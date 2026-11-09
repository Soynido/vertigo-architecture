/**
 * PT-COMMIT-001 fixtures: a Personal Sales runtime pinned to the Sales 0.5.11 CANDIDATE line, with its Production
 * Guard sources (W3.1R/W3.1S) — the index page under the constitution page, Decision Rules, Runtime Configuration,
 * Business Configuration and Tasks — shaped like Notion (select options with ids, paginated lists that prove their
 * end).
 *
 * The 0.5.11 adapter is INJECTED here, into this world's registry only: src/versions/adapters/sales.ts does not
 * register the line, and nothing here adopts it or claims runtime readiness (registration belongs to the activation
 * gate). Every rule, threshold and Type below is a fixture value of this test world, never a product constant.
 */
import assert from "node:assert/strict";
import { approveGuard } from "../../src/cli/guard-approve.ts";
import { FixtureNotionClient } from "../../src/notion/fixtureClient.ts";
import type { NotionClient } from "../../src/notion/client.ts";
import type { Page } from "../../src/notion/shapes.ts";
import { dispatch, dispatchCommit } from "../../src/tools/handlers.ts";
import type { CommitDeps, CommitOutcome } from "../../src/transactions/commit.ts";
import { SALES_CONTROL_PLANE_0511_CANDIDATE } from "../../src/versions/adapters/controlPlane.ts";
import { salesContractAdapter } from "../../src/versions/adapters/sales.ts";
import { handleOf, OWNER } from "../unit/binding-fixtures.ts";
import { synthetic, text } from "../unit/meta-fixtures.ts";
import { buildResumeWorld, R, setRowsIn, type ResumeWorld } from "../unit/resume-fixtures.ts";
import { CONTRACT_PAGE, IDS as SALES_IDS, SGRAMMAR, SV } from "../unit/sales-fixtures.ts";
import { declareOptions } from "./transact.ts";

/** 01:30 in Paris on 2030-01-03: D0 is the 3rd, D+1 the 4th, D+2 the 5th. */
export const NOW = new Date("2030-01-03T00:30:00.000Z");
export const DAY = { d0: "2030-01-03", d1: "2030-01-04", d2: "2030-01-05", d4: "2030-01-07" } as const;
export const GUARD_CONTRACT = "TEST_SALES_CONTRACT/1.11.0-candidate";
export const B0_KEY = "B0_DISCOVERY:PRIMARY_OUTCOME";
export const OUTCOME = "Obtenir trois rendez-vous qualifiés par mois";
/** A business text that must never reach an outcome, an evidence line, an event or a log. */
export const SECRET_RULE = "Ne jamais relancer un compte en litige commercial ouvert";
export const SECRET_VALUE = "Plafond confidentiel quarante-deux";
export const TYPE_IDS = { prospection: "opt-prospection", protection: "opt-protection", spoof: "opt-spoof" } as const;

const list = (results: unknown[]) => ({ results, has_more: false, next_cursor: null });
const rt = (s: string) => [text(s)];

export interface GuardIds {
  readonly root: string; readonly constitution: string; readonly indexPage: string; readonly setup: string; readonly cp: string;
  readonly configDb: string; readonly configDs: string; readonly runtimeDb: string; readonly runtimeDs: string;
  readonly rulesDb: string; readonly rulesDs: string; readonly tasksDb: string; readonly tasksDs: string;
}

export const G: GuardIds = {
  root: SALES_IDS("rep-a").root,
  constitution: synthetic("guard-constitution"), indexPage: synthetic("guard-index-page"), setup: synthetic("guard-setup"), cp: R.salesCp,
  configDb: synthetic("guard-config-db"), configDs: synthetic("guard-config-ds"),
  runtimeDb: synthetic("guard-runtime-db"), runtimeDs: synthetic("guard-runtime-ds"),
  rulesDb: synthetic("guard-rules-db"), rulesDs: synthetic("guard-rules-ds"),
  tasksDb: synthetic("guard-tasks-db"), tasksDs: synthetic("guard-tasks-ds"),
};

/** Rows of a guard table: a proven end, and each row reachable by id. */
export function putRows(map: Map<string, unknown>, ds: string, pages: readonly Page[]): void {
  const withParent = pages.map((p) => ({ ...p, parent: p.parent ?? { type: "data_source_id", data_source_id: ds } }));
  map.set(`query:${ds}`, list(withParent));
  for (const p of withParent) map.set(`page:${p.id}`, p);
}
export const rowsOf = (map: Map<string, unknown>, ds: string): Page[] => ((map.get(`query:${ds}`) as { results?: Page[] } | undefined)?.results ?? []);

export function rule(label: string, ruleId: number, o: { active?: boolean; priority?: string; text?: string; disposition?: string | null } = {}): Page {
  const disposition = o.disposition === undefined ? "HOLD" : o.disposition;
  return { object: "page", id: synthetic(`rule:${label}`), archived: false, properties: {
    Rule: { type: "title", title: rt(o.text ?? SECRET_RULE) },
    "Rule ID": { type: "unique_id", unique_id: { prefix: "DR", number: ruleId } },
    Active: { type: "checkbox", checkbox: o.active ?? true },
    Priority: { type: "select", select: { name: o.priority ?? "P0" } },
    "Default Disposition": { type: "select", select: disposition === null ? null : { name: disposition } },
    "Last edited": { type: "last_edited_time", last_edited_time: "2030-01-01T00:00:00.000Z" },
  } };
}

export function constraint(label: string, configId: number, o: { config?: string; type?: string; state?: string; value?: string; effective?: string; pointer?: readonly [string, string, string] } = {}): Page {
  const [res, key, field] = o.pointer ?? ["", "", ""];
  return { object: "page", id: synthetic(`constraint:${label}`), archived: false, properties: {
    Config: { type: "title", title: rt(o.config ?? label) },
    "Config ID": { type: "unique_id", unique_id: { prefix: "RC", number: configId } },
    Type: { type: "select", select: { name: o.type ?? "LOCAL_CONSTRAINT" } },
    State: { type: "select", select: { name: o.state ?? "CONFIRMED" } },
    Value: { type: "rich_text", rich_text: rt(o.value ?? "") },
    "Effective At": { type: "date", date: o.effective ? { start: o.effective } : null },
    "Pointer Resource Key": { type: "rich_text", rich_text: res ? rt(res) : [] },
    "Pointer Natural Key": { type: "rich_text", rich_text: key ? rt(key) : [] },
    "Pointer Value Field": { type: "rich_text", rich_text: field ? rt(field) : [] },
  } };
}
export const timezone = (zone = "Europe/Paris") => constraint("timezone", 1, { config: "TIMEZONE", value: zone });

export function configRow(label: string, key: string, o: { value?: string; state?: string; category?: string; amount?: number | null; version?: string; source?: string } = {}): Page {
  return { object: "page", id: synthetic(`config:${label}`), archived: false, properties: {
    "Config Item": { type: "title", title: rt(key) },
    Category: { type: "select", select: { name: o.category ?? "CONSTRAINT" } },
    State: { type: "select", select: { name: o.state ?? "CONFIRMED" } },
    Value: { type: "rich_text", rich_text: rt(o.value ?? SECRET_VALUE) },
    Version: { type: "rich_text", rich_text: rt(o.version ?? "SALES_INPUT/1") },
    Source: { type: "rich_text", rich_text: rt(o.source ?? "OPERATOR") },
    Amount: { type: "number", number: o.amount === undefined ? 42 : o.amount },
    "Effective At": { type: "date", date: null },
    Notes: { type: "rich_text", rich_text: [] },
  } };
}

export function task(label: string, key: string, o: { type?: keyof typeof TYPE_IDS; due?: string; status?: string } = {}): Page {
  const t = o.type ?? "prospection";
  return { object: "page", id: synthetic(`task:${label}`), archived: false, properties: {
    Task: { type: "title", title: rt(label) },
    "Idempotency Key": { type: "rich_text", rich_text: rt(key) },
    Status: { type: "select", select: { name: o.status ?? "READY" } },
    Type: { type: "select", select: { id: TYPE_IDS[t], name: TYPE_NAMES[t] } },
    "Due Date": { type: "date", date: o.due ? { start: o.due } : null },
    "Runtime ID": { type: "rich_text", rich_text: [] },
  } };
}
export const TYPE_NAMES = { prospection: "PROSPECTION", protection: "RELANCE_PROTEGEE", spoof: "RELANCE PROTEGEE" } as const;

/** The index page's blocks: by default exactly one json code block holding `doc`. */
export function setIndex(map: Map<string, unknown>, doc: unknown, blocks?: readonly unknown[]): void {
  const code = (body: string, language = "json") => ({ object: "block", id: synthetic(`code:${body.length}:${language}`), type: "code", code: { language, rich_text: rt(body) } });
  map.set(`children:${G.indexPage}`, list(blocks ? [...blocks] : [
    { object: "block", id: synthetic("index-intro"), type: "paragraph", paragraph: { rich_text: rt("Production Guard Index") } },
    code(typeof doc === "string" ? doc : JSON.stringify(doc, null, 2)),
  ]));
}
export const codeBlock = (body: string, language = "json", salt = "") => ({ object: "block", id: synthetic(`code:${salt}:${body.length}:${language}`), type: "code", code: { language, rich_text: rt(body) } });

export interface ClassEntry { class: string; resource_key: string; operation: string; allowed_fields: string[]; date_field?: string; type_option_ids?: string[] }
export interface IndexDoc { schema_version: string; revision: number; p0_rules: unknown[]; operation_classes: ClassEntry[] }

/** The writable Tasks fields of the governing catalog, as an operator would list them. */
const TASK_FIELDS = ["Task", "Status", "Type", "Due Date"];
export const CLASSES = {
  b0Answer: { class: "PRODUCTION", resource_key: "SALES:BUSINESS_CONFIG", operation: "CREATE", allowed_fields: ["Category", "State", "Value", "Version", "Source"] },
  cursor: () => ({ class: "PRODUCTION", resource_key: "SALES:OS_STATE", operation: "UPDATE", allowed_fields: [...(SALES_CONTROL_PLANE_0511_CANDIDATE.resources?.["SALES:OS_STATE"]?.writableProperties ?? [])] }),
  taskProduction: { class: "PRODUCTION", resource_key: "SALES:TASKS", operation: "CREATE", allowed_fields: TASK_FIELDS, type_option_ids: [TYPE_IDS.prospection] },
  taskProtectionCreate: { class: "FUTURE_PROTECTION", resource_key: "SALES:TASKS", operation: "CREATE", allowed_fields: TASK_FIELDS, date_field: "Due Date", type_option_ids: [TYPE_IDS.protection] },
  taskProtectionUpdate: { class: "FUTURE_PROTECTION", resource_key: "SALES:TASKS", operation: "UPDATE", allowed_fields: ["Due Date", "Status"], date_field: "Due Date", type_option_ids: [TYPE_IDS.protection] },
  taskReconcile: { class: "RECONCILE_AS_IS", resource_key: "SALES:TASKS", operation: "UPDATE", allowed_fields: TASK_FIELDS },
} as const;

export const index = (p0: unknown[] = [], classes: ClassEntry[] = [CLASSES.b0Answer as unknown as ClassEntry, CLASSES.cursor()]): IndexDoc => ({ schema_version: "SALES_GUARD_INDEX/1", revision: 1, p0_rules: p0, operation_classes: classes });

/** Typed operands and nodes of the index grammar. */
export const ref = (natural_key: string, property = "Value", value_type = "TEXT", authority = "CONTRACT_STATIC", resource_key = "SALES:BUSINESS_CONFIG") => ({ ref: { resource_key, natural_key, property, value_type, authority } });
export const lit = (value: unknown, value_type = typeof value === "number" ? "NUMBER" : typeof value === "boolean" ? "BOOLEAN" : "TEXT") => ({ literal: { value_type, value } });
export const eq = (left: unknown, right: unknown) => ({ op: "EQUAL", left, right });
export const p0 = (rule_id: number, predicate: unknown) => ({ rule_id, predicate });

export interface GuardWorld {
  readonly w: ResumeWorld;
  readonly map: Map<string, unknown>;
  readonly client: FixtureNotionClient;
  readonly clock: { t: number };
  readonly deps: CommitDeps;
  /** Reads pass through here: tests may intercept one data source. */
  intercept(ds: string, answer: (original: unknown) => unknown): void;
  bind(): Promise<string>;
  approve(): Promise<string>;
  commit(h: string, input: Record<string, unknown>, over?: Partial<CommitDeps>): Promise<CommitOutcome & { say: string }>;
}

/**
 * The world: rep A's runtime on the 0.5.11 candidate line, the cursor on B0_DISCOVERY, the zone Europe/Paris, one
 * guard index (default: no P0, the B0 answer and its cursor movement as PRODUCTION), no approval yet.
 */
export function guardWorld(o: { gate?: string; doc?: unknown; rules?: Page[]; constraints?: Page[]; configs?: Page[]; tasks?: Page[] } = {}): GuardWorld {
  const w = buildResumeWorld();
  const map = w.map;
  w.deps.adapters.salesRuntime.register(GUARD_CONTRACT, salesContractAdapter(GUARD_CONTRACT, [SV.schema], { ...SGRAMMAR, controlPlane: SALES_CONTROL_PLANE_0511_CANDIDATE }));
  const ids = SALES_IDS("rep-a");
  const manifest = map.get(`page:${ids.manifestRow}`) as Page;
  setRowsIn(map, ids.manifestDs, [{ ...manifest, properties: { ...manifest.properties, "Sales Contract Version": { type: "rich_text", rich_text: rt(GUARD_CONTRACT) } } }]);
  map.set(`page:${CONTRACT_PAGE}`, { object: "page", id: CONTRACT_PAGE, archived: false, properties: { title: { type: "title", title: rt(GUARD_CONTRACT) } } });

  // The cursor: the live OS State schema and the B0 step.
  const liveState = map.get(`data_source:${R.salesStateDs}`) as { properties: Record<string, unknown> };
  map.set(`data_source:${R.salesStateDs}`, { properties: { ...liveState.properties, "Gate Passed By Run Ref": { type: "rich_text" }, "Last Durable Mode": { type: "select" }, "Last Durable Turn ID": { type: "rich_text" }, "Next Authorized Topic": { type: "rich_text" } } });
  const gate = o.gate ?? "B0_DISCOVERY";
  w.setSalesState({ gate, buildState: gate, nextAction: "Cadrer le résultat commercial prioritaire", nextQuestion: "Quel résultat commercial concret veux-tu obtenir en priorité ?" });

  // Structure: constitution (index page), setup (Business + Runtime Configuration), control plane (+ Decision Rules, Tasks).
  const rootChildren = ((map.get(`children:${G.root}`) as { results: Array<{ type?: string; child_page?: { title?: string } }> }).results)
    .filter((b) => !["01 — CONSTITUTION & POLICIES", "02 — SETUP & BUSINESS CONFIG"].includes(b.child_page?.title ?? ""));
  map.set(`children:${G.root}`, list([...rootChildren,
    { object: "block", id: G.constitution, type: "child_page", child_page: { title: "01 — CONSTITUTION & POLICIES" } },
    { object: "block", id: G.setup, type: "child_page", child_page: { title: "02 — SETUP & BUSINESS CONFIG" } },
  ]));
  map.set(`children:${G.constitution}`, list([
    { object: "block", id: G.indexPage, type: "child_page", child_page: { title: "Production Guard Index" } },
    { object: "block", id: synthetic("guard-policies-db"), type: "child_database", child_database: { title: "Active Policies" } },
  ]));
  map.set(`page:${G.indexPage}`, { object: "page", id: G.indexPage, archived: false, parent: { type: "page_id", page_id: G.constitution }, properties: { title: { type: "title", title: rt("Production Guard Index") } } });
  setIndex(map, o.doc ?? index());
  map.set(`children:${G.setup}`, list([
    { object: "block", id: G.configDb, type: "child_database", child_database: { title: "Business Configuration" } },
    { object: "block", id: G.runtimeDb, type: "child_database", child_database: { title: "Runtime Configuration" } },
  ]));
  const cpChildren = (map.get(`children:${G.cp}`) as { results: unknown[] }).results;
  map.set(`children:${G.cp}`, list([...cpChildren,
    { object: "block", id: G.rulesDb, type: "child_database", child_database: { title: "Decision Rules" } },
    { object: "block", id: G.tasksDb, type: "child_database", child_database: { title: "Tasks" } },
  ]));
  const opts = (names: readonly string[]) => ({ options: names.map((n) => ({ id: `opt-${n.toLowerCase()}`, name: n })) });
  for (const [db, ds] of [[G.configDb, G.configDs], [G.runtimeDb, G.runtimeDs], [G.rulesDb, G.rulesDs], [G.tasksDb, G.tasksDs]] as const) map.set(`database:${db}`, { object: "database", id: db, data_sources: [{ id: ds }] });
  // Business Configuration categories: the fixture's own, plus every category the candidate walk records (B0…B6).
  const walkCategories = (SALES_CONTROL_PLANE_0511_CANDIDATE.cursorTransitions ?? []).map((t) => t.evidence.equals["Category"]).filter((c): c is string => typeof c === "string");
  map.set(`data_source:${G.configDs}`, { properties: {
    "Config Item": { type: "title" }, Category: { type: "select", select: opts([...new Set(["GOAL", "CONSTRAINT", "OTHER", ...walkCategories])]) }, State: { type: "select", select: opts(["CONFIRMED", "HYPOTHESIS"]) },
    Value: { type: "rich_text" }, Version: { type: "rich_text" }, Source: { type: "rich_text" }, Amount: { type: "number" }, "Effective At": { type: "date" }, Notes: { type: "rich_text" },
  } });
  map.set(`data_source:${G.runtimeDs}`, { properties: {
    Config: { type: "title" }, "Config ID": { type: "unique_id" }, Type: { type: "select", select: opts(["LOCAL_CONSTRAINT", "PRODUCTION_CONTRACT_POINTER"]) }, State: { type: "select", select: opts(["CONFIRMED", "DRAFT"]) },
    Value: { type: "rich_text" }, "Effective At": { type: "date" }, "Pointer Resource Key": { type: "rich_text" }, "Pointer Natural Key": { type: "rich_text" }, "Pointer Value Field": { type: "rich_text" },
  } });
  map.set(`data_source:${G.rulesDs}`, { properties: {
    Rule: { type: "title" }, "Rule ID": { type: "unique_id" }, Active: { type: "checkbox" }, Priority: { type: "select", select: opts(["P0", "P1", "P2"]) }, "Default Disposition": { type: "select", select: opts(["HOLD", "WARN", "ESCALATE"]) }, "Last edited": { type: "last_edited_time" },
  } });
  map.set(`data_source:${G.tasksDs}`, { properties: {
    Task: { type: "title" }, "Idempotency Key": { type: "rich_text" }, Status: { type: "select", select: opts(["READY", "IN_PROGRESS", "BLOCKED", "DONE"]) },
    Type: { type: "select", select: { options: (Object.keys(TYPE_IDS) as Array<keyof typeof TYPE_IDS>).map((k) => ({ id: TYPE_IDS[k], name: TYPE_NAMES[k] })) } },
    "Due Date": { type: "date" }, "Runtime ID": { type: "rich_text" },
  } });
  putRows(map, G.configDs, o.configs ?? []);
  putRows(map, G.runtimeDs, o.constraints ?? [timezone()]);
  putRows(map, G.rulesDs, o.rules ?? []);
  putRows(map, G.tasksDs, o.tasks ?? []);
  for (const d of [R.salesRunsDs, R.salesLedgerDs]) declareOptions(map, d);
  // OS State enumerations the cursor movement writes.
  const state = map.get(`data_source:${R.salesStateDs}`) as { properties: Record<string, { type: string }> };
  const gates = ["B0_DISCOVERY", "B1_OFFER", "B2_ICP", "B3_DATA", "B4_QUALIFICATION", "B5_OUTREACH", "B6_AUTHORITY", "B7_DRY_RUN"];
  const enumOf: Record<string, readonly string[]> = { "Current Gate": gates, "Build State": gates, "Current Gate Status": ["OPEN", "PASSED", "BLOCKED"], "Persistence Health": ["PASS", "FAIL"], "Last Durable Mode": ["INTAKE", "DAILY"] };
  map.set(`data_source:${R.salesStateDs}`, { properties: Object.fromEntries(Object.entries(state.properties).map(([k, v]) => [k, v.type === "select" ? { ...v, select: { options: (enumOf[k] ?? []).map((n) => ({ name: n })) } } : v])) });

  const clock = { t: NOW.getTime() };
  const client = new FixtureNotionClient(map, { now: () => new Date(clock.t) });
  const intercepts = new Map<string, (original: unknown) => unknown>();
  const reads: NotionClient = {
    retrievePage: (id) => client.retrievePage(id),
    retrieveDatabase: (id) => client.retrieveDatabase(id),
    retrieveDataSource: (id) => client.retrieveDataSource(id),
    retrieveBlockChildren: (id) => client.retrieveBlockChildren(id),
    queryDataSource: async (ds, filter, cursor, options) => { const original = await client.queryDataSource(ds); const f = intercepts.get(ds); return f ? f(original) : original; void filter; void cursor; void options; },
    createPage: (ds, props, ctx) => client.createPage(ds, props, ctx),
    updatePage: (id, props, ctx) => client.updatePage(id, props, ctx),
  };
  const deps: CommitDeps = { ...w.deps, notion: reads, notionWriter: client, clock: () => new Date(clock.t), sleep: async () => {} };
  const self: GuardWorld = {
    w, map, client, clock, deps,
    intercept(ds, answer) { intercepts.set(ds, answer); },
    async bind() { return handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, { principal_id: OWNER.principal_id, now: new Date(clock.t) }, deps)); },
    async approve() {
      const preview = await approveGuard(deps, { principal_id: OWNER.principal_id, project: "VERTIGO", operator_id: "operator-test", now: new Date(clock.t) });
      assert.equal(preview.kind, "PREVIEW", JSON.stringify(preview));
      const digest = (preview as { digest_sha256: string }).digest_sha256;
      const approved = await approveGuard(deps, { principal_id: OWNER.principal_id, project: "VERTIGO", operator_id: "operator-test", approve_digest: digest, now: new Date(clock.t) });
      assert.equal(approved.kind, "APPROVED", JSON.stringify(approved));
      return digest;
    },
    commit: (h, input, over = {}) => dispatchCommit({ binding_handle: h, ...input }, { principal_id: OWNER.principal_id, now: new Date(clock.t) }, { ...deps, ...over }),
  };
  return self;
}

/** The B0 answer intent exactly as the capture step writes it. */
export const b0Intent = (value = OUTCOME) => ({ intent: { action_class: "COMMIT", summary: "persist the B0 answer", mutations: [{ logical_resource_key: "SALES:BUSINESS_CONFIG", operation: "CREATE", record_selector: { natural_key: B0_KEY }, desired_changes: { Category: "GOAL", State: "CONFIRMED", Value: value, Version: "SALES_INPUT/1", Source: "CHAT_USER_EXPLICIT" } }] } });

/** One Task, created or updated through os_commit. */
export const taskIntent = (operation: "CREATE" | "UPDATE", key: string, changes: Record<string, unknown>, o: { action_class?: string; summary?: string } = {}) =>
  ({ intent: { action_class: o.action_class ?? "COMMIT", summary: o.summary ?? "one task", mutations: [{ logical_resource_key: "SALES:TASKS", operation, record_selector: { natural_key: key }, desired_changes: changes }] } });
