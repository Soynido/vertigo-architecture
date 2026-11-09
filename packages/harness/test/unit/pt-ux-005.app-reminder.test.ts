/**
 * PT-UX-005 (PV0-020E): the per-message app reminder is HARNESS-EMITTED and the turn order is fixed by the harness.
 * Whenever an envelope carries `ask` (a human answer is required, and that answer is a tool-required message), `say`
 * is EXACTLY « <state> <canonical question> <reminder> » — state first, canonical question second, reminder LAST, each
 * exactly once. `ask` stays the pure canonical question (what §2b persists as `Question`) and is never re-displayed.
 * Envelopes without `ask` never carry the reminder. Deterministic across bind and resume.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../../src/tools/handlers.ts";
import { APP_REMINDER, SAY } from "../../src/tools/messages.fr.ts";
import { toolDescriptions } from "../../src/tools/surface.ts";
import { handleOf, OWNER, REP_B, T0 } from "./binding-fixtures.ts";
import { buildResumeWorld, gateRow, R, setRowsIn } from "./resume-fixtures.ts";
import { withUserSentence } from "../../src/tools/messages.fr.ts";
import { hold } from "../../src/tools/envelope.ts";
import { withConduct } from "../../src/tools/conduct.ts";

const ctx = { principal_id: OWNER.principal_id, now: T0 };
const REM = "Gardez VERTIGO et Notion sélectionnés sur votre réponse.";
const count = (s: string, sub: string) => s.split(sub).length - 1;

test("PT-UX-005/a: ask present ⇒ say === state + canonical question + reminder LAST, each once; ask is pure; no ask ⇒ no reminder", async () => {
  assert.equal(APP_REMINDER, REM);
  const w = buildResumeWorld();
  const q = await dispatch("os_bind", {}, ctx, w.deps);
  assert.equal(q.code, "HOLD_LANE_REQUIRED");
  assert.equal(q.ask, "Souhaitez-vous travailler sur votre espace de pilotage VERTIGO ou votre espace de prospection ?");
  assert.equal(q.say, `${SAY.HOLD_LANE_REQUIRED} ${q.ask} ${REM}`, "exact order: state, question, reminder last");
  const b = await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps);
  assert.equal(b.ask, undefined); assert.ok(!b.say?.includes(REM), "no question ⇒ no reminder");
  const h = handleOf(b);
  const r = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  assert.equal(r.code, "RESUMED");
  assert.equal(r.ask, "What do you sell?", "ask = the gate's Next Question, verbatim, reminder-free");
  assert.equal(r.say, `Reprise faite depuis Notion. Étape en cours : T1. What do you sell? ${REM}`, "exact rendered turn");
  assert.equal(count(r.say!, REM), 1, "reminder exactly once"); assert.equal(count(r.say!, r.ask!), 1, "question exactly once");
  assert.ok(r.say!.endsWith(REM) && r.say!.indexOf(r.ask!) < r.say!.indexOf(REM), "question before reminder, reminder last");
  // Deterministic: a second resume says exactly the same thing.
  assert.equal((await dispatch("os_resume", { binding_handle: h }, ctx, w.deps)).say, r.say);
  // Read-only replies without a question never carry it.
  for (const name of ["os_handoff", "os_control_status"] as const) {
    const e = await dispatch(name, { binding_handle: h }, ctx, w.deps);
    assert.equal(e.ask, undefined); assert.ok(!e.say?.includes(REM), `${name}: ${e.say}`);
  }
});

test("PT-UX-005/b: a step without a next question ⇒ no ask, no question text, no reminder; a rep's single-lane bind asks nothing", async () => {
  const w = buildResumeWorld();
  setRowsIn(w.map, R.metaGatesDs, [gateRow({ id: R.gateM1, key: "T1", status: "OPEN", nextAction: "Wait for the verifier", lastEdited: "2030-01-02T00:00:00.000Z" })]);
  const h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps));
  const r = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  assert.equal(r.code, "RESUMED");
  assert.equal(r.ask, undefined);
  assert.equal(r.say, "Reprise faite depuis Notion. Étape en cours : T1. Prochaine action : Wait for the verifier");
  const rep = await dispatch("os_bind", {}, { principal_id: REP_B.principal_id, now: T0 }, w.deps);
  assert.equal(rep.ask, undefined); assert.ok(!rep.say?.includes(REM));
});

test("PT-UX-005/c: first-message bind and same-conversation handle continuation preserve lane without trusting prose — now carried by the reply's conduct", async () => {
  // The lane-routing rule used to live in the os_bind DESCRIPTION, which the client caches at initialize. It now
  // travels on the HOLD_LANE_REQUIRED reply itself (PV-CONDUCT-001), so a deploy changes it without a reconnect.
  const w = buildResumeWorld();
  const q = await dispatch("os_bind", {}, ctx, w.deps);
  assert.equal(q.code, "HOLD_LANE_REQUIRED");
  const c = q.next.conduct ?? "";
  for (const required of [
    "CURRENT message, never at chat history",
    "prospection or SALES",
    'lane "SALES"',
    "pilotage or META",
    'lane "META"',
    "Only if it is genuinely ambiguous",
    "keep VERTIGO and Notion selected on the reply",
    "Never re-display `ask`, never add anything after `say`",
  ]) assert.ok(c.includes(required), `HOLD_LANE_REQUIRED conduct lacks: ${required}`);
  const b = await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps);
  assert.equal(b.code, "BOUND");
  const cb = b.next.conduct ?? "";
  for (const required of [
    "Stay silent: a binding is not state",
    "Call os_resume now with this binding_handle",
    "Keep this handle for every later message of the conversation",
    "never rebuild authority from an earlier message, the selected apps or a pasted handle",
  ]) assert.ok(cb.includes(required), `BOUND conduct lacks: ${required}`);
  // The description itself is now a fact sheet: what the tool is and takes, nothing imperative to cache.
  assert.match(toolDescriptions.os_bind, /backend-resolved and never accepted from the caller/);
  assert.doesNotMatch(toolDescriptions.os_bind, /immediately retry|silently|never re-display/);
});

test("PT-UX-005/d: the capability remediation conduct names exactly the returned pair, a read-only native action and bounded evidence", () => {
  // Same move for the capability path: the rule is emitted on the HOLD that carries the challenge, from the
  // challenge's own fields, so it can never name a pair the backend did not return.
  const heldWith = (capability: string, competent_source: string) => withConduct("os_resume", withUserSentence("os_resume", hold("HOLD_REQUIRED_CAPABILITY_INCOMPLETE", "connect the app", [], {
    observations: { capability_remediation: { challenge: "c1", capability, competent_source, expires_at: "2030-01-01T00:00:00.000Z" } },
    next: { safe_action: "connect the app", permitted_tool_call: "os_prepare" },
  })));
  const gmail = heldWith("GMAIL_READ", "GMAIL").next.conduct ?? "";
  for (const required of [
    "GMAIL_READ / GMAIL",
    "first missing REQUIRED read",
    "exposed on the CURRENT message",
    "never send, draft, delete, label or otherwise modify mail",
    "call os_prepare with NO intent and only capability_evidence",
    "challenge, competent_source, evidence_ref and an explicit-offset verified_at",
    "observed mailbox as source_identity",
    "Never build a Capability Profile mutation",
    "say `say` word for word",
  ]) assert.ok(gmail.includes(required), `Gmail remediation conduct lacks: ${required}`);
  const calendar = heldWith("CALENDAR_READ", "GOOGLE_CALENDAR").next.conduct ?? "";
  assert.ok(calendar.includes("CALENDAR_READ / GOOGLE_CALENDAR"));
  assert.ok(calendar.includes("never create, update or delete an event or a calendar"));
  assert.ok(calendar.includes("omit source_identity unless the native source exposes one"));
  const notion = heldWith("NOTION_RUNTIME_READ", "NOTION").next.conduct ?? "";
  assert.ok(notion.includes("NOTION_RUNTIME_READ / NOTION"));
  assert.ok(notion.includes("never create, update or delete a page or a database"));
  // Without a challenge there is no remediation to perform: the conduct says `say` alone and stop.
  const bare = withConduct("os_resume", withUserSentence("os_resume", hold("HOLD_REQUIRED_CAPABILITY_INCOMPLETE", "connect the app"))).next.conduct ?? "";
  assert.ok(bare.includes("Stop; relay no technical step and choose no capability yourself"));
  assert.ok(!bare.includes("call os_prepare"), "no challenge ⇒ no os_prepare continuation");
  // The descriptions carry none of it any more.
  for (const d of [toolDescriptions.os_resume, toolDescriptions.os_prepare]) assert.doesNotMatch(d, /GMAIL_READ|CALENDAR_READ|KEEP `say` SILENT/);
});

test("PT-UX-005/e: eligible recovery continuation is silent while an ordinary recovery HOLD remains user-facing", () => {
  const eligible = withUserSentence("os_resume", hold("HOLD_RECOVERY_REQUIRED", "continue", [], {
    next: { safe_action: "continue", permitted_tool_call: "os_verify" },
  }));
  assert.equal(eligible.say, undefined);
  assert.equal(eligible.ask, undefined);
  assert.equal(eligible.next.permitted_tool_call, "os_verify");

  const blocked = withUserSentence("os_resume", hold("HOLD_RECOVERY_REQUIRED", "reconcile manually"));
  assert.equal(blocked.say, SAY.HOLD_RECOVERY_REQUIRED);
});
