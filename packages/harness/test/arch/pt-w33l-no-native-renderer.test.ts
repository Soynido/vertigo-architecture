/** W3.3L: cutover removes the implementation, not just public MCP names. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { HARNESS_ROOT, listFiles, REPO_ROOT, scan } from "./scan.ts";

test("GW3.3L: renderer absent; zero imports across harness/plugin; no native-Notion rendering in production", async () => {
  await assert.rejects(access(join(HARNESS_ROOT, "src/plans/render.ts")), { code: "ENOENT" });
  const all = [
    ...await listFiles(join(REPO_ROOT, "packages/harness"), [".ts", ".mjs"]),
    ...await listFiles(join(REPO_ROOT, "packages/plugin"), [".ts", ".mjs"]),
  ];
  assert.deepEqual(await scan(all, [/\b(?:from|import).*plans\/render\.ts/, /\b(?:from|import).*['"]\.\/render\.ts/]), []);
  const production = await listFiles(join(HARNESS_ROOT, "src"), [".ts"]);
  assert.deepEqual(await scan(production, [/\b(?:function|const)\s+(?:renderActions|renderPlan|bindSymbols|NATIVE_MAPPING)\b/, /\bmethod\s*:\s*["'](?:create_pages|update_page)["']/, /Execute.*with the native Notion app/]), []);
});
