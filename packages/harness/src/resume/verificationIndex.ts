/**
 * PV-FW-001 — the verification index: what the harness has proved, object by object.
 *
 * A verification covers only the objects and fields it actually verified. So the reference for "has this row
 * changed behind my back?" is per object: the fields compared and their content fingerprint in the last receipt
 * that proved that row, and the row's revision at that moment. It is rebuilt from the receipts the backend
 * already stores — never a second business store, never a global date that a transaction on B could advance
 * past a foreign edit on A.
 */
import type { BackendStore } from "../store/memory.ts";
import type { ReceiptRecord } from "../verify/engine.ts";

export interface VerifiedObject {
  readonly target_ref: string;
  readonly data_source_ref: string;
  readonly logical_resource_key: string;
  /** The fields the receipt compared: the governed content of this row. */
  readonly fields: readonly string[];
  /** Per field, what the receipt observed: a `ref:` fingerprint for a redacted resource, otherwise the value. */
  readonly observed: Readonly<Record<string, string | null>>;
  readonly last_edited: string;
  readonly receipt_id: string;
  readonly plan_id: string;
  readonly observed_at: Date;
}

interface TargetEntry {
  readonly ordinal: number;
  readonly target_ref: string;
  readonly data_source_ref?: string;
  readonly logical_resource_key?: string;
  readonly compared_fields?: readonly string[];
  readonly observed?: Record<string, string | null>;
  readonly last_edited?: string;
}

/**
 * Every row a FINAL-verified transaction of this runtime proved, keyed by physical ref, keeping the most recent
 * proof per row. Receipts predating the per-target resource key resolve it through their plan's operations.
 */
export async function buildVerificationIndex(store: BackendStore, runtimeId: string): Promise<ReadonlyMap<string, VerifiedObject>> {
  const finals = (await store.receipts.findByRuntime(runtimeId, "FINAL")).filter((r) => r.status !== "INVALID");
  const index = new Map<string, VerifiedObject>();
  for (const final of finals) {
    if (!final.target_receipt_id) continue;
    const target: ReceiptRecord | undefined = await store.receipts.get(final.target_receipt_id);
    if (!target) continue;
    const targets = (target.observations["targets"] as TargetEntry[] | undefined) ?? [];
    let ops: readonly { ordinal: number; logical_resource_key: string; compared_fields: readonly string[] }[] | undefined;
    for (const t of targets) {
      if (!t.target_ref || !t.observed) continue;
      let key = t.logical_resource_key;
      let fields = t.compared_fields;
      if (!key || !fields) {
        ops ??= (await store.plans.get(final.plan_id))?.operations ?? [];
        const op = ops.find((o) => o.ordinal === t.ordinal);
        if (!op) continue;
        key ??= op.logical_resource_key;
        fields ??= op.compared_fields;
      }
      const prior = index.get(t.target_ref);
      // Receipts are iterated oldest first, so a later proof of the same row replaces the earlier one. Only a
      // strictly newer incumbent wins: fixtures (and same-second transactions) share a timestamp, and there the
      // last proof issued is the current one.
      if (prior && prior.observed_at.getTime() > final.observed_at.getTime()) continue;
      index.set(t.target_ref, { target_ref: t.target_ref, data_source_ref: t.data_source_ref ?? "UNKNOWN", logical_resource_key: key, fields, observed: t.observed, last_edited: t.last_edited ?? "UNKNOWN", receipt_id: final.receipt_id, plan_id: final.plan_id, observed_at: final.observed_at });
    }
  }
  return index;
}
