/**
 * PV-B2..PV-B6 — the walk is a catalog, not a program.
 *
 * B0 proved the mechanism and B1 proved one more step costs one declaration. These prove the claim in general:
 * five further steps are added by publishing five entries, the engine is untouched, and each one is removed
 * again by re-pinning the line below it. Every entry records ONE confirmed answer in the seller's own Business
 * Configuration, under a category the live schema already publishes, and moves the cursor to the step whose
 * question it writes.
 *
 * `B7_DRY_RUN` deliberately has no entry: it asserts that work was DONE, not that a decision was made, and a
 * configuration row claiming it would be self-attestation. It holds on HOLD_GATE_UNSPECIFIED, by design.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { propText, type Page } from "../../src/notion/shapes.ts";
import type { Plan } from "../../src/plans/store.ts";
import { dispatch } from "../../src/tools/handlers.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import type { ControlPlaneGrammar, DerivedCursorTransition } from "../../src/versions/adapters/controlPlane.ts";
import { registerBuiltinSalesAdapters, salesContractAdapter, type SalesContractAdapter } from "../../src/versions/adapters/sales.ts";
import { createAdapterRegistries } from "../../src/versions/registry.ts";
import { handleOf, OWNER, T0 } from "./binding-fixtures.ts";
import { synthetic, text } from "./meta-fixtures.ts";
import { buildResumeWorld, R, setRowsIn } from "./resume-fixtures.ts";
import { CONTRACT_PAGE, IDS as SALES_IDS, SGRAMMAR, SV } from "./sales-fixtures.ts";
import { executeWrites, rowsOf } from "./target-fixtures.ts";
import { stampsAt, transact as nativeTransact } from "../support/transact.ts";
import { CLASSES, G, GUARD_CONTRACT, guardWorld, index, rowsOf as guardRows } from "../support/guard-fixtures.ts";
import { MapAdapterRegistry, type SalesRuntimeAdapter } from "../../src/versions/registry.ts";
import { candidateResume } from "../../src/tools/conduct.ts";
import { prepareIntentFor, pendingStepInputOfTransition } from "../../src/resume/pendingInput.ts";

const ctx = { principal_id: OWNER.principal_id, now: T0 };
const CONFIG = "SALES:BUSINESS_CONFIG";
type Ok = Extract<Envelope, { status: "OK" }>;

function lineOf(suffix: string): SalesContractAdapter {
  const registries = createAdapterRegistries();
  registerBuiltinSalesAdapters(registries.salesRuntime);
  const v = registries.salesRuntime.supported().find((x) => x.endsWith(suffix));
  assert.ok(v, `no registered contract line ends with ${suffix}`);
  return registries.salesRuntime.resolve(v) as SalesContractAdapter;
}
const setupLine = () => lineOf("/0.5.6-candidate").grammar.controlPlane;
const offerLine = () => lineOf("/0.5.5-candidate").grammar.controlPlane;

/** Every step this lot specifies: the gate it leaves, its canonical record, and the gate it reaches. */
const STEPS = [
  { from: "B2_ICP", to: "B3_DATA", key: "B2_ICP:TARGET_ACCOUNTS", category: "ICP_INCLUDE" },
  { from: "B3_DATA", to: "B4_QUALIFICATION", key: "B3_DATA:CANONICAL_SOURCE", category: "OTHER" },
  { from: "B4_QUALIFICATION", to: "B5_OUTREACH", key: "B4_QUALIFICATION:HARD_GATE", category: "CONSTRAINT" },
  { from: "B5_OUTREACH", to: "B6_AUTHORITY", key: "B5_OUTREACH:SEQUENCE", category: "MESSAGING" },
  { from: "B6_AUTHORITY", to: "B7_DRY_RUN", key: "B6_AUTHORITY:SEND_AUTHORITY", category: "CONSTRAINT" },
] as const;

function world(opts: { controlPlane?: ControlPlaneGrammar; gate: string; answered?: { key: string; category: string } }): { w: ReturnType<typeof buildResumeWorld>; configDs: string } {
  const w = buildResumeWorld();
  const contract = "TEST_SALES_CONTRACT/1.8.0";
  const controlPlane = opts.controlPlane ?? setupLine();
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
  w.setSalesState({ gate: opts.gate, buildState: opts.gate, nextAction: "…", nextQuestion: "…" });

  const list = (results: unknown[]) => ({ results, has_more: false, next_cursor: null });
  const spec = controlPlane.resources?.[CONFIG];
  assert.ok(spec?.parentTitle);
  const parent = synthetic("b2-setup-parent"); const db = synthetic("b2-config-db"); const configDs = synthetic("b2-config-ds");
  const rootChildren = (w.map.get(`children:${ids.root}`) as { results: unknown[] }).results;
  w.map.set(`children:${ids.root}`, list([...rootChildren, { id: parent, type: "child_page", child_page: { title: spec.parentTitle } }]));
  w.map.set(`children:${parent}`, list([{ id: db, type: "child_database", child_database: { title: spec.databaseTitle } }]));
  w.map.set(`database:${db}`, { data_sources: [{ id: configDs }] });
  w.map.set(`data_source:${configDs}`, { properties: { "Config Item": { type: "title" }, Category: { type: "select" }, State: { type: "select" }, Value: { type: "rich_text" }, Version: { type: "rich_text" }, Source: { type: "rich_text" }, "Effective At": { type: "date" }, Notes: { type: "rich_text" } } });
  setRowsIn(w.map, configDs, opts.answered ? [answerRow(configDs, opts.answered.key, opts.answered.category)] : []);
  return { w, configDs };
}

const ANSWER = "Industriels français dont le process se filme ; on écarte l'hôtellerie et les purs services";

function answerRow(ds: string, key: string, category: string): Page {
  return {
    object: "page", id: synthetic(`b2-answer-${key}`), archived: false, parent: { type: "data_source_id", data_source_id: ds },
    properties: {
      "Config Item": { type: "title", title: [text(key)] },
      Category: { type: "select", select: { name: category } },
      State: { type: "select", select: { name: "CONFIRMED" } },
      Value: { type: "rich_text", rich_text: [text(ANSWER)] },
      Version: { type: "rich_text", rich_text: [text("SALES_INPUT/1")] },
      Source: { type: "rich_text", rich_text: [text("CHAT_USER_EXPLICIT")] },
    },
  };
}

const bind = async (w: ReturnType<typeof buildResumeWorld>) => handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps));

const answerIntent = (key: string, category: string) => ({
  action_class: "COMMIT", summary: `persist the seller's confirmed ${category}`,
  mutations: [{ logical_resource_key: CONFIG, operation: "UPSERT", record_selector: { natural_key: key },
    desired_changes: { Category: category, State: "CONFIRMED", Value: ANSWER, Version: "SALES_INPUT/1", Source: "CHAT_USER_EXPLICIT" } }],
});

/** The LIVE transaction (test/support/transact.ts), on fixture day 04 at minute `salt`. */
const transact = async (w: ReturnType<typeof buildResumeWorld>, h: string, intent: unknown | undefined, salt: string): Promise<Plan> => (await nativeTransact(w, h, intent, { ctx, stamps: stampsAt("04", salt) })).plan;

const servedAddress = (e: Envelope): Record<string, unknown> | undefined =>
  e.status === "OK" ? (e.result as { pending_step_input?: Record<string, unknown> }).pending_step_input : undefined;

test("PV-B2-001/a: the setup line adds exactly five catalog entries, and nothing else", () => {
  const setup = setupLine().cursorTransitions ?? [];
  const offer = offerLine().cursorTransitions ?? [];
  assert.equal(offer.length, 2, "the line below still specifies B0 and B1 alone");
  assert.equal(setup.length, 7, "B0, B1 and the five steps this lot publishes");
  // Nothing beyond the entries: no new resource, no new property, no new connector requirement.
  assert.deepEqual(Object.keys(setupLine().resources ?? {}).sort(), Object.keys(offerLine().resources ?? {}).sort());
  for (const step of STEPS) {
    const t = setup.find((x) => x.fromGate === step.from) as DerivedCursorTransition;
    assert.ok(t, `no entry leaves ${step.from}`);
    assert.equal(t.evidence.naturalKey, step.key, `${step.from} must have its own canonical record`);
    assert.equal(t.evidence.equals["Category"], step.category);
    assert.equal(t.evidence.equals["State"], "CONFIRMED");
    assert.deepEqual(t.evidence.nonEmpty, ["Value"]);
    assert.equal(t.set["Current Gate"], step.to);
    assert.equal(t.set["Build State"], step.to);
    // Each entry writes the NEXT step's question: the walk carries itself forward.
    assert.ok(String(t.set["Next Question"] ?? "").length > 10, `${step.from} must publish the question of ${step.to}`);
    // All of them move the one durable cursor every step moves.
    assert.equal(t.targetResourceKey, "SALES:OS_STATE");
    assert.equal(t.targetNaturalKey, "CURRENT");
  }
  // Every canonical record is distinct: five steps, five keys, never one row reused.
  assert.equal(new Set(setup.map((t) => t.evidence.naturalKey)).size, setup.length);
});

test("PV-B2-001/b: B7_DRY_RUN publishes no entry — it asserts work was done, not a decision made", () => {
  const setup = setupLine().cursorTransitions ?? [];
  assert.equal(setup.filter((t) => t.fromGate === "B7_DRY_RUN").length, 0);
  assert.equal(setup.filter((t) => t.fromGate === "READY").length, 0, "the end of the walk is not a missing step");
});

test("PV-B2-002/a: an open ICP step serves its own record, and the seller's answer moves the cursor to B3", async () => {
  const { w, configDs } = world({ gate: "B2_ICP" });
  const h = await bind(w);

  const resumed = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  assert.equal(resumed.code, "RESUMED", JSON.stringify(resumed));
  const served = servedAddress(resumed);
  assert.ok(served, "the line specifies this step, so resume must serve its address");
  assert.equal(served["gate_key"], "B2_ICP");
  assert.equal(served["natural_key"], "B2_ICP:TARGET_ACCOUNTS");
  assert.deepEqual(served["required_values"], { Category: "ICP_INCLUDE", State: "CONFIRMED", Version: "SALES_INPUT/1", Source: "CHAT_USER_EXPLICIT" });

  // 1. The answer becomes durable on the business record, never on the cursor.
  const capture = await transact(w, h, answerIntent("B2_ICP:TARGET_ACCOUNTS", "ICP_INCLUDE"), "10");
  assert.equal(capture.operations[0]?.logical_resource_key, CONFIG);
  assert.equal(rowsOf(w, configDs).length, 1);
  assert.equal(propText(w.map.get(`page:${R.salesStateRow}`) as Page, "Current Gate"), "B2_ICP", "a business write is not a gate movement");

  // 2. The move, derived from that verified evidence, in its own proved transaction.
  const move = await transact(w, h, undefined, "20");
  assert.equal(move.operations.length, 1, "one cursor transition, never a batch");
  assert.equal(move.operations[0]?.expected_values["Current Gate"], "B3_DATA");

  // 3. A fresh read serves the NEXT step's question, which this entry wrote.
  const moved = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  assert.equal(moved.code, "RESUMED", JSON.stringify(moved));
  const state = w.map.get(`page:${R.salesStateRow}`) as Page;
  assert.equal(propText(state, "Current Gate"), "B3_DATA");
  assert.match(propText(state, "Next Question") ?? "", /D'où viennent tes comptes/);
  assert.equal(servedAddress(moved)?.["natural_key"], "B3_DATA:CANONICAL_SOURCE", "the walk carries itself to the next record");
});

test("PV-B2-002/b: every specified step of the walk advances on its own answer, with no engine change between them", async () => {
  for (const step of STEPS) {
    const { w } = world({ gate: step.from });
    const h = await bind(w);
    await transact(w, h, answerIntent(step.key, step.category), "10");
    await transact(w, h, undefined, "20");
    assert.equal(propText(w.map.get(`page:${R.salesStateRow}`) as Page, "Current Gate"), step.to, `${step.from} did not reach ${step.to}`);
  }
});

test("PV-B2-002/c: the last specified step lands on B7_DRY_RUN, which then holds — the human boundary", async () => {
  const { w } = world({ gate: "B6_AUTHORITY" });
  const h = await bind(w);
  await transact(w, h, answerIntent("B6_AUTHORITY:SEND_AUTHORITY", "CONSTRAINT"), "10");
  await transact(w, h, undefined, "20");
  assert.equal(propText(w.map.get(`page:${R.salesStateRow}`) as Page, "Current Gate"), "B7_DRY_RUN");
  const held = await dispatch("os_prepare", { binding_handle: h }, ctx, w.deps);
  assert.equal(held.code, "HOLD_GATE_UNSPECIFIED", `a dry run is not a decision a config row may claim: ${JSON.stringify(held)}`);
});

test("PV-B2-002/d: re-pinning the OFFER line is a real rollback — the five steps disappear and B2 holds", async () => {
  const { w } = world({ controlPlane: offerLine(), gate: "B2_ICP", answered: { key: "B2_ICP:TARGET_ACCOUNTS", category: "ICP_INCLUDE" } });
  const h = await bind(w);
  const resumed = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  assert.equal(resumed.code, "RESUMED", JSON.stringify(resumed));
  assert.equal(servedAddress(resumed), undefined, "the rollback target declares no address for this step");
  const r = await dispatch("os_prepare", { binding_handle: h }, ctx, w.deps);
  assert.equal(r.code, "HOLD_GATE_UNSPECIFIED", `a satisfied predicate the prior line never published moves nothing: ${JSON.stringify(r)}`);
});

/** W6.4: actual candidate grammar on isolated TEST pins, not a live install/version/ordinary-chat proof. */
function serverWorld() {
  const grammar = lineOf("/0.5.13-candidate").grammar.controlPlane;
  const first = grammar.cursorTransitions![0]!;
  const answerFields = [...Object.keys(first.evidence.equals), ...first.evidence.nonEmpty];
  const g = guardWorld({ doc: index([], [{ class: "PRODUCTION", resource_key: CONFIG, operation: "UPSERT", allowed_fields: answerFields }, CLASSES.cursor()]) });
  const sales = new MapAdapterRegistry<SalesRuntimeAdapter>();
  for (const v of g.deps.adapters.salesRuntime.supported()) {
    const a = g.deps.adapters.salesRuntime.resolve(v) as SalesContractAdapter;
    sales.register(v, v === GUARD_CONTRACT ? salesContractAdapter(v, [SV.schema], { ...a.grammar, controlPlane: grammar }, a.capabilities) : a);
  }
  Object.assign(g.deps, { adapters: { ...g.deps.adapters, salesRuntime: sales } });
  return { g, grammar };
}

test("W6.4/a: every declared candidate step commits, then a handle-only call proves its deferred movement; neither origin is rewritten", async () => {
  for (const source of ["CHAT_USER_EXPLICIT", "AGENT_PROPOSED_USER_VALIDATED"]) {
    const { g, grammar } = serverWorld(), h = await g.bind(); await g.approve();
    assert.equal(grammar.cursorTransitions!.length, 7);
    for (const t of grammar.cursorTransitions!) {
      assert.equal(propText(guardRows(g.map, R.salesStateDs)[0]!, "Current Gate"), t.fromGate);
      const declaration = pendingStepInputOfTransition(t.fromGate, t), template = prepareIntentFor(declaration);
      const answer = { ...template, mutations: template.mutations.map(m => ({ ...m, desired_changes: { ...m.desired_changes, Value: "Décision locale validée ; aucun envoi automatique", Source: source } })) };
      const saved = await g.commit(h, { intent: answer }, { commitBudgetMs: 17_000 });
      assert.equal(saved.kind, "PERSISTED", JSON.stringify(saved)); if (saved.kind !== "PERSISTED") return;
      assert.deepEqual([saved.step_moved, saved.derived_move], [false, "DEFERRED"]);
      assert.equal((await g.deps.store.receipts.get(saved.target_receipt_id))?.status, "CONSUMED");
      assert.equal((await g.deps.store.receipts.get(saved.final_receipt_id))?.status, "VALID");
      const beforeReplay = g.client.writes.length;
      const replay = await g.commit(h, { intent: answer }, { commitBudgetMs: 17_000 });
      assert.equal(replay.kind, "PERSISTED", JSON.stringify(replay));
      if (replay.kind === "PERSISTED") assert.equal(replay.repeated, true);
      assert.equal(g.client.writes.length, beforeReplay, "identical replay must not duplicate a response or Run");
      const rows = JSON.stringify(guardRows(g.map, G.configDs));
      const resumed = candidateResume(await dispatch("os_resume", { binding_handle: h }, { principal_id: OWNER.principal_id, now: new Date(g.clock.t), candidate_resume: true }, g.deps));
      assert.equal(resumed.code, "RESUMED", JSON.stringify(resumed));
      assert.equal(resumed.ask, undefined);
      assert.equal(resumed.next.permitted_tool_call, "os_commit");
      assert.equal(resumed.next.prepare_intent, undefined);
      assert.match(resumed.next.conduct ?? "", /NO intent/);
      const move = await g.commit(h, {});
      assert.equal(move.kind, "PERSISTED", JSON.stringify(move)); if (move.kind !== "PERSISTED") return;
      assert.deepEqual([move.origin, move.step_moved, move.next_gate], ["DERIVED_MOVE", true, t.set["Current Gate"]]);
      assert.equal((await g.deps.store.receipts.get(move.target_receipt_id))?.status, "CONSUMED");
      assert.equal((await g.deps.store.receipts.get(move.final_receipt_id))?.status, "VALID");
      const plan = (await g.deps.store.plans.get(move.plan_id))!;
      assert.equal(plan.plan_state, "FINAL_VERIFIED");
      assert.ok(plan.operations.every(op => op.logical_resource_key === "SALES:OS_STATE"));
      assert.equal(g.client.writes.filter(w => w.ctx.plan_id === move.plan_id).at(-1)?.ctx.symbol, plan.state_last_write.symbol);
      assert.equal(JSON.stringify(guardRows(g.map, G.configDs)), rows, "resume and movement must not rewrite, copy or relabel a decision");
      const stored = guardRows(g.map, G.configDs).find(p => propText(p, "Config Item") === t.evidence.naturalKey)!;
      assert.equal(propText(stored, "Source"), source);
    }
    assert.equal(propText(guardRows(g.map, R.salesStateDs)[0]!, "Current Gate"), "B7_DRY_RUN");
    const before = g.client.writes.length;
    const held = await g.commit(h, {});
    assert.equal(held.kind, "HELD");
    assert.equal(held.kind === "HELD" ? held.code : undefined, "HOLD_GATE_UNSPECIFIED");
    assert.equal(g.client.writes.length, before, "B7 cannot become READY by a configuration claim");
  }
});

test("W6.4/b: a missing guard approval refuses the candidate before any Notion byte", async () => {
  const { g, grammar } = serverWorld(), h = await g.bind();
  const t = grammar.cursorTransitions![0]!, i = prepareIntentFor(pendingStepInputOfTransition(t.fromGate, t));
  const intent = { ...i, mutations: i.mutations.map(m => ({ ...m, desired_changes: { ...m.desired_changes, Value: "Réponse locale" } })) };
  const out = await g.commit(h, { intent });
  assert.equal(out.kind, "HELD");
  assert.equal(g.client.writes.length, 0);
});

test("W6.4/c: with the ordinary call budget every declared transition persists in the same os_commit", async () => {
  const { g, grammar } = serverWorld(), h = await g.bind(); await g.approve();
  for (const t of grammar.cursorTransitions!) {
    const template = prepareIntentFor(pendingStepInputOfTransition(t.fromGate, t));
    const intent = { ...template, mutations: template.mutations.map(m => ({ ...m, desired_changes: { ...m.desired_changes, Value: "Décision explicite locale" } })) };
    const out = await g.commit(h, { intent });
    assert.equal(out.kind, "PERSISTED", JSON.stringify(out)); if (out.kind !== "PERSISTED") return;
    assert.deepEqual([out.step_moved, out.derived_move, out.next_gate], [true, "PERSISTED", t.set["Current Gate"]]);
    assert.equal((await g.deps.store.plans.get(out.derived_plan_id!))?.plan_state, "FINAL_VERIFIED");
    assert.equal(propText(guardRows(g.map, R.salesStateDs)[0]!, "Current Gate"), t.set["Current Gate"]);
  }
  assert.equal(guardRows(g.map, G.configDs).length, grammar.cursorTransitions!.length);
});
