import type { Code, ErrorCode, HoldCode, OkCode } from "../errors/codes.ts";

/** Explicit epistemic markers. Never null where null would hide meaning. */
export type Unknown = "UNKNOWN";
export type NotFound = "NOT_FOUND";
export type NotYetCreated = "NOT_YET_CREATED";
export type NotApplicable = "NOT_APPLICABLE";
export type Epistemic = Unknown | NotFound | NotYetCreated | NotApplicable;

export type Lane = "META" | "SALES";
export type BindingState = "BOUND" | "STALE" | "REVOKED" | "EXPIRED";

export interface BindingSummary {
  readonly project: string;
  readonly lane: Lane;
  readonly binding_state: BindingState | Unknown;
  readonly runtime_logical_key: string | Epistemic;
  readonly runtime_id: string | Epistemic;
  readonly runtime_generation: string | Epistemic;
  /** FIXTURE = test runtime (never evidence about live company data); LIVE = canonical runtime. */
  readonly runtime_scope: "FIXTURE" | "LIVE";
}

export interface VersionsSummary {
  readonly governing_spec: string | Epistemic;
  readonly governing_schema: string | Epistemic;
  readonly governing_control: string | Epistemic;
  readonly candidate_versions: readonly string[];
  readonly historical_run_pins?: Readonly<Record<string, string>>;
}

export interface NextStep {
  readonly safe_action: string;
  /**
   * The next VERTIGO tool the caller may call. It is scoped to the six tools and says nothing about the native
   * apps — so it must be ABSENT whenever native work has to happen first. A field named "permitted tool call"
   * naming `os_verify` while writes are still pending reads as permission to verify now, and a caller that
   * trusts the structured field over the prose skips the writes and verifies nothing.
   */
  readonly permitted_tool_call?: string;
  /**
   * Work in a native app that must be completed BEFORE any tool call is permitted. Present exactly when
   * `permitted_tool_call` is absent for that reason, so the two are never both plausible at once.
   */
  /**
   * The exact intent that records the answer this step is waiting for, everything filled but the seller's own
   * words. Present only alongside `permitted_tool_call: "os_prepare"`, so the call and its payload arrive
   * together and nothing has to be assembled from the declaration.
   */
  readonly prepare_intent?: unknown;
  /** How to fill `prepare_intent` (the `$answer` placeholder). Beside the intent, never inside it: the intent is sent as is. */
  readonly prepare_note?: string;
  readonly native_actions_required?: {
    readonly app: string;
    readonly count: number;
    readonly source_field: string;
    /** The tool that becomes permitted once, and only once, every action has been executed. */
    readonly then_call: string;
  };
  /**
   * The conduct for THIS reply: what the caller does with it, written by the backend for the situation it has just
   * observed (PV-CONDUCT-001). It travels with every envelope, so it is live on every call — unlike the skill and
   * the tool descriptions, which the client reads once at initialize and caches for the whole connector lifetime.
   * Behaviour therefore ships by redeploying the backend, never by asking every seller to recreate the connector.
   * When it and a general document differ, this field is the more specific and wins for this reply.
   */
  readonly conduct?: string;
}

interface Base<TCode extends Code> {
  readonly code: TCode;
  readonly binding: BindingSummary | Unknown;
  readonly versions: VersionsSummary | Unknown;
  readonly observations: Readonly<Record<string, unknown>>;
  readonly warnings: readonly string[];
  readonly next: NextStep;
  /** User-facing sentence (French), supplied by the harness glossary; the model repeats it verbatim (PV0-020B). */
  readonly say?: string;
  /** The single question to ask the user, only when a human answer is required. */
  readonly ask?: string;
}

export interface OkEnvelope<T = Record<string, unknown>> extends Base<OkCode> {
  readonly status: "OK";
  readonly result: T;
}
export interface HoldEnvelope extends Base<HoldCode> {
  readonly status: "HOLD";
  readonly evidence: readonly string[];
}
export interface ErrorEnvelope extends Base<ErrorCode> {
  readonly status: "ERROR";
  readonly message: string;
}

export type Envelope<T = Record<string, unknown>> = OkEnvelope<T> | HoldEnvelope | ErrorEnvelope;

const UNKNOWN: Unknown = "UNKNOWN";

export function hold(code: HoldCode, safe_action: string, evidence: readonly string[] = [], partial: Partial<Omit<HoldEnvelope, "status" | "code" | "evidence">> = {}): HoldEnvelope {
  return { status: "HOLD", code, evidence, binding: UNKNOWN, versions: UNKNOWN, observations: {}, warnings: [], ...partial, next: { safe_action, ...(partial.next ?? {}) } };
}

export function error(code: ErrorCode, message: string, safe_action: string, partial: Partial<Omit<ErrorEnvelope, "status" | "code" | "message" | "next">> = {}): ErrorEnvelope {
  return { status: "ERROR", code, message, binding: UNKNOWN, versions: UNKNOWN, observations: {}, warnings: [], ...partial, next: { safe_action } };
}

export function ok<T>(code: OkCode, result: T, partial: Partial<Omit<OkEnvelope<T>, "status" | "code" | "result">> & { next: NextStep }): OkEnvelope<T> {
  return { status: "OK", code, result, binding: UNKNOWN, versions: UNKNOWN, observations: {}, warnings: [], ...partial };
}
