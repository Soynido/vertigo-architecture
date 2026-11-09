/**
 * Wake capability preflight (PT-GMAIL-014). A mode is eligible only when every capability it depends on is proven
 * present in this wake environment. Nothing here needs a conversation id; nothing here is a seventh tool.
 */
export const MODE_REQUIREMENTS = Object.freeze({
  NOTION_TRANSACTION: ["harness", "notion_read", "notion_native_write"],
  READ_RECONCILE: ["harness", "notion_read", "gmail_read"],
  DRAFT_THEN_HUMAN_SEND: ["harness", "notion_read", "notion_native_write", "gmail_read"],
  EXTERNAL_ACTION_TEST: ["harness", "notion_read", "notion_native_write", "gmail_read", "gmail_send_test_scope"],
  PROTECTED_AUTOMATED_SEND: ["harness", "notion_read", "notion_native_write", "gmail_read", "mail_executor"],
});

/** capabilities: { [name]: true | false | "UNKNOWN" }. UNKNOWN never counts as present. */
export function declareEligibleModes(capabilities) {
  const present = (c) => capabilities[c] === true;
  const modes = {};
  for (const [mode, needs] of Object.entries(MODE_REQUIREMENTS)) {
    const missing = needs.filter((c) => !present(c));
    modes[mode] = missing.length === 0 ? { eligible: true } : { eligible: false, code: "HOLD_CAPABILITY_MISSING", missing };
  }
  const readOnly = present("harness") && present("notion_read");
  return { read_only_tools: readOnly ? "AVAILABLE" : "HOLD", modes, conversation_id_required: false };
}

/** Runs the probes (each returns true/false, throws ⇒ UNKNOWN) and declares eligible modes. */
export async function runPreflight(probes) {
  const capabilities = {};
  for (const [name, probe] of Object.entries(probes)) {
    try { capabilities[name] = (await probe()) === true; } catch { capabilities[name] = "UNKNOWN"; }
  }
  return { capabilities, ...declareEligibleModes(capabilities) };
}

/** Default probes from the environment: presence + a cheap live read where a credential exists. */
export function defaultProbes(env = process.env, fetchImpl = globalThis.fetch) {
  return {
    harness: async () => Boolean(env.VERTIGO_META_SPEC_ROOT && env.PRINCIPALS_FILE && env.HARNESS_ENV),
    notion_read: async () => {
      if (!env.NOTION_READ_TOKEN) return false;
      const r = await fetchImpl("https://api.notion.com/v1/users/me", { headers: { authorization: `Bearer ${env.NOTION_READ_TOKEN}`, "Notion-Version": "2025-09-03" } });
      return r.status === 200;
    },
    notion_native_write: async () => env.NATIVE_NOTION_CONNECTED === "true",
    gmail_read: async () => {
      if (!env.MAIL_EXECUTOR_GMAIL_ACCESS_TOKEN && env.NATIVE_GMAIL_CONNECTED !== "true") return false;
      if (env.NATIVE_GMAIL_CONNECTED === "true") return true;
      const r = await fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { authorization: `Bearer ${env.MAIL_EXECUTOR_GMAIL_ACCESS_TOKEN}` } });
      return r.status === 200;
    },
    gmail_send_test_scope: async () => Boolean(env.EXTERNAL_ACTION_TEST_FROM && env.EXTERNAL_ACTION_TEST_TO && env.NATIVE_GMAIL_CONNECTED === "true"),
    mail_executor: async () => Boolean(env.MAIL_EXECUTOR_DATABASE_URL && env.MAIL_EXECUTOR_GMAIL_ACCESS_TOKEN && env.MAIL_EXECUTOR_SALES_GRAMMAR_FILE && env.HARNESS_DATABASE_URL),
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  console.log(JSON.stringify(await runPreflight(defaultProbes()), null, 2));
}
