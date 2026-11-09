/**
 * PT-EXEC-002 — the executor completes a whole transaction itself (PV-WRITE-001 / W1.7).
 *
 * A real META plan (os_bind + os_prepare on the resume world) is executed end to end by `executeTransaction`:
 * stage 1 → the existing TARGET verifier → finalization and STATE_LAST → the existing FINAL verifier → atomic
 * finalizePlan. Checked: PERSISTED with two receipts; MUTATE on the target → HOLD_TARGET_WRONG_VALUE and no
 * FINAL; STATE_LAST lost twice → HOLD_STATE_LAST_NOT_PROVEN, then the next call proves it; a replay of the same
 * execution → `repeated`, nothing written; a Run the index does not show yet is found through the journal hint.
 *
 * The world's Runs and Mutation Ledger declare their lifecycle options, as Notion data sources do: the executor
 * refuses a governed value it cannot find among the options (D11).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hashHandle } from "../../src/binding/handle.ts";
import { checkLiveness } from "../../src/binding/service.ts";
import { FixtureNotionClient } from "../../src/notion/fixtureClient.ts";
import { propText, type Page } from "../../src/notion/shapes.ts";
import type { Plan } from "../../src/plans/store.ts";
import type { ResolvedRuntime } from "../../src/resolvers/types.ts";
import { dispatch, resolveRuntimeFor } from "../../src/tools/handlers.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import { Deadline } from "../../src/transactions/budget.ts";
import { executeTransaction, type ExecuteContext, type TransactionDeps } from "../../src/transactions/execute.ts";
import { handleOf, OWNER } from "./binding-fixtures.ts";
import { buildResumeWorld, type ResumeWorld } from "./resume-fixtures.ts";

// After the world's history (dated 2030-01-01/02), like the os_verify(FINAL) suite's transaction timeline.
const NOW = new Date("2030-01-03T00:30:00.000Z");
const ctxCall = { principal_id: OWNER.principal_id, now: NOW };
const gateIntent = { action_class: "COMMIT", summary: "set the next frame question", mutations: [{ logical_resource_key: "META:GATES", operation: "UPDATE" as const, record_selector: { natural_key: "T1" }, desired_changes: { "Next Question": "What is the offer?" } }] };

/** The lifecycle values the control-plane contract gives Runs and ledger rows, declared as Notion select options. */
const LIFECYCLE: Readonly<Record<string, readonly string[]>> = { Status: ["RUNNING", "COMPLETED", "HOLD", "FAILED", "PREPARED", "WRITTEN", "VERIFIED"], Origin: ["PLUGIN", "RUNTIME", "META_RUNTIME"], Operation: ["CREATE", "UPDATE", "UPSERT"] };

function declareOptions(map: Map<string, unknown>, ds: string): void {
  const source = map.get(`data_source:${ds}`) as { properties: Record<string, { type: string }> };
  const rows = ((map.get(`query:${ds}`) as { results?: Page[] } | undefined)?.results ?? []);
  const properties = Object.fromEntries(Object.entries(source.properties).map(([name, p]) => {
    if (p.type !== "select" && p.type !== "status") return [name, p];
    // Options = what the rows already carry + what the contract's lifecycle declares for this property.
    const present = rows.map((r) => propText(r, name)).filter((v): v is string => typeof v === "string" && v !== "");
    return [name, { ...p, [p.type]: { options: [...new Set([...present, ...(LIFECYCLE[name] ?? [])])].map((n) => ({ name: n })) } }];
  }));
  map.set(`data_source:${ds}`, { ...source, properties });
}

async function setup(): Promise<{ w: ResumeWorld; client: FixtureNotionClient; deps: TransactionDeps; plan: Plan; ctx: () => ExecuteContext; clock: { t: number }; h: string }> {
  const w = buildResumeWorld();
  const clock = { t: NOW.getTime() };
  const h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctxCall, w.deps));
  const p = await dispatch("os_prepare", { binding_handle: h, intent: gateIntent }, ctxCall, w.deps);
  assert.equal(p.code, "PLAN_PREPARED", JSON.stringify(p));
  const plan = (await w.deps.store.plans.get(((p as Extract<Envelope, { status: "OK" }>).result as { plan_id: string }).plan_id))!;
  for (const ds of [plan.stage1_writes.find((x) => x.purpose === "OPEN_RUN")!.target_ref, plan.stage1_writes.find((x) => x.purpose === "PREPARE_LEDGER")!.target_ref]) declareOptions(w.map, ds);
  const client = new FixtureNotionClient(w.map, { now: () => new Date(clock.t) });
  const deps: TransactionDeps = { ...w.deps, notion: client, notionWriter: client };
  const binding = (await w.deps.store.bindings.findByHandleHash(hashHandle(h)))!;
  const live = await checkLiveness(w.deps.store, w.deps.principals, binding, NOW, (pr, project, lane) => resolveRuntimeFor(w.deps, pr, project, lane));
  assert.ok(live.ok);
  const runtime = (live as { runtime: ResolvedRuntime }).runtime;
  const ctx = (): ExecuteContext => ({ principal_id: OWNER.principal_id, binding, runtime, plan_id: plan.plan_id, cursor_ref: plan.state_last_write.target_ref, deadline: new Deadline(() => clock.t), clock: () => new Date(clock.t), sleep: async () => {} });
  return { w, client, deps, plan, ctx, clock, h };
}

const instructions = (plan: Plan) => [...plan.stage1_writes, ...plan.finalization_writes, plan.state_last_write];

test("PT-EXEC-002/a: a whole transaction is written and proved by the server — PERSISTED, two receipts, plan FINAL_VERIFIED", async () => {
  const s = await setup();
  const out = await executeTransaction(s.deps, s.ctx());
  assert.equal(out.kind, "PERSISTED", JSON.stringify(out));
  const persisted = out as Extract<typeof out, { kind: "PERSISTED" }>;
  assert.deepEqual([persisted.repeated, persisted.origin, persisted.writes_sent], [false, "INTENT", instructions(s.plan).length]);
  assert.deepEqual(s.client.writes.map((x) => x.ctx.symbol), instructions(s.plan).map((x) => x.symbol), "every instruction once, stage 1 → finalization → STATE_LAST last");
  const target = (await s.deps.store.receipts.get(persisted.target_receipt_id))!;
  const final = (await s.deps.store.receipts.get(persisted.final_receipt_id))!;
  assert.deepEqual([target.type, target.status, final.type, final.target_receipt_id], ["TARGET", "CONSUMED", "FINAL", target.receipt_id]);
  assert.equal((await s.deps.store.plans.get(s.plan.plan_id))!.plan_state, "FINAL_VERIFIED");
  assert.equal(await s.deps.store.leases.current({ project: "VERTIGO", lane: "META", runtime_generation: s.plan.runtime_generation }, NOW), undefined, "lease released");
  assert.deepEqual((await s.deps.store.planWrites.list(s.plan.plan_id)).map((r) => r.status), instructions(s.plan).map(() => "DONE"));
  assert.equal(persisted.run_ref, (await s.deps.store.planWrites.list(s.plan.plan_id)).find((r) => r.symbol === "OPEN_RUN")?.created_id);
  // The durable state reads back clean for the next conversation.
  const resumed = await dispatch("os_resume", { binding_handle: s.h }, ctxCall, s.deps);
  assert.equal(resumed.code, "RESUMED", JSON.stringify(resumed));
});

test("PT-EXEC-002/b: MUTATE on the target → HOLD_TARGET_WRONG_VALUE at TARGET; no receipt, finalization never written", async () => {
  const s = await setup();
  const targetSymbol = s.plan.stage1_writes.find((x) => x.purpose === "WRITE_TARGET")!.symbol;
  s.client.fault({ symbol: targetSymbol }, "MUTATE", { mutate: (p) => ({ ...p, "Next Question": { rich_text: [{ type: "text", text: { content: "What is the price?" } }] } }) });
  const out = await executeTransaction(s.deps, s.ctx());
  assert.deepEqual([out.kind, (out as { phase?: string }).phase, (out as { code?: string }).code], ["HELD", "TARGET", "HOLD_TARGET_WRONG_VALUE"]);
  assert.deepEqual(await s.deps.store.receipts.findByPlan(s.plan.plan_id), [], "no TARGET, no FINAL receipt");
  assert.deepEqual((await s.deps.store.planWrites.list(s.plan.plan_id)).filter((r) => r.phase !== "STAGE1").map((r) => r.status), [...s.plan.finalization_writes, s.plan.state_last_write].map(() => "PENDING"));
  assert.equal(s.client.writes.length, s.plan.stage1_writes.length);
});

test("PT-EXEC-002/c: STATE_LAST lost twice → HOLD_STATE_LAST_NOT_PROVEN by FINAL's readback; the next call resends it and proves it", async () => {
  const s = await setup();
  s.client.fault({ symbol: "STATE_LAST", times: 2 }, "LOSE");
  const out = await executeTransaction(s.deps, s.ctx());
  assert.deepEqual([out.kind, (out as { phase?: string }).phase, (out as { code?: string }).code], ["HELD", "FINAL", "HOLD_STATE_LAST_NOT_PROVEN"], JSON.stringify(out));
  assert.deepEqual(await s.deps.store.receipts.findByPlan(s.plan.plan_id, "FINAL"), [], "no FINAL receipt");
  const stateLast = (await s.deps.store.planWrites.list(s.plan.plan_id)).find((r) => r.symbol === "STATE_LAST")!;
  assert.deepEqual([stateLast.status, stateLast.attempts], ["SENT", 2]);
  s.clock.t += 60_000;
  const next = await executeTransaction(s.deps, s.ctx());
  assert.equal(next.kind, "PERSISTED", JSON.stringify(next));
  assert.deepEqual([(next as { writes_sent?: number }).writes_sent, (await s.deps.store.planWrites.list(s.plan.plan_id)).find((r) => r.symbol === "STATE_LAST")?.attempts], [1, 3], "only STATE_LAST was sent again");
});

test("PT-EXEC-002/d: a replay of the same execution is `repeated` and writes nothing", async () => {
  const s = await setup();
  const first = await executeTransaction(s.deps, s.ctx());
  assert.equal(first.kind, "PERSISTED");
  const before = s.client.writes.length;
  const again = await executeTransaction(s.deps, s.ctx());
  assert.equal(again.kind, "PERSISTED", JSON.stringify(again));
  const r = again as Extract<typeof again, { kind: "PERSISTED" }>;
  assert.deepEqual([r.repeated, r.writes_sent, r.final_receipt_id], [true, 0, (first as { final_receipt_id: string }).final_receipt_id]);
  assert.equal(s.client.writes.length, before);
});

test("PT-EXEC-002/e: a Run the query index does not show yet — TARGET finds it through the journal's created id, FINAL re-reads until the index catches up", async () => {
  const s = await setup();
  s.client.fault({ symbol: "OPEN_RUN" }, "HIDE_FROM_QUERIES");
  let waits = 0;
  // The index catches up during the executor's first wait. TARGET runs before any wait: only the hint can pass it.
  const out = await executeTransaction(s.deps, { ...s.ctx(), sleep: async () => { waits += 1; s.client.revealAll(); } });
  assert.equal(out.kind, "PERSISTED", JSON.stringify(out));
  assert.equal(waits, 1, "TARGET passed without waiting; FINAL waited once for the index");
  const runsDs = s.plan.stage1_writes.find((x) => x.purpose === "OPEN_RUN")!.target_ref;
  const runs = ((s.w.map.get(`query:${runsDs}`) as { results: Page[] }).results).filter((p) => propText(p, "Harness Plan ID") === s.plan.plan_id);
  assert.equal(runs.length, 1);
});

test("PT-EXEC-002/f: STATE_LAST lost once is resent in the same call; nothing is left to prove", async () => {
  const s = await setup();
  s.client.fault({ symbol: "STATE_LAST" }, "LOSE");
  const out = await executeTransaction(s.deps, s.ctx());
  assert.equal(out.kind, "PERSISTED", JSON.stringify(out));
  assert.equal((await s.deps.store.planWrites.list(s.plan.plan_id)).find((r) => r.symbol === "STATE_LAST")?.attempts, 2);
});
