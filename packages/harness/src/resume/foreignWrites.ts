/**
 * PV-FW-001 — re-read every proved row of a guarded resource and compare its governed content with the receipt.
 *
 * The comparison is on content, never on a date: the same fingerprint the receipt stored is recomputed on the
 * live row, field by field. The revision is reported as context. What could not be read is reported as
 * uncovered — an unreadable row is not a verified row, and its cause is never guessed.
 */
import type { NotionReadClient } from "../notion/readClient.ts";
import { normalizeId, propText, type Page } from "../notion/shapes.ts";
import type { ResolvedRuntime } from "../resolvers/types.ts";
import { redact } from "../gtm/semantics.ts";
import { observedField, observationFingerprint } from "../verify/target.ts";
import type { VerifiedObject } from "./verificationIndex.ts";
import type { ControlPlaneGrammar } from "../versions/adapters/controlPlane.ts";
import type { DataSourceSchema } from "../plans/resources.ts";
import { encodeProperty } from "../notion/properties.ts";

export type AdoptionClass = "LOCAL_USER" | "EXTERNAL_FACT" | "SECURITY_AUTHORITY" | "COMPANY_DOCTRINE";
const AUTHORITY = /(do.?not.?contact|\bdnc\b|opt.?out|unsubscri|bounce|send.?authority|authority|approval|consent)/i;
const LOCAL_META_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "META:GATES": ["Next Question", "Next Action"],
  "META:INPUTS": ["Input", "Gate Key", "Question", "Answer", "State"],
};
const LOCAL_SOURCES: readonly unknown[] = ["CHAT_USER_EXPLICIT", "AGENT_PROPOSED_USER_VALIDATED"];

/** D9/D10 is a closed authority boundary, not a configurable ResourceSpec.adoption framework.
 * `key` and `before` come from the stored plan / last proof, never an edited Source or Category.
 * An unknown mapping is not permission to adopt. All differing fields must be seller-local.
 */
export function adoptionClass(g: ControlPlaneGrammar, resource: string, key: string | undefined, field: string, before: Readonly<Record<string, unknown>>): AdoptionClass | undefined {
  const spec = g.resources?.[resource];
  if (!spec) return undefined;
  if (AUTHORITY.test(field) || key?.startsWith("B6_AUTHORITY:") || spec.protectedProperties?.includes(field)) return "SECURITY_AUTHORITY";
  if (spec.externalEffect || ["SALES:INTERACTIONS", "SALES:RECEIPTS", "SALES:CAPABILITY_PROOFS"].includes(resource)) return "EXTERNAL_FACT";
  if (before["Source"] === "META_PUBLISHED") return "COMPANY_DOCTRINE";
  if (spec.backendDerivedOnly || spec.scope === "OBJECTIVE_PACKAGE") return undefined;
  if (LOCAL_META_FIELDS[resource]?.includes(field)) return "LOCAL_USER";
  if (!spec.writableProperties?.includes(field)) return undefined;
  if (resource === "SALES:BUSINESS_CONFIG") {
    const declared = g.cursorTransitions?.some(t => t.evidence.logicalResourceKey === resource && t.evidence.naturalKey === key);
    const independent = g.independentConfigurationResourceKey === resource && key !== undefined && key.trim() !== ""
      && !g.cursorTransitions?.some(t => key.startsWith(`${t.fromGate}:`));
    if (!(declared || independent) || !LOCAL_SOURCES.includes(before["Source"])) return undefined;
    return "LOCAL_USER";
  }
  if (resource === "SALES:QUALIFICATION_GATES" || resource === "SALES:TASKS") return "LOCAL_USER";
  return undefined;
}

/** Same schema ceiling as a write, without coercion, option creation or a same-value target write. */
export function adoptionCeiling(schema: DataSourceSchema, page: Page, fields: readonly string[]): boolean {
  return fields.every(field => {
    const type = schema.properties.get(field);
    const property = page.properties[field];
    if (!type || !property || property.type !== type) return false;
    if (property.type === "relation" && (!Array.isArray(property.relation) || property["has_more"] === true)) return false;
    if (property.type === "multi_select" && !Array.isArray(property.multi_select)) return false;
    const value = property.type === "relation" ? (property.relation as Array<{ id?: string }>).map(r => r?.id)
      : property.type === "multi_select" ? (property.multi_select as Array<{ name?: string }>).map(option => option?.name)
      : propText(page, field) ?? null;
    const typed = property.type === "checkbox" ? property.checkbox : property.type === "number" ? property.number : value;
    const options = schema.options.get(field);
    return encodeProperty(type, typed, options ? { options } : {}).ok;
  });
}

export interface ForeignWrite {
  readonly observation_hash?: string;
  readonly target_ref: string;
  readonly logical_resource_key: string;
  readonly natural_key: string | "UNKNOWN";
  /** Governed fields whose content no longer matches the receipt. Names only. */
  readonly fields: readonly string[];
  /** Every field the receipt governed on this row: a re-adoption must attest all of them. */
  readonly governed_fields: readonly string[];
  readonly last_edited_observed: string;
  readonly last_edited_verified: string;
  readonly receipt_id: string;
}

export interface InFlightOp {
  readonly target_ref: string;
  readonly compared_fields: readonly string[];
  readonly before_values: Readonly<Record<string, unknown>>;
  readonly expected_values: Readonly<Record<string, unknown>>;
}

export interface Uncovered { readonly target_ref: string; readonly logical_resource_key: string; readonly reason: string }

export interface Coverage {
  /** Rows re-read and compared. */
  readonly checked: number;
  /** Rows the check could not establish anything about. Never counted as verified. */
  readonly unknown: readonly Uncovered[];
  /** Rows left to recovery because a transaction of this runtime is still in flight on them. */
  readonly in_flight: readonly string[];
}

export interface ForeignWriteReport { readonly foreign: readonly ForeignWrite[]; readonly coverage: Coverage }

export function guardedResourceKeys(runtime: ResolvedRuntime): ReadonlySet<string> {
  const out = new Set<string>();
  for (const [key, spec] of Object.entries(runtime.adapter.controlPlane.resources ?? {})) {
    // Opt-in only, and never on a resource whose rows are edited outside transactions by design.
    if (spec.foreignWriteGuard === true && spec.externalEffect !== true && spec.scope !== "OBJECTIVE_PACKAGE") out.add(key);
  }
  return out;
}

export async function readForeignWrites(
  client: NotionReadClient,
  runtime: ResolvedRuntime,
  index: ReadonlyMap<string, VerifiedObject>,
  opts: { readonly exclude: ReadonlySet<string>; readonly inFlight: ReadonlyMap<string, InFlightOp>; readonly captureObservation?: boolean },
): Promise<ForeignWriteReport> {
  const guarded = guardedResourceKeys(runtime);
  const resources = runtime.adapter.controlPlane.resources ?? {};
  const foreign: ForeignWrite[] = [];
  const unknown: Uncovered[] = [];
  const in_flight: string[] = [];
  let checked = 0;
  for (const obj of index.values()) {
    if (!guarded.has(obj.logical_resource_key) || opts.exclude.has(obj.target_ref)) continue;
    const spec = resources[obj.logical_resource_key];
    const pending = opts.inFlight.get(obj.target_ref);
    let page: Page;
    try { page = (await client.retrievePage(obj.target_ref)) as Page; } catch (err) { unknown.push({ target_ref: obj.target_ref, logical_resource_key: obj.logical_resource_key, reason: `unreadable: ${(err as Error).message}` }); continue; }
    if (page.archived || page.in_trash) { unknown.push({ target_ref: obj.target_ref, logical_resource_key: obj.logical_resource_key, reason: "archived" }); continue; }
    const redacted = spec?.redactValues === true;
    const print = (v: unknown): string | null => (redacted ? redact(v) : v === undefined || v === null ? null : String(v));
    if (pending) {
      // A transaction of this runtime is still in flight on this row: recovery owns it, and its truth table is the
      // right instrument. But a row that carries neither what the plan found nor what the plan intends was not
      // written by that plan at all, and staying silent would let a foreign write hide behind unfinished work.
      const unexplained = pending.compared_fields.filter((f) => {
        const seen = observedField(page, f) ?? null;
        const live = redacted ? redact(seen) : seen;
        return live !== print(pending.expected_values[f]) && live !== print(pending.before_values[f]);
      });
      if (unexplained.length === 0) { in_flight.push(obj.target_ref); continue; }
      checked++;
      const key = spec ? (propText(page, spec.naturalKeyProperty) ?? "UNKNOWN") : "UNKNOWN";
      foreign.push({ target_ref: normalizeId(page.id) ?? obj.target_ref, logical_resource_key: obj.logical_resource_key, natural_key: key, fields: unexplained, governed_fields: obj.fields, last_edited_observed: page.last_edited_time ?? "UNKNOWN", last_edited_verified: obj.last_edited, receipt_id: obj.receipt_id,
        ...(opts.captureObservation ? { observation_hash: observationFingerprint(page, [...obj.fields, ...(spec ? [spec.naturalKeyProperty] : [])]) } : {}) });
      continue;
    }
    checked++;
    const diverging: string[] = [];
    for (const field of obj.fields) {
      if (!(field in obj.observed)) continue;
      const seen = observedField(page, field) ?? null;
      const fingerprint = redacted ? redact(seen) : seen;
      if (fingerprint !== obj.observed[field]) diverging.push(field);
    }
    if (diverging.length === 0) continue;
    const naturalKey = spec ? (propText(page, spec.naturalKeyProperty) ?? "UNKNOWN") : "UNKNOWN";
    foreign.push({ target_ref: normalizeId(page.id) ?? obj.target_ref, logical_resource_key: obj.logical_resource_key, natural_key: naturalKey, fields: diverging, governed_fields: obj.fields, last_edited_observed: page.last_edited_time ?? "UNKNOWN", last_edited_verified: obj.last_edited, receipt_id: obj.receipt_id,
      ...(opts.captureObservation ? { observation_hash: observationFingerprint(page, [...obj.fields, ...(spec ? [spec.naturalKeyProperty] : [])]) } : {}) });
  }
  return { foreign, coverage: { checked, unknown, in_flight } };
}

export function foreignWriteEvidence(w: ForeignWrite): string {
  return `${w.logical_resource_key} ${w.natural_key !== "UNKNOWN" ? w.natural_key : w.target_ref} changed outside any transaction — fields: ${w.fields.join(", ")}; edited ${w.last_edited_observed}, last proved ${w.last_edited_verified} by receipt ${w.receipt_id}`;
}

/**
 * The confirmation a changed row is owed, served exactly like a step's pending input: the question, and the one
 * call that can follow, already filled. The seller owns these rows — a change they made is a decision to record,
 * not an incident to refuse. Only their confirmation turns it into a verified fact.
 */
export interface PendingConfirmation {
  readonly kind: "FOREIGN_WRITE";
  readonly logical_resource_key: string;
  readonly natural_key: string;
  readonly fields: readonly string[];
  readonly question: string;
  readonly intent: {
    readonly action_class: "RECONCILE";
    readonly summary: string;
    readonly mutations: readonly { readonly logical_resource_key: string; readonly operation: "UPDATE"; readonly record_selector: { readonly natural_key: string }; readonly desired_changes: Readonly<Record<string, string>> }[];
  };
}

/** Human labels for the rows a seller actually recognises. Unknown keys fall back to the record's own key. */
const LABEL: Readonly<Record<string, string>> = {
  "B0_DISCOVERY:PRIMARY_OUTCOME": "votre objectif commercial",
  "B1_OFFER:SELLABLE_OFFER": "votre définition d\u2019offre",
  "B2_ICP:TARGET_ACCOUNTS": "votre définition des comptes à viser",
  "B3_DATA:CANONICAL_SOURCE": "votre source de comptes et de contacts",
  "B4_QUALIFICATION:HARD_GATE": "vos critères de disqualification",
  "B5_OUTREACH:SEQUENCE": "votre séquence de prise de contact",
  "B6_AUTHORITY:SEND_AUTHORITY": "ce que l\u2019agent peut envoyer seul",
};

export function pendingConfirmationFor(w: ForeignWrite, current: Readonly<Record<string, string>>): PendingConfirmation {
  const label = LABEL[w.natural_key] ?? `l\u2019enregistrement ${w.natural_key}`;
  return {
    kind: "FOREIGN_WRITE",
    logical_resource_key: w.logical_resource_key,
    natural_key: w.natural_key,
    fields: w.fields,
    question: `J\u2019ai vu que ${label} a changé depuis que je l\u2019ai enregistré. C\u2019est bien votre décision ?`,
    intent: { action_class: "RECONCILE", summary: `re-adopt ${w.natural_key} as the seller confirms it`, mutations: [{ logical_resource_key: w.logical_resource_key, operation: "UPDATE", record_selector: { natural_key: w.natural_key }, desired_changes: current }] },
  };
}
