/**
 * Property encoding (PV-WRITE-001 / W1.3).
 *
 * `encodeProperty` turns one plan field — a string, number, boolean, null, list, `page:<id>` reference,
 * `$created:<symbol>` reference or `$now` — into the exact REST value Notion accepts on create/update.
 * `materializeProperty` turns that REST value into the page property Notion returns on read. The fixture writer
 * is `materialize ∘ encode`, so the tests exercise the very bytes the executor will send.
 *
 * Nothing is coerced silently: a value that does not fit its property type is refused, a governed enumeration
 * refuses a value outside its options (D11), and `files` is never written.
 */
import type { PageProperty, RichText } from "./shapes.ts";

/** Notion's limits on one rich-text array: 2000 characters per text object, 100 objects per array. */
export const RICH_TEXT_CHUNK = 2000;
export const RICH_TEXT_MAX_ITEMS = 100;

export type PropertyRefusal = "HOLD_SCHEMA_VALUE_UNSUPPORTED" | "HOLD_SCHEMA_MISMATCH" | "HOLD_UNSUPPORTED_OPERATION";
export type Encoded = { readonly ok: true; readonly value: Readonly<Record<string, unknown>> } | { readonly ok: false; readonly code: PropertyRefusal; readonly evidence: string };

export interface EncodeContext {
  /** Resolves `$created:<symbol>` to the id of the page created earlier in the same plan; undefined ⇒ refused. */
  readonly resolveCreated?: (symbol: string) => string | undefined;
  /** Wall-clock ISO timestamp substituted for `$now`. */
  readonly now?: string;
  /**
   * Options of a select / status / multi_select property, as read from the live schema. A value outside them is
   * refused unless the contract declares the list extensible. Absent options cannot prove a value: refused too.
   */
  readonly options?: readonly string[];
  /** True only when the contract declares this enumeration extensible (D11: by default, none is). */
  readonly extensible?: boolean;
}

const refuse = (code: PropertyRefusal, evidence: string): Encoded => ({ ok: false, code, evidence });
const ok = (value: Record<string, unknown>): Encoded => ({ ok: true, value });

type Ref = { readonly ok: true; readonly id: string } | { readonly ok: false; readonly evidence: string } | undefined;

/** A `page:<id>` or `$created:<symbol>` reference, resolved; undefined when the value is not a reference. */
function refOf(value: unknown, ctx: EncodeContext): Ref {
  if (typeof value !== "string") return undefined;
  if (value.startsWith("page:")) return { ok: true, id: value.slice("page:".length) };
  if (value.startsWith("$created:")) {
    const symbol = value.slice("$created:".length);
    const id = ctx.resolveCreated?.(symbol);
    return id ? { ok: true, id } : { ok: false, evidence: `reference to ${symbol}, which has not been created` };
  }
  return undefined;
}

function scalar(value: unknown, ctx: EncodeContext): unknown {
  return value === "$now" ? (ctx.now ?? value) : value;
}

/** Plain text split into ≤2000-character text objects, or a single page mention. */
function richText(value: unknown, ctx: EncodeContext): { ok: true; items: Record<string, unknown>[] } | { ok: false; code: PropertyRefusal; evidence: string } {
  const ref = refOf(value, ctx);
  if (ref && !ref.ok) return { ok: false, code: "HOLD_SCHEMA_MISMATCH", evidence: ref.evidence };
  if (ref) return { ok: true, items: [{ type: "mention", mention: { type: "page", page: { id: ref.id } } }] };
  const v = scalar(value, ctx);
  if (v !== null && v !== undefined && typeof v === "object") return { ok: false, code: "HOLD_SCHEMA_MISMATCH", evidence: "text property given a structured value" };
  const s = v === null || v === undefined ? "" : String(v);
  const chunks: string[] = [];
  for (let i = 0; i < s.length;) {
    let end = Math.min(i + RICH_TEXT_CHUNK, s.length);
    if (end < s.length && /[\uD800-\uDBFF]/.test(s[end - 1] as string) && /[\uDC00-\uDFFF]/.test(s[end] as string)) end--;
    chunks.push(s.slice(i, end)); i = end;
  }
  if (chunks.length > RICH_TEXT_MAX_ITEMS) return { ok: false, code: "HOLD_SCHEMA_MISMATCH", evidence: `text of ${s.length} characters exceeds ${RICH_TEXT_CHUNK * RICH_TEXT_MAX_ITEMS}` };
  return { ok: true, items: (chunks.length ? chunks : [""]).map((content) => ({ type: "text", text: { content } })) };
}

function enumValue(type: string, name: string, ctx: EncodeContext): Encoded | undefined {
  if (name.trim() === "") return refuse("HOLD_SCHEMA_MISMATCH", `${type} given an empty option`);
  if (ctx.extensible) return undefined;
  if (!ctx.options) return refuse("HOLD_SCHEMA_VALUE_UNSUPPORTED", `${type} options unreadable; "${name}" cannot be proven valid`);
  if (!ctx.options.includes(name)) return refuse("HOLD_SCHEMA_VALUE_UNSUPPORTED", `"${name}" is not an option of this ${type} (${ctx.options.length} options), and the list is not extensible`);
  return undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
}

/** One plan field → the REST value for a property of this type. */
export function encodeProperty(type: string, value: unknown, ctx: EncodeContext = {}): Encoded {
  switch (type) {
    case "title":
    case "rich_text": {
      const r = richText(value, ctx);
      return r.ok ? ok({ [type]: r.items }) : refuse(r.code, r.evidence);
    }
    case "select":
    case "status": {
      const v = scalar(value, ctx);
      if (v === null) return ok({ [type]: null });
      if (typeof v !== "string" && typeof v !== "number") return refuse("HOLD_SCHEMA_MISMATCH", `${type} given a non-scalar value`);
      const name = String(v);
      return enumValue(type, name, ctx) ?? ok({ [type]: { name } });
    }
    case "multi_select": {
      const names = list(scalar(value, ctx));
      if (names.some((n) => typeof n !== "string" && typeof n !== "number")) return refuse("HOLD_SCHEMA_MISMATCH", "multi_select given a non-scalar option");
      for (const n of names) { const bad = enumValue(type, String(n), ctx); if (bad) return bad; }
      return ok({ multi_select: [...new Set(names.map(String))].map((name) => ({ name })) });
    }
    case "number": {
      const v = scalar(value, ctx);
      if (v === null) return ok({ number: null });
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
      return Number.isFinite(n) ? ok({ number: n }) : refuse("HOLD_SCHEMA_MISMATCH", "number given a non-numeric value");
    }
    case "checkbox": {
      // Strict: the string "false" is false. The retired native renderer coerced any non-empty string to true.
      const v = scalar(value, ctx);
      if (v === true || v === "true" || v === "__YES__") return ok({ checkbox: true });
      if (v === false || v === "false" || v === "__NO__" || v === null) return ok({ checkbox: false });
      return refuse("HOLD_SCHEMA_MISMATCH", "checkbox accepts only true or false");
    }
    case "date": {
      const v = scalar(value, ctx);
      if (v === null) return ok({ date: null });
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/.test(v) || Number.isNaN(Date.parse(v))) return refuse("HOLD_SCHEMA_MISMATCH", "date given a value that is not an ISO 8601 date");
      return ok({ date: { start: v } });
    }
    case "url":
    case "email":
    case "phone_number": {
      const v = scalar(value, ctx);
      if (v === null || v === "") return ok({ [type]: null });
      if (typeof v !== "string") return refuse("HOLD_SCHEMA_MISMATCH", `${type} given a non-string value`);
      return ok({ [type]: v });
    }
    case "relation": {
      const ids: string[] = [];
      for (const item of list(value)) {
        const ref = refOf(item, ctx);
        if (ref && !ref.ok) return refuse("HOLD_SCHEMA_MISMATCH", ref.evidence);
        const id = ref ? ref.id : typeof item === "string" ? item : undefined;
        if (!id) return refuse("HOLD_SCHEMA_MISMATCH", "relation given a value that is not a page reference");
        ids.push(id);
      }
      return ok({ relation: [...new Set(ids)].map((id) => ({ id })) });
    }
    case "people": {
      const ids = list(value);
      if (ids.some((id) => typeof id !== "string" || id === "")) return refuse("HOLD_SCHEMA_MISMATCH", "people given a value that is not a user id");
      return ok({ people: [...new Set(ids as string[])].map((id) => ({ object: "user", id })) });
    }
    case "files": return refuse("HOLD_UNSUPPORTED_OPERATION", "files properties are never written by the harness");
    default: return refuse("HOLD_UNSUPPORTED_OPERATION", `property type ${type} is not writable`);
  }
}

function readRichText(items: unknown): RichText[] {
  return (Array.isArray(items) ? items : []).map((raw) => {
    const item = raw as { type?: string; text?: { content?: string }; mention?: { page?: { id?: string } } };
    if (item.type === "mention") return { type: "mention", plain_text: "Untitled", mention: { type: "page", page: { id: String(item.mention?.page?.id ?? "") } } };
    return { type: "text", plain_text: String(item.text?.content ?? ""), annotations: { code: false } };
  });
}

/** The REST value written for a property → the page property Notion returns when that page is read back. */
export function materializeProperty(type: string, encoded: Readonly<Record<string, unknown>>): PageProperty {
  const v = encoded[type];
  switch (type) {
    case "title": return { type: "title", title: readRichText(v) };
    case "rich_text": return { type: "rich_text", rich_text: readRichText(v) };
    case "select": return { type: "select", select: v === null ? null : { name: String((v as { name: string }).name) } };
    case "status": return { type: "status", status: v === null ? null : { name: String((v as { name: string }).name) } } as unknown as PageProperty;
    case "multi_select": return { type: "multi_select", multi_select: (v as { name: string }[]).map((o) => ({ name: o.name })) } as unknown as PageProperty;
    case "number": return { type: "number", number: v as number | null };
    case "checkbox": return { type: "checkbox", checkbox: v === true };
    case "date": return { type: "date", date: v === null ? null : { start: String((v as { start: string }).start) } };
    case "url": return { type: "url", url: v as string | null };
    case "email": return { type: "email", email: v as string | null };
    case "phone_number": return { type: "phone_number", phone_number: v as string | null };
    case "relation": return { type: "relation", relation: (v as { id: string }[]).map((r) => ({ id: r.id })) } as unknown as PageProperty;
    case "people": return { type: "people", people: (v as { id: string }[]).map((p) => ({ object: "user", id: p.id })) } as unknown as PageProperty;
    default: throw new Error(`materializeProperty: ${type} is not a writable property type`);
  }
}
