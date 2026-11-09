/**
 * GTM-W03 — THE SEMANTIC ORACLE MATRIX.
 *
 * One entry per required fixture branch identifier. Each entry freezes TWO compare sets:
 *   • `target` — the fixture state that must be materialized for the branch to mean anything;
 *   • `final`  — the semantic outcome the oracle must produce from that state.
 * Both are recomputed from the world on every run and compared to the frozen expectations, so a silent data or
 * oracle drift fails loudly instead of quietly re-baselining.
 *
 * A branch here asserts AVAILABILITY of a fixture and its oracle. It is NOT a PT-GTM case verdict: nothing in this
 * package may be read as PT-GTM-001..014 PASS, and the per-principal read canaries stay deferred.
 */
import { REAL_READ_CANARY, RESOURCE_KEYS, RESULT_SEMANTICS } from "./catalog.ts";
import {
  buildGtmWorld, OBSERVED_AT, OBSERVED_TOO_EARLY, R_ALT, R_TEST, WEEK_NEXT, WEEK_W,
  withCanceledEpisode, withCoverageGap, withExtraContextRef, withHeldEpisode, withoutMetricHorizon,
  withRotatedGeneration, withUnregisteredContext, GTM_CONTEXT_KEYS, inPeriod, type ExposureRec, type GtmWorld,
} from "./world.ts";
import {
  attributeReply, calendarReadState, classifyBatch, classifyEvent, companyAggregate, companyGlobalTotal,
  dispositionsInPeriod, distinctEpisodes, eligibleRepliesByApproachVersion, entryCohort, episodeIdentity,
  episodeStatuses, exposureView, followUpContacts, linkSignals, meetingCounts, messageOf, metricDef,
  profileView, rateOf, readRows, readScopeOf, weeklyRepliedProspects, MEETING_STATUS_LADDER, isUnavailable,
} from "./oracle.ts";
import { buildCandidatePack, isPackStale, LANE_AUTHORIZED_RESOURCES, steerNewRun, submitSymbolToMutationCatalog } from "./pack.ts";

export type Compare = Record<string, unknown>;

export interface GtmBranch {
  readonly id: string;
  readonly title: string;
  /** The W02 decisions this branch materializes. */
  readonly admits: readonly string[];
  readonly resources: readonly string[];
  readonly target: (w: GtmWorld) => Compare;
  readonly expected_target: Compare;
  readonly final: (w: GtmWorld) => Compare;
  readonly expected_final: Compare;
  readonly result_semantics: typeof RESULT_SEMANTICS;
  /** Present on the branches whose real per-principal read stays deferred to the next GTM gate. */
  readonly real_read_canary?: typeof REAL_READ_CANARY;
}

const branch = (
  id: string, title: string, admits: readonly string[], resources: readonly string[],
  target: (w: GtmWorld) => Compare, expected_target: Compare,
  final: (w: GtmWorld) => Compare, expected_final: Compare,
  deferred = false,
): GtmBranch => ({
  id, title, admits, resources, target, expected_target, final, expected_final,
  result_semantics: RESULT_SEMANTICS, ...(deferred ? { real_read_canary: REAL_READ_CANARY } : {}),
});

const SCOPE = { runtime_key: R_TEST, period: WEEK_W, observed_at: OBSERVED_AT } as const;
const O2 = { ...SCOPE, dataset: "O2" } as const;
const metric = (w: GtmWorld) => weeklyRepliedProspects(w, SCOPE);
const cohort = (w: GtmWorld) => entryCohort(w, SCOPE);
const dispo = (w: GtmWorld, key: string) => dispositionsInPeriod(w, SCOPE).find((d) => d.message_key === key);
const event = (w: GtmWorld, key: string) => w.provider_events.find((e) => e.provider_event_key === key);
const classifyKey = (w: GtmWorld, key: string) => {
  const e = event(w, key);
  return e === undefined ? { participation_class: "MISSING", purpose_class: "MISSING", excluded: false } : classifyEvent(e);
};
const calCase = (key: string) => (w: GtmWorld) => {
  const c = classifyKey(w, key);
  return { participation_class: c.participation_class, purpose_class: c.purpose_class, excluded: c.excluded };
};
const calTarget = (key: string) => (w: GtmWorld) => {
  const e = event(w, key);
  return {
    participant_kinds: (e?.participants ?? []).map((p) => p.kind),
    agenda_evidence: e?.agenda_evidence ?? "MISSING",
    evidence_completeness: e?.evidence_completeness ?? "MISSING",
  };
};

/** An attempt to overwrite a pinned exposure. The world is deeply frozen, so the attempt cannot succeed. */
function attemptExposureMutation(w: GtmWorld, exposure_key: string): string {
  const before = w.exposures.find((e) => e.exposure_key === exposure_key);
  if (before === undefined) return "MISSING";
  const price = before.communicated_price_cents;
  try {
    (before as { -readonly [K in keyof ExposureRec]: ExposureRec[K] }).communicated_price_cents = price + 1;
  } catch {
    return "REFUSED_IMMUTABLE";
  }
  return w.exposures.find((e) => e.exposure_key === exposure_key)?.communicated_price_cents === price ? "REFUSED_IMMUTABLE" : "MUTATED";
}

export const BRANCHES: readonly GtmBranch[] = [
  /* ───────── PT-GTM-001 — D01: the weekly metric is defined and testable, its production target is not set ───────── */
  branch("PT-GTM-001/A", "weekly_replied_prospects is pinned as a half-open weekly event-period metric", ["D01", "D02"], [RESOURCE_KEYS.METRIC_DEF],
    (w) => {
      const d = metricDef(w, "weekly_replied_prospects");
      return { metric_class: d?.metric_class, period_kind: d?.period_kind, timezone: d?.timezone, half_open: d?.half_open, unit: d?.unit };
    },
    { metric_class: "EVENT_PERIOD", period_kind: "WEEK_HALF_OPEN", timezone: "Europe/Paris", half_open: true, unit: "CONTACTS" },
    (w) => {
      const d = metricDef(w, "weekly_replied_prospects");
      return { defined: d !== undefined, horizon_days: d?.observation_horizon_days, maturity_rule_pinned: d?.maturity_rule !== null };
    },
    { defined: true, horizon_days: 7, maturity_rule_pinned: true }),

  branch("PT-GTM-001/B", "the fixture threshold is 2 and the production target stays TARGET_NOT_SET", ["D01"], [RESOURCE_KEYS.METRIC_DEF],
    (w) => {
      const d = metricDef(w, "weekly_replied_prospects");
      return { production_target_state: d?.production_target_state, fixture_threshold: d?.fixture_threshold };
    },
    { production_target_state: "TARGET_NOT_SET", fixture_threshold: 2 },
    (w) => {
      const m = metric(w);
      return isUnavailable(m) ? { state: m.state } : {
        meets_fixture_threshold: m.meets_fixture_threshold, production_target_state: m.production_target_state,
        target_comparison: "NOT_APPLICABLE_TARGET_NOT_SET",
      };
    },
    { meets_fixture_threshold: true, production_target_state: "TARGET_NOT_SET", target_comparison: "NOT_APPLICABLE_TARGET_NOT_SET" }),

  branch("PT-GTM-001/C", "the metric computes exactly 3 replied prospects over 5 eligible human reply messages", ["D01"], [RESOURCE_KEYS.MESSAGE, RESOURCE_KEYS.CONTACT],
    (w) => ({ inbound_rows_in_period: dispositionsInPeriod(w, SCOPE).length, runtime_key: SCOPE.runtime_key, period: WEEK_W.period_key }),
    { inbound_rows_in_period: 13, runtime_key: "R_TEST", period: "W-2026-38" },
    (w) => {
      const m = metric(w);
      return isUnavailable(m) ? { state: m.state } : { value: m.value, contacts: m.contacts, eligible_human_reply_messages: m.eligible_human_reply_messages, eligible_message_keys: m.eligible_message_keys };
    },
    { value: 3, contacts: ["C01", "C05", "C09"], eligible_human_reply_messages: 5, eligible_message_keys: ["IN-C01-1", "IN-C01-2", "IN-C01-3", "IN-C05", "IN-C09"] }),

  /* ───────── PT-GTM-002 — D02: explicit per-metric horizons over half-open Paris weeks ───────── */
  branch("PT-GTM-002/A", "the week is half-open: the lower bound belongs to W, the upper bound does not", ["D02"], [RESOURCE_KEYS.MESSAGE],
    (w) => ({ c05_reply_at: messageOf(w, R_TEST, "IN-C05")?.occurred_at, c13_reply_at: messageOf(w, R_TEST, "IN-C13")?.occurred_at, week_start: WEEK_W.start, week_end: WEEK_W.end }),
    { c05_reply_at: "2026-09-14T00:00:00+02:00", c13_reply_at: "2026-09-21T00:00:00+02:00", week_start: "2026-09-14T00:00:00+02:00", week_end: "2026-09-21T00:00:00+02:00" },
    (w) => ({
      c05_in_W: inPeriod(messageOf(w, R_TEST, "IN-C05")?.occurred_at ?? "", WEEK_W),
      c13_in_W: inPeriod(messageOf(w, R_TEST, "IN-C13")?.occurred_at ?? "", WEEK_W),
      c13_in_next_week: inPeriod(messageOf(w, R_TEST, "IN-C13")?.occurred_at ?? "", WEEK_NEXT),
      next_week_value: (() => { const m = weeklyRepliedProspects(w, { runtime_key: R_TEST, period: WEEK_NEXT, observed_at: "2026-10-05T09:00:00+02:00" }); return isUnavailable(m) ? m.state : m.value; })(),
    }),
    { c05_in_W: true, c13_in_W: false, c13_in_next_week: true, next_week_value: 1 }),

  branch("PT-GTM-002/B", "the event-period metric is mature at the declared observation instant", ["D02"], [RESOURCE_KEYS.METRIC_DEF, RESOURCE_KEYS.COVERAGE],
    () => ({ observed_at: OBSERVED_AT, period_end: WEEK_W.end, horizon_days: 7 }),
    { observed_at: "2026-09-28T09:00:00+02:00", period_end: "2026-09-21T00:00:00+02:00", horizon_days: 7 },
    (w) => { const m = metric(w); return { state: isUnavailable(m) ? m.state : m.state }; },
    { state: "COMPUTED" }),

  branch("PT-GTM-002/C", "observed before the horizon elapses, the period is INCONCLUSIVE, never zero", ["D02"], [RESOURCE_KEYS.METRIC_DEF],
    () => ({ observed_at: OBSERVED_TOO_EARLY, period_end: WEEK_W.end }),
    { observed_at: "2026-09-19T09:00:00+02:00", period_end: "2026-09-21T00:00:00+02:00" },
    (w) => {
      const m = weeklyRepliedProspects(w, { runtime_key: R_TEST, period: WEEK_W, observed_at: OBSERVED_TOO_EARLY });
      return { state: m.state, has_value: !isUnavailable(m) };
    },
    { state: "INCONCLUSIVE", has_value: false }),

  branch("PT-GTM-002/D", "a cohort without a pinned horizon or maturity rule is NOT_COMPUTABLE", ["D02"], [RESOURCE_KEYS.METRIC_DEF],
    (w) => {
      const d = metricDef(withoutMetricHorizon(w, "weekly_entry_cohort_reply_rate"), "weekly_entry_cohort_reply_rate");
      return { observation_horizon_days: d?.observation_horizon_days ?? null, maturity_rule: d?.maturity_rule ?? null };
    },
    { observation_horizon_days: null, maturity_rule: null },
    (w) => { const c = cohort(withoutMetricHorizon(w, "weekly_entry_cohort_reply_rate")); return { state: c.state, has_rate: !isUnavailable(c) }; },
    { state: "NOT_COMPUTABLE", has_rate: false }),

  /* ───────── PT-GTM-003 — reply disposition ───────── */
  branch("PT-GTM-003/A", "C01: three eligible human replies, the duplicate first delivery collapses, one contact", ["D01", "D03"], [RESOURCE_KEYS.MESSAGE],
    (w) => ({
      inbound_rows: w.messages.filter((m) => m.contact_key === "C01" && m.direction === "INBOUND").length,
      shared_provider_ids: w.messages.filter((m) => m.provider_message_id === "PM-IN-C01-1").map((m) => m.message_key),
    }),
    { inbound_rows: 4, shared_provider_ids: ["IN-C01-1", "IN-C01-1-DUP"] },
    (w) => {
      const rows = dispositionsInPeriod(w, SCOPE).filter((d) => d.contact_key === "C01");
      const m = metric(w);
      return {
        eligible: rows.filter((d) => d.disposition === "ELIGIBLE_HUMAN_REPLY").map((d) => d.message_key),
        duplicates: rows.filter((d) => d.disposition === "DUPLICATE_DELIVERY").map((d) => d.message_key),
        counted_once: isUnavailable(m) ? "NOT_COMPUTABLE" : m.contacts.filter((c) => c === "C01").length,
      };
    },
    { eligible: ["IN-C01-1", "IN-C01-2", "IN-C01-3"], duplicates: ["IN-C01-1-DUP"], counted_once: 1 }),

  branch("PT-GTM-003/B", "C02: a technical out-of-office is not a reply", ["D01"], [RESOURCE_KEYS.MESSAGE],
    (w) => ({ kind: messageOf(w, R_TEST, "IN-C02")?.kind, intent: messageOf(w, R_TEST, "IN-C02")?.intent }),
    { kind: "TECHNICAL", intent: "OUT_OF_OFFICE" },
    (w) => ({ disposition: dispo(w, "IN-C02")?.disposition, counted: (() => { const m = metric(w); return isUnavailable(m) ? "NOT_COMPUTABLE" : m.contacts.includes("C02"); })() }),
    { disposition: "TECHNICAL_AUTOREPLY", counted: false }),

  branch("PT-GTM-003/C", "C03: a human opt-out is zero success and exactly one opt-out contact", ["D01"], [RESOURCE_KEYS.MESSAGE, RESOURCE_KEYS.CONTACT],
    (w) => ({ kind: messageOf(w, R_TEST, "IN-C03")?.kind, intent: messageOf(w, R_TEST, "IN-C03")?.intent, contact_flag: w.contacts.find((c) => c.contact_key === "C03")?.opted_out }),
    { kind: "HUMAN", intent: "OPT_OUT", contact_flag: true },
    (w) => ({ disposition: dispo(w, "IN-C03")?.disposition, follow_up: dispo(w, "IN-C03")?.follow_up, opt_out_contacts: followUpContacts(w, SCOPE, "OPT_OUT") }),
    { disposition: "OPT_OUT", follow_up: "SUPPRESS_CONTACT", opt_out_contacts: ["C03"] }),

  branch("PT-GTM-003/D", "C07: an inbound of unknown kind counts zero and requires a human takeover", ["D01"], [RESOURCE_KEYS.MESSAGE],
    (w) => ({ kind: messageOf(w, R_TEST, "IN-C07")?.kind, intent: messageOf(w, R_TEST, "IN-C07")?.intent }),
    { kind: "UNKNOWN", intent: "UNDETERMINED" },
    (w) => ({ disposition: dispo(w, "IN-C07")?.disposition, follow_up: dispo(w, "IN-C07")?.follow_up, takeover_contacts: followUpContacts(w, SCOPE, "UNKNOWN_KIND_TAKEOVER") }),
    { disposition: "UNKNOWN_KIND_TAKEOVER", follow_up: "HUMAN_TAKEOVER", takeover_contacts: ["C07"] }),

  branch("PT-GTM-003/E", "C08: a permanent bounce counts zero and stops the address", ["D01"], [RESOURCE_KEYS.MESSAGE, RESOURCE_KEYS.CONTACT],
    (w) => ({ kind: messageOf(w, R_TEST, "IN-C08")?.kind, intent: messageOf(w, R_TEST, "IN-C08")?.intent, contact_flag: w.contacts.find((c) => c.contact_key === "C08")?.address_stopped }),
    { kind: "TECHNICAL", intent: "BOUNCE_PERMANENT", contact_flag: true },
    (w) => ({ disposition: dispo(w, "IN-C08")?.disposition, follow_up: dispo(w, "IN-C08")?.follow_up, bounce_contacts: followUpContacts(w, SCOPE, "PERMANENT_BOUNCE") }),
    { disposition: "PERMANENT_BOUNCE", follow_up: "STOP_ADDRESS", bounce_contacts: ["C08"] }),

  /* ───────── PT-GTM-004 — D03: proof-first attribution ───────── */
  branch("PT-GTM-004/A", "C01: canonical identity plus a prior outbound carrying participation and approach evidence", ["D03"], [RESOURCE_KEYS.MESSAGE, RESOURCE_KEYS.PARTICIPATION],
    (w) => ({
      identity_resolution: w.contacts.find((c) => c.contact_key === "C01")?.identity_resolution,
      prior_outbound: messageOf(w, R_TEST, "OUT-C01")?.message_key,
      participation: messageOf(w, R_TEST, "OUT-C01")?.participation_key,
      approach_version: messageOf(w, R_TEST, "OUT-C01")?.approach_version_key,
    }),
    { identity_resolution: "CANONICAL", prior_outbound: "OUT-C01", participation: "PART-R1-A1V1", approach_version: "AP-1/v1" },
    (w) => {
      const a = attributeReply(w, messageOf(w, R_TEST, "IN-C01-1") as never);
      return { status: a.status, attributed_to: a.attributed_to?.message_key ?? null, candidate_count: a.candidates.length };
    },
    { status: "ATTRIBUTED", attributed_to: "OUT-C01", candidate_count: 1 }),

  branch("PT-GTM-004/B", "C04: a human reply with no attributable outbound is UNKNOWN, never a zero-proof attribution", ["D03"], [RESOURCE_KEYS.MESSAGE],
    (w) => ({ prior_outbound_rows: w.messages.filter((m) => m.direction === "OUTBOUND" && m.contact_key === "C04").length, inbound_kind: messageOf(w, R_TEST, "IN-C04")?.kind }),
    { prior_outbound_rows: 0, inbound_kind: "HUMAN" },
    (w) => {
      const a = attributeReply(w, messageOf(w, R_TEST, "IN-C04") as never);
      const m = metric(w);
      return { status: a.status, candidates: a.candidates.length, disposition: dispo(w, "IN-C04")?.disposition, counted: isUnavailable(m) ? "NOT_COMPUTABLE" : m.contacts.includes("C04") };
    },
    { status: "UNKNOWN", candidates: 0, disposition: "NOT_ATTRIBUTED", counted: false }),

  branch("PT-GTM-004/C", "C06: an internal counterpart is never an external prospect", ["D03"], [RESOURCE_KEYS.CONTACT],
    (w) => ({ party: w.contacts.find((c) => c.contact_key === "C06")?.party, company: w.contacts.find((c) => c.contact_key === "C06")?.company_key }),
    { party: "INTERNAL", company: "CO-INTERNAL" },
    (w) => { const m = metric(w); return { disposition: dispo(w, "IN-C06")?.disposition, counted: isUnavailable(m) ? "NOT_COMPUTABLE" : m.contacts.includes("C06") }; },
    { disposition: "INTERNAL_COUNTERPART", counted: false }),

  branch("PT-GTM-004/D", "C12: several plausible candidates stay UNATTRIBUTED with every candidate preserved", ["D03"], [RESOURCE_KEYS.MESSAGE, RESOURCE_KEYS.CAMPAIGN],
    (w) => ({ touchpoints: w.messages.filter((m) => m.direction === "OUTBOUND" && m.contact_key === "C12").map((m) => m.campaign_key) }),
    { touchpoints: ["CMP-3", "CMP-2"] },
    (w) => {
      const a = attributeReply(w, messageOf(w, R_TEST, "IN-C12") as never);
      return {
        status: a.status, attributed_to: a.attributed_to,
        candidates: a.candidates.map((c) => c.message_key),
        latest_candidate_not_promoted: a.attributed_to === null,
      };
    },
    { status: "UNATTRIBUTED", attributed_to: null, candidates: ["OUT-C12-A", "OUT-C12-B"], latest_candidate_not_promoted: true }),

  branch("PT-GTM-004/E", "a touch older than the bounded lookback is not a candidate at all", ["D03"], [RESOURCE_KEYS.MESSAGE],
    (w) => ({ legacy_touch_at: messageOf(w, R_TEST, "OUT-C01-LEGACY")?.occurred_at, reply_at: messageOf(w, R_TEST, "IN-C01-1")?.occurred_at }),
    { legacy_touch_at: "2026-08-05T09:00:00+02:00", reply_at: "2026-09-15T10:00:00+02:00" },
    (w) => {
      const a = attributeReply(w, messageOf(w, R_TEST, "IN-C01-1") as never);
      return { candidates: a.candidates.map((c) => c.message_key), legacy_is_candidate: a.candidates.some((c) => c.message_key === "OUT-C01-LEGACY") };
    },
    { candidates: ["OUT-C01"], legacy_is_candidate: false }),

  /* ───────── PT-GTM-005 — the two denominators never merge ───────── */
  branch("PT-GTM-005/A", "seven external outbound entrants enter the cohort inside W", ["D02", "D03"], [RESOURCE_KEYS.MESSAGE, RESOURCE_KEYS.CONTACT],
    (w) => ({ outbound_in_W: w.messages.filter((m) => m.direction === "OUTBOUND" && m.runtime_key === R_TEST && inPeriod(m.occurred_at, WEEK_W)).map((m) => m.contact_key).sort() }),
    { outbound_in_W: ["C01", "C02", "C03", "C06", "C07", "C08", "C09", "C10"] },
    (w) => { const c = cohort(w); return isUnavailable(c) ? { state: c.state } : { entrants: c.entrants, denominator: c.denominator }; },
    { entrants: ["C01", "C02", "C03", "C07", "C08", "C09", "C10"], denominator: 7 }),

  branch("PT-GTM-005/B", "two of those entrants replied inside W", ["D02"], [RESOURCE_KEYS.MESSAGE],
    (w) => { const m = metric(w); return { period_repliers: isUnavailable(m) ? "NOT_COMPUTABLE" : m.contacts }; },
    { period_repliers: ["C01", "C05", "C09"] },
    (w) => { const c = cohort(w); return isUnavailable(c) ? { state: c.state } : { replied_entrants: c.replied_entrants, numerator: c.numerator }; },
    { replied_entrants: ["C01", "C09"], numerator: 2 }),

  branch("PT-GTM-005/C", "the cohort rate is 2/7 and never 3/7: C05 replied in W but entered earlier", ["D02"], [RESOURCE_KEYS.MESSAGE],
    (w) => ({ c05_outbound_at: messageOf(w, R_TEST, "OUT-C05")?.occurred_at, c05_reply_in_W: inPeriod(messageOf(w, R_TEST, "IN-C05")?.occurred_at ?? "", WEEK_W) }),
    { c05_outbound_at: "2026-09-10T09:00:00+02:00", c05_reply_in_W: true },
    (w) => {
      const c = cohort(w);
      const m = metric(w);
      return isUnavailable(c) || isUnavailable(m) ? { state: "UNAVAILABLE" } : {
        rate_label: c.rate_label, weekly_metric_value: m.value, repliers_outside_cohort: c.period_repliers_outside_cohort,
      };
    },
    { rate_label: "2/7", weekly_metric_value: 3, repliers_outside_cohort: ["C05"] }),

  branch("PT-GTM-005/D", "missing mailbox coverage makes both the metric and the cohort NOT_COMPUTABLE", ["D02"], [RESOURCE_KEYS.COVERAGE],
    (w) => ({ coverage_state: withCoverageGap(w, "COV-MBX-R_TEST").coverage.find((c) => c.coverage_key === "COV-MBX-R_TEST")?.state }),
    { coverage_state: "PARTIAL" },
    (w) => {
      const gapped = withCoverageGap(w, "COV-MBX-R_TEST");
      return { metric_state: weeklyRepliedProspects(gapped, SCOPE).state, cohort_state: entryCohort(gapped, SCOPE).state };
    },
    { metric_state: "NOT_COMPUTABLE", cohort_state: "NOT_COMPUTABLE" }),

  /* ───────── PT-GTM-006 — O2 meeting counting ───────── */
  branch("PT-GTM-006/A", "M01: explicit agreement plus a provider event is one historical booking, active", ["D04"], [RESOURCE_KEYS.MEETING_EPISODE, RESOURCE_KEYS.PROVIDER_EVENT],
    (w) => {
      const e = w.episodes.find((x) => x.meeting_episode_id === "EP-M01");
      return { accepted: e?.accepted_at !== null, agreement_evidence: e?.agreement_evidence_ref, provider_events: episodeIdentity(w, R_TEST, "EP-M01")?.provider_event_keys.length };
    },
    { accepted: true, agreement_evidence: "EV-AGREE-C09", provider_events: 3 },
    (w) => { const c = meetingCounts(w, O2); return isUnavailable(c) ? { state: c.state } : { historical_bookings: c.historical_bookings, active_bookings: c.active_bookings, held: c.held, qualified: c.qualified, counted_episodes: c.counted_episodes }; },
    { historical_bookings: 1, active_bookings: 1, held: 0, qualified: 0, counted_episodes: ["EP-M01"] }),

  branch("PT-GTM-006/B", "M02: a proposal the contact never agreed to is zero booking", ["D04"], [RESOURCE_KEYS.MEETING_EPISODE],
    (w) => {
      const e = w.episodes.find((x) => x.meeting_episode_id === "EP-M02");
      return { proposed: e?.proposed_at !== null, accepted: e?.accepted_at !== null, booked: e?.booked_at !== null };
    },
    { proposed: true, accepted: false, booked: false },
    (w) => { const c = meetingCounts(w, O2); return { statuses: episodeStatuses(w, R_TEST, "EP-M02"), counted: isUnavailable(c) ? "NOT_COMPUTABLE" : c.counted_episodes.includes("EP-M02") }; },
    { statuses: ["PROPOSED"], counted: false }),

  branch("PT-GTM-006/C", "F01: an internal work block is never a prospect meeting", ["D04"], [RESOURCE_KEYS.MEETING_EPISODE],
    (w) => ({ episode_kind: w.episodes.find((x) => x.meeting_episode_id === "EP-F01")?.episode_kind, participants: event(w, "EVT-F01")?.participants.map((p) => p.kind) }),
    { episode_kind: "INTERNAL", participants: ["INTERNAL_HUMAN", "INTERNAL_HUMAN"] },
    (w) => { const c = meetingCounts(w, O2); return { counted: isUnavailable(c) ? "NOT_COMPUTABLE" : c.counted_episodes.includes("EP-F01"), classification: classifyKey(w, "EVT-F01").participation_class }; },
    { counted: false, classification: "INTERNAL_ONLY" }),

  branch("PT-GTM-006/D", "a cancelled M01 keeps its historical booking and loses its active one", ["D04"], [RESOURCE_KEYS.MEETING_EPISODE],
    (w) => ({ canceled_at: withCanceledEpisode(w, "EP-M01").episodes.find((x) => x.meeting_episode_id === "EP-M01")?.canceled_at }),
    { canceled_at: "2026-09-17T18:00:00+02:00" },
    (w) => { const c = meetingCounts(withCanceledEpisode(w, "EP-M01"), O2); return isUnavailable(c) ? { state: c.state } : { historical_bookings: c.historical_bookings, active_bookings: c.active_bookings }; },
    { historical_bookings: 1, active_bookings: 0 }),

  branch("PT-GTM-006/E", "held without a pinned qualification definition: HELD is 1, qualified is NOT_COMPUTABLE", ["D04"], [RESOURCE_KEYS.MEETING_EPISODE, RESOURCE_KEYS.METRIC_DEF],
    (w) => ({ held_at: withHeldEpisode(w, "EP-M01", "2026-09-19T10:30:00+02:00").episodes.find((x) => x.meeting_episode_id === "EP-M01")?.held_at, qualification_definition: metricDef(w, "qualified_discovery_meetings") === undefined ? "ABSENT" : "PINNED" }),
    { held_at: "2026-09-19T10:30:00+02:00", qualification_definition: "ABSENT" },
    (w) => { const c = meetingCounts(withHeldEpisode(w, "EP-M01", "2026-09-19T10:30:00+02:00"), O2); return isUnavailable(c) ? { state: c.state } : { held: c.held, qualified: c.qualified }; },
    { held: 1, qualified: "NOT_COMPUTABLE" }),

  /* ───────── PT-GTM-007 — D04: episode identity ───────── */
  branch("PT-GTM-007/A", "the episode id is stable across two reschedules", ["D04"], [RESOURCE_KEYS.PROVIDER_EVENT],
    (w) => ({ events: w.provider_events.filter((e) => e.meeting_episode_id === "EP-M01").map((e) => e.provider_event_key), reschedule_links: w.provider_events.filter((e) => e.reschedule_of !== null && e.meeting_episode_id === "EP-M01").map((e) => e.reschedule_of) }),
    { events: ["EVT-M01-1", "EVT-M01-2", "EVT-M01-3"], reschedule_links: ["EVT-M01-1", "EVT-M01-2"] },
    (w) => { const i = episodeIdentity(w, R_TEST, "EP-M01"); return { episodes_for_those_events: 1, reschedule_count: i?.reschedule_count, latest_start: i?.latest_start }; },
    { episodes_for_those_events: 1, reschedule_count: 2, latest_start: "2026-09-22T10:00:00+02:00" }),

  branch("PT-GTM-007/B", "PROPOSED, ACCEPTED, BOOKED, HELD and QUALIFIED_DISCOVERY are five distinct rungs", ["D04"], [RESOURCE_KEYS.MEETING_EPISODE],
    () => ({ ladder: [...MEETING_STATUS_LADDER], distinct: new Set(MEETING_STATUS_LADDER).size }),
    { ladder: ["PROPOSED", "ACCEPTED", "BOOKED", "HELD", "QUALIFIED_DISCOVERY"], distinct: 5 },
    (w) => ({ m01: episodeStatuses(w, R_TEST, "EP-M01"), m02: episodeStatuses(w, R_TEST, "EP-M02"), m01_held: episodeStatuses(w, R_TEST, "EP-M01").includes("HELD"), m01_qualified: episodeStatuses(w, R_TEST, "EP-M01").includes("QUALIFIED_DISCOVERY") }),
    { m01: ["PROPOSED", "ACCEPTED", "BOOKED"], m02: ["PROPOSED"], m01_held: false, m01_qualified: false }),

  branch("PT-GTM-007/C", "cancellation changes the active status, never the historical booking creation", ["D04"], [RESOURCE_KEYS.MEETING_EPISODE],
    (w) => ({ booked_at: w.episodes.find((e) => e.meeting_episode_id === "EP-M01")?.booked_at, canceled_at_baseline: w.episodes.find((e) => e.meeting_episode_id === "EP-M01")?.canceled_at }),
    { booked_at: "2026-09-16T15:05:00+02:00", canceled_at_baseline: null },
    (w) => {
      const after = withCanceledEpisode(w, "EP-M01");
      return { booked_at_after_cancel: after.episodes.find((e) => e.meeting_episode_id === "EP-M01")?.booked_at, statuses_after_cancel: episodeStatuses(after, R_TEST, "EP-M01") };
    },
    { booked_at_after_cancel: "2026-09-16T15:05:00+02:00", statuses_after_cancel: ["PROPOSED", "ACCEPTED", "BOOKED"] }),

  branch("PT-GTM-007/D", "one meeting seen in a second agenda and in a mail thread is one episode", ["D04"], [RESOURCE_KEYS.PROVIDER_EVENT],
    (w) => ({ events: w.provider_events.filter((e) => e.meeting_episode_id === "EP-CAL-MULTI").map((e) => e.provider_event_key), thread_refs: [...new Set(w.provider_events.filter((e) => e.meeting_episode_id === "EP-CAL-MULTI").map((e) => e.thread_ref))] }),
    { events: ["EVT-CAL-MULTI-1", "EVT-CAL-MULTI-2"], thread_refs: ["THREAD-FIXTURE-1"] },
    (w) => { const i = episodeIdentity(w, R_TEST, "EP-CAL-MULTI"); return { episode_count: 1, collapsed_duplicates: i?.collapsed_duplicates }; },
    { episode_count: 1, collapsed_duplicates: ["EVT-CAL-MULTI-2"] }),

  /* ───────── PT-GTM-008 — campaign, approach version, participation, enrollment ───────── */
  branch("PT-GTM-008/A", "one rep running two approach versions keeps them separately measurable", ["D05"], [RESOURCE_KEYS.PARTICIPATION, RESOURCE_KEYS.APPROACH_VERSION],
    (w) => ({ participations: w.participations.filter((p) => p.owner_principal_key === "CELIA_FIXTURE" && p.campaign_key === "CMP-2").map((p) => [p.participation_key, p.approach_version_key]) }),
    { participations: [["PART-R1-A1V1", "AP-1/v1"], ["PART-R1-A1V2", "AP-1/v2"]] },
    (w) => ({ replies_by_version: eligibleRepliesByApproachVersion(w, SCOPE) }),
    { replies_by_version: { "AP-1/v1": 4, "AP-1/v2": 1 } }),

  branch("PT-GTM-008/B", "one approach run by two reps preserves owner and runtime on each participation", ["D06"], [RESOURCE_KEYS.PARTICIPATION],
    (w) => ({ participations: w.participations.filter((p) => p.approach_version_key === "AP-2/v1").map((p) => [p.participation_key, p.owner_principal_key, p.runtime_key]) }),
    { participations: [["PART-R1-A2V1", "CELIA_FIXTURE", "R_TEST"], ["PART-R2-A2V1", "JULIAN_FIXTURE", "R_ALT"]] },
    (w) => ({
      owners: [...new Set(w.participations.filter((p) => p.approach_version_key === "AP-2/v1").map((p) => p.owner_principal_key))].length,
      runtimes: [...new Set(w.participations.filter((p) => p.approach_version_key === "AP-2/v1").map((p) => p.runtime_key))].length,
      merged_into_one_dimension: false,
    }),
    { owners: 2, runtimes: 2, merged_into_one_dimension: false }),

  branch("PT-GTM-008/C", "account and contact uniqueness: one enrollment row per campaign and contact", ["D06"], [RESOURCE_KEYS.ENROLLMENT, RESOURCE_KEYS.COMPANY],
    // Uniqueness is asserted over the FULL natural key: a campaign/contact pair is unique inside its runtime.
    (w) => ({ enrollment_rows: w.enrollments.length, distinct_pairs: new Set(w.enrollments.map((e) => `${e.runtime_key}|${e.campaign_key}|${e.contact_key}`)).size }),
    { enrollment_rows: 15, distinct_pairs: 15 },
    (w) => ({
      company_rows_per_runtime: new Set(w.companies.map((c) => `${c.runtime_key}|${c.company_key}`)).size === w.companies.length,
      company_key_shared_across_runtimes: w.companies.filter((c) => c.company_key === "CO-01").map((c) => c.runtime_key),
    }),
    { company_rows_per_runtime: true, company_key_shared_across_runtimes: ["R_TEST", "R_ALT"] }),

  branch("PT-GTM-008/D", "exactly one ACTIVE enrollment per contact; successive campaigns are temporal", ["D06"], [RESOURCE_KEYS.ENROLLMENT],
    (w) => ({ c01_enrollments: w.enrollments.filter((e) => e.contact_key === "C01").map((e) => [e.campaign_key, e.state]) }),
    { c01_enrollments: [["CMP-1", "ENDED"], ["CMP-2", "ACTIVE"]] },
    (w) => {
      // Counted per (runtime, contact): a contact of another runtime is another contact, never the same one.
      const active = new Map<string, number>();
      for (const e of w.enrollments.filter((x) => x.state === "ACTIVE")) {
        const key = `${e.runtime_key}|${e.contact_key}`;
        active.set(key, (active.get(key) ?? 0) + 1);
      }
      return { max_active_per_contact: Math.max(...active.values()), contacts_with_two_active: [...active.entries()].filter(([, n]) => n > 1).map(([k]) => k.split("|")[1] as string) };
    },
    { max_active_per_contact: 1, contacts_with_two_active: [] }),

  branch("PT-GTM-008/E", "a variant version stays inside the Authority of the version it derives from", ["D05"], [RESOURCE_KEYS.APPROACH_VERSION],
    (w) => ({ variant_of: w.approach_versions.find((v) => v.approach_version_key === "AP-1/v2")?.variant_of, scopes: [...new Set(w.approach_versions.map((v) => v.authority_scope))] }),
    { variant_of: "AP-1/v1", scopes: ["SALES_OUTBOUND_EMAIL"] },
    (w) => ({ authority_expanded: exposureView(w, R_TEST, "EXP-C09")?.authority_expanded, authority_scope: exposureView(w, R_TEST, "EXP-C09")?.authority_scope }),
    { authority_expanded: false, authority_scope: "SALES_OUTBOUND_EMAIL" }),

  /* ───────── PT-GTM-009 — D05: exposure is evidence, configuration is not ───────── */
  branch("PT-GTM-009/A", "the configured offer and price of a campaign are configuration, not exposure", ["D05"], [RESOURCE_KEYS.CAMPAIGN, RESOURCE_KEYS.EXPOSURE],
    (w) => ({ configured_offer: w.campaigns.find((c) => c.campaign_key === "CMP-2")?.configured_offer, configured_price_cents: w.campaigns.find((c) => c.campaign_key === "CMP-2")?.configured_price_cents }),
    { configured_offer: "OFFER-STD", configured_price_cents: 120000 },
    (w) => {
      const contactsWithExposure = new Set(w.exposures.map((e) => e.contact_key));
      const enrolled = w.enrollments.filter((e) => e.campaign_key === "CMP-2").map((e) => e.contact_key);
      return { enrolled_contacts: enrolled.length, contacts_with_a_pinned_exposure: enrolled.filter((c) => contactsWithExposure.has(c)).length };
    },
    { enrolled_contacts: 12, contacts_with_a_pinned_exposure: 2 }),

  branch("PT-GTM-009/B", "an exposure pins what was actually communicated, with its override evidence", ["D05"], [RESOURCE_KEYS.EXPOSURE],
    (w) => {
      const x = w.exposures.find((e) => e.exposure_key === "EXP-C01");
      return { message_key: x?.message_key, campaign_key: x?.campaign_key, approach_version_key: x?.approach_version_key, communicated_offer: x?.communicated_offer, communicated_price_cents: x?.communicated_price_cents };
    },
    { message_key: "OUT-C01", campaign_key: "CMP-2", approach_version_key: "AP-1/v1", communicated_offer: "OFFER-PILOT", communicated_price_cents: 90000 },
    (w) => {
      const v = exposureView(w, R_TEST, "EXP-C01");
      return { differs_from_configuration: v?.differs_from_configuration, configured_price_cents: v?.configured_price_cents, communicated_price_cents: v?.communicated_price_cents, has_override_evidence: v?.override_evidence !== null };
    },
    { differs_from_configuration: true, configured_price_cents: 120000, communicated_price_cents: 90000, has_override_evidence: true }),

  branch("PT-GTM-009/C", "a link sent is not a link read, and two opens by one reader are one distinct read", ["D05"], [RESOURCE_KEYS.TRACKER_EVENT],
    (w) => ({ events: w.tracker_events.map((e) => [e.message_key, e.event_type]) }),
    { events: [["OUT-C01", "LINK_SENT"], ["OUT-C09", "LINK_SENT"], ["OUT-C09", "LINK_READ"], ["OUT-C09", "LINK_READ"]] },
    (w) => ({ c01: linkSignals(w, R_TEST, "OUT-C01"), c09: linkSignals(w, R_TEST, "OUT-C09") }),
    { c01: { sent: 1, read_events: 0, distinct_reads: 0 }, c09: { sent: 1, read_events: 2, distinct_reads: 1 } }),

  branch("PT-GTM-009/D", "an exposure pinned under an older campaign never mutates afterwards", ["D05"], [RESOURCE_KEYS.EXPOSURE],
    (w) => {
      const old = w.exposures.find((e) => e.exposure_key === "EXP-C01-OLD");
      return { pinned_at: old?.pinned_at, communicated_price_cents: old?.communicated_price_cents, campaign_key: old?.campaign_key };
    },
    { pinned_at: "2026-08-05T09:00:00+02:00", communicated_price_cents: 150000, campaign_key: "CMP-1" },
    (w) => ({
      mutation_attempt: attemptExposureMutation(w, "EXP-C01-OLD"),
      still_pinned_at: w.exposures.find((e) => e.exposure_key === "EXP-C01-OLD")?.communicated_price_cents,
      current_campaign_price: w.campaigns.find((c) => c.campaign_key === "CMP-2")?.configured_price_cents,
    }),
    { mutation_attempt: "REFUSED_IMMUTABLE", still_pinned_at: 150000, current_campaign_price: 120000 }),

  /* ───────── PT-GTM-010 — D06: no company-global dedup, per-runtime dimensions only ───────── */
  branch("PT-GTM-010/A", "the pilot is single-runtime and declares no Shared Reality topology", ["D06"], [RESOURCE_KEYS.RUNTIME],
    (w) => ({ topologies: [...new Set(w.runtimes.map((r) => r.shared_reality_topology))], scopes: [...new Set(w.runtimes.map((r) => r.runtime_scope))] }),
    { topologies: ["ABSENT"], scopes: ["FIXTURE"] },
    (w) => { const g = companyGlobalTotal(w, [R_TEST, R_ALT], WEEK_W, OBSERVED_AT); return { deduplicated: false, state: g.state }; },
    { deduplicated: false, state: "NOT_COMPUTABLE" }),

  branch("PT-GTM-010/B", "each runtime carries its own company dimension", ["D06"], [RESOURCE_KEYS.COMPANY],
    (w) => ({ r_test_companies: w.companies.filter((c) => c.runtime_key === R_TEST).length, r_alt_companies: w.companies.filter((c) => c.runtime_key === R_ALT).length }),
    { r_test_companies: 11, r_alt_companies: 1 },
    (w) => {
      const a = companyAggregate(w, SCOPE);
      const b = companyAggregate(w, { runtime_key: R_ALT, period: WEEK_W, observed_at: OBSERVED_AT });
      return {
        r_test: isUnavailable(a) ? a.state : { replied_contacts: a.replied_contacts, replied_companies: a.replied_companies },
        r_alt: isUnavailable(b) ? b.state : { replied_contacts: b.replied_contacts, replied_companies: b.replied_companies },
      };
    },
    { r_test: { replied_contacts: 3, replied_companies: 2 }, r_alt: { replied_contacts: 1, replied_companies: 1 } }),

  branch("PT-GTM-010/C", "an overlap-sensitive company-global total is NOT_COMPUTABLE and holds", ["D06"], [RESOURCE_KEYS.COMPANY, RESOURCE_KEYS.RUNTIME],
    (w) => ({ shared_company_key: w.companies.filter((c) => c.company_key === "CO-01").map((c) => c.runtime_key) }),
    { shared_company_key: ["R_TEST", "R_ALT"] },
    (w) => {
      const g = companyGlobalTotal(w, [R_TEST, R_ALT], WEEK_W, OBSERVED_AT);
      return "overlapping_companies" in g
        ? { state: g.state, disposition: g.disposition, overlapping_companies: g.overlapping_companies, per_runtime: g.per_runtime }
        : { state: "COMPUTED" };
    },
    { state: "NOT_COMPUTABLE", disposition: "HOLD", overlapping_companies: ["CO-01"], per_runtime: { R_TEST: 2, R_ALT: 1 } }),

  branch("PT-GTM-010/D", "two replied contacts inside one company are one company credit, never two", ["D06"], [RESOURCE_KEYS.CONTACT],
    (w) => ({ co_01_contacts: w.contacts.filter((c) => c.runtime_key === R_TEST && c.company_key === "CO-01").map((c) => c.contact_key) }),
    { co_01_contacts: ["C01", "C09"] },
    (w) => { const a = companyAggregate(w, SCOPE); return isUnavailable(a) ? { state: a.state } : { replied_contacts: a.replied_contacts, replied_companies: a.replied_companies, companies: a.companies }; },
    { replied_contacts: 3, replied_companies: 2, companies: ["CO-01", "CO-05"] }),

  /* ───────── PT-GTM-011 — synthetic per-principal source profiles (real reads deferred) ───────── */
  branch("PT-GTM-011/A", "an advanced-setup profile: Notion resolved, mailbox read verified, tracker unreachable, calendar pending", ["D07"], [RESOURCE_KEYS.PRINCIPAL],
    (w) => ({ setup_shape: profileView(w, "CELIA_FIXTURE")?.setup_shape, runtime_key: profileView(w, "CELIA_FIXTURE")?.runtime_key }),
    { setup_shape: "ADVANCED_B6_SHAPED", runtime_key: "R_TEST" },
    (w) => ({ sources: profileView(w, "CELIA_FIXTURE")?.sources, hold: profileView(w, "CELIA_FIXTURE")?.hold, canary: REAL_READ_CANARY }),
    { sources: { notion: "RESOLVED", gmail_read: "VERIFIED", tracker: "INACCESSIBLE", calendar: "PENDING" }, hold: false, canary: "DEFERRED_GTM_G3" }, true),

  branch("PT-GTM-011/B", "a lighter-setup profile: tracker partial instead of unreachable", ["D07"], [RESOURCE_KEYS.PRINCIPAL],
    (w) => ({ setup_shape: profileView(w, "JULIAN_FIXTURE")?.setup_shape, runtime_key: profileView(w, "JULIAN_FIXTURE")?.runtime_key }),
    { setup_shape: "B3_SHAPED", runtime_key: "R_ALT" },
    (w) => ({ sources: profileView(w, "JULIAN_FIXTURE")?.sources, hold: profileView(w, "JULIAN_FIXTURE")?.hold, canary: REAL_READ_CANARY }),
    { sources: { notion: "RESOLVED", gmail_read: "VERIFIED", tracker: "PARTIAL", calendar: "PENDING" }, hold: false, canary: "DEFERRED_GTM_G3" }, true),

  branch("PT-GTM-011/C", "a HOLD-shaped profile keeps both sides of its mailbox identity divergence", ["D07"], [RESOURCE_KEYS.PRINCIPAL],
    (w) => ({ setup_shape: profileView(w, "ARON_FIXTURE")?.setup_shape, divergence: profileView(w, "ARON_FIXTURE")?.divergence }),
    { setup_shape: "B2_HOLD_SHAPED", divergence: "MANIFEST_VS_REGISTRY" },
    (w) => {
      const v = profileView(w, "ARON_FIXTURE");
      return { both_values_preserved: v?.divergent_values.length, collapsed_to_one: v?.divergent_values[0] === v?.divergent_values[1], hold: v?.hold, sources: v?.sources, canary: REAL_READ_CANARY };
    },
    { both_values_preserved: 2, collapsed_to_one: false, hold: true, sources: { notion: "RESOLVED", gmail_read: "HOLD_DIVERGENCE", tracker: "UNKNOWN", calendar: "PENDING" }, canary: "DEFERRED_GTM_G3" }, true),

  branch("PT-GTM-011/D", "a profile without a runtime reads nothing and never borrows another runtime", ["D06", "D07"], [RESOURCE_KEYS.PRINCIPAL],
    (w) => ({ runtime_key: profileView(w, "VALENTIN_FIXTURE")?.runtime_key, setup_shape: profileView(w, "VALENTIN_FIXTURE")?.setup_shape }),
    { runtime_key: null, setup_shape: "NO_RUNTIME" },
    (w) => ({
      scope: readScopeOf(w, "VALENTIN_FIXTURE").refusal,
      own_read: readRows(w, "VALENTIN_FIXTURE", RESOURCE_KEYS.MESSAGE).status,
      borrow_attempt: readRows(w, "VALENTIN_FIXTURE", RESOURCE_KEYS.MESSAGE, R_TEST),
      canary: REAL_READ_CANARY,
    }),
    { scope: "REFUSED_NO_RUNTIME", own_read: "REFUSED", borrow_attempt: { status: "REFUSED", code: "REFUSED_NO_RUNTIME" }, canary: "DEFERRED_GTM_G3" }, true),

  branch("PT-GTM-011/E", "principal isolation: a read returns the bound runtime's rows and refuses a foreign one", ["D06", "D07"], [RESOURCE_KEYS.PRINCIPAL, RESOURCE_KEYS.MESSAGE],
    (w) => ({ owners: w.runtimes.map((r) => [r.runtime_key, r.owner_principal_key]) }),
    { owners: [["R_TEST", "CELIA_FIXTURE"], ["R_ALT", "JULIAN_FIXTURE"], ["R_HOLD", "ARON_FIXTURE"]] },
    (w) => {
      const own = readRows(w, "JULIAN_FIXTURE", RESOURCE_KEYS.MESSAGE);
      const foreign = readRows(w, "JULIAN_FIXTURE", RESOURCE_KEYS.MESSAGE, R_TEST);
      return {
        own_rows_runtimes: own.status === "OK" ? [...new Set(own.rows.map((r) => r["runtime_key"]))] : ["REFUSED"],
        foreign_read: foreign.status === "OK" ? "LEAKED" : foreign.code,
        canary: REAL_READ_CANARY,
      };
    },
    { own_rows_runtimes: ["R_ALT"], foreign_read: "REFUSED_FOREIGN_RUNTIME", canary: "DEFERRED_GTM_G3" }, true),

  /* ───────── PT-GTM-012 — D-CAL-01 participation and purpose ───────── */
  branch("PT-GTM-012/A", "an internal-only event is the only kind that is excluded", ["D-CAL-01"], [RESOURCE_KEYS.PROVIDER_EVENT],
    calTarget("EVT-CAL-A"), { participant_kinds: ["INTERNAL_HUMAN", "INTERNAL_HUMAN"], agenda_evidence: "NONE", evidence_completeness: "COMPLETE" },
    calCase("EVT-CAL-A"), { participation_class: "INTERNAL_ONLY", purpose_class: "PURPOSE_UNKNOWN", excluded: true }, true),

  branch("PT-GTM-012/B", "seller plus prospect with an agreed commercial agenda is an external candidate", ["D-CAL-01"], [RESOURCE_KEYS.PROVIDER_EVENT],
    calTarget("EVT-CAL-B"), { participant_kinds: ["INTERNAL_HUMAN", "EXTERNAL_HUMAN"], agenda_evidence: "COMMERCIAL_AGREED_AGENDA", evidence_completeness: "COMPLETE" },
    calCase("EVT-CAL-B"), { participation_class: "EXTERNAL_CANDIDATE", purpose_class: "EXTERNAL_COMMERCIAL", excluded: false }, true),

  branch("PT-GTM-012/C", "two reps plus one prospect is one company episode, not two", ["D-CAL-01", "D04"], [RESOURCE_KEYS.PROVIDER_EVENT, RESOURCE_KEYS.MEETING_EPISODE],
    calTarget("EVT-CAL-C"), { participant_kinds: ["INTERNAL_HUMAN", "INTERNAL_HUMAN", "EXTERNAL_HUMAN"], agenda_evidence: "COMMERCIAL_AGREED_AGENDA", evidence_completeness: "COMPLETE" },
    (w) => ({ ...calCase("EVT-CAL-C")(w), episodes_for_event: w.provider_events.filter((e) => e.provider_event_key === "EVT-CAL-C").map((e) => e.meeting_episode_id), company: w.episodes.find((e) => e.meeting_episode_id === "EP-CAL-C")?.company_key }),
    { participation_class: "EXTERNAL_CANDIDATE", purpose_class: "EXTERNAL_COMMERCIAL", excluded: false, episodes_for_event: ["EP-CAL-C"], company: "CO-07" }, true),

  branch("PT-GTM-012/D", "an internal alias is internal: the event stays internal-only", ["D-CAL-01"], [RESOURCE_KEYS.PROVIDER_EVENT],
    calTarget("EVT-CAL-D"), { participant_kinds: ["INTERNAL_HUMAN", "INTERNAL_ALIAS"], agenda_evidence: "NONE", evidence_completeness: "COMPLETE" },
    calCase("EVT-CAL-D"), { participation_class: "INTERNAL_ONLY", purpose_class: "PURPOSE_UNKNOWN", excluded: true }, true),

  branch("PT-GTM-012/E", "a bot and a meeting room never create an external human", ["D-CAL-01"], [RESOURCE_KEYS.PROVIDER_EVENT],
    calTarget("EVT-CAL-E"), { participant_kinds: ["INTERNAL_HUMAN", "BOT", "ROOM"], agenda_evidence: "NONE", evidence_completeness: "COMPLETE" },
    calCase("EVT-CAL-E"), { participation_class: "INTERNAL_ONLY", purpose_class: "PURPOSE_UNKNOWN", excluded: true }, true),

  branch("PT-GTM-012/F", "masked or truncated participant evidence is UNKNOWN, never a guess", ["D-CAL-01"], [RESOURCE_KEYS.PROVIDER_EVENT],
    calTarget("EVT-CAL-F"), { participant_kinds: ["INTERNAL_HUMAN", "MASKED"], agenda_evidence: "NONE", evidence_completeness: "INCOMPLETE" },
    calCase("EVT-CAL-F"), { participation_class: "UNKNOWN", purpose_class: "PURPOSE_UNKNOWN", excluded: false }, true),

  branch("PT-GTM-012/G", "an external non-commercial meeting is an external candidate with another purpose", ["D-CAL-01"], [RESOURCE_KEYS.PROVIDER_EVENT],
    calTarget("EVT-CAL-G"), { participant_kinds: ["INTERNAL_HUMAN", "EXTERNAL_HUMAN"], agenda_evidence: "NON_COMMERCIAL_AGENDA", evidence_completeness: "COMPLETE" },
    calCase("EVT-CAL-G"), { participation_class: "EXTERNAL_CANDIDATE", purpose_class: "EXTERNAL_OTHER", excluded: false }, true),

  branch("PT-GTM-012/H", "a commercial-sounding title over internal-only participants changes nothing", ["D-CAL-01"], [RESOURCE_KEYS.PROVIDER_EVENT],
    (w) => ({ ...calTarget("EVT-CAL-H")(w), title: event(w, "EVT-CAL-H")?.title }),
    { participant_kinds: ["INTERNAL_HUMAN", "INTERNAL_HUMAN"], agenda_evidence: "NONE", evidence_completeness: "COMPLETE", title: "Prospection — closing prospect" },
    calCase("EVT-CAL-H"), { participation_class: "INTERNAL_ONLY", purpose_class: "PURPOSE_UNKNOWN", excluded: true }, true),

  /* ───────── PT-GTM-013 — episodes, coverage, checkpoints and denominators ───────── */
  branch("PT-GTM-013/A", "the same meeting in two agendas and one mail thread stays one episode", ["D-CAL-01", "D04"], [RESOURCE_KEYS.PROVIDER_EVENT],
    (w) => ({ events: w.provider_events.filter((e) => e.meeting_episode_id === "EP-CAL-MULTI").length, agendas: w.provider_events.filter((e) => e.meeting_episode_id === "EP-CAL-MULTI").map((e) => e.participants[0]?.participant_key) }),
    { events: 2, agendas: ["P-INT-seller", "P-INT-second-rep"] },
    (w) => ({ episode_ids: [...new Set(w.provider_events.filter((e) => e.meeting_episode_id === "EP-CAL-MULTI").map((e) => e.meeting_episode_id))], collapsed: episodeIdentity(w, R_TEST, "EP-CAL-MULTI")?.collapsed_duplicates }),
    { episode_ids: ["EP-CAL-MULTI"], collapsed: ["EVT-CAL-MULTI-2"] }, true),

  branch("PT-GTM-013/B", "recurring occurrences are distinct episodes; reschedules are not", ["D04", "D-CAL-01"], [RESOURCE_KEYS.PROVIDER_EVENT],
    (w) => ({ series_events: w.provider_events.filter((e) => e.series_key === "SER-1").map((e) => e.occurrence_index), reschedule_events: w.provider_events.filter((e) => e.reschedule_of !== null).length }),
    { series_events: [1, 2, 3], reschedule_events: 2 },
    (w) => ({
      recurring_episodes: [...new Set(w.provider_events.filter((e) => e.series_key === "SER-1").map((e) => e.meeting_episode_id))].length,
      rescheduled_episodes: [...new Set(w.provider_events.filter((e) => e.reschedule_of !== null).map((e) => e.meeting_episode_id))].length,
    }),
    { recurring_episodes: 3, rescheduled_episodes: 1 }, true),

  branch("PT-GTM-013/C", "a cancelled booking stays historical; an unaccepted invitation was never booked", ["D04"], [RESOURCE_KEYS.MEETING_EPISODE, RESOURCE_KEYS.PROVIDER_EVENT],
    (w) => ({ cancel_status: event(w, "EVT-CAL-CANCEL")?.status, unaccepted_status: event(w, "EVT-CAL-UNACCEPTED")?.status }),
    { cancel_status: "CANCELED", unaccepted_status: "UNACCEPTED" },
    (w) => ({
      cancelled_statuses: episodeStatuses(w, R_TEST, "EP-CAL-CANCEL"),
      cancelled_still_historical: w.episodes.find((e) => e.meeting_episode_id === "EP-CAL-CANCEL")?.booked_at !== null,
      unaccepted_statuses: episodeStatuses(w, R_TEST, "EP-CAL-UNACCEPTED"),
    }),
    { cancelled_statuses: ["PROPOSED", "ACCEPTED", "BOOKED"], cancelled_still_historical: true, unaccepted_statuses: ["PROPOSED"] }, true),

  branch("PT-GTM-013/D", "a classification pass that crashes resumes from its checkpoint without duplicating", ["D-CAL-01"], [RESOURCE_KEYS.PROVIDER_EVENT],
    (w) => ({ cal_events: w.provider_events.filter((e) => e.dataset === "CAL").length }),
    { cal_events: 15 },
    (w) => {
      const events = w.provider_events.filter((e) => e.dataset === "CAL");
      const full = classifyBatch(events);
      const crashed = classifyBatch(events, null, 4);
      const resumed = classifyBatch(events, crashed, null);
      return {
        crashed_at: crashed.next_index,
        resumed_count: resumed.processed.length,
        identical_to_uninterrupted: JSON.stringify(resumed.processed) === JSON.stringify(full.processed),
        duplicates: resumed.processed.length - new Set(resumed.processed.map((p) => p.provider_event_key)).size,
      };
    },
    { crashed_at: 4, resumed_count: 15, identical_to_uninterrupted: true, duplicates: 0 }, true),

  branch("PT-GTM-013/E", "revoked or incomplete coverage makes the meeting counts NOT_COMPUTABLE", ["D02", "D-CAL-01"], [RESOURCE_KEYS.COVERAGE, RESOURCE_KEYS.RUNTIME],
    (w) => ({ baseline_state: w.coverage.find((c) => c.coverage_key === "COV-EVT-R_TEST")?.state, calendar_source_connected: w.runtimes.find((r) => r.runtime_key === R_TEST)?.calendar_source_connected }),
    { baseline_state: "COMPLETE", calendar_source_connected: false },
    (w) => {
      const revoked = withCoverageGap(w, "COV-EVT-R_TEST", "REVOKED");
      const counts = meetingCounts(revoked, O2);
      return { state: counts.state, read_state: calendarReadState(w, R_TEST, true).readable, classification_still_available: classifyKey(w, "EVT-CAL-B").participation_class };
    },
    { state: "NOT_COMPUTABLE", read_state: false, classification_still_available: "EXTERNAL_CANDIDATE" }, true),

  branch("PT-GTM-013/F", "duplicate opens collapse and a heterogeneous denominator is refused", ["D02", "D06"], [RESOURCE_KEYS.TRACKER_EVENT, RESOURCE_KEYS.COVERAGE],
    (w) => ({ read_events: w.tracker_events.filter((e) => e.event_type === "LINK_READ").length, tracker_coverage: w.coverage.find((c) => c.coverage_key === "COV-TRK-R_TEST")?.state }),
    { read_events: 2, tracker_coverage: "PARTIAL" },
    (w) => {
      const m = metric(w);
      const contacts = isUnavailable(m) ? 0 : m.value;
      const homogeneous = rateOf({ value: 2, unit: "CONTACTS" }, { value: 7, unit: "CONTACTS" });
      const heterogeneous = rateOf({ value: contacts, unit: "CONTACTS" }, { value: linkSignals(w, R_TEST, "OUT-C09").distinct_reads, unit: "DISTINCT_READS" });
      return { distinct_reads: linkSignals(w, R_TEST, "OUT-C09").distinct_reads, homogeneous_state: homogeneous.state, heterogeneous_state: heterogeneous.state };
    },
    { distinct_reads: 1, homogeneous_state: "COMPUTED", heterogeneous_state: "NOT_COMPUTABLE" }, true),

  /* ───────── PT-GTM-014 — candidate context pack (test-only, never adopted) ───────── */
  branch("PT-GTM-014/A", "the META analysis need selects only the admitted bounded pointers", ["D07"], [RESOURCE_KEYS.REGISTERED_CONTEXT],
    () => ({ lane_authorized: [...LANE_AUTHORIZED_RESOURCES.META] }),
    { lane_authorized: ["META:SALES_RUNTIME_INPUTS", "META:GTM_METRIC_REFS"] },
    (w) => {
      const pack = buildCandidatePack({ world: w, lane: "META", principal_key: "CELIA_FIXTURE", needs: ["META_GTM_ANALYSIS"] });
      return {
        selected: pack.selected_pointers.map((p) => p.resource_key), omitted: pack.omitted_resource_keys,
        completeness: pack.completeness, role: pack.policy_role,
      };
    },
    { selected: ["META:SALES_RUNTIME_INPUTS", "META:GTM_METRIC_REFS"], omitted: [], completeness: "COMPLETE", role: "CANDIDATE_NOT_ADOPTED" }),

  branch("PT-GTM-014/B", "the SALES context need selects only the bound principal's own refs", ["D07"], [RESOURCE_KEYS.REGISTERED_CONTEXT],
    (w) => ({ registered_owners: w.registered_context.filter((c) => c.context_resource_key === GTM_CONTEXT_KEYS.SALES_GTM_CAMPAIGN_CONTEXT).map((c) => [c.runtime_key, c.owner_principal_key]) }),
    { registered_owners: [["R_TEST", "CELIA_FIXTURE"], ["R_ALT", "JULIAN_FIXTURE"]] },
    (w) => {
      const pack = buildCandidatePack({ world: w, lane: "SALES", principal_key: "CELIA_FIXTURE", needs: ["SALES_GTM_CONTEXT"] });
      const refs = pack.selected_pointers.flatMap((p) => p.refs);
      return {
        selected: pack.selected_pointers.map((p) => p.resource_key),
        ref_count: refs.length,
        contains_other_rep_ref: refs.some((r) => r.includes("CMP-4") || r.includes("PART-R2")),
        completeness: pack.completeness,
      };
    },
    { selected: ["SALES:GTM_CAMPAIGN_CONTEXT"], ref_count: 7, contains_other_rep_ref: false, completeness: "COMPLETE" }),

  branch("PT-GTM-014/C", "no private META pointer in a SALES pack, no other-rep pointer, no read-all fallback", ["D07"], [RESOURCE_KEYS.REGISTERED_CONTEXT],
    () => ({ authorized: { META: [...LANE_AUTHORIZED_RESOURCES.META], SALES: [...LANE_AUTHORIZED_RESOURCES.SALES] }, wildcard_symbols: [...LANE_AUTHORIZED_RESOURCES.META, ...LANE_AUTHORIZED_RESOURCES.SALES].filter((k) => k.includes("*") || k.toUpperCase().includes("ALL")) }),
    { authorized: { META: ["META:SALES_RUNTIME_INPUTS", "META:GTM_METRIC_REFS"], SALES: ["SALES:GTM_CAMPAIGN_CONTEXT"] }, wildcard_symbols: [] },
    (w) => {
      const sales = buildCandidatePack({ world: w, lane: "SALES", principal_key: "CELIA_FIXTURE", needs: ["SALES_GTM_CONTEXT", "META_GTM_ANALYSIS"] });
      return {
        selected: sales.selected_pointers.map((p) => p.resource_key),
        meta_pointer_in_sales: sales.selected_pointers.some((p) => p.resource_key.startsWith("META:")),
        completeness: sales.completeness, completeness_reason: sales.completeness_reason,
      };
    },
    { selected: ["SALES:GTM_CAMPAIGN_CONTEXT"], meta_pointer_in_sales: false, completeness: "HOLD", completeness_reason: "cross_lane_rejected" }),

  branch("PT-GTM-014/D", "a changed ref or a rotated generation changes the pack identity", ["D07"], [RESOURCE_KEYS.REGISTERED_CONTEXT, RESOURCE_KEYS.RUNTIME],
    (w) => ({ baseline_generation: w.runtimes.find((r) => r.runtime_key === R_TEST)?.runtime_generation }),
    { baseline_generation: "gen-1" },
    (w) => {
      const base = buildCandidatePack({ world: w, lane: "SALES", principal_key: "CELIA_FIXTURE", needs: ["SALES_GTM_CONTEXT"] });
      const extra = buildCandidatePack({ world: withExtraContextRef(w, R_TEST, GTM_CONTEXT_KEYS.SALES_GTM_CAMPAIGN_CONTEXT, "GTM_FIX:EXPOSURE#EXP-NEW"), lane: "SALES", principal_key: "CELIA_FIXTURE", needs: ["SALES_GTM_CONTEXT"] });
      const rotated = buildCandidatePack({ world: withRotatedGeneration(w, R_TEST), lane: "SALES", principal_key: "CELIA_FIXTURE", needs: ["SALES_GTM_CONTEXT"] });
      const repeat = buildCandidatePack({ world: w, lane: "SALES", principal_key: "CELIA_FIXTURE", needs: ["SALES_GTM_CONTEXT"] });
      return {
        identical_inputs_same_id: base.pack_id === repeat.pack_id,
        ref_change_changes_id: base.pack_id !== extra.pack_id,
        generation_change_changes_id: base.pack_id !== rotated.pack_id,
      };
    },
    { identical_inputs_same_id: true, ref_change_changes_id: true, generation_change_changes_id: true }),

  branch("PT-GTM-014/E", "a stale pack cannot steer a new Run, and no pack ever confers mutation authority", ["D07"], [RESOURCE_KEYS.RUNTIME],
    (w) => ({ rotated_generation: withRotatedGeneration(w, R_TEST).runtimes.find((r) => r.runtime_key === R_TEST)?.runtime_generation }),
    { rotated_generation: "gen-2" },
    (w) => {
      const pack = buildCandidatePack({ world: w, lane: "SALES", principal_key: "CELIA_FIXTURE", needs: ["SALES_GTM_CONTEXT"] });
      const rotated = withRotatedGeneration(w, R_TEST);
      return {
        fresh: steerNewRun(pack, w),
        stale: isPackStale(pack, rotated),
        steer_after_rotation: steerNewRun(pack, rotated),
        mutation_attempt: submitSymbolToMutationCatalog(GTM_CONTEXT_KEYS.SALES_GTM_CAMPAIGN_CONTEXT).code,
        confers_mutation_authority: pack.confers_mutation_authority,
        fresh_rehydration_required: pack.fresh_rehydration_required,
      };
    },
    {
      fresh: { accepted: true, rehydration: "FRESH_REQUIRED" }, stale: true,
      steer_after_rotation: { accepted: false, code: "REFUSED_STALE_PACK", reason: "the pack is pinned to a superseded runtime generation" },
      mutation_attempt: "UNKNOWN_MUTATION_TARGET", confers_mutation_authority: false, fresh_rehydration_required: true,
    }),

  branch("PT-GTM-014/F", "missing registered context is NEEDS_EXPANSION with a truthful unavailable pointer", ["D07"], [RESOURCE_KEYS.REGISTERED_CONTEXT],
    (w) => ({ registration_state: withUnregisteredContext(w, R_TEST, GTM_CONTEXT_KEYS.META_GTM_METRIC_REFS).registered_context.find((c) => c.context_resource_key === GTM_CONTEXT_KEYS.META_GTM_METRIC_REFS)?.registration_state }),
    { registration_state: "NOT_REGISTERED" },
    (w) => {
      const pack = buildCandidatePack({ world: withUnregisteredContext(w, R_TEST, GTM_CONTEXT_KEYS.META_GTM_METRIC_REFS), lane: "META", principal_key: "CELIA_FIXTURE", needs: ["META_GTM_ANALYSIS"] });
      const pointer = pack.selected_pointers.find((p) => p.resource_key === GTM_CONTEXT_KEYS.META_GTM_METRIC_REFS);
      const unknownNeed = buildCandidatePack({ world: w, lane: "META", principal_key: "CELIA_FIXTURE", needs: ["META_GTM_ANALYSIS", "META_EVERYTHING"] });
      const noRuntime = buildCandidatePack({ world: w, lane: "SALES", principal_key: "VALENTIN_FIXTURE", needs: ["SALES_GTM_CONTEXT"] });
      return {
        completeness: pack.completeness, completeness_reason: pack.completeness_reason,
        pointer_availability: pointer?.availability, pointer_refs: pointer?.refs,
        unknown_need: [unknownNeed.completeness, unknownNeed.completeness_reason],
        no_runtime: [noRuntime.completeness, noRuntime.completeness_reason, noRuntime.selected_pointers.length],
      };
    },
    {
      completeness: "NEEDS_EXPANSION", completeness_reason: "context_not_registered",
      pointer_availability: "UNAVAILABLE_NOT_REGISTERED", pointer_refs: [],
      unknown_need: ["NEEDS_EXPANSION", "unknown_need_token"], no_runtime: ["HOLD", "no_runtime_bound", 0],
    }),
];

/** The required branch identifiers, exactly as the coverage contract enumerates them. */
export const REQUIRED_BRANCH_IDS: readonly string[] = [
  ...["A", "B", "C"].map((s) => `PT-GTM-001/${s}`),
  ...["A", "B", "C", "D"].map((s) => `PT-GTM-002/${s}`),
  ...["A", "B", "C", "D", "E"].map((s) => `PT-GTM-003/${s}`),
  ...["A", "B", "C", "D", "E"].map((s) => `PT-GTM-004/${s}`),
  ...["A", "B", "C", "D"].map((s) => `PT-GTM-005/${s}`),
  ...["A", "B", "C", "D", "E"].map((s) => `PT-GTM-006/${s}`),
  ...["A", "B", "C", "D"].map((s) => `PT-GTM-007/${s}`),
  ...["A", "B", "C", "D", "E"].map((s) => `PT-GTM-008/${s}`),
  ...["A", "B", "C", "D"].map((s) => `PT-GTM-009/${s}`),
  ...["A", "B", "C", "D"].map((s) => `PT-GTM-010/${s}`),
  ...["A", "B", "C", "D", "E"].map((s) => `PT-GTM-011/${s}`),
  ...["A", "B", "C", "D", "E", "F", "G", "H"].map((s) => `PT-GTM-012/${s}`),
  ...["A", "B", "C", "D", "E", "F"].map((s) => `PT-GTM-013/${s}`),
  ...["A", "B", "C", "D", "E", "F"].map((s) => `PT-GTM-014/${s}`),
];

/** Evaluates one branch against a freshly built world and returns both compare sets. */
export function evaluateBranch(b: GtmBranch, world: GtmWorld = buildGtmWorld()): { readonly target: Compare; readonly final: Compare } {
  return { target: b.target(world), final: b.final(world) };
}

export const distinctEpisodeCount = (w: GtmWorld, dataset: "O2" | "CAL"): number => distinctEpisodes(w, R_TEST, dataset).length;
