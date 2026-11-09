/**
 * Read side of the Notion client (PV-WRITE-001 / W1.1).
 *
 * The HTTP client moved to client.ts, which reads exactly as before and adds the two allowlisted writes.
 * This module keeps the read-side names every caller already imports, the fixture client, and pagination.
 * `HttpNotionReadClient` stays a read-only view: it holds an HttpNotionClient and exposes its five reads only,
 * so read-only callers (scripts, tests) cannot reach a write even by type.
 */

import { HttpNotionClient, type NotionHttp, type NotionQueryOptions, type NotionReadClient, type NotionReadPolicy } from "./client.ts";

export { assertReadOnly, NotionApiError, NotionWriteRefused } from "./client.ts";
export type { NotionHttp, NotionQueryOptions, NotionReadClient, NotionReadPolicy } from "./client.ts";

export class HttpNotionReadClient implements NotionReadClient {
  readonly #client: HttpNotionClient;
  constructor(token: string, http: NotionHttp, policy: NotionReadPolicy = {}) {
    this.#client = new HttpNotionClient(token, http, policy);
  }
  retrievePage(pageId: string) { return this.#client.retrievePage(pageId); }
  retrieveDatabase(databaseId: string) { return this.#client.retrieveDatabase(databaseId); }
  retrieveDataSource(dataSourceId: string) { return this.#client.retrieveDataSource(dataSourceId); }
  retrieveBlockChildren(blockId: string, cursor?: string) { return this.#client.retrieveBlockChildren(blockId, cursor); }
  queryDataSource(dataSourceId: string, filter: unknown, cursor?: string, options?: NotionQueryOptions) { return this.#client.queryDataSource(dataSourceId, filter, cursor, options); }
}

/** Fixture client for HARNESS_ENV=fixture: no network at all. */
export class FixtureNotionReadClient implements NotionReadClient {
  readonly #fixtures: ReadonlyMap<string, unknown>;
  constructor(fixtures: ReadonlyMap<string, unknown>) {
    this.#fixtures = fixtures;
  }
  #get(key: string): unknown {
    if (!this.#fixtures.has(key)) throw new Error(`fixture missing: ${key}`);
    return this.#fixtures.get(key);
  }
  async retrievePage(pageId: string) { return this.#get(`page:${pageId}`); }
  async retrieveDatabase(databaseId: string) { return this.#get(`database:${databaseId}`); }
  async retrieveDataSource(dataSourceId: string) { return this.#get(`data_source:${dataSourceId}`); }
  async retrieveBlockChildren(blockId: string) { return this.#get(`children:${blockId}`); }
  async queryDataSource(dataSourceId: string) { return this.#get(`query:${dataSourceId}`); }
}

/** Reads every child block of a page/block, following pagination. */
export async function listAllChildren(client: NotionReadClient, blockId: string): Promise<readonly import("./shapes.ts").Block[]> {
  const out: import("./shapes.ts").Block[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 100; guard += 1) {
    const page = (await client.retrieveBlockChildren(blockId, cursor)) as import("./shapes.ts").BlockList;
    out.push(...page.results);
    if (!page.has_more || !page.next_cursor) return out;
    cursor = page.next_cursor;
  }
  throw new Error(`pagination guard exceeded for block ${blockId}`);
}
