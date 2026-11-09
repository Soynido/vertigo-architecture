/**
 * Executor fixtures: a mutable canonical Sales state, a fixture mailbox whose transport appends to the same message
 * list the competent source reads (Gmail reality), and a FINAL-verified harness plan for the intent.
 * All identities are synthetic (TEST_* families, example.invalid addresses).
 */
import { SnapshotCompetentSource, type MailboxMessage } from "../../harness/src/effects/gmail.ts";
import type { Plan } from "../../harness/src/plans/store.ts";
import { createMemoryStore } from "../../harness/src/store/memory.ts";
import { synthetic } from "../../harness/test/unit/meta-fixtures.ts";
import { MemoryExecutionLedger } from "../src/ledger/memory.ts";
import type { Authority, Content, EnrollmentRecord, ExecutorDeps, IntentRecord, PartyState, ProtectedTransport, SalesStateReader, SendEnvelope, TransportResult } from "../src/types.ts";
import { harnessVerification } from "../src/verification.ts";

export const NOW = new Date("2030-02-01T10:00:00.000Z");
export const PREPARED = "2030-02-01T09:00:00.000Z";
export const WINDOW_END = "2030-02-03T09:00:00.000Z";
export const MAILBOX = "rep@example.invalid";
export const RECIPIENT = "prospect@example.invalid";
export const ID = { intent: synthetic("exec-intent"), contact: synthetic("exec-contact"), account: synthetic("exec-account"), enrollment: synthetic("exec-enrollment"), enrollment2: synthetic("exec-enrollment-2"), content: synthetic("exec-content"), run: synthetic("exec-run"), thread: "thread-exec-1" };
export const ACTION_KEY = "ak-exec-0001";
export const PLAN_ID = "plan-exec-0001";
export const AUTH_PIN = "TEST_AUTHORITY/1";
export const AUTH_CURRENT = "TEST_AUTHORITY/2";

export function intentRecord(over: Partial<IntentRecord> = {}): IntentRecord {
  return { intent_ref: ID.intent, action_key: ACTION_KEY, action_type: "OUTBOUND_STEP", run_ref: ID.run, harness_plan_id: PLAN_ID, contact_ref: ID.contact, account_ref: ID.account, enrollment_ref: ID.enrollment, owner: "rep-a", recipient: RECIPIENT, mailbox_identity: MAILBOX, thread_ref: ID.thread, sequence: { key: "seq-outbound-a", version: "1", step: 2 }, content_ref: ID.content, content_hash: "sha256:content-0001", prepared_at: PREPARED, window_end: WINDOW_END, pins: { contract: "TEST_SALES_CONTRACT/1", schema: "TEST_SALES_SCHEMA/1", authority: AUTH_PIN }, effect_status: "PREPARED", ...over };
}

export class FixtureSales implements SalesStateReader {
  intents = new Map<string, IntentRecord | "NOT_FOUND" | "UNAVAILABLE">([[ID.intent, intentRecord()]]);
  authorities = new Map<string, Authority>([[AUTH_PIN, { version: AUTH_PIN, requires_human_approval: false, allowed_action_types: ["OUTBOUND_STEP", "FOLLOW_UP"], max_sequence_step: 5 }], [AUTH_CURRENT, { version: AUTH_CURRENT, requires_human_approval: false, allowed_action_types: "ANY", max_sequence_step: 5 }]]);
  current: string | "UNAVAILABLE" = AUTH_CURRENT;
  parties = new Map<string, PartyState | "NOT_FOUND" | "UNAVAILABLE">([[ID.contact, { dnc: false, opt_out: false, bounced: false, hold: false, owner: "rep-a" }], [ID.account, { dnc: false, opt_out: false, bounced: false, hold: false, owner: "rep-a" }]]);
  enrollmentRows: EnrollmentRecord[] | "UNAVAILABLE" = [{ ref: ID.enrollment, status: "ACTIVE", contact_ref: ID.contact, owner: "rep-a", sequence_key: "seq-outbound-a" }, { ref: ID.enrollment2, status: "COMPLETED", contact_ref: ID.contact, owner: "rep-a", sequence_key: "seq-old" }];
  contents = new Map<string, Content | "NOT_FOUND" | "UNAVAILABLE">([[ID.content, { subject: `Step 2 [${ACTION_KEY}]`, body: "Hello from the fixture sequence.", content_hash: "sha256:content-0001" }]]);
  async intent(ref: string) { return this.intents.get(ref) ?? "NOT_FOUND"; }
  async currentAuthority() { return this.current === "UNAVAILABLE" ? "UNAVAILABLE" as const : (this.authorities.get(this.current) ?? "UNAVAILABLE" as const); }
  async authority(v: string) { return this.authorities.get(v) ?? "NOT_FOUND" as const; }
  async contact(ref: string) { return this.parties.get(ref) ?? "NOT_FOUND" as const; }
  async account(ref: string) { return this.parties.get(ref) ?? "NOT_FOUND" as const; }
  async enrollments() { return this.enrollmentRows; }
  async content(ref: string) { return this.contents.get(ref) ?? "NOT_FOUND" as const; }
  setIntent(over: Partial<IntentRecord>) { this.intents.set(ID.intent, intentRecord(over)); }
  setContact(over: Partial<PartyState>) { this.parties.set(ID.contact, { ...(this.parties.get(ID.contact) as PartyState), ...over }); }
  setAccount(over: Partial<PartyState>) { this.parties.set(ID.account, { ...(this.parties.get(ID.account) as PartyState), ...over }); }
}

export type TransportMode = "SEND" | "AMBIGUOUS_BUT_SENT" | "AMBIGUOUS_NOT_SENT" | "FAIL";
/** Gmail reality: one message list shared by the transport (writes) and the competent source (reads). */
export class FixtureMailbox {
  readonly messages: MailboxMessage[] = [];
  identity: string | "UNKNOWN" = MAILBOX;
  available = true;
  mode: TransportMode = "SEND";
  sends = 0;
  /** Clock used for the messages the transport produces. */
  clock = NOW;
  source(): SnapshotCompetentSource { return new SnapshotCompetentSource(this.identity, this.messages, this.available); }
  transport(): ProtectedTransport {
    return { send: async (e: SendEnvelope): Promise<TransportResult> => {
      this.sends++;
      if (this.mode === "FAIL") return { status: "FAILED", evidence: "fixture: HTTP 400 rejected" };
      if (this.mode === "AMBIGUOUS_NOT_SENT") return { status: "AMBIGUOUS", evidence: "fixture: client timeout before the request left" };
      const n = this.messages.length + 1;
      this.messages.push({ message_id: `msg-${n}`, thread_id: e.thread_id ?? `thread-${n}`, from: e.from, to: [e.to], subject: e.subject, date: this.clock.toISOString(), headers: Object.fromEntries(Object.entries(e.headers).map(([k, v]) => [k.toLowerCase(), v])) });
      if (this.mode === "AMBIGUOUS_BUT_SENT") return { status: "AMBIGUOUS", evidence: "fixture: client timeout after the request was accepted" };
      return { status: "SENT", message_id: `msg-${n}`, thread_id: e.thread_id ?? `thread-${n}` };
    } };
  }
  inbound(from: string, at: string, headers: Record<string, string> = {}, subject = "Re: Step 2"): void {
    this.messages.push({ message_id: `in-${this.messages.length + 1}`, thread_id: ID.thread, from, to: [MAILBOX], subject, date: at, headers });
  }
  manualOutbound(at: string): void {
    this.messages.push({ message_id: `manual-${this.messages.length + 1}`, thread_id: ID.thread, from: MAILBOX, to: [RECIPIENT], subject: "Quick note (manual)", date: at });
  }
}

export interface ExecWorld { readonly sales: FixtureSales; readonly mailbox: FixtureMailbox; readonly ledger: MemoryExecutionLedger; readonly deps: ExecutorDeps; readonly store: ReturnType<typeof createMemoryStore>; setPlanState(state: Plan["plan_state"]): Promise<void> }

export async function buildExecWorld(opts: { verified?: boolean } = {}): Promise<ExecWorld> {
  const store = createMemoryStore();
  const plan: Plan = { plan_id: PLAN_ID, plan_kind: "BUSINESS", principal_id: "p-owner", binding_id: "b-1", project: "VERTIGO", lane: "SALES", runtime_logical_key: "VERTIGO/SALES/rep-a", runtime_id: "rt-sales-a", runtime_generation: "gen-1", governing_spec_version: "TEST_SALES_CONTRACT/1", governing_schema_version: "TEST_SALES_SCHEMA/1", governing_control_version: "UNKNOWN", run_mode: "OPEN_NEW", execution_attempt_id: "att-plan", created_at: NOW, expires_at: new Date(NOW.getTime() + 900_000), baseline_runtime_revision: "r1", operations: [{ operation_id: "op-1", ordinal: 0, logical_resource_key: "SALES:EXTERNAL_ACTIONS", natural_key: ACTION_KEY, natural_key_property: "Action Key", physical_target_ref: ID.intent, idempotency_key: "idem-1", operation: "CREATE", compared_fields: [], before_values: {}, expected_values: {} }], stage1_writes: [], finalization_writes: [], state_last_write: { ordinal: 0, symbol: "S", target_ref: ID.intent, operation: "UPDATE", fields: {}, purpose: "STATE_LAST" }, plan_state: opts.verified === false ? "TARGET_VERIFIED" : "FINAL_VERIFIED" };
  await store.plans.insert(plan);
  if (opts.verified !== false) await store.receipts.insert({ receipt_id: "final-exec-1", type: "FINAL", plan_id: PLAN_ID, principal_id: "p-owner", runtime_id: "rt-sales-a", runtime_generation: "gen-1", observed_at: NOW, observations: {}, status: "VALID" });
  const sales = new FixtureSales();
  const mailbox = new FixtureMailbox();
  const ledger = new MemoryExecutionLedger();
  const deps: ExecutorDeps = { sales, verification: harnessVerification(store.plans, store.receipts), get source() { return mailbox.source(); }, get transport() { return mailbox.transport(); }, ledger };
  return { sales, mailbox, ledger, deps, store, setPlanState: (s) => store.plans.setState(PLAN_ID, s) };
}

export const req = (attempt = "att-1") => ({ intent_ref: ID.intent, action_key: ACTION_KEY, attempt_id: attempt });
