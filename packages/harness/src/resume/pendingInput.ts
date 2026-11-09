/**
 * The pending input of a durable step: the ONE record the governing contract fixes for the answer that step is
 * waiting for.
 *
 * The contract already publishes it, as the completion predicate of the transition that leaves the step. Until
 * now it was only ever read at `os_prepare`, to refuse a key the caller had already chosen. That is a refusal,
 * not an address: nothing told the caller where the answer goes, so a generic mutation engine wrote it under a
 * key of its own — a parallel truth the predicate never matches, leaving the step exactly where it was.
 *
 * Both readers derive the declaration here, so what `os_resume` serves and what `os_prepare` enforces are the
 * same object and can never drift into two truths of their own.
 *
 * A declaration is an address for an answer that is still missing. Whether it still is, is a question about
 * durable state, so this module also owns the one observer of the completion predicate — the same one the
 * cursor transition uses to decide the gate may move. A row that already satisfies the predicate answers the
 * step: it is no longer served, and the seller is never asked twice for what Notion already holds.
 */
import type { NotionReadClient } from "../notion/readClient.ts";
import { findRows } from "../plans/resources.ts";
import type { ResolvedRuntime } from "../resolvers/types.ts";
import type { DerivedCursorTransition } from "../versions/adapters/controlPlane.ts";

export interface PendingStepInput {
  readonly evidence_kind?: "SINGLE_ROW" | "B7_GRAPH";
  /** The durable gate this declaration belongs to. It is never the caller's idea of the current step. */
  readonly gate_key: string;
  readonly logical_resource_key: string;
  /** The exact `record_selector.natural_key` of the answer row. Copied verbatim; never derived from a label. */
  readonly natural_key: string;
  /** Values the contract fixes literally on that row. */
  readonly required_values: Readonly<Record<string, string>>;
  /** Properties that must carry the seller's own answer; an empty one does not complete the step. */
  readonly required_non_empty: readonly string[];
}

/** The declaration a transition publishes, carried verbatim: the one object both readers derive from. */
export function pendingStepInputOfTransition(gateKey: string, transition: DerivedCursorTransition): PendingStepInput {
  return {
    ...(transition.evidence.kind ? { evidence_kind: transition.evidence.kind } : {}),
    gate_key: gateKey,
    logical_resource_key: transition.evidence.logicalResourceKey,
    natural_key: transition.evidence.naturalKey,
    required_values: transition.evidence.equals,
    required_non_empty: transition.evidence.nonEmpty,
  };
}

/** Every pending input the governing contract declares for this durable gate. Empty when it declares none. */
export function pendingStepInputs(runtime: ResolvedRuntime, gateKey: unknown): readonly PendingStepInput[] {
  if (typeof gateKey !== "string" || gateKey.trim() === "" || gateKey === "UNKNOWN") return [];
  return (runtime.adapter.controlPlane.cursorTransitions ?? [])
    .filter((t) => t.fromGate === gateKey)
    .map((t) => pendingStepInputOfTransition(gateKey, t));
}

/** The declaration governing a mutation on this resource at this gate, if the contract declares one. */
export function pendingStepInputFor(runtime: ResolvedRuntime, gateKey: unknown, resourceKey: string, naturalKey?: string): PendingStepInput | undefined {
  const grammar = runtime.adapter.controlPlane;
  if (grammar.independentConfigurationResourceKey === resourceKey && naturalKey !== undefined) {
    // Independent configuration is not an answer. Declared keys AND their namespaces stay protected,
    // including other steps: prepare must refuse those unless they belong to the durable current gate.
    const key = naturalKey.trim();
    return (grammar.cursorTransitions ?? [])
      .map((t) => pendingStepInputOfTransition(t.fromGate, t))
      .find((p) => p.logical_resource_key === resourceKey && (key === p.natural_key || key.startsWith(`${p.gate_key}:`)));
  }
  return pendingStepInputs(runtime, gateKey).find((p) => p.logical_resource_key === resourceKey);
}

/**
 * The placeholder the served intent carries in place of the seller's own words. It is refused at `os_prepare`:
 * a template sent back unchanged would write the token itself into Notion and satisfy the predicate's
 * "non-empty" test while recording nothing the seller said.
 */
export const ANSWER_PLACEHOLDER = "$answer";

/** The candidate accepts two distinct human-local origins, preserving the original label and other predicates. */
export function pendingInputValueMatches(runtime: ResolvedRuntime, pending: PendingStepInput, field: string, value: unknown): boolean {
  const g = runtime.adapter.controlPlane;
  if (field === "Source" && g.localAnswerSources && pending.logical_resource_key === g.independentConfigurationResourceKey)
    return typeof value === "string" && g.localAnswerSources.includes(value);
  return String(value ?? "").trim() === pending.required_values[field];
}

/**
 * The exact `os_prepare` intent that records this step's answer, everything filled but the answer itself.
 *
 * Three fresh conversations in a row read the state, held the declaration, and never called `os_prepare` —
 * then told the seller the backend had refused. The declaration says WHERE the answer goes; it never said
 * what to send. Serving the call itself removes the assembly step that kept failing, and leaves exactly one
 * thing to supply: the seller's words, copied verbatim.
 */
export function prepareIntentFor(pending: PendingStepInput): {
  readonly action_class: string;
  readonly summary: string;
  readonly mutations: readonly {
    readonly logical_resource_key: string;
    readonly operation: string;
    readonly record_selector: { readonly natural_key: string };
    readonly desired_changes: Readonly<Record<string, string>>;
  }[];
} {
  return {
    action_class: "COMMIT",
    summary: pending.evidence_kind === "B7_GRAPH" ? "record the selected durable trial workset, not a gate approval" : `record the answer the ${pending.gate_key} step is waiting for`,
    mutations: [{
      logical_resource_key: pending.logical_resource_key,
      operation: "UPSERT",
      record_selector: { natural_key: pending.natural_key },
      desired_changes: { ...pending.required_values, ...Object.fromEntries(pending.required_non_empty.map((k) => [k, ANSWER_PLACEHOLDER])) },
    }],
  };
}

/**
 * The one instruction that travels NEXT TO the intent, never inside it. Observed 2026-09-23 17:26: with this
 * sentence carried as a `replace` field of the intent, a caller that did exactly what the conduct asks — send
 * next.prepare_intent as given — was refused by the strict os_prepare schema (ERROR_INVALID_ARGUMENT) on the
 * seller's real B3 answer. The served intent must be byte-for-byte what os_prepare accepts.
 */
export const PREPARE_NOTE = `${ANSWER_PLACEHOLDER} — replace with the seller's own answer, copied verbatim from their current message; sending the token itself is refused`;

export function prepareNoteFor(pending: PendingStepInput): string {
  return pending.evidence_kind === "B7_GRAPH"
    ? `${ANSWER_PLACEHOLDER} — assemble the canonical SALES_DRY_RUN_WORKSET/1 JSON from the bound runtime and selected durable identities. Ask the seller only for a natural-language selection/confirmation, never JSON or IDs. A confirmation selects scope; it cannot approve the gate or attest execution.`
    : PREPARE_NOTE;
}

/**
 * What durable state says about one declaration. This is the SINGLE observer of the completion predicate: the
 * cursor transition decides whether the gate may move from it, and `os_resume` decides whether the answer is
 * still pending from it, so the two can never disagree about the same row.
 *
 * It observes only. An unreadable or duplicated answer is reported as it is found; what that means — a HOLD for
 * the transition, a still-served address for resume — belongs to each caller, not here.
 */
export type PendingInputObservation =
  /** One unique row carries every value the contract fixes: the step's answer exists durably. */
  | { readonly kind: "SATISFIED" }
  /** No row carries the contract's natural key. */
  | { readonly kind: "ABSENT" }
  /** The row exists but does not yet carry every contracted value; `mismatched` names the properties. */
  | { readonly kind: "INCOMPLETE"; readonly mismatched: readonly string[] }
  /** More than one row carries the natural key: nothing about the answer can be proven. */
  | { readonly kind: "AMBIGUOUS"; readonly count: number; readonly natural_key_property: string }
  /** The answer's own database could not be read. */
  | { readonly kind: "UNREADABLE"; readonly reason: string }
  /** The governing contract does not address this resource at all. */
  | { readonly kind: "UNADDRESSABLE" };

/** Reads durable business state and reports whether this declaration is already answered. Never writes. */
export async function observePendingStepInput(client: NotionReadClient, runtime: ResolvedRuntime, pending: PendingStepInput): Promise<PendingInputObservation> {
  // A scope selection never attests that the selected business graph was actually executed.
  if (pending.evidence_kind === "B7_GRAPH") return { kind: "INCOMPLETE", mismatched: ["durable trial graph"] };
  if (pending.evidence_kind !== undefined && pending.evidence_kind !== "SINGLE_ROW") return { kind: "UNADDRESSABLE" };
  const spec = runtime.adapter.controlPlane.resources?.[pending.logical_resource_key];
  if (!spec) return { kind: "UNADDRESSABLE" };
  const wanted = [...Object.keys(pending.required_values), ...pending.required_non_empty];
  const found = await findRows(client, runtime, pending.logical_resource_key, spec.naturalKeyProperty, pending.natural_key, wanted);
  if (found.status !== "OK") return { kind: "UNREADABLE", reason: found.reason };
  if (found.rows.length === 0) return { kind: "ABSENT" };
  if (found.rows.length > 1) return { kind: "AMBIGUOUS", count: found.rows.length, natural_key_property: spec.naturalKeyProperty };
  const row = found.rows[0] as Readonly<Record<string, string | null>>;
  const mismatched = [
    ...Object.keys(pending.required_values).filter(k => !pendingInputValueMatches(runtime, pending, k, row[k])).map(k => k),
    ...pending.required_non_empty.filter((k) => (row[k] ?? "").trim() === ""
      || (runtime.adapter.controlPlane.localAnswerSources !== undefined && (row[k] ?? "").trim() === ANSWER_PLACEHOLDER)),
  ];
  return mismatched.length === 0 ? { kind: "SATISFIED" } : { kind: "INCOMPLETE", mismatched };
}

/**
 * The declarations this gate still waits for. A declaration the canonical row already satisfies is NOT pending:
 * serving it would ask the seller again for an answer Notion already holds. Anything short of a proven
 * satisfaction keeps the declaration served — an address is safe, and the step really is still open.
 */
export async function unsatisfiedPendingStepInputs(client: NotionReadClient, runtime: ResolvedRuntime, gateKey: unknown): Promise<readonly PendingStepInput[]> {
  const unsatisfied: PendingStepInput[] = [];
  for (const declaration of pendingStepInputs(runtime, gateKey)) {
    if (declaration.evidence_kind === "B7_GRAPH") {
      // Only the scope INPUT may already be supplied. This is not a SATISFIED graph observation:
      // resume may request a fresh guarded commit, never PASS or cached permission from this row.
      const spec = runtime.adapter.controlPlane.resources?.[declaration.logical_resource_key];
      const selected = spec ? await findRows(client, runtime, declaration.logical_resource_key, spec.naturalKeyProperty,
        declaration.natural_key, [...Object.keys(declaration.required_values), ...declaration.required_non_empty]) : undefined;
      const row = selected?.status === "OK" && selected.rows.length === 1 ? selected.rows[0] : undefined;
      const { parseB7Workset } = await import("./b7DryRun.ts");
      if (row && Object.keys(declaration.required_values).every(k => pendingInputValueMatches(runtime, declaration, k, row[k]))
        && parseB7Workset(row["Value"] ?? "", runtime)) continue;
      unsatisfied.push(declaration);
      continue;
    }
    const observed = await observePendingStepInput(client, runtime, declaration);
    if (observed.kind !== "SATISFIED") unsatisfied.push(declaration);
  }
  return unsatisfied;
}
