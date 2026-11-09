/** W6.2 local provenance oracles; not real publication, member, ordinary-chat or native-source proof. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hashHandle } from "../../src/binding/handle.ts";
import { propText, type Page } from "../../src/notion/shapes.ts";
import { observePendingStepInput, pendingStepInputs, prepareIntentFor } from "../../src/resume/pendingInput.ts";
import { resolveRuntimeFor } from "../../src/tools/handlers.ts";
import { SALES_CONTROL_PLANE_0513_CANDIDATE, SALES_CONTROL_PLANE_0514_CANDIDATE } from "../../src/versions/adapters/controlPlane.ts";
import { registerBuiltinSalesAdapters, salesContractAdapter, type SalesContractAdapter } from "../../src/versions/adapters/sales.ts";
import { MapAdapterRegistry, type SalesRuntimeAdapter } from "../../src/versions/registry.ts";
import { CLASSES, configRow, G, guardWorld, GUARD_CONTRACT, index, rowsOf } from "../support/guard-fixtures.ts";
import { OWNER } from "./binding-fixtures.ts";
import { SV } from "./sales-fixtures.ts";

const CONFIG = "SALES:BUSINESS_CONFIG", KEY = "B3_DATA:CANONICAL_SOURCE", GATE = "B3_DATA";
const localSources = ["CHAT_USER_EXPLICIT", "AGENT_PROPOSED_USER_VALIDATED"] as const;
const fields = (Source: string) => ({ Category: "OTHER", State: "CONFIRMED", Value: "LOCAL-PRIVATE-DECISION", Version: "SALES_INPUT/1", Source });
function world(configs: Page[] = [], candidate = true) {
  const g = guardWorld({ gate: GATE, configs, doc: index([], [
    { class: "PRODUCTION", resource_key: CONFIG, operation: "UPSERT", allowed_fields: Object.keys(fields(localSources[0])) }, CLASSES.cursor(),
  ]) });
  // Isolated registry with the actual candidate policy, not a repin of a live runtime.
  const sales = new MapAdapterRegistry<SalesRuntimeAdapter>();
  for (const version of g.deps.adapters.salesRuntime.supported()) {
    const a = g.deps.adapters.salesRuntime.resolve(version) as SalesContractAdapter;
    sales.register(version, version === GUARD_CONTRACT && candidate ? salesContractAdapter(version, [SV.schema], {
      ...a.grammar, controlPlane: { ...a.grammar.controlPlane, localAnswerSources: SALES_CONTROL_PLANE_0513_CANDIDATE.localAnswerSources! },
    }, a.capabilities) : a);
  }
  Object.assign(g.deps, { adapters: { ...g.deps.adapters, salesRuntime: sales } });
  return g;
}
async function observation(g: ReturnType<typeof world>) {
  const runtime = await resolveRuntimeFor(g.deps, OWNER, "VERTIGO", "SALES");
  assert.equal(runtime.kind, "RESOLVED"); if (runtime.kind !== "RESOLVED") throw new Error("fixture runtime unresolved");
  const pending = pendingStepInputs(runtime.runtime, GATE)[0]!;
  let queryCount = 0;
  const query = g.client.queryDataSource.bind(g.client);
  g.client.queryDataSource = async (...args) => { queryCount++; return query(...args); };
  const observed = await observePendingStepInput(g.deps.notion, runtime.runtime, pending);
  return { pending, observed, queryCount };
}
const intent = (Source: string, key = KEY) => ({ intent: { action_class: "COMMIT", summary: "record the human-local decision", mutations: [{
  logical_resource_key: CONFIG, operation: "UPSERT", record_selector: { natural_key: key }, desired_changes: fields(Source),
}] } });

test("W6.2/a: only the two explicitly registered provenance candidates declare the local origins", () => {
  const sales = new MapAdapterRegistry<SalesRuntimeAdapter>(); registerBuiltinSalesAdapters(sales);
  const enabled = sales.supported().map(v => sales.resolve(v) as SalesContractAdapter).filter(a => a.grammar.controlPlane.localAnswerSources);
  assert.equal(enabled.length, 2);
  assert.deepEqual(enabled.map(a => a.grammar.controlPlane), [SALES_CONTROL_PLANE_0513_CANDIDATE, SALES_CONTROL_PLANE_0514_CANDIDATE], "only the two exact registered grammars opt in, not arbitrary runtime pins");
  assert.deepEqual(SALES_CONTROL_PLANE_0513_CANDIDATE.localAnswerSources, localSources);
  assert.deepEqual(SALES_CONTROL_PLANE_0514_CANDIDATE.localAnswerSources, localSources);
});

test("W6.2/b: both confirmed local origins satisfy the same predicate without converting provenance", async () => {
  for (const source of localSources) {
    const g = world([configRow(source, KEY, { category: "OTHER", value: "confirmed decision", source })]);
    const { pending, observed, queryCount } = await observation(g);
    assert.equal(observed.kind, "SATISFIED");
    assert.equal(queryCount, 1, "the provenance predicate adds no extra query or whole-OS scan");
    assert.equal(propText(rowsOf(g.map, G.configDs)[0]!, "Source"), source);
    assert.equal(g.client.writes.length, 0);
    assert.equal(prepareIntentFor(pending).mutations[0]!.desired_changes["Source"], "CHAT_USER_EXPLICIT", "a fresh direct answer keeps its own default origin");
  }
});

test("W6.2/c: publication, unknown origin and an unvalidated proposal are never a local answer", async () => {
  for (const source of ["META_PUBLISHED", "AGENT_PROPOSED", "UNKNOWN", " AGENT_PROPOSED_USER_VALIDATED "]) {
    const g = world([configRow(source, KEY, { category: "OTHER", value: "claimed answer", source })]);
    const { observed } = await observation(g);
    assert.equal(observed.kind, "INCOMPLETE");
    assert.ok(observed.kind === "INCOMPLETE" && observed.mismatched.includes("Source"));
    assert.equal(g.client.writes.length, 0);
  }
  for (const changes of [{ state: "DRAFT" }, { value: "" }, { version: "WRONG" }, { category: "GOAL" }]) {
    const g = world([configRow("unvalidated", KEY, { category: "OTHER", value: "proposed", source: localSources[1], ...changes })]);
    assert.equal((await observation(g)).observed.kind, "INCOMPLETE", "the provenance label never removes the other proof obligations");
  }
});

test("W6.2/d: a local commit preserves each origin through TARGET and FINAL, without publication", async () => {
  for (const source of localSources) {
    const g = world(), h = await g.bind(); await g.approve();
    const out = await g.commit(h, intent(source));
    assert.equal(out.kind, "PERSISTED", JSON.stringify(out));
    if (out.kind !== "PERSISTED") return;
    const plan = (await g.deps.store.plans.get(out.plan_id))!;
    assert.equal(plan.operations[0]!.expected_values["Source"], source);
    assert.ok(plan.operations[0]!.compared_fields.includes("Source"), "the declared provenance stays within TARGET/FINAL proof");
    const row = rowsOf(g.map, G.configDs).find(p => propText(p, "Config Item") === KEY)!;
    assert.equal(propText(row, "Source"), source);
    assert.equal((await g.deps.store.receipts.get(out.target_receipt_id))?.status, "CONSUMED");
    assert.equal((await g.deps.store.receipts.get(out.final_receipt_id))?.status, "VALID");
  }
});

test("W6.2/e: local writes cannot claim publication or unknown origins, even on an independent key", async () => {
  for (const source of ["META_PUBLISHED", "AGENT_PROPOSED", "UNKNOWN"]) {
    const g = world(), h = await g.bind(); await g.approve();
    const out = await g.commit(h, intent(source, "LOCAL:NOTES"));
    assert.equal(out.kind, "HELD");
    assert.equal(out.kind === "HELD" ? out.code : undefined, "HOLD_UNSUPPORTED_OPERATION");
    assert.doesNotMatch(JSON.stringify(out), /LOCAL-PRIVATE-DECISION/);
    const b = (await g.deps.store.bindings.findByHandleHash(hashHandle(h)))!;
    assert.equal((await g.deps.store.plans.listByRuntime("VERTIGO", "SALES", b.runtime_generation)).length, 0);
    assert.equal(g.client.writes.length, 0);
  }
});

test("W6.2/f: published company content cannot be overwritten or relabelled as local", async () => {
  for (const desiredSource of localSources) {
    const row = configRow("published", "LOCAL:NOTES", { category: "OTHER", value: "company doctrine", source: "META_PUBLISHED" });
    const g = world([row]), h = await g.bind(); await g.approve();
    const out = await g.commit(h, intent(desiredSource, "LOCAL:NOTES"));
    assert.equal(out.kind, "HELD");
    assert.equal(out.kind === "HELD" ? out.code : undefined, "HOLD_ACTION_NOT_AUTHORIZED");
    assert.equal(g.client.writes.length, 0);
    assert.equal(propText(rowsOf(g.map, G.configDs)[0]!, "Source"), "META_PUBLISHED");
  }
});

test("W6.2/f2: a missing origin is refused, never inferred or silently injected", async () => {
  for (const configs of [[], [configRow("local", "LOCAL:NOTES", { category: "OTHER", value: "prior", source: localSources[1] })]]) {
    const g = world(configs), h = await g.bind(); await g.approve();
    const i = intent(localSources[0], "LOCAL:NOTES");
    delete (i.intent.mutations[0]!.desired_changes as Partial<ReturnType<typeof fields>>).Source;
    const out = await g.commit(h, i);
    assert.equal(out.kind, "HELD");
    assert.equal(out.kind === "HELD" ? out.code : undefined, "HOLD_UNSUPPORTED_OPERATION");
    assert.equal(g.client.writes.length, 0);
  }
});

test("W6.2/g: legacy contract predicates remain exact, not silently adopted", async () => {
  const g = world([configRow("old-proposal", KEY, { category: "OTHER", value: "old proposal", source: localSources[1] })], false);
  const { observed } = await observation(g);
  assert.equal(observed.kind, "INCOMPLETE");
  assert.ok(observed.kind === "INCOMPLETE" && observed.mismatched.includes("Source"));
  assert.equal(g.client.writes.length, 0);
});
