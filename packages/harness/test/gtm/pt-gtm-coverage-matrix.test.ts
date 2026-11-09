/**
 * GTM-W03 — coverage contract and catalog validation.
 *
 * Proves that the fixture package materializes every required branch identifier exactly once, that each branch's
 * frozen TARGET and FINAL compare sets are reproduced from the world by the oracles, and that the package claims
 * availability only — never a PT-GTM verdict.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CANDIDATE_MARKERS, GOVERNANCE_UNTOUCHED_FAMILIES, markerLabel, RESOURCE_CATALOG, RESULT_SEMANTICS, resourceSpec } from "./catalog.ts";
import { BASELINE_SHAPE, buildGtmWorld, COLLECTION_RESOURCE, type GtmWorld } from "./world.ts";
import { BRANCHES, evaluateBranch, REQUIRED_BRANCH_IDS } from "./matrix.ts";

const world = buildGtmWorld();

test("GTM-W03/coverage: the 68 required branch identifiers are materialized exactly once", () => {
  assert.equal(REQUIRED_BRANCH_IDS.length, 68);
  const ids = BRANCHES.map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length, "no branch identifier is declared twice");
  assert.deepEqual([...ids].sort(), [...REQUIRED_BRANCH_IDS].sort());
  const perCase = new Map<string, number>();
  for (const id of ids) {
    const head = id.split("/")[0] as string;
    perCase.set(head, (perCase.get(head) ?? 0) + 1);
  }
  assert.deepEqual(Object.fromEntries([...perCase.entries()].sort()), {
    "PT-GTM-001": 3, "PT-GTM-002": 4, "PT-GTM-003": 5, "PT-GTM-004": 5, "PT-GTM-005": 4, "PT-GTM-006": 5,
    "PT-GTM-007": 4, "PT-GTM-008": 5, "PT-GTM-009": 4, "PT-GTM-010": 4, "PT-GTM-011": 5, "PT-GTM-012": 8,
    "PT-GTM-013": 6, "PT-GTM-014": 6,
  });
});

test("GTM-W03/compare-sets: every branch reproduces its frozen TARGET and FINAL compare sets", () => {
  for (const b of BRANCHES) {
    const { target, final } = evaluateBranch(b, buildGtmWorld());
    assert.deepEqual(target, b.expected_target, `${b.id} TARGET compare set`);
    assert.deepEqual(final, b.expected_final, `${b.id} FINAL compare set`);
    assert.ok(b.admits.length > 0, `${b.id} names the admitted semantics it materializes`);
    assert.ok(b.resources.every((r) => resourceSpec(r) !== undefined), `${b.id} only names catalogued resources`);
  }
});

test("GTM-W03/result: the package proves availability, never a PT-GTM PASS", () => {
  for (const b of BRANCHES) assert.equal(b.result_semantics, RESULT_SEMANTICS);
  assert.equal(RESULT_SEMANTICS, "FIXTURE_AND_ORACLE_AVAILABLE");
  const serialized = JSON.stringify(BRANCHES.map((b) => ({ id: b.id, title: b.title, result: b.result_semantics, canary: b.real_read_canary })));
  assert.equal(/"result":"PASS"/.test(serialized), false);
  assert.equal(/PT-GTM-\d{3}[^"]*PASS/.test(serialized), false);
  const deferred = BRANCHES.filter((b) => b.real_read_canary !== undefined).map((b) => b.id.split("/")[0]);
  assert.deepEqual([...new Set(deferred)].sort(), ["PT-GTM-011", "PT-GTM-012", "PT-GTM-013"]);
  for (const b of BRANCHES.filter((x) => ["PT-GTM-011", "PT-GTM-012", "PT-GTM-013"].includes(x.id.split("/")[0] as string))) {
    assert.equal(b.real_read_canary, "DEFERRED_GTM_G3", `${b.id} keeps its real per-principal read deferred`);
  }
});

test("GTM-W03/catalog: every collection is catalogued and every natural key is unique", () => {
  const catalogued = new Set(RESOURCE_CATALOG.map((r) => r.resource_key));
  for (const [collection, resource_key] of Object.entries(COLLECTION_RESOURCE)) {
    assert.ok(catalogued.has(resource_key), `${collection} maps to a catalogued resource`);
    const spec = resourceSpec(resource_key);
    assert.ok(spec !== undefined);
    const rows = world[collection as keyof GtmWorld] as unknown as readonly Record<string, unknown>[];
    assert.ok(Array.isArray(rows), `${collection} is a collection`);
    const keys = rows.map((row) => spec.natural_key.map((f) => String(row[f])).join("|"));
    assert.equal(new Set(keys).size, keys.length, `${collection} natural key ${spec.natural_key.join("+")} is unique`);
    for (const row of rows) {
      for (const field of spec.natural_key) assert.notEqual(row[field], undefined, `${collection}.${field} is present`);
      for (const field of ["source_system", "observed_at", "evidence_ref", "non_live"]) {
        assert.notEqual((row["provenance"] as Record<string, unknown> | undefined)?.[field], undefined, `${collection} carries provenance.${field}`);
      }
      const declared = Object.keys(spec.fields);
      for (const field of Object.keys(row)) {
        if (field === "provenance") continue;
        assert.ok(declared.includes(field), `${collection}.${field} is declared in the catalog`);
      }
    }
  }
  assert.deepEqual(
    Object.fromEntries(Object.keys(COLLECTION_RESOURCE).map((c) => [c, (world[c as keyof GtmWorld] as readonly unknown[]).length])),
    BASELINE_SHAPE,
  );
});

test("GTM-W03/versions: the candidate markers are frozen, decomposed and never activated", () => {
  // Compared as (family, version) tuples: a composed version literal must never appear in this repository.
  assert.deepEqual(CANDIDATE_MARKERS.map((m) => [m.family, m.version]), [
    ["PLUGIN_SPEC", "0.4.0"], ["CONTRACT_PACK", "0.2.0"], ["SALES_RUNTIME_CONTRACT", "0.6.0"], ["SALES_SCHEMA", "0.6.0"],
  ]);
  assert.deepEqual(CANDIDATE_MARKERS.map(markerLabel).map((l) => l.split("/").length), [2, 2, 2, 2]);
  for (const m of CANDIDATE_MARKERS) {
    assert.equal(m.role, "CANDIDATE_NOT_ADOPTED");
    assert.equal(m.activation, "NEVER_ACTIVATED_IN_PRODUCTION");
    assert.equal(m.scope, "W03_FIXTURE_SEMANTICS_ONLY");
  }
  // The package records which families it leaves alone; it never records their governing versions.
  assert.ok(GOVERNANCE_UNTOUCHED_FAMILIES.includes("PLUGIN_SPEC"));
  for (const family of GOVERNANCE_UNTOUCHED_FAMILIES) assert.equal(/\d/.test(family), false, "a family name carries no version");
});
