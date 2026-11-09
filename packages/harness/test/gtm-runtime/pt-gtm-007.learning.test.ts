/**
 * PT-GTM-007 — learning and comparison (PV-GTM-002). Evidence candidates only: no PT case is marked PASS here.
 *
 * A: two approaches that disagree across criteria produce per-criterion results and no global winner.
 * B: confounds are exposed and a replication is proposed.
 * C: volume of activity never ranks people.
 * D: a confirmed offer is not a validated strategy, and an insufficient sample stays bounded.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../../src/tools/handlers.ts";
import { approachViews, compareApproaches, MIN_ARM_SAMPLE } from "../../src/gtm/semantics.ts";
import { handleOf } from "../unit/binding-fixtures.ts";
import { buildGtmRuntimeWorld } from "./world.ts";
import { OWNER_CTX } from "./drive.ts";

const ARM_A = { arm_key: "AP-A", replies: 10, positive_replies: 2, bookings: 1, messages_sent: 120, confounds: ["different industries", "different weeks"] };
const ARM_B = { arm_key: "AP-B", replies: 6, positive_replies: 4, bookings: 3, messages_sent: 110, confounds: ["different weeks"] };

test("PT-GTM-007/A: criteria are reported one by one and no global winner is declared", () => {
  const result = compareApproaches([ARM_A, ARM_B]);
  assert.deepEqual(result.per_criterion.map((c) => [c.criterion, c.leader]), [
    ["replies", "AP-A"],
    ["positive_replies", "AP-B"],
    ["bookings", "AP-B"],
  ]);
  assert.equal(result.global_winner, "NOT_DECIDABLE");
  assert.match(result.reason, /a single winner would be an invention/);
  assert.equal(result.per_criterion[0]?.values["AP-A"], 10);
});

test("PT-GTM-007/B: confounds are exposed and a replication is proposed", () => {
  const result = compareApproaches([ARM_A, ARM_B]);
  assert.deepEqual(result.confounds, ["different industries", "different weeks"]);
  assert.match(result.replication_proposal, /replicate on a comparable, pre-declared sample/);
  assert.equal(result.sample_sufficient, true);
});

test("PT-GTM-007/C: volume of activity never ranks people", () => {
  const busy = compareApproaches([
    { ...ARM_A, arm_key: "REP-1", messages_sent: 300, replies: 3, positive_replies: 1, bookings: 0 },
    { ...ARM_B, arm_key: "REP-2", messages_sent: 30, replies: 3, positive_replies: 1, bookings: 0 },
  ]);
  assert.equal(busy.ranks_people, false);
  assert.equal(busy.global_winner, "NOT_DECIDABLE");
  assert.deepEqual(busy.per_criterion.map((c) => c.leader), ["TIE", "TIE", "TIE"], "equal outcomes stay equal whatever the volume");

  // The learning rules say the same thing, and grouping keeps each owner and runtime on its own participation.
  const views = approachViews([
    { participation_key: "PART-1", approach_version_key: "AP-1/v1", approach_key: "AP-1", owner_rep: "rep-1", runtime_id: "RT-1" },
    { participation_key: "PART-2", approach_version_key: "AP-1/v1", approach_key: "AP-1", owner_rep: "rep-2", runtime_id: "RT-2" },
  ]);
  assert.deepEqual(views.by_approach[0]?.participations.map((p) => p.owner_rep), ["rep-1", "rep-2"]);
});

test("PT-GTM-007/D: a confirmed offer is not a validated strategy and a small sample stays bounded", async () => {
  const small = compareApproaches([{ ...ARM_A, messages_sent: MIN_ARM_SAMPLE - 1 }, ARM_B]);
  assert.equal(small.sample_sufficient, false, "below the pre-declared sample no arm is called better");

  const w = buildGtmRuntimeWorld();
  const handle = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, OWNER_CTX, w.deps));
  const envelope = await dispatch("os_resume", { binding_handle: handle, topic_hint: "META_GTM_ANALYSIS" }, OWNER_CTX, w.deps);
  const payload = (envelope.status === "OK" ? (envelope as { result: Record<string, unknown> }).result : envelope.observations) as Record<string, unknown>;
  const rules = (payload["gtm_analysis"] as { learning_rules: string[] }).learning_rules;
  assert.ok(rules.some((r) => /a confirmed offer is a configuration fact, never a validated strategy/.test(r)));
  assert.ok(rules.some((r) => new RegExp("no arm is called better below a pre-declared sample of " + String(MIN_ARM_SAMPLE)).test(r)));
  assert.ok(rules.some((r) => /never pooled into a ranking of people/.test(r)));
});
