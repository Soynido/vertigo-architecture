/**
 * The Production Guard preflight of a new os_commit (Sales 0.5.11 candidate, W3.1R/W3.1S — NOT ADOPTED).
 *
 * At one instant T-0 it rebuilds the guard snapshot, compares its digest with the operator's approval for this exact
 * runtime binding and generation, evaluates every active P0 and classifies every real mutation. It decides:
 *  - no guard declared, no approval, approval of another generation/grammar, unprovable snapshot or digest drift:
 *    HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE for EVERY new mutation, protection included;
 *  - a mutation of the guard's own sources: HOLD_ACTION_NOT_AUTHORIZED;
 *  - a mutation matching no single approved class: HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE;
 *  - a new PRODUCTION while an approved P0 is TRIGGERED: HOLD_P0_PRODUCTION; while a P0 is UNVERIFIABLE, an index
 *    entry names no active rule, or a declared pointer is not MATCH: HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE;
 *  - a proven FUTURE_PROTECTION or RECONCILE_AS_IS passes a P0, never a digest drift.
 * A HOLD here happens before any plan, Run, lease, ledger row or Notion byte. Evidence names structure, codes and
 * identifiers only; MissingFact labels are human and carry no business value.
 */
import { guardBindingId } from "../binding/guardIdentity.ts";
import type { BindingRecord } from "../binding/store.ts";
import type { NotionReadClient } from "../notion/readClient.ts";
import type { IntentMutation } from "../plans/prepare.ts";
import type { ResolvedRuntime } from "../resolvers/types.ts";
import type { BackendStore } from "../store/memory.ts";
import type { GuardApproval } from "../store/guardApprovals.ts";
import type { ProductionGuardSpec } from "../versions/adapters/controlPlane.ts";
import { classify } from "./classify.ts";
import type { OperationClass } from "./index.ts";
import { evaluateP0, type P0Evaluation } from "./predicates.ts";
import { readGuardSnapshot, type GuardSnapshot } from "./snapshot.ts";

/** A fact the principal or operator must supply, as a human label (never an id, never a value). */
export interface MissingFact { readonly label: string; readonly candidates?: readonly string[] }

export type GuardHoldCode = "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE" | "HOLD_P0_PRODUCTION" | "HOLD_ACTION_NOT_AUTHORIZED" | import("../errors/codes.ts").HoldCode;

export interface GuardHold {
  readonly kind: "HOLD";
  readonly code: GuardHoldCode;
  readonly evidence: readonly string[];
  readonly safe_action: string;
  readonly missing: readonly MissingFact[];
}

export interface OpenGuard {
  readonly kind: "OPEN";
  readonly spec: ProductionGuardSpec;
  readonly approval: GuardApproval;
  readonly snapshot: GuardSnapshot;
  readonly p0: P0Evaluation;
  /** Why a new PRODUCTION is refused at this T-0, if it is. */
  readonly productionBlock?: { readonly code: "HOLD_P0_PRODUCTION" | "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE"; readonly evidence: readonly string[] };
}

const APPROVAL = "Approbation opérateur de la garde de production";
const unverifiable = (evidence: readonly string[], missing: string, safe_action = "ask the operator to review and approve the Production Guard Index of this space; nothing was written"): GuardHold =>
  ({ kind: "HOLD", code: "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE", evidence: [...evidence, "no plan, Run, lease, ledger row or Notion write was made"], safe_action, missing: [{ label: missing }] });

/** Opens the guard of a SALES binding at T-0, or says why no new mutation may be guarded. */
export async function openGuard(deps: { readonly store: BackendStore; readonly notion: NotionReadClient }, binding: BindingRecord, runtime: ResolvedRuntime, t0: Date): Promise<OpenGuard | GuardHold> {
  const spec = runtime.adapter.controlPlane.productionGuard;
  if (!spec) return unverifiable(["the governing Sales contract of this space declares no Production Guard; no new server write can be guarded"], APPROVAL, "move this space to a contract line that declares the Production Guard, then approve its index; nothing was written");
  const approval = await deps.store.guardApprovals?.get(guardBindingId(binding));
  if (!approval) return unverifiable(["no operator approval exists for this runtime binding"], APPROVAL);
  if (approval.runtime_id !== binding.runtime_id || approval.runtime_generation !== binding.runtime_generation || approval.guard_schema_version !== spec.schemaVersion) {
    return unverifiable(["the operator approval belongs to another runtime generation or guard grammar"], APPROVAL);
  }
  const read = await readGuardSnapshot({ client: deps.notion, runtime, spec, t0, indexPageId: approval.index_page_id });
  if (!read.ok) return unverifiable([`the guard snapshot at T-0 cannot be proven: ${read.reason}`], read.source);
  const snapshot = read.snapshot;
  if (snapshot.digest !== approval.digest_sha256) return unverifiable(["the guard snapshot at T-0 differs from the approved digest"], APPROVAL);

  const p0 = evaluateP0(snapshot);
  const triggered = [...p0.verdicts].filter(([, v]) => v === "TRIGGERED").map(([id]) => id);
  const unknown = [...p0.verdicts].filter(([, v]) => v === "UNVERIFIABLE").map(([id]) => id);
  const badPointers = [...snapshot.constraints].filter(([, c]) => (c.type === "PRODUCTION_CONTRACT_POINTER" ? c.status !== "MATCH" : c.status !== "NO_POINTER" && c.status !== "MATCH"));
  let productionBlock: OpenGuard["productionBlock"];
  if (triggered.length > 0) productionBlock = { code: "HOLD_P0_PRODUCTION", evidence: triggered.map((id) => `P0 rule ${id}: TRIGGERED`) };
  else if (unknown.length > 0 || p0.extra.length > 0 || badPointers.length > 0) {
    productionBlock = { code: "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE", evidence: [
      ...unknown.map((id) => `P0 rule ${id}: UNVERIFIABLE`),
      ...p0.extra.map((id) => `index entry for rule ${id} names no active P0 rule`),
      ...badPointers.map(([id, c]) => `constraint ${id}: pointer ${c.status}`),
    ] };
  }
  return { kind: "OPEN", spec, approval, snapshot, p0, ...(productionBlock ? { productionBlock } : {}) };
}

const LABEL: Record<"HOLD_P0_PRODUCTION" | "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE", string> = {
  HOLD_P0_PRODUCTION: "Levée de la règle P0 déclenchée",
  HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE: "Contrainte déclarée démontrable",
};

/** Classifies every real mutation against the open guard. PASS carries each mutation's class, in order. */
export async function checkMutations(client: NotionReadClient, runtime: ResolvedRuntime, binding: BindingRecord, guard: OpenGuard, mutations: readonly IntentMutation[]): Promise<{ readonly kind: "PASS"; readonly classes: readonly OperationClass[] } | GuardHold> {
  const classes: OperationClass[] = [];
  const unclassified: string[] = [];
  for (const [i, m] of mutations.entries()) {
    const c = await classify(client, runtime, binding.binding_mode, m, guard.snapshot);
    switch (c.kind) {
      case "GUARD_SOURCE":
        return { kind: "HOLD", code: "HOLD_ACTION_NOT_AUTHORIZED", evidence: [`mutation ${i + 1} targets a source of the Production Guard, which os_commit never writes`, "no plan, Run, lease, ledger row or Notion write was made"], safe_action: "leave the guard sources to the operator's reviewed process; submit no write for them", missing: [] };
      case "TARGET_HOLD":
        return { kind: "HOLD", code: c.code, evidence: [`mutation ${i + 1}: its target cannot be resolved (${c.code})`, "no plan, Run, lease, ledger row or Notion write was made"], safe_action: "resume from the durable state and prepare the change against the records it reports", missing: [] };
      case "UNCLASSIFIED":
        unclassified.push(`mutation ${i + 1} matches ${c.matches} approved operation classes instead of exactly one`);
        break;
      case "CLASS":
        classes.push(c.cls);
        break;
    }
  }
  if (unclassified.length > 0) return { kind: "HOLD", code: "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE", evidence: [...unclassified, "no plan, Run, lease, ledger row or Notion write was made"], safe_action: "the change is not covered by the approved operation classes; nothing was written", missing: [{ label: "Classe d'opération approuvée" }] };
  if (guard.productionBlock && classes.includes("PRODUCTION")) {
    const b = guard.productionBlock;
    return { kind: "HOLD", code: b.code, evidence: [...b.evidence, "a new production is refused at T-0; no plan, Run, lease, ledger row or Notion write was made"], safe_action: b.code === "HOLD_P0_PRODUCTION" ? "a P0 rule approved for this space is in force; no new production until it is lifted" : "a declared constraint cannot be proven; no new production until it is", missing: [{ label: LABEL[b.code] }] };
  }
  return { kind: "PASS", classes };
}

/** Re-reads the snapshot and compares it with the approval: false once the approved guard has drifted. */
export async function guardStillApproved(deps: { readonly notion: NotionReadClient }, runtime: ResolvedRuntime, guard: OpenGuard, at: Date): Promise<boolean> {
  const read = await readGuardSnapshot({ client: deps.notion, runtime, spec: guard.spec, t0: at, indexPageId: guard.approval.index_page_id });
  return read.ok && read.snapshot.digest === guard.approval.digest_sha256;
}
