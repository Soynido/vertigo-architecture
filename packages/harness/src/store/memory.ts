import type { BindingRecord, BindingStore } from "../binding/store.ts";
import type { BindingState, Lane } from "../tools/envelope.ts";
import type { ClaimStore, Plan, PlanState, PlanStore, PlanWriteRow, PlanWriteStore } from "../plans/store.ts";
import { applyWriteTransition, isTerminal } from "../plans/store.ts";
import { leaseKeyString, type Lease, type LeaseKey, type LeaseOutcome, type LeaseStore } from "../plans/lease.ts";
import type { ReceiptRecord, ReceiptStore } from "../verify/engine.ts";
import { createMemoryGuardApprovals, type GuardApprovalStore } from "./guardApprovals.ts";

export interface TransactionEvent {
  readonly event_type: string;
  readonly result: string;
  readonly principal_id?: string;
  readonly binding_id?: string;
  readonly plan_id?: string;
  readonly receipt_id?: string;
  readonly runtime_id?: string;
  readonly detail?: Readonly<Record<string, unknown>>;
  readonly created_at: Date;
}

export interface EventReadFilter {
  plan_id?: string; binding_id?: string; runtime_id?: string; event_type?: string;
  /** Internal bounded read; existing audit callers retain ascending, unlimited reads. */
  limit?: number; newest_first?: boolean;
}
export function eventReadLimit(filter?: EventReadFilter): number | undefined {
  const limit = filter?.limit;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) throw new Error("event read limit must be an integer from 1 to 100");
  return limit;
}
export interface EventLog {
  append(event: TransactionEvent): Promise<void>;
  /** Audit read (diagnostics/tests). */
  list(filter?: EventReadFilter): Promise<readonly TransactionEvent[]>;
}

/**
 * Everything that must become durable together when FINAL wins.  Keeping this operation on the aggregate store
 * (rather than composing ReceiptStore/PlanStore/LeaseStore calls in the service) gives PostgreSQL one transaction
 * boundary and gives the in-memory implementation one synchronous critical section.
 */
export interface FinalizePlanInput {
  readonly plan: Plan;
  readonly target_receipt: ReceiptRecord;
  readonly final_receipt: ReceiptRecord;
  readonly now: Date;
  /**
   * Recovery-only durable commit marker. The caller may set it only after freshly reading the SALES registry and
   * proving that INSTALL_PENDING -> KNOWN already committed with this exact promotion plan id.
   */
  readonly committed_install_proof_plan_id?: string;
}

export interface BackendStore {
  readonly bindings: BindingStore;
  readonly plans: PlanStore;
  readonly leases: LeaseStore;
  readonly receipts: ReceiptStore;
  readonly events: EventLog;
  /** One executor per plan (PV-WRITE-001). */
  readonly claims: ClaimStore;
  /** Journal of the server's own Notion writes (PV-WRITE-001). */
  readonly planWrites: PlanWriteStore;
  /** Operator approvals of Sales Production Guard Indexes (W3.1). Absent ⇒ no approval exists, so no production. */
  readonly guardApprovals?: GuardApprovalStore;
  /** Idempotently consumes TARGET, stores one FINAL, terminals the plan, releases its lease and audits all four. */
  finalizePlan(input: FinalizePlanInput): Promise<ReceiptRecord>;
}

/** In-memory store for fixtures/dev. Not durable. */
export function createMemoryStore(): BackendStore {
  const bindings = new Map<string, BindingRecord>();
  const plans = new Map<string, Plan>();
  const leases = new Map<string, Lease>();
  const receipts = new Map<string, ReceiptRecord>();
  const events: TransactionEvent[] = [];
  const claims = new Map<string, { token: string; until: Date }>();
  const journal = new Map<string, Map<string, PlanWriteRow>>();
  const liveClaim = (planId: string, token: string, now: Date): boolean => { const c = claims.get(planId); return c !== undefined && c.token === token && c.until > now; };

  const appendOnce = (event: TransactionEvent): void => {
    const terminal = event.event_type === "PLAN_FINAL_VERIFIED" || event.event_type === "FINAL_RECEIPT_ISSUED" || event.event_type === "LEASE_RELEASED";
    const duplicate = terminal && events.some((seen) =>
      seen.event_type === event.event_type && seen.result === event.result
      && seen.plan_id === event.plan_id && seen.receipt_id === event.receipt_id);
    if (!duplicate) events.push(event);
  };

  const store: BackendStore = {
    guardApprovals: createMemoryGuardApprovals(),
    bindings: {
      async insert(r) { bindings.set(r.binding_id, r); },
      async findByHandleHash(h) { return [...bindings.values()].find((b) => b.handle_hash === h); },
      async setStatus(id, status: BindingState) { const b = bindings.get(id); if (b) bindings.set(id, { ...b, status }); },
      async touch(id, at) { const b = bindings.get(id); if (b) bindings.set(id, { ...b, last_seen_at: at }); },
    },
    plans: {
      async insert(p) { plans.set(p.plan_id, p); },
      async get(id) { return plans.get(id); },
      async setState(id, state: PlanState) { const p = plans.get(id); if (p) plans.set(id, { ...p, plan_state: state }); },
      async findActive(project: string, lane: Lane, gen: string) {
        return [...plans.values()].filter((p) => p.project === project && p.lane === lane && p.runtime_generation === gen && !isTerminal(p.plan_state));
      },
      async listByRuntime(project: string, lane: Lane, gen: string) {
        return [...plans.values()].filter((p) => p.project === project && p.lane === lane && p.runtime_generation === gen).sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
      },
      // No `await` between the checks and the writes: one synchronous critical section.
      async renew(planId, claimToken, now, until) {
        const p = plans.get(planId);
        if (!p || isTerminal(p.plan_state) || !liveClaim(planId, claimToken, now)) return false;
        const k = leaseKeyString(p);
        const lease = leases.get(k);
        if (!lease || lease.plan_id !== planId) return false;
        plans.set(planId, { ...p, expires_at: until });
        leases.set(k, { ...lease, expires_at: until });
        return true;
      },
    },
    claims: {
      async claim(planId, token, now, until) {
        const c = claims.get(planId);
        if (c && c.until > now && c.token !== token) return false;
        claims.set(planId, { token, until });
        return true;
      },
      async release(planId, token) { if (claims.get(planId)?.token === token) claims.delete(planId); },
    },
    planWrites: {
      async list(planId) { return [...(journal.get(planId)?.values() ?? [])].sort((a, b) => a.ordinal - b.ordinal); },
      async ensure(planId, seeds) {
        const rows = journal.get(planId) ?? new Map<string, PlanWriteRow>();
        for (const s of seeds) if (!rows.has(s.symbol)) rows.set(s.symbol, { ...s, plan_id: planId, status: "PENDING", attempts: 0 });
        journal.set(planId, rows);
        return [...rows.values()].sort((a, b) => a.ordinal - b.ordinal);
      },
      async transition(planId, symbol, from, to, patch) {
        const row = journal.get(planId)?.get(symbol);
        if (!row) throw new Error(`plan write ${planId}/${symbol} is not journaled`);
        const next = applyWriteTransition(row, from, to, patch);
        if (next) journal.get(planId)?.set(symbol, next);
        return next;
      },
    },
    leases: {
      async acquire(key: LeaseKey, planId, now, expiresAt): Promise<LeaseOutcome> {
        const k = leaseKeyString(key);
        const holder = leases.get(k);
        if (holder && holder.expires_at > now && holder.plan_id !== planId) return { acquired: false, holder };
        const lease: Lease = { ...key, plan_id: planId, acquired_at: now, expires_at: expiresAt };
        leases.set(k, lease);
        return { acquired: true, lease };
      },
      async release(key, planId) { const k = leaseKeyString(key); if (leases.get(k)?.plan_id === planId) leases.delete(k); },
      async current(key, now) { const l = leases.get(leaseKeyString(key)); return l && l.expires_at > now ? l : undefined; },
    },
    receipts: {
      async insert(r) { receipts.set(r.receipt_id, r); },
      // No `await` separates the lookup from the write: on one event loop this is an atomic check-and-set.
      async insertIfAbsent(r) {
        const live = [...receipts.values()].find((x) => x.plan_id === r.plan_id && x.type === r.type && x.status === "VALID");
        if (live) return live;
        receipts.set(r.receipt_id, r);
        return r;
      },
      async get(id) { return receipts.get(id); },
      async setStatus(id, status) { const r = receipts.get(id); if (r) receipts.set(id, { ...r, status }); },
      async findByPlan(planId, type) { return [...receipts.values()].filter((r) => r.plan_id === planId && (!type || r.type === type)); },
      async findByRuntime(runtimeId, type) { return [...receipts.values()].filter((r) => r.runtime_id === runtimeId && (!type || r.type === type)).sort((a, b) => a.observed_at.getTime() - b.observed_at.getTime()); },
      async findFinalByFields(scope, fields) {
        if (fields.length > 16384) throw new Error("terminal proof scope exceeds bounded field lookup");
        const wanted = new Map(fields.map(f => [JSON.stringify([f.page_ref, f.field]), f]));
        const out = new Map<string, { page_ref: string; field: string; receipt: ReceiptRecord }>();
        for (const receipt of receipts.values()) {
          const plan = plans.get(receipt.plan_id);
          if (receipt.type !== "FINAL" || receipt.status !== "VALID" || !plan || plan.plan_state !== "FINAL_VERIFIED"
            || Object.entries(scope).some(([k, v]) => plan[k as keyof Plan] !== v)) continue;
          for (const op of plan.operations) {
            const row = journal.get(plan.plan_id)?.get(`TARGET_${op.ordinal}`);
            const page = (op.physical_target_ref ?? row?.created_id)?.replaceAll("-", "");
            if (!page) continue;
            for (const field of op.compared_fields) {
              const key = JSON.stringify([page, field]); const f = wanted.get(key); const prior = out.get(key);
              if (f && (!prior || receipt.observed_at > prior.receipt.observed_at
                || receipt.observed_at.getTime() === prior.receipt.observed_at.getTime() && receipt.receipt_id > prior.receipt.receipt_id))
                out.set(key, { ...f, receipt });
            }
          }
        }
        return [...out.values()];
      },
    },
    events: {
      async append(e) { appendOnce(e); },
      async list(filter) {
        const limit = eventReadLimit(filter);
        const found = events.filter((e) => (!filter?.plan_id || e.plan_id === filter.plan_id) && (!filter?.binding_id || e.binding_id === filter.binding_id) && (!filter?.runtime_id || e.runtime_id === filter.runtime_id) && (!filter?.event_type || e.event_type === filter.event_type));
        if (filter?.newest_first) found.reverse();
        return limit === undefined ? found : found.slice(0, limit);
      },
    },
    async finalizePlan({ plan, target_receipt, final_receipt, now, committed_install_proof_plan_id }) {
      const currentPlan = plans.get(plan.plan_id);
      if (!currentPlan) throw new Error(`plan ${plan.plan_id} does not exist`);
      const committedRecovery = currentPlan.plan_kind === "INSTALL_PROMOTION"
        && committed_install_proof_plan_id === currentPlan.plan_id;
      let final = [...receipts.values()].find((r) => r.plan_id === currentPlan.plan_id && r.type === "FINAL" && r.status === "VALID");
      if (!final && !["TARGET_VERIFIED", "AWAITING_FINAL_VERIFY", "FINAL_VERIFIED"].includes(currentPlan.plan_state) && !(committedRecovery && (currentPlan.plan_state === "EXPIRED" || currentPlan.plan_state === "SUPERSEDED"))) throw new Error(`plan ${plan.plan_id} cannot finalize from ${currentPlan.plan_state}`);

      const target = receipts.get(target_receipt.receipt_id);
      if (!target || target.type !== "TARGET" || target.plan_id !== currentPlan.plan_id) {
        throw new Error(`target receipt ${target_receipt.receipt_id} does not belong to plan ${currentPlan.plan_id}`);
      }
      if (target.principal_id !== currentPlan.principal_id || target.runtime_generation !== currentPlan.runtime_generation) {
        throw new Error(`target receipt ${target.receipt_id} has the wrong owner or runtime generation`);
      }

      if (!final) {
        // CONSUMED with no FINAL is a recoverable footprint left by the historical non-atomic implementation.
        if (target.status !== "VALID" && target.status !== "CONSUMED" && !(committedRecovery && target.status === "EXPIRED")) throw new Error(`target receipt ${target.receipt_id} is ${target.status}`);
        final = final_receipt;
        receipts.set(final.receipt_id, final);
      } else if (final.target_receipt_id !== target.receipt_id) {
        throw new Error(`FINAL receipt ${final.receipt_id} references another TARGET receipt`);
      }

      receipts.set(target.receipt_id, { ...target, status: "CONSUMED" });
      plans.set(currentPlan.plan_id, { ...currentPlan, plan_state: "FINAL_VERIFIED" });
      const leaseKey = leaseKeyString(currentPlan);
      if (leases.get(leaseKey)?.plan_id === currentPlan.plan_id) leases.delete(leaseKey);

      appendOnce({ event_type: "PLAN_FINAL_VERIFIED", result: "FINAL_VERIFIED", principal_id: currentPlan.principal_id, binding_id: currentPlan.binding_id, plan_id: currentPlan.plan_id, receipt_id: final.receipt_id, runtime_id: currentPlan.runtime_id, detail: { from: currentPlan.plan_state, target_receipt_id: target.receipt_id }, created_at: now });
      appendOnce({ event_type: "FINAL_RECEIPT_ISSUED", result: "TRANSACTION_VERIFIED", principal_id: currentPlan.principal_id, binding_id: currentPlan.binding_id, plan_id: currentPlan.plan_id, receipt_id: final.receipt_id, runtime_id: currentPlan.runtime_id, created_at: now });
      appendOnce({ event_type: "LEASE_RELEASED", result: "FINAL_VERIFIED", principal_id: currentPlan.principal_id, binding_id: currentPlan.binding_id, plan_id: currentPlan.plan_id, receipt_id: final.receipt_id, runtime_id: currentPlan.runtime_id, created_at: now });
      return final;
    },
  };
  return store;
}
