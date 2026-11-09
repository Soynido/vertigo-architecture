/**
 * PT-DEPLOY-001..004 — a remote candidate is attributable to exact code/config, and bearer rotation takes
 * effect without a process restart. These are transport-level tests: the real Streamable HTTP endpoint is used.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ConfigError, loadConfig } from "../../src/config/index.ts";
import { createServer, serverImplementationVersion } from "../../src/index.ts";
import { FileHttpTokenRegistry, sha256, startHttpServer } from "../../src/server/http.ts";
import { buildWorld, OWNER } from "./binding-fixtures.ts";

const REV = "a".repeat(40);
const CFG = "b".repeat(64);

test("W7.3-R1: only the Sales activation directory is writable; credential registries stay read-only", async () => {
  const compose = await readFile(new URL("../../../../deploy/docker-compose.yml", import.meta.url), "utf8");
  assert.match(compose, /SALES_RUNTIME_REGISTRY_FILE: \/app\/runtime-state\/sales-runtimes\.local\.json/);
  assert.match(compose, /- \.\.\/config:\/app\/config:ro/);
  assert.match(compose, /- \.\.\/config\/runtime-state:\/app\/runtime-state:rw/);
  assert.doesNotMatch(compose, /- \.\.\/config:\/app\/config:rw/);
  const deploy = await readFile(new URL("../../../../deploy/deploy.sh", import.meta.url), "utf8");
  assert.match(deploy, /digest config\/runtime-state\/sales-runtimes\.local\.json/);
  assert.match(deploy, /config\/sales-runtimes\.local\.json.*must be migrated/);
  const privatePaths = ["config/runtime-state/sales-runtimes.local.json", "config/runtime-state/sales-runtimes.local.json.lock", "config/runtime-state/sales-runtimes.local.json.tmp-probe", ".run/w73-private/secrets/token"];
  const ignored = execFileSync("git", ["check-ignore", "--", ...privatePaths], { cwd: new URL("../../../../", import.meta.url), encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(ignored, privatePaths);
  const dockerIgnore = await readFile(new URL("../../../../.dockerignore", import.meta.url), "utf8");
  assert.match(dockerIgnore, /^config$/m);
  assert.match(dockerIgnore, /^\.run$/m);
});
const liveEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  HARNESS_ENV: "live_readonly",
  HARNESS_TRANSPORT: "http",
  HARNESS_HTTP_TOKENS_FILE: "/deployment/http-tokens.json",
  VERTIGO_META_SPEC_ROOT: "meta-root",
  PRINCIPALS_FILE: "/deployment/principals.json",
  NOTION_READ_TOKEN: "test-only-notion-token",
  ...extra,
});

test("PT-DEPLOY-001: live HTTP refuses to start without exact revision, dirty bit and config fingerprint", () => {
  for (const [missing, supplied] of [
    ["HARNESS_BUILD_REVISION", { HARNESS_BUILD_DIRTY: "false", HARNESS_CONFIG_FINGERPRINT: CFG }],
    ["HARNESS_BUILD_DIRTY", { HARNESS_BUILD_REVISION: REV, HARNESS_CONFIG_FINGERPRINT: CFG }],
    ["HARNESS_CONFIG_FINGERPRINT", { HARNESS_BUILD_REVISION: REV, HARNESS_BUILD_DIRTY: "false" }],
  ] as const) {
    assert.throws(() => loadConfig(liveEnv(supplied)), (err: unknown) => err instanceof ConfigError && err.message.includes(missing));
  }
  assert.throws(() => loadConfig(liveEnv({ HARNESS_BUILD_REVISION: "short", HARNESS_BUILD_DIRTY: "false", HARNESS_CONFIG_FINGERPRINT: CFG })), /exact 40-hex/);
});

test("PT-DEPLOY-002: MCP serverInfo exposes the exact candidate revision, dirty state and config fingerprint", async () => {
  const w = buildWorld();
  const config = { ...w.deps.config, buildRevision: REV, buildDirty: true, configFingerprint: CFG };
  const deps = { ...w.deps, config };
  const server = createServer(deps, OWNER.principal_id);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "attestation-test", version: "0" });
  await client.connect(ct);
  try {
    const expected = `0.5.0-candidate+rev.${REV}.dirty.true.cfg.${CFG}`;
    assert.equal(serverImplementationVersion(config), expected);
    assert.deepEqual(client.getServerVersion(), { name: "vertigo-os-harness", version: expected });
  } finally { await client.close(); await server.close(); }
});

test("PT-DEPLOY-003: fixture MCP is explicitly unattested and cannot be confused with a served live build", () => {
  const w = buildWorld();
  assert.equal(serverImplementationVersion(w.deps.config), "0.5.0-candidate+fixture.unattested");
});

async function connect(url: URL, token: string): Promise<Client> {
  const client = new Client({ name: "rotation-test", version: "0" });
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
  return client;
}

test("PT-DEPLOY-004: an atomic token-file rotation accepts the new token and makes the old token 401 without restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vertigo-token-rotation-"));
  const file = join(dir, "http-tokens.json");
  const oldToken = "old-live-token-0123456789abcdef";
  const newToken = "new-live-token-0123456789abcdef";
  const body = (token: string) => `${JSON.stringify({ tokens: [{ token_sha256: sha256(token), principal_id: OWNER.principal_id }] }, null, 2)}\n`;
  await writeFile(file, body(oldToken), { mode: 0o600 });

  const w = buildWorld();
  const server = await startHttpServer(w.deps, await FileHttpTokenRegistry.load(file), 0);
  const url = new URL(`http://127.0.0.1:${server.port}/mcp`);
  try {
    const before = await connect(url, oldToken);
    await before.close();

    const replacement = join(dir, ".http-tokens.next");
    await writeFile(replacement, body(newToken), { mode: 0o600 });
    await chmod(replacement, 0o600);
    await rename(replacement, file);

    const after = await connect(url, newToken);
    await after.close();
    await assert.rejects(connect(url, oldToken), /401|unauthenticated/);
  } finally { await server.close(); }
});
