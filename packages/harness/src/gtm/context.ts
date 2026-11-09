/**
 * GTM READ CONTEXT AND META PROJECTIONS — candidate (PV-GTM-002, W04/W05).
 *
 * Two read-only products, both computed from what the bound runtime itself declares:
 *  - the SALES GTM context: the exact GTM containers of the BOUND runtime the native app should read. The harness
 *    discovers containers, never rows: no campaign, contact, price or reply ever enters the backend.
 *  - the META measurement/learning projection: versioned metric definitions with their explicit horizons and their
 *    unset production target, the index-versus-source freshness verdict, the rules a reader must apply and the
 *    publication policy. It states no number: numbers live in a runtime, under their own coverage and horizon.
 *
 * CAPABILITY IS EXPLICIT. SALES: the governing contract adapter declares it. META: the runtime registers a GTM
 * measurement resource AND that registration pins the candidate Contract Pack version. A bare registry row never
 * adopts the candidate policy, and no hint, argument or package flag can switch it on.
 */
import { CANDIDATE_POLICY_VERSION } from "../contractPack/catalog.ts";
import type { NotionReadClient } from "../notion/readClient.ts";
import { discoverDataSource } from "../plans/resources.ts";
import type { ResolvedRuntime } from "../resolvers/types.ts";
import type { Lane } from "../tools/envelope.ts";
import { GTM_RESOURCE_KEYS } from "../versions/adapters/controlPlane.ts";
import {
  ATTRIBUTION_LOOKBACK_DAYS, MEETING_STATUS_LADDER, METRIC_CATALOG, METRIC_DEFINITIONS_DIGEST,
  METRIC_DEFINITIONS_VERSION, MIN_ARM_SAMPLE, PROJECTION_VERSION, SNAPSHOT_IDENTITY_VERSION, ZONE,
} from "./semantics.ts";

/** A registered-resource row as the resume state exposes it. */
export interface RegisteredRow {
  readonly ref: string;
  readonly status?: unknown;
  readonly schema_version?: unknown;
  readonly last_verified?: unknown;
  readonly notes?: unknown;
}
export type RegisteredState = RegisteredRow | "NOT_FOUND" | "NOT_APPLICABLE" | undefined;

const rowOf = (state: RegisteredState): RegisteredRow | undefined =>
  state !== undefined && state !== "NOT_FOUND" && state !== "NOT_APPLICABLE" ? state : undefined;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export interface GtmCapability {
  readonly enabled: boolean;
  /** What decided it: the governing contract adapter (SALES) or an explicitly pinned registration (META). */
  readonly source: "GOVERNING_CONTRACT_ADAPTER" | "PINNED_META_REGISTRATION" | "NONE";
  readonly reason: string;
  /** Present when a registration exists but does not pin the candidate policy: reported, never acted upon. */
  readonly unpinned_registration?: boolean;
}

const OFF = (reason: string, unpinned = false): GtmCapability =>
  ({ enabled: false, source: "NONE", reason, ...(unpinned ? { unpinned_registration: true } : {}) });

/**
 * Is this binding GTM-capable? Decided by the runtime, never by the caller. On META the registration must pin the
 * candidate Contract Pack version explicitly: registering a resource is not adopting a policy.
 */
export function gtmCapability(lane: Lane, runtime: ResolvedRuntime, registration: RegisteredState): GtmCapability {
  if (lane === "SALES") {
    return runtime.adapter.capabilities?.gtm === true
      ? { enabled: true, source: "GOVERNING_CONTRACT_ADAPTER", reason: "the governing Sales contract of this runtime declares GTM semantics" }
      : OFF("the governing Sales contract of this runtime declares no GTM semantics");
  }
  const row = rowOf(registration);
  if (row === undefined) return OFF("this runtime registers no GTM measurement resource");
  if (str(row.schema_version) !== CANDIDATE_POLICY_VERSION) {
    return OFF("this runtime registers a GTM measurement resource but its registration does not pin the candidate policy version; a registry row never adopts a policy", true);
  }
  if (str(row.status) !== "RESOLVED") {
    return OFF("the registered GTM measurement resource is not RESOLVED; nothing is read from an unresolved registration", true);
  }
  return { enabled: true, source: "PINNED_META_REGISTRATION", reason: "this runtime registers a GTM measurement resource pinned to the candidate policy version" };
}

/* ────────────────────────────── SALES: where to read ────────────────────────────── */

export interface GtmContainer {
  readonly resource_key: string;
  readonly database_title: string;
  readonly ref: string | "NOT_FOUND";
}

/** Capability evidence is control-plane state surfaced by os_resume, never a business-context pointer. */
const GTM_CONTEXT_RESOURCE_KEYS = GTM_RESOURCE_KEYS.filter((key) => key !== "SALES:CAPABILITY_PROOFS");

/**
 * Discovers the GTM containers of the bound runtime. Container refs only: rows are read by the native app under
 * the user's own Notion permissions, so no business value crosses the backend.
 */
export async function discoverGtmContainers(client: NotionReadClient, runtime: ResolvedRuntime): Promise<readonly GtmContainer[]> {
  const catalog = runtime.adapter.controlPlane.resources ?? {};
  const out: GtmContainer[] = [];
  for (const key of GTM_CONTEXT_RESOURCE_KEYS) {
    const spec = catalog[key];
    if (!spec) continue;
    let ref: string | "NOT_FOUND" = "NOT_FOUND";
    try {
      const disc = await discoverDataSource(client, runtime, spec);
      if (disc.ok) ref = disc.ds;
    } catch {
      ref = "NOT_FOUND";
    }
    out.push({ resource_key: key, database_title: spec.databaseTitle, ref });
  }
  return out;
}

/* ────────────────────────────── META: index versus source ────────────────────────────── */

export type Divergence = "ALIGNED" | "INDEX_STALE" | "SOURCE_INACCESSIBLE" | "INDEX_ABSENT";

export interface FreshnessVerdict {
  readonly divergence: Divergence;
  readonly conclusion: "USE_SOURCE" | "UNKNOWN";
  /** A divergence is attributed, never resolved by averaging two disagreeing readings. */
  readonly attributed_to: "META_INDEX" | "NOT_APPLICABLE";
  readonly index_last_verified: string;
  readonly source_last_verified: string;
  readonly rule: string;
  /** No side is ever silently corrected and no consensus is invented. */
  readonly corrected: false;
}

/**
 * Compares the registered META index with the source it indexes. A stale index is named as stale and the source is
 * read fresh; an inaccessible source is UNKNOWN — never a fabricated correction, never a merged consensus.
 */
export function indexFreshness(index: RegisteredState, source: RegisteredState): FreshnessVerdict {
  const indexRow = rowOf(index);
  const sourceRow = rowOf(source);
  const base = {
    index_last_verified: str(indexRow?.last_verified) === "" ? "UNKNOWN" : str(indexRow?.last_verified),
    source_last_verified: str(sourceRow?.last_verified) === "" ? "UNKNOWN" : str(sourceRow?.last_verified),
    corrected: false as const,
  };
  if (sourceRow === undefined) {
    return { ...base, divergence: "SOURCE_INACCESSIBLE", conclusion: "UNKNOWN", attributed_to: "NOT_APPLICABLE", rule: "the source cannot be read; nothing is concluded, nothing is corrected and no consensus is invented" };
  }
  if (indexRow === undefined) {
    return { ...base, divergence: "INDEX_ABSENT", conclusion: "USE_SOURCE", attributed_to: "NOT_APPLICABLE", rule: "no index exists; the source is read fresh" };
  }
  const indexAt = Date.parse(base.index_last_verified);
  const sourceAt = Date.parse(base.source_last_verified);
  if (!Number.isFinite(indexAt) || !Number.isFinite(sourceAt)) {
    return { ...base, divergence: "SOURCE_INACCESSIBLE", conclusion: "UNKNOWN", attributed_to: "NOT_APPLICABLE", rule: "freshness cannot be compared without both verification instants; nothing is concluded" };
  }
  if (indexAt < sourceAt) {
    return { ...base, divergence: "INDEX_STALE", conclusion: "USE_SOURCE", attributed_to: "META_INDEX", rule: "the index is older than the source it indexes; the source is read fresh and the divergence is attributed to the index" };
  }
  return { ...base, divergence: "ALIGNED", conclusion: "USE_SOURCE", attributed_to: "NOT_APPLICABLE", rule: "index and source agree on freshness; the source is still the thing read" };
}

/* ────────────────────────────── META: what may be measured, and how ────────────────────────────── */

export interface MetricProjection {
  readonly metric_key: string;
  readonly metric_class: string;
  readonly layer: string;
  readonly period_kind: string;
  readonly timezone: string;
  readonly observation_horizon_days: number | null;
  readonly maturity_rule: string | null;
  readonly production_target_state: "TARGET_NOT_SET";
  readonly unit: string;
  readonly requires_coverage: readonly string[];
  /** A definition is a definition: it is never published as an observed result. */
  readonly publication: "NOT_PUBLISHED_DEFINITION_ONLY";
}

export interface GtmAnalysisProjection {
  readonly projection_version: string;
  readonly metric_definitions_version: string;
  readonly metric_definitions_digest: string;
  readonly snapshot_identity_version: string;
  readonly registered_resource: { readonly ref: string | "NOT_FOUND"; readonly status: string; readonly pinned_policy: string };
  readonly freshness: FreshnessVerdict;
  readonly metrics: readonly MetricProjection[];
  /** Rules a reader must apply. Stated here so the reading is governed and not re-invented per chat. */
  readonly measurement_rules: readonly string[];
  readonly learning_rules: readonly string[];
  readonly publication_policy: {
    readonly default: "NOT_PUBLISHED_WITHOUT_EXPLICIT_APPROVAL";
    readonly private_rep_diagnostics: "NEVER_CROSS_REP";
    readonly hypothetical_fields: "NEVER_PUBLISHED";
    readonly layers_separated: readonly string[];
  };
  /** The projection never carries a number: no value is computable from META alone. */
  readonly values: "NOT_COMPUTABLE_FROM_META";
  readonly values_reason: string;
}

const MEASUREMENT_RULES: readonly string[] = [
  "an event period is a half-open Europe/Paris CALENDAR week: it opens at a Monday 00:00:00 local and closes at the next Monday 00:00:00 local, so a week lasts 167, 168 or 169 hours across a daylight-saving transition",
  "an arbitrary seven-day window is not a period, even when it lasts exactly 168 hours",
  "each metric carries its own observation horizon, counted in calendar days; before it elapses the period is INCONCLUSIVE, never zero",
  "coverage is read after maturity: an immature period stays INCONCLUSIVE even when its coverage is also missing",
  "a period whose required coverage is not COMPLETE is NOT_COMPUTABLE, never zero; the most severe declared state decides, whatever the row order",
  "a cohort is a different denominator from a period's repliers; the two are never merged and two maturities are never compared silently",
  "only a reply attributed through canonical identity, a DURABLY PROVEN prior outbound inside the " + String(ATTRIBUTION_LOOKBACK_DAYS) + "-calendar-day lookback and participation/approach evidence counts; a threading reference that resolves to nothing proven is UNATTRIBUTED and the most recent touch is never promoted",
  "an opt-out, a technical auto-reply, a permanent bounce, an undetermined inbound and a duplicate delivery each count zero and each pins its own consequence, before any measurement",
  "a meeting climbs " + MEETING_STATUS_LADDER.join(" then ") + "; reaching one rung never implies the next, a cancellation changes the active status without erasing the booking creation, and no rung is revenue",
  "no qualified-discovery definition is pinned, so a held meeting can never be called qualified",
  "the production target of every metric is not set; no measurement may be compared to one",
  "a company-global, overlap-sensitive total across runtimes is NOT_COMPUTABLE while no Shared Reality topology is declared; per-runtime figures stay available",
  "a numerator and a denominator of different units never form a rate",
  "the same metric definitions and the same input revision, asked the same question, identify the same snapshot; a backfill or a reclassification produces a NEW input revision and a NEW snapshot beside the old one",
];

const LEARNING_RULES: readonly string[] = [
  "two approach versions of one rep stay separately measurable; their results are never merged into the approach",
  "one approach run by two reps keeps the owner and the runtime on each participation; results are never pooled into a ranking of people",
  "a variant stays inside the Authority of the version it derives from; a comparison never widens Authority",
  "criteria are reported one by one: a single global winner is never declared, confounds are named and a replication is proposed",
  "no arm is called better below a pre-declared sample of " + String(MIN_ARM_SAMPLE) + " sent messages",
  "what a campaign configures is configuration; only a pinned exposure says what was actually communicated",
  "a link sent is not a link read, and a read is stated only with its own evidence",
  "each contact has at most one ACTIVE enrollment; successive campaigns are temporal, never parallel",
  "a confirmed offer is a configuration fact, never a validated strategy",
];

/** The META-side projection. Definitions, freshness and rules only — deterministic, and free of any business value. */
export function gtmAnalysisProjection(registration: RegisteredState, source: RegisteredState): GtmAnalysisProjection {
  const row = rowOf(registration);
  return {
    projection_version: PROJECTION_VERSION,
    metric_definitions_version: METRIC_DEFINITIONS_VERSION,
    metric_definitions_digest: METRIC_DEFINITIONS_DIGEST,
    snapshot_identity_version: SNAPSHOT_IDENTITY_VERSION,
    registered_resource: {
      ref: row?.ref ?? "NOT_FOUND",
      status: str(row?.status) === "" ? "NOT_REGISTERED" : str(row?.status),
      pinned_policy: str(row?.schema_version) === "" ? "NOT_PINNED" : str(row?.schema_version),
    },
    freshness: indexFreshness(registration, source),
    metrics: METRIC_CATALOG.map((m) => ({
      metric_key: m.metric_key, metric_class: m.metric_class, layer: m.layer, period_kind: m.period_kind,
      timezone: m.timezone, observation_horizon_days: m.observation_horizon_days, maturity_rule: m.maturity_rule,
      production_target_state: m.production_target_state, unit: m.unit, requires_coverage: m.requires_coverage,
      publication: "NOT_PUBLISHED_DEFINITION_ONLY" as const,
    })),
    measurement_rules: MEASUREMENT_RULES,
    learning_rules: LEARNING_RULES,
    publication_policy: {
      default: "NOT_PUBLISHED_WITHOUT_EXPLICIT_APPROVAL",
      private_rep_diagnostics: "NEVER_CROSS_REP",
      hypothetical_fields: "NEVER_PUBLISHED",
      layers_separated: ["CONFIGURATION", "EXECUTION", "EFFECTIVENESS"],
    },
    values: "NOT_COMPUTABLE_FROM_META",
    values_reason: "the events a measurement needs live in a Personal SALES runtime; META holds the definitions in " + ZONE + " time, never the numbers, and no lane reads across the other",
  };
}
