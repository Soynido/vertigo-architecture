/**
 * PT-VERS-001 — Governing and candidate versions are separated (ADVERSARIAL, blocking, PG1, PV0-003).
 * Procedure: fixture spec contains a governing version plus a page explicitly marked non-normative change candidate.
 * Expected: resolver returns governing and candidate separately; adapters/actions use only governing semantics.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { childPage, ID, resolver, specRootChildren, V } from "./meta-fixtures.ts";
import { classifyVersions, parseSpecRoot } from "../../src/versions/specRoot.ts";

const candidatePage = childPage(ID.candidatePage, `CHANGE CANDIDATE — ${V.specCandidate} + ${V.controlB} — threat model`);

test("PT-VERS-001: candidate page versions are reported as candidates, never as governing", async () => {
  const r = await resolver({ specRoot: specRootChildren({ extraChildren: [candidatePage] }) }).resolve();
  assert.equal(r.kind, "RESOLVED");
  if (r.kind !== "RESOLVED") return;
  const v = r.runtime.versions;
  assert.equal((v.governing_spec as { value: string }).value, V.specA);
  assert.equal((v.governing_control as { value: string }).value, V.controlA);
  assert.deepEqual(v.candidates.map((c) => [c.value, c.klass]), [[V.specCandidate, "CHANGE_CANDIDATE"], [V.controlB, "CHANGE_CANDIDATE"]]);
  assert.equal(r.runtime.observations["adapter"], V.specA, "adapter is selected from the governing version only");
});

test("PT-VERS-001/b: a candidate cannot select the adapter — governing without adapter HOLDs even if the candidate has one", async () => {
  const r = await resolver({ specRoot: specRootChildren({ spec: V.specB, extraChildren: [candidatePage] }) }, [V.specA, V.specCandidate]).resolve();
  assert.equal(r.kind, "HOLD");
  assert.equal((r as { code: string }).code, "HOLD_UNSUPPORTED_GOVERNING_VERSION");
});

test("PT-VERS-001/c: a candidate page whose versions equal the governing ones is an adopted record, not a candidate", async () => {
  const adopted = childPage(ID.candidatePage, `CHANGE CANDIDATE — ${V.specA} + ${V.controlA} — adopted`);
  const r = await resolver({ specRoot: specRootChildren({ extraChildren: [adopted] }) }).resolve();
  assert.equal(r.kind, "RESOLVED");
  if (r.kind !== "RESOLVED") return;
  assert.deepEqual(r.runtime.versions.candidates, []);
  assert.deepEqual(r.runtime.adopted_records.map((a) => a.value), [V.specA, V.controlA]);
});

test("PT-VERS-001/d: non-frozen readiness, missing status or non-governing marker in Status → HOLD_VERSION_RESOLUTION", async () => {
  assert.equal((await resolver({ specRoot: specRootChildren({ readiness: "DRAFT" }) }).resolve() as { code: string }).code, "HOLD_VERSION_RESOLUTION");
  assert.equal((await resolver({ specRoot: specRootChildren().filter((b) => !JSON.stringify(b).includes("Spec current")) }).resolve() as { code: string }).code, "HOLD_VERSION_RESOLUTION");
  assert.equal((await resolver({ specRoot: specRootChildren({ spec: `${V.specA} (PROPOSED)` }) }).resolve() as { code: string }).code, "HOLD_VERSION_RESOLUTION");
  const c = classifyVersions(parseSpecRoot(specRootChildren({ extraChildren: [candidatePage] })), "spec");
  assert.ok(c.ok && c.candidates.length === 2 && c.governing.spec.klass === "GOVERNING");
});
