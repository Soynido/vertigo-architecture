/**
 * Recovery truth-table engine (PV0-015, PG6).
 *
 * An interrupted transaction is recovered ONLY by observing durable state, never by assumption:
 *   observed target == expected  → reconcile: the effect exists, nothing is replayed;
 *   observed target == before    → replay the planned write only if the governing contract permits;
 *   any other observed state     → HOLD_CONFLICT (a concurrent legitimate change is never clobbered) — or, under
 *                                  conflict policy D10, re-adopted as the user left it when every differing
 *                                  field is the user's local state (never a protected or authority field);
 *   CREATE                       → located by data source + natural key; 0 rows = not created, >1 = HOLD.
 * Plan expiry never implies effect absence. A recovery plan continues the interrupted plan's Run and
 * ledger rows (linkage id = the original plan id), bumps the Run attempt count and preserves versions.
 */
import type { HoldCode } from "../errors/codes.ts";
import type { BindingRecord } from "../binding/store.ts";
import type { NotionReadClient } from "../notion/readClient.ts";
import { foreignRunStillOwned, isForeignRunImport } from "../resume/foreignRuns.ts";
import { createHash } from "node:crypto";
import { normalizeId, propMentions, propRelationIds, propText, type Page } from "../notion/shapes.ts";
import type { Plan, PlanOperation, PlanOrigin, PlanWriteRow, WriteInstruction } from "../plans/store.ts";
import { linkageId } from "../plans/store.ts";
import { createPlan, expireIfDue, opaqueId, type PlanDraft } from "../plans/service.ts";
import { naturalKeyFilter, readSchema } from "../plans/resources.ts";
import { WRITABLE_TYPES } from "../plans/writes.ts";
import type { ResolvedRuntime } from "../resolvers/types.ts";
import { discoverControlPlane } from "../resume/readers.ts";
import type { HarnessDeps } from "../tools/handlers.ts";
import { comparableValue, observedField, referencesId, sameOperationValue, sameValue } from "../verify/target.ts";
import type { ControlPlaneGrammar } from "../versions/adapters/controlPlane.ts";
import { adoptionCeiling, adoptionClass } from "../resume/foreignWrites.ts";
import { redact } from "../gtm/semantics.ts";

export type OpKind = "EXPECTED" | "BEFORE" | "CONFLICT" | "MISSING" | "AMBIGUOUS" | "WRONG_RECORD" | "ADOPTED";
export interface OpObservation {
  readonly ordinal: number; readonly kind: OpKind; readonly page_ref?: string; readonly observed: Readonly<Record<string, string | null>>; readonly evidence: readonly string[];
  /** CONFLICT / ADOPTED: the fields that are neither the before nor the expected value. */
  readonly conflicting?: readonly string[];
  /** CONFLICT / ADOPTED: every compared field as Notion holds it, in the shape a plan compares (relations as id lists). */
  readonly as_is?: Readonly<Record<string, unknown>>;
}

/**
 * How a recovery treats a target that is neither at its before nor at its expected state.
 *   HOLD — stop for a human (the historical behavior, and the default).
 *   D10  — PV-WRITE-001 D10: the user's local edit wins inside the field's ceiling. The target is re-adopted
 *          exactly as it stands (no write), provided no differing field is protected by the resource or carries
 *          authority (do-not-contact, opt-out, bounce, send authority, approval); otherwise HOLD as above.
 */
export type ConflictPolicy = "HOLD" | "D10";

export interface AssessOptions {
  /** The interrupted plan's own write journal (server executor), when it has one. */
  readonly journal?: readonly PlanWriteRow[];
  readonly conflictPolicy?: ConflictPolicy;
}
export interface LedgerObservation { readonly ref: string; readonly status: string; readonly run_ref: string | "NONE"; readonly target_ref: string | "NONE" | "NOT_APPLICABLE"; readonly import_linkage_missing?: boolean }
export type RecoveryPhase = "STAGE1" | "TARGET_PENDING" | "FINALIZATION" | "FINAL_PENDING";

export type Assessment =
  | { readonly kind: "HOLD"; readonly code: HoldCode; readonly evidence: readonly string[]; readonly safe_action: string; readonly ops?: readonly OpObservation[] }
  | { readonly kind: "NOTHING_DURABLE"; readonly ops: readonly OpObservation[] }
  | { readonly kind: "RECOVERABLE"; readonly phase: RecoveryPhase; readonly run_ref: string; readonly run_status: string; readonly attempt_count: number; readonly ledger: Readonly<Record<string, LedgerObservation>>; readonly ops: readonly OpObservation[]; readonly replay: readonly number[]; readonly journal_repair: readonly number[]; readonly adopted: readonly number[]; readonly next_safe_action: string };

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

function classify(op: PlanOperation, page: Page, created: Readonly<Record<string, string>> = {}, redacted = false): { kind: "EXPECTED" | "BEFORE" | "CONFLICT"; observed: Record<string, string | null>; evidence: string[]; conflicting: string[]; as_is: Record<string, unknown> } {
  const observed: Record<string, string | null> = {};
  const conflicting: string[] = [];
  const as_is: Record<string, unknown> = {};
  for (const f of op.compared_fields) as_is[f] = page.properties[f]?.type === "relation" ? propRelationIds(page, f) : (propText(page, f) ?? null);
  let allExpected = true;
  let allBefore = true;
  const evidence: string[] = [];
  const print = (value: unknown) => JSON.stringify(redacted ? redact(value) : value);
  for (const f of op.compared_fields) {
    // Recovery must read a field exactly as TARGET proof reads it, relations included: a link the writer did
    // store must never be classified as a conflict that sends a seller to manual inspection.
    const seen = observedField(page, f);
    // A planned reference to an object this plan created is resolved from the id actually observed, exactly as
    // TARGET and FINAL resolve it; otherwise a correctly written reference would read as a conflict.
    const planned = op.expected_values[f];
    const reference = typeof planned === "string" && planned.startsWith("$created:") ? created[planned.slice("$created:".length)] : undefined;
    if (reference !== undefined) {
      observed[f] = redacted ? redact(seen ?? null) : seen ?? null;
      if (referencesId(page, f, reference)) { allBefore = false; continue; }
      allExpected = false;
      conflicting.push(f);
      evidence.push(`${f}: observed ${print(seen ?? null)} does not reference ${reference}`);
      continue;
    }
    const expected = comparableValue(page, f, planned);
    const before = comparableValue(page, f, op.before_values[f]);
    observed[f] = redacted ? redact(seen ?? null) : seen ?? null;
    const isExp = sameOperationValue(op, f, expected, seen);
    const isBefore = f in op.before_values ? sameValue(before, seen) : false;
    if (!isExp) allExpected = false;
    if (!isBefore) allBefore = false;
    if (!isExp && !isBefore) { conflicting.push(f); evidence.push(`${f}: observed ${print(seen ?? null)}, before ${print(before ?? null)}, expected ${print(expected)}`); }
  }
  if (allExpected) return { kind: "EXPECTED", observed, evidence: ["target already carries the planned expected values"], conflicting, as_is };
  if (allBefore) return { kind: "BEFORE", observed, evidence: ["target is exactly at the recorded before state; the planned write never landed"], conflicting, as_is };
  return { kind: "CONFLICT", observed, evidence: evidence.length > 0 ? evidence : ["target mixes before and expected values"], conflicting, as_is };
}

export type RecoveryPlanOutcome =
  | { readonly kind: "PREPARED"; readonly plan: Plan; readonly replayed: boolean; readonly warnings: readonly string[]; readonly observations: Readonly<Record<string, unknown>> }
  | { readonly kind: "HOLD"; readonly code: HoldCode; readonly evidence: readonly string[]; readonly safe_action: string; readonly warnings: readonly string[]; readonly observations?: Readonly<Record<string, unknown>> };

export interface RecoveryPlanContext {
  readonly governing: { readonly spec: string; readonly schema: string; readonly control: string };
  readonly now: Date;
  readonly cursor_last_edited?: unknown;
  readonly warnings?: readonly string[];
  /** PV-WRITE-001: an automatic recovery (settle) records its origin and the plan it continues. */
  readonly origin?: PlanOrigin;
  readonly journal?: readonly PlanWriteRow[];
  readonly conflictPolicy?: ConflictPolicy;
}

/** D7: as_is is backend input for recovery, not a business-value read exception. */
function publicOperations(operations: readonly OpObservation[]): readonly OpObservation[] {
  return operations.map(operation => {
    const { as_is: _private, ...publicOperation } = operation;
    return publicOperation;
  });
}

/**
 * Open a fresh, binding-scoped recovery plan for one stored BUSINESS plan.
 * The old plan is never adopted or verified through the new binding: durable state is observed first and the
 * new plan continues only the original linkage id, Run and journal rows.
 */
export async function openRecoveryPlan(deps: HarnessDeps, binding: BindingRecord, runtime: ResolvedRuntime, original: Plan, ctx: RecoveryPlanContext): Promise<RecoveryPlanOutcome> {
  const warnings = [...(ctx.warnings ?? [])];
  await expireIfDue(deps.store, original, ctx.now);
  const freshOriginal = (await deps.store.plans.get(original.plan_id)) ?? original;
  const link = linkageId(freshOriginal);
  const a = await assessRecovery(deps, runtime, freshOriginal, { ...(ctx.journal ? { journal: ctx.journal } : {}), ...(ctx.conflictPolicy ? { conflictPolicy: ctx.conflictPolicy } : {}) });
  if (a.kind === "NOTHING_DURABLE") {
    return {
      kind: "HOLD", code: "HOLD_PLAN_EXPIRED",
      evidence: [`expired plan ${freshOriginal.plan_id} left no durable Run, journal row or target effect`, "no recovery plan was created"],
      safe_action: "call os_resume, then let the backend issue or prepare the current step normally; do not replay the expired plan",
      warnings, observations: { recovers_plan_id: link, operations: publicOperations(a.ops) },
    };
  }
  if (a.kind === "HOLD") {
    return { kind: "HOLD", code: a.code, evidence: [...a.evidence, `interrupted plan ${freshOriginal.plan_id} (${freshOriginal.plan_state}) could not be recovered automatically`, "no recovery plan was created"], safe_action: a.safe_action, warnings, observations: { recovers_plan_id: link, operations: publicOperations(a.ops ?? []) } };
  }
  const g = runtime.adapter.controlPlane;
  const dbs = await discoverControlPlane(deps.notion, runtime.root_ref, g);
  if (!dbs.runs || !dbs.ledger) return { kind: "HOLD", code: "HOLD_REQUIRED_RESOURCE_MISSING", evidence: ["control-plane databases missing", "no recovery plan was created"], safe_action: "restore the runtime control plane", warnings };
  const runSchema = (await readSchema(deps.notion, dbs.runs))?.properties;
  const ledgerSchema = (await readSchema(deps.notion, dbs.ledger))?.properties;
  const targetSchemas = new Map<string, ReadonlyMap<string, string>>();
  for (const op of freshOriginal.operations) {
    if (op.target_data_source_ref && !targetSchemas.has(op.target_data_source_ref)) {
      const sch = await readSchema(deps.notion, op.target_data_source_ref);
      if (sch) targetSchemas.set(op.target_data_source_ref, sch.properties);
    }
  }
  const imported = isForeignRunImport(freshOriginal) ? freshOriginal : freshOriginal.recovers_plan_id ? await deps.store.plans.get(freshOriginal.recovers_plan_id) : undefined;
  const stage1 = deriveRecoveryWrites(g, freshOriginal, a, { link, ledger_ds: dbs.ledger, target_schemas: targetSchemas,
    ...(imported && isForeignRunImport(imported) ? { import_manifest: imported } : {}),
    ...(runSchema ? { run_schema: runSchema } : {}), ...(ledgerSchema ? { ledger_schema: ledgerSchema } : {}) });
  // A recovery plan is a new durable plan row. Its operations preserve the
  // original idempotency / target semantics, but need fresh row identities:
  // plan_operations.operation_id is globally unique in the PostgreSQL store.
  const recoveryOperations = freshOriginal.operations.map((operation) => {
    const adopted = a.ops.find((o) => o.ordinal === operation.ordinal && o.kind === "ADOPTED");
    if (!adopted?.as_is) return { ...operation, operation_id: opaqueId() };
    // D10 re-adoption: the row as the user left it is what this recovery attests; nothing is written to it.
    const values = Object.fromEntries(operation.compared_fields.map((f) => [f, adopted.as_is?.[f] ?? null]));
    const hash = createHash("sha256").update(JSON.stringify(values)).digest("hex");
    return { ...operation, operation_id: opaqueId(), before_values: values, expected_values: values, before_hash: hash, expected_hash: hash };
  });
  const draft: PlanDraft = {
    plan_id: opaqueId(), principal_id: binding.principal_id, binding, governing: ctx.governing,
    run_mode: "RECOVER_EXISTING", run_ref: a.run_ref, recovers_plan_id: link, execution_attempt_id: opaqueId(),
    baseline_runtime_revision: typeof ctx.cursor_last_edited === "string" ? ctx.cursor_last_edited : freshOriginal.baseline_runtime_revision,
    operations: recoveryOperations, stage1_writes: stage1, finalization_writes: freshOriginal.finalization_writes, state_last_write: freshOriginal.state_last_write,
    ...(ctx.origin ? { plan_origin: ctx.origin, parent_plan_id: freshOriginal.plan_id } : {}),
  };
  const created = await createPlan(deps.store, deps.config, draft, ctx.now);
  if (created.kind === "BUSY") return { kind: "HOLD", code: "HOLD_RUNTIME_BUSY", evidence: [`another plan (${created.holder_plan_id}) holds the runtime lease`, "no recovery plan was created"], safe_action: "wait for the active plan to reach a terminal state, then resume", warnings };
  if (created.kind === "EXISTING") return { kind: "PREPARED", plan: created.plan, replayed: true, warnings, observations: { recovery: { phase: a.phase }, recovers_plan_id: link } };
  warnings.push(`RECOVER_EXISTING: continuing Run ${a.run_ref} (attempt ${a.attempt_count + 1}) of plan ${link}; phase ${a.phase}; replay ${a.replay.length > 0 ? a.replay.join(", ") : "none"}; journal repair ${a.journal_repair.length > 0 ? a.journal_repair.join(", ") : "none"}`);
  return { kind: "PREPARED", plan: created.plan, replayed: false, warnings, observations: { recovery: { phase: a.phase, run_ref: a.run_ref, run_status: a.run_status, attempt_count: a.attempt_count + 1, replay: a.replay, journal_repair: a.journal_repair, adopted: a.adopted, operations: publicOperations(a.ops), ledger: a.ledger, next_safe_action: a.next_safe_action }, recovers_plan_id: link } };
}

/** Observe one operation's target: UPDATE by planned page, CREATE by data source + natural key. */
export async function observeOperation(client: NotionReadClient, op: PlanOperation, created: Readonly<Record<string, string>> = {}, options: { readonly redacted?: boolean; readonly onPage?: (page: Page) => void } = {}): Promise<OpObservation> {
  if (op.physical_target_ref) {
    let page: Page;
    try { page = (await client.retrievePage(op.physical_target_ref)) as Page; } catch (err) { return { ordinal: op.ordinal, kind: "WRONG_RECORD", observed: {}, evidence: [`planned target ${op.physical_target_ref} unreadable: ${(err as Error).message}`] }; }
    if (page.archived || page.in_trash) return { ordinal: op.ordinal, kind: "WRONG_RECORD", page_ref: op.physical_target_ref, observed: {}, evidence: [`planned target ${op.physical_target_ref} is archived`] };
    options.onPage?.(page);
    const c = classify(op, page, created, options.redacted);
    return { ordinal: op.ordinal, kind: c.kind, page_ref: op.physical_target_ref, observed: c.observed, evidence: c.evidence, ...(c.kind === "CONFLICT" ? { conflicting: c.conflicting, as_is: c.as_is } : {}) };
  }
  if (!op.target_data_source_ref || !op.natural_key || !op.natural_key_property) return { ordinal: op.ordinal, kind: "WRONG_RECORD", observed: {}, evidence: ["CREATE operation without a locatable identity"] };
  const rows = (await queryAll(client, op.target_data_source_ref, naturalKeyFilter(op.natural_key_property_type, op.natural_key_property, op.natural_key))).filter((p) => propText(p, op.natural_key_property as string)?.trim() === op.natural_key);
  if (rows.length === 0) return { ordinal: op.ordinal, kind: "MISSING", observed: {}, evidence: [`no row of ${op.target_data_source_ref} carries ${op.natural_key_property} = ${op.natural_key}: the CREATE never landed`] };
  if (rows.length > 1) return { ordinal: op.ordinal, kind: "AMBIGUOUS", observed: {}, evidence: [`${rows.length} rows carry ${op.natural_key_property} = ${op.natural_key}: ${rows.map((r) => normalizeId(r.id)).join(", ")}`] };
  const page = rows[0] as Page;
  options.onPage?.(page);
  const c = classify(op, page, created, options.redacted);
  return { ordinal: op.ordinal, kind: c.kind === "BEFORE" ? "CONFLICT" : c.kind, page_ref: normalizeId(page.id) as string, observed: c.observed, evidence: c.kind === "BEFORE" ? ["a row with the natural key exists but does not carry the planned values"] : c.evidence };
}

/** Assess the durable state left behind by an interrupted plan. Read-only. */
export async function assessRecovery(deps: HarnessDeps, runtime: ResolvedRuntime, original: Plan, options: AssessOptions = {}): Promise<Assessment> {
  const client = deps.notion;
  const g = runtime.adapter.controlPlane;
  const wp = g.writeProps;
  const link = linkageId(original);
  const ops: OpObservation[] = [];
  const candidate = isForeignRunImport(original) ? original : original.recovers_plan_id ? await deps.store.plans.get(original.recovers_plan_id) : undefined;
  const imported = candidate && isForeignRunImport(candidate) ? candidate : undefined;
  if (imported && (!["principal_id", "project", "lane", "runtime_logical_key", "runtime_id", "runtime_generation", "governing_spec_version", "governing_schema_version", "governing_control_version"]
    .every(k => imported[k as keyof Plan] === original[k as keyof Plan]) || !await foreignRunStillOwned(deps, runtime, imported)))
    return { kind: "HOLD", code: "HOLD_CONFLICT", evidence: ["the frozen foreign-Run manifest lost its scoped ownership"], safe_action: "resolve the exact import ownership before any recovery", ops };

  // The executor's journal is the harness's own record of what it sent. A plan whose every row is still PENDING
  // (or was refused before anything landed) left nothing durable: no Notion read is needed to know it.
  if (!imported && options.journal && options.journal.length > 0 && options.journal.every((r) => r.status === "PENDING" || (r.status === "FAILED_FINAL" && r.attempts === 0))) {
    return { kind: "NOTHING_DURABLE", ops };
  }

  const dbs = await discoverControlPlane(client, runtime.root_ref, g);
  if (!dbs.runs || !dbs.ledger || !wp?.runHarnessPlanId || !wp.ledgerHarnessPlanId || !wp.ledgerIdempotencyKey) return { kind: "HOLD", code: "HOLD_REQUIRED_RESOURCE_MISSING", evidence: ["control plane or harness linkage unavailable; recovery cannot read the journal"], safe_action: "restore the control plane / schema contract, then resume", ops };
  let runRows = (await queryAll(client, dbs.runs, { property: wp.runHarnessPlanId, rich_text: { equals: link } })).filter((p) => propText(p, wp.runHarnessPlanId as string)?.trim() === link);
  // A Run the query index does not show yet, but the journal says the executor created: read it directly, and
  // accept it only if it carries this plan's harness id.
  const journaledRun = options.journal?.find((r) => r.symbol === "OPEN_RUN" && r.created_id)?.created_id;
  if (runRows.length === 0 && journaledRun) {
    try {
      const page = (await client.retrievePage(journaledRun)) as Page;
      if (!page.archived && !page.in_trash && propText(page, wp.runHarnessPlanId)?.trim() === link) runRows = [page];
    } catch { /* unreadable: the query result stands */ }
  }
  if (imported && runRows.length === 0) runRows = [await client.retrievePage(imported.run_ref!) as Page];
  const ledgerRows = (await queryAll(client, dbs.ledger, { property: wp.ledgerHarnessPlanId, rich_text: { equals: link } })).filter((p) => propText(p, wp.ledgerHarnessPlanId as string)?.trim() === link);
  const nativeSeeds = imported?.stage1_writes.filter(w => w.purpose === "PREPARE_LEDGER" && w.operation === "UPDATE") ?? [];
  for (const seed of nativeSeeds) if (!ledgerRows.some(p => normalizeId(p.id) === seed.target_ref)) ledgerRows.push(await client.retrievePage(seed.target_ref) as Page);
  const ledgerFor = (op: PlanOperation) => ledgerRows.filter(p => propText(p, wp.ledgerIdempotencyKey!)?.trim() === op.idempotency_key
    || nativeSeeds.some(seed => seed.symbol === `LEDGER_${op.ordinal}` && normalizeId(p.id) === seed.target_ref));
  // The Run this plan opened, when it exists, resolves any `$created:OPEN_RUN` a planned field points at.
  const observedRun = runRows.length === 1 ? { OPEN_RUN: normalizeId((runRows[0] as Page).id) as string } : {};
  for (const op of original.operations) {
    let page: Page | undefined;
    const spec = g.resources?.[op.logical_resource_key];
    const o = await observeOperation(client, op, observedRun, { redacted: spec?.redactValues === true, onPage: p => { page = p; } });
    // D10: immutable identity + prior provenance + every field's authority and live schema ceiling.
    // Reuse the observation read; no raw page is added to public recovery observations.
    let local = options.conflictPolicy === "D10" && o.kind === "CONFLICT" && o.conflicting !== undefined && o.conflicting.length > 0 && o.as_is !== undefined && page !== undefined
      && (op.natural_key === undefined ? op.logical_resource_key.startsWith("META:") : propText(page, spec?.naturalKeyProperty ?? "") === op.natural_key)
      && o.conflicting.every(f => adoptionClass(g, op.logical_resource_key, op.natural_key, f, op.before_values) === "LOCAL_USER");
    if (local && page) {
      if (op.logical_resource_key === "SALES:BUSINESS_CONFIG" && !["CHAT_USER_EXPLICIT", "AGENT_PROPOSED_USER_VALIDATED"].includes(propText(page, "Source") ?? "")) local = false;
      const schema = op.target_data_source_ref ? await readSchema(client, op.target_data_source_ref) : undefined;
      local = local && schema !== undefined && adoptionCeiling(schema, page, op.compared_fields);
    }
    ops.push(options.conflictPolicy === "D10" && local && op.operation === "UPDATE" ? { ...o, kind: "ADOPTED", evidence: [...o.evidence, "D10: the user's local edit is kept as it stands"] } : o);
  }
  const ledger: Record<string, LedgerObservation> = {};
  for (const op of original.operations) {
    const rows = ledgerFor(op);
    if (rows.length > 1) return { kind: "HOLD", code: "HOLD_DUPLICATE", evidence: [`${rows.length} ledger rows for operation ${op.ordinal}; the journal is ambiguous`], safe_action: "reconcile the duplicate ledger rows by hand, then resume", ops };
  }
  const anyEffect = ops.some((o) => o.kind === "EXPECTED" || o.kind === "ADOPTED") || ledgerRows.length > 0;

  if (runRows.length > 1) return { kind: "HOLD", code: "HOLD_RUN_AMBIGUOUS", evidence: [`${runRows.length} Run rows carry the harness plan id ${link}`], safe_action: "reconcile the duplicate Run rows by hand, then resume", ops };
  if (runRows.length === 0) {
    if (original.plan_origin === "AUTO_RECONCILE" && ledgerRows.length === 0
      && !original.stage1_writes.some(w => w.purpose === "WRITE_TARGET")
      && original.operations.every(op => op.before_hash === op.expected_hash)
      && ops.every(o => o.kind === "EXPECTED" || o.kind === "BEFORE")) return { kind: "NOTHING_DURABLE", ops };
    if (!anyEffect && ops.every((o) => o.kind === "BEFORE" || o.kind === "MISSING")) return { kind: "NOTHING_DURABLE", ops };
    return { kind: "HOLD", code: "HOLD_RECOVERY_REQUIRED", evidence: ["durable effects or journal rows exist without a Run for this plan", ...ops.flatMap((o) => o.evidence)], safe_action: "reconcile the journal by hand: open or reference the Run that owns these effects, then resume", ops };
  }
  const run = runRows[0] as Page;
  const runRef = normalizeId(run.id) as string;
  const runStatus = propText(run, g.runProps.status) ?? "UNKNOWN";
  const attempt = Number(propText(run, g.runProps.attemptCount) ?? "1") || 1;

  // Linkage fields are part of the journal truth, not decoration. A missing value is safely repairable because
  // Harness Plan ID + idempotency key already identify exactly one Run and one observed target. A conflicting
  // non-empty value is never overwritten automatically.
  for (const op of original.operations) {
    const row = ledgerFor(op)[0];
    if (!row) continue;
    const refFrom = (property: string | undefined): string | undefined => property
      ? propMentions(row, property)[0] ?? normalizeId(propText(row, property))
      : undefined;
    ledger[op.idempotency_key] = {
      ref: normalizeId(row.id) as string,
      status: propText(row, g.ledgerProps.status) ?? "UNKNOWN",
      run_ref: refFrom(g.ledgerProps.runRef) ?? "NONE",
      target_ref: wp.ledgerTargetRef ? (refFrom(wp.ledgerTargetRef) ?? "NONE") : "NOT_APPLICABLE",
      ...(imported && propText(row, wp.ledgerHarnessPlanId)?.trim() !== link ? { import_linkage_missing: true } : {}),
    };
  }

  const conflicts = ops.filter((o) => o.kind === "CONFLICT" || o.kind === "WRONG_RECORD");
  if (conflicts.length > 0) return { kind: "HOLD", code: "HOLD_CONFLICT", evidence: conflicts.flatMap((o) => o.evidence.map((e) => `operation ${o.ordinal}: ${e}`)), safe_action: "inspect the target by hand; the observed state is neither the recorded before state nor the planned expected state, so nothing is replayed or overwritten", ops };
  const ambiguous = ops.filter((o) => o.kind === "AMBIGUOUS");
  if (ambiguous.length > 0) return { kind: "HOLD", code: "HOLD_TARGET_AMBIGUOUS", evidence: ambiguous.flatMap((o) => o.evidence), safe_action: "archive the duplicate rows by hand so exactly one carries the natural key, then resume", ops };
  const linkageConflicts = original.operations.flatMap((op) => {
    const row = ledger[op.idempotency_key];
    const observedTarget = ops.find((o) => o.ordinal === op.ordinal)?.page_ref;
    if (!row) return [];
    return [
      ...(row.run_ref !== "NONE" && row.run_ref !== runRef ? [`ledger ${row.ref} points at Run ${row.run_ref}, not ${runRef}`] : []),
      ...(observedTarget && row.target_ref !== "NONE" && row.target_ref !== "NOT_APPLICABLE" && row.target_ref !== observedTarget ? [`ledger ${row.ref} points at target ${row.target_ref}, not observed target ${observedTarget}`] : []),
    ];
  });
  if (linkageConflicts.length > 0) return { kind: "HOLD", code: "HOLD_CONFLICT", evidence: linkageConflicts, safe_action: "inspect the conflicting journal references by hand; recovery never overwrites a non-empty reference to another object", ops };
  const replay = ops.filter((o) => o.kind === "BEFORE" || o.kind === "MISSING").map((o) => o.ordinal);
  if (replay.length > 0 && !(g.recoveryPolicy?.replayFromBeforeState ?? false)) return { kind: "HOLD", code: "HOLD_RECOVERY_REQUIRED", evidence: [`operation(s) ${replay.join(", ")} are at their before state and the governing contract does not permit replay`, ...ops.filter((o) => replay.includes(o.ordinal)).flatMap((o) => o.evidence)], safe_action: "apply the planned write by hand under the governing contract, then resume; the harness never replays without contract permission", ops };
  const adopted = ops.filter((o) => o.kind === "ADOPTED").map((o) => o.ordinal);
  const journal_repair = original.operations.filter((op) => {
    const kind = ops.find((o) => o.ordinal === op.ordinal)?.kind;
    if (kind !== "EXPECTED" && kind !== "ADOPTED") return false;
    const row = ledger[op.idempotency_key];
    return !row || row.status === "PREPARED" || row.run_ref === "NONE" || row.target_ref === "NONE" || row.import_linkage_missing;
  }).map((op) => op.ordinal);
  const allVerified = original.operations.every((op) => ledger[op.idempotency_key]?.status === "VERIFIED");

  if (runStatus === "COMPLETED") {
    if (replay.length > 0 || !allVerified) return { kind: "HOLD", code: "HOLD_CONFLICT", evidence: [`Run ${runRef} is COMPLETED but the journal/targets are incomplete (replay ${replay.join(", ") || "none"}; ledger ${Object.values(ledger).map((l) => l.status).join(", ") || "none"})`], safe_action: "reconcile the Run by hand; a COMPLETED Run with an incomplete journal cannot be recovered automatically", ops };
    return { kind: "RECOVERABLE", phase: "FINAL_PENDING", run_ref: runRef, run_status: runStatus, attempt_count: attempt, ledger, ops, replay: [], journal_repair: [], adopted, next_safe_action: "nothing to write: call os_verify(TARGET) then os_verify(FINAL) to reconstruct the verification; if the state-last write is missing, execute it after TARGET" };
  }
  const phase: RecoveryPhase = replay.length > 0 ? "STAGE1" : allVerified ? "FINALIZATION" : "TARGET_PENDING";
  const next = phase === "STAGE1" ? `execute the recovery stage-1 actions (replay of operation(s) ${replay.join(", ")} permitted by the governing contract), then os_verify(TARGET)` : phase === "FINALIZATION" ? "execute RESUME_RUN, then os_verify(TARGET), then the finalization actions it returns, state-last LAST, then os_verify(FINAL)" : "execute the journal-repair actions (no target replay), then os_verify(TARGET)";
  return { kind: "RECOVERABLE", phase, run_ref: runRef, run_status: runStatus, attempt_count: attempt, ledger, ops, replay, journal_repair, adopted, next_safe_action: next };
}

export interface RecoveryWriteContext {
  readonly link: string;
  readonly ledger_ds: string;
  readonly run_schema?: ReadonlyMap<string, string>;
  readonly ledger_schema?: ReadonlyMap<string, string>;
  readonly target_schemas?: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly import_manifest?: Plan;
}

function keep(schema: ReadonlyMap<string, string> | undefined, fields: Record<string, unknown>): Record<string, unknown> {
  if (!schema) return fields;
  return Object.fromEntries(Object.entries(fields).filter(([k]) => schema.has(k) && WRITABLE_TYPES.has(schema.get(k) as string)));
}
function types(schema: ReadonlyMap<string, string> | undefined, fields: Record<string, unknown>): { property_types?: Record<string, string> } {
  return schema ? { property_types: Object.fromEntries(Object.keys(fields).map((k) => [k, schema.get(k) ?? "UNKNOWN"])) } : {};
}

/** Recovery stage-1: resume the Run, repair the journal, replay only what the truth table allows. */
export function deriveRecoveryWrites(g: ControlPlaneGrammar, original: Plan, a: Extract<Assessment, { kind: "RECOVERABLE" }>, ctx: RecoveryWriteContext): WriteInstruction[] {
  const rp = g.runProps;
  const lp = g.ledgerProps;
  const wp = g.writeProps;
  const out: WriteInstruction[] = [];
  let ordinal = 0;
  if (a.phase !== "FINAL_PENDING") {
    const f = keep(ctx.run_schema, { [rp.status]: "RUNNING", [rp.attemptCount]: a.attempt_count + 1, [rp.nextAction]: `recovery attempt ${a.attempt_count + 1}: ${a.next_safe_action}`,
      ...(ctx.import_manifest && wp?.runHarnessPlanId ? { [wp.runHarnessPlanId]: ctx.link } : {}) });
    out.push({ ordinal: ordinal++, symbol: "RESUME_RUN", target_ref: a.run_ref, operation: "UPDATE", purpose: "RESUME_RUN", fields: f, note: "same Run, next attempt; versions and history preserved", ...types(ctx.run_schema, f) });
  }
  for (const op of original.operations) {
    const obs = a.ops.find((o) => o.ordinal === op.ordinal);
    const row = a.ledger[op.idempotency_key];
    const replaying = a.replay.includes(op.ordinal);
    const repairing = a.journal_repair.includes(op.ordinal);
    if (!replaying && !repairing) continue;
    const sym = `LEDGER_${op.ordinal}`;
    const ledgerRef = row ? row.ref : `$created:${sym}`;
    // For a replayed CREATE, the target page is deliberately unknown while the
    // PREPARED journal row is created.  Link it only after WRITE_TARGET has run.
    const knownTargetRef = op.physical_target_ref ?? obs?.page_ref;
    if (row?.import_linkage_missing) {
      const seed = ctx.import_manifest?.stage1_writes.find(w => w.symbol === sym && w.purpose === "PREPARE_LEDGER" && w.target_ref === row.ref);
      if (seed) out.push({ ...seed, ordinal: ordinal++ });
    }
    if (!row) {
      const lf = keep(ctx.ledger_schema, { [lp.title]: `${op.logical_resource_key} ${op.operation} ${op.natural_key ?? op.physical_target_ref ?? ""}`.trim(), [lp.status]: "PREPARED", [lp.runRef]: `page:${a.run_ref}`, ...(wp?.ledgerTargetRef && knownTargetRef ? { [wp.ledgerTargetRef]: knownTargetRef } : {}), ...(wp?.ledgerOperation ? { [wp.ledgerOperation]: op.operation } : {}), ...(wp?.ledgerHarnessPlanId ? { [wp.ledgerHarnessPlanId]: ctx.link } : {}), ...(wp?.ledgerIdempotencyKey ? { [wp.ledgerIdempotencyKey]: op.idempotency_key } : {}) });
      out.push({ ordinal: ordinal++, symbol: sym, target_ref: ctx.ledger_ds, operation: "CREATE", purpose: "PREPARE_LEDGER", fields: lf, note: "journal repair: the ledger row for this operation was missing", ...types(ctx.ledger_schema, lf) });
    }
    if (replaying) {
      const targetRef = op.physical_target_ref ?? (op.target_data_source_ref as string);
      const ts = op.target_data_source_ref ? ctx.target_schemas?.get(op.target_data_source_ref) : undefined;
      const tf: Record<string, unknown> = { ...op.expected_values };
      out.push({ ordinal: ordinal++, symbol: `TARGET_${op.ordinal}`, target_ref: targetRef, operation: op.physical_target_ref ? "UPDATE" : "CREATE", purpose: "WRITE_TARGET", fields: tf, note: `replay permitted by the governing contract: target observed at its ${obs?.kind === "MISSING" ? "not-created" : "before"} state`, ...types(ts, tf) });
    }
    if (!row || row.status === "PREPARED" || replaying || repairing) {
      const repairedTargetRef = replaying && !knownTargetRef ? `$created:TARGET_${op.ordinal}` : knownTargetRef ? `page:${knownTargetRef}` : undefined;
      const wf = {
        [lp.status]: "WRITTEN",
        ...(row?.run_ref === "NONE" ? { [lp.runRef]: `page:${a.run_ref}` } : {}),
        ...(wp?.ledgerTargetRef && row?.target_ref === "NONE" && repairedTargetRef ? { [wp.ledgerTargetRef]: repairedTargetRef } : {}),
        ...(wp?.ledgerTargetRef && !row && replaying && !knownTargetRef ? { [wp.ledgerTargetRef]: `$created:TARGET_${op.ordinal}` } : {}),
      };
      out.push({ ordinal: ordinal++, symbol: `${sym}_WRITTEN`, target_ref: ledgerRef, operation: "UPDATE", purpose: "LEDGER_WRITTEN", fields: wf, ...types(ctx.ledger_schema, wf) });
    }
  }
  return out;
}
