/**
 * Per-call cache of the runtime's STRUCTURE (PV-WRITE-001, A.4): block children, databases and data sources are
 * read once per tool call. Pages and queries are never cached — they are the facts a transaction writes and
 * proves, and a cached one would be a stale proof. Create one instance per call and drop it afterwards.
 */
import type { NotionReadClient, NotionQueryOptions } from "./readClient.ts";

export class StructureCache implements NotionReadClient {
  readonly #inner: NotionReadClient;
  readonly #memo = new Map<string, Promise<unknown>>();

  constructor(inner: NotionReadClient) {
    this.#inner = inner;
  }

  #once(key: string, read: () => Promise<unknown>): Promise<unknown> {
    const hit = this.#memo.get(key);
    if (hit) return hit;
    // A failed read is not remembered: the next caller in the same call may try again.
    const p = read().catch((err: unknown) => { this.#memo.delete(key); throw err; });
    this.#memo.set(key, p);
    return p;
  }

  retrieveDatabase(databaseId: string) { return this.#once(`database:${databaseId}`, () => this.#inner.retrieveDatabase(databaseId)); }
  retrieveDataSource(dataSourceId: string) { return this.#once(`data_source:${dataSourceId}`, () => this.#inner.retrieveDataSource(dataSourceId)); }
  retrieveBlockChildren(blockId: string, cursor?: string) { return this.#once(`children:${blockId}:${cursor ?? ""}`, () => this.#inner.retrieveBlockChildren(blockId, cursor)); }
  retrievePage(pageId: string) { return this.#inner.retrievePage(pageId); }
  queryDataSource(dataSourceId: string, filter: unknown, cursor?: string, options?: NotionQueryOptions) { return this.#inner.queryDataSource(dataSourceId, filter, cursor, options); }
}
