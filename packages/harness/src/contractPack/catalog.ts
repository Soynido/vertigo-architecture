/**
 * Contract Pack `CONTRACT_PACK/0.1.0` — the explicit, tiny V0 catalog (11 — CONTRACT PACK candidate v4, PDEC-015).
 *
 * This is deliberately a constant table, NOT a generic resource registry or a platform. Adding an entry later
 * requires a normal documented spec change plus tests. The caller never supplies a catalog key: these symbols are
 * READ-SELECTION symbols only. If one is handed to `os_prepare`, the unchanged mutation catalog fails closed
 * (`versions/adapters/controlPlane.ts` knows nothing about them), which is the intended behavior.
 *
 * `PLUGIN_SPEC` is a package/release-artifact version and is never resolved or dispatched at run time: this
 * module's behavior is the behavior of the candidate package, exercised on controlled fixtures until Notion
 * adopts the candidate spec and writes the Plugin Manifest LAST.
 */
import type { Lane } from "../tools/envelope.ts";

export const POLICY_VERSION = "CONTRACT_PACK/0.1.0";
/**
 * CANDIDATE policy (PV-GTM-002). Applied ONLY to a binding whose runtime declares the GTM capability; every other
 * binding keeps `POLICY_VERSION` and a byte-identical pack. Registering a candidate is not adopting it.
 */
export const CANDIDATE_POLICY_VERSION = "CONTRACT_PACK/0.2.0";

/**
 * The allowlisted semantic needs. This order IS the canonical order of `normalized_needs`. The last two are
 * CANDIDATE needs: they are only offered to a GTM-capable binding (`allowedNeedsForLane`), and requesting one
 * elsewhere answers NEEDS_EXPANSION with a truthful reason instead of selecting anything.
 *
 * `SALES_SETUP_INPUTS` (W2.2, S2 amendment) is a candidate-binary catalogue extension, NOT a GTM need: it is offered
 * to every SALES binding whatever its external pointer policy_version, selects the SETUP context and no pointer.
 */
export const CONTEXT_NEEDS = ["CURRENT_WORK", "META_SETUP_INPUTS", "SALES_EXTERNAL_ACTION", "SALES_EMAIL_RECONCILIATION", "SALES_SETUP_INPUTS", "META_GTM_ANALYSIS", "SALES_GTM_CONTEXT"] as const;
export type ContextNeed = (typeof CONTEXT_NEEDS)[number];

const NEED_SET: ReadonlySet<string> = new Set(CONTEXT_NEEDS);
export const isContextNeed = (v: string): v is ContextNeed => NEED_SET.has(v);

/** Lane a need belongs to. `CURRENT_WORK` is lane-agnostic; every other need is lane-exclusive. */
export const NEED_LANE: Readonly<Record<ContextNeed, Lane | "ANY">> = {
  CURRENT_WORK: "ANY",
  META_SETUP_INPUTS: "META",
  SALES_EXTERNAL_ACTION: "SALES",
  SALES_EMAIL_RECONCILIATION: "SALES",
  SALES_SETUP_INPUTS: "SALES",
  META_GTM_ANALYSIS: "META",
  SALES_GTM_CONTEXT: "SALES",
};

/** The needs that exist only under the candidate policy. */
export const GTM_NEEDS: readonly ContextNeed[] = ["META_GTM_ANALYSIS", "SALES_GTM_CONTEXT"];
export const isGtmNeed = (n: ContextNeed): boolean => GTM_NEEDS.includes(n);

/** Symbolic read-selection resource keys. Lane-qualified (PDEC-011); never a URL, page id, runtime id or identity. */
export const RESOURCE_KEYS = {
  META_SALES_RUNTIME_INPUTS: "META:SALES_RUNTIME_INPUTS",
  SALES_EXTERNAL_ACTIONS: "SALES:EXTERNAL_ACTIONS",
  SALES_GMAIL_RECONCILIATION: "SALES:GMAIL_RECONCILIATION",
  /** Candidate read-selection symbols (PV-GTM-002); offered only to a GTM-capable binding. */
  META_GTM_METRIC_REFS: "META:GTM_METRIC_REFS",
  SALES_GTM_CAMPAIGN_CONTEXT: "SALES:GTM_CAMPAIGN_CONTEXT",
} as const;
export type ResourceKey = (typeof RESOURCE_KEYS)[keyof typeof RESOURCE_KEYS];

/**
 * Need → selected optional resource keys. `CURRENT_WORK` selects none: the existing resume state already carries
 * the current safety/work context. Selection is a pure function of (lane, normalized needs); whether a selected
 * pointer currently has refs is DATA, never a change of selection.
 */
export const NEED_RESOURCES: Readonly<Record<ContextNeed, readonly ResourceKey[]>> = {
  CURRENT_WORK: [],
  META_SETUP_INPUTS: [RESOURCE_KEYS.META_SALES_RUNTIME_INPUTS],
  SALES_EXTERNAL_ACTION: [RESOURCE_KEYS.SALES_EXTERNAL_ACTIONS],
  SALES_EMAIL_RECONCILIATION: [RESOURCE_KEYS.SALES_EXTERNAL_ACTIONS, RESOURCE_KEYS.SALES_GMAIL_RECONCILIATION],
  // Content only: the SETUP context carries what this need is for, so no optional pointer is selected.
  SALES_SETUP_INPUTS: [],
  // The GTM analysis need selects the admitted bounded META pointers ONLY: the registered Sales-inputs pointer and
  // the explicitly registered GTM metric refs. There is no third META pointer and no read-all symbol.
  META_GTM_ANALYSIS: [RESOURCE_KEYS.META_SALES_RUNTIME_INPUTS, RESOURCE_KEYS.META_GTM_METRIC_REFS],
  SALES_GTM_CONTEXT: [RESOURCE_KEYS.SALES_GTM_CAMPAIGN_CONTEXT],
};

/**
 * The COMPLETE authorized optional resource set per lane, in canonical order. This is the fixed denominator
 * PT-CP-007 counts against (Q1 0/1 META, Q2 1/1 META, Q3 1/2 SALES, Q4 2/2 SALES) and the source of
 * `omitted_resource_keys` — which means "authorized optional keys NOT selected for native reading", never
 * "absent from the resume payload".
 */
export const LANE_OPTIONAL_RESOURCES: Readonly<Record<Lane, readonly ResourceKey[]>> = {
  META: [RESOURCE_KEYS.META_SALES_RUNTIME_INPUTS],
  SALES: [RESOURCE_KEYS.SALES_EXTERNAL_ACTIONS, RESOURCE_KEYS.SALES_GMAIL_RECONCILIATION],
};

/** The candidate additions to each lane's authorized optional set, in canonical order. */
const GTM_LANE_RESOURCES: Readonly<Record<Lane, readonly ResourceKey[]>> = {
  META: [RESOURCE_KEYS.META_GTM_METRIC_REFS],
  SALES: [RESOURCE_KEYS.SALES_GTM_CAMPAIGN_CONTEXT],
};

/**
 * The COMPLETE authorized optional set for this binding. Without the GTM capability it is byte-identical to
 * `LANE_OPTIONAL_RESOURCES`, so a non-GTM binding sees exactly the adopted pack.
 */
export function laneOptionalResources(lane: Lane, gtm: boolean): readonly ResourceKey[] {
  return gtm ? [...LANE_OPTIONAL_RESOURCES[lane], ...GTM_LANE_RESOURCES[lane]] : LANE_OPTIONAL_RESOURCES[lane];
}

/**
 * Needs this lane may select, canonical order. Requesting another lane's need never discloses that lane's catalog,
 * and a candidate need is listed only for a binding whose runtime declares the capability.
 */
export function allowedNeedsForLane(lane: Lane, gtm = false): readonly ContextNeed[] {
  return CONTEXT_NEEDS.filter((n) => (NEED_LANE[n] === "ANY" || NEED_LANE[n] === lane) && (gtm || !isGtmNeed(n)));
}

// ──────────────── selected_context — CONTRACT_PACK/0.3.0-candidate (D6 / D7, W2.1 framework) ────────────────

/**
 * The policy that carries the bounded CONTENT `selected_context` (S1). It is a CANDIDATE and is never adopted here.
 * `CANDIDATE_POLICY_VERSION` (0.2.0) keeps its exact meaning — the GTM pointer-only candidate — and 0.3 inherits it
 * unchanged: same resource keys, same availability, same telemetry projection, same pointer shape. Its only need
 * addition is `SALES_SETUP_INPUTS` (S2 amendment), which selects content and never a pointer.
 */
export const CONTEXT_POLICY_VERSION = "CONTRACT_PACK/0.3.2-candidate";

/** The three admitted read contexts, canonical order (D6). There is no fourth, ever. */
export const CONTEXT_KINDS = ["SETUP", "DAILY", "EXTERNAL_ACTION"] as const;
export type ContextKind = (typeof CONTEXT_KINDS)[number];

/**
 * Need → the context it selects (S2). GTM needs stay POINTER-ONLY (S3): they select no context, so a GTM-capable
 * binding gets the same pointers as under 0.2 and an empty content shape, never a fourth context.
 */
export const NEED_CONTEXT: Readonly<Record<ContextNeed, ContextKind | "NONE">> = {
  CURRENT_WORK: "DAILY",
  META_SETUP_INPUTS: "SETUP",
  SALES_EXTERNAL_ACTION: "EXTERNAL_ACTION",
  SALES_EMAIL_RECONCILIATION: "EXTERNAL_ACTION",
  SALES_SETUP_INPUTS: "SETUP",
  META_GTM_ANALYSIS: "NONE",
  SALES_GTM_CONTEXT: "NONE",
};

/**
 * The bounds (S4), declared here and nowhere else: at most `max_rows_per_section` rows per section, and at most
 * `max_serialized_bytes` bytes for the COMPLETE serialized `selected_context` — metadata included, not the rows
 * alone. The projector measures the real payload; it never estimates.
 */
export interface ContextBounds {
  readonly max_rows_per_section: number;
  readonly max_serialized_bytes: number;
}
export const CONTEXT_BOUNDS: ContextBounds = { max_rows_per_section: 10, max_serialized_bytes: 16384 };

/**
 * One section of a context. Both keys are SYMBOLS (S7): `section_key` names the section in the served payload,
 * `source_key` names the source the harness supplies rows under. No internal state path is ever declared here and
 * none is ever served — the payload cannot teach a caller to address internal state.
 *
 * `projected_keys` IS the contract: a key outside it is never read, never carried and never interpreted, which is
 * exactly why a column the seller added to their own space is harmless — it is tolerated by being ignored.
 */
export interface ContextSectionSpec {
  readonly section_key: string;
  readonly source_key: string;
  readonly projected_keys: readonly string[];
}

/** The SETUP source symbols (W2.2). Each section is served under the same symbol as its source. */
export const SETUP_SOURCE_KEYS = {
  POSITION: "SETUP_POSITION",
  PENDING_INPUT: "SETUP_PENDING_INPUT",
  RULES: "SETUP_RULES",
  ANSWERS: "SETUP_ANSWERS",
} as const;

/** The SETUP answer projection (W2.2), shared by the rules and the answers: one Business Configuration row each. */
const SETUP_ROW_KEYS = ["step_key", "config_item", "category", "state", "value", "version", "source"] as const;

/**
 * The DAILY source symbols (W2.3, Sales DAILY contract candidate), in the published order. One section per
 * independent source, served under the same symbol, so an absent source is never hidden behind a shared status.
 */
export const DAILY_SOURCE_KEYS = {
  NATIVE_REALITY: "DAILY_NATIVE_REALITY",
  HOLDS: "DAILY_HOLDS",
  BLOCKED_TASKS: "DAILY_BLOCKED_TASKS",
  P0_RULES: "DAILY_P0_RULES",
  ACTIVE_POLICIES: "DAILY_ACTIVE_POLICIES",
  RUNTIME_CONSTRAINTS: "DAILY_RUNTIME_CONSTRAINTS",
  RECENT_RECEIPTS: "DAILY_RECENT_RECEIPTS",
  UNPROCESSED_INTAKE: "DAILY_UNPROCESSED_INTAKE",
  DUE_TASKS: "DAILY_DUE_TASKS",
  TASK_ACCOUNTS: "DAILY_TASK_ACCOUNTS",
  TASK_CONTACTS: "DAILY_TASK_CONTACTS",
  ACTIVE_RULES: "DAILY_ACTIVE_RULES",
  ACTIVE_SEQUENCES: "DAILY_ACTIVE_SEQUENCES",
  /**
   * W3.4R (CONTRACT_PACK 0.3.1 candidate, NOT ADOPTED): the production health the OS itself declared in its single
   * `OS State/CURRENT` row, transported only when its DAILY_GO Run proves it — never calculated by the harness.
   */
  PRODUCTION_HEALTH: "DAILY_PRODUCTION_HEALTH",
} as const;

/** The Decision Rule projection, shared by P0 and the other active rules (which add `priority`). */
const DAILY_RULE_KEYS = ["rule_id", "rule", "trigger", "default_disposition", "required_authority", "required_gate", "stop_conditions", "action_contract"] as const;

const daily = (key: string, projected_keys: readonly string[]): ContextSectionSpec => ({ section_key: key, source_key: key, projected_keys });

/**
 * The EXTERNAL_ACTION source symbols (W2.4, Sales 0.5.10 candidate), in the published order. Each section is its own
 * source, so a section that cannot be proven is ABSENT without hiding the others.
 */
export const EXTERNAL_ACTION_SOURCE_KEYS = {
  INTENTS: "EXTERNAL_INTENTS",
  PARTIES: "EXTERNAL_PARTIES",
  AUTHORITY: "EXTERNAL_AUTHORITY",
  STOPS: "EXTERNAL_STOPS",
} as const;

/** A section served under the same symbol as its source. */
const external = daily;

/**
 * The projection table. SETUP is declared by W2.2, in this fixed order: the durable position, the pending input's
 * address, then the relevant confirmed constraints and answers. DAILY is declared by W2.3, in the published order:
 * the native sources to read first, then safety (holds, blocked work, P0, policies, constraints), recent reality,
 * the due work and what it touches, then the other rules and sequences. EXTERNAL_ACTION is declared by W2.4: the
 * unresolved intents, their explicitly referenced parties, the linked declarative authority rule, then its stops.
 * None of it is a permission to send. The projector holds no per-context knowledge of its own.
 */
export const CONTEXT_SECTIONS: Readonly<Record<ContextKind, readonly ContextSectionSpec[]>> = {
  SETUP: [
    { section_key: SETUP_SOURCE_KEYS.POSITION, source_key: SETUP_SOURCE_KEYS.POSITION, projected_keys: ["gate_key", "gate_status", "next_question", "next_safe_action"] },
    { section_key: SETUP_SOURCE_KEYS.PENDING_INPUT, source_key: SETUP_SOURCE_KEYS.PENDING_INPUT, projected_keys: ["gate_key", "logical_resource_key", "natural_key", "answer_field"] },
    { section_key: SETUP_SOURCE_KEYS.RULES, source_key: SETUP_SOURCE_KEYS.RULES, projected_keys: SETUP_ROW_KEYS },
    { section_key: SETUP_SOURCE_KEYS.ANSWERS, source_key: SETUP_SOURCE_KEYS.ANSWERS, projected_keys: SETUP_ROW_KEYS },
  ],
  DAILY: [
    daily(DAILY_SOURCE_KEYS.NATIVE_REALITY, ["source", "authority", "read_first"]),
    daily(DAILY_SOURCE_KEYS.HOLDS, ["code", "next_safe_action"]),
    daily(DAILY_SOURCE_KEYS.BLOCKED_TASKS, ["task_id", "task", "blocker", "due_date", "gate"]),
    daily(DAILY_SOURCE_KEYS.P0_RULES, DAILY_RULE_KEYS),
    daily(DAILY_SOURCE_KEYS.ACTIVE_POLICIES, ["policy_key", "version", "policy_text", "effective_at"]),
    daily(DAILY_SOURCE_KEYS.RUNTIME_CONSTRAINTS, ["config", "type", "declared_value", "pointer_resource_key", "pointer_natural_key", "pointer_value_field", "reread_value", "reread_status"]),
    daily(DAILY_SOURCE_KEYS.RECENT_RECEIPTS, ["receipt_id", "event_type", "event_timestamp", "task_id", "account_id", "contact_id"]),
    daily(DAILY_SOURCE_KEYS.UNPROCESSED_INTAKE, ["intake_id", "intake", "status", "received_at", "source_type", "human_required", "target"]),
    daily(DAILY_SOURCE_KEYS.DUE_TASKS, ["task_id", "task", "type", "status", "due_date", "authority", "gate", "expected_outcome", "account_id", "contact_id", "sequence_id"]),
    daily(DAILY_SOURCE_KEYS.TASK_ACCOUNTS, ["account_id", "company", "lifecycle", "qualification", "do_not_contact", "next_action_date", "open_gaps"]),
    daily(DAILY_SOURCE_KEYS.TASK_CONTACTS, ["contact_id", "contact", "buyer_role", "lifecycle", "do_not_contact", "email_status"]),
    daily(DAILY_SOURCE_KEYS.ACTIVE_RULES, [...DAILY_RULE_KEYS, "priority"]),
    daily(DAILY_SOURCE_KEYS.ACTIVE_SEQUENCES, ["sequence_id", "sequence", "audience", "trigger", "stop_conditions", "default_authority", "max_steps"]),
    // W3.4R: the 14th and last DAILY section, after the thirteen W2.3 sections, under the same rules S4–S8.
    daily(DAILY_SOURCE_KEYS.PRODUCTION_HEALTH, ["production_health", "daily_run_ref", "evaluated_at"]),
  ],
  EXTERNAL_ACTION: [
    external(EXTERNAL_ACTION_SOURCE_KEYS.INTENTS, ["action_key", "action_type", "effect_status", "approval_state", "recipient", "thread_context", "prepared_at"]),
    external(EXTERNAL_ACTION_SOURCE_KEYS.PARTIES, ["action_key", "account_id", "company", "account_do_not_contact", "contact_id", "contact", "contact_do_not_contact", "email_status"]),
    external(EXTERNAL_ACTION_SOURCE_KEYS.AUTHORITY, ["action_key", "rule_id", "declared_authority", "allowed_modes", "preconditions", "approval_state", "send_authority", "t0_recheck_required"]),
    external(EXTERNAL_ACTION_SOURCE_KEYS.STOPS, ["action_key", "stop_conditions", "account_do_not_contact", "contact_do_not_contact", "reconciliation_status", "competent_source"]),
  ],
};

/**
 * The complete content policy: version, admitted contexts, need mapping, projection table and bounds. It is the
 * object whose digest enters `pack_id` (S8), so no silent change of catalogue, projection or bound can keep a
 * pack identity unchanged.
 */
export interface ContextPolicy {
  readonly version: string;
  readonly kinds: readonly ContextKind[];
  readonly need_context: Readonly<Record<ContextNeed, ContextKind | "NONE">>;
  readonly sections: Readonly<Record<ContextKind, readonly ContextSectionSpec[]>>;
  readonly bounds: ContextBounds;
}

export const CONTEXT_POLICY: ContextPolicy = {
  version: CONTEXT_POLICY_VERSION,
  kinds: CONTEXT_KINDS,
  need_context: NEED_CONTEXT,
  sections: CONTEXT_SECTIONS,
  bounds: CONTEXT_BOUNDS,
};
