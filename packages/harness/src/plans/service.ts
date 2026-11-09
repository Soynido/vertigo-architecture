/**
 * Plan service (PV0-009): durable backend mechanics for active transactions.
 * Backend-side only: plans, operations, receipts, leases and audit events. Never VERTIGO business canon.
 *  - plan ids and receipt ids are opaque and non-guessable (24 random bytes, base64url);
 *  - TTLs are server configuration: plan 15 min, target receipt 10 min (config-owned, never caller-owned);
 *  - one active (non-terminal) mutating plan per project + lane + runtime_generation (lease);
 *  - every transition is audited; expiry records a recovery flag because effects may have happened.
 */
import { randomBytes } from "node:crypto";
import type { BindingRecord } from "../binding/store.ts";
import type { HarnessConfig } from "../config/index.ts";
import type { BackendStore } from "../store/memory.ts";
import type { Lane } from "../tools/envelope.ts";
import type { ReceiptRecord } from "../verify/engine.ts";
import type { Lease, LeaseKey } from "./lease.ts";
import { canTransition, isTerminal, type Plan, type PlanKind, type PlanOperation, type PlanState, type RunMode, type WriteInstruction } from "./store.ts";

export function opaqueId(): string {
  return randomBytes(24).toString("base64url");
}

export interface PlanDraft {
  readonly plan_kind?: PlanKind;
  readonly principal_id: string;
  readonly binding: BindingRecord;
  readonly governing: { readonly spec: string; readonly schema: string; readonly control: string };
  readonly run_mode: RunMode;
  readonly run_ref?: string;
  readonly execution_attempt_id: string;
  readonly baseline_runtime_revision: string;
  readonly operations: readonly PlanOperation[];
  readonly stage1_writes: readonly WriteInstruction[];
  readonly finalization_writes: readonly WriteInstruction[];
  readonly state_last_write: WriteInstruction;
  /** Backend-generated id (opaqueId) when the writes already embed it; never caller-supplied. */
  readonly plan_id?: string;
  readonly recovers_plan_id?: string;
  /** INSTALL_PROMOTION only: the exact mapping proof this promotion is bound to. */
  readonly install_mapping_plan_id?: string;
  readonly install_mapping_final_receipt_id?: string;
  /** INSTALL-only snapshot of governing pins and backend assignment identity. */
  readonly install_context_fingerprint?: string;
  /** PV-WRITE-001: why the backend holds this plan (default INTENT) and the plan that spawned it. */
  readonly plan_origin?: import("./store.ts").PlanOrigin;
  readonly parent_plan_id?: string;
}

export type CreatePlanOutcome =
  | { readonly kind: "CREATED"; readonly plan: Plan }
  | { readonly kind: "EXISTING"; readonly plan: Plan }
  | { readonly kind: "BUSY"; readonly holder_plan_id: string; readonly holder_expires_at: Date };

export function leaseKeyOf(p: { project: string; lane: Lane; runtime_generation: string }): LeaseKey {
  return { project: p.project, lane: p.lane, runtime_generation: p.runtime_generation };
}

/**
 * Read-only description of the backend plan in flight on a runtime generation (PV0-020E observability).
 * `os_resume` reports this instead of always claiming NONE: an interrupted or expired plan still holds the mutation
 * lease and may have left durable Notion writes (06 — RESUME, RECOVERY & CONCURRENCY: "expired backend plan where
 * writes may have occurred" is a recovery trigger). PURE: it never sweeps, transitions, releases or writes anything.
 * A plan owned by another principal is reported as busy WITHOUT disclosing its id or state — the same disclosure the
 * HOLD_RUNTIME_BUSY evidence already gives to anyone who may bind this runtime.
 */
export type ActivePlanReport =
  | "NONE"
  | {
      readonly plan_id: string;
      readonly plan_state: PlanState | "UNKNOWN";
      /** Backend-owned original lineage; disclosed only to this plan's principal. */
      readonly recovers_plan_id?: string;
      readonly owned_by_caller: boolean;
      readonly same_binding: boolean;
      readonly expired: boolean;
      readonly expires_at: string;
      readonly holds_mutation_lease: boolean;
      readonly recovery_possible: boolean;
      readonly next_safe_action: string;
    };

export function describeActivePlan(active: readonly Plan[], lease: Lease | undefined, caller: { principal_id: string; binding_id: string }, now: Date): ActivePlanReport {
  const plan = [...active].sort((a, b) => a.created_at.getTime() - b.created_at.getTime()).at(-1);
  if (!plan) return "NONE";
  const owned = plan.principal_id === caller.principal_id;
  const expired = plan.expires_at <= now;
  const holds_mutation_lease = lease !== undefined && lease.plan_id === plan.plan_id;
  const same_binding = owned && plan.binding_id === caller.binding_id;
  const written = plan.plan_state === "TARGET_VERIFIED" || plan.plan_state === "AWAITING_FINAL_VERIFY";
  const base = { owned_by_caller: owned, same_binding, expired, expires_at: plan.expires_at.toISOString(), holds_mutation_lease, recovery_possible: expired || written };
  if (!owned) {
    return { ...base, plan_id: "NOT_APPLICABLE", plan_state: "UNKNOWN", next_safe_action: "another principal holds this runtime's mutation lease; wait for it to reach a terminal state or expire, then prepare again" };
  }
  const next_safe_action = expired
    ? "this plan expired; its Notion writes may exist — re-prepare the same intent and the backend recovers it by observation, never by blind replay"
    : written
      ? "continue that plan through os_commit; the backend alone finalizes and verifies it"
      : same_binding
        ? "continue this stored plan through os_commit; no native Notion write actions are served"
        : "another conversation of yours holds this runtime's mutation lease; finish or let it expire before preparing again";
  return { ...base, plan_id: plan.plan_id, plan_state: plan.plan_state,
    ...(plan.recovers_plan_id ? { recovers_plan_id: plan.recovers_plan_id } : {}), next_safe_action };
}

/**
 * Same ordered idempotency keys ⇒ the same high-level intent. BUSINESS work is conversation-binding scoped.
 * INSTALL work is assignment scoped instead: a browser/chat restart may mint a fresh INSTALL_ONLY binding, but
 * it must recover the already durable plan for the same principal/runtime generation rather than create a second
 * canary or promotion.
 */
function equivalent(a: Plan, draft: PlanDraft): boolean {
  const kind = draft.plan_kind ?? "BUSINESS";
  if (a.plan_kind !== kind) return false;
  if (kind === "BUSINESS") {
    if (a.binding_id !== draft.binding.binding_id) return false;
  } else if (a.principal_id !== draft.principal_id
    || a.runtime_id !== draft.binding.runtime_id
    || a.runtime_generation !== draft.binding.runtime_generation) return false;
  if (kind === "INSTALL_PROMOTION"
    && (a.install_mapping_plan_id !== draft.install_mapping_plan_id
      || a.install_mapping_final_receipt_id !== draft.install_mapping_final_receipt_id)) return false;
  if (kind !== "BUSINESS" && a.install_context_fingerprint !== draft.install_context_fingerprint) return false;
  const ka = a.operations.map((o) => o.idempotency_key).join("|");
  const kb = draft.operations.map((o) => o.idempotency_key).join("|");
  return ka === kb;
}

/**
 * Keeps a claimed plan alive while its executor works (PV-WRITE-001, A.4): plan and runtime lease both move to
 * now + plan TTL, for the claim holder only. False when the plan is terminal, the claim is not this token's or
 * has lapsed, or the lease is no longer this plan's — the executor must then stop, never write on.
 */
export async function renew(store: BackendStore, config: HarnessConfig, planId: string, claimToken: string, now: Date): Promise<boolean> {
  return store.plans.renew(planId, claimToken, now, new Date(now.getTime() + config.planTtlMinutes * 60_000));
}

export async function createPlan(store: BackendStore, config: HarnessConfig, draft: PlanDraft, now: Date): Promise<CreatePlanOutcome> {
  const b = draft.binding;
  // Expire any due plans on this runtime first so a dead plan cannot hold the lease forever.
  for (const active of await store.plans.findActive(b.project, b.lane, b.runtime_generation)) await expireIfDue(store, active, now);
  const active = await store.plans.findActive(b.project, b.lane, b.runtime_generation);
  const same = active.find((p) => equivalent(p, draft));
  if (same) return { kind: "EXISTING", plan: same };
  const expires_at = new Date(now.getTime() + config.planTtlMinutes * 60_000);
  const plan_id = draft.plan_id ?? opaqueId();
  const lease = await store.leases.acquire(leaseKeyOf(b), plan_id, now, expires_at);
  if (!lease.acquired) {
    await store.events.append({ event_type: "PLAN_HOLD", result: "HOLD_RUNTIME_BUSY", principal_id: draft.principal_id, binding_id: b.binding_id, runtime_id: b.runtime_id, detail: { holder_plan_id: lease.holder.plan_id }, created_at: now });
    return { kind: "BUSY", holder_plan_id: lease.holder.plan_id, holder_expires_at: lease.holder.expires_at };
  }
  const plan: Plan = {
    plan_id,
    plan_kind: draft.plan_kind ?? "BUSINESS",
    principal_id: draft.principal_id,
    binding_id: b.binding_id,
    project: b.project,
    lane: b.lane,
    runtime_logical_key: b.runtime_logical_key,
    runtime_id: b.runtime_id,
    runtime_generation: b.runtime_generation,
    governing_spec_version: draft.governing.spec,
    governing_schema_version: draft.governing.schema,
    governing_control_version: draft.governing.control,
    run_mode: draft.run_mode,
    ...(draft.run_ref ? { run_ref: draft.run_ref } : {}),
    ...(draft.recovers_plan_id ? { recovers_plan_id: draft.recovers_plan_id } : {}),
    execution_attempt_id: draft.execution_attempt_id,
    created_at: now,
    expires_at,
    baseline_runtime_revision: draft.baseline_runtime_revision,
    operations: draft.operations,
    stage1_writes: draft.stage1_writes,
    finalization_writes: draft.finalization_writes,
    state_last_write: draft.state_last_write,
    ...(draft.install_mapping_plan_id ? { install_mapping_plan_id: draft.install_mapping_plan_id } : {}),
    ...(draft.install_mapping_final_receipt_id ? { install_mapping_final_receipt_id: draft.install_mapping_final_receipt_id } : {}),
    ...(draft.install_context_fingerprint ? { install_context_fingerprint: draft.install_context_fingerprint } : {}),
    ...(draft.plan_origin ? { plan_origin: draft.plan_origin } : {}),
    ...(draft.parent_plan_id ? { parent_plan_id: draft.parent_plan_id } : {}),
    plan_state: "AWAITING_STAGE1_WRITES",
  };
  try {
    await store.plans.insert(plan);
  } catch (error) {
    // The lease is acquired before the plan can be inserted. A durable insert
    // failure must not strand that lease; release is ownership-guarded by
    // plan_id in every store implementation, so a successor is never removed.
    await store.leases.release(leaseKeyOf(b), plan_id);
    throw error;
  }
  await store.events.append({ event_type: "PLAN_CREATED", result: "AWAITING_STAGE1_WRITES", principal_id: plan.principal_id, binding_id: plan.binding_id, plan_id, runtime_id: plan.runtime_id, detail: { lease: "ACQUIRED", expires_at: expires_at.toISOString() }, created_at: now });
  return { kind: "CREATED", plan };
}

export type TransitionOutcome = { readonly ok: true; readonly plan: Plan } | { readonly ok: false; readonly reason: "INVALID_TRANSITION" | "PLAN_NOT_FOUND"; readonly from?: PlanState };

export async function transition(store: BackendStore, planId: string, to: PlanState, now: Date, detail: Record<string, unknown> = {}): Promise<TransitionOutcome> {
  const plan = await store.plans.get(planId);
  if (!plan) return { ok: false, reason: "PLAN_NOT_FOUND" };
  if (!canTransition(plan.plan_state, to)) return { ok: false, reason: "INVALID_TRANSITION", from: plan.plan_state };
  await store.plans.setState(planId, to);
  await store.events.append({ event_type: `PLAN_${to}`, result: to, principal_id: plan.principal_id, binding_id: plan.binding_id, plan_id: planId, runtime_id: plan.runtime_id, detail: { from: plan.plan_state, ...detail }, created_at: now });
  if (isTerminal(to)) {
    await store.leases.release(leaseKeyOf(plan), planId);
    await store.events.append({ event_type: "LEASE_RELEASED", result: to, principal_id: plan.principal_id, binding_id: plan.binding_id, plan_id: planId, runtime_id: plan.runtime_id, created_at: now });
  }
  return { ok: true, plan: { ...plan, plan_state: to } };
}

/** Expiry never implies effect absence: an expired non-terminal plan is flagged recovery_possible. */
export async function expireIfDue(store: BackendStore, plan: Plan, now: Date): Promise<boolean> {
  if (isTerminal(plan.plan_state) || plan.expires_at > now) return false;
  await transition(store, plan.plan_id, "EXPIRED", now, { recovery_possible: true, reason: "plan TTL exceeded; Notion effects may exist and must be observed before any replay" });
  return true;
}

export type ReceiptCheck =
  | { readonly ok: true; readonly receipt: ReceiptRecord }
  | { readonly ok: false; readonly reason: "NOT_FOUND" | "WRONG_PLAN" | "WRONG_PRINCIPAL" | "WRONG_RUNTIME" | "EXPIRED" | "CONSUMED" | "INVALID" };

/** Repair the durable bookkeeping if receipt insertion won but the process died before the plan/event writes. */
async function convergeTargetIssuance(store: BackendStore, plan: Plan, receipt: ReceiptRecord, now: Date, recovered: boolean): Promise<void> {
  const fresh = await store.plans.get(plan.plan_id);
  if (fresh?.plan_state === "AWAITING_STAGE1_WRITES") {
    await transition(store, plan.plan_id, "TARGET_VERIFIED", now, { target_receipt_id: receipt.receipt_id, ...(recovered ? { recovered_after_receipt_insert: true } : {}) });
  }
  const events = await store.events.list({ plan_id: plan.plan_id });
  if (!events.some((e) => e.event_type === "TARGET_RECEIPT_ISSUED" && e.receipt_id === receipt.receipt_id)) {
    await store.events.append({ event_type: "TARGET_RECEIPT_ISSUED", result: "VALID", principal_id: plan.principal_id, binding_id: plan.binding_id, plan_id: plan.plan_id, receipt_id: receipt.receipt_id, runtime_id: plan.runtime_id, ...(recovered ? { detail: { recovered_after_receipt_insert: true } } : {}), created_at: now });
  }
}

/** Issue (or re-issue idempotently) the TARGET receipt for a plan whose targets were just verified. */
export async function issueTargetReceipt(store: BackendStore, config: HarnessConfig, plan: Plan, observations: Readonly<Record<string, unknown>>, now: Date): Promise<ReceiptRecord> {
  const existing = await store.receipts.findByPlan(plan.plan_id, "TARGET");
  const live = existing.find((r) => r.status === "VALID" && (!r.expires_at || r.expires_at > now));
  if (live) {
    await convergeTargetIssuance(store, plan, live, now, true);
    return live;
  }
  // Retire a receipt that is still flagged VALID but whose TTL has run out, so it can neither be re-used nor
  // block the uniqueness guard below from admitting the fresh one.
  for (const r of existing) if (r.status === "VALID" && r.expires_at && r.expires_at <= now) await store.receipts.setStatus(r.receipt_id, "EXPIRED");
  const receipt: ReceiptRecord = {
    receipt_id: opaqueId(),
    type: "TARGET",
    plan_id: plan.plan_id,
    principal_id: plan.principal_id,
    runtime_id: plan.runtime_id,
    runtime_generation: plan.runtime_generation,
    ...(plan.run_ref ? { run_ref: plan.run_ref } : {}),
    observed_at: now,
    observations,
    expires_at: new Date(now.getTime() + config.targetReceiptTtlMinutes * 60_000),
    status: "VALID",
  };
  const stored = await store.receipts.insertIfAbsent(receipt);
  // Winner and losers run the same convergence: an incumbent may have been inserted by a process that crashed
  // before transitioning the plan.
  await convergeTargetIssuance(store, plan, stored, now, stored.receipt_id !== receipt.receipt_id);
  return stored;
}

export async function checkTargetReceipt(store: BackendStore, plan: Plan, receiptId: string, now: Date): Promise<ReceiptCheck> {
  const r = await store.receipts.get(receiptId);
  if (!r || r.type !== "TARGET") return { ok: false, reason: "NOT_FOUND" };
  if (r.plan_id !== plan.plan_id) { await store.events.append({ event_type: "RECEIPT_REPLAY_REJECTED", result: "WRONG_PLAN", principal_id: plan.principal_id, plan_id: plan.plan_id, receipt_id: receiptId, runtime_id: plan.runtime_id, created_at: now }); return { ok: false, reason: "WRONG_PLAN" }; }
  if (r.principal_id !== plan.principal_id) return { ok: false, reason: "WRONG_PRINCIPAL" };
  if (r.runtime_generation !== plan.runtime_generation) return { ok: false, reason: "WRONG_RUNTIME" };
  if (r.status === "CONSUMED") { await store.events.append({ event_type: "RECEIPT_REPLAY_REJECTED", result: "CONSUMED", principal_id: plan.principal_id, plan_id: plan.plan_id, receipt_id: receiptId, runtime_id: plan.runtime_id, created_at: now }); return { ok: false, reason: "CONSUMED" }; }
  if (r.status !== "VALID") return { ok: false, reason: "INVALID" };
  if (r.expires_at && r.expires_at <= now) { await store.receipts.setStatus(receiptId, "EXPIRED"); return { ok: false, reason: "EXPIRED" }; }
  return { ok: true, receipt: r };
}

/** FINAL: consumes the target receipt, records a backend-only FINAL receipt, marks the plan terminal. */
export async function issueFinalReceipt(
  store: BackendStore,
  plan: Plan,
  targetReceipt: ReceiptRecord,
  observations: Readonly<Record<string, unknown>>,
  now: Date,
  options: { readonly committed_install_proof_plan_id?: string } = {},
): Promise<ReceiptRecord> {
  const receipt: ReceiptRecord = {
    receipt_id: opaqueId(),
    type: "FINAL",
    plan_id: plan.plan_id,
    principal_id: plan.principal_id,
    runtime_id: plan.runtime_id,
    runtime_generation: plan.runtime_generation,
    ...(plan.run_ref ? { run_ref: plan.run_ref } : {}),
    target_receipt_id: targetReceipt.receipt_id,
    observed_at: now,
    observations,
    status: "VALID",
  };
  return store.finalizePlan({ plan, target_receipt: targetReceipt, final_receipt: receipt, now, ...options });
}
