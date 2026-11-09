import type { PlanStore } from "../../harness/src/plans/store.ts";
import type { ReceiptStore } from "../../harness/src/verify/engine.ts";
import type { VerificationReader } from "./types.ts";

const norm = (s: string): string => s.replace(/-/g, "").toLowerCase();

/** Harness truth, read-only: the intent plan must be FINAL_VERIFIED, carry a FINAL receipt, and plan exactly this action key / record. */
export function harnessVerification(plans: PlanStore, receipts: ReceiptStore): VerificationReader {
  return {
    async finalVerified(harnessPlanId, actionKey, intentRef) {
      const plan = await plans.get(harnessPlanId);
      if (!plan) return { verified: false, evidence: `no backend plan ${harnessPlanId}` };
      if (plan.plan_state !== "FINAL_VERIFIED") return { verified: false, evidence: `plan ${harnessPlanId} is ${plan.plan_state}, not FINAL_VERIFIED` };
      const op = plan.operations.find((o) => o.natural_key === actionKey);
      if (!op) return { verified: false, evidence: `plan ${harnessPlanId} plans no operation for action ${actionKey}` };
      if (op.physical_target_ref && norm(op.physical_target_ref) !== norm(intentRef)) return { verified: false, evidence: `plan ${harnessPlanId} targets ${op.physical_target_ref}, not ${intentRef}` };
      const final = (await receipts.findByPlan(harnessPlanId, "FINAL"))[0];
      if (!final) return { verified: false, evidence: `plan ${harnessPlanId} has no FINAL receipt` };
      return { verified: true, evidence: `plan ${harnessPlanId} FINAL_VERIFIED (receipt ${final.receipt_id}) for action ${actionKey}` };
    },
  };
}
