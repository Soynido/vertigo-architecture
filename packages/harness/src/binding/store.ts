import type { BindingState, Lane } from "../tools/envelope.ts";

export interface BindingRecord {
  readonly binding_id: string;
  readonly handle_hash: string;
  readonly principal_id: string;
  readonly project: string;
  readonly lane: Lane;
  readonly runtime_logical_key: string;
  readonly runtime_id: string;
  readonly runtime_generation: string;
  /** Persisted authorization surface. INSTALL_ONLY can never acquire business authority on the same handle. */
  readonly binding_mode: "BUSINESS" | "INSTALL_ONLY";
  /** Explicit provisioning phase; remains INSTALL_PENDING across every partial install state. */
  readonly install_phase: "NOT_APPLICABLE" | "INSTALL_PENDING";
  readonly resolved_manifest_ref: string;
  readonly governing_versions_snapshot: Readonly<Record<string, string>>;
  readonly status: BindingState;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly last_seen_at?: Date;
}

export interface BindingStore {
  insert(record: BindingRecord): Promise<void>;
  findByHandleHash(handleHash: string): Promise<BindingRecord | undefined>;
  setStatus(bindingId: string, status: BindingState): Promise<void>;
  touch(bindingId: string, at: Date): Promise<void>;
}

/** Binding state machine transitions (04 — BINDING & RUNTIME RESOLUTION). */
export function nextBindingState(current: BindingState, event: "RUNTIME_UNCHANGED" | "RUNTIME_ROTATED" | "AUTH_REVOKED" | "TTL_EXCEEDED"): BindingState {
  if (current !== "BOUND") return current; // STALE/REVOKED/EXPIRED never return to BOUND; rebind instead
  switch (event) {
    case "RUNTIME_UNCHANGED":
      return "BOUND";
    case "RUNTIME_ROTATED":
      return "STALE";
    case "AUTH_REVOKED":
      return "REVOKED";
    case "TTL_EXCEEDED":
      return "EXPIRED";
  }
}

export function canMutate(state: BindingState): boolean {
  return state === "BOUND";
}
