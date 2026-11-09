import { readFile } from "node:fs/promises";
import pg from "pg";
import type { Acquire, ExecutionLedger, LedgerRow, LedgerState } from "../types.ts";

/** Cross-process ledger: the atomic INSERT ... ON CONFLICT ... WHERE makes at most one attempt hold an action_key. */
export class PostgresExecutionLedger implements ExecutionLedger {
  readonly #pool: pg.Pool;
  constructor(pool: pg.Pool) { this.#pool = pool; }

  static async connect(databaseUrl: string): Promise<PostgresExecutionLedger> {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    await pool.query(await readFile(new URL("../../migrations/001_executor.sql", import.meta.url), "utf8"));
    return new PostgresExecutionLedger(pool);
  }
  async close(): Promise<void> { await this.#pool.end(); }

  async acquire(actionKey: string, attemptId: string, now: Date, leaseMs: number): Promise<Acquire> {
    const lease = new Date(now.getTime() + leaseMs);
    const r = await this.#pool.query<{ attempt_id: string }>(
      `INSERT INTO executor_actions (action_key, state, attempt_id, lease_until, evidence, updated_at)
       VALUES ($1, 'CHECKING', $2, $3, '[]'::jsonb, $4)
       ON CONFLICT (action_key) DO UPDATE SET state = 'CHECKING', attempt_id = EXCLUDED.attempt_id, lease_until = EXCLUDED.lease_until, evidence = '[]'::jsonb, updated_at = EXCLUDED.updated_at
       WHERE executor_actions.state IN ('REFUSED', 'FAILED') OR (executor_actions.state = 'CHECKING' AND executor_actions.lease_until < $4)
       RETURNING attempt_id`,
      [actionKey, attemptId, lease, now],
    );
    if (r.rows[0]?.attempt_id === attemptId) return { kind: "ACQUIRED" };
    const row = await this.get(actionKey);
    if (!row) throw new Error(`ledger: ${actionKey} vanished during acquire`);
    return { kind: "HELD", row };
  }

  async update(actionKey: string, attemptId: string, patch: { state: LedgerState; message_id?: string; thread_id?: string; observed_at?: Date; evidence?: readonly string[] }, now: Date): Promise<void> {
    const r = await this.#pool.query(
      `UPDATE executor_actions SET state = $3, message_id = COALESCE($4, message_id), thread_id = COALESCE($5, thread_id), observed_at = COALESCE($6, observed_at), evidence = COALESCE($7::jsonb, evidence), updated_at = $8
       WHERE action_key = $1 AND attempt_id = $2`,
      [actionKey, attemptId, patch.state, patch.message_id ?? null, patch.thread_id ?? null, patch.observed_at ?? null, patch.evidence ? JSON.stringify(patch.evidence) : null, now],
    );
    if (r.rowCount !== 1) throw new Error(`ledger: attempt ${attemptId} does not hold ${actionKey}`);
  }

  async get(actionKey: string): Promise<LedgerRow | undefined> {
    const r = await this.#pool.query<{ action_key: string; state: LedgerState; attempt_id: string; lease_until: Date; message_id: string | null; thread_id: string | null; observed_at: Date | null; evidence: string[]; updated_at: Date }>(`SELECT * FROM executor_actions WHERE action_key = $1`, [actionKey]);
    const row = r.rows[0];
    if (!row) return undefined;
    return { action_key: row.action_key, state: row.state, attempt_id: row.attempt_id, lease_until: row.lease_until, ...(row.message_id ? { message_id: row.message_id } : {}), ...(row.thread_id ? { thread_id: row.thread_id } : {}), ...(row.observed_at ? { observed_at: row.observed_at } : {}), evidence: row.evidence, updated_at: row.updated_at };
  }
}
