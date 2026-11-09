/** W7.3-R2 — native source identity attestation → human confirmation → guarded first link.
 * The transport is the existing capability_evidence, not a new tool or an OAuth assertion.
 * The server cannot authenticate a human reply or inspect the native app's private transcript:
 * both are assistant attestations. A signed token protects their scope, not their factual truth.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { BindingRecord } from "../binding/store.ts";
import type { NotionReadClient } from "../notion/readClient.ts";
import { normalizeId, propText, type Page } from "../notion/shapes.ts";
import type { Intent, IntentMutation } from "../plans/prepare.ts";
import type { Plan } from "../plans/store.ts";
import type { ResolvedRuntime } from "../resolvers/types.ts";
import type { ResumeState } from "./derive.ts";
import type { CapabilityEvidence, CapabilityRemediationOutcome } from "./capabilityRemediation.ts";
import { rehydrate } from "./engine.ts";
import type { BackendStore } from "../store/memory.ts";

type Descriptor = NonNullable<NonNullable<ResolvedRuntime["adapter"]["capabilities"]>["sourceIdentityEnrollment"]>[number];
const TTL = 10 * 60_000;
export const SOURCE_ENROLLMENT_PROTOCOL = "SOURCE_IDENTITY_ENROLLMENT/1";
export interface SourceEnrollmentChallenge {
  readonly protocol: typeof SOURCE_ENROLLMENT_PROTOCOL;
  readonly stage: "OBSERVE" | "CONFIRM";
  readonly challenge: string; readonly capability: string; readonly competent_source: string;
  readonly source_label: string; readonly expires_at: string;
  readonly source_identity?: string; readonly evidence_ref?: string; readonly verified_at?: string;
  /** Output-only exact arguments; the assistant still has to attest the current human reply. */
  readonly completion_args?: { readonly capability_evidence: CapabilityEvidence };
  readonly decline_args?: { readonly capability_evidence: CapabilityEvidence };
}
interface Payload {
  protocol: typeof SOURCE_ENROLLMENT_PROTOCOL; stage: "OBSERVE" | "CONFIRM";
  principal: string; runtime: string; generation: string; root: string; pins: string;
  descriptor: Descriptor; issued: string; expires: string;
  confirmation_nonce?: string;
  identity?: string; evidence?: string; observed?: string;
}
const ownedIntents = new WeakSet<object>();
const ownedMutations = new WeakMap<object, string>();
const attestations = new WeakMap<object, NonNullable<Plan["state_last_write"]["source_identity_enrollment"]>>();
const scope = (r: ResolvedRuntime) => JSON.stringify([r.runtime_id, r.runtime_generation, r.root_ref, pins(r)]);
const pins = (r: ResolvedRuntime) => JSON.stringify([r.versions.governing_spec, r.versions.governing_schema, r.versions.governing_control]);
const enabled = (r: ResolvedRuntime, d: Descriptor) => r.lane === "SALES"
  && Array.isArray(r.observations.source_identity_enrollment)
  && r.observations.source_identity_enrollment.includes(d.source)
  && r.adapter.controlPlane.resources?.[d.resourceKey]?.backendDerivedOnly === true;
const descriptors = (r: ResolvedRuntime) => (r.adapter.capabilities?.sourceIdentityEnrollment ?? []).filter(d => enabled(r, d));
const INVALID_CHALLENGE = "first-link challenge is invalid for the current binding and authority";
const LOG_DIAGNOSTIC = /^SOURCE_ENROLLMENT_(?:TOKEN_SHAPE_INVALID|TOKEN_PAYLOAD_INVALID|TOKEN_SIGNATURE_INVALID(?:;UNTRUSTED_(?:BODY_(?:UNPARSEABLE|NOT_INSPECTED)|AUTHORITY_FIELDS_MATCH|AUTHORITY_FIELDS_DIFFER:(?:principal|runtime|generation|root|pins)(?:,(?:principal|runtime|generation|root|pins))*))?|AUTHORITY_MISMATCH:(?:principal|runtime|generation|root|pins)(?:,(?:principal|runtime|generation|root|pins))*)$/;
/** Only the closed diagnostic vocabulary is eligible for the existing tool access line. */
export function sourceEnrollmentLogDiagnostic(evidence: readonly string[]): string | undefined {
  if (evidence[0] !== INVALID_CHALLENGE || typeof evidence[1] !== "string") return;
  const value = evidence[1], match = LOG_DIAGNOSTIC.exec(value);
  return match?.[0] === value ? value : undefined;
}
const clean = (v: string, d: Descriptor) => d.identityKind === "email" ? v.trim().toLowerCase() : v.trim();
const validIdentity = (v: string, d: Descriptor) => v.length > 0 && v.length <= 320 && v !== "UNKNOWN"
  && !/[;|\p{Cc}]/u.test(v) && (d.identityKind !== "email" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v));
const firstMissing = (s: Partial<ResumeState>) => s.capability_completeness?.comparisons.find(c => c.requirement === "REQUIRED" && !c.satisfied);
function signature(b: BindingRecord, body: string): string {
  return createHmac("sha256", `${SOURCE_ENROLLMENT_PROTOCOL}:${b.binding_id}:${b.handle_hash}`).update(body).digest("base64url");
}
function token(b: BindingRecord, p: Payload): string {
  const body = Buffer.from(JSON.stringify(p)).toString("base64url"); return `sid1.${body}.${signature(b, body)}`;
}
type Decoded = { readonly payload: Payload } | { readonly diagnostic: string; readonly untrustedBody?: string };
function decode(b: BindingRecord, value: string): Decoded {
  const [prefix, body, sig, extra] = value.split(".");
  if (prefix !== "sid1" || !body || !sig || extra !== undefined) return { diagnostic: "SOURCE_ENROLLMENT_TOKEN_SHAPE_INVALID" };
  const wanted = Buffer.from(signature(b, body)), actual = Buffer.from(sig);
  if (wanted.length !== actual.length || !timingSafeEqual(wanted, actual))
    return { diagnostic: "SOURCE_ENROLLMENT_TOKEN_SIGNATURE_INVALID", untrustedBody: body };
  try { const p = JSON.parse(Buffer.from(body, "base64url").toString()) as Payload;
    return p?.protocol === SOURCE_ENROLLMENT_PROTOCOL && ["OBSERVE", "CONFIRM"].includes(p.stage)
      ? { payload: p } : { diagnostic: "SOURCE_ENROLLMENT_TOKEN_PAYLOAD_INVALID" };
  } catch { return { diagnostic: "SOURCE_ENROLLMENT_TOKEN_PAYLOAD_INVALID" }; }
}
function authorityDifferences(p: Partial<Payload>, b: BindingRecord, r: ResolvedRuntime): string[] {
  const expected = { principal: b.principal_id, runtime: r.runtime_id, generation: r.runtime_generation, root: r.root_ref, pins: pins(r) };
  return (Object.keys(expected) as Array<keyof typeof expected>).filter(k => p[k] !== expected[k]);
}
/** Never authenticate from this parse: only fixed labels leave on the already-refused path. */
function unsignedBodyDiagnostic(body: string, b: BindingRecord, r: ResolvedRuntime): string {
  if (body.length > 8192) return "UNTRUSTED_BODY_NOT_INSPECTED";
  try {
    const p: unknown = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!p || typeof p !== "object" || Array.isArray(p)) return "UNTRUSTED_BODY_UNPARSEABLE";
    const fields = authorityDifferences(p as Partial<Payload>, b, r);
    return fields.length ? `UNTRUSTED_AUTHORITY_FIELDS_DIFFER:${fields.join(",")}` : "UNTRUSTED_AUTHORITY_FIELDS_MATCH";
  } catch { return "UNTRUSTED_BODY_UNPARSEABLE"; }
}
function reply(b: BindingRecord, p: Payload, encoded = token(b, p)): SourceEnrollmentChallenge {
  const evidence = p.stage === "CONFIRM" && p.identity && p.evidence && p.observed ? {
    challenge: encoded, competent_source: p.descriptor.source, source_identity: p.identity, verified_at: p.observed,
  } : undefined;
  return { protocol: SOURCE_ENROLLMENT_PROTOCOL, stage: p.stage, challenge: encoded,
    capability: p.descriptor.capability, competent_source: p.descriptor.source, source_label: p.descriptor.label,
    expires_at: p.expires, ...(p.identity ? { source_identity: p.identity, evidence_ref: p.evidence, verified_at: p.observed } : {}),
    ...(evidence ? {
      completion_args: { capability_evidence: { ...evidence, evidence_ref: `user-confirmed:${p.evidence}` } },
      decline_args: { capability_evidence: { ...evidence, evidence_ref: `user-declined:${p.evidence}` } },
    } : {}) };
}
const hold = (reason: string, diagnostic?: string): Extract<CapabilityRemediationOutcome, { kind: "HOLD" }> => ({ kind: "HOLD",
  code: "HOLD_ACTION_NOT_AUTHORIZED", evidence: [reason, ...(diagnostic ? [diagnostic] : [])], safe_action: "resume with the current binding; do not infer or replace a source identity" });

/** Issued only after fresh hydration holds on the first REQUIRED source and its identity is empty. */
export function issueSourceEnrollmentChallenge(b: BindingRecord, r: ResolvedRuntime, s: Partial<ResumeState>, now: Date): SourceEnrollmentChallenge | undefined {
  const missing = firstMissing(s);
  const d = descriptors(r).find(x => x.capability === missing?.capability && x.source === missing.competent_source);
  if (!d || b.binding_mode !== "BUSINESS" || b.lane !== r.lane || b.runtime_id !== r.runtime_id || b.runtime_generation !== r.runtime_generation) return;
  // No interpretation of a cached app tag; the observed Manifest must be empty.
  const value = r.observations[d.observationKey];
  if (value !== "UNKNOWN" && value !== "") return;
  const expires = new Date(Math.min(now.getTime() + TTL, b.expires_at.getTime()));
  if (expires <= now) return;
  return reply(b, { protocol: SOURCE_ENROLLMENT_PROTOCOL, stage: "OBSERVE", descriptor: d,
    principal: b.principal_id, runtime: r.runtime_id, generation: r.runtime_generation, root: r.root_ref,
    pins: pins(r), issued: now.toISOString(), expires: expires.toISOString() });
}

const CONFIRMATION_EVENT = "SOURCE_ENROLLMENT_CONFIRMATION";
const lastConfirmation = async (store: BackendStore, b: BindingRecord, r: ResolvedRuntime) =>
  (await store.events.list({ binding_id: b.binding_id, runtime_id: r.runtime_id, event_type: CONFIRMATION_EVENT, newest_first: true, limit: 1 }))[0];

/** Mechanics only, never a provider proof or business state. No token is written to access logs. */
export async function rememberSourceEnrollmentConfirmation(store: BackendStore, b: BindingRecord, r: ResolvedRuntime, enrollment: SourceEnrollmentChallenge, now: Date, result: "PENDING" | "DECLINED" = "PENDING"): Promise<void> {
  const last = await lastConfirmation(store, b, r);
  if (last?.result === result && last.detail?.["challenge"] === enrollment.challenge) return;
  await store.events.append({ event_type: CONFIRMATION_EVENT, result, principal_id: b.principal_id,
    binding_id: b.binding_id, runtime_id: r.runtime_id, detail: { challenge: enrollment.challenge }, created_at: now });
}

/** Legacy stateless confirmations remain valid only when no newer pending/decline exists. */
export async function sourceEnrollmentConfirmationIsCurrent(store: BackendStore, b: BindingRecord, r: ResolvedRuntime, challenge: string): Promise<boolean> {
  const last = await lastConfirmation(store, b, r);
  return !last || last.principal_id === b.principal_id && last.result === "PENDING" && last.detail?.["challenge"] === challenge;
}

/** Reuses this turn's fresh hydration; never rehydrates the OS to retrieve a pending prompt. */
export async function resumeSourceEnrollmentChallenge(store: BackendStore, b: BindingRecord, r: ResolvedRuntime, s: Partial<ResumeState>, now: Date): Promise<SourceEnrollmentChallenge | undefined> {
  const observe = issueSourceEnrollmentChallenge(b, r, s, now);
  if (!observe) return;
  const last = await lastConfirmation(store, b, r);
  const encoded = last?.detail?.["challenge"];
  if (last?.result !== "PENDING" || last.principal_id !== b.principal_id || typeof encoded !== "string") return observe;
  const decoded = decode(b, encoded);
  if (!("payload" in decoded)) return observe;
  const p = decoded.payload, issued = Date.parse(p.issued), expires = Date.parse(p.expires);
  const d = descriptors(r).find(x => JSON.stringify(x) === JSON.stringify(p.descriptor));
  const expected = d?.expectedObservationKey ? r.observations[d.expectedObservationKey] : undefined;
  if (p.stage !== "CONFIRM" || authorityDifferences(p, b, r).length || !d
    || d.capability !== observe.capability || d.source !== observe.competent_source
    || !Number.isFinite(issued) || !Number.isFinite(expires) || issued > now.getTime() || expires <= now.getTime()
    || expires - issued > TTL || expires > b.expires_at.getTime() || !p.identity || !validIdentity(p.identity, d)
    || !p.evidence?.trim() || !p.observed || !Number.isFinite(Date.parse(p.observed))
    || Date.parse(p.observed) < issued || Date.parse(p.observed) > expires
    || typeof expected === "string" && expected.trim() && expected.trim().toUpperCase() !== "UNKNOWN" && p.identity !== clean(expected, d)) return observe;
  return reply(b, p, encoded);
}

export type SourceEnrollmentOutcome = CapabilityRemediationOutcome
  | { readonly kind: "CONFIRM"; readonly enrollment: SourceEnrollmentChallenge }
  | { readonly kind: "DECLINED"; readonly enrollment: SourceEnrollmentChallenge };
export const isSourceEnrollmentEvidence = (e: CapabilityEvidence): boolean => e.challenge.startsWith("sid1.");
export async function deriveSourceEnrollment(notion: NotionReadClient, b: BindingRecord, r: ResolvedRuntime, e: CapabilityEvidence, now: Date): Promise<SourceEnrollmentOutcome> {
  const decoded = decode(b, e.challenge);
  if (!("payload" in decoded)) return hold(INVALID_CHALLENGE, decoded.diagnostic + (decoded.untrustedBody
    ? `;${unsignedBodyDiagnostic(decoded.untrustedBody, b, r)}` : ""));
  const p = decoded.payload, fields = authorityDifferences(p, b, r);
  if (fields.length) return hold(INVALID_CHALLENGE, `SOURCE_ENROLLMENT_AUTHORITY_MISMATCH:${fields.join(",")}`);
  const issued = Date.parse(p.issued), expires = Date.parse(p.expires), observed = Date.parse(e.verified_at);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > now.getTime() || expires <= now.getTime() || expires - issued > TTL || expires > b.expires_at.getTime()) return hold("first-link challenge expired or has an invalid lifetime");
  const d = descriptors(r).find(x => JSON.stringify(x) === JSON.stringify(p.descriptor));
  if (!d || e.competent_source !== d.source || b.binding_mode !== "BUSINESS") return hold("first-link source is not enabled by the current operator and contract");
  const resumed = await rehydrate(notion, b, r);
  const missing = resumed.kind === "HOLD" && resumed.code === "HOLD_REQUIRED_CAPABILITY_INCOMPLETE" ? firstMissing(resumed.partial) : undefined;
  if (missing?.capability !== d.capability || missing.competent_source !== d.source) return hold("first missing capability changed; no identity was linked");
  const manifest = await notion.retrievePage(r.manifest_ref) as Page;
  if (propText(manifest, d.property)?.trim()) return hold("source identity is already linked; this protocol cannot replace it");
  const identity = clean(e.source_identity ?? "", d);
  const expected = d.expectedObservationKey ? r.observations[d.expectedObservationKey] : undefined;
  if (typeof expected === "string" && expected.trim() && expected.trim().toUpperCase() !== "UNKNOWN" && identity !== clean(expected, d))
    return hold("observed source identity differs from the registry's declared ownership claim");
  if (!validIdentity(identity, d) || !e.evidence_ref.trim() || !Number.isFinite(observed) || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(e.verified_at)
    || observed < issued || observed > expires || observed > now.getTime() + 30_000) return hold("native profile identity or evidence is missing or outside the challenge window");
  // Replaying an observation may ask anew, but must never resurrect a declined/superseded CONFIRM.
  // A random nonce, not the clock, keeps distinct emissions distinct even within one millisecond.
  if (p.stage === "OBSERVE") return { kind: "CONFIRM", enrollment: reply(b, { ...p, stage: "CONFIRM", confirmation_nonce: randomBytes(16).toString("hex"), identity, evidence: e.evidence_ref, observed: e.verified_at }) };
  if (identity !== p.identity || e.verified_at !== p.observed) return hold("confirmation must attest the exact observed identity after an explicit human reply");
  if (e.evidence_ref === `user-declined:${p.evidence}`) return { kind: "DECLINED", enrollment: reply(b, p, e.challenge) };
  if (e.evidence_ref !== `user-confirmed:${p.evidence}`) return hold("confirmation must attest the exact observed identity after an explicit human reply");
  const mutation: IntentMutation = { logical_resource_key: d.resourceKey, operation: "UPDATE",
    record_selector: { natural_key: "CURRENT", existing_object_id: r.manifest_ref }, desired_changes: { [d.property]: identity } };
  const intent: Intent = { action_class: "COMMIT", summary: "First source identity, native observation explicitly confirmed by the member", mutations: [mutation] };
  Object.freeze(mutation.record_selector); Object.freeze(mutation.desired_changes); Object.freeze(mutation);
  Object.freeze(intent.mutations); Object.freeze(intent);
  ownedMutations.set(mutation, scope(r)); ownedIntents.add(intent);
  attestations.set(intent, Object.freeze({ protocol: SOURCE_ENROLLMENT_PROTOCOL, source: d.source,
    identity, evidence_ref: p.evidence!, observed_at: p.observed!, confirmed_at: now.toISOString(),
    confirmation_challenge_sha256: createHash("sha256").update(e.challenge).digest("hex"),
    confirmation: "ASSISTANT_ATTESTED_EXPLICIT_USER_REPLY", principal_id: b.principal_id }));
  return { kind: "READY", capability: d.capability, intent };
}
export const isBackendOwnedSourceEnrollmentIntent = (intent: Intent): boolean => ownedIntents.has(intent);
export const sourceEnrollmentAttestation = (intent: Intent) => attestations.get(intent);
export function isBackendOwnedSourceEnrollmentMutation(r: ResolvedRuntime, m: IntentMutation): boolean {
  const recorded = ownedMutations.get(m);
  return !!recorded && recorded === scope(r)
    && descriptors(r).some(d => d.resourceKey === m.logical_resource_key && Object.keys(m.desired_changes).length === 1 && validIdentity(String(m.desired_changes[d.property] ?? ""), d))
    && Object.isFrozen(m) && m.operation === "UPDATE" && normalizeId(m.record_selector.existing_object_id) === normalizeId(r.manifest_ref);
}
/** Persisted backend plan, not caller input. TARGET/FINAL may complete this link while reads remain missing. */
export function isSourceEnrollmentPlan(r: ResolvedRuntime, p: Plan): boolean {
  const op = p.operations[0];
  const attestation = p.state_last_write.source_identity_enrollment;
  return p.plan_kind === "BUSINESS" && p.lane === r.lane && p.runtime_id === r.runtime_id && p.runtime_generation === r.runtime_generation
    && attestation?.protocol === SOURCE_ENROLLMENT_PROTOCOL && attestation.principal_id === p.principal_id
    && attestation.confirmation === "ASSISTANT_ATTESTED_EXPLICIT_USER_REPLY" && !!attestation.evidence_ref
    && p.operations.length === 1 && !!op && op.operation === "UPDATE" && op.natural_key === "CURRENT"
    && normalizeId(op.physical_target_ref) === normalizeId(r.manifest_ref)
    && descriptors(r).some(d => d.source === attestation.source && d.resourceKey === op.logical_resource_key && op.compared_fields.length === 1 && op.compared_fields[0] === d.property
      && !op.before_values[d.property] && op.expected_values[d.property] === attestation.identity && validIdentity(attestation.identity, d));
}

/** Restore only the exact backend-attested first-link mutation for fresh guard classification on resume. */
export function sourceEnrollmentMutationForPlan(r: ResolvedRuntime, p: Plan): IntentMutation | undefined {
  if (!isSourceEnrollmentPlan(r, p)) return;
  const op = p.operations[0]!;
  const mutation: IntentMutation = { logical_resource_key: op.logical_resource_key, operation: "UPDATE",
    record_selector: { natural_key: "CURRENT", existing_object_id: r.manifest_ref },
    desired_changes: { [op.compared_fields[0]!]: p.state_last_write.source_identity_enrollment!.identity } };
  Object.freeze(mutation.record_selector); Object.freeze(mutation.desired_changes); Object.freeze(mutation);
  ownedMutations.set(mutation, scope(r));
  return mutation;
}

/** One bounded local lookup: a later decline or distinct emission revokes an unstarted link. */
export async function sourceEnrollmentPlanConsentIsCurrent(store: BackendStore, b: BindingRecord, r: ResolvedRuntime, p: Plan): Promise<boolean> {
  const accepted = p.state_last_write.source_identity_enrollment?.confirmation_challenge_sha256;
  if (!accepted || !/^[a-f0-9]{64}$/.test(accepted)) return false;
  const last = await lastConfirmation(store, b, r), challenge = last?.detail?.["challenge"];
  return last?.principal_id === b.principal_id && last.result === "PENDING" && typeof challenge === "string"
    && createHash("sha256").update(challenge).digest("hex") === accepted;
}

/** Every transaction byte refuses a different identity linked concurrently. */
export async function sourceEnrollmentStillValid(notion: NotionReadClient, r: ResolvedRuntime, intent: Intent): Promise<boolean> {
  if (!isBackendOwnedSourceEnrollmentIntent(intent)) return true;
  const m = intent.mutations[0]!;
  const d = descriptors(r).find(x => x.resourceKey === m.logical_resource_key);
  if (!d || !isBackendOwnedSourceEnrollmentMutation(r, m)) return false;
  try { const current = propText(await notion.retrievePage(r.manifest_ref) as Page, d.property)?.trim() ?? "";
    return current === "" || current === m.desired_changes[d.property];
  } catch { return false; }
}

export async function sourceEnrollmentPlanStillValid(notion: NotionReadClient, r: ResolvedRuntime, p: Plan): Promise<boolean> {
  if (!isSourceEnrollmentPlan(r, p)) return false;
  const op = p.operations[0]!;
  try { const current = propText(await notion.retrievePage(r.manifest_ref) as Page, op.compared_fields[0]!)?.trim() ?? "";
    return current === "" || current === op.expected_values[op.compared_fields[0]!];
  } catch { return false; }
}
