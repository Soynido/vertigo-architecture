/**
 * PT-BATCH-001 — one user intent is one commit of n mutations (PV-WRITE-001 / W1.9, decision D12).
 *
 *   a. "add these 10 companies with their evidence" → ONE plan carrying all 20 operations, written and proved by
 *      the server executor in one transaction (one Run, one ledger row per operation);
 *   b. an intent above HARNESS_COMMIT_MAX_OPS → HOLD before anything: no plan, no lease, no Notion read or write;
 *   c. the exact same intent replayed after FINAL → `repeated`, no new durable mutation — and only while the
 *      persisted rows still stand: a row changed since makes the same intent new work again.
 *
 * Accounts and Evidence are only a realistic fixture: the mechanism is generic (an intent is n ordered
 * operations); nothing here teaches the writer that an account "goes with" an evidence row.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hashHandle } from "../../src/binding/handle.ts";
import { checkLiveness } from "../../src/binding/service.ts";
import { loadConfig } from "../../src/config/index.ts";
import { FixtureNotionClient } from "../../src/notion/fixtureClient.ts";
import { propText, type Page } from "../../src/notion/shapes.ts";
import { prepare, type Intent } from "../../src/plans/prepare.ts";
import type { Plan } from "../../src/plans/store.ts";
import type { ResolvedRuntime } from "../../src/resolvers/types.ts";
import { dispatch, resolveRuntimeFor } from "../../src/tools/handlers.ts";
import { Deadline } from "../../src/transactions/budget.ts";
import { executeTransaction, type ExecuteContext, type TransactionDeps } from "../../src/transactions/execute.ts";
import { registerBuiltinSalesAdapters, salesContractAdapter, type SalesContractAdapter } from "../../src/versions/adapters/sales.ts";
import { createAdapterRegistries } from "../../src/versions/registry.ts";
import { handleOf, OWNER } from "./binding-fixtures.ts";
import { synthetic, text } from "./meta-fixtures.ts";
import { buildResumeWorld, R, setRowsIn, type ResumeWorld } from "./resume-fixtures.ts";
import { CONTRACT_PAGE, IDS as SALES_IDS, SGRAMMAR, SV } from "./sales-fixtures.ts";
import { mutatePage } from "./target-fixtures.ts";

const NOW = new Date("2030-01-03T00:30:00.000Z");
const ctxCall = { principal_id: OWNER.principal_id, now: NOW };

function v1(): SalesContractAdapter {
  const registries = createAdapterRegistries();
  registerBuiltinSalesAdapters(registries.salesRuntime);
  const version = registries.salesRuntime.supported().find((candidate) => candidate.endsWith("/0.5.3-candidate"));
  assert.ok(version);
  return registries.salesRuntime.resolve(version) as SalesContractAdapter;
}

/** Contract lifecycle values and the business enumerations this fixture uses, declared as Notion select options. */
const OPTIONS: Readonly<Record<string, readonly string[]>> = {
  Status: ["RUNNING", "COMPLETED", "HOLD", "FAILED", "PREPARED", "WRITTEN", "VERIFIED"], Origin: ["PLUGIN", "RUNTIME"], Operation: ["CREATE", "UPDATE", "UPSERT"],
  Qualification: ["UNASSESSED", "QUALIFIED", "DISQUALIFIED"], Lifecycle: ["RESEARCH", "READY_TO_CONTACT"], Type: ["OBSERVED_FACT", "INFERENCE"], Confidence: ["CERTAIN", "LIKELY"],
};
function declareOptions(map: Map<string, unknown>, ds: string): void {
  const source = map.get(`data_source:${ds}`) as { properties: Record<string, { type: string }> } | undefined;
  if (!source) return;
  const rows = ((map.get(`query:${ds}`) as { results?: Page[] } | undefined)?.results ?? []);
  map.set(`data_source:${ds}`, { ...source, properties: Object.fromEntries(Object.entries(source.properties).map(([name, p]) => {
    if (p.type !== "select" && p.type !== "status") return [name, p];
    const present = rows.map((r) => propText(r, name)).filter((v): v is string => typeof v === "string" && v !== "");
    return [name, { ...p, [p.type]: { options: [...new Set([...present, ...(OPTIONS[name] ?? [])])].map((n) => ({ name: n })) } }];
  })) });
}

function salesWorld(): { w: ResumeWorld; accounts: string; evidence: string } {
  const w = buildResumeWorld();
  const contract = "TEST_SALES_CONTRACT/1.1.0";
  w.deps.adapters.salesRuntime.register(contract, salesContractAdapter(contract, [SV.schema], { ...SGRAMMAR, controlPlane: v1().grammar.controlPlane }));
  const ids = SALES_IDS("rep-a");
  const manifest = w.map.get(`page:${ids.manifestRow}`) as Page;
  setRowsIn(w.map, ids.manifestDs, [{ ...manifest, properties: { ...manifest.properties, "Sales Contract Version": { type: "rich_text", rich_text: [text(contract)] } } }]);
  w.map.set(`page:${CONTRACT_PAGE}`, { object: "page", id: CONTRACT_PAGE, archived: false, properties: { title: { type: "title", title: [text(contract)] } } });
  const list = (results: unknown[]) => ({ results, has_more: false, next_cursor: null });
  const data = synthetic("batch-data");
  const rootChildren = ((w.map.get(`children:${ids.root}`) as { results: unknown[] }).results);
  w.map.set(`children:${ids.root}`, list([...rootChildren, { id: data, type: "child_page", child_page: { title: "04 — DATA & EVIDENCE" } }]));
  const defs: Array<[string, string, Record<string, string>]> = [
    ["Accounts", "accounts", { Company: "title", Website: "url", Qualification: "select", Lifecycle: "select", "Do Not Contact": "checkbox" }],
    ["Evidence", "evidence", { Claim: "title", "Source URL": "url", Type: "select", Confidence: "select" }],
  ];
  const blocks: unknown[] = [];
  const ds: Record<string, string> = {};
  for (const [title, slug, properties] of defs) {
    const db = synthetic(`batch-${slug}-db`);
    ds[title] = synthetic(`batch-${slug}-ds`);
    blocks.push({ id: db, type: "child_database", child_database: { title } });
    w.map.set(`database:${db}`, { data_sources: [{ id: ds[title] }] });
    w.map.set(`data_source:${ds[title]}`, { properties: Object.fromEntries(Object.entries(properties).map(([name, type]) => [name, { type }])) });
    setRowsIn(w.map, ds[title] as string, []);
  }
  w.map.set(`children:${data}`, list(blocks));
  for (const d of [...Object.values(ds), R.salesRunsDs, R.salesLedgerDs]) declareOptions(w.map, d);
  return { w, accounts: ds["Accounts"] as string, evidence: ds["Evidence"] as string };
}

/** Ten companies, each with the evidence that justifies it: twenty ordered operations in one intent. */
function tenCompanies(n = 10): Intent {
  const mutations = [];
  for (let i = 1; i <= n; i += 1) {
    mutations.push({ logical_resource_key: "SALES:ACCOUNTS", operation: "CREATE" as const, record_selector: { natural_key: `https://company-${i}.example/` }, desired_changes: { Company: `Company ${i}`, Qualification: "UNASSESSED", Lifecycle: "RESEARCH", "Do Not Contact": false } });
    mutations.push({ logical_resource_key: "SALES:EVIDENCE", operation: "CREATE" as const, record_selector: { natural_key: `https://company-${i}.example/proof` }, desired_changes: { Claim: `Company ${i} films its process`, Type: "OBSERVED_FACT", Confidence: "CERTAIN" } });
  }
  return { action_class: "COMMIT", summary: `add ${n} companies with their evidence`, mutations };
}

async function session(w: ResumeWorld, config = w.deps.config) {
  const clock = { t: NOW.getTime() };
  const client = new FixtureNotionClient(w.map, { now: () => new Date(clock.t) });
  const deps: TransactionDeps = { ...w.deps, config, notion: client, notionWriter: client };
  const h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctxCall, w.deps));
  const binding = (await w.deps.store.bindings.findByHandleHash(hashHandle(h)))!;
  const live = await checkLiveness(w.deps.store, w.deps.principals, binding, NOW, (pr, project, lane) => resolveRuntimeFor(w.deps, pr, project, lane));
  assert.ok(live.ok, JSON.stringify(live));
  const runtime = (live as { runtime: ResolvedRuntime }).runtime;
  const exec = (plan: Plan): ExecuteContext => ({ principal_id: OWNER.principal_id, binding, runtime, plan_id: plan.plan_id, cursor_ref: plan.state_last_write.target_ref, deadline: new Deadline(() => clock.t, 120_000), clock: () => new Date(clock.t), sleep: async () => {} });
  return { client, deps, h, binding, runtime, clock, exec };
}

test("PT-BATCH-001/a: 10 companies + their evidence = ONE plan of 20 operations, written and proved in one transaction", async () => {
  const { w, accounts, evidence } = salesWorld();
  const s = await session(w);
  const p = await prepare(s.deps, s.binding, s.runtime, tenCompanies(), NOW, { detectPersistedReplay: true });
  assert.equal(p.kind, "PREPARED", JSON.stringify(p));
  const plan = (p as { plan: Plan }).plan;
  assert.equal(plan.operations.length, 20, "one plan carries every operation of the intent");
  assert.deepEqual(plan.operations.map((o) => o.ordinal), [...Array(20).keys()], "in the order the intent gave them");
  assert.equal((await s.deps.store.plans.listByRuntime("VERTIGO", "SALES", s.binding.runtime_generation)).length, 1, "and there is no other plan");
  const out = await executeTransaction(s.deps, s.exec(plan));
  assert.equal(out.kind, "PERSISTED", JSON.stringify(out));
  assert.equal(((w.map.get(`query:${accounts}`) as { results: Page[] }).results).length, 10);
  assert.equal(((w.map.get(`query:${evidence}`) as { results: Page[] }).results).length, 10);
  const byPlan = (ds: string) => ((w.map.get(`query:${ds}`) as { results: Page[] }).results).filter((r) => propText(r, "Harness Plan ID") === plan.plan_id).length;
  assert.deepEqual([byPlan(R.salesRunsDs), byPlan(R.salesLedgerDs)], [1, 20], "one Run for the whole intent, one ledger row per operation");
});

test("PT-BATCH-001/b: above HARNESS_COMMIT_MAX_OPS → HOLD before anything: no plan, no lease, nothing read or written", async () => {
  assert.equal(loadConfig({ VERTIGO_META_SPEC_ROOT: "https://example.invalid/root", HARNESS_ENV: "fixture", PRINCIPALS_FILE: "x" }).commitMaxOps, 25, "default ceiling");
  assert.throws(() => loadConfig({ VERTIGO_META_SPEC_ROOT: "https://example.invalid/root", HARNESS_ENV: "fixture", PRINCIPALS_FILE: "x", HARNESS_COMMIT_MAX_OPS: "2.5" }), /positive integer/);
  const { w } = salesWorld();
  const s = await session(w, { ...w.deps.config, commitMaxOps: 19 });
  let reads = 0;
  const counting = { ...s.deps, notion: new Proxy(s.client, { get: (t, k) => { const v = Reflect.get(t, k); return typeof v === "function" ? (...a: unknown[]) => { reads += 1; return (v as (...x: unknown[]) => unknown).apply(t, a); } : v; } }) } as TransactionDeps;
  const p = await prepare(counting, s.binding, s.runtime, tenCompanies(), NOW, { detectPersistedReplay: true });
  assert.deepEqual([p.kind, (p as { code?: string }).code], ["HOLD", "HOLD_UNSUPPORTED_OPERATION"]);
  assert.match((p as { evidence: readonly string[] }).evidence[0] as string, /20 mutations; one commit accepts at most 19/);
  assert.deepEqual(await s.deps.store.plans.listByRuntime("VERTIGO", "SALES", s.binding.runtime_generation), [], "no plan");
  assert.equal(await s.deps.store.leases.current({ project: "VERTIGO", lane: "SALES", runtime_generation: s.binding.runtime_generation }, NOW), undefined, "no lease");
  assert.deepEqual([reads, s.client.writes.length], [0, 0], "nothing read, nothing written");
});

test("PT-BATCH-001/c: the same intent replayed after FINAL → repeated, nothing written; a row changed since → new work again", async () => {
  const { w, accounts } = salesWorld();
  const s = await session(w);
  const first = await prepare(s.deps, s.binding, s.runtime, tenCompanies(), NOW, { detectPersistedReplay: true });
  const plan = (first as { plan: Plan }).plan;
  const done = await executeTransaction(s.deps, s.exec(plan));
  assert.equal(done.kind, "PERSISTED");
  const writes = s.client.writes.length;

  const replay = await prepare(s.deps, s.binding, s.runtime, tenCompanies(), NOW, { detectPersistedReplay: true });
  assert.deepEqual([replay.kind, (replay as { replayed?: boolean }).replayed, (replay as { plan?: Plan }).plan?.plan_id], ["PREPARED", true, plan.plan_id]);
  const again = await executeTransaction(s.deps, s.exec(plan));
  assert.deepEqual([again.kind, (again as { repeated?: boolean }).repeated, (again as { writes_sent?: number }).writes_sent], ["PERSISTED", true, 0]);
  assert.equal(s.client.writes.length, writes, "no new durable mutation");
  assert.equal(((w.map.get(`query:${accounts}`) as { results: Page[] }).results).length, 10);

  // Someone requalified one company since: the same words are new work, never a stale "already done".
  const row = ((w.map.get(`query:${accounts}`) as { results: Page[] }).results)[0]!;
  mutatePage(w, row.id, { Qualification: "QUALIFIED" }, "2030-01-03T00:45:00.000Z");
  const afterEdit = await prepare(s.deps, s.binding, s.runtime, tenCompanies(), NOW, { detectPersistedReplay: true });
  assert.notEqual((afterEdit as { plan?: Plan }).plan?.plan_id, plan.plan_id, JSON.stringify(afterEdit).slice(0, 400));
});
