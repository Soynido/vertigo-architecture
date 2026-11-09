/**
 * Deterministic write derivation (PV0-010). From a canonical plan the backend derives the ordered
 * stage-1 writes (Run open → ledger PREPARE → target write → ledger WRITTEN), the finalization writes
 * (ledger VERIFIED → Run COMPLETED) and the single state-last write. Nothing here executes: the native
 * writer (the server executor, or the native Notion app on the live V0 path) performs them; independent readback proves them.
 *
 * Symbols: `$created:<symbol>` = object created by an earlier write; `$receipt:TARGET` = the target receipt
 * id issued by the TARGET verification; `$now` = the writer's wall-clock ISO timestamp at write time.
 */
import type { ControlPlaneGrammar } from "../versions/adapters/controlPlane.ts";
import { isReadoption, type PlanOperation, type WriteInstruction } from "./store.ts";

export interface WriteContext {
  readonly plan_id: string;
  readonly summary: string;
  readonly runs_ds: string;
  readonly ledger_ds: string;
  readonly cursor_ref: string; // Manifest (META) or OS State CURRENT row (SALES)
  readonly gate_key: string;
  readonly governing: { readonly spec: string; readonly schema: string; readonly control: string };
  /** name → Notion property type, when readable. */
  readonly run_schema?: ReadonlyMap<string, string>;
  readonly ledger_schema?: ReadonlyMap<string, string>;
  readonly cursor_schema?: ReadonlyMap<string, string>;
  /** Target data source id → schema. */
  readonly target_schemas?: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

/** Property types Notion can accept on create/update. Anything else is system-computed. */
export const WRITABLE_TYPES: ReadonlySet<string> = new Set(["title", "rich_text", "select", "multi_select", "status", "checkbox", "number", "date", "url", "email", "phone_number", "relation", "people", "files"]);

function keep(schema: ReadonlyMap<string, string> | undefined, fields: Record<string, unknown>, warnings: string[], where: string): Record<string, unknown> {
  if (!schema) return fields;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    const t = schema.get(k);
    if (t === undefined) warnings.push(`${where} lacks property "${k}"; omitted from the write (FINAL proof of that fact will be weaker)`);
    else if (!WRITABLE_TYPES.has(t)) warnings.push(`${where} property "${k}" is ${t} (not writable); omitted from the write`);
    else out[k] = v;
  }
  return out;
}

function types(schema: ReadonlyMap<string, string> | undefined, fields: Record<string, unknown>): { property_types?: Record<string, string> } {
  if (!schema) return {};
  return { property_types: Object.fromEntries(Object.keys(fields).map((k) => [k, schema.get(k) ?? "UNKNOWN"])) };
}

export function deriveWrites(g: ControlPlaneGrammar, ops: readonly PlanOperation[], ctx: WriteContext): { stage1: WriteInstruction[]; finalization: WriteInstruction[]; state_last: WriteInstruction; warnings: string[] } {
  const warnings: string[] = [];
  const rp = g.runProps;
  const lp = g.ledgerProps;
  const wp = g.writeProps;
  const stage1: WriteInstruction[] = [];
  let ordinal = 0;

  const runFields: Record<string, unknown> = {
    [rp.title]: `PLUGIN — ${ctx.summary}`,
    [rp.status]: "RUNNING",
    [rp.origin]: wp?.runOriginValue ?? "PLUGIN",
    [rp.recoveryRequired]: false,
    [rp.specVersion]: ctx.governing.spec,
    [rp.schemaVersion]: ctx.governing.schema,
    ...(rp.controlVersion ? { [rp.controlVersion]: ctx.governing.control } : {}),
    [rp.gateBefore]: ctx.gate_key,
    [rp.gateAfterExpected]: ctx.gate_key,
    [rp.mutationCount]: ops.length,
    [rp.verifiedMutationCount]: 0,
    [rp.attemptCount]: 1,
    [rp.nextAction]: "stage 1 in progress: the journal and the target are being written, then verified",
    ...(wp?.runHarnessPlanId ? { [wp.runHarnessPlanId]: ctx.plan_id } : {}),
  };
  const openFields = keep(ctx.run_schema, runFields, warnings, "Runs schema");
  stage1.push({ ordinal: ordinal++, symbol: "OPEN_RUN", target_ref: ctx.runs_ds, operation: "CREATE", purpose: "OPEN_RUN", fields: openFields, note: "create the Run row first; every later write references it", ...types(ctx.run_schema, openFields) });

  for (const op of ops) {
    const sym = `LEDGER_${op.ordinal}`;
    // A CREATE target does not exist yet.  Keep the journal-before-effect order by
    // opening the PREPARED row without a Target Ref, then attach the created page
    // when the same ledger row advances to WRITTEN after WRITE_TARGET.
    const knownTargetRef = op.physical_target_ref;
    const ledgerFields: Record<string, unknown> = {
      [lp.title]: `${op.logical_resource_key} ${isReadoption(op) ? "RECONCILE" : op.operation} ${op.natural_key ?? op.physical_target_ref ?? ""}`.trim(),
      [lp.status]: "PREPARED",
      [lp.runRef]: "$created:OPEN_RUN",
      ...(wp?.ledgerTargetRef && knownTargetRef ? { [wp.ledgerTargetRef]: knownTargetRef } : {}),
      ...(wp?.ledgerOperation ? { [wp.ledgerOperation]: op.operation } : {}),
      ...(wp?.ledgerHarnessPlanId ? { [wp.ledgerHarnessPlanId]: ctx.plan_id } : {}),
      ...(wp?.ledgerIdempotencyKey ? { [wp.ledgerIdempotencyKey]: op.idempotency_key } : {}),
    };
    const prepFields = keep(ctx.ledger_schema, ledgerFields, warnings, "Mutation Ledger schema");
    stage1.push({ ordinal: ordinal++, symbol: sym, target_ref: ctx.ledger_ds, operation: "CREATE", purpose: "PREPARE_LEDGER", fields: prepFields, ...types(ctx.ledger_schema, prepFields) });
    const targetFields: Record<string, unknown> = { ...op.expected_values };
    const targetSchema = op.target_data_source_ref ? ctx.target_schemas?.get(op.target_data_source_ref) : undefined;
    // A re-adoption writes nothing: the row is re-examined as it stands and the receipt attests those values.
    // Forcing a same-value write just to move a date would be the artificial write the contract refuses.
    if (!isReadoption(op)) stage1.push({ ordinal: ordinal++, symbol: `TARGET_${op.ordinal}`, target_ref: op.physical_target_ref ?? (op.target_data_source_ref as string), operation: op.physical_target_ref ? "UPDATE" : "CREATE", purpose: "WRITE_TARGET", fields: targetFields, note: `compared fields: ${op.compared_fields.join(", ")}`, ...types(targetSchema, targetFields) });
    const writtenFields = {
      [lp.status]: "WRITTEN",
      ...(wp?.ledgerTargetRef && !knownTargetRef ? { [wp.ledgerTargetRef]: `$created:TARGET_${op.ordinal}` } : {}),
    };
    stage1.push({ ordinal: ordinal++, symbol: `${sym}_WRITTEN`, target_ref: `$created:${sym}`, operation: "UPDATE", purpose: "LEDGER_WRITTEN", fields: writtenFields, ...types(ctx.ledger_schema, writtenFields) });
  }

  const finalization: WriteInstruction[] = [];
  for (const op of ops) {
    const vf = keep(ctx.ledger_schema, { [lp.status]: "VERIFIED", ...(wp?.ledgerTargetReceiptId ? { [wp.ledgerTargetReceiptId]: "$receipt:TARGET" } : {}) }, warnings, "Mutation Ledger schema");
    finalization.push({ ordinal: ordinal++, symbol: `LEDGER_${op.ordinal}_VERIFIED`, target_ref: `$created:LEDGER_${op.ordinal}`, operation: "UPDATE", purpose: "LEDGER_VERIFIED", fields: vf, ...types(ctx.ledger_schema, vf) });
  }
  const ff = keep(ctx.run_schema, { [rp.status]: "COMPLETED", [rp.verifiedMutationCount]: ops.length, [rp.gateAfterObserved]: ctx.gate_key, [rp.lastRequiredWrittenAt]: "$now", [rp.nextAction]: "finalization written: the transaction is being verified" }, warnings, "Runs schema");
  finalization.push({ ordinal: ordinal++, symbol: "FINALIZE_RUN", target_ref: "$created:OPEN_RUN", operation: "UPDATE", purpose: "FINALIZE_RUN", fields: ff, ...types(ctx.run_schema, ff) });

  const cursor = g.stateCursor ?? g.manifestCursor;
  // When a plan's own target IS the cursor row — a derived gate transition — the target write is authoritative
  // for every field it proves. The state-last write must not then overwrite one of them a moment after TARGET
  // verified it, which the FINAL readback would correctly report as the target drifting.
  const provenOnCursor = new Set(ops.filter((o) => o.physical_target_ref === ctx.cursor_ref).flatMap((o) => o.compared_fields));
  const stateFields: Record<string, unknown> = {
    ...(cursor.lastRunRef ? { [cursor.lastRunRef]: "$created:OPEN_RUN" } : {}),
    ...(cursor.lastVerifiedMutation ? { [cursor.lastVerifiedMutation]: ops.length === 1 ? "$created:LEDGER_0" : `$created:LEDGER_${ops.length - 1}` } : {}),
    ...(cursor.lastVerifiedAt ? { [cursor.lastVerifiedAt]: "$now" } : {}),
    ...(cursor.lastRequiredWrittenAt ? { [cursor.lastRequiredWrittenAt]: "$now" } : {}),
  };
  for (const proven of provenOnCursor) delete stateFields[proven];
  const sf = keep(ctx.cursor_schema, stateFields, warnings, "State/Manifest schema");
  const state_last: WriteInstruction = { ordinal: ordinal++, symbol: "STATE_LAST", target_ref: ctx.cursor_ref, operation: "UPDATE", purpose: "STATE_LAST", fields: sf, note: "written LAST, only after the target is verified and the finalization writes are done", ...types(ctx.cursor_schema, sf) };
  return { stage1, finalization, state_last, warnings };
}
