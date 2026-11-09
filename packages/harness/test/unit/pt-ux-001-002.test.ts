/**
 * PV0-020B — non-tech conversational UX.
 * PT-UX-001: every code carries a deterministic French user sentence with no technical exposure; every envelope
 * returned by dispatch carries `say`, and `ask` only when a human answer is required.
 * PT-UX-002: a rep is never asked for project or lane; the owner (two lanes) gets exactly one question; authority
 * never broadens; the frozen input set is unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ERROR_CODES, HOLD_CODES, OK_CODES } from "../../src/errors/codes.ts";
import { APP_REMINDER, FIXTURE_SENTENCE, SAY } from "../../src/tools/messages.fr.ts";
import { dispatch } from "../../src/tools/handlers.ts";
import { TOOL_NAMES, toolInputSchemas } from "../../src/tools/surface.ts";
import { handleOf, OWNER, REP_B, T0 } from "./binding-fixtures.ts";
import { buildResumeWorld } from "./resume-fixtures.ts";

const TECHNICAL = /\b(HOLD_|ERROR_|[A-Z]{3,}_[A-Z_]+|os_[a-z]+|[0-9a-f]{32}|plan_id|receipt|binding_handle|JSON|TARGET|FINAL)\b/;

test("PT-UX-001/a: every OK, HOLD and ERROR code maps to a French sentence without codes, ids or tool vocabulary", () => {
  for (const code of [...OK_CODES, ...HOLD_CODES, ...ERROR_CODES]) {
    const s = SAY[code];
    assert.ok(typeof s === "string" && s.length >= 12, `${code} has a sentence`);
    assert.doesNotMatch(s, TECHNICAL, `${code}: "${s}" exposes technical vocabulary`);
    assert.match(s, /[.!?]$/, `${code}: sentence ends properly`);
  }
});

test("PT-UX-001/b: every dispatched envelope carries say; ask only when a human answer is required", async () => {
  const w = buildResumeWorld();
  const ctx = { principal_id: OWNER.principal_id, now: T0 };
  const bound = await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps);
  assert.equal(bound.say, `Connexion établie à votre espace de pilotage VERTIGO. ${FIXTURE_SENTENCE}`, "the fixture world (runtime id carries TEST) says the fixture caveat");
  assert.equal(bound.ask, undefined);
  const h = handleOf(bound);
  const resumed = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  assert.equal(resumed.code, "RESUMED");
  assert.equal(resumed.say, `Reprise faite depuis Notion. Étape en cours : T1. What do you sell? ${APP_REMINDER}`, "say = state, canonical question, reminder last (PV0-020E)");
  assert.equal(resumed.ask, "What do you sell?", "the gate's Next Question is the one question to ask");
  const prepared = await dispatch("os_prepare", { binding_handle: h, intent: { action_class: "COMMIT", summary: "s", mutations: [{ logical_resource_key: "META:GATES", operation: "UPDATE", record_selector: { natural_key: "T1" }, desired_changes: { "Next Question": "x" } }] } }, ctx, w.deps);
  assert.equal(prepared.code, "PLAN_PREPARED");
  assert.equal(prepared.say, "Je prépare l'enregistrement dans Notion.");
  assert.equal((prepared as unknown as { result: { stage1_actions?: unknown } }).result.stage1_actions, undefined);
  assert.doesNotMatch(prepared.say ?? "", TECHNICAL);
  const held = await dispatch("os_verify", { binding_handle: h, plan_id: (prepared as unknown as { result: { plan_id: string } }).result.plan_id, phase: "TARGET" }, ctx, w.deps);
  assert.equal(held.status, "HOLD");
  assert.equal(held.say, SAY[held.code]);
  assert.doesNotMatch(held.say ?? "", TECHNICAL);
  const bad = await dispatch("os_verify", { binding_handle: h, plan_id: "nope", phase: "FINAL", extra: 1 }, ctx, w.deps);
  assert.equal(bad.code, "ERROR_INVALID_ARGUMENT");
  assert.equal(bad.say, SAY.ERROR_INVALID_ARGUMENT);
  const handoff = await dispatch("os_handoff", { binding_handle: h }, ctx, w.deps);
  assert.equal(handoff.say, SAY.HANDOFF_READY);
  const control = await dispatch("os_control_status", { binding_handle: h }, ctx, w.deps);
  assert.ok(control.say && !TECHNICAL.test(control.say), control.say);
});

test("PT-UX-002: a rep is never asked; the owner gets one question; authority never broadens; frozen inputs unchanged", async () => {
  const w = buildResumeWorld();
  const rep = { principal_id: REP_B.principal_id, now: T0 };
  const r = await dispatch("os_bind", {}, rep, w.deps);
  assert.notEqual(r.code, "HOLD_LANE_REQUIRED", JSON.stringify(r));
  assert.ok(r.binding !== "UNKNOWN" && r.binding.lane === "SALES" && r.binding.project === "VERTIGO", "project and lane inferred from the rep's registry entry");
  assert.equal(r.ask, undefined);
  // A rep asking for META explicitly is still refused (inference never broadens authority).
  assert.equal((await dispatch("os_bind", { lane: "META" }, rep, w.deps)).code, "HOLD_UNAUTHORIZED_LANE");
  // The owner has two lanes: exactly one question, in plain language, then a normal bind with the answer.
  const owner = { principal_id: OWNER.principal_id, now: T0 };
  const q = await dispatch("os_bind", {}, owner, w.deps);
  assert.equal(q.code, "HOLD_LANE_REQUIRED");
  assert.equal(q.ask, "Souhaitez-vous travailler sur votre espace de pilotage VERTIGO ou votre espace de prospection ?");
  assert.equal(q.say, `${SAY.HOLD_LANE_REQUIRED} ${q.ask} ${APP_REMINDER}`, "the lane question is rendered inside say, reminder last");
  assert.equal((await dispatch("os_bind", { lane: "META" }, owner, w.deps)).code, "BOUND", "project inferred, lane answered");
  // Unknown principal still fails closed; authority fields are still rejected; the frozen key set is unchanged.
  assert.equal((await dispatch("os_bind", {}, { principal_id: "p-nobody", now: T0 }, w.deps)).code, "ERROR_AUTH_REQUIRED");
  assert.equal((await dispatch("os_bind", { lane: "META", root: "x" }, owner, w.deps)).code, "ERROR_INVALID_ARGUMENT");
  assert.deepEqual(Object.keys(toolInputSchemas.os_bind.shape).sort(), ["lane", "project"]);
  assert.deepEqual([...TOOL_NAMES].length, 5);
});
