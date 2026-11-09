/**
 * GTM-W03 — CRASH / RECOVERY / IDEMPOTENCE SUBSTRATE (test-only, in memory).
 *
 * A minimal action-key ledger: enough to exercise safe replay, verified update without duplication, conflict HOLD,
 * exact lookup after a crash between the write and its receipt, single-writer coordination and the reset contract.
 * It touches nothing but its own in-memory namespace.
 */
import { FIXTURE_ROOT } from "./catalog.ts";
import { buildGtmWorld, fingerprint, type GtmWorld } from "./world.ts";

export interface LedgerRow {
  readonly action_key: string;
  readonly value: string;
  readonly receipt: string | null;
  readonly written_at: string;
  readonly writer: string;
}

export interface LedgerState {
  readonly root: typeof FIXTURE_ROOT;
  rows: LedgerRow[];
  lease: { holder: string } | null;
  seq: number;
}

export const newLedger = (): LedgerState => ({ root: FIXTURE_ROOT, rows: [], lease: null, seq: 0 });

export type WriteOutcome =
  | "WRITTEN" | "REPLAY_SAFE_NO_DUPLICATE" | "VERIFIED_NO_DUPLICATE" | "CONFLICT_HOLD" | "COORDINATION_HOLD";

export interface WriteRequest {
  readonly action_key: string;
  /** What the writer believes is currently durable. `null` means "nothing yet". */
  readonly expected_value: string | null;
  readonly value: string;
  readonly writer: string;
  readonly at: string;
  /** Simulates a crash after the durable write and before the receipt is handed back. */
  readonly crash_before_receipt?: boolean;
}

export interface WriteResult {
  readonly outcome: WriteOutcome;
  readonly row_count: number;
  readonly receipt: string | null;
  readonly reason: string;
}

export const lookupByActionKey = (s: LedgerState, action_key: string): LedgerRow | undefined =>
  s.rows.find((r) => r.action_key === action_key);

export const acquireLease = (s: LedgerState, holder: string): boolean => {
  if (s.lease !== null && s.lease.holder !== holder) return false;
  s.lease = { holder };
  return true;
};
export const releaseLease = (s: LedgerState): void => { s.lease = null; };

/** The single write path. One action key is one row, for ever. */
export function writeOnce(s: LedgerState, req: WriteRequest): WriteResult {
  if (s.lease !== null && s.lease.holder !== req.writer) {
    return { outcome: "COORDINATION_HOLD", row_count: s.rows.length, receipt: null, reason: `the runtime is held by ${s.lease.holder}; a second writer coordinates or holds` };
  }
  const existing = lookupByActionKey(s, req.action_key);
  if (existing === undefined) {
    const receipt = req.crash_before_receipt === true ? null : `RCPT-${++s.seq}`;
    s.rows.push({ action_key: req.action_key, value: req.value, receipt, written_at: req.at, writer: req.writer });
    return { outcome: "WRITTEN", row_count: s.rows.length, receipt, reason: req.crash_before_receipt === true ? "the row is durable; the receipt was never handed back" : "first durable write" };
  }
  if (req.expected_value !== existing.value) {
    return { outcome: "CONFLICT_HOLD", row_count: s.rows.length, receipt: existing.receipt, reason: `expected ${JSON.stringify(req.expected_value)} but ${JSON.stringify(existing.value)} is durable` };
  }
  if (req.value === existing.value) {
    const receipt = existing.receipt ?? `RCPT-${++s.seq}`;
    s.rows = s.rows.map((r) => (r.action_key === req.action_key ? { ...r, receipt } : r));
    return { outcome: "REPLAY_SAFE_NO_DUPLICATE", row_count: s.rows.length, receipt, reason: "the exact same transaction was replayed; the existing row is returned, never duplicated" };
  }
  const receipt = `RCPT-${++s.seq}`;
  s.rows = s.rows.map((r) => (r.action_key === req.action_key ? { ...r, value: req.value, receipt, written_at: req.at, writer: req.writer } : r));
  return { outcome: "VERIFIED_NO_DUPLICATE", row_count: s.rows.length, receipt, reason: "the expected value matched what is durable; the same row now carries the new value" };
}

/* ────────────────────────────── the reset / isolation contract ────────────────────────────── */

export const OUTSIDE_ROOT_KEY = "OTHER_NAMESPACE:untouched";
export const WORLD_KEY = `${FIXTURE_ROOT}:world`;
export const LEDGER_KEY = `${FIXTURE_ROOT}:ledger`;

export type FixtureStore = Map<string, unknown>;

export function seedFixtureStore(outside: unknown = { owner: "not the fixture", value: 1 }): FixtureStore {
  const store: FixtureStore = new Map();
  store.set(WORLD_KEY, buildGtmWorld());
  store.set(LEDGER_KEY, newLedger());
  store.set(OUTSIDE_ROOT_KEY, outside);
  return store;
}

export interface ResetReport {
  readonly rebuilt_keys: readonly string[];
  readonly untouched_keys: readonly string[];
  readonly world_fingerprint: string;
}

/**
 * Reset rebuilds exactly the fixture root: every `GTM_FIX:` key is dropped and re-seeded from pure data, and every
 * key outside the root is left strictly alone (same reference, same value).
 */
export function resetFixtureStore(store: FixtureStore): ResetReport {
  const rebuilt: string[] = [];
  for (const key of [...store.keys()]) {
    if (key.startsWith(`${FIXTURE_ROOT}:`)) { store.delete(key); rebuilt.push(key); }
  }
  store.set(WORLD_KEY, buildGtmWorld());
  store.set(LEDGER_KEY, newLedger());
  return {
    rebuilt_keys: rebuilt.sort(),
    untouched_keys: [...store.keys()].filter((k) => !k.startsWith(`${FIXTURE_ROOT}:`)).sort(),
    world_fingerprint: fingerprint(store.get(WORLD_KEY) as GtmWorld),
  };
}
