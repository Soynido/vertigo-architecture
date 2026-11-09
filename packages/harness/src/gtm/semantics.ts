/**
 * GTM SEMANTIC CORE — candidate (PV-GTM-002, W04/W05).
 *
 * The executable form of the semantics admitted in W02 and frozen as fixtures in W03: what a reply is, what makes
 * it attributable, which calendar week a fact belongs to, when a number may be stated at all, what a booked
 * meeting is, what an exposure proves, which totals are refused, and what identifies a measurement.
 *
 * PURE: no Notion, no clock, no store, no I/O, no business data of its own. It decides GRAMMAR, IDENTITY and
 * COMPUTABILITY, never truth: durable truth stays in Notion and the reading is performed by the native app.
 *
 * This module carries NO version literal of a governed family. It is reached only through a runtime whose
 * governing contract declares the `gtm` capability; on every other runtime it is unreachable and inert.
 */
import { createHash } from "node:crypto";

/** A number that may not be stated, and the reason it may not. Never rendered as zero. */
export type Computability = "COMPUTED" | "INCONCLUSIVE" | "NOT_COMPUTABLE";

export interface Verdict<T> {
  readonly state: Computability;
  readonly value: T | "NOT_COMPUTABLE" | "INCONCLUSIVE";
  readonly reason: string;
}

const computed = <T>(value: T): Verdict<T> => ({ state: "COMPUTED", value, reason: "NONE" });
const notComputable = <T>(reason: string): Verdict<T> => ({ state: "NOT_COMPUTABLE", value: "NOT_COMPUTABLE", reason });
const inconclusive = <T>(reason: string): Verdict<T> => ({ state: "INCONCLUSIVE", value: "INCONCLUSIVE", reason });

/* ────────────────────────────── redaction ────────────────────────────── */

/**
 * A business value never appears in an envelope, an evidence line, a warning or backend state. A value that must
 * be referred to at all is referred to by a stable, non-reversible token.
 */
export function redact(value: unknown): string {
  const raw = value === undefined || value === null ? "" : String(value).trim();
  if (raw === "") return "(empty)";
  return "ref:" + createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 8);
}

export const digestOf = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** Stable serialization for every identity digest: keys sorted, arrays in order, undefined dropped. */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    const body = Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonicalize(o[k])).join(",");
    return "{" + body + "}";
  }
  return "null";
}

/* ────────────────────────────── Europe/Paris calendar ────────────────────────────── */

export const ZONE = "Europe/Paris" as const;
const HOUR_MS = 3_600_000;

const PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: ZONE, hour12: false, weekday: "short",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

export interface ZonedParts {
  readonly year: number; readonly month: number; readonly day: number;
  readonly hour: number; readonly minute: number; readonly second: number; readonly weekday: string;
}

/** Civil time in Europe/Paris for an instant. The single place a local calendar field is derived. */
export function parisParts(instant: number): ZonedParts {
  const p = Object.fromEntries(PARTS.formatToParts(new Date(instant)).map((x) => [x.type, x.value]));
  const hour = Number(p["hour"]);
  return {
    year: Number(p["year"]), month: Number(p["month"]), day: Number(p["day"]),
    hour: hour === 24 ? 0 : hour, minute: Number(p["minute"]), second: Number(p["second"]),
    weekday: String(p["weekday"]),
  };
}

/** Offset of Europe/Paris at an instant, in ms. */
function parisOffset(instant: number): number {
  const p = parisParts(instant);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant;
}

/** The instant whose Europe/Paris civil time is exactly the given local date at 00:00:00. DST-correct. */
export function parisMidnight(year: number, month: number, day: number): number {
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0);
  const first = naive - parisOffset(naive);
  return naive - parisOffset(first);
}

/** Local civil-date arithmetic: add whole days to a Paris civil date, then take that date's local midnight. */
export function addParisDays(instant: number, days: number): number {
  const p = parisParts(instant);
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return parisMidnight(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

const pad2 = (n: number): string => (n < 10 ? "0" : "") + String(n);
const localClock = (p: ZonedParts): string => pad2(p.hour) + ":" + pad2(p.minute);

export const isIsoInstant = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));

export interface Period {
  readonly period_key: string;
  readonly start: string;
  readonly end: string;
  readonly timezone: typeof ZONE;
}

export interface WeekCheck { readonly ok: boolean; readonly reason: string; readonly duration_hours: number }

/**
 * A GTM event period is a HALF-OPEN EUROPE/PARIS CALENDAR WEEK: it opens at a Monday 00:00:00 local and closes at
 * the NEXT Monday 00:00:00 local. Its length is 168 hours except across a DST transition, where it is 167 or 169.
 * An arbitrary seven-day window is refused even when it lasts exactly 168 hours.
 */
export function validateParisWeek(startIso: string, endIso: string): WeekCheck {
  if (!isIsoInstant(startIso) || !isIsoInstant(endIso)) {
    return { ok: false, reason: "period bounds must be ISO instants carrying an explicit offset", duration_hours: 0 };
  }
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  const duration_hours = (end - start) / HOUR_MS;
  const p = parisParts(start);
  if (p.weekday !== "Mon" || p.hour !== 0 || p.minute !== 0 || p.second !== 0) {
    return { ok: false, reason: "a period opens at a Monday 00:00:00 " + ZONE + "; this one opens on " + p.weekday + " at " + localClock(p) + " local", duration_hours };
  }
  if (parisMidnight(p.year, p.month, p.day) !== start) {
    return { ok: false, reason: "the opening instant is not the local midnight of that Monday in " + ZONE, duration_hours };
  }
  const expectedEnd = addParisDays(start, 7);
  if (end !== expectedEnd) {
    const q = parisParts(end);
    return {
      ok: false,
      reason: "a period closes at the NEXT Monday 00:00:00 " + ZONE + " (" + new Date(expectedEnd).toISOString() + "); this one closes on " + q.weekday + " at " + localClock(q) + " local after " + String(duration_hours) + " hours",
      duration_hours,
    };
  }
  return { ok: true, reason: "NONE", duration_hours };
}

/** Maturity instant: the period end plus a whole number of CALENDAR days in Europe/Paris (DST-correct). */
export const maturityInstant = (periodEndIso: string, horizonDays: number): number =>
  addParisDays(Date.parse(periodEndIso), horizonDays);

/* ────────────────────────────── versioned metric definitions (D01, D02) ────────────────────────────── */

export type MetricClass = "EVENT_PERIOD" | "COHORT";
export type MetricUnit = "CONTACTS" | "MESSAGES" | "EPISODES" | "COMPANIES" | "READS" | "CONTACTS_PER_CONTACTS";
export const COVERAGE_SOURCES = ["MAILBOX", "MEETING_EVENTS", "TRACKER"] as const;
export type CoverageSource = (typeof COVERAGE_SOURCES)[number];
/** What a metric says about the world: a setting, an action performed, or an effect obtained. */
export const METRIC_LAYERS = ["CONFIGURATION", "EXECUTION", "EFFECTIVENESS"] as const;
export type MetricLayer = (typeof METRIC_LAYERS)[number];

export interface MetricDefinition {
  readonly metric_key: string;
  readonly metric_class: MetricClass;
  readonly layer: MetricLayer;
  readonly period_kind: "PARIS_CALENDAR_WEEK_HALF_OPEN";
  readonly timezone: typeof ZONE;
  /** Explicit per-metric horizon. `null` means the metric can never be stated (D02). */
  readonly observation_horizon_days: number | null;
  readonly maturity_rule: string | null;
  /** The PRODUCTION target. It is not set, and no fixture threshold may be presented as one (D01). */
  readonly production_target_state: "TARGET_NOT_SET";
  readonly unit: MetricUnit;
  readonly requires_coverage: readonly CoverageSource[];
}

const metric = (
  metric_key: string, metric_class: MetricClass, layer: MetricLayer, unit: MetricUnit,
  observation_horizon_days: number | null, maturity_rule: string | null, requires_coverage: readonly CoverageSource[],
): MetricDefinition => ({
  metric_key, metric_class, layer, period_kind: "PARIS_CALENDAR_WEEK_HALF_OPEN", timezone: ZONE,
  observation_horizon_days, maturity_rule, production_target_state: "TARGET_NOT_SET", unit, requires_coverage,
});

const EVENT_MATURITY = "OBSERVATION_CUTOFF_AT_OR_AFTER_PERIOD_END_PLUS_HORIZON_CALENDAR_DAYS";
const COHORT_MATURITY = "COHORT_MATURE_WHEN_CUTOFF_AT_OR_AFTER_ENTRY_END_PLUS_HORIZON_CALENDAR_DAYS";

/**
 * The COMPLETE candidate metric catalog. A deliberately tiny constant table: adding an entry is a documented spec
 * change plus tests, never a runtime decision. `qualified_discovery_meetings` is ABSENT on purpose — no pinned
 * definition exists, so a held meeting can never be called qualified (D04), and asking for it fails narrow.
 */
export const METRIC_CATALOG: readonly MetricDefinition[] = [
  metric("weekly_replied_prospects", "EVENT_PERIOD", "EFFECTIVENESS", "CONTACTS", 7, EVENT_MATURITY, ["MAILBOX"]),
  metric("eligible_human_reply_messages", "EVENT_PERIOD", "EFFECTIVENESS", "MESSAGES", 7, EVENT_MATURITY, ["MAILBOX"]),
  metric("weekly_entry_cohort_reply_rate", "COHORT", "EFFECTIVENESS", "CONTACTS_PER_CONTACTS", 7, COHORT_MATURITY, ["MAILBOX"]),
  metric("meeting_bookings", "EVENT_PERIOD", "EFFECTIVENESS", "EPISODES", 7, EVENT_MATURITY, ["MEETING_EVENTS"]),
  metric("replied_companies", "EVENT_PERIOD", "EFFECTIVENESS", "COMPANIES", 7, EVENT_MATURITY, ["MAILBOX"]),
  metric("distinct_link_reads", "EVENT_PERIOD", "EXECUTION", "READS", 7, EVENT_MATURITY, ["TRACKER"]),
  metric("outbound_messages_sent", "EVENT_PERIOD", "EXECUTION", "MESSAGES", 0, EVENT_MATURITY, ["MAILBOX"]),
];

export const metricDefinition = (key: string): MetricDefinition | undefined => METRIC_CATALOG.find((m) => m.metric_key === key);
export const METRIC_KEYS: readonly string[] = METRIC_CATALOG.map((m) => m.metric_key);

/**
 * The definition set is itself versioned: a human label plus a content digest. Every snapshot pins BOTH, so a
 * later edit of the catalog can never be mistaken for the definitions a historical number was computed under.
 */
export const METRIC_DEFINITIONS_VERSION = "gtm-metric-definitions/v1";
export const METRIC_DEFINITIONS_DIGEST = digestOf(canonicalize(METRIC_CATALOG)).slice(0, 16);
/** The shape of the projection itself, versioned so a reader can tell two projections apart. */
export const PROJECTION_VERSION = "gtm-analysis-projection/v1";
/** The identity scheme of snapshots and input revisions. */
export const SNAPSHOT_IDENTITY_VERSION = "gtm-snapshot-identity/v1";

/* ────────────────────────────── coverage ────────────────────────────── */

export const COVERAGE_STATES = ["COMPLETE", "PARTIAL", "REVOKED", "NOT_CONNECTED", "UNKNOWN"] as const;
export type CoverageState = (typeof COVERAGE_STATES)[number];

export interface CoverageDeclaration {
  readonly coverage_key: string;
  readonly source: CoverageSource;
  readonly since: string;
  readonly until: string;
  readonly state: CoverageState;
}

/** Worst state wins, whatever the row order. A revoked or unknown window can never be shadowed by a later row. */
const SEVERITY: Readonly<Record<CoverageState, number>> = { REVOKED: 5, UNKNOWN: 4, NOT_CONNECTED: 3, PARTIAL: 2, COMPLETE: 1 };

export interface CoverageVerdict {
  readonly ok: boolean;
  readonly state: CoverageState | "ABSENT";
  readonly reason: string;
  /** The rows considered, in deterministic order, by key. Never the rows' business content. */
  readonly considered: readonly string[];
}

/**
 * Coverage of ONE source over a period. Every declared row that overlaps the period is considered, in key order;
 * the most severe state decides. A period no row spans is ABSENT or PARTIAL, never COMPLETE.
 */
export function coverageVerdict(source: CoverageSource, period: Period, rows: readonly CoverageDeclaration[]): CoverageVerdict {
  const start = Date.parse(period.start);
  const end = Date.parse(period.end);
  const ordered = rows.filter((r) => r.source === source).slice().sort((a, b) => a.coverage_key.localeCompare(b.coverage_key));
  const overlapping = ordered.filter((r) => Date.parse(r.until) > start && Date.parse(r.since) < end);
  const considered = overlapping.map((r) => r.coverage_key);
  if (overlapping.length === 0) {
    return { ok: false, state: "ABSENT", reason: "no declared " + source + " coverage overlaps " + period.period_key, considered };
  }
  const worst = overlapping.reduce((acc, r) => (SEVERITY[r.state] > SEVERITY[acc.state] ? r : acc), overlapping[0] as CoverageDeclaration);
  if (worst.state !== "COMPLETE") {
    return { ok: false, state: worst.state, reason: source + " coverage over " + period.period_key + " is " + worst.state, considered };
  }
  const spanning = overlapping.some((r) => Date.parse(r.since) <= start && Date.parse(r.until) >= end);
  if (!spanning) {
    return { ok: false, state: "PARTIAL", reason: "declared " + source + " coverage does not span " + period.period_key, considered };
  }
  return { ok: true, state: "COMPLETE", reason: "NONE", considered };
}

/** The coverage digest a snapshot pins: identity of the coverage evidence, never its content. */
export const coverageDigest = (rows: readonly CoverageDeclaration[]): string =>
  digestOf(canonicalize(
    rows.slice().sort((a, b) => a.coverage_key.localeCompare(b.coverage_key))
      .map((r) => ({ k: r.coverage_key, s: r.source, from: r.since, to: r.until, st: r.state })),
  )).slice(0, 16);

/**
 * May this metric be stated for this period, at this observation instant, under these coverage declarations?
 * PRECEDENCE (frozen by the W03 oracle): pinned definition, then pinned horizon, then MATURITY, then coverage. An
 * immature period is INCONCLUSIVE even when its coverage is also missing: the earlier question decides.
 */
export function computability(metric_key: string, period: Period, observed_at: string, coverage: readonly CoverageDeclaration[]): Verdict<"STATEABLE"> {
  const def = metricDefinition(metric_key);
  if (def === undefined) return notComputable("no pinned definition for " + metric_key);
  if (def.observation_horizon_days === null || def.maturity_rule === null) {
    return notComputable(metric_key + " has no pinned observation horizon or maturity rule");
  }
  if (!isIsoInstant(observed_at)) return notComputable("the observation cutoff must be an ISO instant carrying an explicit offset");
  const week = validateParisWeek(period.start, period.end);
  if (!week.ok) return notComputable(week.reason);
  const mature = maturityInstant(period.end, def.observation_horizon_days);
  if (Date.parse(observed_at) < mature) {
    return inconclusive(metric_key + " over " + period.period_key + " is not mature before " + new Date(mature).toISOString());
  }
  for (const source of def.requires_coverage) {
    const verdict = coverageVerdict(source, period, coverage);
    if (!verdict.ok) return notComputable(verdict.reason);
  }
  return computed("STATEABLE");
}

/* ────────────────────────────── snapshot and input-revision identity (W04) ────────────────────────────── */

export const INPUT_REVISION_REASONS = ["INITIAL", "BACKFILL", "RECLASSIFICATION"] as const;
export type InputRevisionReason = (typeof INPUT_REVISION_REASONS)[number];

export interface InputRevisionBasis {
  readonly runtime_id: string;
  /** Symbolic refs of the durable resources the revision was built from. Never their content. */
  readonly basis_refs: readonly string[];
  readonly reason: InputRevisionReason;
  /** The revision this one supersedes, when it is not the first. */
  readonly supersedes: string | null;
  readonly basis_digest: string;
}

/** Deterministic: the same basis always yields the same revision id; any change yields another one. */
export function inputRevisionId(basis: InputRevisionBasis): string {
  const body = canonicalize({
    v: SNAPSHOT_IDENTITY_VERSION, runtime: basis.runtime_id, refs: [...basis.basis_refs].sort(),
    reason: basis.reason, supersedes: basis.supersedes, basis: basis.basis_digest,
  });
  return "IR-" + digestOf(body).slice(0, 16);
}

export interface SnapshotIdentity {
  readonly metric_definitions_version: string;
  readonly metric_definitions_digest: string;
  readonly input_revision_id: string;
  readonly metric_key: string;
  readonly scope: string;
  readonly period_key: string;
  readonly period_start: string;
  readonly period_end: string;
  readonly observation_cutoff: string;
  readonly coverage_digest: string;
}

/**
 * The logical identity of a measurement. Same definitions + same input revision + same metric/scope/period/cutoff/
 * coverage yields the same snapshot key. A backfill changes the input revision, so it produces a NEW snapshot
 * beside the old one; a historical fact is never overwritten.
 */
export function snapshotKey(id: SnapshotIdentity): string {
  return "SNAP-" + digestOf(canonicalize({ v: SNAPSHOT_IDENTITY_VERSION, id })).slice(0, 20);
}

/* ────────────────────────────── reply disposition (D01) ────────────────────────────── */

export const REPLY_KINDS = ["HUMAN", "TECHNICAL", "UNKNOWN"] as const;
export type ReplyKind = (typeof REPLY_KINDS)[number];
export const REPLY_INTENTS = ["POSITIVE", "QUESTION", "OBJECTION", "NEGATIVE", "OPT_OUT", "OUT_OF_OFFICE", "BOUNCE_PERMANENT", "UNDETERMINED"] as const;
export type ReplyIntent = (typeof REPLY_INTENTS)[number];
export const PARTIES = ["EXTERNAL_PROSPECT", "INTERNAL"] as const;
export type Party = (typeof PARTIES)[number];
export const ATTRIBUTION_STATUSES = ["ATTRIBUTED", "UNATTRIBUTED", "UNKNOWN"] as const;
export type AttributionStatus = (typeof ATTRIBUTION_STATUSES)[number];
export const IDENTITY_RESOLUTIONS = ["CANONICAL", "UNRESOLVED"] as const;
export type IdentityResolution = (typeof IDENTITY_RESOLUTIONS)[number];

export const REPLY_DISPOSITIONS = [
  "ELIGIBLE_HUMAN_REPLY", "DUPLICATE_DELIVERY", "INTERNAL_COUNTERPART", "TECHNICAL_AUTOREPLY",
  "PERMANENT_BOUNCE", "OPT_OUT", "UNKNOWN_KIND_TAKEOVER", "NOT_ATTRIBUTED",
] as const;
export type ReplyDisposition = (typeof REPLY_DISPOSITIONS)[number];
export type FollowUp = "NONE" | "HUMAN_TAKEOVER" | "STOP_ADDRESS" | "SUPPRESS_CONTACT";

export interface ReplyEvidence {
  readonly kind: ReplyKind;
  readonly intent: ReplyIntent;
  readonly party: Party;
  readonly attribution: AttributionStatus;
  readonly duplicate_delivery?: boolean;
}

export interface DispositionView {
  readonly disposition: ReplyDisposition;
  readonly counts_as_reply: boolean;
  readonly follow_up: FollowUp;
  /** Safety consequences come before measurement: a takeover or a stop is never deferred to a later pass. */
  readonly safety_priority: boolean;
  readonly reason: string;
}

/**
 * One reply, one disposition. Only an attributed, external, human, non-opt-out reply counts; everything else
 * counts zero and states why. The order of the tests is part of the semantics.
 */
export function dispositionOf(e: ReplyEvidence): DispositionView {
  const view = (disposition: ReplyDisposition, counts_as_reply: boolean, follow_up: FollowUp, reason: string): DispositionView =>
    ({ disposition, counts_as_reply, follow_up, safety_priority: follow_up !== "NONE", reason });
  if (e.duplicate_delivery === true) return view("DUPLICATE_DELIVERY", false, "NONE", "another delivery of the same provider message was already counted");
  if (e.party === "INTERNAL") return view("INTERNAL_COUNTERPART", false, "NONE", "an internal counterpart is never an external prospect");
  if (e.intent === "BOUNCE_PERMANENT") return view("PERMANENT_BOUNCE", false, "STOP_ADDRESS", "a permanent bounce is a delivery failure, not a reply");
  if (e.kind === "TECHNICAL") return view("TECHNICAL_AUTOREPLY", false, "NONE", "a technical auto-reply carries no human intent");
  if (e.intent === "OPT_OUT") return view("OPT_OUT", false, "SUPPRESS_CONTACT", "an opt-out is a human reply but never a success");
  if (e.kind === "UNKNOWN" || e.intent === "UNDETERMINED") return view("UNKNOWN_KIND_TAKEOVER", false, "HUMAN_TAKEOVER", "the nature of the inbound is undetermined; a human decides");
  if (e.attribution !== "ATTRIBUTED") return view("NOT_ATTRIBUTED", false, "NONE", "a reply that cannot be attributed with proof is never credited to a campaign");
  return view("ELIGIBLE_HUMAN_REPLY", true, "NONE", "attributed human reply of an external prospect");
}

/* ────────────────────────────── proof-first attribution (D03) ────────────────────────────── */

export interface TouchCandidate {
  readonly message_ref: string;
  readonly campaign_key: string | null;
  readonly approach_version_key: string | null;
  readonly participation_key: string | null;
  readonly occurred_at: string;
  /** True only when the touch was found in the runtime's own durable state. A declared touch is never proof. */
  readonly durably_proven: boolean;
}

export interface AttributionEvidence {
  readonly identity_resolution: IdentityResolution;
  readonly reply_at: string;
  readonly prior_touches: readonly TouchCandidate[];
  readonly in_reply_to?: string | undefined;
}

export interface AttributionGroup {
  readonly campaign_key: string | null;
  readonly approach_version_key: string | null;
  readonly participation_key: string | null;
}

export interface AttributionVerdict {
  readonly status: AttributionStatus;
  /** A single proven message, ONLY when threading resolves to one. Never the most recent touch. */
  readonly attributed_to: TouchCandidate | null;
  /** The proven group, when every candidate belongs to one. Attribution is then to the group, not to a message. */
  readonly attributed_group: AttributionGroup | null;
  readonly candidates: readonly TouchCandidate[];
  readonly reason: string;
}

/** Bounded lookback: a touch older than this never becomes a candidate. */
export const ATTRIBUTION_LOOKBACK_DAYS = 30;

const hasProof = (c: TouchCandidate): boolean =>
  c.durably_proven && c.campaign_key !== null && c.approach_version_key !== null && c.participation_key !== null;
const groupOf = (c: TouchCandidate): AttributionGroup =>
  ({ campaign_key: c.campaign_key, approach_version_key: c.approach_version_key, participation_key: c.participation_key });

/**
 * Attribution requires proof. Rules, in order:
 *  1. an unresolved identity, or an unusable reply instant, is UNKNOWN;
 *  2. no durably proven prior touch inside the bounded lookback is UNKNOWN;
 *  3. a threading reference that resolves to a durably proven candidate attributes the reply to THAT message;
 *  4. a threading reference that resolves to nothing proven is UNATTRIBUTED — it never falls through to another touch;
 *  5. otherwise, if every candidate is durably proven and they share one campaign/approach/participation group, the
 *     reply is attributed to the GROUP; no message is promoted, and never the most recent one;
 *  6. anything else is UNATTRIBUTED with every candidate preserved.
 */
export function attributionVerdict(e: AttributionEvidence): AttributionVerdict {
  const none = (status: AttributionStatus, reason: string, candidates: readonly TouchCandidate[] = []): AttributionVerdict =>
    ({ status, attributed_to: null, attributed_group: null, candidates, reason });
  if (e.identity_resolution !== "CANONICAL") return none("UNKNOWN", "the replying identity does not resolve to a canonical contact");
  if (!isIsoInstant(e.reply_at)) return none("UNKNOWN", "the reply instant is not an ISO instant carrying an explicit offset");
  const since = addParisDays(Date.parse(e.reply_at), -ATTRIBUTION_LOOKBACK_DAYS);
  const candidates = e.prior_touches
    .filter((t) => isIsoInstant(t.occurred_at) && Date.parse(t.occurred_at) < Date.parse(e.reply_at) && Date.parse(t.occurred_at) >= since)
    .slice()
    .sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at) || a.message_ref.localeCompare(b.message_ref));
  if (candidates.length === 0) return none("UNKNOWN", "no durably proven prior outbound of this runtime reaches this contact inside the attribution lookback");

  const threadRef = (e.in_reply_to ?? "").trim();
  if (threadRef !== "") {
    const threaded = candidates.find((c) => c.message_ref === threadRef);
    if (threaded === undefined || !hasProof(threaded)) {
      return none("UNATTRIBUTED", "the reply threads onto a message that is not a durably proven touch of this runtime; no other touch takes its place", candidates);
    }
    return {
      status: "ATTRIBUTED", attributed_to: threaded, attributed_group: groupOf(threaded), candidates,
      reason: "the reply threads onto one durably proven touch carrying campaign, approach and participation evidence",
    };
  }

  const groups = new Set(candidates.filter(hasProof).map((c) => canonicalize(groupOf(c))));
  if (candidates.every(hasProof) && groups.size === 1) {
    return {
      status: "ATTRIBUTED", attributed_to: null, attributed_group: groupOf(candidates[0] as TouchCandidate), candidates,
      reason: "every durably proven candidate belongs to one campaign/approach/participation group; the reply is attributed to that group, not to a message",
    };
  }
  return none("UNATTRIBUTED", "several plausible candidates and no decisive evidence; the most recent touch is never promoted", candidates);
}

/* ────────────────────────────── meetings (D04) ────────────────────────────── */

export const MEETING_STATUS_LADDER = ["PROPOSED", "ACCEPTED", "BOOKED", "HELD", "QUALIFIED_DISCOVERY"] as const;
export type MeetingStatus = (typeof MEETING_STATUS_LADDER)[number];
export const EPISODE_KINDS = ["PROSPECT", "INTERNAL"] as const;
export type EpisodeKind = (typeof EPISODE_KINDS)[number];

export interface EpisodeEvidence {
  readonly meeting_episode_id: string;
  readonly proposed_at: string | null;
  readonly accepted_at: string | null;
  readonly agreement_evidence_ref: string | null;
  readonly booked_at: string | null;
  readonly held_at: string | null;
  readonly held_evidence_ref: string | null;
  readonly qualified_at: string | null;
  readonly canceled_at: string | null;
  readonly episode_kind: EpisodeKind;
}

/** The rungs an episode has actually reached. BOOKED requires an explicit, evidenced agreement. */
export function episodeStatuses(e: EpisodeEvidence): readonly MeetingStatus[] {
  const reached: MeetingStatus[] = [];
  if (e.proposed_at !== null) reached.push("PROPOSED");
  if (e.accepted_at !== null && e.agreement_evidence_ref !== null) reached.push("ACCEPTED");
  if (e.booked_at !== null && e.accepted_at !== null && e.agreement_evidence_ref !== null) reached.push("BOOKED");
  if (e.held_at !== null && e.held_evidence_ref !== null) reached.push("HELD");
  if (e.qualified_at !== null) reached.push("QUALIFIED_DISCOVERY");
  return reached;
}

export interface MeetingCounters {
  /** Booking creations are historical facts: a later cancellation never removes one. */
  readonly historical_bookings: number;
  readonly active_bookings: number;
  readonly held: number;
  /** Always NOT_COMPUTABLE once a meeting was held: no qualified-discovery definition is pinned (D04). */
  readonly qualified: 0 | "NOT_COMPUTABLE";
  readonly qualified_reason: string;
  readonly counted_episodes: readonly string[];
  /** A meeting is never revenue: no episode state creates a won deal or an amount. */
  readonly revenue: "NOT_APPLICABLE";
}

/** Counts prospect episodes of ONE runtime. Internal blocks are never prospect meetings. */
export function meetingCounters(episodes: readonly EpisodeEvidence[]): MeetingCounters {
  const prospect = episodes.filter((e) => e.episode_kind === "PROSPECT");
  const booked = prospect.filter((e) => episodeStatuses(e).includes("BOOKED"));
  const held = prospect.filter((e) => episodeStatuses(e).includes("HELD"));
  return {
    historical_bookings: booked.length,
    active_bookings: booked.filter((e) => e.canceled_at === null).length,
    held: held.length,
    qualified: held.length === 0 ? 0 : "NOT_COMPUTABLE",
    qualified_reason: held.length === 0
      ? "no meeting was held, so no meeting can be qualified"
      : "a meeting was held but no pinned qualified-discovery definition exists; the question is NOT_COMPUTABLE",
    counted_episodes: booked.map((e) => e.meeting_episode_id).sort(),
    revenue: "NOT_APPLICABLE",
  };
}

/* ────────────────────────────── exposure (D05) ────────────────────────────── */

export interface ExposureEvidence {
  readonly configured_offer: string;
  readonly configured_price: string;
  readonly communicated_offer: string;
  readonly communicated_price: string;
  readonly price_communicated: boolean;
  readonly currency: string;
  readonly price_unit: string;
  readonly price_scope: string;
  readonly override_evidence: string | null;
  readonly link_sent: boolean;
  readonly link_read_evidence: string | null;
}

export interface ExposureView {
  readonly differs_from_configuration: boolean;
  readonly override_evidence_required: boolean;
  readonly override_evidence_present: boolean;
  /** A price may only be a cause when it was actually communicated with its amount, currency, unit and scope. */
  readonly price_is_a_possible_cause: boolean;
  readonly link_read_proven: boolean;
  /** Redacted, symbolic violation sentences: no offer, price or contact value ever appears here. */
  readonly violations: readonly string[];
}

/** Configuration is not exposure: only a pinned exposure says what was actually communicated. */
export function exposureView(e: ExposureEvidence): ExposureView {
  // A price is only compared with the configuration when a price was actually communicated: saying nothing about
  // price is not an override, it is simply not a price cause.
  const differs = e.configured_offer !== e.communicated_offer || (e.price_communicated && e.configured_price !== e.communicated_price);
  const overridePresent = e.override_evidence !== null && e.override_evidence.trim() !== "";
  const violations: string[] = [];
  if (differs && !overridePresent) violations.push("what was communicated differs from what the campaign configures; the override must pin its evidence");
  if (e.price_communicated && (e.communicated_price.trim() === "" || e.currency.trim() === "" || e.price_unit.trim() === "" || e.price_scope.trim() === "")) {
    violations.push("a communicated price states its amount, its currency, its unit and its scope");
  }
  if (!e.price_communicated && e.communicated_price.trim() !== "") {
    violations.push("a price that was not communicated is internal configuration; it may never be pinned as communicated");
  }
  if (!e.link_sent && e.link_read_evidence !== null && e.link_read_evidence.trim() !== "") {
    violations.push("a link that was never sent cannot carry read evidence");
  }
  return {
    differs_from_configuration: differs,
    override_evidence_required: differs,
    override_evidence_present: overridePresent,
    price_is_a_possible_cause: e.price_communicated && e.communicated_price.trim() !== "" && e.currency.trim() !== "",
    link_read_proven: e.link_read_evidence !== null && e.link_read_evidence.trim() !== "",
    violations,
  };
}

/* ────────────────────────────── aggregation (D06) ────────────────────────────── */

export interface RuntimeAggregate { readonly runtime_key: string; readonly companies: readonly string[]; readonly contacts: number }

export interface GlobalTotalVerdict extends Verdict<number> {
  readonly overlapping_companies: readonly string[];
  readonly per_runtime: Readonly<Record<string, number>>;
  readonly disposition: "COMPUTED" | "HOLD";
}

/**
 * A company-global, overlap-sensitive total across runtimes needs a Shared Reality topology the pilot does not
 * have. Per-runtime figures stay available; only the cross-runtime total is withheld, and the overlap is named by
 * redacted token, never by company key.
 */
export function companyGlobalTotal(per: readonly RuntimeAggregate[], topology: "ABSENT" | "DECLARED"): GlobalTotalVerdict {
  const counts = new Map<string, number>();
  for (const r of per) for (const c of new Set(r.companies)) counts.set(c, (counts.get(c) ?? 0) + 1);
  const overlapping = [...counts.entries()].filter(([, n]) => n > 1).map(([c]) => redact(c)).sort();
  const per_runtime = Object.fromEntries(per.map((r) => [r.runtime_key, new Set(r.companies).size]));
  if (topology === "DECLARED") return { ...computed(counts.size), overlapping_companies: overlapping, per_runtime, disposition: "COMPUTED" };
  return {
    ...notComputable<number>("an overlap-sensitive company-global total needs a Shared Reality topology; the pilot declares none, so runtimes are never deduplicated"),
    overlapping_companies: overlapping, per_runtime, disposition: "HOLD",
  };
}

/** Units must match. A numerator of one unit over a denominator of another is refused, never rounded into a rate. */
export function rateOf(numerator: { value: number; unit: string }, denominator: { value: number; unit: string }): Verdict<string> {
  if (numerator.unit !== denominator.unit) return notComputable("heterogeneous denominator: " + numerator.unit + " over " + denominator.unit);
  if (denominator.value === 0) return notComputable("empty denominator");
  return computed(String(numerator.value) + "/" + String(denominator.value));
}

/* ────────────────────────────── learning views (W04) ────────────────────────────── */

export interface ParticipationView {
  readonly participation_key: string;
  readonly approach_version_key: string;
  readonly approach_key: string;
  readonly owner_rep: string;
  readonly runtime_id: string;
}

export interface ApproachViews {
  /** One row per approach VERSION: two versions of one rep stay separable. */
  readonly by_version: readonly { readonly approach_version_key: string; readonly participations: readonly string[]; readonly owners: readonly string[] }[];
  /** One row per approach: two reps running it are grouped while owner and runtime stay on each participation. */
  readonly by_approach: readonly {
    readonly approach_key: string;
    readonly versions: readonly string[];
    readonly participations: readonly { readonly participation_key: string; readonly owner_rep: string; readonly runtime_id: string }[];
  }[];
}

export function approachViews(participations: readonly ParticipationView[]): ApproachViews {
  const versions = new Map<string, ParticipationView[]>();
  const approaches = new Map<string, ParticipationView[]>();
  for (const p of participations) {
    versions.set(p.approach_version_key, [...(versions.get(p.approach_version_key) ?? []), p]);
    approaches.set(p.approach_key, [...(approaches.get(p.approach_key) ?? []), p]);
  }
  return {
    by_version: [...versions.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([approach_version_key, rows]) => ({
      approach_version_key,
      participations: rows.map((r) => r.participation_key).sort(),
      owners: [...new Set(rows.map((r) => r.owner_rep))].sort(),
    })),
    by_approach: [...approaches.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([approach_key, rows]) => ({
      approach_key,
      versions: [...new Set(rows.map((r) => r.approach_version_key))].sort(),
      participations: rows.map((r) => ({ participation_key: r.participation_key, owner_rep: r.owner_rep, runtime_id: r.runtime_id }))
        .sort((a, b) => a.participation_key.localeCompare(b.participation_key)),
    })),
  };
}

export interface ComparisonArm {
  readonly arm_key: string;
  readonly replies: number;
  readonly positive_replies: number;
  readonly bookings: number;
  readonly messages_sent: number;
  readonly confounds: readonly string[];
}

export interface ComparisonResult {
  readonly per_criterion: readonly { readonly criterion: string; readonly leader: string; readonly values: Readonly<Record<string, number>> }[];
  /** A single winner is never declared: criteria disagree and the sample is bounded. */
  readonly global_winner: "NOT_DECIDABLE";
  readonly reason: string;
  readonly confounds: readonly string[];
  readonly replication_proposal: string;
  readonly sample_sufficient: boolean;
  /** Volume of activity is never a ranking of people. */
  readonly ranks_people: false;
}

/** The minimum per-arm sample below which no arm may be called better on any criterion. */
export const MIN_ARM_SAMPLE = 30;

export function compareApproaches(arms: readonly ComparisonArm[]): ComparisonResult {
  const criterion = (name: string, pick: (a: ComparisonArm) => number) => {
    const values = Object.fromEntries(arms.map((a) => [a.arm_key, pick(a)]));
    const best = Math.max(...arms.map(pick));
    const leaders = arms.filter((a) => pick(a) === best).map((a) => a.arm_key);
    return { criterion: name, leader: leaders.length === 1 ? (leaders[0] as string) : "TIE", values };
  };
  return {
    per_criterion: [
      criterion("replies", (a) => a.replies),
      criterion("positive_replies", (a) => a.positive_replies),
      criterion("bookings", (a) => a.bookings),
    ],
    global_winner: "NOT_DECIDABLE",
    reason: "the criteria do not agree and no pinned objective ranks them; a single winner would be an invention",
    confounds: [...new Set(arms.flatMap((a) => a.confounds))].sort(),
    replication_proposal: "replicate on a comparable, pre-declared sample before treating any arm as better",
    sample_sufficient: arms.every((a) => a.messages_sent >= MIN_ARM_SAMPLE),
    ranks_people: false,
  };
}

/* ────────────────────────────── publication filtering (W04) ────────────────────────────── */

export interface DiagnosticItem {
  readonly item_key: string;
  readonly owner_rep: string;
  readonly visibility: "PRIVATE_REP" | "SHARED";
}

export interface PublicationDecision {
  readonly published: readonly string[];
  readonly excluded: readonly { readonly item_key: string; readonly reason: string }[];
  readonly boundary: "SAFE_SHARED_ONLY";
}

/**
 * A recipient package never carries another rep's private diagnostics. Only shared items, or the recipient's own
 * private items, cross the boundary; everything else is excluded with its reason.
 */
export function filterPublication(items: readonly DiagnosticItem[], recipient_rep: string): PublicationDecision {
  const published: string[] = [];
  const excluded: { item_key: string; reason: string }[] = [];
  for (const item of items.slice().sort((a, b) => a.item_key.localeCompare(b.item_key))) {
    if (item.visibility === "SHARED" || item.owner_rep === recipient_rep) published.push(item.item_key);
    else excluded.push({ item_key: item.item_key, reason: "private diagnostic of another rep; it never crosses into a recipient package" });
  }
  return { published, excluded, boundary: "SAFE_SHARED_ONLY" };
}

/* ────────────────────────────── enum validation ────────────────────────────── */

export const oneOf = <T extends string>(allowed: readonly T[], value: string): value is T => (allowed as readonly string[]).includes(value);
