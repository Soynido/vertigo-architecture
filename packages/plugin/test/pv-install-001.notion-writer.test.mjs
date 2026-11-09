/**
 * PV-INSTALL-001 — which Notion surface writes, and why it is not a matter of taste.
 *
 * 2026-09-21: every transaction prepared correctly and none was ever written. The connector's own words were
 * `FORBIDDEN: This conversation is restricted to developer MCPs`. VERTIGO is a developer MCP; the curated Notion
 * app from the gallery is not, so ChatGPT refuses its write actions for the whole conversation the moment
 * VERTIGO binds. Its reads keep working, which is exactly why this read as a model that would not write — for a
 * full day, across seven fresh conversations.
 *
 * The capture is explicit that the curated app was the deliberate choice (render.ts was aligned to it on
 * 2026-09-18, commit e36420e) and that the adopted doctrine required native connectors. So this is a new
 * decision, not a restoration — and it must be stated where an installer reads it, in both documents, with the
 * reason attached, or the next person will pick the gallery app again.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const SKILL = new URL("../SKILL.md", import.meta.url);
const INSTALL = new URL("../docs/INSTALL.md", import.meta.url);

test("PV-INSTALL-001/a: the skill defines which Notion surface it means, before using the term", async () => {
  const skill = await readFile(SKILL, "utf8");
  const header = skill.split("## 0. Voice")[0];
  assert.ok(header.includes("means Notion's own MCP connector, added to ChatGPT in"), "the term is used throughout and never defined");
  assert.ok(header.includes("never the curated Notion app from the connector gallery"), "the excluded surface is not named");
  assert.ok(header.includes("FORBIDDEN: This conversation is restricted to developer MCPs"), "the connector's own words are the evidence; keep them verbatim");
  assert.ok(header.includes("Both surfaces take the same payloads"), "without this, a reader fears a format change too");
  const defIdx = header.indexOf("means Notion's own MCP connector");
  assert.ok(defIdx >= 0 && defIdx < header.indexOf("never a substitute for these six tools"), "the definition must precede the first use");
});

test("PV-INSTALL-001/b: the install contract names the connector to add and the one to refuse", async () => {
  const install = await readFile(INSTALL, "utf8");
  assert.ok(install.includes("https://mcp.notion.com/mcp"), "the installer is not told what to add");
  assert.ok(install.includes("as a second developer MCP"), "the connector kind is what matters and is not stated");
  assert.ok(install.includes("Do **not** use the curated Notion app from the gallery"), "the failing choice is not ruled out");
  assert.ok(install.includes("a read-only success proves nothing here"), "reads succeed on the wrong surface; the check must be a write");
  assert.ok(install.includes("Both Notion surfaces accept the identical rendered payloads"), "the installer must know no format changes");
});

test("PV-INSTALL-001/c: the canary workaround is never mistaken for the collaborator install", async () => {
  const install = await readFile(INSTALL, "utf8");
  // Asking a seller to enable developer mode is not this product. The two paths must be separable on sight,
  // or the workaround that unblocks one engineer becomes the thing four people are told to do.
  assert.ok(install.includes("**Canary / engineering install (today).**"), "the workaround is not labelled as one");
  assert.ok(install.includes("This is a test path. It is NOT what a collaborator installs"), "nothing stops the workaround being shipped");
  assert.ok(install.includes("**Collaborator install (the shipping path).**"), "the real path is not stated");
  assert.ok(install.includes("submitted through the ChatGPT plugin/app submission flow"), "the way out of developer mode is not named");
  assert.ok(install.includes("no collaborator install is possible**, whatever state the B0→B7 gates are in"), "the gates are not the blocker and the document must say so");
  assert.ok(install.includes("This is an OpenAI-side limitation, reported and unresolved"), "the cause must not read as our defect");
});
