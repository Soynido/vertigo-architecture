import type { Lane } from "../tools/envelope.ts";

export type PlanState = "AWAITING_STAGE1_WRITES" | "TARGET_VERIFIED" | "AWAITING_FINAL_VERIFY" | "FINAL_VERIFIED" | "HOLD" | "EXPIRED" | "ABORTED" | "SUPERSEDED";
export type PlanKind = "BUSINESS" | "INSTALL_MAPPING" | "INSTALL_PROMOTION";
export type RunMode = "OPEN_NEW" | "RESUME_EXISTING" | "RECOVER_EXISTING";
/** Why the backend holds this plan (PV-WRITE-001, A.5). Absent on plans stored before it was recorded: INTENT. */
export type PlanOrigin = "INTENT" | "DERIVED_MOVE" | "AUTO_RECONCILE" | "AUTO_RECOVERY" | "INSTALL";

/**
 * PV-FW-001: a re-adoption is an UPDATE whose expected values ARE its before-image. It writes nothing; its
 * transaction re-examines the current values and issues a receipt for exactly them. The shape is the flag, so
 * no plan column is needed: an ordinary UPDATE always changes at least one compared field.
 */
export const isReadoption = (op: Pick<PlanOperation, "operation" | "before_hash" | "expected_hash">): boolean =>
  op.operation === "UPDATE" && op.before_hash !== undefined && op.before_hash === op.expected_hash;
export type Operation = "CREATE" | "UPDATE" | "UPSERT";

export interface PlanOperation {
  readonly operation_id: string;
  readonly ordinal: number;
  readonly logical_resource_key: string;
  readonly physical_target_ref?: string;
  readonly target_parent_ref?: string;
  readonly target_data_source_ref?: string;
  readonly natural_key?: string;
  /** Property that carries the natural key (needed to locate a CREATE result by readback). */
  readonly natural_key_property?: string;
  /** Its live Notion type, so the readback filter is one that property accepts. Absent on plans prepared before
   *  this was recorded: those fall back to an unfiltered query plus the same exact client-side match. */
  readonly natural_key_property_type?: string;
  readonly idempotency_key: string;
  readonly operation: Operation;
  readonly baseline_revision?: string;
  readonly compared_fields: readonly string[];
  readonly before_values: Readonly<Record<string, unknown>>;
  readonly expected_values: Readonly<Record<string, unknown>>;
  readonly before_hash?: string;
  readonly expected_hash?: string;
}

/** Exact native-Notion write instruction the model must execute verbatim. */
export interface WriteInstruction {
  readonly ordinal: number;
  /** Stable symbol for this write; later writes may reference the created object as `$created:<symbol>`. */
  readonly symbol: string;
  /** Physical target: a page id (UPDATE), a data source id (CREATE), or a `$created:<symbol>` reference. */
  readonly target_ref: string;
  readonly operation: Operation;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly purpose: "OPEN_RUN" | "RESUME_RUN" | "PREPARE_LEDGER" | "WRITE_TARGET" | "LEDGER_WRITTEN" | "LEDGER_VERIFIED" | "FINALIZE_RUN" | "TRANSACTIONAL_RECORD" | "STATE_LAST";
  readonly note?: string;
  /** Backend-captured revision for the first claim of a foreign Run. JSON metadata, never a caller baseline. */
  readonly baseline_revision?: string;
  readonly baseline_parent_ref?: string;
  /** Notion property type per field, captured from the live data-source schema at prepare time (renderer input). */
  readonly property_types?: Readonly<Record<string, string>>;
  /** Backend-captured native field identities, retained in the existing immutable instruction JSON. */
  readonly operation_property_ids?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** B7 derived move only: frozen dependency fingerprint, never caller-supplied permission. */
  readonly b7_graph_fingerprint?: string;
  /** Exact validated intent for a never-sent Sales continuation; backend JSON, never Notion fields. */
  readonly guard_mutations?: readonly import("./prepare.ts").IntentMutation[];
  /** Immutable first-link attestation in existing instruction JSON, not an independent OAuth proof. */
  readonly source_identity_enrollment?: {
    readonly protocol: "SOURCE_IDENTITY_ENROLLMENT/1"; readonly source: string; readonly identity: string;
    readonly evidence_ref: string; readonly observed_at: string; readonly confirmed_at: string;
    readonly confirmation: "ASSISTANT_ATTESTED_EXPLICIT_USER_REPLY"; readonly principal_id: string;
    /** Exact accepted confirmation, without retaining its token. Legacy plans cannot infer it. */
    readonly confirmation_challenge_sha256?: string;
  };
}

export interface Plan {
  readonly plan_id: string;
  readonly plan_kind: PlanKind;
  readonly principal_id: string;
  readonly binding_id: string;
  readonly project: string;
  readonly lane: Lane;
  readonly runtime_logical_key: string;
  readonly runtime_id: string;
  readonly runtime_generation: string;
  readonly governing_spec_version: string;
  readonly governing_schema_version: string;
  readonly governing_control_version: string;
  readonly run_mode: RunMode;
  readonly run_ref?: string;
  /** For RECOVER_EXISTING: the interrupted plan whose Run / ledger rows this plan continues (its id is the harness linkage id). */
  readonly recovers_plan_id?: string;
  readonly execution_attempt_id: string;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly baseline_runtime_revision: string;
  readonly operations: readonly PlanOperation[];
  readonly stage1_writes: readonly WriteInstruction[];
  readonly finalization_writes: readonly WriteInstruction[];
  readonly state_last_write: WriteInstruction;
  /**
   * INSTALL_PROMOTION only: the exact INSTALL_MAPPING plan and the exact FINAL receipt that proved the structural
   * mapping. Promotion is bound to THIS proof, never to "any" final mapping of the same runtime generation, so a
   * second mapping plan can never lend its verification to a promotion prepared against a different one.
   */
  readonly install_mapping_plan_id?: string;
  readonly install_mapping_final_receipt_id?: string;
  /**
   * INSTALL only: hash of every live authority input that may change the meaning of the install between PREPARE,
   * TARGET and FINAL (governing pins plus backend assignment identity).  It is deliberately persisted on the plan
   * instead of inferred from the binding generation because an assignment may change without moving the Notion
   * root or pointer generation.
   */
  readonly install_context_fingerprint?: string;
  /** PV-WRITE-001: why the backend holds this plan, and the plan that spawned it (a derived move, a recovery). */
  readonly plan_origin?: PlanOrigin;
  readonly parent_plan_id?: string;
  readonly plan_state: PlanState;
}

export interface PlanStore {
  insert(plan: Plan): Promise<void>;
  get(planId: string): Promise<Plan | undefined>;
  setState(planId: string, state: PlanState): Promise<void>;
  /** Non-terminal plans for one runtime generation (at most one is allowed to exist). */
  findActive(project: string, lane: Lane, runtimeGeneration: string): Promise<readonly Plan[]>;
  /** Every plan (any state) of one runtime generation — recovery looks for interrupted plans here. */
  listByRuntime(project: string, lane: Lane, runtimeGeneration: string): Promise<readonly Plan[]>;
  /**
   * Extends a live plan and its runtime lease to `until`, for the executor holding the plan's claim only
   * (PV-WRITE-001, A.4). False — and nothing changed — if the plan is terminal, the claim is another's or has
   * lapsed, or the lease is no longer this plan's.
   */
  renew(planId: string, claimToken: string, now: Date, until: Date): Promise<boolean>;
}

/**
 * One executor per plan (PV-WRITE-001, A.4). A claim is exclusive while live; only its holder (same token) can
 * extend it; a lapsed claim can be taken by anyone. Release is a no-op for anyone but the holder.
 */
export interface ClaimStore {
  claim(planId: string, token: string, now: Date, until: Date): Promise<boolean>;
  release(planId: string, token: string): Promise<void>;
}

/** Journal of the server's own writes, one row per plan instruction (PV-WRITE-001, A.5). */
export type PlanWriteStatus = "PENDING" | "SENT" | "DONE" | "OBSERVED" | "FAILED_FINAL";
export type PlanWritePhase = "STAGE1" | "FINALIZATION" | "STATE_LAST";

export interface PlanWriteSeed {
  readonly symbol: string;
  readonly phase: PlanWritePhase;
  readonly ordinal: number;
  readonly operation: "CREATE" | "UPDATE";
  readonly target_ref: string;
}

export interface PlanWriteRow extends PlanWriteSeed {
  readonly plan_id: string;
  readonly status: PlanWriteStatus;
  /** SHA-256 of the exact request, fixed at the first SENT: a resend must be byte-identical. */
  readonly payload_hash?: string;
  /** The `$now` stamped at the first SENT, reused by every resend. */
  readonly stamped_now?: string;
  readonly attempts: number;
  /** CREATE only: the page Notion created (DONE) or that readback located (OBSERVED). */
  readonly created_id?: string;
  readonly last_error?: string;
  readonly sent_at?: Date;
  readonly done_at?: Date;
}

export interface PlanWritePatch {
  readonly at: Date;
  readonly payload_hash?: string;
  readonly stamped_now?: string;
  readonly created_id?: string;
  readonly last_error?: string;
}

/**
 * PENDING → SENT → DONE | OBSERVED | FAILED_FINAL. SENT → SENT is a resend (attempts + 1, same payload). PENDING →
 * FAILED_FINAL is a write refused before it was ever sent. DONE, OBSERVED and FAILED_FINAL are final.
 */
const WRITE_TRANSITIONS: Readonly<Record<PlanWriteStatus, readonly PlanWriteStatus[]>> = {
  PENDING: ["SENT", "FAILED_FINAL"],
  SENT: ["SENT", "DONE", "OBSERVED", "FAILED_FINAL"],
  DONE: [],
  OBSERVED: [],
  FAILED_FINAL: [],
};

export function canTransitionWrite(from: PlanWriteStatus, to: PlanWriteStatus): boolean {
  return WRITE_TRANSITIONS[from].includes(to);
}

/**
 * Applies a journal transition to a row in memory, or explains why it cannot: the shared rule both stores use.
 * `undefined` = compare-and-set lost (the row is not in `from` any more); a thrown error = an illegal request.
 */
export function applyWriteTransition(row: PlanWriteRow, from: PlanWriteStatus, to: PlanWriteStatus, patch: PlanWritePatch): PlanWriteRow | undefined {
  if (!canTransitionWrite(from, to)) throw new Error(`plan write ${row.symbol}: ${from} → ${to} is not a journal transition`);
  if (row.status !== from) return undefined;
  if (to === "SENT") {
    if (!patch.payload_hash) throw new Error(`plan write ${row.symbol}: SENT requires the payload hash`);
    if (row.payload_hash && row.payload_hash !== patch.payload_hash) throw new Error(`plan write ${row.symbol}: a resend must carry the same payload as the first send`);
    if (row.stamped_now && patch.stamped_now && row.stamped_now !== patch.stamped_now) throw new Error(`plan write ${row.symbol}: a resend must reuse the first stamped $now`);
  }
  if ((to === "DONE" || to === "OBSERVED") && row.operation === "CREATE" && !patch.created_id && !row.created_id) throw new Error(`plan write ${row.symbol}: a CREATE is ${to} only with the created page id`);
  return {
    ...row,
    status: to,
    ...(to === "SENT" ? { attempts: row.attempts + 1, sent_at: patch.at, payload_hash: row.payload_hash ?? patch.payload_hash, ...(row.stamped_now ?? patch.stamped_now ? { stamped_now: (row.stamped_now ?? patch.stamped_now) as string } : {}) } : {}),
    ...(to === "DONE" || to === "OBSERVED" ? { done_at: patch.at } : {}),
    ...(patch.created_id ? { created_id: patch.created_id } : {}),
    ...(patch.last_error ? { last_error: patch.last_error } : {}),
  };
}

export interface PlanWriteStore {
  /** The plan's journal, in instruction order. */
  list(planId: string): Promise<readonly PlanWriteRow[]>;
  /** Inserts every seed not yet journaled as PENDING; never alters an existing row. Returns the whole journal. */
  ensure(planId: string, seeds: readonly PlanWriteSeed[]): Promise<readonly PlanWriteRow[]>;
  /** Compare-and-set: applied only if the row is still in `from`; `undefined` when another executor moved it first. */
  transition(planId: string, symbol: string, from: PlanWriteStatus, to: PlanWriteStatus, patch: PlanWritePatch): Promise<PlanWriteRow | undefined>;
}

/** The plan id written into Run / Mutation Ledger harness fields: the original plan for a recovery plan. */
export function linkageId(plan: Pick<Plan, "plan_id" | "recovers_plan_id">): string {
  return plan.recovers_plan_id ?? plan.plan_id;
}

const TRANSITIONS: Readonly<Record<PlanState, readonly PlanState[]>> = {
  AWAITING_STAGE1_WRITES: ["TARGET_VERIFIED", "HOLD", "EXPIRED", "ABORTED", "SUPERSEDED"],
  TARGET_VERIFIED: ["AWAITING_FINAL_VERIFY", "FINAL_VERIFIED", "HOLD", "EXPIRED", "ABORTED", "SUPERSEDED"],
  AWAITING_FINAL_VERIFY: ["FINAL_VERIFIED", "HOLD", "EXPIRED", "ABORTED", "SUPERSEDED"],
  FINAL_VERIFIED: [],
  HOLD: ["EXPIRED", "ABORTED", "SUPERSEDED"],
  EXPIRED: [],
  ABORTED: [],
  SUPERSEDED: [],
};

export function canTransition(from: PlanState, to: PlanState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(state: PlanState): boolean {
  return TRANSITIONS[state].length === 0;
}
