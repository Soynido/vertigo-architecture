/**
 * Packaged remote MCP endpoint (PV0-020): bearer token → principal at the transport layer; the five W3.3 tools discoverable;
 * unauthenticated or unknown tokens are refused before any tool runs; only POST /mcp is served.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FileHttpTokenRegistry, sha256, startHttpServer } from "../../src/server/http.ts";
import { buildWorld, OWNER } from "./binding-fixtures.ts";

async function withServer(fn: (url: URL) => Promise<void>) {
  const w = buildWorld();
  const tokens = new FileHttpTokenRegistry([{ token_sha256: sha256("good-token"), principal_id: OWNER.principal_id }, { token_sha256: sha256("path-token-0123456789abcdef"), principal_id: OWNER.principal_id }]);
  const s = await startHttpServer(w.deps, tokens, 0);
  try { await fn(new URL(`http://127.0.0.1:${s.port}/mcp`)); } finally { await s.close(); }
}
const client = async (url: URL, token?: string) => {
  const c = new Client({ name: "pkg-test", version: "0" });
  const t = new StreamableHTTPClientTransport(url, token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : {});
  await c.connect(t as unknown as Parameters<typeof c.connect>[0]);
  return c;
};

test("http transport: a mapped bearer token yields the principal; the five tools are discoverable and callable", async t => {
  const lines: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => lines.push(args.join(" ")));
  await withServer(async (url) => {
    const c = await client(url, "good-token");
    try {
      assert.deepEqual((await c.listTools()).tools.map((t) => t.name), ["os_bind", "os_resume", "os_commit", "os_handoff", "os_control_status"]);
      const r = await c.callTool({ name: "os_bind", arguments: { project: "VERTIGO", lane: "META" } });
      const env = JSON.parse((r.content as Array<{ text: string }>)[0]?.text ?? "{}") as { code: string };
      assert.equal(env.code, "BOUND");
    } finally { await c.close(); }
  });
  const end = lines.find(l => l.includes("tool=os_bind") && l.includes("event=END")); assert.ok(end);
  const request = end.match(/request=([a-f0-9]{16})(?: |$)/)?.[1]; assert.ok(request);
  const sameRequest = lines.filter(l => l.includes(`request=${request}`));
  assert.ok(sameRequest.some(l => l.includes("event=HTTP_START")));
  assert.ok(sameRequest.some(l => l.includes("event=HTTP_AUTH") && l.includes("auth=ACCEPTED")));
  assert.ok(sameRequest.some(l => l.includes("event=HTTP_END") && l.includes("delivery=FINISHED") && l.includes("http_status=200")));
});

test("http transport: the token may travel as the /mcp/<token> path segment for connector UIs without a bearer option", async () => {
  await withServer(async (url) => {
    const c = await client(new URL("/mcp/path-token-0123456789abcdef", url));
    try { assert.equal((await c.listTools()).tools.length, 5); } finally { await c.close(); }
    await assert.rejects(client(new URL("/mcp/wrong-token-0123456789abcdef", url)), /unauthenticated/);
    await assert.rejects(client(new URL("/mcp/good-token", url)), /unauthenticated/, "path tokens shorter than 16 characters are never accepted");
  });
});

test("http transport: missing or unknown bearer tokens are refused before any tool runs; only POST /mcp is served", async () => {
  await withServer(async (url) => {
    await assert.rejects(client(url), /unauthenticated/);
    await assert.rejects(client(url, "wrong-token"), /unauthenticated/);
    assert.equal((await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" })).status, 401);
    const get = await fetch(url, { method: "GET" });
    assert.equal(get.status, 405);
    const other = await fetch(new URL("/notion/pages", url), { method: "POST", headers: { authorization: "Bearer good-token" } });
    assert.equal(other.status, 405, "no other path exists on the harness endpoint");
  });
});

test("http traces distinguish arrival/auth refusal without any tool execution or private content", async t => {
  const lines: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => lines.push(args.join(" ")));
  await withServer(async url => {
    const r = await fetch(url, { method: "POST", headers: { authorization: "Bearer private-rejected-secret",
      "user-agent": "private@example.invalid", "content-type": "application/json" }, body: '{"private":"never-log-this"}' });
    assert.equal(r.status, 401); await r.text();
  });
  const start = lines.find(l => l.includes("event=HTTP_START"));
  assert.ok(start, "arrival is visible even before auth or any tool dispatch");
  const request = start.match(/request=([a-f0-9]{16})(?: |$)/)?.[1]; assert.ok(request);
  assert.ok(lines.some(l => l.includes(`request=${request}`) && l.includes("auth=DENIED")));
  assert.ok(lines.some(l => l.includes(`request=${request}`) && l.includes("event=HTTP_END") && l.includes("http_status=401")));
  assert.ok(lines.every(l => !l.includes("tool=")), "auth refusal cannot be mistaken for a business HOLD");
  assert.doesNotMatch(lines.join("\n"), /private-rejected-secret|private@example.invalid|never-log-this/);
});

test("HTTP auth diagnostics distinguish missing, malformed, unrecognized and mapped credentials without exposing them", async t => {
  const lines: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => lines.push(args.join(" ")));
  await withServer(async url => {
    const send = async (path: string, authorization?: string) => {
      const begin = lines.length;
      const r = await fetch(new URL(path, url), { method: "POST", headers: authorization ? { authorization } : {}, body: "{}" });
      await r.text();
      return lines.slice(begin).find(line => line.includes("event=HTTP_AUTH")) ?? "";
    };
    assert.match(await send("/mcp"), /bearer=ABSENT path=ABSENT path_enabled=true source=NONE/);
    assert.match(await send("/mcp", "Basic private-secret"), /bearer=MALFORMED path=ABSENT path_enabled=true source=NONE/);
    assert.match(await send("/mcp", "Bearer private-secret"), /bearer=UNMAPPED path=ABSENT path_enabled=true source=NONE/);
    assert.match(await send("/mcp/private-short"), /bearer=ABSENT path=MALFORMED path_enabled=true source=NONE/);
    assert.match(await send("/mcp/private-wrong-token-0123456789"), /bearer=ABSENT path=UNMAPPED path_enabled=true source=NONE/);
    assert.match(await send("/mcp/path-token-0123456789abcdef"), /bearer=ABSENT path=MAPPED path_enabled=true source=PATH/);
    assert.match(await send("/mcp/private-wrong-token-0123456789", "Bearer good-token"), /bearer=MAPPED path=NOT_CHECKED path_enabled=true source=BEARER/);
    assert.match(await send("/mcp/path-token-0123456789abcdef", "Bearer private-secret"), /bearer=UNMAPPED path=MAPPED path_enabled=true source=PATH/);
  });
  assert.doesNotMatch(lines.join("\n"), /private-secret|private-short|private-wrong-token|path-token-0123456789abcdef|good-token/);
  assert.ok(lines.every(line => line.length <= 640));
});

test("HTTP auth diagnostics preserve disabled path fallback and registry lookup short circuit", async t => {
  const lines: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => lines.push(args.join(" ")));
  const observed: string[] = [];
  const w = buildWorld();
  const tokens = { principalFor: (credential: string) => { observed.push(credential); return credential === "header-secret" ? OWNER.principal_id : undefined; } };
  const s = await startHttpServer(w.deps, tokens, 0, "127.0.0.1", false);
  const url = `http://127.0.0.1:${s.port}/mcp/path-private-secret-0123456789`;
  try {
    const denied = await fetch(url, { method: "POST", body: "{}" });
    assert.equal(denied.status, 401); await denied.text();
    assert.deepEqual(observed, []);
    assert.match(lines.find(l => l.includes("event=HTTP_AUTH")) ?? "", /bearer=ABSENT path=DISABLED path_enabled=false source=NONE/);
    const begin = lines.length;
    const response = await fetch(url, { method: "POST", headers: { authorization: "Bearer header-secret" }, body: "{}" });
    await response.text();
    assert.deepEqual(observed, ["header-secret"]);
    assert.match(lines.slice(begin).find(l => l.includes("event=HTTP_AUTH")) ?? "", /bearer=MAPPED path=DISABLED path_enabled=false source=BEARER/);
    assert.doesNotMatch(lines.join("\n"), /header-secret|path-private-secret/);
  } finally { await s.close(); }
});
