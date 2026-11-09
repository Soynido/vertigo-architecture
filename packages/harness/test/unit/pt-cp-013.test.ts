import { test } from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

import { dailySelected, readDailySources } from "../../src/contractPack/dailySources.ts";
import { DAILY_SOURCE_KEYS } from "../../src/contractPack/catalog.ts";
import { buildContractPack, type ContextSource, type ContractPack } from "../../src/contractPack/pack.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import {
  answerRow, BC, bindSales, buildSetupWorld, CONFIG, itemOf, proveRows, resume, runtimeOf, stepOf, STEPS,
} from "./pt-cp-012.fixtures.ts";
import { DailyClient, installDailyTable, type QueryHandler, type RecordedQuery } from "./pt-cp-013.fixtures.ts";
import { synthetic } from "./meta-fixtures.ts";
import type { Page } from "../../src/notion/shapes.ts";

test("PT-CP-013: dailySelected is true when CURRENT_WORK is selected", () => {
  assert.equal(dailySelected(["CURRENT_WORK"]), true);
});

test("PT-CP-013: readDailySources on META returns 14 ABSENT sources with zero reads", async () => {
  const accessed: PropertyKey[] = [];
  const poisonReader = new Proxy(
    {},
    {
      get(_target, prop) {
        accessed.push(prop);
        throw Error("unexpected read");
      },
    },
  );

  const sources = await readDailySources(
    poisonReader as never,
    {} as never,
    "META",
    ["CURRENT_WORK"],
    {} as never,
    new Date("2026-09-28T12:00:00Z"),
  );

  assert.equal(sources.length, 14);
  assert.deepEqual(
    sources.map((s) => s.source_key),
    Object.values(DAILY_SOURCE_KEYS),
  );
  for (const source of sources) {
    assert.equal(source.status, "ABSENT");
  }
  assert.equal(accessed.length, 0);
});

test("PT-CP-013/d: SALES names the native sources, carries holds, and is ABSENT where a table is missing", async () => {
  const sw = buildSetupWorld("B5_OUTREACH", 5);
  const runtime = await runtimeOf(sw);

  const sources = await readDailySources(
    sw.client,
    runtime,
    "SALES",
    ["CURRENT_WORK"],
    { effective_hold: "NONE", next_safe_action: "Continue" },
    new Date("2026-09-28T12:00:00Z"),
  );

  assert.deepEqual(
    sources.map((s) => s.source_key),
    Object.values(DAILY_SOURCE_KEYS),
  );

  const native = sources.find((s) => s.source_key === "DAILY_NATIVE_REALITY");
  assert.ok(native, "DAILY_NATIVE_REALITY is supplied");
  assert.equal(native.status, "PRESENT");
  assert.deepEqual(native.rows, [
    { source: "GMAIL", authority: "GMAIL", read_first: true },
    { source: "HUMAN_ACTIONS", authority: "HUMAN_ACTIONS", read_first: true },
  ]);

  const holds = sources.find((s) => s.source_key === "DAILY_HOLDS");
  assert.ok(holds, "DAILY_HOLDS is supplied");
  assert.equal(holds.status, "PRESENT");
  assert.deepEqual(holds.rows, []);

  // Native sources are named, never copied: no content, email or auto-reply field anywhere.
  const forbidden = /content|e[-_]?mail|auto[-_]?reply|subject|body|snippet|message/i;
  const keysOf = (v: unknown): string[] =>
    v !== null && typeof v === "object"
      ? Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => [k, ...keysOf(x)])
      : [];
  for (const source of sources) {
    for (const key of keysOf(source.rows)) {
      assert.doesNotMatch(key, forbidden, `${source.source_key} carries field ${key}`);
    }
  }

  // Every other source's table is missing from this runtime: each is ABSENT on its own.
  for (const source of sources) {
    if (source.source_key === "DAILY_NATIVE_REALITY" || source.source_key === "DAILY_HOLDS") continue;
    assert.equal(source.status, "ABSENT", source.source_key);
    assert.deepEqual(source.rows, [], source.source_key);
  }
});

test("PT-CP-013/b: DAILY_P0_RULES reads the active P0 decision rules via a server-side filter", async () => {
  const sw = buildSetupWorld("B5_OUTREACH", 5);
  const runtime = await runtimeOf(sw);
  const { ds } = installDailyTable(
    sw.w.map,
    runtime.root_ref,
    "03 — CONTROL PLANE",
    "Decision Rules",
    {
      Active: { type: "checkbox" },
      Priority: { type: "select" },
      "Rule ID": { type: "unique_id" },
      Rule: { type: "title" },
    },
  );

  const p0Rule = {
    object: "page",
    id: synthetic("daily-p0-rule"),
    parent: { type: "data_source_id", data_source_id: ds },
    archived: false,
    properties: {
      Active: { type: "checkbox", checkbox: true },
      Priority: { type: "select", select: { name: "P0" } },
      "Rule ID": { type: "unique_id", unique_id: { prefix: null, number: 1 } },
      Rule: {
        type: "title",
        title: [{ type: "text", plain_text: "Pause outreach" }],
      },
    },
  } as unknown as Page;

  const client = new DailyClient(sw.w.map);
  // Models server-side filtering: the row only comes back for a filter naming P0.
  client.queryHandlers.set(ds, (filter) =>
    JSON.stringify(filter).includes("P0") ? [p0Rule] : [],
  );

  const sources = await readDailySources(
    client,
    runtime,
    "SALES",
    ["CURRENT_WORK"],
    { effective_hold: "NONE", next_safe_action: "Continue" },
    new Date("2026-09-28T12:00:00Z"),
  );

  const p0 = sources.find((s) => s.source_key === "DAILY_P0_RULES");
  assert.ok(p0, "DAILY_P0_RULES is supplied");
  assert.equal(p0.status, "PRESENT");
  assert.equal(p0.rows.length, 1);
  const [row] = p0.rows as Array<Record<string, unknown>>;
  assert.ok(row);
  assert.equal(row.rule_id, "1");
  assert.equal(row.rule, "Pause outreach");

  const active = sources.find((s) => s.source_key === "DAILY_ACTIVE_RULES");
  assert.ok(active, "DAILY_ACTIVE_RULES is supplied");
  assert.equal(active.status, "PRESENT");
  assert.deepEqual(active.rows, []);

  const dsQueries = client.queries.filter((q) => q.dataSourceId === ds);
  assert.ok(dsQueries.length > 0, "the Decision Rules data source is queried");
  for (const q of dsQueries) {
    const options = q.options as
      | { page_size?: number; sorts?: Array<{ property?: string; direction?: string }> }
      | undefined;
    assert.ok(options, "query carries options");
    assert.equal(typeof options.page_size, "number");
    assert.ok((options.page_size as number) <= 11, `page_size ${options.page_size} <= 11`);
    assert.ok(Array.isArray(options.sorts) && options.sorts.length > 0, "query carries sorts");
    assert.deepEqual(options.sorts[options.sorts.length - 1], {
      property: "Rule ID",
      direction: "ascending",
    });
  }
});

test("PT-CP-013/a: DAILY_P0_RULES reads 11 of 12 P0 rows and serves 10 with explicit S6 truncation", async () => {
  const sw = buildSetupWorld("B5_OUTREACH", 5);
  const runtime = await runtimeOf(sw);
  const { ds } = installDailyTable(
    sw.w.map,
    runtime.root_ref,
    "03 — CONTROL PLANE",
    "Decision Rules",
    {
      Active: { type: "checkbox" },
      Priority: { type: "select" },
      "Rule ID": { type: "unique_id" },
      Rule: { type: "title" },
    },
  );

  const p0Rules = Array.from({ length: 12 }, (_, i) => {
    const n = i + 1;
    return {
      object: "page",
      id: synthetic(`daily-p0-rule-${n}`),
      parent: { type: "data_source_id", data_source_id: ds },
      archived: false,
      properties: {
        Active: { type: "checkbox", checkbox: true },
        Priority: { type: "select", select: { name: "P0" } },
        "Rule ID": { type: "unique_id", unique_id: { prefix: null, number: n } },
        Rule: {
          type: "title",
          title: [{ type: "text", plain_text: `P0 rule ${n}` }],
        },
      },
    } as unknown as Page;
  });

  const isP0Filter = (filter: unknown): boolean =>
    JSON.stringify(filter).includes('"equals":"P0"');

  const client = new DailyClient(sw.w.map);
  // Models server-side filtering: the rows only come back for the P0 equals filter; P1-P5 get [].
  client.queryHandlers.set(ds, (filter) => (isP0Filter(filter) ? p0Rules : []));

  const sources = await readDailySources(
    client,
    runtime,
    "SALES",
    ["CURRENT_WORK"],
    { effective_hold: "NONE", next_safe_action: "Continue" },
    new Date("2026-09-28T12:00:00Z"),
  );

  const p0 = sources.find((s) => s.source_key === "DAILY_P0_RULES");
  assert.ok(p0, "DAILY_P0_RULES is supplied");
  assert.equal(p0.status, "PRESENT");
  assert.equal(p0.rows.length, 11);

  const p0Queries = client.queries.filter((q) => q.dataSourceId === ds && isP0Filter(q.filter));
  assert.equal(p0Queries.length, 1, "P0 is queried exactly once, never continued");
  const [p0Query] = p0Queries;
  assert.ok(p0Query);
  assert.ok(p0Query.cursor === undefined || p0Query.cursor === null, "P0 query carries no cursor");
  assert.equal((p0Query.options as { page_size?: number } | undefined)?.page_size, 11);

  const { pack } = await buildContractPack({
    lane: "SALES",
    topic_hint: "CURRENT_WORK",
    runtime_generation: "g1",
    versions: {
      governing_spec: "S",
      governing_schema: "H",
      governing_control: "C",
      candidate_versions: [],
    },
    safety: {},
    open_backend_plan: "NONE",
    context_sources: sources,
  } as never);

  const selected = pack.selected_context;
  const section = selected.contexts
    .flatMap((c) => c.sections)
    .find((s) => s.source_key === "DAILY_P0_RULES");
  assert.ok(section, "DAILY_P0_RULES section is served");
  assert.equal(section.source_status, "PRESENT");
  assert.equal(section.available, 11);
  assert.equal(section.served, 10);
  assert.equal(section.items.length, 10);
  assert.equal(section.omitted, 1);
  assert.equal(section.truncated_by, "ROWS_PER_SECTION");

  for (const key of ["cursor", "has_more", "total"]) {
    assert.equal(Object.hasOwn(selected, key), false, `selected_context has no ${key}`);
    assert.equal(Object.hasOwn(section, key), false, `section has no ${key}`);
  }
});

// ─────────────────────────────── W2.3Q: DAILY_ACTIVE_POLICIES whole selection ───────────────────────────────

/** 12:00Z is 14:00 in Europe/Paris: the civil day is 2026-09-28, so 2026-09-29 is still in the future there. */
const POLICY_NOW = new Date("2026-09-28T12:00:00Z");
const EFFECTIVE_DAY = "2026-09-01";
const TOMORROW_DAY = "2026-09-29";
const FUTURE_DAY = "2026-10-15";

const ACTIVE_FILTER = { property: "State", select: { equals: "ACTIVE" } };
const POLICY_SORTS = [{ property: "Policy Key", direction: "ascending" }];
const TIMEZONE_FILTER = { property: "Config", title: { equals: "TIMEZONE" } };

interface PolicySpec {
  readonly key: string;
  readonly effective: string;
  readonly change?: { readonly status?: string; readonly approved?: boolean };
}

const rich = (s: string) => [{ type: "text", plain_text: s }];

/**
 * A SALES setup world with a valid TIMEZONE (Europe/Paris), an Active Policies index and its Policy Changes. `specs`
 * are the State=ACTIVE rows the server returns, already in Policy Key order; each names its own Approved Change page.
 */
async function policyWorld(specs: readonly PolicySpec[]) {
  const sw = buildSetupWorld("B5_OUTREACH", 5);
  const runtime = await runtimeOf(sw);
  const map = sw.w.map;

  const config = installDailyTable(map, runtime.root_ref, "02 — SETUP & BUSINESS CONFIG", "Runtime Configuration", {
    Config: { type: "title" },
    Type: { type: "select" },
    State: { type: "select" },
    Value: { type: "rich_text" },
  });
  const policies = installDailyTable(map, runtime.root_ref, "01 — CONSTITUTION & POLICIES", "Active Policies", {
    "Policy Key": { type: "rich_text" },
    State: { type: "select" },
    "Effective At": { type: "date" },
    "Approved Change": { type: "url" },
    "Policy Text": { type: "rich_text" },
  });
  const changes = installDailyTable(map, runtime.root_ref, "01 — CONSTITUTION & POLICIES", "Policy Changes", {
    Change: { type: "title" },
    Status: { type: "select" },
    "Human Approved": { type: "checkbox" },
  });

  const timezoneRow = {
    object: "page",
    id: synthetic("w23q-timezone"),
    parent: { type: "data_source_id", data_source_id: config.ds },
    archived: false,
    properties: {
      Config: { type: "title", title: rich("TIMEZONE") },
      Type: { type: "select", select: { name: "LOCAL_CONSTRAINT" } },
      State: { type: "select", select: { name: "CONFIRMED" } },
      Value: { type: "rich_text", rich_text: rich("Europe/Paris") },
    },
  } as unknown as Page;

  const changeIds = specs.map((_, i) => synthetic(`w23q-policy-change-${i}`));
  const rows = specs.map((spec, i) => {
    const changeId = changeIds[i]!;
    map.set(`page:${changeId}`, {
      object: "page",
      id: changeId,
      parent: { type: "data_source_id", data_source_id: changes.ds },
      archived: false,
      properties: {
        Change: { type: "title", title: rich(`Change ${i}`) },
        Status: { type: "select", select: { name: spec.change?.status ?? "APPLIED" } },
        "Human Approved": { type: "checkbox", checkbox: spec.change?.approved ?? true },
      },
    });
    return {
      object: "page",
      id: synthetic(`w23q-policy-row-${i}`),
      parent: { type: "data_source_id", data_source_id: policies.ds },
      archived: false,
      properties: {
        "Policy Key": { type: "rich_text", rich_text: rich(spec.key) },
        State: { type: "select", select: { name: "ACTIVE" } },
        "Effective At": { type: "date", date: { start: spec.effective } },
        "Approved Change": { type: "url", url: `https://www.notion.so/Policy-change-${changeId}` },
        "Policy Text": { type: "rich_text", rich_text: rich(`Policy text ${i}`) },
      },
    } as unknown as Page;
  });

  const client = new DailyClient(map);
  // Models server-side selection: TIMEZONE only for its Config filter; policies only for exactly State=ACTIVE.
  client.queryHandlers.set(config.ds, (filter) => (isDeepStrictEqual(filter, TIMEZONE_FILTER) ? [timezoneRow] : []));
  client.queryHandlers.set(policies.ds, (filter) => (isDeepStrictEqual(filter, ACTIVE_FILTER) ? rows : []));

  const sources = await readDailySources(
    client,
    runtime,
    "SALES",
    ["CURRENT_WORK"],
    { effective_hold: "NONE", next_safe_action: "Continue" },
    POLICY_NOW,
  );
  const source = sources.find((s) => s.source_key === DAILY_SOURCE_KEYS.ACTIVE_POLICIES);
  assert.ok(source, "DAILY_ACTIVE_POLICIES is supplied");

  const changeReads = client.reads
    .filter((r) => r.operation === "retrievePage")
    .map((r) => String(r.args[0]))
    .filter((id) => changeIds.includes(id));

  return { client, policies, sources, source, changeIds, changeReads };
}

/**
 * The index was actually queried (so TIMEZONE and Policy Changes resolved), exactly once, from the start, asking for
 * the whole State=ACTIVE selection by Policy Key with an 11-row page — no date condition on the server.
 */
function assertActiveSelection(client: DailyClient, ds: string): RecordedQuery {
  const queries = client.queries.filter((q) => q.dataSourceId === ds);
  assert.equal(queries.length, 1, "Active Policies is queried exactly once, never continued");
  const [q] = queries;
  assert.ok(q);
  assert.deepEqual(q.filter, ACTIVE_FILTER, "server filter is State=ACTIVE only");
  assert.doesNotMatch(JSON.stringify(q.filter), /Effective At|"date"|on_or_before|on_or_after|before|after/);
  const options = q.options as { page_size?: number; sorts?: unknown } | undefined;
  assert.ok(options, "query carries options");
  assert.deepEqual(options.sorts, POLICY_SORTS, "server sort is Policy Key ascending");
  assert.equal(options.page_size, 11);
  assert.ok(q.cursor === undefined || q.cursor === null, "first query carries no cursor");
  return q;
}

async function policySection(sources: readonly ContextSource[]) {
  const { pack } = await buildContractPack({
    lane: "SALES",
    topic_hint: "CURRENT_WORK",
    runtime_generation: "g1",
    versions: {
      governing_spec: "S",
      governing_schema: "H",
      governing_control: "C",
      candidate_versions: [],
    },
    safety: {},
    open_backend_plan: "NONE",
    context_sources: sources,
  } as never);
  const selected = pack.selected_context;
  const section = selected.contexts
    .flatMap((c) => c.sections)
    .find((s) => s.source_key === DAILY_SOURCE_KEYS.ACTIVE_POLICIES);
  assert.ok(section, "DAILY_ACTIVE_POLICIES section is served");
  for (const key of ["cursor", "has_more", "total"]) {
    assert.equal(Object.hasOwn(selected, key), false, `selected_context has no ${key}`);
    assert.equal(Object.hasOwn(section, key), false, `section has no ${key}`);
  }
  return section;
}

const policyKey = (n: number) => `POL-${String(n).padStart(2, "0")}`;

test("PT-CP-013/W2.3Q-1: 12 ACTIVE policies overflow the 11-row whole selection: ABSENT, no 12th read", async () => {
  const specs = Array.from({ length: 12 }, (_, i) => ({ key: policyKey(i + 1), effective: EFFECTIVE_DAY }));
  const { client, policies, source, changeReads } = await policyWorld(specs);

  assert.equal(source.status, "ABSENT");
  assert.deepEqual(source.rows, []);
  assertActiveSelection(client, policies.ds);
  // The fake returned 11 rows with has_more: the reader must stop there, never continuing to a 12th row.
  assert.equal(
    client.queries.some((q) => q.dataSourceId === policies.ds && q.cursor !== undefined && q.cursor !== null),
    false,
    "no continuation query",
  );
  assert.deepEqual(changeReads, [], "no Approved Change page is read for an unproven selection");
});

test("PT-CP-013/W2.3Q-2: exactly 11 effective ACTIVE policies: PRESENT 11 raw, pack serves 10 with S6", async () => {
  const specs = Array.from({ length: 11 }, (_, i) => ({ key: policyKey(i + 1), effective: EFFECTIVE_DAY }));
  const { client, policies, sources, source, changeIds, changeReads } = await policyWorld(specs);

  assert.equal(source.status, "PRESENT");
  assert.equal(source.rows.length, 11);
  assertActiveSelection(client, policies.ds);
  assert.deepEqual([...changeReads].sort(), [...changeIds].sort(), "each Approved Change is read once");

  const section = await policySection(sources);
  assert.equal(section.source_status, "PRESENT");
  assert.equal(section.available, 11);
  assert.equal(section.served, 10);
  assert.equal(section.items.length, 10);
  assert.equal(section.omitted, 1);
  assert.equal(section.truncated_by, "ROWS_PER_SECTION");
});

test("PT-CP-013/W2.3Q-3: exactly 11 ACTIVE policies with one not yet effective: PRESENT 10, no S6", async () => {
  // POL-06 takes effect tomorrow in the instance zone; it sits mid-order so a first-ten cut would not hide it.
  const specs = Array.from({ length: 11 }, (_, i) => ({
    key: policyKey(i + 1),
    effective: i === 5 ? TOMORROW_DAY : EFFECTIVE_DAY,
  }));
  const { client, policies, sources, source, changeIds, changeReads } = await policyWorld(specs);

  assert.equal(source.status, "PRESENT");
  assert.equal(source.rows.length, 10);
  assertActiveSelection(client, policies.ds);
  // The future row is still fully validated, its Approved Change included.
  assert.deepEqual([...changeReads].sort(), [...changeIds].sort(), "every ACTIVE row's change is read, future included");

  const section = await policySection(sources);
  assert.equal(section.source_status, "PRESENT");
  assert.equal(section.available, 10);
  assert.equal(section.served, 10);
  assert.equal(section.items.length, 10);
  assert.equal(section.omitted, 0);
  assert.notEqual(section.truncated_by, "ROWS_PER_SECTION");
});

test("PT-CP-013/W2.3Q-4: a duplicate Policy Key among complete ACTIVE rows makes the source ABSENT", async () => {
  // Both POL-02 rows are complete and approved; one is in force, the other future. Uniqueness binds both.
  const { client, policies, source } = await policyWorld([
    { key: policyKey(1), effective: EFFECTIVE_DAY },
    { key: policyKey(2), effective: EFFECTIVE_DAY },
    { key: policyKey(2), effective: FUTURE_DAY },
    { key: policyKey(3), effective: EFFECTIVE_DAY },
  ]);

  assert.equal(source.status, "ABSENT");
  assert.deepEqual(source.rows, []);
  assertActiveSelection(client, policies.ds);
});

test("PT-CP-013/W2.3Q-5: a future ACTIVE policy whose Approved Change is not human-approved makes the source ABSENT", async () => {
  const { client, policies, source, changeIds, changeReads } = await policyWorld([
    { key: policyKey(1), effective: EFFECTIVE_DAY },
    { key: policyKey(2), effective: FUTURE_DAY, change: { status: "APPLIED", approved: false } },
    { key: policyKey(3), effective: EFFECTIVE_DAY },
  ]);

  assert.equal(source.status, "ABSENT");
  assert.deepEqual(source.rows, []);
  assertActiveSelection(client, policies.ds);
  assert.ok(changeReads.includes(changeIds[1]!), "the future row's Approved Change page is read and rejected");
});

test("PT-CP-013/W2.3Q-6: server-sorted keys where JS collation disagrees stay PRESENT in returned order", async () => {
  // SEND_LIMIT precedes SENDER_DOMAIN in server order, while a JS localeCompare can reverse them: no false ABSENT.
  const { client, policies, sources, source } = await policyWorld([
    { key: "SEND_LIMIT", effective: EFFECTIVE_DAY },
    { key: "SENDER_DOMAIN", effective: EFFECTIVE_DAY },
  ]);

  assert.equal(source.status, "PRESENT");
  assertActiveSelection(client, policies.ds);

  const section = await policySection(sources);
  assert.deepEqual(
    section.items.map((item) => item.policy_key),
    ["SEND_LIMIT", "SENDER_DOMAIN"],
  );
});

// ─────────────────────────────── W2.3R: reached dates (DUE_TASKS, RUNTIME_CONSTRAINTS) ───────────────────────────────

/** 03:00Z on the 29th is 20:00 on the 28th in Los Angeles (PDT, -07:00): civil today there is a day behind UTC. */
const DATE_NOW = new Date("2026-09-29T03:00:00Z");
const DATE_ZONE = "America/Los_Angeles";
const CIVIL_TODAY = "2026-09-28";
const NOW_ISO = "2026-09-29T03:00:00.000Z";
/** Written on the 28th at -07:00, it is 02:30Z on the 29th: already past, yet on the UTC day after civil today. */
const PAST_OFFSET_INSTANT = "2026-09-28T19:30:00-07:00";
/** Already today in UTC, still tomorrow in the instance zone. */
const ZONE_TOMORROW = "2026-09-29";

const reachedConditions = (column: string) => [
  { property: column, date: { on_or_before: CIVIL_TODAY } },
  { property: column, date: { on_or_before: NOW_ISO } },
];
const DUE_FILTER = {
  and: [
    { or: [{ property: "Status", select: { equals: "READY" } }, { property: "Status", select: { equals: "IN_PROGRESS" } }] },
    { or: reachedConditions("Due Date") },
  ],
};
const DUE_SORTS = [
  { property: "Due Date", direction: "ascending" },
  { property: "Task ID", direction: "ascending" },
];
const CONSTRAINTS_FILTER = {
  and: [
    { property: "State", select: { equals: "CONFIRMED" } },
    {
      or: [
        { property: "Type", select: { equals: "LOCAL_CONSTRAINT" } },
        { property: "Type", select: { equals: "PRODUCTION_CONTRACT_POINTER" } },
      ],
    },
    { or: [{ property: "Effective At", date: { is_empty: true } }, ...reachedConditions("Effective At")] },
  ],
};
const CONSTRAINTS_SORTS = [{ property: "Config ID", direction: "ascending" }];

type DateCell = { readonly start: string; readonly end: string | null; readonly time_zone: string | null } | null;
const dateCell = (d: string | DateCell): DateCell => (typeof d === "string" ? { start: d, end: null, time_zone: null } : d);
/** A range whose start and end are both already reached, and an offset instant (reached) tagged with a named zone. */
const RANGE_DATE: DateCell = { start: "2026-09-27", end: CIVIL_TODAY, time_zone: null };
const NAMED_ZONE_DATE: DateCell = { start: PAST_OFFSET_INSTANT, end: null, time_zone: DATE_ZONE };

interface TaskSpec {
  readonly due: string | DateCell;
  readonly status?: string;
  readonly account?: boolean;
  readonly contact?: boolean;
}

/**
 * A SALES world whose TIMEZONE is America/Los_Angeles, with Tasks related to Accounts, Contacts and Sequences (each
 * relation declared toward the bound runtime's own table) and a Runtime Configuration carrying Config ID and Effective
 * At. `tasks` are what the server returns, in order, for exactly DUE_FILTER; `constraints` are the Effective At of the
 * rows it returns, after the TIMEZONE row (Config ID 1, no Effective At), for exactly CONSTRAINTS_FILTER.
 */
async function dateWorld(tasks: readonly TaskSpec[], constraints: ReadonlyArray<string | DateCell> = []) {
  const sw = buildSetupWorld("B5_OUTREACH", 5);
  const runtime = await runtimeOf(sw);
  const map = sw.w.map;
  const root = runtime.root_ref;

  const config = installDailyTable(map, root, "02 — SETUP & BUSINESS CONFIG", "Runtime Configuration", {
    Config: { type: "title" },
    Type: { type: "select" },
    State: { type: "select" },
    Value: { type: "rich_text" },
    "Config ID": { type: "unique_id" },
    "Effective At": { type: "date" },
  });
  const accounts = installDailyTable(map, root, "04 — DATA & EVIDENCE", "Accounts", { "Account ID": { type: "unique_id" } });
  const contacts = installDailyTable(map, root, "04 — DATA & EVIDENCE", "Contacts", { "Contact ID": { type: "unique_id" } });
  const sequences = installDailyTable(map, root, "05 — OPERATIONS & PLAYBOOKS", "Sequences", { "Sequence ID": { type: "unique_id" } });
  const taskTable = installDailyTable(map, root, "03 — CONTROL PLANE", "Tasks", {
    Status: { type: "select" },
    "Due Date": { type: "date" },
    "Task ID": { type: "unique_id" },
    Account: { type: "relation", relation: { data_source_id: accounts.ds } },
    Contact: { type: "relation", relation: { data_source_id: contacts.ds } },
    Sequence: { type: "relation", relation: { data_source_id: sequences.ds } },
  });

  const uid = (number: number) => ({ type: "unique_id", unique_id: { prefix: null, number } });
  const accountId = synthetic("w23r-account");
  const contactId = synthetic("w23r-contact");
  map.set(`page:${accountId}`, {
    object: "page", id: accountId, parent: { type: "data_source_id", data_source_id: accounts.ds }, archived: false,
    properties: { "Account ID": uid(7) },
  });
  map.set(`page:${contactId}`, {
    object: "page", id: contactId, parent: { type: "data_source_id", data_source_id: contacts.ds }, archived: false,
    properties: { "Contact ID": uid(9) },
  });

  const relation = (id?: string) => ({ type: "relation", relation: id ? [{ id }] : [], has_more: false });
  const taskRows = tasks.map((spec, i) => ({
    object: "page", id: synthetic(`w23r-task-${i}`), parent: { type: "data_source_id", data_source_id: taskTable.ds }, archived: false,
    properties: {
      Status: { type: "select", select: { name: spec.status ?? "READY" } },
      "Due Date": { type: "date", date: dateCell(spec.due) },
      "Task ID": uid(i + 1),
      Account: relation(spec.account ? accountId : undefined),
      Contact: relation(spec.contact ? contactId : undefined),
      Sequence: relation(),
    },
  }) as unknown as Page);

  const configRow = (n: number, name: string, value: string, effective: DateCell) => ({
    object: "page", id: synthetic(`w23r-config-${n}`), parent: { type: "data_source_id", data_source_id: config.ds }, archived: false,
    properties: {
      Config: { type: "title", title: rich(name) },
      Type: { type: "select", select: { name: "LOCAL_CONSTRAINT" } },
      State: { type: "select", select: { name: "CONFIRMED" } },
      Value: { type: "rich_text", rich_text: rich(value) },
      "Config ID": uid(n),
      "Effective At": { type: "date", date: effective },
    },
  }) as unknown as Page;
  const timezoneRow = configRow(1, "TIMEZONE", DATE_ZONE, null);
  const constraintRows = [timezoneRow, ...constraints.map((e, i) => configRow(i + 2, `LIMIT_${i + 2}`, "1", dateCell(e)))];

  const client = new DailyClient(map);
  // Models server-side selection: each table answers only its exact contractual filters, [] for anything else.
  client.queryHandlers.set(config.ds, (filter) =>
    isDeepStrictEqual(filter, TIMEZONE_FILTER) ? [timezoneRow] : isDeepStrictEqual(filter, CONSTRAINTS_FILTER) ? constraintRows : [],
  );
  client.queryHandlers.set(taskTable.ds, (filter) => (isDeepStrictEqual(filter, DUE_FILTER) ? taskRows : []));

  const sources = await readDailySources(
    client,
    runtime,
    "SALES",
    ["CURRENT_WORK"],
    { effective_hold: "NONE", next_safe_action: "Continue" },
    DATE_NOW,
  );
  const sourceOf = (key: string): ContextSource => {
    const s = sources.find((x) => x.source_key === key);
    assert.ok(s, `${key} is supplied`);
    return s;
  };
  const relatedReads = client.reads
    .filter((r) => r.operation === "retrievePage")
    .map((r) => String(r.args[0]))
    .filter((id) => id === accountId || id === contactId);

  return { client, sources, sourceOf, config, taskTable, accountId, contactId, relatedReads };
}

/**
 * The one query of `ds` whose filter names `marker`: asked once, from the start, with exactly `filter` and `sorts` and an
 * 11-row page. No query of `ds` ever carries a cursor.
 */
function assertReachedQuery(client: DailyClient, ds: string, marker: string, filter: unknown, sorts: unknown): void {
  const onDs = client.queries.filter((q) => q.dataSourceId === ds);
  const matching = onDs.filter((q) => JSON.stringify(q.filter).includes(`"${marker}"`));
  assert.equal(matching.length, 1, `the ${marker} selection is queried exactly once`);
  const [q] = matching;
  assert.ok(q);
  assert.deepEqual(q.filter, filter);
  assert.deepEqual(q.options, { sorts, page_size: 11 });
  assert.equal(onDs.some((x) => x.cursor !== undefined && x.cursor !== null), false, "no continuation query");
}

async function dailySection(sources: readonly ContextSource[], key: string) {
  const { pack } = await buildContractPack({
    lane: "SALES",
    topic_hint: "CURRENT_WORK",
    runtime_generation: "g1",
    versions: { governing_spec: "S", governing_schema: "H", governing_control: "C", candidate_versions: [] },
    safety: {},
    open_backend_plan: "NONE",
    context_sources: sources,
  } as never);
  const section = pack.selected_context.contexts.flatMap((c) => c.sections).find((s) => s.source_key === key);
  assert.ok(section, `${key} section is served`);
  return section;
}

const DUE_AND_RELATED = [DAILY_SOURCE_KEYS.DUE_TASKS, DAILY_SOURCE_KEYS.TASK_ACCOUNTS, DAILY_SOURCE_KEYS.TASK_CONTACTS];

test("PT-CP-013/W2.3R-1: Due Tasks asks READY/IN_PROGRESS reached by civil today OR the instant; a zone day and a next-UTC-day offset instant are served", async () => {
  const { client, sources, sourceOf, taskTable, accountId, contactId, relatedReads } = await dateWorld([
    { due: CIVIL_TODAY, account: true, contact: true },
    { due: PAST_OFFSET_INSTANT, status: "IN_PROGRESS", account: true },
  ]);

  assertReachedQuery(client, taskTable.ds, "IN_PROGRESS", DUE_FILTER, DUE_SORTS);

  const due = sourceOf(DAILY_SOURCE_KEYS.DUE_TASKS);
  assert.equal(due.status, "PRESENT");
  assert.equal(due.rows.length, 2);
  // Both tasks name the same Account (de-duplicated); only the first names a Contact.
  const accounts = sourceOf(DAILY_SOURCE_KEYS.TASK_ACCOUNTS);
  assert.equal(accounts.status, "PRESENT");
  assert.equal(accounts.rows.length, 1);
  const contacts = sourceOf(DAILY_SOURCE_KEYS.TASK_CONTACTS);
  assert.equal(contacts.status, "PRESENT");
  assert.equal(contacts.rows.length, 1);
  assert.deepEqual([...relatedReads].sort(), [accountId, contactId].sort(), "each related page is read once");

  const section = await dailySection(sources, DAILY_SOURCE_KEYS.DUE_TASKS);
  assert.equal(section.source_status, "PRESENT");
  assert.equal(section.available, 2);
  assert.equal(section.served, 2);
  assert.equal(section.omitted, 0);
});

test("PT-CP-013/W2.3R-2: a returned Due Date still future in the instance zone makes Due Tasks, Accounts and Contacts ABSENT, no 12th read", async () => {
  // The server returns 12 rows in order; the 11th (read) and 12th (never read) are due tomorrow in Los Angeles.
  const tasks: TaskSpec[] = Array.from({ length: 12 }, (_, i) => ({
    due: i < 10 ? CIVIL_TODAY : ZONE_TOMORROW,
    account: i === 0,
    contact: i === 0,
  }));
  const { client, sourceOf, taskTable, relatedReads } = await dateWorld(tasks);

  assertReachedQuery(client, taskTable.ds, "IN_PROGRESS", DUE_FILTER, DUE_SORTS);
  for (const key of DUE_AND_RELATED) {
    assert.equal(sourceOf(key).status, "ABSENT", key);
    assert.deepEqual(sourceOf(key).rows, [], key);
  }
  assert.deepEqual(relatedReads, [], "no related page is read for an unproven window");
});

test("PT-CP-013/W2.3R-3: Runtime Constraints asks OR(empty, civil today, instant); reached candidates are PRESENT", async () => {
  const { client, sourceOf, config } = await dateWorld([], [CIVIL_TODAY, PAST_OFFSET_INSTANT]);

  assertReachedQuery(client, config.ds, "CONFIRMED", CONSTRAINTS_FILTER, CONSTRAINTS_SORTS);
  const constraints = sourceOf(DAILY_SOURCE_KEYS.RUNTIME_CONSTRAINTS);
  assert.equal(constraints.status, "PRESENT");
  assert.equal(constraints.rows.length, 3, "TIMEZONE (empty Effective At), a zone day and a past offset instant");
});

test("PT-CP-013/W2.3R-4: a returned future Effective At makes the whole Runtime Constraints source ABSENT", async () => {
  const { client, sourceOf, config } = await dateWorld([], [CIVIL_TODAY, PAST_OFFSET_INSTANT, ZONE_TOMORROW]);

  assertReachedQuery(client, config.ds, "CONFIRMED", CONSTRAINTS_FILTER, CONSTRAINTS_SORTS);
  const constraints = sourceOf(DAILY_SOURCE_KEYS.RUNTIME_CONSTRAINTS);
  assert.equal(constraints.status, "ABSENT");
  assert.deepEqual(constraints.rows, []);
  // The zone itself resolved: Due Tasks (no returned rows) is PRESENT and empty.
  assert.equal(sourceOf(DAILY_SOURCE_KEYS.DUE_TASKS).status, "PRESENT");
});

test("PT-CP-013/W2.3R-5: a date range or a named-zone date is ABSENT when encountered, in Due Tasks and Runtime Constraints", async () => {
  const cases: ReadonlyArray<readonly [string, readonly TaskSpec[], DateCell]> = [
    // The range row sorts first (start 27th), the named-zone instant after the bare day of the 28th.
    ["range", [{ due: RANGE_DATE, account: true }, { due: CIVIL_TODAY }], RANGE_DATE],
    ["named zone", [{ due: CIVIL_TODAY, account: true }, { due: NAMED_ZONE_DATE }], NAMED_ZONE_DATE],
  ];
  for (const [label, tasks, effective] of cases) {
    const { client, sourceOf, taskTable, config, relatedReads } = await dateWorld(tasks, [CIVIL_TODAY, effective]);

    assertReachedQuery(client, taskTable.ds, "IN_PROGRESS", DUE_FILTER, DUE_SORTS);
    for (const key of DUE_AND_RELATED) {
      assert.equal(sourceOf(key).status, "ABSENT", `${label}: ${key}`);
      assert.deepEqual(sourceOf(key).rows, [], `${label}: ${key}`);
    }
    assert.deepEqual(relatedReads, [], `${label}: no related page is read`);

    assertReachedQuery(client, config.ds, "CONFIRMED", CONSTRAINTS_FILTER, CONSTRAINTS_SORTS);
    assert.equal(sourceOf(DAILY_SOURCE_KEYS.RUNTIME_CONSTRAINTS).status, "ABSENT", `${label}: RUNTIME_CONSTRAINTS`);
  }
});

// ─────────────────────────────── PT-CP-013/c E3: typed pointers re-read at the bound Business Configuration ───────────────────────────────

/** The only admitted pointer field of the published Business Configuration resource. */
const POINTER_FIELD = "Value";
const REP_A_CONFIG = BC("rep-a");
const REP_B_CONFIG = BC("rep-b");
const configItemFilter = (key: string) => ({ property: "Config Item", title: { equals: key } });
const WRITE_LIKE = /create|update|append|delete|archive|patch|write|insert|move|restore/i;

interface PointerSpec {
  readonly name: string;
  readonly declared: string;
  /** Pointer Resource Key, Pointer Natural Key, Pointer Value Field — verbatim as the row carries them. */
  readonly pointer?: readonly [string, string, string];
}
interface TargetSpec {
  readonly item: string;
  readonly value: string;
}

/**
 * A SALES world (TIMEZONE America/Los_Angeles, Config ID 1) whose Runtime Configuration returns, for exactly
 * CONSTRAINTS_FILTER, the TIMEZONE row then one CONFIRMED PRODUCTION_CONTRACT_POINTER row per spec (Config ID 2, 3, …).
 * `targets` are CONFIRMED, already-effective rows of the bound runtime's own Business Configuration (rep A), answered
 * only for an exact Config Item title equality. Rep B's rival Business Configuration has no handler: any query of it
 * would fail. Every property touched on the client is recorded, and the fixture map is snapshotted.
 */
async function pointerWorld(specs: readonly PointerSpec[], targets: readonly TargetSpec[]) {
  const sw = buildSetupWorld("B5_OUTREACH", 5);
  const runtime = await runtimeOf(sw);
  const map = sw.w.map;

  const config = installDailyTable(map, runtime.root_ref, "02 — SETUP & BUSINESS CONFIG", "Runtime Configuration", {
    Config: { type: "title" },
    Type: { type: "select" },
    State: { type: "select" },
    Value: { type: "rich_text" },
    "Config ID": { type: "unique_id" },
    "Effective At": { type: "date" },
    "Pointer Resource Key": { type: "rich_text" },
    "Pointer Natural Key": { type: "rich_text" },
    "Pointer Value Field": { type: "rich_text" },
  });

  const cell = (s: string) => ({ type: "rich_text", rich_text: s === "" ? [] : rich(s) });
  const configRow = (n: number, name: string, type: string, value: string, pointer: readonly [string, string, string] = ["", "", ""]) => ({
    object: "page", id: synthetic(`e3-config-${n}`), parent: { type: "data_source_id", data_source_id: config.ds }, archived: false,
    properties: {
      Config: { type: "title", title: rich(name) },
      Type: { type: "select", select: { name: type } },
      State: { type: "select", select: { name: "CONFIRMED" } },
      Value: cell(value),
      "Config ID": { type: "unique_id", unique_id: { prefix: null, number: n } },
      "Effective At": { type: "date", date: null },
      "Pointer Resource Key": cell(pointer[0]),
      "Pointer Natural Key": cell(pointer[1]),
      "Pointer Value Field": cell(pointer[2]),
    },
  }) as unknown as Page;
  const timezoneRow = configRow(1, "TIMEZONE", "LOCAL_CONSTRAINT", DATE_ZONE);
  const rows = [timezoneRow, ...specs.map((s, i) => configRow(i + 2, s.name, "PRODUCTION_CONTRACT_POINTER", s.declared, s.pointer))];

  // Target rows exactly as the Business Configuration schema types them, made already effective for this clock.
  const targetRows = targets.map((t, i) => {
    const row = answerRow(REP_A_CONFIG.ds, { gate: "B6_AUTHORITY", key: t.item, category: "CONSTRAINT", value: t.value }, { id: synthetic(`e3-target-${i}`) });
    return {
      ...row,
      properties: { ...row.properties, "Effective At": { type: "date", date: { start: "2026-09-01", end: null, time_zone: null } } } as Page["properties"],
    };
  });

  const client = new DailyClient(map);
  client.queryHandlers.set(config.ds, (filter) =>
    isDeepStrictEqual(filter, TIMEZONE_FILTER) ? [timezoneRow] : isDeepStrictEqual(filter, CONSTRAINTS_FILTER) ? rows : [],
  );
  // Models the server: rows come back only for an exact Config Item title equality, never for anything looser.
  client.queryHandlers.set(REP_A_CONFIG.ds, (filter) =>
    targetRows.filter((_, i) => isDeepStrictEqual(filter, configItemFilter(targets[i]!.item))),
  );

  const touched = new Set<PropertyKey>();
  const observed = new Proxy(client, {
    get(t, p, r) {
      touched.add(p);
      return Reflect.get(t, p, r);
    },
  });
  const mapBefore = [...map.entries()];

  const sources = await readDailySources(
    observed,
    runtime,
    "SALES",
    ["CURRENT_WORK"],
    { effective_hold: "NONE", next_safe_action: "Continue" },
    DATE_NOW,
  );
  const source = sources.find((s) => s.source_key === DAILY_SOURCE_KEYS.RUNTIME_CONSTRAINTS);
  assert.ok(source, "RUNTIME_CONSTRAINTS is supplied");
  assertReachedQuery(client, config.ds, "CONFIRMED", CONSTRAINTS_FILTER, CONSTRAINTS_SORTS);

  // No external write: no write-like member is ever looked up on the client, and the fixture world is untouched.
  assert.deepEqual([...touched].filter((p) => typeof p === "string" && WRITE_LIKE.test(p)), [], "no write-like client member is touched");
  assert.deepEqual([...map.entries()], mapBefore, "the fixture world is unchanged");

  const rowOf = (name: string): Record<string, unknown> => {
    const r = (source.rows as Array<Record<string, unknown>>).find((x) => x.config === name);
    assert.ok(r, `row ${name} is carried`);
    return r;
  };
  return { client, sources, source, rowOf };
}

/**
 * The bound Business Configuration was queried once per re-read pointer, in row order, each with exactly the Config Item
 * title equality, at most 2 rows asked and never continued. The rival runtime's Business Configuration is never touched.
 */
function assertPointerQueries(client: DailyClient, keys: readonly string[]): void {
  const onTarget = client.queries.filter((q) => q.dataSourceId === REP_A_CONFIG.ds);
  assert.deepEqual(onTarget.map((q) => q.filter), keys.map(configItemFilter), "exact Config Item equality per re-read pointer");
  for (const q of onTarget) {
    const size = (q.options as { page_size?: unknown } | undefined)?.page_size;
    assert.ok(typeof size === "number" && size >= 1 && size <= 2, `page_size ${String(size)} <= 2`);
    assert.ok(q.cursor === undefined || q.cursor === null, "pointer query carries no cursor");
  }
  assert.equal(client.queries.some((q) => q.dataSourceId === REP_B_CONFIG.ds), false, "rival Business Configuration never queried");
  const rival = new Set<unknown>([REP_B_CONFIG.parent, REP_B_CONFIG.db, REP_B_CONFIG.ds]);
  assert.equal(client.reads.some((r) => rival.has(r.args[0])), false, "rival Business Configuration never read");
}

function assertNoReread(row: Record<string, unknown>, declared: string, status: string, label: string): void {
  assert.equal(row.reread_status, status, label);
  assert.equal(row.declared_value, declared, `${label}: declared value kept`);
  assert.equal(Object.hasOwn(row, "reread_value"), false, `${label}: no invented re-read value`);
}

test("PT-CP-013/c E3-1: a typed pointer to SALES:BUSINESS_CONFIG carries declared and re-read values apart, MATCH or DRIFT as exact text", async () => {
  const { client, sources, rowOf } = await pointerWorld(
    [
      { name: "MAX_DAILY_SENDS", declared: "25", pointer: [CONFIG, "LIMIT:MAX_DAILY_SENDS", POINTER_FIELD] },
      // Numerically equal, textually different: a threshold is never interpreted, so this is DRIFT.
      { name: "MIN_REPLY_SCORE", declared: "0.7", pointer: [CONFIG, "LIMIT:MIN_REPLY_SCORE", POINTER_FIELD] },
      { name: "MAX_TOUCHES", declared: "3", pointer: [CONFIG, "LIMIT:MAX_TOUCHES", POINTER_FIELD] },
    ],
    [
      { item: "LIMIT:MAX_DAILY_SENDS", value: "25" },
      { item: "LIMIT:MIN_REPLY_SCORE", value: "0.70" },
      { item: "LIMIT:MAX_TOUCHES", value: "5" },
    ],
  );

  assertPointerQueries(client, ["LIMIT:MAX_DAILY_SENDS", "LIMIT:MIN_REPLY_SCORE", "LIMIT:MAX_TOUCHES"]);

  const timezone = rowOf("TIMEZONE");
  assert.equal(timezone.reread_status, "NO_POINTER");
  assert.equal(Object.hasOwn(timezone, "reread_value"), false);

  const match = rowOf("MAX_DAILY_SENDS");
  assert.equal(match.reread_status, "MATCH");
  assert.equal(match.declared_value, "25");
  assert.equal(match.reread_value, "25");

  const textual = rowOf("MIN_REPLY_SCORE");
  assert.equal(textual.reread_status, "DRIFT");
  assert.equal(textual.declared_value, "0.7", "declared value is never overwritten by the re-read");
  assert.equal(textual.reread_value, "0.70");

  const drift = rowOf("MAX_TOUCHES");
  assert.equal(drift.reread_status, "DRIFT");
  assert.equal(drift.declared_value, "3");
  assert.equal(drift.reread_value, "5");

  const section = await dailySection(sources, DAILY_SOURCE_KEYS.RUNTIME_CONSTRAINTS);
  assert.equal(section.source_status, "PRESENT");
  assert.equal(section.available, 4);
  assert.equal(section.served, 4);
  assert.equal(section.omitted, 0);
});

test("PT-CP-013/c E3-2: a pointer whose Config Item is absent is MISSING, with no invented value", async () => {
  const { client, source, rowOf } = await pointerWorld(
    [{ name: "MAX_DAILY_SENDS", declared: "25", pointer: [CONFIG, "LIMIT:NOT_THERE", POINTER_FIELD] }],
    [{ item: "LIMIT:MAX_DAILY_SENDS", value: "25" }],
  );

  assert.equal(source.status, "PRESENT");
  assertPointerQueries(client, ["LIMIT:NOT_THERE"]);
  assertNoReread(rowOf("MAX_DAILY_SENDS"), "25", "MISSING", "missing target");
});

test("PT-CP-013/c E3-3: a partial or wrong pointer is INVALID, never completed or followed", async () => {
  const cases: ReadonlyArray<readonly [string, readonly [string, string, string]]> = [
    ["NO_FIELD", [CONFIG, "LIMIT:X", ""]],
    ["NO_RESOURCE", ["", "LIMIT:X", POINTER_FIELD]],
    ["NO_KEY", [CONFIG, "", POINTER_FIELD]],
    ["RIVAL_RESOURCE", ["SALES:RIVAL_CONFIG", "LIMIT:X", POINTER_FIELD]],
    ["WRONG_FIELD", [CONFIG, "LIMIT:X", "Notes"]],
    ["PADDED_KEY", [CONFIG, " LIMIT:X", POINTER_FIELD]],
    ["PADDED_RESOURCE", [CONFIG + " ", "LIMIT:X", POINTER_FIELD]],
    ["PADDED_FIELD", [CONFIG, "LIMIT:X", POINTER_FIELD + " "]],
  ];
  const { client, source, rowOf } = await pointerWorld(
    cases.map(([name, pointer]) => ({ name, declared: `declared ${name}`, pointer })),
    [{ item: "LIMIT:X", value: "TARGET-VALUE-X" }],
  );

  assert.equal(source.status, "PRESENT");
  assertPointerQueries(client, []);
  for (const [name] of cases) assertNoReread(rowOf(name), `declared ${name}`, "INVALID", name);
  assert.doesNotMatch(JSON.stringify(source.rows), /TARGET-VALUE-X/, "no target value leaks through an invalid pointer");
});

test("PT-CP-013/c E3-4: two Business Configuration rows for the same Config Item are AMBIGUOUS, neither value served", async () => {
  const { client, source, rowOf } = await pointerWorld(
    [{ name: "MAX_DAILY_SENDS", declared: "25", pointer: [CONFIG, "LIMIT:DUP", POINTER_FIELD] }],
    [
      { item: "LIMIT:DUP", value: "DUP-A-25" },
      { item: "LIMIT:DUP", value: "DUP-B-30" },
    ],
  );

  assert.equal(source.status, "PRESENT");
  assertPointerQueries(client, ["LIMIT:DUP"]);
  assertNoReread(rowOf("MAX_DAILY_SENDS"), "25", "AMBIGUOUS", "duplicate Config Item");
  assert.doesNotMatch(JSON.stringify(source.rows), /DUP-A|DUP-B/, "neither duplicate's value is served");
});

test("PT-CP-013/c E3-5: the 11th Runtime Constraint counts for S6 but its pointer is never re-read", async () => {
  // TIMEZONE is Config ID 1; ten pointer rows follow (IDs 2..11), each naming an existing, matching target.
  const ids = Array.from({ length: 10 }, (_, i) => i + 2);
  const { client, sources, source } = await pointerWorld(
    ids.map((n) => ({ name: `LIMIT_${n}`, declared: `${n}`, pointer: [CONFIG, `LIMIT:K${n}`, POINTER_FIELD] as const })),
    ids.map((n) => ({ item: `LIMIT:K${n}`, value: `${n}` })),
  );

  assert.equal(source.status, "PRESENT");
  assert.equal(source.rows.length, 11);
  const rows = source.rows as Array<Record<string, unknown>>;
  assert.equal(rows[0]!.reread_status, "NO_POINTER");
  for (const r of rows.slice(1, 10)) assert.equal(r.reread_status, "MATCH", String(r.config));

  const eleventh = rows[10]!;
  assert.equal(eleventh.config, "LIMIT_11");
  assert.equal(eleventh.declared_value, "11");
  assert.equal(Object.hasOwn(eleventh, "reread_status"), false, "the 11th row is not re-read");
  assert.equal(Object.hasOwn(eleventh, "reread_value"), false, "the 11th row carries no re-read value");

  // Only the 9 pointers among the 10 served rows are re-read; LIMIT:K11 is never asked.
  assertPointerQueries(client, ids.slice(0, 9).map((n) => `LIMIT:K${n}`));

  const section = await dailySection(sources, DAILY_SOURCE_KEYS.RUNTIME_CONSTRAINTS);
  assert.equal(section.source_status, "PRESENT");
  assert.equal(section.available, 11);
  assert.equal(section.served, 10);
  assert.equal(section.items.length, 10);
  assert.equal(section.omitted, 1);
  assert.equal(section.truncated_by, "ROWS_PER_SECTION");
});

// ─────────────────────────────── PT-CP-013/a W2.3: BLOCKED_TASKS, ACTIVE_RULES, ACTIVE_SEQUENCES ───────────────────────────────

const w23aSort = (property: string) => ({ property, direction: "ascending" });
const w23aUid = (number: number) => ({ type: "unique_id", unique_id: { prefix: null, number } });
const w23aSortsOf = (options: unknown): unknown => (options as { sorts?: unknown } | undefined)?.sorts;
const w23aPageSizeOf = (options: unknown): unknown => (options as { page_size?: unknown } | undefined)?.page_size;
const w23aPage = (ds: string, seed: string, properties: Record<string, unknown>): Page =>
  ({ object: "page", id: synthetic(seed), parent: { type: "data_source_id", data_source_id: ds }, archived: false, properties }) as unknown as Page;
const w23aIds = (source: ContextSource, key: string): unknown[] => (source.rows as Array<Record<string, unknown>>).map((r) => r[key]);

/**
 * A SALES world whose TIMEZONE is America/Los_Angeles (answered only for exactly TIMEZONE_FILTER). `setup` installs the
 * tables under test and returns their query handlers; every other data source has no handler and fails if queried.
 */
async function sectionWorld(setup: (map: Map<string, unknown>, root: string) => ReadonlyArray<readonly [string, QueryHandler]>) {
  const sw = buildSetupWorld("B5_OUTREACH", 5);
  const runtime = await runtimeOf(sw);
  const map = sw.w.map;
  const config = installDailyTable(map, runtime.root_ref, "02 — SETUP & BUSINESS CONFIG", "Runtime Configuration", {
    Config: { type: "title" },
    Type: { type: "select" },
    State: { type: "select" },
    Value: { type: "rich_text" },
  });
  const timezoneRow = w23aPage(config.ds, "w23a-timezone", {
    Config: { type: "title", title: rich("TIMEZONE") },
    Type: { type: "select", select: { name: "LOCAL_CONSTRAINT" } },
    State: { type: "select", select: { name: "CONFIRMED" } },
    Value: { type: "rich_text", rich_text: rich(DATE_ZONE) },
  });
  const handlers = setup(map, runtime.root_ref);

  const client = new DailyClient(map);
  client.queryHandlers.set(config.ds, (filter) => (isDeepStrictEqual(filter, TIMEZONE_FILTER) ? [timezoneRow] : []));
  for (const [ds, handler] of handlers) client.queryHandlers.set(ds, handler);

  const sources = await readDailySources(
    client,
    runtime,
    "SALES",
    ["CURRENT_WORK"],
    { effective_hold: "NONE", next_safe_action: "Continue" },
    DATE_NOW,
  );
  const sourceOf = (key: string): ContextSource => {
    const s = sources.find((x) => x.source_key === key);
    assert.ok(s, `${key} is supplied`);
    return s;
  };
  return { client, sources, sourceOf };
}

// ── BLOCKED_TASKS ──

const BLOCKED_DATED_SORTS = [w23aSort("Due Date"), w23aSort("Task ID")];
const TASK_ID_SORTS = [w23aSort("Task ID")];

interface BlockedSpec {
  readonly id: number;
  readonly due: string | null;
  readonly status?: string;
}

/**
 * Tasks answered only for a BLOCKED-only filter: `dated` for the Due Date then Task ID sort, `undated` for the Task ID
 * sort alone, each already in server order. Any other filter (e.g. Due Tasks' READY/IN_PROGRESS) gets [].
 */
async function blockedWorld(dated: readonly BlockedSpec[], undated: readonly BlockedSpec[]) {
  let tasksDs = "";
  const world = await sectionWorld((map, root) => {
    const tasks = installDailyTable(map, root, "03 — CONTROL PLANE", "Tasks", {
      Task: { type: "title" },
      Status: { type: "select" },
      "Due Date": { type: "date" },
      "Task ID": { type: "unique_id" },
    });
    tasksDs = tasks.ds;
    const page = (s: BlockedSpec) =>
      w23aPage(tasks.ds, `w23a-task-${s.id}`, {
        Task: { type: "title", title: rich(`Task ${s.id}`) },
        Status: { type: "select", select: { name: s.status ?? "BLOCKED" } },
        "Due Date": { type: "date", date: s.due === null ? null : { start: s.due, end: null, time_zone: null } },
        "Task ID": w23aUid(s.id),
      });
    const datedRows = dated.map(page);
    const undatedRows = undated.map(page);
    return [
      [
        tasks.ds,
        (filter, options) => {
          const f = JSON.stringify(filter);
          if (!f.includes('"equals":"BLOCKED"') || /READY|IN_PROGRESS|DONE/.test(f)) return [];
          const sorts = w23aSortsOf(options);
          if (isDeepStrictEqual(sorts, BLOCKED_DATED_SORTS)) return datedRows;
          if (isDeepStrictEqual(sorts, TASK_ID_SORTS)) return undatedRows;
          return [];
        },
      ],
    ];
  });
  const blockedQueries = world.client.queries.filter(
    (q) => q.dataSourceId === tasksDs && JSON.stringify(q.filter).includes('"equals":"BLOCKED"'),
  );
  return { ...world, tasksDs, blockedQueries };
}

test("PT-CP-013/a W2.3-BLOCKED-1: Blocked Tasks asks BLOCKED only, dated by Due Date then Task ID, then undated by Task ID", async () => {
  const { sources, sourceOf, blockedQueries } = await blockedWorld(
    // Past and future due dates alike: Blocked Tasks carries no date cutoff.
    [
      { id: 3, due: "2026-09-20" },
      { id: 1, due: "2026-09-25" },
      { id: 2, due: "2026-09-25" },
      { id: 7, due: "2026-10-30" },
    ],
    [
      { id: 4, due: null },
      { id: 5, due: null },
    ],
  );

  assert.equal(blockedQueries.length, 2, "one dated and one undated BLOCKED selection");
  const [datedQ, undatedQ] = blockedQueries;
  assert.ok(datedQ && undatedQ);
  assert.deepEqual(w23aSortsOf(datedQ.options), BLOCKED_DATED_SORTS, "dated phase first, Due Date then Task ID");
  assert.deepEqual(w23aSortsOf(undatedQ.options), TASK_ID_SORTS, "undated phase second, Task ID only");
  assert.equal(w23aPageSizeOf(datedQ.options), 11);
  for (const q of blockedQueries) {
    const f = JSON.stringify(q.filter);
    assert.match(f, /"Due Date"/, "each phase conditions on Due Date presence");
    assert.doesNotMatch(f, /READY|IN_PROGRESS|DONE/, "BLOCKED is the only status asked");
    assert.doesNotMatch(f, /on_or_before|on_or_after|"before"|"after"/, "no date cutoff");
    const size = w23aPageSizeOf(q.options);
    assert.ok(typeof size === "number" && size >= 1 && size <= 11, `page_size ${String(size)} <= 11`);
    assert.ok(q.cursor === undefined || q.cursor === null, "no continuation query");
  }

  const blocked = sourceOf(DAILY_SOURCE_KEYS.BLOCKED_TASKS);
  assert.equal(blocked.status, "PRESENT");
  assert.deepEqual(w23aIds(blocked, "task_id"), ["3", "1", "2", "7", "4", "5"]);

  const section = await dailySection(sources, DAILY_SOURCE_KEYS.BLOCKED_TASKS);
  assert.equal(section.source_status, "PRESENT");
  assert.equal(section.available, 6);
  assert.equal(section.served, 6);
  assert.equal(section.omitted, 0);
});

test("PT-CP-013/a W2.3-BLOCKED-2: a returned non-BLOCKED or out-of-order task makes Blocked Tasks ABSENT", async () => {
  const cases: ReadonlyArray<readonly [string, readonly BlockedSpec[], readonly BlockedSpec[]]> = [
    ["non-BLOCKED status", [{ id: 1, due: "2026-09-20" }, { id: 2, due: "2026-09-21", status: "READY" }], []],
    ["dated out of order", [{ id: 1, due: "2026-09-25" }, { id: 2, due: "2026-09-20" }], []],
    ["undated out of order", [], [{ id: 5, due: null }, { id: 4, due: null }]],
  ];
  for (const [label, dated, undated] of cases) {
    const { sourceOf } = await blockedWorld(dated, undated);
    const blocked = sourceOf(DAILY_SOURCE_KEYS.BLOCKED_TASKS);
    assert.equal(blocked.status, "ABSENT", label);
    assert.deepEqual(blocked.rows, [], label);
  }
});

// ── ACTIVE_RULES ──

const RULE_PRIORITY_NAMES = ["P0", "P1", "P2", "P3", "P4", "P5"] as const;
const priorityOf = (filter: unknown): string | undefined => {
  const f = JSON.stringify(filter);
  return RULE_PRIORITY_NAMES.find((p) => f.includes(`"equals":"${p}"`));
};

/**
 * Decision Rules answered, for an Active condition and a Rule ID sort, with the rows of exactly the named priority in
 * server order. `relabel` gives a rule a Priority other than the phase that returns it (a server misbehaving).
 */
async function rulesWorld(byPriority: Readonly<Record<string, readonly number[]>>, relabel: Readonly<Record<number, string>> = {}) {
  let rulesDs = "";
  const world = await sectionWorld((map, root) => {
    const rules = installDailyTable(map, root, "03 — CONTROL PLANE", "Decision Rules", {
      Active: { type: "checkbox" },
      Priority: { type: "select" },
      "Rule ID": { type: "unique_id" },
      Rule: { type: "title" },
    });
    rulesDs = rules.ds;
    const rows = new Map<string, Page[]>(
      Object.entries(byPriority).map(([p, ids]) => [
        p,
        ids.map((n) =>
          w23aPage(rules.ds, `w23a-rule-${n}`, {
            Active: { type: "checkbox", checkbox: true },
            Priority: { type: "select", select: { name: relabel[n] ?? p } },
            "Rule ID": w23aUid(n),
            Rule: { type: "title", title: rich(`${p} rule ${n}`) },
          }),
        ),
      ]),
    );
    return [
      [
        rules.ds,
        (filter, options) => {
          if (!JSON.stringify(filter).includes('"Active"')) return [];
          if (!isDeepStrictEqual(w23aSortsOf(options), [w23aSort("Rule ID")])) return [];
          const p = priorityOf(filter);
          return p ? (rows.get(p) ?? []) : [];
        },
      ],
    ];
  });
  const activeQueries = world.client.queries.filter((q) => q.dataSourceId === rulesDs && priorityOf(q.filter) !== "P0");
  return { ...world, rulesDs, activeQueries };
}

test("PT-CP-013/a W2.3-RULES-1: Active Rules reads P1→P5 then Rule ID, excludes P0, and shares one 11-row window across phases", async () => {
  const { sources, sourceOf, activeQueries } = await rulesWorld({
    P0: [1],
    P1: [4, 9],
    P2: [2, 3, 8],
    // 7 P3 rows: the window closes at the 6th (Rule ID 12); Rule ID 15, P4 and P5 are never served.
    P3: [5, 6, 7, 10, 11, 12, 15],
    P4: [13],
    P5: [14],
  });

  const asked = activeQueries.map((q) => priorityOf(q.filter));
  assert.ok(asked.length >= 3, "P1, P2 and P3 are each asked");
  assert.deepEqual(asked, ["P1", "P2", "P3", "P4", "P5"].slice(0, asked.length), "one selection per priority, P1 → P5");
  for (const q of activeQueries) {
    assert.deepEqual(w23aSortsOf(q.options), [w23aSort("Rule ID")]);
    const size = w23aPageSizeOf(q.options);
    assert.ok(typeof size === "number" && size >= 1 && size <= 11, `page_size ${String(size)} <= 11`);
    assert.ok(q.cursor === undefined || q.cursor === null, "no continuation query");
  }

  const active = sourceOf(DAILY_SOURCE_KEYS.ACTIVE_RULES);
  assert.equal(active.status, "PRESENT");
  assert.deepEqual(w23aIds(active, "rule_id"), ["4", "9", "2", "3", "8", "5", "6", "7", "10", "11", "12"]);
  assert.equal(active.rows.length, 11, "at most 11 rows across all phases");

  const p0 = sourceOf(DAILY_SOURCE_KEYS.P0_RULES);
  assert.deepEqual(w23aIds(p0, "rule_id"), ["1"], "P0 is its own section, not repeated in Active Rules");

  const section = await dailySection(sources, DAILY_SOURCE_KEYS.ACTIVE_RULES);
  assert.equal(section.source_status, "PRESENT");
  assert.equal(section.available, 11);
  assert.equal(section.served, 10);
  assert.equal(section.omitted, 1);
  assert.equal(section.truncated_by, "ROWS_PER_SECTION");
});

test("PT-CP-013/a W2.3-RULES-2: a P0 or out-of-order row returned for an Active Rules phase makes it ABSENT", async () => {
  const cases: ReadonlyArray<readonly [string, Readonly<Record<string, readonly number[]>>, Readonly<Record<number, string>>]> = [
    ["out of order within a priority", { P1: [9, 4] }, {}],
    ["P0 row returned for the P1 phase", { P1: [4, 9] }, { 9: "P0" }],
  ];
  for (const [label, byPriority, relabel] of cases) {
    const { sourceOf } = await rulesWorld(byPriority, relabel);
    const active = sourceOf(DAILY_SOURCE_KEYS.ACTIVE_RULES);
    assert.equal(active.status, "ABSENT", label);
    assert.deepEqual(active.rows, [], label);
  }
});

// ── ACTIVE_SEQUENCES ──

const SEQUENCE_ACTIVE_FILTER = { property: "Status", select: { equals: "ACTIVE" } };
const SEQUENCE_SORTS = [w23aSort("Sequence ID")];

async function sequencesWorld(returned: ReadonlyArray<readonly [number, string]>) {
  let sequencesDs = "";
  const world = await sectionWorld((map, root) => {
    const sequences = installDailyTable(map, root, "05 — OPERATIONS & PLAYBOOKS", "Sequences", {
      Sequence: { type: "title" },
      Status: { type: "select" },
      "Sequence ID": { type: "unique_id" },
    });
    sequencesDs = sequences.ds;
    const rows = returned.map(([n, status]) =>
      w23aPage(sequences.ds, `w23a-sequence-${n}`, {
        Sequence: { type: "title", title: rich(`Sequence ${n}`) },
        Status: { type: "select", select: { name: status } },
        "Sequence ID": w23aUid(n),
      }),
    );
    // Models the server: rows only for exactly Status=ACTIVE by Sequence ID.
    return [
      [
        sequences.ds,
        (filter, options) =>
          isDeepStrictEqual(filter, SEQUENCE_ACTIVE_FILTER) && isDeepStrictEqual(w23aSortsOf(options), SEQUENCE_SORTS) ? rows : [],
      ],
    ];
  });
  return { ...world, sequencesDs };
}

test("PT-CP-013/a W2.3-SEQ-1: Active Sequences asks exactly Status=ACTIVE by Sequence ID", async () => {
  const { client, sources, sourceOf, sequencesDs } = await sequencesWorld([
    [2, "ACTIVE"],
    [5, "ACTIVE"],
    [9, "ACTIVE"],
  ]);

  assertReachedQuery(client, sequencesDs, "ACTIVE", SEQUENCE_ACTIVE_FILTER, SEQUENCE_SORTS);
  const sequences = sourceOf(DAILY_SOURCE_KEYS.ACTIVE_SEQUENCES);
  assert.equal(sequences.status, "PRESENT");
  assert.deepEqual(w23aIds(sequences, "sequence_id"), ["2", "5", "9"]);

  const section = await dailySection(sources, DAILY_SOURCE_KEYS.ACTIVE_SEQUENCES);
  assert.equal(section.source_status, "PRESENT");
  assert.equal(section.available, 3);
  assert.equal(section.served, 3);
  assert.equal(section.omitted, 0);
});

test("PT-CP-013/a W2.3-SEQ-2: a returned non-ACTIVE or out-of-order sequence makes Active Sequences ABSENT", async () => {
  const cases: ReadonlyArray<readonly [string, ReadonlyArray<readonly [number, string]>]> = [
    ["non-ACTIVE status", [[2, "ACTIVE"], [5, "PAUSED"]]],
    ["out of order", [[5, "ACTIVE"], [2, "ACTIVE"]]],
  ];
  for (const [label, returned] of cases) {
    const { sourceOf } = await sequencesWorld(returned);
    const sequences = sourceOf(DAILY_SOURCE_KEYS.ACTIVE_SEQUENCES);
    assert.equal(sequences.status, "ABSENT", label);
    assert.deepEqual(sequences.rows, [], label);
  }
});

// ── RECENT_RECEIPTS ──

const RECEIPT_DATED_SORTS = [{ property: "Event Timestamp", direction: "descending" }, w23aSort("Receipt ID")];
const RECEIPT_ID_SORTS = [w23aSort("Receipt ID")];
const RECEIPT_KEYS = ["receipt_id", "event_type", "event_timestamp", "task_id", "account_id", "contact_id"];
const NO_CUTOFF = /on_or_before|on_or_after|"before"|"after"|past_week|past_month|past_year|next_/;

/** own: one verified page of the bound runtime's target table; foreign: one page parented elsewhere; two: two own pages; missing: an unknown page. */
type LinkKind = "own" | "foreign" | "two" | "missing";

interface ReceiptSpec {
  readonly id: number;
  readonly at: string | null;
  readonly task?: LinkKind;
  readonly account?: LinkKind;
  readonly contact?: LinkKind;
}

/**
 * Receipts related to the bound runtime's own Tasks, Accounts and Contacts. The server answers only a Verified +
 * Event Timestamp condition: `dated` for Event Timestamp descending then Receipt ID, `undated` for Receipt ID alone,
 * each already in server order. Related targets: Task ID 21, Account ID 7 (and 8), Contact ID 9.
 */
async function receiptsWorld(dated: readonly ReceiptSpec[], undated: readonly ReceiptSpec[]) {
  let receiptsDs = "";
  const world = await sectionWorld((map, root) => {
    const accounts = installDailyTable(map, root, "04 — DATA & EVIDENCE", "Accounts", { "Account ID": { type: "unique_id" } });
    const contacts = installDailyTable(map, root, "04 — DATA & EVIDENCE", "Contacts", { "Contact ID": { type: "unique_id" } });
    const sequences = installDailyTable(map, root, "05 — OPERATIONS & PLAYBOOKS", "Sequences", { "Sequence ID": { type: "unique_id" } });
    const tasks = installDailyTable(map, root, "03 — CONTROL PLANE", "Tasks", {
      Task: { type: "title" },
      Status: { type: "select" },
      "Due Date": { type: "date" },
      "Task ID": { type: "unique_id" },
      Account: { type: "relation", relation: { data_source_id: accounts.ds } },
      Contact: { type: "relation", relation: { data_source_id: contacts.ds } },
      Sequence: { type: "relation", relation: { data_source_id: sequences.ds } },
    });
    const receipts = installDailyTable(map, root, "03 — CONTROL PLANE", "Receipts", {
      Receipt: { type: "title" },
      Verified: { type: "checkbox" },
      "Event Timestamp": { type: "date" },
      "Receipt ID": { type: "unique_id" },
      "Event Type": { type: "select" },
      Task: { type: "relation", relation: { data_source_id: tasks.ds } },
      Account: { type: "relation", relation: { data_source_id: accounts.ds } },
      Contact: { type: "relation", relation: { data_source_id: contacts.ds } },
    });
    receiptsDs = receipts.ds;

    const target = (seed: string, ds: string, column: string, n: number): string => {
      const id = synthetic(seed);
      map.set(`page:${id}`, { object: "page", id, parent: { type: "data_source_id", data_source_id: ds }, archived: false, properties: { [column]: w23aUid(n) } });
      return id;
    };
    // A foreign page carries the right ID column, but its parent is another table (Contacts ↔ Accounts/Tasks swapped).
    const pages = {
      task: { own: target("w23a-rc-task", tasks.ds, "Task ID", 21), foreign: target("w23a-rc-task-foreign", accounts.ds, "Task ID", 22), other: target("w23a-rc-task-2", tasks.ds, "Task ID", 23) },
      account: { own: target("w23a-rc-account", accounts.ds, "Account ID", 7), foreign: target("w23a-rc-account-foreign", contacts.ds, "Account ID", 70), other: target("w23a-rc-account-2", accounts.ds, "Account ID", 8) },
      contact: { own: target("w23a-rc-contact", contacts.ds, "Contact ID", 9), foreign: target("w23a-rc-contact-foreign", accounts.ds, "Contact ID", 90), other: target("w23a-rc-contact-2", contacts.ds, "Contact ID", 10) },
    };
    const relation = (column: keyof typeof pages, kind: LinkKind | undefined) => {
      const p = pages[column];
      const ids =
        kind === undefined ? [] : kind === "own" ? [p.own] : kind === "foreign" ? [p.foreign] : kind === "two" ? [p.own, p.other] : [synthetic(`w23a-rc-${column}-missing`)];
      return { type: "relation", relation: ids.map((id) => ({ id })), has_more: false };
    };
    const page = (s: ReceiptSpec) =>
      w23aPage(receipts.ds, `w23a-receipt-${s.id}`, {
        Receipt: { type: "title", title: rich(`Receipt ${s.id}`) },
        Verified: { type: "checkbox", checkbox: true },
        "Event Timestamp": { type: "date", date: s.at === null ? null : { start: s.at, end: null, time_zone: null } },
        "Receipt ID": w23aUid(s.id),
        "Event Type": { type: "select", select: { name: "EMAIL_SENT" } },
        Task: relation("task", s.task),
        Account: relation("account", s.account),
        Contact: relation("contact", s.contact),
      });
    const datedRows = dated.map(page);
    const undatedRows = undated.map(page);
    return [
      // Tasks is only a relation target here: Due and Blocked selections return nothing.
      [tasks.ds, () => []],
      [
        receipts.ds,
        (filter, options) => {
          const f = JSON.stringify(filter);
          if (!f.includes('"Verified"') || !f.includes('"Event Timestamp"') || NO_CUTOFF.test(f)) return [];
          const sorts = w23aSortsOf(options);
          if (isDeepStrictEqual(sorts, RECEIPT_DATED_SORTS)) return datedRows;
          if (isDeepStrictEqual(sorts, RECEIPT_ID_SORTS)) return undatedRows;
          return [];
        },
      ],
    ];
  });
  const receiptQueries = world.client.queries.filter((q) => q.dataSourceId === receiptsDs);
  return { ...world, receiptsDs, receiptQueries };
}

test("PT-CP-013/a W2.3-RECEIPTS-1: Recent Receipts are verified, newest first then undated by Receipt ID, no day cutoff, with related logical IDs", async () => {
  const { sources, sourceOf, receiptQueries } = await receiptsWorld(
    [
      { id: 2, at: "2026-09-28T18:00:00.000Z", task: "own", account: "own", contact: "own" },
      { id: 4, at: "2026-09-10T09:00:00.000Z", task: "own" },
      // Ten months old: "recent" is the newest of the stream, never a window of days.
      { id: 1, at: "2025-11-02T08:00:00.000Z" },
    ],
    [
      { id: 3, at: null, account: "own" },
      { id: 5, at: null },
    ],
  );

  assert.equal(receiptQueries.length, 2, "one dated and one undated verified selection");
  const [datedQ, undatedQ] = receiptQueries;
  assert.ok(datedQ && undatedQ);
  assert.deepEqual(w23aSortsOf(datedQ.options), RECEIPT_DATED_SORTS, "dated phase first, newest Event Timestamp first");
  assert.deepEqual(w23aSortsOf(undatedQ.options), RECEIPT_ID_SORTS, "undated phase last, Receipt ID only");
  assert.equal(w23aPageSizeOf(datedQ.options), 11);
  for (const q of receiptQueries) {
    const f = JSON.stringify(q.filter);
    assert.match(f, /"Verified"/, "each phase asks Verified");
    assert.match(f, /"Event Timestamp"/, "each phase conditions on Event Timestamp presence");
    assert.doesNotMatch(f, NO_CUTOFF, "no day cutoff");
    const size = w23aPageSizeOf(q.options);
    assert.ok(typeof size === "number" && size >= 1 && size <= 11, `page_size ${String(size)} <= 11`);
    assert.ok(q.cursor === undefined || q.cursor === null, "no continuation query");
  }

  const receipts = sourceOf(DAILY_SOURCE_KEYS.RECENT_RECEIPTS);
  assert.equal(receipts.status, "PRESENT");
  assert.deepEqual(w23aIds(receipts, "receipt_id"), ["2", "4", "1", "3", "5"]);
  const rows = receipts.rows as Array<Record<string, unknown>>;
  for (const r of rows) {
    for (const key of Object.keys(r)) assert.ok(RECEIPT_KEYS.includes(key), `receipt carries only canon keys, not ${key}`);
  }
  const related = (r: Record<string, unknown>) => ({ task_id: r.task_id, account_id: r.account_id, contact_id: r.contact_id });
  assert.deepEqual(related(rows[0]!), { task_id: "21", account_id: "7", contact_id: "9" }, "each relation yields its logical ID");
  // Zero related pages omit the key altogether.
  assert.deepEqual(Object.keys(rows[1]!).filter((k) => k.endsWith("_id") && k !== "receipt_id"), ["task_id"]);
  assert.equal(rows[1]!.task_id, "21");
  assert.deepEqual(Object.keys(rows[2]!).filter((k) => k.endsWith("_id") && k !== "receipt_id"), []);
  assert.deepEqual(Object.keys(rows[3]!).filter((k) => k.endsWith("_id") && k !== "receipt_id"), ["account_id"]);
  assert.equal(rows[3]!.account_id, "7");

  const section = await dailySection(sources, DAILY_SOURCE_KEYS.RECENT_RECEIPTS);
  assert.equal(section.source_status, "PRESENT");
  assert.equal(section.available, 5);
  assert.equal(section.served, 5);
  assert.equal(section.omitted, 0);
});

test("PT-CP-013/a W2.3-RECEIPTS-2: a foreign, duplicated or missing related page makes Recent Receipts ABSENT", async () => {
  const at = "2026-09-20T10:00:00.000Z";
  const cases: ReadonlyArray<readonly [string, ReceiptSpec]> = [
    ["foreign Account parent", { id: 2, at, task: "own", account: "foreign" }],
    ["foreign Task parent", { id: 2, at, task: "foreign" }],
    ["foreign Contact parent", { id: 2, at, contact: "foreign" }],
    ["two related Accounts", { id: 2, at, account: "two" }],
    ["missing related Contact", { id: 2, at, contact: "missing" }],
  ];
  for (const [label, spec] of cases) {
    const { sourceOf, receiptQueries } = await receiptsWorld([{ id: 1, at: "2026-09-25T10:00:00.000Z", task: "own" }, spec], []);
    assert.ok(receiptQueries.length >= 1, `${label}: Receipts is queried`);
    const receipts = sourceOf(DAILY_SOURCE_KEYS.RECENT_RECEIPTS);
    assert.equal(receipts.status, "ABSENT", label);
    assert.deepEqual(receipts.rows, [], label);
  }
});

// ── UNPROCESSED_INTAKE ──

const INTAKE_STATUSES = ["RECEIVED", "INSPECTED", "NEEDS_MAPPING", "MAPPED", "RECONCILED", "HOLD"];
const INTAKE_DATED_SORTS = [w23aSort("Received At"), w23aSort("Intake ID")];
const INTAKE_ID_SORTS = [w23aSort("Intake ID")];
const INTAKE_KEYS = ["intake_id", "intake", "status", "received_at", "source_type", "human_required", "target"];
const statusesAsked = (filter: unknown): string[] =>
  [...JSON.stringify(filter).matchAll(/"equals":"([^"]*)"/g)].map((m) => m[1]!).sort();

interface IntakeSpec {
  readonly id: number;
  readonly at: string | null;
  readonly status: string;
}

/**
 * Intake answered only for exactly the six unprocessed statuses with a Received At condition: `dated` for Received At
 * then Intake ID, `undated` for Intake ID alone, each already in server order.
 */
async function intakeWorld(dated: readonly IntakeSpec[], undated: readonly IntakeSpec[], timeType: "date" | "created_time" | "last_edited_time" | "rich_text" = "date") {
  let intakeDs = "";
  const world = await sectionWorld((map, root) => {
    const intake = installDailyTable(map, root, "04 — DATA & EVIDENCE", "Intake", {
      Intake: { type: "title" },
      Status: { type: "select" },
      "Received At": { type: timeType },
      "Intake ID": { type: "unique_id" },
      "Source Type": { type: "select" },
      "Human Required": { type: "checkbox" },
      Target: { type: "rich_text" },
    });
    intakeDs = intake.ds;
    const page = (s: IntakeSpec) =>
      w23aPage(intake.ds, `w23a-intake-${s.id}`, {
        Intake: { type: "title", title: rich(`Intake ${s.id}`) },
        Status: { type: "select", select: { name: s.status } },
        "Received At": timeType === "date"
          ? { type: "date", date: s.at === null ? null : { start: s.at, end: null, time_zone: null } }
          : { type: timeType, [timeType]: s.at },
        "Intake ID": w23aUid(s.id),
        "Source Type": { type: "select", select: { name: "CSV" } },
        "Human Required": { type: "checkbox", checkbox: false },
        Target: { type: "rich_text", rich_text: rich("Accounts") },
      });
    const datedRows = dated.map(page);
    const undatedRows = undated.map(page);
    return [
      [
        intake.ds,
        (filter, options) => {
          if (!isDeepStrictEqual(statusesAsked(filter), [...INTAKE_STATUSES].sort())) return [];
          if (timeType === "date" && !JSON.stringify(filter).includes('"Received At"')) return [];
          const sorts = w23aSortsOf(options);
          if (isDeepStrictEqual(sorts, INTAKE_DATED_SORTS)) return datedRows;
          if (isDeepStrictEqual(sorts, INTAKE_ID_SORTS)) return undatedRows;
          return [];
        },
      ],
    ];
  });
  const intakeQueries = world.client.queries.filter((q) => q.dataSourceId === intakeDs);
  return { ...world, intakeDs, intakeQueries };
}

test("PT-CP-013/a W5.1I: system Intake creation instants are served without timezone or date-presence filters", async () => {
  const specs: IntakeSpec[] = [
    { id: 1, at: "2026-10-07T09:00:00.000Z", status: "RECEIVED" },
    { id: 2, at: "2026-10-07T09:00:00.000Z", status: "HOLD" },
    { id: 3, at: "2026-10-07T11:01:00.000+02:00", status: "INSPECTED" },
  ];
  const { sourceOf, intakeQueries, sources } = await intakeWorld(specs, [], "created_time");
  const intake = sourceOf(DAILY_SOURCE_KEYS.UNPROCESSED_INTAKE);
  assert.equal(intake.status, "PRESENT");
  assert.deepEqual(w23aIds(intake, "intake_id"), ["1", "2", "3"]);
  assert.deepEqual(w23aIds(intake, "received_at"), specs.map(s => s.at), "raw creation instant is not rewritten");
  assert.equal(intakeQueries.length, 1, "one full bounded server selection, no undated phase");
  const q = intakeQueries[0]!;
  assert.deepEqual(statusesAsked(q.filter), [...INTAKE_STATUSES].sort());
  assert.deepEqual(q.filter, { or: INTAKE_STATUSES.map(s => ({ property: "Status", select: { equals: s } })) });
  assert.deepEqual(w23aSortsOf(q.options), INTAKE_DATED_SORTS);
  assert.equal(w23aPageSizeOf(q.options), 11);
  assert.equal(sourceOf(DAILY_SOURCE_KEYS.RUNTIME_CONSTRAINTS).status, "ABSENT", "no confirmed timezone in this world");
  for (const row of intake.rows as Array<Record<string, unknown>>) assert.deepEqual(Object.keys(row).sort(), [...INTAKE_KEYS].sort());
  assert.equal((await dailySection(sources, DAILY_SOURCE_KEYS.UNPROCESSED_INTAKE)).served, 3);
});

test("PT-CP-013/a W5.1I: missing/invalid creation time, unprocessed violation, instant or ID inversion refuse the entire source", async () => {
  const good: IntakeSpec = { id: 1, at: "2026-10-07T09:00:00.000Z", status: "RECEIVED" };
  const cases: ReadonlyArray<readonly [string, readonly IntakeSpec[]]> = [
    ["missing", [{ ...good, at: null }]],
    ["empty", [{ ...good, at: "" }]],
    ["invalid", [{ ...good, at: "not-an-instant" }]],
    ["bare day", [{ ...good, at: "2026-10-07" }]],
    ["offsetless", [{ ...good, at: "2026-10-07T09:00:00" }]],
    ["processed", [{ ...good, status: "INGESTED" }]],
    ["tie inversion", [{ ...good, id: 2 }, good]],
    ["duplicate ID", [good, { ...good, at: "2026-10-07T09:01:00.000Z" }]],
    ["instant inversion", [good, { ...good, id: 2, at: "2026-10-07T10:59:00.000+02:00" }]],
    ["nonpositive ID", [{ ...good, id: 0 }]],
  ];
  for (const [label, specs] of cases) {
    const { sourceOf, intakeQueries } = await intakeWorld(specs, [], "created_time");
    assert.equal(sourceOf(DAILY_SOURCE_KEYS.UNPROCESSED_INTAKE).status, "ABSENT", label);
    assert.deepEqual(sourceOf(DAILY_SOURCE_KEYS.UNPROCESSED_INTAKE).rows, [], label);
    assert.equal(intakeQueries.length, 1, `${label}: no replacement read`);
  }
  for (const type of ["last_edited_time", "rich_text"] as const) {
    const { sourceOf, intakeQueries } = await intakeWorld([good], [], type);
    assert.equal(sourceOf(DAILY_SOURCE_KEYS.UNPROCESSED_INTAKE).status, "ABSENT", type);
    assert.equal(intakeQueries.length, 0, `${type}: incompatible schema refused before query`);
  }
});

test("PT-CP-013/a W5.1I: creation-time Intake retains the eleven-read/ten-served window", async () => {
  const rows = Array.from({ length: 11 }, (_, i) => ({ id: i + 1, at: "2026-10-07T09:00:00.000Z", status: INTAKE_STATUSES[i % INTAKE_STATUSES.length]! }));
  const { sources, intakeQueries } = await intakeWorld(rows, [], "created_time");
  const section = await dailySection(sources, DAILY_SOURCE_KEYS.UNPROCESSED_INTAKE);
  assert.equal(intakeQueries.length, 1);
  assert.equal(section.source_status, "PRESENT");
  assert.equal(section.available, 11);
  assert.equal(section.served, 10);
  assert.equal(section.omitted, 1);
});

test("PT-CP-013/a W2.3-INTAKE-1: Unprocessed Intake asks exactly the six statuses, Received At ascending then undated, by Intake ID", async () => {
  const { sources, sourceOf, intakeQueries } = await intakeWorld(
    [
      { id: 4, at: "2026-09-01", status: "RECEIVED" },
      { id: 2, at: "2026-09-15", status: "HOLD" },
      { id: 7, at: "2026-09-15", status: "MAPPED" },
    ],
    [
      { id: 1, at: null, status: "NEEDS_MAPPING" },
      { id: 3, at: null, status: "INSPECTED" },
      { id: 9, at: null, status: "RECONCILED" },
    ],
  );

  assert.equal(intakeQueries.length, 2, "one dated and one undated unprocessed selection");
  const [datedQ, undatedQ] = intakeQueries;
  assert.ok(datedQ && undatedQ);
  assert.deepEqual(w23aSortsOf(datedQ.options), INTAKE_DATED_SORTS, "dated phase first, Received At then Intake ID");
  assert.deepEqual(w23aSortsOf(undatedQ.options), INTAKE_ID_SORTS, "undated phase last, Intake ID only");
  assert.equal(w23aPageSizeOf(datedQ.options), 11);
  for (const q of intakeQueries) {
    assert.deepEqual(statusesAsked(q.filter), [...INTAKE_STATUSES].sort(), "exactly the six unprocessed statuses");
    assert.match(JSON.stringify(q.filter), /"Received At"/, "each phase conditions on Received At presence");
    const size = w23aPageSizeOf(q.options);
    assert.ok(typeof size === "number" && size >= 1 && size <= 11, `page_size ${String(size)} <= 11`);
    assert.ok(q.cursor === undefined || q.cursor === null, "no continuation query");
  }

  const intake = sourceOf(DAILY_SOURCE_KEYS.UNPROCESSED_INTAKE);
  assert.equal(intake.status, "PRESENT");
  assert.deepEqual(w23aIds(intake, "intake_id"), ["4", "2", "7", "1", "3", "9"]);
  assert.deepEqual(w23aIds(intake, "status"), ["RECEIVED", "HOLD", "MAPPED", "NEEDS_MAPPING", "INSPECTED", "RECONCILED"]);
  const rows = intake.rows as Array<Record<string, unknown>>;
  for (const r of rows) {
    for (const key of Object.keys(r)) assert.ok(INTAKE_KEYS.includes(key), `intake carries only canon keys, not ${key}`);
  }
  const first = rows[0]!;
  assert.deepEqual(Object.keys(first).sort(), [...INTAKE_KEYS].sort(), "a complete dated row projects every canon key");
  assert.equal(first.intake, "Intake 4");

  const section = await dailySection(sources, DAILY_SOURCE_KEYS.UNPROCESSED_INTAKE);
  assert.equal(section.source_status, "PRESENT");
  assert.equal(section.available, 6);
  assert.equal(section.served, 6);
  assert.equal(section.omitted, 0);
});

test("PT-CP-013/a W2.3-INTAKE-2: a returned processed status or out-of-order row makes Unprocessed Intake ABSENT", async () => {
  const cases: ReadonlyArray<readonly [string, readonly IntakeSpec[], readonly IntakeSpec[]]> = [
    ["processed status returned", [{ id: 1, at: "2026-09-01", status: "RECEIVED" }, { id: 2, at: "2026-09-02", status: "PROCESSED" }], []],
    ["undated processed status returned", [], [{ id: 1, at: null, status: "DONE" }]],
    ["dated out of order", [{ id: 1, at: "2026-09-10", status: "RECEIVED" }, { id: 2, at: "2026-09-01", status: "HOLD" }], []],
  ];
  for (const [label, dated, undated] of cases) {
    const { sourceOf } = await intakeWorld(dated, undated);
    const intake = sourceOf(DAILY_SOURCE_KEYS.UNPROCESSED_INTAKE);
    assert.equal(intake.status, "ABSENT", label);
    assert.deepEqual(intake.rows, [], label);
  }
});

// ─────────────────────────────── W2.3 transport smoke: real os_resume, CURRENT_WORK ───────────────────────────────

test("PT-CP-013 W2.3 transport: os_resume CURRENT_WORK serves DAILY's 14 sources; the same fixture still serves only SETUP for SALES_SETUP_INPUTS", async () => {
  const bag = (e: Envelope): Record<string, unknown> => (e.status === "OK" ? (e.result as Record<string, unknown>) : e.observations);
  const packOf = (e: Envelope): ContractPack => bag(e)["contract_pack"] as ContractPack;
  const evidenceOf = (e: Envelope) => JSON.stringify((e as { evidence?: unknown }).evidence ?? e.warnings);

  // A clean, proved B5 SALES fixture: B0 → B4 answered and proved, then bound.
  const sw = buildSetupWorld("B5_OUTREACH", 5);
  const bound = await bindSales(sw);
  await proveRows(sw, bound, STEPS.slice(0, 5).map((s) => answerRow(BC("rep-a").ds, s)));
  sw.client.reset();

  // ── CURRENT_WORK through the real transport ──
  const daily = await resume(sw, bound.handle, "CURRENT_WORK");
  assert.equal(daily.code, "RESUMED", evidenceOf(daily));
  const dp = packOf(daily);
  assert.deepEqual(dp.normalized_needs, ["CURRENT_WORK"]);
  assert.deepEqual([dp.completeness, dp.completeness_reason], ["COMPLETE", "NONE"]);
  assert.deepEqual(dp.selected_pointers, []);

  const sc = dp.selected_context;
  assert.deepEqual(sc.contexts.map((c) => c.context), ["DAILY"], "DAILY only, no extra context");
  const sections = sc.contexts[0]!.sections;
  assert.deepEqual(sections.map((s) => s.source_key), Object.values(DAILY_SOURCE_KEYS), "the 14 sources in published order");

  const native = sections.find((s) => s.source_key === "DAILY_NATIVE_REALITY");
  assert.ok(native, "DAILY_NATIVE_REALITY is served");
  assert.equal(native.source_status, "PRESENT");
  assert.deepEqual(native.items, [
    { source: "GMAIL", authority: "GMAIL", read_first: true },
    { source: "HUMAN_ACTIONS", authority: "HUMAN_ACTIONS", read_first: true },
  ]);

  const holds = sections.find((s) => s.source_key === "DAILY_HOLDS");
  assert.ok(holds, "DAILY_HOLDS is served");
  assert.equal(holds.source_status, "PRESENT");

  // The fixture carries none of the other daily tables: each of the 12 is ABSENT on its own, nothing served.
  const others = sections.filter((s) => s.source_key !== "DAILY_NATIVE_REALITY" && s.source_key !== "DAILY_HOLDS");
  assert.equal(others.length, 12);
  for (const s of others) {
    assert.equal(s.source_status, "ABSENT", s.source_key);
    assert.deepEqual([s.items, s.served], [[], 0], s.source_key);
  }

  // Native sources are named, never copied; no cursor anywhere; no SETUP value crosses into DAILY.
  const keysOf = (v: unknown): string[] =>
    v !== null && typeof v === "object"
      ? Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => [k, ...keysOf(x)])
      : [];
  for (const key of keysOf(sc)) {
    assert.doesNotMatch(key, /content|e[-_]?mail|auto[-_]?reply|subject|body|snippet|message/i, `selected_context carries ${key}`);
    assert.doesNotMatch(key, /cursor|has_more/i, `selected_context carries ${key}`);
  }
  const served = JSON.stringify(sc);
  assert.equal(served.includes("SENTINEL"), false, "no SETUP content without the need");
  for (const step of STEPS.slice(0, 5)) assert.equal(served.includes(step.value), false, step.gate);

  // ── Same fixture, SALES_SETUP_INPUTS: SETUP only, as PT-CP-012 expects ──
  const setup = await resume(sw, bound.handle, "SALES_SETUP_INPUTS");
  assert.equal(setup.code, "RESUMED", evidenceOf(setup));
  const sp = packOf(setup);
  assert.deepEqual(sp.normalized_needs, ["SALES_SETUP_INPUTS"]);
  assert.deepEqual([sp.completeness, sp.completeness_reason], ["COMPLETE", "NONE"]);
  assert.deepEqual(sp.selected_pointers, []);
  assert.deepEqual(sp.selected_context.contexts.map((c) => c.context), ["SETUP"], "no DAILY without CURRENT_WORK");
  const setupSections = sp.selected_context.contexts[0]!.sections;
  const itemsOf = (key: string) => setupSections.find((s) => s.section_key === key)?.items;
  assert.deepEqual(
    setupSections.map((s) => [s.section_key, s.source_status]),
    ["SETUP_POSITION", "SETUP_PENDING_INPUT", "SETUP_RULES", "SETUP_ANSWERS"].map((k) => [k, "PRESENT"]),
  );
  assert.deepEqual(itemsOf("SETUP_PENDING_INPUT"), [
    { gate_key: "B5_OUTREACH", logical_resource_key: CONFIG, natural_key: "B5_OUTREACH:SEQUENCE", answer_field: "Value" },
  ]);
  assert.deepEqual(itemsOf("SETUP_RULES"), [itemOf(stepOf("B4_QUALIFICATION"))]);
  assert.deepEqual(itemsOf("SETUP_ANSWERS"), ["B0_DISCOVERY", "B1_OFFER", "B2_ICP", "B3_DATA"].map((g) => itemOf(stepOf(g))));
  const setupServed = JSON.stringify(sp.selected_context);
  for (const key of Object.values(DAILY_SOURCE_KEYS)) assert.equal(setupServed.includes(key), false, `no ${key} in SETUP`);

  // One derived state, two needs: same state_fingerprint, distinct pack_id (PT-CP-012/n).
  assert.equal(dp.state_fingerprint, sp.state_fingerprint);
  assert.notEqual(dp.pack_id, sp.pack_id);
});

test("PT-CP-013/p: DAILY_P0_RULES is ABSENT when pagination is unprovable, PRESENT on an explicit empty end", async () => {
  const cases: ReadonlyArray<readonly [string, (q: Record<string, unknown>) => Record<string, unknown>, "PRESENT" | "ABSENT"]> = [
    ["explicit end, null cursor (control)", (q) => ({ ...q, has_more: false, next_cursor: null }), "PRESENT"],
    ["missing has_more", (q) => { const { has_more: _drop, ...rest } = q; return { ...rest, next_cursor: null }; }, "ABSENT"],
    ["non-boolean has_more", (q) => ({ ...q, has_more: "false", next_cursor: null }), "ABSENT"],
    ["has_more=false with a cursor", (q) => ({ ...q, has_more: false, next_cursor: "cursor-1" }), "ABSENT"],
  ];
  for (const [name, mangle, expected] of cases) {
    const sw = buildSetupWorld("B5_OUTREACH", 5);
    const runtime = await runtimeOf(sw);
    const { ds } = installDailyTable(sw.w.map, runtime.root_ref, "03 — CONTROL PLANE", "Decision Rules", {
      Active: { type: "checkbox" },
      Priority: { type: "select" },
      "Rule ID": { type: "unique_id" },
      Rule: { type: "title" },
    });
    const client = new DailyClient(sw.w.map);
    client.queryHandlers.set(ds, () => []);
    // Wrapper fake: delegate to the real fake, then rewrite the pagination of the Decision Rules responses only.
    const inner = client.queryDataSource.bind(client);
    (client as unknown as { queryDataSource: (...a: Parameters<typeof inner>) => Promise<unknown> }).queryDataSource = async (...args) => {
      const q = (await inner(...args)) as Record<string, unknown>;
      return args[0] === ds ? mangle(q) : q;
    };

    const sources = await readDailySources(
      client,
      runtime,
      "SALES",
      ["CURRENT_WORK"],
      { effective_hold: "NONE", next_safe_action: "Continue" },
      new Date("2026-09-28T12:00:00Z"),
    );
    const p0 = sources.find((s) => s.source_key === "DAILY_P0_RULES");
    assert.ok(p0, `${name}: DAILY_P0_RULES is supplied`);
    assert.equal(p0.status, expected, name);
    assert.deepEqual(p0.rows, [], name);
    assert.ok(client.queries.some((q) => q.dataSourceId === ds), `${name}: Decision Rules is queried`);
  }
});

test("PT-CP-013 transport: os_resume CURRENT_WORK serves P0 rules, active policies and runtime constraints PRESENT with exact projections", async () => {
  const CONFIRMED = { property: "State", select: { equals: "CONFIRMED" } };
  const CONSTRAINT_TYPES = {
    or: [
      { property: "Type", select: { equals: "LOCAL_CONSTRAINT" } },
      { property: "Type", select: { equals: "PRODUCTION_CONTRACT_POINTER" } },
    ],
  };
  const sw = buildSetupWorld("B5_OUTREACH", 5);
  const bound = await bindSales(sw);
  await proveRows(sw, bound, STEPS.slice(0, 5).map((s) => answerRow(BC("rep-a").ds, s)));
  const runtime = await runtimeOf(sw);
  const map = sw.w.map;

  // ── Runtime Configuration: TIMEZONE + one confirmed LOCAL_CONSTRAINT without pointer ──
  const config = installDailyTable(map, runtime.root_ref, "02 — SETUP & BUSINESS CONFIG", "Runtime Configuration", {
    Config: { type: "title" },
    Type: { type: "select" },
    State: { type: "select" },
    Value: { type: "rich_text" },
    "Config ID": { type: "unique_id" },
    "Effective At": { type: "date" },
    "Pointer Resource Key": { type: "rich_text" },
    "Pointer Natural Key": { type: "rich_text" },
    "Pointer Value Field": { type: "rich_text" },
  });
  const cell = (s: string) => ({ type: "rich_text", rich_text: s === "" ? [] : rich(s) });
  const configRow = (n: number, name: string, value: string) => ({
    object: "page", id: synthetic(`w23t-config-${n}`), parent: { type: "data_source_id", data_source_id: config.ds }, archived: false,
    properties: {
      Config: { type: "title", title: rich(name) },
      Type: { type: "select", select: { name: "LOCAL_CONSTRAINT" } },
      State: { type: "select", select: { name: "CONFIRMED" } },
      Value: cell(value),
      "Config ID": { type: "unique_id", unique_id: { prefix: null, number: n } },
      "Effective At": { type: "date", date: null },
      "Pointer Resource Key": cell(""),
      "Pointer Natural Key": cell(""),
      "Pointer Value Field": cell(""),
    },
  }) as unknown as Page;
  const timezoneRow = configRow(1, "TIMEZONE", "Europe/Paris");
  const constraintRow = configRow(2, "MAX_DAILY_SENDS", "25");

  // ── Active Policies index + this runtime's own Policy Changes ──
  const policies = installDailyTable(map, runtime.root_ref, "01 — CONSTITUTION & POLICIES", "Active Policies", {
    "Policy Key": { type: "rich_text" },
    State: { type: "select" },
    "Effective At": { type: "date" },
    "Approved Change": { type: "url" },
    "Policy Text": { type: "rich_text" },
  });
  const changes = installDailyTable(map, runtime.root_ref, "01 — CONSTITUTION & POLICIES", "Policy Changes", {
    Change: { type: "title" },
    Status: { type: "select" },
    "Human Approved": { type: "checkbox" },
  });
  const changeId = synthetic("w23t-policy-change");
  map.set(`page:${changeId}`, {
    object: "page", id: changeId, parent: { type: "data_source_id", data_source_id: changes.ds }, archived: false,
    properties: {
      Change: { type: "title", title: rich("Adopt weekday outreach") },
      Status: { type: "select", select: { name: "APPLIED" } },
      "Human Approved": { type: "checkbox", checkbox: true },
    },
  });
  const policyRow = {
    object: "page", id: synthetic("w23t-policy-row"), parent: { type: "data_source_id", data_source_id: policies.ds }, archived: false,
    properties: {
      "Policy Key": { type: "rich_text", rich_text: rich("OUTREACH_WINDOW") },
      State: { type: "select", select: { name: "ACTIVE" } },
      "Effective At": { type: "date", date: { start: "2029-01-01" } },
      "Approved Change": { type: "url", url: `https://www.notion.so/Policy-change-${changeId}` },
      "Policy Text": { type: "rich_text", rich_text: rich("Send outreach on weekdays only") },
    },
  } as unknown as Page;

  // ── Decision Rules: one active P0 ──
  const rules = installDailyTable(map, runtime.root_ref, "03 — CONTROL PLANE", "Decision Rules", {
    Active: { type: "checkbox" },
    Priority: { type: "select" },
    "Rule ID": { type: "unique_id" },
    Rule: { type: "title" },
  });
  const p0Rule = {
    object: "page", id: synthetic("w23t-p0-rule"), parent: { type: "data_source_id", data_source_id: rules.ds }, archived: false,
    properties: {
      Active: { type: "checkbox", checkbox: true },
      Priority: { type: "select", select: { name: "P0" } },
      "Rule ID": { type: "unique_id", unique_id: { prefix: null, number: 1 } },
      Rule: { type: "title", title: rich("Pause outreach on bounce spike") },
    },
  } as unknown as Page;

  // ── Hybrid reader: daily data sources through DailyClient's handlers, everything else through the SETUP client ──
  const daily = new DailyClient(map);
  daily.queryHandlers.set(config.ds, (filter) => {
    if (isDeepStrictEqual(filter, TIMEZONE_FILTER)) return [timezoneRow];
    const and = (filter as { and?: unknown[] } | null)?.and;
    return Array.isArray(and) && isDeepStrictEqual(and[0], CONFIRMED) && isDeepStrictEqual(and[1], CONSTRAINT_TYPES)
      ? [timezoneRow, constraintRow]
      : [];
  });
  daily.queryHandlers.set(policies.ds, (filter) => (isDeepStrictEqual(filter, ACTIVE_FILTER) ? [policyRow] : []));
  daily.queryHandlers.set(rules.ds, (filter) => (JSON.stringify(filter).includes("P0") ? [p0Rule] : []));

  const queried: string[] = [];
  const touched = new Set<PropertyKey>();
  const setupClient = sw.client as unknown as Record<PropertyKey, unknown>;
  const hybrid = new Proxy(setupClient, {
    get(t, p, r) {
      touched.add(p);
      if (p === "queryDataSource") {
        return (ds: string, filter: unknown, cursor?: string, options?: unknown) => {
          queried.push(ds);
          return daily.queryHandlers.has(ds)
            ? daily.queryDataSource(ds, filter, cursor, options as never)
            : (t.queryDataSource as (...a: unknown[]) => Promise<unknown>).call(t, ds, filter, cursor, options);
        };
      }
      const v = Reflect.get(t, p, r);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  (sw.deps as { notion: unknown }).notion = hybrid;
  sw.client.reset();
  const mapBefore = JSON.stringify([...map.entries()]);

  const env = await resume(sw, bound.handle, "CURRENT_WORK");
  const bag = (e: Envelope): Record<string, unknown> => (e.status === "OK" ? (e.result as Record<string, unknown>) : e.observations);
  assert.equal(env.code, "RESUMED", JSON.stringify((env as { evidence?: unknown }).evidence ?? env.warnings));
  const pack = bag(env)["contract_pack"] as ContractPack;
  const sc = pack.selected_context;

  // Selected context: DAILY only.
  assert.equal(sc.contexts.length, 1);
  assert.equal(sc.contexts[0]!.context, "DAILY");
  const sections = sc.contexts[0]!.sections;

  // 14 daily source keys, in catalog order.
  const dailyKeys = Object.values(DAILY_SOURCE_KEYS);
  assert.equal(dailyKeys.length, 14);
  assert.deepEqual(sections.map((s) => s.source_key), dailyKeys);

  // The three critical sections are PRESENT with exact item projections (other sections may also be PRESENT).
  const expectedP0 = [{ rule_id: "1", rule: "Pause outreach on bounce spike" }];
  const expectedPolicies = [
    { policy_key: "OUTREACH_WINDOW", policy_text: "Send outreach on weekdays only", effective_at: "2029-01-01" },
  ];
  const noPointer = { pointer_resource_key: "", pointer_natural_key: "", pointer_value_field: "", reread_status: "NO_POINTER" };
  const expectedConstraints = [
    { config: "TIMEZONE", type: "LOCAL_CONSTRAINT", declared_value: "Europe/Paris", ...noPointer },
    { config: "MAX_DAILY_SENDS", type: "LOCAL_CONSTRAINT", declared_value: "25", ...noPointer },
  ];
  for (const [key, expected] of [
    [DAILY_SOURCE_KEYS.P0_RULES, expectedP0],
    [DAILY_SOURCE_KEYS.ACTIVE_POLICIES, expectedPolicies],
    [DAILY_SOURCE_KEYS.RUNTIME_CONSTRAINTS, expectedConstraints],
  ] as const) {
    const section = sections.find((s) => s.source_key === key);
    assert.ok(section, key);
    assert.equal(section.source_status, "PRESENT", JSON.stringify(section));
    assert.deepEqual((section as { items?: unknown }).items, expected, key);
  }

  // No pagination leakage, no SETUP answer markers.
  assert.doesNotMatch(JSON.stringify(sc), /cursor|has_more/);
  assert.ok(!JSON.stringify(sc).includes("SENTINEL-"));

  // Read-only: no write-like client member touched, map unchanged.
  assert.deepEqual([...touched].filter((p) => typeof p === "string" && WRITE_LIKE.test(p)), []);
  assert.equal(JSON.stringify([...map.entries()]), mapBefore);

  // The three daily data sources were actually queried.
  for (const ds of [config.ds, policies.ds, rules.ds]) assert.ok(queried.includes(ds), ds);
});
