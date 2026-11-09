/**
 * PV-CAPTURE-001 — same-turn input capture, per the Sales V1 candidate amendment (NOT ADOPTED).
 *
 * Its rule 2 requires the answer carried by the first user message to become durable through the authorized
 * path before any progress is claimed, and rule 5 requires a replay of that same input to reuse the key and
 * produce no duplicate row. Those two are backend behaviour and are proved here. Rules 1 and 4 — recognising an
 * explicit answer, refusing an ambiguous one — depend on comparing the `ask` with the user's message, which the
 * harness never sees; they are skill text and are covered as text in the plugin package, never claimed here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { propText, type Page } from "../../src/notion/shapes.ts";
import type { Plan } from "../../src/plans/store.ts";
import { dispatch } from "../../src/tools/handlers.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import { registerBuiltinSalesAdapters, salesContractAdapter, type SalesContractAdapter } from "../../src/versions/adapters/sales.ts";
import { createAdapterRegistries } from "../../src/versions/registry.ts";
import { handleOf, OWNER, T0 } from "./binding-fixtures.ts";
import { synthetic, text } from "./meta-fixtures.ts";
import { buildResumeWorld, setRowsIn } from "./resume-fixtures.ts";
import { CONTRACT_PAGE, IDS as SALES_IDS, SGRAMMAR, SV } from "./sales-fixtures.ts";
import { executeWrites, rowsOf } from "./target-fixtures.ts";
import { stampsAt, transact as nativeTransact } from "../support/transact.ts";

const ctx = { principal_id: OWNER.principal_id, now: T0 };
const CONFIG = "SALES:BUSINESS_CONFIG";

/** The V1 catalog line that carries the business setup resource, reached without adopting anything. */
function v1ControlPlane(): SalesContractAdapter["grammar"]["controlPlane"] {
  const registries = createAdapterRegistries();
  registerBuiltinSalesAdapters(registries.salesRuntime);
  const version = registries.salesRuntime.supported().find((v) => Object.hasOwn((registries.salesRuntime.resolve(v) as SalesContractAdapter).grammar.controlPlane.resources ?? {}, CONFIG));
  assert.ok(version, "no registered contract line exposes the business setup resource");
  return (registries.salesRuntime.resolve(version) as SalesContractAdapter).grammar.controlPlane;
}

function captureWorld(): { w: ReturnType<typeof buildResumeWorld>; configDs: string } {
  const w = buildResumeWorld();
  const contract = "TEST_SALES_CONTRACT/1.4.0";
  w.deps.adapters.salesRuntime.register(contract, salesContractAdapter(contract, [SV.schema], { ...SGRAMMAR, controlPlane: v1ControlPlane() }));

  const ids = SALES_IDS("rep-a");
  const manifest = w.map.get(`page:${ids.manifestRow}`) as Page;
  setRowsIn(w.map, ids.manifestDs, [{ ...manifest, properties: { ...manifest.properties, "Sales Contract Version": { type: "rich_text", rich_text: [text(contract)] } } }]);
  w.map.set(`page:${CONTRACT_PAGE}`, { object: "page", id: CONTRACT_PAGE, archived: false, properties: { title: { type: "title", title: [text(contract)] } } });

  const list = (results: unknown[]) => ({ results, has_more: false, next_cursor: null });
  const spec = v1ControlPlane().resources?.[CONFIG];
  assert.ok(spec?.parentTitle);
  const parent = synthetic("capture-setup-parent");
  const db = synthetic("capture-config-db");
  const configDs = synthetic("capture-config-ds");
  const rootChildren = (w.map.get(`children:${ids.root}`) as { results: unknown[] }).results;
  w.map.set(`children:${ids.root}`, list([...rootChildren, { id: parent, type: "child_page", child_page: { title: spec.parentTitle } }]));
  w.map.set(`children:${parent}`, list([{ id: db, type: "child_database", child_database: { title: spec.databaseTitle } }]));
  w.map.set(`database:${db}`, { data_sources: [{ id: configDs }] });
  w.map.set(`data_source:${configDs}`, { properties: { "Config Item": { type: "title" }, Category: { type: "select" }, State: { type: "select" }, Value: { type: "rich_text" }, Source: { type: "rich_text" } } });
  setRowsIn(w.map, configDs, []);
  return { w, configDs };
}

/** The answer the seller put in their very first message, carried as ordinary business intent. */
const ANSWER = "Obtenir 3 rendez-vous qualifiés par mois avec des industriels français";
const captureIntent = (answer = ANSWER) => ({
  action_class: "COMMIT",
  summary: "persist B0_DISCOVERY answer",
  mutations: [{
    logical_resource_key: CONFIG,
    operation: "UPSERT",
    record_selector: { natural_key: "B0_DISCOVERY:PRIMARY_OUTCOME" },
    desired_changes: { Category: "DISCOVERY", State: "CONFIRMED", Value: answer, Source: "SELLER_MESSAGE" },
  }],
});

async function runTransaction(w: ReturnType<typeof buildResumeWorld>, h: string, intent: unknown, salt: string): Promise<Plan> {
  const { plan, final } = await nativeTransact(w, h, intent, { ctx, stamps: stampsAt("03", salt) });
  // An answer is not a step movement: the reply says so, and its conduct is the SAME-TURN derived os_prepare
  // with no intent (§1e), never « on your next message » (PV-CONDUCT-001, observed 2026-09-23).
  assert.equal(((final as Extract<Envelope, { status: "OK" }>).result as { step_moved?: boolean }).step_moved, false);
  assert.match(final.next.conduct ?? "", /this happens in the SAME turn: do not hand the turn back/);
  assert.match(final.next.conduct ?? "", /Call os_prepare now with the binding_handle and NO intent/);
  return plan;
}

test("PV-CAPTURE-001: the first message's answer becomes durable through prepare/TARGET/FINAL, then resume reads it back", async () => {
  const { w, configDs } = captureWorld();
  const h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps));

  // Before anything is written there is nothing to resume from: no progress may be claimed.
  assert.equal(rowsOf(w, configDs).length, 0);

  const plan = await runTransaction(w, h, captureIntent(), "30");
  const op = plan.operations[0] as Plan["operations"][number];
  assert.equal(op.logical_resource_key, CONFIG, "the answer lands on the canonical setup resource, not the gate");
  assert.equal(op.natural_key, "B0_DISCOVERY:PRIMARY_OUTCOME");
  assert.ok(op.compared_fields.includes("Value"), "the answer itself is a compared field, so FINAL proves it");

  const rows = rowsOf(w, configDs);
  assert.equal(rows.length, 1);
  assert.equal(propText(rows[0] as Page, "Value"), ANSWER, "the exact answer string is what is durable");

  // Only now may the turn continue: resume reads the durable reality back.
  const resumed = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  assert.equal(resumed.code, "RESUMED", JSON.stringify(resumed));
});

test("PV-CAPTURE-001/b: replaying the same first message reuses the key and creates no second row", async () => {
  const { w, configDs } = captureWorld();
  const h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps));
  await runTransaction(w, h, captureIntent(), "30");
  assert.equal(rowsOf(w, configDs).length, 1);

  // A second fresh chat sends the identical message again.
  const h2 = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps));
  const replay = await dispatch("os_prepare", { binding_handle: h2, intent: captureIntent() }, ctx, w.deps);
  assert.equal(replay.code, "PLAN_PREPARED", JSON.stringify(replay));
  const plan2 = await w.deps.store.plans.get(((replay as Extract<Envelope, { status: "OK" }>).result as { plan_id: string }).plan_id) as Plan;
  assert.equal((plan2.operations[0] as Plan["operations"][number]).operation, "UPDATE", "the existing row is updated, never duplicated");
  executeWrites(w, plan2.stage1_writes, plan2.plan_id, { now: "2030-01-03T01:00:00.000Z", salt: "replay" });
  assert.equal(rowsOf(w, configDs).length, 1, "replaying the same answer leaves exactly one durable row");
});

test("PV-CAPTURE-001/c: a capture interrupted before its proof recovers by observation, still without duplicating", async () => {
  const { w, configDs } = captureWorld();
  const h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps));
  const prepared = await dispatch("os_prepare", { binding_handle: h, intent: captureIntent() }, ctx, w.deps);
  assert.equal(prepared.code, "PLAN_PREPARED", JSON.stringify(prepared));
  const planA = await w.deps.store.plans.get(((prepared as Extract<Envelope, { status: "OK" }>).result as { plan_id: string }).plan_id) as Plan;
  executeWrites(w, planA.stage1_writes, planA.plan_id, { now: "2030-01-03T00:30:00.000Z" });
  assert.equal(rowsOf(w, configDs).length, 1);

  const later = new Date(T0.getTime() + 16 * 60_000);
  assert.equal((await dispatch("os_verify", { binding_handle: h, plan_id: planA.plan_id, phase: "TARGET" }, { ...ctx, now: later }, w.deps)).code, "HOLD_PLAN_EXPIRED");

  const h2 = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps));
  assert.equal((await dispatch("os_resume", { binding_handle: h2 }, { ...ctx, now: later }, w.deps)).code, "HOLD_RECOVERY_REQUIRED");
  const preparedB = await dispatch("os_prepare", { binding_handle: h2, intent: captureIntent() }, { ...ctx, now: later }, w.deps);
  assert.equal(preparedB.code, "PLAN_PREPARED", JSON.stringify(preparedB));
  const planB = await w.deps.store.plans.get(((preparedB as Extract<Envelope, { status: "OK" }>).result as { plan_id: string }).plan_id) as Plan;
  assert.equal(planB.run_mode, "RECOVER_EXISTING");
  assert.deepEqual(planB.stage1_writes.map((s) => s.symbol), ["RESUME_RUN"], "the durable answer is observed, not written again");
  assert.equal(rowsOf(w, configDs).length, 1);
});

test("PV-CAPTURE-001/d: a different answer is a different key's business, and an unknown target is refused before any plan", async () => {
  const { w } = captureWorld();
  const h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps));

  // 0.5.4 forbids guessing where to store an answer: an unknown resource never becomes a plan.
  const invented = await dispatch("os_prepare", { binding_handle: h, intent: { ...captureIntent(), mutations: [{ ...captureIntent().mutations[0], logical_resource_key: "SALES:DISCOVERY_ANSWERS" }] } }, ctx, w.deps);
  assert.equal(invented.code, "HOLD_RESOURCE_UNKNOWN", JSON.stringify(invented));
  assert.equal((await w.deps.store.plans.findActive("VERTIGO", "SALES", "g1")).length, 0, "a refused target opens no plan and no Run");

  // A blank answer cannot be laundered into a durable record by an otherwise valid intent.
  const blank = await dispatch("os_prepare", { binding_handle: h, intent: { ...captureIntent(), mutations: [{ ...captureIntent().mutations[0], record_selector: { natural_key: "   " } }] } }, ctx, w.deps);
  assert.equal(blank.status, "HOLD", JSON.stringify(blank));
});

test("PV-CAPTURE-001/e: an unwritten own draft for the same records is superseded, in this chat or a new one, never waited on", async () => {
  // 2026-09-23 17:48 and 17:52: the seller's answer was re-prepared with slightly different text (same binding),
  // then from a new chat while the lease was live. Both answered HOLD_RUNTIME_BUSY and told the seller to wait
  // fifteen minutes for their own unwritten plan to expire. Nothing had been written: there was nothing to protect.
  const { w } = captureWorld();
  const h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps));
  const first = await dispatch("os_prepare", { binding_handle: h, intent: captureIntent(ANSWER) }, ctx, w.deps);
  assert.equal(first.code, "PLAN_PREPARED", JSON.stringify(first));
  const planA = ((first as Extract<Envelope, { status: "OK" }>).result as { plan_id: string }).plan_id;

  // Same chat, the seller edits their answer before any write: a new plan, the draft superseded, one active plan.
  const soon = new Date(T0.getTime() + 60_000);
  const edited = await dispatch("os_prepare", { binding_handle: h, intent: captureIntent(ANSWER + " (précisé)") }, { ...ctx, now: soon }, w.deps);
  assert.equal(edited.code, "PLAN_PREPARED", JSON.stringify(edited));
  const planB = ((edited as Extract<Envelope, { status: "OK" }>).result as { plan_id: string }).plan_id;
  assert.notEqual(planB, planA);
  assert.equal((await w.deps.store.plans.get(planA))!.plan_state, "SUPERSEDED");
  assert.ok(edited.warnings.some((x) => /unwritten draft/.test(x)), edited.warnings.join(" | "));

  // New chat, lease still live, different words again: same outcome, no HOLD_RUNTIME_BUSY.
  const h2 = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, { ...ctx, now: soon }, w.deps));
  const fresh = await dispatch("os_prepare", { binding_handle: h2, intent: captureIntent(ANSWER + " (reformulé)") }, { ...ctx, now: new Date(soon.getTime() + 60_000) }, w.deps);
  assert.equal(fresh.code, "PLAN_PREPARED", JSON.stringify(fresh));
  assert.equal((await w.deps.store.plans.get(planB))!.plan_state, "SUPERSEDED");
  const active = await w.deps.store.plans.findActive("VERTIGO", "SALES", (await w.deps.store.plans.get(planA))!.runtime_generation);
  assert.equal(active.length, 1, "exactly one active plan survives");

  // A draft that HAS written is not a draft any more: a different answer for the same records must wait or recover.
  const planC = await w.deps.store.plans.get(active[0]!.plan_id) as Plan;
  executeWrites(w, planC.stage1_writes, planC.plan_id, { now: "2030-01-03T00:40:00.000Z" });
  const target = await dispatch("os_verify", { binding_handle: h2, plan_id: planC.plan_id, phase: "TARGET" }, { ...ctx, now: new Date(soon.getTime() + 120_000) }, w.deps);
  assert.equal(target.code, "TARGET_VERIFIED", JSON.stringify(target));
  const late = await dispatch("os_prepare", { binding_handle: h2, intent: captureIntent(ANSWER + " (encore)") }, { ...ctx, now: new Date(soon.getTime() + 180_000) }, w.deps);
  assert.equal(late.code, "HOLD_RUNTIME_BUSY", "a plan that already wrote is protected by the lease, as before");
});

test("PV-CAPTURE-001/f: a plan replacing another for the same intent never reuses its operation ids", async () => {
  // 2026-09-23 15:54Z: the seller resent the same B3 text from a new chat. The takeover superseded the old plan,
  // then the replacement failed to insert — plan_operations.operation_id is a global primary key in PostgreSQL and
  // the id was derived from the idempotency key. The memory store has no such key, so this pins the invariant.
  const { w } = captureWorld();
  const h1 = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps));
  const first = await dispatch("os_prepare", { binding_handle: h1, intent: captureIntent() }, ctx, w.deps);
  assert.equal(first.code, "PLAN_PREPARED", JSON.stringify(first));
  const a = await w.deps.store.plans.get(((first as Extract<Envelope, { status: "OK" }>).result as { plan_id: string }).plan_id) as Plan;
  const h2 = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps));
  const again = await dispatch("os_prepare", { binding_handle: h2, intent: captureIntent() }, { ...ctx, now: new Date(T0.getTime() + 60_000) }, w.deps);
  assert.equal(again.code, "PLAN_PREPARED", JSON.stringify(again));
  const b = await w.deps.store.plans.get(((again as Extract<Envelope, { status: "OK" }>).result as { plan_id: string }).plan_id) as Plan;
  assert.notEqual(b.plan_id, a.plan_id);
  assert.equal((await w.deps.store.plans.get(a.plan_id))!.plan_state, "SUPERSEDED");
  const ids = [...a.operations, ...b.operations].map((o) => o.operation_id);
  assert.equal(new Set(ids).size, ids.length, "operation ids are unique across plans, so PostgreSQL's primary key cannot collide");
  assert.equal(a.operations[0]!.idempotency_key, b.operations[0]!.idempotency_key, "the idempotency key, by contrast, is the same on purpose");
});
