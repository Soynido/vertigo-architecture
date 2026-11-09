/**
 * PT-BIND-002 — Binding handle cannot be used by another principal (ADVERSARIAL, blocking, PG1, PV0-002).
 * Procedure: principal A creates a valid binding; principal B calls resume/prepare using A's handle.
 * Expected: ERROR_PRINCIPAL_MISMATCH; no runtime data/action authorized to B.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../../src/tools/handlers.ts";
import { lookupBinding, lookupPlan, lookupReceipt } from "../../src/auth/ownership.ts";
import { makeDeps, OWNER, REP_A, REP_B, seedBinding } from "./fixtures.ts";
import type { Plan } from "../../src/plans/store.ts";
import type { ReceiptRecord } from "../../src/verify/engine.ts";

const B = { principal_id: REP_B.principal_id };

test("PT-BIND-002: B using A's handle gets ERROR_PRINCIPAL_MISMATCH on every handle-taking tool", async () => {
  const deps = makeDeps();
  const { handle } = await seedBinding(deps, REP_A, "SALES");
  const calls = [
    ["os_resume", { binding_handle: handle }],
    ["os_prepare", { binding_handle: handle, intent: { action_class: "COMMIT", summary: "x", mutations: [{ logical_resource_key: "SALES:OS_STATE", operation: "UPDATE", record_selector: { natural_key: "CURRENT" }, desired_changes: { a: 1 } }] } }],
    ["os_verify", { binding_handle: handle, plan_id: "any", phase: "TARGET" }],
    ["os_handoff", { binding_handle: handle }],
    ["os_control_status", { binding_handle: handle }],
  ] as const;
  for (const [name, input] of calls) {
    const r = await dispatch(name, input, B, deps);
    assert.equal(r.status, "ERROR", `${name} must error`);
    assert.equal(r.code, "ERROR_PRINCIPAL_MISMATCH", `${name} must report principal mismatch`);
    assert.equal(r.binding, "UNKNOWN", `${name} must not disclose A's binding to B`);
    assert.deepEqual(r.observations, {}, `${name} must not disclose runtime data to B`);
  }
});

test("PT-BIND-002/b: the owner of the handle is accepted; state is checked only after identity", async () => {
  const { buildWorld, handleOf, T0, REP_B: W_REP_B } = await import("./binding-fixtures.ts");
  const w = buildWorld();
  const bctx = { principal_id: W_REP_B.principal_id, now: T0 };
  const handle = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, bctx, w.deps));
  const own = await dispatch("os_resume", { binding_handle: handle }, bctx, w.deps);
  assert.equal(own.code, "RESUMED"); // ownership + liveness passed and the control plane was read
  const { hashHandle: hh } = await import("../../src/binding/handle.ts");
  const rec = await w.deps.store.bindings.findByHandleHash(hh(handle));
  // Make it STALE: the owner sees HOLD_BINDING_STALE, a foreign principal still sees only PRINCIPAL_MISMATCH.
  await w.deps.store.bindings.setStatus(rec!.binding_id, "STALE");
  assert.equal((await dispatch("os_resume", { binding_handle: handle }, bctx, w.deps)).code, "HOLD_BINDING_STALE");
  assert.equal((await dispatch("os_resume", { binding_handle: handle }, { principal_id: "p-owner", now: T0 }, w.deps)).code, "ERROR_PRINCIPAL_MISMATCH");
});

test("PT-BIND-002/c: display names never authorize (two principals sharing a display name stay distinct)", async () => {
  const deps = makeDeps();
  assert.equal(OWNER.display_name, REP_A.display_name);
  const { handle } = await seedBinding(deps, OWNER, "META");
  assert.equal((await dispatch("os_resume", { binding_handle: handle }, { principal_id: REP_A.principal_id }, deps)).code, "ERROR_PRINCIPAL_MISMATCH");
});

test("PT-BIND-002/d: unknown handle, missing principal and expired binding are distinguished for the owner only", async () => {
  const deps = makeDeps();
  const { handle } = await seedBinding(deps, REP_A, "SALES", { expires_at: new Date(Date.now() - 1000) });
  assert.equal((await dispatch("os_resume", { binding_handle: "not-a-handle" }, { principal_id: REP_A.principal_id }, deps)).code, "ERROR_INVALID_ARGUMENT");
  assert.equal((await dispatch("os_resume", { binding_handle: handle }, { principal_id: undefined }, deps)).code, "ERROR_AUTH_REQUIRED");
  const expired = await dispatch("os_resume", { binding_handle: handle }, { principal_id: REP_A.principal_id }, deps);
  assert.equal(expired.code, "HOLD_BINDING_STALE");
  assert.equal((await dispatch("os_resume", { binding_handle: handle }, B, deps)).code, "ERROR_PRINCIPAL_MISMATCH");
});

test("PT-BIND-002/e: plan and receipt lookups validate principal ownership and plan linkage", async () => {
  const deps = makeDeps();
  const { handle, record: bindingA } = await seedBinding(deps, REP_A, "SALES");
  const { record: bindingB } = await seedBinding(deps, REP_B, "SALES");
  const now = new Date();
  const plan: Plan = {
    plan_id: "plan-a", plan_kind: "BUSINESS", principal_id: REP_A.principal_id, binding_id: bindingA.binding_id, project: "VERTIGO", lane: "SALES",
    runtime_logical_key: bindingA.runtime_logical_key, runtime_id: bindingA.runtime_id, runtime_generation: bindingA.runtime_generation,
    governing_spec_version: "fixture", governing_schema_version: "fixture", governing_control_version: "fixture", run_mode: "OPEN_NEW",
    execution_attempt_id: "att-1", created_at: now, expires_at: new Date(now.getTime() + 60_000), baseline_runtime_revision: "r0", operations: [],
    stage1_writes: [], finalization_writes: [], state_last_write: { ordinal: 0, symbol: "S", target_ref: "x", operation: "UPDATE", fields: {}, purpose: "STATE_LAST" }, plan_state: "AWAITING_STAGE1_WRITES",
  };
  await deps.store.plans.insert(plan);
  const receipt: ReceiptRecord = { receipt_id: "rcpt-a", type: "TARGET", plan_id: "plan-a", principal_id: REP_A.principal_id, runtime_id: plan.runtime_id, runtime_generation: plan.runtime_generation, observed_at: now, observations: {}, status: "VALID" };
  await deps.store.receipts.insert(receipt);

  const ownA = await lookupBinding(deps.store.bindings, handle, REP_A.principal_id, now);
  assert.ok(ownA.ok);
  assert.equal((await lookupPlan(deps.store.plans, "plan-a", REP_A.principal_id, bindingA)).ok, true);
  assert.deepEqual(await lookupPlan(deps.store.plans, "plan-a", REP_B.principal_id, bindingB), { ok: false, reason: "PRINCIPAL_MISMATCH" });
  assert.deepEqual(await lookupPlan(deps.store.plans, "plan-a", REP_A.principal_id, { ...bindingA, binding_id: "other-binding-of-a" }), { ok: false, reason: "PLAN_BINDING_MISMATCH" });
  assert.deepEqual(await lookupPlan(deps.store.plans, "plan-zzz", REP_A.principal_id, bindingA), { ok: false, reason: "PLAN_NOT_FOUND" });
  assert.equal((await lookupReceipt(deps.store.receipts, "rcpt-a", REP_A.principal_id, plan)).ok, true);
  assert.deepEqual(await lookupReceipt(deps.store.receipts, "rcpt-a", REP_B.principal_id, plan), { ok: false, reason: "PRINCIPAL_MISMATCH" });
  assert.deepEqual(await lookupReceipt(deps.store.receipts, "rcpt-a", REP_A.principal_id, { ...plan, plan_id: "plan-other" }), { ok: false, reason: "RECEIPT_PLAN_MISMATCH" });
});
