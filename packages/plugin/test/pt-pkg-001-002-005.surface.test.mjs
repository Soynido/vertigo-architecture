/**
 * PT-PKG-001 two authorities, proved separately and never declared equal (W3.3S): the LIVE manifest keeps its six
 *   names (PLUGIN_SPEC/0.3.0, no adoption), while the BUILD TARGET server announces exactly five (0.5.0-candidate);
 * PT-PKG-002 the custom MCP has no unconfined Notion write path: the only writes are the strict client's two,
 *   called solely by the transactional writer (PT-ARCH-004); no tool argument can smuggle a write;
 * PT-PKG-005 public tool schemas exclude model-asserted authority fields.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../harness/src/index.ts";
import { buildWorld, OWNER } from "../../harness/test/unit/binding-fixtures.ts";
import { listFiles, scan, HARNESS_ROOT } from "../../harness/test/arch/scan.ts";
import { assertWriteAllowed, NotionWriteRefused } from "../../harness/src/notion/client.ts";
import { join } from "node:path";

/** The LIVE manifest's six names (unchanged until adoption). */
const LIVE_SIX = ["os_bind", "os_resume", "os_prepare", "os_verify", "os_handoff", "os_control_status"];
/** The BUILD TARGET server's five names (W3.3, PLUGIN_SPEC/0.5.0-candidate, NOT ADOPTED). */
const CANDIDATE_FIVE = ["os_bind", "os_resume", "os_commit", "os_handoff", "os_control_status"];
async function connected() {
  const w = buildWorld();
  const server = createServer(w.deps, OWNER.principal_id);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "pkg", version: "0" });
  await client.connect(ct);
  return { w, client, close: async () => { await client.close(); await server.close(); } };
}
const envelope = (r) => JSON.parse(r.content[0].text);

test("PT-PKG-001: the LIVE manifest keeps its six names; the candidate server announces exactly five; neither is the other", async () => {
  const { client, close } = await connected();
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((t) => t.name), CANDIDATE_FIVE);
    const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
    assert.deepEqual(manifest.tools, LIVE_SIX);
    assert.notDeepEqual(manifest.tools, tools.tools.map((t) => t.name), "the LIVE manifest must not be read as the candidate surface");
    assert.equal(manifest.version, "0.3.0");
    assert.equal(manifest.spec, "PLUGIN_SPEC/0.3.0");
    const skill = await readFile(new URL("../SKILL.md", import.meta.url), "utf8");
    assert.match(skill, /^# VERTIGO OS — skill \(governing PLUGIN_SPEC\/0\.3\.0; guarded 0\.4\.0 candidate; UX v3\.0\)$/m);
    assert.doesNotMatch(skill.split("\n", 1)[0], /adopted|governing PLUGIN_SPEC\/0\.4\.0/i);
    assert.equal(manifest.harness.notion_access, "read-only");
    assert.equal(manifest.harness.gmail_access, "none");
    for (const forbidden of ["os_finalize", "os_mark_verified", "os_set_gate", "os_create_run", "os_update_manifest", "os_write_notion", "os_control_pass", "os_send_email", "os_gmail_send", "os_execute_external_action"]) {
      const r = await client.callTool({ name: forbidden, arguments: {} }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
      assert.ok(r.isError, `${forbidden} must not exist`);
    }
  } finally { await close(); }
});

test("PT-PKG-002: no unconfined Notion write path — the strict client's two writes, called only by the transactional writer; no tool can smuggle a write", async () => {
  const files = await listFiles(join(HARNESS_ROOT, "src"), [".ts"]);
  const byFile = (hits) => [...new Set(hits.map((h) => h.file))].sort();
  // No SDK-style or MCP-style mutation, no other HTTP verb than the two allowlisted ones.
  assert.deepEqual(await scan(files, [/\bpages\.(create|update|archive)\b/, /\bblocks\.(children\.append|update|delete)\b/, /\bdatabases\.(create|update)\b/, /\bdataSources\.(create|update)\b/, /["'`](DELETE|PUT)["'`]/, /notion-update-page|notion-create-pages/]), []);
  // The wire, the verb and the two calls each live in exactly one module.
  assert.deepEqual(byFile(await scan(files, [/api\.notion\.com/])), ["packages/harness/src/notion/client.ts"]);
  assert.deepEqual(byFile(await scan(files, [/["'`]PATCH["'`]/])), ["packages/harness/src/notion/client.ts"]);
  assert.deepEqual(byFile(await scan(files, [/\.(createPage|updatePage)\(/])), ["packages/harness/src/transactions/write.ts"]);
  assert.deepEqual(byFile(await scan(files, [/\bfetch\s*\(/])), ["packages/harness/src/index.ts"]);
  // Anything that is not one of the two allowlisted writes is refused before the network.
  for (const [m, path, body] of [["DELETE", "/pages/0123456789abcdef0123456789abcdef", {}], ["POST", "/databases", { parent: {}, properties: {} }], ["PATCH", "/blocks/0123456789abcdef0123456789abcdef", { archived: true }], ["PATCH", "/pages/0123456789abcdef0123456789abcdef", { properties: {}, archived: true }], ["POST", "/pages", { parent: { type: "page_id", page_id: "0123456789abcdef0123456789abcdef" }, properties: {} }]]) {
    assert.throws(() => assertWriteAllowed(m, path, body), NotionWriteRefused, `${m} ${path}`);
  }
  const pkg = JSON.parse(await readFile(join(HARNESS_ROOT, "package.json"), "utf8"));
  assert.ok(!Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some((d) => /notion|gmail|google|mail-executor/i.test(d)));
  const cfg = await readFile(join(HARNESS_ROOT, "src/config/index.ts"), "utf8");
  assert.doesNotMatch(cfg, /NOTION_(WRITE|ADMIN|INTERNAL)_TOKEN|GMAIL|MAIL_EXECUTOR/);
  const { client, w, close } = await connected();
  try {
    const before = JSON.stringify([...w.map.entries()]);
    const bound = envelope(await client.callTool({ name: "os_bind", arguments: { project: "VERTIGO", lane: "META" } }));
    assert.equal(bound.code, "BOUND");
    // Every attempt to smuggle a write through a tool argument is rejected by the strict schema; os_commit answers a
    // HELD outcome for it, and the two retired names answer only their upgrade refusal (W3.2), whatever the arguments.
    for (const [name, args] of [
      ["os_resume", { binding_handle: bound.result.binding_handle, write: { "Next Action": "x" } }],
      ["os_commit", { binding_handle: bound.result.binding_handle, intent: { action_class: "COMMIT", summary: "s", mutations: [{ logical_resource_key: "META:GATES", operation: "ARCHIVE", record_selector: {}, desired_changes: {} }] } }],
      ["os_verify", { binding_handle: bound.result.binding_handle, plan_id: "p", phase: "FINAL", mark_verified: true }],
      ["os_prepare", { binding_handle: bound.result.binding_handle, intent: { action_class: "COMMIT", summary: "s", mutations: [{ logical_resource_key: "META:GATES", operation: "ARCHIVE", record_selector: {}, desired_changes: {} }] } }],
      ["os_handoff", { binding_handle: bound.result.binding_handle, next_run: "MRUN-X" }],
    ]) {
      const r = await client.callTool({ name, arguments: args }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
      if (name === "os_commit") assert.deepEqual([envelope(r).kind, envelope(r).code], ["HELD", "ERROR_INVALID_ARGUMENT"], `${name} must reject ${JSON.stringify(args)} at its schema`);
      else if (name === "os_prepare" || name === "os_verify") assert.equal(envelope(r).code, "HOLD_CLIENT_UPGRADE_REQUIRED", `${name} must stay inert`);
      else assert.ok(r.isError, `${name} must reject ${JSON.stringify(args)}`);
    }
    assert.equal(JSON.stringify([...w.map.entries()]), before, "the Notion fixture is byte-identical after every MCP call");
  } finally { await close(); }
});

test("PT-PKG-005: candidate inputs add only native event evidence, never model-asserted authority", async () => {
  const { client, w, close } = await connected();
  try {
    const allowed = { os_bind: ["project", "lane"], os_resume: ["binding_handle", "topic_hint"], os_commit: ["binding_handle", "intent", "capability_evidence", "external_event_evidence"], os_handoff: ["binding_handle", "format_hint"], os_control_status: ["binding_handle", "scope_hint"] };
    const forbidden = /root|runtime|owner|principal|gate|verdict|baseline|version|receipt|manifest|run_ref|authority|approved|mode|recipient|send/i;
    const names = (schema) => { const out = []; const walk = (s) => { if (!s || typeof s !== "object") return; for (const [k, v] of Object.entries(s.properties ?? {})) { out.push(k); walk(v); if (v.items) walk(v.items); } }; walk(schema); return out; };
    for (const t of (await client.listTools()).tools) {
      assert.deepEqual(Object.keys(t.inputSchema.properties ?? {}), allowed[t.name], `${t.name} top-level inputs`);
      assert.equal(t.inputSchema.additionalProperties, false, `${t.name} rejects unknown inputs`);
      const bad = names(t.inputSchema).filter((n) => forbidden.test(n) && !["logical_resource_key", "logical_record_key"].includes(n));
      assert.deepEqual(bad, [], `${t.name} exposes authority-like inputs`);
    }
    const before = JSON.stringify([...w.map.entries()]);
    const evidence = { provider: "GMAIL", source_identity: "owner@example.invalid", evidence_ref: "native-message", observed_at: "2030-01-01T00:00:00Z", message: { message_id: "message-1", thread_id: "thread-1", from: "owner@example.invalid", to: ["contact@example.invalid"], date: "2030-01-01T00:00:00Z" }, contact_refs: ["0123456789abcdef0123456789abcdef"] };
    // Unknown authority fields fail at both nested boundaries, before resolving a runtime or writing any byte.
    for (const key of ["root", "runtime", "owner", "principal", "gate", "version", "authority", "approved", "Verified"]) {
      for (const capture of [{ ...evidence, [key]: true }, { ...evidence, message: { ...evidence.message, [key]: true } }]) {
        const out = envelope(await client.callTool({ name: "os_commit", arguments: { binding_handle: "unused", external_event_evidence: capture } }));
        assert.deepEqual([out.kind, out.code, out.wrote_anything], ["HELD", "ERROR_INVALID_ARGUMENT", false], `${key} cannot supply authority`);
      }
    }
    assert.equal(JSON.stringify([...w.map.entries()]), before, "forged native captures never write Notion");
  } finally { await close(); }
});
