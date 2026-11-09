/**
 * GTM-W03 world H — crash, recovery, idempotence and the reset/isolation contract.
 * Six branches: safe replay, verified update without duplication, conflict HOLD, exact lookup after a crash
 * between write and receipt, deterministic reset inside the fixture root only, and single-writer coordination.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FIXTURE_ROOT } from "./catalog.ts";
import { buildGtmWorld, fingerprint, withCanceledEpisode, withCoverageGap } from "./world.ts";
import {
  acquireLease, LEDGER_KEY, lookupByActionKey, newLedger, OUTSIDE_ROOT_KEY, releaseLease, resetFixtureStore,
  seedFixtureStore, WORLD_KEY, writeOnce, type LedgerState,
} from "./ledger.ts";

const ACTION = "GTM_FIX:ACTION#weekly-metric-snapshot";
const at = (n: number) => `2026-09-28T09:0${n}:00+02:00`;

function seeded(): LedgerState {
  const s = newLedger();
  const first = writeOnce(s, { action_key: ACTION, expected_value: null, value: "v1", writer: "W1", at: at(0) });
  assert.equal(first.outcome, "WRITTEN");
  return s;
}

test("H1/H2/H3: replay is safe, a verified update never duplicates, a third value holds", () => {
  const s = seeded();
  const replay = writeOnce(s, { action_key: ACTION, expected_value: "v1", value: "v1", writer: "W1", at: at(1) });
  assert.equal(replay.outcome, "REPLAY_SAFE_NO_DUPLICATE");
  assert.equal(replay.row_count, 1);
  assert.equal(replay.receipt, "RCPT-1", "the original receipt comes back; no second one is issued");

  const update = writeOnce(s, { action_key: ACTION, expected_value: "v1", value: "v2", writer: "W1", at: at(2) });
  assert.equal(update.outcome, "VERIFIED_NO_DUPLICATE");
  assert.equal(update.row_count, 1);
  assert.equal(lookupByActionKey(s, ACTION)?.value, "v2");

  const conflict = writeOnce(s, { action_key: ACTION, expected_value: "v3", value: "v3", writer: "W1", at: at(3) });
  assert.equal(conflict.outcome, "CONFLICT_HOLD");
  assert.equal(conflict.row_count, 1);
  assert.equal(lookupByActionKey(s, ACTION)?.value, "v2", "a conflicting write changes nothing");
});

test("H4: a crash between the durable write and its receipt is recovered by exact lookup, never by a second write", () => {
  const s = newLedger();
  const crashed = writeOnce(s, { action_key: ACTION, expected_value: null, value: "v1", writer: "W1", at: at(0), crash_before_receipt: true });
  assert.equal(crashed.outcome, "WRITTEN");
  assert.equal(crashed.receipt, null);

  const found = lookupByActionKey(s, ACTION);
  assert.equal(found?.value, "v1", "the row is found by its action key, exactly once");
  const recovery = writeOnce(s, { action_key: ACTION, expected_value: "v1", value: "v1", writer: "W1", at: at(1) });
  assert.equal(recovery.outcome, "REPLAY_SAFE_NO_DUPLICATE");
  assert.equal(recovery.row_count, 1);
  assert.notEqual(recovery.receipt, null);
});

test("H5: reset restores the pristine baseline deterministically and touches nothing outside the fixture root", () => {
  const baseline = fingerprint(buildGtmWorld());
  assert.equal(fingerprint(buildGtmWorld()), baseline, "two independent builds are identical");
  const derived = withCoverageGap(withCanceledEpisode(buildGtmWorld(), "EP-M01"), "COV-MBX-R_TEST");
  assert.notEqual(fingerprint(derived), baseline, "a derived variant is a different value");

  const store = seedFixtureStore();
  const outsideBefore = store.get(OUTSIDE_ROOT_KEY);
  const ledger = store.get(LEDGER_KEY) as LedgerState;
  writeOnce(ledger, { action_key: ACTION, expected_value: null, value: "v1", writer: "W1", at: at(0) });
  store.set(WORLD_KEY, derived);

  const report = resetFixtureStore(store);
  assert.deepEqual(report.rebuilt_keys, [LEDGER_KEY, WORLD_KEY]);
  assert.deepEqual(report.untouched_keys, [OUTSIDE_ROOT_KEY]);
  assert.equal(report.world_fingerprint, baseline, "reset is deterministic: the baseline comes back byte for byte");
  assert.deepEqual(store.get(WORLD_KEY), buildGtmWorld());
  assert.equal((store.get(LEDGER_KEY) as LedgerState).rows.length, 0);
  assert.equal(store.get(OUTSIDE_ROOT_KEY), outsideBefore, "the key outside the fixture root keeps its identity");
  assert.equal([...store.keys()].filter((k) => k.startsWith(`${FIXTURE_ROOT}:`)).length, 2);
});

test("H6: a second concurrent writer coordinates or holds; it never writes behind the first", () => {
  const s = seeded();
  assert.equal(acquireLease(s, "W1"), true);
  assert.equal(acquireLease(s, "W2"), false, "the lease is not shared");
  const blocked = writeOnce(s, { action_key: ACTION, expected_value: "v1", value: "v-other", writer: "W2", at: at(4) });
  assert.equal(blocked.outcome, "COORDINATION_HOLD");
  assert.equal(lookupByActionKey(s, ACTION)?.value, "v1");
  releaseLease(s);
  assert.equal(writeOnce(s, { action_key: ACTION, expected_value: "v1", value: "v-other", writer: "W2", at: at(5) }).outcome, "VERIFIED_NO_DUPLICATE");
  assert.equal(s.rows.length, 1);
});
