/** Offline shape oracle over JSON-isolated historical properties. Not imported by served code.
 * Proves only literal-read feasibility; never a type conversion, schema admission or write permission.
 */
import { createHash } from "node:crypto";
import { propText, type PageProperty } from "../../src/notion/shapes.ts";

type ObjectValue = Record<string, unknown>;
type Target = "GATE_SELECT" | "RECEIPT_TEXT";
type Precision = "TEXT" | "DATE_ONLY" | "DATETIME_OFFSET" | "UNKNOWN";
type Membership = "NOT_APPLICABLE" | "NOT_DECLARED" | "MATCH" | "NO_MATCH" | "INVALID_DECLARATION";
export interface HistoricalLiteralQualification {
  readonly read_shape: "LOSSLESS_LITERAL_READ" | "UNKNOWN_EMPTY" | "HOLD_UNSUPPORTED_OR_LOSSY_SHAPE";
  readonly source_type: "rich_text" | "date" | "UNKNOWN";
  readonly source_property_sha256: string | null;
  readonly literal_sha256: string | null;
  readonly production_literal_sha256: string | null;
  readonly literal_precision: Precision;
  readonly enum_membership: Membership;
  readonly reasons: readonly string[];
  readonly timezone_inferred: false;
  readonly schema_admitted: false;
  readonly apply_allowed: false;
  readonly writer_authorized: false;
}
const object = (v: unknown): ObjectValue | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as ObjectValue : undefined;
const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
  : object(v) ? Object.fromEntries(Object.keys(v as ObjectValue).sort().map(k => [k, canonical((v as ObjectValue)[k])])) : v;
const hash = (v: string): string => createHash("sha256").update(v).digest("hex");
const only = (v: ObjectValue, keys: readonly string[]): boolean => Object.keys(v).every(k => keys.includes(k));

/** Validate the written precision without Date.parse normalization, rounding or a guessed timezone. */
function datePrecision(value: string): "DATE_ONLY" | "DATETIME_OFFSET" | undefined {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-](\d{2}):(\d{2})))?$/);
  if (!m) return undefined;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > (days[month - 1] ?? 0)) return undefined;
  if (m[4] === undefined) return "DATE_ONLY";
  if (Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6]) > 59) return undefined;
  if (m[8] !== "Z" && (Number(m[9]) > 14 || Number(m[10]) > 59 || Number(m[9]) === 14 && Number(m[10]) !== 0)) return undefined;
  return "DATETIME_OFFSET";
}

export function qualifyHistoricalLiteral(input: unknown, target: Target, declaredOptions?: readonly string[]): HistoricalLiteralQualification {
  let copy: unknown, sourceDigest: string | null = null;
  try { copy = structuredClone(input); sourceDigest = hash(JSON.stringify(canonical(copy)) ?? "undefined"); }
  catch { /* Uncloneable/non-JSON data is not a historical property qualification. */ }
  const p = object(copy);
  const sourceType: HistoricalLiteralQualification["source_type"] = p?.["type"] === "rich_text" ? "rich_text"
    : p?.["type"] === "date" ? "date" : "UNKNOWN";
  const base = { source_type: sourceType, source_property_sha256: sourceDigest, literal_sha256: null,
    production_literal_sha256: null, literal_precision: "UNKNOWN" as Precision,
    enum_membership: target === "GATE_SELECT" ? "NOT_DECLARED" as Membership : "NOT_APPLICABLE" as Membership,
    timezone_inferred: false as const, schema_admitted: false as const, apply_allowed: false as const, writer_authorized: false as const };
  const hold = (reason: string): HistoricalLiteralQualification => ({ ...base, read_shape: "HOLD_UNSUPPORTED_OR_LOSSY_SHAPE", reasons: [reason] });
  const empty = (): HistoricalLiteralQualification => ({ ...base, read_shape: "UNKNOWN_EMPTY", reasons: ["NO_LITERAL_VALUE"] });
  if (!p || sourceDigest === null) return hold("UNSUPPORTED_INPUT");
  let literal: string, precision: Precision;
  if (target === "GATE_SELECT") {
    if (p["type"] !== "rich_text" || !only(p, ["id", "type", "rich_text"]) || !Array.isArray(p["rich_text"])) return hold("UNSUPPORTED_GATE_PROPERTY");
    const runs = p["rich_text"];
    if (runs.length === 0) return empty();
    if (runs.length !== 1) return hold("MULTIPLE_RICH_TEXT_RUNS");
    const r = object(runs[0]), text = object(r?.["text"]), annotations = object(r?.["annotations"]);
    if (!r || r["type"] !== "text" || !only(r, ["type", "text", "annotations", "plain_text", "href"])
      || !text || !only(text, ["content", "link"]) || typeof text["content"] !== "string"
      || r["plain_text"] !== text["content"] || r["href"] != null || text["link"] != null) return hold("FORMATTED_LINKED_OR_DIVERGENT_TEXT");
    if (r["annotations"] !== undefined && (!annotations || !only(annotations, ["bold", "italic", "strikethrough", "underline", "code", "color"])
      || Object.entries(annotations).some(([k, v]) => k === "color" ? v !== "default" : v !== false))) return hold("ANNOTATION_INFORMATION_WOULD_BE_LOST");
    literal = text["content"];
    if (literal.length === 0) return empty();
    precision = "TEXT";
  } else if (target === "RECEIPT_TEXT") {
    if (p["type"] !== "date" || !only(p, ["id", "type", "date"])) return hold("UNSUPPORTED_STAMP_PROPERTY");
    if (p["date"] === null) return empty();
    const date = object(p["date"]);
    if (!date || !only(date, ["start", "end", "time_zone"]) || typeof date["start"] !== "string") return hold("UNSUPPORTED_DATE_METADATA");
    if (date["end"] != null || date["time_zone"] != null) return hold("RANGE_OR_TIMEZONE_INFORMATION_WOULD_BE_LOST");
    const parsedPrecision = datePrecision(date["start"]);
    if (!parsedPrecision) return hold("INVALID_OR_AMBIGUOUS_DATE_LITERAL");
    literal = date["start"]; precision = parsedPrecision;
  } else return hold("UNSUPPORTED_TARGET");
  // The actual production helper is the comparator, not a newly served conversion or coerced page.
  const observed = propText({ id: "0".repeat(32), properties: { observed: p as PageProperty } }, "observed");
  if (observed !== literal) return hold("PRODUCTION_LITERAL_DIFFERS");
  let membership = base.enum_membership;
  if (target === "GATE_SELECT" && declaredOptions !== undefined) {
    membership = !Array.isArray(declaredOptions) || declaredOptions.some(v => typeof v !== "string" || v.length === 0)
      || new Set(declaredOptions).size !== declaredOptions.length ? "INVALID_DECLARATION"
      : declaredOptions.includes(literal) ? "MATCH" : "NO_MATCH";
  }
  return { ...base, read_shape: "LOSSLESS_LITERAL_READ", literal_sha256: hash(literal), production_literal_sha256: hash(observed),
    literal_precision: precision, enum_membership: membership, reasons: ["SOURCE_TYPE_CONFLICT_NOT_ADMITTED",
      ...(membership === "NOT_DECLARED" ? ["CANDIDATE_ENUM_NOT_DECLARED"] : [])] };
}
