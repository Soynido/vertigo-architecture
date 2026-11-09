/**
 * Operator approval of a Sales Production Guard Index (W3.1R, Sales 0.5.11 candidate — NOT ADOPTED).
 *
 * The backend keeps only what identifies the approved revision: the runtime binding, its generation, the guard
 * grammar, the approved index page, the SHA-256 digest of the canonical snapshot, when and by whom. Never the
 * rules, the configuration values or any other business text. Only the local operator command writes it; no tool
 * and no Notion field can.
 */
export interface GuardApproval {
  /** The runtime binding the approval belongs to (`guardBindingId`), stable across chat handles. */
  readonly binding_id: string;
  readonly runtime_id: string;
  readonly runtime_generation: string;
  readonly guard_schema_version: string;
  /** Physical page id of the approved index page; part of the digest too. */
  readonly index_page_id: string;
  readonly digest_sha256: string;
  readonly approved_at: Date;
  /** Identity of the operator who ran the approval command, never a principal of the chat. */
  readonly operator_id: string;
}

export interface GuardApprovalStore {
  get(bindingId: string): Promise<GuardApproval | undefined>;
  /** Replaces the approval of this binding: renewing is the only way to accept a new revision. */
  put(approval: GuardApproval): Promise<void>;
}

export function createMemoryGuardApprovals(): GuardApprovalStore {
  const rows = new Map<string, GuardApproval>();
  return {
    async get(bindingId) { return rows.get(bindingId); },
    async put(approval) { rows.set(approval.binding_id, approval); },
  };
}
