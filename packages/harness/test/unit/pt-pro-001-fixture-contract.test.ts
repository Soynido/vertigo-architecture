/**
 * PT-PRO-001 FIXTURE CONTRACT v2 (PV0-020D): the submitted F1 answer must be persisted in the canonical resource
 * META:INPUTS (row selected by Input Key = F1:PRIMARY_OFFER, field Answer = exact submitted string) and proven by
 * TARGET and FINAL. A Gate-only mutation never satisfies answer persistence (PT-PRO-002, blocking).
 * A exact answer → TRANSACTION_VERIFIED; B wrong Answer → TARGET reject; C missing Answer → reject; D wrong Input Key →
 * reject; E answer changed after TARGET → FINAL reject; F repeated identical transaction → idempotent; G META:INPUTS
 * unavailable → HOLD, never another target; H SALES binding → HOLD_CROSS_LANE.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../../src/tools/handlers.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import type { Plan } from "../../src/plans/store.ts";
import { handleOf, OWNER, T0 } from "./binding-fixtures.ts";
import { buildResumeWorld, R, type ResumeWorld } from "./resume-fixtures.ts";
import { executeWrites, mutatePage, type WriterOptions } from "./target-fixtures.ts";

const ctx = { principal_id: OWNER.principal_id, now: T0 };
type Ok = Extract<Envelope, { status: "OK" }>;
const ANSWER = "TEST FIXTURE — offre principale : accompagnement de prospection B2B pour studios créatifs.";
const T = { stage1: "2030-01-03T00:30:00.000Z", fin: "2030-01-03T00:31:00.000Z", state: "2030-01-03T00:32:00.000Z", later: "2030-01-03T00:33:00.000Z" };
const answerIntent = (answer = ANSWER, inputKey = "F1:PRIMARY_OFFER", operation: "CREATE" | "UPSERT" = "UPSERT") => ({ action_class: "COMMIT", summary: "persist fixture F1 answer", mutations: [{ logical_resource_key: "META:INPUTS", operation, record_selector: { natural_key: inputKey }, desired_changes: { Input: `F1 — offre principale`, "Gate Key": "F1", Question: "Quelle est l'offre principale que vous vendez, en une phrase ?", Answer: answer } }] });

async function prepared(w: ResumeWorld, intent: unknown = answerIntent()) {
  const h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps));
  const p = await dispatch("os_prepare", { binding_handle: h, intent }, ctx, w.deps);
  return { h, p, plan: p.status === "OK" ? (await w.deps.store.plans.get((p as Ok).result["plan_id"] as string)) as Plan : undefined };
}
async function target(w: ResumeWorld, h: string, plan: Plan, opts: WriterOptions = {}) {
  const created = executeWrites(w, plan.stage1_writes, plan.plan_id, { now: T.stage1, ...opts });
  const t = await dispatch("os_verify", { binding_handle: h, plan_id: plan.plan_id, phase: "TARGET" }, ctx, w.deps);
  return { t, created, symbols: ((t.observations["symbols"] as Record<string, string>) ?? created) };
}
async function finalize(w: ResumeWorld, h: string, plan: Plan, receipt: string, symbols: Record<string, string>, at: { fin: string; state: string } = { fin: T.fin, state: T.state }) {
  executeWrites(w, plan.finalization_writes, plan.plan_id, { ...({ now: at.fin }), created: symbols, target_receipt_id: receipt });
  executeWrites(w, [plan.state_last_write], plan.plan_id, { ...({ now: at.state }), created: symbols, target_receipt_id: receipt });
  return dispatch("os_verify", { binding_handle: h, plan_id: plan.plan_id, phase: "FINAL" }, ctx, w.deps);
}
const inputsRows = (w: ResumeWorld) => ((w.map.get(`query:${R.metaInputsDs}`) as { results: Array<{ id: string; properties: Record<string, { rich_text?: Array<{ plain_text: string }> }> }> }).results);
const answerOf = (w: ResumeWorld, id: string) => (w.map.get(`page:${id}`) as { properties: Record<string, { rich_text?: Array<{ plain_text: string }> }> }).properties["Answer"]?.rich_text?.map((r) => r.plain_text).join("");

test("A — exact submitted answer persisted in META:INPUTS is proven by TARGET and FINAL", async () => {
  const w = buildResumeWorld();
  const { h, p, plan } = await prepared(w);
  assert.equal(p.code, "PLAN_PREPARED", JSON.stringify(p));
  const op = plan!.operations[0]!;
  assert.equal(op.logical_resource_key, "META:INPUTS"); assert.equal(op.natural_key, "F1:PRIMARY_OFFER"); assert.equal(op.natural_key_property, "Input Key");
  assert.equal(op.expected_values["Answer"], ANSWER); assert.equal(op.expected_values["State"], "SUBMITTED"); assert.equal(op.expected_values["Source"], "USER_CONFIRMED_FIXTURE");
  const prep = plan!.stage1_writes.find((x) => x.purpose === "PREPARE_LEDGER")!;
  const write = plan!.stage1_writes.find((x) => x.purpose === "WRITE_TARGET")!;
  const written = plan!.stage1_writes.find((x) => x.purpose === "LEDGER_WRITTEN")!;
  assert.ok(!("Target Ref" in prep.fields), "PREPARE must not reference a CREATE target that does not exist yet");
  assert.equal(written.fields["Target Ref"], `$created:${write.symbol}`, "the journal acquires Target Ref only after target creation");
  const { t, created, symbols } = await target(w, h, plan!);
  assert.equal(t.code, "TARGET_VERIFIED", JSON.stringify(t));
  const row = inputsRows(w).find((r) => r.properties["Input Key"]?.rich_text?.[0]?.plain_text === "F1:PRIMARY_OFFER");
  assert.ok(row, "one META — INPUTS row with Input Key F1:PRIMARY_OFFER exists");
  assert.equal(answerOf(w, row!.id), ANSWER, "the exact submitted string is durable");
  const f = await finalize(w, h, plan!, (t as Ok).result["target_receipt_id"] as string, symbols);
  assert.equal(f.code, "TRANSACTION_VERIFIED", JSON.stringify(f));
  assert.equal(f.say, "C'est enregistré et vérifié dans Notion.");
  void created;
});

test("PT-PRO-002 — a Gate-only mutation never satisfies F1 answer persistence: the answer write skipped ⇒ TARGET HOLD", async () => {
  const w = buildResumeWorld();
  const { h, plan } = await prepared(w);
  // Native writer opens the Run, prepares the ledger, writes ledger WRITTEN, even edits the gate — but never the answer.
  const skip = plan!.stage1_writes.filter((x) => x.purpose === "WRITE_TARGET").map((x) => x.symbol);
  mutatePage(w, R.gateM1, { "Evidence Refs": { type: "rich_text", rich_text: [{ type: "text", plain_text: "PT-PRO-001 replay evidence", annotations: {} }] } }, T.stage1);
  const { t } = await target(w, h, plan!, { skip });
  assert.equal(t.status, "HOLD", JSON.stringify(t));
  assert.equal(t.code, "HOLD_TARGET_NOT_WRITTEN");
  assert.equal(inputsRows(w).length, 0, "no answer row exists");
  assert.equal((await dispatch("os_verify", { binding_handle: h, plan_id: plan!.plan_id, phase: "FINAL" }, ctx, w.deps)).status, "HOLD", "FINAL cannot bless it either");
});

test("B/C/D — wrong Answer, missing Answer, wrong Input Key are rejected at TARGET", async () => {
  const w = buildResumeWorld();
  const { h, plan } = await prepared(w);
  const sym = plan!.stage1_writes.find((x) => x.purpose === "WRITE_TARGET")!.symbol;
  const wt = plan!.stage1_writes.find((x) => x.purpose === "WRITE_TARGET")!;
  const b = await target(w, h, plan!, { replaceFields: { [sym]: { ...wt.fields, Answer: "TEST FIXTURE — une autre réponse" } } });
  assert.equal(b.t.code, "HOLD_TARGET_WRONG_VALUE", JSON.stringify(b.t));
  const w2 = buildResumeWorld(); const p2 = await prepared(w2); const wt2 = p2.plan!.stage1_writes.find((x) => x.purpose === "WRITE_TARGET")!;
  const { Answer: _dropped, ...withoutAnswer } = wt2.fields as Record<string, unknown>; void _dropped;
  const c = await target(w2, p2.h, p2.plan!, { replaceFields: { [wt2.symbol]: withoutAnswer } });
  assert.equal(c.t.code, "HOLD_TARGET_WRONG_FIELD", JSON.stringify(c.t));
  const w3 = buildResumeWorld(); const p3 = await prepared(w3); const wt3 = p3.plan!.stage1_writes.find((x) => x.purpose === "WRITE_TARGET")!;
  const d = await target(w3, p3.h, p3.plan!, { replaceFields: { [wt3.symbol]: { ...wt3.fields, "Input Key": "F1:OTHER" } } });
  assert.match(d.t.code, /^HOLD_TARGET_(WRONG_VALUE|NOT_WRITTEN|WRONG_RECORD)$/, JSON.stringify(d.t));
  for (const x of [b.t, c.t, d.t]) assert.equal(x.status, "HOLD");
});

test("E — answer changed after TARGET and before FINAL ⇒ FINAL rejects", async () => {
  const w = buildResumeWorld();
  const { h, plan } = await prepared(w);
  const { t, symbols } = await target(w, h, plan!);
  assert.equal(t.code, "TARGET_VERIFIED");
  const row = inputsRows(w)[0]!;
  mutatePage(w, row.id, { Answer: { type: "rich_text", rich_text: [{ type: "text", plain_text: "TEST FIXTURE — réponse altérée", annotations: {} }] } }, T.later);
  const f = await finalize(w, h, plan!, (t as Ok).result["target_receipt_id"] as string, symbols);
  assert.equal(f.status, "HOLD", JSON.stringify(f));
  assert.equal(f.code, "HOLD_TARGET_CHANGED_AFTER_TARGET_VERIFY");
});

test("F — a repeated identical transaction is idempotent (UPSERT updates the same row to the same value)", async () => {
  const w = buildResumeWorld();
  const first = await prepared(w);
  const t1 = await target(w, first.h, first.plan!);
  assert.equal((await finalize(w, first.h, first.plan!, (t1.t as Ok).result["target_receipt_id"] as string, t1.symbols)).code, "TRANSACTION_VERIFIED");
  const second = await prepared(w);
  assert.equal(second.p.code, "PLAN_PREPARED", JSON.stringify(second.p));
  assert.equal(second.plan!.operations[0]!.operation, "UPDATE", "existing row selected by Input Key");
  const t2 = await target(w, second.h, second.plan!, { now: T.later });
  assert.equal(t2.t.code, "TARGET_VERIFIED", JSON.stringify(t2.t));
  assert.equal(inputsRows(w).length, 1, "still exactly one F1:PRIMARY_OFFER row");
  assert.equal((await finalize(w, second.h, second.plan!, (t2.t as Ok).result["target_receipt_id"] as string, t2.symbols, { fin: "2030-01-03T00:34:00.000Z", state: "2030-01-03T00:35:00.000Z" })).code, "TRANSACTION_VERIFIED");
  assert.equal(inputsRows(w).length, 1);
  assert.equal(answerOf(w, inputsRows(w)[0]!.id), ANSWER);
  // A CREATE of the same key, by contrast, is refused as a duplicate.
  const dup = await prepared(w, answerIntent(ANSWER, "F1:PRIMARY_OFFER", "CREATE"));
  assert.equal(dup.p.code, "HOLD_DUPLICATE");
});

test("G/H — META:INPUTS unavailable ⇒ HOLD, never another target; SALES cannot address META:INPUTS", async () => {
  const w = buildResumeWorld();
  w.removeMetaInputs();
  const { p } = await prepared(w);
  assert.equal(p.code, "HOLD_REQUIRED_RESOURCE_MISSING", JSON.stringify(p));
  assert.equal(await w.deps.store.plans.findActive("VERTIGO", "META", (p.binding as { runtime_generation: string }).runtime_generation).then((x) => x.length), 0, "no plan, no improvised target");
  const w2 = buildResumeWorld();
  const hs = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w2.deps));
  const s = await dispatch("os_prepare", { binding_handle: hs, intent: answerIntent() }, ctx, w2.deps);
  assert.equal(s.code, "HOLD_CROSS_LANE", JSON.stringify(s));
});
