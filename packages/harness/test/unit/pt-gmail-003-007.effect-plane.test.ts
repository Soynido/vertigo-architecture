/**
 * PV0-017A — Gmail effect plane on fixtures: PT-GMAIL-003 (verified intent mandatory), PT-GMAIL-004 (crash after
 * intent FINAL recovers without blind replay), PT-GMAIL-006 (ambiguity fail-closed), PT-GMAIL-007 (inbound
 * classification), plus the mailbox-identity guard observed live. Nothing here can send.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../../src/tools/handlers.ts";
import { classifyInbound, routeExternalAction, SnapshotCompetentSource, type MailboxMessage } from "../../src/effects/gmail.ts";
import { intentViewFromPlan } from "../../src/effects/adapter.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import type { Plan } from "../../src/plans/store.ts";
import type { HarnessDeps } from "../../src/tools/handlers.ts";
import { resolveRuntimeFor } from "../../src/tools/handlers.ts";
import { handleOf, OWNER, T0 } from "./binding-fixtures.ts";
import { buildResumeWorld, type ResumeWorld } from "./resume-fixtures.ts";
import { executeWrites } from "./target-fixtures.ts";
import { transact as nativeTransact } from "../support/transact.ts";

const NOW = new Date("2030-01-03T00:29:00.000Z");
const NOW_VERIFY = new Date("2030-01-03T00:33:00.000Z");
const ctx = { principal_id: OWNER.principal_id, now: NOW };
const ctxV = { principal_id: OWNER.principal_id, now: NOW_VERIFY };
type Ok = Extract<Envelope, { status: "OK" }>;
const MAILBOX = "rep-a@example.invalid";
const RECIPIENT = "prospect@example.invalid";
const T = { s1: "2030-01-03T00:30:00.000Z", fin: "2030-01-03T00:31:00.000Z", state: "2030-01-03T00:32:00.000Z" };
const intentOf = (key: string) => ({ action_class: "COMMIT", summary: "queue outreach", mutations: [{ logical_resource_key: "SALES:EXTERNAL_ACTIONS", operation: "CREATE" as const, record_selector: { natural_key: key }, desired_changes: { Recipient: RECIPIENT, "Subject / Content Hash": `Hello ${key}`, "Action Type": "GMAIL_SEND" } }] });

async function throughFinal(w: ResumeWorld, key: string): Promise<{ h: string; plan: Plan; finalResult: Record<string, unknown>; runtime: import("../../src/resolvers/types.ts").ResolvedRuntime; receipt: import("../../src/verify/engine.ts").ReceiptRecord }> {
  const h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps));
  const { plan, final, receipt: rid } = await nativeTransact(w, h, intentOf(key), { ctx, verifyCtx: ctxV, stamps: { stage1: T.s1, fin: T.fin, state: T.state } });
  const principal = (await w.deps.principals.get(OWNER.principal_id))!;
  const r = await resolveRuntimeFor(w.deps, principal, "VERTIGO", "SALES");
  assert.equal(r.kind, "RESOLVED");
  const receipt = (await w.deps.store.receipts.get(rid))!;
  return { h, plan: (await w.deps.store.plans.get(plan.plan_id))!, finalResult: (final as Ok).result as Record<string, unknown>, runtime: (r as { runtime: import("../../src/resolvers/types.ts").ResolvedRuntime }).runtime, receipt };
}
const sent = (id: string, key: string, date: string, extra: Partial<MailboxMessage> = {}): MailboxMessage => ({ message_id: id, thread_id: `thr-${id}`, from: MAILBOX, to: [RECIPIENT], subject: `Hello ${key}`, date, ...extra });
const withSource = (w: ResumeWorld, src: SnapshotCompetentSource): HarnessDeps => ({ ...w.deps, competentSource: src });

test("os_verify(FINAL) on an intent exposes routing metadata only: capability, mailbox, recipient, window, t0 recheck, send_authority NONE", async () => {
  const w = buildResumeWorld();
  const { finalResult } = await throughFinal(w, "ak-route-1");
  const ea = finalResult["external_action"] as Record<string, unknown>;
  assert.equal(ea["capability"], "GMAIL_SEND");
  assert.equal(ea["mailbox_identity"], MAILBOX, "mailbox identity is backend-derived from the runtime Manifest");
  assert.equal(ea["recipient"], RECIPIENT);
  assert.equal(ea["action_key"], "ak-route-1");
  assert.equal(ea["t0_recheck_required"], true);
  assert.equal(ea["send_authority"], "NONE");
  assert.equal(ea["effect_status"], "PREPARED");
  assert.match(String(ea["note"]), /NOT proof of an effect/);
});

test("PT-GMAIL-003: no external action is routed without an exact FINAL-verified intent in an eligible mode; PROTECTED sends are executor-only", async () => {
  const w = buildResumeWorld();
  const { plan, runtime, receipt } = await throughFinal(w, "ak-003");
  const intent = intentViewFromPlan(runtime, plan, receipt)!;
  const src = new SnapshotCompetentSource(MAILBOX, []);
  const base = { intent, requested_action_key: intent.action_key, requested_intent_ref: intent.intent_ref, runtime_generation: plan.runtime_generation, source: src };
  // absent plan
  assert.equal((await routeExternalAction(w.deps.store.receipts, { ...base, plan: undefined, mode: "EXTERNAL_ACTION_TEST" })).kind, "HOLD");
  // non-FINAL plan
  const nf = (await routeExternalAction(w.deps.store.receipts, { ...base, plan: { ...plan, plan_state: "TARGET_VERIFIED" }, mode: "EXTERNAL_ACTION_TEST" })) as { code: string };
  assert.equal(nf.code, "HOLD_EXTERNAL_INTENT_NOT_VERIFIED");
  // wrong runtime
  assert.equal(((await routeExternalAction(w.deps.store.receipts, { ...base, plan, runtime_generation: "other-gen", mode: "EXTERNAL_ACTION_TEST" })) as { code: string }).code, "HOLD_EXTERNAL_INTENT_NOT_VERIFIED");
  // mismatched action key / intent ref
  assert.equal(((await routeExternalAction(w.deps.store.receipts, { ...base, plan, requested_action_key: "ak-other", mode: "EXTERNAL_ACTION_TEST" })) as { code: string }).code, "HOLD_EXTERNAL_INTENT_NOT_VERIFIED");
  assert.equal(((await routeExternalAction(w.deps.store.receipts, { ...base, plan, requested_intent_ref: "0123456789abcdef0123456789abcdef", mode: "EXTERNAL_ACTION_TEST" })) as { code: string }).code, "HOLD_EXTERNAL_INTENT_NOT_VERIFIED");
  // already effected intent
  assert.equal(((await routeExternalAction(w.deps.store.receipts, { ...base, plan, intent: { ...intent, effect_status: "SENT" }, mode: "EXTERNAL_ACTION_TEST" })) as { code: string }).code, "HOLD_EXTERNAL_EFFECT_OBSERVED");
  // protected automated send is executor-only
  assert.equal(((await routeExternalAction(w.deps.store.receipts, { ...base, plan, mode: "PROTECTED_AUTOMATED_SEND" })) as { code: string }).code, "HOLD_EXECUTOR_REQUIRED");
  // test mode: no approved scope / outside scope / inside scope
  assert.equal(((await routeExternalAction(w.deps.store.receipts, { ...base, plan, mode: "EXTERNAL_ACTION_TEST" })) as { code: string }).code, "HOLD_TEST_SCOPE_NOT_APPROVED");
  assert.equal(((await routeExternalAction(w.deps.store.receipts, { ...base, plan, mode: "EXTERNAL_ACTION_TEST", approved_test_scope: { from: "someone-else@example.invalid", to: [RECIPIENT] } })) as { code: string }).code, "HOLD_TEST_SCOPE_NOT_APPROVED");
  const ok = await routeExternalAction(w.deps.store.receipts, { ...base, plan, mode: "EXTERNAL_ACTION_TEST", approved_test_scope: { from: MAILBOX, to: [RECIPIENT] } });
  assert.equal(ok.kind, "ROUTED");
  assert.equal((ok as { disposition: string }).disposition, "ELIGIBLE_FOR_NATIVE_TEST_SEND");
  assert.equal((ok as { routing: { send_authority: string } }).routing.send_authority, "NONE");
  // no competent source ⇒ nothing is eligible
  assert.equal(((await routeExternalAction(w.deps.store.receipts, { ...base, plan, source: undefined, mode: "EXTERNAL_ACTION_TEST", approved_test_scope: { from: MAILBOX, to: [RECIPIENT] } })) as { code: string }).code, "HOLD_EXTERNAL_SOURCE_UNAVAILABLE");
});

test("PT-GMAIL-004: crash after intent FINAL — observed ⇒ no resend; proven absent ⇒ fresh T-0 attempt; ambiguous ⇒ HOLD", async () => {
  const w = buildResumeWorld();
  const { h, plan, runtime, receipt } = await throughFinal(w, "ak-004");
  const intent = intentViewFromPlan(runtime, plan, receipt)!;
  const base = { plan, intent, requested_action_key: intent.action_key, requested_intent_ref: intent.intent_ref, runtime_generation: plan.runtime_generation, mode: "READ_RECONCILE" as const };
  // Observed exactly once ⇒ persist Receipt, never resend.
  const observed = await routeExternalAction(w.deps.store.receipts, { ...base, source: new SnapshotCompetentSource(MAILBOX, [sent("m1", "ak-004", "2030-01-03T00:40:00.000Z")]) });
  assert.equal(observed.kind, "ROUTED");
  assert.equal((observed as { disposition: string }).disposition, "PERSIST_RECEIPT_NO_RESEND");
  assert.match((observed as { next_safe_action: string }).next_safe_action, /do NOT send again/);
  // Proven absent within the bounded window ⇒ still eligible for a fresh attempt with T-0 checks.
  const absent = await routeExternalAction(w.deps.store.receipts, { ...base, source: new SnapshotCompetentSource(MAILBOX, []) });
  assert.equal((absent as { disposition: string }).disposition, "READ_ONLY");
  assert.match((absent as { next_safe_action: string }).next_safe_action, /fresh execution attempt with full T-0 checks/);
  // Ambiguous ⇒ HOLD.
  const amb = await routeExternalAction(w.deps.store.receipts, { ...base, source: new SnapshotCompetentSource(MAILBOX, [sent("m1", "ak-004", "2030-01-03T00:40:00.000Z"), sent("m2", "ak-004", "2030-01-03T00:41:00.000Z")]) });
  assert.equal((amb as { code: string }).code, "HOLD_EXTERNAL_EFFECT_AMBIGUOUS");
  // Missing Receipt alone never authorizes a resend: a fresh chat resume with the observed effect says so.
  const deps = withSource(w, new SnapshotCompetentSource(MAILBOX, [sent("m1", "ak-004", "2030-01-03T00:40:00.000Z")]));
  const h2 = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, deps));
  const rs = await dispatch("os_resume", { binding_handle: h2 }, ctx, deps);
  assert.equal(rs.code, "HOLD_RECOVERY_REQUIRED", "an unresolved intent is recovery work, never silently healthy");
  const ea = rs.observations["external_actions"] as { unresolved: Array<{ reconciliation: { status: string } }>; gmail_hold?: string; competent_source_available: boolean };
  assert.equal(ea.competent_source_available, true);
  assert.equal(ea.unresolved[0]!.reconciliation.status, "OBSERVED");
  assert.match(ea.gmail_hold ?? "", /never resend/);
  assert.match(rs.next.safe_action, /never resend/);
  void h; void T0;
});

test("PT-GMAIL-006: external-action ambiguity is fail-closed — HOLD, no Receipt, nothing completed; unavailable source also HOLDs", async () => {
  const w = buildResumeWorld();
  const { plan, runtime, receipt } = await throughFinal(w, "ak-006");
  const intent = intentViewFromPlan(runtime, plan, receipt)!;
  const before = (await w.deps.store.receipts.findByPlan(plan.plan_id)).length;
  const base = { plan, intent, requested_action_key: intent.action_key, requested_intent_ref: intent.intent_ref, runtime_generation: plan.runtime_generation, mode: "EXTERNAL_ACTION_TEST" as const, approved_test_scope: { from: MAILBOX, to: [RECIPIENT] } };
  const twoWithKey = new SnapshotCompetentSource(MAILBOX, [sent("a", "ak-006", "2030-01-03T00:40:00.000Z"), sent("b", "ak-006", "2030-01-03T00:45:00.000Z")]);
  const r1 = await routeExternalAction(w.deps.store.receipts, { ...base, source: twoWithKey });
  assert.equal((r1 as { code: string }).code, "HOLD_EXTERNAL_EFFECT_AMBIGUOUS");
  // A message to the recipient in the window that does not carry the action key is still ambiguous (could be this effect).
  const looseMatch = new SnapshotCompetentSource(MAILBOX, [sent("c", "unrelated", "2030-01-03T00:50:00.000Z")]);
  assert.equal(((await routeExternalAction(w.deps.store.receipts, { ...base, source: looseMatch })) as { code: string }).code, "HOLD_EXTERNAL_EFFECT_AMBIGUOUS");
  // Unavailable source
  assert.equal(((await routeExternalAction(w.deps.store.receipts, { ...base, source: new SnapshotCompetentSource(MAILBOX, [], false) })) as { code: string }).code, "HOLD_EXTERNAL_SOURCE_UNAVAILABLE");
  assert.equal((await w.deps.store.receipts.findByPlan(plan.plan_id)).length, before, "no receipt created by reconciliation");
  assert.equal((await w.deps.store.plans.get(plan.plan_id))!.plan_state, "FINAL_VERIFIED", "intent transaction untouched; nothing marked completed as an effect");
  // Resume with the ambiguous source carries the hold.
  const deps = withSource(w, twoWithKey);
  const h2 = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, deps));
  const rs = await dispatch("os_resume", { binding_handle: h2 }, ctx, deps);
  assert.equal(rs.code, "HOLD_RECOVERY_REQUIRED");
  const ea = rs.observations["external_actions"] as { unresolved: Array<{ reconciliation: { status: string } }>; gmail_hold?: string };
  assert.equal(ea.unresolved[0]!.reconciliation.status, "AMBIGUOUS");
  assert.match(ea.gmail_hold ?? "", /AMBIGUOUS/);
  assert.match(rs.next.safe_action, /refuse send and replay/);
});

test("PT-GMAIL-007: inbound classification — autoresponders are TECHNICAL, humans are HUMAN, unknowns take over; technical never blocks like a human", async () => {
  const at = "2030-01-03T01:00:00.000Z"; // after the intent was prepared, inside the reconcile window
  const inbound = (over: Partial<MailboxMessage>): MailboxMessage => ({ message_id: "i", thread_id: "thr", from: RECIPIENT, to: [MAILBOX], subject: "Re: Hello", date: at, ...over });
  const c1 = classifyInbound(inbound({ headers: { "Auto-Submitted": "auto-replied" } }), RECIPIENT);
  assert.deepEqual([c1.kind, c1.classification, c1.human_takeover], ["TECHNICAL", "AUTO_REPLY", false]);
  const c2 = classifyInbound(inbound({ headers: { "X-Autoreply": "yes" }, subject: "Automatic reply: out of office" }), RECIPIENT);
  assert.deepEqual([c2.kind, c2.classification], ["TECHNICAL", "OOO"]);
  const c3 = classifyInbound(inbound({ from: "mailer-daemon@googlemail.com", subject: "Delivery Status Notification (Failure)" }), RECIPIENT);
  assert.deepEqual([c3.kind, c3.classification], ["TECHNICAL", "BOUNCE"]);
  const c4 = classifyInbound(inbound({ from: "assistant@example.invalid", subject: "Re: Hello", snippet: "Thanks, forwarding" }), RECIPIENT);
  assert.deepEqual([c4.kind, c4.human_takeover], ["UNKNOWN", true]);
  const c5 = classifyInbound(inbound({ snippet: "Yes, let's talk next week." }), RECIPIENT);
  assert.deepEqual([c5.kind, c5.classification, c5.human_takeover], ["HUMAN", "REPLY", true]);
  const c6 = classifyInbound(inbound({ snippet: "Please unsubscribe me, ne plus me contacter." }), RECIPIENT);
  assert.deepEqual([c6.kind, c6.classification], ["HUMAN", "OPT_OUT"]);
  // Dispatch gate: a HUMAN or UNKNOWN inbound after the intent ⇒ zero sends; a technical auto-reply alone does not block.
  const w = buildResumeWorld();
  const { plan, runtime, receipt } = await throughFinal(w, "ak-007");
  const intent = { ...intentViewFromPlan(runtime, plan, receipt)!, thread_ref: "thr" };
  const base = { plan, intent, requested_action_key: intent.action_key, requested_intent_ref: intent.intent_ref, runtime_generation: plan.runtime_generation, mode: "EXTERNAL_ACTION_TEST" as const, approved_test_scope: { from: MAILBOX, to: [RECIPIENT] } };
  const human = await routeExternalAction(w.deps.store.receipts, { ...base, source: new SnapshotCompetentSource(MAILBOX, [inbound({ snippet: "Yes, let's talk." })]) });
  assert.equal((human as { code: string }).code, "HOLD_INBOUND_BEFORE_DISPATCH");
  const unknown = await routeExternalAction(w.deps.store.receipts, { ...base, source: new SnapshotCompetentSource(MAILBOX, [inbound({ from: "assistant@example.invalid" })]) });
  assert.equal((unknown as { code: string }).code, "HOLD_INBOUND_BEFORE_DISPATCH");
  const technical = await routeExternalAction(w.deps.store.receipts, { ...base, source: new SnapshotCompetentSource(MAILBOX, [inbound({ headers: { "Auto-Submitted": "auto-replied" } })]) });
  assert.equal(technical.kind, "ROUTED", "an autoresponder alone never creates a human-stop");
  assert.equal((technical as unknown as { inbound: Array<{ classification: { kind: string } }> }).inbound[0]!.classification.kind, "TECHNICAL");
});

test("mailbox identity guard (observed live 2026-09-18): a competent source authenticated as another mailbox blocks any routing", async () => {
  const w = buildResumeWorld();
  const { plan, runtime, receipt } = await throughFinal(w, "ak-id");
  const intent = intentViewFromPlan(runtime, plan, receipt)!;
  const r = await routeExternalAction(w.deps.store.receipts, { plan, intent, requested_action_key: intent.action_key, requested_intent_ref: intent.intent_ref, runtime_generation: plan.runtime_generation, mode: "EXTERNAL_ACTION_TEST", approved_test_scope: { from: MAILBOX, to: [RECIPIENT] }, source: new SnapshotCompetentSource("someone-else@example.invalid", []) });
  assert.equal((r as { code: string }).code, "HOLD_MAILBOX_IDENTITY_MISMATCH");
});
