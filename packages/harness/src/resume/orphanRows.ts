/**
 * PV-ORPHAN-001 — answers the walk rests on that the product never recorded, and a cursor it did not move.
 *
 * On 2026-09-23 a conversation that never reached this backend wrote, through the seller's own Notion app, the
 * B3 and B4 answers of a Sales OS and moved its cursor two steps, with journal rows that read exactly like the
 * product's. PV-FW-001 could not see it: that check compares rows the product had PROVED with their receipts,
 * and none of these rows had one. The gap is the other side of the same property — a verification covers only
 * what it verified — so a row nothing verified has to be looked for, not merely re-compared.
 *
 * The scope is the governing contract's, not a scan: the rows this module looks for are exactly the ones the
 * walk's transitions name as evidence (`cursorTransitions[].evidence`), because those are the rows that move
 * the durable step. A row the seller adds under a key of their own in the same database is their business,
 * as FW-13 decided, and stays out. The cursor is looked at through the last FINAL receipt of the runtime, which
 * recorded the cursor's revision the moment the product last proved it.
 *
 * Nothing here decides. What it finds becomes a question the seller answers once, and a RECONCILE transaction
 * that re-adopts those exact rows as they stand — no write on them, a real Run, a real ledger, a real receipt.
 * What it cannot establish is reported as uncovered, never counted either way.
 */
import type { NotionReadClient } from "../notion/readClient.ts";
import { normalizeId, propText, type Page } from "../notion/shapes.ts";
import { discoverDataSource, naturalKeyFilter, queryAll, readSchema } from "../plans/resources.ts";
import type { Plan } from "../plans/store.ts";
import type { ResolvedRuntime } from "../resolvers/types.ts";
import type { CursorProps, DerivedCursorTransition, ResourceSpec } from "../versions/adapters/controlPlane.ts";
import type { ReceiptRecord } from "../verify/engine.ts";
import { observePendingStepInput, pendingStepInputOfTransition } from "./pendingInput.ts";
import type { Uncovered } from "./foreignWrites.ts";
import type { VerifiedObject } from "./verificationIndex.ts";
import { observedFingerprint, observationFingerprint } from "../verify/target.ts";

/** A row the contract names as a step's evidence, present in Notion, that no receipt of this runtime covers. */
export interface OrphanRow {
  readonly observation_hash?: string;
  readonly target_ref: string;
  readonly logical_resource_key: string;
  readonly natural_key: string;
  /** The step whose completion this row is the evidence of. */
  readonly gate_key: string;
  /** Every content field a transaction on this resource would have proved: a re-adoption attests all of them. */
  readonly governed_fields: readonly string[];
  readonly last_edited: string;
}

/** The durable cursor, edited since the product last proved it, with no transaction of this runtime in flight. */
export interface CursorDrift {
  readonly observation_hash?: string;
  readonly target_ref: string;
  readonly logical_resource_key: string;
  readonly natural_key: string;
  readonly current_gate: string;
  readonly last_edited_observed: string;
  readonly last_edited_verified: string;
  readonly receipt_id: string;
  /** The cursor's contract-fixed content, minus what STATE_LAST writes on every transaction. */
  readonly governed_fields: readonly string[];
  /** Changed fields only when a prior FINAL carried their fingerprints; no field values. */
  readonly fields?: readonly string[];
  readonly moved?: boolean;
}

/** A cursor sitting past a step whose evidence is not there: nothing can re-adopt that, and it is said as it is. */
export interface UnjustifiedCursor {
  readonly current_gate: string;
  readonly missing_step: string;
  readonly logical_resource_key: string;
  readonly natural_key: string;
  readonly observation: string;
}

export interface OrphanReport {
  readonly orphans: readonly OrphanRow[];
  readonly cursor?: CursorDrift;
  readonly unjustified?: UnjustifiedCursor;
  readonly coverage: { readonly checked: number; readonly unknown: readonly Uncovered[]; readonly in_flight: readonly string[] };
}

interface CursorRead { readonly ref: string; readonly last_edited: string; readonly current_gate: string }

const contentFields = (spec: ResourceSpec, schema: ReadonlySet<string>, minus: readonly string[] = []): string[] => {
  const excluded = new Set([...(spec.uncomparedProperties ?? []), ...(spec.protectedProperties ?? []), ...minus]);
  const candidates = spec.writableProperties ?? [...schema];
  return candidates.filter((f) => schema.has(f) && !excluded.has(f));
};

function inFlightRefs(plans: readonly Plan[]): { refs: Set<string>; keys: Set<string> } {
  const refs = new Set<string>();
  const keys = new Set<string>();
  for (const p of plans) for (const op of p.operations) {
    if (op.physical_target_ref) refs.add(op.physical_target_ref);
    if (op.natural_key) keys.add(`${op.logical_resource_key}::${op.natural_key}`);
  }
  return { refs, keys };
}

/** The receipt that last proved this runtime, if any: a FINAL that is still valid, the most recent one. */
export function lastProof(receipts: readonly ReceiptRecord[]): ReceiptRecord | undefined {
  const valid = receipts.filter((r) => r.type === "FINAL" && r.status !== "INVALID");
  return valid.length > 0 ? valid[valid.length - 1] : undefined;
}

/** Positive-only grouped observation. Unproved end/failed batch falls back to the existing per-key reader. */
async function groupedEvidence(client: NotionReadClient, ds: string, filters: readonly unknown[]): Promise<Page[] | undefined> {
  const rows: Page[] = [], seen = new Set<string>();
  let cursor: string | undefined;
  try {
    for (let n = 0; n < 50; n++) {
      const q = await client.queryDataSource(ds, { or: filters }, cursor, { page_size: 100 }) as
        { results?: Page[]; has_more?: boolean; next_cursor?: unknown };
      if (!Array.isArray(q.results)) return undefined;
      rows.push(...q.results.filter(p => !p.archived && !p.in_trash));
      if (q.has_more === false) return rows;
      if (q.has_more !== true || typeof q.next_cursor !== "string" || !q.next_cursor || seen.has(q.next_cursor)) return undefined;
      seen.add(q.next_cursor); cursor = q.next_cursor;
    }
  } catch { /* no absence or permission can be inferred from this batch */ }
  return undefined;
}

export async function readOrphanRows(
  client: NotionReadClient,
  runtime: ResolvedRuntime,
  index: ReadonlyMap<string, VerifiedObject>,
  opts: { readonly activePlans: readonly Plan[]; readonly lastFinal: ReceiptRecord | undefined; readonly cursor: CursorRead | undefined; readonly provedGate?: string | undefined; readonly captureObservation?: boolean },
): Promise<OrphanReport> {
  const transitions = runtime.adapter.controlPlane.cursorTransitions ?? [];
  const resources = runtime.adapter.controlPlane.resources ?? {};
  const inFlight = inFlightRefs(opts.activePlans);
  const orphans: OrphanRow[] = [];
  const unknown: Uncovered[] = [];
  const in_flight: string[] = [];
  let checked = 0;

  // 1. The evidence rows the walk names, grouped by resource so each database is discovered once.
  const byResource = new Map<string, DerivedCursorTransition[]>();
  for (const t of transitions) byResource.set(t.evidence.logicalResourceKey, [...(byResource.get(t.evidence.logicalResourceKey) ?? []), t]);
  for (const [resourceKey, ts] of byResource) {
    const spec = resources[resourceKey];
    if (!spec || spec.foreignWriteGuard !== true) continue;
    let ds: string;
    let schema: Awaited<ReturnType<typeof readSchema>>;
    try {
      const disc = await discoverDataSource(client, runtime, spec);
      if (!disc.ok) { unknown.push({ target_ref: resourceKey, logical_resource_key: resourceKey, reason: disc.evidence.join("; ") }); continue; }
      ds = disc.ds;
      schema = await readSchema(client, ds);
    } catch (err) { unknown.push({ target_ref: resourceKey, logical_resource_key: resourceKey, reason: `unreadable: ${(err as Error).message}` }); continue; }
    if (!schema) { unknown.push({ target_ref: resourceKey, logical_resource_key: resourceKey, reason: "schema unreadable" }); continue; }
    const keyType = schema.properties.get(spec.naturalKeyProperty);
    const governed = contentFields(spec, new Set(schema.properties.keys()));
    const filters = ts.map(t => naturalKeyFilter(keyType, spec.naturalKeyProperty, t.evidence.naturalKey));
    const grouped = opts.captureObservation && filters.length > 1 && filters.length <= 100 && filters.every(f => f !== undefined) && ts.every(t => t.evidence.naturalKey === t.evidence.naturalKey.trim())
      ? await groupedEvidence(client, ds, filters) : undefined;
    for (const t of ts) {
      const key = t.evidence.naturalKey;
      let rows: Page[];
      try { rows = (grouped ?? await queryAll(client, ds, naturalKeyFilter(keyType, spec.naturalKeyProperty, key))).filter((p) => (propText(p, spec.naturalKeyProperty) ?? "").trim() === key); }
      catch (err) { unknown.push({ target_ref: key, logical_resource_key: resourceKey, reason: `unreadable: ${(err as Error).message}` }); continue; }
      if (rows.length === 0) continue;
      if (rows.length > 1) { unknown.push({ target_ref: key, logical_resource_key: resourceKey, reason: `${rows.length} rows carry ${spec.naturalKeyProperty} = ${key}` }); continue; }
      const page = rows[0] as Page;
      const ref = normalizeId(page.id) ?? page.id;
      checked++;
      if (index.has(ref)) continue;
      if (inFlight.refs.has(ref) || inFlight.keys.has(`${resourceKey}::${key}`)) { in_flight.push(ref); continue; }
      orphans.push({ target_ref: ref, logical_resource_key: resourceKey, natural_key: key, gate_key: t.fromGate, governed_fields: governed, last_edited: page.last_edited_time ?? "UNKNOWN",
        ...(opts.captureObservation ? { observation_hash: observationFingerprint(page, [...governed, spec.naturalKeyProperty]) } : {}) });
    }
  }

  // 2. The cursor, against the revision the last FINAL of this runtime recorded. A transaction still in flight
  //    may legitimately be editing it, so the check is left to recovery while one exists; a runtime the product
  //    never proved has no reference, and says so.
  let cursor: CursorDrift | undefined;
  let unjustified: UnjustifiedCursor | undefined;
  const anchor = transitions[0];
  const verifiedRevision = opts.lastFinal?.observations["cursor_last_edited"];
  if (anchor && opts.cursor && opts.lastFinal && typeof verifiedRevision === "string" && verifiedRevision !== "UNKNOWN") {
    if (opts.cursor.last_edited === "UNKNOWN") unknown.push({ target_ref: opts.cursor.ref, logical_resource_key: anchor.targetResourceKey, reason: "cursor revision unreadable" });
    else if (opts.cursor.last_edited !== verifiedRevision) {
      if (opts.activePlans.length > 0) in_flight.push(opts.cursor.ref);
      else {
        const spec = resources[anchor.targetResourceKey];
        const props = (runtime.adapter.controlPlane.stateCursor ?? runtime.adapter.controlPlane.manifestCursor) as CursorProps;
        const stateLast = [props.lastRunRef, props.lastVerifiedMutation, props.lastVerifiedAt, props.lastRequiredWrittenAt].filter((p): p is string => typeof p === "string");
        let governed: string[] = [];
        if (spec) {
          try {
            const disc = await discoverDataSource(client, runtime, spec);
            const schema = disc.ok ? await readSchema(client, disc.ds) : undefined;
            if (schema) governed = contentFields(spec, new Set(schema.properties.keys()), stateLast);
          } catch { /* reported below through the empty governed set */ }
        }
        if (governed.length === 0) unknown.push({ target_ref: opts.cursor.ref, logical_resource_key: anchor.targetResourceKey, reason: "cursor schema unreadable; its content cannot be re-adopted" });
        else {
          const prior = opts.lastFinal.observations["cursor_observed"] as Record<string, string> | undefined;
          const page = prior || opts.captureObservation ? await client.retrievePage(opts.cursor.ref) as Page : undefined;
          const fields = page && governed.every(f => /^[a-f0-9]{64}$/.test(prior?.[f] ?? "")) ? governed.filter(f => observedFingerprint(page, f) !== prior![f]) : undefined;
          const currentGate = opts.captureObservation && page && props.currentGate ? propText(page, props.currentGate) ?? "UNKNOWN" : opts.cursor.current_gate;
          cursor = { target_ref: opts.cursor.ref, logical_resource_key: anchor.targetResourceKey, natural_key: anchor.targetNaturalKey, current_gate: currentGate, last_edited_observed: opts.captureObservation && page ? page.last_edited_time ?? "UNKNOWN" : opts.cursor.last_edited, last_edited_verified: verifiedRevision, receipt_id: opts.lastFinal.receipt_id, governed_fields: governed,
            ...(fields ? { fields } : {}), ...(opts.provedGate ? { moved: opts.provedGate !== currentGate } : {}),
            ...(opts.captureObservation && page && spec ? { observation_hash: observationFingerprint(page, [...governed, spec.naturalKeyProperty]) } : {}) };
          // 3. A moved cursor is only adoptable where the walk behind it is complete: every step it has passed
          //    since the product last held it must have its evidence row, exactly as the product would have
          //    required to move it itself. Steps before the last proved gate were vouched for by that proof.
          const sequence = runtime.adapter.controlPlane.gateSequence?.gates ?? [];
          const at = sequence.indexOf(currentGate);
          const from = Math.max(0, opts.provedGate ? sequence.indexOf(opts.provedGate) : 0);
          for (const step of at >= 0 ? sequence.slice(from, at) : []) {
            const t = transitions.find((x) => x.fromGate === step);
            if (!t) continue;
            const observed = await observePendingStepInput(client, runtime, pendingStepInputOfTransition(step, t));
            if (observed.kind === "SATISFIED") continue;
            unjustified = { current_gate: currentGate, missing_step: step, logical_resource_key: t.evidence.logicalResourceKey, natural_key: t.evidence.naturalKey, observation: observed.kind === "INCOMPLETE" ? `incomplete: ${observed.mismatched.join(", ")}` : observed.kind.toLowerCase() };
            break;
          }
        }
      }
    }
  }
  return { orphans, ...(cursor ? { cursor } : {}), ...(unjustified ? { unjustified } : {}), coverage: { checked, unknown, in_flight } };
}

/** Human labels for the rows a seller actually recognises; the FW-001 labels, kept in one place. */
export const STEP_LABEL: Readonly<Record<string, string>> = {
  "B0_DISCOVERY:PRIMARY_OUTCOME": "votre objectif commercial",
  "B1_OFFER:SELLABLE_OFFER": "votre définition d’offre",
  "B2_ICP:TARGET_ACCOUNTS": "votre définition des comptes à viser",
  "B3_DATA:CANONICAL_SOURCE": "votre source de comptes et de contacts",
  "B4_QUALIFICATION:HARD_GATE": "vos critères de disqualification",
  "B5_OUTREACH:SEQUENCE": "votre séquence de prise de contact",
  "B6_AUTHORITY:SEND_AUTHORITY": "ce que l’agent peut envoyer seul",
};

export interface OrphanConfirmation {
  readonly kind: "ORPHAN_ROWS";
  readonly rows: readonly { readonly logical_resource_key: string; readonly natural_key: string; readonly gate_key: string }[];
  readonly cursor_moved: boolean;
  readonly question: string;
  readonly intent: {
    readonly action_class: "RECONCILE";
    readonly summary: string;
    /** One re-adoption per row, `desired_changes` empty: the row is attested exactly as it stands. */
    readonly mutations: readonly { readonly logical_resource_key: string; readonly operation: "UPDATE"; readonly record_selector: { readonly natural_key: string }; readonly desired_changes: Readonly<Record<string, never>> }[];
  };
}

/**
 * The one question these findings are owed, and the one call that can follow it, already filled. The seller
 * owns the space: what was written there without the product is theirs to keep or not, never an incident.
 */
export function orphanConfirmationFor(report: OrphanReport): OrphanConfirmation | undefined {
  if (report.orphans.length === 0 && !report.cursor) return undefined;
  const labels = report.orphans.map((o) => STEP_LABEL[o.natural_key] ?? `l’enregistrement ${o.natural_key}`);
  const list = labels.length === 0 ? "" : labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(", ")} et ${labels[labels.length - 1]}`;
  const parts: string[] = [];
  if (list) parts.push(`J’ai trouvé dans votre espace ${labels.length === 1 ? "une réponse que je n’ai pas enregistrée moi-même" : "des réponses que je n’ai pas enregistrées moi-même"} : ${list}.`);
  if (report.cursor) parts.push(`L’étape affichée (${report.cursor.current_gate}) a aussi été modifiée en dehors de mes enregistrements.`);
  parts.push(labels.length + (report.cursor ? 1 : 0) > 1 ? "C’est bien votre décision de garder tout cela ?" : "C’est bien votre décision ?");
  const mutations = [
    ...report.orphans.map((o) => ({ logical_resource_key: o.logical_resource_key, operation: "UPDATE" as const, record_selector: { natural_key: o.natural_key }, desired_changes: {} })),
    ...(report.cursor ? [{ logical_resource_key: report.cursor.logical_resource_key, operation: "UPDATE" as const, record_selector: { natural_key: report.cursor.natural_key }, desired_changes: {} }] : []),
  ];
  return {
    kind: "ORPHAN_ROWS",
    rows: report.orphans.map((o) => ({ logical_resource_key: o.logical_resource_key, natural_key: o.natural_key, gate_key: o.gate_key })),
    cursor_moved: report.cursor !== undefined,
    question: parts.join(" "),
    intent: { action_class: "RECONCILE", summary: `adopt what the seller confirms was written in their space without the product: ${[...report.orphans.map((o) => o.natural_key), ...(report.cursor ? ["the durable cursor"] : [])].join(", ")}`, mutations },
  };
}
