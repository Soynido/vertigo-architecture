import type { Acquire, ExecutionLedger, LedgerRow, LedgerState } from "../types.ts";

const ACQUIRABLE: ReadonlySet<LedgerState> = new Set(["REFUSED", "FAILED"]);

/** In-process ledger. `acquire` has no await between read and write, so concurrent attempts in one process serialize. */
export class MemoryExecutionLedger implements ExecutionLedger {
  readonly #rows = new Map<string, LedgerRow>();
  async acquire(actionKey: string, attemptId: string, now: Date, leaseMs: number): Promise<Acquire> {
    const row = this.#rows.get(actionKey);
    const free = !row || ACQUIRABLE.has(row.state) || (row.state === "CHECKING" && row.lease_until.getTime() < now.getTime());
    if (!free) return { kind: "HELD", row: row as LedgerRow };
    this.#rows.set(actionKey, { action_key: actionKey, state: "CHECKING", attempt_id: attemptId, lease_until: new Date(now.getTime() + leaseMs), evidence: [], updated_at: now });
    return { kind: "ACQUIRED" };
  }
  async update(actionKey: string, attemptId: string, patch: { state: LedgerState; message_id?: string; thread_id?: string; observed_at?: Date; evidence?: readonly string[] }, now: Date): Promise<void> {
    const row = this.#rows.get(actionKey);
    if (!row || row.attempt_id !== attemptId) throw new Error(`ledger: attempt ${attemptId} does not hold ${actionKey}`);
    this.#rows.set(actionKey, { ...row, ...(patch.message_id ? { message_id: patch.message_id } : {}), ...(patch.thread_id ? { thread_id: patch.thread_id } : {}), ...(patch.observed_at ? { observed_at: patch.observed_at } : {}), state: patch.state, evidence: patch.evidence ?? row.evidence, updated_at: now });
  }
  async get(actionKey: string): Promise<LedgerRow | undefined> { return this.#rows.get(actionKey); }
}
