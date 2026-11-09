/**
 * REST-shaped Personal SALES runtime fixtures. Two reps (A, B) with their own roots, a master template,
 * and a published contract page. All ids/versions are synthetic (derived at import time).
 */
import type { Principal } from "../../src/auth/principal.ts";
import { FixtureNotionReadClient } from "../../src/notion/readClient.ts";
import type { Block, Page, RichText } from "../../src/notion/shapes.ts";
import { InMemorySalesRuntimeRegistry, type SalesRuntimeEntry } from "../../src/registry/salesRuntimes.ts";
import { SalesRuntimeResolver } from "../../src/resolvers/sales.ts";
import { salesContractAdapter, type SalesAddressingGrammar } from "../../src/versions/adapters/sales.ts";
import { SALES_CONTROL_PLANE_05 } from "../../src/versions/adapters/controlPlane.ts";
import { createAdapterRegistries, type AdapterRegistries } from "../../src/versions/registry.ts";
import { synthetic, text, mention, childPage } from "./meta-fixtures.ts";

export const SV: { contract: string; schema: string; contractNext: string } = { contract: "TEST_SALES_CONTRACT/1.0.0", schema: "TEST_SALES_SCHEMA/1.0.0", contractNext: "TEST_SALES_CONTRACT/2.0.0" };

export const SGRAMMAR: SalesAddressingGrammar = {
  bootTitle: "00 — BOOT",
  manifestDatabaseTitle: "Instance Manifest",
  currentRowTitle: "CURRENT",
  manifestProps: { title: "Name", rootUrl: "Root URL", instanceId: "Instance ID", owner: "Owner", gmailIdentity: "Gmail Identity", installState: "Install State", instanceStatus: "Instance Status", contractVersion: "Sales Contract Version", contractUrl: "Sales Contract URL", schemaVersion: "Schema Version", strategyVersion: "Strategy Version", toolkitVersion: "Toolkit Version", authorityVersion: "Authority Version", lastRunRef: "Last Run Ref" },
  template: { instanceIdPattern: /^TEMPLATE\b/i, rootTitlePattern: /\bTEMPLATE\b/i, unboundInstallState: "UNBOUND" },
  retiredInstanceStatus: "RETIRED",
  controlPlane: SALES_CONTROL_PLANE_05,
};

export const REP_A: Principal = { principal_id: "p-rep-a", display_name: "Rep A", status: "ACTIVE", allowed_projects: ["VERTIGO"], allowed_lanes: ["SALES"], rep_identity_key: "rep-a" };
export const REP_B: Principal = { principal_id: "p-rep-b", display_name: "Rep A", status: "ACTIVE", allowed_projects: ["VERTIGO"], allowed_lanes: ["SALES"], rep_identity_key: "rep-b" };
export const REP_C: Principal = { principal_id: "p-rep-c", status: "ACTIVE", allowed_projects: ["VERTIGO"], allowed_lanes: ["SALES"], rep_identity_key: "rep-c" };
export const REP_NOKEY: Principal = { principal_id: "p-rep-nokey", status: "ACTIVE", allowed_projects: ["VERTIGO"], allowed_lanes: ["SALES"] };

export interface RuntimeSpec {
  key: string; // rep key or "template"
  rootTitle: string;
  instanceId: string;
  owner: string;
  gmail: string;
  installState?: string;
  instanceStatus?: string;
  contract?: string;
  schema?: string;
  rootUrlOverride?: string;
  lastRunId?: string;
  archivedRoot?: boolean;
  duplicateCurrent?: boolean;
}

export const IDS = (key: string) => ({
  root: synthetic(`sales-root-${key}`),
  boot: synthetic(`sales-boot-${key}`),
  manifestDb: synthetic(`sales-manifest-db-${key}`),
  manifestDs: synthetic(`sales-manifest-ds-${key}`),
  manifestRow: synthetic(`sales-manifest-row-${key}`),
  manifestRow2: synthetic(`sales-manifest-row2-${key}`),
});
export const CONTRACT_PAGE = synthetic("sales-contract-page");

function rt(s: string): RichText[] { return [text(s)]; }

export function manifestRow(id: string, spec: RuntimeSpec, ids: ReturnType<typeof IDS>): Page {
  return {
    object: "page", id, archived: false, last_edited_time: "2030-01-01T00:00:00.000Z",
    properties: {
      Name: { type: "title", title: rt("CURRENT") },
      "Root URL": { type: "url", url: `https://example.invalid/p/${spec.rootUrlOverride ?? ids.root}` },
      "Instance ID": { type: "rich_text", rich_text: rt(spec.instanceId) },
      Owner: { type: "rich_text", rich_text: rt(spec.owner) },
      "Gmail Identity": { type: "email", email: spec.gmail || null },
      "Install State": { type: "select", select: spec.installState ? { name: spec.installState } : null },
      "Instance Status": { type: "select", select: { name: spec.instanceStatus ?? "ACTIVE" } },
      "Sales Contract Version": { type: "rich_text", rich_text: rt(spec.contract ?? SV.contract) },
      "Sales Contract URL": { type: "url", url: `https://example.invalid/p/${CONTRACT_PAGE}` },
      "Schema Version": { type: "rich_text", rich_text: rt(spec.schema ?? SV.schema) },
      "Strategy Version": { type: "rich_text", rich_text: [] },
      "Toolkit Version": { type: "rich_text", rich_text: [] },
      "Authority Version": { type: "rich_text", rich_text: [] },
      "Last Run Ref": { type: "rich_text", rich_text: spec.lastRunId ? [text("RUN-1 | "), mention(spec.lastRunId)] : [] },
    },
  };
}

export function installRuntime(m: Map<string, unknown>, spec: RuntimeSpec): ReturnType<typeof IDS> {
  const ids = IDS(spec.key);
  const list = (blocks: Block[]) => ({ results: blocks, has_more: false, next_cursor: null });
  m.set(`page:${ids.root}`, { object: "page", id: ids.root, archived: spec.archivedRoot ?? false, properties: { title: { type: "title", title: rt(spec.rootTitle) } } });
  m.set(`children:${ids.root}`, list([childPage(synthetic(`read-first-${spec.key}`), "00 — READ FIRST"), childPage(ids.boot, SGRAMMAR.bootTitle), childPage(synthetic(`control-${spec.key}`), "03 — CONTROL PLANE")]));
  m.set(`children:${ids.boot}`, list([{ id: synthetic(`bootcard-${spec.key}`), type: "child_page", child_page: { title: "00A — BOOT CARD" } }, { id: ids.manifestDb, type: "child_database", child_database: { title: SGRAMMAR.manifestDatabaseTitle } }, { id: synthetic(`registry-${spec.key}`), type: "child_database", child_database: { title: "Registry" } }]));
  m.set(`database:${ids.manifestDb}`, { object: "database", id: ids.manifestDb, title: rt(SGRAMMAR.manifestDatabaseTitle), data_sources: [{ id: ids.manifestDs, name: SGRAMMAR.manifestDatabaseTitle }] });
  const rows: Page[] = [manifestRow(ids.manifestRow, spec, ids)];
  if (spec.duplicateCurrent) rows.push(manifestRow(ids.manifestRow2, spec, ids));
  m.set(`query:${ids.manifestDs}`, { results: rows });
  for (const r of rows) m.set(`page:${r.id}`, r);
  return ids;
}

export function repA(over: Partial<RuntimeSpec> = {}): RuntimeSpec {
  return { key: "rep-a", rootTitle: "REP A - SALES AGENT OS", instanceId: "SALESOS-FIXTURE-A", owner: "Rep A", gmail: "rep-a@example.invalid", installState: "SETUP", ...over };
}
export function repB(over: Partial<RuntimeSpec> = {}): RuntimeSpec {
  return { key: "rep-b", rootTitle: "REP B - SALES AGENT OS", instanceId: "SALESOS-FIXTURE-B", owner: "Rep A", gmail: "rep-b@example.invalid", installState: "READY", ...over };
}
export function templateSpec(over: Partial<RuntimeSpec> = {}): RuntimeSpec {
  return { key: "template", rootTitle: "SALES AGENT OS — MASTER TEMPLATE", instanceId: "TEMPLATE-UNBOUND", owner: "", gmail: "", installState: "UNBOUND", ...over };
}

export function buildSalesClient(specs: RuntimeSpec[], extra: (m: Map<string, unknown>) => void = () => {}): FixtureNotionReadClient {
  const m = new Map<string, unknown>();
  for (const s of specs) installRuntime(m, s);
  m.set(`page:${CONTRACT_PAGE}`, { object: "page", id: CONTRACT_PAGE, archived: false, properties: { title: { type: "title", title: rt(SV.contract) } } });
  extra(m);
  return new FixtureNotionReadClient(m);
}

export function registryEntries(): SalesRuntimeEntry[] {
  return [
    { rep_identity_key: "rep-a", status: "KNOWN", root_ref: IDS("rep-a").root, expected_instance_id: "SALESOS-FIXTURE-A", expected_gmail_identity: "rep-a@example.invalid", pointer_generation: "1" },
    { rep_identity_key: "rep-b", status: "KNOWN", root_ref: IDS("rep-b").root, expected_instance_id: "SALESOS-FIXTURE-B", expected_gmail_identity: "rep-b@example.invalid", pointer_generation: "1" },
    { rep_identity_key: "rep-c", status: "NOT_YET_CREATED", note: "creation scheduled" },
  ];
}

export function salesRegistries(contracts: string[] = [SV.contract]): AdapterRegistries {
  const r = createAdapterRegistries();
  for (const c of contracts) r.salesRuntime.register(c, salesContractAdapter(c, [SV.schema], SGRAMMAR));
  return r;
}

export function salesResolver(principal: Principal, client: FixtureNotionReadClient, entries: SalesRuntimeEntry[] = registryEntries(), contracts?: string[]): SalesRuntimeResolver {
  return new SalesRuntimeResolver(client, principal, "TESTPROJ", new InMemorySalesRuntimeRegistry(entries), salesRegistries(contracts).salesRuntime);
}
