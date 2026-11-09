/**
 * PT-BIND-001 — Unauthorized lane is rejected (UNIT, blocking, gate PG1, ticket PV0-002).
 * Procedure: authenticate a SALES-only principal and call os_bind(VERTIGO, META).
 * Expected: HOLD_UNAUTHORIZED_LANE or equivalent; no binding created.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../../src/tools/handlers.ts";
import { hashHandle } from "../../src/binding/handle.ts";
import { makeDeps, REP_A, SUSPENDED } from "./fixtures.ts";

test("PT-BIND-001: SALES-only principal calling os_bind(VERTIGO, META) gets HOLD_UNAUTHORIZED_LANE and no binding exists", async () => {
  const deps = makeDeps();
  let inserted = 0;
  const realInsert = deps.store.bindings.insert.bind(deps.store.bindings);
  deps.store.bindings.insert = async (r) => { inserted += 1; return realInsert(r); };

  const r = await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, { principal_id: REP_A.principal_id }, deps);
  assert.equal(r.status, "HOLD");
  assert.equal(r.code, "HOLD_UNAUTHORIZED_LANE");
  assert.equal(inserted, 0, "no binding may be created");
  assert.equal(await deps.store.bindings.findByHandleHash(hashHandle("anything")), undefined);
});

test("PT-BIND-001/b: lane authority cannot be escalated through arguments (lane enum, no extra keys)", async () => {
  const deps = makeDeps();
  const bogusLane = await dispatch("os_bind", { project: "VERTIGO", lane: "SALES_OWNER" }, { principal_id: REP_A.principal_id }, deps);
  assert.equal(bogusLane.code, "ERROR_INVALID_ARGUMENT");
  const withOwner = await dispatch("os_bind", { project: "VERTIGO", lane: "META", owner: "p-owner" }, { principal_id: REP_A.principal_id }, deps);
  assert.equal(withOwner.code, "ERROR_INVALID_ARGUMENT");
});

test("PT-BIND-001/c: inactive principal and unknown project are refused before any resolution", async () => {
  const deps = makeDeps();
  assert.equal((await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, { principal_id: SUSPENDED.principal_id }, deps)).code, "ERROR_AUTH_REQUIRED");
  assert.equal((await dispatch("os_bind", { project: "OTHER", lane: "SALES" }, { principal_id: REP_A.principal_id }, deps)).code, "ERROR_PROJECT_UNKNOWN");
  assert.equal((await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, { principal_id: "p-nobody" }, deps)).code, "ERROR_AUTH_REQUIRED");
});
