/**
 * The Production Guard snapshot of one bound Sales runtime at one instant T-0 (Sales 0.5.11 candidate, W3.1R).
 *
 * It reads EVERY guard row, following pagination to a proven end — never the DAILY window of 10+1 — and fails as a
 * whole when anything cannot be proven: a truncated page, an ambiguous identity, an absent value, a property of an
 * unexpected type. A failed snapshot allows no approval and no comparison. What it reads:
 *  - the index: the single child page of the constitution page holding exactly one `json` code block, parsed;
 *  - every governing P0 Decision Rule (Active, Priority P0, Default Disposition HOLD), all of its governing properties;
 *  - every Runtime Configuration constraint in effect at T-0, and for each declared pointer its W2.3 re-read status
 *    and the static target it names;
 *  - for every predicate `ref`: its reference and authority, and — only for CONTRACT_STATIC sources of the read
 *    allowlist — the one row its natural key identifies and the typed value of its property.
 *
 * The digested part holds identities, typed values and texts exactly as Notion returns them (rich text concatenated,
 * no trim, no Unicode normalization); rows sorted by physical page id, properties by name. Nothing here writes, and
 * no reason carries a value: reasons name structure only.
 */
import type { RereadStatus } from "../contractPack/dailySources.ts";
import type { NotionReadClient } from "../notion/readClient.ts";
import { StructureCache } from "../notion/structureCache.ts";
import { normalizeId, plainText, type Block, type Page, type RichText } from "../notion/shapes.ts";
import type { ResolvedRuntime } from "../resolvers/types.ts";
import type { ProductionGuardSpec, ResourceSpec } from "../versions/adapters/controlPlane.ts";
import type { Canonical } from "./canonical.ts";
import { digestOf } from "./canonical.ts";
import { parseGuardIndex, refsOf, type GuardIndex, type RefOperand, type ValueType } from "./index.ts";

/** Revision 2 binds approval to the factory-only capability CREATE reconciliation semantics (W4.7R3). */
export const GUARD_SNAPSHOT_VERSION = "SALES_GUARD_SNAPSHOT/2";
/** The plugin line whose build target carries the guard (PLUGIN_SPEC/0.5.0 candidate). */
export const GUARD_PLUGIN_SPEC = "PLUGIN_SPEC/0.5.0-candidate";
const CONSTRAINT_TYPES = ["LOCAL_CONSTRAINT", "PRODUCTION_CONTRACT_POINTER"] as const;
const POINTER_COLUMNS = ["Pointer Resource Key", "Pointer Natural Key", "Pointer Value Field"] as const;
/** Pagination ceiling of one guard source: beyond it the read is not proven complete. */
const MAX_REQUESTS = 50;
/** Metadata Notion maintains by itself: never governing, excluded from the digest. */
const SYSTEM_TYPES = new Set(["created_time", "last_edited_time", "created_by", "last_edited_by"]);

/** The human label of what could not be proven (MissingFact). Never an id, never a value. */
export type GuardSourceLabel =
  | "Index de garde de production"
  | "Règles P0 actives"
  | "Configuration d'exécution"
  | "Sources des prédicats P0";

export interface RefReading {
  readonly ref: RefOperand;
  /** False when the source is outside CONTRACT_STATIC / the read allowlist / the bound scope: the leaf is UNKNOWN. */
  readonly readable: boolean;
  /** Present when readable: the typed value, and whether it is confirmed and in effect at T-0. */
  readonly value?: string | number | boolean;
  readonly known?: boolean;
}

export interface GuardSnapshot {
  readonly t0: Date;
  readonly digest: string;
  readonly canonical: Canonical;
  readonly index: GuardIndex;
  readonly index_page_id: string;
  readonly p0_rule_ids: readonly number[];
  /** Effective constraints by Config ID, with the W2.3 status of their pointer. */
  readonly constraints: ReadonlyMap<number, { readonly type: string; readonly status: RereadStatus }>;
  readonly refs: ReadonlyMap<string, RefReading>;
  /** The instance's confirmed IANA zone, when exactly one confirmed TIMEZONE constraint is in effect. */
  readonly zone?: string;
  /** Records the guard reads: os_commit may never write them. */
  readonly guarded: readonly { readonly resource_key: string; readonly natural_key: string }[];
  /** Physical pages the guard reads (index, pointed targets, predicate sources): never a write target either. */
  readonly guarded_pages: ReadonlySet<string>;
}

export type SnapshotOutcome =
  | { readonly ok: true; readonly snapshot: GuardSnapshot }
  | { readonly ok: false; readonly source: GuardSourceLabel; readonly reason: string };

class Unproven extends Error {
  readonly source: GuardSourceLabel;
  constructor(source: GuardSourceLabel, reason: string) { super(reason); this.source = source; }
}
const unproven = (source: GuardSourceLabel, reason: string): never => { throw new Unproven(source, reason); };

export const refKey = (r: RefOperand): string => JSON.stringify([r.resource_key, r.natural_key, r.property, r.value_type, r.authority]);

// ─────────────────────────────── strict reads ───────────────────────────────

/** Every child block, to a proven end. */
async function children(client: NotionReadClient, blockId: string, source: GuardSourceLabel): Promise<Block[]> {
  const out: Block[] = [];
  let cursor: string | undefined;
  for (let request = 0; request < MAX_REQUESTS; request += 1) {
    const page = (await client.retrieveBlockChildren(blockId, cursor)) as { results?: unknown; has_more?: unknown; next_cursor?: unknown } | undefined;
    if (!Array.isArray(page?.results)) return unproven(source, "a block list is unreadable");
    out.push(...(page.results as Block[]));
    if (page.has_more === false && page.next_cursor == null) return out;
    if (page.has_more !== true || typeof page.next_cursor !== "string" || page.next_cursor === "") return unproven(source, "a block list does not prove its end");
    cursor = page.next_cursor;
  }
  return unproven(source, "a block list exceeds the pagination ceiling");
}

/** Every row a query returns, to a proven end; archived rows are not part of a database. Filters are re-checked by callers. */
async function rows(client: NotionReadClient, ds: string, filter: unknown, source: GuardSourceLabel): Promise<Page[]> {
  const out: Page[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let request = 0; request < MAX_REQUESTS; request += 1) {
    const q = (await client.queryDataSource(ds, filter, cursor, { page_size: 100 })) as { results?: unknown; has_more?: unknown; next_cursor?: unknown } | undefined;
    if (!Array.isArray(q?.results)) return unproven(source, "a query is unreadable");
    for (const p of q.results as Page[]) {
      const id = normalizeId(p?.id);
      if (!id || seen.has(id)) return unproven(source, "a query returns a row twice or without identity");
      seen.add(id);
      const parent = normalizeId(p.parent?.data_source_id) ?? normalizeId(p.parent?.database_id);
      if (parent !== ds) return unproven(source, "a query returns a row of another data source");
      if (p.archived !== true && p.in_trash !== true) out.push(p);
    }
    if (q.has_more === false && q.next_cursor == null) return out;
    if (q.has_more !== true || typeof q.next_cursor !== "string" || q.next_cursor === "") return unproven(source, "a query does not prove its end");
    cursor = q.next_cursor;
  }
  return unproven(source, "a query exceeds the pagination ceiling");
}

const childTitle = (b: Block, kind: "child_page" | "child_database"): string | undefined => (b.type === kind ? ((b[kind] as { title?: unknown } | undefined)?.title as string | undefined) : undefined);

/** The one page titled `title` directly under `holder`. */
async function onePage(client: NotionReadClient, holder: string, title: string, source: GuardSourceLabel): Promise<string> {
  const found = (await children(client, holder, source)).filter((b) => (childTitle(b, "child_page") ?? "").trim() === title);
  if (found.length !== 1) return unproven(source, `expected exactly one page "${title}", found ${found.length}`);
  return normalizeId((found[0] as Block).id) ?? unproven(source, "a page has no identity");
}

interface Table { readonly ds: string; readonly types: ReadonlyMap<string, string>; readonly raw: Readonly<Record<string, { type?: string; [k: string]: unknown }>> }

/** A database under `parentTitle` of the runtime root, its single data source and its schema. */
async function table(client: NotionReadClient, root: string, parentTitle: string | undefined, databaseTitle: string, source: GuardSourceLabel): Promise<Table> {
  const holder = parentTitle ? await onePage(client, root, parentTitle, source) : root;
  const dbs = (await children(client, holder, source)).filter((b) => (childTitle(b, "child_database") ?? "").trim() === databaseTitle);
  if (dbs.length !== 1) return unproven(source, `expected exactly one database "${databaseTitle}", found ${dbs.length}`);
  const db = (await client.retrieveDatabase(normalizeId((dbs[0] as Block).id) as string)) as { data_sources?: ReadonlyArray<{ id?: string }> } | undefined;
  const sources = db?.data_sources ?? [];
  if (sources.length !== 1) return unproven(source, `"${databaseTitle}" does not have exactly one data source`);
  const ds = normalizeId(sources[0]?.id) ?? unproven(source, `"${databaseTitle}" has a data source without identity`);
  const schema = (await client.retrieveDataSource(ds)) as { properties?: Record<string, { type?: string }> } | undefined;
  if (!schema?.properties) return unproven(source, `"${databaseTitle}" has no readable schema`);
  return { ds, types: new Map(Object.entries(schema.properties).map(([k, v]) => [k, v.type ?? "unknown"])), raw: schema.properties };
}

function requireTypes(t: Table, wanted: Readonly<Record<string, readonly string[]>>, source: GuardSourceLabel, what: string): void {
  for (const [name, types] of Object.entries(wanted)) if (!types.includes(t.types.get(name) ?? "")) unproven(source, `${what}: "${name}" is absent or of an unexpected type`);
}

// ─────────────────────────────── typed cells ───────────────────────────────

type Prop = { type: string; [k: string]: unknown };
const propOf = (p: Page, name: string): Prop | undefined => p.properties[name] as Prop | undefined;

/** Exact text of a text-like cell, as Notion returns it; `undefined` for any other type. */
function textCell(p: Page, name: string): string | undefined {
  const v = propOf(p, name);
  if (!v) return undefined;
  switch (v.type) {
    case "title": case "rich_text": return plainText(v[v.type] as readonly RichText[] | undefined);
    case "select": case "status": return ((v[v.type] as { name?: string } | null | undefined)?.name) ?? "";
    case "url": case "email": case "phone_number": return (v[v.type] as string | null | undefined) ?? "";
    default: return undefined;
  }
}

/** Typed encoding of every governing property of a row. An unsupported type makes the snapshot invalid. */
function encodeRow(p: Page, source: GuardSourceLabel): Canonical {
  const props: Record<string, Canonical> = {};
  for (const [name, raw] of Object.entries(p.properties)) {
    const v = raw as Prop;
    if (SYSTEM_TYPES.has(v.type)) continue;
    let value: Canonical;
    switch (v.type) {
      case "title": case "rich_text": value = plainText(v[v.type] as readonly RichText[] | undefined); break;
      case "select": case "status": value = ((v[v.type] as { name?: string } | null | undefined)?.name) ?? null; break;
      case "multi_select": value = ((v["multi_select"] as ReadonlyArray<{ name?: string }> | undefined) ?? []).map((o) => o.name ?? unproven(source, "a multi-select option has no name")); break;
      case "number": { const n = v["number"]; value = typeof n === "number" && Number.isFinite(n) ? n : n === null || n === undefined ? null : unproven(source, "a number cell is not a number"); break; }
      case "checkbox": value = typeof v["checkbox"] === "boolean" ? v["checkbox"] : unproven(source, "a checkbox cell is not a boolean"); break;
      case "date": { const d = v["date"] as { start?: string; end?: string | null; time_zone?: string | null } | null | undefined; value = d ? { start: d.start ?? unproven(source, "a date cell has no start"), end: d.end ?? null, time_zone: d.time_zone ?? null } : null; break; }
      case "url": case "email": case "phone_number": value = (v[v.type] as string | null | undefined) ?? null; break;
      case "unique_id": { const u = v["unique_id"] as { prefix?: string | null; number?: number } | undefined; value = u && typeof u.number === "number" ? { prefix: u.prefix ?? null, number: u.number } : unproven(source, "a unique id cell is unreadable"); break; }
      case "relation": value = ((v["relation"] as ReadonlyArray<{ id?: string }> | undefined) ?? []).map((r) => normalizeId(r.id) ?? unproven(source, "a relation has no identity")).sort(); break;
      default: return unproven(source, `a governing property has the unsupported type ${v.type}`);
    }
    props[name] = { type: v.type, value };
  }
  return { page_id: normalizeId(p.id) as string, properties: props };
}

const uniqueIdOf = (p: Page, name: string): number | undefined => {
  const v = propOf(p, name);
  const n = v?.type === "unique_id" ? (v["unique_id"] as { number?: unknown } | undefined)?.number : undefined;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : undefined;
};
const byPageId = <T extends { readonly id: string }>(a: T, b: T) => ((normalizeId(a.id) as string) < (normalizeId(b.id) as string) ? -1 : 1);

// ─────────────────────────────── dates and zone ───────────────────────────────

/** Civil day (YYYY-MM-DD) of an instant in an IANA zone. */
export function civilDay(ms: number, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
export function validZone(name: string | undefined): string | undefined {
  if (!name || name !== name.trim() || !name.includes("/")) return undefined;
  try { new Intl.DateTimeFormat("en-CA", { timeZone: name }); return name; } catch { return undefined; }
}
const BARE_DAY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Whether a date cell is in effect at T-0: empty ⇒ yes; an instant ⇒ reached; a bare day ⇒ reached in the zone. Undecidable ⇒ undefined. */
function inEffect(p: Page, name: string, t0: number, zone: string | undefined): boolean | undefined {
  const v = propOf(p, name);
  if (!v) return true;
  if (v.type !== "date") return undefined;
  const d = v["date"] as { start?: string; end?: string | null } | null | undefined;
  if (!d) return true;
  if (!d.start || d.end) return undefined;
  if (INSTANT.test(d.start)) return Date.parse(d.start) <= t0;
  if (BARE_DAY.test(d.start)) return zone ? d.start <= civilDay(t0, zone) : undefined;
  return undefined;
}

// ─────────────────────────────── the snapshot ───────────────────────────────

export interface SnapshotInput {
  readonly client: NotionReadClient;
  readonly runtime: ResolvedRuntime;
  readonly spec: ProductionGuardSpec;
  readonly t0: Date;
  /** The approved index page; absent only for the operator's first discovery. */
  readonly indexPageId?: string;
}

export async function readGuardSnapshot(input: SnapshotInput): Promise<SnapshotOutcome> {
  try {
    // One fresh reader per guard check, never shared with preparation or the next byte check.
    // Deduplicate structure within this T-0; pages and queries still reach the source every time.
    return { ok: true, snapshot: await build({ ...input, client: new StructureCache(input.client) }) };
  } catch (err) {
    if (err instanceof Unproven) return { ok: false, source: err.source, reason: err.message };
    // A read that throws is never echoed: its message could name a stored value.
    return { ok: false, source: "Index de garde de production", reason: "a guard source could not be read" };
  }
}

async function build({ client, runtime, spec, t0, indexPageId }: SnapshotInput): Promise<GuardSnapshot> {
  const root = normalizeId(runtime.root_ref) ?? unproven("Index de garde de production", "the bound runtime has no root");
  const ms = t0.getTime();

  // 1. The index: one child page of the constitution page, exactly one json code block, no other declaring page.
  const INDEX: GuardSourceLabel = "Index de garde de production";
  const constitution = await onePage(client, root, spec.indexParentTitle, INDEX);
  const pages = (await children(client, constitution, INDEX)).filter((b) => b.type === "child_page");
  const codeOf = async (id: string) => (await children(client, id, INDEX)).filter((b) => b.type === "code");
  const codeText = (b: Block) => plainText(((b["code"] as { rich_text?: readonly RichText[] } | undefined)?.rich_text));
  const declaring: string[] = [];
  const codeByPage = new Map<string, Block[]>();
  for (const b of pages) {
    const id = normalizeId(b.id) as string;
    const code = await codeOf(id);
    codeByPage.set(id, code);
    if (code.some((c) => codeText(c).includes(spec.schemaVersion))) declaring.push(id);
  }
  const wanted = indexPageId ? normalizeId(indexPageId) : declaring[0];
  if (!wanted || pages.filter((b) => normalizeId(b.id) === wanted).length !== 1) unproven(INDEX, "the index page is not exactly one child page of the constitution page");
  if (declaring.length !== 1 || declaring[0] !== wanted) unproven(INDEX, `the index page is ambiguous: ${declaring.length} child pages declare the index grammar`);
  const indexPage = (await client.retrievePage(wanted as string)) as Page | undefined;
  if (!indexPage || indexPage.archived === true || indexPage.in_trash === true || normalizeId(indexPage.parent?.page_id) !== constitution) unproven(INDEX, "the index page is not a live child of the constitution page");
  const blocks = codeByPage.get(wanted as string) ?? [];
  if (blocks.length !== 1) unproven(INDEX, `the index page holds ${blocks.length} code blocks instead of exactly one`);
  const block = blocks[0] as Block;
  if ((block["code"] as { language?: unknown } | undefined)?.language !== "json") unproven(INDEX, "the index code block is not of language json");
  let document: unknown;
  try { document = JSON.parse(codeText(block)); } catch { return unproven(INDEX, "the index block is not valid JSON"); }
  const parsed = parseGuardIndex(document, spec.schemaVersion);
  if (!parsed.ok) return unproven(INDEX, `the index is invalid: ${parsed.reason}`);

  // 2. Every governing P0 Decision Rule: Active, Priority P0 AND Default Disposition HOLD — and only those. Every
  //    active P0 row is read so that an absent, empty or mistyped disposition is refused, never silently skipped.
  const RULES: GuardSourceLabel = "Règles P0 actives";
  const rules = await table(client, root, spec.decisionRules.parentTitle, spec.decisionRules.databaseTitle, RULES);
  requireTypes(rules, { Active: ["checkbox"], Priority: ["select", "status"], "Default Disposition": ["select"], "Rule ID": ["unique_id"] }, RULES, "Decision Rules");
  const priorityKind = rules.types.get("Priority") as string;
  const p0 = (await rows(client, rules.ds, { and: [{ property: "Active", checkbox: { equals: true } }, { property: "Priority", [priorityKind]: { equals: "P0" } }] }, RULES))
    .filter((r) => propOf(r, "Active")?.["checkbox"] === true && textCell(r, "Priority") === "P0")
    .filter((r) => {
      const d = propOf(r, "Default Disposition");
      if (d?.type !== "select") return unproven(RULES, "an active P0 rule's \"Default Disposition\" is absent or of an unexpected type");
      const name = (d["select"] as { name?: unknown } | null | undefined)?.name;
      if (typeof name !== "string" || name === "") return unproven(RULES, "an active P0 rule has no Default Disposition");
      return name === "HOLD";
    })
    .sort(byPageId);
  const ruleIds = p0.map((r) => uniqueIdOf(r, "Rule ID") ?? unproven(RULES, "an active P0 rule has no Rule ID"));
  if (new Set(ruleIds).size !== ruleIds.length) unproven(RULES, "two active P0 rules share a Rule ID");

  // 3. Runtime Configuration: the instance zone, then every constraint in effect at T-0.
  const CONFIG: GuardSourceLabel = "Configuration d'exécution";
  const config = await table(client, root, spec.runtimeConfiguration.parentTitle, spec.runtimeConfiguration.databaseTitle, CONFIG);
  requireTypes(config, { Config: ["title", "rich_text"], "Config ID": ["unique_id"], Type: ["select", "status"], State: ["select", "status"], Value: ["rich_text", "title"] }, CONFIG, "Runtime Configuration");
  if (config.types.has("Effective At") && config.types.get("Effective At") !== "date") unproven(CONFIG, "Runtime Configuration: \"Effective At\" is not a date");
  const configKind = config.types.get("Config") as string;
  const zoneRows = (await rows(client, config.ds, { property: "Config", [configKind]: { equals: "TIMEZONE" } }, CONFIG)).filter((r) => textCell(r, "Config") === "TIMEZONE");
  let zone: string | undefined;
  if (zoneRows.length === 1) {
    const z = zoneRows[0] as Page;
    const d = (propOf(z, "Effective At")?.["date"] as { start?: string } | null | undefined)?.start;
    const immediate = d === undefined || (INSTANT.test(d) && Date.parse(d) <= ms);
    if (textCell(z, "Type") === "LOCAL_CONSTRAINT" && textCell(z, "State") === "CONFIRMED" && immediate) zone = validZone(textCell(z, "Value"));
  }
  const typeKind = config.types.get("Type") as string;
  const stateKind = config.types.get("State") as string;
  const candidates = (await rows(client, config.ds, { and: [{ property: "State", [stateKind]: { equals: "CONFIRMED" } }, { or: CONSTRAINT_TYPES.map((t) => ({ property: "Type", [typeKind]: { equals: t } })) }] }, CONFIG))
    .filter((r) => textCell(r, "State") === "CONFIRMED" && (CONSTRAINT_TYPES as readonly string[]).includes(textCell(r, "Type") ?? ""));
  const effective: Page[] = [];
  for (const r of candidates) {
    const e = inEffect(r, "Effective At", ms, zone);
    if (e === undefined) unproven(CONFIG, "a constraint's Effective At is undecidable");
    if (e) effective.push(r);
  }
  effective.sort(byPageId);
  const configIds = effective.map((r) => uniqueIdOf(r, "Config ID") ?? unproven(CONFIG, "a constraint has no Config ID"));
  if (new Set(configIds).size !== configIds.length) unproven(CONFIG, "two constraints share a Config ID");

  // 4. The W2.3 re-read of each declared pointer, at the only admitted source.
  const guarded: { resource_key: string; natural_key: string }[] = [];
  const guardedPages = new Set<string>([wanted as string]);
  const pointerSpec = runtime.adapter.controlPlane.resources?.[spec.pointer.resourceKey];
  let pointerTable: Promise<Table | undefined> | undefined;
  const openPointer = () => (pointerTable ??= (async () => {
    if (!pointerSpec || (pointerSpec.scope ?? "RUNTIME") !== "RUNTIME" || pointerSpec.naturalKeyProperty !== spec.pointer.naturalKeyProperty) return undefined;
    try {
      const t = await table(client, root, pointerSpec.parentTitle, pointerSpec.databaseTitle, CONFIG);
      if (t.types.get(spec.pointer.naturalKeyProperty) !== "title" || t.types.get(spec.pointer.valueField) !== "rich_text" || !["select", "status"].includes(t.types.get("State") ?? "")) return undefined;
      if (t.types.has("Effective At") && t.types.get("Effective At") !== "date") return undefined;
      return t;
    } catch { return undefined; }
  })());
  const constraints = new Map<number, { type: string; status: RereadStatus }>();
  const pointerTargets: Canonical[] = [];
  for (const [i, r] of effective.entries()) {
    const triplet = POINTER_COLUMNS.map((c) => (config.types.has(c) ? textCell(r, c) ?? "" : ""));
    const filled = triplet.filter((v) => v.trim() !== "").length;
    const [resource, naturalKey, field] = triplet as [string, string, string];
    let status: RereadStatus;
    let target: Page | undefined;
    if (filled === 0) status = "NO_POINTER";
    else if (filled !== 3 || resource !== spec.pointer.resourceKey || field !== spec.pointer.valueField || naturalKey !== naturalKey.trim()) status = "INVALID";
    else {
      guarded.push({ resource_key: resource, natural_key: naturalKey });
      const t = await openPointer();
      let found: Page[] | undefined;
      if (t) {
        try { found = (await rows(client, t.ds, { property: spec.pointer.naturalKeyProperty, title: { equals: naturalKey } }, CONFIG)).filter((p) => textCell(p, spec.pointer.naturalKeyProperty) === naturalKey); } catch { found = undefined; }
      }
      if (!t || !found) status = "UNREADABLE";
      else if (found.length === 0) status = "MISSING";
      else if (found.length > 1) status = "AMBIGUOUS";
      else {
        target = found[0] as Page;
        guardedPages.add(normalizeId(target.id) as string);
        const e = inEffect(target, "Effective At", ms, zone);
        status = textCell(target, "State") !== "CONFIRMED" || e !== true ? "INVALID" : (textCell(target, spec.pointer.valueField) ?? "") === (textCell(r, "Value") ?? "") ? "MATCH" : "DRIFT";
      }
    }
    constraints.set(configIds[i] as number, { type: textCell(r, "Type") as string, status });
    pointerTargets.push({ config_page_id: normalizeId(r.id) as string, status, target_page_id: target ? (normalizeId(target.id) as string) : null, target_value: target ? (textCell(target, spec.pointer.valueField) ?? "") : null });
  }

  // 5. Predicate sources: references and authorities always; values only for readable CONTRACT_STATIC sources.
  const REFS: GuardSourceLabel = "Sources des prédicats P0";
  const refs = new Map<string, RefReading>();
  const sources: Canonical[] = [];
  const tables = new Map<string, Table>();
  for (const ref of refsOf(parsed.index)) {
    const key = refKey(ref);
    if (refs.has(key)) continue;
    guarded.push({ resource_key: ref.resource_key, natural_key: ref.natural_key });
    const rs = runtime.adapter.controlPlane.resources?.[ref.resource_key];
    const readable = ref.authority === "CONTRACT_STATIC" && spec.staticSources.includes(ref.resource_key) && ref.resource_key.startsWith(`${runtime.lane}:`) && rs !== undefined && (rs.scope ?? "RUNTIME") === "RUNTIME";
    const identity: Canonical = { resource_key: ref.resource_key, natural_key: ref.natural_key, property: ref.property, value_type: ref.value_type, authority: ref.authority };
    if (!readable) {
      refs.set(key, { ref, readable: false });
      sources.push({ ref: identity, readable: false });
      continue;
    }
    const spec2 = rs as ResourceSpec;
    const t = tables.get(ref.resource_key) ?? await table(client, root, spec2.parentTitle, spec2.databaseTitle, REFS);
    tables.set(ref.resource_key, t);
    const keyType = t.types.get(spec2.naturalKeyProperty);
    if (keyType !== "title" && keyType !== "rich_text") unproven(REFS, "a predicate source has no text natural key");
    const hits = (await rows(client, t.ds, { property: spec2.naturalKeyProperty, [keyType as string]: { equals: ref.natural_key } }, REFS)).filter((p) => textCell(p, spec2.naturalKeyProperty) === ref.natural_key);
    if (hits.length !== 1) unproven(REFS, `a predicate source identifies ${hits.length} rows instead of one`);
    const row = hits[0] as Page;
    guardedPages.add(normalizeId(row.id) as string);
    const value = typedValue(row, ref.property, ref.value_type, t, REFS);
    const state = t.types.has("State") ? textCell(row, "State") : undefined;
    const effectiveNow = inEffect(row, "Effective At", ms, zone);
    const known = (state === undefined || state === "CONFIRMED") && effectiveNow === true;
    refs.set(key, { ref, readable: true, value, known });
    sources.push({ ref: identity, readable: true, page_id: normalizeId(row.id) as string, value, known });
  }
  sources.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));

  const pick = (v: ResolvedRuntime["versions"]["governing_spec"]) => (v === "UNKNOWN" ? "UNKNOWN" : v.value);
  const canonical: Canonical = {
    snapshot_version: GUARD_SNAPSHOT_VERSION,
    guard_schema_version: spec.schemaVersion,
    runtime: { runtime_id: runtime.runtime_id, runtime_generation: runtime.runtime_generation },
    versions: { sales_contract: pick(runtime.versions.governing_spec), sales_schema: pick(runtime.versions.governing_schema), plugin: GUARD_PLUGIN_SPEC },
    index: { page_id: wanted as string, document: document as Canonical },
    decision_rules_p0: p0.map((r) => encodeRow(r, RULES)),
    runtime_configuration: effective.map((r) => encodeRow(r, CONFIG)),
    pointer_targets: pointerTargets,
    predicate_sources: sources,
  };
  return {
    t0, digest: digestOf(canonical), canonical, index: parsed.index, index_page_id: wanted as string,
    p0_rule_ids: ruleIds, constraints, refs, ...(zone ? { zone } : {}), guarded, guarded_pages: guardedPages,
  };
}

/** The typed value of a predicate source; an absent value or an unexpected type makes the snapshot invalid. */
function typedValue(row: Page, property: string, type: ValueType, t: Table, source: GuardSourceLabel): string | number | boolean {
  const kind = t.types.get(property);
  const v = propOf(row, property);
  if (!kind || !v || v.type !== kind) return unproven(source, "a predicate source property is absent");
  switch (type) {
    case "TEXT": {
      const s = ["title", "rich_text", "select", "status", "url", "email", "phone_number"].includes(kind) ? textCell(row, property) : undefined;
      return s ?? unproven(source, "a TEXT predicate source is of an unexpected type");
    }
    case "NUMBER": return kind === "number" && typeof v["number"] === "number" && Number.isFinite(v["number"]) ? (v["number"] as number) : unproven(source, "a NUMBER predicate source is absent or not a number");
    case "BOOLEAN": return kind === "checkbox" && typeof v["checkbox"] === "boolean" ? (v["checkbox"] as boolean) : unproven(source, "a BOOLEAN predicate source is of an unexpected type");
    case "DATE": {
      const d = kind === "date" ? (v["date"] as { start?: string; end?: string | null } | null) : undefined;
      return d?.start && !d.end ? d.start : unproven(source, "a DATE predicate source is absent or a range");
    }
  }
}
