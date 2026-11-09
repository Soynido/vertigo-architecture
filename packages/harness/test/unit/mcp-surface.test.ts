import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/index.ts";
import { InMemoryPrincipalRegistry } from "../../src/auth/principal.ts";
import { createMemoryStore } from "../../src/store/memory.ts";
import { FixtureNotionReadClient } from "../../src/notion/readClient.ts";
import { EMPTY_SALES_REGISTRY } from "../../src/registry/salesRuntimes.ts";
import { createAdapterRegistries } from "../../src/versions/registry.ts";
import { loadConfig } from "../../src/config/index.ts";
import type { HarnessDeps } from "../../src/tools/handlers.ts";
import { CLASSES, configRow, guardWorld, index } from "../support/guard-fixtures.ts";
import { OWNER } from "./binding-fixtures.ts";

test("W6.1 MCP: the actual five-tool resume route journals local adoption; caller flags cannot select it", async () => {
  const row = { ...configRow("mcp-auto", "B3_DATA:CANONICAL_SOURCE", { category: "OTHER", value: "local source", source: "CHAT_USER_EXPLICIT" }), last_edited_time: "2030-01-02T00:00:00.000Z" };
  const g = guardWorld({ gate: "B3_DATA", configs: [row], doc: index([], [
    { class: "PRODUCTION", resource_key: "SALES:BUSINESS_CONFIG", operation: "UPDATE", allowed_fields: ["Category", "State", "Value", "Version", "Source"] }, CLASSES.cursor(),
  ]) }), h = await g.bind(); await g.approve();
  const server = createServer(g.deps, OWNER.principal_id);
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st);
  const client = new Client({ name: "w61-candidate", version: "0" }); await client.connect(ct);
  try {
    const list = (await client.listTools()).tools;
    assert.match(list.find(t => t.name === "os_resume")!.description!, /journal bounded user-local/);
    const bad = await client.callTool({ name: "os_resume", arguments: { binding_handle: h, candidate_resume: true } });
    assert.equal(bad.isError, true);
    assert.equal(g.client.writes.length, 0);
    const good = await client.callTool({ name: "os_resume", arguments: { binding_handle: h } });
    const result = JSON.parse((good.content as Array<{ text: string }>)[0]!.text);
    assert.equal(result.code, "RESUMED"); assert.equal(result.result.durable_hold, undefined, JSON.stringify(result.result.durable_hold));
    assert.equal(result.result.pending_confirmation, undefined);
    assert.ok(g.client.writes.length);
    assert.equal(g.client.writes.filter(w => w.target === row.id).length, 0);
  } finally { await client.close(); await server.close(); }
});

async function connected(principalId: string | undefined) {
  const deps: HarnessDeps = {
    config: loadConfig({ VERTIGO_META_SPEC_ROOT: "https://example.invalid/root", HARNESS_ENV: "fixture", PRINCIPALS_FILE: "x" }),
    principals: new InMemoryPrincipalRegistry([{ principal_id: "p-owner", status: "ACTIVE", allowed_projects: ["VERTIGO"], allowed_lanes: ["META", "SALES"] }]),
    store: createMemoryStore(),
    notion: new FixtureNotionReadClient(new Map()),
    adapters: createAdapterRegistries(),
    salesRegistry: EMPTY_SALES_REGISTRY,
  };
  const server = createServer(deps, principalId);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

test("MCP surface lists exactly the five BUILD TARGET tools (W3.3)", async () => {
  const { client, close } = await connected("p-owner");
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    assert.deepEqual(tools, ["os_bind", "os_resume", "os_commit", "os_handoff", "os_control_status"]);
  } finally { await close(); }
});

test("MCP layer rejects authority-asserting arguments instead of stripping them", async () => {
  const { client, close } = await connected("p-owner");
  try {
    const injected = await client.callTool({ name: "os_bind", arguments: { project: "VERTIGO", lane: "META", runtime_id: "injected" } });
    assert.equal(injected.isError, true, "injected runtime_id must be an error, not silently dropped");
    const text = JSON.stringify(injected.content);
    assert.match(text, /runtime_id|unrecognized|Unrecognized|validation/i);
    const clean = await client.callTool({ name: "os_bind", arguments: { project: "VERTIGO", lane: "META" } });
    const envelope = JSON.parse((clean.content as Array<{ text: string }>)[0]!.text) as { code: string };
    // The clean call passes the schema and reaches real resolution, which HOLDs on the empty fixture world.
    assert.equal(envelope.code, "HOLD_BOOTSTRAP_DISCOVERY");
  } finally { await close(); }
});

test("MCP layer without an authenticated principal yields ERROR_AUTH_REQUIRED", async () => {
  const { client, close } = await connected(undefined);
  try {
    const r = await client.callTool({ name: "os_bind", arguments: { project: "VERTIGO", lane: "META" } });
    const envelope = JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as { code: string };
    assert.equal(envelope.code, "ERROR_AUTH_REQUIRED");
  } finally { await close(); }
});
