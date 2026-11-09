/**
 * PT-GMAIL-014 — Wake environment proves required Notion/Gmail capabilities per execution mode.
 * A mode is eligible only when all capabilities it depends on are present; harness-without-Gmail or
 * Gmail-without-Notion HOLDs Gmail-dependent automated work; no conversation id is required.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { declareEligibleModes, defaultProbes, MODE_REQUIREMENTS, runPreflight } from "../wake/preflight.mjs";

const ALL = { harness: true, notion_read: true, notion_native_write: true, gmail_read: true, gmail_send_test_scope: true, mail_executor: true };

test("PT-GMAIL-014/a: full capability set → every mode eligible; each missing capability HOLDs exactly the modes that need it", () => {
  const full = declareEligibleModes(ALL);
  assert.ok(Object.values(full.modes).every((m) => m.eligible));
  assert.equal(full.conversation_id_required, false);
  for (const cap of Object.keys(ALL)) {
    const r = declareEligibleModes({ ...ALL, [cap]: false });
    for (const [mode, needs] of Object.entries(MODE_REQUIREMENTS)) {
      const m = r.modes[mode];
      if (needs.includes(cap)) { assert.equal(m.eligible, false, `${mode} without ${cap}`); assert.equal(m.code, "HOLD_CAPABILITY_MISSING"); assert.deepEqual(m.missing, [cap]); }
      else assert.equal(m.eligible, true, `${mode} does not need ${cap}`);
    }
  }
  assert.equal(declareEligibleModes({ ...ALL, gmail_read: "UNKNOWN" }).modes.PROTECTED_AUTOMATED_SEND.eligible, false, "UNKNOWN never counts as present");
});

test("PT-GMAIL-014/b: harness-without-Gmail and Gmail-without-Notion branches HOLD Gmail-dependent automated work", async () => {
  const noGmail = await runPreflight({ harness: async () => true, notion_read: async () => true, notion_native_write: async () => true, gmail_read: async () => { throw new Error("no connector"); }, gmail_send_test_scope: async () => false, mail_executor: async () => true });
  assert.equal(noGmail.capabilities.gmail_read, "UNKNOWN");
  assert.equal(noGmail.modes.NOTION_TRANSACTION.eligible, true, "internal Notion planning may continue");
  for (const m of ["READ_RECONCILE", "EXTERNAL_ACTION_TEST", "PROTECTED_AUTOMATED_SEND", "DRAFT_THEN_HUMAN_SEND"]) assert.equal(noGmail.modes[m].eligible, false, m);
  const noNotion = await runPreflight({ harness: async () => true, notion_read: async () => false, notion_native_write: async () => false, gmail_read: async () => true, gmail_send_test_scope: async () => true, mail_executor: async () => true });
  assert.equal(noNotion.read_only_tools, "HOLD");
  assert.ok(Object.values(noNotion.modes).every((m) => !m.eligible), "no automated effect whose authority depends on unavailable durable state");
});

test("PT-GMAIL-014/c: default probes prove capabilities independently (presence + live read), never by assertion", async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return { status: url.includes("notion") ? 200 : 401 }; };
  const env = { VERTIGO_META_SPEC_ROOT: "x", PRINCIPALS_FILE: "y", HARNESS_ENV: "live_readonly", NOTION_READ_TOKEN: "t", MAIL_EXECUTOR_GMAIL_ACCESS_TOKEN: "g" };
  const r = await runPreflight(defaultProbes(env, fetchImpl));
  assert.equal(r.capabilities.harness, true);
  assert.equal(r.capabilities.notion_read, true);
  assert.equal(r.capabilities.gmail_read, false, "a token alone proves nothing; the profile read failed");
  assert.equal(r.capabilities.mail_executor, false, "executor needs its ledger, grammar and harness store configured");
  assert.equal(r.capabilities.notion_native_write, false);
  assert.ok(calls.some((u) => u.includes("api.notion.com")) && calls.some((u) => u.includes("gmail.googleapis.com")));
  assert.equal(r.modes.PROTECTED_AUTOMATED_SEND.eligible, false);
});
