/**
 * Required Capability Set derivation (PV-GTM-002F).
 *
 * Requirements come only from the fresh governing Sales adapter and the runtime's durable operating modes. Proofs
 * come only from the append-only Capability Profile inside that same runtime. A missing/malformed/foreign proof can
 * never become a verified capability through prose or a registry hint.
 */
import type { ResolvedRuntime } from "../resolvers/types.ts";
import type { CapabilityState, SalesCapabilityRequirement } from "../versions/adapters/sales.ts";
import type { CapabilityProofRow, ControlPlaneSnapshot, Text } from "./snapshot.ts";

export type CapabilitySnapshot = Pick<ControlPlaneSnapshot, "manifest" | "state" | "capability_proofs">;

export interface CapabilityComparison {
  readonly capability: string;
  readonly requirement: "REQUIRED" | "OPTIONAL";
  readonly accepted_states: readonly CapabilityState[];
  readonly state: CapabilityState;
  readonly satisfied: boolean;
  readonly competent_source: string;
  readonly operating_modes: readonly string[];
  readonly proof_ref: string | "NOT_FOUND";
  readonly evidence_ref: Text;
  readonly verified_at: Text;
  readonly reason: string;
  readonly next_human_action: string;
}

export interface CapabilityCompleteness {
  readonly profile_state: "PRESENT" | "NOT_FOUND";
  readonly operating_modes: readonly string[];
  readonly required_total: number;
  readonly required_verified: number;
  readonly complete: boolean;
  readonly comparisons: readonly CapabilityComparison[];
  readonly incomplete_required: readonly string[];
  /** Exactly one deterministic, seller-facing human action. */
  readonly next_human_action: string | "NONE";
}

const STATES = new Set<CapabilityState>(["UNKNOWN", "HUMAN_AUTH_PENDING", "READ_VERIFIED", "WRITE_VERIFIED", "PARTIAL", "ERROR", "NOT_APPLICABLE"]);
const badText = (v: Text): boolean => typeof v !== "string" || v === "" || v === "UNKNOWN" || v === "NONE" || v === "NOT_FOUND" || v === "NOT_APPLICABLE";
const splitModes = (v: Text): string[] => badText(v) ? [] : String(v).split(/[,|]/).map((x) => x.trim()).filter(Boolean);
const instant = (v: Text): number | undefined => badText(v) || Number.isNaN(Date.parse(String(v))) ? undefined : Date.parse(String(v));

/** Stable append-only natural key: no caller-chosen mutable identity. */
export function capabilityProofKey(input: { readonly runtimeId: string; readonly principalKey: string; readonly capability: string; readonly operatingMode: string; readonly verifiedAt: string; readonly evidenceRef: string }): string {
  // Kept human/computer reproducible: the installed agent can build it after a native competent-source read
  // without a seventh tool or an unreliable model-computed hash. Each component is already a governed scalar.
  return ["CP", input.runtimeId, input.principalKey, input.capability, input.operatingMode, input.verifiedAt, input.evidenceRef].join("|");
}

function modesAndRequirements(runtime: ResolvedRuntime, snap: CapabilitySnapshot): { modes: string[]; requirements: Map<string, { rule: SalesCapabilityRequirement; modes: string[] }> } {
  const caps = runtime.adapter.capabilities;
  const modes = [...new Set([...(caps?.defaultOperatingModes ?? []), ...splitModes((snap.state ?? snap.manifest).operating_modes)])].sort();
  const requirements = new Map<string, { rule: SalesCapabilityRequirement; modes: string[] }>();
  for (const mode of modes) for (const rule of caps?.operatingModeRequirements?.[mode] ?? []) {
    const prior = requirements.get(rule.capability);
    if (!prior) requirements.set(rule.capability, { rule, modes: [mode] });
    else {
      // A capability required by any governing mode is REQUIRED globally; acceptance narrows to the intersection.
      const required = prior.rule.requirement === "REQUIRED" || rule.requirement === "REQUIRED" ? "REQUIRED" : "OPTIONAL";
      const sourceConflict = prior.rule.competentSource !== rule.competentSource;
      const accepted = sourceConflict ? [] : prior.rule.acceptedStates.filter((s) => rule.acceptedStates.includes(s));
      const base = prior.rule.requirement === "OPTIONAL" && rule.requirement === "REQUIRED" ? rule : prior.rule;
      requirements.set(rule.capability, {
        rule: { ...base, requirement: required, acceptedStates: accepted },
        modes: [...new Set([...prior.modes, mode])].sort(),
      });
    }
  }
  return { modes, requirements };
}

function proofFor(rows: readonly CapabilityProofRow[], runtime: ResolvedRuntime, principal: string, capability: string, modes: readonly string[], source: string): { row?: CapabilityProofRow; state: CapabilityState; reason: string } {
  const matching = rows.filter((r) => r.capability_key === capability && r.runtime_id === runtime.runtime_id && r.principal_key === principal && (r.operating_mode === "ALL" || (typeof r.operating_mode === "string" && modes.includes(r.operating_mode))));
  if (matching.length === 0) return { state: "UNKNOWN", reason: "no competent-source proof exists for this runtime, principal and operating mode" };
  const unordered = matching.find((r) => instant(r.verified_at) === undefined);
  if (unordered) return { row: unordered, state: "ERROR", reason: "a matching append-only proof has no valid verification time, so proof precedence is unknowable" };
  const ordered = [...matching].sort((a, b) => (instant(b.verified_at) ?? -1) - (instant(a.verified_at) ?? -1) || b.ref.localeCompare(a.ref));
  const row = ordered[0] as CapabilityProofRow;
  const declared = typeof row.state === "string" && STATES.has(row.state as CapabilityState) ? row.state as CapabilityState : "ERROR";
  const scope = String(row.scope);
  const scopeTokens = scope.split(/[;,]/).map((x) => x.trim());
  // Notion preserves the instant but may round-trip UTC as `+00:00` even when the immutable key was written
  // with `Z`. Compare against the canonical instant spelling used by the backend-owned proof writer, not the
  // connector's equivalent textual representation.
  const canonicalVerifiedAt = instant(row.verified_at) === undefined ? undefined : new Date(instant(row.verified_at) as number).toISOString();
  const expectedKey = !badText(row.evidence_ref) && canonicalVerifiedAt !== undefined && typeof row.operating_mode === "string"
    ? capabilityProofKey({ runtimeId: runtime.runtime_id, principalKey: principal, capability, operatingMode: row.operating_mode, verifiedAt: canonicalVerifiedAt, evidenceRef: String(row.evidence_ref) })
    : undefined;
  if (row.competent_source !== source || badText(row.evidence_ref) || badText(row.scope) || badText(row.proof_key) || !scopeTokens.includes(`principal:${principal}`) || !scopeTokens.includes(`runtime:${runtime.runtime_id}`) || row.proof_key !== expectedKey) {
    return { row, state: "ERROR", reason: "latest proof is malformed or lacks exact runtime/principal scope and immutable provenance" };
  }
  const sameInstant = ordered.filter((r) => instant(r.verified_at) === instant(row.verified_at));
  if (new Set(sameInstant.map((r) => r.state)).size > 1) return { row, state: "ERROR", reason: "latest competent-source proofs conflict at the same verification time" };
  return { row, state: declared, reason: `latest append-only proof states ${declared}` };
}

/** Undefined means the fresh governing adapter declares no capability profile and legacy behavior is untouched. */
export function evaluateCapabilityCompleteness(runtime: ResolvedRuntime, snap: CapabilitySnapshot): CapabilityCompleteness | undefined {
  const { modes, requirements } = modesAndRequirements(runtime, snap);
  if (runtime.lane !== "SALES" || requirements.size === 0) return undefined;
  const principal = typeof runtime.observations["rep_identity_key"] === "string" ? runtime.observations["rep_identity_key"] : "UNKNOWN";
  const rows = Array.isArray(snap.capability_proofs) ? snap.capability_proofs : [];
  const comparisons: CapabilityComparison[] = [];
  for (const [capability, { rule, modes: requiredByModes }] of requirements) {
    const p = principal === "UNKNOWN" ? { state: "ERROR" as const, reason: "bound principal identity is unreadable" } : proofFor(rows, runtime, principal, capability, requiredByModes, rule.competentSource);
    const satisfied = rule.acceptedStates.includes(p.state);
    comparisons.push({
      capability, requirement: rule.requirement, accepted_states: rule.acceptedStates, state: p.state, satisfied,
      competent_source: rule.competentSource, operating_modes: requiredByModes,
      proof_ref: p.row?.ref ?? "NOT_FOUND", evidence_ref: p.row?.evidence_ref ?? "UNKNOWN", verified_at: p.row?.verified_at ?? "UNKNOWN",
      reason: p.reason, next_human_action: rule.nextHumanAction,
    });
  }
  const required = comparisons.filter((c) => c.requirement === "REQUIRED");
  const incomplete = required.filter((c) => !c.satisfied);
  return {
    profile_state: snap.capability_proofs === "NOT_FOUND" || snap.capability_proofs === undefined ? "NOT_FOUND" : "PRESENT",
    operating_modes: modes,
    required_total: required.length,
    required_verified: required.length - incomplete.length,
    complete: incomplete.length === 0,
    comparisons,
    incomplete_required: incomplete.map((c) => c.capability),
    next_human_action: incomplete[0]?.next_human_action ?? "NONE",
  };
}
