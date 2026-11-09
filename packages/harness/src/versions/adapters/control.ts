/**
 * CONTROL adapters (PV0-019), keyed by the GOVERNING control version discovered at call time from SPEC_ROOT.
 * An adapter declares how a control version is satisfied — it never hardcodes current state:
 *   - INDEPENDENT_PROOF: a canonical Control Check (mirror) written by an independent verifier is consumed and
 *     validated (freshness, scope, result); the harness never fabricates it;
 *   - OPERATIONAL_RECOMPUTE: for the declared scope the harness may recompute CONTROL invariants read-only as an
 *     operational integrity check (not an attestation); gates on the confirmed list still need a fresh check.
 * A candidate version is reported but never dispatched. An unknown governing version HOLDs (no fallback).
 */
import type { AdapterRegistry, ControlAdapter } from "../registry.ts";

export type ControlMode = "INDEPENDENT_PROOF" | "OPERATIONAL_RECOMPUTE";
export type ControlSource = "MANIFEST" | "RUNS" | "LEDGER" | "GATES" | "CONTROL_CHECKS";

export interface ControlSpecAdapter extends ControlAdapter {
  readonly version: string;
  readonly mode: ControlMode;
  /** Gates that always require independent Control confirmation for final PASS under this version. */
  readonly controlConfirmedGates: readonly string[];
  /** Sources the status computation must read; a missing one is HOLD_CONTROL_SCOPE_INCOMPLETE. */
  readonly requiredSources: readonly ControlSource[];
  /** CONTROL-class invariants this version expects to be calculable for the META-internal scope. */
  readonly controlInvariants: readonly string[];
  readonly note: string;
}

export function controlSpecAdapter(a: Omit<ControlSpecAdapter, "kind">): ControlSpecAdapter {
  return { kind: "CONTROL", ...a };
}

const INVARIANTS_10 = ["RUN_RECOVERY", "GATE_PROOF", "MUTATION_CLEAN", "INHERITED_HISTORY", "ATTEMPT_IDENTITY", "VERSION_PIN", "CONTROL_REPORT_TAMPER"] as const;
const INVARIANTS_11 = ["RUN_RECOVERY", "GATE_PROOF", "MUTATION_CLEAN", "INHERITED_HISTORY", "ATTEMPT_IDENTITY", "VERSION_PIN"] as const;

/** Built-in capability declarations for the CONTROL lines this backend understands (00G contract). */
export function registerBuiltinControlAdapters(registry: AdapterRegistry<ControlAdapter>): void {
  registry.register("CONTROL/1.0", controlSpecAdapter({ version: "CONTROL/1.0", mode: "INDEPENDENT_PROOF", controlConfirmedGates: ["M0", "M8", "G2", "G4", "G7", "G8", "G9", "G10", "G11"], requiredSources: ["MANIFEST", "RUNS", "LEDGER", "GATES", "CONTROL_CHECKS"], controlInvariants: INVARIANTS_10, note: "independent verifier with tamper-evident canonical reports; the harness only consumes fresh, in-scope Control Check mirrors" }));
  registry.register("CONTROL/1.1", controlSpecAdapter({ version: "CONTROL/1.1", mode: "OPERATIONAL_RECOMPUTE", controlConfirmedGates: ["M8", "G4", "G7", "G8", "G9", "G10", "G11"], requiredSources: ["MANIFEST", "RUNS", "LEDGER", "GATES"], controlInvariants: INVARIANTS_11, note: "META-internal operational override: deterministic read-only recomputation is an integrity check, not an adversarial attestation; M8 remains a confirmed checkpoint" }));
}
