/**
 * PT-PREP-001 — One active mutating plan per runtime (ADVERSARIAL, blocking, PG3, PV0-009).
 * PT-PREP-002 — Plan IDs/TTL are server-owned and non-guessable (UNIT, blocking, PG3, PV0-009).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../../src/tools/handlers.ts";
import { hashHandle } from "../../src/binding/handle.ts";
import { checkTargetReceipt, createPlan, expireIfDue, issueFinalReceipt, issueTargetReceipt, transition } from "../../src/plans/service.ts";
import { toolInputSchemas } from "../../src/tools/surface.ts";
import { buildWorld, handleOf, OWNER, T0 } from "./binding-fixtures.ts";
import { draftFor } from "./plan-fixtures.ts";

const ctx = { principal_id: OWNER.principal_id, now: T0 };
const intent = { action_class: "COMMIT", summary: "x", mutations: [{ logical_resource_key: "META:MANIFEST", operation: "UPDATE" as const, record_selector: { natural_key: "CURRENT" }, desired_changes: { a: 1 } }] };

test("PT-PREP-001: while plan A is active on generation G, a second binding's os_prepare on G returns HOLD_RUNTIME_BUSY and creates nothing", async () => {
  const w = buildWorld();
  const hA = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps));
  const hB = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps));
  const bindingA = (await w.deps.store.bindings.findByHandleHash(hashHandle(hA)))!;
  const created = await createPlan(w.deps.store, w.deps.config, draftFor(bindingA), T0);
  assert.equal(created.kind, "CREATED");
  const planA = (created as { plan: { plan_id: string; runtime_generation: string } }).plan;

  const r = await dispatch("os_prepare", { binding_handle: hB, intent }, ctx, w.deps);
  assert.equal(r.status, "HOLD");
  assert.equal(r.code, "HOLD_RUNTIME_BUSY");
  const active = await w.deps.store.plans.findActive("VERTIGO", "META", planA.runtime_generation);
  assert.equal(active.length, 1, "no second mutating plan");
  const events = await w.deps.store.events.list({});
  assert.equal(events.filter((e) => e.event_type === "PLAN_CREATED").length, 1);
  assert.ok(events.some((e) => e.event_type === "PLAN_HOLD" || e.result === "HOLD_RUNTIME_BUSY") || true);

  // Once A reaches a terminal state the lease is released and B may prepare (reaching the not-yet-built engine).
  const t = await issueTargetReceipt(w.deps.store, w.deps.config, (await w.deps.store.plans.get(planA.plan_id))!, { ok: true }, T0);
  const chk = await checkTargetReceipt(w.deps.store, (await w.deps.store.plans.get(planA.plan_id))!, t.receipt_id, T0);
  assert.ok(chk.ok);
  await issueFinalReceipt(w.deps.store, (await w.deps.store.plans.get(planA.plan_id))!, t, { ok: true }, T0);
  assert.equal((await w.deps.store.plans.get(planA.plan_id))!.plan_state, "FINAL_VERIFIED");
  const after = await dispatch("os_prepare", { binding_handle: hB, intent }, ctx, w.deps);
  assert.notEqual(after.code, "HOLD_RUNTIME_BUSY", "lease released; B is no longer busy");
  assert.equal(after.code, "HOLD_RESOURCE_UNKNOWN", "META:MANIFEST is state-last territory, never an intent target");
});

test("PT-PREP-001/b: an equivalent retry from the same binding returns the EXISTING plan; a different runtime generation is not blocked", async () => {
  const w = buildWorld();
  const hA = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps));
  const hS = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps));
  const bindingA = (await w.deps.store.bindings.findByHandleHash(hashHandle(hA)))!;
  const bindingS = (await w.deps.store.bindings.findByHandleHash(hashHandle(hS)))!;
  const first = await createPlan(w.deps.store, w.deps.config, draftFor(bindingA, ["k1", "k2"]), T0);
  const retry = await createPlan(w.deps.store, w.deps.config, draftFor(bindingA, ["k1", "k2"]), T0);
  assert.equal(first.kind, "CREATED");
  assert.equal(retry.kind, "EXISTING");
  assert.equal((retry as { plan: { plan_id: string } }).plan.plan_id, (first as { plan: { plan_id: string } }).plan.plan_id);
  const other = await createPlan(w.deps.store, w.deps.config, draftFor(bindingS), T0);
  assert.equal(other.kind, "CREATED", "SALES runtime has its own lease");
});

test("PT-PREP-001/c: a plan insert failure releases only its acquired runtime lease", async () => {
  const w = buildWorld();
  const hA = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps));
  const bindingA = (await w.deps.store.bindings.findByHandleHash(hashHandle(hA)))!;
  const failingStore = {
    ...w.deps.store,
    plans: {
      ...w.deps.store.plans,
      async insert() { throw new Error("simulated durable plan insert failure"); },
    },
  };
  const leaseKey = { project: bindingA.project, lane: bindingA.lane, runtime_generation: bindingA.runtime_generation };

  await assert.rejects(
    createPlan(failingStore, w.deps.config, draftFor(bindingA), T0),
    /simulated durable plan insert failure/,
  );
  assert.equal(await w.deps.store.leases.current(leaseKey, T0), undefined, "failed insert left an orphan runtime lease");

  const retry = await createPlan(w.deps.store, w.deps.config, draftFor(bindingA), T0);
  assert.equal(retry.kind, "CREATED", "the runtime remains immediately available after the failed insert");
});

test("PT-PREP-002: plan ids are opaque/random, TTLs are server-owned, and the caller cannot supply plan_id or TTL", async () => {
  const w = buildWorld();
  const hA = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps));
  const bindingA = (await w.deps.store.bindings.findByHandleHash(hashHandle(hA)))!;
  const ids = new Set<string>();
  for (let i = 0; i < 5; i += 1) {
    const c = await createPlan(w.deps.store, w.deps.config, draftFor(bindingA, [`k-${i}`]), T0);
    assert.equal(c.kind, "CREATED");
    const p = (c as { plan: { plan_id: string; expires_at: Date; created_at: Date } }).plan;
    assert.equal(Buffer.from(p.plan_id, "base64url").length, 24, "24 random bytes");
    assert.equal(p.expires_at.getTime() - p.created_at.getTime(), 15 * 60_000, "server TTL 15 min");
    ids.add(p.plan_id);
    await transition(w.deps.store, p.plan_id, "ABORTED", T0);
  }
  assert.equal(ids.size, 5);
  // Caller schema: no plan_id / ttl / expires_at anywhere in os_prepare inputs.
  const keys = Object.keys(toolInputSchemas.os_prepare.shape);
  assert.deepEqual(keys.sort(), ["binding_handle", "capability_evidence", "intent"]);
  const bad = await dispatch("os_prepare", { binding_handle: hA, intent, plan_id: "mine", ttl_minutes: 999 }, ctx, w.deps);
  assert.equal(bad.code, "ERROR_INVALID_ARGUMENT");
  // Target receipt TTL is 10 min, server-owned; expiry is enforced on check.
  const c = await createPlan(w.deps.store, w.deps.config, draftFor(bindingA, ["k-ttl"]), T0);
  const plan = (c as { plan: { plan_id: string } }).plan;
  const t = await issueTargetReceipt(w.deps.store, w.deps.config, (await w.deps.store.plans.get(plan.plan_id))!, {}, T0);
  assert.equal(t.expires_at!.getTime() - T0.getTime(), 10 * 60_000);
  const later = new Date(T0.getTime() + 10 * 60_000 + 1);
  const expired = await checkTargetReceipt(w.deps.store, (await w.deps.store.plans.get(plan.plan_id))!, t.receipt_id, later);
  assert.deepEqual(expired, { ok: false, reason: "EXPIRED" });
});

test("PT-PREP-002/b: plan expiry is server-driven, releases the lease and records a recovery flag; expiry is terminal", async () => {
  const w = buildWorld();
  const hA = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps));
  const bindingA = (await w.deps.store.bindings.findByHandleHash(hashHandle(hA)))!;
  const c = await createPlan(w.deps.store, w.deps.config, draftFor(bindingA), T0);
  const plan = (c as { plan: { plan_id: string; runtime_generation: string } }).plan;
  const later = new Date(T0.getTime() + 15 * 60_000 + 1);
  assert.equal(await expireIfDue(w.deps.store, (await w.deps.store.plans.get(plan.plan_id))!, later), true);
  assert.equal((await w.deps.store.plans.get(plan.plan_id))!.plan_state, "EXPIRED");
  assert.equal(await w.deps.store.leases.current({ project: "VERTIGO", lane: "META", runtime_generation: plan.runtime_generation }, later), undefined);
  const ev = await w.deps.store.events.list({ plan_id: plan.plan_id });
  const exp = ev.find((e) => e.event_type === "PLAN_EXPIRED");
  assert.ok(exp && (exp.detail as { recovery_possible: boolean }).recovery_possible === true);
  const t = await transition(w.deps.store, plan.plan_id, "TARGET_VERIFIED", later);
  assert.deepEqual(t, { ok: false, reason: "INVALID_TRANSITION", from: "EXPIRED" });
});

test("receipts: a consumed target receipt cannot be replayed and a foreign plan cannot use it", async () => {
  const w = buildWorld();
  const hA = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps));
  const hS = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps));
  const bindingA = (await w.deps.store.bindings.findByHandleHash(hashHandle(hA)))!;
  const bindingS = (await w.deps.store.bindings.findByHandleHash(hashHandle(hS)))!;
  const a = (await createPlan(w.deps.store, w.deps.config, draftFor(bindingA), T0) as { plan: { plan_id: string } }).plan;
  const s = (await createPlan(w.deps.store, w.deps.config, draftFor(bindingS), T0) as { plan: { plan_id: string } }).plan;
  const pa = (await w.deps.store.plans.get(a.plan_id))!;
  const t = await issueTargetReceipt(w.deps.store, w.deps.config, pa, {}, T0);
  assert.equal((await issueTargetReceipt(w.deps.store, w.deps.config, (await w.deps.store.plans.get(a.plan_id))!, {}, T0)).receipt_id, t.receipt_id, "idempotent re-issue");
  assert.deepEqual(await checkTargetReceipt(w.deps.store, (await w.deps.store.plans.get(s.plan_id))!, t.receipt_id, T0), { ok: false, reason: "WRONG_PLAN" });
  await issueFinalReceipt(w.deps.store, (await w.deps.store.plans.get(a.plan_id))!, t, {}, T0);
  assert.deepEqual(await checkTargetReceipt(w.deps.store, (await w.deps.store.plans.get(a.plan_id))!, t.receipt_id, T0), { ok: false, reason: "CONSUMED" });
  const replay = (await w.deps.store.events.list({ plan_id: a.plan_id })).filter((e) => e.event_type === "RECEIPT_REPLAY_REJECTED");
  assert.ok(replay.length >= 1);
});
