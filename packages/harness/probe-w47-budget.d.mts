import type { BindingRecord } from "./src/binding/store.ts";
import type { Plan, PlanWriteRow } from "./src/plans/store.ts";

export interface PreparedDraft { readonly plan_id: string; readonly expires_at: Date | string }
export interface DriverProgress {
  readonly settled_writes: number;
  readonly verified_receipts: number;
  readonly active_plan_ids?: readonly string[];
  readonly prepared_capability?: PreparedDraft | undefined;
}
export function preparedCapabilityDraft(input: {
  plan: Plan | undefined; writes: readonly PlanWriteRow[]; binding: BindingRecord;
  expected: { readonly natural_key: string; readonly values: Readonly<Record<string, unknown>> }; now: number;
}): PreparedDraft | undefined;
export function driveCapabilityCommit<T extends {
  readonly kind: string; readonly phase?: string; readonly reason?: string;
  readonly plan_id?: string; readonly writes_done?: number;
}>(input: {
  call: () => Promise<T>; progress: () => Promise<DriverProgress>; expiresAt: string;
  clock?: () => number; report?: (entry: Record<string, unknown>) => void;
}): Promise<{ calls: T[]; stopped_at: string }>;
