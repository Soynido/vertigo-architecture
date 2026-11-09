/**
 * os_verify(TARGET) — independent readback verification of stage-1 writes (PV0-012, PG4).
 *
 * Inputs are ONLY the owned binding, the plan and the fresh runtime. Nothing the caller says about what it
 * wrote is consulted: the verifier re-reads the Run, the Mutation Ledger and every target from Notion and
 * compares them with the canonical plan. Success issues exactly one opaque target receipt (server TTL) and
 * returns the finalization + state-last actions with symbols bound to the observed physical ids.
 */
import { createHash } from "node:crypto";
import type { BindingRecord } from "../binding/store.ts";
import type { HoldCode } from "../errors/codes.ts";
import type { NotionReadClient } from "../notion/readClient.ts";
import { normalizeId, propMentions, propRelationIds, propText, type Page } from "../notion/shapes.ts";
import { naturalKeyFilter, relationIds } from "../plans/resources.ts";
import { checkTargetReceipt, expireIfDue, issueTargetReceipt, transition } from "../plans/service.ts";
import { checkSchemaCompatibility } from "./schemaContract.ts";
import { linkageId, type Plan, type PlanOperation } from "../plans/store.ts";
import type { ResolvedRuntime } from "../resolvers/types.ts";
import { discoverControlPlane, readCapabilitySnapshot, readControlPlane } from "../resume/readers.ts";
import { isForeignRunImport } from "../resume/foreignRuns.ts";
import { isExternalEventPlan } from "../effects/eventWrite.ts";
import { isSourceEnrollmentPlan } from "../resume/sourceEnrollment.ts";
import { evaluateCapabilityCompleteness } from "../resume/capabilities.ts";
import { readManifestBlockers } from "../resume/admission.ts";
import type { HarnessDeps } from "../tools/handlers.ts";
import type { ReceiptRecord } from "./engine.ts";
import { redact as redactValue } from "../gtm/semantics.ts";

export type TargetOutcome =
  | { readonly kind: "VERIFIED"; readonly receipt: ReceiptRecord; readonly symbols: Readonly<Record<string, string>>; readonly observations: Readonly<Record<string, unknown>>; readonly warnings: readonly string[]; readonly repeated: boolean }
  | { readonly kind: "HOLD"; readonly code: HoldCode; readonly evidence: readonly string[]; readonly safe_action: string; readonly warnings?: readonly string[]; readonly observations?: Readonly<Record<string, unknown>> };

function hold(code: HoldCode, evidence: string[], safe_action: string, extra: Partial<Extract<TargetOutcome, { kind: "HOLD" }>> = {}): TargetOutcome {
  return { kind: "HOLD", code, evidence, safe_action, ...extra };
}

async function queryAll(client: NotionReadClient, dsId: string, filter: unknown): Promise<Page[]> {
  const out: Page[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 50; guard += 1) {
    const q = (await client.queryDataSource(dsId, filter, cursor)) as { results: readonly Page[]; has_more?: boolean; next_cursor?: string | null };
    out.push(...q.results.filter((p) => !p.archived && !p.in_trash));
    if (!q.has_more || !q.next_cursor) return out;
    cursor = q.next_cursor;
  }
  return out;
}

function parentDs(page: Page): string | undefined {
  return normalizeId(page.parent?.data_source_id) ?? normalizeId(page.parent?.database_id);
}

/** Canonical scalar comparison: expected values were planned as JSON scalars, observed values are Notion property text. */
export function sameValue(expected: unknown, observed: string | undefined): boolean {
  if (expected === null || expected === undefined) return observed === undefined || observed === "";
  if (typeof expected === "boolean") return observed === (expected ? "true" : "false");
  if (typeof expected === "number") return observed !== undefined && Number(observed) === expected;
  return observed !== undefined && observed.trim() === String(expected).trim();
}

/** Legacy compatibility for the one live capability proof written before Notion minute-canonicalization shipped. */
export function sameOperationValue(op: Pick<PlanOperation, "logical_resource_key">, field: string, expected: unknown, observed: string | undefined): boolean {
  if (op.logical_resource_key === "SALES:CAPABILITY_PROOFS" && field === "Verified At" && observed !== undefined) {
    const expectedTime = typeof expected === "string" ? Date.parse(expected) : Number.NaN;
    const observedTime = Date.parse(observed);
    if (Number.isFinite(expectedTime) && Number.isFinite(observedTime) && Math.floor(expectedTime / 60_000) === Math.floor(observedTime / 60_000)) return true;
  }
  return sameValue(expected, observed);
}

/**
 * Typed equality on top of the scalar one (PV-WRITE-001 / W1.7): an empty planned value and an absent or empty
 * observed one are the same fact, and a date-time property is compared at the minute — Notion stores date-times
 * at minute precision, so a planned `…T09:00:20Z` reads back as `…T09:00`.
 */
export function sameTypedValue(page: Page, field: string, expected: unknown, observed: string | undefined): boolean {
  if (expected === "" && (observed === undefined || observed === "")) return true;
  if (page.properties[field]?.type === "date" && typeof expected === "string" && observed !== undefined && expected.includes("T") && observed.includes("T")) {
    const a = Date.parse(expected);
    const b = Date.parse(observed);
    if (Number.isFinite(a) && Number.isFinite(b)) return Math.floor(a / 60_000) === Math.floor(b / 60_000);
  }
  return false;
}

type FieldCheck = { readonly ok: true; readonly observed: Record<string, string | null> } | { readonly ok: false; readonly code: "HOLD_TARGET_NOT_WRITTEN" | "HOLD_TARGET_WRONG_VALUE" | "HOLD_TARGET_WRONG_FIELD"; readonly evidence: string[]; readonly observed: Record<string, string | null> };

/**
 * Compare every compared field of one operation against the page actually read from Notion.
 *
 * `redact` is set for resources whose rows carry business values (an offer, a price, a contact): the mismatch is
 * then reported by field name and by non-reversible token, never by value. The comparison itself is unchanged.
 */
/**
 * One field as actually stored. A relation is a SET of page references, not text, so it is read as its
 * normalized, de-duplicated, sorted id list: link order and dashed/undashed spellings can neither fake a
 * divergence nor hide one.
 */
export function observedField(page: Page, field: string): string | undefined {
  return page.properties[field]?.type === "relation" ? propRelationIds(page, field).join(",") : propText(page, field);
}

/** Cursor FINAL fingerprints use the same observed scalar/normalized relation set, without retaining text. */
export function observedFingerprint(page: Page, field: string): string {
  return createHash("sha256").update(JSON.stringify(observedField(page, field) ?? null)).digest("hex");
}

/** Binds the bounded adoption classification and walk to the exact content already read, not just its date. */
export function observationFingerprint(page: Page, fields: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify([...new Set(fields)].sort().map(f => [f, observedField(page, f) ?? null]))).digest("hex");
}

/** The planned value of a field in the same shape `observedField` returns, so the two are directly comparable. */
export function comparableValue(page: Page, field: string, value: unknown): unknown {
  if (page.properties[field]?.type !== "relation") return value;
  return [...new Set(relationIds(value).map((id) => id ?? "INVALID"))].sort().join(",");
}

/**
 * A planned field may point at an object the SAME plan creates, written as `$created:<symbol>`. The proof
 * resolves that symbol from the id actually observed and then matches it the way every other reference in this
 * system is matched — a page mention, or the id inside the text. Unresolvable symbols stay literal and fail,
 * because a reference that cannot be resolved has not been proved.
 */
function createdReference(expected: unknown, created: Readonly<Record<string, string>>): string | undefined {
  if (typeof expected !== "string" || !expected.startsWith("$created:")) return undefined;
  return created[expected.slice("$created:".length)];
}

export function referencesId(page: Page, field: string, id: string): boolean {
  return propMentions(page, field).includes(id) || (propText(page, field) ?? "").includes(id);
}

export function compareFields(op: PlanOperation, page: Page, redactValues = false, created: Readonly<Record<string, string>> = {}, nativeIds?: Readonly<Record<string, string>>): FieldCheck {
  const show = (v: unknown): string => (redactValues ? redactValue(v) : JSON.stringify(v ?? null));
  const observed: Record<string, string | null> = {};
  const missingField: string[] = [];
  const unchanged: string[] = [];
  const wrong: string[] = [];
  for (const field of op.compared_fields) {
    if (nativeIds?.[field] && (page.properties[field] as { id?: string } | undefined)?.id !== nativeIds[field]) {
      missingField.push(field); observed[field] = null; continue;
    }
    if (!(field in page.properties)) { missingField.push(field); observed[field] = null; continue; }
    const seen = observedField(page, field);
    observed[field] = seen ?? null;
    const reference = createdReference(op.expected_values[field], created);
    if (reference !== undefined) {
      if (referencesId(page, field, reference)) continue;
      wrong.push(`${field}: observed ${show(seen)}, expected a reference to ${show(reference)}`);
      continue;
    }
    const expected = comparableValue(page, field, op.expected_values[field]);
    if (sameOperationValue(op, field, expected, seen) || sameTypedValue(page, field, expected, seen)) continue;
    const baseline = comparableValue(page, field, op.before_values[field]);
    if (field in op.before_values && sameValue(baseline, seen)) unchanged.push(`${field}: still ${show(seen)} (expected ${show(expected)})`);
    else wrong.push(`${field}: observed ${show(seen)}, expected ${show(expected)}${field in op.before_values ? `, baseline ${show(baseline)}` : ""}`);
  }
  if (missingField.length > 0) return { ok: false, code: "HOLD_TARGET_WRONG_FIELD", evidence: [`planned field(s) absent on the target: ${missingField.join(", ")}`], observed };
  if (wrong.length > 0) return { ok: false, code: "HOLD_TARGET_WRONG_VALUE", evidence: wrong.map((w) => `${w}; the target diverged from the canonical expected state (written wrongly or changed by another actor after prepare)`), observed };
  if (unchanged.length > 0) return { ok: false, code: "HOLD_TARGET_NOT_WRITTEN", evidence: unchanged.map((u) => `${u}: the planned write is absent`), observed };
  return { ok: true, observed };
}

/**
 * `hints.created`: page ids the server executor itself created for this plan (its journal), keyed by symbol. A
 * data-source query can lag behind a fresh CREATE; when the query returns nothing, the hinted page is read
 * DIRECTLY and accepted only if it carries exactly the keys the query would have matched. A hint never
 * overrides a query that returned rows, so duplicates are still seen.
 */
export async function verifyTarget(deps: HarnessDeps, binding: BindingRecord, runtime: ResolvedRuntime, plan: Plan, now: Date, hints: { readonly created?: Readonly<Record<string, string>> } = {}): Promise<TargetOutcome> {
  const store = deps.store;
  const client = deps.notion;
  const warnings: string[] = [];

  // 1. Plan liveness and identity.
  await expireIfDue(store, plan, now);
  const fresh = (await store.plans.get(plan.plan_id)) ?? plan;
  if (fresh.plan_state === "EXPIRED" || fresh.plan_state === "ABORTED" || fresh.plan_state === "SUPERSEDED") {
    return hold("HOLD_PLAN_EXPIRED", [`plan ${plan.plan_id} is ${fresh.plan_state}`, "durable stage-1 writes may exist; they must be observed and reconciled before any replay"], "call os_resume; if the Run/ledger show partial writes, recover them before preparing again", { observations: { plan_state: fresh.plan_state, recovery_possible: true } });
  }
  if (fresh.plan_state === "FINAL_VERIFIED") return hold("HOLD_PLAN_REPLAY_INVALID", [`plan ${plan.plan_id} is already FINAL_VERIFIED; its target receipt was consumed`], "no action: the transaction is complete; prepare a new plan for new work");
  if (fresh.plan_state === "HOLD") return hold("HOLD_PLAN_REPLAY_INVALID", [`plan ${plan.plan_id} is on HOLD after a detected divergence`], "call os_resume and reconcile the runtime before any further verification");
  if (fresh.runtime_generation !== binding.runtime_generation || fresh.runtime_id !== runtime.runtime_id) return hold("HOLD_PLAN_RUNTIME_MISMATCH", [`plan was prepared for generation ${fresh.runtime_generation} / runtime ${fresh.runtime_id}; binding is ${binding.runtime_generation} / ${runtime.runtime_id}`], "call os_bind again and prepare a new plan; do not reuse this one");
  const gov = runtime.versions;
  const nowV = { spec: gov.governing_spec === "UNKNOWN" ? "UNKNOWN" : gov.governing_spec.value, schema: gov.governing_schema === "UNKNOWN" ? "UNKNOWN" : gov.governing_schema.value, control: gov.governing_control === "UNKNOWN" ? "UNKNOWN" : gov.governing_control.value };
  const changed = [["spec", fresh.governing_spec_version, nowV.spec], ["schema", fresh.governing_schema_version, nowV.schema], ["control", fresh.governing_control_version, nowV.control]].filter(([, a, b]) => a !== b).map(([k, a, b]) => `governing ${k}: plan=${a} now=${b}`);
  if (changed.length > 0) return hold("HOLD_VERSION_CHANGED_DURING_TRANSACTION", changed, "stop; the governing versions changed mid-transaction. Reconcile durably, then bind and prepare again");
  const graphHold = await (await import("../resume/b7DryRun.ts")).verifyB7Graph(deps, binding, runtime, fresh);
  if (graphHold) return graphHold;

  // A plan prepared before a mode gained a REQUIRED capability cannot cross TARGET afterwards. Capability-proof
  // remediation is the sole exception: it must be able to complete while other REQUIRED items remain pending.
  const capabilityProofResource = runtime.adapter.capabilities?.capabilityProofResource;
  const capabilityRemediation = capabilityProofResource !== undefined && fresh.operations.every((o) => o.logical_resource_key === capabilityProofResource);
  // ADMISSION-SALES-001: a plan prepared while the Manifest admitted the runtime cannot cross TARGET once the
  // Manifest declares a blocker. Bounded recovery of the caller's own interrupted work is the one exception:
  // it reconciles effects that already exist and opens nothing new. Capability-proof remediation is the other.
  if (fresh.run_mode !== "RECOVER_EXISTING" && !capabilityRemediation) {
    const manifest = await readManifestBlockers(client, runtime);
    if ("unreadable" in manifest) return hold("HOLD_RECOVERY_REQUIRED", [manifest.unreadable, "the runtime's admission cannot be established without its Manifest"], "restore read access to the Manifest, then call os_resume");
    if (manifest.blockers.length > 0) return hold("HOLD_RECOVERY_REQUIRED", [...manifest.blockers, "the Manifest no longer admits this runtime: no receipt is issued on a blocked runtime"], "call os_resume; resolve the Manifest blocker (rebind / install / recovery) before verifying this transaction again");
  }
  if (runtime.adapter.capabilities?.operatingModeRequirements && !capabilityRemediation && !isSourceEnrollmentPlan(runtime, fresh)) {
    const root = isForeignRunImport(fresh) ? fresh : fresh.recovers_plan_id && !isExternalEventPlan(fresh) ? await store.plans.get(fresh.recovers_plan_id) : undefined;
    const narrow = root && isForeignRunImport(root) ? await readCapabilitySnapshot(client, runtime) : undefined;
    const snapshot = narrow ?? await readControlPlane(client, runtime);
    if (!("hold" in snapshot)) {
      const capability = evaluateCapabilityCompleteness(runtime, snapshot);
      if (capability && !capability.complete) {
        const evidence = capability.comparisons.filter((c) => c.requirement === "REQUIRED" && !c.satisfied).map((c) => `${c.capability}=${c.state}: ${c.reason}`);
        return hold("HOLD_REQUIRED_CAPABILITY_INCOMPLETE", evidence, capability.next_human_action, { observations: { capability_completeness: capability } });
      }
    }
  }

  // 2. Control plane: the Run and ledger rows must be linked to THIS plan by their harness fields.
  const g = runtime.adapter.controlPlane;
  const wp = g.writeProps;
  const dbs = await discoverControlPlane(client, runtime.root_ref, g);
  if (!dbs.runs || !dbs.ledger) return hold("HOLD_REQUIRED_RESOURCE_MISSING", [`control-plane databases missing: ${[!dbs.runs && g.runsDatabaseTitle, !dbs.ledger && g.ledgerDatabaseTitle].filter(Boolean).join(", ")}`], "restore the runtime control plane");
  if (!wp?.runHarnessPlanId || !wp.ledgerHarnessPlanId || !wp.ledgerIdempotencyKey) return hold("HOLD_SCHEMA_MISMATCH", ["adapter grammar declares no harness linkage fields for Runs / Mutation Ledger"], "adopt a grammar with harness linkage before TARGET verification");
  const compat = await checkSchemaCompatibility(client, runtime);
  if (!compat.compatible) return hold("HOLD_SCHEMA_MISMATCH", [...compat.migration.map((m) => `${m.database} lacks "${m.property}" (${m.type}) — ${m.reason}`), "without structured harness linkage the journal cannot be bound to this plan; a target value alone never receives a receipt"], "apply the listed schema migration through a separately authorized migration validation ticket, then verify again", { observations: { schema_migration: compat.migration } });

  const link = linkageId(fresh);
  const recovering = fresh.run_mode === "RECOVER_EXISTING";
  const hinted = async (symbol: string, ds: string | undefined, matches: (p: Page) => boolean): Promise<Page[]> => {
    const id = hints.created?.[symbol];
    if (!id || !ds) return [];
    try {
      const page = (await client.retrievePage(id)) as Page;
      return !page.archived && !page.in_trash && parentDs(page) === ds && matches(page) ? [page] : [];
    } catch { return []; }
  };
  const isRunOfPlan = (p: Page) => propText(p, wp.runHarnessPlanId as string)?.trim() === link;
  let runRows = (await queryAll(client, dbs.runs, { property: wp.runHarnessPlanId, rich_text: { equals: link } })).filter(isRunOfPlan);
  if (runRows.length === 0) runRows = await hinted("OPEN_RUN", dbs.runs, isRunOfPlan);
  if (runRows.length === 0) return hold("HOLD_RUN_NOT_OPENED", [`no Run row carries ${wp.runHarnessPlanId} = ${link}`, "stage-1 step OPEN_RUN was not executed (or was executed elsewhere)"], "execute the OPEN_RUN action first, then the remaining stage-1 actions, then verify again");
  if (runRows.length > 1) return hold("HOLD_RUN_AMBIGUOUS", [`${runRows.length} Run rows carry ${wp.runHarnessPlanId} = ${link}: ${runRows.map((r) => normalizeId(r.id)).join(", ")}`], "reconcile the duplicate Run rows by hand; no receipt can bind to an ambiguous Run");
  const run = runRows[0] as Page;
  const runRef = normalizeId(run.id) as string;
  const runStatus = propText(run, g.runProps.status);
  if (runStatus !== "RUNNING" && !(recovering && runStatus === "COMPLETED")) return hold("HOLD_RUN_NOT_OPENED", [`Run ${runRef} for this plan is ${runStatus ?? "UNKNOWN"}, not RUNNING`], "the Run must be RUNNING until FINAL; reconcile by hand if it was closed early");
  if (recovering && runStatus === "COMPLETED") warnings.push(`recovery: Run ${runRef} is already COMPLETED; TARGET reconstructs the verification without reopening it`);
  const symbols: Record<string, string> = { OPEN_RUN: runRef };

  const ledgerAll = (await queryAll(client, dbs.ledger, { property: wp.ledgerHarnessPlanId, rich_text: { equals: link } })).filter((p) => propText(p, wp.ledgerHarnessPlanId as string)?.trim() === link);
  const ledgerRefs: Record<string, string> = {};
  for (const op of fresh.operations) {
    const isLedgerOfOp = (p: Page) => propText(p, wp.ledgerIdempotencyKey as string)?.trim() === op.idempotency_key;
    let rows = ledgerAll.filter(isLedgerOfOp);
    if (rows.length === 0) rows = await hinted(`LEDGER_${op.ordinal}`, dbs.ledger, (p) => isLedgerOfOp(p) && propText(p, wp.ledgerHarnessPlanId as string)?.trim() === link);
    if (rows.length === 0) return hold("HOLD_LEDGER_PREPARE_MISSING", [`no Mutation Ledger row carries ${wp.ledgerHarnessPlanId} = ${link} and ${wp.ledgerIdempotencyKey} = ${op.idempotency_key} (operation ${op.ordinal})`, "the persistence journal must be written before the effect can be blessed"], "execute the PREPARE_LEDGER action for this operation, then verify again");
    if (rows.length > 1) return hold("HOLD_DUPLICATE", [`${rows.length} Mutation Ledger rows carry the same plan and idempotency key for operation ${op.ordinal}`], "reconcile duplicate ledger rows by hand before verification");
    const row = rows[0] as Page;
    const refMentions = propMentions(row, g.ledgerProps.runRef);
    const refText = propText(row, g.ledgerProps.runRef) ?? "";
    if (!refMentions.includes(runRef) && !refText.includes(runRef)) return hold("HOLD_LEDGER_PREPARE_MISSING", [`ledger row ${normalizeId(row.id)} references Run ${refMentions[0] ?? (refText || "NONE")}, not the Run opened for this plan (${runRef})`], "fix the ledger row's Run reference (or re-create it) so it points at the plan's Run, then verify again");
    const st = propText(row, g.ledgerProps.status);
    if (st !== "PREPARED" && st !== "WRITTEN" && !(recovering && st === "VERIFIED")) return hold("HOLD_LEDGER_PREPARE_MISSING", [`ledger row ${normalizeId(row.id)} is ${st ?? "UNKNOWN"}; TARGET expects PREPARED or WRITTEN`], "reconcile the ledger row status before verification");
    if (st === "PREPARED") warnings.push(`ledger row for operation ${op.ordinal} is still PREPARED: the LEDGER_WRITTEN step was not observed; execute it before finalization`);
    ledgerRefs[op.idempotency_key] = normalizeId(row.id) as string;
    symbols[`LEDGER_${op.ordinal}`] = normalizeId(row.id) as string;
  }

  // 3. Targets: exact planned fields on exactly the planned record.
  const targets: Array<Record<string, unknown>> = [];
  for (const op of fresh.operations) {
    let page: Page;
    if (op.physical_target_ref) {
      try { page = (await client.retrievePage(op.physical_target_ref)) as Page; } catch (err) { return hold("HOLD_TARGET_NOT_WRITTEN", [`planned target ${op.physical_target_ref} unreadable: ${(err as Error).message}`], "the planned record no longer exists; reconcile before any retry"); }
      if (page.archived || page.in_trash) return hold("HOLD_TARGET_WRONG_RECORD", [`planned target ${op.physical_target_ref} is archived`], "restore or re-plan the target");
    } else {
      if (!op.target_data_source_ref || !op.natural_key || !op.natural_key_property) return hold("HOLD_TARGET_NOT_WRITTEN", [`operation ${op.ordinal} has no locatable CREATE identity`], "prepare again");
      const hasKey = (p: Page) => propText(p, op.natural_key_property as string)?.trim() === op.natural_key;
      let rows = (await queryAll(client, op.target_data_source_ref, naturalKeyFilter(op.natural_key_property_type, op.natural_key_property, op.natural_key))).filter(hasKey);
      if (rows.length === 0) rows = await hinted(`TARGET_${op.ordinal}`, op.target_data_source_ref, hasKey);
      if (rows.length === 0) return hold("HOLD_TARGET_NOT_WRITTEN", [`no row of data source ${op.target_data_source_ref} carries ${op.natural_key_property} = ${op.natural_key}`, "the planned CREATE is absent"], "execute the WRITE_TARGET action, then verify again");
      if (rows.length > 1) return hold("HOLD_TARGET_AMBIGUOUS", [`${rows.length} rows carry ${op.natural_key_property} = ${op.natural_key}: ${rows.map((r) => normalizeId(r.id)).join(", ")}`, "a duplicate CREATE is never eligible for a receipt"], "reconcile the duplicate rows by hand (archive the extra one), then verify again");
      page = rows[0] as Page;
    }
    const ds = parentDs(page);
    if (op.target_data_source_ref && ds && ds !== op.target_data_source_ref) return hold("HOLD_TARGET_WRONG_RECORD", [`record ${normalizeId(page.id)} belongs to data source ${ds}, not the planned ${op.target_data_source_ref}`], "the effect landed outside the planned record; reconcile before any retry");
    const redactValues = g.resources?.[op.logical_resource_key]?.redactValues === true;
    const cmp = compareFields(op, page, redactValues, symbols, fresh.state_last_write.operation_property_ids?.[String(op.ordinal)]);
    const observedForEnvelope = redactValues
      ? Object.fromEntries(Object.keys(cmp.observed).map((k) => [k, redactValue(cmp.observed[k])]))
      : cmp.observed;
    if (!cmp.ok) return hold(cmp.code, [...cmp.evidence, `planned record: ${normalizeId(page.id)}`], cmp.code === "HOLD_TARGET_NOT_WRITTEN" ? "execute the WRITE_TARGET action on exactly the planned record, then verify again" : "inspect the planned record; do not overwrite blindly — re-plan from fresh state if another actor changed it", { observations: { operation: op.ordinal, target_ref: normalizeId(page.id), observed: observedForEnvelope } });
    symbols[`TARGET_${op.ordinal}`] = normalizeId(page.id) as string;
    const protectedProps = g.resources?.[op.logical_resource_key]?.protectedProperties ?? [];
    const protectedSnapshot = Object.fromEntries(protectedProps.map((f) => [f, propText(page, f) ?? null]));
    targets.push({ ordinal: op.ordinal, target_ref: normalizeId(page.id), data_source_ref: ds ?? "UNKNOWN", logical_resource_key: op.logical_resource_key, compared_fields: op.compared_fields, observed: observedForEnvelope, protected: redactValues ? Object.fromEntries(Object.keys(protectedSnapshot).map((k) => [k, redactValue(protectedSnapshot[k])])) : protectedSnapshot, last_edited: page.last_edited_time ?? "UNKNOWN" });
  }

  // 3b. Candidate GTM constraints are re-checked against durable state as it is NOW: between prepare and verify a
  //     native Notion edit could have created a second ACTIVE enrollment, widened a parent version's Authority or
  //     removed a named campaign. A plan never commits a stale assumption (PV-GTM-002).
  const capabilityProofResourceForValidation = runtime.adapter.capabilities?.capabilityProofResource;
  if (runtime.adapter.capabilities?.gtm === true || (capabilityProofResourceForValidation !== undefined && fresh.operations.some((o) => o.logical_resource_key === capabilityProofResourceForValidation))) {
    const { revalidateGtmOperations } = await import("../gtm/intents.ts");
    const { findRows } = await import("../plans/resources.ts");
    const principal = await deps.principals.get(binding.principal_id);
    const stale = await revalidateGtmOperations(fresh.operations, {
      rep_identity_key: principal?.rep_identity_key,
      runtime_id: runtime.runtime_id,
      ...(runtime.adapter.capabilities ? { capabilities: runtime.adapter.capabilities } : {}),
      find: (logicalKey, property, value, project) => findRows(client, runtime, logicalKey, property, value, project),
    });
    if (stale) {
      return hold("HOLD_GTM_CONTRACT_VIOLATION", [...stale], "re-read the durable state and prepare again from what is true now");
    }
  }

  // 4. Receipt: one opaque receipt per successful verification, re-used when unchanged.
  const existing = (await store.receipts.findByPlan(plan.plan_id, "TARGET")).find((r) => r.status === "VALID");
  const observations = { run_ref: runRef, ledger_refs: ledgerRefs, targets, symbols, verified_at: now.toISOString() };
  if (existing) {
    const chk = await checkTargetReceipt(store, fresh, existing.receipt_id, now);
    if (chk.ok) return { kind: "VERIFIED", receipt: chk.receipt, symbols, observations, warnings, repeated: true };
  }
  const receipt = await issueTargetReceipt(store, deps.config, fresh, observations, now);
  return { kind: "VERIFIED", receipt, symbols, observations, warnings, repeated: false };
}

/** Drift after a successful TARGET: the previous receipt must never remain usable. */
export async function invalidateOnDrift(deps: HarnessDeps, plan: Plan, now: Date, reason: string): Promise<string[]> {
  const notes: string[] = [];
  for (const r of await deps.store.receipts.findByPlan(plan.plan_id, "TARGET")) {
    if (r.status === "VALID") { await deps.store.receipts.setStatus(r.receipt_id, "INVALID"); notes.push(`target receipt ${r.receipt_id} invalidated: ${reason}`); }
  }
  const fresh = await deps.store.plans.get(plan.plan_id);
  if (fresh && fresh.plan_state === "TARGET_VERIFIED") { await transition(deps.store, plan.plan_id, "HOLD", now, { reason }); notes.push(`plan ${plan.plan_id} moved to HOLD`); }
  return notes;
}
