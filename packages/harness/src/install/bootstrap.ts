/**
 * Dedicated, fail-closed bootstrap reader for a provisioner-assigned Personal SALES clone.
 *
 * Copied Registry/history values are hostile input. The governing adapter owns the required keys, exact paths,
 * object kinds and minimum schemas. This module reads only the assigned root and projects Registry rows to Key,
 * Resource URL and Status; Notes, copied PII, Last Run and every business row remain quarantined.
 */
import { createHash } from "node:crypto";
import type { Principal } from "../auth/principal.ts";
import type { BindingRecord } from "../binding/store.ts";
import { listAllChildren, type NotionReadClient } from "../notion/readClient.ts";
import { childPageTitle, normalizeId, propText, type Block, type Page } from "../notion/shapes.ts";
import type { Intent, IntentMutation } from "../plans/prepare.ts";
import type { ResolvedRuntime } from "../resolvers/types.ts";
import type { InstallPhysicalResource } from "../versions/adapters/controlPlane.ts";

export const INSTALL_MANIFEST_RESOURCE = "SALES:INSTALL_MANIFEST";
export const INSTALL_REGISTRY_RESOURCE = "SALES:INSTALL_REGISTRY";
/** Server-derived only: callers never supply this mutation in an install intent. */
export const INSTALL_OS_STATE_RESOURCE = "SALES:INSTALL_OS_STATE";
export const INSTALL_RESOURCES = [INSTALL_MANIFEST_RESOURCE, INSTALL_REGISTRY_RESOURCE] as const;

const READ_SCOPE = "INSTANCE_ROOT + sources explicitement autorisées";
const WRITE_SCOPE = "INSTANCE_ROOT";

export const isInstallOnlyBinding = (binding: BindingRecord): boolean => binding.binding_mode === "INSTALL_ONLY";
export const isInstallMutation = (m: IntentMutation): boolean => (INSTALL_RESOURCES as readonly string[]).includes(m.logical_resource_key);

const dbTitle = (b: Block): string | undefined => b.type === "child_database" ? (b["child_database"] as { title?: string } | undefined)?.title : undefined;
const title = (b: Block): string | undefined => b.type === "child_page" ? childPageTitle(b) : dbTitle(b);
const url = (id: string): string => `https://www.notion.so/${id}`;
const scalar = (v: unknown): string => typeof v === "string" ? v.trim() : "";
const selectorKey = (m: IntentMutation): string | undefined => m.record_selector.natural_key?.trim() ?? m.record_selector.logical_record_key?.trim();
interface SchemaProperty {
  readonly type?: string;
  readonly select?: { readonly options?: readonly { readonly name?: string }[] };
  readonly status?: { readonly options?: readonly { readonly name?: string }[] };
  readonly multi_select?: { readonly options?: readonly { readonly name?: string }[] };
  /** Fixture/MCP-normalized fallback; production Notion REST nests options under the property type. */
  readonly options?: readonly { readonly name?: string }[];
}
type DataSourceSchema = Readonly<Record<string, SchemaProperty>>;

const optionsOf = (p: SchemaProperty | undefined): readonly string[] => {
  if (!p) return [];
  const options = p.select?.options ?? p.status?.options ?? p.multi_select?.options ?? p.options ?? [];
  return options.map((o) => o.name?.trim() ?? "").filter(Boolean).sort();
};

const fingerprint = (properties: DataSourceSchema): string => createHash("sha256").update(JSON.stringify(Object.entries(properties).map(([k, v]) => [k, v.type ?? "unknown", optionsOf(v)]).sort())).digest("hex");

export interface InstallCandidate {
  readonly key: string;
  readonly registry_key?: string;
  readonly required: boolean;
  readonly object_type: "PAGE" | "DATABASE";
  readonly exact_path: string;
  readonly object_ref: string;
  readonly data_source_ref?: string;
  readonly schema_fingerprint?: string;
  readonly registry_row_ref?: string;
  readonly registry_row_revision?: string;
  readonly observed_resource_ref?: string;
  readonly observed_status?: string;
  readonly observed_required?: string;
  readonly observed_resource_type?: string;
  readonly observed_scope?: string;
  /** Equality only: copied Notes may contain PII and are never projected into backend state or envelopes. */
  readonly observed_notes_matches_contract?: boolean;
  readonly observed_points_to_candidate: boolean;
}

export interface InstallInspection {
  readonly candidates: readonly InstallCandidate[];
  readonly mapping: readonly {
    readonly key: string;
    readonly row_ref: string;
    readonly candidate_ref: string;
    readonly candidate_url: string;
    readonly object_type: "PAGE" | "DATABASE";
    readonly exact_path: string;
    readonly required: boolean;
    readonly scope: "READ_ONLY" | "READ_WRITE";
    readonly notes: string;
  }[];
  readonly connector_capabilities: readonly { readonly key: string; readonly requirement: "REQUIRED" | "OPTIONAL"; readonly competent_source: string; readonly state: "UNKNOWN" }[];
  readonly violations: readonly string[];
  readonly registry_data_source_ref?: string;
  readonly registry_schema?: DataSourceSchema;
  readonly manifest_data_source_ref?: string;
  readonly manifest_schema?: DataSourceSchema;
  readonly state_data_source_ref?: string;
  readonly state_schema?: DataSourceSchema;
  /** One digest over every contract-derived physical ref and schema used by this inspection. */
  readonly inspection_fingerprint?: string;
}

async function resolveExactPath(
  client: NotionReadClient,
  rootId: string,
  spec: InstallPhysicalResource,
  childrenOf: (blockId: string) => Promise<readonly Block[]> = (blockId) => listAllChildren(client, blockId),
): Promise<{ readonly ref: string; readonly dataSource?: string; readonly schemaFingerprint?: string; readonly schema?: DataSourceSchema } | string> {
  if (spec.path.length === 0) return { ref: rootId };
  let holder = rootId;
  for (const [i, segment] of spec.path.entries()) {
    let children: readonly Block[];
    try { children = await childrenOf(holder); }
    catch (err) { return `${spec.key}: cannot read ${i === 0 ? "assigned root" : spec.path.slice(0, i).join(" / ")}: ${(err as Error).message}`; }
    const matches = children.filter((b) => title(b)?.trim() === segment);
    if (matches.length !== 1) return `${spec.key}: exact path ${spec.path.join(" / ")} has ${matches.length} matches at ${segment}`;
    const match = matches[0] as Block;
    const expected = i === spec.path.length - 1 ? spec.objectType : "PAGE";
    const observed = match.type === "child_page" ? "PAGE" : match.type === "child_database" ? "DATABASE" : "BLOCK";
    if (observed !== expected) return `${spec.key}: ${segment} is ${observed}, expected ${expected}`;
    holder = normalizeId(match.id) as string;
  }
  if (spec.objectType === "PAGE") return { ref: holder };
  try {
    const db = (await client.retrieveDatabase(holder)) as { readonly data_sources?: readonly { readonly id: string }[] };
    const sources = db.data_sources ?? [];
    if (sources.length !== 1) return `${spec.key}: database has ${sources.length} data sources, expected exactly one`;
    const ds = normalizeId((sources[0] as { id: string }).id) as string;
    const schema = (await client.retrieveDataSource(ds)) as { readonly properties?: DataSourceSchema };
    if (!schema.properties) return `${spec.key}: data-source schema is unreadable`;
    const titleCount = Object.values(schema.properties).filter((p) => p.type === "title").length;
    if (titleCount !== 1) return `${spec.key}: schema has ${titleCount} title properties, expected exactly one`;
    for (const [name, type] of Object.entries(spec.requiredProperties ?? {})) if (schema.properties[name]?.type !== type) return `${spec.key}: schema property ${name} is ${schema.properties[name]?.type ?? "MISSING"}, expected ${type}`;
    for (const [name, required] of Object.entries(spec.requiredSelectOptions ?? {})) {
      const available = optionsOf(schema.properties[name]);
      for (const option of required) if (!available.includes(option)) return `${spec.key}: schema select ${name} lacks required option ${option}`;
    }
    return { ref: holder, dataSource: ds, schemaFingerprint: fingerprint(schema.properties), schema: schema.properties };
  } catch (err) {
    return `${spec.key}: database/schema read failed: ${(err as Error).message}`;
  }
}

function registryMetadata(spec: InstallPhysicalResource): { readonly required: boolean; readonly resourceType: "PAGE" | "DATABASE"; readonly scope: "READ_ONLY" | "READ_WRITE"; readonly notes: string } {
  return {
    required: spec.required,
    resourceType: spec.objectType,
    scope: spec.objectType === "DATABASE" ? "READ_WRITE" : "READ_ONLY",
    notes: `Ressource ${spec.key} dérivée du contrat ; métadonnées copiées neutralisées.`,
  };
}

function requireWritableField(violations: string[], label: string, schema: DataSourceSchema | undefined, field: string, type: string, options: readonly string[] = []): void {
  const p = schema?.[field];
  if (p?.type !== type) {
    violations.push(`${label}: writable property ${field} is ${p?.type ?? "MISSING"}, expected ${type}`);
    return;
  }
  const available = optionsOf(p);
  for (const option of options) if (!available.includes(option)) violations.push(`${label}: writable select ${field} lacks required option ${option}`);
}

/** Every field/value the installer may write must already be admitted by the live clone schema. */
function validateInstallerSchemas(violations: string[], registry: DataSourceSchema | undefined, manifest: DataSourceSchema | undefined): void {
  requireWritableField(violations, "REGISTRY", registry, "Key", "title");
  requireWritableField(violations, "REGISTRY", registry, "Required", "checkbox");
  requireWritableField(violations, "REGISTRY", registry, "Resource URL", "url");
  requireWritableField(violations, "REGISTRY", registry, "Resource Type", "select", ["PAGE"]);
  requireWritableField(violations, "REGISTRY", registry, "Status", "select", ["MISSING", "EXPECTED", "RESOLVED", "HOLD"]);
  requireWritableField(violations, "REGISTRY", registry, "Scope", "select", ["READ_WRITE"]);
  requireWritableField(violations, "REGISTRY", registry, "Notes", "rich_text");

  requireWritableField(violations, "INSTANCE_MANIFEST", manifest, "Root URL", "url");
  requireWritableField(violations, "INSTANCE_MANIFEST", manifest, "Instance ID", "rich_text");
  requireWritableField(violations, "INSTANCE_MANIFEST", manifest, "Owner", "rich_text");
  requireWritableField(violations, "INSTANCE_MANIFEST", manifest, "Gmail Identity", "email");
  requireWritableField(violations, "INSTANCE_MANIFEST", manifest, "Install State", "select", ["SETUP"]);
  requireWritableField(violations, "INSTANCE_MANIFEST", manifest, "Instance Status", "select", ["ACTIVE"]);
  requireWritableField(violations, "INSTANCE_MANIFEST", manifest, "Sales Contract URL", "url");
  requireWritableField(violations, "INSTANCE_MANIFEST", manifest, "Last Run Ref", "rich_text");
  requireWritableField(violations, "INSTANCE_MANIFEST", manifest, "Read Scope", "rich_text");
  requireWritableField(violations, "INSTANCE_MANIFEST", manifest, "Write Scope", "rich_text");
  requireWritableField(violations, "INSTANCE_MANIFEST", manifest, "Gmail Verified", "checkbox");
  requireWritableField(violations, "INSTANCE_MANIFEST", manifest, "Tracker Access", "select", ["UNKNOWN"]);
  requireWritableField(violations, "INSTANCE_MANIFEST", manifest, "Capability Status", "select", ["UNKNOWN"]);
  requireWritableField(violations, "INSTANCE_MANIFEST", manifest, "Recovery Required", "checkbox");
}

async function queryAll(client: NotionReadClient, dsId: string): Promise<Page[]> {
  const out: Page[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 50; guard += 1) {
    const q = (await client.queryDataSource(dsId, undefined, cursor)) as { readonly results: readonly Page[]; readonly has_more?: boolean; readonly next_cursor?: string | null };
    out.push(...q.results.filter((p) => !p.archived && !p.in_trash));
    if (!q.has_more || !q.next_cursor) return out;
    cursor = q.next_cursor;
  }
  throw new Error("Registry pagination exceeded the safety limit");
}

/** Resolve just the governing Registry, without projecting or caching the other resources' facts. */
export async function resolveInstallRegistry(client: NotionReadClient, runtime: ResolvedRuntime): Promise<string | undefined> {
  const specs = runtime.adapter.controlPlane.installContract?.physicalResources.filter((s) => s.key === "REGISTRY");
  if (specs?.length !== 1) return undefined;
  const resolved = await resolveExactPath(client, runtime.root_ref, specs[0] as InstallPhysicalResource);
  return typeof resolved === "string" ? undefined : resolved.dataSource;
}

/** A fresh scan for one continuation observation, never a canary absence proof. */
export async function queryInstallRegistryRows(client: NotionReadClient, runtime: ResolvedRuntime): Promise<Page[]> {
  const ds = await resolveInstallRegistry(client, runtime);
  return ds ? queryAll(client, ds) : [];
}

/** Contract-derived, deterministic mapping. No copied Required/Resource Type/Notes value is ever consumed. */
export async function inspectInstallBootstrap(client: NotionReadClient, runtime: ResolvedRuntime): Promise<InstallInspection> {
  const contract = runtime.adapter.controlPlane.installContract;
  if (!contract) return { candidates: [], mapping: [], connector_capabilities: [], violations: ["governing Sales contract declares no install contract"] };
  const violations: string[] = [];
  const discovered = new Map<string, { readonly ref: string; readonly dataSource?: string; readonly schemaFingerprint?: string; readonly schema?: DataSourceSchema }>();
  // Most contract paths share the same root and section pages. Resolve each block's children only once per
  // inspection pass; otherwise a 35-resource contract can issue hundreds of identical reads and hit Notion's
  // rate limit before the second bounded install action.
  const childReads = new Map<string, Promise<readonly Block[]>>();
  const childrenOf = (blockId: string): Promise<readonly Block[]> => {
    const key = normalizeId(blockId) ?? blockId;
    let pending = childReads.get(key);
    if (!pending) {
      pending = listAllChildren(client, key);
      childReads.set(key, pending);
    }
    return pending;
  };
  for (const spec of contract.physicalResources) {
    const r = await resolveExactPath(client, runtime.root_ref, spec, childrenOf);
    if (typeof r === "string") { if (spec.required) violations.push(r); continue; }
    discovered.set(spec.key, r);
  }
  const registry = discovered.get("REGISTRY");
  if (!registry?.dataSource) return { candidates: [], mapping: [], connector_capabilities: contract.connectorCapabilities.map((c) => ({ key: c.key, requirement: c.requirement, competent_source: c.competentSource, state: "UNKNOWN" as const })), violations: [...violations, "governing Registry database is not uniquely readable"] };

  const manifest = discovered.get("INSTANCE_MANIFEST");
  const state = discovered.get("OS_STATE");
  validateInstallerSchemas(violations, registry.schema, manifest?.schema);

  let rows: Page[] = [];
  try { rows = await queryAll(client, registry.dataSource); }
  catch (err) { violations.push(`Registry rows cannot be projected: ${(err as Error).message}`); }
  const rowsByKey = new Map<string, Page[]>();
  for (const row of rows) {
    const key = propText(row, "Key")?.trim() ?? "";
    if (key) rowsByKey.set(key, [...(rowsByKey.get(key) ?? []), row]);
  }

  const candidates: InstallCandidate[] = [];
  const mapping: InstallInspection["mapping"][number][] = [];
  for (const spec of contract.physicalResources) {
    const object = discovered.get(spec.key);
    if (!object) continue;
    const rr = spec.registryKey ? rowsByKey.get(spec.registryKey) ?? [] : [];
    if (spec.registryKey && rr.length !== 1) violations.push(`${spec.key}: Registry must contain exactly one contract key ${spec.registryKey}, found ${rr.length}`);
    const row = rr.length === 1 ? rr[0] as Page : undefined;
    const observedUrl = row ? propText(row, "Resource URL")?.trim() : undefined;
    const observedStatus = row ? propText(row, "Status")?.trim() : undefined;
    const observedRequired = row ? propText(row, "Required")?.trim() : undefined;
    const observedResourceType = row ? propText(row, "Resource Type")?.trim() : undefined;
    const observedScope = row ? propText(row, "Scope")?.trim() : undefined;
    const metadata = registryMetadata(spec);
    const candidate: InstallCandidate = {
      key: spec.key, ...(spec.registryKey ? { registry_key: spec.registryKey } : {}), required: spec.required,
      object_type: spec.objectType, exact_path: ["ROOT", ...spec.path].join(" / "), object_ref: object.ref,
      ...(object.dataSource ? { data_source_ref: object.dataSource } : {}), ...(object.schemaFingerprint ? { schema_fingerprint: object.schemaFingerprint } : {}),
      ...(row ? {
        registry_row_ref: normalizeId(row.id) as string,
        ...(row.last_edited_time ? { registry_row_revision: row.last_edited_time } : {}),
        ...(normalizeId(observedUrl) ? { observed_resource_ref: normalizeId(observedUrl) as string } : {}),
        ...(observedStatus ? { observed_status: observedStatus } : {}),
        ...(observedRequired ? { observed_required: observedRequired } : {}),
        ...(observedResourceType ? { observed_resource_type: observedResourceType } : {}),
        ...(observedScope ? { observed_scope: observedScope } : {}),
        observed_notes_matches_contract: propText(row, "Notes")?.trim() === metadata.notes,
      } : {}),
      observed_points_to_candidate: normalizeId(observedUrl) === object.ref,
    };
    candidates.push(candidate);
    if (spec.registryKey && row) mapping.push({ key: spec.registryKey, row_ref: normalizeId(row.id) as string, candidate_ref: object.ref, candidate_url: url(object.ref), object_type: spec.objectType, exact_path: candidate.exact_path, required: metadata.required, scope: metadata.scope, notes: metadata.notes });
  }
  const inspectionFingerprint = createHash("sha256").update(JSON.stringify([...discovered.entries()].map(([key, value]) => [key, value.ref, value.dataSource ?? null, value.schemaFingerprint ?? null]).sort())).digest("hex");
  return {
    candidates,
    mapping: mapping.sort((a, b) => a.key.localeCompare(b.key)),
    connector_capabilities: contract.connectorCapabilities.map((c) => ({ key: c.key, requirement: c.requirement, competent_source: c.competentSource, state: "UNKNOWN" as const })),
    violations,
    registry_data_source_ref: registry.dataSource,
    ...(registry.schema ? { registry_schema: registry.schema } : {}),
    ...(manifest?.dataSource ? { manifest_data_source_ref: manifest.dataSource } : {}),
    ...(manifest?.schema ? { manifest_schema: manifest.schema } : {}),
    ...(state?.dataSource ? { state_data_source_ref: state.dataSource } : {}),
    ...(state?.schema ? { state_schema: state.schema } : {}),
    inspection_fingerprint: inspectionFingerprint,
  };
}

export function mappingIntentTemplate(inspection: InstallInspection): Intent {
  return {
    action_class: "INSTALL",
    summary: "rebind this assigned clone to its contract-derived local resources",
    // Registry.Status already governs EXPECTED / RESOLVED / MISSING / HOLD. Provisioning authorization itself
    // lives in the backend registry as INSTALL_PENDING; no unversioned Notion select option is invented here.
    mutations: inspection.mapping.map((m) => ({
      logical_resource_key: INSTALL_REGISTRY_RESOURCE, operation: "UPDATE" as const, record_selector: { natural_key: m.key },
      desired_changes: { Required: m.required, "Resource URL": m.candidate_url, "Resource Type": m.object_type, Status: "HOLD", Scope: m.scope, Notes: m.notes },
    })),
  };
}

/** Exact equality with the server-derived mapping is required; no caller-selected root or target is admitted. */
export async function validateInstallMappingIntent(client: NotionReadClient, runtime: ResolvedRuntime, intent: Intent): Promise<{ readonly violations: string[]; readonly inspection: InstallInspection }> {
  const inspection = await inspectInstallBootstrap(client, runtime);
  const v = [...inspection.violations];
  if (intent.action_class !== "INSTALL") v.push("INSTALL_ONLY mapping requires action_class INSTALL");
  if (intent.mutations.some((m) => m.logical_resource_key !== INSTALL_REGISTRY_RESOURCE || m.operation !== "UPDATE")) v.push("mapping accepts only UPDATE of SALES:INSTALL_REGISTRY");
  const expected = new Map(mappingIntentTemplate(inspection).mutations.map((m) => [selectorKey(m) as string, m]));
  if (intent.mutations.length !== expected.size) v.push(`mapping must contain exactly ${expected.size} contract-derived Registry mutations`);
  const seen = new Set<string>();
  for (const m of intent.mutations) {
    const key = selectorKey(m) ?? "UNKNOWN";
    if (seen.has(key)) v.push(`Registry key ${key} is duplicated`);
    seen.add(key);
    const e = expected.get(key);
    if (!e) { v.push(`Registry key ${key} is not part of the governing install contract`); continue; }
    const fields = Object.keys(m.desired_changes).sort();
    if (fields.join("|") !== "Notes|Required|Resource Type|Resource URL|Scope|Status") v.push(`Registry key ${key} must update exactly the contract-derived Required, Resource URL, Resource Type, Status, Scope and Notes metadata`);
    if (normalizeId(scalar(m.desired_changes["Resource URL"])) !== normalizeId(scalar(e.desired_changes["Resource URL"]))) v.push(`Registry key ${key} does not target its unique contract-derived clone resource`);
    if (m.desired_changes["Status"] !== "HOLD") v.push(`Registry key ${key} must remain HOLD until the bounded readback verification completes`);
    for (const field of ["Required", "Resource Type", "Scope", "Notes"] as const) if (m.desired_changes[field] !== e.desired_changes[field]) v.push(`Registry key ${key} ${field} does not match the governing contract metadata`);
  }
  for (const key of expected.keys()) if (!seen.has(key)) v.push(`required contract mapping ${key} is absent`);
  return { violations: v, inspection };
}

export function installManifestTemplate(principal: Principal, runtime: ResolvedRuntime): Readonly<Record<string, unknown>> {
  const expected: Record<string, unknown> = {
    "Root URL": url(runtime.root_ref), "Instance ID": runtime.runtime_id, Owner: principal.display_name ?? "",
    "Install State": "SETUP", "Instance Status": "ACTIVE", "Read Scope": READ_SCOPE, "Write Scope": WRITE_SCOPE,
    "Sales Contract URL": null, "Last Run Ref": "",
    "Gmail Verified": false, "Tracker Access": "UNKNOWN", "Capability Status": "UNKNOWN", "Recovery Required": false,
    // ADMISSION-SALES-001: the Manifest is authoritative for admission, so promotion must clear its fail-closed
    // seed exactly as it clears the OS State one below. The master ships Health Status HOLD and Persistence
    // Health HOLD_REBIND_REQUIRED on purpose; leaving them turns every installed clone into a runtime that is
    // refused on its first business turn. The promotion has just proved this clone's structure against the
    // contract and is establishing its identity, so HEALTHY/PASS is the claim it is entitled to make.
    "Health Status": "HEALTHY",
    "Persistence Health": "PASS",
    // Copied cursor and journal pointers, cleared for the same reason as Last Run Ref: a pointer inherited from
    // the master names rows that do not belong to this instance.
    "Current Gate": "B0_DISCOVERY",
    "Current Gate Status": "OPEN",
    "Last Verified Mutation": "",
  };
  const gmail = runtime.observations["registry_expected_gmail_identity"];
  // A clone may carry another seller's mailbox. Absence of a backend expectation therefore means CLEAR, never
  // preserve: a later competent-source proof may repopulate identity, but copied template PII cannot survive install.
  expected["Gmail Identity"] = typeof gmail === "string" && gmail !== "UNKNOWN" && gmail.trim() !== "" ? gmail.trim().toLowerCase() : null;
  return expected;
}

/**
 * Clone-local cursor established immediately before Manifest SETUP becomes authoritative.
 *
 * The master deliberately carries a fail-closed UNBOUND seed. Promotion must not turn that copied seed into
 * recovery evidence: it replaces every cursor field the BUSINESS engine consumes, clears copied journal pointers,
 * and leaves the first business turn at B0 where capability completeness can select the next safe user action.
 */
export function installStateTemplate(): Readonly<Record<string, unknown>> {
  return {
    "Build State": "B0_DISCOVERY",
    "Current Gate": "B0_DISCOVERY",
    "Current Gate Status": "OPEN",
    "Persistence Health": "PASS",
    "Recovery Required": false,
    "Open Blocker": "",
    "Next Action": "Connecter les capacités requises, puis reprendre le setup depuis B0_DISCOVERY.",
    "Next Question": "",
    "Last Run Ref": "",
    "Last Verified Mutation": "",
    "Last Required Written At": null,
    "Last Verified At": null,
  };
}

export function validatePromotionIntent(principal: Principal, runtime: ResolvedRuntime, intent: Intent): string[] {
  const v: string[] = [];
  if (intent.action_class !== "INSTALL_PROMOTE") v.push("promotion requires action_class INSTALL_PROMOTE");
  if (intent.mutations.length !== 1) return [...v, "promotion requires exactly one server-derived Manifest mutation"];
  const m = intent.mutations[0] as IntentMutation;
  if (m.logical_resource_key !== INSTALL_MANIFEST_RESOURCE || m.operation !== "UPDATE" || selectorKey(m) !== "CURRENT") v.push("promotion may update only the canonical Manifest CURRENT row");
  const expected = installManifestTemplate(principal, runtime);
  if (JSON.stringify(Object.keys(m.desired_changes).sort()) !== JSON.stringify(Object.keys(expected).sort())) v.push("promotion fields differ from the governing Manifest template");
  for (const [field, value] of Object.entries(expected)) {
    const actual = m.desired_changes[field];
    if (field === "Root URL" ? normalizeId(scalar(actual)) !== runtime.root_ref : actual !== value) v.push(`Manifest ${field} does not match the authenticated assignment`);
  }
  return v;
}
