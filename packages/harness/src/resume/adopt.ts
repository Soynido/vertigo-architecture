/** Candidate D9: one bounded, journaled adoption batch, not a confirmation or a new adoption framework. */
import { createHash } from "node:crypto";
import type { BindingRecord } from "../binding/store.ts";
import type { ResolvedRuntime } from "../resolvers/types.ts";
import type { CommitDeps, CommitHoldCode } from "../transactions/commit.ts";
import { Deadline, HARNESS_CALL_BUDGET_MS } from "../transactions/budget.ts";
import { settle } from "../transactions/settle.ts";
import { executeTransaction } from "../transactions/execute.ts";
import { checkMutations, guardStillApproved, openGuard } from "../guards/preflight.ts";
import { prepare, type Intent } from "../plans/prepare.ts";
import { rehydrate, type ResumeOutcome } from "./engine.ts";
import { storedCapabilityProofMatches } from "./capabilityRemediation.ts";

export interface AdoptionHold {
  readonly plan_id?: string;
  readonly code: CommitHoldCode;
  readonly evidence: readonly string[];
  readonly safe_action: string;
  readonly repeated: boolean;
}
export const CURSOR_ADOPTION_NOTICE = "Votre progression modifiée dans Notion a été prise en compte.";

export async function resumeAndAdopt(deps: CommitDeps, binding: BindingRecord, runtime: ResolvedRuntime, now: Date): Promise<{ resume: ResumeOutcome }> {
  // A five-tool client cannot repin a historical Sales runtime or turn its native-writer plans into server work.
  if (binding.lane === "SALES" && !runtime.adapter.controlPlane.independentConfigurationResourceKey)
    return { resume: await rehydrate(deps.notion, binding, runtime, deps.store, now) };
  const clock = deps.clock ?? (() => new Date());
  const deadline = new Deadline(() => clock().getTime(), deps.commitBudgetMs ?? HARNESS_CALL_BUDGET_MS);
  const ctx = { principal_id: binding.principal_id, binding, runtime, deadline, clock, ...(deps.sleep ? { sleep: deps.sleep } : {}) };
  const settled = await settle(deps, ctx);
  const ledger_completed: { plan_id: string; final_receipt_id: string }[] = [];
  for (const outcome of settled.outcomes) {
    if (outcome.kind !== "PERSISTED") continue;
    const final = await deps.store.receipts.get(outcome.final_receipt_id);
    if (final?.type === "FINAL" && final.status === "VALID" && final.receipt_id === outcome.final_receipt_id
      && final.plan_id === outcome.plan_id && final.principal_id === binding.principal_id
      && final.runtime_id === binding.runtime_id && final.runtime_generation === binding.runtime_generation)
      ledger_completed.push({ plan_id: outcome.plan_id, final_receipt_id: final.receipt_id });
  }
  let resume = await rehydrate(deps.notion, binding, runtime, deps.store, now, undefined, true);
  // Only an actual executor budget/index boundary may continue. A boolean adoption flag also covers
  // races and interrupted work; it is not sufficient evidence for another automatic call.
  const pending = settled.outcomes.filter(o => o.kind !== "PERSISTED");
  const unfinished = pending.length === 1 ? pending[0] : undefined;
  let capabilityJournal = settled.capability_continuation_plan_id === unfinished?.plan_id;
  if (!capabilityJournal && !settled.durable_hold && unfinished?.kind === "IN_PROGRESS"
    && (unfinished.reason === "BUDGET" || unfinished.reason === "INDEX_LAG")
    && resume.kind === "HOLD" && resume.code === "HOLD_REQUIRED_CAPABILITY_INCOMPLETE") {
    // Already-started journals execute under existing recovery rules. Reuse the fresh post-settle
    // comparison only to label their hand-off; never mint mutation authority or re-gate those writes.
    const plan = await deps.store.plans.get(unfinished.plan_id);
    const comparison = resume.partial.capability_completeness?.comparisons.find(c => c.requirement === "REQUIRED" && !c.satisfied
      && c.capability === plan?.operations[0]?.expected_values["Capability Key"]);
    capabilityJournal = !!plan && plan.binding_id === binding.binding_id && storedCapabilityProofMatches(runtime, plan, comparison);
  }
  const ledger_continuation = !settled.durable_hold && unfinished?.kind === "IN_PROGRESS"
    && (unfinished.reason === "BUDGET" || unfinished.reason === "INDEX_LAG")
      ? { protocol: "LEDGER_CONTINUATION/1" as const, plan_id: unfinished.plan_id, phase: unfinished.phase,
        reason: unfinished.reason, writes_done: unfinished.writes_done, writes_total: unfinished.writes_total,
        ...(capabilityJournal ? { purpose: "CAPABILITY_PROOF" as const } : {}) }
      : undefined;
  const report = (h?: AdoptionHold, notice?: string, inProgress = false) => {
    const state = resume.kind === "OK" ? resume.state : resume.partial;
    const extra = { ...(ledger_completed.length ? { ledger_completed } : {}), ...(h ? { durable_hold: h } : {}), ...(notice ? { adoption_notice: notice } : {}), ...(inProgress ? { adoption_in_progress: true, ...(ledger_continuation ? { ledger_continuation } : {}) } : {}) };
    return { resume: resume.kind === "OK" ? { ...resume, state: { ...state, ...extra } } as ResumeOutcome
      : { ...resume, partial: { ...state, ...extra } } as ResumeOutcome };
  };
  if (settled.durable_hold) return report(settled.durable_hold);
  if (settled.outcomes.some(o => o.kind !== "PERSISTED")) return report(undefined, undefined, true);
  if (resume.kind !== "OK") return report();
  const state = resume.state;
  const rows = [...(state.foreign_writes ?? []), ...(state.orphan_rows ?? []), ...(state.cursor_drift ? [state.cursor_drift] : [])];
  if (!rows.length) return report();
  if (!deadline.allows(8_000)) return report(undefined, undefined, true);
  // No business values: the stamp identifies this exact observed obstruction, across bindings of one member.
  const fingerprint = createHash("sha256").update(JSON.stringify([binding.runtime_generation, rows.map(r => [r.target_ref,
    "last_edited_observed" in r ? r.last_edited_observed : r.last_edited, "receipt_id" in r ? r.receipt_id : null,
    "fields" in r ? r.fields : r.governed_fields, r.observation_hash ?? null])])).digest("hex");
  const held = (await deps.store.events.list({ runtime_id: runtime.runtime_id, event_type: "AUTO_ADOPTION_HELD" }))
    .find(e => e.principal_id === binding.principal_id && e.detail?.["fingerprint"] === fingerprint);
  if (held) return report({ code: held.result as CommitHoldCode, evidence: ["this observed adoption was already held"], safe_action: "restore or verify the competent authority before adopting this change", repeated: true });
  const stop = async (code: CommitHoldCode, evidence: readonly string[], safe_action: string, plan_id?: string, intrinsic = false) => {
    if (intrinsic) await deps.store.events.append({ event_type: "AUTO_ADOPTION_HELD", result: code, principal_id: binding.principal_id,
      binding_id: binding.binding_id, runtime_id: runtime.runtime_id, ...(plan_id ? { plan_id } : {}), detail: { fingerprint }, created_at: clock() });
    if (plan_id && intrinsic) await deps.store.events.append({ event_type: "AUTO_WORK_HELD", result: code, principal_id: binding.principal_id,
      binding_id: binding.binding_id, runtime_id: runtime.runtime_id, plan_id, detail: { evidence: ["automatic local adoption was held"] }, created_at: clock() });
    return report({ code, evidence, safe_action, repeated: false, ...(plan_id ? { plan_id } : {}) });
  };
  const intent: Intent = { action_class: "RECONCILE", summary: "adopt bounded local observations as they stand", mutations: rows.map(r => ({
    logical_resource_key: r.logical_resource_key, operation: "UPDATE", record_selector: { existing_object_id: r.target_ref }, desired_changes: {},
  })) };
  const guard = binding.lane === "SALES" ? await openGuard(deps, binding, runtime, clock()) : undefined;
  if (guard?.kind === "HOLD") return stop(guard.code, ["automatic adoption has no current guard authorization"], guard.safe_action);
  if (guard) {
    const checked = await checkMutations(deps.notion, runtime, binding, guard, intent.mutations);
    if (checked.kind === "HOLD") return stop(checked.code, ["automatic adoption is outside the currently approved operation classes"], checked.safe_action);
  }
  const prepared = await prepare(deps, binding, runtime, intent, clock(), { automaticAdoption: resume });
  if (prepared.kind === "HOLD") {
    if (prepared.code === "HOLD_VERSION_CHANGED" || prepared.code === "HOLD_RUNTIME_BUSY") return report(undefined, undefined, true);
    const intrinsic = ["HOLD_CONFLICT", "HOLD_SCHEMA_MISMATCH", "HOLD_UNSUPPORTED_OPERATION"].includes(prepared.code);
    return stop(prepared.code, prepared.evidence, prepared.safe_action, undefined, intrinsic);
  }
  const out = await executeTransaction(deps, { ...ctx, plan_id: prepared.plan.plan_id, cursor_ref: prepared.plan.state_last_write.target_ref,
    ...(guard ? { guardCheck: () => guardStillApproved(deps, runtime, guard, clock()) } : {}) });
  if (out.kind === "HELD") return stop(out.code, out.evidence, out.safe_action, prepared.plan.plan_id);
  // Re-read after real mutation; never serve the earlier observation as the post-write state.
  resume = await rehydrate(deps.notion, binding, runtime, deps.store, clock(), undefined, true);
  return report(undefined, out.kind === "PERSISTED" && state.cursor_drift?.moved ? CURSOR_ADOPTION_NOTICE : undefined, out.kind !== "PERSISTED");
}
