/**
 * PT-CP-012 fixtures — W2.2 SETUP context (CONTRACT_PACK/0.3.0-candidate).
 *
 * A Personal SALES runtime (rep A) pinning the full setup line — every published B0 → B7 cursor transition — with its
 * own Business Configuration under the bound root. Beside it: a second runtime (rep B) with a rival Business
 * Configuration full of rival values, and a Registry table copied into rep A that names that rival. Neither may ever
 * be read. A recording client emulates the ONE server filter the SETUP reader may send (Config Item equality, verbatim)
 * and records every read, so "zero read" and "one filter per key" are observable facts rather than intentions.
 */
import assert from "node:assert/strict";
import { redact } from "../../src/gtm/semantics.ts";
import type { NotionReadClient } from "../../src/notion/readClient.ts";
import { plainText, type Page, type RichText } from "../../src/notion/shapes.ts";
import type { ResolvedRuntime } from "../../src/resolvers/types.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import { dispatch, resolveRuntimeFor, type HarnessDeps } from "../../src/tools/handlers.ts";
import type { ControlPlaneGrammar } from "../../src/versions/adapters/controlPlane.ts";
import { registerBuiltinSalesAdapters, salesContractAdapter, type SalesContractAdapter } from "../../src/versions/adapters/sales.ts";
import { createAdapterRegistries } from "../../src/versions/registry.ts";
import { handleOf, OWNER, T0 } from "./binding-fixtures.ts";
import { synthetic, text } from "./meta-fixtures.ts";
import { buildResumeWorld, setRowsIn, type ResumeWorld } from "./resume-fixtures.ts";
import { CONTRACT_PAGE, IDS as SALES_IDS, SGRAMMAR, SV } from "./sales-fixtures.ts";

export const ctx = { principal_id: OWNER.principal_id, now: T0 };
export const CONFIG = "SALES:BUSINESS_CONFIG";
export const SETUP_CONTRACT = "TEST_SALES_CONTRACT/1.8.0";
export const GATES = ["B0_DISCOVERY", "B1_OFFER", "B2_ICP", "B3_DATA", "B4_QUALIFICATION", "B5_OUTREACH", "B6_AUTHORITY", "B7_DRY_RUN"] as const;

/**
 * The published answer of every specified step, transcribed independently of the adapter so the oracle is not the
 * code under test. Each value carries a sentinel that must never appear outside `selected_context`.
 */
export interface Step { readonly gate: string; readonly key: string; readonly category: string; readonly value: string }
export const STEPS: readonly Step[] = [
  { gate: "B0_DISCOVERY", key: "B0_DISCOVERY:PRIMARY_OUTCOME", category: "GOAL", value: "SENTINEL-B0 trois rendez-vous qualifiés par mois" },
  { gate: "B1_OFFER", key: "B1_OFFER:SELLABLE_OFFER", category: "OFFER", value: "SENTINEL-B1 audit de conformité livré en dix jours" },
  { gate: "B2_ICP", key: "B2_ICP:TARGET_ACCOUNTS", category: "ICP_INCLUDE", value: "SENTINEL-B2 industriels français de 50 à 500 salariés" },
  { gate: "B3_DATA", key: "B3_DATA:CANONICAL_SOURCE", category: "OTHER", value: "SENTINEL-B3 export CRM hebdomadaire, doublons fusionnés" },
  { gate: "B4_QUALIFICATION", key: "B4_QUALIFICATION:HARD_GATE", category: "CONSTRAINT", value: "SENTINEL-B4 jamais d'organisme public" },
  { gate: "B5_OUTREACH", key: "B5_OUTREACH:SEQUENCE", category: "MESSAGING", value: "SENTINEL-B5 trois touches email, arrêt à la réponse" },
  { gate: "B6_AUTHORITY", key: "B6_AUTHORITY:SEND_AUTHORITY", category: "CONSTRAINT", value: "SENTINEL-B6 aucun envoi sans accord" },
];
export const stepOf = (gate: string): Step => {
  const s = STEPS.find((x) => x.gate === gate);
  assert.ok(s, "no step " + gate);
  return s;
};

/** Values carried by columns the SETUP projection does not declare: they must never be served. */
export const NOTE_MARK = "NONPROJECTED-NOTE carnet perso";
export const SCORE_MARK = 97531;
export const RIVAL_MARK = "RIVAL-REP-B";

const rt = (s: string): RichText[] => [text(s)];
export const CONFIG_SCHEMA = {
  properties: {
    "Config Item": { type: "title" }, Category: { type: "select" }, State: { type: "select" }, Value: { type: "rich_text" },
    Version: { type: "rich_text" }, Source: { type: "rich_text" }, "Effective At": { type: "date" }, Notes: { type: "rich_text" },
    // A column the seller added to their own space: tolerated by being ignored.
    "Score perso": { type: "number" },
  },
};

export interface RowOver {
  readonly id?: string; readonly configItem?: string; readonly category?: string | null; readonly state?: string;
  readonly value?: string | readonly string[]; readonly version?: string; readonly source?: string;
}
/** A Business Configuration row exactly as PV-B0-001 writes it, plus the seller's own non-projected columns. */
export function answerRow(ds: string, step: Step, over: RowOver = {}): Page {
  const value = over.value ?? step.value;
  return {
    object: "page", id: over.id ?? synthetic(`pt-cp-012-row-${ds}-${step.key}`), archived: false, last_edited_time: "2030-01-01T06:00:00.000Z",
    parent: { type: "data_source_id", data_source_id: ds },
    properties: {
      "Config Item": { type: "title", title: rt(over.configItem ?? step.key) },
      Category: { type: "select", select: over.category === null ? null : { name: over.category ?? step.category } },
      State: { type: "select", select: { name: over.state ?? "CONFIRMED" } },
      Value: { type: "rich_text", rich_text: (typeof value === "string" ? [value] : value).map((s) => text(s)) },
      Version: { type: "rich_text", rich_text: rt(over.version ?? "SALES_INPUT/1") },
      Source: { type: "rich_text", rich_text: rt(over.source ?? "CHAT_USER_EXPLICIT") },
      "Effective At": { type: "date", date: { start: "2030-01-01" } },
      Notes: { type: "rich_text", rich_text: rt(NOTE_MARK) },
      "Score perso": { type: "number", number: SCORE_MARK },
    } as Page["properties"],
  };
}

/** The expected served item for one step's conforming row: projected keys only, values untouched. */
export const itemOf = (step: Step, value = step.value) => ({
  step_key: step.gate, config_item: step.key, category: step.category, state: "CONFIRMED", value, version: "SALES_INPUT/1", source: "CHAT_USER_EXPLICIT",
});

export const BC = (rep: "rep-a" | "rep-b") => ({
  parent: synthetic(`pt-cp-012-setup-parent-${rep}`), db: synthetic(`pt-cp-012-config-db-${rep}`), ds: synthetic(`pt-cp-012-config-ds-${rep}`),
});
/** The Registry table every clone carries under its boot page. A copy of it is never an addressing authority. */
export const COPIED_REGISTRY = { db: synthetic("registry-rep-a"), ds: synthetic("pt-cp-012-copied-registry-ds") };

export type Read = { readonly op: "page" | "database" | "data_source" | "children" | "query"; readonly id: string; readonly filter?: unknown };

const titleText = (p: Page): string => {
  const prop = p.properties["Config Item"];
  return prop && prop.type === "title" ? plainText((prop as { title: readonly RichText[] }).title) : "";
};

/** Fixture Notion client that records every read and applies a Config Item equality filter the way Notion does. */
export class RecordingClient implements NotionReadClient {
  readonly reads: Read[] = [];
  /** Config Item values whose keyed query fails, as an unavailable Notion read would. */
  readonly failing = new Set<string>();
  readonly #map: ReadonlyMap<string, unknown>;
  constructor(map: ReadonlyMap<string, unknown>) { this.#map = map; }
  #get(key: string): unknown {
    if (!this.#map.has(key)) throw new Error(`fixture missing: ${key}`);
    return this.#map.get(key);
  }
  async retrievePage(id: string) { this.reads.push({ op: "page", id }); return this.#get(`page:${id}`); }
  async retrieveDatabase(id: string) { this.reads.push({ op: "database", id }); return this.#get(`database:${id}`); }
  async retrieveDataSource(id: string) { this.reads.push({ op: "data_source", id }); return this.#get(`data_source:${id}`); }
  async retrieveBlockChildren(id: string) { this.reads.push({ op: "children", id }); return this.#get(`children:${id}`); }
  async queryDataSource(id: string, filter: unknown) {
    this.reads.push({ op: "query", id, filter });
    const all = this.#get(`query:${id}`) as { results: readonly Page[] };
    const f = filter as { property?: unknown; title?: { equals?: unknown } } | undefined;
    if (f?.property !== "Config Item" || typeof f.title?.equals !== "string") return all;
    const key = f.title.equals;
    if (this.failing.has(key)) throw new Error("fixture: keyed query unavailable");
    return { results: all.results.filter((p) => titleText(p) === key), has_more: false, next_cursor: null };
  }
  on(id: string): Read[] { return this.reads.filter((r) => r.id === id); }
  reset(): void { this.reads.length = 0; }
}

export const nextActionOf = (gate: string) => `Action formelle de ${gate}`;
export const nextQuestionOf = (gate: string) => `Question formelle de ${gate} ?`;

export interface SetupWorld {
  readonly w: ResumeWorld;
  readonly client: RecordingClient;
  readonly deps: HarnessDeps;
  /** Replace rep A's Business Configuration rows. */
  setRows(rows: readonly Page[]): void;
  /** Move rep A's durable cursor. */
  setGate(gate: string, o?: { readonly status?: string; readonly recovery?: boolean }): void;
}

/** The governing control plane of the full setup line, as the backend registers it. */
export function fullSetupLine(): ControlPlaneGrammar {
  const registries = createAdapterRegistries();
  registerBuiltinSalesAdapters(registries.salesRuntime);
  const v = registries.salesRuntime.supported().find((x) => x.endsWith("/0.5.6-candidate"));
  assert.ok(v, "the full setup line is registered");
  return (registries.salesRuntime.resolve(v) as SalesContractAdapter).grammar.controlPlane;
}

/** Rep A on `gate`, with the answers of the first `answered` steps in its own Business Configuration. */
export function buildSetupWorld(gate: string, answered = 0): SetupWorld {
  const w = buildResumeWorld();
  const list = (results: unknown[]) => ({ results, has_more: false, next_cursor: null });
  const spec = fullSetupLine().resources?.[CONFIG];
  assert.ok(spec?.parentTitle);
  w.deps.adapters.salesRuntime.register(SETUP_CONTRACT, salesContractAdapter(SETUP_CONTRACT, [SV.schema], { ...SGRAMMAR, controlPlane: fullSetupLine() }));
  w.map.set(`page:${CONTRACT_PAGE}`, { object: "page", id: CONTRACT_PAGE, archived: false, properties: { title: { type: "title", title: rt(SETUP_CONTRACT) } } });

  for (const rep of ["rep-a", "rep-b"] as const) {
    const ids = SALES_IDS(rep);
    const manifest = w.map.get(`page:${ids.manifestRow}`) as Page;
    setRowsIn(w.map, ids.manifestDs, [{ ...manifest, properties: { ...manifest.properties, "Sales Contract Version": { type: "rich_text", rich_text: rt(SETUP_CONTRACT) } } as Page["properties"] }]);
    const bc = BC(rep);
    const rootChildren = (w.map.get(`children:${ids.root}`) as { results: unknown[] }).results;
    w.map.set(`children:${ids.root}`, list([...rootChildren, { id: bc.parent, type: "child_page", child_page: { title: spec.parentTitle } }]));
    w.map.set(`children:${bc.parent}`, list([{ id: bc.db, type: "child_database", child_database: { title: spec.databaseTitle } }]));
    w.map.set(`database:${bc.db}`, { object: "database", id: bc.db, data_sources: [{ id: bc.ds }] });
    w.map.set(`data_source:${bc.ds}`, CONFIG_SCHEMA);
  }
  // Rep B's rival answers for every step: a runtime this binding does not own, which must show zero reads.
  setRowsIn(w.map, BC("rep-b").ds, STEPS.map((s) => answerRow(BC("rep-b").ds, s, { value: `${RIVAL_MARK} ${s.gate}` })));
  // The copied Registry of rep A names rep B's database: it is data, never an address.
  w.map.set(`database:${COPIED_REGISTRY.db}`, { object: "database", id: COPIED_REGISTRY.db, data_sources: [{ id: COPIED_REGISTRY.ds }] });
  w.map.set(`data_source:${COPIED_REGISTRY.ds}`, { properties: { Key: { type: "title" }, URL: { type: "url" } } });
  setRowsIn(w.map, COPIED_REGISTRY.ds, [{ object: "page", id: synthetic("pt-cp-012-copied-registry-row"), archived: false, properties: { Key: { type: "title", title: rt(CONFIG) }, URL: { type: "url", url: `https://example.invalid/p/${BC("rep-b").db}` } } as Page["properties"] }]);

  const client = new RecordingClient(w.map);
  const deps: HarnessDeps = { ...w.deps, notion: client };
  const sw: SetupWorld = {
    w, client, deps,
    setRows(rows) { setRowsIn(w.map, BC("rep-a").ds, [...rows]); },
    setGate(g, o = {}) { w.setSalesState({ gate: g, buildState: g, gateStatus: o.status ?? "OPEN", recovery: o.recovery ?? false, nextAction: nextActionOf(g), nextQuestion: nextQuestionOf(g) }); },
  };
  sw.setRows(STEPS.slice(0, answered).map((s) => answerRow(BC("rep-a").ds, s)));
  sw.setGate(gate);
  return sw;
}

export interface Bound { readonly handle: string; readonly runtime_id: string; readonly runtime_generation: string }

export async function bindSales(sw: SetupWorld): Promise<Bound> {
  const e = await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, sw.deps);
  const b = (e as unknown as { binding: { runtime_id: string; runtime_generation: string } }).binding;
  return { handle: handleOf(e), runtime_id: b.runtime_id, runtime_generation: b.runtime_generation };
}

export async function bindMeta(sw: SetupWorld): Promise<string> {
  return handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, sw.deps));
}

export async function resume(sw: SetupWorld, handle: string, topic_hint?: string): Promise<Envelope> {
  return dispatch("os_resume", topic_hint === undefined ? { binding_handle: handle } : { binding_handle: handle, topic_hint }, ctx, sw.deps);
}

/**
 * Receipts proving the given rows, as a FINAL-verified transaction of this runtime would leave them. With them the
 * rows are this runtime's own proved answers: no foreign-write or orphan confirmation is owed, so a sentinel that
 * reaches the envelope can only have come through `selected_context`.
 */
export async function proveRows(sw: SetupWorld, bound: Bound, rows: readonly Page[]): Promise<void> {
  const plan_id = "pt-cp-012-proved-setup";
  const base = { plan_id, principal_id: OWNER.principal_id, runtime_id: bound.runtime_id, runtime_generation: bound.runtime_generation, observed_at: T0 };
  const value = (p: Page): string => plainText((p.properties["Value"] as { rich_text: readonly RichText[] }).rich_text);
  await sw.deps.store.receipts.insert({
    ...base, receipt_id: "pt-cp-012-target", type: "TARGET", status: "CONSUMED",
    observations: { targets: rows.map((r, i) => ({ ordinal: i, target_ref: r.id, data_source_ref: BC("rep-a").ds, logical_resource_key: CONFIG, compared_fields: ["Value"], observed: { Value: redact(value(r)) }, last_edited: r.last_edited_time })) },
  });
  await sw.deps.store.receipts.insert({ ...base, receipt_id: "pt-cp-012-final", type: "FINAL", status: "VALID", target_receipt_id: "pt-cp-012-target", observations: {} });
}

/** Rep A's runtime, resolved by the backend exactly as a binding resolves it. */
export async function runtimeOf(sw: SetupWorld): Promise<ResolvedRuntime> {
  const resolved = await resolveRuntimeFor(sw.w.deps, OWNER, "VERTIGO", "SALES");
  assert.equal(resolved.kind, "RESOLVED", JSON.stringify(resolved));
  return (resolved as Extract<typeof resolved, { kind: "RESOLVED" }>).runtime;
}

/** The same runtime under a hand-made control plane: the structural cases no published line exhibits. */
export function withControlPlane(runtime: ResolvedRuntime, over: Partial<ControlPlaneGrammar>): ResolvedRuntime {
  return { ...runtime, adapter: { ...runtime.adapter, controlPlane: { ...runtime.adapter.controlPlane, ...over } } };
}
