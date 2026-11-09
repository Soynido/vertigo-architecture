/** R4: structure is deduplicated within one fresh guard check, never across checks. Local fixtures only. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readGuardSnapshot } from "../../src/guards/snapshot.ts";
import { openGuard, guardStillApproved } from "../../src/guards/preflight.ts";
import type { NotionReadClient } from "../../src/notion/readClient.ts";
import { bindLive } from "../../src/tools/handlers.ts";
import { rehydrate } from "../../src/resume/engine.ts";
import { OWNER } from "./binding-fixtures.ts";
import { G, guardWorld, index, NOW, setIndex } from "../support/guard-fixtures.ts";
import { R } from "./resume-fixtures.ts";

async function world() {
  const g = guardWorld();
  const h = await g.bind();
  await g.approve();
  const bound = await bindLive(h, { principal_id: OWNER.principal_id, now: NOW }, g.deps);
  assert.ok(bound.ok);
  const spec = bound.runtime.adapter.controlPlane.productionGuard;
  assert.ok(spec);
  const counts = new Map<string, number>();
  const queryArgs: unknown[][] = [];
  const count = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
  const inner = g.deps.notion;
  const client: NotionReadClient = {
    retrieveDatabase(id) { count(`database:${id}`); return inner.retrieveDatabase(id); },
    retrieveDataSource(id) { count(`data_source:${id}`); return inner.retrieveDataSource(id); },
    retrieveBlockChildren(id, cursor) { count(`children:${id}:${cursor ?? ""}`); return inner.retrieveBlockChildren(id, cursor); },
    retrievePage(id) { count(`page:${id}`); return inner.retrievePage(id); },
    queryDataSource(id, filter, cursor, options) {
      count(`query:${id}`); queryArgs.push([id, filter, cursor, options]);
      return inner.queryDataSource(id, filter, cursor, options);
    },
  };
  const read = (reader: NotionReadClient = client) => readGuardSnapshot({ client: reader, runtime: bound.runtime, spec, t0: NOW, indexPageId: G.indexPage });
  return { g, bound, client, counts, queryArgs, read };
}

test("R4 guard: each structural key is read once per snapshot; pages/queries and query options are fresh", async () => {
  const w = await world();
  const first = await w.read();
  assert.ok(first.ok);
  const structures = [...w.counts].filter(([k]) => /^(children|database|data_source):/.test(k));
  assert.ok(structures.length > 0);
  assert.deepEqual(structures.filter(([, n]) => n !== 1), []);
  assert.equal(w.counts.get(`children:${G.root}:`), 1);
  assert.equal(w.counts.get(`query:${G.runtimeDs}`), 2, "TIMEZONE and constraints are distinct fresh queries");
  for (const [, , , options] of w.queryArgs) assert.deepEqual(options, { page_size: 100 });
  const second = await w.read();
  assert.ok(second.ok);
  assert.equal(second.snapshot.digest, first.snapshot.digest, "deduplication does not change approval identity");
  for (const [key] of structures) assert.equal(w.counts.get(key), 2, `next check rereads ${key}`);
  assert.equal(w.counts.get(`page:${G.indexPage}`), 2);
  assert.equal(w.counts.get(`query:${G.runtimeDs}`), 4);
  assert.equal(w.g.client.writes.length, 0);
});

test("R4 guard: the next before-byte check refuses a changed index without reusing the open snapshot", async () => {
  const w = await world();
  const opened = await openGuard({ ...w.g.deps, notion: w.client }, w.bound.binding, w.bound.runtime, NOW);
  assert.equal(opened.kind, "OPEN");
  if (opened.kind !== "OPEN") return;
  setIndex(w.g.map, { ...index(), revision: 2 });
  assert.equal(await guardStillApproved({ notion: w.client }, w.bound.runtime, opened, NOW), false);
  assert.equal(w.counts.get(`children:${G.indexPage}:`), 2);
  assert.equal(w.g.client.writes.length, 0);
});

test("R4 guard: schema removal between checks is observed and fails closed", async () => {
  const w = await world();
  assert.ok((await w.read()).ok);
  const schema = w.g.map.get(`data_source:${G.rulesDs}`) as { properties: Record<string, unknown> };
  const { Active: _removed, ...properties } = schema.properties;
  w.g.map.set(`data_source:${G.rulesDs}`, { ...schema, properties });
  const after = await w.read();
  assert.equal(after.ok, false);
  if (!after.ok) assert.match(after.reason, /Active/);
  assert.equal(w.counts.get(`data_source:${G.rulesDs}`), 2);
  assert.equal(w.g.client.writes.length, 0);
});

test("R4 guard: duplicate declaring index page between checks is not hidden by structural deduplication", async () => {
  const w = await world();
  assert.ok((await w.read()).ok);
  const key = `children:${G.constitution}`;
  const children = w.g.map.get(key) as { results: unknown[] };
  w.g.map.set(key, { ...children, results: [...children.results, children.results[0]] });
  assert.equal((await w.read()).ok, false);
  assert.equal(w.counts.get(`${key}:`), 2);
  assert.equal(w.g.client.writes.length, 0);
});

test("R4 guard: structural pagination preserves each cursor and is deduplicated by page, not just holder", async () => {
  const w = await world();
  const calls: (string | undefined)[] = [];
  const original = await w.client.retrieveBlockChildren(G.root) as { results: unknown[] };
  const reader: NotionReadClient = {
    ...w.client,
    async retrieveBlockChildren(id, cursor) {
      if (id !== G.root) return w.client.retrieveBlockChildren(id, cursor);
      calls.push(cursor);
      if (!cursor) return { results: original.results.slice(0, 1), has_more: true, next_cursor: "root-page-2" };
      assert.equal(cursor, "root-page-2");
      return { results: original.results.slice(1), has_more: false, next_cursor: null };
    },
  };
  assert.ok((await w.read(reader)).ok);
  assert.deepEqual(calls, [undefined, "root-page-2"]);
});

test("R4 guard: row pagination forwards the filter/cursor/options and reads to a proven end", async () => {
  const w = await world();
  const calls: unknown[][] = [];
  const reader: NotionReadClient = {
    ...w.client,
    async queryDataSource(id, filter, cursor, options) {
      if (id !== G.rulesDs) return w.client.queryDataSource(id, filter, cursor, options);
      calls.push([filter, cursor, options]);
      if (!cursor) return { results: [], has_more: true, next_cursor: "rules-page-2" };
      assert.equal(cursor, "rules-page-2");
      return w.client.queryDataSource(id, filter, cursor, options);
    },
  };
  assert.ok((await w.read(reader)).ok);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], [calls[0]![0], "rules-page-2", { page_size: 100 }]);
});

test("W7.1 resume cost: one structural read per candidate observation, identical facts and fresh page/query calls", async t => {
  const w = await world();
  const read = (automatic: boolean) => rehydrate(w.client, w.bound.binding, w.bound.runtime, w.g.deps.store, NOW, undefined, automatic);
  const before = await read(false);
  const uncached = new Map(w.counts);
  w.counts.clear();
  const after = await read(true);
  assert.deepEqual(after, before, "structural deduplication cannot change the observed result");
  const structure = (counts: Map<string, number>) => [...counts].filter(([k]) => /^(children|database|data_source):/.test(k));
  const total = (counts: Map<string, number>) => structure(counts).reduce((n, [, count]) => n + count, 0);
  t.diagnostic(`structural reads: uncached=${total(uncached)}, candidate=${total(w.counts)}`);
  assert.ok(total(w.counts) < total(uncached), "resume still rediscovers the same runtime structure");
  assert.deepEqual(structure(w.counts).filter(([, n]) => n !== 1), []);
  const facts = (counts: Map<string, number>) => [...counts].filter(([k]) => /^(page|query):/.test(k)).sort(([a], [b]) => a.localeCompare(b));
  const expectedFacts = new Map(uncached);
  assert.equal(uncached.get(`query:${G.configDs}`), 8, "pending input plus seven separate evidence keys");
  assert.equal(w.counts.get(`query:${G.configDs}`), 2, "pending input plus one complete fresh grouped evidence query");
  expectedFacts.set(`query:${G.configDs}`, 2);
  assert.deepEqual(facts(w.counts), facts(expectedFacts), "all other page/query observations are unchanged");
  assert.ok(facts(w.counts).some(([k, n]) => k.startsWith("query:") && n > 1), "repeated business queries remain fresh");
  assert.equal(w.g.client.writes.length, 0);
});

test("W7.1 resume cost: next candidate observation rereads changed structure, not the preceding snapshot", async () => {
  const w = await world();
  const read = () => rehydrate(w.client, w.bound.binding, w.bound.runtime, w.g.deps.store, NOW, undefined, true);
  const first = await read();
  assert.equal(first.kind, "OK", JSON.stringify(first));
  const key = `children:${G.root}`;
  const children = w.g.map.get(key) as { results: { id: string }[] };
  const parent = children.results.find(b => b.id === R.salesCp);
  assert.ok(parent);
  w.g.map.set(key, { ...children, results: [...children.results, parent] });
  const second = await read();
  assert.equal(second.kind, "HOLD");
  if (second.kind === "HOLD") assert.equal(second.code, "HOLD_REQUIRED_RESOURCE_MISSING");
  assert.equal(w.counts.get(`${key}:`), 2);
  assert.equal(w.g.client.writes.length, 0);
});

test("W7.1 resume cost: next candidate observation still queries the current rows freshly", async () => {
  const w = await world();
  const read = () => rehydrate(w.client, w.bound.binding, w.bound.runtime, w.g.deps.store, NOW, undefined, true);
  assert.equal((await read()).kind, "OK");
  const key = `query:${R.salesStateDs}`;
  const query = w.g.map.get(key) as { results: unknown[] };
  w.g.map.set(key, { ...query, results: [...query.results, ...query.results] });
  const next = await read();
  assert.equal(next.kind, "HOLD");
  if (next.kind === "HOLD") assert.match(next.evidence.join(" "), /CURRENT.*found 2/);
  assert.equal(w.counts.get(key), 2);
  assert.equal(w.g.client.writes.length, 0);
});
