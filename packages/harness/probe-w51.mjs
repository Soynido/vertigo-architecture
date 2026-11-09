/** W5.1: real bind/resume over owner-approved durable acceptance configs; no external writes. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, open } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildDeps, createServer } from "./src/index.ts";
import { HttpNotionClient } from "./src/notion/client.ts";
import { hashHandle } from "./src/binding/handle.ts";
import { CONTEXT_BOUNDS, CONTEXT_SECTIONS } from "./src/contractPack/catalog.ts";

const repo = new URL("../../", import.meta.url);
export const IDENTITY = Object.freeze({ principal: "p-w51-CollaboratorGamma-readonly", rep: "CollaboratorGamma",
  root: "c3ca99d70c9a556f9c5fe58839734cd4", instance: "SALESOS-VERTIGO-20260916-56A0",
  mailbox: "person@example.test", spec: "SALES_RUNTIME_CONTRACT/0.5.0", schema: "SALES_SCHEMA/0.5.0" });
const READ_METHODS = ["retrievePage", "retrieveDatabase", "retrieveDataSource", "retrieveBlockChildren", "queryDataSource"];

export function assertCredentialFile(stat) {
  assert.ok(stat.isFile() && (stat.mode & 0o777) === 0o600 && stat.uid === process.getuid(),
    "W5.1 credential must be an owner-only regular file (0600)");
}
export function parseW51Credential(contents) {
  const c = parseEnv(contents);
  assert.deepEqual(Object.keys(c), ["NOTION_TOKEN"], "W5.1 isolated credential accepts only NOTION_TOKEN");
  const token = c.NOTION_TOKEN.trim();
  assert.ok(token && token !== "COLLER_LE_NOUVEAU_JETON_ICI", "W5.1 credential not supplied locally yet");
  return token;
}
async function readW51Credential() {
  const file = await open(new URL(".env.w51-readonly", repo), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { assertCredentialFile(await file.stat()); return parseW51Credential(await file.readFile("utf8")); }
  finally { await file.close(); }
}

export function assertAssignment(principals, runtimes) {
  assert.equal(principals.principals.length, 1); assert.equal(runtimes.runtimes.length, 1);
  const p = principals.principals[0], r = runtimes.runtimes[0];
  assert.equal(p.principal_id, IDENTITY.principal); assert.equal(p.status, "ACTIVE");
  assert.deepEqual(p.allowed_projects, ["VERTIGO"]); assert.deepEqual(p.allowed_lanes, ["SALES"]);
  assert.equal(p.rep_identity_key, IDENTITY.rep); assert.equal(r.rep_identity_key, IDENTITY.rep);
  assert.equal(r.status, "KNOWN"); assert.equal(r.root_ref, IDENTITY.root);
  assert.equal(r.expected_instance_id, IDENTITY.instance); assert.equal(r.expected_gmail_identity, IDENTITY.mailbox);
  assert.equal(r.pointer_generation, "1"); assert.equal(r.activation_proof_plan_id, undefined);
  assert.equal(r.objective_package_ref, undefined); assert.equal(p.meta_authority, undefined);
}

export function assertVersions(versions) {
  assert.equal(versions.governing_spec, IDENTITY.spec, "unexpected governing spec version");
  assert.equal(versions.governing_schema, IDENTITY.schema, "unexpected governing schema version");
}

export function assertReadRequest(url, init) {
  const u = new URL(url), method = init?.method ?? "GET", id = "[0-9a-f-]+";
  assert.equal(u.origin, "https://api.notion.com", "non-Notion origin refused before network");
  assert.equal(u.username + u.password, "");
  const get = new RegExp(`^/v1/(pages|databases|data_sources)/${id}$`).test(u.pathname)
    || new RegExp(`^/v1/blocks/${id}/children$`).test(u.pathname);
  const query = new RegExp(`^/v1/data_sources/${id}/query$`).test(u.pathname);
  assert.ok((method === "GET" && get) || (method === "POST" && query), "non-read endpoint refused before network");
  assert.ok([...u.searchParams.keys()].every(k => k === "start_cursor" || k === "page_size"));
}

export function assertDailyContext(selected) {
  assert.ok(selected, "selected_context missing");
  assert.equal(selected.policy_role, "CANDIDATE_NOT_ADOPTED");
  assert.equal(selected.contexts.length, 1); const daily = selected.contexts[0];
  assert.equal(daily.context, "DAILY");
  assert.equal(selected.bounds.max_rows_per_section, CONTEXT_BOUNDS.max_rows_per_section);
  assert.equal(selected.bounds.max_serialized_bytes, CONTEXT_BOUNDS.max_serialized_bytes);
  const bytes = Buffer.byteLength(JSON.stringify(selected), "utf8");
  assert.equal(bytes, selected.bounds.serialized_bytes); assert.ok(bytes <= CONTEXT_BOUNDS.max_serialized_bytes);
  assert.deepEqual(daily.sections.map(s => s.section_key), CONTEXT_SECTIONS.DAILY.map(s => s.section_key));
  daily.sections.forEach((s, i) => {
    const spec = CONTEXT_SECTIONS.DAILY[i]; assert.equal(s.source_key, spec.source_key);
    assert.deepEqual(s.projected_keys, [...spec.projected_keys]);
    assert.ok(["PRESENT", "ABSENT"].includes(s.source_status));
    assert.equal(s.served, s.items.length); assert.ok(s.served <= CONTEXT_BOUNDS.max_rows_per_section);
    assert.ok(Number.isInteger(s.available) && Number.isInteger(s.omitted) && s.available >= s.served && s.omitted === s.available - s.served);
    if (s.source_status === "ABSENT") assert.equal(s.served, 0);
    for (const item of s.items) assert.ok(Object.keys(item).every(k => spec.projected_keys.includes(k)), "unconfined projected field");
  });
  return { bytes, sections: daily.sections.map(s => ({ key: s.section_key, status: s.source_status, served: s.served,
    available: s.available, omitted: s.omitted, truncated_by: s.truncated_by })),
    absent_sources: daily.sections.filter(s => s.source_status === "ABSENT").map(s => s.source_key) };
}

/** Read acceptance only: never convert an operational HOLD into OK or approve an ABSENT cause. */
export function assertReadonlyResume(resume, selected) {
  assertVersions(resume.versions);
  assert.equal(selected?.policy_version, "CONTRACT_PACK/0.3.2-candidate");
  const proof = assertDailyContext(selected);
  if (resume.status !== "OK") {
    assert.equal(resume.status, "HOLD", "ERROR is not read acceptance");
    assert.equal(resume.code, "HOLD_REQUIRED_CAPABILITY_INCOMPLETE", "only the W5.1R Gmail HOLD is permitted");
    assert.deepEqual(resume.evidence, ["GMAIL_READ=UNKNOWN: no competent-source proof exists for this runtime, principal and operating mode"],
      "a different or additional HOLD cause requires its own diagnosis");
    const holds = selected.contexts[0].sections.find(s => s.section_key === "DAILY_HOLDS");
    assert.equal(holds.source_status, "PRESENT"); assert.equal(holds.items.length, 1);
    assert.equal(holds.items[0].code, resume.code);
    const action = holds.items[0].next_safe_action;
    assert.ok(typeof action === "string" && action.length > 0 && typeof resume.say === "string" && resume.say.includes(action),
      "the runtime HOLD and next safe action must remain visible");
  }
  return proof;
}

const sha = text => createHash("sha256").update(text).digest("hex");
async function configHashes() {
  return Object.fromEntries(await Promise.all(["config/principals.local.json", "config/sales-runtimes.local.json"].map(async path =>
    [path, sha(await readFile(new URL(path, repo)))])));
}

export async function main(args = process.argv.slice(2)) {
  assert.ok(args.length === 0 || (args.length === 1 && args[0] === "--check"), "fixed acceptance; no runtime, identity or authority arguments");
  const principals = JSON.parse(await readFile(new URL("config/w51.principals.json", repo), "utf8"));
  const runtimes = JSON.parse(await readFile(new URL("config/w51.sales-runtimes.json", repo), "utf8"));
  assertAssignment(principals, runtimes);
  if (args[0] === "--check") return { result: "OFFLINE_CHECK_ONLY", assignment_valid: true, network_calls: 0 };
  const token = await readW51Credential();
  const before = await configHashes(), c = parseEnv(await readFile(new URL(".env", repo), "utf8"));
  assert.ok(c.VERTIGO_META_SPEC_ROOT, "missing existing non-secret META spec pointer");
  const originalFetch = globalThis.fetch, http = []; let stopped = false, client, server;
  const out = { task: "W5.1", environment: "OWNER_AUTHORIZED_LOCAL_READONLY_ACCEPTANCE", assignment: IDENTITY,
    credential_source: "OWNER_SUPPLIED_ISOLATED_NOTION_TOKEN_NO_FALLBACK",
    before_live_config_hashes: before, calls: [], http, notion_writes: 0, gmail_calendar_calls: 0,
    backend: "VOLATILE_ISOLATED_BINDING_ONLY", transport: "IN_PROCESS_MCP_NO_HTTP_TOKEN_OR_SERVER",
    not_proved: "CollaboratorGamma authentication in ChatGPT, ordinary-chat UX, persistence, migration or adoption" };
  globalThis.fetch = async (url, init) => {
    assert.ok(!stopped, "STOP after first read failure; no retry or new dispatch"); assertReadRequest(url, init);
    const sample = { at: new Date().toISOString(), method: init?.method ?? "GET", endpoint: new URL(url).pathname };
    http.push(sample);
    try {
      const response = await originalFetch(url, { ...init, redirect: "error" }); sample.status = response.status;
      if (response.status >= 400) { stopped = true; throw new Error(`STOP read HTTP${response.status}`); }
      return response;
    } catch (e) { stopped = true; throw e; }
  };
  try {
    const base = buildDeps({ HARNESS_ENV: "live", HARNESS_TRANSPORT: "stdio", NOTION_TOKEN: token,
      VERTIGO_META_SPEC_ROOT: c.VERTIGO_META_SPEC_ROOT,
      PRINCIPALS_FILE: fileURLToPath(new URL("config/w51.principals.json", repo)),
      SALES_RUNTIME_REGISTRY_FILE: fileURLToPath(new URL("config/w51.sales-runtimes.json", repo)) });
    const active = new HttpNotionClient(token, (url, init) => fetch(url, init),
      { ratePerSecond: 2.8, burst: 1, shared429Cooldown: true, abortReadsOn429: true, max429Retries: 0, requestTimeoutMs: 30000 });
    const notion = new Proxy(active, { get(target, method) {
      assert.ok(READ_METHODS.includes(method), "non-read client method refused"); return target[method].bind(target);
    } });
    const { notionWriter: _discard, ...readonlyBase } = base;
    const deps = { ...readonlyBase, notion };
    assert.equal("notionWriter" in deps, false); assert.equal(deps.competentSource, undefined);
    assert.equal((await deps.salesRegistry.lookup(IDENTITY.rep)).root_ref, IDENTITY.root);
    server = createServer(deps, IDENTITY.principal); client = new Client({ name: "w51-readonly-acceptance", version: "1" });
    const [st, ct] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
    const call = async (name, input) => {
      assert.ok(["os_bind", "os_resume"].includes(name) && !stopped);
      const start = performance.now(), response = await client.callTool({ name, arguments: input }, undefined, { timeout: 180000 });
      const e = JSON.parse(response.content.find(x => x.type === "text").text);
      out.calls.push({ tool: name, status: e.status, code: e.code, elapsed_ms: Math.round(performance.now() - start) });
      console.error(JSON.stringify(out.calls.at(-1))); return e;
    };
    const bind = await call("os_bind", {});
    out.bind = { status: bind.status, code: bind.code, versions: bind.versions, binding: bind.binding,
      observations: bind.observations, evidence: bind.evidence, warnings: bind.warnings };
    assert.equal(bind.status, "OK", "real binding not proven"); assert.ok(!stopped);
    assert.equal(bind.observations.root_ref, IDENTITY.root); assert.equal(bind.observations.runtime_id, IDENTITY.instance);
    assertVersions(bind.versions);
    const binding = await deps.store.bindings.findByHandleHash(hashHandle(bind.result.binding_handle));
    assert.equal(binding?.binding_mode, "BUSINESS", "INSTALL_ONLY resume forbidden");
    const resume = await call("os_resume", { binding_handle: bind.result.binding_handle, topic_hint: "CURRENT_WORK" });
    out.resume = { status: resume.status, code: resume.code, versions: resume.versions,
      evidence: resume.evidence, warnings: resume.warnings, say: resume.say };
    const selected = resume.result?.contract_pack?.selected_context ?? resume.observations?.contract_pack?.selected_context;
    if (selected) out.selected_context = selected;
    out.context_proof = assertReadonlyResume(out.resume, selected); assert.ok(!stopped);
    // Even the authorized HOLD requires independently verified absence causes before gate PASS.
    out.result = out.context_proof.absent_sources.length ? "INCOMPLETE_REQUIRES_CONTRACT_DIAGNOSIS" : "READY_FOR_INDEPENDENT_GATE_REVIEW";
  } catch (e) {
    out.result = "HOLD_NOT_PASS"; out.stop = e.name === "AssertionError" ? e.message.split("\n")[0] : "read/transport failure; no automatic retry";
  } finally {
    await client?.close(); await server?.close(); globalThis.fetch = originalFetch;
    out.after_live_config_hashes = await configHashes(); assert.deepEqual(out.after_live_config_hashes, before);
    out.observed_at = new Date().toISOString(); out.total_http_reads = http.length;
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = await main(); console.log(JSON.stringify(out, null, 2));
  if (["HOLD_NOT_PASS", "INCOMPLETE_REQUIRES_CONTRACT_DIAGNOSIS"].includes(out.result)) process.exitCode = 1;
}
