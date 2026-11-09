/**
 * Control-plane schema contract for harness linkage (PV0-013, PT-SCHEMA-001).
 *
 * FINAL must distinguish a narrative "VERIFIED" from a harness-verified mutation, so the Mutation Ledger and
 * the Runs database must expose STRUCTURED, filterable identity fields. This module declares the contract
 * (derived from the adapter grammar so names stay version-scoped), detects compatibility of a live or
 * fixture runtime with exact gaps, and offers a PURE migration helper for fixture schemas.
 *
 * It never mutates a live runtime: applying the migration to META or SALES requires a separately authorized
 * migration validation ticket; the harness only reports what is missing.
 */
import type { NotionReadClient } from "../notion/readClient.ts";
import type { ResolvedRuntime } from "../resolvers/types.ts";
import { discoverControlPlane } from "../resume/readers.ts";
import { readSchema } from "../plans/resources.ts";
import type { ControlPlaneGrammar } from "../versions/adapters/controlPlane.ts";

export interface RequiredProperty { readonly name: string; readonly type: string; readonly role: string; readonly level: "REQUIRED" | "RECOMMENDED" }
export interface SchemaContract { readonly runs: readonly RequiredProperty[]; readonly ledger: readonly RequiredProperty[] }

/** Derives the contract from the grammar: property NAMES are version-scoped, roles and types are fixed. */
export function schemaContractOf(g: ControlPlaneGrammar): SchemaContract {
  const wp = g.writeProps;
  const runs: RequiredProperty[] = [
    { name: g.runProps.status, type: "select", role: "run status", level: "REQUIRED" },
    ...(wp?.runHarnessPlanId ? [{ name: wp.runHarnessPlanId, type: "rich_text", role: "harness plan id (Run ↔ plan linkage)", level: "REQUIRED" as const }] : []),
  ];
  const ledger: RequiredProperty[] = [
    { name: g.ledgerProps.status, type: "select", role: "ledger status", level: "REQUIRED" },
    { name: g.ledgerProps.runRef, type: "rich_text", role: "Run reference (page mention)", level: "REQUIRED" },
    ...(wp?.ledgerHarnessPlanId ? [{ name: wp.ledgerHarnessPlanId, type: "rich_text", role: "harness plan id (ledger ↔ plan linkage)", level: "REQUIRED" as const }] : []),
    ...(wp?.ledgerIdempotencyKey ? [{ name: wp.ledgerIdempotencyKey, type: "rich_text", role: "operation idempotency key", level: "REQUIRED" as const }] : []),
    ...(wp?.ledgerTargetReceiptId ? [{ name: wp.ledgerTargetReceiptId, type: "rich_text", role: "harness target receipt id (FINAL proof)", level: "REQUIRED" as const }] : []),
    ...(wp?.ledgerTargetRef ? [{ name: wp.ledgerTargetRef, type: "rich_text", role: "physical target reference", level: "RECOMMENDED" as const }] : []),
    ...(wp?.ledgerOperation ? [{ name: wp.ledgerOperation, type: "select", role: "operation kind", level: "RECOMMENDED" as const }] : []),
  ];
  return { runs, ledger };
}

export interface DatabaseReport { readonly data_source: string | "NOT_FOUND"; readonly missing: readonly RequiredProperty[]; readonly wrong_type: readonly (RequiredProperty & { readonly observed: string })[]; readonly recommended_missing: readonly RequiredProperty[] }
export interface CompatibilityReport {
  readonly compatible: boolean;
  readonly runs: DatabaseReport;
  readonly ledger: DatabaseReport;
  /** Exact migration a human (or an authorized migration ticket) must apply. Empty when compatible. */
  readonly migration: readonly { readonly database: string; readonly property: string; readonly type: string; readonly reason: string }[];
}

const TEXT_LIKE = new Set(["rich_text", "title"]);
function typeOk(required: string, observed: string): boolean {
  if (required === observed) return true;
  if (required === "rich_text" && TEXT_LIKE.has(observed)) return true;
  if (required === "select" && observed === "status") return true;
  return false;
}

export function reportDatabase(ds: string | undefined, schema: ReadonlyMap<string, string> | undefined, required: readonly RequiredProperty[]): DatabaseReport {
  if (!ds || !schema) return { data_source: "NOT_FOUND", missing: required.filter((r) => r.level === "REQUIRED"), wrong_type: [], recommended_missing: required.filter((r) => r.level === "RECOMMENDED") };
  const missing: RequiredProperty[] = [];
  const wrong: (RequiredProperty & { observed: string })[] = [];
  const rec: RequiredProperty[] = [];
  for (const r of required) {
    const t = schema.get(r.name);
    if (t === undefined) { (r.level === "REQUIRED" ? missing : rec).push(r); continue; }
    if (!typeOk(r.type, t)) wrong.push({ ...r, observed: t });
  }
  return { data_source: ds, missing, wrong_type: wrong, recommended_missing: rec };
}

/** Read-only compatibility detection against the bound runtime's control plane. */
export async function checkSchemaCompatibility(client: NotionReadClient, runtime: ResolvedRuntime): Promise<CompatibilityReport> {
  const g = runtime.adapter.controlPlane;
  const contract = schemaContractOf(g);
  const dbs = await discoverControlPlane(client, runtime.root_ref, g);
  const runsSchema = dbs.runs ? (await readSchema(client, dbs.runs))?.properties : undefined;
  const ledgerSchema = dbs.ledger ? (await readSchema(client, dbs.ledger))?.properties : undefined;
  const runs = reportDatabase(dbs.runs, runsSchema, contract.runs);
  const ledger = reportDatabase(dbs.ledger, ledgerSchema, contract.ledger);
  const migration = [
    ...runs.missing.map((m) => ({ database: g.runsDatabaseTitle, property: m.name, type: m.type, reason: `missing: ${m.role}` })),
    ...runs.wrong_type.map((m) => ({ database: g.runsDatabaseTitle, property: m.name, type: m.type, reason: `wrong type ${m.observed}: ${m.role}` })),
    ...ledger.missing.map((m) => ({ database: g.ledgerDatabaseTitle, property: m.name, type: m.type, reason: `missing: ${m.role}` })),
    ...ledger.wrong_type.map((m) => ({ database: g.ledgerDatabaseTitle, property: m.name, type: m.type, reason: `wrong type ${m.observed}: ${m.role}` })),
  ];
  return { compatible: migration.length === 0 && runs.data_source !== "NOT_FOUND" && ledger.data_source !== "NOT_FOUND", runs, ledger, migration };
}

/** PURE fixture migration: returns a new REST-shaped data-source schema object with the required properties added. Never touches Notion. */
export function migrateFixtureSchema(schema: { readonly properties?: Readonly<Record<string, { readonly type?: string }>> }, required: readonly RequiredProperty[]): { properties: Record<string, { type: string }> } {
  const properties: Record<string, { type: string }> = Object.fromEntries(Object.entries(schema.properties ?? {}).map(([k, v]) => [k, { type: v.type ?? "unknown" }]));
  for (const r of required) if (!(r.name in properties) || !typeOk(r.type, properties[r.name]?.type ?? "")) properties[r.name] = { type: r.type };
  return { properties };
}
