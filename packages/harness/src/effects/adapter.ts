/**
 * SALES effect-plane state adapter (PV0-017A): binds the durable ExternalActionIntent record to the harness view
 * (IntentView), exposes routing metadata from verified durable state, and reconciles unresolved intents against
 * the competent source when one is available. Read-only; never sends.
 */
import type { ResumeState } from "../resume/derive.ts";
import type { ExternalActionIntent, NativeReconciliation } from "../resume/snapshot.ts";
import type { NotionReadClient } from "../notion/readClient.ts";
import type { HoldCode } from "../errors/codes.ts";
import type { Plan } from "../plans/store.ts";
import type { ResolvedRuntime } from "../resolvers/types.ts";
import type { HarnessDeps } from "../tools/handlers.ts";
import type { ReceiptRecord } from "../verify/engine.ts";
import { inboundSincePrepared, reconcileIntent, externalIdentityKey, type IntentView, type Reconciliation, type RoutingMetadata } from "./gmail.ts";
import { normalizeId, propText, propRelationIds, type Page } from "../notion/shapes.ts";
import { discoverDataSource, naturalKeyFilter, readSchema } from "../plans/resources.ts";
import { EXTERNAL_INTERACTION_PROPERTIES, EXTERNAL_RECEIPT_PROPERTIES } from "../versions/adapters/controlPlane.ts";
import { eventVersionAllowed } from "./eventWrite.ts";

export const RECONCILE_WINDOW_MS = 48 * 3600_000;

function mailboxOf(runtime: ResolvedRuntime): string {
  const m = runtime.observations["mailbox_identity"];
  return typeof m === "string" ? m : "UNKNOWN";
}

/** IntentView from a resume-time ExternalActionIntent row. */
export function intentViewFromRow(runtime: ResolvedRuntime, row: ExternalActionIntent): IntentView {
  const preparedProp = typeof row.prepared_at === "string" && row.prepared_at !== "UNKNOWN" && !Number.isNaN(Date.parse(row.prepared_at)) ? new Date(row.prepared_at).toISOString() : undefined;
  const prepared = preparedProp ?? (typeof row.last_edited === "string" && row.last_edited !== "UNKNOWN" ? row.last_edited : new Date(0).toISOString());
  return {
    intent_ref: row.ref,
    action_key: typeof row.action_key === "string" ? row.action_key : "UNKNOWN",
    mailbox_identity: mailboxOf(runtime),
    recipient: typeof row.recipient === "string" ? row.recipient : "UNKNOWN",
    prepared_at: prepared,
    window_end: new Date(Date.parse(prepared) + RECONCILE_WINDOW_MS).toISOString(),
    ...(typeof row.thread_ref === "string" && row.thread_ref !== "UNKNOWN" ? { thread_ref: row.thread_ref } : {}),
    ...(typeof row.subject === "string" && row.subject !== "UNKNOWN" ? { subject_hint: row.subject } : {}),
    effect_status: typeof row.effect_status === "string" ? row.effect_status : "UNKNOWN",
    ...(typeof row.approval_state === "string" ? { approval_state: row.approval_state } : {}),
  };
}

/** IntentView from a verified intent plan (target observations captured at TARGET). */
export function intentViewFromPlan(runtime: ResolvedRuntime, plan: Plan, targetReceipt: ReceiptRecord): IntentView | undefined {
  const catalog = runtime.adapter.controlPlane.resources ?? {};
  const op = plan.operations.find((o) => catalog[o.logical_resource_key]?.externalEffect);
  if (!op) return undefined;
  const t = (targetReceipt.observations["targets"] as Array<{ ordinal: number; target_ref: string; observed: Record<string, string | null> }> | undefined)?.find((x) => x.ordinal === op.ordinal);
  const ep = runtime.adapter.controlPlane.externalActionProps;
  const observed = t?.observed ?? {};
  const recipient = (ep?.recipient && observed[ep.recipient]) || (op.expected_values[ep?.recipient ?? "Recipient"] as string | undefined) || "UNKNOWN";
  const prepared = targetReceipt.observed_at.toISOString();
  return {
    intent_ref: t?.target_ref ?? op.physical_target_ref ?? "UNKNOWN",
    action_key: op.natural_key ?? "UNKNOWN",
    mailbox_identity: mailboxOf(runtime),
    recipient,
    prepared_at: prepared,
    window_end: new Date(targetReceipt.observed_at.getTime() + RECONCILE_WINDOW_MS).toISOString(),
    ...(ep?.threadRef && observed[ep.threadRef] ? { thread_ref: observed[ep.threadRef] as string } : {}),
    ...(ep?.subject && observed[ep.subject] ? { subject_hint: observed[ep.subject] as string } : {}),
    effect_status: (ep?.effectStatus && observed[ep.effectStatus]) || "PREPARED",
    ...(ep?.approvalState && observed[ep.approvalState] ? { approval_state: observed[ep.approvalState] as string } : {}),
  };
}

type Capability = RoutingMetadata["capability"];

/**
 * W2.4E: the routing capability of a recorded Action Type. Only an explicit contracted value routes; an absent,
 * UNKNOWN or otherwise non-governed Action Type is UNGOVERNED (never read in Gmail, never defaulted to GMAIL_SEND).
 */
function capabilityOf(actionType: unknown): Capability {
  if (actionType === "GMAIL_SEND" || actionType === "GMAIL_DRAFT" || actionType === "OTHER_EXTERNAL") return actionType;
  return "UNGOVERNED";
}

/** Why no contracted reader can reconcile this capability; undefined only for GMAIL_SEND (searchSent is competent). */
function noCompetentReader(capability: Capability): string | undefined {
  switch (capability) {
    case "GMAIL_SEND": return undefined;
    case "GMAIL_DRAFT": return "no contracted Gmail draft reader";
    case "OTHER_EXTERNAL": return "no competent source is contracted for OTHER_EXTERNAL";
    case "UNGOVERNED": return "the Action Type is not governed; no competent reader";
  }
}

/** The Action Type an intent plan carries: the value verified at TARGET, else the one it was prepared with. */
function planActionType(runtime: ResolvedRuntime, plan: Plan, targetReceipt: ReceiptRecord): unknown {
  const catalog = runtime.adapter.controlPlane.resources ?? {};
  const op = plan.operations.find((o) => catalog[o.logical_resource_key]?.externalEffect);
  const name = runtime.adapter.controlPlane.externalActionProps?.actionType;
  if (!op || !name) return undefined;
  const t = (targetReceipt.observations["targets"] as Array<{ ordinal: number; observed: Record<string, string | null> }> | undefined)?.find((x) => x.ordinal === op.ordinal);
  return t?.observed[name] ?? op.expected_values[name];
}

export function routingMetadata(intent: IntentView, capability: Capability): RoutingMetadata {
  return { action_key: intent.action_key, intent_ref: intent.intent_ref, capability, execution_mode: "READ_RECONCILE", mailbox_identity: intent.mailbox_identity, recipient: intent.recipient, content_ref: intent.subject_hint ?? "UNKNOWN", reconcile_window: { since: intent.prepared_at, until: intent.window_end }, t0_recheck_required: true, send_authority: "NONE" };
}

/** os_verify(FINAL) exposure for an intent plan: routing/context, never send Authority. */
export async function routingMetadataForPlan(deps: HarnessDeps, runtime: ResolvedRuntime, plan: Plan, targetReceipt: ReceiptRecord): Promise<(RoutingMetadata & { readonly effect_status: string; readonly note: string; readonly reconciliation?: Reconciliation }) | undefined> {
  const intent = intentViewFromPlan(runtime, plan, targetReceipt);
  if (!intent) return undefined;
  const capability = capabilityOf(planActionType(runtime, plan, targetReceipt));
  const why = noCompetentReader(capability);
  // searchSent is competent only for GMAIL_SEND: any other Action Type is never looked up in Gmail.
  const rec = !why && deps.competentSource ? await reconcileIntent(intent, deps.competentSource) : undefined;
  const note = `durable intent verified; NOT authorization at T-0 and NOT proof of an effect${why ? `; ${why}: the effect stays UNKNOWN — no send, no replay, no completion` : ""}`;
  return { ...routingMetadata(intent, capability), effect_status: intent.effect_status, note, ...(rec ? { reconciliation: rec } : {}) };
}

export interface ExternalActionsView {
  readonly unresolved: ReadonlyArray<ExternalActionIntent & { readonly routing: RoutingMetadata; readonly reconciliation: Reconciliation | { readonly status: "NOT_RECONCILED"; readonly evidence: readonly string[] }; readonly native_reconciliation?: NativeReconciliation; readonly inbound?: ReadonlyArray<{ readonly message_id: string; readonly from: string; readonly kind: string; readonly classification: string }> }>;
  readonly reconciliation_required: boolean;
  readonly competent_source: "GMAIL" | "NOT_APPLICABLE";
  /** Aggregate: a source is connected. Never per-intent proof — each row's `reconciliation` is (W2.4D). */
  readonly competent_source_available: boolean;
  /** Set when a Gmail-dependent decision is blocked; the caller must not send, replay or complete the intent. */
  readonly gmail_hold?: string;
  /** A competent source contradicts native bookkeeping; neither provenance is erased. */
  readonly native_conflict?: { readonly code: HoldCode; readonly evidence: readonly string[] };
}

/** Terminal bookkeeping for a caller capture, deliberately NOT a competent-source Reconciliation. */
export type { NativeReconciliation } from "../resume/snapshot.ts";

/** Read a unique, complete, owned pair for this exact intent. Never infer a Gmail effect from Notion. */
export async function readNativeReconciliation(notion: NotionReadClient, runtime: ResolvedRuntime, row: ExternalActionIntent): Promise<NativeReconciliation | undefined> {
  if (!eventVersionAllowed(runtime) || row.action_type !== "GMAIL_SEND") return undefined;
  try {
    const deps = { notion };
    const source = mailboxOf(runtime).trim().toLowerCase();
    if (!source || source === "unknown") return undefined;
    const schemas = [];
    for (const key of ["SALES:RECEIPTS", "SALES:INTERACTIONS", "SALES:CONTACTS", "SALES:ACCOUNTS"]) {
      const spec = runtime.adapter.controlPlane.resources?.[key];
      if (!spec) return undefined;
      const ds = await discoverDataSource(deps.notion, runtime, spec);
      const schema = ds.ok ? await readSchema(deps.notion, ds.ds) : undefined;
      if (!schema) return undefined;
      schemas.push(schema);
    }
    const [receipts, interactions, contacts, accounts] = schemas;
    if (!receipts || !interactions || !contacts || !accounts) return undefined;
    for (const [schema, required] of [[receipts, EXTERNAL_RECEIPT_PROPERTIES], [interactions, EXTERNAL_INTERACTION_PROPERTIES]] as const)
      if (Object.entries(required).some(([name, type]) => schema.properties.get(name) !== type)) return undefined;
    const owned = (p: Page, ds: string) => !p.archived && !p.in_trash && normalizeId(p.parent?.data_source_id) === ds;
    const completeRelation = (p: Page, name: string) => {
      const v = p.properties[name];
      return v?.type === "relation" && !("has_more" in v && v.has_more === true);
    };
    const one = async (ds: string, field: string, value: string): Promise<Page | undefined> => {
      const q = await deps.notion.queryDataSource(ds, naturalKeyFilter("rich_text", field, value), undefined, { page_size: 2 }) as { results?: Page[]; has_more?: boolean };
      return q.has_more === false && q.results?.length === 1 && owned(q.results[0]!, ds) && propText(q.results[0]!, field) === value ? q.results[0] : undefined;
    };
    const receipt = await one(receipts.id, "Intent Ref", normalizeId(row.ref) ?? "");
    if (!receipt || propText(receipt, "Receipt") !== "Gmail outbound capture" || propText(receipt, "Verified") !== "false" || propText(receipt, "Effect Status") !== "ATTESTED_SENT"
      || propText(receipt, "Provenance") !== "SOURCE_ATTESTED_BY_NATIVE_READ" || propText(receipt, "Provider") !== "GMAIL"
      || propText(receipt, "Event Type") !== "GMAIL_SEND" || propText(receipt, "Source Identity") !== source) return undefined;
    const event = propText(receipt, "Event ID"), occurred = propText(receipt, "Occurred At"), observed = propText(receipt, "Observed At");
    const key = event ? externalIdentityKey({ provider: "GMAIL", source_identity: source, event_id: event }) : undefined;
    const prepared = Date.parse(String(row.prepared_at));
    if (!key || !occurred || !observed || !Number.isFinite(prepared) || !Number.isFinite(Date.parse(occurred)) || !Number.isFinite(Date.parse(observed))
      || Date.parse(occurred) < prepared || Date.parse(occurred) > prepared + RECONCILE_WINDOW_MS || Date.parse(occurred) > Date.parse(observed)
      || propText(receipt, "Idempotency Key") !== key || propText(receipt, "Interaction Key") !== key) return undefined;
    const interaction = await one(interactions.id, "Event Key", key);
    if (!interaction || propText(interaction, "Interaction") !== "Gmail outbound" || propText(interaction, "Receipt Key") !== key || ["Provider", "Source Identity", "Event ID", "Thread ID", "Occurred At"].some((k) => !propText(receipt, k) || propText(interaction, k) !== propText(receipt, k))) return undefined;
    const contactRefs = propRelationIds(interaction, "Contacts"), accountRefs = propRelationIds(interaction, "Accounts");
    if (!contactRefs.length || contactRefs.length > 20 || !accountRefs.length || accountRefs.length > 20
      || new Set(contactRefs).size !== contactRefs.length || new Set(accountRefs).size !== accountRefs.length
      || !completeRelation(interaction, "Contacts") || !completeRelation(interaction, "Accounts")
      || interactions.relations.get("Contacts") !== contacts.id || interactions.relations.get("Accounts") !== accounts.id || contacts.relations.get("Account") !== accounts.id) return undefined;
    const linkedAccounts = new Set<string>(); let matchingContacts = 0;
    for (const ref of contactRefs) {
      const contact = await deps.notion.retrievePage(ref) as Page;
      const linked = propRelationIds(contact, "Account");
      if (!owned(contact, contacts.id) || linked.length !== 1 || !completeRelation(contact, "Account")) return undefined;
      const email = propText(contact, "Email")?.trim().toLowerCase();
      if (!email) return undefined;
      const matches = await deps.notion.queryDataSource(contacts.id, naturalKeyFilter(contacts.properties.get("Email"), "Email", email), undefined, { page_size: 2 }) as { results?: Page[]; has_more?: boolean };
      const sameEmail = matches.results?.filter((p) => propText(p, "Email")?.trim().toLowerCase() === email);
      if (matches.has_more !== false || sameEmail?.length !== 1 || normalizeId(sameEmail[0]?.id) !== normalizeId(ref) || !owned(sameEmail[0]!, contacts.id)) return undefined;
      const account = await deps.notion.retrievePage(linked[0]!) as Page;
      if (!owned(account, accounts.id)) return undefined;
      linkedAccounts.add(linked[0]!);
      if (email === String(row.recipient).trim().toLowerCase()) matchingContacts++;
    }
    if (matchingContacts !== 1 || JSON.stringify([...linkedAccounts].sort()) !== JSON.stringify([...accountRefs].sort())) return undefined;
    return { status: "ATTESTED_SENT", provenance: "SOURCE_ATTESTED_BY_NATIVE_READ", verified: false, receipt_ref: receipt.id, interaction_ref: interaction.id, event_key: key };
  } catch { return undefined; }
}

/** os_resume exposure: unresolved intents with routing metadata and, when a competent source exists, their reconciliation. */
export async function reconcileUnresolvedIntents(deps: HarnessDeps, runtime: ResolvedRuntime, ea: ResumeState["external_actions"]): Promise<ExternalActionsView> {
  const source = deps.competentSource;
  const out: ExternalActionsView["unresolved"][number][] = [];
  let hold: string | undefined;
  let native_conflict: ExternalActionsView["native_conflict"];
  for (const original of ea.unresolved) {
    const native = original.native_reconciliation;
    const row = { ...original, ...(native ? { native_reconciliation: native } : {}) };
    const intent = intentViewFromRow(runtime, row);
    const capability = capabilityOf(row.action_type);
    const routing = routingMetadata(intent, capability);
    // W2.4D: searchSent is competent only for GMAIL_SEND. Other Action Types keep their durable intent, are never
    // looked up in Gmail (no searchSent, no thread) and HOLD, even when the source is connected.
    const why = noCompetentReader(capability);
    if (why) { out.push({ ...row, routing, reconciliation: { status: "NOT_RECONCILED", evidence: [`Action Type ${row.action_type}: ${why}; the intent's effect is UNKNOWN — do not send, replay or complete it`] } }); hold = `intent ${intent.action_key} (${capability}): ${why}; the intent cannot be reconciled — no send, no replay, no completion`; continue; }
    if (!source) { out.push({ ...row, routing, reconciliation: { status: "NOT_RECONCILED", evidence: ["no competent source (Gmail) available; the intent's effect is UNKNOWN — do not send, replay or complete it"] } }); if (!native) hold = "Gmail competent source unavailable: unresolved intents cannot be reconciled; no send, no replay, no completion"; continue; }
    const rec = await reconcileIntent(intent, source);
    const inb = await inboundSincePrepared(intent, source);
    const inbound = inb.status === "OK" ? inb.inbound.map((i) => ({ message_id: i.message.message_id, from: i.message.from, kind: i.classification.kind, classification: i.classification.classification })) : [];
    out.push({ ...row, routing, reconciliation: rec, inbound });
    if (native) {
      const differentEvent = rec.status === "OBSERVED" && externalIdentityKey({ provider: "GMAIL", source_identity: mailboxOf(runtime), event_id: rec.message_id }) !== native.event_key;
      if (rec.status === "AMBIGUOUS" || rec.status === "IDENTITY_MISMATCH" || differentEvent) {
        native_conflict ??= { code: rec.status === "IDENTITY_MISMATCH" ? "HOLD_MAILBOX_IDENTITY_MISMATCH" : "HOLD_EXTERNAL_EFFECT_AMBIGUOUS",
          evidence: ["competent Gmail evidence contradicts the native capture; retain both provenances and reconcile without resend"] };
        hold = "Gmail evidence conflicts with the recorded native capture; human reconciliation required, never resend";
      }
      continue; // UNKNOWN/absence never erase native bookkeeping or fabricate OBSERVED.
    }
    if (rec.status === "AMBIGUOUS") hold = `intent ${intent.action_key}: Gmail reconciliation AMBIGUOUS — human reconciliation required; refuse send and replay`;
    else if (rec.status === "UNAVAILABLE" || rec.status === "IDENTITY_MISMATCH") hold = `intent ${intent.action_key}: ${rec.evidence.join("; ")}`;
    else if (rec.status === "OBSERVED") hold = hold ?? `intent ${intent.action_key}: effect already OBSERVED in Gmail (message ${rec.message_id}); persist transaction B, never resend`;
  }
  return { unresolved: out, reconciliation_required: ea.reconciliation_required, competent_source: ea.competent_source, competent_source_available: source !== undefined, ...(hold ? { gmail_hold: hold } : {}), ...(native_conflict ? { native_conflict } : {}) };
}
