/** Synthetic local B7 graph + real registered grammar; not a live cohort/install/ChatGPT proof. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canonicalJson } from "../../src/guards/canonical.ts";
import { encodeProperty, materializeProperty } from "../../src/notion/properties.ts";
import { propRelationIds, propText, type Page } from "../../src/notion/shapes.ts";
import { createMemoryStore } from "../../src/store/memory.ts";
import { observeB7DryRun, parseB7Workset, verifyB7Graph, type B7Workset } from "../../src/resume/b7DryRun.ts";
import { observePendingStepInput, pendingStepInputOfTransition, prepareIntentFor, prepareNoteFor, PREPARE_NOTE, unsatisfiedPendingStepInputs } from "../../src/resume/pendingInput.ts";
import { deriveCursorTransition } from "../../src/plans/cursorTransition.ts";
import { registerBuiltinSalesAdapters, type SalesContractAdapter } from "../../src/versions/adapters/sales.ts";
import { MapAdapterRegistry, type SalesRuntimeAdapter } from "../../src/versions/registry.ts";
import { eventVersionAllowed, EXTERNAL_SPEC, EXTERNAL_SCHEMA } from "../../src/effects/eventWrite.ts";
import { verifyTarget, observedField } from "../../src/verify/target.ts";
import { verifyFinal } from "../../src/verify/final.ts";
import type { Plan } from "../../src/plans/store.ts";
import type { BindingRecord } from "../../src/binding/store.ts";
import type { ResolvedRuntime } from "../../src/resolvers/types.ts";
import type { ResumeState } from "../../src/resume/derive.ts";
import type { HarnessDeps } from "../../src/tools/handlers.ts";
import { synthetic, text as rt } from "./meta-fixtures.ts";
import { guardWorld, index, CLASSES, G } from "../support/guard-fixtures.ts";
import { salesContractAdapter } from "../../src/versions/adapters/sales.ts";
import { bindLive } from "../../src/tools/handlers.ts";
import { OWNER } from "./binding-fixtures.ts";
import { CONTRACT_PAGE, IDS as SALES_IDS, SGRAMMAR } from "./sales-fixtures.ts";
import { R, setRowsIn } from "./resume-fixtures.ts";

const NOW = new Date("2030-01-01T00:00:00.000Z");
const registry = new MapAdapterRegistry<SalesRuntimeAdapter>(); registerBuiltinSalesAdapters(registry);
const SPEC = registry.supported().find(v => v.endsWith("/0.5.14-candidate"))!, OLD_SPEC = registry.supported().find(v => v.endsWith("/0.5.13-candidate"))!;
const adapter = registry.resolve(SPEC) as SalesContractAdapter;
const SCHEMA = adapter.supportedSchemas[0]!;
const grammar = adapter.grammar.controlPlane, transition = grammar.cursorTransitions!.at(-1)!;
const shape: Record<string, Record<string, string>> = {
  BUSINESS_CONFIG: { "Config Item": "title", Category: "select", State: "select", Version: "rich_text", Source: "rich_text", Value: "rich_text" },
  QUALIFICATION_GATES: { "Gate Key": "rich_text", Active: "checkbox", "Hard Gate": "checkbox", Criterion: "rich_text", "Pass Condition": "rich_text", "Required Evidence": "rich_text", "Fail Disposition": "select", Version: "rich_text" },
  ACCOUNTS: { Website: "url", Company: "title", Qualification: "select", Lifecycle: "select", "Do Not Contact": "checkbox", Source: "rich_text", "Open Gaps": "rich_text", "Next Action": "rich_text" },
  CONTACTS: { Email: "email", Account: "relation", "Email Status": "select", "Email Source": "url", "Buyer Role": "select", "Do Not Contact": "checkbox", Lifecycle: "select" },
  EVIDENCE: { "Source URL": "url", Claim: "title", Type: "select", Confidence: "select", "Source Provider": "rich_text", "Source Date": "date", Gate: "rich_text", Account: "relation", Contact: "relation" },
  OUTREACH_PIPELINE: { "Action Key": "rich_text", Outreach: "title", Account: "relation", Contact: "relation", Channel: "select", Angle: "rich_text", "Evidence-led opener": "rich_text", "Message version": "rich_text", Stage: "select", "Sent date": "date", "Last touch": "date", "Next touch": "date", Outcome: "select", Objection: "select", "Reply summary": "rich_text" },
  TASKS: { "Idempotency Key": "rich_text", "Runtime ID": "rich_text", Task: "title", Type: "select", Status: "select", Authority: "select", Account: "relation", Contact: "relation", "Expected Outcome": "rich_text" },
};
const lists = (results: unknown[]) => ({ results, has_more: false, next_cursor: null });
const propertyId = (field: string) => `native-${field}`;

async function fixture(count = 10, supplied?: { runtime: ResolvedRuntime; binding: BindingRecord; store: HarnessDeps["store"] }) {
  const root = supplied?.runtime.root_ref ?? synthetic("b7-root"), objective = synthetic("b7-objective"), cursor = synthetic("b7-cursor"), gen = supplied?.runtime.runtime_generation ?? "b7-generation";
  const runtime = supplied?.runtime ?? { root_ref: root, runtime_id: "B7-ISOLATED", runtime_generation: gen, lane: "SALES", logical_key: "VERTIGO/SALES/test",
    access_mode: "BUSINESS", observations: { objective_package_ref: objective }, adapter: { version: SPEC, controlPlane: grammar, capabilities: adapter.capabilities },
    versions: { governing_spec: { value: SPEC }, governing_schema: { value: SCHEMA }, governing_control: { value: "CONTROL/1" } } } as unknown as ResolvedRuntime;
  const binding = supplied?.binding ?? { principal_id: "b7-owner", project: "VERTIGO", lane: "SALES", runtime_id: runtime.runtime_id,
    runtime_generation: gen, binding_mode: "BUSINESS", binding_id: "b7-binding" } as BindingRecord;
  const map = new Map<string, unknown>(), rows = new Map<string, Page[]>(), ds = new Map<string, string>();
  map.set(`children:${root}`, lists([])); map.set(`children:${objective}`, lists([]));
  function addChild(parent: string, child: unknown) { const l = map.get(`children:${parent}`) as { results: unknown[] }; l.results.push(child); }
  for (const [r, fields] of Object.entries(shape)) {
    const spec = grammar.resources![`SALES:${r}`]!; const scope = spec.scope === "OBJECTIVE_PACKAGE" ? objective : root;
    let holder = scope;
    if (spec.parentTitle) {
      holder = synthetic(`holder-${scope}-${spec.parentTitle}`);
      if (!map.has(`children:${holder}`)) { map.set(`children:${holder}`, lists([])); addChild(scope, { id: holder, type: "child_page", child_page: { title: spec.parentTitle } }); }
    }
    const db = synthetic(`b7-db-${r}`), source = synthetic(`b7-ds-${r}`); ds.set(r, source);
    addChild(holder, { id: db, type: "child_database", child_database: { title: spec.databaseTitle } });
    map.set(`database:${db}`, { data_sources: [{ id: source }] }); rows.set(source, []);
    const properties = Object.fromEntries(Object.entries(fields).map(([f, type]) => [f, { id: propertyId(f), type,
      ...(type === "relation" ? { relation: { data_source_id: synthetic(`b7-ds-${f === "Account" ? "ACCOUNTS" : "CONTACTS"}`) } } : {}),
      ...(["select", "status"].includes(type) ? { [type]: { options: (f === "Channel" ? ["Email", "LinkedIn"] : f === "Type" ? ["RESEARCH", "SEND", "QUALIFY"] : f === "Status" ? ["READY", "DONE", "CANCELLED", "BLOCKED"] : f === "Authority" ? ["AUTO_ALLOWED", "HUMAN_APPROVAL", "HUMAN_ONLY"] : []).map(name => ({ name })) } } : {}),
    }])); map.set(`data_source:${source}`, { properties });
  }
  function add(r: string, key: string, values: Record<string, unknown>): Page {
    const source = ds.get(r)!, spec = grammar.resources![`SALES:${r}`]!, types = shape[r]!;
    const valuesWithKey = { ...Object.fromEntries(Object.entries(types).map(([f, t]) => [f, t === "checkbox" ? false : t === "relation" ? [] : ["title", "rich_text"].includes(t) ? "" : null])), ...values, [spec.naturalKeyProperty]: key };
    const properties = Object.fromEntries(Object.entries(valuesWithKey).map(([f, v]) => {
      const type = types[f]!, encoded = encodeProperty(type, v, { extensible: true }); assert.ok(encoded.ok, `${r}.${f}`);
      return [f, { ...materializeProperty(type, encoded.value), id: propertyId(f) }];
    }));
    const page = { id: synthetic(`b7-row-${r}-${key}`), archived: false, parent: { data_source_id: source }, properties } as Page;
    rows.get(source)!.push(page); map.set(`page:${page.id}`, page); return page;
  }
  const active = { gate_key: "G1", active: true as const, hard_gate: true as const, version: "RULE/1", criterion: "criterion", pass_condition: "pass", required_evidence: "public source", fail_disposition: "HOLD" as const };
  const hardGate = add("QUALIFICATION_GATES", "G1", { Active: true, "Hard Gate": true, Version: active.version, Criterion: active.criterion,
    "Pass Condition": active.pass_condition, "Required Evidence": active.required_evidence, "Fail Disposition": active.fail_disposition });
  const sample: B7Workset["sample"] = [], accounts: Page[] = [];
  for (let n = 0; n < count; n++) {
    const key = `https://account${String(n).padStart(2, "0")}.test/`;
    accounts.push(add("ACCOUNTS", key, { Company: "Synthetic account", Qualification: n === 0 ? "READY" : "HOLD", Lifecycle: "ACTIVE", Source: "public source", "Next Action": "research next" }));
    sample.push({ account_key: key, expected_qualification: n === 0 ? "READY" : "HOLD", evidence: n === 0 ? [{ source_url: "https://source.test/report", gate_key: "G1", role: "SUPPORTING" }] : [] });
  }
  const account = accounts[0]!, contact = add("CONTACTS", "member@example.test", { Account: [account.id], "Email Status": "PUBLIC_SOURCE", "Email Source": "https://source.test/", "Buyer Role": "UNKNOWN", Lifecycle: "ACTIVE" });
  const supporting = add("EVIDENCE", "https://source.test/report", { Claim: "Synthetic source claim", Type: "SOURCE_CLAIM", Confidence: "LIKELY", "Source Provider": "WEB", Gate: "G1", Account: [account.id], Contact: [contact.id] });
  const draft = add("OUTREACH_PIPELINE", "draft-01", { Outreach: "Synthetic draft", Account: [account.id], Contact: [contact.id], Channel: "Email", Angle: "synthetic angle", "Evidence-led opener": "synthetic opener", "Message version": "test message", Stage: "Draft" });
  const task = add("TASKS", "task-01", { "Runtime ID": runtime.runtime_id, Task: "Review draft", Type: "RESEARCH", Status: "READY", Authority: "AUTO_ALLOWED", Account: [account.id], Contact: [contact.id], "Expected Outcome": "Human review" });
  const w: B7Workset = { schema_id: "SALES_DRY_RUN_WORKSET/1", runtime_id: runtime.runtime_id, sales_contract_version: SPEC,
    sales_schema_version: SCHEMA, objective_package_id: objective, qualification_gates: [active], sample,
    cohort: [{ account_key: sample[0]!.account_key, contact_key: "member@example.test", draft_key: "draft-01", task_keys: ["task-01"] }] };
  const scope = add("BUSINESS_CONFIG", "B7_DRY_RUN:WORKSET", { Category: "OTHER", State: "CONFIRMED", Version: "SALES_DRY_RUN_WORKSET/1", Source: "CHAT_USER_EXPLICIT", Value: canonicalJson(w) });
  for (const t of grammar.cursorTransitions!.slice(0, -1)) add("BUSINESS_CONFIG", t.evidence.naturalKey,
    { ...t.evidence.equals, ...Object.fromEntries(t.evidence.nonEmpty.map(f => [f, "A prior confirmed answer"])) });
  const state = { effective_hold: "NONE" } as ResumeState;
  const stateSource = synthetic("b7-state-ds"), stateSpec = grammar.resources!["SALES:OS_STATE"]!;
  const holder = synthetic(`holder-${root}-${stateSpec.parentTitle}`), db = synthetic("b7-state-db");
  addChild(holder, { id: db, type: "child_database", child_database: { title: stateSpec.databaseTitle } });
  map.set(`database:${db}`, { data_sources: [{ id: stateSource }] });
  map.set(`data_source:${stateSource}`, { properties: { Name: { type: "title" }, "Current Gate": { type: "rich_text" } } });
  const cursorRow: Page = { id: cursor, parent: { data_source_id: stateSource }, properties: { Name: { type: "title", title: [rt("CURRENT")] }, "Current Gate": { type: "rich_text", rich_text: [rt("B7_DRY_RUN")] }, "Last Run Ref": { type: "rich_text", rich_text: [rt("prior-run")] } } };
  rows.set(stateSource, [cursorRow]); map.set(`page:${cursor}`, cursorRow);
  const queries: string[] = [];
  function matches(p: Page, f: any): boolean {
    if (!f) return true;
    if (f.or) return f.or.some((v: unknown) => matches(p, v));
    if (f.and) return f.and.every((v: unknown) => matches(p, v));
    if (f.relation) return propRelationIds(p, f.property).includes(f.relation.contains);
    const op = f.title ?? f.rich_text ?? f.url ?? f.email ?? f.checkbox;
    return op && (op.equals !== undefined ? propText(p, f.property) === String(op.equals) : (propText(p, f.property) ?? "").includes(op.contains));
  }
  const notion = { retrievePage: async (id: string) => map.get(`page:${id}`), retrieveDatabase: async (id: string) => map.get(`database:${id}`),
    retrieveDataSource: async (id: string) => map.get(`data_source:${id}`), retrieveBlockChildren: async (id: string) => map.get(`children:${id}`),
    queryDataSource: async (id: string, filter: unknown) => { queries.push(id); return lists((rows.get(id) ?? []).filter(p => matches(p, filter))); } };
  const store = supplied?.store ?? createMemoryStore(); const deps = { notion, store } as HarnessDeps;
  const ops = [...rows].filter(([id]) => id !== stateSource).flatMap(([source, ps]) => ps.map(p => {
    const r = [...ds].find(([, id]) => id === source)![0]; const key = grammar.resources![`SALES:${r}`]!.naturalKeyProperty;
    return { r, source, p, key };
  })).map(({ r, source, p, key }, ordinal) => ({ ordinal, operation_id: `op-${ordinal}`, operation: "UPDATE" as const, logical_resource_key: `SALES:${r}`, physical_target_ref: p.id,
    target_data_source_ref: source, natural_key: propText(p, key)!, natural_key_property: key, idempotency_key: `i-${ordinal}`,
    compared_fields: Object.keys(p.properties).filter(f => f !== key), before_values: {}, expected_values: Object.fromEntries(Object.keys(p.properties).map(f => [f, p.properties[f]?.type === "relation" ? propRelationIds(p, f) : observedField(p, f) ?? null])) }));
  const plan = { plan_id: "b7-seed-plan", plan_kind: "BUSINESS", principal_id: binding.principal_id, binding_id: binding.binding_id,
    project: binding.project, lane: binding.lane, runtime_logical_key: runtime.logical_key, runtime_id: runtime.runtime_id, runtime_generation: gen,
    governing_spec_version: SPEC, governing_schema_version: SCHEMA, governing_control_version: runtime.versions.governing_control === "UNKNOWN" ? "UNKNOWN" : runtime.versions.governing_control.value, run_mode: "OPEN_NEW", execution_attempt_id: "seed",
    created_at: NOW, expires_at: new Date("2040-01-01"), baseline_runtime_revision: "seed", plan_state: "FINAL_VERIFIED", operations: ops,
    stage1_writes: [], finalization_writes: [], state_last_write: { symbol: "STATE_LAST", ordinal: 0, target_ref: cursor, operation: "UPDATE", purpose: "STATE_LAST", fields: {},
      operation_property_ids: Object.fromEntries(ops.map(o => [String(o.ordinal), Object.fromEntries(o.compared_fields.map(f => [f, propertyId(f)]))])) } } as Plan;
  await store.plans.insert(plan);
  await store.planWrites.ensure(plan.plan_id, [{ symbol: "STATE_LAST", ordinal: 0, phase: "STATE_LAST", target_ref: cursor, operation: "UPDATE" }]);
  await store.planWrites.transition(plan.plan_id, "STATE_LAST", "PENDING", "SENT", { at: NOW, payload_hash: "synthetic-final-journal" });
  await store.planWrites.transition(plan.plan_id, "STATE_LAST", "SENT", "DONE", { at: NOW });
  const receipt = { principal_id: binding.principal_id, runtime_id: runtime.runtime_id, runtime_generation: gen, plan_id: plan.plan_id, observed_at: NOW, observations: {} };
  await store.receipts.insert({ ...receipt, receipt_id: "seed-target", type: "TARGET", status: "CONSUMED" });
  await store.receipts.insert({ ...receipt, receipt_id: "seed-final", target_receipt_id: "seed-target", type: "FINAL", status: "VALID" });
  function change(p: Page, field: string, value: unknown) {
    const type = p.properties[field]!.type, encoded = encodeProperty(type, value, { extensible: true }); assert.ok(encoded.ok);
    Object.assign(p.properties, { [field]: { ...materializeProperty(type, encoded.value), id: propertyId(field) } });
  }
  return { runtime, binding, deps, map, rows, ds, state, w, scope, account, contact, supporting, draft, task, hardGate, plan, queries, change, add };
}

test("B7/a: actual new grammar moves only a fully scoped graph with backend field lineage", async () => {
  const f = await fixture(); assert.equal(transition.evidence.kind, "B7_GRAPH");
  const observed = await observeB7DryRun(f.deps, f.binding, f.runtime); assert.equal(observed.kind, "SATISFIED", JSON.stringify(observed));
  const derived = await deriveCursorTransition(f.deps, f.binding, f.runtime, f.state); assert.equal(derived.kind, "INTENT", JSON.stringify(derived));
  if (derived.kind === "INTENT") assert.deepEqual(derived.intent.mutations[0]?.desired_changes, { ...transition.set, "Gate Passed By Run Ref": "prior-run", "Last Run Ref": "$created:OPEN_RUN", "Last Required Written At": "$now", "Last Verified At": "$now", "Open Blocker": "" });
  assert.equal(f.queries.filter(x => x === f.ds.get("BUSINESS_CONFIG")).length, 2, "one batched setup query per independent observation");
  const pending = await observePendingStepInput(f.deps.notion, f.runtime, pendingStepInputOfTransition("B7_DRY_RUN", transition));
  assert.notEqual(pending.kind, "SATISFIED", "a confirmed scope alone never completes B7");
});

for (const [name, mutate] of Object.entries({
  "classification UNKNOWN": (f: Awaited<ReturnType<typeof fixture>>) => f.change(f.account, "Qualification", "UNASSESSED"),
  "hard gate drift": f => f.change(f.hardGate, "Criterion", "changed rule"),
  "support UNKNOWN": f => f.change(f.supporting, "Confidence", "UNKNOWN"),
  "unsupported support": f => f.change(f.supporting, "Type", "TRACKER_SIGNAL"),
  "foreign Contact": f => f.change(f.contact, "Account", [synthetic("foreign")]),
  "extra draft Contact": f => f.change(f.draft, "Contact", [f.contact.id, synthetic("foreign-contact")]),
  "extra draft Account": f => f.change(f.draft, "Account", [f.account.id, synthetic("foreign-account")]),
  "DNC Account": f => f.change(f.account, "Do Not Contact", true),
  "DNC Contact": f => f.change(f.contact, "Do Not Contact", true),
  "opt out": f => f.change(f.contact, "Lifecycle", "OPT_OUT"),
  "email not verified": f => f.change(f.contact, "Email Status", "UNKNOWN"),
  "effect-bearing draft": f => f.change(f.draft, "Stage", "Sent"),
  "sent timestamp": f => f.change(f.draft, "Sent date", "2030-01-01"),
  "empty opener": f => f.change(f.draft, "Evidence-led opener", ""),
  "foreign task": f => f.change(f.task, "Runtime ID", "ANOTHER"),
  "terminal task": f => f.change(f.task, "Status", "DONE"),
  "automatic SEND task": f => f.change(f.task, "Type", "SEND"),
  "field value has no current proof": f => f.change(f.account, "Open Gaps", "new observation"),
  "self attestation": f => f.change(f.scope, "Value", "PASS"),
  "forged workset": f => f.change(f.scope, "Value", canonicalJson({ ...f.w, verified: true })),
} as Record<string, (f: Awaited<ReturnType<typeof fixture>>) => void>)) test(`B7/negative: ${name}`, async () => {
  const f = await fixture(); mutate(f); const out = await observeB7DryRun(f.deps, f.binding, f.runtime); assert.equal(out.kind, "HOLD", JSON.stringify(out));
});

test("B7/b: current-tuple FINAL, native property identity, target lineage and completed journal are mandatory", async () => {
  for (const defect of ["receipt", "plan", "property", "target", "journal", "principal", "version"] as const) {
    const f = await fixture();
    if (defect === "receipt") await f.deps.store.receipts.setStatus("seed-final", "INVALID");
    if (defect === "plan") await f.deps.store.plans.setState(f.plan.plan_id, "HOLD");
    if (defect === "property") Object.assign(f.account.properties["Open Gaps"]!, { id: "recreated-property" });
    if (defect === "target") await f.deps.store.receipts.setStatus("seed-target", "INVALID");
    if (defect === "journal") await f.deps.store.plans.insert({ ...f.plan, finalization_writes: [{ ...f.plan.state_last_write, symbol: "MISSING" }] });
    if (defect === "principal" || defect === "version") await f.deps.store.plans.insert({ ...f.plan, ...(defect === "principal" ? { principal_id: "foreign" } : { governing_spec_version: OLD_SPEC }) });
    const out = await observeB7DryRun(f.deps, f.binding, f.runtime); assert.equal(out.kind, "HOLD", defect);
  }
});

test("B7/c: unknown tails, duplicate exact identities, undisclosed Evidence and wrong authority refuse", async () => {
  for (const defect of ["tail", "duplicate", "undisclosed", "authority"] as const) {
    const f = await fixture();
    if (defect === "tail") Object.assign(f.deps.notion, { queryDataSource: async () => ({ results: [], has_more: true, next_cursor: null }) });
    if (defect === "duplicate") f.rows.get(f.ds.get("ACCOUNTS")!)!.push(f.account);
    if (defect === "undisclosed") f.add("EVIDENCE", "https://source.test/another", { Claim: "disclosed required", Gate: "G1", Account: [f.account.id] });
    if (defect === "authority") {
      const schema = f.map.get(`data_source:${f.ds.get("OUTREACH_PIPELINE")}`) as any;
      schema.properties.Account.relation.data_source_id = synthetic("other-authority");
    }
    const out = await observeB7DryRun(f.deps, f.binding, f.runtime); assert.equal(out.kind, "HOLD", defect);
    if (defect === "authority") assert.equal(f.queries.length, 0, "schema authority refused before any business row");
  }
});

test("B7/d: 10 and 25 bounds; no extra business thresholds or source dates invented", async () => {
  for (const n of [9, 10, 25, 26]) {
    const f = await fixture(n); const out = await observeB7DryRun(f.deps, f.binding, f.runtime);
    assert.equal(out.kind, n === 10 || n === 25 ? "SATISFIED" : "HOLD", `${n}: ${JSON.stringify(out)}`);
  }
});

test("B7/e: TARGET and FINAL re-observe the graph, not the old SATISFIED flag", async () => {
  const f = await fixture(), ready = await observeB7DryRun(f.deps, f.binding, f.runtime); assert.equal(ready.kind, "SATISFIED"); if (ready.kind !== "SATISFIED") return;
  const plan = { ...f.plan, plan_id: "new-move", plan_state: "AWAITING_STAGE1_WRITES" as const, state_last_write: { ...f.plan.state_last_write, b7_graph_fingerprint: ready.fingerprint } };
  assert.equal(await verifyB7Graph(f.deps, f.binding, f.runtime, plan), undefined);
  f.change(f.hardGate, "Version", "RULE/2");
  assert.equal((await verifyB7Graph(f.deps, f.binding, f.runtime, plan))?.kind, "HOLD");
  await f.deps.store.plans.insert(plan);
  assert.equal((await verifyTarget(f.deps, f.binding, f.runtime, plan, NOW)).kind, "HOLD");
  await f.deps.store.plans.setState(plan.plan_id, "TARGET_VERIFIED");
  await f.deps.store.receipts.insert({ receipt_id: "move-target", plan_id: plan.plan_id, principal_id: f.binding.principal_id,
    runtime_id: f.runtime.runtime_id, runtime_generation: f.runtime.runtime_generation, type: "TARGET", status: "VALID", observed_at: NOW, expires_at: new Date("2040-01-01"), observations: {} });
  assert.equal((await verifyFinal(f.deps, f.binding, f.runtime, plan, NOW)).kind, "HOLD");
});

test("B7/f: legacy rollback and unknown evidence kinds never get the graph transition", async () => {
  const f = await fixture(), old = registry.resolve(OLD_SPEC) as SalesContractAdapter;
  const rolledBack = { ...f.runtime, adapter: { ...f.runtime.adapter, controlPlane: old.grammar.controlPlane } };
  assert.equal((await deriveCursorTransition(f.deps, f.binding, rolledBack, f.state)).kind, "HOLD");
  const unknown = { ...f.runtime, adapter: { ...f.runtime.adapter, controlPlane: { ...grammar,
    cursorTransitions: [{ ...transition, evidence: { ...transition.evidence, kind: "UNKNOWN" } }] } } } as unknown as ResolvedRuntime;
  const out = await deriveCursorTransition(f.deps, f.binding, unknown, f.state); assert.equal(out.kind === "HOLD" ? out.code : undefined, "HOLD_GATE_UNSPECIFIED");
  assert.equal(eventVersionAllowed(f.runtime), true); assert.equal(eventVersionAllowed({ ...f.runtime, versions: { ...f.runtime.versions, governing_schema: { value: "UNKNOWN_SCHEMA" } } } as ResolvedRuntime), false);
});

test("B7/g: canonical strict workset and UTF16 chunk boundaries", async () => {
  const f = await fixture();
  for (const v of [JSON.stringify(f.w), canonicalJson({ ...f.w, cohort: [] }), canonicalJson({ ...f.w, runtime_id: "foreign" }), "x".repeat(65537)]) assert.equal(parseB7Workset(v, f.runtime), undefined);
  const value = "x".repeat(1999) + "😀" + "y".repeat(2400), encoded = encodeProperty("rich_text", value); assert.ok(encoded.ok);
  const property = encoded.value as { rich_text: { text: { content: string } }[] };
  const chunks = property.rich_text.map(t => t.text.content); assert.equal(chunks.join(""), value);
  assert.ok(chunks.every(c => c.length <= 2000 && !/[\uD800-\uDBFF]$/.test(c) && !/^[\uDC00-\uDFFF]/.test(c)));
});

async function serverFixture(classes: Parameters<typeof index>[1] = []) {
  // Actual registered new graph grammar, isolated addressing override and no capability-profile fixture.
  // This proves dispatcher/writer/proof composition, not candidate boot/adoption/installed capabilities.
  const g = guardWorld({ gate: "B7_DRY_RUN", doc: index([], [CLASSES.cursor(), { class: "PRODUCTION", resource_key: "SALES:BUSINESS_CONFIG", operation: "UPSERT", allowed_fields: [...Object.keys(transition.evidence.equals), ...transition.evidence.nonEmpty] }, ...classes]) });
  const cursorSchema = g.map.get(`data_source:${R.salesStateDs}`) as { properties: Record<string, unknown> };
  for (const [field, names] of Object.entries({ "Current Gate": ["B7_DRY_RUN", "READY"], "Build State": ["B7_DRY_RUN", "READY"],
    "Current Gate Status": ["OPEN", "PASS"], "Last Durable Mode": ["COMMIT", "GO", "INTAKE", "REVIEW", "RECOVERY"] }))
    cursorSchema.properties[field] = { type: "select", select: { options: names.map(name => ({ name })) } };
  g.deps.adapters.salesRuntime.register(SPEC, salesContractAdapter(SPEC, [SCHEMA], { ...SGRAMMAR, controlPlane: grammar }));
  const ids = SALES_IDS("rep-a"), manifest = g.map.get(`page:${ids.manifestRow}`) as Page;
  setRowsIn(g.map, ids.manifestDs, [{ ...manifest, properties: { ...manifest.properties,
    "Sales Contract Version": { type: "rich_text", rich_text: [rt(SPEC)] }, "Schema Version": { type: "rich_text", rich_text: [rt(SCHEMA)] } } }]);
  g.map.set(`page:${CONTRACT_PAGE}`, { id: CONTRACT_PAGE, properties: { title: { type: "title", title: [rt(SPEC)] } } });
  const objective = synthetic("b7-objective");
  // Registry authority pointer is already supplied by fixture assignment; set the precise assignment.
  const assignment = await g.deps.salesRegistry.lookup("rep-a");
  assert.ok(assignment);
  g.w.setSalesRegistry([{ ...assignment, objective_package_ref: objective }]);
  const h = await g.bind(), live = await bindLive(h, { principal_id: OWNER.principal_id, now: new Date(g.clock.t) }, g.deps);
  assert.ok(live.ok, JSON.stringify(live)); if (!live.ok) throw new Error("fixture binding failed");
  assert.equal(live.runtime.observations.objective_package_ref, objective);
  const f = await fixture(10, { runtime: live.runtime, binding: live.binding, store: g.deps.store });
  const oldRoot = g.map.get(`children:${G.root}`) as { results: any[] };
  const newRoot = f.map.get(`children:${G.root}`) as { results: any[] };
  for (const child of newRoot.results) {
    const title = child.child_page?.title, old = oldRoot.results.find(x => x.child_page?.title === title);
    if (old) {
      const oldChildren = g.map.get(`children:${old.id}`) as { results: any[] }, fresh = f.map.get(`children:${child.id}`) as { results: any[] };
      const titles = new Set(fresh.results.map(x => x.child_database?.title));
      fresh.results = [...fresh.results.filter(x => x.child_database?.title !== "OS State"), ...oldChildren.results.filter(x => !titles.has(x.child_database?.title) || x.child_database?.title === "OS State")];
    }
  }
  const replaceTitles = new Set(newRoot.results.map(c => c.child_page?.title));
  newRoot.results = [...oldRoot.results.filter(c => !replaceTitles.has(c.child_page?.title)), ...newRoot.results];
  for (const [k, value] of f.map) g.map.set(k, value);
  for (const [source, pages] of f.rows) if ([...f.ds.values()].includes(source)) setRowsIn(g.map, source, pages);
  const original = g.deps.notion;
  Object.assign(g.deps, { notion: { ...original, queryDataSource: (source: string, filter: unknown, cursor?: string) => [...f.ds.values()].includes(source)
    ? f.deps.notion.queryDataSource(source, filter, cursor) : original.queryDataSource(source, filter, cursor) } });
  // New resource holder keeps original control-plane databases, including native cursor and Run history.
  await g.approve();
  return { g, h, f };
}

test("B7/h: public server dispatch proves READY exactly once and keeps business rows unchanged", async () => {
  const { g, h, f } = await serverFixture();
  const businessBefore = JSON.stringify([...f.rows].filter(([source]) => [...f.ds.values()].includes(source)));
  const out = await g.commit(h, {}); assert.equal(out.kind, "PERSISTED", JSON.stringify(out));
  if (out.kind !== "PERSISTED") return;
  assert.equal(out.next_gate, "READY"); assert.equal(out.step_moved, true);
  const plan = await g.deps.store.plans.get(out.plan_id); assert.ok(plan?.state_last_write.b7_graph_fingerprint);
  assert.equal((await g.deps.store.receipts.get(out.final_receipt_id))?.status, "VALID");
  assert.equal((await g.deps.store.receipts.get(out.target_receipt_id))?.status, "CONSUMED");
  assert.equal(JSON.stringify([...f.rows].filter(([source]) => [...f.ds.values()].includes(source))), businessBefore);
  // Ordinary READY must not re-run the scoped B7 field proof at every use.
  g.deps.store.receipts.findFinalByFields = async () => { throw new Error("B7 lookup called after READY"); };
  const writes = g.client.writes.length, again = await g.commit(h, {});
  assert.equal(g.client.writes.length, writes, "READY replay must not create any new cursor or business write");
  assert.notEqual(again.kind, "PERSISTED", "no second graph transition exists on terminal READY");
  const row = (g.map.get(`query:${R.salesStateDs}`) as { results: Page[] }).results[0]!;
  assert.equal(propText(row, "Current Gate"), "READY"); assert.equal(propText(row, "Last Durable Mode"), "COMMIT");
});

test("B7/i: no human JSON requirement, raw PASS refused before Plan or byte", async () => {
  const pending = pendingStepInputOfTransition("B7_DRY_RUN", transition);
  assert.match(prepareNoteFor(pending), /never JSON or IDs/);
  assert.equal(prepareNoteFor(pendingStepInputOfTransition(grammar.cursorTransitions![0]!.fromGate, grammar.cursorTransitions![0]!)), PREPARE_NOTE);
  const { g, h, f } = await serverFixture(), template = prepareIntentFor(pending);
  const before = await g.deps.store.plans.listByRuntime("VERTIGO", "SALES", f.runtime.runtime_generation);
  const out = await g.commit(h, { intent: { ...template, mutations: template.mutations.map(m => ({ ...m, desired_changes: { ...m.desired_changes, Value: "PASS" } })) } });
  assert.equal(out.kind, "HELD", JSON.stringify(out));
  if (out.kind === "HELD") { assert.equal(out.code, "HOLD_UNSUPPORTED_OPERATION"); assert.match(out.evidence.join(" "), /workset.*not canonical/); }
  assert.equal(g.client.writes.length, 0);
  assert.equal((await g.deps.store.plans.listByRuntime("VERTIGO", "SALES", f.runtime.runtime_generation)).length, before.length);
});

test("B7/j: short budget resumes exact journal once, State last, without business replay", async () => {
  const { g, h, f } = await serverFixture();
  const create = g.client.createPage.bind(g.client); let paused = false;
  g.client.createPage = async (...args) => { const row = await create(...args); if (!paused) { paused = true; g.clock.t += 30_000; } return row; };
  const before = JSON.stringify([...f.rows].filter(([source]) => [...f.ds.values()].includes(source)));
  const first = await g.commit(h, {}, { commitBudgetMs: 17_000 });
  assert.equal(first.kind, "IN_PROGRESS", JSON.stringify(first));
  assert.equal(propText((g.map.get(`query:${R.salesStateDs}`) as { results: Page[] }).results[0]!, "Current Gate"), "B7_DRY_RUN");
  const started = g.client.writes.map(w => [w.ctx.plan_id, w.ctx.symbol]);
  const resumed = await g.commit(h, {});
  assert.equal(resumed.kind, "PERSISTED", JSON.stringify(resumed));
  assert.equal(propText((g.map.get(`query:${R.salesStateDs}`) as { results: Page[] }).results[0]!, "Current Gate"), "READY");
  for (const [plan, symbol] of started) assert.equal(g.client.writes.filter(w => w.ctx.plan_id === plan && w.ctx.symbol === symbol).length, 1, "completed instruction is not re-sent");
  if (resumed.kind === "PERSISTED") {
    const plan = (await g.deps.store.plans.get(resumed.plan_id))!;
    assert.ok(plan.state_last_write.b7_graph_fingerprint);
    assert.equal(g.client.writes.filter(w => w.ctx.plan_id === plan.plan_id).at(-1)?.ctx.symbol, plan.state_last_write.symbol);
  }
  assert.equal(JSON.stringify([...f.rows].filter(([source]) => [...f.ds.values()].includes(source))), before);
});

test("B7/k: native key re-addressing and unread relation tail cannot acquire proof", async () => {
  const f = await fixture();
  Object.assign(f.contact.properties.Account!, { has_more: true });
  assert.equal((await observeB7DryRun(f.deps, f.binding, f.runtime)).kind, "HOLD");
  delete (f.contact.properties.Account as { has_more?: boolean }).has_more;
  f.plan.operations[0] && Object.assign(f.plan.operations[0], { natural_key: "manually renamed" });
  assert.equal((await observeB7DryRun(f.deps, f.binding, f.runtime)).kind, "HOLD");
});

test("B7/l: valid scope is not asked twice, but never becomes a satisfied graph", async () => {
  const f = await fixture();
  assert.deepEqual(await unsatisfiedPendingStepInputs(f.deps.notion, f.runtime, "B7_DRY_RUN"), []);
  assert.equal((await observePendingStepInput(f.deps.notion, f.runtime, pendingStepInputOfTransition("B7_DRY_RUN", transition))).kind, "INCOMPLETE");
  f.change(f.scope, "Value", "PASS");
  assert.equal((await unsatisfiedPendingStepInputs(f.deps.notion, f.runtime, "B7_DRY_RUN")).length, 1);
});

test("B7/review-B1: undisclosed server-matched Evidence with a truncated Account relation holds", async () => {
  const f = await fixture(), hidden = f.add("EVIDENCE", "https://source.test/hidden", { Claim: "undisclosed row", Gate: "G1", Account: [synthetic("first-visible-foreign-account")] });
  Object.assign(hidden.properties.Account!, { has_more: true });
  const query = f.deps.notion.queryDataSource.bind(f.deps.notion);
  Object.assign(f.deps.notion, { queryDataSource: async (ds: string, filter: any, cursor?: string) => {
    const q = await query(ds, filter, cursor) as { results: Page[] };
    // The server matched an Account in the unread tail. The fixture's ordinary relation filter cannot simulate it.
    return ds === f.ds.get("EVIDENCE") && filter?.or?.some((v: any) => v.relation) ? lists([...q.results, hidden]) : q;
  } });
  const out = await observeB7DryRun(f.deps, f.binding, f.runtime);
  assert.equal(out.kind, "HOLD"); if (out.kind === "HOLD") assert.match(out.evidence.join(" "), /slice.*unread property tail/);
});

test("B7/review-B2: historical event admission is unchanged; empty-build switch remains explicit", async () => {
  const f = await fixture();
  for (const schema of [EXTERNAL_SCHEMA, "unsupported"]) {
    const historical = { ...f.runtime, versions: { ...f.runtime.versions, governing_spec: { value: EXTERNAL_SPEC }, governing_schema: { value: schema } } } as ResolvedRuntime;
    assert.equal(eventVersionAllowed(historical), EXTERNAL_SPEC !== "" && EXTERNAL_SCHEMA !== "" && schema === EXTERNAL_SCHEMA);
  }
  // Static branch proof, not a claim that the frozen registration constants were changed at runtime.
  const source = readFileSync(new URL("../../src/effects/eventWrite.ts", import.meta.url), "utf8");
  assert.match(source, /if \(EXTERNAL_SPEC === "" \|\| EXTERNAL_SCHEMA === ""\) return false;/);
});

test("B7/review-B3-B5: real public prepare admits business writes at B7 and binds shared field names by operation", async () => {
  const { g, h, f } = await serverFixture([{ class: "PRODUCTION", resource_key: "SALES:ACCOUNTS", operation: "UPSERT", allowed_fields: ["Source"] }]);
  const accountSchema = f.map.get(`data_source:${f.ds.get("ACCOUNTS")}`) as any;
  const configSchema = f.map.get(`data_source:${f.ds.get("BUSINESS_CONFIG")}`) as any;
  accountSchema.properties.Source.id = "account-source-native";
  configSchema.properties.Source.id = "config-source-native";
  configSchema.properties.Category.select.options = [{ name: "OTHER" }];
  configSchema.properties.State.select.options = [{ name: "CONFIRMED" }];
  const out = await g.commit(h, { intent: { action_class: "COMMIT", summary: "two confined trial updates", mutations: [
    { logical_resource_key: "SALES:ACCOUNTS", operation: "UPSERT", record_selector: { natural_key: f.w.sample[0]!.account_key }, desired_changes: { Source: "amended research source" } },
    { logical_resource_key: "SALES:BUSINESS_CONFIG", operation: "UPSERT", record_selector: { natural_key: "LOCAL:B7_SOURCE_TEST" }, desired_changes: { Category: "OTHER", State: "CONFIRMED", Version: "SALES_INPUT/1", Source: "CHAT_USER_EXPLICIT", Value: "local trial choice" } },
  ] } }, { commitBudgetMs: 0 });
  assert.equal(out.kind, "IN_PROGRESS", JSON.stringify(out)); if (out.kind !== "IN_PROGRESS") return;
  const plan = (await g.deps.store.plans.get(out.plan_id))!;
  assert.equal(plan.operations.length, 2);
  for (const operation of plan.operations) assert.equal(plan.state_last_write.operation_property_ids?.[String(operation.ordinal)]?.Source,
    operation.logical_resource_key === "SALES:ACCOUNTS" ? "account-source-native" : "config-source-native");
  assert.equal(g.client.writes.length, 0, "zero budget prepares durable instructions, never sends bytes");
});

test("B7/review-gap: wrong-parent row, unresolved work and forged READY are refused", async () => {
  const f = await fixture();
  const parent = f.account.parent; Object.assign(f.account, { parent: { data_source_id: synthetic("foreign-runtime-ds") } });
  const wrong = await observeB7DryRun(f.deps, f.binding, f.runtime);
  assert.equal(wrong.kind === "HOLD" ? wrong.code : undefined, "HOLD_CROSS_RUNTIME");
  Object.assign(f.account, { parent }); const count = f.queries.length;
  const blocked = await deriveCursorTransition(f.deps, f.binding, f.runtime, { ...f.state, effective_hold: { code: "HOLD_RECOVERY_REQUIRED", evidence: ["pending plan"], safe_action: "recover" } } as ResumeState);
  assert.equal(blocked.kind, "HOLD"); assert.ok(f.queries.slice(count).every(ds => ![...f.ds.values()].includes(ds)), "unresolved work refuses before business graph queries; a fresh cursor read remains required");
  const { g, h } = await serverFixture();
  const forged = await g.commit(h, { intent: { action_class: "COMMIT", summary: "forge READY", mutations: [{ logical_resource_key: "SALES:OS_STATE", operation: "UPDATE", record_selector: { natural_key: "Current" }, desired_changes: { "Current Gate": "READY" } }] } });
  assert.equal(forged.kind, "HELD"); if (forged.kind === "HELD") assert.equal(forged.code, "HOLD_ACTION_NOT_AUTHORIZED");
  assert.equal(g.client.writes.length, 0);
});

test("B7/review-B3-legacy: a historical public commit does not capture or enforce native IDs", async () => {
  const g = guardWorld({ doc: index([], [CLASSES.cursor(), { class: "PRODUCTION", resource_key: "SALES:BUSINESS_CONFIG", operation: "UPSERT", allowed_fields: ["Category", "State", "Version", "Source", "Value"] }]) });
  const schema = g.map.get(`data_source:${G.configDs}`) as { properties: Record<string, { id?: string }> };
  for (const [field, p] of Object.entries(schema.properties)) p.id = `legacy-native-${field}`;
  const h = await g.bind(); await g.approve();
  const live = await bindLive(h, { principal_id: OWNER.principal_id, now: new Date(g.clock.t) }, g.deps); assert.ok(live.ok); if (!live.ok) return;
  const t = live.runtime.adapter.controlPlane.cursorTransitions![0]!;
  const template = prepareIntentFor(pendingStepInputOfTransition(t.fromGate, t));
  const out = await g.commit(h, { intent: { ...template, mutations: template.mutations.map(m => ({ ...m, desired_changes: { ...m.desired_changes, Value: "historical local answer" } })) } }, { commitBudgetMs: 17_000 });
  assert.equal(out.kind, "PERSISTED", JSON.stringify(out)); if (out.kind !== "PERSISTED") return;
  assert.equal((await g.deps.store.plans.get(out.plan_id))!.state_last_write.operation_property_ids, undefined);
});
