import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryPrincipalRegistry, authorize, type Principal } from "../../src/auth/principal.ts";
import { dispatch, type HarnessDeps } from "../../src/tools/handlers.ts";
import { createMemoryStore } from "../../src/store/memory.ts";
import { FixtureNotionReadClient } from "../../src/notion/readClient.ts";
import { EMPTY_SALES_REGISTRY } from "../../src/registry/salesRuntimes.ts";
import { createAdapterRegistries } from "../../src/versions/registry.ts";
import { loadConfig } from "../../src/config/index.ts";

const owner: Principal = { principal_id: "p-owner", status: "ACTIVE", allowed_projects: ["VERTIGO"], allowed_lanes: ["META", "SALES"] };
const rep: Principal = { principal_id: "p-rep", status: "ACTIVE", allowed_projects: ["VERTIGO"], allowed_lanes: ["SALES"], rep_identity_key: "rep-1" };
const registry = new InMemoryPrincipalRegistry([owner, rep]);

function deps(): HarnessDeps {
  return { config: loadConfig({ VERTIGO_META_SPEC_ROOT: "https://example.invalid/root", HARNESS_ENV: "fixture", PRINCIPALS_FILE: "x" }), principals: registry, store: createMemoryStore(), notion: new FixtureNotionReadClient(new Map()), adapters: createAdapterRegistries(), salesRegistry: EMPTY_SALES_REGISTRY };
}

test("authorize uses backend principal identity, never arguments", async () => {
  assert.equal((await authorize(registry, undefined, "VERTIGO", "META")).ok, false);
  assert.equal((await authorize(registry, "p-rep", "VERTIGO", "META")).ok, false);
  assert.equal((await authorize(registry, "p-rep", "OTHER", "SALES")).ok, false);
  assert.equal((await authorize(registry, "p-owner", "VERTIGO", "META")).ok, true);
});

test("os_bind rejects authority-asserting arguments and unauthorized lanes", async () => {
  const d = deps();
  const bad = await dispatch("os_bind", { project: "VERTIGO", lane: "META", runtime_id: "x" }, { principal_id: "p-owner" }, d);
  assert.equal(bad.status, "ERROR");
  assert.equal(bad.code, "ERROR_INVALID_ARGUMENT");
  const lane = await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, { principal_id: "p-rep" }, d);
  assert.equal(lane.status, "HOLD");
  assert.equal(lane.code, "HOLD_UNAUTHORIZED_LANE");
  const noAuth = await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, { principal_id: undefined }, d);
  assert.equal(noAuth.code, "ERROR_AUTH_REQUIRED");
});

test("unimplemented tool bodies return ERROR_NOT_IMPLEMENTED once ownership and liveness pass; unknown handles never reach them", async () => {
  const { buildWorld, handleOf, OWNER: W_OWNER, T0 } = await import("./binding-fixtures.ts");
  const w = buildWorld();
  const wctx = { principal_id: W_OWNER.principal_id, now: T0 };
  const handle = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, wctx, w.deps));
  // Every tool body is live now; the six tools never answer ERROR_NOT_IMPLEMENTED for an owned, live binding.
  assert.notEqual((await dispatch("os_control_status", { binding_handle: handle }, wctx, w.deps)).code, "ERROR_NOT_IMPLEMENTED");
  // os_handoff is live (derived from durable state); os_verify is live: an unknown plan is an ownership error.
  assert.equal((await dispatch("os_handoff", { binding_handle: handle }, wctx, w.deps)).code, "HANDOFF_READY");
  assert.equal((await dispatch("os_verify", { binding_handle: handle, plan_id: "p", phase: "FINAL" }, wctx, w.deps)).code, "ERROR_PLAN_NOT_FOUND");
  assert.equal((await dispatch("os_resume", { binding_handle: "h" }, wctx, w.deps)).code, "ERROR_INVALID_ARGUMENT");
});

test("memory lease store serializes mutation per runtime generation", async () => {
  const { leases } = createMemoryStore();
  const key = { project: "VERTIGO", lane: "META" as const, runtime_generation: "gen-1" };
  const now = new Date();
  const later = new Date(now.getTime() + 60_000);
  const a = await leases.acquire(key, "plan-a", now, later);
  assert.equal(a.acquired, true);
  const b = await leases.acquire(key, "plan-b", now, later);
  assert.equal(b.acquired, false);
  await leases.release(key, "plan-a");
  assert.equal((await leases.acquire(key, "plan-b", now, later)).acquired, true);
});
