/**
 * Deterministic Mail Executor engine (PV0-019A). No LLM. The decision is a pure function of fresh canonical
 * reads + the action-key ledger; the protected transport is invoked only after every check PASSes, and the
 * effect is complete only once the competent source (Gmail) has been read back.
 */
import { inboundSincePrepared, reconcileIntent, type IntentView } from "../../harness/src/effects/gmail.ts";
import { strictest } from "./authority.ts";
import type { CheckResult, Decision, DecisionKind, ExecutionRequest, ExecutorDeps, IntentRecord, LedgerRow } from "./types.ts";

const DEFAULT_LEASE_MS = 120_000;
const ELIGIBLE_EFFECT = new Set(["PREPARED", "APPROVED"]);

function view(i: IntentRecord): IntentView {
  return { intent_ref: i.intent_ref, action_key: i.action_key, mailbox_identity: i.mailbox_identity, recipient: i.recipient, prepared_at: i.prepared_at, window_end: i.window_end, ...(i.thread_ref ? { thread_ref: i.thread_ref } : {}), effect_status: i.effect_status, ...(i.approval ? { approval_state: i.approval.state } : {}) };
}

class Refusal extends Error {
  readonly code: string; readonly kind: DecisionKind; readonly check: CheckResult; readonly next: string;
  constructor(code: string, kind: DecisionKind, check: CheckResult, next: string) { super(code); this.code = code; this.kind = kind; this.check = check; this.next = next; }
}
const refuse = (name: string, code: string, evidence: readonly string[], next = "resolve the refused check durably; a new execution attempt re-runs every T-0 check"): never => { throw new Refusal(code, "REFUSED", { name, result: "REFUSE", evidence }, next); };
const holdOn = (name: string, code: string, evidence: readonly string[], next: string): never => { throw new Refusal(code, "HOLD", { name, result: "HOLD", evidence }, next); };
const flag = (name: string, v: boolean | "UNKNOWN", what: string): void => { if (v === "UNKNOWN") refuse(name, "REFUSE_STATE_UNKNOWN", [`${what} is UNKNOWN`]); if (v === true) refuse(name, `REFUSE_${what.toUpperCase().replace(/[^A-Z]+/g, "_")}`, [`${what} is set`]); };

export async function execute(deps: ExecutorDeps, req: ExecutionRequest, now = new Date()): Promise<Decision> {
  const checks: CheckResult[] = [];
  const base = { action_key: req.action_key, intent_ref: req.intent_ref, attempt_id: req.attempt_id };
  const done = (decision: DecisionKind, code: string, evidence: readonly string[], gmail: boolean, next: string, effect?: Decision["effect"]): Decision => ({ decision, code, ...base, checks, evidence, gmail_send_called: gmail, ...(effect ? { effect } : {}), next_safe_action: next });
  if (!req.intent_ref?.trim() || !req.action_key?.trim() || !req.attempt_id?.trim()) return done("REFUSED", "REFUSE_INVALID_REQUEST", ["intent_ref, action_key and attempt_id are required; nothing else is accepted"], false, "pass the immutable reference set of a verified intent");

  // 0. Serialize by action_key.
  const acq = await deps.ledger.acquire(req.action_key, req.attempt_id, now, deps.leaseMs ?? DEFAULT_LEASE_MS);
  if (acq.kind === "HELD") return reconcileHeld(deps, req, acq.row, now, checks, done);
  const pass = (name: string, ...evidence: string[]) => checks.push({ name, result: "PASS", evidence });
  const record = async (state: "REFUSED" | "FAILED", evidence: readonly string[]) => deps.ledger.update(req.action_key, req.attempt_id, { state, evidence }, now);
  let gmailCalled = false;

  try {
    // 1. Exact eligible durable intent.
    const intent = await deps.sales.intent(req.intent_ref);
    if (intent === "NOT_FOUND" || intent === "UNAVAILABLE") refuse("INTENT", intent === "NOT_FOUND" ? "REFUSE_INTENT_NOT_FOUND" : "REFUSE_STATE_UNAVAILABLE", [`intent ${req.intent_ref}: ${intent}`]);
    const i = intent as IntentRecord;
    if (i.action_key !== req.action_key) refuse("INTENT", "REFUSE_ACTION_KEY_MISMATCH", [`intent ${i.intent_ref} carries action_key ${i.action_key}, requested ${req.action_key}`]);
    if (!ELIGIBLE_EFFECT.has(i.effect_status)) refuse("INTENT", "REFUSE_EFFECT_STATUS", [`effect status ${i.effect_status} is not PREPARED/APPROVED`], "reconcile the recorded effect; never send an intent that is not PREPARED/APPROVED");
    if (now.toISOString() < i.prepared_at || now.toISOString() > i.window_end) refuse("INTENT", "REFUSE_WINDOW", [`now ${now.toISOString()} is outside the intent window [${i.prepared_at}, ${i.window_end}]`]);
    for (const [k, v] of Object.entries({ recipient: i.recipient, mailbox_identity: i.mailbox_identity, contact_ref: i.contact_ref, account_ref: i.account_ref, enrollment_ref: i.enrollment_ref, owner: i.owner, content_ref: i.content_ref, content_hash: i.content_hash, harness_plan_id: i.harness_plan_id, authority_pin: i.pins.authority })) if (!v || v === "UNKNOWN") refuse("INTENT", "REFUSE_INTENT_INCOMPLETE", [`intent field ${k} is missing/UNKNOWN`]);
    pass("INTENT", `intent ${i.intent_ref} action ${i.action_key} ${i.effect_status}, window ok`);

    // 2. Harness verification of the intent transaction (Transaction A).
    const v = await deps.verification.finalVerified(i.harness_plan_id, i.action_key, i.intent_ref);
    if (!v.verified) refuse("VERIFIED_INTENT", "REFUSE_INTENT_NOT_VERIFIED", [v.evidence], "finish os_verify(FINAL) for the intent transaction; the executor never sends an unverified intent");
    pass("VERIFIED_INTENT", v.evidence);

    // 3. Authority: strictest of pinned and current.
    const current = await deps.sales.currentAuthority();
    if (current === "UNAVAILABLE") refuse("AUTHORITY", "REFUSE_STATE_UNAVAILABLE", ["current published Authority unavailable"]);
    const pinnedRead = await deps.sales.authority(i.pins.authority);
    if (pinnedRead === "NOT_FOUND" || pinnedRead === "UNAVAILABLE") refuse("AUTHORITY", "REFUSE_AUTHORITY_PIN_UNKNOWN", [`pinned Authority ${i.pins.authority}: ${pinnedRead}`]);
    const pinned = pinnedRead as Exclude<typeof pinnedRead, string>, cur = current as Exclude<typeof current, string>;
    const eff = strictest(pinned, cur);
    if (eff.send_paused) refuse("AUTHORITY", "REFUSE_AUTHORITY", [`sends are paused under ${eff.version}`]);
    if (eff.allowed_action_types !== "ANY" && !eff.allowed_action_types.includes(i.action_type)) refuse("AUTHORITY", "REFUSE_AUTHORITY", [`action type ${i.action_type} is not allowed under effective Authority ${eff.version} (allowed: ${eff.allowed_action_types.join(", ") || "none"})`]);
    if (typeof eff.max_sequence_step === "number" && i.sequence.step > eff.max_sequence_step) refuse("AUTHORITY", "REFUSE_AUTHORITY", [`sequence step ${i.sequence.step} exceeds max ${eff.max_sequence_step} under ${eff.version}`]);
    pass("AUTHORITY", `effective Authority ${eff.version} (pinned ${pinned.version}, current ${cur.version}) permits ${i.action_type} step ${i.sequence.step}`);

    // 4. Approval validity for this exact intent/context.
    if (eff.requires_human_approval || i.effect_status === "APPROVED") {
      const ap = i.approval;
      if (!ap || ap.state !== "APPROVED") refuse("APPROVAL", "REFUSE_APPROVAL_INVALID", [`HUMAN_APPROVAL required under ${eff.version}; approval state ${ap?.state ?? "NONE"}`]);
      const a = ap as NonNullable<typeof ap>;
      if (a.expires_at && a.expires_at <= now.toISOString()) refuse("APPROVAL", "REFUSE_APPROVAL_EXPIRED", [`approval expired at ${a.expires_at}`]);
      if (a.context_hash !== i.content_hash) refuse("APPROVAL", "REFUSE_APPROVAL_CONTEXT_MISMATCH", [`approval context ${a.context_hash ?? "NONE"} does not match intent content ${i.content_hash}`]);
      pass("APPROVAL", `approval valid for content ${i.content_hash}${a.expires_at ? ` until ${a.expires_at}` : ""}`);
    } else pass("APPROVAL", "not required by effective Authority");

    // 5. Exactly one eligible ACTIVE Enrollment for the Contact.
    const enr = await deps.sales.enrollments(i.contact_ref);
    if (enr === "UNAVAILABLE") refuse("ENROLLMENT", "REFUSE_STATE_UNAVAILABLE", ["enrollments unavailable"]);
    const active = (enr as readonly { ref: string; status: string; owner: string; sequence_key: string }[]).filter((e) => e.status === "ACTIVE");
    if (active.length !== 1) refuse("ENROLLMENT", "REFUSE_ENROLLMENT_NOT_UNIQUE", [`${active.length} ACTIVE enrollment(s) for contact ${i.contact_ref}: ${active.map((e) => e.ref).join(", ") || "none"}`]);
    const e = active[0] as { ref: string; status: string; owner: string; sequence_key: string };
    if (e.ref !== i.enrollment_ref || e.sequence_key !== i.sequence.key) refuse("ENROLLMENT", "REFUSE_ENROLLMENT_MISMATCH", [`active enrollment ${e.ref}/${e.sequence_key} is not the intent's ${i.enrollment_ref}/${i.sequence.key}`]);
    pass("ENROLLMENT", `exactly one ACTIVE enrollment ${e.ref} (${e.sequence_key})`);

    // 6. Contact + Account DNC / opt-out / bounce / hold.
    const contact = await deps.sales.contact(i.contact_ref);
    const account = await deps.sales.account(i.account_ref);
    if (contact === "NOT_FOUND" || contact === "UNAVAILABLE") refuse("SAFETY_STATE", "REFUSE_STATE_UNAVAILABLE", [`contact ${i.contact_ref}: ${contact}`]);
    if (account === "NOT_FOUND" || account === "UNAVAILABLE") refuse("SAFETY_STATE", "REFUSE_STATE_UNAVAILABLE", [`account ${i.account_ref}: ${account}`]);
    const c = contact as Exclude<typeof contact, string>, ac = account as Exclude<typeof account, string>;
    flag("SAFETY_STATE", c.dnc, "contact dnc"); flag("SAFETY_STATE", ac.dnc, "account dnc"); flag("SAFETY_STATE", c.opt_out, "contact opt out"); flag("SAFETY_STATE", c.bounced, "contact bounce"); flag("SAFETY_STATE", c.hold, "contact hold"); flag("SAFETY_STATE", ac.hold, "account hold");
    pass("SAFETY_STATE", "no DNC / opt-out / bounce / hold on contact or account");

    // 7. Ownership / coordination.
    if (c.owner === "UNKNOWN" || ac.owner === "UNKNOWN") refuse("OWNERSHIP", "REFUSE_STATE_UNKNOWN", ["owner UNKNOWN on contact or account"]);
    if (c.owner !== i.owner || e.owner !== i.owner) refuse("OWNERSHIP", "REFUSE_OWNERSHIP", [`intent owner ${i.owner}; contact owner ${c.owner}; enrollment owner ${e.owner}`]);
    if (c.coordination_lock || ac.coordination_lock) refuse("OWNERSHIP", "REFUSE_COORDINATION", [`coordination lock: ${c.coordination_lock ?? ac.coordination_lock}`]);
    pass("OWNERSHIP", `owner ${i.owner} on intent, contact and enrollment; no coordination lock`);

    // 8. Mailbox identity of the competent source.
    const identity = await deps.source.identity();
    if (identity === "UNKNOWN") refuse("MAILBOX", "REFUSE_SOURCE_UNAVAILABLE", ["competent source identity unknown"], "restore Gmail access; no send without a provable mailbox identity");
    if (identity.toLowerCase() !== i.mailbox_identity.toLowerCase()) refuse("MAILBOX", "REFUSE_MAILBOX_IDENTITY", [`source is ${identity}, intent mailbox is ${i.mailbox_identity}`], "never send from another identity");
    pass("MAILBOX", `competent source is ${identity}`);

    // 9. Exact thread at T-0: no HUMAN / UNKNOWN inbound since the intent was prepared.
    const iv = view(i);
    const inb = await inboundSincePrepared(iv, deps.source);
    if (inb.status === "UNAVAILABLE") refuse("THREAD", "REFUSE_SOURCE_UNAVAILABLE", [`thread ${i.thread_ref} unreadable at T-0`]);
    const blocking = inb.inbound.filter((x) => x.classification.kind !== "TECHNICAL");
    if (blocking.length > 0) refuse("THREAD", "REFUSE_INBOUND", blocking.map((x) => `${x.classification.kind}/${x.classification.classification} inbound ${x.message.message_id} from ${x.message.from} at ${x.message.date}`), "hand the thread to a human; zero outbound after a HUMAN or UNKNOWN inbound");
    pass("THREAD", `${inb.inbound.length} inbound since ${i.prepared_at}, none HUMAN/UNKNOWN`);

    // 10. No already-observed effect for this action key.
    const rec = await reconcileIntent(iv, deps.source);
    if (rec.status === "OBSERVED") {
      await deps.ledger.update(req.action_key, req.attempt_id, { state: "OBSERVED", message_id: rec.message_id, thread_id: rec.thread_id, observed_at: new Date(rec.observed_at), evidence: rec.evidence }, now);
      checks.push({ name: "PRIOR_EFFECT", result: "HOLD", evidence: rec.evidence });
      return done("ALREADY_OBSERVED", "EFFECT_ALREADY_OBSERVED", rec.evidence, false, "do NOT send; persist transaction B (Interaction + effect Receipt + Enrollment transition) for the observed message", { message_id: rec.message_id, thread_id: rec.thread_id, observed_at: rec.observed_at, mailbox_identity: rec.mailbox_identity, recipient: rec.recipient });
    }
    if (rec.status === "AMBIGUOUS") holdOn("PRIOR_EFFECT", "HOLD_EFFECT_AMBIGUOUS", rec.evidence, "human reconciliation of the mailbox; refuse send and replay");
    if (rec.status === "UNAVAILABLE" || rec.status === "IDENTITY_MISMATCH") refuse("PRIOR_EFFECT", "REFUSE_SOURCE_UNAVAILABLE", rec.evidence);
    pass("PRIOR_EFFECT", rec.evidence[0] ?? "effect proven absent in the bounded window");

    // 11. No manual / newer outbound making the intent obsolete.
    const othersRead = await deps.source.searchSent({ recipient: i.recipient, since: i.prepared_at, until: now.toISOString() });
    if (othersRead === "UNAVAILABLE") refuse("OBSOLESCENCE", "REFUSE_SOURCE_UNAVAILABLE", ["sent mail unreadable at T-0"]);
    const others = othersRead as Exclude<typeof othersRead, string>;
    if (others.length > 0) refuse("OBSOLESCENCE", "REFUSE_INTENT_OBSOLETE", others.map((m) => `outbound ${m.message_id} "${m.subject}" to ${i.recipient} at ${m.date} exists since the intent was prepared`), "reconcile the manual/new outbound exactly once; the intent is obsolete");
    pass("OBSOLESCENCE", `no outbound to ${i.recipient} since ${i.prepared_at}`);

    // 12. Content resolves from the durable ref and matches the verified hash.
    const content = await deps.sales.content(i.content_ref);
    if (content === "NOT_FOUND" || content === "UNAVAILABLE") refuse("CONTENT", "REFUSE_STATE_UNAVAILABLE", [`content ${i.content_ref}: ${content}`]);
    const ct = content as Exclude<typeof content, string>;
    if (ct.content_hash !== i.content_hash) refuse("CONTENT", "REFUSE_CONTENT_DRIFT", [`content ${i.content_ref} hash ${ct.content_hash} differs from verified ${i.content_hash}`]);
    pass("CONTENT", `content ${i.content_ref} matches ${i.content_hash}`);

    // SEND (only here), then readback.
    await deps.ledger.update(req.action_key, req.attempt_id, { state: "SENDING", evidence: ["all T-0 checks PASS"] }, now);
    gmailCalled = true;
    const sent = await deps.transport.send({ from: i.mailbox_identity, to: i.recipient, subject: ct.subject, body: ct.body, ...(i.thread_ref ? { thread_id: i.thread_ref } : {}), headers: { "X-Vertigo-Action-Key": i.action_key, "X-Vertigo-Intent-Ref": i.intent_ref } });
    if (sent.status === "FAILED") {
      await deps.ledger.update(req.action_key, req.attempt_id, { state: "FAILED", evidence: [sent.evidence] }, now);
      return done("HOLD", "HOLD_TRANSPORT_FAILED", [sent.evidence], true, "reconcile Gmail before any fresh attempt; a fresh attempt re-runs every T-0 check");
    }
    await deps.ledger.update(req.action_key, req.attempt_id, sent.status === "SENT" ? { state: "SENT_PENDING_READBACK", message_id: sent.message_id, thread_id: sent.thread_id, evidence: [`transport accepted: message ${sent.message_id} thread ${sent.thread_id}`] } : { state: "AMBIGUOUS_TRANSPORT", evidence: [sent.evidence] }, now);
    const back = await reconcileIntent({ ...iv, window_end: iv.window_end > now.toISOString() ? iv.window_end : now.toISOString() }, deps.source);
    if (back.status === "OBSERVED") {
      await deps.ledger.update(req.action_key, req.attempt_id, { state: "OBSERVED", message_id: back.message_id, thread_id: back.thread_id, observed_at: new Date(back.observed_at), evidence: back.evidence }, now);
      checks.push({ name: "READBACK", result: "PASS", evidence: back.evidence });
      return done("SENT_AND_OBSERVED", "EFFECT_OBSERVED", back.evidence, true, "persist transaction B: Interaction + effect Receipt + Enrollment transition via os_prepare, then TARGET and FINAL", { message_id: back.message_id, thread_id: back.thread_id, observed_at: back.observed_at, mailbox_identity: back.mailbox_identity, recipient: back.recipient });
    }
    checks.push({ name: "READBACK", result: "HOLD", evidence: back.evidence });
    return done(sent.status === "SENT" ? "SENT_READBACK_PENDING" : "HOLD", sent.status === "SENT" ? "HOLD_READBACK_PENDING" : "HOLD_TRANSPORT_AMBIGUOUS", [...(sent.status === "AMBIGUOUS" ? [sent.evidence] : []), ...back.evidence], true, "reconcile the effect from Gmail (competent source) before anything else; NEVER resend this action key");
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    checks.push(err.check);
    if (!gmailCalled) await record("REFUSED", err.check.evidence);
    return done(err.kind, err.code, [...err.check.evidence], gmailCalled, err.next);
  }
}

/** Another attempt holds (or held) this action key: observe its state and reconcile; never replay. */
async function reconcileHeld(deps: ExecutorDeps, req: ExecutionRequest, row: LedgerRow, now: Date, checks: CheckResult[], done: (d: DecisionKind, code: string, ev: string[], gmail: boolean, next: string, effect?: Decision["effect"]) => Decision): Promise<Decision> {
  const ev = [`action ${req.action_key} ledger state ${row.state} held by attempt ${row.attempt_id} (updated ${row.updated_at.toISOString()})`];
  checks.push({ name: "LOCK", result: "HOLD", evidence: ev });
  if (row.state === "OBSERVED" && row.message_id && row.thread_id) return done("ALREADY_OBSERVED", "EFFECT_ALREADY_OBSERVED", [...ev, ...row.evidence], false, "do NOT send; persist transaction B for the observed message", { message_id: row.message_id, thread_id: row.thread_id, observed_at: (row.observed_at ?? row.updated_at).toISOString(), mailbox_identity: "SEE_LEDGER", recipient: "SEE_LEDGER" });
  if (row.state === "CHECKING" || row.state === "SENDING") return done("REFUSED", "REFUSE_IN_FLIGHT", [...ev, "another execution attempt is in flight; this attempt sends nothing"], false, "wait for the in-flight attempt; then observe the ledger / Gmail");
  // SENT_PENDING_READBACK / AMBIGUOUS_TRANSPORT: the effect may exist; reconcile from Gmail, never replay.
  const intent = await deps.sales.intent(req.intent_ref);
  if (intent === "NOT_FOUND" || intent === "UNAVAILABLE") return done("HOLD", "HOLD_EFFECT_UNRESOLVED", [...ev, `intent ${req.intent_ref}: ${intent}`], false, "restore canonical state, then reconcile from Gmail; never resend");
  const rec = await reconcileIntent({ ...view(intent), window_end: now.toISOString() }, deps.source);
  if (rec.status === "OBSERVED") return done("ALREADY_OBSERVED", "EFFECT_ALREADY_OBSERVED", [...ev, ...rec.evidence], false, "do NOT send; persist transaction B for the observed message", { message_id: rec.message_id, thread_id: rec.thread_id, observed_at: rec.observed_at, mailbox_identity: rec.mailbox_identity, recipient: rec.recipient });
  return done("HOLD", "HOLD_EFFECT_UNRESOLVED", [...ev, ...rec.evidence, "a prior attempt reached the transport; absence within the window is not proof enough to replay"], false, "human reconciliation of the mailbox; never resend this action key automatically");
}
