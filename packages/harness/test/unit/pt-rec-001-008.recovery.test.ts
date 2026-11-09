/**
 * PV0-015 — recovery truth-table engine: PT-REC-001..008 (PG6).
 * Every crash is simulated by executing a subset of the rendered actions, then starting a NEW binding ("new chat")
 * that resumes and re-issues the original intent. Recovery is decided by observing durable state only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../../src/tools/handlers.ts";
import { metaSpecAdapter } from "../../src/versions/adapters/meta.ts";
import { META_CONTROL_PLANE_06 } from "../../src/versions/adapters/controlPlane.ts";
import { createAdapterRegistries } from "../../src/versions/registry.ts";
import { salesContractAdapter } from "../../src/versions/adapters/sales.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import type { Plan } from "../../src/plans/store.ts";
import { handleOf, OWNER, T0 } from "./binding-fixtures.ts";
import { buildResumeWorld, R, SALES_EXT_DS, type ResumeWorld } from "./resume-fixtures.ts";
import { GRAMMAR as META_GRAMMAR, ID as META_ID, V as MV } from "./meta-fixtures.ts";
import { SGRAMMAR, SV } from "./sales-fixtures.ts";
import { executeWrites, mutatePage, rowsOf, type WriterOptions } from "./target-fixtures.ts";
import { stage1 } from "../support/transact.ts";

const ctx = { principal_id: OWNER.principal_id, now: T0 };
const intent = { action_class: "COMMIT", summary: "set the next frame question", mutations: [{ logical_resource_key: "META:GATES", operation: "UPDATE" as const, record_selector: { natural_key: "T1" }, desired_changes: { "Next Question": "What is the offer?" } }] };
const T = { stage1: "2030-01-03T00:30:00.000Z", fin: "2030-01-03T00:31:00.000Z", state: "2030-01-03T00:32:00.000Z", rec1: "2030-01-03T01:00:00.000Z", rec2: "2030-01-03T01:01:00.000Z", rec3: "2030-01-03T01:02:00.000Z" };
type Ok = Extract<Envelope, { status: "OK" }>;

async function bind(w: ResumeWorld, lane: "META" | "SALES" = "META"): Promise<string> { return handleOf(await dispatch("os_bind", { project: "VERTIGO", lane }, ctx, w.deps)); }
async function prepare(w: ResumeWorld, h: string, i: unknown = intent, now = T0): Promise<{ r: Envelope; plan?: Plan }> {
  const r = await dispatch("os_prepare", { binding_handle: h, intent: i }, { principal_id: OWNER.principal_id, now }, w.deps);
  if (r.code === "PLAN_PREPARED") {
    assert.equal(r.next.permitted_tool_call, undefined, "preparation/recovery confers no implicit verification permission");
    assert.equal(r.next.native_actions_required, undefined, "recovery has no native-writer fallback");
  }
  const plan = r.code === "PLAN_PREPARED" ? await w.deps.store.plans.get(((r as Ok).result as { plan_id: string }).plan_id) : undefined;
  return { r, ...(plan ? { plan } : {}) };
}
const verify = (w: ResumeWorld, h: string, planId: string, phase: "TARGET" | "FINAL", now = T0) => dispatch("os_verify", { binding_handle: h, plan_id: planId, phase }, { principal_id: OWNER.principal_id, now }, w.deps);
/** Crash after a stage-1 subset in chat A, then a new chat B. */
async function crashAfter(w: ResumeWorld, opts: WriterOptions, i: unknown = intent, lane: "META" | "SALES" = "META"): Promise<{ hA: string; planA: Plan; created: Record<string, string> }> {
  const hA = await bind(w, lane);
  const { r, plan } = await prepare(w, hA, i);
  assert.equal(r.code, "PLAN_PREPARED", JSON.stringify(r));
  const created = stage1(w, plan!, { now: T.stage1, ...opts });
  return { hA, planA: plan!, created };
}
function symbolsOf(w: ResumeWorld, targetResult: Envelope): Record<string, string> { void w; return targetResult.observations["symbols"] as Record<string, string>; }
async function completeRecovery(w: ResumeWorld, hB: string, planB: Plan, now = T0): Promise<Envelope> {
  executeWrites(w, planB.stage1_writes, planB.plan_id, { now: T.rec1, salt: "rec" });
  const t = await verify(w, hB, planB.plan_id, "TARGET", now);
  assert.equal(t.code, "TARGET_VERIFIED", JSON.stringify(t));
  const receipt = ((t as Ok).result as { target_receipt_id: string }).target_receipt_id;
  const symbols = symbolsOf(w, t);
  executeWrites(w, planB.finalization_writes, planB.plan_id, { ...({ now: T.rec2 }), created: symbols, target_receipt_id: receipt });
  executeWrites(w, [planB.state_last_write], planB.plan_id, { ...({ now: T.rec3 }), created: symbols, target_receipt_id: receipt });
  return verify(w, hB, planB.plan_id, "FINAL", now);
}
const runsFor = (w: ResumeWorld, link: string) => rowsOf(w, R.metaRunsDs).filter((p) => (p.properties["Harness Plan ID"] as unknown as { rich_text: Array<{ plain_text: string }> })?.rich_text?.[0]?.plain_text === link);
const ledgerFor = (w: ResumeWorld, link: string) => rowsOf(w, R.metaLedgerDs).filter((p) => (p.properties["Harness Plan ID"] as unknown as { rich_text: Array<{ plain_text: string }> })?.rich_text?.[0]?.plain_text === link);
const text = (p: { properties: Record<string, unknown> }, f: string) => (p.properties[f] as { rich_text?: Array<{ plain_text: string }>; select?: { name: string }; number?: number } | undefined);

test("PT-REC-001: crash before TARGET after a stage-1 subset — new chat recovers by target observation; before-state replays once, no duplicates", async () => {
  // a) Run opened + ledger PREPARED, target never written (before state), ledger WRITTEN step missing.
  const w = buildResumeWorld();
  const { planA } = await crashAfter(w, { skip: ["TARGET_0", "LEDGER_0_WRITTEN"] });
  const hB = await bind(w);
  const res = await dispatch("os_resume", { binding_handle: hB }, ctx, w.deps);
  assert.equal(res.code, "HOLD_RECOVERY_REQUIRED", "stale RUNNING Run + PREPARED ledger row ⇒ recovery, never liveness");
  const { r, plan: planB } = await prepare(w, hB);
  assert.equal(r.code, "PLAN_PREPARED", JSON.stringify(r));
  assert.equal(planB!.run_mode, "RECOVER_EXISTING");
  assert.equal(planB!.recovers_plan_id, planA.plan_id);
  assert.equal((await w.deps.store.plans.get(planA.plan_id))!.plan_state, "SUPERSEDED");
  const rec = r.observations["recovery"] as { phase: string; replay: number[]; journal_repair: number[]; attempt_count: number };
  assert.equal(rec.phase, "STAGE1");
  assert.deepEqual(rec.replay, [0]);
  assert.equal(rec.attempt_count, 2);
  assert.deepEqual(planB!.stage1_writes.map((s) => s.symbol), ["RESUME_RUN", "TARGET_0", "LEDGER_0_WRITTEN"], "existing Run resumed, existing ledger row reused, target replayed once");
  assert.equal(planB!.stage1_writes[0]!.fields["Attempt Count"], 2);
  assert.match(planB!.stage1_writes[1]!.note ?? "", /replay permitted by the governing contract/);
  const fin = await completeRecovery(w, hB, planB!);
  assert.equal(fin.code, "TRANSACTION_VERIFIED", JSON.stringify(fin));
  assert.equal(runsFor(w, planA.plan_id).length, 1, "one Run");
  assert.equal(ledgerFor(w, planA.plan_id).length, 1, "one ledger row");
  assert.equal(text(runsFor(w, planA.plan_id)[0]!, "Attempt Count")?.number, 2, "historical attempt semantics preserved");
  assert.equal(text(runsFor(w, planA.plan_id)[0]!, "Spec Version")?.rich_text?.[0]?.plain_text, MV.specA, "version pins preserved");

  // b) Full stage-1 executed, crash before the TARGET call: the effect exists ⇒ reconcile, nothing replayed.
  const w2 = buildResumeWorld();
  const c2 = await crashAfter(w2, {});
  const hB2 = await bind(w2);
  const p2 = await prepare(w2, hB2);
  assert.equal(p2.r.code, "PLAN_PREPARED", JSON.stringify(p2.r));
  assert.deepEqual(p2.plan!.stage1_writes.map((s) => s.symbol), ["RESUME_RUN"], "no target replay when the expected state is observed");
  assert.equal((p2.r.observations["recovery"] as { phase: string }).phase, "TARGET_PENDING");
  const fin2 = await completeRecovery(w2, hB2, p2.plan!);
  assert.equal(fin2.code, "TRANSACTION_VERIFIED", JSON.stringify(fin2));
  assert.equal(ledgerFor(w2, c2.planA.plan_id).length, 1);

  // c) Only the Run was opened: journal repair + permitted replay.
  const w3 = buildResumeWorld();
  await crashAfter(w3, { skip: ["LEDGER_0", "TARGET_0", "LEDGER_0_WRITTEN"] });
  const hB3 = await bind(w3);
  const p3 = await prepare(w3, hB3);
  assert.equal(p3.r.code, "PLAN_PREPARED", JSON.stringify(p3.r));
  assert.deepEqual(p3.plan!.stage1_writes.map((s) => s.symbol), ["RESUME_RUN", "LEDGER_0", "TARGET_0", "LEDGER_0_WRITTEN"]);
  const fin3 = await completeRecovery(w3, hB3, p3.plan!);
  assert.equal(fin3.code, "TRANSACTION_VERIFIED", JSON.stringify(fin3));
});

test("PT-REC-002: crash after TARGET before finalization — target stays verified evidence, transaction incomplete; recovery finalizes without repeating the mutation", async () => {
  const w = buildResumeWorld();
  const { hA, planA } = await crashAfter(w, {});
  const t = await verify(w, hA, planA.plan_id, "TARGET");
  assert.equal(t.code, "TARGET_VERIFIED");
  const targetEdited = (w.map.get(`page:${R.gateM1}`) as { last_edited_time: string }).last_edited_time;
  // Chat A dies. Chat B resumes: not complete.
  const hB = await bind(w);
  const res = await dispatch("os_resume", { binding_handle: hB }, ctx, w.deps);
  assert.equal(res.code, "HOLD_RECOVERY_REQUIRED", "a RUNNING Run with WRITTEN ledger rows is not a completed transaction");
  const { r, plan: planB } = await prepare(w, hB);
  assert.equal(r.code, "PLAN_PREPARED", JSON.stringify(r));
  assert.equal((await w.deps.store.plans.get(planA.plan_id))!.plan_state, "SUPERSEDED");
  assert.ok(!planB!.stage1_writes.some((s) => s.purpose === "WRITE_TARGET"), "business mutation is not repeated");
  const fin = await completeRecovery(w, hB, planB!);
  assert.equal(fin.code, "TRANSACTION_VERIFIED", JSON.stringify(fin));
  assert.equal((w.map.get(`page:${R.gateM1}`) as { last_edited_time: string }).last_edited_time, targetEdited, "target untouched by recovery");
  assert.equal(ledgerFor(w, planA.plan_id).length, 1);
});

test("PT-REC-002/b: missing ledger Run/Target references are repaired from unambiguous durable facts; conflicting references HOLD", async () => {
  const w = buildResumeWorld();
  const { planA } = await crashAfter(w, {});
  const row = ledgerFor(w, planA.plan_id)[0]!;
  mutatePage(w, row.id, { "Run Ref": "", "Target Ref": "" }, T.fin);
  const hB = await bind(w);
  const p = await prepare(w, hB);
  assert.equal(p.r.code, "PLAN_PREPARED", JSON.stringify(p.r));
  const repair = p.plan!.stage1_writes.find((x) => x.purpose === "LEDGER_WRITTEN")!;
  assert.equal(repair.fields["Run Ref"], `page:${runsFor(w, planA.plan_id)[0]!.id}`);
  assert.equal(repair.fields["Target Ref"], `page:${R.gateM1}`);
  assert.equal((await completeRecovery(w, hB, p.plan!)).code, "TRANSACTION_VERIFIED");

  const w2 = buildResumeWorld();
  const c = await crashAfter(w2, {});
  mutatePage(w2, ledgerFor(w2, c.planA.plan_id)[0]!.id, { "Run Ref": R.run3 }, T.fin);
  const blocked = await prepare(w2, await bind(w2));
  assert.equal(blocked.r.code, "HOLD_CONFLICT", JSON.stringify(blocked.r));
});

test("PT-REC-003: crash during finalization before State Last — stale state is detected; recovery completes state-last without duplicating finalized pieces", async () => {
  const w = buildResumeWorld();
  const { hA, planA } = await crashAfter(w, {});
  const t = await verify(w, hA, planA.plan_id, "TARGET");
  const receipt = ((t as Ok).result as { target_receipt_id: string }).target_receipt_id;
  executeWrites(w, planA.finalization_writes, planA.plan_id, { ...({ now: T.fin }), created: symbolsOf(w, t), target_receipt_id: receipt });
  // Crash here: ledger VERIFIED, Run COMPLETED, Manifest stale.
  const hB = await bind(w);
  const res = await dispatch("os_resume", { binding_handle: hB }, ctx, w.deps);
  assert.equal(res.code, "HOLD_STATE_DIVERGENCE", JSON.stringify(res));
  assert.match((res as { evidence: readonly string[] }).evidence.join("\n"), /state-last write is missing/);
  // Unrelated new work is blocked.
  const other = await prepare(w, hB, { ...intent, summary: "other", mutations: [{ ...intent.mutations[0]!, desired_changes: { "Next Question": "Unrelated?" } }] });
  assert.equal(other.r.code, "HOLD_RUNTIME_BUSY", "unrelated work cannot leapfrog the interrupted transaction (its plan still holds the lease)");
  // Re-issuing the original intent recovers: FINAL_PENDING, nothing to rewrite except state-last.
  const { r, plan: planB } = await prepare(w, hB);
  assert.equal(r.code, "PLAN_PREPARED", JSON.stringify(r));
  assert.equal((r.observations["recovery"] as { phase: string }).phase, "FINAL_PENDING");
  assert.deepEqual(planB!.stage1_writes, []);
  const t2 = await verify(w, hB, planB!.plan_id, "TARGET");
  assert.equal(t2.code, "TARGET_VERIFIED", JSON.stringify(t2));
  const symbols = symbolsOf(w, t2);
  executeWrites(w, [planB!.state_last_write], planB!.plan_id, { ...({ now: T.rec3 }), created: symbols, target_receipt_id: ((t2 as Ok).result as { target_receipt_id: string }).target_receipt_id });
  const fin = await verify(w, hB, planB!.plan_id, "FINAL");
  assert.equal(fin.code, "TRANSACTION_VERIFIED", JSON.stringify(fin));
  assert.equal(ledgerFor(w, planA.plan_id).length, 1);
  assert.equal(text(ledgerFor(w, planA.plan_id)[0]!, "Target Receipt ID")?.rich_text?.[0]?.plain_text, receipt, "already-finalized ledger row kept its original harness receipt (lineage accepted)");
});

test("PT-REC-004: crash after State Last before FINAL — verification is reconstructed without replaying any write", async () => {
  const w = buildResumeWorld();
  const { hA, planA } = await crashAfter(w, {});
  const t = await verify(w, hA, planA.plan_id, "TARGET");
  const receipt = ((t as Ok).result as { target_receipt_id: string }).target_receipt_id;
  const symbols = symbolsOf(w, t);
  executeWrites(w, planA.finalization_writes, planA.plan_id, { ...({ now: T.fin }), created: symbols, target_receipt_id: receipt });
  executeWrites(w, [planA.state_last_write], planA.plan_id, { ...({ now: T.state }), created: symbols, target_receipt_id: receipt });
  const snapshot = JSON.stringify([...w.map.entries()].sort(([a], [b]) => a.localeCompare(b)));
  // FINAL never called; chat B takes over.
  const hB = await bind(w);
  assert.equal((await dispatch("os_resume", { binding_handle: hB }, ctx, w.deps)).code, "RESUMED", "durable state is healthy: Run adopted by the Manifest");
  const { r, plan: planB } = await prepare(w, hB);
  assert.equal(r.code, "PLAN_PREPARED", JSON.stringify(r));
  assert.equal((r.observations["recovery"] as { phase: string }).phase, "FINAL_PENDING");
  assert.deepEqual(planB!.stage1_writes, []);
  const t2 = await verify(w, hB, planB!.plan_id, "TARGET");
  assert.equal(t2.code, "TARGET_VERIFIED", JSON.stringify(t2));
  const fin = await verify(w, hB, planB!.plan_id, "FINAL");
  assert.equal(fin.code, "TRANSACTION_VERIFIED", JSON.stringify(fin));
  assert.equal(JSON.stringify([...w.map.entries()].sort(([a], [b]) => a.localeCompare(b))), snapshot, "no Notion write was needed or performed");
});

test("PT-REC-005: plan expiry never implies effect absence — recovery inspects Run/ledger/target and reconciles", async () => {
  const w = buildResumeWorld();
  const { hA, planA } = await crashAfter(w, {});
  const later = new Date(T0.getTime() + 16 * 60_000);
  assert.equal((await verify(w, hA, planA.plan_id, "TARGET", later)).code, "HOLD_PLAN_EXPIRED");
  assert.equal((await w.deps.store.plans.get(planA.plan_id))!.plan_state, "EXPIRED");
  const hB = await bind(w);
  const resumed = await dispatch("os_resume", { binding_handle: hB }, { principal_id: OWNER.principal_id, now: later }, w.deps);
  assert.equal(resumed.code, "HOLD_RECOVERY_REQUIRED");
  const reported = resumed.observations["open_backend_plan"] as { plan_id: string; owned_by_caller: boolean; expired: boolean };
  assert.equal(reported.plan_id, planA.plan_id, "the durable Run reconnects an already-terminal EXPIRED backend plan");
  assert.equal(reported.owned_by_caller, true);
  assert.equal(reported.expired, true);
  assert.equal(resumed.next.permitted_tool_call, "os_verify");
  assert.equal(resumed.say, undefined, "backend-directed recovery is an internal continuation, not a user turn");
  const { r, plan: planB } = await prepare(w, hB, intent, later);
  assert.equal(r.code, "PLAN_PREPARED", JSON.stringify(r));
  assert.equal(planB!.run_mode, "RECOVER_EXISTING");
  assert.deepEqual(planB!.stage1_writes.map((s) => s.symbol), ["RESUME_RUN"], "expired plan's write is observed as present: nothing replayed");
  const fin = await completeRecovery(w, hB, planB!, later);
  assert.equal(fin.code, "TRANSACTION_VERIFIED", JSON.stringify(fin));
  assert.equal(ledgerFor(w, planA.plan_id).length, 1);
  assert.equal(runsFor(w, planA.plan_id).length, 1);
});

test("PT-REC-005/b: a cold chat TARGETs its owned expired old plan id and receives a new binding-scoped recovery plan", async () => {
  const w = buildResumeWorld();
  const { planA } = await crashAfter(w, {});
  const later = new Date(T0.getTime() + 16 * 60_000);
  const hB = await bind(w);

  const opened = await verify(w, hB, planA.plan_id, "TARGET", later);
  assert.equal(opened.code, "PLAN_PREPARED", JSON.stringify(opened));
  const planBId = (opened as Ok).result["plan_id"] as string;
  const planB = (await w.deps.store.plans.get(planBId)) as Plan;
  assert.notEqual(planB.plan_id, planA.plan_id, "the old plan is observed, never adopted");
  assert.notEqual(planB.binding_id, planA.binding_id);
  assert.equal(planB.run_mode, "RECOVER_EXISTING");
  assert.equal(planB.recovers_plan_id, planA.plan_id);
  const withoutRowIdentity = (op: Plan["operations"][number]) => Object.fromEntries(
    Object.entries(op).filter(([field]) => field !== "operation_id"),
  );
  assert.deepEqual(
    planB.operations.map(withoutRowIdentity),
    planA.operations.map(withoutRowIdentity),
    "recovery preserves every business field, including idempotency and target semantics",
  );
  assert.equal(
    planB.operations.some((op) => planA.operations.some((original) => original.operation_id === op.operation_id)),
    false,
    "a new durable plan never reuses globally unique plan-operation row ids",
  );
  assert.equal((await w.deps.store.plans.get(planA.plan_id))?.plan_state, "EXPIRED");

  const fin = await completeRecovery(w, hB, planB, later);
  assert.equal(fin.code, "TRANSACTION_VERIFIED", JSON.stringify(fin));
  assert.equal(runsFor(w, planA.plan_id).length, 1, "one Run across the old and recovery plans");
  assert.equal(ledgerFor(w, planA.plan_id).length, 1, "one ledger row across the old and recovery plans");
  assert.equal(rowsOf(w, R.metaGatesDs).filter((p) => p.id === R.gateM1).length, 1, "one target record");
});

test("PT-REC-005/c: cross-binding recovery stays closed for a live plan and for a runtime/generation mismatch", async () => {
  const w = buildResumeWorld();
  const { planA } = await crashAfter(w, {});
  const hB = await bind(w);
  assert.equal((await verify(w, hB, planA.plan_id, "TARGET", T0)).code, "HOLD_PLAN_BINDING_MISMATCH", "a live old plan cannot be recovered cross-binding");

  const expired = new Date(T0.getTime() + 16 * 60_000);
  const rotated = { ...planA, runtime_generation: `${planA.runtime_generation}-other`, expires_at: new Date(T0.getTime() - 1), plan_state: "EXPIRED" as const };
  await w.deps.store.plans.insert({ ...rotated, plan_id: "expired-other-generation", binding_id: "old-other-binding" });
  assert.equal((await verify(w, hB, "expired-other-generation", "TARGET", expired)).code, "HOLD_PLAN_BINDING_MISMATCH");
});

test("PT-REC-006: before-state replay only under a governing contract that permits it; otherwise HOLD, no blind replay", async () => {
  // Permitted branch is covered by PT-REC-001/c. Forbidden branch: same runtime, contract without replay.
  const w = buildResumeWorld();
  const adapters = createAdapterRegistries();
  adapters.metaRuntime.register(MV.specA, metaSpecAdapter(MV.specA, [MV.schema], { ...META_GRAMMAR, controlPlane: { ...META_CONTROL_PLANE_06, recoveryPolicy: { replayFromBeforeState: false } } }));
  adapters.salesRuntime.register(SV.contract, salesContractAdapter(SV.contract, [SV.schema], SGRAMMAR));
  (w.deps as { adapters: typeof adapters }).adapters = adapters;
  await crashAfter(w, { skip: ["TARGET_0", "LEDGER_0_WRITTEN"] });
  const hB = await bind(w);
  const { r } = await prepare(w, hB);
  assert.equal(r.code, "HOLD_RECOVERY_REQUIRED", JSON.stringify(r));
  assert.match((r as { evidence: readonly string[] }).evidence.join("\n"), /does not permit replay/);
  assert.equal((await w.deps.store.events.list({})).filter((e) => e.event_type === "PLAN_CREATED").length, 1, "no recovery plan created");
  assert.equal((w.map.get(`page:${R.gateM1}`) as { last_edited_time: string }).last_edited_time, "2030-01-02T00:00:00.000Z", "target untouched");
});

test("PT-REC-007: a target in a third state (neither before nor expected) HOLDs with evidence; nothing is overwritten", async () => {
  const w = buildResumeWorld();
  await crashAfter(w, { skip: ["TARGET_0", "LEDGER_0_WRITTEN"] });
  mutatePage(w, R.gateM1, { "Next Question": "Someone else's question?" }, T.fin);
  const hB = await bind(w);
  const { r } = await prepare(w, hB);
  assert.equal(r.code, "HOLD_CONFLICT", JSON.stringify(r));
  const ev = (r as { evidence: readonly string[] }).evidence.join("\n");
  assert.match(ev, /observed "Someone else's question\?", before "What do you sell\?", expected "What is the offer\?"/);
  assert.equal((await w.deps.store.events.list({})).filter((e) => e.event_type === "PLAN_CREATED").length, 1, "no recovery plan");
  assert.match(r.next.safe_action, /nothing is replayed or overwritten/);
});

test("PT-REC-008: interrupted CREATE is located by data source + natural key; no duplicate; multiple matches HOLD", async () => {
  const createIntent = { action_class: "COMMIT", summary: "queue an intent", mutations: [{ logical_resource_key: "SALES:EXTERNAL_ACTIONS", operation: "CREATE" as const, record_selector: { natural_key: "ak-rec-1" }, desired_changes: { Recipient: "someone@example.invalid" } }] };
  const w = buildResumeWorld();
  const { planA, created } = await crashAfter(w, {}, createIntent, "SALES");
  const countRows = () => rowsOf(w, SALES_EXT_DS("rep-a")).filter((p) => (p.properties["Action Key"] as unknown as { rich_text: Array<{ plain_text: string }> }).rich_text[0]?.plain_text === "ak-rec-1").length;
  assert.equal(countRows(), 1);
  const hB = await bind(w, "SALES");
  const { r, plan: planB } = await prepare(w, hB, createIntent);
  assert.equal(r.code, "PLAN_PREPARED", JSON.stringify(r));
  const rec = r.observations["recovery"] as { operations: Array<{ kind: string; page_ref: string }> };
  assert.equal(rec.operations[0]!.kind, "EXPECTED");
  assert.equal(rec.operations[0]!.page_ref, created["TARGET_0"], "existing row located by natural key");
  assert.ok(!planB!.stage1_writes.some((s) => s.purpose === "WRITE_TARGET"), "no second CREATE");
  const fin = await completeRecovery(w, hB, planB!);
  assert.equal(fin.code, "TRANSACTION_VERIFIED", JSON.stringify(fin));
  assert.equal(countRows(), 1, "no duplicate created");
  assert.equal(planB!.recovers_plan_id, planA.plan_id);
  // Duplicate rows ⇒ HOLD, never bind to either.
  const w2 = buildResumeWorld();
  await crashAfter(w2, { duplicate: ["TARGET_0"] }, createIntent, "SALES");
  const hB2 = await bind(w2, "SALES");
  const p2 = await prepare(w2, hB2, createIntent);
  assert.equal(p2.r.code, "HOLD_TARGET_AMBIGUOUS", JSON.stringify(p2.r));
  assert.equal((await w2.deps.store.events.list({})).filter((e) => e.event_type === "PLAN_CREATED").length, 1);

  // Only the Run landed: recovery must preserve PREPARE-before-effect without a
  // forward reference, then link the newly created target at LEDGER_WRITTEN.
  const w3 = buildResumeWorld();
  await crashAfter(w3, { skip: ["LEDGER_0", "TARGET_0", "LEDGER_0_WRITTEN"] }, createIntent, "SALES");
  const hB3 = await bind(w3, "SALES");
  const p3 = await prepare(w3, hB3, createIntent);
  assert.equal(p3.r.code, "PLAN_PREPARED", JSON.stringify(p3.r));
  const prep3 = p3.plan!.stage1_writes.find((x) => x.purpose === "PREPARE_LEDGER")!;
  const written3 = p3.plan!.stage1_writes.find((x) => x.purpose === "LEDGER_WRITTEN")!;
  assert.ok(!("Target Ref" in prep3.fields), "recovery PREPARE has no future target reference");
  assert.equal(written3.fields["Target Ref"], "$created:TARGET_0", "recovery links the target after replayed CREATE");
  assert.equal((await completeRecovery(w3, hB3, p3.plan!)).code, "TRANSACTION_VERIFIED");
});

test("PT-REC-010 (engine part): a stale RUNNING Run left by a dead attempt is classified recovery-pending, never treated as a live worker", async () => {
  const w = buildResumeWorld();
  await crashAfter(w, { skip: ["TARGET_0", "LEDGER_0_WRITTEN"] });
  const hB = await bind(w);
  const res = await dispatch("os_resume", { binding_handle: hB }, ctx, w.deps);
  assert.equal(res.code, "HOLD_RECOVERY_REQUIRED");
  assert.match((res as { evidence: readonly string[] }).evidence.join("\n"), /RUNNING\/HOLD from another execution is not liveness proof/);
  void META_ID;
});
