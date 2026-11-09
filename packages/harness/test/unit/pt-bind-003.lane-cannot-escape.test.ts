/**
 * PT-BIND-003 — Bound lane cannot escape via later arguments (ADVERSARIAL, blocking, PG1).
 * Procedure: create a META binding then attempt later tool calls with SALES-looking logical
 * resource/intent data; repeat in the inverse direction.
 * Expected: calls remain fixed to the bound runtime/lane or HOLD_CROSS_LANE; no implicit lane switch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../../src/tools/handlers.ts";
import { checkLaneScope } from "../../src/tools/lane.ts";
import { makeDeps, OWNER, seedBinding } from "./fixtures.ts";
import { buildWorld, handleOf, OWNER as W_OWNER, REP_B as W_REP_B, T0 } from "./binding-fixtures.ts";

async function metaWorld() {
  const w = buildWorld();
  const ctx = { principal_id: W_OWNER.principal_id, now: T0 };
  const handle = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps));
  return { w, ctx, handle };
}
async function salesWorld() {
  const w = buildWorld();
  const ctx = { principal_id: W_REP_B.principal_id, now: T0 };
  const handle = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps));
  return { w, ctx, handle };
}

function intent(keys: string[]) {
  return { action_class: "COMMIT", summary: "attempt", mutations: keys.map((k) => ({ logical_resource_key: k, operation: "UPDATE" as const, record_selector: { natural_key: "CURRENT" }, desired_changes: { x: 1 } })) };
}

test("PT-BIND-003: META binding refuses SALES-looking resources with HOLD_CROSS_LANE and stays on META", async () => {
  const { w, ctx, handle } = await metaWorld();
  const deps = w.deps;
  const r = await dispatch("os_prepare", { binding_handle: handle, intent: intent(["SALES:OS_STATE", "SALES:RUNS"]) }, ctx, deps);
  assert.equal(r.status, "HOLD");
  assert.equal(r.code, "HOLD_CROSS_LANE");
  assert.notEqual(r.binding, "UNKNOWN");
  assert.equal((r.binding as { lane: string }).lane, "META", "binding stays pinned to META; no implicit switch");
  const mixed = await dispatch("os_prepare", { binding_handle: handle, intent: intent(["META:MANIFEST", "SALES:OS_STATE"]) }, ctx, deps);
  assert.equal(mixed.code, "HOLD_CROSS_LANE", "a single foreign key poisons the whole intent");
});

test("PT-BIND-003/b: inverse direction — SALES binding refuses META resources", async () => {
  const { w, ctx, handle } = await salesWorld();
  const r = await dispatch("os_prepare", { binding_handle: handle, intent: intent(["META:MANIFEST"]) }, ctx, w.deps);
  assert.equal(r.code, "HOLD_CROSS_LANE");
  assert.equal((r.binding as { lane: string }).lane, "SALES");
});

test("PT-BIND-003/c: in-lane intents pass the lane gate; unscoped keys cannot be used to smuggle a lane", async () => {
  const { w, ctx, handle } = await metaWorld();
  const deps = w.deps;
  // In-lane key passes the lane gate and reaches the prepare engine (META:MANIFEST is state-last territory, so the engine refuses it as a resource).
  assert.equal((await dispatch("os_prepare", { binding_handle: handle, intent: intent(["META:MANIFEST"]) }, ctx, deps)).code, "HOLD_RESOURCE_UNKNOWN");
  assert.equal((await dispatch("os_prepare", { binding_handle: handle, intent: intent(["OS_STATE"]) }, ctx, deps)).code, "HOLD_RESOURCE_UNKNOWN");
  assert.equal((await dispatch("os_prepare", { binding_handle: handle, intent: intent(["sales:OS_STATE"]) }, ctx, deps)).code, "HOLD_RESOURCE_UNKNOWN", "case-variant prefixes are not a lane");
  assert.deepEqual(checkLaneScope("META", ["META:A", "META:B"]), { kind: "IN_LANE" });
});

test("PT-BIND-003/d: no tool accepts a lane, project, runtime or root argument after binding", async () => {
  const deps = makeDeps();
  const { handle } = await seedBinding(deps, OWNER, "META");
  for (const extra of [{ lane: "SALES" }, { project: "OTHER" }, { runtime_id: "x" }, { sales_root: "https://example.invalid" }, { current_gate: "G2" }]) {
    for (const name of ["os_resume", "os_handoff", "os_control_status"] as const) {
      const r = await dispatch(name, { binding_handle: handle, ...extra }, { principal_id: OWNER.principal_id }, deps);
      assert.equal(r.code, "ERROR_INVALID_ARGUMENT", `${name} must reject ${JSON.stringify(extra)}`);
    }
    const v = await dispatch("os_verify", { binding_handle: handle, plan_id: "p", phase: "TARGET", ...extra }, { principal_id: OWNER.principal_id }, deps);
    assert.equal(v.code, "ERROR_INVALID_ARGUMENT");
  }
});
