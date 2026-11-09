import { test } from "node:test";
import assert from "node:assert/strict";
import { driveCapabilityCommit, preparedCapabilityDraft } from "./probe-w47-budget.mjs";

const expiresAt = "2030-01-01T00:10:00.000Z";
const T0 = Date.parse("2030-01-01T00:00:00.000Z");
const pending = { kind: "IN_PROGRESS", reason: "BUDGET", phase: "STAGE1" };
const progress = (settled_writes = 0, verified_receipts = 0) => ({ settled_writes, verified_receipts });

test("zero durable progress stops after one call, even if a plan was created", async () => {
  let calls = 0;
  const r = await driveCapabilityCommit({ call: async () => { calls++; return pending; },
    progress: async () => progress(), expiresAt, clock: () => T0 });
  assert.equal(calls, 1); assert.equal(r.stopped_at, "NO_DURABLE_PROGRESS");
});

test("same closure continues only after settled writes and stops at PERSISTED", async () => {
  let calls = 0, settled = 0;
  const r = await driveCapabilityCommit({ call: async () => { calls++; settled++; return calls === 2 ? { kind: "PERSISTED" } : pending; },
    progress: async () => progress(settled), expiresAt, clock: () => T0 });
  assert.equal(calls, 2); assert.equal(r.stopped_at, "PERSISTED");
});

test("verified TARGET/FINAL receipt is durable progress at a write boundary", async () => {
  let calls = 0, receipts = 0;
  const r = await driveCapabilityCommit({ call: async () => { calls++; receipts++; return calls === 2 ? { kind: "PERSISTED" } : pending; },
    progress: async () => progress(0, receipts), expiresAt, clock: () => T0 });
  assert.equal(calls, 2); assert.equal(r.stopped_at, "PERSISTED");
});

test("hard six-call ceiling even when every call advances", async () => {
  let n = 0;
  const r = await driveCapabilityCommit({ call: async () => { n++; return pending; },
    progress: async () => progress(n), expiresAt, clock: () => T0 });
  assert.equal(n, 6); assert.equal(r.stopped_at, "CALL_LIMIT");
});

test("expired, invalid or progress-read-expired challenge calls nothing", async () => {
  for (const expiry of [expiresAt, "invalid"]) {
    const r = await driveCapabilityCommit({ call: async () => { assert.fail("no expired call"); },
      progress: async () => progress(), expiresAt: expiry, clock: () => Date.parse(expiresAt) });
    assert.equal(r.stopped_at, "EXPIRED");
  }
  let time = T0;
  const r = await driveCapabilityCommit({ call: async () => { assert.fail("inspection exhausted TTL"); },
    progress: async () => { time = Date.parse(expiresAt); return progress(); }, expiresAt, clock: () => time });
  assert.equal(r.stopped_at, "EXPIRED");
});

test("HELD, interruption, index lag and claimed elsewhere never retry", async () => {
  for (const reply of [{ kind: "HELD" }, { kind: "INTERRUPTED" }, { ...pending, reason: "INDEX_LAG" }, { ...pending, reason: "CLAIMED_ELSEWHERE" }]) {
    let n = 0;
    const r = await driveCapabilityCommit({ call: async () => { n++; return reply; },
      progress: async () => progress(n), expiresAt, clock: () => T0 });
    assert.equal(n, 1); assert.equal(r.stopped_at, "REFUSED_OR_INTERRUPTED");
  }
});

function draftFixture() {
  const binding = { binding_id: "binding", principal_id: "principal", project: "VERTIGO", lane: "SALES",
    runtime_logical_key: "sales/me", runtime_id: "canary", runtime_generation: "gen", expires_at: expiresAt,
    governing_versions_snapshot: { spec: "spec", schema: "schema", control: "UNKNOWN" } };
  const values = Object.fromEntries(["Capability Proof", "Capability Proof Key", "Capability Key", "State", "Runtime ID",
    "Principal Key", "Operating Mode", "Competent Source", "Evidence Ref", "Verified At", "Scope"].map((f) => [f, f]));
  Object.assign(values, { State: "READ_VERIFIED", "Capability Proof Key": "proof-key" });
  const instruction = (symbol, ordinal, operation = "CREATE") => ({ symbol, ordinal, operation, target_ref: `target:${symbol}` });
  const plan = { ...binding, plan_id: "plan", plan_kind: "BUSINESS", plan_state: "AWAITING_STAGE1_WRITES", plan_origin: "INTENT",
    run_mode: "OPEN_NEW", governing_spec_version: "spec", governing_schema_version: "schema", governing_control_version: "UNKNOWN",
    operations: [{ operation: "CREATE", logical_resource_key: "SALES:CAPABILITY_PROOFS", natural_key: "proof-key",
      natural_key_property: "Capability Proof Key", expected_values: values }],
    stage1_writes: [instruction("run", 0), instruction("prepare", 1), instruction("target", 2), instruction("written", 3, "UPDATE")],
    finalization_writes: [instruction("verified", 4, "UPDATE"), instruction("final", 5, "UPDATE")],
    state_last_write: instruction("state", 6, "UPDATE") };
  const writes = [...plan.stage1_writes.map((w) => ({ ...w, phase: "STAGE1" })),
    ...plan.finalization_writes.map((w) => ({ ...w, phase: "FINALIZATION" })), { ...plan.state_last_write, phase: "STATE_LAST" }]
    .map((w) => ({ ...w, plan_id: "plan", status: "PENDING", attempts: 0 }));
  return { binding, plan, writes, expected: { natural_key: "proof-key", values }, now: T0 };
}

test("prepared capability requires exact owned pins/fields and complete untouched journal", () => {
  assert.deepEqual(preparedCapabilityDraft(draftFixture()), { plan_id: "plan", expires_at: expiresAt });
  for (const mutate of [
    (f) => { f.plan.binding_id = "foreign"; }, (f) => { f.plan.runtime_generation = "foreign"; },
    (f) => { f.plan.governing_schema_version = "other"; }, (f) => { f.plan.plan_origin = "AUTO_RECOVERY"; },
    (f) => { f.plan.expires_at = "invalid"; }, (f) => { f.binding.expires_at = "invalid"; },
    (f) => { f.plan.expires_at = new Date(T0).toISOString(); }, (f) => { f.writes.pop(); },
    (f) => { f.writes = []; }, (f) => { f.writes[1] = { ...f.writes[0] }; },
    (f) => { f.writes[0].attempts = 1; }, (f) => { f.writes[0].status = "SENT"; },
    (f) => { f.writes[0].target_ref = "foreign"; }, (f) => { f.writes[0].payload_hash = "started"; },
    (f) => { f.plan.operations[0].logical_resource_key = "SALES:TASKS"; },
    (f) => { f.plan.operations[0].expected_values = { ...f.expected.values, Scope: "foreign" }; },
    (f) => { delete f.expected.values["Evidence Ref"]; }, (f) => { f.expected.values.extra = "new authority"; },
  ]) { const f = structuredClone(draftFixture()); mutate(f); assert.equal(preparedCapabilityDraft(f), undefined); }
});

test("one exact prepared handoff is distinct from writes; second zero-progress stops", async () => {
  let n = 0; const reports = [];
  const draft = preparedCapabilityDraft(draftFixture());
  const r = await driveCapabilityCommit({ call: async () => { n++; return { ...pending, plan_id: "plan", writes_done: 0 }; },
    progress: async () => ({ ...progress(), active_plan_ids: n ? ["plan"] : [], prepared_capability: n ? draft : undefined }),
    expiresAt, clock: () => T0, report: (r) => reports.push(r) });
  assert.equal(n, 2); assert.equal(r.stopped_at, "NO_DURABLE_PROGRESS");
  assert.equal(reports.filter((r) => r.prepared_handoff).length, 1);
});

test("no handoff for preexisting/foreign/missing/expired draft or post-read challenge expiry", async () => {
  for (const mode of ["preexisting", "wrong_reply", "missing_count", "multiple", "missing_draft", "expired_plan", "expired_challenge"]) {
    let n = 0, time = T0;
    const r = await driveCapabilityCommit({ call: async () => { n++; return { ...pending, plan_id: mode === "wrong_reply" ? "foreign" : "plan",
      ...(mode === "missing_count" ? {} : { writes_done: 0 }) }; },
      progress: async () => {
        if (n && mode === "expired_challenge") time = Date.parse(expiresAt);
        return { ...progress(), active_plan_ids: n ? (mode === "multiple" ? ["plan", "other"] : ["plan"]) : (mode === "preexisting" ? ["plan"] : []),
          prepared_capability: mode === "missing_draft" ? undefined : { plan_id: "plan", expires_at: mode === "expired_plan" ? new Date(T0).toISOString() : expiresAt } };
      }, expiresAt, clock: () => time });
    assert.equal(n, 1); assert.equal(r.stopped_at, mode === "expired_challenge" ? "EXPIRED" : "NO_DURABLE_PROGRESS");
  }
});
