/** W4.3: caller-attested outbound event -> two confined, independently read-back targets. No Gmail writer. */
import type { BindingRecord } from "../binding/store.ts";
import type { HoldCode } from "../errors/codes.ts";
import { normalizeId, propRelationIds, propText, type Page } from "../notion/shapes.ts";
import { discoverDataSource, naturalKeyFilter, queryAll, readSchema, type DataSourceSchema } from "../plans/resources.ts";
import type { Intent, IntentMutation } from "../plans/prepare.ts";
import type { Plan } from "../plans/store.ts";
import type { ResolvedRuntime } from "../resolvers/types.ts";
import type { HarnessDeps } from "../tools/handlers.ts";
import type { ExternalEventEvidence } from "../tools/surface.ts";
import { EXTERNAL_INTERACTION_PROPERTIES, EXTERNAL_RECEIPT_PROPERTIES, EXTERNAL_RECEIPT_OPTIONS, SALES_CONTROL_PLANE_0513_CANDIDATE } from "../versions/adapters/controlPlane.ts";
import { registerBuiltinSalesAdapters, type SalesContractAdapter } from "../versions/adapters/sales.ts";
import { MapAdapterRegistry, type SalesRuntimeAdapter } from "../versions/registry.ts";
import { externalIdentityKey } from "./gmail.ts";
import { RECONCILE_WINDOW_MS } from "./adapter.ts";
import type { OperationClassEntry } from "../guards/index.ts";
import type { ExternalActionIntent } from "../resume/snapshot.ts";
import { StructureCache } from "../notion/structureCache.ts";
import { SALES_CONTROL_PLANE_0514_CANDIDATE } from "../versions/adapters/controlPlane.ts";

export const INTERACTIONS = "SALES:INTERACTIONS";
export const RECEIPTS = "SALES:RECEIPTS";
// Version literals belong only to frozen adapter registrations, never a hardcoded "current" runtime.
const builtins = new MapAdapterRegistry<SalesRuntimeAdapter>();
registerBuiltinSalesAdapters(builtins);
const eventAdapters = builtins.supported().map((v) => builtins.resolve(v) as SalesContractAdapter)
  .filter((a) => a.grammar.controlPlane === SALES_CONTROL_PLANE_0513_CANDIDATE);
export const EXTERNAL_SPEC = eventAdapters.length === 1 ? eventAdapters[0]!.contractVersion : "";
export const EXTERNAL_SCHEMA = eventAdapters.length === 1 && eventAdapters[0]!.supportedSchemas.length === 1 ? eventAdapters[0]!.supportedSchemas[0]! : "";
export const isEventResource = (key: string) => key === INTERACTIONS || key === RECEIPTS;
const owned = new WeakSet<object>();
const ownedMutations = new WeakSet<object>();
const capturedIntent = new WeakMap<object, { ref: string; action_key: string; recipient: string; prepared_at: string }>();
export const isExternalEventIntent = (intent: Intent) => owned.has(intent);
/** Private factory marker, rechecked against the fresh durable intent; never a caller flag. */
export function nativeCaptureMatches(runtime: ResolvedRuntime, intent: Intent, row: ExternalActionIntent): boolean {
  const source = capturedIntent.get(intent);
  return eventVersionAllowed(runtime) && isExternalEventIntent(intent) && Object.isFrozen(intent)
    && intent.mutations.length === 2 && intent.mutations.every((m) => isExternalEventMutation(runtime, m))
    && source !== undefined && source.ref === row.ref && source.action_key === row.action_key
    && source.recipient === row.recipient && source.prepared_at === row.prepared_at
    && row.record_type === "INTENT" && row.action_type === "GMAIL_SEND"
    && (row.effect_status === "PREPARED" || row.effect_status === "APPROVED");
}
/** Object provenance, never a caller flag or a serialized authority. */
export function isExternalEventMutation(runtime: ResolvedRuntime, m: IntentMutation): boolean {
  const spec = runtime.adapter.controlPlane.resources?.[m.logical_resource_key];
  const required = m.logical_resource_key === INTERACTIONS ? EXTERNAL_INTERACTION_PROPERTIES : EXTERNAL_RECEIPT_PROPERTIES;
  return ownedMutations.has(m) && eventVersionAllowed(runtime) && isEventResource(m.logical_resource_key)
    && spec?.backendDerivedOnly === true && m.operation === "CREATE" && Object.isFrozen(m)
    && Object.keys(m.desired_changes).length === Object.keys(required).length
    && Object.keys(required).every((k) => Object.hasOwn(m.desired_changes, k));
}
function freezeDerived(value: object): void {
  for (const child of Object.values(value)) if (child !== null && typeof child === "object") freezeDerived(child);
  Object.freeze(value);
}
export const isExternalEventPlan = (plan: Plan) => plan.operations.length === 2
  && plan.operations[0]?.logical_resource_key === INTERACTIONS && plan.operations[1]?.logical_resource_key === RECEIPTS;
const mailbox = (v: string) => v.trim().toLowerCase();
const parent = (p: Page) => normalizeId(p.parent?.data_source_id) ?? normalizeId(p.parent?.database_id);
const live = (p: Page) => !p.archived && !p.in_trash;
const canonical = (value: unknown): string => value === null || typeof value !== "object" ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
/** Same immutable payload, not merely the same event key. No caller flag grants journal ownership. */
export const eventPlanMatchesCapture = (plan: Plan, intent: Intent) => isExternalEventPlan(plan)
  && plan.operations.every((op, i) => op.logical_resource_key === intent.mutations[i]?.logical_resource_key
    && canonical(op.expected_values) === canonical(intent.mutations[i]?.desired_changes));
export interface EventHold { readonly kind: "HOLD"; readonly code: HoldCode; readonly evidence: readonly string[]; readonly safe_action: string }
const hold = (code: HoldCode, structural: string): EventHold => ({ kind: "HOLD", code, evidence: [structural], safe_action: "reconcile the source, ownership or candidate schema; do not send or invent an effect" });

export function eventVersionAllowed(runtime: ResolvedRuntime): boolean {
  if (runtime.lane !== "SALES" || runtime.versions.governing_spec === "UNKNOWN" || runtime.versions.governing_schema === "UNKNOWN") return false;
  if (EXTERNAL_SPEC === "" || EXTERNAL_SCHEMA === "") return false;
  // Preserve the original exact-pins predicate verbatim for the historical line, including its disable switch.
  if (runtime.versions.governing_spec.value === EXTERNAL_SPEC && runtime.versions.governing_schema.value === EXTERNAL_SCHEMA) return true;
  const adapter = builtins.resolve(runtime.versions.governing_spec.value) as SalesContractAdapter | undefined;
  return adapter?.grammar.controlPlane === SALES_CONTROL_PLANE_0514_CANDIDATE
    && adapter.grammar.controlPlane === runtime.adapter.controlPlane && runtime.versions.governing_schema.value === EXTERNAL_SCHEMA
    && adapter.supportedSchemas.includes(runtime.versions.governing_schema.value);
}

export async function externalEventSourceOwned(deps: HarnessDeps, binding: BindingRecord, runtime: ResolvedRuntime, source: string): Promise<boolean> {
  try {
  const p = await deps.principals.get(binding.principal_id);
  if (!p || p.status !== "ACTIVE" || !p.rep_identity_key || !p.allowed_projects.includes(binding.project) || !p.allowed_lanes.includes("SALES")) return false;
  const assigned = await deps.salesRegistry.uniqueMailboxAssignment?.(source);
  return assigned?.status === "KNOWN" && assigned.rep_identity_key === p.rep_identity_key
    && normalizeId(assigned.root_ref) === normalizeId(runtime.root_ref)
    && assigned.expected_instance_id === runtime.runtime_id
    && assigned.expected_gmail_identity !== undefined && mailbox(assigned.expected_gmail_identity) === source
    && typeof runtime.observations["mailbox_identity"] === "string" && mailbox(runtime.observations["mailbox_identity"] as string) === source;
  } catch { return false; }
}

interface Stores { interactions: DataSourceSchema; receipts: DataSourceSchema; accounts: DataSourceSchema; contacts: DataSourceSchema }
async function stores(deps: HarnessDeps, runtime: ResolvedRuntime): Promise<Stores | undefined> {
  // Four independent read-only resolutions, on ONE globally paced client. No facts cross check boundaries.
  const schemas = await Promise.all([INTERACTIONS, RECEIPTS, "SALES:ACCOUNTS", "SALES:CONTACTS"].map(async (key) => {
    const spec = runtime.adapter.controlPlane.resources?.[key];
    if (!spec) return undefined;
    const ds = await discoverDataSource(deps.notion, runtime, spec);
    if (!ds.ok) return undefined;
    const schema = await readSchema(deps.notion, ds.ds);
    if (!schema) return undefined;
    return schema;
  }));
  if (schemas.some((s) => !s)) return undefined;
  const [interactions, receipts, accounts, contacts] = schemas as [DataSourceSchema, DataSourceSchema, DataSourceSchema, DataSourceSchema];
  for (const [schema, required, options] of [[interactions, EXTERNAL_INTERACTION_PROPERTIES, { Provider: ["GMAIL"] }],
    [receipts, EXTERNAL_RECEIPT_PROPERTIES, EXTERNAL_RECEIPT_OPTIONS]] as const) {
    if (Object.entries(required).some(([name, type]) => schema.properties.get(name) !== type)) return undefined;
    if (Object.entries(options).some(([name, allowed]) => allowed.some((v) => !schema.options.get(name)?.includes(v)))) return undefined;
  }
  if (interactions.relations.get("Accounts") !== accounts.id || interactions.relations.get("Contacts") !== contacts.id
    || contacts.relations.get("Account") !== accounts.id) return undefined;
  return { interactions, receipts, accounts, contacts };
}

async function exactRows(deps: HarnessDeps, ds: DataSourceSchema, field: string, value: string): Promise<Page[]> {
  return (await queryAll(deps.notion, ds.id, naturalKeyFilter(ds.properties.get(field), field, value))).filter((p) => live(p) && propText(p, field) === value);
}
function safeEvidenceRef(value: string): boolean {
  if (/^gmail:[^\s]+$/.test(value)) return true;
  try { const u = new URL(value); return u.protocol === "https:" && u.hostname === "mail.google.com" && !u.username && !u.password; } catch { return false; }
}

export async function deriveExternalEvent(deps: HarnessDeps, binding: BindingRecord, runtime: ResolvedRuntime, e: ExternalEventEvidence): Promise<{ kind: "READY"; intent: Intent } | EventHold> {
  try {
    if (!eventVersionAllowed(runtime)) return hold("HOLD_SCHEMA_MISMATCH", "native event capture requires the exact candidate contract/schema pins");
    const source = mailbox(e.source_identity);
    if (mailbox(e.message.from) !== source || !(await externalEventSourceOwned(deps, binding, runtime, source)))
      return hold("HOLD_MAILBOX_IDENTITY_MISMATCH", "capture sender/source does not have one matching bound mailbox assignment");
    if (!safeEvidenceRef(e.evidence_ref) || !Number.isFinite(Date.parse(e.message.date)) || !Number.isFinite(Date.parse(e.observed_at))
      || Date.parse(e.message.date) > Date.parse(e.observed_at)) return hold("HOLD_UNKNOWN_REQUIRED_FACT", "capture reference or event/capture instants are invalid");
    const s = await stores(deps, runtime);
    if (!s) return hold("HOLD_SCHEMA_MISMATCH", "candidate Interaction/Receipt schema, ATTESTED_SENT option or owned relation mapping is missing");
    const tos = e.message.to.map(mailbox);
    const refs = e.contact_refs.map(normalizeId);
    if (new Set(tos).size !== tos.length || new Set(refs).size !== refs.length || tos.length !== refs.length || refs.some((r) => !r))
      return hold("HOLD_TARGET_AMBIGUOUS", "recipient/Contact mapping is not a bijection");
    const foundEmails = new Set<string>(); const accountIds = new Set<string>();
    for (const ref of refs as string[]) {
      const contact = await deps.notion.retrievePage(ref) as Page;
      const email = mailbox(propText(contact, "Email") ?? "");
      const matches = (await queryAll(deps.notion, s.contacts.id, naturalKeyFilter(s.contacts.properties.get("Email"), "Email", email)))
        .filter((p) => live(p) && mailbox(propText(p, "Email") ?? "") === email);
      const account = propRelationIds(contact, "Account");
      if (!live(contact) || parent(contact) !== s.contacts.id || !tos.includes(email) || foundEmails.has(email) || matches.length !== 1
        || normalizeId(matches[0]?.id) !== ref || account.length !== 1) return hold("HOLD_TARGET_AMBIGUOUS", "Contact/recipient or canonical Account association is missing or ambiguous");
      foundEmails.add(email); accountIds.add(account[0]!);
    }
    // Validate distinct Account IDs after reading every Contact relation; no page facts leave this phase.
    for (const id of accountIds) {
      const a = await deps.notion.retrievePage(id) as Page;
      if (!live(a) || parent(a) !== s.accounts.id) return hold("HOLD_CROSS_RUNTIME", "Contact Account is outside the bound canonical store");
    }
    const key = externalIdentityKey({ provider: "GMAIL", source_identity: source, event_id: e.message.message_id });
    if (!key) return hold("HOLD_UNKNOWN_REQUIRED_FACT", "event identity is incomplete");
    let linkedIntent: Page | undefined;
    if (e.intent_ref) {
      const spec = runtime.adapter.controlPlane.resources?.["SALES:EXTERNAL_ACTIONS"];
      const ds = spec ? await discoverDataSource(deps.notion, runtime, spec) : undefined;
      const intent = await deps.notion.retrievePage(e.intent_ref) as Page;
      const action = propText(intent, "Action Key") ?? "";
      const marker = action !== "" && (e.message.action_key === action || (e.message.subject ?? "").split(/[^\p{L}\p{N}_-]+/u).includes(action));
      const prepared = Date.parse(propText(intent, "Prepared At") ?? "");
      // Existing effect plane's bounded reconciliation window, never an unbounded time/title match.
      if (!ds?.ok || !live(intent) || parent(intent) !== ds.ds || propText(intent, "Record Type") !== "INTENT"
        || propText(intent, "Action Type") !== "GMAIL_SEND" || !marker || !tos.includes(mailbox(propText(intent, "Recipient") ?? ""))
        || !Number.isFinite(prepared) || Date.parse(e.message.date) < prepared || Date.parse(e.message.date) > prepared + RECONCILE_WINDOW_MS)
        return hold("HOLD_TARGET_AMBIGUOUS", "capture does not exactly match the bound intent and its recipient/time window");
      linkedIntent = intent;
    }
    const common = { Provider: "GMAIL", "Source Identity": source, "Event ID": e.message.message_id,
      "Thread ID": e.message.thread_id, "Occurred At": new Date(e.message.date).toISOString() };
    const intent: Intent = { action_class: "RECONCILE_AS_IS", summary: "Reconcile native outbound capture (not backend-verified)", mutations: [
      { logical_resource_key: INTERACTIONS, operation: "CREATE", record_selector: { natural_key: key }, desired_changes: {
        Interaction: "Gmail outbound", "Event Key": key, ...common, "Receipt Key": key, Accounts: [...accountIds].sort(), Contacts: (refs as string[]).sort(),
      } },
      { logical_resource_key: RECEIPTS, operation: "CREATE", record_selector: { natural_key: key }, desired_changes: {
        Receipt: "Gmail outbound capture", "Idempotency Key": key, "Event Type": "GMAIL_SEND", ...common,
        "Observed At": new Date(e.observed_at).toISOString(), "Evidence Ref": e.evidence_ref, "Interaction Key": key,
        "Intent Ref": normalizeId(e.intent_ref) ?? "", Provenance: "SOURCE_ATTESTED_BY_NATIVE_READ", "Effect Status": "ATTESTED_SENT", Verified: false,
      } },
    ] };
    const plans = await deps.store.plans.listByRuntime(binding.project, binding.lane, binding.runtime_generation);
    const known = plans.filter((p) => isExternalEventPlan(p) && p.operations[0]?.expected_values["Event Key"] === key);
    // IDs validated in THIS derivation only, never returned or passed to executor/recovery checks.
    const ownership = { contacts: refs as string[], accounts: [...accountIds] };
    if (known.length > 0) {
      // Reuse only the original journal: exact final replay or its own partial recovery, never an UPSERT.
      const original = known.filter((p) => p.principal_id === binding.principal_id && p.runtime_id === runtime.runtime_id
        && eventPlanMatchesCapture(p, intent)).at(-1);
      if (!original || !(await eventPairCheck(deps, runtime, original.operations, original, ownership)))
        return hold("HOLD_DUPLICATE", "event pair or intent completion already exists or is inconsistent; no new pair was prepared");
      if (original.plan_state !== "FINAL_VERIFIED" && !(await deps.store.plans.findActive(binding.project, binding.lane, binding.runtime_generation)).some((p) => p.plan_id === original.plan_id))
        return hold("HOLD_DUPLICATE", "non-final event journal is no longer active; recover the original journal, never create another pair");
      if (original.plan_state === "FINAL_VERIFIED" && ((await exactRows(deps, s.interactions, "Event Key", key)).length !== 1
        || (await exactRows(deps, s.receipts, "Idempotency Key", key)).length !== 1))
        return hold("HOLD_DUPLICATE", "final event pair is incomplete; no missing target is re-created");
    } else if (!(await eventPairCheck(deps, runtime, intent.mutations.map((m) => ({ logical_resource_key: m.logical_resource_key,
      target_data_source_ref: m.logical_resource_key === INTERACTIONS ? s.interactions.id : s.receipts.id, expected_values: m.desired_changes })), undefined, ownership))) {
      return hold("HOLD_DUPLICATE", "event pair or intent completion already exists or is inconsistent; no new pair was prepared");
    }
    freezeDerived(intent);
    for (const mutation of intent.mutations) ownedMutations.add(mutation);
    owned.add(intent);
    if (linkedIntent) capturedIntent.set(intent, { ref: normalizeId(linkedIntent.id)!, action_key: propText(linkedIntent, "Action Key")!,
      recipient: propText(linkedIntent, "Recipient")!, prepared_at: propText(linkedIntent, "Prepared At")! });
    return { kind: "READY", intent };
  } catch { return hold("HOLD_UNKNOWN_REQUIRED_FACT", "candidate source, schema or business reference is unreadable; no values logged"); }
}

type EventOperation = Pick<Plan["operations"][number], "logical_resource_key" | "target_data_source_ref" | "expected_values">;
/** Read-only recovery preflight, before releasing a lease or creating a successor plan. */
export async function externalEventJournalConsistent(deps: HarnessDeps, runtime: ResolvedRuntime, plan: Plan): Promise<boolean> {
  try { return isExternalEventPlan(plan) && eventVersionAllowed(runtime) && await eventPairCheck(deps, runtime, plan.operations, plan); }
  catch { return false; }
}
/** Stored recovery authority is the journal, but each not-yet-completed CREATE still needs its approved class. */
export async function eventRecoveryClassesApproved(deps: HarnessDeps, plan: Plan, entries: readonly OperationClassEntry[]): Promise<boolean> {
  const journal = await deps.store.planWrites.list(plan.plan_id);
  return isExternalEventPlan(plan) && plan.operations.every((op, i) => {
    const row = journal.find((r) => r.symbol === `TARGET_${i}`);
    if (row && ["DONE", "OBSERVED"].includes(row.status)) return true;
    const required = Object.keys(op.logical_resource_key === INTERACTIONS ? EXTERNAL_INTERACTION_PROPERTIES : EXTERNAL_RECEIPT_PROPERTIES);
    return entries.filter((e) => e.resource_key === op.logical_resource_key && e.operation === "CREATE"
      && e.class === "RECONCILE_AS_IS" && e.date_field === undefined && e.type_option_ids === undefined
      && e.allowed_fields.length === required.length && required.every((k) => e.allowed_fields.includes(k))).length === 1;
  });
}
/** Under the runtime lease, accept only this plan's own journaled partial pair. */
async function eventPairCheck(deps: HarnessDeps, runtime: ResolvedRuntime, ops: readonly EventOperation[], plan: Plan | undefined,
  derivedOwnership?: { readonly contacts: readonly string[]; readonly accounts: readonly string[] }): Promise<boolean> {
  // One fresh structure view per check; page/query facts still reach the raw client on every read.
  // During derivation this may nest over its preparation cache. Execution/recovery callers stay raw.
  deps = { ...deps, notion: new StructureCache(deps.notion) };
  const s = await stores(deps, runtime);
  if (!s || ops[0]?.target_data_source_ref !== s.interactions.id || ops[1]?.target_data_source_ref !== s.receipts.id) return false;
  const contacts = ops[0]?.expected_values["Contacts"], accounts = ops[0]?.expected_values["Accounts"];
  if (!Array.isArray(contacts) || !Array.isArray(accounts)) return false;
  const sameIds = (a: readonly unknown[], b: readonly unknown[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  // Only derive may supply its private same-phase witness. All byte/recovery checks take the full fresh path.
  const alreadyReadHere = derivedOwnership && sameIds(derivedOwnership.contacts, contacts) && sameIds(derivedOwnership.accounts, accounts);
  if (!alreadyReadHere) {
    const ownedAccounts = new Set<string>();
    for (const ref of contacts) {
      if (typeof ref !== "string") return false;
      const contact = await deps.notion.retrievePage(ref) as Page;
      const linked = propRelationIds(contact, "Account");
      if (!live(contact) || parent(contact) !== s.contacts.id || linked.length !== 1) return false;
      ownedAccounts.add(linked[0]!);
    }
    if (JSON.stringify([...ownedAccounts].sort()) !== JSON.stringify([...accounts].sort())) return false;
    for (const id of ownedAccounts) {
      const account = await deps.notion.retrievePage(id) as Page;
      if (!live(account) || parent(account) !== s.accounts.id) return false;
    }
  }
  const key = ops[0]?.expected_values["Event Key"];
  if (typeof key !== "string" || ops[1]?.expected_values["Idempotency Key"] !== key) return false;
  const rows = [await exactRows(deps, s.interactions, "Event Key", key), await exactRows(deps, s.receipts, "Idempotency Key", key)];
  const journal = plan ? [...await deps.store.planWrites.list(plan.plan_id)] : [];
  if (plan?.recovers_plan_id) {
    // Only the same immutable capture's root/sibling journals may lend created IDs to recovery.
    for (const prior of await deps.store.plans.listByRuntime(plan.project, plan.lane, plan.runtime_generation)) {
      if (prior.plan_id === plan.plan_id || prior.principal_id !== plan.principal_id || prior.runtime_id !== plan.runtime_id
        || (prior.plan_id !== plan.recovers_plan_id && prior.recovers_plan_id !== plan.recovers_plan_id)
        || !isExternalEventPlan(prior) || canonical(prior.operations.map((o) => o.expected_values)) !== canonical(ops.map((o) => o.expected_values))) continue;
      journal.push(...await deps.store.planWrites.list(prior.plan_id));
    }
  } else if (plan?.plan_kind === "BUSINESS" && plan.run_mode === "OPEN_NEW" && (plan.plan_origin ?? "INTENT") === "INTENT") {
    // Bare recovery assesses the started root first, even when its expired direct child wrote a target.
    // Lend only that child's exact immutable journal; this witness is not new CREATE/lease authority.
    const run = journal.find((j) => j.symbol === "OPEN_RUN" && ["DONE", "OBSERVED"].includes(j.status))?.created_id;
    const scope = ["principal_id", "project", "lane", "runtime_logical_key", "runtime_id", "runtime_generation",
      "governing_spec_version", "governing_schema_version", "governing_control_version"] as const;
    const capture = (p: Plan) => canonical(p.operations.map(({ operation_id: _id, ...op }) => op));
    if (run) for (const prior of await deps.store.plans.listByRuntime(plan.project, plan.lane, plan.runtime_generation)) {
      if (prior.plan_id === plan.plan_id || prior.plan_kind !== "BUSINESS" || prior.run_mode !== "RECOVER_EXISTING"
        || prior.plan_origin !== "AUTO_RECOVERY" || prior.parent_plan_id !== plan.plan_id || prior.recovers_plan_id !== plan.plan_id
        || prior.run_ref !== run || !scope.every((field) => prior[field] === plan[field])
        || !isExternalEventPlan(prior) || capture(prior) !== capture(plan)) continue;
      journal.push(...await deps.store.planWrites.list(prior.plan_id));
    }
  }
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.length > 1) return false;
    if (rows[i]!.length === 0) {
      if (journal.some((j) => j.symbol === `TARGET_${i}` && ["DONE", "OBSERVED"].includes(j.status))) return false;
      continue;
    }
    const witnesses = journal.filter((j) => j.symbol === `TARGET_${i}` && ["SENT", "DONE", "OBSERVED"].includes(j.status));
    const row = witnesses[0];
    if (!row || !["SENT", "DONE", "OBSERVED"].includes(row.status)) return false;
    if (witnesses.some((j) => j.created_id && normalizeId(rows[i]![0]!.id) !== normalizeId(j.created_id))) return false;
    const page = rows[i]![0]!;
    if (parent(page) !== ops[i]!.target_data_source_ref) return false;
    if (Object.values(page.properties).some((p) => p.type === "relation" && p.has_more === true)) return false;
    for (const [field, expected] of Object.entries(ops[i]!.expected_values)) {
      if (Array.isArray(expected)) {
        if (JSON.stringify(propRelationIds(page, field).sort()) !== JSON.stringify([...expected].sort())) return false;
      } else if ((propText(page, field) ?? "") !== String(expected)) return false;
    }
  }
  const ref = ops[1]?.expected_values["Intent Ref"];
  if (typeof ref === "string" && ref !== "") {
    const receipts = (await exactRows(deps, s.receipts, "Intent Ref", ref)).filter((p) => propText(p, "Event Type") === "GMAIL_SEND");
    if (receipts.length > 1 || receipts.some((p) => propText(p, "Interaction Key") !== key)) return false;
  }
  return true;
}

/** The executor calls this immediately before every byte, including during journal recovery. */
export async function externalEventPlanStillOwned(deps: HarnessDeps, binding: BindingRecord, runtime: ResolvedRuntime, plan: Plan, clock: () => Date,
  readGuard?: () => Promise<boolean>): Promise<boolean> {
  try {
    const source = plan.operations[0]?.expected_values["Source Identity"];
    if (!isExternalEventPlan(plan) || !eventVersionAllowed(runtime) || typeof source !== "string"
      || !(await externalEventSourceOwned(deps, binding, runtime, source))) return false;
    // Separate RAW checks, no shared cache. Drain BOTH even on error; nothing may outlive the lease-LAST check.
    const [owned, guarded] = await Promise.allSettled([
      eventPairCheck(deps, runtime, plan.operations, plan), readGuard ? readGuard() : Promise.resolve(true),
    ]);
    if (owned.status !== "fulfilled" || !owned.value || guarded.status !== "fulfilled" || !guarded.value) return false;
    // Ownership/schema AND guard reads can yield: prove the lease LAST with a fresh clock, before bytes.
    const lease = await deps.store.leases.current({ project: binding.project, lane: binding.lane, runtime_generation: binding.runtime_generation }, clock());
    return lease?.plan_id === plan.plan_id;
  } catch { return false; }
}
