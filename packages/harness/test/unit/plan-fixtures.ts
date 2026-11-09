import type { BindingRecord } from "../../src/binding/store.ts";
import type { PlanOperation, WriteInstruction } from "../../src/plans/store.ts";
import type { PlanDraft } from "../../src/plans/service.ts";

export function draftFor(binding: BindingRecord, keys: string[] = ["op-1"]): PlanDraft {
  const w = (ordinal: number, purpose: WriteInstruction["purpose"]): WriteInstruction => ({ ordinal, symbol: `W${ordinal}`, target_ref: `target-${ordinal}`, operation: "UPDATE", fields: { a: ordinal }, purpose });
  const operations: PlanOperation[] = keys.map((k, i) => ({ operation_id: `${k}-id`, ordinal: i, logical_resource_key: `${binding.lane}:RESOURCE`, idempotency_key: k, operation: "UPDATE", compared_fields: ["a"], before_values: { a: 0 }, expected_values: { a: 1 } }));
  return {
    principal_id: binding.principal_id, binding, governing: { spec: "TEST_SPEC/1.0.0", schema: "TEST_SCHEMA/1.0.0", control: "TEST_CONTROL/1.0" },
    run_mode: "OPEN_NEW", execution_attempt_id: "att-1", baseline_runtime_revision: "rev-0", operations,
    stage1_writes: [w(0, "OPEN_RUN"), w(1, "PREPARE_LEDGER"), w(2, "WRITE_TARGET"), w(3, "LEDGER_WRITTEN")],
    finalization_writes: [w(4, "LEDGER_VERIFIED"), w(5, "FINALIZE_RUN")],
    state_last_write: w(6, "STATE_LAST"),
  };
}
