/**
 * PT-CP-012 — W2.2 SETUP context (CONTRACT_PACK/0.3.0-candidate, S2 amendment, GW2.2R/S/T/U).
 *
 * `SALES_SETUP_INPUTS` selects the SETUP context for every SALES binding. Its four sections are served through the
 * real `os_resume` transport from the bound runtime's own Business Configuration, under the bound governing
 * contract's cursor transitions — or ABSENT, never guessed. The historical hints keep their selection, completeness
 * and pointers; only META_SETUP_INPUTS gains four ABSENT SETUP sections.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildContractPack, canonicalize, packTelemetry,
  type ContextSection, type ContextSource, type ContractPack, type PackInput, type SelectedContext,
} from "../../src/contractPack/pack.ts";
import {
  allowedNeedsForLane, CANDIDATE_POLICY_VERSION, CONTEXT_BOUNDS, CONTEXT_KINDS, CONTEXT_POLICY, CONTEXT_SECTIONS,
  isGtmNeed, LANE_OPTIONAL_RESOURCES, NEED_CONTEXT, NEED_LANE, NEED_RESOURCES, POLICY_VERSION, RESOURCE_KEYS,
  type ContextNeed, type ContextPolicy,
} from "../../src/contractPack/catalog.ts";
import { readSetupSources, type SetupSafety } from "../../src/contractPack/setupSources.ts";
import type { ResolvedRuntime } from "../../src/resolvers/types.ts";
import { prepareIntentFor, type PendingStepInput } from "../../src/resume/pendingInput.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import type { ControlPlaneGrammar, DerivedCursorTransition } from "../../src/versions/adapters/controlPlane.ts";
import { synthetic } from "./meta-fixtures.ts";
import { registryRow } from "./resume-fixtures.ts";
import { IDS as SALES_IDS } from "./sales-fixtures.ts";
import {
  answerRow, BC, bindMeta, bindSales, buildSetupWorld, CONFIG, COPIED_REGISTRY, fullSetupLine, GATES, itemOf,
  nextActionOf, nextQuestionOf, NOTE_MARK, proveRows, RecordingClient, resume, RIVAL_MARK, runtimeOf, SCORE_MARK,
  stepOf, STEPS, withControlPlane, type SetupWorld, type Step,
} from "./pt-cp-012.fixtures.ts";

const VERSIONS = { governing_spec: "S", governing_schema: "H", governing_control: "C", candidate_versions: [] } as const;
const packFor = (lane: "META" | "SALES", topic_hint?: string, extra: Partial<PackInput> = {}): ContractPack =>
  buildContractPack({ lane, runtime_generation: "g1", versions: VERSIONS, safety: {}, open_backend_plan: "NONE", ...(topic_hint === undefined ? {} : { topic_hint }), ...extra }).pack;

const bag = (e: Envelope): Record<string, unknown> => (e.status === "OK" ? (e.result as Record<string, unknown>) : e.observations);
const packOf = (e: Envelope): ContractPack => bag(e)["contract_pack"] as ContractPack;
const kinds = (p: ContractPack) => p.selected_context.contexts.map((c) => c.context);
const measure = (sc: SelectedContext) => Buffer.byteLength(JSON.stringify(sc), "utf8");
const evidenceOf = (e: Envelope) => JSON.stringify((e as { evidence?: unknown }).evidence ?? e.warnings);

const SETUP_KEYS = ["SETUP_POSITION", "SETUP_PENDING_INPUT", "SETUP_RULES", "SETUP_ANSWERS"] as const;
type SetupKey = (typeof SETUP_KEYS)[number];

const setupOf = (sc: SelectedContext): readonly ContextSection[] => {
  const block = sc.contexts.find((c) => c.context === "SETUP");
  assert.ok(block, "SETUP must be served");
  return block.sections;
};
const sectionOf = (sc: SelectedContext, key: SetupKey): ContextSection => {
  const s = setupOf(sc).find((x) => x.section_key === key);
  assert.ok(s, "section " + key);
  return s;
};
const statuses = (sc: SelectedContext) => setupOf(sc).map((s) => [s.section_key, s.source_status]);
const ALL_ABSENT = SETUP_KEYS.map((k) => [k, "ABSENT"]);

/** The whole envelope MINUS the pack: the safety spine, byte-for-byte. */
function safetyView(e: Envelope): string {
  const c = JSON.parse(JSON.stringify(e)) as { result?: Record<string, unknown>; observations?: Record<string, unknown> };
  if (c.result) delete c.result["contract_pack"];
  if (c.observations) delete c.observations["contract_pack"];
  return JSON.stringify(c);
}

const ORDER: readonly string[] = GATES;
const SPEC = (key: SetupKey) => CONTEXT_SECTIONS.SETUP.find((s) => s.section_key === key)!;
const presentSection = (key: SetupKey, items: readonly Record<string, string>[]): ContextSection => ({
  section_key: key, source_key: key, source_status: "PRESENT", projected_keys: SPEC(key).projected_keys,
  items, served: items.length, available: items.length, omitted: 0, truncated_by: "NONE",
});

/** The independent oracle of a clean fixture at `gate`: every earlier answer, split by its published category. */
function expectedSetup(gate: string): readonly ContextSection[] {
  const before = STEPS.filter((s) => ORDER.indexOf(s.gate) < ORDER.indexOf(gate));
  const pending = STEPS.find((s) => s.gate === gate);
  return [
    presentSection("SETUP_POSITION", [{ gate_key: gate, gate_status: "OPEN", next_question: nextQuestionOf(gate), next_safe_action: nextActionOf(gate) }]),
    presentSection("SETUP_PENDING_INPUT", pending ? [{ gate_key: gate, logical_resource_key: CONFIG, natural_key: pending.key, answer_field: "Value" }] : []),
    presentSection("SETUP_RULES", before.filter((s) => s.category === "CONSTRAINT").map((s) => itemOf(s))),
    presentSection("SETUP_ANSWERS", before.filter((s) => s.category !== "CONSTRAINT").map((s) => itemOf(s))),
  ];
}

/** A resume-state slice at `gate`, as the derivation would hand it over. */
const safetyAt = (gate: string, status = "OPEN", pending?: PendingStepInput): SetupSafety => ({
  gate: {
    gate_key: gate, status, control_confirmation_state: "UNKNOWN", metadata_stale: "NOT_APPLICABLE", gate_last_edited_at: "2030-01-02T00:00:00.000Z",
    formal_blocker: "NONE", formal_next_action: nextActionOf(gate), formal_next_question: nextQuestionOf(gate), source: "CURSOR",
  },
  next_safe_action: nextActionOf(gate),
  ...(pending ? { pending_step_input: pending } : {}),
});

interface ReadAt { readonly reader: RecordingClient; readonly sources: readonly ContextSource[]; source(key: SetupKey): ContextSource }
async function readAt(sw: SetupWorld, gate: string, o: { runtime?: ResolvedRuntime; status?: string; lane?: "META" | "SALES"; needs?: readonly ContextNeed[]; failing?: readonly string[] } = {}): Promise<ReadAt> {
  const reader = new RecordingClient(sw.w.map);
  for (const k of o.failing ?? []) reader.failing.add(k);
  const runtime = o.runtime ?? await runtimeOf(sw);
  const sources = await readSetupSources(reader, runtime, o.lane ?? "SALES", o.needs ?? ["SALES_SETUP_INPUTS"], safetyAt(gate, o.status));
  return {
    reader, sources,
    source(key) {
      const s = sources.find((x) => x.source_key === key);
      assert.ok(s, "source " + key);
      return s;
    },
  };
}
const answersStatus = (r: ReadAt) => [r.source("SETUP_RULES").status, r.source("SETUP_ANSWERS").status];
const configReads = (r: RecordingClient) => r.on(BC("rep-a").ds);
const list = (results: unknown[]) => ({ results, has_more: false, next_cursor: null });
const rowsThrough = (n: number) => STEPS.slice(0, n).map((s) => answerRow(BC("rep-a").ds, s));

/** A clean, proved fixture on `gate`, bound and resumed with the hint. */
async function resumedAt(gate: string, hint = "SALES_SETUP_INPUTS"): Promise<{ sw: SetupWorld; r: Envelope }> {
  const n = ORDER.indexOf(gate);
  const sw = buildSetupWorld(gate, n);
  const bound = await bindSales(sw);
  await proveRows(sw, bound, rowsThrough(n));
  sw.client.reset();
  return { sw, r: await resume(sw, bound.handle, hint) };
}

// ─────────────────────────────── catalogue delta ───────────────────────────────

test("PT-CP-012/a: SALES_SETUP_INPUTS is the exact allowed-needs delta: SALES-only, SETUP, no pointer, not GTM", () => {
  assert.equal(NEED_LANE.SALES_SETUP_INPUTS, "SALES");
  assert.equal(NEED_CONTEXT.SALES_SETUP_INPUTS, "SETUP");
  assert.deepEqual(NEED_RESOURCES.SALES_SETUP_INPUTS, []);
  assert.equal(isGtmNeed("SALES_SETUP_INPUTS"), false);
  assert.deepEqual([...CONTEXT_KINDS], ["SETUP", "DAILY", "EXTERNAL_ACTION"], "still three contexts");
  // Every SALES binding of the candidate binary, GTM or not; META never.
  assert.deepEqual(allowedNeedsForLane("SALES"), ["CURRENT_WORK", "SALES_EXTERNAL_ACTION", "SALES_EMAIL_RECONCILIATION", "SALES_SETUP_INPUTS"]);
  assert.deepEqual(allowedNeedsForLane("SALES", true), ["CURRENT_WORK", "SALES_EXTERNAL_ACTION", "SALES_EMAIL_RECONCILIATION", "SALES_SETUP_INPUTS", "SALES_GTM_CONTEXT"]);
  assert.deepEqual(allowedNeedsForLane("META"), ["CURRENT_WORK", "META_SETUP_INPUTS"]);
  assert.deepEqual(allowedNeedsForLane("META", true), ["CURRENT_WORK", "META_SETUP_INPUTS", "META_GTM_ANALYSIS"]);
  // The optional pointer sets and the version strings are untouched.
  assert.deepEqual(LANE_OPTIONAL_RESOURCES.SALES, [RESOURCE_KEYS.SALES_EXTERNAL_ACTIONS, RESOURCE_KEYS.SALES_GMAIL_RECONCILIATION]);
  assert.deepEqual(LANE_OPTIONAL_RESOURCES.META, [RESOURCE_KEYS.META_SALES_RUNTIME_INPUTS]);
  assert.equal(POLICY_VERSION, "CONTRACT_PACK/0.1.0");
  assert.equal(CANDIDATE_POLICY_VERSION, "CONTRACT_PACK/0.2.0");

  // Recognized, not unknown_need_token, even while the external pointer policy is still 0.1.0.
  const p = packFor("SALES", "SALES_SETUP_INPUTS");
  assert.equal(p.policy_version, POLICY_VERSION);
  assert.equal(p.policy_role, undefined, "the pointer policy is not adopted by a catalogue extension");
  assert.deepEqual([p.completeness, p.completeness_reason], ["COMPLETE", "NONE"]);
  assert.deepEqual(p.requested_needs, ["SALES_SETUP_INPUTS"]);
  assert.deepEqual(p.normalized_needs, ["SALES_SETUP_INPUTS"]);
  assert.deepEqual(p.selected_pointers, []);
  assert.deepEqual(p.omitted_resource_keys, LANE_OPTIONAL_RESOURCES.SALES);
  assert.deepEqual(kinds(p), ["SETUP"]);
  assert.deepEqual(p.allowed_needs_for_lane, allowedNeedsForLane("SALES"));
  // Canonical position: after SALES_EMAIL_RECONCILIATION, whatever the caller order.
  assert.deepEqual(packFor("SALES", "SALES_SETUP_INPUTS,SALES_EMAIL_RECONCILIATION").normalized_needs, ["SALES_EMAIL_RECONCILIATION", "SALES_SETUP_INPUTS"]);
  // Telemetry keeps the S8 fields only.
  assert.deepEqual(Object.keys(packTelemetry(p)).sort(), ["completeness", "completeness_reason", "normalized_needs", "pointer_count", "policy_version", "resource_keys"]);
  assert.deepEqual(packTelemetry(p).resource_keys, []);
});

test("PT-CP-012/b: historical hints keep selection, completeness and pointers; only META_SETUP_INPUTS gains four ABSENT sections", () => {
  const sel = (p: ContractPack) => ({ n: p.normalized_needs, s: p.selected_pointers.map((x) => x.resource_key), o: p.omitted_resource_keys, c: [p.completeness, p.completeness_reason], k: kinds(p) });
  const EXT = RESOURCE_KEYS.SALES_EXTERNAL_ACTIONS, GMAIL = RESOURCE_KEYS.SALES_GMAIL_RECONCILIATION, INPUTS = RESOURCE_KEYS.META_SALES_RUNTIME_INPUTS;
  assert.deepEqual(sel(packFor("SALES")), { n: ["CURRENT_WORK"], s: [], o: [EXT, GMAIL], c: ["COMPLETE", "NONE"], k: ["DAILY"] });
  assert.deepEqual(sel(packFor("SALES", "CURRENT_WORK")), { n: ["CURRENT_WORK"], s: [], o: [EXT, GMAIL], c: ["COMPLETE", "NONE"], k: ["DAILY"] });
  assert.deepEqual(sel(packFor("SALES", "SALES_EXTERNAL_ACTION")), { n: ["SALES_EXTERNAL_ACTION"], s: [EXT], o: [GMAIL], c: ["COMPLETE", "NONE"], k: ["EXTERNAL_ACTION"] });
  assert.deepEqual(sel(packFor("SALES", "SALES_EMAIL_RECONCILIATION")), { n: ["SALES_EMAIL_RECONCILIATION"], s: [EXT, GMAIL], o: [], c: ["COMPLETE", "NONE"], k: ["EXTERNAL_ACTION"] });
  assert.deepEqual(sel(packFor("SALES", "GTM_APPROACH_HISTORY")), { n: ["CURRENT_WORK"], s: [], o: [EXT, GMAIL], c: ["NEEDS_EXPANSION", "unknown_need_token"], k: ["DAILY"] });
  assert.deepEqual(sel(packFor("SALES", "META_SETUP_INPUTS")), { n: ["CURRENT_WORK"], s: [], o: [EXT, GMAIL], c: ["HOLD", "cross_lane_rejected"], k: ["DAILY"] });
  assert.deepEqual(sel(packFor("META", "CURRENT_WORK")), { n: ["CURRENT_WORK"], s: [], o: [INPUTS], c: ["COMPLETE", "NONE"], k: ["DAILY"] });
  assert.deepEqual(sel(packFor("META", "SALES_EXTERNAL_ACTION")), { n: ["CURRENT_WORK"], s: [], o: [INPUTS], c: ["HOLD", "cross_lane_rejected"], k: ["DAILY"] });

  // META_SETUP_INPUTS: same pointer and completeness; its content shape is four SETUP sections, all ABSENT.
  const meta = packFor("META", "META_SETUP_INPUTS");
  assert.deepEqual(sel(meta), { n: ["META_SETUP_INPUTS"], s: [INPUTS], o: [], c: ["COMPLETE", "NONE"], k: ["SETUP"] });
  assert.deepEqual(statuses(meta.selected_context), ALL_ABSENT);
  for (const s of setupOf(meta.selected_context)) assert.deepEqual([s.served, s.available, s.omitted, s.truncated_by, s.items], [0, 0, 0, "NONE", []]);

  // Adding the new need never moves the pointers or completeness of a historical need.
  for (const hint of ["CURRENT_WORK", "SALES_EXTERNAL_ACTION", "SALES_EMAIL_RECONCILIATION"]) {
    const before = packFor("SALES", hint);
    const after = packFor("SALES", hint + ",SALES_SETUP_INPUTS");
    assert.deepEqual(after.selected_pointers, before.selected_pointers, hint);
    assert.deepEqual(after.omitted_resource_keys, before.omitted_resource_keys, hint);
    assert.deepEqual([after.completeness, after.completeness_reason], [before.completeness, before.completeness_reason], hint);
  }

  // GTM stays pointer-only and 0.2: SETUP is added beside its pointers, never instead of them.
  const gtm = { gtm_capability: true, gtm_containers: [] } as const;
  const onlyGtm = packFor("SALES", "SALES_GTM_CONTEXT", gtm);
  const both = packFor("SALES", "SALES_SETUP_INPUTS,SALES_GTM_CONTEXT", gtm);
  assert.deepEqual(kinds(onlyGtm), []);
  assert.deepEqual(kinds(both), ["SETUP"]);
  assert.equal(both.policy_version, CANDIDATE_POLICY_VERSION);
  assert.deepEqual(both.selected_pointers, onlyGtm.selected_pointers);
  assert.deepEqual([both.completeness, both.completeness_reason], [onlyGtm.completeness, onlyGtm.completeness_reason]);
  assert.deepEqual(kinds(packFor("META", "META_GTM_ANALYSIS", { gtm_capability: true })), []);
});

// ─────────────────────────────── os_resume transport, B0 → B7 ───────────────────────────────

test("PT-CP-012/c: os_resume serves exactly the SETUP content of every step B0 → B7, nothing more", async () => {
  for (const gate of GATES) {
    const { r } = await resumedAt(gate);
    assert.equal(r.code, "RESUMED", gate + " " + evidenceOf(r));
    const result = bag(r);
    assert.equal(result["pending_confirmation"], undefined, gate + ": every answer of the fixture is proved");
    const p = packOf(r);
    assert.deepEqual(p.normalized_needs, ["SALES_SETUP_INPUTS"], gate);
    assert.deepEqual([p.completeness, p.completeness_reason], ["COMPLETE", "NONE"], gate);
    assert.deepEqual(p.selected_pointers, [], gate);
    assert.deepEqual(kinds(p), ["SETUP"], gate);
    assert.deepEqual(setupOf(p.selected_context), expectedSetup(gate), gate);
    // The position is the derived resume state, carried; never an action rebuilt by the projector.
    const position = sectionOf(p.selected_context, "SETUP_POSITION").items[0]!;
    assert.equal(position["next_safe_action"], result["next_safe_action"], gate);
    assert.equal(position["next_question"], (result["gate"] as { formal_next_question: string }).formal_next_question, gate);
    assert.equal(p.selected_context.bounds.truncated, false, gate);
    assert.equal(p.selected_context.bounds.serialized_bytes, measure(p.selected_context), gate);
  }
});

test("PT-CP-012/d: at B5 the five B0 → B4 values are served exactly, the B4 constraint included, and nowhere else", async () => {
  const sw = buildSetupWorld("B5_OUTREACH", 5);
  const bound = await bindSales(sw);
  await proveRows(sw, bound, rowsThrough(5));
  const logged: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const saved = methods.map((m) => console[m]);
  methods.forEach((m) => { console[m] = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); }; });
  const r = await (async () => {
    try { return await resume(sw, bound.handle, "SALES_SETUP_INPUTS"); } finally { methods.forEach((m, i) => { console[m] = saved[i]!; }); }
  })();

  assert.equal(r.code, "RESUMED", evidenceOf(r));
  const result = bag(r);
  assert.equal(result["pending_confirmation"], undefined, "no foreign or orphan Business Configuration row in this fixture");
  const sc = packOf(r).selected_context;
  assert.deepEqual(sectionOf(sc, "SETUP_RULES").items, [itemOf(stepOf("B4_QUALIFICATION"))], "the B4 hard gate is a rule");
  assert.deepEqual(sectionOf(sc, "SETUP_ANSWERS").items, ["B0_DISCOVERY", "B1_OFFER", "B2_ICP", "B3_DATA"].map((g) => itemOf(stepOf(g))));
  assert.ok(sc.bounds.serialized_bytes <= CONTEXT_BOUNDS.max_serialized_bytes);
  assert.equal(sc.bounds.truncated, false, "the five values fit S4–S6");

  // The pending input is an address: exactly four keys per row, no structured value, no intent.
  const pending = sectionOf(sc, "SETUP_PENDING_INPUT").items;
  assert.deepEqual(pending, [{ gate_key: "B5_OUTREACH", logical_resource_key: CONFIG, natural_key: "B5_OUTREACH:SEQUENCE", answer_field: "Value" }]);
  const served = JSON.stringify(sc);
  for (const leak of ["required_values", "required_non_empty", "MESSAGING", "$answer", "prepare_intent", "mutations", "desired_changes"]) {
    assert.equal(served.includes(leak), false, "selected_context carries no structured value or intent: " + leak);
  }
  // The executable intent stays where it was, in the exact shape os_prepare accepts.
  assert.deepEqual(r.next.prepare_intent, prepareIntentFor(result["pending_step_input"] as PendingStepInput));

  // Only projected keys, only scalar strings; the seller's own columns are ignored, not carried.
  for (const s of setupOf(sc)) {
    for (const item of s.items) {
      assert.deepEqual(Object.keys(item).filter((k) => !s.projected_keys.includes(k)), [], s.section_key);
      for (const v of Object.values(item)) assert.equal(typeof v, "string", s.section_key);
    }
  }
  for (const leak of [NOTE_MARK, String(SCORE_MARK), "Effective At", "Notes", "Score perso", RIVAL_MARK]) assert.equal(served.includes(leak), false, "not projected: " + leak);

  // D7: the values exist in selected_context for the bound principal, and nowhere else.
  const outside = JSON.parse(JSON.stringify(r)) as { result: { contract_pack: { selected_context?: unknown } } };
  delete outside.result.contract_pack.selected_context;
  const rest = JSON.stringify(outside);
  const events = JSON.stringify(await sw.deps.store.events.list());
  const telemetry = JSON.stringify(packTelemetry(packOf(r)));
  for (const step of STEPS.slice(0, 5)) {
    assert.ok(served.includes(step.value), "served: " + step.gate);
    for (const [where, text] of [["envelope", rest], ["events", events], ["telemetry", telemetry], ["logs", logged.join("\n")], ["warnings", JSON.stringify(r.warnings)]] as const) {
      assert.equal(text.includes(step.value), false, step.gate + " value leaked into " + where);
      assert.equal(text.includes("SENTINEL"), false, "a sentinel leaked into " + where);
    }
  }
  assert.equal(rest.includes(NOTE_MARK), false);
});

test("PT-CP-012/e: only the bound runtime's Business Configuration is read; a rival runtime and a copied Registry show zero reads", async () => {
  const { sw, r } = await resumedAt("B5_OUTREACH");
  assert.equal(r.code, "RESUMED", evidenceOf(r));
  const rival = BC("rep-b");
  for (const id of [rival.parent, rival.db, rival.ds, COPIED_REGISTRY.db, COPIED_REGISTRY.ds]) {
    assert.deepEqual(sw.client.on(id), [], "never read: " + id);
  }
  assert.equal(JSON.stringify(r).includes(RIVAL_MARK), false);
  // Every query on the bound Business Configuration names one Config Item, by server equality, and nothing else.
  const keyed = new Set(STEPS.map((s) => canonicalize({ property: "Config Item", title: { equals: s.key } })));
  const queries = configReads(sw.client).filter((x) => x.op === "query");
  assert.ok(queries.length >= 5);
  for (const q of queries) assert.ok(keyed.has(canonicalize(q.filter)), "unexpected filter " + JSON.stringify(q.filter));

  // The SETUP reader alone: one schema read, then one keyed query per relevant transition, in contract order.
  const a = BC("rep-a");
  const read = await readAt(sw, "B5_OUTREACH");
  assert.deepEqual(read.reader.reads.filter((x) => x.op === "query"), STEPS.slice(0, 5).map((s) => ({ op: "query", id: a.ds, filter: { property: "Config Item", title: { equals: s.key } } })));
  assert.deepEqual(read.reader.reads.filter((x) => x.op === "data_source"), [{ op: "data_source", id: a.ds }]);
  assert.deepEqual([...new Set(read.reader.reads.map((x) => x.id))].sort(), [SALES_IDS("rep-a").root, a.parent, a.db, a.ds].sort(), "the bound root and its own database only");
});

// ─────────────────────────────── source rules (reader level) ───────────────────────────────

test("PT-CP-012/f: at B0 the answers are PRESENT and empty without any schema read or data query, once discovery is unique", async () => {
  const a = BC("rep-a");
  const sw = buildSetupWorld("B0_DISCOVERY");
  const r0 = await readAt(sw, "B0_DISCOVERY");
  assert.deepEqual(answersStatus(r0), ["PRESENT", "PRESENT"]);
  assert.deepEqual([r0.source("SETUP_RULES").rows, r0.source("SETUP_ANSWERS").rows], [[], []]);
  assert.deepEqual(configReads(r0.reader), [], "no schema read and no data query on B0");
  assert.equal(r0.reader.on(a.db).length, 1, "the database was discovered under the bound root");

  // Not discoverable under the bound root: ABSENT, never "no answers".
  sw.w.map.set(`children:${a.parent}`, list([]));
  const missing = await readAt(sw, "B0_DISCOVERY");
  assert.deepEqual(answersStatus(missing), ["ABSENT", "ABSENT"]);
  // Two candidates: ambiguous, ABSENT, and neither is read.
  const twin = { id: synthetic("pt-cp-012-config-db-twin"), type: "child_database", child_database: { title: "Business Configuration" } };
  sw.w.map.set(`children:${a.parent}`, list([{ id: a.db, type: "child_database", child_database: { title: "Business Configuration" } }, twin]));
  const ambiguous = await readAt(sw, "B0_DISCOVERY");
  assert.deepEqual(answersStatus(ambiguous), ["ABSENT", "ABSENT"]);
  assert.deepEqual(configReads(ambiguous.reader), []);
  // Position and pending address are still served: only the unresolvable source is ABSENT.
  assert.deepEqual([ambiguous.source("SETUP_POSITION").status, ambiguous.source("SETUP_PENDING_INPUT").status], ["PRESENT", "PRESENT"]);
});

test("PT-CP-012/g: a Business Configuration schema without the six typed columns makes both sections ABSENT before any query", async () => {
  const a = BC("rep-a");
  const props = (over: Record<string, { type: string } | undefined>) => {
    const base: Record<string, { type: string }> = { "Config Item": { type: "title" }, Category: { type: "select" }, State: { type: "select" }, Value: { type: "rich_text" }, Version: { type: "rich_text" }, Source: { type: "rich_text" }, Notes: { type: "rich_text" } };
    for (const [k, v] of Object.entries(over)) { if (v) base[k] = v; else delete base[k]; }
    return { properties: base };
  };
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ["missing Source", props({ Source: undefined })],
    ["Version as select", props({ Version: { type: "select" } })],
    ["Category as rich_text", props({ Category: { type: "rich_text" } })],
    ["Config Item as rich_text", props({ "Config Item": { type: "rich_text" } })],
    ["unreadable schema", undefined],
  ];
  for (const [label, schema] of cases) {
    const sw = buildSetupWorld("B5_OUTREACH", 5);
    if (schema === undefined) sw.w.map.delete(`data_source:${a.ds}`);
    else sw.w.map.set(`data_source:${a.ds}`, schema);
    const read = await readAt(sw, "B5_OUTREACH");
    assert.deepEqual(answersStatus(read), ["ABSENT", "ABSENT"], label);
    assert.deepEqual(read.reader.on(a.ds).filter((x) => x.op === "query"), [], label + ": no data query");
    assert.deepEqual([read.source("SETUP_POSITION").status, read.source("SETUP_PENDING_INPUT").status], ["PRESENT", "PRESENT"], label);
  }
});

test("PT-CP-012/h: two rows for one key, counted before any other predicate, make both sections ABSENT — no partial answer", async () => {
  const a = BC("rep-a");
  for (const rival of ["DRAFT", "CONFIRMED"]) {
    const sw = buildSetupWorld("B5_OUTREACH", 5);
    sw.setRows([...rowsThrough(5), answerRow(a.ds, stepOf("B2_ICP"), { id: synthetic("pt-cp-012-duplicate-" + rival), state: rival, value: "SENTINEL-B2 rival" })]);
    const read = await readAt(sw, "B5_OUTREACH");
    assert.deepEqual(answersStatus(read), ["ABSENT", "ABSENT"], rival);
    assert.deepEqual([read.source("SETUP_RULES").rows, read.source("SETUP_ANSWERS").rows], [[], []], rival);
  }
});

test("PT-CP-012/i: a failed read makes both sections ABSENT without changing the resume code or the completeness", async () => {
  const unit = await readAt(buildSetupWorld("B5_OUTREACH", 5), "B5_OUTREACH", { failing: ["B3_DATA:CANONICAL_SOURCE"] });
  assert.deepEqual(answersStatus(unit), ["ABSENT", "ABSENT"]);

  const sw = buildSetupWorld("B5_OUTREACH", 5);
  const bound = await bindSales(sw);
  await proveRows(sw, bound, rowsThrough(5));
  const clean = await resume(sw, bound.handle, "SALES_SETUP_INPUTS");
  sw.client.failing.add("B3_DATA:CANONICAL_SOURCE");
  const failed = await resume(sw, bound.handle, "SALES_SETUP_INPUTS");
  assert.equal(failed.status, clean.status);
  assert.equal(failed.code, clean.code);
  const p = packOf(failed);
  assert.deepEqual([p.completeness, p.completeness_reason], [packOf(clean).completeness, packOf(clean).completeness_reason]);
  assert.deepEqual(statuses(p.selected_context), [["SETUP_POSITION", "PRESENT"], ["SETUP_PENDING_INPUT", "PRESENT"], ["SETUP_RULES", "ABSENT"], ["SETUP_ANSWERS", "ABSENT"]]);
  assert.equal(JSON.stringify(p).includes("SENTINEL"), false, "nothing partial is served");
  assert.equal(JSON.stringify(p).includes("keyed query unavailable"), false, "the failure is not echoed into the pack");
});

test("PT-CP-012/j: every published predicate is evaluated after trim(); served values stay untrimmed; a non-conforming key yields nothing", async () => {
  const a = BC("rep-a");
  const sw = buildSetupWorld("B5_OUTREACH", 5);
  sw.setRows([
    answerRow(a.ds, stepOf("B0_DISCOVERY"), { state: " CONFIRMED ", version: "SALES_INPUT/1 ", value: ["  SENTINEL-B0 ", "second run  "] }),
    answerRow(a.ds, stepOf("B1_OFFER"), { state: "DRAFT" }),
    answerRow(a.ds, stepOf("B2_ICP"), { value: "   " }),
    answerRow(a.ds, stepOf("B3_DATA"), { category: "GOAL" }),
    answerRow(a.ds, stepOf("B4_QUALIFICATION"), { category: null }),
  ]);
  const read = await readAt(sw, "B5_OUTREACH");
  assert.deepEqual(answersStatus(read), ["PRESENT", "PRESENT"]);
  assert.deepEqual(read.source("SETUP_RULES").rows, [], "a constraint whose read category does not match is not served, anywhere");
  assert.deepEqual(read.source("SETUP_ANSWERS").rows, [{ ...itemOf(stepOf("B0_DISCOVERY"), "  SENTINEL-B0 second run  "), state: " CONFIRMED ", version: "SALES_INPUT/1 " }]);

  // A category is taken from the published predicate, and the read row must match it: B3 read as CONSTRAINT is not a rule.
  sw.setRows([...rowsThrough(3), answerRow(a.ds, stepOf("B3_DATA"), { category: "CONSTRAINT" }), answerRow(a.ds, stepOf("B4_QUALIFICATION"), { source: "AGENT_GUESS" })]);
  const second = await readAt(sw, "B5_OUTREACH");
  assert.deepEqual(second.source("SETUP_RULES").rows, []);
  assert.deepEqual(second.source("SETUP_ANSWERS").rows, ["B0_DISCOVERY", "B1_OFFER", "B2_ICP"].map((g) => itemOf(stepOf(g))));

  // No conforming row at all: PRESENT and empty, not ABSENT.
  sw.setRows([]);
  const none = await readAt(sw, "B5_OUTREACH");
  assert.deepEqual(answersStatus(none), ["PRESENT", "PRESENT"]);
  assert.deepEqual([none.source("SETUP_RULES").rows, none.source("SETUP_ANSWERS").rows], [[], []]);
});

test("PT-CP-012/k: unknown, READY, HOLD or non-OPEN gates and malformed contracts make both sections ABSENT before any read", async () => {
  const sw = buildSetupWorld("B5_OUTREACH", 5);
  const runtime = await runtimeOf(sw);
  const line = fullSetupLine();
  const transitions = line.cursorTransitions ?? [];
  const at = (gate: string) => transitions.find((t) => t.fromGate === gate)!;
  const b0 = at("B0_DISCOVERY");
  const { Category: _dropped, ...noCategory } = b0.evidence.equals;
  void _dropped;
  const replace = (gate: string, t: DerivedCursorTransition) => transitions.map((x) => (x.fromGate === gate ? t : x));
  const { gateSequence: _sequence, ...unsequenced } = runtime.adapter.controlPlane;
  void _sequence;
  const noSequence: ResolvedRuntime = { ...runtime, adapter: { ...runtime.adapter, controlPlane: unsequenced } };
  const cases: ReadonlyArray<readonly [string, string, ResolvedRuntime, string?]> = [
    ["READY is terminal", "READY", runtime],
    ["HOLD is not a step", "HOLD", runtime],
    ["unknown gate", "B9_UNKNOWN", runtime],
    ["gate not OPEN", "B5_OUTREACH", runtime, "BLOCKED"],
    ["no gateSequence", "B5_OUTREACH", noSequence],
    ["no published Category", "B5_OUTREACH", withControlPlane(runtime, { cursorTransitions: replace("B0_DISCOVERY", { ...b0, evidence: { ...b0.evidence, equals: noCategory } }) })],
    ["shared natural key", "B5_OUTREACH", withControlPlane(runtime, { cursorTransitions: replace("B1_OFFER", { ...at("B1_OFFER"), evidence: { ...at("B1_OFFER").evidence, naturalKey: b0.evidence.naturalKey } }) })],
    ["predicate column outside the six", "B5_OUTREACH", withControlPlane(runtime, { cursorTransitions: replace("B0_DISCOVERY", { ...b0, evidence: { ...b0.evidence, nonEmpty: ["Value", "Notes"] } }) })],
    ["objective-package scope", "B5_OUTREACH", withControlPlane(runtime, { resources: { ...line.resources, [CONFIG]: { ...line.resources![CONFIG]!, scope: "OBJECTIVE_PACKAGE" } } })],
  ];
  for (const [label, gate, rt, status] of cases) {
    const read = await readAt(sw, gate, { runtime: rt, ...(status ? { status } : {}) });
    assert.deepEqual(answersStatus(read), ["ABSENT", "ABSENT"], label);
    assert.deepEqual(read.reader.reads, [], label + ": decided without reading anything");
    assert.equal(read.source("SETUP_POSITION").status, "PRESENT", label);
  }
});

// ─────────────────────────────── lanes, outer HOLD, bounds, identity ───────────────────────────────

test("PT-CP-012/l: META gets four ABSENT sections and no SALES read; a cross-lane request is rejected; an outer HOLD serves ABSENT", async () => {
  const a = BC("rep-a");
  // Reader level: not selected ⇒ nothing; META ⇒ four ABSENT, zero reads.
  const sw = buildSetupWorld("B5_OUTREACH", 5);
  const notSelected = await readAt(sw, "B5_OUTREACH", { needs: ["CURRENT_WORK"] });
  assert.deepEqual([notSelected.sources, notSelected.reader.reads], [[], []]);
  const meta = await readAt(sw, "B5_OUTREACH", { lane: "META", needs: ["META_SETUP_INPUTS"] });
  assert.deepEqual(meta.sources.map((s) => [s.source_key, s.status, s.rows.length]), SETUP_KEYS.map((k) => [k, "ABSENT", 0]));
  assert.deepEqual(meta.reader.reads, []);

  // Transport: META_SETUP_INPUTS keeps its pointer; its SETUP is ABSENT and no SALES data is touched.
  sw.w.setMetaRegistry([registryRow({ key: "META_SALES_RUNTIME_INPUTS", status: "RESOLVED", scope: "PRIVATE_META", schemaVersion: "TEST_INPUTS/1", lastVerified: "2030-01-02T00:00:00.000Z" })]);
  const hm = await bindMeta(sw);
  sw.client.reset();
  const metaResume = await resume(sw, hm, "META_SETUP_INPUTS");
  assert.equal(metaResume.code, "RESUMED", evidenceOf(metaResume));
  const mp = packOf(metaResume);
  assert.deepEqual(mp.selected_pointers.map((p) => p.resource_key), [RESOURCE_KEYS.META_SALES_RUNTIME_INPUTS]);
  assert.deepEqual(statuses(mp.selected_context), ALL_ABSENT);
  assert.equal(JSON.stringify(mp).includes("SALES:"), false, "no SALES value or key crosses into META");
  for (const id of [a.parent, a.db, a.ds]) assert.deepEqual(sw.client.on(id), [], "a META resume reads no SALES Business Configuration");

  // Cross-lane: META asking for the SALES need is rejected inside the pack; the safety spine is unchanged.
  const clean = await resume(sw, hm);
  const crossed = await resume(sw, hm, "SALES_SETUP_INPUTS");
  assert.equal(safetyView(crossed), safetyView(clean));
  const cp = packOf(crossed);
  assert.deepEqual([cp.completeness, cp.completeness_reason, cp.normalized_needs], ["HOLD", "cross_lane_rejected", ["CURRENT_WORK"]]);
  assert.deepEqual(kinds(cp), ["DAILY"]);
  assert.deepEqual(cp.allowed_needs_for_lane, ["CURRENT_WORK", "META_SETUP_INPUTS"]);

  // Outer HOLD: the pack stays diagnostic, its SETUP sections ABSENT; the HOLD itself is unchanged by the hint.
  const held = buildSetupWorld("B5_OUTREACH", 5);
  const bound = await bindSales(held);
  await proveRows(held, bound, rowsThrough(5));
  held.setGate("B5_OUTREACH", { recovery: true });
  const noHint = await resume(held, bound.handle);
  const withHint = await resume(held, bound.handle, "SALES_SETUP_INPUTS");
  assert.equal(withHint.status, "HOLD");
  assert.equal(withHint.code, noHint.code);
  assert.equal(withHint.code, "HOLD_RECOVERY_REQUIRED");
  assert.equal(safetyView(withHint), safetyView(noHint));
  assert.deepEqual(statuses(packOf(withHint).selected_context), ALL_ABSENT);
  assert.equal(JSON.stringify(withHint).includes("SENTINEL"), false);
});

/** A hand-made walk of `n` steps (the first `constraints` of them CONSTRAINT), to exceed S4–S6 on purpose. */
function longWalk(n: number, constraints: number): { readonly over: Partial<ControlPlaneGrammar>; readonly steps: readonly Step[]; readonly gate: string } {
  const base = (fullSetupLine().cursorTransitions ?? [])[0]!;
  const gates = Array.from({ length: n + 1 }, (_, i) => "S" + String(i).padStart(2, "0"));
  const steps = gates.slice(0, n).map((g, i): Step => ({ gate: g, key: g + ":ANSWER", category: i < constraints ? "CONSTRAINT" : "GOAL", value: "" }));
  const cursorTransitions = steps.map((s): DerivedCursorTransition => ({ ...base, key: s.gate + "->next", fromGate: s.gate, evidence: { ...base.evidence, naturalKey: s.key, equals: { ...base.evidence.equals, Category: s.category } } }));
  return { over: { gateSequence: { gates, terminal: "READY" }, cursorTransitions }, steps, gate: gates[n]! };
}

test("PT-CP-012/m: out of bounds, truncation follows the fixed section order and is announced per S4–S6", async () => {
  const a = BC("rep-a");
  const walk = longWalk(15, 2);
  const sw = buildSetupWorld("B5_OUTREACH");
  const runtime = withControlPlane(await runtimeOf(sw), walk.over);
  const packWith = (sources: readonly ContextSource[]) => packFor("SALES", "SALES_SETUP_INPUTS", { context_sources: sources }).selected_context;

  // Byte bound: two small rules, then thirteen 2 KB answers. The rules are served whole; the answers are a prefix.
  const big = (s: Step, i: number) => ({ ...s, value: `V${i} ` + "x".repeat(2000) });
  const bigSteps = walk.steps.map((s, i) => (s.category === "CONSTRAINT" ? { ...s, value: "rule " + i } : big(s, i)));
  sw.setRows(bigSteps.map((s) => answerRow(a.ds, s)));
  const bytes = packWith((await readAt(sw, walk.gate, { runtime })).sources);
  assert.deepEqual(setupOf(bytes).map((s) => s.section_key), [...SETUP_KEYS], "fixed section order");
  const rules = sectionOf(bytes, "SETUP_RULES");
  assert.deepEqual([rules.served, rules.available, rules.truncated_by], [2, 2, "NONE"]);
  const answers = sectionOf(bytes, "SETUP_ANSWERS");
  assert.equal(answers.available, 13);
  assert.equal(answers.truncated_by, "SERIALIZED_BYTES");
  assert.ok(answers.served > 0 && answers.served < CONTEXT_BOUNDS.max_rows_per_section, "bounded, not empty: " + answers.served);
  assert.equal(answers.omitted, 13 - answers.served);
  assert.deepEqual(answers.items, bigSteps.slice(2, 2 + answers.served).map((s) => itemOf(s)), "a prefix, in contract order");
  assert.equal(bytes.bounds.truncated, true);
  assert.equal(bytes.bounds.serialized_bytes, measure(bytes));
  assert.ok(measure(bytes) <= CONTEXT_BOUNDS.max_serialized_bytes);

  // Row bound: thirteen small answers. Ten are served, three are announced, none is a cursor.
  const smallSteps = walk.steps.map((s, i) => ({ ...s, value: "v" + i }));
  sw.setRows(smallSteps.map((s) => answerRow(a.ds, s)));
  const rows = sectionOf(packWith((await readAt(sw, walk.gate, { runtime })).sources), "SETUP_ANSWERS");
  assert.deepEqual([rows.served, rows.available, rows.omitted, rows.truncated_by], [10, 13, 3, "ROWS_PER_SECTION"]);
  assert.deepEqual(rows.items, smallSteps.slice(2, 12).map((s) => itemOf(s)));
});

test("PT-CP-012/n (S8): the SETUP catalogue moves pack_id; the same state and needs keep one identity and one content", async () => {
  const w21: ContextPolicy = { ...CONTEXT_POLICY, sections: { SETUP: [], DAILY: [], EXTERNAL_ACTION: [] } };
  const twin: ContextPolicy = { ...CONTEXT_POLICY, sections: { SETUP: [...CONTEXT_SECTIONS.SETUP], DAILY: [...CONTEXT_SECTIONS.DAILY], EXTERNAL_ACTION: [...CONTEXT_SECTIONS.EXTERNAL_ACTION] } };
  const id = (policy?: ContextPolicy) => packFor("SALES", "SALES_SETUP_INPUTS", policy ? { context_policy: policy } : {});
  assert.notEqual(id().pack_id, id(w21).pack_id, "declaring the SETUP sections changes the identity");
  assert.equal(id().pack_id, id(twin).pack_id, "an equal policy keeps it");
  assert.equal(id().state_fingerprint, id(w21).state_fingerprint, "state_fingerprint covers derived state, not the policy");
  assert.notEqual(id().pack_id, packFor("SALES", "CURRENT_WORK").pack_id, "the need is part of the identity");

  const first = await resumedAt("B5_OUTREACH");
  const second = await resumedAt("B5_OUTREACH");
  assert.equal(packOf(first.r).pack_id, packOf(second.r).pack_id, "deterministic pack_id");
  assert.equal(canonicalize(packOf(first.r).selected_context), canonicalize(packOf(second.r).selected_context), "deterministic content");
  const cw = await resumedAt("B5_OUTREACH", "CURRENT_WORK");
  assert.equal(packOf(cw.r).state_fingerprint, packOf(first.r).state_fingerprint);
  assert.notEqual(packOf(cw.r).pack_id, packOf(first.r).pack_id);
  assert.deepEqual(kinds(packOf(cw.r)), ["DAILY"], "the default stays DAILY");
  assert.equal(JSON.stringify(packOf(cw.r)).includes("SENTINEL"), false, "no SETUP content without the need");
});
