/** Readonly operator metadata, not running-host instrumentation or ChatGPT proof. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NotionApiError, type NotionReadClient } from "../../src/notion/client.ts";
import { safeReadFailure, traceHistoricalReads } from "../support/historical-read-trace.ts";

const REF = "a".repeat(32);
const DASHED_REF = [8, 4, 4, 4, 12].map(length => "A".repeat(length)).join("-");
function world() {
  const calls: { method: string; args: unknown[] }[] = [], value = { secret: "never-return-this-in-a-trace" };
  const client = Object.fromEntries(["retrievePage", "retrieveDatabase", "retrieveDataSource", "retrieveBlockChildren", "queryDataSource"].map(method => [method, async function(this: unknown, ...args: unknown[]) {
    assert.equal(this, client); calls.push({ method, args }); return value;
  }])) as unknown as NotionReadClient;
  return { client, calls, value };
}
test("W7.3 read trace: pass through all five reads/arguments/this/value exactly, never expose writers", async () => {
  const w = world(), trace = traceHistoricalReads(w.client);
  const filter = { email: "secret-filter" }, options = { page_size: 100 };
  for (const [method, args] of [
    ["retrievePage", [REF]], ["retrieveDatabase", [REF]], ["retrieveDataSource", [REF]],
    ["retrieveBlockChildren", [REF, "secret-cursor"]], ["queryDataSource", [REF, filter, undefined, options]],
  ] as const) assert.equal(await Reflect.apply(trace.client[method], trace.client, args), w.value);
  assert.equal(w.calls.length, 5);
  assert.equal(w.calls[4]!.args[1], filter); assert.equal(w.calls[4]!.args[2], undefined); assert.equal(w.calls[4]!.args[3], options);
  assert.equal(trace.snapshot().rows.length, 5);
  assert.deepEqual(Object.keys(trace.client).sort(), ["queryDataSource", "retrieveBlockChildren", "retrieveDataSource", "retrieveDatabase", "retrievePage"]);
  const output = JSON.stringify(trace.snapshot());
  assert(!output.includes("secret")); assert(!output.includes("page_size"));
});
test("W7.3 read trace: received status/code retained safely, original exception identity unchanged and no retry", async () => {
  for (const [status, code] of [[401, "unauthorized"], [403, "restricted_resource"], [404, "object_not_found"], [429, "rate_limited"], [503, "service_unavailable"], ["TIMEOUT", "secret-timeout"], ["TRANSPORT", "secret-network"]] as const) {
    const w = world(), error = new NotionApiError(status, code, false, false, "secret-body-token-url"); let calls = 0;
    w.client.retrievePage = async () => { calls++; throw error; };
    const trace = traceHistoricalReads(w.client);
    await assert.rejects(trace.client.retrievePage(REF), got => got === error);
    assert.equal(calls, 1);
    const row = trace.snapshot().rows[0]!;
    assert.equal(row.outcome, "ERROR"); assert.equal(row.failure!.status, status); assert.equal(row.failure!.class, "NotionApiError");
    assert.equal(row.failure!.notion_code, code.startsWith("secret") ? "WITHHELD" : code);
    assert(!JSON.stringify(row).includes("secret"));
  }
});
test("W7.3 read trace: unknown types/statuses/codes never stringify arbitrary error data", () => {
  for (const value of [null, undefined, "secret", 3, { status: "secret", notionCode: "secret", message: "secret" }, { status: 600, notionCode: { secret: true } }, { status: Number.NaN }]) {
    assert.deepEqual(safeReadFailure(value), { class: "UNKNOWN", status: "UNKNOWN", notion_code: "WITHHELD" });
  }
});
test("W7.3 read trace: getters/hostile proxies are not invoked or leaked", async () => {
  let getters = 0;
  const error = Object.create(null) as object;
  for (const key of ["status", "notionCode", "message", "stack", "constructor"]) Object.defineProperty(error, key, { get() { getters++; throw new Error("secret"); } });
  assert.deepEqual(safeReadFailure(error), { class: "UNKNOWN", status: "UNKNOWN", notion_code: "WITHHELD" });
  assert.equal(getters, 0);
  const hostile = new Proxy({}, { getPrototypeOf() { throw new Error("secret"); } });
  assert.deepEqual(safeReadFailure(hostile), { class: "UNKNOWN", status: "UNKNOWN", notion_code: "WITHHELD" });
  const w = world(); w.client.retrievePage = async () => { throw hostile; };
  await assert.rejects(traceHistoricalReads(w.client).client.retrievePage(REF), got => got === hostile);
});
test("W7.3 read trace: bounded trace loss is explicit, snapshot copies cannot mutate retained state", async () => {
  const w = world(), trace = traceHistoricalReads(w.client, 1);
  for (let i = 0; i < 3; i++) await trace.client.retrievePage(REF);
  assert.equal(w.calls.length, 3); const snapshot = trace.snapshot();
  assert.equal(snapshot.rows.length, 1); assert.equal(snapshot.dropped, 2); assert.equal(snapshot.total_attempts, 3); assert.equal(snapshot.complete, false);
  snapshot.rows[0]!.ref = "changed"; snapshot.rows.length = 0;
  assert.equal(trace.snapshot().rows[0]!.ref, REF);
});
test("W7.3 read trace: malformed reference metadata withheld, valid dashed UUID canonicalized", async () => {
  const w = world(), trace = traceHistoricalReads(w.client);
  await trace.client.retrievePage("secret-url-token");
  await trace.client.retrievePage(DASHED_REF);
  assert.equal(trace.snapshot().rows[0]!.ref, "INVALID_REF"); assert.equal(trace.snapshot().rows[1]!.ref, REF);
  assert.equal(w.calls[0]!.args[0], "secret-url-token", "metadata filtering must not change original arguments");
});
test("W7.3 read trace: clock failure or backwards/nonfinite time never replaces a result/error", async () => {
  for (const clock of [() => { throw new Error("secret"); }, () => Number.NaN, (() => { let n = 5; return () => n--; })()]) {
    const w = world(), trace = traceHistoricalReads(w.client, 2, clock);
    assert.equal(await trace.client.retrievePage(REF), w.value);
    const error = new Error("secret"); w.client.retrievePage = async () => { throw error; };
    await assert.rejects(trace.client.retrievePage(REF), got => got === error);
    assert.equal(trace.snapshot().rows[0]!.method_elapsed_ms, null); assert.equal(trace.snapshot().rows[1]!.method_elapsed_ms, null);
  }
});
test("W7.3 read trace: invalid bounds reject before accessing the client", () => {
  const client = new Proxy({} as NotionReadClient, { get() { throw new Error("CLIENT_ACCESSED"); } });
  for (const bound of [0, -1, 1.1, Number.NaN, Number.POSITIVE_INFINITY, 10001]) assert.throws(() => traceHistoricalReads(client, bound), /INVALID_TRACE_BOUND/);
});
