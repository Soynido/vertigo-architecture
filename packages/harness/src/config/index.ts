/**
 * Configuration contract (docs/CONFIGURATION.md).
 *
 * The only stable runtime bootstrap pointer is VERTIGO_META_SPEC_ROOT (PDEC-008). Everything below it
 * — locator, META root, Manifest, Runs, Gates, versions, SALES roots — is discovered at call time.
 * Callers (LLM tool arguments) can never override any value here.
 */

/**
 * Loaded discriminant. The canonical HARNESS_ENV value is now `live`; `live_readonly` is its deprecated alias for
 * one release (W3.5a). Both load as the legacy discriminant "live_readonly" for that release so no runtime consumer
 * changes with this config cutover; the value no longer implies that every Notion access is read-only.
 */
export type HarnessEnv = "fixture" | "live_readonly";

export interface HarnessConfig {
  readonly metaSpecRoot: string;
  /**
   * Resolved Notion token: NOTION_TOKEN (canonical) or NOTION_READ_TOKEN (deprecated alias, one release). The field
   * keeps its legacy name for that release; it does not assert that the token or the process is read-only.
   */
  readonly notionReadToken: string | undefined;
  readonly databaseUrl: string | undefined;
  readonly harnessEnv: HarnessEnv;
  readonly principalsFile: string;
  /** Backend SALES runtime registry (discovery only). Optional: absent ⇒ every SALES lookup is UNKNOWN. */
  readonly salesRuntimeRegistryFile: string | undefined;
  /** Serialized fixture Notion world (PV0-024F). Accepted ONLY when harnessEnv is "fixture"; a live deployment refuses it. */
  readonly fixtureWorldFile: string | undefined;
  /** Owner-approved EXTERNAL_ACTION_TEST scope (deployment config, never caller input): the only sender / recipients a native Gmail test send may use. */
  readonly externalActionTestScope: { readonly from: string; readonly to: readonly string[] } | undefined;
  /** MCP transport for the packaged server: stdio (local dev) or http (remote MCP endpoint for ChatGPT). */
  readonly transport: "stdio" | "http";
  readonly httpHost: string;
  readonly httpPort: number;
  /** JSON file mapping sha256(bearer token) → principal_id; the transport supplies the principal, never the caller. */
  readonly httpTokensFile: string | undefined;
  /** False once every application authenticates with a header: the /mcp/<token> fallback is then refused. */
  readonly allowPathToken: boolean;
  /** Exact source revision served by a remote live deployment. Mandatory for live HTTP; never inferred by the process. */
  readonly buildRevision: string | undefined;
  /** Whether that exact revision was served with uncommitted files. Mandatory for live HTTP. */
  readonly buildDirty: boolean | undefined;
  /** SHA-256 of the deployment configuration material. It is an attestation, never a secret or a config value. */
  readonly configFingerprint: string | undefined;
  readonly bindingTtlHours: number;
  readonly planTtlMinutes: number;
  readonly targetReceiptTtlMinutes: number;
  /** PV-WRITE-001 D12: the most mutations one user intent may carry in one commit (HARNESS_COMMIT_MAX_OPS, default 25). */
  readonly commitMaxOps: number;
  /** Deployment-only single-principal pilot; never an LLM tool argument or mutation authority. Empty = disabled. */
  readonly metaRecoveryStatusPrincipalIds: readonly string[];
  /** Owner-only native note pilot profile; absent disables it. No caller-supplied authority. */
  readonly nativeNotePilotFile?: string;
  /** Optional same-owner synthetic direction control; never enabled for other principals. */
  readonly nativeDirectionPilotFile?: string;
  /** Optional read-only real META profile for the same private owner. Never a Sales install prerequisite. */
  readonly nativeMetaProfileFile?: string;
  /** Explicit single seller native observer; absent preserves the existing surface. Never a write permission. */
  readonly nativeSalesProfileFile?: string;
  /** Bounded opt-in additional seller profiles; invalid additions never replace the primary seller. */
  readonly nativeSalesAdditionalProfilesFile?: string;
  /** Optional real META-to-SALES direction; exact existing profiles must agree. No default activation. */
  readonly nativeRealDirectionProfileFile?: string;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key]?.trim();
  if (!v) throw new ConfigError(`missing required configuration ${key}`);
  return v;
}

function positiveNumber(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new ConfigError(`${key} must be a positive number`);
  return n;
}

function positiveInteger(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const n = positiveNumber(env, key, fallback);
  if (!Number.isInteger(n)) throw new ConfigError(`${key} must be a positive integer`);
  return n;
}

function optionalBoolean(env: NodeJS.ProcessEnv, key: string): boolean | undefined {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new ConfigError(`${key} must be true or false`);
}

function metaStatusPilot(env: NodeJS.ProcessEnv): readonly string[] {
  const raw = env["HARNESS_META_RECOVERY_STATUS_PRINCIPALS"];
  if (raw === undefined || raw === "") return [];
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new ConfigError("HARNESS_META_RECOVERY_STATUS_PRINCIPALS must be a JSON array"); }
  if (!Array.isArray(value) || value.length > 1 || value.some(p => typeof p !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(p)))
    throw new ConfigError("HARNESS_META_RECOVERY_STATUS_PRINCIPALS permits at most one exact principal");
  return Object.freeze([...value]) as readonly string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HarnessConfig {
  const harnessEnvRaw = required(env, "HARNESS_ENV");
  if (harnessEnvRaw !== "fixture" && harnessEnvRaw !== "live" && harnessEnvRaw !== "live_readonly") {
    throw new ConfigError(`HARNESS_ENV must be "fixture" or "live" (deprecated alias "live_readonly"), got "${harnessEnvRaw}"`);
  }
  const harnessEnv: HarnessEnv = harnessEnvRaw === "fixture" ? "fixture" : "live_readonly";
  const live = harnessEnv !== "fixture";
  // W3.5a: NOTION_TOKEN is canonical, NOTION_READ_TOKEN is accepted for one release. When both are present and
  // differ, the loader refuses: it never silently selects which credential is the Notion authority.
  const notionToken = env["NOTION_TOKEN"]?.trim() || undefined;
  const legacyNotionToken = env["NOTION_READ_TOKEN"]?.trim() || undefined;
  if (notionToken && legacyNotionToken && notionToken !== legacyNotionToken) {
    throw new ConfigError("NOTION_TOKEN and NOTION_READ_TOKEN are both set and differ; set only NOTION_TOKEN");
  }
  const notionReadToken = notionToken ?? legacyNotionToken;
  if (live && !notionReadToken) {
    throw new ConfigError("NOTION_TOKEN is required when HARNESS_ENV=live (NOTION_READ_TOKEN accepted for one release)");
  }
  // PV0-024F: a serialized fixture world may never be loaded by a live deployment. Fail closed, never ignore.
  const fixtureWorldFile = env["HARNESS_FIXTURE_WORLD_FILE"]?.trim() || undefined;
  if (fixtureWorldFile && live) {
    throw new ConfigError("HARNESS_FIXTURE_WORLD_FILE is only accepted when HARNESS_ENV=fixture");
  }
  const transportRaw = env["HARNESS_TRANSPORT"]?.trim() || "stdio";
  if (transportRaw !== "stdio" && transportRaw !== "http") throw new ConfigError(`HARNESS_TRANSPORT must be "stdio" or "http", got "${transportRaw}"`);
  const httpTokensFile = env["HARNESS_HTTP_TOKENS_FILE"]?.trim() || undefined;
  if (transportRaw === "http" && !httpTokensFile) throw new ConfigError("HARNESS_HTTP_TOKENS_FILE is required when HARNESS_TRANSPORT=http");
  // A token in the URL path makes the URL itself the credential (PV-CRED-001). It stays available for connector
  // UIs with no authentication field, and a deployment turns it off once every application sends a header.
  const allowPathToken = optionalBoolean(env, "HARNESS_ALLOW_PATH_TOKEN") ?? true;
  const buildRevision = env["HARNESS_BUILD_REVISION"]?.trim().toLowerCase() || undefined;
  const buildDirty = optionalBoolean(env, "HARNESS_BUILD_DIRTY");
  const configFingerprint = env["HARNESS_CONFIG_FINGERPRINT"]?.trim().toLowerCase() || undefined;
  if (buildRevision && !/^[0-9a-f]{40}$/.test(buildRevision)) throw new ConfigError("HARNESS_BUILD_REVISION must be the exact 40-hex git revision");
  if (configFingerprint && !/^[0-9a-f]{64}$/.test(configFingerprint)) throw new ConfigError("HARNESS_CONFIG_FINGERPRINT must be a 64-hex SHA-256 digest");
  if (live && transportRaw === "http") {
    if (!buildRevision) throw new ConfigError("HARNESS_BUILD_REVISION is required for live HTTP serving");
    if (buildDirty === undefined) throw new ConfigError("HARNESS_BUILD_DIRTY is required for live HTTP serving");
    if (!configFingerprint) throw new ConfigError("HARNESS_CONFIG_FINGERPRINT is required for live HTTP serving");
  }
  return {
    metaSpecRoot: required(env, "VERTIGO_META_SPEC_ROOT"),
    transport: transportRaw,
    httpHost: env["HARNESS_HTTP_HOST"]?.trim() || "127.0.0.1",
    httpPort: positiveNumber(env, "HARNESS_HTTP_PORT", 8787),
    httpTokensFile,
    allowPathToken,
    buildRevision,
    buildDirty,
    configFingerprint,
    notionReadToken,
    databaseUrl: env["DATABASE_URL"]?.trim() || undefined,
    harnessEnv,
    principalsFile: required(env, "PRINCIPALS_FILE"),
    salesRuntimeRegistryFile: env["SALES_RUNTIME_REGISTRY_FILE"]?.trim() || undefined,
    fixtureWorldFile,
    externalActionTestScope: env["EXTERNAL_ACTION_TEST_FROM"]?.trim() && env["EXTERNAL_ACTION_TEST_TO"]?.trim()
      ? { from: (env["EXTERNAL_ACTION_TEST_FROM"] as string).trim().toLowerCase(), to: (env["EXTERNAL_ACTION_TEST_TO"] as string).split(",").map((x) => x.trim().toLowerCase()).filter(Boolean) }
      : undefined,
    bindingTtlHours: positiveNumber(env, "BINDING_TTL_HOURS", 24),
    planTtlMinutes: positiveNumber(env, "PLAN_TTL_MINUTES", 15),
    targetReceiptTtlMinutes: positiveNumber(env, "TARGET_RECEIPT_TTL_MINUTES", 10),
    commitMaxOps: positiveInteger(env, "HARNESS_COMMIT_MAX_OPS", 25),
    metaRecoveryStatusPrincipalIds: metaStatusPilot(env),
    ...(env["HARNESS_NATIVE_NOTE_PILOT_FILE"]?.trim() ? { nativeNotePilotFile: env["HARNESS_NATIVE_NOTE_PILOT_FILE"].trim() } : {}),
    ...(env["HARNESS_NATIVE_DIRECTION_PILOT_FILE"]?.trim() ? { nativeDirectionPilotFile: env["HARNESS_NATIVE_DIRECTION_PILOT_FILE"].trim() } : {}),
    ...(env["HARNESS_NATIVE_META_PROFILE_FILE"]?.trim() ? { nativeMetaProfileFile: env["HARNESS_NATIVE_META_PROFILE_FILE"].trim() } : {}),
    ...(env["HARNESS_NATIVE_SALES_PROFILE_FILE"]?.trim() ? { nativeSalesProfileFile: env["HARNESS_NATIVE_SALES_PROFILE_FILE"].trim() } : {}),
    ...(env["HARNESS_NATIVE_SALES_ADDITIONAL_PROFILES_FILE"]?.trim() ? { nativeSalesAdditionalProfilesFile: env["HARNESS_NATIVE_SALES_ADDITIONAL_PROFILES_FILE"].trim() } : {}),
    ...(env["HARNESS_NATIVE_REAL_DIRECTION_PROFILE_FILE"]?.trim() ? { nativeRealDirectionProfileFile: env["HARNESS_NATIVE_REAL_DIRECTION_PROFILE_FILE"].trim() } : {}),
  };
}
