/** PV-SALES-001 — version-dispatched Personal SALES V1 catalog and safe B0 continuation. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FixtureNotionReadClient } from "../../src/notion/readClient.ts";
import type { Page } from "../../src/notion/shapes.ts";
import type { Plan } from "../../src/plans/store.ts";
import { resolveTarget } from "../../src/plans/resources.ts";
import { replaceCompletedCapabilityPrompt } from "../../src/resume/engine.ts";
import type { ResumeState } from "../../src/resume/derive.ts";
import type { ResolvedRuntime } from "../../src/resolvers/types.ts";
import { registerBuiltinSalesAdapters, salesContractAdapter, type SalesContractAdapter } from "../../src/versions/adapters/sales.ts";
import { createAdapterRegistries } from "../../src/versions/registry.ts";
import { dispatch } from "../../src/tools/handlers.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import { handleOf, OWNER, T0 } from "./binding-fixtures.ts";
import { synthetic, text } from "./meta-fixtures.ts";
import { buildResumeWorld, R, SCHEMAS, setRowsIn } from "./resume-fixtures.ts";
import { CONTRACT_PAGE, IDS as SALES_IDS, SGRAMMAR, SV } from "./sales-fixtures.ts";
import { executeWrites, rowsOf } from "./target-fixtures.ts";

const V1_SUFFIX = "/0.5.3-candidate";
const expectedKeys: Record<string, [string, string]> = {
  "SALES:BUSINESS_CONFIG": ["Business Configuration", "Config Item"],
  "SALES:QUALIFICATION_GATES": ["Qualification Gates", "Gate Key"],
  "SALES:INTAKE": ["Intake", "Source Reference"],
  "SALES:ACCOUNTS": ["Accounts", "Website"],
  "SALES:CONTACTS": ["Contacts", "Email"],
  "SALES:EVIDENCE": ["Evidence", "Source URL"],
  "SALES:SEQUENCES": ["Sequences", "Sequence"],
  "SALES:TASKS": ["Tasks", "Idempotency Key"],
  "SALES:EXTERNAL_ACTIONS": ["External Actions", "Action Key"],
};

function v1(): SalesContractAdapter {
  const registries = createAdapterRegistries();
  registerBuiltinSalesAdapters(registries.salesRuntime);
  const version = registries.salesRuntime.supported().find((candidate) => candidate.endsWith(V1_SUFFIX));
  assert.ok(version);
  return registries.salesRuntime.resolve(version) as SalesContractAdapter;
}

test("PV-SALES-001/A: 0.5.3 dispatch exposes exactly the bounded V1 resources with existing physical key properties", () => {
  const adapter = v1();
  const registries = createAdapterRegistries();
  registerBuiltinSalesAdapters(registries.salesRuntime);
  const bridgeVersion = registries.salesRuntime.supported().find((candidate) => candidate.endsWith("/0.5.2-candidate"));
  assert.ok(bridgeVersion);
  const bridge = registries.salesRuntime.resolve(bridgeVersion) as SalesContractAdapter;
  assert.equal(adapter.supportedSchemas.length, 1, "exactly one schema line is accepted; nothing is guessed");
  assert.notDeepEqual(adapter.supportedSchemas, bridge.supportedSchemas, "V1 accepts only the schema carrying the outreach idempotency key");
  const resources = adapter.grammar.controlPlane.resources ?? {};
  for (const [key, [database, naturalKey]] of Object.entries(expectedKeys)) {
    assert.equal(resources[key]?.databaseTitle, database, key);
    assert.equal(resources[key]?.naturalKeyProperty, naturalKey, key);
    assert.ok(resources[key]?.protectedProperties?.includes(naturalKey), `${key} natural key is caller-immutable`);
  }
  assert.equal(resources["SALES:ACCOUNTS"]?.naturalKeyProperty, "Website", "account title is never identity");
  assert.equal(resources["SALES:CONTACTS"]?.naturalKeyProperty, "Email", "contact title is never identity");
  assert.equal(resources["SALES:EVIDENCE"]?.naturalKeyProperty, "Source URL", "V1 is one consolidated evidence row per source URL");

  const physical = new Map((adapter.grammar.controlPlane.installContract?.physicalResources ?? []).map((r) => [r.key, r]));
  for (const [key, [, naturalKey]] of Object.entries(expectedKeys)) {
    const physicalKey = key.slice("SALES:".length);
    assert.equal(physical.get(physicalKey)?.requiredProperties?.[naturalKey],
      naturalKey === "Website" || naturalKey === "Source URL" ? "url" : naturalKey === "Email" ? "email" : naturalKey === "Config Item" || naturalKey === "Sequence" ? "title" : "rich_text",
      `installer validates ${physicalKey}.${naturalKey} before BUSINESS`);
  }
});

function fixtureFor(adapter: SalesContractAdapter): { client: FixtureNotionReadClient; runtime: ResolvedRuntime; ids: Record<string, string>; map: Map<string, unknown> } {
  const root = synthetic("sales-v1-root");
  const m = new Map<string, unknown>();
  const ids: Record<string, string> = {};
  const list = (results: unknown[]) => ({ results, has_more: false, next_cursor: null });
  const parentTitles = [...new Set(Object.values(expectedKeys).map(([database]) => {
    const entry = Object.values(adapter.grammar.controlPlane.resources ?? {}).find((r) => r.databaseTitle === database);
    return entry?.parentTitle as string;
  }))];
  m.set(`children:${root}`, list(parentTitles.map((title) => {
    const id = synthetic(`parent-${title}`); ids[`parent:${title}`] = id;
    return { id, type: "child_page", child_page: { title } };
  })));
  for (const [logicalKey, [databaseTitle, naturalKey]] of Object.entries(expectedKeys)) {
    const spec = adapter.grammar.controlPlane.resources?.[logicalKey];
    assert.ok(spec?.parentTitle);
    const db = synthetic(`db-${logicalKey}`); const ds = synthetic(`ds-${logicalKey}`);
    ids[logicalKey] = ds;
    const parent = ids[`parent:${spec.parentTitle}`] as string;
    const current = (m.get(`children:${parent}`) as { results?: unknown[] } | undefined)?.results ?? [];
    m.set(`children:${parent}`, list([...current, { id: db, type: "child_database", child_database: { title: databaseTitle } }]));
    m.set(`database:${db}`, { data_sources: [{ id: ds }] });
    const type = naturalKey === "Website" || naturalKey === "Source URL" ? "url" : naturalKey === "Email" ? "email" : naturalKey === "Config Item" || naturalKey === "Sequence" ? "title" : "rich_text";
    m.set(`data_source:${ds}`, { properties: { [naturalKey]: { type }, Name: { type: "title" }, Claim: { type: "title" }, Company: { type: "title" }, Contact: { type: "title" }, Intake: { type: "title" }, Gate: { type: "title" }, Task: { type: "title" }, Action: { type: "title" } } });
    m.set(`query:${ds}`, list([]));
  }
  const runtime = {
    root_ref: root, runtime_id: "SALES-V1-FIXTURE", runtime_generation: "g1", lane: "SALES", logical_key: "VERTIGO/SALES/fixture",
    access_mode: "BUSINESS", manifest_ref: synthetic("manifest"), locator_ref: "registry:fixture", pointer_generation: "1",
    lifecycle_state: "SETUP", owner_display: "Fixture", versions: { governing_spec: "UNKNOWN", governing_schema: "UNKNOWN", governing_control: "UNKNOWN", candidates: [], historical_pins: [] },
    manifest_pins: { ref: synthetic("manifest-pin"), spec: adapter.contractVersion, schema: adapter.supportedSchemas[0] as string, control: "NOT_APPLICABLE" },
    historical_pins: [], adopted_records: [], observations: {}, warnings: [], adapter: { version: adapter.contractVersion, controlPlane: adapter.grammar.controlPlane, capabilities: adapter.capabilities },
  } as unknown as ResolvedRuntime;
  return { client: new FixtureNotionReadClient(m), runtime, ids, map: m };
}

test("PV-SALES-001/B: natural keys resolve NEW deterministically; invalid identity and duplicate source evidence fail closed", async () => {
  const adapter = v1();
  const { client, runtime, ids, map } = fixtureFor(adapter);
  const examples: Record<string, string> = {
    "SALES:BUSINESS_CONFIG": "OFFER:PRIMARY", "SALES:QUALIFICATION_GATES": "G1_PROCESS",
    "SALES:INTAKE": "upload:sha256:abc", "SALES:ACCOUNTS": "https://acme.example/",
    "SALES:CONTACTS": "buyer@acme.example", "SALES:EVIDENCE": "https://acme.example/proof",
    "SALES:SEQUENCES": "industrial-first-touch-v1", "SALES:TASKS": "task:acme:qualify:v1",
    "SALES:EXTERNAL_ACTIONS": "action:acme:buyer:first-touch:v1",
  };
  for (const [key, natural] of Object.entries(examples)) {
    const operation = key === "SALES:EXTERNAL_ACTIONS" ? "CREATE" : "UPSERT";
    const outcome = await resolveTarget(client, runtime, "BUSINESS", key, operation, { natural_key: natural });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    if (outcome.ok) assert.deepEqual({ kind: outcome.target.kind, ds: outcome.target.data_source.id, natural: outcome.target.kind === "NEW" ? outcome.target.natural_key : "" }, { kind: "NEW", ds: ids[key], natural });
  }
  assert.equal((await resolveTarget(client, runtime, "BUSINESS", "SALES:ACCOUNTS", "UPSERT", { natural_key: "Acme" })).ok, false);
  assert.equal((await resolveTarget(client, runtime, "BUSINESS", "SALES:ACCOUNTS", "UPSERT", { natural_key: "https://acme.example" })).ok, false, "URL missing canonical trailing slash cannot fork account identity");
  assert.equal((await resolveTarget(client, runtime, "BUSINESS", "SALES:CONTACTS", "UPSERT", { natural_key: "Buyer@acme.example" })).ok, false);

  const evidenceDs = ids["SALES:EVIDENCE"] as string;
  const source = examples["SALES:EVIDENCE"] as string;
  const duplicate = (id: string): Page => ({ id, parent: { type: "data_source_id", data_source_id: evidenceDs }, properties: { Claim: { type: "title", title: [text(id)] }, "Source URL": { type: "url", url: source } } });
  const rows = [duplicate(synthetic("ev-a")), duplicate(synthetic("ev-b"))];
  map.set(`query:${evidenceDs}`, { results: rows, has_more: false, next_cursor: null });
  for (const row of rows) map.set(`page:${row.id}`, row);
  const ambiguous = await resolveTarget(client, runtime, "BUSINESS", "SALES:EVIDENCE", "UPSERT", { natural_key: source });
  assert.equal(ambiguous.ok, false);
  if (!ambiguous.ok) assert.equal(ambiguous.code, "HOLD_TARGET_AMBIGUOUS");
});

test("PV-SALES-001/C: completed Gmail+Calendar at B0 replaces only stale connector remediation with business work", () => {
  const adapter = v1();
  const base = {
    runtime_state: "SETUP", persistence_health: "PASS", health: "HEALTHY", recovery_required: false, recovery_reasons: [],
    current_run: "NOT_FOUND", mutations: { incomplete_count: 0, incomplete_refs: [], last_verified_ref: "NONE" },
    gate: { gate_key: "B0_DISCOVERY", status: "OPEN", control_confirmation_state: "UNKNOWN", metadata_stale: "NOT_APPLICABLE", gate_last_edited_at: "2030-01-01T00:00:00.000Z", formal_blocker: "Autorisation Calendar requise", formal_next_action: "Connectez Google Calendar", formal_next_question: "UNKNOWN", source: "CURSOR" },
    effective_hold: { code: "HOLD_UNKNOWN_REQUIRED_FACT", evidence: ["open blocker: autorisation Calendar requise"] },
    next_safe_action: "Connectez Google Calendar", external_intents_unresolved: 0,
    external_actions: { unresolved: [], reconciliation_required: false, competent_source: "GMAIL" }, historical_holds: [], historical_mutations: [], meta_inputs: "NOT_APPLICABLE", cursor_ref: synthetic("cursor"), cursor_last_edited: "2030-01-01T00:00:00.000Z",
  } as unknown as ResumeState;
  const runtime = { adapter: { capabilities: adapter.capabilities } } as unknown as ResolvedRuntime;
  const resumed = replaceCompletedCapabilityPrompt(runtime, base);
  assert.equal(resumed.effective_hold, "NONE");
  assert.match(resumed.next_safe_action, /résultat commercial/i);
  assert.match(String(resumed.gate.formal_next_question), /résultat commercial concret/i);

  const business = { ...base, gate: { ...base.gate, formal_blocker: "Offre inconnue", formal_next_action: "Définir l'offre" }, effective_hold: { code: "HOLD_UNKNOWN_REQUIRED_FACT", evidence: ["open blocker: offre inconnue"] } } as ResumeState;
  assert.deepEqual(replaceCompletedCapabilityPrompt(runtime, business), business, "a business blocker is never cleared");
});

test("PV-SALES-001/D: all nine V1 resources complete the native writer TARGET -> FINAL transaction", async () => {
  const w = buildResumeWorld();
  const candidate = v1();
  const contract = "TEST_SALES_CONTRACT/1.1.0";
  w.deps.adapters.salesRuntime.register(contract, salesContractAdapter(contract, [SV.schema], { ...SGRAMMAR, controlPlane: candidate.grammar.controlPlane }));

  const ids = SALES_IDS("rep-a");
  const manifest = w.map.get(`page:${ids.manifestRow}`) as Page;
  const adopted: Page = { ...manifest, properties: { ...manifest.properties, "Sales Contract Version": { type: "rich_text", rich_text: [text(contract)] } } };
  setRowsIn(w.map, ids.manifestDs, [adopted]);
  w.map.set(`page:${CONTRACT_PAGE}`, { object: "page", id: CONTRACT_PAGE, archived: false, properties: { title: { type: "title", title: [text(contract)] } } });

  const list = (results: unknown[]) => ({ results, has_more: false, next_cursor: null });
  const parents = { setup: synthetic("v1-setup"), data: synthetic("v1-data"), ops: synthetic("v1-ops") };
  const rootChildren = ((w.map.get(`children:${ids.root}`) as { results: unknown[] }).results);
  w.map.set(`children:${ids.root}`, list([...rootChildren,
    { id: parents.setup, type: "child_page", child_page: { title: "02 — SETUP & BUSINESS CONFIG" } },
    { id: parents.data, type: "child_page", child_page: { title: "04 — DATA & EVIDENCE" } },
    { id: parents.ops, type: "child_page", child_page: { title: "05 — OPERATIONS & PLAYBOOKS" } },
  ]));
  const cpChildren = ((w.map.get(`children:${R.salesCp}`) as { results: unknown[] }).results);
  const resourceDefs: Array<[string, string, string, Record<string, string>]> = [
    [parents.setup, "Business Configuration", "business", { "Config Item": "title", Category: "select", State: "select", Value: "rich_text" }],
    [parents.setup, "Qualification Gates", "gates", { Gate: "title", "Gate Key": "rich_text", Active: "checkbox", "Hard Gate": "checkbox", "Pass Condition": "rich_text" }],
    [parents.data, "Intake", "intake", { Intake: "title", "Source Reference": "rich_text", Status: "select", "Source Type": "select", Target: "rich_text", "Human Required": "checkbox" }],
    [parents.data, "Accounts", "accounts", { Company: "title", Website: "url", Qualification: "select", Lifecycle: "select", "Do Not Contact": "checkbox" }],
    [parents.data, "Contacts", "contacts", { Contact: "title", Email: "email", "Email Status": "select", Lifecycle: "select", "Do Not Contact": "checkbox" }],
    [parents.data, "Evidence", "evidence", { Claim: "title", "Source URL": "url", Type: "select", Confidence: "select" }],
    [parents.ops, "Sequences", "sequences", { Sequence: "title", Status: "select", "Default Authority": "select", "Max Steps": "number", "Stop Conditions": "rich_text" }],
    [R.salesCp, "Tasks", "tasks", { Task: "title", "Idempotency Key": "rich_text", Status: "select", Type: "select", Authority: "select", "Runtime ID": "rich_text" }],
  ];
  const dsByName: Record<string, string> = {};
  const parentBlocks = new Map<string, unknown[]>([[parents.setup, []], [parents.data, []], [parents.ops, []], [R.salesCp, [...cpChildren]]]);
  for (const [parent, title, slug, properties] of resourceDefs) {
    const db = synthetic(`v1-${slug}-db`); const ds = synthetic(`v1-${slug}-ds`); dsByName[title] = ds;
    parentBlocks.set(parent, [...(parentBlocks.get(parent) ?? []), { id: db, type: "child_database", child_database: { title } }]);
    w.map.set(`database:${db}`, { data_sources: [{ id: ds }] });
    w.map.set(`data_source:${ds}`, { properties: Object.fromEntries(Object.entries(properties).map(([name, type]) => [name, { type }])) });
    setRowsIn(w.map, ds, []);
  }
  for (const [parent, blocks] of parentBlocks) w.map.set(`children:${parent}`, list(blocks));

  const h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, { principal_id: OWNER.principal_id, now: T0 }, w.deps));
  const mutations = [
    { logical_resource_key: "SALES:BUSINESS_CONFIG", operation: "UPSERT", record_selector: { natural_key: "OFFER:PRIMARY" }, desired_changes: { Category: "OFFER", State: "CONFIRMED", Value: "Industrial storytelling" } },
    { logical_resource_key: "SALES:QUALIFICATION_GATES", operation: "UPSERT", record_selector: { natural_key: "G1_PROCESS" }, desired_changes: { Gate: "G1 — Process", Active: true, "Hard Gate": true, "Pass Condition": "observable process" } },
    { logical_resource_key: "SALES:INTAKE", operation: "UPSERT", record_selector: { natural_key: "upload:sha256:abc" }, desired_changes: { Intake: "ICP input", Status: "RECEIVED", "Source Type": "CHAT_UPLOAD", Target: "ACCOUNTS", "Human Required": false } },
    { logical_resource_key: "SALES:ACCOUNTS", operation: "UPSERT", record_selector: { natural_key: "https://acme.example/" }, desired_changes: { Company: "Acme", Qualification: "UNASSESSED", Lifecycle: "RESEARCH", "Do Not Contact": false } },
    { logical_resource_key: "SALES:CONTACTS", operation: "UPSERT", record_selector: { natural_key: "buyer@acme.example" }, desired_changes: { Contact: "Buyer", "Email Status": "PUBLIC_SOURCE", Lifecycle: "NEW", "Do Not Contact": false } },
    { logical_resource_key: "SALES:EVIDENCE", operation: "UPSERT", record_selector: { natural_key: "https://acme.example/proof" }, desired_changes: { Claim: "Acme publishes process video", Type: "OBSERVED_FACT", Confidence: "CERTAIN" } },
    { logical_resource_key: "SALES:SEQUENCES", operation: "UPSERT", record_selector: { natural_key: "industrial-first-touch-v1" }, desired_changes: { Status: "DRAFT", "Default Authority": "HUMAN_APPROVAL", "Max Steps": 3, "Stop Conditions": "human reply or opt-out" } },
    { logical_resource_key: "SALES:TASKS", operation: "UPSERT", record_selector: { natural_key: "task:acme:qualify:v1" }, desired_changes: { Task: "Qualify Acme", Status: "READY", Type: "QUALIFY", Authority: "AUTO_ALLOWED" } },
    { logical_resource_key: "SALES:EXTERNAL_ACTIONS", operation: "CREATE", record_selector: { natural_key: "action:acme:first-touch:v1" }, desired_changes: { Action: "Prepare Acme first touch", "Action Type": "GMAIL_DRAFT", Recipient: "buyer@acme.example", "Subject / Content Hash": "sha256:test" } },
  ];
  const prepared = await dispatch("os_prepare", { binding_handle: h, intent: { action_class: "COMMIT", summary: "Sales V1 bounded lifecycle", mutations } }, { principal_id: OWNER.principal_id, now: T0 }, w.deps);
  assert.equal(prepared.code, "PLAN_PREPARED", JSON.stringify(prepared));
  const plan = await w.deps.store.plans.get(((prepared as Extract<Envelope, { status: "OK" }>).result as { plan_id: string }).plan_id) as Plan;
  assert.equal(plan.operations.length, 9);
  const symbols = executeWrites(w, plan.stage1_writes, plan.plan_id, { now: "2030-01-03T00:30:00.000Z" });
  const target = await dispatch("os_verify", { binding_handle: h, plan_id: plan.plan_id, phase: "TARGET" }, { principal_id: OWNER.principal_id, now: T0 }, w.deps);
  assert.equal(target.code, "TARGET_VERIFIED", JSON.stringify(target));
  const targetResult = (target as Extract<Envelope, { status: "OK" }>).result as { target_receipt_id: string };
  const observedSymbols = (target.observations["symbols"] as Record<string, string> | undefined) ?? symbols;
  executeWrites(w, plan.finalization_writes, plan.plan_id, { ...({ now: "2030-01-03T00:31:00.000Z" }), created: observedSymbols, target_receipt_id: targetResult.target_receipt_id });
  executeWrites(w, [plan.state_last_write], plan.plan_id, { ...({ now: "2030-01-03T00:32:00.000Z" }), created: observedSymbols, target_receipt_id: targetResult.target_receipt_id });
  const final = await dispatch("os_verify", { binding_handle: h, plan_id: plan.plan_id, phase: "FINAL" }, { principal_id: OWNER.principal_id, now: T0 }, w.deps);
  assert.equal(final.code, "TRANSACTION_VERIFIED", JSON.stringify(final));
  for (const title of ["Business Configuration", "Qualification Gates", "Intake", "Accounts", "Contacts", "Evidence", "Sequences", "Tasks"]) assert.equal(rowsOf(w, dsByName[title] as string).length, 1, title);
  assert.equal(rowsOf(w, R.salesExtDs).filter((row) => JSON.stringify(row).includes("action:acme:first-touch:v1")).length, 1);
});
