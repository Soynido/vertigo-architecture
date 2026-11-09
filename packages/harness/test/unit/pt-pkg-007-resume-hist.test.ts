/**
 * PV0-020C — post-Pro integration patch.
 * PT-PKG-007: a fixture/test runtime is distinguishable (runtime_scope) and its bind sentence carries the fixture
 * caveat; a live runtime carries none; deployment may force the scope. Names of people/runtimes are never hardcoded.
 * PT-RESUME-HIST-001: an incomplete Run superseded by a later durable reconciliation (healthy cursor, later COMPLETED
 * Run referenced, older watermark) is historical, not recovery/divergence; pins preserved; a newer unreferenced HOLD
 * still diverges. Plus: os_resume(META) exposes the registered META_SALES_RUNTIME_INPUTS pointer (NOT_FOUND / row /
 * NOT_APPLICABLE on SALES).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../../src/tools/handlers.ts";
import { runtimeScope } from "../../src/tools/scope.ts";
import { FIXTURE_SENTENCE } from "../../src/tools/messages.fr.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import { handleOf, OWNER, T0 } from "./binding-fixtures.ts";
import { buildResumeWorld, R, registryRow, runPage } from "./resume-fixtures.ts";

const ctx = { principal_id: OWNER.principal_id, now: T0 };
type Ok = Extract<Envelope, { status: "OK" }>;

test("PT-PKG-007: runtime_scope distinguishes fixture and live runtimes; the fixture caveat is said once at bind", async () => {
  assert.equal(runtimeScope("RT-TEST-01", {}), "FIXTURE");
  assert.equal(runtimeScope("META-FIXTURE-PTPRO-20260918-01", {}), "FIXTURE");
  assert.equal(runtimeScope("META-ACME-20300101-01", {}), "LIVE");
  assert.equal(runtimeScope("SALES-CONTEST-1", {}), "LIVE", "only a delimited FIXTURE/TEST token marks a fixture");
  assert.equal(runtimeScope("META-ACME-20300101-01", { HARNESS_RUNTIME_SCOPE: "fixture" }), "FIXTURE", "deployment may force the scope");
  assert.equal(runtimeScope("RT-TEST-01", { HARNESS_RUNTIME_SCOPE: "LIVE" }), "LIVE");
  const w = buildResumeWorld();
  const b = await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps);
  assert.equal(b.status, "OK");
  assert.equal((b.binding as { runtime_scope: string }).runtime_scope, "FIXTURE");
  assert.ok(b.say?.endsWith(FIXTURE_SENTENCE));
  assert.match(FIXTURE_SENTENCE, /ne dit rien de leur existence/, "the caveat never claims live data is absent");
  process.env["HARNESS_RUNTIME_SCOPE"] = "LIVE";
  try {
    const live = await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps);
    assert.equal((live.binding as { runtime_scope: string }).runtime_scope, "LIVE");
    assert.equal(live.say, "Connexion établie à votre espace de pilotage VERTIGO.");
  } finally { delete process.env["HARNESS_RUNTIME_SCOPE"]; }
});

test("PT-RESUME-HIST-001: a superseded historical HOLD is not recovery nor divergence; a newer unreferenced HOLD still is", async () => {
  const w = buildResumeWorld();
  // TRUN-1 HOLD at 06:00, then TRUN-2 COMPLETED at 12:00 adopted by a healthy Manifest (watermark 2030-01-02).
  w.setMetaRuns([runPage({ id: R.run1, label: "TRUN-1", status: "HOLD", lastEdited: "2030-01-01T06:00:00.000Z", control: "TEST_CONTROL/1.0" }), runPage({ id: R.run2, label: "TRUN-2", status: "COMPLETED", lastEdited: "2030-01-01T12:00:00.000Z", nextAction: "Ask the first frame question" })]);
  w.setMetaManifest({ lastRunId: R.run2, lastEdited: "2030-01-02T00:00:00.000Z" });
  const h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps));
  const r = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  assert.equal(r.code, "RESUMED", JSON.stringify(r));
  const s = (r as Ok).result as { current_run: { run_id: string; status: string }; historical_holds: Array<{ label: string; superseded_by: string; version_pins: { control: string } }>; recovery_required: boolean };
  assert.equal(s.current_run.status, "COMPLETED");
  assert.match(s.current_run.run_id, /^TRUN-2/);
  assert.equal(s.recovery_required, false);
  assert.equal(s.historical_holds.length, 1);
  assert.match(s.historical_holds[0]?.label ?? "", /^TRUN-1/);
  assert.match(s.historical_holds[0]?.superseded_by ?? "", /^TRUN-2/);
  assert.equal(s.historical_holds[0]?.version_pins.control, "TEST_CONTROL/1.0", "historical pins preserved, never rewritten");
  assert.ok(r.warnings.some((x) => x.startsWith("historical_hold_superseded: TRUN-1")), JSON.stringify(r.warnings));
  const c = await dispatch("os_control_status", { binding_handle: h }, ctx, w.deps);
  assert.equal(c.code, "CONTROL_STATUS", "RUN_RECOVERY no longer trips on the superseded HOLD");
  // Same HOLD but NEWER than the cursor watermark and unreferenced: still divergence.
  w.setMetaRuns([runPage({ id: R.run1, label: "TRUN-1", status: "HOLD", lastEdited: "2030-01-03T00:00:00.000Z" }), runPage({ id: R.run2, label: "TRUN-2", status: "COMPLETED", lastEdited: "2030-01-01T12:00:00.000Z" })]);
  assert.equal((await dispatch("os_resume", { binding_handle: h }, ctx, w.deps)).code, "HOLD_STATE_DIVERGENCE");
  // Old HOLD but the Manifest declares Recovery Required: recovery, not history.
  w.setMetaRuns([runPage({ id: R.run1, label: "TRUN-1", status: "HOLD", lastEdited: "2030-01-01T06:00:00.000Z" }), runPage({ id: R.run2, label: "TRUN-2", status: "COMPLETED", lastEdited: "2030-01-01T12:00:00.000Z" })]);
  w.setMetaManifest({ lastRunId: R.run2, lastEdited: "2030-01-02T00:00:00.000Z", recovery: true });
  assert.equal((await dispatch("os_resume", { binding_handle: h }, ctx, w.deps)).code, "HOLD_RECOVERY_REQUIRED");
});

test("PT-RESUME-HIST-001/c: canonical page-id text pointers adopt the completed Run and supersede older durable history", async () => {
  const { ledgerRow } = await import("./resume-fixtures.ts");
  const w = buildResumeWorld();
  w.setMetaRuns([
    runPage({ id: R.run1, label: "TRUN-1", status: "RUNNING", lastEdited: "2030-01-01T06:00:00.000Z" }),
    runPage({ id: R.run2, label: "TRUN-2", status: "HOLD", lastEdited: "2030-01-01T07:00:00.000Z" }),
    runPage({ id: R.run3, label: "TRUN-3", status: "COMPLETED", lastEdited: "2030-01-01T12:00:00.000Z" }),
  ]);
  w.setMetaLedger([ledgerRow(R.run1, "TMUT-4", "FAILED", "TRUN-1", "2030-01-01T08:00:00.000Z")]);
  // The native Notion renderer stores reference values as scalar canonical page ids (no page mention and no label).
  w.setMetaManifest({ lastRunId: null, lastEdited: "2030-01-02T00:00:00.000Z", lastVerifiedMutation: R.run2 });
  const manifest = w.map.get(`page:${(await import("./meta-fixtures.ts")).ID.manifest}`) as { properties: Record<string, unknown> };
  manifest.properties["Last Run Ref"] = { type: "rich_text", rich_text: [{ type: "text", plain_text: R.run3, text: { content: R.run3 } }] };
  const h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps));
  const r = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  assert.equal(r.code, "RESUMED", JSON.stringify(r));
  const s = (r as Ok).result as { current_run: { ref: string; status: string }; historical_holds: unknown[]; historical_mutations: unknown[]; recovery_required: boolean };
  assert.equal(s.current_run.ref, R.run3);
  assert.equal(s.current_run.status, "COMPLETED");
  assert.equal(s.recovery_required, false);
  assert.equal(s.historical_holds.length, 2);
  assert.equal(s.historical_mutations.length, 1);
});

test("PV0-020C: os_resume exposes the registered META_SALES_RUNTIME_INPUTS pointer (NOT_FOUND / row / NOT_APPLICABLE)", async () => {
  const w = buildResumeWorld();
  const h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps));
  assert.equal(((await dispatch("os_resume", { binding_handle: h }, ctx, w.deps)) as Ok).result["meta_inputs"], "NOT_FOUND");
  w.setMetaRegistry([registryRow({ key: "META_SALES_RUNTIME_INPUTS", status: "RESOLVED", notes: "derived cache; source refs kept per item" }), registryRow({ key: "OTHER_RESOURCE" })]);
  const mi = ((await dispatch("os_resume", { binding_handle: h }, ctx, w.deps)) as Ok).result["meta_inputs"] as { resource_key: string; status: string; url: string; notes: string };
  assert.equal(mi.resource_key, "META_SALES_RUNTIME_INPUTS");
  assert.equal(mi.status, "RESOLVED");
  assert.match(mi.url, /^https:\/\/example\.invalid\//);
  const hs = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps));
  assert.equal(((await dispatch("os_resume", { binding_handle: hs }, ctx, w.deps)) as Ok).result["meta_inputs"], "NOT_APPLICABLE", "no cross-lane exposure on SALES");
});

test("PT-RESUME-HIST-001/b: a superseded FAILED mutation (older than the watermark, before the cursor's Last Verified Mutation) is historical, not recovery; a newer one still is", async () => {
  const { ledgerRow } = await import("./resume-fixtures.ts");
  const w = buildResumeWorld();
  w.setMetaRuns([runPage({ id: R.run1, label: "TRUN-1", status: "COMPLETED", lastEdited: "2030-01-01T12:00:00.000Z" })]);
  w.setMetaLedger([ledgerRow(R.run2, "TMUT-3", "FAILED", "TRUN-1", "2030-01-01T10:00:00.000Z"), ledgerRow(R.run3, "TMUT-7", "VERIFIED", "TRUN-1", "2030-01-01T11:00:00.000Z")]);
  w.setMetaManifest({ lastRunId: R.run1, lastEdited: "2030-01-02T00:00:00.000Z", lastVerifiedMutation: "TMUT-7 | recovery" });
  const h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps));
  const r = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  assert.equal(r.code, "RESUMED", JSON.stringify(r));
  const s = (r as Ok).result as { historical_mutations: Array<{ label: string; superseded_by: string }>; mutations: { incomplete_count: number } };
  assert.equal(s.mutations.incomplete_count, 0);
  assert.match(s.historical_mutations[0]?.label ?? "", /^TMUT-3/);
  assert.ok(r.warnings.some((x) => x.startsWith("historical_mutation_superseded: TMUT-3")));
  assert.equal((await dispatch("os_control_status", { binding_handle: h }, ctx, w.deps)).code, "CONTROL_STATUS");
  // Newer than the watermark: still recovery.
  w.setMetaLedger([ledgerRow(R.run2, "TMUT-3", "FAILED", "TRUN-1", "2030-01-03T00:00:00.000Z"), ledgerRow(R.run3, "TMUT-7", "VERIFIED", "TRUN-1", "2030-01-01T11:00:00.000Z")]);
  assert.equal((await dispatch("os_resume", { binding_handle: h }, ctx, w.deps)).code, "HOLD_RECOVERY_REQUIRED");
  // An old PREPARED row is an unfinished write of unknown fate: always recovery, never historical.
  w.setMetaLedger([ledgerRow(R.run2, "TMUT-3", "PREPARED", "TRUN-1", "2030-01-01T10:00:00.000Z"), ledgerRow(R.run3, "TMUT-7", "VERIFIED", "TRUN-1", "2030-01-01T11:00:00.000Z")]);
  assert.equal((await dispatch("os_resume", { binding_handle: h }, ctx, w.deps)).code, "HOLD_RECOVERY_REQUIRED");
  // Older, but numbered after the cursor's Last Verified Mutation: not superseded, still recovery.
  w.setMetaLedger([ledgerRow(R.run2, "TMUT-9", "FAILED", "TRUN-1", "2030-01-01T10:00:00.000Z"), ledgerRow(R.run3, "TMUT-7", "VERIFIED", "TRUN-1", "2030-01-01T11:00:00.000Z")]);
  assert.equal((await dispatch("os_resume", { binding_handle: h }, ctx, w.deps)).code, "HOLD_RECOVERY_REQUIRED");
  // An id-only Last Verified pointer equal to the FAILED row is not proof of supersession.
  w.setMetaLedger([ledgerRow(R.run2, "TMUT-3", "FAILED", "TRUN-1", "2030-01-01T10:00:00.000Z")]);
  w.setMetaManifest({ lastRunId: R.run1, lastEdited: "2030-01-02T00:00:00.000Z", lastVerifiedMutation: R.run2 });
  assert.equal((await dispatch("os_resume", { binding_handle: h }, ctx, w.deps)).code, "HOLD_RECOVERY_REQUIRED");
});
