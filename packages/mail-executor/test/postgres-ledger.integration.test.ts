/** Cross-process lock: runs only with HARNESS_TEST_DATABASE_URL (local PostgreSQL). Two racing acquires → one holder. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PostgresExecutionLedger } from "../src/ledger/postgres.ts";

const url = process.env["HARNESS_TEST_DATABASE_URL"];

test("postgres ledger: atomic acquire, holder-only update, re-acquirable only from REFUSED/FAILED/expired CHECKING", { skip: !url }, async () => {
  const ledger = await PostgresExecutionLedger.connect(url as string);
  const key = `ak-it-${Date.now()}`;
  const now = new Date();
  try {
    const [a, b] = await Promise.all([ledger.acquire(key, "att-1", now, 60_000), ledger.acquire(key, "att-2", now, 60_000)]);
    assert.deepEqual([a.kind, b.kind].sort(), ["ACQUIRED", "HELD"]);
    const holder = a.kind === "ACQUIRED" ? "att-1" : "att-2", other = holder === "att-1" ? "att-2" : "att-1";
    await assert.rejects(ledger.update(key, other, { state: "SENDING" }, now), /does not hold/);
    await ledger.update(key, holder, { state: "SENT_PENDING_READBACK", message_id: "m1", thread_id: "t1" }, now);
    assert.equal((await ledger.acquire(key, "att-3", new Date(now.getTime() + 3_600_000), 60_000)).kind, "HELD", "post-send states are never re-acquirable");
    await ledger.update(key, holder, { state: "OBSERVED", observed_at: now }, now);
    assert.equal((await ledger.get(key))?.state, "OBSERVED");
    const key2 = `${key}-b`;
    assert.equal((await ledger.acquire(key2, "att-x", now, 60_000)).kind, "ACQUIRED");
    await ledger.update(key2, "att-x", { state: "REFUSED", evidence: ["dnc"] }, now);
    assert.equal((await ledger.acquire(key2, "att-y", now, 60_000)).kind, "ACQUIRED", "REFUSED is re-acquirable");
    const key3 = `${key}-c`;
    await ledger.acquire(key3, "att-dead", new Date(now.getTime() - 3_600_000), 60_000);
    assert.equal((await ledger.acquire(key3, "att-live", now, 60_000)).kind, "ACQUIRED", "expired CHECKING lease is taken over");
  } finally { await ledger.close(); }
});
