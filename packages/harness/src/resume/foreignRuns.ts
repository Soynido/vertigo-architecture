/** W6.1/E12: freeze an explicit recovery list into the existing journaled Plan, not a second Run/store. */
import type { BindingRecord } from "../binding/store.ts";
import type { HoldCode } from "../errors/codes.ts";
import { encodeProperty } from "../notion/properties.ts";
import type { NotionReadClient } from "../notion/readClient.ts";
import { normalizeId, plainText, propMentions, propRelationIds, propText, type Page } from "../notion/shapes.ts";
import type { Intent, PrepareOutcome } from "../plans/prepare.ts";
import { sha } from "../plans/prepare.ts";
import { checkFields, checkRelationTargets, queryAll, readSchema, resolveTarget } from "../plans/resources.ts";
import { createPlan, opaqueId } from "../plans/service.ts";
import type { Plan, PlanOperation, WriteInstruction } from "../plans/store.ts";
import { deriveWrites } from "../plans/writes.ts";
import type { ResolvedRuntime } from "../resolvers/types.ts";
import type { HarnessDeps } from "../tools/handlers.ts";
import { checkSchemaCompatibility } from "../verify/schemaContract.ts";
import { comparableValue, observedField, sameValue } from "../verify/target.ts";
import { adoptionCeiling, adoptionClass } from "./foreignWrites.ts";
import { discoverControlPlane, readRun } from "./readers.ts";

export const FOREIGN_RUN_ACTION = "RECOVER_FOREIGN_RUN";
const empty = (v: string | undefined) => v === undefined || v === "" || v === "NONE" || v === "UNKNOWN";
const parent = (p: Page) => normalizeId(p.parent?.data_source_id ?? p.parent?.database_id);
const refs = (p: Page, f: string) => propMentions(p, f).length > 0 ? propMentions(p, f) : [normalizeId(propText(p, f)?.replace(/^page:/, ""))].filter((v): v is string => !!v);
const canonical = (v: Readonly<Record<string, unknown>>) => JSON.stringify(Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))));
const held = (code: HoldCode, evidence: string): PrepareOutcome => ({ kind: "HOLD", code, evidence: [evidence, "no foreign Run was attached or written"], safe_action: "supply the complete explicit recovery list or resolve the named ambiguity; never infer missing values", warnings: [] });

/** Closed shape of a backend-issued import root; a client cannot supply Plan/write instructions. */
export function isForeignRunImport(p: Plan): boolean {
  return p.plan_kind === "BUSINESS" && p.plan_origin === "AUTO_RECOVERY" && p.run_mode === "RECOVER_EXISTING"
    && p.recovers_plan_id === undefined && p.run_ref !== undefined && p.stage1_writes.some(w => w.symbol === "RESUME_RUN"
      && w.purpose === "RESUME_RUN" && w.target_ref === p.run_ref && w.baseline_revision !== undefined);
}

/** Fresh admission before every byte. An unclaimed Run must still be the exact observed revision. */
export async function foreignRunStillOwned(deps: { readonly notion: NotionReadClient }, runtime: ResolvedRuntime, root: Plan): Promise<boolean> {
  if (!isForeignRunImport(root)) return false;
  const g = runtime.adapter.controlPlane, wp = g.writeProps;
  if (!wp?.runHarnessPlanId || !root.run_ref) return false;
  try {
    const p = await deps.notion.retrievePage(root.run_ref) as Page;
    const linked = propText(p, wp.runHarnessPlanId)?.trim();
    const claim = root.stage1_writes.find(w => w.symbol === "RESUME_RUN")!;
    const run = readRun(p, g.runProps, wp.runHarnessPlanId);
    const owned = !p.archived && !p.in_trash && parent(p) === claim.baseline_parent_ref && (empty(linked) ? p.last_edited_time === claim.baseline_revision : linked === root.plan_id)
      && run.pins.spec === root.governing_spec_version && run.pins.schema === root.governing_schema_version
      && (!g.runProps.controlVersion || run.pins.control === root.governing_control_version)
      && run.mutation_count === root.operations.length;
    if (!owned) return false;
    for (const seed of root.stage1_writes.filter(w => w.purpose === "PREPARE_LEDGER" && w.operation === "UPDATE")) {
      const row = await deps.notion.retrievePage(seed.target_ref) as Page;
      const link = propText(row, wp.ledgerHarnessPlanId!);
      if (row.archived || row.in_trash || parent(row) !== seed.baseline_parent_ref || !refs(row, g.ledgerProps.runRef).includes(root.run_ref)
        || (empty(link) ? row.last_edited_time !== seed.baseline_revision : link !== root.plan_id || propText(row, wp.ledgerIdempotencyKey!) !== seed.fields[wp.ledgerIdempotencyKey!])) return false;
    }
    return true;
  } catch { return false; }
}

/** Called only after prepare's principal/version/lease checks and commit's scope/Production Guard checks. */
export async function prepareForeignRun(deps: HarnessDeps, binding: BindingRecord, runtime: ResolvedRuntime,
  intent: Intent, keys: readonly string[], governing: { spec: string; schema: string; control: string }, now: Date): Promise<PrepareOutcome> {
  const g = runtime.adapter.controlPlane, wp = g.writeProps;
  if (!g.independentConfigurationResourceKey || binding.lane !== "SALES") return held("HOLD_UNSUPPORTED_OPERATION", "foreign-Run import is confined to the declared candidate Sales grammar");
  if (!wp?.runHarnessPlanId || !wp.ledgerHarnessPlanId || !wp.ledgerIdempotencyKey || !wp.ledgerTargetRef)
    return held("HOLD_SCHEMA_MISMATCH", "structured Run/ledger linkage is required");
  const dbs = await discoverControlPlane(deps.notion, runtime.root_ref, g);
  if (!dbs.runs || !dbs.ledger || !dbs.state) return held("HOLD_REQUIRED_RESOURCE_MISSING", "the bound control plane is incomplete");
  const allRuns = await queryAll(deps.notion, dbs.runs, { or: [...g.incompleteRunStatuses.map(s => ({ property: g.runProps.status, select: { equals: s } })), { property: g.runProps.recoveryRequired, checkbox: { equals: true } }] });
  const incomplete = allRuns.filter(p => g.incompleteRunStatuses.includes(propText(p, g.runProps.status) ?? "") || propText(p, g.runProps.recoveryRequired) === "true");
  if (incomplete.length !== 1) return held("HOLD_RUN_AMBIGUOUS", "recovery requires exactly one incomplete Run in this runtime");
  const runPage = incomplete[0]!, run = readRun(runPage, g.runProps, wp.runHarnessPlanId);
  if (parent(runPage) !== dbs.runs || !empty(propText(runPage, wp.runHarnessPlanId))) return held("HOLD_CROSS_RUNTIME", "the Run is already attributed or not a member of this control plane");
  if (run.status !== "RUNNING" || !runPage.last_edited_time || !Number.isInteger(run.attempt_count) || Number(run.attempt_count) < 1 || !Number.isInteger(run.mutation_count) || run.mutation_count !== intent.mutations.length)
    return held("HOLD_RECOVERY_REQUIRED", "Run status/revision or completeness of the explicit mutation list is not established");
  if (run.pins.spec !== governing.spec || run.pins.schema !== governing.schema || (g.runProps.controlVersion && run.pins.control !== governing.control))
    return held("HOLD_VERSION_CHANGED", "the foreign Run pins differ from the bound governing versions");
  const cursors = (await queryAll(deps.notion, dbs.state, { property: "title", title: { equals: g.stateRowTitle ?? "CURRENT" } }))
    .filter(p => Object.values(p.properties).some(v => v.type === "title" && plainText((v as { title: readonly import("../notion/shapes.ts").RichText[] }).title) === (g.stateRowTitle ?? "CURRENT")));
  if (cursors.length !== 1 || parent(cursors[0]!) !== dbs.state) return held("HOLD_REQUIRED_RESOURCE_MISSING", "the candidate cursor is not uniquely established");
  const gateProperty = (g.stateCursor ?? g.manifestCursor).currentGate;
  if (!gateProperty) return held("HOLD_SCHEMA_MISMATCH", "the candidate cursor has no declared gate field");
  const cursor = cursors[0]!, gate = propText(cursor, gateProperty);
  if (empty(gate) || run.gate_after_expected !== gate) return held("HOLD_STATE_DIVERGENCE", "the Run's expected gate and current cursor disagree");
  const compatible = await checkSchemaCompatibility(deps.notion, runtime);
  const runSchema = await readSchema(deps.notion, dbs.runs), ledgerSchema = await readSchema(deps.notion, dbs.ledger), cursorSchema = await readSchema(deps.notion, dbs.state);
  if (!compatible.compatible || !runSchema || !ledgerSchema || !cursorSchema) return held("HOLD_SCHEMA_MISMATCH", "complete compatible control-plane schemas are required before import");
  const ledgers = (await queryAll(deps.notion, dbs.ledger, { property: g.ledgerProps.runRef, rich_text: { contains: run.ref } }))
    .filter(p => refs(p, g.ledgerProps.runRef).includes(run.ref));
  if (ledgers.some(p => !p.last_edited_time || parent(p) !== dbs.ledger || !empty(propText(p, wp.ledgerHarnessPlanId!)) || !["PREPARED", "WRITTEN", "VERIFIED"].includes(propText(p, g.ledgerProps.status) ?? ""))) return held("HOLD_CONFLICT", "a foreign ledger has unknown revision, is already attributed or has conflicting membership/status");

  const ops: PlanOperation[] = [], present = new Set<number>(), matched = new Map<number, Page>(), used = new Set<string>();
  const schemas = new Map<string, ReadonlyMap<string, string>>(), identities = new Set<string>();
  for (const [ordinal, m] of intent.mutations.entries()) {
    const spec = g.resources?.[m.logical_resource_key];
    if (!spec || spec.backendDerivedOnly || spec.externalEffect || !spec.operations.includes(m.operation)) return held("HOLD_ACTION_NOT_AUTHORIZED", "recovery list includes an unknown, backend-owned or external-effect resource");
    const resolved = await resolveTarget(deps.notion, runtime, binding.binding_mode, m.logical_resource_key, m.operation === "CREATE" ? "UPSERT" : m.operation, m.record_selector);
    if (!resolved.ok) return held(resolved.code, resolved.evidence.join("; "));
    const target = resolved.target;
    const fields = checkFields(target, m.desired_changes), relations = await checkRelationTargets(deps.notion, target, m.desired_changes);
    if (!fields.ok || !relations.ok) return held(!fields.ok ? fields.code : "HOLD_SCHEMA_MISMATCH", "recovery fields or relation targets violate the live schema");
    const key = target.kind === "NEW" ? target.natural_key : propText(target.page, spec.naturalKeyProperty);
    if (!key || identities.has(`${m.logical_resource_key}:${key}`)) return held("HOLD_DUPLICATE", "each recovery target must have one immutable identity and one mutation");
    identities.add(`${m.logical_resource_key}:${key}`);
    const source = target.kind === "EXISTING" ? propText(target.page, "Source") : m.desired_changes["Source"];
    if (!Object.keys(m.desired_changes).every(f => adoptionClass(g, m.logical_resource_key, key, f, { Source: source }) === "LOCAL_USER"))
      return held("HOLD_CONFLICT", "foreign authority, doctrine, external facts or unclassified fields cannot be imported as user-local state");
    const expected = { [spec.naturalKeyProperty]: key, ...m.desired_changes };
    for (const [f, v] of Object.entries(expected)) {
      const type = target.data_source.properties.get(f);
      const options = target.data_source.options.get(f);
      if (!type || !encodeProperty(type, v, options ? { options } : {}).ok) return held("HOLD_SCHEMA_MISMATCH", "a recovery value is outside its declared type/enum ceiling");
    }
    const compared = Object.keys(expected).filter(f => !spec.uncomparedProperties?.includes(f));
    const actual = target.kind === "EXISTING" ? Object.fromEntries(compared.map(f => [f, target.page.properties[f]?.type === "relation" ? propRelationIds(target.page, f) : propText(target.page, f) ?? null])) : {};
    const exists = target.kind === "EXISTING";
    const rows = ledgers.filter(p => !used.has(p.id) && (exists ? refs(p, wp.ledgerTargetRef!).includes(target.page_ref) : propText(p, "After Expected Hash") === sha(canonical(expected))));
    if (rows.length > 1) return held("HOLD_DUPLICATE", "multiple native ledger rows match one recovery target");
    const row = rows[0];
    if (row) { used.add(row.id); matched.set(ordinal, row); }
    let before: Readonly<Record<string, unknown>> = {};
    if (exists) {
      if (!adoptionCeiling(target.data_source, target.page, compared)) return held("HOLD_SCHEMA_MISMATCH", "the observed row exceeds its schema ceiling");
      const equal = compared.every(f => sameValue(comparableValue(target.page, f, expected[f as keyof typeof expected]), observedField(target.page, f)));
      if (equal) { present.add(ordinal); before = actual; }
      else if (m.operation === "UPDATE" && row && propText(row, "Before Hash") === sha(canonical(actual))) {
        let originalFields: unknown; try { originalFields = JSON.parse(propText(row, "Compared Fields") ?? "null"); } catch { /* not an original before-image proof */ }
        if (!Array.isArray(originalFields) || JSON.stringify([...originalFields].sort()) !== JSON.stringify([...compared].sort())) return held("HOLD_CONFLICT", "the original before hash does not identify exactly these fields");
        before = actual;
      } else return held("HOLD_CONFLICT", "a differing existing target has no proved original before-image; recovery never invents one");
    }
    schemas.set(target.data_source.id, target.data_source.properties);
    ops.push({ operation_id: opaqueId(), ordinal, logical_resource_key: m.logical_resource_key, operation: m.operation === "UPSERT" ? exists ? "UPDATE" : "CREATE" : m.operation,
      ...(exists ? { physical_target_ref: target.page_ref, baseline_revision: target.page.last_edited_time } : {}), target_data_source_ref: target.data_source.id,
      natural_key: key, natural_key_property: spec.naturalKeyProperty, natural_key_property_type: target.data_source.properties.get(spec.naturalKeyProperty)!,
      idempotency_key: keys[ordinal]!, compared_fields: compared, before_values: before, expected_values: expected,
      before_hash: sha(canonical(before)), expected_hash: sha(canonical(expected)) });
  }
  if (used.size !== ledgers.length) return held("HOLD_CONFLICT", "the explicit list does not uniquely cover every native ledger row");
  const planId = opaqueId();
  const derived = deriveWrites(g, ops, { plan_id: planId, summary: intent.summary, runs_ds: dbs.runs, ledger_ds: dbs.ledger,
    cursor_ref: cursor.id, gate_key: gate!, governing, run_schema: runSchema.properties, ledger_schema: ledgerSchema.properties,
    cursor_schema: cursorSchema.properties, target_schemas: schemas });
  const aliases = new Map<string, string>([["OPEN_RUN", run.ref], ...[...matched].map(([i, p]) => [`LEDGER_${i}`, p.id] as [string, string])]);
  const resolve = (value: unknown): unknown => typeof value === "string" && value.startsWith("$created:") && aliases.has(value.slice(9)) ? `page:${aliases.get(value.slice(9))}` : value;
  const replace = (w: WriteInstruction): WriteInstruction => ({ ...w,
    target_ref: w.target_ref.startsWith("$created:") && aliases.has(w.target_ref.slice(9)) ? aliases.get(w.target_ref.slice(9))! : w.target_ref,
    fields: Object.fromEntries(Object.entries(w.fields).map(([f, v]) => [f, resolve(v)])) });
  const stage1 = derived.stage1.filter(w => w.purpose !== "OPEN_RUN" && !(w.purpose === "WRITE_TARGET" && present.has(Number(w.symbol.split("_")[1])))).map(w => {
    const row = w.purpose === "PREPARE_LEDGER" ? matched.get(Number(w.symbol.split("_")[1])) : undefined;
    return replace(row ? { ...w, operation: "UPDATE", target_ref: row.id, baseline_revision: row.last_edited_time!, baseline_parent_ref: dbs.ledger! } : w);
  });
  stage1.unshift({ ordinal: 0, symbol: "RESUME_RUN", purpose: "RESUME_RUN", operation: "UPDATE", target_ref: run.ref,
    baseline_revision: runPage.last_edited_time, baseline_parent_ref: dbs.runs, fields: { [wp.runHarnessPlanId]: planId, [g.runProps.status]: "RUNNING", [g.runProps.attemptCount]: Number(run.attempt_count) + 1, [g.runProps.recoveryRequired]: false },
    property_types: Object.fromEntries([wp.runHarnessPlanId, g.runProps.status, g.runProps.attemptCount, g.runProps.recoveryRequired].map(f => [f, runSchema.properties.get(f)!])) });
  const frozen = await createPlan(deps.store, deps.config, { plan_id: planId, principal_id: binding.principal_id, binding, governing,
    run_mode: "RECOVER_EXISTING", run_ref: run.ref, plan_origin: "AUTO_RECOVERY", execution_attempt_id: opaqueId(),
    baseline_runtime_revision: cursor.last_edited_time ?? "UNKNOWN", operations: ops, stage1_writes: stage1.map((w, ordinal) => ({ ...w, ordinal })),
    finalization_writes: derived.finalization.map(replace), state_last_write: replace(derived.state_last) }, now);
  if (frozen.kind === "BUSY") return held("HOLD_RUNTIME_BUSY", "another plan owns this runtime lease");
  return { kind: "PREPARED", plan: frozen.plan, replayed: frozen.kind === "EXISTING", warnings: derived.warnings,
    observations: { cursor_ref: cursor.id, adopted_operations: [...present], foreign_run_ref: run.ref } };
}
