/**
 * Ownership validation (PV0-002). Every binding / plan / receipt lookup must validate that the
 * record belongs to the authenticated principal. The handle, plan_id or receipt_id alone is never
 * sufficient authorization. Display names are never used.
 */
import { hashHandle } from "../binding/handle.ts";
import type { BindingRecord, BindingStore } from "../binding/store.ts";
import type { Plan, PlanStore } from "../plans/store.ts";
import type { ReceiptRecord, ReceiptStore } from "../verify/engine.ts";

export type OwnershipFailure =
  | { readonly ok: false; readonly reason: "AUTH_REQUIRED" }
  | { readonly ok: false; readonly reason: "UNKNOWN_HANDLE" }
  | { readonly ok: false; readonly reason: "PRINCIPAL_MISMATCH" }
  | { readonly ok: false; readonly reason: "BINDING_NOT_BOUND"; readonly state: BindingRecord["status"] | "EXPIRED" }
  | { readonly ok: false; readonly reason: "PLAN_NOT_FOUND" }
  | { readonly ok: false; readonly reason: "PLAN_BINDING_MISMATCH" }
  | { readonly ok: false; readonly reason: "RECEIPT_NOT_FOUND" }
  | { readonly ok: false; readonly reason: "RECEIPT_PLAN_MISMATCH" };

export type BindingLookup = { readonly ok: true; readonly binding: BindingRecord } | OwnershipFailure;
export type PlanLookup = { readonly ok: true; readonly plan: Plan } | OwnershipFailure;
export type ReceiptLookup = { readonly ok: true; readonly receipt: ReceiptRecord } | OwnershipFailure;

/**
 * Resolve a binding handle for the authenticated principal.
 * Order matters: principal identity is checked before binding state so that a foreign handle never
 * leaks whether it is BOUND, STALE or EXPIRED.
 */
export async function lookupBinding(store: BindingStore, handle: string, principalId: string | undefined, now: Date): Promise<BindingLookup> {
  if (!principalId) return { ok: false, reason: "AUTH_REQUIRED" };
  const binding = await store.findByHandleHash(hashHandle(handle));
  if (!binding) return { ok: false, reason: "UNKNOWN_HANDLE" };
  if (binding.principal_id !== principalId) return { ok: false, reason: "PRINCIPAL_MISMATCH" };
  if (binding.status !== "BOUND") return { ok: false, reason: "BINDING_NOT_BOUND", state: binding.status };
  if (binding.expires_at <= now) return { ok: false, reason: "BINDING_NOT_BOUND", state: "EXPIRED" };
  return { ok: true, binding };
}

/**
 * Business plans remain strictly binding-scoped. A bounded installation plan may be adopted after a process/chat
 * interruption, but only by a fresh INSTALL_ONLY binding for the exact same authenticated principal, runtime id and
 * runtime generation. The live runtime is re-read by the installer before every subsequent transition.
 */
export async function lookupPlan(store: PlanStore, planId: string, principalId: string | undefined, binding: BindingRecord): Promise<PlanLookup> {
  if (!principalId) return { ok: false, reason: "AUTH_REQUIRED" };
  const plan = await store.get(planId);
  if (!plan) return { ok: false, reason: "PLAN_NOT_FOUND" };
  if (plan.principal_id !== principalId) return { ok: false, reason: "PRINCIPAL_MISMATCH" };
  if (plan.binding_id !== binding.binding_id || plan.principal_id !== binding.principal_id) {
    const installAdoption = (plan.plan_kind === "INSTALL_MAPPING" || plan.plan_kind === "INSTALL_PROMOTION")
      && binding.binding_mode === "INSTALL_ONLY"
      && plan.principal_id === binding.principal_id
      && plan.project === binding.project
      && plan.lane === binding.lane
      && plan.runtime_id === binding.runtime_id
      && plan.runtime_generation === binding.runtime_generation;
    if (!installAdoption) return { ok: false, reason: "PLAN_BINDING_MISMATCH" };
  }
  return { ok: true, plan };
}

/** A receipt is valid only for its own principal and plan. */
export async function lookupReceipt(store: ReceiptStore, receiptId: string, principalId: string | undefined, plan: Plan): Promise<ReceiptLookup> {
  if (!principalId) return { ok: false, reason: "AUTH_REQUIRED" };
  const receipt = await store.get(receiptId);
  if (!receipt) return { ok: false, reason: "RECEIPT_NOT_FOUND" };
  if (receipt.principal_id !== principalId) return { ok: false, reason: "PRINCIPAL_MISMATCH" };
  if (receipt.plan_id !== plan.plan_id) return { ok: false, reason: "RECEIPT_PLAN_MISMATCH" };
  return { ok: true, receipt };
}
