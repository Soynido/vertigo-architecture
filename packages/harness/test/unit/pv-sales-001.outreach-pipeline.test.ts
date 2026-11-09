/**
 * PV-SALES-001 — SALES:OUTREACH_PIPELINE, the first business resource that lives OUTSIDE the Personal Sales
 * runtime, in the seller's one authorized commercial objective package (MIG-SALES-052-001).
 *
 * What these tests pin down:
 *  - the frozen bridge contract gains nothing: the resource is reachable only through the V1 candidate line;
 *  - addressing resolves through the runtime's backend objective pointer, never a caller argument or a fallback
 *    to the runtime root, so one principal can never write into another's package;
 *  - `Action Key` is the stable idempotency key: blank, duplicate and unprovable lookups all fail closed, and a
 *    retry of the same intent never produces a second row;
 *  - relations must point at the data sources the live schema declares;
 *  - a draft is exactly what the business intent supplied: the backend fabricates no send, touch or outcome.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FixtureNotionReadClient, type NotionReadClient } from "../../src/notion/readClient.ts";
import { propRelationIds, propText, type Page } from "../../src/notion/shapes.ts";
import { checkFields, checkRelationTargets, readSchema, resolveTarget, type ResolvedTarget } from "../../src/plans/resources.ts";
import { observeOperation } from "../../src/recovery/engine.ts";
import type { Plan, PlanOperation } from "../../src/plans/store.ts";
import type { ResolvedRuntime } from "../../src/resolvers/types.ts";
import { registerBuiltinSalesAdapters, salesContractAdapter, type SalesContractAdapter } from "../../src/versions/adapters/sales.ts";
import { createAdapterRegistries } from "../../src/versions/registry.ts";
import { dispatch } from "../../src/tools/handlers.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import { handleOf, OWNER, T0 } from "./binding-fixtures.ts";
import { synthetic, text } from "./meta-fixtures.ts";
import { buildResumeWorld, setRowsIn } from "./resume-fixtures.ts";
import { CONTRACT_PAGE, IDS as SALES_IDS, registryEntries, SGRAMMAR, SV } from "./sales-fixtures.ts";
import { executeWrites, rowsOf } from "./target-fixtures.ts";

const PIPELINE = "SALES:OUTREACH_PIPELINE";
const DATABASE = "Outreach Pipeline";
const KEY_PROPERTY = "Action Key";

function adapters(): { v1: SalesContractAdapter; bridge: SalesContractAdapter; install: SalesContractAdapter } {
  const registries = createAdapterRegistries();
  registerBuiltinSalesAdapters(registries.salesRuntime);
  const find = (predicate: (a: SalesContractAdapter) => boolean): SalesContractAdapter => {
    const version = registries.salesRuntime.supported().find((v) => predicate(registries.salesRuntime.resolve(v) as SalesContractAdapter));
    assert.ok(version);
    return registries.salesRuntime.resolve(version) as SalesContractAdapter;
  };
  return {
    v1: find((a) => Object.hasOwn(a.grammar.controlPlane.resources ?? {}, PIPELINE)),
    bridge: find((a) => a.contractVersion.endsWith("/0.5.2-candidate")),
    install: find((a) => a.contractVersion.endsWith("/0.5.1-candidate")),
  };
}

/** The canonical writable field-set of the migrated pipeline, plus the types the live schema exposes. */
const PIPELINE_SCHEMA: Record<string, string> = {
  Outreach: "title", [KEY_PROPERTY]: "rich_text", Account: "relation", Contact: "relation",
  Tier: "select", Channel: "select", Angle: "rich_text", "Evidence-led opener": "rich_text",
  "Message version": "rich_text", Notes: "rich_text", Stage: "select", "Sent date": "date",
  "Last touch": "date", "Next touch": "date", Outcome: "select", Objection: "rich_text", "Reply summary": "rich_text",
};

interface Pkg { readonly root: string; readonly pipelineDs: string; readonly accountDs: string; readonly contactDs: string; readonly accountRow: string; readonly contactRow: string }

/** Builds one authorized objective package holding the canonical Outreach Pipeline, Accounts and Contacts. */
function objectivePackage(map: Map<string, unknown>, label: string): Pkg {
  const list = (results: unknown[]) => ({ results, has_more: false, next_cursor: null });
  const root = synthetic(`objpkg-${label}`);
  const db = synthetic(`objpkg-${label}-db`);
  const pipelineDs = synthetic(`objpkg-${label}-pipeline-ds`);
  const accountDs = synthetic(`objpkg-${label}-account-ds`);
  const contactDs = synthetic(`objpkg-${label}-contact-ds`);
  map.set(`children:${root}`, list([{ id: db, type: "child_database", child_database: { title: DATABASE } }]));
  map.set(`database:${db}`, { data_sources: [{ id: pipelineDs }] });
  map.set(`data_source:${pipelineDs}`, {
    properties: Object.fromEntries(Object.entries(PIPELINE_SCHEMA).map(([name, type]) => [
      name, type === "relation" ? { type, relation: { data_source_id: name === "Account" ? accountDs : contactDs } } : { type },
    ])),
  });
  setRowsIn(map, pipelineDs, []);
  const row = (ds: string, slug: string): string => {
    const id = synthetic(`objpkg-${label}-${slug}`);
    const page: Page = { object: "page", id, archived: false, parent: { type: "data_source_id", data_source_id: ds }, properties: { Name: { type: "title", title: [text(slug)] } } };
    map.set(`page:${id}`, page);
    setRowsIn(map, ds, [page]);
    map.set(`data_source:${ds}`, { properties: { Name: { type: "title" } } });
    return id;
  };
  return { root, pipelineDs, accountDs, contactDs, accountRow: row(accountDs, "account"), contactRow: row(contactDs, "contact") };
}

function runtimeOn(adapter: SalesContractAdapter, objectivePackageRef: string | undefined, root = synthetic("pv-sales-root")): ResolvedRuntime {
  return {
    root_ref: root, runtime_id: "SALES-PIPELINE-FIXTURE", runtime_generation: "g1", lane: "SALES", logical_key: "VERTIGO/SALES/fixture",
    access_mode: "BUSINESS", manifest_ref: synthetic("pv-sales-manifest"), locator_ref: "registry:fixture", pointer_generation: "1",
    lifecycle_state: "SETUP", owner_display: "Fixture",
    versions: { governing_spec: "UNKNOWN", governing_schema: "UNKNOWN", governing_control: "UNKNOWN", candidates: [], historical_pins: [] },
    manifest_pins: { ref: synthetic("pv-sales-pin"), spec: adapter.contractVersion, schema: adapter.supportedSchemas[0] as string, control: "NOT_APPLICABLE" },
    historical_pins: [], adopted_records: [],
    observations: objectivePackageRef === undefined ? {} : { objective_package_ref: objectivePackageRef },
    warnings: [], adapter: { version: adapter.contractVersion, controlPlane: adapter.grammar.controlPlane, capabilities: adapter.capabilities },
  } as unknown as ResolvedRuntime;
}

const DRAFT = { Outreach: "Acme — process video retrofit", Stage: "Draft", Channel: "LinkedIn", Tier: "S", Angle: "Unused factory footage", "Message version": "v1" };

test("PV-SALES-001/E1: the resource is reachable only on the V1 line; the frozen bridge still fails closed", async () => {
  const { v1, bridge, install } = adapters();
  assert.ok(Object.hasOwn(v1.grammar.controlPlane.resources ?? {}, PIPELINE));
  assert.deepEqual(
    Object.keys(bridge.grammar.controlPlane.resources ?? {}),
    Object.keys(install.grammar.controlPlane.resources ?? {}),
    "the governing bridge catalog is frozen: adding a V1 resource must not widen it",
  );
  assert.equal(bridge.grammar.controlPlane.resources?.[PIPELINE], undefined);

  const map = new Map<string, unknown>();
  const pkg = objectivePackage(map, "bridge");
  const client = new FixtureNotionReadClient(map);
  const outcome = await resolveTarget(client, runtimeOn(bridge, pkg.root), "BUSINESS", PIPELINE, "CREATE", { natural_key: "R:1" });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.code, "HOLD_RESOURCE_UNKNOWN");
  assert.ok(outcome.evidence.join(" ").includes(bridge.contractVersion), "the refusal names the contract that was actually served");
});

test("PV-SALES-001/E2: addressing follows the backend objective pointer and never falls back or crosses over", async () => {
  const { v1 } = adapters();
  const map = new Map<string, unknown>();
  const mine = objectivePackage(map, "mine");
  const theirs = objectivePackage(map, "theirs");
  const client = new FixtureNotionReadClient(map);

  const ok = await resolveTarget(client, runtimeOn(v1, mine.root), "BUSINESS", PIPELINE, "CREATE", { natural_key: "R:1" });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  if (ok.ok) assert.equal(ok.target.data_source.id, mine.pipelineDs);

  // No pointer ⇒ nothing is addressable. A fallback to the runtime root would invent a second truth.
  const unassigned = await resolveTarget(client, runtimeOn(v1, undefined), "BUSINESS", PIPELINE, "CREATE", { natural_key: "R:1" });
  assert.equal(unassigned.ok, false);
  if (!unassigned.ok) assert.equal(unassigned.code, "HOLD_REQUIRED_RESOURCE_MISSING");

  // A package this identity cannot read is a missing prerequisite, never a crash and never "absent".
  const unreadable = await resolveTarget(client, runtimeOn(v1, synthetic("objpkg-not-shared")), "BUSINESS", PIPELINE, "CREATE", { natural_key: "R:1" });
  assert.equal(unreadable.ok, false);
  if (!unreadable.ok) assert.equal(unreadable.code, "HOLD_REQUIRED_RESOURCE_MISSING");

  // A row of somebody else's package cannot be adopted by naming its id.
  const foreign: Page = { object: "page", id: synthetic("foreign-row"), archived: false, parent: { type: "data_source_id", data_source_id: theirs.pipelineDs }, properties: { [KEY_PROPERTY]: { type: "rich_text", rich_text: [text("R:1")] } } };
  map.set(`page:${foreign.id}`, foreign);
  const crossed = await resolveTarget(client, runtimeOn(v1, mine.root), "BUSINESS", PIPELINE, "UPDATE", { existing_object_id: foreign.id });
  assert.equal(crossed.ok, false);
  if (!crossed.ok) assert.equal(crossed.code, "HOLD_CROSS_RUNTIME");
});

test("PV-SALES-001/E3: the idempotency key is mandatory, exact and never guessed", async () => {
  const { v1 } = adapters();
  const map = new Map<string, unknown>();
  const pkg = objectivePackage(map, "keys");
  const client = new FixtureNotionReadClient(map);
  const runtime = runtimeOn(v1, pkg.root);
  const code = async (operation: "CREATE" | "UPDATE", selector: Record<string, string>): Promise<string> => {
    const outcome = await resolveTarget(client, runtime, "BUSINESS", PIPELINE, operation, selector);
    return outcome.ok ? `OK:${outcome.target.kind}` : outcome.code;
  };

  assert.equal(await code("CREATE", {}), "HOLD_TARGET_NOT_FOUND", "no selector at all");
  assert.equal(await code("CREATE", { natural_key: "" }), "HOLD_TARGET_NOT_FOUND", "blank key");
  assert.equal(await code("CREATE", { natural_key: "   " }), "HOLD_TARGET_NOT_FOUND", "whitespace-only key");
  assert.equal(await code("CREATE", { natural_key: " R:1 " }), "HOLD_TARGET_NOT_FOUND", "an untrimmed key would fork identity");
  assert.equal(await code("CREATE", { natural_key: "R:1" }), "OK:NEW");
  assert.equal(await code("UPDATE", { natural_key: "R:1" }), "HOLD_TARGET_NOT_FOUND", "UPDATE never silently creates");

  const keyed = (slug: string): Page => ({ object: "page", id: synthetic(slug), archived: false, parent: { type: "data_source_id", data_source_id: pkg.pipelineDs }, properties: { [KEY_PROPERTY]: { type: "rich_text", rich_text: [text("R:1")] } } });
  const first = keyed("pipeline-row-1");
  setRowsIn(map, pkg.pipelineDs, [first]);
  assert.equal(await code("CREATE", { natural_key: "R:1" }), "HOLD_DUPLICATE", "a replay of the same key must never add a second row");
  assert.equal(await code("UPDATE", { natural_key: "R:1" }), "OK:EXISTING");

  setRowsIn(map, pkg.pipelineDs, [first, keyed("pipeline-row-2")]);
  assert.equal(await code("CREATE", { natural_key: "R:1" }), "HOLD_TARGET_AMBIGUOUS");
  assert.equal(await code("UPDATE", { natural_key: "R:1" }), "HOLD_TARGET_AMBIGUOUS");

  // An unavailable exact lookup is not evidence of absence: refusing is the only way a retry cannot duplicate.
  map.delete(`query:${pkg.pipelineDs}`);
  assert.equal(await code("CREATE", { natural_key: "R:1" }), "HOLD_TARGET_AMBIGUOUS");
});

test("PV-SALES-001/E4: only the canonical draft field-set is writable and the backend fabricates no effect", async () => {
  const { v1 } = adapters();
  const map = new Map<string, unknown>();
  const pkg = objectivePackage(map, "fields");
  const client = new FixtureNotionReadClient(map);
  const resolved = await resolveTarget(client, runtimeOn(v1, pkg.root), "BUSINESS", PIPELINE, "CREATE", { natural_key: "R:1" });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  const target = resolved.target as ResolvedTarget;

  assert.equal(checkFields(target, DRAFT).ok, true);
  const refused = (changes: Record<string, unknown>): string => {
    const outcome = checkFields(target, changes);
    return outcome.ok ? "OK" : outcome.code;
  };
  assert.equal(refused({ [KEY_PROPERTY]: "R:forged" }), "HOLD_UNSUPPORTED_OPERATION", "the idempotency key is backend-owned");
  assert.equal(refused({ "Send Now": true }), "HOLD_SCHEMA_MISMATCH", "a field absent from the live schema is never invented");
  assert.equal(refused({}), "HOLD_UNSUPPORTED_OPERATION");

  const spec = target.spec;
  assert.equal(spec.createDefaults, undefined, "no backend default can fabricate a send, a touch date or an outcome");
  assert.notEqual(spec.externalEffect, true, "creating a draft row is not an external effect and grants no send authority");
  assert.deepEqual(spec.protectedProperties, [KEY_PROPERTY]);
  for (const effect of ["Sent date", "Last touch", "Next touch", "Outcome", "Objection", "Reply summary"]) {
    assert.ok(spec.writableProperties?.includes(effect), `${effect} stays writable so already-observed reality can be recorded`);
    assert.equal(Object.hasOwn(DRAFT, effect), false, `${effect} is absent from a draft unless the business intent supplies it`);
  }
  assert.equal(spec.redactValues, true, "message content is never echoed into an envelope or a log");
});

test("PV-SALES-001/E5: relations must point at the data sources the live schema declares", async () => {
  const { v1 } = adapters();
  const map = new Map<string, unknown>();
  const pkg = objectivePackage(map, "relations");
  const client = new FixtureNotionReadClient(map);
  const resolved = await resolveTarget(client, runtimeOn(v1, pkg.root), "BUSINESS", PIPELINE, "CREATE", { natural_key: "R:1" });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  const target = resolved.target as ResolvedTarget;

  const schema = await readSchema(client, pkg.pipelineDs);
  assert.equal(schema?.relations.get("Account"), pkg.accountDs);
  assert.equal(schema?.relations.get("Contact"), pkg.contactDs);

  const good = await checkRelationTargets(client, target, { ...DRAFT, Account: [pkg.accountRow], Contact: [pkg.contactRow] });
  assert.equal(good.ok, true, JSON.stringify(good));

  const swapped = await checkRelationTargets(client, target, { Account: [pkg.contactRow] });
  assert.equal(swapped.ok, false);
  if (!swapped.ok) assert.ok(swapped.evidence.join(" ").includes(pkg.accountDs));

  const archived: Page = { object: "page", id: synthetic("archived-account"), archived: true, parent: { type: "data_source_id", data_source_id: pkg.accountDs }, properties: {} };
  map.set(`page:${archived.id}`, archived);
  assert.equal((await checkRelationTargets(client, target, { Account: [archived.id] })).ok, false);
  assert.equal((await checkRelationTargets(client, target, { Account: [synthetic("never-created")] })).ok, false, "an unreadable relation target is refused, not assumed valid");
  assert.equal((await checkRelationTargets(client, target, { Account: ["not-a-page-reference"] })).ok, false);
});

/**
 * A SALES world whose runtime pins the V1 catalog and whose principal is assigned one objective package.
 * The package is reachable ONLY through that backend assignment, exactly as in deployment.
 */
function pipelineWorld(label: string, key: string): { w: ReturnType<typeof buildResumeWorld>; pkg: Pkg; intent: unknown } {
  const w = buildResumeWorld();
  const { v1 } = adapters();
  const contract = "TEST_SALES_CONTRACT/1.2.0";
  w.deps.adapters.salesRuntime.register(contract, salesContractAdapter(contract, [SV.schema], { ...SGRAMMAR, controlPlane: v1.grammar.controlPlane }));

  const ids = SALES_IDS("rep-a");
  const manifest = w.map.get(`page:${ids.manifestRow}`) as Page;
  setRowsIn(w.map, ids.manifestDs, [{ ...manifest, properties: { ...manifest.properties, "Sales Contract Version": { type: "rich_text", rich_text: [text(contract)] } } }]);
  w.map.set(`page:${CONTRACT_PAGE}`, { object: "page", id: CONTRACT_PAGE, archived: false, properties: { title: { type: "title", title: [text(contract)] } } });

  const pkg = objectivePackage(w.map, label);
  w.setSalesRegistry(registryEntries().map((e) => (e.rep_identity_key === "rep-a" ? { ...e, objective_package_ref: pkg.root } : e)));

  const mutations = [{ logical_resource_key: PIPELINE, operation: "CREATE", record_selector: { natural_key: key }, desired_changes: { ...DRAFT, Account: [pkg.accountRow], Contact: [pkg.contactRow] } }];
  return { w, pkg, intent: { action_class: "COMMIT", summary: "Prepare one personalized outreach draft", mutations } };
}

const bindSales = async (w: ReturnType<typeof buildResumeWorld>): Promise<string> =>
  handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, { principal_id: OWNER.principal_id, now: T0 }, w.deps));

test("PV-SALES-001/E6: one draft survives CREATE, replay, TARGET, FINAL and a post-transaction retry", async () => {
  const key = "R009:acme-buyer";
  const { w, pkg, intent } = pipelineWorld("e2e", key);
  const h = await bindSales(w);
  const prepared = await dispatch("os_prepare", { binding_handle: h, intent }, { principal_id: OWNER.principal_id, now: T0 }, w.deps);
  assert.equal(prepared.code, "PLAN_PREPARED", JSON.stringify(prepared));
  const plan = await w.deps.store.plans.get(((prepared as Extract<Envelope, { status: "OK" }>).result as { plan_id: string }).plan_id) as Plan;
  assert.equal(plan.operations.length, 1);
  const op = plan.operations[0] as Plan["operations"][number];
  assert.equal(op.operation, "CREATE");
  assert.equal(op.target_data_source_ref, pkg.pipelineDs, "the write lands in the authorized package, not in the runtime");
  assert.equal(op.expected_values[KEY_PROPERTY], key, "the selector is persisted verbatim as the idempotency key");
  assert.ok(op.compared_fields.includes(KEY_PROPERTY), "the key is proved by readback like any other planned field");
  for (const effect of ["Sent date", "Last touch", "Next touch", "Outcome", "Objection", "Reply summary"]) {
    assert.equal(Object.hasOwn(op.expected_values, effect), false, `${effect} was never fabricated for a draft`);
  }
  assert.equal(plan.stage1_writes.filter((wr) => wr.purpose === "WRITE_TARGET").length, 1, "exactly one business write; nothing external is scheduled");

  const symbols = executeWrites(w, plan.stage1_writes, plan.plan_id, { now: "2030-01-03T00:30:00.000Z" });
  assert.equal(rowsOf(w, pkg.pipelineDs).length, 1);

  // Replay of the exact same intent before verification: the active plan is returned, never a second Run or row.
  const replay = await dispatch("os_prepare", { binding_handle: h, intent }, { principal_id: OWNER.principal_id, now: T0 }, w.deps);
  assert.equal(replay.code, "PLAN_PREPARED", JSON.stringify(replay));
  assert.equal(((replay as Extract<Envelope, { status: "OK" }>).result as { plan_id: string }).plan_id, plan.plan_id);
  assert.equal(rowsOf(w, pkg.pipelineDs).length, 1);

  const target = await dispatch("os_verify", { binding_handle: h, plan_id: plan.plan_id, phase: "TARGET" }, { principal_id: OWNER.principal_id, now: T0 }, w.deps);
  assert.equal(target.code, "TARGET_VERIFIED", JSON.stringify(target));
  const receipt = ((target as Extract<Envelope, { status: "OK" }>).result as { target_receipt_id: string }).target_receipt_id;
  const observed = (target.observations["symbols"] as Record<string, string> | undefined) ?? symbols;
  executeWrites(w, plan.finalization_writes, plan.plan_id, { ...({ now: "2030-01-03T00:31:00.000Z" }), created: observed, target_receipt_id: receipt });
  executeWrites(w, [plan.state_last_write], plan.plan_id, { ...({ now: "2030-01-03T00:32:00.000Z" }), created: observed, target_receipt_id: receipt });
  const final = await dispatch("os_verify", { binding_handle: h, plan_id: plan.plan_id, phase: "FINAL" }, { principal_id: OWNER.principal_id, now: T0 }, w.deps);
  assert.equal(final.code, "TRANSACTION_VERIFIED", JSON.stringify(final));

  const rows = rowsOf(w, pkg.pipelineDs);
  assert.equal(rows.length, 1, "exactly one row after write and readback");
  const row = rows[0] as Page;
  assert.equal(propText(row, KEY_PROPERTY), key);
  assert.equal(propText(row, "Stage"), "Draft");
  assert.deepEqual(propRelationIds(row, "Account"), [pkg.accountRow]);
  assert.deepEqual(propRelationIds(row, "Contact"), [pkg.contactRow]);
  for (const effect of ["Sent date", "Outcome", "Reply summary"]) assert.equal(row.properties[effect], undefined, `${effect} was never written`);

  // A fresh chat reusing the same key after the transaction closed finds the row and refuses to duplicate it.
  const retry = await dispatch("os_prepare", { binding_handle: h, intent }, { principal_id: OWNER.principal_id, now: T0 }, w.deps);
  assert.equal(retry.code, "HOLD_DUPLICATE", JSON.stringify(retry));
  assert.equal(rowsOf(w, pkg.pipelineDs).length, 1);
});

test("PV-SALES-001/E7: a crash between the write and its proof recovers by observation, never by rewriting the draft", async () => {
  const key = "R009:acme-buyer-crash";
  const { w, pkg, intent } = pipelineWorld("recovery", key);
  const hA = await bindSales(w);
  const preparedA = await dispatch("os_prepare", { binding_handle: hA, intent }, { principal_id: OWNER.principal_id, now: T0 }, w.deps);
  assert.equal(preparedA.code, "PLAN_PREPARED", JSON.stringify(preparedA));
  const planA = await w.deps.store.plans.get(((preparedA as Extract<Envelope, { status: "OK" }>).result as { plan_id: string }).plan_id) as Plan;

  // The draft reaches Notion; the chat then dies before it can prove anything.
  executeWrites(w, planA.stage1_writes, planA.plan_id, { now: "2030-01-03T00:30:00.000Z" });
  assert.equal(rowsOf(w, pkg.pipelineDs).length, 1);

  const later = new Date(T0.getTime() + 16 * 60_000);
  assert.equal((await dispatch("os_verify", { binding_handle: hA, plan_id: planA.plan_id, phase: "TARGET" }, { principal_id: OWNER.principal_id, now: later }, w.deps)).code, "HOLD_PLAN_EXPIRED");

  // A brand-new chat submits the SAME business intent with the SAME key.
  const hB = await bindSales(w);
  const resumed = await dispatch("os_resume", { binding_handle: hB }, { principal_id: OWNER.principal_id, now: later }, w.deps);
  assert.equal(resumed.code, "HOLD_RECOVERY_REQUIRED", JSON.stringify(resumed));
  const preparedB = await dispatch("os_prepare", { binding_handle: hB, intent }, { principal_id: OWNER.principal_id, now: later }, w.deps);
  assert.equal(preparedB.code, "PLAN_PREPARED", JSON.stringify(preparedB));
  const planB = await w.deps.store.plans.get(((preparedB as Extract<Envelope, { status: "OK" }>).result as { plan_id: string }).plan_id) as Plan;
  assert.equal(planB.run_mode, "RECOVER_EXISTING");
  assert.deepEqual(planB.stage1_writes.map((s) => s.symbol), ["RESUME_RUN"], "the durable draft is observed, so no outreach row is written twice");
  assert.equal(rowsOf(w, pkg.pipelineDs).length, 1);

  executeWrites(w, planB.stage1_writes, planB.plan_id, { now: "2030-01-03T01:00:00.000Z", salt: "rec" });
  const target = await dispatch("os_verify", { binding_handle: hB, plan_id: planB.plan_id, phase: "TARGET" }, { principal_id: OWNER.principal_id, now: later }, w.deps);
  assert.equal(target.code, "TARGET_VERIFIED", JSON.stringify(target));
  const receipt = ((target as Extract<Envelope, { status: "OK" }>).result as { target_receipt_id: string }).target_receipt_id;
  const symbols = target.observations["symbols"] as Record<string, string>;
  executeWrites(w, planB.finalization_writes, planB.plan_id, { ...({ now: "2030-01-03T01:01:00.000Z" }), created: symbols, target_receipt_id: receipt });
  executeWrites(w, [planB.state_last_write], planB.plan_id, { ...({ now: "2030-01-03T01:02:00.000Z" }), created: symbols, target_receipt_id: receipt });
  const final = await dispatch("os_verify", { binding_handle: hB, plan_id: planB.plan_id, phase: "FINAL" }, { principal_id: OWNER.principal_id, now: later }, w.deps);
  assert.equal(final.code, "TRANSACTION_VERIFIED", JSON.stringify(final));

  const rows = rowsOf(w, pkg.pipelineDs);
  assert.equal(rows.length, 1, "recovery reconciled the existing draft instead of creating a second one");
  assert.equal(propText(rows[0] as Page, KEY_PROPERTY), key);
});

/* ── Adversarial pass: the selector branches that do NOT go through the natural key ────────────────────── */

test("PV-SALES-001/E8: no UPDATE selector can reach an outreach row without naming its idempotency key", async () => {
  const { v1 } = adapters();
  const map = new Map<string, unknown>();
  const pkg = objectivePackage(map, "selectors");
  const client = new FixtureNotionReadClient(map);
  const runtime = runtimeOn(v1, pkg.root);

  const title = "Acme — process video retrofit";
  const row = (slug: string, key: string | undefined): Page => ({
    object: "page", id: synthetic(slug), archived: false, parent: { type: "data_source_id", data_source_id: pkg.pipelineDs },
    properties: { Outreach: { type: "title", title: [text(title)] }, ...(key === undefined ? {} : { [KEY_PROPERTY]: { type: "rich_text", rich_text: [text(key)] } }) },
  });
  // A row that predates MIG-SALES-052-001: it has a title but no Action Key.
  const legacy = row("legacy-outreach-row", undefined);
  const keyed = row("keyed-outreach-row", "R009:acme-buyer");
  for (const p of [legacy, keyed]) map.set(`page:${p.id}`, p);
  setRowsIn(map, pkg.pipelineDs, [legacy, keyed]);

  const code = async (selector: Record<string, string>): Promise<string> => {
    const outcome = await resolveTarget(client, runtime, "BUSINESS", PIPELINE, "UPDATE", selector);
    return outcome.ok ? `OK:${outcome.target.kind}` : outcome.code;
  };

  // The migration says a row without Action Key "remains legacy/unaddressable until explicitly reconciled".
  assert.equal(await code({ logical_record_key: title }), "HOLD_TARGET_NOT_FOUND", "a title never identifies an outreach row");
  assert.equal(await code({ existing_object_id: legacy.id }), "HOLD_TARGET_NOT_FOUND", "a legacy row without the key stays unaddressable");
  assert.equal(await code({ existing_object_id: keyed.id }), "OK:EXISTING", "a keyed row is still addressable by id");
  assert.equal(await code({ existing_object_id: keyed.id, natural_key: "R009:someone-else" }), "HOLD_TARGET_NOT_FOUND", "a page id may not contradict the key the caller named");
  assert.equal(await code({ existing_object_id: keyed.id, natural_key: "R009:acme-buyer" }), "OK:EXISTING");
  assert.equal((await resolveTarget(client, runtime, "BUSINESS", PIPELINE, "UPSERT", { natural_key: "R009:acme-buyer" })).ok, false, "the contract permits CREATE and UPDATE only");

  // Legacy behaviour is preserved for resources whose contract does not make the key sole identity.
  const legacyResource = Object.entries(v1.grammar.controlPlane.resources ?? {}).find(([, s]) => s.scope !== "OBJECTIVE_PACKAGE" && s.operations.includes("UPDATE") && s.bootstrapOnly !== true);
  assert.ok(legacyResource);
  assert.notEqual(legacyResource[1].naturalKeyIsIdentity, true, "only the outreach pipeline tightens the selector in this pass");
});

/** A read client that records the exact filter each query was given. */
function recordingClient(inner: FixtureNotionReadClient): { client: NotionReadClient; filters: unknown[] } {
  const filters: unknown[] = [];
  const client: NotionReadClient = {
    retrievePage: (id) => inner.retrievePage(id),
    retrieveDatabase: (id) => inner.retrieveDatabase(id),
    retrieveDataSource: (id) => inner.retrieveDataSource(id),
    retrieveBlockChildren: (id) => inner.retrieveBlockChildren(id),
    queryDataSource: (id, filter) => { filters.push(filter); return inner.queryDataSource(id); },
  };
  return { client, filters };
}

/**
 * Scope of this test: it proves ONLY the condition the harness emits. It cannot prove how Notion responds —
 * the claim that a rich_text condition on a url property is rejected comes from the API contract, not from
 * anything asserted here.
 */
test("PV-SALES-001/E9: locating a CREATE by natural key emits a condition the live property type accepts", async () => {
  const map = new Map<string, unknown>();
  const ds = synthetic("e9-ds");
  setRowsIn(map, ds, []);
  const { client, filters } = recordingClient(new FixtureNotionReadClient(map));

  const op = (property: string, type: string): PlanOperation => ({
    operation_id: "op", ordinal: 0, logical_resource_key: "X", target_data_source_ref: ds,
    natural_key: "value", natural_key_property: property, natural_key_property_type: type,
    idempotency_key: "k", operation: "CREATE", compared_fields: [property], before_values: {}, expected_values: {},
  });

  await observeOperation(client, op(KEY_PROPERTY, "rich_text"));
  assert.deepEqual(filters.at(-1), { property: KEY_PROPERTY, rich_text: { equals: "value" } }, "a rich_text key keeps its exact server filter");

  // A rich_text condition on a url/email/title property is not a condition those properties accept, so the
  // lookup would fail and a landed CREATE would read as unwritten. Asserted here only as the emitted shape.
  for (const [property, type] of [["Website", "url"], ["Email", "email"], ["Config Item", "title"]] as const) {
    await observeOperation(client, op(property, type));
    const sent = filters.at(-1) as Record<string, unknown> | undefined;
    assert.equal(sent !== undefined && Object.hasOwn(sent, "rich_text"), false, `${type} key must not be queried with a rich_text condition`);
  }

  // A plan persisted before the property type was recorded still works: no filter, exact match client-side.
  const { natural_key_property_type: _omitted, ...legacyOp } = op(KEY_PROPERTY, "rich_text");
  await observeOperation(client, legacyOp as PlanOperation);
  assert.equal(filters.at(-1), undefined, "an in-flight plan without the type falls back to an unfiltered exact match");
});

/**
 * Runs on FixtureNotionReadClient, which returns every row whatever the filter. It therefore proves the
 * harness's own comparison and refusal logic, NOT which rows a live query would surface. E13 and E14 cover the
 * behaviour under a client that really evaluates the emitted condition.
 */
test("PV-SALES-001/E10: naming a page id proves the same key facts the natural-key selector proves", async () => {
  const { v1 } = adapters();
  const map = new Map<string, unknown>();
  const pkg = objectivePackage(map, "id-route");
  const client = new FixtureNotionReadClient(map);
  const runtime = runtimeOn(v1, pkg.root);

  const row = (slug: string, stored: string | undefined): Page => ({
    object: "page", id: synthetic(slug), archived: false, parent: { type: "data_source_id", data_source_id: pkg.pipelineDs },
    properties: { Outreach: { type: "title", title: [text(slug)] }, ...(stored === undefined ? {} : { [KEY_PROPERTY]: { type: "rich_text", rich_text: [text(stored)] } }) },
  });
  const unique = row("unique-row", "R009:unique");
  const dupA = row("dup-a", "R009:dup");
  const dupB = row("dup-b", "R009:dup");
  const untrimmed = row("untrimmed-row", "  R009:untrimmed  ");
  const blankKey = row("blank-key-row", "   ");
  const keyless = row("keyless-row", undefined);
  const all = [unique, dupA, dupB, untrimmed, blankKey, keyless];
  for (const p of all) map.set(`page:${p.id}`, p);
  setRowsIn(map, pkg.pipelineDs, all);

  const code = async (selector: Record<string, string>): Promise<string> => {
    const outcome = await resolveTarget(client, runtime, "BUSINESS", PIPELINE, "UPDATE", selector);
    return outcome.ok ? `OK:${outcome.target.kind}` : outcome.code;
  };

  assert.equal(await code({ existing_object_id: unique.id }), "OK:EXISTING", "one canonical row with a unique key stays addressable");

  // Canon: "More than one match ... is a HOLD" and "exactly one after write/readback". Naming a page id must not
  // be a way to write into a duplicated key that the natural-key selector would refuse.
  assert.equal(await code({ existing_object_id: dupA.id }), "HOLD_TARGET_AMBIGUOUS", "a duplicated key is a HOLD whichever selector found the row");
  assert.equal(await code({ natural_key: "R009:dup" }), "HOLD_TARGET_AMBIGUOUS", "both selectors agree on the duplicate");

  // Canon: a stored key that is not canonical is an unreconciled row, exactly like a missing one.
  assert.equal(await code({ existing_object_id: untrimmed.id }), "HOLD_TARGET_NOT_FOUND", "an untrimmed stored key is not canonical");
  assert.equal(await code({ existing_object_id: blankKey.id }), "HOLD_TARGET_NOT_FOUND", "a whitespace-only stored key is blank");
  assert.equal(await code({ existing_object_id: keyless.id }), "HOLD_TARGET_NOT_FOUND", "a legacy row carries no key at all");
  assert.equal(await code({ natural_key: "R009:untrimmed" }), "HOLD_TARGET_AMBIGUOUS", "the natural-key selector reports the unreconciled row instead of creating a rival one");

  // A caller-supplied natural_key alongside the id is validated exactly as it is on its own route.
  assert.equal(await code({ existing_object_id: unique.id, natural_key: "R009:unique" }), "OK:EXISTING");
  assert.equal(await code({ existing_object_id: unique.id, natural_key: "R009:other" }), "HOLD_TARGET_NOT_FOUND", "contradicts the stored key");
  assert.equal(await code({ existing_object_id: unique.id, natural_key: "" }), "HOLD_TARGET_NOT_FOUND", "blank key");
  assert.equal(await code({ existing_object_id: unique.id, natural_key: "   " }), "HOLD_TARGET_NOT_FOUND", "whitespace-only key");
  assert.equal(await code({ existing_object_id: unique.id, natural_key: " R009:unique " }), "HOLD_TARGET_NOT_FOUND", "an untrimmed key is not a canonical value");
  assert.equal(await code({ existing_object_id: unique.id, logical_record_key: "unique-row" }), "HOLD_TARGET_NOT_FOUND", "a title is never part of a selector here");

  // Uniqueness that cannot be PROVEN is a HOLD on this route too, not a silent success.
  map.delete(`query:${pkg.pipelineDs}`);
  assert.equal(await code({ existing_object_id: unique.id }), "HOLD_TARGET_AMBIGUOUS", "an unavailable exact lookup never licenses a write");
});

test("PV-SALES-001/E11: resources that did not opt in keep their existing selector behaviour", async () => {
  const { v1 } = adapters();
  const map = new Map<string, unknown>();
  const list = (results: unknown[]) => ({ results, has_more: false, next_cursor: null });
  const root = synthetic("legacy-root");
  const db = synthetic("legacy-db");
  const ds = synthetic("legacy-ds");
  const parent = "03 — CONTROL PLANE";
  map.set(`children:${root}`, list([{ id: synthetic("legacy-parent"), type: "child_page", child_page: { title: parent } }]));
  map.set(`children:${synthetic("legacy-parent")}`, list([{ id: db, type: "child_database", child_database: { title: "Tasks" } }]));
  map.set(`database:${db}`, { data_sources: [{ id: ds }] });
  map.set(`data_source:${ds}`, { properties: { Task: { type: "title" }, "Idempotency Key": { type: "rich_text" }, Status: { type: "select" } } });

  // Same shapes E10 refuses for the outreach pipeline: a keyless row, an untrimmed key, a duplicated key.
  const row = (slug: string, stored: string | undefined): Page => ({
    object: "page", id: synthetic(slug), archived: false, parent: { type: "data_source_id", data_source_id: ds },
    properties: { Task: { type: "title", title: [text(slug)] }, ...(stored === undefined ? {} : { "Idempotency Key": { type: "rich_text", rich_text: [text(stored)] } }) },
  });
  const rows = [row("legacy-keyless", undefined), row("legacy-untrimmed", "  task:x  "), row("legacy-dup-a", "task:dup"), row("legacy-dup-b", "task:dup")];
  for (const p of rows) map.set(`page:${p.id}`, p);
  setRowsIn(map, ds, rows);

  const client = new FixtureNotionReadClient(map);
  const runtime = runtimeOn(v1, undefined, root);
  const spec = v1.grammar.controlPlane.resources?.["SALES:TASKS"];
  assert.notEqual(spec?.naturalKeyIsIdentity, true, "SALES:TASKS never opted in");
  const resolve = (selector: Record<string, string>) => resolveTarget(client, runtime, "BUSINESS", "SALES:TASKS", "UPDATE", selector);

  assert.equal((await resolve({ existing_object_id: (rows[0] as Page).id })).ok, true, "a keyless row is still addressable by id for a resource that did not opt in");
  assert.equal((await resolve({ existing_object_id: (rows[1] as Page).id })).ok, true, "an untrimmed stored key is still tolerated there");
  assert.equal((await resolve({ existing_object_id: (rows[2] as Page).id })).ok, true, "a duplicated key does not block the id route there");
  assert.equal((await resolve({ logical_record_key: "legacy-keyless" })).ok, true, "title addressing survives for legacy resources");
});

/** Same fixture scope as E10: the refusal logic, not the live query's result set. */
test("PV-SALES-001/E12: the remaining selector/operation combinations all fail closed", async () => {
  const { v1 } = adapters();
  const map = new Map<string, unknown>();
  const pkg = objectivePackage(map, "matrix");
  const client = new FixtureNotionReadClient(map);
  const runtime = runtimeOn(v1, pkg.root);

  const inPackage = (slug: string, stored: string, extra: Partial<Page> = {}): Page => ({
    object: "page", id: synthetic(slug), archived: false, parent: { type: "data_source_id", data_source_id: pkg.pipelineDs },
    properties: { [KEY_PROPERTY]: { type: "rich_text", rich_text: [text(stored)] } }, ...extra,
  });
  const live = inPackage("matrix-live", "R009:live");
  const archived = inPackage("matrix-archived", "R009:archived", { archived: true });
  const orphan: Page = { object: "page", id: synthetic("matrix-orphan"), archived: false, properties: { [KEY_PROPERTY]: { type: "rich_text", rich_text: [text("R009:orphan")] } } };
  const unreconciled = inPackage("matrix-unreconciled", " R009:new ");
  for (const p of [live, archived, orphan, unreconciled]) map.set(`page:${p.id}`, p);
  setRowsIn(map, pkg.pipelineDs, [live, archived, unreconciled]);

  const code = async (operation: "CREATE" | "UPDATE" | "UPSERT", selector: Record<string, string>, mode: "BUSINESS" | "INSTALL_ONLY" = "BUSINESS"): Promise<string> => {
    const outcome = await resolveTarget(client, runtime, mode, PIPELINE, operation, selector);
    return outcome.ok ? `OK:${outcome.target.kind}` : outcome.code;
  };

  assert.equal(await code("CREATE", { existing_object_id: live.id }), "HOLD_UNSUPPORTED_OPERATION", "a CREATE never names an existing row");
  assert.equal(await code("UPSERT", { natural_key: "R009:live" }), "HOLD_UNSUPPORTED_OPERATION", "the contract permits CREATE and UPDATE only");
  assert.equal(await code("UPDATE", { existing_object_id: "not-a-notion-id" }), "HOLD_TARGET_NOT_FOUND");
  assert.equal(await code("UPDATE", { existing_object_id: synthetic("never-created") }), "HOLD_TARGET_NOT_FOUND", "an unreadable page is not a target");
  assert.equal(await code("UPDATE", { existing_object_id: archived.id }), "HOLD_TARGET_NOT_FOUND", "an archived row is not a target");
  assert.equal(await code("UPDATE", { existing_object_id: orphan.id }), "HOLD_CROSS_RUNTIME", "a row whose parent cannot be read proves no membership");
  assert.equal(await code("UPDATE", { logical_record_key: "anything" }), "HOLD_TARGET_NOT_FOUND");
  assert.equal(await code("UPDATE", {}), "HOLD_TARGET_NOT_FOUND");
  assert.equal(await code("UPDATE", { natural_key: "R009:live" }, "INSTALL_ONLY"), "HOLD_UNSUPPORTED_OPERATION", "an installing binding reaches no business resource");

  // The case that would otherwise duplicate: a CREATE whose key already exists, but only after normalization.
  // Reporting it is what stops a rival row being written beside the unreconciled one.
  assert.equal(await code("CREATE", { natural_key: "R009:new" }), "HOLD_TARGET_AMBIGUOUS");
  assert.equal(await code("CREATE", { natural_key: "R009:live" }), "HOLD_DUPLICATE", "an exact existing key is a duplicate, not an ambiguity");
  assert.equal(await code("CREATE", { natural_key: "R009:absent" }), "OK:NEW", "a genuinely free key still creates");
});

/* ── Realistic query fixtures ──────────────────────────────────────────────────────────────────────────────
 * FixtureNotionReadClient DISCARDS the filter and returns every row, so it can prove what the harness SENDS
 * and what its client-side comparison decides, but never what a real equality filter would have returned.
 * The client below applies the one equality/contains condition the harness emits the way Notion evaluates it —
 * exact string comparison on the property value, no normalization — so a test can show which rows a live query
 * would actually surface. `unobservable` models a query that under-reports a row that genuinely exists (index
 * lag right after a write); it is an explicit simulation, not an artifact of the fixture.
 */
function filteringClient(map: Map<string, unknown>, opts: { unobservable?: ReadonlySet<string>; failQuery?: boolean } = {}): NotionReadClient {
  const inner = new FixtureNotionReadClient(map);
  const condition = (filter: unknown): { property: string; kind: "equals" | "contains"; value: string } | undefined => {
    if (filter === null || typeof filter !== "object") return undefined;
    const f = filter as Record<string, unknown>;
    const property = typeof f["property"] === "string" ? (f["property"] as string) : undefined;
    if (!property) return undefined;
    for (const [key, body] of Object.entries(f)) {
      if (key === "property" || body === null || typeof body !== "object") continue;
      const b = body as Record<string, unknown>;
      if (typeof b["equals"] === "string") return { property, kind: "equals", value: b["equals"] as string };
      if (typeof b["contains"] === "string") return { property, kind: "contains", value: b["contains"] as string };
    }
    return undefined;
  };
  return {
    retrievePage: (id) => inner.retrievePage(id),
    retrieveDatabase: (id) => inner.retrieveDatabase(id),
    retrieveDataSource: (id) => inner.retrieveDataSource(id),
    retrieveBlockChildren: (id) => inner.retrieveBlockChildren(id),
    async queryDataSource(id: string, filter?: unknown) {
      if (opts.failQuery) throw new Error("query unavailable");
      const all = ((map.get(`query:${id}`) as { results?: Page[] } | undefined)?.results ?? [])
        .filter((p) => !opts.unobservable?.has(p.id));
      const c = condition(filter);
      if (!c) return { results: all, has_more: false, next_cursor: null };
      const results = all.filter((p) => {
        const stored = propText(p, c.property);
        if (stored === undefined) return false;
        return c.kind === "equals" ? stored === c.value : stored.includes(c.value);
      });
      return { results, has_more: false, next_cursor: null };
    },
  };
}

test("PV-SALES-001/E13: a page id is only addressable when the live query shows that same row is the sole key holder", async () => {
  const { v1 } = adapters();
  const build = (): { map: Map<string, unknown>; pkg: Pkg; target: Page; rival: Page } => {
    const map = new Map<string, unknown>();
    const pkg = objectivePackage(map, "sole-holder");
    const mk = (slug: string, stored: string): Page => ({
      object: "page", id: synthetic(slug), archived: false, parent: { type: "data_source_id", data_source_id: pkg.pipelineDs },
      properties: { [KEY_PROPERTY]: { type: "rich_text", rich_text: [text(stored)] } },
    });
    const target = mk("sole-target", "R009:sole");
    const rival = mk("sole-rival", "R009:sole");
    for (const p of [target, rival]) map.set(`page:${p.id}`, p);
    setRowsIn(map, pkg.pipelineDs, [target, rival]);
    return { map, pkg, target, rival };
  };
  const code = async (map: Map<string, unknown>, pkg: Pkg, selector: Record<string, string>, opts?: Parameters<typeof filteringClient>[1]): Promise<string> => {
    const outcome = await resolveTarget(filteringClient(map, opts), runtimeOn(v1, pkg.root), "BUSINESS", PIPELINE, "UPDATE", selector);
    return outcome.ok ? `OK:${outcome.target.kind}` : outcome.code;
  };

  // Baseline: the target is genuinely alone under a real equality/contains filter.
  {
    const { map, pkg, target, rival } = build();
    setRowsIn(map, pkg.pipelineDs, [target]);
    map.delete(`page:${rival.id}`);
    assert.equal(await code(map, pkg, { existing_object_id: target.id }), "OK:EXISTING");
  }

  // Both rows are visible: two holders of one key is the duplicate the contract refuses.
  {
    const { map, pkg, target } = build();
    assert.equal(await code(map, pkg, { existing_object_id: target.id }), "HOLD_TARGET_AMBIGUOUS");
  }

  // The query returns ZERO rows although the page itself reads fine. Uniqueness is not proven, and the key
  // selector would have answered NOT_FOUND for the same observation.
  {
    const { map, pkg, target, rival } = build();
    setRowsIn(map, pkg.pipelineDs, [target]);
    map.delete(`page:${rival.id}`);
    assert.equal(await code(map, pkg, { existing_object_id: target.id }, { unobservable: new Set([target.id]) }), "HOLD_TARGET_NOT_FOUND");
  }

  // The query returns EXACTLY ONE row, but a different one: another record holds this key, so writing to the
  // page that was fetched directly would split one business identity across two rows.
  {
    const { map, pkg, target } = build();
    assert.equal(await code(map, pkg, { existing_object_id: target.id }, { unobservable: new Set([target.id]) }), "HOLD_TARGET_AMBIGUOUS");
  }

  // A lookup that cannot run at all stays a refusal on this route.
  {
    const { map, pkg, target } = build();
    assert.equal(await code(map, pkg, { existing_object_id: target.id }, { failQuery: true }), "HOLD_TARGET_AMBIGUOUS");
  }
});

test("PV-SALES-001/E14: an unreconciled near-duplicate is surfaced by the live query, not only by the fixture", async () => {
  const { v1 } = adapters();
  const map = new Map<string, unknown>();
  const pkg = objectivePackage(map, "near-duplicate");
  // A human-entered row whose key differs only by surrounding whitespace. A `rich_text.equals` condition cannot
  // see it, so a CREATE that trusted `equals` alone would report zero matches and write a rival row beside it.
  const stray: Page = {
    object: "page", id: synthetic("stray-row"), archived: false, parent: { type: "data_source_id", data_source_id: pkg.pipelineDs },
    properties: { [KEY_PROPERTY]: { type: "rich_text", rich_text: [text("  R009:stray  ")] } },
  };
  map.set(`page:${stray.id}`, stray);
  setRowsIn(map, pkg.pipelineDs, [stray]);
  const client = filteringClient(map);
  const runtime = runtimeOn(v1, pkg.root);

  const created = await resolveTarget(client, runtime, "BUSINESS", PIPELINE, "CREATE", { natural_key: "R009:stray" });
  assert.equal(created.ok, false, "a CREATE must not add a second row beside an unreconciled one");
  if (!created.ok) assert.equal(created.code, "HOLD_TARGET_AMBIGUOUS");

  const updated = await resolveTarget(client, runtime, "BUSINESS", PIPELINE, "UPDATE", { natural_key: "R009:stray" });
  assert.equal(updated.ok, false);
  if (!updated.ok) assert.equal(updated.code, "HOLD_TARGET_AMBIGUOUS");

  // A key that genuinely has no row is still free to create.
  const free = await resolveTarget(client, runtime, "BUSINESS", PIPELINE, "CREATE", { natural_key: "R009:free" });
  assert.equal(free.ok, true, JSON.stringify(free));
});
