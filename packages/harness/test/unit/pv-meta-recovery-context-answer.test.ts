import assert from "node:assert/strict";
import { test } from "node:test";
import { candidatePlainLanguage, candidateResume } from "../../src/tools/conduct.ts";
import { error, hold, type HoldEnvelope } from "../../src/tools/envelope.ts";
import { withUserSentence } from "../../src/tools/messages.fr.ts";
import { createAdapterRegistries } from "../../src/versions/registry.ts";
import { registerBuiltinMetaAdapters, type MetaSpecAdapter } from "../../src/versions/adapters/meta.ts";
import { registerBuiltinControlAdapters } from "../../src/versions/adapters/control.ts";

const diagnostic = /This reliable META recovery HOLD carries already-read state/;
// Read supported capability declarations, never embed a current runtime's version pins in the test.
const adapters = createAdapterRegistries();
registerBuiltinMetaAdapters(adapters.metaRuntime);registerBuiltinControlAdapters(adapters.control);
const meta = adapters.metaRuntime.resolve(adapters.metaRuntime.supported()[0]!) as MetaSpecAdapter;
const fixtureVersions = { governing_spec: meta.specVersion, governing_schema: meta.supportedSchemas[0]!,
  governing_control: adapters.control.supported()[0]!, candidate_versions: [] };

test("META diagnostic is disabled by default and does not affect any unselected caller", () => {
  const raw = historical();
  for (const reply of [candidateResume(raw), candidateResume(raw, false)]) {
    assert.doesNotMatch(reply.next.conduct!, diagnostic);
    assert.equal(reply.status, "HOLD");
    assert.deepEqual(reply.observations, raw.observations);
  }
});

/** Shape of the actual fresh owner Web failure; no receipt, account or completion is invented. */
function historical(): HoldEnvelope {
  const evidence = ["A historical integration Run is HOLD; no backend recovery plan is linked"];
  return withUserSentence("os_resume", hold("HOLD_RECOVERY_REQUIRED", "Ask the administrator to verify the historical integration", evidence, {
    binding: { project: "VERTIGO", lane: "META", binding_state: "BOUND", runtime_scope: "LIVE",
      runtime_logical_key: "VERTIGO/META", runtime_id: "META-HISTORICAL", runtime_generation: "generation" },
    versions: fixtureVersions,
    observations: {
      gate: { gate_key: "M4", status: "PROVISIONAL_PASS", source: "GATE_ROW",
        gate_last_edited_at: "2026-10-07T14:38:00.000Z",
        formal_blocker: "Business definition is complete; publication is withheld pending recovery",
        formal_next_action: "Keep the existing business package frozen; verify integration before publication" },
      current_run: { run_id: "Historical integration", ref: "historical-run", status: "HOLD",
        harness_plan_id: "UNKNOWN", last_required_written_at: "2026-09-23T17:10:00.000+02:00" },
      effective_hold: { code: "HOLD_RECOVERY_REQUIRED", evidence },
      recovery_required: true, next_safe_action: "Ask the administrator to verify the historical integration",
      open_backend_plan: "NONE", mutations: { incomplete_count: 0 },
    },
  }));
}

test("W7.3 META: a fresh read-only status request can use the already-served historical state without lifting recovery", () => {
  const raw = historical(), before = structuredClone(raw);
  const reply = candidatePlainLanguage("os_resume", candidateResume(raw, true));
  const conduct = reply.next.conduct!;
  assert.match(conduct, diagnostic);
  assert.match(conduct, /If the CURRENT human request asks for status/);
  assert.match(conduct, /Use ONLY this fresh reply's already-served observations/);
  assert.match(conduct, /Call no other tool/);
  assert.match(conduct, /no production plan or recommendation/);
  assert.match(conduct, /Do not reopen completed business framing/);
  assert.match(conduct, /The recovery HOLD remains active/);
  assert.match(conduct, /Only otherwise apply the original stop below/);
  assert.ok(conduct.indexOf("If the CURRENT human request") < conduct.indexOf("Say `say` word for word"));
  assert.equal(reply.status, "HOLD");assert.equal(reply.code, raw.code);
  assert.equal(reply.say, raw.say);assert.equal(reply.next.safe_action, raw.next.safe_action);
  assert.equal(reply.next.permitted_tool_call, undefined);assert.equal(reply.next.prepare_intent, undefined);
  assert.deepEqual(reply.observations, raw.observations);assert.deepEqual(reply.evidence, raw.evidence);
  assert.deepEqual(reply.binding, raw.binding);assert.deepEqual(reply.versions, raw.versions);
  assert.deepEqual(raw, before, "presentation never changes the historical Run, progression or facts");
});

test("W7.3 META: absent, contradictory, fixture, foreign or in-flight evidence keeps the original stop", () => {
  const cases: Array<[string, (e: HoldEnvelope) => HoldEnvelope]> = [
    ["unknown binding", e => ({ ...e, binding: "UNKNOWN" })],
    ["SALES", e => ({ ...e, binding: { ...e.binding as Exclude<HoldEnvelope["binding"], "UNKNOWN">, lane: "SALES" } })],
    ["fixture", e => ({ ...e, binding: { ...e.binding as Exclude<HoldEnvelope["binding"], "UNKNOWN">, runtime_scope: "FIXTURE" } })],
    ["stale", e => ({ ...e, binding: { ...e.binding as Exclude<HoldEnvelope["binding"], "UNKNOWN">, binding_state: "STALE" } })],
    ["unknown versions", e => ({ ...e, versions: "UNKNOWN" })],
    ["missing gate", e => ({ ...e, observations: { ...e.observations, gate: undefined } })],
    ["unknown gate", e => ({ ...e, observations: { ...e.observations, gate: { gate_key: "UNKNOWN", source: "GATE_ROW" } } })],
    ["missing run", e => ({ ...e, observations: { ...e.observations, current_run: "NOT_FOUND" } })],
    ["completed run", e => ({ ...e, observations: { ...e.observations, current_run: { ...(e.observations.current_run as object), status: "COMPLETED" } } })],
    ["linked recovery plan", e => ({ ...e, observations: { ...e.observations, current_run: { ...(e.observations.current_run as object), harness_plan_id: "real-plan" } } })],
    ["open backend plan", e => ({ ...e, observations: { ...e.observations, open_backend_plan: { plan_id: "in-flight" } } })],
    ["another hold", e => ({ ...e, observations: { ...e.observations, effective_hold: { code: "HOLD_CONFLICT", evidence: e.evidence } } })],
    ["different hold evidence", e => ({ ...e, observations: { ...e.observations, effective_hold: { code: e.code, evidence: ["different refusal"] } } })],
    ["unknown recovery", e => ({ ...e, observations: { ...e.observations, recovery_required: "UNKNOWN" } })],
    ["unknown safe action", e => ({ ...e, observations: { ...e.observations, next_safe_action: "" } })],
    ["pending ledger", e => ({ ...e, observations: { ...e.observations, ledger_continuation: { protocol: "LEDGER_CONTINUATION/1" } } })],
    ["durable adoption hold", e => ({ ...e, observations: { ...e.observations, durable_hold: { code: "HOLD_CONFLICT" } } })],
    ["already-directed tool", e => ({ ...e, next: { ...e.next, permitted_tool_call: "os_verify" } })],
    ["mutation intent", e => ({ ...e, next: { ...e.next, prepare_intent: { action_class: "RECONCILE" } } })],
  ];
  for (const [name, change] of cases) {
    const raw = change(historical()), before = structuredClone(raw), reply = candidateResume(raw, true);
    assert.doesNotMatch(reply.next.conduct!, diagnostic, name);
    assert.equal(reply.status, "HOLD", name);assert.deepEqual(reply.observations, raw.observations, name);
    assert.deepEqual(raw, before, name);
  }
});

test("W7.3 META: an authentication failure with identical observations never inherits a status-answer branch", () => {
  const raw = error("ERROR_PRINCIPAL_MISMATCH", "foreign binding", "stop", { observations: historical().observations });
  const reply = candidateResume(raw, true);
  assert.doesNotMatch(reply.next.conduct!, diagnostic);
  assert.equal(reply.status, "ERROR");assert.equal(reply.code, "ERROR_PRINCIPAL_MISMATCH");
});
