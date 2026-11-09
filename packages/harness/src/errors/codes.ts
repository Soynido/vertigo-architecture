/**
 * Stable machine codes. ERROR = malformed/unauthorized invocation; HOLD = understood but blocked by
 * observed/unknown state. The model must never convert a HOLD into success through prose.
 */
export const ERROR_CODES = [
  "ERROR_AUTH_REQUIRED",
  "ERROR_INVALID_ARGUMENT",
  "ERROR_PROJECT_UNKNOWN",
  "ERROR_PRINCIPAL_MISMATCH",
  "ERROR_PLAN_NOT_FOUND",
  "ERROR_NOT_IMPLEMENTED", // scaffold-only: the ticket implementing this path has not run yet
  "ERROR_INTERNAL", // the backend failed on its own side (store, unexpected exception): nothing was written; retry, then report
] as const;

export const HOLD_CODES = [
  // bind
  "HOLD_UNAUTHORIZED_LANE",
  "HOLD_LANE_REQUIRED", // PV0-020B: project/lane could not be inferred from the principal; one question is asked
  "HOLD_RUNTIME_NOT_FOUND",
  "HOLD_RUNTIME_NOT_YET_CREATED",
  "HOLD_RUNTIME_AMBIGUOUS",
  "HOLD_BOOTSTRAP_DISCOVERY",
  "HOLD_RUNTIME_MANIFEST_MISMATCH",
  "HOLD_RUNTIME_TEMPLATE_NOT_INSTANCE",
  "HOLD_INSTALL_REQUIRED", // registry-assigned UNBOUND SALES clone: only its verified bootstrap transaction may proceed
  // resume
  "HOLD_BINDING_STALE_RUNTIME_ROTATED",
  "HOLD_VERSION_RESOLUTION",
  "HOLD_UNSUPPORTED_GOVERNING_VERSION",
  "HOLD_RUN_AMBIGUOUS",
  "HOLD_RECOVERY_REQUIRED",
  "HOLD_STATE_DIVERGENCE",
  "HOLD_REQUIRED_RESOURCE_MISSING",
  "HOLD_UNKNOWN_REQUIRED_FACT",
  "HOLD_REQUIRED_CAPABILITY_INCOMPLETE", // PV-GTM-002F: a REQUIRED source is not yet verified for this principal/runtime/mode
  // prepare
  "HOLD_BINDING_STALE",
  "HOLD_RUNTIME_BUSY",
  "HOLD_VERSION_CHANGED",
  "HOLD_PERMISSION_UNKNOWN",
  "HOLD_ACTION_NOT_AUTHORIZED",
  "HOLD_GATE_UNSPECIFIED", // PV-GATE-000: the governing contract governs this durable step but publishes no
                           // completion predicate or cursor transition for it; the step cannot be advanced
  "HOLD_RESOURCE_UNKNOWN",
  "HOLD_TARGET_NOT_FOUND",
  "HOLD_TARGET_AMBIGUOUS",
  "HOLD_SCHEMA_MISMATCH",
  "HOLD_UNSUPPORTED_OPERATION",
  "HOLD_FIXTURE_CONTRACT_VIOLATION",
  "HOLD_GTM_CONTRACT_VIOLATION", // PV-GTM-002: the record states more than its evidence supports (candidate GTM grammar)
  "HOLD_EXISTING_PLAN_ACTIVE",
  // verify (generic)
  "HOLD_PLAN_EXPIRED",
  "HOLD_PLAN_BINDING_MISMATCH",
  "HOLD_PLAN_RUNTIME_MISMATCH",
  "HOLD_PLAN_REPLAY_INVALID",
  // verify TARGET
  "HOLD_TARGET_NOT_WRITTEN",
  "HOLD_TARGET_WRONG_VALUE",
  "HOLD_TARGET_WRONG_FIELD",
  "HOLD_TARGET_WRONG_RECORD",
  "HOLD_LEDGER_PREPARE_MISSING",
  "HOLD_RUN_NOT_OPENED",
  "HOLD_VERSION_CHANGED_DURING_TRANSACTION",
  // verify FINAL
  "HOLD_FINAL_WITHOUT_TARGET_VERIFICATION",
  "HOLD_TARGET_RECEIPT_EXPIRED",
  "HOLD_TARGET_RECEIPT_INVALID",
  "HOLD_TARGET_RECEIPT_REPLAY",
  "HOLD_TARGET_CHANGED_AFTER_TARGET_VERIFY",
  "HOLD_LEDGER_NOT_VERIFIED",
  "HOLD_LEDGER_RECEIPT_MISMATCH",
  "HOLD_RUN_INCOMPLETE",
  "HOLD_RUN_COUNT_MISMATCH",
  "HOLD_STATE_LAST_NOT_PROVEN",
  "HOLD_FINAL_RUNTIME_CONFLICT",
  "HOLD_FINAL_GATE_INVALID",
  "HOLD_FINAL_VERSION_CONFLICT",
  // recovery
  "HOLD_CONFLICT",
  "HOLD_DUPLICATE",
  // handoff
  "HOLD_NO_DURABLE_HANDOFF",
  // control
  "HOLD_UNSUPPORTED_CONTROL_VERSION",
  "HOLD_CONTROL_PROOF_MISSING",
  "HOLD_CONTROL_STALE",
  "HOLD_CONTROL_SCOPE_INCOMPLETE",
  "HOLD_CONTROL_UNKNOWN",
  "HOLD_CONTROL_VIOLATION",
  "HOLD_CONTROL_GOVERNANCE_AMBIGUOUS",
  // isolation
  "HOLD_CROSS_LANE",
  "HOLD_CROSS_RUNTIME",
  // external effect plane (PLUGIN_SPEC/0.2.0, PDEC-013): Gmail is the competent source; the harness never sends
  "HOLD_EXTERNAL_INTENT_NOT_VERIFIED",
  "HOLD_EXTERNAL_SOURCE_UNAVAILABLE",
  "HOLD_EXTERNAL_EFFECT_AMBIGUOUS",
  "HOLD_EXTERNAL_EFFECT_OBSERVED",
  "HOLD_MAILBOX_IDENTITY_MISMATCH",
  "HOLD_INBOUND_BEFORE_DISPATCH",
  "HOLD_EXECUTOR_REQUIRED",
  "HOLD_TEST_SCOPE_NOT_APPROVED",
] as const;

/**
 * Codes of the candidate `TransactionOutcome` (PV-WRITE-001 A.3, os_commit — PDEC-018 CANDIDATE, NOT ADOPTED).
 * Deliberately OUTSIDE `HOLD_CODES`: the six-tool envelope, its exhaustive sentence map and its conduct never
 * carry them. Their sentences live with the transaction (transactions/sentences.fr.ts).
 */
export const TRANSACTION_HOLD_CODES = [
  "HOLD_SERVER_WRITES_DISABLED", // no Notion writer in this process; never a fallback to writing from the chat
  "HOLD_NOTION_WRITE_REJECTED",
  "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE", // W3.1R/S: a guard source, approval, P0, pointer or class cannot be proven
  "HOLD_P0_PRODUCTION", // W3.1S: an approved P0 is really TRIGGERED on a new production
] as const;

export const OK_CODES = ["BOUND", "RESUMED", "PLAN_PREPARED", "TARGET_VERIFIED", "TRANSACTION_VERIFIED", "HANDOFF_READY", "CONTROL_STATUS"] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
export type HoldCode = (typeof HOLD_CODES)[number];
export type OkCode = (typeof OK_CODES)[number];
export type TransactionHoldCode = (typeof TRANSACTION_HOLD_CODES)[number];
export type Code = ErrorCode | HoldCode | OkCode;
