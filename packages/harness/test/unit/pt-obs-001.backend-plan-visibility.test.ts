/**
 * PT-OBS-001 (PV0-020E) — a backend plan in flight must be visible, and a refusal by a live lease must be audited.
 * Before this, os_resume always reported open_backend_plan = "NONE" and prepare's lease refusal wrote no event, so a
 * lane blocked for a whole plan TTL was invisible in both the envelope and transaction_events (06 — RESUME, RECOVERY
 * & CONCURRENCY lists "expired backend plan where writes may have occurred" as a recovery trigger).
 * Read-only guarantee: os_resume reports the plan but never sweeps, transitions, releases or writes it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../../src/tools/handlers.ts";
import { createPlan, describeActivePlan, leaseKeyOf, type ActivePlanReport } from "../../src/plans/service.ts";
import { hashHandle } from "../../src/binding/handle.ts";
import type { Plan } from "../../src/plans/store.ts";
import { buildWorld, handleOf, OWNER, T0 } from "./binding-fixtures.ts";
import { buildResumeWorld } from "./resume-fixtures.ts";
import { draftFor } from "./plan-fixtures.ts";

const ctx = { principal_id: OWNER.principal_id, now: T0 };
const report = (e: Awaited<ReturnType<typeof dispatch>>) => (e.status === "OK" ? (e.result as Record<string, unknown>)["open_backend_plan"] : e.observations["open_backend_plan"]) as ActivePlanReport;
const caller = { principal_id: OWNER.principal_id, binding_id: "b-1" };

test("PT-OBS-001/a: the descriptor is pure — no plan is NONE, and a foreign principal's plan is busy without disclosing id or state", () => {
  assert.equal(describeActivePlan([], undefined, caller, T0), "NONE");
  const foreign = { plan_id: "p-secret", principal_id: "p-someone-else", binding_id: "b-x", plan_state: "TARGET_VERIFIED", created_at: T0, expires_at: new Date(T0.getTime() + 60_000) } as unknown as Plan;
  const lease = { project: "VERTIGO", lane: "META" as const, runtime_generation: "g", plan_id: "p-secret", acquired_at: T0, expires_at: new Date(T0.getTime() + 60_000) };
  const r = describeActivePlan([foreign], lease, caller, T0);
  assert.notEqual(r, "NONE");
  const o = r as Exclude<ActivePlanReport, "NONE">;
  assert.equal(o.owned_by_caller, false);
  assert.equal(o.plan_id, "NOT_APPLICABLE", "a foreign plan id is never disclosed");
  assert.equal(o.plan_state, "UNKNOWN", "a foreign plan state is never disclosed");
  assert.equal(o.holds_mutation_lease, true, "but the busy signal is given");
  assert.match(o.next_safe_action, /another principal holds this runtime's mutation lease/);
  assert.ok(!JSON.stringify(o).includes("p-secret"));
});

test("PT-OBS-001/b: os_resume reports this binding's live plan instead of NONE", async () => {
  const w = buildResumeWorld();
  const h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps));
  assert.equal(report(await dispatch("os_resume", { binding_handle: h }, ctx, w.deps)), "NONE", "no plan ⇒ NONE");
  const binding = (await w.deps.store.bindings.findByHandleHash(hashHandle(h)))!;
  const created = await createPlan(w.deps.store, w.deps.config, draftFor(binding), T0);
  assert.equal(created.kind, "CREATED");
  const plan = (created as { plan: Plan }).plan;
  const o = report(await dispatch("os_resume", { binding_handle: h }, ctx, w.deps)) as Exclude<ActivePlanReport, "NONE">;
  assert.equal(o.plan_id, plan.plan_id);
  assert.equal(o.plan_state, "AWAITING_STAGE1_WRITES");
  assert.equal(o.owned_by_caller, true);
  assert.equal(o.same_binding, true);
  assert.equal(o.expired, false);
  assert.equal(o.holds_mutation_lease, true);
  assert.equal(o.recovery_possible, false);
  assert.match(o.next_safe_action, /through os_commit/);
  assert.equal("stage1_actions" in o, false, "the backend plan is visible, never a native-write payload");
});

test("PT-OBS-001/c: an expired plan is reported as recovery-possible, and os_resume does not sweep it", async () => {
  const w = buildResumeWorld();
  const h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps));
  const binding = (await w.deps.store.bindings.findByHandleHash(hashHandle(h)))!;
  const created = await createPlan(w.deps.store, w.deps.config, draftFor(binding), T0);
  const plan = (created as { plan: Plan }).plan;
  const later = { principal_id: OWNER.principal_id, now: new Date(T0.getTime() + 3600_000) };
  const before = (await w.deps.store.events.list({})).length;
  const o = report(await dispatch("os_resume", { binding_handle: h }, later, w.deps)) as Exclude<ActivePlanReport, "NONE">;
  assert.equal(o.plan_id, plan.plan_id);
  assert.equal(o.expired, true);
  assert.equal(o.recovery_possible, true, "expiry never implies effect absence");
  assert.equal(o.holds_mutation_lease, false, "an expired lease no longer holds the runtime");
  assert.match(o.next_safe_action, /re-prepare the same intent/);
  // Read-only: the plan is NOT transitioned and nothing is appended by resume.
  assert.equal((await w.deps.store.plans.get(plan.plan_id))!.plan_state, "AWAITING_STAGE1_WRITES", "os_resume never sweeps");
  assert.equal((await w.deps.store.events.list({})).length, before, "os_resume appends no event");
  assert.ok(await w.deps.store.leases.current(leaseKeyOf(binding), T0), "the lease row is untouched, only logically expired");
});

test("PT-OBS-001/d: a prepare refused by a live lease is audited as PLAN_HOLD / HOLD_RUNTIME_BUSY", async () => {
  const w = buildWorld();
  const chatA = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps));
  const chatB = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps));
  const bindingA = (await w.deps.store.bindings.findByHandleHash(hashHandle(chatA)))!;
  const a = await createPlan(w.deps.store, w.deps.config, draftFor(bindingA), T0);
  assert.equal(a.kind, "CREATED");
  const holder = (a as { plan: Plan }).plan.plan_id;
  const before = (await w.deps.store.events.list({})).filter((e) => e.event_type === "PLAN_HOLD").length;
  const refused = await dispatch("os_prepare", { binding_handle: chatB, intent: { action_class: "COMMIT", summary: "parallel", mutations: [{ logical_resource_key: "META:MANIFEST", operation: "UPDATE", record_selector: { natural_key: "CURRENT" }, desired_changes: { a: 1 } }] } }, ctx, w.deps);
  assert.equal(refused.code, "HOLD_RUNTIME_BUSY");
  const holds = (await w.deps.store.events.list({})).filter((e) => e.event_type === "PLAN_HOLD" && e.result === "HOLD_RUNTIME_BUSY");
  assert.equal(holds.length, before + 1, "the refusal leaves exactly one audit trace");
  assert.equal((holds.at(-1)!.detail as { holder_plan_id: string }).holder_plan_id, holder);
  assert.ok((holds.at(-1)!.detail as { holder_expires_at: string }).holder_expires_at);
  // And the refused caller can now SEE what blocks it.
  const o = report(await dispatch("os_resume", { binding_handle: chatB }, ctx, w.deps)) as Exclude<ActivePlanReport, "NONE">;
  assert.equal(o.plan_id, holder);
  assert.equal(o.same_binding, false);
  assert.equal(o.holds_mutation_lease, true);
  assert.match(o.next_safe_action, /another conversation of yours/);
});
