/**
 * The one transaction driver of the test suites (PV-WRITE-001 / W1.11, annex A.9).
 *
 * W3.3L retires production native rendering. The historical readback protocol remains a fixture only:
 *
 *   - `transact` — historical internal hooks: os_prepare → fixture evidence injection performs stage 1 →
 *     os_verify(TARGET) → native finalization + state-last → os_verify(FINAL). The seven local helpers the suites
 *     used to carry (`transact` ×4, `runTransaction`, `throughFinal`, `crashAfter`) are thin wrappers over it.
 *     Finalization resolves through the strict backend resolver, never a native connector renderer;
 *   - `executorSession` / `salesV1World` — the BUILD TARGET: the server executor writes and proves the same
 *     stored plan itself (`executeTransaction`), against a FixtureNotionClient world shaped like Notion.
 *
 * Nothing here changes what a tool does; it only removes seven copies of the same sequence.
 */
import assert from "node:assert/strict";
import { hashHandle } from "../../src/binding/handle.ts";
import { checkLiveness } from "../../src/binding/service.ts";
import type { BindingRecord } from "../../src/binding/store.ts";
import type { HarnessConfig } from "../../src/config/index.ts";
import { FixtureNotionClient } from "../../src/notion/fixtureClient.ts";
import { propText, type Page } from "../../src/notion/shapes.ts";
import type { Plan } from "../../src/plans/store.ts";
import type { ResolvedRuntime } from "../../src/resolvers/types.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import { dispatch, resolveRuntimeFor, type HarnessDeps } from "../../src/tools/handlers.ts";
import { Deadline } from "../../src/transactions/budget.ts";
import type { ExecuteContext, TransactionDeps } from "../../src/transactions/execute.ts";
import { registerBuiltinSalesAdapters, salesContractAdapter, type SalesContractAdapter } from "../../src/versions/adapters/sales.ts";
import { createAdapterRegistries } from "../../src/versions/registry.ts";
import { handleOf } from "../unit/binding-fixtures.ts";
import { synthetic, text } from "../unit/meta-fixtures.ts";
import { buildResumeWorld, R, setRowsIn, type ResumeWorld } from "../unit/resume-fixtures.ts";
import { CONTRACT_PAGE, IDS as SALES_IDS, SGRAMMAR, SV } from "../unit/sales-fixtures.ts";
import { executeWrites, type WriterOptions } from "../unit/target-fixtures.ts";

export type Ok = Extract<Envelope, { status: "OK" }>;
/** Any fixture world: the harness dependencies plus the Notion map the native writer mutates. */
export interface NativeWorld { readonly deps: HarnessDeps; readonly map: Map<string, unknown> }
export interface CallCtx { readonly principal_id: string; readonly now?: Date }
export interface Stamps { readonly stage1: string; readonly fin: string; readonly state: string }

/** The timestamps the suites have always used: one minute (`salt`) of a fixture day, three instants in it. */
export const stampsAt = (day: string, salt: string): Stamps => ({ stage1: `2030-01-${day}T00:${salt}:00.000Z`, fin: `2030-01-${day}T00:${salt}:30.000Z`, state: `2030-01-${day}T00:${salt}:45.000Z` });

export async function prepare(w: NativeWorld, h: string, intent: unknown | undefined, ctx: CallCtx): Promise<{ envelope: Envelope; plan?: Plan }> {
  const envelope = await dispatch("os_prepare", intent === undefined ? { binding_handle: h } : { binding_handle: h, intent }, ctx, w.deps);
  if (envelope.status !== "OK") return { envelope };
  const plan = await w.deps.store.plans.get((envelope as Ok).result["plan_id"] as string);
  return { envelope, ...(plan ? { plan } : {}) };
}

/** The native writer performs a plan's stage 1. Returns symbol → created page id. */
export const stage1 = (w: NativeWorld, plan: Plan, opts: WriterOptions = {}): Record<string, string> => executeWrites(w, plan.stage1_writes, plan.plan_id, opts);

export interface TransactOptions {
  readonly ctx: CallCtx;
  /** Context of the two os_verify calls when it differs from the prepare's (a later clock). */
  readonly verifyCtx?: CallCtx;
  readonly stamps: Stamps;
  /** Native-writer knobs for stage 1 (skip, sabotage, duplicate…). */
  readonly stage1?: WriterOptions;
  /** Runs after stage 1 landed and before TARGET is verified: a concurrent actor. */
  readonly whileInFlight?: () => void;
}

export interface Transacted { readonly plan: Plan; readonly target: Envelope; readonly final: Envelope; readonly symbols: Record<string, string>; readonly receipt: string }

/** Historical trace injection for proof oracles, NOT a served LIVE transaction; asserts every step. */
export async function transact(w: NativeWorld, h: string, intent: unknown | undefined, o: TransactOptions): Promise<Transacted> {
  const p = await prepare(w, h, intent, o.ctx);
  assert.equal(p.envelope.code, "PLAN_PREPARED", JSON.stringify(p.envelope));
  const plan = p.plan as Plan;
  const created = stage1(w, plan, { now: o.stamps.stage1, ...(o.stage1 ?? {}) });
  o.whileInFlight?.();
  const vctx = o.verifyCtx ?? o.ctx;
  const target = await dispatch("os_verify", { binding_handle: h, plan_id: plan.plan_id, phase: "TARGET" }, vctx, w.deps);
  assert.equal(target.code, "TARGET_VERIFIED", JSON.stringify(target));
  const receipt = ((target as Ok).result as { target_receipt_id: string }).target_receipt_id;
  const symbols = (target.observations["symbols"] as Record<string, string> | undefined) ?? created;
  executeWrites(w, plan.finalization_writes, plan.plan_id, { ...({ now: o.stamps.fin }), created: symbols, target_receipt_id: receipt });
  executeWrites(w, [plan.state_last_write], plan.plan_id, { ...({ now: o.stamps.state }), created: symbols, target_receipt_id: receipt });
  const final = await dispatch("os_verify", { binding_handle: h, plan_id: plan.plan_id, phase: "FINAL" }, vctx, w.deps);
  assert.equal(final.code, "TRANSACTION_VERIFIED", JSON.stringify(final));
  return { plan, target, final, symbols, receipt };
}

/* ───────────────────────── the server executor (BUILD TARGET) ───────────────────────── */

/** Contract lifecycle values and the fixture's business enumerations, declared as Notion select options (D11). */
const OPTIONS: Readonly<Record<string, readonly string[]>> = {
  Status: ["RUNNING", "COMPLETED", "HOLD", "FAILED", "PREPARED", "WRITTEN", "VERIFIED"], Origin: ["PLUGIN", "RUNTIME", "META_RUNTIME"], Operation: ["CREATE", "UPDATE", "UPSERT"],
  Qualification: ["UNASSESSED", "QUALIFIED", "DISQUALIFIED"], Lifecycle: ["RESEARCH", "READY_TO_CONTACT"], Type: ["OBSERVED_FACT", "INFERENCE"], Confidence: ["CERTAIN", "LIKELY"],
  State: ["SUBMITTED", "CONFIRMED"], Source: ["USER_CONFIRMED_FIXTURE"],
};

/** Gives a fixture data source the select options a real Notion schema carries: what its rows hold + the contract's lifecycle. */
export function declareOptions(map: Map<string, unknown>, ds: string): void {
  const source = map.get(`data_source:${ds}`) as { properties: Record<string, { type: string }> } | undefined;
  if (!source) return;
  const rows = ((map.get(`query:${ds}`) as { results?: Page[] } | undefined)?.results ?? []);
  map.set(`data_source:${ds}`, { ...source, properties: Object.fromEntries(Object.entries(source.properties).map(([name, p]) => {
    if (p.type !== "select" && p.type !== "status") return [name, p];
    const present = rows.map((r) => propText(r, name)).filter((v): v is string => typeof v === "string" && v !== "");
    return [name, { ...p, [p.type]: { options: [...new Set([...present, ...(OPTIONS[name] ?? [])])].map((n) => ({ name: n })) } }];
  })) });
}

function salesV1Adapter(): SalesContractAdapter {
  const registries = createAdapterRegistries();
  registerBuiltinSalesAdapters(registries.salesRuntime);
  const version = registries.salesRuntime.supported().find((candidate) => candidate.endsWith("/0.5.3-candidate"));
  assert.ok(version);
  return registries.salesRuntime.resolve(version) as SalesContractAdapter;
}

/** The resume world with a SALES V1 runtime holding empty Accounts and Evidence databases, options declared. */
export function salesV1World(): { w: ResumeWorld; accounts: string; evidence: string } {
  const w = buildResumeWorld();
  const contract = "TEST_SALES_CONTRACT/1.1.0";
  w.deps.adapters.salesRuntime.register(contract, salesContractAdapter(contract, [SV.schema], { ...SGRAMMAR, controlPlane: salesV1Adapter().grammar.controlPlane }));
  const ids = SALES_IDS("rep-a");
  const manifest = w.map.get(`page:${ids.manifestRow}`) as Page;
  setRowsIn(w.map, ids.manifestDs, [{ ...manifest, properties: { ...manifest.properties, "Sales Contract Version": { type: "rich_text", rich_text: [text(contract)] } } }]);
  w.map.set(`page:${CONTRACT_PAGE}`, { object: "page", id: CONTRACT_PAGE, archived: false, properties: { title: { type: "title", title: [text(contract)] } } });
  const list = (results: unknown[]) => ({ results, has_more: false, next_cursor: null });
  const data = synthetic("support-data");
  const rootChildren = ((w.map.get(`children:${ids.root}`) as { results: unknown[] }).results);
  w.map.set(`children:${ids.root}`, list([...rootChildren, { id: data, type: "child_page", child_page: { title: "04 — DATA & EVIDENCE" } }]));
  const defs: Array<[string, string, Record<string, string>]> = [
    ["Accounts", "accounts", { Company: "title", Website: "url", Qualification: "select", Lifecycle: "select", "Do Not Contact": "checkbox" }],
    ["Evidence", "evidence", { Claim: "title", "Source URL": "url", Type: "select", Confidence: "select" }],
  ];
  const blocks: unknown[] = [];
  const ds: Record<string, string> = {};
  for (const [title, slug, properties] of defs) {
    const db = synthetic(`support-${slug}-db`);
    ds[title] = synthetic(`support-${slug}-ds`);
    blocks.push({ id: db, type: "child_database", child_database: { title } });
    w.map.set(`database:${db}`, { data_sources: [{ id: ds[title] }] });
    w.map.set(`data_source:${ds[title]}`, { properties: Object.fromEntries(Object.entries(properties).map(([name, type]) => [name, { type }])) });
    setRowsIn(w.map, ds[title] as string, []);
  }
  w.map.set(`children:${data}`, list(blocks));
  for (const d of [...Object.values(ds), R.salesRunsDs, R.salesLedgerDs]) declareOptions(w.map, d);
  return { w, accounts: ds["Accounts"] as string, evidence: ds["Evidence"] as string };
}

export interface ExecutorSession {
  readonly client: FixtureNotionClient;
  readonly deps: TransactionDeps;
  readonly h: string;
  readonly binding: BindingRecord;
  readonly runtime: ResolvedRuntime;
  readonly clock: { t: number };
  /** The executor's context for one stored plan; the deadline is generous, the sleeps are no-ops. */
  readonly exec: (plan: Plan) => ExecuteContext;
}

/**
 * Binds `principal` on `lane`, then hands back a FixtureNotionClient that is both the reads and the writer of the
 * harness dependencies, so `executeTransaction` runs against the same map the world was built from.
 */
export async function executorSession(w: ResumeWorld, o: { principal_id: string; lane: "META" | "SALES"; now: Date; config?: HarnessConfig; declare?: readonly string[] }): Promise<ExecutorSession> {
  for (const ds of o.declare ?? []) declareOptions(w.map, ds);
  const clock = { t: o.now.getTime() };
  const client = new FixtureNotionClient(w.map, { now: () => new Date(clock.t) });
  const deps: TransactionDeps = { ...w.deps, ...(o.config ? { config: o.config } : {}), notion: client, notionWriter: client };
  const h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: o.lane }, { principal_id: o.principal_id, now: o.now }, w.deps));
  const binding = (await w.deps.store.bindings.findByHandleHash(hashHandle(h)))!;
  const live = await checkLiveness(w.deps.store, w.deps.principals, binding, o.now, (pr, project, lane) => resolveRuntimeFor(w.deps, pr, project, lane));
  assert.ok(live.ok, JSON.stringify(live));
  const runtime = (live as { runtime: ResolvedRuntime }).runtime;
  const exec = (plan: Plan): ExecuteContext => ({ principal_id: o.principal_id, binding, runtime, plan_id: plan.plan_id, cursor_ref: plan.state_last_write.target_ref, deadline: new Deadline(() => clock.t, 120_000), clock: () => new Date(clock.t), sleep: async () => {} });
  return { client, deps, h, binding, runtime, clock, exec };
}
