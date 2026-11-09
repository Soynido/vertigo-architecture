/**
 * GTM-W03 — THE DETERMINISTIC SYNTHETIC WORLD.
 *
 * Pure data plus pure transforms. No clock, no network, no filesystem, no provider adapter, no import from `src/`.
 * `buildGtmWorld()` returns a deeply frozen value: two calls are deep-equal and share the same fingerprint, and a
 * variant is always a fresh clone, so the baseline can never drift under a test.
 *
 * Every identity is synthetic: addresses use the reserved `example.invalid` domain, keys are readable tokens, and
 * every record carries the NON_LIVE provenance marker. No live URL, mailbox, runtime id or page id exists here.
 */
import { createHash } from "node:crypto";
import { FIXTURE_DOMAIN, FIXTURE_ROOT, NON_LIVE_MARKER, RESOURCE_KEYS } from "./catalog.ts";

/* ────────────────────────────── time ────────────────────────────── */

/** The event period under test: a half-open Europe/Paris week (D02). */
export const WEEK_W = {
  period_key: "W-2026-38",
  timezone: "Europe/Paris",
  start: "2026-09-14T00:00:00+02:00",
  end: "2026-09-21T00:00:00+02:00",
  half_open: true,
} as const;

/** The preceding week, used by the entrants-vs-repliers separation (C05, C12, C13). */
export const WEEK_PREV = {
  period_key: "W-2026-37",
  timezone: "Europe/Paris",
  start: "2026-09-07T00:00:00+02:00",
  end: "2026-09-14T00:00:00+02:00",
  half_open: true,
} as const;

/** The week that follows W; the reply pinned exactly on W's upper bound belongs here, never to W. */
export const WEEK_NEXT = {
  period_key: "W-2026-39",
  timezone: "Europe/Paris",
  start: "2026-09-21T00:00:00+02:00",
  end: "2026-09-28T00:00:00+02:00",
  half_open: true,
} as const;

export type Period = typeof WEEK_W | typeof WEEK_PREV | typeof WEEK_NEXT;

/** Everything in the fixture is observed at this instant: after W plus the declared horizon. */
export const OBSERVED_AT = "2026-09-28T09:00:00+02:00";
/** An observation instant inside W, used to prove an immature period is INCONCLUSIVE, never zero. */
export const OBSERVED_TOO_EARLY = "2026-09-19T09:00:00+02:00";
/** Attribution never reaches further back than this (D03: proof-first, bounded). */
export const ATTRIBUTION_WINDOW_DAYS = 30;
/** Two opens of one link by one reader inside this window are one distinct read. */
export const READ_DEDUPE_WINDOW_SECONDS = 600;

export const ms = (iso: string): number => Date.parse(iso);
/** Half-open membership: `start <= t < end`. The single place the week boundary rule is implemented. */
export const inPeriod = (iso: string, p: Period): boolean => ms(iso) >= ms(p.start) && ms(iso) < ms(p.end);

/* ────────────────────────────── records ────────────────────────────── */

export interface Provenance {
  readonly source_system: "FIXTURE_SYNTHETIC";
  readonly observed_at: string;
  readonly evidence_ref: string;
  readonly non_live: typeof NON_LIVE_MARKER;
}

const prov = (evidence_ref: string, observed_at: string = OBSERVED_AT): Provenance => ({
  source_system: "FIXTURE_SYNTHETIC", observed_at, evidence_ref, non_live: NON_LIVE_MARKER,
});

export type SourceState = "RESOLVED" | "VERIFIED" | "PARTIAL" | "INACCESSIBLE" | "UNKNOWN" | "PENDING" | "HOLD_DIVERGENCE" | "NOT_APPLICABLE";

export interface PrincipalProfile {
  readonly principal_key: string;
  readonly display_label: string;
  readonly runtime_key: string | null;
  readonly setup_shape: string;
  readonly notion_state: SourceState;
  readonly gmail_read_state: SourceState;
  readonly tracker_state: SourceState;
  readonly calendar_state: SourceState;
  readonly gmail_manifest_identity: string | null;
  readonly gmail_registry_identity: string | null;
  readonly divergence: "NONE" | "MANIFEST_VS_REGISTRY";
  readonly hold_reason: string | null;
  readonly provenance: Provenance;
}

export interface RuntimeRec {
  readonly runtime_key: string;
  readonly owner_principal_key: string;
  readonly runtime_generation: string;
  readonly runtime_scope: "FIXTURE";
  readonly shared_reality_topology: "ABSENT";
  readonly calendar_source_connected: false;
  readonly provenance: Provenance;
}

export interface CompanyRec {
  readonly runtime_key: string;
  readonly company_key: string;
  readonly classification: "EXTERNAL" | "INTERNAL";
  readonly provenance: Provenance;
}

export interface ContactRec {
  readonly contact_key: string;
  readonly runtime_key: string;
  readonly company_key: string;
  readonly canonical_identity: string;
  readonly party: "EXTERNAL_PROSPECT" | "INTERNAL";
  readonly identity_resolution: "CANONICAL" | "UNRESOLVED";
  readonly opted_out: boolean;
  readonly address_stopped: boolean;
  readonly takeover_required: boolean;
  readonly provenance: Provenance;
}

export type MessageKind = "HUMAN" | "TECHNICAL" | "UNKNOWN";
export type MessageIntent =
  | "OUTBOUND_APPROACH" | "POSITIVE" | "QUESTION" | "OBJECTION" | "NEGATIVE" | "OPT_OUT"
  | "OUT_OF_OFFICE" | "BOUNCE_PERMANENT" | "UNDETERMINED";

export interface MessageRec {
  readonly message_key: string;
  readonly runtime_key: string;
  readonly contact_key: string;
  readonly direction: "OUTBOUND" | "INBOUND";
  /** Duplicated provider deliveries share this id; the oracle deduplicates on it. */
  readonly provider_message_id: string;
  readonly occurred_at: string;
  readonly kind: MessageKind;
  readonly intent: MessageIntent;
  readonly campaign_key: string | null;
  readonly approach_version_key: string | null;
  readonly participation_key: string | null;
  readonly exposure_key: string | null;
  /** Decisive threading proof for attribution; never inferred from recency (D03). */
  readonly in_reply_to: string | null;
  /** Explicit meeting agreement evidence, when the reply carries one (D04). */
  readonly agreement_evidence: string | null;
  readonly provenance: Provenance;
}

export interface CampaignRec {
  readonly campaign_key: string;
  readonly runtime_key: string;
  readonly owner_principal_key: string;
  readonly approach_key: string;
  readonly configured_offer: string;
  readonly configured_price_cents: number;
  readonly currency: "EUR";
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly status: "ACTIVE" | "ENDED";
  readonly provenance: Provenance;
}

export interface ApproachVersionRec {
  readonly approach_version_key: string;
  readonly approach_key: string;
  readonly version_label: string;
  readonly authority_scope: string;
  readonly variant_of: string | null;
  readonly provenance: Provenance;
}

export interface ParticipationRec {
  readonly participation_key: string;
  readonly runtime_key: string;
  readonly owner_principal_key: string;
  readonly approach_version_key: string;
  readonly campaign_key: string;
  readonly provenance: Provenance;
}

export interface EnrollmentRec {
  readonly enrollment_key: string;
  readonly runtime_key: string;
  readonly campaign_key: string;
  readonly contact_key: string;
  readonly state: "ACTIVE" | "ENDED";
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly provenance: Provenance;
}

export interface ExposureRec {
  readonly exposure_key: string;
  readonly runtime_key: string;
  readonly contact_key: string;
  readonly message_key: string;
  readonly campaign_key: string;
  readonly approach_version_key: string;
  readonly communicated_offer: string;
  readonly communicated_price_cents: number;
  readonly currency: "EUR";
  readonly override_evidence: string | null;
  readonly pinned_at: string;
  readonly provenance: Provenance;
}

export interface TrackerEventRec {
  readonly tracker_event_key: string;
  readonly runtime_key: string;
  readonly message_key: string;
  readonly link_key: string;
  readonly event_type: "LINK_SENT" | "LINK_READ";
  readonly occurred_at: string;
  readonly reader_fingerprint: string | null;
  readonly provenance: Provenance;
}

/** `O2` is the meeting-counting substrate; `CAL` is the D-CAL-01 classification substrate. Never mixed. */
export type Dataset = "O2" | "CAL";

export type ParticipantKind = "INTERNAL_HUMAN" | "INTERNAL_ALIAS" | "EXTERNAL_HUMAN" | "BOT" | "ROOM" | "MASKED";

export interface Participant {
  readonly participant_key: string;
  readonly kind: ParticipantKind;
  readonly identity: string;
  /** An external human only counts once it is established evidence, never a guess from a masked address. */
  readonly established_external: boolean;
}

export interface ProviderEventRec {
  readonly provider_event_key: string;
  readonly runtime_key: string;
  /** Two disjoint substrates share one runtime: the O2 meeting world and the D-CAL-01 classification world. */
  readonly dataset: Dataset;
  readonly meeting_episode_id: string;
  readonly series_key: string | null;
  readonly occurrence_index: number | null;
  readonly reschedule_of: string | null;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly status: "CONFIRMED" | "CANCELED" | "UNACCEPTED" | "TENTATIVE";
  readonly title: string;
  readonly agenda_evidence: "COMMERCIAL_AGREED_AGENDA" | "NON_COMMERCIAL_AGENDA" | "NONE";
  readonly participants: readonly Participant[];
  readonly evidence_completeness: "COMPLETE" | "INCOMPLETE";
  /** Same meeting seen in a second agenda or in a mail thread; identity collapses, it never duplicates. */
  readonly duplicate_of: string | null;
  readonly thread_ref: string | null;
  readonly provenance: Provenance;
}

export interface EpisodeRec {
  readonly meeting_episode_id: string;
  readonly runtime_key: string;
  readonly dataset: Dataset;
  readonly company_key: string;
  readonly contact_keys: readonly string[];
  readonly episode_kind: "PROSPECT" | "INTERNAL";
  readonly proposed_at: string | null;
  readonly accepted_at: string | null;
  readonly booked_at: string | null;
  readonly held_at: string | null;
  readonly qualified_at: string | null;
  readonly canceled_at: string | null;
  readonly agreement_evidence_ref: string | null;
  readonly provenance: Provenance;
}

export interface CoverageRec {
  readonly coverage_key: string;
  readonly runtime_key: string;
  readonly source: "MAILBOX" | "MEETING_EVENTS" | "TRACKER";
  readonly since: string;
  readonly until: string;
  readonly state: "COMPLETE" | "PARTIAL" | "REVOKED" | "NOT_CONNECTED";
  readonly gap_reason: string | null;
  readonly provenance: Provenance;
}

export interface MetricDefRec {
  readonly metric_key: string;
  readonly metric_class: "EVENT_PERIOD" | "COHORT";
  readonly period_kind: "WEEK_HALF_OPEN";
  readonly timezone: "Europe/Paris";
  readonly half_open: true;
  /** `null` means the horizon was never pinned: the metric is NOT_COMPUTABLE, never zero (D02). */
  readonly observation_horizon_days: number | null;
  readonly maturity_rule: string | null;
  readonly production_target_state: "TARGET_NOT_SET";
  readonly fixture_threshold: number | null;
  readonly unit: "CONTACTS" | "MESSAGES" | "EPISODES" | "COMPANIES" | "CONTACTS_PER_CONTACTS";
  readonly provenance: Provenance;
}

export interface RegisteredContextRec {
  readonly runtime_key: string;
  readonly context_resource_key: string;
  readonly owner_principal_key: string;
  readonly lane: "META" | "SALES";
  readonly refs: readonly string[];
  readonly registration_state: "REGISTERED" | "NOT_REGISTERED";
  readonly provenance: Provenance;
}

export interface GtmWorld {
  readonly fixture_root: typeof FIXTURE_ROOT;
  readonly principals: readonly PrincipalProfile[];
  readonly runtimes: readonly RuntimeRec[];
  readonly companies: readonly CompanyRec[];
  readonly contacts: readonly ContactRec[];
  readonly messages: readonly MessageRec[];
  readonly campaigns: readonly CampaignRec[];
  readonly approach_versions: readonly ApproachVersionRec[];
  readonly participations: readonly ParticipationRec[];
  readonly enrollments: readonly EnrollmentRec[];
  readonly exposures: readonly ExposureRec[];
  readonly tracker_events: readonly TrackerEventRec[];
  readonly provider_events: readonly ProviderEventRec[];
  readonly episodes: readonly EpisodeRec[];
  readonly coverage: readonly CoverageRec[];
  readonly metric_defs: readonly MetricDefRec[];
  readonly registered_context: readonly RegisteredContextRec[];
}

/** Collection name → catalog resource key. The catalog validation walks exactly this map. */
export const COLLECTION_RESOURCE: Readonly<Record<string, string>> = {
  principals: RESOURCE_KEYS.PRINCIPAL,
  runtimes: RESOURCE_KEYS.RUNTIME,
  companies: RESOURCE_KEYS.COMPANY,
  contacts: RESOURCE_KEYS.CONTACT,
  messages: RESOURCE_KEYS.MESSAGE,
  campaigns: RESOURCE_KEYS.CAMPAIGN,
  approach_versions: RESOURCE_KEYS.APPROACH_VERSION,
  participations: RESOURCE_KEYS.PARTICIPATION,
  enrollments: RESOURCE_KEYS.ENROLLMENT,
  exposures: RESOURCE_KEYS.EXPOSURE,
  tracker_events: RESOURCE_KEYS.TRACKER_EVENT,
  provider_events: RESOURCE_KEYS.PROVIDER_EVENT,
  episodes: RESOURCE_KEYS.MEETING_EPISODE,
  coverage: RESOURCE_KEYS.COVERAGE,
  metric_defs: RESOURCE_KEYS.METRIC_DEF,
  registered_context: RESOURCE_KEYS.REGISTERED_CONTEXT,
};

/* ────────────────────────────── the data ────────────────────────────── */

export const R_TEST = "R_TEST";
export const R_ALT = "R_ALT";
export const R_HOLD = "R_HOLD";

const mail = (local: string): string => `${local}@${FIXTURE_DOMAIN}`;

const PRINCIPALS: readonly PrincipalProfile[] = [
  {
    principal_key: "CELIA_FIXTURE", display_label: "Fixture profile 1", runtime_key: R_TEST,
    setup_shape: "ADVANCED_B6_SHAPED", notion_state: "RESOLVED", gmail_read_state: "VERIFIED",
    tracker_state: "INACCESSIBLE", calendar_state: "PENDING",
    gmail_manifest_identity: mail("profile-1-fixture"), gmail_registry_identity: mail("profile-1-fixture"),
    divergence: "NONE", hold_reason: null, provenance: prov("EV-PROFILE-1"),
  },
  {
    principal_key: "JULIAN_FIXTURE", display_label: "Fixture profile 2", runtime_key: R_ALT,
    setup_shape: "B3_SHAPED", notion_state: "RESOLVED", gmail_read_state: "VERIFIED",
    tracker_state: "PARTIAL", calendar_state: "PENDING",
    gmail_manifest_identity: mail("profile-2-fixture"), gmail_registry_identity: mail("profile-2-fixture"),
    divergence: "NONE", hold_reason: null, provenance: prov("EV-PROFILE-2"),
  },
  {
    principal_key: "ARON_FIXTURE", display_label: "Fixture profile 3", runtime_key: R_HOLD,
    setup_shape: "B2_HOLD_SHAPED", notion_state: "RESOLVED", gmail_read_state: "HOLD_DIVERGENCE",
    tracker_state: "UNKNOWN", calendar_state: "PENDING",
    gmail_manifest_identity: mail("profile-3-manifest-fixture"), gmail_registry_identity: mail("profile-3-registry-fixture"),
    divergence: "MANIFEST_VS_REGISTRY",
    hold_reason: "the mailbox identity declared by the manifest and the one held by the registry differ; a human resolves it",
    provenance: prov("EV-PROFILE-3"),
  },
  {
    principal_key: "VALENTIN_FIXTURE", display_label: "Fixture profile 4", runtime_key: null,
    setup_shape: "NO_RUNTIME", notion_state: "NOT_APPLICABLE", gmail_read_state: "NOT_APPLICABLE",
    tracker_state: "NOT_APPLICABLE", calendar_state: "NOT_APPLICABLE",
    gmail_manifest_identity: null, gmail_registry_identity: null, divergence: "NONE",
    hold_reason: "no runtime exists for this profile; it never borrows another principal's runtime",
    provenance: prov("EV-PROFILE-4"),
  },
];

const runtime = (runtime_key: string, owner_principal_key: string): RuntimeRec => ({
  runtime_key, owner_principal_key, runtime_generation: "gen-1", runtime_scope: "FIXTURE",
  shared_reality_topology: "ABSENT", calendar_source_connected: false, provenance: prov(`EV-RUNTIME-${runtime_key}`),
});

const RUNTIMES: readonly RuntimeRec[] = [
  runtime(R_TEST, "CELIA_FIXTURE"), runtime(R_ALT, "JULIAN_FIXTURE"), runtime(R_HOLD, "ARON_FIXTURE"),
];

const company = (runtime_key: string, company_key: string, classification: "EXTERNAL" | "INTERNAL" = "EXTERNAL"): CompanyRec =>
  ({ runtime_key, company_key, classification, provenance: prov(`EV-COMPANY-${runtime_key}-${company_key}`) });

const COMPANIES: readonly CompanyRec[] = [
  company(R_TEST, "CO-01"), company(R_TEST, "CO-02"), company(R_TEST, "CO-03"), company(R_TEST, "CO-04"),
  company(R_TEST, "CO-05"), company(R_TEST, "CO-07"), company(R_TEST, "CO-08"), company(R_TEST, "CO-10"),
  company(R_TEST, "CO-12"), company(R_TEST, "CO-13"), company(R_TEST, "CO-INTERNAL", "INTERNAL"),
  // CO-01 also exists in the second runtime: the same real-world company, two runtimes, no shared topology (D06).
  company(R_ALT, "CO-01"),
];

interface ContactSeed {
  readonly key: string; readonly runtime: string; readonly company: string;
  readonly party?: "EXTERNAL_PROSPECT" | "INTERNAL";
  readonly resolution?: "CANONICAL" | "UNRESOLVED";
  readonly opted_out?: boolean; readonly stopped?: boolean; readonly takeover?: boolean;
}

const contact = (s: ContactSeed): ContactRec => ({
  contact_key: s.key, runtime_key: s.runtime, company_key: s.company,
  canonical_identity: mail(`${s.key.toLowerCase()}-${s.runtime.toLowerCase()}`),
  party: s.party ?? "EXTERNAL_PROSPECT", identity_resolution: s.resolution ?? "CANONICAL",
  opted_out: s.opted_out ?? false, address_stopped: s.stopped ?? false, takeover_required: s.takeover ?? false,
  provenance: prov(`EV-CONTACT-${s.key}`),
});

const CONTACTS: readonly ContactRec[] = [
  contact({ key: "C01", runtime: R_TEST, company: "CO-01" }),
  contact({ key: "C02", runtime: R_TEST, company: "CO-02" }),
  contact({ key: "C03", runtime: R_TEST, company: "CO-03", opted_out: true }),
  contact({ key: "C04", runtime: R_TEST, company: "CO-04" }),
  contact({ key: "C05", runtime: R_TEST, company: "CO-05" }),
  contact({ key: "C06", runtime: R_TEST, company: "CO-INTERNAL", party: "INTERNAL" }),
  contact({ key: "C07", runtime: R_TEST, company: "CO-07", takeover: true }),
  contact({ key: "C08", runtime: R_TEST, company: "CO-08", stopped: true }),
  contact({ key: "C09", runtime: R_TEST, company: "CO-01" }),
  contact({ key: "C10", runtime: R_TEST, company: "CO-10" }),
  contact({ key: "C12", runtime: R_TEST, company: "CO-12" }),
  contact({ key: "C13", runtime: R_TEST, company: "CO-13" }),
  contact({ key: "C20", runtime: R_ALT, company: "CO-01" }),
];

const AP_1_V1 = "AP-1/v1";
const AP_1_V2 = "AP-1/v2";
const AP_2_V1 = "AP-2/v1";

const APPROACH_VERSIONS: readonly ApproachVersionRec[] = [
  { approach_version_key: AP_1_V1, approach_key: "AP-1", version_label: "v1", authority_scope: "SALES_OUTBOUND_EMAIL", variant_of: null, provenance: prov("EV-AP-1-V1") },
  { approach_version_key: AP_1_V2, approach_key: "AP-1", version_label: "v2", authority_scope: "SALES_OUTBOUND_EMAIL", variant_of: AP_1_V1, provenance: prov("EV-AP-1-V2") },
  { approach_version_key: AP_2_V1, approach_key: "AP-2", version_label: "v1", authority_scope: "SALES_OUTBOUND_EMAIL", variant_of: null, provenance: prov("EV-AP-2-V1") },
];

const CAMPAIGNS: readonly CampaignRec[] = [
  { campaign_key: "CMP-1", runtime_key: R_TEST, owner_principal_key: "CELIA_FIXTURE", approach_key: "AP-1", configured_offer: "OFFER-LEGACY", configured_price_cents: 150000, currency: "EUR", started_at: "2026-08-03T09:00:00+02:00", ended_at: "2026-09-06T18:00:00+02:00", status: "ENDED", provenance: prov("EV-CMP-1") },
  { campaign_key: "CMP-2", runtime_key: R_TEST, owner_principal_key: "CELIA_FIXTURE", approach_key: "AP-1", configured_offer: "OFFER-STD", configured_price_cents: 120000, currency: "EUR", started_at: "2026-09-07T09:00:00+02:00", ended_at: null, status: "ACTIVE", provenance: prov("EV-CMP-2") },
  { campaign_key: "CMP-3", runtime_key: R_TEST, owner_principal_key: "CELIA_FIXTURE", approach_key: "AP-2", configured_offer: "OFFER-STD", configured_price_cents: 120000, currency: "EUR", started_at: "2026-09-07T09:00:00+02:00", ended_at: null, status: "ACTIVE", provenance: prov("EV-CMP-3") },
  { campaign_key: "CMP-4", runtime_key: R_ALT, owner_principal_key: "JULIAN_FIXTURE", approach_key: "AP-2", configured_offer: "OFFER-STD", configured_price_cents: 120000, currency: "EUR", started_at: "2026-09-07T09:00:00+02:00", ended_at: null, status: "ACTIVE", provenance: prov("EV-CMP-4") },
];

const PART_R1_A1V0 = "PART-R1-A1V0";
const PART_R1_A1V1 = "PART-R1-A1V1";
const PART_R1_A1V2 = "PART-R1-A1V2";
const PART_R1_A2V1 = "PART-R1-A2V1";
const PART_R2_A2V1 = "PART-R2-A2V1";

const PARTICIPATIONS: readonly ParticipationRec[] = [
  { participation_key: PART_R1_A1V0, runtime_key: R_TEST, owner_principal_key: "CELIA_FIXTURE", approach_version_key: AP_1_V1, campaign_key: "CMP-1", provenance: prov("EV-PART-0") },
  { participation_key: PART_R1_A1V1, runtime_key: R_TEST, owner_principal_key: "CELIA_FIXTURE", approach_version_key: AP_1_V1, campaign_key: "CMP-2", provenance: prov("EV-PART-1") },
  { participation_key: PART_R1_A1V2, runtime_key: R_TEST, owner_principal_key: "CELIA_FIXTURE", approach_version_key: AP_1_V2, campaign_key: "CMP-2", provenance: prov("EV-PART-2") },
  { participation_key: PART_R1_A2V1, runtime_key: R_TEST, owner_principal_key: "CELIA_FIXTURE", approach_version_key: AP_2_V1, campaign_key: "CMP-3", provenance: prov("EV-PART-3") },
  { participation_key: PART_R2_A2V1, runtime_key: R_ALT, owner_principal_key: "JULIAN_FIXTURE", approach_version_key: AP_2_V1, campaign_key: "CMP-4", provenance: prov("EV-PART-4") },
];

const enrollment = (campaign_key: string, contact_key: string, state: "ACTIVE" | "ENDED", started_at: string, ended_at: string | null, runtime_key = R_TEST): EnrollmentRec => ({
  enrollment_key: `ENR-${campaign_key}-${contact_key}`, runtime_key, campaign_key, contact_key, state, started_at, ended_at,
  provenance: prov(`EV-ENR-${campaign_key}-${contact_key}`),
});

const ENROLLMENTS: readonly EnrollmentRec[] = [
  // C01 ran in CMP-1 first, then in CMP-2: successive in time, never two ACTIVE at once.
  enrollment("CMP-1", "C01", "ENDED", "2026-08-03T09:00:00+02:00", "2026-09-06T18:00:00+02:00"),
  enrollment("CMP-2", "C01", "ACTIVE", "2026-09-07T09:00:00+02:00", null),
  ...["C02", "C03", "C04", "C05", "C06", "C07", "C08", "C09", "C10", "C13"].map((c) =>
    enrollment("CMP-2", c, "ACTIVE", "2026-09-07T09:00:00+02:00", null)),
  // C12 was touched by CMP-3 first and by CMP-2 afterwards: two touchpoints, one ACTIVE enrollment.
  enrollment("CMP-3", "C12", "ENDED", "2026-09-07T09:00:00+02:00", "2026-09-11T18:00:00+02:00"),
  enrollment("CMP-2", "C12", "ACTIVE", "2026-09-11T18:00:00+02:00", null),
  enrollment("CMP-4", "C20", "ACTIVE", "2026-09-07T09:00:00+02:00", null, R_ALT),
];

interface OutSeed {
  readonly key: string; readonly contact: string; readonly at: string;
  readonly campaign: string; readonly version: string; readonly participation: string;
  readonly exposure?: string; readonly runtime?: string;
}

const outbound = (s: OutSeed): MessageRec => ({
  message_key: s.key, runtime_key: s.runtime ?? R_TEST, contact_key: s.contact, direction: "OUTBOUND",
  provider_message_id: `PM-${s.key}`, occurred_at: s.at, kind: "HUMAN", intent: "OUTBOUND_APPROACH",
  campaign_key: s.campaign, approach_version_key: s.version, participation_key: s.participation,
  exposure_key: s.exposure ?? null, in_reply_to: null, agreement_evidence: null, provenance: prov(`EV-${s.key}`),
});

interface InSeed {
  readonly key: string; readonly contact: string; readonly at: string;
  readonly kind: MessageKind; readonly intent: MessageIntent;
  readonly provider?: string; readonly in_reply_to?: string; readonly agreement?: string; readonly runtime?: string;
}

const inbound = (s: InSeed): MessageRec => ({
  message_key: s.key, runtime_key: s.runtime ?? R_TEST, contact_key: s.contact, direction: "INBOUND",
  provider_message_id: s.provider ?? `PM-${s.key}`, occurred_at: s.at, kind: s.kind, intent: s.intent,
  campaign_key: null, approach_version_key: null, participation_key: null, exposure_key: null,
  in_reply_to: s.in_reply_to ?? null, agreement_evidence: s.agreement ?? null, provenance: prov(`EV-${s.key}`),
});

const MESSAGES: readonly MessageRec[] = [
  /* the touch that predates the bounded attribution lookback entirely */
  outbound({ key: "OUT-C01-LEGACY", contact: "C01", at: "2026-08-05T09:00:00+02:00", campaign: "CMP-1", version: AP_1_V1, participation: PART_R1_A1V0, exposure: "EXP-C01-OLD" }),
  /* outbound inside W — the seven external entrants of the entry cohort */
  outbound({ key: "OUT-C01", contact: "C01", at: "2026-09-14T09:00:00+02:00", campaign: "CMP-2", version: AP_1_V1, participation: PART_R1_A1V1, exposure: "EXP-C01" }),
  outbound({ key: "OUT-C02", contact: "C02", at: "2026-09-14T09:05:00+02:00", campaign: "CMP-2", version: AP_1_V1, participation: PART_R1_A1V1 }),
  outbound({ key: "OUT-C03", contact: "C03", at: "2026-09-14T09:10:00+02:00", campaign: "CMP-2", version: AP_1_V1, participation: PART_R1_A1V1 }),
  outbound({ key: "OUT-C07", contact: "C07", at: "2026-09-14T09:15:00+02:00", campaign: "CMP-2", version: AP_1_V1, participation: PART_R1_A1V1 }),
  outbound({ key: "OUT-C08", contact: "C08", at: "2026-09-15T09:00:00+02:00", campaign: "CMP-2", version: AP_1_V2, participation: PART_R1_A1V2 }),
  outbound({ key: "OUT-C09", contact: "C09", at: "2026-09-15T09:05:00+02:00", campaign: "CMP-2", version: AP_1_V2, participation: PART_R1_A1V2, exposure: "EXP-C09" }),
  outbound({ key: "OUT-C10", contact: "C10", at: "2026-09-15T09:10:00+02:00", campaign: "CMP-2", version: AP_1_V2, participation: PART_R1_A1V2 }),
  /* outbound inside W to an internal counterpart — never an external prospect entrant */
  outbound({ key: "OUT-C06", contact: "C06", at: "2026-09-15T11:00:00+02:00", campaign: "CMP-2", version: AP_1_V1, participation: PART_R1_A1V1 }),
  /* outbound before W — replies land in W, entry cohort membership does not */
  outbound({ key: "OUT-C05", contact: "C05", at: "2026-09-10T09:00:00+02:00", campaign: "CMP-2", version: AP_1_V1, participation: PART_R1_A1V1 }),
  outbound({ key: "OUT-C13", contact: "C13", at: "2026-09-11T09:00:00+02:00", campaign: "CMP-2", version: AP_1_V1, participation: PART_R1_A1V1 }),
  /* two touchpoints on one contact, from two campaigns: ambiguity, never an implicit last touch */
  outbound({ key: "OUT-C12-A", contact: "C12", at: "2026-09-08T09:00:00+02:00", campaign: "CMP-3", version: AP_2_V1, participation: PART_R1_A2V1 }),
  outbound({ key: "OUT-C12-B", contact: "C12", at: "2026-09-12T09:00:00+02:00", campaign: "CMP-2", version: AP_1_V1, participation: PART_R1_A1V1 }),
  /* the second runtime */
  outbound({ key: "OUT-C20", contact: "C20", at: "2026-09-14T10:00:00+02:00", campaign: "CMP-4", version: AP_2_V1, participation: PART_R2_A2V1, runtime: R_ALT }),

  /* inbound — C01: three eligible human replies, the first delivered twice by the provider */
  inbound({ key: "IN-C01-1", contact: "C01", at: "2026-09-15T10:00:00+02:00", kind: "HUMAN", intent: "POSITIVE", provider: "PM-IN-C01-1", in_reply_to: "OUT-C01" }),
  inbound({ key: "IN-C01-1-DUP", contact: "C01", at: "2026-09-15T10:00:00+02:00", kind: "HUMAN", intent: "POSITIVE", provider: "PM-IN-C01-1", in_reply_to: "OUT-C01" }),
  inbound({ key: "IN-C01-2", contact: "C01", at: "2026-09-16T10:00:00+02:00", kind: "HUMAN", intent: "QUESTION", in_reply_to: "OUT-C01" }),
  inbound({ key: "IN-C01-3", contact: "C01", at: "2026-09-17T10:00:00+02:00", kind: "HUMAN", intent: "OBJECTION", in_reply_to: "OUT-C01" }),
  inbound({ key: "IN-C02", contact: "C02", at: "2026-09-15T10:05:00+02:00", kind: "TECHNICAL", intent: "OUT_OF_OFFICE", in_reply_to: "OUT-C02" }),
  inbound({ key: "IN-C03", contact: "C03", at: "2026-09-15T10:10:00+02:00", kind: "HUMAN", intent: "OPT_OUT", in_reply_to: "OUT-C03" }),
  inbound({ key: "IN-C04", contact: "C04", at: "2026-09-16T11:00:00+02:00", kind: "HUMAN", intent: "QUESTION" }),
  inbound({ key: "IN-C05", contact: "C05", at: WEEK_W.start, kind: "HUMAN", intent: "NEGATIVE", in_reply_to: "OUT-C05" }),
  inbound({ key: "IN-C06", contact: "C06", at: "2026-09-16T12:00:00+02:00", kind: "HUMAN", intent: "POSITIVE", in_reply_to: "OUT-C06" }),
  inbound({ key: "IN-C07", contact: "C07", at: "2026-09-16T13:00:00+02:00", kind: "UNKNOWN", intent: "UNDETERMINED", in_reply_to: "OUT-C07" }),
  inbound({ key: "IN-C08", contact: "C08", at: "2026-09-16T14:00:00+02:00", kind: "TECHNICAL", intent: "BOUNCE_PERMANENT", in_reply_to: "OUT-C08" }),
  inbound({ key: "IN-C09", contact: "C09", at: "2026-09-16T15:00:00+02:00", kind: "HUMAN", intent: "POSITIVE", in_reply_to: "OUT-C09", agreement: "EV-AGREE-C09" }),
  inbound({ key: "IN-C12", contact: "C12", at: "2026-09-16T16:00:00+02:00", kind: "HUMAN", intent: "POSITIVE" }),
  /* pinned exactly on the upper bound of W: it belongs to the next week, never to W (half-open) */
  inbound({ key: "IN-C13", contact: "C13", at: WEEK_W.end, kind: "HUMAN", intent: "POSITIVE", in_reply_to: "OUT-C13" }),
  inbound({ key: "IN-C20", contact: "C20", at: "2026-09-16T10:00:00+02:00", kind: "HUMAN", intent: "POSITIVE", in_reply_to: "OUT-C20", runtime: R_ALT }),
];

const EXPOSURES: readonly ExposureRec[] = [
  // Pinned under CMP-1 while its configured offer was OFFER-LEGACY. It never changes afterwards.
  { exposure_key: "EXP-C01-OLD", runtime_key: R_TEST, contact_key: "C01", message_key: "OUT-C01-LEGACY", campaign_key: "CMP-1", approach_version_key: AP_1_V1, communicated_offer: "OFFER-LEGACY", communicated_price_cents: 150000, currency: "EUR", override_evidence: null, pinned_at: "2026-08-05T09:00:00+02:00", provenance: prov("EV-EXP-C01-OLD", "2026-08-05T09:10:00+02:00") },
  // What was actually communicated differs from what CMP-2 configures: the override is pinned with its evidence.
  { exposure_key: "EXP-C01", runtime_key: R_TEST, contact_key: "C01", message_key: "OUT-C01", campaign_key: "CMP-2", approach_version_key: AP_1_V1, communicated_offer: "OFFER-PILOT", communicated_price_cents: 90000, currency: "EUR", override_evidence: "EV-OVERRIDE-C01: the sent body pins the pilot price agreed for this contact", pinned_at: "2026-09-14T09:00:00+02:00", provenance: prov("EV-EXP-C01") },
  { exposure_key: "EXP-C09", runtime_key: R_TEST, contact_key: "C09", message_key: "OUT-C09", campaign_key: "CMP-2", approach_version_key: AP_1_V2, communicated_offer: "OFFER-STD", communicated_price_cents: 120000, currency: "EUR", override_evidence: null, pinned_at: "2026-09-15T09:05:00+02:00", provenance: prov("EV-EXP-C09") },
];

const TRACKER_EVENTS: readonly TrackerEventRec[] = [
  { tracker_event_key: "TRK-1", runtime_key: R_TEST, message_key: "OUT-C01", link_key: "LNK-C01", event_type: "LINK_SENT", occurred_at: "2026-09-14T09:00:00+02:00", reader_fingerprint: null, provenance: prov("EV-TRK-1") },
  { tracker_event_key: "TRK-2", runtime_key: R_TEST, message_key: "OUT-C09", link_key: "LNK-C09", event_type: "LINK_SENT", occurred_at: "2026-09-15T09:05:00+02:00", reader_fingerprint: null, provenance: prov("EV-TRK-2") },
  { tracker_event_key: "TRK-3", runtime_key: R_TEST, message_key: "OUT-C09", link_key: "LNK-C09", event_type: "LINK_READ", occurred_at: "2026-09-16T10:00:00+02:00", reader_fingerprint: "RDR-1", provenance: prov("EV-TRK-3") },
  // Same link, same reader, 30 seconds later: one distinct read, not two.
  { tracker_event_key: "TRK-4", runtime_key: R_TEST, message_key: "OUT-C09", link_key: "LNK-C09", event_type: "LINK_READ", occurred_at: "2026-09-16T10:00:30+02:00", reader_fingerprint: "RDR-1", provenance: prov("EV-TRK-4") },
];

const internalHuman = (n: string): Participant => ({ participant_key: `P-INT-${n}`, kind: "INTERNAL_HUMAN", identity: mail(`internal-${n}-fixture`), established_external: false });
const externalHuman = (n: string): Participant => ({ participant_key: `P-EXT-${n}`, kind: "EXTERNAL_HUMAN", identity: mail(`external-${n}-fixture`), established_external: true });
const internalAlias = (n: string): Participant => ({ participant_key: `P-ALIAS-${n}`, kind: "INTERNAL_ALIAS", identity: mail(`team-${n}-fixture`), established_external: false });
const botParticipant = (n: string): Participant => ({ participant_key: `P-BOT-${n}`, kind: "BOT", identity: mail(`bot-${n}-fixture`), established_external: false });
const roomParticipant = (n: string): Participant => ({ participant_key: `P-ROOM-${n}`, kind: "ROOM", identity: mail(`room-${n}-fixture`), established_external: false });
const maskedParticipant = (n: string): Participant => ({ participant_key: `P-MASK-${n}`, kind: "MASKED", identity: "masked-truncated…", established_external: false });

interface EventSeed {
  readonly key: string; readonly episode: string; readonly starts: string;
  readonly participants: readonly Participant[];
  readonly title?: string;
  readonly agenda?: "COMMERCIAL_AGREED_AGENDA" | "NON_COMMERCIAL_AGENDA" | "NONE";
  readonly status?: "CONFIRMED" | "CANCELED" | "UNACCEPTED" | "TENTATIVE";
  readonly reschedule_of?: string; readonly series?: string; readonly occurrence?: number;
  readonly completeness?: "COMPLETE" | "INCOMPLETE";
  readonly duplicate_of?: string; readonly thread_ref?: string;
  readonly dataset?: Dataset;
}

const providerEvent = (s: EventSeed): ProviderEventRec => ({
  provider_event_key: s.key, runtime_key: R_TEST, dataset: s.dataset ?? "CAL", meeting_episode_id: s.episode,
  series_key: s.series ?? null, occurrence_index: s.occurrence ?? null, reschedule_of: s.reschedule_of ?? null,
  starts_at: s.starts, ends_at: new Date(ms(s.starts) + 30 * 60_000).toISOString(),
  status: s.status ?? "CONFIRMED", title: s.title ?? "Fixture event", agenda_evidence: s.agenda ?? "NONE",
  participants: s.participants, evidence_completeness: s.completeness ?? "COMPLETE",
  duplicate_of: s.duplicate_of ?? null, thread_ref: s.thread_ref ?? null, provenance: prov(`EV-${s.key}`),
});

const SELLER = internalHuman("seller");
const SECOND_REP = internalHuman("second-rep");
const PROSPECT_C09 = externalHuman("prospect-c09");

const PROVIDER_EVENTS: readonly ProviderEventRec[] = [
  /* M01 — one episode, one booking creation, two reschedules */
  providerEvent({ dataset: "O2", key: "EVT-M01-1", episode: "EP-M01", starts: "2026-09-18T10:00:00+02:00", participants: [SELLER, PROSPECT_C09], title: "Découverte", agenda: "COMMERCIAL_AGREED_AGENDA" }),
  providerEvent({ dataset: "O2", key: "EVT-M01-2", episode: "EP-M01", starts: "2026-09-19T10:00:00+02:00", participants: [SELLER, PROSPECT_C09], title: "Découverte", agenda: "COMMERCIAL_AGREED_AGENDA", reschedule_of: "EVT-M01-1" }),
  providerEvent({ dataset: "O2", key: "EVT-M01-3", episode: "EP-M01", starts: "2026-09-22T10:00:00+02:00", participants: [SELLER, PROSPECT_C09], title: "Découverte", agenda: "COMMERCIAL_AGREED_AGENDA", reschedule_of: "EVT-M01-2" }),
  /* F01 — an internal work block, never a prospect meeting */
  providerEvent({ dataset: "O2", key: "EVT-F01", episode: "EP-F01", starts: "2026-09-17T14:00:00+02:00", participants: [SELLER, SECOND_REP], title: "Bloc de travail" }),

  /* D-CAL-01 classification cases (PT-GTM-012 A–H) */
  providerEvent({ key: "EVT-CAL-A", episode: "EP-CAL-A", starts: "2026-09-14T14:00:00+02:00", participants: [SELLER, SECOND_REP], title: "Point interne" }),
  providerEvent({ key: "EVT-CAL-B", episode: "EP-CAL-B", starts: "2026-09-15T14:00:00+02:00", participants: [SELLER, externalHuman("prospect-b")], title: "Échange", agenda: "COMMERCIAL_AGREED_AGENDA" }),
  providerEvent({ key: "EVT-CAL-C", episode: "EP-CAL-C", starts: "2026-09-16T14:00:00+02:00", participants: [SELLER, SECOND_REP, externalHuman("prospect-c")], title: "Échange", agenda: "COMMERCIAL_AGREED_AGENDA" }),
  providerEvent({ key: "EVT-CAL-D", episode: "EP-CAL-D", starts: "2026-09-16T16:00:00+02:00", participants: [SELLER, internalAlias("ops")], title: "Revue" }),
  providerEvent({ key: "EVT-CAL-E", episode: "EP-CAL-E", starts: "2026-09-17T09:00:00+02:00", participants: [SELLER, botParticipant("notes"), roomParticipant("salle-1")], title: "Revue" }),
  providerEvent({ key: "EVT-CAL-F", episode: "EP-CAL-F", starts: "2026-09-17T11:00:00+02:00", participants: [SELLER, maskedParticipant("1")], title: "Échange", completeness: "INCOMPLETE" }),
  providerEvent({ key: "EVT-CAL-G", episode: "EP-CAL-G", starts: "2026-09-17T16:00:00+02:00", participants: [SELLER, externalHuman("comptable")], title: "Point annuel", agenda: "NON_COMMERCIAL_AGENDA" }),
  providerEvent({ key: "EVT-CAL-H", episode: "EP-CAL-H", starts: "2026-09-18T09:00:00+02:00", participants: [SELLER, SECOND_REP], title: "Prospection — closing prospect" }),

  /* PT-GTM-013 A–F substrate */
  providerEvent({ key: "EVT-CAL-MULTI-1", episode: "EP-CAL-MULTI", starts: "2026-09-18T15:00:00+02:00", participants: [SELLER, externalHuman("prospect-multi")], title: "Échange", agenda: "COMMERCIAL_AGREED_AGENDA", thread_ref: "THREAD-FIXTURE-1" }),
  providerEvent({ key: "EVT-CAL-MULTI-2", episode: "EP-CAL-MULTI", starts: "2026-09-18T15:00:00+02:00", participants: [SECOND_REP, externalHuman("prospect-multi")], title: "Échange", agenda: "COMMERCIAL_AGREED_AGENDA", duplicate_of: "EVT-CAL-MULTI-1", thread_ref: "THREAD-FIXTURE-1" }),
  providerEvent({ key: "EVT-CAL-REC-1", episode: "EP-CAL-REC-1", starts: "2026-09-15T08:00:00+02:00", participants: [SELLER, externalHuman("prospect-rec")], title: "Suivi hebdomadaire", agenda: "COMMERCIAL_AGREED_AGENDA", series: "SER-1", occurrence: 1 }),
  providerEvent({ key: "EVT-CAL-REC-2", episode: "EP-CAL-REC-2", starts: "2026-09-22T08:00:00+02:00", participants: [SELLER, externalHuman("prospect-rec")], title: "Suivi hebdomadaire", agenda: "COMMERCIAL_AGREED_AGENDA", series: "SER-1", occurrence: 2 }),
  providerEvent({ key: "EVT-CAL-REC-3", episode: "EP-CAL-REC-3", starts: "2026-09-29T08:00:00+02:00", participants: [SELLER, externalHuman("prospect-rec")], title: "Suivi hebdomadaire", agenda: "COMMERCIAL_AGREED_AGENDA", series: "SER-1", occurrence: 3 }),
  providerEvent({ key: "EVT-CAL-CANCEL", episode: "EP-CAL-CANCEL", starts: "2026-09-18T17:00:00+02:00", participants: [SELLER, externalHuman("prospect-cancel")], title: "Échange", agenda: "COMMERCIAL_AGREED_AGENDA", status: "CANCELED" }),
  providerEvent({ key: "EVT-CAL-UNACCEPTED", episode: "EP-CAL-UNACCEPTED", starts: "2026-09-19T17:00:00+02:00", participants: [SELLER, externalHuman("prospect-unaccepted")], title: "Échange", agenda: "COMMERCIAL_AGREED_AGENDA", status: "UNACCEPTED" }),
];

const episode = (
  dataset: Dataset, meeting_episode_id: string, company_key: string, contact_keys: readonly string[], episode_kind: "PROSPECT" | "INTERNAL",
  stamps: { proposed?: string; accepted?: string; booked?: string; held?: string; qualified?: string; canceled?: string; agreement?: string },
): EpisodeRec => ({
  meeting_episode_id, runtime_key: R_TEST, dataset, company_key, contact_keys, episode_kind,
  proposed_at: stamps.proposed ?? null, accepted_at: stamps.accepted ?? null, booked_at: stamps.booked ?? null,
  held_at: stamps.held ?? null, qualified_at: stamps.qualified ?? null, canceled_at: stamps.canceled ?? null,
  agreement_evidence_ref: stamps.agreement ?? null, provenance: prov(`EV-${meeting_episode_id}`),
});

const EPISODES: readonly EpisodeRec[] = [
  episode("O2", "EP-M01", "CO-01", ["C09"], "PROSPECT", { proposed: "2026-09-16T11:00:00+02:00", accepted: "2026-09-16T15:00:00+02:00", booked: "2026-09-16T15:05:00+02:00", agreement: "EV-AGREE-C09" }),
  // A proposal the contact never agreed to: proposed, never accepted, never booked.
  episode("O2", "EP-M02", "CO-01", ["C01"], "PROSPECT", { proposed: "2026-09-17T09:00:00+02:00" }),
  episode("O2", "EP-F01", "CO-INTERNAL", [], "INTERNAL", { booked: "2026-09-16T09:00:00+02:00" }),
  episode("CAL", "EP-CAL-A", "CO-INTERNAL", [], "INTERNAL", { booked: "2026-09-13T09:00:00+02:00" }),
  episode("CAL", "EP-CAL-B", "CO-02", [], "PROSPECT", { proposed: "2026-09-14T09:00:00+02:00", accepted: "2026-09-14T10:00:00+02:00", booked: "2026-09-14T10:05:00+02:00", agreement: "EV-AGREE-CAL-B" }),
  episode("CAL", "EP-CAL-C", "CO-07", [], "PROSPECT", { proposed: "2026-09-15T09:00:00+02:00", accepted: "2026-09-15T10:00:00+02:00", booked: "2026-09-15T10:05:00+02:00", agreement: "EV-AGREE-CAL-C" }),
  episode("CAL", "EP-CAL-D", "CO-INTERNAL", [], "INTERNAL", { booked: "2026-09-15T12:00:00+02:00" }),
  episode("CAL", "EP-CAL-E", "CO-INTERNAL", [], "INTERNAL", { booked: "2026-09-16T08:00:00+02:00" }),
  episode("CAL", "EP-CAL-F", "CO-04", [], "PROSPECT", { proposed: "2026-09-16T10:00:00+02:00" }),
  episode("CAL", "EP-CAL-G", "CO-10", [], "PROSPECT", { proposed: "2026-09-16T12:00:00+02:00", accepted: "2026-09-16T13:00:00+02:00", booked: "2026-09-16T13:05:00+02:00", agreement: "EV-AGREE-CAL-G" }),
  episode("CAL", "EP-CAL-H", "CO-INTERNAL", [], "INTERNAL", { booked: "2026-09-17T08:00:00+02:00" }),
  episode("CAL", "EP-CAL-MULTI", "CO-12", [], "PROSPECT", { proposed: "2026-09-17T15:00:00+02:00", accepted: "2026-09-17T16:00:00+02:00", booked: "2026-09-17T16:05:00+02:00", agreement: "EV-AGREE-MULTI" }),
  episode("CAL", "EP-CAL-REC-1", "CO-13", [], "PROSPECT", { proposed: "2026-09-13T09:00:00+02:00", accepted: "2026-09-13T10:00:00+02:00", booked: "2026-09-13T10:05:00+02:00", agreement: "EV-AGREE-REC" }),
  episode("CAL", "EP-CAL-REC-2", "CO-13", [], "PROSPECT", { proposed: "2026-09-13T09:00:00+02:00", accepted: "2026-09-13T10:00:00+02:00", booked: "2026-09-13T10:05:00+02:00", agreement: "EV-AGREE-REC" }),
  episode("CAL", "EP-CAL-REC-3", "CO-13", [], "PROSPECT", { proposed: "2026-09-13T09:00:00+02:00", accepted: "2026-09-13T10:00:00+02:00", booked: "2026-09-13T10:05:00+02:00", agreement: "EV-AGREE-REC" }),
  episode("CAL", "EP-CAL-CANCEL", "CO-03", [], "PROSPECT", { proposed: "2026-09-16T17:00:00+02:00", accepted: "2026-09-16T18:00:00+02:00", booked: "2026-09-16T18:05:00+02:00", canceled: "2026-09-17T18:00:00+02:00", agreement: "EV-AGREE-CANCEL" }),
  episode("CAL", "EP-CAL-UNACCEPTED", "CO-05", [], "PROSPECT", { proposed: "2026-09-17T17:00:00+02:00" }),
];

const COVERAGE: readonly CoverageRec[] = [
  { coverage_key: "COV-MBX-R_TEST", runtime_key: R_TEST, source: "MAILBOX", since: WEEK_PREV.start, until: OBSERVED_AT, state: "COMPLETE", gap_reason: null, provenance: prov("EV-COV-MBX-1") },
  { coverage_key: "COV-EVT-R_TEST", runtime_key: R_TEST, source: "MEETING_EVENTS", since: WEEK_PREV.start, until: OBSERVED_AT, state: "COMPLETE", gap_reason: null, provenance: prov("EV-COV-EVT-1") },
  { coverage_key: "COV-TRK-R_TEST", runtime_key: R_TEST, source: "TRACKER", since: WEEK_PREV.start, until: OBSERVED_AT, state: "PARTIAL", gap_reason: "the owning profile cannot reach the tracker; observed opens are evidence, tracker-denominated rates are not", provenance: prov("EV-COV-TRK-1") },
  { coverage_key: "COV-MBX-R_ALT", runtime_key: R_ALT, source: "MAILBOX", since: WEEK_PREV.start, until: OBSERVED_AT, state: "COMPLETE", gap_reason: null, provenance: prov("EV-COV-MBX-2") },
];

const METRIC_DEFS: readonly MetricDefRec[] = [
  { metric_key: "weekly_replied_prospects", metric_class: "EVENT_PERIOD", period_kind: "WEEK_HALF_OPEN", timezone: "Europe/Paris", half_open: true, observation_horizon_days: 7, maturity_rule: "OBSERVATION_CUTOFF_AT_OR_AFTER_PERIOD_END_PLUS_HORIZON", production_target_state: "TARGET_NOT_SET", fixture_threshold: 2, unit: "CONTACTS", provenance: prov("EV-METRIC-1") },
  { metric_key: "eligible_human_reply_messages", metric_class: "EVENT_PERIOD", period_kind: "WEEK_HALF_OPEN", timezone: "Europe/Paris", half_open: true, observation_horizon_days: 7, maturity_rule: "OBSERVATION_CUTOFF_AT_OR_AFTER_PERIOD_END_PLUS_HORIZON", production_target_state: "TARGET_NOT_SET", fixture_threshold: null, unit: "MESSAGES", provenance: prov("EV-METRIC-2") },
  { metric_key: "weekly_entry_cohort_reply_rate", metric_class: "COHORT", period_kind: "WEEK_HALF_OPEN", timezone: "Europe/Paris", half_open: true, observation_horizon_days: 7, maturity_rule: "COHORT_MATURE_WHEN_CUTOFF_AT_OR_AFTER_ENTRY_END_PLUS_HORIZON", production_target_state: "TARGET_NOT_SET", fixture_threshold: null, unit: "CONTACTS_PER_CONTACTS", provenance: prov("EV-METRIC-3") },
  { metric_key: "meeting_bookings", metric_class: "EVENT_PERIOD", period_kind: "WEEK_HALF_OPEN", timezone: "Europe/Paris", half_open: true, observation_horizon_days: 7, maturity_rule: "OBSERVATION_CUTOFF_AT_OR_AFTER_PERIOD_END_PLUS_HORIZON", production_target_state: "TARGET_NOT_SET", fixture_threshold: null, unit: "EPISODES", provenance: prov("EV-METRIC-4") },
  { metric_key: "replied_companies", metric_class: "EVENT_PERIOD", period_kind: "WEEK_HALF_OPEN", timezone: "Europe/Paris", half_open: true, observation_horizon_days: 7, maturity_rule: "OBSERVATION_CUTOFF_AT_OR_AFTER_PERIOD_END_PLUS_HORIZON", production_target_state: "TARGET_NOT_SET", fixture_threshold: null, unit: "COMPANIES", provenance: prov("EV-METRIC-5") },
  // NOTE: `qualified_discovery_meetings` is deliberately ABSENT. A held meeting cannot be called qualified
  // without a pinned definition, so the oracle answers NOT_COMPUTABLE instead of inventing a zero (D04).
];

/** Candidate-pack read-selection resource keys. Symbolic, lane-qualified, never a URL or a page id. */
export const GTM_CONTEXT_KEYS = {
  META_SALES_RUNTIME_INPUTS: "META:SALES_RUNTIME_INPUTS",
  META_GTM_METRIC_REFS: "META:GTM_METRIC_REFS",
  SALES_GTM_CAMPAIGN_CONTEXT: "SALES:GTM_CAMPAIGN_CONTEXT",
} as const;

const REGISTERED_CONTEXT: readonly RegisteredContextRec[] = [
  { runtime_key: R_TEST, context_resource_key: GTM_CONTEXT_KEYS.META_SALES_RUNTIME_INPUTS, owner_principal_key: "CELIA_FIXTURE", lane: "META", refs: [`${FIXTURE_ROOT}:REF/META_SALES_RUNTIME_INPUTS/${R_TEST}`], registration_state: "REGISTERED", provenance: prov("EV-CTX-1") },
  { runtime_key: R_TEST, context_resource_key: GTM_CONTEXT_KEYS.META_GTM_METRIC_REFS, owner_principal_key: "CELIA_FIXTURE", lane: "META", refs: [`${FIXTURE_ROOT}:METRIC_DEF#weekly_replied_prospects`, `${FIXTURE_ROOT}:METRIC_DEF#weekly_entry_cohort_reply_rate`], registration_state: "REGISTERED", provenance: prov("EV-CTX-2") },
  { runtime_key: R_TEST, context_resource_key: GTM_CONTEXT_KEYS.SALES_GTM_CAMPAIGN_CONTEXT, owner_principal_key: "CELIA_FIXTURE", lane: "SALES", refs: [`${FIXTURE_ROOT}:CAMPAIGN#CMP-2`, `${FIXTURE_ROOT}:APPROACH_VERSION#${AP_1_V1}`, `${FIXTURE_ROOT}:APPROACH_VERSION#${AP_1_V2}`, `${FIXTURE_ROOT}:PARTICIPATION#${PART_R1_A1V1}`, `${FIXTURE_ROOT}:PARTICIPATION#${PART_R1_A1V2}`, `${FIXTURE_ROOT}:EXPOSURE#EXP-C01`, `${FIXTURE_ROOT}:EXPOSURE#EXP-C09`], registration_state: "REGISTERED", provenance: prov("EV-CTX-3") },
  { runtime_key: R_ALT, context_resource_key: GTM_CONTEXT_KEYS.SALES_GTM_CAMPAIGN_CONTEXT, owner_principal_key: "JULIAN_FIXTURE", lane: "SALES", refs: [`${FIXTURE_ROOT}:CAMPAIGN#CMP-4`, `${FIXTURE_ROOT}:PARTICIPATION#${PART_R2_A2V1}`], registration_state: "REGISTERED", provenance: prov("EV-CTX-4") },
];

/* ────────────────────────────── build / reset / variants ────────────────────────────── */

const BASELINE: GtmWorld = {
  fixture_root: FIXTURE_ROOT,
  principals: PRINCIPALS, runtimes: RUNTIMES, companies: COMPANIES, contacts: CONTACTS, messages: MESSAGES,
  campaigns: CAMPAIGNS, approach_versions: APPROACH_VERSIONS, participations: PARTICIPATIONS,
  enrollments: ENROLLMENTS, exposures: EXPOSURES, tracker_events: TRACKER_EVENTS,
  provider_events: PROVIDER_EVENTS, episodes: EPISODES, coverage: COVERAGE, metric_defs: METRIC_DEFS,
  registered_context: REGISTERED_CONTEXT,
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

/** Stable serialization: object keys sorted, arrays in order. The fingerprint is a hash of this string. */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`).join(",")}}`;
  }
  return "null";
}

export const fingerprint = (value: unknown): string => `sha256:${createHash("sha256").update(canonicalize(value), "utf8").digest("hex")}`;

/** A deeply frozen fresh copy of the pristine baseline. Two calls are deep-equal and share one fingerprint. */
export function buildGtmWorld(): GtmWorld {
  return deepFreeze(structuredClone(BASELINE)) as GtmWorld;
}

/** The reset contract: discard whatever a test derived and rebuild the pristine baseline, deterministically. */
export const resetGtmWorld = buildGtmWorld;

/** Frozen record counts. A silent data edit that changes the shape of the world fails the catalog validation. */
export const BASELINE_SHAPE: Readonly<Record<string, number>> = {
  principals: 4, runtimes: 3, companies: 12, contacts: 13, messages: 29, campaigns: 4, approach_versions: 3,
  participations: 5, enrollments: 15, exposures: 3, tracker_events: 4, provider_events: 19, episodes: 17,
  coverage: 4, metric_defs: 5, registered_context: 4,
};

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function variant(world: GtmWorld, apply: (draft: Mutable<GtmWorld>) => void): GtmWorld {
  const draft = structuredClone(world) as Mutable<GtmWorld>;
  apply(draft);
  return deepFreeze(draft) as GtmWorld;
}

/** D04: the meeting is canceled. The booking creation stays historical; only the active/net status changes. */
export const withCanceledEpisode = (w: GtmWorld, id: string, at = "2026-09-17T18:00:00+02:00"): GtmWorld =>
  variant(w, (d) => { d.episodes = d.episodes.map((e) => (e.meeting_episode_id === id ? { ...e, canceled_at: at } : e)); });

/** D04: the meeting happened. Whether it was a qualified discovery is a separate, pinned question. */
export const withHeldEpisode = (w: GtmWorld, id: string, at = "2026-09-22T10:30:00+02:00"): GtmWorld =>
  variant(w, (d) => { d.episodes = d.episodes.map((e) => (e.meeting_episode_id === id ? { ...e, held_at: at } : e)); });

/** D02/coverage: part of the window is not observed. Metrics over it are NOT_COMPUTABLE, never zero. */
export const withCoverageGap = (w: GtmWorld, coverage_key: string, state: "PARTIAL" | "REVOKED" = "PARTIAL"): GtmWorld =>
  variant(w, (d) => { d.coverage = d.coverage.map((c) => (c.coverage_key === coverage_key ? { ...c, state, gap_reason: "the fixture declares this window unobserved" } : c)); });

/** D02: the per-metric horizon/maturity rule was never pinned. */
export const withoutMetricHorizon = (w: GtmWorld, metric_key: string): GtmWorld =>
  variant(w, (d) => { d.metric_defs = d.metric_defs.map((m) => (m.metric_key === metric_key ? { ...m, observation_horizon_days: null, maturity_rule: null } : m)); });

/** Contract-pack candidate: the context exists as a symbol but is not registered for this runtime. */
export const withUnregisteredContext = (w: GtmWorld, runtime_key: string, context_resource_key: string): GtmWorld =>
  variant(w, (d) => {
    d.registered_context = d.registered_context.map((c) =>
      c.runtime_key === runtime_key && c.context_resource_key === context_resource_key
        ? { ...c, refs: [], registration_state: "NOT_REGISTERED" } : c);
  });

/** The runtime rotated: anything pinned to the previous generation is stale. */
export const withRotatedGeneration = (w: GtmWorld, runtime_key: string, generation = "gen-2"): GtmWorld =>
  variant(w, (d) => { d.runtimes = d.runtimes.map((r) => (r.runtime_key === runtime_key ? { ...r, runtime_generation: generation } : r)); });

/** A registered ref changed: pack identity must change with it. */
export const withExtraContextRef = (w: GtmWorld, runtime_key: string, context_resource_key: string, ref: string): GtmWorld =>
  variant(w, (d) => {
    d.registered_context = d.registered_context.map((c) =>
      c.runtime_key === runtime_key && c.context_resource_key === context_resource_key ? { ...c, refs: [...c.refs, ref] } : c);
  });

/**
 * Cross-runtime key collision: the second runtime lawfully mints ITS OWN `C01`, `OUT-C01`, `IN-C01-1`, `EP-M01`,
 * `EXP-C01` and `TRK-1`. Nothing here is a duplicate — a runtime-scoped key is minted by a runtime — so every
 * natural key must carry `runtime_key` and every runtime-scoped lookup must be given the runtime it reads.
 * Its `C01` is an INTERNAL counterpart, so the second runtime's weekly metric must NOT gain a replied prospect.
 */
export function withCollidingRuntimeKeys(w: GtmWorld): GtmWorld {
  const evidence = prov("EV-COLLISION");
  return variant(w, (d) => {
    d.companies = [...d.companies, { runtime_key: R_ALT, company_key: "CO-ALT-INTERNAL", classification: "INTERNAL", provenance: evidence }];
    d.contacts = [...d.contacts, {
      contact_key: "C01", runtime_key: R_ALT, company_key: "CO-ALT-INTERNAL", canonical_identity: mail("c01-alt-fixture"),
      party: "INTERNAL", identity_resolution: "CANONICAL", opted_out: false, address_stopped: false, takeover_required: false,
      provenance: evidence,
    }];
    d.messages = [...d.messages,
      { message_key: "OUT-C01", runtime_key: R_ALT, contact_key: "C01", direction: "OUTBOUND", provider_message_id: "PM-OUT-C01-ALT", occurred_at: "2026-09-14T11:00:00+02:00", kind: "HUMAN", intent: "OUTBOUND_APPROACH", campaign_key: "CMP-4", approach_version_key: AP_2_V1, participation_key: PART_R2_A2V1, exposure_key: "EXP-C01", in_reply_to: null, agreement_evidence: null, provenance: evidence },
      { message_key: "IN-C01-1", runtime_key: R_ALT, contact_key: "C01", direction: "INBOUND", provider_message_id: "PM-IN-C01-1-ALT", occurred_at: "2026-09-16T11:00:00+02:00", kind: "HUMAN", intent: "POSITIVE", campaign_key: null, approach_version_key: null, participation_key: null, exposure_key: null, in_reply_to: "OUT-C01", agreement_evidence: null, provenance: evidence },
    ];
    // Its own ACTIVE enrollment for its own C01: one ACTIVE enrollment PER RUNTIME per contact, never a global one.
    d.enrollments = [...d.enrollments, {
      enrollment_key: "ENR-CMP-4-C01", runtime_key: R_ALT, campaign_key: "CMP-4", contact_key: "C01", state: "ACTIVE",
      started_at: "2026-09-07T09:00:00+02:00", ended_at: null, provenance: evidence,
    }];
    d.exposures = [...d.exposures, {
      exposure_key: "EXP-C01", runtime_key: R_ALT, contact_key: "C01", message_key: "OUT-C01", campaign_key: "CMP-4",
      approach_version_key: AP_2_V1, communicated_offer: "OFFER-STD", communicated_price_cents: 120000, currency: "EUR",
      override_evidence: null, pinned_at: "2026-09-14T11:00:00+02:00", provenance: evidence,
    }];
    d.tracker_events = [...d.tracker_events, {
      tracker_event_key: "TRK-1", runtime_key: R_ALT, message_key: "OUT-C01", link_key: "LNK-ALT", event_type: "LINK_READ",
      occurred_at: "2026-09-16T11:30:00+02:00", reader_fingerprint: "RDR-ALT", provenance: evidence,
    }];
    d.episodes = [...d.episodes, {
      meeting_episode_id: "EP-M01", runtime_key: R_ALT, dataset: "O2", company_key: "CO-01", contact_keys: ["C01"],
      episode_kind: "PROSPECT", proposed_at: "2026-09-16T12:00:00+02:00", accepted_at: null, booked_at: null,
      held_at: null, qualified_at: null, canceled_at: null, agreement_evidence_ref: null, provenance: evidence,
    }];
    d.provider_events = [...d.provider_events, {
      provider_event_key: "EVT-M01-1", runtime_key: R_ALT, dataset: "O2", meeting_episode_id: "EP-M01", series_key: null,
      occurrence_index: null, reschedule_of: null, starts_at: "2026-09-18T12:00:00+02:00", ends_at: "2026-09-18T12:30:00+02:00",
      status: "TENTATIVE", title: "Fixture event", agenda_evidence: "NONE", participants: [], evidence_completeness: "COMPLETE",
      duplicate_of: null, thread_ref: null, provenance: evidence,
    }];
  });
}
