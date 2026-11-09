/**
 * GTM-W03 — CONTROLLED FIXTURE CATALOG (PBRUN-030 / PV-GTM-001F).
 *
 * TEST-ONLY, NON-LIVE, DETERMINISTIC. Nothing in this directory is imported by `src/`, shipped by the plugin
 * package, or adopted by any governing spec. It materializes the W02-admitted GTM semantics (D01..D07, D-CAL-01)
 * as a synthetic world plus machine-checked oracles, so that the per-principal read canaries scheduled for the
 * next GTM gate have a frozen target to compare against. It proves FIXTURE AND ORACLE AVAILABILITY ONLY:
 * no PT-GTM case is marked PASS here.
 *
 * Every logical key lives under the single fixture root `GTM_FIX`. The reset contract (see `world.ts`) rebuilds
 * exactly that namespace and nothing outside it.
 */

/** The only namespace this package owns. Reset/isolation is defined against this prefix. */
export const FIXTURE_ROOT = "GTM_FIX";
/** Stamped on every record's provenance so a leaked row is recognizable at a glance. */
export const NON_LIVE_MARKER = "NON_LIVE_SYNTHETIC_FIXTURE";
/** The only email/host domain any fixture identity may use (RFC 6761 reserved, unroutable). */
export const FIXTURE_DOMAIN = "example.invalid";

/** How a field may change. The oracle never compares a MUTABLE field as if it were evidence of history. */
export type FieldClass = "IMMUTABLE" | "VERSIONED" | "MUTABLE" | "PROVENANCE";

/**
 * Who may read a resource. Principal isolation is enforced by `readRows` in `oracle.ts`.
 *
 * NATURAL-KEY INVARIANT: a RUNTIME_SCOPED key is minted BY a runtime, so `runtime_key` must participate in its
 * natural key. Two runtimes minting the same local token is lawful, never a duplicate, and must never let a lookup
 * resolve another runtime's row (D06). `RUNTIME` itself is the exception: its natural key IS `runtime_key`.
 * `pt-gtm-key-collision.test.ts` machine-checks this over the catalog and over a colliding world.
 */
export type ReadScope = "RUNTIME_SCOPED" | "PRINCIPAL_SCOPED" | "CATALOG_GLOBAL";

export interface ResourceSpec {
  readonly resource_key: string;
  /** Ordered field names whose tuple is the natural key. Uniqueness is machine-checked over the world. */
  readonly natural_key: readonly string[];
  readonly fields: Readonly<Record<string, FieldClass>>;
  readonly read_scope: ReadScope;
  readonly note: string;
}

const PROVENANCE_FIELDS: Readonly<Record<string, FieldClass>> = {
  source_system: "PROVENANCE",
  observed_at: "PROVENANCE",
  evidence_ref: "PROVENANCE",
  non_live: "PROVENANCE",
};

const spec = (
  resource_key: string,
  natural_key: readonly string[],
  fields: Readonly<Record<string, FieldClass>>,
  read_scope: ReadScope,
  note: string,
): ResourceSpec => ({ resource_key, natural_key, fields: { ...fields, ...PROVENANCE_FIELDS }, read_scope, note });

export const RESOURCE_KEYS = {
  PRINCIPAL: `${FIXTURE_ROOT}:PRINCIPAL`,
  RUNTIME: `${FIXTURE_ROOT}:RUNTIME`,
  COMPANY: `${FIXTURE_ROOT}:COMPANY`,
  CONTACT: `${FIXTURE_ROOT}:CONTACT`,
  MESSAGE: `${FIXTURE_ROOT}:MESSAGE`,
  CAMPAIGN: `${FIXTURE_ROOT}:CAMPAIGN`,
  APPROACH_VERSION: `${FIXTURE_ROOT}:APPROACH_VERSION`,
  PARTICIPATION: `${FIXTURE_ROOT}:PARTICIPATION`,
  ENROLLMENT: `${FIXTURE_ROOT}:ENROLLMENT`,
  EXPOSURE: `${FIXTURE_ROOT}:EXPOSURE`,
  TRACKER_EVENT: `${FIXTURE_ROOT}:TRACKER_EVENT`,
  PROVIDER_EVENT: `${FIXTURE_ROOT}:PROVIDER_EVENT`,
  MEETING_EPISODE: `${FIXTURE_ROOT}:MEETING_EPISODE`,
  COVERAGE: `${FIXTURE_ROOT}:COVERAGE`,
  METRIC_DEF: `${FIXTURE_ROOT}:METRIC_DEF`,
  REGISTERED_CONTEXT: `${FIXTURE_ROOT}:REGISTERED_CONTEXT`,
} as const;

export type GtmResourceKey = (typeof RESOURCE_KEYS)[keyof typeof RESOURCE_KEYS];

/**
 * THE FROZEN RESOURCE CATALOG. `world.ts` may not carry a collection that is absent here, and every natural key
 * declared here is checked for uniqueness by `pt-gtm-coverage-matrix.test.ts`.
 */
export const RESOURCE_CATALOG: readonly ResourceSpec[] = [
  spec(RESOURCE_KEYS.PRINCIPAL, ["principal_key"], {
    principal_key: "IMMUTABLE", display_label: "IMMUTABLE", runtime_key: "IMMUTABLE", setup_shape: "VERSIONED",
    notion_state: "MUTABLE", gmail_read_state: "MUTABLE", tracker_state: "MUTABLE", calendar_state: "MUTABLE",
    gmail_manifest_identity: "IMMUTABLE", gmail_registry_identity: "IMMUTABLE", divergence: "MUTABLE", hold_reason: "MUTABLE",
  }, "PRINCIPAL_SCOPED", "synthetic source profile; shape only, never a live identity or connector state"),

  spec(RESOURCE_KEYS.RUNTIME, ["runtime_key"], {
    runtime_key: "IMMUTABLE", owner_principal_key: "IMMUTABLE", runtime_generation: "VERSIONED",
    runtime_scope: "IMMUTABLE", shared_reality_topology: "MUTABLE", calendar_source_connected: "IMMUTABLE",
  }, "RUNTIME_SCOPED", "one synthetic Personal SALES runtime; the pilot is single-runtime (D06)"),

  spec(RESOURCE_KEYS.COMPANY, ["runtime_key", "company_key"], {
    company_key: "IMMUTABLE", runtime_key: "IMMUTABLE", classification: "IMMUTABLE",
  }, "RUNTIME_SCOPED", "company dimension is per-runtime; there is no company-global dedup (D06)"),

  spec(RESOURCE_KEYS.CONTACT, ["runtime_key", "contact_key"], {
    contact_key: "IMMUTABLE", runtime_key: "IMMUTABLE", company_key: "IMMUTABLE", canonical_identity: "IMMUTABLE",
    party: "IMMUTABLE", identity_resolution: "MUTABLE", opted_out: "MUTABLE", address_stopped: "MUTABLE",
    takeover_required: "MUTABLE",
  }, "RUNTIME_SCOPED", "canonical identity is the attribution anchor (D03)"),

  spec(RESOURCE_KEYS.MESSAGE, ["runtime_key", "message_key"], {
    message_key: "IMMUTABLE", runtime_key: "IMMUTABLE", contact_key: "IMMUTABLE", direction: "IMMUTABLE",
    provider_message_id: "IMMUTABLE", occurred_at: "IMMUTABLE", kind: "VERSIONED", intent: "VERSIONED",
    campaign_key: "IMMUTABLE", approach_version_key: "IMMUTABLE", participation_key: "IMMUTABLE",
    exposure_key: "IMMUTABLE", in_reply_to: "IMMUTABLE", agreement_evidence: "IMMUTABLE",
  }, "RUNTIME_SCOPED", "outbound and inbound share one resource; duplicates share provider_message_id"),

  spec(RESOURCE_KEYS.CAMPAIGN, ["runtime_key", "campaign_key"], {
    campaign_key: "IMMUTABLE", runtime_key: "IMMUTABLE", owner_principal_key: "IMMUTABLE", approach_key: "IMMUTABLE",
    configured_offer: "VERSIONED", configured_price_cents: "VERSIONED", currency: "VERSIONED",
    started_at: "IMMUTABLE", ended_at: "MUTABLE", status: "MUTABLE",
  }, "RUNTIME_SCOPED", "configured offer/price is configuration, never exposure (D05)"),

  spec(RESOURCE_KEYS.APPROACH_VERSION, ["approach_version_key"], {
    approach_version_key: "IMMUTABLE", approach_key: "IMMUTABLE", version_label: "IMMUTABLE",
    authority_scope: "IMMUTABLE", variant_of: "IMMUTABLE",
  }, "CATALOG_GLOBAL", "variants stay inside the declared Authority scope; a variant never widens it (D05)"),

  spec(RESOURCE_KEYS.PARTICIPATION, ["runtime_key", "participation_key"], {
    participation_key: "IMMUTABLE", runtime_key: "IMMUTABLE", owner_principal_key: "IMMUTABLE",
    approach_version_key: "IMMUTABLE", campaign_key: "IMMUTABLE",
  }, "RUNTIME_SCOPED", "owner and runtime are preserved when two reps run one approach"),

  spec(RESOURCE_KEYS.ENROLLMENT, ["runtime_key", "campaign_key", "contact_key"], {
    enrollment_key: "IMMUTABLE", runtime_key: "IMMUTABLE", campaign_key: "IMMUTABLE", contact_key: "IMMUTABLE",
    state: "MUTABLE", started_at: "IMMUTABLE", ended_at: "MUTABLE",
  }, "RUNTIME_SCOPED", "at most one ACTIVE enrollment per contact; successive campaigns are temporal, not parallel"),

  spec(RESOURCE_KEYS.EXPOSURE, ["runtime_key", "exposure_key"], {
    exposure_key: "IMMUTABLE", runtime_key: "IMMUTABLE", contact_key: "IMMUTABLE", message_key: "IMMUTABLE",
    campaign_key: "IMMUTABLE", approach_version_key: "IMMUTABLE", communicated_offer: "IMMUTABLE",
    communicated_price_cents: "IMMUTABLE", currency: "IMMUTABLE", override_evidence: "IMMUTABLE", pinned_at: "IMMUTABLE",
  }, "RUNTIME_SCOPED", "an exposure pins what was actually communicated; every field is immutable once pinned (D05)"),

  spec(RESOURCE_KEYS.TRACKER_EVENT, ["runtime_key", "tracker_event_key"], {
    tracker_event_key: "IMMUTABLE", runtime_key: "IMMUTABLE", message_key: "IMMUTABLE", link_key: "IMMUTABLE",
    event_type: "IMMUTABLE", occurred_at: "IMMUTABLE", reader_fingerprint: "IMMUTABLE",
  }, "RUNTIME_SCOPED", "link sent is not link read; repeated opens of one link are one distinct read"),

  spec(RESOURCE_KEYS.PROVIDER_EVENT, ["runtime_key", "provider_event_key"], {
    provider_event_key: "IMMUTABLE", runtime_key: "IMMUTABLE", dataset: "IMMUTABLE", meeting_episode_id: "IMMUTABLE",
    series_key: "IMMUTABLE", occurrence_index: "IMMUTABLE", reschedule_of: "IMMUTABLE",
    starts_at: "VERSIONED", ends_at: "VERSIONED", status: "MUTABLE", title: "MUTABLE",
    agenda_evidence: "VERSIONED", participants: "VERSIONED", evidence_completeness: "MUTABLE",
    duplicate_of: "IMMUTABLE", thread_ref: "IMMUTABLE",
  }, "RUNTIME_SCOPED", "synthetic provider events only; no Calendar source is connected in W03"),

  spec(RESOURCE_KEYS.MEETING_EPISODE, ["runtime_key", "meeting_episode_id"], {
    meeting_episode_id: "IMMUTABLE", runtime_key: "IMMUTABLE", dataset: "IMMUTABLE", company_key: "IMMUTABLE", contact_keys: "IMMUTABLE",
    episode_kind: "IMMUTABLE", proposed_at: "IMMUTABLE", accepted_at: "IMMUTABLE", booked_at: "IMMUTABLE",
    held_at: "MUTABLE", qualified_at: "MUTABLE", canceled_at: "MUTABLE", agreement_evidence_ref: "IMMUTABLE",
  }, "RUNTIME_SCOPED", "the episode id is stable across reschedules; cancellation never erases the booking creation (D04)"),

  spec(RESOURCE_KEYS.COVERAGE, ["runtime_key", "coverage_key"], {
    coverage_key: "IMMUTABLE", runtime_key: "IMMUTABLE", source: "IMMUTABLE", since: "IMMUTABLE", until: "IMMUTABLE",
    state: "MUTABLE", gap_reason: "MUTABLE",
  }, "RUNTIME_SCOPED", "a metric over an uncovered window is NOT_COMPUTABLE, never zero"),

  spec(RESOURCE_KEYS.METRIC_DEF, ["metric_key"], {
    metric_key: "IMMUTABLE", metric_class: "IMMUTABLE", period_kind: "IMMUTABLE", timezone: "IMMUTABLE",
    half_open: "IMMUTABLE", observation_horizon_days: "VERSIONED", maturity_rule: "VERSIONED",
    production_target_state: "MUTABLE", fixture_threshold: "MUTABLE", unit: "IMMUTABLE",
  }, "CATALOG_GLOBAL", "per-metric horizons are explicit; a missing horizon/maturity rule is NOT_COMPUTABLE (D02)"),

  spec(RESOURCE_KEYS.REGISTERED_CONTEXT, ["runtime_key", "context_resource_key"], {
    runtime_key: "IMMUTABLE", context_resource_key: "IMMUTABLE", owner_principal_key: "IMMUTABLE",
    refs: "MUTABLE", registration_state: "MUTABLE", lane: "IMMUTABLE",
  }, "PRINCIPAL_SCOPED", "the only registered read-selection context the candidate pack may select"),
];

const BY_KEY: ReadonlyMap<string, ResourceSpec> = new Map(RESOURCE_CATALOG.map((r) => [r.resource_key, r]));
export const resourceSpec = (key: string): ResourceSpec | undefined => BY_KEY.get(key);

/**
 * CANDIDATE VERSION MARKERS. Stored decomposed (family + version) on purpose: this package must never contain a
 * governing-looking version literal, and a candidate must never be resolvable, dispatched, installed or compared
 * as governance. `activation` is the frozen proof of non-adoption.
 */
export interface CandidateMarker {
  readonly family: string;
  readonly version: string;
  readonly role: "CANDIDATE_NOT_ADOPTED";
  readonly activation: "NEVER_ACTIVATED_IN_PRODUCTION";
  readonly scope: "W03_FIXTURE_SEMANTICS_ONLY";
}

const candidate = (family: string, version: string): CandidateMarker => ({
  family, version, role: "CANDIDATE_NOT_ADOPTED", activation: "NEVER_ACTIVATED_IN_PRODUCTION", scope: "W03_FIXTURE_SEMANTICS_ONLY",
});

export const CANDIDATE_MARKERS: readonly CandidateMarker[] = [
  candidate("PLUGIN_SPEC", "0.4.0"),
  candidate("CONTRACT_PACK", "0.2.0"),
  candidate("SALES_RUNTIME_CONTRACT", "0.6.0"),
  candidate("SALES_SCHEMA", "0.6.0"),
];

/** Composes a marker for display/hashing. Never used to select an adapter, a resolver or a plan. */
export const markerLabel = (m: CandidateMarker): string => `${m.family}/${m.version}`;

/**
 * Families whose governing selection W03 leaves exactly as it found it. The package records the FAMILY, never the
 * current governing version: the governing version is resolved from Notion at run time, never from this repository.
 */
export const GOVERNANCE_UNTOUCHED_FAMILIES: readonly string[] = [
  "PLUGIN_SPEC", "META_SPEC", "META_SCHEMA", "CONTRACT_PACK", "SALES_RUNTIME_CONTRACT", "SALES_SCHEMA", "CONTROL",
];

/** What a W03 run is allowed to conclude. Never `PASS` for a PT-GTM case. */
export const RESULT_SEMANTICS = "FIXTURE_AND_ORACLE_AVAILABLE" as const;
/** Per-principal real read canaries stay deferred to the next GTM gate. */
export const REAL_READ_CANARY = "DEFERRED_GTM_G3" as const;
