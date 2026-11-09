/**
 * os_handoff (PV0-018): a terminal handoff derived ONLY from fresh durable runtime state. The caller supplies a
 * binding handle and, at most, a display format hint; NEXT, current gate, reserved next and target lane are
 * never accepted. A handoff carries a state fingerprint: when durable state changes, the old handoff loses
 * authority. When durable state has no deterministic next action (or is ambiguous), the result is
 * HOLD_NO_DURABLE_HANDOFF with an UNKNOWN target — never an invented NEXT.
 */
import { createHash } from "node:crypto";
import type { BindingRecord } from "../binding/store.ts";
import type { HoldCode } from "../errors/codes.ts";
import type { ResumeState } from "../resume/derive.ts";
import type { ResumeOutcome } from "../resume/engine.ts";
import type { Lane } from "../tools/envelope.ts";

export interface Handoff {
  readonly handoff_id: string;
  readonly derived_at: string;
  readonly source: {
    readonly lane: Lane;
    readonly runtime_id: string;
    readonly runtime_generation: string;
    readonly cursor_ref: string;
    readonly cursor_last_edited: string;
    readonly current_run: string;
    readonly gate: string;
    readonly hold: string;
  };
  /** Target lane is the bound lane unless a durable rule says otherwise; no durable cross-lane rule exists in the current grammars. */
  readonly target_lane: Lane | "UNKNOWN";
  readonly cross_lane_rule: "NONE_IN_GOVERNING_GRAMMAR";
  readonly next_action: string;
  readonly next_question: string;
  readonly open_blocker: string;
  readonly external_actions_pending: number | "NOT_APPLICABLE" | "UNKNOWN";
  /** Fingerprint of the durable facts the handoff was derived from; a different fingerprint means this handoff is stale. */
  readonly state_fingerprint: string;
  readonly valid_while: "state_fingerprint unchanged";
  readonly terminal_text: string;
}

export type HandoffOutcome = { readonly kind: "READY"; readonly handoff: Handoff } | { readonly kind: "HOLD"; readonly code: HoldCode; readonly evidence: readonly string[]; readonly safe_action: string; readonly partial: Partial<Handoff> };

const fp = (parts: readonly unknown[]): string => createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);

function runLabel(state: Partial<ResumeState>): string {
  const r = state.current_run;
  if (!r) return "UNKNOWN";
  if (typeof r === "string") return r;
  return `${r.run_id} (${r.status})`;
}

export function deriveHandoff(binding: BindingRecord, resumed: ResumeOutcome, now: Date, formatHint?: string): HandoffOutcome {
  const state: Partial<ResumeState> = resumed.kind === "OK" ? resumed.state : resumed.partial;
  const gate = state.gate ? `${state.gate.gate_key} (${state.gate.status})` : "UNKNOWN";
  const hold = resumed.kind === "HOLD" ? resumed.code : state.effective_hold && state.effective_hold !== "NONE" ? state.effective_hold.code : "NONE";
  const cursorRef = state.cursor_ref ?? "UNKNOWN";
  const cursorEdited = typeof state.cursor_last_edited === "string" ? state.cursor_last_edited : "UNKNOWN";
  const nextAction = typeof state.next_safe_action === "string" && state.next_safe_action !== "UNKNOWN" && state.next_safe_action.trim() !== "" ? state.next_safe_action : "UNKNOWN";
  // The handoff question is the gate's Next Question, never its Next Action (P1 from the 2026-09-18 acceptance report).
  const nextQuestion = state.gate && typeof state.gate.formal_next_question === "string" && state.gate.formal_next_question !== "UNKNOWN" ? state.gate.formal_next_question : "UNKNOWN";
  const openBlocker = state.gate && typeof state.gate.formal_blocker === "string" ? state.gate.formal_blocker : "UNKNOWN";
  const fingerprint = fp([binding.runtime_generation, cursorRef, cursorEdited, runLabel(state), gate, hold, nextAction]);
  const source: Handoff["source"] = { lane: binding.lane, runtime_id: binding.runtime_id, runtime_generation: binding.runtime_generation, cursor_ref: cursorRef, cursor_last_edited: cursorEdited, current_run: runLabel(state), gate, hold };
  const partial: Partial<Handoff> = { derived_at: now.toISOString(), source, cross_lane_rule: "NONE_IN_GOVERNING_GRAMMAR", target_lane: "UNKNOWN", next_action: nextAction, next_question: nextQuestion, open_blocker: openBlocker, external_actions_pending: state.external_intents_unresolved ?? "UNKNOWN", state_fingerprint: fingerprint, valid_while: "state_fingerprint unchanged" };

  // No deterministic handoff: ambiguous durable state, unreadable control plane, or no durable next action anywhere.
  if (resumed.kind === "HOLD" && (resumed.code === "HOLD_RUN_AMBIGUOUS" || resumed.code === "HOLD_BOOTSTRAP_DISCOVERY" || resumed.code === "HOLD_REQUIRED_RESOURCE_MISSING")) {
    return { kind: "HOLD", code: "HOLD_NO_DURABLE_HANDOFF", evidence: [`durable state is ${resumed.code}: ${resumed.evidence.join("; ")}`, "no next lane/action can be derived; nothing is invented"], safe_action: "reconcile the durable state by hand (Runs / Manifest), then call os_handoff again", partial };
  }
  if (nextAction === "UNKNOWN") {
    return { kind: "HOLD", code: "HOLD_NO_DURABLE_HANDOFF", evidence: ["the Manifest/OS State carries no Next Action and the gate has no formal next action", `run ${runLabel(state)}, gate ${gate}, hold ${hold}`], safe_action: "write the next action durably in the runtime (Manifest/OS State or Gate) through a verified transaction, then call os_handoff again", partial };
  }
  const handoff: Handoff = { ...(partial as Omit<Handoff, "handoff_id" | "target_lane" | "terminal_text">), handoff_id: fp(["handoff", fingerprint, binding.binding_id]), target_lane: binding.lane, terminal_text: render(binding.lane, source, nextAction, nextQuestion, openBlocker, hold, fingerprint, formatHint) };
  return { kind: "READY", handoff };
}

function render(lane: Lane, s: Handoff["source"], next: string, question: string, blocker: string, hold: string, fingerprint: string, formatHint?: string): string {
  const lines = [
    `HANDOFF — ${lane} runtime ${s.runtime_id}`,
    `Current run: ${s.current_run}`,
    `Gate: ${s.gate}`,
    `Hold: ${hold}`,
    `Open blocker: ${blocker}`,
    `Next action: ${next}`,
    `Next question: ${question}`,
    `Target lane: ${lane}`,
    `State fingerprint: ${fingerprint} (this handoff is void if the fingerprint changes)`,
  ];
  return formatHint === "one_line" ? lines.join(" | ") : lines.join("\n");
}
