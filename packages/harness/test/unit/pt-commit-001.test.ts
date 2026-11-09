/**
 * PT-COMMIT-001 — os_commit (PV-WRITE-001 / W3.1, PDEC-018 CANDIDATE — NOT ADOPTED), with the Production Guard of the
 * Sales 0.5.11 candidate (W3.1R/W3.1S). The 0.5.11 adapter is injected by the fixture only.
 *
 * base — a direct MCP CallTool (announced by ListTools since W3.3): PERSISTED with the derived movement in the same call
 *        (step_moved, next_gate), IN_PROGRESS on budget, INTERRUPTED then ledger recovery, DEFERRED under 18 s.
 * /b   — E3: no approval, the seven re-read statuses, absent/truncated/ambiguous/invalid sources, T-0, digest drift,
 *        zero write at preflight, MissingFact without business values, drift after the first write.
 * /c   — E4: P0 TRIGGERED/NOT_TRIGGERED/UNVERIFIABLE, index/classes, local Task Type, label spoofing, D+1/D+2
 *        protection before/after, guard sources refused, reconciliation as-is, ledger repair under a P0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { hashHandle } from "../../src/binding/handle.ts";
import { dispatch } from "../../src/tools/handlers.ts";
import { approveGuard } from "../../src/cli/guard-approve.ts";
import { createServer } from "../../src/index.ts";
import { propText, type Page } from "../../src/notion/shapes.ts";
import type { CommitOutcome } from "../../src/transactions/commit.ts";
import { SALES_CONTROL_PLANE_0511_CANDIDATE } from "../../src/versions/adapters/controlPlane.ts";
import { OWNER } from "./binding-fixtures.ts";
import { synthetic } from "./meta-fixtures.ts";
import { R } from "./resume-fixtures.ts";
import {
  B0_KEY, CLASSES, codeBlock, configRow, constraint, DAY, eq, G, guardWorld, index, lit, NOW, p0, putRows, ref, rowsOf, rule,
  SECRET_RULE, SECRET_VALUE, setIndex, task, taskIntent, timezone, TYPE_NAMES, b0Intent, type ClassEntry, type GuardWorld,
} from "../support/guard-fixtures.ts";

type Out = CommitOutcome & { say: string };
const held = (o: Out) => [o.kind, o.kind === "HELD" ? o.code : "—"];
const cls = (...c: unknown[]) => c as ClassEntry[];
const b0Gate = () => SALES_CONTROL_PLANE_0511_CANDIDATE.cursorTransitions?.find((t) => t.fromGate === "B0_DISCOVERY")?.set["Current Gate"];

/** Nothing durable happened: no Notion write, no plan, no lease, no Run or ledger row. */
async function assertNothingWritten(g: GuardWorld, runs: number, ledger: number): Promise<void> {
  assert.equal(g.client.writes.length, 0, "no Notion byte");
  assert.equal((await g.deps.store.plans.listByRuntime("VERTIGO", "SALES", (await firstBinding(g)).runtime_generation)).length, 0, "no plan");
  const b = await firstBinding(g);
  assert.equal(await g.deps.store.leases.current({ project: b.project, lane: b.lane, runtime_generation: b.runtime_generation }, NOW), undefined, "no lease");
  assert.equal(rowsOf(g.map, R.salesRunsDs).length, runs, "no Run");
  assert.equal(rowsOf(g.map, R.salesLedgerDs).length, ledger, "no ledger row");
}
/** The binding behind the handle `bound` returned for this world. */
async function firstBinding(g: GuardWorld) {
  return (await g.deps.store.bindings.findByHandleHash(hashHandle(lastHandle.get(g) as string)))!;
}
const lastHandle = new WeakMap<GuardWorld, string>();
async function bound(g: GuardWorld): Promise<string> {
  const h = await g.bind();
  lastHandle.set(g, h);
  return h;
}

/** No business text in the outcome, the evidence, the events or the log lines of the call. */
async function assertNoBusinessValue(g: GuardWorld, out: Out, logged: readonly string[]): Promise<void> {
  const events = JSON.stringify(await g.deps.store.events.list({}));
  for (const [where, textValue] of [["outcome", JSON.stringify(out)], ["events", events], ["log", logged.join("\n")]] as const) {
    for (const secret of [SECRET_RULE, SECRET_VALUE]) assert.ok(!textValue.includes(secret), `${where} carries a business value`);
  }
  if (out.kind === "HELD") for (const m of out.missing) assert.ok(m.label.length > 0 && !/[0-9a-f]{32}/.test(m.label) && !/HOLD_/.test(m.label), "a MissingFact is a human label");
  assert.ok(!/HOLD_|ERROR_|[0-9a-f]{32}/.test(out.say), "the sentence carries no code and no id");
}
async function quietly<T>(f: () => Promise<T>): Promise<{ value: T; logged: string[] }> {
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try { return { value: await f(), logged }; } finally { console.error = original; }
}

/* ───────────────────────────── base ───────────────────────────── */

test("PT-COMMIT-001/a: a direct CallTool os_commit, announced by ListTools since W3.3, persists the answer and moves the step in the same call", async () => {
  const g = guardWorld();
  const h = await bound(g);
  await g.approve();
  const server = createServer(g.deps, OWNER.principal_id);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(ct);
  try {
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ["os_bind", "os_resume", "os_commit", "os_handoff", "os_control_status"], "W3.3 announces os_commit among exactly five tools");
    const { value: r } = await quietly(() => client.callTool({ name: "os_commit", arguments: { binding_handle: h, ...b0Intent() } }));
    const out = JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as Out;
    assert.equal(r.isError, false);
    assert.equal(out.kind, "PERSISTED", JSON.stringify(out));
    if (out.kind !== "PERSISTED") return;
    assert.deepEqual([out.origin, out.repeated, out.step_moved, out.derived_move, out.next_gate], ["INTENT", false, true, "PERSISTED", b0Gate()]);
    assert.deepEqual(out.targets.map((t) => [t.logical_resource_key, t.operation]), [["SALES:BUSINESS_CONFIG", "CREATE"]]);
    assert.ok(!JSON.stringify(out.targets).includes("rendez-vous"), "targets are ids, never values");
    assert.equal(rowsOf(g.map, G.configDs).filter((p) => propText(p, "Config Item") === B0_KEY).length, 1, "one answer row");
    assert.equal(propText(rowsOf(g.map, R.salesStateDs)[0] as Page, "Current Gate"), b0Gate(), "the durable cursor moved");
    assert.ok(out.say.length > 0 && !/HOLD_|[0-9a-f]{32}/.test(out.say));
  } finally { await client.close(); await server.close(); }
});

test("PT-COMMIT-001/a2: IN_PROGRESS when the budget cannot fit a write (nothing sent), then the same intent persists once", async () => {
  const g = guardWorld();
  const h = await bound(g);
  await g.approve();
  const first = await g.commit(h, b0Intent(), { commitBudgetMs: 3_000 });
  assert.deepEqual([first.kind, (first as { reason?: string }).reason, (first as { writes_done?: number }).writes_done], ["IN_PROGRESS", "BUDGET", 0], JSON.stringify(first));
  assert.equal(g.client.writes.length, 0);
  const second = await g.commit(h, b0Intent());
  assert.equal(second.kind, "PERSISTED", JSON.stringify(second));
  assert.equal(rowsOf(g.map, G.configDs).filter((p) => propText(p, "Config Item") === B0_KEY).length, 1);
});

test("W7.1: a new chat reports the unstarted binding-scoped plan, never completion from an unrelated receipt", async () => {
  const g = guardWorld();
  const h = await bound(g);
  await g.approve();
  const first = await g.commit(h, b0Intent(), { commitBudgetMs: 3_000 });
  assert.equal(first.kind, "IN_PROGRESS");
  if (first.kind !== "IN_PROGRESS") return;
  assert.equal(g.client.writes.length, 0);
  const fresh = await g.bind();
  assert.notEqual(fresh, h);
  const resumed = await dispatch("os_resume", { binding_handle: fresh },
    { principal_id: OWNER.principal_id, now: new Date(g.clock.t), candidate_resume: true }, g.deps);
  const p = (await g.deps.store.plans.get(first.plan_id))!;
  assert.equal(p.plan_state, "AWAITING_STAGE1_WRITES");
  assert.equal(resumed.status, "OK");
  if (resumed.status !== "OK") return;
  const result = resumed.result as { durable_hold?: { plan_id: string; code: string }; ledger_completed?: unknown };
  assert.deepEqual([result.durable_hold?.plan_id, result.durable_hold?.code], [first.plan_id, "HOLD_CROSS_RUNTIME"]);
  assert.equal(result.ledger_completed, undefined, "no old receipt can certify this pending plan");
  assert.equal(g.client.writes.length, 0);
  const plans = await g.deps.store.plans.listByRuntime("VERTIGO", "SALES", (await firstBinding(g)).runtime_generation);
  assert.equal(plans.length, 1, "continue the original plan, never fabricate a recovery child");
  assert.equal(rowsOf(g.map, G.configDs).filter(p => propText(p, "Config Item") === B0_KEY).length, 0);
  assert.equal(propText(rowsOf(g.map, R.salesStateDs)[0] as Page, "Current Gate"), "B0_DISCOVERY", "resume completion does not advance the business cursor");
  const continued = await g.commit(h, b0Intent());
  assert.equal(continued.kind, "PERSISTED");
  assert.equal((await g.deps.store.plans.get(first.plan_id))?.plan_state, "FINAL_VERIFIED");
  assert.equal(rowsOf(g.map, G.configDs).filter(p => propText(p, "Config Item") === B0_KEY).length, 1);
});

test("PT-COMMIT-001/a3: INTERRUPTED on a lost answer; the next call recovers from the ledger without duplicating anything", async () => {
  const g = guardWorld();
  const h = await bound(g);
  await g.approve();
  g.client.fault({ symbol: "OPEN_RUN" }, "APPLY_THEN_FAIL");
  const first = await g.commit(h, b0Intent());
  assert.deepEqual([first.kind, (first as { failed_symbol?: string }).failed_symbol, (first as { notion_status?: unknown }).notion_status], ["INTERRUPTED", "OPEN_RUN", 502], JSON.stringify(first));
  g.clock.t += 60_000;
  const second = await g.commit(h, b0Intent());
  assert.equal(second.kind, "PERSISTED", JSON.stringify(second));
  assert.equal(rowsOf(g.map, G.configDs).filter((p) => propText(p, "Config Item") === B0_KEY).length, 1, "one answer row");
  const plan = (first as { plan_id: string }).plan_id;
  assert.equal(rowsOf(g.map, R.salesRunsDs).filter((p) => propText(p, "Harness Plan ID") === plan).length, 1, "one Run for the interrupted plan");
  assert.equal((await g.deps.store.plans.get(plan))?.plan_state, "FINAL_VERIFIED");
});

test("PT-COMMIT-001/a4: under 18 s left the derived movement is DEFERRED; the next call without intent derives and persists it", async () => {
  const g = guardWorld();
  const h = await bound(g);
  await g.approve();
  const first = await g.commit(h, b0Intent(), { commitBudgetMs: 17_000 });
  assert.deepEqual([first.kind, (first as { step_moved?: boolean }).step_moved, (first as { derived_move?: string }).derived_move], ["PERSISTED", false, "DEFERRED"], JSON.stringify(first));
  assert.equal(propText(rowsOf(g.map, R.salesStateDs)[0] as Page, "Current Gate"), "B0_DISCOVERY");
  const move = await g.commit(h, {});
  assert.deepEqual([move.kind, (move as { origin?: string }).origin, (move as { step_moved?: boolean }).step_moved, (move as { next_gate?: string }).next_gate], ["PERSISTED", "DERIVED_MOVE", true, b0Gate()], JSON.stringify(move));
});

/* ───────────────────────────── /b — E3 ───────────────────────────── */

test("PT-COMMIT-001/b1: no approval ⇒ HELD UNVERIFIABLE at preflight: zero plan, Run, lease, ledger, Notion byte; human MissingFact", async () => {
  const g = guardWorld({ rules: [rule("r7", 7)], doc: index([p0(7, eq(ref("PT:MODE"), lit("LITIGE")))]), configs: [configRow("mode", "PT:MODE", { value: "NORMAL" })] });
  const h = await bound(g);
  const runs = rowsOf(g.map, R.salesRunsDs).length; const ledger = rowsOf(g.map, R.salesLedgerDs).length;
  const { value: out, logged } = await quietly(() => g.commit(h, b0Intent()));
  assert.deepEqual(held(out), ["HELD", "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE"], JSON.stringify(out));
  assert.deepEqual([(out as { phase?: string }).phase, (out as { wrote_anything?: boolean }).wrote_anything], ["PREPARE", false]);
  assert.equal((out as unknown as { missing: Array<{ label: string }> }).missing[0]?.label, "Approbation opérateur de la garde de production");
  await assertNothingWritten(g, runs, ledger);
  await assertNoBusinessValue(g, out, logged);
  assert.deepEqual((await g.deps.store.events.list({})).filter((e) => e.event_type === "COMMIT_GUARD_HOLD").map((e) => e.result), ["HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE"]);
});

const taskClasses = () => cls(CLASSES.taskProduction, CLASSES.b0Answer, CLASSES.cursor());
const pointer = (key: string) => ["SALES:BUSINESS_CONFIG", key, "Value"] as const;

test("PT-COMMIT-001/b2: the seven re-read statuses — only MATCH (pointer) and NO_POINTER (local) let a new production through", async () => {
  const V = "VALEUR-APPROUVEE";
  const cases: Array<[string, { constraints: Page[]; configs: Page[]; unreadable?: boolean }, boolean]> = [
    ["MATCH", { constraints: [timezone(), constraint("p", 2, { type: "PRODUCTION_CONTRACT_POINTER", value: V, pointer: pointer("PT:CAP") })], configs: [configRow("cap", "PT:CAP", { value: V })] }, true],
    ["NO_POINTER", { constraints: [timezone(), constraint("l", 2, { value: "locale" })], configs: [] }, true],
    ["DRIFT", { constraints: [timezone(), constraint("p", 2, { type: "PRODUCTION_CONTRACT_POINTER", value: V, pointer: pointer("PT:CAP") })], configs: [configRow("cap", "PT:CAP", { value: "AUTRE" })] }, false],
    ["MISSING", { constraints: [timezone(), constraint("p", 2, { type: "PRODUCTION_CONTRACT_POINTER", value: V, pointer: pointer("PT:CAP") })], configs: [] }, false],
    ["AMBIGUOUS", { constraints: [timezone(), constraint("p", 2, { type: "PRODUCTION_CONTRACT_POINTER", value: V, pointer: pointer("PT:CAP") })], configs: [configRow("cap", "PT:CAP", { value: V }), configRow("cap2", "PT:CAP", { value: V })] }, false],
    ["UNREADABLE", { constraints: [timezone(), constraint("p", 2, { type: "PRODUCTION_CONTRACT_POINTER", value: V, pointer: pointer("PT:CAP") })], configs: [], unreadable: true }, false],
    ["INVALID", { constraints: [timezone(), constraint("p", 2, { type: "PRODUCTION_CONTRACT_POINTER", value: V, pointer: ["SALES:BUSINESS_CONFIG", "", ""] })], configs: [] }, false],
    ["NO_POINTER on a production pointer", { constraints: [timezone(), constraint("p", 2, { type: "PRODUCTION_CONTRACT_POINTER", value: V })], configs: [] }, false],
  ];
  for (const [name, world, passes] of cases) {
    const g = guardWorld({ doc: index([], taskClasses()), constraints: world.constraints, configs: world.configs });
    if (world.unreadable) g.intercept(G.configDs, () => { throw new Error("unreadable"); });
    const h = await bound(g);
    await g.approve();
    const out = await g.commit(h, taskIntent("CREATE", "task-1", { Task: "Relancer", Type: TYPE_NAMES.prospection, Status: "READY", "Due Date": DAY.d4 }));
    if (passes) assert.equal(out.kind, "PERSISTED", `${name}: ${JSON.stringify(out)}`);
    else {
      assert.deepEqual(held(out), ["HELD", "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE"], `${name}: ${JSON.stringify(out)}`);
      assert.equal(g.client.writes.length, 0, `${name}: zero write`);
    }
  }
});

test("PT-COMMIT-001/b3: any change of a guard source after approval — rule edited, added, removed, index class added — is a digest drift", async () => {
  const base = { rules: [rule("r7", 7)], doc: index([p0(7, eq(ref("PT:MODE"), lit("LITIGE")))], taskClasses()), configs: [configRow("mode", "PT:MODE", { value: "NORMAL" })] };
  const edits: Array<[string, (g: GuardWorld) => void]> = [
    ["rule text edited", (g) => putRows(g.map, G.rulesDs, [rule("r7", 7, { text: `${SECRET_RULE} (révisée)` })])],
    ["P0 rule added", (g) => putRows(g.map, G.rulesDs, [rule("r7", 7), rule("r8", 8)])],
    ["P0 rule removed", (g) => putRows(g.map, G.rulesDs, [])],
    ["index class added", (g) => setIndex(g.map, index([p0(7, eq(ref("PT:MODE"), lit("LITIGE")))], [...taskClasses(), CLASSES.taskReconcile as unknown as ClassEntry]))],
    ["static source value edited", (g) => putRows(g.map, G.configDs, [configRow("mode", "PT:MODE", { value: "NORMAL " })])],
  ];
  for (const [name, edit] of edits) {
    const g = guardWorld(base);
    const h = await bound(g);
    await g.approve();
    edit(g);
    const { value: out, logged } = await quietly(() => g.commit(h, taskIntent("CREATE", "task-1", { Task: "Relancer", Type: TYPE_NAMES.prospection, "Due Date": DAY.d4 })));
    assert.deepEqual(held(out), ["HELD", "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE"], `${name}: ${JSON.stringify(out)}`);
    assert.ok((out as unknown as { evidence: string[] }).evidence.some((e) => e.includes("differs from the approved digest")), name);
    assert.equal(g.client.writes.length, 0, name);
    await assertNoBusinessValue(g, out, logged);
  }
});

/** Edits the Decision Rules schema in place. */
function rulesSchema(g: GuardWorld, edit: (properties: Record<string, unknown>) => void): void {
  const properties = { ...(g.map.get(`data_source:${G.rulesDs}`) as { properties: Record<string, unknown> }).properties };
  edit(properties);
  g.map.set(`data_source:${G.rulesDs}`, { properties });
}

test("PT-COMMIT-001/b4: absent, truncated, ambiguous or invalid guard sources allow no approval and no production", async () => {
  const doc = index([], taskClasses());
  const breakers: Array<[string, (g: GuardWorld) => void]> = [
    ["Decision Rules absent", (g) => g.map.set(`children:${G.cp}`, { results: ((g.map.get(`children:${G.cp}`) as { results: Array<{ id: string }> }).results).filter((b) => b.id !== G.rulesDb), has_more: false, next_cursor: null })],
    ["Decision Rules truncated", (g) => g.intercept(G.rulesDs, (o) => ({ ...(o as object), has_more: true, next_cursor: null }))],
    ["Runtime Configuration truncated", (g) => g.intercept(G.runtimeDs, (o) => ({ ...(o as object), has_more: undefined }))],
    ["Decision Rules without Default Disposition", (g) => rulesSchema(g, (p) => { delete p["Default Disposition"]; })],
    ["Default Disposition not a select", (g) => rulesSchema(g, (p) => { p["Default Disposition"] = { type: "rich_text" }; })],
    ["index without code block", (g) => setIndex(g.map, doc, [])],
    ["index with two json blocks", (g) => setIndex(g.map, doc, [codeBlock(JSON.stringify(doc), "json", "a"), codeBlock(JSON.stringify(doc), "json", "b")])],
    ["index block not json", (g) => setIndex(g.map, doc, [codeBlock(JSON.stringify(doc), "javascript")])],
    ["index not parseable", (g) => setIndex(g.map, `${JSON.stringify(doc)} ,`)],
    ["index with an unknown key", (g) => setIndex(g.map, { ...doc, verdict: "NOT_TRIGGERED" })],
    ["index predicate too deep", (g) => setIndex(g.map, index([p0(7, { op: "ALL", terms: [{ op: "ANY", terms: [{ op: "ALL", terms: [eq(lit(1), lit(1))] }] }] })], taskClasses()))],
    ["second page declaring the index", (g) => {
      const other = synthetic("guard-constitution-copy");
      g.map.set(`children:${G.constitution}`, { results: [...((g.map.get(`children:${G.constitution}`) as { results: unknown[] }).results), { object: "block", id: other, type: "child_page", child_page: { title: "Copie" } }], has_more: false, next_cursor: null });
      g.map.set(`children:${other}`, { results: [codeBlock(JSON.stringify(doc), "json", "copy")], has_more: false, next_cursor: null });
    }],
  ];
  for (const [name, breakWorld] of breakers) {
    // Broken before approval: the operator cannot approve.
    const fresh = guardWorld({ doc });
    breakWorld(fresh);
    const refused = await approveGuard(fresh.deps, { principal_id: OWNER.principal_id, project: "VERTIGO", operator_id: "operator-test", now: NOW });
    assert.equal(refused.kind, "REFUSED", `${name}: ${JSON.stringify(refused)}`);
    // Broken after approval: no new production.
    const g = guardWorld({ doc });
    const h = await bound(g);
    await g.approve();
    breakWorld(g);
    const out = await g.commit(h, taskIntent("CREATE", "task-1", { Task: "Relancer", Type: TYPE_NAMES.prospection, "Due Date": DAY.d4 }));
    assert.deepEqual(held(out), ["HELD", "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE"], `${name}: ${JSON.stringify(out)}`);
    assert.equal(g.client.writes.length, 0, name);
  }
});

test("PT-COMMIT-001/b5: T-0 fixes the instant — a constraint that takes effect later changes the snapshot, and only a new approval accepts it", async () => {
  const later = new Date(NOW.getTime() + 3_600_000).toISOString();
  const g = guardWorld({ doc: index([], taskClasses()), constraints: [timezone(), constraint("later", 3, { value: "à venir", effective: later })] });
  const h = await bound(g);
  await g.approve();
  const before = await g.commit(h, taskIntent("CREATE", "task-1", { Task: "Relancer", Type: TYPE_NAMES.prospection, "Due Date": DAY.d4 }));
  assert.equal(before.kind, "PERSISTED", JSON.stringify(before));
  g.clock.t += 2 * 3_600_000;
  const after = await g.commit(h, taskIntent("CREATE", "task-2", { Task: "Relancer", Type: TYPE_NAMES.prospection, "Due Date": DAY.d4 }));
  assert.deepEqual(held(after), ["HELD", "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE"], JSON.stringify(after));
  await g.approve();
  const renewed = await g.commit(h, taskIntent("CREATE", "task-2", { Task: "Relancer", Type: TYPE_NAMES.prospection, "Due Date": DAY.d4 }));
  assert.equal(renewed.kind, "PERSISTED", JSON.stringify(renewed));
});

test("PT-COMMIT-001/b6: a drift BETWEEN two stage 1 writes stops before the second byte (INTERRUPTED); only ledger recovery completes that plan", async () => {
  const g = guardWorld({ rules: [rule("r7", 7)], doc: index([p0(7, eq(ref("PT:MODE"), lit("LITIGE")))]), configs: [configRow("mode", "PT:MODE", { value: "NORMAL" })] });
  const h = await bound(g);
  await g.approve();
  let edited = false;
  g.client.onWrite = () => { if (!edited) { edited = true; putRows(g.map, G.rulesDs, [rule("r7", 7, { text: "Règle modifiée pendant l'écriture" })]); } };
  const first = await g.commit(h, b0Intent());
  assert.deepEqual([first.kind, (first as { reason?: string }).reason, (first as { notion_status?: unknown }).notion_status, (first as { phase?: string }).phase], ["INTERRUPTED", "GUARD_DRIFT", "NOT_SENT", "STAGE1"], JSON.stringify(first));
  const plan = (first as { plan_id: string }).plan_id;
  const stored = await g.deps.store.plans.get(plan);
  assert.ok(stored && stored.stage1_writes.length >= 2, "the plan has at least two stage 1 writes");
  assert.equal(g.client.writes.length, 1, "the second stage 1 write was never sent");
  assert.equal((first as { failed_symbol?: string }).failed_symbol, stored.stage1_writes[1]?.symbol, "stopped right before the second stage 1 write");
  assert.notEqual(stored.plan_state, "FINAL_VERIFIED");
  delete g.client.onWrite;
  const next = await g.commit(h, b0Intent());
  assert.deepEqual(held(next), ["HELD", "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE"], JSON.stringify(next));
  assert.equal((await g.deps.store.plans.get(plan))?.plan_state, "FINAL_VERIFIED", "the started plan was repaired from the ledger");
  assert.ok(next.warnings.some((w) => w.includes("completed from the ledger")));
  assert.equal(rowsOf(g.map, G.configDs).filter((p) => propText(p, "Config Item") === B0_KEY).length, 1);
});

test("PT-COMMIT-001/b6b: the guard is re-proven before EVERY write of a new plan — first, stage 1, finalization, STATE_LAST", async () => {
  const world = () => guardWorld({ rules: [rule("r7", 7)], doc: index([p0(7, eq(ref("PT:MODE"), lit("LITIGE")))]), configs: [configRow("mode", "PT:MODE", { value: "NORMAL" })] });
  const drift = (g: GuardWorld) => putRows(g.map, G.rulesDs, [rule("r7", 7, { text: "Règle modifiée pendant l'écriture" })]);
  // The clean write sequence of this plan (the derived movement deferred, so one plan only).
  const clean = world();
  const hc = await bound(clean);
  await clean.approve();
  const baseline = await clean.commit(hc, b0Intent(), { commitBudgetMs: 17_000 });
  assert.equal(baseline.kind, "PERSISTED", JSON.stringify(baseline));
  const symbols = clean.client.writes.map((w) => w.ctx.symbol as string);
  const plan = await clean.deps.store.plans.get((baseline as { plan_id: string }).plan_id);
  const phaseOf = (symbol: string) => (plan?.stage1_writes.some((w) => w.symbol === symbol) ? "STAGE1" : plan?.finalization_writes.some((w) => w.symbol === symbol) ? "FINALIZATION" : "STATE_LAST");
  assert.ok(symbols.length >= 4, JSON.stringify(symbols));

  // Drift after the preflight, before the first byte: nothing of the plan is written, a plain HOLD.
  const g0 = world();
  const h0 = await bound(g0);
  await g0.approve();
  let reads = 0;
  g0.intercept(G.rulesDs, (o) => { reads += 1; if (reads > 1) drift(g0); return reads > 1 ? g0.map.get(`query:${G.rulesDs}`) : o; });
  const none = await g0.commit(h0, b0Intent(), { commitBudgetMs: 17_000 });
  assert.deepEqual([...held(none), (none as { phase?: string }).phase, (none as { wrote_anything?: boolean }).wrote_anything], ["HELD", "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE", "STAGE1", false], JSON.stringify(none));
  assert.equal(g0.client.writes.length, 0, "no first byte");

  // Drift after write k: write k+1 is never sent, whatever its phase.
  const phases = new Set<string>();
  for (let k = 1; k < symbols.length; k += 1) {
    const g = world();
    const h = await bound(g);
    await g.approve();
    g.client.onWrite = () => { if (g.client.writes.length === k) drift(g); };
    const out = await g.commit(h, b0Intent(), { commitBudgetMs: 17_000 });
    const expected = symbols[k] as string;
    assert.deepEqual([out.kind, (out as { reason?: string }).reason, (out as { notion_status?: unknown }).notion_status, (out as { failed_symbol?: string }).failed_symbol, (out as { phase?: string }).phase], ["INTERRUPTED", "GUARD_DRIFT", "NOT_SENT", expected, phaseOf(expected)], `after write ${k}: ${JSON.stringify(out)}`);
    assert.equal(g.client.writes.length, k, `after write ${k}: nothing more was sent`);
    phases.add(phaseOf(expected));
  }
  assert.deepEqual([...phases].sort(), ["FINALIZATION", "STAGE1", "STATE_LAST"], "every phase is guarded");
});

test("PT-COMMIT-001/b6c: a guard re-check the budget cannot finish sends nothing more (IN_PROGRESS); ledger recovery then completes the plan", async () => {
  const g = guardWorld({ rules: [rule("r7", 7)], doc: index([p0(7, eq(ref("PT:MODE"), lit("LITIGE")))]), configs: [configRow("mode", "PT:MODE", { value: "NORMAL" })] });
  const h = await bound(g);
  await g.approve();
  let armed = false;
  g.client.onWrite = () => { if (g.client.writes.length === 1) armed = true; };
  // The re-check before the second write consumes the budget: it proves the guard unchanged, too late to write.
  g.intercept(G.rulesDs, (o) => { if (armed) { armed = false; g.clock.t += 20_000; } return o; });
  const first = await g.commit(h, b0Intent(), { commitBudgetMs: 22_000 });
  assert.deepEqual([first.kind, (first as { reason?: string }).reason, (first as { phase?: string }).phase], ["IN_PROGRESS", "BUDGET", "STAGE1"], JSON.stringify(first));
  assert.equal(g.client.writes.length, 1, "no byte after the unfinished re-check");
  const plan = (first as { plan_id: string }).plan_id;
  delete g.client.onWrite;
  await g.commit(h, b0Intent());
  assert.equal((await g.deps.store.plans.get(plan))?.plan_state, "FINAL_VERIFIED", "the started plan was completed");
  assert.equal(rowsOf(g.map, G.configDs).filter((p) => propText(p, "Config Item") === B0_KEY).length, 1, "one answer row");
});

test("PT-COMMIT-001/b7: a digest drift blocks every new mutation, a proven future protection included", async () => {
  const g = guardWorld({ doc: index([], cls(CLASSES.taskProtectionCreate)), rules: [] });
  const h = await bound(g);
  await g.approve();
  putRows(g.map, G.rulesDs, [rule("r9", 9)]);
  const out = await g.commit(h, taskIntent("CREATE", "prot-1", { Task: "Protéger", Type: TYPE_NAMES.protection, "Due Date": DAY.d1 }));
  assert.deepEqual(held(out), ["HELD", "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE"], JSON.stringify(out));
  assert.equal(g.client.writes.length, 0);
});

/* ───────────────────────────── /c — E4 ───────────────────────────── */

const MODE = (value: string) => configRow("mode", "PT:MODE", { value });
const litige = p0(7, eq(ref("PT:MODE"), lit("LITIGE")));
const e4Classes = () => cls(CLASSES.taskProduction, CLASSES.taskProtectionCreate, CLASSES.taskProtectionUpdate, CLASSES.taskReconcile);
function e4(o: { mode?: string; rules?: Page[]; p0?: unknown[]; classes?: ClassEntry[]; tasks?: Page[]; constraints?: Page[] } = {}) {
  return guardWorld({ rules: o.rules ?? [rule("r7", 7)], doc: index(o.p0 ?? [litige], o.classes ?? e4Classes()), configs: [MODE(o.mode ?? "LITIGE")], ...(o.tasks ? { tasks: o.tasks } : {}), ...(o.constraints ? { constraints: o.constraints } : {}) });
}
const production = (key = "prod-1", o: { action_class?: string; summary?: string } = {}) => taskIntent("CREATE", key, { Task: "Prospecter", Type: TYPE_NAMES.prospection, Status: "READY", "Due Date": DAY.d4 }, o);

test("PT-COMMIT-001/c1: P0 TRIGGERED blocks a new production (HOLD_P0_PRODUCTION, zero write); NOT_TRIGGERED lets it persist", async () => {
  const g = e4();
  const h = await bound(g);
  await g.approve();
  const runs = rowsOf(g.map, R.salesRunsDs).length; const ledger = rowsOf(g.map, R.salesLedgerDs).length;
  const { value: out, logged } = await quietly(() => g.commit(h, production()));
  assert.deepEqual(held(out), ["HELD", "HOLD_P0_PRODUCTION"], JSON.stringify(out));
  assert.ok((out as unknown as { evidence: string[] }).evidence.includes("P0 rule 7: TRIGGERED"));
  await assertNothingWritten(g, runs, ledger);
  await assertNoBusinessValue(g, out, logged);
  const calm = e4({ mode: "NORMAL" });
  const hc = await bound(calm);
  await calm.approve();
  assert.equal((await calm.commit(hc, production())).kind, "PERSISTED");
});

test("PT-COMMIT-001/c2: an UNVERIFIABLE P0 — another authority, outside the allowlist, a rule without entry, an entry without rule — blocks production", async () => {
  const cases: Array<[string, Parameters<typeof e4>[0]]> = [
    ["operational authority", { p0: [p0(7, eq(ref("PT:MODE", "Value", "TEXT", "OPERATIONAL_LIVE"), lit("LITIGE")))] }],
    ["outside the read allowlist", { p0: [p0(7, eq(ref("https://x.example/", "Company", "TEXT", "CONTRACT_STATIC", "SALES:ACCOUNTS"), lit("X")))] }],
    ["active P0 without entry", { rules: [rule("r7", 7), rule("r8", 8)], mode: "NORMAL" }],
    ["entry without active P0", { p0: [litige, p0(9, eq(lit("a"), lit("a")))], mode: "NORMAL" }],
    ["inactive rule is not P0", { rules: [rule("r7", 7, { active: false })], mode: "NORMAL" }],
    ["NUMBER comparison with a TEXT operand", { p0: [p0(7, { op: "NUMBER_LT", left: ref("PT:MODE", "Amount", "NUMBER"), right: lit("40") })] }],
  ];
  for (const [name, o] of cases) {
    const g = e4(o);
    const h = await bound(g);
    await g.approve();
    const out = await g.commit(h, production());
    assert.deepEqual(held(out), ["HELD", "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE"], `${name}: ${JSON.stringify(out)}`);
  }
});

test("PT-COMMIT-001/c2b: only Active ∧ P0 ∧ Default Disposition HOLD governs; an absent, empty or mistyped disposition is refused", async () => {
  // An active P0 rule whose disposition is not HOLD is ignored: it needs no index entry, and its edit is no drift.
  const warn = e4({ rules: [rule("r7", 7), rule("r8", 8, { disposition: "WARN" })], mode: "NORMAL" });
  const hw = await bound(warn);
  await warn.approve();
  putRows(warn.map, G.rulesDs, [rule("r7", 7), rule("r8", 8, { disposition: "WARN", text: "Règle non bloquante révisée" })]);
  assert.equal((await warn.commit(hw, production())).kind, "PERSISTED", "a non-HOLD P0 rule governs nothing");
  // An index entry for that rule is an entry without a governing rule.
  const entry = e4({ rules: [rule("r7", 7), rule("r8", 8, { disposition: "ESCALATE" })], p0: [litige, p0(8, eq(lit("a"), lit("a")))], mode: "NORMAL" });
  const he = await bound(entry);
  await entry.approve();
  assert.deepEqual(held(await entry.commit(he, production())), ["HELD", "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE"]);
  // Absent, empty or mistyped on an active P0 row: nothing can be approved, and after approval nothing is produced.
  const cell = (edit: (p: Record<string, unknown>) => void): Page => { const r = rule("r7", 7); const properties = { ...r.properties }; edit(properties); return { ...r, properties } as Page; };
  const broken: Array<[string, Page]> = [
    ["cell absent", cell((p) => { delete p["Default Disposition"]; })],
    ["cell empty", rule("r7", 7, { disposition: null })],
    ["cell mistyped", cell((p) => { p["Default Disposition"] = { type: "rich_text", rich_text: [] }; })],
  ];
  for (const [name, row] of broken) {
    const fresh = e4({ rules: [row] });
    const refused = await approveGuard(fresh.deps, { principal_id: OWNER.principal_id, project: "VERTIGO", operator_id: "operator-test", now: NOW });
    assert.equal(refused.kind, "REFUSED", `${name}: ${JSON.stringify(refused)}`);
    const g = e4({ mode: "NORMAL" });
    const h = await bound(g);
    await g.approve();
    putRows(g.map, G.rulesDs, [row]);
    const out = await g.commit(h, production());
    assert.deepEqual(held(out), ["HELD", "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE"], `${name}: ${JSON.stringify(out)}`);
    assert.equal(g.client.writes.length, 0, name);
  }
});

test("PT-COMMIT-001/c3: three-valued logic and typed comparisons — ANY with one true triggers, ALL with one false does not", async () => {
  const unknown = eq(ref("PT:MODE", "Value", "TEXT", "OPERATIONAL_LIVE"), lit("x"));
  const cases: Array<[string, unknown, string]> = [
    ["ANY(true, unknown)", { op: "ANY", terms: [eq(ref("PT:MODE"), lit("LITIGE")), unknown] }, "HOLD_P0_PRODUCTION"],
    ["ALL(false, unknown)", { op: "ALL", terms: [eq(ref("PT:MODE"), lit("AUTRE")), unknown] }, "PERSISTED"],
    ["NUMBER_GTE 42 ≥ 40", { op: "NUMBER_GTE", left: ref("PT:MODE", "Amount", "NUMBER"), right: lit(40) }, "HOLD_P0_PRODUCTION"],
    ["NUMBER_LT 42 < 40", { op: "NUMBER_LT", left: ref("PT:MODE", "Amount", "NUMBER"), right: lit(40) }, "PERSISTED"],
    ["NOT_EQUAL exact text, no trim", { op: "NOT_EQUAL", left: ref("PT:MODE"), right: lit("LITIGE ") }, "HOLD_P0_PRODUCTION"],
    ["POINTER_STATUS_IS MATCH", { op: "POINTER_STATUS_IS", config_id: 2, status: "MATCH" }, "HOLD_P0_PRODUCTION"],
    ["PRESENT on a filled value", { op: "PRESENT", operand: ref("PT:MODE") }, "HOLD_P0_PRODUCTION"],
  ];
  for (const [name, predicate, expected] of cases) {
    const g = e4({ p0: [p0(7, predicate)], constraints: [timezone(), constraint("p", 2, { type: "PRODUCTION_CONTRACT_POINTER", value: "LITIGE", pointer: pointer("PT:MODE") })] });
    const h = await bound(g);
    await g.approve();
    const out = await g.commit(h, production());
    assert.equal(out.kind === "HELD" ? out.code : out.kind, expected, `${name}: ${JSON.stringify(out)}`);
  }
  // A NUMBER reference to a text property is an unexpected type: the snapshot cannot be approved at all.
  const g = e4({ p0: [p0(7, { op: "NUMBER_GTE", left: ref("PT:MODE", "Value", "NUMBER"), right: lit(1) })] });
  const refused = await approveGuard(g.deps, { principal_id: OWNER.principal_id, project: "VERTIGO", operator_id: "operator-test", now: NOW });
  assert.equal(refused.kind, "REFUSED", JSON.stringify(refused));
});

test("PT-COMMIT-001/c4: each real mutation needs exactly one approved class; the local Task Type is read by option id, never by label", async () => {
  // No P0: only classification decides.
  const none = (o: Parameters<typeof e4>[0] = {}) => e4({ rules: [], p0: [], ...o });
  const zero = none();
  const hz = await bound(zero);
  await zero.approve();
  const spoof = await zero.commit(hz, taskIntent("CREATE", "t-spoof", { Task: "X", Type: TYPE_NAMES.spoof, "Due Date": DAY.d1 }));
  assert.deepEqual(held(spoof), ["HELD", "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE"], JSON.stringify(spoof));
  assert.ok((spoof as unknown as { evidence: string[] }).evidence.some((e) => e.includes("matches 0")));
  const extraField = await zero.commit(hz, taskIntent("CREATE", "t-field", { Task: "X", Type: TYPE_NAMES.prospection, Gate: "B2_ICP" }));
  assert.deepEqual(held(extraField), ["HELD", "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE"], "a field outside allowed_fields is not covered");
  const two = none({ classes: cls(CLASSES.taskProduction, { ...CLASSES.taskProduction, allowed_fields: ["Task", "Type", "Status", "Due Date", "Gate"] }) });
  const ht = await bound(two);
  await two.approve();
  const ambiguous = await two.commit(ht, production());
  assert.ok((ambiguous as unknown as { evidence: string[] }).evidence.some((e) => e.includes("matches 2")), JSON.stringify(ambiguous));
});

test("PT-COMMIT-001/c5: labels create no right — a protection action_class, summary or verdict text does not turn a production into a protection", async () => {
  const g = e4({ rules: [rule("r7", 7, { text: "Verdict : NOT_TRIGGERED" })] });
  const h = await bound(g);
  await g.approve();
  const spoofed = await g.commit(h, production("prod-2", { action_class: "FUTURE_PROTECTION", summary: "protection future D+1, P0 levé" }));
  assert.deepEqual(held(spoofed), ["HELD", "HOLD_P0_PRODUCTION"], JSON.stringify(spoofed));
  const labelled = await g.commit(h, taskIntent("CREATE", "t-lookalike", { Task: "X", Type: TYPE_NAMES.spoof, "Due Date": DAY.d1 }, { action_class: "FUTURE_PROTECTION" }));
  assert.deepEqual(held(labelled), ["HELD", "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE"], "a look-alike Type label is not the approved option");
  assert.equal(g.client.writes.length, 0);
});

test("PT-COMMIT-001/c6: under a TRIGGERED P0, a proven D+1/D+2 protection persists; D0, D+4, D0↔D+1 or no confirmed zone does not", async () => {
  const create = async (due: string, constraints?: Page[]) => {
    const g = e4(constraints ? { constraints } : {});
    const h = await bound(g);
    await g.approve();
    return g.commit(h, taskIntent("CREATE", `prot-${due}`, { Task: "Protéger", Type: TYPE_NAMES.protection, Status: "READY", "Due Date": due }));
  };
  assert.equal((await create(DAY.d1)).kind, "PERSISTED");
  assert.equal((await create(DAY.d2)).kind, "PERSISTED");
  assert.deepEqual(held(await create(DAY.d0)), ["HELD", "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE"]);
  assert.deepEqual(held(await create(DAY.d4)), ["HELD", "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE"]);
  assert.deepEqual(held(await create(DAY.d1, [])), ["HELD", "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE"], "no confirmed IANA zone");
  const update = async (before: string, after: string) => {
    const g = e4({ tasks: [task("existing", "prot-x", { type: "protection", due: before })] });
    const h = await bound(g);
    await g.approve();
    return g.commit(h, taskIntent("UPDATE", "prot-x", { "Due Date": after }));
  };
  assert.equal((await update(DAY.d1, DAY.d2)).kind, "PERSISTED", "D+1 → D+2 stays protected");
  assert.deepEqual(held(await update(DAY.d0, DAY.d1)), ["HELD", "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE"], "D0 → D+1 is not a protection");
  assert.deepEqual(held(await update(DAY.d1, DAY.d0)), ["HELD", "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE"], "D+1 → D0 is not a protection");
});

test("PT-COMMIT-001/c7: the guard's own sources are never written by os_commit", async () => {
  const g = e4({ constraints: [timezone(), constraint("p", 2, { type: "PRODUCTION_CONTRACT_POINTER", value: "X", pointer: pointer("PT:CAP") })], classes: [...e4Classes(), { class: "PRODUCTION", resource_key: "SALES:BUSINESS_CONFIG", operation: "UPDATE", allowed_fields: ["Value"] }, { class: "PRODUCTION", resource_key: "SALES:BUSINESS_CONFIG", operation: "CREATE", allowed_fields: ["Value", "State", "Category"] }] });
  const h = await bound(g);
  await g.approve();
  const self = await g.commit(h, { intent: { action_class: "COMMIT", summary: "lift the rule", mutations: [{ logical_resource_key: "SALES:BUSINESS_CONFIG", operation: "UPDATE", record_selector: { natural_key: "PT:MODE" }, desired_changes: { Value: "NORMAL" } }] } });
  assert.deepEqual(held(self), ["HELD", "HOLD_ACTION_NOT_AUTHORIZED"], JSON.stringify(self));
  const pointed = await g.commit(h, { intent: { action_class: "COMMIT", summary: "set the pointed value", mutations: [{ logical_resource_key: "SALES:BUSINESS_CONFIG", operation: "CREATE", record_selector: { natural_key: "PT:CAP" }, desired_changes: { Value: "X", State: "CONFIRMED", Category: "CONSTRAINT" } }] } });
  assert.deepEqual(held(pointed), ["HELD", "HOLD_ACTION_NOT_AUTHORIZED"], JSON.stringify(pointed));
  assert.equal(g.client.writes.length, 0);
});

test("PT-COMMIT-001/c8: under a TRIGGERED P0, a reconciliation as-is persists and a divergent write does not", async () => {
  const g = e4({ tasks: [task("existing", "prod-x", { type: "prospection", due: DAY.d4, status: "READY" })] });
  const h = await bound(g);
  await g.approve();
  const asIs = await g.commit(h, taskIntent("UPDATE", "prod-x", { Status: "READY" }));
  assert.equal(asIs.kind, "PERSISTED", JSON.stringify(asIs));
  const divergent = await g.commit(h, taskIntent("UPDATE", "prod-x", { Status: "DONE" }));
  assert.deepEqual(held(divergent), ["HELD", "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE"], JSON.stringify(divergent));
  assert.equal(propText(rowsOf(g.map, G.tasksDs).find((p) => propText(p, "Idempotency Key") === "prod-x") as Page, "Status"), "READY");
});

test("PT-COMMIT-001/c9: a plan already started is repaired from the ledger under a TRIGGERED P0; the new production is refused", async () => {
  const g = e4({ mode: "NORMAL" });
  const h = await bound(g);
  await g.approve();
  g.client.fault({ symbol: "OPEN_RUN" }, "APPLY_THEN_FAIL");
  const first = await g.commit(h, production("prod-started"));
  assert.equal(first.kind, "INTERRUPTED", JSON.stringify(first));
  putRows(g.map, G.configDs, [MODE("LITIGE")]);
  await g.approve();
  g.clock.t += 60_000;
  const next = await g.commit(h, production("prod-new"));
  assert.deepEqual(held(next), ["HELD", "HOLD_P0_PRODUCTION"], JSON.stringify(next));
  assert.equal((await g.deps.store.plans.get((first as { plan_id: string }).plan_id))?.plan_state, "FINAL_VERIFIED", "the started plan was completed");
  const keys = rowsOf(g.map, G.tasksDs).map((p) => propText(p, "Idempotency Key"));
  assert.deepEqual([keys.filter((k) => k === "prod-started").length, keys.filter((k) => k === "prod-new").length], [1, 0]);
});
