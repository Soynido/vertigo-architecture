/**
 * PT-BIND-009 — Runtime rotation stales old binding (ADVERSARIAL, blocking, PG1, PV0-005).
 * Procedure: bind runtime generation A, rotate locator/manifest fixture to generation B, then call a stateful
 * tool using the old handle. Expected: old binding becomes STALE/HOLD and never silently targets B; rebind resolves B.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../../src/tools/handlers.ts";
import { buildWorld, handleOf, OWNER, T0 } from "./binding-fixtures.ts";
import { ID as META_ID } from "./meta-fixtures.ts";
import { hashHandle } from "../../src/binding/handle.ts";

const ctx = { principal_id: OWNER.principal_id, now: T0 };

test("PT-BIND-009: after rotation the old handle HOLDs as STALE, discloses no B identity, and a rebind resolves B", async () => {
  const w = buildWorld();
  const first = await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps);
  const hA = handleOf(first);
  const genA = (first.binding as { runtime_generation: string }).runtime_generation;
  assert.equal((await dispatch("os_resume", { binding_handle: hA }, ctx, w.deps)).code, "RESUMED", "pre-rotation: binding is live");

  // Rotate: the locator now points at root B with a new pointer generation.
  w.rotateMeta({ rootId: META_ID.rootB, pointerGeneration: "2" });

  // First stateful use after rotation detects it; every later use sees the persisted STALE state. Either way: HOLD.
  const afterRotation = await dispatch("os_resume", { binding_handle: hA }, ctx, w.deps);
  assert.equal(afterRotation.status, "HOLD");
  assert.equal(afterRotation.code, "HOLD_BINDING_STALE_RUNTIME_ROTATED");
  assert.equal((afterRotation.binding as { binding_state: string }).binding_state, "STALE");
  assert.equal(JSON.stringify(afterRotation).includes(META_ID.rootB), false, "old handle never discloses/targets the replacement runtime");
  for (const name of ["os_handoff", "os_control_status"] as const) {
    const r = await dispatch(name, { binding_handle: hA }, ctx, w.deps);
    assert.equal(r.status, "HOLD", `${name} must HOLD on the old handle`);
    assert.equal(r.code, "HOLD_BINDING_STALE");
    assert.equal(JSON.stringify(r).includes(META_ID.rootB), false);
  }
  const v = await dispatch("os_verify", { binding_handle: hA, plan_id: "p", phase: "TARGET" }, ctx, w.deps);
  assert.equal(v.code, "HOLD_BINDING_STALE");
  const p = await dispatch("os_prepare", { binding_handle: hA, intent: { action_class: "COMMIT", summary: "x", mutations: [{ logical_resource_key: "META:MANIFEST", operation: "UPDATE", record_selector: { natural_key: "CURRENT" }, desired_changes: { a: 1 } }] } }, ctx, w.deps);
  assert.equal(p.code, "HOLD_BINDING_STALE", "mutation authority is gone with the stale binding");

  // STALE is persisted and terminal: a later call sees the persisted state, it is never re-pointed at B.
  const rec = await w.deps.store.bindings.findByHandleHash(hashHandle(hA));
  assert.equal(rec?.status, "STALE");
  assert.equal(rec?.runtime_generation, genA, "stored generation is never rewritten to B");
  assert.equal((await dispatch("os_resume", { binding_handle: hA }, ctx, w.deps)).code, "HOLD_BINDING_STALE");

  // Rebind resolves B with a different generation.
  const second = await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps);
  assert.equal(second.code, "BOUND");
  assert.notEqual((second.binding as { runtime_generation: string }).runtime_generation, genA);
  assert.equal((second.observations as { root_ref: string }).root_ref, META_ID.rootB);
  const hB = handleOf(second);
  assert.equal((await dispatch("os_resume", { binding_handle: hB }, ctx, w.deps)).code, "RESUMED", "new binding is live on B");
});

test("PT-BIND-009/b: a pointer-generation-only rotation (same root) also stales the binding", async () => {
  const w = buildWorld();
  const first = await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps);
  const hA = handleOf(first);
  w.rotateMeta({ pointerGeneration: "2" });
  assert.equal((await dispatch("os_resume", { binding_handle: hA }, ctx, w.deps)).code, "HOLD_BINDING_STALE_RUNTIME_ROTATED");
});

test("PT-BIND-009/c: SALES rotation via registry pointer generation stales the SALES binding the same way", async () => {
  const w = buildWorld();
  const first = await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps);
  const h = handleOf(first);
  const { registryEntries } = await import("./sales-fixtures.ts");
  w.setSalesRegistry(registryEntries().map((e) => (e.rep_identity_key === "rep-a" ? { ...e, pointer_generation: "2" } : e)));
  assert.equal((await dispatch("os_resume", { binding_handle: h }, ctx, w.deps)).code, "HOLD_BINDING_STALE_RUNTIME_ROTATED");
});

test("PT-BIND-009/d: TTL expiry ⇒ EXPIRED persisted; principal suspension ⇒ REVOKED persisted; neither returns to BOUND", async () => {
  const w = buildWorld();
  const first = await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps);
  const h = handleOf(first);
  const later = new Date(T0.getTime() + 24 * 3600 * 1000 + 1);
  const expired = await dispatch("os_resume", { binding_handle: h }, { principal_id: OWNER.principal_id, now: later }, w.deps);
  assert.equal(expired.code, "HOLD_BINDING_STALE");
  assert.equal((await w.deps.store.bindings.findByHandleHash(hashHandle(h)))?.status, "EXPIRED");
  assert.equal((await dispatch("os_resume", { binding_handle: h }, ctx, w.deps)).code, "HOLD_BINDING_STALE", "EXPIRED never flips back to BOUND even at an earlier clock");

  const second = await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps);
  const h2 = handleOf(second);
  w.setPrincipals([{ ...OWNER, status: "SUSPENDED" }]);
  const revoked = await dispatch("os_resume", { binding_handle: h2 }, ctx, w.deps);
  assert.equal(revoked.code, "ERROR_AUTH_REQUIRED");
  assert.equal((await w.deps.store.bindings.findByHandleHash(hashHandle(h2)))?.status, "REVOKED");
  w.setPrincipals([OWNER]);
  assert.equal((await dispatch("os_resume", { binding_handle: h2 }, ctx, w.deps)).code, "HOLD_BINDING_STALE", "REVOKED is terminal");
});
