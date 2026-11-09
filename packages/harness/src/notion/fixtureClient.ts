/**
 * Fixture Notion client with writes (PV-WRITE-001, A.7). It reads the same `Map` keys as FixtureNotionReadClient
 * (`page:`, `database:`, `data_source:`, `children:`, `query:`) and applies the two allowlisted writes the way
 * Notion does — a created row gets a parent data source, a last-edited time and a place in its data source's
 * query results; an update merges properties. Faults inject what a real network and a real Notion do to a write.
 *
 *   REJECT             4xx, nothing applied
 *   APPLY_THEN_FAIL    applied, then a 5xx: the caller cannot know it landed (ambiguous)
 *   LOSE               nothing applied, then a timeout (ambiguous)
 *   MUTATE             applied with other values (a concurrent editor, a bad mapping)
 *   DROP_FIELDS        applied without some fields
 *   DUPLICATE          a CREATE lands twice
 *   REDIRECT           an UPDATE lands on another page
 *   CRASH_BEFORE/AFTER the process dies before / after the write is applied (FixtureCrash)
 *   HIDE_FROM_QUERIES  a CREATE lands but data-source queries do not return it yet (index lag)
 *
 * Test-only by construction: nothing in the served process builds it.
 */
import { createHash } from "node:crypto";
import { NotionApiError, NotionWriteRefused, type NotionClient, type NotionProperties, type NotionWriteContext, type NotionWriteResult } from "./client.ts";
import { materializeProperty } from "./properties.ts";
import type { Page, PageProperty } from "./shapes.ts";

export type FaultKind = "REJECT" | "APPLY_THEN_FAIL" | "LOSE" | "MUTATE" | "DROP_FIELDS" | "DUPLICATE" | "REDIRECT" | "CRASH_BEFORE" | "CRASH_AFTER" | "HIDE_FROM_QUERIES";

export interface FaultMatch {
  readonly symbol?: string;
  readonly plan_id?: string;
  /** The nth write this client receives (1-based), whatever it is. */
  readonly nth?: number;
  readonly method?: "createPage" | "updatePage";
  /** How many matching writes the fault applies to (default 1). */
  readonly times?: number;
}

export interface FaultOptions {
  readonly status?: number;
  readonly code?: string;
  /** MUTATE: the REST properties actually applied. Default: the first field's value is replaced by a foreign one. */
  readonly mutate?: (properties: NotionProperties) => NotionProperties;
  /** DROP_FIELDS: the fields left out. Default: the last field. */
  readonly fields?: readonly string[];
  /** REDIRECT: the page the update lands on instead. */
  readonly redirect_to?: string;
}

export class FixtureCrash extends Error {
  override readonly name = "FixtureCrash";
}

export interface FixtureWrite {
  readonly n: number;
  readonly method: "createPage" | "updatePage";
  readonly target: string;
  readonly properties: NotionProperties;
  readonly ctx: NotionWriteContext;
  readonly fault?: FaultKind;
  /** Page(s) the write actually changed; empty when nothing was applied. */
  readonly applied: readonly string[];
}

interface ArmedFault { readonly match: FaultMatch; readonly kind: FaultKind; readonly options: FaultOptions; remaining: number }

const typeOf = (value: Readonly<Record<string, unknown>>): string => Object.keys(value)[0] as string;

export class FixtureNotionClient implements NotionClient {
  readonly map: Map<string, unknown>;
  readonly writes: FixtureWrite[] = [];
  /** A concurrent actor: called after every applied write, with the entry just logged. */
  onWrite?: (entry: FixtureWrite) => void;
  readonly #faults: ArmedFault[] = [];
  readonly #hidden = new Set<string>();
  readonly #now: () => Date;
  #created = 0;

  constructor(map: Map<string, unknown>, options: { now?: () => Date } = {}) {
    this.map = map;
    this.#now = options.now ?? (() => new Date("2030-01-01T00:30:00.000Z"));
  }

  fault(match: FaultMatch, kind: FaultKind, options: FaultOptions = {}): this {
    this.#faults.push({ match, kind, options, remaining: match.times ?? 1 });
    return this;
  }

  /** Ends every index lag: hidden rows become visible to queries. */
  revealAll(): void {
    this.#hidden.clear();
  }

  #get(key: string): unknown {
    if (!this.map.has(key)) throw new Error(`fixture missing: ${key}`);
    return this.map.get(key);
  }

  async retrievePage(pageId: string) { return this.#get(`page:${pageId}`); }
  async retrieveDatabase(databaseId: string) { return this.#get(`database:${databaseId}`); }
  async retrieveDataSource(dataSourceId: string) { return this.#get(`data_source:${dataSourceId}`); }
  async retrieveBlockChildren(blockId: string) { return this.#get(`children:${blockId}`); }
  async queryDataSource(dataSourceId: string) {
    const q = this.#get(`query:${dataSourceId}`) as { results?: Page[] };
    return { ...q, results: (q.results ?? []).filter((p) => !this.#hidden.has(p.id)) };
  }

  #take(method: FixtureWrite["method"], n: number, ctx: NotionWriteContext): ArmedFault | undefined {
    const f = this.#faults.find((x) => x.remaining > 0
      && (x.match.symbol === undefined || x.match.symbol === ctx.symbol)
      && (x.match.plan_id === undefined || x.match.plan_id === ctx.plan_id)
      && (x.match.method === undefined || x.match.method === method)
      && (x.match.nth === undefined || x.match.nth === n));
    if (f) f.remaining -= 1;
    return f;
  }

  #materialize(properties: NotionProperties): Record<string, PageProperty> {
    return Object.fromEntries(Object.entries(properties).map(([k, v]) => [k, materializeProperty(typeOf(v), v)]));
  }

  #rows(ds: string): Page[] {
    return ((this.map.get(`query:${ds}`) as { results?: Page[] } | undefined)?.results ?? []);
  }

  #setRows(ds: string, rows: Page[]): void {
    const prior = (this.map.get(`query:${ds}`) as Record<string, unknown> | undefined) ?? {};
    this.map.set(`query:${ds}`, { ...prior, results: rows });
  }

  #insert(ds: string, properties: NotionProperties, ctx: NotionWriteContext): Page {
    this.#created += 1;
    const id = createHash("sha256").update(`fixture-create:${ctx.plan_id}:${ctx.symbol}:${this.#created}`).digest("hex").slice(0, 32);
    const page: Page = { object: "page", id, archived: false, last_edited_time: this.#now().toISOString(), parent: { type: "data_source_id", data_source_id: ds }, properties: this.#materialize(properties) };
    this.map.set(`page:${id}`, page);
    this.#setRows(ds, [...this.#rows(ds), page]);
    return page;
  }

  #update(pageId: string, properties: NotionProperties): Page {
    const page = this.map.get(`page:${pageId}`) as Page | undefined;
    if (!page || page.archived || page.in_trash) throw new NotionApiError(404, "object_not_found", false, false, `fixture: page ${pageId} not found`);
    const updated: Page = { ...page, last_edited_time: this.#now().toISOString(), properties: { ...page.properties, ...this.#materialize(properties) } };
    this.map.set(`page:${pageId}`, updated);
    const ds = page.parent?.data_source_id;
    if (ds) this.#setRows(ds, this.#rows(ds).map((r) => (r.id === pageId ? updated : r)));
    return updated;
  }

  async #write(method: FixtureWrite["method"], target: string, properties: NotionProperties, ctx: NotionWriteContext): Promise<NotionWriteResult> {
    // The HTTP client guards the real wire (allowlist + body shape); the fixture holds its callers to the same
    // two shapes: a 32-hex target and a properties object, nothing else.
    if (!/^[0-9a-f]{32}$/.test(target.replace(/-/g, "")) || typeof properties !== "object" || properties === null || Array.isArray(properties)) {
      throw new NotionWriteRefused(`fixture: refused ${method} on ${target}: not an allowlisted write shape`);
    }
    const n = this.writes.length + 1;
    const f = this.#take(method, n, ctx);
    const log = (applied: readonly string[], props: NotionProperties = properties): FixtureWrite => {
      const entry: FixtureWrite = { n, method, target, properties: props, ctx, ...(f ? { fault: f.kind } : {}), applied };
      this.writes.push(entry);
      return entry;
    };
    const apply = (props: NotionProperties): Page => (method === "createPage" ? this.#insert(target, props, ctx) : this.#update(f?.kind === "REDIRECT" ? (f.options.redirect_to as string) : target, props));
    const done = (page: Page, entry: FixtureWrite): NotionWriteResult => { this.onWrite?.(entry); return { id: page.id, last_edited_time: page.last_edited_time ?? "" }; };

    switch (f?.kind) {
      case "REJECT": log([]); throw new NotionApiError(f.options.status ?? 400, f.options.code ?? "validation_error", false, (f.options.status ?? 400) === 409, `fixture: ${ctx.symbol} rejected`);
      case "LOSE": log([]); throw new NotionApiError("TIMEOUT", "timeout", true, true, `fixture: ${ctx.symbol} lost in transit`);
      case "CRASH_BEFORE": log([]); throw new FixtureCrash(`fixture: process died before ${ctx.symbol}`);
      case "APPLY_THEN_FAIL": { const page = apply(properties); done(page, log([page.id])); throw new NotionApiError(f.options.status ?? 502, f.options.code ?? "bad_gateway", true, true, `fixture: ${ctx.symbol} applied, then failed`); }
      case "CRASH_AFTER": { const page = apply(properties); done(page, log([page.id])); throw new FixtureCrash(`fixture: process died after ${ctx.symbol}`); }
      case "MUTATE": {
        const first = Object.keys(properties)[0];
        const mutated = f.options.mutate ? f.options.mutate(properties) : first ? { ...properties, [first]: { rich_text: [{ type: "text", text: { content: "FIXTURE — foreign value" } }] } } : properties;
        const page = apply(mutated);
        return done(page, log([page.id], mutated));
      }
      case "DROP_FIELDS": {
        const drop = new Set(f.options.fields ?? Object.keys(properties).slice(-1));
        const kept = Object.fromEntries(Object.entries(properties).filter(([k]) => !drop.has(k)));
        const page = apply(kept);
        return done(page, log([page.id], kept));
      }
      case "DUPLICATE": {
        const first = apply(properties);
        const second = method === "createPage" ? apply(properties) : first;
        return done(first, log([...new Set([first.id, second.id])]));
      }
      case "HIDE_FROM_QUERIES": {
        const page = apply(properties);
        this.#hidden.add(page.id);
        return done(page, log([page.id]));
      }
      default: {
        const page = apply(properties);
        return done(page, log([page.id]));
      }
    }
  }

  createPage(dataSourceId: string, properties: NotionProperties, ctx: NotionWriteContext): Promise<NotionWriteResult> {
    return this.#write("createPage", dataSourceId, properties, ctx);
  }
  updatePage(pageId: string, properties: NotionProperties, ctx: NotionWriteContext): Promise<NotionWriteResult> {
    return this.#write("updatePage", pageId, properties, ctx);
  }
}
