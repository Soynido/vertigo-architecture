/**
 * PT-BIND-010 — Parallel bindings may read but do not imply shared conversation state (INTEGRATION, blocking, PG1, PV0-005).
 * Procedure: same principal creates two bindings to the same runtime, simulating two chats; resume through both.
 * Expected: both can read fresh canonical state; neither depends on hidden conversation identity; later mutation lease semantics are separate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../../src/tools/handlers.ts";
import { buildWorld, handleOf, OWNER, REP_B, T0 } from "./binding-fixtures.ts";
import { ID as META_ID } from "./meta-fixtures.ts";

const ctx = { principal_id: OWNER.principal_id, now: T0 };

test("PT-BIND-010: two bindings of one principal to the same runtime both read fresh state and are independent", async () => {
  const w = buildWorld();
  const a = await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps);
  const b = await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps);
  assert.equal(a.code, "BOUND");
  assert.equal(b.code, "BOUND");
  const hA = handleOf(a);
  const hB = handleOf(b);
  assert.notEqual(hA, hB, "two chats get two distinct handles");
  assert.equal((a.binding as { runtime_generation: string }).runtime_generation, (b.binding as { runtime_generation: string }).runtime_generation, "same runtime, same generation");
  const ra = await dispatch("os_resume", { binding_handle: hA }, ctx, w.deps);
  const rb = await dispatch("os_resume", { binding_handle: hB }, ctx, w.deps);
  for (const r of [ra, rb]) {
    assert.equal((r.binding as { binding_state: string }).binding_state, "BOUND");
    assert.equal((r.observations as { root_ref: string }).root_ref, META_ID.rootA);
  }
  // No hidden singleton: neither handle is affected by the other's use, and no per-principal "current lane" exists.
  const sales = await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps);
  const hS = handleOf(sales);
  assert.equal((await dispatch("os_resume", { binding_handle: hA }, ctx, w.deps)).binding && ((await dispatch("os_resume", { binding_handle: hA }, ctx, w.deps)).binding as { lane: string }).lane, "META");
  assert.equal(((await dispatch("os_resume", { binding_handle: hS }, ctx, w.deps)).binding as { lane: string }).lane, "SALES");
});

test("PT-BIND-010/b: rotation stales BOTH parallel bindings; expiry of one does not touch the other", async () => {
  const w = buildWorld();
  const a = await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps);
  const later = { principal_id: OWNER.principal_id, now: new Date(T0.getTime() + 3600 * 1000) };
  const b = await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, later, w.deps);
  const hA = handleOf(a);
  const hB = handleOf(b);
  // A expires one hour before B.
  const afterA = { principal_id: OWNER.principal_id, now: new Date(T0.getTime() + 24 * 3600 * 1000 + 1) };
  assert.equal((await dispatch("os_resume", { binding_handle: hA }, afterA, w.deps)).code, "HOLD_BINDING_STALE");
  assert.equal((await dispatch("os_resume", { binding_handle: hB }, afterA, w.deps)).code, "RESUMED", "B is still live");
  // Rotation stales every live binding on that runtime.
  w.rotateMeta({ pointerGeneration: "2" });
  assert.equal((await dispatch("os_resume", { binding_handle: hB }, afterA, w.deps)).code, "HOLD_BINDING_STALE_RUNTIME_ROTATED");
});

test("PT-BIND-010/c: cross-user use of a parallel handle is refused before any state disclosure; lease semantics untouched", async () => {
  const w = buildWorld();
  const a = await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps);
  const hA = handleOf(a);
  const foreign = await dispatch("os_resume", { binding_handle: hA }, { principal_id: REP_B.principal_id, now: T0 }, w.deps);
  assert.equal(foreign.code, "ERROR_PRINCIPAL_MISMATCH");
  assert.equal(foreign.binding, "UNKNOWN");
  // Two bindings never acquire anything: no lease exists after reads.
  const lease = await w.deps.store.leases.current({ project: "VERTIGO", lane: "META", runtime_generation: (a.binding as { runtime_generation: string }).runtime_generation }, T0);
  assert.equal(lease, undefined);
});
