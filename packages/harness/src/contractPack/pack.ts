/**
 * Contract Pack builder (11 — CONTRACT PACK candidate v4, PDEC-015).
 *
 * The pack is a READ PLAN for the native Notion / Gmail fanout. It consumes the already-derived `os_resume`
 * safety state; it never reimplements `deriveResumeState`, recovery precedence, Gmail reconciliation or CONTROL,
 * and it never filters, hides or restates any safety field. Selection is a pure function of
 * (bound lane, normalized needs); the refs a selected pointer carries are data, not selection.
 *
 * Fail-narrow grammar, in this order per comma-separated part:
 *   1. a bare token matching the allowlist case-insensitively  → that need;
 *   2. a strictly UPPERCASE bare token outside the allowlist    → an unknown need token;
 *   3. anything else (spaces, punctuation, a URL, a sentence)   → the WHOLE hint is legacy free text.
 * Legacy free text never reaches the output: it collapses to CURRENT_WORK plus a warning, so no caller-supplied
 * prose, ref or authority claim can appear in the pack.
 */
import { createHash } from "node:crypto";
import type { Lane, VersionsSummary } from "../tools/envelope.ts";
import type { ResumeState } from "../resume/derive.ts";
import type { ExternalActionsView } from "../effects/adapter.ts";
import {
  allowedNeedsForLane, CANDIDATE_POLICY_VERSION, CONTEXT_NEEDS, CONTEXT_POLICY, isContextNeed, isGtmNeed,
  laneOptionalResources, NEED_LANE, NEED_RESOURCES, POLICY_VERSION, RESOURCE_KEYS, type ContextKind,
  type ContextNeed, type ContextPolicy, type ContextSectionSpec, type ResourceKey,
} from "./catalog.ts";
import type { GtmAnalysisProjection, GtmContainer } from "../gtm/context.ts";

export type Completeness = "COMPLETE" | "NEEDS_EXPANSION" | "HOLD";
/** Coarse, symbolic invalidation reason. Never carries caller text, a ref or a business value. */
export type CompletenessReason = "NONE" | "cross_lane_rejected" | "unknown_need_token" | "gtm_capability_absent" | "context_not_registered";

/** Narrow bound-mailbox Gmail selector, taken from routing metadata the effect adapter already derived. */
export interface GmailSelector {
  readonly intent_ref: string;
  readonly action_key: string;
  readonly mailbox_identity: string;
  readonly recipient: string;
  readonly since: string;
  readonly until: string;
  readonly thread_ref?: string;
}

export interface ContractPackPointer {
  readonly resource_key: ResourceKey;
  readonly source: "NOTION" | "GMAIL";
  /** Exact registered / durable ref values the native read needs. Empty when durable state currently has none. */
  readonly refs: readonly string[];
  /** Narrow competent-source selectors (GMAIL pointers only). Routing context for the bound runtime, never authority. */
  readonly selectors?: readonly GmailSelector[];
  readonly reason: string;
  /**
   * Explicit availability of a CANDIDATE pointer. A selected resource that is not registered for the bound
   * principal and runtime is UNAVAILABLE_NOT_REGISTERED and makes the pack NEEDS_EXPANSION; it is never COMPLETE
   * with an empty ref list. Absent on adopted pointers, whose shape is unchanged.
   */
  readonly availability?: "AVAILABLE" | "UNAVAILABLE_NOT_REGISTERED";
  /** Provenance / freshness already available from durable state. */
  readonly provenance: Readonly<Record<string, string | number | boolean>>;
}

/**
 * A served content value, exactly as the source holds it. Scalars only: restating a structure would mean
 * interpreting it, and this framework carries content, it never interprets it.
 */
export type ContextValue = string | number | boolean;
export type ContextItem = Readonly<Record<string, ContextValue>>;

/**
 * Rows the harness supplies for one declared source key (S7: a symbol, never an internal state path). ABSENT means
 * the harness could not resolve that source for this runtime, never that the seller space holds no such record.
 */
export interface ContextSource {
  readonly source_key: string;
  readonly status: "PRESENT" | "ABSENT";
  readonly rows: readonly unknown[];
}

export interface ContextSection {
  readonly section_key: string;
  readonly source_key: string;
  readonly source_status: "PRESENT" | "ABSENT";
  /** The exact key set this section may serve. Every served item carries a subset of it, never anything else. */
  readonly projected_keys: readonly string[];
  readonly items: readonly ContextItem[];
  readonly served: number;
  readonly available: number;
  /**
   * Rows the source held that this section did not serve. Explicit truncation (S6), and the ONLY thing said about
   * them: no cursor, no token and no offset is served, because no input of os_resume could consume one.
   */
  readonly omitted: number;
  readonly truncated_by: "NONE" | "ROWS_PER_SECTION" | "SERIALIZED_BYTES";
}

export interface ContextBlock {
  readonly context: ContextKind;
  readonly sections: readonly ContextSection[];
}

export interface SelectedContextBounds {
  readonly max_rows_per_section: number;
  readonly max_serialized_bytes: number;
  /** Byte length of THIS payload, serialized in full, metadata included (S4). Measured, never estimated. */
  readonly serialized_bytes: number;
  readonly truncated: boolean;
}

/**
 * The bounded CONTENT served for this turn (D6), beside the pointer read plan. Its policy_version is the CONTENT
 * policy (S1); the pointer policy on the pack itself is untouched, so a GTM binding keeps 0.2 pointer-for-pointer.
 * The contexts list is empty when the normalized needs select none (S5): one stable shape, never a missing field.
 */
export interface SelectedContext {
  readonly policy_version: string;
  readonly policy_role: "CANDIDATE_NOT_ADOPTED";
  readonly contexts: readonly ContextBlock[];
  readonly bounds: SelectedContextBounds;
}

export interface ContractPack {
  readonly policy_version: string;
  /** Applied policy role: the adopted one, or the candidate one for a GTM-capable binding. */
  readonly policy_role?: "ADOPTED" | "CANDIDATE_NOT_ADOPTED";
  readonly requested_needs: readonly string[];
  readonly normalized_needs: readonly ContextNeed[];
  readonly completeness: Completeness;
  readonly completeness_reason: CompletenessReason;
  readonly state_fingerprint: string;
  readonly pack_id: string;
  readonly selected_pointers: readonly ContractPackPointer[];
  /**
   * The bounded content of the selected contexts, under the content policy (S1). That version, the catalogue and
   * projection digest and the bounds are part of pack_id (S8), so no silent policy change keeps an identity.
   */
  readonly selected_context: SelectedContext;
  /** Authorized optional resource keys NOT selected for native reading. Never a claim that data is absent. */
  readonly omitted_resource_keys: readonly ResourceKey[];
  readonly allowed_needs_for_lane: readonly ContextNeed[];
}

export interface PackInput {
  readonly lane: Lane;
  readonly topic_hint?: string | undefined;
  readonly runtime_generation: string;
  readonly versions: VersionsSummary;
  /** The complete already-derived safety state (partial on an outer HOLD). Consumed, never reclassified. */
  readonly safety: Partial<ResumeState>;
  readonly external_actions?: ExternalActionsView | undefined;
  readonly open_backend_plan: unknown;
  /** Capability declared by the BOUND RUNTIME (governing contract adapter / registered resource). Never a caller input. */
  readonly gtm_capability?: boolean | undefined;
  /** GTM read context of the bound runtime: container refs only, never rows. */
  readonly gtm_containers?: readonly GtmContainer[] | undefined;
  /** The registered META GTM measurement resource, as the resume state exposes it. */
  readonly meta_gtm_metrics?: { readonly ref: string; readonly status?: unknown } | "NOT_FOUND" | "NOT_APPLICABLE" | undefined;
  /** The META projection, when this binding is GTM-capable; reported beside the pack, never inside a pointer. */
  readonly gtm_analysis?: GtmAnalysisProjection | undefined;
  /**
   * Rows the harness supplies per declared source key. The SETUP sources are read by `setupSources.ts` (W2.2) and
   * are PRESENT only for a SALES binding outside any outer HOLD; a source not supplied here is served ABSENT. The
   * DAILY sources are read by `dailySources.ts` (W2.3) outside an outer HOLD, or under the reliable Gmail-only
   * capability HOLD specified by W5.1R (Notion read-only; the outer HOLD remains authoritative). EXTERNAL_ACTION uses
   * `externalActionSources.ts` (W2.4), also on a HOLD whose snapshot of the bound runtime is reliable.
   */
  readonly context_sources?: readonly ContextSource[] | undefined;
  /** The content policy in force. Production always uses the catalogue default; only a test pins another one. */
  readonly context_policy?: ContextPolicy | undefined;
}

export interface PackResult {
  readonly pack: ContractPack;
  /** Envelope warnings. Non-empty ONLY for legacy free text: a rejected other-lane need adds nothing here, so
   *  every safety field stays byte-identical to the same resume without that need. */
  readonly warnings: readonly string[];
}

const BARE_TOKEN = /^[A-Za-z][A-Za-z0-9_]*$/;
const UPPER_TOKEN = /^[A-Z][A-Z0-9_]*$/;

interface Normalized {
  readonly requested: readonly string[];
  readonly needs: readonly ContextNeed[];
  readonly unknown: readonly string[];
  readonly crossLane: readonly ContextNeed[];
  /** Candidate needs requested by a binding whose runtime does not declare the capability. */
  readonly uncapable: readonly ContextNeed[];
  readonly legacy: boolean;
}

const byCanonicalOrder = (a: ContextNeed, b: ContextNeed) => CONTEXT_NEEDS.indexOf(a) - CONTEXT_NEEDS.indexOf(b);
const LEGACY: Normalized = { requested: [], needs: ["CURRENT_WORK"], unknown: [], crossLane: [], uncapable: [], legacy: true };
const DEFAULTED: Normalized = { requested: [], needs: ["CURRENT_WORK"], unknown: [], crossLane: [], uncapable: [], legacy: false };

export function normalizeTopicHint(lane: Lane, hint: string | undefined, gtm = false): Normalized {
  const raw = (hint ?? "").trim();
  if (raw === "") return DEFAULTED;
  const parts = raw.split(",").map((p) => p.trim()).filter((p) => p !== "");
  if (parts.length === 0) return DEFAULTED;

  const known = new Set<ContextNeed>();
  const unknown = new Set<string>();
  for (const part of parts) {
    if (!BARE_TOKEN.test(part)) return LEGACY;
    const upper = part.toUpperCase();
    if (isContextNeed(upper)) { known.add(upper); continue; }
    if (UPPER_TOKEN.test(part)) { unknown.add(upper); continue; }
    return LEGACY; // a lowercase word outside the allowlist is presentation text, not an intended need
  }

  const inLane: ContextNeed[] = [];
  const crossLane: ContextNeed[] = [];
  const uncapable: ContextNeed[] = [];
  for (const need of [...known].sort(byCanonicalOrder)) {
    if (NEED_LANE[need] !== "ANY" && NEED_LANE[need] !== lane) { crossLane.push(need); continue; }
    if (isGtmNeed(need) && !gtm) { uncapable.push(need); continue; }
    inLane.push(need);
  }
  return {
    requested: [...[...known].sort(byCanonicalOrder), ...[...unknown].sort()],
    needs: inLane.length > 0 ? inLane : ["CURRENT_WORK"],
    unknown: [...unknown].sort(),
    crossLane,
    uncapable,
    legacy: false,
  };
}

/** Stable serialization: object keys sorted, arrays in order, `undefined` dropped. */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`).join(",")}}`;
  }
  return "null";
}

const digest = (s: string): string => `sha256:${createHash("sha256").update(s, "utf8").digest("hex")}`;

const known = (t: unknown): t is string => typeof t === "string" && t !== "UNKNOWN" && t !== "NOT_FOUND" && t !== "NOT_APPLICABLE" && t !== "NOT_YET_CREATED" && t.trim() !== "";

function metaInputsPointer(safety: Partial<ResumeState>): ContractPackPointer {
  const row = safety.meta_inputs;
  if (row === undefined || row === "NOT_FOUND" || row === "NOT_APPLICABLE") {
    return {
      resource_key: RESOURCE_KEYS.META_SALES_RUNTIME_INPUTS, source: "NOTION", refs: [],
      reason: "registered META inputs resource is not resolvable in this runtime; read nothing and do not improvise a target",
      provenance: { status: row ?? "NOT_APPLICABLE" },
    };
  }
  return {
    resource_key: RESOURCE_KEYS.META_SALES_RUNTIME_INPUTS, source: "NOTION",
    refs: [known(row.url) ? row.url : row.ref],
    reason: "registered derived SALES inputs pointer for the bound META runtime; read it with the native Notion app",
    provenance: {
      registered_key: row.resource_key,
      status: known(row.status) ? row.status : "UNKNOWN",
      scope: known(row.scope) ? row.scope : "UNKNOWN",
      schema_version: known(row.schema_version) ? row.schema_version : "UNKNOWN",
      last_verified: known(row.last_verified) ? row.last_verified : "UNKNOWN",
    },
  };
}

function externalActionsPointer(ea: ExternalActionsView | undefined): ContractPackPointer {
  const rows = ea?.unresolved ?? [];
  return {
    resource_key: RESOURCE_KEYS.SALES_EXTERNAL_ACTIONS, source: "NOTION",
    refs: rows.map((r) => r.ref),
    reason: "unresolved durable ExternalActionIntent records of the bound Personal SALES runtime; routing context only, never send authority",
    provenance: {
      unresolved_count: rows.length,
      reconciliation_required: ea?.reconciliation_required ?? false,
      competent_source: ea?.competent_source ?? "NOT_APPLICABLE",
      competent_source_available: ea?.competent_source_available ?? false,
    },
  };
}

function gmailReconciliationPointer(ea: ExternalActionsView | undefined): ContractPackPointer {
  const rows = ea?.unresolved ?? [];
  const selectors: GmailSelector[] = rows.map((r) => ({
    intent_ref: r.ref,
    action_key: r.routing.action_key,
    mailbox_identity: r.routing.mailbox_identity,
    recipient: r.routing.recipient,
    since: r.routing.reconcile_window.since,
    until: r.routing.reconcile_window.until,
    ...(known(r.thread_ref) ? { thread_ref: r.thread_ref } : {}),
  }));
  return {
    resource_key: RESOURCE_KEYS.SALES_GMAIL_RECONCILIATION, source: "GMAIL",
    refs: rows.map((r) => r.ref),
    selectors,
    reason: "narrow bound-mailbox competent-source lookup for those durable intents; read/reconcile only — never send",
    provenance: {
      selector_count: selectors.length,
      competent_source_available: ea?.competent_source_available ?? false,
      reconciliation_required: ea?.reconciliation_required ?? false,
    },
  };
}

function metaGtmMetricsPointer(input: PackInput): ContractPackPointer {
  const row = input.meta_gtm_metrics;
  if (row === undefined || row === "NOT_FOUND" || row === "NOT_APPLICABLE") {
    return {
      resource_key: RESOURCE_KEYS.META_GTM_METRIC_REFS, source: "NOTION", refs: [],
      reason: "no GTM measurement resource is registered for this runtime; read nothing and state no measurement",
      availability: "UNAVAILABLE_NOT_REGISTERED",
      provenance: { status: row === undefined ? "NOT_APPLICABLE" : row },
    };
  }
  return {
    resource_key: RESOURCE_KEYS.META_GTM_METRIC_REFS, source: "NOTION", refs: [row.ref],
    reason: "the explicitly registered GTM measurement resource of this runtime; definitions and horizons only, never a number",
    availability: "AVAILABLE",
    provenance: { status: typeof row.status === "string" ? row.status : "UNKNOWN" },
  };
}

function salesGtmContextPointer(input: PackInput): ContractPackPointer {
  const containers = input.gtm_containers ?? [];
  const found = containers.filter((c) => c.ref !== "NOT_FOUND");
  const missing = containers.filter((c) => c.ref === "NOT_FOUND");
  return {
    resource_key: RESOURCE_KEYS.SALES_GTM_CAMPAIGN_CONTEXT, source: "NOTION",
    refs: found.map((c) => c.ref as string),
    availability: found.length > 0 && missing.length === 0 ? "AVAILABLE" : "UNAVAILABLE_NOT_REGISTERED",
    reason: "the GTM containers of the bound principal's own runtime (campaigns, approach versions, participations, enrollments, exposures, meeting episodes, attributions, observations); read them with the native Notion app",
    provenance: {
      containers_found: found.length,
      containers_missing: containers.filter((c) => c.ref === "NOT_FOUND").map((c) => c.database_title).join(", ") || "NONE",
      resource_keys: found.map((c) => c.resource_key).join(", ") || "NONE",
    },
  };
}

function pointersFor(lane: Lane, needs: readonly ContextNeed[], input: PackInput): ContractPackPointer[] {
  const wanted = new Set<ResourceKey>(needs.flatMap((n) => [...NEED_RESOURCES[n]]));
  const candidateNeeds = needs.some((n) => isGtmNeed(n));
  return laneOptionalResources(lane, input.gtm_capability === true)
    .filter((k) => wanted.has(k))
    .map((k) => {
      switch (k) {
        case RESOURCE_KEYS.META_SALES_RUNTIME_INPUTS: {
          const pointer = metaInputsPointer(input.safety);
          // Availability is stated only when a CANDIDATE need selected it: the adopted pointer shape is unchanged.
          if (!candidateNeeds) return pointer;
          return { ...pointer, availability: pointer.refs.length > 0 ? "AVAILABLE" : "UNAVAILABLE_NOT_REGISTERED" };
        }
        case RESOURCE_KEYS.SALES_EXTERNAL_ACTIONS: return externalActionsPointer(input.external_actions);
        case RESOURCE_KEYS.SALES_GMAIL_RECONCILIATION: return gmailReconciliationPointer(input.external_actions);
        case RESOURCE_KEYS.META_GTM_METRIC_REFS: return metaGtmMetricsPointer(input);
        case RESOURCE_KEYS.SALES_GTM_CAMPAIGN_CONTEXT: return salesGtmContextPointer(input);
      }
    });
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Exactly the projected keys, each value carried as the source holds it. A value outside the governed options on a
 * projected key is transported verbatim, never validated, corrected or classified (D11 governs writing, not
 * reading). A key outside the projection is not read at all, so a column the seller added to their own space is
 * tolerated by being ignored. A projected key whose value is not scalar is not carried.
 */
function projectRow(row: Record<string, unknown>, keys: readonly string[]): ContextItem {
  const out: Record<string, ContextValue> = {};
  for (const key of keys) {
    const v = Object.hasOwn(row, key) ? row[key] : undefined;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[key] = v;
  }
  return out;
}

/**
 * The identity of the content policy (S8): its version, the admitted contexts, the need mapping, the projection
 * table and the bounds. Changing any of them changes this digest, hence pack_id.
 */
export function contextPolicyDigest(policy: ContextPolicy): string {
  return digest(canonicalize({
    version: policy.version, kinds: policy.kinds, need_context: policy.need_context,
    sections: policy.sections, bounds: policy.bounds,
  }));
}

interface SectionPlan {
  readonly spec: ContextSectionSpec;
  readonly source_status: "PRESENT" | "ABSENT";
  readonly available: number;
  readonly candidates: readonly ContextItem[];
}

/**
 * The bounded projector: the whole of W2.1. It knows contexts, sections, projection and bounds, and nothing about
 * any business content, which is why W2.2 to W2.4 only declare sections in the catalogue.
 *
 * Deterministic and monotone: contexts in catalogue order, sections in declared order, rows in the order the source
 * holds them, cut first by the per-section row bound, then by the byte bound MEASURED on the complete serialized
 * payload (S4). The first row that does not fit ends the fill, so what is served is always a prefix of the
 * canonical order; every section states what it did not serve (S6). Source pagination stays internal: the rows a
 * source hands over are already its own page, and no cursor of any kind is served.
 *
 * Invariant: the metadata of the declared sections must itself fit the byte bound. It is measured, not assumed, so
 * a catalogue that could not fit is caught by PT-CP-011 rather than served.
 */
/** A served symbol: uppercase, digits and underscores. Anything shaped like a path or a traversal is refused. */
const CONTEXT_SYMBOL = /^[A-Z][A-Z0-9_]*$/;
const isPathShaped = (v: string): boolean => v.includes(".") || v.includes("/") || v.includes("[");

/**
 * Item keys a continuation handle would hide behind (S6). No projection may publish one, whatever its case: the
 * absence of a public cursor is a property of the boundary, not a habit of the tables that pass through it.
 */
const RESERVED_ITEM_KEYS: ReadonlySet<string> = new Set(["cursor", "token", "offset", "next_cursor", "has_more"]);

export type ContextPolicyViolationCode =
  | "CONTEXT_SECTION_KEY_PATH_SHAPED"
  | "CONTEXT_SECTION_KEY_NOT_SYMBOLIC"
  | "CONTEXT_SOURCE_KEY_PATH_SHAPED"
  | "CONTEXT_SOURCE_KEY_NOT_SYMBOLIC"
  | "CONTEXT_PROJECTED_KEY_RESERVED"
  | "CONTEXT_METADATA_EXCEEDS_BYTE_BOUND";

/**
 * A content policy that cannot be served within the rules. It fails closed: no context is projected at all, because
 * serving a payload that breaks S4, S6 or S7 would be worse than serving none. The code is stable and the message
 * names the offending symbol, so the failure is diagnosable without reading any state.
 */
export class ContextPolicyViolation extends Error {
  readonly code: ContextPolicyViolationCode;
  constructor(code: ContextPolicyViolationCode, detail: string) {
    super(code + ": " + detail);
    this.name = "ContextPolicyViolation";
    this.code = code;
  }
}

function assertSymbolicKey(which: "SECTION" | "SOURCE", value: string): void {
  const pathCode = which === "SECTION" ? "CONTEXT_SECTION_KEY_PATH_SHAPED" : "CONTEXT_SOURCE_KEY_PATH_SHAPED";
  const symbolCode = which === "SECTION" ? "CONTEXT_SECTION_KEY_NOT_SYMBOLIC" : "CONTEXT_SOURCE_KEY_NOT_SYMBOLIC";
  if (isPathShaped(value)) throw new ContextPolicyViolation(pathCode, value);
  if (!CONTEXT_SYMBOL.test(value)) throw new ContextPolicyViolation(symbolCode, value);
}

/**
 * The boundary check (S6 / S7), run on the WHOLE policy rather than on the contexts this turn selected: a table that
 * could leak an internal path or publish a continuation handle is refused whether or not today needs reach it.
 */
function assertPolicyAdmitted(policy: ContextPolicy): void {
  for (const kind of policy.kinds) {
    for (const spec of policy.sections[kind]) {
      assertSymbolicKey("SECTION", spec.section_key);
      assertSymbolicKey("SOURCE", spec.source_key);
      for (const key of spec.projected_keys) {
        if (RESERVED_ITEM_KEYS.has(key.toLowerCase())) throw new ContextPolicyViolation("CONTEXT_PROJECTED_KEY_RESERVED", spec.section_key + " " + key);
      }
    }
  }
}

export function projectSelectedContext(policy: ContextPolicy, contexts: readonly ContextKind[], sources: readonly ContextSource[]): SelectedContext {
  assertPolicyAdmitted(policy);
  const byKey = new Map(sources.map((s) => [s.source_key, s] as const));
  const cap = policy.bounds.max_rows_per_section;
  const plan = contexts.map((kind) => ({
    kind,
    sections: policy.sections[kind].map((spec): SectionPlan => {
      const source = byKey.get(spec.source_key);
      // A source the harness declared ABSENT serves nothing, even if it contradicts itself and hands rows over:
      // ABSENT states that this runtime resolves no such source, and rows cannot outvote that statement.
      const rows = source && source.status === "PRESENT" ? source.rows.filter(isRecord) : [];
      return {
        spec,
        source_status: source ? source.status : "ABSENT",
        available: rows.length,
        candidates: rows.slice(0, cap).map((r) => projectRow(r, spec.projected_keys)),
      };
    }),
  }));
  const served = plan.map((c) => c.sections.map(() => 0));

  const render = (serialized_bytes: number): SelectedContext => ({
    policy_version: policy.version,
    policy_role: "CANDIDATE_NOT_ADOPTED",
    contexts: plan.map((c, ci) => ({
      context: c.kind,
      sections: c.sections.map((sec, si) => {
        const n = served[ci]![si]!;
        const omitted = sec.available - n;
        return {
          section_key: sec.spec.section_key,
          source_key: sec.spec.source_key,
          source_status: sec.source_status,
          projected_keys: sec.spec.projected_keys,
          items: sec.candidates.slice(0, n),
          served: n,
          available: sec.available,
          omitted,
          truncated_by: omitted === 0 ? "NONE" : n < sec.candidates.length ? "SERIALIZED_BYTES" : "ROWS_PER_SECTION",
        };
      }),
    })),
    bounds: {
      max_rows_per_section: cap,
      max_serialized_bytes: policy.bounds.max_serialized_bytes,
      serialized_bytes,
      truncated: plan.some((c, ci) => c.sections.some((sec, si) => sec.available > served[ci]![si]!)),
    },
  });

  /** serialized_bytes names the size of the very payload that carries it: iterate to the fixed point, then state it. */
  const settle = (): { readonly context: SelectedContext; readonly bytes: number } => {
    let reported = 0;
    for (let i = 0; i < 8; i++) {
      const candidate = render(reported);
      const bytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
      if (bytes === reported) return { context: candidate, bytes };
      reported = bytes;
    }
    const settled = render(reported);
    return { context: settled, bytes: Buffer.byteLength(JSON.stringify(settled), "utf8") };
  };

  // S4 is absolute: the metadata of the declared sections must itself fit, or nothing is served at all. A payload
  // over the bound is never returned, not even an empty one, because the bound is the promise, not the rows.
  const bound = policy.bounds.max_serialized_bytes;
  const skeleton = settle().bytes;
  if (skeleton > bound) throw new ContextPolicyViolation("CONTEXT_METADATA_EXCEEDS_BYTE_BOUND", skeleton + " bytes of metadata alone exceed " + bound);

  fill: for (let ci = 0; ci < plan.length; ci++) {
    for (let si = 0; si < plan[ci]!.sections.length; si++) {
      const candidates = plan[ci]!.sections[si]!.candidates;
      for (let ri = 0; ri < candidates.length; ri++) {
        served[ci]![si] = ri + 1;
        if (settle().bytes > bound) { served[ci]![si] = ri; break fill; }
      }
    }
  }
  const settled = settle();
  if (settled.bytes > bound) throw new ContextPolicyViolation("CONTEXT_METADATA_EXCEEDS_BYTE_BOUND", settled.bytes + " bytes exceed " + bound);
  return settled.context;
}

/**
 * `state_fingerprint` is a content hash over the bound runtime generation, the governing-version summary, the
 * COMPLETE already-derived safety state, the open backend plan and the effect-reconciliation state. Being
 * content-based, two changes inside the same minute still differ whenever the derived state differs.
 * `pack_id` additionally covers the policy version, the canonical normalized needs and the ordered pointers.
 * Both are identity / observability aids only: `os_prepare` accepts neither and rehydrates independently.
 */
export function buildContractPack(input: PackInput): PackResult {
  const lane = input.lane;
  const gtm = input.gtm_capability === true;
  const n = normalizeTopicHint(lane, input.topic_hint, gtm);
  const selected = pointersFor(lane, n.needs, input);
  // S2 / S3 / S5: the contexts the normalized needs select, catalogue order; none for a pointer-only GTM need.
  const contextPolicy = input.context_policy ?? CONTEXT_POLICY;
  const contextKinds = contextPolicy.kinds.filter((kind) => n.needs.some((need) => contextPolicy.need_context[need] === kind));
  const selectedKeys = new Set<ResourceKey>(selected.map((p) => p.resource_key));

  const state_fingerprint = digest(canonicalize({
    runtime_generation: input.runtime_generation,
    governing_versions: input.versions,
    safety: input.safety,
    open_backend_plan: input.open_backend_plan,
    effects: input.external_actions ?? null,
    // A relevant GTM ref or capability change changes the pack identity, so a stale pack cannot pass for a fresh one.
    gtm: gtm ? { containers: input.gtm_containers ?? [], metrics: input.meta_gtm_metrics ?? null } : null,
  }));

  // A candidate need that selected an unregistered resource can never report COMPLETE (frozen W03 PT-GTM-014/F).
  const unregistered = selected.filter((p) => p.availability === "UNAVAILABLE_NOT_REGISTERED").map((p) => p.resource_key);
  const completeness: Completeness =
    n.crossLane.length > 0 ? "HOLD"
      : n.unknown.length > 0 || n.uncapable.length > 0 || unregistered.length > 0 ? "NEEDS_EXPANSION"
        : "COMPLETE";
  const completeness_reason: CompletenessReason =
    n.crossLane.length > 0 ? "cross_lane_rejected"
      : n.unknown.length > 0 ? "unknown_need_token"
        : n.uncapable.length > 0 ? "gtm_capability_absent"
          : unregistered.length > 0 ? "context_not_registered"
            : "NONE";

  const policy_version = gtm ? CANDIDATE_POLICY_VERSION : POLICY_VERSION;
  const pack: ContractPack = {
    policy_version,
    ...(gtm ? { policy_role: "CANDIDATE_NOT_ADOPTED" as const } : {}),
    requested_needs: n.requested,
    normalized_needs: n.needs,
    completeness,
    completeness_reason,
    state_fingerprint,
    pack_id: digest(canonicalize({
      policy_version,
      state_fingerprint,
      normalized_needs: n.needs,
      selected_pointers: selected,
      // S8: the content policy is part of the identity — its version, its catalogue/projection digest and its bounds.
      context_policy: { version: contextPolicy.version, digest: contextPolicyDigest(contextPolicy), bounds: contextPolicy.bounds },
    })),
    selected_pointers: selected,
    selected_context: projectSelectedContext(contextPolicy, contextKinds, input.context_sources ?? []),
    omitted_resource_keys: laneOptionalResources(lane, gtm).filter((k) => !selectedKeys.has(k)),
    allowed_needs_for_lane: allowedNeedsForLane(lane, gtm),
  };

  return {
    pack,
    warnings: n.legacy ? ["contract_pack_topic_hint_legacy_text: the hint is not an uppercase-token list; it was read as presentation text and normalized to CURRENT_WORK"] : [],
  };
}

export interface PackTelemetry {
  readonly policy_version: string;
  readonly normalized_needs: readonly ContextNeed[];
  readonly resource_keys: readonly ResourceKey[];
  readonly pointer_count: number;
  readonly completeness: Completeness;
  readonly completeness_reason: CompletenessReason;
}

/**
 * The ONLY sanctioned telemetry projection: policy version, symbolic needs, symbolic resource keys, pointer
 * count, completeness and the coarse reason. Never a ref, URL, page id, recipient, subject/content ref or
 * thread id. V0 wires no telemetry sink; this is the shape any future sink must use.
 */
export function packTelemetry(pack: ContractPack): PackTelemetry {
  return {
    policy_version: pack.policy_version,
    normalized_needs: pack.normalized_needs,
    resource_keys: pack.selected_pointers.map((p) => p.resource_key),
    pointer_count: pack.selected_pointers.length,
    completeness: pack.completeness,
    completeness_reason: pack.completeness_reason,
  };
}
