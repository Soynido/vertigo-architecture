/**
 * PT-CLIENT-001 — the Notion client reaches only allowlisted reads and the two allowlisted writes, with exact bodies.
 * PT-CLIENT-002 — retry discipline: 429 is retried (never applied); a failed write is never resent here and is
 * classified (ambiguous or not, retryable or not). PV-WRITE-001 / W1.1.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as drain } from "node:timers/promises";
import { assertReadOnly, assertWriteAllowed, HttpNotionClient, NotionApiError, NotionWriteRefused, type NotionHttp } from "../../src/notion/client.ts";

const PAGE = "0123456789abcdef0123456789abcdef";
/** A second synthetic id, derived from the tolerated placeholder so no id literal sits in the source (PT-ARCH-002). */
const DS = [...PAGE].reverse().join("");
/** The same page id as Notion returns it, dashed; built here so no dashed id literal sits in the source (PT-ARCH-002). */
const PAGE_DASHED = PAGE.replace(/^(.{8})(.{4})(.{4})(.{4})/, "$1-$2-$3-$4-");
const CTX = { plan_id: "plan-test", symbol: "row_1" };
const TITLE = { Name: { title: [{ text: { content: "x" } }] } };

type Call = { url: string; method: string; body: unknown };
function recorder(responses: Array<{ status: number; body?: unknown; retryAfter?: string } | Error>) {
  const calls: Call[] = [];
  const http: NotionHttp = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const next = responses.length > 1 ? responses.shift()! : responses[0]!;
    if (next instanceof Error) throw next;
    return { status: next.status, headers: { get: (h: string) => (h === "retry-after" ? next.retryAfter ?? "0" : null) }, json: async () => next.body ?? {} };
  };
  return { calls, http };
}
const client = (http: NotionHttp, max429Retries = 2) => new HttpNotionClient("token", http, { max429Retries, retryBaseMs: 0 });
const refused = (fn: () => unknown) => assert.throws(fn, NotionWriteRefused);

test("PT-CLIENT-001/a: every non-allowlisted route is refused before the network", () => {
  refused(() => assertWriteAllowed("DELETE", `/pages/${PAGE}`, {}));
  refused(() => assertWriteAllowed("DELETE", `/blocks/${PAGE}`, {}));
  refused(() => assertWriteAllowed("PATCH", `/blocks/${PAGE}`, { archived: true }));
  refused(() => assertWriteAllowed("PATCH", `/blocks/${PAGE}/children`, { children: [] }));
  refused(() => assertWriteAllowed("POST", "/databases", { parent: {}, properties: {} }));
  refused(() => assertWriteAllowed("PATCH", `/databases/${PAGE}`, { properties: {} }));
  refused(() => assertWriteAllowed("PATCH", `/data_sources/${PAGE}`, { properties: {} }));
  refused(() => assertWriteAllowed("POST", "/comments", { parent: { page_id: PAGE }, rich_text: [] }));
  refused(() => assertWriteAllowed("PATCH", `/pages/${PAGE}/properties/title`, { properties: {} }));
  // The read guard still refuses every write route.
  refused(() => assertReadOnly("POST", "/pages"));
  refused(() => assertReadOnly("PATCH", `/pages/${PAGE}`));
});

test("PT-CLIENT-001/b: a PATCH carries properties only — archived, in_trash, icon, cover, content are refused", () => {
  assert.doesNotThrow(() => assertWriteAllowed("PATCH", `/pages/${PAGE}`, { properties: TITLE }));
  for (const extra of ["archived", "in_trash", "icon", "cover", "children", "parent"]) {
    refused(() => assertWriteAllowed("PATCH", `/pages/${PAGE}`, { properties: TITLE, [extra]: extra === "archived" || extra === "in_trash" ? true : {} }));
  }
  refused(() => assertWriteAllowed("PATCH", `/pages/${PAGE}`, { archived: true }));
  refused(() => assertWriteAllowed("PATCH", `/pages/${PAGE}`, { properties: [] }));
  refused(() => assertWriteAllowed("PATCH", `/pages/${PAGE}`, null));
});

test("PT-CLIENT-001/c: a POST /pages has a data_source_id parent and properties only", () => {
  const ok = { parent: { type: "data_source_id", data_source_id: DS }, properties: TITLE };
  assert.doesNotThrow(() => assertWriteAllowed("POST", "/pages", ok));
  refused(() => assertWriteAllowed("POST", "/pages", { parent: { type: "page_id", page_id: PAGE }, properties: TITLE }));
  refused(() => assertWriteAllowed("POST", "/pages", { parent: { type: "database_id", database_id: PAGE }, properties: TITLE }));
  refused(() => assertWriteAllowed("POST", "/pages", { parent: { data_source_id: DS }, properties: TITLE }));
  refused(() => assertWriteAllowed("POST", "/pages", { parent: { type: "data_source_id", data_source_id: DS, page_id: PAGE }, properties: TITLE }));
  refused(() => assertWriteAllowed("POST", "/pages", { parent: { type: "data_source_id", data_source_id: "" }, properties: TITLE }));
  refused(() => assertWriteAllowed("POST", "/pages", { ...ok, children: [] }));
  refused(() => assertWriteAllowed("POST", "/pages", { ...ok, icon: { emoji: "x" } }));
  refused(() => assertWriteAllowed("POST", "/pages", { parent: ok.parent }));
});

test("PT-CLIENT-001/d: createPage and updatePage send exactly the allowlisted request; reads are unchanged", async () => {
  const { calls, http } = recorder([{ status: 200, body: { id: PAGE_DASHED, last_edited_time: "2026-09-24T10:00:00.000Z" } }]);
  const c = client(http);
  assert.deepEqual(await c.createPage(DS, TITLE, CTX), { id: PAGE, last_edited_time: "2026-09-24T10:00:00.000Z" });
  assert.deepEqual(await c.updatePage(PAGE, TITLE, CTX), { id: PAGE, last_edited_time: "2026-09-24T10:00:00.000Z" });
  await c.retrievePage(PAGE);
  await c.queryDataSource(DS, { property: "Name", title: { equals: "x" } });
  assert.deepEqual(calls.map((x) => `${x.method} ${x.url}`), [
    "POST https://api.notion.com/v1/pages",
    `PATCH https://api.notion.com/v1/pages/${PAGE}`,
    `GET https://api.notion.com/v1/pages/${PAGE}`,
    `POST https://api.notion.com/v1/data_sources/${DS}/query`,
  ]);
  assert.deepEqual(calls[0]!.body, { parent: { type: "data_source_id", data_source_id: DS }, properties: TITLE });
  assert.deepEqual(calls[1]!.body, { properties: TITLE });
  // A page id that is not an id cannot smuggle another route.
  await assert.rejects(c.updatePage(`${PAGE}/children`, TITLE, CTX), NotionWriteRefused);
  assert.equal(calls.length, 4);
});

test("PT-CLIENT-001/e: the client exposes the five reads and the two writes, nothing else", () => {
  const methods = Object.getOwnPropertyNames(HttpNotionClient.prototype).filter((m) => m !== "constructor").sort();
  assert.deepEqual(methods, ["createPage", "queryDataSource", "retrieveBlockChildren", "retrieveDataSource", "retrieveDatabase", "retrievePage", "updatePage"]);
});

test("PT-CLIENT-002/a: a write refused with 429 is retried, then succeeds; exhaustion is classified, never ambiguous", async () => {
  const ok = { status: 200, body: { id: PAGE, last_edited_time: "t" } };
  const r = recorder([{ status: 429 }, { status: 429 }, ok]);
  assert.equal((await client(r.http).createPage(DS, TITLE, CTX)).id, PAGE);
  assert.equal(r.calls.length, 3);

  const x = recorder([{ status: 429 }]);
  const err = await client(x.http, 1).updatePage(PAGE, TITLE, CTX).catch((e) => e);
  assert.ok(err instanceof NotionApiError);
  assert.deepEqual([err.status, err.notionCode, err.ambiguous, err.retryable], [429, "rate_limited", false, true]);
  assert.equal(x.calls.length, 2);
});

test("PT-CLIENT-002/b: a write that fails with 5xx, timeout or transport is never resent and is ambiguous", async () => {
  for (const status of [500, 502, 503, 504]) {
    const r = recorder([{ status, body: { code: "internal_server_error" } }]);
    const err = await client(r.http).createPage(DS, TITLE, CTX).catch((e) => e);
    assert.ok(err instanceof NotionApiError);
    assert.deepEqual([err.status, err.ambiguous, err.retryable], [status, true, true]);
    assert.equal(r.calls.length, 1, `status ${status} must not be resent`);
  }
  const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  for (const [thrown, status] of [[timeout, "TIMEOUT"], [new TypeError("fetch failed"), "TRANSPORT"]] as const) {
    const r = recorder([thrown]);
    const err = await client(r.http).updatePage(PAGE, TITLE, CTX).catch((e) => e);
    assert.ok(err instanceof NotionApiError);
    assert.deepEqual([err.status, err.ambiguous, err.retryable], [status, true, true]);
    assert.equal(r.calls.length, 1);
  }
  const malformed = recorder([{ status: 200, body: {} }]);
  const err = await client(malformed.http).createPage(DS, TITLE, CTX).catch((e) => e);
  assert.ok(err instanceof NotionApiError && err.ambiguous && !err.retryable);
});

test("PT-CLIENT-002/c: a write refused with 4xx is classified with Notion's code, not ambiguous, not resent", async () => {
  const cases: Array<[number, string, boolean]> = [[400, "validation_error", false], [404, "object_not_found", false], [403, "restricted_resource", false], [409, "conflict_error", true]];
  for (const [status, code, retryable] of cases) {
    const r = recorder([{ status, body: { object: "error", code } }]);
    const err = await client(r.http).updatePage(PAGE, TITLE, CTX).catch((e) => e);
    assert.ok(err instanceof NotionApiError);
    assert.deepEqual([err.status, err.notionCode, err.ambiguous, err.retryable], [status, code, false, retryable]);
    assert.equal(r.calls.length, 1);
  }
});

test("PT-CLIENT-002/d: reads keep their behavior — 429 retried, 4xx/5xx classified, messages unchanged", async () => {
  const r = recorder([{ status: 429 }, { status: 200, body: { object: "page" } }]);
  assert.deepEqual(await client(r.http).retrievePage(PAGE), { object: "page" });
  const e = recorder([{ status: 404, body: { code: "object_not_found" } }]);
  const err = await client(e.http).retrievePage(PAGE).catch((x) => x);
  assert.ok(err instanceof NotionApiError);
  assert.match(err.message, /^notion read failed 404 for GET \/pages\//);
  assert.deepEqual([err.notionCode, err.ambiguous], ["object_not_found", false]);
});

test("PT-CLIENT-002/e: the token bucket paces reads and writes together", async () => {
  const r = recorder([{ status: 200, body: { id: PAGE, last_edited_time: "t" } }]);
  const c = new HttpNotionClient("token", r.http, { ratePerSecond: 20, burst: 1, retryBaseMs: 0 });
  const start = Date.now();
  await Promise.all([c.retrievePage(PAGE), c.updatePage(PAGE, TITLE, CTX), c.retrievePage(PAGE), c.createPage(DS, TITLE, CTX)]);
  // Burst 1 at 20/s: the first request is immediate, the next three wait ~50ms each.
  assert.ok(Date.now() - start >= 130, `paced in ${Date.now() - start}ms`);
  assert.equal(r.calls.length, 4);
});

test("R5 canary: burst10/rate2.8 bounds every rolling60s window across reads and writes", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const starts: number[] = [];
  const c = new HttpNotionClient("token", async () => {
    starts.push(Date.now()); return { status: 200, json: async () => ({ id: PAGE }) };
  }, { ratePerSecond: 2.8, burst: 10, shared429Cooldown: true });
  const work = Array.from({ length: 400 }, (_, i) => i % 2 ? c.updatePage(PAGE, TITLE, CTX) : c.retrievePage(PAGE));
  await drain(); assert.equal(starts.length, 10);
  // Advance the fake clock without real sleeps; requests pass the actual client queue.
  for (let ms = 0; ms < 145000; ms += 100) { t.mock.timers.tick(100); await drain(); }
  await Promise.all(work);
  for (const start of starts) assert.ok(starts.filter((ms) => ms >= start && ms < start + 60000).length <= 178);
});

test("R5 canary: exhausted429 pauses reads, permanently refuses writes; default stays unchanged", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  for (const shared of [false, true]) {
    const r = recorder([{ status: 429, retryAfter: "1" }, { status: 200, body: { id: PAGE } }]);
    const c = new HttpNotionClient("token", r.http, { max429Retries: 0, shared429Cooldown: shared });
    await assert.rejects(c.retrievePage(PAGE), NotionApiError);
    const queued = Promise.all([c.retrievePage(PAGE), c.retrievePage(PAGE)]);
    await drain(); assert.equal(r.calls.length, shared ? 1 : 3);
    if (shared) {
      t.mock.timers.tick(999); await drain(); assert.equal(r.calls.length, 1);
      t.mock.timers.tick(1); await drain();
    }
    await queued; assert.equal(r.calls.length, 3);
    // Even after Retry-After expires, only a fresh instance may admit a freshly guarded write.
    if (shared) {
      await assert.rejects(c.updatePage(PAGE, TITLE, CTX), (e: unknown) => e instanceof NotionApiError && !e.ambiguous && e.retryable);
      assert.equal(r.calls.length, 3);
    } else { await c.updatePage(PAGE, TITLE, CTX); assert.equal(r.calls.length, 4); }
  }
});

test("R5 canary: late concurrent429 extends the pause instead of releasing queued requests early", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const replies: Array<(r: { status: number; headers: { get(): string }; json(): Promise<unknown> }) => void> = [];
  let count = 0;
  const c = new HttpNotionClient("token", async () => {
    count += 1;
    if (count <= 2) return new Promise((resolve) => replies.push(resolve));
    return { status: 200, json: async () => ({ id: PAGE }) };
  }, { max429Retries: 0, shared429Cooldown: true });
  const a = c.retrievePage(PAGE).catch((e: unknown) => e), b = c.retrievePage(PAGE).catch((e: unknown) => e);
  await drain(); assert.equal(count, 2);
  const limited = { status: 429, headers: { get: () => "1" }, json: async () => ({}) };
  replies[0]!(limited); await a;
  const pending = c.retrievePage(PAGE);
  await drain(); t.mock.timers.tick(500); replies[1]!(limited); await b;
  t.mock.timers.tick(500); await drain(); assert.equal(count, 2);
  t.mock.timers.tick(499); await drain(); assert.equal(count, 2);
  t.mock.timers.tick(1); await drain(); await pending; assert.equal(count, 3);
});

test("R5 canary:429 arriving during token wait refuses queued write without dispatch", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  let firstReply!: (r: { status: number; headers: { get(): string }; json(): Promise<unknown> }) => void;
  let count = 0;
  const c = new HttpNotionClient("token", async () => {
    count += 1;
    if (count === 1) return new Promise((resolve) => { firstReply = resolve; });
    return { status: 200, json: async () => ({ id: PAGE }) };
  }, { ratePerSecond: 2, burst: 1, max429Retries: 0, shared429Cooldown: true });
  const first = c.retrievePage(PAGE).catch((e: unknown) => e);
  await drain(); const next = c.updatePage(PAGE, TITLE, CTX).catch((e: unknown) => e); await drain();
  t.mock.timers.tick(100); firstReply({ status: 429, headers: { get: () => "1" }, json: async () => ({}) }); await first;
  t.mock.timers.tick(400); await drain(); assert.equal(count, 1);
  t.mock.timers.tick(599); await drain(); assert.equal(count, 1);
  t.mock.timers.tick(1); await drain(); assert.ok((await next) instanceof NotionApiError); assert.equal(count, 1);
});

test("R5 canary: write429 stops after ONE attempt, registers cooldown and cannot internally resend", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const r = recorder([{ status: 429 }]);
  const c = new HttpNotionClient("token", r.http, { max429Retries: 3, retryBaseMs: 0, shared429Cooldown: true });
  await assert.rejects(c.createPage(DS, TITLE, CTX), (e: unknown) => e instanceof NotionApiError && e.status === 429 && !e.ambiguous && e.retryable);
  assert.equal(r.calls.length, 1);
  await assert.rejects(c.updatePage(PAGE, TITLE, CTX), NotionApiError);
  assert.equal(r.calls.length, 1);
});

test("R5 canary:429 while queued behind another request refuses write even after pause expires", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  let limited!: (r: { status: number; headers: { get(): string }; json(): Promise<unknown> }) => void;
  let count = 0;
  const c = new HttpNotionClient("token", async () => {
    count += 1;
    if (count === 1) return new Promise((resolve) => { limited = resolve; });
    return { status: 200, json: async () => ({ id: PAGE }) };
  }, { minimumIntervalMs: 500, max429Retries: 0, shared429Cooldown: true });
  const first = c.retrievePage(PAGE).catch((e: unknown) => e);
  await drain(); const reader = c.retrievePage(PAGE), writer = c.updatePage(PAGE, TITLE, CTX).catch((e: unknown) => e);
  await drain(); limited({ status: 429, headers: { get: () => "1" }, json: async () => ({}) }); await first;
  t.mock.timers.tick(1000); await drain(); await reader;
  t.mock.timers.tick(500); await drain(); assert.ok((await writer) instanceof NotionApiError); assert.equal(count, 2);
});

test("R5 canary: without429 successful writes and ambiguous5xx classification stay unchanged", async () => {
  const r = recorder([{ status: 200, body: { id: PAGE } }, { status: 503, body: { code: "service_unavailable" } }]);
  const c = new HttpNotionClient("token", r.http, { shared429Cooldown: true });
  assert.equal((await c.createPage(DS, TITLE, CTX)).id, PAGE);
  await assert.rejects(c.updatePage(PAGE, TITLE, CTX), (e: unknown) => e instanceof NotionApiError && e.ambiguous && e.status === 503);
  assert.equal(r.calls.length, 2);
});

test("R5 cutoff: explicit option needs shared barrier; no silent unsafe standalone mode", () => {
  const r = recorder([{ status: 200 }]);
  assert.throws(() => new HttpNotionClient("token", r.http, { abortReadsOn429: true }), /shared429Cooldown/);
  assert.equal(r.calls.length, 0);
});

test("R5 cutoff: first read429 never retries; all later reads/writes reject rather than empty proof", async () => {
  const r = recorder([{ status: 429 }, { status: 200, body: { results: [] } }]);
  const c = new HttpNotionClient("token", r.http, { shared429Cooldown: true, abortReadsOn429: true,
    max429Retries: 4, retryBaseMs: 0 });
  const limited = (e: unknown) => e instanceof NotionApiError && e.status === 429 && !e.ambiguous && e.retryable;
  await assert.rejects(c.retrievePage(PAGE), limited);
  await assert.rejects(c.queryDataSource(DS, undefined), limited);
  await assert.rejects(c.retrieveDataSource(DS), limited);
  await assert.rejects(c.updatePage(PAGE, TITLE, CTX), limited);
  assert.equal(r.calls.length, 1, "no retry, no post-latch network");
});

test("R5 cutoff: queued token-wait reads and writes remain closed after cooldown expires", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  let limited!: (r: { status: number; headers: { get(): string }; json(): Promise<unknown> }) => void;
  let count = 0;
  const c = new HttpNotionClient("token", async () => {
    count += 1;
    if (count === 1) return new Promise((resolve) => { limited = resolve; });
    return { status: 200, json: async () => ({ id: PAGE }) };
  }, { ratePerSecond: 2, burst: 1, max429Retries: 0, shared429Cooldown: true, abortReadsOn429: true });
  const first = c.retrievePage(PAGE).catch((e: unknown) => e);
  await drain();
  const reader = c.retrievePage(PAGE).catch((e: unknown) => e), writer = c.updatePage(PAGE, TITLE, CTX).catch((e: unknown) => e);
  await drain(); limited({ status: 429, headers: { get: () => "1" }, json: async () => ({}) });
  assert.ok((await first) instanceof NotionApiError);
  t.mock.timers.tick(2000); await drain();
  assert.ok((await reader) instanceof NotionApiError); assert.ok((await writer) instanceof NotionApiError);
  await assert.rejects(c.retrievePage(PAGE), NotionApiError);
  assert.equal(count, 1, "no dispatch after latch, even beyond Retry-After");
});

test("R5 cutoff: already-inflight read may finish; no queued retry, successful paths stay normal", async () => {
  const replies: Array<(r: { status: number; json(): Promise<unknown> }) => void> = [];
  let count = 0;
  const c = new HttpNotionClient("token", async () => {
    count += 1;
    if (count > 2) return { status: 200, json: async () => ({ id: PAGE }) };
    return new Promise((resolve) => replies.push(resolve));
  }, { shared429Cooldown: true, abortReadsOn429: true, max429Retries: 4, retryBaseMs: 0 });
  const first = c.retrievePage(PAGE).catch((e: unknown) => e), inflight = c.retrievePage(PAGE);
  await drain(); assert.equal(count, 2);
  replies[0]!({ status: 429, json: async () => ({}) });
  assert.ok((await first) instanceof NotionApiError);
  replies[1]!({ status: 200, json: async () => ({ id: PAGE }) });
  assert.deepEqual(await inflight, { id: PAGE });
  await assert.rejects(c.queryDataSource(DS, undefined), NotionApiError);
  assert.equal(count, 2);
  const r = recorder([{ status: 200, body: { id: PAGE } }]);
  const normal = new HttpNotionClient("token", r.http, { shared429Cooldown: true, abortReadsOn429: true });
  assert.deepEqual(await normal.retrievePage(PAGE), { id: PAGE });
  assert.equal((await normal.createPage(DS, TITLE, CTX)).id, PAGE);
  assert.equal(r.calls.length, 2);
});

test("R5 cutoff: a write429 also closes reads; no internal resend or read fallback", async () => {
  const r = recorder([{ status: 429 }, { status: 200, body: { id: PAGE } }]);
  const c = new HttpNotionClient("token", r.http, { shared429Cooldown: true, abortReadsOn429: true, retryBaseMs: 0 });
  await assert.rejects(c.createPage(DS, TITLE, CTX), NotionApiError);
  await assert.rejects(c.retrievePage(PAGE), NotionApiError);
  assert.equal(r.calls.length, 1);
});
