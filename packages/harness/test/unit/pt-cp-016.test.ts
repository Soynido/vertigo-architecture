import { test } from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

import { CONTEXT_KINDS, CONTEXT_SECTIONS, DAILY_SOURCE_KEYS } from "../../src/contractPack/catalog.ts";
import type { ContextItem, ContractPack } from "../../src/contractPack/pack.ts";
import type { Page } from "../../src/notion/shapes.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import {
  answerRow, BC, bindSales, buildSetupWorld, nextActionOf, nextQuestionOf, proveRows, resume, runtimeOf, STEPS,
} from "./pt-cp-012.fixtures.ts";
import { DailyClient, installDailyTable } from "./pt-cp-013.fixtures.ts";
import { synthetic } from "./meta-fixtures.ts";

// ─────────────────────────────── PT-CP-016 (W2.6): « on fait quoi ? » on a daily fixture ───────────────────────────────

/** The seller's own question, free text: it is presentation, normalized to CURRENT_WORK, and never served back. */
const QUESTION = "on fait quoi ?";
const GATE = "B5_OUTREACH";
const ZONE = "Europe/Paris";
/** ctx.now is T0 = 2030-01-01T00:00:00.000Z: 01:00 on the 1st in Paris, so civil today there is the 1st. */
const TODAY = "2030-01-01";
const NOW_ISO = "2030-01-01T00:00:00.000Z";
const BLOCKER = "PT-CP-016 open blocker on the durable cursor";
/** A column the seller added to their own space: tolerated by being ignored, never served. */
const NOTE_MARK = "PT-CP-016 NONPROJECTED note";

const WRITE_LIKE = /create|update|append|delete|archive|patch|write|insert|move|restore/i;
const rich = (s: string) => [{ type: "text", plain_text: s }];
const uid = (number: number) => ({ type: "unique_id", unique_id: { prefix: null, number } });
const relation = (id?: string) => ({ type: "relation", relation: id ? [{ id }] : [], has_more: false });
const day = (start: string) => ({ type: "date", date: { start, end: null, time_zone: null } });
const pageIn = (ds: string, seed: string, properties: Record<string, unknown>): Page =>
  ({ object: "page", id: synthetic(seed), parent: { type: "data_source_id", data_source_id: ds }, archived: false, properties }) as unknown as Page;
const asc = (property: string) => ({ property, direction: "ascending" });

// The exact server selections a DAILY read may send for this fixture, as the contract publishes them.
const TIMEZONE_FILTER = { property: "Config", title: { equals: "TIMEZONE" } };
const CONSTRAINTS_FILTER = {
  and: [
    { property: "State", select: { equals: "CONFIRMED" } },
    { or: [{ property: "Type", select: { equals: "LOCAL_CONSTRAINT" } }, { property: "Type", select: { equals: "PRODUCTION_CONTRACT_POINTER" } }] },
  ],
};
const BLOCKED = { property: "Status", select: { equals: "BLOCKED" } };
const BLOCKED_DATED_FILTER = { and: [BLOCKED, { property: "Due Date", date: { is_not_empty: true } }] };
const BLOCKED_UNDATED_FILTER = { and: [BLOCKED, { property: "Due Date", date: { is_empty: true } }] };
const DUE_FILTER = {
  and: [
    { or: [{ property: "Status", select: { equals: "READY" } }, { property: "Status", select: { equals: "IN_PROGRESS" } }] },
    { or: [{ property: "Due Date", date: { on_or_before: TODAY } }, { property: "Due Date", date: { on_or_before: NOW_ISO } }] },
  ],
};
const SEQUENCE_ACTIVE_FILTER = { property: "Status", select: { equals: "ACTIVE" } };

test("PT-CP-016: « on fait quoi ? » with due Tasks, one hold and one active sequence serves exactly the expected DAILY context, and no other", async () => {
  // ── A clean, proved B5 SALES fixture: B0 → B4 answered and proved, then bound ──
  const sw = buildSetupWorld(GATE, 5);
  const bound = await bindSales(sw);
  await proveRows(sw, bound, STEPS.slice(0, 5).map((s) => answerRow(BC("rep-a").ds, s)));
  const runtime = await runtimeOf(sw);
  const map = sw.w.map;
  const root = runtime.root_ref;

  // ── One hold: an open blocker on the durable cursor (HOLD_UNKNOWN_REQUIRED_FACT), which does not stop os_resume ──
  sw.w.setSalesState({ gate: GATE, buildState: GATE, gateStatus: "OPEN", blocker: BLOCKER, nextAction: nextActionOf(GATE), nextQuestion: nextQuestionOf(GATE) });

  // ── The instance zone: the single confirmed TIMEZONE row ──
  const config = installDailyTable(map, root, "02 — SETUP & BUSINESS CONFIG", "Runtime Configuration", {
    Config: { type: "title" },
    Type: { type: "select" },
    State: { type: "select" },
    Value: { type: "rich_text" },
    "Config ID": { type: "unique_id" },
  });
  const timezoneRow = pageIn(config.ds, "pt-cp-016-timezone", {
    Config: { type: "title", title: rich("TIMEZONE") },
    Type: { type: "select", select: { name: "LOCAL_CONSTRAINT" } },
    State: { type: "select", select: { name: "CONFIRMED" } },
    Value: { type: "rich_text", rich_text: rich(ZONE) },
    "Config ID": uid(1),
  });

  // ── Accounts, Contacts and Sequences of the bound runtime; Tasks relate to each of them ──
  const accounts = installDailyTable(map, root, "04 — DATA & EVIDENCE", "Accounts", { Company: { type: "title" }, "Account ID": { type: "unique_id" } });
  const contacts = installDailyTable(map, root, "04 — DATA & EVIDENCE", "Contacts", { Contact: { type: "title" }, "Contact ID": { type: "unique_id" } });
  const sequences = installDailyTable(map, root, "05 — OPERATIONS & PLAYBOOKS", "Sequences", {
    Sequence: { type: "title" },
    Status: { type: "select" },
    "Sequence ID": { type: "unique_id" },
    "Notes perso": { type: "rich_text" },
  });
  const tasks = installDailyTable(map, root, "03 — CONTROL PLANE", "Tasks", {
    Task: { type: "title" },
    Status: { type: "select" },
    "Due Date": { type: "date" },
    "Task ID": { type: "unique_id" },
    Account: { type: "relation", relation: { data_source_id: accounts.ds } },
    Contact: { type: "relation", relation: { data_source_id: contacts.ds } },
    Sequence: { type: "relation", relation: { data_source_id: sequences.ds } },
    "Notes perso": { type: "rich_text" },
  });

  const account = pageIn(accounts.ds, "pt-cp-016-account-7", { Company: { type: "title", title: rich("Account 7") }, "Account ID": uid(7) });
  const contact = pageIn(contacts.ds, "pt-cp-016-contact-9", { Contact: { type: "title", title: rich("Contact 9") }, "Contact ID": uid(9) });
  const sequence = pageIn(sequences.ds, "pt-cp-016-sequence-3", {
    Sequence: { type: "title", title: rich("Sequence 3") },
    Status: { type: "select", select: { name: "ACTIVE" } },
    "Sequence ID": uid(3),
    "Notes perso": { type: "rich_text", rich_text: rich(NOTE_MARK) },
  });
  for (const p of [account, contact, sequence]) map.set(`page:${p.id}`, p);

  // Two due Tasks, as the server returns them for DUE_FILTER, by Due Date then Task ID: one past, one due today in Paris.
  const task = (n: number, status: string, due: string, links: { account?: string; contact?: string; sequence?: string }) =>
    pageIn(tasks.ds, `pt-cp-016-task-${n}`, {
      Task: { type: "title", title: rich(`Task ${n}`) },
      Status: { type: "select", select: { name: status } },
      "Due Date": day(due),
      "Task ID": uid(n),
      Account: relation(links.account),
      Contact: relation(links.contact),
      Sequence: relation(links.sequence),
      "Notes perso": { type: "rich_text", rich_text: rich(NOTE_MARK) },
    });
  const dueRows = [
    task(1, "IN_PROGRESS", "2029-12-30", { account: account.id }),
    task(2, "READY", TODAY, { account: account.id, contact: contact.id, sequence: sequence.id }),
  ];

  // ── The daily data sources, answered only for their exact contractual selection and order; [] for anything else ──
  const daily = new DailyClient(map);
  const exactly = (filter: unknown, sorts: unknown, rows: readonly Page[]) => (f: unknown, o: unknown) =>
    isDeepStrictEqual(f, filter) && isDeepStrictEqual((o as { sorts?: unknown } | undefined)?.sorts, sorts) ? rows : [];
  daily.queryHandlers.set(config.ds, (f, o) => [...exactly(TIMEZONE_FILTER, [], [timezoneRow])(f, o), ...exactly(CONSTRAINTS_FILTER, [asc("Config ID")], [timezoneRow])(f, o)]);
  daily.queryHandlers.set(tasks.ds, exactly(DUE_FILTER, [asc("Due Date"), asc("Task ID")], dueRows));
  daily.queryHandlers.set(sequences.ds, exactly(SEQUENCE_ACTIVE_FILTER, [asc("Sequence ID")], [sequence]));
  daily.queryHandlers.set(accounts.ds, () => []);
  daily.queryHandlers.set(contacts.ds, () => []);

  // ── Hybrid reader: daily data sources through DailyClient, everything else through the SETUP recording client ──
  const touched = new Set<PropertyKey>();
  const setupClient = sw.client as unknown as Record<PropertyKey, unknown>;
  const hybrid = new Proxy(setupClient, {
    get(t, p, r) {
      touched.add(p);
      if (p === "queryDataSource") {
        return (ds: string, filter: unknown, cursor?: string, options?: unknown) =>
          daily.queryHandlers.has(ds)
            ? daily.queryDataSource(ds, filter, cursor, options as never)
            : (t.queryDataSource as (...a: unknown[]) => Promise<unknown>).call(t, ds, filter, cursor, options);
      }
      const v = Reflect.get(t, p, r);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  (sw.deps as { notion: unknown }).notion = hybrid;
  sw.client.reset();
  const mapBefore = JSON.stringify([...map.entries()]);

  // ── The seller asks « on fait quoi ? » through the real transport ──
  const env: Envelope = await resume(sw, bound.handle, QUESTION);
  assert.equal(env.code, "RESUMED", JSON.stringify((env as { evidence?: unknown }).evidence ?? env.warnings));
  assert.equal(env.status, "OK");
  const result = (env as { result?: unknown }).result as Record<string, unknown>;
  assert.deepEqual(result["effective_hold"], { code: "HOLD_UNKNOWN_REQUIRED_FACT", evidence: [`open blocker: ${BLOCKER}`] });
  assert.equal(result["next_safe_action"], nextActionOf(GATE));
  assert.ok(env.warnings.some((w) => w.startsWith("contract_pack_topic_hint_legacy_text:")), "the free-text question is read as presentation text");

  const pack = result["contract_pack"] as ContractPack;
  assert.deepEqual(pack.requested_needs, []);
  assert.deepEqual(pack.normalized_needs, ["CURRENT_WORK"]);
  assert.deepEqual([pack.completeness, pack.completeness_reason], ["COMPLETE", "NONE"]);
  assert.deepEqual(pack.selected_pointers, []);

  // ── DAILY only: no SETUP, no EXTERNAL_ACTION, and no fourth context exists to be served ──
  assert.deepEqual(CONTEXT_KINDS, ["SETUP", "DAILY", "EXTERNAL_ACTION"]);
  const sc = pack.selected_context;
  assert.deepEqual(sc.contexts.map((c) => c.context), ["DAILY"]);
  assert.equal(sc.bounds.truncated, false);

  // ── Exactly the expected fourteen sections (thirteen W2.3, then W3.4R production health), in the published order ──
  const DAILY_ORDER = [
    "DAILY_NATIVE_REALITY", "DAILY_HOLDS", "DAILY_BLOCKED_TASKS", "DAILY_P0_RULES", "DAILY_ACTIVE_POLICIES",
    "DAILY_RUNTIME_CONSTRAINTS", "DAILY_RECENT_RECEIPTS", "DAILY_UNPROCESSED_INTAKE", "DAILY_DUE_TASKS",
    "DAILY_TASK_ACCOUNTS", "DAILY_TASK_CONTACTS", "DAILY_ACTIVE_RULES", "DAILY_ACTIVE_SEQUENCES",
    "DAILY_PRODUCTION_HEALTH",
  ];
  assert.deepEqual(Object.values(DAILY_SOURCE_KEYS), DAILY_ORDER);
  const PRESENT = (items: readonly ContextItem[]) => ({ source_status: "PRESENT" as const, items });
  const ABSENT = { source_status: "ABSENT" as const, items: [] };
  const expected: Record<string, { source_status: "PRESENT" | "ABSENT"; items: readonly ContextItem[] }> = {
    // Named, never copied: read these first.
    DAILY_NATIVE_REALITY: PRESENT([
      { source: "GMAIL", authority: "GMAIL", read_first: true },
      { source: "HUMAN_ACTIONS", authority: "HUMAN_ACTIONS", read_first: true },
    ]),
    // The one hold, as already derived: its code and the next safe action, never the blocker's evidence.
    DAILY_HOLDS: PRESENT([{ code: "HOLD_UNKNOWN_REQUIRED_FACT", next_safe_action: nextActionOf(GATE) }]),
    // Tasks exist and the server returns no BLOCKED one.
    DAILY_BLOCKED_TASKS: PRESENT([]),
    // No Decision Rules, Active Policies, Receipts or Intake table in this runtime: each is ABSENT on its own.
    DAILY_P0_RULES: ABSENT,
    DAILY_ACTIVE_POLICIES: ABSENT,
    // The TIMEZONE row is itself a confirmed local constraint, without a pointer.
    DAILY_RUNTIME_CONSTRAINTS: PRESENT([{ config: "TIMEZONE", type: "LOCAL_CONSTRAINT", declared_value: ZONE, reread_status: "NO_POINTER" }]),
    DAILY_RECENT_RECEIPTS: ABSENT,
    DAILY_UNPROCESSED_INTAKE: ABSENT,
    DAILY_DUE_TASKS: PRESENT([
      { task_id: "1", task: "Task 1", status: "IN_PROGRESS", due_date: "2029-12-30", account_id: "7" },
      { task_id: "2", task: "Task 2", status: "READY", due_date: TODAY, account_id: "7", contact_id: "9", sequence_id: "3" },
    ]),
    // First hop only, de-duplicated in the order of the due Tasks.
    DAILY_TASK_ACCOUNTS: PRESENT([{ account_id: "7", company: "Account 7" }]),
    DAILY_TASK_CONTACTS: PRESENT([{ contact_id: "9", contact: "Contact 9" }]),
    DAILY_ACTIVE_RULES: ABSENT,
    DAILY_ACTIVE_SEQUENCES: PRESENT([{ sequence_id: "3", sequence: "Sequence 3" }]),
    // This fixture's OS State declares no production health: ABSENT, and no HOLD is added for it.
    DAILY_PRODUCTION_HEALTH: ABSENT,
  };
  const projectedKeysOf = (key: string) => CONTEXT_SECTIONS.DAILY.find((s) => s.source_key === key)?.projected_keys;
  assert.deepEqual(
    sc.contexts[0]!.sections,
    DAILY_ORDER.map((key) => {
      const { source_status, items } = expected[key]!;
      return {
        section_key: key, source_key: key, source_status, projected_keys: projectedKeysOf(key), items,
        served: items.length, available: items.length, omitted: 0, truncated_by: "NONE",
      };
    }),
  );

  // ── Exactly the contractual server selections were sent, each once, from the start, with an 11-row window ──
  const canon = (q: { dataSourceId: string; filter: unknown; cursor: unknown; options: unknown }) =>
    JSON.stringify([q.dataSourceId, q.filter, q.cursor ?? null, q.options]);
  assert.deepEqual(
    daily.queries.map(canon).sort(),
    [
      [config.ds, TIMEZONE_FILTER, null, { sorts: [], page_size: 2 }],
      [config.ds, CONSTRAINTS_FILTER, null, { sorts: [asc("Config ID")], page_size: 11 }],
      [tasks.ds, BLOCKED_DATED_FILTER, null, { sorts: [asc("Due Date"), asc("Task ID")], page_size: 11 }],
      [tasks.ds, BLOCKED_UNDATED_FILTER, null, { sorts: [asc("Task ID")], page_size: 11 }],
      [tasks.ds, DUE_FILTER, null, { sorts: [asc("Due Date"), asc("Task ID")], page_size: 11 }],
      [sequences.ds, SEQUENCE_ACTIVE_FILTER, null, { sorts: [asc("Sequence ID")], page_size: 11 }],
    ].map((q) => JSON.stringify(q)).sort(),
  );
  // Each related page is read directly, once; Accounts and Contacts are never queried.
  const relatedReads = sw.client.reads.filter((r) => r.op === "page" && [account.id, contact.id, sequence.id].includes(r.id)).map((r) => r.id);
  assert.deepEqual([...relatedReads].sort(), [account.id, contact.id, sequence.id].sort());

  // ── Nothing else crosses: no question text, no blocker evidence, no non-projected column, no SETUP answer, no cursor ──
  const served = JSON.stringify(sc);
  for (const mark of [QUESTION, BLOCKER, NOTE_MARK, "SENTINEL-"]) assert.equal(served.includes(mark), false, mark);
  const keysOf = (v: unknown): string[] =>
    v !== null && typeof v === "object" ? Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => [k, ...keysOf(x)]) : [];
  for (const key of keysOf(sc)) assert.doesNotMatch(key, /cursor|has_more/i, `selected_context carries ${key}`);

  // ── Read-only: no write-like client member touched, fixture unchanged ──
  assert.deepEqual([...touched].filter((p) => typeof p === "string" && WRITE_LIKE.test(p)), []);
  assert.equal(JSON.stringify([...map.entries()]), mapBefore);
});
