/** W6.1 E12 local public-commit oracles; not member or ordinary-chat evidence. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { propMentions, propText, type Page } from "../../src/notion/shapes.ts";
import { FixtureCrash } from "../../src/notion/fixtureClient.ts";
import { hashHandle } from "../../src/binding/handle.ts";
import { checkLiveness } from "../../src/binding/service.ts";
import { resolveRuntimeFor } from "../../src/tools/handlers.ts";
import { Deadline } from "../../src/transactions/budget.ts";
import { settle } from "../../src/transactions/settle.ts";
import { sha } from "../../src/plans/prepare.ts";
import { salesContractAdapter } from "../../src/versions/adapters/sales.ts";
import { SALES_CONTROL_PLANE_0511_CANDIDATE, SALES_CONTROL_PLANE_0513_CANDIDATE } from "../../src/versions/adapters/controlPlane.ts";
import { capabilityProofKey } from "../../src/resume/capabilities.ts";
import { MapAdapterRegistry, type SalesRuntimeAdapter } from "../../src/versions/registry.ts";
import { FOREIGN_RUN_ACTION } from "../../src/resume/foreignRuns.ts";
import { CLASSES, G, GUARD_CONTRACT, configRow, guardWorld, index, setIndex } from "../support/guard-fixtures.ts";
import { synthetic } from "./meta-fixtures.ts";
import { ledgerRow, R, runPage, setRowsIn } from "./resume-fixtures.ts";
import { SGRAMMAR, SV } from "./sales-fixtures.ts";

const fields = (value: string) => ({ Category: "OTHER", State: "CONFIRMED", Value: value, Version: "SALES_INPUT/1", Source: "CHAT_USER_EXPLICIT" });
const rt = (content: string) => [{ type: "text" as const, text: { content }, plain_text: content }];
const firstKey = "B3_DATA:CANONICAL_SOURCE", secondKey = "additional-context";
const runId = synthetic("foreign-run-e12"), ledgerId = synthetic("foreign-ledger-e12");
async function world(o: { prepared?: boolean; count?: number; wrongPin?: boolean } = {}) {
  const existing = configRow("foreign-first", firstKey, { value: "alpha", category: "OTHER", source: "CHAT_USER_EXPLICIT" });
  const g = guardWorld({ gate: "B3_DATA", configs: [existing], doc: index([], [{ ...CLASSES.b0Answer, allowed_fields: Object.keys(fields("alpha")) }, CLASSES.cursor()]) });
  const h = await g.bind(); await g.approve();
  const manual = runPage({ id: runId, label: "Run46", status: "RUNNING", lane: "SALES", mutationCount: o.count ?? 2,
    spec: o.wrongPin ? "FOREIGN/WRONG" : GUARD_CONTRACT, schema: SV.schema, lastEdited: "2030-01-03T00:10:00.000Z" });
  g.w.setSalesRuns([{ ...manual, properties: { ...manual.properties, "Gate Before": { type: "rich_text", rich_text: rt("B3_DATA") }, "Gate After Expected": { type: "rich_text", rich_text: rt("B3_DATA") } } }]);
  const native = ledgerRow(ledgerId, "MUT231", "PREPARED", `page:${runId}`);
  g.w.setSalesLedger(o.prepared === false ? [] : [{ ...native, properties: { ...native.properties,
    "Target Ref": { type: "rich_text", rich_text: rt(`page:${existing.id}`) }, Operation: { type: "select", select: { name: "CREATE" } } } }]);
  const intent = { action_class: FOREIGN_RUN_ACTION, summary: "complete the explicitly restated interrupted Run", mutations: [
    { logical_resource_key: "SALES:BUSINESS_CONFIG", operation: "CREATE", record_selector: { natural_key: firstKey }, desired_changes: fields("alpha") },
    { logical_resource_key: "SALES:BUSINESS_CONFIG", operation: "CREATE", record_selector: { natural_key: secondKey }, desired_changes: fields("beta") },
  ] };
  return { g, h, existing, intent };
}

async function settleContext(s: Awaited<ReturnType<typeof world>>) {
  const binding = (await s.g.deps.store.bindings.findByHandleHash(hashHandle(s.h)))!;
  const at = () => new Date(s.g.clock.t);
  const live = await checkLiveness(s.g.deps.store, s.g.deps.principals, binding, at(), (pr, project, lane) => resolveRuntimeFor(s.g.deps, pr, project, lane));
  assert.ok(live.ok);
  return { principal_id: binding.principal_id, binding, runtime: live.runtime, cursor_ref: R.salesStateRow,
    deadline: new Deadline(() => s.g.clock.t), clock: at, sleep: async () => {} };
}

test("E12/a: explicit full list completes the same foreign Run, never rewrites a present effect, preserves PREPARED or fills absent ledger, State last", async () => {
  for (const prepared of [true, false]) {
    const s = await world({ prepared });
    const out = await s.g.commit(s.h, { intent: s.intent });
    assert.equal(out.kind, "PERSISTED", JSON.stringify(out));
    assert.equal(out.kind === "PERSISTED" ? out.run_ref : "", runId);
    assert.equal(s.g.client.writes.some(w => w.target === s.existing.id), false, "the already present target is observed, never written");
    assert.equal(s.g.client.writes.at(-1)?.ctx.symbol, "STATE_LAST");
    const runs = (s.g.map.get(`query:${R.salesRunsDs}`) as { results: Page[] }).results;
    const ledgers = (s.g.map.get(`query:${R.salesLedgerDs}`) as { results: Page[] }).results;
    const configs = (s.g.map.get(`query:${G.configDs}`) as { results: Page[] }).results;
    assert.equal(runs.length, 1); assert.equal(runs[0]?.id, runId); assert.equal(propText(runs[0]!, "Status"), "COMPLETED");
    assert.equal(ledgers.length, 2); if (prepared) assert.ok(ledgers.some(p => p.id === ledgerId), "the native PREPARED row is preserved");
    assert.equal(configs.filter(p => propText(p, "Config Item") === firstKey).length, 1);
    assert.equal(configs.filter(p => propText(p, "Config Item") === secondKey).length, 1);
    assert.deepEqual(propMentions(s.g.map.get(`page:${R.salesStateRow}`) as Page, "Last Run Ref"), [runId]);
  }
});

test("E12/b: an incomplete list or foreign pins refuse before plan or Notion write", async () => {
  for (const options of [{ count: 3 }, { wrongPin: true }]) {
    const s = await world(options);
    const out = await s.g.commit(s.h, { intent: s.intent });
    assert.equal(out.kind, "HELD", JSON.stringify(out));
    assert.equal(s.g.client.writes.length, 0);
    assert.equal((await s.g.deps.store.plans.listByRuntime("VERTIGO", "SALES", (await s.g.deps.store.bindings.findByHandleHash((await import("../../src/binding/handle.ts")).hashHandle(s.h)))!.runtime_generation)).length, 0);
  }
});

test("E12/c: duplicate or unattributable native ledger refuses, never guessed from title/order", async () => {
  for (const duplicate of [false, true]) {
    const s = await world();
    const old = (s.g.map.get(`query:${R.salesLedgerDs}`) as { results: Page[] }).results[0]!;
    setRowsIn(s.g.map, R.salesLedgerDs, duplicate ? [old, { ...old, id: synthetic("native-duplicate") }]
      : [{ ...old, properties: { ...old.properties, "Target Ref": { type: "rich_text", rich_text: [] } } }]);
    const out = await s.g.commit(s.h, { intent: s.intent });
    assert.equal(out.kind, "HELD", JSON.stringify(out)); assert.equal(s.g.client.writes.length, 0);
  }
});

test("E12/d: automatic continuation of the stored manifest completes after a crash without asking for the list again", async () => {
  const s = await world();
  s.g.client.fault({ symbol: "TARGET_1" }, "CRASH_BEFORE");
  await assert.rejects(s.g.commit(s.h, { intent: s.intent }), FixtureCrash);
  s.g.clock.t += 120_000;
  const out = await settle(s.g.deps, await settleContext(s));
  assert.equal(out.outcomes.at(-1)?.kind, "PERSISTED", JSON.stringify(out));
  assert.equal(s.g.client.writes.filter(w => w.ctx.symbol === "TARGET_1" && w.applied.length).length, 1);
  assert.equal(s.g.client.writes.some(w => w.target === s.existing.id), false);
  assert.equal(s.g.client.writes.at(-1)?.ctx.symbol, "STATE_LAST");
});

test("E12/e: automatic continuation never bypasses a changed guard or foreign Run parent", async () => {
  for (const drift of ["GUARD", "PARENT"] as const) {
    const s = await world();
    s.g.client.fault({ symbol: "TARGET_1" }, "CRASH_BEFORE");
    await assert.rejects(s.g.commit(s.h, { intent: s.intent }), FixtureCrash);
    if (drift === "GUARD") setIndex(s.g.map, index([], [CLASSES.cursor()]));
    else {
      const p = s.g.map.get(`page:${runId}`) as Page;
      s.g.map.set(`page:${runId}`, { ...p, parent: { type: "data_source_id", data_source_id: synthetic("other-runtime") } });
    }
    const before = s.g.client.writes.length;
    s.g.clock.t += 120_000;
    const out = await settle(s.g.deps, await settleContext(s));
    assert.notEqual(out.outcomes.at(-1)?.kind, "PERSISTED", JSON.stringify(out));
    assert.equal(s.g.client.writes.length, before, `${drift}: no further byte`);
  }
});

test("E12/f: after FINAL the answer reads only the proven cursor, not another full OS hydration", async () => {
  const s = await world();
  let finalized = false;
  const afterFinal: string[] = [];
  const store = s.g.deps.store;
  const reader = new Proxy(s.g.deps.notion, { get(target, property) {
    const method = Reflect.get(target, property);
    return typeof method === "function" ? (...args: unknown[]) => {
      if (finalized) afterFinal.push(`${String(property)}:${String(args[0])}`);
      return Reflect.apply(method, target, args);
    } : method;
  } });
  const out = await s.g.commit(s.h, { intent: s.intent }, { notion: reader, store: { ...store, async finalizePlan(input) {
    const receipt = await store.finalizePlan(input); finalized = true; return receipt;
  } } });
  assert.equal(out.kind, "PERSISTED", JSON.stringify(out));
  assert.equal(out.kind === "PERSISTED" ? out.next_gate : "", "B3_DATA");
  assert.deepEqual(afterFinal, [`retrievePage:${R.salesStateRow}`]);
});

test("E12/g: expired or new-chat import continues the same foreign Run even when native linkage was only partially attached", async () => {
  for (const prepared of [true, false]) {
    const probe = await world({ prepared });
    const persisted = await probe.g.commit(probe.h, { intent: probe.intent });
    assert.equal(persisted.kind, "PERSISTED");
    if (persisted.kind !== "PERSISTED") return;
    const plan = (await probe.g.deps.store.plans.get(persisted.plan_id))!;
    const symbols = [...plan.stage1_writes, ...plan.finalization_writes, plan.state_last_write].map(w => w.symbol);
    for (const symbol of symbols) {
    for (const position of ["CRASH_BEFORE", "CRASH_AFTER"] as const) {
      const s = await world({ prepared });
      s.g.client.fault({ symbol }, position);
      await assert.rejects(s.g.commit(s.h, { intent: s.intent }), FixtureCrash);
      s.g.clock.t += 20 * 60_000;
      const h = await s.g.bind();
      const out = await settle(s.g.deps, await settleContext({ ...s, h }));
      assert.equal(out.outcomes.at(-1)?.kind, "PERSISTED", `${prepared}/${position}/${symbol}: ${JSON.stringify(out)}`);
      const runs = (s.g.map.get(`query:${R.salesRunsDs}`) as { results: Page[] }).results;
      const ledgers = (s.g.map.get(`query:${R.salesLedgerDs}`) as { results: Page[] }).results;
      assert.equal(runs.length, 1); assert.equal(runs[0]?.id, runId);
      assert.equal(ledgers.length, 2);
      assert.equal(s.g.client.writes.filter(w => w.ctx.symbol === "TARGET_1" && w.applied.length).length, 1);
      assert.equal(s.g.client.writes.some(w => w.target === s.existing.id), false);
      assert.equal(s.g.client.writes.at(-1)?.ctx.symbol, "STATE_LAST");
    }
    }
  }
});

test("E12/h: existing non-local provenance cannot be relabelled local by the recovery list", async () => {
  for (const source of ["OPERATOR", "META_PUBLISHED"]) {
    const s = await world();
    const existing = s.g.map.get(`page:${s.existing.id}`) as Page;
    setRowsIn(s.g.map, G.configDs, [{ ...existing, properties: { ...existing.properties, Source: { type: "rich_text", rich_text: rt(source) } } }]);
    const out = await s.g.commit(s.h, { intent: s.intent });
    assert.equal(out.kind, "HELD", JSON.stringify(out));
    assert.equal(s.g.client.writes.length, 0);
  }
});

test("E12/i: a missing UPDATE needs the exact original before hash and compared fields, never a guessed baseline", async () => {
  for (const proved of [false, true]) {
    const s = await world();
    setIndex(s.g.map, index([], [{ ...CLASSES.b0Answer, allowed_fields: Object.keys(fields("alpha")) },
      { ...CLASSES.b0Answer, operation: "UPDATE", allowed_fields: Object.keys(fields("alpha")) }, CLASSES.cursor()]));
    await s.g.approve();
    const native = (s.g.map.get(`query:${R.salesLedgerDs}`) as { results: Page[] }).results[0]!;
    const before = { "Config Item": firstKey, ...fields("alpha") };
    const ordered = Object.fromEntries(Object.entries(before).sort(([a], [b]) => a.localeCompare(b)));
    setRowsIn(s.g.map, R.salesLedgerDs, [{ ...native, properties: { ...native.properties,
      Operation: { type: "select", select: { name: "UPDATE" } },
      "Before Hash": { type: "rich_text", rich_text: proved ? rt(sha(JSON.stringify(ordered))) : [] },
      "Compared Fields": { type: "rich_text", rich_text: rt(JSON.stringify(Object.keys(before))) },
    } }]);
    const first = { ...s.intent.mutations[0]!, operation: "UPDATE", desired_changes: fields("updated") };
    const out = await s.g.commit(s.h, { intent: { ...s.intent, mutations: [first, s.intent.mutations[1]!] } });
    assert.equal(out.kind, proved ? "PERSISTED" : "HELD", JSON.stringify(out));
    assert.equal(s.g.client.writes.filter(w => w.target === s.existing.id).length, proved ? 1 : 0);
    if (proved) assert.equal(s.g.client.writes.at(-1)?.ctx.symbol, "STATE_LAST");
    else assert.equal(s.g.client.writes.length, 0);
  }
});

test("E12/j: a fresh complete capability snapshot avoids unrelated hydration; a missing required proof still refuses", async () => {
  for (const proved of [true, false]) {
    const s = await world();
    const p = SALES_CONTROL_PLANE_0513_CANDIDATE.capabilityProofProps!;
    const grammar = { ...SALES_CONTROL_PLANE_0511_CANDIDATE,
      capabilityProofsDatabaseTitle: SALES_CONTROL_PLANE_0513_CANDIDATE.capabilityProofsDatabaseTitle!, capabilityProofProps: p };
    Object.assign(s.g.deps.adapters, { salesRuntime: new MapAdapterRegistry<SalesRuntimeAdapter>() });
    s.g.deps.adapters.salesRuntime.register(GUARD_CONTRACT, salesContractAdapter(GUARD_CONTRACT, [SV.schema], { ...SGRAMMAR, controlPlane: grammar }, {
      gtm: false, defaultOperatingModes: ["SALES_OPERATIONS"], operatingModeRequirements: { SALES_OPERATIONS: [{ capability: "GMAIL_READ", requirement: "REQUIRED", acceptedStates: ["READ_VERIFIED"], competentSource: "GMAIL", nextHumanAction: "Vérifier la lecture Gmail dans votre propre chat." }] },
    }));
    const db = synthetic("import-capability-db"), ds = synthetic("import-capability-ds");
    const children = (s.g.map.get(`children:${G.cp}`) as { results: unknown[] }).results;
    s.g.map.set(`children:${G.cp}`, { results: [...children, { object: "block", id: db, type: "child_database", child_database: { title: grammar.capabilityProofsDatabaseTitle } }], has_more: false, next_cursor: null });
    s.g.map.set(`database:${db}`, { object: "database", id: db, data_sources: [{ id: ds }] });
    s.g.map.set(`data_source:${ds}`, { properties: {} });
    const at = new Date(s.g.clock.t).toISOString(), evidence = "fixture:own-gmail";
    const key = capabilityProofKey({ runtimeId: "SALESOS-FIXTURE-A", principalKey: "rep-a", capability: "GMAIL_READ", operatingMode: "SALES_OPERATIONS", verifiedAt: at, evidenceRef: evidence });
    const values = { [p.proofKey]: key, [p.capabilityKey]: "GMAIL_READ", [p.runtimeId]: "SALESOS-FIXTURE-A", [p.principalKey]: "rep-a", [p.operatingMode]: "SALES_OPERATIONS", [p.evidenceRef]: evidence, [p.scope]: "principal:rep-a;runtime:SALESOS-FIXTURE-A" };
    setRowsIn(s.g.map, ds, proved ? [{ object: "page", id: synthetic("import-own-proof"), properties: {
      ...Object.fromEntries(Object.entries(values).map(([f, v]) => [f, { type: "rich_text", rich_text: rt(v) }])),
      [p.state]: { type: "select", select: { name: "READ_VERIFIED" } }, [p.competentSource]: { type: "select", select: { name: "GMAIL" } },
      [p.verifiedAt]: { type: "date", date: { start: at } },
    } } as Page] : []);
    for (const complete of [ds, R.salesStateDs]) {
      const rows = s.g.map.get(`query:${complete}`) as { results: Page[] };
      s.g.map.set(`query:${complete}`, { ...rows, has_more: false, next_cursor: null });
    }
    let unrelated = 0;
    s.g.intercept(R.salesExtDs, rows => { unrelated++; return rows; });
    const h = await s.g.bind();
    unrelated = 0; // Binding admission is outside this transaction's targeted reconstruction.
    const out = await s.g.commit(h, { intent: s.intent });
    assert.equal(out.kind, proved ? "PERSISTED" : "HELD", JSON.stringify(out));
    if (proved) assert.equal(unrelated, 0, "positive scoped proof does not trigger full control-plane hydration");
    else { assert.equal(s.g.client.writes.length, 0); assert.equal(out.kind === "HELD" ? out.code : "", "HOLD_REQUIRED_CAPABILITY_INCOMPLETE"); }
  }
});
