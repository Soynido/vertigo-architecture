/**
 * PT-EXEC-001 — the executor writes stage 1 of a stored plan itself (PV-WRITE-001 / W1.6).
 *
 * The plan is derived by the product's own `deriveWrites` from the SALES 0.5 control-plane grammar, stored with
 * `createPlan`, then executed against a FixtureNotionClient world shaped like Notion (select options declared,
 * relations typed). Checked: a complete stage 1; LOSE on OPEN_RUN → INTERRUPTED, then index-lag patience, then
 * relocation finds nothing and the same payload is resent once; APPLY_THEN_FAIL → INTERRUPTED with the journal
 * SENT, then relocation adopts the row without a second CREATE; an ambiguous UPDATE is resent once in the call;
 * an exhausted budget → IN_PROGRESS, resumable with no duplicate; refusals HELD with nothing sent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BindingRecord } from "../../src/binding/store.ts";
import { loadConfig } from "../../src/config/index.ts";
import { FixtureNotionClient } from "../../src/notion/fixtureClient.ts";
import { propText, type Page } from "../../src/notion/shapes.ts";
import { createPlan } from "../../src/plans/service.ts";
import type { Plan, PlanOperation } from "../../src/plans/store.ts";
import { deriveWrites } from "../../src/plans/writes.ts";
import type { ResolvedRuntime } from "../../src/resolvers/types.ts";
import { createMemoryStore } from "../../src/store/memory.ts";
import { Deadline } from "../../src/transactions/budget.ts";
import { executeStage1, type ExecuteContext, type ExecutorDeps } from "../../src/transactions/execute.ts";
import { SALES_CONTROL_PLANE_05 as G } from "../../src/versions/adapters/controlPlane.ts";
import { synthetic } from "./meta-fixtures.ts";

const ID = {
  root: synthetic("exec-root"), cp: synthetic("exec-cp"), runsDb: synthetic("exec-runs-db"), ledgerDb: synthetic("exec-ledger-db"),
  runs: synthetic("exec-runs-ds"), ledger: synthetic("exec-ledger-ds"), contacts: synthetic("exec-contacts-ds"), companies: synthetic("exec-companies-ds"), state: synthetic("exec-state-ds"),
  contact: synthetic("exec-contact"), company: synthetic("exec-company"), cursor: synthetic("exec-cursor"),
};
const PLAN_ID = "plan-exec-001";
const T0 = Date.parse("2030-01-03T09:00:20.000Z");
const config = loadConfig({ VERTIGO_META_SPEC_ROOT: "https://example.invalid/root", HARNESS_ENV: "fixture", PRINCIPALS_FILE: "x" });

const schema = (props: Record<string, string>, options: Record<string, string[]> = {}, relations: Record<string, string> = {}) => ({
  object: "data_source",
  properties: Object.fromEntries(Object.entries(props).map(([name, type]) => [name, {
    type,
    ...(type === "select" || type === "status" ? { [type]: { options: (options[name] ?? []).map((n) => ({ name: n })) } } : {}),
    ...(type === "relation" ? { relation: { data_source_id: relations[name] } } : {}),
  }])),
});

const rp = G.runProps;
const lp = G.ledgerProps;
const wp = G.writeProps!;
const RUNS: Record<string, string> = { [rp.title]: "title", [rp.status]: "select", [rp.origin]: "select", [rp.recoveryRequired]: "checkbox", [rp.specVersion]: "rich_text", [rp.schemaVersion]: "rich_text", [rp.gateBefore]: "rich_text", [rp.gateAfterExpected]: "rich_text", [rp.gateAfterObserved]: "rich_text", [rp.mutationCount]: "number", [rp.verifiedMutationCount]: "number", [rp.attemptCount]: "number", [rp.nextAction]: "rich_text", [rp.holds]: "rich_text", [rp.lastRequiredWrittenAt]: "date", [wp.runHarnessPlanId as string]: "rich_text" };
const LEDGER: Record<string, string> = { [lp.title]: "title", [lp.status]: "select", [lp.runRef]: "relation", [wp.ledgerTargetRef as string]: "rich_text", [wp.ledgerOperation as string]: "select", [wp.ledgerHarnessPlanId as string]: "rich_text", [wp.ledgerIdempotencyKey as string]: "rich_text", [wp.ledgerTargetReceiptId as string]: "rich_text" };
const CONTACTS: Record<string, string> = { Name: "title", Email: "email", Stage: "select", Company: "relation", "Last Touch": "date" };
const RUN_OPTIONS = { [rp.status]: ["RUNNING", "COMPLETED", "HOLD", "FAILED"], [rp.origin]: ["PLUGIN", "RUNTIME"] };
const LEDGER_OPTIONS = { [lp.status]: ["PREPARED", "WRITTEN", "VERIFIED", "FAILED"], [wp.ledgerOperation as string]: ["CREATE", "UPDATE", "UPSERT"] };
const CONTACT_OPTIONS = { Stage: ["New", "Qualified"] };

function page(id: string, ds: string, properties: Record<string, unknown>): Page {
  return { object: "page", id, archived: false, last_edited_time: "2030-01-01T00:00:00.000Z", parent: { type: "data_source_id", data_source_id: ds }, properties } as Page;
}
const title = (s: string) => ({ type: "title", title: [{ type: "text", plain_text: s }] });

function world(runOptions = RUN_OPTIONS): Map<string, unknown> {
  const m = new Map<string, unknown>();
  m.set(`children:${ID.root}`, { results: [{ id: ID.cp, type: "child_page", child_page: { title: G.parentTitle } }] });
  m.set(`children:${ID.cp}`, { results: [{ id: ID.runsDb, type: "child_database", child_database: { title: G.runsDatabaseTitle } }, { id: ID.ledgerDb, type: "child_database", child_database: { title: G.ledgerDatabaseTitle } }] });
  m.set(`database:${ID.runsDb}`, { id: ID.runsDb, data_sources: [{ id: ID.runs }] });
  m.set(`database:${ID.ledgerDb}`, { id: ID.ledgerDb, data_sources: [{ id: ID.ledger }] });
  m.set(`data_source:${ID.runs}`, schema(RUNS, runOptions));
  m.set(`data_source:${ID.ledger}`, schema(LEDGER, LEDGER_OPTIONS, { [lp.runRef]: ID.runs }));
  m.set(`data_source:${ID.contacts}`, schema(CONTACTS, CONTACT_OPTIONS, { Company: ID.companies }));
  m.set(`data_source:${ID.companies}`, schema({ Name: "title" }));
  const contact = page(ID.contact, ID.contacts, { Name: title("Lucie"), Email: { type: "email", email: "lucie@example.invalid" }, Stage: { type: "select", select: { name: "New" } } });
  const company = page(ID.company, ID.companies, { Name: title("Hôtel") });
  const cursor = page(ID.cursor, ID.state, { Name: title("CURRENT") });
  for (const p of [contact, company, cursor]) m.set(`page:${p.id}`, p);
  m.set(`query:${ID.runs}`, { results: [] });
  m.set(`query:${ID.ledger}`, { results: [] });
  m.set(`query:${ID.contacts}`, { results: [contact] });
  m.set(`query:${ID.companies}`, { results: [company] });
  return m;
}

const binding: BindingRecord = { binding_id: "b-exec", handle_hash: "e".repeat(64), principal_id: "p-exec", project: "VERTIGO", lane: "SALES", runtime_logical_key: "SALES:rep-exec", runtime_id: ID.root, runtime_generation: "g1", binding_mode: "BUSINESS", install_phase: "NOT_APPLICABLE", resolved_manifest_ref: ID.cursor, governing_versions_snapshot: {}, status: "BOUND", created_at: new Date(T0), expires_at: new Date(T0 + 86_400_000) };
const runtime = { access_mode: "BUSINESS", lane: "SALES", logical_key: "SALES:rep-exec", runtime_id: ID.root, root_ref: ID.root, manifest_ref: ID.cursor, runtime_generation: "g1", adapter: { version: "TEST_ADAPTER", controlPlane: G } } as unknown as ResolvedRuntime;

const OPS: PlanOperation[] = [
  { operation_id: "op-update", ordinal: 0, logical_resource_key: "SALES:CONTACTS", physical_target_ref: ID.contact, target_data_source_ref: ID.contacts, natural_key: "lucie@example.invalid", natural_key_property: "Email", natural_key_property_type: "email", idempotency_key: "k-update", operation: "UPDATE", compared_fields: ["Stage"], before_values: { Stage: "New" }, expected_values: { Stage: "Qualified", Company: `page:${ID.company}`, "Last Touch": "$now" } },
  { operation_id: "op-create", ordinal: 1, logical_resource_key: "SALES:CONTACTS", target_data_source_ref: ID.contacts, natural_key: "meganne@example.invalid", natural_key_property: "Email", natural_key_property_type: "email", idempotency_key: "k-create", operation: "CREATE", compared_fields: ["Email", "Stage"], before_values: {}, expected_values: { Name: "Meganne", Email: "meganne@example.invalid", Stage: "New" } },
];

async function setup(opts: { runOptions?: Record<string, string[]>; clock?: { t: number } } = {}) {
  const clock = opts.clock ?? { t: T0 };
  const map = world(opts.runOptions);
  const client = new FixtureNotionClient(map, { now: () => new Date(clock.t) });
  const store = createMemoryStore();
  const toMap = (r: Record<string, string>) => new Map(Object.entries(r));
  const writes = deriveWrites(G, OPS, { plan_id: PLAN_ID, summary: "Lucie qualifiée, Meganne ajoutée", runs_ds: ID.runs, ledger_ds: ID.ledger, cursor_ref: ID.cursor, gate_key: "B5", governing: { spec: "TEST_SPEC/1.0.0", schema: "TEST_SCHEMA/1.0.0", control: "TEST_CONTROL/1.0" }, run_schema: toMap(RUNS), ledger_schema: toMap(LEDGER), cursor_schema: new Map([["Name", "title"]]), target_schemas: new Map([[ID.contacts, toMap(CONTACTS)]]) });
  const out = await createPlan(store, config, { plan_id: PLAN_ID, principal_id: "p-exec", binding, governing: { spec: "TEST_SPEC/1.0.0", schema: "TEST_SCHEMA/1.0.0", control: "TEST_CONTROL/1.0" }, run_mode: "OPEN_NEW", execution_attempt_id: "att-1", baseline_runtime_revision: "rev-0", operations: OPS, stage1_writes: writes.stage1, finalization_writes: writes.finalization, state_last_write: writes.state_last }, new Date(T0));
  assert.equal(out.kind, "CREATED");
  const plan = (out as { plan: Plan }).plan;
  const deps: ExecutorDeps = { store, notion: client, notionWriter: client, config };
  const now = () => new Date(clock.t);
  const ctx = (budgetMs?: number): ExecuteContext => ({ principal_id: "p-exec", binding, runtime, plan_id: PLAN_ID, cursor_ref: ID.cursor, deadline: new Deadline(() => clock.t, budgetMs), clock: now });
  const rows = (ds: string) => ((map.get(`query:${ds}`) as { results: Page[] }).results);
  return { clock, map, client, store, plan, deps, ctx, rows, journal: () => store.planWrites.list(PLAN_ID) };
}

test("PT-EXEC-001/a: a stored plan's stage 1 is written by the executor — Run, ledger rows, targets — in order, journaled DONE", async () => {
  const s = await setup();
  const out = await executeStage1(s.deps, s.ctx());
  assert.equal(out.kind, "STAGE1_DONE", JSON.stringify(out));
  const symbols = s.plan.stage1_writes.map((w) => w.symbol);
  assert.deepEqual(s.client.writes.map((w) => w.ctx.symbol), symbols, "one Notion write per stage-1 instruction, in order");
  assert.deepEqual((await s.journal()).filter((r) => r.phase === "STAGE1").map((r) => r.status), symbols.map(() => "DONE"));
  assert.deepEqual((await s.journal()).filter((r) => r.phase !== "STAGE1").map((r) => r.status), ["PENDING", "PENDING", "PENDING", "PENDING"], "finalization and STATE_LAST wait for TARGET (W1.7)");
  // Run row: linked to the plan by its harness field.
  const [run] = s.rows(ID.runs);
  assert.equal(propText(run as Page, wp.runHarnessPlanId as string), PLAN_ID);
  assert.equal(propText(run as Page, rp.status), "RUNNING");
  // Ledger rows point at the Run the executor created, by relation.
  const ledger = s.rows(ID.ledger);
  assert.equal(ledger.length, 2);
  for (const row of ledger) assert.deepEqual((row.properties[lp.runRef] as unknown as { relation: { id: string }[] }).relation.map((r) => r.id), [run?.id]);
  assert.deepEqual(ledger.map((r) => propText(r, lp.status)), ["WRITTEN", "WRITTEN"], "each ledger row advanced to WRITTEN after its target");
  // Targets: the UPDATE landed with its relation and a minute-stamped $now; the CREATE made one new contact.
  const contact = s.map.get(`page:${ID.contact}`) as Page;
  assert.equal(propText(contact, "Stage"), "Qualified");
  assert.equal(propText(contact, "Last Touch"), "2030-01-03T09:00:00.000Z");
  assert.deepEqual((contact.properties["Company"] as unknown as { relation: { id: string }[] }).relation.map((r) => r.id), [ID.company]);
  assert.deepEqual(s.rows(ID.contacts).map((r) => propText(r, "Email")), ["lucie@example.invalid", "meganne@example.invalid"]);
  // Idempotent: a second call finds everything DONE and writes nothing.
  const again = await executeStage1(s.deps, s.ctx());
  assert.equal(again.kind, "STAGE1_DONE");
  assert.equal(s.client.writes.length, symbols.length);
  assert.deepEqual((again as { created: Record<string, string> }).created, (out as { created: Record<string, string> }).created);
});

test("PT-EXEC-001/b: LOSE on OPEN_RUN → INTERRUPTED; a quick retry waits for the index; later, relocation finds nothing and the same payload is resent once", async () => {
  const s = await setup();
  s.client.fault({ symbol: "OPEN_RUN" }, "LOSE");
  const first = await executeStage1(s.deps, s.ctx());
  assert.deepEqual([first.kind, (first as { failed_symbol?: string }).failed_symbol, (first as { notion_status?: unknown }).notion_status], ["INTERRUPTED", "OPEN_RUN", "TIMEOUT"]);
  const openRun = (await s.journal()).find((r) => r.symbol === "OPEN_RUN")!;
  assert.deepEqual([openRun.status, openRun.attempts, s.rows(ID.runs).length], ["SENT", 1, 0]);
  s.clock.t += 5_000;
  const quick = await executeStage1(s.deps, s.ctx());
  assert.deepEqual([quick.kind, (quick as { reason?: string }).reason], ["IN_PROGRESS", "INDEX_LAG"]);
  assert.equal(s.client.writes.length, 1, "nothing is resent while the lost CREATE may still appear");
  s.clock.t += 60_000;
  const later = await executeStage1(s.deps, s.ctx());
  assert.equal(later.kind, "STAGE1_DONE", JSON.stringify(later));
  assert.equal(s.rows(ID.runs).length, 1, "exactly one Run");
  const resent = (await s.journal()).find((r) => r.symbol === "OPEN_RUN")!;
  assert.deepEqual([resent.status, resent.attempts, resent.payload_hash], ["DONE", 2, openRun.payload_hash], "resent once, byte-identical");
  const openRunWrites = s.client.writes.filter((w) => w.ctx.symbol === "OPEN_RUN");
  assert.equal(openRunWrites.length, 2);
  assert.deepEqual(openRunWrites[0]!.properties, openRunWrites[1]!.properties, "the stamped $now is reused by the resend");
});

test("PT-EXEC-001/c: APPLY_THEN_FAIL on OPEN_RUN → INTERRUPTED with the journal SENT; the next call adopts the row it finds, never creating a second", async () => {
  const s = await setup();
  s.client.fault({ symbol: "OPEN_RUN" }, "APPLY_THEN_FAIL");
  const first = await executeStage1(s.deps, s.ctx());
  assert.deepEqual([first.kind, (first as { notion_status?: unknown }).notion_status], ["INTERRUPTED", 502]);
  assert.equal((await s.journal()).find((r) => r.symbol === "OPEN_RUN")?.status, "SENT");
  assert.equal(s.rows(ID.runs).length, 1, "the write landed although its answer was an error");
  s.clock.t += 1_000;
  const next = await executeStage1(s.deps, s.ctx());
  assert.equal(next.kind, "STAGE1_DONE", JSON.stringify(next));
  assert.equal(s.rows(ID.runs).length, 1, "relocated, not resent");
  const row = (await s.journal()).find((r) => r.symbol === "OPEN_RUN")!;
  assert.deepEqual([row.status, row.attempts, row.created_id], ["OBSERVED", 1, s.rows(ID.runs)[0]!.id]);
  assert.equal(s.client.writes.filter((w) => w.ctx.symbol === "OPEN_RUN").length, 1);
});

test("PT-EXEC-001/d: an ambiguous UPDATE is resent once in the same call; a CREATE found twice is a HOLD, never a choice", async () => {
  const s = await setup();
  s.client.fault({ symbol: "TARGET_0" }, "APPLY_THEN_FAIL");
  const out = await executeStage1(s.deps, s.ctx());
  assert.equal(out.kind, "STAGE1_DONE", JSON.stringify(out));
  assert.equal(s.client.writes.filter((w) => w.ctx.symbol === "TARGET_0").length, 2);
  assert.equal((await s.journal()).find((r) => r.symbol === "TARGET_0")?.attempts, 2);

  // A CREATE whose answer was lost, and two rows now carry its keys (a concurrent actor copied it).
  const dup = await setup();
  dup.client.fault({ symbol: "OPEN_RUN" }, "APPLY_THEN_FAIL");
  dup.client.onWrite = (e) => { if (e.ctx.symbol === "OPEN_RUN") { const rows = dup.rows(ID.runs); dup.map.set(`query:${ID.runs}`, { results: [...rows, { ...rows[0]!, id: synthetic("exec-dup-run") }] }); } };
  assert.equal((await executeStage1(dup.deps, dup.ctx())).kind, "INTERRUPTED");
  dup.clock.t += 1_000;
  const held = await executeStage1(dup.deps, dup.ctx());
  assert.deepEqual([held.kind, (held as { code?: string }).code], ["HELD", "HOLD_DUPLICATE"]);
  assert.equal(dup.client.writes.length, 1, "nothing more was written");
});

test("PT-EXEC-001/e: an exhausted budget stops at a write boundary (IN_PROGRESS); the next call resumes with no duplicate", async () => {
  const clock = { t: T0 };
  const s = await setup({ clock });
  s.client.onWrite = () => { clock.t += 3_000; };
  const first = await executeStage1(s.deps, s.ctx(12_000));
  assert.deepEqual([first.kind, (first as { reason?: string }).reason], ["IN_PROGRESS", "BUDGET"]);
  const done = first.writes_done;
  assert.ok(done > 0 && done < first.writes_total, `partial: ${done}/${first.writes_total}`);
  assert.equal(s.client.writes.length, done);
  const second = await executeStage1(s.deps, s.ctx());
  assert.equal(second.kind, "STAGE1_DONE");
  assert.equal(s.client.writes.length, first.writes_total, "each instruction written exactly once across both calls");
  assert.equal(s.rows(ID.runs).length, 1);
  assert.equal(s.rows(ID.ledger).length, 2);
});

test("PT-EXEC-001/f: refusals are HELD with nothing more sent — Notion rejects, unknown governed value, no writer, plan claimed elsewhere", async () => {
  const r = await setup();
  r.client.fault({ symbol: "LEDGER_0" }, "REJECT", { status: 400, code: "validation_error" });
  const rejected = await executeStage1(r.deps, r.ctx());
  assert.deepEqual([rejected.kind, (rejected as { code?: string }).code, (rejected as { wrote_anything?: boolean }).wrote_anything], ["HELD", "HOLD_NOTION_WRITE_REJECTED", true]);
  assert.equal((await r.journal()).find((x) => x.symbol === "LEDGER_0")?.status, "FAILED_FINAL");
  const again = await executeStage1(r.deps, r.ctx());
  assert.deepEqual([again.kind, (again as { code?: string }).code, r.client.writes.length], ["HELD", "HOLD_NOTION_WRITE_REJECTED", 2]);

  // The Runs schema does not offer RUNNING: governed (D11) ⇒ refused before any byte.
  const g = await setup({ runOptions: { [rp.status]: ["COMPLETED"], [rp.origin]: ["PLUGIN"] } });
  const governed = await executeStage1(g.deps, g.ctx());
  assert.deepEqual([governed.kind, (governed as { code?: string }).code, g.client.writes.length], ["HELD", "HOLD_SCHEMA_VALUE_UNSUPPORTED", 0]);
  assert.equal((await g.journal()).find((x) => x.symbol === "OPEN_RUN")?.status, "FAILED_FINAL");

  const n = await setup();
  const noWriter = await executeStage1({ ...n.deps, notionWriter: undefined } as unknown as ExecutorDeps, n.ctx());
  assert.deepEqual([noWriter.kind, (noWriter as { code?: string }).code, n.client.writes.length], ["HELD", "HOLD_SERVER_WRITES_DISABLED", 0]);

  const c = await setup();
  await c.store.claims.claim(PLAN_ID, "another-executor", new Date(T0), new Date(T0 + 60_000));
  const claimed = await executeStage1(c.deps, c.ctx());
  assert.deepEqual([claimed.kind, (claimed as { reason?: string }).reason, c.client.writes.length], ["IN_PROGRESS", "CLAIMED_ELSEWHERE", 0]);
});

test("PT-EXEC-001/g: a ledger CREATE whose answer was lost is relocated by plan id + idempotency key, not resent", async () => {
  const s = await setup();
  s.client.fault({ symbol: "LEDGER_1" }, "APPLY_THEN_FAIL");
  assert.equal((await executeStage1(s.deps, s.ctx())).kind, "INTERRUPTED");
  s.clock.t += 1_000;
  assert.equal((await executeStage1(s.deps, s.ctx())).kind, "STAGE1_DONE");
  assert.equal(s.rows(ID.ledger).length, 2);
  const row = (await s.journal()).find((r) => r.symbol === "LEDGER_1")!;
  assert.equal(row.status, "OBSERVED");
  const ledger1 = s.rows(ID.ledger).find((r) => r.id === row.created_id)!;
  assert.equal(propText(ledger1, wp.ledgerIdempotencyKey as string), "k-create");
  assert.equal(propText(ledger1, wp.ledgerHarnessPlanId as string), PLAN_ID);
  assert.equal(s.client.writes.filter((w) => w.ctx.symbol === "LEDGER_1").length, 1);
});
