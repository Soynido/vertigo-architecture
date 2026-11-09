/** Normalized read of a runtime's control plane. Every field that could not be read is UNKNOWN. */
import type { Epistemic } from "../tools/envelope.ts";

export type Text = string | Epistemic;

export interface RunRow {
  readonly ref: string;
  readonly label: Text;
  readonly status: Text;
  readonly recovery_required: boolean | "UNKNOWN";
  readonly last_edited: Text;
  readonly next_action: Text;
  readonly holds: Text;
  readonly last_required_written_at: Text;
  readonly mutation_count: number | "UNKNOWN";
  readonly verified_mutation_count: number | "UNKNOWN";
  readonly attempt_count: number | "UNKNOWN";
  readonly pins: { readonly spec: Text; readonly schema: Text; readonly control: Text };
  readonly gate_before: Text;
  readonly gate_after_expected: Text;
  readonly gate_after_observed: Text;
  readonly origin: Text;
  /** Harness plan id carried by the Run (plugin-owned transactions); UNKNOWN for runs the harness cannot attribute. */
  readonly harness_plan_id: Text;
}

export interface LedgerRow {
  readonly ref: string;
  readonly label: Text;
  readonly status: Text;
  readonly run_ref_text: Text;
  readonly last_edited: Text;
}

export interface GateRow {
  readonly ref: string;
  readonly key: Text;
  readonly status: Text;
  readonly open_blocker: Text;
  readonly next_action: Text;
  readonly next_question: Text;
  readonly last_edited: Text;
  readonly last_required_written_at: Text;
  readonly control_confirmation_state: Text;
  readonly passed_by_run_ref: Text;
  readonly passed_by_run_ids: readonly string[];
  readonly confirmed_by_control_check_ref: Text;
}

/** A registered derived resource (META Resource Registry row), e.g. META_SALES_RUNTIME_INPUTS. Read-only pointer. */
export interface DerivedInputsRow {
  readonly ref: string;
  readonly resource_key: string;
  readonly url: Text;
  readonly status: Text;
  readonly scope: Text;
  readonly schema_version: Text;
  readonly last_verified: Text;
  readonly notes: Text;
}

export interface ControlCheckRow {
  readonly ref: string;
  readonly check_id: Text;
  readonly control_version: Text;
  readonly checked_at: Text;
  readonly result: Text;
  readonly scope: Text;
  readonly artifact_hash: Text;
  readonly mirror_integrity: Text;
  readonly last_edited: Text;
}

export interface CursorRow {
  readonly ref: string;
  readonly runtime_state: Text;
  readonly health: Text;
  readonly persistence_health: Text;
  readonly recovery_required: boolean | "UNKNOWN";
  readonly current_gate: Text;
  readonly current_gate_status: Text;
  readonly current_setup_gate: Text;
  readonly current_setup_gate_status: Text;
  readonly open_blocker: Text;
  readonly next_action: Text;
  readonly next_question: Text;
  readonly last_run_ref_ids: readonly string[];
  readonly last_run_ref_text: Text;
  readonly last_verified_mutation: Text;
  readonly last_required_written_at: Text;
  readonly last_verified_at: Text;
  readonly last_edited: Text;
  /** Explicit modes recorded by the runtime cursor. Contract-default modes are added separately by the adapter. */
  readonly operating_modes: Text;
}

export interface CapabilityProofRow {
  readonly ref: string;
  readonly proof_key: Text;
  readonly capability_key: Text;
  readonly state: Text;
  readonly runtime_id: Text;
  readonly principal_key: Text;
  readonly operating_mode: Text;
  readonly competent_source: Text;
  readonly evidence_ref: Text;
  readonly verified_at: Text;
  readonly scope: Text;
  readonly last_edited: Text;
}

/** One unresolved ExternalActionIntent reconstructed from the durable External Actions record (routing metadata only). */
export interface ExternalActionIntent {
  readonly ref: string;
  readonly action_key: Text;
  readonly record_type: Text;
  readonly effect_status: Text;
  readonly approval_state: Text;
  readonly action_type: Text;
  readonly recipient: Text;
  readonly subject: Text;
  readonly thread_ref: Text;
  readonly effect_ref: Text;
  readonly prepared_at: Text;
  readonly last_edited: Text;
  /** What the EXTERNAL_ACTION context (W2.4) needs beyond routing: read facts only, never a routing or send input. */
  readonly context_facts?: ExternalActionContextFacts;
  /** Read-only terminal bookkeeping, never competent-source proof of a Gmail effect. */
  readonly native_reconciliation?: NativeReconciliation;
}

export interface NativeReconciliation {
  readonly status: "ATTESTED_SENT";
  readonly provenance: "SOURCE_ATTESTED_BY_NATIVE_READ";
  readonly verified: false;
  readonly receipt_ref: string;
  readonly interaction_ref: string;
  readonly event_key: string;
}

/**
 * The facts of one intent the bounded EXTERNAL_ACTION context reads. A free text is `""` when its property was read
 * empty and UNKNOWN when it could not be read, so an established absence is never confused with an unreadable one.
 */
export interface ExternalActionContextFacts {
  readonly recipient: Text;
  readonly thread_context: Text;
  /** The account and contact page UUIDs the intent names, as stored text. */
  readonly account_ref: Text;
  readonly contact_ref: Text;
  /** Every page id of the `Authority Ref` relation, or UNKNOWN when it is not a fully listed relation. */
  readonly authority_refs: readonly string[] | "UNKNOWN";
}

export interface ControlPlaneSnapshot {
  readonly manifest: CursorRow;
  /** SALES OS State; META has no separate state row. */
  readonly state?: CursorRow;
  readonly incomplete_runs: readonly RunRow[];
  /** The Run the cursor points at, when readable. */
  readonly referenced_run?: RunRow | "NOT_FOUND";
  /** Most recently edited Run of the runtime (any status), for state-staleness detection. */
  readonly latest_run?: RunRow;
  readonly incomplete_ledger: readonly LedgerRow[];
  readonly gate?: GateRow | "NOT_FOUND";
  /** Control Check mirrors (META); "NOT_FOUND" when the grammar names the database but it is absent. */
  readonly control_checks?: readonly ControlCheckRow[] | "NOT_FOUND";
  /** Registered derived inputs resource: row, "NOT_FOUND" (registry present, no such key) or absent when the grammar has no registry. */
  readonly derived_inputs?: DerivedInputsRow | "NOT_FOUND";
  /** Registered GTM measurement resource (candidate): row, "NOT_FOUND", or absent when the grammar names none. */
  readonly gtm_metrics?: DerivedInputsRow | "NOT_FOUND";
  /** Raw discovery flags for scope reporting. */
  readonly sources: { readonly runs: boolean; readonly ledger: boolean; readonly gates: boolean; readonly control_checks: boolean; readonly state: boolean };
  readonly external_intents_unresolved: number | "NOT_APPLICABLE" | "UNKNOWN";
  /** The unresolved intents themselves (SALES); empty for META. */
  readonly external_intents: readonly ExternalActionIntent[];
  /** Append-only competent-source proofs. Absent means this contract line declares no profile journal. */
  readonly capability_proofs?: readonly CapabilityProofRow[] | "NOT_FOUND";
  readonly warnings: readonly string[];
}
