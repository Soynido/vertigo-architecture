/** W6.5b: bounded real-row B7 proof. No writer, semantic grader, history scan or permission cache. */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { BindingRecord } from "../binding/store.ts";
import type { HoldCode } from "../errors/codes.ts";
import { canonicalJson } from "../guards/canonical.ts";
import { StructureCache } from "../notion/structureCache.ts";
import { normalizeId, propRelationIds, propText, type Page } from "../notion/shapes.ts";
import { discoverDataSource, naturalKeyFilter, readSchema, type DataSourceSchema } from "../plans/resources.ts";
import type { Intent } from "../plans/prepare.ts";
import type { Plan } from "../plans/store.ts";
import type { ResolvedRuntime } from "../resolvers/types.ts";
import type { HarnessDeps } from "../tools/handlers.ts";
import { compareFields, observedField } from "../verify/target.ts";
import { registerBuiltinSalesAdapters, type SalesContractAdapter } from "../versions/adapters/sales.ts";
import { MapAdapterRegistry, type SalesRuntimeAdapter } from "../versions/registry.ts";

const adapters = new MapAdapterRegistry<SalesRuntimeAdapter>();
registerBuiltinSalesAdapters(adapters);

const str = z.string().min(1).refine(s => s === s.trim());
const http = str.refine(s => { try { const u = new URL(s); return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password && u.href === s; } catch { return false; } });
const email = str.refine(s => s === s.toLowerCase() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
const gate = z.object({ gate_key: str, active: z.literal(true), hard_gate: z.literal(true), version: str,
  pass_condition: str, required_evidence: str, criterion: str, fail_disposition: z.enum(["HOLD", "REJECT", "RESEARCH_MORE"]) }).strict();
const evidence = z.object({ source_url: http, gate_key: str, role: z.enum(["SUPPORTING", "DISCLOSED"]) }).strict();
const workset = z.object({ schema_id: z.literal("SALES_DRY_RUN_WORKSET/1"), runtime_id: str,
  sales_contract_version: str, sales_schema_version: str, objective_package_id: str,
  qualification_gates: z.array(gate), sample: z.array(z.object({ account_key: http,
    expected_qualification: z.enum(["READY", "HOLD", "REJECT"]), evidence: z.array(evidence) }).strict()).min(10).max(25),
  cohort: z.array(z.object({ account_key: http, contact_key: email, draft_key: str, task_keys: z.array(str).min(1) }).strict()).min(1).max(25),
}).strict();
export type B7Workset = z.infer<typeof workset>;
const ordered = (xs: readonly string[]) => xs.every((s, i) => i === 0 || (xs[i - 1] as string) < s);
const pins = (r: ResolvedRuntime) => ({ spec: r.versions.governing_spec === "UNKNOWN" ? "UNKNOWN" : r.versions.governing_spec.value,
  schema: r.versions.governing_schema === "UNKNOWN" ? "UNKNOWN" : r.versions.governing_schema.value,
  control: r.versions.governing_control === "UNKNOWN" ? "UNKNOWN" : r.versions.governing_control.value });

/** Canonical encoding comparison also refuses duplicate JSON keys; arrays are identity sets, not caller order. */
export function parseB7Workset(value: string, runtime: ResolvedRuntime): B7Workset | undefined {
  if (Buffer.byteLength(value, "utf8") > 65536) return undefined;
  try {
    const p = workset.safeParse(JSON.parse(value)); if (!p.success || canonicalJson(p.data) !== value) return undefined;
    const w = p.data, v = pins(runtime);
    if (w.runtime_id !== runtime.runtime_id || w.sales_contract_version !== v.spec || w.sales_schema_version !== v.schema
      || w.objective_package_id !== normalizeId(String(runtime.observations.objective_package_ref ?? ""))) return undefined;
    if (!ordered(w.qualification_gates.map(g => g.gate_key)) || !ordered(w.sample.map(a => a.account_key))
      || !ordered(w.cohort.map(c => `${c.account_key}\n${c.contact_key}\n${c.draft_key}`))) return undefined;
    const drafts = new Set<string>(), members = new Set<string>();
    for (const s of w.sample) if (!ordered(s.evidence.map(e => `${e.gate_key}\n${e.source_url}`))) return undefined;
    for (const c of w.cohort) {
      if (!w.sample.some(s => s.account_key === c.account_key && s.expected_qualification === "READY") || !ordered(c.task_keys)
        || drafts.has(c.draft_key) || members.has(`${c.account_key}\n${c.contact_key}`)) return undefined;
      drafts.add(c.draft_key); members.add(`${c.account_key}\n${c.contact_key}`);
    }
    return w;
  } catch { return undefined; }
}

export type B7Observation = { kind: "SATISFIED"; fingerprint: string }
  | { kind: "HOLD"; code: HoldCode; evidence: readonly string[]; safe_action: string };
class Refusal extends Error {
  readonly code: HoldCode; readonly reason: string;
  constructor(code: HoldCode, reason: string) { super(reason); this.code = code; this.reason = reason; }
}
function requireFact(ok: unknown, reason: string, code: HoldCode = "HOLD_UNKNOWN_REQUIRED_FACT"): asserts ok {
  if (!ok) throw new Refusal(code, reason);
}
const fields = {
  BUSINESS_CONFIG: ["Category", "State", "Version", "Source", "Value"],
  QUALIFICATION_GATES: ["Active", "Hard Gate", "Criterion", "Pass Condition", "Required Evidence", "Fail Disposition", "Version"],
  ACCOUNTS: ["Company", "Qualification", "Lifecycle", "Do Not Contact", "Source", "Open Gaps", "Next Action"],
  CONTACTS: ["Account", "Email Status", "Email Source", "Buyer Role", "Do Not Contact", "Lifecycle"],
  EVIDENCE: ["Claim", "Type", "Confidence", "Source Provider", "Source Date", "Gate", "Account", "Contact"],
  OUTREACH_PIPELINE: ["Outreach", "Account", "Contact", "Channel", "Angle", "Evidence-led opener", "Message version", "Stage", "Sent date", "Last touch", "Next touch", "Outcome", "Objection", "Reply summary"],
  TASKS: ["Runtime ID", "Task", "Type", "Status", "Authority", "Account", "Contact", "Expected Outcome"],
} as const;
type Resource = keyof typeof fields;
interface Address { ds: string; schema: DataSourceSchema; key: string }
const idOf = (p: Page) => normalizeId(p.id) as string;
const text = (p: Page, f: string) => (propText(p, f) ?? "").trim();
const parent = (p: Page) => normalizeId(p.parent?.data_source_id) ?? normalizeId(p.parent?.database_id);
const ownedIntents = new WeakMap<object, string>();
export function bindB7Intent(intent: Intent, fingerprint: string): Intent { ownedIntents.set(intent, fingerprint); return intent; }
export function b7IntentFingerprint(intent: Intent): string | undefined { return ownedIntents.get(intent); }

/** A fresh scope, with batched key queries and reused in-call pages/schema. All diagnostics structural only. */
export async function observeB7DryRun(deps: HarnessDeps, binding: BindingRecord, runtime: ResolvedRuntime): Promise<B7Observation> {
  try {
    const v = pins(runtime);
    const declared = adapters.resolve(v.spec) as SalesContractAdapter | undefined;
    requireFact(declared?.supportedSchemas.includes(v.schema) && runtime.adapter.version === v.spec
      && declared.grammar.controlPlane === runtime.adapter.controlPlane
      && declared.grammar.controlPlane.cursorTransitions?.some(t => t.evidence.kind === "B7_GRAPH"),
      "B7 graph requires its exact registered candidate tuple", "HOLD_GATE_UNSPECIFIED");
    const client = new StructureCache(deps.notion);
    const addresses = new Map<Resource, Address>();
    for (const key of Object.keys(fields) as Resource[]) {
      const spec = runtime.adapter.controlPlane.resources?.[`SALES:${key}`];
      requireFact(spec, `B7 resource declaration missing: ${key}`, "HOLD_REQUIRED_RESOURCE_MISSING");
      const found = await discoverDataSource(client, runtime, spec);
      if (!found.ok) throw new Refusal(found.code, `B7 resource address unavailable: ${key}`);
      const schema = await readSchema(client, found.ds);
      requireFact(schema, `B7 schema unreadable: ${key}`, "HOLD_SCHEMA_MISMATCH");
      for (const f of [spec.naturalKeyProperty, ...fields[key]]) requireFact(schema.properties.has(f) && schema.propertyIds?.has(f),
        `B7 field/native identity missing: ${key}.${f}`, "HOLD_SCHEMA_MISMATCH");
      addresses.set(key, { ds: found.ds, schema, key: spec.naturalKeyProperty });
    }
    const address = (r: Resource) => addresses.get(r) as Address;
    for (const r of ["CONTACTS", "EVIDENCE", "TASKS", "OUTREACH_PIPELINE"] as Resource[]) {
      for (const [f, target] of [["Account", "ACCOUNTS"], ...(r === "CONTACTS" ? [] : [["Contact", "CONTACTS"]])] as [string, Resource][]) {
        requireFact(address(r).schema.relations.get(f) === normalizeId(address(target).ds),
          "B7 RELATION_AUTHORITY: resource relation parents differ", "HOLD_SCHEMA_MISMATCH");
      }
    }
    async function query(r: Resource, filter: unknown): Promise<Page[]> {
      const rows: Page[] = []; let cursor: string | undefined;
      for (let n = 0; n < 50; n++) {
        const q = await client.queryDataSource(address(r).ds, filter, cursor, { page_size: 100 }) as { results: Page[]; has_more?: boolean; next_cursor?: string | null };
        requireFact(Array.isArray(q.results), "B7 query did not return a complete row window");
        for (const p of q.results) if (!p.archived && !p.in_trash) {
          requireFact(parent(p) === normalizeId(address(r).ds), "B7 row has foreign parent", "HOLD_CROSS_RUNTIME"); rows.push(p);
        }
        if (q.has_more === false) return rows;
        requireFact(q.has_more === true && q.next_cursor && q.next_cursor !== cursor, "B7 query has unknown tail");
        cursor = q.next_cursor;
      }
      throw new Refusal("HOLD_UNKNOWN_REQUIRED_FACT", "B7 scoped query exceeded existing pagination bound");
    }
    async function keys(r: Resource, wanted: readonly string[]): Promise<Map<string, Page>> {
      const unique = [...new Set(wanted)]; if (!unique.length) return new Map();
      const a = address(r), rows: Page[] = [];
      for (let n = 0; n < unique.length; n += 50) {
        const batch = unique.slice(n, n + 50);
        const filters = batch.map(k => naturalKeyFilter(a.schema.properties.get(a.key), a.key, k));
        requireFact(filters.every(Boolean), "B7 exact key filter unsupported", "HOLD_SCHEMA_MISMATCH");
        rows.push(...await query(r, filters.length === 1 ? filters[0] : { or: filters }));
      }
      const out = new Map<string, Page>();
      for (const k of unique) {
        const hits = rows.filter(p => propText(p, a.key) === k);
        requireFact(hits.length === 1, "B7 natural key is absent or ambiguous", hits.length > 1 ? "HOLD_TARGET_AMBIGUOUS" : "HOLD_TARGET_NOT_FOUND");
        out.set(k, hits[0] as Page);
      }
      return out;
    }
    const proofRows = new Map<string, { resource: Resource; page: Page; fields: readonly string[] }>();
    function remember(r: Resource, p: Page, proofFields: readonly string[] = fields[r]) {
      const a = address(r);
      for (const f of proofFields) {
        const property = p.properties[f] as { id?: string; has_more?: boolean } | undefined;
        requireFact(property && property.id === a.schema.propertyIds?.get(f),
          `B7 observed native field identity missing/changed: ${r}.${f}`, "HOLD_SCHEMA_MISMATCH");
        requireFact(property.has_more !== true, `B7 observed field has an unread property tail: ${r}.${f}`);
      }
      proofRows.set(idOf(p), { resource: r, page: p, fields: [...new Set(proofFields)] });
    }
    const prior = (runtime.adapter.controlPlane.cursorTransitions ?? []).filter(t => t.evidence.kind === undefined || t.evidence.kind === "SINGLE_ROW");
    const configRows = await keys("BUSINESS_CONFIG", ["B7_DRY_RUN:WORKSET", ...prior.map(t => t.evidence.naturalKey)]);
    for (const t of prior) {
      const p = configRows.get(t.evidence.naturalKey) as Page;
      for (const [f, value] of Object.entries(t.evidence.equals)) requireFact(f === "Source"
        ? runtime.adapter.controlPlane.localAnswerSources?.includes(text(p, f)) : text(p, f) === value, "B7 prior setup declaration changed");
      for (const f of t.evidence.nonEmpty) requireFact(text(p, f) && text(p, f) !== "$answer", "B7 prior setup answer incomplete");
      remember("BUSINESS_CONFIG", p, [...Object.keys(t.evidence.equals), ...t.evidence.nonEmpty]);
    }
    const scope = configRows.get("B7_DRY_RUN:WORKSET") as Page;
    requireFact(text(scope, "Category") === "OTHER" && text(scope, "State") === "CONFIRMED"
      && text(scope, "Version") === "SALES_DRY_RUN_WORKSET/1"
      && runtime.adapter.controlPlane.localAnswerSources?.includes(text(scope, "Source")), "B7 scope metadata invalid");
    const w = parseB7Workset(propText(scope, "Value") ?? "", runtime);
    requireFact(w, "B7 workset encoding/identity/pins/selection invalid"); remember("BUSINESS_CONFIG", scope);
    const gates = await query("QUALIFICATION_GATES", { and: [{ property: "Active", checkbox: { equals: true } }, { property: "Hard Gate", checkbox: { equals: true } }] });
    requireFact(gates.length === w.qualification_gates.length, "B7 complete hard-gate set changed");
    const gateFields = { gate_key: "Gate Key", active: "Active", hard_gate: "Hard Gate", version: "Version", pass_condition: "Pass Condition",
      required_evidence: "Required Evidence", criterion: "Criterion", fail_disposition: "Fail Disposition" };
    for (const g of w.qualification_gates) {
      const matches = gates.filter(p => text(p, "Gate Key") === g.gate_key); requireFact(matches.length === 1, "B7 gate key absent/ambiguous");
      const p = matches[0] as Page;
      for (const [k, f] of Object.entries(gateFields)) requireFact(text(p, f) === String(g[k as keyof typeof g]), "B7 frozen hard-gate definition changed");
      remember("QUALIFICATION_GATES", p);
    }
    const accounts = await keys("ACCOUNTS", w.sample.map(s => s.account_key));
    for (const s of w.sample) {
      const p = accounts.get(s.account_key) as Page;
      requireFact(text(p, "Qualification") === s.expected_qualification && text(p, "Source") && text(p, "Next Action"), "B7 sample classification/research incomplete");
      remember("ACCOUNTS", p);
    }
    const wantedEvidence = w.sample.flatMap(s => s.evidence.map(e => e.source_url));
    const evidenceRows = await keys("EVIDENCE", wantedEvidence);
    const ready = w.sample.filter(s => s.expected_qualification === "READY");
    const slices = await query("EVIDENCE", { or: ready.map(s => ({ property: "Account", relation: { contains: idOf(accounts.get(s.account_key) as Page) } })) });
    for (const p of slices) for (const f of ["Account", "Gate"])
      requireFact((p.properties[f] as { has_more?: boolean } | undefined)?.has_more !== true, "B7 complete Evidence slice has an unread property tail");
    function tokens(p: Page): string[] {
      const xs = (propText(p, "Gate") ?? "").split("\n").map(s => s.trim());
      if (xs.length === 1 && xs[0] === "") return []; // an unassigned Evidence row belongs to no hard-gate slice
      requireFact(xs.every(Boolean) && new Set(xs).size === xs.length, "B7 Evidence gate tokens invalid"); return xs;
    }
    for (const s of w.sample) {
      const account = accounts.get(s.account_key) as Page;
      for (const e of s.evidence) {
        const p = evidenceRows.get(e.source_url) as Page;
        requireFact(tokens(p).includes(e.gate_key) && propRelationIds(p, "Account").includes(idOf(account)), "B7 Evidence membership differs");
        remember("EVIDENCE", p);
      }
      if (s.expected_qualification !== "READY") continue;
      for (const g of w.qualification_gates) {
        const actual = slices.filter(p => propRelationIds(p, "Account").includes(idOf(account)) && tokens(p).includes(g.gate_key));
        const refs = s.evidence.filter(e => e.gate_key === g.gate_key);
        requireFact(actual.length === refs.length && actual.every(p => refs.some(e => e.source_url === propText(p, "Source URL") && idOf(evidenceRows.get(e.source_url) as Page) === idOf(p))),
          "B7 complete Evidence slice has undisclosed/duplicate rows");
        const supporting = refs.filter(e => e.role === "SUPPORTING"); requireFact(supporting.length > 0, "B7 READY has no supporting Evidence");
        for (const e of supporting) {
          const p = evidenceRows.get(e.source_url) as Page;
          requireFact(text(p, "Claim") && http.safeParse(e.source_url).success && text(p, "Source Provider")
            && ["OBSERVED_FACT", "SOURCE_CLAIM"].includes(text(p, "Type")) && ["CERTAIN", "LIKELY", "POSSIBLE"].includes(text(p, "Confidence")), "B7 supporting Evidence is absent/UNKNOWN");
          const date = text(p, "Source Date"); requireFact(!date || Number.isFinite(Date.parse(date)), "B7 source date invalid");
        }
      }
    }
    const contacts = await keys("CONTACTS", w.cohort.map(c => c.contact_key));
    const drafts = await keys("OUTREACH_PIPELINE", w.cohort.map(c => c.draft_key));
    const tasks = await keys("TASKS", w.cohort.flatMap(c => c.task_keys));
    for (const c of w.cohort) {
      const a = accounts.get(c.account_key) as Page, contact = contacts.get(c.contact_key) as Page, draft = drafts.get(c.draft_key) as Page;
      requireFact(text(a, "Qualification") === "READY" && text(a, "Do Not Contact") === "false" && text(contact, "Do Not Contact") === "false"
        && !["BOUNCED", "OPT_OUT"].includes(text(contact, "Lifecycle"))
        && propRelationIds(contact, "Account").length === 1 && propRelationIds(contact, "Account")[0] === idOf(a), "B7 cohort unsafe or foreign Contact");
      const member = (p: Page) => propRelationIds(p, "Account").includes(idOf(a)) && propRelationIds(p, "Contact").includes(idOf(contact));
      const channel = text(draft, "Channel");
      requireFact(address("OUTREACH_PIPELINE").schema.options.get("Channel")?.includes(channel), "B7 channel not declared", "HOLD_SCHEMA_MISMATCH");
      requireFact(channel === "Email" ? ["VERIFIED", "PUBLIC_SOURCE"].includes(text(contact, "Email Status")) && text(contact, "Email Source") : text(contact, "Email Status") !== "INVALID",
        "B7 channel contact proof insufficient");
      requireFact(propRelationIds(draft, "Account").length === 1 && propRelationIds(draft, "Account")[0] === idOf(a)
        && propRelationIds(draft, "Contact").length === 1 && propRelationIds(draft, "Contact")[0] === idOf(contact) && text(draft, "Stage") === "Draft"
        && ["Outreach", "Angle", "Evidence-led opener", "Message version"].every(f => text(draft, f))
        && ["Sent date", "Last touch", "Next touch", "Outcome", "Objection", "Reply summary"].every(f => !text(draft, f)), "B7 draft incomplete or carries an external effect");
      remember("CONTACTS", contact); remember("OUTREACH_PIPELINE", draft);
      for (const ref of w.sample.find(s => s.account_key === c.account_key)!.evidence)
        requireFact(propRelationIds(evidenceRows.get(ref.source_url) as Page, "Contact").includes(idOf(contact)), "B7 Evidence Contact membership differs");
      for (const key of c.task_keys) {
        const t = tasks.get(key) as Page;
        const allowed = (f: string) => address("TASKS").schema.options.get(f)?.includes(text(t, f));
        requireFact(text(t, "Runtime ID") === runtime.runtime_id && member(t) && text(t, "Task") && text(t, "Expected Outcome")
          && allowed("Type") && allowed("Status") && !["DONE", "CANCELLED"].includes(text(t, "Status")) && allowed("Authority")
          && (text(t, "Type") !== "SEND" || ["HUMAN_APPROVAL", "HUMAN_ONLY"].includes(text(t, "Authority"))), "B7 next Task missing, unsafe or foreign");
        remember("TASKS", t);
      }
    }
    const wanted = [...proofRows.values()].flatMap(r => r.fields.map(field => ({ page_ref: idOf(r.page), field })));
    requireFact(wanted.length <= 16384 && deps.store.receipts.findFinalByFields, "B7 bounded backend proof lookup unavailable");
    const results = await deps.store.receipts.findFinalByFields({ principal_id: binding.principal_id, project: binding.project, lane: binding.lane,
      runtime_id: runtime.runtime_id, runtime_generation: runtime.runtime_generation, governing_spec_version: v.spec,
      governing_schema_version: v.schema, governing_control_version: v.control }, wanted);
    requireFact(results.length === wanted.length, "B7 exact current-tuple field lineage missing; unsupported adoption/migration stays HOLD");
    requireFact(new Set(results.map(r => JSON.stringify([r.page_ref, r.field]))).size === wanted.length, "B7 duplicate field proof does not cover the scope");
    const planCache = new Map<string, Plan>(), proofStamps: [string, string, string][] = [];
    const journalCache = new Map<string, Awaited<ReturnType<typeof deps.store.planWrites.list>>>();
    const targetCache = new Map<string, Awaited<ReturnType<typeof deps.store.receipts.get>>>();
    for (const r of results) {
      const observed = proofRows.get(r.page_ref); requireFact(observed && observed.fields.includes(r.field), "B7 proof outside selected scope");
      const receipt = r.receipt; let plan = planCache.get(receipt.plan_id);
      if (!plan) { plan = await deps.store.plans.get(receipt.plan_id); requireFact(plan, "B7 terminal Plan missing"); planCache.set(plan.plan_id, plan); }
      requireFact(receipt.type === "FINAL" && receipt.status === "VALID" && receipt.principal_id === binding.principal_id
        && receipt.runtime_id === runtime.runtime_id && receipt.runtime_generation === runtime.runtime_generation
        && plan.plan_state === "FINAL_VERIFIED" && plan.principal_id === binding.principal_id && plan.project === binding.project
        && plan.lane === binding.lane && plan.runtime_id === runtime.runtime_id && plan.runtime_generation === runtime.runtime_generation
        && plan.governing_spec_version === v.spec && plan.governing_schema_version === v.schema && plan.governing_control_version === v.control, "B7 terminal proof identity/pins invalid");
      let journal = journalCache.get(plan.plan_id);
      if (!journal) { journal = await deps.store.planWrites.list(plan.plan_id); journalCache.set(plan.plan_id, journal); }
      const symbols = Object.fromEntries(journal.filter(j => (j.status === "DONE" || j.status === "OBSERVED") && j.created_id).map(j => [j.symbol, j.created_id as string]));
      requireFact([...plan.stage1_writes, ...plan.finalization_writes, plan.state_last_write].every(i => journal.some(j => j.symbol === i.symbol && ["DONE", "OBSERVED"].includes(j.status))), "B7 immutable journal incomplete");
      const op = plan.operations.find(o => normalizeId(o.physical_target_ref ?? symbols[`TARGET_${o.ordinal}`]) === r.page_ref && o.compared_fields.includes(r.field));
      requireFact(op && op.logical_resource_key === `SALES:${observed.resource}` && normalizeId(op.target_data_source_ref) === normalizeId(address(observed.resource).ds)
        && op.natural_key_property === address(observed.resource).key && op.natural_key === propText(observed.page, address(observed.resource).key), "B7 actual target lineage invalid");
      requireFact(plan.state_last_write.operation_property_ids?.[String(op.ordinal)]?.[r.field] === address(observed.resource).schema.propertyIds?.get(r.field), "B7 native property lineage absent/changed");
      let targetReceipt = targetCache.get(plan.plan_id);
      if (!targetReceipt && receipt.target_receipt_id) { targetReceipt = await deps.store.receipts.get(receipt.target_receipt_id); targetCache.set(plan.plan_id, targetReceipt); }
      requireFact(targetReceipt?.type === "TARGET" && targetReceipt.status === "CONSUMED" && targetReceipt.plan_id === plan.plan_id, "B7 FINAL lacks consumed TARGET lineage");
      requireFact(compareFields({ ...op, compared_fields: [r.field] }, observed.page, true, symbols).ok, "B7 proved field differs from fresh observation");
      proofStamps.push([r.page_ref, r.field, receipt.receipt_id]);
    }
    const snapshot = [...proofRows.values()].map(r => [r.resource, idOf(r.page), r.fields.map(f => [f, address(r.resource).schema.propertyIds?.get(f) ?? null, observedField(r.page, f) ?? null])]);
    proofStamps.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return { kind: "SATISFIED", fingerprint: createHash("sha256").update(canonicalJson({ snapshot, proofStamps, addresses: [...addresses].map(([r, a]) => [r, a.ds]), pins: v })).digest("hex") };
  } catch (err) {
    if (!(err instanceof Refusal)) throw err; // existing shared deadline/429 handling, never convert an exhausted read into PASS
    return { kind: "HOLD", code: err.code, evidence: [err.reason], safe_action: "compléter seulement les éléments manquants de l'essai, sans envoi ni changement d'autorité" };
  }
}

/** Independent TARGET/FINAL use raw fresh reads, never derivation's in-call cached rows. */
export async function verifyB7Graph(deps: HarnessDeps, binding: BindingRecord, runtime: ResolvedRuntime, plan: Plan): Promise<Extract<B7Observation, { kind: "HOLD" }> | undefined> {
  const hash = plan.state_last_write.b7_graph_fingerprint; if (!hash) return undefined;
  const read = await observeB7DryRun(deps, binding, runtime);
  if (read.kind === "HOLD") return read;
  return read.fingerprint === hash ? undefined : { kind: "HOLD", code: "HOLD_CONFLICT", evidence: ["B7 scoped dependencies changed since derivation"], safe_action: "reconcilier uniquement le graphe concerné avant la promotion" };
}
