/** End-to-end FINAL recovery at the real six-tool boundary (the store-only crash tests live in PT-INST-035/036). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../../src/tools/handlers.ts";
import type { Plan } from "../../src/plans/store.ts";
import type { ReceiptRecord } from "../../src/verify/engine.ts";
import { executeWrites } from "./target-fixtures.ts";
import { buildGtmRuntimeWorld } from "../gtm-runtime/world.ts";
import { bindRep, exposureIntent, prepare, REP_CTX, T, target } from "../gtm-runtime/drive.ts";

type Ok = { readonly status: "OK"; readonly code: string; readonly result: Record<string, unknown> };

async function readyFinal(label: string) {
  const w = buildGtmRuntimeWorld();
  const handle = await bindRep(w);
  const prepared = await prepare(w, handle, exposureIntent({ key: `EXP-${label}`, contact: "C01", message_ref: `MSG-${label}` }));
  assert.equal(prepared.envelope.code, "PLAN_PREPARED", JSON.stringify(prepared.envelope));
  const plan = prepared.plan as Plan;
  const targeted = await target(w, handle, plan, { now: T.stage1 });
  assert.equal(targeted.envelope.code, "TARGET_VERIFIED", JSON.stringify(targeted.envelope));
  const targetReceiptId = (targeted.envelope as Ok).result["target_receipt_id"] as string;
  executeWrites(w, plan.finalization_writes, plan.plan_id, { ...({ now: T.fin }), created: targeted.symbols, target_receipt_id: targetReceiptId });
  executeWrites(w, [plan.state_last_write], plan.plan_id, { ...({ now: T.state }), created: targeted.symbols, target_receipt_id: targetReceiptId });
  return { w, handle, plan, targetReceiptId };
}

test("PT-FINAL-ATOMIC/1: os_verify(FINAL) recovers a consumed TARGET left without FINAL", async () => {
  const { w, handle, plan, targetReceiptId } = await readyFinal("CONSUMED");
  await w.deps.store.receipts.setStatus(targetReceiptId, "CONSUMED");

  const recovered = await dispatch("os_verify", { binding_handle: handle, plan_id: plan.plan_id, phase: "FINAL" }, REP_CTX, w.deps);
  assert.equal(recovered.code, "TRANSACTION_VERIFIED", JSON.stringify(recovered));
  assert.equal((await w.deps.store.plans.get(plan.plan_id))?.plan_state, "FINAL_VERIFIED");
  assert.equal((await w.deps.store.receipts.findByPlan(plan.plan_id, "FINAL")).length, 1);
  assert.match(recovered.warnings.join(" | "), /interrupted historical FINAL/);
});

test("PT-FINAL-ATOMIC/2: os_verify(FINAL) converges an incumbent FINAL after plan-transition crash", async () => {
  const { w, handle, plan, targetReceiptId } = await readyFinal("INCUMBENT");
  const incumbent: ReceiptRecord = {
    receipt_id: "final-incumbent-before-plan-transition", type: "FINAL", plan_id: plan.plan_id,
    principal_id: plan.principal_id, runtime_id: plan.runtime_id, runtime_generation: plan.runtime_generation,
    target_receipt_id: targetReceiptId, observed_at: new Date(T.state), observations: { recovered: true }, status: "VALID",
  };
  await w.deps.store.receipts.insert(incumbent);

  const recovered = await dispatch("os_verify", { binding_handle: handle, plan_id: plan.plan_id, phase: "FINAL" }, REP_CTX, w.deps);
  assert.equal(recovered.code, "TRANSACTION_VERIFIED", JSON.stringify(recovered));
  assert.equal((recovered as Ok).result["final_receipt_id"], incumbent.receipt_id);
  assert.equal((await w.deps.store.plans.get(plan.plan_id))?.plan_state, "FINAL_VERIFIED");
  assert.equal((await w.deps.store.receipts.get(targetReceiptId))?.status, "CONSUMED");
  const terminalEvents = await w.deps.store.events.list({ plan_id: plan.plan_id });
  for (const type of ["PLAN_FINAL_VERIFIED", "FINAL_RECEIPT_ISSUED", "LEASE_RELEASED"]) assert.equal(terminalEvents.filter((e) => e.event_type === type).length, 1, `${type} did not converge exactly once`);
});
