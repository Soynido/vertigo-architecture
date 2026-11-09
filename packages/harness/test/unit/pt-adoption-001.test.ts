/** W6.1 local D9/D10 authority oracles. No real member, Gmail or runtime proof. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hashHandle } from "../../src/binding/handle.ts";
import { FixtureCrash } from "../../src/notion/fixtureClient.ts";
import { propText, type Page } from "../../src/notion/shapes.ts";
import type { Plan } from "../../src/plans/store.ts";
import { assessRecovery, openRecoveryPlan } from "../../src/recovery/engine.ts";
import { adoptionClass } from "../../src/resume/foreignWrites.ts";
import { SALES_CONTROL_PLANE_0513_CANDIDATE } from "../../src/versions/adapters/controlPlane.ts";
import { dispatch, resolveRuntimeFor } from "../../src/tools/handlers.ts";
import { candidateResume } from "../../src/tools/conduct.ts";
import { dispatchCommit } from "../../src/tools/handlers.ts";
import { G } from "../support/guard-fixtures.ts";
import { R, setRowsIn } from "./resume-fixtures.ts";
import { Deadline } from "../../src/transactions/budget.ts";
import { executeTransaction } from "../../src/transactions/execute.ts";
import { settle } from "../../src/transactions/settle.ts";
import { CLASSES, configRow as fixtureConfigRow, guardWorld, index, b0Intent } from "../support/guard-fixtures.ts";
import { OWNER } from "./binding-fixtures.ts";
import { mutatePage } from "./target-fixtures.ts";

const CONFIG = "SALES:BUSINESS_CONFIG", B6 = "B6_AUTHORITY:SEND_AUTHORITY", B3 = "B3_DATA:CANONICAL_SOURCE";
const fields = (category: string, value = "human approval only") => ({ Category: category, State: "CONFIRMED", Value: value, Version: "SALES_INPUT/1", Source: "CHAT_USER_EXPLICIT" });
// Real Notion pages always carry a revision. The older shared fixture intentionally omits one.
const configRow: typeof fixtureConfigRow = (...args) => ({ ...fixtureConfigRow(...args), last_edited_time: "2030-01-02T00:00:00.000Z" });

async function startedOrdinaryAnswer() {
  const g = guardWorld({ doc: index([], [{ class: "PRODUCTION", resource_key: CONFIG,
    operation: "CREATE", allowed_fields: Object.keys(fields("GOAL")) }]) });
  const h = await g.bind(); await g.approve();
  g.client.onWrite = () => { if (g.client.writes.length === 1) g.clock.t += 40_000; };
  const first = await g.commit(h, b0Intent());
  assert.equal(first.kind, "IN_PROGRESS", JSON.stringify(first));
  delete g.client.onWrite;
  return { g, h, planId: (first as { plan_id: string }).plan_id };
}

test("W7.1/receipt-voice: resume announces its proved ordinary completion before any unapproved cursor move", async () => {
  const { g, h, planId } = await startedOrdinaryAnswer();
  const ctx = () => ({ principal_id: OWNER.principal_id, now: new Date(g.clock.t), candidate_resume: true as const });
  const reply = candidateResume(await dispatch("os_resume", { binding_handle: h }, ctx(), g.deps));
  assert.equal((await g.deps.store.plans.get(planId))?.plan_state, "FINAL_VERIFIED");
  assert.equal(reply.status, "OK", JSON.stringify(reply));
  const final = (await g.deps.store.receipts.findByPlan(planId, "FINAL"))[0]!;
  assert.deepEqual(reply.status === "OK" ? reply.result["ledger_completed"] : undefined,
    [{ plan_id: planId, final_receipt_id: final.receipt_id }]);
  assert.match(reply.say ?? "", /enregistré et vérifié/);
  assert.equal(reply.next.permitted_tool_call, undefined, "acknowledge completion, do not attempt cursor this turn");
  assert.equal(propText(g.map.get(`page:${R.salesStateRow}`) as Page, "Current Gate"), "B0_DISCOVERY");
  const count = g.client.writes.length;
  const next = await dispatch("os_resume", { binding_handle: h }, ctx(), g.deps);
  assert.equal(next.status === "OK" ? next.result["ledger_completed"] : undefined, undefined);
  assert.equal(g.client.writes.length, count, "no replay or duplicated Run");
  const denied = await g.commit(h, {});
  assert.equal(denied.kind, "HELD", "cursor remains unauthorized");
  assert.equal(g.client.writes.length, count);
});

test("W7.1/receipt-voice: invalid or wrong-scope FINAL cannot announce completed recording", async () => {
  for (const fault of ["missing", "invalid", "plan", "principal", "runtime", "generation", "receipt"] as const) {
    const { g, h, planId } = await startedOrdinaryAnswer();
    const get = g.deps.store.receipts.get.bind(g.deps.store.receipts);
    let checkedFinal = false;
    g.deps.store.receipts.get = async id => {
      const receipt = await get(id);
      if (receipt?.type !== "FINAL") return receipt;
      checkedFinal = true;
      if (fault === "missing") return undefined;
      return { ...receipt, ...(fault === "invalid" ? { status: "INVALID" as const }
        : fault === "plan" ? { plan_id: "wrong" } : fault === "principal" ? { principal_id: "wrong" }
        : fault === "runtime" ? { runtime_id: "wrong" } : fault === "generation" ? { runtime_generation: "wrong" }
        : { receipt_id: "wrong" }) };
    };
    const out = await dispatch("os_resume", { binding_handle: h },
      { principal_id: OWNER.principal_id, now: new Date(g.clock.t), candidate_resume: true }, g.deps);
    const body = out.status === "OK" ? out.result : out.observations;
    assert.equal((await g.deps.store.plans.get(planId))?.plan_state, "FINAL_VERIFIED", fault);
    assert.equal(checkedFinal, true, `FINAL proof actually checked: ${fault}`);
    assert.equal(body["ledger_completed"], undefined, fault);
  }
});

test("W6.1/auto: five-tool resume adopts a local orphan silently once, without writing its value", async () => {
  const row = configRow("auto-local", B3, { value: "seller's canonical source", source: "CHAT_USER_EXPLICIT", category: "OTHER" });
  const g = guardWorld({ gate: "B3_DATA", configs: [row], doc: index([], [
    { class: "PRODUCTION", resource_key: CONFIG, operation: "UPDATE", allowed_fields: Object.keys(fields("OTHER")) }, CLASSES.cursor(),
  ]) });
  const h = await g.bind(); await g.approve();
  const ctx = { principal_id: OWNER.principal_id, now: new Date(g.clock.t), candidate_resume: true as const };
  const out = await dispatch("os_resume", { binding_handle: h }, ctx, g.deps);
  assert.equal(out.status, "OK", JSON.stringify(out));
  assert.ok(g.client.writes.length > 0, JSON.stringify(out.status === "OK" ? out.result["durable_hold"] : out));
  assert.equal(out.status === "OK" ? out.result["pending_confirmation"] : undefined, undefined);
  assert.equal(out.status === "OK" ? out.result["durable_hold"] : undefined, undefined, JSON.stringify(out));
  assert.equal(g.client.writes.filter(w => w.target === row.id).length, 0, "the local row is observed, never rewritten");
  const adopted = (await g.deps.store.plans.listByRuntime("VERTIGO", "SALES", (await g.deps.store.bindings.findByHandleHash(hashHandle(h)))!.runtime_generation));
  assert.equal(adopted.length, 1);
  assert.equal(adopted[0]!.plan_origin, "AUTO_RECONCILE");
  assert.equal(adopted[0]!.plan_state, "FINAL_VERIFIED");
  const count = g.client.writes.length;
  const listJournal = g.deps.store.planWrites.list.bind(g.deps.store.planWrites);
  let closedJournalReads = 0;
  g.deps.store.planWrites.list = async id => { closedJournalReads++; return listJournal(id); };
  await dispatch("os_resume", { binding_handle: h }, ctx, g.deps);
  assert.equal(g.client.writes.length, count, "no new Run or repeated adoption on the next request");
  assert.equal(closedJournalReads, 0, "a completed adoption does not replay its write journal on every request");
});

test("W6.1/auto-protected: B6 and company doctrine are held durably without confirmation or new writes", async () => {
  for (const [key, source] of [[B6, "CHAT_USER_EXPLICIT"], [B3, "META_PUBLISHED"]] as const) {
    const row = configRow(`protected-${source}`, key!, { value: "automatic sending or revised doctrine", source, category: key === B6 ? "CONSTRAINT" : "OTHER" });
    const g = guardWorld({ gate: key!.split(":")[0]!, configs: [row], doc: index([], [
      { class: "PRODUCTION", resource_key: CONFIG, operation: "UPDATE", allowed_fields: Object.keys(fields("OTHER")) }, CLASSES.cursor(),
    ]) }), h = await g.bind(); await g.approve();
    const ctx = { principal_id: OWNER.principal_id, now: new Date(g.clock.t), candidate_resume: true as const };
    const first = candidateResume(await dispatch("os_resume", { binding_handle: h }, ctx, g.deps));
    assert.equal(first.status, "OK");
    assert.equal(first.status === "OK" ? (first.result["durable_hold"] as { code?: string })?.code : undefined, "HOLD_CONFLICT", JSON.stringify(first));
    assert.equal(first.ask, undefined);
    assert.equal(first.next.prepare_intent, undefined);
    assert.equal(g.client.writes.length, 0);
    const freshHandle = await g.bind();
    const again = await dispatch("os_resume", { binding_handle: freshHandle }, ctx, g.deps);
    assert.equal(again.status === "OK" ? (again.result["durable_hold"] as { repeated?: boolean })?.repeated : undefined, true);
    assert.equal((await g.deps.store.events.list({ runtime_id: (again.binding !== "UNKNOWN" ? again.binding.runtime_id : ""), event_type: "AUTO_ADOPTION_HELD" })).length, 1);
    assert.equal(g.client.writes.length, 0);
  }
});

test("W6.1/review-B2: a subsequently approved guard resumes the unchanged local observation", async () => {
  const row = configRow("temporary-guard", B3, { value: "local", source: "CHAT_USER_EXPLICIT", category: "OTHER" });
  const g = guardWorld({ gate: "B3_DATA", configs: [row], doc: index([], [
    { class: "PRODUCTION", resource_key: CONFIG, operation: "UPDATE", allowed_fields: Object.keys(fields("OTHER")) }, CLASSES.cursor(),
  ]) }), h = await g.bind();
  const ctx = { principal_id: OWNER.principal_id, now: new Date(g.clock.t), candidate_resume: true as const };
  const refused = await dispatch("os_resume", { binding_handle: h }, ctx, g.deps);
  assert.equal(refused.status, "OK");
  assert.ok(refused.result["durable_hold"]);
  assert.equal(g.client.writes.length, 0);
  assert.equal((await g.deps.store.events.list({ event_type: "AUTO_ADOPTION_HELD" })).length, 0);
  await g.approve();
  const out = await dispatch("os_resume", { binding_handle: h }, ctx, g.deps);
  assert.equal(out.status, "OK");
  assert.equal(out.result["durable_hold"], undefined);
  assert.ok(g.client.writes.length > 0);
  assert.equal(g.client.writes.filter(w => w.target === row.id).length, 0);
});

test("W6.1/auto-foreign: two proved local rows changed outside the harness are adopted in one batch", async () => {
  const a = configRow("auto-a", "NOTES:A", { value: "first", source: "CHAT_USER_EXPLICIT" });
  const b = configRow("auto-b", "NOTES:B", { value: "second", source: "CHAT_USER_EXPLICIT" });
  const g = guardWorld({ gate: "B3_DATA", configs: [a, b], doc: index([], [
    { class: "PRODUCTION", resource_key: CONFIG, operation: "UPDATE", allowed_fields: Object.keys(fields("OTHER")) }, CLASSES.cursor(),
  ]) }), h = await g.bind(); await g.approve();
  const recorded = await dispatchCommit({ binding_handle: h, intent: { action_class: "COMMIT", summary: "two local notes", mutations: [a, b].map(r => ({
    logical_resource_key: CONFIG, operation: "UPDATE", record_selector: { existing_object_id: r.id }, desired_changes: fields("OTHER", propText(r, "Value")),
  })) } }, { principal_id: OWNER.principal_id, now: new Date(g.clock.t) }, g.deps);
  assert.equal(recorded.kind, "PERSISTED", JSON.stringify(recorded));
  mutatePage(g.w, a.id, { Value: "changed first" }, "2030-01-04T00:01:00.000Z");
  mutatePage(g.w, b.id, { Value: "changed second" }, "2030-01-04T00:02:00.000Z");
  const before = g.client.writes.length;
  const out = candidateResume(await dispatch("os_resume", { binding_handle: h }, { principal_id: OWNER.principal_id, now: new Date(g.clock.t), candidate_resume: true }, g.deps));
  assert.equal(out.status, "OK", JSON.stringify(out));
  assert.equal(out.status === "OK" ? out.result["durable_hold"] : undefined, undefined, JSON.stringify(out));
  assert.equal(out.status === "OK" ? out.result["pending_confirmation"] : undefined, undefined);
  assert.equal(out.status === "OK" ? out.result["adoption_notice"] : undefined, undefined, "no notice for a local row alone");
  const writes = g.client.writes.slice(before);
  assert.equal(writes.filter(w => w.target === a.id || w.target === b.id).length, 0);
  assert.equal(writes.filter(w => w.method === "createPage" && w.target === R.salesRunsDs).length, 1, "one Run for both observations");
});

test("W6.1/auto-ceiling: malformed enum is not silently adopted", async () => {
  const row = configRow("bad-enum", B3, { value: "local", source: "CHAT_USER_EXPLICIT", state: "INVENTED" });
  const g = guardWorld({ gate: "B3_DATA", configs: [row], doc: index([], [
    { class: "PRODUCTION", resource_key: CONFIG, operation: "UPDATE", allowed_fields: Object.keys(fields("OTHER")) }, CLASSES.cursor(),
  ]) }), h = await g.bind(); await g.approve();
  const out = await dispatch("os_resume", { binding_handle: h }, { principal_id: OWNER.principal_id, now: new Date(g.clock.t), candidate_resume: true }, g.deps);
  assert.equal(out.status === "OK" ? (out.result["durable_hold"] as { code?: string })?.code : undefined, "HOLD_SCHEMA_MISMATCH", JSON.stringify(out));
  assert.equal(g.client.writes.length, 0);
});

test("W6.1/auto-cursor: justified movement is journaled as-is with one notice, unproved movement writes nothing", async () => {
  const row = configRow("auto-cursor-source", B3, { value: "canonical source", source: "CHAT_USER_EXPLICIT", category: "OTHER" });
  const g = guardWorld({ gate: "B3_DATA", configs: [row], doc: index([], [
    { class: "PRODUCTION", resource_key: CONFIG, operation: "UPDATE", allowed_fields: Object.keys(fields("OTHER")) }, CLASSES.cursor(),
  ]) }), h = await g.bind(); await g.approve();
  mutatePage(g.w, R.salesStateRow, { "Gate Passed By Run Ref": "", "Last Durable Mode": "INTAKE", "Next Authorized Topic": "B3_DATA" }, new Date(g.clock.t).toISOString());
  const cursor = g.map.get(`page:${R.salesStateRow}`) as Page;
  setRowsIn(g.map, R.salesStateDs, [{ ...cursor, properties: { ...cursor.properties, "Last Durable Mode": { type: "select", select: { name: "INTAKE" } } } }]);
  const ctx = { principal_id: OWNER.principal_id, now: new Date(g.clock.t), candidate_resume: true as const };
  await dispatch("os_resume", { binding_handle: h }, ctx, g.deps);
  mutatePage(g.w, R.salesStateRow, { "Current Gate": "B4_QUALIFICATION", "Build State": "B4_QUALIFICATION", "Next Authorized Topic": "B4_QUALIFICATION", "Next Question": "Which criteria?" }, new Date(g.clock.t + 60_000).toISOString());
  const out = candidateResume(await dispatch("os_resume", { binding_handle: h }, ctx, g.deps));
  assert.equal(out.status, "OK");
  assert.equal(out.result["durable_hold"], undefined, JSON.stringify({ hold: out.result["durable_hold"], cursor: out.result["cursor_drift"] }));
  assert.match(out.say ?? "", /progression modifiée dans Notion/);
  const binding = (await g.deps.store.bindings.findByHandleHash(hashHandle(h)))!;
  for (const plan of await g.deps.store.plans.listByRuntime("VERTIGO", "SALES", binding.runtime_generation)) {
    for (const final of await g.deps.store.receipts.findByPlan(plan.plan_id, "FINAL")) {
      const fingerprints = final.observations["cursor_observed"] as Record<string, string>;
      assert.ok(fingerprints);
      assert.ok(Object.values(fingerprints).every(v => /^[a-f0-9]{64}$/.test(v)), "FINAL contains only cursor hashes");
      assert.doesNotMatch(JSON.stringify(final.observations), /Which criteria\?/);
    }
  }
  const repeated = candidateResume(await dispatch("os_resume", { binding_handle: h }, ctx, g.deps));
  assert.doesNotMatch(repeated.say ?? "", /progression modifiée dans Notion/);
  mutatePage(g.w, R.salesStateRow, { "Current Gate": "B5_OUTREACH", "Build State": "B5_OUTREACH" }, new Date(g.clock.t + 120_000).toISOString());
  const count = g.client.writes.length;
  const unjustified = await dispatch("os_resume", { binding_handle: h }, ctx, g.deps);
  assert.equal(unjustified.code, "HOLD_STATE_DIVERGENCE");
  assert.equal(g.client.writes.length, count);
});

test("W6.1/review-B1: same-revision cursor movement during guard reads cannot attest the earlier walk", async () => {
  const row = configRow("cursor-race-source", B3, { value: "local source", source: "CHAT_USER_EXPLICIT", category: "OTHER" });
  const g = guardWorld({ gate: "B3_DATA", configs: [row], doc: index([], [
    { class: "PRODUCTION", resource_key: CONFIG, operation: "UPDATE", allowed_fields: Object.keys(fields("OTHER")) }, CLASSES.cursor(),
  ]) }), h = await g.bind(); await g.approve();
  mutatePage(g.w, R.salesStateRow, { "Gate Passed By Run Ref": "", "Last Durable Mode": "INTAKE", "Next Authorized Topic": "B3_DATA" }, new Date(g.clock.t).toISOString());
  const cursor = g.map.get(`page:${R.salesStateRow}`) as Page;
  setRowsIn(g.map, R.salesStateDs, [{ ...cursor, properties: { ...cursor.properties, "Last Durable Mode": { type: "select", select: { name: "INTAKE" } } } }]);
  const ctx = { principal_id: OWNER.principal_id, now: new Date(g.clock.t), candidate_resume: true as const };
  await dispatch("os_resume", { binding_handle: h }, ctx, g.deps);
  mutatePage(g.w, R.salesStateRow, { "Current Gate": "B4_QUALIFICATION", "Build State": "B4_QUALIFICATION", "Next Authorized Topic": "B4_QUALIFICATION" }, new Date(g.clock.t + 60_000).toISOString());
  const readApproval = g.deps.store.guardApprovals!.get.bind(g.deps.store.guardApprovals!);
  let once = true;
  g.deps.store.guardApprovals!.get = async id => {
    if (once) {
      once = false;
      mutatePage(g.w, R.salesStateRow, { "Current Gate": "B5_OUTREACH", "Build State": "B5_OUTREACH", "Next Authorized Topic": "B5_OUTREACH" }, new Date(g.clock.t + 60_000).toISOString());
    }
    return readApproval(id);
  };
  const count = g.client.writes.length;
  const out = await dispatch("os_resume", { binding_handle: h }, ctx, g.deps);
  assert.equal(out.status, "OK");
  assert.equal(out.result["adoption_in_progress"], true, JSON.stringify({ hold: out.result["durable_hold"] }));
  assert.equal(g.client.writes.length, count);
  assert.equal((await g.deps.store.events.list({ event_type: "AUTO_ADOPTION_HELD" })).length, 0);
  const reobserved = await dispatch("os_resume", { binding_handle: h }, ctx, g.deps);
  assert.equal(reobserved.code, "HOLD_STATE_DIVERGENCE");
  assert.equal(g.client.writes.length, count);
});

test("W6.1/review-B1b: same-revision local row changes after observation require fresh classification", async () => {
  const row = configRow("source-race", B3, { value: "local source", source: "CHAT_USER_EXPLICIT", category: "OTHER" });
  const g = guardWorld({ gate: "B3_DATA", configs: [row], doc: index([], [
    { class: "PRODUCTION", resource_key: CONFIG, operation: "UPDATE", allowed_fields: Object.keys(fields("OTHER")) }, CLASSES.cursor(),
  ]) }), h = await g.bind(); await g.approve();
  const ctx = { principal_id: OWNER.principal_id, now: new Date(g.clock.t), candidate_resume: true as const };
  await dispatch("os_resume", { binding_handle: h }, ctx, g.deps);
  const revision = new Date(g.clock.t + 60_000).toISOString();
  mutatePage(g.w, row.id, { Value: "edited local source" }, revision);
  const readApproval = g.deps.store.guardApprovals!.get.bind(g.deps.store.guardApprovals!);
  let once = true;
  g.deps.store.guardApprovals!.get = async id => {
    if (once) { once = false; mutatePage(g.w, row.id, { Source: "META_PUBLISHED" }, revision); }
    return readApproval(id);
  };
  const count = g.client.writes.length;
  const raced = await dispatch("os_resume", { binding_handle: h }, ctx, g.deps);
  assert.equal(raced.status, "OK");
  assert.equal(raced.result["adoption_in_progress"], true);
  assert.equal(g.client.writes.length, count);
  assert.equal((await g.deps.store.events.list({ event_type: "AUTO_ADOPTION_HELD" })).length, 0);
  const current = await dispatch("os_resume", { binding_handle: h }, ctx, g.deps);
  assert.equal(current.status, "OK");
  assert.equal((current.result["durable_hold"] as { code: string }).code, "HOLD_CONFLICT");
  assert.equal(g.client.writes.length, count);
});

test("W6.1/auto-recovery: crash, expiry and new chat continue the same adoption without duplicate Run or target write", async () => {
  const row = configRow("auto-crash", B3, { value: "local source", source: "CHAT_USER_EXPLICIT", category: "OTHER" });
  const g = guardWorld({ gate: "B3_DATA", configs: [row], doc: index([], [
    { class: "PRODUCTION", resource_key: CONFIG, operation: "UPDATE", allowed_fields: Object.keys(fields("OTHER")) }, CLASSES.cursor(),
  ]) }), h = await g.bind(); await g.approve();
  g.client.fault({ nth: 1 }, "CRASH_AFTER");
  await assert.rejects(dispatch("os_resume", { binding_handle: h }, { principal_id: OWNER.principal_id, now: new Date(g.clock.t), candidate_resume: true }, g.deps), FixtureCrash);
  g.clock.t += 20 * 60_000;
  const fresh = await g.bind();
  const resumed = await dispatch("os_resume", { binding_handle: fresh }, { principal_id: OWNER.principal_id, now: new Date(g.clock.t), candidate_resume: true }, g.deps);
  assert.equal(resumed.status, "OK", JSON.stringify({ code: resumed.code, hold: resumed.observations["durable_hold"], plans: (await g.deps.store.plans.listByRuntime("VERTIGO", "SALES", (await g.deps.store.bindings.findByHandleHash(hashHandle(fresh)))!.runtime_generation)).map(p => [p.plan_state, p.plan_origin]), events: (await g.deps.store.events.list({ event_type: "AUTO_WORK_HELD" })).map(e => [e.result, e.detail]) }));
  assert.equal(resumed.status === "OK" ? resumed.result["durable_hold"] : undefined, undefined, JSON.stringify(resumed.status === "OK" ? resumed.result["durable_hold"] : resumed));
  assert.equal(g.client.writes.filter(w => w.method === "createPage" && w.target === R.salesRunsDs).length, 1);
  assert.equal(g.client.writes.filter(w => w.target === row.id).length, 0);
  const count = g.client.writes.length;
  await dispatch("os_resume", { binding_handle: fresh }, { principal_id: OWNER.principal_id, now: new Date(g.clock.t), candidate_resume: true }, g.deps);
  assert.equal(g.client.writes.length, count);
});

test("W6.1/auto-matrix: every lost response is resumed without duplicate Run, ledger or target mutation", async t => {
  const world = async () => {
    const row = configRow("auto-matrix", B3, { value: "seller-local source", source: "CHAT_USER_EXPLICIT", category: "OTHER" });
    const g = guardWorld({ gate: "B3_DATA", configs: [row], doc: index([], [
      { class: "PRODUCTION", resource_key: CONFIG, operation: "UPDATE", allowed_fields: Object.keys(fields("OTHER")) }, CLASSES.cursor(),
    ]) }), h = await g.bind(); await g.approve(); return { g, h, row };
  };
  const probe = await world();
  await dispatch("os_resume", { binding_handle: probe.h }, { principal_id: OWNER.principal_id, now: new Date(probe.g.clock.t), candidate_resume: true }, probe.g.deps);
  for (let nth = 1; nth <= probe.g.client.writes.length; nth++) for (const fault of ["CRASH_BEFORE", "CRASH_AFTER"] as const) await t.test(`${nth}/${fault}`, async () => {
    const { g, h, row } = await world(); g.client.fault({ nth }, fault);
    await assert.rejects(dispatch("os_resume", { binding_handle: h }, { principal_id: OWNER.principal_id, now: new Date(g.clock.t), candidate_resume: true }, g.deps), FixtureCrash);
    g.clock.t += 20 * 60_000; const fresh = await g.bind();
    const out = await dispatch("os_resume", { binding_handle: fresh }, { principal_id: OWNER.principal_id, now: new Date(g.clock.t), candidate_resume: true }, g.deps);
    assert.equal(out.status, "OK", JSON.stringify({ code: out.code, hold: out.observations["durable_hold"] }));
    assert.equal(out.result["durable_hold"], undefined, JSON.stringify(out.result["durable_hold"]));
    const liveRuns = (g.map.get(`query:${R.salesRunsDs}`) as { results: Page[] }).results.filter(r => propText(r, "Harness Plan ID"));
    const liveLedger = (g.map.get(`query:${R.salesLedgerDs}`) as { results: Page[] }).results.filter(r => propText(r, "Harness Plan ID"));
    assert.equal(liveRuns.length, 1, "one durable Run, even when the response was lost");
    assert.equal(liveLedger.length, 1, "one durable ledger for the observed local row");
    assert.equal(g.client.writes.filter(w => w.target === row.id).length, 0);
    const successfulWrites = g.client.writes.filter(w => w.applied.length);
    assert.equal(successfulWrites.at(-1)?.target, R.salesStateRow, "State is last");
  });
});

test("W6.1/auto-identity: edited identity or published Source cannot upgrade a proved local row", async () => {
  for (const changes of [{ "Config Item": B6 }, { Source: "META_PUBLISHED" }]) {
    const row = configRow("auto-identity", B3, { value: "local", source: "CHAT_USER_EXPLICIT", category: "OTHER" });
    const g = guardWorld({ gate: "B3_DATA", configs: [row], doc: index([], [
      { class: "PRODUCTION", resource_key: CONFIG, operation: "UPDATE", allowed_fields: Object.keys(fields("OTHER")) }, CLASSES.cursor(),
    ]) }), h = await g.bind(); await g.approve();
    await dispatch("os_resume", { binding_handle: h }, { principal_id: OWNER.principal_id, now: new Date(g.clock.t), candidate_resume: true }, g.deps);
    mutatePage(g.w, row.id, { ...changes, Value: "a changed value" }, new Date(g.clock.t + 60_000).toISOString());
    const count = g.client.writes.length;
    const out = await dispatch("os_resume", { binding_handle: h }, { principal_id: OWNER.principal_id, now: new Date(g.clock.t), candidate_resume: true }, g.deps);
    assert.equal(out.status, "OK");
    assert.equal((out.result["durable_hold"] as { code?: string })?.code, "HOLD_CONFLICT");
    assert.equal(g.client.writes.length, count);
  }
});

async function interrupted(key: string, o: { byId?: boolean; source?: string } = {}) {
  const category = key === B6 ? "CONSTRAINT" : "OTHER";
  const row = configRow("adoption", key, { value: "before", category, source: o.source ?? "CHAT_USER_EXPLICIT" });
  const g = guardWorld({ gate: key.split(":")[0]!, configs: [row], doc: index([], [
    { class: "PRODUCTION", resource_key: CONFIG, operation: "UPDATE", allowed_fields: Object.keys(fields(category)) }, CLASSES.cursor(),
  ]) });
  const h = await g.bind(); await g.approve();
  const out = await dispatch("os_prepare", { binding_handle: h, intent: { action_class: "COMMIT", summary: "one canonical answer", mutations: [{
    logical_resource_key: CONFIG, operation: "UPDATE", record_selector: o.byId ? { existing_object_id: row.id } : { natural_key: key }, desired_changes: fields(category),
  }] } }, { principal_id: OWNER.principal_id, now: new Date(g.clock.t) }, g.deps);
  assert.equal(out.code, "PLAN_PREPARED", JSON.stringify(out));
  assert.equal(out.status, "OK");
  const plan = (await g.deps.store.plans.get(out.status === "OK" ? out.result["plan_id"] as string : "")) as Plan;
  const binding = (await g.deps.store.bindings.findByHandleHash(hashHandle(h)))!;
  const resolved = await resolveRuntimeFor(g.deps, OWNER, "VERTIGO", "SALES");
  assert.equal(resolved.kind, "RESOLVED", JSON.stringify(resolved));
  const runtime = (resolved as { runtime: import("../../src/resolvers/types.ts").ResolvedRuntime }).runtime;
  const ctx = { principal_id: OWNER.principal_id, binding, runtime, cursor_ref: plan.state_last_write.target_ref,
    deadline: new Deadline(() => g.clock.t), clock: () => new Date(g.clock.t), sleep: async () => {} };
  g.client.fault({ symbol: plan.stage1_writes.find(w => w.purpose === "WRITE_TARGET")!.symbol }, "CRASH_AFTER");
  await assert.rejects(executeTransaction(g.deps, { ...ctx, plan_id: plan.plan_id }), FixtureCrash);
  return { g, row, plan, runtime, ctx };
}

test("W6.1/a: B6 Value conflict cannot expand send authority, by key or object ID; hold is durable and not retried", async () => {
  for (const byId of [false, true]) {
    const s = await interrupted(B6, { byId });
    mutatePage(s.g.w, s.row.id, { Value: "agent may send automatically", Source: "CHAT_USER_EXPLICIT", Category: "OTHER" }, "2030-01-03T00:40:00.000Z");
    s.g.clock.t += 20 * 60_000;
    const writes = s.g.client.writes.length;
    const report = await settle(s.g.deps, { ...s.ctx, deadline: new Deadline(() => s.g.clock.t) });
    assert.equal(report.durable_hold?.code, "HOLD_CONFLICT", JSON.stringify(report));
    assert.equal(s.g.client.writes.length, writes, "no Notion write or cursor progression on an authority conflict");
    assert.equal(propText(s.g.map.get(`page:${s.row.id}`) as Page, "Value"), "agent may send automatically");
    const repeated = await settle(s.g.deps, { ...s.ctx, deadline: new Deadline(() => s.g.clock.t) });
    assert.equal(repeated.durable_hold?.repeated, true, JSON.stringify(repeated));
    assert.equal(s.g.client.writes.length, writes);
  }
});

test("W6.1/b: a canonical seller-local Value conflict stays adoptable under D10", async () => {
  const s = await interrupted(B3);
  mutatePage(s.g.w, s.row.id, { Value: "seller's revised source" }, "2030-01-03T00:40:00.000Z");
  const assessed = await assessRecovery(s.g.deps, s.runtime, s.plan, { journal: await s.g.deps.store.planWrites.list(s.plan.plan_id), conflictPolicy: "D10" });
  assert.equal(assessed.kind, "RECOVERABLE", JSON.stringify(assessed));
  assert.equal(assessed.ops?.[0]?.kind, "ADOPTED");
});

test("W6.1/c: an earlier published source cannot be relabelled into a local D10 edit", async () => {
  const s = await interrupted(B3, { source: "META_PUBLISHED" });
  mutatePage(s.g.w, s.row.id, { Value: "edited doctrine", Source: "CHAT_USER_EXPLICIT" }, "2030-01-03T00:40:00.000Z");
  const assessed = await assessRecovery(s.g.deps, s.runtime, s.plan, { journal: await s.g.deps.store.planWrites.list(s.plan.plan_id), conflictPolicy: "D10" });
  assert.equal(assessed.kind, "HOLD", JSON.stringify(assessed));
  assert.notEqual(assessed.ops?.[0]?.kind, "ADOPTED");
});

test("W6.1/c2: D10 cannot turn an interrupted local row into published doctrine", async () => {
  const s = await interrupted(B3);
  mutatePage(s.g.w, s.row.id, { Value: "fake published doctrine", Source: "META_PUBLISHED" }, "2030-01-03T00:40:00.000Z");
  const assessed = await assessRecovery(s.g.deps, s.runtime, s.plan, { journal: await s.g.deps.store.planWrites.list(s.plan.plan_id), conflictPolicy: "D10" });
  assert.equal(assessed.kind, "HOLD");
});

test("W6.1/d: RECONCILE cannot attest an unproved B6 authority row even with empty desired changes", async () => {
  const row = configRow("foreign-authority", B6, { value: "automatic sending", source: "CHAT_USER_EXPLICIT" });
  const g = guardWorld({ gate: "B6_AUTHORITY", configs: [row] }), h = await g.bind();
  const out = await dispatch("os_prepare", { binding_handle: h, intent: { action_class: "RECONCILE", summary: "adopt as-is", mutations: [{
    logical_resource_key: CONFIG, operation: "UPDATE", record_selector: { existing_object_id: row.id }, desired_changes: {},
  }] } }, { principal_id: OWNER.principal_id, now: new Date(g.clock.t) }, g.deps);
  assert.equal(out.status, "HOLD", JSON.stringify(out));
  assert.equal(g.client.writes.length, 0);
  assert.equal((await g.deps.store.plans.findActive("VERTIGO", "SALES", (await g.deps.store.bindings.findByHandleHash(hashHandle(h)))!.runtime_generation)).length, 0);
});

test("W6.1/e: the closed classifier separates four authorities; unknown resources are not local by default", () => {
  const grammar = SALES_CONTROL_PLANE_0513_CANDIDATE;
  for (const field of ["Do Not Contact", "DNC", "Opt Out", "Send Authority", "Approval State"])
    assert.equal(adoptionClass(grammar, CONFIG, B3, field, { Source: "CHAT_USER_EXPLICIT" }), "SECURITY_AUTHORITY", field);
  assert.equal(adoptionClass(grammar, CONFIG, B6, "Value", { Source: "CHAT_USER_EXPLICIT" }), "SECURITY_AUTHORITY");
  for (const resource of ["SALES:INTERACTIONS", "SALES:RECEIPTS", "SALES:CAPABILITY_PROOFS"])
    assert.equal(adoptionClass(grammar, resource, "fact", "Value", {}), "EXTERNAL_FACT", resource);
  assert.equal(adoptionClass(grammar, CONFIG, B3, "Value", { Source: "META_PUBLISHED" }), "COMPANY_DOCTRINE");
  assert.equal(adoptionClass(grammar, CONFIG, B3, "Value", { Source: "CHAT_USER_EXPLICIT" }), "LOCAL_USER");
  assert.equal(adoptionClass(grammar, CONFIG, B3, "Value", {}), undefined, "missing prior authority is not guessed from today's Source");
  assert.equal(adoptionClass(grammar, CONFIG, B3, "Value", { Source: null }), undefined);
  assert.equal(adoptionClass(grammar, CONFIG, B3, "Value", { Source: "UNCLASSIFIED" }), undefined);
  assert.equal(adoptionClass(grammar, "UNKNOWN", "row", "Value", {}), undefined);
});

test("W6.1/f: D10 does not adopt a local row outside its live enum ceiling", async () => {
  const s = await interrupted(B3);
  mutatePage(s.g.w, s.row.id, { Value: "new source", State: "UNDECLARED_OPTION" }, "2030-01-03T00:40:00.000Z");
  const writes = s.g.client.writes.length;
  const assessed = await assessRecovery(s.g.deps, s.runtime, s.plan, { journal: await s.g.deps.store.planWrites.list(s.plan.plan_id), conflictPolicy: "D10" });
  assert.equal(assessed.kind, "HOLD", JSON.stringify(assessed));
  assert.notEqual(assessed.ops?.[0]?.kind, "ADOPTED");
  assert.equal(s.g.client.writes.length, writes);
});

test("W6.1/g: rejected adoption never exposes business values through recovery evidence or public observations", async () => {
  const s = await interrupted(B6), secret = "PRIVATE_SENDING_AUTHORITY_7615";
  mutatePage(s.g.w, s.row.id, { Value: secret }, "2030-01-03T00:40:00.000Z");
  s.g.clock.t += 20 * 60_000;
  const recovered = await openRecoveryPlan(s.g.deps, s.ctx.binding, s.runtime, s.plan, {
    now: new Date(s.g.clock.t), conflictPolicy: "D10", journal: await s.g.deps.store.planWrites.list(s.plan.plan_id),
    governing: { spec: s.plan.governing_spec_version, schema: s.plan.governing_schema_version, control: s.plan.governing_control_version },
  });
  assert.equal(recovered.kind, "HOLD");
  assert.equal(JSON.stringify(recovered).includes(secret), false);
});
