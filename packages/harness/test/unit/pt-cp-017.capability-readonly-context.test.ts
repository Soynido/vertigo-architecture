import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContractPack } from "../../src/contractPack/pack.ts";
import type { NotionReadClient } from "../../src/notion/readClient.ts";
import { HttpNotionClient } from "../../src/notion/client.ts";
import type { Page } from "../../src/notion/shapes.ts";
import { MapAdapterRegistry, type SalesRuntimeAdapter } from "../../src/versions/registry.ts";
import { SALES_OPERATIONS_REQUIREMENTS, salesContractAdapter, type SalesContractAdapter, type SalesCapabilityRequirement } from "../../src/versions/adapters/sales.ts";
import { BC, COPIED_REGISTRY, RIVAL_MARK, SETUP_CONTRACT, bindMeta, bindSales, buildSetupWorld, ctx, resume } from "./pt-cp-012.fixtures.ts";
import { DailyClient, installDailyTable } from "./pt-cp-013.fixtures.ts";
import { synthetic, text } from "./meta-fixtures.ts";
import { IDS } from "./sales-fixtures.ts";

const HOLD = "HOLD_REQUIRED_CAPABILITY_INCOMPLETE";
const SENTINEL = "OWN-RULE-NOTION-READONLY";

function world(requirements: readonly SalesCapabilityRequirement[] = SALES_OPERATIONS_REQUIREMENTS) {
  const sw = buildSetupWorld("B0_DISCOVERY");
  const adapter = sw.deps.adapters.salesRuntime.resolve(SETUP_CONTRACT) as SalesContractAdapter;
  const registry = new MapAdapterRegistry<SalesRuntimeAdapter>();
  registry.register(SETUP_CONTRACT, salesContractAdapter(SETUP_CONTRACT, adapter.supportedSchemas, adapter.grammar, {
    gtm: false, defaultOperatingModes: ["SALES_OPERATIONS"],
    operatingModeRequirements: { SALES_OPERATIONS: requirements },
  }));
  const own = installDailyTable(sw.w.map, IDS("rep-a").root, "03 — CONTROL PLANE", "Decision Rules", {
    Active: { type: "checkbox" }, Priority: { type: "select" }, "Rule ID": { type: "unique_id" }, Rule: { type: "title" },
  });
  const daily = new DailyClient(sw.w.map);
  const row = {
    object: "page", id: synthetic("w51r-p0"), archived: false,
    parent: { type: "data_source_id", data_source_id: own.ds },
    properties: {
      Active: { type: "checkbox", checkbox: true }, Priority: { type: "select", select: { name: "P0" } },
      "Rule ID": { type: "unique_id", unique_id: { prefix: null, number: 1 } },
      Rule: { type: "title", title: [text(SENTINEL)] },
    },
  } as Page;
  daily.queryHandlers.set(own.ds, (filter) => JSON.stringify(filter).includes("P0") ? [row] : []);
  const base: NotionReadClient = sw.client;
  const notion: NotionReadClient = {
    retrievePage: (...args) => base.retrievePage(...args),
    retrieveDatabase: (...args) => base.retrieveDatabase(...args),
    retrieveDataSource: (...args) => base.retrieveDataSource(...args),
    retrieveBlockChildren: (...args) => base.retrieveBlockChildren(...args),
    queryDataSource: (ds, ...args) => ds === own.ds ? daily.queryDataSource(ds, ...args) : base.queryDataSource(ds, ...args),
  };
  return { sw: { ...sw, deps: { ...sw.deps, notion, adapters: { ...sw.deps.adapters, salesRuntime: registry } } }, daily, own };
}

const pack = (e: Awaited<ReturnType<typeof resume>>) => {
  const v = e as unknown as { observations?: { contract_pack?: ContractPack }; result?: { contract_pack?: ContractPack } };
  return (v.observations?.contract_pack ?? v.result?.contract_pack)!;
};
const section = (p: ContractPack, key: string) => p.selected_context.contexts.flatMap((c) => c.sections).find((s) => s.section_key === key)!;

test("PT-CP-017/a: Gmail-only capability HOLD serves bounded own Notion facts, not permission or native evidence", async () => {
  const { sw, daily } = world();
  const bound = await bindSales(sw);
  const baseline = await resume(sw, bound.handle, "SALES_SETUP_INPUTS");
  const before = [...sw.w.map];
  const events = await sw.deps.store.events.list();
  const e = await resume(sw, bound.handle, "CURRENT_WORK");
  assert.equal(e.status, "HOLD");
  assert.equal(e.code, HOLD);
  const b = baseline as unknown as { evidence: unknown; next: unknown; observations: Record<string, unknown> };
  const o = e as unknown as { evidence: unknown; next: unknown; observations: Record<string, unknown> };
  assert.deepEqual(o.evidence, b.evidence);
  assert.deepEqual(o.next, b.next);
  for (const key of ["effective_hold", "next_safe_action", "capability_completeness"]) assert.deepEqual(o.observations[key], b.observations[key]);
  const caps = o.observations.capability_completeness as { complete: boolean; incomplete_required: string[]; comparisons: { state: string }[] };
  assert.equal(caps.complete, false);
  assert.deepEqual(caps.incomplete_required, ["GMAIL_READ"]);
  assert.equal(caps.comparisons[0]!.state, "UNKNOWN");
  const p = pack(e);
  assert.equal(section(p, "DAILY_NATIVE_REALITY").source_status, "PRESENT");
  assert.equal(section(p, "DAILY_P0_RULES").source_status, "PRESENT");
  assert.equal(section(p, "DAILY_P0_RULES").items[0]!.rule, SENTINEL);
  assert.equal(section(p, "DAILY_HOLDS").items[0]!.code, HOLD);
  assert.equal(section(p, "DAILY_ACTIVE_POLICIES").source_status, "ABSENT", "missing legacy source is not fabricated");
  assert.ok(Buffer.byteLength(JSON.stringify(p.selected_context), "utf8") <= 16_384);
  for (const s of p.selected_context.contexts.flatMap((c) => c.sections)) assert.ok(s.items.length <= 10);
  assert.ok(daily.queries.length > 0);
  for (const q of daily.queries) assert.ok(q.options && q.options.page_size! <= 11);
  assert.deepEqual([...sw.w.map], before, "no Notion mutation or synthetic native proof");
  assert.deepEqual(await sw.deps.store.events.list(), events);
  assert.deepEqual(await sw.deps.store.plans.listByRuntime("VERTIGO", "SALES", bound.runtime_generation), [], "no plan created by context read");
  assert.equal(await sw.deps.store.leases.current({ project: "VERTIGO", lane: "SALES", runtime_generation: bound.runtime_generation }, ctx.now), undefined, "no lease acquired");
  const { contract_pack: _omitted, ...outside } = o.observations;
  assert.ok(!JSON.stringify(outside).includes(SENTINEL), "content is not copied outside selected_context");
  assert.ok(!JSON.stringify(e).includes(RIVAL_MARK));
  const foreign = [BC("rep-b").db, BC("rep-b").ds, COPIED_REGISTRY.db, COPIED_REGISTRY.ds];
  assert.ok(sw.client.reads.every((r) => !foreign.includes(r.id)));
});

test("PT-CP-017/b: other needs retain ABSENT and open no DAILY read under Gmail HOLD", async () => {
  const { sw, daily } = world();
  const { handle } = await bindSales(sw);
  for (const hint of ["SALES_SETUP_INPUTS", "SALES_EXTERNAL_ACTION"]) {
    const e = await resume(sw, handle, hint);
    assert.equal(e.code, HOLD);
    assert.ok(pack(e).selected_context.contexts.filter((c) => c.context === "SETUP" || c.context === "DAILY").flatMap((c) => c.sections).every((s) => s.source_status === "ABSENT"));
  }
  assert.equal(daily.queries.length, 0);
});

test("PT-CP-017/c: incomplete Calendar or Notion proof does not open the exception", async () => {
  for (const capability of ["CALENDAR_READ", "NOTION_RUNTIME_READ"]) {
    const { sw, daily } = world([...SALES_OPERATIONS_REQUIREMENTS, { ...SALES_OPERATIONS_REQUIREMENTS[0]!, capability, competentSource: capability }]);
    const { handle } = await bindSales(sw);
    const e = await resume(sw, handle, "CURRENT_WORK");
    assert.equal(e.code, HOLD);
    assert.ok(pack(e).selected_context.contexts.flatMap((c) => c.sections).every((s) => s.source_status === "ABSENT"));
    assert.equal(daily.queries.length, 0);
  }
});

test("PT-CP-017/d: recovery remains prioritary and opens no DAILY read", async () => {
  const { sw, daily } = world();
  sw.setGate("B0_DISCOVERY", { recovery: true });
  const { handle } = await bindSales(sw);
  const e = await resume(sw, handle, "CURRENT_WORK");
  assert.equal(e.status, "HOLD");
  assert.notEqual(e.code, HOLD);
  assert.ok(pack(e).selected_context.contexts.flatMap((c) => c.sections).every((s) => s.source_status === "ABSENT"));
  assert.equal(daily.queries.length, 0);
});

test("PT-CP-017/e: META cannot receive Sales DAILY facts", async () => {
  const { sw, daily } = world();
  const handle = await bindMeta(sw);
  const e = await resume(sw, handle, "CURRENT_WORK");
  assert.ok(pack(e).selected_context.contexts.flatMap((c) => c.sections).every((s) => s.source_status === "ABSENT"));
  assert.ok(!JSON.stringify(e).includes(SENTINEL));
  assert.equal(daily.queries.length, 0);
});

test("PT-CP-017/f: DAILY query failure or transport timeout preserves the outer Gmail HOLD and its challenge", async () => {
  for (const fault of ["throw", "timeout"] as const) {
    const { sw, own } = world();
    const { handle } = await bindSales(sw);
    const baseline = await resume(sw, handle, "SALES_SETUP_INPUTS");
    let timedOut = 0;
    const http = new HttpNotionClient("fixture-token-not-a-credential",
      async (_url, init) => new Promise((_resolve, reject) => {
        assert.ok(init.signal);
        const watchdog = setTimeout(() => reject(new Error("fixture watchdog: HTTP timeout did not abort")), 1000);
        init.signal.addEventListener("abort", () => { clearTimeout(watchdog); timedOut++; reject(init.signal!.reason); }, { once: true });
      }), { requestTimeoutMs: 5, max429Retries: 0 });
    // Only the added DAILY table fails; safety discovery still uses its original reader.
    const base = sw.deps.notion;
    const notion: NotionReadClient = { ...base,
      queryDataSource: (ds, ...args) => ds !== own.ds ? base.queryDataSource(ds, ...args)
        : fault === "throw" ? Promise.reject(new Error("injected DAILY read failure")) : http.queryDataSource(ds, ...args),
    };
    const e = await resume({ ...sw, deps: { ...sw.deps, notion } }, handle, "CURRENT_WORK");
    assert.equal(e.status, baseline.status);
    assert.equal(e.code, baseline.code);
    const b = baseline as unknown as { evidence: unknown; next: unknown; observations: Record<string, unknown> };
    const o = e as unknown as typeof b;
    assert.deepEqual(o.evidence, b.evidence);
    assert.deepEqual(o.next, b.next);
    for (const key of ["effective_hold", "next_safe_action", "capability_completeness", "capability_remediation"]) assert.deepEqual(o.observations[key], b.observations[key]);
    assert.ok(o.observations.capability_remediation, "challenge was still issued");
    assert.equal(section(pack(e), "DAILY_P0_RULES").source_status, "ABSENT");
    assert.equal(section(pack(e), "DAILY_ACTIVE_RULES").source_status, "ABSENT");
    assert.equal(section(pack(e), "DAILY_HOLDS").items[0]!.code, HOLD, "independent reliable safety facts remain visible");
    if (fault === "timeout") assert.equal(timedOut, 2, "real HTTP aborts both bounded DAILY queries");
  }
});
