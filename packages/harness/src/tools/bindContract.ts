/**
 * os_bind contract (PV0-006): the deterministic set of codes the public primitive may return.
 * Anything outside this set is a bug. Inputs are only logical `project` and `lane`; roots, runtime
 * IDs, owners, gates, Runs and versions are backend-resolved and never accepted from the caller.
 */
import type { Code } from "../errors/codes.ts";

export const OS_BIND_OK_CODES = ["BOUND"] as const satisfies readonly Code[];

export const OS_BIND_ERROR_CODES = ["ERROR_AUTH_REQUIRED", "ERROR_INVALID_ARGUMENT", "ERROR_PROJECT_UNKNOWN"] as const satisfies readonly Code[];

export const OS_BIND_HOLD_CODES = [
  "HOLD_UNAUTHORIZED_LANE",
  "HOLD_LANE_REQUIRED",
  "HOLD_RUNTIME_NOT_FOUND",
  "HOLD_RUNTIME_NOT_YET_CREATED",
  "HOLD_RUNTIME_AMBIGUOUS",
  "HOLD_BOOTSTRAP_DISCOVERY",
  "HOLD_RUNTIME_MANIFEST_MISMATCH",
  "HOLD_RUNTIME_TEMPLATE_NOT_INSTANCE",
  "HOLD_VERSION_RESOLUTION",
  "HOLD_UNSUPPORTED_GOVERNING_VERSION",
  "HOLD_UNKNOWN_REQUIRED_FACT",
] as const satisfies readonly Code[];

export const OS_BIND_CODES: ReadonlySet<Code> = new Set<Code>([...OS_BIND_OK_CODES, ...OS_BIND_ERROR_CODES, ...OS_BIND_HOLD_CODES]);

/** Fields of a successful os_bind result (spec §17 outputs). */
export interface OsBindResult {
  readonly binding_handle: string;
  readonly binding_expires_at: string;
  readonly owner_display: string;
  readonly lifecycle_state: string;
}

/** Arguments os_bind must refuse when supplied as authority (spec §17 "LLM-forbidden authority assertions"). */
export const OS_BIND_FORBIDDEN_ARGUMENTS = ["meta_root", "sales_root", "root", "runtime_id", "owner", "notion_user_id", "permissions", "current_gate", "current_run", "manifest_url", "control_version", "spec_version", "rep", "rep_identity_key"] as const;
