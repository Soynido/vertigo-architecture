/** W4.7 real isolated Notion canary. Default mode is read-only; never use the LIVE registry. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildDeps, createServer } from "./src/index.ts";
import { PostgresBackend } from "./src/store/postgres.ts";
import { dispatch, resolveRuntimeFor } from "./src/tools/handlers.ts";
import { inspectInstallBootstrap } from "./src/install/bootstrap.ts";
import { hashHandle } from "./src/binding/handle.ts";
import { driveCapabilityCommit, preparedCapabilityDraft } from "./probe-w47-budget.mjs";
import { capabilityProofKey } from "./src/resume/capabilities.ts";

const root = "e033c8a8759159bda69b11cfee1f57b3";
const repo = new URL("../../", import.meta.url);
const install = process.argv.includes("--install");
const control = process.argv.includes("--control");
const resume = process.argv.includes("--resume");
const remediate = process.argv.includes("--remediate");
assert.ok([install, control, resume, remediate].filter(Boolean).length <= 1, "probe actions are mutually exclusive");
const existingIntegration = process.argv.includes("--existing-integration");
const canaryCredential = !existingIntegration && (install || process.argv.includes("--canary-credential"));
assert.ok(!(existingIntegration && process.argv.includes("--canary-credential")), "credential routes are mutually exclusive");
assert.ok(process.argv.slice(2).every((arg) => ["--install", "--control", "--resume", "--remediate", "--canary-credential", "--existing-integration"].includes(arg)), "unknown probe mode");
const hashes = {};
for (const path of [".env", "config/sales-runtimes.local.json", "config/principals.local.json"])
  hashes[path] = createHash("sha256").update(await readFile(new URL(path, repo))).digest("hex");
const env = { ...process.env, HARNESS_ENV: "live", HARNESS_TRANSPORT: "stdio",
  PRINCIPALS_FILE: fileURLToPath(new URL("config/w47.principals.json", repo)),
  SALES_RUNTIME_REGISTRY_FILE: fileURLToPath(new URL("config/w47.sales-runtimes.json", repo)),
  DATABASE_URL: "", HARNESS_FIXTURE_WORLD_FILE: "" };
if (canaryCredential) {
  // Never inherit the existing integration for an installation or silently fall back to it.
  const credential = parseEnv(await readFile(new URL(".env.w47-canary", repo), "utf8"));
  assert.ok(Object.keys(credential).every((key) => ["NOTION_TOKEN", "VERTIGO_META_SPEC_ROOT"].includes(key)), "canary credential file has unexpected keys");
  assert.ok(credential.NOTION_TOKEN?.trim(), "canary NOTION_TOKEN must be configured before any API call");
  delete env.NOTION_TOKEN;
  delete env.NOTION_READ_TOKEN;
  env.NOTION_TOKEN = credential.NOTION_TOKEN.trim();
  if (credential.VERTIGO_META_SPEC_ROOT) env.VERTIGO_META_SPEC_ROOT = credential.VERTIGO_META_SPEC_ROOT;
  assert.ok(!env.NOTION_READ_TOKEN, "canary credential must have no legacy fallback");
}
if (existingIntegration) {
  // Owner-approved capability change, not permission to write LIVE. The exact canary assignment stays fixed.
  const credential = parseEnv(await readFile(new URL(".env", repo), "utf8"));
  const canonical = credential.NOTION_TOKEN?.trim();
  const legacy = credential.NOTION_READ_TOKEN?.trim();
  assert.ok(!(canonical && legacy && canonical !== legacy), "existing integration aliases must agree");
  const token = canonical || legacy;
  assert.ok(token, "existing integration credential must be configured before any API call");
  delete env.NOTION_TOKEN;
  delete env.NOTION_READ_TOKEN;
  env.NOTION_TOKEN = token;
  if (credential.VERTIGO_META_SPEC_ROOT) env.VERTIGO_META_SPEC_ROOT = credential.VERTIGO_META_SPEC_ROOT;
}
let deps = buildDeps(env);
// Engineering latency evidence only: method names/durations, never ids, query bodies or credentials.
// Each read still reaches the original client and keeps its pacing/semantics; no extra API request.
const readCosts = [];
const originalReader = deps.notion;
deps = { ...deps, notion: Object.fromEntries(
  ["retrievePage", "retrieveDatabase", "retrieveDataSource", "retrieveBlockChildren", "queryDataSource"].map((method) =>
    [method, async (...args) => {
      const started = Date.now();
      try { return await originalReader[method](...args); }
      finally { readCosts.push({ method, elapsed_ms: Date.now() - started }); }
    }]),
) };
let backend;
if (install || control || resume || remediate) {
  // This fixed loopback database is distinct from every LIVE and prior test store. Never inherit DATABASE_URL.
  backend = new PostgresBackend("postgresql://operator@127.0.0.1:5432/vertigo_w47_canary");
  await backend.migrateAll(new URL("./migrations/", import.meta.url));
  deps = { ...deps, store: backend.store() };
}
const assignment = await deps.salesRegistry.lookup("valentin");
assert.equal(assignment.root_ref, root);
assert.equal(assignment.expected_gmail_identity, "person@example.test");
const ctx = { principal_id: "p-valentin" };
let client, server;
if (install || control || resume || remediate) {
  server = createServer(deps, ctx.principal_id);
  client = new Client({ name: "w47-isolated-real-canary-probe", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
}
const call = async (name, args) => {
  const first = readCosts.length;
  try {
    if (!client) return await dispatch(name, args, ctx, deps);
    const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
    return JSON.parse(response.content.find((c) => c.type === "text").text);
  } finally { console.error(JSON.stringify({ read_cost_tool: name, reads: readCosts.slice(first) })); }
};
const bind = await call("os_bind", { project: "VERTIGO", lane: "SALES" });
const out = { observed_at: new Date().toISOString(), environment: "ISOLATED_REAL_NOTION_CANARY_ENGINEERING",
  read_only: !install && !resume && !remediate, credential_source: existingIntegration ? "OWNER_APPROVED_EXISTING_FILE" : canaryCredential ? "ISOLATED_CANARY_FILE" : "EXISTING_READ_INSPECTION_ONLY",
  root, live_config_hashes_before: hashes, bind };
let succeeded = bind.status === "OK";
if (bind.status === "OK") {
  const handle = bind.result.binding_handle;
  assert.equal(bind.observations.root_ref, root);
  if (control || resume || remediate) {
    out.binding_mode = (await backend.store().bindings.findByHandleHash(hashHandle(handle)))?.binding_mode;
    assert.equal(out.binding_mode, "BUSINESS", "CONTROL requires completed installation");
    const field = control ? "control" : "resume";
    out[field] = await call(control ? "os_control_status" : "os_resume", { binding_handle: handle });
    succeeded = out[field].status === "OK";
    if (remediate) {
      const challenge = out.resume.observations?.capability_remediation;
      assert.equal(out.resume.code, "HOLD_REQUIRED_CAPABILITY_INCOMPLETE");
      assert.ok(challenge?.challenge && challenge?.competent_source);
      console.error(JSON.stringify({ native_read_required: challenge.capability, competent_source: challenge.competent_source,
        issued_at: challenge.issued_at, expires_at: challenge.expires_at }));
      const input = createInterface({ input: process.stdin });
      const [line] = await once(input, "line");
      input.close();
      assert.ok(Buffer.byteLength(line, "utf8") <= 8192, "native evidence exceeds probe limit");
      const evidence = JSON.parse(line);
      assert.ok(Object.keys(evidence).every((key) => ["competent_source", "source_identity", "evidence_ref", "verified_at"].includes(key)));
      assert.equal(evidence.competent_source, challenge.competent_source);
      const args = { binding_handle: handle, capability_evidence: { ...evidence, challenge: challenge.challenge } };
      const binding = await backend.store().bindings.findByHandleHash(hashHandle(handle));
      assert.ok(binding, "the exact binding must exist in the isolated backend");
      const requirement = out.resume.observations.capability_completeness?.comparisons.find((c) => c.capability === challenge.capability);
      assert.ok(requirement?.requirement === "REQUIRED" && requirement.operating_modes?.[0], "signed capability requirement must remain explicit");
      const principalKey = bind.observations.rep_identity_key;
      const mode = requirement.operating_modes[0];
      const verifiedAt = new Date(Math.floor(Date.parse(evidence.verified_at) / 60_000) * 60_000).toISOString();
      const sourceIdentity = challenge.competent_source === "GMAIL" ? bind.observations.mailbox_identity.toLowerCase() : principalKey;
      const key = capabilityProofKey({ runtimeId: binding.runtime_id, principalKey, capability: challenge.capability,
        operatingMode: mode, verifiedAt, evidenceRef: evidence.evidence_ref });
      const expected = { natural_key: key, values: {
        "Capability Proof Key": key, "Capability Proof": `${challenge.capability} verified by ${challenge.competent_source}`,
        "Capability Key": challenge.capability, State: "READ_VERIFIED", "Runtime ID": binding.runtime_id,
        "Principal Key": principalKey, "Operating Mode": mode, "Competent Source": challenge.competent_source,
        "Evidence Ref": evidence.evidence_ref, "Verified At": verifiedAt,
        Scope: `principal:${principalKey};runtime:${binding.runtime_id};source:${challenge.competent_source};identity:${sourceIdentity};access:read`,
      } };
      const progress = async () => {
        const rows = await backend.pool.query(`SELECT
          (SELECT count(*)::int FROM plan_writes w JOIN plans p ON p.plan_id=w.plan_id
            WHERE p.runtime_id=$1 AND p.principal_id=$2 AND p.runtime_generation=$3 AND w.status IN ('DONE','OBSERVED')) AS settled_writes,
          (SELECT count(*)::int FROM receipts r JOIN plans p ON p.plan_id=r.plan_id
            WHERE p.runtime_id=$1 AND p.principal_id=$2 AND p.runtime_generation=$3 AND r.type IN ('TARGET','FINAL') AND r.status IN ('VALID','CONSUMED')) AS verified_receipts`,
          [bind.binding.runtime_id, ctx.principal_id, bind.binding.runtime_generation]);
        const plans = await backend.store().plans.listByRuntime(binding.project, binding.lane, binding.runtime_generation);
        const now = Date.now();
        const active = plans.filter((p) => ["AWAITING_STAGE1_WRITES", "TARGET_VERIFIED", "AWAITING_FINAL_VERIFY"].includes(p.plan_state) && p.expires_at.getTime() > now);
        const plan = active.length === 1 ? active[0] : undefined;
        return { ...rows.rows[0], active_plan_ids: active.map((p) => p.plan_id), prepared_capability: preparedCapabilityDraft({
          plan, binding, expected, now, writes: plan ? await backend.store().planWrites.list(plan.plan_id) : [],
        }) };
      };
      const driven = await driveCapabilityCommit({ call: () => call("os_commit", args), progress,
        expiresAt: challenge.expires_at, report: (r) => console.error(JSON.stringify(r)) });
      out.capability_calls = driven.calls;
      out.capability_stopped_at = driven.stopped_at;
      out.capability_commit = driven.calls.at(-1);
      succeeded = out.capability_commit?.kind === "PERSISTED";
    }
  } else if (!install) {
    const principal = await deps.principals.get(ctx.principal_id);
    const resolved = await resolveRuntimeFor(deps, principal, "VERTIGO", "SALES");
    assert.equal(resolved.kind, "RESOLVED");
    assert.equal(resolved.runtime.root_ref, root);
    out.install_inspection = await inspectInstallBootstrap(deps.notion, resolved.runtime);
  } else {
      // os_resume owns fresh bootstrap verification. Do not duplicate its full read here.
      assert.equal(bind.observations.binding_mode, "INSTALL_ONLY");
      out.install_calls = [];
      succeeded = false;
      const progress = async () => JSON.stringify((await backend.pool.query(
        "SELECT plan_id, plan_state, (SELECT count(*) FROM plan_writes w WHERE w.plan_id=p.plan_id AND w.status IN ('DONE','OBSERVED')) AS completed_writes FROM plans p ORDER BY created_at, plan_id"
      )).rows);
      for (let n = 1; n <= 8; n += 1) {
        const beforeProgress = await progress();
        const reply = await call("os_resume", { binding_handle: handle });
        out.install_calls.push(reply);
        console.error(JSON.stringify({ call: n, status: reply.status, code: reply.code,
          phase: reply.result?.installation?.phase, writes_sent: reply.result?.installation?.writes_sent ?? reply.observations?.writes_sent }));
        if (reply.status !== "OK") break;
        assert.ok((reply.result?.installation?.writes_sent ?? 0) <= 30, "installer exceeded K30");
        if (reply.result?.installation?.manifest_promoted === true) {
          out.fresh_bind = await call("os_bind", { project: "VERTIGO", lane: "SALES" });
          out.fresh_binding_mode = out.fresh_bind.status === "OK"
            ? (await backend.store().bindings.findByHandleHash(hashHandle(out.fresh_bind.result.binding_handle)))?.binding_mode
            : undefined;
          succeeded = out.fresh_bind.status === "OK" && out.fresh_binding_mode === "BUSINESS";
          if (out.fresh_bind.status === "OK") out.fresh_bind.result.binding_handle = "<redacted>";
          break;
        }
        // Budget/batch boundaries may continue only when the durable journal actually advanced.
        // An unchanged interruption, index lag or refusal is never blindly retried.
        const stopped = reply.result?.installation?.stopped_at;
        if (stopped && !["BUDGET", "BATCH_LIMIT"].includes(stopped)) break;
        if (stopped && (await progress()) === beforeProgress) {
          out.no_progress_boundary = stopped;
          break;
        }
      }
      out.assignment_after = await deps.salesRegistry.lookup("valentin");
  }
  bind.result.binding_handle = "<redacted>";
}
const after = {};
for (const path of Object.keys(hashes)) after[path] = createHash("sha256").update(await readFile(new URL(path, repo))).digest("hex");
assert.deepEqual(after, hashes, "LIVE deployment configuration changed");
out.live_config_hashes_after = after;
console.log(JSON.stringify(out, (key, value) => ["binding_handle", "challenge"].includes(key) ? "<redacted>" : value, 2));
await client?.close();
await server?.close();
await backend?.close();
process.exit(succeeded ? 0 : 1);
