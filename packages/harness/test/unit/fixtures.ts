import { InMemoryPrincipalRegistry, type Principal } from "../../src/auth/principal.ts";
import { generateHandle, hashHandle } from "../../src/binding/handle.ts";
import type { BindingRecord } from "../../src/binding/store.ts";
import { loadConfig } from "../../src/config/index.ts";
import { FixtureNotionReadClient } from "../../src/notion/readClient.ts";
import { createMemoryStore } from "../../src/store/memory.ts";
import type { Lane } from "../../src/tools/envelope.ts";
import type { HarnessDeps } from "../../src/tools/handlers.ts";
import { EMPTY_SALES_REGISTRY } from "../../src/registry/salesRuntimes.ts";
import { createAdapterRegistries } from "../../src/versions/registry.ts";

/** Synthetic principals: one META owner and several SALES reps. Names are presentation only. */
export const OWNER: Principal = { principal_id: "p-owner", display_name: "Owner", status: "ACTIVE", allowed_projects: ["VERTIGO"], allowed_lanes: ["META", "SALES"], rep_identity_key: "rep-owner", meta_authority: "COMPANY_OWNER" };
export const REP_A: Principal = { principal_id: "p-rep-a", display_name: "Owner", status: "ACTIVE", allowed_projects: ["VERTIGO"], allowed_lanes: ["SALES"], rep_identity_key: "rep-a" };
export const REP_B: Principal = { principal_id: "p-rep-b", display_name: "Rep B", status: "ACTIVE", allowed_projects: ["VERTIGO"], allowed_lanes: ["SALES"], rep_identity_key: "rep-b" };
export const SUSPENDED: Principal = { principal_id: "p-suspended", status: "SUSPENDED", allowed_projects: ["VERTIGO"], allowed_lanes: ["META", "SALES"] };

export function makeDeps(): HarnessDeps {
  return {
    config: loadConfig({ VERTIGO_META_SPEC_ROOT: "https://example.invalid/spec-root", HARNESS_ENV: "fixture", PRINCIPALS_FILE: "fixture" }),
    principals: new InMemoryPrincipalRegistry([OWNER, REP_A, REP_B, SUSPENDED]),
    store: createMemoryStore(),
    notion: new FixtureNotionReadClient(new Map()),
    adapters: createAdapterRegistries(),
    salesRegistry: EMPTY_SALES_REGISTRY,
  };
}

/** Seed a BOUND binding directly in the store (runtime resolution itself is a later ticket). */
export async function seedBinding(deps: HarnessDeps, principal: Principal, lane: Lane, overrides: Partial<BindingRecord> = {}): Promise<{ handle: string; record: BindingRecord }> {
  const handle = generateHandle();
  const now = new Date();
  const record: BindingRecord = {
    binding_id: `b-${principal.principal_id}-${lane}-${hashHandle(handle).slice(0, 8)}`,
    handle_hash: hashHandle(handle),
    principal_id: principal.principal_id,
    project: "VERTIGO",
    lane,
    runtime_logical_key: `VERTIGO/${lane}/${principal.rep_identity_key ?? "owner"}`,
    runtime_id: `fixture-runtime-${lane.toLowerCase()}-${principal.principal_id}`,
    runtime_generation: `gen-${lane.toLowerCase()}-${principal.principal_id}`,
    resolved_manifest_ref: `fixture-manifest-${principal.principal_id}`,
    governing_versions_snapshot: {},
    status: "BOUND",
    created_at: now,
    expires_at: new Date(now.getTime() + 24 * 3600 * 1000),
    ...overrides,
    binding_mode: overrides.binding_mode ?? "BUSINESS",
    install_phase: overrides.install_phase ?? "NOT_APPLICABLE",
  };
  await deps.store.bindings.insert(record);
  return { handle, record };
}
