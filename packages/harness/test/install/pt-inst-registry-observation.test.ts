import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectInstallBootstrap, mappingIntentTemplate } from "../../src/install/bootstrap.ts";
import { runInstallBatch } from "../../src/install/execute.ts";
import { prepareInstall } from "../../src/install/plan.ts";
import type { NotionReadClient } from "../../src/notion/readClient.ts";
import { normalizeId, type Page } from "../../src/notion/shapes.ts";
import { bindLive } from "../../src/tools/handlers.ts";
import { Deadline } from "../../src/transactions/budget.ts";
import { buildInstallWorld } from "../unit/install-fixtures.ts";
import { boundHandle, CTX, writerOf } from "./drive.ts";

async function prepared() {
  const world = buildInstallWorld();
  const writer = writerOf(world);
  const live = await bindLive(await boundHandle(world), CTX, world.deps);
  assert.ok(live.ok);
  const principal = await world.deps.principals.get(live.binding.principal_id);
  assert.ok(principal);
  const now = new Date("2030-01-02T00:00:00.000Z");
  const plan = await prepareInstall(world.deps, live.binding, live.runtime,
    mappingIntentTemplate(await inspectInstallBootstrap(world.deps.notion, live.runtime)), now);
  assert.equal(plan.kind, "PREPARED");
  assert.ok(plan.kind === "PREPARED");
  const run = (notion: NotionReadClient) => runInstallBatch({ ...world.deps, notion }, {
    binding: live.binding, runtime: live.runtime, principal, writer,
    clock: () => now, deadline: new Deadline(() => now.getTime()),
  });
  return { world, writer, plan: plan.plan, run };
}

test("W4.7R2: preopened mapping batch resolves only Registry metadata and has linear fresh row reads", async () => {
  const { world, run } = await prepared();
  const inner = world.deps.notion;
  const sources = new Set<string>();
  let pages = 0, scans = 0, filtered = 0;
  const notion: NotionReadClient = {
    retrieveDatabase: inner.retrieveDatabase.bind(inner),
    retrieveBlockChildren: inner.retrieveBlockChildren.bind(inner),
    retrieveDataSource(id) { sources.add(id); return inner.retrieveDataSource(id); },
    retrievePage(id) { pages += 1; return inner.retrievePage(id); },
    queryDataSource(id, filter, cursor, options) {
      if (filter === undefined) scans += 1; else filtered += 1;
      return inner.queryDataSource(id, filter, cursor, options);
    },
  };
  const out = await run(notion);
  assert.equal(out.kind, "CONTINUE");
  assert.equal(out.writes_sent, 30);
  assert.deepEqual([...sources], [world.ids.registryDs], "normal mapping observations must not rediscover all37 resources");
  assert.ok(pages < 120, `quadratic repeated row GETs: ${pages}`);
  assert.ok(scans > 1 && filtered > 1, "each observation needs fresh rows plus independent filtered canary query");
});

for (const mode of ["stale", "missing"] as const) {
  test(`W4.7R2: ${mode} scan candidates fall back to GET without a second write`, async () => {
    const { world, plan, writer, run } = await prepared();
    const inner = world.deps.notion;
    const first = plan.stage1_writes.find((w) => w.symbol === "MAP_0")!;
    const stale = structuredClone(await inner.retrievePage(first.target_ref)) as Page;
    let scans = 0, firstGets = 0;
    const notion: NotionReadClient = {
      retrieveDatabase: inner.retrieveDatabase.bind(inner),
      retrieveDataSource: inner.retrieveDataSource.bind(inner),
      retrieveBlockChildren: inner.retrieveBlockChildren.bind(inner),
      retrievePage(id) { if (normalizeId(id) === normalizeId(first.target_ref)) firstGets += 1; return inner.retrievePage(id); },
      async queryDataSource(id, filter, cursor, options) {
        const q = await inner.queryDataSource(id, filter, cursor, options) as { results: Page[] };
        if (id !== world.ids.registryDs || filter !== undefined) return q;
        scans += 1;
        return { ...q, results: q.results.flatMap((p) => normalizeId(p.id) === normalizeId(first.target_ref) ? mode === "missing" ? [] : [stale] : [p]) };
      },
    };
    const out = await run(notion);
    assert.equal(out.writes_sent, 30);
    assert.ok(scans > 1 && firstGets > 1, "stale/missing scan must cause fresh GET fallback");
    assert.equal(writer.writes.filter((w) => w.ctx.symbol === "MAP_0").length, 1, "stale scan replayed a mapping write");
  });
}
