/**
 * PT-REC-009 — Concurrent second prepare returns runtime busy (ADVERSARIAL, blocking; required by PV0-009,
 * targeted again under PG6/PV0-016). Precondition: plan A owns the runtime mutation lease.
 * Procedure: from a parallel binding/chat attempt os_prepare plan B on the same runtime generation.
 * Expected: HOLD_RUNTIME_BUSY; plan B does not create stage-1 instructions/Run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../../src/tools/handlers.ts";
import { hashHandle } from "../../src/binding/handle.ts";
import { createPlan } from "../../src/plans/service.ts";
import { buildWorld, handleOf, OWNER, T0 } from "./binding-fixtures.ts";
import { draftFor } from "./plan-fixtures.ts";

const ctx = { principal_id: OWNER.principal_id, now: T0 };
const intent = { action_class: "COMMIT", summary: "parallel", mutations: [{ logical_resource_key: "META:MANIFEST", operation: "UPDATE" as const, record_selector: { natural_key: "CURRENT" }, desired_changes: { a: 1 } }] };

test("PT-REC-009: parallel chat prepare on the same runtime generation is refused with HOLD_RUNTIME_BUSY and produces no plan, instructions or Run", async () => {
  const w = buildWorld();
  const chatA = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps));
  const chatB = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps));
  const bindingA = (await w.deps.store.bindings.findByHandleHash(hashHandle(chatA)))!;
  const a = await createPlan(w.deps.store, w.deps.config, draftFor(bindingA), T0);
  assert.equal(a.kind, "CREATED");
  const gen = (a as { plan: { runtime_generation: string } }).plan.runtime_generation;

  // Several concurrent attempts from chat B.
  const attempts = await Promise.all([1, 2, 3].map(() => dispatch("os_prepare", { binding_handle: chatB, intent }, ctx, w.deps)));
  for (const r of attempts) {
    assert.equal(r.status, "HOLD");
    assert.equal(r.code, "HOLD_RUNTIME_BUSY");
    assert.equal(JSON.stringify(r).includes("stage1"), false, "no stage-1 instructions returned");
  }
  assert.equal((await w.deps.store.plans.findActive("VERTIGO", "META", gen)).length, 1);
  const created = (await w.deps.store.events.list({})).filter((e) => e.event_type === "PLAN_CREATED");
  assert.equal(created.length, 1, "no plan B");

  // Even chat A's own second prepare with a different intent is busy: exactly one active mutating plan per runtime.
  const ownSecond = await dispatch("os_prepare", { binding_handle: chatA, intent: { ...intent, summary: "another" } }, ctx, w.deps);
  assert.equal(ownSecond.code, "HOLD_RUNTIME_BUSY");
});
