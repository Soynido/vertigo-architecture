/**
 * PT-PRO-005 — backend half (PV0-020E): per-message app re-selection in ChatGPT makes the model run the opening ritual
 * again (a new os_bind). The backend has no notion of app selection: a rebind by the same principal resolves the SAME
 * logical/physical runtime (same runtime_id, generation, lane, scope), the fixture-contract intent from the new binding
 * targets only that runtime's META:INPUTS / control plane, exactly one active plan exists, the old binding stays a valid
 * read-only view and cannot verify the new plan, and an unwritten plan of the previous binding is superseded (never
 * duplicated) by the same intent re-issued from the new binding. The cold-chat half is run by the independent lane.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../../src/tools/handlers.ts";
import { runtimeScope } from "../../src/tools/scope.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import type { Plan } from "../../src/plans/store.ts";
import { handleOf, OWNER, T0 } from "./binding-fixtures.ts";
import { buildResumeWorld, R } from "./resume-fixtures.ts";

type Ok = Extract<Envelope, { status: "OK" }>;
type Summary = { runtime_id: string; runtime_generation: string; runtime_logical_key: string; lane: string; runtime_scope: string; binding_state: string };
const ctx = { principal_id: OWNER.principal_id, now: T0 };
const later = { principal_id: OWNER.principal_id, now: new Date(T0.getTime() + 60_000) };
const ANSWER = "TEST FIXTURE — offre principale : accompagnement de prospection B2B pour studios créatifs.";
const intent = { action_class: "COMMIT", summary: "persist F1 answer", mutations: [{ logical_resource_key: "META:INPUTS", operation: "UPSERT" as const, record_selector: { natural_key: "F1:PRIMARY_OFFER" }, desired_changes: { Input: "F1 — offre principale", "Gate Key": "F1", Question: "Quelle est l'offre principale que vous vendez, en une phrase ?", Answer: ANSWER } }] };
const summary = (e: Envelope) => e.binding as Summary;

test("PT-PRO-005/backend: a rebind after app re-selection resolves the same runtime; the new binding's plan targets only that runtime; one active plan", async () => {
  const w = buildResumeWorld();
  const a = await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps);
  const hA = handleOf(a);
  assert.equal((await dispatch("os_resume", { binding_handle: hA }, ctx, w.deps)).code, "RESUMED");
  // User re-selects the apps on a later message; the skill runs the opening ritual again.
  const b = await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, later, w.deps);
  const hB = handleOf(b);
  assert.notEqual(hA, hB, "a fresh opaque handle");
  for (const k of ["runtime_id", "runtime_generation", "runtime_logical_key", "lane", "runtime_scope"] as const) assert.equal(summary(b)[k], summary(a)[k], `${k} identical across the rebind`);
  const p = await dispatch("os_prepare", { binding_handle: hB, intent }, later, w.deps);
  assert.equal(p.code, "PLAN_PREPARED", JSON.stringify(p));
  assert.equal((p as Ok).result["replayed"], false, "a fresh plan, nothing to take over");
  assert.equal(summary(p).runtime_id, summary(a).runtime_id);
  const plan = (await w.deps.store.plans.get((p as Ok).result["plan_id"] as string)) as Plan;
  assert.equal(plan.runtime_generation, summary(a).runtime_generation);
  assert.equal(plan.run_mode, "OPEN_NEW");
  assert.deepEqual(plan.operations.map((o) => o.logical_resource_key), ["META:INPUTS"]);
  // Every stage-1 write lands inside the bound runtime's control plane or on an object created by an earlier write.
  const inside = new Set([R.metaRunsDs, R.metaLedgerDs, R.metaInputsDs]);
  for (const x of plan.stage1_writes) assert.ok(inside.has(x.target_ref) || x.target_ref.startsWith("$created:"), `stage-1 target ${x.target_ref} is inside the fixture runtime`);
  assert.equal((await w.deps.store.plans.findActive("VERTIGO", "META", plan.runtime_generation)).length, 1, "exactly one active plan on the runtime");
  // The previous connection still reads, but cannot verify the plan of another connection (no cross-binding drift).
  assert.equal((await dispatch("os_resume", { binding_handle: hA }, later, w.deps)).code, "RESUMED");
  assert.equal((await dispatch("os_verify", { binding_handle: hA, plan_id: plan.plan_id, phase: "TARGET" }, later, w.deps)).code, "HOLD_PLAN_BINDING_MISMATCH");
  // The real fixture id is classified as a FIXTURE scope (PT-PRO-005 expects runtime_scope FIXTURE to survive re-selection).
  assert.equal(runtimeScope("META-FIXTURE-PTPRO-20260918-01", {}), "FIXTURE");
});

test("PT-PRO-005/backend: an unwritten plan of the previous binding is superseded by the same intent from the new binding — one plan, no duplicate Run", async () => {
  const w = buildResumeWorld();
  const hA = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps));
  const p1 = await dispatch("os_prepare", { binding_handle: hA, intent }, ctx, w.deps);
  assert.equal(p1.code, "PLAN_PREPARED", JSON.stringify(p1));
  const plan1 = (p1 as Ok).result["plan_id"] as string;
  // Apps dropped before the native writes; the user re-selects them and answers again in the same words.
  const hB = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, later, w.deps));
  const p2 = await dispatch("os_prepare", { binding_handle: hB, intent }, later, w.deps);
  assert.equal(p2.code, "PLAN_PREPARED", JSON.stringify(p2));
  const plan2 = (p2 as Ok).result["plan_id"] as string;
  assert.notEqual(plan2, plan1);
  assert.equal((await w.deps.store.plans.get(plan1))!.plan_state, "SUPERSEDED", "the interrupted plan is superseded, not duplicated");
  assert.ok(p2.warnings.some((x) => x.includes("superseded")), JSON.stringify(p2.warnings));
  assert.equal((p2 as Ok).result["replayed"], false);
  const gen = summary(p2).runtime_generation;
  assert.equal((await w.deps.store.plans.findActive("VERTIGO", "META", gen)).length, 1, "one active plan");
  const p2plan = (await w.deps.store.plans.get(plan2)) as Plan;
  assert.equal(p2plan.run_mode, "OPEN_NEW", "nothing durable existed, so a fresh Run is opened once");
  assert.equal(p2plan.stage1_writes.filter((x) => x.purpose === "OPEN_RUN").length, 1);
  // The old binding can no longer drive the superseded plan.
  assert.equal((await dispatch("os_verify", { binding_handle: hA, plan_id: plan1, phase: "TARGET" }, later, w.deps)).status, "HOLD");
});
