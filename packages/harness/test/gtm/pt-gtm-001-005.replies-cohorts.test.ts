/**
 * GTM-W03 world A — replies, eligibility, attribution and the two denominators (PT-GTM-001..005).
 * Fixture availability only: these assertions describe the fixture and its oracle, never a PT-GTM verdict.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGtmWorld, OBSERVED_AT, OBSERVED_TOO_EARLY, R_TEST, WEEK_NEXT, WEEK_PREV, WEEK_W, withCoverageGap, withoutMetricHorizon } from "./world.ts";
import { attributeReply, dispositionsInPeriod, entryCohort, followUpContacts, isUnavailable, messageOf, weeklyRepliedProspects } from "./oracle.ts";

const w = buildGtmWorld();
const scope = { runtime_key: R_TEST, period: WEEK_W, observed_at: OBSERVED_AT } as const;

test("PT-GTM-001 fixture: the weekly metric computes 3 replied prospects and 5 eligible reply messages", () => {
  const m = weeklyRepliedProspects(w, scope);
  assert.ok(!isUnavailable(m));
  assert.deepEqual(m.contacts, ["C01", "C05", "C09"]);
  assert.equal(m.value, 3);
  assert.equal(m.eligible_human_reply_messages, 5);
  assert.equal(m.production_target_state, "TARGET_NOT_SET", "the production target is never set from a fixture threshold");
  assert.equal(m.fixture_threshold, 2);
});

test("PT-GTM-002 fixture: half-open Paris weeks, explicit horizons, maturity and coverage", () => {
  assert.equal(messageOf(w, R_TEST, "IN-C05")?.occurred_at, WEEK_W.start, "the lower bound belongs to W");
  assert.equal(messageOf(w, R_TEST, "IN-C13")?.occurred_at, WEEK_W.end, "the upper bound does not");
  const next = weeklyRepliedProspects(w, { runtime_key: R_TEST, period: WEEK_NEXT, observed_at: "2026-10-05T09:00:00+02:00" });
  assert.ok(!isUnavailable(next));
  assert.deepEqual(next.contacts, ["C13"]);

  const early = weeklyRepliedProspects(w, { runtime_key: R_TEST, period: WEEK_W, observed_at: OBSERVED_TOO_EARLY });
  assert.equal(early.state, "INCONCLUSIVE");
  const noHorizon = weeklyRepliedProspects(withoutMetricHorizon(w, "weekly_replied_prospects"), scope);
  assert.equal(noHorizon.state, "NOT_COMPUTABLE");
  assert.match((noHorizon as { reason: string }).reason, /observation horizon/);
  const prev = weeklyRepliedProspects(w, { runtime_key: R_TEST, period: WEEK_PREV, observed_at: OBSERVED_AT });
  assert.ok(!isUnavailable(prev));
  assert.deepEqual(prev.contacts, [], "no reply landed in the previous week");
});

test("PT-GTM-003 fixture: every reply disposition of W, one line per inbound row", () => {
  const rows = dispositionsInPeriod(w, scope).map((d) => [d.message_key, d.disposition]);
  assert.deepEqual(rows, [
    ["IN-C01-1", "ELIGIBLE_HUMAN_REPLY"], ["IN-C01-1-DUP", "DUPLICATE_DELIVERY"], ["IN-C01-2", "ELIGIBLE_HUMAN_REPLY"],
    ["IN-C01-3", "ELIGIBLE_HUMAN_REPLY"], ["IN-C02", "TECHNICAL_AUTOREPLY"], ["IN-C03", "OPT_OUT"],
    ["IN-C04", "NOT_ATTRIBUTED"], ["IN-C05", "ELIGIBLE_HUMAN_REPLY"], ["IN-C06", "INTERNAL_COUNTERPART"],
    ["IN-C07", "UNKNOWN_KIND_TAKEOVER"], ["IN-C08", "PERMANENT_BOUNCE"], ["IN-C09", "ELIGIBLE_HUMAN_REPLY"],
    ["IN-C12", "NOT_ATTRIBUTED"],
  ]);
  assert.deepEqual(followUpContacts(w, scope, "OPT_OUT"), ["C03"]);
  assert.deepEqual(followUpContacts(w, scope, "PERMANENT_BOUNCE"), ["C08"]);
  assert.deepEqual(followUpContacts(w, scope, "UNKNOWN_KIND_TAKEOVER"), ["C07"]);
  assert.equal(w.contacts.find((c) => c.contact_key === "C08")?.address_stopped, true);
  assert.equal(w.contacts.find((c) => c.contact_key === "C03")?.opted_out, true);
});

test("PT-GTM-004 fixture: proof-first attribution preserves candidates and never promotes the last touch", () => {
  const ambiguous = attributeReply(w, messageOf(w, R_TEST, "IN-C12") as never);
  assert.equal(ambiguous.status, "UNATTRIBUTED");
  assert.equal(ambiguous.attributed_to, null);
  assert.deepEqual(ambiguous.candidates.map((c) => c.message_key), ["OUT-C12-A", "OUT-C12-B"]);
  assert.deepEqual([...new Set(ambiguous.candidates.map((c) => c.campaign_key))], ["CMP-3", "CMP-2"]);

  const unknown = attributeReply(w, messageOf(w, R_TEST, "IN-C04") as never);
  assert.equal(unknown.status, "UNKNOWN");
  assert.deepEqual(unknown.candidates, []);

  const attributed = attributeReply(w, messageOf(w, R_TEST, "IN-C09") as never);
  assert.equal(attributed.status, "ATTRIBUTED");
  assert.equal(attributed.attributed_to?.message_key, "OUT-C09");
  assert.equal(attributed.attributed_to?.participation_key, "PART-R1-A1V2");
});

test("PT-GTM-005 fixture: the entry cohort denominator is 7 and never merges with the weekly repliers", () => {
  const c = entryCohort(w, scope);
  assert.ok(!isUnavailable(c));
  assert.deepEqual(c.entrants, ["C01", "C02", "C03", "C07", "C08", "C09", "C10"]);
  assert.deepEqual(c.replied_entrants, ["C01", "C09"]);
  assert.equal(c.rate_label, "2/7");
  assert.notEqual(c.rate_label, "3/7");
  assert.deepEqual(c.period_repliers_outside_cohort, ["C05"]);

  const gapped = withCoverageGap(w, "COV-MBX-R_TEST");
  assert.equal(weeklyRepliedProspects(gapped, scope).state, "NOT_COMPUTABLE");
  assert.equal(entryCohort(gapped, scope).state, "NOT_COMPUTABLE");
  assert.match((weeklyRepliedProspects(gapped, scope) as { reason: string }).reason, /coverage/);
});
