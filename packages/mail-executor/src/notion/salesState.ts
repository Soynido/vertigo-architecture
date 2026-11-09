/**
 * Canonical Sales state reader over the harness read-only Notion client. Property names come from a local grammar
 * file (deployment config). Any unmapped or unreadable value is UNKNOWN / UNAVAILABLE — the engine refuses on it.
 */
import type { NotionReadClient } from "../../../harness/src/notion/readClient.ts";
import { normalizeId, propMentions, propText, type Page } from "../../../harness/src/notion/shapes.ts";
import type { Authority, Content, EnrollmentRecord, Flag, IntentRecord, Missing, PartyState, SalesStateReader } from "../types.ts";

export interface SalesGrammar {
  readonly data_sources: { readonly authority: string; readonly enrollments: string };
  readonly intent: Readonly<Record<"actionKey" | "actionType" | "runRef" | "harnessPlanId" | "contactRef" | "accountRef" | "enrollmentRef" | "owner" | "recipient" | "mailboxIdentity" | "threadRef" | "sequenceKey" | "sequenceVersion" | "sequenceStep" | "contentRef" | "contentHash" | "preparedAt" | "windowEnd" | "approvalState" | "approvalExpiresAt" | "approvalContextHash" | "contractPin" | "schemaPin" | "authorityPin" | "effectStatus", string>>;
  readonly party: Readonly<Record<"dnc" | "optOut" | "bounced" | "hold" | "owner" | "coordinationLock", string>>;
  readonly enrollment: Readonly<Record<"status" | "contactRef" | "owner" | "sequenceKey", string>>;
  readonly authority: Readonly<Record<"version" | "current" | "requiresHumanApproval" | "allowedActionTypes" | "maxSequenceStep" | "sendPaused", string>>;
  readonly content: Readonly<Record<"subject" | "body" | "contentHash", string>>;
}

const text = (p: Page, name: string): string => propText(p, name)?.trim() || "UNKNOWN";
const ref = (p: Page, name: string): string => { const m = propMentions(p, name)[0]; if (m) return normalizeId(m) ?? m; const raw = (p.properties[name] as { relation?: Array<{ id: string }> } | undefined)?.relation?.[0]?.id; return raw ? (normalizeId(raw) ?? raw) : text(p, name); };
const flag = (p: Page, name: string): Flag => { const t = propText(p, name); return t === "true" ? true : t === "false" ? false : t === undefined ? "UNKNOWN" : /^(yes|y|on|1)$/i.test(t) ? true : /^(no|n|off|0)$/i.test(t) ? false : "UNKNOWN"; };

export class NotionSalesStateReader implements SalesStateReader {
  readonly #client: NotionReadClient; readonly #g: SalesGrammar;
  constructor(client: NotionReadClient, g: SalesGrammar) { this.#client = client; this.#g = g; }
  get client(): NotionReadClient { return this.#client; }
  get g(): SalesGrammar { return this.#g; }
  async #page(id: string): Promise<Page | Missing> {
    try { const p = (await this.client.retrievePage(id)) as Page; return p?.properties ? p : "NOT_FOUND"; } catch (e) { return /404|not_found|object_not_found/i.test(String(e)) ? "NOT_FOUND" : "UNAVAILABLE"; }
  }
  async #rows(ds: string, filter: unknown): Promise<Page[] | "UNAVAILABLE"> {
    try { const r = (await this.client.queryDataSource(ds, filter)) as { results?: Page[] }; return r.results ?? []; } catch { return "UNAVAILABLE"; }
  }
  async intent(intentRef: string): Promise<IntentRecord | Missing> {
    const p = await this.#page(intentRef);
    if (typeof p === "string") return p;
    const g = this.g.intent;
    const step = Number(propText(p, g.sequenceStep));
    const approvalState = propText(p, g.approvalState);
    return {
      intent_ref: normalizeId(p.id) ?? p.id, action_key: text(p, g.actionKey), action_type: text(p, g.actionType), run_ref: ref(p, g.runRef), harness_plan_id: text(p, g.harnessPlanId), contact_ref: ref(p, g.contactRef), account_ref: ref(p, g.accountRef), enrollment_ref: ref(p, g.enrollmentRef), owner: text(p, g.owner), recipient: text(p, g.recipient).toLowerCase(), mailbox_identity: text(p, g.mailboxIdentity).toLowerCase(),
      ...(propText(p, g.threadRef) ? { thread_ref: text(p, g.threadRef) } : {}),
      sequence: { key: text(p, g.sequenceKey), version: text(p, g.sequenceVersion), step: Number.isFinite(step) ? step : Number.NaN },
      content_ref: ref(p, g.contentRef), content_hash: text(p, g.contentHash), prepared_at: text(p, g.preparedAt), window_end: text(p, g.windowEnd),
      ...(approvalState ? { approval: { state: approvalState, ...(propText(p, g.approvalExpiresAt) ? { expires_at: text(p, g.approvalExpiresAt) } : {}), ...(propText(p, g.approvalContextHash) ? { context_hash: text(p, g.approvalContextHash) } : {}) } } : {}),
      pins: { contract: text(p, g.contractPin), schema: text(p, g.schemaPin), authority: text(p, g.authorityPin) }, effect_status: text(p, g.effectStatus),
    };
  }
  #authorityOf(p: Page): Authority {
    const a = this.g.authority;
    const allowed = propText(p, a.allowedActionTypes)?.trim();
    const max = Number(propText(p, a.maxSequenceStep));
    return { version: text(p, a.version), requires_human_approval: flag(p, a.requiresHumanApproval) !== false, allowed_action_types: !allowed || allowed === "UNKNOWN" ? [] : allowed === "ANY" ? "ANY" : allowed.split(",").map((x) => x.trim()).filter(Boolean), ...(Number.isFinite(max) ? { max_sequence_step: max } : {}), send_paused: flag(p, a.sendPaused) !== false };
  }
  async currentAuthority(): Promise<Authority | "UNAVAILABLE"> {
    const rows = await this.#rows(this.g.data_sources.authority, { property: this.g.authority.current, checkbox: { equals: true } });
    if (rows === "UNAVAILABLE" || rows.length !== 1) return "UNAVAILABLE";
    return this.#authorityOf(rows[0] as Page);
  }
  async authority(version: string): Promise<Authority | Missing> {
    const rows = await this.#rows(this.g.data_sources.authority, { property: this.g.authority.version, rich_text: { equals: version } });
    if (rows === "UNAVAILABLE") return "UNAVAILABLE";
    const exact = rows.filter((r) => text(r, this.g.authority.version) === version);
    return exact.length === 1 ? this.#authorityOf(exact[0] as Page) : "NOT_FOUND";
  }
  async #party(id: string): Promise<PartyState | Missing> {
    const p = await this.#page(id);
    if (typeof p === "string") return p;
    const g = this.g.party;
    const lock = propText(p, g.coordinationLock)?.trim();
    return { dnc: flag(p, g.dnc), opt_out: flag(p, g.optOut), bounced: flag(p, g.bounced), hold: flag(p, g.hold), owner: text(p, g.owner), ...(lock ? { coordination_lock: lock } : {}) };
  }
  contact(r: string) { return this.#party(r); }
  account(r: string) { return this.#party(r); }
  async enrollments(contactRef: string): Promise<readonly EnrollmentRecord[] | "UNAVAILABLE"> {
    const rows = await this.#rows(this.g.data_sources.enrollments, { property: this.g.enrollment.contactRef, relation: { contains: contactRef } });
    if (rows === "UNAVAILABLE") return "UNAVAILABLE";
    const g = this.g.enrollment;
    return rows.map((p) => ({ ref: normalizeId(p.id) ?? p.id, status: text(p, g.status), contact_ref: ref(p, g.contactRef), owner: text(p, g.owner), sequence_key: text(p, g.sequenceKey) }));
  }
  async content(contentRef: string): Promise<Content | Missing> {
    const p = await this.#page(contentRef);
    if (typeof p === "string") return p;
    const g = this.g.content;
    return { subject: text(p, g.subject), body: propText(p, g.body) ?? "", content_hash: text(p, g.contentHash) };
  }
}
