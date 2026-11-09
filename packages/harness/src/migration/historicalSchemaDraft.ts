/** Pure local historical-migration rehearsal. NOT an API payload, write plan or schema admission.
 * Keeps complete existing schema objects; never calls a client, installer, registry or version adapter.
 */
import { createHash } from "node:crypto";

type ObjectValue = Record<string, unknown>;
export interface HistoricalSchemaRequirements {
  readonly properties: Readonly<Record<string, string>>;
  readonly selectOptions?: Readonly<Record<string, readonly string[]>>;
}
export interface HistoricalSchemaDraft {
  readonly kind: "HISTORICAL_SCHEMA_ADDITIONS_DRAFT/1";
  readonly status: "DRAFT_ADDITIONS_ONLY" | "HOLD_STRUCTURAL_GAPS";
  readonly source_schema_sha256: string | null;
  readonly projected_schema_sha256: string | null;
  readonly projected_schema: ObjectValue | null;
  readonly property_additions: readonly { readonly property: string; readonly type: string }[];
  readonly option_additions: readonly { readonly property: string; readonly option: string }[];
  readonly holds: readonly { readonly code: string; readonly property?: string; readonly observed_type?: string; readonly expected_type?: string }[];
  readonly schema_admitted: false;
  readonly execution_authorized: false;
  readonly writer_authorized: false;
}
const object = (v: unknown): ObjectValue | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as ObjectValue : undefined;
const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : object(v)
  ? Object.fromEntries(Object.keys(v as ObjectValue).sort().map(k => [k, canonical((v as ObjectValue)[k])])) : v;
const digest = (v: unknown): string => createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");
const own = (v: ObjectValue, key: string): boolean => Object.prototype.hasOwnProperty.call(v, key);
const set = (v: ObjectValue, key: string, value: unknown): void => { Object.defineProperty(v, key, { value, enumerable: true, writable: true, configurable: true }); };
const SCALAR_ADDITIONS = new Set(["rich_text", "number", "checkbox", "url", "email", "phone_number", "date", "select", "multi_select"]);

/** Input is a JSON-isolated captured schema; the caller must independently establish source identity/pins.
 * A HOLD may retain safe speculative additions in the LOCAL copy, but it grants no executable authority.
 */
export function draftHistoricalSchemaAdditions(input: unknown, required: HistoricalSchemaRequirements): HistoricalSchemaDraft {
  const additions: { property: string; type: string }[] = [], options: { property: string; option: string }[] = [];
  const holds: { code: string; property?: string; observed_type?: string; expected_type?: string }[] = [];
  const flags = { kind: "HISTORICAL_SCHEMA_ADDITIONS_DRAFT/1" as const, schema_admitted: false as const,
    execution_authorized: false as const, writer_authorized: false as const };
  let projected: ObjectValue | undefined, sourceSha: string | null = null;
  try { projected = object(structuredClone(input)); if (projected) sourceSha = digest(projected); }
  catch { projected = undefined; /* Non-JSON captures cannot produce a draft. */ }
  const finish = (): HistoricalSchemaDraft => ({ ...flags, status: holds.length ? "HOLD_STRUCTURAL_GAPS" : "DRAFT_ADDITIONS_ONLY",
    source_schema_sha256: sourceSha, projected_schema_sha256: projected ? digest(projected) : null,
    projected_schema: projected ?? null, property_additions: additions, option_additions: options, holds });
  const properties = object(projected?.["properties"]);
  if (!projected || !properties) { projected = undefined; holds.push({ code: "MISSING_OR_INVALID_SCHEMA" }); return finish(); }
  if (Object.values(properties).filter(p => object(p)?.["type"] === "title").length !== 1) {
    holds.push({ code: "TITLE_MISSING_OR_AMBIGUOUS" }); return finish();
  }
  if (!object(required?.properties)) { holds.push({ code: "INVALID_REQUIREMENTS" }); return finish(); }
  for (const [name, type] of Object.entries(required.properties)) {
    if (!name.length || typeof type !== "string" || !type.length) { holds.push({ code: "INVALID_REQUIREMENT", property: name }); continue; }
    if (own(properties, name)) {
      const observed = object(properties[name])?.["type"];
      if (observed !== type) holds.push({ code: "PRESERVE_TYPE_CONFLICT", property: name,
        observed_type: typeof observed === "string" ? observed : "UNKNOWN", expected_type: type });
      continue;
    }
    if (!SCALAR_ADDITIONS.has(type)) { holds.push({ code: "UNSUPPORTED_ADDITION_NO_INFERENCE", property: name, expected_type: type }); continue; }
    set(properties, name, { type, [type]: ["select", "multi_select"].includes(type) ? { options: [] } : {} });
    additions.push({ property: name, type });
  }
  const optionRequirements = required.selectOptions;
  if (optionRequirements !== undefined && !object(optionRequirements)) { holds.push({ code: "INVALID_OPTIONS_DECLARATION" }); return finish(); }
  for (const [name, declared] of Object.entries(optionRequirements ?? {})) {
    if (!Array.isArray(declared) || declared.some(v => typeof v !== "string" || !v.length) || new Set(declared).size !== declared.length) {
      holds.push({ code: "INVALID_OPTIONS_DECLARATION", property: name }); continue;
    }
    const property = object(properties[name]), type = property?.["type"];
    // A declared target type conflicting with the original must never gain option semantics here.
    if (!property || required.properties[name] !== undefined && type !== required.properties[name]) {
      holds.push({ code: "OPTIONS_ON_MISSING_OR_CONFLICTING_PROPERTY", property: name }); continue;
    }
    if (type !== "select" && type !== "multi_select") { holds.push({ code: "UNSUPPORTED_OPTIONS_NO_GROUP_INFERENCE", property: name }); continue; }
    const config = object(property[type]), existing = config?.["options"];
    if (!config || !Array.isArray(existing) || existing.some(o => typeof object(o)?.["name"] !== "string" || !(object(o)?.["name"] as string).length)
      || new Set(existing.map(o => (o as ObjectValue)["name"])).size !== existing.length) {
      holds.push({ code: "INVALID_EXISTING_OPTIONS", property: name }); continue;
    }
    const names = new Set(existing.map(o => (o as ObjectValue)["name"]));
    for (const option of declared) if (!names.has(option)) { existing.push({ name: option }); names.add(option); options.push({ property: name, option }); }
  }
  return finish();
}
