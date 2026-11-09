/**
 * PT-PRO-003 / PT-PRO-004 (local, documentation half — PV0-020E): the package tells the operator that ChatGPT exposes
 * apps per message, that every tool-required message (opening + persisted answer) must carry VERTIGO and native
 * Notion, and that a message without them fails closed with a resend request. The cold-chat halves of PT-PRO-003/004/005
 * are executed by the independent lanes; nothing here adjudicates them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const here = (p) => new URL(p, import.meta.url);

test("PT-PRO-003/docs: INSTALL.md carries the per-message exposure step and keeps the project-instructions carrier", async () => {
  const install = await readFile(here("../docs/INSTALL.md"), "utf8");
  assert.match(install, /Per-message app exposure \(ChatGPT web\)/);
  assert.match(install, /per message, not per conversation/);
  assert.match(install, /Select the VERTIGO connector and the native Notion app on every message that needs them/);
  assert.match(install, /fails closed and asks for a resend/);
  assert.match(install, /Load `SKILL\.md` as the project\/custom instructions/, "the skill must also live outside the VERTIGO MCP carrier");
});

test("PT-PRO-003/docs: the skill and the install doc agree on the platform model and the fail-closed sentence", async () => {
  const install = await readFile(here("../docs/INSTALL.md"), "utf8");
  const skill = await readFile(here("../SKILL.md"), "utf8");
  for (const text of [install, skill]) assert.match(text, /per message, not per conversation/);
  assert.ok(skill.includes("Sélectionnez VERTIGO et Notion sur votre message, puis renvoyez votre réponse."));
  // No wording anywhere in the package promises that app availability persists for the conversation.
  for (const text of [install, skill]) assert.doesNotMatch(text, /remains active for the (entire )?conversation/i);
});
