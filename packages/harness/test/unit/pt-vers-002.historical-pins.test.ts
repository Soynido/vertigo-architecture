/**
 * PT-VERS-002 — Historical Run pins are preserved (UNIT, blocking, PG1, PV0-003).
 * Procedure: current governance version B; incomplete/historical Run pinned to A.
 * Expected: Run remains attributed to A for recovery/audit; no pin rewritten to B.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ID, manifestPage, resolver, runPage, specRootChildren, synthetic, V } from "./meta-fixtures.ts";

test("PT-VERS-002: governance moved to B; the Run pinned to A is reported with A, governing is B", async () => {
  const r = await resolver({
    specRoot: specRootChildren({ spec: V.specB, control: V.controlB }),
    manifest: manifestPage({ spec: V.specB, control: V.controlB, lastRunId: ID.runOld }),
    runs: [runPage(ID.runOld, { spec: V.specA, schema: V.schema, control: V.controlA, status: "COMPLETED" })],
  }, [V.specB]).resolve();
  assert.equal(r.kind, "RESOLVED");
  if (r.kind !== "RESOLVED") return;
  assert.equal((r.runtime.versions.governing_spec as { value: string }).value, V.specB);
  assert.deepEqual(r.runtime.historical_pins, [{ ref: ID.runOld, spec: V.specA, schema: V.schema, control: V.controlA, status: "COMPLETED" }]);
  assert.ok(r.runtime.versions.historical_pins.every((p) => p.klass === "HISTORICAL_PIN" && p.evidence_ref === ID.runOld));
  assert.ok(!r.runtime.historical_pins.some((p) => p.spec === V.specB), "no historical pin is rewritten to the current version");
});

test("PT-VERS-002/b: a Manifest still pinned to A under governing B is reported separately with a warning, not rewritten", async () => {
  const r = await resolver({
    specRoot: specRootChildren({ spec: V.specB }),
    manifest: manifestPage({ spec: V.specA, lastRunId: null }),
  }, [V.specB]).resolve();
  assert.equal(r.kind, "RESOLVED");
  if (r.kind !== "RESOLVED") return;
  assert.equal(r.runtime.manifest_pins.spec, V.specA);
  assert.equal((r.runtime.versions.governing_spec as { value: string }).value, V.specB);
  assert.ok(r.runtime.warnings.some((w) => w.startsWith("manifest_spec_pin_differs_from_governing")));
  assert.deepEqual(r.runtime.historical_pins, []);
});

test("PT-VERS-002/c: an unreadable historical Run keeps its reference with UNKNOWN pins (never guessed)", async () => {
  const missingRun = synthetic("unreadable-run");
  const r = await resolver({ manifest: manifestPage({ lastRunId: missingRun }), runs: [] }).resolve();
  assert.equal(r.kind, "RESOLVED");
  if (r.kind !== "RESOLVED") return;
  assert.deepEqual(r.runtime.historical_pins, [{ ref: missingRun, spec: "UNKNOWN", schema: "UNKNOWN", control: "UNKNOWN", status: "UNKNOWN" }]);
  assert.ok(r.runtime.warnings.some((w) => w.startsWith("last_run_unreadable")));
});
