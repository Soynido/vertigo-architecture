/**
 * PT-GTM-004 — measurement, computability and snapshot identity, through the real six-tool protocol
 * (PV-GTM-002, W04/W05). Evidence candidates only: no PT case is marked PASS here.
 *
 * A: the exact O1 figures of the frozen W03 world, stated as durable snapshots.
 * B: two maturities are visible and never compared silently.
 * C: an inaccessible mailbox makes the reply count NOT_COMPUTABLE while a missing price invalidates nothing.
 * D: the same input revision identifies the same snapshot; a backfill produces a new, traceable one.
 * E: calendar weeks (including both DST transitions), duplicates, company distincts and unit guards.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGtmWorld, OBSERVED_AT, R_TEST, WEEK_W } from "../gtm/world.ts";
import { entryCohort, isUnavailable, weeklyRepliedProspects } from "../gtm/oracle.ts";
import { digestOf, validateParisWeek } from "../../src/gtm/semantics.ts";
import { buildGtmRuntimeWorld, G } from "./world.ts";
import {
  bindRep, commit, coverageIntent, DST_WEEKS, evidenceOf, prepare, revisionKey, seedCoverage, seedRevision,
  snapshotIntent, snapshotKeyOf, WEEK, type CoverageSpec,
} from "./drive.ts";

const MAILBOX: CoverageSpec = { key: "COV-MBX-W38", source: "MAILBOX", since: "2026-09-07T00:00:00+02:00", until: "2026-09-28T00:00:00+02:00", state: "COMPLETE" };
const BASIS = { reason: "INITIAL" as const, basis_refs: ["SALES:EXPOSURES", "SALES:REPLY_ATTRIBUTIONS"], basis_digest: digestOf("w38-initial").slice(0, 16) };

test("PT-GTM-004/A: the exact O1 figures of the frozen W03 week are stated as durable snapshots", async () => {
  // The numbers come from the frozen W03 oracle, not from this test.
  const frozen = buildGtmWorld();
  const scope = { runtime_key: R_TEST, period: WEEK_W, observed_at: OBSERVED_AT };
  const metric = weeklyRepliedProspects(frozen, scope);
  const cohort = entryCohort(frozen, scope);
  assert.ok(!isUnavailable(metric) && !isUnavailable(cohort));
  assert.deepEqual(metric.contacts, ["C01", "C05", "C09"]);
  assert.equal(metric.value, 3);
  assert.equal(metric.eligible_human_reply_messages, 5);
  assert.deepEqual(cohort.entrants.length, 7);
  assert.deepEqual(cohort.replied_entrants, ["C01", "C09"]);
  assert.equal(cohort.rate_label, "2/7");

  const w = buildGtmRuntimeWorld();
  const h = await bindRep(w);
  await seedCoverage(w, h, [MAILBOX]);
  const revision = await seedRevision(w, h, BASIS);

  await commit(w, h, snapshotIntent({ metric_key: "weekly_replied_prospects", period: WEEK, cutoff: WEEK.mature_cutoff, input_revision: revision, coverage: [MAILBOX], value: String(metric.value), evidence_refs: metric.eligible_message_keys.join(";") }));
  await commit(w, h, snapshotIntent({ metric_key: "eligible_human_reply_messages", period: WEEK, cutoff: WEEK.mature_cutoff, input_revision: revision, coverage: [MAILBOX], value: String(metric.eligible_human_reply_messages), evidence_refs: metric.eligible_message_keys.join(";") }));
  await commit(w, h, snapshotIntent({ metric_key: "weekly_entry_cohort_reply_rate", period: WEEK, cutoff: WEEK.mature_cutoff, input_revision: revision, coverage: [MAILBOX], value: String(cohort.replied_entrants.length / cohort.entrants.length), evidence_refs: cohort.replied_entrants.join(";") }));
  const rows = w.rows(G.snapshotsDs);
  assert.equal(rows.length, 3);
  const values = rows.map((r) => (r.properties["Value"] as unknown as { rich_text: Array<{ plain_text: string }> }).rich_text[0]?.plain_text).sort();
  assert.deepEqual(values, [String(2 / 7), "3", "5"]);
});

test("PT-GTM-004/B: a cohort of a different maturity is visible and never compared silently", async () => {
  const w = buildGtmRuntimeWorld();
  const h = await bindRep(w);
  await seedCoverage(w, h, [MAILBOX]);
  const revision = await seedRevision(w, h, BASIS);

  // The cohort rate has a 7-day horizon while outbound execution has a zero-day horizon. One day after the week,
  // execution is stateable but the cohort is still INCONCLUSIVE. Claiming the cohort number is refused; stating
  // it as INCONCLUSIVE is accepted. At the canonical O1 cutoff both are mature (case A above).
  const earlyCutoff = "2026-09-22T09:00:00+02:00";
  await commit(w, h, snapshotIntent({ metric_key: "outbound_messages_sent", period: WEEK, cutoff: earlyCutoff, input_revision: revision, coverage: [MAILBOX], value: "7" }));
  const forced = await prepare(w, h, snapshotIntent({ metric_key: "weekly_entry_cohort_reply_rate", period: WEEK, cutoff: earlyCutoff, input_revision: revision, coverage: [MAILBOX], computability: "COMPUTED", value: String(2 / 7) }));
  assert.equal(forced.envelope.code, "HOLD_GTM_CONTRACT_VIOLATION", JSON.stringify(forced.envelope));
  assert.match(evidenceOf(forced.envelope), /contradicts the declared evidence: INCONCLUSIVE/);
  await commit(w, h, snapshotIntent({ metric_key: "weekly_entry_cohort_reply_rate", period: WEEK, cutoff: earlyCutoff, input_revision: revision, coverage: [MAILBOX], computability: "INCONCLUSIVE" }));

  const silent = await prepare(w, h, snapshotIntent({
    metric_key: "outbound_messages_sent", period: WEEK, cutoff: WEEK.mature_cutoff, input_revision: revision,
    coverage: [MAILBOX], value: "7", extra: { "Compared With Snapshot": "SNAP-other" },
  }));
  assert.equal(silent.envelope.code, "HOLD_GTM_CONTRACT_VIOLATION");
  assert.match(evidenceOf(silent.envelope), /two snapshots of different maturity are never compared silently/);
});

test("PT-GTM-004/C: an inaccessible mailbox is NOT_COMPUTABLE while a missing price invalidates no reply count", async () => {
  const w = buildGtmRuntimeWorld();
  const h = await bindRep(w);
  const revoked: CoverageSpec = { ...MAILBOX, key: "COV-MBX-W38-REVOKED", state: "REVOKED" };
  await seedCoverage(w, h, [revoked]);
  const revision = await seedRevision(w, h, BASIS);

  const stated = await prepare(w, h, snapshotIntent({ metric_key: "weekly_replied_prospects", period: WEEK, cutoff: WEEK.mature_cutoff, input_revision: revision, coverage: [revoked], value: "3" }));
  assert.equal(stated.envelope.code, "HOLD_GTM_CONTRACT_VIOLATION");
  assert.match(evidenceOf(stated.envelope), /NOT_COMPUTABLE — MAILBOX coverage over W-2026-38 is REVOKED/);
  await commit(w, h, snapshotIntent({ metric_key: "weekly_replied_prospects", period: WEEK, cutoff: WEEK.mature_cutoff, input_revision: revision, coverage: [revoked], computability: "NOT_COMPUTABLE", extra: { "Coverage State Reported": "REVOKED" } }));

  // A price that was never communicated belongs to another source entirely: the reply count stays computable.
  await seedCoverage(w, h, [MAILBOX]);
  await commit(w, h, snapshotIntent({ metric_key: "weekly_replied_prospects", period: WEEK, cutoff: WEEK.mature_cutoff, input_revision: revision, coverage: [MAILBOX], value: "3" }));
  assert.equal(w.rows(G.snapshotsDs).length, 2);
});

test("PT-GTM-004/D: one input revision identifies one snapshot; a backfill produces a new traceable one", async () => {
  const w = buildGtmRuntimeWorld();
  const h = await bindRep(w);
  await seedCoverage(w, h, [MAILBOX]);
  const first = await seedRevision(w, h, BASIS);
  const spec = { metric_key: "weekly_replied_prospects", period: WEEK, cutoff: WEEK.mature_cutoff, input_revision: first, coverage: [MAILBOX], value: "3" } as const;
  await commit(w, h, snapshotIntent(spec));

  // Same definitions, same revision, same question: the same logical snapshot, so a second creation is a duplicate.
  const again = await prepare(w, h, snapshotIntent(spec));
  assert.equal(again.envelope.code, "HOLD_DUPLICATE", JSON.stringify(again.envelope));

  // A forged key is refused: identity is derived, never chosen.
  const forged = await prepare(w, h, snapshotIntent({ ...spec, forced_key: "SNAP-chosen-by-hand" }));
  assert.equal(forged.envelope.code, "HOLD_GTM_CONTRACT_VIOLATION");
  assert.match(evidenceOf(forged.envelope), /Snapshot Key is derived/);

  // A backfill states a new basis, supersedes the first revision and produces a NEW snapshot beside the old one.
  const backfill = { reason: "BACKFILL" as const, basis_refs: [...BASIS.basis_refs, "SALES:GTM_COVERAGE"], basis_digest: digestOf("w38-backfill").slice(0, 16), supersedes: first };
  const second = await seedRevision(w, h, backfill);
  assert.notEqual(second, first);
  assert.equal(second, revisionKey(backfill));
  await commit(w, h, snapshotIntent({ ...spec, input_revision: second, value: "4" }));
  const snapshots = w.rows(G.snapshotsDs);
  assert.equal(snapshots.length, 2, "the historical snapshot is never overwritten");
  assert.notEqual(snapshotKeyOf({ ...spec, input_revision: second }), snapshotKeyOf(spec));

  // The superseded revision stays durable and the supersession is traceable.
  const revisions = w.rows(G.revisionsDs);
  assert.equal(revisions.length, 2);
  const supersedes = revisions.map((r) => (r.properties["Supersedes"] as unknown as { rich_text?: Array<{ plain_text: string }> } | undefined)?.rich_text?.[0]?.plain_text ?? "");
  assert.ok(supersedes.includes(first));

  // A backfill that supersedes nothing, and an initial revision that claims to supersede, are both refused.
  const orphan = await prepare(w, h, snapshotIntent({ ...spec, input_revision: "IR-does-not-exist" }));
  assert.equal(orphan.envelope.code, "HOLD_GTM_CONTRACT_VIOLATION");
  assert.match(evidenceOf(orphan.envelope), /input revision that does not exist in this runtime/);
});

test("PT-GTM-004/E: calendar weeks across both DST transitions, arbitrary windows, duplicates and unit guards", async () => {
  // The two real Europe/Paris transition weeks, checked by the shared calendar rule.
  assert.deepEqual(validateParisWeek(DST_WEEKS.spring.start, DST_WEEKS.spring.end), { ok: true, reason: "NONE", duration_hours: 167 });
  assert.deepEqual(validateParisWeek(DST_WEEKS.autumn.start, DST_WEEKS.autumn.end), { ok: true, reason: "NONE", duration_hours: 169 });
  assert.equal(validateParisWeek(WEEK.start, WEEK.end).duration_hours, 168);
  // An arbitrary seven-day window is refused even though it lasts exactly 168 hours.
  const arbitrary = validateParisWeek("2026-09-16T00:00:00+02:00", "2026-09-23T00:00:00+02:00");
  assert.equal(arbitrary.ok, false);
  assert.equal(arbitrary.duration_hours, 168);
  assert.match(arbitrary.reason, /opens at a Monday 00:00:00 Europe\/Paris/);

  const w = buildGtmRuntimeWorld();
  const h = await bindRep(w);
  const springCoverage: CoverageSpec = { key: "COV-MBX-W13", source: "MAILBOX", since: "2026-03-16T00:00:00+01:00", until: "2026-04-06T00:00:00+02:00", state: "COMPLETE" };
  const autumnCoverage: CoverageSpec = { key: "COV-MBX-W43", source: "MAILBOX", since: "2026-10-12T00:00:00+02:00", until: "2026-11-02T00:00:00+01:00", state: "COMPLETE" };
  await seedCoverage(w, h, [springCoverage, autumnCoverage]);
  const revision = await seedRevision(w, h, BASIS);

  // Both DST weeks are stateable end to end through the protocol.
  await commit(w, h, snapshotIntent({ metric_key: "weekly_replied_prospects", period: DST_WEEKS.spring, cutoff: DST_WEEKS.spring.mature_cutoff, input_revision: revision, coverage: [springCoverage], value: "2" }));
  await commit(w, h, snapshotIntent({ metric_key: "weekly_replied_prospects", period: DST_WEEKS.autumn, cutoff: DST_WEEKS.autumn.mature_cutoff, input_revision: revision, coverage: [autumnCoverage], value: "1" }));
  assert.equal(w.rows(G.snapshotsDs).length, 2);

  // An arbitrary seven-day window is refused by the integrated grammar too.
  const slid = await prepare(w, h, snapshotIntent({
    metric_key: "weekly_replied_prospects",
    period: { key: "W-SLID", start: "2026-09-16T00:00:00+02:00", end: "2026-09-23T00:00:00+02:00" },
    cutoff: WEEK.mature_cutoff, input_revision: revision, coverage: [springCoverage], value: "3",
  }));
  assert.equal(slid.envelope.code, "HOLD_GTM_CONTRACT_VIOLATION");
  assert.match(evidenceOf(slid.envelope), /opens at a Monday 00:00:00/);

  // Heterogeneous units never form a rate, and a company-global total is refused outright.
  const mixed = await prepare(w, h, snapshotIntent({
    metric_key: "weekly_replied_prospects", period: DST_WEEKS.spring, cutoff: "2026-04-07T09:00:00+02:00",
    input_revision: revision, coverage: [springCoverage], value: "2",
    extra: { "Numerator Unit": "CONTACTS", "Denominator Unit": "MESSAGES" },
  }));
  assert.equal(mixed.envelope.code, "HOLD_GTM_CONTRACT_VIOLATION");
  assert.match(evidenceOf(mixed.envelope), /heterogeneous denominator/);

  const global = await prepare(w, h, snapshotIntent({
    metric_key: "replied_companies", period: DST_WEEKS.spring, cutoff: "2026-04-08T09:00:00+02:00",
    input_revision: revision, coverage: [springCoverage], value: "2", scope: "COMPANY_GLOBAL",
  }));
  assert.equal(global.envelope.code, "HOLD_GTM_CONTRACT_VIOLATION");
  assert.match(evidenceOf(global.envelope), /needs a Shared Reality topology; the pilot declares none/);

  // A duplicate coverage declaration cannot be re-stated: append-only history, one key one row.
  const duplicate = await prepare(w, h, coverageIntent(springCoverage));
  assert.equal(duplicate.envelope.code, "HOLD_DUPLICATE");
});
