/**
 * Logical resource → physical target resolution (PV0-010). The caller names a lane-namespaced logical
 * resource and a record selector; the backend discovers the physical database by exact title inside the SCOPE
 * the governing contract declares for that resource, validates the selector against the data source schema and
 * returns the unique target.
 *
 * Two scopes exist, and both are decided by the backend alone. `RUNTIME` is the bound runtime root. The V1 Sales
 * line adds `OBJECTIVE_PACKAGE`: the one authorized commercial objective package assigned to this principal, so
 * the seller's existing company truth is linked and reconciled rather than copied into a second one. A caller can
 * neither name nor widen a scope, and anything outside the resolved scope is refused.
 */
import { listAllChildren, type NotionReadClient } from "../notion/readClient.ts";
import { childPageTitle, normalizeId, plainText, propText, type Block, type Page, type RichText } from "../notion/shapes.ts";
import type { ResolvedRuntime } from "../resolvers/types.ts";
import type { ResourceSpec } from "../versions/adapters/controlPlane.ts";
import type { Operation } from "./store.ts";
import { WRITABLE_TYPES } from "./writes.ts";

export interface RecordSelector { readonly natural_key?: string | undefined; readonly logical_record_key?: string | undefined; readonly existing_object_id?: string | undefined }

export interface DataSourceSchema {
  readonly id: string;
  readonly properties: ReadonlyMap<string, string> /* name → type */;
  /** relation property name → the data source its rows must belong to, as declared by the live schema. */
  readonly relations: ReadonlyMap<string, string>;
  /** select / status / multi_select property name → its option names, as declared by the live schema (D11). */
  readonly options: ReadonlyMap<string, readonly string[]>;
  /** Native identities, not property names. Missing on historical fixtures/proofs means unknown. */
  readonly propertyIds?: ReadonlyMap<string, string>;
}

/** The part of a resolved runtime that decides WHERE a resource's physical database is discovered. */
export interface ResourceScope { readonly root_ref: string; readonly observations: Readonly<Record<string, unknown>> }

/** Backend-derived pointer to the principal's one authorized commercial objective package. Never caller input. */
export const OBJECTIVE_PACKAGE_REF = "objective_package_ref";

export type ResolvedTarget =
  | { readonly kind: "EXISTING"; readonly page: Page; readonly page_ref: string; readonly data_source: DataSourceSchema; readonly spec: ResourceSpec }
  | { readonly kind: "NEW"; readonly data_source: DataSourceSchema; readonly natural_key: string; readonly spec: ResourceSpec };

export type ResourceHoldCode = "HOLD_RESOURCE_UNKNOWN" | "HOLD_TARGET_NOT_FOUND" | "HOLD_TARGET_AMBIGUOUS" | "HOLD_CROSS_RUNTIME" | "HOLD_SCHEMA_MISMATCH" | "HOLD_UNSUPPORTED_OPERATION" | "HOLD_REQUIRED_RESOURCE_MISSING" | "HOLD_DUPLICATE";
export type ResourceOutcome = { readonly ok: true; readonly target: ResolvedTarget } | { readonly ok: false; readonly code: ResourceHoldCode; readonly evidence: readonly string[] };

function validNaturalKey(kind: ResourceSpec["naturalKeyKind"], value: string): boolean {
  if (value !== value.trim() || value.length === 0) return false;
  if (kind === "EMAIL") return value === value.toLowerCase() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if (kind === "HTTP_URL") {
    try {
      const url = new URL(value);
      return (url.protocol === "https:" || url.protocol === "http:") && url.username === "" && url.password === "" && url.href === value;
    } catch { return false; }
  }
  return true;
}

function titleOf(page: Page): string {
  for (const p of Object.values(page.properties)) if (p.type === "title") return plainText((p as { title: readonly RichText[] }).title);
  return "";
}

function pageDataSource(page: Page): string | undefined {
  return normalizeId(page.parent?.data_source_id) ?? normalizeId(page.parent?.database_id);
}

/** Reads the data-source schema (property name → type, each relation's declared target, each enumeration's options). Unreadable ⇒ undefined. */
export async function readSchema(client: NotionReadClient, dsId: string): Promise<DataSourceSchema | undefined> {
  try {
    type EnumConfig = { options?: ReadonlyArray<{ name?: string }> };
    const ds = (await client.retrieveDataSource(dsId)) as { properties?: Record<string, { id?: string; type?: string; relation?: { data_source_id?: string; database_id?: string }; select?: EnumConfig; status?: EnumConfig; multi_select?: EnumConfig }> };
    if (!ds.properties) return undefined;
    const entries = Object.entries(ds.properties);
    const relations = new Map<string, string>();
    for (const [name, v] of entries) {
      if (v.type !== "relation") continue;
      const target = normalizeId(v.relation?.data_source_id) ?? normalizeId(v.relation?.database_id);
      if (target) relations.set(name, target);
    }
    const options = new Map<string, readonly string[]>();
    for (const [name, v] of entries) {
      if (v.type !== "select" && v.type !== "status" && v.type !== "multi_select") continue;
      const declared = v[v.type]?.options;
      if (Array.isArray(declared)) options.set(name, declared.map((o) => o.name).filter((n): n is string => typeof n === "string"));
    }
    return { id: dsId, properties: new Map(entries.map(([k, v]) => [k, v.type ?? "unknown"])), relations, options,
      propertyIds: new Map(entries.filter(([, v]) => typeof v.id === "string" && v.id !== "").map(([k, v]) => [k, v.id as string])) };
  } catch {
    return undefined;
  }
}

/**
 * Root inside which the resource's physical database is discovered. RUNTIME-scoped resources stay inside the bound
 * runtime, exactly as before. An OBJECTIVE_PACKAGE-scoped resource resolves ONLY through this runtime's backend
 * objective pointer: a runtime without one addresses nothing, and no caller can supply or widen it.
 */
export function resourceRoot(runtime: ResourceScope, spec: ResourceSpec): { ok: true; root: string } | { ok: false; code: ResourceHoldCode; evidence: string[] } {
  if (spec.scope !== "OBJECTIVE_PACKAGE") return { ok: true, root: runtime.root_ref };
  const raw = runtime.observations[OBJECTIVE_PACKAGE_REF];
  const root = typeof raw === "string" ? normalizeId(raw) : undefined;
  if (!root) return { ok: false, code: "HOLD_REQUIRED_RESOURCE_MISSING", evidence: [`"${spec.databaseTitle}" lives in the authorized commercial objective package, and this runtime has no such package assigned`] };
  return { ok: true, root };
}

/** Discover the data source of a titled database under the resource's scope root (or under the spec's parent page). */
export async function discoverDataSource(client: NotionReadClient, runtime: ResourceScope, spec: ResourceSpec): Promise<{ ok: true; ds: string } | { ok: false; code: ResourceHoldCode; evidence: string[] }> {
  const scope = resourceRoot(runtime, spec);
  if (!scope.ok) return scope;
  const rootId = scope.root;
  let holder = rootId;
  if (spec.parentTitle) {
    const parents = (await listAllChildren(client, rootId)).filter((b) => (childPageTitle(b) ?? "").trim() === spec.parentTitle);
    if (parents.length !== 1) return { ok: false, code: "HOLD_REQUIRED_RESOURCE_MISSING", evidence: [`expected exactly one "${spec.parentTitle}" page under the runtime root, found ${parents.length}`] };
    holder = normalizeId((parents[0] as Block).id) as string;
  }
  const dbs = (await listAllChildren(client, holder)).filter((b) => b.type === "child_database" && ((b["child_database"] as { title?: string } | undefined)?.title ?? "").trim() === spec.databaseTitle);
  if (dbs.length !== 1) return { ok: false, code: dbs.length === 0 ? "HOLD_REQUIRED_RESOURCE_MISSING" : "HOLD_TARGET_AMBIGUOUS", evidence: [`expected exactly one "${spec.databaseTitle}" database inside the bound runtime, found ${dbs.length}`] };
  const db = (await client.retrieveDatabase(normalizeId((dbs[0] as Block).id) as string)) as { data_sources?: ReadonlyArray<{ id: string }> };
  const sources = db.data_sources ?? [];
  if (sources.length !== 1) return { ok: false, code: "HOLD_TARGET_AMBIGUOUS", evidence: [`"${spec.databaseTitle}" has ${sources.length} data sources`] };
  return { ok: true, ds: normalizeId((sources[0] as { id: string }).id) as string };
}

/**
 * Server-side equality filter a given property TYPE accepts. Notion rejects a condition whose kind does not
 * match the property (a rich_text condition on a url property is a validation error), and an unknown type gets
 * no filter at all. The filter is only an optimization: every caller re-checks the exact match client-side.
 */
export function naturalKeyFilter(type: string | undefined, property: string, value: string): unknown {
  switch (type) {
    case "title": return { property, title: { equals: value } };
    case "rich_text": return { property, rich_text: { equals: value } };
    case "select": return { property, select: { equals: value } };
    case "url": return { property, url: { equals: value } };
    case "email": return { property, email: { equals: value } };
    default: return undefined; // unique_id/number/etc.: query all and match client-side
  }
}

/**
 * Candidate scan for a resource whose key IS its identity. `equals` compares the stored value verbatim, so it
 * cannot see a row whose key differs only by surrounding whitespace — and a CREATE that trusted it would report
 * zero matches and write a rival row beside that unreconciled one. `contains` surfaces those candidates; the
 * exact decision is still made client-side, so the wider result set never widens what is accepted.
 */
export function naturalKeyScanFilter(type: string | undefined, property: string, value: string): unknown {
  switch (type) {
    case "title": return { property, title: { contains: value } };
    case "rich_text": return { property, rich_text: { contains: value } };
    case "url": return { property, url: { contains: value } };
    case "email": return { property, email: { contains: value } };
    default: return undefined; // select/number/etc.: no usable substring condition, so scan and match client-side
  }
}

/** The filter used to look a key up: a candidate scan for key-identified resources, plain equality otherwise. */
function keyLookupFilter(spec: ResourceSpec, type: string | undefined, property: string, value: string): unknown {
  return spec.naturalKeyIsIdentity === true ? naturalKeyScanFilter(type, property, value) : naturalKeyFilter(type, property, value);
}

export async function queryAll(client: NotionReadClient, dsId: string, filter: unknown): Promise<Page[]> {
  const out: Page[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 50; guard += 1) {
    const q = (await client.queryDataSource(dsId, filter, cursor)) as { results: readonly Page[]; has_more?: boolean; next_cursor?: string | null };
    out.push(...q.results.filter((p) => !p.archived && !p.in_trash));
    if (!q.has_more || !q.next_cursor) return out;
    cursor = q.next_cursor;
  }
  return out;
}

/**
 * Prove that the row the caller named is the ONE row carrying this key — the contract's "exactly one after
 * write/readback", bound to a specific record rather than to a count. Reading a page directly says nothing
 * about that: the live query may show no such row, or show a different one, and either way writing to the page
 * that was fetched would split one business identity across two records. A lookup that cannot run is a refusal
 * for the same reason it is on the key route: absence of evidence is never evidence of uniqueness.
 */
async function proveSoleKeyHolder(client: NotionReadClient, dsId: string, schema: DataSourceSchema, spec: ResourceSpec, key: string, targetRef: string): Promise<{ ok: true } | { ok: false; code: ResourceHoldCode; evidence: string[] }> {
  let rows: Page[];
  try {
    rows = await queryAll(client, dsId, keyLookupFilter(spec, schema.properties.get(spec.naturalKeyProperty), spec.naturalKeyProperty, key));
  } catch (err) {
    return { ok: false, code: "HOLD_TARGET_AMBIGUOUS", evidence: [`the ${spec.naturalKeyProperty} lookup on "${spec.databaseTitle}" is unavailable (${(err as Error).message}); uniqueness cannot be proven, so nothing is created or updated`] };
  }
  const same = rows.filter((p) => (propText(p, spec.naturalKeyProperty) ?? "").trim() === key);
  if (same.length > 1) return { ok: false, code: "HOLD_TARGET_AMBIGUOUS", evidence: [`${same.length} rows of "${spec.databaseTitle}" carry ${spec.naturalKeyProperty} = ${key}: ${same.map((r) => normalizeId(r.id)).join(", ")}; reconcile the duplicates before writing`] };
  if (same.length === 0) return { ok: false, code: "HOLD_TARGET_NOT_FOUND", evidence: [`${targetRef} reads correctly but no row of "${spec.databaseTitle}" is returned for ${spec.naturalKeyProperty} = ${key}; the row cannot be proven unique by its own key, so nothing is written`] };
  const holder = normalizeId((same[0] as Page).id);
  if (holder !== targetRef) return { ok: false, code: "HOLD_TARGET_AMBIGUOUS", evidence: [`${spec.naturalKeyProperty} = ${key} is carried by ${holder}, not by the named ${targetRef}; two rows of "${spec.databaseTitle}" claim one identity and must be reconciled before writing`] };
  return { ok: true };
}

/**
 * Resolve one mutation's target. Rules:
 *  - unknown logical key ⇒ HOLD_RESOURCE_UNKNOWN (control-plane records are never addressable);
 *  - operation not allowed for the resource ⇒ HOLD_UNSUPPORTED_OPERATION;
  *  - existing_object_id must be a live row of the discovered data source ⇒ else HOLD_CROSS_RUNTIME;
 *  - when the spec makes the natural key the row's sole identity, EVERY route additionally proves the same key
 *    facts: no title selector, a canonical stored key, no contradiction with a named natural_key, and exactly
 *    one row carrying that key (an unprovable or duplicated key is a HOLD, never a guess);
 *  - natural_key / logical_record_key must match exactly one row for UPDATE (0 ⇒ NOT_FOUND, >1 ⇒ AMBIGUOUS);
 *  - CREATE requires a natural key that matches no row (else HOLD_DUPLICATE); UPSERT picks EXISTING or NEW.
 */
export async function resolveTarget(client: NotionReadClient, runtime: ResolvedRuntime, bindingMode: "BUSINESS" | "INSTALL_ONLY", logicalKey: string, operation: Operation, selector: RecordSelector): Promise<ResourceOutcome> {
  const spec = runtime.adapter.controlPlane.resources?.[logicalKey];
  if (!spec) return { ok: false, code: "HOLD_RESOURCE_UNKNOWN", evidence: [`logical resource ${logicalKey} is not addressable under ${runtime.adapter.version}`, `known: ${Object.keys(runtime.adapter.controlPlane.resources ?? {}).join(", ") || "NONE"}`] };
  const installOnly = bindingMode === "INSTALL_ONLY";
  if (spec.bootstrapOnly === true && !installOnly) return { ok: false, code: "HOLD_UNSUPPORTED_OPERATION", evidence: [`${logicalKey} is available only while installing a registry-assigned UNBOUND clone`] };
  if (installOnly && spec.bootstrapOnly !== true) return { ok: false, code: "HOLD_UNSUPPORTED_OPERATION", evidence: [`INSTALL-only binding cannot address business resource ${logicalKey}`] };
  if (!spec.operations.includes(operation)) return { ok: false, code: "HOLD_UNSUPPORTED_OPERATION", evidence: [`${operation} is not permitted on ${logicalKey}; permitted: ${spec.operations.join(", ")}`] };
  let disc: Awaited<ReturnType<typeof discoverDataSource>>;
  try {
    disc = await discoverDataSource(client, runtime, spec);
  } catch (err) {
    // An unreadable scope (typically an objective package not shared with the harness identity) must never look
    // like "resource absent" or crash the tool: it is a missing prerequisite the seller's admin has to grant.
    return { ok: false, code: "HOLD_REQUIRED_RESOURCE_MISSING", evidence: [`"${spec.databaseTitle}" could not be read where it is declared to live: ${(err as Error).message}`] };
  }
  if (!disc.ok) return { ok: false, code: disc.code, evidence: disc.evidence };
  const schema = await readSchema(client, disc.ds);
  if (!schema) return { ok: false, code: "HOLD_SCHEMA_MISMATCH", evidence: [`schema of "${spec.databaseTitle}" is unreadable; fields cannot be validated`] };
  if (!schema.properties.has(spec.naturalKeyProperty)) return { ok: false, code: "HOLD_SCHEMA_MISMATCH", evidence: [`"${spec.databaseTitle}" has no "${spec.naturalKeyProperty}" property (natural key of ${logicalKey})`] };

  if (spec.naturalKeyIsIdentity === true && selector.logical_record_key !== undefined) return { ok: false, code: "HOLD_TARGET_NOT_FOUND", evidence: [`rows of "${spec.databaseTitle}" are identified by "${spec.naturalKeyProperty}" alone; a title can match several rows or a legacy one, so it never addresses a record here`] };

  const existingId = normalizeId(selector.existing_object_id);
  if (selector.existing_object_id !== undefined && !existingId) return { ok: false, code: "HOLD_TARGET_NOT_FOUND", evidence: ["existing_object_id is not a Notion object id"] };
  if (existingId) {
    if (operation === "CREATE") return { ok: false, code: "HOLD_UNSUPPORTED_OPERATION", evidence: ["CREATE cannot name an existing_object_id"] };
    let page: Page;
    try { page = (await client.retrievePage(existingId)) as Page; } catch (err) { return { ok: false, code: "HOLD_TARGET_NOT_FOUND", evidence: [`existing_object_id ${existingId} unreadable: ${(err as Error).message}`] }; }
    if (page.archived || page.in_trash) return { ok: false, code: "HOLD_TARGET_NOT_FOUND", evidence: [`existing_object_id ${existingId} is archived`] };
    const parentDs = pageDataSource(page);
    if (!parentDs) return { ok: false, code: "HOLD_CROSS_RUNTIME", evidence: [`existing_object_id ${existingId} has no readable parent data source; membership in the bound runtime cannot be proven`] };
    if (parentDs !== disc.ds) return { ok: false, code: "HOLD_CROSS_RUNTIME", evidence: [`existing_object_id ${existingId} belongs to data source ${parentDs}, not to "${spec.databaseTitle}" (${disc.ds}) of the bound runtime`] };
    if (spec.naturalKeyIsIdentity === true) {
      // Membership alone is not identity here. The stored key must be exactly what the backend would have
      // written: absent, blank or non-canonical means a legacy or unreconciled row, which the migration keeps
      // unaddressable. A natural_key named alongside the id is held to the same standard as on its own route,
      // and may not contradict what the row actually carries.
      const stored = propText(page, spec.naturalKeyProperty) ?? "";
      if (!validNaturalKey(spec.naturalKeyKind, stored)) return { ok: false, code: "HOLD_TARGET_NOT_FOUND", evidence: [`${existingId} does not carry a canonical "${spec.naturalKeyProperty}": it is a legacy or unreconciled row of "${spec.databaseTitle}" and stays unaddressable until it is reconciled`] };
      const named = selector.natural_key;
      if (named !== undefined) {
        if (!validNaturalKey(spec.naturalKeyKind, named)) return { ok: false, code: "HOLD_TARGET_NOT_FOUND", evidence: [`natural_key for ${logicalKey} is not a canonical ${spec.naturalKeyKind ?? "OPAQUE"} value`] };
        if (named !== stored) return { ok: false, code: "HOLD_TARGET_NOT_FOUND", evidence: [`existing_object_id ${existingId} carries a different "${spec.naturalKeyProperty}" than the natural_key named in the same selector`] };
      }
      const sole = await proveSoleKeyHolder(client, disc.ds, schema, spec, stored, normalizeId(page.id) as string);
      if (!sole.ok) return sole;
    }
    return { ok: true, target: { kind: "EXISTING", page, page_ref: normalizeId(page.id) as string, data_source: schema, spec } };
  }

  const byNatural = selector.natural_key !== undefined;
  const key = byNatural ? selector.natural_key : selector.logical_record_key;
  if (key === undefined || key.trim() === "") return { ok: false, code: "HOLD_TARGET_NOT_FOUND", evidence: ["record_selector must name natural_key, logical_record_key or existing_object_id"] };
  if (byNatural && !validNaturalKey(spec.naturalKeyKind, key)) return { ok: false, code: "HOLD_TARGET_NOT_FOUND", evidence: [`natural_key for ${logicalKey} is not a canonical ${spec.naturalKeyKind ?? "OPAQUE"} value`] };
  const property = byNatural ? spec.naturalKeyProperty : [...schema.properties.entries()].find(([, t]) => t === "title")?.[0];
  if (!property) return { ok: false, code: "HOLD_SCHEMA_MISMATCH", evidence: [`"${spec.databaseTitle}" has no title property for logical_record_key`] };
  let matches: Page[];
  try {
    matches = await queryAll(client, disc.ds, keyLookupFilter(spec, schema.properties.get(property), property, key));
  } catch (err) {
    // Uniqueness could not be PROVEN. Treating this as "no row" would let a retry create a second row, so the
    // only safe answer is to refuse: an unavailable exact lookup is never evidence of absence.
    return { ok: false, code: "HOLD_TARGET_AMBIGUOUS", evidence: [`exact ${property} lookup on "${spec.databaseTitle}" is unavailable (${(err as Error).message}); uniqueness cannot be proven, so nothing is created or updated`] };
  }
  const rows = matches.filter((p) => (byNatural ? propText(p, property) : titleOf(p))?.trim() === key.trim());
  if (spec.naturalKeyIsIdentity === true) {
    const unreconciled = rows.filter((p) => !validNaturalKey(spec.naturalKeyKind, propText(p, property) ?? ""));
    if (unreconciled.length > 0) return { ok: false, code: "HOLD_TARGET_AMBIGUOUS", evidence: [`${unreconciled.map((r) => normalizeId(r.id)).join(", ")} of "${spec.databaseTitle}" match ${property} = ${key} only after normalization; reconcile the stored key before writing, so a second row is never created beside it`] };
  }
  if (rows.length > 1) return { ok: false, code: "HOLD_TARGET_AMBIGUOUS", evidence: [`${rows.length} rows of "${spec.databaseTitle}" match ${property} = ${key}: ${rows.map((r) => normalizeId(r.id)).join(", ")}`] };
  if (rows.length === 1) {
    if (operation === "CREATE") return { ok: false, code: "HOLD_DUPLICATE", evidence: [`a row of "${spec.databaseTitle}" with ${property} = ${key} already exists (${normalizeId((rows[0] as Page).id)}); use UPDATE or UPSERT`] };
    return { ok: true, target: { kind: "EXISTING", page: rows[0] as Page, page_ref: normalizeId((rows[0] as Page).id) as string, data_source: schema, spec } };
  }
  if (operation === "UPDATE") return { ok: false, code: "HOLD_TARGET_NOT_FOUND", evidence: [`no row of "${spec.databaseTitle}" has ${property} = ${key}`] };
  if (!byNatural) return { ok: false, code: "HOLD_TARGET_NOT_FOUND", evidence: ["CREATE/UPSERT of a new row requires natural_key"] };
  return { ok: true, target: { kind: "NEW", data_source: schema, natural_key: key, spec } };
}

/** Validates desired_changes against the target schema and the resource's protected properties. */
export function checkFields(target: ResolvedTarget, desired: Readonly<Record<string, unknown>>): { ok: true } | { ok: false; code: "HOLD_SCHEMA_MISMATCH" | "HOLD_UNSUPPORTED_OPERATION"; evidence: string[] } {
  const keys = Object.keys(desired);
  if (keys.length === 0) return { ok: false, code: "HOLD_UNSUPPORTED_OPERATION", evidence: ["desired_changes is empty"] };
  const missing = keys.filter((k) => !target.data_source.properties.has(k));
  if (missing.length > 0) return { ok: false, code: "HOLD_SCHEMA_MISMATCH", evidence: [`fields not in "${target.spec.databaseTitle}" schema: ${missing.join(", ")}`] };
  const unwritable = keys.filter((k) => !WRITABLE_TYPES.has(target.data_source.properties.get(k) as string));
  if (unwritable.length > 0) return { ok: false, code: "HOLD_SCHEMA_MISMATCH", evidence: [`fields are system-computed (not writable): ${unwritable.map((k) => `${k} (${target.data_source.properties.get(k)})`).join(", ")}`] };
  const protectedHit = keys.filter((k) => (target.spec.protectedProperties ?? []).includes(k));
  if (protectedHit.length > 0) return { ok: false, code: "HOLD_UNSUPPORTED_OPERATION", evidence: [`control-owned fields cannot be set through os_prepare: ${protectedHit.join(", ")}`] };
  const outsideAllowlist = target.spec.writableProperties ? keys.filter((k) => !target.spec.writableProperties?.includes(k)) : [];
  if (outsideAllowlist.length > 0) return { ok: false, code: "HOLD_UNSUPPORTED_OPERATION", evidence: [`fields are outside the writable allowlist of ${target.spec.databaseTitle}: ${outsideAllowlist.join(", ")}`] };
  return { ok: true };
}

/** Caller relation values may be one reference or a list; a `page:` prefix and dashes are normalized away. */
export function relationIds(value: unknown): readonly (string | undefined)[] {
  const list = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  return list.map((v) => (typeof v === "string" ? normalizeId(v.replace(/^page:/, "")) : undefined));
}

/**
 * Relation fields must point at the data source the LIVE schema declares for them — for an outreach row, the
 * canonical Account and Contact sources of the objective package itself. A reference to another source, to an
 * archived row, or to a row that cannot be read is a schema mismatch reported before any plan exists, so a
 * mis-targeted relation can never become a durable write.
 */
export async function checkRelationTargets(client: NotionReadClient, target: ResolvedTarget, desired: Readonly<Record<string, unknown>>): Promise<{ ok: true } | { ok: false; code: "HOLD_SCHEMA_MISMATCH"; evidence: string[] }> {
  const evidence: string[] = [];
  for (const [field, value] of Object.entries(desired)) {
    if (target.data_source.properties.get(field) !== "relation") continue;
    const expected = target.data_source.relations.get(field);
    if (!expected) {
      evidence.push(`"${field}" is a relation whose target data source is not declared by the live schema; its rows cannot be validated`);
      continue;
    }
    for (const id of relationIds(value)) {
      if (!id) { evidence.push(`"${field}" holds a value that is not a Notion page reference`); continue; }
      let page: Page;
      try { page = (await client.retrievePage(id)) as Page; } catch (err) { evidence.push(`"${field}" references ${id}, which is unreadable: ${(err as Error).message}`); continue; }
      if (page.archived || page.in_trash) { evidence.push(`"${field}" references ${id}, which is archived`); continue; }
      const parent = pageDataSource(page);
      if (parent !== expected) evidence.push(`"${field}" must reference rows of data source ${expected}; ${id} belongs to ${parent ?? "an unreadable parent"}`);
    }
  }
  return evidence.length === 0 ? { ok: true } : { ok: false, code: "HOLD_SCHEMA_MISMATCH", evidence };
}

/**
 * Read-only, PROJECTED lookup of live rows of a logical resource INSIDE the bound runtime.
 *
 * Used by candidate validators that must check a claim against durable state. Three rules make it safe:
 *  - only the properties the caller names are materialized; a whole row is never built;
 *  - the outcome distinguishes an empty result from an unavailable resource, an unreadable schema and a failed
 *    read, so a missing capability can never look like "no rows";
 *  - it reads only inside the bound runtime.
 */
export type LookupOutcome =
  | { readonly status: "OK"; readonly rows: readonly Readonly<Record<string, string | null>>[] }
  | { readonly status: "UNAVAILABLE"; readonly reason: string }
  | { readonly status: "SCHEMA_INVALID"; readonly reason: string }
  | { readonly status: "READ_FAILED"; readonly reason: string };

export async function findRows(
  client: NotionReadClient,
  runtime: ResolvedRuntime,
  logicalKey: string,
  property: string,
  value: string,
  project: readonly string[],
): Promise<LookupOutcome> {
  const spec = runtime.adapter.controlPlane.resources?.[logicalKey];
  if (!spec) return { status: "UNAVAILABLE", reason: `logical resource ${logicalKey} is not addressable under ${runtime.adapter.version}` };
  let disc: Awaited<ReturnType<typeof discoverDataSource>>;
  try {
    disc = await discoverDataSource(client, runtime, spec);
  } catch (err) {
    return { status: "READ_FAILED", reason: `discovery of "${spec.databaseTitle}" failed: ${(err as Error).message}` };
  }
  if (!disc.ok) return { status: "UNAVAILABLE", reason: disc.evidence.join("; ") };
  const schema = await readSchema(client, disc.ds);
  if (!schema) return { status: "SCHEMA_INVALID", reason: `schema of "${spec.databaseTitle}" is unreadable` };
  const wanted = [...new Set([property, ...project])];
  const missing = wanted.filter((k) => !schema.properties.has(k));
  if (missing.length > 0) return { status: "SCHEMA_INVALID", reason: `"${spec.databaseTitle}" has no ${missing.join(", ")} property` };
  let pages: Page[];
  try {
    pages = await queryAll(client, disc.ds, naturalKeyFilter(schema.properties.get(property), property, value));
  } catch (err) {
    return { status: "READ_FAILED", reason: `query of "${spec.databaseTitle}" failed: ${(err as Error).message}` };
  }
  const rows = pages
    .filter((p) => (propText(p, property) ?? "").trim() === value.trim())
    .map((p) => Object.fromEntries(wanted.map((k) => [k, propText(p, k) ?? null])));
  return { status: "OK", rows };
}
