/**
 * PT-PKG-006 — permissions and dependency setup are documented and reproducible: every configuration variable the
 * harness and the executor read is documented; every dependency/permission the modes need is declared; no secret
 * value ships in the package.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const here = (p) => new URL(p, import.meta.url);

test("PT-PKG-006: install doc covers every harness and executor configuration variable; manifest declares dependencies and fallbacks", async () => {
  const install = await readFile(here("../docs/INSTALL.md"), "utf8");
  const cfg = await readFile(here("../../harness/src/config/index.ts"), "utf8");
  const harnessVars = [...new Set([...cfg.matchAll(/env\["([A-Z_]+)"\]|required\(env, "([A-Z_]+)"\)|positiveNumber\(env, "([A-Z_]+)"/g)].map((m) => m[1] ?? m[2] ?? m[3]))];
  assert.ok(harnessVars.length >= 10, `expected the config loader to be scanned (${harnessVars.length} vars)`);
  for (const v of harnessVars) assert.ok(install.includes(v), `INSTALL.md must document ${v}`);
  const cli = await readFile(here("../../mail-executor/src/cli.ts"), "utf8");
  const execVars = [...new Set([...cli.matchAll(/need\("([A-Z_]+)"\)/g)].map((m) => m[1]))];
  const runbook = await readFile(here("../../mail-executor/README.md"), "utf8");
  for (const v of execVars) assert.ok(runbook.includes(v) && install.includes(v), `${v} must be documented in the executor runbook and INSTALL.md`);
  const manifest = JSON.parse(await readFile(here("../manifest.json"), "utf8"));
  for (const dep of ["native_notion_app", "native_gmail", "mail_executor"]) assert.ok(manifest.dependencies[dep]?.permissions || manifest.dependencies[dep]?.credential, `${dep} declares permissions/credential`);
  assert.equal(manifest.dependencies.work_or_codex_runtime.required, false);
  for (const mode of ["READ_RECONCILE", "DRAFT_THEN_HUMAN_SEND", "EXTERNAL_ACTION_TEST", "PROTECTED_AUTOMATED_SEND"]) assert.ok(Array.isArray(manifest.execution_modes[mode]), `${mode} capabilities declared`);
  assert.ok(Object.keys(manifest.safe_fallbacks).length >= 4);
});

test("PT-PKG-006: no secret value ships in the package or docs", async () => {
  for (const f of ["../manifest.json", "../SKILL.md", "../docs/INSTALL.md", "../wake/preflight.mjs", "../../mail-executor/README.md", "../../../docs/CONFIGURATION.md"]) {
    const text = await readFile(here(f), "utf8");
    assert.doesNotMatch(text, /\b(ntn_|secret_)[A-Za-z0-9]{20,}/, `${f} carries a Notion token`);
    assert.doesNotMatch(text, /ya29\.[A-Za-z0-9_-]{20,}/, `${f} carries a Google access token`);
    assert.doesNotMatch(text, /postgres:\/\/[^\s:]+:[^\s@]+@/, `${f} carries a database password`);
  }
});
