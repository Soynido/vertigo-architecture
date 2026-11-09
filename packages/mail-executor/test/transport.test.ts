/** Protected transport classification: accepted → SENT with ids; 4xx → FAILED; 5xx/network/timeout → AMBIGUOUS (fail closed). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GmailRestCompetentSource, GmailRestTransport, rfc822 } from "../src/transport/gmailRest.ts";

const env = { from: "rep@example.invalid", to: "prospect@example.invalid", subject: "S", body: "B", headers: { "X-Vertigo-Action-Key": "ak-1" } };

test("transport: outcome classification is fail-closed and the raw message carries the action key header", async () => {
  const calls: string[] = [];
  const mk = (status: number, body: unknown = {}) => new GmailRestTransport(async (url) => { calls.push(url); return { status, json: async () => body }; }, async () => "tok");
  assert.deepEqual(await mk(200, { id: "m1", threadId: "t1" }).send(env), { status: "SENT", message_id: "m1", thread_id: "t1" });
  assert.equal((await mk(200, {}).send(env)).status, "AMBIGUOUS");
  assert.equal((await mk(400).send(env)).status, "FAILED");
  assert.equal((await mk(403).send(env)).status, "FAILED");
  assert.equal((await mk(500).send(env)).status, "AMBIGUOUS");
  assert.equal((await new GmailRestTransport(async () => { throw new Error("socket hang up"); }, async () => "tok").send(env)).status, "AMBIGUOUS");
  assert.ok(calls.every((u) => u.endsWith("/messages/send")));
  assert.match(rfc822(env), /X-Vertigo-Action-Key: ak-1\r\n\r\nB$/);
});

test("competent source: identity from the profile, unavailable on any non-2xx", async () => {
  const ok = new GmailRestCompetentSource(async () => ({ status: 200, json: async () => ({ emailAddress: "Rep@Example.invalid" }) }), async () => "tok");
  assert.equal(await ok.identity(), "rep@example.invalid");
  const bad = new GmailRestCompetentSource(async () => ({ status: 401, json: async () => ({}) }), async () => "tok");
  assert.equal(await bad.identity(), "UNKNOWN");
  assert.equal(await bad.searchSent({ recipient: "x@example.invalid", since: "2030-01-01T00:00:00.000Z", until: "2030-01-02T00:00:00.000Z" }), "UNAVAILABLE");
  assert.equal(await bad.thread("t"), "UNAVAILABLE");
});
