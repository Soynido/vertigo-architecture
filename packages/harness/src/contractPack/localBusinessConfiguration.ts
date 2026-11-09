import type { NotionReadClient } from "../notion/readClient.ts";
import type { ResolvedRuntime } from "../resolvers/types.ts";

type Status = "NOT_SELECTED" | "UNAVAILABLE" | "PARTIAL" | "COMPLETE";
type Issue = { readonly ref: string; readonly code: string };
type Cell = string | null | Readonly<Record<string, unknown>>;
export interface LocalBusinessConfiguration {
  readonly trust: "SOURCE_DATA_ONLY";
  readonly scope: "CONTAINED_HISTORICAL_BUSINESS_CONFIGURATION_ONLY";
  readonly status: Status;
  readonly root_ref?: string;
  readonly database_ref?: string;
  readonly data_source_ref?: string;
  readonly effectivity: "NOT_EVALUATED";
  readonly atomic: false;
  readonly stability: "NOT_VERIFIED";
  readonly references_followed: false;
  readonly reads: number;
  readonly blocks_seen: number;
  readonly rows_seen: number;
  readonly issues_omitted: number;
  readonly limits: typeof LIMITS;
  /** Observed declarations, including RETIRED rows. Not reconciled/active configuration or permission evidence. */
  readonly observed_rows: readonly { readonly page_ref: string; readonly values: Readonly<Record<string, Cell>> }[];
  readonly issues: readonly Issue[];
}

const LIMITS = { reads: 10, discovery_blocks: 256, rows: 100, response_bytes: 32 * 1024 } as const;
const FIELDS: Readonly<Record<string, string>> = {
  "Config Item": "title", Category: "select", State: "select", Value: "rich_text", Version: "rich_text",
  "Config ID": "unique_id", "Effective At": "date", Source: "rich_text", Notes: "rich_text",
};
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function id(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const compact = v.replace(/-/g, "").toLowerCase();
  return /^[0-9a-f]{32}$/.test(compact) ? compact : undefined;
}
function parent(v: Record<string, unknown>, type: string, ref: string): boolean {
  return record(v.parent) && v.parent.type === type && id(v.parent[type]) === ref;
}
function text(v: unknown): string {
  if (!Array.isArray(v) || v.some((r) => !record(r) || typeof r.plain_text !== "string")) throw new Error("INVALID_TEXT");
  return v.map((r) => (r as { plain_text: string }).plain_text).join("");
}
function titled(v: Record<string, unknown>, expected: string): boolean {
  try { return text(v.title) === expected; } catch { return false; }
}
function cell(v: unknown, type: string): Cell {
  if (!record(v) || v.type !== type) throw new Error("INVALID_CELL");
  const body = v[type];
  if (type === "title" || type === "rich_text") return text(body);
  if (type === "select") {
    if (body === null) return null;
    if (!record(body) || typeof body.name !== "string") throw new Error("INVALID_SELECT");
    return body.name;
  }
  if (type === "unique_id") {
    if (!record(body) || !Number.isSafeInteger(body.number) || (body.number as number) < 0 || (body.prefix !== null && typeof body.prefix !== "string")) throw new Error("INVALID_ID");
    return { number: body.number, prefix: body.prefix };
  }
  if (type === "date") {
    if (body === null) return null;
    if (!record(body) || typeof body.start !== "string" || (body.end !== null && typeof body.end !== "string")
      || (body.time_zone !== null && typeof body.time_zone !== "string")) throw new Error("INVALID_DATE");
    return { start: body.start, end: body.end, time_zone: body.time_zone }; // No date parsing or inferred zone.
  }
  throw new Error("UNSUPPORTED_CELL");
}

/** Read-only legacy context. D7-redacted candidate resources keep their existing selected_context projector. */
export async function readLocalBusinessConfiguration(client: NotionReadClient, runtime: ResolvedRuntime, selected: boolean): Promise<LocalBusinessConfiguration> {
  const root = id(runtime.root_ref), observed_rows: { page_ref: string; values: Record<string, Cell> }[] = [], issues: Issue[] = [];
  let reads = 0, blocks = 0, rowsSeen = 0, omitted = 0, failed = false, stopped = false;
  let database: string | undefined, ds: string | undefined;
  const result = (status: Status): LocalBusinessConfiguration => ({
    trust: "SOURCE_DATA_ONLY", scope: "CONTAINED_HISTORICAL_BUSINESS_CONFIGURATION_ONLY", status,
    ...(root && status !== "NOT_SELECTED" ? { root_ref: root } : {}),
    ...(database ? { database_ref: database } : {}), ...(ds ? { data_source_ref: ds } : {}),
    effectivity: "NOT_EVALUATED", atomic: false, stability: "NOT_VERIFIED", references_followed: false,
    reads, blocks_seen: blocks, rows_seen: rowsSeen, issues_omitted: omitted, limits: LIMITS, observed_rows, issues,
  });
  const issue = (ref: string, code: string) => {
    failed = true; issues.push({ ref, code });
    if (Buffer.byteLength(JSON.stringify(result("PARTIAL"))) > LIMITS.response_bytes - 256) { issues.pop(); omitted += 1; }
  };
  const finish = () => result(failed ? observed_rows.length ? "PARTIAL" : "UNAVAILABLE" : "COMPLETE");
  if (!selected || runtime.lane !== "SALES" || runtime.access_mode !== "BUSINESS") return result("NOT_SELECTED");
  if (runtime.adapter.controlPlane.resources?.["SALES:BUSINESS_CONFIG"]?.redactValues) {
    issue("ADAPTER", "VALUES_REQUIRE_EXISTING_D7_PROJECTOR"); return finish();
  }
  if (!root) { issue("RUNTIME", "INVALID_ROOT"); return finish(); }
  const paths = (runtime.adapter.controlPlane.installContract?.physicalResources ?? []).filter((p) => p.key === "BUSINESS_CONFIG");
  const path = paths[0];
  if (paths.length !== 1 || !path || path.objectType !== "DATABASE" || path.path.length !== 2 || !path.path.every((p) => p.length)
    || !path.requiredProperties || Object.entries(path.requiredProperties).some(([k, t]) => FIELDS[k] !== t)
    || Object.entries(FIELDS).slice(0, 5).some(([k, t]) => path.requiredProperties?.[k] !== t)) {
    issue("ADAPTER", "BUSINESS_CONFIGURATION_PATH_OR_SCHEMA_UNAVAILABLE"); return finish();
  }
  async function read(ref: string, fn: () => Promise<unknown>): Promise<unknown> {
    if (stopped || reads >= LIMITS.reads) { issue(ref, "READ_LIMIT"); stopped = true; return undefined; }
    reads += 1;
    try { return await fn(); } catch { issue(ref, "READ_FAILED"); return undefined; }
  }
  async function page(ref: string, owner?: string): Promise<boolean> {
    const v = await read(ref, () => client.retrievePage(ref));
    if (v === undefined) return false;
    if (!record(v) || v.object !== "page" || id(v.id) !== ref || v.archived !== false || v.in_trash === true || (owner && !parent(v, "page_id", owner))) {
      issue(ref, "INVALID_PAGE_CONTAINMENT_OR_ACTIVITY"); return false;
    }
    return true;
  }
  const blockIds = new Set<string>();
  async function child(owner: string, kind: "child_page" | "child_database", title: string): Promise<string | undefined> {
    const matches: string[] = [], cursors = new Set<string>(); let cursor: string | undefined;
    do {
      const v = await read(owner, () => client.retrieveBlockChildren(owner, cursor));
      if (v === undefined) return undefined;
      if (!record(v) || !Array.isArray(v.results) || typeof v.has_more !== "boolean"
        || (v.has_more ? typeof v.next_cursor !== "string" || !v.next_cursor.length : v.next_cursor !== null)) {
        issue(owner, "INVALID_CHILD_LIST"); return undefined;
      }
      for (const b of v.results) {
        if (blocks >= LIMITS.discovery_blocks) { issue(owner, "DISCOVERY_BLOCK_LIMIT"); stopped = true; return undefined; }
        blocks += 1; const ref = record(b) ? id(b.id) : undefined;
        if (!record(b) || !ref || !parent(b, "page_id", owner) || blockIds.has(ref)) { issue(owner, "INVALID_OR_DUPLICATE_CHILD"); return undefined; }
        blockIds.add(ref);
        if (b.type === kind && record(b[kind]) && b[kind].title === title) {
          if (b.archived !== false || b.in_trash === true) { issue(ref, "INACTIVE_CHILD"); return undefined; }
          matches.push(ref);
        }
      }
      if (!v.has_more) break;
      cursor = v.next_cursor as string;
      if (cursors.has(cursor)) { issue(owner, "CHILD_PAGINATION_CYCLE"); return undefined; }
      cursors.add(cursor);
    } while (!stopped);
    if (matches.length !== 1) { issue(owner, "MISSING_OR_AMBIGUOUS_CHILD"); return undefined; }
    return matches[0];
  }
  if (!await page(root)) return finish();
  const setup = await child(root, "child_page", path.path[0]!);
  if (!setup || !await page(setup, root)) return finish();
  database = await child(setup, "child_database", path.path[1]!);
  if (!database) return finish();
  const db = await read(database, () => client.retrieveDatabase(database!));
  if (db === undefined) return finish();
  if (!record(db) || db.object !== "database" || id(db.id) !== database || db.archived !== false || db.in_trash === true
    || !parent(db, "page_id", setup) || !titled(db, path.path[1]!) || !Array.isArray(db.data_sources) || db.data_sources.length !== 1
    || !record(db.data_sources[0]) || !(ds = id(db.data_sources[0].id))) {
    issue(database, "INVALID_DATABASE_CONTAINMENT_OR_SOURCE"); return finish();
  }
  const source = await read(ds, () => client.retrieveDataSource(ds!));
  if (source === undefined) return finish();
  if (!record(source) || source.object !== "data_source" || id(source.id) !== ds || source.archived !== false || source.in_trash === true
    || !parent(source, "database_id", database) || !titled(source, path.path[1]!) || !record(source.properties)) {
    issue(ds, "INVALID_SOURCE_CONTAINMENT_OR_ACTIVITY"); return finish();
  }
  const schema = source.properties;
  if (Object.values(schema).filter((p) => record(p) && p.type === "title").length !== 1
    || Object.entries(path.requiredProperties).some(([k, t]) => !record(schema[k]) || schema[k].type !== t)
    || Object.entries(FIELDS).some(([k, t]) => schema[k] !== undefined && (!record(schema[k]) || schema[k].type !== t))) {
    issue(ds, "INVALID_CONFIGURATION_SCHEMA"); return finish();
  }
  const rowIds = new Set<string>(), keys = new Set<string>(), cursors = new Set<string>(); let cursor: string | undefined;
  do {
    const v = await read(ds, () => client.queryDataSource(ds!, undefined, cursor, { page_size: 100 }));
    if (v === undefined) break;
    if (!record(v) || !Array.isArray(v.results) || typeof v.has_more !== "boolean"
      || (v.has_more ? typeof v.next_cursor !== "string" || !v.next_cursor.length : v.next_cursor !== null)) { issue(ds, "INVALID_ROW_LIST"); break; }
    for (const row of v.results) {
      if (rowsSeen >= LIMITS.rows) { issue(ds, "ROW_LIMIT"); stopped = true; break; }
      rowsSeen += 1; const ref = record(row) ? id(row.id) : undefined;
      if (!record(row) || row.object !== "page" || !ref || !parent(row, "data_source_id", ds) || row.archived !== false || row.in_trash === true
        || rowIds.has(ref) || !record(row.properties)) { issue(ds, "INVALID_OR_DUPLICATE_ROW"); stopped = true; break; }
      rowIds.add(ref); const values: Record<string, Cell> = {};
      try {
        for (const [field, type] of Object.entries(FIELDS)) if (schema[field] !== undefined) values[field] = cell(row.properties[field], type);
      } catch { issue(ref, "INVALID_CONFIGURATION_CELL"); stopped = true; break; }
      const naturalKey = values["Config Item"];
      if (typeof naturalKey !== "string" || !naturalKey.length) { issue(ref, "EMPTY_CONFIGURATION_KEY"); stopped = true; break; }
      if (keys.has(naturalKey)) issue(ref, "DUPLICATE_CONFIGURATION_KEY");
      keys.add(naturalKey);
      observed_rows.push({ page_ref: ref, values });
      if (Buffer.byteLength(JSON.stringify(result("PARTIAL"))) > LIMITS.response_bytes - 1024) {
        observed_rows.pop(); issue(ref, "RESPONSE_BYTE_LIMIT"); stopped = true; break;
      }
    }
    if (stopped || !v.has_more) break;
    cursor = v.next_cursor as string;
    if (cursors.has(cursor)) { issue(ds, "ROW_PAGINATION_CYCLE"); break; }
    cursors.add(cursor);
  } while (!stopped);
  return finish();
}
