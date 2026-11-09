/**
 * PT-RESUME-001 / PT-RESUME-002 runner (COLD_CHAT / LIVE_READ_ONLY). A fresh process with only the
 * configured SPEC_ROOT, a read-only token and the authenticated principal: os_bind then os_resume.
 * Prints the token-free envelopes for comparison with an independent oracle.
 */
import { ConfigError } from "../src/config/index.ts";
import { buildDeps } from "../src/index.ts";
import { dispatch } from "../src/tools/handlers.ts";

let deps;
try {
  deps = buildDeps();
} catch (err) {
  if (err instanceof ConfigError) { console.error(`HOLD (HUMAN_ONLY prerequisite): ${err.message}`); process.exit(2); }
  throw err;
}
if (deps.config.harnessEnv !== "live_readonly") { console.error("HOLD: HARNESS_ENV=live_readonly required"); process.exit(2); }
const principal = process.env["HARNESS_PRINCIPAL_ID"];
const lane = (process.env["HARNESS_LANE"] ?? "META") as "META" | "SALES";
const ctx = { principal_id: principal };
const bind = await dispatch("os_bind", { project: "VERTIGO", lane }, ctx, deps);
const out: Record<string, unknown> = { resolved_at: new Date().toISOString(), lane, bind };
if (bind.status === "OK") {
  const handle = (bind as { result: { binding_handle: string } }).result.binding_handle;
  const resume = await dispatch("os_resume", { binding_handle: handle }, ctx, deps);
  out["resume"] = resume;
  (bind as { result: Record<string, unknown> }).result["binding_handle"] = "<redacted>";
}
console.log(JSON.stringify(out, null, 2));
process.exit(bind.status === "OK" ? 0 : 1);
