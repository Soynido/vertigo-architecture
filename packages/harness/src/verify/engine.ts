import type { Plan } from "../plans/store.ts";
import type { HoldCode } from "../errors/codes.ts";

export type VerifyPhase = "TARGET" | "FINAL";

export interface ReceiptRecord {
  readonly receipt_id: string;
  readonly type: VerifyPhase;
  readonly plan_id: string;
  readonly principal_id: string;
  readonly runtime_id: string;
  readonly runtime_generation: string;
  readonly run_ref?: string;
  readonly target_receipt_id?: string;
  readonly observed_at: Date;
  readonly observations: Readonly<Record<string, unknown>>;
  readonly expires_at?: Date;
  readonly status: "VALID" | "EXPIRED" | "CONSUMED" | "INVALID";
}

export interface ReceiptStore {
  insert(receipt: ReceiptRecord): Promise<void>;
  /**
   * Concurrency-safe issuance. Stores `receipt` only when no VALID receipt already exists for its
   * (plan_id, type), and always returns the receipt that is live afterwards — the caller's own when it won the
   * race, the incumbent when it lost. Two simultaneous os_verify calls can therefore never mint two live
   * receipts for one plan phase. PostgreSQL enforces this with the partial unique index
   * `receipts_one_valid_per_plan_phase_uq`; the in-memory store does the check and the write with no `await`
   * between them, which is the equivalent guarantee on a single event loop.
   */
  insertIfAbsent(receipt: ReceiptRecord): Promise<ReceiptRecord>;
  get(receiptId: string): Promise<ReceiptRecord | undefined>;
  setStatus(receiptId: string, status: ReceiptRecord["status"]): Promise<void>;
  findByPlan(planId: string, type?: VerifyPhase): Promise<readonly ReceiptRecord[]>;
  /** Every receipt this runtime ever received, across generations. The verification index is rebuilt from it. */
  findByRuntime(runtimeId: string, type?: VerifyPhase): Promise<readonly ReceiptRecord[]>;
  /** Latest terminal proof for each exact scoped page/field; bounded output, no history readback. */
  findFinalByFields?(scope: Pick<Plan, "principal_id" | "project" | "lane" | "runtime_id" | "runtime_generation" | "governing_spec_version" | "governing_schema_version" | "governing_control_version">,
    fields: readonly { page_ref: string; field: string }[]): Promise<readonly { page_ref: string; field: string; receipt: ReceiptRecord }[]>;
}

export type VerifyOutcome =
  | { readonly kind: "VERIFIED"; readonly receipt: ReceiptRecord }
  | { readonly kind: "HOLD"; readonly code: HoldCode; readonly evidence: readonly string[] };

/**
 * Verification engine. Reads actual Notion state; never trusts write responses or caller-supplied
 * observations. TARGET and FINAL validations are delivered by later tickets. This scaffold fixes the
 * contract and the phase precondition (FINAL requires TARGET_VERIFIED).
 */
export interface VerificationEngine {
  verify(plan: Plan, phase: VerifyPhase): Promise<VerifyOutcome>;
}

export function finalPreconditionHold(plan: Plan): VerifyOutcome | undefined {
  if (plan.plan_state === "FINAL_VERIFIED") return undefined; // repeat FINAL returns the stored terminal result
  if (plan.plan_state !== "TARGET_VERIFIED" && plan.plan_state !== "AWAITING_FINAL_VERIFY") {
    return { kind: "HOLD", code: "HOLD_FINAL_WITHOUT_TARGET_VERIFICATION", evidence: [`plan_state=${plan.plan_state}`] };
  }
  return undefined;
}
