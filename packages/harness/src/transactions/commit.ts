/**
 * os_commit (PV-WRITE-001 / W3.1, decision PDEC-018 — CANDIDATE, NOT ADOPTED): one call prepares, writes, reads back
 * and proves one transaction on the server, then — budget permitting — the cursor movement it authorizes.
 *
 * Staging (W3.1S): routed by MCP CallTool only; ListTools still announces the six historical names until W3.3.
 * Legacy inputs plus the version-gated W4.3 native capture. The answer is a `CommitOutcome` (annex A.3), never the six-tool
 * envelope. In order:
 *   1. an INSTALL_ONLY binding is left to its unchanged installation path;
 *   2. ledger recovery (settle): the principal's own started work is finished or recovered first. Historical
 *      own-journal recovery keeps its guards unchanged; a candidate foreign-Run import is always guarded again.
 *      An unwritten plan of this binding is replayed only by a guarded intent;
 *   3. the intent: the caller's, the one fresh capability evidence derives, or the derived cursor movement;
 *   4. SALES: the Production Guard preflight at T-0 (guards/preflight.ts) — a HOLD here writes nothing at all;
 *   5. prepare (persisted-replay detection on), then the executor; the approved guard is re-proven before EVERY
 *      Notion write of the new plan, and a drift stops the call before that byte — HELD when nothing was written,
 *      otherwise INTERRUPTED for ledger recovery; a re-check the budget cannot finish is IN_PROGRESS;
 *   6. PERSISTED without a step movement: the derived movement in the same call when ≥ 18 s remain, guarded like any
 *      new mutation, otherwise DEFERRED.
 */
import { randomBytes } from "node:crypto";
import type { BindingRecord } from "../binding/store.ts";
import { isDeepStrictEqual } from "node:util";
import type { HoldCode } from "../errors/codes.ts";
import { checkMutations, guardStillApproved, openGuard, type GuardHold, type MissingFact, type OpenGuard } from "../guards/preflight.ts";
import type { Intent } from "../plans/prepare.ts";
import type { NotionReadClient } from "../notion/readClient.ts";
import { propText, type Page } from "../notion/shapes.ts";
import { StructureCache } from "../notion/structureCache.ts";
import { linkageId, type Plan, type PlanOrigin, type PlanWriteRow } from "../plans/store.ts";
import type { ResolvedRuntime } from "../resolvers/types.ts";
import { checkLaneScope } from "../tools/lane.ts";
import type { CallContext } from "../tools/handlers.ts";
import type { ReceiptRecord } from "../verify/engine.ts";
import { Deadline, HARNESS_CALL_BUDGET_MS } from "./budget.ts";
import { executeTransaction, type ExecutorHoldCode, type TransactionDeps, type TransactionOutcome, type WritePhase } from "./execute.ts";
import { settle } from "./settle.ts";
import { deriveExternalEvent, eventVersionAllowed, eventRecoveryClassesApproved, externalEventPlanStillOwned, externalEventSourceOwned, isEventResource, isExternalEventPlan, eventPlanMatchesCapture, externalEventJournalConsistent } from "../effects/eventWrite.ts";
import type { ExternalEventEvidence } from "../tools/surface.ts";
import { FOREIGN_RUN_ACTION, foreignRunStillOwned, isForeignRunImport } from "../resume/foreignRuns.ts";
import { deriveSourceEnrollment, isSourceEnrollmentEvidence, isBackendOwnedSourceEnrollmentIntent, isSourceEnrollmentPlan, rememberSourceEnrollmentConfirmation, sourceEnrollmentConfirmationIsCurrent, type SourceEnrollmentChallenge } from "../resume/sourceEnrollment.ts";

/** A derived movement starts in the same call only with at least this much budget left (A.4). */
export const DERIVED_MOVE_MIN_MS = 18_000;

export type DerivedMove = "NONE" | "PERSISTED" | "DEFERRED" | "IN_PROGRESS" | "INTERRUPTED" | "HELD";
export interface CommitTarget { readonly ordinal: number; readonly logical_resource_key: string; readonly operation: string; readonly target_ref: string }
export type CommitHoldCode = ExecutorHoldCode | GuardHold["code"];

/** The candidate TransactionOutcome of annex A.3, as os_commit answers it. `say` is the one human sentence. */
export type CommitOutcome =
  | { readonly kind: "PERSISTED"; readonly origin: PlanOrigin; readonly plan_id: string; readonly target_receipt_id: string; readonly final_receipt_id: string; readonly run_ref: string; readonly repeated: boolean; readonly step_moved: boolean; readonly next_gate: string; readonly derived_move: DerivedMove; readonly derived_plan_id?: string; readonly targets: readonly CommitTarget[]; readonly writes_sent: number; readonly external_action?: unknown; readonly warnings: readonly string[] }
  | { readonly kind: "IN_PROGRESS"; readonly origin: PlanOrigin; readonly plan_id: string; readonly phase: WritePhase | "TARGET"; readonly writes_done: number; readonly writes_total: number; readonly reason: "BUDGET" | "CLAIMED_ELSEWHERE" | "INDEX_LAG"; readonly warnings: readonly string[] }
  | { readonly kind: "INTERRUPTED"; readonly origin: PlanOrigin; readonly plan_id: string; readonly phase: WritePhase; readonly writes_done: number; readonly writes_total: number; readonly failed_symbol: string; readonly notion_status: number | "TRANSPORT" | "TIMEOUT" | "NOT_SENT"; readonly reason?: "GUARD_DRIFT"; readonly warnings: readonly string[] }
  | { readonly kind: "HELD"; readonly origin: PlanOrigin; readonly plan_id?: string; readonly phase: WritePhase | "TARGET" | "FINAL" | "PREPARE"; readonly code: CommitHoldCode; readonly evidence: readonly string[]; readonly safe_action: string; readonly missing: readonly MissingFact[]; readonly wrote_anything: boolean; readonly warnings: readonly string[]; readonly source_identity_enrollment?: SourceEnrollmentChallenge; readonly next?: { readonly conduct: string } };

export interface CommitInput {
  readonly intent?: Intent;
  readonly capability_evidence?: { readonly challenge: string; readonly competent_source: string; readonly source_identity?: string | undefined; readonly evidence_ref: string; readonly verified_at: string };
  readonly external_event_evidence?: ExternalEventEvidence;
}

/** The executor's dependencies, plus the clock, sleep and call budget a caller (or a test) may pin. */
export type CommitDeps = TransactionDeps & { readonly clock?: () => Date; readonly sleep?: (ms: number) => Promise<void>; readonly commitBudgetMs?: number };

const IN_FLIGHT = new Set(["AWAITING_STAGE1_WRITES", "TARGET_VERIFIED", "AWAITING_FINAL_VERIFY"]);

const heldPrepare = (origin: PlanOrigin, code: CommitHoldCode, evidence: readonly string[], safe_action: string, missing: readonly MissingFact[] = [], warnings: readonly string[] = []): Extract<CommitOutcome, { kind: "HELD" }> =>
  ({ kind: "HELD", origin, phase: "PREPARE", code, evidence, safe_action, missing, wrote_anything: false, warnings });

export async function commit(deps: CommitDeps, binding: BindingRecord, runtime: ResolvedRuntime, input: CommitInput, ctx: CallContext): Promise<CommitOutcome> {
  if (runtime.operation_policy === "LEGACY_READ_ONLY") return heldPrepare("INTENT", "HOLD_ACTION_NOT_AUTHORIZED",
    ["LEGACY_READ_ONLY forbids recovery, plans, leases, claims and writes"], "finish the verified migration before recording; historical source data stays read-only");
  const fixed = ctx.now;
  const clock = deps.clock ?? (fixed ? () => fixed : () => new Date());
  const deadline = new Deadline(() => clock().getTime(), deps.commitBudgetMs ?? HARNESS_CALL_BUDGET_MS);
  const sleep = deps.sleep;
  const warnings: string[] = [];
  const execBase = { principal_id: binding.principal_id, binding, runtime, deadline, clock, ...(sleep ? { sleep } : {}) };

  // Reject a forged event intent before even recovering another plan. No public bypass, including RECONCILE {}.
  if (input.intent?.mutations.some((m) => isEventResource(m.logical_resource_key))) return heldPrepare("INTENT", "HOLD_ACTION_NOT_AUTHORIZED", ["external event records are server-derived only"], "submit a bounded native capture, not record mutations");
  if (input.external_event_evidence) {
    if (input.intent || input.capability_evidence) return heldPrepare("AUTO_RECONCILE", "ERROR_INVALID_ARGUMENT", ["capture and other intents are mutually exclusive"], "submit only one capture");
    if (!eventVersionAllowed(runtime)) return heldPrepare("AUTO_RECONCILE", "HOLD_SCHEMA_MISMATCH", ["native capture candidate pins are required"], "use the authorized candidate version");
    if (binding.binding_mode === "INSTALL_ONLY") return heldPrepare("INSTALL", "HOLD_INSTALL_REQUIRED", ["installation cannot reconcile business events"], "complete the candidate installation first");
    return commitExternalEvent(deps, binding, runtime, input.external_event_evidence, execBase, clock);
  }

  // 1. Installation keeps its own path, unchanged.
  if (binding.binding_mode === "INSTALL_ONLY") return heldPrepare("INSTALL", "HOLD_INSTALL_REQUIRED", ["this binding is INSTALL_ONLY; os_commit carries no installation step and acquires no business authority"], "continue the installation with the tools that serve it");

  // A negative reply cancels only the pending prompt, before any business-journal recovery can write.
  if (input.capability_evidence && isSourceEnrollmentEvidence(input.capability_evidence) && input.capability_evidence.evidence_ref.startsWith("user-declined:")) {
    if (input.intent) return heldPrepare("INTENT", "ERROR_INVALID_ARGUMENT", ["intent and capability_evidence are mutually exclusive"], "submit only the current reply");
    const declined = await deriveSourceEnrollment(new StructureCache(deps.notion), binding, runtime, input.capability_evidence, clock());
    if (declined.kind === "HOLD") return heldPrepare("INTENT", declined.code, declined.evidence, declined.safe_action);
    if (declined.kind !== "DECLINED" || !await sourceEnrollmentConfirmationIsCurrent(deps.store, binding, runtime, input.capability_evidence.challenge))
      return heldPrepare("INTENT", "HOLD_ACTION_NOT_AUTHORIZED", ["first-link confirmation is no longer pending"], "resume; do not reuse a declined or superseded confirmation");
    await rememberSourceEnrollmentConfirmation(deps.store, binding, runtime, declined.enrollment, clock(), "DECLINED");
    return heldPrepare("INTENT", "HOLD_UNKNOWN_REQUIRED_FACT", ["SOURCE_ENROLLMENT_DECLINED"], "leave this account unlinked; a later attempt requires a new observation and explicit reply");
  }

  // 2. Ledger recovery of the principal's own started work. An unwritten plan of THIS binding is not recovery: only
  //    a guarded intent may replay it, so settle — which would execute it — is not run while one exists.
  const own = (await deps.store.plans.listByRuntime(binding.project, binding.lane, binding.runtime_generation)).filter((p) => p.principal_id === binding.principal_id);
  let unwrittenHere = false;
  for (const p of own) {
    if (p.binding_id !== binding.binding_id || p.plan_state !== "AWAITING_STAGE1_WRITES") continue;
    if (!(await deps.store.planWrites.list(p.plan_id)).some((r) => r.status !== "PENDING")) unwrittenHere = true;
  }
  const owed = own.filter((p) => IN_FLIGHT.has(p.plan_state) || p.plan_state === "EXPIRED");
  for (const owedEvent of owed.filter(isExternalEventPlan)) {
    // Older empty expired drafts must not hide a started event behind unguarded generic settlement.
    const journal = await deps.store.planWrites.list(owedEvent.plan_id);
    if (!journal.some((r) => r.status !== "PENDING")) continue;
    // A backend-issued recovery may still have no bytes when its opening used the previous call budget.
    // Continue only that exact direct child on this binding, through the same guarded recovery path.
    const children = owed.filter((p) => p.binding_id === binding.binding_id && p.recovers_plan_id === linkageId(owedEvent)
      && IN_FLIGHT.has(p.plan_state) && p.expires_at.getTime() > clock().getTime());
    if (children.length > 1) return heldPrepare("AUTO_RECOVERY", "HOLD_RUNTIME_BUSY", ["multiple live recovery children"], "reconcile the owned recovery lineage");
    const child = children[0];
    if (child) {
      const runRef = owedEvent.run_ref ?? journal.find((r) => r.symbol === "OPEN_RUN" && ["DONE", "OBSERVED"].includes(r.status))?.created_id;
      const sameScope = ["principal_id", "project", "lane", "runtime_logical_key", "runtime_id", "runtime_generation"]
        .every((k) => child[k as keyof Plan] === owedEvent[k as keyof Plan] && child[k as keyof Plan] === binding[k as keyof BindingRecord]);
      const samePins = ["governing_spec_version", "governing_schema_version", "governing_control_version"]
        .every((k) => child[k as keyof Plan] === owedEvent[k as keyof Plan]);
      const withoutIds = (p: Plan) => p.operations.map(({ operation_id: _fresh, ...operation }) => operation);
      if (child.plan_kind !== "BUSINESS" || child.run_mode !== "RECOVER_EXISTING" || child.plan_origin !== "AUTO_RECOVERY"
        || child.parent_plan_id !== owedEvent.plan_id || !runRef || child.run_ref !== runRef || !sameScope || !samePins
        || !isDeepStrictEqual(withoutIds(child), withoutIds(owedEvent)))
        return heldPrepare("AUTO_RECOVERY", "HOLD_DUPLICATE", ["prepared recovery child differs from its original authority"], "reconcile the exact recovery lineage before any byte");
    }
    return recoverExternalEvent(deps, binding, runtime, child ?? owedEvent, execBase, clock);
  }
  if (!unwrittenHere && owed.length > 0) {
    // Every plan of one runtime generation writes its State last to the same cursor record.
    const report = await settle(deps, { ...execBase, cursor_ref: (owed[0] as Plan).state_last_write.target_ref });
    warnings.push(...report.notices, ...report.warnings);
    const recovered = report.outcomes.filter((o) => o.kind === "PERSISTED").length;
    if (recovered > 0) warnings.push(`${recovered} earlier transaction(s) of this space were completed from the ledger before this change`);
    if (report.durable_hold) warnings.push(`earlier work of this space is held (${report.durable_hold.code}) and needs a decision; it is not retried automatically`);
    const pending = report.outcomes.find((o) => o.kind === "IN_PROGRESS" || o.kind === "INTERRUPTED");
    if (pending) return withWarnings(pending as CommitOutcome, warnings);
    if (!input.intent && !input.capability_evidence && !report.durable_hold) {
      const completed = report.outcomes.filter((o) => o.kind === "PERSISTED");
      if (completed.length === 1) {
        const recovered = completed[0]!;
        if (recovered.kind === "PERSISTED") {
          const proof = await deps.store.plans.get(recovered.plan_id);
          if (proof && (proof.state_last_write.b7_graph_fingerprint || isSourceEnrollmentPlan(runtime, proof))) {
            const final = await deps.store.receipts.get(recovered.final_receipt_id);
            if (final?.type === "FINAL" && final.status === "VALID" && final.plan_id === proof.plan_id)
              return { ...recovered, warnings: [...warnings, ...recovered.warnings], next_gate: await currentGate(deps, binding, runtime, clock()), derived_move: "NONE", targets: targetsOf(proof, final) };
          }
        }
      }
    }
  }

  // 3. The intent.
  let intent: Intent | undefined = input.intent;
  let origin: PlanOrigin = intent?.action_class === FOREIGN_RUN_ACTION ? "AUTO_RECOVERY" : "INTENT";
  let preparationRead: NotionReadClient | undefined;
  if (input.intent && input.capability_evidence) return heldPrepare(origin, "ERROR_INVALID_ARGUMENT", ["intent and capability_evidence are mutually exclusive"], "submit the business intent or the fresh capability evidence, never both");
  if (input.capability_evidence) {
    const { deriveCapabilityRemediation } = await import("../resume/capabilityRemediation.ts");
    // One call-local structural view for derivation/preparation ONLY. Pages/queries stay fresh;
    // guards, execution, verification and the next commit always use the original reader.
    preparationRead = new StructureCache(deps.notion);
    const derived = isSourceEnrollmentEvidence(input.capability_evidence)
      ? await deriveSourceEnrollment(preparationRead, binding, runtime, input.capability_evidence, clock())
      : await deriveCapabilityRemediation(preparationRead, binding, runtime, input.capability_evidence, clock(), deps.competentSource);
    if (derived.kind === "CONFIRM") {
      await rememberSourceEnrollmentConfirmation(deps.store, binding, runtime, derived.enrollment, clock());
      return { ...heldPrepare(origin, "HOLD_UNKNOWN_REQUIRED_FACT", ["native profile observed; explicit member confirmation required before any link"], "ask whether to use the observed account for this space", [], warnings),
        source_identity_enrollment: derived.enrollment,
        next: { conduct: "Say `say` and stop. Only after an explicit affirmative HUMAN reply to this exact account question, call os_commit with NO intent and source_identity_enrollment.completion_args unchanged, adding only this binding_handle. If the current human explicitly declines that exact account, use decline_args unchanged instead; no Notion write. A prior yes, done, app tag or assistant answer is not confirmation. Uncertainty: no submission. On the next message os_resume returns the pending confirmation without another native read. If expired, resume and observe again. Never claim the server independently verified the native account or granted any permission." } };
    }
    if (derived.kind === "HOLD") return heldPrepare(origin, derived.code, derived.evidence, derived.safe_action, [], warnings);
    if (derived.kind === "DECLINED") return heldPrepare(origin, "HOLD_ACTION_NOT_AUTHORIZED", ["first-link decline requires the exact negative reply"], "resume and use the server-issued decline arguments");
    if (isSourceEnrollmentEvidence(input.capability_evidence) && !await sourceEnrollmentConfirmationIsCurrent(deps.store, binding, runtime, input.capability_evidence.challenge))
      return heldPrepare(origin, "HOLD_ACTION_NOT_AUTHORIZED", ["first-link confirmation is no longer pending"], "resume; do not reuse a declined or superseded confirmation", [], warnings);
    intent = derived.intent;
  }
  let derivedTransition: import("../versions/adapters/controlPlane.ts").DerivedCursorTransition | undefined;
  if (!intent) {
    const d = await deriveMove(deps, binding, runtime, clock());
    if (d.kind === "HOLD") return heldPrepare(origin, d.code, d.evidence, d.safe_action, [], warnings);
    if (d.kind === "NONE") return heldPrepare(origin, "ERROR_INVALID_ARGUMENT", ["no intent was given and the durable state authorizes no step movement"], "provide the business intent served by os_resume", [], warnings);
    intent = d.intent;
    derivedTransition = d.transition;
    origin = "DERIVED_MOVE";
  }
  if (input.intent) {
    // A gate is moved by the evidence the contract names, never by a caller's intent (same refusal as os_prepare).
    const asIs = (m: { readonly desired_changes: Readonly<Record<string, unknown>> }) => input.intent?.action_class === "RECONCILE" && Object.keys(m.desired_changes).length === 0;
    const forged = input.intent.mutations.filter((m) => m.logical_resource_key === "SALES:SOURCE_IDENTITY" || (runtime.adapter.controlPlane.resources?.[m.logical_resource_key]?.backendDerivedOnly === true && !asIs(m)));
    if (forged.length > 0) return heldPrepare(origin, "HOLD_ACTION_NOT_AUTHORIZED", [`${[...new Set(forged.map((m) => m.logical_resource_key))].join(", ")} is derived by the backend from verified durable evidence`, "a submitted intent for it is refused before plan, Run or lease creation"], "let the durable step advance from the evidence it requires; submit no intent for it", [], warnings);
  }
  const scope = checkLaneScope(binding.lane, intent.mutations.map((m) => m.logical_resource_key));
  if (scope.kind === "CROSS_LANE") return heldPrepare(origin, "HOLD_CROSS_LANE", scope.keys.map((k) => `resource ${k} is outside lane ${binding.lane}`), `this binding is fixed to lane ${binding.lane}; bind the other lane in its own binding`, [], warnings);
  if (scope.kind === "UNSCOPED") return heldPrepare(origin, "HOLD_RESOURCE_UNKNOWN", scope.keys.map((k) => `resource ${k} has no lane namespace`), "use lane-namespaced logical resource keys (META:<resource> or SALES:<resource>)", [], warnings);

  // 4. The Production Guard at T-0 (Sales only: META inherits no Sales rule).
  let guard: OpenGuard | undefined;
  if (binding.lane === "SALES") {
    const opened = await openGuard(deps, binding, runtime, clock());
    if (opened.kind === "HOLD") return guardHeld(deps, binding, origin, opened, warnings, clock());
    guard = opened;
    const verdict = await checkMutations(deps.notion, runtime, binding, guard, intent.mutations);
    if (verdict.kind === "HOLD") return guardHeld(deps, binding, origin, verdict, warnings, clock());
  }

  // 5. Prepare and execute.
  const first = await run(deps, binding, runtime, intent, origin, guard, execBase, clock, preparationRead);
  if (first.kind !== "PERSISTED") return withWarnings(first, warnings);
  // A first account link grants no business step and creates no operational read proof.
  if (isBackendOwnedSourceEnrollmentIntent(intent)) return { ...first, next_gate: await currentGate(deps, binding, runtime, clock()), derived_move: "NONE", warnings: [...warnings, ...first.warnings] };
  const gateProp = runtime.adapter.controlPlane.stateCursor?.currentGate ?? runtime.adapter.controlPlane.manifestCursor.currentGate;
  if (first.step_moved || origin !== "INTENT") {
    const gate = derivedTransition && gateProp ? derivedTransition.set[gateProp] : undefined;
    const saved = intent.action_class === FOREIGN_RUN_ACTION ? await deps.store.plans.get(first.plan_id) : undefined;
    let importedGate: string | undefined;
    if (saved && isForeignRunImport(saved)) {
      try { importedGate = gateProp ? propText(await deps.notion.retrievePage(saved.state_last_write.target_ref) as Page, gateProp) : undefined; }
      catch { /* FINAL is already durable; an unavailable cursor is not permission to write again. */ }
      importedGate ||= "UNKNOWN";
    }
    return { ...first, next_gate: typeof gate === "string" ? gate : importedGate ?? await currentGate(deps, binding, runtime, clock()), warnings: [...warnings, ...first.warnings] };
  }

  // 6. The derived movement this transaction authorizes, in the same call when the budget allows.
  if (!deadline.allows(DERIVED_MOVE_MIN_MS)) return { ...first, derived_move: "DEFERRED", next_gate: "UNKNOWN", warnings: [...warnings, ...first.warnings] };
  const d = await deriveMove(deps, binding, runtime, clock());
  if (d.kind === "NONE") return { ...first, next_gate: d.gate, warnings: [...warnings, ...first.warnings] };
  if (d.kind === "HOLD") return { ...first, derived_move: "HELD", next_gate: "UNKNOWN", warnings: [...warnings, ...first.warnings, `the step movement was not derived (${d.code})`] };
  if (guard) {
    const verdict = await checkMutations(deps.notion, runtime, binding, guard, d.intent.mutations);
    if (verdict.kind === "HOLD") return { ...first, derived_move: "HELD", next_gate: "UNKNOWN", warnings: [...warnings, ...first.warnings, `the step movement is held by the Production Guard (${verdict.code}); nothing of it was written`] };
  }
  const second = await run(deps, binding, runtime, d.intent, "DERIVED_MOVE", guard, execBase, clock);
  if (second.kind !== "PERSISTED") return { ...first, derived_move: second.kind, ...(second.plan_id ? { derived_plan_id: second.plan_id } : {}), next_gate: "UNKNOWN", warnings: [...warnings, ...first.warnings, ...second.warnings] };
  const gate = gateProp ? d.transition.set[gateProp] : undefined;
  return { ...first, step_moved: second.step_moved || first.step_moved, derived_move: "PERSISTED", derived_plan_id: second.plan_id, next_gate: typeof gate === "string" ? gate : second.next_gate, writes_sent: first.writes_sent + second.writes_sent, warnings: [...warnings, ...first.warnings, ...second.warnings] };
}

function withWarnings(o: CommitOutcome | TransactionOutcome, warnings: readonly string[]): CommitOutcome {
  const merged = [...warnings, ...o.warnings];
  if (o.kind === "HELD") return { ...o, missing: "missing" in o ? o.missing : [], warnings: merged } as CommitOutcome;
  return { ...o, warnings: merged } as CommitOutcome;
}

async function guardHeld(deps: CommitDeps, binding: BindingRecord, origin: PlanOrigin, h: GuardHold, warnings: readonly string[], at: Date): Promise<CommitOutcome> {
  // Audit: the code and structural evidence only — the evidence never carries a business value.
  await deps.store.events.append({ event_type: "COMMIT_GUARD_HOLD", result: h.code, principal_id: binding.principal_id, binding_id: binding.binding_id, runtime_id: binding.runtime_id, detail: { evidence: [...h.evidence] }, created_at: at });
  return heldPrepare(origin, h.code, h.evidence, h.safe_action, h.missing, warnings);
}

type Derived =
  | { readonly kind: "INTENT"; readonly intent: Intent; readonly transition: import("../versions/adapters/controlPlane.ts").DerivedCursorTransition }
  | { readonly kind: "NONE"; readonly gate: string }
  | { readonly kind: "HOLD"; readonly code: HoldCode; readonly evidence: readonly string[]; readonly safe_action: string };

/** The cursor movement the durable state authorizes now (same derivation as os_prepare without intent). */
async function deriveMove(deps: CommitDeps, binding: BindingRecord, runtime: ResolvedRuntime, now: Date): Promise<Derived> {
  const { rehydrate } = await import("../resume/engine.ts");
  const { deriveCursorTransition } = await import("../plans/cursorTransition.ts");
  const rehydrated = await rehydrate(deps.notion, binding, runtime, deps.store, now);
  const durable = (rehydrated.kind === "OK" ? rehydrated.state : rehydrated.partial) as import("../resume/derive.ts").ResumeState;
  const derived = await deriveCursorTransition(deps, binding, runtime, durable);
  if (derived.kind === "HOLD") return derived;
  if (derived.kind === "INTENT") return { kind: "INTENT", intent: derived.intent, transition: derived.transition };
  return { kind: "NONE", gate: gateOf(durable) };
}

const gateOf = (state: Partial<import("../resume/derive.ts").ResumeState> | undefined): string => {
  const g = state?.gate?.gate_key;
  return typeof g === "string" && g !== "" ? g : "UNKNOWN";
};

async function currentGate(deps: CommitDeps, binding: BindingRecord, runtime: ResolvedRuntime, now: Date): Promise<string> {
  const { rehydrate } = await import("../resume/engine.ts");
  const r = await rehydrate(deps.notion, binding, runtime, deps.store, now);
  return gateOf(r.kind === "OK" ? r.state : r.partial);
}

/** One transaction: prepare (persisted replay detected), execute, and the PERSISTED answer's targets. */
async function run(deps: CommitDeps, binding: BindingRecord, runtime: ResolvedRuntime, intent: Intent, origin: PlanOrigin, guard: OpenGuard | undefined, execBase: { principal_id: string; binding: BindingRecord; runtime: ResolvedRuntime; deadline: Deadline; clock: () => Date; sleep?: (ms: number) => Promise<void> }, clock: () => Date, preparationRead?: NotionReadClient): Promise<CommitOutcome & { readonly plan_id?: string }> {
  const { prepare } = await import("../plans/prepare.ts");
  // A.4: ordinary intents need the same call-local structural deduplication as capability preparation.
  // Facts stay fresh; guards, execution and verification below retain the original reader.
  const prepareReads = preparationRead ?? new StructureCache(deps.notion);
  const prepared = await prepare({ ...deps, notion: prepareReads }, binding, runtime, intent, clock(), { detectPersistedReplay: true });
  if (prepared.kind === "HOLD") return heldPrepare(origin, prepared.code, prepared.evidence, prepared.safe_action, [], prepared.warnings ?? []);
  const plan = prepared.plan;
  const cursor = prepared.observations["cursor_ref"];
  const out = await executeTransaction(deps, {
    ...execBase, plan_id: plan.plan_id,
    cursor_ref: typeof cursor === "string" ? cursor : plan.state_last_write.target_ref,
    ...((guard || isExternalEventPlan(plan) || isForeignRunImport(plan)) ? { guardCheck: async () => isExternalEventPlan(plan)
      ? externalEventPlanStillOwned(deps, binding, runtime, plan, clock,
        guard ? () => guardStillApproved(deps, runtime, guard, clock()) : undefined)
      : (!isForeignRunImport(plan) || await foreignRunStillOwned(deps, runtime, plan)) && (!guard || await guardStillApproved(deps, runtime, guard, clock()))
        } : {}),
  });
  const warnings = [...prepared.warnings, ...out.warnings];
  if (out.kind !== "PERSISTED") return withWarnings({ ...out, origin, warnings: [] } as TransactionOutcome, warnings) as CommitOutcome & { plan_id?: string };
  const receipt = (await deps.store.receipts.findByPlan(plan.plan_id, "TARGET")).find((r) => r.receipt_id === out.target_receipt_id);
  const targets = targetsOf(plan, receipt);
  let external: unknown;
  if (receipt) {
    const { routingMetadataForPlan } = await import("../effects/adapter.ts");
    external = await routingMetadataForPlan(deps, runtime, plan, receipt);
  }
  return { ...out, origin, next_gate: "UNKNOWN", derived_move: "NONE", targets, ...(external ? { external_action: external } : {}), warnings };
}

/** Private eligibility, not authority: only the exact, never-started original manifest may save discovery. */
function untouchedEventJournal(plan: Plan, rows: readonly PlanWriteRow[]): boolean {
  if (plan.plan_kind !== "BUSINESS" || plan.run_mode !== "OPEN_NEW" || plan.recovers_plan_id
    || (plan.plan_origin ?? "INTENT") !== "INTENT" || plan.operations.some((o) => o.operation !== "CREATE")
    || plan.stage1_writes.length !== 7 || plan.finalization_writes.length !== 3 || rows.length !== 11) return false;
  const manifest = [...plan.stage1_writes.map((w) => ({ ...w, phase: "STAGE1" })),
    ...plan.finalization_writes.map((w) => ({ ...w, phase: "FINALIZATION" })), { ...plan.state_last_write, phase: "STATE_LAST" }];
  if (new Set(manifest.map((w) => w.symbol)).size !== 11 || new Set(rows.map((r) => r.symbol)).size !== 11) return false;
  return manifest.every((w) => {
    const r = rows.find((x) => x.symbol === w.symbol);
    return r?.plan_id === plan.plan_id && r.ordinal === w.ordinal && r.phase === w.phase
      && r.operation === w.operation && r.target_ref === w.target_ref && r.status === "PENDING" && r.attempts === 0
      && !r.sent_at && !r.done_at && !r.created_id && !r.payload_hash && !r.stamped_now && !r.last_error;
  });
}

async function commitExternalEvent(deps: CommitDeps, binding: BindingRecord, runtime: ResolvedRuntime, evidence: ExternalEventEvidence,
  execBase: Parameters<typeof run>[6], clock: () => Date): Promise<CommitOutcome> {
  const source = evidence.source_identity.trim().toLowerCase();
  if (evidence.message.from.trim().toLowerCase() !== source || !await externalEventSourceOwned(deps, binding, runtime, source))
    return heldPrepare("AUTO_RECONCILE", "HOLD_MAILBOX_IDENTITY_MISMATCH", ["capture sender/source lacks the unique bound assignment"], "repair the mailbox binding; do not send");
  // Structure only, private to this derivation/preparation. Every later guard/byte/proof uses raw deps.
  const preparationRead = new StructureCache(deps.notion);
  let hasStartedEvent = false;
  try {
    for (const p of await deps.store.plans.findActive(binding.project, binding.lane, binding.runtime_generation)) {
      if (isExternalEventPlan(p) && (await deps.store.planWrites.list(p.plan_id)).some((r) => r.status !== "PENDING")) {
        hasStartedEvent = true; break;
      }
    }
  } catch { hasStartedEvent = true; } // Uncertain optimization falls back, never masks a derive refusal.
  // Read-only independent streams on ONE paced client. Started recovery must not pay an unused T0 guard.
  let initialGuard: PromiseSettledResult<OpenGuard | GuardHold> | undefined;
  let d: Awaited<ReturnType<typeof deriveExternalEvent>>;
  if (hasStartedEvent) d = await deriveExternalEvent({ ...deps, notion: preparationRead }, binding, runtime, evidence);
  else {
    const [derived, guarded] = await Promise.allSettled([
      deriveExternalEvent({ ...deps, notion: preparationRead }, binding, runtime, evidence),
      openGuard(deps, binding, runtime, clock()),
    ]);
    if (derived.status === "rejected") throw derived.reason;
    d = derived.value; initialGuard = guarded;
  }
  if (d.kind === "HOLD") return heldPrepare("AUTO_RECONCILE", d.code, d.evidence, d.safe_action);
  const active = await deps.store.plans.findActive(binding.project, binding.lane, binding.runtime_generation);
  let exactUnwrittenDraft: Plan | undefined;
  for (const plan of active) {
    if (!isExternalEventPlan(plan)) continue;
    const journal = await deps.store.planWrites.list(plan.plan_id);
    if (journal.some((r) => r.status !== "PENDING")) {
      if (plan.principal_id !== binding.principal_id) return heldPrepare("AUTO_RECONCILE", "HOLD_RUNTIME_BUSY", ["another owner has unfinished event work"], "wait for journal recovery");
      if (!eventPlanMatchesCapture(plan, d.intent)) return heldPrepare("AUTO_RECONCILE", "HOLD_RUNTIME_BUSY", ["unfinished journal belongs to a different event or immutable capture"], "resume the original capture before submitting a different one");
      return recoverExternalEvent(deps, binding, runtime, plan, execBase, clock);
    } else if (plan.binding_id === binding.binding_id && plan.principal_id === binding.principal_id
      && plan.runtime_id === binding.runtime_id && plan.runtime_generation === binding.runtime_generation
      && plan.runtime_logical_key === binding.runtime_logical_key && plan.plan_state === "AWAITING_STAGE1_WRITES"
      && plan.expires_at.getTime() > clock().getTime() && eventPlanMatchesCapture(plan, d.intent)
      && untouchedEventJournal(plan, journal)) {
      exactUnwrittenDraft = plan;
    }
  }
  if (initialGuard?.status === "rejected") throw initialGuard.reason;
  const guard = initialGuard?.status === "fulfilled" ? initialGuard.value : await openGuard(deps, binding, runtime, clock());
  if (guard.kind === "HOLD") return guardHeld(deps, binding, "AUTO_RECONCILE", guard, [], clock());
  const exactClassesApproved = exactUnwrittenDraft
    && !d.intent.mutations.some((m) => guard.snapshot.guarded.some((g) => g.resource_key === m.logical_resource_key
      && g.natural_key === m.record_selector.natural_key))
    && await eventRecoveryClassesApproved(deps, exactUnwrittenDraft, guard.snapshot.index.operation_classes);
  if (!exactClassesApproved) {
    const verdict = await checkMutations(deps.notion, runtime, binding, guard, d.intent.mutations);
    if (verdict.kind === "HOLD") return guardHeld(deps, binding, "AUTO_RECONCILE", verdict, [], clock());
  }
  const result = await run(deps, binding, runtime, d.intent, "AUTO_RECONCILE", guard, execBase, clock, preparationRead);
  return result.kind === "PERSISTED" ? { ...result, step_moved: false, derived_move: "NONE" } : result;
}

export async function recoverExternalEvent(deps: CommitDeps, binding: BindingRecord, runtime: ResolvedRuntime, plan: Plan,
  execBase: Parameters<typeof run>[6], clock: () => Date): Promise<CommitOutcome> {
  // Recovery is journal-authorized, not a newly classified intent; guard/schema drift still forbids new bytes.
  const guard = await openGuard(deps, binding, runtime, clock());
  if (guard.kind === "HOLD") return guardHeld(deps, binding, "AUTO_RECOVERY", guard, [], clock());
  if (!(await eventRecoveryClassesApproved(deps, plan, guard.snapshot.index.operation_classes)))
    return heldPrepare("AUTO_RECOVERY", "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE", ["pending event CREATE no longer has exactly one approved reconciliation class"], "restore the reviewed event class before recovery");
  if (!(await externalEventJournalConsistent(deps, runtime, plan)))
    return heldPrepare("AUTO_RECOVERY", "HOLD_DUPLICATE", ["original event pair disagrees with its journal; lease and plan state untouched"], "reconcile the original pair; never recreate a settled target");
  if (plan.binding_id !== binding.binding_id || plan.plan_state === "EXPIRED") {
    // Use the existing binding-scoped recovery engine, never execute the old plan through a new handle.
    if (plan.principal_id !== binding.principal_id || plan.runtime_id !== binding.runtime_id || plan.runtime_generation !== binding.runtime_generation)
      return heldPrepare("AUTO_RECOVERY", "HOLD_CROSS_RUNTIME", ["event recovery scope changed"], "resume only the original owned runtime");
    const { transition } = await import("../plans/service.ts");
    const { openRecoveryPlan } = await import("../recovery/engine.ts");
    const original = plan;
    const token = randomBytes(18).toString("base64url");
    if (!(await deps.store.claims.claim(original.plan_id, token, clock(), new Date(clock().getTime() + 60_000))))
      return { kind: "IN_PROGRESS", origin: "AUTO_RECOVERY", plan_id: original.plan_id, phase: "STAGE1", reason: "CLAIMED_ELSEWHERE", writes_done: 0, writes_total: 0, warnings: [] };
    try {
      const current = await deps.store.plans.get(original.plan_id);
      if (!current || ![...IN_FLIGHT, "EXPIRED", "SUPERSEDED"].includes(current.plan_state)
        || ["plan_state", "binding_id", "runtime_generation"].some(k => current[k as keyof Plan] !== original[k as keyof Plan])
        || current.expires_at.getTime() !== original.expires_at.getTime())
        return { kind: "IN_PROGRESS", origin: "AUTO_RECOVERY", plan_id: original.plan_id, phase: "STAGE1", reason: "INDEX_LAG", writes_done: 0, writes_total: 0, warnings: ["the original plan changed before the recovery claim; no transfer was made"] };
      // Only an unclaimed original may transfer its lease: another chat must not interrupt an active writer.
      const scope = { project: binding.project, lane: binding.lane, runtime_generation: binding.runtime_generation };
      const priorLease = await deps.store.leases.current(scope, clock());
      await deps.store.leases.release(scope, original.plan_id);
      const opened = await openRecoveryPlan(deps, binding, runtime, original, { now: clock(), origin: "AUTO_RECOVERY",
        governing: { spec: original.governing_spec_version, schema: original.governing_schema_version, control: original.governing_control_version },
        journal: await deps.store.planWrites.list(original.plan_id) });
      if (opened.kind === "HOLD") {
        if (priorLease?.plan_id === original.plan_id && priorLease.expires_at > clock()) {
          const restored = await deps.store.leases.acquire(scope, original.plan_id, clock(), priorLease.expires_at);
          if (!restored.acquired) return heldPrepare("AUTO_RECOVERY", "HOLD_RUNTIME_BUSY", ["the recovery opening held and another plan now owns the runtime lease"], "resume the current owned work before this recovery");
        }
        return heldPrepare("AUTO_RECOVERY", opened.code, opened.evidence, opened.safe_action);
      }
      if (original.plan_state !== "EXPIRED") await transition(deps.store, original.plan_id, "SUPERSEDED", clock(), { reason: "same owner event recovery successfully opened on new binding" });
      plan = opened.plan;
    } finally { await deps.store.claims.release(original.plan_id, token); }
  }
  const out = await executeTransaction(deps, { ...execBase, plan_id: plan.plan_id, cursor_ref: plan.state_last_write.target_ref,
    guardCheck: () => externalEventPlanStillOwned(deps, binding, runtime, plan, clock, async () =>
      await guardStillApproved(deps, runtime, guard, clock())
      && await eventRecoveryClassesApproved(deps, plan, guard.snapshot.index.operation_classes)) });
  if (out.kind !== "PERSISTED") return withWarnings(out, []);
  const receipt = (await deps.store.receipts.findByPlan(plan.plan_id, "TARGET")).find((r) => r.receipt_id === out.target_receipt_id);
  return { ...out, origin: "AUTO_RECOVERY", step_moved: false, next_gate: "UNKNOWN", derived_move: "NONE", targets: targetsOf(plan, receipt) };
}

/** The records a transaction wrote, as ids only: no value leaves in the outcome. */
function targetsOf(plan: Plan, receipt: ReceiptRecord | undefined): CommitTarget[] {
  const observed = (receipt?.observations["targets"] as ReadonlyArray<{ ordinal?: number; target_ref?: string }> | undefined) ?? [];
  return plan.operations.map((o) => ({
    ordinal: o.ordinal, logical_resource_key: o.logical_resource_key, operation: o.operation,
    target_ref: observed.find((t) => t.ordinal === o.ordinal)?.target_ref ?? o.physical_target_ref ?? "UNKNOWN",
  }));
}
