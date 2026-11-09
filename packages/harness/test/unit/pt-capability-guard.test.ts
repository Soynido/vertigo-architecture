/** W4.7R3 local fixtures only: real signed factory, classifier, guard and transactional dispatcher. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hashHandle } from "../../src/binding/handle.ts";
import { guardBindingId } from "../../src/binding/guardIdentity.ts";
import { classify } from "../../src/guards/classify.ts";
import { checkMutations, openGuard } from "../../src/guards/preflight.ts";
import { digestOf } from "../../src/guards/canonical.ts";
import type { GuardSnapshot } from "../../src/guards/snapshot.ts";
import { deriveCapabilityRemediation, isBackendOwnedCapabilityMutation, capabilityMutationForPlan, storedCapabilityProofMatches } from "../../src/resume/capabilityRemediation.ts";
import { prepare } from "../../src/plans/prepare.ts";
import { discoverControlPlane } from "../../src/resume/readers.ts";
import { executeStage1 } from "../../src/transactions/execute.ts";
import { Deadline } from "../../src/transactions/budget.ts";
import { driveCapabilityCommit, preparedCapabilityDraft } from "../../probe-w47-budget.mjs";
import { capabilityProofKey } from "../../src/resume/capabilities.ts";
import { InMemorySalesRuntimeRegistry } from "../../src/registry/salesRuntimes.ts";
import { bindLive, dispatch } from "../../src/tools/handlers.ts";
import { candidateResume } from "../../src/tools/conduct.ts";
import { hold } from "../../src/tools/envelope.ts";
import { PostgresBackend } from "../../src/store/postgres.ts";
import type { BackendStore } from "../../src/store/memory.ts";
import { registerBuiltinSalesAdapters } from "../../src/versions/adapters/sales.ts";
import { SALES_CONTROL_PLANE_0513_CANDIDATE } from "../../src/versions/adapters/controlPlane.ts";
import { EXTERNAL_SPEC, EXTERNAL_SCHEMA } from "../../src/effects/eventWrite.ts";
import { propText, type Page } from "../../src/notion/shapes.ts";
import { OWNER } from "./binding-fixtures.ts";
import { synthetic, text } from "./meta-fixtures.ts";
import { IDS, CONTRACT_PAGE, registryEntries } from "./sales-fixtures.ts";
import { R, setRowsIn } from "./resume-fixtures.ts";
import { CLASSES, G, guardWorld, index, NOW, putRows, rowsOf, rule, eq, lit, p0, setIndex, type ClassEntry } from "../support/guard-fixtures.ts";

const P = synthetic("capability-guard-profile"), DB = synthetic("capability-guard-profile-db");
const FIELDS = ["Capability Proof", "Capability Key", "State", "Runtime ID", "Principal Key", "Operating Mode", "Competent Source", "Evidence Ref", "Verified At", "Scope"];
const CLASS: ClassEntry = { class: "RECONCILE_AS_IS", resource_key: "SALES:CAPABILITY_PROOFS", operation: "CREATE", allowed_fields: FIELDS };
const rt = (value: string) => ({ type: "rich_text", rich_text: [text(value)] });
const list = (results: unknown[]) => ({ results, has_more: false, next_cursor: null });

function world(triggered = false) {
  // Missing semantics are UNKNOWN in this synthetic approval, not a real operator coverage attestation.
  const g = guardWorld({ doc: index(triggered ? [p0(1, eq(lit(true), lit(true)))] : [], [CLASS, { ...CLASSES.taskProduction, type_option_ids: [...CLASSES.taskProduction.type_option_ids] }]), rules: [rule("capability-p0", 1)] });
  Object.assign(g.deps, { salesRegistry: new InMemorySalesRuntimeRegistry(registryEntries()) });
  registerBuiltinSalesAdapters(g.deps.adapters.salesRuntime);
  const ids = IDS("rep-a"), manifest = g.map.get(`page:${ids.manifestRow}`) as Page;
  setRowsIn(g.map, ids.manifestDs, [{ ...manifest, properties: { ...manifest.properties, "Sales Contract Version": rt(EXTERNAL_SPEC), "Schema Version": rt(EXTERNAL_SCHEMA) } } as Page]);
  g.map.set(`page:${CONTRACT_PAGE}`, { object: "page", id: CONTRACT_PAGE, archived: false, properties: { title: { type: "title", title: [text(EXTERNAL_SPEC)] } } });
  const root = (g.map.get(`children:${G.root}`) as { results: Array<{ child_page?: { title: string } }> }).results;
  g.map.set(`children:${G.root}`, list(root.map((b) => b.child_page?.title === "00 — BOOT" ? { ...b, child_page: { title: "00 — BOOT & INSTANCE" } } : b)));
  const cp = (g.map.get(`children:${G.cp}`) as { results: unknown[] }).results;
  g.map.set(`children:${G.cp}`, list([...cp, { object: "block", id: DB, type: "child_database", child_database: { title: "Capability Profile" } }]));
  g.map.set(`database:${DB}`, { object: "database", id: DB, data_sources: [{ id: P }] });
  const profile = SALES_CONTROL_PLANE_0513_CANDIDATE.installContract!.physicalResources.find((r) => r.key === "CAPABILITY_PROFILE")!;
  g.map.set(`data_source:${P}`, { properties: Object.fromEntries(Object.entries(profile.requiredProperties!).map(([k, type]) => [k, { type, ...(type === "select" ? { select: { options: (profile.requiredSelectOptions?.[k] ?? []).map((name) => ({ name })) } } : {}) }])) });
  const proofKey = capabilityProofKey({ runtimeId: "SALESOS-FIXTURE-A", principalKey: "rep-a", capability: "CALENDAR_READ", operatingMode: "SALES_OPERATIONS", verifiedAt: NOW.toISOString(), evidenceRef: "fixture:calendar" });
  putRows(g.map, P, [{ object: "page", id: synthetic("capability-guard-calendar"), properties: {
    "Capability Proof": { type: "title", title: [text("Calendar native read")] }, "Capability Proof Key": rt(proofKey),
    "Capability Key": rt("CALENDAR_READ"), "Runtime ID": rt("SALESOS-FIXTURE-A"), "Principal Key": rt("rep-a"),
    "Operating Mode": rt("SALES_OPERATIONS"), "Evidence Ref": rt("fixture:calendar"), Scope: rt("principal:rep-a;runtime:SALESOS-FIXTURE-A"),
    State: { type: "select", select: { name: "READ_VERIFIED" } }, "Competent Source": { type: "select", select: { name: "GOOGLE_CALENDAR" } }, "Verified At": { type: "date", date: { start: NOW.toISOString() } },
  } } as Page]);
  return g;
}

async function ready(approve = true, triggered = false, store?: BackendStore) {
  const g = world(triggered);
  if (store) Object.assign(g.deps, { store });
  const h = await g.bind();
  if (approve) await g.approve(); // Existing fixture approval API only; no live credentials or writes.
  const resumed = await dispatch("os_resume", { binding_handle: h }, { principal_id: OWNER.principal_id, now: NOW }, g.deps);
  assert.equal(resumed.code, "HOLD_REQUIRED_CAPABILITY_INCOMPLETE", JSON.stringify(resumed));
  const challenge = resumed.observations.capability_remediation as { challenge: string; capability: string; competent_source: string };
  assert.equal(challenge.capability, "GMAIL_READ");
  const evidence = { challenge: challenge.challenge, competent_source: challenge.competent_source, source_identity: "rep-a@example.invalid", evidence_ref: "fixture:gmail-profile", verified_at: NOW.toISOString() };
  const bound = await bindLive(h, { principal_id: OWNER.principal_id, now: NOW }, g.deps);
  assert.ok(bound.ok); if (!bound.ok) throw new Error("fixture binding failed");
  const derived = await deriveCapabilityRemediation(g.deps.notion, bound.binding, bound.runtime, evidence, NOW, g.deps.competentSource);
  assert.equal(derived.kind, "READY", JSON.stringify(derived)); if (derived.kind !== "READY") throw new Error("fixture factory failed");
  return { g, h, evidence, bound, intent: derived.intent, mutation: derived.intent.mutations[0]! };
}

test("W4.7R3/a: original frozen capability mutation alone receives the exact approved reconciliation class", async () => {
  const { g, bound, intent, mutation } = await ready();
  const opened = await openGuard(g.deps, bound.binding, bound.runtime, NOW);
  assert.equal(opened.kind, "OPEN"); if (opened.kind !== "OPEN") return;
  assert.ok(Object.isFrozen(intent) && Object.isFrozen(intent.mutations) && Object.isFrozen(mutation.desired_changes) && Object.isFrozen(mutation.record_selector));
  assert.throws(() => { (mutation.desired_changes as Record<string, unknown>).State = "WRITE_VERIFIED"; }, TypeError);
  assert.throws(() => { (mutation.record_selector as { natural_key: string }).natural_key = "forged"; }, TypeError);
  assert.throws(() => { (intent.mutations as unknown[]).push(mutation); }, TypeError);
  assert.ok(isBackendOwnedCapabilityMutation(bound.runtime, mutation));
  assert.deepEqual(await classify(g.deps.notion, bound.runtime, "BUSINESS", mutation, opened.snapshot), { kind: "CLASS", cls: "RECONCILE_AS_IS" });
  for (const copy of [{ ...mutation }, structuredClone(mutation), JSON.parse(JSON.stringify(mutation)), { ...mutation, operation: "UPDATE" as const }, { ...mutation, logical_resource_key: "SALES:TASKS" }])
    assert.ok(!isBackendOwnedCapabilityMutation(bound.runtime, copy));
  for (const copy of [{ ...mutation }, structuredClone(mutation), JSON.parse(JSON.stringify(mutation))])
    assert.equal((await classify(g.deps.notion, bound.runtime, "BUSINESS", copy, opened.snapshot)).kind, "UNCLASSIFIED");
  const entry = opened.snapshot.index.operation_classes[0]!;
  for (const entries of [[], [entry, entry], [{ ...entry, allowed_fields: [...FIELDS, "EXTRA"] }], [{ ...entry, allowed_fields: FIELDS.slice(1) }],
    [{ ...entry, class: "PRODUCTION" as const }], [{ ...entry, class: "FUTURE_PROTECTION" as const, date_field: "Verified At" }], [{ ...entry, date_field: "Verified At" }]]) {
    const snapshot: GuardSnapshot = { ...opened.snapshot, index: { ...opened.snapshot.index, operation_classes: entries } };
    assert.equal((await classify(g.deps.notion, bound.runtime, "BUSINESS", mutation, snapshot)).kind, "UNCLASSIFIED");
  }
  assert.equal(g.client.writes.length, 0);
});

test("W4.7R3/b: provenance cannot cross runtime, generation, root, lane or governing schema", async () => {
  const { bound, mutation } = await ready(); const runtime = bound.runtime;
  assert.notEqual(runtime.versions.governing_schema, "UNKNOWN");
  const schema = runtime.versions.governing_schema;
  if (schema === "UNKNOWN") return;
  for (const other of [{ ...runtime, runtime_id: "foreign" }, { ...runtime, runtime_generation: "foreign" }, { ...runtime, root_ref: synthetic("foreign-root") },
    { ...runtime, lane: "META" as const }, { ...runtime, versions: { ...runtime.versions, governing_schema: { ...schema, value: "foreign" } } },
    { ...runtime, adapter: { ...runtime.adapter, controlPlane: { ...runtime.adapter.controlPlane } } }])
    assert.ok(!isBackendOwnedCapabilityMutation(other, mutation));
});

test("W4.7R3/c: unknown or triggered P0 still blocks production, never an approved factory reconciliation", async () => {
  for (const triggered of [false, true]) {
    const { g, bound, mutation } = await ready(true, triggered);
    const opened = await openGuard(g.deps, bound.binding, bound.runtime, NOW);
    assert.equal(opened.kind, "OPEN"); if (opened.kind !== "OPEN") continue;
    assert.equal(opened.p0.verdicts.get(1), triggered ? "TRIGGERED" : "UNVERIFIABLE");
    assert.ok(opened.productionBlock);
    assert.equal((await checkMutations(g.deps.notion, bound.runtime, bound.binding, opened, [mutation])).kind, "PASS");
    const production = await checkMutations(g.deps.notion, bound.runtime, bound.binding, opened, [{ logical_resource_key: "SALES:TASKS", operation: "CREATE", record_selector: { natural_key: "new-task" }, desired_changes: { Task: "Do outreach", Status: "READY", Type: "PROSPECTION" } }]);
    assert.equal(production.kind, "HOLD");
    if (production.kind === "HOLD") assert.equal(production.code, triggered ? "HOLD_P0_PRODUCTION" : "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE");
    assert.equal(g.client.writes.length, 0);
  }
});

test("W4.7R3/d: absent approval, source drift and pre-repair digest remain zero-write HOLD", async () => {
  for (const failure of ["absent", "drift", "old-digest"]) {
    const { g, h, evidence, bound } = await ready(failure !== "absent");
    if (failure === "drift") setIndex(g.map, { ...index([], [CLASS]), revision: 2 });
    if (failure === "old-digest") {
      const opened = await openGuard(g.deps, bound.binding, bound.runtime, NOW);
      assert.equal(opened.kind, "OPEN"); if (opened.kind !== "OPEN") continue;
      const old = JSON.parse(JSON.stringify(opened.snapshot.canonical)); old.snapshot_version = "SALES_GUARD_SNAPSHOT/1";
      const approval = (await g.deps.store.guardApprovals!.get(guardBindingId(bound.binding)))!;
      await g.deps.store.guardApprovals!.put({ ...approval, digest_sha256: digestOf(old) });
    }
    const result = await g.commit(h, { capability_evidence: evidence });
    assert.equal(result.kind, "HELD", JSON.stringify(result));
    if (result.kind === "HELD") assert.equal(result.code, "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE");
    assert.equal(g.client.writes.length, 0);
    assert.equal((await g.deps.store.plans.listByRuntime("VERTIGO", "SALES", bound.binding.runtime_generation)).length, 0);
  }
});

test("W4.7R3/e: capability_evidence reaches TARGET/FINAL without business gate movement or raw-intent authority", async () => {
  const { g, h, evidence, intent } = await ready();
  const gate = propText(rowsOf(g.map, R.salesStateDs)[0]!, "Current Gate");
  const before = rowsOf(g.map, P).length;
  const raw = await g.commit(h, { intent: structuredClone(intent) });
  assert.equal(raw.kind, "HELD"); assert.equal(g.client.writes.length, 0);
  const result = await g.commit(h, { capability_evidence: evidence });
  assert.equal(result.kind, "PERSISTED", JSON.stringify(result));
  if (result.kind !== "PERSISTED") return;
  assert.ok(result.target_receipt_id && result.final_receipt_id);
  assert.equal(result.step_moved, false);
  assert.equal(rowsOf(g.map, P).length, before + 1);
  assert.equal(propText(rowsOf(g.map, R.salesStateDs)[0]!, "Current Gate"), gate);
  const proof = rowsOf(g.map, P).find((row) => propText(row, "Capability Key") === "GMAIL_READ")!;
  assert.equal(propText(proof, "State"), "READ_VERIFIED");
  assert.ok(propText(proof, "Scope")?.includes("access:read"));
  const binding = (await g.deps.store.bindings.findByHandleHash(hashHandle(h)))!;
  assert.ok((await g.deps.store.plans.listByRuntime("VERTIGO", "SALES", binding.runtime_generation)).every((plan) => plan.plan_state === "FINAL_VERIFIED"));
});

// Fails if settle demands the very capability this exact backend factory journal is meant to prove.
test("W7.3: an unsent factory read proof resumes its existing journal, not a second intent", async () => {
  const { g, h, evidence, bound } = await ready();
  Object.assign(g.deps, { commitBudgetMs: 0 });
  const paused = await g.commit(h, { capability_evidence: evidence });
  assert.equal(paused.kind, "IN_PROGRESS"); if (paused.kind !== "IN_PROGRESS") return;
  assert.equal(g.client.writes.length, 0);
  Object.assign(g.deps, { commitBudgetMs: 35_000 });
  const reply = await dispatch("os_resume", { binding_handle: h }, { principal_id: OWNER.principal_id, now: NOW, candidate_resume: true }, g.deps);
  assert.equal((await g.deps.store.plans.get(paused.plan_id))?.plan_state, "FINAL_VERIFIED", JSON.stringify({ code: reply.code, hold: reply.observations.durable_hold }));
  assert.equal((await g.deps.store.plans.listByRuntime("VERTIGO", "SALES", bound.runtime.runtime_generation)).length, 1);
  assert.equal(rowsOf(g.map, P).filter(row => propText(row, "Capability Key") === "GMAIL_READ").length, 1);
  assert.equal(g.client.writes.at(-1)?.ctx.symbol, "STATE_LAST");
  assert.equal((await g.deps.store.receipts.findByPlan(paused.plan_id, "FINAL")).filter(r => r.status === "VALID").length, 1);
});

// After one actual byte, the capability HOLD must not hide the existing budget-bound journal.
test("W7.3: a read proof exposes bounded same-journal continuation while other accesses remain missing", async () => {
  const { g, h, evidence } = await ready();
  const initialRuns = rowsOf(g.map, R.salesRunsDs);
  const initialLedger = rowsOf(g.map, R.salesLedgerDs);
  let clock = NOW.getTime();
  Object.assign(g.deps, { clock: () => new Date(clock) });
  g.client.onWrite = () => { clock += 32_000; };
  const paused = await g.commit(h, { capability_evidence: evidence });
  assert.equal(paused.kind, "IN_PROGRESS"); if (paused.kind !== "IN_PROGRESS") return;
  // Writes landed, but provider indexes still return the previous Run/ledger view. The
  // original fixture only exercised recovery precedence, not the missing-capability branch.
  g.intercept(R.salesRunsDs, () => list(initialRuns));
  g.intercept(R.salesLedgerDs, () => list(initialLedger));
  const raw = await dispatch("os_resume", { binding_handle: h }, { principal_id: OWNER.principal_id, now: new Date(clock), candidate_resume: true }, g.deps);
  assert.equal(raw.code, "HOLD_REQUIRED_CAPABILITY_INCOMPLETE", JSON.stringify({ writes: g.client.writes.map(w => w.ctx.symbol), evidence: raw.observations.effective_hold }));
  assert.equal((raw.observations.ledger_continuation as { purpose?: string })?.purpose, "CAPABILITY_PROOF");
  const reply = candidateResume(raw);
  assert.equal(reply.next.permitted_tool_call, "os_resume", JSON.stringify({ code: raw.code, ledger: raw.observations.ledger_continuation }));
  assert.equal(reply.next.prepare_intent, undefined);
  assert.doesNotMatch(reply.next.conduct!, /perform ONE minimal real read/);
});

test("W7.3: only a certified capability journal may continue under its missing-capability HOLD", () => {
  const observations = { adoption_in_progress: true, ledger_continuation: { protocol: "LEDGER_CONTINUATION/1", plan_id: "owned", phase: "STAGE1", reason: "BUDGET", writes_done: 0, writes_total: 4, purpose: "CAPABILITY_PROOF" },
    open_backend_plan: { plan_id: "owned", plan_state: "AWAITING_STAGE1_WRITES", owned_by_caller: true, same_binding: true, expired: false },
    source_remediation_enabled: true, capability_remediation: { challenge: "opaque", capability: "GMAIL_READ", competent_source: "GMAIL" } };
  const reply = candidateResume(hold("HOLD_REQUIRED_CAPABILITY_INCOMPLETE", "verify", [], { observations }));
  assert.equal(reply.next.permitted_tool_call, "os_resume");
  assert.doesNotMatch(reply.next.conduct!, /perform ONE minimal real read/);
  const generic = candidateResume(hold("HOLD_REQUIRED_CAPABILITY_INCOMPLETE", "verify", [], { observations: { ...observations,
    ledger_continuation: { ...observations.ledger_continuation, purpose: undefined } } }));
  assert.notEqual(generic.next.permitted_tool_call, "os_resume", "a generic business draft never inherits remediation");
});

test("W7.3: a started proof label rejects changed mailbox, pins or mode and never mints provenance", async () => {
  const { g, h, evidence, bound } = await ready();
  let clock = NOW.getTime();
  Object.assign(g.deps, { clock: () => new Date(clock) });
  g.client.onWrite = () => { clock += 32_000; };
  const paused = await g.commit(h, { capability_evidence: evidence });
  assert.equal(paused.kind, "IN_PROGRESS"); if (paused.kind !== "IN_PROGRESS") return;
  const plan = (await g.deps.store.plans.get(paused.plan_id))!;
  assert.ok((await g.deps.store.planWrites.list(plan.plan_id)).some(w => w.attempts > 0));
  const raw = await dispatch("os_resume", { binding_handle: h }, { principal_id: OWNER.principal_id, now: new Date(clock) }, g.deps);
  const comparison = (raw.observations.capability_completeness as { comparisons: import("../../src/resume/capabilities.ts").CapabilityComparison[] }).comparisons.find(c => c.capability === "GMAIL_READ")!;
  const stored = JSON.parse(JSON.stringify(plan));
  assert.equal(storedCapabilityProofMatches(bound.runtime, stored, comparison), true);
  assert.equal(isBackendOwnedCapabilityMutation(bound.runtime, stored.state_last_write.guard_mutations[0]), false);
  assert.equal(storedCapabilityProofMatches({ ...bound.runtime, observations: { ...bound.runtime.observations, mailbox_identity: "other@example.invalid" } }, stored, comparison), false);
  assert.equal(storedCapabilityProofMatches(bound.runtime, { ...stored, governing_schema_version: "OTHER" }, comparison), false);
  assert.equal(storedCapabilityProofMatches(bound.runtime, stored, { ...comparison, operating_modes: ["OTHER"] }), false);
});

test("W7.3: stored proof restoration rejects changed requirement, pins, identity or payload", async () => {
  const { g, h, bound, evidence } = await ready();
  Object.assign(g.deps, { commitBudgetMs: 0 });
  const paused = await g.commit(h, { capability_evidence: evidence });
  assert.equal(paused.kind, "IN_PROGRESS"); if (paused.kind !== "IN_PROGRESS") return;
  const plan = (await g.deps.store.plans.get(paused.plan_id))!;
  const raw = await dispatch("os_resume", { binding_handle: h }, { principal_id: OWNER.principal_id, now: NOW }, g.deps);
  const comparison = (raw.observations.capability_completeness as { comparisons: import("../../src/resume/capabilities.ts").CapabilityComparison[] }).comparisons.find(c => c.requirement === "REQUIRED" && !c.satisfied)!;
  const restored = capabilityMutationForPlan(bound.runtime, JSON.parse(JSON.stringify(plan)), comparison);
  assert.ok(restored && isBackendOwnedCapabilityMutation(bound.runtime, restored), "a stored JSON plan restores only its original guarded proof");
  assert.ok(!isBackendOwnedCapabilityMutation(bound.runtime, structuredClone(restored)));
  for (const other of [undefined, { ...comparison, satisfied: true }, { ...comparison, capability: "GMAIL_SEND" },
    { ...comparison, competent_source: "OTHER" }, { ...comparison, operating_modes: ["OTHER"] }, { ...comparison, accepted_states: ["WRITE_VERIFIED" as const] }])
    assert.equal(capabilityMutationForPlan(bound.runtime, plan, other), undefined);
  const { guard_mutations: _savedGuard, ...withoutGuardMutations } = plan.state_last_write;
  for (const other of [{ ...plan, governing_schema_version: "OTHER" }, { ...plan, runtime_generation: "OTHER" },
    { ...plan, operations: [...plan.operations, plan.operations[0]!] },
    { ...plan, state_last_write: withoutGuardMutations },
    { ...plan, operations: [{ ...plan.operations[0]!, natural_key: "OTHER" }] },
    { ...plan, state_last_write: { ...plan.state_last_write, guard_mutations: [{ ...plan.state_last_write.guard_mutations![0]!, desired_changes: { ...plan.state_last_write.guard_mutations![0]!.desired_changes, EXTRA: "forged" } }] } }])
    assert.equal(capabilityMutationForPlan(bound.runtime, other, comparison), undefined);
  assert.equal(capabilityMutationForPlan({ ...bound.runtime, observations: { ...bound.runtime.observations, mailbox_identity: "changed@example.invalid" } }, plan, comparison), undefined);
  setIndex(g.map, { ...index([], [CLASS]), revision: 2 });
  Object.assign(g.deps, { commitBudgetMs: 35_000 });
  await dispatch("os_resume", { binding_handle: h }, { principal_id: OWNER.principal_id, now: NOW, candidate_resume: true }, g.deps);
  assert.equal(g.client.writes.length, 0, "restored factory provenance cannot replace a fresh guard approval");
  assert.equal((await g.deps.store.receipts.findByPlan(plan.plan_id, "FINAL")).length, 0);
});

test("W7.3: PostgreSQL restart resumes an unsent factory proof without a second capability read", { skip: !process.env["HARNESS_TEST_DATABASE_URL"] && "HARNESS_TEST_DATABASE_URL not set" }, async () => {
  const url = process.env["HARNESS_TEST_DATABASE_URL"]!;
  const admin = new PostgresBackend(url);
  await admin.pool.query("create schema if not exists pt_capability_journal"); await admin.close();
  const scoped = `${url}${url.includes("?") ? "&" : "?"}options=${encodeURIComponent("-c search_path=pt_capability_journal")}`;
  let backend = new PostgresBackend(scoped);
  try {
    await backend.migrateAll(new URL("../../migrations/", import.meta.url));
    await backend.pool.query("truncate plan_writes, transaction_events, receipts, runtime_leases, plan_operations, plans, bindings, principals cascade");
    const { g, h, evidence, bound } = await ready(true, false, backend.store());
    Object.assign(g.deps, { commitBudgetMs: 0 });
    const paused = await g.commit(h, { capability_evidence: evidence });
    assert.equal(paused.kind, "IN_PROGRESS"); if (paused.kind !== "IN_PROGRESS") return;
    assert.equal(g.client.writes.length, 0);
    await backend.close(); backend = new PostgresBackend(scoped);
    Object.assign(g.deps, { store: backend.store(), commitBudgetMs: 35_000 });
    await dispatch("os_resume", { binding_handle: h }, { principal_id: OWNER.principal_id, now: NOW, candidate_resume: true }, g.deps);
    assert.equal((await g.deps.store.plans.get(paused.plan_id))?.plan_state, "FINAL_VERIFIED");
    assert.equal((await g.deps.store.plans.listByRuntime("VERTIGO", "SALES", bound.runtime.runtime_generation)).length, 1);
    assert.equal((await g.deps.store.receipts.findByPlan(paused.plan_id, "FINAL")).filter(r => r.status === "VALID").length, 1);
    assert.equal(rowsOf(g.map, P).filter(row => propText(row, "Capability Key") === "GMAIL_READ").length, 1);
    assert.equal(g.client.writes.at(-1)?.ctx.symbol, "STATE_LAST");
  } finally { await backend.close(); }
});

test("W4.7R4/a: factory proof preparation reads the capability profile once, raw clone never bypasses preflight", async () => {
  const { g, bound, intent } = await ready();
  let profileQueries = 0;
  const query = g.deps.notion.queryDataSource.bind(g.deps.notion);
  const deps = { ...g.deps, notion: { ...g.deps.notion,
    retrievePage: g.deps.notion.retrievePage.bind(g.deps.notion),
    retrieveDatabase: g.deps.notion.retrieveDatabase.bind(g.deps.notion),
    retrieveDataSource: g.deps.notion.retrieveDataSource.bind(g.deps.notion),
    retrieveBlockChildren: g.deps.notion.retrieveBlockChildren.bind(g.deps.notion),
    queryDataSource: async (...args: Parameters<typeof query>) => { if (args[0] === P && args[1] === undefined) profileQueries++; return query(...args); },
  } };
  const raw = await prepare(deps, bound.binding, bound.runtime, structuredClone(intent), NOW);
  assert.equal(raw.kind, "HOLD"); assert.equal(profileQueries, 0);
  const result = await prepare(deps, bound.binding, bound.runtime, intent, NOW);
  assert.equal(result.kind, "PREPARED", JSON.stringify(result));
  assert.equal(profileQueries, 1, "only the later full store-backed hydration is necessary for the factory proof");
});

test("W4.7R4/b: factory proof still refuses a newly missing durable cursor before creating a plan", async () => {
  const { g, bound, intent } = await ready();
  setRowsIn(g.map, R.salesStateDs, []);
  const result = await prepare(g.deps, bound.binding, bound.runtime, intent, NOW);
  assert.equal(result.kind, "HOLD", JSON.stringify(result));
  assert.equal((await g.deps.store.plans.listByRuntime("VERTIGO", "SALES", bound.binding.runtime_generation)).length, 0);
  assert.equal(g.client.writes.length, 0);
});

test("W4.7R4/c: preparation cache never hides a guard-index edit before the first byte", async () => {
  const { g, h, evidence } = await ready();
  let reads = 0;
  const original = g.deps.notion;
  const notion = { ...original,
    retrievePage: original.retrievePage.bind(original), retrieveDatabase: original.retrieveDatabase.bind(original),
    retrieveDataSource: original.retrieveDataSource.bind(original), queryDataSource: original.queryDataSource.bind(original),
    retrieveBlockChildren: async (id: string, cursor?: string) => {
      if (id === G.indexPage && ++reads === 2) setIndex(g.map, index([], []));
      return original.retrieveBlockChildren(id, cursor);
    },
  };
  const { commit } = await import("../../src/transactions/commit.ts");
  const bound = await bindLive(h, { principal_id: OWNER.principal_id, now: NOW }, g.deps);
  assert.ok(bound.ok); if (!bound.ok) return;
  const result = await commit({ ...g.deps, notion }, bound.binding, bound.runtime,
    { capability_evidence: evidence }, { principal_id: OWNER.principal_id, now: NOW });
  assert.equal(result.kind, "HELD", JSON.stringify(result));
  assert.ok(reads >= 2, "the guard index is re-read independently of preparation");
  assert.equal(g.client.writes.length, 0);
});

test("W4.7R4/d: execution discovers only fresh Run/Ledger addresses, default hydration remains complete", async () => {
  const { g, bound, intent } = await ready();
  const prepared = await prepare(g.deps, bound.binding, bound.runtime, intent, NOW);
  assert.equal(prepared.kind, "PREPARED"); if (prepared.kind !== "PREPARED") return;
  const original = g.deps.notion, databases: string[] = [], children: string[] = [];
  const notion = { ...original,
    retrievePage: original.retrievePage.bind(original), retrieveDataSource: original.retrieveDataSource.bind(original),
    queryDataSource: original.queryDataSource.bind(original),
    retrieveDatabase: async (id: string) => { databases.push(id); return original.retrieveDatabase(id); },
    retrieveBlockChildren: async (id: string, cursor?: string) => { children.push(id); return original.retrieveBlockChildren(id, cursor); },
  };
  const result = await executeStage1({ ...g.deps, notion }, { principal_id: OWNER.principal_id,
    binding: bound.binding, runtime: bound.runtime, plan_id: prepared.plan.plan_id,
    cursor_ref: prepared.plan.state_last_write.target_ref, clock: () => NOW,
    deadline: new Deadline(() => NOW.getTime(), 0) });
  assert.equal(result.kind, "IN_PROGRESS", JSON.stringify(result));
  assert.deepEqual(databases, [R.salesRunsDb, R.salesLedgerDb]);
  assert.ok(children.includes(bound.runtime.root_ref) && children.includes(G.cp), "execution re-reads its own structure, not preparation's cache");
  assert.equal(g.client.writes.length, 0, "budget reserve still forbids a write");
  databases.length = 0;
  const complete = await discoverControlPlane(notion, bound.runtime.root_ref, bound.runtime.adapter.controlPlane);
  assert.equal(complete.runs, R.salesRunsDs); assert.equal(complete.ledger, R.salesLedgerDs);
  assert.equal(complete.state, R.salesStateDs); assert.equal(complete.capabilityProofs, P);
  assert.ok(databases.length > 2 && databases.includes(DB), "default discovery still hydrates auxiliary tables");
});

test("W4.7R4/e: write discovery keeps exact-title uniqueness and one-data-source constraints", async () => {
  const { g, bound } = await ready();
  const children = (g.map.get(`children:${G.cp}`) as { results: Array<{ id: string; child_database?: { title: string } }> }).results;
  const runs = children.find((b) => b.id === R.salesRunsDb)!;
  g.map.set(`children:${G.cp}`, list([...children, { ...runs, id: synthetic("duplicate-runs-db") }]));
  const duplicate = await discoverControlPlane(g.deps.notion, bound.runtime.root_ref, bound.runtime.adapter.controlPlane, "RUN_AND_LEDGER");
  assert.equal(duplicate.runs, undefined); assert.equal(duplicate.ledger, R.salesLedgerDs);
  assert.ok(duplicate.warnings.some((w) => w.includes("found 2")));
  g.map.set(`children:${G.cp}`, list(children));
  g.map.set(`database:${R.salesLedgerDb}`, { data_sources: [{ id: R.salesLedgerDs }, { id: synthetic("extra-ledger-ds") }] });
  const multiple = await discoverControlPlane(g.deps.notion, bound.runtime.root_ref, bound.runtime.adapter.controlPlane, "RUN_AND_LEDGER");
  assert.equal(multiple.runs, R.salesRunsDs); assert.equal(multiple.ledger, undefined);
  assert.ok(multiple.warnings.some((w) => w.includes("2 data sources")));
});

test("W4.7R4/f: a2 through the bounded driver persists one factory proof after one prepared handoff", async () => {
  const { g, bound, evidence, intent } = await ready();
  const { commit } = await import("../../src/transactions/commit.ts");
  const expected = { natural_key: intent.mutations[0]!.record_selector.natural_key!,
    values: { ...intent.mutations[0]!.desired_changes, "Capability Proof Key": intent.mutations[0]!.record_selector.natural_key! } };
  let n = 0;
  const result = await driveCapabilityCommit({
    call: async () => commit({ ...g.deps, commitBudgetMs: ++n === 1 ? 3_000 : 35_000 }, bound.binding, bound.runtime,
      { capability_evidence: evidence }, { principal_id: OWNER.principal_id, now: NOW }),
    progress: async () => {
      const plans = await g.deps.store.plans.listByRuntime("VERTIGO", "SALES", bound.runtime.runtime_generation);
      const active = plans.filter((p) => p.plan_state === "AWAITING_STAGE1_WRITES" && p.expires_at > NOW);
      const allRows = (await Promise.all(plans.map((p) => g.deps.store.planWrites.list(p.plan_id)))).flat();
      const plan = active.length === 1 ? active[0] : undefined;
      const receipts = await g.deps.store.receipts.findByRuntime(bound.runtime.runtime_id);
      const writes = plan ? await g.deps.store.planWrites.list(plan.plan_id) : [];
      const draft = preparedCapabilityDraft({ plan, binding: bound.binding, expected, now: NOW.getTime(), writes });
      if (n === 1 && plan) assert.ok(draft, "the freshly prepared factory proof has a complete untouched journal");
      return { settled_writes: allRows.filter((w) => w.status === "DONE" || w.status === "OBSERVED").length,
        verified_receipts: receipts.filter((r) => r.type === "TARGET" || r.type === "FINAL").length,
        active_plan_ids: active.map((p) => p.plan_id),
        prepared_capability: draft };
    }, expiresAt: new Date(NOW.getTime() + 60_000).toISOString(), clock: () => NOW.getTime(),
  });
  assert.equal(n, 2, JSON.stringify(result)); assert.equal(result.stopped_at, "PERSISTED", JSON.stringify(result));
  assert.equal(rowsOf(g.map, P).filter((r) => propText(r, "Capability Key") === "GMAIL_READ").length, 1);
  const plans = await g.deps.store.plans.listByRuntime("VERTIGO", "SALES", bound.runtime.runtime_generation);
  assert.equal(plans.length, 1); assert.equal(plans[0]!.plan_state, "FINAL_VERIFIED");
});
