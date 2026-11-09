/**
 * PV-CRED-001 — one credential per seller, and the URL stops being one.
 *
 * A single token travelled in the URL path and that URL was baked into the plugin archive. Three consequences
 * made it unshippable to a team: the archive was itself a secret, so one had to be built per person; anything
 * that quotes a URL quotes the credential, which is how Valentin's token reached a working chat on 2026-09-23;
 * and a leak could only be repaired by hand-editing JSON on the server.
 *
 * So: a command mints, rotates and revokes per-principal tokens, storing only their SHA-256, and the endpoint
 * can refuse the URL-path fallback entirely. These tests hold both halves to their promises — in particular
 * that a rotation leaves no window in which the old token still works, and that the raw token never lands on disk.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { newToken, readEntries, run } from "../../src/cli/token.ts";
import { FileHttpTokenRegistry, sha256, startHttpServer } from "../../src/server/http.ts";
import { buildWorld, OWNER } from "./binding-fixtures.ts";

function workspace(): { dir: string; registry: string; principals: string } {
  const dir = mkdtempSync(join(tmpdir(), "vertigo-cred-"));
  const principals = join(dir, "principals.json");
  writeFileSync(principals, JSON.stringify({ principals: [{ principal_id: OWNER.principal_id }, { principal_id: "p-CollaboratorBeta" }] }));
  return { dir, registry: join(dir, "tokens.json"), principals };
}
const env = (w: { registry: string; principals: string }) => ({ HARNESS_HTTP_TOKENS_FILE: w.registry, PRINCIPALS_FILE: w.principals }) as NodeJS.ProcessEnv;

test("PV-CRED-001/a: minting yields a usable token, stores only its digest, and never writes the token itself", () => {
  const w = workspace();
  try {
    const out = run(["mint", "p-CollaboratorBeta"], env(w));
    assert.ok(out.token && out.token.length >= 32, "a token is returned to the operator");
    assert.match(out.token!, /^[A-Za-z0-9_-]+$/, "no character a URL, a shell or a log would mangle");
    const raw = readFileSync(w.registry, "utf8");
    assert.ok(!raw.includes(out.token!), "the raw token is stored nowhere");
    assert.deepEqual(readEntries(w.registry), [{ token_sha256: sha256(out.token!), principal_id: "p-CollaboratorBeta" }]);
    assert.ok(out.lines.some((l) => /shown ONCE/.test(l)), "the operator is told it is shown once");
    assert.ok(out.lines.some((l) => /not in the server URL/.test(l)), "and where it must not go");
    // Two mints for two sellers coexist; each maps to its own principal.
    const second = run(["mint", OWNER.principal_id], env(w));
    const entries = readEntries(w.registry);
    assert.equal(entries.length, 2);
    assert.equal(entries.find((e) => e.token_sha256 === sha256(second.token!))?.principal_id, OWNER.principal_id);
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test("PV-CRED-001/b: rotation revokes the old token in the same write, and revocation empties the principal", () => {
  const w = workspace();
  try {
    const first = run(["mint", "p-CollaboratorBeta"], env(w)).token!;
    const rotated = run(["rotate", "p-CollaboratorBeta"], env(w));
    assert.notEqual(rotated.token, first);
    const digests = readEntries(w.registry).map((e) => e.token_sha256);
    assert.deepEqual(digests, [sha256(rotated.token!)], "exactly one token survives; there is no window where both work");
    assert.ok(rotated.lines[0]?.includes("1 earlier token"), rotated.lines[0]);
    // Another principal's credential is untouched by a rotation that is not theirs.
    const other = run(["mint", OWNER.principal_id], env(w)).token!;
    run(["rotate", "p-CollaboratorBeta"], env(w));
    assert.ok(readEntries(w.registry).some((e) => e.token_sha256 === sha256(other)), "rotating one seller never revokes another");
    const revoked = run(["revoke", "p-CollaboratorBeta"], env(w));
    assert.ok(revoked.lines[0]?.includes("revoked 1 token"), revoked.lines[0]);
    assert.deepEqual(readEntries(w.registry).map((e) => e.principal_id), [OWNER.principal_id]);
    assert.ok(run(["revoke", "p-CollaboratorBeta"], env(w)).lines[0]?.includes("nothing changed"), "revoking twice is not an error");
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test("PV-CRED-001/c: a principal no principals file declares is refused before anything is written", () => {
  const w = workspace();
  try {
    assert.throws(() => run(["mint", "p-typo"], env(w)), /not declared/);
    assert.deepEqual(readEntries(w.registry), [], "a typo mints nothing");
    assert.throws(() => run(["mint"], env(w)), /requires a principal_id/);
    assert.throws(() => run(["nonsense", "p-CollaboratorBeta"], env(w)), /usage/);
    assert.throws(() => run(["mint", "p-CollaboratorBeta"], {} as NodeJS.ProcessEnv), /no registry file/);
    // Revoking is always allowed: a principal may be removed from the principals file before its token is.
    run(["mint", "p-CollaboratorBeta"], env(w));
    writeFileSync(w.principals, JSON.stringify({ principals: [{ principal_id: OWNER.principal_id }] }));
    assert.ok(run(["revoke", "p-CollaboratorBeta"], env(w)).lines[0]?.includes("revoked"));
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test("PV-CRED-001/d: listing reports who holds credentials and how many, and never a token", () => {
  const w = workspace();
  try {
    assert.deepEqual(run(["list"], env(w)).lines, ["no token is registered"]);
    const t = run(["mint", "p-CollaboratorBeta"], env(w)).token!;
    run(["mint", "p-CollaboratorBeta"], env(w));
    run(["mint", OWNER.principal_id], env(w));
    const out = run(["list"], env(w));
    assert.equal(out.token, undefined, "listing hands back no credential");
    assert.deepEqual(out.lines.filter((l) => l.startsWith("p-CollaboratorBeta")), ["p-CollaboratorBeta: 2 tokens"]);
    assert.ok(out.lines.some((l) => l.startsWith(`${OWNER.principal_id}: 1 token`)), out.lines.join(" | "));
    assert.ok(!out.lines.some((l) => l.includes(t)), "no line quotes a token");
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test("PV-CRED-001/e: with the path fallback off, the header authenticates and the URL is no longer a credential", async () => {
  const world = buildWorld();
  const token = newToken();
  const registry = new FileHttpTokenRegistry([{ token_sha256: sha256(token), principal_id: OWNER.principal_id }]);
  const connect = async (url: URL, bearer?: string) => {
    const c = new Client({ name: "cred-test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(url, bearer ? { requestInit: { headers: { authorization: `Bearer ${bearer}` } } } : {}) as unknown as Parameters<typeof c.connect>[0]);
    return c;
  };

  const hardened = await startHttpServer(world.deps, registry, 0, "127.0.0.1", /*allowPathToken*/ false);
  try {
    const base = new URL(`http://127.0.0.1:${hardened.port}/mcp`);
    const c = await connect(base, token);
    try { assert.equal((await c.listTools()).tools.length, 5, "the header is the credential"); } finally { await c.close(); }
    await assert.rejects(connect(new URL(`/mcp/${token}`, base)), /unauthenticated/, "the very same token in the URL path is refused");
    const refused = await fetch(new URL(`/mcp/${token}`, base), { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    assert.equal(refused.status, 401);
    assert.match((await refused.json() as { error: { message: string } }).error.message, /no longer accepts a token in the URL path/);
  } finally { await hardened.close(); }

  // Until every application sends a header, the fallback stays available, and that is the default.
  const permissive = await startHttpServer(world.deps, registry, 0);
  try {
    const c = await connect(new URL(`http://127.0.0.1:${permissive.port}/mcp/${token}`));
    try { assert.equal((await c.listTools()).tools.length, 5); } finally { await c.close(); }
  } finally { await permissive.close(); }
});

test("PV-CRED-001/f: a rotation takes effect on the next request, with no restart and no stale acceptance", async () => {
  const w = workspace();
  const world = buildWorld();
  const first = run(["mint", OWNER.principal_id], env(w)).token!;
  const server = await startHttpServer(world.deps, await FileHttpTokenRegistry.load(w.registry), 0, "127.0.0.1", false);
  const call = (bearer: string) => fetch(new URL(`http://127.0.0.1:${server.port}/mcp`), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  try {
    assert.equal((await call(first)).status, 200);
    const second = run(["rotate", OWNER.principal_id], env(w)).token!;
    assert.equal((await call(second)).status, 200, "the new token works immediately");
    assert.equal((await call(first)).status, 401, "the old one stops working immediately, with no restart");
  } finally { await server.close(); rmSync(w.dir, { recursive: true, force: true }); }
});
