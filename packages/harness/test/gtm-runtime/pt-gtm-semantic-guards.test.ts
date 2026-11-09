/**
 * Semantic guards of the candidate (PV-GTM-002): the calendar, the coverage precedence, the attribution rules,
 * the fail-narrow lookup and the verification-time re-validation. Evidence candidates only.
 *
 * These exercise the SHARED functions the integrated grammar routes through, plus the two places where a stale
 * assumption could otherwise be committed: a native Notion edit between prepare and verify.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../../src/tools/handlers.ts";
import type { Plan } from "../../src/plans/store.ts";
import { findRows } from "../../src/plans/resources.ts";
import {
  attributionVerdict, computability, coverageVerdict, maturityInstant, metricDefinition, parisParts,
  validateParisWeek, type CoverageDeclaration, type Period, type TouchCandidate,
} from "../../src/gtm/semantics.ts";
import { executeWrites } from "../unit/target-fixtures.ts";
import { synthetic } from "../unit/meta-fixtures.ts";
import { buildGtmRuntimeWorld, G, gtmRow, GTM_SCHEMAS, REP_GTM_INSTANCE } from "./world.ts";
import { bindRep, commit, evidenceOf, exposureIntent, gtmIntent, prepare, REP_CTX, WEEK } from "./drive.ts";

const period = (key: string, start: string, end: string): Period => ({ period_key: key, start, end, timezone: "Europe/Paris" });
const W38 = period("W-2026-38", WEEK.start, WEEK.end);
const SPRING = period("W-2026-13", "2026-03-23T00:00:00+01:00", "2026-03-30T00:00:00+02:00");
const AUTUMN = period("W-2026-43", "2026-10-19T00:00:00+02:00", "2026-10-26T00:00:00+01:00");
const cov = (key: string, source: CoverageDeclaration["source"], state: CoverageDeclaration["state"], since = "2026-09-07T00:00:00+02:00", until = "2026-09-28T00:00:00+02:00"): CoverageDeclaration =>
  ({ coverage_key: key, source, since, until, state });

test("guard/calendar: Monday-local alignment, half-open next Monday, 167 and 169 hour weeks", () => {
  assert.equal(parisParts(Date.parse(WEEK.start)).weekday, "Mon");
  assert.equal(validateParisWeek(WEEK.start, WEEK.end).duration_hours, 168);
  assert.deepEqual(validateParisWeek(SPRING.start, SPRING.end), { ok: true, reason: "NONE", duration_hours: 167 });
  assert.deepEqual(validateParisWeek(AUTUMN.start, AUTUMN.end), { ok: true, reason: "NONE", duration_hours: 169 });

  // A Tuesday open, a Sunday close, a fixed 7 * 24h span across a transition: each refused, each with its reason.
  assert.match(validateParisWeek("2026-09-15T00:00:00+02:00", "2026-09-22T00:00:00+02:00").reason, /opens on Tue/);
  assert.match(validateParisWeek(WEEK.start, "2026-09-20T00:00:00+02:00").reason, /closes at the NEXT Monday/);
  const fixedSpan = validateParisWeek(SPRING.start, "2026-03-30T00:00:00+01:00");
  assert.equal(fixedSpan.ok, false);
  assert.equal(fixedSpan.duration_hours, 168, "a fixed 168-hour span is the wrong instant across a spring transition");
  const autumnFixed = validateParisWeek(AUTUMN.start, "2026-10-26T00:00:00+02:00");
  assert.equal(autumnFixed.ok, false);
  assert.equal(autumnFixed.duration_hours, 168, "and the wrong instant across an autumn transition too");

  // Maturity is counted in calendar days, so it lands on the local instant, not on a fixed multiple of 24 hours.
  const mature = maturityInstant(SPRING.end, 7);
  assert.equal(new Date(mature).toISOString(), "2026-04-05T22:00:00.000Z");
  assert.equal(parisParts(mature).hour, 0);
});

test("guard/coverage: the worst declared state decides, whatever the row order, for every source", () => {
  const complete = cov("COV-A", "MAILBOX", "COMPLETE");
  const revoked = cov("COV-Z", "MAILBOX", "REVOKED");
  const forward = coverageVerdict("MAILBOX", W38, [complete, revoked]);
  const reversed = coverageVerdict("MAILBOX", W38, [revoked, complete]);
  assert.deepEqual(forward, reversed, "row order never changes the verdict");
  assert.equal(forward.state, "REVOKED");
  assert.deepEqual(forward.considered, ["COV-A", "COV-Z"]);

  assert.equal(coverageVerdict("MAILBOX", W38, [cov("COV-U", "MAILBOX", "UNKNOWN"), complete]).state, "UNKNOWN");
  assert.equal(coverageVerdict("MAILBOX", W38, [cov("COV-P", "MAILBOX", "PARTIAL"), complete]).state, "PARTIAL");
  assert.equal(coverageVerdict("MAILBOX", W38, []).state, "ABSENT");
  assert.equal(coverageVerdict("MAILBOX", W38, [cov("COV-SHORT", "MAILBOX", "COMPLETE", "2026-09-16T00:00:00+02:00")]).state, "PARTIAL");
  assert.equal(coverageVerdict("MAILBOX", W38, [complete]).ok, true);

  // Every source of the catalog is exercised, including the two metrics the review named.
  assert.deepEqual(metricDefinition("eligible_human_reply_messages")?.requires_coverage, ["MAILBOX"]);
  assert.deepEqual(metricDefinition("meeting_bookings")?.requires_coverage, ["MEETING_EVENTS"]);
  assert.deepEqual(metricDefinition("distinct_link_reads")?.requires_coverage, ["TRACKER"]);
  assert.equal(computability("eligible_human_reply_messages", W38, WEEK.mature_cutoff, [complete]).state, "COMPUTED");
  assert.equal(computability("meeting_bookings", W38, WEEK.mature_cutoff, [complete]).state, "NOT_COMPUTABLE");
  assert.equal(computability("meeting_bookings", W38, WEEK.mature_cutoff, [cov("COV-EVT", "MEETING_EVENTS", "COMPLETE")]).state, "COMPUTED");
  assert.equal(computability("distinct_link_reads", W38, WEEK.mature_cutoff, [cov("COV-TRK", "TRACKER", "PARTIAL")]).state, "NOT_COMPUTABLE");
  assert.equal(computability("distinct_link_reads", W38, WEEK.mature_cutoff, [cov("COV-TRK", "TRACKER", "COMPLETE")]).state, "COMPUTED");
});

test("guard/precedence: maturity is decided before coverage, so immature and uncovered is INCONCLUSIVE", () => {
  const immatureUncovered = computability("weekly_replied_prospects", W38, WEEK.immature_cutoff, []);
  assert.equal(immatureUncovered.state, "INCONCLUSIVE");
  assert.match(immatureUncovered.reason, /not mature before/);
  assert.equal(computability("weekly_replied_prospects", W38, WEEK.mature_cutoff, []).state, "NOT_COMPUTABLE");
  assert.equal(computability("unknown_metric", W38, WEEK.mature_cutoff, []).reason, "no pinned definition for unknown_metric");
  assert.match(computability("weekly_replied_prospects", W38, "not-an-instant", []).reason, /ISO instant/);
});

test("guard/attribution: an unresolvable thread is UNATTRIBUTED and a group is never a message", () => {
  const touch = (ref: string, over: Partial<TouchCandidate> = {}): TouchCandidate => ({
    message_ref: ref, campaign_key: "CMP-1", approach_version_key: "AP-1/v1", participation_key: "PART-1",
    occurred_at: "2026-09-14T09:00:00+02:00", durably_proven: true, ...over,
  });
  const base = { identity_resolution: "CANONICAL" as const, reply_at: "2026-09-15T10:00:00+02:00" };

  // A threading reference that resolves to nothing proven never falls through to another touch.
  const ghostThread = attributionVerdict({ ...base, prior_touches: [touch("MSG-A")], in_reply_to: "MSG-UNKNOWN" });
  assert.equal(ghostThread.status, "UNATTRIBUTED");
  assert.equal(ghostThread.attributed_to, null);
  assert.match(ghostThread.reason, /no other touch takes its place/);

  const undurableThread = attributionVerdict({ ...base, prior_touches: [touch("MSG-A", { durably_proven: false })], in_reply_to: "MSG-A" });
  assert.equal(undurableThread.status, "UNATTRIBUTED");

  // Same group, several touches: attribution is to the GROUP, and no message is promoted.
  const group = attributionVerdict({ ...base, prior_touches: [touch("MSG-A"), touch("MSG-B", { occurred_at: "2026-09-14T18:00:00+02:00" })] });
  assert.equal(group.status, "ATTRIBUTED");
  assert.equal(group.attributed_to, null, "the most recent touch is never promoted");
  assert.deepEqual(group.attributed_group, { campaign_key: "CMP-1", approach_version_key: "AP-1/v1", participation_key: "PART-1" });

  // Different groups stay UNATTRIBUTED with every candidate preserved.
  const ambiguous = attributionVerdict({ ...base, prior_touches: [touch("MSG-A"), touch("MSG-C", { campaign_key: "CMP-2", occurred_at: "2026-09-14T18:00:00+02:00" })] });
  assert.equal(ambiguous.status, "UNATTRIBUTED");
  assert.deepEqual(ambiguous.candidates.map((c) => c.message_ref), ["MSG-A", "MSG-C"]);

  // Threading onto a proven touch attributes to that message.
  const threaded = attributionVerdict({ ...base, prior_touches: [touch("MSG-A")], in_reply_to: "MSG-A" });
  assert.equal(threaded.status, "ATTRIBUTED");
  assert.equal(threaded.attributed_to?.message_ref, "MSG-A");

  // Fail-closed on identity and instants.
  assert.equal(attributionVerdict({ ...base, identity_resolution: "UNRESOLVED", prior_touches: [touch("MSG-A")] }).status, "UNKNOWN");
  assert.equal(attributionVerdict({ ...base, reply_at: "15/09/2026", prior_touches: [touch("MSG-A")] }).status, "UNKNOWN");
  assert.equal(attributionVerdict({ ...base, prior_touches: [touch("MSG-OLD", { occurred_at: "2026-07-01T09:00:00+02:00" })] }).status, "UNKNOWN");
});

test("guard/lookup: an unavailable or unreadable resource is never an empty result", async () => {
  const w = buildGtmRuntimeWorld();
  const h = await bindRep(w);
  const bound = await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, REP_CTX, w.deps);
  void bound;

  // Remove the Exposures container: the cross-check can no longer be performed, so the record is refused.
  const children = (w.map.get(`children:${G.gtmPage}`) as { results: Array<{ id: string }> }).results;
  w.map.set(`children:${G.gtmPage}`, { results: children.filter((c) => c.id !== G.exposuresDb), has_more: false, next_cursor: null });
  const refused = await prepare(w, h, gtmIntent("SALES:REPLY_ATTRIBUTIONS", "RA-NO-SOURCE", {
    "Reply Ref": "IN-C01", Contact: "C01", "Identity Resolution": "CANONICAL", "Reply At": "2026-09-15T10:00:00+02:00",
    "In Reply To": "MSG-C01", "Prior Touches": "MSG-C01|CMP-1|AP-1/v1|PART-1|2026-09-14T09:00:00+02:00",
    "Attribution Status": "ATTRIBUTED", "Attributed To": "MSG-C01", Candidates: "MSG-C01",
    Disposition: "ELIGIBLE_HUMAN_REPLY", "Counts As Reply": "true", "Reply Kind": "HUMAN", "Reply Intent": "POSITIVE", Party: "EXTERNAL_PROSPECT",
  }));
  assert.equal(refused.envelope.code, "HOLD_GTM_CONTRACT_VIOLATION", JSON.stringify(refused.envelope));
  assert.match(evidenceOf(refused.envelope), /could not be checked against durable state \(UNAVAILABLE\)/);

  // The lookup itself distinguishes the failure modes.
  const runtime = { root_ref: G.root, adapter: { version: "x", controlPlane: { resources: {} } } } as never;
  const unknown = await findRows(w.deps.notion, runtime, "SALES:EXPOSURES", "Message Ref", "MSG-C01", ["Campaign"]);
  assert.equal(unknown.status, "UNAVAILABLE");
});

test("guard/revalidation: a native edit between prepare and verify never commits a stale assumption", async () => {
  const w = buildGtmRuntimeWorld();
  const h = await bindRep(w);
  await commit(w, h, exposureIntent({ key: "EXP-SEED", contact: "C02", message_ref: "MSG-SEED" }));

  // A perfectly valid enrollment is planned and written by the native app...
  const prepared = await prepare(w, h, gtmIntent("SALES:ENROLLMENTS", "ENR-NEW", { Campaign: "CMP-1", Contact: "C02", "Started At": "2026-09-07T09:00:00+02:00" }));
  const plan = prepared.plan as Plan;
  executeWrites(w, plan.stage1_writes, plan.plan_id, { now: "2030-01-03T00:30:00.000Z" });

  // ...and, before the verification, somebody creates a second ACTIVE enrollment for the same contact by hand.
  w.setRows(G.enrollmentsDs, [
    ...w.rows(G.enrollmentsDs),
    gtmRow(synthetic("hand-written-enrollment"), "Enrollment", "ENR-BY-HAND", { "Enrollment Key": "ENR-BY-HAND", Campaign: "CMP-2", Contact: "C02", State: "ACTIVE" }, GTM_SCHEMAS.enrollments),
  ]);
  const verified = await dispatch("os_verify", { binding_handle: h, plan_id: plan.plan_id, phase: "TARGET" }, REP_CTX, w.deps);
  assert.equal(verified.code, "HOLD_GTM_CONTRACT_VIOLATION", JSON.stringify(verified));
  assert.match(evidenceOf(verified), /already holds 1 ACTIVE enrollment/);
  assert.match(evidenceOf(verified), /no receipt was issued/);
});

test("guard/revalidation: a parent version whose Authority widens after prepare stops the variant", async () => {
  const w = buildGtmRuntimeWorld();
  const h = await bindRep(w);
  const prepared = await prepare(w, h, gtmIntent("SALES:APPROACH_VERSIONS", "AP-1/v2", {
    "Approach Key": "AP-1", "Version Label": "v2", "Authority Scope": "SALES_OUTBOUND_EMAIL", "Variant Of": "AP-1/v1",
  }));
  const plan = prepared.plan as Plan;
  executeWrites(w, plan.stage1_writes, plan.plan_id, { now: "2030-01-03T00:30:00.000Z" });

  // The parent's Authority is edited by hand between the write and the verification.
  w.setRows(G.versionsDs, w.rows(G.versionsDs).map((r) => (
    ((r.properties["Approach Version Key"] as unknown as { rich_text: Array<{ plain_text: string }> }).rich_text[0]?.plain_text === "AP-1/v1")
      ? { ...r, properties: { ...r.properties, "Authority Scope": { type: "rich_text", rich_text: [{ type: "text", plain_text: "SALES_OUTBOUND_EMAIL_AND_CALL", annotations: {} }] } } as never }
      : r
  )));
  const verified = await dispatch("os_verify", { binding_handle: h, plan_id: plan.plan_id, phase: "TARGET" }, REP_CTX, w.deps);
  assert.equal(verified.code, "HOLD_GTM_CONTRACT_VIOLATION", JSON.stringify(verified));
  assert.match(evidenceOf(verified), /a variant never widens Authority/);
  assert.equal(REP_GTM_INSTANCE, "SALESOS-FIXTURE-GTM");
});
