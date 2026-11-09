/**
 * PV-ORPHAN-001 — answers the walk rests on that the product never recorded, and a cursor it did not move.
 *
 * On 2026-09-23 a conversation that never reached the backend wrote, through the seller's own Notion app, the
 * B3 and B4 answers of a Sales OS and moved its cursor from B3 to B5, with journal rows that read exactly like
 * the product's. PV-FW-001 could not see any of it: it compares rows the product PROVED with their receipts,
 * and none of these had one. The seller's decision was: the content stays; the product adopts it.
 *
 * The property under test: **what the walk rests on is either proved or asked about, never assumed.** The rows
 * looked for are exactly the ones the contract names as a step's evidence; the cursor is compared with the
 * revision its last FINAL recorded. One question, one RECONCILE, no write on the rows, real receipts — and a
 * cursor sitting past a step whose answer does not exist is refused as it is, because nothing can adopt that.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { propText, type Page } from "../../src/notion/shapes.ts";
import { transition } from "../../src/plans/service.ts";
import type { Plan } from "../../src/plans/store.ts";
import { bindLive, dispatch } from "../../src/tools/handlers.ts";
import { readOrphanRows } from "../../src/resume/orphanRows.ts";
import type { NotionReadClient } from "../../src/notion/readClient.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import { toolInputSchemas } from "../../src/tools/surface.ts";
import { registerBuiltinSalesAdapters, salesContractAdapter, type SalesContractAdapter } from "../../src/versions/adapters/sales.ts";
import { createAdapterRegistries } from "../../src/versions/registry.ts";
import { handleOf, OWNER, T0 } from "./binding-fixtures.ts";
import { synthetic, text } from "./meta-fixtures.ts";
import { buildResumeWorld, R, setRowsIn } from "./resume-fixtures.ts";
import { CONTRACT_PAGE, IDS as SALES_IDS, SGRAMMAR, SV } from "./sales-fixtures.ts";
import { executeWrites, mutatePage, rowsOf } from "./target-fixtures.ts";
import { stampsAt, transact as nativeTransact } from "../support/transact.ts";

const ctx = { principal_id: OWNER.principal_id, now: T0 };
const CONFIG = "SALES:BUSINESS_CONFIG";
const STATE = "SALES:OS_STATE";
const B1_KEY = "B1_OFFER:SELLABLE_OFFER";
const B2_KEY = "B2_ICP:TARGET_ACCOUNTS";
const OFFER = "Un récit industriel filmé qui rend une usine désirable pour ses clients";
const ICP = "Industriels français dont le process se filme ; on écarte l'hôtellerie";
type Ok = Extract<Envelope, { status: "OK" }>;
type Hold = Extract<Envelope, { status: "HOLD" }>;
type World = ReturnType<typeof buildResumeWorld>;
interface Confirmation { kind: string; question: string; rows?: { natural_key: string }[]; cursor_moved?: boolean; intent: { action_class: string; mutations: { logical_resource_key: string; operation: string; record_selector: { natural_key: string }; desired_changes: Record<string, unknown> }[] } }

function setupLine() {
  const registries = createAdapterRegistries();
  registerBuiltinSalesAdapters(registries.salesRuntime);
  const v = registries.salesRuntime.supported().find((x) => x.endsWith("/0.5.6-candidate"));
  assert.ok(v);
  return (registries.salesRuntime.resolve(v) as SalesContractAdapter).grammar.controlPlane;
}

function world(gate = "B1_OFFER"): { w: World; configDs: string } {
  const w = buildResumeWorld();
  const contract = "TEST_SALES_CONTRACT/1.9.0";
  const controlPlane = setupLine();
  w.deps.adapters.salesRuntime.register(contract, salesContractAdapter(contract, [SV.schema], { ...SGRAMMAR, controlPlane }));
  const ids = SALES_IDS("rep-a");
  const manifest = w.map.get(`page:${ids.manifestRow}`) as Page;
  setRowsIn(w.map, ids.manifestDs, [{ ...manifest, properties: { ...manifest.properties,
    "Sales Contract Version": { type: "rich_text", rich_text: [text(contract)] },
    "Health Status": { type: "select", select: { name: "HEALTHY" } },
    "Persistence Health": { type: "select", select: { name: "PASS" } } } }]);
  w.map.set(`page:${CONTRACT_PAGE}`, { object: "page", id: CONTRACT_PAGE, archived: false, properties: { title: { type: "title", title: [text(contract)] } } });
  const liveState = w.map.get(`data_source:${R.salesStateDs}`) as { properties: Record<string, unknown> };
  w.map.set(`data_source:${R.salesStateDs}`, { properties: { ...liveState.properties,
    "Gate Passed By Run Ref": { type: "rich_text" }, "Last Durable Mode": { type: "select" },
    "Last Durable Turn ID": { type: "rich_text" }, "Next Authorized Topic": { type: "rich_text" } } });
  w.setSalesState({ gate, buildState: gate, nextAction: "…", nextQuestion: "…" });
  const list = (results: unknown[]) => ({ results, has_more: false, next_cursor: null });
  const spec = controlPlane.resources?.[CONFIG];
  assert.ok(spec?.parentTitle);
  const parent = synthetic("orphan-setup-parent"); const db = synthetic("orphan-config-db"); const configDs = synthetic("orphan-config-ds");
  const rootChildren = (w.map.get(`children:${ids.root}`) as { results: unknown[] }).results;
  w.map.set(`children:${ids.root}`, list([...rootChildren, { id: parent, type: "child_page", child_page: { title: spec.parentTitle } }]));
  w.map.set(`children:${parent}`, list([{ id: db, type: "child_database", child_database: { title: spec.databaseTitle } }]));
  w.map.set(`database:${db}`, { data_sources: [{ id: configDs }] });
  w.map.set(`data_source:${configDs}`, { properties: { "Config Item": { type: "title" }, Category: { type: "select" }, State: { type: "select" }, Value: { type: "rich_text" }, Version: { type: "rich_text" }, Source: { type: "rich_text" }, "Effective At": { type: "date" }, Notes: { type: "rich_text" } } });
  setRowsIn(w.map, configDs, []);
  return { w, configDs };
}

/** A contract-complete answer row, written by anyone but the product. */
function handRow(configDs: string, key: string, category: string, value: string, edited = "2030-01-06T00:00:00.000Z"): Page {
  return { object: "page", id: synthetic(`orphan-row-${key}`), archived: false, last_edited_time: edited,
    parent: { type: "data_source_id", data_source_id: configDs },
    properties: { "Config Item": { type: "title", title: [text(key)] }, Category: { type: "select", select: { name: category } }, State: { type: "select", select: { name: "CONFIRMED" } }, Value: { type: "rich_text", rich_text: [text(value)] }, Version: { type: "rich_text", rich_text: [text("SALES_INPUT/1")] }, Source: { type: "rich_text", rich_text: [text("CHAT_USER_EXPLICIT")] }, Notes: { type: "rich_text", rich_text: [text("Recovered … durable reconciliation")] } } };
}
const nativeRow = (configDs: string): Page => ({ object: "page", id: synthetic("orphan-native-row"), archived: false, last_edited_time: "2030-01-06T00:00:00.000Z",
  parent: { type: "data_source_id", data_source_id: configDs },
  properties: { "Config Item": { type: "title", title: [text("NOTES:MY_OWN")] }, Category: { type: "select", select: { name: "OTHER" } }, State: { type: "select", select: { name: "HYPOTHESIS" } }, Value: { type: "rich_text", rich_text: [text("une note perso")] }, Version: { type: "rich_text", rich_text: [] }, Source: { type: "rich_text", rich_text: [] } } });

const bind = async (w: World) => handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps));
const answerIntent = () => ({ action_class: "COMMIT", summary: "persist the seller's confirmed offer",
  mutations: [{ logical_resource_key: CONFIG, operation: "UPSERT", record_selector: { natural_key: B1_KEY },
    desired_changes: { Category: "OFFER", State: "CONFIRMED", Value: OFFER, Version: "SALES_INPUT/1", Source: "CHAT_USER_EXPLICIT" } }] });
const confirmationOf = (e: Envelope): Confirmation | undefined => ((e as Ok).result as { pending_confirmation?: Confirmation } | undefined)?.pending_confirmation;
const evidenceOf = (e: Envelope) => ((e as Hold).evidence ?? []).join(" | ");
const plansCreated = async (w: World) => (await w.deps.store.events.list({})).filter((e) => e.event_type === "PLAN_CREATED").length;

/** One complete transaction; `undefined` intent = the backend-derived cursor move. */
/** The LIVE transaction (test/support/transact.ts), on fixture day 04 at minute `salt`. */
const transact = async (w: World, h: string, intent: unknown | undefined, salt: string): Promise<Plan> => (await nativeTransact(w, h, intent, { ctx, stamps: stampsAt("04", salt) })).plan;

async function groupedProbe(keys?: readonly string[]) {
  const { w, configDs } = world();
  const live = await bindLive(await bind(w), ctx, w.deps);
  assert.ok(live.ok);
  const runtime = keys ? { ...live.runtime, adapter: { ...live.runtime.adapter, controlPlane: { ...live.runtime.adapter.controlPlane,
    cursorTransitions: keys.map((naturalKey, i) => {
      const t = live.runtime.adapter.controlPlane.cursorTransitions![i]!;
      return { ...t, evidence: { ...t.evidence, naturalKey } };
    }) } } } : live.runtime;
  const inner = w.deps.notion;
  const reader = (batch?: (cursor?: string) => Promise<unknown>) => {
    const calls: { filter: unknown; cursor: string | undefined; options: unknown }[] = [];
    const client: NotionReadClient = {
      retrievePage: id => inner.retrievePage(id), retrieveDatabase: id => inner.retrieveDatabase(id),
      retrieveDataSource: id => inner.retrieveDataSource(id), retrieveBlockChildren: (id, cursor) => inner.retrieveBlockChildren(id, cursor),
      async queryDataSource(id, filter, cursor, options) {
        if (id === configDs) {
          calls.push({ filter, cursor, options });
          if (batch && Array.isArray((filter as { or?: unknown } | undefined)?.or)) return batch(cursor);
          if (keys) {
            const q = pRows();
            const equals = (filter as { title?: { equals?: string } } | undefined)?.title?.equals;
            return { results: q.filter(r => propText(r, "Config Item") === equals), has_more: false, next_cursor: null };
          }
        }
        return inner.queryDataSource(id, filter, cursor, options);
      },
    };
    const pRows = () => (w.map.get(`query:${configDs}`) as { results: Page[] }).results;
    return { calls, read: (capture = true) => readOrphanRows(client, runtime, new Map(),
      { activePlans: [], lastFinal: undefined, cursor: undefined, captureObservation: capture }) };
  };
  return { w, configDs, reader };
}

test("W7.1 grouped evidence: one fresh source query preserves the fallback report and ignores unrelated/archived rows", async () => {
  const p = await groupedProbe();
  const installComplete = (rows: Page[]) => {
    setRowsIn(p.w.map, p.configDs, rows);
    const q = p.w.map.get(`query:${p.configDs}`) as { results: Page[] };
    p.w.map.set(`query:${p.configDs}`, { ...q, has_more: false, next_cursor: null });
  };
  const a = handRow(p.configDs, B1_KEY, "OFFER", OFFER), b = handRow(p.configDs, B2_KEY, "ICP_INCLUDE", ICP);
  installComplete([a, b, nativeRow(p.configDs), { ...b, id: synthetic("archived-duplicate"), archived: true }]);
  const baseline = p.reader(async () => { throw new Error("OR unavailable"); });
  const expected = await baseline.read();
  const optimized = p.reader();
  assert.deepEqual(await optimized.read(), expected);
  assert.equal(optimized.calls.length, 1, "one complete grouped query, not seven separate key lookups");
  assert.deepEqual(optimized.calls[0]?.options, { page_size: 100 });
  assert.equal(expected.orphans.length, 2);
  assert.deepEqual(expected.coverage.unknown, []);
  const changed = { ...a, properties: { ...a.properties, Value: { type: "rich_text" as const, rich_text: [text("new local answer")] } } };
  installComplete([changed, b]);
  const next = await optimized.read();
  assert.equal(optimized.calls.length, 2, "next observation re-queries, no evidence cache");
  assert.notEqual(next.orphans[0]?.observation_hash, expected.orphans[0]?.observation_hash);
  const historical = p.reader();
  await historical.read(false);
  assert.ok(historical.calls.length > 1, "historical path is unchanged");
});

test("W7.1 grouped evidence: mixed-whitespace contract keys use the original exact per-key queries", async () => {
  const p = await groupedProbe(["A", " A"]);
  const row = handRow(p.configDs, " A", "OFFER", OFFER);
  setRowsIn(p.w.map, p.configDs, [row]);
  const probe = p.reader(async () => ({ results: [row], has_more: false, next_cursor: null }));
  const report = await probe.read();
  assert.deepEqual(report.orphans, [], "the OR result must not turn the whitespace row into evidence of A");
  assert.deepEqual(report.coverage.unknown, []);
  assert.equal(probe.calls.length, 2);
  assert.ok(probe.calls.every(c => !Array.isArray((c.filter as { or?: unknown } | undefined)?.or)), "no grouped query for noncanonical key spelling");
});

test("W7.1 grouped evidence: a duplicate on the second page remains UNKNOWN, with identical filter and forwarded cursor", async () => {
  const p = await groupedProbe();
  const row = handRow(p.configDs, B1_KEY, "OFFER", OFFER);
  const duplicate = { ...row, id: synthetic("second-page-duplicate") };
  setRowsIn(p.w.map, p.configDs, [row, duplicate]);
  const expected = await p.reader(async () => { throw new Error("OR unavailable"); }).read();
  const paged = p.reader(async cursor => cursor
    ? { results: [duplicate], has_more: false, next_cursor: null }
    : { results: [row], has_more: true, next_cursor: "page2" });
  const report = await paged.read();
  assert.deepEqual(report, expected);
  assert.equal(report.orphans.length, 0);
  assert.match(report.coverage.unknown[0]?.reason ?? "", /2 rows carry/);
  assert.equal(paged.calls.length, 2);
  assert.equal(paged.calls[1]?.cursor, "page2");
  assert.deepEqual(paged.calls[1]?.filter, paged.calls[0]?.filter);
  assert.deepEqual(paged.calls[1]?.options, { page_size: 100 });
});

test("W7.1 grouped evidence: unproved batch end or read error discards partial evidence and falls back to fresh per-key reads", async t => {
  for (const fault of ["error", "missing-end", "missing-cursor", "cycle", "bounded", "malformed"] as const) await t.test(fault, async () => {
    const p = await groupedProbe();
    const row = handRow(p.configDs, B1_KEY, "OFFER", OFFER);
    setRowsIn(p.w.map, p.configDs, [row, { ...row, id: synthetic("live-duplicate") }]);
    const expected = await p.reader(async () => { throw new Error("OR unavailable"); }).read();
    let n = 0;
    const partial = p.reader(async () => {
      n++;
      if (fault === "error") throw new Error("batch unreadable");
      if (fault === "malformed") return { results: null, has_more: false };
      if (fault === "missing-end") return { results: [row] };
      return { results: [row], has_more: true, next_cursor: fault === "missing-cursor" ? null : fault === "cycle" ? "loop" : `page${n}` };
    });
    const report = await partial.read();
    assert.deepEqual(report, expected, "a partial batch cannot hide the durable duplicate");
    assert.ok(partial.calls.some(c => !Array.isArray((c.filter as { or?: unknown } | undefined)?.or)), "existing per-key path used");
    if (fault === "bounded") assert.equal(n, 50);
  });
});

test("PV-ORPHAN-001/a: a step's answer written without the product is found, asked about once in the seller's words, and blocks nothing", async () => {
  const { w, configDs } = world();
  const h = await bind(w);
  setRowsIn(w.map, configDs, [handRow(configDs, B1_KEY, "OFFER", OFFER), nativeRow(configDs)]);
  const before = await plansCreated(w);

  const resumed = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  assert.equal(resumed.code, "RESUMED", `the seller's space is never a refusal: ${JSON.stringify(resumed)}`);
  const pc = confirmationOf(resumed);
  assert.ok(pc, "the unrecorded answer becomes the next question");
  assert.equal(pc.kind, "ORPHAN_ROWS");
  assert.deepEqual(pc.rows?.map((r) => r.natural_key), [B1_KEY], "the seller's own note under a key of their own is not the product's business (FW-13)");
  assert.equal(pc.cursor_moved, false, "a cursor the product never proved has no reference and is not claimed to have moved");
  assert.match(pc.question, /votre définition d.offre/, "asked about what the seller recognises");
  assert.match(pc.question, /pas enregistrée moi-même/);
  assert.doesNotMatch(pc.question, /B1_OFFER|récit industriel/, "never an internal key, never the business value");
  assert.equal(resumed.ask, pc.question, "and it is the question of this turn");
  assert.equal(((resumed as Ok).result as { pending_step_input?: unknown }).pending_step_input, undefined, "the step's own question is not asked again: Notion already holds the answer");
  assert.equal(resumed.next.permitted_tool_call, "os_prepare");
  assert.deepEqual(resumed.next.prepare_intent, pc.intent, "the call that records the seller's yes travels with the question");
  assert.equal(pc.intent.action_class, "RECONCILE");
  assert.deepEqual(pc.intent.mutations, [{ logical_resource_key: CONFIG, operation: "UPDATE", record_selector: { natural_key: B1_KEY }, desired_changes: {} }], "adopted as it stands: nothing to fill, nothing to copy");
  assert.ok(toolInputSchemas.os_prepare.safeParse({ binding_handle: h, intent: pc.intent }).success, "the served intent is byte-for-byte what os_prepare accepts");
  assert.match(resumed.next.conduct ?? "", /written there without this product/, "the conduct names the situation");
  assert.match(resumed.next.conduct ?? "", /empty ones included/, "and tells the caller to send the intent exactly as served");
  assert.equal(await plansCreated(w), before, "asking creates nothing");
});

test("PV-ORPHAN-001/b: the seller's yes adopts the row as it stands — no write on it, a real Run and receipt — and the walk then rests on it", async () => {
  const { w, configDs } = world();
  const h = await bind(w);
  setRowsIn(w.map, configDs, [handRow(configDs, B1_KEY, "OFFER", OFFER)]);
  const rowBefore = rowsOf(w, configDs)[0] as Page;
  const pc = confirmationOf(await dispatch("os_resume", { binding_handle: h }, ctx, w.deps));
  assert.ok(pc);

  const prepared = await dispatch("os_prepare", { binding_handle: h, intent: pc.intent }, ctx, w.deps);
  assert.equal(prepared.code, "PLAN_PREPARED", JSON.stringify(prepared));
  const plan = await w.deps.store.plans.get(((prepared as Ok).result as { plan_id: string }).plan_id) as Plan;
  assert.ok(plan.stage1_writes.every((x) => x.purpose !== "WRITE_TARGET"), "a re-adoption writes nothing on the row");
  assert.deepEqual(plan.operations[0]?.compared_fields, ["Category", "Source", "State", "Value", "Version"], "and attests every governed field, not only what the caller listed");
  assert.equal(plan.operations[0]?.before_hash, plan.operations[0]?.expected_values && plan.operations[0]?.expected_hash, "expected is exactly what is there");
  const symbols = executeWrites(w, plan.stage1_writes, plan.plan_id, { now: "2030-01-07T00:10:00.000Z" });
  const target = await dispatch("os_verify", { binding_handle: h, plan_id: plan.plan_id, phase: "TARGET" }, ctx, w.deps);
  assert.equal(target.code, "TARGET_VERIFIED", JSON.stringify(target));
  const receipt = ((target as Ok).result as { target_receipt_id: string }).target_receipt_id;
  const observed = (target.observations["symbols"] as Record<string, string> | undefined) ?? symbols;
  executeWrites(w, plan.finalization_writes, plan.plan_id, { ...({ now: "2030-01-07T00:10:30.000Z" }), created: observed, target_receipt_id: receipt });
  executeWrites(w, [plan.state_last_write], plan.plan_id, { ...({ now: "2030-01-07T00:10:45.000Z" }), created: observed, target_receipt_id: receipt });
  const final = await dispatch("os_verify", { binding_handle: h, plan_id: plan.plan_id, phase: "FINAL" }, ctx, w.deps);
  assert.equal(final.code, "TRANSACTION_VERIFIED", JSON.stringify(final));
  const rowAfter = rowsOf(w, configDs).find((r) => r.id === rowBefore.id) as Page;
  assert.equal(rowAfter.last_edited_time, rowBefore.last_edited_time, "the row itself was not touched");
  assert.equal(propText(rowAfter, "Value"), OFFER);

  const again = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  assert.equal(again.code, "RESUMED", JSON.stringify(again));
  assert.equal(confirmationOf(again), undefined, "adopted once, never asked again");
  // The adopted answer is now the evidence the contract reads: the step moves from it, by the ordinary engine.
  const move = await dispatch("os_prepare", { binding_handle: h }, ctx, w.deps);
  assert.equal(move.code, "PLAN_PREPARED", `the walk rests on the adopted row: ${JSON.stringify(move)}`);
  assert.equal(((move as Ok).result as { plan_id: string }).plan_id !== plan.plan_id, true);
});

test("PV-ORPHAN-001/c: a cursor moved without the product, over steps whose answers are there, is adopted with them and re-anchored", async () => {
  const { w, configDs } = world();
  const h = await bind(w);
  await transact(w, h, answerIntent(), "10");
  await transact(w, h, undefined, "20");
  assert.equal(propText(w.map.get(`page:${R.salesStateRow}`) as Page, "Current Gate"), "B2_ICP", "the product moved the step itself, once");
  // Then, with no product in the loop: the B2 answer appears, and the cursor is pushed to B3 by hand.
  setRowsIn(w.map, configDs, [...rowsOf(w, configDs), handRow(configDs, B2_KEY, "ICP_INCLUDE", ICP)]);
  mutatePage(w, R.salesStateRow, { "Current Gate": "B3_DATA", "Build State": "B3_DATA", "Next Authorized Topic": "B3_DATA", "Next Question": "D'où viennent tes comptes et contacts ?" }, "2030-01-06T12:00:00.000Z");

  const resumed = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  assert.equal(resumed.code, "RESUMED", JSON.stringify(resumed));
  const pc = confirmationOf(resumed);
  assert.ok(pc, "both the unrecorded answer and the moved cursor are asked about, in one question");
  assert.deepEqual(pc.rows?.map((r) => r.natural_key), [B2_KEY]);
  assert.equal(pc.cursor_moved, true);
  assert.match(pc.question, /comptes à viser/);
  assert.match(pc.question, /étape affichée \(B3_DATA\) a aussi été modifiée/);
  assert.equal(pc.intent.mutations.length, 2);
  assert.deepEqual(pc.intent.mutations[1], { logical_resource_key: STATE, operation: "UPDATE", record_selector: { natural_key: "CURRENT" }, desired_changes: {} }, "the cursor is re-adopted as it stands, never declared");

  const prepared = await dispatch("os_prepare", { binding_handle: h, intent: pc.intent }, ctx, w.deps);
  assert.equal(prepared.code, "PLAN_PREPARED", `an as-is re-adoption of the cursor is not a forged gate: ${JSON.stringify(prepared)}`);
  const plan = await w.deps.store.plans.get(((prepared as Ok).result as { plan_id: string }).plan_id) as Plan;
  const cursorOp = plan.operations.find((o) => o.logical_resource_key === STATE);
  assert.ok(cursorOp);
  assert.ok(!cursorOp.compared_fields.includes("Last Run Ref"), "what STATE_LAST writes is not part of the cursor's re-adopted content");
  assert.ok(cursorOp.compared_fields.includes("Current Gate"));
  assert.ok(plan.stage1_writes.every((x) => x.purpose !== "WRITE_TARGET"));
  const symbols = executeWrites(w, plan.stage1_writes, plan.plan_id, { now: "2030-01-07T00:10:00.000Z" });
  const target = await dispatch("os_verify", { binding_handle: h, plan_id: plan.plan_id, phase: "TARGET" }, ctx, w.deps);
  assert.equal(target.code, "TARGET_VERIFIED", JSON.stringify(target));
  const receipt = ((target as Ok).result as { target_receipt_id: string }).target_receipt_id;
  const observed = (target.observations["symbols"] as Record<string, string> | undefined) ?? symbols;
  executeWrites(w, plan.finalization_writes, plan.plan_id, { ...({ now: "2030-01-07T00:10:30.000Z" }), created: observed, target_receipt_id: receipt });
  executeWrites(w, [plan.state_last_write], plan.plan_id, { ...({ now: "2030-01-07T00:10:45.000Z" }), created: observed, target_receipt_id: receipt });
  const final = await dispatch("os_verify", { binding_handle: h, plan_id: plan.plan_id, phase: "FINAL" }, ctx, w.deps);
  assert.equal(final.code, "TRANSACTION_VERIFIED", JSON.stringify(final));
  assert.equal(propText(w.map.get(`page:${R.salesStateRow}`) as Page, "Current Gate"), "B3_DATA", "the step the seller kept stays where they put it");

  const again = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  assert.equal(again.code, "RESUMED", JSON.stringify(again));
  assert.equal(confirmationOf(again), undefined, "re-anchored: nothing is asked twice");
  assert.equal(((again as Ok).result as { gate: { gate_key: string } }).gate.gate_key, "B3_DATA");
  assert.match(again.ask ?? "", /comptes et contacts/, "and the conversation goes on from the step's own question");
});

test("PV-ORPHAN-001/d: a cursor pushed past a step whose answer does not exist is refused as it is — nothing can adopt an answer that is not there", async () => {
  const { w } = world();
  const h = await bind(w);
  await transact(w, h, answerIntent(), "10");
  await transact(w, h, undefined, "20");
  const before = await plansCreated(w);
  mutatePage(w, R.salesStateRow, { "Current Gate": "B3_DATA", "Build State": "B3_DATA", "Next Authorized Topic": "B3_DATA" }, "2030-01-06T12:00:00.000Z");

  const resumed = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  assert.equal(resumed.code, "HOLD_STATE_DIVERGENCE", JSON.stringify(resumed));
  assert.match(evidenceOf(resumed), /sits on B3_DATA/);
  assert.match(evidenceOf(resumed), /step B2_ICP it has passed has no verified answer/);
  assert.match(evidenceOf(resumed), /absent/);
  assert.equal(confirmationOf(resumed), undefined, "no adoption is offered for a step with no answer");
  assert.equal(await plansCreated(w), before);
  const prepared = await dispatch("os_prepare", { binding_handle: h, intent: { action_class: "RECONCILE", summary: "adopt", mutations: [{ logical_resource_key: STATE, operation: "UPDATE", record_selector: { natural_key: "CURRENT" }, desired_changes: {} }] } }, ctx, w.deps);
  assert.equal(prepared.code, "HOLD_STATE_DIVERGENCE", `nor can it be forced: ${JSON.stringify(prepared)}`);
});

test("PV-ORPHAN-001/e: a re-adoption covers exactly what was reported — another row is refused, and so is a value that differs from the row", async () => {
  const { w, configDs } = world();
  const h = await bind(w);
  await transact(w, h, answerIntent(), "10");
  setRowsIn(w.map, configDs, [...rowsOf(w, configDs), handRow(configDs, B2_KEY, "ICP_INCLUDE", ICP)]);
  const pc = confirmationOf(await dispatch("os_resume", { binding_handle: h }, ctx, w.deps));
  assert.ok(pc);
  assert.deepEqual(pc.rows?.map((r) => r.natural_key), [B2_KEY], "the proved B1 row is not an orphan");

  const other = await dispatch("os_prepare", { binding_handle: h, intent: { ...pc.intent, mutations: [{ logical_resource_key: CONFIG, operation: "UPDATE", record_selector: { natural_key: B1_KEY }, desired_changes: {} }] } }, ctx, w.deps);
  assert.equal(other.code, "HOLD_UNSUPPORTED_OPERATION", JSON.stringify(other));
  assert.match(evidenceOf(other), /not among the rows reported/);
  const edit = await dispatch("os_prepare", { binding_handle: h, intent: { ...pc.intent, mutations: [{ ...pc.intent.mutations[0]!, desired_changes: { Value: "Une autre définition" } }] } }, ctx, w.deps);
  assert.equal(edit.code, "HOLD_UNSUPPORTED_OPERATION", JSON.stringify(edit));
  assert.match(evidenceOf(edit), /would change Value/, "an edit is not a re-adoption");
  // A forged cursor declaration is still refused before anything: only the empty, as-is form passes the door.
  const forged = await dispatch("os_prepare", { binding_handle: h, intent: { action_class: "RECONCILE", summary: "x", mutations: [{ logical_resource_key: STATE, operation: "UPDATE", record_selector: { natural_key: "CURRENT" }, desired_changes: { "Current Gate": "B5_OUTREACH" } }] } }, ctx, w.deps);
  assert.equal(forged.code, "HOLD_ACTION_NOT_AUTHORIZED", JSON.stringify(forged));
});

test("PV-ORPHAN-001/f: a row a live plan of this runtime is about to write is in flight, not orphan; once that plan is dead, it is", async () => {
  const { w, configDs } = world();
  const h = await bind(w);
  const prepared = await dispatch("os_prepare", { binding_handle: h, intent: answerIntent() }, ctx, w.deps);
  assert.equal(prepared.code, "PLAN_PREPARED", JSON.stringify(prepared));
  const planId = ((prepared as Ok).result as { plan_id: string }).plan_id;
  // The row appears before the plan's own writes ran — exactly the 2026-09-23 sequence.
  setRowsIn(w.map, configDs, [handRow(configDs, B1_KEY, "OFFER", OFFER)]);
  const live = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  assert.equal(live.code, "RESUMED", JSON.stringify(live));
  assert.equal(confirmationOf(live), undefined, "recovery owns a row a live plan targets");
  assert.ok((((live as Ok).result as { coverage: { in_flight: string[] } }).coverage.in_flight.length) >= 1, "and says so");

  // Past its TTL the plan protects nothing, even before anything marked it expired.
  const later = { ...ctx, now: new Date(T0.getTime() + 60 * 60 * 1000) };
  const stale = await dispatch("os_resume", { binding_handle: h }, later, w.deps);
  assert.equal(confirmationOf(stale)?.kind, "ORPHAN_ROWS", `a plan past its TTL is unfinished work, not work in flight: ${JSON.stringify(stale)}`);
  await transition(w.deps.store, planId, "EXPIRED", later.now, { reason: "test" });
  const dead = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  assert.equal(confirmationOf(dead)?.kind, "ORPHAN_ROWS", JSON.stringify(dead));
});
