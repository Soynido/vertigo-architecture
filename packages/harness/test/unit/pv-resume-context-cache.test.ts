import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatch } from "../../src/tools/handlers.ts";
import type { NotionReadClient } from "../../src/notion/readClient.ts";
import { StructureCache } from "../../src/notion/structureCache.ts";
import { buildResumeWorld, gateRow, R } from "./resume-fixtures.ts";
import { handleOf, OWNER, REP_B, T0 } from "./binding-fixtures.ts";
import { IDS } from "./sales-fixtures.ts";
import { synthetic, text } from "./meta-fixtures.ts";
import type { LocalOperatingDocuments } from "../../src/contractPack/localOperatingDocuments.ts";

const root = IDS("rep-a").root, daily = synthetic("cache-daily"), engine = synthetic("cache-engine");
const titles = ["04 — DAILY GO PROTOCOL", "04A — DAILY DECISION ENGINE"];
const list = (results: unknown[]) => ({ results, has_more: false, next_cursor: null });
const page = (id: string, parent: string) => ({ object: "page", id, archived: false, in_trash: false,
  parent: { type: "page_id", page_id: parent } });
const child = (id: string, title: string) => ({ id, type: "child_page", archived: false, in_trash: false,
  has_children: false, parent: { type: "page_id", page_id: R.salesCp }, child_page: { title } });
const paragraph = (id: string, content: string) => ({ id: synthetic(`cache-paragraph-${id}`), type: "paragraph",
  archived: false, in_trash: false, has_children: false, parent: { type: "page_id", page_id: id },
  paragraph: { rich_text: [text(content)] } });
const ctx = { principal_id: OWNER.principal_id, now: T0 };
const data = (e: Awaited<ReturnType<typeof dispatch>>) => (e.status === "OK" ? e.result : e.observations) as Record<string, unknown>;

/** Local-only synthetic source. The first CP read belongs to safety; documents appear only afterwards. */
function instrument(base: NotionReadClient) {
  const calls: { method: string; args: unknown[] }[] = [];
  const count = (method: string, ref: string) => calls.filter((c) => c.method === method && c.args[0] === ref).length;
  let content = "First local instruction — preserve CURRENT", hideEngine = false;
  const note = (method: string, args: unknown[]) => { calls.push({ method, args }); };
  const decorate = (v: unknown, parent: string, extra: unknown[] = []) => {
    const a = v as { results: Record<string, unknown>[] };
    return list([...a.results.map((b) => ({ ...b, archived: false, in_trash: false, has_children: false,
      parent: { type: "page_id", page_id: parent } })), ...extra]);
  };
  const notion: NotionReadClient = {
    async retrievePage(r) {
      note("page", [r]);
      return r === R.salesCp ? page(r, root) : r === daily || r === engine ? page(r, R.salesCp) : base.retrievePage(r);
    },
    async retrieveDatabase(...a) { note("database", a); return base.retrieveDatabase(...a); },
    async retrieveDataSource(...a) { note("source", a); return base.retrieveDataSource(...a); },
    async queryDataSource(...a) { note("query", a); return base.queryDataSource(...a); },
    async retrieveBlockChildren(r, cursor) {
      note("children", [r, cursor]);
      if (r === daily || r === engine) return list([paragraph(r, content)]);
      const v = await base.retrieveBlockChildren(r, cursor);
      if (r === root) return decorate(v, r);
      if (r !== R.salesCp) return v;
      // An earlier safety snapshot must NOT seed the later context cache.
      const extra = count("children", R.salesCp) === 1 ? []
        : [child(daily, titles[0]!), ...(hideEngine ? [] : [child(engine, titles[1]!)])];
      return decorate(v, r, extra);
    },
  };
  return { notion, calls, count, change: () => { content = "Updated local instruction — keep the existing OS"; hideEngine = true; } };
}

test("resume context cache: share only post-hydration structure, preserve source text, safety and durable state", async () => {
  const w = buildResumeWorld(), h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps));
  const before = structuredClone([...w.map]), events = await w.deps.store.events.list();
  const f = instrument(w.deps.notion);
  const e = await dispatch("os_resume", { binding_handle: h, topic_hint: "CURRENT_WORK" }, ctx, { ...w.deps, notion: f.notion });
  assert.equal(e.code, "RESUMED");
  const docs = data(e).local_operating_documents as LocalOperatingDocuments;
  assert.equal(docs.status, "COMPLETE"); assert.equal(docs.documents.length, 2);
  assert.equal(docs.documents[0]!.items[0]!.text, "First local instruction — preserve CURRENT");
  assert.equal(f.count("children", root), 3, "liveness and safety each read fresh; context shares its own third read");
  assert.equal(f.count("children", R.salesCp), 2, "safety is not cached with context; DAILY and local manuals share the second read");
  assert.equal(f.count("page", root), 3, "liveness and both local readers each retrieve fresh page facts");
  assert.equal(f.count("children", daily), 1); assert.equal(f.count("children", engine), 1);
  assert.equal(data(e).recovery_required, false); assert.equal(e.ask, "Who is the ideal customer?");
  assert.deepEqual([...w.map], before); assert.deepEqual(await w.deps.store.events.list(), events);
  assert.ok(e.binding && e.binding !== "UNKNOWN");
  assert.deepEqual(await w.deps.store.plans.listByRuntime("VERTIGO", "SALES", e.binding.runtime_generation), []);
});

test("resume context cache: next exchange rereads changed structure, document text and cursor facts", async () => {
  const w = buildResumeWorld(), h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps));
  const f = instrument(w.deps.notion), deps = { ...w.deps, notion: f.notion };
  assert.equal((await dispatch("os_resume", { binding_handle: h, topic_hint: "CURRENT_WORK" }, ctx, deps)).code, "RESUMED");
  f.change(); f.calls.length = 0;
  w.setSalesState({ nextQuestion: "Which client should we prioritize now?" });
  const e = await dispatch("os_resume", { binding_handle: h, topic_hint: "CURRENT_WORK" }, ctx, deps);
  const docs = data(e).local_operating_documents as LocalOperatingDocuments;
  assert.equal(docs.status, "PARTIAL"); assert.equal(docs.documents.length, 1);
  assert.equal(docs.documents[0]!.items[0]!.text, "Updated local instruction — keep the existing OS");
  assert.equal(e.ask, "Which client should we prioritize now?");
  assert.equal(f.count("children", root), 3); assert.equal(f.count("children", R.salesCp), 2);
  assert.ok(f.count("query", R.salesStateDs) > 0, "cursor query is fresh on the next exchange");
});

test("resume context cache: ownership and recovery refusals never read local manuals", async () => {
  const w = buildResumeWorld(), h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps));
  const f = instrument(w.deps.notion), deps = { ...w.deps, notion: f.notion };
  const denied = await dispatch("os_resume", { binding_handle: h, topic_hint: "CURRENT_WORK" }, { ...ctx, principal_id: REP_B.principal_id }, deps);
  assert.equal(denied.code, "ERROR_PRINCIPAL_MISMATCH"); assert.equal(f.calls.length, 0);
  w.setSalesState({ recovery: true });
  const held = await dispatch("os_resume", { binding_handle: h, topic_hint: "CURRENT_WORK" }, ctx, deps);
  assert.equal(held.code, "HOLD_RECOVERY_REQUIRED");
  assert.equal((data(held).local_operating_documents as LocalOperatingDocuments).status, "NOT_SELECTED");
  assert.equal(f.count("children", daily), 0); assert.equal(f.count("children", engine), 0);
});

test("resume context cache: META retains its own cursor, fresh next exchange and zero SALES manual reads", async () => {
  const w = buildResumeWorld(), h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps));
  const f = instrument(w.deps.notion), deps = { ...w.deps, notion: f.notion };
  const first = await dispatch("os_resume", { binding_handle: h }, ctx, deps);
  assert.equal(first.code, "RESUMED");
  assert.equal((data(first).local_operating_documents as LocalOperatingDocuments).status, "NOT_SELECTED");
  assert.equal((data(first).local_business_configuration as { status: string }).status, "NOT_SELECTED");
  const next = "What should META prioritize next?";
  w.setMetaGates([gateRow({ id: R.gateM1, key: "T1", status: "OPEN", nextQuestion: next,
    nextAction: "Ask the next META question", lastEdited: "2030-01-02T00:00:00.000Z" })]);
  const second = await dispatch("os_resume", { binding_handle: h }, ctx, deps);
  assert.equal(second.code, "RESUMED"); assert.equal(second.ask, next);
  assert.equal(f.count("children", root), 0); assert.equal(f.count("children", daily), 0); assert.equal(f.count("children", engine), 0);
});

test("resume context cache primitive: pages and queries are never memoized, pagination is distinct and failures evicted", async () => {
  let pages = 0, queries = 0, attempts = 0;
  const cursors: (string | undefined)[] = [], filters: unknown[] = [];
  const c = new StructureCache({
    async retrievePage() { return ++pages; },
    async queryDataSource(_r, filter, _cursor, options) { filters.push({ filter, options }); return ++queries; },
    async retrieveBlockChildren(_r, cursor) { cursors.push(cursor); return { cursor }; },
    async retrieveDatabase() { if (++attempts === 1) throw new Error("metadata failure"); return attempts; },
    async retrieveDataSource() { return {}; },
  });
  assert.equal(await c.retrievePage(root), 1); assert.equal(await c.retrievePage(root), 2);
  for (const n of [1, 2]) assert.equal(await c.queryDataSource(root, { equals: n }, undefined, { page_size: n }), n);
  assert.deepEqual(filters, [{ filter: { equals: 1 }, options: { page_size: 1 } }, { filter: { equals: 2 }, options: { page_size: 2 } }]);
  await c.retrieveBlockChildren(root); await c.retrieveBlockChildren(root); await c.retrieveBlockChildren(root, "next"); await c.retrieveBlockChildren(root, "next");
  assert.deepEqual(cursors, [undefined, "next"]);
  await assert.rejects(c.retrieveDatabase(root), /metadata failure/);
  assert.equal(await c.retrieveDatabase(root), 2); assert.equal(await c.retrieveDatabase(root), 2); assert.equal(attempts, 2);
});
