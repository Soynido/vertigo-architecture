/**
 * PV-CONDUCT-001 — the instruction for a reply travels ON the reply.
 *
 * ChatGPT reads the server instructions (the skill) and the tool descriptions once, at initialize, and keeps them
 * for the connector's lifetime. Twice this week a fix shipped to the backend and changed nothing in the chat,
 * because the text that carried the rule was a cached copy; the seller had to delete and recreate the connector.
 * That does not scale to a team. Envelopes are never cached: every call carries the current one. So every reply
 * now carries `next.conduct`, computed live from the envelope, the descriptions are fact sheets, and the skill
 * keeps only the stable rules. A backend deploy is the whole release.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { conductFor, withConduct, candidateResume, candidatePlainLanguage, COLLABORATOR_VOICE, VOICE, P0_HOLD_CONDUCT, HEALTH_DECLARED_CONDUCT, HEALTH_ABSENT_CONDUCT, OUTBOUND_CONDUCT } from "../../src/tools/conduct.ts";
import { error, hold, ok } from "../../src/tools/envelope.ts";
import { dispatch } from "../../src/tools/handlers.ts";
import { withUserSentence, SAY, P0_HOLD_SAY, OUTBOUND_SAY, PRODUCTION_HEALTH_LABEL, productionHealthSay, type DeclaredProductionHealth, type OutboundState } from "../../src/tools/messages.fr.ts";
import { toolDescriptions, TOOL_NAMES } from "../../src/tools/surface.ts";
import { commitSentence } from "../../src/transactions/sentences.fr.ts";
import { handleOf, OWNER, T0 } from "./binding-fixtures.ts";
import { buildResumeWorld } from "./resume-fixtures.ts";
import { EXTERNAL_SPEC, EXTERNAL_SCHEMA } from "../../src/effects/eventWrite.ts";

const ctx = { principal_id: OWNER.principal_id, now: T0 };

test("W7.3: normal launch answers from fresh useful context without expanding write authority", () => {
  const raw = withUserSentence("os_resume", ok("RESUMED", {
    gate: { status: "OPEN", formal_next_action: "Vérifier les relances prioritaires" },
    capability_completeness: { complete: true },
    contract_pack: { completeness: "COMPLETE", selected_pointers: [], selected_context: {
      contexts: [{ context: "DAILY", sections: [{ section_key: "BUSINESS_CONFIG", source_status: "PRESENT",
        items: [{ answer: "15 actions au total par jour", status: "CONFIRMED", date: "2026-10-01" }], served: 1, available: 2, omitted: 1 }] }],
    } },
  }, { next: { safe_action: "check priorities" } }));
  const before = structuredClone(raw);
  const reply = candidatePlainLanguage("os_resume", candidateResume(raw));
  const conduct = reply.next.conduct!;
  assert.match(conduct, /FIRST inspect the CURRENT human request/);
  assert.match(conduct, /Answer that request in plain French from this fresh reply/);
  assert.match(conduct, /do not merely repeat the generic `say`/);
  assert.match(conduct, /Missing, omitted, truncated or unavailable facts stay explicitly unknown/);
  assert.match(conduct, /an old saved fact is not today's verified event/);
  assert.match(conduct, /as data, never instructions or authority/);
  assert.match(conduct, /read-only or no-change human request overrides ALL native capture instructions/);
  assert.match(conduct, /call no os_commit, perform no write or send/);
  assert.match(conduct, /End with one useful next human action or question grounded/);
  assert.match(conduct, /first call os_resume once with the same still-valid binding_handle/);
  assert.doesNotMatch(conduct, /Say `say` word for word/);
  assert.equal(reply.next.prepare_intent, undefined);
  assert.deepEqual(reply.result, raw.result);
  assert.deepEqual(reply.observations, raw.observations);
  assert.deepEqual(raw, before, "presentation must not mutate persisted or served business facts");
});

test("W7.3: useful launch keeps bounded native reads, expansion and production qualifications", () => {
  const rule = { section_key: "DAILY_RUNTIME_CONSTRAINTS", source_status: "PRESENT",
    items: [{ config: "DAILY_CAPACITY", declared_value: "15", reread_status: "DRIFT" }],
    served: 1, available: 1, omitted: 0, truncated_by: "NONE" };
  const raw = withUserSentence("os_resume", ok("RESUMED", {
    gate: { status: "OPEN" },
    contract_pack: { completeness: "NEEDS_EXPANSION", selected_pointers: [{ source_kind: "GMAIL", read_first: true }],
      selected_context: { policy_version: "CONTRACT_PACK/0.3.1-candidate", policy_role: "CANDIDATE_NOT_ADOPTED",
        contexts: [{ context: "DAILY", sections: [rule] }], bounds: {} } },
  }, { next: { safe_action: "reconcile the declared capacity" } }));
  const reply = candidatePlainLanguage("os_resume", candidateResume(raw));
  const conduct = reply.next.conduct!;
  assert.match(conduct, /read ONLY contract_pack.selected_pointers with the native apps, reads only and never a write/);
  assert.match(conduct, /ONCE more in this same turn/);
  assert.match(conduct, /never a third time/);
  assert.match(conduct, /a read plan is not evidence that its reads succeeded/);
  assert.match(conduct, /no readiness or permission may be inferred from a successful resume/);
  assert.ok(conduct.includes(P0_HOLD_CONDUCT));
  assert.ok(conduct.includes(HEALTH_ABSENT_CONDUCT));
  assert.deepEqual(reply.result, raw.result);
});

test("W7.3: normal capture exception remains evidence-only and yields to explicit read-only requests", () => {
  const raw = withUserSentence("os_resume", ok("RESUMED", {
    gate: { status: "OPEN" },
    external_actions: { unresolved: [{ ref: "pending", routing: { capability: "GMAIL_SEND" }, effect_status: "APPROVED" }] },
    contract_pack: { completeness: "COMPLETE", selected_pointers: [{ source: "GMAIL", selectors: [{ query: "bound" }] }] },
  }, { versions: { governing_spec: EXTERNAL_SPEC, governing_schema: EXTERNAL_SCHEMA,
    governing_control: "UNKNOWN", candidate_versions: [] }, next: { safe_action: "reconcile" } }));
  const reply = candidatePlainLanguage("os_resume", candidateResume(raw));
  const conduct = reply.next.conduct!;
  assert.match(conduct, /only a native capture reconciliation explicitly conducted below in this SAME reply may submit its narrowly served external_event_evidence/);
  assert.match(conduct, /An explicit read-only or no-change human request overrides ALL native capture instructions below/);
  assert.match(conduct, /its commit reply and stops override this answer branch/);
  assert.match(conduct, /call os_commit once with binding_handle and external_event_evidence only, no intent\/capability_evidence/);
  assert.ok(conduct.indexOf("overrides ALL native capture") < conduct.indexOf("For the remaining GMAIL_SEND intents only"));
  assert.equal(reply.next.prepare_intent, undefined);
  assert.deepEqual(reply.result, raw.result);
});

test("W7.3: pending configuration question does not replace a status or read-only request", () => {
  const question = "Quel résultat commercial concret veux-tu obtenir en priorité avec ton Sales OS ?";
  const intent = { action_class: "BUSINESS_CONFIG", summary: "record answer", mutations: [{ desired_changes: { Answer: "$answer" } }] };
  const raw = withUserSentence("os_resume", ok("RESUMED", {
    gate: { gate_key: "B0_DISCOVERY", status: "OPEN", formal_next_question: question },
    pending_step_input: { logical_resource_key: "SALES:BUSINESS_CONFIG", natural_key: "B0_DISCOVERY:PRIMARY_OUTCOME" },
    capability_completeness: { complete: true }, recovery_required: false, persistence_health: "PASS",
  }, { next: { safe_action: "answer the pending question", permitted_tool_call: "os_prepare", prepare_intent: intent } }));
  const before = structuredClone(raw);
  const reply = candidatePlainLanguage("os_resume", candidateResume(raw));
  const conduct = reply.next.conduct ?? "";
  assert.match(conduct, /pending configuration input, not a universal reply/);
  assert.match(conduct, /If the CURRENT message asks for status/);
  assert.match(conduct, /do not repeat the generic `say` or ask the configuration question again/);
  assert.match(conduct, /Call no os_commit/);
  assert.match(conduct, /On every later human message.*os_resume/);
  assert.ok(conduct.indexOf("If the CURRENT message asks for status") < conduct.indexOf("If it already holds one explicit"));
  assert.equal(reply.ask, question);
  assert.ok(reply.say?.includes(question));
  assert.deepEqual(reply.next.prepare_intent, intent);
  assert.deepEqual(reply.result, raw.result);
  assert.deepEqual(reply.observations, raw.observations);
  assert.deepEqual(raw, before);
});

test("W7.3: an operation request is not a missing business answer or permission to bypass setup", () => {
  const reply = candidateResume(withUserSentence("os_resume", ok("RESUMED", {
    gate: { gate_key: "B0_DISCOVERY", status: "OPEN", formal_next_question: "Quel objectif ?" },
  }, { next: { safe_action: "answer the pending question" } })));
  const conduct = reply.next.conduct ?? "";
  assert.match(conduct, /If the CURRENT message requests an operation instead of answering `ask`/);
  assert.match(conduct, /missing answer named by `ask`/);
  assert.match(conduct, /Never treat a launch request, yes or proceed as that business answer/);
  assert.match(conduct, /do not start or claim the operation started/);
  assert.match(conduct, /No intent was served/);
  assert.equal(reply.next.permitted_tool_call, undefined);
  assert.equal(reply.next.prepare_intent, undefined);
});

test("W7.3: question-loop guidance cannot replace a higher-priority hold, ledger or confirmation", () => {
  const ask = "Quel objectif ?";
  const held = candidateResume(hold("HOLD_CONFLICT", "administrator must check", ["hold evidence"], { ask }));
  const confirmed = candidateResume(ok("RESUMED", { pending_confirmation: { question: "C'est ta modification ?" } }, { ask, next: { safe_action: "confirm" } }));
  const completed = candidateResume(ok("RESUMED", { ledger_completed: [{ plan_id: "p", final_receipt_id: "r" }] }, { ask, next: { safe_action: "stop" } }));
  for (const reply of [held, confirmed, completed]) {
    assert.doesNotMatch(reply.next.conduct ?? "", /pending configuration input, not a universal reply/);
    assert.doesNotMatch(reply.next.conduct ?? "", /Answer that request in plain French from this fresh reply/);
  }
  assert.equal(held.status, "HOLD");
  assert.deepEqual(held.evidence, ["hold evidence"]);
  assert.match(completed.say ?? "", /enregistré et vérifié/);
});

test("W7.3: a completed journal offers a next human step without new write authority", () => {
  const raw = candidateResume(hold("HOLD_REQUIRED_CAPABILITY_INCOMPLETE", "verify reads", [], {
    observations: { ledger_completed: [{ plan_id: "owned", final_receipt_id: "final" }] },
  }));
  const reply = candidatePlainLanguage("os_resume", raw);
  assert.match(reply.next.conduct!, /one concrete next/);
  assert.doesNotMatch(reply.next.conduct!, /and nothing else;/);
  assert.match(reply.next.conduct!, /Then stop for this turn/);
  assert.equal(reply.next.permitted_tool_call, undefined);
  assert.deepEqual(reply.observations, raw.observations);
  assert.match(commitSentence({ kind: "IN_PROGRESS", origin: "INTENT", plan_id: "owned", phase: "STAGE1", reason: "BUDGET", writes_done: 0, writes_total: 4, warnings: [] }), /[Rr]épondez « Continue »/);
});

test("W7.1/plain-language: fixed system prose changes, business literals and evidence do not", () => {
  const question = "Le produit B0/setup est-il prêt ?";
  const base = withUserSentence("os_resume", hold("HOLD_GATE_UNSPECIFIED", "publish the step", ["contract not defined"], {
    ask: question, observations: { value: "B0/setup", receipt: "opaque-id" },
  }));
  const raw = withConduct("os_resume", { ...base, say: `${base.say} ${question}` });
  const before = structuredClone(raw);
  const spoken = candidatePlainLanguage("os_resume", raw);
  assert.match(spoken.say!, /^Je ne sais pas encore comment poursuivre cette étape/);
  assert.ok(spoken.say!.includes(question), "the canonical business question stays verbatim");
  assert.deepEqual({ ...spoken, say: raw.say, next: { ...spoken.next, conduct: raw.next.conduct } }, raw);
  assert.deepEqual(raw, before, "no mutation of the source envelope");
  assert.deepEqual(candidatePlainLanguage("os_resume", spoken), spoken, "idempotent per-reply voice");
  assert.ok(spoken.next.conduct!.includes(COLLABORATOR_VOICE));
  const ownWords = { ...raw, say: "Le produit B0/setup est bloqué." };
  assert.equal(candidatePlainLanguage("os_resume", ownWords).say, ownWords.say, "no blanket replacement in business text");
});

test("W7.1/plain-language: a binding stays silent and personal state comes from resume, not governance control", () => {
  const raw = withConduct("os_bind", ok("BOUND", { binding_handle: "opaque-handle" }, { next: { safe_action: "resume" } }));
  const reply = candidatePlainLanguage("os_bind", raw);
  assert.match(reply.next.conduct!, /Stay silent/);
  assert.match(reply.next.conduct!, /os_resume/);
  assert.match(reply.next.conduct!, /not os_control_status/);
  assert.deepEqual(reply.result, raw.result);
});

test("W7.1/plain-language: human handoff replaces the raw paste directive, not its structured state", () => {
  const raw = withConduct("os_handoff", ok("HANDOFF_READY", { terminal_text: "HANDOFF — SALES runtime opaque-id", next_action: "Appeler Léa", next_question: "Quel créneau ?", open_blocker: "UNKNOWN", state_fingerprint: "opaque-fingerprint", valid_while: "state_fingerprint unchanged" }, { next: { safe_action: "paste" } }));
  const reply = candidatePlainLanguage("os_handoff", raw);
  assert.deepEqual(reply.result, raw.result);
  assert.doesNotMatch(reply.next.conduct!, /Paste `terminal_text` unchanged/);
  assert.match(reply.next.conduct!, /next_action, next_question and open_blocker/);
  assert.match(reply.next.conduct!, /if the space has changed/);
  assert.match(reply.next.conduct!, /UNKNOWN stays unknown/);
  assert.match(reply.next.conduct!, /Never announce or execute a send/);
  assert.deepEqual(candidatePlainLanguage("os_handoff", reply), reply);
  const guarded = { ...raw, next: { ...raw.next, conduct: `${raw.next.conduct} ${P0_HOLD_CONDUCT} ${HEALTH_DECLARED_CONDUCT} ${OUTBOUND_CONDUCT}` } };
  const safe = candidatePlainLanguage("os_handoff", guarded);
  for (const rule of [P0_HOLD_CONDUCT, HEALTH_DECLARED_CONDUCT, OUTBOUND_CONDUCT]) assert.ok(safe.next.conduct!.includes(rule), "replace only the paste directive, preserve every extra restriction");
  assert.deepEqual(safe.result, guarded.result);
});

test("W7.1/plain-language: incomplete work is not saved, authorization holds and silent continuation stay intact", () => {
  const completed = [{ plan_id: "opaque-plan", final_receipt_id: "opaque-final" }];
  const held = candidatePlainLanguage("os_resume", candidateResume(ok("RESUMED", { ledger_completed: completed, durable_hold: { code: "HOLD_CONFLICT" } }, { next: { safe_action: "stop" } })));
  assert.match(held.say!, /enregistré et vérifié/);
  assert.match(held.say!, /autorisée/);
  assert.match(held.next.conduct!, /Do not submit any adoption or production intent/);
  const moving = candidatePlainLanguage("os_resume", candidateResume(ok("RESUMED", { setup_input_satisfied: true, effective_hold: "NONE", recovery_required: false, mutations: { incomplete_count: 0 }, external_intents_unresolved: 0 }, { next: { safe_action: "resume" } })));
  assert.doesNotMatch(moving.say!, /setup/);
  assert.match(moving.next.conduct!, /Say nothing yet/);
  assert.match(moving.next.conduct!, /Call os_commit ONCE/);
});

test("W7.1/receipt-voice: completion survives independent HOLD or unfinished work without granting progression", () => {
  const ledger_completed = [{ plan_id: "opaque-plan", final_receipt_id: "opaque-final" }];
  for (const extra of [{}, { durable_hold: { code: "HOLD_CONFLICT" } }, { adoption_in_progress: true }]) {
    const reply = candidateResume(ok("RESUMED", { ledger_completed, setup_input_satisfied: true,
      effective_hold: "NONE", recovery_required: false, mutations: { incomplete_count: 0 },
      external_intents_unresolved: 0, ...extra }, { next: { safe_action: "resume" } }));
    assert.match(reply.say ?? "", /enregistré et vérifié/);
    assert.equal(reply.next.permitted_tool_call, undefined);
    assert.doesNotMatch(reply.next.conduct ?? "", /Call os_commit ONCE/);
    if ("durable_hold" in extra) assert.match(reply.say ?? "", /autorisée/);
    if ("adoption_in_progress" in extra) assert.match(reply.say ?? "", /terminé/);
  }
  const held = candidateResume(hold("HOLD_CONFLICT", "stop", ["independent conflict"], {
    observations: { ledger_completed }, say: "Une autre modification reste bloquée.", next: { safe_action: "stop" } }));
  assert.equal(held.status, "HOLD");
  assert.match(held.say ?? "", /enregistré et vérifié/);
  assert.match(held.say ?? "", /autre modification reste bloquée/);
  assert.deepEqual(held.evidence, ["independent conflict"]);
});

test("PV-CONDUCT-001/a: every reply dispatched over the six tools carries a non-empty next.conduct, deterministically", async () => {
  const w = buildResumeWorld();
  const replies = [];
  replies.push(await dispatch("os_bind", {}, ctx, w.deps)); // HOLD_LANE_REQUIRED
  const b = await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps);
  replies.push(b);
  const h = handleOf(b);
  replies.push(await dispatch("os_resume", { binding_handle: h }, ctx, w.deps)); // RESUMED with ask
  replies.push(await dispatch("os_handoff", { binding_handle: h }, ctx, w.deps));
  replies.push(await dispatch("os_control_status", { binding_handle: h }, ctx, w.deps));
  replies.push(await dispatch("os_verify", { binding_handle: h, plan_id: "nope", phase: "TARGET" }, ctx, w.deps)); // ERROR_PLAN_NOT_FOUND
  replies.push(await dispatch("os_prepare", { binding_handle: h, intent: { action_class: "X" } }, ctx, w.deps)); // ERROR_INVALID_ARGUMENT
  for (const r of replies) {
    assert.ok(typeof r.next.conduct === "string" && r.next.conduct.length > 20, `${r.code} carries no conduct`);
    assert.ok(!/[0-9a-f]{32}/.test(r.next.conduct), `${r.code}: conduct leaks an id`);
  }
  // Same envelope ⇒ same conduct (a second identical resume).
  const again = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  assert.equal(again.next.conduct, replies[2]!.next.conduct);
  // The RESUMED reply with a question is the whole turn.
  assert.match(replies[2]!.next.conduct!, /Say `say` word for word and stop: it is the complete turn/);
  // A malformed call is corrected, never worked around.
  assert.match(replies[6]!.next.conduct!, /Your call was malformed/);
  assert.match(replies[6]!.next.conduct!, /never add authority fields/);
});

test("PV-CONDUCT-001/b: the descriptions are facts — short, declarative, without the imperatives the client would cache", () => {
  for (const n of TOOL_NAMES) {
    const d = toolDescriptions[n];
    // A fact sheet, not a page: os_bind is the longest because it also states that it is the entry point of every
    // conversation about the space — the one fact whose absence let a chat answer from memory (2026-09-23).
    assert.ok(d.length < 800, `${n}: ${d.length} chars`);
    assert.doesNotMatch(d, /\b(KEEP|NEVER|IMMEDIATELY|SILENTLY|DO NOT|ON PLAN_PREPARED|THE ORDINARY BUSINESS CASE)\b/, `${n} description still shouts conduct`);
    // One imperative survives, on os_bind only: « call this first ». Two chats on 2026-09-23 with factual-only
    // descriptions never called VERTIGO at all and hand-wrote Run, ledger and Manifest rows through the Notion
    // connector. The entry point is the one instruction that has to be read where the model reads first.
    if (n !== "os_bind") assert.doesNotMatch(d, /^Call this|\. Call this|\bcall os_(bind|resume|prepare|verify) (again|first|now)\b/i, `${n} description still tells the model when to call`);
    assert.doesNotMatch(d, /\bsends?\b|\bsending\b|e-?mail/i, `${n} must not read as able to send`);
  }
  assert.match(toolDescriptions.os_bind, /backend-resolved/);
  assert.match(toolDescriptions.os_bind, /never accepted from the caller/);
  for (const n of ["os_bind", "os_resume", "os_prepare", "os_verify"] as const) assert.match(toolDescriptions[n], /next\.conduct/, `${n} points at where the conduct now lives`);
});

test("PV-CONDUCT-001/c: the recovery continuation names the plan to verify and forbids adoption; a generic HOLD ends the turn", () => {
  const eligible = withConduct("os_resume", withUserSentence("os_resume", hold("HOLD_RECOVERY_REQUIRED", "continue", ["Run incomplete"], {
    observations: { open_backend_plan: { plan_id: "PLAN-OLD", owned_by_caller: true, expired: true } },
    next: { safe_action: "continue", permitted_tool_call: "os_verify" },
  })));
  assert.equal(eligible.say, undefined, "the continuation stays silent");
  const c = eligible.next.conduct ?? "";
  assert.match(c, /observed stored plan \(PLAN-OLD\)/);
  assert.match(c, /never rebuild its old intent, replay a write or show its id/);
  assert.match(c, /through os_commit/);
  assert.match(c, /Never execute a native Notion write/);

  const generic = withConduct("os_resume", withUserSentence("os_resume", hold("HOLD_RECOVERY_REQUIRED", "reconcile the Run by hand", ["Manifest declares Health Status DEGRADED"])));
  const g = generic.next.conduct ?? "";
  assert.ok(g.startsWith(VOICE));
  assert.match(g, /ONE plain sentence with the concrete thing a person must do/);
  assert.match(g, /Nothing was written\. Do not do the work by hand/);
  assert.doesNotMatch(g, /os_verify/);
});

test("PV-CONDUCT-001/d: an unspecified step, a changed row, an installation hold and a handoff each get their own conduct", () => {
  const unspecified = conductFor("os_prepare", withUserSentence("os_prepare", hold("HOLD_GATE_UNSPECIFIED", "publish the step")));
  assert.match(unspecified, /This step does not exist yet in the governing contract/);
  assert.match(unspecified, /do not ask the user anything about it, do not offer another way/);

  const confirm = conductFor("os_resume", withUserSentence("os_resume", ok("RESUMED", {
    gate: { gate_key: "B2_ICP", status: "OPEN", formal_next_question: "Qui ?", formal_next_action: "x" },
    pending_confirmation: { question: "J'ai vu que votre offre a changé depuis que je l'ai enregistrée. C'est bien votre décision ?", intent: { action_class: "RECONCILE" } },
  }, { next: { safe_action: "confirm", permitted_tool_call: "os_prepare", prepare_intent: { action_class: "RECONCILE" } } })));
  assert.match(confirm, /their space and their decision: never an incident, never a refusal/);
  assert.match(confirm, /if they confirm it is their decision, call os_prepare with next\.prepare_intent exactly as served, changing nothing/);
  assert.match(confirm, /If they say it was not them or the value is wrong, do not send it/);
  assert.match(confirm, /Never send that call without their answer/);

  const install = conductFor("os_prepare", withUserSentence("os_prepare", hold("HOLD_INSTALL_REQUIRED", "corriger la structure du clone", ["x"], { observations: { install_phase: "INSTALL_PENDING" } })));
  assert.match(install, /Installation is in progress and blocked here/);
  assert.match(install, /no repair steps, no ids, no property names/);

  const handoff = conductFor("os_handoff", ok("HANDOFF_READY", { terminal_text: "…" }, { next: { safe_action: "paste", permitted_tool_call: "os_resume" } }));
  assert.match(handoff, /Paste `terminal_text` unchanged, and nothing else/);

  const promoted = conductFor("os_verify", ok("TRANSACTION_VERIFIED", { plan_id: "P", install_phase: "reconnexion requise", manifest_promoted: true }, { next: { safe_action: "rebind", permitted_tool_call: "os_bind" } }));
  assert.match(promoted, /Silently call os_bind with no arguments, then os_resume/);
  assert.match(promoted, /Never reuse the installer handle/);

  const outbound = conductFor("os_verify", ok("TRANSACTION_VERIFIED", { plan_id: "P", step_moved: false, external_action: { send_authority: "NONE" } }, { next: { safe_action: "route" } }));
  assert.match(outbound, /NOT authorization and NOT proof of any send; this plugin cannot send/);
  assert.doesNotMatch(outbound, /NO intent/, "an outbound intent is routed, not followed by a derived step movement");

  const err = conductFor("os_verify", withUserSentence("os_verify", error("ERROR_PLAN_NOT_FOUND", "unknown plan_id", "prepare")));
  assert.match(err, /Stop\. Nothing changed/);
});

test("PV-CONDUCT-001/e: a conduct a handler set on purpose is kept, and the wrapper never touches anything else", () => {
  const e = ok("CONTROL_STATUS", { result: "CONFIRMED" }, { next: { safe_action: "report", conduct: "custom" } });
  const out = withConduct("os_control_status", e);
  assert.equal(out.next.conduct, "custom");
  const { next: _n, ...rest } = out;
  const { next: _m, ...orig } = e;
  assert.deepEqual(rest, orig);
});

test("PV-CONDUCT-001/f: the caller's own plan awaiting its writes is executed, never waited on or prepared again", () => {
  // 2026-09-23 17:48: a second os_prepare over an already-prepared answer answered HOLD_RUNTIME_BUSY with the
  // generic « wait » conduct while carrying the four rendered writes; the seller was told to wait for their own
  // plan to expire. Same trap on os_resume after a resend: the plan and its actions are served, the question is not due.
  const plan = { owned_by_caller: true, same_binding: true, expired: false, holds_mutation_lease: true, plan_id: "PLAN-OWN", plan_state: "AWAITING_STAGE1_WRITES", stage1_actions: [{ step: 1 }, { step: 2 }, { step: 3 }, { step: 4 }] };
  const busy = withConduct("os_prepare", withUserSentence("os_prepare", hold("HOLD_RUNTIME_BUSY", "wait for the active plan", ["active mutating plan"], { observations: { open_backend_plan: plan } })));
  assert.equal(busy.say, "Je reprends l'enregistrement déjà préparé.");
  const c = busy.next.conduct ?? "";
  assert.match(c, /already prepared/);
  assert.match(c, /never prepare again or wait for its expiry/);
  assert.match(c, /through os_commit/);
  assert.match(c, /Never execute a native Notion write/);
  assert.doesNotMatch(c, /Nothing was written\. Do not do the work by hand/);

  const resumed = withConduct("os_resume", withUserSentence("os_resume", ok("RESUMED", {
    gate: { gate_key: "B3_DATA", status: "OPEN", formal_next_question: "D'où viennent tes comptes ?", formal_next_action: "x" },
    pending_step_input: { logical_resource_key: "SALES:BUSINESS_CONFIG", natural_key: "B3_DATA:CANONICAL_SOURCE" },
    open_backend_plan: plan,
  }, { next: { safe_action: "answer", permitted_tool_call: "os_prepare", prepare_intent: { action_class: "COMMIT" } } })));
  const rc = resumed.next.conduct ?? "";
  assert.match(rc, /already prepared/);
  assert.match(rc, /The step's question is NOT due again/);
  assert.doesNotMatch(rc, /call os_prepare with it now/);

  // Someone else's plan, or an expired one, keeps the ordinary conduct: nothing to execute here.
  const foreign = withConduct("os_prepare", withUserSentence("os_prepare", hold("HOLD_RUNTIME_BUSY", "wait", [], { observations: { open_backend_plan: { ...plan, same_binding: false } } })));
  assert.equal(foreign.say, "Une autre modification est en cours sur cet espace. Je patiente qu'elle se termine.");
  assert.doesNotMatch(foreign.next.conduct ?? "", /ALREADY PREPARED/);
  const expired = withConduct("os_resume", withUserSentence("os_resume", ok("RESUMED", { gate: { gate_key: "B3_DATA", status: "OPEN", formal_next_question: "Q ?", formal_next_action: "x" }, open_backend_plan: { ...plan, expired: true } }, { next: { safe_action: "answer" } })));
  assert.doesNotMatch(expired.next.conduct ?? "", /ALREADY PREPARED/);
});

// ──────────────────────────── PT-VOICE-001 (W3.4 — BIND-FIRST CONDUCT) ────────────────────────────

const CANDIDATE_SKILL = readFileSync(new URL("../../../plugin/SKILL.candidate.md", import.meta.url), "utf8");
/** A claim that something is saved, verified or persisted — not an obligation (« doit être vérifié ») or a negation. */
const CLAIM = /\b(?:c'est|c'était|est|sont|a été|ont été|bien)\s+(?:déjà\s+)?(?:enregistré|vérifié|persisté)|\bfait\b/i;
const CODE_OR_ID = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\bos_[a-z_]+\b|[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-/;
const RUN_REF = "0123456789abcdef0123456789abcdef";

const section = (section_key: string, source_status: "PRESENT" | "ABSENT", items: readonly Record<string, unknown>[] = []) =>
  ({ section_key, source_key: section_key, source_status, projected_keys: [], items, served: items.length, available: items.length, omitted: 0, truncated_by: "NONE" });
const pack = (contexts: readonly { context: string; sections: readonly unknown[] }[]) =>
  ({ contract_pack: { selected_context: { policy_version: "CONTRACT_PACK/0.3.1-candidate", policy_role: "CANDIDATE_NOT_ADOPTED", contexts, bounds: {} } } });
/** A business resume without a gate key or a question, so `say` holds only what the harness itself voices. */
const resumedWith = (extra: Record<string, unknown>, gate: Record<string, unknown> = { status: "OPEN", formal_next_action: "Lancer la production du jour" }) =>
  withConduct("os_resume", withUserSentence("os_resume", ok("RESUMED", { gate, ...extra }, { next: { safe_action: "report" } })));
const persisted = (o: Record<string, unknown>) => commitSentence({ kind: "PERSISTED", repeated: false, step_moved: false, derived_move: "NONE", ...o } as never);

test("PT-VOICE-001/a: bind is the first call; nothing is claimed before PERSISTED; no id or code reaches the user; the four derived-movement sentences", () => {
  // First call, in the served candidate skill and in the os_bind description.
  assert.ok(CANDIDATE_SKILL.includes("the first call is `os_bind`, with no arguments"), "the candidate skill names os_bind as the first call");
  assert.match(toolDescriptions.os_bind, /^Call this first, before anything else, on the first message of every conversation/);

  // Nothing short of PERSISTED says saved, verified or persisted.
  const notPersisted = [
    commitSentence({ kind: "IN_PROGRESS" } as never),
    commitSentence({ kind: "INTERRUPTED" } as never),
    ...["HOLD_P0_PRODUCTION", "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE", "HOLD_ACTION_NOT_AUTHORIZED", "HOLD_INSTALL_REQUIRED", "HOLD_SERVER_WRITES_DISABLED", "HOLD_TARGET_NOT_WRITTEN"]
      .flatMap((code) => [true, false].map((wrote_anything) => commitSentence({ kind: "HELD", code, wrote_anything } as never))),
  ];
  for (const s of notPersisted) assert.doesNotMatch(s, CLAIM, `claims before PERSISTED: ${s}`);
  assert.ok(CANDIDATE_SKILL.includes("Never say « enregistré », « vérifié », « persisté », « fait » or anything equivalent before `os_commit` returns"));

  // The four sentences of the derived movement are commitSentence's own, and the skill quotes each verbatim.
  const four = [
    persisted({ step_moved: true, derived_move: "PERSISTED" }),
    persisted({ derived_move: "NONE" }),
    persisted({ derived_move: "DEFERRED" }),
    persisted({ repeated: true }),
  ];
  assert.equal(new Set(four).size, 4, "four distinct sentences");
  for (const s of four) {
    assert.match(s, CLAIM, "PERSISTED is the one outcome that may claim");
    assert.ok(CANDIDATE_SKILL.includes(`« ${s} »`), `the candidate skill lacks « ${s} »`);
  }
  // A held or in-flight derived movement never claims the step moved.
  assert.equal(persisted({ derived_move: "HELD" }), four[1]);
  for (const m of ["IN_PROGRESS", "INTERRUPTED"]) assert.equal(persisted({ derived_move: m }), four[2]);

  // No sentence the harness owns carries a code, a tool name or an id.
  const owned = [...Object.values(SAY), ...notPersisted, ...four, ...Object.values(P0_HOLD_SAY), ...Object.values(OUTBOUND_SAY),
    ...(Object.keys(PRODUCTION_HEALTH_LABEL) as DeclaredProductionHealth[]).map(productionHealthSay)];
  for (const s of owned) assert.doesNotMatch(s, CODE_OR_ID, `a user sentence leaks a code or an id: ${s}`);
});

test("PT-VOICE-001/a: every material EXTERNAL_ACTION state orients the collaborator, and an approval is never a send", () => {
  const states: OutboundState[] = ["PREPARED", "APPROVED", "NOT_OBSERVED", "AMBIGUOUS", "OBSERVED", "UNQUALIFIED"];
  for (const state of states) {
    const e = resumedWith(pack([{ context: "EXTERNAL_ACTION", sections: [section("EXTERNAL_INTENTS", "PRESENT", [{ action_key: "AK-7", action_type: "GMAIL_SEND", effect_status: state === "UNQUALIFIED" ? "SOMETHING_ELSE" : state, approval_state: "APPROVED", recipient: "lead@example.com", prepared_at: "2026-09-29T08:00:00Z" }])] }]));
    const say = e.say ?? "";
    assert.ok(say.includes(OUTBOUND_SAY[state]), `${state}: say does not orient: ${say}`);
    // The next useful step or one intelligible human question, never a send from here.
    assert.match(OUTBOUND_SAY[state], /décision|exécuteur|vérification humaine|ne sera pas renvoyé|ne sera renvoyé|rien ne part/);
    assert.doesNotMatch(say, /lead@example\.com|AK-7|GMAIL_SEND|APPROVED|SOMETHING_ELSE/, `${state}: say leaks a recipient, key or code`);
    assert.doesNotMatch(say, CODE_OR_ID);
    const c = e.next.conduct ?? "";
    assert.ok(c.includes(OUTBOUND_CONDUCT), `${state}: conduct lacks the outbound rule`);
    assert.match(c, /An approval is NOT authorization to send/);
  }
  assert.match(OUTBOUND_SAY.APPROVED, /une approbation n'est pas un envoi/);
  assert.doesNotMatch(OUTBOUND_SAY.APPROVED, /va partir|part maintenant|est envoyé|j'envoie/);
  // Several intents: one sentence per distinct state, in a fixed order.
  const two = resumedWith(pack([{ context: "EXTERNAL_ACTION", sections: [section("EXTERNAL_INTENTS", "PRESENT", [{ effect_status: "OBSERVED" }, { effect_status: "APPROVED" }, { effect_status: "APPROVED" }])] }]));
  assert.ok((two.say ?? "").indexOf(OUTBOUND_SAY.APPROVED) < (two.say ?? "").indexOf(OUTBOUND_SAY.OBSERVED));
  assert.equal((two.say ?? "").split(OUTBOUND_SAY.APPROVED).length, 2, "said once");
  // No outbound context: no outbound sentence, no outbound conduct.
  const none = resumedWith({});
  assert.doesNotMatch(none.next.conduct ?? "", /outbound message/);
});

test("PT-VOICE-001/b: production health is the OS's declaration, transported; ABSENT or omitted never reads as ready, and is no P0 HOLD", () => {
  for (const h of Object.keys(PRODUCTION_HEALTH_LABEL) as DeclaredProductionHealth[]) {
    const e = resumedWith(pack([{ context: "DAILY", sections: [section("DAILY_PRODUCTION_HEALTH", "PRESENT", [{ production_health: h, daily_run_ref: RUN_REF, evaluated_at: "2026-09-29T07:00:00+02:00" }])] }]));
    const say = e.say ?? "";
    assert.ok(say.includes(productionHealthSay(h)), `${h}: the declared health is not said`);
    assert.ok(!say.includes(h) && !say.includes(RUN_REF), `${h}: say leaks the value code or the Run reference`);
    const c = e.next.conduct ?? "";
    assert.ok(c.includes(HEALTH_DECLARED_CONDUCT));
    assert.ok(!c.includes(HEALTH_ABSENT_CONDUCT) && !c.includes(P0_HOLD_CONDUCT), `${h}: a declared health is not a hold`);
  }
  const absent = resumedWith(pack([{ context: "DAILY", sections: [section("DAILY_PRODUCTION_HEALTH", "ABSENT")] }]));
  const omitted = resumedWith(pack([{ context: "DAILY", sections: [section("DAILY_P0_RULES", "PRESENT", [])] }]));
  const undeclared = resumedWith(pack([{ context: "DAILY", sections: [section("DAILY_PRODUCTION_HEALTH", "PRESENT", [{ production_health: "READY" }])] }]));
  for (const [what, e] of [["ABSENT", absent], ["omitted", omitted], ["outside the three values", undeclared]] as const) {
    const say = e.say ?? "";
    assert.doesNotMatch(say, /santé de production|prête?\b/i, `${what}: say speaks of production health`);
    const c = e.next.conduct ?? "";
    assert.ok(c.includes(HEALTH_ABSENT_CONDUCT), `${what}: conduct does not forbid « production ready »`);
    assert.ok(!c.includes(P0_HOLD_CONDUCT), `${what}: an absent health is not a P0 HOLD`);
    assert.ok(say.includes("Prochaine action : Lancer la production du jour"), `${what}: nothing is held`);
  }
  // System health is not production health.
  const system = withUserSentence("os_control_status", ok("CONTROL_STATUS", { result: "OPERATIONAL_PASS" }, { next: { safe_action: "report" } }));
  assert.doesNotMatch(system.say ?? "", /production/i);
});

test("PT-VOICE-001/c: a P0 HOLD carried by selected_context forbids any production plan or recommendation, and offers only reconcile, repair or protect", () => {
  const rule = section("DAILY_P0_RULES", "PRESENT", [{ rule_id: "P0-PIPE-COVERAGE", rule: "Couverture du pipeline", default_disposition: "HOLD" }]);
  const drift = section("DAILY_RUNTIME_CONSTRAINTS", "PRESENT", [{ config: "DAILY_CAPACITY", declared_value: "40", reread_status: "DRIFT" }]);
  for (const [kind, sec] of [["P0_RULE", rule], ["CONSTRAINT_UNVERIFIABLE", drift]] as const) {
    const e = resumedWith(pack([{ context: "DAILY", sections: [sec] }]));
    const say = e.say ?? "";
    assert.ok(say.includes(P0_HOLD_SAY[kind]), `${kind}: the hold is not explained`);
    assert.match(say, /réconcilier l'existant, à reprendre un travail interrompu ou à protéger les prochains jours/);
    assert.doesNotMatch(say, /Prochaine action|Lancer la production/, `${kind}: a production action is still voiced`);
    assert.doesNotMatch(say, /P0-PIPE-COVERAGE|DAILY_CAPACITY|DRIFT|HOLD/, `${kind}: say leaks an id or a code`);
    const c = e.next.conduct ?? "";
    assert.ok(c.includes(P0_HOLD_CONDUCT), `${kind}: conduct does not forbid production`);
    assert.match(c, /produce NO production plan and NO production recommendation/);
    assert.match(c, /reconciling what exists, repairing an interrupted run, or protecting the next days/);
  }
  // The same hold travels on a turn that asks a question.
  const asking = withConduct("os_resume", withUserSentence("os_resume", ok("RESUMED", { gate: { status: "OPEN", formal_next_question: "Quelle source ?" }, ...pack([{ context: "DAILY", sections: [rule] }]) }, { next: { safe_action: "ask" } })));
  assert.ok((asking.next.conduct ?? "").includes(P0_HOLD_CONDUCT));
  // Proven constraints and a non-HOLD P0 disposition carry no hold: the harness transports, it never evaluates a rule.
  const clear = resumedWith(pack([{ context: "DAILY", sections: [
    section("DAILY_P0_RULES", "PRESENT", [{ rule_id: "P0-X", default_disposition: "ALERT" }]),
    section("DAILY_RUNTIME_CONSTRAINTS", "PRESENT", [{ config: "A", reread_status: "MATCH" }, { config: "B", reread_status: "NO_POINTER" }]),
  ] }]));
  assert.ok(!(clear.next.conduct ?? "").includes(P0_HOLD_CONDUCT));
  assert.ok((clear.say ?? "").includes("Prochaine action : Lancer la production du jour"));
});
