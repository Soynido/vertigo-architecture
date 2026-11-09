/**
 * Fixture evidence injector: applies stored instructions in memory, with sabotage knobs (skip, wrong value,
 * wrong field, wrong record, duplicate CREATE). Test-only, never native MCP actions. Strict finalization uses
 * the same backend resolver; production writes belong exclusively to the transactional writer.
 */
import { encodeProperty, materializeProperty } from "../../src/notion/properties.ts";
import { resolveInstruction } from "../../src/transactions/write.ts";
import type { Page, PageProperty } from "../../src/notion/shapes.ts";
import type { WriteInstruction } from "../../src/plans/store.ts";
import type { World } from "./binding-fixtures.ts";
import { synthetic } from "./meta-fixtures.ts";
import { setRowsIn } from "./resume-fixtures.ts";

export interface WriterOptions {
  /** Stored TARGET symbols/receipt for the strict backend resolver, never native action rendering. */
  created?: Readonly<Record<string, string>>;
  target_receipt_id?: string;
  /** Symbols to skip entirely (dependent steps referencing them are skipped too). */
  skip?: string[];
  /** Replace (not merge) the fields written by a step. */
  replaceFields?: Record<string, Record<string, unknown>>;
  /** Apply a step to another page id (wrong record). */
  redirect?: Record<string, string>;
  /** Create the row of these CREATE steps twice (duplicate). */
  duplicate?: string[];
  now?: string;
  /** Id salt so two executions of the same plan create different pages. */
  salt?: string;
}

/**
 * The fixture writes exactly what the executor will send: `materialize ∘ encode` (W1.3). Like the native Notion
 * app it stands in for, it creates select options freely (extensible), and a field whose type the schema could
 * not give is written as rich_text. A value Notion would refuse makes the fixture write fail loudly.
 */
const FIXTURE_TYPES: ReadonlySet<string> = new Set(["title", "rich_text", "select", "status", "multi_select", "number", "checkbox", "date", "url", "email", "phone_number", "relation", "people"]);
function prop(type: string | undefined, value: unknown, created: Record<string, string>, now: string): PageProperty {
  const t = type !== undefined && FIXTURE_TYPES.has(type) ? type : "rich_text";
  // A sabotaged plan (a skipped CREATE) leaves its dependents pointing at nothing: the fixture writes that dangling
  // reference, as a careless writer would, so the proof is what refuses it.
  const encoded = encodeProperty(t, value, { resolveCreated: (symbol) => created[symbol] ?? `$created:${symbol}`, now, extensible: true });
  if (!encoded.ok) throw new Error(`fixture writer: ${encoded.code} — ${encoded.evidence}`);
  return materializeProperty(t, encoded.value);
}

export function rowsOf(w: Pick<World, "map">, ds: string): Page[] {
  return ((w.map.get(`query:${ds}`) as { results?: Page[] } | undefined)?.results ?? []);
}

/** Direct fixture mutation of an existing page (simulates any actor, e.g. a concurrent human edit). */
export function mutatePage(w: Pick<World, "map">, pageId: string, fields: Record<string, unknown>, now = "2030-01-01T01:00:00.000Z"): void {
  const page = w.map.get(`page:${pageId}`) as Page | undefined;
  if (!page) throw new Error(`fixture page ${pageId} missing`);
  const properties: Record<string, PageProperty> = { ...page.properties };
  // A human edit arrives either as a plan-style value or as a page property already in read form.
  const isReadForm = (v: unknown): v is PageProperty => typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as { type?: unknown }).type === "string";
  for (const [k, v] of Object.entries(fields)) properties[k] = isReadForm(v) ? v : prop(page.properties[k]?.type, v, {}, now);
  const updated: Page = { ...page, last_edited_time: now, properties };
  w.map.set(`page:${pageId}`, updated);
  const ds = page.parent?.data_source_id;
  if (ds) setRowsIn(w.map, ds, rowsOf(w, ds).map((r) => (r.id === pageId ? updated : r)));
}

/** Executes write instructions against the fixture. Returns the symbol → created page id map. */
export function executeWrites(w: Pick<World, "map">, writes: readonly WriteInstruction[], planId: string, opts: WriterOptions = {}): Record<string, string> {
  const now = opts.now ?? "2030-01-01T00:30:00.000Z";
  const created: Record<string, string> = { ...(opts.created ?? {}) };
  for (const stored of [...writes].sort((a, b) => a.ordinal - b.ordinal)) {
    // Fault injection without a TARGET context remains capable of producing malformed evidence.
    // Finalization uses the same strict resolver as the server; no duplicated substitution algorithm.
    let wi = stored;
    if (opts.created !== undefined || opts.target_receipt_id !== undefined) {
      const resolved = resolveInstruction(stored, { created, ...(opts.target_receipt_id !== undefined ? { target_receipt_id: opts.target_receipt_id } : {}), now: new Date(now) });
      if (!resolved.ok) throw new Error(`fixture resolver: ${resolved.code} — ${resolved.evidence.join("; ")}`);
      wi = { ...stored, target_ref: resolved.instruction.target_id, fields: resolved.instruction.fields };
    }
    if (opts.skip?.includes(wi.symbol)) continue;
    let target = wi.target_ref;
    if (target.startsWith("$created:")) { const id = created[target.slice("$created:".length)]; if (!id) continue; target = id; }
    if (opts.redirect?.[wi.symbol]) target = opts.redirect[wi.symbol] as string;
    const fields = opts.replaceFields?.[wi.symbol] ?? wi.fields;
    const types = wi.property_types ?? {};
    if (wi.operation === "CREATE") {
      const copies = opts.duplicate?.includes(wi.symbol) ? 2 : 1;
      for (let c = 0; c < copies; c += 1) {
        const id = synthetic(`created-${wi.symbol}-${planId}-${opts.salt ?? ""}-${c}`);
        const properties: Record<string, PageProperty> = {};
        for (const [k, v] of Object.entries(fields)) properties[k] = prop(types[k], v, created, now);
        const page: Page = { object: "page", id, archived: false, last_edited_time: now, parent: { type: "data_source_id", data_source_id: target }, properties };
        w.map.set(`page:${id}`, page);
        setRowsIn(w.map, target, [...rowsOf(w, target), page]);
        if (c === 0) {
          created[wi.symbol] = id;
          // Compatibility alias for durability fixtures written against the former internal symbol.
          if (wi.symbol === "INSTALL_VERIFICATION") created["INSTALL_CANARY"] = id;
        }
      }
    } else {
      const page = w.map.get(`page:${target}`) as Page | undefined;
      if (!page) throw new Error(`fixture page ${target} missing for ${wi.symbol}`);
      const properties: Record<string, PageProperty> = { ...page.properties };
      for (const [k, v] of Object.entries(fields)) properties[k] = prop(types[k] ?? page.properties[k]?.type, v, created, now);
      const updated: Page = { ...page, last_edited_time: now, properties };
      w.map.set(`page:${target}`, updated);
      const ds = page.parent?.data_source_id;
      if (ds) setRowsIn(w.map, ds, rowsOf(w, ds).map((r) => (r.id === target ? updated : r)));
    }
  }
  return created;
}
