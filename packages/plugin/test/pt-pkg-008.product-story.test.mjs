/**
 * PT-PKG-008 — the package tells the product story of PLUGIN_SPEC/0.2.0 (01 Final Product, 02 Architecture,
 * 09 Golden Path, 10 Gmail Effect Plane): the Plugin is one installable product for ordinary ChatGPT users,
 * serving VERTIGO META OS and Personal SALES OS, made of the skill, the read-only six-tool backend, native Notion,
 * native Gmail and the deterministic Mail Executor. The story must not collapse the product into its MCP backend,
 * must state what the user observes and what is guaranteed, and must include the protected email effect path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const here = (p) => new URL(p, import.meta.url);
const SIX = ["os_bind", "os_resume", "os_prepare", "os_verify", "os_handoff", "os_control_status"];

test("PT-PKG-008: README opens with the whole installable product, both lanes, all five components and the protected email path", async () => {
  const readme = await readFile(here("../../../README.md"), "utf8");
  const product = readme.split("## Layout")[0];
  assert.match(product, /## The product/);
  assert.match(product, /one installable product for an ordinary ChatGPT account/);
  assert.match(product, /VERTIGO META OS/); assert.match(product, /Personal SALES OS/);
  assert.match(product, /"the Harness" names this whole installable plugin/, "program vocabulary: Harness = the whole plugin");
  for (const component of ["VERTIGO OS skill", "read-only harness backend", "native Notion app", "native Gmail", "deterministic Mail Executor"]) assert.ok(product.includes(component), `component missing: ${component}`);
  for (const tool of SIX) assert.ok(product.includes(`\`${tool}\``), `tool missing: ${tool}`);
  assert.doesNotMatch(product, /^Read-only VERTIGO harness exposing/m, "the product story must not collapse into the backend");
  // How to use, observable outputs, guarantees, target experience.
  assert.match(product, /\*\*How it is installed and used\.\*\*/); assert.match(product, /apps\s+per message/);
  assert.match(product, /\*\*What the user observes\.\*\*/); assert.match(product, /C'est enregistré et vérifié dans Notion\./); assert.match(product, /TRANSACTION_VERIFIED/);
  assert.match(product, /\*\*What it guarantees\*\*/); assert.match(product, /no completion without\s+TARGET and FINAL/); assert.match(product, /cannot send twice/); assert.match(product, /no bypass of the protected send effect/);
  assert.match(product, /\*\*Target experience\.\*\*/); assert.match(product, /transaction A/); assert.match(product, /transaction B/); assert.match(product, /Gmail is read back/);
  assert.match(product, /Project canon is Notion, not this README/);
});

test("PT-PKG-008: INSTALL and manifest carry the same product framing (both lanes, five components, six tools, executor for automated sends)", async () => {
  const install = await readFile(here("../docs/INSTALL.md"), "utf8");
  const intro = install.split("## 0.")[0];
  assert.match(intro, /VERTIGO META OS and\/or a Personal SALES OS/);
  assert.match(intro, /the Harness, in this program's vocabulary/);
  for (const component of ["VERTIGO OS skill", "read-only harness backend", "native Notion app", "native Gmail connector", "deterministic Mail Executor"]) assert.ok(intro.includes(component), `INSTALL intro lacks: ${component}`);
  const manifest = JSON.parse(await readFile(here("../manifest.json"), "utf8"));
  assert.match(manifest.description, /META OS/); assert.match(manifest.description, /Personal SALES OS/);
  assert.match(manifest.description, /native Notion app/); assert.match(manifest.description, /deterministic Mail Executor/);
  assert.deepEqual(manifest.tools, SIX);
  assert.equal(manifest.harness.notion_access, "read-only"); assert.equal(manifest.harness.gmail_access, "none");
  assert.equal(manifest.dependencies.native_notion_app.required, true);
  assert.deepEqual(manifest.execution_modes.PROTECTED_AUTOMATED_SEND, ["harness", "native_notion_app", "native_gmail_read", "mail_executor"]);
});
