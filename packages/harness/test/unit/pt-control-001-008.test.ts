/**
 * PV0-019 — os_control_status under version-dispatched CONTROL adapters (PG8).
 * PT-CONTROL-001 adapter dispatched from the governing version; 002 candidate reported, behavior unchanged;
 * 003 adoption switches adapter without rebind; 004 unsupported governing version HOLDs with no fallback;
 * 005 stale check → HOLD_CONTROL_STALE; 006 missing/unknown proof never fabricated; 007 incomplete scope never
 * promoted; 008 historical Run pins stay visible and unchanged while current governance applies.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../../src/tools/handlers.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import { handleOf, OWNER, T0 } from "./binding-fixtures.ts";
import { childPage, ID as META_ID, specRootChildren, V as MV } from "./meta-fixtures.ts";
import { buildResumeWorld, controlCheckRow, gateRow, R } from "./resume-fixtures.ts";
import type { ControlStatus } from "../../src/control/engine.ts";

const ctx = { principal_id: OWNER.principal_id, now: T0 };
type Ok = Extract<Envelope, { status: "OK" }>;
type Hold = Extract<Envelope, { status: "HOLD" }>;
const gov = (r: Envelope) => (r.versions as { governing_control?: string }).governing_control;
const obs = (r: Envelope) => (r as Hold).observations as Partial<ControlStatus> & { scope_hint?: string };

async function statusOf(w: ReturnType<typeof buildResumeWorld>, h?: string) {
  const handle = h ?? handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps));
  return { handle, r: await dispatch("os_control_status", { binding_handle: handle }, ctx, w.deps) };
}

test("PT-CONTROL-001: the adapter is dispatched from the governing CONTROL version and identified in the result", async () => {
  const w = buildResumeWorld();
  const { r } = await statusOf(w);
  assert.equal(r.code, "CONTROL_STATUS", JSON.stringify(r));
  const s = (r as Ok).result as unknown as ControlStatus;
  assert.equal(s.governing_control_version, MV.controlA);
  assert.deepEqual(s.adapter, { version: MV.controlA, mode: "INDEPENDENT_PROOF", note: "test proof line" });
  assert.equal(s.result, "CONFIRMED");
  assert.equal(s.control_check.status, "FRESH");
  assert.equal(s.control_check.ref, R.check1);
  assert.deepEqual(s.candidate_control_versions, []);
  assert.deepEqual(s.scope.missing, []);
  assert.ok(s.invariants.some((i) => i.name === "CONTROL_REPORT_TAMPER" && i.result === "PASS"), "1.0 invariants computed");
  // Live mirror vocabulary: MATCH is intact, TAMPERED is a violation, UNVERIFIED is unknown (never PASS).
  w.setMetaControlChecks([controlCheckRow({ integrity: "MATCH" })]);
  assert.equal(((await statusOf(w)).r as Ok).result && (((await statusOf(w)).r as Ok).result as unknown as ControlStatus).invariants.find((i) => i.name === "CONTROL_REPORT_TAMPER")?.result, "PASS");
  w.setMetaControlChecks([controlCheckRow({ integrity: "TAMPERED" })]);
  assert.equal((await statusOf(w)).r.code, "HOLD_CONTROL_VIOLATION");
  w.setMetaControlChecks([controlCheckRow({ integrity: "UNVERIFIED" })]);
  const rv = (await statusOf(w)).r;
  assert.equal(rv.code, "CONTROL_STATUS", "under INDEPENDENT_PROOF the fresh check is the authority; recomputation UNKNOWN is a warning");
  assert.equal(((rv as Ok).result as unknown as ControlStatus).invariants.find((i) => i.name === "CONTROL_REPORT_TAMPER")?.result, "UNKNOWN");
  assert.equal(gov(r), MV.controlA);
});

test("PT-CONTROL-002: a candidate CONTROL version is reported separately and changes nothing operationally", async () => {
  const w = buildResumeWorld();
  const base = ((await statusOf(w)).r as Ok).result as unknown as ControlStatus;
  w.setSpecRoot(specRootChildren({ extraChildren: [childPage(META_ID.candidatePage, `CHANGE CANDIDATE — ${MV.specCandidate} + ${MV.controlB} — threat model`)] }));
  const { r } = await statusOf(w);
  assert.equal(r.code, "CONTROL_STATUS", JSON.stringify(r));
  const s = (r as Ok).result as unknown as ControlStatus;
  assert.deepEqual(s.candidate_control_versions, [MV.controlB]);
  assert.deepEqual({ ...s, candidate_control_versions: [] }, { ...base, candidate_control_versions: [] }, "identical behavior apart from the candidate report");
  assert.equal(s.adapter.version, MV.controlA);
});

test("PT-CONTROL-003: adopting the candidate as governing switches the adapter on the same binding, without rebind", async () => {
  const w = buildResumeWorld();
  const first = await statusOf(w);
  assert.equal(((first.r as Ok).result as unknown as ControlStatus).adapter.mode, "INDEPENDENT_PROOF");
  w.setSpecRoot(specRootChildren({ control: MV.controlB }));
  const { r } = await statusOf(w, first.handle);
  assert.equal(r.code, "CONTROL_STATUS", JSON.stringify(r));
  const s = (r as Ok).result as unknown as ControlStatus;
  assert.equal(s.governing_control_version, MV.controlB);
  assert.deepEqual(s.adapter, { version: MV.controlB, mode: "OPERATIONAL_RECOMPUTE", note: "test recompute line" });
  assert.equal(s.result, "OPERATIONAL_PASS", "1.1 permits deterministic read-only recomputation for a non-confirmed gate");
  assert.equal(s.control_check.status, "NOT_REQUIRED");
  assert.ok(!s.invariants.some((i) => i.name === "CONTROL_REPORT_TAMPER"), "1.1 invariant set differs from 1.0");
  assert.equal(gov(r), MV.controlB, "versions block re-resolved fresh on the same binding");
  // A control-confirmed gate under 1.1 still needs a fresh independent check; recomputation never substitutes.
  w.setMetaManifest({ setupGate: "T8 — CLOSE", setupGateStatus: "PASS" });
  w.setMetaGates([gateRow({ id: R.gateM1, key: "T8", status: "PASS", confirmation: "CONFIRMED", passedBy: "TRUN-1", confirmedBy: "TCC-1", lastEdited: "2030-01-02T00:00:00.000Z" })]);
  w.setMetaControlChecks([]);
  const rr = await dispatch("os_control_status", { binding_handle: first.handle }, ctx, w.deps);
  assert.equal(rr.code, "HOLD_CONTROL_PROOF_MISSING", JSON.stringify(rr));
});

test("PT-CONTROL-004: an unsupported governing CONTROL version HOLDs with no fallback to another adapter", async () => {
  const w = buildResumeWorld();
  w.setSpecRoot(specRootChildren({ control: "TEST_CONTROL/9.9" }));
  const { r } = await statusOf(w);
  assert.equal(r.code, "HOLD_UNSUPPORTED_CONTROL_VERSION", JSON.stringify(r));
  assert.equal(obs(r).governing_control_version, "TEST_CONTROL/9.9");
  assert.equal(obs(r).adapter, undefined, "no adapter selected");
  assert.equal(obs(r).result, undefined, "no result computed under a prior adapter");
  assert.match((r as Hold).evidence.join(" "), /no fallback/);
  // A candidate that IS supported still cannot be dispatched when the governing version is unsupported.
  w.setSpecRoot(specRootChildren({ control: "TEST_CONTROL/9.9", extraChildren: [childPage(META_ID.candidatePage, `CHANGE CANDIDATE — ${MV.specCandidate} + ${MV.controlA} — rollback`)] }));
  const { r: r2 } = await statusOf(w);
  assert.equal(r2.code, "HOLD_UNSUPPORTED_CONTROL_VERSION");
  assert.deepEqual(obs(r2).candidate_control_versions, [MV.controlA]);
});

test("PT-CONTROL-005: a Control Check older than the latest required write is stale and never confirms", async () => {
  const w = buildResumeWorld();
  w.setMetaControlChecks([controlCheckRow({ checkedAt: "2030-01-01T06:00:00.000Z" })]);
  const { r } = await statusOf(w);
  assert.equal(r.code, "HOLD_CONTROL_STALE", JSON.stringify(r));
  assert.equal(obs(r).control_check?.status, "STALE");
  assert.equal(obs(r).control_check?.required_written_at, "2030-01-02T00:00:00.000Z", "gate/Manifest last required write");
  assert.equal(obs(r).result, "HOLD");
  // Freshness is a boundary, not a tolerance: a check at the exact write instant is fresh.
  w.setMetaControlChecks([controlCheckRow({ checkedAt: "2030-01-02T00:00:00.000Z" })]);
  assert.equal((await statusOf(w)).r.code, "CONTROL_STATUS");
  // The latest check under the governing version decides; an older PASS beside a newer stale one does not resurrect it.
  w.setMetaControlChecks([controlCheckRow({ id: R.check1, checkedAt: "2030-01-02T06:00:00.000Z" }), controlCheckRow({ id: "b".repeat(32), checkId: "TCC-2", version: MV.controlB, checkedAt: "2030-01-03T00:00:00.000Z" })]);
  const { r: r3 } = await statusOf(w);
  assert.equal(r3.code, "CONTROL_STATUS", "a check for another version is ignored");
  assert.equal(((r3 as Ok).result as unknown as ControlStatus).control_check.ref, R.check1);
});

test("PT-CONTROL-006: missing or non-PASS proof is never fabricated into a PASS", async () => {
  const w = buildResumeWorld();
  w.setMetaControlChecks([]);
  const { r } = await statusOf(w);
  assert.equal(r.code, "HOLD_CONTROL_PROOF_MISSING", JSON.stringify(r));
  assert.equal(obs(r).control_check?.status, "MISSING");
  assert.equal(obs(r).result, "UNKNOWN");
  assert.match((r as Hold).evidence.join(" "), /never fabricates/);
  for (const [result, code, expect] of [["UNKNOWN", "HOLD_CONTROL_UNKNOWN", "UNKNOWN"], ["HOLD", "HOLD_CONTROL_UNKNOWN", "HOLD"], ["VIOLATION", "HOLD_CONTROL_VIOLATION", "VIOLATION"]] as const) {
    w.setMetaControlChecks([controlCheckRow({ result })]);
    const { r: rr } = await statusOf(w);
    assert.equal(rr.code, code, `verifier result ${result}`);
    assert.equal(obs(rr).result, expect);
  }
  // GATE_PROOF: a listed gate marked PASS while opting out of confirmation is a VIOLATION even with a fresh PASS check.
  w.setMetaControlChecks([controlCheckRow()]);
  w.setMetaManifest({ setupGate: "T8 — CLOSE", setupGateStatus: "PASS" });
  w.setMetaGates([gateRow({ id: R.gateM1, key: "T8", status: "PASS", confirmation: "NOT_REQUIRED", passedBy: "TRUN-1", lastEdited: "2030-01-02T00:00:00.000Z" })]);
  const { r: rv } = await statusOf(w);
  assert.equal(rv.code, "HOLD_CONTROL_VIOLATION", JSON.stringify(rv));
  assert.ok(obs(rv).invariants?.some((i) => i.name === "GATE_PROOF" && i.result === "VIOLATION"));
  // A SALES binding has no governing CONTROL version to dispatch on: HOLD, never a guessed adapter.
  const hs = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps));
  const rs = await dispatch("os_control_status", { binding_handle: hs }, ctx, w.deps);
  assert.equal(rs.code, "HOLD_CONTROL_UNKNOWN", JSON.stringify(rs));
});

test("PT-CONTROL-007: an incomplete verification scope is reported and never promoted", async () => {
  const w = buildResumeWorld();
  w.setMetaControlChecks([controlCheckRow({ scope: "manifest, runs" })]);
  const { r } = await statusOf(w);
  assert.equal(r.code, "HOLD_CONTROL_SCOPE_INCOMPLETE", JSON.stringify(r));
  assert.equal(obs(r).control_check?.status, "SCOPE_INCOMPLETE");
  assert.match((r as Hold).evidence.join(" "), /LEDGER, GATES/);
  // The harness's own read scope: a required source that cannot be read is also incomplete.
  w.setMetaControlChecks([controlCheckRow()]);
  w.removeMetaControlChecks();
  const { r: r2 } = await statusOf(w);
  assert.equal(r2.code, "HOLD_CONTROL_SCOPE_INCOMPLETE", JSON.stringify(r2));
  assert.deepEqual(obs(r2).scope?.missing, ["CONTROL_CHECKS"]);
  const w2 = buildResumeWorld();
  w2.removeMetaGates();
  const { r: r3 } = await statusOf(w2);
  assert.equal(r3.code, "HOLD_CONTROL_SCOPE_INCOMPLETE");
  assert.deepEqual(obs(r3).scope?.missing, ["GATES"]);
});

test("PT-CONTROL-008: historical Run pins stay visible and unchanged while current governance applies", async () => {
  const w = buildResumeWorld();
  const before = ((await statusOf(w)).r as Ok).result as unknown as ControlStatus;
  assert.match(before.historical_run_pins[R.run1] ?? "", new RegExp(`^${MV.specA} / .* / ${MV.controlA}$`), "pins observed on the referenced Run");
  w.setSpecRoot(specRootChildren({ control: MV.controlB }));
  const { r } = await statusOf(w);
  assert.equal(r.code, "CONTROL_STATUS", JSON.stringify(r));
  const after = (r as Ok).result as unknown as ControlStatus;
  assert.equal(after.governing_control_version, MV.controlB);
  assert.deepEqual(after.historical_run_pins, before.historical_run_pins, "pins are reported as observed, never rewritten to the new governing version");
  const pin = after.invariants.find((i) => i.name === "VERSION_PIN");
  assert.equal(pin?.result, "PASS");
  assert.match(pin?.evidence[0] ?? "", new RegExp(MV.controlA), "the Run keeps the version it started with");
  assert.ok(r.warnings.some((x) => /manifest_control_pin_differs_from_governing/.test(x)), "the Manifest pin difference is surfaced, not hidden");
});
