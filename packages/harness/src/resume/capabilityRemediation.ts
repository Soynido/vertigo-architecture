/**
 * Backend-owned REQUIRED-capability remediation.
 *
 * os_resume issues a short-lived, binding-secret-signed challenge for exactly the first missing REQUIRED
 * capability. os_prepare accepts only the narrow competent-source evidence below, fresh-rehydrates the runtime,
 * revalidates the challenge, and derives the sole canonical Capability Profile intent. Raw callers can neither
 * choose the target nor manufacture an internally-authorized proof intent.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { BindingRecord } from "../binding/store.ts";
import type { HoldCode } from "../errors/codes.ts";
import type { CompetentSource } from "../effects/gmail.ts";
import type { NotionReadClient } from "../notion/readClient.ts";
import type { Intent, IntentMutation } from "../plans/prepare.ts";
import type { Plan } from "../plans/store.ts";
import type { ResolvedRuntime } from "../resolvers/types.ts";
import { capabilityProofKey, type CapabilityComparison, type CapabilityCompleteness } from "./capabilities.ts";
import type { ResumeState } from "./derive.ts";
import { rehydrate } from "./engine.ts";
import { SALES_CONTROL_PLANE_0513_CANDIDATE, SALES_CONTROL_PLANE_0514_CANDIDATE } from "../versions/adapters/controlPlane.ts";

const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const FUTURE_SKEW_MS = 30 * 1000;
const TOKEN_VERSION = 1 as const;
const REMEDIABLE_READ_CAPABILITIES: Readonly<Record<string, string>> = {
  NOTION_RUNTIME_READ: "NOTION",
  GMAIL_READ: "GMAIL",
  CALENDAR_READ: "GOOGLE_CALENDAR",
};

export interface CapabilityEvidence {
  readonly challenge: string;
  readonly competent_source: string;
  /** Required and externally verified for Gmail. Other native reads are bound to the signed runtime principal. */
  readonly source_identity?: string | undefined;
  readonly evidence_ref: string;
  readonly verified_at: string;
}

export interface CapabilityRemediationChallenge {
  readonly challenge: string;
  readonly capability: string;
  readonly competent_source: string;
  readonly issued_at: string;
  readonly expires_at: string;
}

interface ChallengePayload {
  readonly v: typeof TOKEN_VERSION;
  readonly runtime_id: string;
  readonly runtime_generation: string;
  readonly spec: string;
  readonly schema: string;
  readonly control: string;
  readonly capability: string;
  readonly competent_source: string;
  readonly operating_mode: string;
  readonly accepted_state: "READ_VERIFIED";
  readonly issued_at: string;
  readonly expires_at: string;
}

export type CapabilityRemediationOutcome =
  | { readonly kind: "READY"; readonly intent: Intent; readonly capability: string }
  | { readonly kind: "HOLD"; readonly code: HoldCode; readonly evidence: readonly string[]; readonly safe_action: string };

/** Object-identity provenance: JSON/raw tool input can never enter this set. */
const BACKEND_OWNED_INTENTS = new WeakSet<object>();
const BACKEND_OWNED_MUTATIONS = new WeakMap<object, {
  runtime_id: string; generation: string; root: string; pins: ReturnType<typeof versions>;
}>();

/** Only the immutable factory object on the exact candidate runtime can acquire a reconciliation class. */
export function isBackendOwnedCapabilityMutation(runtime: ResolvedRuntime, mutation: IntentMutation): boolean {
  const provenance = BACKEND_OWNED_MUTATIONS.get(mutation);
  const pins = versions(runtime);
  return provenance !== undefined && runtime.lane === "SALES"
    && [SALES_CONTROL_PLANE_0513_CANDIDATE, SALES_CONTROL_PLANE_0514_CANDIDATE].includes(runtime.adapter.controlPlane)
    && mutation.logical_resource_key === "SALES:CAPABILITY_PROOFS"
    && mutation.logical_resource_key === runtime.adapter.capabilities?.capabilityProofResource
    && mutation.operation === "CREATE" && Object.isFrozen(mutation)
    && provenance.runtime_id === runtime.runtime_id && provenance.generation === runtime.runtime_generation
    && provenance.root === runtime.root_ref && provenance.pins.spec === pins.spec
    && provenance.pins.schema === pins.schema && provenance.pins.control === pins.control;
}

function freezeDerived(value: object): void {
  for (const child of Object.values(value)) if (child !== null && typeof child === "object") freezeDerived(child);
  Object.freeze(value);
}

export function isBackendOwnedCapabilityIntent(intent: Intent): boolean {
  return BACKEND_OWNED_INTENTS.has(intent as object);
}

/** Pure match of a stored factory proof; does not grant mutation provenance or authorize execution. */
export function storedCapabilityProofMatches(runtime: ResolvedRuntime, plan: Plan, current: CapabilityComparison | undefined): boolean {
  const saved = plan.state_last_write.guard_mutations;
  const op = plan.operations[0], mutation = saved?.[0], values = mutation?.desired_changes;
  const pins = versions(runtime), principal = principalKey(runtime);
  if (!current || current.requirement !== "REQUIRED" || current.satisfied || !principal
    || plan.plan_kind !== "BUSINESS" || plan.run_mode !== "OPEN_NEW" || plan.recovers_plan_id
    || (plan.plan_origin ?? "INTENT") !== "INTENT" || plan.lane !== "SALES" || runtime.lane !== "SALES"
    || plan.runtime_id !== runtime.runtime_id || plan.runtime_generation !== runtime.runtime_generation
    || plan.governing_spec_version !== pins.spec || plan.governing_schema_version !== pins.schema || plan.governing_control_version !== pins.control
    || plan.operations.length !== 1 || saved?.length !== 1 || !op || !mutation || !values
    || mutation.logical_resource_key !== "SALES:CAPABILITY_PROOFS" || op.logical_resource_key !== mutation.logical_resource_key
    || mutation.operation !== "CREATE" || op.operation !== "CREATE" || op.natural_key_property !== "Capability Proof Key"
    || Object.keys(op.before_values).length !== 0 || !current.accepted_states.includes("READ_VERIFIED")
    || REMEDIABLE_READ_CAPABILITIES[current.capability] !== current.competent_source) return false;
  const source = current.competent_source, identity = sourceIdentity(runtime, source);
  const mode = values["Operating Mode"], verified = values["Verified At"], evidence = values["Evidence Ref"];
  if (identity === "UNKNOWN" || typeof mode !== "string" || !current.operating_modes.includes(mode)
    || typeof verified !== "string" || validInstant(verified) === undefined || new Date(verified).toISOString() !== verified
    || typeof evidence !== "string" || !evidence.trim()) return false;
  const expected = { "Capability Proof": `${current.capability} verified by ${source}`, "Capability Key": current.capability,
    State: "READ_VERIFIED", "Runtime ID": runtime.runtime_id, "Principal Key": principal, "Operating Mode": mode,
    "Competent Source": source, "Evidence Ref": evidence, "Verified At": verified,
    Scope: `principal:${principal};runtime:${runtime.runtime_id};source:${source};identity:${normalizeIdentity(source, identity)};access:read` };
  const key = capabilityProofKey({ runtimeId: runtime.runtime_id, principalKey: principal, capability: current.capability, operatingMode: mode, verifiedAt: verified, evidenceRef: evidence });
  if (!isDeepStrictEqual(values, expected) || !isDeepStrictEqual(mutation.record_selector, { natural_key: key })
    || op.natural_key !== key || !isDeepStrictEqual(op.expected_values, { ...expected, "Capability Proof Key": key })
    || !isDeepStrictEqual([...op.compared_fields].sort(), Object.keys(op.expected_values).sort())) return false;
  return true;
}

/** Restore only an exact stored factory proof. Never called with tool input or a Notion row. */
export function capabilityMutationForPlan(runtime: ResolvedRuntime, plan: Plan, current: CapabilityComparison | undefined): IntentMutation | undefined {
  if (!storedCapabilityProofMatches(runtime, plan, current)) return;
  const mutation = plan.state_last_write.guard_mutations![0]!;
  const pins = versions(runtime);
  const restored = structuredClone(mutation);
  freezeDerived(restored);
  BACKEND_OWNED_MUTATIONS.set(restored, { runtime_id: runtime.runtime_id, generation: runtime.runtime_generation, root: runtime.root_ref, pins });
  return isBackendOwnedCapabilityMutation(runtime, restored) ? restored : undefined;
}

function versionValue(v: ResolvedRuntime["versions"]["governing_spec"]): string {
  return v === "UNKNOWN" ? "UNKNOWN" : v.value;
}

function versions(runtime: ResolvedRuntime): Pick<ChallengePayload, "spec" | "schema" | "control"> {
  return {
    spec: versionValue(runtime.versions.governing_spec),
    schema: versionValue(runtime.versions.governing_schema),
    control: versionValue(runtime.versions.governing_control),
  };
}

function completenessOf(state: Partial<ResumeState>): CapabilityCompleteness | undefined {
  const value = state.capability_completeness;
  return value && typeof value === "object" ? value as CapabilityCompleteness : undefined;
}

function firstMissing(state: Partial<ResumeState>): CapabilityComparison | undefined {
  return completenessOf(state)?.comparisons.find((c) => c.requirement === "REQUIRED" && !c.satisfied);
}

function principalKey(runtime: ResolvedRuntime): string | undefined {
  const value = runtime.observations["rep_identity_key"];
  return typeof value === "string" && value !== "" && value !== "UNKNOWN" ? value : undefined;
}

function sourceIdentity(runtime: ResolvedRuntime, source: string): string {
  if (source === "GMAIL") {
    const mailbox = runtime.observations["mailbox_identity"];
    return typeof mailbox === "string" && mailbox.trim() !== "" && mailbox.trim().toUpperCase() !== "UNKNOWN" ? mailbox.trim().toLowerCase() : "UNKNOWN";
  }
  // The current runtime contract has no canonical Notion-workspace or Calendar-account identity. Until it does,
  // their signed native-read attestations bind to the authenticated runtime principal. This does not prove which
  // external workspace/account was read; it prevents a proof from crossing principals or runtimes.
  return principalKey(runtime) ?? "UNKNOWN";
}

function normalizeIdentity(source: string, value: string): string {
  const trimmed = value.trim();
  return source === "GMAIL" ? trimmed.toLowerCase() : trimmed;
}

function secret(binding: BindingRecord): string {
  // binding_id is random server state and is never returned on the tool surface; handle_hash adds binding-specific
  // key material without introducing configuration or a new persistence surface.
  return `${binding.binding_id}:${binding.handle_hash}`;
}

function sign(binding: BindingRecord, body: string): string {
  return createHmac("sha256", secret(binding)).update(body, "utf8").digest("base64url");
}

function encode(binding: BindingRecord, payload: ChallengePayload): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `v1.${body}.${sign(binding, body)}`;
}

function decode(binding: BindingRecord, token: string): ChallengePayload | undefined {
  const [prefix, body, supplied, extra] = token.split(".");
  if (prefix !== "v1" || !body || !supplied || extra !== undefined) return undefined;
  const expected = Buffer.from(sign(binding, body), "utf8");
  const actual = Buffer.from(supplied, "utf8");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ChallengePayload;
    return parsed.v === TOKEN_VERSION ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function validInstant(value: string): number | undefined {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function sameCurrentRequirement(payload: ChallengePayload, current: CapabilityComparison, runtime: ResolvedRuntime): boolean {
  const declaredSource = REMEDIABLE_READ_CAPABILITIES[current.capability];
  return payload.capability === current.capability
    && payload.competent_source === current.competent_source
    && current.operating_modes.includes(payload.operating_mode)
    && declaredSource !== undefined
    && current.competent_source === declaredSource
    && current.accepted_states.includes("READ_VERIFIED")
    && sourceIdentity(runtime, current.competent_source) !== "UNKNOWN";
}

/** Called only when fresh os_resume is holding on REQUIRED capability completeness. */
export function issueCapabilityChallenge(binding: BindingRecord, runtime: ResolvedRuntime, state: Partial<ResumeState>, now: Date): CapabilityRemediationChallenge | undefined {
  const missing = firstMissing(state);
  const principal = principalKey(runtime);
  const mode = missing?.operating_modes[0];
  const declaredSource = missing ? REMEDIABLE_READ_CAPABILITIES[missing.capability] : undefined;
  if (!missing || !principal || !mode || binding.lane !== "SALES" || !declaredSource || missing.competent_source !== declaredSource || !missing.accepted_states.includes("READ_VERIFIED")) return undefined;
  const expires = new Date(Math.min(now.getTime() + CHALLENGE_TTL_MS, binding.expires_at.getTime()));
  if (expires <= now) return undefined;
  const identity = sourceIdentity(runtime, missing.competent_source);
  if (identity === "UNKNOWN") return undefined;
  const payload: ChallengePayload = {
    v: TOKEN_VERSION,
    runtime_id: runtime.runtime_id,
    runtime_generation: runtime.runtime_generation,
    ...versions(runtime),
    capability: missing.capability,
    competent_source: missing.competent_source,
    operating_mode: mode,
    accepted_state: "READ_VERIFIED",
    issued_at: now.toISOString(),
    expires_at: expires.toISOString(),
  };
  return {
    challenge: encode(binding, payload),
    capability: payload.capability,
    competent_source: payload.competent_source,
    issued_at: payload.issued_at,
    expires_at: payload.expires_at,
  };
}

/** Rehydrate, validate the bounded evidence, and derive the exact append-only proof transaction. */
export async function deriveCapabilityRemediation(
  notion: NotionReadClient,
  binding: BindingRecord,
  runtime: ResolvedRuntime,
  evidence: CapabilityEvidence,
  now: Date,
  competentSource?: CompetentSource,
): Promise<CapabilityRemediationOutcome> {
  const payload = decode(binding, evidence.challenge);
  if (!payload) return { kind: "HOLD", code: "HOLD_ACTION_NOT_AUTHORIZED", evidence: ["capability challenge is malformed or not signed for this binding"], safe_action: "call os_resume again and use only its fresh capability challenge" };
  const issuedAt = validInstant(payload.issued_at);
  const expiresAt = validInstant(payload.expires_at);
  if (issuedAt === undefined || expiresAt === undefined || expiresAt - issuedAt > CHALLENGE_TTL_MS || expiresAt <= now.getTime()) {
    return { kind: "HOLD", code: "HOLD_PLAN_EXPIRED", evidence: ["capability challenge expired or has an invalid lifetime"], safe_action: "call os_resume again to obtain a fresh capability challenge" };
  }
  if (payload.runtime_id !== runtime.runtime_id || payload.runtime_generation !== runtime.runtime_generation) {
    return { kind: "HOLD", code: "HOLD_CROSS_RUNTIME", evidence: ["capability challenge does not belong to this binding, principal or runtime generation"], safe_action: "call os_resume on this binding and use only its challenge" };
  }
  const currentVersions = versions(runtime);
  if (payload.spec !== currentVersions.spec || payload.schema !== currentVersions.schema || payload.control !== currentVersions.control) {
    return { kind: "HOLD", code: "HOLD_VERSION_CHANGED", evidence: ["the governing versions changed after the capability challenge was issued"], safe_action: "call os_bind and os_resume again under the current governing versions" };
  }

  const resumed = await rehydrate(notion, binding, runtime);
  if (resumed.kind !== "HOLD" || resumed.code !== "HOLD_REQUIRED_CAPABILITY_INCOMPLETE") {
    return { kind: "HOLD", code: "HOLD_REQUIRED_CAPABILITY_INCOMPLETE", evidence: ["fresh durable state no longer exposes the challenged missing capability"], safe_action: "call os_resume and continue from the fresh durable state" };
  }
  const missing = firstMissing(resumed.partial);
  if (!missing || !sameCurrentRequirement(payload, missing, runtime)) {
    return { kind: "HOLD", code: "HOLD_REQUIRED_CAPABILITY_INCOMPLETE", evidence: ["the first missing REQUIRED capability changed after the challenge was issued"], safe_action: "call os_resume again and verify the newly returned first missing capability" };
  }

  if (evidence.competent_source !== payload.competent_source) {
    return { kind: "HOLD", code: "HOLD_REQUIRED_CAPABILITY_INCOMPLETE", evidence: ["competent source does not match the governing capability requirement"], safe_action: "perform the read with the competent native source named by os_resume" };
  }
  const expectedIdentity = normalizeIdentity(payload.competent_source, sourceIdentity(runtime, payload.competent_source));
  if (expectedIdentity === "" || expectedIdentity === "UNKNOWN") {
    return { kind: "HOLD", code: "HOLD_REQUIRED_CAPABILITY_INCOMPLETE", evidence: ["the signed runtime identity is unavailable"], safe_action: "restore the Sales runtime owner identity, then resume" };
  }
  // Gmail exposes a canonical mailbox identity and must independently match it. Calendar and Notion do not have
  // a canonical external-account field in this contract line: their proof scope is therefore derived from the
  // signed challenge's principal/runtime binding, never from a caller-supplied internal key.
  if (payload.competent_source === "GMAIL") {
    const observedIdentity = normalizeIdentity("GMAIL", evidence.source_identity ?? "");
    if (observedIdentity === "" || observedIdentity !== expectedIdentity) {
      return { kind: "HOLD", code: "HOLD_MAILBOX_IDENTITY_MISMATCH", evidence: ["native-source identity does not match the mailbox bound to this runtime"], safe_action: "connect the Gmail mailbox that belongs to this Sales runtime, then resume" };
    }
  }
  // When a server-side competent-source adapter is configured, its live identity independently corroborates the
  // native evidence. Without one, this path remains a signed, runtime-bound native-read attestation rather than a
  // claim that the read occurred inside the harness.
  if (payload.competent_source === "GMAIL" && competentSource) {
    const liveIdentity = await competentSource.identity();
    if (liveIdentity === "UNKNOWN") return { kind: "HOLD", code: "HOLD_EXTERNAL_SOURCE_UNAVAILABLE", evidence: ["backend competent-source identity is UNKNOWN"], safe_action: "restore readable Gmail identity, then resume" };
    if (normalizeIdentity("GMAIL", liveIdentity) !== expectedIdentity) return { kind: "HOLD", code: "HOLD_MAILBOX_IDENTITY_MISMATCH", evidence: ["backend competent-source identity differs from the bound runtime mailbox"], safe_action: "connect the Gmail mailbox that belongs to this Sales runtime" };
  }
  const verifiedAt = validInstant(evidence.verified_at);
  if (verifiedAt === undefined || verifiedAt < issuedAt || verifiedAt > expiresAt || verifiedAt > now.getTime() + FUTURE_SKEW_MS) {
    return { kind: "HOLD", code: "HOLD_REQUIRED_CAPABILITY_INCOMPLETE", evidence: ["competent-source verification time is outside the challenge window"], safe_action: "perform a fresh native read, then submit its evidence immediately" };
  }
  if (!evidence.evidence_ref.trim()) {
    return { kind: "HOLD", code: "HOLD_REQUIRED_CAPABILITY_INCOMPLETE", evidence: ["native read returned no durable evidence reference"], safe_action: "perform a fresh native read that returns a durable evidence reference" };
  }
  const principal = principalKey(runtime);
  if (!principal) return { kind: "HOLD", code: "HOLD_PERMISSION_UNKNOWN", evidence: ["bound Sales principal identity is unreadable"], safe_action: "restore the runtime owner identity, then bind again" };

  // The native Notion writer round-trips datetime properties at minute precision. Validate the competent-source
  // instant above at its original precision, then canonicalize only the durable Notion representation so TARGET
  // compares what Notion can faithfully return. The proof key must embed that same canonical value.
  const notionVerifiedAt = new Date(Math.floor(verifiedAt / 60_000) * 60_000).toISOString();
  const naturalKey = capabilityProofKey({
    runtimeId: runtime.runtime_id,
    principalKey: principal,
    capability: payload.capability,
    operatingMode: payload.operating_mode,
    verifiedAt: notionVerifiedAt,
    evidenceRef: evidence.evidence_ref,
  });
  const intent: Intent = {
    action_class: "COMMIT",
    summary: "append verified capability proof",
    mutations: [{
      logical_resource_key: "SALES:CAPABILITY_PROOFS",
      operation: "CREATE",
      record_selector: { natural_key: naturalKey },
      desired_changes: {
        "Capability Proof": `${payload.capability} verified by ${payload.competent_source}`,
        "Capability Key": payload.capability,
        State: payload.accepted_state,
        "Runtime ID": runtime.runtime_id,
        "Principal Key": principal,
        "Operating Mode": payload.operating_mode,
        "Competent Source": payload.competent_source,
        "Evidence Ref": evidence.evidence_ref,
        "Verified At": notionVerifiedAt,
        Scope: `principal:${principal};runtime:${runtime.runtime_id};source:${payload.competent_source};identity:${expectedIdentity};access:read`,
      },
    }],
  };
  freezeDerived(intent);
  BACKEND_OWNED_MUTATIONS.set(intent.mutations[0]!, {
    runtime_id: runtime.runtime_id, generation: runtime.runtime_generation,
    root: runtime.root_ref, pins: currentVersions,
  });
  BACKEND_OWNED_INTENTS.add(intent as object);
  return { kind: "READY", intent, capability: payload.capability };
}
