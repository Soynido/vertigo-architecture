/**
 * Runtime scope (PV0-020C): a FIXTURE/test runtime must never be presented as evidence that live company data is
 * absent. Deployment may force the scope (HARNESS_RUNTIME_SCOPE=FIXTURE|LIVE); otherwise a runtime whose id carries
 * a FIXTURE/TEST marker is a fixture. No identity of a person or a runtime is ever hardcoded here.
 */
export type RuntimeScope = "FIXTURE" | "LIVE";

export function runtimeScope(runtimeId: string | undefined, env: NodeJS.ProcessEnv = process.env): RuntimeScope {
  const forced = env["HARNESS_RUNTIME_SCOPE"]?.trim().toUpperCase();
  if (forced === "FIXTURE" || forced === "LIVE") return forced;
  return typeof runtimeId === "string" && /(^|[-_])(FIXTURE|TEST)([-_]|$)/i.test(runtimeId) ? "FIXTURE" : "LIVE";
}
