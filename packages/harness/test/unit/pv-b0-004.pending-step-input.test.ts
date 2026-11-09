/**
 * PV-B0-004 — the canonical record of a pending answer is SERVED, not only enforced.
 *
 * The fresh replay of 2026-09-19 was asked the B0 question and wrote the answer under a key of its own
 * (`PRIMARY_COMMERCIAL_GOAL`). PV-B0-003 refuses that key, but a refusal is not an address: nothing in the served
 * state said where the answer goes, and the only canonical-key recipe the shipped skill carried pointed at the
 * META lane. `os_resume` now serves the contract's own declaration for the durable gate, and it is the SAME
 * object `os_prepare` enforces — so following it always prepares, and nothing can drift into a second truth.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Plan } from "../../src/plans/store.ts";
import { dispatch, resolveRuntimeFor } from "../../src/tools/handlers.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import { candidateResume } from "../../src/tools/conduct.ts";
import { unsatisfiedPendingStepInputs, type PendingStepInput } from "../../src/resume/pendingInput.ts";
import { deriveCursorTransition } from "../../src/plans/cursorTransition.ts";
import { hashHandle } from "../../src/binding/handle.ts";
import { propText } from "../../src/notion/shapes.ts";
import { registerBuiltinSalesAdapters, salesContractAdapter, type SalesContractAdapter } from "../../src/versions/adapters/sales.ts";
import { createAdapterRegistries } from "../../src/versions/registry.ts";
import { handleOf, OWNER, T0 } from "./binding-fixtures.ts";
import { synthetic, text } from "./meta-fixtures.ts";
import { buildResumeWorld, R, setRowsIn } from "./resume-fixtures.ts";
import { CONTRACT_PAGE, IDS as SALES_IDS, SGRAMMAR, SV } from "./sales-fixtures.ts";
import type { Page } from "../../src/notion/shapes.ts";
import { stampsAt, transact } from "../support/transact.ts";

const ctx = { principal_id: OWNER.principal_id, now: T0 };
const CONFIG = "SALES:BUSINESS_CONFIG";
const B0_KEY = "B0_DISCOVERY:PRIMARY_OUTCOME";
const OUTCOME = "Obtenir trois rendez-vous qualifiés par mois avec des industriels français";

function captureLine(suffix = "/0.5.4-candidate"): SalesContractAdapter {
  const registries = createAdapterRegistries();
  registerBuiltinSalesAdapters(registries.salesRuntime);
  const v = registries.salesRuntime.supported().find((x) => x.endsWith(suffix));
  assert.ok(v);
  return registries.salesRuntime.resolve(v) as SalesContractAdapter;
}

/** The B0 answer row exactly as PV-B0-001 writes it, in the Business Configuration data source. */
function answerRow(ds: string, id: string): Page {
  return {
    object: "page", id: synthetic(id), archived: false, parent: { type: "data_source_id", data_source_id: ds },
    properties: {
      "Config Item": { type: "title", title: [text(B0_KEY)] },
      Category: { type: "select", select: { name: "GOAL" } },
      State: { type: "select", select: { name: "CONFIRMED" } },
      Value: { type: "rich_text", rich_text: [text(OUTCOME)] },
      Version: { type: "rich_text", rich_text: [text("SALES_INPUT/1")] },
      Source: { type: "rich_text", rich_text: [text("CHAT_USER_EXPLICIT")] },
    },
  };
}

/** A V1 runtime whose durable cursor sits on the given gate, with the given Business Configuration answer. */
function world(gate: string, answer: "ABSENT" | "SATISFIED" | "DUPLICATE" = "ABSENT", suffix = "/0.5.4-candidate"): ReturnType<typeof buildResumeWorld> {
  const w = buildResumeWorld();
  const contract = "TEST_SALES_CONTRACT/1.7.0";
  w.deps.adapters.salesRuntime.register(contract, salesContractAdapter(contract, [SV.schema], { ...SGRAMMAR, controlPlane: captureLine(suffix).grammar.controlPlane }));
  const ids = SALES_IDS("rep-a");
  const manifest = w.map.get(`page:${ids.manifestRow}`) as Page;
  setRowsIn(w.map, ids.manifestDs, [{ ...manifest, properties: { ...manifest.properties, "Sales Contract Version": { type: "rich_text", rich_text: [text(contract)] } } }]);
  w.map.set(`page:${CONTRACT_PAGE}`, { object: "page", id: CONTRACT_PAGE, archived: false, properties: { title: { type: "title", title: [text(contract)] } } });
  w.setSalesState({ gate, buildState: gate, nextQuestion: "Quel est ton objectif commercial prioritaire ?" });

  const list = (results: unknown[]) => ({ results, has_more: false, next_cursor: null });
  const spec = captureLine(suffix).grammar.controlPlane.resources?.[CONFIG];
  assert.ok(spec?.parentTitle);
  const parent = synthetic("b4-setup-parent"); const db = synthetic("b4-config-db"); const ds = synthetic("b4-config-ds");
  const rootChildren = (w.map.get(`children:${ids.root}`) as { results: unknown[] }).results;
  w.map.set(`children:${ids.root}`, list([...rootChildren, { id: parent, type: "child_page", child_page: { title: spec.parentTitle } }]));
  w.map.set(`children:${parent}`, list([{ id: db, type: "child_database", child_database: { title: spec.databaseTitle } }]));
  w.map.set(`database:${db}`, { data_sources: [{ id: ds }] });
  w.map.set(`data_source:${ds}`, { properties: { "Config Item": { type: "title" }, Category: { type: "select" }, State: { type: "select" }, Value: { type: "rich_text" }, Version: { type: "rich_text" }, Source: { type: "rich_text" }, "Effective At": { type: "date" }, Notes: { type: "rich_text" } } });
  setRowsIn(w.map, ds, answer === "ABSENT" ? [] : answer === "SATISFIED" ? [answerRow(ds, "b4-answer-row")] : [answerRow(ds, "b4-answer-row"), answerRow(ds, "b4-answer-row-2")]);
  return w;
}

const bind = async (w: ReturnType<typeof buildResumeWorld>) => handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps));
const resumedResult = async (w: ReturnType<typeof buildResumeWorld>, h: string) => {
  const r = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  assert.equal(r.code, "RESUMED", JSON.stringify(r));
  return (r as Extract<Envelope, { status: "OK" }>).result as { pending_step_input?: PendingStepInput };
};

test("PV-B0-004/a: a resume on the open B0 step serves the contract's canonical record for the pending answer", async () => {
  const w = world("B0_DISCOVERY");
  const served = (await resumedResult(w, await bind(w))).pending_step_input;
  assert.ok(served, "the seller's step waits for an answer whose record the contract fixes; it must be served");
  assert.equal(served.gate_key, "B0_DISCOVERY");
  assert.equal(served.logical_resource_key, CONFIG, "the answer stays in the seller's own space, never in META");
  assert.equal(served.natural_key, B0_KEY);
  assert.deepEqual(served.required_values, { Category: "GOAL", State: "CONFIRMED", Version: "SALES_INPUT/1", Source: "CHAT_USER_EXPLICIT" });
  assert.deepEqual(served.required_non_empty, ["Value"]);
});

test("PV-B0-004/b: writing exactly what was served prepares; the invented key of the replay still holds", async () => {
  const w = world("B0_DISCOVERY");
  const h = await bind(w);
  const served = (await resumedResult(w, h)).pending_step_input as PendingStepInput;
  const mutationFrom = (key: string) => ({
    action_class: "COMMIT", summary: "persist the B0 answer",
    mutations: [{
      logical_resource_key: served.logical_resource_key, operation: "UPSERT" as const,
      record_selector: { natural_key: key },
      desired_changes: { ...served.required_values, ...Object.fromEntries(served.required_non_empty.map((f) => [f, OUTCOME])) },
    }],
  });

  const prepared = await dispatch("os_prepare", { binding_handle: h, intent: mutationFrom(served.natural_key) }, ctx, w.deps);
  assert.equal(prepared.code, "PLAN_PREPARED", `obeying the served declaration must always prepare: ${JSON.stringify(prepared)}`);
  const plan = await w.deps.store.plans.get(((prepared as Extract<Envelope, { status: "OK" }>).result as { plan_id: string }).plan_id) as Plan;
  assert.equal((plan.operations[0] as Plan["operations"][number]).natural_key, B0_KEY);

  // The exact shape the replay submitted, on its own world so the prepared plan above is not replayed.
  const replay = world("B0_DISCOVERY");
  const invented = await dispatch("os_prepare", { binding_handle: await bind(replay), intent: mutationFrom("PRIMARY_COMMERCIAL_GOAL") }, ctx, replay.deps);
  assert.equal(invented.status, "HOLD", JSON.stringify(invented));
  assert.ok(JSON.stringify(invented.evidence ?? []).includes(B0_KEY), "the refusal still names the canonical key");
});

test("PV-B0-004/c: a step the contract declares no record for serves none — the field is absent, never guessed", async () => {
  const w = world("B2_ICP");
  assert.equal(Object.hasOwn(await resumedResult(w, await bind(w)), "pending_step_input"), false);
  assert.equal((await w.deps.store.plans.findActive("VERTIGO", "SALES", "g1")).length, 0, "a resume opens no plan");
});

test("PV-B0-004/d: the served declaration is the contract's own, carried verbatim from the governing adapter", () => {
  const transition = (captureLine().grammar.controlPlane.cursorTransitions ?? []).find((t) => t.fromGate === "B0_DISCOVERY");
  assert.ok(transition, "the V1 line declares the B0 completion predicate");
  assert.equal(transition.evidence.naturalKey, B0_KEY);
  assert.equal(transition.evidence.logicalResourceKey, CONFIG);
});


test("PV-B0-004/e: a canonical row that already answers the step is not asked for again", async () => {
  const w = world("B0_DISCOVERY", "SATISFIED");
  const resumed = await resumedResult(w, await bind(w));
  assert.equal(Object.hasOwn(resumed, "pending_step_input"), false, "the answer is durably in the seller's own record; serving its address again would ask for it twice");
});

test("PV-B0-004/f: an answer that cannot be proven stays pending — a duplicated row is not an answer", async () => {
  const w = world("B0_DISCOVERY", "DUPLICATE");
  const served = (await resumedResult(w, await bind(w))).pending_step_input;
  assert.ok(served, "two rivals for the same canonical key prove nothing, so the step is still open");
  assert.equal(served.natural_key, B0_KEY);
});

const CANDIDATE = "/0.5.13-candidate", CONFIG_DS = synthetic("b4-config-ds");
const configRows = (w: ReturnType<typeof world>) => (w.map.get(`query:${CONFIG_DS}`) as { results: Page[] }).results;
async function existingDecision(source = "CHAT_USER_EXPLICIT", suffix = CANDIDATE) {
  const w = world("B0_DISCOVERY", "ABSENT", suffix), h = await bind(w);
  // A fully proved answer with a still-open cursor: the previous call did not finish its movement.
  await transact(w, h, { action_class: "COMMIT", summary: "existing confirmed decision", mutations: [{
    logical_resource_key: CONFIG, operation: "UPSERT", record_selector: { natural_key: B0_KEY },
    desired_changes: { Category: "GOAL", State: "CONFIRMED", Value: OUTCOME, Version: "SALES_INPUT/1", Source: source },
  }] }, { ctx, stamps: stampsAt("04", "10") });
  return { w, h };
}
const candidateReply = async (w: ReturnType<typeof world>, h: string) => candidateResume(await dispatch("os_resume", { binding_handle: h }, { ...ctx, candidate_resume: true }, w.deps));

test("W6.3/a: the real candidate grammar reuses either local origin, with no old question or answer rewrite", async () => {
  for (const source of ["CHAT_USER_EXPLICIT", "AGENT_PROPOSED_USER_VALIDATED"]) {
    const { w, h } = await existingDecision(source);
    const before = JSON.stringify(configRows(w));
    const reply = await candidateReply(w, h);
    assert.equal(reply.code, "RESUMED", JSON.stringify(reply));
    assert.equal(reply.ask, undefined, "a stale cursor question must not reinterview a valid durable decision");
    assert.equal(reply.next.permitted_tool_call, "os_commit");
    assert.equal(reply.next.prepare_intent, undefined, "the caller must not rewrite or manufacture an answer intent");
    assert.match(reply.next.conduct ?? "", /NO intent/);
    assert.doesNotMatch(reply.say ?? "", /objectif commercial prioritaire|enregistré et vérifié|étape suivante est ouverte/);
    assert.equal(JSON.stringify(configRows(w)), before);
    assert.equal(propText(configRows(w)[0]!, "Source"), source);
    assert.equal((reply.status === "OK" ? reply.result : {}).setup_input_satisfied, true);
  }
});

test("W6.3/b: legacy grammar, absent/duplicate answers and undeclared B7 do not acquire the satisfaction signal", async () => {
  const legacy = await existingDecision("CHAT_USER_EXPLICIT", "/0.5.4-candidate");
  for (const pair of [legacy, ...await Promise.all(["ABSENT", "DUPLICATE"].map(async answer => {
    const w = world("B0_DISCOVERY", answer as "ABSENT" | "DUPLICATE", CANDIDATE); return { w, h: await bind(w) };
  })), await (async () => { const w = world("B7_DRY_RUN", "ABSENT", CANDIDATE); return { w, h: await bind(w) }; })()]) {
    const reply = await candidateReply(pair.w, pair.h);
    assert.equal((reply.status === "OK" ? reply.result : {}).setup_input_satisfied, undefined);
    assert.doesNotMatch(reply.next.conduct ?? "", /Call os_commit ONCE.*NO intent/);
  }
});

test("W6.3/c: shared predicates stay fresh, targeted and incapable of inventing missing proof", async () => {
  const { w, h } = await existingDecision("AGENT_PROPOSED_USER_VALIDATED");
  const resolved = await resolveRuntimeFor(w.deps, OWNER, "VERTIGO", "SALES");
  assert.equal(resolved.kind, "RESOLVED"); if (resolved.kind !== "RESOLVED") throw new Error("fixture runtime unresolved");
  const runtime = resolved.runtime, binding = (await w.deps.store.bindings.findByHandleHash(hashHandle(h)))!;
  assert.equal(runtime.adapter.controlPlane, captureLine(CANDIDATE).grammar.controlPlane);
  assert.equal(runtime.adapter.controlPlane.resources?.[CONFIG]?.uncomparedProperties?.includes("Source"), false);
  let queries = 0;
  const query = w.deps.notion.queryDataSource.bind(w.deps.notion);
  w.deps.notion.queryDataSource = async (...args) => { if (args[0] === CONFIG_DS) queries++; return query(...args); };
  assert.deepEqual(await unsatisfiedPendingStepInputs(w.deps.notion, runtime, "B0_DISCOVERY"), []);
  assert.equal(queries, 1, "one targeted predicate read, no new scan/cache");
  const fresh = await deriveCursorTransition(w.deps, binding, runtime, undefined);
  assert.equal(fresh.kind, "INTENT");
  if (fresh.kind === "INTENT") assert.equal(fresh.intent.mutations[0]?.logical_resource_key, "SALES:OS_STATE");
  const row = configRows(w)[0]!;
  for (const changes of [
    { State: { type: "select", select: { name: "DRAFT" } } },
    { Value: { type: "rich_text", rich_text: [] } },
    { Value: { type: "rich_text", rich_text: [text("$answer")] } },
    { Source: { type: "rich_text", rich_text: [text("META_PUBLISHED")] } },
    { Source: { type: "rich_text", rich_text: [text("AGENT_PROPOSED")] } },
    { Version: { type: "rich_text", rich_text: [text("UNKNOWN")] } },
  ]) {
    setRowsIn(w.map, CONFIG_DS, [{ ...row, properties: { ...row.properties, ...changes } } as Page]);
    assert.equal((await unsatisfiedPendingStepInputs(w.deps.notion, runtime, "B0_DISCOVERY")).length, 1);
    assert.equal((await deriveCursorTransition(w.deps, binding, runtime, undefined)).kind, "NONE", "the earlier satisfaction is never cached as current authority");
  }
});

test("W6.3/d: recovery, holds, unfinished mutations, active plans and external effects outrank a satisfied setup", async () => {
  const { w, h } = await existingDecision();
  const e = await dispatch("os_resume", { binding_handle: h }, { ...ctx, candidate_resume: true }, w.deps);
  assert.equal(e.status, "OK"); if (e.status !== "OK") return;
  for (const result of [
    { ...e.result, effective_hold: { code: "HOLD_CONFLICT", evidence: ["still blocked"] } },
    { ...e.result, recovery_required: true },
    { ...e.result, mutations: { incomplete_count: 1 } },
    { ...e.result, external_intents_unresolved: 1 },
    { ...e.result, adoption_in_progress: true },
    { ...e.result, durable_hold: { code: "HOLD_CONFLICT" } },
    { ...e.result, pending_confirmation: { question: "Cette modification est-elle votre décision ?" } },
  ]) {
    const reply = candidateResume({ ...e, result });
    assert.doesNotMatch(reply.next.conduct ?? "", /Call os_commit ONCE.*NO intent/);
  }
  const active = candidateResume({ ...e, observations: { ...e.observations, open_backend_plan: {
    owned_by_caller: true, same_binding: true, plan_state: "AWAITING_STAGE1_WRITES", plan_id: "fixture-plan", stage1_actions: [{}],
  } } });
  assert.doesNotMatch(active.next.conduct ?? "", /Call os_commit ONCE.*NO intent/);
});

test("W6.3/e: the satisfaction signal is backend output, never an accepted tool argument", async () => {
  const w = world("B0_DISCOVERY", "ABSENT", CANDIDATE);
  const out = await dispatch("os_resume", { binding_handle: await bind(w), setup_input_satisfied: true }, ctx, w.deps);
  assert.equal(out.code, "ERROR_INVALID_ARGUMENT");
});
