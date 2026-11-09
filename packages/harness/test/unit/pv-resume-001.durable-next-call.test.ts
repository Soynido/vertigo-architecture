/**
 * PV-RESUME-001 — a resume that asks the seller a question advertises no next tool call.
 *
 * This pins a property an earlier revision of this very fix broke. The black-box divergence (2026-09-19, chats
 * 6aaeb127 / 6aaeb260) showed one chat doing three minutes of unrecorded work after a correct resume, and the
 * tempting repair was to make the business RESUMED envelope name `permitted_tool_call: "os_prepare"` so the model
 * had a machine-actionable next step. That is wrong: a healthy resume normally carries an `ask`, and its own
 * `safe_action` can read "Ask the first frame question". Naming a tool on that envelope contradicts the action it
 * ships with and pressures a model to invent a mutation in order to comply — the "narrative VERIFIED" failure the
 * threat model names. The next event there is the human's answer, so the field stays absent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../../src/tools/handlers.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import { handleOf, OWNER, T0 } from "./binding-fixtures.ts";
import { buildResumeWorld } from "./resume-fixtures.ts";

const ctx = { principal_id: OWNER.principal_id, now: T0 };

async function resume(lane: "META" | "SALES"): Promise<{ world: ReturnType<typeof buildResumeWorld>; envelope: Envelope }> {
  const world = buildResumeWorld();
  const h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane }, ctx, world.deps));
  return { world, envelope: await dispatch("os_resume", { binding_handle: h }, ctx, world.deps) };
}

test("PV-RESUME-001: a resume whose turn is a question never advertises a tool as the next step", async () => {
  for (const lane of ["META", "SALES"] as const) {
    const { envelope } = await resume(lane);
    assert.equal(envelope.code, "RESUMED", `${lane}: ${JSON.stringify(envelope)}`);
    assert.notEqual(envelope.ask, undefined, `${lane}: this fixture's resume is expected to ask the seller something`);
    assert.equal(envelope.next.permitted_tool_call, undefined, `${lane}: the next event is the human's answer, not a tool call`);
    // The human-readable action stays authoritative and can itself be "ask": nothing may contradict it.
    assert.equal(typeof envelope.next.safe_action, "string");
    assert.ok((envelope.next.safe_action as string).length > 0);
  }
});

test("PV-RESUME-001/b: a resume stays a pure read — it opens no plan and writes nothing", async () => {
  const { world, envelope } = await resume("SALES");
  assert.equal(envelope.code, "RESUMED");
  const before = JSON.stringify([...world.map.entries()].sort(([a], [b]) => a.localeCompare(b)));
  await dispatch("os_resume", { binding_handle: handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, world.deps)) }, ctx, world.deps);
  assert.equal(JSON.stringify([...world.map.entries()].sort(([a], [b]) => a.localeCompare(b))), before, "os_resume is a read");
  assert.equal((await world.deps.store.plans.findActive("VERTIGO", "SALES", "g1")).length, 0, "resuming opens no plan");
});
