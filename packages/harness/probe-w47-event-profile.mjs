/** Closed READONLY diagnostic: no commit, writer, lease mutation or old-handle authority. */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { buildDeps } from "./src/index.ts";
import { HttpNotionClient } from "./src/notion/client.ts";
import { PostgresBackend } from "./src/store/postgres.ts";
import { resolveRuntimeFor } from "./src/tools/handlers.ts";
import { openGuard, guardStillApproved } from "./src/guards/preflight.ts";
import { externalEventJournalConsistent, externalEventPlanStillOwned, eventRecoveryClassesApproved } from "./src/effects/eventWrite.ts";

const flags = process.argv.slice(2).join(" ");
assert.ok(["", "--check", "--burst10", "--burst10 --check"].includes(flags), "fixed readonly diagnostic; no authority arguments");
const burst = process.argv.includes("--burst10") ? 10 : 1;
if (process.argv.includes("--check")) { console.log(`READONLY profile check; burst${burst}; no credential/network access`); process.exit(0); }
const repo = new URL("../../", import.meta.url);
const planId = "VIxazmjM5KwLXraYoty_Yur5L2tkIfZn";
const c = parseEnv(await readFile(new URL(".env", repo), "utf8"));
const token = c.NOTION_TOKEN?.trim(), legacy = c.NOTION_READ_TOKEN?.trim();
assert.ok(!(token && legacy && token !== legacy) && (token || legacy) && c.VERTIGO_META_SPEC_ROOT);
const context = new AsyncLocalStorage(), reads = [], http = [];
const fetchOriginal = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = new URL(url), method = init?.method ?? "GET";
  assert.equal(u.origin, "https://api.notion.com");
  assert.ok(method === "GET" || (method === "POST" && /^\/v1\/data_sources\/[0-9a-f-]+\/query$/.test(u.pathname)), "READONLY HTTP gate before network");
  const r = context.getStore(), begin = performance.now();
  const sample = { phase: r?.phase ?? "UNATTRIBUTED", method, endpoint: u.pathname.replace(/[0-9a-f-]{32,}/g, ":id"),
    read_id: r?.id, dispatch_ms: begin, wait_before_http_ms: r ? begin - r.start : null };
  http.push(sample);
  try {
    const response = await fetchOriginal(url, init); sample.status = response.status;
    return new Proxy(response, { get(target, property) {
      if (property === "json") return async () => {
        const start = performance.now(); try { return await target.json(); }
        finally { sample.body_json_ms = performance.now() - start; }
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  } finally { sample.network_to_headers_ms = performance.now() - begin; }
};
const base = buildDeps({ ...process.env, NOTION_TOKEN: token || legacy, NOTION_READ_TOKEN: "", VERTIGO_META_SPEC_ROOT: c.VERTIGO_META_SPEC_ROOT,
  HARNESS_ENV: "live", HARNESS_TRANSPORT: "stdio", HARNESS_FIXTURE_WORLD_FILE: "", DATABASE_URL: "",
  PRINCIPALS_FILE: fileURLToPath(new URL("config/w47.principals.json", repo)),
  SALES_RUNTIME_REGISTRY_FILE: fileURLToPath(new URL("config/w47.sales-runtimes.json", repo)) });
// buildDeps constructs its default reader but performs no reads. Exactly ONE reader is dispatched here;
// neither the unused default client nor its writer is called in burst10 mode.
const activeReader = burst === 1 ? base.notion : new HttpNotionClient(token || legacy,
  (url, init) => fetch(url, init), { ratePerSecond: 2.8, burst: 10, shared429Cooldown: true,
    max429Retries: 4, retryBaseMs: 1000, requestTimeoutMs: 30000 });
let phase = "INITIAL";
const notion = new Proxy(activeReader, { get(target, method) {
  const fn = target[method]; if (typeof fn !== "function") return fn;
  return (...args) => {
    assert.ok(["retrievePage", "retrieveDatabase", "retrieveDataSource", "retrieveBlockChildren", "queryDataSource"].includes(method), "readonly method gate");
    const sample = { id: reads.length, phase, method, object_hash: createHash("sha256").update(String(args[0])).digest("hex"), start: performance.now() };
    reads.push(sample);
    return context.run(sample, async () => { try { return await fn.apply(target, args); }
      finally { sample.elapsed_ms = performance.now() - sample.start; } });
  };
} });
const backend = new PostgresBackend("postgresql://operator@127.0.0.1:5432/vertigo_w47_canary"), store = backend.store();
const { notionWriter: _discarded, ...readonlyBase } = base;
const deps = { ...readonlyBase, notion, store };
const stages = [], measure = async (name, fn) => {
  phase = name; const start = performance.now(), count = reads.length;
  const result = await fn();
  stages.push({ name, elapsed_ms: performance.now() - start, reads: reads.length - count,
    result: typeof result === "boolean" ? result : result?.kind });
  console.error(JSON.stringify(stages.at(-1))); return result;
};
try {
  const plan = await store.plans.get(planId); assert.ok(plan);
  assert.equal(plan.principal_id, "p-valentin"); assert.equal(plan.runtime_id, "SALES-W47-CANARY-20261005");
  assert.equal(plan.runtime_generation, "aaced2bc8bd07f51ab77a4da073562e0");
  const before = await store.planWrites.list(planId);
  const hashes = await backend.pool.query("select handle_hash from bindings where binding_id=$1", [plan.binding_id]);
  assert.equal(hashes.rows.length, 1);
  const binding = await store.bindings.findByHandleHash(hashes.rows[0].handle_hash); assert.ok(binding);
  const principal = await deps.principals.get(binding.principal_id); assert.ok(principal && principal.status === "ACTIVE");
  const resolved = await measure("resolve_READONLY", () => resolveRuntimeFor(deps, principal, "VERTIGO", "SALES"));
  assert.equal(resolved.kind, "RESOLVED"); const runtime = resolved.runtime;
  assert.equal(runtime.root_ref, "e033c8a8759159bda69b11cfee1f57b3");
  const guard = await measure("recovery_open_guard", () => openGuard(deps, binding, runtime, new Date()));
  assert.equal(guard.kind, "OPEN");
  await measure("recovery_classes", () => eventRecoveryClassesApproved(deps, plan, guard.snapshot.index.operation_classes));
  await measure("recovery_pair_preflight", () => externalEventJournalConsistent(deps, runtime, plan));
  await measure("before_byte_source_pair_guard_lease_READONLY", () => externalEventPlanStillOwned(deps, binding, runtime, plan, () => new Date(),
    () => guardStillApproved(deps, runtime, guard, new Date())));
  assert.deepEqual(await store.planWrites.list(planId), before);
  assert.ok(http.every((h) => h.read_id !== undefined), "every HTTP dispatch belongs to the one active readonly client");
  const maxRequests60s = Math.max(0, ...http.map((h) => http.filter((x) => x.dispatch_ms >= h.dispatch_ms && x.dispatch_ms < h.dispatch_ms + 60000).length));
  if (burst === 10) assert.ok(maxRequests60s <= 178, "canary envelope exceeded");
  console.log(JSON.stringify({ task: "W4.7", mode: "SEPARATE_READONLY_PHASE_PROFILE_NOT_COMMIT", plan_id: planId, stages,
    reads: reads.map(({ start: _localTime, ...r }) => r), http, journal_unchanged: true,
    writer_present: "notionWriter" in deps, send_calls: 0, rate_per_second: 2.8, burst,
    shared_429_cooldown: burst === 10, active_dispatched_clients: 1, max_requests_rolling_60s: maxRequests60s }, null, 2));
} finally { globalThis.fetch = fetchOriginal; await backend.close(); }
