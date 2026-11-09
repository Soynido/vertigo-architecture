import assert from "node:assert/strict";
import { test } from "node:test";
import { runInstallBatch } from "../../src/install/execute.ts";
import type { NotionReadClient } from "../../src/notion/readClient.ts";
import { StructureCache } from "../../src/notion/structureCache.ts";
import { bindLive } from "../../src/tools/handlers.ts";
import { Deadline } from "../../src/transactions/budget.ts";
import { buildInstallWorld } from "../unit/install-fixtures.ts";
import { boundHandle, CTX, writerOf } from "./drive.ts";

async function instrument() {
  const world = buildInstallWorld();
  const handle = await boundHandle(world);
  const live = await bindLive(handle, CTX, world.deps);
  assert.ok(live.ok);
  const principal = await world.deps.principals.get(live.binding.principal_id);
  assert.ok(principal);
  const inner = world.deps.notion;
  const counts = new Map<string, number>();
  const count = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
  const notion: NotionReadClient = {
    retrieveDatabase(id) { count(`database:${id}`); return inner.retrieveDatabase(id); },
    retrieveDataSource(id) { count(`data_source:${id}`); return inner.retrieveDataSource(id); },
    retrieveBlockChildren(id, cursor) { count(`children:${id}:${cursor ?? ""}`); return inner.retrieveBlockChildren(id, cursor); },
    retrievePage(id) { count(`page:${id}`); return inner.retrievePage(id); },
    queryDataSource(id, filter, cursor, options) { count(`query:${id}`); return inner.queryDataSource(id, filter, cursor, options); },
  };
  const writer = writerOf(world);
  const clock = () => new Date("2030-01-02T00:00:00.000Z");
  const run = () => runInstallBatch({ ...world.deps, notion }, {
    binding: live.binding, runtime: live.runtime, principal, writer, clock,
    deadline: new Deadline(() => clock().getTime()),
  });
  return { world, counts, writer, run };
}

test("W4.7R: one structural read per key per installer batch, but repeated pages and queries stay fresh", async () => {
  const { counts, run } = await instrument();
  const out = await run();
  assert.equal(out.kind, "CONTINUE");
  assert.equal(out.writes_sent, 30);
  const structure = [...counts].filter(([key]) => /^(database|data_source|children):/.test(key));
  assert.ok(structure.length > 0);
  assert.deepEqual(structure.filter(([, n]) => n !== 1), [], "installer reread cached structure");
  assert.ok([...counts].some(([key, n]) => key.startsWith("page:") && n > 1), "page observations must not be memoized");
  assert.ok([...counts].some(([key, n]) => key.startsWith("query:") && n > 1), "query observations must not be memoized");
});

test("W4.7R: the next batch rereads structure and refuses a removed required option without writing", async () => {
  const { world, counts, writer, run } = await instrument();
  assert.equal((await run()).writes_sent, 30);
  const key = `data_source:${world.ids.registryDs}`;
  const source = world.map.get(key) as { properties: Record<string, { type: string; select: { options: { name: string }[] } }> };
  const field = source.properties["Scope"]!;
  world.map.set(key, { ...source, properties: { ...source.properties, "Scope": {
    ...field, select: { options: field.select.options.filter((o) => o.name !== "READ_WRITE") },
  } } });
  const sent = writer.writes.length;
  counts.clear();
  const out = await run();
  assert.equal(out.kind, "HOLD");
  assert.equal(out.writes_sent, 0);
  assert.equal(writer.writes.length, sent, "an undeclared select option must not trigger a write/schema extension");
  assert.equal(counts.get(key), 1, "next batch must discard the previous structural snapshot");
});

test("W4.7R: failed structural reads are evicted rather than reused", async () => {
  const world = buildInstallWorld();
  const inner = world.deps.notion;
  let attempts = 0;
  const cache = new StructureCache({
    retrieveDatabase: inner.retrieveDatabase.bind(inner),
    retrieveBlockChildren: inner.retrieveBlockChildren.bind(inner),
    retrievePage: inner.retrievePage.bind(inner),
    queryDataSource: inner.queryDataSource.bind(inner),
    async retrieveDataSource(id) {
      attempts += 1;
      if (attempts === 1) throw new Error("transient metadata failure");
      return inner.retrieveDataSource(id);
    },
  });
  await assert.rejects(cache.retrieveDataSource(world.ids.registryDs), /transient metadata failure/);
  const recovered = await cache.retrieveDataSource(world.ids.registryDs);
  assert.equal(await cache.retrieveDataSource(world.ids.registryDs), recovered);
  assert.equal(attempts, 2);
});
