/**
 * PT-SEC-001..003 — a live credential must never reach a log line, a response body or a runtime artifact.
 *
 * The remote MCP endpoint accepts its bearer token in the `Authorization` header OR as the path segment
 * `/mcp/<token>`, because some connector UIs cannot send headers. Both are live credentials. `.run/harness.log`
 * and `.run/tunnel.log` outlive any token's usefulness and are read by operators and shipped to support, so the
 * access line, the error body and the runtime artifacts are all held to the same standard.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { REDACTED, redactSecrets, redactUrl } from "../../src/server/redact.ts";
import { FileHttpTokenRegistry, handleMcpRequest, sha256 } from "../../src/server/http.ts";
import { buildWorld, OWNER } from "./binding-fixtures.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

const LIVE = "live-token-0123456789abcdefghij";

test("PT-SEC-001/a: the /mcp/<token> path segment is redacted wherever it appears", () => {
  assert.equal(redactUrl(`/mcp/${LIVE}`), "/mcp/<token>");
  assert.equal(redactUrl(`/mcp/${LIVE}/`), "/mcp/<token>/");
  assert.equal(redactUrl(`/mcp/${LIVE}?x=1`), "/mcp/<token>?x=1");
  assert.equal(redactUrl("/mcp"), "/mcp");
  for (const raw of [`/mcp/${LIVE}`, `/mcp/${LIVE}?a=b#frag`]) assert.doesNotMatch(redactUrl(raw), new RegExp(LIVE));
});

test("PT-SEC-001/b: credential-bearing query values are redacted; ordinary ones survive", () => {
  for (const key of ["token", "access_token", "refresh_token", "id_token", "api_key", "apikey", "key", "bearer", "auth", "authorization", "secret", "password", "sig", "signature"]) {
    const out = redactUrl(`/mcp?${key}=${LIVE}`);
    assert.equal(out, `/mcp?${key}=${REDACTED}`, key);
    assert.doesNotMatch(out, new RegExp(LIVE), key);
  }
  // Case-insensitive and URL-encoded keys are covered too; harmless parameters are left readable.
  assert.equal(redactUrl(`/mcp?TOKEN=${LIVE}`), `/mcp?TOKEN=${REDACTED}`);
  assert.equal(redactUrl("/mcp?page=2&lane=SALES"), "/mcp?page=2&lane=SALES");
  assert.equal(redactUrl(`/mcp?page=2&token=${LIVE}&lane=SALES`), `/mcp?page=2&token=${REDACTED}&lane=SALES`);
});

test("PT-SEC-001/c: free-form text (error messages, stack traces) is redacted too", () => {
  const cases = [
    `Authorization: Bearer ${LIVE}`,
    `fetch failed for https://os.example.invalid/mcp/${LIVE}`,
    `upstream said {"authorization":"Bearer ${LIVE}"}`,
    `GET /x?access_token=${LIVE} -> 500`,
    `X-Api-Key: ${LIVE}`,
  ];
  for (const raw of cases) {
    const out = redactSecrets(raw);
    assert.doesNotMatch(out, new RegExp(LIVE), raw);
    assert.match(out, /<redacted>|\/mcp\/<token>/, raw);
  }
});

/** Minimal fake request/response so the real access-log path runs without opening a socket. */
function fakeExchange(url: string, headers: Record<string, string> = {}) {
  const finish: Array<() => void> = [];
  const res = {
    statusCode: 405, headersSent: false,
    writeHead(status: number) { res.statusCode = status; res.headersSent = true; return res; },
    end(body?: string) { res.body = body ?? ""; for (const f of finish) f(); return res; },
    on(event: string, handler: () => void) { if (event === "finish") finish.push(handler); return res; },
    body: "",
  };
  const response = res as unknown as ServerResponse;
  const req = { url, method: "GET", headers: { "user-agent": "probe", ...headers } } as unknown as IncomingMessage;
  return { req, res: response, seen: res };
}

test("PT-SEC-002: the access line and the 401 body never contain the token, however it travelled", async () => {
  const w = buildWorld();
  const tokens = new FileHttpTokenRegistry([{ token_sha256: sha256(LIVE), principal_id: OWNER.principal_id }]);
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    for (const [url, headers] of [
      [`/mcp/${LIVE}`, {}],
      [`/mcp?token=${LIVE}`, {}],
      ["/mcp", { authorization: `Bearer ${LIVE}` }],
      [`/mcp/${LIVE}?access_token=${LIVE}`, { authorization: `Bearer ${LIVE}` }],
    ] as Array<[string, Record<string, string>]>) {
      const { req, res, seen } = fakeExchange(url, headers);
      await handleMcpRequest(w.deps, tokens, req, res);
      assert.doesNotMatch(seen.body, new RegExp(LIVE), `response body leaked the token for ${url}`);
    }
  } finally { console.error = original; }

  assert.ok(lines.length >= 4, `expected one access line per request, got ${lines.length}`);
  for (const line of lines) {
    assert.doesNotMatch(line, new RegExp(LIVE), `access log leaked the token: ${line}`);
    assert.match(line, /event=HTTP_(?:START|END)/, line);
    assert.ok(line.length <= 640);
  }
  assert.equal(lines.filter(l => l.includes("event=HTTP_START")).length, 4);
  assert.equal(lines.filter(l => l.includes("event=HTTP_END") && l.includes("http_status=405")).length, 4);
  assert.ok(lines.every(l => !l.includes("/mcp") && !l.includes("ua=") && !l.includes("token=")),
    "access traces retain no URL, query or user-agent content");
});

test("PT-SEC-003: the deployment script keeps .run owner-only (0700 directories, 0600 files)", async () => {
  const serve = await readFile(fileURLToPath(new URL("../../../../scripts/serve.sh", import.meta.url)), "utf8");
  assert.match(serve, /^umask 077$/m, "serve.sh must set umask 077 BEFORE any redirection creates a log file");
  assert.match(serve, /chmod 700 "\$RUN_DIR"/, "the run directory must be owner-only");
  assert.match(serve, /find "\$RUN_DIR" -type d -exec chmod 700/, "inherited run directories must be tightened");
  assert.match(serve, /find "\$RUN_DIR" -type f -exec chmod 600/, "inherited run files must be tightened");
  // umask must precede the first redirection into $RUN_DIR, otherwise the log is created world-readable.
  assert.ok(serve.indexOf("umask 077") < serve.indexOf('> "$RUN_DIR/harness.log"'), "umask 077 comes too late");
});
