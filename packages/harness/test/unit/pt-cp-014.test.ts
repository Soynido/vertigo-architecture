/**
 * PT-CP-014 — W2.4 EXTERNAL_ACTION context (CONTRACT_PACK/0.3.0-candidate, Sales 0.5.10 / schema 0.5.5 candidate).
 *
 * A Personal SALES runtime (rep A) with its own External Actions, Accounts, Contacts and Authority Matrix; beside it,
 * rep B's Accounts, Contacts and Authority Matrix, whose pages rep A's intents may name but must never serve. Every
 * id and value is synthetic; no seller data is copied.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { CONTEXT_POLICY, CONTEXT_SECTIONS, EXTERNAL_ACTION_SOURCE_KEYS, NEED_CONTEXT, type ContextPolicy } from "../../src/contractPack/catalog.ts";
import { externalActionSelected, readExternalActionSources, type ReconciledIntent } from "../../src/contractPack/externalActionSources.ts";
import { buildContractPack, type ContextSection, type ContractPack } from "../../src/contractPack/pack.ts";
import type { ExternalActionsView } from "../../src/effects/adapter.ts";
import type { CompetentSource } from "../../src/effects/gmail.ts";
import type { Page } from "../../src/notion/shapes.ts";
import type { ResolvedRuntime } from "../../src/resolvers/types.ts";
import { readControlPlane } from "../../src/resume/readers.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import { synthetic, text } from "./meta-fixtures.ts";
import { bindSales, buildSetupWorld, resume, runtimeOf, type SetupWorld } from "./pt-cp-012.fixtures.ts";
import { installDailyTable } from "./pt-cp-013.fixtures.ts";
import { R, runPage, SCHEMAS, setRowsIn } from "./resume-fixtures.ts";
import { IDS as SALES_IDS } from "./sales-fixtures.ts";

const K = EXTERNAL_ACTION_SOURCE_KEYS;
const KEYS = [K.INTENTS, K.PARTIES, K.AUTHORITY, K.STOPS] as const;
type Key = (typeof KEYS)[number];

// ─────────────────────────────── fixture world ───────────────────────────────

const rt = (s: string) => [text(s)];
const title = (s: string) => ({ type: "title", title: rt(s) });
const rich = (s: string) => ({ type: "rich_text", rich_text: s === "" ? [] : rt(s) });
const select = (name: string | null) => ({ type: "select", select: name === null ? null : { name } });
const uid = (prefix: string, number: number | null) => ({ type: "unique_id", unique_id: { prefix, number } });
const check = (v: boolean) => ({ type: "checkbox", checkbox: v });
const relation = (ids: readonly string[], has_more = false) => ({ type: "relation", relation: ids.map((id) => ({ id })), has_more });
const options = (...names: string[]) => ({ options: names.map((name) => ({ name })) });

const AA = ["Accounts", "Contacts", "Authority Matrix"] as const;
interface Tables { readonly accounts: string; readonly contacts: string; readonly matrix: string }

function installTables(m: Map<string, unknown>, root: string): Tables {
  const accounts = installDailyTable(m, root, "04 — DATA & EVIDENCE", AA[0], {}).ds;
  const contacts = installDailyTable(m, root, "04 — DATA & EVIDENCE", AA[1], {}).ds;
  const matrix = installDailyTable(m, root, "02 — SETUP & BUSINESS CONFIG", AA[2], {}).ds;
  m.set(`data_source:${accounts}`, { properties: { Company: { type: "title" }, "Account ID": { type: "unique_id" }, "Do Not Contact": { type: "checkbox" }, Notes: { type: "rich_text" } } });
  m.set(`data_source:${contacts}`, { properties: { Contact: { type: "title" }, "Contact ID": { type: "unique_id" }, "Do Not Contact": { type: "checkbox" }, Email: { type: "email" }, "Email Status": { type: "select", select: options("VERIFIED", "INVALID") }, Account: { type: "relation", relation: { data_source_id: accounts } } } });
  m.set(`data_source:${matrix}`, { properties: { Action: { type: "title" }, "Action Type": { type: "select", select: options("FIRST_EMAIL", "FOLLOWUP") }, "Authority ID": { type: "unique_id" }, Active: { type: "checkbox" }, Authority: { type: "select", select: options("HUMAN_APPROVAL", "AUTO_ALLOWED") }, "Allowed In Mode": { type: "multi_select", multi_select: options("LEARN", "GUARDED", "AUTONOMOUS") }, Preconditions: { type: "rich_text" }, "Stop Conditions": { type: "rich_text" } } });
  return { accounts, contacts, matrix };
}

const extSchema = (matrix: string) => ({
  properties: {
    ...SCHEMAS.salesExt.properties,
    "Record Type": { type: "select", select: options("INTENT") },
    "Effect Status": { type: "select", select: options("PREPARED", "APPROVED", "NOT_OBSERVED", "AMBIGUOUS", "OBSERVED", "SENT") },
    "Approval State": { type: "select", select: options("PENDING", "APPROVED", "REJECTED") },
    "Action Type": { type: "select", select: options("GMAIL_SEND", "GMAIL_DRAFT", "OTHER_EXTERNAL") },
    "Prepared At": { type: "date" },
    "Account Ref": { type: "rich_text" },
    "Contact Ref": { type: "rich_text" },
    "Authority Ref": { type: "relation", relation: { data_source_id: matrix } },
  },
});

interface AccountOpts { n: number; company?: string; dnc?: boolean }
interface ContactOpts { n: number; name?: string; dnc?: boolean; email?: string | null; status?: string | null; account?: readonly string[] }
interface RuleOpts { n: number | null; active?: boolean; authority?: string; modes?: readonly string[]; pre?: string; stop?: string }

const account = (id: string, o: AccountOpts) => ({ id, props: { Company: title(o.company ?? `Société ${o.n}`), "Account ID": uid("ACC", o.n), "Do Not Contact": check(o.dnc ?? false), Notes: rich("NONPROJECTED-ACCOUNT-NOTE") } });
const contact = (id: string, o: ContactOpts) => ({ id, props: { Contact: title(o.name ?? `Contact ${o.n}`), "Contact ID": uid("CON", o.n), "Do Not Contact": check(o.dnc ?? false), Email: { type: "email", email: o.email === undefined ? `c${o.n}@example.invalid` : o.email }, "Email Status": select(o.status === undefined ? "VERIFIED" : o.status), Account: relation(o.account ?? []) } });
const rule = (id: string, o: RuleOpts) => ({ id, props: { Action: title("Premier e-mail"), "Action Type": select("FIRST_EMAIL"), "Authority ID": uid("AUTH", o.n), Active: check(o.active ?? true), Authority: select(o.authority ?? "HUMAN_APPROVAL"), "Allowed In Mode": { type: "multi_select", multi_select: (o.modes ?? ["GUARDED", "LEARN"]).map((name) => ({ name })) }, Preconditions: rich(o.pre ?? "Contact vérifié et approuvé"), "Stop Conditions": rich(o.stop ?? "Réponse reçue ou désinscription") } });

type Row = { readonly id: string; readonly props: Record<string, unknown> };
const page = (ds: string, r: Row): Page => ({ object: "page", id: r.id, archived: false, parent: { type: "data_source_id", data_source_id: ds }, properties: r.props as Page["properties"] });

interface IntentOpts {
  key: string;
  type?: string;
  effect?: string;
  approval?: string;
  recipient?: string | null | "OMIT";
  thread?: string;
  prepared?: string | null;
  account?: string | "OMIT";
  contact?: string | "OMIT";
  authority?: readonly string[] | "OMIT";
  authorityHasMore?: boolean;
}

interface ExtWorld {
  readonly sw: SetupWorld;
  readonly runtime: ResolvedRuntime;
  readonly own: Tables;
  readonly rival: Tables;
  /** Rep A's own pages: two accounts, their contacts, one rule. */
  readonly ids: { readonly a1: string; readonly a2: string; readonly c1: string; readonly c2: string; readonly r1: string };
  setRows(ds: string, rows: readonly Row[]): void;
  setIntents(intents: readonly IntentOpts[]): void;
  intent(o: IntentOpts): Page;
}

async function buildExtWorld(): Promise<ExtWorld> {
  const sw = buildSetupWorld("B5_OUTREACH", 5);
  const runtime = await runtimeOf(sw);
  const m = sw.w.map;
  const own = installTables(m, runtime.root_ref);
  const rival = installTables(m, SALES_IDS("rep-b").root);
  m.set(`data_source:${R.salesExtDs}`, extSchema(own.matrix));
  const ids = { a1: synthetic("ea-a1"), a2: synthetic("ea-a2"), c1: synthetic("ea-c1"), c2: synthetic("ea-c2"), r1: synthetic("ea-r1") };
  const setRows = (ds: string, rows: readonly Row[]) => setRowsIn(m, ds, rows.map((r) => page(ds, r)));
  setRows(own.accounts, [account(ids.a1, { n: 101, company: "Acme" }), account(ids.a2, { n: 102, company: "Beta", dnc: true })]);
  setRows(own.contacts, [contact(ids.c1, { n: 201, name: "Ana", email: "ana@acme.example", account: [ids.a1] }), contact(ids.c2, { n: 202, name: "Bo", email: "bo@beta.example", status: "INVALID" })]);
  setRows(own.matrix, [rule(ids.r1, { n: 7 })]);
  const intent = (o: IntentOpts): Page => {
    const props: Record<string, unknown> = {
      Action: title("Envoyer"),
      "Record Type": select("INTENT"),
      "Effect Status": select(o.effect ?? "PREPARED"),
      "Approval State": select(o.approval ?? "PENDING"),
      "Action Key": rich(o.key),
      "Action Type": select(o.type ?? "GMAIL_SEND"),
      "Subject / Content Hash": rich("NONPROJECTED-SUBJECT"),
      "Thread ID / Context": rich(o.thread ?? ""),
      "Prepared At": { type: "date", date: o.prepared === null ? null : { start: o.prepared ?? "2030-01-01T09:00:00.000Z" } },
    };
    if (o.recipient !== "OMIT") props["Recipient"] = { type: "email", email: o.recipient === undefined ? "ana@acme.example" : o.recipient };
    if (o.account !== "OMIT") props["Account Ref"] = rich(o.account ?? ids.a1);
    if (o.contact !== "OMIT") props["Contact Ref"] = rich(o.contact ?? ids.c1);
    if (o.authority !== "OMIT") props["Authority Ref"] = relation(o.authority ?? [ids.r1], o.authorityHasMore ?? false);
    return { object: "page", id: synthetic(`ea-intent-${o.key}`), archived: false, last_edited_time: "2030-01-01T12:00:00.000Z", properties: props as Page["properties"] };
  };
  return {
    sw, runtime, own, rival, ids, setRows, intent,
    setIntents(intents) { setRowsIn(m, R.salesExtDs, intents.map(intent)); },
  };
}

// ─────────────────────────────── observation helpers ───────────────────────────────

const bag = (e: Envelope): Record<string, unknown> => (e.status === "OK" ? (e.result as Record<string, unknown>) : e.observations);
const packOf = (e: Envelope): ContractPack => bag(e)["contract_pack"] as ContractPack;
const sectionsOf = (p: ContractPack): readonly ContextSection[] => p.selected_context.contexts.find((c) => c.context === "EXTERNAL_ACTION")?.sections ?? [];
const sectionOf = (p: ContractPack, key: Key): ContextSection => {
  const s = sectionsOf(p).find((x) => x.section_key === key);
  assert.ok(s, "section " + key);
  return s;
};
const statusOf = (p: ContractPack) => Object.fromEntries(sectionsOf(p).map((s) => [s.section_key, s.source_status]));
const ALL = (status: "PRESENT" | "ABSENT") => Object.fromEntries(KEYS.map((k) => [k, status]));

/** The whole envelope MINUS the pack: the safety spine, byte-for-byte. */
function safetyView(e: Envelope): string {
  const c = JSON.parse(JSON.stringify(e)) as { result?: Record<string, unknown>; observations?: Record<string, unknown> };
  if (c.result) delete c.result["contract_pack"];
  if (c.observations) delete c.observations["contract_pack"];
  return JSON.stringify(c);
}

async function resumed(x: ExtWorld, hint = "SALES_EXTERNAL_ACTION"): Promise<{ readonly e: Envelope; readonly p: ContractPack; readonly bare: Envelope }> {
  const bound = await bindSales(x.sw);
  const bare = await resume(x.sw, bound.handle);
  x.sw.client.reset();
  const e = await resume(x.sw, bound.handle, hint);
  return { e, p: packOf(e), bare };
}

/** The contract readers, called directly: the four sources for a hand-built anchor. */
async function direct(x: ExtWorld, intents: readonly IntentOpts[], status: string | ((i: number) => string) = "NOT_RECONCILED") {
  // The very intent shape the safety rehydration builds, read from this world by the control-plane reader.
  x.setIntents(intents);
  const snap = await readControlPlane(x.sw.client, x.runtime);
  assert.ok(!("hold" in snap));
  const rows = snap.external_intents.map((row, i) => ({ ...row, reconciliation: { status: typeof status === "string" ? status : status(i) } })) as ReconciledIntent[];
  assert.equal(rows.length, intents.length);
  x.sw.client.reset();
  const sources = await readExternalActionSources(x.sw.client, x.runtime, "SALES", ["SALES_EXTERNAL_ACTION"], { unresolved_count: rows.length, intents: rows });
  return Object.fromEntries(sources.map((s) => [s.source_key, s])) as Record<Key, { source_key: string; status: "PRESENT" | "ABSENT"; rows: readonly Record<string, unknown>[] }>;
}
const st = (s: Awaited<ReturnType<typeof direct>>) => Object.fromEntries(KEYS.map((k) => [k, s[k].status]));

const GMAIL: IntentOpts = { key: "ak-001", type: "GMAIL_SEND", approval: "PENDING", recipient: "ana@acme.example", thread: "", prepared: "2030-01-01T09:00:00.000Z" };
const OTHER = (x: ExtWorld): IntentOpts => ({ key: "ak-002", type: "OTHER_EXTERNAL", effect: "APPROVED", approval: "APPROVED", recipient: null, thread: "ctx-2", prepared: "2030-01-01T10:00:00.000Z", account: x.ids.a2, contact: x.ids.c2 });

// ─────────────────────────────── PT-CP-014 ───────────────────────────────

test("PT-CP-014/a: EXTERNAL_ACTION declares four sections in the published order; both needs select it; no fourth context", () => {
  assert.deepEqual(CONTEXT_SECTIONS.EXTERNAL_ACTION.map((s) => [s.section_key, s.source_key]), KEYS.map((k) => [k, k]));
  assert.deepEqual(CONTEXT_SECTIONS.EXTERNAL_ACTION.map((s) => s.projected_keys), [
    ["action_key", "action_type", "effect_status", "approval_state", "recipient", "thread_context", "prepared_at"],
    ["action_key", "account_id", "company", "account_do_not_contact", "contact_id", "contact", "contact_do_not_contact", "email_status"],
    ["action_key", "rule_id", "declared_authority", "allowed_modes", "preconditions", "approval_state", "send_authority", "t0_recheck_required"],
    ["action_key", "stop_conditions", "account_do_not_contact", "contact_do_not_contact", "reconciliation_status", "competent_source"],
  ]);
  assert.equal(NEED_CONTEXT.SALES_EXTERNAL_ACTION, "EXTERNAL_ACTION");
  assert.equal(NEED_CONTEXT.SALES_EMAIL_RECONCILIATION, "EXTERNAL_ACTION");
  assert.deepEqual([...CONTEXT_POLICY.kinds], ["SETUP", "DAILY", "EXTERNAL_ACTION"]);
  assert.equal(externalActionSelected(["CURRENT_WORK"]), false);
  assert.equal(externalActionSelected(["SALES_EMAIL_RECONCILIATION"]), true);
});

test("PT-CP-014/b: os_resume HOLD transports the real content of a reliable snapshot; the HOLD stays first and grants nothing", async () => {
  const x = await buildExtWorld();
  x.setIntents([OTHER(x), GMAIL]);
  const { e, p, bare } = await resumed(x);
  assert.equal(e.status, "HOLD");
  assert.equal(e.code, bare.code, "the HOLD is the one of the resume without the need");
  assert.equal(safetyView(e), safetyView(bare), "the safety spine is byte-identical");
  assert.deepEqual(statusOf(p), { ...ALL("PRESENT"), [K.STOPS]: "ABSENT" }, "OTHER_EXTERNAL has no competent source: its stops are ABSENT");
  assert.deepEqual(sectionOf(p, K.INTENTS).items, [
    { action_key: "ak-001", action_type: "GMAIL_SEND", effect_status: "PREPARED", approval_state: "PENDING", recipient: "ana@acme.example", thread_context: "", prepared_at: "2030-01-01T09:00:00.000Z" },
    { action_key: "ak-002", action_type: "OTHER_EXTERNAL", effect_status: "APPROVED", approval_state: "APPROVED", recipient: "", thread_context: "ctx-2", prepared_at: "2030-01-01T10:00:00.000Z" },
  ], "ordered by Prepared At; an empty recipient or thread read as a fact stays visible as \"\"");
  assert.deepEqual(sectionOf(p, K.PARTIES).items, [
    { action_key: "ak-001", account_id: 101, company: "Acme", account_do_not_contact: false, contact_id: 201, contact: "Ana", contact_do_not_contact: false, email_status: "VERIFIED" },
    { action_key: "ak-002", account_id: 102, company: "Beta", account_do_not_contact: true, contact_id: 202, contact: "Bo", contact_do_not_contact: false, email_status: "INVALID" },
  ]);
  const authority = { rule_id: 7, declared_authority: "HUMAN_APPROVAL", allowed_modes: "LEARN,GUARDED", preconditions: "Contact vérifié et approuvé", send_authority: "NONE", t0_recheck_required: true };
  assert.deepEqual(sectionOf(p, K.AUTHORITY).items, [
    { action_key: "ak-001", ...authority, approval_state: "PENDING" },
    { action_key: "ak-002", ...authority, approval_state: "APPROVED" },
  ], "APPROVED is a fact of the intent, never a send authority");
  assert.deepEqual(sectionOf(p, K.STOPS).items, []);
  // Nothing outside the projection travels: no subject, no note, no page id of a referenced row.
  const served = JSON.stringify(p.selected_context);
  for (const hidden of ["NONPROJECTED-SUBJECT", "NONPROJECTED-ACCOUNT-NOTE", x.ids.a1, x.ids.c1, x.ids.r1]) assert.equal(served.includes(hidden), false, hidden);
  assert.equal(JSON.stringify({ evidence: (e as { evidence?: unknown }).evidence, warnings: e.warnings }).includes("Contact vérifié"), false, "values stay out of evidence and warnings");
  assert.equal(e.next.permitted_tool_call, bare.next.permitted_tool_call, "no tool call is added by the pack");
});

test("PT-CP-014/c: Gmail-only intents serve their stops with the competent-source symbol; the same context for both needs", async () => {
  const x = await buildExtWorld();
  x.setIntents([GMAIL, { ...GMAIL, key: "ak-003", type: "GMAIL_DRAFT", prepared: "2030-01-02T09:00:00.000Z" }]);
  for (const hint of ["SALES_EXTERNAL_ACTION", "SALES_EMAIL_RECONCILIATION"]) {
    const { p } = await resumed(x, hint);
    assert.deepEqual(statusOf(p), ALL("PRESENT"), hint);
    assert.deepEqual(sectionOf(p, K.STOPS).items, ["ak-001", "ak-003"].map((action_key) => ({
      action_key, stop_conditions: "Réponse reçue ou désinscription", account_do_not_contact: false, contact_do_not_contact: false, reconciliation_status: "NOT_RECONCILED", competent_source: "GMAIL",
    })), "no competent source in this world: NOT_RECONCILED, never a conclusion");
  }
});

test("PT-CP-014/d: normal os_resume with a verified source and zero intent serves four PRESENT empty sections, with no fanout", async () => {
  const x = await buildExtWorld();
  x.setIntents([]);
  const { e, p } = await resumed(x);
  assert.equal(e.status, "OK");
  assert.equal(e.code, "RESUMED");
  assert.deepEqual(statusOf(p), ALL("PRESENT"));
  for (const s of sectionsOf(p)) assert.deepEqual([s.items, s.available, s.omitted], [[], 0, 0]);
  for (const ds of [x.own.accounts, x.own.contacts, x.own.matrix]) assert.deepEqual(x.sw.client.on(ds), [], "nothing to verify, nothing read");
});

test("PT-CP-014/e: window 11 → 10 served + S6 omission; order Prepared At then Action Key; no twelfth candidate; no scan", async () => {
  const x = await buildExtWorld();
  const many: IntentOpts[] = Array.from({ length: 12 }, (_, i) => ({ ...GMAIL, key: `ak-${String(12 - i).padStart(2, "0")}`, prepared: i < 2 ? "2030-01-01T08:00:00.000Z" : `2030-01-01T${String(8 + i).padStart(2, "0")}:00:00.000Z` }));
  // The twelfth in order names a rival account: outside the window, it is neither read nor able to fail a section.
  many[11] = { ...many[11]!, account: synthetic("never-read-account") };
  x.setIntents(many);
  const r = await resumed(x);
  assert.deepEqual(statusOf(r.p), ALL("PRESENT"));
  for (const s of sectionsOf(r.p)) assert.deepEqual([s.served, s.available, s.omitted, s.truncated_by], [10, 11, 1, "ROWS_PER_SECTION"], s.section_key);
  assert.deepEqual(sectionOf(r.p, K.INTENTS).items.map((i) => i["action_key"]), ["ak-11", "ak-12", "ak-10", "ak-09", "ak-08", "ak-07", "ak-06", "ak-05", "ak-04", "ak-03"], "same instant: Action Key decides");
  assert.ok(r.p.selected_context.bounds.serialized_bytes <= 16384);
  const queried = x.sw.client.reads.filter((q) => q.op === "query").map((q) => q.id);
  for (const ds of [x.own.accounts, x.own.contacts, x.own.matrix]) assert.equal(queried.includes(ds), false, "no scan of a referenced database");
  assert.deepEqual(x.sw.client.reads.filter((q) => q.op === "page" && q.id === synthetic("never-read-account")), []);

  // A candidate INSIDE the window that fails makes its section ABSENT: the twelfth never takes its place.
  many[10] = { ...many[10]!, contact: "OMIT" };
  x.setIntents(many);
  const broken = await resumed(x);
  assert.deepEqual(statusOf(broken.p), { ...ALL("PRESENT"), [K.PARTIES]: "ABSENT", [K.STOPS]: "ABSENT" });
  assert.deepEqual(sectionOf(broken.p, K.PARTIES).items, [], "no partial row");
});

test("PT-CP-014/f: the anchor must be proven over the whole unresolved set, or the four sections are ABSENT", async () => {
  const x = await buildExtWorld();
  assert.deepEqual(st(await direct(x, [GMAIL, { ...GMAIL, prepared: "2030-01-03T09:00:00.000Z" }])), ALL("ABSENT"), "duplicate Action Key");
  assert.deepEqual(st(await direct(x, [GMAIL, { ...GMAIL, key: "ak-009", prepared: null }])), ALL("ABSENT"), "missing Prepared At");
  assert.deepEqual(st(await direct(x, [GMAIL, { ...GMAIL, key: "ak-009", prepared: "2030-01-03T09:00" }])), ALL("ABSENT"), "an offsetless time is undecidable");
  assert.deepEqual(st(await direct(x, [GMAIL, { ...GMAIL, key: "ak-009", prepared: "2030-01-03" }])), ALL("ABSENT"), "a day cannot be ordered against an instant");
  assert.deepEqual(st(await direct(x, [{ ...GMAIL, prepared: "2030-01-03" }, { ...GMAIL, key: "ak-009", prepared: "2030-01-02" }])), ALL("PRESENT"), "days alone are ordered");
  assert.deepEqual(st(await direct(x, [{ ...GMAIL, key: "" }])), ALL("ABSENT"), "empty Action Key");
  // An unverified source, a missing anchor or another lane: ABSENT with zero reads.
  const poison = new Proxy({}, { get() { throw new Error("unexpected read"); } }) as never;
  const one = (await direct(x, [GMAIL]))[K.INTENTS];
  assert.equal(one.status, "PRESENT");
  const rows = [] as ReconciledIntent[];
  for (const anchor of [undefined, { unresolved_count: "UNKNOWN" as const, intents: rows }, { unresolved_count: 1, intents: rows }]) {
    const s = await readExternalActionSources(poison, x.runtime, "SALES", ["SALES_EXTERNAL_ACTION"], anchor);
    assert.deepEqual(s.map((v) => [v.source_key, v.status]), KEYS.map((k) => [k, "ABSENT"]));
  }
  const meta = await readExternalActionSources(poison, x.runtime, "META", ["SALES_EXTERNAL_ACTION"], { unresolved_count: 0, intents: [] });
  assert.deepEqual(meta.map((v) => v.status), ["ABSENT", "ABSENT", "ABSENT", "ABSENT"]);
  assert.deepEqual(await readExternalActionSources(poison, x.runtime, "SALES", ["CURRENT_WORK"], { unresolved_count: 0, intents: [] }), [], "not selected, nothing read");
});

test("PT-CP-014/f2: Prepared At is parsed, never rolled over: an impossible date, time or offset makes the anchor undecidable", async () => {
  const x = await buildExtWorld();
  const instant = (prepared: string) => [GMAIL, { ...GMAIL, key: "ak-009", prepared }];
  for (const impossible of [
    "2030-02-30T09:00:00.000Z", "2030-02-29T09:00:00Z", "2100-02-29T09:00:00Z", "2030-04-31T09:00:00Z", "2030-13-01T09:00:00Z", "2030-00-10T09:00:00Z", "2030-01-00T09:00:00Z",
    "2030-01-01T24:00:00Z", "2030-01-01T23:60:00Z", "2030-01-01T23:59:60Z",
    "2030-01-01T09:00:00+24:00", "2030-01-01T09:00:00-23:60", "2030-01-01T09:00:00+0100", "2030-01-01T09:00:00+01",
    // The offset never repairs the civil date: 2030-02-29 does not exist, even though this instant would fall on 02-28Z.
    "2030-02-29T00:30:00+01:00",
  ]) assert.deepEqual(st(await direct(x, instant(impossible))), ALL("ABSENT"), impossible);
  for (const impossible of ["2030-02-30", "2029-02-29", "1900-02-29", "2030-11-31"]) {
    assert.deepEqual(st(await direct(x, [{ ...GMAIL, prepared: "2030-01-03" }, { ...GMAIL, key: "ak-009", prepared: impossible }])), ALL("ABSENT"), impossible);
  }
  for (const possible of ["2028-02-29T09:00:00Z", "2000-02-29T09:00:00Z", "2030-01-01T09:00:00+23:59", "2030-01-01T09:00:00-23:59", "2030-01-01T09:00:00-00:00"]) {
    assert.deepEqual(st(await direct(x, instant(possible))), ALL("PRESENT"), possible);
  }
  assert.deepEqual(st(await direct(x, [{ ...GMAIL, prepared: "2028-02-29" }, { ...GMAIL, key: "ak-009", prepared: "2000-02-29" }])), ALL("PRESENT"), "leap days exist");

  // Order is the instant, not the text: offsets crossing midnight and a leap day, and nanoseconds before Action Key.
  const order = async (intents: readonly IntentOpts[]) => (await direct(x, intents))[K.INTENTS].rows.map((r) => r["action_key"]);
  assert.deepEqual(await order([
    { ...GMAIL, key: "ak-a", prepared: "2028-03-01T00:15:00+01:00" }, // 2028-02-29T23:15Z
    { ...GMAIL, key: "ak-b", prepared: "2028-02-29T23:30:00-01:00" }, // 2028-03-01T00:30Z
    { ...GMAIL, key: "ak-c", prepared: "2028-03-01T00:00:00Z" },
    { ...GMAIL, key: "ak-d", prepared: "2028-03-01T23:00:00+23:59" }, // 2028-02-29T23:01Z
  ]), ["ak-d", "ak-a", "ak-c", "ak-b"]);
  assert.deepEqual(await order([
    { ...GMAIL, key: "ak-1", prepared: "2030-01-01T09:00:00.000000002Z" },
    { ...GMAIL, key: "ak-2", prepared: "2030-01-01T09:00:00.000000001Z" },
    { ...GMAIL, key: "ak-3", prepared: "2030-01-01T09:00:00.000000001+00:00" },
  ]), ["ak-2", "ak-3", "ak-1"], "sub-millisecond digits decide; equal instants fall back to Action Key");
});

test("PT-CP-014/g: parties come only from explicit references verified in the instance; foreign, missing or divergent ⇒ ABSENT", async () => {
  const x = await buildExtWorld();
  const rivalAccount = synthetic("rival-account");
  x.setRows(x.rival.accounts, [account(rivalAccount, { n: 101, company: "Acme" })]);
  const cases: [string, IntentOpts][] = [
    ["foreign account page", { ...GMAIL, account: rivalAccount }],
    ["account ref is a URL, not a UUID", { ...GMAIL, account: `https://www.notion.so/${x.ids.a1}` }],
    ["missing account ref", { ...GMAIL, account: "OMIT" }],
    ["contact ref names an account", { ...GMAIL, contact: x.ids.a1 }],
    ["contact's own account differs", { ...GMAIL, account: x.ids.a2 }],
    ["unknown page", { ...GMAIL, contact: synthetic("no-such-contact") }],
  ];
  for (const [label, o] of cases) {
    assert.deepEqual(st(await direct(x, [o])), { ...ALL("PRESENT"), [K.PARTIES]: "ABSENT", [K.STOPS]: "ABSENT" }, label);
  }
  // The rival's page is at most read to be refused; its values never reach a section.
  const s = await direct(x, [{ ...GMAIL, account: rivalAccount }]);
  assert.equal(JSON.stringify(s).includes("Acme"), false);
});

test("PT-CP-014/h: Gmail recipient equals the contact's e-mail exactly after trim; OTHER_EXTERNAL assumes no equality", async () => {
  const x = await buildExtWorld();
  const parties = async (o: IntentOpts) => (await direct(x, [o]))[K.PARTIES].status;
  assert.equal(await parties({ ...GMAIL, recipient: "  ana@acme.example " }), "PRESENT", "edges only");
  assert.equal(await parties({ ...GMAIL, recipient: "Ana@acme.example" }), "ABSENT", "case preserved");
  assert.equal(await parties({ ...GMAIL, recipient: "bo@beta.example" }), "ABSENT", "another contact's address");
  const noRecipient = await direct(x, [{ ...GMAIL, recipient: null }]);
  assert.deepEqual(st(noRecipient), { ...ALL("PRESENT"), [K.PARTIES]: "ABSENT" }, "a missing address does not erase the intent");
  assert.equal(noRecipient[K.INTENTS].rows[0]!["recipient"], "");
  x.setRows(x.own.contacts, [contact(x.ids.c1, { n: 201, name: "Ana", email: null, account: [x.ids.a1] })]);
  assert.equal(await parties(GMAIL), "ABSENT", "the contact holds no address");
  assert.equal(await parties({ ...OTHER(x), account: x.ids.a1, contact: x.ids.c1, recipient: "ana@acme.example" }), "PRESENT", "OTHER_EXTERNAL");
});

test("PT-CP-014/i: an intent codec failure is local to the sections that need the value", async () => {
  const x = await buildExtWorld();
  assert.deepEqual(st(await direct(x, [{ ...GMAIL, recipient: "OMIT" }])), { ...ALL("PRESENT"), [K.INTENTS]: "ABSENT", [K.PARTIES]: "ABSENT" }, "an unreadable recipient is never invented as empty");
  assert.deepEqual(st(await direct(x, [{ ...GMAIL, approval: "MAYBE" }])), { ...ALL("PRESENT"), [K.INTENTS]: "ABSENT", [K.AUTHORITY]: "ABSENT" }, "ungoverned Approval State");
  assert.deepEqual(st(await direct(x, [{ ...GMAIL, type: "SMS_SEND" }])), { ...ALL("PRESENT"), [K.INTENTS]: "ABSENT", [K.PARTIES]: "ABSENT", [K.STOPS]: "ABSENT" }, "ungoverned Action Type");
  const incomplete = await direct(x, [{ ...GMAIL, recipient: null, thread: "" }]);
  assert.equal(incomplete[K.INTENTS].status, "PRESENT", "an incomplete intent stays visible for orientation");
  assert.deepEqual([incomplete[K.INTENTS].rows[0]!["recipient"], incomplete[K.INTENTS].rows[0]!["thread_context"]], ["", ""]);
});

test("PT-CP-014/j: the linked rule is singular, of this instance, active and complete; its codec is canonical", async () => {
  const x = await buildExtWorld();
  const rivalRule = synthetic("rival-rule");
  x.setRows(x.rival.matrix, [rule(rivalRule, { n: 7 })]);
  const r2 = synthetic("ea-r2");
  const authority = async (o: IntentOpts, r?: RuleOpts) => {
    if (r) x.setRows(x.own.matrix, [rule(x.ids.r1, r), rule(r2, { n: 8 })]);
    else x.setRows(x.own.matrix, [rule(x.ids.r1, { n: 7 }), rule(r2, { n: 8 })]);
    return st(await direct(x, [o]));
  };
  const ruleAbsent = { ...ALL("PRESENT"), [K.AUTHORITY]: "ABSENT", [K.STOPS]: "ABSENT" };
  assert.deepEqual(await authority({ ...GMAIL, authority: [] }), ruleAbsent, "no linked rule");
  assert.deepEqual(await authority({ ...GMAIL, authority: [x.ids.r1, r2] }), ruleAbsent, "two linked rules");
  assert.deepEqual(await authority({ ...GMAIL, authorityHasMore: true }), ruleAbsent, "a truncated relation");
  assert.deepEqual(await authority({ ...GMAIL, authority: "OMIT" }), ruleAbsent, "no Authority Ref column");
  assert.deepEqual(await authority({ ...GMAIL, authority: [rivalRule] }), ruleAbsent, "a rival rule");
  for (const [label, r] of [
    ["inactive", { n: 7, active: false }],
    ["no Authority ID", { n: null }],
    ["zero Authority ID", { n: 0 }],
    ["ungoverned Authority", { n: 7, authority: "SEND_ANYTHING" }],
    ["no mode", { n: 7, modes: [] }],
    ["unknown mode", { n: 7, modes: ["LEARN", "TURBO"] }],
    ["duplicated mode", { n: 7, modes: ["LEARN", "LEARN"] }],
    ["empty preconditions", { n: 7, pre: " " }],
    ["empty stop conditions", { n: 7, stop: "" }],
  ] as [string, RuleOpts][]) {
    assert.deepEqual(await authority(GMAIL, r), ruleAbsent, label);
  }
  x.setRows(x.own.matrix, [rule(x.ids.r1, { n: 7, modes: ["AUTONOMOUS", "LEARN", "GUARDED"], authority: "AUTO_ALLOWED" })]);
  const s = await direct(x, [GMAIL]);
  assert.deepEqual([s[K.AUTHORITY].rows[0]!["allowed_modes"], s[K.AUTHORITY].rows[0]!["declared_authority"], s[K.AUTHORITY].rows[0]!["send_authority"], s[K.AUTHORITY].rows[0]!["t0_recheck_required"]], ["LEARN,GUARDED,AUTONOMOUS", "AUTO_ALLOWED", "NONE", true], "even AUTO_ALLOWED sends nothing");
  assert.equal(typeof s[K.AUTHORITY].rows[0]!["rule_id"], "number");
});

test("PT-CP-014/k: only the competent reconciliation symbols travel; anything else makes the stops ABSENT", async () => {
  const x = await buildExtWorld();
  for (const status of ["OBSERVED", "NOT_OBSERVED", "AMBIGUOUS", "UNAVAILABLE", "IDENTITY_MISMATCH", "NOT_RECONCILED"]) {
    const s = await direct(x, [GMAIL], status);
    assert.equal(s[K.STOPS].status, "PRESENT", status);
    assert.equal(s[K.STOPS].rows[0]!["reconciliation_status"], status);
  }
  assert.equal((await direct(x, [GMAIL], "SENT"))[K.STOPS].status, "ABSENT");
  assert.equal((await direct(x, [GMAIL, { ...GMAIL, key: "ak-004", prepared: "2030-01-05T09:00:00.000Z" }], (i) => (i === 0 ? "OBSERVED" : "PROOF: msg-1")))[K.STOPS].status, "ABSENT");
});

test("PT-CP-014/l: SETUP and DAILY are preserved; a HOLD without a reliable snapshot serves four ABSENT; S8 moves pack_id only", async () => {
  const x = await buildExtWorld();
  x.setIntents([GMAIL]);
  const both = await resumed(x, "CURRENT_WORK,SALES_EXTERNAL_ACTION");
  assert.deepEqual(both.p.selected_context.contexts.map((c) => c.context), ["DAILY", "EXTERNAL_ACTION"]);
  const daily = both.p.selected_context.contexts[0]!.sections;
  assert.equal(daily.length, 14);
  assert.ok(daily.every((s) => s.source_status === "ABSENT"), "no DAILY source is read on a HOLD");
  assert.deepEqual(statusOf(both.p), ALL("PRESENT"));
  const setup = await resumed(x, "SALES_SETUP_INPUTS");
  assert.deepEqual(setup.p.selected_context.contexts.map((c) => [c.context, c.sections.map((s) => s.source_status)]), [["SETUP", ["ABSENT", "ABSENT", "ABSENT", "ABSENT"]]]);

  // Two incomplete Runs: the HOLD carries no reliable snapshot, so no read path opens.
  x.sw.w.setSalesRuns([runPage({ id: synthetic("run-a"), label: "SRUN-2", status: "RUNNING", lane: "SALES" }), runPage({ id: synthetic("run-b"), label: "SRUN-3", status: "RUNNING", lane: "SALES" })]);
  const ambiguous = await resumed(x);
  assert.equal(ambiguous.e.status, "HOLD");
  assert.equal(ambiguous.e.code, "HOLD_RUN_AMBIGUOUS");
  assert.deepEqual(statusOf(ambiguous.p), ALL("ABSENT"));
  for (const ds of [x.own.accounts, x.own.contacts, x.own.matrix]) assert.deepEqual(x.sw.client.on(ds), []);

  // S8: the declared sections enter pack_id; an equal policy keeps it; the state fingerprint does not move.
  const VERSIONS = { governing_spec: "S", governing_schema: "H", governing_control: "C", candidate_versions: [] } as const;
  const id = (policy?: ContextPolicy) => buildContractPack({ lane: "SALES", topic_hint: "SALES_EXTERNAL_ACTION", runtime_generation: "g1", versions: VERSIONS, safety: {}, open_backend_plan: "NONE", ...(policy ? { context_policy: policy } : {}) }).pack;
  const without: ContextPolicy = { ...CONTEXT_POLICY, sections: { ...CONTEXT_POLICY.sections, EXTERNAL_ACTION: [] } };
  const twin: ContextPolicy = { ...CONTEXT_POLICY, sections: { ...CONTEXT_POLICY.sections, EXTERNAL_ACTION: [...CONTEXT_SECTIONS.EXTERNAL_ACTION] } };
  assert.notEqual(id().pack_id, id(without).pack_id);
  assert.equal(id().pack_id, id(twin).pack_id);
  assert.equal(id().state_fingerprint, id(without).state_fingerprint);
  assert.equal(id().selected_context.policy_version, "CONTRACT_PACK/0.3.2-candidate");
});

test("PT-CP-014/m: deterministic, and no row ever carries a permission", async () => {
  const x = await buildExtWorld();
  x.setIntents([GMAIL, { ...GMAIL, key: "ak-005", approval: "APPROVED", prepared: "2030-01-06T09:00:00.000Z" }]);
  const a = await resumed(x);
  const b = await resumed(x);
  assert.equal(a.p.pack_id, b.p.pack_id);
  assert.equal(JSON.stringify(a.p.selected_context), JSON.stringify(b.p.selected_context));
  for (const s of sectionsOf(a.p)) {
    for (const item of s.items) {
      for (const k of Object.keys(item)) assert.doesNotMatch(k, /permit|allowed_to|can_send|authorized|cursor|token|offset|has_more/i, `${s.section_key}.${k}`);
      if ("send_authority" in item) assert.equal(item["send_authority"], "NONE");
    }
  }
});

/** A connected competent source that records every read it serves. */
function spySource(identity: string) {
  const calls: string[] = [];
  const src: CompetentSource = {
    async identity() { calls.push("identity"); return identity; },
    async searchSent(q) { calls.push(`searchSent:${q.action_key ?? "*"}`); return []; },
    async thread(id) { calls.push(`thread:${id}`); return []; },
  };
  return { src, calls };
}

test("PT-CP-014/n: W2.4D — searchSent is competent only for GMAIL_SEND; a connected Gmail never reads a DRAFT or OTHER intent, which HOLDs NOT_RECONCILED", async () => {
  const x = await buildExtWorld();
  const mailbox = x.runtime.observations["mailbox_identity"];
  const { src, calls } = spySource(typeof mailbox === "string" ? mailbox : "rep-a@example.invalid");
  const sw: SetupWorld = { ...x.sw, deps: { ...x.sw.deps, competentSource: src } };
  const connected = async (intents: readonly IntentOpts[]) => {
    x.setIntents(intents);
    const bound = await bindSales(sw);
    calls.length = 0;
    x.sw.client.reset();
    const e = await resume(sw, bound.handle, "SALES_EXTERNAL_ACTION");
    return { e, p: packOf(e), ea: bag(e)["external_actions"] as ExternalActionsView };
  };
  const DRAFT: IntentOpts = { ...GMAIL, key: "ak-003", type: "GMAIL_DRAFT", thread: "thr-draft", prepared: "2030-01-02T09:00:00.000Z" };
  const blocks = /no send, no replay, no completion/;

  // GMAIL_DRAFT: no contracted draft reader. The durable intent stays, raw NOT_RECONCILED, explicit HOLD, zero Gmail read.
  const d = await connected([DRAFT]);
  assert.deepEqual(calls, [] as string[], "no identity, searchSent or thread lookup for a draft");
  assert.equal(d.e.status, "HOLD");
  assert.equal(d.ea.competent_source_available, true, "the source is connected");
  assert.equal(d.ea.unresolved.length, 1, "the durable intent is retained");
  const dr = d.ea.unresolved[0]!;
  assert.deepEqual([dr.action_key, dr.reconciliation.status, dr.routing.capability, dr.routing.send_authority, "inbound" in dr], ["ak-003", "NOT_RECONCILED", "GMAIL_DRAFT", "NONE", false]);
  assert.match(d.ea.gmail_hold ?? "", /GMAIL_DRAFT/);
  assert.match(d.ea.gmail_hold ?? "", blocks);
  assert.ok(d.e.next.safe_action.includes(d.ea.gmail_hold!), "the HOLD reaches the caller's safe action");
  // Projection agrees with the raw envelope: GMAIL is the contracted source symbol, the status is NOT_RECONCILED.
  assert.deepEqual(statusOf(d.p), ALL("PRESENT"));
  assert.deepEqual(sectionOf(d.p, K.STOPS).items.map((i) => [i["action_key"], i["reconciliation_status"], i["competent_source"]]), [["ak-003", dr.reconciliation.status, "GMAIL"]]);

  // OTHER_EXTERNAL: no competent reader at all. Same HOLD; its stops stay ABSENT.
  const o = await connected([OTHER(x)]);
  assert.deepEqual(calls, [] as string[], "no Gmail read for OTHER_EXTERNAL");
  assert.equal(o.e.status, "HOLD");
  const or = o.ea.unresolved[0]!;
  assert.deepEqual([or.reconciliation.status, or.routing.capability, "inbound" in or], ["NOT_RECONCILED", "OTHER_EXTERNAL", false]);
  assert.match(o.ea.gmail_hold ?? "", /OTHER_EXTERNAL/);
  assert.match(o.ea.gmail_hold ?? "", blocks);
  assert.equal(statusOf(o.p)[K.STOPS], "ABSENT");

  // GMAIL_SEND is unchanged: the connected source is consulted. Beside it, aggregate availability proves nothing for the draft.
  const m = await connected([GMAIL, DRAFT]);
  assert.ok(calls.includes("identity"), "GMAIL_SEND is reconciled against the source");
  assert.equal(calls.some((c) => c.includes("ak-003") || c.includes("thr-draft")), false, "the draft is never looked up");
  const byKey = Object.fromEntries(m.ea.unresolved.map((r) => [r.action_key, r]));
  assert.equal(byKey["ak-001"]!.routing.capability, "GMAIL_SEND");
  assert.notEqual(byKey["ak-001"]!.reconciliation.status, "NOT_RECONCILED");
  assert.deepEqual([m.ea.competent_source_available, byKey["ak-003"]!.reconciliation.status], [true, "NOT_RECONCILED"]);
  assert.ok(m.ea.gmail_hold, "an unreconcilable intent always holds");
  const stops = Object.fromEntries(sectionOf(m.p, K.STOPS).items.map((i) => [i["action_key"], i["reconciliation_status"]]));
  assert.deepEqual(stops, { "ak-001": byKey["ak-001"]!.reconciliation.status, "ak-003": "NOT_RECONCILED" }, "each projected status is its raw row's");
  // W2.4E: an UNKNOWN Action Type is UNGOVERNED, never defaulted to GMAIL_SEND: no Gmail read, raw NOT_RECONCILED, HOLD.
  const u = await connected([{ ...GMAIL, key: "ak-006", type: "UNKNOWN", thread: "thr-unknown" }]);
  assert.deepEqual(calls, [] as string[], "no identity, searchSent or thread lookup for an UNKNOWN Action Type");
  assert.equal(u.e.status, "HOLD");
  assert.equal(u.ea.competent_source_available, true, "the source is connected");
  const ur = u.ea.unresolved[0]!;
  assert.deepEqual([ur.action_key, ur.reconciliation.status, ur.routing.capability, ur.routing.send_authority, "inbound" in ur], ["ak-006", "NOT_RECONCILED", "UNGOVERNED", "NONE", false]);
  assert.match(u.ea.gmail_hold ?? "", /UNGOVERNED/);
  assert.match(u.ea.gmail_hold ?? "", blocks);
  assert.ok(u.e.next.safe_action.includes(u.ea.gmail_hold!), "the HOLD reaches the caller's safe action");
  assert.deepEqual([K.INTENTS, K.PARTIES, K.STOPS].map((k) => statusOf(u.p)[k]), ["ABSENT", "ABSENT", "ABSENT"], "dependent sections are ABSENT");
});
