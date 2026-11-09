/**
 * PT-PRO-007 (PV0-020E) — the shipped skill must state, verbatim, the two rules the independent lane is adjudicated
 * on, and the copy the plugin actually serves must be the same bytes:
 *  1. the governed record key of META:INPUTS is "<GATE KEY>:PRIMARY_OFFER", never a human label (fixture contract v2,
 *     enforced backend-side by PT-PRO-006);
 *  2. PT-PRO-003: a message without the apps produces no os_prepare, therefore no plan and no lease.
 * The build compiles TypeScript only and copies no Markdown, so there is exactly one canonical SKILL.md and the
 * compiled binary resolves to it; this test pins that so a stale packaged copy can never be served.
 * W3.4: /a /b keep pinning the LIVE six-tool canon SKILL.md. The BUILD TARGET server serves SKILL.candidate.md by
 * default, so /c /d pin the bytes it actually serves: one candidate file, resolved identically from src and dist.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../harness/src/index.ts";
import { CANDIDATE_SKILL_PATH } from "../../harness/src/tools/skill.ts";
import { buildWorld, OWNER } from "../../harness/test/unit/binding-fixtures.ts";

const CANONICAL = new URL("../SKILL.md", import.meta.url);
const KEY_RULE = "`record_selector.natural_key` is the governed record key `<GATE KEY>:PRIMARY_OFFER`, never a human label.";
const KEY_RULE_TAIL = "A selector outside the form `<GATE KEY>:<INPUT NAME>` is refused by the backend before any plan or lease exists, and no Run is opened.";
const LABEL_HOME = "The readable title « <gate key> — <short label> » belongs to `desired_changes.Input`.";
const NO_APPS_SENTENCE = "« Les applications VERTIGO et Notion ne sont pas sélectionnées sur ce message : je ne peux pas enregistrer. Sélectionnez VERTIGO et Notion sur votre message, puis renvoyez votre réponse. »";
const NO_APPS_EFFECT = "and stop: no plan, no pretend write, no FINAL, and never store that answer later from memory";
const RULES = [KEY_RULE, KEY_RULE_TAIL, LABEL_HOME, NO_APPS_SENTENCE, NO_APPS_EFFECT];
// W3.4 — the candidate the BUILD TARGET serves: first call, nothing claimed before PERSISTED, approval is not a send,
// no production under a P0 HOLD; W3.6 only requires actually available VERTIGO tools, not the native Notion app.
const CANDIDATE = new URL("../SKILL.candidate.md", import.meta.url);
const CANDIDATE_RULES = [
  "the first call is `os_bind`, with no arguments",
  "Never say « enregistré », « vérifié », « persisté », « fait » or anything equivalent before `os_commit` returns",
  "An approval is never authorization to send and never proof that a message left.",
  "or a declared constraint cannot be verified, produce no production plan",
  "The native Notion app is not required for these server-backed operations.",
  "« VERTIGO n'est pas disponible sur ce message : je ne peux pas enregistrer. Activez VERTIGO, puis renvoyez votre réponse. »",
];

async function walk(dir, hits = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    // `.run` is untracked build output, rebuilt from the canonical file on demand (the uploadable archive
    // stages a copy of the skill there). It is not a second source that could drift; a tracked copy would be.
    if (e.name === "node_modules" || e.name === ".git" || e.name === ".run") continue;
    const child = new URL(`${e.name}${e.isDirectory() ? "/" : ""}`, dir);
    if (e.isDirectory()) await walk(child, hits);
    else hits.push(fileURLToPath(child));
  }
  return hits;
}

test("PT-PRO-007/a: the canonical skill states the governed record key rule verbatim", async () => {
  const skill = await readFile(CANONICAL, "utf8");
  assert.ok(skill.includes(KEY_RULE), `skill lacks: ${KEY_RULE}`);
  assert.ok(skill.includes(LABEL_HOME), `skill lacks: ${LABEL_HOME}`);
  assert.ok(skill.includes(KEY_RULE_TAIL), `skill lacks: ${KEY_RULE_TAIL}`);
  // The §2b intent recipe still names the key and the exact Answer, and the rule sits inside §2b.
  const s2b = skill.split("## 2b.")[1].split("## 2c.")[0];
  assert.ok(s2b.includes("`F1:PRIMARY_OFFER`"), "§2b keeps the concrete example of the governed key");
  assert.ok(s2b.includes(KEY_RULE), "the prohibition sits in §2b, next to the recipe it corrects");
  assert.ok(s2b.includes("`Answer`: the exact submitted answer string"));
});

test("PT-PRO-007/b: the canonical skill states the PT-PRO-003 fail-closed rule verbatim — no apps, no os_prepare, no plan", async () => {
  const skill = await readFile(CANONICAL, "utf8");
  assert.ok(skill.includes(NO_APPS_SENTENCE), "the exact resend sentence");
  assert.ok(skill.includes(NO_APPS_EFFECT), "the exact consequence: no plan");
  const guard = skill.split("\n").find((l) => l.startsWith("- Before `os_prepare`, both the VERTIGO tools and the native Notion app must be exposed"));
  assert.ok(guard, "the guard is stated before os_prepare");
  assert.ok(guard.includes("**on the current message**") && guard.includes(NO_APPS_SENTENCE) && guard.includes(NO_APPS_EFFECT), guard);
  assert.ok(skill.includes("An answer in chat alone is never « enregistré »."), "§2c restates it for the answer turn");
});

test("PT-PRO-007/c: exactly one LIVE SKILL.md and one SKILL.candidate.md exist, the build copies no Markdown, and src and dist serve the same candidate", async () => {
  const repo = new URL("../../../", import.meta.url);
  const files = await walk(repo);
  // This exact agent-only orchestration skill is not shipped or served by the plugin. Other copies still fail.
  const agentSkill = fileURLToPath(new URL("docs/skills/vertigo-scope-control/SKILL.md", repo));
  const skills = files.filter((f) => f.endsWith("/SKILL.md") && f !== agentSkill);
  assert.deepEqual(skills, [fileURLToPath(CANONICAL)], `exactly one LIVE canonical skill; found: ${skills.join(", ")}`);
  const candidates = files.filter((f) => f.endsWith("/SKILL.candidate.md"));
  assert.deepEqual(candidates, [fileURLToPath(CANDIDATE)], `exactly one candidate skill; found: ${candidates.join(", ")}`);
  assert.deepEqual(files.filter((f) => f.includes("/dist/") && f.endsWith(".md")), [], "the build copies no Markdown into dist");
  // loadSkill resolves "../../../plugin/SKILL.candidate.md" relative to its own module: identical from source and from dist.
  const fromSrc = fileURLToPath(new URL("../../../plugin/SKILL.candidate.md", new URL("../../harness/src/tools/skill.ts", import.meta.url)));
  const fromDist = fileURLToPath(new URL("../../../plugin/SKILL.candidate.md", new URL("../../harness/dist/tools/skill.js", import.meta.url)));
  assert.equal(fromSrc, fileURLToPath(CANDIDATE));
  assert.equal(CANDIDATE_SKILL_PATH, fromSrc, "the loader's default is the candidate file");
  assert.equal(fromDist, fromSrc, "the compiled binary serves the candidate file, never a packaged copy");
});

test("PT-PRO-007/d: the copy the plugin actually serves is the candidate, byte-identical, and carries its rules", async () => {
  const skill = await readFile(CANDIDATE, "utf8");
  const live = await readFile(CANONICAL, "utf8");
  const w = buildWorld();
  const server = createServer(w.deps, OWNER.principal_id);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "pt-pro-007", version: "0" });
  await client.connect(ct);
  try {
    const served = [
      ["instructions", client.getInstructions()],
      ["prompt", (await client.getPrompt({ name: "vertigo_skill" })).messages[0].content.text],
      ["resource", (await client.readResource({ uri: "vertigo://skill" })).contents[0].text],
    ];
    for (const [what, text] of served) {
      assert.equal(text, skill, `${what} is not byte-identical to the candidate skill`);
      assert.notEqual(text, live, `${what} serves the LIVE six-tool canon`);
      for (const rule of CANDIDATE_RULES) assert.ok(text.includes(rule), `${what} lacks: ${rule.slice(0, 60)}`);
    }
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ["os_bind", "os_resume", "os_commit", "os_handoff", "os_control_status"], "the candidate server announces five tools (W3.3); the LIVE manifest keeps its own six");
  } finally { await client.close(); await server.close(); }
});
