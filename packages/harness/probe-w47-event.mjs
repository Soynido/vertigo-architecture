/** W4.7 one fixed owner-authorized native mail capture. NO send API; writes only to the isolated canary. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseEnv, isDeepStrictEqual } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildDeps, createServer } from "./src/index.ts";
import { PostgresBackend } from "./src/store/postgres.ts";
import { hashHandle } from "./src/binding/handle.ts";
import { externalIdentityKey } from "./src/effects/gmail.ts";
import { HttpNotionClient } from "./src/notion/client.ts";
import { untouchedEventDraft, exactUnwrittenPredecessor, fixedStartedEvent, exactPreparedEventRecovery, replayUnchanged,
  eventProbeMode, partialProbeStop, partialCheckpoint, finalCheckpoint, exactPartialEventCheckpoint, exactPreparedPartialRecovery,
  exactFinalEventCheckpoint, exactPreparedFinalRecovery, cutoffCheckpoint,
  exactCutoffEventCheckpoint, exactPreparedCutoffRecovery, cutoffContinuation } from "./probe-w47-event-proof.mjs";

const selected = eventProbeMode(process.argv.slice(2));
assert.ok(selected, "fixed-event probe accepts only closed modes, no authority arguments");
if (selected.check) { console.log("fixed partial-lineage burst10 check; no credential/network access"); process.exit(0); }
const finalTail = selected.mode === "RECOVER_FINAL_BURST10";
const cutoff = selected.mode === "RECOVER_CUTOFF";
const partial = selected.mode === "RECOVER_PARTIAL_BURST10" || finalTail || cutoff, recovering = selected.mode !== "CAPTURE";
const burst = cutoff ? 1 : 10;
const repo = new URL("../../", import.meta.url);
const root = "e033c8a8759159bda69b11cfee1f57b3";
const id = "1a1169f26e070c81";
const account = "9ee569f237425a5eb89c230bd79311b6";
const contacts = ["47b23b6c5f9d506dbc09de9cb4e567d4", "9414de69ad9c5f79b552f4c520a3d3fa", "6d055212d86354dcb34b4db1a26d17a7"].sort();
const evidence = {
  provider: "GMAIL", source_identity: "person@example.test", evidence_ref: `gmail:message/${id}`,
  observed_at: "2026-10-07T13:49:49.000Z",
  message: { message_id: id, thread_id: id, from: "person@example.test",
    to: ["person@example.test", "person@example.test", "person@example.test"], date: "2026-10-07T13:48:11.000Z" },
  contact_refs: contacts,
};
const key = externalIdentityKey({ provider: "GMAIL", source_identity: evidence.source_identity, event_id: id });
assert.ok(key);
const common = { Provider: "GMAIL", "Source Identity": evidence.source_identity, "Event ID": id, "Thread ID": id, "Occurred At": evidence.message.date };
const expected = [
  { resource: "SALES:INTERACTIONS", natural_key_property: "Event Key", values: {
    Interaction: "Gmail outbound", "Event Key": key, ...common, "Receipt Key": key, Accounts: [account], Contacts: contacts,
  } },
  { resource: "SALES:RECEIPTS", natural_key_property: "Idempotency Key", values: {
    Receipt: "Gmail outbound capture", "Idempotency Key": key, "Event Type": "GMAIL_SEND", ...common,
    "Observed At": evidence.observed_at, "Evidence Ref": evidence.evidence_ref, "Interaction Key": key,
    "Intent Ref": "", Provenance: "SOURCE_ATTESTED_BY_NATIVE_READ", "Effect Status": "ATTESTED_SENT", Verified: false,
  } },
];
const paths = [".env", "config/sales-runtimes.local.json", "config/principals.local.json"];
const hashes = async () => Object.fromEntries(await Promise.all(paths.map(async (p) => [p, createHash("sha256").update(await readFile(new URL(p, repo))).digest("hex")])));
const beforeHashes = await hashes();
const c = parseEnv(await readFile(new URL(".env", repo), "utf8"));
const a = c.NOTION_TOKEN?.trim(), l = c.NOTION_READ_TOKEN?.trim();
assert.ok(!(a && l && a !== l) && (a || l) && c.VERTIGO_META_SPEC_ROOT);
const base = buildDeps({ ...process.env, NOTION_TOKEN: a || l, NOTION_READ_TOKEN: "", VERTIGO_META_SPEC_ROOT: c.VERTIGO_META_SPEC_ROOT,
  HARNESS_ENV: "live", HARNESS_TRANSPORT: "stdio", HARNESS_FIXTURE_WORLD_FILE: "", DATABASE_URL: "",
  PRINCIPALS_FILE: fileURLToPath(new URL("config/w47.principals.json", repo)),
  SALES_RUNTIME_REGISTRY_FILE: fileURLToPath(new URL("config/w47.sales-runtimes.json", repo)) });
assert.equal((await base.salesRegistry.lookup("valentin")).root_ref, root);
const backend = new PostgresBackend("postgresql://operator@127.0.0.1:5432/vertigo_w47_canary");
const http = [];
// Opt-in only: ONE active transport for reads AND writes; the buildDeps default is never dispatched.
const activeNotion = partial ? new HttpNotionClient(a || l, async (url, init) => {
  const at = Date.now();
  assert.ok(http.filter((r) => r.at > at - 60_000).length < 178, "canary rolling minute ceiling before dispatch");
  const sample = { at, method: init.method, write: init.method === "PATCH" || (init.method === "POST" && new URL(url).pathname === "/v1/pages") };
  http.push(sample); const response = await fetch(url, init); sample.status = response.status; return response;
}, { ratePerSecond: 2.8, burst, shared429Cooldown: true, abortReadsOn429: cutoff, max429Retries: 4, retryBaseMs: 1000, requestTimeoutMs: 30000 }) : base.notion;
const store = backend.store(), deps = { ...base, store,
  ...(partial ? { notion: activeNotion, notionWriter: activeNotion } : {}) };
const server = createServer(deps, "p-valentin"), client = new Client({ name: "w47-fixed-native-event-probe", version: "1" });
const [st, ct] = InMemoryTransport.createLinkedPair();
const out = { task: "W4.7", environment: "ISOLATED_REAL_NOTION_CANARY_ENGINEERING", native_evidence: evidence,
  mode: selected.mode, email_send_calls: 0, before_live_hashes: beforeHashes, calls: [],
  ...(partial ? { canary_http_policy: { rate: 2.8, burst, shared429Cooldown: true, abortReadsOn429: cutoff, active_clients: 1 }, http } : {}) };
let success = false;
const call = async (name, args) => {
  assert.ok(!partial || !http.some((r) => r.status === 429), "STOP HTTP429: no further tool call or client recreation");
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  assert.equal(r.isError, false);
  return JSON.parse(r.content.find((x) => x.type === "text").text);
};
try {
  await Promise.all([server.connect(st), client.connect(ct)]);
  const bound = await call("os_bind", { project: "VERTIGO", lane: "SALES" });
  assert.ok(!partial || !http.some((r) => r.status === 429), "STOP HTTP429 during fresh binding; no commit");
  assert.equal(bound.status, "OK"); assert.equal(bound.observations.root_ref, root);
  const handle = bound.result.binding_handle, binding = await store.bindings.findByHandleHash(hashHandle(handle));
  assert.equal(binding.binding_mode, "BUSINESS");
  assert.equal(binding.runtime_id, "SALES-W47-CANARY-20261005");
  assert.equal(binding.runtime_generation, "aaced2bc8bd07f51ab77a4da073562e0");
  const recoveryRoot = "EzNnzw-ZQJ9c6i15_6p_uX3cd-2U4KXj";
  let checkpointRoot, checkpointChild;
  if (partial) {
    const entries = [];
    for (const p of await store.plans.listByRuntime(binding.project, binding.lane, binding.runtime_generation))
      entries.push({ p, journal: await store.planWrites.list(p.plan_id) });
    const lease = await store.leases.current({ project: binding.project, lane: binding.lane, runtime_generation: binding.runtime_generation }, new Date());
    assert.ok((cutoff ? exactCutoffEventCheckpoint : finalTail ? exactFinalEventCheckpoint : exactPartialEventCheckpoint)(entries, binding, expected, key, Date.now(), lease), "exact expired partial-lineage checkpoint; no guess or journal repair");
    checkpointRoot = entries.find(({ p }) => p.plan_id === partialCheckpoint.root_id).p;
    checkpointChild = entries.find(({ p }) => p.plan_id === (cutoff ? cutoffCheckpoint.cutoff_child_id : finalTail ? finalCheckpoint.final_child_id : partialCheckpoint.child_id)).p;
    out.recovery_readback = { original_plan_id: checkpointRoot.plan_id, partial_plan_id: checkpointChild.plan_id, run_ref: partialCheckpoint.run_ref, exact: true };
  } else if (recovering) {
    const owed = (await store.plans.listByRuntime(binding.project, binding.lane, binding.runtime_generation))
      .filter((p) => p.principal_id === binding.principal_id && ["AWAITING_STAGE1_WRITES", "TARGET_VERIFIED", "AWAITING_FINAL_VERIFY", "EXPIRED"].includes(p.plan_state));
    const started = [];
    for (const p of owed) {
      const journal = await store.planWrites.list(p.plan_id);
      if (journal.some((r) => r.status !== "PENDING")) started.push({ p, journal });
    }
    assert.equal(started.length, 1, "require unique own started journal; no guess among plans");
    assert.equal(started[0].p.plan_id, recoveryRoot);
    assert.ok(owed.every((p) => p.plan_id === recoveryRoot || p.plan_state === "EXPIRED" || p.expires_at.getTime() <= Date.now()), "another live virgin plan forbids recovery probe");
    assert.ok(fixedStartedEvent(started[0].p, started[0].journal, binding, expected, key), "exact started capture/journal checkpoint required");
    out.recovery_readback = { original_plan_id: started[0].p.plan_id, run_ref: started[0].journal.find((r) => r.symbol === "OPEN_RUN").created_id, exact: true };
  }
  const progress = async (scope = recovering ? recoveryRoot : null) => {
    const rows = await backend.pool.query(`SELECT
      (SELECT count(*)::int FROM plan_writes w JOIN plans p ON p.plan_id=w.plan_id WHERE p.runtime_id=$1 AND p.principal_id=$2 AND p.runtime_generation=$3 AND ($4::text IS NULL OR p.plan_id=$4 OR p.recovers_plan_id=$4) AND w.status IN ('DONE','OBSERVED')) AS writes,
      (SELECT count(*)::int FROM receipts r JOIN plans p ON p.plan_id=r.plan_id WHERE p.runtime_id=$1 AND p.principal_id=$2 AND p.runtime_generation=$3 AND ($4::text IS NULL OR p.plan_id=$4 OR p.recovers_plan_id=$4) AND r.type IN ('TARGET','FINAL') AND r.status IN ('VALID','CONSUMED')) AS receipts`,
      [binding.runtime_id, binding.principal_id, binding.runtime_generation, scope]);
    const plans = await store.plans.listByRuntime(binding.project, binding.lane, binding.runtime_generation);
    return { ...rows.rows[0], plans: plans.filter((p) => p.principal_id === binding.principal_id && p.runtime_id === binding.runtime_id).length,
      active: plans.filter((p) => ["AWAITING_STAGE1_WRITES", "TARGET_VERIFIED", "AWAITING_FINAL_VERIFY"].includes(p.plan_state) && p.expires_at.getTime() > Date.now()).map((p) => p.plan_id) };
  };
  const preparedHandoff = async (reply, before, after) => {
    if (before.active.length > 1 || after.active.length !== 1 || after.active[0] !== reply.plan_id || reply.phase !== "STAGE1" || reply.writes_done !== 0) return false;
    const p = await store.plans.get(reply.plan_id);
    if (!p || p.plan_kind !== "BUSINESS" || p.plan_state !== "AWAITING_STAGE1_WRITES" || p.run_mode !== "OPEN_NEW" || p.recovers_plan_id || (p.plan_origin ?? "INTENT") !== "INTENT" || p.expires_at.getTime() <= Date.now()) return false;
    for (const k of ["binding_id", "principal_id", "project", "lane", "runtime_logical_key", "runtime_id", "runtime_generation"]) if (p[k] !== binding[k]) return false;
    for (const [k, field] of [["spec", "governing_spec_version"], ["schema", "governing_schema_version"], ["control", "governing_control_version"]]) if (p[field] !== (binding.governing_versions_snapshot[k] ?? "UNKNOWN")) return false;
    if (p.operations.length !== 2 || !p.operations.every((op, i) => op.operation === "CREATE" && op.logical_resource_key === expected[i].resource && op.natural_key_property === expected[i].natural_key_property && op.natural_key === key && isDeepStrictEqual(op.expected_values, expected[i].values))) return false;
    const journal = await store.planWrites.list(p.plan_id);
    if (!untouchedEventDraft(p, journal)) return false;
    if (before.active.length === 0) return true;
    const previous = await store.plans.get(before.active[0]);
    return previous !== undefined && exactUnwrittenPredecessor(previous, p, await store.planWrites.list(previous.plan_id));
  };
  const args = { binding_handle: handle, external_event_evidence: evidence };
  let successorId;
  for (let n = 1; n <= (cutoff ? 8 : 6); n++) {
    if (partial && http.some((r) => r.status === 429)) { out.stopped_at = "HTTP429"; break; }
    if (binding.expires_at.getTime() <= Date.now()) { out.stopped_at = "EXPIRED"; break; }
    const before = await progress();
    if (binding.expires_at.getTime() <= Date.now()) { out.stopped_at = "EXPIRED"; break; }
    const started = Date.now(), reply = await call("os_commit", recovering ? { binding_handle: handle } : args), after = await progress();
    out.calls.push(reply);
    console.error(JSON.stringify({ call: n, elapsed_ms: Date.now() - started, kind: reply.kind, phase: reply.phase, reason: reply.reason, before, after }));
    if (recovering && ["PERSISTED", "IN_PROGRESS"].includes(reply.kind)) assert.ok(reply.plan_id, "progress reply requires lineage id");
    if (recovering && reply.plan_id) {
      const p = await store.plans.get(reply.plan_id);
      assert.ok(p && (p.plan_id === recoveryRoot || p.recovers_plan_id === recoveryRoot), "reply must stay on original lineage");
      for (const k of ["principal_id", "project", "lane", "runtime_logical_key", "runtime_id", "runtime_generation"]) assert.equal(p[k], binding[k]);
      for (const [k, field] of [["spec", "governing_spec_version"], ["schema", "governing_schema_version"], ["control", "governing_control_version"]]) assert.equal(p[field], binding.governing_versions_snapshot[k]);
      assert.equal(p.operations.length, 2);
      assert.ok(p.operations.every((op, i) => op.operation === "CREATE" && op.logical_resource_key === expected[i].resource
        && op.natural_key_property === expected[i].natural_key_property && op.natural_key === key && isDeepStrictEqual(op.expected_values, expected[i].values)));
    }
    if (partial) { const stop = partialProbeStop(reply, http); if (stop) { out.stopped_at = stop; break; } }
    if (cutoff) {
      const p = n === 1 && reply.plan_id ? await store.plans.get(reply.plan_id) : undefined;
      const handoffValid = p && exactPreparedCutoffRecovery(p, await store.planWrites.list(p.plan_id), checkpointRoot, checkpointChild, binding, Date.now());
      const decision = cutoffContinuation(n, reply, before, after, handoffValid, successorId);
      if (decision === "STOP") { out.stopped_at = "HANDOFF_OR_SUCCESSOR_REFUSED"; break; }
      if (decision === "HANDOFF") { successorId = p.plan_id; console.error(JSON.stringify({ prepared_recovery_handoff: successorId })); continue; }
    }
    if (reply.kind === "PERSISTED") { success = true; out.stopped_at = "PERSISTED"; break; }
    if (reply.kind !== "IN_PROGRESS" || reply.reason !== "BUDGET") { out.stopped_at = "REFUSED_OR_INTERRUPTED"; break; }
    if (binding.expires_at.getTime() <= Date.now()) { out.stopped_at = "EXPIRED"; break; }
    if (after.writes > before.writes || after.receipts > before.receipts) continue;
    if (recovering && n === 1 && reply.phase === "STAGE1" && reply.writes_done === 0
      && before.active.length === 0 && after.active.length === 1 && after.active[0] === reply.plan_id
      && after.plans === before.plans + 1 && before.writes === after.writes && before.receipts === after.receipts) {
      const p = await store.plans.get(reply.plan_id), parent = await store.plans.get(recoveryRoot);
      const valid = p && parent && (partial
        ? (cutoff ? exactPreparedCutoffRecovery : finalTail ? exactPreparedFinalRecovery : exactPreparedPartialRecovery)(p, await store.planWrites.list(p.plan_id), checkpointRoot, checkpointChild, binding, Date.now())
        : exactPreparedEventRecovery(p, await store.planWrites.list(p.plan_id), parent,
          await store.planWrites.list(parent.plan_id), binding, expected, key, Date.now()));
      if (valid) {
        console.error(JSON.stringify({ prepared_recovery_handoff: p.plan_id })); continue;
      }
    }
    if (!recovering && n === 1 && await preparedHandoff(reply, before, after)) { console.error(JSON.stringify({ prepared_handoff: reply.plan_id })); continue; }
    out.stopped_at = "NO_DURABLE_PROGRESS"; break;
  }
  if (!out.stopped_at) out.stopped_at = "CALL_LIMIT";
  if (success) {
    const before = await progress(null); out.replay = await call("os_commit", args); const after = await progress(null);
    if (partial && http.some((r) => r.status === 429)) { success = false; out.stopped_at = "HTTP429"; throw new Error("STOP HTTP429 during replay"); }
    out.replay_counts = { before, after, scope: "WHOLE_OWN_RUNTIME" };
    out.replay_zero_writes = replayUnchanged(before, after);
    assert.equal(out.replay.kind, "PERSISTED"); assert.equal(out.replay.repeated, true); assert.ok(out.replay_zero_writes);
    const fresh = await call("os_bind", { project: "VERTIGO", lane: "SALES" });
    assert.equal(fresh.status, "OK"); assert.equal(fresh.observations.root_ref, root);
    out.fresh_resume = await call("os_resume", { binding_handle: fresh.result.binding_handle });
    assert.equal(out.fresh_resume.status, "OK");
    if (partial && http.some((r) => r.status === 429)) { success = false; out.stopped_at = "HTTP429"; }
  }
} finally {
  out.after_live_hashes = await hashes(); assert.deepEqual(out.after_live_hashes, beforeHashes);
  console.log(JSON.stringify(out, (k, v) => ["binding_handle", "challenge"].includes(k) ? "<redacted>" : v, 2));
  await client.close(); await server.close(); await backend.close();
}
process.exitCode = success ? 0 : 1;
