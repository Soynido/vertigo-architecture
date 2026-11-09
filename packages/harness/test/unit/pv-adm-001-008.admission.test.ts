/**
 * PV-ADM-001..008 — ADMISSION-SALES-001 (DELIVERY_CONTRACT/0.1.0-rc2 §4, finding F-002).
 *
 * The runtime is admitted to business work only when every authoritative precondition is satisfied at once.
 * The Manifest carries identity, install, versions and blockers; OS State carries progression. A blocker on
 * either row is a blocker on the runtime. Before this lot the resume derivation read `state ?? manifest`:
 * a Manifest on HOLD / HOLD_REBIND_REQUIRED with a healthy OS State next to it was admitted, a plan was
 * prepared, and Runs completed on a runtime the Manifest itself declared unfit. The counter-example here is
 * that Manifest, redacted: Health Status = HOLD, Persistence Health = HOLD_REBIND_REQUIRED,
 * Recovery Required = false, Current Gate = B0_DISCOVERY / HOLD, while OS State sits healthy on B1_OFFER.
 *
 * Oracle (rc2 §4): A1 Manifest HOLD + OS State healthy + valid intent → HOLD, no plan. A2 the mirror.
 * A3 the caller's own interrupted work is still recoverable under the HOLD (bounded RECOVER). A4 any other
 * intent under the HOLD is refused. A5 a plan prepared healthy cannot cross TARGET or FINAL once the Manifest
 * turns. A6 / A7 reference the existing divergence and idempotency proofs. A8 is the unchanged regression set.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hashHandle } from "../../src/binding/handle.ts";
import type { Page } from "../../src/notion/shapes.ts";
import type { Plan } from "../../src/plans/store.ts";
import { dispatch } from "../../src/tools/handlers.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import { registerBuiltinSalesAdapters, salesContractAdapter, type SalesContractAdapter } from "../../src/versions/adapters/sales.ts";
import { createAdapterRegistries } from "../../src/versions/registry.ts";
import { handleOf, OWNER, T0 } from "./binding-fixtures.ts";
import { synthetic, text } from "./meta-fixtures.ts";
import { buildResumeWorld, R, setRowsIn } from "./resume-fixtures.ts";
import { CONTRACT_PAGE, IDS as SALES_IDS, SGRAMMAR, SV } from "./sales-fixtures.ts";
import { executeWrites, rowsOf } from "./target-fixtures.ts";

const ctx = { principal_id: OWNER.principal_id, now: T0 };
const CONFIG = "SALES:BUSINESS_CONFIG";
const B1_KEY = "B1_OFFER:SELLABLE_OFFER";
const OFFER = "Un récit industriel filmé qui rend une usine désirable pour ses clients et ses candidats";

type World = ReturnType<typeof buildResumeWorld>;
type Hold = Extract<Envelope, { status: "HOLD" }>;
type Ok = Extract<Envelope, { status: "OK" }>;

function offerLine(): SalesContractAdapter {
  const registries = createAdapterRegistries();
  registerBuiltinSalesAdapters(registries.salesRuntime);
  const v = registries.salesRuntime.supported().find((x) => x.endsWith("/0.5.5-candidate"));
  assert.ok(v);
  return registries.salesRuntime.resolve(v) as SalesContractAdapter;
}

/** The counter-example Manifest, redacted: only the four cursor properties that carried the blocker. */
const BLOCKED_MANIFEST = {
  "Health Status": { type: "select", select: { name: "HOLD" } },
  "Persistence Health": { type: "select", select: { name: "HOLD_REBIND_REQUIRED" } },
  "Recovery Required": { type: "checkbox", checkbox: false },
  "Current Gate": { type: "rich_text", rich_text: [text("B0_DISCOVERY")] },
  "Current Gate Status": { type: "select", select: { name: "HOLD" } },
} as const;

const HEALTHY_MANIFEST = {
  "Health Status": { type: "select", select: { name: "HEALTHY" } },
  "Persistence Health": { type: "select", select: { name: "PASS" } },
  "Recovery Required": { type: "checkbox", checkbox: false },
} as const;

function setManifest(w: World, props: Record<string, unknown>, lastEdited?: string): void {
  const ids = SALES_IDS("rep-a");
  const manifest = w.map.get(`page:${ids.manifestRow}`) as Page;
  const next = { ...manifest, ...(lastEdited ? { last_edited_time: lastEdited } : {}), properties: { ...manifest.properties, ...props } } as Page;
  setRowsIn(w.map, ids.manifestDs, [next]);
}

/** Same world as PV-B1: the OFFER line pinned, OS State healthy on B1_OFFER, an empty Business Configuration. */
function world(opts: { manifest?: Record<string, unknown>; state?: { persistence?: string; recovery?: boolean } } = {}): { w: World; configDs: string } {
  const w = buildResumeWorld();
  const contract = "TEST_SALES_CONTRACT/1.7.0";
  const controlPlane = offerLine().grammar.controlPlane;
  w.deps.adapters.salesRuntime.register(contract, salesContractAdapter(contract, [SV.schema], { ...SGRAMMAR, controlPlane }));
  setManifest(w, { "Sales Contract Version": { type: "rich_text", rich_text: [text(contract)] }, ...HEALTHY_MANIFEST, ...(opts.manifest ?? {}) });
  w.map.set(`page:${CONTRACT_PAGE}`, { object: "page", id: CONTRACT_PAGE, archived: false, properties: { title: { type: "title", title: [text(contract)] } } });
  const liveState = w.map.get(`data_source:${R.salesStateDs}`) as { properties: Record<string, unknown> };
  w.map.set(`data_source:${R.salesStateDs}`, { properties: { ...liveState.properties,
    "Gate Passed By Run Ref": { type: "rich_text" }, "Last Durable Mode": { type: "select" },
    "Last Durable Turn ID": { type: "rich_text" }, "Next Authorized Topic": { type: "rich_text" } } });
  w.setSalesState({ gate: "B1_OFFER", buildState: "B1_OFFER", nextAction: "Reconcile the canonical offer", nextQuestion: "Which part of the offer must change?", ...(opts.state ?? {}) });

  const list = (results: unknown[]) => ({ results, has_more: false, next_cursor: null });
  const spec = controlPlane.resources?.[CONFIG];
  assert.ok(spec?.parentTitle);
  const ids = SALES_IDS("rep-a");
  const parent = synthetic("adm-setup-parent"); const db = synthetic("adm-config-db"); const configDs = synthetic("adm-config-ds");
  const rootChildren = (w.map.get(`children:${ids.root}`) as { results: unknown[] }).results;
  w.map.set(`children:${ids.root}`, list([...rootChildren, { id: parent, type: "child_page", child_page: { title: spec.parentTitle } }]));
  w.map.set(`children:${parent}`, list([{ id: db, type: "child_database", child_database: { title: spec.databaseTitle } }]));
  w.map.set(`database:${db}`, { data_sources: [{ id: configDs }] });
  w.map.set(`data_source:${configDs}`, { properties: { "Config Item": { type: "title" }, Category: { type: "select" }, State: { type: "select" }, Value: { type: "rich_text" }, Version: { type: "rich_text" }, Source: { type: "rich_text" }, "Effective At": { type: "date" }, Notes: { type: "rich_text" } } });
  setRowsIn(w.map, configDs, []);
  return { w, configDs };
}

const bind = async (w: World) => handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps));

const answerIntent = (value = OFFER) => ({
  action_class: "COMMIT",
  summary: "persist the seller's confirmed offer",
  mutations: [{ logical_resource_key: CONFIG, operation: "UPSERT", record_selector: { natural_key: B1_KEY },
    desired_changes: { Category: "OFFER", State: "CONFIRMED", Value: value, Version: "SALES_INPUT/1", Source: "CHAT_USER_EXPLICIT" } }],
});

const plansCreated = async (w: World) => (await w.deps.store.events.list({})).filter((e) => e.event_type === "PLAN_CREATED").length;
const evidenceOf = (e: Envelope) => ((e as Hold).evidence ?? []).join(" | ");

/** The admission refusal: no plan, and the evidence names the Manifest blocker rather than a symptom of it. */
async function assertRefusedByManifest(w: World, e: Envelope, plansBefore: number, where: string): Promise<void> {
  assert.equal(e.status, "HOLD", `${where}: ${JSON.stringify(e)}`);
  assert.match(evidenceOf(e), /Manifest/, `${where}: the refusal must name the Manifest as the blocking authority — ${evidenceOf(e)}`);
  assert.match(evidenceOf(e), /HOLD_REBIND_REQUIRED|Health Status HOLD|health HOLD/, `${where}: and the blocker itself — ${evidenceOf(e)}`);
  assert.equal(await plansCreated(w), plansBefore, `${where}: no plan may be created on an unadmitted runtime`);
}

test("PV-ADM-001 (A1): a Manifest on HOLD blocks the business turn even when OS State is healthy — no plan is created", async () => {
  const { w, configDs } = world({ manifest: BLOCKED_MANIFEST });
  const h = await bind(w);
  // What os_resume says is informational here; what os_prepare does is the admission.
  const resumed = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  const prepared = await dispatch("os_prepare", { binding_handle: h, intent: answerIntent() }, ctx, w.deps);
  await assertRefusedByManifest(w, prepared, 0, "os_prepare under Manifest HOLD");
  assert.equal(prepared.code, "HOLD_RECOVERY_REQUIRED", JSON.stringify(prepared));
  assert.equal(resumed.code, "HOLD_RECOVERY_REQUIRED", `os_resume must already report the blocked runtime: ${JSON.stringify(resumed)}`);
  assert.equal(rowsOf(w, configDs).length, 0);
  assert.equal((await w.deps.store.plans.findActive("VERTIGO", "SALES", "g1")).length, 0);
});

test("PV-ADM-002 (A2): the mirror — OS State on HOLD_PARTIAL_COMMIT with a healthy Manifest is refused the same way", async () => {
  const { w } = world({ state: { persistence: "HOLD_PARTIAL_COMMIT" } });
  const h = await bind(w);
  const prepared = await dispatch("os_prepare", { binding_handle: h, intent: answerIntent() }, ctx, w.deps);
  assert.equal(prepared.code, "HOLD_RECOVERY_REQUIRED", JSON.stringify(prepared));
  assert.match(evidenceOf(prepared), /HOLD_PARTIAL_COMMIT/);
  assert.equal(await plansCreated(w), 0);
});

/** A plan prepared while healthy, whose stage-1 writes landed, and whose turn then died before TARGET. */
async function interruptedTransaction(w: World, h: string): Promise<Plan> {
  const prepared = await dispatch("os_prepare", { binding_handle: h, intent: answerIntent() }, ctx, w.deps);
  assert.equal(prepared.code, "PLAN_PREPARED", JSON.stringify(prepared));
  const plan = await w.deps.store.plans.get(((prepared as Ok).result as { plan_id: string }).plan_id) as Plan;
  executeWrites(w, plan.stage1_writes, plan.plan_id, { now: "2030-01-04T00:10:00.000Z" });
  return plan;
}

test("PV-ADM-003 (A3): the caller's own interrupted work is still recoverable under the Manifest HOLD — recovery is bounded to that plan", async () => {
  const { w } = world();
  const h = await bind(w);
  const plan = await interruptedTransaction(w, h);
  // The Manifest turns while the transaction is half-written, and the plan's own lease expires (PT-REC-005).
  setManifest(w, BLOCKED_MANIFEST, "2030-01-04T00:11:00.000Z");
  const later = { ...ctx, now: new Date(T0.getTime() + 16 * 60_000) };
  const again = await dispatch("os_prepare", { binding_handle: h, intent: answerIntent() }, later, w.deps);
  // Recovery of the same intent by the same principal is observed durable state, not new work: the plan that
  // comes back continues the interrupted Run and recovers the interrupted plan by id. It opens nothing new.
  assert.equal(again.code, "PLAN_PREPARED", `bounded recovery must still be admitted: ${JSON.stringify(again)}`);
  const result = (again as Ok).result as { plan_id: string; run_mode: string };
  assert.equal(result.run_mode, "RECOVER_EXISTING", "recovery continues the existing Run; it never opens a new one on a blocked runtime");
  const recovered = await w.deps.store.plans.get(result.plan_id) as Plan;
  assert.equal(recovered.recovers_plan_id, plan.plan_id, "and it recovers exactly the interrupted plan");
  // The bounded recovery then completes through its own TARGET: the exemption is for that plan alone.
  const target = await dispatch("os_verify", { binding_handle: h, plan_id: recovered.plan_id, phase: "TARGET" }, later, w.deps);
  assert.equal(target.code, "TARGET_VERIFIED", `recovery TARGET under the Manifest HOLD: ${JSON.stringify(target)}`);
});

test("PV-ADM-004 (A4): under the Manifest HOLD an intent that recovers nothing is refused by the admission, before its own validity is even judged", async () => {
  const { w } = world({ manifest: BLOCKED_MANIFEST });
  const h = await bind(w);
  // On an admitted runtime this intent would be refused later, as HOLD_UNSUPPORTED_OPERATION (a second key would
  // be a second truth). On a blocked runtime the admission answers first: there is nothing to judge.
  const foreign = await dispatch("os_prepare", { binding_handle: h, intent: { ...answerIntent(), mutations: [{ ...answerIntent().mutations[0], record_selector: { natural_key: "B1_OFFER:MY_OFFER" } }] } }, ctx, w.deps);
  await assertRefusedByManifest(w, foreign, 0, "foreign intent under Manifest HOLD");
  assert.equal(foreign.code, "HOLD_RECOVERY_REQUIRED", JSON.stringify(foreign));
});

test("PV-ADM-005 (A5): a plan prepared healthy cannot cross TARGET once the Manifest turns", async () => {
  const { w } = world();
  const h = await bind(w);
  const plan = await interruptedTransaction(w, h);
  setManifest(w, BLOCKED_MANIFEST, "2030-01-04T00:11:00.000Z");
  const target = await dispatch("os_verify", { binding_handle: h, plan_id: plan.plan_id, phase: "TARGET" }, ctx, w.deps);
  assert.equal(target.status, "HOLD", `TARGET on an unadmitted runtime: ${JSON.stringify(target)}`);
  assert.match(evidenceOf(target), /Manifest/);
  assert.match(evidenceOf(target), /HOLD_REBIND_REQUIRED|HOLD/);
  assert.equal((await w.deps.store.plans.get(plan.plan_id))?.plan_state, "AWAITING_STAGE1_WRITES", "no receipt was issued");
});

test("PV-ADM-005 (A5, FINAL): a plan whose TARGET passed cannot cross FINAL once the Manifest turns", async () => {
  const { w } = world();
  const h = await bind(w);
  const plan = await interruptedTransaction(w, h);
  const target = await dispatch("os_verify", { binding_handle: h, plan_id: plan.plan_id, phase: "TARGET" }, ctx, w.deps);
  assert.equal(target.code, "TARGET_VERIFIED", JSON.stringify(target));
  const receipt = ((target as Ok).result as { target_receipt_id: string }).target_receipt_id;
  const observed = target.observations["symbols"] as Record<string, string>;
  executeWrites(w, plan.finalization_writes, plan.plan_id, { ...({ now: "2030-01-04T00:10:30.000Z" }), created: observed, target_receipt_id: receipt });
  executeWrites(w, [plan.state_last_write], plan.plan_id, { ...({ now: "2030-01-04T00:10:45.000Z" }), created: observed, target_receipt_id: receipt });
  setManifest(w, BLOCKED_MANIFEST, "2030-01-04T00:10:50.000Z");
  const final = await dispatch("os_verify", { binding_handle: h, plan_id: plan.plan_id, phase: "FINAL" }, ctx, w.deps);
  assert.equal(final.status, "HOLD", `FINAL on an unadmitted runtime: ${JSON.stringify(final)}`);
  assert.match(evidenceOf(final), /Manifest/);
  assert.notEqual((await w.deps.store.plans.get(plan.plan_id))?.plan_state, "FINAL_VERIFIED");
});

test("PV-ADM-006 (A6): with both rows healthy the same intent is admitted — the admission is a conjunction, not a veto", async () => {
  const { w, configDs } = world();
  const h = await bind(w);
  const prepared = await dispatch("os_prepare", { binding_handle: h, intent: answerIntent() }, ctx, w.deps);
  assert.equal(prepared.code, "PLAN_PREPARED", JSON.stringify(prepared));
  assert.equal(rowsOf(w, configDs).length, 0, "prepare still writes nothing itself");
});

test("PV-ADM-007 (A7): a Manifest whose health is merely UNKNOWN (property absent) is not a blocker — only a declared HOLD is", async () => {
  const { w } = world();
  const ids = SALES_IDS("rep-a");
  const manifest = w.map.get(`page:${ids.manifestRow}`) as Page;
  const { "Health Status": _h, "Persistence Health": _p, "Recovery Required": _r, ...rest } = manifest.properties as Record<string, unknown>;
  setRowsIn(w.map, ids.manifestDs, [{ ...manifest, properties: rest } as Page]);
  const h = await bind(w);
  const prepared = await dispatch("os_prepare", { binding_handle: h, intent: answerIntent() }, ctx, w.deps);
  assert.equal(prepared.code, "PLAN_PREPARED", `absence of a declaration is not a declared blocker: ${JSON.stringify(prepared)}`);
  void hashHandle;
});

/**
 * PV-ADM-008 — the refusal has to be actionable.
 *
 * Observed live on 2026-09-22, minutes after the admission fix was served: the Manifest blocker correctly raised
 * HOLD_RECOVERY_REQUIRED, but the durable Run in view was COMPLETED and its plan FINAL_VERIFIED, so os_resume
 * reported that finished plan as the recoverable one and served « call os_verify(plan_id, TARGET) ». That call
 * can only answer HOLD_PLAN_REPLAY_INVALID. The skill obeys that continuation silently, so the conversation would
 * have looped on a dead end instead of showing the seller the blocker. A refusal that cannot be acted on is not
 * a refusal.
 */
test("PV-ADM-008 (A8): a Manifest HOLD whose durable Run is COMPLETED serves the blocker, never a replay of the finished plan", async () => {
  const { w } = world();
  const h = await bind(w);
  // A complete transaction: its plan reaches FINAL_VERIFIED and the Run it opened is COMPLETED.
  const plan = await interruptedTransaction(w, h);
  const target = await dispatch("os_verify", { binding_handle: h, plan_id: plan.plan_id, phase: "TARGET" }, ctx, w.deps);
  assert.equal(target.code, "TARGET_VERIFIED", JSON.stringify(target));
  const receipt = ((target as Ok).result as { target_receipt_id: string }).target_receipt_id;
  const symbols = target.observations["symbols"] as Record<string, string>;
  executeWrites(w, plan.finalization_writes, plan.plan_id, { ...({ now: "2030-01-04T00:10:30.000Z" }), created: symbols, target_receipt_id: receipt });
  executeWrites(w, [plan.state_last_write], plan.plan_id, { ...({ now: "2030-01-04T00:10:45.000Z" }), created: symbols, target_receipt_id: receipt });
  assert.equal((await dispatch("os_verify", { binding_handle: h, plan_id: plan.plan_id, phase: "FINAL" }, ctx, w.deps)).code, "TRANSACTION_VERIFIED");

  // The Manifest then turns, and the seller comes back in a later turn.
  setManifest(w, BLOCKED_MANIFEST, "2030-01-04T00:11:00.000Z");
  const later = { ...ctx, now: new Date(T0.getTime() + 16 * 60_000) };
  const resumed = await dispatch("os_resume", { binding_handle: h }, later, w.deps);
  assert.equal(resumed.code, "HOLD_RECOVERY_REQUIRED", JSON.stringify(resumed));
  assert.match(evidenceOf(resumed), /Manifest/, "the blocker is what the seller must be told about");

  const report = resumed.observations["open_backend_plan"] as { plan_id?: string } | "NONE";
  assert.notEqual(report !== "NONE" ? report.plan_id : undefined, plan.plan_id, "a FINAL_VERIFIED plan is not recoverable work");
  const safe = String((resumed as Hold).next?.safe_action ?? "");
  assert.doesNotMatch(safe, /os_verify/, `the continuation must not send the chat into a replay that can only be refused: ${safe}`);
  assert.match(safe, /HOLD_REBIND_REQUIRED|Health Status|Manifest/, `it must name what has to be reconciled: ${safe}`);
});
