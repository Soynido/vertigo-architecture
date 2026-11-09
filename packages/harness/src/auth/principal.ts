import { readFile } from "node:fs/promises";
import type { Lane } from "../tools/envelope.ts";

/** Authenticated principal. Names are presentation only; authorization uses principal_id. */
export interface Principal {
  readonly principal_id: string;
  readonly status: "ACTIVE" | "SUSPENDED" | "REVOKED";
  readonly allowed_projects: readonly string[];
  readonly allowed_lanes: readonly Lane[];
  readonly rep_identity_key?: string;
  readonly meta_authority?: string;
  readonly display_name?: string;
}

export interface PrincipalRegistry {
  get(principalId: string): Promise<Principal | undefined>;
}

export type AuthorizationResult =
  | { readonly ok: true; readonly principal: Principal }
  | { readonly ok: false; readonly reason: "AUTH_REQUIRED" | "PROJECT_UNKNOWN" | "UNAUTHORIZED_LANE" | "PRINCIPAL_INACTIVE" };

/** Deterministic authorization: identity comes from the backend's authenticated principal, never from tool arguments. */
export async function authorize(registry: PrincipalRegistry, principalId: string | undefined, project: string, lane: Lane): Promise<AuthorizationResult> {
  if (!principalId) return { ok: false, reason: "AUTH_REQUIRED" };
  const principal = await registry.get(principalId);
  if (!principal) return { ok: false, reason: "AUTH_REQUIRED" };
  if (principal.status !== "ACTIVE") return { ok: false, reason: "PRINCIPAL_INACTIVE" };
  if (!principal.allowed_projects.includes(project)) return { ok: false, reason: "PROJECT_UNKNOWN" };
  if (!principal.allowed_lanes.includes(lane)) return { ok: false, reason: "UNAUTHORIZED_LANE" };
  return { ok: true, principal };
}

/**
 * File-backed registry (deployment config, never source code).
 *
 * Fresh-read on EVERY lookup, exactly like the SALES runtime registry. A process-lifetime cache would keep a
 * suspended or revoked principal authorized, and would keep a stale rep_identity_key / display_name in force
 * after a provisioning change, until someone remembered to restart the harness.
 */
export class FilePrincipalRegistry implements PrincipalRegistry {
  readonly #path: string;
  constructor(path: string) {
    this.#path = path;
  }
  async get(principalId: string): Promise<Principal | undefined> {
    const raw = JSON.parse(await readFile(this.#path, "utf8")) as { principals: Principal[] };
    return raw.principals.find((p) => p.principal_id === principalId);
  }
}

export class InMemoryPrincipalRegistry implements PrincipalRegistry {
  readonly #byId: Map<string, Principal>;
  constructor(principals: readonly Principal[]) {
    this.#byId = new Map(principals.map((p) => [p.principal_id, p]));
  }
  async get(principalId: string): Promise<Principal | undefined> {
    return this.#byId.get(principalId);
  }
}
