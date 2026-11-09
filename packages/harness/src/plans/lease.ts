import type { Lane } from "../tools/envelope.ts";

/** One active mutating plan per (project, lane, runtime_generation) — PDEC-006. */
export interface LeaseKey {
  readonly project: string;
  readonly lane: Lane;
  readonly runtime_generation: string;
}

export interface Lease extends LeaseKey {
  readonly plan_id: string;
  readonly acquired_at: Date;
  readonly expires_at: Date;
}

export type LeaseOutcome = { readonly acquired: true; readonly lease: Lease } | { readonly acquired: false; readonly holder: Lease };

export interface LeaseStore {
  /** Atomic acquire: fails with the current holder when a live lease exists. */
  acquire(key: LeaseKey, planId: string, now: Date, expiresAt: Date): Promise<LeaseOutcome>;
  release(key: LeaseKey, planId: string): Promise<void>;
  current(key: LeaseKey, now: Date): Promise<Lease | undefined>;
}

export function leaseKeyString(key: LeaseKey): string {
  return `${key.project}|${key.lane}|${key.runtime_generation}`;
}
