/**
 * PT-BIND-008 — Same user can bind META and SALES independently (INTEGRATION, blocking, PG1, PV0-005).
 * Procedure: create META binding and SALES binding for the same principal; call resume on each in alternating order.
 * Expected: handles stay pinned to different logical runtimes/lanes and never cross-contaminate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../../src/tools/handlers.ts";
import { buildWorld, handleOf, OWNER, T0 } from "./binding-fixtures.ts";
import { IDS } from "./sales-fixtures.ts";
import { ID as META_ID } from "./meta-fixtures.ts";

const ctx = { principal_id: OWNER.principal_id, now: T0 };

test("PT-BIND-008: META and SALES bindings of one principal stay pinned to their own lane and runtime across alternating resumes", async () => {
  const w = buildWorld();
  const meta = await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps);
  const sales = await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps);
  assert.equal(meta.code, "BOUND");
  assert.equal(sales.code, "BOUND");
  const hMeta = handleOf(meta);
  const hSales = handleOf(sales);
  assert.notEqual(hMeta, hSales);
  assert.equal(Buffer.from(hMeta, "base64url").length, 32);
  for (let i = 0; i < 3; i += 1) {
    const rm = await dispatch("os_resume", { binding_handle: hMeta }, ctx, w.deps);
    const rs = await dispatch("os_resume", { binding_handle: hSales }, ctx, w.deps);
    assert.equal((rm.binding as { lane: string }).lane, "META");
    assert.equal((rs.binding as { lane: string }).lane, "SALES");
    assert.equal((rm.observations as { root_ref: string }).root_ref, META_ID.rootA);
    assert.equal((rs.observations as { root_ref: string }).root_ref, IDS("rep-a").root);
    assert.equal((rm.binding as { runtime_id: string }).runtime_id, "RT-TEST-01");
    assert.equal((rs.binding as { runtime_id: string }).runtime_id, "SALESOS-FIXTURE-A");
    assert.equal((rm.binding as { binding_state: string }).binding_state, "BOUND");
    assert.equal((rs.binding as { binding_state: string }).binding_state, "BOUND");
  }
});

test("PT-BIND-008/b: a SALES-lane intent through the META handle is refused and the META binding stays META", async () => {
  const w = buildWorld();
  const meta = await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps);
  const h = handleOf(meta);
  const r = await dispatch("os_prepare", { binding_handle: h, intent: { action_class: "COMMIT", summary: "x", mutations: [{ logical_resource_key: "SALES:OS_STATE", operation: "UPDATE", record_selector: { natural_key: "CURRENT" }, desired_changes: { a: 1 } }] } }, ctx, w.deps);
  assert.equal(r.code, "HOLD_CROSS_LANE");
  assert.equal((r.binding as { lane: string }).lane, "META");
});

test("PT-BIND-008/c: the binding persists only a hash; the handle itself is never stored", async () => {
  const w = buildWorld();
  const meta = await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps);
  const h = handleOf(meta);
  const { hashHandle } = await import("../../src/binding/handle.ts");
  const rec = await w.deps.store.bindings.findByHandleHash(hashHandle(h));
  assert.ok(rec);
  assert.equal(JSON.stringify(rec).includes(h), false, "raw handle must not appear in the stored record");
  assert.equal(rec!.expires_at.getTime() - rec!.created_at.getTime(), 24 * 3600 * 1000, "absolute TTL is 24h");
});
