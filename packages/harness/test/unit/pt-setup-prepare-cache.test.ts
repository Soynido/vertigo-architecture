/** W7.1: preparation structure is bounded, while facts and the execution guard stay fresh. Fixtures only. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { guardWorld, index, CLASSES, G, NOW, setIndex, configRow } from "../support/guard-fixtures.ts";
import { OWNER } from "./binding-fixtures.ts";
import { bindLive } from "../../src/tools/handlers.ts";
import { dispatch } from "../../src/tools/handlers.ts";
import { pendingStepInputs, prepareIntentFor } from "../../src/resume/pendingInput.ts";
import type { NotionReadClient } from "../../src/notion/readClient.ts";

async function setup() {
  const entry = { ...CLASSES.b0Answer, operation: "UPSERT", allowed_fields: [...CLASSES.b0Answer.allowed_fields] };
  const g = guardWorld({ doc: index([], [entry]) });
  const h = await g.bind(); await g.approve();
  const bound = await bindLive(h, { principal_id: OWNER.principal_id, now: NOW }, g.deps);
  assert.ok(bound.ok); if (!bound.ok) throw new Error("fixture bind failed");
  const template = prepareIntentFor(pendingStepInputs(bound.runtime, "B0_DISCOVERY")[0]!);
  const intent = { ...template, mutations: template.mutations.map(m => ({ ...m, desired_changes: { ...m.desired_changes, Value: "TEST CANARY — no prospecting or send" } })) };
  return { g, h, bound, intent };
}

test("W7.1/A4: ordinary SETUP preparation reads root children once, independently of fresh guard and classification", async () => {
  const { g, h, bound, intent } = await setup(); const original = g.deps.notion;
  let rootReads = 0; let beforeFirstWrite: number | undefined; let beforePlanInsert: number | undefined;
  const notion: NotionReadClient = { ...original, retrieveBlockChildren: async (id, cursor) => {
    if (id === bound.runtime.root_ref) rootReads++;
    return original.retrieveBlockChildren(id, cursor);
  } };
  const writer = { createPage: async (...args: Parameters<typeof g.client.createPage>) => {
    beforeFirstWrite ??= rootReads; return g.client.createPage(...args);
  }, updatePage: (...args: Parameters<typeof g.client.updatePage>) => g.client.updatePage(...args) };
  const store = { ...g.deps.store, plans: { ...g.deps.store.plans,
    insert: (...args: Parameters<typeof g.deps.store.plans.insert>) => {
      beforePlanInsert ??= rootReads; return g.deps.store.plans.insert(...args);
    } } };
  const r = await g.commit(h, { intent }, { notion, notionWriter: writer, store });
  assert.equal(r.kind, "PERSISTED", JSON.stringify(r));
  // Dispatcher re-resolution + independent guard + classifier + one preparation lookup.
  assert.equal(beforePlanInsert, 4, "preparation must not repeat root tree traversal");
  assert.ok(beforeFirstWrite! > beforePlanInsert!, "execution must discover its own fresh structure");
  assert.equal(r.kind === "PERSISTED" && r.step_moved, false);
});

test("W7.1/A4: ordinary SETUP never reuses a prepared guard-index snapshot before the first byte", async () => {
  const { g, h, intent } = await setup(); const original = g.deps.notion; let reads = 0;
  const notion: NotionReadClient = { ...original, retrieveBlockChildren: async (id, cursor) => {
    if (id === G.indexPage && ++reads === 2) setIndex(g.map, index([], []));
    return original.retrieveBlockChildren(id, cursor);
  } };
  const r = await g.commit(h, { intent }, { notion });
  assert.equal(r.kind, "HELD", JSON.stringify(r)); assert.ok(reads >= 2);
  assert.equal(g.client.writes.length, 0);
});

test("W7.1/A4: pages and queries remain uncached and a fresh commit gets fresh structure", async () => {
  const { g, h, bound, intent } = await setup(); const original = g.deps.notion;
  const seen = new Map<string, number>(); const count = (k: string) => seen.set(k, (seen.get(k) ?? 0) + 1);
  const notion: NotionReadClient = { ...original,
    retrievePage: id => { count("page:" + id); return original.retrievePage(id); },
    queryDataSource: (ds, f, cursor, options) => { count("query:" + ds); return original.queryDataSource(ds, f, cursor, options); },
    retrieveBlockChildren: (id, cursor) => { count("children:" + id); return original.retrieveBlockChildren(id, cursor); },
  };
  await g.commit(h, { intent }, { notion });
  assert.ok([...seen.entries()].some(([k,v]) => k.startsWith("page:") && v > 1), "facts are reread");
  assert.ok([...seen.entries()].some(([k,v]) => k.startsWith("query:") && v > 1), "queries are reread");
  const before = seen.get("children:" + bound.runtime.root_ref)!;
  await g.commit(h, { intent }, { notion });
  assert.ok(seen.get("children:" + bound.runtime.root_ref)! > before, "no structure cache survives the call");
});

test("W7.1: same-handle resume never sends an unsent plan after the approved guard drifted", async () => {
  const { g, h, intent } = await setup();
  const pending = await g.commit(h, { intent }, { commitBudgetMs: 1 });
  assert.equal(pending.kind, "IN_PROGRESS");
  assert.equal(g.client.writes.length, 0);
  setIndex(g.map, index([], []));
  await dispatch("os_resume", { binding_handle: h }, { principal_id: OWNER.principal_id, now: NOW, candidate_resume: true }, g.deps);
  assert.equal(g.client.writes.length, 0, "fresh guard approval is required before the first continuation byte");
});

test("W7.1: approved same-handle continuation finishes the original plan once, not a second Run", async () => {
  const { g, h, intent } = await setup();
  const pending = await g.commit(h, { intent }, { commitBudgetMs: 1 });
  assert.equal(pending.kind, "IN_PROGRESS"); if (pending.kind !== "IN_PROGRESS") return;
  const continued = await dispatch("os_resume", { binding_handle: h }, { principal_id: OWNER.principal_id, now: NOW, candidate_resume: true }, g.deps);
  const original = await g.deps.store.plans.get(pending.plan_id);
  assert.equal(original?.plan_state, "FINAL_VERIFIED", JSON.stringify(continued));
  assert.deepEqual(original?.state_last_write.guard_mutations, intent.mutations);
  const journal = await g.deps.store.planWrites.list(pending.plan_id);
  assert.ok(journal.find(w => w.symbol === "OPEN_RUN")?.created_id);
  assert.equal(JSON.stringify(g.client.writes).includes("guard_mutations"), false, "backend metadata never becomes a Notion field");
  const binding = await bindLive(h, { principal_id: OWNER.principal_id, now: NOW }, g.deps);
  assert.ok(binding.ok); if (!binding.ok) return;
  assert.equal((await g.deps.store.plans.listByRuntime("VERTIGO", "SALES", binding.binding.runtime_generation)).length, 1);
  const sent = g.client.writes.length;
  await dispatch("os_resume", { binding_handle: h }, { principal_id: OWNER.principal_id, now: NOW, candidate_resume: true }, g.deps);
  assert.equal(g.client.writes.length, sent);
});

test("W7.1: same-handle unsent continuation rechecks the guard before every byte", async () => {
  const { g, h, intent } = await setup();
  const pending = await g.commit(h, { intent }, { commitBudgetMs: 1 });
  assert.equal(pending.kind, "IN_PROGRESS");
  const raw = g.deps.notion; let checks = 0;
  const notion: NotionReadClient = { ...raw, retrieveBlockChildren: async (id, cursor) => {
    if (id === G.indexPage && ++checks === 3) setIndex(g.map, index([], []));
    return raw.retrieveBlockChildren(id, cursor);
  } };
  await dispatch("os_resume", { binding_handle: h }, { principal_id: OWNER.principal_id, now: NOW, candidate_resume: true }, { ...g.deps, notion });
  assert.equal(g.client.writes.length, 1, "only OPEN_RUN preceded the guard drift; no target byte is sent");
  assert.ok(checks >= 3);
});

test("W7.1: missing or mismatched immutable intent refuses an unsent continuation, never guesses UPSERT", async () => {
  for (const change of ["missing", "operation", "value", "length"] as const) {
    const { g, h, intent } = await setup();
    const pending = await g.commit(h, { intent }, { commitBudgetMs: 1 });
    assert.equal(pending.kind, "IN_PROGRESS"); if (pending.kind !== "IN_PROGRESS") return;
    const raw = g.deps.store;
    const store = { ...raw, plans: { ...raw.plans, get: async (id: string) => {
      const p = await raw.plans.get(id); if (!p || id !== pending.plan_id) return p;
      const clone = JSON.parse(JSON.stringify(p.state_last_write));
      if (change === "missing") delete clone.guard_mutations;
      if (change === "operation") clone.guard_mutations[0].operation = "CREATE";
      if (change === "value") clone.guard_mutations[0].desired_changes.Value = "different intent";
      if (change === "length") clone.guard_mutations.push(clone.guard_mutations[0]);
      return { ...p, state_last_write: clone };
    } } };
    await dispatch("os_resume", { binding_handle: h }, { principal_id: OWNER.principal_id, now: NOW, candidate_resume: true }, { ...g.deps, store });
    assert.equal(g.client.writes.length, 0, change);
    assert.equal((await raw.plans.get(pending.plan_id))?.plan_state, "AWAITING_STAGE1_WRITES");
  }
});

test("W7.1: an unsent AUTO_RECONCILE keeps its empty-change guard path without new intent metadata", async () => {
  const row = { ...configRow("w71-adoption", "B3_DATA:CANONICAL_SOURCE", { value: "seller's local source", source: "CHAT_USER_EXPLICIT", category: "OTHER" }),
    last_edited_time: "2030-01-02T00:00:00.000Z" };
  const g = guardWorld({ gate: "B3_DATA", configs: [row], doc: index([], [
    { class: "PRODUCTION", resource_key: "SALES:BUSINESS_CONFIG", operation: "UPDATE", allowed_fields: ["Category", "State", "Value", "Version", "Source"] }, CLASSES.cursor(),
  ]) });
  const h = await g.bind(); await g.approve();
  const bound = await bindLive(h, { principal_id: OWNER.principal_id, now: NOW }, g.deps);
  assert.ok(bound.ok); if (!bound.ok) return;
  const insert = g.deps.store.plans.insert.bind(g.deps.store.plans);
  g.deps.store.plans.insert = async plan => {
    if (plan.plan_origin !== "AUTO_RECONCILE") return insert(plan);
    const { guard_mutations, ...state_last_write } = plan.state_last_write;
    await insert({ ...plan, state_last_write });
    g.clock.t += 36_000; // Stop at the call deadline, after preparing the adoption but before its first byte.
  };
  await dispatch("os_resume", { binding_handle: h }, { principal_id: OWNER.principal_id, now: NOW, candidate_resume: true }, g.deps);
  const [pending] = await g.deps.store.plans.listByRuntime("VERTIGO", "SALES", bound.binding.runtime_generation);
  assert.equal(pending?.plan_origin, "AUTO_RECONCILE"); assert.equal(pending?.plan_state, "AWAITING_STAGE1_WRITES");
  assert.equal(pending?.state_last_write.guard_mutations, undefined); assert.equal(g.client.writes.length, 0);
  g.deps.store.plans.insert = insert;
  const out = await dispatch("os_resume", { binding_handle: h }, { principal_id: OWNER.principal_id, now: new Date(g.clock.t), candidate_resume: true }, g.deps);
  assert.equal(out.status === "OK" && out.result["durable_hold"], undefined, JSON.stringify(out));
  assert.equal((await g.deps.store.plans.get(pending!.plan_id))?.plan_state, "FINAL_VERIFIED");
  assert.equal(g.client.writes.filter(w => w.target === row.id).length, 0, "the observed local value is never rewritten");
});
