/** PT-PREP-006, W3.3L: deterministic stored backend instructions; historical native rendering frozen at 31f8087. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../../src/tools/handlers.ts";
import { transition } from "../../src/plans/service.ts";
import { resolveInstruction } from "../../src/transactions/write.ts";
import { encodeProperty } from "../../src/notion/properties.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import type { WriteInstruction } from "../../src/plans/store.ts";
import { handleOf, OWNER, T0 } from "./binding-fixtures.ts";
import { buildResumeWorld, META_MANIFEST_DS, R } from "./resume-fixtures.ts";
import { ID as META_ID, synthetic } from "./meta-fixtures.ts";

const ctx = { principal_id: OWNER.principal_id, now: T0 };
const intent = { action_class: "COMMIT", summary: "set the next frame question", mutations: [{ logical_resource_key: "META:GATES", operation: "UPDATE" as const, record_selector: { natural_key: "T1" }, desired_changes: { "Next Question": "What is the offer?" } }] };
type Prepared = { plan_id: string; execution_attempt_id: string; stage1_writes: WriteInstruction[]; operations: unknown[]; stage1_actions?: unknown };
const normalize = (x: unknown, p: Prepared): string => JSON.stringify(x).split(p.plan_id).join("<PLAN_ID>").split(p.execution_attempt_id).join("<ATTEMPT>");

test("PT-PREP-006: identical baseline produces identical ordered backend instructions; strict resolution; no native actions", async () => {
  const w = buildResumeWorld();
  const h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps));
  const first = await dispatch("os_prepare", { binding_handle: h, intent }, ctx, w.deps);
  assert.equal(first.code, "PLAN_PREPARED", JSON.stringify(first));
  const a = (first as Extract<Envelope, { status: "OK" }>).result as Prepared;
  await transition(w.deps.store, a.plan_id, "ABORTED", T0);
  const second = await dispatch("os_prepare", { binding_handle: h, intent }, ctx, w.deps);
  assert.equal(second.code, "PLAN_PREPARED");
  const b = (second as Extract<Envelope, { status: "OK" }>).result as Prepared;
  assert.notEqual(b.plan_id, a.plan_id);
  assert.equal(normalize(b.operations, b), normalize(a.operations, a));
  assert.equal(normalize(b.stage1_writes, b), normalize(a.stage1_writes, a));
  assert.equal(a.stage1_actions, undefined);
  assert.equal(b.stage1_actions, undefined);
  assert.deepEqual(a.stage1_writes.map((s) => s.purpose), ["OPEN_RUN", "PREPARE_LEDGER", "WRITE_TARGET", "LEDGER_WRITTEN"]);
  assert.deepEqual(a.stage1_writes.map((s) => s.operation), ["CREATE", "CREATE", "UPDATE", "UPDATE"]);
  assert.deepEqual(a.stage1_writes.map((s) => s.target_ref), [R.metaRunsDs, R.metaLedgerDs, R.gateM1, "$created:LEDGER_0"]);
  for (const s of a.stage1_writes) {
    assert.notEqual(s.purpose, "STATE_LAST");
    assert.notEqual(s.target_ref, META_ID.manifest);
    assert.notEqual(s.target_ref, META_MANIFEST_DS);
  }
  const open = a.stage1_writes[0]!;
  assert.equal(open.fields["Status"], "RUNNING");
  assert.equal(open.fields["Origin"], "PLUGIN");
  assert.equal(open.fields["Mutation Count"], 1);
  assert.equal(open.fields["Harness Plan ID"], a.plan_id);
  assert.equal(a.stage1_writes[1]!.fields["Run Ref"], "$created:OPEN_RUN");
  assert.deepEqual(a.stage1_writes[2]!.fields, { "Next Question": "What is the offer?" });
  assert.deepEqual(a.stage1_writes[3]!.fields, { Status: "WRITTEN" });
  const unresolved = resolveInstruction(a.stage1_writes[1]!, { created: {}, now: T0 });
  assert.equal(unresolved.ok, false, "unbound symbols never become connector text");
  const plan = (await w.deps.store.plans.get(b.plan_id))!;
  assert.deepEqual(plan.finalization_writes.map((s) => s.purpose), ["LEDGER_VERIFIED", "FINALIZE_RUN"]);
  assert.equal(plan.finalization_writes[0]!.fields["Target Receipt ID"], "$receipt:TARGET");
  assert.ok(plan.state_last_write.ordinal > plan.finalization_writes.at(-1)!.ordinal);
  assert.equal(plan.state_last_write.target_ref, META_ID.manifest);
  assert.equal(plan.state_last_write.fields["Last Run Ref"], "$created:OPEN_RUN");
  const resolved = resolveInstruction(plan.state_last_write, { created: { OPEN_RUN: synthetic("backend-run"), LEDGER_0: synthetic("backend-ledger") }, target_receipt_id: "receipt", now: T0 });
  assert.ok(resolved.ok, JSON.stringify(resolved));
  const date = resolved.instruction.fields["Last Verified At"];
  assert.deepEqual(encodeProperty("date", date), { ok: true, value: { date: { start: date } } });
  assert.equal("method" in resolved.instruction, false);
});
