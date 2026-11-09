/**
 * PT-CP-017 — W3.4R / E2E-J:E5: DAILY_PRODUCTION_HEALTH, the 14th and last DAILY source (CONTRACT_PACK 0.3.1
 * candidate, NOT ADOPTED). The OS declares its own production health in its single `OS State/CURRENT` row; the harness
 * only transports it, when the DAILY_GO Run named by its physical UUID proves it, and is ABSENT otherwise — never a
 * HOLD, never a computed health. Every id and value is synthetic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

import { CONTEXT_SECTIONS, DAILY_SOURCE_KEYS } from "../../src/contractPack/catalog.ts";
import { readDailySources } from "../../src/contractPack/dailySources.ts";
import { buildContractPack, type ContextSource } from "../../src/contractPack/pack.ts";
import type { Page } from "../../src/notion/shapes.ts";
import { buildSetupWorld, runtimeOf } from "./pt-cp-012.fixtures.ts";
import { DailyClient, installDailyTable } from "./pt-cp-013.fixtures.ts";
import { synthetic } from "./meta-fixtures.ts";
import { IDS as SALES_IDS } from "./sales-fixtures.ts";

const KEY = DAILY_SOURCE_KEYS.PRODUCTION_HEALTH;
const ZONE = "Europe/Paris";
/** 10:00Z is 12:00 in Paris (CEST): the instance's civil today is 2026-09-29. */
const NOW = new Date("2026-09-29T10:00:00.000Z");

const TIMEZONE_FILTER = { property: "Config", title: { equals: "TIMEZONE" } };
const CURRENT_FILTER = { property: "Name", title: { equals: "CURRENT" } };

const rich = (s: string) => [{ type: "text", plain_text: s }];
type DateCell = { readonly start: string; readonly end: string | null; readonly time_zone: string | null } | null;
const dateCell = (d: string | DateCell): DateCell => (typeof d === "string" ? { start: d, end: null, time_zone: null } : d);
const dashed = (id: string) => `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;

const STATE_SCHEMA = {
  Name: { type: "title" },
  "Production Health": { type: "select" },
  "Production Health Run Ref": { type: "rich_text" },
  "Last Daily Run": { type: "date" },
};
const RUNS_SCHEMA = {
  Run: { type: "title" },
  "Run Type": { type: "select" },
  Status: { type: "select" },
  Created: { type: "created_time" },
  Finished: { type: "date" },
};

interface HealthSpec {
  /** The declared value; `null` leaves the select empty. */
  readonly health?: string | null;
  /** The text of Production Health Run Ref; a function receives the own Run id and the rival Run id. */
  readonly ref?: (own: string, rival: string) => string;
  readonly last?: string | DateCell;
  readonly runType?: string;
  readonly status?: string;
  readonly created?: string;
  /** `date` makes Created a date column, whose value must still be a full date-time. */
  readonly createdAsDate?: boolean;
  readonly finished?: string | DateCell;
  readonly archived?: boolean;
  /** How many `CURRENT` rows the server holds for the exact Name filter (default 1). */
  readonly currentRows?: number;
  /** The instance declares its TIMEZONE (default true). */
  readonly zone?: boolean;
  /** Replaces the OS State schema. */
  readonly stateSchema?: Record<string, { type: string }>;
}

/**
 * A SALES world (rep A, TIMEZONE Europe/Paris) with its own OS State and Runs, and rep B's rival Runs holding a
 * DAILY_GO Run as complete as rep A's. Only the TIMEZONE selection and the exact `CURRENT` selection are answered.
 */
async function healthWorld(spec: HealthSpec = {}) {
  const sw = buildSetupWorld("B5_OUTREACH", 5);
  const runtime = await runtimeOf(sw);
  const map = sw.w.map;
  const root = runtime.root_ref;

  const config = installDailyTable(map, root, "02 — SETUP & BUSINESS CONFIG", "Runtime Configuration", {
    Config: { type: "title" },
    Type: { type: "select" },
    State: { type: "select" },
    Value: { type: "rich_text" },
  });
  const timezoneRow = {
    object: "page", id: synthetic("pt-cp-017-timezone"), parent: { type: "data_source_id", data_source_id: config.ds }, archived: false,
    properties: {
      Config: { type: "title", title: rich("TIMEZONE") },
      Type: { type: "select", select: { name: "LOCAL_CONSTRAINT" } },
      State: { type: "select", select: { name: "CONFIRMED" } },
      Value: { type: "rich_text", rich_text: rich(ZONE) },
    },
  } as unknown as Page;

  const state = installDailyTable(map, root, "03 — CONTROL PLANE", "OS State", spec.stateSchema ?? STATE_SCHEMA);
  const runs = installDailyTable(map, root, "03 — CONTROL PLANE", "Runs", RUNS_SCHEMA);
  const rival = installDailyTable(map, SALES_IDS("rep-b").root, "03 — CONTROL PLANE", "Runs", RUNS_SCHEMA);

  const runId = synthetic("pt-cp-017-run");
  const rivalRunId = synthetic("pt-cp-017-rival-run");
  const created = spec.created ?? "2026-09-29T05:00:00.000Z";
  const runPage = (id: string, ds: string) => ({
    object: "page", id, parent: { type: "data_source_id", data_source_id: ds }, archived: spec.archived ?? false,
    properties: {
      Run: { type: "title", title: rich("DAILY GO") },
      "Run Type": { type: "select", select: { name: spec.runType ?? "DAILY_GO" } },
      Status: { type: "select", select: { name: spec.status ?? "COMPLETED" } },
      Created: spec.createdAsDate ? { type: "date", date: dateCell(created) } : { type: "created_time", created_time: created },
      Finished: { type: "date", date: dateCell(spec.finished === undefined ? "2026-09-29T05:45:00.000Z" : spec.finished) },
    },
  });
  map.set(`page:${runId}`, runPage(runId, runs.ds));
  map.set(`page:${rivalRunId}`, { ...runPage(rivalRunId, rival.ds), archived: false });

  const ref = spec.ref ? spec.ref(runId, rivalRunId) : runId;
  const currentRow = (n: number) => ({
    object: "page", id: synthetic(`pt-cp-017-current-${n}`), parent: { type: "data_source_id", data_source_id: state.ds }, archived: false,
    properties: {
      Name: { type: "title", title: rich("CURRENT") },
      "Production Health": { type: "select", select: spec.health === null ? null : { name: spec.health ?? "ON_TARGET" } },
      "Production Health Run Ref": { type: "rich_text", rich_text: ref === "" ? [] : rich(ref) },
      "Last Daily Run": { type: "date", date: dateCell(spec.last === undefined ? "2026-09-29T05:30:00.000Z" : spec.last) },
    },
  }) as unknown as Page;
  const currentRows = Array.from({ length: spec.currentRows ?? 1 }, (_, n) => currentRow(n));

  const client = new DailyClient(map);
  client.queryHandlers.set(config.ds, (filter) => (isDeepStrictEqual(filter, TIMEZONE_FILTER) && spec.zone !== false ? [timezoneRow] : []));
  client.queryHandlers.set(state.ds, (filter) => (isDeepStrictEqual(filter, CURRENT_FILTER) ? currentRows : []));

  const sources = await readDailySources(client, runtime, "SALES", ["CURRENT_WORK"], { effective_hold: "NONE", next_safe_action: "Continue" }, NOW);
  const source = sources.find((s) => s.source_key === KEY);
  assert.ok(source, `${KEY} is supplied`);
  const stateQueries = client.queries.filter((q) => q.dataSourceId === state.ds);
  const runReads = client.reads.filter((r) => r.operation === "retrievePage" && [runId, rivalRunId].includes(String(r.args[0])));
  return { client, sources, source, state, runs, rival, runId, rivalRunId, stateQueries, runReads };
}

type World = Awaited<ReturnType<typeof healthWorld>>;

/** At most one bounded query of OS State (exact Name=CURRENT, two rows, no cursor, no sort); never a query of any Runs. */
function assertBounded(w: World, stateQueried: boolean): void {
  assert.equal(w.stateQueries.length, stateQueried ? 1 : 0, "OS State is queried at most once");
  for (const q of w.stateQueries) {
    assert.deepEqual(q.filter, CURRENT_FILTER);
    assert.deepEqual(q.options, { sorts: [], page_size: 2 });
    assert.ok(q.cursor === undefined || q.cursor === null, "no continuation query");
  }
  for (const ds of [w.runs.ds, w.rival.ds]) assert.equal(w.client.queries.some((q) => q.dataSourceId === ds), false, "no Runs database is ever queried");
  assert.ok(w.runReads.length <= 1, "at most one direct Run read");
}

function assertAbsent(w: World, label: string): void {
  assert.equal(w.source.status, "ABSENT", label);
  assert.deepEqual(w.source.rows, [], label);
  // ABSENT is never a HOLD: the carried holds are exactly the ones already derived.
  const holds = w.sources.find((s) => s.source_key === DAILY_SOURCE_KEYS.HOLDS);
  assert.deepEqual([holds?.status, holds?.rows], ["PRESENT", []], `${label}: no HOLD added`);
}

async function sectionOf(sources: readonly ContextSource[]) {
  const { pack } = await buildContractPack({
    lane: "SALES", topic_hint: "CURRENT_WORK", runtime_generation: "g1",
    versions: { governing_spec: "S", governing_schema: "H", governing_control: "C", candidate_versions: [] },
    safety: {}, open_backend_plan: "NONE", context_sources: sources,
  } as never);
  const daily = pack.selected_context.contexts.find((c) => c.context === "DAILY");
  assert.ok(daily, "DAILY is served");
  assert.equal(daily.sections.at(-1)?.source_key, KEY, "production health is the last DAILY section");
  const section = daily.sections.find((s) => s.source_key === KEY);
  assert.ok(section, `${KEY} section is served`);
  return { pack, section };
}

test("PT-CP-017/a: the catalogue declares DAILY_PRODUCTION_HEALTH last, after the thirteen W2.3 sources, with exactly three keys", () => {
  const daily = CONTEXT_SECTIONS.DAILY;
  assert.equal(daily.length, 14);
  assert.deepEqual(daily.at(-1), { section_key: KEY, source_key: KEY, projected_keys: ["production_health", "daily_run_ref", "evaluated_at"] });
  assert.equal(Object.values(DAILY_SOURCE_KEYS).at(-1), KEY);
});

test("PT-CP-017/b valid: each declared value is transported verbatim with its DAILY_GO Run and evaluation instant", async () => {
  for (const health of ["ON_TARGET", "AT_RISK", "PRODUCTION_BREACH"]) {
    const w = await healthWorld({ health });
    assert.equal(w.source.status, "PRESENT", health);
    assert.deepEqual(w.source.rows, [{ production_health: health, daily_run_ref: w.runId, evaluated_at: "2026-09-29T05:30:00.000Z" }], health);
    assertBounded(w, true);
    assert.deepEqual(w.runReads.map((r) => String(r.args[0])), [w.runId], "one direct read of the named Run");

    const { section } = await sectionOf(w.sources);
    assert.equal(section.source_status, "PRESENT");
    assert.deepEqual(section.items, [{ production_health: health, daily_run_ref: w.runId, evaluated_at: "2026-09-29T05:30:00.000Z" }]);
    assert.deepEqual([section.served, section.available, section.omitted, section.truncated_by], [1, 1, 0, "NONE"]);
  }
  // A dashed physical UUID names the same page; the served ref is its normalized id.
  const d = await healthWorld({ ref: (own) => dashed(own) });
  assert.equal(d.source.status, "PRESENT");
  assert.equal((d.source.rows[0] as Record<string, unknown>)["daily_run_ref"], d.runId);
  // The civil day is the instance's: 22:30Z on the 28th is already 00:30 on the 29th in Paris.
  const m = await healthWorld({ created: "2026-09-28T22:00:00.000Z", last: "2026-09-28T22:30:00.000Z", finished: "2026-09-28T22:45:00.000Z" });
  assert.equal(m.source.status, "PRESENT", "same civil day in Europe/Paris, not in UTC");
  // A Created date column holding a full date-time is admitted like a creation time.
  assert.equal((await healthWorld({ createdAsDate: true })).source.status, "PRESENT");
});

test("PT-CP-017/c missing: no zone, no column, no CURRENT row, no value, no ref or no evaluation instant is ABSENT", async () => {
  const noZone = await healthWorld({ zone: false });
  assertAbsent(noZone, "no TIMEZONE");
  assertBounded(noZone, false);
  assert.equal(noZone.runReads.length, 0);

  const { "Production Health": _drop, ...withoutHealth } = STATE_SCHEMA;
  const noColumn = await healthWorld({ stateSchema: withoutHealth });
  assertAbsent(noColumn, "no Production Health column");
  assertBounded(noColumn, false);

  const noRow = await healthWorld({ currentRows: 0 });
  assertAbsent(noRow, "no CURRENT row");
  assertBounded(noRow, true);
  assert.equal(noRow.runReads.length, 0);

  for (const [label, spec] of [
    ["empty Production Health", { health: null }],
    ["empty Run Ref", { ref: () => "" }],
    ["empty Last Daily Run", { last: null }],
  ] as const) {
    const w = await healthWorld(spec as HealthSpec);
    assertAbsent(w, label);
    assertBounded(w, true);
  }
});

test("PT-CP-017/d wrong enum: only ON_TARGET, AT_RISK and PRODUCTION_BREACH, exactly as written, are transported", async () => {
  for (const health of ["HEALTHY", "on_target", " ON_TARGET", "AT_RISK ", "BREACH", "UNKNOWN"]) {
    const w = await healthWorld({ health });
    assertAbsent(w, health);
    assertBounded(w, true);
    assert.equal(w.runReads.length, 0, `${health}: no Run is read for an ungoverned value`);
  }
});

test("PT-CP-017/e stale or future: an evaluation of another civil day, or after evaluation_now, is ABSENT", async () => {
  const cases: ReadonlyArray<readonly [string, HealthSpec]> = [
    // 19:30Z on the 28th is 21:30 on the 28th in Paris: yesterday there.
    ["yesterday in the instance zone", { created: "2026-09-28T19:00:00.000Z", last: "2026-09-28T19:30:00.000Z", finished: "2026-09-28T19:45:00.000Z" }],
    ["a week old", { created: "2026-09-22T05:00:00.000Z", last: "2026-09-22T05:30:00.000Z", finished: "2026-09-22T05:45:00.000Z" }],
    ["later today than evaluation_now", { created: "2026-09-29T10:10:00.000Z", last: "2026-09-29T10:30:00.000Z", finished: "2026-09-29T11:00:00.000Z" }],
  ];
  for (const [label, spec] of cases) {
    const w = await healthWorld(spec);
    assertAbsent(w, label);
    assertBounded(w, true);
  }
});

test("PT-CP-017/f date-only: a bare day, a range or a named-zone value is never a served evaluation instant", async () => {
  const cases: ReadonlyArray<readonly [string, HealthSpec]> = [
    ["Last Daily Run is a bare day", { last: "2026-09-29" }],
    ["Last Daily Run is a range", { last: { start: "2026-09-29T05:30:00.000Z", end: "2026-09-29T05:40:00.000Z", time_zone: null } }],
    ["Last Daily Run carries a named zone", { last: { start: "2026-09-29T07:30:00.000+02:00", end: null, time_zone: ZONE } }],
    ["Last Daily Run has no offset", { last: "2026-09-29T05:30:00" }],
    ["Finished is a bare day", { finished: "2026-09-29" }],
    ["Finished is empty", { finished: null }],
    ["Created is a bare day", { createdAsDate: true, created: "2026-09-29" }],
  ];
  for (const [label, spec] of cases) {
    const w = await healthWorld(spec);
    assertAbsent(w, label);
    assertBounded(w, true);
  }
});

test("PT-CP-017/g wrong or foreign Run: only a live COMPLETED DAILY_GO Run of the bound Runs database, around the evaluation, proves it", async () => {
  const cases: ReadonlyArray<readonly [string, HealthSpec, number]> = [
    ["Run Type is not DAILY_GO", { runType: "SETUP" }, 1],
    ["Run is still RUNNING", { status: "RUNNING" }, 1],
    ["Run ended in HOLD", { status: "HOLD" }, 1],
    ["evaluation before the Run was created", { created: "2026-09-29T05:40:00.000Z" }, 1],
    ["evaluation after the Run finished", { finished: "2026-09-29T05:20:00.000Z" }, 1],
    ["archived Run", { archived: true }, 1],
    ["Run of the rival runtime", { ref: (_own, rival) => rival }, 1],
    ["unknown page", { ref: () => synthetic("pt-cp-017-no-such-run") }, 0],
    // Never followed: a URL, a logical ID or a padded value is not the physical UUID the contract names.
    ["a Notion URL", { ref: (own) => `https://www.notion.so/Run-${own}` }, 0],
    ["a logical Run ID", { ref: () => "SRUN-12" }, 0],
    ["a padded UUID", { ref: (own) => ` ${own}` }, 0],
  ];
  for (const [label, spec, reads] of cases) {
    const w = await healthWorld(spec);
    assertAbsent(w, label);
    assertBounded(w, true);
    assert.equal(w.runReads.length, reads, `${label}: ${reads} direct Run read(s)`);
  }
  // The rival Run is at most read to be refused: nothing of it reaches a source.
  const foreign = await healthWorld({ ref: (_own, rival) => rival });
  assert.equal(JSON.stringify(foreign.sources).includes(foreign.rivalRunId), false);
});

test("PT-CP-017/h bounded read: two CURRENT rows prove it is not single; the source is ABSENT after one two-row request", async () => {
  for (const n of [2, 12]) {
    const w = await healthWorld({ currentRows: n });
    assertAbsent(w, `${n} CURRENT rows`);
    assertBounded(w, true);
    assert.equal(w.runReads.length, 0, "no Run is read for an ambiguous cursor");
  }
});

test("PT-CP-017/i META: fourteen DAILY sources, all ABSENT, the production health included, with zero reads", async () => {
  const accessed: PropertyKey[] = [];
  const poison = new Proxy({}, { get(_t, p) { accessed.push(p); throw new Error("unexpected read"); } });
  const sources = await readDailySources(poison as never, {} as never, "META", ["CURRENT_WORK"], {} as never, NOW);
  assert.deepEqual(sources.map((s) => [s.source_key, s.status]), Object.values(DAILY_SOURCE_KEYS).map((k) => [k, "ABSENT"]));
  assert.equal(sources.length, 14);
  assert.deepEqual(sources.at(-1), { source_key: KEY, status: "ABSENT", rows: [] });
  assert.equal(accessed.length, 0);
});

test("PT-CP-017/j ABSENT through the pack: an explicit ABSENT section, no HOLD, no health claim", async () => {
  const w = await healthWorld({ health: "HEALTHY" });
  const { pack, section } = await sectionOf(w.sources);
  assert.deepEqual([section.source_status, section.items, section.served, section.available, section.omitted], ["ABSENT", [], 0, 0, 0]);
  const holds = pack.selected_context.contexts.flatMap((c) => c.sections).find((s) => s.source_key === DAILY_SOURCE_KEYS.HOLDS);
  assert.deepEqual([holds?.source_status, holds?.items], ["PRESENT", []], "no HOLD for a missing production health");
  const served = JSON.stringify(pack.selected_context);
  for (const claim of ["ON_TARGET", "AT_RISK", "PRODUCTION_BREACH", "HEALTHY"]) assert.equal(served.includes(claim), false, claim);
});
