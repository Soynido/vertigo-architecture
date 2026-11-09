/**
 * PT-PKG-003 — Historical readback choreography (INTEGRATION, in-memory MCP fixture, NOT ordinary ChatGPT).
 * An approved fixture durable mutation is driven through the MCP client exactly as the skill prescribes:
 * os_prepare → native Notion stage-1 → TARGET → native finalization / State LAST → FINAL. The custom MCP never
 * writes the target: the fixture injects stored instructions, resolved strictly by the backend after TARGET.
 * W3.3L freezes exact native rendering at commit 31f8087; no renderer, native payload or LIVE acceptance here.
 *
 * W3.3U: historical proof of the LIVE six-tool choreography. The candidate server (createServer) announces five
 * tools and keeps os_prepare/os_verify inert, so the MCP transport here is a TEST-ONLY six-tool fixture that answers
 * each LIVE name with the harness's internal handler. The retired names are never made public on createServer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "../../harness/src/index.ts";
import { dispatch } from "../../harness/src/tools/handlers.ts";
import { HANDLER_NAMES, toolDescriptions, toolInputSchemas } from "../../harness/src/tools/surface.ts";
import { OWNER } from "../../harness/test/unit/binding-fixtures.ts";
import { buildResumeWorld } from "../../harness/test/unit/resume-fixtures.ts";
import { executeWrites } from "../../harness/test/unit/target-fixtures.ts";

const T = { stage1: "2030-01-03T00:30:00.000Z", fin: "2030-01-03T00:31:00.000Z", state: "2030-01-03T00:32:00.000Z" };
const call = async (client, name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
const snapshot = (w) => JSON.stringify([...w.map.entries()]);

/** Test-only: the historical LIVE six-tool MCP surface, each name answered by the internal handler of the same name. */
function liveSixToolFixture(deps, principalId) {
  const server = new McpServer({ name: "vertigo-os-harness-live-six-tool-fixture", version: "0" });
  for (const name of HANDLER_NAMES) {
    server.registerTool(name, { description: toolDescriptions[name], inputSchema: toolInputSchemas[name] }, async (input) =>
      ({ content: [{ type: "text", text: JSON.stringify(await dispatch(name, input, { principal_id: principalId }, deps)) }] }));
  }
  return server;
}

async function connected(server) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "chat", version: "0" });
  await client.connect(ct);
  return client;
}

test("PT-PKG-003: the prescribed tool sequence reaches TRANSACTION_VERIFIED; MCP calls never mutate the fixture", async () => {
  const w = buildResumeWorld();
  // The candidate server never announces the retired names; only the test fixture below carries them.
  const candidate = createServer(w.deps, OWNER.principal_id);
  const candidateClient = await connected(candidate);
  try {
    const announced = (await candidateClient.listTools()).tools.map((t) => t.name);
    assert.ok(!announced.includes("os_prepare") && !announced.includes("os_verify"), `the candidate server announces a retired tool: ${announced.join(", ")}`);
  } finally { await candidateClient.close(); await candidate.close(); }

  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  const server = liveSixToolFixture(w.deps, OWNER.principal_id);
  const client = await connected(server);
  const sequence = [];
  try {
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), [...manifest.tools].sort(), "the fixture is not the LIVE six-tool surface");
    let snap = snapshot(w);
    const bound = await call(client, "os_bind", { project: "VERTIGO", lane: "META" }); sequence.push("os_bind");
    assert.equal(bound.code, "BOUND");
    const h = bound.result.binding_handle;
    assert.equal((await call(client, "os_resume", { binding_handle: h })).code, "RESUMED"); sequence.push("os_resume");
    const p = await call(client, "os_prepare", { binding_handle: h, intent: { action_class: "COMMIT", summary: "set the next frame question", mutations: [{ logical_resource_key: "META:GATES", operation: "UPDATE", record_selector: { natural_key: "T1" }, desired_changes: { "Next Question": "What is the offer?" } }] } }); sequence.push("os_prepare");
    assert.equal(p.code, "PLAN_PREPARED", JSON.stringify(p));
    assert.equal(snapshot(w), snap, "prepare rendered actions but wrote nothing");
    const plan = await w.deps.store.plans.get(p.result.plan_id);
    // FINAL before TARGET is refused: the barrier cannot be skipped.
    assert.equal((await call(client, "os_verify", { binding_handle: h, plan_id: plan.plan_id, phase: "FINAL" })).status, "HOLD");
    // TARGET before the native write: HOLD (nothing observed), still no mutation by the MCP.
    assert.equal((await call(client, "os_verify", { binding_handle: h, plan_id: plan.plan_id, phase: "TARGET" })).status, "HOLD");
    assert.equal(snapshot(w), snap);
    // Native Notion executes the rendered stage-1 actions verbatim.
    const created = executeWrites(w, plan.stage1_writes, plan.plan_id, { now: T.stage1 }); sequence.push("native:stage1");
    assert.notEqual(snapshot(w), snap, "only the native writer changes Notion");
    snap = snapshot(w);
    const t = await call(client, "os_verify", { binding_handle: h, plan_id: plan.plan_id, phase: "TARGET" }); sequence.push("os_verify:TARGET");
    assert.equal(t.code, "TARGET_VERIFIED", JSON.stringify(t));
    assert.equal(snapshot(w), snap, "TARGET is a readback, not a write");
    const symbols = t.observations.symbols ?? created;
    executeWrites(w, plan.finalization_writes, plan.plan_id, { ...({ now: T.fin }), created: symbols, target_receipt_id: t.result.target_receipt_id }); sequence.push("native:finalization");
    executeWrites(w, [plan.state_last_write], plan.plan_id, { ...({ now: T.state }), created: symbols, target_receipt_id: t.result.target_receipt_id }); sequence.push("native:state_last");
    snap = snapshot(w);
    const f = await call(client, "os_verify", { binding_handle: h, plan_id: plan.plan_id, phase: "FINAL" }); sequence.push("os_verify:FINAL");
    assert.equal(f.code, "TRANSACTION_VERIFIED", JSON.stringify(f));
    assert.equal(snapshot(w), snap, "FINAL is a readback, not a write");
    assert.deepEqual(sequence, ["os_bind", "os_resume", "os_prepare", "native:stage1", "os_verify:TARGET", "native:finalization", "native:state_last", "os_verify:FINAL"]);
  } finally { await client.close(); await server.close(); }
  // The skill text prescribes exactly this order and the pre-verification vocabulary.
  const skill = await readFile(new URL("../SKILL.md", import.meta.url), "utf8");
  const order = ["os_bind", "os_resume", "os_prepare(intent | capability_evidence)", "execute stage1_actions verbatim", "os_verify(plan_id, TARGET)", "execute finalization_actions, then state_last_action LAST", "os_verify(plan_id, FINAL)", "TRANSACTION_VERIFIED"];
  let at = 0;
  for (const token of order) { const i = skill.indexOf(token, at); assert.ok(i >= 0, `skill lacks "${token}" in order`); at = i; }
  assert.match(skill, /Never: saved, done, persisted, committed, verified, completed/);
  assert.match(skill, /Never send yourself/);
});
