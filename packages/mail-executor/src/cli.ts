/**
 * Mail Executor CLI — the ONLY invocation surface. Accepts immutable references only; any other argument (a
 * recipient, subject, body, mode, override…) is refused before anything is read. Configuration comes from the
 * deployment environment, never from the caller.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { HttpNotionReadClient, type NotionHttp } from "../../harness/src/notion/readClient.ts";
import { PostgresBackend } from "../../harness/src/store/postgres.ts";
import { execute } from "./engine.ts";
import { PostgresExecutionLedger } from "./ledger/postgres.ts";
import { NotionSalesStateReader, type SalesGrammar } from "./notion/salesState.ts";
import { GmailRestCompetentSource, GmailRestTransport } from "./transport/gmailRest.ts";
import { harnessVerification } from "./verification.ts";

export const ALLOWED_FLAGS = ["--intent-ref", "--action-key", "--attempt-id"] as const;

export function parseArgs(argv: readonly string[]): { ok: true; intent_ref: string; action_key: string; attempt_id: string } | { ok: false; reason: string } {
  const out: Record<string, string> = {};
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k] as string;
    const [flag, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    if (!(ALLOWED_FLAGS as readonly string[]).includes(flag)) return { ok: false, reason: `refused: the executor accepts only ${ALLOWED_FLAGS.join(", ")} (got ${flag}); recipient, content, mode and overrides are read from durable state, never from the caller` };
    const value = inline ?? argv[++k];
    if (!value || value.startsWith("--")) return { ok: false, reason: `refused: ${flag} needs a value` };
    if (out[flag]) return { ok: false, reason: `refused: ${flag} given twice` };
    out[flag] = value;
  }
  const intent_ref = out["--intent-ref"], action_key = out["--action-key"];
  if (!intent_ref || !action_key) return { ok: false, reason: "refused: --intent-ref and --action-key are required" };
  return { ok: true, intent_ref, action_key, attempt_id: out["--attempt-id"] ?? `att-${randomUUID()}` };
}

const need = (k: string): string => { const v = process.env[k]?.trim(); if (!v) { console.error(`refused: ${k} is not configured`); process.exit(2); } return v; };

if (import.meta.url === `file://${process.argv[1]}`) {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) { console.error(parsed.reason); process.exit(2); }
  const http: NotionHttp = async (url, init) => { const r = await fetch(url, init); return { status: r.status, json: () => r.json() }; };
  const notion = new HttpNotionReadClient(need("NOTION_READ_TOKEN"), http);
  const grammar = JSON.parse(await readFile(need("MAIL_EXECUTOR_SALES_GRAMMAR_FILE"), "utf8")) as SalesGrammar;
  const token = async () => need("MAIL_EXECUTOR_GMAIL_ACCESS_TOKEN");
  const gfetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => { const r = await fetch(url, init); return { status: r.status, json: () => r.json() }; };
  const backend = new PostgresBackend(need("HARNESS_DATABASE_URL"));
  const store = backend.store();
  const ledger = await PostgresExecutionLedger.connect(need("MAIL_EXECUTOR_DATABASE_URL"));
  try {
    const decision = await execute({ sales: new NotionSalesStateReader(notion, grammar), verification: harnessVerification(store.plans, store.receipts), source: new GmailRestCompetentSource(gfetch, token), transport: new GmailRestTransport(gfetch, token), ledger }, parsed);
    console.log(JSON.stringify(decision, null, 2));
    process.exit(decision.decision === "SENT_AND_OBSERVED" || decision.decision === "ALREADY_OBSERVED" ? 0 : decision.decision === "REFUSED" ? 3 : 4);
  } finally { await ledger.close(); await backend.close(); }
}
