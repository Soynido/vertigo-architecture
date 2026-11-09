/**
 * PT-BIND-007 — Template, NOT_YET_CREATED and NOT_FOUND are distinct (UNIT, blocking, PG1, PV0-004).
 * Procedure: (a) template page found but no instance, (b) explicit human/registry not-yet-created state,
 * (c) discovery finds nothing without nonexistence proof.
 * Expected: template rejected as runtime; NOT_YET_CREATED and NOT_FOUND/UNKNOWN remain distinct machine states.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSalesClient, IDS, registryEntries, repA, REP_A, REP_B, REP_C, salesResolver, templateSpec } from "./sales-fixtures.ts";

test("PT-BIND-007/a: a template root is refused as a runtime (HOLD_RUNTIME_TEMPLATE_NOT_INSTANCE), even when the registry points at it", async () => {
  const client = buildSalesClient([templateSpec()]);
  const r = await salesResolver(REP_A, client, [{ rep_identity_key: "rep-a", status: "KNOWN", root_ref: IDS("template").root, expected_instance_id: "TEMPLATE-UNBOUND" }]).resolve();
  assert.equal(r.kind, "HOLD");
  assert.equal((r as { code: string }).code, "HOLD_RUNTIME_TEMPLATE_NOT_INSTANCE");
  const ev = (r as unknown as { evidence: string[] }).evidence.join(" ");
  assert.match(ev, /template marker/);
  assert.match(ev, /Install State UNBOUND/);
  // Each marker alone is sufficient.
  const byTitleOnly = buildSalesClient([templateSpec({ instanceId: "SALESOS-FIXTURE-T", owner: "Someone", installState: "SETUP" })]);
  assert.equal((await salesResolver(REP_A, byTitleOnly, [{ rep_identity_key: "rep-a", status: "KNOWN", root_ref: IDS("template").root, expected_instance_id: "SALESOS-FIXTURE-T" }]).resolve() as { code: string }).code, "HOLD_RUNTIME_TEMPLATE_NOT_INSTANCE");
});

test("PT-BIND-007/b: explicit registry NOT_YET_CREATED is its own state and is not a NOT_FOUND", async () => {
  const r = await salesResolver(REP_C, buildSalesClient([repA()])).resolve();
  assert.equal(r.kind, "HOLD");
  assert.equal((r as { code: string }).code, "HOLD_RUNTIME_NOT_YET_CREATED");
  assert.ok((r as unknown as { evidence: string[] }).evidence.includes("existence=NOT_YET_CREATED"));
});

test("PT-BIND-007/c: no registry entry ⇒ UNKNOWN (no nonexistence proof); dangling registry root ⇒ NOT_FOUND (proof)", async () => {
  const client = buildSalesClient([repA()]);
  const unknown = await salesResolver(REP_B, client, [registryEntries()[0]!]).resolve();
  assert.equal((unknown as { code: string }).code, "HOLD_RUNTIME_NOT_FOUND");
  assert.ok((unknown as unknown as { evidence: string[] }).evidence.includes("existence=UNKNOWN"));
  const dangling = await salesResolver(REP_B, client, [{ rep_identity_key: "rep-b", status: "KNOWN", root_ref: IDS("rep-b").root, expected_instance_id: "x" }]).resolve();
  assert.equal((dangling as { code: string }).code, "HOLD_RUNTIME_NOT_FOUND");
  assert.ok((dangling as unknown as { evidence: string[] }).evidence.includes("existence=NOT_FOUND"));
  const archived = await salesResolver(REP_A, buildSalesClient([repA({ archivedRoot: true })])).resolve();
  assert.ok((archived as unknown as { evidence: string[] }).evidence.includes("existence=NOT_FOUND"));
});

test("PT-BIND-007/d: the three outcomes are pairwise distinct machine states and none resolves", async () => {
  const codes = new Set<string>();
  codes.add((await salesResolver(REP_A, buildSalesClient([templateSpec()]), [{ rep_identity_key: "rep-a", status: "KNOWN", root_ref: IDS("template").root, expected_instance_id: "TEMPLATE-UNBOUND" }]).resolve() as { code: string }).code);
  codes.add((await salesResolver(REP_C, buildSalesClient([])).resolve() as { code: string }).code);
  codes.add((await salesResolver(REP_B, buildSalesClient([]), []).resolve() as { code: string }).code);
  assert.deepEqual([...codes].sort(), ["HOLD_RUNTIME_NOT_FOUND", "HOLD_RUNTIME_NOT_YET_CREATED", "HOLD_RUNTIME_TEMPLATE_NOT_INSTANCE"]);
});
