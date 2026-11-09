/** Candidate deployment/skill contract: seller sees an ordinary autonomous install; operators can prove the remote build. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolveInstruction } from "../../harness/src/transactions/write.ts";
import { encodeProperty } from "../../harness/src/notion/properties.ts";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

test("PT-INST-SKILL-001: governing 0.3 and guarded 0.4 candidate are explicit and package labels agree", async () => {
  const [skill, pkg, manifest, candidate] = await Promise.all([
    read("../SKILL.md"),
    read("../package.json").then(JSON.parse),
    read("../manifest.json").then(JSON.parse),
    read("../candidates/manifest.candidate.json").then(JSON.parse),
  ]);
  assert.match(skill.split("\n")[0], /governing PLUGIN_SPEC\/0\.3\.0; guarded 0\.4\.0 candidate/);
  assert.equal(pkg.version, manifest.version);
  assert.equal(manifest.spec, "PLUGIN_SPEC/0.3.0");
  assert.equal(candidate.spec, "PLUGIN_SPEC/0.4.0");
  assert.equal(candidate.status, "CANDIDATE_NOT_ADOPTED");
  assert.equal(candidate.adopted, false);
  assert.doesNotMatch(skill, /The harness only reads Notion/);
  assert.match(skill, /has no Notion write client/);
  assert.match(skill, /runtime-registry\ncompare-and-swap|runtime-registry compare-and-swap/);
});

test("PT-INST-SKILL-002: INSTALL_ONLY is autonomous, bounded, silent between safe steps, and never gives sellers repair commands", async () => {
  const skill = await read("../SKILL.md");
  const order = ["## 1a.", "## 1b. Installing", "## 1c. Which business", "## 2. Durable", "## 2a. Exact native"];
  let cursor = 0;
  for (const marker of order) { const found = skill.indexOf(marker, cursor); assert.ok(found >= cursor, `missing or out of order: ${marker}`); cursor = found + marker.length; }
  for (const required of [
    "run this routine autonomously on the",
    "two install plans, six `os_verify` calls",
    "each rendered action at",
    "first `CANARY_UPDATE`, then `CANARY_RESOLVE`",
    "call TARGET again after each one",
    "exactly three TARGET calls total",
    "OS State normalization",
    "A third\n   verification action",
    "Keep successful intermediate `say` values silent",
    "A HOLD or an `ask` is never swallowed",
    "speak only that fresh resume's `say`",
    "never ask them to run a command, copy an",
    "give the seller no technical repair",
  ]) assert.ok(skill.includes(required), `skill lacks: ${required}`);
  assert.match(skill, /On an `INSTALL_ONLY` HOLD, say `say` alone and stop/);
});

test("PT-INST-SKILL-003: renderer actions map to the exact native Notion connector shapes", async () => {
  const skill = await read("../SKILL.md");
  assert.match(skill, /`method: "create_pages"` is valid only with `target\.kind: "data_source"`/);
  assert.ok(skill.includes('{ "parent": { "data_source_id": target.data_source_id }, "pages": [{ "properties": properties }] }'));
  assert.match(skill, /`method: "update_page"` is valid only with `target\.kind: "page"` or `target\.kind: "created"`/);
  assert.ok(skill.includes('{ "page_id": <resolved id>, "command": "update_properties", "properties": properties, "allow_async": false }'));
  // Exact native shapes above belong to the frozen historical skill, not a candidate renderer.
  const resolved = resolveInstruction({ ordinal: 1, symbol: "updated", operation: "UPDATE", target_ref: "$created:row", purpose: "STATE_LAST", fields: { Status: "READY", "Target Receipt ID": "$receipt:TARGET" }, property_types: { Status: "select", "Target Receipt ID": "rich_text" } }, { created: { row: "0123456789abcdef0123456789abcdef" }, target_receipt_id: "receipt", now: new Date("2030-01-01T00:00:00Z") });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.instruction.target_id, "0123456789abcdef0123456789abcdef");
  assert.equal(resolved.instruction.fields["Target Receipt ID"], "receipt");
  assert.deepEqual(encodeProperty("select", resolved.instruction.fields.Status, { options: ["READY"] }), { ok: true, value: { select: { name: "READY" } } });
  assert.equal("method" in resolved.instruction, false, "strict backend instruction, not a native connector call");
  for (const required of ["`$created:<symbol>`", "`$receipt:TARGET`", "`$now`", "`untyped_fields` must be empty", "one rendered action per native mutation call"]) {
    assert.ok(skill.includes(required), `skill lacks exact action guard: ${required}`);
  }
  assert.doesNotMatch(skill, /archived\s*:\s*true/);
});

test("PT-DEPLOY-DOC-001: remote acceptance requires attestation, token revocation, app refresh and an ordinary-chat cold start without local MCP", async () => {
  const [install, config, provisioning] = await Promise.all([
    read("../docs/INSTALL.md"),
    read("../../../docs/CONFIGURATION.md"),
    read("../../../docs/INSTALL_PROVISIONING.md"),
  ]);
  for (const text of [install, config]) {
    for (const token of ["HARNESS_BUILD_REVISION", "HARNESS_BUILD_DIRTY", "HARNESS_CONFIG_FINGERPRINT", "serverInfo.version", "old token", "401"]) {
      assert.ok(text.includes(token), `deployment doc lacks ${token}`);
    }
  }
  assert.match(install, /PASS requires `dirty\.false`/);
  for (const token of ["refresh", "fresh ordinary ChatGPT chat", "no local", "@VERTIGO", "native Notion", "Gmail", "Google Calendar", "SALES_TEAM_V1_READY", "V0_READY"]) assert.match(install, new RegExp(token, "i"));
  assert.match(install, /must never run in a ChatGPT\s+Work task, Codex task\/lane/i);
  assert.match(provisioning, /A Work\/Codex task or engineering\s+lane is never acceptance evidence/i);
  assert.match(provisioning, /`SALES_TEAM_V1_READY`[\s\S]*not\s+`V0_READY`/i);
  assert.match(provisioning, /in-process fixture/);
  assert.match(provisioning, /not.*evidence[\s\S]*production Notion connector/i);
  for (const text of [config, provisioning]) {
    assert.match(text, /exclusive .*directory|exclusive `0700` \*\*directory\*\*/i);
    assert.match(text, /never age-reaped/i);
    assert.match(text, /owner-token/i);
    assert.doesNotMatch(text, /created with `O_CREAT\|O_EXCL`/);
  }
  for (const actual of ["PT-INST-001\u2013004", "PT-INST-011\u2013014", "PT-INST-021\u2013025", "PT-INST-031\u2013033"]) assert.ok(provisioning.includes(actual));
  for (const invented of ["PT-INST-005", "PT-INST-010", "PT-INST-015", "PT-INST-020", "PT-INST-026", "PT-INST-030", "PT-INST-034", "PT-INST-040"]) assert.ok(!provisioning.includes(invented), `docs claim nonexistent ${invented}`);
});
