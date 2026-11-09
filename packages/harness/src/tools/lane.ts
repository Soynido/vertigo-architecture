import type { Lane } from "./envelope.ts";

/**
 * Lane scoping of logical resource keys (PT-BIND-003).
 * Logical resource keys are namespaced by lane: `META:<resource>` or `SALES:<resource>`.
 * The lane of every later call is taken from the binding, never from arguments; an intent whose
 * resource keys belong to another lane is refused (HOLD_CROSS_LANE), and a key without a lane
 * namespace cannot be scoped (HOLD_RESOURCE_UNKNOWN).
 */
export type LaneScope = { readonly kind: "IN_LANE" } | { readonly kind: "CROSS_LANE"; readonly keys: readonly string[] } | { readonly kind: "UNSCOPED"; readonly keys: readonly string[] };

export function laneOfResourceKey(key: string): Lane | undefined {
  if (key.startsWith("META:")) return "META";
  if (key.startsWith("SALES:")) return "SALES";
  return undefined;
}

export function checkLaneScope(boundLane: Lane, resourceKeys: readonly string[]): LaneScope {
  const unscoped = resourceKeys.filter((k) => laneOfResourceKey(k) === undefined);
  if (unscoped.length > 0) return { kind: "UNSCOPED", keys: unscoped };
  const cross = resourceKeys.filter((k) => laneOfResourceKey(k) !== boundLane);
  if (cross.length > 0) return { kind: "CROSS_LANE", keys: cross };
  return { kind: "IN_LANE" };
}
