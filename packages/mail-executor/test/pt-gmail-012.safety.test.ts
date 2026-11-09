/**
 * PT-GMAIL-012 — Fresh safety-state changes block protected send (ADVERSARIAL, blocking, PG9, PV0-019A).
 * Each T-0 safety input is falsified after planning but before the executor decision: every unsafe/ambiguous branch
 * REFUSES SEND with an explicit reason and the transport is never called. The happy path proves the send + readback.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execute } from "../src/engine.ts";
import { buildExecWorld, ID, MAILBOX, NOW, PREPARED, RECIPIENT, req, type ExecWorld } from "./executor-fixtures.ts";

async function refused(w: ExecWorld, code: string, check: string, attempt = "att-1") {
  const d = await execute(w.deps, req(attempt), NOW);
  assert.equal(d.decision, "REFUSED", JSON.stringify(d));
  assert.equal(d.code, code);
  assert.equal(d.checks.at(-1)?.name, check);
  assert.equal(d.gmail_send_called, false);
  assert.equal(w.mailbox.sends, 0, "transport never called");
  assert.ok(d.evidence.length > 0 && d.evidence.every((e) => e.length > 0), "explicit reason");
  return d;
}

test("PT-GMAIL-012/happy: all fresh checks PASS → exactly one send, then Gmail readback proves the effect", async () => {
  const w = await buildExecWorld();
  const d = await execute(w.deps, req(), NOW);
  assert.equal(d.decision, "SENT_AND_OBSERVED", JSON.stringify(d));
  assert.equal(d.gmail_send_called, true);
  assert.equal(w.mailbox.sends, 1);
  assert.equal(d.effect?.message_id, "msg-1");
  assert.equal(d.effect?.thread_id, ID.thread);
  assert.equal(d.effect?.mailbox_identity, MAILBOX);
  assert.equal(d.effect?.recipient, RECIPIENT);
  assert.deepEqual(d.checks.map((c) => c.name), ["INTENT", "VERIFIED_INTENT", "AUTHORITY", "APPROVAL", "ENROLLMENT", "SAFETY_STATE", "OWNERSHIP", "MAILBOX", "THREAD", "PRIOR_EFFECT", "OBSOLESCENCE", "CONTENT", "READBACK"]);
  assert.ok(d.checks.every((c) => c.result === "PASS"));
  const sent = w.mailbox.messages[0];
  assert.equal(sent?.headers?.["x-vertigo-action-key"], "ak-exec-0001", "the effect carries the action key for reconciliation");
  assert.equal((await w.ledger.get("ak-exec-0001"))?.state, "OBSERVED");
});

test("PT-GMAIL-012/a: Contact DNC, Account DNC, opt-out, bounce, hold and UNKNOWN flags each refuse", async () => {
  for (const [label, mutate, code] of [
    ["contact dnc", (w: ExecWorld) => w.sales.setContact({ dnc: true }), "REFUSE_CONTACT_DNC"],
    ["account dnc", (w: ExecWorld) => w.sales.setAccount({ dnc: true }), "REFUSE_ACCOUNT_DNC"],
    ["opt-out", (w: ExecWorld) => w.sales.setContact({ opt_out: true }), "REFUSE_CONTACT_OPT_OUT"],
    ["bounce", (w: ExecWorld) => w.sales.setContact({ bounced: true }), "REFUSE_CONTACT_BOUNCE"],
    ["contact hold", (w: ExecWorld) => w.sales.setContact({ hold: true }), "REFUSE_CONTACT_HOLD"],
    ["account hold", (w: ExecWorld) => w.sales.setAccount({ hold: true }), "REFUSE_ACCOUNT_HOLD"],
    ["unknown flag", (w: ExecWorld) => w.sales.setContact({ dnc: "UNKNOWN" }), "REFUSE_STATE_UNKNOWN"],
    ["contact unreadable", (w: ExecWorld) => w.sales.parties.set(ID.contact, "UNAVAILABLE"), "REFUSE_STATE_UNAVAILABLE"],
  ] as const) {
    const w = await buildExecWorld();
    mutate(w);
    await refused(w, code, "SAFETY_STATE");
    void label;
  }
});

test("PT-GMAIL-012/b: HUMAN or UNKNOWN inbound at T-0 refuses; a technical auto-reply alone does not", async () => {
  const w = await buildExecWorld();
  w.mailbox.inbound(RECIPIENT, "2030-02-01T09:30:00.000Z");
  const d = await refused(w, "REFUSE_INBOUND", "THREAD");
  assert.match(d.evidence[0] ?? "", /HUMAN\/REPLY inbound in-1/);
  const w2 = await buildExecWorld();
  w2.mailbox.inbound("someone-else@example.invalid", "2030-02-01T09:30:00.000Z", {}, "FYI");
  assert.equal((await refused(w2, "REFUSE_INBOUND", "THREAD")).evidence[0]?.startsWith("UNKNOWN/"), true);
  const w3 = await buildExecWorld();
  w3.mailbox.inbound(RECIPIENT, "2030-02-01T09:30:00.000Z", { "auto-submitted": "auto-replied" }, "Automatic reply: out of office");
  const d3 = await execute(w3.deps, req(), NOW);
  assert.equal(d3.decision, "SENT_AND_OBSERVED", "TECHNICAL inbound never blocks by itself");
  const w4 = await buildExecWorld();
  w4.mailbox.available = false;
  await refused(w4, "REFUSE_SOURCE_UNAVAILABLE", "THREAD");
});

test("PT-GMAIL-012/c: ownership / coordination conflict, duplicate or missing ACTIVE Enrollment refuse", async () => {
  const w = await buildExecWorld();
  w.sales.setContact({ owner: "rep-b" });
  await refused(w, "REFUSE_OWNERSHIP", "OWNERSHIP");
  const w2 = await buildExecWorld();
  w2.sales.setAccount({ coordination_lock: "account owned by another rep's live deal" });
  await refused(w2, "REFUSE_COORDINATION", "OWNERSHIP");
  const w3 = await buildExecWorld();
  w3.sales.enrollmentRows = [...(w3.sales.enrollmentRows as []), { ref: ID.enrollment2, status: "ACTIVE", contact_ref: ID.contact, owner: "rep-a", sequence_key: "seq-b" }];
  await refused(w3, "REFUSE_ENROLLMENT_NOT_UNIQUE", "ENROLLMENT");
  const w4 = await buildExecWorld();
  w4.sales.enrollmentRows = [];
  await refused(w4, "REFUSE_ENROLLMENT_NOT_UNIQUE", "ENROLLMENT");
  const w5 = await buildExecWorld();
  w5.sales.enrollmentRows = [{ ref: ID.enrollment2, status: "ACTIVE", contact_ref: ID.contact, owner: "rep-a", sequence_key: "seq-outbound-a" }];
  await refused(w5, "REFUSE_ENROLLMENT_MISMATCH", "ENROLLMENT");
});

test("PT-GMAIL-012/d: prior/manual outbound makes the intent obsolete; wrong mailbox identity refuses", async () => {
  const w = await buildExecWorld();
  w.mailbox.manualOutbound("2030-02-01T09:45:00.000Z");
  // A manual message to the recipient in the window is ambiguous for the action key (cannot rule it out) → fail closed.
  const d = await execute(w.deps, req(), NOW);
  assert.equal(d.decision, "HOLD", JSON.stringify(d));
  assert.equal(d.code, "HOLD_EFFECT_AMBIGUOUS");
  assert.equal(w.mailbox.sends, 0);
  const w2 = await buildExecWorld();
  w2.mailbox.identity = "other@example.invalid";
  await refused(w2, "REFUSE_MAILBOX_IDENTITY", "MAILBOX");
  const w3 = await buildExecWorld();
  w3.mailbox.identity = "UNKNOWN";
  await refused(w3, "REFUSE_SOURCE_UNAVAILABLE", "MAILBOX");
});

test("PT-GMAIL-012/e: intent shape — missing, mismatched key, wrong effect status, window, unverified transaction, content drift", async () => {
  const w = await buildExecWorld();
  w.sales.intents.set(ID.intent, "NOT_FOUND");
  await refused(w, "REFUSE_INTENT_NOT_FOUND", "INTENT");
  const w2 = await buildExecWorld();
  w2.sales.setIntent({ action_key: "ak-other" });
  await refused(w2, "REFUSE_ACTION_KEY_MISMATCH", "INTENT");
  const w3 = await buildExecWorld();
  w3.sales.setIntent({ effect_status: "SENT" });
  await refused(w3, "REFUSE_EFFECT_STATUS", "INTENT");
  const w4 = await buildExecWorld();
  assert.equal((await execute(w4.deps, req(), new Date("2030-02-04T00:00:00.000Z"))).code, "REFUSE_WINDOW");
  const w5 = await buildExecWorld({ verified: false });
  await refused(w5, "REFUSE_INTENT_NOT_VERIFIED", "VERIFIED_INTENT");
  const w6 = await buildExecWorld();
  w6.sales.contents.set(ID.content, { subject: "edited", body: "edited after verification", content_hash: "sha256:content-0002" });
  await refused(w6, "REFUSE_CONTENT_DRIFT", "CONTENT");
  const w7 = await buildExecWorld();
  w7.sales.setIntent({ recipient: "UNKNOWN" });
  await refused(w7, "REFUSE_INTENT_INCOMPLETE", "INTENT");
  void PREPARED;
});
