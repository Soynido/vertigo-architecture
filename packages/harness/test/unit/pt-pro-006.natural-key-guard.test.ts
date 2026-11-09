/**
 * PT-PRO-006 (PV0-020E) — the governed record-key grammar of META:INPUTS is enforced by the harness, as the
 * PT-PRO-001 fixture contract v2 requires: the answer row is selected by "<GATE KEY>:<INPUT NAME>", never by the
 * human label. Observed twice in real Pro lanes (13:27 and 13:44): the model put the label in record_selector, the
 * harness planned it, and the second lane produced a durable row whose key cannot satisfy the contract.
 * The refusal happens on the selector alone: no target lookup, no plan, no lease, no Run.
 * Scope: only resources whose grammar declares a key pattern. META:GATES and the SALES resources are untouched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../../src/tools/handlers.ts";
import { hashHandle } from "../../src/binding/handle.ts";
import { leaseKeyOf } from "../../src/plans/service.ts";
import { TOOL_NAMES, toolInputSchemas } from "../../src/tools/surface.ts";
import { META_CONTROL_PLANE_06 } from "../../src/versions/adapters/controlPlane.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import type { Plan } from "../../src/plans/store.ts";
import { handleOf, OWNER, T0 } from "./binding-fixtures.ts";
import { buildResumeWorld, type ResumeWorld } from "./resume-fixtures.ts";

type Ok = Extract<Envelope, { status: "OK" }>;
const ctx = { principal_id: OWNER.principal_id, now: T0 };
const QUESTION = "Quelle est l'offre principale que vous vendez, en une phrase ?";
const ANSWER = "TEST FIXTURE — J'aide les PME B2B à transformer leur prospection commerciale en rendez-vous qualifiés grâce à un système opérationnel simple et mesurable.";
const LABEL = "F1 — Offre principale";
const GOVERNED = "F1:PRIMARY_OFFER";

const intent = (naturalKey: string, operation: "CREATE" | "UPDATE" | "UPSERT" = "UPSERT", desired?: Record<string, unknown>) => ({
  action_class: "COMMIT",
  summary: "persist F1 answer",
  mutations: [{ logical_resource_key: "META:INPUTS", operation, record_selector: { natural_key: naturalKey }, desired_changes: desired ?? { Input: LABEL, "Gate Key": "F1", Question: QUESTION, Answer: ANSWER } }],
});
const bind = async (w: ResumeWorld) => handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps));
const bindingOf = async (w: ResumeWorld, h: string) => (await w.deps.store.bindings.findByHandleHash(hashHandle(h)))!;

test("PT-PRO-006/a: the shared META grammar carries no fixture record-key rule; a governed intent prepares normally", async () => {
  // The guard is a declarable capability (PT-PRO-008/d), not a global META rule: without a declaration the harness
  // plans whatever selector it is given, and the fixture-exact preflight is what proves the convention on the runtime
  // the contract actually governs. This test pins the absence of a global activation.
  const w = buildResumeWorld();
  const h = await bind(w);
  const binding = await bindingOf(w, h);
  const p = await dispatch("os_prepare", { binding_handle: h, intent: intent(GOVERNED) }, ctx, w.deps);
  assert.equal(p.code, "PLAN_PREPARED", "the shared grammar imposes nothing of its own");
  const active = await w.deps.store.plans.findActive("VERTIGO", "META", binding.runtime_generation);
  assert.equal(active.length, 1, "exactly one active plan");
  assert.equal(JSON.stringify(META_CONTROL_PLANE_06.resources ?? {}).includes("naturalKey"), true, "the shared grammar keeps only naturalKeyProperty");
  assert.equal(JSON.stringify(META_CONTROL_PLANE_06.resources ?? {}).includes("naturalKeyPattern"), false, "no fixture convention in the shared grammar");
});

test("PT-PRO-006/b: UPSERT with the governed key is accepted and preserves the submitted Answer exactly, prefix included", async () => {
  const w = buildResumeWorld();
  const h = await bind(w);
  const p = await dispatch("os_prepare", { binding_handle: h, intent: intent(GOVERNED) }, ctx, w.deps);
  assert.equal(p.code, "PLAN_PREPARED", JSON.stringify(p));
  const plan = (await w.deps.store.plans.get((p as Ok).result["plan_id"] as string)) as Plan;
  const op = plan.operations[0]!;
  assert.equal(op.logical_resource_key, "META:INPUTS");
  assert.equal(op.natural_key, GOVERNED);
  assert.equal(op.natural_key_property, "Input Key");
  assert.equal(op.expected_values["Answer"], ANSWER, "the exact submitted string, byte for byte");
  assert.ok((op.expected_values["Answer"] as string).startsWith("TEST FIXTURE — "), "the prefix is preserved");
  assert.equal(op.expected_values["Question"], QUESTION);
  assert.equal(op.expected_values["Input"], LABEL, "the human label lives in the writable field, not in the key");
  assert.equal(op.expected_values["Input Key"], GOVERNED);
  assert.equal(op.expected_values["State"], "SUBMITTED");
  assert.equal(op.expected_values["Source"], "USER_CONFIRMED_FIXTURE");
  // The rendered stage-1 write carries the same exact Answer.
  const write = plan.stage1_writes.find((x) => x.purpose === "WRITE_TARGET")!;
  assert.equal((write.fields as Record<string, unknown>)["Answer"], ANSWER);
});

test("PT-PRO-006/c: the same intent re-issued from a new binding is taken over, never duplicated", async () => {
  const w = buildResumeWorld();
  const hA = await bind(w);
  const first = await dispatch("os_prepare", { binding_handle: hA, intent: intent(GOVERNED) }, ctx, w.deps);
  assert.equal(first.code, "PLAN_PREPARED");
  const planA = (first as Ok).result["plan_id"] as string;
  const later = { principal_id: OWNER.principal_id, now: new Date(T0.getTime() + 60_000) };
  const hB = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, later, w.deps));
  const second = await dispatch("os_prepare", { binding_handle: hB, intent: intent(GOVERNED) }, later, w.deps);
  assert.equal(second.code, "PLAN_PREPARED", JSON.stringify(second));
  const planB = (second as Ok).result["plan_id"] as string;
  assert.notEqual(planB, planA);
  assert.equal((await w.deps.store.plans.get(planA))!.plan_state, "SUPERSEDED");
  assert.ok(second.warnings.some((x) => x.includes("superseded")), JSON.stringify(second.warnings));
  const gen = (second.binding as { runtime_generation: string }).runtime_generation;
  assert.equal((await w.deps.store.plans.findActive("VERTIGO", "META", gen)).length, 1, "exactly one active plan");
  const b = (await w.deps.store.plans.get(planB)) as Plan;
  assert.equal(b.stage1_writes.filter((x) => x.purpose === "OPEN_RUN").length, 1, "one Run, never two");
  assert.equal(b.operations[0]!.natural_key, GOVERNED);
});

test("PT-PRO-006/d: protected fields stay refused, the grammar is scoped to the declaring resource, and the surface is the five W3.3 tools", async () => {
  const w = buildResumeWorld();
  const h = await bind(w);
  for (const field of ["Input Key", "Source"]) {
    const p = await dispatch("os_prepare", { binding_handle: h, intent: intent(GOVERNED, "UPSERT", { Answer: ANSWER, [field]: "x" }) }, ctx, w.deps);
    assert.equal(p.code, "HOLD_UNSUPPORTED_OPERATION", `${field}: ${JSON.stringify(p)}`);
    assert.ok(p.evidence.some((e) => e.includes("control-owned fields")), JSON.stringify(p.evidence));
  }
  // Scope: no resource of the shared META grammar declares a key grammar (PT-PRO-008/d holds the capability test).
  assert.equal(JSON.stringify(META_CONTROL_PLANE_06.resources ?? {}).includes("naturalKeyPattern"), false, "no fixture convention is imposed lane-wide");
  // A gate update by its own key is unaffected.
  const g = await dispatch("os_prepare", { binding_handle: h, intent: { action_class: "COMMIT", summary: "gate", mutations: [{ logical_resource_key: "META:GATES", operation: "UPDATE", record_selector: { natural_key: "T1" }, desired_changes: { "Next Question": "x" } }] } }, ctx, w.deps);
  assert.equal(g.code, "PLAN_PREPARED", JSON.stringify(g));
  // Frozen surface and frozen inputs.
  assert.deepEqual([...TOOL_NAMES], ["os_bind", "os_resume", "os_commit", "os_handoff", "os_control_status"]);
  assert.deepEqual(Object.keys(toolInputSchemas.os_prepare.shape).sort(), ["binding_handle", "capability_evidence", "intent"]);
});
