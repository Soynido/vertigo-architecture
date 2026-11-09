/**
 * PT-COMMIT-002 — the Sales journeys B0, B1, B2…B6 and same-turn capture on os_commit (PV-WRITE-001 / W3.3M,
 * PDEC-018 CANDIDATE — NOT ADOPTED).
 *
 * Candidate mirrors of pv-b0-002, pv-b1-001-002, pv-b2-006 and pv-capture-001. Those four stay unchanged as LIVE
 * regressions of Sales 0.5.4–0.5.6 and the os_prepare/os_verify choreography; the same durable business invariants
 * are proved here on the Sales 0.5.11 candidate line (injected by the fixture only), with a structured Production
 * Guard Index (SALES_GUARD_INDEX/1) whose digest the local operator command approved outside the chat. As in those
 * four, the answer is an UPSERT on its canonical record, so this suite builds its own index (the answer's UPSERT class
 * plus the cursor class); the default fixture index, with its CREATE class, stays PT-COMMIT-001's. Every write goes
 * through a direct MCP CallTool os_commit; every persisted transaction carries its TARGET and FINAL receipts.
 * Without an approval nothing is written.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { hashHandle } from "../../src/binding/handle.ts";
import { guardBindingId } from "../../src/binding/guardIdentity.ts";
import { createServer } from "../../src/index.ts";
import { normalizeId, propText, type Page } from "../../src/notion/shapes.ts";
import type { Plan } from "../../src/plans/store.ts";
import { dispatch } from "../../src/tools/handlers.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import type { CommitOutcome } from "../../src/transactions/commit.ts";
import { SALES_CONTROL_PLANE_0511_CANDIDATE } from "../../src/versions/adapters/controlPlane.ts";
import { OWNER } from "./binding-fixtures.ts";
import { R } from "./resume-fixtures.ts";
import { B0_KEY, CLASSES, configRow, G, guardWorld, index, OUTCOME, rowsOf, type ClassEntry, type GuardWorld } from "../support/guard-fixtures.ts";

type Out = CommitOutcome & { say: string };
type Persisted = Extract<Out, { kind: "PERSISTED" }>;
const CONFIG = "SALES:BUSINESS_CONFIG";
const OS_STATE = "SALES:OS_STATE";
const B1_KEY = "B1_OFFER:SELLABLE_OFFER";
const OFFER = "Un récit industriel filmé qui rend une usine désirable pour ses clients et ses candidats";
const ANSWER = "Industriels français dont le process se filme ; on écarte l'hôtellerie et les purs services";
const NO_APPROVAL = "Approbation opérateur de la garde de production";

/** The walk the candidate line publishes: the gate each entry leaves, its canonical record and the gate it reaches. */
const walk = () => (SALES_CONTROL_PLANE_0511_CANDIDATE.cursorTransitions ?? []).map((t) => ({ from: t.fromGate, to: t.set["Current Gate"] as string, key: t.evidence.naturalKey as string, category: t.evidence.equals["Category"] as string }));
const stepOf = (from: string) => { const s = walk().find((x) => x.from === from); assert.ok(s, `the candidate line specifies ${from}`); return s; };

/** The index the operator approves for these journeys: the answer as UPSERT on its record, and the cursor move. */
const SALES_INDEX = index([], [{ class: "PRODUCTION", resource_key: CONFIG, operation: "UPSERT", allowed_fields: ["Category", "State", "Value", "Version", "Source"] }, CLASSES.cursor() as unknown as ClassEntry]);
const world = (o: Parameters<typeof guardWorld>[0] = {}) => guardWorld({ doc: SALES_INDEX, ...o });

/** The seller's answer to one step, carried as the capture step writes it (UPSERT on the step's canonical record). */
const answer = (key: string, category: string, value: string, o: { state?: string } = {}) => ({ intent: { action_class: "COMMIT", summary: "persist the seller's answer", mutations: [{ logical_resource_key: CONFIG, operation: "UPSERT", record_selector: { natural_key: key }, desired_changes: { Category: category, State: o.state ?? "CONFIRMED", Value: value, Version: "SALES_INPUT/1", Source: "CHAT_USER_EXPLICIT" } }] } });
const b0Answer = (value = OUTCOME) => answer(B0_KEY, "GOAL", value);

/** A direct MCP session on the candidate server: every write of this suite is a CallTool os_commit. */
async function session(g: GuardWorld) {
  const server = createServer(g.deps, OWNER.principal_id);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "pt-commit-002", version: "0" });
  await client.connect(ct);
  const original = console.error;
  return {
    tools: async () => (await client.listTools()).tools.map((t) => t.name),
    async commit(h: string, input: Record<string, unknown>): Promise<Out> {
      console.error = () => {};
      try {
        const r = await client.callTool({ name: "os_commit", arguments: { binding_handle: h, ...input } });
        assert.equal(r.isError, false);
        return JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as Out;
      } finally { console.error = original; }
    },
    async close() { await client.close(); await server.close(); },
  };
}

const ctx = (g: GuardWorld) => ({ principal_id: OWNER.principal_id, now: new Date(g.clock.t) });
const resume = (g: GuardWorld, h: string) => dispatch("os_resume", { binding_handle: h }, ctx(g), g.deps);
const served = (e: Envelope): Record<string, unknown> | undefined => (e.status === "OK" ? (e.result as { pending_step_input?: Record<string, unknown> }).pending_step_input : undefined);
const gateOf = (e: Envelope): string | undefined => (e.status === "OK" ? (e.result as { gate?: { gate_key?: string } }).gate?.gate_key : undefined);
const cursor = (g: GuardWorld) => { const rows = rowsOf(g.map, R.salesStateDs); assert.equal(rows.length, 1, "the cursor row is never duplicated"); return rows[0] as Page; };
const answers = (g: GuardWorld, key: string) => rowsOf(g.map, G.configDs).filter((p) => propText(p, "Config Item") === key);
const runs = (g: GuardWorld) => rowsOf(g.map, R.salesRunsDs).length;

/** The operator approves the structured index outside the chat: no tool of the five does it, the store keeps only ids. */
async function approvedOutsideChat(g: GuardWorld, h: string, tools: readonly string[]): Promise<void> {
  assert.deepEqual(tools, ["os_bind", "os_resume", "os_commit", "os_handoff", "os_control_status"], "the chat's five tools include no approval");
  const digest = await g.approve();
  const binding = (await g.deps.store.bindings.findByHandleHash(hashHandle(h)))!;
  const approval = await g.deps.store.guardApprovals?.get(guardBindingId(binding));
  assert.ok(approval, "the approval is held by the backend");
  assert.deepEqual([approval.digest_sha256, approval.guard_schema_version, normalizeId(approval.index_page_id), approval.operator_id], [digest, "SALES_GUARD_INDEX/1", normalizeId(G.indexPage), "operator-test"]);
  assert.match(digest, /^[0-9a-f]{64}$/);
}

/** One plan proved end to end: a TARGET receipt, the FINAL receipt that consumed it, and a FINAL_VERIFIED plan. */
async function proved(g: GuardWorld, planId: string, ids?: { target: string; final: string }): Promise<Plan> {
  const plan = await g.deps.store.plans.get(planId);
  assert.ok(plan, `plan ${planId} exists`);
  assert.equal(plan.plan_state, "FINAL_VERIFIED", `plan ${planId} is FINAL_VERIFIED`);
  const targets = await g.deps.store.receipts.findByPlan(planId, "TARGET");
  const finals = await g.deps.store.receipts.findByPlan(planId, "FINAL");
  assert.equal(finals.length, 1, `plan ${planId} has one FINAL receipt`);
  const final = finals[0]!;
  assert.ok(targets.some((t) => t.receipt_id === final.target_receipt_id), "the FINAL receipt is bound to a TARGET receipt of the same plan");
  if (ids) assert.deepEqual([final.target_receipt_id, final.receipt_id], [ids.target, ids.final], "the outcome names the very receipts the backend holds");
  return plan;
}

/**
 * One answered step on os_commit: the answer is proved on its canonical record, the cursor move is derived and proved
 * in its own transaction of the same call, credited to the answer's Run.
 */
async function assertStepPersisted(g: GuardWorld, out: Out, step: { key: string; to: string }, effective: "CREATE" | "UPDATE" = "CREATE"): Promise<Persisted> {
  assert.equal(out.kind, "PERSISTED", JSON.stringify(out));
  const p = out as Persisted;
  assert.deepEqual([p.origin, p.repeated, p.step_moved, p.derived_move, p.next_gate], ["INTENT", false, true, "PERSISTED", step.to]);
  // The UPSERT resolves on the record: a fresh row when none exists, that very row when one does.
  assert.deepEqual(p.targets.map((t) => [t.logical_resource_key, t.operation]), [[CONFIG, effective]], "the answer lands on the business record, never on the cursor");
  assert.equal(answers(g, step.key).length, 1, "the answer has exactly one row");
  const capture = await proved(g, p.plan_id, { target: p.target_receipt_id, final: p.final_receipt_id });
  const op = capture.operations[0] as Plan["operations"][number];
  assert.deepEqual([capture.operations.length, op.logical_resource_key, op.natural_key], [1, CONFIG, step.key]);
  assert.ok(op.compared_fields.includes("Value"), "FINAL proves the answer itself");
  assert.ok(p.derived_plan_id && p.derived_plan_id !== p.plan_id, "the move is its own transaction");
  const move = await proved(g, p.derived_plan_id);
  const cursorOp = move.operations[0] as Plan["operations"][number];
  assert.deepEqual([move.operations.length, cursorOp.logical_resource_key], [1, OS_STATE], "one cursor transition, never a batch");
  assert.equal(cursorOp.expected_values["Current Gate"], step.to);
  assert.equal(cursorOp.expected_values["Gate Passed By Run Ref"], p.run_ref, "the gate is credited to the Run that made the answer durable");
  assert.equal(cursorOp.expected_values["Last Run Ref"], "$created:OPEN_RUN");
  assert.deepEqual([propText(cursor(g), "Current Gate"), propText(cursor(g), "Build State")], [step.to, step.to]);
  return p;
}

/** Nothing durable happened: no Notion byte, no plan, no lease, no Run or ledger row, the cursor where it was. */
async function assertNothingWritten(g: GuardWorld, h: string, before: { runs: number; ledger: number; gate: string }): Promise<void> {
  const b = (await g.deps.store.bindings.findByHandleHash(hashHandle(h)))!;
  assert.equal(g.client.writes.length, 0, "no Notion byte");
  assert.equal((await g.deps.store.plans.listByRuntime(b.project, b.lane, b.runtime_generation)).length, 0, "no plan");
  assert.equal(await g.deps.store.leases.current({ project: b.project, lane: b.lane, runtime_generation: b.runtime_generation }, new Date(g.clock.t)), undefined, "no lease");
  assert.deepEqual([runs(g), rowsOf(g.map, R.salesLedgerDs).length, propText(cursor(g), "Current Gate")], [before.runs, before.ledger, before.gate]);
}

/* ───────────────────────────── B0 (mirror of PV-B0-002) ───────────────────────────── */

test("PT-COMMIT-002/b0: the B0 answer and the cursor move persist through one CallTool os_commit, TARGET/FINAL each; a fresh chat resumes at B1 and nothing re-fires", async () => {
  const g = world();
  const s = await session(g);
  try {
    const h = await g.bind();
    await approvedOutsideChat(g, h, await s.tools());
    const b0 = stepOf("B0_DISCOVERY");
    assert.equal(b0.key, B0_KEY);
    await assertStepPersisted(g, await s.commit(h, b0Answer()), b0);
    assert.equal(answers(g, B0_KEY).length, 1, "one answer row");
    assert.equal(propText(answers(g, B0_KEY)[0] as Page, "Value"), OUTCOME, "the exact answer is what is durable");

    // A brand-new chat reads the verified cursor and is past B0; the walk serves the next step's record.
    const h2 = await g.bind();
    const resumed = await resume(g, h2);
    assert.equal(resumed.code, "RESUMED", JSON.stringify(resumed));
    assert.equal(gateOf(resumed), b0.to, "a fresh resume must not re-ask B0");
    assert.equal(served(resumed)?.["natural_key"], B1_KEY);

    // Asking again with the cursor already moved derives nothing and opens no second Run.
    const runsAfter = runs(g);
    const again = await s.commit(h2, {});
    assert.deepEqual([again.kind, again.kind === "HELD" ? again.code : "—", (again as { wrote_anything?: boolean }).wrote_anything], ["HELD", "ERROR_INVALID_ARGUMENT", false], JSON.stringify(again));
    assert.deepEqual([runs(g), propText(cursor(g), "Current Gate")], [runsAfter, b0.to], "the transition does not re-fire once the cursor moved");
  } finally { await s.close(); }
});

/* ───────────────────────────── B1 (mirror of PV-B1-001/002) ───────────────────────────── */

test("PT-COMMIT-002/b1: the OFFER step serves its own record, its answer persists and moves the cursor to B2 once; a replay writes nothing", async () => {
  const g = world({ gate: "B1_OFFER" });
  const s = await session(g);
  try {
    const h = await g.bind();
    await approvedOutsideChat(g, h, await s.tools());
    const b1 = stepOf("B1_OFFER");
    assert.equal(b1.key, B1_KEY);
    const open = await resume(g, h);
    assert.equal(open.code, "RESUMED", JSON.stringify(open));
    assert.equal(served(open)?.["natural_key"], B1_KEY, "the open OFFER step serves its own record, never B0's");

    // The answer goes in the contract's record carrying the contract's values, or nowhere.
    for (const [name, input] of [["another key", answer("B1_OFFER:MY_OFFER", b1.category, OFFER)], ["unconfirmed", answer(B1_KEY, b1.category, OFFER, { state: "HYPOTHESIS" })], ["empty", answer(B1_KEY, b1.category, "")]] as const) {
      const refused = await s.commit(h, input);
      assert.deepEqual([refused.kind, refused.kind === "HELD" ? refused.code : "—", (refused as { wrote_anything?: boolean }).wrote_anything], ["HELD", "HOLD_UNSUPPORTED_OPERATION", false], `${name}: ${JSON.stringify(refused)}`);
    }
    assert.deepEqual([g.client.writes.length, rowsOf(g.map, G.configDs).length], [0, 0], "every refusal happened before any write");

    const out = await assertStepPersisted(g, await s.commit(h, answer(B1_KEY, b1.category, OFFER)), b1);
    assert.equal(propText(answers(g, B1_KEY)[0] as Page, "Value"), OFFER);
    const moved = await resume(g, await g.bind());
    assert.equal(gateOf(moved), b1.to, JSON.stringify(moved));

    // The seller says the same thing again in another chat: the same key, so the same single row, and no new Run.
    const runsAfter = runs(g);
    const writesAfter = g.client.writes.length;
    const replay = await s.commit(await g.bind(), answer(B1_KEY, b1.category, OFFER));
    assert.equal(replay.kind, "PERSISTED", JSON.stringify(replay));
    assert.deepEqual([(replay as Persisted).repeated, (replay as Persisted).step_moved, (replay as Persisted).writes_sent, (replay as Persisted).plan_id], [true, false, 0, out.plan_id]);
    assert.deepEqual([answers(g, B1_KEY).length, runs(g), g.client.writes.length, propText(cursor(g), "Current Gate")], [1, runsAfter, writesAfter, b1.to], "the cursor moved exactly once");
  } finally { await s.close(); }
});

/* ───────────────────────────── B2…B6 (mirror of PV-B2-002) ───────────────────────────── */

test("PT-COMMIT-002/b2: every specified setup step advances on its own served answer to B7_DRY_RUN, which then holds — the human boundary", async () => {
  const g = world({ gate: "B2_ICP" });
  const s = await session(g);
  try {
    const h = await g.bind();
    await approvedOutsideChat(g, h, await s.tools());
    const steps = walk().filter((t) => !["B0_DISCOVERY", "B1_OFFER"].includes(t.from));
    assert.deepEqual(steps.map((t) => t.from), ["B2_ICP", "B3_DATA", "B4_QUALIFICATION", "B5_OUTREACH", "B6_AUTHORITY"]);
    for (const step of steps) {
      // The chat answers exactly the address the fresh resume serves: no engine change between steps.
      const open = await resume(g, h);
      assert.equal(open.code, "RESUMED", JSON.stringify(open));
      const address = served(open);
      assert.ok(address, `${step.from} is specified, so resume serves its address`);
      assert.deepEqual([address["gate_key"], address["natural_key"], (address["required_values"] as Record<string, unknown>)["Category"]], [step.from, step.key, step.category]);
      await assertStepPersisted(g, await s.commit(h, answer(step.key, step.category, ANSWER)), step);
      if (step.from === "B2_ICP") assert.match(propText(cursor(g), "Next Question") ?? "", /D'où viennent tes comptes/, "the entry writes the next step's question");
    }
    assert.deepEqual(steps.map((t) => answers(g, t.key).length), steps.map(() => 1), "each step has exactly one answer row");
    assert.equal(new Set(steps.map((t) => t.key)).size, steps.length, "five steps, five canonical records, never one row reused");

    // B7_DRY_RUN asserts work was done, not a decision made: no address, and no move.
    const last = await resume(g, h);
    assert.deepEqual([gateOf(last), served(last)], ["B7_DRY_RUN", undefined]);
    const writes = g.client.writes.length;
    const held = await s.commit(h, {});
    assert.deepEqual([held.kind, held.kind === "HELD" ? held.code : "—", (held as { wrote_anything?: boolean }).wrote_anything], ["HELD", "HOLD_GATE_UNSPECIFIED", false], JSON.stringify(held));
    assert.equal(g.client.writes.length, writes);
  } finally { await s.close(); }
});

/* ───────────────────────────── capture (mirror of PV-CAPTURE-001) ───────────────────────────── */

test("PT-COMMIT-002/capture: the first message's answer becomes durable and the step moves in that same call; a replay in a new chat writes no second row", async () => {
  const g = world();
  const s = await session(g);
  try {
    const h = await g.bind();
    await approvedOutsideChat(g, h, await s.tools());
    // Before anything is written there is nothing to resume from: no progress may be claimed.
    assert.equal(answers(g, B0_KEY).length, 0);
    const out = await assertStepPersisted(g, await s.commit(h, b0Answer()), stepOf("B0_DISCOVERY"));
    assert.equal(propText(answers(g, B0_KEY)[0] as Page, "Value"), OUTCOME);
    assert.equal((await resume(g, h)).code, "RESUMED");

    const replay = await s.commit(await g.bind(), b0Answer());
    assert.deepEqual([replay.kind, (replay as Persisted).repeated, (replay as Persisted).writes_sent, (replay as Persisted).plan_id], ["PERSISTED", true, 0, out.plan_id], JSON.stringify(replay));
    assert.equal(answers(g, B0_KEY).length, 1, "replaying the same answer leaves exactly one durable row");
  } finally { await s.close(); }
});

test("PT-COMMIT-002/capture-b: a capture interrupted before its proof is completed from the ledger by the next chat, without duplicating", async () => {
  const g = world();
  const s = await session(g);
  try {
    const h = await g.bind();
    await approvedOutsideChat(g, h, await s.tools());
    const runsBefore = runs(g);
    g.client.fault({ symbol: "TARGET_0" }, "APPLY_THEN_FAIL");
    const first = await s.commit(h, b0Answer());
    assert.deepEqual([first.kind, (first as { failed_symbol?: string }).failed_symbol], ["INTERRUPTED", "TARGET_0"], JSON.stringify(first));
    assert.equal(answers(g, B0_KEY).length, 1, "the answer reached Notion before its proof");
    assert.equal(propText(cursor(g), "Current Gate"), "B0_DISCOVERY");
    const planA = (first as { plan_id: string }).plan_id;

    g.clock.t += 60_000;
    const next = await s.commit(await g.bind(), b0Answer());
    assert.equal(next.kind, "PERSISTED", JSON.stringify(next));
    assert.ok(next.warnings.some((w) => w.includes("completed from the ledger")), JSON.stringify(next.warnings));
    // Recovery issues a new plan continuing the same Run and never adopts the old one: the answer is observed, not
    // written again, and that recovery is proved like any transaction.
    const b = (await g.deps.store.bindings.findByHandleHash(hashHandle(h)))!;
    const plans = await g.deps.store.plans.listByRuntime(b.project, b.lane, b.runtime_generation);
    assert.equal(plans.find((p) => p.plan_id === planA)?.plan_state, "SUPERSEDED");
    const recoveries = plans.filter((p) => p.run_mode === "RECOVER_EXISTING");
    assert.equal(recoveries.length, 1, JSON.stringify(plans.map((p) => [p.run_mode, p.plan_state])));
    const recovery = await proved(g, recoveries[0]!.plan_id);
    const resumed = recovery.stage1_writes.map((w) => w.symbol);
    assert.equal(resumed[0], "RESUME_RUN", JSON.stringify(resumed));
    assert.ok(!resumed.some((sym) => sym.startsWith("TARGET_")), `the durable answer is observed, not written again: ${JSON.stringify(resumed)}`);
    assert.equal(answers(g, B0_KEY).length, 1, "one answer row");
    assert.equal(rowsOf(g.map, R.salesRunsDs).filter((p) => propText(p, "Harness Plan ID") === planA).length, 1, "one Run for the interrupted plan");
    assert.equal(runs(g), runsBefore + 2, "the capture's Run, continued, and the move's own Run — never a second capture Run");
    assert.deepEqual([(next as Persisted).step_moved, propText(cursor(g), "Current Gate")], [true, stepOf("B0_DISCOVERY").to]);
  } finally { await s.close(); }
});

test("PT-COMMIT-002/capture-c: an unknown target, a blank key or an operation outside the approved index is refused before any plan", async () => {
  const g = world();
  const s = await session(g);
  try {
    const h = await g.bind();
    await approvedOutsideChat(g, h, await s.tools());
    const base = b0Answer().intent;
    const invented = await s.commit(h, { intent: { ...base, mutations: [{ ...base.mutations[0], logical_resource_key: "SALES:DISCOVERY_ANSWERS" }] } });
    assert.deepEqual([invented.kind, invented.kind === "HELD" ? invented.code : "—"], ["HELD", "HOLD_RESOURCE_UNKNOWN"], JSON.stringify(invented));
    const blank = await s.commit(h, { intent: { ...base, mutations: [{ ...base.mutations[0], record_selector: { natural_key: "   " } }] } });
    assert.equal(blank.kind, "HELD", JSON.stringify(blank));
    // The approved digest covers the answer's UPSERT only: the same answer as a CREATE matches no approved class.
    const created = await s.commit(h, { intent: { ...base, mutations: [{ ...base.mutations[0], operation: "CREATE" }] } });
    assert.deepEqual([created.kind, created.kind === "HELD" ? created.code : "—", (created as { missing?: Array<{ label: string }> }).missing?.[0]?.label], ["HELD", "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE", "Classe d'opération approuvée"], JSON.stringify(created));
    await assertNothingWritten(g, h, { runs: runs(g), ledger: rowsOf(g.map, R.salesLedgerDs).length, gate: "B0_DISCOVERY" });
  } finally { await s.close(); }
});

/* ───────────────────────────── edit / retry (the UPSERT's existing-record path) ───────────────────────────── */

test("PT-COMMIT-002/edit: at the open step a corrected answer updates its one record and moves the cursor; once the step moved, rewriting it is refused before any write", async () => {
  // An unconfirmed first draft of the B0 answer already sits on its record; the step is still open.
  const g = world({ configs: [configRow("b0-draft", B0_KEY, { category: "GOAL", state: "HYPOTHESIS", value: "Un premier jet", source: "CHAT_USER_EXPLICIT" })] });
  const s = await session(g);
  try {
    const h = await g.bind();
    await approvedOutsideChat(g, h, await s.tools());
    const b0 = stepOf("B0_DISCOVERY");
    const draftId = normalizeId((answers(g, B0_KEY)[0] as Page).id);
    const out = await assertStepPersisted(g, await s.commit(h, b0Answer()), b0, "UPDATE");
    assert.equal(normalizeId(out.targets[0]!.target_ref), draftId, "the UPSERT updates the existing record, never a second row");
    const row = answers(g, B0_KEY)[0] as Page;
    assert.deepEqual([normalizeId(row.id), propText(row, "Value"), propText(row, "State")], [draftId, OUTCOME, "CONFIRMED"]);

    // Same key, same answer, another chat: recognized, nothing written.
    const writes = g.client.writes.length;
    const runsAfter = runs(g);
    const retry = await s.commit(await g.bind(), b0Answer());
    assert.deepEqual([retry.kind, (retry as Persisted).repeated, (retry as Persisted).writes_sent, (retry as Persisted).plan_id], ["PERSISTED", true, 0, out.plan_id], JSON.stringify(retry));

    // Same key, another value, after the cursor moved: the pending step is B1's, so B0's record is not re-opened.
    const late = await s.commit(await g.bind(), b0Answer(`${OUTCOME} (précisé)`));
    assert.deepEqual([late.kind, late.kind === "HELD" ? late.code : "—", (late as { wrote_anything?: boolean }).wrote_anything], ["HELD", "HOLD_UNSUPPORTED_OPERATION", false], JSON.stringify(late));
    assert.deepEqual([g.client.writes.length, runs(g), answers(g, B0_KEY).length, propText(answers(g, B0_KEY)[0] as Page, "Value"), propText(cursor(g), "Current Gate")], [writes, runsAfter, 1, OUTCOME, b0.to]);
  } finally { await s.close(); }
});

/* ───────────────────────────── no approval ⇒ no write ───────────────────────────── */

test("PT-COMMIT-002/no-approval: without the operator's approval no journey writes — not an answer, not a derived move", async () => {
  const cases: Array<[string, () => GuardWorld, Record<string, unknown>]> = [
    ["B0 answer (capture)", () => world(), b0Answer()],
    ["B1 answer", () => world({ gate: "B1_OFFER" }), answer(B1_KEY, stepOf("B1_OFFER").category, OFFER)],
    ["B2 answer", () => world({ gate: "B2_ICP" }), answer(stepOf("B2_ICP").key, stepOf("B2_ICP").category, ANSWER)],
    // The B0 answer already durable: the move the state authorizes is still a new write, and is held.
    ["derived B0 move", () => world({ configs: [configRow("b0", B0_KEY, { category: "GOAL", value: OUTCOME, source: "CHAT_USER_EXPLICIT" })] }), {}],
  ];
  for (const [name, make, input] of cases) {
    const g = make();
    const s = await session(g);
    try {
      const h = await g.bind();
      const before = { runs: runs(g), ledger: rowsOf(g.map, R.salesLedgerDs).length, gate: propText(cursor(g), "Current Gate") as string };
      const out = await s.commit(h, input);
      assert.deepEqual([out.kind, out.kind === "HELD" ? out.code : "—", (out as { phase?: string }).phase, (out as { wrote_anything?: boolean }).wrote_anything], ["HELD", "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE", "PREPARE", false], `${name}: ${JSON.stringify(out)}`);
      assert.equal((out as { missing?: Array<{ label: string }> }).missing?.[0]?.label, NO_APPROVAL, name);
      await assertNothingWritten(g, h, before);
    } finally { await s.close(); }
  }
  // The same derived move, once the operator approves outside the chat, persists and is proved.
  const g = world({ configs: [configRow("b0", B0_KEY, { category: "GOAL", value: OUTCOME, source: "CHAT_USER_EXPLICIT" })] });
  const s = await session(g);
  try {
    const h = await g.bind();
    await approvedOutsideChat(g, h, await s.tools());
    const move = await s.commit(h, {});
    assert.deepEqual([move.kind, (move as Persisted).origin, (move as Persisted).step_moved, (move as Persisted).next_gate], ["PERSISTED", "DERIVED_MOVE", true, stepOf("B0_DISCOVERY").to], JSON.stringify(move));
    await proved(g, (move as Persisted).plan_id, { target: (move as Persisted).target_receipt_id, final: (move as Persisted).final_receipt_id });
    assert.equal(answers(g, B0_KEY).length, 1);
  } finally { await s.close(); }
});
