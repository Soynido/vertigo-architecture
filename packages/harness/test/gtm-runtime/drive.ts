/**
 * Drives the six real tools against the candidate GTM runtime: bind → resume → prepare → native writes →
 * verify(TARGET) → finalization + State LAST → verify(FINAL). The harness never writes; the fixture "native
 * writer" performs every physical write exactly as the user's Notion app would.
 *
 * The record builders below state the SEMANTICS of a record (a window, a basis, a question asked) and derive its
 * identity with the very functions the backend derives it with, so a test never hardcodes a digest — and the
 * "wrong key" cases prove the derivation is enforced rather than trusted.
 */
import assert from "node:assert/strict";
import { dispatch } from "../../src/tools/handlers.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import type { Plan } from "../../src/plans/store.ts";
import type { Intent } from "../../src/plans/prepare.ts";
import {
  coverageDigest, inputRevisionId, METRIC_DEFINITIONS_DIGEST, METRIC_DEFINITIONS_VERSION, metricDefinition,
  snapshotKey, type CoverageDeclaration, type CoverageSource, type CoverageState, type InputRevisionReason,
} from "../../src/gtm/semantics.ts";
import { handleOf } from "../unit/binding-fixtures.ts";
import { executeWrites, type WriterOptions } from "../unit/target-fixtures.ts";
import { REP_GTM, REP_GTM_INSTANCE, REP_GTM_KEY, type GtmRuntimeWorld } from "./world.ts";
import { transact } from "../support/transact.ts";

type Ok = Extract<Envelope, { status: "OK" }>;

export const REP_CTX = { principal_id: REP_GTM.principal_id } as const;
export const OWNER_CTX = { principal_id: "p-owner" } as const;

export const T = {
  stage1: "2030-01-03T00:30:00.000Z",
  fin: "2030-01-03T00:31:00.000Z",
  state: "2030-01-03T00:32:00.000Z",
  later: "2030-01-03T00:40:00.000Z",
} as const;

/** Distinct finalization instants per transaction, so successive commits in one test never share a timestamp. */
let tick = 0;
const nextStamps = (): { fin: string; state: string; stage1: string } => {
  tick += 1;
  const mm = String(10 + tick).padStart(2, "0");
  return {
    stage1: "2030-01-03T01:" + mm + ":00.000Z",
    fin: "2030-01-03T02:" + mm + ":00.000Z",
    state: "2030-01-03T03:" + mm + ":00.000Z",
  };
};

/** One GTM mutation, ready for os_prepare. */
export const gtmIntent = (
  logical_resource_key: string,
  natural_key: string,
  desired_changes: Record<string, unknown>,
  operation: "CREATE" | "UPDATE" | "UPSERT" = "CREATE",
): Intent => ({
  action_class: "COMMIT",
  summary: "persist " + logical_resource_key,
  mutations: [{ logical_resource_key, operation, record_selector: { natural_key }, desired_changes }],
});

export async function bindRep(w: GtmRuntimeWorld, ctx: { principal_id: string } = REP_CTX): Promise<string> {
  return handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps));
}

export async function resume(w: GtmRuntimeWorld, handle: string, topic_hint?: string, ctx: { principal_id: string } = REP_CTX): Promise<{ envelope: Envelope; payload: Record<string, unknown> }> {
  const envelope = await dispatch("os_resume", { binding_handle: handle, ...(topic_hint === undefined ? {} : { topic_hint }) }, ctx, w.deps);
  const payload = (envelope.status === "OK" ? (envelope as Ok).result : envelope.observations) as Record<string, unknown>;
  return { envelope, payload };
}

export async function prepare(w: GtmRuntimeWorld, handle: string, intent: Intent, ctx: { principal_id: string } = REP_CTX): Promise<{ envelope: Envelope; plan?: Plan }> {
  const envelope = await dispatch("os_prepare", { binding_handle: handle, intent }, ctx, w.deps);
  if (envelope.status !== "OK") return { envelope };
  const plan = await w.deps.store.plans.get((envelope as Ok).result["plan_id"] as string);
  return { envelope, ...(plan ? { plan } : {}) };
}

export async function target(w: GtmRuntimeWorld, handle: string, plan: Plan, opts: WriterOptions = {}, ctx: { principal_id: string } = REP_CTX) {
  const created = executeWrites(w, plan.stage1_writes, plan.plan_id, { now: T.stage1, ...opts });
  const envelope = await dispatch("os_verify", { binding_handle: handle, plan_id: plan.plan_id, phase: "TARGET" }, ctx, w.deps);
  const symbols = ((envelope.observations["symbols"] as Record<string, string>) ?? created);
  return { envelope, created, symbols };
}

export async function finalize(
  w: GtmRuntimeWorld, handle: string, plan: Plan, receipt: string, symbols: Record<string, string>,
  at: { fin: string; state: string } = { fin: T.fin, state: T.state }, ctx: { principal_id: string } = REP_CTX,
) {
  executeWrites(w, plan.finalization_writes, plan.plan_id, { ...({ now: at.fin }), created: symbols, target_receipt_id: receipt });
  executeWrites(w, [plan.state_last_write], plan.plan_id, { ...({ now: at.state }), created: symbols, target_receipt_id: receipt });
  return dispatch("os_verify", { binding_handle: handle, plan_id: plan.plan_id, phase: "FINAL" }, ctx, w.deps);
}

/** The whole transaction for one GTM intent; asserts TRANSACTION_VERIFIED and returns the written row id. */
export async function commit(w: GtmRuntimeWorld, handle: string, intent: Intent): Promise<{ plan: Plan; targetRef: string }> {
  const stamps = nextStamps();
  const { plan, symbols } = await transact(w, handle, intent, { ctx: REP_CTX, stamps });
  const write = plan.stage1_writes.find((x) => x.purpose === "WRITE_TARGET");
  return { plan, targetRef: (write ? symbols[write.symbol] : undefined) ?? "UNKNOWN" };
}

/** Evidence lines of a HOLD envelope, joined for assertion messages. */
export const evidenceOf = (e: Envelope): string => (e.status === "HOLD" ? e.evidence.join(" | ") : "");

/* ────────────────────────────── the controlled GTM week ────────────────────────────── */

/** A half-open Europe/Paris calendar week used across the integrated evidence (W03 world A). */
export const WEEK = {
  key: "W-2026-38",
  start: "2026-09-14T00:00:00+02:00",
  end: "2026-09-21T00:00:00+02:00",
  mature_cutoff: "2026-09-28T09:00:00+02:00",
  immature_cutoff: "2026-09-22T09:00:00+02:00",
} as const;

/** The spring week that lasts 167 hours and the autumn week that lasts 169 hours in Europe/Paris. */
export const DST_WEEKS = {
  spring: { key: "W-2026-13", start: "2026-03-23T00:00:00+01:00", end: "2026-03-30T00:00:00+02:00", mature_cutoff: "2026-04-06T09:00:00+02:00" },
  autumn: { key: "W-2026-43", start: "2026-10-19T00:00:00+02:00", end: "2026-10-26T00:00:00+01:00", mature_cutoff: "2026-11-02T09:00:00+01:00" },
} as const;

export interface CoverageSpec {
  readonly key: string;
  readonly source: CoverageSource;
  readonly since: string;
  readonly until: string;
  readonly state: CoverageState;
}

export const coverageIntent = (c: CoverageSpec): Intent =>
  gtmIntent("SALES:GTM_COVERAGE", c.key, { Source: c.source, Since: c.since, Until: c.until, State: c.state });

export const asDeclaration = (c: CoverageSpec): CoverageDeclaration =>
  ({ coverage_key: c.key, source: c.source, since: c.since, until: c.until, state: c.state });

export interface RevisionSpec {
  readonly reason: InputRevisionReason;
  readonly basis_refs: readonly string[];
  readonly basis_digest: string;
  readonly supersedes?: string | null;
}

export const revisionKey = (r: RevisionSpec): string =>
  inputRevisionId({ runtime_id: REP_GTM_INSTANCE, basis_refs: r.basis_refs, reason: r.reason, supersedes: r.supersedes ?? null, basis_digest: r.basis_digest });

export const revisionIntent = (r: RevisionSpec): Intent =>
  gtmIntent("SALES:GTM_INPUT_REVISIONS", revisionKey(r), {
    Reason: r.reason, "Basis Refs": r.basis_refs.join(";"), "Basis Digest": r.basis_digest,
    "Runtime ID": REP_GTM_INSTANCE, ...(r.supersedes ? { Supersedes: r.supersedes } : {}),
    "Created At": "2026-09-28T09:00:00+02:00",
  });

export interface SnapshotSpec {
  readonly metric_key: string;
  readonly period: { readonly key: string; readonly start: string; readonly end: string };
  readonly cutoff: string;
  readonly input_revision: string;
  readonly coverage: readonly CoverageSpec[];
  readonly scope?: string;
  readonly value?: string;
  readonly computability?: "COMPUTED" | "INCONCLUSIVE" | "NOT_COMPUTABLE";
  readonly evidence_refs?: string;
  readonly extra?: Record<string, unknown>;
  /** Overrides the derived Snapshot Key, to prove the derivation is enforced. */
  readonly forced_key?: string;
}

export const snapshotKeyOf = (s: SnapshotSpec): string =>
  snapshotKey({
    metric_definitions_version: METRIC_DEFINITIONS_VERSION,
    metric_definitions_digest: METRIC_DEFINITIONS_DIGEST,
    input_revision_id: s.input_revision,
    metric_key: s.metric_key,
    scope: s.scope ?? "RUNTIME",
    period_key: s.period.key,
    period_start: s.period.start,
    period_end: s.period.end,
    observation_cutoff: s.cutoff,
    coverage_digest: coverageDigest(s.coverage.map(asDeclaration)),
  });

export const snapshotIntent = (s: SnapshotSpec): Intent => {
  const computability = s.computability ?? "COMPUTED";
  const fields: Record<string, unknown> = {
    "Metric Key": s.metric_key,
    Layer: metricDefinition(s.metric_key)?.layer ?? "EFFECTIVENESS",
    "Period Key": s.period.key, "Period Start": s.period.start, "Period End": s.period.end,
    "Observation Cutoff": s.cutoff, Scope: s.scope ?? "RUNTIME", Computability: computability,
    "Input Revision": s.input_revision,
    "Metric Definitions Version": METRIC_DEFINITIONS_VERSION,
    "Metric Definitions Digest": METRIC_DEFINITIONS_DIGEST,
    "Coverage Refs": s.coverage.map((c) => c.key).join(";"),
    "Coverage Digest": coverageDigest(s.coverage.map(asDeclaration)),
    "Target Comparison": "NOT_APPLICABLE_TARGET_NOT_SET",
    ...(s.extra ?? {}),
  };
  if (computability === "COMPUTED") {
    fields["Value"] = s.value ?? "0";
    fields["Evidence Refs"] = s.evidence_refs ?? "EV-1";
  }
  return gtmIntent("SALES:GTM_SNAPSHOTS", s.forced_key ?? snapshotKeyOf(s), fields);
};

export interface ExposureSpec {
  readonly key: string;
  readonly contact: string;
  readonly message_ref: string;
  readonly campaign?: string;
  readonly approach_version?: string;
  readonly participation?: string;
  readonly extra?: Record<string, unknown>;
}

/** A faithful exposure: what the campaign configures, communicated as configured. */
export const exposureIntent = (e: ExposureSpec): Intent =>
  gtmIntent("SALES:EXPOSURES", e.key, {
    Contact: e.contact, "Message Ref": e.message_ref,
    Campaign: e.campaign ?? "CMP-1", "Approach Version": e.approach_version ?? "AP-1/v1",
    Participation: e.participation ?? "PART-1",
    "Communicated Offer": "OFFER-STD", "Communicated Price": "120000", "Price Communicated": "true",
    Currency: "EUR", "Price Unit": "PER_MONTH", "Price Scope": "PILOT", "Link Sent": "true",
    "Pinned At": "2026-09-14T09:00:00+02:00",
    ...(e.extra ?? {}),
  });

/** Seeds the durable rows the cross-checks read: coverage windows, an input revision and proven touches. */
export async function seedCoverage(w: GtmRuntimeWorld, handle: string, specs: readonly CoverageSpec[]): Promise<void> {
  for (const c of specs) await commit(w, handle, coverageIntent(c));
}

export async function seedRevision(w: GtmRuntimeWorld, handle: string, spec: RevisionSpec): Promise<string> {
  await commit(w, handle, revisionIntent(spec));
  return revisionKey(spec);
}

export async function seedExposure(w: GtmRuntimeWorld, handle: string, spec: ExposureSpec): Promise<void> {
  await commit(w, handle, exposureIntent(spec));
}

export const OWNER_FIELDS = { "Owner Rep": REP_GTM_KEY, "Runtime ID": REP_GTM_INSTANCE } as const;
