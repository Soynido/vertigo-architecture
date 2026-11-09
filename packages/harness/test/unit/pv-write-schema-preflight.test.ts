/** The candidate writer must not open new unfinished work for a schema gap it already knows.
 * Uses the actual commit/prepare/executor/store with a Notion-shaped local client, not a mocked prepare.
 * Removing prepare's candidate schema refusal must fail the no-plan/no-lease/no-write assertions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hashHandle } from "../../src/binding/handle.ts";
import { dispatch, dispatchCommit } from "../../src/tools/handlers.ts";
import { FixtureNotionClient } from "../../src/notion/fixtureClient.ts";
import { propText } from "../../src/notion/shapes.ts";
import { draftHistoricalSchemaAdditions } from "../../src/migration/historicalSchemaDraft.ts";
import { b0Intent, B0_KEY, G, guardWorld, NOW, rowsOf, type GuardWorld } from "../support/guard-fixtures.ts";
import { R, buildResumeWorld } from "./resume-fixtures.ts";
import { handleOf, OWNER } from "./binding-fixtures.ts";
import { declareOptions } from "../support/transact.ts";

type Schema = { properties: Record<string, { type: string; select?: { options: Array<{ name: string }> } }> };
const gaps = [
  { source: R.salesRunsDs, name: "Harness Plan ID" },
  { source: R.salesLedgerDs, name: "Harness Plan ID" },
  { source: R.salesLedgerDs, name: "Target Receipt ID" },
] as const;

async function assertNoNewWork(g: GuardWorld, h: string, before: string) {
  const b = (await g.deps.store.bindings.findByHandleHash(hashHandle(h)))!;
  assert.equal(g.client.writes.length, 0, "no Run, ledger or target byte was sent");
  assert.equal((await g.deps.store.plans.listByRuntime(b.project, b.lane, b.runtime_generation)).length, 0, "no unprovable plan acquired the lane");
  assert.equal(await g.deps.store.leases.current({ project: b.project, lane: b.lane, runtime_generation: b.runtime_generation }, NOW), undefined);
  assert.equal(JSON.stringify([...g.map]), before, "existing business and historical rows are untouched");
}

for (const gap of gaps) test(`candidate schema preflight: missing ${gap.source === R.salesRunsDs ? "Run" : "Ledger"}.${gap.name} refuses before new work`, async () => {
  const g = guardWorld(), h = await g.bind(); await g.approve();
  const schema = structuredClone(g.map.get(`data_source:${gap.source}`) as Schema);
  delete schema.properties[gap.name]; g.map.set(`data_source:${gap.source}`, schema);
  const before = JSON.stringify([...g.map]);
  const out = await g.commit(h, b0Intent());
  assert.equal(out.kind, "HELD", JSON.stringify(out));
  if (out.kind !== "HELD") return;
  assert.equal(out.code, "HOLD_SCHEMA_MISMATCH");
  assert.equal(out.phase, "PREPARE", "a known schema gap is not discovered after stage-1 effects");
  assert.equal(out.wrote_anything, false);
  await assertNoNewWork(g, h, before);
});

test("candidate schema preflight: repeated intents in a fresh binding do not accumulate partial Runs", async () => {
  const g = guardWorld(), h = await g.bind(); await g.approve();
  for (const gap of gaps) {
    const schema = structuredClone(g.map.get(`data_source:${gap.source}`) as Schema);
    delete schema.properties[gap.name]; g.map.set(`data_source:${gap.source}`, schema);
  }
  const before = JSON.stringify([...g.map]);
  for (const binding of [h, h, await g.bind()]) {
    const out = await g.commit(binding, b0Intent());
    assert.equal(out.kind, "HELD");
    if (out.kind === "HELD") assert.deepEqual([out.code, out.phase, out.wrote_anything], ["HOLD_SCHEMA_MISMATCH", "PREPARE", false]);
    await assertNoNewWork(g, binding, before);
  }
});

for (const gap of [
  { source: R.metaRunsDs, name: "Harness Plan ID" },
  { source: R.metaLedgerDs, name: "Harness Plan ID" },
  { source: R.metaLedgerDs, name: "Target Receipt ID" },
]) test(`candidate schema preflight: META ${gap.source === R.metaRunsDs ? "Run" : "Ledger"}.${gap.name} also refuses before new work`, async () => {
  const w = buildResumeWorld(), client = new FixtureNotionClient(w.map, { now: () => NOW });
  declareOptions(w.map, R.metaRunsDs); declareOptions(w.map, R.metaLedgerDs);
  const schema = structuredClone(w.map.get(`data_source:${gap.source}`) as Schema);
  delete schema.properties[gap.name]; w.map.set(`data_source:${gap.source}`, schema);
  const deps = { ...w.deps, notion: client, notionWriter: client, clock: () => NOW, sleep: async () => {} };
  const ctx = { principal_id: OWNER.principal_id, now: NOW };
  const h = handleOf(await dispatch("os_bind", { lane: "META" }, ctx, deps));
  const before = JSON.stringify([...w.map]);
  const intent = { action_class: "COMMIT", summary: "record the next question", mutations: [{ logical_resource_key: "META:GATES",
    operation: "UPDATE", record_selector: { natural_key: "T1" }, desired_changes: { "Next Question": "What is the offer?" } }] };
  const out = await dispatchCommit({ binding_handle: h, intent }, ctx, deps);
  assert.equal(out.kind, "HELD");
  if (out.kind === "HELD") assert.deepEqual([out.code, out.phase, out.wrote_anything], ["HOLD_SCHEMA_MISMATCH", "PREPARE", false]);
  assert.equal(client.writes.length, 0);
  assert.equal(JSON.stringify([...w.map]), before);
  const binding = (await deps.store.bindings.findByHandleHash(hashHandle(h)))!;
  assert.equal((await deps.store.plans.listByRuntime(binding.project, binding.lane, binding.runtime_generation)).length, 0);
  assert.equal(await deps.store.leases.current({ project: binding.project, lane: binding.lane, runtime_generation: binding.runtime_generation }, NOW), undefined);
});

test("candidate schema preflight: an undeclared Run origin refuses before opening the journal", async () => {
  const g = guardWorld(), h = await g.bind(); await g.approve();
  const schema = structuredClone(g.map.get(`data_source:${R.salesRunsDs}`) as Schema);
  const origin = schema.properties["Origin"]!;
  origin.select = { options: [{ name: "META_RUNTIME" }, { name: "MIGRATED" }, { name: "TEMPLATE_SEED" }] };
  g.map.set(`data_source:${R.salesRunsDs}`, schema);
  const before = JSON.stringify([...g.map]);
  const out = await g.commit(h, b0Intent());
  assert.equal(out.kind, "HELD");
  if (out.kind !== "HELD") return;
  assert.deepEqual([out.code, out.phase, out.wrote_anything], ["HOLD_SCHEMA_MISMATCH", "PREPARE", false]);
  await assertNoNewWork(g, h, before);
});

test("candidate schema preflight: an unwritten legacy draft cannot bypass the writer refusal", async () => {
  const g = guardWorld(), h = await g.bind(); await g.approve();
  const schema = structuredClone(g.map.get(`data_source:${R.salesLedgerDs}`) as Schema);
  delete schema.properties["Target Receipt ID"]; g.map.set(`data_source:${R.salesLedgerDs}`, schema);
  const draft = await dispatch("os_prepare", { binding_handle: h, ...b0Intent() }, { principal_id: OWNER.principal_id, now: NOW }, g.deps);
  assert.equal(draft.code, "PLAN_PREPARED", "historical readonly prepare still renders its schema diagnostic");
  const b = (await g.deps.store.bindings.findByHandleHash(hashHandle(h)))!;
  const plan = (await g.deps.store.plans.listByRuntime(b.project, b.lane, b.runtime_generation))[0]!;
  const before = JSON.stringify([...g.map]), planBefore = structuredClone(plan);
  const out = await g.commit(h, b0Intent());
  assert.equal(out.kind, "HELD");
  if (out.kind === "HELD") assert.deepEqual([out.code, out.phase, out.wrote_anything], ["HOLD_SCHEMA_MISMATCH", "PREPARE", false]);
  assert.equal(g.client.writes.length, 0);
  assert.equal(JSON.stringify([...g.map]), before);
  assert.deepEqual(await g.deps.store.plans.get(plan.plan_id), planBefore, "the existing plan is neither discarded nor altered");
  assert.equal((await g.deps.store.plans.listByRuntime(b.project, b.lane, b.runtime_generation)).length, 1);
  assert.deepEqual(await g.deps.store.planWrites.list(plan.plan_id), [], "no execution journal was opened");
});

test("candidate schema preflight: repairing the local schema rederives an unwritten incomplete draft instead of executing it", async () => {
  const g = guardWorld(), h = await g.bind(); await g.approve();
  const original = structuredClone(g.map.get(`data_source:${R.salesLedgerDs}`) as Schema);
  const legacy = structuredClone(original); delete legacy.properties["Target Receipt ID"];
  g.map.set(`data_source:${R.salesLedgerDs}`, legacy);
  const draft = await dispatch("os_prepare", { binding_handle: h, ...b0Intent() }, { principal_id: OWNER.principal_id, now: NOW }, g.deps);
  assert.equal(draft.code, "PLAN_PREPARED");
  const b = (await g.deps.store.bindings.findByHandleHash(hashHandle(h)))!;
  const oldPlan = (await g.deps.store.plans.listByRuntime(b.project, b.lane, b.runtime_generation))[0]!;
  g.map.set(`data_source:${R.salesLedgerDs}`, original);
  const out = await g.commit(h, b0Intent());
  assert.equal(out.kind, "PERSISTED", JSON.stringify(out));
  assert.equal((await g.deps.store.plans.get(oldPlan.plan_id))?.plan_state, "SUPERSEDED", "only a never-sent draft is replaced, not deleted");
  assert.deepEqual(await g.deps.store.planWrites.list(oldPlan.plan_id), [], "old incomplete instructions were never executed");
  assert.equal(g.client.writes.some(w => w.ctx.plan_id === oldPlan.plan_id), false);
  assert.equal(rowsOf(g.map, G.configDs).filter(p => propText(p, "Config Item") === B0_KEY).length, 1);
});

test("candidate schema preflight: a concurrent executor claim prevents replacing an incomplete draft", async () => {
  const g = guardWorld(), h = await g.bind(); await g.approve();
  const original = structuredClone(g.map.get(`data_source:${R.salesLedgerDs}`) as Schema);
  const legacy = structuredClone(original); delete legacy.properties["Target Receipt ID"];
  g.map.set(`data_source:${R.salesLedgerDs}`, legacy);
  assert.equal((await dispatch("os_prepare", { binding_handle: h, ...b0Intent() }, { principal_id: OWNER.principal_id, now: NOW }, g.deps)).code, "PLAN_PREPARED");
  const b = (await g.deps.store.bindings.findByHandleHash(hashHandle(h)))!;
  const oldPlan = (await g.deps.store.plans.listByRuntime(b.project, b.lane, b.runtime_generation))[0]!;
  g.map.set(`data_source:${R.salesLedgerDs}`, original);
  const until = new Date(NOW.getTime() + 60_000), before = JSON.stringify([...g.map]);
  assert.equal(await g.deps.store.claims.claim(oldPlan.plan_id, "existing-executor", NOW, until), true);
  const out = await g.commit(h, b0Intent());
  assert.equal(out.kind, "HELD");
  if (out.kind === "HELD") assert.deepEqual([out.code, out.phase, out.wrote_anything], ["HOLD_RUNTIME_BUSY", "PREPARE", false]);
  assert.deepEqual(await g.deps.store.plans.get(oldPlan.plan_id), oldPlan);
  assert.equal(g.client.writes.length, 0); assert.equal(JSON.stringify([...g.map]), before);
  assert.equal((await g.deps.store.plans.listByRuntime(b.project, b.lane, b.runtime_generation)).length, 1);
  assert.equal(await g.deps.store.claims.claim(oldPlan.plan_id, "other-executor", NOW, until), false, "the incumbent claim was not released");
  await g.deps.store.claims.release(oldPlan.plan_id, "existing-executor");
});

test("candidate schema preflight: additive local preparation permits one verified transaction, not a second copy", async () => {
  const g = guardWorld(), h = await g.bind(); await g.approve();
  for (const gap of gaps) {
    const schema = structuredClone(g.map.get(`data_source:${gap.source}`) as Schema);
    delete schema.properties[gap.name]; g.map.set(`data_source:${gap.source}`, schema);
  }
  for (const ds of [R.salesRunsDs, R.salesLedgerDs]) {
    const original = g.map.get(`data_source:${ds}`) as Schema;
    const required = ds === R.salesRunsDs ? { "Harness Plan ID": "rich_text" }
      : { "Harness Plan ID": "rich_text", "Target Receipt ID": "rich_text" };
    const draft = draftHistoricalSchemaAdditions(original, { properties: required });
    assert.equal(draft.status, "DRAFT_ADDITIONS_ONLY");
    assert.equal(draft.writer_authorized, false, "a local draft is not source-write authority");
    g.map.set(`data_source:${ds}`, draft.projected_schema);
  }
  const first = await g.commit(h, b0Intent());
  assert.equal(first.kind, "PERSISTED", JSON.stringify(first));
  const bytes = g.client.writes.length;
  const repeated = await g.commit(h, b0Intent());
  assert.equal(repeated.kind, "PERSISTED", JSON.stringify(repeated));
  if (repeated.kind === "PERSISTED") assert.equal(repeated.repeated, true);
  assert.equal(g.client.writes.length, bytes, "the existing proof is returned without another write");
  assert.equal(rowsOf(g.map, G.configDs).filter(p => propText(p, "Config Item") === B0_KEY).length, 1);
});
