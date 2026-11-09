/**
 * PV0-014 — os_verify(FINAL): PT-FINAL-001..012 (PG5), plus the success path (TRANSACTION_VERIFIED).
 * The fixture writer executes the rendered actions with explicit timestamps so state-last ordering is provable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../../src/tools/handlers.ts";
import { metaSpecAdapter } from "../../src/versions/adapters/meta.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import type { Plan, WriteInstruction } from "../../src/plans/store.ts";
import { handleOf, OWNER, T0 } from "./binding-fixtures.ts";
import { buildResumeWorld, R, type ResumeWorld } from "./resume-fixtures.ts";
import { GRAMMAR as META_GRAMMAR, ID as META_ID, specRootChildren, V as MV } from "./meta-fixtures.ts";
import { executeWrites, mutatePage, type WriterOptions } from "./target-fixtures.ts";

const ctx = { principal_id: OWNER.principal_id, now: T0 };
const gateIntent = { action_class: "COMMIT", summary: "set the next frame question", mutations: [{ logical_resource_key: "META:GATES", operation: "UPDATE" as const, record_selector: { natural_key: "T1" }, desired_changes: { "Next Question": "What is the offer?" } }] };
// Transaction timeline after the fixture history (historical runs are dated 2030-01-01/02).
const T = { stage1: "2030-01-03T00:30:00.000Z", fin: "2030-01-03T00:31:00.000Z", state: "2030-01-03T00:32:00.000Z", later: "2030-01-03T00:33:00.000Z" };
type Tx = { h: string; plan: Plan; created: Record<string, string>; receipt: string; symbols: Record<string, string> };

async function throughTarget(w: ResumeWorld, lane: "META" | "SALES" = "META", intent: unknown = gateIntent): Promise<Tx> {
  const h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane }, ctx, w.deps));
  const p = await dispatch("os_prepare", { binding_handle: h, intent }, ctx, w.deps);
  assert.equal(p.code, "PLAN_PREPARED", JSON.stringify(p));
  const plan = (await w.deps.store.plans.get(((p as Extract<Envelope, { status: "OK" }>).result as { plan_id: string }).plan_id))!;
  const created = executeWrites(w, plan.stage1_writes, plan.plan_id, { now: T.stage1 });
  const t = await dispatch("os_verify", { binding_handle: h, plan_id: plan.plan_id, phase: "TARGET" }, ctx, w.deps);
  assert.equal(t.code, "TARGET_VERIFIED", JSON.stringify(t));
  const receipt = ((t as Extract<Envelope, { status: "OK" }>).result as { target_receipt_id: string }).target_receipt_id;
  const symbols = (t.observations["symbols"] as Record<string, string>) ?? created;
  return { h, plan, created, receipt, symbols };
}
function bound(tx: Tx, receipt = tx.receipt): { fin: readonly WriteInstruction[]; state: readonly WriteInstruction[]; resolve: WriterOptions } {
  return { fin: tx.plan.finalization_writes, state: [tx.plan.state_last_write], resolve: { created: tx.symbols, target_receipt_id: receipt } };
}
function finalize(w: ResumeWorld, tx: Tx, opts: { fin?: WriterOptions; state?: WriterOptions; receipt?: string; skipState?: boolean; stateFirst?: boolean } = {}): void {
  const b = bound(tx, opts.receipt);
  if (opts.stateFirst) {
    executeWrites(w, b.state, tx.plan.plan_id, { now: T.fin, ...b.resolve, ...(opts.state ?? {}) });
    executeWrites(w, b.fin, tx.plan.plan_id, { now: T.state, ...b.resolve, ...(opts.fin ?? {}) });
    return;
  }
  executeWrites(w, b.fin, tx.plan.plan_id, { now: T.fin, ...b.resolve, ...(opts.fin ?? {}) });
  if (!opts.skipState) executeWrites(w, b.state, tx.plan.plan_id, { now: T.state, ...b.resolve, ...(opts.state ?? {}) });
}
const final = (w: ResumeWorld, tx: Tx, now = T0) => dispatch("os_verify", { binding_handle: tx.h, plan_id: tx.plan.plan_id, phase: "FINAL" }, { principal_id: OWNER.principal_id, now }, w.deps);
async function noFinal(w: ResumeWorld, tx: Tx, expectedState = "TARGET_VERIFIED") {
  assert.deepEqual(await w.deps.store.receipts.findByPlan(tx.plan.plan_id, "FINAL"), [], "no final receipt");
  assert.equal((await w.deps.store.plans.get(tx.plan.plan_id))!.plan_state, expectedState);
}

test("os_verify(FINAL) success: full transaction verified, final receipt stored, target receipt consumed, lease released", async () => {
  const w = buildResumeWorld();
  const tx = await throughTarget(w);
  finalize(w, tx);
  const r = await final(w, tx);
  assert.equal(r.code, "TRANSACTION_VERIFIED", JSON.stringify(r));
  const res = (r as Extract<Envelope, { status: "OK" }>).result as { final_receipt_id: string; target_receipt_id: string; run_ref: string; repeated: boolean };
  assert.equal(res.repeated, false);
  assert.equal(res.target_receipt_id, tx.receipt);
  assert.equal(res.run_ref, tx.created["OPEN_RUN"]);
  const fin = (await w.deps.store.receipts.get(res.final_receipt_id))!;
  assert.equal(fin.type, "FINAL");
  assert.equal(fin.target_receipt_id, tx.receipt);
  assert.equal((await w.deps.store.receipts.get(tx.receipt))!.status, "CONSUMED");
  assert.equal((await w.deps.store.plans.get(tx.plan.plan_id))!.plan_state, "FINAL_VERIFIED");
  assert.equal(await w.deps.store.leases.current({ project: "VERTIGO", lane: "META", runtime_generation: tx.plan.runtime_generation }, T0), undefined, "lease released");
  assert.equal(r.next.permitted_tool_call, "os_resume");
  // The runtime is now clean: a fresh resume sees the completed Run referenced by the Manifest.
  const resumed = await dispatch("os_resume", { binding_handle: tx.h }, ctx, w.deps);
  assert.equal(resumed.code, "RESUMED", JSON.stringify(resumed));
});

test("PT-FINAL-001: FINAL before TARGET_PASS ⇒ HOLD_FINAL_WITHOUT_TARGET_VERIFICATION, no final receipt", async () => {
  const w = buildResumeWorld();
  const h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps));
  const p = await dispatch("os_prepare", { binding_handle: h, intent: gateIntent }, ctx, w.deps);
  const plan = (await w.deps.store.plans.get(((p as Extract<Envelope, { status: "OK" }>).result as { plan_id: string }).plan_id))!;
  executeWrites(w, plan.stage1_writes, plan.plan_id, { now: T.stage1 });
  const r = await dispatch("os_verify", { binding_handle: h, plan_id: plan.plan_id, phase: "FINAL" }, ctx, w.deps);
  assert.equal(r.code, "HOLD_FINAL_WITHOUT_TARGET_VERIFICATION");
  assert.deepEqual(await w.deps.store.receipts.findByPlan(plan.plan_id), []);
  assert.equal((await w.deps.store.plans.get(plan.plan_id))!.plan_state, "AWAITING_STAGE1_WRITES");
});

test("PT-FINAL-002: ledger carrying another / malformed receipt id ⇒ HOLD_LEDGER_RECEIPT_MISMATCH", async () => {
  const w = buildResumeWorld();
  const tx = await throughTarget(w);
  finalize(w, tx, { receipt: "not-a-receipt" });
  const r = await final(w, tx);
  assert.equal(r.code, "HOLD_LEDGER_RECEIPT_MISMATCH", JSON.stringify(r));
  await noFinal(w, tx);
});

test("PT-FINAL-003: a valid receipt of another plan / runtime is rejected as replay", async () => {
  const w = buildResumeWorld();
  const a = await throughTarget(w);
  const b = await throughTarget(w, "SALES", { action_class: "COMMIT", summary: "queue", mutations: [{ logical_resource_key: "SALES:EXTERNAL_ACTIONS", operation: "CREATE", record_selector: { natural_key: "ak-replay" }, desired_changes: { Recipient: "x@example.invalid" } }] });
  finalize(w, a, { receipt: b.receipt });
  const r = await final(w, a);
  assert.equal(r.code, "HOLD_TARGET_RECEIPT_REPLAY", JSON.stringify(r));
  assert.ok((r as { evidence: readonly string[] }).evidence.some((e) => e.includes(b.plan.plan_id)));
  await noFinal(w, a);
  assert.ok((await w.deps.store.events.list({ plan_id: a.plan.plan_id })).some((e) => e.event_type === "RECEIPT_REPLAY_REJECTED"));
});

test("PT-FINAL-004: a manually written VERIFIED never passes FINAL", async () => {
  // a) target written, ledger set to VERIFIED by hand, TARGET never called.
  const w = buildResumeWorld();
  const h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps));
  const p = await dispatch("os_prepare", { binding_handle: h, intent: gateIntent }, ctx, w.deps);
  const plan = (await w.deps.store.plans.get(((p as Extract<Envelope, { status: "OK" }>).result as { plan_id: string }).plan_id))!;
  const created = executeWrites(w, plan.stage1_writes, plan.plan_id, { now: T.stage1 });
  mutatePage(w, created["LEDGER_0"]!, { Status: "VERIFIED" }, T.fin);
  const r1 = await dispatch("os_verify", { binding_handle: h, plan_id: plan.plan_id, phase: "FINAL" }, ctx, w.deps);
  assert.equal(r1.code, "HOLD_FINAL_WITHOUT_TARGET_VERIFICATION");
  // b) TARGET passed, but the writer set VERIFIED without the receipt id.
  const w2 = buildResumeWorld();
  const tx = await throughTarget(w2);
  const b = bound(tx);
  const fin = b.fin.map((wi) => (wi.symbol === "LEDGER_0_VERIFIED" ? { ...wi, fields: { Status: "VERIFIED" } } : wi));
  executeWrites(w2, fin, tx.plan.plan_id, { now: T.fin, ...b.resolve });
  executeWrites(w2, b.state, tx.plan.plan_id, { now: T.state, ...b.resolve });
  const r2 = await final(w2, tx);
  assert.equal(r2.code, "HOLD_LEDGER_RECEIPT_MISMATCH");
  assert.match((r2 as { evidence: readonly string[] }).evidence.join("\n"), /narrative, not proof/);
  await noFinal(w2, tx);
});

test("PT-FINAL-005: target drift after TARGET ⇒ HOLD_TARGET_CHANGED_AFTER_TARGET_VERIFY; receipt invalidated, plan parked", async () => {
  const w = buildResumeWorld();
  const tx = await throughTarget(w);
  mutatePage(w, R.gateM1, { "Next Question": "Drifted?" }, T.fin);
  finalize(w, tx);
  const r = await final(w, tx);
  assert.equal(r.code, "HOLD_TARGET_CHANGED_AFTER_TARGET_VERIFY", JSON.stringify(r));
  assert.equal((await w.deps.store.receipts.get(tx.receipt))!.status, "INVALID");
  await noFinal(w, tx, "HOLD");
});

test("PT-FINAL-006: incomplete / missing ledger rows or an unfinished Run ⇒ HOLD, no final receipt", async () => {
  const w1 = buildResumeWorld();
  const a = await throughTarget(w1);
  finalize(w1, a, { fin: { skip: ["LEDGER_0_VERIFIED"] } });
  const r1 = await final(w1, a);
  assert.equal(r1.code, "HOLD_LEDGER_NOT_VERIFIED", JSON.stringify(r1));
  await noFinal(w1, a);
  const w2 = buildResumeWorld();
  const b = await throughTarget(w2);
  finalize(w2, b, { fin: { skip: ["FINALIZE_RUN"] } });
  const r2 = await final(w2, b);
  assert.equal(r2.code, "HOLD_RUN_INCOMPLETE");
  await noFinal(w2, b);
});

test("PT-FINAL-007: Run mutation/verified count mismatch ⇒ HOLD_RUN_COUNT_MISMATCH", async () => {
  const w = buildResumeWorld();
  const tx = await throughTarget(w);
  const finalizeRun = tx.plan.finalization_writes.find((f) => f.symbol === "FINALIZE_RUN")!;
  finalize(w, tx, { fin: { replaceFields: { FINALIZE_RUN: { ...finalizeRun.fields, "Verified Mutation Count": 0 } } } });
  const r = await final(w, tx);
  assert.equal(r.code, "HOLD_RUN_COUNT_MISMATCH", JSON.stringify(r));
  await noFinal(w, tx);
});

test("PT-FINAL-008: State/Manifest-last must be provable — early or missing state write ⇒ HOLD_STATE_LAST_NOT_PROVEN", async () => {
  const w1 = buildResumeWorld();
  const a = await throughTarget(w1);
  finalize(w1, a, { stateFirst: true });
  const r1 = await final(w1, a);
  assert.equal(r1.code, "HOLD_STATE_LAST_NOT_PROVEN", JSON.stringify(r1));
  assert.match((r1 as { evidence: readonly string[] }).evidence.join("\n"), /came later/);
  await noFinal(w1, a);
  const w2 = buildResumeWorld();
  const b = await throughTarget(w2);
  finalize(w2, b, { skipState: true });
  const r2 = await final(w2, b);
  assert.equal(r2.code, "HOLD_STATE_LAST_NOT_PROVEN");
  assert.match((r2 as { evidence: readonly string[] }).evidence.join("\n"), /state-last write is absent/);
  await noFinal(w2, b);
});

test("PT-FINAL-009: concurrent incompatible Manifest/OS State change ⇒ HOLD_FINAL_RUNTIME_CONFLICT", async () => {
  const w = buildResumeWorld();
  const tx = await throughTarget(w);
  finalize(w, tx);
  // Another actor re-points the Manifest at a different Run after our state-last write.
  mutatePage(w, META_ID.manifest, { "Last Run Ref": `page:${R.run1}` }, T.later);
  const r = await final(w, tx);
  assert.equal(r.code, "HOLD_FINAL_RUNTIME_CONFLICT", JSON.stringify(r));
  await noFinal(w, tx);
  const w2 = buildResumeWorld();
  const b = await throughTarget(w2);
  finalize(w2, b);
  mutatePage(w2, META_ID.manifest, { "Recovery Required": true }, T.later);
  const r2 = await final(w2, b);
  assert.equal(r2.code, "HOLD_FINAL_RUNTIME_CONFLICT");
  await noFinal(w2, b);
});

test("PT-FINAL-010: governing version adopted mid-transaction ⇒ HOLD_FINAL_VERSION_CONFLICT; never reinterpreted", async () => {
  const w = buildResumeWorld();
  const tx = await throughTarget(w);
  finalize(w, tx);
  w.deps.adapters.metaRuntime.register(MV.specB, metaSpecAdapter(MV.specB, [MV.schema], META_GRAMMAR));
  w.map.set(`children:${META_ID.specRoot}`, { results: specRootChildren({ spec: MV.specB }), has_more: false, next_cursor: null });
  const r = await final(w, tx);
  assert.equal(r.code, "HOLD_FINAL_VERSION_CONFLICT", JSON.stringify(r));
  assert.match((r as { evidence: readonly string[] }).evidence.join("\n"), /not reinterpreted/);
  await noFinal(w, tx, "HOLD");
});

test("PT-FINAL-011: a gate transition the plan did not derive cannot pass FINAL", async () => {
  // a) the writer flips the gate's control-owned Status during finalization.
  const w = buildResumeWorld();
  const tx = await throughTarget(w);
  finalize(w, tx);
  mutatePage(w, R.gateM1, { Status: "PASS" }, T.fin);
  mutatePage(w, META_ID.manifest, {}, T.later); // state still last
  const r = await final(w, tx);
  assert.equal(r.code, "HOLD_FINAL_GATE_INVALID", JSON.stringify(r));
  await noFinal(w, tx, "HOLD");
  // b) the Run narrates a different observed gate than expected.
  const w2 = buildResumeWorld();
  const b = await throughTarget(w2);
  const finalizeRun = b.plan.finalization_writes.find((f) => f.symbol === "FINALIZE_RUN")!;
  finalize(w2, b, { fin: { replaceFields: { FINALIZE_RUN: { ...finalizeRun.fields, "Gate After Observed": "T9" } } } });
  const r2 = await final(w2, b);
  assert.equal(r2.code, "HOLD_FINAL_GATE_INVALID");
  await noFinal(w2, b);
});

test("PT-FINAL-012: repeated FINAL after success returns the stored terminal result; nothing new is created", async () => {
  const w = buildResumeWorld();
  const tx = await throughTarget(w);
  finalize(w, tx);
  const first = (await final(w, tx)) as Extract<Envelope, { status: "OK" }>;
  assert.equal(first.code, "TRANSACTION_VERIFIED");
  const eventsBefore = (await w.deps.store.events.list({ plan_id: tx.plan.plan_id })).length;
  const again = (await final(w, tx)) as Extract<Envelope, { status: "OK" }>;
  assert.equal(again.code, "TRANSACTION_VERIFIED");
  assert.equal((again.result as { final_receipt_id: string }).final_receipt_id, (first.result as { final_receipt_id: string }).final_receipt_id);
  assert.equal((again.result as { repeated: boolean }).repeated, true);
  assert.equal((await w.deps.store.receipts.findByPlan(tx.plan.plan_id, "FINAL")).length, 1);
  assert.equal((await w.deps.store.events.list({ plan_id: tx.plan.plan_id })).length, eventsBefore, "no new durable effect or audit event");
  // TARGET after FINAL is a replay, not a fresh verification.
  const t = await dispatch("os_verify", { binding_handle: tx.h, plan_id: tx.plan.plan_id, phase: "TARGET" }, ctx, w.deps);
  assert.equal(t.code, "HOLD_PLAN_REPLAY_INVALID");
});
