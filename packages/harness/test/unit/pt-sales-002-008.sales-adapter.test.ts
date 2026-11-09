/**
 * PV0-017 — SALES adapter and cross-runtime isolation: PT-SALES-002..007 on fixtures.
 * PT-SALES-008 (cold LIVE chat) is not runnable here: it needs an approved SALES test principal, the SALES roots
 * shared with the read-only harness credential and SALES_RUNTIME_REGISTRY_FILE — a HUMAN prerequisite.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../../src/tools/handlers.ts";
import { toolInputSchemas, TOOL_NAMES, toolDescriptions } from "../../src/tools/surface.ts";
import { HttpNotionReadClient } from "../../src/notion/readClient.ts";
import { SALES_CONTROL_PLANE_05 } from "../../src/versions/adapters/controlPlane.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import type { NotionReadClient } from "../../src/notion/readClient.ts";
import { handleOf, OWNER, REP_B, T0 } from "./binding-fixtures.ts";
import { buildResumeWorld, extIntent, R, SALES_EXT_ROW, type ResumeWorld } from "./resume-fixtures.ts";
import { ID as META_ID } from "./meta-fixtures.ts";
import { IDS as SALES_IDS } from "./sales-fixtures.ts";
import { executeWrites } from "./target-fixtures.ts";

const asA = { principal_id: OWNER.principal_id, now: T0 };
const asB = { principal_id: REP_B.principal_id, now: T0 };
type Ok = Extract<Envelope, { status: "OK" }>;
const intentFor = (key: string) => ({ action_class: "COMMIT", summary: "queue an outreach intent", mutations: [{ logical_resource_key: "SALES:EXTERNAL_ACTIONS", operation: "CREATE" as const, record_selector: { natural_key: key }, desired_changes: { Recipient: "prospect@example.invalid", "Subject / Content Hash": "Hello" } }] });

/** Wraps the fixture client to record every page/database/data source the harness touches. */
function spy(w: ResumeWorld): { ids: string[] } {
  const inner = w.deps.notion;
  const ids: string[] = [];
  const wrapped: NotionReadClient = {
    retrievePage: (id) => { ids.push(id); return inner.retrievePage(id); },
    retrieveDatabase: (id) => { ids.push(id); return inner.retrieveDatabase(id); },
    retrieveDataSource: (id) => { ids.push(id); return inner.retrieveDataSource(id); },
    retrieveBlockChildren: (id, c) => { ids.push(id); return inner.retrieveBlockChildren(id, c); },
    queryDataSource: (id, f, c) => { ids.push(id); return inner.queryDataSource(id, f, c); },
  };
  (w.deps as { notion: NotionReadClient }).notion = wrapped;
  return { ids };
}

test("PT-SALES-002: a rep cannot select another rep by arguments — bind/prepare accept no rep, runtime, root or selector pointing at another runtime", async () => {
  const w = buildResumeWorld();
  for (const extra of [{ rep: "rep-b" }, { rep_identity_key: "rep-b" }, { runtime_id: "SALESOS-FIXTURE-B" }, { root_ref: SALES_IDS("rep-b").root }, { sales_root: `https://example.invalid/p/${SALES_IDS("rep-b").root}` }, { owner: "Rep B" }, { instance_id: "SALESOS-FIXTURE-B" }]) {
    const r = await dispatch("os_bind", { project: "VERTIGO", lane: "SALES", ...extra }, asA, w.deps);
    assert.equal(r.code, "ERROR_INVALID_ARGUMENT", JSON.stringify(extra));
  }
  // Identical caller arguments ⇒ each principal lands on its own runtime.
  const a = await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, asA, w.deps) as Ok;
  const b = await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, asB, w.deps) as Ok;
  assert.equal((a.binding as { runtime_id: string }).runtime_id, "SALESOS-FIXTURE-A");
  assert.equal((b.binding as { runtime_id: string }).runtime_id, "SALESOS-FIXTURE-B");
  // A selector that resolves to rep B's record from rep A's binding is denied and persists nothing.
  const hA = handleOf(a);
  const cross = await dispatch("os_prepare", { binding_handle: hA, intent: { action_class: "COMMIT", summary: "x", mutations: [{ logical_resource_key: "SALES:EXTERNAL_ACTIONS", operation: "UPDATE", record_selector: { existing_object_id: SALES_EXT_ROW("rep-b") }, desired_changes: { Recipient: "x@example.invalid" } }] } }, asA, w.deps);
  assert.equal(cross.code, "HOLD_CROSS_RUNTIME");
  assert.equal((await w.deps.store.events.list({})).filter((e) => e.event_type === "PLAN_CREATED").length, 0);
  // Display names never authorize: REP_B's display name is "Rep B" but even a principal whose display name equals rep A's cannot reach A's runtime.
  const spoof = { ...REP_B, display_name: OWNER.display_name ?? "Owner" };
  w.setPrincipals([OWNER, spoof]);
  const s = await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, asB, w.deps) as Ok;
  assert.equal((s.binding as { runtime_id: string }).runtime_id, "SALESOS-FIXTURE-B");
});

test("PT-SALES-003: principal B replaying A's binding handle or plan id is rejected; nothing on A's runtime is authorized", async () => {
  const w = buildResumeWorld();
  const hA = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, asA, w.deps));
  const pA = await dispatch("os_prepare", { binding_handle: hA, intent: intentFor("ak-a-1") }, asA, w.deps);
  assert.equal(pA.code, "PLAN_PREPARED", JSON.stringify(pA));
  const planId = ((pA as Ok).result as { plan_id: string }).plan_id;
  for (const name of ["os_resume", "os_handoff", "os_control_status"] as const) {
    const r = await dispatch(name, { binding_handle: hA }, asB, w.deps);
    assert.equal(r.code, "ERROR_PRINCIPAL_MISMATCH", name);
    assert.equal(r.binding, "UNKNOWN", "no runtime identity leaks to the foreign principal");
  }
  assert.equal((await dispatch("os_prepare", { binding_handle: hA, intent: intentFor("ak-b") }, asB, w.deps)).code, "ERROR_PRINCIPAL_MISMATCH");
  assert.equal((await dispatch("os_verify", { binding_handle: hA, plan_id: planId, phase: "TARGET" }, asB, w.deps)).code, "ERROR_PRINCIPAL_MISMATCH");
  // B with their own binding but A's plan id.
  const hB = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, asB, w.deps));
  const v = await dispatch("os_verify", { binding_handle: hB, plan_id: planId, phase: "TARGET" }, asB, w.deps);
  assert.equal(v.code, "ERROR_PRINCIPAL_MISMATCH");
  assert.deepEqual(await w.deps.store.receipts.findByPlan(planId), []);
  assert.equal((await w.deps.store.plans.get(planId))!.plan_state, "AWAITING_STAGE1_WRITES");
});

test("PT-SALES-004: a SALES binding cannot target or even read Private META through the plugin", async () => {
  const w = buildResumeWorld();
  const { ids } = spy(w);
  const hS = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, asA, w.deps));
  assert.equal((await dispatch("os_resume", { binding_handle: hS }, asA, w.deps)).code, "RESUMED");
  for (const key of ["META:GATES", "META:MANIFEST", "META:RUNS"]) {
    const r = await dispatch("os_prepare", { binding_handle: hS, intent: { action_class: "COMMIT", summary: "x", mutations: [{ logical_resource_key: key, operation: "UPDATE", record_selector: { natural_key: "T1" }, desired_changes: { "Next Question": "q" } }] } }, asA, w.deps);
    assert.equal(r.code, "HOLD_CROSS_LANE", key);
  }
  const meta = new Set([META_ID.specRoot, META_ID.locator, META_ID.manifest, META_ID.rootA, META_ID.rootB, R.metaRunsDb, R.metaRunsDs, R.metaLedgerDb, R.metaLedgerDs, R.metaGatesDb, R.metaGatesDs, R.gateM1]);
  const touched = ids.filter((id) => meta.has(id));
  assert.deepEqual(touched, [], "no META object was read while operating the SALES binding");
  assert.equal((await w.deps.store.events.list({})).filter((e) => e.event_type === "PLAN_CREATED").length, 0);
});

test("PT-SALES-005: the registry is discovery only — a stale registry snapshot never overrides the fresh Sales Manifest / OS State", async () => {
  const w = buildResumeWorld();
  w.setSalesRegistry([
    { rep_identity_key: "rep-a", status: "KNOWN", root_ref: SALES_IDS("rep-a").root, expected_instance_id: "SALESOS-FIXTURE-A", expected_gmail_identity: "rep-a@example.invalid", pointer_generation: "1", snapshot: { install_state: "READY", instance_status: "ACTIVE", current_gate: "B9_DONE", snapshot_at: "2029-12-01T00:00:00.000Z" } },
    { rep_identity_key: "rep-b", status: "KNOWN", root_ref: SALES_IDS("rep-b").root, expected_instance_id: "SALESOS-FIXTURE-B", expected_gmail_identity: "rep-b@example.invalid", pointer_generation: "1" },
  ]);
  const b = await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, asA, w.deps) as Ok;
  assert.equal((b.result as { lifecycle_state: string }).lifecycle_state, "SETUP", "Manifest install state wins over the registry snapshot");
  const r = await dispatch("os_resume", { binding_handle: handleOf(b) }, asA, w.deps) as Ok;
  assert.equal(r.code, "RESUMED");
  assert.equal((r.result as { gate: { gate_key: string } }).gate.gate_key, "B2_ICP", "OS State gate wins");
  assert.ok(r.warnings.some((x) => x.startsWith("registry_snapshot_stale: install_state")));
  assert.ok(r.warnings.some((x) => x.startsWith("registry_snapshot_stale: current_gate")));
});

test("PT-SALES-006: NOT_YET_CREATED, NOT_FOUND and UNKNOWN stay distinct machine states with distinct bind outcomes", async () => {
  const w = buildResumeWorld();
  w.setSalesRegistry([
    { rep_identity_key: "rep-a", status: "NOT_YET_CREATED", note: "creation scheduled" },
  ]);
  const notYet = await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, asA, w.deps);
  assert.equal(notYet.code, "HOLD_RUNTIME_NOT_YET_CREATED");
  assert.ok((notYet as { evidence: readonly string[] }).evidence.includes("existence=NOT_YET_CREATED"));
  w.setSalesRegistry([{ rep_identity_key: "rep-a", status: "KNOWN", root_ref: "0123456789abcdef0123456789abcdef", expected_instance_id: "X", pointer_generation: "1" }]);
  const notFound = await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, asA, w.deps);
  assert.equal(notFound.code, "HOLD_RUNTIME_NOT_FOUND");
  assert.ok((notFound as { evidence: readonly string[] }).evidence.includes("existence=NOT_FOUND"));
  w.setSalesRegistry([]);
  const unknown = await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, asA, w.deps);
  assert.equal(unknown.code, "HOLD_RUNTIME_NOT_FOUND");
  assert.ok((unknown as { evidence: readonly string[] }).evidence.includes("existence=UNKNOWN"));
  assert.notDeepEqual((unknown as { evidence: readonly string[] }).evidence, (notFound as { evidence: readonly string[] }).evidence, "absence of discovery is not proof of nonexistence");
});

test("PT-SALES-007: the internal transaction path introduces no external send authority — intents are Notion records with routing metadata only", async () => {
  // Surface: the five W3.3 tools, none named or described as sending; no input field can carry a send.
  assert.deepEqual([...TOOL_NAMES], ["os_bind", "os_resume", "os_commit", "os_handoff", "os_control_status"]);
  for (const n of TOOL_NAMES) assert.doesNotMatch(toolDescriptions[n], /\bsends?\b|\bsending\b|e-?mail/i, `${n} description carries no send capability`);
  assert.deepEqual(Object.keys(toolInputSchemas.os_prepare.shape).sort(), ["binding_handle", "capability_evidence", "intent"]);
  const methods = Object.getOwnPropertyNames(HttpNotionReadClient.prototype).filter((m) => m !== "constructor");
  assert.ok(methods.every((m) => /^(retrieve|query)/.test(m)), "the only external client is read-only Notion");
  // Encoding a send as a Notion mutation is refused: executor-owned fields are protected.
  const w = buildResumeWorld();
  const hS = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, asA, w.deps));
  for (const desired of [{ "Effect Status": "SENT" }, { "Approval State": "APPROVED" }, { "Record Type": "EFFECT" }, { "Competent Source ID": "gmail:msg-1" }, { Verified: true }, { "Observed At": "2030-01-03T00:00:00.000Z" }]) {
    const r = await dispatch("os_prepare", { binding_handle: hS, intent: { action_class: "SEND", summary: "send now", mutations: [{ logical_resource_key: "SALES:EXTERNAL_ACTIONS", operation: "UPDATE", record_selector: { existing_object_id: SALES_EXT_ROW("rep-a") }, desired_changes: desired }] } }, asA, w.deps);
    assert.equal(r.code, "HOLD_UNSUPPORTED_OPERATION", JSON.stringify(desired));
  }
  const bogus = await dispatch("os_prepare", { binding_handle: hS, intent: { action_class: "SEND", summary: "send", mutations: [{ logical_resource_key: "SALES:GMAIL_SEND", operation: "CREATE", record_selector: { natural_key: "k" }, desired_changes: { To: "x@example.invalid" } }] } }, asA, w.deps);
  assert.equal(bogus.code, "HOLD_RESOURCE_UNKNOWN");
  // A legitimate INTENT: the plan is pure Notion writes with backend defaults (INTENT / PREPARED); TARGET exposes routing metadata and no send authority.
  const p = await dispatch("os_prepare", { binding_handle: hS, intent: intentFor("ak-intent-7") }, asA, w.deps);
  assert.equal(p.code, "PLAN_PREPARED", JSON.stringify(p));
  const plan = (await w.deps.store.plans.get(((p as Ok).result as { plan_id: string }).plan_id))!;
  const create = plan.stage1_writes.find((s) => s.purpose === "WRITE_TARGET")!;
  assert.equal(create.fields["Record Type"], "INTENT");
  assert.equal(create.fields["Effect Status"], "PREPARED");
  assert.equal((p as Ok).result["stage1_actions"], undefined, "no native-call rendering or external send authority");
  assert.ok(plan.stage1_writes.every((wi) => wi.operation === "CREATE" || wi.operation === "UPDATE"));
  executeWrites(w, plan.stage1_writes, plan.plan_id, { now: "2030-01-03T00:30:00.000Z" });
  const t = await dispatch("os_verify", { binding_handle: hS, plan_id: plan.plan_id, phase: "TARGET" }, asA, w.deps);
  assert.equal(t.code, "TARGET_VERIFIED", JSON.stringify(t));
  const ext = ((t as Ok).result as { external_action_intents: Array<{ send_authority: string; effect_status: string; routing: Record<string, string> }> }).external_action_intents;
  assert.equal(ext.length, 1);
  assert.equal(ext[0]!.send_authority, "NONE");
  assert.equal(ext[0]!.effect_status, "PREPARED");
  assert.equal(ext[0]!.routing["Recipient"], "prospect@example.invalid");
  // Resume reconstructs the unresolved intent (routing metadata) and flags competent-source reconciliation.
  const hS2 = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, asA, w.deps));
  const rs = await dispatch("os_resume", { binding_handle: hS2 }, asA, w.deps);
  assert.equal(rs.code, "HOLD_RECOVERY_REQUIRED", "an unresolved intent (and the in-flight Run) is recovery, never silently healthy");
  const ea = (rs.observations["external_actions"] as { unresolved: Array<{ action_key: string; recipient: string; effect_status: string }>; reconciliation_required: boolean; competent_source: string });
  assert.equal(ea.reconciliation_required, true);
  assert.equal(ea.competent_source, "GMAIL");
  assert.equal(ea.unresolved[0]!.action_key, "ak-intent-7");
  assert.equal(ea.unresolved[0]!.recipient, "prospect@example.invalid");
  assert.equal(ea.unresolved[0]!.effect_status, "PREPARED");
  assert.equal(SALES_CONTROL_PLANE_05.resources?.["SALES:EXTERNAL_ACTIONS"]?.externalEffect, true);
  void extIntent;
});
