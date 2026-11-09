/** Migration test input, not a served runtime or a migration writer.
 * Captures a physical Notion subtree and its pagination without following links to other OS.
 * COMPLETE_CONTAINMENT means complete/stable observed API payloads within that boundary,
 * not atomicity, external-reference closure, binary assets or candidate compatibility.
 */
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { NotionReadClient } from "../../src/notion/client.ts";

type ReadMethod = keyof NotionReadClient;
type ObjectValue = Record<string, unknown>;
export interface CapturedRead { method: ReadMethod; args: unknown[]; value: unknown; sha256: string; stability_sha256: string }
export interface SnapshotIssue { code: string; ref: string }
export interface HistoricalSnapshot {
  kind: "HISTORICAL_NOTION_SUBTREE/1";
  root_ref: string;
  status: "COMPLETE_CONTAINMENT" | "INCOMPLETE";
  reads: CapturedRead[];
  issues: SnapshotIssue[];
  page_refs: string[];
  database_refs: string[];
  data_source_refs: string[];
  block_refs: string[];
  external_refs: string[];
  binary_assets_copied: false;
  comments_captured: false;
  edit_history_captured: false;
  archived_records_complete: false;
  external_semantic_closure_claimed: false;
  atomic_snapshot_claimed: false;
  started_at: string;
  finished_at: string;
  read_method_calls: number;
  client_read_method_calls: number;
  seed_reads_reused: number;
  discovery_completed: boolean;
  stability_checks_completed: number;
  capture_lineage?: { seed_snapshot_sha256: string; seed_started_at: string; seed_finished_at: string };
  payload_bytes: number;
}
export interface CaptureOptions {
  maxCalls?: number;
  maxObjects?: number;
  maxPagesPerCollection?: number;
  maxPayloadBytes?: number;
  now?: () => Date;
  /** Diagnostic reuse only. No seed response is used for stability or served as current authority. */
  seed?: { snapshot: HistoricalSnapshot; expectedDigest: string };
  /** Qualify physical payload stability even when semantic boundaries remain incomplete. Never clears issues. */
  verifyIncompleteCapture?: boolean;
  /** Summary only; no payload or account token supplied to this observer. */
  onProgress?: (progress: { calls: number; objects: number; phase: "CAPTURE" | "STABILITY" }) => void;
}
const object = (value: unknown): ObjectValue | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;
function id(value: unknown): string {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(value)) throw new Error("INVALID_OBJECT_ID");
  return value.replaceAll("-", "").toLowerCase();
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  const record = object(value);
  if (!record) return value;
  // Ignore only signing parameters/expiry, never the asset's address or other file metadata.
  if (record["type"] === "file" && object(record["file"])) {
    const file = { ...object(record["file"])! };
    delete file["expiry_time"];
    if (typeof file["url"] === "string") {
      try {
        const url = new URL(file["url"]);
        for (const key of [...url.searchParams.keys()]) if (/^(?:X-Amz-.+|X-Goog-.+|AWSAccessKeyId|Signature|Expires|GoogleAccessId)$/i.test(key)) url.searchParams.delete(key);
        file["url"] = url.href;
      } catch { /* preserved verbatim */ }
    }
    return stable({ ...record, type: "stable_file_reference", file });
  }
  return Object.fromEntries(Object.keys(record).sort().map(key => [key, stable(record[key])]));
}
function digest(value: unknown): string {
  const envelope = object(value);
  // A request UUID identifies transport, not source state. Only the root API
  // envelope is normalized: business fields with this name remain significant.
  let comparable = value;
  if (envelope && ["page", "database", "data_source", "list"].includes(String(envelope["object"]))
    && typeof envelope["request_id"] === "string"
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(envelope["request_id"])) {
    const { request_id: _transport, ...source } = envelope;
    comparable = source;
  }
  return createHash("sha256").update(JSON.stringify(stable(comparable))).digest("hex");
}
const readKey = (method: ReadMethod, args: unknown[]) => `${method}:${JSON.stringify(args)}`;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  const record = object(value);
  return record ? Object.fromEntries(Object.keys(record).sort().map(key => [key, canonical(record[key])])) : value;
}
const exactDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const readDigest = (method: ReadMethod, args: unknown[], value: unknown) => exactDigest({ method, args, value });
/** Pin this in an independently retained receipt; a hash supplied by the snapshot itself is not trust. */
export const historicalSnapshotDigest = (snapshot: HistoricalSnapshot): string => exactDigest(snapshot);

export async function captureHistoricalSubtree(client: NotionReadClient, rootRef: string, options: CaptureOptions = {}): Promise<HistoricalSnapshot> {
  const root = id(rootRef), now = options.now ?? (() => new Date());
  const maxCalls = options.maxCalls ?? 1500, maxObjects = options.maxObjects ?? 10000;
  const maxPages = options.maxPagesPerCollection ?? 100, maxBytes = options.maxPayloadBytes ?? 50_000_000;
  for (const bound of [maxCalls, maxObjects, maxPages, maxBytes]) if (!Number.isSafeInteger(bound) || bound <= 0) throw new Error("INVALID_CAPTURE_BOUND");
  const seed = options.seed;
  const seeded = new Map<string, unknown>();
  if (seed) {
    if (!/^[a-f0-9]{64}$/.test(seed.expectedDigest) || historicalSnapshotDigest(seed.snapshot) !== seed.expectedDigest) throw new Error("SNAPSHOT_INTEGRITY_MISMATCH");
    if (seed.snapshot.kind !== "HISTORICAL_NOTION_SUBTREE/1" || seed.snapshot.root_ref !== root) throw new Error("SEED_ROOT_MISMATCH");
    for (const captured of seed.snapshot.reads) {
      if (readDigest(captured.method, captured.args, captured.value) !== captured.sha256) throw new Error("SNAPSHOT_INTEGRITY_MISMATCH");
      const key = readKey(captured.method, captured.args);
      if (seeded.has(key)) throw new Error("DUPLICATE_SEED_READ");
      seeded.set(key, structuredClone(captured.value));
    }
  }
  const started = now().toISOString(), reads: CapturedRead[] = [], issues: SnapshotIssue[] = [];
  const pages = new Set<string>(), databases = new Set<string>(), dataSources = new Set<string>();
  const blocks = new Set<string>();
  const visited = new Set<string>(), objects = new Set<string>(), references = new Set<string>();
  let calls = 0, clientCalls = 0, reused = 0, stabilityChecks = 0, discoveryComplete = false;
  let bytes = 0, phase: "CAPTURE" | "STABILITY" = "CAPTURE";
  const problem = (code: string, ref: string) => { if (!issues.some(issue => issue.code === code && issue.ref === ref)) issues.push({ code, ref }); };
  const invoke = async (method: ReadMethod, args: unknown[]): Promise<unknown> => {
    if (calls >= maxCalls) throw new Error("CALL_BOUND_EXCEEDED");
    calls++;
    options.onProgress?.({ calls, objects: objects.size, phase });
    const key = readKey(method, args);
    if (phase === "CAPTURE" && seeded.has(key)) { reused++; return structuredClone(seeded.get(key)); }
    clientCalls++;
    return Reflect.apply(client[method], client, args);
  };
  const read = async (method: ReadMethod, args: unknown[]): Promise<unknown> => {
    const value = await invoke(method, args);
    // JSON isolation preserves every API field without retaining aliases into the source client.
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("INVALID_READ_PAYLOAD");
    bytes += Buffer.byteLength(encoded);
    if (bytes > maxBytes) throw new Error("PAYLOAD_BOUND_EXCEEDED");
    const copy: unknown = JSON.parse(encoded);
    reads.push({ method, args: structuredClone(args), value: copy, sha256: readDigest(method, args, copy), stability_sha256: digest(copy) });
    scan(copy);
    return copy;
  };
  function scan(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(scan); return; }
    const record = object(value); if (!record) return;
    // These limits concern references/mentions, not text length or the number of plain-text runs.
    // Scope the test to page property VALUES, not database schema declarations or block text.
    if (record["object"] === "page" && object(record["properties"])) {
      for (const [name, raw] of Object.entries(object(record["properties"])!)) {
        const property = object(raw); if (!property) continue;
        const type = property["type"];
        const values = typeof type === "string" ? property[type] : undefined;
        if (type === "people" && Array.isArray(values) && values.length >= 25
          || (type === "title" || type === "rich_text") && Array.isArray(values) && values.filter(v => object(v)?.["type"] === "mention").length >= 25
          || type === "rollup" || type === "formula") problem("PROPERTY_POSSIBLY_TRUNCATED", `${record["id"]}:${name}`);
      }
    }
    if (record["has_more"] === true && record["type"] === "relation") problem("PROPERTY_PAGINATION_NOT_CAPTURED", String(record["id"] ?? "unknown-property"));
    for (const key of ["relation", "page"]) {
      const values = key === "relation" ? record[key] : [record[key]];
      if (Array.isArray(values)) for (const linked of values) {
        const ref = object(linked)?.["id"];
        if (ref !== undefined) { try { references.add(id(ref)); } catch { problem("INVALID_REFERENCE", "embedded-reference"); } }
      }
    }
    for (const key of ["page_id", "database_id", "data_source_id", "block_id"]) {
      if (record[key] !== undefined) { try { references.add(id(record[key])); } catch { problem("INVALID_REFERENCE", key); } }
    }
    if (record["type"] === "database" || record["type"] === "data_source") {
      const target = object(record[String(record["type"])]);
      if (target?.["id"] !== undefined) { try { references.add(id(target["id"])); } catch { problem("INVALID_REFERENCE", "mention"); } }
    }
    for (const key of ["url", "href"]) {
      if (typeof record[key] !== "string") continue;
      try {
        const url = new URL(record[key]);
        if (!/(^|\.)(notion\.so|notion\.site|notion\.com)$/.test(url.hostname)) continue;
        const match = url.pathname.replaceAll("-", "").match(/[a-f0-9]{32}/gi)?.at(-1);
        if (match) references.add(id(match));
      } catch { /* ordinary text, not a navigable reference */ }
    }
    Object.values(record).forEach(scan);
  }
  function track(ref: string): void {
    if (!objects.has(ref) && objects.size >= maxObjects) throw new Error("OBJECT_BOUND_EXCEEDED");
    objects.add(ref);
  }
  function visit(kind: string, ref: string): boolean {
    const key = `${kind}:${ref}`;
    if (visited.has(key)) { problem("REPEATED_CONTAINMENT_OBJECT", ref); return false; }
    track(ref);
    visited.add(key); return true;
  }
  async function collection(method: "retrieveBlockChildren" | "queryDataSource", ref: string): Promise<ObjectValue[]> {
    const out: ObjectValue[] = [], seen = new Set<string>(), cursors = new Set<string>();
    let cursor: string | undefined;
    for (let n = 0; n < maxPages; n++) {
      const args = method === "retrieveBlockChildren" ? [ref, cursor] : [ref, undefined, cursor, { page_size: 100 }];
      const result = object(await read(method, args));
      if (!result || !Array.isArray(result["results"]) || typeof result["has_more"] !== "boolean") throw new Error("INVALID_COLLECTION_PAYLOAD");
      for (const entry of result["results"]) {
        const row = object(entry); if (!row) throw new Error("INVALID_COLLECTION_OBJECT");
        const key = id(row["id"]);
        if (seen.has(key)) throw new Error("DUPLICATE_COLLECTION_OBJECT");
        seen.add(key); out.push(row);
      }
      if (result["has_more"] === false) {
        if (result["next_cursor"] !== null && result["next_cursor"] !== undefined) throw new Error("INCONSISTENT_PAGINATION_END");
        return out;
      }
      const next = result["next_cursor"];
      if (typeof next !== "string" || !next || cursors.has(next)) throw new Error("INVALID_PAGINATION_CURSOR");
      cursors.add(next); cursor = next;
    }
    throw new Error("PAGINATION_BOUND_EXCEEDED");
  }
  async function children(ref: string): Promise<void> {
    for (const block of await collection("retrieveBlockChildren", ref)) {
      const blockId = id(block["id"]), type = block["type"];
      track(blockId);
      if (blocks.has(blockId)) problem("REPEATED_CONTAINMENT_OBJECT", blockId);
      blocks.add(blockId);
      if (typeof type !== "string" || type === "unsupported") problem("UNSUPPORTED_BLOCK_CONTENT", blockId);
      if (type === "child_page") await page(blockId, undefined, ref);
      else if (type === "child_database") await database(blockId, ref);
      else if (type === "synced_block" && object(block["synced_block"])?.["synced_from"]) problem("EXTERNAL_SYNCED_CONTENT", blockId);
      else if (block["has_children"] === true) {
        if (visit("block", blockId)) await children(blockId);
      }
    }
  }
  async function page(ref: string, expectedDataSource?: string, expectedParent?: string): Promise<void> {
    if (!visit("page", ref)) return;
    pages.add(ref);
    const value = object(await read("retrievePage", [ref]));
    if (!value || value["object"] !== "page" || id(value["id"]) !== ref) throw new Error("PAGE_IDENTITY_MISMATCH");
    if (expectedDataSource && id(object(value["parent"])?.["data_source_id"]) !== expectedDataSource) throw new Error("ROW_PARENT_MISMATCH");
    if (expectedParent && id(object(value["parent"])?.["page_id"] ?? object(value["parent"])?.["block_id"]) !== expectedParent) throw new Error("PAGE_PARENT_MISMATCH");
    await children(ref);
  }
  async function database(ref: string, expectedParent: string): Promise<void> {
    if (!visit("database", ref)) return;
    databases.add(ref);
    const value = object(await read("retrieveDatabase", [ref]));
    if (!value || value["object"] !== "database" || id(value["id"]) !== ref || !Array.isArray(value["data_sources"])) throw new Error("DATABASE_IDENTITY_MISMATCH");
    if (id(object(value["parent"])?.["page_id"] ?? object(value["parent"])?.["block_id"]) !== expectedParent) throw new Error("DATABASE_PARENT_MISMATCH");
    if (value["data_sources"].length === 0) problem("DATABASE_SOURCES_NOT_CAPTURED", ref);
    for (const source of value["data_sources"]) {
      const sourceId = id(object(source)?.["id"]);
      if (!visit("data_source", sourceId)) continue;
      dataSources.add(sourceId);
      const schema = object(await read("retrieveDataSource", [sourceId]));
      if (!schema || schema["object"] !== "data_source" || id(schema["id"]) !== sourceId || id(object(schema["parent"])?.["database_id"]) !== ref) throw new Error("DATA_SOURCE_PARENT_MISMATCH");
      for (const row of await collection("queryDataSource", sourceId)) await page(id(row["id"]), sourceId);
    }
  }
  try { await page(root); discoveryComplete = true; } catch (error) { problem(safeErrorCode(error), root); }
  // Re-reading exactly the captured read requests detects observable drift, including insertions.
  // This is not an atomic Notion snapshot or a lock against edits after this check.
  if (!issues.length || options.verifyIncompleteCapture === true && discoveryComplete) {
    phase = "STABILITY";
    for (const captured of reads) {
      try {
        if (digest(await invoke(captured.method, captured.args)) !== captured.stability_sha256) problem("SOURCE_CHANGED_DURING_CAPTURE", String(captured.args[0]));
        stabilityChecks++;
      } catch (error) { problem(safeErrorCode(error), String(captured.args[0])); }
      if (calls >= maxCalls) { if (reads.length * 2 > calls) problem("CALL_BOUND_EXCEEDED", root); break; }
    }
  }
  return { kind: "HISTORICAL_NOTION_SUBTREE/1", root_ref: root, status: issues.length ? "INCOMPLETE" : "COMPLETE_CONTAINMENT", reads, issues,
    page_refs: [...pages].sort(), database_refs: [...databases].sort(), data_source_refs: [...dataSources].sort(),
    block_refs: [...blocks].sort(), external_refs: [...references].filter(ref => !pages.has(ref) && !databases.has(ref) && !dataSources.has(ref) && !blocks.has(ref)).sort(),
    binary_assets_copied: false, comments_captured: false, edit_history_captured: false, archived_records_complete: false,
    external_semantic_closure_claimed: false, atomic_snapshot_claimed: false,
    started_at: started, finished_at: now().toISOString(), read_method_calls: calls, client_read_method_calls: clientCalls,
    seed_reads_reused: reused, discovery_completed: discoveryComplete, stability_checks_completed: stabilityChecks,
    ...(seed ? { capture_lineage: { seed_snapshot_sha256: seed.expectedDigest, seed_started_at: seed.snapshot.started_at, seed_finished_at: seed.snapshot.finished_at } } : {}),
    payload_bytes: bytes };
}
function safeErrorCode(error: unknown): string {
  // Never propagate server messages, payloads, credentials or URLs to the public receipt.
  const message = error instanceof Error ? error.message : "";
  return /^[A-Z_]+$/.test(message) ? message : "READ_FAILED";
}

/** Exact response replay. An uncaptured request refuses rather than inventing a Notion result. */
export function replayHistoricalSnapshot(snapshot: HistoricalSnapshot, expectedDigest: string): NotionReadClient {
  if (!/^[a-f0-9]{64}$/.test(expectedDigest) || historicalSnapshotDigest(snapshot) !== expectedDigest) throw new Error("SNAPSHOT_INTEGRITY_MISMATCH");
  if (snapshot.status !== "COMPLETE_CONTAINMENT" || snapshot.issues.length) throw new Error("INCOMPLETE_SNAPSHOT");
  for (const captured of snapshot.reads) if (readDigest(captured.method, captured.args, captured.value) !== captured.sha256) throw new Error("SNAPSHOT_INTEGRITY_MISMATCH");
  const responses = new Map(snapshot.reads.map(read => [readKey(read.method, read.args), read.value]));
  const invoke = (method: ReadMethod, args: unknown[]) => {
    const key = readKey(method, args);
    if (!responses.has(key)) throw new Error("UNCAPTURED_READ");
    return Promise.resolve(structuredClone(responses.get(key)));
  };
  return {
    retrievePage: ref => invoke("retrievePage", [ref]),
    retrieveDatabase: ref => invoke("retrieveDatabase", [ref]),
    retrieveDataSource: ref => invoke("retrieveDataSource", [ref]),
    retrieveBlockChildren: (ref, cursor) => invoke("retrieveBlockChildren", [ref, cursor]),
    queryDataSource: (ref, filter, cursor, options) => invoke("queryDataSource", [ref, filter, cursor, options]),
  };
}

/** Private JSON-lines transport: decode UTF-8 across chunk boundaries and verify the sender's
 * byte digest before parsing/persisting. Does not write files, echo payloads or trust payload hashes.
 */
export function createSnapshotReceiver(onProgress: (summary: { calls: number; objects: number; phase: string }) => void = () => {}, maxBytes = 60_000_000) {
  const decoder = new StringDecoder("utf8");
  let pending = "", total = 0, expected: string | undefined, payload: string | undefined;
  const line = (raw: string) => {
    let value: ObjectValue | undefined;
    try { value = object(JSON.parse(raw)); } catch { throw new Error("INVALID_CAPTURE_TRANSPORT"); }
    if (value?.["kind"] === "CAPTURE_PROGRESS") {
      if (!Number.isSafeInteger(value["calls"]) || !Number.isSafeInteger(value["objects"]) || !["CAPTURE", "STABILITY"].includes(String(value["phase"]))) throw new Error("INVALID_CAPTURE_TRANSPORT");
      onProgress({ calls: value["calls"] as number, objects: value["objects"] as number, phase: String(value["phase"]) });
    } else if (value?.["kind"] === "PRIVATE_CAPTURE_DIGEST") {
      if (expected || typeof value["sha256"] !== "string" || !/^[a-f0-9]{64}$/.test(value["sha256"])) throw new Error("INVALID_CAPTURE_TRANSPORT");
      expected = value["sha256"];
    } else if (value?.["kind"] === "PRIVATE_CAPTURE_RESULT") {
      if (payload) throw new Error("INVALID_CAPTURE_TRANSPORT"); payload = raw;
    } else throw new Error("INVALID_CAPTURE_TRANSPORT");
  };
  const drain = () => { let end: number; while ((end = pending.indexOf("\n")) >= 0) { line(pending.slice(0, end)); pending = pending.slice(end + 1); } };
  return {
    push(chunk: Uint8Array) {
      total += chunk.byteLength; if (total > maxBytes) throw new Error("CAPTURE_TRANSPORT_BOUND");
      pending += decoder.write(Buffer.from(chunk)); drain();
    },
    finish(): { encoded: string; result: Record<string, unknown>; transport_sha256: string; snapshot_sha256: string } {
      pending += decoder.end(); drain();
      if (pending || !expected || !payload || createHash("sha256").update(payload).digest("hex") !== expected) throw new Error("CAPTURE_TRANSPORT_MISMATCH");
      const result = JSON.parse(payload) as Record<string, unknown>, snapshot = result["snapshot"] as HistoricalSnapshot;
      for (const captured of snapshot.reads) if (readDigest(captured.method, captured.args, captured.value) !== captured.sha256) throw new Error("SNAPSHOT_INTEGRITY_MISMATCH");
      const snapshotSha = historicalSnapshotDigest(snapshot);
      if (snapshot.status === "COMPLETE_CONTAINMENT") replayHistoricalSnapshot(snapshot, snapshotSha);
      return { encoded: payload, result, transport_sha256: expected, snapshot_sha256: snapshotSha };
    },
  };
}
