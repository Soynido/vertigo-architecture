/**
 * Deterministic derivation of resume state from a control-plane snapshot (spec 13, 14, 15, 20, 68).
 * No chat input, no inference: current Run selection, recovery classification, Manifest/Run
 * compatibility, gate freshness, effective hold and exact next safe action.
 */
import { CANDIDATE_POLICY_VERSION } from "../contractPack/catalog.ts";
import type { HoldCode } from "../errors/codes.ts";
import type { ControlPlaneSnapshot, CursorRow, DerivedInputsRow, ExternalActionIntent, GateRow, LedgerRow, RunRow, Text } from "./snapshot.ts";
import type { CapabilityCompleteness } from "./capabilities.ts";
import { admitted, cursorBlockers, manifestBlockers } from "./admission.ts";

export interface CurrentRunView {
  readonly run_id: Text;
  readonly ref: string;
  readonly status: Text;
  readonly attempt_count: number | "UNKNOWN";
  readonly version_pins: RunRow["pins"];
  readonly last_required_written_at: Text;
  /** NOT_APPLICABLE once the Run is terminal (the durable field then only records the action that closed it). */
  readonly next_action: Text;
  /** The durable Next Action text of a terminal Run, kept for audit; absent while the Run is open. */
  readonly last_action?: Text;
  readonly holds: Text;
  readonly recovery_reason: string | "NONE";
  /** Backend plan identity durably written by the harness; UNKNOWN for non-plugin work. */
  readonly harness_plan_id: Text;
}

/** An incomplete Run superseded by a later durable reconciliation: kept for audit, never recovery. */
export interface HistoricalHold {
  readonly label: Text;
  readonly ref: string;
  readonly status: Text;
  readonly last_required_written_at: Text;
  readonly superseded_by: Text;
  readonly version_pins: RunRow["pins"];
}

export interface HistoricalMutation { readonly label: Text; readonly ref: string; readonly status: Text; readonly last_edited: Text; readonly superseded_by: Text }

export interface GateView {
  readonly gate_key: Text;
  readonly status: Text;
  readonly control_confirmation_state: Text;
  readonly metadata_stale: boolean | "NOT_APPLICABLE";
  readonly gate_last_edited_at: Text;
  readonly formal_blocker: Text;
  readonly formal_next_action: Text;
  readonly formal_next_question: Text;
  readonly source: "GATE_ROW" | "CURSOR";
}

export interface ResumeState {
  /** Candidate only: completions proved in this call, never a cached inventory of closed work. */
  readonly ledger_completed?: readonly { readonly plan_id: string; readonly final_receipt_id: string }[];
  /** Derived only from a completed harness Run not yet adopted by the cursor; the HOLD remains. */
  readonly pending_state_last_plan_id?: string;
  /** Candidate only: a real bounded executor result, not permission, a background job or completion. */
  readonly ledger_continuation?: {
    readonly protocol: "LEDGER_CONTINUATION/1";
    readonly plan_id: string;
    readonly phase: "STAGE1" | "TARGET" | "FINALIZATION" | "STATE_LAST";
    readonly reason: "BUDGET" | "INDEX_LAG";
    readonly writes_done: number;
    readonly writes_total: number;
    readonly purpose?: "CAPABILITY_PROOF";
  };
  readonly runtime_state: Text;
  readonly persistence_health: Text;
  readonly health: Text;
  readonly recovery_required: boolean;
  readonly recovery_reasons: readonly string[];
  /** Address of the sole pending native read/capture remediation, never authority to bypass any check. */
  readonly native_capture_pending_ref?: string;
  readonly current_run: CurrentRunView | "NOT_FOUND" | "NOT_YET_CREATED";
  readonly mutations: { readonly incomplete_count: number; readonly incomplete_refs: readonly string[]; readonly last_verified_ref: Text };
  readonly gate: GateView;
  readonly effective_hold: { readonly code: HoldCode; readonly evidence: readonly string[] } | "NONE";
  readonly next_safe_action: string;
  /** Candidate shared predicate found a declared answer; not permission or proof of a cursor movement. */
  readonly setup_input_satisfied?: true;
  /** PV-FW-001: proved rows whose governed content changed outside any transaction (names and fields, never values). */
  readonly foreign_writes?: readonly import("./foreignWrites.ts").ForeignWrite[];
  /** PV-FW-001: what the foreign-write check actually covered. Unknown is reported, never counted as verified. */
  readonly coverage?: import("./foreignWrites.ts").Coverage;
  /** PV-FW-001 / PV-ORPHAN-001: the confirmation a changed or unrecorded row is owed, with the call that records it already filled. */
  readonly pending_confirmation?: import("./foreignWrites.ts").PendingConfirmation | import("./orphanRows.ts").OrphanConfirmation;
  /** PV-ORPHAN-001: evidence rows of the walk present in Notion that no receipt of this runtime covers. */
  readonly orphan_rows?: readonly import("./orphanRows.ts").OrphanRow[];
  /** PV-ORPHAN-001: the cursor, edited since the last FINAL of this runtime with nothing in flight. */
  readonly cursor_drift?: import("./orphanRows.ts").CursorDrift;
  /** SALES candidate only: complete comparison of governing REQUIRED/OPTIONAL capabilities to competent-source proofs. */
  readonly capability_completeness?: CapabilityCompleteness;
  readonly external_intents_unresolved: number | "NOT_APPLICABLE" | "UNKNOWN";
  /** Durable external-effect recovery state: unresolved intents (routing metadata only) and whether competent-source (Gmail) reconciliation is required before any replay. */
  readonly external_actions: { readonly unresolved: readonly ExternalActionIntent[]; readonly reconciliation_required: boolean; readonly competent_source: "GMAIL" | "NOT_APPLICABLE" };
  /** Superseded incomplete Runs (PV0-020C): reported, never selected. */
  readonly historical_holds: readonly HistoricalHold[];
  /** Superseded non-VERIFIED mutations (PV0-020C): reported, never recovery. */
  readonly historical_mutations: readonly HistoricalMutation[];
  /**
   * The record the governing contract fixes for the answer THIS durable step is waiting for, when it declares
   * one. Served so the answer is written where the step's own completion predicate reads it, instead of under a
   * key the caller invents — which the engine refuses, and which would in any case never move the step.
   */
  readonly pending_step_input?: import("./pendingInput.ts").PendingStepInput;
  /** META only: the registered META_SALES_RUNTIME_INPUTS resource the Skill may read with native Notion. */
  readonly meta_inputs: DerivedInputsRow | "NOT_FOUND" | "NOT_APPLICABLE";
  /**
   * META only, CANDIDATE: the registered GTM measurement resource, present ONLY when its registration explicitly
   * pins the candidate Contract Pack version. On every adopted runtime the field is absent and the payload is
   * byte-identical to the adopted one: a registry row never adopts a policy by itself (PV-GTM-002).
   */
  readonly meta_gtm_metrics?: DerivedInputsRow;
  readonly cursor_ref: string;
  readonly cursor_last_edited: Text;
}

export type Derived = { readonly kind: "STATE"; readonly state: ResumeState } | { readonly kind: "HOLD"; readonly code: "HOLD_RUN_AMBIGUOUS" | "HOLD_STATE_DIVERGENCE"; readonly evidence: readonly string[]; readonly partial: Partial<ResumeState> };

/**
 * A GTM registration is only exposed once it PINS the candidate policy version: registering a resource is not
 * adopting a policy, and an unpinned row leaves the adopted payload exactly as it was.
 */
function pinnedGtmRegistration(row: DerivedInputsRow | "NOT_FOUND" | undefined): boolean {
  return row !== undefined && row !== "NOT_FOUND" && row.schema_version === CANDIDATE_POLICY_VERSION && row.status === "RESOLVED";
}

function newer(a: Text, b: Text): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a === "UNKNOWN" || b === "UNKNOWN") return false;
  return Date.parse(a) > Date.parse(b);
}

const runMark = (r: RunRow): Text => (typeof r.last_required_written_at === "string" && r.last_required_written_at !== "UNKNOWN" ? r.last_required_written_at : r.last_edited);
const textRefers = (text: Text, label: Text): boolean => { const id = typeof label === "string" ? label.split(" | ")[0]?.trim() : undefined; return typeof text === "string" && text !== "UNKNOWN" && !!id && text.startsWith(id); };
const compactRef = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const textPointsAt = (text: Text, row: { readonly ref: string; readonly label: Text }): boolean => {
  if (typeof text !== "string" || text === "UNKNOWN") return false;
  const ref = compactRef(row.ref);
  return (ref.length >= 16 && compactRef(text).includes(ref)) || textRefers(text, row.label);
};
const cursorPointsAtRun = (cursor: CursorRow, row: RunRow): boolean => cursor.last_run_ref_ids.includes(row.ref) || textPointsAt(cursor.last_run_ref_text, row);

/**
 * Historical HOLD supersession (PV0-020C): an incomplete Run that predates a healthy cursor's watermark, while the
 * cursor references a later COMPLETED Run, was superseded by that later reconciliation. It stays in the journal with
 * its pins (auditability) but is not recovery-required and not divergence.
 */
export function splitHistoricalHolds(snap: ControlPlaneSnapshot): { readonly active: RunRow[]; readonly historical: HistoricalHold[] } {
  const cursor: CursorRow = snap.state ?? snap.manifest;
  const manifest = snap.manifest;
  const latest = snap.latest_run;
  const healthy = admitted(cursor, manifest);
  const latestReferenced = !!latest && latest.status === "COMPLETED" && (cursorPointsAtRun(cursor, latest) || cursorPointsAtRun(manifest, latest));
  const active: RunRow[] = [];
  const historical: HistoricalHold[] = [];
  for (const r of snap.incomplete_runs) {
    const mark = runMark(r);
    const superseded = healthy && latestReferenced && latest !== undefined && r.ref !== latest.ref && newer(cursor.last_required_written_at, mark) && newer(runMark(latest), mark);
    if (superseded) historical.push({ label: r.label, ref: r.ref, status: r.status, last_required_written_at: mark, superseded_by: (latest as RunRow).label, version_pins: r.pins });
    else active.push(r);
  }
  return { active, historical };
}

const mutationNumber = (label: Text): number | undefined => { const m = typeof label === "string" ? /^[A-Z]+-(\d+)/.exec(label) : null; return m ? Number(m[1]) : undefined; };

/**
 * Historical mutation supersession (PV0-020C, same principle as the Runs): a FAILED ledger row that predates a healthy
 * cursor's watermark, while the cursor's Last Verified Mutation is a later mutation, was superseded by a later verified
 * recovery. Kept for audit, reported, never recovery. PREPARED / WRITTEN rows are unfinished writes whose fate is
 * unknown: they always stay recovery, whatever their age. A newer FAILED row still is recovery.
 */
export function splitHistoricalMutations(snap: ControlPlaneSnapshot): { readonly active: LedgerRow[]; readonly historical: HistoricalMutation[] } {
  const cursor: CursorRow = snap.state ?? snap.manifest;
  const manifest = snap.manifest;
  const healthy = admitted(cursor, manifest);
  const lastVerified = cursor.last_verified_mutation !== "UNKNOWN" ? cursor.last_verified_mutation : manifest.last_verified_mutation;
  const lastVerifiedNo = mutationNumber(lastVerified);
  const hasVerifiedPointer = typeof lastVerified === "string" && lastVerified !== "UNKNOWN" && lastVerified !== "NONE" && lastVerified.trim().length > 0;
  const active: LedgerRow[] = [];
  const historical: HistoricalMutation[] = [];
  for (const l of snap.incomplete_ledger) {
    const no = mutationNumber(l.label);
    // Native Notion writes persist canonical page ids as scalar rich text. In that shape there is no mutation number
    // to compare, so the healthy state-last watermark is the ordering proof. Never classify the row as history when
    // the verified pointer itself points at that FAILED row; PREPARED/WRITTEN remain recovery unconditionally.
    const sequenceAllowsSupersession = lastVerifiedNo !== undefined && no !== undefined ? no < lastVerifiedNo : true;
    const verifiedPointerIsDifferent = !textPointsAt(lastVerified, l);
    const superseded = l.status === "FAILED" && healthy && hasVerifiedPointer && verifiedPointerIsDifferent && sequenceAllowsSupersession && newer(cursor.last_required_written_at, l.last_edited);
    if (superseded) historical.push({ label: l.label, ref: l.ref, status: l.status, last_edited: l.last_edited, superseded_by: lastVerified });
    else active.push(l);
  }
  return { active, historical };
}

export function deriveResumeState(snap: ControlPlaneSnapshot, nativeCaptureIntentRef?: string): Derived {
  const cursor: CursorRow = snap.state ?? snap.manifest;
  const manifest = snap.manifest;
  const { active: incompleteRuns, historical: historical_holds } = splitHistoricalHolds(snap);
  const { active: incompleteLedger, historical: historical_mutations } = splitHistoricalMutations(snap);

  // 1. Current / incomplete Run selection (spec 13).
  let selected: RunRow | undefined;
  const recoveryReasons: string[] = [];
  if (incompleteRuns.length === 1) selected = incompleteRuns[0];
  else if (incompleteRuns.length > 1) {
    const referenced = incompleteRuns.filter((r) => cursorPointsAtRun(cursor, r) || cursorPointsAtRun(manifest, r));
    if (referenced.length === 1) selected = referenced[0];
    else {
      return { kind: "HOLD", code: "HOLD_RUN_AMBIGUOUS", evidence: [`${incompleteRuns.length} incomplete Runs and no deterministic precedence: ${incompleteRuns.map((r) => `${r.label} (${r.status})`).join("; ")}`], partial: { cursor_ref: cursor.ref, cursor_last_edited: cursor.last_edited, runtime_state: cursor.runtime_state, persistence_health: cursor.persistence_health, health: manifest.health, recovery_required: true, mutations: { incomplete_count: snap.incomplete_ledger.length, incomplete_refs: snap.incomplete_ledger.map((l) => l.ref), last_verified_ref: cursor.last_verified_mutation }, external_intents_unresolved: snap.external_intents_unresolved, historical_holds } };
    }
  }
  if (selected) {
    recoveryReasons.push(`run ${selected.label} is ${selected.status}${selected.recovery_required === true ? " with Recovery Required" : ""}; RUNNING/HOLD from another execution is not liveness proof${selected.harness_plan_id !== "UNKNOWN" ? ` (plugin transaction, harness plan ${selected.harness_plan_id})` : ""}`);
  }
  if (incompleteLedger.length > 0) recoveryReasons.push(`${incompleteLedger.length} Mutation Ledger row(s) not VERIFIED: ${incompleteLedger.map((l) => `${l.label} (${l.status})`).join("; ")}`);
  // ADMISSION-SALES-001: the progression row and the Manifest are a conjunction. When OS State is the cursor, the
  // Manifest's own blockers (Recovery Required, persistence HOLD*, Health Status other than HEALTHY) still block;
  // before this the Manifest was consulted only as a fallback cursor, and a runtime it declared unfit was admitted.
  if (snap.state) recoveryReasons.push(...cursorBlockers(cursor, "OS State"), ...manifestBlockers(manifest));
  else recoveryReasons.push(...cursorBlockers(manifest, "Manifest"), ...manifestBlockers(manifest).filter((r) => r.includes("Health Status")));
  // An internal, factory-owned capture may reconcile only its own sole pending intent. The caller of this
  // derivation validates object provenance and fresh identity; counts and routing facts remain honest.
  const pendingExternal = snap.external_intents.filter((row) => !row.native_reconciliation);
  const capturingOwnIntent = snap.external_intents_unresolved === 1 && pendingExternal.length === 1
    && nativeCaptureIntentRef !== undefined && pendingExternal[0]?.ref === nativeCaptureIntentRef;
  if (!capturingOwnIntent && typeof snap.external_intents_unresolved === "number" && snap.external_intents_unresolved > 0) recoveryReasons.push(`${snap.external_intents_unresolved} unresolved external-action intent(s); competent-source reconciliation required before replay`);
  const recovery_required = recoveryReasons.length > 0;

  // 2. Manifest ↔ Run compatibility (spec 14): an incomplete Run the cursor neither references nor flags is divergence.
  let divergence: string[] | undefined;
  let pendingStateLastPlanId: string | undefined;
  if (selected) {
    const referenced = cursorPointsAtRun(cursor, selected) || cursorPointsAtRun(manifest, selected);
    const flagged = cursor.recovery_required === true || manifest.recovery_required === true || (typeof cursor.persistence_health === "string" && cursor.persistence_health.startsWith("HOLD"));
    // A plugin-owned Run (carrying a harness plan id) is unreferenced BY PROTOCOL until its state-last write: that is
    // recovery-pending work, not divergence. Divergence is reserved for incomplete runs the harness cannot attribute.
    if (!referenced && !flagged && selected.harness_plan_id === "UNKNOWN") {
      divergence = [`incomplete run ${selected.label} (${selected.status}) is neither referenced by the ${snap.state ? "OS State/Manifest" : "Manifest"} (last run ref ${cursor.last_run_ref_text}) nor flagged by Recovery Required`, "do not guess which record is current; reconcile durable evidence"];
    }
  }

  // 2b. A COMPLETED Run newer than the cursor that the cursor never adopted: finalization reached the journal but
  //     not the State/Manifest (crash before state-last, or state-last lost). Stale state is divergence, not health.
  if (!divergence && !selected && snap.latest_run && snap.latest_run.status === "COMPLETED") {
    const lr = snap.latest_run;
    const adopted = cursorPointsAtRun(cursor, lr) || cursorPointsAtRun(manifest, lr);
    const cursorMark = cursor.last_required_written_at !== "UNKNOWN" ? cursor.last_required_written_at : cursor.last_verified_at;
    if (!adopted && newer(lr.last_required_written_at, cursorMark)) {
      divergence = [`completed run ${lr.label} (required writes at ${lr.last_required_written_at}) is newer than the ${snap.state ? "OS State" : "Manifest"} watermark (${cursorMark}) and is not referenced by it: the state-last write is missing`, "reconcile: adopt that Run in the cursor (state-last) and finish its verification, or mark it superseded; no new work until then"];
      selected = lr;
      if (lr.harness_plan_id !== "UNKNOWN") pendingStateLastPlanId = lr.harness_plan_id;
    }
  }

  // 3. Current run view.
  const runSource = selected ?? (snap.referenced_run && snap.referenced_run !== "NOT_FOUND" ? snap.referenced_run : undefined);
  const current_run: ResumeState["current_run"] = runSource
    ? { run_id: runSource.label, ref: runSource.ref, status: runSource.status, attempt_count: runSource.attempt_count, version_pins: runSource.pins, last_required_written_at: runSource.last_required_written_at, ...(runSource.status === "COMPLETED" ? { next_action: "NOT_APPLICABLE" as const, last_action: runSource.next_action } : { next_action: runSource.next_action }), holds: runSource.holds, recovery_reason: selected ? (recoveryReasons[0] ?? "NONE") : "NONE", harness_plan_id: runSource.harness_plan_id }
    : snap.referenced_run === "NOT_FOUND" ? "NOT_FOUND" : cursor.last_run_ref_ids.length === 0 && cursor.last_run_ref_text === "UNKNOWN" ? "NOT_YET_CREATED" : "NOT_FOUND";

  // 4. Gate view + freshness (spec 15 / 68).
  let gate: GateView;
  if (snap.gate && snap.gate !== "NOT_FOUND") {
    const g: GateRow = snap.gate;
    const newestActivity = [cursor.last_edited, selected?.last_edited ?? "UNKNOWN"].filter((t): t is string => typeof t === "string" && t !== "UNKNOWN").sort().at(-1) ?? "UNKNOWN";
    const cursorHasNewerWork = newer(newestActivity, g.last_edited);
    const absent = (t: string) => t === "UNKNOWN" || t === "NONE";
    const differs = (!absent(cursor.open_blocker) && cursor.open_blocker !== g.open_blocker) || (cursor.next_action !== "UNKNOWN" && cursor.next_action !== g.next_action) || (selected !== undefined && selected.next_action !== "UNKNOWN" && selected.next_action !== g.next_action);
    gate = { gate_key: g.key, status: g.status, control_confirmation_state: g.control_confirmation_state, metadata_stale: cursorHasNewerWork && differs, gate_last_edited_at: g.last_edited, formal_blocker: g.open_blocker, formal_next_action: g.next_action, formal_next_question: g.next_question, source: "GATE_ROW" };
  } else {
    gate = { gate_key: cursor.current_gate, status: cursor.current_gate_status, control_confirmation_state: "UNKNOWN", metadata_stale: "NOT_APPLICABLE", gate_last_edited_at: cursor.last_edited, formal_blocker: cursor.open_blocker, formal_next_action: cursor.next_action, formal_next_question: cursor.next_question, source: "CURSOR" };
  }

  // 5. Effective hold and next safe action: recovery > cursor blocker > run holds > fresh gate blocker.
  let effective_hold: ResumeState["effective_hold"] = "NONE";
  let next_safe_action: string;
  if (divergence && selected) {
    effective_hold = { code: "HOLD_STATE_DIVERGENCE", evidence: divergence };
    next_safe_action = `reconcile run ${selected.label} (${selected.status}) against the ${snap.state ? "OS State/Manifest" : "Manifest"}: close, supersede or reference it durably, then resume again; no new work until reconciled`;
  } else if (recovery_required) {
    effective_hold = { code: "HOLD_RECOVERY_REQUIRED", evidence: recoveryReasons };
    next_safe_action = selected
      ? `recover run ${selected.label} before any new work${selected.next_action !== "UNKNOWN" ? `: ${selected.next_action}` : ""}`
      : `reconcile incomplete durable work before any new work: ${recoveryReasons.join("; ")}`;
  } else if (cursor.open_blocker !== "UNKNOWN" && cursor.open_blocker !== "NONE") {
    effective_hold = { code: "HOLD_UNKNOWN_REQUIRED_FACT", evidence: [`open blocker: ${cursor.open_blocker}`] };
    next_safe_action = cursor.next_action !== "UNKNOWN" ? cursor.next_action : `resolve open blocker: ${cursor.open_blocker}`;
  } else if (gate.source === "GATE_ROW" && gate.metadata_stale === false && gate.formal_blocker !== "UNKNOWN" && gate.formal_blocker !== "NONE") {
    effective_hold = { code: "HOLD_UNKNOWN_REQUIRED_FACT", evidence: [`gate ${gate.gate_key} blocker: ${gate.formal_blocker}`] };
    next_safe_action = gate.formal_next_action !== "UNKNOWN" ? gate.formal_next_action : cursor.next_action !== "UNKNOWN" ? cursor.next_action : "UNKNOWN";
  } else {
    next_safe_action = cursor.next_action !== "UNKNOWN" ? cursor.next_action : gate.formal_next_action !== "UNKNOWN" ? gate.formal_next_action : "UNKNOWN";
  }

  const state: ResumeState = {
    ...(pendingStateLastPlanId ? { pending_state_last_plan_id: pendingStateLastPlanId } : {}),
    runtime_state: cursor.runtime_state !== "UNKNOWN" ? cursor.runtime_state : manifest.runtime_state,
    persistence_health: cursor.persistence_health !== "UNKNOWN" ? cursor.persistence_health : manifest.persistence_health,
    health: manifest.health,
    recovery_required,
    recovery_reasons: recoveryReasons,
    current_run,
    mutations: { incomplete_count: incompleteLedger.length, incomplete_refs: incompleteLedger.map((l) => l.ref), last_verified_ref: cursor.last_verified_mutation !== "UNKNOWN" ? cursor.last_verified_mutation : manifest.last_verified_mutation },
    gate,
    effective_hold,
    next_safe_action,
    external_intents_unresolved: snap.external_intents_unresolved,
    ...(!divergence && recoveryReasons.length === 1 && snap.external_intents_unresolved === 1
      && pendingExternal.length === 1 && pendingExternal[0]?.action_type === "GMAIL_SEND"
      && (cursor.open_blocker === "NONE" || cursor.open_blocker === "UNKNOWN")
      && (gate.formal_blocker === "NONE" || gate.formal_blocker === "UNKNOWN")
      ? { native_capture_pending_ref: pendingExternal[0].ref } : {}),
    historical_holds,
    historical_mutations,
    meta_inputs: snap.derived_inputs === undefined ? "NOT_APPLICABLE" : snap.derived_inputs,
    ...(pinnedGtmRegistration(snap.gtm_metrics) ? { meta_gtm_metrics: snap.gtm_metrics as DerivedInputsRow } : {}),
    external_actions: { unresolved: snap.external_intents, reconciliation_required: pendingExternal.length > 0 || snap.external_intents_unresolved === "UNKNOWN", competent_source: snap.external_intents_unresolved === "NOT_APPLICABLE" ? "NOT_APPLICABLE" : "GMAIL" },
    cursor_ref: cursor.ref,
    cursor_last_edited: cursor.last_edited,
  };
  if (divergence) return { kind: "HOLD", code: "HOLD_STATE_DIVERGENCE", evidence: divergence, partial: state };
  return { kind: "STATE", state };
}
