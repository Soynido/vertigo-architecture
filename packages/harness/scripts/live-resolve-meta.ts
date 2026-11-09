/**
 * PT-BIND-004 runner (LIVE_READ_ONLY). Provide only the configured SPEC_ROOT and a read-only Notion
 * token; prints the resolver outcome. Usage:
 *   node --env-file=../../.env scripts/live-resolve-meta.ts   (HARNESS_ENV=live_readonly)
 */
import { ConfigError, loadConfig, type HarnessConfig } from "../src/config/index.ts";
import { HttpNotionReadClient } from "../src/notion/readClient.ts";
import { MetaRuntimeResolver } from "../src/resolvers/meta.ts";
import { createAdapterRegistries } from "../src/versions/registry.ts";
import { registerBuiltinMetaAdapters } from "../src/versions/adapters/meta.ts";

let config: HarnessConfig;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`HOLD (HUMAN_ONLY prerequisite): ${err.message}. A live read-only resolution needs HARNESS_ENV=live_readonly and a read-only, least-privilege NOTION_READ_TOKEN.`);
    process.exit(2);
  }
  throw err;
}
if (config.harnessEnv !== "live_readonly" || !config.notionReadToken) {
  console.error("HOLD (HUMAN_ONLY prerequisite): HARNESS_ENV=live_readonly and NOTION_READ_TOKEN are required for a live read-only resolution.");
  process.exit(2);
}
const registries = createAdapterRegistries();
registerBuiltinMetaAdapters(registries.metaRuntime);
const client = new HttpNotionReadClient(config.notionReadToken, (url, init) => fetch(url, init));
const outcome = await new MetaRuntimeResolver(client, config.metaSpecRoot, "VERTIGO", registries.metaRuntime).resolve();
console.log(JSON.stringify({ resolved_at: new Date().toISOString(), outcome }, null, 2));
process.exit(outcome.kind === "RESOLVED" ? 0 : 1);
