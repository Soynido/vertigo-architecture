/**
 * PT-ARCH-004 — the harness writes to Notion through exactly one confined path (PV-WRITE-001 / W1.11, annex A.8).
 * It replaces PT-ARCH-001 (no write client) and PT-ARCH-003 (the renderer performs no write), whose invariants
 * PDEC-018 supersedes: the server now writes, and what must be proved is that it can write NOTHING ELSE.
 *
 *   a. the HTTP allowlist is the reads plus POST /pages (data-source parent) and PATCH /pages/{id} (properties);
 *   b. api.notion.com is spoken to from src/notion/client.ts and nowhere else;
 *   c. .createPage( / .updatePage( are called from src/transactions/write.ts and nowhere else;
 *   d. one token, one HttpNotionClient construction site (plus the read-only facade), no raw fetch elsewhere;
 *   e. the executor takes a plan id, never a plan;
 *   f. every write recorded is exactly one WriteInstruction of a stored plan, in order, under lease and claim;
 *   g. a forged stored plan is HOLD_CROSS_RUNTIME with zero writes;
 *   h. os_resume, os_handoff, os_control_status and os_prepare write nothing;
 *   i. no value of a redactValues resource reaches an event, a hold's evidence or the log.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../../src/config/index.ts";
import { assertReadOnly, assertWriteAllowed, HttpNotionClient, NotionWriteRefused } from "../../src/notion/client.ts";
import { propText, type Page } from "../../src/notion/shapes.ts";
import type { Plan } from "../../src/plans/store.ts";
import { dispatch } from "../../src/tools/handlers.ts";
import { executeTransaction, type TransactionDeps } from "../../src/transactions/execute.ts";
import { executorSession, prepare, salesV1World } from "../support/transact.ts";
import { OWNER } from "../unit/binding-fixtures.ts";
import { synthetic } from "../unit/meta-fixtures.ts";
import { buildResumeWorld, R } from "../unit/resume-fixtures.ts";
import { HARNESS_ROOT, listFiles, scan } from "./scan.ts";

const NOW = new Date("2030-01-03T00:30:00.000Z");
const ctx = { principal_id: OWNER.principal_id, now: NOW };
const PAGE = "0123456789abcdef0123456789abcdef";
const gateIntent = { action_class: "COMMIT", summary: "set the next frame question", mutations: [{ logical_resource_key: "META:GATES", operation: "UPDATE" as const, record_selector: { natural_key: "T1" }, desired_changes: { "Next Question": "What is the offer?" } }] };
const files = () => listFiles(join(HARNESS_ROOT, "src"), [".ts"]);
const filesOf = (hits: readonly { file: string }[]) => [...new Set(hits.map((h) => h.file))].sort();

async function metaSession() {
  const w = buildResumeWorld();
  const s = await executorSession(w, { principal_id: OWNER.principal_id, lane: "META", now: NOW, declare: [R.metaRunsDs, R.metaLedgerDs] });
  const p = await prepare(w, s.h, gateIntent, ctx);
  assert.equal(p.envelope.code, "PLAN_PREPARED", JSON.stringify(p.envelope));
  return { w, s, plan: p.plan as Plan };
}
const instructions = (plan: Plan) => [...plan.stage1_writes, ...plan.finalization_writes, plan.state_last_write];

test("PT-ARCH-004/a: the allowlist is the reads plus two exact writes, with guarded bodies", () => {
  for (const [m, p] of [["POST", "/pages"], ["PATCH", `/pages/${PAGE}`]] as const) assert.throws(() => assertReadOnly(m, p), NotionWriteRefused);
  assert.doesNotThrow(() => assertWriteAllowed("POST", "/pages", { parent: { type: "data_source_id", data_source_id: PAGE }, properties: {} }));
  assert.doesNotThrow(() => assertWriteAllowed("PATCH", `/pages/${PAGE}`, { properties: {} }));
  const refused: Array<[string, string, unknown]> = [
    ["DELETE", `/pages/${PAGE}`, {}], ["DELETE", `/blocks/${PAGE}`, {}], ["PATCH", `/blocks/${PAGE}`, { archived: true }], ["PATCH", `/blocks/${PAGE}/children`, { children: [] }],
    ["POST", "/databases", { parent: {}, properties: {} }], ["PATCH", `/databases/${PAGE}`, { properties: {} }], ["PATCH", `/data_sources/${PAGE}`, { properties: {} }], ["POST", "/comments", { parent: {}, rich_text: [] }],
    ["PATCH", `/pages/${PAGE}`, { properties: {}, archived: true }], ["PATCH", `/pages/${PAGE}`, { properties: {}, in_trash: true }], ["PATCH", `/pages/${PAGE}`, { properties: {}, icon: {} }], ["PATCH", `/pages/${PAGE}`, { properties: {}, cover: {} }],
    ["POST", "/pages", { parent: { type: "page_id", page_id: PAGE }, properties: {} }], ["POST", "/pages", { parent: { type: "data_source_id", data_source_id: PAGE }, properties: {}, children: [] }],
  ];
  for (const [m, p, body] of refused) assert.throws(() => assertWriteAllowed(m, p, body), NotionWriteRefused, `${m} ${p} ${JSON.stringify(body)}`);
  const methods = Object.getOwnPropertyNames(HttpNotionClient.prototype).filter((m) => m !== "constructor").sort();
  assert.deepEqual(methods, ["createPage", "queryDataSource", "retrieveBlockChildren", "retrieveDataSource", "retrieveDatabase", "retrievePage", "updatePage"]);
});

test("PT-ARCH-004/b: api.notion.com is reached from the strict client only", async () => {
  assert.deepEqual(filesOf(await scan(await files(), [/api\.notion\.com/])), ["packages/harness/src/notion/client.ts"]);
});

test("PT-ARCH-004/c: createPage / updatePage are called from the transactional writer only", async () => {
  assert.deepEqual(filesOf(await scan(await files(), [/\.(createPage|updatePage)\(/])), ["packages/harness/src/transactions/write.ts"]);
  // No generic mutation path either: no SDK verbs, no other HTTP verb string, no raw fetch outside the wiring.
  assert.deepEqual(await scan(await files(), [/\bpages\.(create|update|archive)\b/, /\bblocks\.(children\.append|update|delete)\b/, /\bdatabases\.(create|update)\b/, /\bdataSources\.(create|update)\b/, /["'`](DELETE|PUT)["'`]/, /notion-update-page|notion-create-pages|notion-create-database/]), []);
  assert.deepEqual(filesOf(await scan(await files(), [/["'`]PATCH["'`]/])), ["packages/harness/src/notion/client.ts"]);
  assert.deepEqual(filesOf(await scan(await files(), [/\bfetch\s*\(/])), ["packages/harness/src/index.ts"]);
});

test("PT-ARCH-004/d: one token, one client construction site (plus the read-only facade)", async () => {
  assert.deepEqual(filesOf(await scan(await files(), [/new HttpNotionClient\(/])), ["packages/harness/src/index.ts", "packages/harness/src/notion/readClient.ts"]);
  assert.deepEqual(filesOf(await scan(await files(), [/notionReadToken/])), ["packages/harness/src/config/index.ts", "packages/harness/src/index.ts"]);
  const cfg = await readFile(join(HARNESS_ROOT, "src/config/index.ts"), "utf8");
  // W3.5a: canonical NOTION_TOKEN plus the one-release legacy alias NOTION_READ_TOKEN, and nothing else.
  assert.deepEqual((cfg.match(/env\["NOTION_[A-Z_]*TOKEN"\]/g) ?? []).sort(), ['env["NOTION_READ_TOKEN"]', 'env["NOTION_TOKEN"]'], "only NOTION_TOKEN and its legacy alias NOTION_READ_TOKEN are read from the environment");
  // Both collapse into one resolved token binding, which is the only token the client wiring sees.
  assert.equal((cfg.match(/const notionReadToken = /g) ?? []).length, 1, "the two env names resolve to exactly one token");
  // Conflicting values fail closed: the loader never silently picks which credential is the Notion authority.
  assert.throws(() => loadConfig({ HARNESS_ENV: "live", NOTION_TOKEN: "secret-a", NOTION_READ_TOKEN: "secret-b" }), /NOTION_TOKEN and NOTION_READ_TOKEN are both set and differ/);
  const pkg = JSON.parse(await readFile(join(HARNESS_ROOT, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  assert.deepEqual(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => /notion/i.test(d)), [], "no Notion SDK: the wire is the strict client alone");
});

test("PT-ARCH-004/e: the executor takes a plan id and re-reads the stored plan; an unknown id writes nothing", async () => {
  const src = await readFile(join(HARNESS_ROOT, "src/transactions/execute.ts"), "utf8");
  const ctxBlock = src.slice(src.indexOf("export interface ExecuteContext"), src.indexOf("}", src.indexOf("export interface ExecuteContext")));
  assert.match(ctxBlock, /readonly plan_id: string;/);
  assert.doesNotMatch(ctxBlock, /readonly plan\b/);
  const { s } = await metaSession();
  const out = await executeTransaction(s.deps, { ...s.exec({ plan_id: "no-such-plan", state_last_write: { target_ref: PAGE } } as unknown as Plan) });
  assert.deepEqual([out.kind, (out as { code?: string }).code, s.client.writes.length], ["HELD", "ERROR_PLAN_NOT_FOUND", 0]);
});

test("PT-ARCH-004/f: every recorded write is one instruction of the stored plan, in order, under this plan's lease and claim", async () => {
  const { s, plan } = await metaSession();
  const key = { project: plan.project, lane: plan.lane, runtime_generation: plan.runtime_generation };
  const checks: Promise<[string | undefined, boolean]>[] = [];
  s.client.onWrite = () => {
    const now = new Date(s.clock.t);
    checks.push(Promise.all([s.deps.store.leases.current(key, now).then((l) => l?.plan_id), s.deps.store.claims.claim(plan.plan_id, "intruder", now, new Date(now.getTime() + 60_000))]));
  };
  const out = await executeTransaction(s.deps, s.exec(plan));
  assert.equal(out.kind, "PERSISTED", JSON.stringify(out));
  const expected = instructions(plan).map((w) => w.symbol);
  assert.deepEqual(s.client.writes.map((w) => w.ctx.symbol), expected, "the writes are the plan's instructions, in order");
  assert.deepEqual(s.client.writes.map((w) => w.ctx.plan_id), expected.map(() => plan.plan_id));
  const journal = await s.deps.store.planWrites.list(plan.plan_id);
  assert.deepEqual(journal.map((r) => [r.symbol, r.status]), expected.map((sym) => [sym, "DONE"]));
  for (const [holder, intruderWon] of await Promise.all(checks)) { assert.equal(holder, plan.plan_id, "the runtime lease is this plan's during every write"); assert.equal(intruderWon, false, "the claim is held during every write"); }
});

test("PT-ARCH-004/g: a stored plan forged to write outside the runtime is HOLD_CROSS_RUNTIME with zero writes", async () => {
  const { s, plan } = await metaSession();
  const foreignDs = synthetic("arch-004-foreign-ds");
  const forged: Plan = { ...plan, stage1_writes: plan.stage1_writes.map((w) => (w.purpose === "OPEN_RUN" ? { ...w, target_ref: foreignDs } : w)) };
  await s.deps.store.plans.insert(forged);
  const out = await executeTransaction(s.deps, s.exec(plan));
  assert.deepEqual([out.kind, (out as { code?: string }).code, s.client.writes.length], ["HELD", "HOLD_CROSS_RUNTIME", 0], JSON.stringify(out));
});

test("PT-ARCH-004/h: os_resume, os_handoff, os_control_status and os_prepare write nothing, even with a writer in hand", async () => {
  const w = buildResumeWorld();
  const s = await executorSession(w, { principal_id: OWNER.principal_id, lane: "META", now: NOW });
  const before = JSON.stringify([...w.map.entries()].sort(([a], [b]) => a.localeCompare(b)));
  const deps: TransactionDeps = s.deps;
  const codes: string[] = [];
  for (const [name, input] of [["os_resume", { binding_handle: s.h }], ["os_handoff", { binding_handle: s.h }], ["os_control_status", { binding_handle: s.h }], ["os_prepare", { binding_handle: s.h, intent: gateIntent }]] as const) {
    codes.push((await dispatch(name, input, ctx, deps)).code);
  }
  assert.deepEqual(codes, ["RESUMED", "HANDOFF_READY", "CONTROL_STATUS", "PLAN_PREPARED"]);
  assert.equal(s.client.writes.length, 0, "no tool but the future os_commit ever reaches the writer");
  assert.equal(JSON.stringify([...w.map.entries()].sort(([a], [b]) => a.localeCompare(b))), before, "the Notion fixture is byte-identical");
});

test("PT-ARCH-004/i: a redactValues resource never leaks a value into an event, a hold's evidence or the log", async () => {
  const { w, accounts } = salesV1World();
  const s = await executorSession(w, { principal_id: OWNER.principal_id, lane: "SALES", now: NOW });
  const SECRET = "Zorglub Confidential Holdings";
  const intent = { action_class: "COMMIT", summary: "add one company", mutations: [{ logical_resource_key: "SALES:ACCOUNTS", operation: "CREATE" as const, record_selector: { natural_key: "https://zorglub.example/" }, desired_changes: { Company: SECRET, Qualification: "UNASSESSED", Lifecycle: "RESEARCH", "Do Not Contact": false } }] };
  const p = await prepare(w, s.h, intent, ctx);
  assert.equal(p.envelope.code, "PLAN_PREPARED", JSON.stringify(p.envelope));
  const plan = p.plan as Plan;
  const target = plan.stage1_writes.find((x) => x.purpose === "WRITE_TARGET")!;
  s.client.fault({ symbol: target.symbol }, "MUTATE", { mutate: (props) => ({ ...props, Company: { title: [{ type: "text", text: { content: "Someone Else SAS" } }] } }) });
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  let out: Awaited<ReturnType<typeof executeTransaction>>;
  try { out = await executeTransaction(s.deps, s.exec(plan)); } finally { console.error = original; }
  assert.deepEqual([out.kind, (out as { phase?: string }).phase, (out as { code?: string }).code], ["HELD", "TARGET", "HOLD_TARGET_WRONG_VALUE"], JSON.stringify(out));
  const events = JSON.stringify(await s.deps.store.events.list({}));
  const records: Array<[string, string]> = [["evidence", JSON.stringify((out as { evidence: readonly string[] }).evidence)], ["events", events], ["log", logged.join("\n")]];
  for (const [where, text] of records) assert.ok(!text.includes(SECRET) && !text.includes("Someone Else"), `${where} carries a business value`);
  // The value did reach Notion — the fixture holds it — so the check above is about the harness's own records.
  assert.ok(((w.map.get(`query:${accounts}`) as { results: Page[] }).results).some((r) => propText(r, "Company") === "Someone Else SAS"));
});
