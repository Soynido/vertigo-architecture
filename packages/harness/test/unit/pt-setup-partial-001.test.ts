/** W5.3 local candidate oracles, not ordinary-chat/Gmail acceptance. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { propText, type Page } from "../../src/notion/shapes.ts";
import { pendingStepInputFor } from "../../src/resume/pendingInput.ts";
import { dispatch } from "../../src/tools/handlers.ts";
import { SALES_CONTROL_PLANE_056, SALES_CONTROL_PLANE_0511_CANDIDATE, SALES_CONTROL_PLANE_0513_CANDIDATE, SALES_CONTROL_PLANE_0514_CANDIDATE } from "../../src/versions/adapters/controlPlane.ts";
import { registerBuiltinSalesAdapters, type SalesContractAdapter } from "../../src/versions/adapters/sales.ts";
import { createAdapterRegistries } from "../../src/versions/registry.ts";
import type { ResolvedRuntime } from "../../src/resolvers/types.ts";
import { OWNER } from "./binding-fixtures.ts";
import { R } from "./resume-fixtures.ts";
import { CLASSES, configRow, G, guardWorld, index, rowsOf } from "../support/guard-fixtures.ts";

const CONFIG = "SALES:BUSINESS_CONFIG", GATE = "B3_DATA", KEY = "B3_DATA:CANONICAL_SOURCE";
const fields = { Category: "OTHER", State: "CONFIRMED", Value: "Export CRM dédoublonné", Version: "SALES_INPUT/1", Source: "CHAT_USER_EXPLICIT" };
const intent = (key: string, changes: Record<string, unknown> = fields) => ({ intent: { action_class: "COMMIT", summary: "record explicit local configuration", mutations: [{
  logical_resource_key: CONFIG, operation: "UPSERT", record_selector: { natural_key: key }, desired_changes: changes,
}] } });
const world = (configs: Page[] = []) => guardWorld({ gate: GATE, configs,
  doc: index([], [{ class: "PRODUCTION", resource_key: CONFIG, operation: "UPSERT", allowed_fields: Object.keys(fields) }, CLASSES.cursor()]),
});
const cursor = (g: ReturnType<typeof world>) => propText(rowsOf(g.map, R.salesStateDs)[0] as Page, "Current Gate");
const runtime = (grammar = SALES_CONTROL_PLANE_0511_CANDIDATE) => ({ adapter: { controlPlane: grammar } }) as ResolvedRuntime;

test("W5.3/a: independent configuration opt-in is candidate-only, not a legacy repin", () => {
  const registries = createAdapterRegistries(); registerBuiltinSalesAdapters(registries.salesRuntime);
  let enabled = 0;
  for (const v of registries.salesRuntime.supported()) {
    const a = registries.salesRuntime.resolve(v) as SalesContractAdapter;
    const candidate = a.grammar.controlPlane === SALES_CONTROL_PLANE_0513_CANDIDATE || a.grammar.controlPlane === SALES_CONTROL_PLANE_0514_CANDIDATE;
    if (candidate) enabled++;
    assert.equal(a.grammar.controlPlane.independentConfigurationResourceKey, candidate ? CONFIG : undefined, v);
  }
  assert.equal(enabled, 2, "only the two explicitly registered candidates inherit the opt-in");
});

test("W5.3/b: candidate free keys are independent; declared namespaces remain strict and legacy remains unchanged", () => {
  const r = runtime();
  assert.equal(pendingStepInputFor(r, GATE, CONFIG, "LOCAL:WORKING_HOURS"), undefined);
  for (const key of [KEY, "B3_DATA:MISSPELLED", "B6_AUTHORITY:SEND_AUTHORITY", "B6_AUTHORITY:MISSPELLED"]) {
    assert.ok(pendingStepInputFor(r, GATE, CONFIG, key), key);
  }
  assert.equal(pendingStepInputFor(runtime(SALES_CONTROL_PLANE_056), GATE, CONFIG, "LOCAL:WORKING_HOURS")?.natural_key, KEY);
  assert.equal(pendingStepInputFor(r, GATE, CONFIG)?.natural_key, KEY, "resume declaration has no mutation selector and stays canonical");
});

test("W5.3/c: a free config key persists with TARGET/FINAL without consuming B3 or granting authority", async () => {
  const g = world(), h = await g.bind(); await g.approve();
  const out = await g.commit(h, intent("LOCAL:WORKING_HOURS", { ...fields, Value: "24 heures" }));
  assert.equal(out.kind, "PERSISTED", JSON.stringify(out));
  if (out.kind !== "PERSISTED") return;
  assert.equal(out.step_moved, false); assert.equal(cursor(g), GATE);
  assert.equal(out.targets.length, 1); assert.equal(out.targets[0]?.logical_resource_key, CONFIG);
  const receipts = await g.deps.store.receipts.findByPlan(out.plan_id);
  assert.deepEqual(receipts.map(r => r.type).sort(), ["FINAL", "TARGET"]);
  const resumed = await dispatch("os_resume", { binding_handle: await g.bind() }, { principal_id: OWNER.principal_id, now: new Date(g.clock.t) }, g.deps);
  assert.equal(resumed.code, "RESUMED", JSON.stringify(resumed));
  assert.equal((resumed as { result: { pending_step_input?: { natural_key: string } } }).result.pending_step_input?.natural_key, KEY);
});

test("W5.3/d: resolving an independent row by object id cannot accidentally turn it into the pending answer", async () => {
  const row = configRow("hours", "LOCAL:WORKING_HOURS", { category: "OTHER", source: "CHAT_USER_EXPLICIT" });
  const g = world([row]), h = await g.bind(); await g.approve();
  const input = intent("unused");
  const out = await g.commit(h, { intent: { ...input.intent, mutations: [{ ...input.intent.mutations[0]!, record_selector: { existing_object_id: row.id } }] } });
  assert.equal(out.kind, "PERSISTED", JSON.stringify(out)); assert.equal(cursor(g), GATE);
  assert.equal(rowsOf(g.map, G.configDs).length, 1, "update the existing row, never duplicate it");
});

test("W5.3/e: malformed current answers and reserved keys never write or advance", async () => {
  for (const [key, changes] of [["B3_DATA:MISSPELLED", fields], ["B6_AUTHORITY:SEND_AUTHORITY", { ...fields, Category: "CONSTRAINT" }],
    ["B6_AUTHORITY:MISSPELLED", fields], ["B0_DISCOVERY:PRIMARY_OUTCOME", { ...fields, Category: "GOAL" }],
    [KEY, { ...fields, State: "HYPOTHESIS" }], [KEY, { ...fields, Value: "" }], [KEY, { ...fields, Value: "$answer" }]] as const) {
    const g = world(), h = await g.bind(); await g.approve();
    const out = await g.commit(h, intent(key, changes));
    assert.equal(out.kind, "HELD", JSON.stringify(out));
    if (out.kind === "HELD") assert.equal(out.code, "HOLD_UNSUPPORTED_OPERATION", JSON.stringify(out));
    assert.equal(g.client.writes.length, 0); assert.equal(cursor(g), GATE);
  }
});

test("W5.3/f: object-id selectors cannot bypass canonical answer field checks", async () => {
  const row = configRow("draft", KEY, { category: "OTHER", source: "CHAT_USER_EXPLICIT", state: "HYPOTHESIS" });
  const g = world([row]), h = await g.bind(); await g.approve();
  const input = intent("unused", { ...fields, State: "HYPOTHESIS" });
  const out = await g.commit(h, { intent: { ...input.intent, mutations: [{ ...input.intent.mutations[0]!, record_selector: { existing_object_id: row.id } }] } });
  assert.equal(out.kind, "HELD", JSON.stringify(out)); assert.equal(g.client.writes.length, 0); assert.equal(cursor(g), GATE);
});

test("W5.3/g: a free mutation cannot smuggle a future canonical answer through a batch", async () => {
  const g = world(), h = await g.bind(); await g.approve();
  const input = intent("LOCAL:WORKING_HOURS"), future = intent("B6_AUTHORITY:SEND_AUTHORITY", { ...fields, Category: "CONSTRAINT" });
  const out = await g.commit(h, { intent: { ...input.intent, mutations: [...input.intent.mutations, ...future.intent.mutations] } });
  assert.equal(out.kind, "HELD", JSON.stringify(out)); assert.equal(g.client.writes.length, 0); assert.equal(cursor(g), GATE);
});

test("W5.3/h: a valid current canonical answer still advances exactly its declared step", async () => {
  const g = world(), h = await g.bind(); await g.approve();
  const out = await g.commit(h, intent(KEY));
  assert.equal(out.kind, "PERSISTED", JSON.stringify(out)); assert.equal(cursor(g), "B4_QUALIFICATION");
  if (out.kind === "PERSISTED") assert.equal(out.step_moved, true);
});

test("W5.3/i: independent configuration does not bypass operator guard approval", async () => {
  const g = world(), h = await g.bind();
  const out = await g.commit(h, intent("LOCAL:WORKING_HOURS"));
  assert.equal(out.kind, "HELD", JSON.stringify(out)); assert.equal(g.client.writes.length, 0); assert.equal(cursor(g), GATE);
  if (out.kind === "HELD") assert.equal(out.code, "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE", JSON.stringify(out));
});

test("W5.3/j: neither NEW nor object-id writes can rename a free key into a protected setup answer", async () => {
  for (const existing of [false, true]) for (const destination of [KEY, "B6_AUTHORITY:SEND_AUTHORITY"]) {
    const row = configRow("hours", "LOCAL:WORKING_HOURS", { category: "OTHER", source: "CHAT_USER_EXPLICIT" });
    // This fixture deliberately permits the field at the guard layer: the resource's immutable
    // identity must reject it independently, even if an operator class names that field.
    const g = guardWorld({ gate: GATE, configs: existing ? [row] : [], doc: index([], [
      { class: "PRODUCTION", resource_key: CONFIG, operation: "UPSERT", allowed_fields: [...Object.keys(fields), "Config Item"] }, CLASSES.cursor(),
    ]) }), h = await g.bind(); await g.approve();
    const input = intent("LOCAL:WORKING_HOURS", { ...fields, "Config Item": destination });
    const out = await g.commit(h, { intent: { ...input.intent, mutations: [{ ...input.intent.mutations[0]!,
      record_selector: existing ? { existing_object_id: row.id } : { natural_key: "LOCAL:WORKING_HOURS" },
    }] } });
    assert.equal(out.kind, "HELD", JSON.stringify(out)); assert.equal(g.client.writes.length, 0); assert.equal(cursor(g), GATE);
    if (out.kind === "HELD") {
      assert.equal(out.code, "HOLD_UNSUPPORTED_OPERATION");
      assert.ok(out.evidence.some(e => e.includes("control-owned fields") && e.includes("Config Item")), JSON.stringify(out));
    }
  }
});
