/**
 * EXTERNAL_ACTION context sources — CONTRACT_PACK/0.3.0-candidate (W2.4, Sales 0.5.10 / schema 0.5.5 candidate).
 * READ-ONLY and DIAGNOSTIC: this module never writes, never routes, never sends and never decides that an action is
 * safe. `declared_authority` describes a rule; `send_authority` is always `NONE` and a T-0 re-check is always owed.
 *
 * It supplies the four sources the catalogue declares for EXTERNAL_ACTION, and only for the SALES lane, each one on
 * its own so that one section that cannot be proven is ABSENT without hiding another:
 *  - `EXTERNAL_INTENTS`: the unresolved durable intents themselves, as the safety rehydration already read them;
 *  - `EXTERNAL_PARTIES`: the account and contact each intent names by explicit page UUID, verified in the instance;
 *  - `EXTERNAL_AUTHORITY`: the one Authority Matrix rule each intent links through `Authority Ref`, as declared;
 *  - `EXTERNAL_STOPS`: that rule's stop conditions, the two Do Not Contact flags and the competent-source symbol.
 *
 * Anchor. The set of unresolved intents of the ONE bound SALES runtime, already reconstructed (completely) by the
 * safety rehydration; no plan, e-mail or chat memory chooses an intent. Every `Action Key` must be non-empty and
 * unique, every `Prepared At` decidable, or all four sources are ABSENT. The order is `Prepared At` then
 * `Action Key`; the window is the first eleven: ten can be served, the eleventh only makes the projector announce an
 * omission (S6). A candidate that fails a section makes that whole section ABSENT: no partial row, no twelfth
 * candidate in its place. The only further reads are the account, contact and rule pages the window names, and the
 * schemas of their databases in the bound runtime: no scan of Accounts, Contacts or Authority Matrix.
 *
 * Anything that cannot be resolved truthfully is ABSENT, never guessed; a failure is never echoed, because its
 * message could name a stored value. Values reach the projector only (D7).
 */
import type { NotionReadClient } from "../notion/readClient.ts";
import { normalizeId, plainText, type Page, type RichText } from "../notion/shapes.ts";
import { discoverDataSource, readSchema, type DataSourceSchema } from "../plans/resources.ts";
import type { ResolvedRuntime } from "../resolvers/types.ts";
import type { ExternalActionIntent } from "../resume/snapshot.ts";
import type { Lane } from "../tools/envelope.ts";
import type { ExternalActionProps, ResourceSpec } from "../versions/adapters/controlPlane.ts";
import { CONTEXT_BOUNDS, EXTERNAL_ACTION_SOURCE_KEYS, NEED_CONTEXT, type ContextNeed } from "./catalog.ts";
import type { ContextSource, ContextValue } from "./pack.ts";

/** The row bound, and one more candidate whose only role is to prove that at least one intent was not served. */
const WINDOW = CONTEXT_BOUNDS.max_rows_per_section + 1;

const K = EXTERNAL_ACTION_SOURCE_KEYS;

/** The governed `External Actions.Action Type` values. Gmail ones have a competent source; `OTHER_EXTERNAL` has none. */
const ACTION_TYPES = ["GMAIL_SEND", "GMAIL_DRAFT", "OTHER_EXTERNAL"] as const;
const GMAIL_TYPES: readonly string[] = ["GMAIL_SEND", "GMAIL_DRAFT"];
/** `Authority Matrix.Allowed In Mode`, in its canonical order: the order of the served CSV. */
const MODES = ["LEARN", "GUARDED", "AUTONOMOUS"] as const;
/** The only symbols the competent reconciliation can hand over; never its proof, message or conclusion. */
const RECONCILIATION_STATUSES: readonly string[] = ["OBSERVED", "NOT_OBSERVED", "AMBIGUOUS", "UNAVAILABLE", "IDENTITY_MISMATCH", "NOT_RECONCILED"];

/** Where the referenced pages live in a Personal SALES runtime. Read locations only, never addressable resources. */
const AT = {
  EXTERNAL_ACTIONS: { parentTitle: "03 — CONTROL PLANE", databaseTitle: "External Actions" },
  ACCOUNTS: { parentTitle: "04 — DATA & EVIDENCE", databaseTitle: "Accounts" },
  CONTACTS: { parentTitle: "04 — DATA & EVIDENCE", databaseTitle: "Contacts" },
  AUTHORITY_MATRIX: { parentTitle: "02 — SETUP & BUSINESS CONFIG", databaseTitle: "Authority Matrix" },
} as const;
type Location = (typeof AT)[keyof typeof AT];

/** One unresolved intent with the symbol its competent reconciliation produced, as `os_resume` already holds it. */
export type ReconciledIntent = ExternalActionIntent & { readonly reconciliation: { readonly status: string } };

/**
 * The anchor handed over by `os_resume`. `unresolved_count` is the count the safety rehydration established: only a
 * number equal to the intents supplied proves the External Actions source. Anything else — an unreadable database, a
 * HOLD without a reliable snapshot — leaves no anchor, and the four sections are ABSENT.
 */
export interface ExternalActionAnchor {
  readonly unresolved_count: number | "NOT_APPLICABLE" | "UNKNOWN" | undefined;
  readonly intents: readonly ReconciledIntent[];
}

const absent = (source_key: string): ContextSource => ({ source_key, status: "ABSENT", rows: [] });
const present = (source_key: string, rows: readonly unknown[]): ContextSource => ({ source_key, status: "PRESENT", rows });

/** A fact that cannot be proven. Thrown, never echoed: the section that raised it is ABSENT. */
class NotProven extends Error {
  override readonly name = "NotProven";
}
const fail = (): never => {
  throw new NotProven("EXTERNAL_ACTION fact not proven");
};
const must = (ok: boolean): void => {
  if (!ok) fail();
};

/** Whether the normalized needs select the EXTERNAL_ACTION context at all. When they do not, nothing is read. */
export function externalActionSelected(needs: readonly ContextNeed[]): boolean {
  return needs.some((n) => NEED_CONTEXT[n] === "EXTERNAL_ACTION");
}

// ─────────────────────────────── intents and their window ───────────────────────────────

const EPISTEMIC: ReadonlySet<string> = new Set(["UNKNOWN", "NOT_FOUND", "NOT_YET_CREATED", "NOT_APPLICABLE"]);
/** A value the rehydration actually read: a non-empty string that is not an epistemic marker. */
const value = (t: unknown): string => (typeof t === "string" && t.trim() !== "" && !EPISTEMIC.has(t) ? t : fail());
/** An optional free text: `""` when read empty, the text when read, never an unreadable one. */
const knownText = (t: unknown): string => (typeof t !== "string" || EPISTEMIC.has(t) ? fail() : t.trim() === "" ? "" : t);

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:Z|([+-])(\d{2}):(\d{2}))$/;
/** `order` is in nanoseconds since 1970-01-01T00:00Z: exact down to the nine fractional digits an instant may carry. */
type Prepared = { readonly kind: "DAY" | "INSTANT"; readonly order: bigint };
const NS_PER_SECOND = 1_000_000_000n;
const NS_PER_MINUTE = 60n * NS_PER_SECOND;
const NS_PER_DAY = 1440n * NS_PER_MINUTE;

/**
 * Days since 1970-01-01 of a civil date of the proleptic Gregorian calendar that EXISTS. Nothing is normalized:
 * 2030-02-30 is not proven, never 2030-03-02.
 */
function civilDay(y: number, m: number, d: number): bigint {
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const last = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  must(last !== undefined && d >= 1 && d <= last);
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1;
  return BigInt(era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468);
}

/**
 * A decidable `Prepared At`: a civil day or an instant with its offset. A day cannot be ordered against an instant
 * without a zone, so a set mixing both is not decidable either; neither kind is ever read in an implicit zone.
 * Parsed here, never by `Date.parse`: a date that does not exist, 24:00, a leap second or an offset outside
 * ±23:59 is not proven instead of being rolled over into another instant. The offset never repairs the civil date.
 */
function preparedAt(raw: string): Prepared {
  const day = DAY.exec(raw);
  if (day) return { kind: "DAY", order: civilDay(Number(day[1]), Number(day[2]), Number(day[3])) * NS_PER_DAY };
  const [, y, mo, d, h, mi, s = "00", frac = "", sign, oh = "00", om = "00"] = INSTANT.exec(raw) ?? fail();
  const [hh, mm, ss, ohh, omm] = [h, mi, s, oh, om].map(Number) as [number, number, number, number, number];
  must(hh <= 23 && mm <= 59 && ss <= 59 && ohh <= 23 && omm <= 59);
  const local = civilDay(Number(y), Number(mo), Number(d)) * NS_PER_DAY + BigInt((hh * 60 + mm) * 60 + ss) * NS_PER_SECOND + BigInt(frac.padEnd(9, "0"));
  const offset = BigInt(ohh * 60 + omm) * NS_PER_MINUTE;
  return { kind: "INSTANT", order: sign === "-" ? local + offset : local - offset };
}

const cmp = <T extends string | bigint>(a: T, b: T): number => (a < b ? -1 : a > b ? 1 : 0);

/** The ordered window of the anchor: every key and date proven over the WHOLE unresolved set, then the first eleven. */
function windowOf(intents: readonly ReconciledIntent[]): readonly ReconciledIntent[] {
  const keys = new Set<string>();
  const dated = intents.map((intent) => {
    const key = value(intent.action_key);
    must(!keys.has(key));
    keys.add(key);
    return { intent, key, when: preparedAt(value(intent.prepared_at)) };
  });
  must(new Set(dated.map((d) => d.when.kind)).size <= 1);
  dated.sort((a, b) => cmp(a.when.order, b.when.order) || cmp(a.key, b.key));
  return dated.slice(0, WINDOW).map((d) => d.intent);
}

// ─────────────────────────────── tables and pages of the bound runtime ───────────────────────────────

interface Table { readonly ds: string; readonly schema: DataSourceSchema }

/**
 * Discover one database under the bound root (never from a reference a row carries) and require every column a
 * verification needs, with its type. `undefined` means every section that needs it is ABSENT.
 */
async function openTable(client: NotionReadClient, runtime: ResolvedRuntime, at: Location, required: Readonly<Record<string, string>>): Promise<Table | undefined> {
  const spec: ResourceSpec = { scope: "RUNTIME", parentTitle: at.parentTitle, databaseTitle: at.databaseTitle, naturalKeyProperty: "", operations: [] };
  const disc = await discoverDataSource(client, runtime, spec);
  if (!disc.ok) return undefined;
  const schema = await readSchema(client, disc.ds);
  if (!schema) return undefined;
  for (const [column, type] of Object.entries(required)) {
    if (schema.properties.get(column) !== type) return undefined;
  }
  return { ds: disc.ds, schema };
}

type Property = { readonly type?: string } & Readonly<Record<string, unknown>>;
const prop = (page: Page, column: string): Property | undefined => page.properties[column] as Property | undefined;

/** A title or rich text, as its concatenated plain_text (untrimmed); required non-empty. */
function text(page: Page, column: string): string {
  const p = prop(page, column);
  must(p?.type === "title" || p?.type === "rich_text");
  const v = plainText(p![p!.type!] as readonly RichText[] | undefined);
  return v.trim() !== "" ? v : fail();
}
function flag(page: Page, column: string): boolean {
  const p = prop(page, column);
  return p?.type === "checkbox" && typeof p["checkbox"] === "boolean" ? (p["checkbox"] as boolean) : fail();
}
/** The positive integer of an auto-increment ID, served as a number without its prefix. */
function autoId(page: Page, column: string): number {
  const p = prop(page, column);
  const n = p?.type === "unique_id" ? (p["unique_id"] as { number?: unknown } | undefined)?.number : undefined;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : fail();
}
/** A select value that the live schema of its own database declares (D11). */
function governed(t: Table, page: Page, column: string): string {
  const p = prop(page, column);
  const name = p?.type === "select" ? (p["select"] as { name?: unknown } | null)?.name : undefined;
  return typeof name === "string" && name !== "" && (t.schema.options.get(column) ?? []).includes(name) ? name : fail();
}
/** A value of the intent itself, checked against the governed options of its External Actions column. */
const governedValue = (t: Table, column: string | undefined, raw: unknown): string => {
  const v = value(raw);
  return column !== undefined && (t.schema.options.get(column) ?? []).includes(v) ? v : fail();
};
/** A text-typed page reference that is exactly one page UUID, dashed or compact, and nothing else. */
const UUID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
function pageUuid(raw: unknown): string {
  const v = typeof raw === "string" ? raw.trim() : "";
  return UUID.test(v) ? (normalizeId(v) ?? fail()) : fail();
}

/**
 * Per-attempt reads. Structure (discovery, schemas) is read once; each named page is read once, directly by its id,
 * and must be a live row of the expected database of the bound runtime.
 */
class Reader {
  readonly #client: NotionReadClient;
  readonly #runtime: ResolvedRuntime;
  readonly #tables = new Map<string, Promise<Table | undefined>>();
  readonly #pages = new Map<string, Promise<unknown>>();
  constructor(client: NotionReadClient, runtime: ResolvedRuntime) {
    this.#client = client;
    this.#runtime = runtime;
  }

  async table(at: Location, required: Readonly<Record<string, string>>): Promise<Table> {
    const key = at.parentTitle + "/" + at.databaseTitle;
    let t = this.#tables.get(key);
    if (!t) { t = openTable(this.#client, this.#runtime, at, required).catch(() => undefined); this.#tables.set(key, t); }
    return (await t) ?? fail();
  }

  async row(id: string, t: Table): Promise<Page> {
    let read = this.#pages.get(id);
    if (!read) { read = this.#client.retrievePage(id); this.#pages.set(id, read); }
    const page = (await read) as Page | undefined;
    must(page !== undefined && normalizeId(page.id) === id && page.archived !== true && page.in_trash !== true && normalizeId(page.parent?.data_source_id) === t.ds);
    return page!;
  }
}

// ─────────────────────────────── the facts each section needs ───────────────────────────────

const REQUIRED = {
  ACCOUNTS: { "Account ID": "unique_id", Company: "title", "Do Not Contact": "checkbox" },
  CONTACTS: { "Contact ID": "unique_id", Contact: "title", "Do Not Contact": "checkbox", Email: "email", "Email Status": "select", Account: "relation" },
  AUTHORITY_MATRIX: { "Authority ID": "unique_id", Active: "checkbox", Authority: "select", "Allowed In Mode": "multi_select", Preconditions: "rich_text", "Stop Conditions": "rich_text" },
} as const;

interface Parties { readonly accounts: Table; readonly contacts: Table; readonly account: Page; readonly contact: Page; readonly account_dnc: boolean; readonly contact_dnc: boolean }
interface Rule { readonly rule_id: number; readonly declared_authority: string; readonly allowed_modes: string; readonly preconditions: string; readonly stop_conditions: string }

class Facts {
  readonly #reader: Reader;
  readonly #props: ExternalActionProps;
  readonly #parties = new Map<string, Promise<Parties>>();
  readonly #rules = new Map<string, Promise<Rule>>();
  constructor(reader: Reader, props: ExternalActionProps) {
    this.#reader = reader;
    this.#props = props;
  }

  /** The intents' own database, for its governed options and the target of `Authority Ref`. */
  intents(): Promise<Table> {
    return this.#reader.table(AT.EXTERNAL_ACTIONS, {});
  }

  actionType(t: Table, intent: ReconciledIntent): string {
    const v = governedValue(t, this.#props.actionType, intent.action_type);
    return (ACTION_TYPES as readonly string[]).includes(v) ? v : fail();
  }
  approvalState(t: Table, intent: ReconciledIntent): string {
    return governedValue(t, this.#props.approvalState, intent.approval_state);
  }

  /**
   * The two pages the intent names by explicit UUID, each a live row of its own database in the bound runtime, each
   * with its logical ID and its Do Not Contact flag. The contact's own account, when filled, must be that account.
   */
  parties(intent: ReconciledIntent): Promise<Parties> {
    let p = this.#parties.get(intent.ref);
    if (!p) { p = this.#resolveParties(intent); this.#parties.set(intent.ref, p); }
    return p;
  }
  async #resolveParties(intent: ReconciledIntent): Promise<Parties> {
    const facts = intent.context_facts ?? fail();
    const accountId = pageUuid(facts.account_ref);
    const contactId = pageUuid(facts.contact_ref);
    const accounts = await this.#reader.table(AT.ACCOUNTS, REQUIRED.ACCOUNTS);
    const contacts = await this.#reader.table(AT.CONTACTS, REQUIRED.CONTACTS);
    must(contacts.schema.relations.get("Account") === accounts.ds);
    const account = await this.#reader.row(accountId, accounts);
    const contact = await this.#reader.row(contactId, contacts);
    autoId(account, "Account ID");
    autoId(contact, "Contact ID");
    const link = prop(contact, "Account");
    must(link?.type === "relation" && Array.isArray(link["relation"]) && link["has_more"] !== true);
    const linked = (link!["relation"] as readonly { id?: string }[]).map((r) => normalizeId(r?.id) ?? fail());
    must(linked.length === 0 || (linked.length === 1 && linked[0] === accountId));
    return { accounts, contacts, account, contact, account_dnc: flag(account, "Do Not Contact"), contact_dnc: flag(contact, "Do Not Contact") };
  }

  /**
   * The one rule `Authority Ref` links, a live row of this runtime's Authority Matrix: active, with its logical ID, a
   * governed Authority, a readable mode set and non-empty preconditions and stop conditions. Declarative only.
   */
  rule(intent: ReconciledIntent): Promise<Rule> {
    let r = this.#rules.get(intent.ref);
    if (!r) { r = this.#resolveRule(intent); this.#rules.set(intent.ref, r); }
    return r;
  }
  async #resolveRule(intent: ReconciledIntent): Promise<Rule> {
    const refs = intent.context_facts?.authority_refs;
    must(Array.isArray(refs) && refs.length === 1);
    const matrix = await this.#reader.table(AT.AUTHORITY_MATRIX, REQUIRED.AUTHORITY_MATRIX);
    const own = await this.intents();
    must(this.#props.authorityRef !== undefined && own.schema.relations.get(this.#props.authorityRef) === matrix.ds);
    const rule = await this.#reader.row((refs as readonly string[])[0]!, matrix);
    must(flag(rule, "Active"));
    return {
      rule_id: autoId(rule, "Authority ID"),
      declared_authority: governed(matrix, rule, "Authority"),
      allowed_modes: modes(rule),
      preconditions: text(rule, "Preconditions"),
      stop_conditions: text(rule, "Stop Conditions"),
    };
  }
}

/** The selected modes as one CSV in canonical order. Empty, unknown or duplicated selections are not a mode set. */
function modes(rule: Page): string {
  const p = prop(rule, "Allowed In Mode");
  must(p?.type === "multi_select" && Array.isArray(p["multi_select"]));
  const names = (p!["multi_select"] as readonly { name?: unknown }[]).map((o) => (typeof o?.name === "string" ? o.name : fail()));
  must(names.length > 0 && new Set(names).size === names.length && names.every((n) => (MODES as readonly string[]).includes(n)));
  return MODES.filter((m) => names.includes(m)).join(",");
}

// ─────────────────────────────── the sections ───────────────────────────────

/** Every candidate of the window, or the section is ABSENT: a failure is never echoed. */
async function section(source_key: string, window: readonly ReconciledIntent[], row: (intent: ReconciledIntent) => Promise<Record<string, ContextValue>>): Promise<ContextSource> {
  try {
    const rows: Record<string, ContextValue>[] = [];
    for (const intent of window) rows.push(await row(intent));
    return present(source_key, rows);
  } catch {
    return absent(source_key);
  }
}

/**
 * The EXTERNAL_ACTION sources for this turn, in catalogue order. Empty when EXTERNAL_ACTION is not selected. On META,
 * or without a proven anchor, the four sections exist and all are ABSENT. Zero unresolved intents in a proven source
 * serves four PRESENT empty sections, which only means "no unresolved intent in this source", never a permission.
 */
export async function readExternalActionSources(client: NotionReadClient, runtime: ResolvedRuntime, lane: Lane, needs: readonly ContextNeed[], anchor: ExternalActionAnchor | undefined): Promise<readonly ContextSource[]> {
  if (!externalActionSelected(needs)) return [];
  const keys = Object.values(K);
  const props = runtime.adapter.controlPlane.externalActionProps;
  if (lane !== "SALES" || !anchor || !props || typeof anchor.unresolved_count !== "number" || anchor.unresolved_count !== anchor.intents.length) return keys.map(absent);
  let window: readonly ReconciledIntent[];
  try {
    window = windowOf(anchor.intents);
  } catch {
    return keys.map(absent);
  }
  if (window.length === 0) return keys.map((k) => present(k, []));
  const facts = new Facts(new Reader(client, runtime), props);

  return Promise.all([
    section(K.INTENTS, window, async (intent) => {
      const own = await facts.intents();
      return {
        action_key: value(intent.action_key),
        action_type: facts.actionType(own, intent),
        effect_status: governedValue(own, props.effectStatus, intent.effect_status),
        approval_state: facts.approvalState(own, intent),
        recipient: knownText(intent.context_facts?.recipient),
        thread_context: knownText(intent.context_facts?.thread_context),
        prepared_at: value(intent.prepared_at),
      };
    }),
    section(K.PARTIES, window, async (intent) => {
      const own = await facts.intents();
      const actionType = facts.actionType(own, intent);
      const p = await facts.parties(intent);
      // A Gmail action names its recipient: it must be the referenced contact's own address, compared exactly after
      // trimming the edges only. The contact is never found by its address.
      if (GMAIL_TYPES.includes(actionType)) {
        const recipient = knownText(intent.context_facts?.recipient).trim();
        const email = prop(p.contact, "Email");
        const address = email?.type === "email" && typeof email["email"] === "string" ? (email["email"] as string).trim() : "";
        must(recipient !== "" && address !== "" && recipient === address);
      }
      return {
        action_key: value(intent.action_key),
        account_id: autoId(p.account, "Account ID"),
        company: text(p.account, "Company"),
        account_do_not_contact: p.account_dnc,
        contact_id: autoId(p.contact, "Contact ID"),
        contact: text(p.contact, "Contact"),
        contact_do_not_contact: p.contact_dnc,
        email_status: governed(p.contacts, p.contact, "Email Status"),
      };
    }),
    section(K.AUTHORITY, window, async (intent) => {
      const own = await facts.intents();
      const rule = await facts.rule(intent);
      return {
        action_key: value(intent.action_key),
        rule_id: rule.rule_id,
        declared_authority: rule.declared_authority,
        allowed_modes: rule.allowed_modes,
        preconditions: rule.preconditions,
        approval_state: facts.approvalState(own, intent),
        send_authority: "NONE",
        t0_recheck_required: true,
      };
    }),
    section(K.STOPS, window, async (intent) => {
      const own = await facts.intents();
      // OTHER_EXTERNAL has no competent source contracted: its stops cannot be stated, so the section is ABSENT.
      must(GMAIL_TYPES.includes(facts.actionType(own, intent)));
      const rule = await facts.rule(intent);
      const p = await facts.parties(intent);
      const status = intent.reconciliation.status;
      must(RECONCILIATION_STATUSES.includes(status));
      return {
        action_key: value(intent.action_key),
        stop_conditions: rule.stop_conditions,
        account_do_not_contact: p.account_dnc,
        contact_do_not_contact: p.contact_dnc,
        reconciliation_status: status,
        competent_source: "GMAIL",
      };
    }),
  ]);
}
