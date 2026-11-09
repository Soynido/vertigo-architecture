/**
 * GTM INTENT GRAMMAR — candidate (PV-GTM-002, W04/W05).
 *
 * Prepare-time (and verification-time) grammar for the GTM resources of the candidate Sales contract. It runs ONLY
 * when the bound runtime's governing adapter declares the `gtm` capability; on every other runtime it returns
 * undefined and the transaction path is unchanged.
 *
 * Three properties hold for every rule here:
 *  1. it ROUTES THROUGH THE SEMANTIC CORE — computability, coverage, attribution, disposition, episode counters,
 *     exposure and unit guards are the same functions the oracle uses, never a second implementation;
 *  2. it CROSS-CHECKS against durable state — a claimed touch, campaign, coverage window or parent version must
 *     exist in the runtime's own resources; a declared string is never self-certifying;
 *  3. it is REDACTED and FAIL-NARROW — evidence names fields and verdicts, never offers, prices, contacts or
 *     bodies, and an unavailable/unreadable resource is a HOLD, never an empty result.
 */
import type { IntentMutation } from "../plans/prepare.ts";
import type { LookupOutcome } from "../plans/resources.ts";
import { capabilityProofKey } from "../resume/capabilities.ts";
import type { CapabilityState, SalesCapabilities } from "../versions/adapters/sales.ts";
import { GTM_APPEND_ONLY_KEYS, GTM_RESOURCE_KEYS } from "../versions/adapters/controlPlane.ts";
import {
  ATTRIBUTION_LOOKBACK_DAYS, ATTRIBUTION_STATUSES, attributionVerdict, canonicalize, companyGlobalTotal, COVERAGE_SOURCES,
  COVERAGE_STATES, coverageDigest, coverageVerdict, computability, digestOf, dispositionOf, episodeStatuses,
  EPISODE_KINDS, exposureView, IDENTITY_RESOLUTIONS, INPUT_REVISION_REASONS, inputRevisionId, isIsoInstant,
  MEETING_STATUS_LADDER, meetingCounters, METRIC_DEFINITIONS_DIGEST, METRIC_DEFINITIONS_VERSION, METRIC_KEYS,
  metricDefinition, oneOf, PARTIES, rateOf, redact, REPLY_DISPOSITIONS, REPLY_INTENTS, REPLY_KINDS, snapshotKey,
  validateParisWeek, type CoverageDeclaration, type CoverageSource, type CoverageState, type EpisodeEvidence,
  type InputRevisionReason, type Period, type ReplyIntent, type ReplyKind, type TouchCandidate,
} from "./semantics.ts";

/** A durable row, projected to the properties a rule asked for. */
export type Row = Readonly<Record<string, string | null>>;

export interface GtmIntentContext {
  /** Rep identity of the authenticated principal. A GTM record may never name another rep. */
  readonly rep_identity_key: string | undefined;
  readonly runtime_id: string;
  readonly capabilities?: SalesCapabilities;
  /** Projected, fail-narrow lookup inside the bound runtime. */
  readonly find: (logicalKey: string, property: string, value: string, project: readonly string[]) => Promise<LookupOutcome>;
}

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : v === null || v === undefined ? "" : String(v).trim());
const has = (d: Readonly<Record<string, unknown>>, k: string): boolean => text(d[k]) !== "";
const missing = (d: Readonly<Record<string, unknown>>, keys: readonly string[]): readonly string[] => keys.filter((k) => !has(d, k));
const bool = (v: unknown): boolean => text(v).toLowerCase() === "true";

const PROOF = "no plan, no Run and no lease were created: the intent was refused before anything durable was touched";
const VERIFY_PROOF = "no receipt was issued: the durable state contradicts the plan's assumptions";

/** Every lookup is fail-narrow: anything but OK is a violation naming the failure mode, never an empty result. */
function rowsOrViolation(outcome: LookupOutcome, what: string, v: string[]): readonly Row[] | undefined {
  if (outcome.status === "OK") return outcome.rows;
  v.push(`${what} could not be checked against durable state (${outcome.status}): ${outcome.reason}`);
  return undefined;
}

/* ────────────────────────────── shared parsing ────────────────────────────── */

/** `ref|campaign|approach_version|participation|occurred_at`, several separated by `;`. Values stay symbolic keys. */
export function parseTouches(raw: string): readonly Omit<TouchCandidate, "durably_proven">[] {
  return raw.split(";").map((s) => s.trim()).filter((s) => s !== "").map((s) => {
    const [message_ref, campaign_key, approach_version_key, participation_key, occurred_at] = s.split("|").map((x) => x.trim());
    return {
      message_ref: message_ref ?? "",
      campaign_key: campaign_key === undefined || campaign_key === "" ? null : campaign_key,
      approach_version_key: approach_version_key === undefined || approach_version_key === "" ? null : approach_version_key,
      participation_key: participation_key === undefined || participation_key === "" ? null : participation_key,
      occurred_at: occurred_at ?? "",
    };
  });
}

/** `coverage_key|source|since|until|state`, several separated by `;`. */
export function parseCoverageRefs(raw: string): readonly string[] {
  return raw.split(";").map((s) => s.trim()).filter((s) => s !== "");
}

/* ────────────────────────────── identity rules (every GTM record) ────────────────────────────── */

function identityRules(d: Readonly<Record<string, unknown>>, ctx: GtmIntentContext): string[] {
  const v: string[] = [];
  if (has(d, "Owner Rep") && ctx.rep_identity_key !== undefined && text(d["Owner Rep"]) !== ctx.rep_identity_key) {
    v.push(`Owner Rep ${redact(d["Owner Rep"])} is not the bound principal; a record of this runtime never names another rep`);
  }
  if (has(d, "Runtime ID") && text(d["Runtime ID"]) !== ctx.runtime_id) {
    v.push(`Runtime ID ${redact(d["Runtime ID"])} is not the bound runtime; owner and runtime are preserved on every record`);
  }
  return v;
}

/* ────────────────────────────── capability proof journal (PV-GTM-002F) ────────────────────────────── */

function capabilityProofRules(d: Readonly<Record<string, unknown>>, m: IntentMutation, ctx: GtmIntentContext): string[] {
  const v: string[] = [];
  const required = ["Capability Proof", "Capability Key", "State", "Runtime ID", "Principal Key", "Operating Mode", "Competent Source", "Evidence Ref", "Verified At", "Scope"];
  const gaps = missing(d, required);
  if (gaps.length > 0) { v.push(`a capability proof carries its complete provenance; it is missing ${gaps.join(", ")}`); return v; }
  const mode = text(d["Operating Mode"]);
  const capability = text(d["Capability Key"]);
  const rule = ctx.capabilities?.operatingModeRequirements?.[mode]?.find((x) => x.capability === capability);
  if (!rule) v.push("the capability is not declared by the governing contract for this operating mode");
  if (text(d["Runtime ID"]) !== ctx.runtime_id) v.push("Runtime ID is not the bound runtime");
  if (ctx.rep_identity_key === undefined || text(d["Principal Key"]) !== ctx.rep_identity_key) v.push("Principal Key is not the authenticated owner of this Personal SALES runtime");
  if (rule && text(d["Competent Source"]) !== rule.competentSource) v.push("Competent Source is not the source declared by the governing capability contract");
  if (rule && !rule.acceptedStates.includes(text(d["State"]) as CapabilityState)) v.push("only a state accepted by the governing requirement may close capability onboarding");
  if (!isIsoInstant(text(d["Verified At"]))) v.push("Verified At must be an ISO instant carrying an explicit offset");
  if (!has(d, "Evidence Ref") || !has(d, "Scope")) v.push("competent-source evidence and its verified scope are mandatory");
  if (has(d, "Scope")) {
    const scopeTokens = text(d["Scope"]).split(/[;,]/).map((x) => x.trim());
    if (!scopeTokens.includes(`principal:${ctx.rep_identity_key ?? "UNKNOWN"}`) || !scopeTokens.includes(`runtime:${ctx.runtime_id}`)) v.push("Scope must bind the competent-source proof to the authenticated principal and bound runtime");
  }
  if (v.length === 0) {
    const expected = capabilityProofKey({
      runtimeId: ctx.runtime_id, principalKey: ctx.rep_identity_key as string, capability, operatingMode: mode,
      verifiedAt: text(d["Verified At"]), evidenceRef: text(d["Evidence Ref"]),
    });
    if (text(m.record_selector.natural_key) !== expected) v.push(`Capability Proof Key is derived from immutable provenance (expected ${expected})`);
  }
  return v;
}

/* ────────────────────────────── exposure (D05) ────────────────────────────── */

async function exposureRules(d: Readonly<Record<string, unknown>>, ctx: GtmIntentContext): Promise<string[]> {
  const v: string[] = [];
  const required = ["Contact", "Message Ref", "Campaign", "Approach Version", "Communicated Offer", "Pinned At"];
  const gaps = missing(d, required);
  if (gaps.length > 0) v.push(`an exposure pins what was actually communicated; it is missing ${gaps.join(", ")}`);
  if (has(d, "Pinned At") && !isIsoInstant(text(d["Pinned At"]))) v.push("Pinned At must be an ISO instant carrying an explicit offset");

  const campaignKey = text(d["Campaign"]);
  let configured_offer = "";
  let configured_price = "";
  if (campaignKey !== "") {
    const rows = rowsOrViolation(await ctx.find("SALES:CAMPAIGNS", "Campaign Key", campaignKey, ["Configured Offer", "Configured Price"]), "the campaign this exposure names", v);
    if (rows === undefined) return v;
    if (rows.length === 0) v.push("the exposure names a campaign that does not exist in this runtime");
    else {
      configured_offer = text(rows[0]?.["Configured Offer"]);
      configured_price = text(rows[0]?.["Configured Price"]);
    }
  }
  const view = exposureView({
    configured_offer, configured_price,
    communicated_offer: text(d["Communicated Offer"]),
    communicated_price: text(d["Communicated Price"]),
    price_communicated: bool(d["Price Communicated"]),
    currency: text(d["Currency"]), price_unit: text(d["Price Unit"]), price_scope: text(d["Price Scope"]),
    override_evidence: has(d, "Override Evidence") ? text(d["Override Evidence"]) : null,
    link_sent: bool(d["Link Sent"]),
    link_read_evidence: has(d, "Link Read Evidence") ? text(d["Link Read Evidence"]) : null,
  });
  v.push(...view.violations);
  if (bool(d["Link Read"]) && !view.link_read_proven) {
    v.push("an accessible link is not a read link: a read is stated only with its own evidence");
  }
  if (bool(d["Price Cause Claimed"]) && !view.price_is_a_possible_cause) {
    v.push("a price can only be a cause once it was actually communicated with its amount and currency");
  }
  if (text(d["Message Variant"]) === "PERSONALIZED" && !has(d, "Override Evidence")) {
    v.push("a personalized message is an observed override; it pins its evidence instead of attaching a template blindly");
  }
  return v;
}

/* ────────────────────────────── approach versions (D05) ────────────────────────────── */

async function approachVersionRules(d: Readonly<Record<string, unknown>>, ctx: GtmIntentContext): Promise<string[]> {
  const v: string[] = [];
  const parent = text(d["Variant Of"]);
  if (parent === "") return v;
  if (!has(d, "Authority Scope")) { v.push("a variant declares the Authority scope it stays inside"); return v; }
  const rows = rowsOrViolation(await ctx.find("SALES:APPROACH_VERSIONS", "Approach Version Key", parent, ["Authority Scope"]), "the version this variant derives from", v);
  if (rows === undefined) return v;
  if (rows.length === 0) { v.push("the variant derives from a version that does not exist in this runtime"); return v; }
  if (text(rows[0]?.["Authority Scope"]) !== text(d["Authority Scope"])) {
    v.push("a variant never widens Authority: the declared scope differs from the scope of the version it derives from");
  }
  return v;
}

/* ────────────────────────────── enrollments (D06) ────────────────────────────── */

async function enrollmentRules(d: Readonly<Record<string, unknown>>, m: IntentMutation, ctx: GtmIntentContext): Promise<string[]> {
  const v: string[] = [];
  if (m.operation !== "UPDATE") {
    const gaps = missing(d, ["Campaign", "Contact"]);
    if (gaps.length > 0) v.push(`an enrollment names its campaign and its contact; it is missing ${gaps.join(", ")}`);
  }
  const state = has(d, "State") ? text(d["State"]) : m.operation === "UPDATE" ? "" : "ACTIVE";
  if (state !== "" && state !== "ACTIVE" && state !== "ENDED") v.push(`State ${redact(state)} is neither ACTIVE nor ENDED`);
  const own = text(m.record_selector.natural_key);
  let contact = has(d, "Contact") ? text(d["Contact"]) : "";
  if (contact === "" && state === "ACTIVE" && own !== "") {
    const mine = rowsOrViolation(await ctx.find("SALES:ENROLLMENTS", "Enrollment Key", own, ["Contact"]), "the enrollment being updated", v);
    if (mine === undefined) return v;
    contact = text(mine[0]?.["Contact"]);
  }
  if (state === "ACTIVE" && contact !== "") {
    const rows = rowsOrViolation(await ctx.find("SALES:ENROLLMENTS", "Contact", contact, ["Enrollment Key", "State"]), "the other enrollments of this contact", v);
    if (rows === undefined) return v;
    const conflicting = rows.filter((r) => text(r["State"]) === "ACTIVE" && text(r["Enrollment Key"]) !== own);
    if (conflicting.length > 0) {
      v.push(`this contact already holds ${conflicting.length} ACTIVE enrollment(s) (${conflicting.map((r) => redact(r["Enrollment Key"])).join(", ")}); successive campaigns are temporal, never parallel`);
    }
  }
  if (m.operation !== "UPDATE" && has(d, "Campaign") && contact !== "") {
    const rows = rowsOrViolation(await ctx.find("SALES:ENROLLMENTS", "Contact", contact, ["Enrollment Key", "Campaign"]), "the history of this contact", v);
    if (rows === undefined) return v;
    if (rows.some((r) => text(r["Campaign"]) === text(d["Campaign"]) && text(r["Enrollment Key"]) !== own)) {
      v.push("this contact is already enrolled in that campaign; an account is never duplicated to re-enroll it");
    }
  }
  return v;
}

/* ────────────────────────────── meeting episodes (D04) ────────────────────────────── */

function episodeEvidenceOf(d: Readonly<Record<string, unknown>>): EpisodeEvidence {
  const at = (k: string): string | null => (has(d, k) ? text(d[k]) : null);
  return {
    meeting_episode_id: text(d["Meeting Episode ID"]),
    proposed_at: at("Proposed At"), accepted_at: at("Accepted At"), agreement_evidence_ref: at("Agreement Evidence Ref"),
    booked_at: at("Booked At"), held_at: at("Held At"), held_evidence_ref: at("Held Evidence Ref"),
    qualified_at: at("Qualified At"), canceled_at: at("Canceled At"),
    episode_kind: text(d["Episode Kind"]) === "INTERNAL" ? "INTERNAL" : "PROSPECT",
  };
}

function meetingRules(d: Readonly<Record<string, unknown>>): string[] {
  const v: string[] = [];
  const kind = text(d["Episode Kind"]);
  if (kind !== "" && !oneOf(EPISODE_KINDS, kind)) v.push(`Episode Kind ${redact(kind)} is not a known episode kind`);
  for (const stamp of ["Proposed At", "Accepted At", "Booked At", "Held At", "Qualified At", "Canceled At"]) {
    if (has(d, stamp) && !isIsoInstant(text(d[stamp]))) v.push(`${stamp} must be an ISO instant carrying an explicit offset`);
  }
  const status = text(d["Meeting Status"]);
  if (status === "") return v;
  if (!oneOf(MEETING_STATUS_LADDER, status)) {
    v.push(`Meeting Status ${redact(status)} is not a rung of the ladder (${MEETING_STATUS_LADDER.join(" then ")})`);
    return v;
  }
  if (kind === "INTERNAL" && (status === "BOOKED" || status === "HELD" || status === "QUALIFIED_DISCOVERY")) {
    v.push("an internal block is never a prospect meeting; it can carry no booking, no held and no qualification");
  }
  // The claimed rung must be the rung the evidence actually reaches, computed by the shared ladder.
  const reached = episodeStatuses(episodeEvidenceOf(d));
  if (status === "QUALIFIED_DISCOVERY") {
    const counters = meetingCounters([{ ...episodeEvidenceOf(d), episode_kind: "PROSPECT" }]);
    v.push(`qualified discovery cannot be stated: ${counters.qualified_reason}`);
  } else if (!reached.includes(status)) {
    v.push(`Meeting Status ${status} is not reached by the evidence on this record (reached: ${reached.length === 0 ? "NONE" : reached.join(", ")})`);
  }
  if (has(d, "Canceled At") && Object.prototype.hasOwnProperty.call(d, "Booked At") && !has(d, "Booked At")) {
    v.push("a cancellation changes the active status; it never erases the historical booking creation");
  }
  if (has(d, "Won") || has(d, "Revenue")) {
    v.push("a meeting is never revenue: no episode state creates a won deal or an amount");
  }
  return v;
}

/* ────────────────────────────── reply attributions (D01, D03) ────────────────────────────── */

async function attributionRules(d: Readonly<Record<string, unknown>>, ctx: GtmIntentContext): Promise<string[]> {
  const v: string[] = [];
  const gaps = missing(d, ["Reply Ref", "Contact", "Identity Resolution", "Reply At", "Attribution Status", "Reply Kind", "Reply Intent", "Party"]);
  if (gaps.length > 0) { v.push(`an attribution record carries its whole evidence; it is missing ${gaps.join(", ")}`); return v; }

  const identity = text(d["Identity Resolution"]);
  const kind = text(d["Reply Kind"]);
  const intent = text(d["Reply Intent"]);
  const party = text(d["Party"]);
  const claimed = text(d["Attribution Status"]);
  if (!oneOf(IDENTITY_RESOLUTIONS, identity)) v.push(`Identity Resolution ${redact(identity)} is not a known resolution state`);
  if (!oneOf(REPLY_KINDS, kind)) v.push(`Reply Kind ${redact(kind)} is not a known reply kind`);
  if (!oneOf(REPLY_INTENTS, intent)) v.push(`Reply Intent ${redact(intent)} is not a known reply intent`);
  if (!oneOf(PARTIES, party)) v.push(`Party ${redact(party)} is not a known party`);
  if (!oneOf(ATTRIBUTION_STATUSES, claimed)) v.push(`Attribution Status ${redact(claimed)} is not a known attribution status`);
  if (!isIsoInstant(text(d["Reply At"]))) v.push("Reply At must be an ISO instant carrying an explicit offset");
  if (has(d, "Disposition") && !oneOf(REPLY_DISPOSITIONS, text(d["Disposition"]))) v.push(`Disposition ${redact(d["Disposition"])} is not a known disposition`);
  if (has(d, "Counterfactual")) v.push("no counterfactual is certain: an objection keeps its context and never becomes a proven cause");
  if (v.length > 0) return v;

  // Every declared touch is cross-checked against the runtime's own durable exposures: a declared string is
  // never proof. A touch that is not durably found stays a candidate but can never attribute the reply.
  const declared = parseTouches(text(d["Prior Touches"]));
  const touches: TouchCandidate[] = [];
  for (const t of declared) {
    if (t.message_ref === "") continue;
    const rows = rowsOrViolation(
      await ctx.find("SALES:EXPOSURES", "Message Ref", t.message_ref, ["Campaign", "Approach Version", "Participation", "Pinned At"]),
      "a declared prior touch", v,
    );
    if (rows === undefined) return v;
    const row = rows[0];
    const proven = row !== undefined
      && text(row["Campaign"]) === (t.campaign_key ?? "")
      && text(row["Approach Version"]) === (t.approach_version_key ?? "")
      && (text(row["Participation"]) === (t.participation_key ?? "") || text(row["Participation"]) === "");
    touches.push({ ...t, durably_proven: proven });
  }
  const undurable = touches.filter((t) => !t.durably_proven);

  const inReplyTo = text(d["In Reply To"]);
  const verdict = attributionVerdict({
    identity_resolution: identity as "CANONICAL" | "UNRESOLVED",
    reply_at: text(d["Reply At"]),
    prior_touches: touches,
    ...(inReplyTo === "" ? {} : { in_reply_to: inReplyTo }),
  });
  if (claimed !== verdict.status) {
    v.push(`Attribution Status ${claimed} contradicts the evidence: ${verdict.status} — ${verdict.reason} (bounded lookback ${ATTRIBUTION_LOOKBACK_DAYS} calendar days${undurable.length > 0 ? `; ${undurable.length} declared touch(es) are not durably proven` : ""})`);
  }
  const namedTouch = text(d["Attributed To"]);
  if (verdict.status === "ATTRIBUTED" && verdict.attributed_to !== null && namedTouch !== verdict.attributed_to.message_ref) {
    v.push("Attributed To is not the touch the threading evidence proves");
  }
  if (verdict.status === "ATTRIBUTED" && verdict.attributed_to === null && namedTouch !== "") {
    v.push("no single message may be named: the evidence attributes this reply to a campaign/approach/participation group, never to the most recent touch");
  }
  if (verdict.status === "ATTRIBUTED" && verdict.attributed_to === null) {
    const group = text(d["Attributed Group"]);
    const expected = canonicalize(verdict.attributed_group);
    if (group === "" ) v.push("a group attribution names the group it is attributed to");
    else if (digestOf(group).slice(0, 8) !== digestOf(expected).slice(0, 8) && group !== `${verdict.attributed_group?.campaign_key}|${verdict.attributed_group?.approach_version_key}|${verdict.attributed_group?.participation_key}`) {
      v.push("Attributed Group is not the group the evidence proves");
    }
  }
  if (verdict.status !== "ATTRIBUTED" && namedTouch !== "") {
    v.push("no touch may be named when the evidence does not attribute the reply");
  }
  if (verdict.candidates.length > 0) {
    const preserved = text(d["Candidates"]).split(";").map((s) => s.trim()).filter((s) => s !== "");
    const expected = verdict.candidates.map((c) => c.message_ref);
    if (preserved.length !== expected.length || expected.some((e) => !preserved.includes(e))) {
      v.push(`every plausible candidate stays preserved; the evidence carries ${expected.length} and the record carries ${preserved.length}`);
    }
  }

  const disposition = dispositionOf({
    kind: kind as ReplyKind, intent: intent as ReplyIntent,
    party: party === "INTERNAL" ? "INTERNAL" : "EXTERNAL_PROSPECT",
    attribution: verdict.status,
    ...(bool(d["Duplicate Delivery"]) ? { duplicate_delivery: true } : {}),
  });
  if (has(d, "Disposition") && text(d["Disposition"]) !== disposition.disposition) {
    v.push(`Disposition ${text(d["Disposition"])} contradicts the evidence: ${disposition.disposition} — ${disposition.reason}`);
  }
  if (has(d, "Counts As Reply") && bool(d["Counts As Reply"]) !== disposition.counts_as_reply) {
    v.push(`Counts As Reply contradicts the disposition ${disposition.disposition}`);
  }
  if (has(d, "Follow Up") && text(d["Follow Up"]) !== disposition.follow_up) {
    v.push(`Follow Up contradicts the disposition ${disposition.disposition}, which requires ${disposition.follow_up}`);
  }
  if (disposition.safety_priority && !has(d, "Follow Up")) {
    v.push(`this disposition carries a safety consequence (${disposition.follow_up}); it is recorded with the record, never deferred`);
  }
  if (bool(d["Outbound Sent"])) {
    v.push("recording a reply never sends anything: this candidate has no send path at all");
  }
  return v;
}

/* ────────────────────────────── coverage declarations ────────────────────────────── */

function coverageRules(d: Readonly<Record<string, unknown>>): string[] {
  const v: string[] = [];
  const gaps = missing(d, ["Source", "Since", "Until", "State"]);
  if (gaps.length > 0) { v.push(`a coverage declaration states its source, its window and its state; it is missing ${gaps.join(", ")}`); return v; }
  if (!oneOf(COVERAGE_SOURCES, text(d["Source"]))) v.push(`Source ${redact(d["Source"])} is not a known coverage source`);
  if (!oneOf(COVERAGE_STATES, text(d["State"]))) v.push(`State ${redact(d["State"])} is not a known coverage state`);
  for (const stamp of ["Since", "Until"]) if (!isIsoInstant(text(d[stamp]))) v.push(`${stamp} must be an ISO instant carrying an explicit offset`);
  if (v.length === 0 && Date.parse(text(d["Until"])) <= Date.parse(text(d["Since"]))) v.push("a coverage window closes after it opens");
  return v;
}

/* ────────────────────────────── input revisions (W04) ────────────────────────────── */

async function inputRevisionRules(d: Readonly<Record<string, unknown>>, m: IntentMutation, ctx: GtmIntentContext): Promise<string[]> {
  const v: string[] = [];
  const gaps = missing(d, ["Reason", "Basis Refs", "Basis Digest", "Runtime ID"]);
  if (gaps.length > 0) { v.push(`an input revision states its reason, its basis and the runtime it was built from; it is missing ${gaps.join(", ")}`); return v; }
  const reason = text(d["Reason"]);
  if (!oneOf(INPUT_REVISION_REASONS, reason)) { v.push(`Reason ${redact(reason)} is not a known input-revision reason`); return v; }
  const supersedes = has(d, "Supersedes") ? text(d["Supersedes"]) : null;
  if (reason === "INITIAL" && supersedes !== null) v.push("an INITIAL revision supersedes nothing");
  if (reason !== "INITIAL" && supersedes === null) {
    v.push("a backfill or a reclassification supersedes the revision it replaces; the superseded revision stays durable");
  }
  if (supersedes !== null) {
    const rows = rowsOrViolation(await ctx.find("SALES:GTM_INPUT_REVISIONS", "Input Revision ID", supersedes, ["Input Revision ID"]), "the superseded input revision", v);
    if (rows === undefined) return v;
    if (rows.length === 0) v.push("the superseded input revision does not exist in this runtime");
  }
  const expected = inputRevisionId({
    runtime_id: text(d["Runtime ID"]),
    basis_refs: parseCoverageRefs(text(d["Basis Refs"])),
    reason: reason as InputRevisionReason,
    supersedes,
    basis_digest: text(d["Basis Digest"]),
  });
  const declared = text(m.record_selector.natural_key);
  if (declared !== expected) {
    v.push(`the Input Revision ID is derived from its basis; this one does not match what its declared basis yields (expected ${expected})`);
  }
  return v;
}

/* ────────────────────────────── metric snapshots (W04) ────────────────────────────── */

async function snapshotRules(d: Readonly<Record<string, unknown>>, m: IntentMutation, ctx: GtmIntentContext): Promise<string[]> {
  const v: string[] = [];
  const gaps = missing(d, ["Metric Key", "Period Key", "Period Start", "Period End", "Observation Cutoff", "Scope", "Computability", "Input Revision", "Metric Definitions Version", "Metric Definitions Digest", "Coverage Refs"]);
  if (gaps.length > 0) { v.push(`a metric snapshot states its metric, its period, its cutoff, its definitions, its input revision, its coverage and its computability; it is missing ${gaps.join(", ")}`); return v; }

  if (text(d["Metric Definitions Version"]) !== METRIC_DEFINITIONS_VERSION || text(d["Metric Definitions Digest"]) !== METRIC_DEFINITIONS_DIGEST) {
    v.push("the snapshot pins metric definitions that are not the ones this backend governs; a number is never re-attributed to another definition set");
  }
  const metricKey = text(d["Metric Key"]);
  const def = metricDefinition(metricKey);
  if (def === undefined) { v.push(`Metric Key ${redact(metricKey)} is not a defined metric (${METRIC_KEYS.join(", ")})`); return v; }
  if (has(d, "Layer") && text(d["Layer"]) !== def.layer) {
    v.push(`Layer ${redact(d["Layer"])} contradicts the pinned definition of this metric (${def.layer}); configuration, execution and effectiveness are never conflated`);
  }
  const scope = text(d["Scope"]);
  if (scope === "COMPANY_GLOBAL") {
    const global = companyGlobalTotal([{ runtime_key: ctx.runtime_id, companies: [], contacts: 0 }], "ABSENT");
    v.push(global.reason + " (" + global.disposition + ")");
  } else if (scope !== "RUNTIME") {
    v.push(`Scope ${redact(scope)} is neither RUNTIME nor COMPANY_GLOBAL`);
  }
  if (has(d, "Target Comparison") && text(d["Target Comparison"]) !== "NOT_APPLICABLE_TARGET_NOT_SET") {
    v.push("the production target of this metric is not set; a measurement may never be compared to one");
  }
  if (has(d, "Compared With Snapshot") && !has(d, "Comparison Maturity Note")) {
    v.push("two snapshots of different maturity are never compared silently; the difference in maturity is stated with the comparison");
  }

  const period: Period = { period_key: text(d["Period Key"]), start: text(d["Period Start"]), end: text(d["Period End"]), timezone: "Europe/Paris" };
  const week = validateParisWeek(period.start, period.end);
  if (!week.ok) v.push(week.reason);

  // Coverage is cross-checked against the runtime's own durable coverage declarations, never self-certified.
  const coverageKeys = parseCoverageRefs(text(d["Coverage Refs"]));
  const coverage: CoverageDeclaration[] = [];
  for (const key of coverageKeys) {
    const rows = rowsOrViolation(await ctx.find("SALES:GTM_COVERAGE", "Coverage Key", key, ["Coverage Key", "Source", "Since", "Until", "State"]), "a declared coverage window", v);
    if (rows === undefined) return v;
    const row = rows[0];
    if (row === undefined) { v.push("a declared coverage window does not exist in this runtime"); continue; }
    coverage.push({
      coverage_key: text(row["Coverage Key"]), source: text(row["Source"]) as CoverageSource,
      since: text(row["Since"]), until: text(row["Until"]), state: text(row["State"]) as CoverageState,
    });
  }
  for (const source of def.requires_coverage) {
    const verdict = coverageVerdict(source, period, coverage);
    if (has(d, "Coverage State Reported") && text(d["Coverage State Reported"]) !== verdict.state) {
      v.push(`the reported ${source} coverage state contradicts the durable declarations (${verdict.state})`);
    }
  }

  const revision = text(d["Input Revision"]);
  const revisionRows = rowsOrViolation(await ctx.find("SALES:GTM_INPUT_REVISIONS", "Input Revision ID", revision, ["Input Revision ID"]), "the input revision this snapshot pins", v);
  if (revisionRows === undefined) return v;
  if (revisionRows.length === 0) v.push("the snapshot pins an input revision that does not exist in this runtime");

  const verdict = computability(metricKey, period, text(d["Observation Cutoff"]), coverage);
  const claimed = text(d["Computability"]);
  if (claimed !== verdict.state) {
    v.push(`Computability ${claimed} contradicts the declared evidence: ${verdict.state} — ${verdict.reason}`);
  }
  if (verdict.state === "COMPUTED") {
    if (!has(d, "Value")) v.push("a computable measurement states its value");
    else if (!Number.isFinite(Number(text(d["Value"])))) v.push("Value is not a number");
    if (!has(d, "Evidence Refs")) v.push("a computable measurement names the evidence it was computed from");
    if (has(d, "Denominator Unit") && has(d, "Numerator Unit")) {
      const rate = rateOf({ value: Number(text(d["Value"])), unit: text(d["Numerator Unit"]) }, { value: 1, unit: text(d["Denominator Unit"]) });
      if (rate.state !== "COMPUTED") v.push(`the declared units do not form a rate: ${rate.reason}`);
    }
  } else if (has(d, "Value")) {
    v.push(`no number may be stated while the measurement is ${verdict.state}: ${verdict.reason}`);
  }

  // Identity: the snapshot key is derived, never chosen. Same definitions + same revision + same question ⇒ same key.
  const expectedKey = snapshotKey({
    metric_definitions_version: METRIC_DEFINITIONS_VERSION,
    metric_definitions_digest: METRIC_DEFINITIONS_DIGEST,
    input_revision_id: revision,
    metric_key: metricKey,
    scope,
    period_key: period.period_key,
    period_start: period.start,
    period_end: period.end,
    observation_cutoff: text(d["Observation Cutoff"]),
    coverage_digest: coverageDigest(coverage),
  });
  const declaredKey = text(m.record_selector.natural_key);
  if (declaredKey !== expectedKey) {
    v.push(`the Snapshot Key is derived from the definitions, the input revision and the question asked; this one does not match (expected ${expectedKey})`);
  }
  if (has(d, "Coverage Digest") && text(d["Coverage Digest"]) !== coverageDigest(coverage)) {
    v.push("the pinned coverage digest is not the digest of the coverage this snapshot names");
  }
  return v;
}

/* ────────────────────────────── entry point ────────────────────────────── */

/**
 * Validates ONE mutation against the candidate GTM grammar. Returns every violation found, or undefined when the
 * mutation is not a GTM mutation or is exactly what the semantics permit.
 */
export async function validateGtmMutation(m: IntentMutation, ctx: GtmIntentContext): Promise<readonly string[] | undefined> {
  if (!GTM_RESOURCE_KEYS.includes(m.logical_resource_key)) return undefined;
  const d = m.desired_changes ?? {};
  const v: string[] = [...identityRules(d, ctx)];
  if (GTM_APPEND_ONLY_KEYS.includes(m.logical_resource_key) && m.operation !== "CREATE") {
    v.push(`${m.logical_resource_key} is append-only: a stated fact is never rewritten, a new one is stated beside it`);
  }
  switch (m.logical_resource_key) {
    case "SALES:CAPABILITY_PROOFS": v.push(...capabilityProofRules(d, m, ctx)); break;
    case "SALES:EXPOSURES": v.push(...(await exposureRules(d, ctx))); break;
    case "SALES:APPROACH_VERSIONS": v.push(...(await approachVersionRules(d, ctx))); break;
    case "SALES:ENROLLMENTS": v.push(...(await enrollmentRules(d, m, ctx))); break;
    case "SALES:MEETING_EPISODES": v.push(...meetingRules(d)); break;
    case "SALES:REPLY_ATTRIBUTIONS": v.push(...(await attributionRules(d, ctx))); break;
    case "SALES:GTM_COVERAGE": v.push(...coverageRules(d)); break;
    case "SALES:GTM_INPUT_REVISIONS": v.push(...(await inputRevisionRules(d, m, ctx))); break;
    case "SALES:GTM_SNAPSHOTS": v.push(...(await snapshotRules(d, m, ctx))); break;
    default: break; // campaigns and participations: identity rules only
  }
  return v.length === 0 ? undefined : [...v, PROOF];
}

/**
 * Re-validates the DURABLE-STATE-DEPENDENT constraints at verification time, against the state as it is now.
 * Between prepare and verify a native Notion edit can create a second ACTIVE enrollment, widen a parent version's
 * Authority or remove the campaign an exposure names; the plan must not be able to commit a stale assumption.
 */
export async function revalidateGtmOperations(
  operations: readonly { readonly logical_resource_key: string; readonly natural_key?: string | undefined; readonly expected_values: Readonly<Record<string, unknown>> }[],
  ctx: GtmIntentContext,
): Promise<readonly string[] | undefined> {
  const v: string[] = [];
  for (const op of operations) {
    if (!GTM_RESOURCE_KEYS.includes(op.logical_resource_key)) continue;
    const mutation: IntentMutation = {
      logical_resource_key: op.logical_resource_key,
      operation: "CREATE",
      record_selector: { natural_key: op.natural_key },
      desired_changes: op.expected_values,
    };
    const violations = await validateGtmMutation(
      { ...mutation, operation: op.logical_resource_key === "SALES:ENROLLMENTS" ? "UPDATE" : "CREATE" },
      ctx,
    );
    if (violations) v.push(...violations.filter((x) => x !== PROOF));
  }
  return v.length === 0 ? undefined : [...v, VERIFY_PROOF];
}
