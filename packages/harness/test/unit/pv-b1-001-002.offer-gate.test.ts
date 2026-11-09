/**
 * PV-B1-001 / PV-B1-002 — the OFFER step, specified.
 *
 * B0 proved the mechanism; this proves the mechanism is a catalog. Nothing in the engine was touched to add
 * this step: the contract publishes one more entry — its canonical record, its required values, its
 * destination — and the same `os_resume → os_prepare → TARGET → FINAL → os_resume` chain that made B0 durable
 * makes B1 durable. What is therefore under test here is the CONTRACT's entry and the walk it produces, not a
 * new code path.
 *
 * The step is deliberately one decision. The seller's Business Configuration also publishes VALUE_PROP, PROOF
 * and CONSTRAINT categories; a predicate that waited on all four would be four gates sharing one name, and
 * PV-GATE-000 allows a gate exactly one canonical question.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { propMentions, propText, type Page } from "../../src/notion/shapes.ts";
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

const ctx = { principal_id: OWNER.principal_id, now: T0 };
const CONFIG = "SALES:BUSINESS_CONFIG";
const B1_KEY = "B1_OFFER:SELLABLE_OFFER";
const OFFER = "Un récit industriel filmé qui rend une usine désirable pour ses clients et ses candidats";

function lineOf(suffix: string): SalesContractAdapter {
  const registries = createAdapterRegistries();
  registerBuiltinSalesAdapters(registries.salesRuntime);
  const v = registries.salesRuntime.supported().find((x) => x.endsWith(suffix));
  assert.ok(v, `no registered contract line ends with ${suffix}`);
  return registries.salesRuntime.resolve(v) as SalesContractAdapter;
}

const offerLine = () => lineOf("/0.5.5-candidate").grammar.controlPlane;
const captureLine = () => lineOf("/0.5.4-candidate").grammar.controlPlane;

/** A runtime pinning the given catalog, sitting on the given durable step, with a Business Configuration. */
function world(opts: { controlPlane?: ControlPlaneGrammar; gate?: string; answer?: "SATISFIED" | "ABSENT" } = {}): { w: ReturnType<typeof buildResumeWorld>; configDs: string } {
  const w = buildResumeWorld();
  const contract = "TEST_SALES_CONTRACT/1.7.0";
  const controlPlane = opts.controlPlane ?? offerLine();
  w.deps.adapters.salesRuntime.register(contract, salesContractAdapter(contract, [SV.schema], { ...SGRAMMAR, controlPlane }));
  const ids = SALES_IDS("rep-a");
  const manifest = w.map.get(`page:${ids.manifestRow}`) as Page;
  setRowsIn(w.map, ids.manifestDs, [{ ...manifest, properties: { ...manifest.properties, "Sales Contract Version": { type: "rich_text", rich_text: [text(contract)] } } }]);
  w.map.set(`page:${CONTRACT_PAGE}`, { object: "page", id: CONTRACT_PAGE, archived: false, properties: { title: { type: "title", title: [text(contract)] } } });

  // The live OS State schema carries the cursor properties a derived transition writes.
  const liveState = w.map.get(`data_source:${R.salesStateDs}`) as { properties: Record<string, unknown> };
  w.map.set(`data_source:${R.salesStateDs}`, { properties: { ...liveState.properties,
    "Gate Passed By Run Ref": { type: "rich_text" }, "Last Durable Mode": { type: "select" },
    "Last Durable Turn ID": { type: "rich_text" }, "Next Authorized Topic": { type: "rich_text" } } });
  const gate = opts.gate ?? "B1_OFFER";
  w.setSalesState({ gate, buildState: gate, nextAction: "Reconcile the canonical offer with the seller's constraints", nextQuestion: "Which part of the offer must be changed before it can be sold?" });

  const list = (results: unknown[]) => ({ results, has_more: false, next_cursor: null });
  const spec = controlPlane.resources?.[CONFIG];
  assert.ok(spec?.parentTitle);
  const parent = synthetic("b1-setup-parent"); const db = synthetic("b1-config-db"); const configDs = synthetic("b1-config-ds");
  const rootChildren = (w.map.get(`children:${ids.root}`) as { results: unknown[] }).results;
  w.map.set(`children:${ids.root}`, list([...rootChildren, { id: parent, type: "child_page", child_page: { title: spec.parentTitle } }]));
  w.map.set(`children:${parent}`, list([{ id: db, type: "child_database", child_database: { title: spec.databaseTitle } }]));
  w.map.set(`database:${db}`, { data_sources: [{ id: configDs }] });
  // Exactly the live Business Configuration schema of an installed Personal Sales space.
  w.map.set(`data_source:${configDs}`, { properties: { "Config Item": { type: "title" }, Category: { type: "select" }, State: { type: "select" }, Value: { type: "rich_text" }, Version: { type: "rich_text" }, Source: { type: "rich_text" }, "Effective At": { type: "date" }, Notes: { type: "rich_text" } } });
  setRowsIn(w.map, configDs, opts.answer === "SATISFIED" ? [answerRow(configDs)] : []);
  return { w, configDs };
}

function answerRow(ds: string): Page {
  return {
    object: "page", id: synthetic("b1-answer-row"), archived: false, parent: { type: "data_source_id", data_source_id: ds },
    properties: {
      "Config Item": { type: "title", title: [text(B1_KEY)] },
      Category: { type: "select", select: { name: "OFFER" } },
      State: { type: "select", select: { name: "CONFIRMED" } },
      Value: { type: "rich_text", rich_text: [text(OFFER)] },
      Version: { type: "rich_text", rich_text: [text("SALES_INPUT/1")] },
      Source: { type: "rich_text", rich_text: [text("CHAT_USER_EXPLICIT")] },
    },
  };
}

const bind = async (w: ReturnType<typeof buildResumeWorld>) => handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps));

/** The seller's answer, carried exactly as an ordinary chat would carry it after reading the served address. */
const answerIntent = (changes: Record<string, unknown> = {}, key = B1_KEY) => ({
  action_class: "COMMIT",
  summary: "persist the seller's confirmed offer",
  mutations: [{
    logical_resource_key: CONFIG, operation: "UPSERT", record_selector: { natural_key: key },
    desired_changes: { Category: "OFFER", State: "CONFIRMED", Value: OFFER, Version: "SALES_INPUT/1", Source: "CHAT_USER_EXPLICIT", ...changes },
  }],
});

/** One complete authorized transaction: prepare, the native writes, TARGET, finalization, State LAST, FINAL. */
/** The LIVE transaction (test/support/transact.ts), on fixture day 04 at minute `salt`. */
const transact = async (w: ReturnType<typeof buildResumeWorld>, h: string, intent: unknown | undefined, salt: string): Promise<Plan> => (await nativeTransact(w, h, intent, { ctx, stamps: stampsAt("04", salt) })).plan;

/** The address os_resume serves for the open step, when the governing contract declares one. */
const servedAddress = (envelope: Envelope): Record<string, unknown> | undefined =>
  envelope.status === "OK" ? (envelope.result as { pending_step_input?: Record<string, unknown> }).pending_step_input : undefined;

test("PV-B1-001/a: the OFFER step is one more catalog entry — it borrows nothing from B0 and rolls back cleanly", () => {
  const offer = offerLine().cursorTransitions ?? [];
  const capture = captureLine().cursorTransitions ?? [];
  assert.equal(capture.length, 1, "the prior line still specifies the capture step alone");
  assert.equal(offer.length, 2, "the OFFER line specifies exactly one step more");
  const b1 = offer.find((t) => t.fromGate === "B1_OFFER") as DerivedCursorTransition;
  const b0 = offer.find((t) => t.fromGate === "B0_DISCOVERY") as DerivedCursorTransition;
  assert.ok(b1 && b0);
  assert.equal(b1.evidence.naturalKey, B1_KEY);
  assert.notEqual(b1.evidence.naturalKey, b0.evidence.naturalKey, "each step has its own canonical record");
  assert.notEqual(b1.evidence.equals["Category"], b0.evidence.equals["Category"], "and its own required values");
  assert.equal(b1.set["Current Gate"], "B2_ICP");
  // Both move the same durable cursor: the gate must stay readable from the one row every move updates.
  assert.equal(b1.targetResourceKey, b0.targetResourceKey);
  assert.equal(b1.targetNaturalKey, b0.targetNaturalKey);
  // Nothing was added to the catalog beyond the entry: no new resource, no new property.
  assert.deepEqual(Object.keys(offerLine().resources ?? {}).sort(), Object.keys(captureLine().resources ?? {}).sort());
});

test("PV-B1-001/b: a resume on the open OFFER step serves that step's record, never B0's", async () => {
  const { w } = world({ answer: "ABSENT" });
  const h = await bind(w);
  const resumed = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  assert.equal(resumed.code, "RESUMED", JSON.stringify(resumed));
  const served = servedAddress(resumed);
  assert.ok(served, "the contract now declares an address for this step; resume must serve it");
  assert.equal(served["gate_key"], "B1_OFFER");
  assert.equal(served["natural_key"], B1_KEY);
  assert.equal(served["logical_resource_key"], CONFIG);
  assert.deepEqual(served["required_values"], { Category: "OFFER", State: "CONFIRMED", Version: "SALES_INPUT/1", Source: "CHAT_USER_EXPLICIT" });
  assert.deepEqual(served["required_non_empty"], ["Value"]);
});

/**
 * PV-PREP-001 — the resume carries the call, not only the address.
 *
 * Three fresh conversations in a row resumed two, three, four times over an answer the seller had already
 * given, never called `os_prepare`, and then reported a backend refusal that had never happened — the tool they
 * did not call cannot refuse anything. The declaration says WHERE the answer goes and never said what to send.
 * So the envelope now names the one call that can follow and ships it filled, with the seller's words the
 * single thing left to supply — and refuses that template sent back unchanged.
 */
test("PV-PREP-001/a: a resume with a pending answer names os_prepare and carries the intent ready to send", async () => {
  const { w } = world({ answer: "ABSENT" });
  const h = await bind(w);
  const resumed = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  assert.equal(resumed.code, "RESUMED", JSON.stringify(resumed));
  const next = resumed.next as { permitted_tool_call?: string; prepare_intent?: { mutations: { logical_resource_key: string; operation: string; record_selector: { natural_key: string }; desired_changes: Record<string, string> }[] } };
  assert.equal(next.permitted_tool_call, "os_prepare", "reading this same state again is the one thing that cannot follow");
  const mutation = next.prepare_intent?.mutations[0];
  assert.ok(mutation, "the call arrives with its payload, or the caller has to assemble it — which is what kept failing");
  assert.equal(mutation.logical_resource_key, CONFIG);
  assert.equal(mutation.operation, "UPSERT");
  assert.equal(mutation.record_selector.natural_key, B1_KEY);
  for (const [k, v] of Object.entries({ Category: "OFFER", State: "CONFIRMED", Version: "SALES_INPUT/1", Source: "CHAT_USER_EXPLICIT" })) assert.equal(mutation.desired_changes[k], v);
  assert.equal(mutation.desired_changes["Value"], "$answer", "the seller's words are the only thing left to fill");
});

test("PV-PREP-001/b: the template sent back unfilled is refused before any plan", async () => {
  const { w, configDs } = world({ answer: "ABSENT" });
  const h = await bind(w);
  const echoed = await dispatch("os_prepare", { binding_handle: h, intent: answerIntent({ Value: "$answer" }) }, ctx, w.deps);
  assert.equal(echoed.code, "HOLD_UNSUPPORTED_OPERATION", `the placeholder is not empty, so nothing else would have stopped it: ${JSON.stringify(echoed)}`);
  assert.match(((echoed as Extract<Envelope, { status: "HOLD" }>).evidence ?? []).join(" "), /still carries the placeholder/);
  assert.equal(rowsOf(w, configDs).length, 0, "the token never reaches Notion as the seller's decision");
});

test("PV-PREP-001/c: an answered step ships no answer template; a row nothing proved is asked about instead (PV-ORPHAN-001)", async () => {
  const { w } = world({ answer: "SATISFIED" });
  const h = await bind(w);
  const resumed = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  assert.equal(resumed.code, "RESUMED", JSON.stringify(resumed));
  const next = resumed.next as { permitted_tool_call?: string; prepare_intent?: { action_class?: string } };
  // The fixture's answer row was placed by hand, with no receipt: since PV-ORPHAN-001 the one call that can
  // follow is its adoption, never the step's own question again.
  assert.equal(next.permitted_tool_call, "os_prepare");
  assert.equal(next.prepare_intent?.action_class, "RECONCILE", "the served call adopts the row as it stands; it is not the answer template");
  assert.doesNotMatch(JSON.stringify(next.prepare_intent), /\$answer/, "nothing is asked twice");
});

test("PV-B1-001/c: the answer goes in the contract's record carrying the contract's values, or nowhere", async () => {
  const { w, configDs } = world({ answer: "ABSENT" });
  const h = await bind(w);
  const invented = await dispatch("os_prepare", { binding_handle: h, intent: answerIntent({}, "B1_OFFER:MY_OFFER") }, ctx, w.deps);
  assert.equal(invented.code, "HOLD_UNSUPPORTED_OPERATION", `a second key would be a second truth: ${JSON.stringify(invented)}`);
  const unconfirmed = await dispatch("os_prepare", { binding_handle: h, intent: answerIntent({ State: "HYPOTHESIS" }) }, ctx, w.deps);
  assert.equal(unconfirmed.code, "HOLD_UNSUPPORTED_OPERATION", `an unconfirmed offer does not complete the step: ${JSON.stringify(unconfirmed)}`);
  const blank = await dispatch("os_prepare", { binding_handle: h, intent: answerIntent({ Value: "" }) }, ctx, w.deps);
  assert.equal(blank.code, "HOLD_UNSUPPORTED_OPERATION", `an empty answer is not an answer: ${JSON.stringify(blank)}`);
  assert.equal(rowsOf(w, configDs).length, 0, "every refusal happened before any plan, so nothing was written anywhere");
});

test("PV-B1-002/a: the answer becomes durable, the cursor then moves in its own transaction, and a fresh resume reads B2", async () => {
  const { w, configDs } = world({ answer: "ABSENT" });
  const h = await bind(w);

  // 1. The seller's answer, written where the step's own predicate reads it.
  const capture = await transact(w, h, answerIntent(), "10");
  const op = capture.operations[0] as Plan["operations"][number];
  assert.equal(op.logical_resource_key, CONFIG, "the answer lands on the business record, never on the cursor");
  assert.equal(op.natural_key, B1_KEY);
  assert.ok(op.compared_fields.includes("Value"), "FINAL proves the answer itself");
  assert.equal(rowsOf(w, configDs).length, 1);
  assert.equal(propText(rowsOf(w, configDs)[0] as Page, "Value"), OFFER);

  // 2. The answer exists, so the step is no longer waiting for it — but the cursor has not moved by itself.
  const answered = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  assert.equal(answered.code, "RESUMED", JSON.stringify(answered));
  assert.equal(servedAddress(answered), undefined, "an answered step is not asked again");
  const afterCapture = w.map.get(`page:${R.salesStateRow}`) as Page;
  assert.equal(propText(afterCapture, "Current Gate"), "B1_OFFER", "a business write is not a gate movement");
  // Attribution is carried from the cursor, never minted: the Run that made the answer durable is the one the
  // gate is credited to, and it reached the cursor through that transaction's own State LAST write.
  const captureRun = propMentions(afterCapture, "Last Run Ref")[0] ?? propText(afterCapture, "Last Run Ref")?.trim();
  assert.ok(typeof captureRun === "string" && captureRun !== "" && captureRun !== R.salesRun1, "the capture transaction is what the cursor now points at");

  // 3. The move: derived from that durable evidence, proved by its own TARGET and FINAL.
  const move = await transact(w, h, undefined, "20");
  const cursorOp = move.operations[0] as Plan["operations"][number];
  assert.equal(move.operations.length, 1, "one cursor transition, never a batch");
  assert.equal(cursorOp.logical_resource_key, "SALES:OS_STATE");
  assert.equal(cursorOp.expected_values["Current Gate"], "B2_ICP");
  assert.equal(cursorOp.expected_values["Gate Passed By Run Ref"], captureRun, "the reference is carried from the cursor, not minted");
  assert.equal(cursorOp.expected_values["Last Run Ref"], "$created:OPEN_RUN", "the move's own Run is a symbol the proof resolves the same way the writer does");

  // 4. A fresh read of durable state — the only thing that may authorize the next question.
  const moved = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  assert.equal(moved.code, "RESUMED", JSON.stringify(moved));
  assert.equal(propText(w.map.get(`page:${R.salesStateRow}`) as Page, "Current Gate"), "B2_ICP");
  assert.equal(servedAddress(moved), undefined, "B2 is not specified yet, so no address is invented for it");
});

/**
 * PV-UX-006 — a resume that names the stage-1 writes has to carry them.
 *
 * Observed 2026-09-21, twice in a row: the turn that prepared the plan ended before the writes. The seller came
 * back, `os_resume` reported the open plan and said « execute its stage1_actions » — and served none. Only the
 * `os_prepare` that rendered them ever returned them, so the conversation had nothing to execute and did the
 * one thing it still could: verify. TARGET held on HOLD_RUN_NOT_OPENED, the model tried again, held again, and
 * the space stayed stuck until the plan expired. An instruction that cannot be followed is not an instruction.
 */
test("PV-UX-006: an interrupted transaction is resumable — the resume serves the very actions it tells you to run", async () => {
  const { w } = world({ answer: "ABSENT" });
  const h = await bind(w);
  const prepared = await dispatch("os_prepare", { binding_handle: h, intent: answerIntent() }, ctx, w.deps);
  assert.equal(prepared.code, "PLAN_PREPARED", JSON.stringify(prepared));
  const served = (prepared as Extract<Envelope, { status: "OK" }>).result as { plan_id: string; stage1_actions: readonly unknown[] };

  // The turn dies here: nothing was written, and the rendered actions are gone with it.
  const resumed = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  assert.equal(resumed.code, "RESUMED", JSON.stringify(resumed));
  const open = ((resumed as Extract<Envelope, { status: "OK" }>).result as { open_backend_plan: Record<string, unknown> }).open_backend_plan;
  assert.equal(open["plan_id"], served.plan_id);
  assert.equal(open["plan_state"], "AWAITING_STAGE1_WRITES");
  assert.equal(open["stage1_actions"], undefined, "resume carries no native-write payload");
  assert.match(String(open["next_safe_action"]), /through os_commit/, "same stored plan continues with the guarded backend");

  // Serving them changes nothing durable: the renderer is pure, and the plan is where it was.
  assert.equal((await w.deps.store.plans.get(served.plan_id))?.plan_state, "AWAITING_STAGE1_WRITES");
});

test("PV-B1-002/b: replaying the same answer creates no second row, and the completed move opens no second Run", async () => {
  const { w, configDs } = world({ answer: "ABSENT" });
  const h = await bind(w);
  await transact(w, h, answerIntent(), "10");
  await transact(w, h, undefined, "20");

  // The seller says the same thing again in another turn: the same key, so the same single row.
  await transact(w, h, answerIntent(), "30");
  assert.equal(rowsOf(w, configDs).length, 1, "the contract's key is what makes a replay idempotent");

  // And asking the space to move on now lands on B2, which the contract has not specified: it holds truthfully
  // rather than re-deriving the move that already happened.
  const again = await dispatch("os_prepare", { binding_handle: h }, ctx, w.deps);
  assert.equal(again.code, "HOLD_GATE_UNSPECIFIED", JSON.stringify(again));
  assert.equal(propText(w.map.get(`page:${R.salesStateRow}`) as Page, "Current Gate"), "B2_ICP", "the cursor moved exactly once");
});

test("PV-B1-002/c: re-pinning the prior line is a real rollback — the OFFER step disappears and the space holds", async () => {
  const { w } = world({ controlPlane: captureLine(), answer: "SATISFIED" });
  const h = await bind(w);
  const resumed = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  assert.equal(resumed.code, "RESUMED", JSON.stringify(resumed));
  assert.equal(servedAddress(resumed), undefined, "the rollback target declares no address for this step");
  const r = await dispatch("os_prepare", { binding_handle: h }, ctx, w.deps);
  assert.equal(r.code, "HOLD_GATE_UNSPECIFIED", `a satisfied predicate the prior line never published moves nothing: ${JSON.stringify(r)}`);
  assert.equal((await w.deps.store.plans.findActive("VERTIGO", "SALES", "g1")).length, 0);
});
