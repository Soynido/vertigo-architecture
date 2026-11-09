/**
 * Gmail effect plane (PV0-017A, PLUGIN_SPEC/0.2.0 §10, PDEC-013).
 *
 * Gmail is the COMPETENT SOURCE for mailbox / thread / effect reality. This module only reads it through a
 * port (`CompetentSource`) and reasons deterministically about what was observed:
 *   - reconciliation of an ExternalActionIntent: OBSERVED exactly once / NOT_OBSERVED (proven absent within the
 *     bounded window) / AMBIGUOUS (fail-closed) / UNAVAILABLE (no send, no replay, no completion);
 *   - inbound classification: HUMAN / TECHNICAL (AUTO_REPLY, OOO, BOUNCE) / UNKNOWN (human takeover);
 *   - routing gate: an external action may be routed only from an exact FINAL-verified durable intent, in an
 *     eligible execution mode, after fresh T-0 checks; PROTECTED_AUTOMATED_SEND is executor-only (PV0-019A).
 * Nothing here sends. `PREPARED` / `APPROVED` / a FINAL receipt are never proof of an effect.
 */
import { createHash } from "node:crypto";
import type { HoldCode } from "../errors/codes.ts";
import type { Plan } from "../plans/store.ts";
import type { ReceiptStore } from "../verify/engine.ts";

export interface MailboxMessage {
  readonly message_id: string;
  readonly thread_id: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  /** ISO-8601 */
  readonly date: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly snippet?: string;
  readonly labels?: readonly string[];
}

export interface SentQuery { readonly recipient: string; readonly since: string; readonly until: string; readonly action_key?: string; readonly subject_contains?: string }

/** Read-only port to the competent source. A live adapter may be a Gmail API client or a snapshot captured from the native connector. */
export interface CompetentSource {
  /** Mailbox identity the source is authenticated as; UNKNOWN when not provable. */
  identity(): Promise<string | "UNKNOWN">;
  searchSent(q: SentQuery): Promise<readonly MailboxMessage[] | "UNAVAILABLE">;
  thread(threadId: string): Promise<readonly MailboxMessage[] | "UNAVAILABLE">;
}

/** Explicit-offset instants only: no host timezone, calendar rollover or lexical ordering. */
function instant(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!m) return undefined;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const offsetHour = Number(m[9] ?? 0), offsetMinute = Number(m[10] ?? 0);
  if (offsetHour > 23 || offsetMinute > 59 || hour! > 23 || minute! > 59 || second! > 59) return undefined;
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return undefined;
  const offset = (m[8] === "-" ? -1 : 1) * (offsetHour * 60 + offsetMinute) * 60_000;
  const local = new Date(epoch + offset);
  if (local.getUTCFullYear() !== year || local.getUTCMonth() + 1 !== month || local.getUTCDate() !== day) return undefined;
  return epoch;
}
function boundedWindow(since: string, until: string): readonly [number, number] | undefined {
  const start = instant(since), end = instant(until);
  return start !== undefined && end !== undefined && start <= end ? [start, end] : undefined;
}
function covered(messages: readonly MailboxMessage[], window: readonly [number, number]): boolean {
  return messages.every((message) => {
    const at = instant(message.date);
    return at !== undefined && at >= window[0] && at <= window[1];
  });
}

/** Snapshot source: deterministic over a captured list of messages (fixtures and native-connector captures). */
export class SnapshotCompetentSource implements CompetentSource {
  readonly #identity: string | "UNKNOWN";
  readonly #messages: readonly MailboxMessage[];
  readonly #available: boolean;
  constructor(identity: string | "UNKNOWN", messages: readonly MailboxMessage[], available = true) {
    this.#identity = identity;
    this.#messages = messages;
    this.#available = available;
  }
  async identity() { return this.#identity; }
  async searchSent(q: SentQuery) {
    if (!this.#available) return "UNAVAILABLE" as const;
    const window = boundedWindow(q.since, q.until);
    if (!window) return "UNAVAILABLE" as const;
    const me = typeof this.#identity === "string" ? this.#identity.toLowerCase() : "";
    const candidates = this.#messages.filter((m) => m.from.toLowerCase() === me && m.to.map((t) => t.toLowerCase()).includes(q.recipient.toLowerCase()));
    if (candidates.some((m) => instant(m.date) === undefined)) return "UNAVAILABLE" as const;
    return candidates.filter((m) => instant(m.date)! >= window[0] && instant(m.date)! <= window[1] && (!q.action_key || m.subject.includes(q.action_key) || (m.headers?.["x-vertigo-action-key"] ?? "") === q.action_key) && (!q.subject_contains || m.subject.includes(q.subject_contains)));
  }
  async thread(threadId: string) {
    if (!this.#available) return "UNAVAILABLE" as const;
    const messages = this.#messages.filter((m) => m.thread_id === threadId);
    if (messages.some((m) => instant(m.date) === undefined)) return "UNAVAILABLE" as const;
    return messages.sort((a, b) => instant(a.date)! - instant(b.date)!);
  }
}

export interface IntentView {
  readonly intent_ref: string;
  readonly action_key: string;
  readonly mailbox_identity: string;
  readonly recipient: string;
  readonly prepared_at: string;
  /** End of the bounded send/reconcile window (ISO). */
  readonly window_end: string;
  readonly thread_ref?: string;
  readonly subject_hint?: string;
  readonly effect_status: string;
  readonly approval_state?: string;
}

export type Reconciliation =
  | { readonly status: "OBSERVED"; readonly message_id: string; readonly thread_id: string; readonly observed_at: string; readonly recipient: string; readonly mailbox_identity: string; readonly evidence: readonly string[] }
  | { readonly status: "NOT_OBSERVED"; readonly window: { readonly since: string; readonly until: string }; readonly evidence: readonly string[] }
  | { readonly status: "AMBIGUOUS"; readonly candidates: readonly string[]; readonly evidence: readonly string[] }
  | { readonly status: "UNAVAILABLE"; readonly evidence: readonly string[] }
  | { readonly status: "IDENTITY_MISMATCH"; readonly evidence: readonly string[] };

/** Locate the effect of one intent in the competent source, bounded by recipient + window + action key. */
export async function reconcileIntent(intent: IntentView, source: CompetentSource): Promise<Reconciliation> {
  const identity = await source.identity();
  if (identity === "UNKNOWN") return { status: "UNAVAILABLE", evidence: ["competent source identity is UNKNOWN; mailbox binding cannot be proven"] };
  if (identity.toLowerCase() !== intent.mailbox_identity.toLowerCase()) return { status: "IDENTITY_MISMATCH", evidence: [`competent source is ${identity}, intent mailbox is ${intent.mailbox_identity}`] };
  const window = boundedWindow(intent.prepared_at, intent.window_end);
  if (!window) return { status: "UNAVAILABLE", evidence: ["invalid or inverted competent-source time window; no absence/effect proof"] };
  const found = await source.searchSent({ recipient: intent.recipient, since: intent.prepared_at, until: intent.window_end, action_key: intent.action_key });
  if (found === "UNAVAILABLE" || !covered(found, window)) return { status: "UNAVAILABLE", evidence: ["competent source unavailable or timestamps outside its valid window: no send, no replay, no completion of the intent"] };
  if (found.length === 1) {
    const m = found[0] as MailboxMessage;
    return { status: "OBSERVED", message_id: m.message_id, thread_id: m.thread_id, observed_at: m.date, recipient: intent.recipient, mailbox_identity: identity, evidence: [`exactly one message for action ${intent.action_key} to ${intent.recipient} within [${intent.prepared_at}, ${intent.window_end}]: message ${m.message_id} thread ${m.thread_id} at ${m.date}`] };
  }
  if (found.length > 1) return { status: "AMBIGUOUS", candidates: found.map((m) => m.message_id), evidence: [`${found.length} plausible messages for action ${intent.action_key} to ${intent.recipient}: ${found.map((m) => `${m.message_id}@${m.date}`).join(", ")}`, "effect matching cannot decide OBSERVED vs NOT_OBSERVED; fail closed"] };
  // Zero matches: absence is proven only for the bounded window that the source could cover.
  const loose = await source.searchSent({ recipient: intent.recipient, since: intent.prepared_at, until: intent.window_end });
  if (loose === "UNAVAILABLE" || !covered(loose, window)) return { status: "UNAVAILABLE", evidence: ["bounded absence cannot be proven from unreadable or invalid source timestamps"] };
  if (loose.length > 0) return { status: "AMBIGUOUS", candidates: loose.map((m) => m.message_id), evidence: [`no message carries action ${intent.action_key}, but ${loose.length} message(s) to ${intent.recipient} exist in the window: ${loose.map((m) => `${m.message_id} "${m.subject}"`).join(", ")}`, "cannot rule out that one of them is this action's effect; fail closed"] };
  return { status: "NOT_OBSERVED", window: { since: intent.prepared_at, until: intent.window_end }, evidence: [`no message to ${intent.recipient} from ${identity} within [${intent.prepared_at}, ${intent.window_end}]`] };
}

export type InboundKind = "HUMAN" | "TECHNICAL" | "UNKNOWN";
export type InboundClass = "REPLY" | "AUTO_REPLY" | "OOO" | "BOUNCE" | "OPT_OUT" | "UNCLASSIFIED";
export interface InboundClassification { readonly kind: InboundKind; readonly classification: InboundClass; readonly human_takeover: boolean; readonly evidence: readonly string[] }

const h = (m: MailboxMessage, name: string): string => (Object.entries(m.headers ?? {}).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1] ?? "").trim().toLowerCase();
const OOO = /\b(out of office|out-of-office|automatic reply|réponse automatique|absen[ct]e? du bureau|je suis absent|en congé)\b/i;
const OPT_OUT = /\b(unsubscribe|opt[- ]?out|stop|remove me|ne plus (me|nous) contacter|désabonn|desabonn|plus de mail)\b/i;
const BOUNCE_FROM = /(mailer-daemon|postmaster|noreply@.*bounce|mail delivery)/i;
const BOUNCE_SUBJECT = /(delivery status notification|undeliverable|delivery failure|mail delivery failed|échec de (la )?remise|non remis)/i;

/**
 * Deterministic safe-minimum mapping (spec §Inbound classification). Autoresponder evidence is TECHNICAL even
 * though the message is inbound; a technical auto-reply never becomes a human reply.
 */
export function classifyInbound(m: MailboxMessage, expectedHuman: string): InboundClassification {
  const evidence: string[] = [];
  const autoSubmitted = h(m, "auto-submitted");
  const xAutoreply = h(m, "x-autoreply");
  const precedence = h(m, "precedence");
  const xAutoResp = h(m, "x-autorespond");
  const text = `${m.subject} ${m.snippet ?? ""}`;
  if (BOUNCE_FROM.test(m.from) || BOUNCE_SUBJECT.test(m.subject)) return { kind: "TECHNICAL", classification: "BOUNCE", human_takeover: false, evidence: [`bounce evidence: from ${m.from}, subject "${m.subject}"`] };
  const autoresponder = (autoSubmitted !== "" && autoSubmitted !== "no") || xAutoreply === "yes" || xAutoResp !== "" || precedence === "auto_reply";
  if (autoresponder) {
    evidence.push(`autoresponder headers: Auto-Submitted=${autoSubmitted || "-"} X-Autoreply=${xAutoreply || "-"} Precedence=${precedence || "-"}`);
    return { kind: "TECHNICAL", classification: OOO.test(text) ? "OOO" : "AUTO_REPLY", human_takeover: false, evidence };
  }
  if (OOO.test(text)) return { kind: "TECHNICAL", classification: "OOO", human_takeover: false, evidence: [`out-of-office wording in "${m.subject}"`] };
  const fromExpected = m.from.toLowerCase().includes(expectedHuman.toLowerCase());
  if (precedence === "bulk" || precedence === "list" || h(m, "list-id") !== "") return { kind: "UNKNOWN", classification: "UNCLASSIFIED", human_takeover: true, evidence: [`bulk/list traffic from ${m.from}; human vs machine not established`] };
  if (fromExpected) {
    if (OPT_OUT.test(text)) return { kind: "HUMAN", classification: "OPT_OUT", human_takeover: true, evidence: [`human opt-out wording from ${m.from}`] };
    return { kind: "HUMAN", classification: "REPLY", human_takeover: true, evidence: [`reply from the expected human ${m.from} with no autoresponder evidence`] };
  }
  return { kind: "UNKNOWN", classification: "UNCLASSIFIED", human_takeover: true, evidence: [`inbound from ${m.from} is neither the expected human nor a deterministic autoresponder; human takeover`] };
}

/** Inbound messages on the intent's thread that arrived after it was prepared, with their classification. */
export async function inboundSincePrepared(intent: IntentView, source: CompetentSource): Promise<{ readonly status: "OK" | "UNAVAILABLE"; readonly inbound: ReadonlyArray<{ readonly message: MailboxMessage; readonly classification: InboundClassification }> }> {
  const prepared = instant(intent.prepared_at);
  if (prepared === undefined) return { status: "UNAVAILABLE", inbound: [] };
  if (!intent.thread_ref) return { status: "OK", inbound: [] };
  const msgs = await source.thread(intent.thread_ref);
  if (msgs === "UNAVAILABLE") return { status: "UNAVAILABLE", inbound: [] };
  const candidates = msgs.filter((m) => m.from.toLowerCase() !== intent.mailbox_identity.toLowerCase());
  if (candidates.some((m) => instant(m.date) === undefined)) return { status: "UNAVAILABLE", inbound: [] };
  const inbound = candidates.filter((m) => instant(m.date)! >= prepared).map((message) => ({ message, classification: classifyInbound(message, intent.recipient) }));
  return { status: "OK", inbound };
}

export type ExecutionMode = "READ_RECONCILE" | "EXTERNAL_ACTION_TEST" | "DRAFT_THEN_HUMAN_SEND" | "PROTECTED_AUTOMATED_SEND";

export interface RoutingMetadata {
  readonly action_key: string;
  readonly intent_ref: string;
  /** The intent's governed Action Type (W2.4D); UNGOVERNED when its recorded value is outside the contract. */
  readonly capability: "GMAIL_SEND" | "GMAIL_DRAFT" | "OTHER_EXTERNAL" | "UNGOVERNED";
  readonly execution_mode: ExecutionMode;
  readonly mailbox_identity: string;
  readonly recipient: string;
  readonly content_ref: string;
  readonly reconcile_window: { readonly since: string; readonly until: string };
  readonly t0_recheck_required: true;
  readonly send_authority: "NONE";
}

export type RouteOutcome =
  | { readonly kind: "ROUTED"; readonly disposition: "READ_ONLY" | "ELIGIBLE_FOR_NATIVE_TEST_SEND" | "DRAFT_ONLY" | "PERSIST_RECEIPT_NO_RESEND"; readonly routing: RoutingMetadata; readonly reconciliation: Reconciliation; readonly inbound: ReadonlyArray<{ message: MailboxMessage; classification: InboundClassification }>; readonly next_safe_action: string; readonly evidence: readonly string[] }
  | { readonly kind: "HOLD"; readonly code: HoldCode; readonly evidence: readonly string[]; readonly safe_action: string; readonly routing?: RoutingMetadata };

export interface RouteRequest {
  readonly plan: Plan | undefined;
  readonly intent: IntentView;
  readonly requested_action_key: string;
  readonly requested_intent_ref: string;
  readonly runtime_generation: string;
  readonly mode: ExecutionMode;
  readonly approved_test_scope?: { readonly from: string; readonly to: readonly string[] } | undefined;
  readonly source?: CompetentSource | undefined;
}

/**
 * Routing gate. Never sends. Produces routing metadata only when an exact FINAL-verified durable intent backs the
 * request and the fresh T-0 checks the harness can perform (competent-source reconciliation, inbound scan) pass.
 */
export async function routeExternalAction(receipts: ReceiptStore, req: RouteRequest): Promise<RouteOutcome> {
  const { plan, intent } = req;
  const routing: RoutingMetadata = { action_key: intent.action_key, intent_ref: intent.intent_ref, capability: "GMAIL_SEND", execution_mode: req.mode, mailbox_identity: intent.mailbox_identity, recipient: intent.recipient, content_ref: intent.subject_hint ?? "UNKNOWN", reconcile_window: { since: intent.prepared_at, until: intent.window_end }, t0_recheck_required: true, send_authority: "NONE" };
  const hold = (code: HoldCode, evidence: readonly string[], safe_action: string): RouteOutcome => ({ kind: "HOLD", code, evidence, safe_action, routing });

  // 1. Exact verified durable intent.
  if (!plan) return hold("HOLD_EXTERNAL_INTENT_NOT_VERIFIED", ["no backend plan backs this intent"], "prepare and verify the ExternalActionIntent (TARGET then FINAL) before any external action");
  if (plan.plan_state !== "FINAL_VERIFIED") return hold("HOLD_EXTERNAL_INTENT_NOT_VERIFIED", [`plan ${plan.plan_id} is ${plan.plan_state}, not FINAL_VERIFIED`], "finish os_verify(FINAL) for the intent transaction first");
  if (plan.runtime_generation !== req.runtime_generation) return hold("HOLD_EXTERNAL_INTENT_NOT_VERIFIED", [`intent plan belongs to runtime generation ${plan.runtime_generation}, binding is ${req.runtime_generation}`], "bind the runtime the intent belongs to; never route across runtimes");
  const finalReceipt = (await receipts.findByPlan(plan.plan_id, "FINAL"))[0];
  if (!finalReceipt) return hold("HOLD_EXTERNAL_INTENT_NOT_VERIFIED", [`plan ${plan.plan_id} has no FINAL receipt`], "finish os_verify(FINAL) for the intent transaction first");
  const op = plan.operations.find((o) => o.natural_key === intent.action_key);
  if (!op || req.requested_action_key !== intent.action_key || req.requested_intent_ref !== intent.intent_ref) return hold("HOLD_EXTERNAL_INTENT_NOT_VERIFIED", [`requested action_key/intent_ref (${req.requested_action_key} / ${req.requested_intent_ref}) do not match the verified intent (${intent.action_key} / ${intent.intent_ref})`], "route only the exact verified intent; never a substituted action key or record");
  if (!["PREPARED", "APPROVED"].includes(intent.effect_status)) return hold("HOLD_EXTERNAL_EFFECT_OBSERVED", [`intent effect status is ${intent.effect_status}; only PREPARED/APPROVED intents can be routed`], "reconcile the existing effect; do not send again");
  const now = new Date().toISOString();
  void now;

  // 2. Competent source: reconciliation + inbound (fresh T-0).
  if (!req.source) {
    if (req.mode === "READ_RECONCILE") return hold("HOLD_EXTERNAL_SOURCE_UNAVAILABLE", ["no competent source (Gmail) is available in this execution environment"], "reconcile through native Gmail (READ_RECONCILE) before any decision; no send, no replay");
    return hold("HOLD_EXTERNAL_SOURCE_UNAVAILABLE", ["Gmail competent source unavailable: automated effects and replays are refused"], "restore Gmail access; internal planning may continue if safe");
  }
  const rec = await reconcileIntent(intent, req.source);
  if (rec.status === "IDENTITY_MISMATCH") return hold("HOLD_MAILBOX_IDENTITY_MISMATCH", rec.evidence, "bind the mailbox that owns this Sales runtime; never send from another identity");
  if (rec.status === "UNAVAILABLE") return hold("HOLD_EXTERNAL_SOURCE_UNAVAILABLE", rec.evidence, "no send, no replay and no completion until Gmail is readable");
  if (rec.status === "AMBIGUOUS") return hold("HOLD_EXTERNAL_EFFECT_AMBIGUOUS", rec.evidence, "human reconciliation of the mailbox is required; refuse send and replay; create no Receipt");
  const inb = await inboundSincePrepared(intent, req.source);
  if (inb.status === "UNAVAILABLE") return hold("HOLD_EXTERNAL_SOURCE_UNAVAILABLE", ["the intent's thread is unreadable at T-0"], "no send until the exact thread can be read");
  const blocking = inb.inbound.filter((i) => i.classification.kind !== "TECHNICAL");
  if (rec.status === "OBSERVED") {
    return { kind: "ROUTED", disposition: "PERSIST_RECEIPT_NO_RESEND", routing, reconciliation: rec, inbound: inb.inbound, next_safe_action: `the effect already exists in Gmail (message ${rec.message_id}); do NOT send again. Prepare transaction B: Interaction + effect Receipt + Enrollment transition via os_prepare, then TARGET and FINAL`, evidence: rec.evidence };
  }
  if (blocking.length > 0 && req.mode !== "READ_RECONCILE") return hold("HOLD_INBOUND_BEFORE_DISPATCH", blocking.map((i) => `${i.classification.kind}/${i.classification.classification} inbound ${i.message.message_id} from ${i.message.from} at ${i.message.date}: ${i.classification.evidence.join("; ")}`), "cancel/hold the intent and hand the thread to a human; zero outbound sends after a HUMAN or UNKNOWN inbound");

  // 3. Mode eligibility (routing only — the send, if any, happens elsewhere).
  switch (req.mode) {
    case "READ_RECONCILE":
      return { kind: "ROUTED", disposition: "READ_ONLY", routing, reconciliation: rec, inbound: inb.inbound, next_safe_action: "effect not observed; the intent remains eligible for a fresh execution attempt with full T-0 checks in an eligible mode", evidence: rec.evidence };
    case "PROTECTED_AUTOMATED_SEND":
      return hold("HOLD_EXECUTOR_REQUIRED", ["automated / pre-approved production sends execute only through the deterministic Mail Executor after its own fresh T-0 checks (PV0-019A, PG9)"], "invoke the Mail Executor with intent_ref + action_key; no LLM path may send");
    case "DRAFT_THEN_HUMAN_SEND":
      return { kind: "ROUTED", disposition: "DRAFT_ONLY", routing, reconciliation: rec, inbound: inb.inbound, next_safe_action: "prepare the approved draft in the bound mailbox; a human performs the send; reconcile the effect afterwards exactly once", evidence: rec.evidence };
    case "EXTERNAL_ACTION_TEST": {
      const scope = req.approved_test_scope;
      if (!scope) return hold("HOLD_TEST_SCOPE_NOT_APPROVED", ["no owner-approved EXTERNAL_ACTION_TEST scope is configured"], "the Company Owner must approve a sender and test recipient before any native test send");
      if (scope.from !== intent.mailbox_identity.toLowerCase() || !scope.to.includes(intent.recipient.toLowerCase())) return hold("HOLD_TEST_SCOPE_NOT_APPROVED", [`intent ${intent.mailbox_identity} → ${intent.recipient} is outside the approved test scope ${scope.from} → ${scope.to.join(", ")}`], "refuse: only the approved sender/recipient pair may be used for a test send");
      return { kind: "ROUTED", disposition: "ELIGIBLE_FOR_NATIVE_TEST_SEND", routing, reconciliation: rec, inbound: inb.inbound, next_safe_action: `within the approved test scope: exactly one uniquely identifiable test message (action ${intent.action_key}) may be sent by the native Gmail capability; then read it back from Gmail and persist transaction B`, evidence: rec.evidence };
    }
  }
}

/** W4.1: source identity owns an event; runtime, recipient and thread only attribute it. */
export interface ExternalEventIdentity { readonly provider: string; readonly source_identity: string; readonly event_id: string }
const knownIdentityPart = (v: unknown): v is string => typeof v === "string" && v.trim() !== "" && v.trim().toUpperCase() !== "UNKNOWN";
const EXTERNAL_KEY = /^EXTERNAL_EVENT\/1:[0-9a-f]{64}$/;

/** Opaque, unambiguously encoded tuple. Provider-specific normalization belongs to the source adapter. */
export function externalIdentityKey(identity: ExternalEventIdentity): string | undefined {
  const parts = [identity.provider, identity.source_identity, identity.event_id];
  if (!parts.every(knownIdentityPart)) return undefined;
  return `EXTERNAL_EVENT/1:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}

export interface ManualSendCandidate { readonly message: MailboxMessage; readonly external_identity_key: string; readonly disposition: "MATERIALIZE_ONCE" | "ALREADY_RECONCILED" | "MATCHES_INTENT"; readonly intent_action_key?: string; readonly evidence: readonly string[] }

/**
 * Manual sends outside the OS: Gmail wins. Every outbound message to a recipient in the window that no intent explains
 * is identified by provider + authenticated mailbox + message_id. A receipt for that exact event means
 * ALREADY_RECONCILED; bare legacy message ids are refused, never used as cross-mailbox deduplication proof.
 */
export async function reconcileManualSends(source: CompetentSource, mailbox: string, recipient: string, window: { since: string; until: string }, intents: readonly IntentView[], receiptsByKey: ReadonlySet<string>): Promise<{ readonly status: "OK" | "UNAVAILABLE" | "IDENTITY_MISMATCH"; readonly candidates: readonly ManualSendCandidate[] }> {
  if ([...receiptsByKey].some((key) => !EXTERNAL_KEY.test(key))) return { status: "UNAVAILABLE", candidates: [] };
  const identity = await source.identity();
  if (!knownIdentityPart(identity) || !knownIdentityPart(mailbox)) return { status: "UNAVAILABLE", candidates: [] };
  if (identity.toLowerCase() !== mailbox.toLowerCase()) return { status: "IDENTITY_MISMATCH", candidates: [] };
  const bounds = boundedWindow(window.since, window.until);
  if (!bounds) return { status: "UNAVAILABLE", candidates: [] };
  const sent = await source.searchSent({ recipient, since: window.since, until: window.until });
  if (sent === "UNAVAILABLE" || !covered(sent, bounds)) return { status: "UNAVAILABLE", candidates: [] };
  // Gmail mailbox comparison is already case-insensitive; event ids remain opaque and case-sensitive.
  const keys = sent.map((message) => externalIdentityKey({ provider: "GMAIL", source_identity: identity.toLowerCase(), event_id: message.message_id }));
  if (keys.some((key) => key === undefined)) return { status: "UNAVAILABLE", candidates: [] };
  const candidates: ManualSendCandidate[] = sent.map((message, ordinal) => {
    const external_identity_key = keys[ordinal] as string;
    const intent = intents.find((i) => message.subject.includes(i.action_key) || (message.headers?.["x-vertigo-action-key"] ?? "") === i.action_key);
    if (intent) return { message, external_identity_key, disposition: "MATCHES_INTENT", intent_action_key: intent.action_key, evidence: [`message ${message.message_id} is the effect of intent ${intent.action_key}`] };
    if (receiptsByKey.has(external_identity_key)) return { message, external_identity_key, disposition: "ALREADY_RECONCILED", evidence: [`message ${message.message_id} already has a Receipt; no duplicate Interaction/Receipt`] };
    return { message, external_identity_key, disposition: "MATERIALIZE_ONCE", evidence: [`manual send ${message.message_id} (thread ${message.thread_id}, ${message.date}) has no intent and no Receipt: materialize exactly once as Interaction + Receipt under governing Sales rules`] };
  });
  return { status: "OK", candidates };
}
