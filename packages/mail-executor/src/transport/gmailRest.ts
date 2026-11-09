/**
 * Protected Gmail REST transport + competent-source reader. Owns the protected credential through a token provider
 * (deployment config, never a chat input). HTTP outcomes are classified fail-closed: an accepted send returns SENT
 * with Gmail's ids; a definitive rejection (4xx) is FAILED; anything else (5xx, network error, timeout) is AMBIGUOUS.
 */
import type { CompetentSource, MailboxMessage, SentQuery } from "../../../harness/src/effects/gmail.ts";
import type { ProtectedTransport, SendEnvelope, TransportResult } from "../types.ts";

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;
export type TokenProvider = () => Promise<string>;
const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

const b64url = (s: string): string => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export function rfc822(e: SendEnvelope): string {
  const headers = [`From: ${e.from}`, `To: ${e.to}`, `Subject: ${e.subject}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", ...Object.entries(e.headers).map(([k, v]) => `${k}: ${v}`)];
  return `${headers.join("\r\n")}\r\n\r\n${e.body}`;
}

export class GmailRestTransport implements ProtectedTransport {
  readonly #fetch: FetchLike; readonly #token: TokenProvider; readonly #timeoutMs: number;
  constructor(fetchImpl: FetchLike, token: TokenProvider, timeoutMs = 20_000) { this.#fetch = fetchImpl; this.#token = token; this.#timeoutMs = timeoutMs; }
  async send(envelope: SendEnvelope): Promise<TransportResult> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.#timeoutMs);
    try {
      const res = await this.#fetch(`${BASE}/messages/send`, { method: "POST", headers: { authorization: `Bearer ${await this.#token()}`, "content-type": "application/json" }, body: JSON.stringify({ raw: b64url(rfc822(envelope)), ...(envelope.thread_id ? { threadId: envelope.thread_id } : {}) }), signal: ctrl.signal });
      if (res.status >= 200 && res.status < 300) {
        const body = (await res.json()) as { id?: string; threadId?: string };
        if (body.id && body.threadId) return { status: "SENT", message_id: body.id, thread_id: body.threadId };
        return { status: "AMBIGUOUS", evidence: `send returned ${res.status} without message/thread ids` };
      }
      if (res.status >= 400 && res.status < 500) return { status: "FAILED", evidence: `send rejected with HTTP ${res.status}` };
      return { status: "AMBIGUOUS", evidence: `send returned HTTP ${res.status}; the effect may or may not exist` };
    } catch (err) {
      return { status: "AMBIGUOUS", evidence: `send transport error: ${err instanceof Error ? err.message : String(err)}; the effect may or may not exist` };
    } finally { clearTimeout(t); }
  }
}

interface GmailMessage { id: string; threadId: string; internalDate?: string; snippet?: string; labelIds?: string[]; payload?: { headers?: Array<{ name: string; value: string }> } }
function toMessage(m: GmailMessage): MailboxMessage {
  const h = Object.fromEntries((m.payload?.headers ?? []).map((x) => [x.name.toLowerCase(), x.value]));
  const addr = (s: string | undefined): string => (s?.match(/<([^>]+)>/)?.[1] ?? s ?? "").trim().toLowerCase();
  return { message_id: m.id, thread_id: m.threadId, from: addr(h["from"]), to: (h["to"] ?? "").split(",").map((x) => addr(x)).filter(Boolean), subject: h["subject"] ?? "", date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : "", headers: h, ...(m.snippet ? { snippet: m.snippet } : {}), ...(m.labelIds ? { labels: m.labelIds } : {}) };
}

/** Read-only Gmail competent source over the same protected credential (metadata only). */
export class GmailRestCompetentSource implements CompetentSource {
  readonly #fetch: FetchLike; readonly #token: TokenProvider;
  constructor(fetchImpl: FetchLike, token: TokenProvider) { this.#fetch = fetchImpl; this.#token = token; }
  async #get(path: string): Promise<unknown | "UNAVAILABLE"> {
    try {
      const res = await this.#fetch(`${BASE}/${path}`, { method: "GET", headers: { authorization: `Bearer ${await this.#token()}` } });
      return res.status >= 200 && res.status < 300 ? res.json() : "UNAVAILABLE";
    } catch { return "UNAVAILABLE"; }
  }
  async identity(): Promise<string | "UNKNOWN"> {
    const p = await this.#get("profile");
    const email = (p as { emailAddress?: string } | "UNAVAILABLE") === "UNAVAILABLE" ? undefined : (p as { emailAddress?: string }).emailAddress;
    return email ? email.toLowerCase() : "UNKNOWN";
  }
  async searchSent(q: SentQuery): Promise<readonly MailboxMessage[] | "UNAVAILABLE"> {
    const after = Math.floor(Date.parse(q.since) / 1000) - 1, before = Math.floor(Date.parse(q.until) / 1000) + 1;
    const list = await this.#get(`messages?q=${encodeURIComponent(`in:sent to:${q.recipient} after:${after} before:${before}`)}&maxResults=50`);
    if (list === "UNAVAILABLE") return "UNAVAILABLE";
    const ids = ((list as { messages?: Array<{ id: string }> }).messages ?? []).map((m) => m.id);
    const out: MailboxMessage[] = [];
    for (const id of ids) {
      const m = await this.#get(`messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=X-Vertigo-Action-Key`);
      if (m === "UNAVAILABLE") return "UNAVAILABLE";
      out.push(toMessage(m as GmailMessage));
    }
    return out.filter((m) => m.date >= q.since && m.date <= q.until && (!q.action_key || m.subject.includes(q.action_key) || (m.headers?.["x-vertigo-action-key"] ?? "") === q.action_key) && (!q.subject_contains || m.subject.includes(q.subject_contains)));
  }
  async thread(threadId: string): Promise<readonly MailboxMessage[] | "UNAVAILABLE"> {
    const t = await this.#get(`threads/${threadId}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Auto-Submitted&metadataHeaders=X-Autoreply&metadataHeaders=Precedence`);
    if (t === "UNAVAILABLE") return "UNAVAILABLE";
    return ((t as { messages?: GmailMessage[] }).messages ?? []).map(toMessage).sort((a, b) => a.date.localeCompare(b.date));
  }
}
