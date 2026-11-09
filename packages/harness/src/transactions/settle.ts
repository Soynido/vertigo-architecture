/**
 * settle() — the first thing os_resume and os_commit will do (PV-WRITE-001 / W1.8, annex A.6).
 *
 * Before a principal is told anything or asked for anything, the harness finishes or recovers the work it
 * already owes them on this runtime, by itself:
 *
 *   - an own plan still in flight on THIS binding           → continued by the executor;
 *   - a guarded Sales draft with zero attempts on ANOTHER binding → preserved and reported, never hidden;
 *   - other own plans in flight on ANOTHER binding          → superseded, then recovered on this one;
 *   - an own plan that expired after the executor sent writes → recovered by observation (AUTO_RECOVERY);
 *   - a plan claimed by a live executor elsewhere            → one short wait, then reported IN_PROGRESS.
 *
 * Recovery reads before it writes: what already landed is adopted, never replayed; a user's local edit made in
 * the meantime is kept (conflict policy D10); anything ambiguous, duplicated or protected is a HOLD, reported in
 * `durable_hold` without blocking the read that follows. Automatic work that held once is not retried
 * automatically (AUTO_WORK_HELD): the next settle reports the hold instead of looping on it.
 */
import { randomBytes } from "node:crypto";
import { checkMutations, guardStillApproved, openGuard } from "../guards/preflight.ts";
import { idempotencyKey, type IntentMutation } from "../plans/prepare.ts";
import { expireIfDue, transition } from "../plans/service.ts";
import { isTerminal, linkageId, type Plan, type PlanWriteRow } from "../plans/store.ts";
import { foreignRunStillOwned, isForeignRunImport } from "../resume/foreignRuns.ts";
import { isExternalEventPlan } from "../effects/eventWrite.ts";
import { sourceEnrollmentMutationForPlan, sourceEnrollmentPlanConsentIsCurrent } from "../resume/sourceEnrollment.ts";
import { capabilityMutationForPlan } from "../resume/capabilityRemediation.ts";
import { executeTransaction, type ExecuteContext, type ExecutorHoldCode, type TransactionDeps, type TransactionOutcome } from "./execute.ts";

/** How long settle waits once for a plan another executor holds, before reporting IN_PROGRESS. */
export const CLAIM_WAIT_MS = 1_500;

/** The French sentence a principal hears when their own edit, made during an interrupted save, was kept (D10). */
export const D10_NOTICE = "Vous aviez modifié cette ligne dans Notion pendant l'enregistrement : votre version est conservée.";

export type SettleContext = Omit<ExecuteContext, "plan_id" | "cursor_ref"> & { readonly cursor_ref?: string };

export interface DurableHold {
  readonly plan_id: string;
  readonly code: ExecutorHoldCode;
  readonly evidence: readonly string[];
  readonly safe_action: string;
  /** True when this hold was already reported by an earlier settle and is not being retried. */
  readonly repeated: boolean;
}

export interface SettleReport {
  /** Every transaction settle drove in this call, in order. */
  readonly outcomes: readonly TransactionOutcome[];
  /** The first durable hold on this principal's own work; reading continues around it. */
  readonly durable_hold?: DurableHold;
  /** Plain sentences for the principal (never ids or codes). */
  readonly notices: readonly string[];
  readonly warnings: readonly string[];
  /** Only an unsent backend factory read-proof that passed the current requirement and guard. */
  readonly capability_continuation_plan_id?: string;
}

const IN_FLIGHT = new Set(["AWAITING_STAGE1_WRITES", "TARGET_VERIFIED", "AWAITING_FINAL_VERIFY"]);
const sentAnything = (journal: readonly PlanWriteRow[]) => journal.some((r) => r.status !== "PENDING" && !(r.status === "FAILED_FINAL" && r.attempts === 0));

export async function settle(deps: TransactionDeps, ctx: SettleContext): Promise<SettleReport> {
  const clock = ctx.clock ?? (() => new Date());
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const { store } = deps;
  const { binding } = ctx;
  const outcomes: TransactionOutcome[] = [];
  const notices: string[] = [];
  const warnings: string[] = [];
  let durable_hold: DurableHold | undefined;
  let capability_continuation_plan_id: string | undefined;
  const holdOnce = (h: DurableHold) => { durable_hold ??= h; };

  const own = (await store.plans.listByRuntime(binding.project, binding.lane, binding.runtime_generation)).filter((p) => p.principal_id === ctx.principal_id);
  // FINAL is immutable. Neither a closed plan nor its expired ancestors need another audit on each request.
  // Keep fresh lineage checks below for genuinely unfinished work: this is not a cache of Notion evidence.
  const completedLineages = new Set(own.filter(p => p.plan_state === "FINAL_VERIFIED").map(linkageId));
  const unfinished = own.filter(p => (!isTerminal(p.plan_state) || p.plan_state === "EXPIRED")
    && !(p.plan_state === "EXPIRED" && completedLineages.has(linkageId(p))));
  const heldBefore = new Map<string, { code: string; evidence: readonly string[] }>();
  for (const p of unfinished) {
    for (const e of await store.events.list({ plan_id: p.plan_id })) {
      if (e.event_type === "AUTO_WORK_HELD") heldBefore.set(p.plan_id, { code: e.result, evidence: (e.detail?.["evidence"] as string[] | undefined) ?? [] });
    }
  }

  const markHeld = async (plan: Plan, code: ExecutorHoldCode, evidence: readonly string[], safe_action: string, stamp = true) => {
    if (stamp) await store.events.append({ event_type: "AUTO_WORK_HELD", result: code, principal_id: plan.principal_id, binding_id: binding.binding_id, plan_id: plan.plan_id, runtime_id: plan.runtime_id, detail: { evidence: [...evidence], origin: plan.plan_origin ?? "INTENT" }, created_at: clock() });
    holdOnce({ plan_id: plan.plan_id, code, evidence, safe_action, repeated: false });
  };

  /** Drives one plan through the executor; one short wait if another executor holds it. */
  const drive = async (plan: Plan): Promise<TransactionOutcome> => {
    if (isExternalEventPlan(plan)) {
      // The native bookkeeping path already owns its source/guard checks. Never bypass them via generic resume.
      const { recoverExternalEvent } = await import("./commit.ts");
      const recovered = await recoverExternalEvent(deps, binding, ctx.runtime, plan, { ...ctx, principal_id: ctx.principal_id, clock }, clock);
      const out: TransactionOutcome = recovered.kind === "HELD" ? { ...recovered,
        plan_id: recovered.plan_id ?? plan.plan_id, phase: recovered.phase === "PREPARE" ? "STAGE1" : recovered.phase,
        code: recovered.code === "HOLD_P0_PRODUCTION" ? "HOLD_ACTION_NOT_AUTHORIZED" : recovered.code } : recovered;
      outcomes.push(out);
      if (out.kind === "HELD") await markHeld(plan, out.code, out.evidence, out.safe_action,
        recovered.kind === "HELD" && recovered.phase !== "PREPARE" && out.code !== "HOLD_ACTION_NOT_AUTHORIZED");
      return out;
    }
    let execution = { ...ctx, plan_id: plan.plan_id, cursor_ref: plan.state_last_write.target_ref };
    // An own draft has no started journal to recover. Its first byte is still a NEW guarded mutation,
    // even when os_resume continues the exact server-stored plan without resubmitting an intent.
    const unsentDraft = plan.plan_state === "AWAITING_STAGE1_WRITES" && plan.run_mode === "OPEN_NEW"
      && !!ctx.runtime.adapter.controlPlane.productionGuard
      && (plan.plan_origin ?? "INTENT") === "INTENT" && !isForeignRunImport(plan)
      && !plan.recovers_plan_id && !sentAnything(await store.planWrites.list(plan.plan_id));
    const root = isForeignRunImport(plan) || plan.plan_origin === "AUTO_RECONCILE" || unsentDraft
      ? plan : plan.recovers_plan_id ? await store.plans.get(plan.recovers_plan_id) : undefined;
    const sourceEnrollment = unsentDraft ? sourceEnrollmentMutationForPlan(ctx.runtime, plan) : undefined;
    let capabilityMutation: IntentMutation | undefined;
    const localAdoption = root?.plan_origin === "AUTO_RECONCILE" && root.operations.every(o => o.before_hash === o.expected_hash);
    if (root && binding.lane === "SALES" && (isForeignRunImport(root) || localAdoption || unsentDraft)) {
      let mutations: readonly IntentMutation[] = plan.operations.map(o => ({
        logical_resource_key: o.logical_resource_key, operation: o.operation,
        record_selector: o.natural_key ? { natural_key: o.natural_key } : { object_id: o.physical_target_ref! },
        desired_changes: localAdoption ? {} : Object.fromEntries(Object.entries(o.expected_values).filter(([f]) => f !== o.natural_key_property)),
      }));
      if (unsentDraft) {
        const saved = plan.state_last_write.guard_mutations;
        let exact = false;
        try {
          exact = Array.isArray(saved) && saved.length === plan.operations.length && saved.every((m, i) =>
            m.logical_resource_key === plan.operations[i]!.logical_resource_key
            && idempotencyKey(plan.runtime_generation, m) === plan.operations[i]!.idempotency_key);
        } catch { /* Malformed backend metadata is not permission to start a mutation. */ }
        if (!exact) {
          const out: Extract<TransactionOutcome, { kind: "HELD" }> = { kind: "HELD", origin: "AUTO_RECOVERY", plan_id: plan.plan_id, phase: "STAGE1",
            code: "HOLD_ACTION_NOT_AUTHORIZED", evidence: ["unsent plan lacks its exact validated guard mutations"],
            safe_action: "prepare the explicit intended change again; never infer an original mutation from resolved writes", wrote_anything: false, warnings: [] };
          outcomes.push(out); await markHeld(plan, out.code, out.evidence, out.safe_action, false); return out;
        }
        mutations = saved!;
        // Deserialized mutations have no factory provenance. Restore only this already-confirmed
        // backend identity plan, then reclassify it against the fresh approved guard below.
        if (sourceEnrollment) {
          if (!await sourceEnrollmentPlanConsentIsCurrent(store, binding, ctx.runtime, plan)) {
            const out: Extract<TransactionOutcome, { kind: "HELD" }> = { kind: "HELD", origin: "AUTO_RECOVERY", plan_id: plan.plan_id, phase: "STAGE1",
              code: "HOLD_ACTION_NOT_AUTHORIZED", evidence: ["unstarted first-link plan has no exact current member confirmation"],
              safe_action: "leave this account unlinked; resume with a new observation and explicit reply after the original plan expires", wrote_anything: false, warnings: [] };
            outcomes.push(out); await markHeld(plan, out.code, out.evidence, out.safe_action, false); return out;
          }
          mutations = [sourceEnrollment];
        }
      }
      if (unsentDraft && !sourceEnrollment && ctx.runtime.adapter.capabilities?.operatingModeRequirements) {
        const { readCapabilitySnapshot } = await import("../resume/readers.ts");
        const { evaluateCapabilityCompleteness } = await import("../resume/capabilities.ts");
        const snapshot = await readCapabilitySnapshot(deps.notion, ctx.runtime);
        const fresh = !snapshot ? await (await import("../resume/engine.ts")).rehydrate(deps.notion, binding, ctx.runtime, store, clock()) : undefined;
        const completeness = snapshot ? evaluateCapabilityCompleteness(ctx.runtime, snapshot)
          : fresh?.kind === "HOLD" && fresh.code === "HOLD_REQUIRED_CAPABILITY_INCOMPLETE" ? fresh.partial.capability_completeness : undefined;
        capabilityMutation = capabilityMutationForPlan(ctx.runtime, plan, completeness?.comparisons.find(c => c.requirement === "REQUIRED" && !c.satisfied
          && c.capability === plan.operations[0]?.expected_values["Capability Key"]));
        if (completeness?.complete !== true && !capabilityMutation) {
          const out: Extract<TransactionOutcome, { kind: "HELD" }> = { kind: "HELD", origin: "AUTO_RECOVERY", plan_id: plan.plan_id, phase: "STAGE1",
            code: "HOLD_REQUIRED_CAPABILITY_INCOMPLETE", evidence: ["unsent plan continuation lacks fresh capability completeness"],
            safe_action: "verify the required capabilities before starting this prepared change", wrote_anything: false, warnings: [] };
          outcomes.push(out); await markHeld(plan, out.code, out.evidence, out.safe_action, false); return out;
        }
        if (capabilityMutation) mutations = [capabilityMutation];
      }
      const sameScope = ["principal_id", "project", "lane", "runtime_logical_key", "runtime_id", "runtime_generation"]
        .every(k => root[k as keyof Plan] === plan[k as keyof Plan] && root[k as keyof Plan] === binding[k as keyof typeof binding]);
      const opened = sameScope ? await openGuard(deps, binding, ctx.runtime, clock()) : undefined;
      const verdict = opened?.kind === "OPEN" ? await checkMutations(deps.notion, ctx.runtime, binding, opened, mutations) : opened;
      if (!opened || opened.kind === "HOLD" || verdict?.kind === "HOLD") {
        const refusal = verdict?.kind === "HOLD" ? verdict : undefined;
        const out: Extract<TransactionOutcome, { kind: "HELD" }> = { kind: "HELD", origin: "AUTO_RECOVERY", plan_id: plan.plan_id, phase: "STAGE1",
          code: refusal?.code === "HOLD_P0_PRODUCTION" ? "HOLD_ACTION_NOT_AUTHORIZED" : refusal?.code ?? "HOLD_CROSS_RUNTIME", evidence: [unsentDraft ? "unsent plan continuation has no current scoped guard authorization" : "foreign-Run continuation has no current scoped guard authorization"],
          safe_action: "resolve the current guard or scoped import before any continuation", wrote_anything: false, warnings: [] };
        outcomes.push(out); await markHeld(plan, out.code, out.evidence, out.safe_action, false); return out;
      }
      const prior = ctx.guardCheck;
      execution = { ...execution, guardCheck: async () => (!isForeignRunImport(root) || await foreignRunStillOwned(deps, ctx.runtime, root))
        && await guardStillApproved(deps, ctx.runtime, opened, clock()) && (!prior || await prior()) };
    }
    let out = await executeTransaction(deps, execution);
    if (out.kind === "IN_PROGRESS" && out.reason === "CLAIMED_ELSEWHERE" && ctx.deadline.allows(CLAIM_WAIT_MS + 4_000)) {
      await sleep(CLAIM_WAIT_MS);
      out = await executeTransaction(deps, execution);
    }
    outcomes.push(out);
    if (capabilityMutation && out.kind === "IN_PROGRESS" && (out.reason === "BUDGET" || out.reason === "INDEX_LAG"))
      capability_continuation_plan_id = out.plan_id;
    if (out.kind === "HELD") await markHeld(plan, out.code, out.evidence, out.safe_action, !localAdoption || out.code !== "HOLD_ACTION_NOT_AUTHORIZED");
    return out;
  };

  /** Opens a recovery plan for an interrupted one on this binding, then drives it. */
  const recover = async (plan: Plan) => {
    if (isExternalEventPlan(plan)) { await drive(plan); return; }
    const journal = await store.planWrites.list(plan.plan_id);
    const { openRecoveryPlan } = await import("../recovery/engine.ts");
    const governing = { spec: plan.governing_spec_version, schema: plan.governing_schema_version, control: plan.governing_control_version };
    const opened = await openRecoveryPlan(deps, binding, ctx.runtime, plan, { governing, now: clock(), origin: "AUTO_RECOVERY", journal, conflictPolicy: "D10" });
    if (opened.kind === "HOLD") {
      // Nothing durable: nothing to recover, nothing to report.
      if (opened.code === "HOLD_PLAN_EXPIRED" && opened.evidence.some((e) => e.includes("left no durable"))) return;
      await markHeld(plan, opened.code, opened.evidence, opened.safe_action);
      return;
    }
    warnings.push(...opened.warnings);
    const adopted = ((opened.observations["recovery"] as { adopted?: readonly number[] } | undefined)?.adopted ?? []).length;
    const out = await drive(opened.plan);
    if (out.kind === "PERSISTED" && adopted > 0) notices.push(D10_NOTICE);
  };

  for (const found of unfinished) {
    if (!ctx.deadline.allows(8_000)) { warnings.push("settle stopped at its budget; the remaining work continues on the next call"); break; }
    await expireIfDue(store, found, clock());
    const plan = (await store.plans.get(found.plan_id)) ?? found;
    if (isTerminal(plan.plan_state) && plan.plan_state !== "EXPIRED") continue;

    const held = heldBefore.get(plan.plan_id);
    if (held) {
      // Anti-loop: automatic work that held is reported, never retried automatically.
      holdOnce({ plan_id: plan.plan_id, code: held.code as ExecutorHoldCode, evidence: held.evidence, safe_action: "the automatic continuation stopped on this plan earlier; it needs the principal's decision", repeated: true });
      continue;
    }
    if (plan.plan_state === "HOLD") {
      holdOnce({ plan_id: plan.plan_id, code: "HOLD_PLAN_REPLAY_INVALID", evidence: [`plan ${plan.plan_id} is on HOLD after a detected divergence`], safe_action: "reconcile the divergence before any automatic continuation", repeated: false });
      continue;
    }

    if (IN_FLIGHT.has(plan.plan_state)) {
      if (plan.binding_id === binding.binding_id) { await drive(plan); continue; }
      // In flight from another chat of the same principal: take it over only if no executor holds it.
      const token = randomBytes(18).toString("base64url");
      if (!(await store.claims.claim(plan.plan_id, token, clock(), new Date(clock().getTime() + 60_000)))) {
        outcomes.push({ kind: "IN_PROGRESS", origin: plan.plan_origin ?? "INTENT", plan_id: plan.plan_id, phase: "STAGE1", reason: "CLAIMED_ELSEWHERE", writes_done: 0, writes_total: 0, warnings: [] });
        continue;
      }
      const claimed = await store.plans.get(plan.plan_id);
      if (!claimed || !IN_FLIGHT.has(claimed.plan_state)
        || ["plan_state", "binding_id", "runtime_generation"].some(k => claimed[k as keyof Plan] !== plan[k as keyof Plan])
        || claimed.expires_at.getTime() !== plan.expires_at.getTime()) {
        await store.claims.release(plan.plan_id, token);
        continue;
      }
      if (binding.lane === "SALES" && !isExternalEventPlan(claimed)
        && claimed.expires_at.getTime() > clock().getTime()
        && claimed.plan_state === "AWAITING_STAGE1_WRITES" && claimed.run_mode === "OPEN_NEW"
        && !!ctx.runtime.adapter.controlPlane.productionGuard
        && (claimed.plan_origin ?? "INTENT") === "INTENT" && !isForeignRunImport(claimed)
        && !claimed.recovers_plan_id
        && (await store.planWrites.list(claimed.plan_id)).every(r => r.status === "PENDING" && r.attempts === 0)) {
        // Nothing exists to observe/adopt, and business verifiers require the original binding.
        // Keep that exact draft visible: an old unrelated FINAL receipt is not its completion proof.
        await store.claims.release(plan.plan_id, token);
        await markHeld(claimed, "HOLD_CROSS_RUNTIME", ["this unstarted plan belongs to the original binding; no write or completion has occurred"],
          "continue this prepared change in its original chat, or explicitly prepare the intended change again", false);
        continue;
      }
      await transition(store, plan.plan_id, "SUPERSEDED", clock(), { reason: "settle: the same principal continues from a new binding; recovered by observation" });
      await store.claims.release(plan.plan_id, token);
      await recover((await store.plans.get(plan.plan_id)) ?? plan);
      continue;
    }

    // EXPIRED: recover the executor's own interrupted work — the newest plan of its lineage (the original, or an
    // interrupted recovery of it), once, and only when no plan of that lineage is live or already final.
    if (plan.plan_state === "EXPIRED") {
      const link = linkageId(plan);
      const lineage = (await store.plans.listByRuntime(binding.project, binding.lane, binding.runtime_generation)).filter((q) => q.principal_id === ctx.principal_id && linkageId(q) === link);
      if (lineage.some((q) => q.plan_state === "FINAL_VERIFIED" || IN_FLIGHT.has(q.plan_state))) continue;
      const newest = [...lineage].sort((a, b) => a.created_at.getTime() - b.created_at.getTime()).at(-1);
      if (newest?.plan_id !== plan.plan_id) continue;
      const imported = isForeignRunImport(plan) ? plan : plan.recovers_plan_id ? await store.plans.get(plan.recovers_plan_id) : undefined;
      if (!sentAnything(await store.planWrites.list(plan.plan_id)) && !(imported && isForeignRunImport(imported))) continue;
      await recover(plan);
    }
  }
  return { outcomes, ...(durable_hold ? { durable_hold } : {}), notices, warnings,
    ...(capability_continuation_plan_id ? { capability_continuation_plan_id } : {}) };
}
