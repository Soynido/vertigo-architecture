/** W4.6R: equivalent instants, inclusive windows, malformed chronology fails closed. No sends. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SnapshotCompetentSource, inboundSincePrepared, reconcileIntent, reconcileManualSends, routeExternalAction, type IntentView, type MailboxMessage, type CompetentSource } from "../../src/effects/gmail.ts";
import { dispatch, resolveRuntimeFor } from "../../src/tools/handlers.ts";
import { intentViewFromPlan } from "../../src/effects/adapter.ts";
import { handleOf, OWNER } from "./binding-fixtures.ts";
import { buildResumeWorld, R } from "./resume-fixtures.ts";
import { transact } from "../support/transact.ts";

const mailbox = "rep-a@example.invalid", recipient = "prospect@example.invalid";
const intent: IntentView = { intent_ref: "fixture", action_key: "temporal", mailbox_identity: mailbox, recipient,
  prepared_at: "2030-01-03T00:33:00Z", window_end: "2030-01-03T02:00:00Z", thread_ref: "thread", effect_status: "PREPARED" };
const message = (date: string, extra: Partial<MailboxMessage> = {}): MailboxMessage => ({ message_id: "m", thread_id: "thread", from: recipient, to: [mailbox], subject: "Re: temporal", date, ...extra });
const source = (date: string, extra: Partial<MailboxMessage> = {}) => new SnapshotCompetentSource(mailbox, [message(date, extra)]);
const port = (messages: readonly MailboxMessage[]): CompetentSource => ({ identity: async () => mailbox, searchSent: async () => messages, thread: async () => messages });
const query = { recipient, since: intent.prepared_at, until: intent.window_end, action_key: intent.action_key };
const malformed = ["", "garbage", "2030-01-03T01:00:00", "2030-02-30T01:00:00Z", "2030-01-03T24:00:00Z", "2030-01-03T01:60:00Z", "2030-01-03T01:00:60Z", "2030-01-03T01:00:00+24:00", "2030-01-03T01:00:00.0001Z", undefined as unknown as string];

test("PT-GMAIL-017/a: UTC, offsets, equality and milliseconds use actual inclusive instants", async () => {
  for (const date of ["2030-01-03T01:00:00Z", "2030-01-02T21:00:00-04:00", "2030-01-03T01:33:00+01:00", "2030-01-03T00:33:00.001Z"])
    assert.equal((await inboundSincePrepared(intent, source(date))).inbound.length, 1, date);
  for (const date of ["2030-01-03T01:00:00+02:00", "2030-01-03T00:32:59.999Z"])
    assert.deepEqual(await inboundSincePrepared(intent, source(date)), { status: "OK", inbound: [] }, date);
});

test("PT-GMAIL-017/b: sent search includes equivalent endpoints and excludes earlier/later instants", async () => {
  for (const date of ["2030-01-02T20:33:00-04:00", "2030-01-03T04:00:00+02:00", "2030-01-02T21:00:00-04:00"])
    assert.equal((await source(date, { from: mailbox, to: [recipient] }).searchSent(query) as MailboxMessage[]).length, 1, date);
  for (const date of ["2030-01-03T01:00:00+02:00", "2030-01-02T23:00:00-04:00"])
    assert.deepEqual(await source(date, { from: mailbox, to: [recipient] }).searchSent(query), [], date);
});

test("PT-GMAIL-017/c: thread order follows chronology, not spelling", async () => {
  const src = new SnapshotCompetentSource(mailbox, [message("2030-01-02T21:00:00-04:00", { message_id: "later" }), message("2030-01-03T01:00:00+02:00", { message_id: "earlier" })]);
  assert.deepEqual((await src.thread("thread") as MailboxMessage[]).map(m => m.message_id), ["earlier", "later"]);
});

test("PT-GMAIL-017/d: malformed thread timestamps cannot become an empty or technical-safe scan", async () => {
  for (const date of malformed) {
    assert.equal(await source(date).thread("thread"), "UNAVAILABLE");
    for (const headers of [undefined, { "auto-submitted": "auto-replied" }])
      assert.deepEqual(await inboundSincePrepared(intent, port([message(date, headers ? { headers } : {})])), { status: "UNAVAILABLE", inbound: [] });
  }
});

test("PT-GMAIL-017/e: malformed/inverted windows refuse even empty ports", async () => {
  for (const [since, until] of [...malformed.map(date => [date, intent.window_end]), [intent.window_end, intent.prepared_at], [intent.prepared_at, "bad"]] as [string, string][]) {
    assert.equal(await new SnapshotCompetentSource(mailbox, []).searchSent({ ...query, since, until }), "UNAVAILABLE");
    assert.equal((await reconcileIntent({ ...intent, prepared_at: since, window_end: until }, port([]))).status, "UNAVAILABLE");
    assert.equal((await reconcileManualSends(port([]), mailbox, recipient, { since, until }, [], new Set())).status, "UNAVAILABLE");
  }
  const { thread_ref: _thread, ...unthreaded } = intent;
  assert.equal((await inboundSincePrepared({ ...unthreaded, prepared_at: "bad" }, port([]))).status, "UNAVAILABLE");
});

test("PT-GMAIL-017/f: source results with malformed/out-of-window time are not observation or absence proof", async () => {
  for (const date of [...malformed, "2030-01-03T01:00:00+02:00", "2030-01-02T23:00:00-04:00"]) {
    const src = port([message(date, { from: mailbox, to: [recipient] })]);
    assert.equal((await reconcileIntent(intent, src)).status, "UNAVAILABLE", String(date));
    assert.deepEqual(await reconcileManualSends(src, mailbox, recipient, { since: intent.prepared_at, until: intent.window_end }, [], new Set()), { status: "UNAVAILABLE", candidates: [] });
  }
  for (const loose of ["UNAVAILABLE" as const, [message("bad")]]) {
    let reads = 0;
    const src: CompetentSource = { ...port([]), searchSent: async () => ++reads === 1 ? [] : loose };
    assert.equal((await reconcileIntent(intent, src)).status, "UNAVAILABLE");
  }
});

test("PT-GMAIL-017/g: valid offset sent facts still reconcile; sender/marker classification unchanged", async () => {
  const src = source("2030-01-02T21:00:00-04:00", { from: mailbox, to: [recipient] });
  assert.equal((await reconcileIntent(intent, src)).status, "OBSERVED");
  assert.equal((await reconcileManualSends(src, mailbox, recipient, { since: intent.prepared_at, until: intent.window_end }, [intent], new Set())).candidates[0]?.disposition, "MATCHES_INTENT");
  assert.equal((await inboundSincePrepared(intent, source("2030-01-03T01:00:00Z", { from: mailbox.toUpperCase() }))).inbound.length, 0);
});

test("PT-GMAIL-017/h: real FINAL intent routing blocks offset human inbound and unknown chronology without writes", async () => {
  const w = buildResumeWorld();
  (w.map.get(`data_source:${R.salesExtDs}`) as { properties: Record<string, unknown> }).properties["Thread ID / Context"] = { type: "rich_text" };
  const ctx = { principal_id: OWNER.principal_id, now: new Date("2030-01-03T00:29:00Z") };
  const h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps));
  const tx = await transact(w, h, { action_class: "COMMIT", summary: "temporal guard", mutations: [{ logical_resource_key: "SALES:EXTERNAL_ACTIONS", operation: "CREATE", record_selector: { natural_key: "temporal" }, desired_changes: { Recipient: recipient, "Subject / Content Hash": "temporal", "Action Type": "GMAIL_SEND", "Thread ID / Context": "thread" } }] }, { ctx, verifyCtx: { ...ctx, now: new Date("2030-01-03T00:33:00Z") }, stamps: { stage1: "2030-01-03T00:30:00Z", fin: "2030-01-03T00:31:00Z", state: "2030-01-03T00:32:00Z" } });
  const principal = (await w.deps.principals.get(OWNER.principal_id))!;
  const runtime = await resolveRuntimeFor(w.deps, principal, "VERTIGO", "SALES");
  assert.equal(runtime.kind, "RESOLVED");
  if (runtime.kind !== "RESOLVED") throw new Error("fixture unresolved");
  const plan = (await w.deps.store.plans.get(tx.plan.plan_id))!;
  const view = intentViewFromPlan(runtime.runtime, plan, (await w.deps.store.receipts.get(tx.receipt))!)!;
  assert.equal(view.thread_ref, "thread");
  const before = JSON.stringify(await w.deps.store.plans.get(plan.plan_id));
  const receiptsBefore = JSON.stringify(await w.deps.store.receipts.findByPlan(plan.plan_id));
  for (const date of ["2030-01-02T21:00:00-04:00", "bad", "2030-01-03T01:00:00"]) {
    const result = await routeExternalAction(w.deps.store.receipts, { plan, intent: view, requested_action_key: view.action_key, requested_intent_ref: view.intent_ref, runtime_generation: plan.runtime_generation, mode: "EXTERNAL_ACTION_TEST", approved_test_scope: { from: mailbox, to: [recipient] }, source: source(date) });
    assert.equal(result.kind, "HOLD");
    if (result.kind !== "HOLD") throw new Error("routing unexpectedly eligible");
    assert.equal(result.code, date === "2030-01-02T21:00:00-04:00" ? "HOLD_INBOUND_BEFORE_DISPATCH" : "HOLD_EXTERNAL_SOURCE_UNAVAILABLE");
  }
  assert.equal(JSON.stringify(await w.deps.store.plans.get(plan.plan_id)), before);
  assert.equal(JSON.stringify(await w.deps.store.receipts.findByPlan(plan.plan_id)), receiptsBefore);
});
