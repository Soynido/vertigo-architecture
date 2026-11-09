/**
 * PT-RESUME-001 (fixture part), 003, 004, 005, 006, 007, 008, 009, 010 — os_resume canonical rehydration (PV0-007).
 * PT-RESUME-001/002 live parts are executed by scripts/live-resume-meta.ts against the live META runtime.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../../src/tools/handlers.ts";
import { handleOf, OWNER, REP_B, T0 } from "./binding-fixtures.ts";
import { buildResumeWorld, extIntent, gateRow, ledgerRow, R, runPage } from "./resume-fixtures.ts";
import { ID as META_ID, V as MV } from "./meta-fixtures.ts";
import { registryEntries } from "./sales-fixtures.ts";
import { metaSpecAdapter, type MetaSpecAdapter } from "../../src/versions/adapters/meta.ts";

const ctx = { principal_id: OWNER.principal_id, now: T0 };
type Res = { status: string; code: string; result?: Record<string, unknown>; observations: Record<string, unknown>; warnings: string[]; evidence?: string[]; next: { safe_action: string } };
async function bindMeta(w: ReturnType<typeof buildResumeWorld>) { return handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps)); }
async function resume(w: ReturnType<typeof buildResumeWorld>, h: string, c = ctx): Promise<Res> { return (await dispatch("os_resume", { binding_handle: h }, c, w.deps)) as unknown as Res; }

test("PT-RESUME-001 (fixture): a cold context with only bind+resume reconstructs runtime, versions, current Run, gate and next action", async () => {
  const w = buildResumeWorld();
  const r = await resume(w, await bindMeta(w));
  assert.equal(r.status, "OK");
  assert.equal(r.code, "RESUMED");
  const s = r.result!;
  assert.equal(s["runtime_state"], "SETUP");
  assert.equal((s["current_run"] as { ref: string; status: string }).ref, R.run1);
  assert.equal((s["current_run"] as { status: string }).status, "COMPLETED");
  assert.equal((s["gate"] as { gate_key: string; status: string; source: string }).gate_key, "T1");
  assert.equal((s["gate"] as { status: string }).status, "OPEN");
  assert.equal(s["recovery_required"], false);
  assert.equal(s["next_safe_action"], "Ask the first frame question");
  assert.equal(r.next.safe_action, "Ask the first frame question");
  assert.equal((s["mutations"] as { incomplete_count: number }).incomplete_count, 0);
  assert.equal(s["open_backend_plan"], "NONE");
});

test("PT-RESUME-003: a Run change between two resume calls is observed; no per-binding cache", async () => {
  const w = buildResumeWorld();
  const h = await bindMeta(w);
  const first = await resume(w, h);
  assert.equal((first.result!["current_run"] as { ref: string }).ref, R.run1);
  const run2 = runPage({ id: R.run2, label: "TRUN-2", status: "COMPLETED", lastEdited: "2030-01-03T00:00:00.000Z", nextAction: "Ask the second frame question" });
  w.setMetaRuns([runPage({ id: R.run1, label: "TRUN-1", status: "COMPLETED" }), run2]);
  w.setMetaManifest({ lastRunId: R.run2, nextAction: "Ask the second frame question", lastEdited: "2030-01-03T00:00:00.000Z" });
  const second = await resume(w, h);
  assert.equal(second.code, "RESUMED");
  assert.equal((second.result!["current_run"] as { ref: string }).ref, R.run2);
  assert.equal(second.result!["next_safe_action"], "Ask the second frame question");
});

test("PT-RESUME-004: a prior-attempt RUNNING Run triggers HOLD_RECOVERY_REQUIRED before new work; RUNNING is not liveness proof", async () => {
  const w = buildResumeWorld();
  const h = await bindMeta(w);
  w.setMetaRuns([runPage({ id: R.run2, label: "TRUN-2", status: "RUNNING", nextAction: "finish writing target X", lastEdited: "2030-01-03T00:00:00.000Z", mutationCount: 3, verified: 1 })]);
  w.setMetaManifest({ lastRunId: R.run2, lastEdited: "2030-01-03T00:00:00.000Z" });
  const r = await resume(w, h);
  assert.equal(r.status, "HOLD");
  assert.equal(r.code, "HOLD_RECOVERY_REQUIRED");
  assert.ok(r.evidence!.some((e) => /RUNNING.*not liveness proof/.test(e)));
  assert.equal(r.observations["recovery_required"], true);
  assert.match(r.next.safe_action, /recover run TRUN-2/);
  assert.match(r.next.safe_action, /finish writing target X/);
});

test("PT-RESUME-005: a non-VERIFIED required mutation triggers recovery even when the Run looks healthy", async () => {
  const w = buildResumeWorld();
  const h = await bindMeta(w);
  w.setMetaLedger([ledgerRow(R.run3, "TMUT-10", "WRITTEN", "TRUN-1")]);
  const r = await resume(w, h);
  assert.equal(r.code, "HOLD_RECOVERY_REQUIRED");
  assert.ok(r.evidence!.some((e) => /TMUT-10 \(WRITTEN\)/.test(e)));
  assert.equal((r.observations["mutations"] as { incomplete_count: number }).incomplete_count, 1);
  assert.notEqual(r.status, "OK", "runtime is not presented healthy/complete");
});

test("PT-RESUME-006: a stale registry snapshot cannot override the fresh SALES Manifest/OS State", async () => {
  const w = buildResumeWorld();
  w.setSalesRegistry(registryEntries().map((e) => (e.rep_identity_key === "rep-a" ? { ...e, snapshot: { install_state: "UNBOUND", current_gate: "B0_DISCOVERY", snapshot_at: "2029-12-01" } } : e)));
  const h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps));
  const r = await resume(w, h);
  assert.equal(r.code, "RESUMED");
  assert.equal(r.observations["lifecycle_state"], "SETUP", "lifecycle follows the fresh Manifest");
  assert.equal((r.result!["gate"] as { gate_key: string }).gate_key, "B2_ICP", "gate follows fresh OS State");
  assert.ok(r.warnings.some((x) => x.startsWith("registry_snapshot_stale: install_state")));
  assert.ok(r.warnings.some((x) => x.startsWith("registry_snapshot_stale: current_gate")));
});

test("PT-RESUME-007: stale Gate metadata is separated from the effective current hold; the Gate is not edited", async () => {
  const w = buildResumeWorld();
  const h = await bindMeta(w);
  const staleGate = gateRow({ id: R.gateM1, key: "T1", status: "OPEN", blocker: "OLD blocker text", nextAction: "OLD next action", lastEdited: "2030-01-01T00:00:00.000Z" });
  w.setMetaGates([staleGate]);
  w.setMetaManifest({ blocker: "NEW reconciliation blocker", nextAction: "NEW exact next action", lastEdited: "2030-01-05T00:00:00.000Z" });
  const before = JSON.stringify(w.map.get(`page:${R.gateM1}`));
  const r = await resume(w, h);
  assert.equal(r.code, "RESUMED");
  const gate = r.result!["gate"] as { status: string; metadata_stale: boolean; formal_blocker: string };
  assert.equal(gate.status, "OPEN", "formal status is returned unchanged");
  assert.equal(gate.metadata_stale, true);
  assert.equal(gate.formal_blocker, "OLD blocker text");
  const hold = r.result!["effective_hold"] as { evidence: string[] };
  assert.ok(hold.evidence[0]!.includes("NEW reconciliation blocker"), "effective hold is the newer cursor blocker");
  assert.equal(r.result!["next_safe_action"], "NEW exact next action");
  assert.equal(JSON.stringify(w.map.get(`page:${R.gateM1}`)), before, "Gate row untouched");
});

test("PT-RESUME-008: UNKNOWN stays UNKNOWN and HOLD stays HOLD with evidence and next action", async () => {
  const w = buildResumeWorld();
  const h = await bindMeta(w);
  w.setMetaManifest({ omitPersistence: true });
  w.removeMetaGates();
  const r = await resume(w, h);
  assert.equal(r.code, "RESUMED");
  assert.equal(r.result!["persistence_health"], "UNKNOWN");
  const gate = r.result!["gate"] as { source: string; metadata_stale: string; control_confirmation_state: string };
  assert.equal(gate.source, "CURSOR");
  assert.equal(gate.control_confirmation_state, "UNKNOWN");
  assert.ok(r.warnings.some((x) => x.includes("META — GATES")));
  // A HOLD keeps evidence and a next action; it never becomes OK/PASS.
  w.setMetaRuns([runPage({ id: R.run2, label: "TRUN-2", status: "HOLD_PARTIAL_COMMIT", holds: "target Y unreadable" })]);
  w.setMetaManifest({ lastRunId: R.run2, recovery: true, omitPersistence: true });
  const held = await resume(w, h);
  assert.equal(held.status, "HOLD");
  assert.equal(held.code, "HOLD_RECOVERY_REQUIRED");
  assert.ok(held.evidence!.length >= 2);
  assert.match(held.next.safe_action, /recover run TRUN-2/);
  assert.equal(held.observations["persistence_health"], "UNKNOWN");
});

test("PT-RESUME-008/b: divergence and ambiguity HOLD instead of guessing", async () => {
  const w = buildResumeWorld();
  const h = await bindMeta(w);
  // Incomplete run that the Manifest neither references nor flags → divergence.
  w.setMetaRuns([runPage({ id: R.run1, label: "TRUN-1", status: "COMPLETED" }), runPage({ id: R.run2, label: "TRUN-2", status: "RUNNING" })]);
  w.setMetaManifest({ lastRunId: R.run1, recovery: false });
  const d = await resume(w, h);
  assert.equal(d.code, "HOLD_STATE_DIVERGENCE");
  // Two incomplete runs, neither referenced → ambiguous.
  w.setMetaRuns([runPage({ id: R.run2, label: "TRUN-2", status: "RUNNING" }), runPage({ id: R.run3, label: "TRUN-3", status: "HOLD" })]);
  w.setMetaManifest({ lastRunId: R.run1, recovery: true });
  const a = await resume(w, h);
  assert.equal(a.code, "HOLD_RUN_AMBIGUOUS");
  // Two incomplete runs, one referenced by the Manifest → deterministic precedence.
  w.setMetaManifest({ lastRunId: R.run3, recovery: true });
  const p = await resume(w, h);
  assert.equal(p.code, "HOLD_RECOVERY_REQUIRED");
  assert.equal((p.observations["current_run"] as { ref: string }).ref, R.run3);
});

test("PT-RESUME-009: locator move / rotation is detected on resume; rebind resolves B and its current state", async () => {
  const w = buildResumeWorld();
  const hA = await bindMeta(w);
  assert.equal((await resume(w, hA)).code, "RESUMED");
  w.rotateMeta({ rootId: META_ID.rootB, pointerGeneration: "2" });
  // root B needs its own control plane: reuse the same databases under root B.
  w.map.set(`children:${META_ID.rootB}`, w.map.get(`children:${META_ID.rootA}`));
  w.map.set(`page:${META_ID.manifest}`, { ...(w.map.get(`page:${META_ID.manifest}`) as object), properties: { ...((w.map.get(`page:${META_ID.manifest}`) as { properties: Record<string, unknown> }).properties), "Root URL": { type: "url", url: `https://example.invalid/p/${META_ID.rootB}` } } });
  assert.equal((await resume(w, hA)).code, "HOLD_BINDING_STALE_RUNTIME_ROTATED");
  const hB = await bindMeta(w);
  const r = await resume(w, hB);
  assert.equal(r.code, "RESUMED");
  assert.equal(r.observations["root_ref"], META_ID.rootB);
});

test("PT-RESUME-010: unsupported governing version HOLDs; a supported change dispatches the new adapter and is flagged", async () => {
  const w = buildResumeWorld();
  const h = await bindMeta(w);
  // Unsupported: the spec root now declares a version with no adapter.
  const { specRootChildren } = await import("./meta-fixtures.ts");
  w.map.set(`children:${META_ID.specRoot}`, { results: specRootChildren({ spec: MV.specB }), has_more: false, next_cursor: null });
  const u = await resume(w, h);
  assert.equal(u.code, "HOLD_UNSUPPORTED_GOVERNING_VERSION");
  // Supported: register an adapter for the new version; resume dispatches it and flags the change since bind.
  const existing = w.deps.adapters.metaRuntime.resolve(MV.specA) as MetaSpecAdapter;
  w.deps.adapters.metaRuntime.register(MV.specB, metaSpecAdapter(MV.specB, existing.supportedSchemas, existing.grammar));
  const s = await resume(w, h);
  assert.equal(s.code, "RESUMED");
  assert.ok(s.warnings.some((x) => x.startsWith("governing_spec_changed_since_bind")));
  assert.equal((s as unknown as { versions: { governing_spec: string } }).versions.governing_spec, MV.specB);
});

test("SALES resume: OS State drives the cursor; unresolved external intents require recovery; cross-user stays refused", async () => {
  const w = buildResumeWorld();
  const h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps));
  const ok = await resume(w, h);
  assert.equal(ok.code, "RESUMED");
  assert.equal((ok.result!["gate"] as { gate_key: string; status: string }).gate_key, "B2_ICP");
  assert.equal(ok.result!["next_safe_action"], "Answer the ICP question");
  assert.equal(ok.result!["external_intents_unresolved"], 0);
  w.setSalesExternal([extIntent(R.run3, "NOT_OBSERVED"), extIntent(R.run2, "OBSERVED"), extIntent(R.gateM1, "PREPARED", "EFFECT_RECEIPT")]);
  const held = await resume(w, h);
  assert.equal(held.code, "HOLD_RECOVERY_REQUIRED");
  assert.equal(held.observations["external_intents_unresolved"], 1);
  assert.ok(held.evidence!.some((e) => /competent-source reconciliation/.test(e)));
  const foreign = await resume(w, h, { principal_id: REP_B.principal_id, now: T0 });
  assert.equal(foreign.code, "ERROR_PRINCIPAL_MISMATCH");
});
