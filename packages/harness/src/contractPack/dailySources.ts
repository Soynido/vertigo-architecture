/**
 * DAILY context sources — CONTRACT_PACK/0.3.0-candidate (W2.3, Sales DAILY contract candidate). READ-ONLY:
 * this module never writes, never plans, never scores and never decides what the seller does today.
 *
 * It supplies the fourteen sources the catalogue declares for DAILY, and only for the SALES lane, each one on its own
 * so that one unresolvable source is ABSENT without hiding another:
 *  - `DAILY_NATIVE_REALITY`: the two competent native sources to read BEFORE deciding — named, never copied;
 *  - `DAILY_HOLDS`: `ResumeState.effective_hold` as already derived, carried verbatim;
 *  - the seller's own rows, read in the databases of the bound runtime only, each under the filter, order and
 *    projection the contract publishes: blocked Tasks, P0 and other active Decision Rules, the Active Policies
 *    index, the confirmed Runtime Configuration constraints (with the E3 re-read of a typed pointer), the most
 *    recent verified Receipts, the unprocessed Intake, the due Tasks with the Accounts and Contacts they relate to,
 *    and the active Sequences;
 *  - `DAILY_PRODUCTION_HEALTH` (W3.4R, last): the production health the OS itself declared in its single
 *    `OS State/CURRENT` row, transported only when the DAILY_GO Run it names proves it — never calculated here.
 *
 * Window (W2.3P). A source asks the server for its eligible rows, filtered and sorted there, and reads at most ELEVEN
 * returned rows in total, over all its internal requests: ten can be served, the eleventh only makes the projector
 * announce an omission (S6). Every returned row is a candidate and is verified here; one that fails — a predicate,
 * the contractual order, its unique final key, a relation, an approved change — makes the source ABSENT. It is never
 * skipped to read a twelfth row in its place. No read of a whole database, no total, cursor or offset leaves this
 * module. The only other reads are direct reads of the pages a candidate names (related rows, an approved change),
 * and the E3 re-read of a declared pointer: validations of this window, never a further walk of the source.
 *
 * Dates. One `evaluation_now` is captured by the caller at the start of the os_resume attempt and shared by every
 * read here. A date without a time is compared with the civil day of that instant in the instance's own IANA zone,
 * declared by its single confirmed `TIMEZONE` Runtime Configuration row; without that zone the sources that need it
 * are ABSENT, never evaluated in an implicit UTC.
 *
 * Anything that cannot be resolved truthfully is ABSENT, never guessed; a failure is never echoed, because its
 * message could name a stored value. Values reach the projector only (D7).
 */
import type { NotionReadClient } from "../notion/readClient.ts";
import { normalizeId, plainText, type Page, type RichText } from "../notion/shapes.ts";
import { discoverDataSource, readSchema, type DataSourceSchema } from "../plans/resources.ts";
import type { ResolvedRuntime } from "../resolvers/types.ts";
import type { ResumeState } from "../resume/derive.ts";
import type { Lane } from "../tools/envelope.ts";
import type { ResourceSpec } from "../versions/adapters/controlPlane.ts";
import { CONTEXT_BOUNDS, CONTEXT_SECTIONS, DAILY_SOURCE_KEYS, NEED_CONTEXT, type ContextNeed } from "./catalog.ts";
import type { ContextSource, ContextValue } from "./pack.ts";

/** The row bound, and one more row whose only role is to prove that at least one row was not served. */
const SERVABLE = CONTEXT_BOUNDS.max_rows_per_section;
const WINDOW = SERVABLE + 1;

/** The already-derived resume facts DAILY carries. Consumed, never reclassified. */
export type DailySafety = Pick<ResumeState, "effective_hold" | "next_safe_action">;

/** The contractual native sources, in the published order: each is its own competent authority. Read first, copy nothing. */
const NATIVE_SOURCES = ["GMAIL", "HUMAN_ACTIONS"] as const;

/** The only resource a typed Runtime Configuration pointer may name, and the only field it may compare. */
const POINTER_RESOURCE = "SALES:BUSINESS_CONFIG";
const POINTER_FIELD = "Value";
const CONFIG_ITEM = "Config Item";

export type RereadStatus = "NO_POINTER" | "MATCH" | "DRIFT" | "MISSING" | "AMBIGUOUS" | "UNREADABLE" | "INVALID";

/**
 * Where each source lives in a Personal SALES runtime, as the template publishes it. These are read locations, not
 * addressable resources: nothing here is known to os_prepare, so naming one in an intent still fails closed.
 */
const AT = {
  ACTIVE_POLICIES: { parentTitle: "01 — CONSTITUTION & POLICIES", databaseTitle: "Active Policies" },
  POLICY_CHANGES: { parentTitle: "01 — CONSTITUTION & POLICIES", databaseTitle: "Policy Changes" },
  RUNTIME_CONFIG: { parentTitle: "02 — SETUP & BUSINESS CONFIG", databaseTitle: "Runtime Configuration" },
  TASKS: { parentTitle: "03 — CONTROL PLANE", databaseTitle: "Tasks" },
  DECISION_RULES: { parentTitle: "03 — CONTROL PLANE", databaseTitle: "Decision Rules" },
  RECEIPTS: { parentTitle: "03 — CONTROL PLANE", databaseTitle: "Receipts" },
  INTAKE: { parentTitle: "04 — DATA & EVIDENCE", databaseTitle: "Intake" },
  ACCOUNTS: { parentTitle: "04 — DATA & EVIDENCE", databaseTitle: "Accounts" },
  CONTACTS: { parentTitle: "04 — DATA & EVIDENCE", databaseTitle: "Contacts" },
  SEQUENCES: { parentTitle: "05 — OPERATIONS & PLAYBOOKS", databaseTitle: "Sequences" },
  OS_STATE: { parentTitle: "03 — CONTROL PLANE", databaseTitle: "OS State" },
  RUNS: { parentTitle: "03 — CONTROL PLANE", databaseTitle: "Runs" },
} as const;
type Location = (typeof AT)[keyof typeof AT];

const INTAKE_UNPROCESSED = ["RECEIVED", "INSPECTED", "NEEDS_MAPPING", "MAPPED", "RECONCILED", "HOLD"] as const;
const TASK_DUE_STATUSES = ["READY", "IN_PROGRESS"] as const;
const RULE_PRIORITIES = ["P1", "P2", "P3", "P4", "P5"] as const;
const CONSTRAINT_TYPES = ["LOCAL_CONSTRAINT", "PRODUCTION_CONTRACT_POINTER"] as const;

const absent = (source_key: string): ContextSource => ({ source_key, status: "ABSENT", rows: [] });
const present = (source_key: string, rows: readonly unknown[]): ContextSource => ({ source_key, status: "PRESENT", rows });

/** A window that cannot be proven. Thrown, never echoed: the source that raised it is ABSENT. */
class NotProven extends Error {
  override readonly name = "NotProven";
}
const fail = (): never => {
  throw new NotProven("DAILY window not proven");
};

/** Whether the normalized needs select the DAILY context at all. When they do not, nothing is read. */
export function dailySelected(needs: readonly ContextNeed[]): boolean {
  return needs.some((n) => NEED_CONTEXT[n] === "DAILY");
}

// ─────────────────────────────── columns and cells ───────────────────────────────

/**
 * The published column of a projected key: its words capitalized, `id` written `ID` — `task_id` is `Task ID`,
 * `do_not_contact` is `Do Not Contact`. The projection table in the catalogue is therefore the whole mapping.
 */
export function columnOf(key: string): string {
  return key.split("_").map((w) => (w === "id" ? "ID" : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
}

/**
 * The property types a column may have to be filtered, sorted or verified. Anything else is not read. A final sort
 * key (`… ID`) is an auto-increment `unique_id`: the only type whose server order is numeric and whose values are
 * unique by construction.
 */
const KINDS = {
  TEXT: ["title", "rich_text", "select", "status"],
  KEY: ["title", "rich_text"],
  RICH_TEXT: ["rich_text"],
  STATE: ["select", "status"],
  ID: ["unique_id"],
  WHEN: ["date"],
  /** A creation instant: the page's own creation time, or a date column holding one. */
  CREATED: ["created_time", "date"],
  FLAG: ["checkbox"],
  URL: ["url"],
} as const;
type Kind = keyof typeof KINDS;

/**
 * A cell as the source holds it, scalars only: text as its concatenated plain_text (untrimmed), a select as its
 * name, a checkbox as a boolean, a number as a number, a date as its start. A structure (multi-select, relation,
 * rollup, formula) is not a scalar and is not restated.
 */
function cell(page: Page, column: string): ContextValue | undefined {
  const p = page.properties[column] as ({ type: string } & Record<string, unknown>) | undefined;
  if (!p) return undefined;
  switch (p.type) {
    case "title": case "rich_text": return plainText(p[p.type] as readonly RichText[] | undefined);
    case "select": case "status": return (p[p.type] as { name?: string } | null)?.name;
    case "checkbox": return p["checkbox"] === true;
    case "number": return typeof p["number"] === "number" ? p["number"] : undefined;
    case "date": return (p["date"] as { start?: string } | null)?.start ?? undefined;
    case "created_time": case "last_edited_time": return typeof p[p.type] === "string" ? (p[p.type] as string) : undefined;
    case "url": case "email": case "phone_number": return typeof p[p.type] === "string" ? (p[p.type] as string) : undefined;
    case "unique_id": {
      const u = p["unique_id"] as { prefix?: string | null; number?: number } | undefined;
      return typeof u?.number === "number" ? `${u.prefix ? `${u.prefix}-` : ""}${u.number}` : undefined;
    }
    default: return undefined;
  }
}

const textOf = (page: Page, column: string): string | undefined => {
  const v = cell(page, column);
  return typeof v === "string" ? v : undefined;
};
/** A published predicate value, compared after trim() like every other predicate of the harness. */
const is = (page: Page, column: string, value: string): boolean => (textOf(page, column) ?? "").trim() === value;
const isOneOf = (page: Page, column: string, values: readonly string[]): boolean => values.includes((textOf(page, column) ?? "").trim());
const must = (ok: boolean): void => {
  if (!ok) fail();
};

/** Exactly the projected keys that hold a scalar, each read from its published column. */
function project(page: Page, keys: readonly string[]): Record<string, ContextValue> {
  const out: Record<string, ContextValue> = {};
  for (const key of keys) {
    const v = cell(page, columnOf(key));
    if (v !== undefined) out[key] = v;
  }
  return out;
}

// ─────────────────────────────── order ───────────────────────────────

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The auto-increment number of a unique final key. A candidate without one is invalid. */
function idOf(page: Page, column: string): number {
  const p = page.properties[column] as { type?: string; unique_id?: { number?: unknown } } | undefined;
  const n = p?.type === "unique_id" ? p.unique_id?.number : undefined;
  return typeof n === "number" && Number.isInteger(n) ? n : fail();
}
const byId = (a: Page, b: Page, column: string): number => idOf(a, column) - idOf(b, column);

/** Every returned row strictly after the one before it: the server's order, re-proven on the window it returned. */
function strictly(rows: readonly Page[], compare: (a: Page, b: Page) => number): void {
  for (let i = 1; i < rows.length; i += 1) must(compare(rows[i - 1]!, rows[i]!) < 0);
}

// ─────────────────────────────── time ───────────────────────────────

/** A stored date: a civil day, an instant with its offset, or something no zone can make decidable. */
type When = { readonly kind: "DAY"; readonly day: string } | { readonly kind: "INSTANT"; readonly ms: number; readonly raw: string } | { readonly kind: "UNDECIDABLE" };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function whenOf(page: Page, column: string): When | undefined {
  const raw = cell(page, column);
  if (raw === undefined || raw === "") return undefined;
  if (typeof raw !== "string") return { kind: "UNDECIDABLE" };
  if (DAY.test(raw) && !Number.isNaN(Date.parse(raw + "T00:00:00Z"))) return { kind: "DAY", day: raw };
  const ms = Date.parse(raw);
  if (INSTANT.test(raw) && Number.isFinite(ms)) return { kind: "INSTANT", ms, raw };
  return { kind: "UNDECIDABLE" };
}
/** A date the contract can order: empty, a civil day or an instant with its offset. Anything else is invalid. */
const decidable = (page: Page, column: string): boolean => whenOf(page, column)?.kind !== "UNDECIDABLE";

/** The shared evaluation instant, and the civil day it falls on in the instance's zone when that zone is known. */
interface Clock { readonly ms: number; readonly zone?: string; readonly today?: string }
type ZonedClock = Clock & { readonly zone: string; readonly today: string };

function civilDay(ms: number, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const part = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Reached at the evaluation instant: `undefined` when it cannot be decided (a civil day without a known zone). */
function reached(w: When, clock: Clock): boolean | undefined {
  if (w.kind === "DAY") return clock.today === undefined ? undefined : w.day <= clock.today;
  if (w.kind === "INSTANT") return w.ms <= clock.ms;
  return undefined;
}
/** A candidate the server returned as reached must be reached here too: an empty, future or undecidable date is invalid. */
const reachedHere = (page: Page, column: string, clock: Clock): boolean => {
  const w = whenOf(page, column);
  return w !== undefined && reached(w, clock) === true;
};

/**
 * Chronological order of stored dates: by civil day — an instant's day in the instance's zone when it is known,
 * otherwise the day it was written on — then a bare day before the instants of that day, then by instant.
 * An empty or undecidable date sorts last. It orders; it decides nothing.
 */
function whenKey(w: When | undefined, clock: Clock): readonly [number, string, number, number] {
  if (!w || w.kind === "UNDECIDABLE") return [1, "", 0, 0];
  if (w.kind === "DAY") return [0, w.day, 0, 0];
  return [0, clock.zone ? civilDay(w.ms, clock.zone) : w.raw.slice(0, 10), 1, w.ms];
}
function byWhen(a: Page, b: Page, column: string, clock: Clock, descending = false): number {
  const x = whenKey(whenOf(a, column), clock), y = whenKey(whenOf(b, column), clock);
  if (x[0] !== y[0]) return x[0] - y[0];
  const sign = descending ? -1 : 1;
  return sign * (cmp(x[1], y[1]) || x[2] - y[2] || x[3] - y[3]);
}

/** An IANA zone name the runtime can evaluate. A bare offset or an abbreviation-shaped value is not one. */
const IANA_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9][A-Za-z0-9_+-]*)*$/;
function ianaZone(value: string | undefined): string | undefined {
  if (value === undefined || value !== value.trim() || !IANA_NAME.test(value)) return undefined;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone ? value : undefined;
  } catch {
    return undefined;
  }
}

// ─────────────────────────────── tables of the bound runtime ───────────────────────────────

interface Table { readonly ds: string; readonly schema: DataSourceSchema }

/**
 * Discover one database under the bound root (never from a URL a row carries), read its schema, and require every
 * column a predicate, an order or a verification needs, with an admitted type. `undefined` means the source is
 * ABSENT, decided before any data query. A thrown read propagates to the source, which is ABSENT for it.
 */
async function openTable(client: NotionReadClient, runtime: ResolvedRuntime, at: Location, required: Readonly<Record<string, Kind>>): Promise<Table | undefined> {
  const spec: ResourceSpec = { scope: "RUNTIME", parentTitle: at.parentTitle, databaseTitle: at.databaseTitle, naturalKeyProperty: "", operations: [] };
  const disc = await discoverDataSource(client, runtime, spec);
  if (!disc.ok) return undefined;
  const schema = await readSchema(client, disc.ds);
  if (!schema) return undefined;
  for (const [column, kind] of Object.entries(required)) {
    if (!(KINDS[kind] as readonly string[]).includes(schema.properties.get(column) ?? "")) return undefined;
  }
  return { ds: disc.ds, schema };
}

// Server conditions, each in the form the column's type accepts. A column of another type has no condition: the
// server could not select the eligible rows, so the source is ABSENT rather than filtered here.
type Condition = Readonly<Record<string, unknown>>;
function equals(t: Table, column: string, value: string | boolean): Condition {
  const type = t.schema.properties.get(column);
  if (type === "checkbox" && typeof value === "boolean") return { property: column, checkbox: { equals: value } };
  if ((type === "select" || type === "status" || type === "title" || type === "rich_text") && typeof value === "string") return { property: column, [type]: { equals: value } };
  return fail();
}
function filled(t: Table, column: string, yes: boolean): Condition {
  const type = t.schema.properties.get(column);
  if (type === "date" || type === "title" || type === "rich_text" || type === "url") return { property: column, [type]: yes ? { is_not_empty: true } : { is_empty: true } };
  return fail();
}
const onOrBefore = (column: string, day: string): Condition => ({ property: column, date: { on_or_before: day } });
/**
 * The server preselection of a reached date (DAILY_DUE_TASKS and DAILY_RUNTIME_CONSTRAINTS only): on or before the
 * instance's civil today, or on or before the single evaluation instant in ISO Z. Every returned row is re-proven.
 */
const reachedBy = (column: string, clock: ZonedClock): Condition[] => [onOrBefore(column, clock.today), onOrBefore(column, new Date(clock.ms).toISOString())];
/** A single date value: neither a range (non-null `end`) nor an offsetless time in a named zone (non-null `time_zone`). Never inferred. */
function pointDate(page: Page, column: string): boolean {
  const d = (page.properties[column] as { date?: { end?: unknown; time_zone?: unknown } | null } | undefined)?.date;
  return !d || (d.end == null && d.time_zone == null);
}
const every = (...conditions: Condition[]): Condition => (conditions.length === 1 ? conditions[0]! : { and: conditions });
const anyOf = (conditions: readonly Condition[]): Condition => (conditions.length === 1 ? conditions[0]! : { or: conditions });
const asc = (property: string): Condition => ({ property, direction: "ascending" });
const desc = (property: string): Condition => ({ property, direction: "descending" });

/** One server selection: its filter and its order. A source may chain several, in the contractual order. */
interface Phase { readonly filter: Condition; readonly sorts: readonly Condition[] }

/**
 * The first rows of the contractual order: at most `limit` RETURNED rows over all phases and internal pages, each
 * request asking for exactly what remains. Anything that makes the window unprovable — more rows than asked, a row
 * returned twice, archived, trashed or from another data source, a continuation without a cursor, an end with a cursor,
 * a missing or non-boolean `has_more`, no progress — ends
 * the read: the source is ABSENT. The cursor never leaves this function.
 */
async function firstRows(client: NotionReadClient, t: Table, phases: readonly Phase[], limit: number = WINDOW): Promise<Page[]> {
  const out: Page[] = [];
  const seen = new Set<string>();
  for (const phase of phases) {
    let cursor: string | undefined;
    for (let request = 0; out.length < limit; request += 1) {
      must(request < limit);
      const want = limit - out.length;
      const q = (await client.queryDataSource(t.ds, phase.filter, cursor, { sorts: phase.sorts, page_size: want })) as { results?: unknown; has_more?: unknown; next_cursor?: unknown } | undefined;
      const results = Array.isArray(q?.results) ? (q.results as readonly Page[]) : fail();
      must(results.length <= want);
      for (const p of results) {
        const id = normalizeId(p?.id);
        must(id !== undefined && !seen.has(id) && p.archived !== true && p.in_trash !== true && normalizeId(p.parent?.data_source_id) === t.ds);
        seen.add(id as string);
        out.push(p);
      }
      // Pagination must be proven either way: an explicit end without a cursor, or an explicit continuation with one
      // (even when the cap is reached). Anything else — missing/unknown has_more, an end carrying a cursor — is ABSENT.
      const more = q!.has_more;
      const next = q!.next_cursor;
      if (more === false) {
        must(next === null || next === undefined);
        break;
      }
      must(more === true && typeof next === "string" && next !== "");
      cursor = next as string;
    }
    if (out.length >= limit) break;
  }
  return out;
}

// ─────────────────────────────── related pages ───────────────────────────────

/**
 * A singular relation of a source row, served as the logical ID of the page it names: `column` must be declared by the
 * source schema toward the very database the bound runtime holds at `at`, whose `idColumn` is its auto-increment ID.
 */
interface Link { readonly key: string; readonly column: string; readonly target: Table; readonly idColumn: string }

async function openLink(client: NotionReadClient, runtime: ResolvedRuntime, source: Table, key: string, column: string, at: Location): Promise<Link | undefined> {
  const idColumn = columnOf(key);
  const target = await openTable(client, runtime, at, { [idColumn]: "ID" });
  if (!target || source.schema.properties.get(column) !== "relation" || source.schema.relations.get(column) !== target.ds) return undefined;
  return { key, column, target, idColumn };
}

/**
 * Direct reads of the pages the window's candidates name, one per page for one source. Zero relation: nothing to
 * serve. One relation: the live page of that very database, with its logical ID. Several, a truncated list, a page of
 * another database, archived, missing or unreadable: the candidate is invalid and its source ABSENT.
 */
class Related {
  readonly #client: NotionReadClient;
  readonly #pages = new Map<string, Promise<unknown>>();
  constructor(client: NotionReadClient) {
    this.#client = client;
  }

  async one(page: Page, link: Link): Promise<Page | undefined> {
    const p = page.properties[link.column] as { type?: string; relation?: unknown; has_more?: unknown } | undefined;
    must(p?.type === "relation" && Array.isArray(p.relation) && p.has_more !== true);
    const ids = [...new Set((p!.relation as readonly { id?: string }[]).map((r) => normalizeId(r?.id) ?? fail()))];
    if (ids.length === 0) return undefined;
    must(ids.length === 1);
    const id = ids[0]!;
    let read = this.#pages.get(id);
    if (!read) { read = this.#client.retrievePage(id); this.#pages.set(id, read); }
    const row = (await read) as Page | undefined;
    must(row !== undefined && normalizeId(row.id) === id && row.archived !== true && row.in_trash !== true && normalizeId(row.parent?.data_source_id) === link.target.ds);
    idOf(row!, link.idColumn);
    return row;
  }

  /** The projected row: its own scalar keys, then each linked key as the related page's logical ID, or omitted. */
  async project(page: Page, keys: readonly string[], links: readonly Link[]): Promise<Record<string, ContextValue>> {
    const linked = new Set(links.map((l) => l.key));
    const out = project(page, keys.filter((k) => !linked.has(k)));
    for (const link of links) {
      const row = await this.one(page, link);
      if (row) out[link.key] = cell(row, link.idColumn) as string;
    }
    return out;
  }
}

/** One read per structural object for the whole attempt; data queries and row reads are never cached. */
function structureOnce(client: NotionReadClient): NotionReadClient {
  const memo = new Map<string, Promise<unknown>>();
  const once = (key: string, read: () => Promise<unknown>): Promise<unknown> => {
    let p = memo.get(key);
    if (!p) { p = read(); memo.set(key, p); }
    return p;
  };
  return {
    retrievePage: (id) => client.retrievePage(id),
    retrieveDatabase: (id) => once(`database:${id}`, () => client.retrieveDatabase(id)),
    retrieveDataSource: (id) => once(`data_source:${id}`, () => client.retrieveDataSource(id)),
    retrieveBlockChildren: (id, cursor) => once(`children:${id}:${cursor ?? ""}`, () => client.retrieveBlockChildren(id, cursor)),
    queryDataSource: (id, filter, cursor, options) => client.queryDataSource(id, filter, cursor, options),
  };
}

/** A source that throws is ABSENT; the failure is not echoed. */
async function guarded(source_key: string, read: () => Promise<ContextSource>): Promise<ContextSource> {
  try {
    return await read();
  } catch {
    return absent(source_key);
  }
}

// ─────────────────────────────── the sources ───────────────────────────────

const K = DAILY_SOURCE_KEYS;

/** The projected keys the catalogue declares for a DAILY source: the one table both the reader and the projector obey. */
function keysOf(source_key: string): readonly string[] {
  const spec = CONTEXT_SECTIONS.DAILY.find((s) => s.source_key === source_key);
  if (!spec) throw new Error("DAILY source not declared: " + source_key);
  return spec.projected_keys;
}
/** The verified window of a source, each row read under the catalogue projection. */
const windowOf = (source_key: string, rows: readonly Page[]): ContextSource => present(source_key, rows.map((r) => project(r, keysOf(source_key))));

/**
 * The DAILY sources for this turn, in catalogue order. Empty when DAILY is not selected. On META the fourteen sections
 * exist and all are ABSENT: DAILY projects Sales content only, and no SALES value crosses the lane. Call it only
 * outside an outer HOLD, or under the reliable Gmail-only capability HOLD specified by W5.1R. The caller
 * enforces that narrow exception and retains the outer HOLD; this reader never grants operational permission.
 *
 * `evaluation_now` is the single instant captured at the start of this os_resume attempt.
 */
export async function readDailySources(client: NotionReadClient, runtime: ResolvedRuntime, lane: Lane, needs: readonly ContextNeed[], safety: DailySafety, evaluation_now: Date): Promise<readonly ContextSource[]> {
  if (!dailySelected(needs)) return [];
  if (lane !== "SALES") return Object.values(K).map(absent);
  const reader = structureOnce(client);
  const ms = evaluation_now.getTime();

  const configTable = openTable(reader, runtime, AT.RUNTIME_CONFIG, { Config: "TEXT", Type: "STATE", State: "STATE", Value: "TEXT" }).catch(() => undefined);
  const clock: Promise<ZonedClock | undefined> = configTable.then(async (t) => {
    const zone = t ? await instanceZone(reader, t, ms).catch(() => undefined) : undefined;
    return zone ? { ms, zone, today: civilDay(ms, zone) } : undefined;
  });
  // Tasks and Decision Rules each feed two sources: one discovery each, shared; each source runs its own window.
  const tasks = openTable(reader, runtime, AT.TASKS, { Status: "STATE", "Due Date": "WHEN", "Task ID": "ID" }).catch(() => undefined);
  const rules = openTable(reader, runtime, AT.DECISION_RULES, { Active: "FLAG", Priority: "STATE", "Rule ID": "ID" }).catch(() => undefined);
  const due = dueTasks(reader, runtime, tasks, clock);

  return Promise.all([
    present(K.NATIVE_REALITY, NATIVE_SOURCES.map((source) => ({ source, authority: source, read_first: true }))),
    present(K.HOLDS, safety.effective_hold === "NONE" ? [] : [{ code: safety.effective_hold.code, next_safe_action: safety.next_safe_action }]),
    guarded(K.BLOCKED_TASKS, async () => {
      const t = await tasks;
      if (!t) return absent(K.BLOCKED_TASKS);
      const c: Clock = (await clock) ?? { ms };
      const blocked = equals(t, "Status", "BLOCKED");
      // A dated Task first, by Due Date then Task ID; an undated one after all of them, by Task ID.
      const rows = await firstRows(reader, t, [
        { filter: every(blocked, filled(t, "Due Date", true)), sorts: [asc("Due Date"), asc("Task ID")] },
        { filter: every(blocked, filled(t, "Due Date", false)), sorts: [asc("Task ID")] },
      ]);
      for (const r of rows) must(is(r, "Status", "BLOCKED") && decidable(r, "Due Date") && idOf(r, "Task ID") > 0);
      strictly(rows, (a, b) => byWhen(a, b, "Due Date", c) || byId(a, b, "Task ID"));
      return windowOf(K.BLOCKED_TASKS, rows);
    }),
    guarded(K.P0_RULES, async () => {
      const t = await rules;
      if (!t) return absent(K.P0_RULES);
      const rows = await firstRows(reader, t, [{ filter: every(equals(t, "Active", true), equals(t, "Priority", "P0")), sorts: [asc("Rule ID")] }]);
      for (const r of rows) must(cell(r, "Active") === true && is(r, "Priority", "P0") && idOf(r, "Rule ID") > 0);
      strictly(rows, (a, b) => byId(a, b, "Rule ID"));
      return windowOf(K.P0_RULES, rows);
    }),
    guarded(K.ACTIVE_POLICIES, async () => activePolicies(reader, runtime, await clock)),
    guarded(K.RUNTIME_CONSTRAINTS, async () => runtimeConstraints(reader, runtime, await configTable, await clock)),
    guarded(K.RECENT_RECEIPTS, async () => {
      const t = await openTable(reader, runtime, AT.RECEIPTS, { Verified: "FLAG", "Event Timestamp": "WHEN", "Receipt ID": "ID" });
      const taskTable = await tasks;
      if (!t || !taskTable) return absent(K.RECENT_RECEIPTS);
      const links = await Promise.all([
        openLink(reader, runtime, t, "task_id", "Task", AT.TASKS),
        openLink(reader, runtime, t, "account_id", "Account", AT.ACCOUNTS),
        openLink(reader, runtime, t, "contact_id", "Contact", AT.CONTACTS),
      ]);
      if (links.some((l) => !l)) return absent(K.RECENT_RECEIPTS);
      const c: Clock = (await clock) ?? { ms };
      const verified = equals(t, "Verified", true);
      // "Recent" is the most recent of this stream, never a window of days; an undated receipt comes after all.
      const rows = await firstRows(reader, t, [
        { filter: every(verified, filled(t, "Event Timestamp", true)), sorts: [desc("Event Timestamp"), asc("Receipt ID")] },
        { filter: every(verified, filled(t, "Event Timestamp", false)), sorts: [asc("Receipt ID")] },
      ]);
      for (const r of rows) must(cell(r, "Verified") === true && decidable(r, "Event Timestamp") && idOf(r, "Receipt ID") > 0);
      strictly(rows, (a, b) => byWhen(a, b, "Event Timestamp", c, true) || byId(a, b, "Receipt ID"));
      const related = new Related(reader);
      const out: Record<string, ContextValue>[] = [];
      for (const r of rows) out.push(await related.project(r, keysOf(K.RECENT_RECEIPTS), links as Link[]));
      return present(K.RECENT_RECEIPTS, out);
    }),
    guarded(K.UNPROCESSED_INTAKE, async () => {
      const t = await openTable(reader, runtime, AT.INTAKE, { Status: "STATE", "Received At": "CREATED", "Intake ID": "ID" });
      if (!t) return absent(K.UNPROCESSED_INTAKE);
      const createdAt = t.schema.properties.get("Received At") === "created_time";
      const c: Clock = createdAt ? { ms } : (await clock) ?? { ms };
      const unprocessed = anyOf(INTAKE_UNPROCESSED.map((s) => equals(t, "Status", s)));
      // System creation times are always populated: no date-presence filter or undated phase. Keep the date path.
      const rows = await firstRows(reader, t, createdAt ? [
        { filter: unprocessed, sorts: [asc("Received At"), asc("Intake ID")] },
      ] : [
        { filter: every(unprocessed, filled(t, "Received At", true)), sorts: [asc("Received At"), asc("Intake ID")] },
        { filter: every(unprocessed, filled(t, "Received At", false)), sorts: [asc("Intake ID")] },
      ]);
      const creationIds = new Set<number>();
      for (const r of rows) {
        must(isOneOf(r, "Status", INTAKE_UNPROCESSED) && decidable(r, "Received At") && idOf(r, "Intake ID") > 0);
        if (createdAt) {
          must(r.properties["Received At"]?.type === "created_time" && instantOf(r, "Received At") !== undefined && !creationIds.has(idOf(r, "Intake ID")));
          creationIds.add(idOf(r, "Intake ID"));
        }
      }
      strictly(rows, (a, b) => (createdAt ? instantOf(a, "Received At")! - instantOf(b, "Received At")! : byWhen(a, b, "Received At", c)) || byId(a, b, "Intake ID"));
      return windowOf(K.UNPROCESSED_INTAKE, rows);
    }),
    guarded(K.DUE_TASKS, async () => {
      const d = await due;
      return d ? present(K.DUE_TASKS, d.items) : absent(K.DUE_TASKS);
    }),
    guarded(K.TASK_ACCOUNTS, async () => taskRelated(await due, "account_id", K.TASK_ACCOUNTS)),
    guarded(K.TASK_CONTACTS, async () => taskRelated(await due, "contact_id", K.TASK_CONTACTS)),
    guarded(K.ACTIVE_RULES, async () => {
      const t = await rules;
      if (!t) return absent(K.ACTIVE_RULES);
      // P1 → P5 then Rule ID: one server selection per priority, in that order, sharing one window. The server's
      // order of select options is never relied upon. P0 is its own section and is not repeated here.
      const active = equals(t, "Active", true);
      const rows = await firstRows(reader, t, RULE_PRIORITIES.map((p) => ({ filter: every(active, equals(t, "Priority", p)), sorts: [asc("Rule ID")] })));
      const rank = (x: Page) => (RULE_PRIORITIES as readonly string[]).indexOf((textOf(x, "Priority") ?? "").trim());
      for (const r of rows) must(cell(r, "Active") === true && rank(r) >= 0 && idOf(r, "Rule ID") > 0);
      strictly(rows, (a, b) => rank(a) - rank(b) || byId(a, b, "Rule ID"));
      return windowOf(K.ACTIVE_RULES, rows);
    }),
    guarded(K.ACTIVE_SEQUENCES, async () => {
      const t = await openTable(reader, runtime, AT.SEQUENCES, { Status: "STATE", "Sequence ID": "ID" });
      if (!t) return absent(K.ACTIVE_SEQUENCES);
      const rows = await firstRows(reader, t, [{ filter: equals(t, "Status", "ACTIVE"), sorts: [asc("Sequence ID")] }]);
      for (const r of rows) must(is(r, "Status", "ACTIVE") && idOf(r, "Sequence ID") > 0);
      strictly(rows, (a, b) => byId(a, b, "Sequence ID"));
      return windowOf(K.ACTIVE_SEQUENCES, rows);
    }),
    guarded(K.PRODUCTION_HEALTH, async () => productionHealth(reader, runtime, await clock)),
  ]);
}

// ─────────────────────────────── Production health (W3.4R) ───────────────────────────────

/** The only production health values an OS may declare. Carried verbatim, never computed, ranked or defaulted. */
const PRODUCTION_HEALTH = ["ON_TARGET", "AT_RISK", "PRODUCTION_BREACH"] as const;
/** A physical Notion page UUID, dashed or compact, and nothing else: never a URL, a title or a logical ID. */
const PAGE_UUID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** A single full date-time with its offset (`is_datetime=1`): never a bare day, a range or a named-zone value. */
function instantOf(page: Page, column: string): number | undefined {
  const w = whenOf(page, column);
  return w?.kind === "INSTANT" && pointDate(page, column) ? w.ms : undefined;
}

/**
 * DAILY_PRODUCTION_HEALTH (W3.4R). Exactly one `OS State` row named `CURRENT` in the bound runtime (at most two rows
 * asked, to prove it single), then ONE direct read of the Run whose physical UUID it holds in `Production Health Run
 * Ref`. Served only when the declared value is one of the three published values, the Run is a live page of this very
 * runtime's Runs database with `Run Type` DAILY_GO and `Status` COMPLETED, its `Finished` and the row's `Last Daily
 * Run` are full date-times, and `Last Daily Run` falls within that Run's `Created`..`Finished`, is not in the future
 * and is on the instance's civil today. Anything missing or unprovable is ABSENT — never a HOLD, never a verdict
 * of the harness's own: the health is the OS's, carried as declared.
 */
async function productionHealth(client: NotionReadClient, runtime: ResolvedRuntime, clock: ZonedClock | undefined): Promise<ContextSource> {
  const key = K.PRODUCTION_HEALTH;
  // "Today" needs the instance's declared zone: without it nothing is served, and nothing is read.
  if (!clock) return absent(key);
  const state = await openTable(client, runtime, AT.OS_STATE, { Name: "KEY", "Production Health": "STATE", "Production Health Run Ref": "RICH_TEXT", "Last Daily Run": "WHEN" });
  if (!state) return absent(key);
  const rows = await firstRows(client, state, [{ filter: equals(state, "Name", "CURRENT"), sorts: [] }], 2);
  if (rows.length !== 1) return absent(key);
  const current = rows[0]!;
  must(is(current, "Name", "CURRENT"));
  const health = textOf(current, "Production Health");
  must(health !== undefined && (PRODUCTION_HEALTH as readonly string[]).includes(health));
  const ref = textOf(current, "Production Health Run Ref") ?? "";
  must(PAGE_UUID.test(ref));
  const runId = normalizeId(ref) ?? fail();
  const evaluated = instantOf(current, "Last Daily Run");
  must(evaluated !== undefined && evaluated <= clock.ms && civilDay(evaluated, clock.zone) === clock.today);
  // The Run must belong to the bound runtime's own Runs database: one discovery, then one direct read, never a query.
  const runs = await openTable(client, runtime, AT.RUNS, { "Run Type": "STATE", Status: "STATE", Created: "CREATED", Finished: "WHEN" });
  if (!runs) return absent(key);
  const run = (await client.retrievePage(runId)) as Page | undefined;
  must(run !== undefined && normalizeId(run.id) === runId && run.archived !== true && run.in_trash !== true && normalizeId(run.parent?.data_source_id) === runs.ds);
  must(is(run!, "Run Type", "DAILY_GO") && is(run!, "Status", "COMPLETED"));
  const created = instantOf(run!, "Created");
  const finished = instantOf(run!, "Finished");
  must(created !== undefined && finished !== undefined && created <= evaluated! && evaluated! <= finished);
  return present(key, [{ production_health: health!, daily_run_ref: runId, evaluated_at: textOf(current, "Last Daily Run")! }]);
}

/**
 * The instance's IANA zone: its single `TIMEZONE` Runtime Configuration row, a confirmed local constraint whose value
 * is an IANA name. Every row carrying that Config counts, whatever its state, so a draft can never hide behind a
 * confirmed twin: two returned rows are enough to know it is not single. The row may only take effect immediately or
 * at an instant with an offset that is already reached: a bare day would need the very zone it declares.
 */
async function instanceZone(client: NotionReadClient, t: Table, ms: number): Promise<string | undefined> {
  const rows = await firstRows(client, t, [{ filter: equals(t, "Config", "TIMEZONE"), sorts: [] }], 2);
  if (rows.length !== 1) return undefined;
  const row = rows[0]!;
  if (!is(row, "Config", "TIMEZONE") || !is(row, "Type", "LOCAL_CONSTRAINT") || !is(row, "State", "CONFIRMED")) return undefined;
  if (t.schema.properties.has("Effective At")) {
    if (t.schema.properties.get("Effective At") !== "date") return undefined;
    const w = whenOf(row, "Effective At");
    if (w && (w.kind !== "INSTANT" || w.ms > ms)) return undefined;
  }
  return ianaZone(textOf(row, "Value"));
}

/**
 * Tasks READY or IN_PROGRESS whose Due Date is reached, by Due Date then Task ID, with the Account, Contact and
 * Sequence each one names. `undefined`: DAILY_DUE_TASKS is ABSENT, and so are the Accounts and Contacts that follow it.
 */
interface Due {
  readonly items: readonly Record<string, ContextValue>[];
  /** The related Accounts and Contacts of the ten servable Tasks, by projected key, in first-appearance order. */
  readonly related: ReadonlyMap<string, readonly Page[]>;
}
function dueTasks(client: NotionReadClient, runtime: ResolvedRuntime, tasks: Promise<Table | undefined>, clock: Promise<ZonedClock | undefined>): Promise<Due | undefined> {
  return (async () => {
    const t = await tasks;
    const c = await clock;
    // A bare due day needs the instance's zone: without it no task is presented as due, never in an implicit UTC.
    if (!t || !c) return undefined;
    const links = await Promise.all([
      openLink(client, runtime, t, "account_id", "Account", AT.ACCOUNTS),
      openLink(client, runtime, t, "contact_id", "Contact", AT.CONTACTS),
      openLink(client, runtime, t, "sequence_id", "Sequence", AT.SEQUENCES),
    ]);
    if (links.some((l) => !l)) return undefined;
    const statuses = anyOf(TASK_DUE_STATUSES.map((s) => equals(t, "Status", s)));
    const rows = await firstRows(client, t, [{ filter: every(statuses, anyOf(reachedBy("Due Date", c))), sorts: [asc("Due Date"), asc("Task ID")] }]);
    // A returned future, undecidable, range or named-zone candidate makes the whole source ABSENT: never skipped or replaced.
    for (const r of rows) must(isOneOf(r, "Status", TASK_DUE_STATUSES) && pointDate(r, "Due Date") && reachedHere(r, "Due Date", c) && idOf(r, "Task ID") > 0);
    strictly(rows, (a, b) => byWhen(a, b, "Due Date", c) || byId(a, b, "Task ID"));
    const related = new Related(client);
    const items: Record<string, ContextValue>[] = [];
    for (const r of rows) items.push(await related.project(r, keysOf(K.DUE_TASKS), links as Link[]));
    const firstHop = new Map<string, Page[]>();
    for (const link of (links as Link[]).filter((l) => l.key !== "sequence_id")) {
      const pages: Page[] = [];
      for (const r of rows.slice(0, SERVABLE)) {
        const page = await related.one(r, link);
        if (page && !pages.some((p) => normalizeId(p.id) === normalizeId(page.id))) pages.push(page);
      }
      firstHop.set(link.key, pages);
    }
    return { items, related: firstHop };
  })().catch(() => undefined);
}

/**
 * The Accounts (or Contacts) the ten servable due Tasks relate to, first hop only, de-duplicated in the order of those
 * Tasks: the pages already read to verify them, never another query. No recursion (Account → Contact or other).
 */
async function taskRelated(due: Due | undefined, linkKey: string, key: string): Promise<ContextSource> {
  const pages = due?.related.get(linkKey);
  return pages ? windowOf(key, pages) : absent(key);
}

// ─────────────────────────────── Active Policies ───────────────────────────────

/** The hosts an `Approved Change` URL may name. Anything else is not recognized, and is never followed. */
const NOTION_HOSTS = new Set(["notion.so", "www.notion.so", "app.notion.com"]);
const COMPACT_ID = /(?:^|-)([0-9a-f]{32})$/i;
const DASHED_ID = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i;

/**
 * The one page id a recognized Notion page URL names, or `undefined`. Only `https` on a Notion host, without
 * credentials, port or fragment (a block), and without a `v` (a database view) or `p` (a peeked page) parameter
 * that would make the target something other than the page of its path.
 */
export function notionPageId(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "" || raw !== raw.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || !NOTION_HOSTS.has(url.hostname) || url.port !== "" || url.username !== "" || url.password !== "" || url.hash !== "") return undefined;
  if (url.searchParams.has("v") || url.searchParams.has("p")) return undefined;
  const last = url.pathname.split("/").filter((s) => s !== "").at(-1) ?? "";
  const dashed = DASHED_ID.exec(last);
  if (dashed) return dashed.slice(1).join("").toLowerCase();
  return COMPACT_ID.exec(last)?.[1]?.toLowerCase();
}

/** At most this many RETURNED rows of the whole `State=ACTIVE` selection of Active Policies: never a twelfth. */
const ACTIVE_POLICIES_CAP = WINDOW;

/**
 * The WHOLE selection of one phase, proven complete: at most `cap` RETURNED rows over its internal pages, each request
 * asking for exactly what remains, and a last response that proves the end (`has_more` false, no cursor). More rows
 * than `cap`, a continuation after `cap` rows, an ambiguous `has_more`, or any check of `firstRows` failing: the source
 * is ABSENT. The cursor never leaves this function.
 */
async function wholeSelection(client: NotionReadClient, t: Table, phase: Phase, cap: number): Promise<Page[]> {
  const out: Page[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let request = 0; ; request += 1) {
    must(request < cap);
    const want = cap - out.length;
    const q = (await client.queryDataSource(t.ds, phase.filter, cursor, { sorts: phase.sorts, page_size: want })) as { results?: unknown; has_more?: unknown; next_cursor?: unknown } | undefined;
    const results = Array.isArray(q?.results) ? (q.results as readonly Page[]) : fail();
    must(results.length <= want);
    for (const p of results) {
      const id = normalizeId(p?.id);
      must(id !== undefined && !seen.has(id) && p.archived !== true && p.in_trash !== true && normalizeId(p.parent?.data_source_id) === t.ds);
      seen.add(id as string);
      out.push(p);
    }
    if (q?.has_more === false && q.next_cursor == null) return out;
    // Anything but a proven end is a continuation: allowed only while rows remain under the cap, with a cursor.
    must(q?.has_more === true && out.length < cap && typeof q.next_cursor === "string" && q.next_cursor !== "");
    cursor = q!.next_cursor as string;
  }
}

/**
 * The Active Policies index (candidate Sales schema, W2.3C/W2.3P/GW2.3Q). Global uniqueness binds EVERY `State=ACTIVE`
 * row, future `Effective At` included: the server selects `State=ACTIVE` only, ordered by `Policy Key`, and the whole
 * selection must fit in eleven returned rows with a proven end, or the source is ABSENT. Every ACTIVE row needs a
 * non-empty `Policy Key` unique among them in a verifiable strict order, a non-empty `Policy Text`, a decidable
 * non-empty `Effective At` and a recognized `Approved Change` URL (schema 0.5.3, a URL, not a relation) naming one
 * page of this runtime's own Policy Changes, `APPLIED` and `Human Approved` — all checked by direct reads of those
 * pages, future rows included, before any effect date filters. Only the rows whose `Effective At` is already reached
 * are served; an eleventh such row only announces an omission. A runtime without the index, or without a verifiable
 * zone, has this source ABSENT, and so does any ACTIVE row, in force or not yet, that fails one of these checks.
 */
async function activePolicies(client: NotionReadClient, runtime: ResolvedRuntime, clock: ZonedClock | undefined): Promise<ContextSource> {
  const key = K.ACTIVE_POLICIES;
  if (!clock) return absent(key);
  const t = await openTable(client, runtime, AT.ACTIVE_POLICIES, { "Policy Key": "RICH_TEXT", State: "STATE", "Effective At": "WHEN", "Approved Change": "URL", "Policy Text": "RICH_TEXT" });
  const changes = await openTable(client, runtime, AT.POLICY_CHANGES, { Status: "STATE", "Human Approved": "FLAG" });
  if (!t || !changes) return absent(key);
  const active = await wholeSelection(client, t, { filter: equals(t, "State", "ACTIVE"), sorts: [asc("Policy Key")] }, ACTIVE_POLICIES_CAP);
  const policyKey = (r: Page) => (textOf(r, "Policy Key") ?? "").trim();
  for (const r of active) {
    const w = whenOf(r, "Effective At");
    must(is(r, "State", "ACTIVE") && policyKey(r) !== "" && (textOf(r, "Policy Text") ?? "").trim() !== "");
    must(w !== undefined && reached(w, clock) !== undefined && notionPageId(textOf(r, "Approved Change")) !== undefined);
  }
  // Two ACTIVE rows for one key, in force or not yet: neither is the policy, and choosing one would be a decision.
  const keys = active.map(policyKey);
  must(new Set(keys).size === keys.length);
  // Every ACTIVE row, future included, needs its approved change: one direct read of the page it names, never a walk.
  for (const r of active) {
    const id = notionPageId(textOf(r, "Approved Change")) ?? fail();
    const change = (await client.retrievePage(id)) as Page | undefined;
    must(change !== undefined && normalizeId(change.id) === id && change.archived !== true && change.in_trash !== true && normalizeId(change.parent?.data_source_id) === changes.ds);
    must(is(change!, "Status", "APPLIED") && cell(change!, "Human Approved") === true);
  }
  // Future rows are valid but not served.
  const rows = active.filter((r) => reachedHere(r, "Effective At", clock));
  return windowOf(key, rows);
}

// ─────────────────────────────── Runtime Configuration ───────────────────────────────

/**
 * Confirmed Runtime Configuration constraints (`LOCAL_CONSTRAINT` and `PRODUCTION_CONTRACT_POINTER`) that are in
 * effect, by `Config ID`. `Value` is the DECLARED value and `Source` stays free provenance; a complete typed pointer
 * adds the value re-read at its source (E3), compared as exact text and never interpreted.
 */
async function runtimeConstraints(client: NotionReadClient, runtime: ResolvedRuntime, t: Table | undefined, clock: ZonedClock | undefined): Promise<ContextSource> {
  const key = K.RUNTIME_CONSTRAINTS;
  if (!t || !clock || t.schema.properties.get("Config ID") !== "unique_id") return absent(key);
  const hasEffective = t.schema.properties.has("Effective At");
  if (hasEffective && t.schema.properties.get("Effective At") !== "date") return absent(key);
  // An empty Effective At on this database means no deferred activation.
  const conditions = [equals(t, "State", "CONFIRMED"), anyOf(CONSTRAINT_TYPES.map((ty) => equals(t, "Type", ty)))];
  if (hasEffective) conditions.push(anyOf([filled(t, "Effective At", false), ...reachedBy("Effective At", clock)]));
  const rows = await firstRows(client, t, [{ filter: every(...conditions), sorts: [asc("Config ID")] }]);
  for (const r of rows) {
    must(is(r, "State", "CONFIRMED") && isOneOf(r, "Type", CONSTRAINT_TYPES) && idOf(r, "Config ID") > 0);
    // A returned future, undecidable, range or named-zone value makes the whole source ABSENT: never skipped or replaced.
    if (hasEffective && whenOf(r, "Effective At") !== undefined) must(pointDate(r, "Effective At") && reachedHere(r, "Effective At", clock));
  }
  strictly(rows, (a, b) => byId(a, b, "Config ID"));
  const target = new PointerTarget(client, runtime, clock);
  const out: Record<string, ContextValue>[] = [];
  for (const [i, r] of rows.entries()) {
    const declared = textOf(r, "Value") ?? "";
    const item: Record<string, ContextValue> = { ...project(r, ["config", "type"]), declared_value: declared, ...project(r, ["pointer_resource_key", "pointer_natural_key", "pointer_value_field"]) };
    // The eleventh row only announces an omission: it is never served, so its source is not re-read.
    if (i < SERVABLE) Object.assign(item, await target.reread(r, declared));
    out.push(item);
  }
  return present(key, out);
}

/**
 * E3: the declared pointer of one Runtime Configuration row, re-read at its only admitted source — the bound runtime's
 * own Business Configuration, discovered like every other resource — never through a URL the row carries.
 */
class PointerTarget {
  readonly client: NotionReadClient;
  readonly runtime: ResolvedRuntime;
  readonly clock: Clock;
  #table: Promise<Table | undefined> | undefined;
  constructor(client: NotionReadClient, runtime: ResolvedRuntime, clock: Clock) {
    this.client = client;
    this.runtime = runtime;
    this.clock = clock;
  }

  #open(): Promise<Table | undefined> {
    this.#table ??= (async () => {
      const spec = this.runtime.adapter.controlPlane.resources?.[POINTER_RESOURCE];
      if (!spec || (spec.scope ?? "RUNTIME") !== "RUNTIME" || spec.naturalKeyProperty !== CONFIG_ITEM) return undefined;
      const disc = await discoverDataSource(this.client, this.runtime, spec);
      if (!disc.ok) return undefined;
      const schema = await readSchema(this.client, disc.ds);
      if (!schema || schema.properties.get(CONFIG_ITEM) !== "title" || schema.properties.get(POINTER_FIELD) !== "rich_text" || schema.properties.get("State") !== "select") return undefined;
      const effective = schema.properties.get("Effective At");
      if (effective !== undefined && effective !== "date") return undefined;
      return { ds: disc.ds, schema };
    })();
    return this.#table;
  }

  async reread(row: Page, declared: string): Promise<{ reread_status: RereadStatus; reread_value?: string }> {
    const triplet = ["Pointer Resource Key", "Pointer Natural Key", "Pointer Value Field"].map((c) => textOf(row, c) ?? "");
    const filled = triplet.filter((v) => v.trim() !== "").length;
    if (filled === 0) return { reread_status: "NO_POINTER" };
    // A partial triplet is invalid, never completed by inference; only the published resource and field are admitted.
    const [resource, naturalKey, field] = triplet as [string, string, string];
    if (filled !== 3 || resource !== POINTER_RESOURCE || field !== POINTER_FIELD || naturalKey !== naturalKey.trim()) return { reread_status: "INVALID" };
    let found: Page[];
    let t: Table | undefined;
    try {
      t = await this.#open();
      if (!t) return { reread_status: "UNREADABLE" };
      // Two returned rows are enough to know the key is not single; the server's equality is re-proven on each.
      found = await firstRows(this.client, t, [{ filter: equals(t, CONFIG_ITEM, naturalKey), sorts: [] }], 2);
      if (found.some((p) => textOf(p, CONFIG_ITEM) !== naturalKey)) return { reread_status: "UNREADABLE" };
    } catch {
      return { reread_status: "UNREADABLE" };
    }
    if (found.length === 0) return { reread_status: "MISSING" };
    if (found.length > 1) return { reread_status: "AMBIGUOUS" };
    const target = found[0]!;
    // Only a CONFIRMED target already in effect can be compared; unconfirmed, future or undecidable is INVALID.
    if (!is(target, "State", "CONFIRMED")) return { reread_status: "INVALID" };
    const w = t.schema.properties.has("Effective At") ? whenOf(target, "Effective At") : undefined;
    if (w && reached(w, this.clock) !== true) return { reread_status: "INVALID" };
    const reread = textOf(target, POINTER_FIELD) ?? "";
    return { reread_status: reread === declared ? "MATCH" : "DRIFT", reread_value: reread };
  }
}
