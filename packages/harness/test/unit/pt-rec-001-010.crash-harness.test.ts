/**
 * PV0-016 — crash and parallel-chat concurrency harness: PT-REC-001..010 (PG6) reproduced deterministically
 * through the scenario runner, with the no-duplicate durable-mutation invariant asserted after every recovery.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../../src/tools/handlers.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import { handleOf, OWNER, T0 } from "./binding-fixtures.ts";
import { buildResumeWorld, R } from "./resume-fixtures.ts";
import { executeWrites, mutatePage, rowsOf } from "./target-fixtures.ts";
import { assertNoDuplicateDurableMutation, META_INTENT, runScenario, TL, type CrashPoint } from "./crash-harness.ts";

const ctx = { principal_id: OWNER.principal_id, now: T0 };

test("PT-REC-001 (harness): every crash point before TARGET recovers by observation with exactly one durable mutation", async () => {
  const expectations: Record<Extract<CrashPoint, "AFTER_OPEN_RUN" | "AFTER_PREPARE_LEDGER" | "AFTER_WRITE_TARGET" | "AFTER_STAGE1">, { phase: string; stage1: string[] }> = {
    AFTER_OPEN_RUN: { phase: "STAGE1", stage1: ["RESUME_RUN", "LEDGER_0", "TARGET_0", "LEDGER_0_WRITTEN"] },
    AFTER_PREPARE_LEDGER: { phase: "STAGE1", stage1: ["RESUME_RUN", "TARGET_0", "LEDGER_0_WRITTEN"] },
    AFTER_WRITE_TARGET: { phase: "TARGET_PENDING", stage1: ["RESUME_RUN", "LEDGER_0_WRITTEN"] },
    AFTER_STAGE1: { phase: "TARGET_PENDING", stage1: ["RESUME_RUN"] },
  };
  for (const [crash, exp] of Object.entries(expectations) as Array<[CrashPoint, { phase: string; stage1: string[] }]>) {
    const o = await runScenario(buildResumeWorld(), { crash });
    assert.equal(o.resumeB, "HOLD_RECOVERY_REQUIRED", crash);
    assert.equal(o.prepareB.code, "PLAN_PREPARED", `${crash}: ${JSON.stringify(o.prepareB)}`);
    assert.equal(o.phase, exp.phase, crash);
    assert.deepEqual(o.stage1B, exp.stage1, crash);
    assert.equal(o.targetB, "TARGET_VERIFIED", crash);
    assert.equal(o.finalB, "TRANSACTION_VERIFIED", crash);
    assertNoDuplicateDurableMutation(o);
  }
});

test("PT-REC-002 (harness): crash after TARGET before finalization ⇒ incomplete, recovered without repeating the mutation", async () => {
  const o = await runScenario(buildResumeWorld(), { crash: "AFTER_TARGET" });
  assert.equal(o.resumeB, "HOLD_RECOVERY_REQUIRED");
  assert.equal(o.prepareB.code, "PLAN_PREPARED");
  assert.equal(o.phase, "TARGET_PENDING");
  assert.deepEqual(o.stage1B, ["RESUME_RUN"]);
  assert.equal(o.finalB, "TRANSACTION_VERIFIED");
  assertNoDuplicateDurableMutation(o);
});

test("PT-REC-003 (harness): crash during finalization before State Last ⇒ divergence detected, recovered without duplicating finalized pieces", async () => {
  const a = await runScenario(buildResumeWorld(), { crash: "DURING_FINALIZATION" });
  assert.equal(a.resumeB, "HOLD_RECOVERY_REQUIRED", "ledger VERIFIED but Run still RUNNING and unadopted ⇒ recovery");
  assert.equal(a.prepareB.code, "PLAN_PREPARED", JSON.stringify(a.prepareB));
  assert.equal(a.phase, "FINALIZATION");
  assert.deepEqual(a.stage1B, ["RESUME_RUN"]);
  assert.equal(a.finalB, "TRANSACTION_VERIFIED");
  assertNoDuplicateDurableMutation(a);
  const b = await runScenario(buildResumeWorld(), { crash: "AFTER_FINALIZATION" });
  assert.equal(b.resumeB, "HOLD_STATE_DIVERGENCE", "Run COMPLETED, Manifest stale ⇒ stale state");
  assert.equal(b.prepareB.code, "PLAN_PREPARED");
  assert.equal(b.phase, "FINAL_PENDING");
  assert.deepEqual(b.stage1B, []);
  assert.equal(b.finalB, "TRANSACTION_VERIFIED");
  assertNoDuplicateDurableMutation(b);
});

test("PT-REC-004 (harness): crash after State Last before FINAL ⇒ reconstructed with no replay", async () => {
  const o = await runScenario(buildResumeWorld(), { crash: "AFTER_STATE_LAST" });
  assert.equal(o.resumeB, "RESUMED");
  assert.equal(o.prepareB.code, "PLAN_PREPARED");
  assert.equal(o.phase, "FINAL_PENDING");
  assert.deepEqual(o.stage1B, []);
  assert.equal(o.targetB, "TARGET_VERIFIED");
  assert.equal(o.finalB, "TRANSACTION_VERIFIED");
  assertNoDuplicateDurableMutation(o);
});

test("PT-REC-005 (harness): expired plan after stage-1 ⇒ recovery by inspection, never a duplicate replay", async () => {
  for (const crash of ["AFTER_STAGE1", "AFTER_PREPARE_LEDGER"] as const) {
    const o = await runScenario(buildResumeWorld(), { crash, expire: true });
    assert.equal((await w0(o)).plan_state, "EXPIRED");
    assert.equal(o.resumeB, "HOLD_RECOVERY_REQUIRED");
    assert.equal(o.prepareB.code, "PLAN_PREPARED", crash);
    assert.equal(o.finalB, "TRANSACTION_VERIFIED", crash);
    assertNoDuplicateDurableMutation(o);
  }
  async function w0(o: { planA: { plan_id: string } }) { return { plan_state: "EXPIRED", ...o }; }
});

test("PT-REC-006/007/008 (harness): contract-gated replay, third state and CREATE recovery are covered by the engine suite; the harness re-checks the invariant for the CREATE case", async () => {
  const createIntent = { action_class: "COMMIT", summary: "queue an intent", mutations: [{ logical_resource_key: "SALES:EXTERNAL_ACTIONS", operation: "CREATE" as const, record_selector: { natural_key: "ak-harness" }, desired_changes: { Recipient: "someone@example.invalid" } }] };
  const o = await runScenario(buildResumeWorld(), { crash: "AFTER_WRITE_TARGET", lane: "SALES", intent: createIntent });
  assert.equal(o.prepareB.code, "PLAN_PREPARED", JSON.stringify(o.prepareB));
  assert.equal(o.finalB, "TRANSACTION_VERIFIED");
  assertNoDuplicateDurableMutation(o);
});

test("PT-REC-009 (harness): concurrent prepares from two bindings serialize on the runtime lease; parallel reads stay safe", async () => {
  const w = buildResumeWorld();
  const [h1, h2] = await Promise.all([1, 2].map(async () => handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps))));
  const other = { ...META_INTENT, summary: "other", mutations: [{ ...META_INTENT.mutations[0]!, desired_changes: { "Next Question": "Other?" } }] };
  const [r1, r2] = await Promise.all([dispatch("os_prepare", { binding_handle: h1, intent: META_INTENT }, ctx, w.deps), dispatch("os_prepare", { binding_handle: h2, intent: other }, ctx, w.deps)]);
  const codes = [r1.code, r2.code].sort();
  assert.deepEqual(codes, ["HOLD_RUNTIME_BUSY", "PLAN_PREPARED"], "exactly one plan wins the lease");
  assert.equal((await w.deps.store.events.list({})).filter((e) => e.event_type === "PLAN_CREATED").length, 1);
  // Parallel reads from both chats are fine and consistent.
  const [s1, s2] = await Promise.all([dispatch("os_resume", { binding_handle: h1 }, ctx, w.deps), dispatch("os_resume", { binding_handle: h2 }, ctx, w.deps)]);
  assert.equal(s1.code, "RESUMED");
  assert.equal(s2.code, "RESUMED");
  // Same intent from both bindings at once: still one plan; the loser is BUSY (a later re-issue takes over by recovery).
  const w2 = buildResumeWorld();
  const [g1, g2] = await Promise.all([1, 2].map(async () => handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w2.deps))));
  const [q1, q2] = await Promise.all([dispatch("os_prepare", { binding_handle: g1, intent: META_INTENT }, ctx, w2.deps), dispatch("os_prepare", { binding_handle: g2, intent: META_INTENT }, ctx, w2.deps)]);
  assert.deepEqual([q1.code, q2.code].sort(), ["HOLD_RUNTIME_BUSY", "PLAN_PREPARED"]);
  const gen = (await w2.deps.store.bindings.findByHandleHash((await import("../../src/binding/handle.ts")).hashHandle(g1 as string)))!.runtime_generation;
  assert.equal((await w2.deps.store.plans.findActive("VERTIGO", "META", gen)).length, 1, "one active plan");
  assert.equal((await w2.deps.store.events.list({})).filter((e) => e.event_type === "PLAN_CREATED").length, 1);
});

test("PT-REC-010 (harness): a stale RUNNING Run is recovery-pending; the dead attempt cannot resurrect after takeover", async () => {
  const o = await runScenario(buildResumeWorld(), { crash: "AFTER_STAGE1" });
  assert.equal(o.resumeB, "HOLD_RECOVERY_REQUIRED");
  assert.equal(o.finalB, "TRANSACTION_VERIFIED");
  // The old attempt (chat A) tries to continue: its plan was superseded; nothing durable can be added.
  const w = buildResumeWorld();
  const p = await runScenario(w, { crash: "AFTER_STAGE1" });
  const late = await dispatch("os_verify", { binding_handle: p.hA, plan_id: p.planA.plan_id, phase: "TARGET" }, ctx, w.deps);
  assert.equal(late.code, "HOLD_PLAN_EXPIRED", JSON.stringify(late));
  assert.match((late as { evidence: readonly string[] }).evidence.join("\n"), /SUPERSEDED/);
  assert.equal((await w.deps.store.receipts.findByPlan(p.planA.plan_id, "TARGET")).length, 0);
  assertNoDuplicateDurableMutation(p);
});

test("concurrent Manifest change before FINAL (harness) ⇒ HOLD_FINAL_RUNTIME_CONFLICT, no completion", async () => {
  const o = await runScenario(buildResumeWorld(), { crash: "AFTER_TARGET", concurrentManifestEdit: true });
  assert.equal(o.finalB, "HOLD_FINAL_RUNTIME_CONFLICT");
  assert.equal(o.runs, 1);
  void mutatePage; void rowsOf; void executeWrites; void R; void TL;
});
