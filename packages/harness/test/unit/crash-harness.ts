/**
 * Deterministic crash + parallel-chat harness (PV0-016). Drives a full plugin transaction in "chat A" up to a
 * named crash point, then starts "chat B" (a new binding of the same principal) that resumes, re-issues the
 * intent and finishes the transaction. Every write is performed by the fixture native writer, so the harness
 * can count durable mutations exactly and assert that nothing is ever duplicated.
 */
import assert from "node:assert/strict";
import { dispatch } from "../../src/tools/handlers.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import type { Plan, WriteInstruction } from "../../src/plans/store.ts";
import { handleOf, OWNER, T0 } from "./binding-fixtures.ts";
import { R, type ResumeWorld } from "./resume-fixtures.ts";
import { executeWrites, mutatePage, rowsOf } from "./target-fixtures.ts";
import { ID as META_ID } from "./meta-fixtures.ts";

export type CrashPoint = "AFTER_OPEN_RUN" | "AFTER_PREPARE_LEDGER" | "AFTER_WRITE_TARGET" | "AFTER_STAGE1" | "AFTER_TARGET" | "DURING_FINALIZATION" | "AFTER_FINALIZATION" | "AFTER_STATE_LAST";
const ORDER: CrashPoint[] = ["AFTER_OPEN_RUN", "AFTER_PREPARE_LEDGER", "AFTER_WRITE_TARGET", "AFTER_STAGE1", "AFTER_TARGET", "DURING_FINALIZATION", "AFTER_FINALIZATION", "AFTER_STATE_LAST"];
const reached = (crash: CrashPoint, point: CrashPoint) => ORDER.indexOf(crash) >= ORDER.indexOf(point);

export const TL = { a1: "2030-01-03T00:30:00.000Z", a2: "2030-01-03T00:31:00.000Z", a3: "2030-01-03T00:32:00.000Z", b1: "2030-01-03T01:00:00.000Z", b2: "2030-01-03T01:01:00.000Z", b3: "2030-01-03T01:02:00.000Z", edit: "2030-01-03T01:03:00.000Z" };
export const META_INTENT = { action_class: "COMMIT", summary: "set the next frame question", mutations: [{ logical_resource_key: "META:GATES", operation: "UPDATE" as const, record_selector: { natural_key: "T1" }, desired_changes: { "Next Question": "What is the offer?" } }] };
type Ok = Extract<Envelope, { status: "OK" }>;

export interface Scenario {
  readonly crash: CrashPoint;
  readonly lane?: "META" | "SALES";
  readonly intent?: unknown;
  /** Chat B acts after the plan TTL (stale/expired plan). */
  readonly expire?: boolean;
  /** Another actor re-points the Manifest at a foreign Run right before chat B's FINAL. */
  readonly concurrentManifestEdit?: boolean;
  /** Chat B is a different principal's... no: chat B is always the same principal (a new chat). */
}

export interface Outcome {
  readonly planA: Plan;
  readonly hA: string;
  readonly hB: string;
  readonly resumeB: string;
  readonly prepareB: Envelope;
  readonly planB?: Plan;
  readonly phase?: string;
  readonly stage1B: readonly string[];
  readonly targetB?: string;
  readonly finalB?: string;
  /** Durable counters observed in the fixture after chat B. */
  readonly targetWrites: number;
  readonly runs: number;
  readonly ledgerRows: number;
}

function ctxAt(now: Date) { return { principal_id: OWNER.principal_id, now }; }

export async function runScenario(w: ResumeWorld, s: Scenario): Promise<Outcome> {
  const lane = s.lane ?? "META";
  const intent = s.intent ?? META_INTENT;
  let targetWrites = 0;
  const count = (writes: readonly WriteInstruction[], skip: string[] = []) => { targetWrites += writes.filter((x) => x.purpose === "WRITE_TARGET" && !skip.includes(x.symbol)).length; };

  // Chat A.
  const hA = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane }, ctxAt(T0), w.deps));
  const pA = await dispatch("os_prepare", { binding_handle: hA, intent }, ctxAt(T0), w.deps);
  assert.equal(pA.code, "PLAN_PREPARED", JSON.stringify(pA));
  const planA = (await w.deps.store.plans.get(((pA as Ok).result as { plan_id: string }).plan_id))!;
  const skip = s.crash === "AFTER_OPEN_RUN" ? ["LEDGER_0", "TARGET_0", "LEDGER_0_WRITTEN"] : s.crash === "AFTER_PREPARE_LEDGER" ? ["TARGET_0", "LEDGER_0_WRITTEN"] : s.crash === "AFTER_WRITE_TARGET" ? ["LEDGER_0_WRITTEN"] : [];
  executeWrites(w, planA.stage1_writes, planA.plan_id, { now: TL.a1, skip });
  count(planA.stage1_writes, skip);
  if (reached(s.crash, "AFTER_TARGET")) {
    const t = await dispatch("os_verify", { binding_handle: hA, plan_id: planA.plan_id, phase: "TARGET" }, ctxAt(T0), w.deps);
    assert.equal(t.code, "TARGET_VERIFIED", JSON.stringify(t));
    const receipt = ((t as Ok).result as { target_receipt_id: string }).target_receipt_id;
    const symbols = t.observations["symbols"] as Record<string, string>;
    if (reached(s.crash, "DURING_FINALIZATION")) {
      executeWrites(w, planA.finalization_writes, planA.plan_id, { now: TL.a2, created: symbols, target_receipt_id: receipt, skip: s.crash === "DURING_FINALIZATION" ? ["FINALIZE_RUN"] : [] });
    }
    if (reached(s.crash, "AFTER_STATE_LAST")) executeWrites(w, [planA.state_last_write], planA.plan_id, { ...({ now: TL.a3 }), created: symbols, target_receipt_id: receipt });
  }

  // Chat B (same principal, new binding), possibly after expiry.
  const nowB = s.expire ? new Date(T0.getTime() + 16 * 60_000) : T0;
  const hB = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane }, ctxAt(nowB), w.deps));
  const resumeB = (await dispatch("os_resume", { binding_handle: hB }, ctxAt(nowB), w.deps)).code;
  const prepareB = await dispatch("os_prepare", { binding_handle: hB, intent }, ctxAt(nowB), w.deps);
  let planB: Plan | undefined;
  let targetB: string | undefined;
  let finalB: string | undefined;
  let stage1B: string[] = [];
  if (prepareB.code === "PLAN_PREPARED") {
    planB = (await w.deps.store.plans.get(((prepareB as Ok).result as { plan_id: string }).plan_id))!;
    stage1B = planB.stage1_writes.map((x) => x.symbol);
    executeWrites(w, planB.stage1_writes, planB.plan_id, { now: TL.b1, salt: "B" });
    count(planB.stage1_writes);
    const t = await dispatch("os_verify", { binding_handle: hB, plan_id: planB.plan_id, phase: "TARGET" }, ctxAt(nowB), w.deps);
    targetB = t.code;
    if (t.code === "TARGET_VERIFIED") {
      const receipt = ((t as Ok).result as { target_receipt_id: string }).target_receipt_id;
      const symbols = t.observations["symbols"] as Record<string, string>;
      executeWrites(w, planB.finalization_writes, planB.plan_id, { ...({ now: TL.b2 }), created: symbols, target_receipt_id: receipt });
      executeWrites(w, [planB.state_last_write], planB.plan_id, { ...({ now: TL.b3 }), created: symbols, target_receipt_id: receipt });
      if (s.concurrentManifestEdit) mutatePage(w, lane === "META" ? META_ID.manifest : R.salesStateRow, { "Last Run Ref": `page:${R.run1}` }, TL.edit);
      finalB = (await dispatch("os_verify", { binding_handle: hB, plan_id: planB.plan_id, phase: "FINAL" }, ctxAt(nowB), w.deps)).code;
    }
  }
  const link = planA.plan_id;
  const runsDs = lane === "META" ? R.metaRunsDs : R.salesRunsDs;
  const ledgerDs = lane === "META" ? R.metaLedgerDs : R.salesLedgerDs;
  const byLink = (ds: string) => rowsOf(w, ds).filter((p) => (p.properties["Harness Plan ID"] as unknown as { rich_text?: Array<{ plain_text: string }> } | undefined)?.rich_text?.[0]?.plain_text === link).length;
  const phase = (prepareB.observations["recovery"] as { phase?: string } | undefined)?.phase;
  return { planA, hA, hB, resumeB, prepareB, ...(planB ? { planB } : {}), ...(phase ? { phase } : {}), stage1B, ...(targetB ? { targetB } : {}), ...(finalB ? { finalB } : {}), targetWrites, runs: byLink(runsDs), ledgerRows: byLink(ledgerDs) };
}

/** The durable invariant every recovered scenario must satisfy: one Run, one ledger row per operation, one effect. */
export function assertNoDuplicateDurableMutation(o: Outcome, ops = 1): void {
  assert.equal(o.runs, 1, "exactly one Run for the transaction");
  assert.equal(o.ledgerRows, ops, "exactly one ledger row per operation");
  assert.equal(o.targetWrites, 1, "the business mutation was written exactly once across both chats");
}
