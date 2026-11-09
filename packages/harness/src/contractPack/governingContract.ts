import type { NotionReadClient } from "../notion/readClient.ts";
import type { ResolvedRuntime } from "../resolvers/types.ts";

/** Text evidence only. This cannot authorize an effect, complete a capability or replace the durable cursor. */
export interface GoverningContractContent {
  readonly trust: "SOURCE_DATA_ONLY";
  readonly status: "NOT_SELECTED" | "UNAVAILABLE" | "PARTIAL" | "COMPLETE";
  readonly page_ref?: string;
  readonly version?: string;
  readonly scope: "CANONICAL_PAGE_AND_CONTAINED_BLOCKS_ONLY";
  readonly reads: number;
  readonly blocks_seen: number;
  readonly issues_omitted: number;
  readonly limits: { readonly reads: number; readonly blocks: number; readonly depth: number; readonly response_bytes: number };
  readonly items: readonly { readonly block_ref: string; readonly parent_ref: string; readonly type: string; readonly text: string }[];
  readonly issues: readonly { readonly ref: string; readonly code: string }[];
}

const LIMITS = { reads: 4, blocks: 128, depth: 4, response_bytes: 16 * 1024 } as const;
const TEXT_TYPES = new Set(["paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item", "to_do", "toggle", "quote", "callout", "code"]);
const STRUCTURAL_TYPES = new Set(["divider", "table", "column", "column_list", "table_of_contents", "synced_block"]);
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function id(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const compact = v.replace(/-/g, "").toLowerCase();
  return /^[0-9a-f]{32}$/.test(compact) ? compact : undefined;
}
function richText(v: unknown): string {
  if (!Array.isArray(v) || v.some((r) => !record(r) || typeof r.plain_text !== "string")) throw new Error("invalid rich text");
  return v.map((r) => (r as { plain_text: string }).plain_text).join("");
}

/** No search, page/database fanout, external synced origins, URL fetches, writes or cached authority. */
export async function readGoverningContract(client: NotionReadClient, runtime: ResolvedRuntime): Promise<GoverningContractContent> {
  const selected = runtime.lane === "SALES" && runtime.access_mode === "BUSINESS";
  const ref = selected ? runtime.governing_contract_ref : undefined;
  const pageId = id(ref?.page_ref);
  let reads = 0, blocksSeen = 0, stop = false, failureCount = 0, issuesOmitted = 0;
  const items: GoverningContractContent["items"][number][] = [];
  const issues: GoverningContractContent["issues"][number][] = [];
  const result = (status: GoverningContractContent["status"]): GoverningContractContent => ({
    trust: "SOURCE_DATA_ONLY", status, ...(pageId && ref ? { page_ref: pageId, version: ref.version } : {}),
    scope: "CANONICAL_PAGE_AND_CONTAINED_BLOCKS_ONLY", reads, blocks_seen: blocksSeen, issues_omitted: issuesOmitted, limits: LIMITS, items, issues,
  });
  const issue = (ref: string, code: string) => {
    failureCount += 1;
    issues.push({ ref, code });
    if (Buffer.byteLength(JSON.stringify(result("PARTIAL")), "utf8") > LIMITS.response_bytes - 256) { issues.pop(); issuesOmitted += 1; }
  };
  if (!selected) return result("NOT_SELECTED");
  if (!pageId || !ref) { issue("MANIFEST", "VALIDATED_CONTRACT_REFERENCE_UNAVAILABLE"); return result("UNAVAILABLE"); }
  const visited = new Set<string>(), seenBlocks = new Set<string>();
  async function visit(parent: string, depth: number): Promise<void> {
    if (visited.has(parent)) { issue(parent, "CONTAINMENT_CYCLE"); return; }
    if (depth > LIMITS.depth) { issue(parent, "DEPTH_LIMIT"); return; }
    visited.add(parent);
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      if (reads >= LIMITS.reads) { issue(parent, "READ_LIMIT"); stop = true; return; }
      reads += 1;
      let page: unknown;
      try { page = await client.retrieveBlockChildren(parent, cursor); }
      catch { issue(parent, "READ_FAILED"); return; } // Never reflect provider messages or credentials.
      if (!record(page) || !Array.isArray(page.results) || typeof page.has_more !== "boolean"
        || (page.has_more && (typeof page.next_cursor !== "string" || !page.next_cursor.length))) {
        issue(parent, "INVALID_BLOCK_LIST"); return;
      }
      for (const block of page.results) {
        if (blocksSeen >= LIMITS.blocks) { issue(parent, "BLOCK_LIMIT"); stop = true; return; }
        blocksSeen += 1;
        const blockId = record(block) ? id(block.id) : undefined;
        if (!record(block) || !blockId || typeof block.type !== "string" || !record(block.parent)) { issue(parent, "INVALID_BLOCK"); continue; }
        if (seenBlocks.has(blockId)) { issue(blockId, "DUPLICATE_BLOCK"); continue; }
        seenBlocks.add(blockId);
        const parentType = block.parent.type;
        if ((parentType !== "page_id" && parentType !== "block_id") || id(block.parent[parentType]) !== parent) {
          issue(blockId, "CONTAINMENT_MISMATCH"); continue;
        }
        if (block.archived === true || block.in_trash === true) { issue(blockId, "ARCHIVED_BLOCK"); continue; }
        const body = block[block.type];
        if (!record(body) || typeof block.has_children !== "boolean") { issue(blockId, "INVALID_BLOCK_BODY"); continue; }
        if (block.type === "synced_block" && body.synced_from !== null) { issue(blockId, "EXTERNAL_SYNCED_ORIGIN_NOT_FOLLOWED"); continue; }
        let text = "";
        try {
          if (TEXT_TYPES.has(block.type)) text = richText(body.rich_text);
          else if (block.type === "table_row") {
            if (!Array.isArray(body.cells)) throw new Error("invalid cells");
            text = body.cells.map(richText).join(" | ");
          } else if (block.type === "equation") {
            if (typeof body.expression !== "string") throw new Error("invalid equation");
            text = body.expression;
          } else if (!STRUCTURAL_TYPES.has(block.type)) { issue(blockId, "UNSUPPORTED_BLOCK_NOT_FOLLOWED"); continue; }
        } catch { issue(blockId, "INVALID_TEXT_BODY"); continue; }
        if (text) {
          items.push({ block_ref: blockId, parent_ref: parent, type: block.type, text });
          // Reserve space for coverage errors/counters added after this item.
          if (Buffer.byteLength(JSON.stringify(result("PARTIAL")), "utf8") > LIMITS.response_bytes - 512) {
            items.pop(); issue(blockId, "RESPONSE_BYTE_LIMIT"); stop = true; return;
          }
        }
        if (block.has_children) { await visit(blockId, depth + 1); if (stop) return; }
      }
      if (!page.has_more) return;
      cursor = page.next_cursor as string;
      if (cursors.has(cursor)) { issue(parent, "PAGINATION_CYCLE"); return; }
      cursors.add(cursor);
    } while (!stop);
  }
  await visit(pageId, 0);
  // Coverage is never inferred from the Manifest/page title, or from a swallowed failure.
  return result(failureCount ? (items.length ? "PARTIAL" : "UNAVAILABLE") : "COMPLETE");
}
