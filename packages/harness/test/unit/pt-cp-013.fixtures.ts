import {
  FixtureNotionReadClient,
  type NotionQueryOptions,
  type NotionReadClient,
} from "../../src/notion/readClient.ts";
import type { Page } from "../../src/notion/shapes.ts";
import { synthetic } from "./meta-fixtures.ts";

type ChildBlock = {
  object?: string;
  id: string;
  type?: string;
  [key: string]: unknown;
};

type ChildList = {
  results: ChildBlock[];
  has_more: false;
  next_cursor: null;
};

function readChildren(map: Map<string, unknown>, key: string): ChildBlock[] {
  const existing = map.get(key) as { results?: unknown } | undefined;
  return Array.isArray(existing?.results) ? [...(existing.results as ChildBlock[])] : [];
}

function ensureNamedChild(
  map: Map<string, unknown>,
  parentId: string,
  kind: "child_page" | "child_database",
  title: string,
  seed: string,
): string {
  const key = `children:${parentId}`;
  const results = readChildren(map, key);
  const found = results.find(
    (block) =>
      block.type === kind &&
      (block[kind] as { title?: unknown } | undefined)?.title === title,
  );
  if (found) return found.id;
  const id = synthetic(seed);
  results.push({ object: "block", id, type: kind, [kind]: { title } });
  const list: ChildList = { results, has_more: false, next_cursor: null };
  map.set(key, list);
  return id;
}

export function installDailyTable(
  map: Map<string, unknown>,
  rootId: string,
  parentTitle: string,
  databaseTitle: string,
  properties: Record<string, { type: string; relation?: { data_source_id: string } }>,
): { db: string; ds: string } {
  const parent = ensureNamedChild(
    map,
    rootId,
    "child_page",
    parentTitle,
    `daily-parent:${rootId}:${parentTitle}`,
  );
  const db = ensureNamedChild(
    map,
    parent,
    "child_database",
    databaseTitle,
    `daily-database:${parent}:${databaseTitle}`,
  );
  const ds = synthetic(`daily-data-source:${db}`);
  map.set(`database:${db}`, { object: "database", id: db, data_sources: [{ id: ds }] });
  map.set(`data_source:${ds}`, { properties });
  return { db, ds };
}

type ReadOperation =
  | "retrievePage"
  | "retrieveDatabase"
  | "retrieveDataSource"
  | "retrieveBlockChildren";

export interface RecordedRead {
  readonly operation: ReadOperation;
  readonly args: readonly unknown[];
}

export interface RecordedQuery {
  readonly dataSourceId: string;
  readonly filter: unknown;
  readonly cursor: string | null | undefined;
  readonly options: NotionQueryOptions | undefined;
}

export type QueryHandler = (
  filter: unknown,
  options: NotionQueryOptions | undefined,
) => readonly Page[];

const DEFAULT_PAGE_SIZE = 11;

function parseCursor(cursor: string | null | undefined): number {
  if (cursor === undefined || cursor === null || cursor === "") return 0;
  if (!/^\d+$/.test(cursor)) {
    throw new Error(`DailyClient: invalid fake cursor "${cursor}"`);
  }
  return Number(cursor);
}

function resolvePageSize(options: NotionQueryOptions | undefined): number {
  const raw = (options as { page_size?: unknown } | undefined)?.page_size;
  if (raw === undefined || raw === null) return DEFAULT_PAGE_SIZE;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    throw new Error(`DailyClient: invalid page_size ${String(raw)}`);
  }
  return raw;
}

/**
 * Fake Notion read client for PT-CP-013 daily tests.
 *
 * Retrieval calls delegate to FixtureNotionReadClient. Queries are answered by
 * per-data-source handlers so each test explicitly models server-side
 * selection and sorting; this client only applies pagination. Cursors are
 * opaque numeric offsets meaningful only to this fake.
 */
export class DailyClient implements NotionReadClient {
  public readonly reads: RecordedRead[] = [];
  public readonly queries: RecordedQuery[] = [];
  public readonly queryHandlers = new Map<string, QueryHandler>();

  private readonly inner: FixtureNotionReadClient;

  constructor(fixtures: Map<string, unknown>) {
    this.inner = new FixtureNotionReadClient(fixtures);
  }

  retrievePage(
    ...args: Parameters<NotionReadClient["retrievePage"]>
  ): ReturnType<NotionReadClient["retrievePage"]> {
    this.reads.push({ operation: "retrievePage", args: [...args] });
    return this.inner.retrievePage(...args);
  }

  retrieveDatabase(
    ...args: Parameters<NotionReadClient["retrieveDatabase"]>
  ): ReturnType<NotionReadClient["retrieveDatabase"]> {
    this.reads.push({ operation: "retrieveDatabase", args: [...args] });
    return this.inner.retrieveDatabase(...args);
  }

  retrieveDataSource(
    ...args: Parameters<NotionReadClient["retrieveDataSource"]>
  ): ReturnType<NotionReadClient["retrieveDataSource"]> {
    this.reads.push({ operation: "retrieveDataSource", args: [...args] });
    return this.inner.retrieveDataSource(...args);
  }

  retrieveBlockChildren(
    ...args: Parameters<NotionReadClient["retrieveBlockChildren"]>
  ): ReturnType<NotionReadClient["retrieveBlockChildren"]> {
    this.reads.push({ operation: "retrieveBlockChildren", args: [...args] });
    return this.inner.retrieveBlockChildren(args[0]);
  }

  queryDataSource(
    ...args: Parameters<NotionReadClient["queryDataSource"]>
  ): ReturnType<NotionReadClient["queryDataSource"]> {
    const [dataSourceId, filter, cursor, options] = args as unknown as [
      string,
      unknown,
      string | null | undefined,
      NotionQueryOptions | undefined,
    ];
    this.queries.push({ dataSourceId, filter, cursor, options });

    const handler = this.queryHandlers.get(dataSourceId);
    if (!handler) {
      return Promise.reject(
        new Error(`DailyClient: no query handler for data source ${dataSourceId}`),
      ) as unknown as ReturnType<NotionReadClient["queryDataSource"]>;
    }

    let result: { results: Page[]; has_more: boolean; next_cursor: string | null };
    try {
      const rows = handler(filter, options);
      const pageSize = resolvePageSize(options);
      const offset = parseCursor(cursor);
      const end = offset + pageSize;
      const hasMore = end < rows.length;
      result = {
        results: rows.slice(offset, end),
        has_more: hasMore,
        next_cursor: hasMore ? String(end) : null,
      };
    } catch (error) {
      return Promise.reject(error) as unknown as ReturnType<
        NotionReadClient["queryDataSource"]
      >;
    }

    return Promise.resolve(result) as unknown as ReturnType<
      NotionReadClient["queryDataSource"]
    >;
  }
}
