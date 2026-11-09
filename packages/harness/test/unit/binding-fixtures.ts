/**
 * Combined META + SALES fixture world for binding tests. The underlying map is mutable so a test can
 * rotate the META locator (pointer generation / root) or a SALES registry pointer between calls.
 */
import { InMemoryPrincipalRegistry, type Principal } from "../../src/auth/principal.ts";
import { loadConfig } from "../../src/config/index.ts";
import { FixtureNotionReadClient } from "../../src/notion/readClient.ts";
import { InMemorySalesRuntimeRegistry, type SalesRuntimeEntry } from "../../src/registry/salesRuntimes.ts";
import { createMemoryStore } from "../../src/store/memory.ts";
import type { HarnessDeps } from "../../src/tools/handlers.ts";
import { metaSpecAdapter } from "../../src/versions/adapters/meta.ts";
import { salesContractAdapter } from "../../src/versions/adapters/sales.ts";
import { controlSpecAdapter } from "../../src/versions/adapters/control.ts";
import { createAdapterRegistries } from "../../src/versions/registry.ts";
import { GRAMMAR as META_GRAMMAR, ID as META_ID, locatorChildren, manifestPage, rootPage, runPage, specRootChildren, V as MV, type LocatorOptions } from "./meta-fixtures.ts";
import { installRuntime, repA, repB, registryEntries, CONTRACT_PAGE, SGRAMMAR, SV, type RuntimeSpec } from "./sales-fixtures.ts";
import { text } from "./meta-fixtures.ts";

export const OWNER: Principal = { principal_id: "p-owner", display_name: "Owner", status: "ACTIVE", allowed_projects: ["VERTIGO"], allowed_lanes: ["META", "SALES"], rep_identity_key: "rep-a", meta_authority: "COMPANY_OWNER" };
export const REP_B: Principal = { principal_id: "p-rep-b", display_name: "Rep B", status: "ACTIVE", allowed_projects: ["VERTIGO"], allowed_lanes: ["SALES"], rep_identity_key: "rep-b" };

export interface World {
  readonly map: Map<string, unknown>;
  readonly deps: HarnessDeps;
  /** Rotate the META runtime: new locator pointer generation and/or root. */
  rotateMeta(opts: LocatorOptions): void;
  /** Swap the principal registry (e.g. to suspend a principal). */
  setPrincipals(principals: Principal[]): void;
  /** Replace the SALES registry entries (e.g. bump pointer generation). */
  setSalesRegistry(entries: SalesRuntimeEntry[]): void;
}

export function buildWorld(now = new Date("2030-01-01T00:00:00.000Z")): World {
  const map = new Map<string, unknown>();
  const list = (blocks: unknown[]) => ({ results: blocks, has_more: false, next_cursor: null });
  // META
  map.set(`children:${META_ID.specRoot}`, list(specRootChildren()));
  map.set(`children:${META_ID.locator}`, list(locatorChildren()));
  map.set(`page:${META_ID.manifest}`, manifestPage());
  map.set(`page:${META_ID.rootA}`, rootPage(META_ID.rootA));
  map.set(`page:${META_ID.rootB}`, rootPage(META_ID.rootB));
  map.set(`page:${META_ID.runOld}`, runPage(META_ID.runOld, { spec: MV.specA, schema: MV.schema, control: MV.controlA }));
  // SALES (reps A and B)
  installRuntime(map, repA());
  installRuntime(map, repB());
  map.set(`page:${CONTRACT_PAGE}`, { object: "page", id: CONTRACT_PAGE, archived: false, properties: { title: { type: "title", title: [text(SV.contract)] } } });

  const adapters = createAdapterRegistries();
  adapters.metaRuntime.register(MV.specA, metaSpecAdapter(MV.specA, [MV.schema], META_GRAMMAR));
  adapters.salesRuntime.register(SV.contract, salesContractAdapter(SV.contract, [SV.schema], SGRAMMAR));
  // CONTROL adapters for the TEST_CONTROL family: 1.0 needs an independent proof, 1.1 permits read-only recomputation.
  adapters.control.register(MV.controlA, controlSpecAdapter({ version: MV.controlA, mode: "INDEPENDENT_PROOF", controlConfirmedGates: ["T0", "T8"], requiredSources: ["MANIFEST", "RUNS", "LEDGER", "GATES", "CONTROL_CHECKS"], controlInvariants: ["RUN_RECOVERY", "GATE_PROOF", "MUTATION_CLEAN", "INHERITED_HISTORY", "ATTEMPT_IDENTITY", "VERSION_PIN", "CONTROL_REPORT_TAMPER"], note: "test proof line" }));
  adapters.control.register(MV.controlB, controlSpecAdapter({ version: MV.controlB, mode: "OPERATIONAL_RECOMPUTE", controlConfirmedGates: ["T8"], requiredSources: ["MANIFEST", "RUNS", "LEDGER", "GATES"], controlInvariants: ["RUN_RECOVERY", "GATE_PROOF", "MUTATION_CLEAN", "INHERITED_HISTORY", "ATTEMPT_IDENTITY", "VERSION_PIN"], note: "test recompute line" }));

  const state = { principals: new InMemoryPrincipalRegistry([OWNER, REP_B]), sales: new InMemorySalesRuntimeRegistry(registryEntries()) };
  const deps: HarnessDeps = {
    config: loadConfig({ VERTIGO_META_SPEC_ROOT: `https://example.invalid/p/${META_ID.specRoot}`, HARNESS_ENV: "fixture", PRINCIPALS_FILE: "fixture" }),
    principals: { get: (id) => state.principals.get(id) },
    store: createMemoryStore(),
    notion: new FixtureNotionReadClient(map),
    adapters,
    salesRegistry: { lookup: (k) => state.sales.lookup(k), activateInstallation: (expected, proof) => state.sales.activateInstallation(expected, proof) },
  };
  void now;
  installControlPlanes(map);
  return {
    map,
    deps,
    rotateMeta(opts) {
      map.set(`children:${META_ID.locator}`, list(locatorChildren(opts)));
      if (opts.rootId) map.set(`page:${META_ID.manifest}`, manifestPage({ rootId: opts.rootId }));
    },
    setPrincipals(principals) { state.principals = new InMemoryPrincipalRegistry(principals); },
    setSalesRegistry(entries) { state.sales = new InMemorySalesRuntimeRegistry(entries); },
  };
}

export const T0 = new Date("2030-01-01T00:00:00.000Z");
export function at(hours: number): Date { return new Date(T0.getTime() + hours * 3600 * 1000); }
export type { RuntimeSpec };

import type { Envelope } from "../../src/tools/envelope.ts";
import { installControlPlanes } from "./resume-fixtures.ts";
/** Extracts the handle from a BOUND envelope (throws otherwise). */
export function handleOf(e: Envelope): string {
  if (e.status !== "OK" || e.code !== "BOUND") throw new Error(`expected BOUND, got ${e.status} ${e.code}`);
  return (e.result as { binding_handle: string }).binding_handle;
}
