/**
 * The Sales Production Guard Index grammar, `SALES_GUARD_INDEX/1` (Sales 0.5.11 candidate, W3.1R/W3.1S — NOT ADOPTED).
 *
 * Parsing is exact: every object has exactly the keys the grammar names, every enumeration is closed, and anything
 * else makes the whole index invalid (UNVERIFIABLE), never partially read. A predicate node carries its operator in
 * `op`; operands are `{"ref":{…}}` or `{"literal":{…}}`. The index never translates prose: the rules' coverage is
 * attested by the operator at approval time. Reasons name structure only, never a value.
 */
import type { RereadStatus } from "../contractPack/dailySources.ts";

export const VALUE_TYPES = ["TEXT", "NUMBER", "BOOLEAN", "DATE"] as const;
export type ValueType = (typeof VALUE_TYPES)[number];
export const REREAD_STATUSES: readonly RereadStatus[] = ["NO_POINTER", "MATCH", "DRIFT", "MISSING", "AMBIGUOUS", "UNREADABLE", "INVALID"];
export const OPERATION_CLASSES = ["PRODUCTION", "FUTURE_PROTECTION", "RECONCILE_AS_IS"] as const;
export type OperationClass = (typeof OPERATION_CLASSES)[number];
export const MAX_TERMS = 16;
export const MAX_DEPTH = 3;

export interface RefOperand {
  readonly resource_key: string;
  readonly natural_key: string;
  readonly property: string;
  readonly value_type: ValueType;
  readonly authority: string;
}
export type Literal = { readonly value_type: "TEXT"; readonly value: string } | { readonly value_type: "NUMBER"; readonly value: number } | { readonly value_type: "BOOLEAN"; readonly value: boolean } | { readonly value_type: "DATE"; readonly value: string };
export type Operand = { readonly ref: RefOperand } | { readonly literal: Literal };

export type Predicate =
  | { readonly op: "PRESENT"; readonly operand: Operand }
  | { readonly op: "EQUAL" | "NOT_EQUAL" | "NUMBER_LT" | "NUMBER_GTE"; readonly left: Operand; readonly right: Operand }
  | { readonly op: "POINTER_STATUS_IS"; readonly config_id: number; readonly status: RereadStatus }
  | { readonly op: "ALL" | "ANY"; readonly terms: readonly Predicate[] };

export interface P0Entry { readonly rule_id: number; readonly predicate: Predicate }

export interface OperationClassEntry {
  readonly class: OperationClass;
  readonly resource_key: string;
  readonly operation: "CREATE" | "UPDATE" | "UPSERT";
  readonly allowed_fields: readonly string[];
  readonly date_field?: string;
  readonly type_option_ids?: readonly string[];
}

export interface GuardIndex {
  readonly schema_version: string;
  readonly revision: number;
  readonly p0_rules: readonly P0Entry[];
  readonly operation_classes: readonly OperationClassEntry[];
}

export type ParsedIndex = { readonly ok: true; readonly index: GuardIndex } | { readonly ok: false; readonly reason: string };

class Invalid extends Error {}
const bad = (reason: string): never => { throw new Invalid(reason); };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function exactKeys(v: unknown, where: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!isObject(v)) return bad(`${where} is not an object`);
  for (const k of required) if (!(k in v)) bad(`${where} lacks ${k}`);
  for (const k of Object.keys(v)) if (!required.includes(k) && !optional.includes(k)) bad(`${where} has an unknown key`);
  return v;
}
const positiveInt = (v: unknown, where: string): number => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : bad(`${where} is not a positive integer`));
const nonEmpty = (v: unknown, where: string): string => (typeof v === "string" && v !== "" ? v : bad(`${where} is not a non-empty string`));
function oneOf<T extends string>(v: unknown, values: readonly T[], where: string): T {
  return typeof v === "string" && (values as readonly string[]).includes(v) ? (v as T) : bad(`${where} is outside its enumeration`);
}
const DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

function operand(v: unknown, where: string): Operand {
  if (!isObject(v) || Object.keys(v).length !== 1) return bad(`${where} is neither a ref nor a literal`);
  if ("ref" in v) {
    const r = exactKeys(v["ref"], `${where}.ref`, ["resource_key", "natural_key", "property", "value_type", "authority"]);
    return { ref: { resource_key: nonEmpty(r["resource_key"], `${where}.ref.resource_key`), natural_key: nonEmpty(r["natural_key"], `${where}.ref.natural_key`), property: nonEmpty(r["property"], `${where}.ref.property`), value_type: oneOf(r["value_type"], VALUE_TYPES, `${where}.ref.value_type`), authority: nonEmpty(r["authority"], `${where}.ref.authority`) } };
  }
  if ("literal" in v) {
    const l = exactKeys(v["literal"], `${where}.literal`, ["value_type", "value"]);
    const t = oneOf(l["value_type"], VALUE_TYPES, `${where}.literal.value_type`);
    const value = l["value"];
    switch (t) {
      case "TEXT": return typeof value === "string" ? { literal: { value_type: t, value } } : bad(`${where}.literal is not TEXT`);
      case "NUMBER": return typeof value === "number" && Number.isFinite(value) ? { literal: { value_type: t, value } } : bad(`${where}.literal is not NUMBER`);
      case "BOOLEAN": return typeof value === "boolean" ? { literal: { value_type: t, value } } : bad(`${where}.literal is not BOOLEAN`);
      case "DATE": return typeof value === "string" && DATE.test(value) ? { literal: { value_type: t, value } } : bad(`${where}.literal is not DATE`);
    }
  }
  return bad(`${where} is neither a ref nor a literal`);
}

function predicate(v: unknown, where: string, depth: number): Predicate {
  if (depth > MAX_DEPTH) return bad(`${where} is deeper than ${MAX_DEPTH}`);
  if (!isObject(v)) return bad(`${where} is not an object`);
  const op = v["op"];
  switch (op) {
    case "PRESENT": {
      const n = exactKeys(v, where, ["op", "operand"]);
      return { op, operand: operand(n["operand"], `${where}.operand`) };
    }
    case "EQUAL": case "NOT_EQUAL": case "NUMBER_LT": case "NUMBER_GTE": {
      const n = exactKeys(v, where, ["op", "left", "right"]);
      return { op, left: operand(n["left"], `${where}.left`), right: operand(n["right"], `${where}.right`) };
    }
    case "POINTER_STATUS_IS": {
      const n = exactKeys(v, where, ["op", "config_id", "status"]);
      return { op, config_id: positiveInt(n["config_id"], `${where}.config_id`), status: oneOf(n["status"], REREAD_STATUSES, `${where}.status`) };
    }
    case "ALL": case "ANY": {
      const n = exactKeys(v, where, ["op", "terms"]);
      const terms = n["terms"];
      if (!Array.isArray(terms) || terms.length === 0 || terms.length > MAX_TERMS) return bad(`${where}.terms must hold 1 to ${MAX_TERMS} terms`);
      return { op, terms: terms.map((t, i) => predicate(t, `${where}.terms[${i}]`, depth + 1)) };
    }
    default:
      return bad(`${where}.op is outside its enumeration`);
  }
}

function operationClass(v: unknown, where: string): OperationClassEntry {
  const e = exactKeys(v, where, ["class", "resource_key", "operation", "allowed_fields"], ["date_field", "type_option_ids"]);
  const cls = oneOf(e["class"], OPERATION_CLASSES, `${where}.class`);
  const fields = e["allowed_fields"];
  if (!Array.isArray(fields) || fields.length === 0) bad(`${where}.allowed_fields must be non-empty`);
  const allowed = (fields as unknown[]).map((f, i) => nonEmpty(f, `${where}.allowed_fields[${i}]`));
  if (new Set(allowed).size !== allowed.length) bad(`${where}.allowed_fields repeats a field`);
  const out: OperationClassEntry = {
    class: cls,
    resource_key: nonEmpty(e["resource_key"], `${where}.resource_key`),
    operation: oneOf(e["operation"], ["CREATE", "UPDATE", "UPSERT"] as const, `${where}.operation`),
    allowed_fields: allowed,
    ...("date_field" in e ? { date_field: nonEmpty(e["date_field"], `${where}.date_field`) } : {}),
  };
  if ("type_option_ids" in e) {
    const ids = e["type_option_ids"];
    if (!Array.isArray(ids) || ids.length === 0) bad(`${where}.type_option_ids must be non-empty when present`);
    const list = (ids as unknown[]).map((x, i) => nonEmpty(x, `${where}.type_option_ids[${i}]`));
    if (new Set(list).size !== list.length) bad(`${where}.type_option_ids repeats an id`);
    Object.assign(out, { type_option_ids: list });
  }
  if (cls === "FUTURE_PROTECTION" && out.date_field === undefined) bad(`${where} is FUTURE_PROTECTION without date_field`);
  return out;
}

/** Parses the one JSON object of the index page. Any deviation from the grammar is a reason, never a partial index. */
export function parseGuardIndex(raw: unknown, schemaVersion: string): ParsedIndex {
  try {
    const top = exactKeys(raw, "index", ["schema_version", "revision", "p0_rules", "operation_classes"]);
    if (top["schema_version"] !== schemaVersion) bad("index.schema_version is not the grammar this contract line reads");
    const revision = positiveInt(top["revision"], "index.revision");
    if (!Array.isArray(top["p0_rules"])) bad("index.p0_rules is not an array");
    if (!Array.isArray(top["operation_classes"])) bad("index.operation_classes is not an array");
    const p0 = (top["p0_rules"] as unknown[]).map((r, i) => {
      const e = exactKeys(r, `p0_rules[${i}]`, ["rule_id", "predicate"]);
      return { rule_id: positiveInt(e["rule_id"], `p0_rules[${i}].rule_id`), predicate: predicate(e["predicate"], `p0_rules[${i}].predicate`, 1) };
    });
    if (new Set(p0.map((r) => r.rule_id)).size !== p0.length) bad("p0_rules names one rule twice");
    const classes = (top["operation_classes"] as unknown[]).map((c, i) => operationClass(c, `operation_classes[${i}]`));
    return { ok: true, index: { schema_version: schemaVersion, revision, p0_rules: p0, operation_classes: classes } };
  } catch (err) {
    if (err instanceof Invalid) return { ok: false, reason: err.message };
    throw err;
  }
}

/** Every `ref` operand of an index, in syntactic order. */
export function refsOf(index: GuardIndex): RefOperand[] {
  const out: RefOperand[] = [];
  const walkOperand = (o: Operand) => { if ("ref" in o) out.push(o.ref); };
  const walk = (p: Predicate): void => {
    switch (p.op) {
      case "PRESENT": walkOperand(p.operand); return;
      case "EQUAL": case "NOT_EQUAL": case "NUMBER_LT": case "NUMBER_GTE": walkOperand(p.left); walkOperand(p.right); return;
      case "POINTER_STATUS_IS": return;
      case "ALL": case "ANY": p.terms.forEach(walk); return;
    }
  };
  for (const r of index.p0_rules) walk(r.predicate);
  return out;
}
