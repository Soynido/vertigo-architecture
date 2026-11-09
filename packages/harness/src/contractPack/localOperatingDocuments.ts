import type { NotionReadClient } from "../notion/readClient.ts";
import type { ResolvedRuntime } from "../resolvers/types.ts";

type Status = "NOT_SELECTED" | "UNAVAILABLE" | "PARTIAL" | "COMPLETE";
type Issue = { readonly ref: string; readonly code: string };
type Item = { readonly block_ref: string; readonly parent_ref: string; readonly type: string; readonly text: string };
type Document = {
  readonly role: "DAILY_GO" | "DECISION_ENGINE";
  readonly title: string;
  readonly page_ref: string;
  readonly last_edited_time?: string;
  status: Status;
  readonly items: Item[];
  readonly issues: Issue[];
};

/** Observed local text, NOT authority, capability evidence, a reconciled configuration or a production plan. */
export interface LocalOperatingDocuments {
  readonly trust: "SOURCE_DATA_ONLY";
  readonly scope: "CONTAINED_LOCAL_OPERATING_DOCUMENTS_ONLY";
  readonly status: Status;
  readonly root_ref?: string;
  readonly atomic: false;
  readonly stability: "NOT_VERIFIED";
  readonly references_followed: false;
  readonly reads: number;
  readonly blocks_seen: number;
  readonly issues_omitted: number;
  readonly limits: { readonly reads: number; readonly blocks: number; readonly depth: number; readonly response_bytes: number };
  readonly documents: readonly Document[];
  readonly issues: readonly Issue[];
}

// Separate from the small shared-contract budget: existing local manuals can have multiple pages of blocks.
const LIMITS = { reads: 12, blocks: 512, depth: 4, response_bytes: 96 * 1024 } as const;
const ROLES = ["DAILY_GO", "DECISION_ENGINE"] as const;
const TEXT_TYPES = new Set(["paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item", "to_do", "toggle", "quote", "callout", "code"]);
const STRUCTURAL_TYPES = new Set(["divider", "table", "column", "column_list", "table_of_contents", "synced_block"]);
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function id(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const compact = v.replace(/-/g, "").toLowerCase();
  return /^[0-9a-f]{32}$/.test(compact) ? compact : undefined;
}
function contained(v: Record<string, unknown>, parent: string): boolean {
  const p = v.parent;
  return record(p) && (p.type === "page_id" || p.type === "block_id") && id(p[p.type]) === parent;
}
function richText(v: unknown): string {
  if (!Array.isArray(v) || v.some((r) => !record(r) || typeof r.plain_text !== "string")) throw new Error("invalid text");
  return v.map((r) => (r as { plain_text: string }).plain_text).join("");
}

/**
 * Only two existing PAGE paths declared by the bound adapter, never a registry copy, caller ref or URL.
 * `selected` is the handler's already-guarded CURRENT_WORK selection; it grants no new read lane on a HOLD.
 */
export async function readLocalOperatingDocuments(client: NotionReadClient, runtime: ResolvedRuntime, selected: boolean): Promise<LocalOperatingDocuments> {
  const root = id(runtime.root_ref);
  const documents: Document[] = [], issues: Issue[] = [];
  let reads = 0, blocksSeen = 0, failures = 0, issuesOmitted = 0, stopped = false;
  const result = (status: Status): LocalOperatingDocuments => ({
    trust: "SOURCE_DATA_ONLY", scope: "CONTAINED_LOCAL_OPERATING_DOCUMENTS_ONLY", status,
    ...(root && status !== "NOT_SELECTED" ? { root_ref: root } : {}), atomic: false, stability: "NOT_VERIFIED", references_followed: false,
    reads, blocks_seen: blocksSeen, issues_omitted: issuesOmitted, limits: LIMITS, documents, issues,
  });
  const issue = (ref: string, code: string, doc?: Document) => {
    failures += 1;
    const target = doc?.issues ?? issues;
    target.push({ ref, code });
    if (Buffer.byteLength(JSON.stringify(result("PARTIAL"))) > LIMITS.response_bytes - 256) { target.pop(); issuesOmitted += 1; }
  };
  if (!selected || runtime.lane !== "SALES" || runtime.access_mode !== "BUSINESS") return result("NOT_SELECTED");
  if (!root) { issue("RUNTIME", "INVALID_ROOT"); return result("UNAVAILABLE"); }
  const cp = runtime.adapter.controlPlane;
  const paths = ROLES.map((role) => (cp.installContract?.physicalResources ?? []).filter((p) => p.key === role));
  if (!cp.parentTitle || paths.some((p) => p.length !== 1 || p[0]!.objectType !== "PAGE"
    || p[0]!.path.length !== 2 || p[0]!.path[0] !== cp.parentTitle || !p[0]!.path[1])) {
    issue("ADAPTER", "LOCAL_DOCUMENT_PATHS_UNAVAILABLE"); return result("UNAVAILABLE");
  }
  async function read(ref: string, method: "retrievePage" | "retrieveBlockChildren", cursor?: string, doc?: Document): Promise<unknown> {
    if (stopped || reads >= LIMITS.reads) { issue(ref, "READ_LIMIT", doc); stopped = true; return undefined; }
    reads += 1;
    try { return method === "retrievePage" ? await client.retrievePage(ref) : await client.retrieveBlockChildren(ref, cursor); }
    catch { issue(ref, "READ_FAILED", doc); return undefined; } // Never echo provider errors or credentials.
  }
  async function page(ref: string, parent?: string, doc?: Document): Promise<Record<string, unknown> | undefined> {
    const p = await read(ref, "retrievePage", undefined, doc);
    if (p === undefined) return undefined;
    if (!record(p) || p.object !== "page" || id(p.id) !== ref || p.archived !== false || p.in_trash === true
      || (parent !== undefined && !contained(p, parent))) { issue(ref, "INVALID_PAGE_CONTAINMENT_OR_ACTIVITY", doc); return undefined; }
    return p;
  }
  const seenBlocks = new Set<string>(), visited = new Set<string>();
  async function list(parent: string, consume: (b: Record<string, unknown>, ref: string) => Promise<void>, doc?: Document): Promise<boolean> {
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const v = await read(parent, "retrieveBlockChildren", cursor, doc);
      if (v === undefined) return false;
      if (!record(v) || !Array.isArray(v.results) || typeof v.has_more !== "boolean"
        || (v.has_more ? typeof v.next_cursor !== "string" || !v.next_cursor.length : v.next_cursor !== null)) {
        issue(parent, "INVALID_BLOCK_LIST", doc); return false;
      }
      for (const b of v.results) {
        if (blocksSeen >= LIMITS.blocks) { issue(parent, "BLOCK_LIMIT", doc); stopped = true; return false; }
        blocksSeen += 1;
        const ref = record(b) ? id(b.id) : undefined;
        if (!record(b) || !ref || typeof b.type !== "string" || !contained(b, parent) || seenBlocks.has(ref)) {
          issue(parent, "INVALID_OR_DUPLICATE_CONTAINED_BLOCK", doc); return false;
        }
        seenBlocks.add(ref);
        await consume(b, ref);
        if (stopped) return false;
      }
      if (!v.has_more) return true;
      cursor = v.next_cursor as string;
      if (cursors.has(cursor)) { issue(parent, "PAGINATION_CYCLE", doc); return false; }
      cursors.add(cursor);
    } while (!stopped);
    return false;
  }
  async function children(parent: string): Promise<Record<string, unknown>[] | undefined> {
    const rows: Record<string, unknown>[] = [];
    return await list(parent, async (b) => { rows.push(b); }) ? rows : undefined;
  }
  function child(rows: Record<string, unknown>[], title: string): string | undefined {
    const matches = rows.filter((b) => b.type === "child_page" && record(b.child_page) && b.child_page.title === title);
    if (matches.length !== 1) { issue("PATH", "MISSING_OR_AMBIGUOUS_LOCAL_PAGE"); return undefined; }
    const match = matches[0]!;
    if (match.archived !== false || match.in_trash === true) { issue("PATH", "INACTIVE_LOCAL_PAGE"); return undefined; }
    return id(match.id);
  }
  if (!await page(root)) return result("UNAVAILABLE");
  const rootChildren = await children(root);
  if (!rootChildren) return result("UNAVAILABLE");
  const control = child(rootChildren, cp.parentTitle);
  if (!control || !await page(control, root)) return result("UNAVAILABLE");
  const controlChildren = await children(control);
  if (!controlChildren) return result("UNAVAILABLE");

  async function visit(parent: string, depth: number, doc: Document): Promise<void> {
    if (visited.has(parent)) { issue(parent, "CONTAINMENT_CYCLE", doc); return; }
    if (depth > LIMITS.depth) { issue(parent, "DEPTH_LIMIT", doc); return; }
    visited.add(parent);
    await list(parent, async (b, ref) => {
      if (b.archived !== false || b.in_trash === true) { issue(ref, "INACTIVE_BLOCK", doc); return; }
      const type = b.type as string, body = b[type];
      if (!record(body) || typeof b.has_children !== "boolean") { issue(ref, "INVALID_BLOCK_BODY", doc); return; }
      if (type === "synced_block" && body.synced_from !== null) { issue(ref, "EXTERNAL_SYNCED_ORIGIN_NOT_FOLLOWED", doc); return; }
      let text = "";
      try {
        if (TEXT_TYPES.has(type)) text = richText(body.rich_text);
        else if (type === "table_row") {
          if (!Array.isArray(body.cells)) throw new Error("invalid cells");
          text = body.cells.map(richText).join(" | ");
        } else if (type === "equation") {
          if (typeof body.expression !== "string") throw new Error("invalid equation");
          text = body.expression;
        } else if (!STRUCTURAL_TYPES.has(type)) { issue(ref, "UNSUPPORTED_BLOCK_NOT_FOLLOWED", doc); return; }
      } catch { issue(ref, "INVALID_TEXT_BODY", doc); return; }
      if (text) {
        doc.items.push({ block_ref: ref, parent_ref: parent, type, text });
        if (Buffer.byteLength(JSON.stringify(result("PARTIAL"))) > LIMITS.response_bytes - 2048) {
          doc.items.pop(); issue(ref, "RESPONSE_BYTE_LIMIT", doc); stopped = true; return;
        }
      }
      if (b.has_children) await visit(ref, depth + 1, doc);
    }, doc);
  }
  for (const [index, role] of ROLES.entries()) {
    const title = paths[index]![0]!.path[1]!;
    const ref = child(controlChildren, title);
    if (!ref) continue;
    const doc: Document = { role, title, page_ref: ref, status: "UNAVAILABLE", items: [], issues: [] };
    documents.push(doc);
    const before = failures;
    const meta = await page(ref, control, doc);
    if (!meta) continue;
    if (typeof meta.last_edited_time === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(meta.last_edited_time)) {
      Object.assign(doc, { last_edited_time: meta.last_edited_time });
    }
    await visit(ref, 0, doc);
    doc.status = failures === before ? "COMPLETE" : doc.items.length ? "PARTIAL" : "UNAVAILABLE";
    if (stopped) break;
  }
  return result(failures ? documents.some((d) => d.items.length > 0) ? "PARTIAL" : "UNAVAILABLE" : "COMPLETE");
}
