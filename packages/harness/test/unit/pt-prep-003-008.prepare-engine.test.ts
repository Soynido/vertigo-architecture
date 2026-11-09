/**
 * PV0-010 — os_prepare canonical plan engine.
 * PT-PREP-003 caller cannot assert baseline/Run/gate/verification truth (ADVERSARIAL)
 * PT-PREP-004 wrong logical resource / record target is rejected (ADVERSARIAL)
 * PT-PREP-005 recovery state blocks unrelated new prepare (ADVERSARIAL)
 * PT-PREP-007 retry does not create a duplicate Run/plan while an equivalent plan is active (ADVERSARIAL)
 * PT-PREP-008 cross-runtime plan target is denied (ADVERSARIAL)
 * plus: version change since bind, authority, deterministic plan content.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../../src/tools/handlers.ts";
import { hashHandle } from "../../src/binding/handle.ts";
import { transition } from "../../src/plans/service.ts";
import { metaSpecAdapter } from "../../src/versions/adapters/meta.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import { handleOf, OWNER, T0, type World } from "./binding-fixtures.ts";
import { buildResumeWorld, gateRow, ledgerRow, R, runPage, SALES_EXT_DS, SALES_EXT_ROW, type ResumeWorld } from "./resume-fixtures.ts";
import { GRAMMAR as META_GRAMMAR, ID as META_ID, specRootChildren, V as MV } from "./meta-fixtures.ts";

const ctx = { principal_id: OWNER.principal_id, now: T0 };
const gateIntent = (question = "What is the offer?") => ({ action_class: "COMMIT", summary: "set the next frame question", mutations: [{ logical_resource_key: "META:GATES", operation: "UPDATE" as const, record_selector: { natural_key: "T1" }, desired_changes: { "Next Question": question } }] });

async function noPlan(w: World, gen?: string) {
  const plans = await w.deps.store.plans.findActive("VERTIGO", "META", gen ?? "");
  const created = (await w.deps.store.events.list({})).filter((e) => e.event_type === "PLAN_CREATED");
  return { plans, created };
}
function genOf(w: World, handle: string): Promise<string> {
  return w.deps.store.bindings.findByHandleHash(hashHandle(handle)).then((b) => b!.runtime_generation);
}
async function bindMeta(w: World): Promise<string> { return handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps)); }

test("os_prepare (happy path): backend-owned plan with baseline from Notion, ordered stage-1 writes, finalization and state-last derived", async () => {
  const w = buildResumeWorld();
  const h = await bindMeta(w);
  const r = await dispatch("os_prepare", { binding_handle: h, intent: gateIntent() }, ctx, w.deps);
  assert.equal(r.status, "OK", JSON.stringify(r));
  assert.equal(r.code, "PLAN_PREPARED");
  const res = (r as Extract<Envelope, { status: "OK" }>).result as { plan_id: string; run_mode: string; replayed: boolean; operations: Array<Record<string, unknown>>; stage1_writes: Array<{ purpose: string; target_ref: string; fields: Record<string, unknown>; symbol: string }> };
  assert.equal(res.run_mode, "OPEN_NEW");
  assert.equal(res.replayed, false);
  assert.equal(res.operations.length, 1);
  assert.equal(res.operations[0]!["physical_target_ref"], R.gateM1, "target resolved inside the bound runtime");
  assert.deepEqual(res.operations[0]!["before_values"], { "Next Question": "What do you sell?" }, "baseline read from Notion");
  assert.deepEqual(res.operations[0]!["expected_values"], { "Next Question": "What is the offer?" });
  assert.deepEqual(res.operations[0]!["compared_fields"], ["Next Question"]);
  assert.deepEqual(res.stage1_writes.map((s) => s.purpose), ["OPEN_RUN", "PREPARE_LEDGER", "WRITE_TARGET", "LEDGER_WRITTEN"]);
  assert.deepEqual(res.stage1_writes.map((s) => s.target_ref), [R.metaRunsDs, R.metaLedgerDs, R.gateM1, "$created:LEDGER_0"]);
  assert.ok(!res.stage1_writes.some((s) => s.target_ref === META_ID.manifest || s.purpose === "STATE_LAST"), "no State/Manifest write in stage 1");
  assert.equal(res.stage1_writes[0]!.fields["Harness Plan ID"], res.plan_id);
  assert.equal(res.stage1_writes[0]!.fields["Status"], "RUNNING");
  assert.equal(res.stage1_writes[1]!.fields["Status"], "PREPARED");
  assert.equal(res.stage1_writes[1]!.fields["Run Ref"], "$created:OPEN_RUN");
  const plan = (await w.deps.store.plans.get(res.plan_id))!;
  assert.equal(plan.plan_state, "AWAITING_STAGE1_WRITES");
  assert.deepEqual(plan.finalization_writes.map((f) => f.purpose), ["LEDGER_VERIFIED", "FINALIZE_RUN"]);
  assert.equal(plan.state_last_write.target_ref, META_ID.manifest);
  assert.equal(plan.state_last_write.purpose, "STATE_LAST");
  assert.equal(plan.governing_spec_version, MV.specA);
  const lease = await w.deps.store.leases.current({ project: "VERTIGO", lane: "META", runtime_generation: plan.runtime_generation }, T0);
  assert.equal(lease?.plan_id, res.plan_id, "lease held by the new plan");
  // PV-UX-007: no tool is permitted until the native writes are done. Naming `os_verify` here is what made a
  // fresh chat verify writes it had never performed — twice, in two different conversations.
  assert.equal(r.next.permitted_tool_call, undefined, "a tool named as permitted while writes are pending is read as permission to call it now");
  assert.equal(r.next.native_actions_required, undefined, "no native-writer fallback after cutover");
  assert.match(r.next.safe_action, /guarded backend executor/);
});

test("PT-PREP-003: forbidden authority inputs are rejected at every level and never reach the plan", async () => {
  const w = buildResumeWorld();
  const h = await bindMeta(w);
  const forbidden = { runtime_id: "x", root_ref: "x", physical_root: "x", current_run: "RUN-1", run_id: "RUN-1", baseline: {}, baseline_values: {}, compared_fields: [], gate: "G", current_gate: "G", verified: true, manifest_patch: {}, expected_values: {}, plan_id: "mine", run_mode: "RESUME_EXISTING" };
  for (const [k, v] of Object.entries(forbidden)) {
    const top = await dispatch("os_prepare", { binding_handle: h, intent: gateIntent(), [k]: v }, ctx, w.deps);
    assert.equal(top.code, "ERROR_INVALID_ARGUMENT", `top-level ${k}`);
    const inIntent = await dispatch("os_prepare", { binding_handle: h, intent: { ...gateIntent(), [k]: v } }, ctx, w.deps);
    assert.equal(inIntent.code, "ERROR_INVALID_ARGUMENT", `intent.${k}`);
    const m = gateIntent().mutations[0]!;
    const inMutation = await dispatch("os_prepare", { binding_handle: h, intent: { ...gateIntent(), mutations: [{ ...m, [k]: v }] } }, ctx, w.deps);
    assert.equal(inMutation.code, "ERROR_INVALID_ARGUMENT", `mutation.${k}`);
    const inSelector = await dispatch("os_prepare", { binding_handle: h, intent: { ...gateIntent(), mutations: [{ ...m, record_selector: { ...m.record_selector, [k]: v } }] } }, ctx, w.deps);
    assert.equal(inSelector.code, "ERROR_INVALID_ARGUMENT", `record_selector.${k}`);
  }
  // Control-owned fields cannot be smuggled through desired_changes either.
  const smuggle = await dispatch("os_prepare", { binding_handle: h, intent: { ...gateIntent(), mutations: [{ ...gateIntent().mutations[0]!, desired_changes: { Status: "PASS", "Passed By Run Ref": "RUN-1" } }] } }, ctx, w.deps);
  assert.equal(smuggle.code, "HOLD_UNSUPPORTED_OPERATION");
  const { created } = await noPlan(w);
  assert.equal(created.length, 0, "no plan created by any rejected call");
  assert.equal((await w.deps.store.plans.findActive("VERTIGO", "META", await genOf(w, h))).length, 0);
});

test("PT-PREP-004: unknown resource, missing target, ambiguous target, unknown field and bogus object id are refused without a plan or lease", async () => {
  const w = buildResumeWorld();
  const h = await bindMeta(w);
  const gen = await genOf(w, h);
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["unknown logical resource", { logical_resource_key: "META:NOPE", operation: "UPDATE", record_selector: { natural_key: "T1" }, desired_changes: { "Next Question": "q" } }, "HOLD_RESOURCE_UNKNOWN"],
    ["control-plane resource is not addressable", { logical_resource_key: "META:RUNS", operation: "CREATE", record_selector: { natural_key: "RUN-99" }, desired_changes: { Status: "COMPLETED" } }, "HOLD_RESOURCE_UNKNOWN"],
    ["no such row", { logical_resource_key: "META:GATES", operation: "UPDATE", record_selector: { natural_key: "T9" }, desired_changes: { "Next Question": "q" } }, "HOLD_TARGET_NOT_FOUND"],
    ["field outside schema", { logical_resource_key: "META:GATES", operation: "UPDATE", record_selector: { natural_key: "T1" }, desired_changes: { Nonexistent: "q" } }, "HOLD_SCHEMA_MISMATCH"],
    ["bogus existing_object_id", { logical_resource_key: "META:GATES", operation: "UPDATE", record_selector: { existing_object_id: "not-an-id" }, desired_changes: { "Next Question": "q" } }, "HOLD_TARGET_NOT_FOUND"],
    ["CREATE not permitted on gates", { logical_resource_key: "META:GATES", operation: "CREATE", record_selector: { natural_key: "T7" }, desired_changes: { "Next Question": "q" } }, "HOLD_UNSUPPORTED_OPERATION"],
    ["empty selector", { logical_resource_key: "META:GATES", operation: "UPDATE", record_selector: {}, desired_changes: { "Next Question": "q" } }, "HOLD_TARGET_NOT_FOUND"],
  ];
  for (const [label, mutation, code] of cases) {
    const r = await dispatch("os_prepare", { binding_handle: h, intent: { action_class: "COMMIT", summary: label, mutations: [mutation] } }, ctx, w.deps);
    assert.equal(r.status, "HOLD", label);
    assert.equal(r.code, code, label);
    assert.ok((r as { evidence: readonly string[] }).evidence.includes("no plan was created"), label);
  }
  // Ambiguous: two rows with the same natural key.
  w.setMetaGates([gateRow({ id: R.gateM1, key: "T1", status: "OPEN", nextQuestion: "What do you sell?" }), gateRow({ id: R.gateM1.replace(/.$/, "f"), key: "T1", status: "OPEN", nextQuestion: "dup" })]);
  const amb = await dispatch("os_prepare", { binding_handle: h, intent: gateIntent() }, ctx, w.deps);
  assert.equal(amb.code, "HOLD_TARGET_AMBIGUOUS");
  assert.equal((await w.deps.store.plans.findActive("VERTIGO", "META", gen)).length, 0);
  assert.equal(await w.deps.store.leases.current({ project: "VERTIGO", lane: "META", runtime_generation: gen }, T0), undefined);
  assert.equal((await noPlan(w)).created.length, 0);
});

test("PT-PREP-005: recovery state (incomplete Run, non-VERIFIED ledger, divergence) blocks an unrelated new prepare; no Run/plan", async () => {
  const w: ResumeWorld = buildResumeWorld();
  const h = await bindMeta(w);
  const gen = await genOf(w, h);
  // Incomplete run referenced by the Manifest and flagged.
  w.setMetaRuns([runPage({ id: R.run2, label: "TRUN-2", status: "HOLD", recovery: true, nextAction: "finish TRUN-2", lastEdited: "2030-01-03T00:00:00.000Z" })]);
  w.setMetaManifest({ lastRunId: R.run2, recovery: true, lastEdited: "2030-01-03T00:00:00.000Z" });
  const r1 = await dispatch("os_prepare", { binding_handle: h, intent: gateIntent() }, ctx, w.deps);
  assert.equal(r1.code, "HOLD_RECOVERY_REQUIRED", JSON.stringify(r1));
  assert.match(r1.next.safe_action, /recover run TRUN-2/);
  // Only a non-VERIFIED ledger row.
  w.setMetaRuns([runPage({ id: R.run1, label: "TRUN-1", status: "COMPLETED", lastEdited: "2030-01-01T12:00:00.000Z" })]);
  w.setMetaManifest({});
  w.setMetaLedger([ledgerRow(R.run3, "TMUT-3", "PREPARED", "TRUN-1")]);
  const r2 = await dispatch("os_prepare", { binding_handle: h, intent: gateIntent() }, ctx, w.deps);
  assert.equal(r2.code, "HOLD_RECOVERY_REQUIRED");
  // Divergence: incomplete run neither referenced nor flagged.
  w.setMetaLedger([]);
  w.setMetaRuns([runPage({ id: R.run2, label: "TRUN-2", status: "RUNNING", lastEdited: "2030-01-03T00:00:00.000Z" })]);
  const r3 = await dispatch("os_prepare", { binding_handle: h, intent: gateIntent() }, ctx, w.deps);
  assert.equal(r3.code, "HOLD_STATE_DIVERGENCE");
  assert.equal((await w.deps.store.plans.findActive("VERTIGO", "META", gen)).length, 0);
  assert.equal(await w.deps.store.leases.current({ project: "VERTIGO", lane: "META", runtime_generation: gen }, T0), undefined);
  assert.equal((await noPlan(w)).created.length, 0);
});

test("PT-PREP-007: a client retry of the same intent surfaces the existing plan; never a duplicate Run or second canonical plan", async () => {
  const w = buildResumeWorld();
  const h = await bindMeta(w);
  const first = await dispatch("os_prepare", { binding_handle: h, intent: gateIntent() }, ctx, w.deps);
  const retry = await dispatch("os_prepare", { binding_handle: h, intent: gateIntent() }, ctx, w.deps);
  assert.equal(first.code, "PLAN_PREPARED");
  assert.equal(retry.code, "PLAN_PREPARED");
  const a = (first as Extract<Envelope, { status: "OK" }>).result as { plan_id: string; stage1_writes: unknown[]; replayed: boolean };
  const b = (retry as Extract<Envelope, { status: "OK" }>).result as { plan_id: string; stage1_writes: unknown[]; replayed: boolean };
  assert.equal(b.plan_id, a.plan_id, "same canonical plan");
  assert.equal(b.replayed, true);
  assert.deepEqual(b.stage1_writes, a.stage1_writes, "identical stage-1 instructions (one Run open)");
  const gen = await genOf(w, h);
  assert.equal((await w.deps.store.plans.findActive("VERTIGO", "META", gen)).length, 1);
  assert.equal((await noPlan(w)).created.length, 1);
  // A different intent on the SAME record from the same binding, before any write, replaces the unwritten draft
  // (2026-09-23: the seller edited their answer and was told to wait fifteen minutes for their own plan to
  // expire). Still exactly one active plan, never two; the draft is SUPERSEDED, and it had opened no Run.
  const other = await dispatch("os_prepare", { binding_handle: h, intent: gateIntent("Another question?") }, ctx, w.deps);
  assert.equal(other.code, "PLAN_PREPARED", JSON.stringify(other));
  const c = (other as Extract<Envelope, { status: "OK" }>).result as { plan_id: string };
  assert.notEqual(c.plan_id, a.plan_id, "an edited answer is a new plan");
  assert.equal((await w.deps.store.plans.get(a.plan_id))!.plan_state, "SUPERSEDED");
  assert.equal((await w.deps.store.plans.findActive("VERTIGO", "META", gen)).length, 1, "never two active plans");
  // Once stage 1 is past (TARGET_VERIFIED), the plan is no longer a draft: a retry of its intent surfaces it and
  // re-issues no stage-1 instructions, and a different intent is busy, not a second plan.
  await transition(w.deps.store, c.plan_id, "TARGET_VERIFIED", T0);
  const late = await dispatch("os_prepare", { binding_handle: h, intent: gateIntent("Another question?") }, ctx, w.deps);
  assert.equal(late.code, "HOLD_EXISTING_PLAN_ACTIVE");
  assert.equal((late.observations as { plan_id: string }).plan_id, c.plan_id);
  const busy = await dispatch("os_prepare", { binding_handle: h, intent: gateIntent("A third question?") }, ctx, w.deps);
  assert.equal(busy.code, "HOLD_RUNTIME_BUSY", "a plan that already wrote is protected by the lease");
  assert.equal((await noPlan(w)).created.length, 2, "two plans were created in all: the draft and its replacement");
});

test("PT-PREP-008: a target in another lane or another runtime is denied and nothing is persisted", async () => {
  const w = buildResumeWorld();
  const hMeta = await bindMeta(w);
  const cross = await dispatch("os_prepare", { binding_handle: hMeta, intent: { action_class: "COMMIT", summary: "x", mutations: [{ logical_resource_key: "SALES:EXTERNAL_ACTIONS", operation: "UPDATE", record_selector: { natural_key: "k" }, desired_changes: { Recipient: "a" } }] } }, ctx, w.deps);
  assert.equal(cross.code, "HOLD_CROSS_LANE");
  // SALES binding of rep A; selector names rep B's row by object id.
  const hSales = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps));
  const foreign = await dispatch("os_prepare", { binding_handle: hSales, intent: { action_class: "COMMIT", summary: "x", mutations: [{ logical_resource_key: "SALES:EXTERNAL_ACTIONS", operation: "UPDATE", record_selector: { existing_object_id: SALES_EXT_ROW("rep-b") }, desired_changes: { Recipient: "someone" } }] } }, ctx, w.deps);
  assert.equal(foreign.code, "HOLD_CROSS_RUNTIME", JSON.stringify(foreign));
  assert.ok((foreign as { evidence: readonly string[] }).evidence.some((e) => e.includes(SALES_EXT_DS("rep-b"))));
  assert.equal((await noPlan(w)).created.length, 0);
  const genS = await genOf(w, hSales);
  assert.equal((await w.deps.store.plans.findActive("VERTIGO", "SALES", genS)).length, 0);
  // Sanity: the rep's own row resolves inside their runtime.
  const own = await dispatch("os_prepare", { binding_handle: hSales, intent: { action_class: "COMMIT", summary: "x", mutations: [{ logical_resource_key: "SALES:EXTERNAL_ACTIONS", operation: "UPDATE", record_selector: { existing_object_id: SALES_EXT_ROW("rep-a") }, desired_changes: { Recipient: "someone" } }] } }, ctx, w.deps);
  assert.equal(own.code, "PLAN_PREPARED", JSON.stringify(own));
  const ownRes = (own as Extract<Envelope, { status: "OK" }>).result as { operations: Array<{ target_data_source_ref: string; physical_target_ref: string }> };
  assert.equal(ownRes.operations[0]!.target_data_source_ref, SALES_EXT_DS("rep-a"));
  assert.equal(ownRes.operations[0]!.physical_target_ref, SALES_EXT_ROW("rep-a"));
  const plan = (await w.deps.store.plans.findActive("VERTIGO", "SALES", genS))[0]!;
  assert.equal(plan.state_last_write.target_ref, R.salesStateRow, "SALES state-last targets the OS State CURRENT row");
});

test("governing version changed since bind ⇒ HOLD_VERSION_CHANGED before any target resolution; missing META authority ⇒ HOLD_ACTION_NOT_AUTHORIZED", async () => {
  const w = buildResumeWorld();
  const h = await bindMeta(w);
  w.deps.adapters.metaRuntime.register(MV.specB, metaSpecAdapter(MV.specB, [MV.schema], META_GRAMMAR));
  w.map.set(`children:${META_ID.specRoot}`, { results: specRootChildren({ spec: MV.specB }), has_more: false, next_cursor: null });
  const r = await dispatch("os_prepare", { binding_handle: h, intent: gateIntent() }, ctx, w.deps);
  assert.equal(r.code, "HOLD_VERSION_CHANGED", JSON.stringify(r));
  assert.equal((await noPlan(w)).created.length, 0);

  const w2 = buildResumeWorld();
  const { meta_authority: _drop, ...noAuthority } = OWNER; void _drop; w2.setPrincipals([noAuthority]);
  const h2 = await bindMeta(w2);
  const r2 = await dispatch("os_prepare", { binding_handle: h2, intent: gateIntent() }, ctx, w2.deps);
  assert.equal(r2.code, "HOLD_ACTION_NOT_AUTHORIZED");
  assert.equal((await noPlan(w2)).created.length, 0);
});
