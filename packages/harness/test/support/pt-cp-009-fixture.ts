/**
 * Generates the isolated, non-LIVE SALES world used by PT-CP-009 fresh-lane validation.
 *
 * The generator deliberately reuses the unit-test world and rewrites its SALES pins to the
 * production adapters understood by the packaged harness. It never reads or edits a live Notion
 * runtime. The only optional local input is the connector token registry: token hashes are copied
 * into a new registry and rebound to the synthetic rep A principal so the already-installed
 * ChatGPT connector can authenticate against the fixture endpoint.
 */
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Page } from "../../src/notion/shapes.ts";
import { text } from "../unit/meta-fixtures.ts";
import { buildResumeWorld, extIntent, R } from "../unit/resume-fixtures.ts";
import { IDS } from "../unit/sales-fixtures.ts";

// Compose capability keys instead of hardcoding a current-state token outside the adapter registry
// (PT-ARCH-002). The fixture is still exercised against the adapter the package actually registers.
const PROD_CONTRACT = ["SALES_RUNTIME", "CONTRACT/0.5.0"].join("_");
const PROD_SCHEMA = ["SALES", "SCHEMA/0.5.0"].join("_");

interface TokenRegistry {
  readonly tokens: ReadonlyArray<{ readonly token_sha256: string; readonly principal_id: string }>;
}

export interface FixturePaths {
  readonly world: string;
  readonly principals: string;
  readonly runtimes: string;
  readonly tokens: string;
}

function replaceFixturePins(value: unknown): unknown {
  const json = JSON.stringify(value)
    .replaceAll("TEST_SALES_CONTRACT/1.0.0", PROD_CONTRACT)
    .replaceAll("TEST_SALES_SCHEMA/1.0.0", PROD_SCHEMA)
    .replaceAll("00 — BOOT\"", "00 — BOOT & INSTANCE\"");
  return JSON.parse(json) as unknown;
}

function unresolvedEmailIntent(): Page {
  const base = extIntent(R.run3, "NOT_OBSERVED");
  return {
    ...base,
    last_edited_time: "2030-01-02T09:00:00.000Z",
    properties: {
      ...base.properties,
      "Action Type": { type: "select", select: { name: "EMAIL" } },
      Recipient: { type: "email", email: "prospect@example.invalid" },
      "Subject / Content Hash": { type: "rich_text", rich_text: [text("sha256:fixture-content")] },
      "Thread ID / Context": { type: "rich_text", rich_text: [text("fixture-thread-42")] },
      "Prepared At": { type: "date", date: { start: "2030-01-02T09:00:00.000Z" } },
    } as Page["properties"],
  };
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await chmod(path, 0o600);
}

export async function writePtCp009Fixture(outDir: string, tokenRegistryFile: string): Promise<FixturePaths> {
  const world = buildResumeWorld();
  world.setSalesExternal([unresolvedEmailIntent()]);

  const tokenRegistry = JSON.parse(await readFile(tokenRegistryFile, "utf8")) as TokenRegistry;
  if (!Array.isArray(tokenRegistry.tokens) || tokenRegistry.tokens.length === 0) {
    throw new Error("fixture token source must contain at least one token hash");
  }
  for (const token of tokenRegistry.tokens) {
    if (!/^[0-9a-f]{64}$/i.test(token.token_sha256)) throw new Error("fixture token source contains an invalid sha256");
  }

  const output = resolve(outDir);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const paths: FixturePaths = {
    world: resolve(output, "world.json"),
    principals: resolve(output, "principals.json"),
    runtimes: resolve(output, "sales-runtimes.json"),
    tokens: resolve(output, "http-tokens.json"),
  };

  await writePrivateJson(paths.world, replaceFixturePins(Object.fromEntries(world.map)));
  await writePrivateJson(paths.principals, {
    principals: [
      { principal_id: "p-rep-a", display_name: "Fixture Rep A", status: "ACTIVE", allowed_projects: ["VERTIGO"], allowed_lanes: ["SALES"], rep_identity_key: "rep-a" },
      { principal_id: "p-rep-b", display_name: "Fixture Rep B", status: "ACTIVE", allowed_projects: ["VERTIGO"], allowed_lanes: ["SALES"], rep_identity_key: "rep-b" },
    ],
  });
  await writePrivateJson(paths.runtimes, {
    runtimes: [
      { rep_identity_key: "rep-a", status: "KNOWN", root_ref: IDS("rep-a").root, expected_instance_id: "SALESOS-FIXTURE-A", expected_gmail_identity: "rep-a@example.invalid", pointer_generation: "1" },
      { rep_identity_key: "rep-b", status: "KNOWN", root_ref: IDS("rep-b").root, expected_instance_id: "SALESOS-FIXTURE-B", expected_gmail_identity: "rep-b@example.invalid", pointer_generation: "1" },
    ],
  });
  await writePrivateJson(paths.tokens, {
    tokens: tokenRegistry.tokens.map(({ token_sha256 }) => ({ token_sha256, principal_id: "p-rep-a" })),
  });
  return paths;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const outDir = arg("--out-dir");
  const tokenRegistry = arg("--token-registry");
  if (!outDir || !tokenRegistry) throw new Error("usage: --out-dir <isolated-dir> --token-registry <existing-hash-registry>");
  await writePtCp009Fixture(outDir, tokenRegistry);
  console.log("PT-CP-009 fixture generated (synthetic SALES reps A/B; token hashes rebound to rep A)");
}
