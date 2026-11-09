import assert from "node:assert/strict";
import { test } from "node:test";
import { readLocalBusinessConfiguration, type LocalBusinessConfiguration } from "../../src/contractPack/localBusinessConfiguration.ts";
import type { NotionReadClient } from "../../src/notion/readClient.ts";
import type { ResolvedRuntime } from "../../src/resolvers/types.ts";
import { SALES_CONTROL_PLANE_05 } from "../../src/versions/adapters/controlPlane.ts";
import { synthetic, text } from "./meta-fixtures.ts";
import { IDS } from "./sales-fixtures.ts";
import { buildResumeWorld } from "./resume-fixtures.ts";
import { dispatch } from "../../src/tools/handlers.ts";
import { handleOf, OWNER, T0 } from "./binding-fixtures.ts";
import { bindSales, buildSetupWorld, resume, SETUP_CONTRACT } from "./pt-cp-012.fixtures.ts";
import { salesContractAdapter, SALES_OPERATIONS_REQUIREMENTS, type SalesContractAdapter } from "../../src/versions/adapters/sales.ts";
import { MapAdapterRegistry, type SalesRuntimeAdapter } from "../../src/versions/registry.ts";

const root = synthetic("configuration-root"), setup = synthetic("configuration-setup"), db = synthetic("configuration-db"), ds = synthetic("configuration-ds"), foreign = synthetic("foreign-configuration");
const setupTitle = "02 — SETUP & BUSINESS CONFIG", dbTitle = "Business Configuration";
const fieldTypes = { "Config Item": "title", Category: "select", State: "select", Value: "rich_text", Version: "rich_text", Source: "rich_text", Notes: "rich_text", "Config ID": "unique_id", "Effective At": "date" };
const p = (type: string, value: unknown) => ({ type, [type]: value });
const cells = (label: string, state = "CONFIRMED", number = 21) => ({
  "Config Item": p("title", [text(label)]), Category: p("select", { name: "CONSTRAINT" }), State: p("select", { name: state }),
  Value: p("rich_text", [text("  é\nNever reset B0 or send mail  ")]), Version: p("rich_text", [text("v3")]),
  Source: p("rich_text", [text("native declaration; not fresh capability proof")]), Notes: p("rich_text", [text("source note")]),
  "Config ID": p("unique_id", { number, prefix: null }), "Effective At": p("date", { start: "2026-09-28", end: null, time_zone: null }),
});
const row = (label: string, state = "CONFIRMED", number = 21) => ({ object: "page", id: synthetic(label), archived: false, in_trash: false,
  parent: { type: "data_source_id", data_source_id: ds }, properties: cells(label, state, number) });
const page = (id: string, parent?: string) => ({ object: "page", id, archived: false, in_trash: false, ...(parent ? { parent: { type: "page_id", page_id: parent } } : {}) });
const child = (id: string, parent: string, type: "child_page" | "child_database", title: string) => ({ id, type, archived: false, in_trash: false,
  parent: { type: "page_id", page_id: parent }, [type]: { title } });
const list = (results: unknown[], has_more = false, next_cursor: string | null = null) => ({ results, has_more, next_cursor });
const key = (method: string, ref: string, cursor?: string) => JSON.stringify([method, ref, cursor ?? null]);
const runtime = () => ({ lane: "SALES", access_mode: "BUSINESS", root_ref: root, adapter: { controlPlane: SALES_CONTROL_PLANE_05 } } as ResolvedRuntime);
function fixture(rows: unknown[] = [row("active segments"), row("old goal", "RETIRED", 12)]) {
  const values = new Map<string, unknown>([
    [key("page", root), page(root)], [key("page", setup), page(setup, root)],
    [key("children", root), list([child(setup, root, "child_page", setupTitle)])],
    [key("children", setup), list([child(db, setup, "child_database", dbTitle)])],
    [key("database", db), { object: "database", id: db, archived: false, in_trash: false, parent: { type: "page_id", page_id: setup }, title: [text(dbTitle)], data_sources: [{ id: ds, name: dbTitle }] }],
    [key("source", ds), { object: "data_source", id: ds, archived: false, in_trash: false, parent: { type: "database_id", database_id: db }, title: [text(dbTitle)],
      properties: Object.fromEntries(Object.entries(fieldTypes).map(([k, type]) => [k, { type }])) }],
    [key("query", ds), list(rows)],
  ]);
  const calls: string[] = [];
  async function read(method: string, ref: string, cursor?: string) {
    const k = key(method, ref, cursor); calls.push(k);
    if (!values.has(k)) throw new Error("PRIVATE_PROVIDER_SECRET");
    const v = values.get(k); if (v instanceof Error) throw v; return v;
  }
  const notion: NotionReadClient = {
    retrievePage: (r) => read("page", r), retrieveBlockChildren: (r, c) => read("children", r, c),
    retrieveDatabase: (r) => read("database", r), retrieveDataSource: (r) => read("source", r),
    queryDataSource: (r, filter, c, opts) => { assert.equal(filter, undefined); assert.deepEqual(opts, { page_size: 100 }); return read("query", r, c); },
  };
  return { values, calls, notion };
}
const data = (e: Awaited<ReturnType<typeof dispatch>>) => (e.status === "OK" ? e.result : e.observations) as Record<string, unknown>;

test("business configuration: raw declarations and retired state retain order, dates, source and provenance, without effectivity claims", async () => {
  const f = fixture(), r = await readLocalBusinessConfiguration(f.notion, runtime(), true);
  assert.equal(r.status, "COMPLETE"); assert.equal(r.reads, 7); assert.equal(r.rows_seen, 2); assert.equal(r.database_ref, db); assert.equal(r.data_source_ref, ds);
  assert.deepEqual(r.observed_rows.map((r) => r.values.State), ["CONFIRMED", "RETIRED"]);
  assert.deepEqual(r.observed_rows[0], { page_ref: synthetic("active segments"), values: {
    "Config Item": "active segments", Category: "CONSTRAINT", State: "CONFIRMED", Value: "  é\nNever reset B0 or send mail  ", Version: "v3",
    "Config ID": { number: 21, prefix: null }, "Effective At": { start: "2026-09-28", end: null, time_zone: null }, Source: "native declaration; not fresh capability proof", Notes: "source note",
  } });
  assert.equal(r.effectivity, "NOT_EVALUATED"); assert.equal(r.trust, "SOURCE_DATA_ONLY"); assert.equal(r.atomic, false);
  assert.equal(r.stability, "NOT_VERIFIED"); assert.equal(r.references_followed, false);
});

test("business configuration: META, installation, other needs and D7-redacted candidates perform no read", async () => {
  const f = fixture(), rt = runtime();
  for (const r of [{ ...rt, lane: "META" as const }, { ...rt, access_mode: "INSTALL_ONLY" as const }]) assert.equal((await readLocalBusinessConfiguration(f.notion, r, true)).status, "NOT_SELECTED");
  assert.equal((await readLocalBusinessConfiguration(f.notion, rt, false)).status, "NOT_SELECTED");
  const protectedRuntime = { ...rt, adapter: { ...rt.adapter, controlPlane: { ...rt.adapter.controlPlane,
    resources: { "SALES:BUSINESS_CONFIG": { databaseTitle: dbTitle, naturalKeyProperty: "Config Item", operations: ["UPDATE"] as const, redactValues: true } } } } };
  const out = await readLocalBusinessConfiguration(f.notion, protectedRuntime, true);
  assert.equal(out.status, "UNAVAILABLE"); assert.equal(out.issues[0]?.code, "VALUES_REQUIRE_EXISTING_D7_PROJECTOR");
  assert.deepEqual(out.observed_rows, []); assert.equal(f.calls.length, 0);
});

test("business configuration: adapter path/schema and root cannot be supplied by registry or caller-like hints", async () => {
  const f = fixture(), rt = runtime();
  const { installContract: _a, ...cp } = rt.adapter.controlPlane;
  const out = await readLocalBusinessConfiguration(f.notion, { ...rt, adapter: { ...rt.adapter, controlPlane: cp },
    registry_snapshot: { BUSINESS_CONFIG: db }, observations: { source_ref: ds } } as ResolvedRuntime, true);
  assert.equal(out.status, "UNAVAILABLE"); assert.equal(f.calls.length, 0);
  const invalid = await readLocalBusinessConfiguration(f.notion, { ...rt, root_ref: "https://example.invalid" }, true);
  assert.equal(invalid.status, "UNAVAILABLE"); assert.equal(f.calls.length, 0);
});

test("business configuration: complete discovery rejects ambiguity on later pages before reading descendants", async () => {
  const f = fixture(); f.values.set(key("children", root), list([child(setup, root, "child_page", setupTitle)], true, "next"));
  f.values.set(key("children", root, "next"), list([child(foreign, root, "child_page", setupTitle)]));
  const r = await readLocalBusinessConfiguration(f.notion, runtime(), true);
  assert.equal(r.status, "UNAVAILABLE"); assert.ok(r.issues.some((i) => i.code === "MISSING_OR_AMBIGUOUS_CHILD"));
  assert.ok(!f.calls.includes(key("page", setup)));
});

test("business configuration: containment, object identity/activity and unique data source are checked before any query", async () => {
  const cases = [
    [key("page", root), { ...page(root), id: foreign }], [key("page", setup), page(setup, foreign)], [key("page", setup), { ...page(setup, root), archived: true }],
    [key("children", setup), list([child(db, foreign, "child_database", dbTitle)])],
    [key("database", db), { object: "database", id: db, archived: false, parent: { type: "page_id", page_id: foreign }, data_sources: [{ id: ds }] }],
    [key("database", db), { object: "database", id: db, archived: false, parent: { type: "page_id", page_id: setup }, data_sources: [{ id: ds }, { id: foreign }] }],
    [key("source", ds), { object: "data_source", id: ds, archived: false, parent: { type: "database_id", database_id: foreign }, properties: {} }],
  ] as const;
  for (const [at, value] of cases) {
    const f = fixture(); f.values.set(at, value);
    assert.equal((await readLocalBusinessConfiguration(f.notion, runtime(), true)).status, "UNAVAILABLE");
    assert.ok(!f.calls.includes(key("query", ds)));
  }
});

test("business configuration: required and present optional columns retain their declared types", async () => {
  for (const column of ["Config Item", "Value", "Effective At", "Config ID"]) {
    const f = fixture(), source = structuredClone(f.values.get(key("source", ds))) as { properties: Record<string, unknown> };
    source.properties[column] = { type: "url" }; f.values.set(key("source", ds), source);
    const out = await readLocalBusinessConfiguration(f.notion, runtime(), true);
    assert.equal(out.status, "UNAVAILABLE"); assert.equal(out.issues[0]?.code, "INVALID_CONFIGURATION_SCHEMA");
    assert.ok(!f.calls.includes(key("query", ds)));
  }
  const f = fixture(), source = structuredClone(f.values.get(key("source", ds))) as { properties: Record<string, unknown> };
  for (const k of ["Effective At", "Config ID", "Source", "Notes"]) delete source.properties[k];
  f.values.set(key("source", ds), source);
  const out = await readLocalBusinessConfiguration(f.notion, runtime(), true);
  assert.equal(out.status, "COMPLETE"); assert.ok(!Object.hasOwn(out.observed_rows[0]!.values, "Effective At"));
});

test("business configuration: query pagination preserves raw order and duplicate natural keys remain visible as PARTIAL", async () => {
  const f = fixture([row("key")]); f.values.set(key("query", ds), list([row("key")], true, "next"));
  f.values.set(key("query", ds, "next"), list([{ ...row("duplicate"), properties: cells("key") }]));
  const r = await readLocalBusinessConfiguration(f.notion, runtime(), true);
  assert.equal(r.status, "PARTIAL"); assert.equal(r.observed_rows.length, 2); assert.equal(r.issues[0]?.code, "DUPLICATE_CONFIGURATION_KEY");
  assert.deepEqual(r.observed_rows.map((r) => r.page_ref), [synthetic("key"), synthetic("duplicate")]);
});

test("business configuration: bad row parents, duplicate IDs, archived rows and malformed cells cannot appear complete", async () => {
  const first = row("first");
  for (const bad of [{ ...row("bad"), parent: { type: "data_source_id", data_source_id: foreign } }, first,
    { ...row("bad"), archived: true }, { ...row("bad"), properties: { ...cells("bad"), Value: p("rich_text", [{ plain_text: 7 }]) } },
    { ...row("bad"), properties: { ...cells("bad"), "Effective At": p("date", { start: "2026-09-28" }) } }]) {
    const f = fixture([first, bad]), r = await readLocalBusinessConfiguration(f.notion, runtime(), true);
    assert.equal(r.status, "PARTIAL"); assert.equal(r.observed_rows.length, 1); assert.ok(r.issues.length);
  }
});

test("business configuration: read/discovery/row/UTF8 limits preserve incomplete coverage and bound the response", async () => {
  const cases = [fixture(), fixture(), fixture(Array.from({ length: 101 }, (_, i) => row(`row-${i}`))),
    fixture([{ ...row("large"), properties: { ...cells("large"), Value: p("rich_text", [text("é".repeat(18_000))]) } }])];
  for (let i = 0; i < 20; i++) cases[0]!.values.set(key("query", ds, i ? String(i) : undefined), list([], true, String(i + 1)));
  cases[1]!.values.set(key("children", root), list(Array.from({ length: 257 }, (_, i) => child(synthetic(`block-${i}`), root, "child_page", "irrelevant"))));
  for (const f of cases) {
    const r = await readLocalBusinessConfiguration(f.notion, runtime(), true);
    assert.notEqual(r.status, "COMPLETE"); assert.ok(r.reads <= r.limits.reads); assert.ok(r.blocks_seen <= r.limits.discovery_blocks);
    assert.ok(r.rows_seen <= r.limits.rows); assert.ok(Buffer.byteLength(JSON.stringify(r)) <= r.limits.response_bytes);
    assert.ok(r.issues.length || r.issues_omitted);
  }
});

test("business configuration: provider errors, malformed lists and repeating cursors are explicit with no diagnostic leak", async () => {
  for (const value of [new Error("PRIVATE_PROVIDER_SECRET"), { results: [], has_more: true, next_cursor: null }, list([], true, "repeat")]) {
    const f = fixture(); f.values.set(key("query", ds), value); f.values.set(key("query", ds, "repeat"), list([], true, "repeat"));
    const r = await readLocalBusinessConfiguration(f.notion, runtime(), true);
    assert.notEqual(r.status, "COMPLETE"); assert.ok(!JSON.stringify(r).includes("PRIVATE_PROVIDER_SECRET"));
  }
});

test("business configuration: real dispatch adds source data but preserves say/ask/next/cursor/safety/map/events/plans", async () => {
  const w = buildResumeWorld(), ctx = { principal_id: OWNER.principal_id, now: T0 };
  const h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps));
  const baseline = await dispatch("os_resume", { binding_handle: h, topic_hint: "CURRENT_WORK" }, ctx, w.deps);
  const f = fixture(), ownRoot = IDS("rep-a").root;
  f.values.set(key("page", ownRoot), page(ownRoot)); f.values.set(key("page", setup), page(setup, ownRoot));
  const base = w.deps.notion;
  const notion: NotionReadClient = {
    ...f.notion, retrievePage: async (r) => r === setup ? f.notion.retrievePage(r) : r === ownRoot
      ? { ...await base.retrievePage(r) as Record<string, unknown>, archived: false, in_trash: false } : base.retrievePage(r),
    retrieveDatabase: (r) => r === db ? f.notion.retrieveDatabase(r) : base.retrieveDatabase(r),
    retrieveDataSource: (r) => r === ds ? f.notion.retrieveDataSource(r) : base.retrieveDataSource(r),
    queryDataSource: (r, ...a) => r === ds ? f.notion.queryDataSource(r, ...a) : base.queryDataSource(r, ...a),
    retrieveBlockChildren: async (r, c) => {
      if (r === setup) return f.notion.retrieveBlockChildren(r, c);
      const v = await base.retrieveBlockChildren(r, c);
      if (r !== ownRoot) return v;
      const a = v as { results: Record<string, unknown>[] };
      return list([...a.results.map((b) => ({ ...b, parent: { type: "page_id", page_id: r } })), child(setup, ownRoot, "child_page", setupTitle)]);
    },
  };
  const before = [...w.map], events = await w.deps.store.events.list();
  const e = await dispatch("os_resume", { binding_handle: h, topic_hint: "CURRENT_WORK" }, ctx, { ...w.deps, notion });
  assert.equal(e.status, baseline.status); assert.equal(e.code, baseline.code); assert.equal(e.say, baseline.say); assert.equal(e.ask, baseline.ask); assert.deepEqual(e.next, baseline.next);
  // This fixture adds a Setup child to the root; the documents reader's discovery count changes accordingly.
  // Compare all safety/pack/conduct fields, excluding only the two additive source-data components.
  const { local_business_configuration: _a, local_operating_documents: _docsA, ...a } = data(e),
    { local_business_configuration: _b, local_operating_documents: _docsB, ...b } = data(baseline);
  assert.deepEqual(a, b);
  const cfg = data(e).local_business_configuration as LocalBusinessConfiguration;
  assert.equal(cfg.status, "COMPLETE"); assert.equal(cfg.observed_rows[1]!.values.State, "RETIRED");
  assert.deepEqual([...w.map], before); assert.deepEqual(await w.deps.store.events.list(), events);
  assert.ok(e.binding && e.binding !== "UNKNOWN"); assert.deepEqual(await w.deps.store.plans.listByRuntime("VERTIGO", "SALES", e.binding.runtime_generation), []);
});

test("business configuration: candidate Gmail-only HOLD retains D7; recovery and unselected needs do not open this lane", async () => {
  for (const mode of ["GMAIL", "RECOVERY", "OTHER_NEED"] as const) {
    const sw = buildSetupWorld("B0_DISCOVERY"); if (mode === "RECOVERY") sw.setGate("B0_DISCOVERY", { recovery: true });
    const adapter = sw.deps.adapters.salesRuntime.resolve(SETUP_CONTRACT) as SalesContractAdapter;
    const registry = new MapAdapterRegistry<SalesRuntimeAdapter>();
    registry.register(SETUP_CONTRACT, salesContractAdapter(SETUP_CONTRACT, adapter.supportedSchemas, adapter.grammar, {
      gtm: false, defaultOperatingModes: ["SALES_OPERATIONS"], operatingModeRequirements: { SALES_OPERATIONS: SALES_OPERATIONS_REQUIREMENTS },
    }));
    const w = { ...sw, deps: { ...sw.deps, adapters: { ...sw.deps.adapters, salesRuntime: registry } } };
    const { handle } = await bindSales(w);
    const e = await resume(w, handle, mode === "OTHER_NEED" ? "SALES_SETUP_INPUTS" : "CURRENT_WORK");
    assert.equal(e.status, "HOLD"); const cfg = data(e).local_business_configuration as LocalBusinessConfiguration;
    assert.equal(cfg.status, mode === "GMAIL" ? "UNAVAILABLE" : "NOT_SELECTED");
    assert.equal(cfg.reads, 0); assert.deepEqual(cfg.observed_rows, []);
    if (mode === "GMAIL") assert.equal(cfg.issues[0]?.code, "VALUES_REQUIRE_EXISTING_D7_PROJECTOR");
  }
});
