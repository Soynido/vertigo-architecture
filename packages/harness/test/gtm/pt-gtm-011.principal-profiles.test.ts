/**
 * GTM-W03 world E — four synthetic principal source profiles and principal isolation (PT-GTM-011).
 * Shapes only: no live identity, no live runtime, and the real per-principal reads stay deferred.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FIXTURE_DOMAIN, REAL_READ_CANARY, RESOURCE_KEYS } from "./catalog.ts";
import { buildGtmWorld, R_TEST } from "./world.ts";
import { profileView, readRows, readScopeOf } from "./oracle.ts";

const w = buildGtmWorld();

test("PT-GTM-011 fixture: the four profiles mirror shapes only, on unroutable identities", () => {
  assert.deepEqual(w.principals.map((p) => p.principal_key), ["CELIA_FIXTURE", "JULIAN_FIXTURE", "ARON_FIXTURE", "VALENTIN_FIXTURE"]);
  for (const p of w.principals) {
    for (const identity of [p.gmail_manifest_identity, p.gmail_registry_identity]) {
      if (identity !== null) assert.ok(identity.endsWith(`@${FIXTURE_DOMAIN}`), `${p.principal_key} uses an unroutable identity`);
    }
  }
  assert.deepEqual(profileView(w, "CELIA_FIXTURE")?.sources, { notion: "RESOLVED", gmail_read: "VERIFIED", tracker: "INACCESSIBLE", calendar: "PENDING" });
  assert.deepEqual(profileView(w, "JULIAN_FIXTURE")?.sources, { notion: "RESOLVED", gmail_read: "VERIFIED", tracker: "PARTIAL", calendar: "PENDING" });
  assert.equal(REAL_READ_CANARY, "DEFERRED_GTM_G3");
});

test("PT-GTM-011 fixture: a mailbox identity divergence is preserved, never collapsed", () => {
  const v = profileView(w, "ARON_FIXTURE");
  assert.equal(v?.divergence, "MANIFEST_VS_REGISTRY");
  assert.equal(v?.divergent_values.length, 2);
  assert.notEqual(v?.divergent_values[0], v?.divergent_values[1]);
  assert.equal(v?.hold, true);
  assert.equal(v?.sources["tracker"], "UNKNOWN");
});

test("PT-GTM-011 fixture: a profile without a runtime reads nothing and never borrows one", () => {
  assert.equal(profileView(w, "VALENTIN_FIXTURE")?.runtime_key, null);
  assert.equal(readScopeOf(w, "VALENTIN_FIXTURE").refusal, "REFUSED_NO_RUNTIME");
  assert.deepEqual(readScopeOf(w, "VALENTIN_FIXTURE").resource_keys, []);
  for (const resource of Object.values(RESOURCE_KEYS)) {
    assert.equal(readRows(w, "VALENTIN_FIXTURE", resource).status, "REFUSED");
  }
  assert.deepEqual(readRows(w, "VALENTIN_FIXTURE", RESOURCE_KEYS.MESSAGE, R_TEST), { status: "REFUSED", code: "REFUSED_NO_RUNTIME" });
});

test("PT-GTM-011 fixture: each principal reads its own runtime and only its own", () => {
  for (const p of w.principals.filter((x) => x.runtime_key !== null)) {
    const rows = readRows(w, p.principal_key, RESOURCE_KEYS.MESSAGE);
    assert.equal(rows.status, "OK");
    if (rows.status !== "OK") return;
    assert.deepEqual([...new Set(rows.rows.map((r) => r["runtime_key"]))].filter((k) => k !== undefined), rows.rows.length === 0 ? [] : [p.runtime_key]);
    for (const other of w.runtimes.filter((r) => r.runtime_key !== p.runtime_key)) {
      assert.deepEqual(readRows(w, p.principal_key, RESOURCE_KEYS.MESSAGE, other.runtime_key), { status: "REFUSED", code: "REFUSED_FOREIGN_RUNTIME" });
    }
  }
});
