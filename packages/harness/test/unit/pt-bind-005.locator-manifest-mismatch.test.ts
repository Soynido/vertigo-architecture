/**
 * PT-BIND-005 — Locator/Manifest mismatch HOLDs instead of guessing (ADVERSARIAL, blocking, PG1, PV0-003).
 * Procedure: fixture locator points to runtime/root A while Manifest claims B.
 * Expected: HOLD_BOOTSTRAP_DISCOVERY or manifest-mismatch code; no runtime chosen by narration.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ID, locatorChildren, manifestPage, resolver, rootPage, specRootChildren, synthetic } from "./meta-fixtures.ts";

test("PT-BIND-005: locator root A vs Manifest root B → HOLD_RUNTIME_MANIFEST_MISMATCH with both identities in evidence", async () => {
  const r = await resolver({ locator: locatorChildren({ rootId: ID.rootA }), manifest: manifestPage({ rootId: ID.rootB }), root: rootPage(ID.rootA) }).resolve();
  assert.equal(r.kind, "HOLD");
  if (r.kind !== "HOLD") return;
  assert.equal(r.code, "HOLD_RUNTIME_MANIFEST_MISMATCH");
  assert.ok(r.evidence.some((e) => e.includes(ID.rootA) && e.includes(ID.rootB)), "evidence names both roots; neither is chosen");
});

test("PT-BIND-005/b: runtime id disagreement HOLDs the same way", async () => {
  const r = await resolver({ locator: locatorChildren({ runtimeId: "RT-TEST-01" }), manifest: manifestPage({ runtimeId: "RT-TEST-02" }) }).resolve();
  assert.equal(r.kind, "HOLD");
  assert.equal((r as { code: string }).code, "HOLD_RUNTIME_MANIFEST_MISMATCH");
});

test("PT-BIND-005/c: Manifest pointing at a different SPEC_ROOT than the configured one HOLDs", async () => {
  const r = await resolver({ manifest: manifestPage({ specRootId: synthetic("other-spec-root") }) }).resolve();
  assert.equal((r as { code: string }).code, "HOLD_RUNTIME_MANIFEST_MISMATCH");
});

test("PT-BIND-005/d: missing, duplicated or incomplete locator → HOLD_BOOTSTRAP_DISCOVERY", async () => {
  assert.equal((await resolver({ specRoot: specRootChildren({ omitLocator: true }) }).resolve() as { code: string }).code, "HOLD_BOOTSTRAP_DISCOVERY");
  assert.equal((await resolver({ specRoot: specRootChildren({ duplicateLocator: true }) }).resolve() as { code: string }).code, "HOLD_BOOTSTRAP_DISCOVERY");
  const noManifestPointer = locatorChildren().filter((b) => !JSON.stringify(b).includes("Current Manifest"));
  assert.equal((await resolver({ locator: noManifestPointer }).resolve() as { code: string }).code, "HOLD_BOOTSTRAP_DISCOVERY");
});

test("PT-BIND-005/e: archived root or Manifest → HOLD_RUNTIME_NOT_FOUND; consistent world resolves", async () => {
  assert.equal((await resolver({ root: rootPage(ID.rootA, true) }).resolve() as { code: string }).code, "HOLD_RUNTIME_NOT_FOUND");
  assert.equal((await resolver({ manifest: manifestPage({ archived: true }) }).resolve() as { code: string }).code, "HOLD_RUNTIME_NOT_FOUND");
  const ok = await resolver().resolve();
  assert.equal(ok.kind, "RESOLVED");
  if (ok.kind !== "RESOLVED") return;
  assert.equal(ok.runtime.root_ref, ID.rootA);
  assert.equal(ok.runtime.manifest_ref, ID.manifest);
  assert.equal(ok.runtime.runtime_id, "RT-TEST-01");
  assert.equal(ok.runtime.pointer_generation, "1");
  assert.match(ok.runtime.runtime_generation, /^[0-9a-f]{32}$/);
});
