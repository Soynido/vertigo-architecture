/** W5.1 bounded structural diagnosis only. Never acceptance, repair, proof or migration. */
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { HttpNotionClient } from "./src/notion/client.ts";
import { IDENTITY, assertAssignment, assertCredentialFile, assertReadRequest, parseW51Credential } from "./probe-w51.mjs";

const repo = new URL("../../", import.meta.url);
const TARGETS = [
  { key: "DAILY_ACTIVE_POLICIES", parent: "01 — CONSTITUTION & POLICIES", table: "Active Policies", required: { "Policy Key": ["rich_text"], State: ["select", "status"], "Policy Text": ["rich_text"], "Effective At": ["date"], "Approved Change": ["url"] } },
  { key: "DAILY_RUNTIME_CONSTRAINTS", parent: "02 — SETUP & BUSINESS CONFIG", table: "Runtime Configuration", required: { Config: ["title", "rich_text", "select", "status"], Type: ["select", "status"], State: ["select", "status"], Value: ["title", "rich_text", "select", "status"] } },
  { key: "DAILY_UNPROCESSED_INTAKE", parent: "04 — DATA & EVIDENCE", table: "Intake", required: { Status: ["select", "status"], "Received At": ["date", "created_time"], "Intake ID": ["unique_id"] } },
  { key: "DAILY_PRODUCTION_HEALTH", parent: "03 — CONTROL PLANE", table: "OS State", required: { Name: ["title", "rich_text"], "Production Health": ["select", "status"], "Production Health Run Ref": ["rich_text"], "Last Daily Run": ["date"] } },
];

export function schemaDefects(properties, required) {
  return Object.entries(required).filter(([name, types]) => !types.includes(properties?.[name]?.type))
    .map(([name, expected]) => ({ column: name, actual: properties?.[name]?.type ?? "ABSENT", expected }));
}

export async function diagnose(args = process.argv.slice(2)) {
  assert.ok(args.length === 0 || (args.length === 1 && ["--check", "--intake"].includes(args[0])));
  assertAssignment(JSON.parse(await readFile(new URL("config/w51.principals.json", repo), "utf8")),
    JSON.parse(await readFile(new URL("config/w51.sales-runtimes.json", repo), "utf8")));
  if (args[0] === "--check") return { result: "OFFLINE_ONLY", network_calls: 0 };
  const configHashes = async () => Object.fromEntries(await Promise.all(["config/principals.local.json", "config/sales-runtimes.local.json"].map(async (p) => [p, createHash("sha256").update(await readFile(new URL(p, repo))).digest("hex")])));
  const before = await configHashes();
  const fd = await open(new URL(".env.w51-readonly", repo), constants.O_RDONLY | constants.O_NOFOLLOW);
  let token;
  try { assertCredentialFile(await fd.stat()); token = parseW51Credential(await fd.readFile("utf8")); } finally { await fd.close(); }
  const requests = []; let stopped = false;
  const client = new HttpNotionClient(token, async (url, init) => {
    assert.ok(!stopped); assertReadRequest(url, init);
    assert.ok(requests.length < 24, "bounded structural diagnosis exhausted; do not scan further");
    const sample = { method: init.method, endpoint: new URL(url).pathname }; requests.push(sample);
    try {
      const response = await fetch(url, { ...init, redirect: "error" }); sample.status = response.status;
      if (response.status >= 400) { stopped = true; throw Error("STOP at first read denial"); }
      return response;
    } catch (error) { stopped = true; throw error; }
  }, { ratePerSecond: 2.8, burst: 1, shared429Cooldown: true, abortReadsOn429: true, max429Retries: 0, requestTimeoutMs: 30000 });
  const children = async (id) => {
    const page = await client.retrieveBlockChildren(id);
    assert.equal(page.has_more, false, "structural page incomplete: no broad scan");
    return page.results;
  };
  const out = { task: "W5.1", result: "DIAGNOSIS_ONLY_NOT_GATE_PASS", root: IDENTITY.root, findings: [], requests, before_live_config_hashes: before, notion_writes: 0, native_calls: 0 };
  try {
    await client.retrievePage(IDENTITY.root);
    const roots = await children(IDENTITY.root), memo = new Map();
    for (const target of TARGETS.filter((t) => args[0] !== "--intake" || t.key === "DAILY_UNPROCESSED_INTAKE")) {
      const parents = roots.filter((b) => b.type === "child_page" && b.child_page?.title === target.parent);
      const finding = { key: target.key, location: `${target.parent} / ${target.table}` }; out.findings.push(finding);
      if (parents.length !== 1) { finding.reason = `PARENT_COUNT_${parents.length}`; continue; }
      const parent = parents[0].id;
      if (!memo.has(parent)) memo.set(parent, await children(parent));
      const tables = memo.get(parent).filter((b) => b.type === "child_database" && b.child_database?.title === target.table);
      if (tables.length !== 1) { finding.reason = `TABLE_COUNT_${tables.length}`; continue; }
      const db = await client.retrieveDatabase(tables[0].id);
      if (db.data_sources?.length !== 1) { finding.reason = "DATA_SOURCE_AMBIGUOUS"; continue; }
      const ds = db.data_sources[0].id, schema = await client.retrieveDataSource(ds);
      finding.data_source = ds; finding.schema_defects = schemaDefects(schema.properties, target.required);
      finding.schema_types = Object.fromEntries(Object.keys(target.required).map((name) => [name, schema.properties?.[name]?.type ?? "ABSENT"]));
      finding.reason = finding.schema_defects.length ? "SCHEMA_INCOMPATIBLE" : "SCHEMA_OK_CAUSE_NEEDS_ROW_DIAGNOSIS";
      if (target.key === "DAILY_RUNTIME_CONSTRAINTS" && finding.schema_defects.length === 0) {
        const p = schema.properties;
        const filter = { and: [{ property: "Config", [p.Config.type]: { equals: "TIMEZONE" } }, { property: "Type", [p.Type.type]: { equals: "LOCAL_CONSTRAINT" } }, { property: "State", [p.State.type]: { equals: "CONFIRMED" } }] };
        const rows = await client.queryDataSource(ds, filter, undefined, { page_size: 2 });
        finding.timezone = { rows: rows.results.length, has_more: rows.has_more, unique_confirmed: rows.results.length === 1 && rows.has_more === false };
      }
    }
  } catch { out.result = "STOP_DIAGNOSIS_NO_RETRY"; }
  out.after_live_config_hashes = await configHashes(); assert.deepEqual(out.after_live_config_hashes, before);
  out.observed_at = new Date().toISOString(); return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = await diagnose(); console.log(JSON.stringify(out, null, 2));
  if (out.result === "STOP_DIAGNOSIS_NO_RETRY") process.exitCode = 1;
}
