/**
 * PV-B0-002 — the canonical B0 completion and cursor transition.
 *
 * The contract makes a verified, unique BUSINESS_CONFIG answer row the complete B0 predicate, and requires a
 * SEPARATE verified UPDATE against the OS State CURRENT row to move the cursor to B1. Every value is derived by
 * the backend from durable state or fixed by the contract: a caller may not declare a gate.
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

const ctx = { principal_id: OWNER.principal_id, now: T0 };
const OS_STATE = "SALES:OS_STATE";
const CONFIG = "SALES:BUSINESS_CONFIG";
const B0_KEY = "B0_DISCOVERY:PRIMARY_OUTCOME";
const OUTCOME = "Obtenir trois rendez-vous qualifiés par mois avec des industriels français";
/**
 * PV-B0-002A's revised exact compared field-set. `Last Run Ref` is the stable durable identity of the transition
 * itself and is proved; `Last Verified Mutation` is finalizer-stamped provenance and `Last Durable Turn ID`
 * needs a stable external turn identifier this architecture does not have — both are excluded.
 */
const COMPARED = [
  "Build State", "Current Gate", "Current Gate Status", "Gate Passed By Run Ref", "Last Durable Mode",
  "Last Run Ref", "Name", "Next Action", "Next Authorized Topic",
  "Next Question", "Persistence Health", "Recovery Required",
];

function captureLine(): SalesContractAdapter {
  const registries = createAdapterRegistries();
  registerBuiltinSalesAdapters(registries.salesRuntime);
  const v = registries.salesRuntime.supported().find((x) => x.endsWith("/0.5.4-candidate"));
  assert.ok(v);
  return registries.salesRuntime.resolve(v) as SalesContractAdapter;
}

/** The B0 answer row exactly as PV-B0-001 writes it. `satisfied=false` breaks one predicate field. */
function answerRow(ds: string, satisfied = true, id = "b0-answer-row", key = B0_KEY, category = "GOAL"): Page {
  return {
    object: "page", id: synthetic(id), archived: false, parent: { type: "data_source_id", data_source_id: ds },
    properties: {
      "Config Item": { type: "title", title: [text(key)] },
      Category: { type: "select", select: { name: category } },
      State: { type: "select", select: { name: satisfied ? "CONFIRMED" : "HYPOTHESIS" } },
      Value: { type: "rich_text", rich_text: [text(OUTCOME)] },
      Version: { type: "rich_text", rich_text: [text("SALES_INPUT/1")] },
      Source: { type: "rich_text", rich_text: [text("CHAT_USER_EXPLICIT")] },
    },
  };
}

/**
 * `controlPlane`, `gate`, `answerKey` and `answerCategory` exist so the very same world can be built around a
 * transition the governing contract declares for a DIFFERENT step. Nothing in the engine is allowed to know B0.
 */
function world(opts: { answer?: "SATISFIED" | "INCOMPLETE" | "ABSENT" | "DUPLICATE"; current?: "ONE" | "NONE" | "TWO"; controlPlane?: ControlPlaneGrammar; gate?: string; answerKey?: string; answerCategory?: string } = {}): { w: ReturnType<typeof buildResumeWorld>; configDs: string } {
  const w = buildResumeWorld();
  const contract = "TEST_SALES_CONTRACT/1.6.0";
  const controlPlane = opts.controlPlane ?? captureLine().grammar.controlPlane;
  w.deps.adapters.salesRuntime.register(contract, salesContractAdapter(contract, [SV.schema], { ...SGRAMMAR, controlPlane }));
  const ids = SALES_IDS("rep-a");
  const manifest = w.map.get(`page:${ids.manifestRow}`) as Page;
  setRowsIn(w.map, ids.manifestDs, [{ ...manifest, properties: { ...manifest.properties, "Sales Contract Version": { type: "rich_text", rich_text: [text(contract)] } } }]);
  w.map.set(`page:${CONTRACT_PAGE}`, { object: "page", id: CONTRACT_PAGE, archived: false, properties: { title: { type: "title", title: [text(contract)] } } });

  // Mirror the live OS State schema: the cursor properties PV-B0-002 writes all exist in production.
  const liveState = (w.map.get(`data_source:${R.salesStateDs}`) as { properties: Record<string, unknown> });
  w.map.set(`data_source:${R.salesStateDs}`, { properties: { ...liveState.properties,
    "Gate Passed By Run Ref": { type: "rich_text" }, "Last Durable Mode": { type: "select" },
    "Last Durable Turn ID": { type: "rich_text" }, "Next Authorized Topic": { type: "rich_text" } } });
  const gate = opts.gate ?? "B0_DISCOVERY";
  w.setSalesState({ gate, buildState: gate, nextAction: "Cadrer le résultat commercial prioritaire", nextQuestion: "Quel résultat commercial concret veux-tu obtenir en priorité ?" });
  if (opts.current === "NONE") setRowsIn(w.map, R.salesStateDs, []);
  if (opts.current === "TWO") {
    const dup = { ...(w.map.get(`page:${R.salesStateRow}`) as Page), id: synthetic("sales-state-row-2") };
    w.map.set(`page:${dup.id}`, dup);
    setRowsIn(w.map, R.salesStateDs, [...rowsOf(w, R.salesStateDs), dup]);
  }

  const list = (results: unknown[]) => ({ results, has_more: false, next_cursor: null });
  const spec = controlPlane.resources?.[CONFIG];
  assert.ok(spec?.parentTitle);
  const parent = synthetic("b2-setup-parent"); const db = synthetic("b2-config-db"); const configDs = synthetic("b2-config-ds");
  const rootChildren = (w.map.get(`children:${ids.root}`) as { results: unknown[] }).results;
  w.map.set(`children:${ids.root}`, list([...rootChildren, { id: parent, type: "child_page", child_page: { title: spec.parentTitle } }]));
  w.map.set(`children:${parent}`, list([{ id: db, type: "child_database", child_database: { title: spec.databaseTitle } }]));
  w.map.set(`database:${db}`, { data_sources: [{ id: configDs }] });
  w.map.set(`data_source:${configDs}`, { properties: { "Config Item": { type: "title" }, Category: { type: "select" }, State: { type: "select" }, Value: { type: "rich_text" }, Version: { type: "rich_text" }, Source: { type: "rich_text" }, "Effective At": { type: "date" }, Notes: { type: "rich_text" } } });
  const answer = opts.answer ?? "SATISFIED";
  const key = opts.answerKey ?? B0_KEY; const category = opts.answerCategory ?? "GOAL";
  const answerRows = answer === "ABSENT" ? []
    : answer === "DUPLICATE" ? [answerRow(configDs, true, "b0-answer-row", key, category), answerRow(configDs, true, "b0-answer-row-2", key, category)]
    : [answerRow(configDs, answer === "SATISFIED", "b0-answer-row", key, category)];
  setRowsIn(w.map, configDs, answerRows);
  return { w, configDs };
}

const bind = async (w: ReturnType<typeof buildResumeWorld>) => handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps));
/** The transition is requested the same way an installation step is: os_prepare with no caller intent. */
const requestTransition = (w: ReturnType<typeof buildResumeWorld>, h: string, now = T0) => dispatch("os_prepare", { binding_handle: h }, { ...ctx, now }, w.deps);

test("PV-B0-002/a: the derived transition writes exactly the canonical fields and compares exactly the canonical set", async () => {
  const { w } = world();
  const h = await bind(w);
  const prepared = await requestTransition(w, h);
  assert.equal(prepared.code, "PLAN_PREPARED", JSON.stringify(prepared));
  const plan = await w.deps.store.plans.get(((prepared as Extract<Envelope, { status: "OK" }>).result as { plan_id: string }).plan_id) as Plan;
  assert.equal(plan.operations.length, 1, "one cursor transition, never a batch");
  const op = plan.operations[0] as Plan["operations"][number];
  assert.equal(op.logical_resource_key, OS_STATE);
  assert.equal(op.operation, "UPDATE", "the cursor row is updated, never created");
  assert.equal(op.natural_key, "CURRENT");
  assert.deepEqual([...op.compared_fields].sort(), COMPARED);

  const e = op.expected_values;
  assert.equal(e["Name"], "CURRENT");
  assert.equal(e["Current Gate"], "B1_OFFER");
  assert.equal(e["Build State"], "B1_OFFER");
  assert.equal(e["Current Gate Status"], "OPEN");
  assert.equal(e["Last Durable Mode"], "INTAKE");
  assert.equal(e["Next Authorized Topic"], "B1_OFFER");
  // The canonical OFFER question of the 0.5.5 contract page (PV-B1-001), not the English question the catalog had drifted to.
  assert.equal(e["Next Action"], "Énoncer l'offre précise à vendre et le signe que le client voit quand elle a marché");
  assert.equal(e["Next Question"], "Quelle offre précise veux-tu vendre, et à quoi le client voit qu'elle a marché ?");
  assert.equal(e["Persistence Health"], "PASS");
  assert.equal(e["Recovery Required"], false);
  // References are carried from the durable cursor the B0 transaction already wrote, never invented.
  // The run that satisfied B0 is preserved; the transition's own run becomes the stable durable identity.
  assert.equal(e["Gate Passed By Run Ref"], R.salesRun1);
  assert.equal(e["Last Run Ref"], "$created:OPEN_RUN", "the transition's own run is the cursor's durable identity");
  assert.equal(Object.hasOwn(e, "Last Durable Turn ID"), false, "no stable external turn identifier exists, so the field is not written");
  assert.equal(Object.hasOwn(e, "Last Verified Mutation"), false, "finalizer-stamped provenance, never caller-compared");
  assert.ok(plan.state_last_write.fields["Last Verified Mutation"] !== undefined, "the finalizer still stamps the transition's verified mutation");
  assert.equal(plan.state_last_write.fields["Last Run Ref"], undefined, "the plan already proves the run reference on the cursor");
  // Timestamps are writer-resolved and excluded from the proof.
  for (const stamp of ["Last Verified At", "Last Required Written At"]) {
    assert.equal(e[stamp], "$now", `${stamp} must be resolved by the writer, not frozen into the plan`);
    assert.ok(!op.compared_fields.includes(stamp), `${stamp} is excluded from the exact comparison`);
  }
});

test("PV-B0-002/g: the one shared observer of the completion predicate decides both readers", async () => {
  // A satisfied predicate authorizes the transition intent AND answers the step, so the pending input the same
  // declaration publishes is no longer served: one observation, never two opinions about the same row.
  const { w: satisfied } = world();
  const hs = await bind(satisfied);
  const resumedSatisfied = await dispatch("os_resume", { binding_handle: hs }, ctx, satisfied.deps);
  assert.equal(resumedSatisfied.code, "RESUMED", JSON.stringify(resumedSatisfied));
  assert.equal(Object.hasOwn(resumedSatisfied.result as object, "pending_step_input"), false, "the answer exists durably; its address must not be served again");
  assert.equal((await requestTransition(satisfied, hs)).code, "PLAN_PREPARED", "the same satisfied predicate authorizes the cursor transition");

  // Two rivals for the contract's key prove nothing: the transition still refuses rather than guessing.
  const { w: duplicated } = world({ answer: "DUPLICATE" });
  const hd = await bind(duplicated);
  const held = await requestTransition(duplicated, hd);
  assert.equal(held.status, "HOLD", JSON.stringify(held));
  assert.equal(held.code, "HOLD_TARGET_AMBIGUOUS", JSON.stringify(held));
  assert.ok(JSON.stringify(held.evidence ?? []).includes(B0_KEY), "the refusal names the canonical key it could not prove");
  assert.equal((await duplicated.deps.store.plans.findActive("VERTIGO", "SALES", "g1")).length, 0, "an unprovable answer opens no plan");
});

test("PV-B0-002/b: a caller can never declare a gate — the cursor resource refuses raw intent before any plan", async () => {
  const { w } = world();
  const h = await bind(w);
  const forged = await dispatch("os_prepare", { binding_handle: h, intent: {
    action_class: "COMMIT", summary: "advance the gate",
    mutations: [{ logical_resource_key: OS_STATE, operation: "UPDATE", record_selector: { natural_key: "CURRENT" }, desired_changes: { "Current Gate": "READY", "Build State": "READY" } }],
  } }, ctx, w.deps);
  assert.equal(forged.status, "HOLD", JSON.stringify(forged));
  assert.equal((await w.deps.store.plans.findActive("VERTIGO", "SALES", "g1")).length, 0, "a forged gate opens no plan, Run or lease");
  const spec = captureLine().grammar.controlPlane.resources?.[OS_STATE];
  assert.deepEqual(spec?.operations, ["UPDATE"], "the cursor resource is UPDATE-only");
  assert.equal(spec?.backendDerivedOnly, true);
});

test("PV-B0-002/c: the transition is gated on the verified B0 predicate, not on being asked", async () => {
  for (const answer of ["ABSENT", "INCOMPLETE"] as const) {
    const { w } = world({ answer });
    const h = await bind(w);
    const r = await requestTransition(w, h);
    assert.notEqual(r.code, "PLAN_PREPARED", `${answer}: an unverified B0 answer must not move the cursor: ${JSON.stringify(r)}`);
    assert.equal((await w.deps.store.plans.findActive("VERTIGO", "SALES", "g1")).length, 0, `${answer}: no plan is opened`);
  }
});

test("PV-B0-002/d: zero or duplicate CURRENT rows hold instead of guessing the cursor", async () => {
  for (const [current, expected] of [["NONE", "HOLD_TARGET_NOT_FOUND"], ["TWO", "HOLD_TARGET_AMBIGUOUS"]] as const) {
    const { w } = world({ current });
    const h = await bind(w);
    const r = await requestTransition(w, h);
    assert.equal(r.status, "HOLD", `${current}: ${JSON.stringify(r)}`);
    assert.equal(r.code, expected, `${current}: ${JSON.stringify(r)}`);
  }
});

test("PV-B0-002/e: the transition completes, a fresh resume reads B1 back, and a replay opens no second Run", async () => {
  const { w } = world();
  const h = await bind(w);
  const prepared = await requestTransition(w, h);
  const plan = await w.deps.store.plans.get(((prepared as Extract<Envelope, { status: "OK" }>).result as { plan_id: string }).plan_id) as Plan;
  const symbols = executeWrites(w, plan.stage1_writes, plan.plan_id, { now: "2030-01-03T00:30:00.000Z" });
  const target = await dispatch("os_verify", { binding_handle: h, plan_id: plan.plan_id, phase: "TARGET" }, ctx, w.deps);
  assert.equal(target.code, "TARGET_VERIFIED", JSON.stringify(target));
  const receipt = ((target as Extract<Envelope, { status: "OK" }>).result as { target_receipt_id: string }).target_receipt_id;
  const observed = (target.observations["symbols"] as Record<string, string> | undefined) ?? symbols;
  executeWrites(w, plan.finalization_writes, plan.plan_id, { ...({ now: "2030-01-03T00:31:00.000Z" }), created: observed, target_receipt_id: receipt });
  executeWrites(w, [plan.state_last_write], plan.plan_id, { ...({ now: "2030-01-03T00:32:00.000Z" }), created: observed, target_receipt_id: receipt });
  const final = await dispatch("os_verify", { binding_handle: h, plan_id: plan.plan_id, phase: "FINAL" }, ctx, w.deps);
  assert.equal(final.code, "TRANSACTION_VERIFIED", JSON.stringify(final));
  // This transaction wrote the cursor, so the reply says the step moved and its conduct is « resume and speak »,
  // never a second derived os_prepare (PV-CONDUCT-001).
  assert.equal(((final as Extract<Envelope, { status: "OK" }>).result as { step_moved?: boolean }).step_moved, true);
  assert.match(final.next.conduct ?? "", /The durable step has moved\. Call os_resume now/);

  const cursor = w.map.get(`page:${R.salesStateRow}`) as Page;
  assert.equal(propText(cursor, "Current Gate"), "B1_OFFER");
  assert.equal(propText(cursor, "Build State"), "B1_OFFER");
  assert.equal(rowsOf(w, R.salesStateDs).length, 1, "the cursor row is never duplicated");

  // A brand-new chat reads the verified CURRENT and is past B0.
  const h2 = await bind(w);
  const resumed = await dispatch("os_resume", { binding_handle: h2 }, ctx, w.deps);
  assert.equal(resumed.code, "RESUMED", JSON.stringify(resumed));
  assert.equal((resumed.result as { gate: { gate_key: string } }).gate.gate_key, "B1_OFFER", "a fresh resume must not re-ask B0");

  // Asking again with the cursor already at B1 no longer derives the same transition.
  assert.notEqual((await requestTransition(w, h2)).code, "PLAN_PREPARED", "the transition does not re-fire once the cursor moved");
});

test("PV-B0-002/f: an interrupted transition is continued by observation, never re-derived or duplicated", async () => {
  const { w } = world();
  const h = await bind(w);
  const prepared = await requestTransition(w, h);
  const planA = await w.deps.store.plans.get(((prepared as Extract<Envelope, { status: "OK" }>).result as { plan_id: string }).plan_id) as Plan;
  executeWrites(w, planA.stage1_writes, planA.plan_id, { now: "2030-01-03T00:30:00.000Z" });
  const runsAfterFirst = rowsOf(w, R.salesRunsDs).length;

  const later = new Date(T0.getTime() + 16 * 60_000);
  assert.equal((await dispatch("os_verify", { binding_handle: h, plan_id: planA.plan_id, phase: "TARGET" }, { ...ctx, now: later }, w.deps)).code, "HOLD_PLAN_EXPIRED");

  // The cursor now durably reads B1, so the predicate no longer fires: re-deriving would be wrong, and does not
  // happen. Recovery is the backend-directed continuation, which observes the durable write instead.
  const h2 = await bind(w);
  const resumed = await dispatch("os_resume", { binding_handle: h2 }, { ...ctx, now: later }, w.deps);
  assert.equal(resumed.code, "HOLD_RECOVERY_REQUIRED", JSON.stringify(resumed));
  const open = resumed.observations["open_backend_plan"] as { plan_id: string; owned_by_caller: boolean; expired: boolean };
  assert.equal(open.plan_id, planA.plan_id);
  assert.equal(open.owned_by_caller, true);
  assert.equal(open.expired, true);
  assert.equal(resumed.next.permitted_tool_call, "os_verify");
  assert.notEqual((await requestTransition(w, h2, later)).code, "PLAN_PREPARED", "a moved cursor never re-derives the same transition");

  const recovered = await dispatch("os_verify", { binding_handle: h2, plan_id: planA.plan_id, phase: "TARGET" }, { ...ctx, now: later }, w.deps);
  assert.equal(recovered.code, "PLAN_PREPARED", JSON.stringify(recovered));
  const planB = await w.deps.store.plans.get(((recovered as Extract<Envelope, { status: "OK" }>).result as { plan_id: string }).plan_id) as Plan;
  assert.notEqual(planB.plan_id, planA.plan_id, "recovery issues a new binding-scoped plan and never adopts the old one");
  assert.equal(planB.run_mode, "RECOVER_EXISTING");
  assert.deepEqual(planB.stage1_writes.map((s) => s.symbol), ["RESUME_RUN"], "the durable cursor write is observed, not repeated");
  assert.equal(rowsOf(w, R.salesRunsDs).length, runsAfterFirst, "recovery opens no second Run");
  assert.equal(rowsOf(w, R.salesStateDs).length, 1, "the cursor row is never duplicated");
});

/* ── The canonical input key, falsified against the fresh replay of 2026-09-19 ──────────────────────────────
 * That replay bound SALES on the clarified contract, was asked the B0 question, and wrote the answer to
 * SALES:BUSINESS_CONFIG under the caller's own key `PRIMARY_COMMERCIAL_GOAL`. The engine accepted it, so the
 * completion predicate — which reads the contract's key — stayed unsatisfied, the derived transition correctly
 * declined, and the step never moved. A generic mutation engine had created a parallel truth for a pending
 * input whose key the governing contract fixes.
 */
const CANONICAL = { Category: "GOAL", State: "CONFIRMED", Value: OUTCOME, Version: "SALES_INPUT/1", Source: "CHAT_USER_EXPLICIT" };
const answerIntent = (key: string, changes: Record<string, unknown> = CANONICAL) => ({
  action_class: "COMMIT", summary: "persist the B0 answer",
  mutations: [{ logical_resource_key: CONFIG, operation: "UPSERT", record_selector: { natural_key: key }, desired_changes: changes }],
});

test("PV-B0-003/a: a pending input may only be written under the key its contract fixes", async () => {
  const { w } = world({ answer: "ABSENT" });
  const h = await bind(w);
  // The exact shape the replay submitted.
  const invented = await dispatch("os_prepare", { binding_handle: h, intent: answerIntent("PRIMARY_COMMERCIAL_GOAL") }, ctx, w.deps);
  assert.equal(invented.status, "HOLD", JSON.stringify(invented));
  assert.equal((await w.deps.store.plans.findActive("VERTIGO", "SALES", "g1")).length, 0, "a parallel truth opens no plan, Run or lease");
  assert.ok(JSON.stringify(invented.evidence ?? []).includes(B0_KEY), "the refusal names the canonical key so the same turn can correct itself");

  const canonical = await dispatch("os_prepare", { binding_handle: h, intent: answerIntent(B0_KEY) }, ctx, w.deps);
  assert.equal(canonical.code, "PLAN_PREPARED", JSON.stringify(canonical));
});

test("PV-B0-003/b: the contract's own predicate values are required at write time, not merely hoped for at read time", async () => {
  for (const [label, changes] of [
    ["wrong category", { ...CANONICAL, Category: "OTHER" }],
    ["unconfirmed state", { ...CANONICAL, State: "HYPOTHESIS" }],
    ["wrong version", { ...CANONICAL, Version: "SALES_INPUT/9" }],
    ["wrong source", { ...CANONICAL, Source: "CHAT_INFERRED" }],
    ["blank value", { ...CANONICAL, Value: "   " }],
  ] as const) {
    const { w } = world({ answer: "ABSENT" });
    const h = await bind(w);
    const r = await dispatch("os_prepare", { binding_handle: h, intent: answerIntent(B0_KEY, changes) }, ctx, w.deps);
    assert.equal(r.status, "HOLD", `${label}: ${JSON.stringify(r)}`);
    assert.equal((await w.deps.store.plans.findActive("VERTIGO", "SALES", "g1")).length, 0, `${label}: no plan is opened`);
  }
});

test("PV-B0-003/c: the constraint is scoped to the declared record — it does not police the rest of the space", async () => {
  // Another resource at the same step is untouched by this rule.
  const { w } = world({ answer: "ABSENT" });
  const h = await bind(w);
  const other = await dispatch("os_prepare", { binding_handle: h, intent: {
    action_class: "COMMIT", summary: "record an intake",
    mutations: [{ logical_resource_key: "SALES:INTAKE", operation: "UPSERT", record_selector: { natural_key: "upload:sha256:abc" }, desired_changes: { Intake: "ICP input", Status: "RECEIVED" } }],
  } }, ctx, w.deps);
  assert.notEqual(other.code, "HOLD_UNSUPPORTED_OPERATION", `a different resource is not policed by the input rule: ${JSON.stringify(other)}`);

  // And at a step the contract declares no canonical input for, the same resource takes any key as before.
  const later = world({ answer: "ABSENT" });
  later.w.setSalesState({ gate: "B2_ICP", buildState: "B2_ICP" });
  const h2 = await bind(later.w);
  const free = await dispatch("os_prepare", { binding_handle: h2, intent: answerIntent("ICP:PRIMARY_SEGMENT", { Category: "ICP_INCLUDE", State: "CONFIRMED", Value: "Industriels français", Version: "SALES_INPUT/1", Source: "CHAT_USER_EXPLICIT" }) }, ctx, later.w.deps);
  assert.equal(free.code, "PLAN_PREPARED", `no declared input at this step means no key constraint: ${JSON.stringify(free)}`);
});

/**
 * PV-GATE-001 — the step engine is the contract's catalog, not B0's.
 *
 * Only B0 is specified deterministically today: the governing amendment publishes the exact
 * predicate, canonical resource, natural key, required values, cursor field-set, next action and next question
 * for B0_DISCOVERY → B1_OFFER, and for no later step. B1–B7 exist as prose objectives only.
 *
 * What must therefore be proved is that the *mechanism* carries no knowledge of B0: given a declaration for a
 * different step, with a different gate, key, values and cursor destination, the same engine serves the same
 * address, applies the same predicate and derives the same kind of proved move. When a later step's predicate
 * is published, the catalog grows by one entry and nothing else changes.
 */
const B3_TRANSITION: DerivedCursorTransition = {
  key: "B3_DATA->B4_QUALIFICATION",
  fromGate: "B3_DATA",
  evidence: {
    logicalResourceKey: CONFIG,
    naturalKey: "B3_DATA:CANONICAL_SOURCE",
    equals: { Category: "DATA", State: "CONFIRMED", Version: "SALES_INPUT/1", Source: "CHAT_USER_EXPLICIT" },
    nonEmpty: ["Value"],
  },
  targetResourceKey: OS_STATE,
  targetNaturalKey: "CURRENT",
  set: {
    Name: "CURRENT", "Current Gate": "B4_QUALIFICATION", "Build State": "B4_QUALIFICATION",
    "Current Gate Status": "OPEN", "Last Durable Mode": "INTAKE", "Next Authorized Topic": "B4_QUALIFICATION",
    "Next Action": "Tester les hard gates sur un échantillon", "Next Question": "Quel échantillon veux-tu tester ?",
    "Persistence Health": "PASS", "Recovery Required": false,
  },
  carryForward: { "Gate Passed By Run Ref": "lastRunRef" },
  runReferenceProperties: ["Last Run Ref"],
  stampedProperties: ["Last Verified At", "Last Required Written At"],
  clearWhenUnblocked: ["Open Blocker"],
};

/** The capture line's catalog with its one entry swapped for a different step's. Same engine, other contract. */
function otherStepLine(): ControlPlaneGrammar {
  return { ...captureLine().grammar.controlPlane, cursorTransitions: [B3_TRANSITION] };
}

const otherStepWorld = (answer: "SATISFIED" | "ABSENT") => world({
  controlPlane: otherStepLine(), gate: B3_TRANSITION.fromGate, answer,
  answerKey: B3_TRANSITION.evidence.naturalKey, answerCategory: B3_TRANSITION.evidence.equals["Category"] as string,
});

test("PV-GATE-001/a: an unanswered step of another contract serves that step's address, verbatim from the catalog", async () => {
  const { w } = otherStepWorld("ABSENT");
  const h = await bind(w);
  const resumed = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  assert.equal(resumed.code, "RESUMED", JSON.stringify(resumed));
  const served = (resumed.result as { pending_step_input?: Record<string, unknown> }).pending_step_input;
  assert.ok(served, "the contract declares an address for this step; resume must serve it");
  assert.equal(served["gate_key"], B3_TRANSITION.fromGate, "the served gate is the durable one, never B0");
  assert.equal(served["natural_key"], B3_TRANSITION.evidence.naturalKey);
  assert.equal(served["logical_resource_key"], B3_TRANSITION.evidence.logicalResourceKey);
  assert.deepEqual(served["required_values"], B3_TRANSITION.evidence.equals);
  assert.deepEqual(served["required_non_empty"], B3_TRANSITION.evidence.nonEmpty);
});

test("PV-GATE-001/b: the same engine derives another step's move from its own predicate and cursor fields", async () => {
  const { w } = otherStepWorld("SATISFIED");
  const h = await bind(w);
  const prepared = await requestTransition(w, h);
  assert.equal(prepared.code, "PLAN_PREPARED", JSON.stringify(prepared));
  const plan = await w.deps.store.plans.get(((prepared as Extract<Envelope, { status: "OK" }>).result as { plan_id: string }).plan_id) as Plan;
  assert.equal(plan.operations.length, 1);
  const op = plan.operations[0] as Plan["operations"][number];
  assert.equal(op.logical_resource_key, B3_TRANSITION.targetResourceKey);
  assert.equal(op.operation, "UPDATE");
  assert.equal(op.natural_key, B3_TRANSITION.targetNaturalKey);
  for (const [property, value] of Object.entries(B3_TRANSITION.set)) assert.equal(op.expected_values[property], value, property);
  assert.equal(op.expected_values["Last Run Ref"], "$created:OPEN_RUN");
  assert.equal(op.expected_values["Gate Passed By Run Ref"], R.salesRun1, "the reference is carried from the durable cursor, not minted");
  // No B0 value survives into a step the contract addresses differently.
  assert.ok(!Object.values(op.expected_values).includes("B1_OFFER"), "nothing about B0 leaks into another step's move");
});

test("PV-GATE-001/c: a durable step the contract specifies no predicate for moves nothing and invents no question", async () => {
  // This is today's B1–B7 reality: the cursor sits on a gate the governing catalog does not address.
  const { w } = world({ gate: "B1_OFFER" });
  const h = await bind(w);
  const resumed = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  assert.equal(resumed.code, "RESUMED", JSON.stringify(resumed));
  assert.equal(Object.hasOwn(resumed.result as object, "pending_step_input"), false, "no declaration exists, so no address is invented");
  const r = await requestTransition(w, h);
  assert.notEqual(r.code, "PLAN_PREPARED", `an unspecified step must derive no move: ${JSON.stringify(r)}`);
  assert.equal((await w.deps.store.plans.findActive("VERTIGO", "SALES", "g1")).length, 0, "no plan, Run or lease is opened for a step the contract does not specify");
});

/**
 * PV-GATE-000 — an unfinished step is not a finished space.
 *
 * Deriving nothing is the right MOVE at an unspecified step, and it was until now the whole answer: the backend
 * stayed silent and the caller was told its intent was missing, which reads as an invitation to supply one.
 * Silence cannot distinguish "this step of the product was never specified" from "there is nothing left to do",
 * and the difference is exactly what decides whether a conversation may decide the step by itself.
 *
 * The contract closes it by publishing its walk. These tests hold the refusal to what the contract actually
 * says: it fires on a governed step, it does not fire at the end of the walk, and it disappears entirely with
 * the declaration — so a line that publishes no walk behaves exactly as it did before.
 */
const noWalkLine = (): ControlPlaneGrammar => {
  const { gateSequence: _unpublished, ...withoutWalk } = captureLine().grammar.controlPlane;
  return withoutWalk;
};

test("PV-GATE-000/a: asking to advance a governed but unspecified step holds truthfully instead of asking for an intent", async () => {
  const { w } = world({ gate: "B1_OFFER" });
  const h = await bind(w);
  const r = await requestTransition(w, h);
  assert.equal(r.status, "HOLD", `an unspecified step of the published walk must hold, not fall through: ${JSON.stringify(r)}`);
  assert.equal(r.code, "HOLD_GATE_UNSPECIFIED", JSON.stringify(r));
  const evidence = ((r as Extract<Envelope, { status: "HOLD" }>).evidence ?? []).join(" ");
  assert.match(evidence, /B1_OFFER/, "the refusal names the durable step it is about");
  assert.match(evidence, /no completion predicate/, "and says what the contract is missing, not merely that it refused");
  assert.equal((await w.deps.store.plans.findActive("VERTIGO", "SALES", "g1")).length, 0, "refusing writes nothing: no plan, Run or lease");
  // The durable cursor is untouched: a refusal to advance is not a gate movement of its own.
  assert.equal(propText(w.map.get(`page:${R.salesStateRow}`) as Page, "Current Gate"), "B1_OFFER");
});

test("PV-GATE-000/b: the end of the walk is not a missing step — the terminal state derives no move and holds nothing", async () => {
  const { w } = world({ gate: "READY" });
  const h = await bind(w);
  const r = await requestTransition(w, h);
  assert.notEqual(r.code, "HOLD_GATE_UNSPECIFIED", `a completed walk must not be reported as an unfinished product: ${JSON.stringify(r)}`);
  assert.equal((await w.deps.store.plans.findActive("VERTIGO", "SALES", "g1")).length, 0);
});

test("PV-GATE-000/c: a cursor outside the published walk is a divergence, refused on its own evidence", async () => {
  const { w } = world({ gate: "B9_INVENTED" });
  const h = await bind(w);
  const r = await requestTransition(w, h);
  assert.equal(r.code, "HOLD_GATE_UNSPECIFIED", JSON.stringify(r));
  const evidence = ((r as Extract<Envelope, { status: "HOLD" }>).evidence ?? []).join(" ");
  assert.match(evidence, /does not name/, "an unknown step is refused for not being governed, not for being unfinished");
});

test("PV-GATE-000/d: the refusal belongs to the contract — a line that publishes no walk claims nothing", async () => {
  const { w } = world({ gate: "B1_OFFER", controlPlane: noWalkLine() });
  const h = await bind(w);
  const r = await requestTransition(w, h);
  assert.notEqual(r.code, "HOLD_GATE_UNSPECIFIED", `without a published walk the backend has no ground to call a step unfinished: ${JSON.stringify(r)}`);
  assert.equal((await w.deps.store.plans.findActive("VERTIGO", "SALES", "g1")).length, 0);
});

test("PV-GATE-000/e: a step the contract DOES specify still derives its move — the walk refuses, it never blocks", async () => {
  const { w } = world();
  const h = await bind(w);
  const prepared = await requestTransition(w, h);
  assert.equal(prepared.code, "PLAN_PREPARED", `publishing the walk must not disturb the one specified step: ${JSON.stringify(prepared)}`);
});

test("PV-GATE-001/d: a catalog that names two different cursor rows is refused rather than resolved by order", async () => {
  const twoCursors = { ...captureLine().grammar.controlPlane, cursorTransitions: [
    (captureLine().grammar.controlPlane.cursorTransitions ?? [])[0] as DerivedCursorTransition,
    { ...B3_TRANSITION, targetNaturalKey: "OTHER" },
  ] } satisfies ControlPlaneGrammar;
  const { w } = world({ controlPlane: twoCursors });
  const h = await bind(w);
  const r = await requestTransition(w, h);
  assert.equal(r.status, "HOLD", JSON.stringify(r));
  assert.equal(r.code, "HOLD_TARGET_AMBIGUOUS", JSON.stringify(r));
  assert.equal((await w.deps.store.plans.findActive("VERTIGO", "SALES", "g1")).length, 0);
});
