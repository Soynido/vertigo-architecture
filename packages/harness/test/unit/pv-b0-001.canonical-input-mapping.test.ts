/**
 * PV-B0-001 — the canonical B0 input mapping, audited against the live Business Configuration schema.
 *
 * The fixture below mirrors the real data source property-for-property (Config Item title, Category/State select,
 * Value/Version/Source/Notes text, Effective At date), so a mismatch here is a mismatch in production.
 *
 * The mapping fixes an EXACT compared field-set — Config Item, Category, State, Value, Version, Source — while
 * still requiring Effective At and Notes to be written. The plan engine derives compared_fields from every key of
 * desired_changes, so those two provenance fields could not be written without also being proved. That matters
 * because Effective At is a date and Notion stores dates to the minute: comparing it re-creates the exact
 * failure already seen on Verified At, for which only SALES:CAPABILITY_PROOFS has a tolerance.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FixtureNotionReadClient } from "../../src/notion/readClient.ts";
import { propText, type Page } from "../../src/notion/shapes.ts";
import { resolveTarget } from "../../src/plans/resources.ts";
import type { Plan } from "../../src/plans/store.ts";
import type { ResolvedRuntime } from "../../src/resolvers/types.ts";
import { dispatch } from "../../src/tools/handlers.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import { registerBuiltinSalesAdapters, salesContractAdapter, type SalesContractAdapter } from "../../src/versions/adapters/sales.ts";
import { createAdapterRegistries } from "../../src/versions/registry.ts";
import { handleOf, OWNER, T0 } from "./binding-fixtures.ts";
import { synthetic, text } from "./meta-fixtures.ts";
import { buildResumeWorld, setRowsIn } from "./resume-fixtures.ts";
import { CONTRACT_PAGE, IDS as SALES_IDS, SGRAMMAR, SV } from "./sales-fixtures.ts";
import { executeWrites, rowsOf } from "./target-fixtures.ts";

const ctx = { principal_id: OWNER.principal_id, now: T0 };
const CONFIG = "SALES:BUSINESS_CONFIG";
const KEY = "B0_DISCOVERY:PRIMARY_OUTCOME";
/** Exactly the properties the live Business Configuration data source exposes, with their live types. */
const LIVE_SCHEMA: Record<string, string> = {
  "Config Item": "title", Category: "select", State: "select", Value: "rich_text",
  Version: "rich_text", Source: "rich_text", "Effective At": "date", Notes: "rich_text",
};
/** The canonical compared field-set of PV-B0-001, in the sorted order the engine emits. */
const COMPARED = ["Category", "Config Item", "Source", "State", "Value", "Version"];

const OUTCOME = "Obtenir trois rendez-vous qualifiés par mois avec des industriels français";
const mapping = (effectiveAt = "2026-09-19T16:31:45.000Z") => ({
  Category: "GOAL", State: "CONFIRMED", Value: OUTCOME, Version: "SALES_INPUT/1",
  Source: "CHAT_USER_EXPLICIT", "Effective At": effectiveAt,
  Notes: `Question Key=B0_DISCOVERY.PRIMARY_OUTCOME; Objective Package=https://app.notion.com/p/${synthetic("objective-package")}`,
});
const intentFor = (changes: Record<string, unknown>) => ({
  action_class: "COMMIT", summary: "persist B0_DISCOVERY answer",
  mutations: [{ logical_resource_key: CONFIG, operation: "UPSERT", record_selector: { natural_key: KEY }, desired_changes: changes }],
});

function adapterFor(suffix: string): SalesContractAdapter {
  const registries = createAdapterRegistries();
  registerBuiltinSalesAdapters(registries.salesRuntime);
  const version = registries.salesRuntime.supported().find((v) => v.endsWith(suffix));
  assert.ok(version, `no registered SALES contract line ends with ${suffix}`);
  return registries.salesRuntime.resolve(version) as SalesContractAdapter;
}

test("PV-B0-001/a: the same-turn capture contract line is dispatchable and keeps the migrated schema", () => {
  const capture = adapterFor("/0.5.4-candidate");
  const base = adapterFor("/0.5.3-candidate");
  assert.deepEqual(capture.supportedSchemas, base.supportedSchemas, "the amendment changes behaviour, not the schema line");
  assert.equal(capture.supportedSchemas.length, 1);
  assert.ok(Object.hasOwn(capture.grammar.controlPlane.resources ?? {}, CONFIG), "the B0 target must be addressable on this line");
  const added = Object.keys(capture.grammar.controlPlane.resources ?? {}).filter((k) => !Object.hasOwn(base.grammar.controlPlane.resources ?? {}, k));
  assert.deepEqual(added, ["SALES:OS_STATE"], "the amendment adds exactly the durable cursor the 0.5.4 page authorizes");
  assert.deepEqual(
    Object.keys(base.grammar.controlPlane.resources ?? {}).filter((k) => !Object.hasOwn(capture.grammar.controlPlane.resources ?? {}, k)),
    [], "the amendment removes no business resource",
  );
  assert.equal(capture.capabilities, base.capabilities, "connector behaviour is untouched");
});

function configWorld(): { w: ReturnType<typeof buildResumeWorld>; ds: string } {
  const w = buildResumeWorld();
  const contract = "TEST_SALES_CONTRACT/1.5.0";
  w.deps.adapters.salesRuntime.register(contract, salesContractAdapter(contract, [SV.schema], { ...SGRAMMAR, controlPlane: adapterFor("/0.5.4-candidate").grammar.controlPlane }));
  const ids = SALES_IDS("rep-a");
  const manifest = w.map.get(`page:${ids.manifestRow}`) as Page;
  setRowsIn(w.map, ids.manifestDs, [{ ...manifest, properties: { ...manifest.properties, "Sales Contract Version": { type: "rich_text", rich_text: [text(contract)] } } }]);
  w.map.set(`page:${CONTRACT_PAGE}`, { object: "page", id: CONTRACT_PAGE, archived: false, properties: { title: { type: "title", title: [text(contract)] } } });

  const list = (results: unknown[]) => ({ results, has_more: false, next_cursor: null });
  const spec = adapterFor("/0.5.4-candidate").grammar.controlPlane.resources?.[CONFIG];
  assert.ok(spec?.parentTitle);
  const parent = synthetic("b0-setup-parent"); const db = synthetic("b0-config-db"); const ds = synthetic("b0-config-ds");
  const rootChildren = (w.map.get(`children:${ids.root}`) as { results: unknown[] }).results;
  w.map.set(`children:${ids.root}`, list([...rootChildren, { id: parent, type: "child_page", child_page: { title: spec.parentTitle } }]));
  w.map.set(`children:${parent}`, list([{ id: db, type: "child_database", child_database: { title: spec.databaseTitle } }]));
  w.map.set(`database:${db}`, { data_sources: [{ id: ds }] });
  w.map.set(`data_source:${ds}`, { properties: Object.fromEntries(Object.entries(LIVE_SCHEMA).map(([n, t]) => [n, { type: t }])) });
  setRowsIn(w.map, ds, []);
  return { w, ds };
}

test("PV-B0-001/b: the write carries the full mapping while the proof covers exactly the canonical field-set", async () => {
  const { w, ds } = configWorld();
  const h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps));
  const prepared = await dispatch("os_prepare", { binding_handle: h, intent: intentFor(mapping()) }, ctx, w.deps);
  assert.equal(prepared.code, "PLAN_PREPARED", JSON.stringify(prepared));
  const plan = await w.deps.store.plans.get(((prepared as Extract<Envelope, { status: "OK" }>).result as { plan_id: string }).plan_id) as Plan;
  const op = plan.operations[0] as Plan["operations"][number];

  assert.deepEqual([...op.compared_fields].sort(), COMPARED, "the proof must cover exactly the canonical compared field-set");
  assert.equal(op.expected_values["Config Item"], KEY, "the key is written from the selector, never from the caller");
  assert.equal(op.expected_values["Category"], "GOAL");
  assert.equal(op.expected_values["State"], "CONFIRMED");
  assert.equal(op.expected_values["Value"], OUTCOME);
  assert.equal(op.expected_values["Version"], "SALES_INPUT/1");
  assert.equal(op.expected_values["Source"], "CHAT_USER_EXPLICIT");
  // Provenance is still written; it is simply not part of the proof.
  assert.equal(op.expected_values["Effective At"], "2026-09-19T16:31:45.000Z");
  assert.match(String(op.expected_values["Notes"]), /Question Key=B0_DISCOVERY\.PRIMARY_OUTCOME; Objective Package=https:/);
  const targetWrite = plan.stage1_writes.find((wr) => wr.purpose === "WRITE_TARGET");
  assert.ok(targetWrite);
  for (const f of ["Effective At", "Notes"]) assert.ok(Object.hasOwn(targetWrite.fields, f), `${f} must still reach Notion`);
});

test("PV-B0-001/c: Notion truncating the provenance date to the minute cannot hold the transaction", async () => {
  const { w, ds } = configWorld();
  const h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps));
  const prepared = await dispatch("os_prepare", { binding_handle: h, intent: intentFor(mapping("2026-09-19T16:31:45.000Z")) }, ctx, w.deps);
  const plan = await w.deps.store.plans.get(((prepared as Extract<Envelope, { status: "OK" }>).result as { plan_id: string }).plan_id) as Plan;
  const targetSymbol = (plan.stage1_writes.find((wr) => wr.purpose === "WRITE_TARGET") as { symbol: string }).symbol;
  // Notion keeps dates to the minute and returns them with milliseconds: exactly what production returns.
  const truncated = { ...(plan.stage1_writes.find((wr) => wr.purpose === "WRITE_TARGET") as { fields: Record<string, unknown> }).fields, "Effective At": "2026-09-19T16:31:00.000Z" };
  executeWrites(w, plan.stage1_writes, plan.plan_id, { now: "2030-01-03T00:30:00.000Z", replaceFields: { [targetSymbol]: truncated } });
  const target = await dispatch("os_verify", { binding_handle: h, plan_id: plan.plan_id, phase: "TARGET" }, ctx, w.deps);
  assert.equal(target.code, "TARGET_VERIFIED", `a date outside the compared set must not hold the proof: ${JSON.stringify(target)}`);
  assert.equal(rowsOf(w, ds).length, 1);
  assert.equal(propText(rowsOf(w, ds)[0] as Page, "Value"), OUTCOME);
});

test("PV-B0-001/d: zero rows create, one row updates, more than one holds", async () => {
  const keyed = (ds: string, slug: string): Page => ({
    object: "page", id: synthetic(slug), archived: false, parent: { type: "data_source_id", data_source_id: ds },
    properties: { "Config Item": { type: "title", title: [text(KEY)] }, Value: { type: "rich_text", rich_text: [text("ancienne réponse")] } },
  });
  // Each case needs its own world: an active plan from a previous prepare is replayed before any target lookup.
  const prepareOn = async (rows: (ds: string) => Page[]): Promise<{ envelope: Envelope; world: ReturnType<typeof buildResumeWorld> }> => {
    const { w, ds } = configWorld();
    setRowsIn(w.map, ds, rows(ds));
    const h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps));
    return { envelope: await dispatch("os_prepare", { binding_handle: h, intent: intentFor(mapping()) }, ctx, w.deps), world: w };
  };

  const zero = await prepareOn(() => []);
  assert.equal(zero.envelope.code, "PLAN_PREPARED", JSON.stringify(zero.envelope));
  const zeroPlan = await zero.world.deps.store.plans.get(((zero.envelope as Extract<Envelope, { status: "OK" }>).result as { plan_id: string }).plan_id) as Plan;
  assert.equal((zeroPlan.operations[0] as Plan["operations"][number]).operation, "CREATE", "zero exact-key rows permits the create");

  const one = await prepareOn((ds) => [keyed(ds, "b0-row-single")]);
  assert.equal(one.envelope.code, "PLAN_PREPARED", JSON.stringify(one.envelope));
  const onePlan = await one.world.deps.store.plans.get(((one.envelope as Extract<Envelope, { status: "OK" }>).result as { plan_id: string }).plan_id) as Plan;
  const op = onePlan.operations[0] as Plan["operations"][number];
  assert.equal(op.operation, "UPDATE", "one exact-key row is updated in place, never duplicated");
  assert.equal(op.expected_values["Value"], OUTCOME, "a changed explicit outcome replaces the value on the single canonical row");
  assert.deepEqual([...op.compared_fields].sort(), COMPARED.filter((f) => f !== "Config Item"),
    "on an update the key is the selector, proven by the exact-key lookup, so the proof covers the remaining canonical fields");

  const many = await prepareOn((ds) => [keyed(ds, "b0-row-1"), keyed(ds, "b0-row-2")]);
  assert.equal(many.envelope.code, "HOLD_TARGET_AMBIGUOUS", JSON.stringify(many.envelope));
});

/**
 * PV-B0-001/g — the published rollback is a real rollback.
 *
 * The amendment's Rollback section re-pins the prior V1 line in the Manifest. That only means
 * something if the prior line genuinely lacks the amendment: a rename that leaves the cursor writable and the
 * transition derivable would roll nothing back. So the earlier line must declare neither.
 */
test("PV-B0-001/g: re-pinning the prior line removes the amendment — the cursor is unaddressable and no move is derivable", () => {
  const base = adapterFor("/0.5.3-candidate");
  assert.equal(base.grammar.controlPlane.resources?.["SALES:OS_STATE"], undefined, "the rollback target cannot transact against the durable cursor");
  assert.deepEqual(base.grammar.controlPlane.cursorTransitions ?? [], [], "the rollback target derives no gate movement");
  const capture = adapterFor("/0.5.4-candidate");
  assert.equal((capture.grammar.controlPlane.cursorTransitions ?? []).length, 1, "the amendment carries the one transition its page authorizes");
});
