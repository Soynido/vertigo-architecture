/**
 * PT-GMAIL-011 — Two chats/retries cannot duplicate one action_key send (ADVERSARIAL, blocking, PG9).
 * Two execution attempts race on the same verified intent_ref/action_key; a retry follows an ambiguous client
 * timeout; a crash between send and readback is retried. At most one Gmail effect exists for the action key.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execute } from "../src/engine.ts";
import { ACTION_KEY, buildExecWorld, NOW, req } from "./executor-fixtures.ts";

const effects = (w: Awaited<ReturnType<typeof buildExecWorld>>) => w.mailbox.messages.filter((m) => m.headers?.["x-vertigo-action-key"] === ACTION_KEY);

test("PT-GMAIL-011/a: two concurrent attempts → exactly one send; the other observes in-flight state and refuses", async () => {
  const w = await buildExecWorld();
  const [a, b] = await Promise.all([execute(w.deps, req("chat-1"), NOW), execute(w.deps, req("chat-2"), NOW)]);
  const kinds = [a.decision, b.decision].sort();
  assert.deepEqual(kinds, ["REFUSED", "SENT_AND_OBSERVED"], JSON.stringify([a, b]));
  const loser = a.decision === "REFUSED" ? a : b;
  assert.equal(loser.code, "REFUSE_IN_FLIGHT");
  assert.equal(loser.gmail_send_called, false);
  assert.equal(w.mailbox.sends, 1);
  assert.equal(effects(w).length, 1, "Gmail shows exactly one effect for the action key");
  // A later retry from either chat observes the effect and never sends again.
  const later = await execute(w.deps, req("chat-1-retry"), new Date(NOW.getTime() + 60_000));
  assert.equal(later.decision, "ALREADY_OBSERVED");
  assert.equal(later.gmail_send_called, false);
  assert.equal(w.mailbox.sends, 1);
});

test("PT-GMAIL-011/b: retry after an ambiguous client timeout reconciles from Gmail instead of resending", async () => {
  const w = await buildExecWorld();
  w.mailbox.mode = "AMBIGUOUS_BUT_SENT";
  // Readback inside the same attempt already resolves it when Gmail shows the message.
  const first = await execute(w.deps, req("att-1"), NOW);
  assert.equal(first.decision, "SENT_AND_OBSERVED", JSON.stringify(first));
  assert.equal(w.mailbox.sends, 1);
  const retry = await execute(w.deps, req("att-1-retry"), NOW);
  assert.equal(retry.decision, "ALREADY_OBSERVED");
  assert.equal(w.mailbox.sends, 1);
  assert.equal(effects(w).length, 1);
  // Ambiguous with NO effect visible yet: HOLD, never replay — even a later attempt only reconciles.
  const w2 = await buildExecWorld();
  w2.mailbox.mode = "AMBIGUOUS_NOT_SENT";
  const amb = await execute(w2.deps, req("att-1"), NOW);
  assert.equal(amb.decision, "HOLD", JSON.stringify(amb));
  assert.equal(amb.code, "HOLD_TRANSPORT_AMBIGUOUS");
  assert.equal(amb.gmail_send_called, true);
  const again = await execute(w2.deps, req("att-2"), new Date(NOW.getTime() + 600_000));
  assert.equal(again.decision, "HOLD");
  assert.equal(again.code, "HOLD_EFFECT_UNRESOLVED");
  assert.equal(w2.mailbox.sends, 1, "no blind replay after an ambiguous transport result");
  assert.equal((await w2.ledger.get(ACTION_KEY))?.state, "AMBIGUOUS_TRANSPORT");
});

test("PT-GMAIL-011/c: crash between send and readback → the next attempt reconciles the existing effect, zero duplicates", async () => {
  const w = await buildExecWorld();
  // Simulate the crash: the ledger reached SENT_PENDING_READBACK, the message exists in Gmail, the process died.
  await w.ledger.acquire(ACTION_KEY, "att-crashed", NOW, 120_000);
  await w.ledger.update(ACTION_KEY, "att-crashed", { state: "SENT_PENDING_READBACK", message_id: "msg-1", thread_id: "thread-exec-1" }, NOW);
  await w.mailbox.transport().send({ from: "rep@example.invalid", to: "prospect@example.invalid", subject: `Step 2 [${ACTION_KEY}]`, body: "x", thread_id: "thread-exec-1", headers: { "X-Vertigo-Action-Key": ACTION_KEY } });
  w.mailbox.sends = 0;
  const d = await execute(w.deps, req("att-recover"), new Date(NOW.getTime() + 300_000));
  assert.equal(d.decision, "ALREADY_OBSERVED", JSON.stringify(d));
  assert.equal(d.effect?.message_id, "msg-1");
  assert.equal(w.mailbox.sends, 0);
  assert.equal(effects(w).length, 1);
  // Crash BEFORE send (lease expired in CHECKING): a fresh attempt runs the full T-0 checks and may send once.
  const w2 = await buildExecWorld();
  await w2.ledger.acquire(ACTION_KEY, "att-dead", new Date(NOW.getTime() - 3_600_000), 120_000);
  const d2 = await execute(w2.deps, req("att-fresh"), NOW);
  assert.equal(d2.decision, "SENT_AND_OBSERVED", JSON.stringify(d2));
  assert.equal(d2.checks.length, 13, "full T-0 check set re-run");
  assert.equal(w2.mailbox.sends, 1);
  // A definitive transport failure is re-acquirable, but only after reconciliation proves absence.
  const w3 = await buildExecWorld();
  w3.mailbox.mode = "FAIL";
  const f = await execute(w3.deps, req("att-1"), NOW);
  assert.equal(f.code, "HOLD_TRANSPORT_FAILED");
  w3.mailbox.mode = "SEND";
  const g = await execute(w3.deps, req("att-2"), NOW);
  assert.equal(g.decision, "SENT_AND_OBSERVED");
  assert.equal(effects(w3).length, 1);
});
