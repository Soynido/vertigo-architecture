/**
 * os_prepare canonical plan engine (PV0-010).
 *
 * Translates business intent into ONE backend-owned plan. Order of decisions (each is a HOLD, never a guess):
 *  1. idempotency keys from the intent (pure) → equivalent active plan of THIS binding is replayed, never forked;
 *     any other live lease ⇒ HOLD_RUNTIME_BUSY before anything is resolved;
 *  2. governing versions must equal the ones bound (HOLD_VERSION_CHANGED);
 *  3. principal authority for the lane (HOLD_ACTION_NOT_AUTHORIZED / HOLD_PERMISSION_UNKNOWN);
 *  4. fresh rehydration: recovery, divergence, ambiguity or discovery holds pass through — no new work leapfrogs them;
 *  5. every logical target is resolved INSIDE the bound runtime, fields validated against the live schema,
 *     baseline read from Notion (the caller never supplies baseline, Run, gate or verified state);
 *  6. Run mode is derived (OPEN_NEW; RESUME/RECOVER modes are only produced by the recovery engine);
 *  7. stage-1 / finalization / state-last writes are derived deterministically and the plan is persisted under the lease.
 */
import { createHash } from "node:crypto";
import type { BindingRecord } from "../binding/store.ts";
import { observationFingerprint } from "../verify/target.ts";
import { validateFixturePrepareIntent } from "../fixture/preflight.ts";
import type { HoldCode } from "../errors/codes.ts";
import { normalizeId, propRelationIds, propText } from "../notion/shapes.ts";
import type { ResolvedRuntime } from "../resolvers/types.ts";
import { rehydrate } from "../resume/engine.ts";
import { adoptionCeiling, adoptionClass } from "../resume/foreignWrites.ts";
import { ANSWER_PLACEHOLDER, pendingStepInputFor, pendingInputValueMatches } from "../resume/pendingInput.ts";
import { discoverControlPlane, readCapabilitySnapshot } from "../resume/readers.ts";
import { evaluateCapabilityCompleteness } from "../resume/capabilities.ts";
import { checkSchemaCompatibility, type CompatibilityReport } from "../verify/schemaContract.ts";
import type { HarnessDeps } from "../tools/handlers.ts";
import { checkFields, checkRelationTargets, findRows, readSchema, resolveTarget, type DataSourceSchema, type RecordSelector } from "./resources.ts";
import { createPlan, expireIfDue, leaseKeyOf, opaqueId, transition, type PlanDraft } from "./service.ts";
import type { Operation, Plan, PlanOperation, RunMode } from "./store.ts";
import { deriveWrites } from "./writes.ts";
import { HARNESS_CALL_BUDGET_MS } from "../transactions/budget.ts";
import { isInstallMutation } from "../install/bootstrap.ts";
import { isBackendOwnedCapabilityIntent } from "../resume/capabilityRemediation.ts";
import { isBackendOwnedSourceEnrollmentIntent, sourceEnrollmentAttestation } from "../resume/sourceEnrollment.ts";
import { isEventResource, isExternalEventIntent, eventVersionAllowed, eventPlanMatchesCapture } from "../effects/eventWrite.ts";

export interface IntentMutation { readonly logical_resource_key: string; readonly operation: Operation; readonly record_selector: RecordSelector; readonly desired_changes: Readonly<Record<string, unknown>> }
export interface Intent { readonly action_class: string; readonly summary: string; readonly mutations: readonly IntentMutation[] }

export type PrepareOutcome =
  | { readonly kind: "PREPARED"; readonly plan: Plan; readonly replayed: boolean; readonly warnings: readonly string[]; readonly observations: Readonly<Record<string, unknown>> }
  | { readonly kind: "HOLD"; readonly code: HoldCode; readonly evidence: readonly string[]; readonly safe_action: string; readonly observations?: Readonly<Record<string, unknown>>; readonly warnings?: readonly string[] };

function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
}
export function sha(s: string): string { return createHash("sha256").update(s).digest("hex"); }

/** Deterministic idempotency key: same runtime generation + same normalized mutation ⇒ same key. */
export function idempotencyKey(runtimeGeneration: string, m: IntentMutation): string {
  return sha(["v1", runtimeGeneration, m.logical_resource_key, m.operation, canonical(m.record_selector), canonical(m.desired_changes)].join("|")).slice(0, 32);
}

function hold(code: HoldCode, evidence: string[], safe_action: string, extra: Partial<Extract<PrepareOutcome, { kind: "HOLD" }>> = {}): PrepareOutcome {
  return { kind: "HOLD", code, evidence, safe_action, ...extra };
}

/** Candidate server writes cannot open work which the known schema cannot prove. The historical
 * readonly prepare still reports its diagnostic; this never migrates a schema or repairs a journal. */
async function writableControlPlaneHold(deps: HarnessDeps, runtime: ResolvedRuntime, warnings: readonly string[],
  known?: { readonly compatibility: CompatibilityReport; readonly runs?: DataSourceSchema }): Promise<PrepareOutcome | undefined> {
  const compatibility = known?.compatibility ?? await checkSchemaCompatibility(deps.notion, runtime);
  if (!compatibility.compatible) return hold("HOLD_SCHEMA_MISMATCH", [
    ...compatibility.migration.map(m => `${m.database}."${m.property}" (${m.type}) — ${m.reason}`),
    "structured harness linkage is unavailable; no new plan, lease or Notion write was created",
  ], "have the administrator prepare and verify the bound control-plane schema before a new transaction; preserve existing journals", {
    warnings, observations: { control_plane_schema: { compatible: false, migration: compatibility.migration } },
  });
  const runs = known ? known.runs : compatibility.runs.data_source === "NOT_FOUND" ? undefined : await readSchema(deps.notion, compatibility.runs.data_source);
  const g = runtime.adapter.controlPlane, origin = g.runProps.origin, value = g.writeProps?.runOriginValue ?? "PLUGIN";
  const type = runs?.properties.get(origin);
  if (!runs || !type || !["rich_text", "title", "select", "status"].includes(type)
    || (["select", "status"].includes(type) && !runs.options.get(origin)?.includes(value))) {
    return hold("HOLD_SCHEMA_MISMATCH", ["the declared Run origin cannot be encoded by the bound Runs schema",
      "no new plan, lease or Notion write was created"], "have the administrator verify the bound Run origin declaration; do not infer or extend an option", { warnings });
  }
  return undefined;
}

/** A schema fixed after readonly preparation does not fill omitted fields in stored instructions.
 * Only OPEN_NEW never-sent drafts may be rederived; recovery lineage is handled by its own engine. */
function draftCarriesLinkage(plan: Plan, runtime: ResolvedRuntime): boolean {
  const wp = runtime.adapter.controlPlane.writeProps;
  if (!wp?.runHarnessPlanId || !wp.ledgerHarnessPlanId || !wp.ledgerIdempotencyKey || !wp.ledgerTargetReceiptId) return false;
  const run = plan.stage1_writes.find(w => w.purpose === "OPEN_RUN");
  if (run?.fields[wp.runHarnessPlanId] !== plan.plan_id) return false;
  return plan.operations.every(op => {
    const prepared = plan.stage1_writes.find(w => w.symbol === `LEDGER_${op.ordinal}` && w.purpose === "PREPARE_LEDGER");
    const verified = plan.finalization_writes.find(w => w.symbol === `LEDGER_${op.ordinal}_VERIFIED` && w.purpose === "LEDGER_VERIFIED");
    return prepared?.fields[wp.ledgerHarnessPlanId!] === plan.plan_id
      && prepared.fields[wp.ledgerIdempotencyKey!] === op.idempotency_key
      && verified?.fields[wp.ledgerTargetReceiptId!] === "$receipt:TARGET";
  });
}

/**
 * The latest FINAL_VERIFIED plan of this principal and runtime generation carrying exactly these idempotency keys,
 * provided every one of its targets still reads back at the planned values. A target changed since (by the user,
 * or anyone) means the intent is new work again, and the answer is undefined — never a stale "already done".
 */
async function persistedReplay(deps: HarnessDeps, binding: BindingRecord, keys: readonly string[], intent: Intent): Promise<Plan | undefined> {
  const done = (await deps.store.plans.listByRuntime(binding.project, binding.lane, binding.runtime_generation))
    .filter((p) => p.principal_id === binding.principal_id && p.runtime_id === binding.runtime_id && p.plan_state === "FINAL_VERIFIED"
      && (isExternalEventIntent(intent) ? eventPlanMatchesCapture(p, intent) : p.operations.map((o) => o.idempotency_key).join("|") === keys.join("|")));
  const latest = done.at(-1);
  if (!latest) return undefined;
  const { observeOperation } = await import("../recovery/engine.ts");
  for (const op of latest.operations) if ((await observeOperation(deps.notion, op)).kind !== "EXPECTED") return undefined;
  return latest;
}

/**
 * Recovery entry point (PV0-015): an earlier plan of this principal on this runtime with the same normalized intent
 * (any non-final state: expired, superseded, on hold, or still awaiting) is assessed by observation. A recovery plan
 * continues its Run and ledger rows; nothing durable is ever duplicated.
 */
async function tryRecovery(deps: HarnessDeps, binding: BindingRecord, runtime: ResolvedRuntime, keys: readonly string[], intent: Intent, governing: { spec: string; schema: string; control: string }, cursorLastEdited: unknown, warnings: string[], now: Date): Promise<PrepareOutcome | undefined> {
  const store = deps.store;
  const candidates = (await store.plans.listByRuntime(binding.project, binding.lane, binding.runtime_generation))
    .filter((p) => p.principal_id === binding.principal_id && p.plan_state !== "FINAL_VERIFIED" && p.plan_id !== undefined && p.operations.map((o) => o.idempotency_key).join("|") === keys.join("|"));
  if (candidates.length === 0) return undefined;
  // Assess the most recent candidate; all share the linkage id of the first interrupted plan.
  const latest = candidates[candidates.length - 1] as Plan;
  const { openRecoveryPlan } = await import("../recovery/engine.ts");
  const outcome = await openRecoveryPlan(deps, binding, runtime, latest, { governing, cursor_last_edited: cursorLastEdited, warnings, now });
  // os_prepare still has a complete, freshly validated intent, so a plan with no durable trace can be re-issued
  // normally. The intent-free cross-binding os_verify path instead surfaces this HOLD to force resume/reissue.
  if (outcome.kind === "HOLD" && outcome.code === "HOLD_PLAN_EXPIRED" && outcome.evidence.some((e) => e.includes("left no durable"))) {
    warnings.push(`earlier plan ${latest.plan_id} (${latest.plan_state}) left no durable effect; a fresh plan is prepared`);
    return undefined;
  }
  if (outcome.kind === "HOLD") return hold(outcome.code, [...outcome.evidence], outcome.safe_action, { warnings: outcome.warnings, ...(outcome.observations ? { observations: outcome.observations } : {}) });
  return { ...outcome, observations: { ...outcome.observations, intent_summary: intent.summary } };
}

/** Schema of the data source holding the cursor row (Manifest / OS State), read through the row's parent. */
async function cursorSchemaOf(deps: HarnessDeps, cursorRef: string): Promise<ReadonlyMap<string, string> | undefined> {
  try {
    const page = (await deps.notion.retrievePage(cursorRef)) as { parent?: { data_source_id?: string; database_id?: string } };
    const ds = normalizeId(page.parent?.data_source_id) ?? normalizeId(page.parent?.database_id);
    if (!ds) return undefined;
    return (await readSchema(deps.notion, ds))?.properties;
  } catch {
    return undefined;
  }
}

/** Run mode derivation. Recovery holds are raised before this point, so a prepare that reaches here opens a new Run. */
export function chooseRunMode(currentRunStatus: string | undefined): RunMode {
  void currentRunStatus;
  return "OPEN_NEW";
}

/** The capability HOLD may open only the append-only proof journal that can resolve it. No business mutation rides along. */
function isCapabilityRemediation(runtime: ResolvedRuntime, intent: Intent): boolean {
  if (isBackendOwnedSourceEnrollmentIntent(intent)) return true;
  const key = runtime.adapter.capabilities?.capabilityProofResource;
  return key !== undefined && isBackendOwnedCapabilityIntent(intent) && intent.mutations.length === 1 && intent.mutations.every((m) => m.logical_resource_key === key && m.operation === "CREATE");
}

export interface PrepareOptions {
  /**
   * PV-WRITE-001 / W1.9: the server-writer path (os_commit) sets this. The exact same intent, already persisted and
   * still standing in Notion, is then answered with its stored FINAL_VERIFIED plan (`replayed`), which the executor
   * reports as `repeated` — nothing is written twice. The live os_prepare path leaves it off and is unchanged.
   */
  readonly detectPersistedReplay?: boolean;
  /** Backend-only D9: this call's observation, never a tool argument or an inter-call cache. */
  readonly automaticAdoption?: import("../resume/engine.ts").ResumeOutcome;
}

export async function prepare(deps: HarnessDeps, binding: BindingRecord, runtime: ResolvedRuntime, intent: Intent, now: Date, options: PrepareOptions = {}): Promise<PrepareOutcome> {
  const store = deps.store;
  const warnings: string[] = [];
  if (options.automaticAdoption && (intent.action_class !== "RECONCILE" || intent.mutations.some(m => m.operation !== "UPDATE" || Object.keys(m.desired_changes).length)))
    return hold("HOLD_ACTION_NOT_AUTHORIZED", ["automatic adoption is backend-derived as-is observation only"], "submit no values or new targets for automatic adoption");

  // D12: one user intent is one commit of n mutations, under a server ceiling. Checked before anything else: a
  // refused batch touches no plan, no lease, no journal and reads nothing from Notion.
  if (intent.mutations.length > deps.config.commitMaxOps) {
    return hold("HOLD_UNSUPPORTED_OPERATION", [`this intent carries ${intent.mutations.length} mutations; one commit accepts at most ${deps.config.commitMaxOps}`, "no plan was created or replayed"], `split the change into intents of at most ${deps.config.commitMaxOps} mutations each, then prepare them one after another`);
  }

  // 0. PT-PRO-001 fixture contract preflight: the COMPLETE intent is validated BEFORE the active-plan scan, the
  //    expiry sweep, the lease check and the rehydration, so a refused intent expires nothing, supersedes nothing,
  //    touches no lease and reads nothing from Notion. Governs only that contract's runtime on the META lane.
  const fixtureViolations = validateFixturePrepareIntent(binding, runtime, intent);
  if (fixtureViolations) return hold("HOLD_FIXTURE_CONTRACT_VIOLATION", [...fixtureViolations], "submit exactly the intent the fixture contract permits, then prepare again");

  // INSTALL_ONLY never enters this business transaction engine. The dedicated installer neither rehydrates copied
  // history nor inherits generic HOLD-remediation privileges.
  const principal = await deps.principals.get(binding.principal_id);
  if (!principal) return hold("HOLD_PERMISSION_UNKNOWN", [`principal ${binding.principal_id} is not resolvable`], "re-authenticate, then call os_bind");
  if (binding.binding_mode === "INSTALL_ONLY") return hold("HOLD_INSTALL_REQUIRED", ["INSTALL_ONLY cannot enter the business prepare/rehydrate engine", "no plan was created or replayed"], "continue only the server-derived installer flow");
  if (intent.mutations.some(isInstallMutation)) {
    return hold("HOLD_UNSUPPORTED_OPERATION", ["INSTALL resources are unavailable after the runtime leaves UNBOUND", "no plan was created or replayed"], "continue from the runtime's current business gate");
  }
  const capabilityProofResource = runtime.adapter.capabilities?.capabilityProofResource;
  if (intent.mutations.some(m => m.logical_resource_key === "SALES:SOURCE_IDENTITY") && !isBackendOwnedSourceEnrollmentIntent(intent))
    return hold("HOLD_ACTION_NOT_AUTHORIZED", ["source identities are backend-derived only"], "use the signed first-link protocol; submit no Manifest intent");
  if (intent.mutations.some((m) => isEventResource(m.logical_resource_key)) && !isExternalEventIntent(intent)) {
    return hold("HOLD_ACTION_NOT_AUTHORIZED", ["external event records accept only backend-derived native capture intents"], "submit only the bounded external_event_evidence; never a record mutation");
  }
  if (capabilityProofResource && intent.mutations.some((m) => m.logical_resource_key === capabilityProofResource) && !isBackendOwnedCapabilityIntent(intent)) {
    return hold("HOLD_ACTION_NOT_AUTHORIZED", ["Capability Profile mutations are backend-derived from a fresh signed challenge and competent-source evidence", "raw capability-proof intent refused before plan, Run or lease creation"], "call os_resume, perform the named competent native read, then submit only capability_evidence");
  }

  // 1. Governing versions unchanged since bind. This must precede every
  // capability read and active-plan/idempotency path: those are interpreted by
  // the governing adapter and must never mask a version-boundary HOLD.
  const gov = runtime.versions;
  const fresh = { spec: gov.governing_spec === "UNKNOWN" ? "UNKNOWN" : gov.governing_spec.value, schema: gov.governing_schema === "UNKNOWN" ? "UNKNOWN" : gov.governing_schema.value, control: gov.governing_control === "UNKNOWN" ? "UNKNOWN" : gov.governing_control.value };
  const snap = binding.governing_versions_snapshot;
  const changed = (["spec", "schema", "control"] as const).filter((k) => snap[k] !== undefined && snap[k] !== fresh[k]).map((k) => `governing ${k}: bound=${snap[k]} now=${fresh[k]}`);
  if (changed.length > 0) return hold("HOLD_VERSION_CHANGED", changed, "call os_bind again to bind under the current governing versions, then resume and prepare");
  if (fresh.spec === "UNKNOWN" || fresh.schema === "UNKNOWN") return hold("HOLD_VERSION_RESOLUTION", ["governing spec/schema UNKNOWN"], "resolve the governing versions durably before preparing");

  // Candidate SALES runtimes fresh-check capability completeness even before returning an already-active business
  // plan. This closes the adoption race where a plan prepared under an older capability set might otherwise be
  // replayed after a newly REQUIRED source appeared. Only the proof journal itself may pass this boundary.
  // The factory proof cannot be rejected by this business-only preflight. A new proof plan still needs the
  // full store-backed rehydrate below; existing-plan replay keeps its established idempotency path.
  if (runtime.adapter.capabilities?.operatingModeRequirements && !isCapabilityRemediation(runtime, intent)) {
    const cap = await readCapabilitySnapshot(deps.notion, runtime);
    const required = Object.values(runtime.adapter.capabilities.operatingModeRequirements).flat().filter(r => r.requirement === "REQUIRED");
    const completeness = cap ? evaluateCapabilityCompleteness(runtime, cap) : undefined;
    if (intent.action_class === "RECOVER_FOREIGN_RUN" && required.length > 0 && completeness?.complete !== true) {
      return hold("HOLD_REQUIRED_CAPABILITY_INCOMPLETE", ["the foreign-Run import has no fresh proof of its required capability completeness", "no plan, lease or Notion write was created"],
        completeness?.next_human_action ?? required[0]!.nextHumanAction,
        completeness ? { observations: { capability_completeness: completeness } } : {});
    }
    // Only a positive proof may avoid unrelated hydration. Every uncertainty preserves the original HOLD priority.
    const capabilityPreflight = completeness?.complete === true
      ? undefined : await rehydrate(deps.notion, binding, runtime, deps.store, now);
    if (capabilityPreflight?.kind === "HOLD" && capabilityPreflight.code === "HOLD_REQUIRED_CAPABILITY_INCOMPLETE" && !isCapabilityRemediation(runtime, intent)) {
      return hold(capabilityPreflight.code, [...capabilityPreflight.evidence, "no plan was created or replayed"], capabilityPreflight.partial.next_safe_action ?? "verify the first missing required capability in the seller's own thread", { observations: { ...capabilityPreflight.partial }, warnings: [...capabilityPreflight.warnings] });
    }
  }

  // 2. Idempotency / one-active-plan.
  const keys = intent.mutations.map((m) => isExternalEventIntent(intent)
    ? sha(["external-event-v1", m.logical_resource_key, m.operation, m.record_selector.natural_key].join("|")).slice(0, 32)
    : idempotencyKey(binding.runtime_generation, m));
  for (const active of await store.plans.findActive(binding.project, binding.lane, binding.runtime_generation)) await expireIfDue(store, active, now);
  let active = await store.plans.findActive(binding.project, binding.lane, binding.runtime_generation);
  const same = active.find((p) => p.binding_id === binding.binding_id && p.operations.map((o) => o.idempotency_key).join("|") === keys.join("|"));
  if (same) {
    if (same.plan_state === "AWAITING_STAGE1_WRITES") {
      // An unwritten draft may predate a schema change or come from readonly prepare.
      // Started own-journal recovery keeps its established path; no new work is admitted here.
      const writableDraft = (options.detectPersistedReplay || options.automaticAdoption)
        && !(await store.planWrites.list(same.plan_id)).some(r => r.status !== "PENDING" && !(r.status === "FAILED_FINAL" && r.attempts === 0));
      if (writableDraft) {
        const gap = await writableControlPlaneHold(deps, runtime, warnings);
        if (gap) return gap;
      }
      if (writableDraft && same.run_mode === "OPEN_NEW" && !draftCarriesLinkage(same, runtime)) {
        const claim = opaqueId(), until = new Date(Math.min(same.expires_at.getTime(), now.getTime() + HARNESS_CALL_BUDGET_MS));
        if (!await store.claims.claim(same.plan_id, claim, now, until)) return hold("HOLD_RUNTIME_BUSY",
          ["the incomplete draft is claimed by another executor; no replacement or Notion write was made"], "let the existing executor finish, then resume");
        try {
          const live = await store.plans.get(same.plan_id);
          const sent = (await store.planWrites.list(same.plan_id)).some(r => r.status !== "PENDING" && !(r.status === "FAILED_FINAL" && r.attempts === 0));
          if (live?.plan_state !== "AWAITING_STAGE1_WRITES" || sent) return hold("HOLD_RUNTIME_BUSY",
            ["the draft changed or started before replacement; its original journal is preserved"], "resume the original journal, never rederive its effects");
          const replaced = await transition(store, same.plan_id, "SUPERSEDED", now, { reason: "never-sent draft omitted required linkage; derive fresh instructions from the current schema" });
          if (!replaced.ok) return hold("HOLD_RUNTIME_BUSY", ["the draft could not be superseded; no replacement was created"], "resume the existing plan");
        } finally { await store.claims.release(same.plan_id, claim); }
        active = active.filter(p => p.plan_id !== same.plan_id);
        warnings.push("an unwritten incomplete draft was superseded; the current intent is revalidated against fresh sources");
      } else return { kind: "PREPARED", plan: same, replayed: true, warnings: ["replayed: an equivalent plan from this binding is already active; no second plan or Run was created"], observations: { plan_state: same.plan_state } };
    } else {
      return hold("HOLD_EXISTING_PLAN_ACTIVE", [`plan ${same.plan_id} for this exact intent is ${same.plan_state}`], same.plan_state === "TARGET_VERIFIED" || same.plan_state === "AWAITING_FINAL_VERIFY" ? "continue that plan: execute its finalization writes, then call os_verify(FINAL)" : "wait for that plan to reach a terminal state, then prepare again", { observations: { plan_id: same.plan_id, plan_state: same.plan_state } });
    }
  }
  if (options.detectPersistedReplay) {
    const persisted = await persistedReplay(deps, binding, keys, intent);
    if (persisted) {
      if (isExternalEventIntent(intent)) {
        const freshReplay = await rehydrate(deps.notion, binding, runtime, deps.store, now);
        if (freshReplay.kind === "HOLD") return hold(freshReplay.code, [...freshReplay.evidence, "no event replay or new plan"], freshReplay.partial.next_safe_action ?? "resolve the runtime hold");
        const { reconcileUnresolvedIntents } = await import("../effects/adapter.ts");
        const ea = await reconcileUnresolvedIntents(deps, runtime, freshReplay.state.external_actions);
        if (ea.native_conflict) return hold(ea.native_conflict.code, [...ea.native_conflict.evidence], "reconcile the conflicting source; do not resend");
      }
      return { kind: "PREPARED", plan: persisted, replayed: true, warnings: ["replayed: this exact intent was already persisted and still stands; nothing is written again"], observations: { plan_state: persisted.plan_state } };
    }
  }
  // The same principal re-issuing the same intent from a NEW binding (a new chat after a crash) takes over: the
  // interrupted plan is superseded and recovered by observation, never duplicated.
  const takeover = active.find((p) => p.principal_id === binding.principal_id && p.binding_id !== binding.binding_id && p.operations.map((o) => o.idempotency_key).join("|") === keys.join("|"));
  // An own plan that has written NOTHING yet is a draft. The same principal preparing an intent for the same
  // records again — from this binding with different words (the seller edited their answer, or the caller
  // re-serialized it), or from a new chat while the lease is still live — supersedes it: no Run was opened, no
  // row was written, so nothing durable is lost, and the seller is not told to wait for their own draft to
  // expire (observed 2026-09-23 17:48 and 17:52, one HOLD_RUNTIME_BUSY each, fifteen minutes of wall each).
  const recordsOf = (ops: ReadonlyArray<{ readonly logical_resource_key: string; readonly natural_key?: string | undefined }>) => ops.map((o) => `${o.logical_resource_key}::${o.natural_key ?? ""}`).join("|");
  const records = recordsOf(intent.mutations.map((m) => ({ logical_resource_key: m.logical_resource_key, natural_key: m.record_selector.natural_key })));
  // PV-WRITE-001 / W1.8: with the server executor, AWAITING_STAGE1_WRITES no longer means "nothing written". A plan is
  // a draft only if its own write journal shows nothing ever sent; one the executor already wrote from is recovered,
  // never replaced (the replay is detected from the journal, not guessed from the plan state).
  const neverSent = async (p: Plan) => (await store.planWrites.list(p.plan_id)).every((r) => r.status === "PENDING" || (r.status === "FAILED_FINAL" && r.attempts === 0));
  let unwrittenDraft: Plan | undefined;
  if (!takeover) {
    for (const p of active) {
      if (p.principal_id === binding.principal_id && p.plan_state === "AWAITING_STAGE1_WRITES" && recordsOf(p.operations) === records && await neverSent(p)) { unwrittenDraft = p; break; }
    }
  }
  if (takeover) {
    await transition(store, takeover.plan_id, "SUPERSEDED", now, { reason: "same principal re-issued the intent from a new binding; recovery by observation" });
    warnings.push(`plan ${takeover.plan_id} (${takeover.plan_state}) from a previous binding superseded; its durable effects are recovered, not repeated`);
  } else if (unwrittenDraft) {
    await transition(store, unwrittenDraft.plan_id, "SUPERSEDED", now, { reason: "same principal re-prepared the same records before any write; the unwritten draft is replaced" });
    warnings.push(`plan ${unwrittenDraft.plan_id} (unwritten draft for the same records) superseded; nothing durable existed for it`);
  } else {
    const holder = await store.leases.current(leaseKeyOf(binding), now);
    if (holder) {
      // Audited like the createPlan race (PV0-020E): a refusal by a live lease must leave a trace, otherwise a lane
      // blocked for the whole plan TTL is invisible in transaction_events.
      await store.events.append({ event_type: "PLAN_HOLD", result: "HOLD_RUNTIME_BUSY", principal_id: binding.principal_id, binding_id: binding.binding_id, runtime_id: binding.runtime_id, detail: { holder_plan_id: holder.plan_id, holder_expires_at: holder.expires_at.toISOString() }, created_at: now });
      return hold("HOLD_RUNTIME_BUSY", [`runtime generation ${binding.runtime_generation} has an active mutating plan`, `holder_expires_at=${holder.expires_at.toISOString()}`], "wait for the active plan on this runtime to reach a terminal state (or let it expire), then prepare again");
    }
  }

  // 3. Authority.
  if (binding.lane === "META" && principal.meta_authority !== "COMPANY_OWNER") return hold("HOLD_ACTION_NOT_AUTHORIZED", [`META mutations require COMPANY_OWNER authority; principal has ${principal.meta_authority ?? "NONE"}`], "ask the Company Owner to perform this change in their own binding");
  if (binding.lane === "SALES" && !principal.rep_identity_key) return hold("HOLD_ACTION_NOT_AUTHORIZED", ["SALES mutations require a rep identity"], "bind with a principal that owns a Personal SALES runtime");

  if (intent.action_class === "RECOVER_FOREIGN_RUN") {
    const { prepareForeignRun } = await import("../resume/foreignRuns.ts");
    return prepareForeignRun(deps, binding, runtime, intent, keys, fresh, now);
  }

  // 4. Fresh durable state; recovery / divergence / ambiguity block any new work — unless this intent IS the
  //    interrupted work of this principal, which is recovered by observing durable state.
  const resumed = options.automaticAdoption ?? await rehydrate(deps.notion, binding, runtime, deps.store, now, isExternalEventIntent(intent) ? intent : undefined);
  warnings.push(...resumed.warnings);
  const recovery = await tryRecovery(deps, binding, runtime, keys, intent, fresh, resumed.kind === "OK" ? resumed.state.cursor_last_edited : resumed.partial.cursor_last_edited, warnings, now);
  if (recovery) return recovery;
  // PV-FW-001: rows changed outside the system hold the runtime. The one intent admitted under that hold is a
  // RECONCILE re-adoption of exactly those rows — examined values, no write, a real receipt. Checked op by op below.
  // PV-ORPHAN-001 widens the same admission to the walk's evidence rows nothing proved and to a cursor the
  // product did not move: each is re-adopted exactly as it stands, under the same op-by-op checks.
  const resumedState = (resumed.kind === "OK" ? resumed.state : resumed.partial) as import("../resume/derive.ts").ResumeState | undefined;
  const changedRows: readonly { readonly target_ref: string; readonly natural_key: string; readonly governed_fields: readonly string[]; readonly last_edited_observed?: string; readonly last_edited?: string; readonly observation_hash?: string }[] = [
    ...(resumedState?.foreign_writes ?? []),
    ...(resumedState?.orphan_rows ?? []),
    ...(resumedState?.cursor_drift ? [resumedState.cursor_drift] : []),
  ];
  const reconciling = intent.action_class === "RECONCILE" && changedRows.length > 0;
  if (intent.action_class === "RECONCILE" && !reconciling) return hold("HOLD_UNSUPPORTED_OPERATION", ["nothing in this runtime has changed outside a transaction, so there is nothing to confirm", "no plan was created"], "call os_resume; confirm only what it reports as changed", { warnings });
  if (resumed.kind === "HOLD") {
    // A re-adoption clears a hold only when adopting is what clears it. A cursor sitting past a step whose answer
    // does not exist (PV-ORPHAN-001/d) is not that: attesting it as it stands would attest the missing answer.
    const remediation = (resumed.code === "HOLD_REQUIRED_CAPABILITY_INCOMPLETE" && isCapabilityRemediation(runtime, intent)) || (reconciling && resumed.code !== "HOLD_STATE_DIVERGENCE");
    if (!remediation) {
      const safe = resumed.partial.next_safe_action ?? (resumed.code === "HOLD_RECOVERY_REQUIRED" ? "recover the incomplete durable work before any new prepare" : "reconcile durable state before any new prepare");
      return hold(resumed.code, [...resumed.evidence, "no plan was created"], safe, { observations: { ...resumed.partial }, warnings });
    }
    warnings.push(reconciling ? "reconciliation only: the flagged rows are re-examined and re-adopted; business progression remains blocked until every foreign write is reconciled" : "capability remediation only: the incomplete runtime may append competent-source proofs; business progression remains blocked");
  }
  const state = (resumed.kind === "OK" ? resumed.state : resumed.partial) as import("../resume/derive.ts").ResumeState;
  if (eventVersionAllowed(runtime) && state.external_actions.unresolved.some((row) => row.native_reconciliation)) {
    const { reconcileUnresolvedIntents } = await import("../effects/adapter.ts");
    const ea = await reconcileUnresolvedIntents(deps, runtime, state.external_actions);
    if (ea.native_conflict) return hold(ea.native_conflict.code, [...ea.native_conflict.evidence, "no plan was created"], "reconcile the source contradiction first; never send or resend", { warnings });
  }
  if (isExternalEventIntent(intent) && (changedRows.length > 0 || state.effective_hold !== "NONE")) {
    const code = state.effective_hold === "NONE" ? "HOLD_UNKNOWN_REQUIRED_FACT" : state.effective_hold.code;
    return hold(code, ["native capture cannot bypass another durable blocker or a row requiring re-adoption", "no plan was created"], "reconcile the other durable work first; do not send or invent an effect", { observations: { ...state }, warnings });
  }
  if (state.effective_hold !== "NONE") warnings.push(`durable state carries ${state.effective_hold.code}: ${state.effective_hold.evidence.join("; ")}`);

  // 5. Targets, fields, baseline.
  const g = runtime.adapter.controlPlane;
  const durableGate = typeof state.gate.gate_key === "string" ? state.gate.gate_key : undefined;
  const ops: PlanOperation[] = [];
  const targetSchemas = new Map<string, ReadonlyMap<string, string>>();
  const operationPropertyIds: Record<string, Record<string, string>> = {};
  for (const [i, m] of intent.mutations.entries()) {
    // The answer to the step's pending input goes in the record the contract names, carrying the values the
    // contract requires — or it does not go anywhere. The refusal names the key so the same turn can correct
    // itself instead of inventing a second place to put the answer.
    // Classify candidate configuration by its resolved identity, never just a caller's selector: an
    // existing_object_id must not bypass the canonical answer checks. Reuse this read below.
    const independentConfig = !reconciling && g.independentConfigurationResourceKey === m.logical_resource_key;
    const resolvedConfig = independentConfig ? await resolveTarget(deps.notion, runtime, binding.binding_mode, m.logical_resource_key, m.operation, m.record_selector) : undefined;
    if (resolvedConfig && !resolvedConfig.ok) return hold(resolvedConfig.code, [...resolvedConfig.evidence, "no plan was created"], resolvedConfig.code === "HOLD_CROSS_RUNTIME" ? "target only records of the runtime this binding is bound to" : "correct the logical resource / record selector, then prepare again", { warnings });
    const suppliedKey = resolvedConfig?.ok
      ? resolvedConfig.target.kind === "NEW" ? resolvedConfig.target.natural_key : propText(resolvedConfig.target.page, resolvedConfig.target.spec.naturalKeyProperty)
      : m.record_selector.natural_key;
    const pendingInput = reconciling ? undefined : pendingStepInputFor(runtime, durableGate, m.logical_resource_key, independentConfig ? suppliedKey : undefined);
    if (pendingInput) {
      if (pendingInput.gate_key !== durableGate) return hold("HOLD_UNSUPPORTED_OPERATION", [
        `${pendingInput.natural_key} belongs to ${pendingInput.gate_key}, not the current gate ${durableGate ?? "UNKNOWN"}`,
        "a reserved setup key is never independent configuration",
        "no plan was created",
      ], "record only the current step's answer or an independent configuration key; reconcile reported changes separately", { warnings });
      const supplied = (suppliedKey ?? "").trim();
      if (supplied !== pendingInput.natural_key) {
        return hold("HOLD_UNSUPPORTED_OPERATION", [
          `the answer pending at ${durableGate} is recorded under ${pendingInput.natural_key}, not ${supplied || "an unnamed key"}`,
          "another key would be a second truth for the same input and would leave the step where it is",
          "no plan was created",
        ], `record the answer under ${pendingInput.natural_key}, then prepare again`, { warnings });
      }
      const wrong = Object.entries(pendingInput.required_values).filter(([k]) => !pendingInputValueMatches(runtime, pendingInput, k, m.desired_changes[k])).map(([k, v]) => k === "Source" && g.localAnswerSources ? "Source must be a declared human-local origin" : `${k} must be ${v}`);
      const blank = pendingInput.required_non_empty.filter((k) => String(m.desired_changes[k] ?? "").trim() === "");
      // The served intent carries a placeholder where the seller's words go. Sent back unchanged it is not
      // empty, so it would pass the non-empty test and write the token itself into Notion as the decision.
      const unfilled = pendingInput.required_non_empty.filter((k) => String(m.desired_changes[k] ?? "").trim() === ANSWER_PLACEHOLDER);
      if (unfilled.length > 0) {
        return hold("HOLD_UNSUPPORTED_OPERATION", [
          `${unfilled.join(", ")} still carries the placeholder of the served intent instead of the seller's answer`,
          "the template is where the answer goes, never the answer itself",
          "no plan was created",
        ], pendingInput.evidence_kind === "B7_GRAPH" ? "assemble the selected canonical workset from the bound runtime; ask the seller for a natural-language confirmation, never JSON or IDs" : "copy the seller's own answer from their current message into that property, then prepare again", { warnings });
      }
      if (wrong.length > 0 || blank.length > 0) {
        return hold("HOLD_UNSUPPORTED_OPERATION", [
          `${pendingInput.natural_key} does not carry what completing ${durableGate} requires: ${[...wrong, ...blank.map((k) => `${k} must not be empty`)].join("; ")}`,
          "no plan was created",
        ], "ask the one business question that is still missing, or correct the record, then prepare again", { warnings });
      }
    }
    if (pendingInput?.evidence_kind === "B7_GRAPH") {
      const { parseB7Workset } = await import("../resume/b7DryRun.ts");
      if (!parseB7Workset(String(m.desired_changes["Value"] ?? ""), runtime))
        return hold("HOLD_UNSUPPORTED_OPERATION", ["the selected trial workset is not canonical or belongs to another runtime/version", "no plan was created"], "assemble the canonical workset from the bound runtime and selected durable identities; a confirmation or PASS flag is not a workset", { warnings });
    }
    const r = resolvedConfig ?? await resolveTarget(deps.notion, runtime, binding.binding_mode, m.logical_resource_key, m.operation, m.record_selector);
    if (!r.ok) return hold(r.code, [...r.evidence, "no plan was created"], r.code === "HOLD_CROSS_RUNTIME" ? "target only records of the runtime this binding is bound to" : "correct the logical resource / record selector, then prepare again", { warnings });
    if (!reconciling && g.localAnswerSources && m.logical_resource_key === g.independentConfigurationResourceKey) {
      if (r.target.kind === "EXISTING" && propText(r.target.page, "Source")?.trim() === "META_PUBLISHED")
        return hold("HOLD_ACTION_NOT_AUTHORIZED", ["published company doctrine cannot be overwritten or relabelled by a local answer", "no plan was created"], "use the competent company publication authority; never reclassify it as a local answer", { warnings });
      if (typeof m.desired_changes["Source"] !== "string" || !g.localAnswerSources.includes(m.desired_changes["Source"]))
        return hold("HOLD_UNSUPPORTED_OPERATION", ["Source is not a declared human-local provenance", "no plan was created"], "record the exact local origin only after the human decision; never claim a company publication", { warnings });
    }
    // A re-adoption may carry no desired change at all: it asserts the row as it stands, nothing more.
    const f = reconciling && Object.keys(m.desired_changes).length === 0 ? { ok: true as const } : checkFields(r.target, m.desired_changes);
    if (!f.ok) return hold(f.code, [...f.evidence, "no plan was created"], "restrict desired_changes to writable fields of the resource", { warnings });
    const rel = await checkRelationTargets(deps.notion, r.target, m.desired_changes);
    if (!rel.ok) return hold(rel.code, [...rel.evidence, "no plan was created"], "point each relation at a row of the canonical data source it declares, then prepare again", { warnings });
    // 5b. Candidate GTM grammar (PV-GTM-002). Reached only when the GOVERNING contract of this runtime declares the
    //     capability; the refusal happens before the plan is persisted, so nothing durable is touched.
    if (runtime.adapter.capabilities?.gtm === true || m.logical_resource_key === runtime.adapter.capabilities?.capabilityProofResource) {
      const { validateGtmMutation } = await import("../gtm/intents.ts");
      const violations = await validateGtmMutation(m, {
        rep_identity_key: principal.rep_identity_key,
        runtime_id: runtime.runtime_id,
        capabilities: runtime.adapter.capabilities,
        find: (logicalKey, property, value, project) => findRows(deps.notion, runtime, logicalKey, property, value, project),
      });
      if (violations) return hold("HOLD_GTM_CONTRACT_VIOLATION", [...violations], "correct the record so it states only what its evidence supports, then prepare again", { warnings });
    }
    targetSchemas.set(r.target.data_source.id, r.target.data_source.properties);
    // PV-FW-001: a resource whose proved rows could not all be re-read is not admissible for new work on it. Unknown
    // coverage is reported, never treated as verified, and never guessed at.
    // Only the row itself is affected: a row whose proved content cannot be re-read is not admissible work, while
    // every other row of the same resource is untouched by that failure.
    const uncovered = (state.coverage?.unknown ?? []).filter((u) => r.target.kind === "EXISTING" && u.target_ref === r.target.page_ref);
    if (uncovered.length > 0) return hold("HOLD_UNKNOWN_REQUIRED_FACT", [...uncovered.map((u) => `${u.logical_resource_key} ${u.target_ref}: ${u.reason}; what was proved on it cannot be re-established`), "no plan was created"], "restore access to that record so its state can be read, then prepare again", { warnings });
    const flagged = reconciling ? changedRows.find((fw) => r.target.kind === "EXISTING" && fw.target_ref === r.target.page_ref) : undefined;
    if (reconciling && !flagged) return hold("HOLD_UNSUPPORTED_OPERATION", [`${m.logical_resource_key} ${m.record_selector.natural_key ?? "(no key)"} is not among the rows reported as changed outside the system`, "a re-adoption covers exactly the flagged rows, nothing else", "no plan was created"], "reconcile only the rows os_resume reported", { warnings });
    if (options.automaticAdoption && flagged && r.target.kind === "EXISTING"
      && (!r.target.page.last_edited_time || r.target.page.last_edited_time !== (flagged.last_edited_observed ?? flagged.last_edited)
        || !flagged.observation_hash || flagged.observation_hash !== observationFingerprint(r.target.page, [...flagged.governed_fields, r.target.spec.naturalKeyProperty])))
      return hold("HOLD_VERSION_CHANGED", ["the adoption observation changed before preparation", "no plan was created"], "resume once more to observe the current row and walk; never attest the earlier observation", { warnings });
    const defaults = r.target.kind === "NEW" ? Object.fromEntries(Object.entries(r.target.spec.createDefaults ?? {}).filter(([k]) => r.target.data_source.properties.has(k))) : {};
    // The proof covers every planned field except the provenance the governing contract excludes; those are
    // still written, they are simply not what FINAL attests.
    const uncompared = new Set(r.target.spec.uncomparedProperties ?? []);
    // A re-adoption attests every field the earlier proof governed, whether or not the caller listed it.
    const reconcileFields = flagged ? flagged.governed_fields.filter((k) => r.target.data_source.properties.has(k)) : [];
    const compared = [...new Set([...Object.keys(m.desired_changes), ...Object.keys(defaults), ...reconcileFields])].filter((k) => !uncompared.has(k)).sort();
    const before: Record<string, unknown> = {};
    // A relation baseline is its normalized id set, so a later TARGET comparison can tell "not written yet" from
    // "written wrongly" for links exactly as it does for scalars.
    if (r.target.kind === "EXISTING") for (const k of compared) before[k] = r.target.data_source.properties.get(k) === "relation" ? propRelationIds(r.target.page, k) : propText(r.target.page, k) ?? null;
    const expected: Record<string, unknown> = { ...(r.target.kind === "NEW" ? { [r.target.spec.naturalKeyProperty]: r.target.natural_key } : {}), ...defaults, ...(flagged ? Object.fromEntries(reconcileFields.map((k) => [k, before[k]])) : {}), ...m.desired_changes };
    // What a re-adoption asserts is exactly what is there now. A caller-supplied value that differs from the row
    // is not a re-adoption, it is an edit — and an edit is not admitted under this hold.
    if (flagged) {
      const edits = compared.filter((k) => canonical(expected[k]) !== canonical(before[k]));
      if (edits.length > 0) return hold("HOLD_UNSUPPORTED_OPERATION", [`re-adoption of ${flagged.natural_key} would change ${edits.join(", ")}; a reconciliation asserts the current values, it does not correct them`, "no plan was created"], "state the values exactly as the row carries them now, or correct the row through an ordinary transaction once the hold is cleared", { warnings });
      if ((options.automaticAdoption || g.independentConfigurationResourceKey) && r.target.kind === "EXISTING") {
        const target = r.target;
        const key = propText(target.page, target.spec.naturalKeyProperty);
        const foreign = state.foreign_writes?.find(w => w.target_ref === target.page_ref);
        const proof = foreign ? await deps.store.receipts.get(foreign.receipt_id) : undefined;
        const prior = proof ? (await deps.store.plans.get(proof.plan_id))?.operations.find(op => op.physical_target_ref === target.page_ref || op.logical_resource_key === m.logical_resource_key && op.natural_key === key) : undefined;
        // Proved rows use the preceding plan, never today's mutable Source. A new local setup row is
        // classified by its declared contract key, while authority/doctrine remain inadmissible.
        const provenance = prior ? prior.expected_values : foreign ? {} : { Source: propText(r.target.page, "Source") ?? null };
        const differing = foreign?.fields ?? (options.automaticAdoption && state.cursor_drift?.target_ref === target.page_ref ? state.cursor_drift.fields : undefined)
          ?? reconcileFields.filter(field => field !== target.spec.naturalKeyProperty);
        const originalKey = prior?.natural_key ?? key;
        if (prior?.natural_key && prior.natural_key !== key)
          return hold("HOLD_CONFLICT", ["D9: the observed key no longer matches its preceding proof", "no plan was created"], "restore the proved identity before adopting this row", { warnings });
        if (m.logical_resource_key === "SALES:BUSINESS_CONFIG" && !["CHAT_USER_EXPLICIT", "AGENT_PROPOSED_USER_VALIDATED"].includes(propText(target.page, "Source") ?? ""))
          return hold("HOLD_CONFLICT", ["D9: the observed Source cannot acquire publication or operator authority through local adoption", "no plan was created"], "verify the competent publication or operator authority", { warnings });
        const cursor = options.automaticAdoption && state.cursor_drift?.target_ref === target.page_ref;
        const cursorFields = new Set(g.cursorTransitions?.flatMap(t => Object.keys(t.set)) ?? []);
        const local = cursor ? differing.every(field => cursorFields.has(field) || field === target.spec.naturalKeyProperty)
          : differing.every(field => adoptionClass(g, m.logical_resource_key, originalKey, field, provenance) === "LOCAL_USER");
        if (!local)
          return hold("HOLD_CONFLICT", ["D9: this row contains authority, an external fact, published doctrine or an unclassified field; local RECONCILE cannot attest it", "no plan was created"], "restore or verify the competent authority; never adopt an expanded local permission", { warnings });
        if (!adoptionCeiling(r.target.data_source, r.target.page, reconcileFields))
          return hold("HOLD_SCHEMA_MISMATCH", ["D9: the observed row is outside the governing schema ceiling", "no plan was created"], "restore the declared field types and options before adoption", { warnings });
      }
    }
    ops.push({
      // Opaque per plan, as recovery and install already do: plan_operations.operation_id is a global primary
      // key in PostgreSQL, and an id derived from the idempotency key collides the moment the same intent is
      // prepared a second time — a takeover from a new chat, or a superseded draft. On 2026-09-23 15:54Z that
      // collision superseded the seller's plan and then failed to create its replacement, silently.
      operation_id: opaqueId(),
      ordinal: i,
      logical_resource_key: m.logical_resource_key,
      ...(r.target.kind === "EXISTING" ? { physical_target_ref: r.target.page_ref } : {}),
      target_data_source_ref: r.target.data_source.id,
      ...(r.target.kind === "NEW" ? { natural_key: r.target.natural_key } : propText(r.target.page, r.target.spec.naturalKeyProperty) !== undefined ? { natural_key: propText(r.target.page, r.target.spec.naturalKeyProperty) as string } : {}),
      natural_key_property: r.target.spec.naturalKeyProperty,
      ...(r.target.data_source.properties.has(r.target.spec.naturalKeyProperty) ? { natural_key_property_type: r.target.data_source.properties.get(r.target.spec.naturalKeyProperty) as string } : {}),
      idempotency_key: keys[i] as string,
      operation: r.target.kind === "NEW" ? "CREATE" : "UPDATE",
      ...(r.target.kind === "EXISTING" && r.target.page.last_edited_time ? { baseline_revision: r.target.page.last_edited_time } : {}),
      compared_fields: r.target.kind === "NEW" ? [r.target.spec.naturalKeyProperty, ...compared] : compared,
      before_values: before,
      expected_values: expected,
      before_hash: sha(canonical(before)),
      expected_hash: sha(canonical(expected)),
    });
    if (g.cursorTransitions?.some(t => t.evidence.kind === "B7_GRAPH")) {
      const operation = ops.at(-1)!;
      operationPropertyIds[String(operation.ordinal)] = Object.fromEntries(r.target.data_source.propertyIds ?? []);
    }
  }

  // 6. Control-plane targets for the derived writes.
  const dbs = await discoverControlPlane(deps.notion, runtime.root_ref, g);
  if (!dbs.runs || !dbs.ledger) return hold("HOLD_REQUIRED_RESOURCE_MISSING", [`control-plane databases missing: ${[!dbs.runs && g.runsDatabaseTitle, !dbs.ledger && g.ledgerDatabaseTitle].filter(Boolean).join(", ")}`, "no plan was created"], "restore the runtime control plane before preparing", { warnings });
  const runSchema = await readSchema(deps.notion, dbs.runs);
  const ledgerSchema = await readSchema(deps.notion, dbs.ledger);
  if (!runSchema) warnings.push("Runs schema unreadable; run writes are rendered unvalidated");
  if (!ledgerSchema) warnings.push("Mutation Ledger schema unreadable; ledger writes are rendered unvalidated");
  const compat = await checkSchemaCompatibility(deps.notion, runtime);
  if (options.detectPersistedReplay || options.automaticAdoption) {
    const gap = await writableControlPlaneHold(deps, runtime, warnings, { compatibility: compat, ...(runSchema ? { runs: runSchema } : {}) });
    if (gap) return gap;
  }
  if (!compat.compatible) warnings.push(`control-plane schema incompatible with harness linkage: ${compat.migration.map((m) => `${m.database}."${m.property}" (${m.type})`).join(", ")} — os_verify(TARGET) will HOLD_SCHEMA_MISMATCH until migrated`);
  const cursorSchema = await cursorSchemaOf(deps, state.cursor_ref);
  if (!cursorSchema) warnings.push("State/Manifest schema unreadable; the state-last write is rendered unvalidated");
  const gateKey = typeof state.gate.gate_key === "string" ? state.gate.gate_key : "UNKNOWN";
  const plan_id = opaqueId();
  const writes = deriveWrites(g, ops, { plan_id, summary: intent.summary, runs_ds: dbs.runs, ledger_ds: dbs.ledger, cursor_ref: state.cursor_ref, gate_key: gateKey, governing: fresh, target_schemas: targetSchemas, ...(runSchema ? { run_schema: runSchema.properties } : {}), ...(ledgerSchema ? { ledger_schema: ledgerSchema.properties } : {}), ...(cursorSchema ? { cursor_schema: cursorSchema } : {}) });
  warnings.push(...writes.warnings);
  const graphFingerprint = (await import("../resume/b7DryRun.ts")).b7IntentFingerprint(intent);
  const sourceAttestation = sourceEnrollmentAttestation(intent);
  writes.state_last = { ...writes.state_last,
    ...(sourceAttestation ? { source_identity_enrollment: sourceAttestation } : {}),
    ...(binding.lane === "SALES" && g.productionGuard ? { guard_mutations: structuredClone(intent.mutations) } : {}),
    ...(g.cursorTransitions?.some(t => t.evidence.kind === "B7_GRAPH") ? { operation_property_ids: operationPropertyIds } : {}),
    ...(graphFingerprint ? { b7_graph_fingerprint: graphFingerprint } : {}) };

  // 7. Persist under the lease (atomic; a concurrent winner makes this BUSY).
  const draft: PlanDraft = {
    ...(options.automaticAdoption ? { plan_origin: "AUTO_RECONCILE" as const } : {}),
    principal_id: binding.principal_id,
    binding,
    governing: fresh,
    run_mode: chooseRunMode(typeof state.current_run === "object" ? String(state.current_run.status) : undefined),
    execution_attempt_id: opaqueId(),
    baseline_runtime_revision: typeof state.cursor_last_edited === "string" ? state.cursor_last_edited : "UNKNOWN",
    operations: ops,
    stage1_writes: writes.stage1,
    finalization_writes: writes.finalization,
    state_last_write: writes.state_last,
  };
  const created = await createPlan(store, deps.config, { ...draft, plan_id }, now);
  if (created.kind === "BUSY") return hold("HOLD_RUNTIME_BUSY", [`another plan (${created.holder_plan_id}) won the runtime lease`, "no plan was created"], "wait for the active plan to reach a terminal state, then prepare again", { warnings });
  if (created.kind === "EXISTING") return { kind: "PREPARED", plan: created.plan, replayed: true, warnings: [...warnings, "replayed: equivalent active plan"], observations: {} };
  return { kind: "PREPARED", plan: created.plan, replayed: false, warnings, observations: { gate_key: gateKey, cursor_ref: state.cursor_ref, cursor_last_edited: state.cursor_last_edited, current_run: state.current_run, durable_next_action: state.next_safe_action, control_plane_schema: { compatible: compat.compatible, migration: compat.migration } } };
}
