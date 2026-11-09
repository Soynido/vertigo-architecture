/**
 * PT-GTM-005 — meetings and episodes, through the real six-tool protocol (PV-GTM-002).
 * Evidence candidates only: no PT case is marked PASS here.
 *
 * A: a positive reply is not a booking.
 * B: the exact O2 figures of the frozen W03 world, recomputed by the shared counters.
 * C: held and qualified need a pinned definition and their own proof.
 * D: a proposal, a booking, a task or a focus never creates a won deal or revenue.
 * E: several contacts on one meeting do not create several episodes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { meetingCounters, type EpisodeEvidence } from "../../src/gtm/semantics.ts";
import { buildGtmRuntimeWorld, G } from "./world.ts";
import { bindRep, commit, evidenceOf, exposureIntent, gtmIntent, prepare } from "./drive.ts";

const AGREED = {
  "Episode Kind": "PROSPECT", Contact: "C09", Company: "CO-01", "Meeting Status": "BOOKED",
  "Agreement Evidence Ref": "EV-AGREE-C09", "Proposed At": "2026-09-16T11:00:00+02:00",
  "Accepted At": "2026-09-16T15:00:00+02:00", "Booked At": "2026-09-16T15:05:00+02:00",
  "Provider Event Refs": "EVT-M01-1",
} as const;

const episode = (over: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({ ...AGREED, ...over });

const evidence = (over: Partial<EpisodeEvidence> = {}): EpisodeEvidence => ({
  meeting_episode_id: "EP-M01", proposed_at: "2026-09-16T11:00:00+02:00", accepted_at: "2026-09-16T15:00:00+02:00",
  agreement_evidence_ref: "EV-AGREE-C09", booked_at: "2026-09-16T15:05:00+02:00", held_at: null, held_evidence_ref: null,
  qualified_at: null, canceled_at: null, episode_kind: "PROSPECT", ...over,
});

test("PT-GTM-005/A: a positive reply is not a booking", async () => {
  const w = buildGtmRuntimeWorld();
  const h = await bindRep(w);
  await commit(w, h, exposureIntent({ key: "EXP-C09", contact: "C09", message_ref: "MSG-C09" }));
  await commit(w, h, gtmIntent("SALES:REPLY_ATTRIBUTIONS", "RA-C09", {
    "Reply Ref": "IN-C09", Contact: "C09", "Identity Resolution": "CANONICAL", "Reply At": "2026-09-16T15:00:00+02:00",
    "In Reply To": "MSG-C09", "Prior Touches": "MSG-C09|CMP-1|AP-1/v1|PART-1|2026-09-14T09:00:00+02:00",
    "Attribution Status": "ATTRIBUTED", "Attributed To": "MSG-C09", Candidates: "MSG-C09",
    Disposition: "ELIGIBLE_HUMAN_REPLY", "Counts As Reply": "true", "Reply Kind": "HUMAN", "Reply Intent": "POSITIVE",
    Party: "EXTERNAL_PROSPECT",
  }));
  // The positive reply exists; a booking claimed on its strength alone is refused.
  const claimed = await prepare(w, h, gtmIntent("SALES:MEETING_EPISODES", "EP-M01", episode({ "Accepted At": "", "Agreement Evidence Ref": "", "Booked At": "" })));
  assert.equal(claimed.envelope.code, "HOLD_GTM_CONTRACT_VIOLATION", JSON.stringify(claimed.envelope));
  assert.match(evidenceOf(claimed.envelope), /Meeting Status BOOKED is not reached by the evidence/);
  assert.equal(w.rows(G.episodesDs).length, 0);

  // With an explicit, evidenced agreement it is accepted.
  await commit(w, h, gtmIntent("SALES:MEETING_EPISODES", "EP-M01", episode()));
  assert.equal(w.rows(G.episodesDs).length, 1);
});

test("PT-GTM-005/B: the exact O2 figures are produced by the shared counters", () => {
  const m01 = evidence();
  const m02 = evidence({ meeting_episode_id: "EP-M02", accepted_at: null, agreement_evidence_ref: null, booked_at: null });
  const internal = evidence({ meeting_episode_id: "EP-F01", episode_kind: "INTERNAL" });
  const counters = meetingCounters([m01, m02, internal]);
  assert.deepEqual(
    { historical: counters.historical_bookings, active: counters.active_bookings, held: counters.held, qualified: counters.qualified },
    { historical: 1, active: 1, held: 0, qualified: 0 },
  );
  assert.deepEqual(counters.counted_episodes, ["EP-M01"], "the proposal and the internal block are not bookings");

  const canceled = meetingCounters([evidence({ canceled_at: "2026-09-17T18:00:00+02:00" }), m02, internal]);
  assert.equal(canceled.historical_bookings, 1, "the booking creation stays historical");
  assert.equal(canceled.active_bookings, 0);
  assert.equal(canceled.revenue, "NOT_APPLICABLE");
});

test("PT-GTM-005/C: held needs its own proof and qualified needs a pinned definition", async () => {
  const w = buildGtmRuntimeWorld();
  const h = await bindRep(w);
  await commit(w, h, gtmIntent("SALES:MEETING_EPISODES", "EP-M01", episode()));

  const heldWithoutProof = await prepare(w, h, gtmIntent("SALES:MEETING_EPISODES", "EP-M01", episode({ "Meeting Status": "HELD", "Held At": "2026-09-22T10:30:00+02:00" }), "UPDATE"));
  assert.equal(heldWithoutProof.envelope.code, "HOLD_GTM_CONTRACT_VIOLATION");
  assert.match(evidenceOf(heldWithoutProof.envelope), /Meeting Status HELD is not reached by the evidence/);

  const qualified = await prepare(w, h, gtmIntent("SALES:MEETING_EPISODES", "EP-M01", episode({
    "Meeting Status": "QUALIFIED_DISCOVERY", "Held At": "2026-09-22T10:30:00+02:00", "Held Evidence Ref": "EV-HELD-1", "Qualified At": "2026-09-22T11:00:00+02:00",
  }), "UPDATE"));
  assert.equal(qualified.envelope.code, "HOLD_GTM_CONTRACT_VIOLATION");
  assert.match(evidenceOf(qualified.envelope), /no pinned qualified-discovery definition exists/);

  await commit(w, h, gtmIntent("SALES:MEETING_EPISODES", "EP-M01", episode({ "Meeting Status": "HELD", "Held At": "2026-09-22T10:30:00+02:00", "Held Evidence Ref": "EV-HELD-1" }), "UPDATE"));
  const counters = meetingCounters([evidence({ held_at: "2026-09-22T10:30:00+02:00", held_evidence_ref: "EV-HELD-1" })]);
  assert.equal(counters.held, 1);
  assert.equal(counters.qualified, "NOT_COMPUTABLE");
});

test("PT-GTM-005/D: no episode state creates a won deal, revenue or a focus that counts as one", async () => {
  const w = buildGtmRuntimeWorld();
  const h = await bindRep(w);
  const won = await prepare(w, h, gtmIntent("SALES:MEETING_EPISODES", "EP-M01", { ...episode(), Won: "true" }));
  assert.equal(won.envelope.code, "HOLD_SCHEMA_MISMATCH", "the candidate schema has no won or revenue field at all");
  assert.match(evidenceOf(won.envelope), /fields not in "Meeting Episodes" schema: Won/);

  // And no metric of the catalog names revenue, so a snapshot cannot state one either.
  const revenue = await prepare(w, h, gtmIntent("SALES:GTM_SNAPSHOTS", "SNAP-revenue", {
    "Metric Key": "won_revenue", "Period Key": "W-2026-38", "Period Start": "2026-09-14T00:00:00+02:00",
    "Period End": "2026-09-21T00:00:00+02:00", "Observation Cutoff": "2026-09-28T09:00:00+02:00", Scope: "RUNTIME",
    Computability: "COMPUTED", "Input Revision": "IR-x", "Metric Definitions Version": "gtm-metric-definitions/v1",
    "Metric Definitions Digest": "x", "Coverage Refs": "COV-MBX-W38",
  }));
  assert.equal(revenue.envelope.code, "HOLD_GTM_CONTRACT_VIOLATION");
  assert.match(evidenceOf(revenue.envelope), /is not a defined metric/);
});

test("PT-GTM-005/E: several contacts on one meeting stay one stable episode", async () => {
  const w = buildGtmRuntimeWorld();
  const h = await bindRep(w);
  await commit(w, h, gtmIntent("SALES:MEETING_EPISODES", "EP-M01", episode({ Contacts: "C09;C10", "Provider Event Refs": "EVT-M01-1;EVT-M01-2" })));
  const second = await prepare(w, h, gtmIntent("SALES:MEETING_EPISODES", "EP-M01", episode({ Contact: "C10" })));
  assert.equal(second.envelope.code, "HOLD_DUPLICATE", "one episode id is one episode, whatever the number of contacts");
  assert.equal(w.rows(G.episodesDs).length, 1);

  // Two reschedules of the same meeting stay the same episode too.
  await commit(w, h, gtmIntent("SALES:MEETING_EPISODES", "EP-M01", { "Provider Event Refs": "EVT-M01-1;EVT-M01-2;EVT-M01-3" }, "UPDATE"));
  assert.equal(w.rows(G.episodesDs).length, 1);
  const rewrite = await prepare(w, h, gtmIntent("SALES:MEETING_EPISODES", "EP-M01", { "Meeting Episode ID": "EP-RENAMED" }, "UPDATE"));
  assert.equal(rewrite.envelope.code, "HOLD_UNSUPPORTED_OPERATION");
  assert.match(evidenceOf(rewrite.envelope), /control-owned fields cannot be set through os_prepare: Meeting Episode ID/);
});
