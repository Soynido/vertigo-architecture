/**
 * GTM-W03 world C/D — campaigns, approach versions, participations, exposure and company non-additivity
 * (PT-GTM-008..010). Fixture availability only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGtmWorld, OBSERVED_AT, R_ALT, R_TEST, WEEK_W } from "./world.ts";
import { companyAggregate, companyGlobalTotal, eligibleRepliesByApproachVersion, exposureView, isUnavailable, linkSignals, rateOf } from "./oracle.ts";

const w = buildGtmWorld();
const scope = { runtime_key: R_TEST, period: WEEK_W, observed_at: OBSERVED_AT } as const;

test("PT-GTM-008 fixture: two versions of one approach stay separable, one approach across two reps keeps owners", () => {
  assert.deepEqual(eligibleRepliesByApproachVersion(w, scope), { "AP-1/v1": 4, "AP-1/v2": 1 });
  const shared = w.participations.filter((p) => p.approach_version_key === "AP-2/v1");
  assert.deepEqual(shared.map((p) => [p.owner_principal_key, p.runtime_key]), [["CELIA_FIXTURE", R_TEST], ["JULIAN_FIXTURE", R_ALT]]);

  const active = w.enrollments.filter((e) => e.state === "ACTIVE");
  assert.equal(new Set(active.map((e) => e.contact_key)).size, active.length, "at most one ACTIVE enrollment per contact");
  assert.deepEqual(w.enrollments.filter((e) => e.contact_key === "C01").map((e) => [e.campaign_key, e.state]), [["CMP-1", "ENDED"], ["CMP-2", "ACTIVE"]]);
});

test("PT-GTM-009 fixture: configuration is not exposure, and an old pin never moves", () => {
  const pinned = exposureView(w, R_TEST, "EXP-C01");
  assert.equal(pinned?.configured_price_cents, 120000);
  assert.equal(pinned?.communicated_price_cents, 90000);
  assert.equal(pinned?.differs_from_configuration, true);
  assert.notEqual(pinned?.override_evidence, null);
  assert.equal(pinned?.authority_expanded, false);

  const old = exposureView(w, R_TEST, "EXP-C01-OLD");
  assert.equal(old?.communicated_price_cents, 150000, "the old exposure keeps what was communicated then");
  assert.throws(() => {
    (w.exposures.find((e) => e.exposure_key === "EXP-C01-OLD") as unknown as { communicated_price_cents: number }).communicated_price_cents = 1;
  }, TypeError, "a pinned exposure is immutable");

  assert.deepEqual(linkSignals(w, R_TEST, "OUT-C01"), { sent: 1, read_events: 0, distinct_reads: 0 }, "a link sent is not a link read");
  assert.deepEqual(linkSignals(w, R_TEST, "OUT-C09"), { sent: 1, read_events: 2, distinct_reads: 1 }, "two opens by one reader are one read");
});

test("PT-GTM-010 fixture: per-runtime company dimensions, no company-global dedup", () => {
  const own = companyAggregate(w, scope);
  assert.ok(!isUnavailable(own));
  assert.deepEqual({ contacts: own.replied_contacts, companies: own.replied_companies }, { contacts: 3, companies: 2 });

  const global = companyGlobalTotal(w, [R_TEST, R_ALT], WEEK_W, OBSERVED_AT);
  assert.equal(global.state, "NOT_COMPUTABLE");
  assert.ok("overlapping_companies" in global);
  assert.deepEqual(global.overlapping_companies, ["CO-01"]);
  assert.equal(global.disposition, "HOLD");
  assert.deepEqual(global.per_runtime, { R_TEST: 2, R_ALT: 1 }, "the per-runtime figures stay truthful and available");

  assert.equal(rateOf({ value: 2, unit: "CONTACTS" }, { value: 7, unit: "CONTACTS" }).state, "COMPUTED");
  assert.equal(rateOf({ value: 2, unit: "CONTACTS" }, { value: 5, unit: "MESSAGES" }).state, "NOT_COMPUTABLE");
});
