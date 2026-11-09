/**
 * PT-PRO-003 backend criterion (PV0-020E) — the adjudication reads the backend, not the chat. A lane whose answer
 * message carries no apps never reaches os_prepare, so the runtime must show: no plan (active or historical), no
 * mutation lease, no receipt, and an event trail containing nothing but the bind. This pins exactly what the
 * independent lane is adjudicated on. The cold-chat half is run by the independent lane; nothing here adjudicates it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../../src/tools/handlers.ts";
import { hashHandle } from "../../src/binding/handle.ts";
import { leaseKeyOf } from "../../src/plans/service.ts";
import { handleOf, OWNER, T0 } from "./binding-fixtures.ts";
import { buildResumeWorld } from "./resume-fixtures.ts";

const ctx = { principal_id: OWNER.principal_id, now: T0 };

test("PT-PRO-003/backend: bind + resume only ⇒ zero plan, zero lease, zero receipt, and only BIND_CREATED in the trail", async () => {
  const w = buildResumeWorld();
  const bound = await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps);
  assert.equal(bound.code, "BOUND");
  const h = handleOf(bound);
  const binding = (await w.deps.store.bindings.findByHandleHash(hashHandle(h)))!;
  const resumed = await dispatch("os_resume", { binding_handle: h }, ctx, w.deps);
  assert.equal(resumed.code, "RESUMED");
  // The step is still open and the question is still asked: nothing was consumed by a tool-less answer.
  assert.equal((resumed.result as { gate: { status: string } }).gate.status, "OPEN");
  assert.ok(resumed.ask, "the step still asks its question");
  // Backend criterion read by the adjudicator.
  assert.equal((await w.deps.store.plans.findActive("VERTIGO", "META", binding.runtime_generation)).length, 0, "no active plan");
  assert.equal((await w.deps.store.plans.listByRuntime("VERTIGO", "META", binding.runtime_generation)).length, 0, "no plan at all");
  assert.equal(await w.deps.store.leases.current(leaseKeyOf(binding), T0), undefined, "no mutation lease");
  assert.equal((resumed.result as { open_backend_plan: unknown }).open_backend_plan, "NONE", "and os_resume says so truthfully");
  const events = await w.deps.store.events.list({});
  assert.deepEqual([...new Set(events.map((e) => e.event_type))], ["BIND_CREATED"], JSON.stringify(events.map((e) => e.event_type)));
  assert.equal(events.filter((e) => e.event_type === "PLAN_CREATED" || e.event_type === "TARGET_RECEIPT_ISSUED").length, 0);
});
