/**
 * GTM-W03 — THE SEMANTIC ORACLES.
 *
 * Pure functions over a frozen `GtmWorld`. They implement exactly the W02-admitted semantics (D01..D07, D-CAL-01)
 * and nothing else: no provider, no network, no clock, no production import. Every "I cannot say" is an explicit
 * `NOT_COMPUTABLE` / `INCONCLUSIVE` value carrying its reason — never a silent zero.
 */
import {
  ATTRIBUTION_WINDOW_DAYS, READ_DEDUPE_WINDOW_SECONDS, inPeriod, ms,
  type ContactRec, type Dataset, type GtmWorld, type MessageRec, type Period, type PrincipalProfile,
  type ProviderEventRec,
} from "./world.ts";
import { RESOURCE_KEYS } from "./catalog.ts";

/* ────────────────────────────── shared result shapes ────────────────────────────── */

export interface Unavailable {
  readonly state: "NOT_COMPUTABLE" | "INCONCLUSIVE";
  readonly reason: string;
}
export const isUnavailable = (v: unknown): v is Unavailable =>
  typeof v === "object" && v !== null && ((v as Unavailable).state === "NOT_COMPUTABLE" || (v as Unavailable).state === "INCONCLUSIVE");

const notComputable = (reason: string): Unavailable => ({ state: "NOT_COMPUTABLE", reason });
const inconclusive = (reason: string): Unavailable => ({ state: "INCONCLUSIVE", reason });

const DAY_MS = 86_400_000;

/* ────────────────────────────── lookups ────────────────────────────── */

/**
 * RUNTIME-SCOPED LOOKUPS. `runtime_key` is REQUIRED on every one of them: a local key is minted by a runtime, two
 * runtimes may lawfully mint the same token, and resolving one runtime's row from another runtime's key would be a
 * cross-runtime leak into a per-runtime answer (D06). Only the catalog-global resources resolve by key alone.
 */
export const contactOf = (w: GtmWorld, runtime_key: string, key: string): ContactRec | undefined =>
  w.contacts.find((c) => c.runtime_key === runtime_key && c.contact_key === key);
export const messageOf = (w: GtmWorld, runtime_key: string, key: string): MessageRec | undefined =>
  w.messages.find((m) => m.runtime_key === runtime_key && m.message_key === key);
export const episodeOf = (w: GtmWorld, runtime_key: string, id: string) =>
  w.episodes.find((e) => e.runtime_key === runtime_key && e.meeting_episode_id === id);
/** Catalog-global: a metric definition belongs to no runtime. */
export const metricDef = (w: GtmWorld, key: string) => w.metric_defs.find((m) => m.metric_key === key);
export const principalOf = (w: GtmWorld, key: string): PrincipalProfile | undefined => w.principals.find((p) => p.principal_key === key);
export const runtimeOf = (w: GtmWorld, key: string) => w.runtimes.find((r) => r.runtime_key === key);

/** Coverage over the whole period, per source. Anything short of COMPLETE makes the metric NOT_COMPUTABLE. */
export function coverageState(w: GtmWorld, runtime_key: string, source: "MAILBOX" | "MEETING_EVENTS" | "TRACKER", period: Period): { ok: boolean; reason: string } {
  const rows = w.coverage.filter((c) => c.runtime_key === runtime_key && c.source === source);
  if (rows.length === 0) return { ok: false, reason: `no declared ${source} coverage for ${runtime_key}` };
  const covering = rows.find((c) => ms(c.since) <= ms(period.start) && ms(c.until) >= ms(period.end));
  if (covering === undefined) return { ok: false, reason: `declared ${source} coverage does not span ${period.period_key}` };
  if (covering.state !== "COMPLETE") return { ok: false, reason: `${source} coverage over ${period.period_key} is ${covering.state}` };
  return { ok: true, reason: "COMPLETE" };
}

/** D02: a metric may only be computed once its own horizon is pinned AND the period has matured. */
function horizonGate(w: GtmWorld, metric_key: string, period: Period, observed_at: string): Unavailable | undefined {
  const def = metricDef(w, metric_key);
  if (def === undefined) return notComputable(`no pinned definition for ${metric_key}`);
  if (def.observation_horizon_days === null || def.maturity_rule === null) return notComputable(`${metric_key} has no pinned observation horizon or maturity rule`);
  if (ms(observed_at) < ms(period.end) + def.observation_horizon_days * DAY_MS) {
    return inconclusive(`${metric_key} over ${period.period_key} is not mature at ${observed_at}`);
  }
  return undefined;
}

/* ────────────────────────────── D03 — proof-first attribution ────────────────────────────── */

export interface AttributionCandidate {
  readonly message_key: string;
  readonly campaign_key: string | null;
  readonly approach_version_key: string | null;
  readonly participation_key: string | null;
  readonly owner_principal_key: string | null;
  readonly occurred_at: string;
}

export interface Attribution {
  readonly status: "ATTRIBUTED" | "UNATTRIBUTED" | "UNKNOWN";
  readonly reason: string;
  /** Every plausible candidate is preserved, in chronological order, whatever the verdict. */
  readonly candidates: readonly AttributionCandidate[];
  readonly attributed_to: AttributionCandidate | null;
}

const candidateOf = (w: GtmWorld, m: MessageRec): AttributionCandidate => ({
  message_key: m.message_key, campaign_key: m.campaign_key, approach_version_key: m.approach_version_key,
  participation_key: m.participation_key,
  owner_principal_key: w.participations.find((p) => p.participation_key === m.participation_key)?.owner_principal_key ?? null,
  occurred_at: m.occurred_at,
});

const hasProof = (c: AttributionCandidate): boolean => c.participation_key !== null && c.approach_version_key !== null && c.campaign_key !== null;

/**
 * Attribution requires proof: a canonical identity, a prior outbound inside the bounded lookback, and either
 * decisive threading or a single participation/approach group. Several plausible candidates stay UNATTRIBUTED
 * with every candidate preserved — the most recent touch is never promoted implicitly.
 */
export function attributeReply(w: GtmWorld, reply: MessageRec): Attribution {
  const contact = contactOf(w, reply.runtime_key, reply.contact_key);
  if (contact === undefined || contact.identity_resolution !== "CANONICAL") {
    return { status: "UNKNOWN", reason: "the replying identity does not resolve to a canonical contact", candidates: [], attributed_to: null };
  }
  const since = ms(reply.occurred_at) - ATTRIBUTION_WINDOW_DAYS * DAY_MS;
  const priors = w.messages
    .filter((m) => m.direction === "OUTBOUND" && m.runtime_key === reply.runtime_key && m.contact_key === reply.contact_key)
    .filter((m) => ms(m.occurred_at) < ms(reply.occurred_at) && ms(m.occurred_at) >= since)
    .sort((a, b) => ms(a.occurred_at) - ms(b.occurred_at));
  const candidates = priors.map((m) => candidateOf(w, m));
  if (candidates.length === 0) {
    return { status: "UNKNOWN", reason: "no prior outbound of this runtime reaches this contact inside the attribution window", candidates: [], attributed_to: null };
  }
  const threaded = reply.in_reply_to === null ? undefined : candidates.find((c) => c.message_key === reply.in_reply_to);
  if (threaded !== undefined && hasProof(threaded)) {
    return { status: "ATTRIBUTED", reason: "the reply threads onto one outbound carrying campaign, approach and participation evidence", candidates, attributed_to: threaded };
  }
  const groups = new Set(candidates.filter(hasProof).map((c) => `${c.campaign_key}|${c.participation_key}|${c.approach_version_key}`));
  if (groups.size === 1 && candidates.every(hasProof)) {
    const only = candidates[candidates.length - 1] as AttributionCandidate;
    return { status: "ATTRIBUTED", reason: "every plausible candidate belongs to one campaign/approach/participation group", candidates, attributed_to: only };
  }
  return { status: "UNATTRIBUTED", reason: "several plausible candidates and no decisive evidence; no implicit last touch", candidates, attributed_to: null };
}

/* ────────────────────────────── D01 — reply disposition and the weekly metric ────────────────────────────── */

export type ReplyDisposition =
  | "ELIGIBLE_HUMAN_REPLY" | "DUPLICATE_DELIVERY" | "INTERNAL_COUNTERPART" | "TECHNICAL_AUTOREPLY"
  | "PERMANENT_BOUNCE" | "OPT_OUT" | "UNKNOWN_KIND_TAKEOVER" | "NOT_ATTRIBUTED";

export interface DispositionView {
  readonly message_key: string;
  readonly contact_key: string;
  readonly disposition: ReplyDisposition;
  readonly attribution: Attribution["status"];
  /** The operational consequence the fixture pins for this disposition, if any. */
  readonly follow_up: "NONE" | "HUMAN_TAKEOVER" | "STOP_ADDRESS" | "SUPPRESS_CONTACT";
}

/** Inbound messages of a runtime, deduplicated on the provider message id (a duplicate delivery is not a reply). */
export function inboundDeduped(w: GtmWorld, runtime_key: string): { kept: readonly MessageRec[]; duplicates: readonly MessageRec[] } {
  const seen = new Set<string>();
  const kept: MessageRec[] = [];
  const duplicates: MessageRec[] = [];
  for (const m of w.messages.filter((x) => x.direction === "INBOUND" && x.runtime_key === runtime_key)
    .slice().sort((a, b) => ms(a.occurred_at) - ms(b.occurred_at) || a.message_key.localeCompare(b.message_key))) {
    if (seen.has(m.provider_message_id)) duplicates.push(m);
    else { seen.add(m.provider_message_id); kept.push(m); }
  }
  return { kept, duplicates };
}

export function dispositionOf(w: GtmWorld, msg: MessageRec, duplicateKeys: ReadonlySet<string>): DispositionView {
  const attribution = attributeReply(w, msg);
  const contact = contactOf(w, msg.runtime_key, msg.contact_key);
  const base = { message_key: msg.message_key, contact_key: msg.contact_key, attribution: attribution.status };
  if (duplicateKeys.has(msg.message_key)) return { ...base, disposition: "DUPLICATE_DELIVERY", follow_up: "NONE" };
  if (contact === undefined || contact.party === "INTERNAL") return { ...base, disposition: "INTERNAL_COUNTERPART", follow_up: "NONE" };
  if (msg.intent === "BOUNCE_PERMANENT") return { ...base, disposition: "PERMANENT_BOUNCE", follow_up: "STOP_ADDRESS" };
  if (msg.kind === "TECHNICAL") return { ...base, disposition: "TECHNICAL_AUTOREPLY", follow_up: "NONE" };
  if (msg.intent === "OPT_OUT") return { ...base, disposition: "OPT_OUT", follow_up: "SUPPRESS_CONTACT" };
  if (msg.kind === "UNKNOWN" || msg.intent === "UNDETERMINED") return { ...base, disposition: "UNKNOWN_KIND_TAKEOVER", follow_up: "HUMAN_TAKEOVER" };
  if (attribution.status !== "ATTRIBUTED") return { ...base, disposition: "NOT_ATTRIBUTED", follow_up: "NONE" };
  return { ...base, disposition: "ELIGIBLE_HUMAN_REPLY", follow_up: "NONE" };
}

export interface PeriodScope {
  readonly runtime_key: string;
  readonly period: Period;
  readonly observed_at: string;
}

/** Every inbound message of the scope, deduplicated, in period, with its disposition. */
export function dispositionsInPeriod(w: GtmWorld, scope: PeriodScope): readonly DispositionView[] {
  const { kept, duplicates } = inboundDeduped(w, scope.runtime_key);
  const duplicateKeys = new Set(duplicates.map((d) => d.message_key));
  return [...kept, ...duplicates]
    .filter((m) => inPeriod(m.occurred_at, scope.period))
    .sort((a, b) => a.message_key.localeCompare(b.message_key))
    .map((m) => dispositionOf(w, m, duplicateKeys));
}

export interface WeeklyRepliedProspects {
  readonly state: "COMPUTED";
  readonly metric_key: "weekly_replied_prospects";
  readonly value: number;
  readonly contacts: readonly string[];
  readonly eligible_message_keys: readonly string[];
  readonly eligible_human_reply_messages: number;
  readonly production_target_state: "TARGET_NOT_SET";
  readonly fixture_threshold: number | null;
  readonly meets_fixture_threshold: boolean;
}

/**
 * D01. The metric exists, is testable, and carries a fixture threshold; its PRODUCTION target stays
 * `TARGET_NOT_SET` — the fixture threshold is never presented as a production target.
 */
export function weeklyRepliedProspects(w: GtmWorld, scope: PeriodScope): WeeklyRepliedProspects | Unavailable {
  const gate = horizonGate(w, "weekly_replied_prospects", scope.period, scope.observed_at);
  if (gate !== undefined) return gate;
  const cov = coverageState(w, scope.runtime_key, "MAILBOX", scope.period);
  if (!cov.ok) return notComputable(cov.reason);
  const eligible = dispositionsInPeriod(w, scope).filter((d) => d.disposition === "ELIGIBLE_HUMAN_REPLY");
  const contacts = [...new Set(eligible.map((d) => d.contact_key))].sort();
  const def = metricDef(w, "weekly_replied_prospects");
  return {
    state: "COMPUTED", metric_key: "weekly_replied_prospects", value: contacts.length, contacts,
    eligible_message_keys: eligible.map((d) => d.message_key).sort(),
    eligible_human_reply_messages: eligible.length,
    production_target_state: "TARGET_NOT_SET",
    fixture_threshold: def?.fixture_threshold ?? null,
    meets_fixture_threshold: contacts.length >= (def?.fixture_threshold ?? Number.POSITIVE_INFINITY),
  };
}

/** Contacts whose period disposition triggered a pinned operational consequence. */
export function followUpContacts(w: GtmWorld, scope: PeriodScope, disposition: ReplyDisposition): readonly string[] {
  return [...new Set(dispositionsInPeriod(w, scope).filter((d) => d.disposition === disposition).map((d) => d.contact_key))].sort();
}

/* ────────────────────────────── D02 — entry cohort ────────────────────────────── */

export interface EntryCohort {
  readonly state: "COMPUTED";
  readonly metric_key: "weekly_entry_cohort_reply_rate";
  readonly entrants: readonly string[];
  readonly replied_entrants: readonly string[];
  readonly numerator: number;
  readonly denominator: number;
  readonly rate_label: string;
  /** Repliers of the period who are NOT members of the entry cohort: the two denominators never merge. */
  readonly period_repliers_outside_cohort: readonly string[];
}

/**
 * Entry = an external prospect first approached inside the period, with no approach in the bounded lookback
 * immediately before it. A contact approached earlier can reply inside the period without joining the cohort.
 */
export function entryCohort(w: GtmWorld, scope: PeriodScope): EntryCohort | Unavailable {
  const gate = horizonGate(w, "weekly_entry_cohort_reply_rate", scope.period, scope.observed_at);
  if (gate !== undefined) return gate;
  const cov = coverageState(w, scope.runtime_key, "MAILBOX", scope.period);
  if (!cov.ok) return notComputable(cov.reason);

  const outbound = w.messages.filter((m) => m.direction === "OUTBOUND" && m.runtime_key === scope.runtime_key);
  const lookbackStart = ms(scope.period.start) - ATTRIBUTION_WINDOW_DAYS * DAY_MS;
  const entrants = [...new Set(outbound
    .filter((m) => inPeriod(m.occurred_at, scope.period))
    .filter((m) => contactOf(w, scope.runtime_key, m.contact_key)?.party === "EXTERNAL_PROSPECT")
    .filter((m) => !outbound.some((p) => p.contact_key === m.contact_key && ms(p.occurred_at) < ms(scope.period.start) && ms(p.occurred_at) >= lookbackStart))
    .map((m) => m.contact_key))].sort();

  const repliers = new Set(dispositionsInPeriod(w, scope).filter((d) => d.disposition === "ELIGIBLE_HUMAN_REPLY").map((d) => d.contact_key));
  const replied = entrants.filter((c) => repliers.has(c));
  return {
    state: "COMPUTED", metric_key: "weekly_entry_cohort_reply_rate", entrants, replied_entrants: replied,
    numerator: replied.length, denominator: entrants.length, rate_label: `${replied.length}/${entrants.length}`,
    period_repliers_outside_cohort: [...repliers].filter((c) => !entrants.includes(c)).sort(),
  };
}

/** Replies of the period grouped by the approach version they are attributed to (two versions stay separable). */
export function eligibleRepliesByApproachVersion(w: GtmWorld, scope: PeriodScope): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const d of dispositionsInPeriod(w, scope)) {
    if (d.disposition !== "ELIGIBLE_HUMAN_REPLY") continue;
    const msg = messageOf(w, scope.runtime_key, d.message_key);
    const version = msg === undefined ? null : attributeReply(w, msg).attributed_to?.approach_version_key ?? null;
    if (version === null) continue;
    out[version] = (out[version] ?? 0) + 1;
  }
  return out;
}

/* ────────────────────────────── D04 — meeting episodes ────────────────────────────── */

/** The ladder is ordered but its rungs are NOT equivalent: reaching one never implies reaching the next. */
export const MEETING_STATUS_LADDER = ["PROPOSED", "ACCEPTED", "BOOKED", "HELD", "QUALIFIED_DISCOVERY"] as const;
export type MeetingStatus = (typeof MEETING_STATUS_LADDER)[number];

export function episodeStatuses(w: GtmWorld, runtime_key: string, id: string): readonly MeetingStatus[] {
  const e = episodeOf(w, runtime_key, id);
  if (e === undefined) return [];
  const reached: MeetingStatus[] = [];
  if (e.proposed_at !== null) reached.push("PROPOSED");
  if (e.accepted_at !== null && e.agreement_evidence_ref !== null) reached.push("ACCEPTED");
  if (e.booked_at !== null && e.accepted_at !== null) reached.push("BOOKED");
  if (e.held_at !== null) reached.push("HELD");
  if (e.qualified_at !== null) reached.push("QUALIFIED_DISCOVERY");
  return reached;
}

export interface EpisodeIdentity {
  readonly meeting_episode_id: string;
  readonly provider_event_keys: readonly string[];
  readonly reschedule_count: number;
  readonly latest_start: string;
  readonly collapsed_duplicates: readonly string[];
}

/** One episode, whatever the number of reschedules, second agendas or mail-thread sightings of the same meeting. */
export function episodeIdentity(w: GtmWorld, runtime_key: string, id: string): EpisodeIdentity | undefined {
  const events = w.provider_events.filter((e) => e.runtime_key === runtime_key && e.meeting_episode_id === id).slice().sort((a, b) => ms(a.starts_at) - ms(b.starts_at));
  if (events.length === 0) return undefined;
  const last = events[events.length - 1] as ProviderEventRec;
  return {
    meeting_episode_id: id,
    provider_event_keys: events.map((e) => e.provider_event_key),
    reschedule_count: events.filter((e) => e.reschedule_of !== null).length,
    latest_start: last.starts_at,
    collapsed_duplicates: events.filter((e) => e.duplicate_of !== null).map((e) => e.provider_event_key),
  };
}

/** Distinct episodes of a dataset: recurring occurrences are distinct episodes, reschedules are not. */
export function distinctEpisodes(w: GtmWorld, runtime_key: string, dataset: Dataset): readonly string[] {
  return [...new Set(w.provider_events.filter((e) => e.runtime_key === runtime_key && e.dataset === dataset).map((e) => e.meeting_episode_id))].sort();
}

export interface MeetingCounts {
  readonly state: "COMPUTED";
  /** Booking creations are historical facts: a later cancellation never removes one. */
  readonly historical_bookings: number;
  readonly active_bookings: number;
  readonly held: number;
  readonly qualified: number | "NOT_COMPUTABLE";
  readonly qualified_reason: string;
  readonly counted_episodes: readonly string[];
}

export interface MeetingScope extends PeriodScope { readonly dataset: Dataset }

export function meetingCounts(w: GtmWorld, scope: MeetingScope): MeetingCounts | Unavailable {
  const gate = horizonGate(w, "meeting_bookings", scope.period, scope.observed_at);
  if (gate !== undefined) return gate;
  const cov = coverageState(w, scope.runtime_key, "MEETING_EVENTS", scope.period);
  if (!cov.ok) return notComputable(cov.reason);
  const episodes = w.episodes.filter((e) => e.runtime_key === scope.runtime_key && e.dataset === scope.dataset && e.episode_kind === "PROSPECT");
  const booked = episodes.filter((e) => episodeStatuses(w, scope.runtime_key, e.meeting_episode_id).includes("BOOKED") && e.booked_at !== null && inPeriod(e.booked_at, scope.period));
  const held = episodes.filter((e) => e.held_at !== null && inPeriod(e.held_at, scope.period));
  const pinnedQualification = metricDef(w, "qualified_discovery_meetings") !== undefined;
  return {
    state: "COMPUTED",
    historical_bookings: booked.length,
    active_bookings: booked.filter((e) => e.canceled_at === null).length,
    held: held.length,
    qualified: held.length === 0 ? 0 : pinnedQualification ? held.filter((e) => e.qualified_at !== null).length : "NOT_COMPUTABLE",
    qualified_reason: held.length === 0
      ? "no meeting was held in the period, so no meeting can be qualified"
      : pinnedQualification ? "a pinned qualification definition is available" : "a meeting was held but no pinned qualified-discovery definition exists",
    counted_episodes: booked.map((e) => e.meeting_episode_id).sort(),
  };
}

/* ────────────────────────────── D05 — exposure ────────────────────────────── */

export interface ExposureView {
  readonly exposure_key: string;
  readonly campaign_key: string;
  readonly approach_version_key: string;
  readonly configured_offer: string;
  readonly configured_price_cents: number;
  readonly communicated_offer: string;
  readonly communicated_price_cents: number;
  readonly differs_from_configuration: boolean;
  readonly override_evidence: string | null;
  readonly authority_scope: string;
  readonly authority_expanded: boolean;
}

/** What was configured is configuration; only a pinned exposure says what was actually communicated. */
export function exposureView(w: GtmWorld, runtime_key: string, exposure_key: string): ExposureView | undefined {
  const x = w.exposures.find((e) => e.runtime_key === runtime_key && e.exposure_key === exposure_key);
  if (x === undefined) return undefined;
  const campaign = w.campaigns.find((c) => c.runtime_key === runtime_key && c.campaign_key === x.campaign_key);
  const version = w.approach_versions.find((v) => v.approach_version_key === x.approach_version_key);
  const parent = version?.variant_of === null || version?.variant_of === undefined ? undefined : w.approach_versions.find((v) => v.approach_version_key === version.variant_of);
  return {
    exposure_key, campaign_key: x.campaign_key, approach_version_key: x.approach_version_key,
    configured_offer: campaign?.configured_offer ?? "UNKNOWN", configured_price_cents: campaign?.configured_price_cents ?? -1,
    communicated_offer: x.communicated_offer, communicated_price_cents: x.communicated_price_cents,
    differs_from_configuration: campaign !== undefined && (campaign.configured_offer !== x.communicated_offer || campaign.configured_price_cents !== x.communicated_price_cents),
    override_evidence: x.override_evidence,
    authority_scope: version?.authority_scope ?? "UNKNOWN",
    authority_expanded: parent !== undefined && version !== undefined && parent.authority_scope !== version.authority_scope,
  };
}

/** Link sent is not link read; repeated opens by one reader inside the dedupe window are one distinct read. */
export function linkSignals(w: GtmWorld, runtime_key: string, message_key: string): { readonly sent: number; readonly read_events: number; readonly distinct_reads: number } {
  const events = w.tracker_events.filter((e) => e.runtime_key === runtime_key && e.message_key === message_key).slice().sort((a, b) => ms(a.occurred_at) - ms(b.occurred_at));
  const reads = events.filter((e) => e.event_type === "LINK_READ");
  const distinct: Array<{ link: string; reader: string | null; at: number }> = [];
  for (const r of reads) {
    const dup = distinct.some((d) => d.link === r.link_key && d.reader === r.reader_fingerprint && Math.abs(ms(r.occurred_at) - d.at) <= READ_DEDUPE_WINDOW_SECONDS * 1000);
    if (!dup) distinct.push({ link: r.link_key, reader: r.reader_fingerprint, at: ms(r.occurred_at) });
  }
  return { sent: events.filter((e) => e.event_type === "LINK_SENT").length, read_events: reads.length, distinct_reads: distinct.length };
}

/* ────────────────────────────── D06 — company aggregation, no global dedup ────────────────────────────── */

export interface CompanyAggregate {
  readonly state: "COMPUTED";
  readonly runtime_key: string;
  readonly replied_contacts: number;
  readonly replied_companies: number;
  readonly companies: readonly string[];
}

/** Per-runtime only. Two replies inside one company are two contacts and one company — never two companies. */
export function companyAggregate(w: GtmWorld, scope: PeriodScope): CompanyAggregate | Unavailable {
  const metric = weeklyRepliedProspects(w, scope);
  if (isUnavailable(metric)) return metric;
  const companies = [...new Set(metric.contacts.map((c) => contactOf(w, scope.runtime_key, c)?.company_key ?? "UNKNOWN"))].sort();
  return { state: "COMPUTED", runtime_key: scope.runtime_key, replied_contacts: metric.value, replied_companies: companies.length, companies };
}

export interface GlobalAttempt extends Unavailable {
  readonly overlapping_companies: readonly string[];
  readonly per_runtime: Readonly<Record<string, number>>;
  readonly disposition: "HOLD";
}

/**
 * A company-global, overlap-sensitive total across runtimes needs a Shared Reality topology that the pilot does
 * not have. The per-runtime figures stay available and truthful; only the cross-runtime total is withheld.
 */
export function companyGlobalTotal(w: GtmWorld, runtimeKeys: readonly string[], period: Period, observed_at: string): GlobalAttempt | CompanyAggregate {
  const per: Record<string, number> = {};
  const companySets: string[][] = [];
  for (const runtime_key of runtimeKeys) {
    const agg = companyAggregate(w, { runtime_key, period, observed_at });
    if (isUnavailable(agg)) { per[runtime_key] = -1; companySets.push([]); continue; }
    per[runtime_key] = agg.replied_companies;
    companySets.push([...agg.companies]);
  }
  const counts = new Map<string, number>();
  for (const set of companySets) for (const c of set) counts.set(c, (counts.get(c) ?? 0) + 1);
  const overlapping = [...counts.entries()].filter(([, n]) => n > 1).map(([c]) => c).sort();
  const topologyAbsent = runtimeKeys.every((k) => runtimeOf(w, k)?.shared_reality_topology === "ABSENT");
  if (runtimeKeys.length === 1 && !topologyAbsent) {
    return companyAggregate(w, { runtime_key: runtimeKeys[0] as string, period, observed_at }) as CompanyAggregate;
  }
  return {
    state: "NOT_COMPUTABLE",
    reason: "an overlap-sensitive company-global total needs a Shared Reality topology; the pilot declares none, so runtimes are never deduplicated",
    overlapping_companies: overlapping, per_runtime: per, disposition: "HOLD",
  };
}

/** Units must match. A numerator of one unit over a denominator of another is refused, never rounded into a rate. */
export function rateOf(numerator: { value: number; unit: string }, denominator: { value: number; unit: string }): { state: "COMPUTED"; value: number; label: string } | Unavailable {
  if (numerator.unit !== denominator.unit) return notComputable(`heterogeneous denominator: ${numerator.unit} over ${denominator.unit}`);
  if (denominator.value === 0) return notComputable("empty denominator");
  return { state: "COMPUTED", value: numerator.value / denominator.value, label: `${numerator.value}/${denominator.value}` };
}

/* ────────────────────────────── D-CAL-01 — event classification ────────────────────────────── */

export type ParticipationClass = "EXTERNAL_CANDIDATE" | "INTERNAL_ONLY" | "UNKNOWN";
export type PurposeClass = "EXTERNAL_COMMERCIAL" | "EXTERNAL_OTHER" | "PURPOSE_UNKNOWN";

export interface EventClassification {
  readonly provider_event_key: string;
  readonly participation_class: ParticipationClass;
  readonly purpose_class: PurposeClass;
  readonly excluded: boolean;
  readonly reason: string;
}

/**
 * D-CAL-01 CONFIRMED. Only INTERNAL_ONLY is excluded. A VERTIGO participant never excludes an event; bots and
 * meeting rooms never create an external human; incomplete evidence is UNKNOWN, never a guess. Purpose is a
 * SEPARATE classification derived from agreed-agenda evidence — never from a title.
 */
export function classifyEvent(event: ProviderEventRec): EventClassification {
  const externals = event.participants.filter((p) => p.kind === "EXTERNAL_HUMAN" && p.established_external);
  const incomplete = event.evidence_completeness === "INCOMPLETE" || event.participants.some((p) => p.kind === "MASKED");
  const purpose_class: PurposeClass =
    event.agenda_evidence === "COMMERCIAL_AGREED_AGENDA" ? "EXTERNAL_COMMERCIAL"
      : event.agenda_evidence === "NON_COMMERCIAL_AGENDA" ? "EXTERNAL_OTHER" : "PURPOSE_UNKNOWN";
  if (externals.length > 0) {
    return { provider_event_key: event.provider_event_key, participation_class: "EXTERNAL_CANDIDATE", purpose_class, excluded: false, reason: "at least one established external human takes part alongside the runtime's own participants" };
  }
  if (incomplete) {
    return { provider_event_key: event.provider_event_key, participation_class: "UNKNOWN", purpose_class, excluded: false, reason: "participant evidence is masked or truncated; the event is not classified either way" };
  }
  return { provider_event_key: event.provider_event_key, participation_class: "INTERNAL_ONLY", purpose_class, excluded: true, reason: "every participant is internal, an internal alias, a bot or a room; no external human is established" };
}

/** The calendar allowlist decides whether a calendar may be read at all. It never changes a classification. */
export function calendarReadState(w: GtmWorld, runtime_key: string, allowlisted: boolean): { readonly readable: boolean; readonly source_connected: boolean; readonly reason: string } {
  const connected = runtimeOf(w, runtime_key)?.calendar_source_connected ?? false;
  return {
    readable: allowlisted && connected, source_connected: connected,
    reason: connected ? "the calendar source is connected" : "no Calendar source is connected in this fixture; real per-principal reads stay deferred",
  };
}

export interface ClassificationCheckpoint {
  readonly processed: readonly EventClassification[];
  readonly next_index: number;
}

/**
 * A classification pass that can crash and resume from its checkpoint. Resuming produces exactly the result an
 * uninterrupted pass produces, and never classifies an event twice.
 */
export function classifyBatch(events: readonly ProviderEventRec[], from: ClassificationCheckpoint | null = null, crashAfter: number | null = null): ClassificationCheckpoint {
  const processed = [...(from?.processed ?? [])];
  let i = from?.next_index ?? 0;
  let done = 0;
  for (; i < events.length; i++) {
    if (crashAfter !== null && done >= crashAfter) break;
    processed.push(classifyEvent(events[i] as ProviderEventRec));
    done++;
  }
  return { processed, next_index: i };
}

/* ────────────────────────────── read scopes and principal isolation ────────────────────────────── */

export const PRINCIPAL_READABLE_RESOURCES: readonly string[] = [
  RESOURCE_KEYS.COMPANY, RESOURCE_KEYS.CONTACT, RESOURCE_KEYS.MESSAGE, RESOURCE_KEYS.CAMPAIGN,
  RESOURCE_KEYS.PARTICIPATION, RESOURCE_KEYS.ENROLLMENT, RESOURCE_KEYS.EXPOSURE, RESOURCE_KEYS.TRACKER_EVENT,
  RESOURCE_KEYS.PROVIDER_EVENT, RESOURCE_KEYS.MEETING_EPISODE, RESOURCE_KEYS.COVERAGE, RESOURCE_KEYS.REGISTERED_CONTEXT,
];

export interface ReadScopeView {
  readonly principal_key: string;
  readonly runtime_key: string | null;
  readonly resource_keys: readonly string[];
  readonly refusal: "NONE" | "REFUSED_NO_RUNTIME";
}

export function readScopeOf(w: GtmWorld, principal_key: string): ReadScopeView {
  const p = principalOf(w, principal_key);
  if (p === undefined || p.runtime_key === null) {
    return { principal_key, runtime_key: null, resource_keys: [], refusal: "REFUSED_NO_RUNTIME" };
  }
  return { principal_key, runtime_key: p.runtime_key, resource_keys: [...PRINCIPAL_READABLE_RESOURCES], refusal: "NONE" };
}

export type ReadResult =
  | { readonly status: "OK"; readonly rows: readonly Record<string, unknown>[] }
  | { readonly status: "REFUSED"; readonly code: "REFUSED_NO_RUNTIME" | "REFUSED_OUT_OF_SCOPE" | "REFUSED_FOREIGN_RUNTIME" };

const COLLECTION_OF: Readonly<Record<string, keyof GtmWorld>> = {
  [RESOURCE_KEYS.COMPANY]: "companies", [RESOURCE_KEYS.CONTACT]: "contacts", [RESOURCE_KEYS.MESSAGE]: "messages",
  [RESOURCE_KEYS.CAMPAIGN]: "campaigns", [RESOURCE_KEYS.PARTICIPATION]: "participations",
  [RESOURCE_KEYS.ENROLLMENT]: "enrollments", [RESOURCE_KEYS.EXPOSURE]: "exposures",
  [RESOURCE_KEYS.TRACKER_EVENT]: "tracker_events", [RESOURCE_KEYS.PROVIDER_EVENT]: "provider_events",
  [RESOURCE_KEYS.MEETING_EPISODE]: "episodes", [RESOURCE_KEYS.COVERAGE]: "coverage",
  [RESOURCE_KEYS.REGISTERED_CONTEXT]: "registered_context",
};

/**
 * Principal isolation: a principal reads its own runtime's rows and nothing else. A principal without a runtime
 * reads nothing at all and never falls back onto somebody else's runtime.
 */
export function readRows(w: GtmWorld, principal_key: string, resource_key: string, requested_runtime_key?: string): ReadResult {
  const scope = readScopeOf(w, principal_key);
  if (scope.refusal === "REFUSED_NO_RUNTIME") return { status: "REFUSED", code: "REFUSED_NO_RUNTIME" };
  if (!scope.resource_keys.includes(resource_key)) return { status: "REFUSED", code: "REFUSED_OUT_OF_SCOPE" };
  if (requested_runtime_key !== undefined && requested_runtime_key !== scope.runtime_key) return { status: "REFUSED", code: "REFUSED_FOREIGN_RUNTIME" };
  const collection = COLLECTION_OF[resource_key];
  if (collection === undefined) return { status: "REFUSED", code: "REFUSED_OUT_OF_SCOPE" };
  const rows = (w[collection] as unknown as readonly Record<string, unknown>[]).filter((r) => r["runtime_key"] === scope.runtime_key);
  return { status: "OK", rows };
}

export interface ProfileView {
  readonly principal_key: string;
  readonly runtime_key: string | null;
  readonly setup_shape: string;
  readonly sources: Readonly<Record<string, string>>;
  readonly divergence: "NONE" | "MANIFEST_VS_REGISTRY";
  readonly divergent_values: readonly string[];
  readonly hold: boolean;
}

/** The profile as the canaries will read it: shapes and states, both sides of a divergence preserved. */
export function profileView(w: GtmWorld, principal_key: string): ProfileView | undefined {
  const p = principalOf(w, principal_key);
  if (p === undefined) return undefined;
  return {
    principal_key: p.principal_key, runtime_key: p.runtime_key, setup_shape: p.setup_shape,
    sources: { notion: p.notion_state, gmail_read: p.gmail_read_state, tracker: p.tracker_state, calendar: p.calendar_state },
    divergence: p.divergence,
    divergent_values: p.divergence === "MANIFEST_VS_REGISTRY" ? [p.gmail_manifest_identity ?? "UNKNOWN", p.gmail_registry_identity ?? "UNKNOWN"] : [],
    hold: p.hold_reason !== null,
  };
}
