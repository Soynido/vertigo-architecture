/**
 * PT-STORE-002 — the executor's durable mechanics (PV-WRITE-001 / W1.5): an exclusive claim per plan, renewal by
 * its holder only (plan and lease together), the write journal's compare-and-set transitions, and an idempotent
 * migration. Runs on the in-memory store always, and on PostgreSQL when HARNESS_TEST_DATABASE_URL is set.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BindingRecord } from "../../src/binding/store.ts";
import { loadConfig } from "../../src/config/index.ts";
import { createPlan, leaseKeyOf, renew } from "../../src/plans/service.ts";
import type { Plan, PlanWriteSeed } from "../../src/plans/store.ts";
import { createMemoryStore, type BackendStore } from "../../src/store/memory.ts";
import { PostgresBackend } from "../../src/store/postgres.ts";
import { draftFor } from "./plan-fixtures.ts";

const url = process.env["HARNESS_TEST_DATABASE_URL"];
const config = loadConfig({ VERTIGO_META_SPEC_ROOT: "https://example.invalid/root", HARNESS_ENV: "fixture", PRINCIPALS_FILE: "x" });
const T0 = new Date("2030-01-01T10:00:00.000Z");
const at = (s: number) => new Date(T0.getTime() + s * 1_000);

function binding(id: string): BindingRecord {
  return { binding_id: `b-${id}`, handle_hash: id.padEnd(64, "0"), principal_id: "p-store", project: "VERTIGO", lane: "META", runtime_logical_key: "VERTIGO/META", runtime_id: `rt-${id}`, runtime_generation: `gen-${id}`, binding_mode: "BUSINESS", install_phase: "NOT_APPLICABLE", resolved_manifest_ref: "m", governing_versions_snapshot: { spec: "s" }, status: "BOUND", created_at: T0, expires_at: at(86_400) };
}

async function planIn(store: BackendStore, id: string): Promise<Plan> {
  const b = binding(id);
  await store.bindings.insert(b);
  const out = await createPlan(store, config, draftFor(b, [`op-${id}`]), T0);
  assert.equal(out.kind, "CREATED");
  return (out as { plan: Plan }).plan;
}

function seedsOf(p: Plan): PlanWriteSeed[] {
  const phase = (w: Plan["stage1_writes"][number]) => (p.stage1_writes.includes(w) ? "STAGE1" : p.finalization_writes.includes(w) ? "FINALIZATION" : "STATE_LAST") as PlanWriteSeed["phase"];
  return [...p.stage1_writes, ...p.finalization_writes, p.state_last_write].map((w) => ({ symbol: w.symbol, phase: phase(w), ordinal: w.ordinal, operation: w.operation === "CREATE" ? "CREATE" : "UPDATE", target_ref: w.target_ref }));
}

type Sub = (name: string, fn: () => Promise<void>) => Promise<unknown>;

async function suite(name: string, store: BackendStore, run: string, sub: Sub) {
  await sub(`PT-STORE-002/events [${name}]: bounded newest read retains audit defaults and exact scope`, async () => {
    const p = await planIn(store, `${run}-events`);
    const add = (result: string, runtime_id = p.runtime_id, event_type = "SOURCE_ENROLLMENT_CONFIRMATION") => store.events.append({ principal_id: p.principal_id, binding_id: p.binding_id, runtime_id, event_type, result, detail: { challenge: `fixture:${result}` }, created_at: T0 });
    await add("PENDING"); await add("DECLINED"); await add("FOREIGN", "other"); await add("OTHER_TYPE", p.runtime_id, "OTHER");
    const scope = { binding_id: p.binding_id, runtime_id: p.runtime_id, event_type: "SOURCE_ENROLLMENT_CONFIRMATION" };
    assert.deepEqual((await store.events.list(scope)).map(e => e.result), ["PENDING", "DECLINED"]);
    assert.deepEqual((await store.events.list({ ...scope, newest_first: true, limit: 1 })).map(e => e.result), ["DECLINED"]);
    assert.deepEqual((await store.events.list({ ...scope, limit: 1 })).map(e => e.result), ["PENDING"]);
    assert.equal((await store.events.list({ ...scope, binding_id: "other", limit: 1 })).length, 0);
    for (const limit of [0, -1, 1.5, 101, NaN]) await assert.rejects(store.events.list({ ...scope, limit }), /integer from 1 to 100/);
  });
  await sub(`PT-STORE-002/a [${name}]: a claim is exclusive while live, extended only by its holder, free once lapsed`, async () => {
    const p = await planIn(store, `${run}-a`);
    assert.equal(await store.claims.claim(p.plan_id, "tok-A", T0, at(30)), true);
    assert.equal(await store.claims.claim(p.plan_id, "tok-B", at(1), at(31)), false, "a live claim is exclusive");
    assert.equal(await store.claims.claim(p.plan_id, "tok-A", at(10), at(40)), true, "the holder extends its own claim");
    assert.equal(await store.claims.claim(p.plan_id, "tok-B", at(35), at(60)), false, "still live after the holder's extension");
    assert.equal(await store.claims.claim(p.plan_id, "tok-B", at(41), at(70)), true, "a lapsed claim can be taken");
    await store.claims.release(p.plan_id, "tok-A");
    assert.equal(await store.claims.claim(p.plan_id, "tok-C", at(42), at(80)), false, "a former holder cannot release another's claim");
    await store.claims.release(p.plan_id, "tok-B");
    assert.equal(await store.claims.claim(p.plan_id, "tok-C", at(43), at(80)), true);
    // Two executors racing for a free plan: exactly one wins.
    const q = await planIn(store, `${run}-a2`);
    const wins = await Promise.all([store.claims.claim(q.plan_id, "tok-X", T0, at(30)), store.claims.claim(q.plan_id, "tok-Y", T0, at(30))]);
    assert.equal(wins.filter(Boolean).length, 1);
  });

  await sub(`PT-STORE-002/b [${name}]: renew moves plan and lease together, for the live claim holder only`, async () => {
    const p = await planIn(store, `${run}-b`);
    assert.equal(await renew(store, config, p.plan_id, "tok-A", at(5)), false, "no claim, no renewal");
    await store.claims.claim(p.plan_id, "tok-A", at(5), at(65));
    assert.equal(await renew(store, config, p.plan_id, "tok-B", at(6)), false, "another token cannot renew");
    assert.equal(await renew(store, config, p.plan_id, "tok-A", at(60)), true);
    const expected = at(60 + config.planTtlMinutes * 60);
    assert.equal((await store.plans.get(p.plan_id))?.expires_at.getTime(), expected.getTime());
    assert.equal((await store.leases.current(leaseKeyOf(p), at(61)))?.expires_at.getTime(), expected.getTime());
    assert.equal(await renew(store, config, p.plan_id, "tok-A", at(66)), false, "a lapsed claim renews nothing");
    await store.claims.claim(p.plan_id, "tok-A", at(66), at(200));
    await store.plans.setState(p.plan_id, "ABORTED");
    assert.equal(await renew(store, config, p.plan_id, "tok-A", at(70)), false, "a terminal plan is never renewed");
    assert.equal((await store.plans.get(p.plan_id))?.expires_at.getTime(), expected.getTime(), "a refused renewal changed nothing");
  });

  await sub(`PT-STORE-002/c [${name}]: the write journal — ensure is idempotent, transitions are compare-and-set`, async () => {
    const p = await planIn(store, `${run}-c`);
    const seeds = seedsOf(p);
    const rows = await store.planWrites.ensure(p.plan_id, seeds);
    assert.deepEqual(rows.map((r) => [r.symbol, r.status, r.attempts]), seeds.map((s) => [s.symbol, "PENDING", 0]));
    assert.deepEqual(rows.map((r) => r.phase), ["STAGE1", "STAGE1", "STAGE1", "STAGE1", "FINALIZATION", "FINALIZATION", "STATE_LAST"]);

    const hash = "a".repeat(64);
    const sent = await store.planWrites.transition(p.plan_id, "W0", "PENDING", "SENT", { at: at(1), payload_hash: hash, stamped_now: "2030-01-01T10:00:00.000Z" });
    assert.equal(sent?.status, "SENT");
    assert.equal(sent?.attempts, 1);
    // Re-ensuring never resets a journaled row.
    assert.equal((await store.planWrites.ensure(p.plan_id, seeds)).find((r) => r.symbol === "W0")?.status, "SENT");
    // A resend: same payload, attempts + 1, first stamp kept. A different payload is refused.
    const resent = await store.planWrites.transition(p.plan_id, "W0", "SENT", "SENT", { at: at(2), payload_hash: hash });
    assert.deepEqual([resent?.attempts, resent?.stamped_now], [2, "2030-01-01T10:00:00.000Z"]);
    await assert.rejects(store.planWrites.transition(p.plan_id, "W0", "SENT", "SENT", { at: at(3), payload_hash: "b".repeat(64) }), /same payload/);
    // Compare-and-set lost: the row is no longer PENDING.
    assert.equal(await store.planWrites.transition(p.plan_id, "W0", "PENDING", "SENT", { at: at(4), payload_hash: hash }), undefined);
    const done = await store.planWrites.transition(p.plan_id, "W0", "SENT", "DONE", { at: at(5) });
    assert.equal(done?.status, "DONE");
    // Final states are final; illegal jumps are refused, not ignored.
    await assert.rejects(store.planWrites.transition(p.plan_id, "W0", "DONE", "SENT", { at: at(6), payload_hash: hash }), /not a journal transition/);
    await assert.rejects(store.planWrites.transition(p.plan_id, "W1", "PENDING", "DONE", { at: at(6) }), /not a journal transition/);
    await assert.rejects(store.planWrites.transition(p.plan_id, "W1", "PENDING", "SENT", { at: at(6) }), /requires the payload hash/);
    await assert.rejects(store.planWrites.transition(p.plan_id, "NOPE", "PENDING", "SENT", { at: at(6), payload_hash: hash }), /not journaled/);
    // OBSERVED (located after an ambiguous send) and FAILED_FINAL (refused before any send).
    await store.planWrites.transition(p.plan_id, "W1", "PENDING", "SENT", { at: at(7), payload_hash: hash });
    assert.equal((await store.planWrites.transition(p.plan_id, "W1", "SENT", "OBSERVED", { at: at(8), last_error: "timeout" }))?.status, "OBSERVED");
    assert.equal((await store.planWrites.transition(p.plan_id, "W2", "PENDING", "FAILED_FINAL", { at: at(9), last_error: "validation_error" }))?.last_error, "validation_error");
    // Two executors racing on one row: exactly one transition applies.
    const race = await Promise.all([
      store.planWrites.transition(p.plan_id, "W3", "PENDING", "SENT", { at: at(10), payload_hash: hash }),
      store.planWrites.transition(p.plan_id, "W3", "PENDING", "SENT", { at: at(10), payload_hash: hash }),
    ]);
    assert.equal(race.filter(Boolean).length, 1);
    assert.equal((await store.planWrites.list(p.plan_id)).find((r) => r.symbol === "W3")?.attempts, 1);
  });

  await sub(`PT-STORE-002/d [${name}]: a CREATE is DONE or OBSERVED only with the page it created`, async () => {
    const p = await planIn(store, `${run}-d`);
    await store.planWrites.ensure(p.plan_id, [{ symbol: "OPEN_RUN", phase: "STAGE1", ordinal: 0, operation: "CREATE", target_ref: "ds-runs" }]);
    await store.planWrites.transition(p.plan_id, "OPEN_RUN", "PENDING", "SENT", { at: at(1), payload_hash: "c".repeat(64) });
    await assert.rejects(store.planWrites.transition(p.plan_id, "OPEN_RUN", "SENT", "DONE", { at: at(2) }), /created page id/);
    assert.equal((await store.planWrites.transition(p.plan_id, "OPEN_RUN", "SENT", "DONE", { at: at(2), created_id: "page-1" }))?.created_id, "page-1");
  });
}

await suite("memory", createMemoryStore(), "m", (n, fn) => test(n, fn));

test("PT-STORE-002 [postgres]: migrations are idempotent, the new columns round-trip, then the same suite", { skip: !url && "HARNESS_TEST_DATABASE_URL not set" }, async (t) => {
  // Its own schema: postgres.integration.test.ts truncates the default one, and node --test runs files in parallel.
  const admin = new PostgresBackend(url as string);
  await admin.pool.query("create schema if not exists pt_store_002");
  await admin.close();
  const backend = new PostgresBackend(`${url as string}${(url as string).includes("?") ? "&" : "?"}options=${encodeURIComponent("-c search_path=pt_store_002")}`);
  t.after(() => backend.close());
  const dir = new URL("../../migrations/", import.meta.url);
  assert.deepEqual(await backend.migrateAll(dir), ["001_init.sql", "002_server_writes.sql", "003_guard_approval.sql"]);
  assert.deepEqual(await backend.migrateAll(dir), ["001_init.sql", "002_server_writes.sql", "003_guard_approval.sql"], "a second run is a no-op, not an error");
  await backend.pool.query("truncate plan_writes, transaction_events, receipts, runtime_leases, plan_operations, plans, bindings, principals cascade");
  const store = backend.store();
  // natural_key_property_type and plan_origin survive a PostgreSQL round trip.
  const b = binding("pg-rt");
  await store.bindings.insert(b);
  const draft = draftFor(b, ["op-pg-rt"]);
  const out = await createPlan(store, config, { ...draft, operations: draft.operations.map((o) => ({ ...o, natural_key: "k@example.invalid", natural_key_property: "Email", natural_key_property_type: "email" })) }, T0);
  const stored = await store.plans.get((out as { plan: Plan }).plan.plan_id);
  assert.equal(stored?.operations[0]?.natural_key_property_type, "email");
  assert.equal(stored?.plan_origin, "INTENT", "every plan stored without an origin reads back as INTENT");
  await suite("postgres", store, "p", (n, fn) => t.test(n, fn));
});
