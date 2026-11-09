/**
 * PT-BIND-006 — SALES principal resolves only their own runtime (INTEGRATION, blocking, PG1, PV0-004).
 * Procedure: bind each principal with identical os_bind(VERTIGO, SALES) arguments.
 * Expected: each resolves their own backend-authorized runtime; caller never supplies rep name/runtime ID.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryPrincipalRegistry } from "../../src/auth/principal.ts";
import { loadConfig } from "../../src/config/index.ts";
import { InMemorySalesRuntimeRegistry } from "../../src/registry/salesRuntimes.ts";
import { createMemoryStore } from "../../src/store/memory.ts";
import { dispatch, type HarnessDeps } from "../../src/tools/handlers.ts";
import { buildSalesClient, IDS, registryEntries, repA, repB, REP_A, REP_B, REP_NOKEY, salesRegistries } from "./sales-fixtures.ts";

function deps(): HarnessDeps {
  return {
    config: loadConfig({ VERTIGO_META_SPEC_ROOT: "https://example.invalid/spec-root", HARNESS_ENV: "fixture", PRINCIPALS_FILE: "x" }),
    principals: new InMemoryPrincipalRegistry([REP_A, REP_B, REP_NOKEY]),
    store: createMemoryStore(),
    notion: buildSalesClient([repA(), repB()]),
    adapters: salesRegistries(),
    salesRegistry: new InMemorySalesRuntimeRegistry(registryEntries()),
  };
}
const ARGS = { project: "VERTIGO", lane: "SALES" } as const;

test("PT-BIND-006: identical os_bind arguments resolve two different reps to their own runtimes", async () => {
  const d = deps();
  const a = await dispatch("os_bind", ARGS, { principal_id: REP_A.principal_id }, d);
  const b = await dispatch("os_bind", ARGS, { principal_id: REP_B.principal_id }, d);
  assert.equal(a.code, "BOUND");
  assert.equal(b.code, "BOUND");
  const ra = a.observations as Record<string, unknown>;
  const rb = b.observations as Record<string, unknown>;
  assert.equal(ra["runtime_id"], "SALESOS-FIXTURE-A");
  assert.equal(rb["runtime_id"], "SALESOS-FIXTURE-B");
  assert.equal(ra["root_ref"], IDS("rep-a").root);
  assert.equal(rb["root_ref"], IDS("rep-b").root);
  assert.notEqual((a.binding as { runtime_generation: string }).runtime_generation, (b.binding as { runtime_generation: string }).runtime_generation);
  assert.equal((a.binding as { lane: string }).lane, "SALES");
});

test("PT-BIND-006/b: the caller cannot steer resolution with rep/runtime/root arguments", async () => {
  const d = deps();
  for (const extra of [{ rep: "rep-b" }, { runtime_id: "SALESOS-FIXTURE-B" }, { root: IDS("rep-b").root }, { owner: "Rep B" }, { rep_identity_key: "rep-b" }]) {
    const r = await dispatch("os_bind", { ...ARGS, ...extra }, { principal_id: REP_A.principal_id }, d);
    assert.equal(r.code, "ERROR_INVALID_ARGUMENT", `extra ${JSON.stringify(extra)} must be rejected`);
  }
});

test("PT-BIND-006/c: a principal without a rep identity cannot reach any runtime; display names play no part", async () => {
  const d = deps();
  assert.equal(REP_A.display_name, "Rep A");
  assert.equal(repB().owner, "Rep A", "rep B's Manifest carries rep A's display name and still resolves to B");
  const r = await dispatch("os_bind", ARGS, { principal_id: REP_NOKEY.principal_id }, d);
  assert.equal(r.status, "HOLD");
  assert.equal(r.code, "HOLD_RUNTIME_NOT_FOUND");
  assert.ok((r as unknown as { evidence: string[] }).evidence.includes("existence=UNKNOWN"));
});
