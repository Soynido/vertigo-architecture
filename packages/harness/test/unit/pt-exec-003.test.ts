/**
 * PT-EXEC-003 — recovery and idempotence (PV-WRITE-001 / W1.8): settle() finishes or recovers the principal's own
 * interrupted work by itself, without ever duplicating a durable mutation.
 *
 * Checked on real META plans (os_bind + os_prepare on the resume world):
 *   a. crash matrix — the process dies before or after EVERY write; the next settle resumes to PERSISTED with one
 *      Run, one ledger row per operation and one effect (assertNoDuplicateDurableMutation);
 *   b. a crashed plan that expired is recovered automatically (AUTO_RECOVERY, parent plan recorded);
 *   c. a user's local edit made during the interruption is kept, with the D10 sentence;
 *   d. a CREATE that landed twice → HOLD_TARGET_AMBIGUOUS, reported, and not retried by the next settle;
 *   e. a plan held by a live executor elsewhere → one wait, then IN_PROGRESS;
 *   f. a plan the executor already wrote from is never replaced as a "draft" by a re-prepare (journal-based).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hashHandle } from "../../src/binding/handle.ts";
import { checkLiveness } from "../../src/binding/service.ts";
import { FixtureCrash, FixtureNotionClient, type FaultKind } from "../../src/notion/fixtureClient.ts";
import { propText, type Page } from "../../src/notion/shapes.ts";
import type { Plan } from "../../src/plans/store.ts";
import type { ResolvedRuntime } from "../../src/resolvers/types.ts";
import { dispatch, resolveRuntimeFor } from "../../src/tools/handlers.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import { Deadline } from "../../src/transactions/budget.ts";
import { executeTransaction, type ExecuteContext, type TransactionDeps } from "../../src/transactions/execute.ts";
import { D10_NOTICE, settle } from "../../src/transactions/settle.ts";
import { handleOf, OWNER } from "./binding-fixtures.ts";
import { assertNoDuplicateDurableMutation, type Outcome } from "./crash-harness.ts";
import { buildResumeWorld, type ResumeWorld } from "./resume-fixtures.ts";
import { mutatePage } from "./target-fixtures.ts";

const NOW = new Date("2030-01-03T00:30:00.000Z");
const ctxCall = { principal_id: OWNER.principal_id, now: NOW };
const QUESTION = "What is the offer?";
const gateIntent = { action_class: "COMMIT", summary: "set the next frame question", mutations: [{ logical_resource_key: "META:GATES", operation: "UPDATE" as const, record_selector: { natural_key: "T1" }, desired_changes: { "Next Question": QUESTION } }] };
const inputIntent = { action_class: "COMMIT", summary: "persist the F1 answer", mutations: [{ logical_resource_key: "META:INPUTS", operation: "CREATE" as const, record_selector: { natural_key: "F1:PRIMARY_OFFER" }, desired_changes: { Input: "F1 — offre principale", "Gate Key": "F1", Question: "Quelle est l'offre principale ?", Answer: "Des visites immersives" } }] };

/** Contract lifecycle values, declared as select options the way Notion data sources carry them (D11). */
const LIFECYCLE: Readonly<Record<string, readonly string[]>> = { Status: ["RUNNING", "COMPLETED", "HOLD", "FAILED", "PREPARED", "WRITTEN", "VERIFIED"], Origin: ["PLUGIN", "RUNTIME", "META_RUNTIME"], Operation: ["CREATE", "UPDATE", "UPSERT"], State: ["SUBMITTED", "CONFIRMED"], Source: ["USER_CONFIRMED_FIXTURE"] };
function declareOptions(map: Map<string, unknown>, ds: string): void {
  const source = map.get(`data_source:${ds}`) as { properties: Record<string, { type: string }> } | undefined;
  if (!source) return;
  const rows = ((map.get(`query:${ds}`) as { results?: Page[] } | undefined)?.results ?? []);
  map.set(`data_source:${ds}`, { ...source, properties: Object.fromEntries(Object.entries(source.properties).map(([name, p]) => {
    if (p.type !== "select" && p.type !== "status") return [name, p];
    const present = rows.map((r) => propText(r, name)).filter((v): v is string => typeof v === "string" && v !== "");
    return [name, { ...p, [p.type]: { options: [...new Set([...present, ...(LIFECYCLE[name] ?? [])])].map((n) => ({ name: n })) } }];
  })) });
}

interface Setup { w: ResumeWorld; client: FixtureNotionClient; deps: TransactionDeps; plan: Plan; clock: { t: number }; h: string; ctx: () => ExecuteContext; sleeps: number[] }

async function setup(intent: unknown = gateIntent): Promise<Setup> {
  const w = buildResumeWorld();
  const clock = { t: NOW.getTime() };
  const h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctxCall, w.deps));
  const p = await dispatch("os_prepare", { binding_handle: h, intent }, ctxCall, w.deps);
  assert.equal(p.code, "PLAN_PREPARED", JSON.stringify(p));
  const plan = (await w.deps.store.plans.get(((p as Extract<Envelope, { status: "OK" }>).result as { plan_id: string }).plan_id))!;
  const sources = new Set([...plan.stage1_writes.filter((x) => x.operation === "CREATE").map((x) => x.target_ref), ...plan.operations.map((o) => o.target_data_source_ref).filter((x): x is string => !!x)]);
  for (const ds of sources) declareOptions(w.map, ds);
  const client = new FixtureNotionClient(w.map, { now: () => new Date(clock.t) });
  const deps: TransactionDeps = { ...w.deps, notion: client, notionWriter: client };
  const binding = (await w.deps.store.bindings.findByHandleHash(hashHandle(h)))!;
  const live = await checkLiveness(w.deps.store, w.deps.principals, binding, NOW, (pr, project, lane) => resolveRuntimeFor(w.deps, pr, project, lane));
  assert.ok(live.ok);
  const runtime = (live as { runtime: ResolvedRuntime }).runtime;
  const sleeps: number[] = [];
  const ctx = (): ExecuteContext => ({ principal_id: OWNER.principal_id, binding, runtime, plan_id: plan.plan_id, cursor_ref: plan.state_last_write.target_ref, deadline: new Deadline(() => clock.t), clock: () => new Date(clock.t), sleep: async (ms) => { sleeps.push(ms); } });
  return { w, client, deps, plan, clock, h, ctx, sleeps };
}

const settleCtx = (s: Setup) => { const { plan_id: _unused, ...rest } = s.ctx(); return rest; };
const rows = (s: Setup, ds: string): Page[] => ((s.w.map.get(`query:${ds}`) as { results?: Page[] } | undefined)?.results ?? []);
const dsOf = (s: Setup, purpose: string) => s.plan.stage1_writes.find((x) => x.purpose === purpose)!.target_ref;
function durable(s: Setup, link = s.plan.plan_id): Outcome {
  const byLink = (ds: string) => rows(s, ds).filter((p) => propText(p, "Harness Plan ID") === link).length;
  const gatesDs = s.plan.operations[0]!.target_data_source_ref as string;
  const effects = rows(s, gatesDs).filter((p) => propText(p, "Next Question") === QUESTION).length;
  return { runs: byLink(dsOf(s, "OPEN_RUN")), ledgerRows: byLink(dsOf(s, "PREPARE_LEDGER")), targetWrites: effects } as unknown as Outcome;
}
const instructions = (plan: Plan) => [...plan.stage1_writes, ...plan.finalization_writes, plan.state_last_write];

/** Counts work done by settle itself, after all preparation/execution has finished. */
function counted(s: Setup) {
  const counts = { inventory: 0, plan: 0, events: 0, journal: 0, notion: 0 };
  const store = s.deps.store;
  const deps: TransactionDeps = { ...s.deps, store: {
    ...store,
    plans: { ...store.plans,
      async listByRuntime(...args) { counts.inventory++; return store.plans.listByRuntime(...args); },
      async get(id) { counts.plan++; return store.plans.get(id); },
    },
    events: { ...store.events, async list(filter) { counts.events++; return store.events.list(filter); } },
    planWrites: { ...store.planWrites, async list(id) { counts.journal++; return store.planWrites.list(id); } },
  }, notion: new Proxy(s.deps.notion, { get(target, property) {
    const value = Reflect.get(target, property);
    return typeof value === "function" ? (...args: unknown[]) => { counts.notion++; return Reflect.apply(value, target, args); } : value;
  } }) };
  return { deps, counts };
}

test("PT-EXEC-003/a: crash before and after every write — the next settle resumes to PERSISTED with no duplicate durable mutation", async () => {
  const probe = await setup();
  const symbols = instructions(probe.plan).map((x) => x.symbol);
  assert.equal(symbols.length, 7);
  for (const symbol of symbols) {
    for (const kind of ["CRASH_BEFORE", "CRASH_AFTER"] as FaultKind[]) {
      const s = await setup();
      s.client.fault({ symbol }, kind);
      await assert.rejects(executeTransaction(s.deps, s.ctx()), FixtureCrash, `${kind} ${symbol}`);
      s.clock.t += 120_000; // the dead executor's claim lapses; the plan is still alive
      const report = await settle(s.deps, settleCtx(s));
      const last = report.outcomes.at(-1);
      assert.equal(last?.kind, "PERSISTED", `${kind} ${symbol}: ${JSON.stringify(report)}`);
      assert.equal((await s.deps.store.plans.get(s.plan.plan_id))!.plan_state, "FINAL_VERIFIED", `${kind} ${symbol}`);
      assertNoDuplicateDurableMutation(durable(s));
      assert.equal(report.durable_hold, undefined);
    }
  }
});

test("PT-EXEC-003/b: a crashed plan that expired is recovered automatically — AUTO_RECOVERY, same Run, nothing replayed twice", async () => {
  const s = await setup();
  const target = s.plan.stage1_writes.find((x) => x.purpose === "WRITE_TARGET")!.symbol;
  s.client.fault({ symbol: target }, "CRASH_AFTER");
  await assert.rejects(executeTransaction(s.deps, s.ctx()), FixtureCrash);
  s.clock.t += 20 * 60_000; // past the plan TTL
  const report = await settle(s.deps, settleCtx(s));
  const last = report.outcomes.at(-1)!;
  assert.equal(last.kind, "PERSISTED", JSON.stringify(report));
  assert.equal(last.origin, "AUTO_RECOVERY");
  const recovery = (await s.deps.store.plans.get(last.plan_id))!;
  assert.deepEqual([recovery.plan_origin, recovery.parent_plan_id, recovery.recovers_plan_id, recovery.plan_state], ["AUTO_RECOVERY", s.plan.plan_id, s.plan.plan_id, "FINAL_VERIFIED"]);
  assert.equal((await s.deps.store.plans.get(s.plan.plan_id))!.plan_state, "EXPIRED");
  assertNoDuplicateDurableMutation(durable(s));
  assert.equal(s.client.writes.filter((x) => x.ctx.symbol === target && x.applied.length > 0).length, 1, "the target write that landed is observed, not replayed");
  // A second settle has nothing left to do.
  const checked = counted(s);
  const again = await settle(checked.deps, settleCtx(s));
  assert.deepEqual([again.outcomes.length, again.durable_hold], [0, undefined]);
  assert.deepEqual(checked.counts, { inventory: 1, plan: 0, events: 0, journal: 0, notion: 0 }, "a FINAL recovery closes its expired ancestors too; no repeated history audit");
});

test("PT-EXEC-003/c: a local user edit made during the interruption is kept (D10) and said in one sentence", async () => {
  const s = await setup();
  const target = s.plan.stage1_writes.find((x) => x.purpose === "WRITE_TARGET")!.symbol;
  s.client.fault({ symbol: target }, "CRASH_AFTER");
  await assert.rejects(executeTransaction(s.deps, s.ctx()), FixtureCrash);
  const gate = s.plan.operations[0]!.physical_target_ref as string;
  mutatePage(s.w, gate, { "Next Question": "What is the market?" }, "2030-01-03T00:40:00.000Z");
  s.clock.t += 20 * 60_000;
  const report = await settle(s.deps, settleCtx(s));
  assert.equal(report.outcomes.at(-1)?.kind, "PERSISTED", JSON.stringify(report));
  assert.deepEqual(report.notices, [D10_NOTICE]);
  assert.equal(propText(s.w.map.get(`page:${gate}`) as Page, "Next Question"), "What is the market?", "the user's version stands; nothing overwrote it");
});

test("PT-EXEC-003/d: a CREATE that landed twice → HOLD_TARGET_AMBIGUOUS, reported once, never retried automatically (AUTO_WORK_HELD)", async () => {
  const s = await setup(inputIntent);
  const target = s.plan.stage1_writes.find((x) => x.purpose === "WRITE_TARGET")!;
  assert.equal(target.operation, "CREATE");
  s.client.fault({ symbol: target.symbol }, "DUPLICATE");
  s.client.fault({ symbol: `${s.plan.stage1_writes.find((x) => x.purpose === "PREPARE_LEDGER")!.symbol}_WRITTEN` }, "CRASH_BEFORE");
  await assert.rejects(executeTransaction(s.deps, s.ctx()), FixtureCrash);
  s.clock.t += 20 * 60_000;
  const first = await settle(s.deps, settleCtx(s));
  assert.deepEqual([first.durable_hold?.code, first.durable_hold?.repeated], ["HOLD_TARGET_AMBIGUOUS", false], JSON.stringify(first));
  const writesBefore = s.client.writes.length;
  const eventsBefore = (await s.deps.store.events.list({ plan_id: s.plan.plan_id })).length;
  const second = await settle(s.deps, settleCtx(s));
  assert.deepEqual([second.durable_hold?.code, second.durable_hold?.repeated, second.outcomes.length], ["HOLD_TARGET_AMBIGUOUS", true, 0]);
  assert.equal(s.client.writes.length, writesBefore, "the anti-loop wrote nothing");
  assert.equal((await s.deps.store.events.list({ plan_id: s.plan.plan_id })).length, eventsBefore, "and logged nothing new");
});

test("PT-EXEC-003/e: a plan a live executor holds elsewhere → one wait, then IN_PROGRESS; nothing written", async () => {
  const s = await setup();
  await s.deps.store.claims.claim(s.plan.plan_id, "another-executor", NOW, new Date(NOW.getTime() + 600_000));
  const report = await settle(s.deps, settleCtx(s));
  const last = report.outcomes.at(-1)!;
  assert.deepEqual([last.kind, (last as { reason?: string }).reason], ["IN_PROGRESS", "CLAIMED_ELSEWHERE"]);
  assert.equal(s.sleeps.length, 1, "waited once");
  assert.equal(s.client.writes.length, 0);
});

test("PT-EXEC-003/f: a re-prepare of the same records never replaces a plan the executor already wrote from (journal, not plan state)", async () => {
  const s = await setup();
  s.client.fault({ symbol: "OPEN_RUN" }, "LOSE");
  assert.equal((await executeTransaction(s.deps, s.ctx())).kind, "INTERRUPTED");
  assert.equal((await s.deps.store.plans.get(s.plan.plan_id))!.plan_state, "AWAITING_STAGE1_WRITES");
  // Same record (gate T1), edited value: a different intent on the same records — the "draft" path of prepare.
  const reworded = { ...gateIntent, mutations: [{ ...gateIntent.mutations[0]!, desired_changes: { "Next Question": "What is the offer, exactly?" } }] };
  const p = await dispatch("os_prepare", { binding_handle: s.h, intent: reworded }, ctxCall, s.deps);
  assert.notEqual((await s.deps.store.plans.get(s.plan.plan_id))!.plan_state, "SUPERSEDED", `the written-from plan survived: ${p.code}`);
});

test("PT-EXEC-003/g: closed work does not trigger plan/event/journal/Notion readback on each settle", async () => {
  const s = await setup();
  assert.equal((await executeTransaction(s.deps, s.ctx())).kind, "PERSISTED");
  const completed = (await s.deps.store.plans.get(s.plan.plan_id))!;
  // More completed history must not multiply the recovery work of an ordinary request.
  for (let i = 0; i < 20; i++) {
    const ancestor = `closed-ancestor-${i}`;
    await s.deps.store.plans.insert({ ...completed, plan_id: ancestor, plan_state: "EXPIRED" });
    await s.deps.store.plans.insert({ ...completed, plan_id: `closed-recovery-${i}`, recovers_plan_id: ancestor });
  }
  const checked = counted(s), writes = s.client.writes.length;
  const report = await settle(checked.deps, settleCtx(s));
  assert.deepEqual(report, { outcomes: [], notices: [], warnings: [] });
  assert.deepEqual(checked.counts, { inventory: 1, plan: 0, events: 0, journal: 0, notion: 0 });
  assert.equal(s.client.writes.length, writes);
});
