/**
 * PV-FW — writes made outside any transaction, on rows the harness has proved.
 *
 * The seller owns these rows. A change they made in Notion is a decision to record, not an incident to refuse:
 * the space notices it, asks once whether it is theirs, and records the answer. Nothing is blocked. What is
 * refused is only the silent case — a change nobody ever confirmed becoming the evidence a later step rests on.
 *
 * Three times on 2026-09-22 a chat reached Notion without VERTIGO and wrote or narrated over governed state,
 * and one row written that way on the 21st still holds a gate. Nothing in the harness could see it: the resume
 * path reads no business row, FINAL compares values only inside its own transaction, and a "last verified"
 * date says nothing about the rows a transaction did not touch.
 *
 * The property under test: **a verification covers only the objects and fields it actually verified**. So the
 * reference is per object — the fields and content fingerprint of the last receipt that proved it — and a
 * transaction on B never vouches for A. FW-6 is the counter-example that killed the global-watermark design.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { propText, type Page } from "../../src/notion/shapes.ts";
import type { Plan } from "../../src/plans/store.ts";
import { dispatch } from "../../src/tools/handlers.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
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
const B1_KEY = "B1_OFFER:SELLABLE_OFFER";
const OFFER = "Un récit industriel filmé qui rend une usine désirable pour ses clients";
type Ok = Extract<Envelope, { status: "OK" }>;
type Hold = Extract<Envelope, { status: "HOLD" }>;
type World = ReturnType<typeof buildResumeWorld>;

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
  const parent = synthetic("fw-setup-parent"); const db = synthetic("fw-config-db"); const configDs = synthetic("fw-config-ds");
  const rootChildren = (w.map.get(`children:${ids.root}`) as { results: unknown[] }).results;
  w.map.set(`children:${ids.root}`, list([...rootChildren, { id: parent, type: "child_page", child_page: { title: spec.parentTitle } }]));
  w.map.set(`children:${parent}`, list([{ id: db, type: "child_database", child_database: { title: spec.databaseTitle } }]));
  w.map.set(`database:${db}`, { data_sources: [{ id: configDs }] });
  w.map.set(`data_source:${configDs}`, { properties: { "Config Item": { type: "title" }, Category: { type: "select" }, State: { type: "select" }, Value: { type: "rich_text" }, Version: { type: "rich_text" }, Source: { type: "rich_text" }, "Effective At": { type: "date" }, Notes: { type: "rich_text" } } });
  setRowsIn(w.map, configDs, []);
  return { w, configDs };
}

const bind = async (w: World) => handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps));
const answerIntent = () => ({ action_class: "COMMIT", summary: "persist the seller's confirmed offer",
  mutations: [{ logical_resource_key: CONFIG, operation: "UPSERT", record_selector: { natural_key: B1_KEY },
    desired_changes: { Category: "OFFER", State: "CONFIRMED", Value: OFFER, Version: "SALES_INPUT/1", Source: "CHAT_USER_EXPLICIT" } }] });

/** One complete transaction, with a hook that runs while it is in flight: after the stage-1 writes, before TARGET. */
/** The LIVE transaction (test/support/transact.ts), on fixture day 04 at minute `salt`; `whileInFlight` acts between stage 1 and TARGET. */
const transact = async (w: World, h: string, intent: unknown | undefined, salt: string, whileInFlight?: () => void): Promise<Plan> =>
  (await nativeTransact(w, h, intent, { ctx, stamps: stampsAt("04", salt), ...(whileInFlight ? { whileInFlight } : {}) })).plan;

const evidenceOf = (e: Envelope) => ((e as Hold).evidence ?? []).join(" | ");
const plansCreated = async (w: World) => (await w.deps.store.events.list({})).filter((e) => e.event_type === "PLAN_CREATED").length;

test("FW-1: a proved row edited outside the system is noticed and asked about, in the seller's words, without blocking", async () => {
  const { w, configDs } = world();
  const h = await bind(w);
  await transact(w, h, answerIntent(), "10");
  const rowA = rowsOf(w, configDs)[0] as Page;
  const before = await plansCreated(w);

  // Someone with the same Notion rights rewrites the seller's offer with no VERTIGO in the loop.
  mutatePage(w, rowA.id, { Value: "Une offre réécrite par un agent sans transaction" }, "2030-01-05T00:00:00.000Z");

  const resumed = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  assert.equal(resumed.code, "RESUMED", `a row the seller owns is never a refusal: ${JSON.stringify(resumed)}`);
  const pc = ((resumed as Ok).result as { pending_confirmation?: { natural_key: string; fields: string[]; question: string; intent: unknown } }).pending_confirmation;
  assert.ok(pc, "the change is surfaced as the next question");
  assert.equal(pc.natural_key, B1_KEY);
  assert.deepEqual(pc.fields, ["Value"]);
  assert.match(pc.question, /définition d.offre a changé/, "asked about what the seller recognises, not a row id");
  assert.doesNotMatch(pc.question, /réécrite par un agent|B1_OFFER/, "never the business value, never an internal key");
  assert.equal(resumed.ask, pc.question, "and it is the question of this turn");
  assert.equal(resumed.next.permitted_tool_call, "os_prepare", "with the call that records the answer");
  assert.ok(resumed.next.prepare_intent, "already filled: only the seller's yes is missing");
  assert.equal(await plansCreated(w), before, "asking creates nothing");
});

test("FW-2: a proved row left intact resumes normally", async () => {
  const { w } = world();
  const h = await bind(w);
  await transact(w, h, answerIntent(), "10");
  const resumed = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  assert.equal(resumed.code, "RESUMED", JSON.stringify(resumed));
});

test("FW-6 (the counter-example): a foreign edit on A during a legitimate transaction on B stays detectable after B completes", async () => {
  const { w, configDs } = world();
  const h = await bind(w);
  // A: the seller's answer, proved.
  await transact(w, h, answerIntent(), "10");
  const rowA = rowsOf(w, configDs)[0] as Page;
  // B: the cursor move, a legitimate transaction on a different row. While it is in flight, A is edited outside.
  // A global "last verified" watermark would jump past 00:11 when B completes and A would vanish from view.
  await transact(w, h, undefined, "20", () => {
    mutatePage(w, rowA.id, { Value: "Édition étrangère pendant la transaction B" }, "2030-01-04T00:11:00.000Z");
  });
  assert.equal(propText(w.map.get(`page:${R.salesStateRow}`) as Page, "Current Gate"), "B2_ICP", "B completed on its own evidence");

  const resumed = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  const pc = ((resumed as Ok).result as { pending_confirmation?: { natural_key: string } }).pending_confirmation;
  assert.ok(pc, `B's completion must not vouch for A: ${JSON.stringify(resumed)}`);
  assert.equal(pc.natural_key, B1_KEY);
});

const ICP_KEY = "B2_ICP:TARGET_ACCOUNTS";
const ICP = "Industriels français dont le process se filme ; on écarte l'hôtellerie";
const icpIntent = () => ({ action_class: "COMMIT", summary: "persist the seller's confirmed ICP",
  mutations: [{ logical_resource_key: CONFIG, operation: "UPSERT", record_selector: { natural_key: ICP_KEY },
    desired_changes: { Category: "ICP_INCLUDE", State: "CONFIRMED", Value: ICP, Version: "SALES_INPUT/1", Source: "CHAT_USER_EXPLICIT" } }] });

/** The one intent admitted under the hold: the row's values exactly as they now stand, examined and re-adopted. */
function reconcileIntent(w: World, configDs: string, key: string) {
  const row = rowsOf(w, configDs).find((r) => propText(r as Page, "Config Item") === key) as Page;
  assert.ok(row, `row ${key} missing`);
  return { action_class: "RECONCILE", summary: `re-adopt ${key} as it now stands`,
    mutations: [{ logical_resource_key: CONFIG, operation: "UPDATE", record_selector: { natural_key: key },
      desired_changes: { Value: propText(row, "Value") ?? "", State: propText(row, "State") ?? "" } }] };
}

test("FW-R: a reconciliation re-adopts the row as it stands — no write, a real Run and receipt, and the hold clears", async () => {
  const { w, configDs } = world();
  const h = await bind(w);
  await transact(w, h, answerIntent(), "10");
  const row = rowsOf(w, configDs)[0] as Page;
  mutatePage(w, row.id, { Value: "Valeur posée hors transaction" }, "2030-01-05T00:00:00.000Z");
  const asked = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  const served = ((asked as Ok).result as { pending_confirmation?: { intent: unknown } }).pending_confirmation;
  assert.ok(served, "the seller is asked before anything is recorded");

  // The seller says yes: the call served with the question is sent exactly as it came.
  const plan = await transact(w, h, served.intent, "30");
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0]?.before_hash, plan.operations[0]?.expected_hash, "a re-adoption asserts exactly what is there");
  assert.equal(plan.stage1_writes.filter((x) => x.purpose === "WRITE_TARGET").length, 0, "it writes nothing to the row");
  assert.ok(plan.stage1_writes.some((x) => x.purpose === "OPEN_RUN"), "but it is a real transaction with its own Run");
  assert.equal(propText(rowsOf(w, configDs)[0] as Page, "Value"), "Valeur posée hors transaction", "the value is unchanged by the reconciliation");

  const resumed = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  assert.equal(resumed.code, "RESUMED", JSON.stringify(resumed));
  assert.equal(((resumed as Ok).result as { pending_confirmation?: unknown }).pending_confirmation, undefined, "confirmed once, never asked again");
});

test("FW-R/b: a reconciliation that would change a value is refused — it is an edit, not a re-adoption", async () => {
  const { w, configDs } = world();
  const h = await bind(w);
  await transact(w, h, answerIntent(), "10");
  mutatePage(w, (rowsOf(w, configDs)[0] as Page).id, { Value: "Valeur étrangère" }, "2030-01-05T00:00:00.000Z");
  const corrected = { action_class: "RECONCILE", summary: "re-adopt with a correction",
    mutations: [{ logical_resource_key: CONFIG, operation: "UPDATE", record_selector: { natural_key: B1_KEY }, desired_changes: { Value: "Ce que j'aurais voulu" } }] };
  const r = await dispatch("os_prepare", { binding_handle: h, intent: corrected }, ctx, w.deps);
  assert.equal(r.code, "HOLD_UNSUPPORTED_OPERATION", JSON.stringify(r));
  assert.match(evidenceOf(r), /asserts the current values, it does not correct them/);
});

test("FW-R/c: a confirmation is refused when nothing was changed outside the system", async () => {
  const { w, configDs } = world();
  const h = await bind(w);
  await transact(w, h, answerIntent(), "10");
  const r = await dispatch("os_prepare", { binding_handle: h, intent: reconcileIntent(w, configDs, B1_KEY) }, ctx, w.deps);
  assert.equal(r.code, "HOLD_UNSUPPORTED_OPERATION", JSON.stringify(r));
  assert.match(evidenceOf(r), /nothing in this runtime has changed outside a transaction/);
});

test("FW-7: two rows changed, one reconciled — the second stays open", async () => {
  const { w, configDs } = world();
  const h = await bind(w);
  await transact(w, h, answerIntent(), "10");
  await transact(w, h, undefined, "20");
  await transact(w, h, icpIntent(), "30");
  const rowA = rowsOf(w, configDs).find((r) => propText(r as Page, "Config Item") === B1_KEY) as Page;
  const rowB = rowsOf(w, configDs).find((r) => propText(r as Page, "Config Item") === ICP_KEY) as Page;
  mutatePage(w, rowA.id, { Value: "A modifiée hors système" }, "2030-01-05T00:00:00.000Z");
  mutatePage(w, rowB.id, { Value: "B modifiée hors système" }, "2030-01-05T00:01:00.000Z");
  const asked = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  const state = (asked as Ok).result as { foreign_writes?: { natural_key: string }[]; pending_confirmation?: { natural_key: string } };
  assert.equal(state.foreign_writes?.length, 2, "both rows are seen");
  assert.ok(state.pending_confirmation, "one question at a time");

  await transact(w, h, reconcileIntent(w, configDs, B1_KEY), "40");
  const still = (await dispatch("os_resume", { binding_handle: h }, ctx, w.deps) as Ok).result as { foreign_writes?: { natural_key: string }[]; pending_confirmation?: { natural_key: string } };
  assert.deepEqual(still.foreign_writes?.map((f) => f.natural_key), [ICP_KEY], "confirming A must not acquit B");
  assert.equal(still.pending_confirmation?.natural_key, ICP_KEY, "so B is the next question");
});

test("FW-12: a foreign edit that leaves the revision untouched is still caught — content decides, not the clock", async () => {
  const { w, configDs } = world();
  const h = await bind(w);
  await transact(w, h, answerIntent(), "10");
  const row = rowsOf(w, configDs)[0] as Page;
  const stamp = row.last_edited_time as string;
  // Same timestamp as the one the receipt recorded; only the content differs.
  mutatePage(w, row.id, { Value: "Contenu différent, même horodatage" }, stamp);
  assert.equal((rowsOf(w, configDs)[0] as Page).last_edited_time, stamp, "the fixture kept the revision identical");
  const resumed = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  assert.ok(((resumed as Ok).result as { pending_confirmation?: unknown }).pending_confirmation, `a timestamp is not proof of content: ${JSON.stringify(resumed)}`);
});

test("FW-13: a row the harness never proved is not its business; a second row under a proved key is", async () => {
  const { w, configDs } = world();
  const h = await bind(w);
  await transact(w, h, answerIntent(), "10");
  const proved = rowsOf(w, configDs)[0] as Page;
  const native: Page = { object: "page", id: synthetic("fw-native-row"), archived: false, last_edited_time: "2030-01-06T00:00:00.000Z",
    parent: { type: "data_source_id", data_source_id: configDs },
    properties: { "Config Item": { type: "title", title: [text("NOTES:MY_OWN")] }, Category: { type: "select", select: { name: "OTHER" } }, State: { type: "select", select: { name: "HYPOTHESIS" } }, Value: { type: "rich_text", rich_text: [text("une note perso")] }, Version: { type: "rich_text", rich_text: [] }, Source: { type: "rich_text", rich_text: [] } } };
  setRowsIn(w.map, configDs, [proved, native]);
  const resumed = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  assert.equal(((resumed as Ok).result as { pending_confirmation?: unknown }).pending_confirmation, undefined, `the seller's own additions are not anomalies: ${JSON.stringify(resumed)}`);
});

test("FW-10: a proved row that cannot be read leaves coverage unknown — that row alone is not admissible, the rest continues", async () => {
  const { w, configDs } = world();
  const h = await bind(w);
  await transact(w, h, answerIntent(), "10");
  await transact(w, h, undefined, "20");
  const row = rowsOf(w, configDs)[0] as Page;
  w.map.delete(`page:${row.id}`);

  const resumed = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  assert.equal(resumed.code, "RESUMED", "an unreadable row is not by itself a foreign write");
  assert.match((resumed.warnings ?? []).join(" "), /foreign_write_coverage_unknown/, "but it is reported as uncovered");
  // Another row of the same database is untouched by that failure: the seller keeps working.
  const prepared = await dispatch("os_prepare", { binding_handle: h, intent: icpIntent() }, ctx, w.deps);
  assert.equal(prepared.code, "PLAN_PREPARED", `one unreadable row must not stop the rest: ${JSON.stringify(prepared)}`);
});

test("FW-11: a proved row that was archived is uncovered, and its absence is reported without inventing a cause", async () => {
  const { w, configDs } = world();
  const h = await bind(w);
  await transact(w, h, answerIntent(), "10");
  const row = rowsOf(w, configDs)[0] as Page;
  w.map.set(`page:${row.id}`, { ...row, archived: true });

  const resumed = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  const warned = (resumed.warnings ?? []).join(" ");
  assert.match(warned, /foreign_write_coverage_unknown/);
  assert.match(warned, /archived/);
  assert.doesNotMatch(warned, /deleted by|someone/, "the cause of the absence is not guessed");
});

test("FW-8: a changed row never sends the chat into os_verify, even with an expired plan of its own", async () => {
  const { w, configDs } = world();
  const h = await bind(w);
  await transact(w, h, answerIntent(), "10");
  mutatePage(w, (rowsOf(w, configDs)[0] as Page).id, { Value: "Écriture étrangère" }, "2030-01-05T00:00:00.000Z");
  // A plan of this same caller, left open and now expired: the shape that used to trigger the recovery continuation.
  await dispatch("os_prepare", { binding_handle: h, intent: icpIntent() }, ctx, w.deps);
  const later = { ...ctx, now: new Date(T0.getTime() + 16 * 60_000) };
  const resumed = await dispatch("os_resume", { binding_handle: h }, later, w.deps);
  assert.equal(resumed.code, "RESUMED", JSON.stringify(resumed));
  assert.doesNotMatch(String(resumed.next?.safe_action ?? ""), /os_verify/, "a changed row is not recovered by verifying an old plan");
  assert.ok(((resumed as Ok).result as { pending_confirmation?: unknown }).pending_confirmation);
});

test("FW-5: the guard is opt-in — never a resource edited outside transactions by design, never the shared package", () => {
  const resources = setupLine().resources ?? {};
  const guarded = Object.entries(resources).filter(([, s]) => s.foreignWriteGuard === true).map(([k]) => k);
  assert.deepEqual(guarded.sort(), ["SALES:BUSINESS_CONFIG", "SALES:QUALIFICATION_GATES"]);
  for (const [key, spec] of Object.entries(resources)) {
    if (spec.foreignWriteGuard !== true) continue;
    assert.notEqual(spec.externalEffect, true, `${key} is externally effective: its rows are completed by the executor, not by a transaction`);
    assert.notEqual(spec.scope, "OBJECTIVE_PACKAGE", `${key} lives in the company package, where other people legitimately write`);
  }
});
