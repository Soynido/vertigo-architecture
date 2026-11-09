import type { Authority } from "./types.ts";

/**
 * Effective Authority = the strictest of the pinned and the currently published constraints, per constraint.
 * Current stricter Authority overrides a looser pin; a mid-run relaxation never silently broadens the original.
 */
export function strictest(pinned: Authority, current: Authority): Authority {
  const allowed = pinned.allowed_action_types === "ANY" ? current.allowed_action_types : current.allowed_action_types === "ANY" ? pinned.allowed_action_types : pinned.allowed_action_types.filter((t) => (current.allowed_action_types as readonly string[]).includes(t));
  const steps = [pinned.max_sequence_step, current.max_sequence_step].filter((s): s is number => typeof s === "number");
  return {
    version: `${pinned.version}+${current.version}`,
    requires_human_approval: pinned.requires_human_approval || current.requires_human_approval,
    allowed_action_types: allowed,
    ...(steps.length > 0 ? { max_sequence_step: Math.min(...steps) } : {}),
    send_paused: pinned.send_paused === true || current.send_paused === true,
  };
}
