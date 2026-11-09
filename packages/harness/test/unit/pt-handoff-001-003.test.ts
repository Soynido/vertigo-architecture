/**
 * PV0-018 — os_handoff: PT-HANDOFF-001 (derived from durable canon), PT-HANDOFF-002 (stale chat NEXT cannot
 * override), PT-HANDOFF-003 (no durable handoff ⇒ HOLD, no invented target).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../../src/tools/handlers.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import { handleOf, OWNER, T0 } from "./binding-fixtures.ts";
import { buildResumeWorld, gateRow, R, runPage } from "./resume-fixtures.ts";

const ctx = { principal_id: OWNER.principal_id, now: T0 };
type Ok = Extract<Envelope, { status: "OK" }>;
type H = { handoff_id: string; source: { current_run: string; gate: string; hold: string; lane: string }; target_lane: string; next_action: string; next_question: string; state_fingerprint: string; terminal_text: string; cross_lane_rule: string };

test("PT-HANDOFF-001: source Run/Gate/HOLD/next action and target lane come from fresh durable state; terminal text matches", async () => {
  const w = buildResumeWorld();
  const h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps));
  const r = await dispatch("os_handoff", { binding_handle: h }, ctx, w.deps);
  assert.equal(r.code, "HANDOFF_READY", JSON.stringify(r));
  const ho = (r as Ok).result as H;
  assert.equal(ho.source.current_run, "TRUN-1 | TRUN-1 (COMPLETED)");
  assert.equal(ho.source.gate, "T1 (OPEN)");
  assert.equal(ho.source.hold, "NONE");
  assert.equal(ho.next_action, "Ask the first frame question", "durable Manifest Next Action");
  assert.equal(ho.target_lane, "META");
  assert.equal(ho.cross_lane_rule, "NONE_IN_GOVERNING_GRAMMAR");
  assert.match(ho.terminal_text, /^HANDOFF — META runtime RT-TEST-01\nCurrent run: TRUN-1 \| TRUN-1 \(COMPLETED\)\nGate: T1 \(OPEN\)\nHold: NONE\n/);
  assert.match(ho.terminal_text, /Next action: Ask the first frame question/);
  assert.match(ho.terminal_text, new RegExp(`State fingerprint: ${ho.state_fingerprint}`));
  assert.equal(r.next.safe_action, ho.next_action);
  // SALES: derived from the OS State cursor.
  const hs = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps));
  const rs = await dispatch("os_handoff", { binding_handle: hs, format_hint: "one_line" }, ctx, w.deps);
  assert.equal(rs.code, "HANDOFF_READY");
  const hos = (rs as Ok).result as H;
  assert.equal(hos.target_lane, "SALES");
  assert.equal(hos.source.gate, "B2_ICP (OPEN)");
  assert.equal(hos.next_action, "Answer the ICP question");
  assert.ok(!hos.terminal_text.includes("\n"), "one_line format hint only changes rendering");
  // A durable recovery hold is still a durable handoff: the handoff IS the recovery action.
  w.setMetaRuns([runPage({ id: R.run2, label: "TRUN-2", status: "HOLD", recovery: true, nextAction: "finish TRUN-2", lastEdited: "2030-01-03T00:00:00.000Z" })]);
  w.setMetaManifest({ lastRunId: R.run2, recovery: true, lastEdited: "2030-01-03T00:00:00.000Z" });
  const rr = await dispatch("os_handoff", { binding_handle: h }, ctx, w.deps);
  assert.equal(rr.code, "HANDOFF_READY");
  const hor = (rr as Ok).result as H;
  assert.equal(hor.source.hold, "HOLD_RECOVERY_REQUIRED");
  assert.match(hor.next_action, /recover run TRUN-2/);
});

test("PT-HANDOFF-002: chat claims cannot override — forbidden next/gate arguments are rejected and a stale handoff loses authority when state changes", async () => {
  const w = buildResumeWorld();
  const h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps));
  for (const extra of [{ next_lane: "SALES" }, { target_lane: "SALES" }, { current_gate: "T9" }, { next: "Ship it" }, { reserved_next: "x" }, { next_action: "Publish" }, { handoff: { target_lane: "SALES" } }, { run_id: "TRUN-9" }]) {
    const r = await dispatch("os_handoff", { binding_handle: h, ...extra }, ctx, w.deps);
    assert.equal(r.code, "ERROR_INVALID_ARGUMENT", JSON.stringify(extra));
  }
  const first = (await dispatch("os_handoff", { binding_handle: h }, ctx, w.deps) as Ok).result as H;
  assert.equal(first.next_action, "Ask the first frame question", "durable state wins over any chat narrative");
  // Durable state changes ⇒ new handoff, different fingerprint; the old one is void.
  w.setMetaManifest({ nextAction: "Confirm the ICP exclusions", lastEdited: "2030-01-03T00:00:00.000Z" });
  const second = (await dispatch("os_handoff", { binding_handle: h }, ctx, w.deps) as Ok).result as H;
  assert.equal(second.next_action, "Confirm the ICP exclusions");
  assert.notEqual(second.state_fingerprint, first.state_fingerprint);
  assert.notEqual(second.handoff_id, first.handoff_id);
  // Unchanged state ⇒ identical fingerprint (deterministic).
  const third = (await dispatch("os_handoff", { binding_handle: h }, ctx, w.deps) as Ok).result as H;
  assert.equal(third.state_fingerprint, second.state_fingerprint);
});

test("PT-HANDOFF-003: no deterministic next lane/action or ambiguous state ⇒ HOLD_NO_DURABLE_HANDOFF with UNKNOWN target, nothing invented", async () => {
  const w = buildResumeWorld();
  const h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps));
  // No Next Action on the Manifest and none on the gate row.
  w.setMetaManifest({ nextAction: "" });
  w.setMetaGates([gateRow({ id: R.gateM1, key: "T1", status: "OPEN" })]);
  const r1 = await dispatch("os_handoff", { binding_handle: h }, ctx, w.deps);
  assert.equal(r1.code, "HOLD_NO_DURABLE_HANDOFF", JSON.stringify(r1));
  assert.equal((r1.observations as { target_lane: string }).target_lane, "UNKNOWN");
  assert.equal((r1.observations as { next_action: string }).next_action, "UNKNOWN");
  assert.match((r1 as { evidence: readonly string[] }).evidence.join("\n"), /nothing is invented|no Next Action/);
  // Ambiguous incomplete Runs.
  const w2 = buildResumeWorld();
  const h2 = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w2.deps));
  w2.setMetaRuns([runPage({ id: R.run2, label: "TRUN-2", status: "RUNNING" }), runPage({ id: R.run3, label: "TRUN-3", status: "HOLD" })]);
  w2.setMetaManifest({ lastRunId: null });
  const r2 = await dispatch("os_handoff", { binding_handle: h2 }, ctx, w2.deps);
  assert.equal(r2.code, "HOLD_NO_DURABLE_HANDOFF", JSON.stringify(r2));
  assert.match((r2 as { evidence: readonly string[] }).evidence.join("\n"), /HOLD_RUN_AMBIGUOUS/);
  assert.equal((r2.observations as { target_lane: string }).target_lane, "UNKNOWN");
});
