/**
 * PT-ARCH-002 — Only META SPEC_ROOT is a stable hardcoded runtime pointer (ADVERSARIAL, blocking, gate PG1).
 * Procedure: search source, config templates, migrations, docs and tests for current META root, Manifest
 * URL, runtime ID, MRUN IDs, current Gate/blocker, current CONTROL/spec versions or specific SALES roots.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { REPO_ROOT, listFiles, scan } from "./scan.ts";

// The single allowed bootstrap pointer (docs/CONFIGURATION.md). It may appear only in configuration
// templates and documentation, never inside src/.
const SPEC_ROOT_ID = /ba6bcfce1c925786a42a4e808e92eaa7/;

const CURRENT_STATE_PATTERNS: readonly RegExp[] = [
  /\bMRUN-\d+\b/, /\bMMUT-\d+\b/, /\bMETA-VERTIGO-\d{8}-\d+\b/, /\bMETA_SPEC\/\d+\.\d+\.\d+\b/, /\bMETA_SCHEMA\/\d+\.\d+\.\d+\b/,
  /\bCONTROL\/\d+\.\d+\b/, /\bSALES_SCHEMA\/\d+\.\d+\.\d+\b/, /\bSALES_RUNTIME_CONTRACT\/\d+\.\d+\.\d+\b/, /\bMETA_LOCATOR\/\d+\.\d+\b/,
  /\b[MG]\d{1,2}\s+—\s+[A-Z][A-Z /&]+\b/, // e.g. "M1 — COMPANY FRAME", "G2 — META INSTALL"
  /notion\.(so|com|site)\/[A-Za-z0-9/_-]*[0-9a-f]{32}/, /collection:\/\/[0-9a-f-]{36}/, /\b[0-9a-f]{32}\b/, /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/,
  /\b(CollaboratorGamma|CollaboratorAlpha|CollaboratorBeta)\b.*(root|runtime|OS)/i,
];

function isDocOrConfig(file: string): boolean {
  return file.startsWith("docs/") || file === ".env.example" || file === "README.md";
}

test("PT-ARCH-002/a: src/, migrations/ and tests contain no current runtime-state constants", async () => {
  const files = [
    ...(await listFiles(join(REPO_ROOT, "packages"), [".ts", ".json", ".sql", ".md"])),
  ];
  const hits = await scan(files, CURRENT_STATE_PATTERNS, (file, line) => {
    // The 32-hex zero-padded placeholder used by PT-ARCH-001 fixtures is synthetic, not a runtime id.
    if (/0123456789abcdef0123456789abcdef/.test(line)) return true;
    // Notion-Version header date is an API version, not a runtime version.
    if (/NOTION_VERSION\s*=/.test(line)) return true;
    // Adapter CAPABILITY keys: version tokens may appear only in src/versions/adapters/** and only on a
    // registration line. They declare which frozen versions the backend understands; an unmatched
    // governing version HOLDs, so they cannot make cold resolution stale (07 — adapter registry).
    if (/packages\/harness\/src\/versions\/adapters\//.test(file) && /\.register\(/.test(line)) return true;
    return file.endsWith("pt-arch-002.no-current-state.test.ts");
  });
  assert.deepEqual(hits, [], `current-state constants found:\n${hits.map((h) => `${h.file}:${h.line} [${h.pattern}] ${h.text}`).join("\n")}`);
});

test("PT-ARCH-002/b: the SPEC_ROOT pointer appears only in configuration templates/docs, never in src/", async () => {
  const all = await listFiles(REPO_ROOT, [".ts", ".json", ".sql", ".md", ".example", ".yaml"]);
  const hits = await scan(all, [SPEC_ROOT_ID], (file) => file.endsWith("pt-arch-002.no-current-state.test.ts"));
  const offenders = hits.filter((h) => !isDocOrConfig(h.file));
  assert.deepEqual(offenders, [], `SPEC_ROOT hardcoded outside config/docs:\n${offenders.map((h) => `${h.file}:${h.line}`).join("\n")}`);
  assert.ok(hits.some((h) => h.file === ".env.example"), ".env.example must document VERTIGO_META_SPEC_ROOT");
});

test("PT-ARCH-002/c: SPEC_ROOT is read from configuration and is the only *_ROOT configuration key", async () => {
  const { loadConfig } = await import("../../src/config/index.ts");
  const cfg = loadConfig({ VERTIGO_META_SPEC_ROOT: "https://example.invalid/spec-root", HARNESS_ENV: "fixture", PRINCIPALS_FILE: "x.json" });
  assert.equal(cfg.metaSpecRoot, "https://example.invalid/spec-root");
  const keys = Object.keys(cfg);
  assert.deepEqual(keys.filter((k) => /root/i.test(k)), ["metaSpecRoot"]);
});

test("PT-ARCH-002/d: version tokens inside the adapters directory appear only on registration lines", async () => {
  const files = (await listFiles(join(REPO_ROOT, "packages/harness/src/versions/adapters"), [".ts"]));
  const hits = await scan(files, [/\b[A-Z][A-Z_]*\/\d+\.\d+(\.\d+)?\b/], (_f, line) => /\.register\(/.test(line) || line.trimStart().startsWith("*") || line.trimStart().startsWith("//"));
  assert.deepEqual(hits, [], `version literals outside registration lines:\n${hits.map((h) => `${h.file}:${h.line} ${h.text}`).join("\n")}`);
});
