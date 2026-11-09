import assert from "node:assert/strict";
import { test } from "node:test";
import { candidateResume } from "../../src/tools/conduct.ts";
import { ok, type Envelope } from "../../src/tools/envelope.ts";
import { createAdapterRegistries } from "../../src/versions/registry.ts";
import { registerBuiltinMetaAdapters, type MetaSpecAdapter } from "../../src/versions/adapters/meta.ts";
import { registerBuiltinControlAdapters } from "../../src/versions/adapters/control.ts";
const registries = createAdapterRegistries();
registerBuiltinMetaAdapters(registries.metaRuntime); registerBuiltinControlAdapters(registries.control);
const adapter = registries.metaRuntime.resolve(registries.metaRuntime.supported()[0]!) as MetaSpecAdapter;
function current() {
  return ok("RESUMED", { runtime_state: "SETUP", health: "HEALTHY", persistence_health: "PASS", recovery_required: false,
    open_backend_plan: "NONE", mutations: { incomplete_count: 0 }, external_intents_unresolved: "NOT_APPLICABLE",
    current_run: { ref: "new-run", status: "COMPLETED", harness_plan_id: "real-plan" },
    historical_holds: [{ ref: "old-run", status: "HOLD" }], historical_mutations: [{ ref: "old-row", status: "FAILED" }],
    effective_hold: { code: "HOLD_UNKNOWN_REQUIRED_FACT", evidence: ["Historical manually entered provenance caveat remains"] },
    gate: { gate_key: "M4", status: "PROVISIONAL_PASS", source: "GATE_ROW", metadata_stale: true,
      gate_last_edited_at: "2026-10-07T14:38:00.000Z", formal_blocker: "publication remains unproved",
      formal_next_action: "Business complete; runtime recovery and publication", formal_next_question: "UNKNOWN" },
  }, { binding: { project: "VERTIGO", lane: "META", binding_state: "BOUND", runtime_scope: "LIVE", runtime_id: "owner-meta",
      runtime_logical_key: "VERTIGO/META", runtime_generation: "generation" },
    versions: { governing_spec: adapter.specVersion, governing_schema: adapter.supportedSchemas[0]!, governing_control: registries.control.supported()[0]!, candidate_versions: [] },
    say: "Je reprends votre espace. Prochaine action : Business complete; runtime recovery and publication.",
    observations: { root_ref: "owner-root" }, warnings: ["historical rows preserved"],
    next: { safe_action: "Old manually entered recovery caveat" } });
}
const marker = /Owner META current-state explanation/;
// Missing admission incorrectly serves a caveat-specific answer despite no current caveat.
for (const [label, hold] of [["cleared", "NONE"], ["omitted", undefined]] as const) {
  test(`owner caveat answer cannot invent an effective hold when it is ${label}`, () => {
    const raw = current();
    assert.equal(raw.status, "OK"); if (raw.status !== "OK") throw Error("fixture must be resumed");
    const noHold = { ...raw, result: { ...raw.result, effective_hold: hold } };
    const before = structuredClone(noHold);
    const reply = candidateResume(noHold, true);
    assert.doesNotMatch(reply.next.conduct!, marker);
    assert.deepEqual(reply, candidateResume(noHold, false), "use the existing presentation, not an invented caveat");
    assert.deepEqual(reply.result, noHold.result);
    assert.equal(reply.next.permitted_tool_call, undefined);
    assert.deepEqual(noHold, before);
  });
}
test("owner META current answer uses fresh facts, not the stale verbatim action; all facts and caveats remain intact", () => {
  const raw = current(), before = structuredClone(raw), reply = candidateResume(raw, true);
  assert.match(reply.next.conduct!, marker);
  assert.match(reply.next.conduct!, /CURRENT human request/);
  assert.match(reply.next.conduct!, /effective_hold remains binding/);
  assert.match(reply.next.conduct!, /never certify the original failed operations/);
  assert.match(reply.next.conduct!, /Call no other tool/);
  assert.match(reply.next.conduct!, /next human step/);
  assert.doesNotMatch(reply.say!, /Business|M4|runtime|publication\./);
  assert.equal(reply.status, "OK"); assert.equal(reply.code, raw.code);
  assert.deepEqual(reply.result, raw.result); assert.deepEqual(reply.observations, raw.observations);
  assert.deepEqual(reply.binding, raw.binding); assert.deepEqual(reply.versions, raw.versions); assert.deepEqual(reply.warnings, raw.warnings);
  assert.equal(reply.next.permitted_tool_call, undefined); assert.equal(reply.next.prepare_intent, undefined);
  assert.deepEqual(raw, before);
});
test("owner reads the freshly served source-only business block before declaring empty legacy sections to be missing facts", () => {
  for (const status of ["PARTIAL", "COMPLETE"]) {
    const raw = current(); if (raw.status !== "OK") throw Error("fixture must be resumed");
    const input = { ...raw, result: { ...raw.result, local_meta_operating_context: {
      status, trust: "SOURCE_DATA_ONLY", policy_role: "CANDIDATE_NOT_ADOPTED", effectivity: "NOT_EVALUATED",
      documents: [{ status: "PARTIAL", items: [{ text: "business fixture" }] }], tables: [{ rows: [{ values: { Title: "fixture" } }] }],
    } } };
    const before = structuredClone(input), reply = candidateResume(input, true);
    assert.match(reply.next.conduct!, /result\.local_meta_operating_context/);
    assert.match(reply.next.conduct!, /documents\[\]\.items\[\]\.text/);
    assert.match(reply.next.conduct!, /tables\[\]\.rows\[\]\.values/);
    assert.match(reply.next.conduct!, /empty legacy sections.*do not prove/i);
    assert.match(reply.next.conduct!, /PARTIAL/);
    assert.match(reply.next.conduct!, /NOT_EVALUATED/);
    assert.match(reply.next.conduct!, /Call no other tool/);
    assert.doesNotMatch(reply.next.conduct!, /business fixture/);
    assert.equal(reply.next.permitted_tool_call, undefined);
    assert.deepEqual(reply.result, input.result); assert.deepEqual(reply.observations, input.observations);
    assert.deepEqual(reply.binding, input.binding); assert.deepEqual(reply.versions, input.versions);
    assert.deepEqual(input, before);
    assert.doesNotMatch(candidateResume(input, false).next.conduct!, /result\.local_meta_operating_context/);
  }
});
test("unavailable or unqualified business payload does not gain the served-source instruction", () => {
  const raw = current(); if (raw.status !== "OK") throw Error("fixture must be resumed");
  const baseline = candidateResume(raw, true), meta = { status: "PARTIAL", trust: "SOURCE_DATA_ONLY",
    policy_role: "CANDIDATE_NOT_ADOPTED", effectivity: "NOT_EVALUATED", documents: [], tables: [] };
  for (const delta of [{ status: "UNAVAILABLE" }, { status: "NOT_SELECTED" }, { status: "UNKNOWN" },
    { trust: "AUTHORITATIVE" }, { policy_role: "ADOPTED" }, { effectivity: "VERIFIED" }, { documents: null }, { tables: {} }]) {
    const input = { ...raw, result: { ...raw.result, local_meta_operating_context: { ...meta, ...delta } } };
    assert.equal(candidateResume(input, true).next.conduct, baseline.next.conduct);
  }
});
test("current answer is disabled by default; malformed, foreign, pending and unsafe shapes keep exactly the old presentation", () => {
  const cases: Array<(e: Envelope) => Envelope> = [
    e => ({ ...e, binding: "UNKNOWN" }),
    e => ({ ...e, binding: { ...e.binding as Exclude<Envelope["binding"], "UNKNOWN">, lane: "SALES" } }),
    e => ({ ...e, binding: { ...e.binding as Exclude<Envelope["binding"], "UNKNOWN">, runtime_scope: "FIXTURE" } }),
    e => ({ ...e, binding: { ...e.binding as Exclude<Envelope["binding"], "UNKNOWN">, binding_state: "STALE" } }),
    e => ({ ...e, versions: "UNKNOWN" }),
    ...["health", "persistence_health", "recovery_required", "current_run", "gate", "open_backend_plan"].map(k =>
      (e: Envelope): Envelope => e.status === "OK" ? { ...e, result: { ...e.result, [k]: "UNKNOWN" } } : e),
    ...["adoption_in_progress", "install_only", "setup_input_satisfied"].map(k =>
      (e: Envelope): Envelope => e.status === "OK" ? { ...e, result: { ...e.result, [k]: true } } : e),
    e => e.status === "OK" ? { ...e, result: { ...e.result, durable_hold: { code: "HOLD_CONFLICT" } } } : e,
    e => ({ ...e, ask: "business question" }),
    e => ({ ...e, next: { ...e.next, permitted_tool_call: "os_commit" } }),
    e => ({ ...e, next: { ...e.next, prepare_intent: { action_class: "RECONCILE" } } }),
    e => e.status === "OK" ? { ...e, result: { ...e.result, external_intents_unresolved: 1 } } : e,
    e => e.status === "OK" ? { ...e, result: { ...e.result, external_intents_unresolved: "UNKNOWN" } } : e,
    e => e.status === "OK" ? { ...e, result: { ...e.result, ledger_completed: [{ plan_id: "p", final_receipt_id: "f" }] } } : e,
  ];
  assert.deepEqual(candidateResume(current()), candidateResume(current(), false));
  assert.doesNotMatch(candidateResume(current()).next.conduct!, marker);
  for (const transform of cases) {
    const raw = transform(current());
    assert.deepEqual(candidateResume(raw, true), candidateResume(raw, false));
  }
});
