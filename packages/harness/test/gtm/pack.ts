/**
 * GTM-W03 — CANDIDATE CONTEXT PACK (test-only, never adopted).
 *
 * A self-contained read-selection builder for the two GTM needs. It deliberately does NOT import, extend, wrap or
 * re-register the adopted Contract Pack: the adopted pack's behavior must stay exactly as it is, and this module
 * exists only so that W03 can machine-check the candidate selection rules on controlled fixtures.
 *
 * Read-selection symbols confer no mutation authority, and a pack never replaces rehydration: `fresh_rehydration_required`
 * is part of the value precisely so a test can assert it.
 */
import { createHash } from "node:crypto";
import { CANDIDATE_MARKERS, markerLabel, type CandidateMarker } from "./catalog.ts";
import { canonicalize, GTM_CONTEXT_KEYS, type GtmWorld } from "./world.ts";
import { principalOf, runtimeOf } from "./oracle.ts";

export const CANDIDATE_PACK_MARKER: CandidateMarker =
  CANDIDATE_MARKERS.find((m) => m.family === "CONTRACT_PACK") as CandidateMarker;

export type Lane = "META" | "SALES";
export const GTM_NEEDS = ["META_GTM_ANALYSIS", "SALES_GTM_CONTEXT"] as const;
export type GtmNeed = (typeof GTM_NEEDS)[number];

const NEED_LANE: Readonly<Record<GtmNeed, Lane>> = { META_GTM_ANALYSIS: "META", SALES_GTM_CONTEXT: "SALES" };

/** The complete authorized selection per need. There is no wildcard and no read-all fallback anywhere. */
const NEED_RESOURCES: Readonly<Record<GtmNeed, readonly string[]>> = {
  META_GTM_ANALYSIS: [GTM_CONTEXT_KEYS.META_SALES_RUNTIME_INPUTS, GTM_CONTEXT_KEYS.META_GTM_METRIC_REFS],
  SALES_GTM_CONTEXT: [GTM_CONTEXT_KEYS.SALES_GTM_CAMPAIGN_CONTEXT],
};

/** The fixed per-lane denominator `omitted_resource_keys` is computed against. */
export const LANE_AUTHORIZED_RESOURCES: Readonly<Record<Lane, readonly string[]>> = {
  META: [GTM_CONTEXT_KEYS.META_SALES_RUNTIME_INPUTS, GTM_CONTEXT_KEYS.META_GTM_METRIC_REFS],
  SALES: [GTM_CONTEXT_KEYS.SALES_GTM_CAMPAIGN_CONTEXT],
};

export type Completeness = "COMPLETE" | "NEEDS_EXPANSION" | "HOLD";
export type CompletenessReason = "NONE" | "cross_lane_rejected" | "unknown_need_token" | "context_not_registered" | "no_runtime_bound";

export interface PackPointer {
  readonly resource_key: string;
  readonly refs: readonly string[];
  readonly availability: "AVAILABLE" | "UNAVAILABLE_NOT_REGISTERED";
  readonly reason: string;
  readonly provenance: Readonly<Record<string, string | number | boolean>>;
}

export interface CandidatePack {
  readonly policy_version_marker: string;
  readonly policy_role: "CANDIDATE_NOT_ADOPTED";
  readonly lane: Lane;
  readonly requested_needs: readonly string[];
  readonly normalized_needs: readonly GtmNeed[];
  readonly bound: { readonly principal_key: string; readonly runtime_key: string | null; readonly runtime_generation: string | null };
  readonly selected_pointers: readonly PackPointer[];
  readonly omitted_resource_keys: readonly string[];
  readonly completeness: Completeness;
  readonly completeness_reason: CompletenessReason;
  readonly state_fingerprint: string;
  readonly pack_id: string;
  /** A read-selection symbol is never authority to mutate anything. */
  readonly confers_mutation_authority: false;
  /** The pack is a read plan; the transaction path still rehydrates from durable state. */
  readonly fresh_rehydration_required: true;
}

export interface PackInput {
  readonly world: GtmWorld;
  readonly lane: Lane;
  readonly principal_key: string;
  readonly needs: readonly string[];
}

const digest = (s: string): string => `sha256:${createHash("sha256").update(s, "utf8").digest("hex")}`;

export function buildCandidatePack(input: PackInput): CandidatePack {
  const { world, lane, principal_key } = input;
  const principal = principalOf(world, principal_key);
  const runtime_key = principal?.runtime_key ?? null;
  const runtime_generation = runtime_key === null ? null : runtimeOf(world, runtime_key)?.runtime_generation ?? null;

  const known = input.needs.filter((n): n is GtmNeed => (GTM_NEEDS as readonly string[]).includes(n));
  const unknown = input.needs.filter((n) => !(GTM_NEEDS as readonly string[]).includes(n));
  const inLane = known.filter((n) => NEED_LANE[n] === lane);
  const crossLane = known.filter((n) => NEED_LANE[n] !== lane);

  const wanted = [...new Set(inLane.flatMap((n) => [...NEED_RESOURCES[n]]))];
  const selected: PackPointer[] = runtime_key === null ? [] : LANE_AUTHORIZED_RESOURCES[lane]
    .filter((k) => wanted.includes(k))
    .map((resource_key) => {
      const row = world.registered_context.find((c) =>
        c.context_resource_key === resource_key && c.runtime_key === runtime_key && c.owner_principal_key === principal_key && c.lane === lane);
      if (row === undefined || row.registration_state !== "REGISTERED") {
        return {
          resource_key, refs: [], availability: "UNAVAILABLE_NOT_REGISTERED" as const,
          reason: "this context is not registered for the bound principal and runtime; read nothing and claim nothing",
          provenance: { registration_state: row?.registration_state ?? "ABSENT", runtime_key, owner_principal_key: principal_key },
        };
      }
      return {
        resource_key, refs: [...row.refs], availability: "AVAILABLE" as const,
        reason: "registered context of the bound principal's own runtime; read it with the native app",
        provenance: { registration_state: row.registration_state, runtime_key, owner_principal_key: principal_key },
      };
    });

  const completeness: Completeness =
    runtime_key === null ? "HOLD"
      : crossLane.length > 0 ? "HOLD"
        : unknown.length > 0 ? "NEEDS_EXPANSION"
          : selected.some((p) => p.availability === "UNAVAILABLE_NOT_REGISTERED") ? "NEEDS_EXPANSION" : "COMPLETE";
  const completeness_reason: CompletenessReason =
    runtime_key === null ? "no_runtime_bound"
      : crossLane.length > 0 ? "cross_lane_rejected"
        : unknown.length > 0 ? "unknown_need_token"
          : selected.some((p) => p.availability === "UNAVAILABLE_NOT_REGISTERED") ? "context_not_registered" : "NONE";

  const state_fingerprint = digest(canonicalize({
    marker: markerLabel(CANDIDATE_PACK_MARKER), runtime_key, runtime_generation,
    refs: selected.map((p) => ({ resource_key: p.resource_key, refs: p.refs })),
  }));
  const selectedKeys = selected.map((p) => p.resource_key);

  return {
    policy_version_marker: markerLabel(CANDIDATE_PACK_MARKER), policy_role: "CANDIDATE_NOT_ADOPTED", lane,
    requested_needs: [...input.needs],
    normalized_needs: inLane,
    bound: { principal_key, runtime_key, runtime_generation },
    selected_pointers: selected,
    omitted_resource_keys: LANE_AUTHORIZED_RESOURCES[lane].filter((k) => !selectedKeys.includes(k)),
    completeness, completeness_reason, state_fingerprint,
    pack_id: digest(canonicalize({ state_fingerprint, needs: inLane, pointers: selected, marker: markerLabel(CANDIDATE_PACK_MARKER) })),
    confers_mutation_authority: false, fresh_rehydration_required: true,
  };
}

/** A pack pinned to a superseded runtime generation is stale by construction. */
export const isPackStale = (pack: CandidatePack, world: GtmWorld): boolean =>
  pack.bound.runtime_key !== null && (runtimeOf(world, pack.bound.runtime_key)?.runtime_generation ?? null) !== pack.bound.runtime_generation;

export type SteerResult =
  | { readonly accepted: true; readonly rehydration: "FRESH_REQUIRED" }
  | { readonly accepted: false; readonly code: "REFUSED_STALE_PACK"; readonly reason: string };

/** A stale pack can never steer a new Run: it is refused, and a fresh rehydration is required in every case. */
export function steerNewRun(pack: CandidatePack, world: GtmWorld): SteerResult {
  if (isPackStale(pack, world)) {
    return { accepted: false, code: "REFUSED_STALE_PACK", reason: "the pack is pinned to a superseded runtime generation" };
  }
  return { accepted: true, rehydration: "FRESH_REQUIRED" };
}

/** Handing a read-selection symbol to a mutation catalog fails closed: it is not a mutation target. */
export const submitSymbolToMutationCatalog = (symbol: string): { readonly refused: true; readonly code: "UNKNOWN_MUTATION_TARGET"; readonly symbol: string } =>
  ({ refused: true, code: "UNKNOWN_MUTATION_TARGET", symbol });
