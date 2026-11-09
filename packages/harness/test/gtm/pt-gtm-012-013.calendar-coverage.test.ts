/**
 * GTM-W03 world F — D-CAL-01 classification over purely synthetic provider events, plus episode identity,
 * coverage and denominator cases (PT-GTM-012 A–H, PT-GTM-013 A–F). No Calendar source is connected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGtmWorld, OBSERVED_AT, R_TEST, WEEK_W, withCoverageGap } from "./world.ts";
import { calendarReadState, classifyBatch, classifyEvent, distinctEpisodes, episodeStatuses, isUnavailable, linkSignals, meetingCounts, rateOf } from "./oracle.ts";

const w = buildGtmWorld();
const event = (key: string) => w.provider_events.find((e) => e.provider_event_key === key) as never;
const klass = (key: string) => classifyEvent(event(key));

test("PT-GTM-012 fixture: only INTERNAL_ONLY is excluded, and purpose is classified separately", () => {
  const table = ["A", "B", "C", "D", "E", "F", "G", "H"].map((s) => {
    const c = klass(`EVT-CAL-${s}`);
    return [s, c.participation_class, c.purpose_class, c.excluded];
  });
  assert.deepEqual(table, [
    ["A", "INTERNAL_ONLY", "PURPOSE_UNKNOWN", true],
    ["B", "EXTERNAL_CANDIDATE", "EXTERNAL_COMMERCIAL", false],
    ["C", "EXTERNAL_CANDIDATE", "EXTERNAL_COMMERCIAL", false],
    ["D", "INTERNAL_ONLY", "PURPOSE_UNKNOWN", true],
    ["E", "INTERNAL_ONLY", "PURPOSE_UNKNOWN", true],
    ["F", "UNKNOWN", "PURPOSE_UNKNOWN", false],
    ["G", "EXTERNAL_CANDIDATE", "EXTERNAL_OTHER", false],
    ["H", "INTERNAL_ONLY", "PURPOSE_UNKNOWN", true],
  ]);
  assert.equal(klass("EVT-CAL-B").participation_class, "EXTERNAL_CANDIDATE", "a VERTIGO participant never excludes an event");
  assert.match(klass("EVT-CAL-E").reason, /bot or a room/);
  assert.match(klass("EVT-CAL-F").reason, /masked or truncated/);
});

test("PT-GTM-012 fixture: the calendar allowlist and the event classification are separate questions", () => {
  const allowlisted = calendarReadState(w, R_TEST, true);
  const denied = calendarReadState(w, R_TEST, false);
  assert.equal(allowlisted.source_connected, false, "W03 connects no Calendar source");
  assert.equal(allowlisted.readable, false);
  assert.equal(denied.readable, false);
  assert.deepEqual(klass("EVT-CAL-B"), classifyEvent(event("EVT-CAL-B")), "classification does not depend on the allowlist");
});

test("PT-GTM-013 fixture: one episode across agendas and threads, occurrences versus reschedules", () => {
  assert.equal(new Set(w.provider_events.filter((e) => e.meeting_episode_id === "EP-CAL-MULTI").map((e) => e.meeting_episode_id)).size, 1);
  assert.equal([...new Set(w.provider_events.filter((e) => e.series_key === "SER-1").map((e) => e.meeting_episode_id))].length, 3);
  assert.equal([...new Set(w.provider_events.filter((e) => e.reschedule_of !== null).map((e) => e.meeting_episode_id))].length, 1);
  assert.deepEqual(distinctEpisodes(w, R_TEST, "O2"), ["EP-F01", "EP-M01"]);

  assert.deepEqual(episodeStatuses(w, R_TEST, "EP-CAL-CANCEL"), ["PROPOSED", "ACCEPTED", "BOOKED"]);
  assert.notEqual(w.episodes.find((e) => e.meeting_episode_id === "EP-CAL-CANCEL")?.canceled_at, null);
  assert.deepEqual(episodeStatuses(w, R_TEST, "EP-CAL-UNACCEPTED"), ["PROPOSED"], "an unaccepted invitation was never booked");
});

test("PT-GTM-013 fixture: a crashed classification pass resumes without duplicating or diverging", () => {
  const events = w.provider_events.filter((e) => e.dataset === "CAL");
  const full = classifyBatch(events);
  const crashed = classifyBatch(events, null, 4);
  assert.equal(crashed.processed.length, 4);
  const resumed = classifyBatch(events, crashed, null);
  assert.deepEqual(resumed.processed, full.processed);
  assert.equal(new Set(resumed.processed.map((p) => p.provider_event_key)).size, resumed.processed.length);
});

test("PT-GTM-013 fixture: revoked coverage withholds counts, duplicate opens collapse, units never mix", () => {
  const revoked = withCoverageGap(w, "COV-EVT-R_TEST", "REVOKED");
  const counts = meetingCounts(revoked, { runtime_key: R_TEST, period: WEEK_W, observed_at: OBSERVED_AT, dataset: "O2" });
  assert.equal(counts.state, "NOT_COMPUTABLE");
  assert.ok(isUnavailable(counts) && /REVOKED/.test(counts.reason));
  assert.equal(classifyEvent(event("EVT-CAL-B")).participation_class, "EXTERNAL_CANDIDATE", "classification survives a coverage gap; counting does not");

  assert.equal(linkSignals(w, R_TEST, "OUT-C09").read_events, 2);
  assert.equal(linkSignals(w, R_TEST, "OUT-C09").distinct_reads, 1);
  assert.equal(w.coverage.find((c) => c.coverage_key === "COV-TRK-R_TEST")?.state, "PARTIAL");
  assert.equal(rateOf({ value: 3, unit: "CONTACTS" }, { value: 1, unit: "DISTINCT_READS" }).state, "NOT_COMPUTABLE");
});
