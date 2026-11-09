/**
 * PT-SALES-001 — SALES bind resolves authenticated rep's own runtime (INTEGRATION, blocking; required by PV0-004,
 * targeted again by PG7/PV0-017). Procedure: call os_bind(VERTIGO, SALES) for each principal with identical
 * caller arguments. Expected: backend resolves each principal's authorized runtime from its own registry/Manifest evidence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSalesClient, IDS, registryEntries, repA, repB, REP_A, REP_B, salesResolver, SV } from "./sales-fixtures.ts";

test("PT-SALES-001: each rep resolves to the runtime whose Manifest satisfies the registry's identity claims", async () => {
  const client = buildSalesClient([repA(), repB()]);
  const a = await salesResolver(REP_A, client).resolve();
  const b = await salesResolver(REP_B, client).resolve();
  assert.equal(a.kind, "RESOLVED");
  assert.equal(b.kind, "RESOLVED");
  if (a.kind !== "RESOLVED" || b.kind !== "RESOLVED") return;
  assert.equal(a.runtime.runtime_id, "SALESOS-FIXTURE-A");
  assert.equal(b.runtime.runtime_id, "SALESOS-FIXTURE-B");
  assert.equal(a.runtime.root_ref, IDS("rep-a").root);
  assert.equal(a.runtime.manifest_ref, IDS("rep-a").manifestRow);
  assert.equal(a.runtime.logical_key, "TESTPROJ/SALES/rep-a");
  assert.deepEqual(a.runtime.observations["ownership_claims_verified"], ["instance_id", "gmail_identity"]);
  assert.equal((a.runtime.versions.governing_spec as { value: string }).value, SV.contract);
  assert.equal(a.runtime.lifecycle_state, "SETUP");
  assert.notEqual(a.runtime.runtime_generation, b.runtime.runtime_generation);
});

test("PT-SALES-001/b: ownership is verified by registry claims, not names — a swapped root fails ownership", async () => {
  const client = buildSalesClient([repA(), repB()]);
  // Registry for rep A wrongly points at rep B's root: the Manifest there does not satisfy A's claims.
  const r = await salesResolver(REP_A, client, [{ ...registryEntries()[0]!, root_ref: IDS("rep-b").root }]).resolve();
  assert.equal((r as { code: string }).code, "HOLD_RUNTIME_MANIFEST_MISMATCH");
  assert.ok((r as unknown as { evidence: string[] }).evidence.includes("owner_mapping_failed"));
  // No identity claim at all ⇒ ownership cannot be verified.
  const noClaim = await salesResolver(REP_A, client, [{ rep_identity_key: "rep-a", status: "KNOWN", root_ref: IDS("rep-a").root }]).resolve();
  assert.equal((noClaim as { code: string }).code, "HOLD_UNKNOWN_REQUIRED_FACT");
});

test("PT-SALES-001/c: Manifest must point back at the root; duplicate CURRENT rows HOLD; unsupported contract HOLDs", async () => {
  const other = IDS("rep-b").root;
  assert.equal((await salesResolver(REP_A, buildSalesClient([repA({ rootUrlOverride: other })])).resolve() as { code: string }).code, "HOLD_RUNTIME_MANIFEST_MISMATCH");
  assert.equal((await salesResolver(REP_A, buildSalesClient([repA({ duplicateCurrent: true })])).resolve() as { code: string }).code, "HOLD_RUNTIME_AMBIGUOUS");
  assert.equal((await salesResolver(REP_A, buildSalesClient([repA({ contract: SV.contractNext })])).resolve() as { code: string }).code, "HOLD_UNSUPPORTED_GOVERNING_VERSION");
  assert.equal((await salesResolver(REP_A, buildSalesClient([repA({ instanceStatus: "RETIRED" })])).resolve() as { code: string }).code, "HOLD_BOOTSTRAP_DISCOVERY");
});

test("PT-SALES-001/d: runtime generation changes when the registry pointer generation is bumped (rotation)", async () => {
  const client = buildSalesClient([repA()]);
  const g1 = await salesResolver(REP_A, client).resolve();
  const g2 = await salesResolver(REP_A, client, [{ ...registryEntries()[0]!, pointer_generation: "2" }]).resolve();
  assert.equal(g1.kind, "RESOLVED");
  assert.equal(g2.kind, "RESOLVED");
  if (g1.kind !== "RESOLVED" || g2.kind !== "RESOLVED") return;
  assert.notEqual(g1.runtime.runtime_generation, g2.runtime.runtime_generation);
});
