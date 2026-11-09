/** Local snapshot containment oracles, not a real migration or installed ChatGPT proof. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { NotionReadClient } from "../../src/notion/client.ts";
import { captureHistoricalSubtree, replayHistoricalSnapshot, historicalSnapshotDigest, createSnapshotReceiver } from "../support/historical-snapshot.ts";

const ref = (n: number) => n.toString(16).padStart(32, "0");
const ROOT = ref(1), NESTED = ref(2), DB = ref(3), DS = ref(4), A = ref(5), B = ref(6), EXTERNAL = ref(7);
const list = (results: unknown[], next: string | null = null) => ({ object: "list", results, has_more: next !== null, next_cursor: next });
const page = (id: string, properties: Record<string, unknown> = {}, parent?: unknown) => ({ object: "page", id, properties,
  last_edited_time: "2026-10-01T13:02:00.000Z", ...(parent ? { parent } : {}) });
function world() {
  const root = page(ROOT, { Name: { type: "title", title: [{ plain_text: "Historical Sales OS" }] } });
  const a = page(A, {
    State: { type: "select", select: { name: "CONFIRMED" } },
    Value: { type: "rich_text", rich_text: [{ type: "text", plain_text: "15 TOTAL, not per segment" },
      { type: "mention", plain_text: "external policy", mention: { type: "page", page: { id: EXTERNAL } } }] },
    Source: { type: "rich_text", rich_text: [{ plain_text: "historical source, not CHAT_USER_EXPLICIT" }] },
    Relation: { id: "rel", type: "relation", relation: [{ id: B }, { id: EXTERNAL }], has_more: false },
  }, { type: "data_source_id", data_source_id: DS });
  const b = page(B, { State: { type: "select", select: { name: "RETIRED" } }, Value: { type: "number", number: 15 } }, { type: "data_source_id", data_source_id: DS });
  const map = new Map<string, unknown>([
    [`page:${ROOT}`, root], [`page:${NESTED}`, page(NESTED, {}, { type: "page_id", page_id: ROOT })], [`page:${A}`, a], [`page:${B}`, b],
    [`children:${ROOT}:`, list([{ id: NESTED, type: "child_page", child_page: { title: "Rules" } }], "second")],
    [`children:${ROOT}:second`, list([{ id: DB, type: "child_database", child_database: { title: "Configuration" } }])],
    [`children:${NESTED}:`, list([{ id: ref(8), type: "toggle", has_children: true, toggle: { rich_text: [{ plain_text: "Policy" }] } }])],
    [`children:${ref(8)}:`, list([{ id: ref(9), type: "paragraph", paragraph: { rich_text: [{ type: "text", plain_text: "No sends; preserved rule" }] } }])],
    [`children:${A}:`, list([])], [`children:${B}:`, list([])],
    [`database:${DB}`, { object: "database", id: DB, parent: { type: "page_id", page_id: ROOT }, title: [{ plain_text: "Configuration" }], data_sources: [{ id: DS }] }],
    [`data_source:${DS}`, { object: "data_source", id: DS, parent: { database_id: DB }, properties: { Relation: { type: "relation", relation: { data_source_id: DS } } } }],
    [`query:${DS}:`, list([a], "row-second")], [`query:${DS}:row-second`, list([b])],
  ]);
  const calls: { method: string; ref: string; cursor?: string }[] = [];
  const get = (method: string, key: string, id: string, cursor?: string) => {
    calls.push({ method, ref: id, ...(cursor ? { cursor } : {}) });
    if (!map.has(key)) throw new Error("secret-account-error-do-not-log");
    return Promise.resolve(structuredClone(map.get(key)));
  };
  let writes = 0;
  const client: NotionReadClient & { updatePage(): never; createPage(): never } = {
    retrievePage: id => get("retrievePage", `page:${id}`, id),
    retrieveDatabase: id => get("retrieveDatabase", `database:${id}`, id),
    retrieveDataSource: id => get("retrieveDataSource", `data_source:${id}`, id),
    retrieveBlockChildren: (id, cursor) => get("retrieveBlockChildren", `children:${id}:${cursor ?? ""}`, id, cursor),
    queryDataSource: (id, _filter, cursor) => get("queryDataSource", `query:${id}:${cursor ?? ""}`, id, cursor),
    updatePage() { writes++; throw new Error("writer invoked"); },
    createPage() { writes++; throw new Error("writer invoked"); },
  };
  return { map, calls, client, writes: () => writes };
}

test("W7.3 snapshot: physical subtree, schemas, paginated rows and nested policy contents preserve all payloads without writes", async () => {
  const w = world(), before = structuredClone([...w.map]);
  const s = await captureHistoricalSubtree(w.client, ROOT);
  assert.equal(s.status, "COMPLETE_CONTAINMENT", JSON.stringify(s.issues));
  assert.deepEqual(s.page_refs, [ROOT, NESTED, A, B]);
  assert.deepEqual(s.database_refs, [DB]); assert.deepEqual(s.data_source_refs, [DS]);
  assert.deepEqual(s.external_refs, [EXTERNAL]);
  assert.equal(s.read_method_calls, s.reads.length * 2, "every response gets a stability read");
  assert.equal(w.calls.some(call => call.ref === EXTERNAL), false, "relations do not cause cross-OS reads");
  assert.ok(JSON.stringify(s.reads).includes("15 TOTAL, not per segment"));
  assert.ok(JSON.stringify(s.reads).includes("RETIRED"));
  assert.ok(JSON.stringify(s.reads).includes("historical source, not CHAT_USER_EXPLICIT"));
  assert.equal(s.atomic_snapshot_claimed, false); assert.equal(s.binary_assets_copied, false);
  assert.equal(w.writes(), 0); assert.deepEqual([...w.map], before);
  const replay = replayHistoricalSnapshot(s, historicalSnapshotDigest(s));
  const copied = await replay.retrievePage(A) as { properties: Record<string, unknown> };
  copied.properties["Value"] = "changed local copy";
  assert.deepEqual(await replay.retrievePage(A), w.map.get(`page:${A}`));
  assert.equal(Object.keys(replay).some(key => /create|update|delete/i.test(key)), false);
  assert.throws(() => replay.queryDataSource(DS, { property: "State", select: { equals: "CONFIRMED" } }), /UNCAPTURED_READ/);
});

test("W7.3 snapshot: pinned partial discovery is reused, but every stability check calls the live reader", async () => {
  const w = world(), partial = await captureHistoricalSubtree(w.client, ROOT, { maxCalls: 5 });
  assert.equal(partial.status, "INCOMPLETE");
  w.calls.length = 0;
  const s = await captureHistoricalSubtree(w.client, ROOT, { seed: { snapshot: partial, expectedDigest: historicalSnapshotDigest(partial) } });
  assert.equal(s.status, "COMPLETE_CONTAINMENT", JSON.stringify(s.issues));
  assert.equal(s.seed_reads_reused, partial.reads.length);
  assert.equal(s.discovery_completed, true);
  assert.equal(s.stability_checks_completed, s.reads.length);
  assert.equal(w.calls.length, s.client_read_method_calls);
  assert.equal(s.read_method_calls - s.client_read_method_calls, s.seed_reads_reused);
  assert.equal(w.calls.filter(call => call.method === "retrievePage" && call.ref === ROOT).length, 1, "seed root is actually re-read for stability");
  assert.equal(s.capture_lineage?.seed_snapshot_sha256, historicalSnapshotDigest(partial));
  assert.equal(w.writes(), 0);
});

test("W7.3 snapshot: seeded old facts never hide source drift or grant a complete replay", async () => {
  const w = world(), partial = await captureHistoricalSubtree(w.client, ROOT, { maxCalls: 5 });
  const changed = w.map.get(`page:${ROOT}`) as Record<string, unknown>;
  changed["last_edited_time"] = "2026-10-12T18:30:00Z";
  const s = await captureHistoricalSubtree(w.client, ROOT, { seed: { snapshot: partial, expectedDigest: historicalSnapshotDigest(partial) } });
  assert.equal(s.status, "INCOMPLETE");
  assert.ok(s.issues.some(i => i.code === "SOURCE_CHANGED_DURING_CAPTURE"));
  assert.throws(() => replayHistoricalSnapshot(s, historicalSnapshotDigest(s)), /INCOMPLETE_SNAPSHOT/);
  assert.equal(w.writes(), 0);
});

test("W7.3 snapshot: changing root API request UUIDs do not change source stability; exact payload pins still bind them", async () => {
  const w = world(); let sequence = 0;
  for (const method of ["retrievePage", "retrieveDatabase", "retrieveDataSource", "retrieveBlockChildren", "queryDataSource"] as const) {
    const initial = w.client[method];
    (w.client as any)[method] = async (...args: unknown[]) => ({
      ...await Reflect.apply(initial, w.client, args), request_id: `00000000-0000-0000-0000-${(++sequence).toString(16).padStart(12, "0")}`,
    });
  }
  const s = await captureHistoricalSubtree(w.client, ROOT);
  assert.equal(s.status, "COMPLETE_CONTAINMENT", JSON.stringify(s.issues));
  assert.equal(s.stability_checks_completed, s.reads.length);
  assert.ok(s.reads.every(r => typeof (r.value as any).request_id === "string"));
  const pinned = historicalSnapshotDigest(s), replay = replayHistoricalSnapshot(s, pinned);
  assert.deepEqual(await replay.retrievePage(ROOT), s.reads[0]!.value, "transport UUID remains in exact replay payload");
  const changed = structuredClone(s);
  (changed.reads[0]!.value as any).request_id = ["00000000", "0000", "0000", "0000", "ffffffffffff"].join("-");
  assert.throws(() => replayHistoricalSnapshot(changed, pinned), /SNAPSHOT_INTEGRITY_MISMATCH/);
  assert.equal(w.writes(), 0);
});

test("W7.3 snapshot: a business request_id and malformed root metadata are never ignored", async () => {
  for (const fault of ["business-field", "invalid-root-uuid"] as const) {
    const w = world(), original = w.client.retrievePage; let sequence = 0;
    w.client.retrievePage = async id => {
      const value = await original(id) as Record<string, any>;
      if (id === ROOT) {
        sequence++;
        if (fault === "business-field") value.properties.request_id = { type: "rich_text", rich_text: [{ plain_text: String(sequence) }] };
        else value.request_id = `invalid-transport-${sequence}`;
      }
      return value;
    };
    const s = await captureHistoricalSubtree(w.client, ROOT);
    assert.equal(s.status, "INCOMPLETE", fault);
    assert.ok(s.issues.some(i => i.code === "SOURCE_CHANGED_DURING_CAPTURE" && i.ref === ROOT), fault);
    assert.throws(() => replayHistoricalSnapshot(s, historicalSnapshotDigest(s)), /INCOMPLETE_SNAPSHOT/);
    assert.equal(w.writes(), 0);
  }
});

test("W7.3 snapshot: wrong seed root or independently pinned bytes refuse before any live read", async () => {
  const seed = await captureHistoricalSubtree(world().client, ROOT, { maxCalls: 5 }), w = world();
  await assert.rejects(captureHistoricalSubtree(w.client, ROOT, { seed: { snapshot: seed, expectedDigest: "0".repeat(64) } }), /SNAPSHOT_INTEGRITY_MISMATCH/);
  await assert.rejects(captureHistoricalSubtree(w.client, EXTERNAL, { seed: { snapshot: seed, expectedDigest: historicalSnapshotDigest(seed) } }), /SEED_ROOT_MISMATCH/);
  const duplicated = structuredClone(seed); duplicated.reads.push(duplicated.reads[0]!);
  await assert.rejects(captureHistoricalSubtree(w.client, ROOT, { seed: { snapshot: duplicated, expectedDigest: historicalSnapshotDigest(duplicated) } }), /DUPLICATE_SEED_READ/);
  assert.equal(w.calls.length, 0);
  assert.equal(w.writes(), 0);
});

test("W7.3 snapshot: physical stability witness never clears unresolved synchronized content", async () => {
  const w = world();
  w.map.set(`children:${A}:`, list([{ id: ref(10), type: "synced_block", has_children: false,
    synced_block: { synced_from: { block_id: EXTERNAL } } }]));
  const seed = await captureHistoricalSubtree(w.client, ROOT);
  const s = await captureHistoricalSubtree(w.client, ROOT, { seed: { snapshot: seed, expectedDigest: historicalSnapshotDigest(seed) }, verifyIncompleteCapture: true });
  assert.equal(s.discovery_completed, true);
  assert.equal(s.stability_checks_completed, s.reads.length);
  assert.equal(s.status, "INCOMPLETE");
  assert.ok(s.issues.some(i => i.code === "EXTERNAL_SYNCED_CONTENT"));
  assert.throws(() => replayHistoricalSnapshot(s, historicalSnapshotDigest(s)), /INCOMPLETE_SNAPSHOT/);
  assert.equal(w.calls.some(call => call.ref === EXTERNAL), false);
  assert.equal(w.writes(), 0);
});

test("W7.3 snapshot: partial, looping, duplicate or inconsistent pagination never claims complete", async () => {
  for (const fault of ["missing-cursor", "repeat-cursor", "duplicate-row", "inconsistent-end", "missing-flag"] as const) {
    const w = world();
    if (fault === "missing-cursor") w.map.set(`query:${DS}:`, { results: [], has_more: true, next_cursor: null });
    if (fault === "repeat-cursor") w.map.set(`query:${DS}:row-second`, list([], "row-second"));
    if (fault === "duplicate-row") w.map.set(`query:${DS}:row-second`, list([w.map.get(`page:${A}`)]));
    if (fault === "inconsistent-end") w.map.set(`query:${DS}:`, { results: [], has_more: false, next_cursor: "should-not-exist" });
    if (fault === "missing-flag") w.map.set(`query:${DS}:`, { results: [], next_cursor: null });
    const s = await captureHistoricalSubtree(w.client, ROOT);
    assert.equal(s.status, "INCOMPLETE", fault); assert.ok(s.issues.length, fault); assert.equal(w.writes(), 0);
  }
});

test("W7.3 snapshot: read failures and incomplete property relations are explicit, with error messages withheld", async () => {
  for (const fault of ["missing-page", "relation-more", "unsupported-block", "synced-content", "foreign-parent"] as const) {
    const w = world();
    if (fault === "missing-page") w.map.delete(`page:${A}`);
    if (fault === "relation-more") (w.map.get(`page:${A}`) as any).properties.Relation.has_more = true;
    if (fault === "unsupported-block") w.map.set(`children:${A}:`, list([{ id: ref(10), type: "unsupported" }]));
    if (fault === "synced-content") w.map.set(`children:${A}:`, list([{ id: ref(10), type: "synced_block", synced_block: { synced_from: { block_id: EXTERNAL } } }]));
    if (fault === "foreign-parent") (w.map.get(`page:${A}`) as any).parent.data_source_id = EXTERNAL;
    const s = await captureHistoricalSubtree(w.client, ROOT);
    assert.equal(s.status, "INCOMPLETE", fault); assert.ok(s.issues.length, fault);
    assert.doesNotMatch(JSON.stringify(s.issues), /secret-account|do-not-log/); assert.equal(w.writes(), 0);
  }
});

test("W7.3 snapshot: source changes, including a new database row, invalidate the observed copy", async () => {
  const w = world(), initial = w.client.queryDataSource;
  let queries = 0;
  w.client.queryDataSource = async (...args) => {
    queries++;
    if (queries === 3) return list([]); // The first stability query sees a changed membership.
    return initial(...args);
  };
  const s = await captureHistoricalSubtree(w.client, ROOT);
  assert.equal(s.status, "INCOMPLETE");
  assert.ok(s.issues.some(issue => issue.code === "SOURCE_CHANGED_DURING_CAPTURE"));
  assert.equal(w.writes(), 0);
});

test("W7.3 snapshot: budgets refuse incomplete copies; limits are validated before reading", async () => {
  for (const options of [{ maxCalls: 2 }, { maxCalls: 16 }, { maxObjects: 1 }, { maxPagesPerCollection: 1 }, { maxPayloadBytes: 1 }]) {
    const w = world(), s = await captureHistoricalSubtree(w.client, ROOT, options);
    assert.equal(s.status, "INCOMPLETE", JSON.stringify(options));
    if (options.maxCalls) assert.ok(w.calls.length <= options.maxCalls);
    assert.equal(w.writes(), 0);
  }
  const w = world();
  await assert.rejects(captureHistoricalSubtree(w.client, ROOT, { maxCalls: 0 }), /INVALID_CAPTURE_BOUND/);
  await assert.rejects(captureHistoricalSubtree(w.client, "https://notion.so/other-OS"), /INVALID_OBJECT_ID/);
  assert.equal(w.calls.length, 0);
});

test("W7.3 snapshot: file signing changes do not hide a different asset", async () => {
  for (const assetChanged of [false, true]) {
    const w = world(), original = w.client.retrievePage;
    let calls = 0;
    w.client.retrievePage = async id => {
      const p = await original(id) as Record<string, unknown>;
      if (id === ROOT) {
        calls++;
        p["cover"] = { type: "file", file: { url: `https://files.example.invalid/${assetChanged && calls > 1 ? "other" : "same"}.png?signature=${calls}`, expiry_time: `${calls}` } };
      }
      return p;
    };
    const s = await captureHistoricalSubtree(w.client, ROOT);
    assert.equal(s.status, assetChanged ? "INCOMPLETE" : "COMPLETE_CONTAINMENT");
    assert.equal(s.binary_assets_copied, false);
  }
});

test("W7.3 snapshot: incomplete or tampered copies cannot be replayed as valid test inputs", async () => {
  const w = world(), s = await captureHistoricalSubtree(w.client, ROOT);
  const incomplete = { ...s, status: "INCOMPLETE" as const };
  assert.throws(() => replayHistoricalSnapshot(incomplete, historicalSnapshotDigest(incomplete)), /INCOMPLETE_SNAPSHOT/);
  const changed = structuredClone(s);
  (changed.reads.find(read => read.method === "retrievePage" && read.args[0] === A)!.value as Record<string, unknown>)["properties"] = {};
  assert.throws(() => replayHistoricalSnapshot(changed, historicalSnapshotDigest(s)), /SNAPSHOT_INTEGRITY_MISMATCH/);
  const serialized = JSON.parse(JSON.stringify(s));
  assert.deepEqual(await replayHistoricalSnapshot(serialized, historicalSnapshotDigest(s)).retrievePage(A), w.map.get(`page:${A}`));
});

test("W7.3 snapshot/B2: the independently pinned manifest rejects swapped reads, removed rows and metadata edits", async () => {
  const s = await captureHistoricalSubtree(world().client, ROOT), pinned = historicalSnapshotDigest(s);
  for (const fault of ["swap-values", "swap-args", "remove-read", "metadata", "recompute-read-hash"] as const) {
    const changed = structuredClone(s);
    const a = changed.reads.find(read => read.method === "retrievePage" && read.args[0] === A)!;
    const b = changed.reads.find(read => read.method === "retrievePage" && read.args[0] === B)!;
    if (fault === "swap-values") [a.value, b.value] = [b.value, a.value];
    if (fault === "swap-args") [a.args, b.args] = [b.args, a.args];
    if (fault === "remove-read") { changed.reads = changed.reads.filter(read => read !== a); changed.page_refs = changed.page_refs.filter(ref => ref !== A); }
    if (fault === "metadata") { changed.issues = [{ code: "hidden-hold", ref: ROOT }]; changed.status = "INCOMPLETE"; }
    if (fault === "recompute-read-hash") {
      a.value = {};
      a.sha256 = createHash("sha256").update(JSON.stringify({ args: a.args, method: a.method, value: {} })).digest("hex");
    }
    assert.throws(() => replayHistoricalSnapshot(changed, pinned), /SNAPSHOT_INTEGRITY_MISMATCH/, fault);
  }
});

test("W7.3 snapshot/B3: possible property-reference truncation and computed values are flagged, not ordinary long text", async () => {
  for (const type of ["rich_text", "title", "people", "rollup", "formula"] as const) {
    const w = world(), row = w.map.get(`page:${A}`) as { properties: Record<string, unknown> };
    row.properties["Limited"] = { id: "limited", type, [type]: type === "rollup" || type === "formula" ? { type: "number", number: 1 }
      : Array.from({ length: 25 }, () => type === "people" ? { object: "user", id: EXTERNAL } : { type: "mention", mention: { type: "page", page: { id: EXTERNAL } }, plain_text: "policy" }) };
    const s = await captureHistoricalSubtree(w.client, ROOT);
    assert.equal(s.status, "INCOMPLETE", type);
    assert.ok(s.issues.some(issue => issue.code === "PROPERTY_POSSIBLY_TRUNCATED"), type);
  }
  const w = world(), row = w.map.get(`page:${A}`) as { properties: Record<string, unknown> };
  row.properties["Long text"] = { type: "rich_text", rich_text: Array.from({ length: 25 }, () => ({ type: "text", plain_text: "Texte métier complet" })) };
  assert.equal((await captureHistoricalSubtree(w.client, ROOT)).status, "COMPLETE_CONTAINMENT", "Notion's limit is references, not text runs");
});

test("W7.3 snapshot/B4: external link targets and database/data-source mentions are inventoried without dereferencing", async () => {
  const w = world();
  w.map.set(`children:${A}:`, list([
    { id: ref(11), type: "link_to_page", link_to_page: { type: "page_id", page_id: EXTERNAL } },
    { id: ref(12), type: "link_to_page", link_to_page: { type: "database_id", database_id: ref(13) } },
    { id: ref(14), type: "paragraph", paragraph: { rich_text: [
      { type: "mention", mention: { type: "database", database: { id: ref(15) } } },
      { type: "mention", mention: { type: "data_source", data_source: { id: ref(16) } } },
      { type: "text", href: `https://www.notion.com/p/${ref(17)}`, plain_text: "External link" },
    ] } },
  ]));
  const s = await captureHistoricalSubtree(w.client, ROOT);
  assert.equal(s.status, "COMPLETE_CONTAINMENT");
  assert.deepEqual(s.external_refs, [EXTERNAL, ref(13), ref(15), ref(16), ref(17)]);
  assert.equal(w.calls.some(call => s.external_refs.includes(call.ref)), false);
  assert.equal(s.comments_captured, false); assert.equal(s.edit_history_captured, false);
  assert.equal(s.archived_records_complete, false); assert.equal(s.external_semantic_closure_claimed, false);
});

test("W7.3 snapshot/B1: byte-split UTF-8 preserves accents/emoji, and corrupted or incomplete transport refuses before persistence", async () => {
  const s = await captureHistoricalSubtree(world().client, ROOT);
  const result = { kind: "PRIVATE_CAPTURE_RESULT", snapshot: s, comment: "Décision vérifiée 🙂" };
  const payload = JSON.stringify(result), checksum = createHash("sha256").update(payload).digest("hex");
  const bytes = Buffer.from(`${JSON.stringify({ kind: "PRIVATE_CAPTURE_DIGEST", sha256: checksum })}\n${payload}\n`);
  const receiver = createSnapshotReceiver();
  for (const byte of bytes) receiver.push(Uint8Array.of(byte));
  const received = receiver.finish();
  assert.equal(received.encoded, payload); assert.equal(received.snapshot_sha256, historicalSnapshotDigest(s));
  assert.deepEqual(received.result, JSON.parse(payload));
  for (const damaged of [bytes.subarray(0, -2), Buffer.from(bytes.toString("utf8").replace("Décision", "Decision"))]) {
    const invalid = createSnapshotReceiver(); invalid.push(damaged);
    assert.throws(() => invalid.finish(), /CAPTURE_TRANSPORT_MISMATCH/);
  }
  const bounded = createSnapshotReceiver(undefined, 1);
  assert.throws(() => bounded.push(bytes), /CAPTURE_TRANSPORT_BOUND/);
});

test("W7.3 snapshot: a database moved outside the selected subtree refuses before its schema or rows are read", async () => {
  const w = world();
  (w.map.get(`database:${DB}`) as { parent: { page_id: string } }).parent.page_id = EXTERNAL;
  const s = await captureHistoricalSubtree(w.client, ROOT);
  assert.equal(s.status, "INCOMPLETE");
  assert.ok(s.issues.some(issue => issue.code === "DATABASE_PARENT_MISMATCH"));
  assert.equal(w.calls.some(call => call.ref === DS || call.ref === A || call.ref === B), false);
  assert.equal(w.writes(), 0);
});
