/**
 * PV0-006 — Expose os_bind tool. Checks the public primitive as an MCP tool end to end (in-process
 * client/server), its closed error/HOLD contract, and the forbidden-authority-argument rule.
 * Blocking validations for the ticket are PT-BIND-001..010 (their own suites).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/index.ts";
import { dispatch } from "../../src/tools/handlers.ts";
import { OS_BIND_CODES, OS_BIND_FORBIDDEN_ARGUMENTS, OS_BIND_HOLD_CODES } from "../../src/tools/bindContract.ts";
import { toolDescriptions } from "../../src/tools/surface.ts";
import { buildWorld, OWNER, REP_B, T0 } from "./binding-fixtures.ts";
import { ID as META_ID } from "./meta-fixtures.ts";
import { IDS, registryEntries, templateSpec, installRuntime } from "./sales-fixtures.ts";

async function connect(principalId: string | undefined) {
  const w = buildWorld();
  const server = createServer(w.deps, principalId);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "pv0-006", version: "0" });
  await client.connect(ct);
  return { w, client, close: async () => { await client.close(); await server.close(); } };
}

test("PV0-006: os_bind over MCP returns BOUND with handle, logical identity, lifecycle and version summary", async () => {
  const { client, close } = await connect(OWNER.principal_id);
  try {
    const tools = (await client.listTools()).tools;
    const bind = tools.find((t) => t.name === "os_bind")!;
    assert.match(bind.description ?? "", /backend-resolved/);
    assert.match(bind.description ?? "", /never accepted from the caller/);
    const props = Object.keys((bind.inputSchema as { properties: Record<string, unknown> }).properties);
    assert.deepEqual(props.sort(), ["lane", "project"], "schema permits only logical project/lane");
    const r = await client.callTool({ name: "os_bind", arguments: { project: "VERTIGO", lane: "META" } });
    const env = JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as { status: string; code: string; result: Record<string, string>; binding: Record<string, string>; versions: { governing_spec: string; candidate_versions: string[] } };
    assert.equal(env.status, "OK");
    assert.equal(env.code, "BOUND");
    assert.equal(Buffer.from(env.result["binding_handle"]!, "base64url").length, 32);
    assert.match(env.result["binding_expires_at"]!, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(env.binding["runtime_logical_key"], "VERTIGO/META");
    assert.equal(env.binding["runtime_id"], "RT-TEST-01");
    assert.equal(env.result["lifecycle_state"], "SETUP");
    assert.equal(env.versions.governing_spec, "TEST_SPEC/1.0.0");
    assert.deepEqual(env.versions.candidate_versions, []);
  } finally { await close(); }
});

test("PV0-006/b: every forbidden authority argument is refused at the MCP layer", async () => {
  const { client, close } = await connect(OWNER.principal_id);
  try {
    for (const arg of OS_BIND_FORBIDDEN_ARGUMENTS) {
      const r = await client.callTool({ name: "os_bind", arguments: { project: "VERTIGO", lane: "META", [arg]: "x" } });
      assert.equal(r.isError, true, `${arg} must be refused`);
    }
  } finally { await close(); }
});

test("PV0-006/c: os_bind codes are a closed set and each documented HOLD is reachable", async () => {
  const w = buildWorld();
  const ctx = { principal_id: OWNER.principal_id, now: T0 };
  const seen = new Set<string>();
  const record = async (input: unknown, principal = OWNER.principal_id) => { const e = await dispatch("os_bind", input, { principal_id: principal, now: T0 }, w.deps); assert.ok(OS_BIND_CODES.has(e.code), `out of contract: ${e.code}`); seen.add(e.code); return e; };
  await record({ project: "VERTIGO", lane: "META" });                                   // BOUND
  await record({ project: "VERTIGO", lane: "META" }, "p-nobody");                       // ERROR_AUTH_REQUIRED
  await record({ project: "OTHER", lane: "META" });                                     // ERROR_PROJECT_UNKNOWN
  await record({ project: "VERTIGO", lane: "META" }, REP_B.principal_id);               // HOLD_UNAUTHORIZED_LANE
  await record({ project: "VERTIGO", lane: "NOPE" });                                   // ERROR_INVALID_ARGUMENT
  // SALES discovery states
  w.setSalesRegistry([]);                                                               // UNKNOWN
  await record({ project: "VERTIGO", lane: "SALES" });                                  // HOLD_RUNTIME_NOT_FOUND
  w.setSalesRegistry([{ rep_identity_key: "rep-a", status: "NOT_YET_CREATED" }]);
  await record({ project: "VERTIGO", lane: "SALES" });                                  // HOLD_RUNTIME_NOT_YET_CREATED
  installRuntime(w.map, templateSpec());
  w.setSalesRegistry([{ rep_identity_key: "rep-a", status: "KNOWN", root_ref: IDS("template").root, expected_instance_id: "TEMPLATE-UNBOUND" }]);
  await record({ project: "VERTIGO", lane: "SALES" });                                  // HOLD_RUNTIME_TEMPLATE_NOT_INSTANCE
  w.setSalesRegistry([{ ...registryEntries()[0]!, root_ref: IDS("rep-b").root }]);
  await record({ project: "VERTIGO", lane: "SALES" });                                  // HOLD_RUNTIME_MANIFEST_MISMATCH
  w.setSalesRegistry([{ rep_identity_key: "rep-a", status: "KNOWN", root_ref: IDS("rep-a").root }]);
  await record({ project: "VERTIGO", lane: "SALES" });                                  // HOLD_UNKNOWN_REQUIRED_FACT
  // META discovery states
  w.rotateMeta({ rootId: META_ID.rootB });                                              // locator B, manifest B? rotateMeta sets manifest rootId=B → consistent; use a mismatch instead:
  w.map.set(`children:${META_ID.locator}`, { results: [], has_more: false, next_cursor: null });
  await record({ project: "VERTIGO", lane: "META" });                                   // HOLD_BOOTSTRAP_DISCOVERY
  void ctx;
  for (const c of ["BOUND", "ERROR_AUTH_REQUIRED", "ERROR_PROJECT_UNKNOWN", "HOLD_UNAUTHORIZED_LANE", "ERROR_INVALID_ARGUMENT", "HOLD_RUNTIME_NOT_FOUND", "HOLD_RUNTIME_NOT_YET_CREATED", "HOLD_RUNTIME_TEMPLATE_NOT_INSTANCE", "HOLD_RUNTIME_MANIFEST_MISMATCH", "HOLD_UNKNOWN_REQUIRED_FACT", "HOLD_BOOTSTRAP_DISCOVERY"]) {
    assert.ok(seen.has(c), `expected to observe ${c}`);
  }
  assert.ok(OS_BIND_HOLD_CODES.every((c) => OS_BIND_CODES.has(c)));
  assert.match(toolDescriptions.os_bind, /Roots, runtime IDs, owners, current gate, current Run/);
});
