/**
 * GTM-W03 world B — meeting episodes (PT-GTM-006..007). Fixture availability only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGtmWorld, OBSERVED_AT, R_TEST, WEEK_W, withCanceledEpisode, withHeldEpisode } from "./world.ts";
import { episodeIdentity, episodeStatuses, isUnavailable, meetingCounts, metricDef, MEETING_STATUS_LADDER } from "./oracle.ts";

const w = buildGtmWorld();
const scope = { runtime_key: R_TEST, period: WEEK_W, observed_at: OBSERVED_AT, dataset: "O2" } as const;

test("PT-GTM-006 fixture: one agreed and booked episode, one bare proposal, one internal block", () => {
  const counts = meetingCounts(w, scope);
  assert.ok(!isUnavailable(counts));
  assert.deepEqual(
    { historical: counts.historical_bookings, active: counts.active_bookings, held: counts.held, qualified: counts.qualified },
    { historical: 1, active: 1, held: 0, qualified: 0 },
  );
  assert.deepEqual(counts.counted_episodes, ["EP-M01"], "neither the proposal nor the internal block is counted");
});

test("PT-GTM-006 fixture: cancellation, then a held meeting without a pinned qualification definition", () => {
  const canceled = meetingCounts(withCanceledEpisode(w, "EP-M01"), scope);
  assert.ok(!isUnavailable(canceled));
  assert.equal(canceled.historical_bookings, 1, "the booking creation stays a historical fact");
  assert.equal(canceled.active_bookings, 0);

  const held = meetingCounts(withHeldEpisode(w, "EP-M01", "2026-09-19T10:30:00+02:00"), scope);
  assert.ok(!isUnavailable(held));
  assert.equal(held.held, 1);
  assert.equal(held.qualified, "NOT_COMPUTABLE");
  assert.equal(metricDef(w, "qualified_discovery_meetings"), undefined, "no pinned qualified-discovery definition exists");
  assert.match(held.qualified_reason, /no pinned qualified-discovery definition/);
});

test("PT-GTM-007 fixture: one stable episode across two reschedules, five distinct ladder rungs", () => {
  const identity = episodeIdentity(w, R_TEST, "EP-M01");
  assert.deepEqual(identity?.provider_event_keys, ["EVT-M01-1", "EVT-M01-2", "EVT-M01-3"]);
  assert.equal(identity?.reschedule_count, 2);
  assert.equal(new Set(w.provider_events.filter((e) => e.meeting_episode_id === "EP-M01").map((e) => e.meeting_episode_id)).size, 1);

  assert.equal(new Set(MEETING_STATUS_LADDER).size, MEETING_STATUS_LADDER.length);
  assert.deepEqual(episodeStatuses(w, R_TEST, "EP-M01"), ["PROPOSED", "ACCEPTED", "BOOKED"]);
  assert.deepEqual(episodeStatuses(w, R_TEST, "EP-M02"), ["PROPOSED"]);
  const afterCancel = withCanceledEpisode(w, "EP-M01");
  assert.deepEqual(episodeStatuses(afterCancel, R_TEST, "EP-M01"), ["PROPOSED", "ACCEPTED", "BOOKED"], "cancellation never rewrites history");
  assert.equal(afterCancel.episodes.find((e) => e.meeting_episode_id === "EP-M01")?.canceled_at !== null, true);
});
