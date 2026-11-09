import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import type { BindingRecord, BindingStore } from "../binding/store.ts";
import type { BindingState, Lane } from "../tools/envelope.ts";
import type { ClaimStore, Plan, PlanOperation, PlanState, PlanStore, PlanWriteRow, PlanWriteStore } from "../plans/store.ts";
import { applyWriteTransition, isTerminal } from "../plans/store.ts";
import type { Lease, LeaseKey, LeaseOutcome, LeaseStore } from "../plans/lease.ts";
import type { ReceiptRecord, ReceiptStore, VerifyPhase } from "../verify/engine.ts";
import type { BackendStore, EventLog, TransactionEvent } from "./memory.ts";
import { eventReadLimit } from "./memory.ts";
import type { GuardApproval, GuardApprovalStore } from "./guardApprovals.ts";

/**
 * PostgreSQL-backed transaction store (migrations/001_init.sql). Holds ACTIVE TRANSACTION MECHANICS ONLY
 * (bindings, plans, operations, receipts, leases, audit events); never VERTIGO business or runtime canon.
 * Lease acquisition is atomic (single INSERT ... ON CONFLICT guarded by expiry/terminal state).
 */
export class PostgresBackend {
  readonly pool: pg.Pool;
  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl });
  }
  async ping(): Promise<boolean> {
    const r = await this.pool.query("select 1 as ok");
    return r.rows[0]?.ok === 1;
  }
  /** Applies the SQL migration text (idempotent statements). */
  async migrate(sql: string): Promise<void> {
    await this.pool.query(sql);
  }
  /** Applies every `NNN_*.sql` file of a migrations directory, in name order. Each file is idempotent. */
  async migrateAll(dir: URL): Promise<readonly string[]> {
    const files = (await readdir(dir)).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
    for (const f of files) await this.migrate(await readFile(new URL(f, dir), "utf8"));
    return files;
  }
  store(): BackendStore {
    const pool = this.pool;
    const NON_TERMINAL = ["AWAITING_STAGE1_WRITES", "TARGET_VERIFIED", "AWAITING_FINAL_VERIFY", "HOLD"];

    const bindings: BindingStore = {
      async insert(r: BindingRecord) {
        await pool.query(
          `insert into bindings (binding_id, handle_hash, principal_id, project, lane, runtime_logical_key, runtime_id, runtime_generation, binding_mode, install_phase, resolved_manifest_ref, governing_versions_snapshot, status, created_at, expires_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [r.binding_id, r.handle_hash, r.principal_id, r.project, r.lane, r.runtime_logical_key, r.runtime_id, r.runtime_generation, r.binding_mode, r.install_phase, r.resolved_manifest_ref, JSON.stringify(r.governing_versions_snapshot), r.status, r.created_at, r.expires_at],
        );
      },
      async findByHandleHash(h) {
        const q = await pool.query("select * from bindings where handle_hash = $1", [h]);
        return q.rows[0] ? rowToBinding(q.rows[0]) : undefined;
      },
      async setStatus(id, status: BindingState) { await pool.query("update bindings set status = $2 where binding_id = $1", [id, status]); },
      async touch(id, at) { await pool.query("update bindings set last_seen_at = $2 where binding_id = $1", [id, at]); },
    };

    const plans: PlanStore = {
      async insert(p: Plan) {
        const client = await pool.connect();
        try {
          await client.query("begin");
          await client.query(
            `insert into plans (plan_id, plan_kind, principal_id, binding_id, project, lane, runtime_logical_key, runtime_id, runtime_generation, governing_spec_version, governing_schema_version, governing_control_version, run_mode, run_ref, execution_attempt_id, baseline_runtime_revision, stage1_writes, finalization_writes, state_last_write, plan_state, created_at, expires_at, recovers_plan_id, install_mapping_plan_id, install_mapping_final_receipt_id, install_context_fingerprint, plan_origin, parent_plan_id)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)`,
            [p.plan_id, p.plan_kind, p.principal_id, p.binding_id, p.project, p.lane, p.runtime_logical_key, p.runtime_id, p.runtime_generation, p.governing_spec_version, p.governing_schema_version, p.governing_control_version, p.run_mode, p.run_ref ?? null, p.execution_attempt_id, p.baseline_runtime_revision, JSON.stringify(p.stage1_writes), JSON.stringify(p.finalization_writes), JSON.stringify(p.state_last_write), p.plan_state, p.created_at, p.expires_at, p.recovers_plan_id ?? null, p.install_mapping_plan_id ?? null, p.install_mapping_final_receipt_id ?? null, p.install_context_fingerprint ?? null, p.plan_origin ?? "INTENT", p.parent_plan_id ?? null],
          );
          for (const o of p.operations) {
            await client.query(
              `insert into plan_operations (operation_id, plan_id, ordinal, logical_resource_key, physical_target_ref, target_parent_ref, target_data_source_ref, natural_key, idempotency_key, operation, baseline_revision, compared_fields, before_values, expected_values, before_hash, expected_hash, natural_key_property, natural_key_property_type)
               values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
              [o.operation_id, p.plan_id, o.ordinal, o.logical_resource_key, o.physical_target_ref ?? null, o.target_parent_ref ?? null, o.target_data_source_ref ?? null, o.natural_key ?? null, o.idempotency_key, o.operation, o.baseline_revision ?? null, [...o.compared_fields], JSON.stringify(o.before_values), JSON.stringify(o.expected_values), o.before_hash ?? null, o.expected_hash ?? null, o.natural_key_property ?? null, o.natural_key_property_type ?? null],
            );
          }
          await client.query("commit");
        } catch (err) {
          await client.query("rollback");
          throw err;
        } finally {
          client.release();
        }
      },
      async get(id) {
        const q = await pool.query("select * from plans where plan_id = $1", [id]);
        if (!q.rows[0]) return undefined;
        const ops = await pool.query("select * from plan_operations where plan_id = $1 order by ordinal", [id]);
        return rowToPlan(q.rows[0], ops.rows);
      },
      async setState(id, state: PlanState) { await pool.query("update plans set plan_state = $2 where plan_id = $1", [id, state]); },
      async findActive(project: string, lane: Lane, gen: string) {
        const q = await pool.query("select plan_id from plans where project = $1 and lane = $2 and runtime_generation = $3 and plan_state = any($4)", [project, lane, gen, NON_TERMINAL]);
        const out: Plan[] = [];
        for (const r of q.rows) { const p = await plans.get(r.plan_id as string); if (p && !isTerminal(p.plan_state)) out.push(p); }
        return out;
      },
      async listByRuntime(project: string, lane: Lane, gen: string) {
        const q = await pool.query("select plan_id from plans where project = $1 and lane = $2 and runtime_generation = $3 order by created_at", [project, lane, gen]);
        const out: Plan[] = [];
        for (const r of q.rows) { const p = await plans.get(r.plan_id as string); if (p) out.push(p); }
        return out;
      },
      async renew(planId, claimToken, now, until) {
        // Plan and lease move together or not at all, under row locks.
        const client = await pool.connect();
        try {
          await client.query("begin");
          const p = await client.query(
            "select project, lane, runtime_generation from plans where plan_id = $1 and exec_claim_token = $2 and exec_claim_until > $3 and plan_state = any($4) for update",
            [planId, claimToken, now, NON_TERMINAL],
          );
          const row = p.rows[0] as { project: string; lane: string; runtime_generation: string } | undefined;
          const lease = row ? await client.query(
            "update runtime_leases set expires_at = $5 where project = $1 and lane = $2 and runtime_generation = $3 and plan_id = $4 returning plan_id",
            [row.project, row.lane, row.runtime_generation, planId, until],
          ) : undefined;
          if (!row || !lease?.rows[0]) { await client.query("rollback"); return false; }
          await client.query("update plans set expires_at = $2 where plan_id = $1", [planId, until]);
          await client.query("commit");
          return true;
        } catch (err) {
          await client.query("rollback").catch(() => undefined);
          throw err;
        } finally {
          client.release();
        }
      },
    };

    const claims: ClaimStore = {
      async claim(planId, token, now, until) {
        const q = await pool.query(
          "update plans set exec_claim_token = $2, exec_claim_until = $4 where plan_id = $1 and (exec_claim_token is null or exec_claim_until <= $3 or exec_claim_token = $2) returning plan_id",
          [planId, token, now, until],
        );
        return q.rows.length === 1;
      },
      async release(planId, token) {
        await pool.query("update plans set exec_claim_token = null, exec_claim_until = null where plan_id = $1 and exec_claim_token = $2", [planId, token]);
      },
    };

    const planWrites: PlanWriteStore = {
      async list(planId) {
        const q = await pool.query("select * from plan_writes where plan_id = $1 order by ordinal, symbol", [planId]);
        return q.rows.map(rowToPlanWrite);
      },
      async ensure(planId, seeds) {
        const client = await pool.connect();
        try {
          await client.query("begin");
          for (const w of seeds) {
            await client.query(
              "insert into plan_writes (plan_id, symbol, phase, ordinal, operation, target_ref) values ($1,$2,$3,$4,$5,$6) on conflict (plan_id, symbol) do nothing",
              [planId, w.symbol, w.phase, w.ordinal, w.operation, w.target_ref],
            );
          }
          await client.query("commit");
        } catch (err) {
          await client.query("rollback").catch(() => undefined);
          throw err;
        } finally {
          client.release();
        }
        return planWrites.list(planId);
      },
      async transition(planId, symbol, from, to, patch) {
        const client = await pool.connect();
        try {
          await client.query("begin");
          const q = await client.query("select * from plan_writes where plan_id = $1 and symbol = $2 for update", [planId, symbol]);
          if (!q.rows[0]) throw new Error(`plan write ${planId}/${symbol} is not journaled`);
          const next = applyWriteTransition(rowToPlanWrite(q.rows[0]), from, to, patch);
          if (!next) { await client.query("rollback"); return undefined; }
          await client.query(
            "update plan_writes set status = $3, payload_hash = $4, stamped_now = $5, attempts = $6, created_id = $7, last_error = $8, sent_at = $9, done_at = $10 where plan_id = $1 and symbol = $2",
            [planId, symbol, next.status, next.payload_hash ?? null, next.stamped_now ?? null, next.attempts, next.created_id ?? null, next.last_error ?? null, next.sent_at ?? null, next.done_at ?? null],
          );
          await client.query("commit");
          return next;
        } catch (err) {
          await client.query("rollback").catch(() => undefined);
          throw err;
        } finally {
          client.release();
        }
      },
    };

    const leases: LeaseStore = {
      async acquire(key: LeaseKey, planId, now, expiresAt): Promise<LeaseOutcome> {
        // Atomic: insert, or take over only if the holder is expired or its plan is terminal.
        const q = await pool.query(
          `insert into runtime_leases (project, lane, runtime_generation, plan_id, acquired_at, expires_at)
           values ($1,$2,$3,$4,$5,$6)
           on conflict (project, lane, runtime_generation) do update
             set plan_id = excluded.plan_id, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at
             where runtime_leases.expires_at <= $5
                or runtime_leases.plan_id = excluded.plan_id
                or exists (select 1 from plans p where p.plan_id = runtime_leases.plan_id and p.plan_state in ('FINAL_VERIFIED','EXPIRED','ABORTED','SUPERSEDED'))
           returning plan_id, acquired_at, expires_at`,
          [key.project, key.lane, key.runtime_generation, planId, now, expiresAt],
        );
        if (q.rows[0]) return { acquired: true, lease: { ...key, plan_id: q.rows[0].plan_id, acquired_at: q.rows[0].acquired_at, expires_at: q.rows[0].expires_at } };
        const h = await pool.query("select plan_id, acquired_at, expires_at from runtime_leases where project = $1 and lane = $2 and runtime_generation = $3", [key.project, key.lane, key.runtime_generation]);
        const holder: Lease = { ...key, plan_id: h.rows[0].plan_id, acquired_at: h.rows[0].acquired_at, expires_at: h.rows[0].expires_at };
        return { acquired: false, holder };
      },
      async release(key, planId) { await pool.query("delete from runtime_leases where project = $1 and lane = $2 and runtime_generation = $3 and plan_id = $4", [key.project, key.lane, key.runtime_generation, planId]); },
      async current(key, now) {
        const q = await pool.query("select plan_id, acquired_at, expires_at from runtime_leases where project = $1 and lane = $2 and runtime_generation = $3 and expires_at > $4", [key.project, key.lane, key.runtime_generation, now]);
        return q.rows[0] ? { ...key, plan_id: q.rows[0].plan_id, acquired_at: q.rows[0].acquired_at, expires_at: q.rows[0].expires_at } : undefined;
      },
    };

    const receipts: ReceiptStore = {
      async insert(r: ReceiptRecord) {
        await pool.query(
          `insert into receipts (receipt_id, type, plan_id, principal_id, runtime_id, runtime_generation, run_ref, target_receipt_id, observed_at, observations, expires_at, status)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [r.receipt_id, r.type, r.plan_id, r.principal_id, r.runtime_id, r.runtime_generation, r.run_ref ?? null, r.target_receipt_id ?? null, r.observed_at, JSON.stringify(r.observations), r.expires_at ?? null, r.status],
        );
      },
      async insertIfAbsent(r: ReceiptRecord) {
        // `on conflict do nothing` covers the partial unique index receipts_one_valid_per_plan_phase_uq.
        const q = await pool.query(
          `insert into receipts (receipt_id, type, plan_id, principal_id, runtime_id, runtime_generation, run_ref, target_receipt_id, observed_at, observations, expires_at, status)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict do nothing returning *`,
          [r.receipt_id, r.type, r.plan_id, r.principal_id, r.runtime_id, r.runtime_generation, r.run_ref ?? null, r.target_receipt_id ?? null, r.observed_at, JSON.stringify(r.observations), r.expires_at ?? null, r.status],
        );
        if (q.rows[0]) return rowToReceipt(q.rows[0]);
        const incumbent = await pool.query("select * from receipts where plan_id = $1 and type = $2 and status = 'VALID' order by observed_at limit 1", [r.plan_id, r.type]);
        if (incumbent.rows[0]) return rowToReceipt(incumbent.rows[0]);
        throw new Error(`receipt ${r.receipt_id} was rejected but no live ${r.type} receipt exists for plan ${r.plan_id}`);
      },
      async get(id) { const q = await pool.query("select * from receipts where receipt_id = $1", [id]); return q.rows[0] ? rowToReceipt(q.rows[0]) : undefined; },
      async setStatus(id, status) { await pool.query("update receipts set status = $2 where receipt_id = $1", [id, status]); },
      async findByPlan(planId, type?: VerifyPhase) {
        const q = type ? await pool.query("select * from receipts where plan_id = $1 and type = $2 order by observed_at", [planId, type]) : await pool.query("select * from receipts where plan_id = $1 order by observed_at", [planId]);
        return q.rows.map(rowToReceipt);
      },
      async findByRuntime(runtimeId, type?: VerifyPhase) {
        const q = type ? await pool.query("select * from receipts where runtime_id = $1 and type = $2 order by observed_at", [runtimeId, type]) : await pool.query("select * from receipts where runtime_id = $1 order by observed_at", [runtimeId]);
        return q.rows.map(rowToReceipt);
      },
    };

    receipts.findFinalByFields = async (scope, fields) => {
      if (fields.length > 16384) throw new Error("terminal proof scope exceeds bounded field lookup");
      if (fields.length === 0) return [];
      const q = await pool.query(`with wanted as (select * from jsonb_to_recordset($1::jsonb) as x(page_ref text, field text))
        select distinct on (x.page_ref, x.field) x.page_ref, x.field, r.*
        from wanted x join plan_operations o on x.field = any(o.compared_fields)
        join plans p on p.plan_id = o.plan_id
        join receipts r on r.plan_id = p.plan_id and r.type = 'FINAL' and r.status = 'VALID'
        left join plan_writes w on w.plan_id = p.plan_id and w.symbol = 'TARGET_' || o.ordinal::text
        where replace(coalesce(o.physical_target_ref,w.created_id),'-','') = x.page_ref
          and p.plan_state = 'FINAL_VERIFIED' and p.principal_id = $2 and p.project = $3 and p.lane = $4
          and p.runtime_id = $5 and p.runtime_generation = $6 and p.governing_spec_version = $7
          and p.governing_schema_version = $8 and p.governing_control_version = $9
        order by x.page_ref,x.field,r.observed_at desc,r.receipt_id desc`,
      [JSON.stringify(fields),scope.principal_id,scope.project,scope.lane,scope.runtime_id,scope.runtime_generation,
        scope.governing_spec_version,scope.governing_schema_version,scope.governing_control_version]);
      return q.rows.map(r => ({ page_ref: r.page_ref as string, field: r.field as string, receipt: rowToReceipt(r) }));
    };

    const events: EventLog = {
      async append(e: TransactionEvent) {
        const args = [e.principal_id ?? null, e.binding_id ?? null, e.plan_id ?? null, e.receipt_id ?? null, e.runtime_id ?? null, e.event_type, e.result, e.detail ? JSON.stringify(e.detail) : null, e.created_at];
        const terminal = e.event_type === "PLAN_FINAL_VERIFIED" || e.event_type === "FINAL_RECEIPT_ISSUED" || e.event_type === "LEASE_RELEASED";
        await pool.query(terminal
          ? `insert into transaction_events (principal_id, binding_id, plan_id, receipt_id, runtime_id, event_type, result, detail, created_at)
             select $1,$2,$3,$4,$5,$6,$7,$8,$9
             where not exists (
               select 1 from transaction_events
                where plan_id = $3 and event_type = $6 and result = $7
                  and receipt_id is not distinct from $4
             )`
          : `insert into transaction_events (principal_id, binding_id, plan_id, receipt_id, runtime_id, event_type, result, detail, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, args);
      },
      async list(filter) {
        const limit = eventReadLimit(filter);
        const q = await pool.query(`select * from transaction_events where ($1::text is null or plan_id = $1) and ($2::text is null or binding_id = $2) and ($3::text is null or runtime_id = $3) and ($4::text is null or event_type = $4) order by event_id ${filter?.newest_first ? "desc" : "asc"} limit $5`, [filter?.plan_id ?? null, filter?.binding_id ?? null, filter?.runtime_id ?? null, filter?.event_type ?? null, limit ?? null]);
        return q.rows.map((r) => ({ event_type: r.event_type, result: r.result, principal_id: r.principal_id ?? undefined, binding_id: r.binding_id ?? undefined, plan_id: r.plan_id ?? undefined, receipt_id: r.receipt_id ?? undefined, runtime_id: r.runtime_id ?? undefined, detail: r.detail ?? undefined, created_at: r.created_at }));
      },
    };

    const finalizePlan: BackendStore["finalizePlan"] = async ({ plan, target_receipt, final_receipt, now, committed_install_proof_plan_id }) => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const lockedPlan = await client.query("select * from plans where plan_id = $1 for update", [plan.plan_id]);
        const planRow = lockedPlan.rows[0] as Record<string, unknown> | undefined;
        if (!planRow) throw new Error(`plan ${plan.plan_id} does not exist`);
        const state = planRow["plan_state"] as PlanState;
        const committedRecovery = planRow["plan_kind"] === "INSTALL_PROMOTION"
          && committed_install_proof_plan_id === plan.plan_id;

        const incumbent = await client.query(
          "select * from receipts where plan_id = $1 and type = 'FINAL' and status = 'VALID' order by observed_at, receipt_id limit 1 for update",
          [plan.plan_id],
        );
        if (!incumbent.rows[0] && !["TARGET_VERIFIED", "AWAITING_FINAL_VERIFY", "FINAL_VERIFIED"].includes(state) && !(committedRecovery && (state === "EXPIRED" || state === "SUPERSEDED"))) throw new Error(`plan ${plan.plan_id} cannot finalize from ${state}`);

        const lockedTarget = await client.query("select * from receipts where receipt_id = $1 for update", [target_receipt.receipt_id]);
        const targetRow = lockedTarget.rows[0] as Record<string, unknown> | undefined;
        if (!targetRow || targetRow["type"] !== "TARGET" || targetRow["plan_id"] !== plan.plan_id) {
          throw new Error(`target receipt ${target_receipt.receipt_id} does not belong to plan ${plan.plan_id}`);
        }
        if (targetRow["principal_id"] !== planRow["principal_id"] || targetRow["runtime_generation"] !== planRow["runtime_generation"]) {
          throw new Error(`target receipt ${target_receipt.receipt_id} has the wrong owner or runtime generation`);
        }

        let final: ReceiptRecord;
        if (incumbent.rows[0]) {
          final = rowToReceipt(incumbent.rows[0]);
          if (final.target_receipt_id !== target_receipt.receipt_id) throw new Error(`FINAL receipt ${final.receipt_id} references another TARGET receipt`);
        } else {
          const targetStatus = targetRow["status"] as ReceiptRecord["status"];
          // CONSUMED with no FINAL is the recoverable crash footprint left by the former multi-call sequence.
          if (targetStatus !== "VALID" && targetStatus !== "CONSUMED" && !(committedRecovery && targetStatus === "EXPIRED")) throw new Error(`target receipt ${target_receipt.receipt_id} is ${targetStatus}`);
          const inserted = await client.query(
            `insert into receipts (receipt_id, type, plan_id, principal_id, runtime_id, runtime_generation, run_ref, target_receipt_id, observed_at, observations, expires_at, status)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
             on conflict do nothing returning *`,
            [final_receipt.receipt_id, final_receipt.type, final_receipt.plan_id, final_receipt.principal_id, final_receipt.runtime_id, final_receipt.runtime_generation, final_receipt.run_ref ?? null, final_receipt.target_receipt_id ?? null, final_receipt.observed_at, JSON.stringify(final_receipt.observations), final_receipt.expires_at ?? null, final_receipt.status],
          );
          if (inserted.rows[0]) final = rowToReceipt(inserted.rows[0]);
          else {
            const raced = await client.query("select * from receipts where plan_id = $1 and type = 'FINAL' and status = 'VALID' order by observed_at, receipt_id limit 1 for update", [plan.plan_id]);
            if (!raced.rows[0]) throw new Error(`FINAL receipt ${final_receipt.receipt_id} was rejected without an incumbent`);
            final = rowToReceipt(raced.rows[0]);
          }
        }

        await client.query(
          "update receipts set status = 'CONSUMED' where receipt_id = $1 and status = any($2)",
          [target_receipt.receipt_id, committedRecovery ? ["VALID", "CONSUMED", "EXPIRED"] : ["VALID", "CONSUMED"]],
        );
        await client.query("update plans set plan_state = 'FINAL_VERIFIED' where plan_id = $1", [plan.plan_id]);
        await client.query("delete from runtime_leases where project = $1 and lane = $2 and runtime_generation = $3 and plan_id = $4", [planRow["project"], planRow["lane"], planRow["runtime_generation"], plan.plan_id]);

        const terminalEvents: TransactionEvent[] = [
          { event_type: "PLAN_FINAL_VERIFIED", result: "FINAL_VERIFIED", principal_id: planRow["principal_id"] as string, binding_id: planRow["binding_id"] as string, plan_id: plan.plan_id, receipt_id: final.receipt_id, runtime_id: planRow["runtime_id"] as string, detail: { from: state, target_receipt_id: target_receipt.receipt_id }, created_at: now },
          { event_type: "FINAL_RECEIPT_ISSUED", result: "TRANSACTION_VERIFIED", principal_id: planRow["principal_id"] as string, binding_id: planRow["binding_id"] as string, plan_id: plan.plan_id, receipt_id: final.receipt_id, runtime_id: planRow["runtime_id"] as string, created_at: now },
          { event_type: "LEASE_RELEASED", result: "FINAL_VERIFIED", principal_id: planRow["principal_id"] as string, binding_id: planRow["binding_id"] as string, plan_id: plan.plan_id, receipt_id: final.receipt_id, runtime_id: planRow["runtime_id"] as string, created_at: now },
        ];
        for (const e of terminalEvents) {
          await client.query(
            `insert into transaction_events (principal_id, binding_id, plan_id, receipt_id, runtime_id, event_type, result, detail, created_at)
             select $1,$2,$3,$4,$5,$6,$7,$8,$9
             where not exists (
               select 1 from transaction_events
                where plan_id = $3 and event_type = $6 and result = $7
                  and receipt_id is not distinct from $4
             )`,
            [e.principal_id ?? null, e.binding_id ?? null, e.plan_id ?? null, e.receipt_id ?? null, e.runtime_id ?? null, e.event_type, e.result, e.detail ? JSON.stringify(e.detail) : null, e.created_at],
          );
        }
        await client.query("commit");
        return final;
      } catch (err) {
        await client.query("rollback").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    };

    const guardApprovals: GuardApprovalStore = {
      async get(bindingId) {
        const q = await pool.query("select * from guard_approvals where binding_id = $1", [bindingId]);
        const r = q.rows[0] as Record<string, unknown> | undefined;
        return r ? { binding_id: r["binding_id"] as string, runtime_id: r["runtime_id"] as string, runtime_generation: r["runtime_generation"] as string, guard_schema_version: r["guard_schema_version"] as string, index_page_id: r["index_page_id"] as string, digest_sha256: r["digest_sha256"] as string, approved_at: r["approved_at"] as Date, operator_id: r["operator_id"] as string } : undefined;
      },
      async put(a: GuardApproval) {
        await pool.query(
          `insert into guard_approvals (binding_id, runtime_id, runtime_generation, guard_schema_version, index_page_id, digest_sha256, approved_at, operator_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8)
           on conflict (binding_id) do update set runtime_id = excluded.runtime_id, runtime_generation = excluded.runtime_generation, guard_schema_version = excluded.guard_schema_version,
             index_page_id = excluded.index_page_id, digest_sha256 = excluded.digest_sha256, approved_at = excluded.approved_at, operator_id = excluded.operator_id`,
          [a.binding_id, a.runtime_id, a.runtime_generation, a.guard_schema_version, a.index_page_id, a.digest_sha256, a.approved_at, a.operator_id],
        );
      },
    };

    return { bindings, plans, leases, receipts, events, claims, planWrites, finalizePlan, guardApprovals };
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
}

function rowToBinding(r: Record<string, unknown>): BindingRecord {
  return {
    binding_id: r["binding_id"] as string, handle_hash: r["handle_hash"] as string, principal_id: r["principal_id"] as string, project: r["project"] as string, lane: r["lane"] as Lane,
    runtime_logical_key: r["runtime_logical_key"] as string, runtime_id: r["runtime_id"] as string, runtime_generation: r["runtime_generation"] as string,
    binding_mode: (r["binding_mode"] as BindingRecord["binding_mode"] | undefined) ?? "BUSINESS",
    install_phase: (r["install_phase"] as BindingRecord["install_phase"] | undefined) ?? "NOT_APPLICABLE",
    resolved_manifest_ref: r["resolved_manifest_ref"] as string,
    governing_versions_snapshot: r["governing_versions_snapshot"] as Record<string, string>, status: r["status"] as BindingState, created_at: r["created_at"] as Date, expires_at: r["expires_at"] as Date,
    ...(r["last_seen_at"] ? { last_seen_at: r["last_seen_at"] as Date } : {}),
  };
}

function rowToPlan(r: Record<string, unknown>, ops: Record<string, unknown>[]): Plan {
  return {
    plan_id: r["plan_id"] as string, plan_kind: (r["plan_kind"] as Plan["plan_kind"] | undefined) ?? "BUSINESS", principal_id: r["principal_id"] as string, binding_id: r["binding_id"] as string, project: r["project"] as string, lane: r["lane"] as Lane,
    runtime_logical_key: r["runtime_logical_key"] as string, runtime_id: r["runtime_id"] as string, runtime_generation: r["runtime_generation"] as string,
    governing_spec_version: r["governing_spec_version"] as string, governing_schema_version: r["governing_schema_version"] as string, governing_control_version: r["governing_control_version"] as string,
    run_mode: r["run_mode"] as Plan["run_mode"], ...(r["run_ref"] ? { run_ref: r["run_ref"] as string } : {}), ...(r["recovers_plan_id"] ? { recovers_plan_id: r["recovers_plan_id"] as string } : {}), execution_attempt_id: r["execution_attempt_id"] as string,
    ...(r["install_mapping_plan_id"] ? { install_mapping_plan_id: r["install_mapping_plan_id"] as string } : {}),
    ...(r["install_mapping_final_receipt_id"] ? { install_mapping_final_receipt_id: r["install_mapping_final_receipt_id"] as string } : {}),
    ...(r["install_context_fingerprint"] ? { install_context_fingerprint: r["install_context_fingerprint"] as string } : {}),
    ...(r["plan_origin"] ? { plan_origin: r["plan_origin"] as NonNullable<Plan["plan_origin"]> } : {}),
    ...(r["parent_plan_id"] ? { parent_plan_id: r["parent_plan_id"] as string } : {}),
    created_at: r["created_at"] as Date, expires_at: r["expires_at"] as Date, baseline_runtime_revision: r["baseline_runtime_revision"] as string,
    operations: ops.map((o): PlanOperation => ({
      operation_id: o["operation_id"] as string, ordinal: o["ordinal"] as number, logical_resource_key: o["logical_resource_key"] as string,
      ...(o["physical_target_ref"] ? { physical_target_ref: o["physical_target_ref"] as string } : {}), ...(o["target_parent_ref"] ? { target_parent_ref: o["target_parent_ref"] as string } : {}),
      ...(o["target_data_source_ref"] ? { target_data_source_ref: o["target_data_source_ref"] as string } : {}), ...(o["natural_key"] ? { natural_key: o["natural_key"] as string } : {}), ...(o["natural_key_property"] ? { natural_key_property: o["natural_key_property"] as string } : {}), ...(o["natural_key_property_type"] ? { natural_key_property_type: o["natural_key_property_type"] as string } : {}),
      idempotency_key: o["idempotency_key"] as string, operation: o["operation"] as PlanOperation["operation"], ...(o["baseline_revision"] ? { baseline_revision: o["baseline_revision"] as string } : {}),
      compared_fields: o["compared_fields"] as string[], before_values: o["before_values"] as Record<string, unknown>, expected_values: o["expected_values"] as Record<string, unknown>,
      ...(o["before_hash"] ? { before_hash: o["before_hash"] as string } : {}), ...(o["expected_hash"] ? { expected_hash: o["expected_hash"] as string } : {}),
    })),
    stage1_writes: r["stage1_writes"] as Plan["stage1_writes"], finalization_writes: r["finalization_writes"] as Plan["finalization_writes"], state_last_write: r["state_last_write"] as Plan["state_last_write"],
    plan_state: r["plan_state"] as PlanState,
  };
}

function rowToPlanWrite(r: Record<string, unknown>): PlanWriteRow {
  return {
    plan_id: r["plan_id"] as string, symbol: r["symbol"] as string, phase: r["phase"] as PlanWriteRow["phase"], ordinal: r["ordinal"] as number,
    operation: r["operation"] as PlanWriteRow["operation"], target_ref: r["target_ref"] as string, status: r["status"] as PlanWriteRow["status"], attempts: r["attempts"] as number,
    ...(r["payload_hash"] ? { payload_hash: r["payload_hash"] as string } : {}), ...(r["stamped_now"] ? { stamped_now: r["stamped_now"] as string } : {}),
    ...(r["created_id"] ? { created_id: r["created_id"] as string } : {}), ...(r["last_error"] ? { last_error: r["last_error"] as string } : {}),
    ...(r["sent_at"] ? { sent_at: r["sent_at"] as Date } : {}), ...(r["done_at"] ? { done_at: r["done_at"] as Date } : {}),
  };
}

function rowToReceipt(r: Record<string, unknown>): ReceiptRecord {
  return {
    receipt_id: r["receipt_id"] as string, type: r["type"] as VerifyPhase, plan_id: r["plan_id"] as string, principal_id: r["principal_id"] as string, runtime_id: r["runtime_id"] as string, runtime_generation: r["runtime_generation"] as string,
    ...(r["run_ref"] ? { run_ref: r["run_ref"] as string } : {}), ...(r["target_receipt_id"] ? { target_receipt_id: r["target_receipt_id"] as string } : {}),
    observed_at: r["observed_at"] as Date, observations: r["observations"] as Record<string, unknown>, ...(r["expires_at"] ? { expires_at: r["expires_at"] as Date } : {}), status: r["status"] as ReceiptRecord["status"],
  };
}
