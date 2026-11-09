/**
 * Backend-derived cursor transitions (PV-B0-002).
 *
 * A gate moves only when durable evidence already says it should. The governing contract declares, per
 * transition, which verified business row completes the gate and exactly which cursor fields the move writes;
 * this module reads that evidence, refuses unless it is unambiguous, and returns the intent the ordinary
 * transaction engine then plans, writes and proves. Nothing here writes: the move is a normal
 * `os_prepare → TARGET → FINAL`, never a side effect of the transaction that produced the evidence.
 *
 * Every value is either fixed by the contract or carried from the cursor's own durable row, so the result is a
 * pure function of durable state: replaying the same situation yields the same idempotency key and the same
 * single Run. Commit timestamps travel as the writer's `$now` placeholder for that reason.
 */
import type { BindingRecord } from "../binding/store.ts";
import type { HoldCode } from "../errors/codes.ts";
import { propMentions, propText } from "../notion/shapes.ts";
import type { ResolvedRuntime } from "../resolvers/types.ts";
import type { ResumeState } from "../resume/derive.ts";
import { observePendingStepInput, pendingStepInputOfTransition } from "../resume/pendingInput.ts";
import type { HarnessDeps } from "../tools/handlers.ts";
import type { ControlPlaneGrammar, CursorProps, DerivedCursorTransition } from "../versions/adapters/controlPlane.ts";
import type { Intent } from "./prepare.ts";
import { resolveTarget } from "./resources.ts";
import { bindB7Intent, observeB7DryRun } from "../resume/b7DryRun.ts";

export type TransitionOutcome =
  | { readonly kind: "INTENT"; readonly intent: Intent; readonly transition: DerivedCursorTransition }
  | { readonly kind: "NONE" }
  | { readonly kind: "HOLD"; readonly code: HoldCode; readonly evidence: readonly string[]; readonly safe_action: string };

/**
 * What the governing contract has to say about a durable step it declares no transition for (PV-GATE-000).
 *
 * A contract line that governs no walk keeps the old answer: nothing is derivable and nothing is claimed. A line
 * that DOES publish its walk has already said which steps belong to the product, so silence at one of them is no
 * longer ambiguous — it is an unfinished gate, and the only honest answer is to refuse to advance it. The
 * terminal step is the one exception: arriving there is the walk being over, not a gate that is missing.
 *
 * Refusing costs nothing durable. Nothing is written either way; the difference is whether the conversation is
 * told the step cannot move, or is left to infer from a silent backend that it may decide the step itself.
 */
function unspecifiedStep(controlPlane: ControlPlaneGrammar, gateKey: string): TransitionOutcome {
  const sequence = controlPlane.gateSequence;
  if (!sequence || gateKey === sequence.terminal) return { kind: "NONE" };
  return {
    kind: "HOLD",
    code: "HOLD_GATE_UNSPECIFIED",
    evidence: sequence.gates.includes(gateKey)
      ? [
          `the governing contract governs the durable step ${gateKey} but publishes no completion predicate and no cursor transition for it`,
          "an unspecified step cannot be proven complete, so the cursor must not move and no question may be invented for it",
        ]
      : [
          `the durable cursor sits on ${gateKey}, which the governing contract's published walk does not name`,
          "a step outside the governed walk has no predicate of its own and cannot be advanced",
        ],
    safe_action: "publish and adopt this step's completion predicate and cursor transition in the governing contract, then resume",
  };
}

export async function deriveCursorTransition(deps: HarnessDeps, binding: BindingRecord, runtime: ResolvedRuntime, state: ResumeState | undefined): Promise<TransitionOutcome> {
  const declared = runtime.adapter.controlPlane.cursorTransitions ?? [];
  if (declared.length === 0) return { kind: "NONE" };

  // 1. The cursor row itself, first: the contract makes zero or more than one CURRENT a HOLD, and the gate this
  //    branches on must be read from the very row the transition would update — never from a second source.
  //    Which row that is must not depend on which transition happens to fire, so the declared transitions have
  //    to agree on one cursor address. A contract that named two would leave the gate readable from a row a
  //    different move would not update, so it is refused here rather than resolved by declaration order.
  const anchor = declared[0] as DerivedCursorTransition;
  if (declared.some((t) => t.targetResourceKey !== anchor.targetResourceKey || t.targetNaturalKey !== anchor.targetNaturalKey)) {
    return { kind: "HOLD", code: "HOLD_TARGET_AMBIGUOUS", evidence: ["the governing contract declares cursor transitions against more than one cursor row"], safe_action: "resolve the governing contract to a single durable cursor, then resume" };
  }
  const cursorTarget = await resolveTarget(deps.notion, runtime, binding.binding_mode, anchor.targetResourceKey, "UPDATE", { natural_key: anchor.targetNaturalKey });
  if (!cursorTarget.ok) return { kind: "HOLD", code: cursorTarget.code, evidence: cursorTarget.evidence, safe_action: "reconcile the durable cursor row, then resume" };
  if (cursorTarget.target.kind !== "EXISTING") return { kind: "HOLD", code: "HOLD_TARGET_NOT_FOUND", evidence: [`the durable cursor row ${anchor.targetNaturalKey} does not exist`], safe_action: "restore the runtime control plane, then resume" };
  const cursorProps = (runtime.adapter.controlPlane.stateCursor ?? runtime.adapter.controlPlane.manifestCursor) as CursorProps;
  const cursorPage = cursorTarget.target.page;
  const gateKey = cursorProps.currentGate ? propText(cursorPage, cursorProps.currentGate)?.trim() : undefined;
  if (!gateKey) return { kind: "NONE" };
  const transition = declared.find((t) => t.fromGate === gateKey);
  if (!transition) return unspecifiedStep(runtime.adapter.controlPlane, gateKey);
  if (transition.evidence.kind !== undefined && transition.evidence.kind !== "SINGLE_ROW" && transition.evidence.kind !== "B7_GRAPH")
    return { kind: "HOLD", code: "HOLD_GATE_UNSPECIFIED", evidence: ["unknown cursor evidence kind"], safe_action: "publish a supported completion predicate before moving this gate" };
  let graphFingerprint: string | undefined;
  if (transition.evidence.kind === "B7_GRAPH") {
    if (state?.effective_hold !== "NONE") return { kind: "HOLD", code: "HOLD_UNKNOWN_REQUIRED_FACT", evidence: ["B7 requires a healthy durable state without unresolved work or effects"], safe_action: "complete the scoped recovery first" };
    const graph = await observeB7DryRun(deps, binding, runtime);
    if (graph.kind === "HOLD") return graph;
    graphFingerprint = graph.fingerprint;
  }

  // 2. The completion predicate, read from durable business state through the one shared observer `os_resume`
  //    also reads. Anything short of one row carrying every contracted value leaves the gate exactly where it
  //    is; a missing resource or a duplicated answer stays a HOLD, because neither can be proven either way.
  const observed = graphFingerprint ? { kind: "SATISFIED" as const } : await observePendingStepInput(deps.notion, runtime, pendingStepInputOfTransition(transition.fromGate, transition));
  if (observed.kind === "UNREADABLE") {
    return { kind: "HOLD", code: "HOLD_REQUIRED_RESOURCE_MISSING", evidence: [`the durable answer that completes ${transition.fromGate} could not be read: ${observed.reason}`], safe_action: "restore access to the setup records, then resume" };
  }
  if (observed.kind === "AMBIGUOUS") {
    return { kind: "HOLD", code: "HOLD_TARGET_AMBIGUOUS", evidence: [`${observed.count} rows carry ${observed.natural_key_property} = ${transition.evidence.naturalKey}; the completion of ${transition.fromGate} cannot be proven`], safe_action: "reconcile the duplicate setup rows, then resume" };
  }
  if (observed.kind !== "SATISFIED") return { kind: "NONE" };

  // 3. References the contract carries forward from the cursor the previous transaction already wrote.
  const cursor = cursorProps;
  const carried: Record<string, unknown> = {};
  for (const [property, cursorKey] of Object.entries(transition.carryForward)) {
    const source = (cursor as unknown as Record<string, string | undefined>)[cursorKey];
    // The previous transaction wrote these as page references, so a mention carries the id while plain text
    // carries the value itself; both are legitimate durable forms of the same pointer.
    const value = source ? (propMentions(cursorPage, source)[0] ?? propText(cursorPage, source)?.trim()) : undefined;
    if (!value) {
      return { kind: "HOLD", code: "HOLD_UNKNOWN_REQUIRED_FACT", evidence: [`the cursor carries no ${source ?? cursorKey}, so ${property} cannot be derived from durable state`], safe_action: "complete the pending transaction, then resume" };
    }
    carried[property] = value;
  }

  const stamped = Object.fromEntries(transition.stampedProperties.map((p) => [p, "$now"]));
  // The transition's own Run: a symbol the writer resolves and the proof resolves the same way, so the cursor's
  // durable identity is verified rather than asserted.
  const runReference = Object.fromEntries(transition.runReferenceProperties.map((p) => [p, "$created:OPEN_RUN"]));
  const cleared = state?.effective_hold === "NONE" ? Object.fromEntries(transition.clearWhenUnblocked.map((p) => [p, ""])) : {};
  const desired_changes = { ...transition.set, ...carried, ...runReference, ...stamped, ...cleared };

  const intent: Intent = {
    action_class: "COMMIT",
    summary: `advance the durable step to ${String(transition.set["Current Gate"] ?? transition.key)}`,
    mutations: [{ logical_resource_key: transition.targetResourceKey, operation: "UPDATE", record_selector: { natural_key: transition.targetNaturalKey }, desired_changes }],
  };
  return {
    kind: "INTENT",
    transition,
    intent: graphFingerprint ? bindB7Intent(intent, graphFingerprint) : intent,
  };
}
