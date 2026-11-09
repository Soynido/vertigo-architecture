/**
 * PV0-012 — os_verify(TARGET): PT-TARGET-001..010 (PG4), plus the success path and receipt semantics.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../../src/tools/handlers.ts";
import { toolInputSchemas } from "../../src/tools/surface.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import type { Plan } from "../../src/plans/store.ts";
import { resolveInstruction } from "../../src/transactions/write.ts";
import { handleOf, OWNER, T0, at } from "./binding-fixtures.ts";
import { buildResumeWorld, gateRow, R, SALES_EXT_DS, SCHEMAS, type ResumeWorld } from "./resume-fixtures.ts";
import { ID as META_ID } from "./meta-fixtures.ts";
import { executeWrites, mutatePage, rowsOf } from "./target-fixtures.ts";

const ctx = { principal_id: OWNER.principal_id, now: T0 };
const gateIntent = { action_class: "COMMIT", summary: "set the next frame question", mutations: [{ logical_resource_key: "META:GATES", operation: "UPDATE" as const, record_selector: { natural_key: "T1" }, desired_changes: { "Next Question": "What is the offer?" } }] };
type OkResult = { plan_id: string; target_receipt_id: string; repeated: boolean; run_ref: string; targets: Array<{ target_ref: string; observed: Record<string, string> }>; finalization_actions?: unknown; state_last_action?: unknown };

async function prepared(w: ResumeWorld, lane: "META" | "SALES" = "META", intent: unknown = gateIntent): Promise<{ h: string; plan: Plan }> {
  const h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane }, ctx, w.deps));
  const r = await dispatch("os_prepare", { binding_handle: h, intent }, ctx, w.deps);
  assert.equal(r.code, "PLAN_PREPARED", JSON.stringify(r));
  const plan = (await w.deps.store.plans.get(((r as Extract<Envelope, { status: "OK" }>).result as { plan_id: string }).plan_id))!;
  return { h, plan };
}
const verify = (w: ResumeWorld, h: string, planId: string, now = T0) => dispatch("os_verify", { binding_handle: h, plan_id: planId, phase: "TARGET" }, { principal_id: OWNER.principal_id, now }, w.deps);
async function noReceipt(w: ResumeWorld, planId: string) {
  assert.deepEqual(await w.deps.store.receipts.findByPlan(planId, "TARGET"), [], "no target receipt");
  assert.equal((await w.deps.store.plans.get(planId))!.plan_state, "AWAITING_STAGE1_WRITES");
}

test("os_verify(TARGET) success: independent readback of Run, ledger and target; one opaque receipt; finalization + state-last bound to observed ids", async () => {
  const w = buildResumeWorld();
  const { h, plan } = await prepared(w);
  const created = executeWrites(w, plan.stage1_writes, plan.plan_id);
  const r = await verify(w, h, plan.plan_id);
  assert.equal(r.code, "TARGET_VERIFIED", JSON.stringify(r));
  const res = (r as Extract<Envelope, { status: "OK" }>).result as OkResult;
  assert.equal(res.repeated, false);
  assert.equal(res.run_ref, created["OPEN_RUN"]);
  assert.equal(res.targets[0]!.target_ref, R.gateM1);
  assert.deepEqual(res.targets[0]!.observed, { "Next Question": "What is the offer?" });
  const receipt = (await w.deps.store.receipts.get(res.target_receipt_id))!;
  assert.equal(receipt.type, "TARGET");
  assert.equal(receipt.status, "VALID");
  assert.equal(receipt.principal_id, OWNER.principal_id);
  assert.equal(receipt.plan_id, plan.plan_id);
  assert.equal(receipt.runtime_generation, plan.runtime_generation);
  assert.equal(receipt.expires_at!.getTime() - T0.getTime(), 10 * 60_000, "server TTL 10 min");
  assert.equal(Buffer.from(res.target_receipt_id, "base64url").length, 24, "opaque receipt id");
  assert.equal((await w.deps.store.plans.get(plan.plan_id))!.plan_state, "TARGET_VERIFIED");
  // Same stored instructions and proof obligations; only the strict backend resolves them.
  const context = { created, target_receipt_id: res.target_receipt_id, now: T0 };
  const fin = plan.finalization_writes.map((wi) => resolveInstruction(wi, context));
  assert.ok(fin.every((r) => r.ok));
  assert.deepEqual(plan.finalization_writes.map((wi) => wi.purpose), ["LEDGER_VERIFIED", "FINALIZE_RUN"]);
  assert.equal(fin[0]!.ok && fin[0]!.instruction.target_id, created["LEDGER_0"]);
  assert.equal(fin[0]!.ok && fin[0]!.instruction.fields["Target Receipt ID"], res.target_receipt_id);
  assert.equal(fin[1]!.ok && fin[1]!.instruction.target_id, created["OPEN_RUN"]);
  const last = resolveInstruction(plan.state_last_write, context);
  assert.ok(last.ok);
  assert.equal(last.instruction.target_id, META_ID.manifest);
  assert.equal(last.instruction.fields["Last Run Ref"], `page:${created["OPEN_RUN"]}`);
  assert.ok(plan.state_last_write.ordinal > plan.finalization_writes.at(-1)!.ordinal);
  assert.equal(res.finalization_actions, undefined);
  assert.equal(res.state_last_action, undefined);
  assert.equal(r.next.native_actions_required, undefined);
  assert.equal(r.next.permitted_tool_call, undefined, "TARGET proof does not grant an implicit finalization tool call");
  assert.match(r.next.safe_action, /guarded backend executor/);
  // The receipt is issued by the backend audit trail, not by the caller.
  assert.ok((await w.deps.store.events.list({ plan_id: plan.plan_id })).some((e) => e.event_type === "TARGET_RECEIPT_ISSUED"));
});

test("PT-TARGET-001: target write absent ⇒ HOLD_TARGET_NOT_WRITTEN, no receipt (Run and ledger alone prove nothing)", async () => {
  const w = buildResumeWorld();
  const { h, plan } = await prepared(w);
  executeWrites(w, plan.stage1_writes, plan.plan_id, { skip: ["TARGET_0"] });
  const r = await verify(w, h, plan.plan_id);
  assert.equal(r.code, "HOLD_TARGET_NOT_WRITTEN", JSON.stringify(r));
  assert.ok((r as { evidence: readonly string[] }).evidence.some((e) => e.includes("Next Question") && e.includes("What do you sell?")));
  await noReceipt(w, plan.plan_id);
});

test("PT-TARGET-002: wrong value ⇒ HOLD_TARGET_WRONG_VALUE with the observed mismatch as evidence; no receipt", async () => {
  const w = buildResumeWorld();
  const { h, plan } = await prepared(w);
  executeWrites(w, plan.stage1_writes, plan.plan_id, { replaceFields: { TARGET_0: { "Next Question": "What is the price?" } } });
  const r = await verify(w, h, plan.plan_id);
  assert.equal(r.code, "HOLD_TARGET_WRONG_VALUE");
  const ev = (r as { evidence: readonly string[] }).evidence.join("\n");
  assert.match(ev, /observed "What is the price\?", expected "What is the offer\?"/);
  await noReceipt(w, plan.plan_id);
});

test("PT-TARGET-003: field substitution (B written instead of planned A) ⇒ HOLD; A still unwritten", async () => {
  const w = buildResumeWorld();
  const { h, plan } = await prepared(w);
  executeWrites(w, plan.stage1_writes, plan.plan_id, { replaceFields: { TARGET_0: { "Next Action": "What is the offer?" } } });
  const r = await verify(w, h, plan.plan_id);
  assert.equal(r.code, "HOLD_TARGET_NOT_WRITTEN");
  assert.ok((r as { evidence: readonly string[] }).evidence.some((e) => e.startsWith("Next Question:")));
  await noReceipt(w, plan.plan_id);
});

test("PT-TARGET-004: expected values applied to the wrong record ⇒ planned record A fails; B never satisfies the plan", async () => {
  const w = buildResumeWorld();
  const other = R.gateM1.replace(/.$/, "e");
  w.setMetaGates([gateRow({ id: R.gateM1, key: "T1", status: "OPEN", nextQuestion: "What do you sell?" }), gateRow({ id: other, key: "T2", status: "OPEN", nextQuestion: "Who buys?" })]);
  const { h, plan } = await prepared(w);
  executeWrites(w, plan.stage1_writes, plan.plan_id, { redirect: { TARGET_0: other } });
  const r = await verify(w, h, plan.plan_id);
  assert.equal(r.code, "HOLD_TARGET_NOT_WRITTEN");
  assert.ok((r as { evidence: readonly string[] }).evidence.some((e) => e.includes(`planned record: ${R.gateM1}`)));
  await noReceipt(w, plan.plan_id);
});

test("PT-TARGET-005: compared field changed by another actor after prepare ⇒ HOLD; baseline is never used as success", async () => {
  const w = buildResumeWorld();
  const { h, plan } = await prepared(w);
  mutatePage(w, R.gateM1, { "Next Question": "Conflicting edit?" });
  // Writer executes Run + ledger but leaves the conflicting value in place.
  executeWrites(w, plan.stage1_writes, plan.plan_id, { skip: ["TARGET_0"] });
  const r1 = await verify(w, h, plan.plan_id);
  assert.equal(r1.code, "HOLD_TARGET_WRONG_VALUE");
  assert.match((r1 as { evidence: readonly string[] }).evidence.join("\n"), /changed by another actor/);
  await noReceipt(w, plan.plan_id);
  // A page whose compared field merely equals the stale baseline is NOT_WRITTEN, never verified.
  mutatePage(w, R.gateM1, { "Next Question": "What do you sell?" });
  const r2 = await verify(w, h, plan.plan_id);
  assert.equal(r2.code, "HOLD_TARGET_NOT_WRITTEN");
  await noReceipt(w, plan.plan_id);
});

test("PT-TARGET-006: CREATE located by data source + natural key; duplicates ⇒ HOLD_TARGET_AMBIGUOUS and no receipt", async () => {
  const createIntent = { action_class: "COMMIT", summary: "queue an intent", mutations: [{ logical_resource_key: "SALES:EXTERNAL_ACTIONS", operation: "CREATE" as const, record_selector: { natural_key: "ak-new-1" }, desired_changes: { Recipient: "someone@example.invalid" } }] };
  const w = buildResumeWorld();
  const { h, plan } = await prepared(w, "SALES", createIntent);
  assert.equal(plan.operations[0]!.physical_target_ref, undefined, "CREATE has no physical target at prepare time");
  executeWrites(w, plan.stage1_writes, plan.plan_id, { duplicate: ["TARGET_0"] });
  assert.equal(rowsOf(w, SALES_EXT_DS("rep-a")).filter((p) => (p.properties["Action Key"] as unknown as { rich_text: Array<{ plain_text: string }> }).rich_text[0]?.plain_text === "ak-new-1").length, 2);
  const r = await verify(w, h, plan.plan_id);
  assert.equal(r.code, "HOLD_TARGET_AMBIGUOUS", JSON.stringify(r));
  await noReceipt(w, plan.plan_id);
  // Single CREATE verifies and the created id is bound.
  const w2 = buildResumeWorld();
  const p2 = await prepared(w2, "SALES", createIntent);
  const created = executeWrites(w2, p2.plan.stage1_writes, p2.plan.plan_id);
  const ok = await verify(w2, p2.h, p2.plan.plan_id);
  assert.equal(ok.code, "TARGET_VERIFIED", JSON.stringify(ok));
  const res = (ok as Extract<Envelope, { status: "OK" }>).result as OkResult;
  assert.equal(res.targets[0]!.target_ref, created["TARGET_0"]);
  assert.deepEqual(res.targets[0]!.observed, { "Action Key": "ak-new-1", "Effect Status": "PREPARED", Recipient: "someone@example.invalid", "Record Type": "INTENT" }, "backend-injected intent defaults are planned and verified like any field");
  assert.equal(res.state_last_action, undefined);
  assert.equal(p2.plan.state_last_write.target_ref, R.salesStateRow);
});

test("PT-TARGET-007: expired plan, rotated runtime or foreign binding ⇒ HOLD, no receipt", async () => {
  const w = buildResumeWorld();
  const { h, plan } = await prepared(w);
  executeWrites(w, plan.stage1_writes, plan.plan_id);
  const late = await verify(w, h, plan.plan_id, new Date(T0.getTime() + 16 * 60_000));
  assert.equal(late.code, "HOLD_PLAN_EXPIRED");
  assert.equal((late.observations as { recovery_possible: boolean }).recovery_possible, true);
  assert.deepEqual(await w.deps.store.receipts.findByPlan(plan.plan_id, "TARGET"), []);
  assert.equal((await w.deps.store.plans.get(plan.plan_id))!.plan_state, "EXPIRED");

  const w2 = buildResumeWorld();
  const p2 = await prepared(w2);
  executeWrites(w2, p2.plan.stage1_writes, p2.plan.plan_id);
  w2.rotateMeta({ pointerGeneration: "2" });
  const rot = await verify(w2, p2.h, p2.plan.plan_id);
  assert.equal(rot.code, "HOLD_BINDING_STALE_RUNTIME_ROTATED");
  assert.deepEqual(await w2.deps.store.receipts.findByPlan(p2.plan.plan_id, "TARGET"), []);

  const w3 = buildResumeWorld();
  const p3 = await prepared(w3);
  executeWrites(w3, p3.plan.stage1_writes, p3.plan.plan_id);
  const otherHandle = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w3.deps));
  const foreign = await verify(w3, otherHandle, p3.plan.plan_id);
  assert.equal(foreign.code, "HOLD_PLAN_BINDING_MISMATCH");
  assert.deepEqual(await w3.deps.store.receipts.findByPlan(p3.plan.plan_id, "TARGET"), []);
});

test("PT-TARGET-008: the os_verify schema carries no observation or verdict; caller-supplied evidence is rejected", async () => {
  const w = buildResumeWorld();
  const { h, plan } = await prepared(w);
  assert.deepEqual(Object.keys(toolInputSchemas.os_verify.shape).sort(), ["binding_handle", "phase", "plan_id"]);
  for (const extra of [{ observed_values: { "Next Question": "What is the offer?" } }, { verified: true }, { verdict: "PASS" }, { observations: {} }, { target_receipt_id: "x" }, { run_ref: "x" }, { evidence: ["fine"] }]) {
    const r = await dispatch("os_verify", { binding_handle: h, plan_id: plan.plan_id, phase: "TARGET", ...extra }, ctx, w.deps);
    assert.equal(r.code, "ERROR_INVALID_ARGUMENT", JSON.stringify(extra));
  }
  await noReceipt(w, plan.plan_id);
  // And the honest call still reads Notion: nothing was written, so it HOLDs.
  const r = await verify(w, h, plan.plan_id);
  assert.equal(r.code, "HOLD_RUN_NOT_OPENED");
});

test("PT-TARGET-009: Run/ledger PREPARE and harness linkage are required; a correct target value alone never gets a receipt", async () => {
  // No Run opened.
  const w1 = buildResumeWorld();
  const p1 = await prepared(w1);
  executeWrites(w1, p1.plan.stage1_writes, p1.plan.plan_id, { skip: ["OPEN_RUN"] });
  const r1 = await verify(w1, p1.h, p1.plan.plan_id);
  assert.equal(r1.code, "HOLD_RUN_NOT_OPENED");
  await noReceipt(w1, p1.plan.plan_id);
  // No ledger PREPARE.
  const w2 = buildResumeWorld();
  const p2 = await prepared(w2);
  executeWrites(w2, p2.plan.stage1_writes, p2.plan.plan_id, { skip: ["LEDGER_0"] });
  const r2 = await verify(w2, p2.h, p2.plan.plan_id);
  assert.equal(r2.code, "HOLD_LEDGER_PREPARE_MISSING");
  await noReceipt(w2, p2.plan.plan_id);
  // Ledger row pointing at the wrong Run.
  const w3 = buildResumeWorld();
  const p3 = await prepared(w3);
  const prep = p3.plan.stage1_writes.find((s) => s.symbol === "LEDGER_0")!;
  executeWrites(w3, p3.plan.stage1_writes, p3.plan.plan_id, { replaceFields: { LEDGER_0: { ...prep.fields, "Run Ref": `$created:NOPE` } } });
  const r3 = await verify(w3, p3.h, p3.plan.plan_id);
  assert.equal(r3.code, "HOLD_LEDGER_PREPARE_MISSING");
  assert.match((r3 as { evidence: readonly string[] }).evidence.join("\n"), /not the Run opened for this plan/);
  await noReceipt(w3, p3.plan.plan_id);
  // Ledger schema without harness linkage ⇒ schema HOLD, even with a perfect target value.
  const w4 = buildResumeWorld();
  const p4 = await prepared(w4);
  executeWrites(w4, p4.plan.stage1_writes, p4.plan.plan_id);
  const { ["Harness Plan ID"]: _drop, ...rest } = SCHEMAS.metaLedger.properties as Record<string, unknown>;
  void _drop;
  w4.map.set(`data_source:${R.metaLedgerDs}`, { properties: rest });
  const r4 = await verify(w4, p4.h, p4.plan.plan_id);
  assert.equal(r4.code, "HOLD_SCHEMA_MISMATCH");
  assert.match((r4 as { evidence: readonly string[] }).evidence.join("\n"), /MUTATION LEDGER lacks "Harness Plan ID" \(rich_text\)/);
  await noReceipt(w4, p4.plan.plan_id);
});

test("PT-TARGET-010: repeated TARGET is idempotent (same receipt); after drift it HOLDs, invalidates the receipt and never issues another", async () => {
  const w = buildResumeWorld();
  const { h, plan } = await prepared(w);
  executeWrites(w, plan.stage1_writes, plan.plan_id);
  const first = (await verify(w, h, plan.plan_id)) as Extract<Envelope, { status: "OK" }>;
  const again = (await verify(w, h, plan.plan_id)) as Extract<Envelope, { status: "OK" }>;
  assert.equal(again.code, "TARGET_VERIFIED");
  assert.equal((again.result as OkResult).target_receipt_id, (first.result as OkResult).target_receipt_id);
  assert.equal((again.result as OkResult).repeated, true);
  assert.equal((await w.deps.store.receipts.findByPlan(plan.plan_id, "TARGET")).length, 1, "receipts never multiply");
  // Drift.
  mutatePage(w, R.gateM1, { "Next Question": "Drifted?" }, "2030-01-01T02:00:00.000Z");
  const drift = await verify(w, h, plan.plan_id);
  assert.equal(drift.code, "HOLD_TARGET_WRONG_VALUE");
  assert.ok((drift as { evidence: readonly string[] }).evidence.some((e) => e.includes("invalidated")));
  const receipts = await w.deps.store.receipts.findByPlan(plan.plan_id, "TARGET");
  assert.deepEqual(receipts.map((r) => r.status), ["INVALID"]);
  assert.equal((await w.deps.store.plans.get(plan.plan_id))!.plan_state, "HOLD");
  const after = await verify(w, h, plan.plan_id);
  assert.equal(after.code, "HOLD_PLAN_REPLAY_INVALID");
  assert.equal((await w.deps.store.receipts.findByPlan(plan.plan_id, "TARGET")).length, 1);
  // FINAL cannot proceed without a valid target verification.
  const fin = await dispatch("os_verify", { binding_handle: h, plan_id: plan.plan_id, phase: "FINAL" }, ctx, w.deps);
  assert.equal(fin.code, "HOLD_FINAL_WITHOUT_TARGET_VERIFICATION");
});
