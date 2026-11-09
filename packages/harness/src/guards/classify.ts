/**
 * Classification of the REAL mutations of one new server write (Sales 0.5.11 candidate, W3.1R/W3.1S).
 *
 * A mutation belongs to exactly one approved `operation_classes` entry, decided from its resource, operation,
 * written fields, its date and — when the entry restricts it — the physical option id of its Type. Nothing the
 * caller says counts: `action_class`, `summary`, a Type name, a verdict typed in a field create no right.
 *  - FUTURE_PROTECTION is proven only with the instance's confirmed IANA zone: a CREATE dated D+1 or D+2, or an UPDATE
 *    whose date stays in D+1/D+2 before AND after. D0↔D+1 is not a protection. Never on an effect-bearing resource.
 *  - RECONCILE_AS_IS is an UPDATE that writes nothing divergent: every written field already holds that value.
 *    Sales 0.5.13/0.5.8 alone adds immutable, factory-proven native-event CREATEs (W4.3) and capability proof (W4.7R3).
 *  - A `date_field` on another class has no published meaning, so such an entry never matches (fail closed).
 * Zero or several matching entries: the mutation cannot be classified and is UNVERIFIABLE. LEDGER_RECOVERY is never
 * decided here: the backend decides it from its own journal.
 */
import type { NotionReadClient } from "../notion/readClient.ts";
import { isExternalEventMutation } from "../effects/eventWrite.ts";
import { isBackendOwnedCapabilityMutation } from "../resume/capabilityRemediation.ts";
import { isBackendOwnedSourceEnrollmentMutation } from "../resume/sourceEnrollment.ts";
import { normalizeId, plainText, propText, type Page, type RichText } from "../notion/shapes.ts";
import { discoverDataSource, resolveTarget } from "../plans/resources.ts";
import type { IntentMutation } from "../plans/prepare.ts";
import type { ResolvedRuntime } from "../resolvers/types.ts";
import type { HoldCode } from "../errors/codes.ts";
import type { OperationClass, OperationClassEntry } from "./index.ts";
import { civilDay, type GuardSnapshot } from "./snapshot.ts";

/** The property whose physical option id a `type_option_ids` restriction reads. */
export const TYPE_PROPERTY = "Type";

export type Classified =
  | { readonly kind: "CLASS"; readonly cls: OperationClass }
  | { readonly kind: "UNCLASSIFIED"; readonly matches: number }
  | { readonly kind: "GUARD_SOURCE" }
  | { readonly kind: "TARGET_HOLD"; readonly code: HoldCode; readonly evidence: readonly string[] };

type Cell = { type: string; [k: string]: unknown };

const BARE_DAY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function dayOf(raw: unknown, zone: string): string | undefined {
  if (typeof raw !== "string") return undefined;
  if (BARE_DAY.test(raw)) return raw;
  if (INSTANT.test(raw)) return civilDay(Date.parse(raw), zone);
  return undefined;
}
function currentDate(page: Page, field: string): string | undefined {
  const v = page.properties[field] as Cell | undefined;
  if (!v || v.type !== "date") return undefined;
  const d = v["date"] as { start?: string; end?: string | null } | null | undefined;
  return d?.start && !d.end ? d.start : undefined;
}

/** Whether `desired` is exactly what the row already holds. Anything not provably equal is divergent. */
function holdsAlready(page: Page, field: string, desired: unknown): boolean {
  const v = page.properties[field] as Cell | undefined;
  if (!v) return false;
  switch (v.type) {
    case "title": case "rich_text": return typeof desired === "string" && plainText(v[v.type] as readonly RichText[] | undefined) === desired;
    case "select": case "status": {
      const name = (v[v.type] as { name?: string } | null | undefined)?.name;
      return desired === null ? name === undefined : typeof desired === "string" && name === desired;
    }
    case "url": case "email": case "phone_number": return desired === null ? v[v.type] == null : typeof desired === "string" && v[v.type] === desired;
    case "checkbox": return typeof desired === "boolean" && v["checkbox"] === desired;
    case "number": return (typeof desired === "number" || desired === null) && v["number"] === desired;
    case "date": return typeof desired === "string" && currentDate(page, field) === desired;
    default: return false;
  }
}

/** The physical option id of the row's Type, or of a Type name in this data source; `undefined` when not exactly one. */
async function optionIdOf(client: NotionReadClient, ds: string, name: unknown, cellId?: unknown): Promise<string | undefined> {
  if (typeof cellId === "string" && cellId !== "") return cellId;
  if (typeof name !== "string") return undefined;
  const schema = (await client.retrieveDataSource(ds)) as { properties?: Record<string, { type?: string; [k: string]: unknown }> } | undefined;
  const p = schema?.properties?.[TYPE_PROPERTY];
  const options = p && (p.type === "select" || p.type === "status") ? ((p[p.type] as { options?: ReadonlyArray<{ id?: string; name?: string }> } | undefined)?.options ?? []) : [];
  const hits = options.filter((o) => o.name === name && typeof o.id === "string" && o.id !== "");
  return hits.length === 1 ? (hits[0]!.id as string) : undefined;
}

/** What a CREATE writes into (a data source), or the one row an UPDATE changes. */
type Target = { readonly kind: "NEW"; readonly ds: string } | { readonly kind: "EXISTING"; readonly ds: string; readonly page: Page };

interface Facts {
  readonly m: IntentMutation;
  readonly target: Target;
  readonly effective: "CREATE" | "UPDATE";
  readonly external: boolean;
  readonly nativeEvent: boolean;
  readonly capabilityProof: boolean;
  readonly sourceEnrollment: boolean;
}

async function typeAllowed(client: NotionReadClient, f: Facts, allowed: readonly string[]): Promise<boolean> {
  const ds = f.target.ds;
  const desired = f.m.desired_changes[TYPE_PROPERTY];
  if (f.effective === "CREATE") {
    const id = await optionIdOf(client, ds, desired);
    return id !== undefined && allowed.includes(id);
  }
  const page = (f.target as Extract<Target, { kind: "EXISTING" }>).page;
  const cell = page.properties[TYPE_PROPERTY] as Cell | undefined;
  const sel = cell && (cell.type === "select" || cell.type === "status") ? (cell[cell.type] as { id?: string; name?: string } | null | undefined) : undefined;
  const oldId = sel ? await optionIdOf(client, ds, sel.name, sel.id) : undefined;
  const newId = TYPE_PROPERTY in f.m.desired_changes ? await optionIdOf(client, ds, desired) : oldId;
  return oldId !== undefined && newId !== undefined && allowed.includes(oldId) && allowed.includes(newId);
}

function protectionProven(f: Facts, entry: OperationClassEntry, s: GuardSnapshot): boolean {
  if (f.external || !s.zone || !entry.date_field) return false;
  const d0 = civilDay(s.t0.getTime(), s.zone);
  const window = new Set([addDays(d0, 1), addDays(d0, 2)]);
  const field = entry.date_field;
  const next = field in f.m.desired_changes ? dayOf(f.m.desired_changes[field], s.zone) : undefined;
  if (f.effective === "CREATE") return next !== undefined && window.has(next);
  const before = dayOf(currentDate((f.target as Extract<Target, { kind: "EXISTING" }>).page, field), s.zone);
  const after = field in f.m.desired_changes ? next : before;
  return before !== undefined && after !== undefined && window.has(before) && window.has(after);
}

async function matches(client: NotionReadClient, f: Facts, entry: OperationClassEntry, s: GuardSnapshot): Promise<boolean> {
  if (entry.resource_key !== f.m.logical_resource_key || entry.operation !== f.m.operation) return false;
  if ((f.nativeEvent || f.capabilityProof || f.sourceEnrollment) && (entry.class !== "RECONCILE_AS_IS" || entry.allowed_fields.length !== Object.keys(f.m.desired_changes).length)) return false;
  if (!Object.keys(f.m.desired_changes).every((k) => entry.allowed_fields.includes(k))) return false;
  if (entry.type_option_ids && !(await typeAllowed(client, f, entry.type_option_ids))) return false;
  switch (entry.class) {
    case "FUTURE_PROTECTION": return protectionProven(f, entry, s);
    case "RECONCILE_AS_IS": {
      if (entry.date_field !== undefined) return false;
      if (f.effective === "CREATE") return f.nativeEvent || f.capabilityProof;
      const page = (f.target as Extract<Target, { kind: "EXISTING" }>).page;
      if (f.sourceEnrollment) return Object.keys(f.m.desired_changes).every(k => !propText(page, k)?.trim());
      return Object.entries(f.m.desired_changes).every(([k, v]) => holdsAlready(page, k, v));
    }
    case "PRODUCTION": return entry.date_field === undefined;
  }
}

export async function classify(client: NotionReadClient, runtime: ResolvedRuntime, bindingMode: "BUSINESS" | "INSTALL_ONLY", m: IntentMutation, s: GuardSnapshot): Promise<Classified> {
  const spec = runtime.adapter.controlPlane.resources?.[m.logical_resource_key];
  const guardSpec = runtime.adapter.controlPlane.productionGuard;
  // The guard's own sources are never writable: not the rules, not the configuration, not a record a predicate reads.
  if (spec && guardSpec && [guardSpec.decisionRules.databaseTitle, guardSpec.runtimeConfiguration.databaseTitle].includes(spec.databaseTitle)) return { kind: "GUARD_SOURCE" };
  const key = m.record_selector.natural_key;
  if (key !== undefined && s.guarded.some((g) => g.resource_key === m.logical_resource_key && g.natural_key === key)) return { kind: "GUARD_SOURCE" };
  if (!spec) return { kind: "TARGET_HOLD", code: "HOLD_RESOURCE_UNKNOWN", evidence: [] };
  let target: Target;
  if (m.operation === "CREATE") {
    // A CREATE is classified by what it writes, never by what already exists: an exact replay of a persisted CREATE
    // is recognized by prepare, and a real duplicate is refused there, both before any write.
    const disc = await discoverDataSource(client, runtime, spec);
    if (!disc.ok) return { kind: "TARGET_HOLD", code: disc.code, evidence: disc.evidence };
    target = { kind: "NEW", ds: disc.ds };
  } else {
    const resolved = await resolveTarget(client, runtime, bindingMode, m.logical_resource_key, m.operation, m.record_selector);
    if (!resolved.ok) return { kind: "TARGET_HOLD", code: resolved.code, evidence: resolved.evidence };
    const r = resolved.target;
    if (r.kind === "EXISTING" && s.guarded_pages.has(normalizeId(r.page_ref) as string)) return { kind: "GUARD_SOURCE" };
    target = r.kind === "EXISTING" ? { kind: "EXISTING", ds: r.data_source.id, page: r.page } : { kind: "NEW", ds: r.data_source.id };
  }
  const facts: Facts = { m, target, effective: target.kind === "EXISTING" ? "UPDATE" : "CREATE", external: spec.externalEffect === true, nativeEvent: isExternalEventMutation(runtime, m), capabilityProof: isBackendOwnedCapabilityMutation(runtime, m), sourceEnrollment: isBackendOwnedSourceEnrollmentMutation(runtime, m) };
  const hits: OperationClass[] = [];
  for (const entry of s.index.operation_classes) if (await matches(client, facts, entry, s)) hits.push(entry.class);
  return hits.length === 1 ? { kind: "CLASS", cls: hits[0] as OperationClass } : { kind: "UNCLASSIFIED", matches: hits.length };
}
