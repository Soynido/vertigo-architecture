/** Validation of the EXISTING readoption transaction kernel for an explicitly authorized
 * administrative META baseline. No original failed transaction is recovered or blessed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { hashHandle } from "../../src/binding/handle.ts";
import { authorize } from "../../src/auth/principal.ts";
import { FixtureNotionClient } from "../../src/notion/fixtureClient.ts";
import { normalizeId, propText, type Page } from "../../src/notion/shapes.ts";
import { readControlPlane } from "../../src/resume/readers.ts";
import { deriveResumeState } from "../../src/resume/derive.ts";
import { resolveTarget, readSchema } from "../../src/plans/resources.ts";
import { createPlan, opaqueId } from "../../src/plans/service.ts";
import { deriveWrites } from "../../src/plans/writes.ts";
import { dispatch, resolveRuntimeFor } from "../../src/tools/handlers.ts";
import { executeTransaction } from "../../src/transactions/execute.ts";
import { Deadline } from "../../src/transactions/budget.ts";
import { OWNER, handleOf } from "./binding-fixtures.ts";
import { buildResumeWorld, R, runPage, ledgerRow, META_MANIFEST_DS } from "./resume-fixtures.ts";
import { synthetic } from "./meta-fixtures.ts";

const NOW = new Date("2030-01-03T10:00:00.000Z"), ctx = { principal_id: OWNER.principal_id, now: NOW };
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

async function setup() {
  const w = buildResumeWorld();
  w.setMetaRuns([
    runPage({ id: R.run1, label: "TRUN-1", status: "HOLD", lastEdited: "2030-01-01T06:00:00.000Z", holds: "unverified old transaction" }),
    runPage({ id: R.run2, label: "TRUN-2", status: "HOLD", lastEdited: "2030-01-01T07:00:00.000Z", mutationCount: 5, verified: 0, holds: "preserve five FAILED and human decisions; no original verification" }),
  ]);
  const failures = [1, 2, 3, 4, 5].map(n => ledgerRow(synthetic(`old-failed-${n}`), `TMUT-${n}`, "FAILED", "TRUN-2", "2030-01-01T08:00:00.000Z"));
  w.setMetaLedger(failures);
  w.setMetaManifest({ lastRunId: R.run2, lastEdited: "2030-01-02T00:00:00.000Z", lastVerifiedMutation: "TMUT-9 | manual old claim" });
  // The fixture declares exactly the options already used by the executor's normal workflow.
  for (const ds of [R.metaRunsDs, R.metaLedgerDs]) {
    const schema = w.map.get(`data_source:${ds}`) as { properties: Record<string, { type: string }> };
    w.map.set(`data_source:${ds}`, { ...schema, properties: Object.fromEntries(Object.entries(schema.properties).map(([k, p]) => [k,
      p.type === "select" ? { ...p, select: { options: (k === "Origin" ? ["PLUGIN", "META_RUNTIME"] : k === "Status" ? ["RUNNING", "COMPLETED", "HOLD", "FAILED", "PREPARED", "WRITTEN", "VERIFIED"] : k === "Operation" ? ["UPDATE"] : []).map(name => ({ name })) } } : p])) });
  }
  const client = new FixtureNotionClient(w.map, { now: () => NOW });
  const deps = { ...w.deps, notion: client, notionWriter: client };
  const h = handleOf(await dispatch("os_bind", { lane: "META" }, ctx, deps));
  const binding = (await deps.store.bindings.findByHandleHash(hashHandle(h)))!;
  const actor = await authorize(deps.principals, ctx.principal_id, binding.project, binding.lane);
  assert.equal(actor.ok, true); if (!actor.ok) throw Error("no actor");
  assert.equal(actor.principal.meta_authority, "COMPANY_OWNER");
  const resolved = await resolveRuntimeFor(deps, actor.principal, binding.project, binding.lane);
  assert.equal(resolved.kind, "RESOLVED"); if (resolved.kind !== "RESOLVED") throw Error("no runtime");
  const runtime = resolved.runtime, snap = await readControlPlane(client, runtime);
  assert(!("hold" in snap)); const old = deriveResumeState(snap); assert.equal(old.kind, "STATE");
  if (old.kind !== "STATE") throw Error("expected derived state");
  assert.equal(old.state.recovery_required, true);
  assert.notEqual(old.state.effective_hold, "NONE");
  const target = await resolveTarget(client, runtime, binding.binding_mode, "META:GATES", "UPDATE", { natural_key: "T1" });
  assert(target.ok && target.target.kind === "EXISTING"); if (!target.ok || target.target.kind !== "EXISTING") throw Error("no gate");
  const page = target.target.page, fields = ["Gate Key", "Status", "Open Blocker", "Next Action", "Next Question", "Control Confirmation State", "Passed By Run Ref"];
  assert.equal(typeof page.last_edited_time, "string");
  const values = Object.fromEntries(fields.map(f => [f, propText(page, f) ?? ""]));
  const hash = digest(Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b))));
  const op = { operation_id: opaqueId(), ordinal: 0, logical_resource_key: "META:GATES", operation: "UPDATE" as const,
    physical_target_ref: target.target.page_ref, target_data_source_ref: target.target.data_source.id,
    natural_key: "T1", natural_key_property: "Gate Key", natural_key_property_type: "rich_text",
    idempotency_key: digest([binding.runtime_generation, target.target.page_ref, hash]), baseline_revision: page.last_edited_time!,
    compared_fields: fields, before_values: values, expected_values: values, before_hash: hash, expected_hash: hash };
  const governing = binding.governing_versions_snapshot as { spec: string; schema: string; control: string }, planId = opaqueId();
  const cursorSchema = (await readSchema(client, META_MANIFEST_DS))!;
  const writes = deriveWrites(runtime.adapter.controlPlane, [op], { plan_id: planId, summary: "AS-IS CURRENT BASELINE — old failures unverified and preserved",
    runs_ds: R.metaRunsDs, ledger_ds: R.metaLedgerDs, cursor_ref: runtime.manifest_ref, gate_key: "T1", governing,
    run_schema: (await readSchema(client, R.metaRunsDs))!.properties, ledger_schema: (await readSchema(client, R.metaLedgerDs))!.properties,
    cursor_schema: cursorSchema.properties });
  assert.equal(writes.stage1.some(x => x.purpose === "WRITE_TARGET"), false);
  const created = await createPlan(deps.store, deps.config, { principal_id: binding.principal_id, binding, governing, plan_id: planId,
    plan_origin: "AUTO_RECONCILE", run_mode: "OPEN_NEW", execution_attempt_id: opaqueId(), baseline_runtime_revision: snap.manifest.last_edited,
    operations: [op], stage1_writes: writes.stage1, finalization_writes: writes.finalization, state_last_write: writes.state_last }, NOW);
  assert.equal(created.kind, "CREATED"); if (created.kind !== "CREATED") throw Error("no plan");
  const protectedPages = [R.run1, R.run2, ...failures.map(p => p.id), page.id];
  const before = protectedPages.map(id => [normalizeId(id), digest(w.map.get(`page:${normalizeId(id)}`))]);
  const execute = () => executeTransaction(deps, { principal_id: binding.principal_id, binding, runtime, plan_id: created.plan.plan_id,
    cursor_ref: runtime.manifest_ref, clock: () => NOW, deadline: new Deadline(() => NOW.getTime()), sleep: async () => {} });
  return { w, deps, client, runtime, binding, h, execute, plan: created.plan, before, protectedPages, gatePage: page };
}

test("owner META baseline: existing kernel proves the current gate as-is, preserving both historical holds and all five failures", async () => {
  const s = await setup(), out = await s.execute();
  assert.equal(out.kind, "PERSISTED", JSON.stringify(out)); if (out.kind !== "PERSISTED") return;
  assert.equal(out.step_moved, false);
  assert.deepEqual(s.client.writes.map(x => x.ctx.symbol), ["OPEN_RUN", "LEDGER_0", "LEDGER_0_WRITTEN", "LEDGER_0_VERIFIED", "FINALIZE_RUN", "STATE_LAST"]);
  assert.deepEqual(s.protectedPages.map(id => [normalizeId(id), digest(s.w.map.get(`page:${normalizeId(id)}`))]), s.before);
  const resumed = await dispatch("os_resume", { binding_handle: s.h }, ctx, s.deps);
  assert.equal(resumed.code, "RESUMED", JSON.stringify(resumed));
  assert.equal(resumed.status, "OK"); if (resumed.status !== "OK") return;
  const state = resumed.result;
  assert.equal(state.recovery_required, false);
  assert.equal((state.historical_holds as unknown[]).length, 2);
  assert.equal((state.historical_mutations as unknown[]).length, 5);
  const bytes = s.client.writes.length;
  const repeated = await s.execute(); assert.equal(repeated.kind, "PERSISTED");
  assert.equal(s.client.writes.length, bytes, "only the existing FINAL is returned");
});

test("owner META baseline: current gate drift cannot receive a FINAL and cannot rewrite historical failures", async () => {
  const s = await setup();
  s.client.onWrite = write => { if (write.ctx.symbol === "LEDGER_0_VERIFIED") {
    const page = s.w.map.get(`page:${s.gatePage.id}`) as Page;
    s.w.map.set(`page:${s.gatePage.id}`, { ...page, properties: { ...page.properties, "Next Question": { type: "rich_text", rich_text: [{ type: "text", text: { content: "concurrent question" }, plain_text: "concurrent question" }] } } });
  } };
  const out = await s.execute(); assert.equal(out.kind, "HELD");
  assert.equal((await s.deps.store.receipts.findByPlan(s.plan.plan_id, "FINAL")).length, 0);
  assert.equal(s.client.writes.some(x => x.target === s.gatePage.id), false, "no correction of the concurrent business edit");
  for (const [id, hash] of s.before.slice(0, 7)) assert.equal(digest(s.w.map.get(`page:${id}`)), hash);
});
