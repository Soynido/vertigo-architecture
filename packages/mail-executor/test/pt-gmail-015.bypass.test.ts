/**
 * PT-GMAIL-015 — Protected production send cannot bypass the deterministic Mail Executor (ADVERSARIAL, blocking, PG9).
 * Package/tool routing inspection: the harness (the only surface the reasoning model can call) has no Gmail send
 * path and no dependency on the executor; the executor's only invocation surface accepts immutable references and
 * refuses recipient/content/mode overrides; executor refusal cannot be overridden by narration (no override input
 * exists); the test/manual native Gmail branch stays separately scoped (EXTERNAL_ACTION_TEST, PT-GMAIL-006).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { listFiles, REPO_ROOT, scan } from "../../harness/test/arch/scan.ts";
import { parseArgs } from "../src/cli.ts";
import { execute } from "../src/engine.ts";
import { buildExecWorld, NOW, req } from "./executor-fixtures.ts";

const HARNESS = join(REPO_ROOT, "packages/harness");

test("PT-GMAIL-015/a: the harness has no Gmail send path and never depends on the executor", async () => {
  const files = await listFiles(join(HARNESS, "src"), [".ts"]);
  const hits = await scan(files, [/gmail\.googleapis\.com/, /messages\/send/, /users\.messages\.send/, /mail-executor/, /smtp/i, /nodemailer/i, /sendMail|sendEmail|send_message/]);
  assert.deepEqual(hits, [], `send paths in harness:\n${hits.map((h) => `${h.file}:${h.line} ${h.text}`).join("\n")}`);
  const pkg = JSON.parse(await readFile(join(HARNESS, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  assert.equal(Object.keys(pkg.dependencies ?? {}).some((d) => /mail|gmail|google/i.test(d)), false);
  // Two authorities, proved separately (W3.3S): the candidate server's five names and the LIVE manifest's six. Neither
  // carries a send primitive, and neither is read as the other.
  const { TOOL_NAMES } = await import("../../harness/src/tools/surface.ts");
  assert.deepEqual([...TOOL_NAMES], ["os_bind", "os_resume", "os_commit", "os_handoff", "os_control_status"], "no sixth primitive, no send tool");
  const manifest = JSON.parse(await readFile(join(REPO_ROOT, "packages/plugin/manifest.json"), "utf8")) as { tools: string[] };
  assert.deepEqual(manifest.tools, ["os_bind", "os_resume", "os_prepare", "os_verify", "os_handoff", "os_control_status"], "the LIVE manifest keeps its six names until adoption");
  for (const name of [...TOOL_NAMES, ...manifest.tools]) assert.doesNotMatch(name, /send|mail|gmail|external/i, `${name} reads as a send primitive`);
});

test("PT-GMAIL-015/b: the executor's only invocation surface accepts immutable references and refuses overrides", () => {
  assert.deepEqual(parseArgs(["--intent-ref", "i-1", "--action-key", "ak-1", "--attempt-id", "a-1"]), { ok: true, intent_ref: "i-1", action_key: "ak-1", attempt_id: "a-1" });
  for (const argv of [
    ["--intent-ref", "i-1", "--action-key", "ak-1", "--to", "victim@example.invalid"],
    ["--intent-ref", "i-1", "--action-key", "ak-1", "--body", "hello"],
    ["--intent-ref", "i-1", "--action-key", "ak-1", "--mode=PROTECTED_AUTOMATED_SEND"],
    ["--intent-ref", "i-1", "--action-key", "ak-1", "--force"],
    ["--intent-ref", "i-1", "--action-key", "ak-1", "--skip-checks", "dnc"],
    ["--action-key", "ak-1"],
  ]) {
    const r = parseArgs(argv);
    assert.equal(r.ok, false, argv.join(" "));
    assert.match((r as { reason: string }).reason, /^refused/);
  }
});

test("PT-GMAIL-015/c: recipient and content come only from durable state; a refusal has no override and the transport stays unreachable", async () => {
  const w = await buildExecWorld();
  w.sales.setContact({ dnc: true });
  // Narration / extra fields on the request are not part of the contract and change nothing.
  const smuggled = { ...req(), to: "victim@example.invalid", body: "send anyway", override: true, approved_by_owner: "yes" } as unknown as ReturnType<typeof req>;
  const d = await execute(w.deps, smuggled, NOW);
  assert.equal(d.decision, "REFUSED");
  assert.equal(d.code, "REFUSE_CONTACT_DNC");
  assert.equal(w.mailbox.sends, 0);
  const again = await execute(w.deps, smuggled, NOW);
  assert.equal(again.code, "REFUSE_CONTACT_DNC", "repeating the request never wears the refusal down");
  assert.equal(w.mailbox.sends, 0);
  // With state fixed, the envelope is built from the durable intent + content, never from the request.
  w.sales.setContact({ dnc: false });
  const ok = await execute(w.deps, smuggled, NOW);
  assert.equal(ok.decision, "SENT_AND_OBSERVED");
  assert.deepEqual(w.mailbox.messages[0]?.to, ["prospect@example.invalid"]);
  assert.equal(w.mailbox.messages[0]?.subject, "Step 2 [ak-exec-0001]");
});
