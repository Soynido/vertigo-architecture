import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildContractPack, canonicalize, contextPolicyDigest, ContextPolicyViolation, packTelemetry, projectSelectedContext,
  type ContextSection, type ContextSource, type ContractPack, type PackInput, type SelectedContext,
} from "../../src/contractPack/pack.ts";
import {
  CANDIDATE_POLICY_VERSION, CONTEXT_BOUNDS, CONTEXT_KINDS, CONTEXT_POLICY, CONTEXT_POLICY_VERSION,
  CONTEXT_SECTIONS, NEED_CONTEXT, POLICY_VERSION, type ContextPolicy, type ContextSectionSpec,
} from "../../src/contractPack/catalog.ts";

const VERSIONS = { governing_spec: "S", governing_schema: "H", governing_control: "C", candidate_versions: [] } as const;
const base = (lane: "META" | "SALES"): PackInput => ({ lane, runtime_generation: "g1", versions: VERSIONS, safety: {}, open_backend_plan: "NONE" });
const packFor = (lane: "META" | "SALES", topic_hint?: string, extra: Partial<PackInput> = {}): ContractPack =>
  buildContractPack({ ...base(lane), ...(topic_hint === undefined ? {} : { topic_hint }), ...extra }).pack;
const kinds = (p: ContractPack) => p.selected_context.contexts.map((c) => c.context);
const measure = (sc: SelectedContext) => Buffer.byteLength(JSON.stringify(sc), "utf8");

/** A probe section: symbolic keys only, five projected keys. It exists in the TEST, never in the catalogue. */
const PROBE: ContextSectionSpec = {
  section_key: "PROBE_SECTION", source_key: "PROBE_SOURCE",
  projected_keys: ["record_key", "state", "label", "count", "flag"],
};
const SECOND: ContextSectionSpec = { section_key: "PROBE_SECTION_B", source_key: "PROBE_SOURCE_B", projected_keys: ["record_key"] };
const NARROWER = { max_rows_per_section: 9, max_serialized_bytes: 16384 };

const policyWith = (sections: Partial<Record<(typeof CONTEXT_KINDS)[number], readonly ContextSectionSpec[]>>, bounds = CONTEXT_BOUNDS, version = CONTEXT_POLICY_VERSION): ContextPolicy => ({
  version, kinds: CONTEXT_KINDS, need_context: NEED_CONTEXT, bounds,
  sections: { SETUP: sections.SETUP ?? [], DAILY: sections.DAILY ?? [], EXTERNAL_ACTION: sections.EXTERNAL_ACTION ?? [] },
});
const rows = (n: number, fill = "x"): readonly unknown[] =>
  Array.from({ length: n }, (_, i) => ({ record_key: "K-" + i, state: "OPEN", label: fill.repeat(fill === "x" ? 1 : 3000), count: i, flag: i % 2 === 0 }));
const source = (source_key: string, r: readonly unknown[]): ContextSource => ({ source_key, status: "PRESENT", rows: r });
const sectionOf = (sc: SelectedContext, key: string): ContextSection => {
  const found = sc.contexts.flatMap((c) => c.sections).find((s) => s.section_key === key);
  assert.ok(found, "section " + key + " must be served");
  return found;
};

test("PT-CP-011/a (S1): selected_context declares CONTRACT_PACK/0.3.2-candidate; the pointer policy is untouched", () => {
  assert.equal(CONTEXT_POLICY_VERSION, "CONTRACT_PACK/0.3.2-candidate");
  const adopted = packFor("META", "CURRENT_WORK");
  assert.equal(adopted.selected_context.policy_version, CONTEXT_POLICY_VERSION);
  assert.equal(adopted.selected_context.policy_role, "CANDIDATE_NOT_ADOPTED");
  // The pack policy, its pointers and its telemetry are what they were: 0.3 adds content and regresses nothing.
  assert.equal(adopted.policy_version, POLICY_VERSION);
  assert.equal(packTelemetry(adopted).policy_version, POLICY_VERSION);
  const gtm = packFor("META", "META_GTM_ANALYSIS", { gtm_capability: true });
  assert.equal(gtm.policy_version, CANDIDATE_POLICY_VERSION, "the GTM pointer candidate stays 0.2");
  assert.equal(gtm.policy_role, "CANDIDATE_NOT_ADOPTED");
  assert.deepEqual(gtm.selected_pointers.length, 2, "its pointers are still served, unchanged");
  assert.equal(gtm.selected_context.policy_version, CONTEXT_POLICY_VERSION);
});

test("PT-CP-011/b (S2, S3, S5): the needs select the context; GTM selects none; the empty shape is stable", () => {
  assert.deepEqual([...CONTEXT_KINDS], ["SETUP", "DAILY", "EXTERNAL_ACTION"]);
  assert.deepEqual(kinds(packFor("META")), ["DAILY"], "no hint means CURRENT_WORK, hence DAILY");
  assert.deepEqual(kinds(packFor("META", "CURRENT_WORK")), ["DAILY"]);
  assert.deepEqual(kinds(packFor("META", "META_SETUP_INPUTS")), ["SETUP"]);
  assert.deepEqual(kinds(packFor("SALES", "SALES_EXTERNAL_ACTION")), ["EXTERNAL_ACTION"]);
  assert.deepEqual(kinds(packFor("SALES", "SALES_EMAIL_RECONCILIATION")), ["EXTERNAL_ACTION"]);
  assert.deepEqual(kinds(packFor("SALES", "SALES_EXTERNAL_ACTION,CURRENT_WORK")), ["DAILY", "EXTERNAL_ACTION"], "catalogue order, not the caller order");
  for (const [lane, hint] of [["META", "META_GTM_ANALYSIS"], ["SALES", "SALES_GTM_CONTEXT"]] as const) {
    const p = packFor(lane, hint, { gtm_capability: true });
    assert.deepEqual(p.selected_context.contexts, [], hint + " must select no context");
    assert.ok(p.selected_pointers.length > 0, "its pointers are still served");
    assert.deepEqual(p.selected_context.bounds, {
      max_rows_per_section: CONTEXT_BOUNDS.max_rows_per_section,
      max_serialized_bytes: CONTEXT_BOUNDS.max_serialized_bytes,
      serialized_bytes: measure(p.selected_context),
      truncated: false,
    });
  }
  assert.equal(
    canonicalize(packFor("META", "META_GTM_ANALYSIS", { gtm_capability: true }).selected_context),
    canonicalize(packFor("SALES", "SALES_GTM_CONTEXT", { gtm_capability: true }).selected_context),
  );
});

test("PT-CP-011/c: the catalogue declares the four W2.2 SETUP sections, the thirteen W2.3 DAILY sections then DAILY_PRODUCTION_HEALTH, and the four W2.4 EXTERNAL_ACTION sections in order", () => {
  const daily = (key: string, projected_keys: readonly string[]) => ({ section_key: key, source_key: key, projected_keys });
  const RULE = ["rule_id", "rule", "trigger", "default_disposition", "required_authority", "required_gate", "stop_conditions", "action_contract"];
  const DAILY = [
    daily("DAILY_NATIVE_REALITY", ["source", "authority", "read_first"]),
    daily("DAILY_HOLDS", ["code", "next_safe_action"]),
    daily("DAILY_BLOCKED_TASKS", ["task_id", "task", "blocker", "due_date", "gate"]),
    daily("DAILY_P0_RULES", RULE),
    daily("DAILY_ACTIVE_POLICIES", ["policy_key", "version", "policy_text", "effective_at"]),
    daily("DAILY_RUNTIME_CONSTRAINTS", ["config", "type", "declared_value", "pointer_resource_key", "pointer_natural_key", "pointer_value_field", "reread_value", "reread_status"]),
    daily("DAILY_RECENT_RECEIPTS", ["receipt_id", "event_type", "event_timestamp", "task_id", "account_id", "contact_id"]),
    daily("DAILY_UNPROCESSED_INTAKE", ["intake_id", "intake", "status", "received_at", "source_type", "human_required", "target"]),
    daily("DAILY_DUE_TASKS", ["task_id", "task", "type", "status", "due_date", "authority", "gate", "expected_outcome", "account_id", "contact_id", "sequence_id"]),
    daily("DAILY_TASK_ACCOUNTS", ["account_id", "company", "lifecycle", "qualification", "do_not_contact", "next_action_date", "open_gaps"]),
    daily("DAILY_TASK_CONTACTS", ["contact_id", "contact", "buyer_role", "lifecycle", "do_not_contact", "email_status"]),
    daily("DAILY_ACTIVE_RULES", [...RULE, "priority"]),
    daily("DAILY_ACTIVE_SEQUENCES", ["sequence_id", "sequence", "audience", "trigger", "stop_conditions", "default_authority", "max_steps"]),
    // W3.4R: the 14th and last DAILY source, after the thirteen W2.3 sources.
    daily("DAILY_PRODUCTION_HEALTH", ["production_health", "daily_run_ref", "evaluated_at"]),
  ];
  assert.equal(DAILY.length, 14);
  const EXTERNAL_ACTION = [
    daily("EXTERNAL_INTENTS", ["action_key", "action_type", "effect_status", "approval_state", "recipient", "thread_context", "prepared_at"]),
    daily("EXTERNAL_PARTIES", ["action_key", "account_id", "company", "account_do_not_contact", "contact_id", "contact", "contact_do_not_contact", "email_status"]),
    daily("EXTERNAL_AUTHORITY", ["action_key", "rule_id", "declared_authority", "allowed_modes", "preconditions", "approval_state", "send_authority", "t0_recheck_required"]),
    daily("EXTERNAL_STOPS", ["action_key", "stop_conditions", "account_do_not_contact", "contact_do_not_contact", "reconciliation_status", "competent_source"]),
  ];
  assert.deepEqual(CONTEXT_SECTIONS, {
    SETUP: [
      { section_key: "SETUP_POSITION", source_key: "SETUP_POSITION", projected_keys: ["gate_key", "gate_status", "next_question", "next_safe_action"] },
      { section_key: "SETUP_PENDING_INPUT", source_key: "SETUP_PENDING_INPUT", projected_keys: ["gate_key", "logical_resource_key", "natural_key", "answer_field"] },
      { section_key: "SETUP_RULES", source_key: "SETUP_RULES", projected_keys: ["step_key", "config_item", "category", "state", "value", "version", "source"] },
      { section_key: "SETUP_ANSWERS", source_key: "SETUP_ANSWERS", projected_keys: ["step_key", "config_item", "category", "state", "value", "version", "source"] },
    ],
    DAILY,
    EXTERNAL_ACTION,
  }, "SETUP holds exactly the four W2.2 sections, DAILY the thirteen W2.3 sections then the W3.4R production health, and EXTERNAL_ACTION the four W2.4 sections, each in the published order");
  const p = packFor("SALES", "CURRENT_WORK,SALES_EXTERNAL_ACTION");
  assert.deepEqual(p.selected_context.contexts.map((c) => [c.context, c.sections.length]), [["DAILY", 14], ["EXTERNAL_ACTION", 4]]);
  assert.equal(p.selected_context.bounds.truncated, false);
  assert.equal(canonicalize(p), canonicalize(packFor("SALES", "CURRENT_WORK,SALES_EXTERNAL_ACTION")));
});

test("PT-CP-011/d (S4): a section serves at most 10 rows and says how many it did not serve", () => {
  const n = CONTEXT_BOUNDS.max_rows_per_section + 2;
  const sc = projectSelectedContext(policyWith({ DAILY: [PROBE] }), ["DAILY"], [source(PROBE.source_key, rows(n))]);
  const s = sectionOf(sc, PROBE.section_key);
  assert.equal(s.served, CONTEXT_BOUNDS.max_rows_per_section);
  assert.equal(s.items.length, CONTEXT_BOUNDS.max_rows_per_section);
  assert.equal(s.available, n);
  assert.equal(s.omitted, 2);
  assert.equal(s.truncated_by, "ROWS_PER_SECTION");
  assert.equal(sc.bounds.truncated, true);
  const small = sectionOf(projectSelectedContext(policyWith({ DAILY: [PROBE] }), ["DAILY"], [source(PROBE.source_key, rows(3))]), PROBE.section_key);
  assert.deepEqual([small.served, small.available, small.omitted, small.truncated_by], [3, 3, 0, "NONE"]);
});

test("PT-CP-011/e (S4): 16 KiB is measured on the complete serialized payload, metadata included, and never exceeded", () => {
  const policy = policyWith({ DAILY: [PROBE, SECOND] });
  const sc = projectSelectedContext(policy, ["DAILY"], [source(PROBE.source_key, rows(10, "y")), source(SECOND.source_key, rows(4))]);
  const real = measure(sc);
  // The number served IS the measured size of the very payload that carries it: no estimate, no slack.
  assert.equal(sc.bounds.serialized_bytes, real);
  assert.ok(real <= CONTEXT_BOUNDS.max_serialized_bytes, real + " bytes served must fit " + CONTEXT_BOUNDS.max_serialized_bytes);
  assert.ok(real > CONTEXT_BOUNDS.max_serialized_bytes - 4096, "the fill is greedy, not timid: " + real + " bytes");
  const first = sectionOf(sc, PROBE.section_key);
  assert.equal(first.truncated_by, "SERIALIZED_BYTES");
  assert.ok(first.served > 0 && first.served < 10, "bounded, not empty: " + first.served);
  // Monotone: the fill stops at the first row that does not fit, so a later section is starved and says so.
  const second = sectionOf(sc, SECOND.section_key);
  assert.deepEqual([second.served, second.available, second.omitted, second.truncated_by], [0, 4, 4, "SERIALIZED_BYTES"]);
  assert.equal(sc.bounds.truncated, true);
});

test("PT-CP-011/f (S6): truncation is explicit and no cursor, token or offset is ever served", () => {
  const sc = projectSelectedContext(policyWith({ DAILY: [PROBE] }), ["DAILY"], [source(PROBE.source_key, rows(12))]);
  const keys = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === "object" && v !== null) for (const [k, inner] of Object.entries(v)) { keys.add(k); walk(inner); }
  };
  walk(sc);
  for (const forbidden of [...keys].filter((k) => /cursor|token|offset|next_|has_more/i.test(k))) {
    assert.fail("selected_context must serve no continuation handle, found " + forbidden);
  }
  assert.ok(keys.has("served") && keys.has("available") && keys.has("omitted") && keys.has("truncated_by") && keys.has("truncated"));
});

test("PT-CP-011/g (S7): only symbolic section_key and source_key leave the harness", () => {
  const SYMBOL = /^[A-Z][A-Z0-9_]*$/;
  const sc = projectSelectedContext(policyWith({ DAILY: [PROBE], SETUP: [SECOND] }), ["SETUP", "DAILY"], [source(PROBE.source_key, rows(2)), source(SECOND.source_key, rows(1))]);
  for (const s of sc.contexts.flatMap((c) => c.sections)) {
    assert.match(s.section_key, SYMBOL, s.section_key);
    assert.match(s.source_key, SYMBOL, s.source_key);
  }
  const served = JSON.stringify(sc);
  for (const leak of ["safety", "external_actions", "meta_inputs", "current_run", "origin"]) {
    assert.equal(served.includes(leak), false, "no internal state path may be served: " + leak);
  }
  for (const kind of CONTEXT_KINDS) {
    for (const spec of CONTEXT_POLICY.sections[kind]) {
      assert.match(spec.section_key, SYMBOL);
      assert.match(spec.source_key, SYMBOL);
    }
  }
});

test("PT-CP-011/h (S8): the content policy version, its catalogue and projection digest and its bounds enter pack_id", () => {
  const d = contextPolicyDigest(CONTEXT_POLICY);
  assert.match(d, /^sha256:[0-9a-f]{64}$/);
  assert.equal(d, contextPolicyDigest(CONTEXT_POLICY), "equal policy, equal digest");
  assert.notEqual(d, contextPolicyDigest(policyWith({}, CONTEXT_BOUNDS, "CONTRACT_PACK/0.2.0-candidate")), "version moves the digest");
  assert.notEqual(d, contextPolicyDigest(policyWith({}, NARROWER)), "a bound moves the digest");
  assert.notEqual(d, contextPolicyDigest(policyWith({ DAILY: [PROBE] })), "a projection moves the digest");
  const identity = (policy: ContextPolicy) => packFor("META", "CURRENT_WORK", { context_policy: policy }).pack_id;
  const canonical = identity(CONTEXT_POLICY);
  assert.equal(canonical, identity(policyWith({ SETUP: CONTEXT_SECTIONS.SETUP, DAILY: [...CONTEXT_SECTIONS.DAILY], EXTERNAL_ACTION: [...CONTEXT_SECTIONS.EXTERNAL_ACTION] })), "the catalogue default and its equal twin share an identity");
  assert.notEqual(canonical, identity(policyWith({}, NARROWER)));
  assert.notEqual(canonical, identity(policyWith({}, CONTEXT_BOUNDS, "CONTRACT_PACK/0.2.0-candidate")));
  assert.notEqual(canonical, identity(policyWith({ DAILY: [PROBE] })));
  // state_fingerprint keeps its own meaning: it covers derived state, not the policy.
  assert.equal(
    packFor("META", "CURRENT_WORK").state_fingerprint,
    packFor("META", "CURRENT_WORK", { context_policy: policyWith({ DAILY: [PROBE] }) }).state_fingerprint,
  );
});

// PT-CP-011/b (E2E-J:E1): ungoverned keys injected DIRECTLY at the projector input, never only on a Notion page.

const UNGOVERNED_KEYS = ["Score CollaboratorGamma", "Notes perso", "Prochaine etape perso"];
const UNGOVERNED_VALUES = [97531, "rappeler apres les vacances", "relance lundi"];
const UNGOVERNED_STATE = "Valide par CollaboratorGamma";

/** The seller row as the harness would hand it over: governed keys intact, an ungoverned value on one of them,
 *  their own ungoverned columns, and a structured value the projector must not restate. */
const sellerRow = (withUngoverned: boolean): Record<string, unknown> => {
  const row: Record<string, unknown> = { record_key: "K-CollaboratorGamma", state: UNGOVERNED_STATE, label: "ACME", count: 3, flag: true };
  if (!withUngoverned) return row;
  UNGOVERNED_KEYS.forEach((k, i) => { row[k] = UNGOVERNED_VALUES[i]; });
  row["Plan perso"] = { step: "call", when: "lundi" };
  row["Tags perso"] = ["vip", "warm"];
  return row;
};

test("PT-CP-011/b (E2E-J:E1): ungoverned keys reach the projector, tolerated, never transported, never interpreted", () => {
  const policy = policyWith({ DAILY: [PROBE] });
  const dirty = projectSelectedContext(policy, ["DAILY"], [source(PROBE.source_key, [sellerRow(true)])]);
  const clean = projectSelectedContext(policy, ["DAILY"], [source(PROBE.source_key, [sellerRow(false)])]);
  // Tolerated without error, and byte-identical to the same row without them: they change nothing the harness serves.
  assert.equal(canonicalize(dirty), canonicalize(clean));
  const s = sectionOf(dirty, PROBE.section_key);
  assert.equal(s.served, 1);
  // Exact equality of the served key set with the projection.
  assert.deepEqual(Object.keys(s.items[0]!).sort(), [...PROBE.projected_keys].sort());
  // Not transported: neither the ungoverned keys nor their values appear anywhere in the payload.
  const served = JSON.stringify(dirty);
  for (const key of [...UNGOVERNED_KEYS, "Plan perso", "Tags perso", "step", "vip"]) {
    assert.equal(served.includes(key), false, "ungoverned key " + key + " must not be carried");
  }
  for (const value of UNGOVERNED_VALUES) assert.equal(served.includes(String(value)), false, "ungoverned value must not be carried");
  // Never interpreted: the fields the harness depends on are intact, and a value outside the governed options on a
  // PROJECTED key is carried verbatim, not corrected, not classified, not refused (D11 governs writing, not reading).
  assert.deepEqual(s.items[0], { record_key: "K-CollaboratorGamma", state: UNGOVERNED_STATE, label: "ACME", count: 3, flag: true });
});

test("PT-CP-011/b2 (E2E-J:E1): the same through the pack, and a projected key without a scalar value is not restated", () => {
  const policy = policyWith({ DAILY: [PROBE] });
  const structured: Record<string, unknown> = { record_key: "K-2", label: "ACME", count: 2, flag: false };
  structured["state"] = { name: "OPEN" };
  const p = packFor("META", "CURRENT_WORK", { context_policy: policy, context_sources: [source(PROBE.source_key, [sellerRow(true), structured])] });
  const s = sectionOf(p.selected_context, PROBE.section_key);
  assert.equal(s.served, 2);
  assert.deepEqual(Object.keys(s.items[0]!).sort(), [...PROBE.projected_keys].sort());
  // A projected key whose value is a structure is dropped, never flattened or summarised: the rest is served as held.
  assert.deepEqual(s.items[1], { record_key: "K-2", label: "ACME", count: 2, flag: false });
  assert.equal(JSON.stringify(p.selected_context).includes("Notes perso"), false);
  // An absent source is stated as absent, never as an empty business reality.
  const missing = sectionOf(projectSelectedContext(policy, ["DAILY"], []), PROBE.section_key);
  assert.deepEqual([missing.source_status, missing.served, missing.available, missing.omitted, missing.truncated_by], ["ABSENT", 0, 0, 0, "NONE"]);
  const declared = sectionOf(projectSelectedContext(policy, ["DAILY"], [{ source_key: PROBE.source_key, status: "ABSENT", rows: [] }]), PROBE.section_key);
  assert.equal(declared.source_status, "ABSENT");
});

// Boundary enforcement: the projector refuses a policy it could not serve within S4, S6 and S7 — fail-closed,
// with a stable code, whether or not this turn selects the offending context.

const specOf = (section_key: string, source_key: string, projected_keys: readonly string[]): ContextSectionSpec => ({ section_key, source_key, projected_keys });
const codeOf = (fn: () => unknown): string => {
  try { fn(); } catch (e) { return e instanceof ContextPolicyViolation ? e.code : "NOT_A_POLICY_VIOLATION:" + String(e); }
  return "NO_THROW";
};

test("PT-CP-011/i (S4 absolute): metadata alone over the byte bound is refused, never served", () => {
  // Sixty sections, each declaring eight 300-character projected keys: the metadata alone dwarfs 16 KiB.
  const fat = Array.from({ length: 60 }, (_, i) => specOf("PROBE_FAT_" + i, "PROBE_SOURCE_" + i, Array.from({ length: 8 }, (_, k) => "A".repeat(300) + "_" + k)));
  const policy = policyWith({ DAILY: fat });
  assert.equal(codeOf(() => projectSelectedContext(policy, ["DAILY"], [])), "CONTEXT_METADATA_EXCEEDS_BYTE_BOUND");
  // The same refusal through the pack: no out-of-bound payload can reach a caller by that route either.
  assert.equal(codeOf(() => packFor("META", "CURRENT_WORK", { context_policy: policy })), "CONTEXT_METADATA_EXCEEDS_BYTE_BOUND");
  // A policy whose metadata does fit is served, and the served payload is within the bound.
  const slim = projectSelectedContext(policyWith({ DAILY: [PROBE] }), ["DAILY"], [source(PROBE.source_key, rows(2))]);
  assert.ok(measure(slim) <= CONTEXT_BOUNDS.max_serialized_bytes);
});

test("PT-CP-011/j (S7 enforced): a path-shaped or non-symbolic key is refused by the projector itself", () => {
  const cases: ReadonlyArray<readonly [ContextSectionSpec, string]> = [
    [specOf("safety.current_run", "PROBE_SOURCE", ["record_key"]), "CONTEXT_SECTION_KEY_PATH_SHAPED"],
    [specOf("PROBE_SECTION", "safety.meta_inputs", ["record_key"]), "CONTEXT_SOURCE_KEY_PATH_SHAPED"],
    [specOf("PROBE_SECTION", "external_actions/unresolved", ["record_key"]), "CONTEXT_SOURCE_KEY_PATH_SHAPED"],
    [specOf("probe_section", "PROBE_SOURCE", ["record_key"]), "CONTEXT_SECTION_KEY_NOT_SYMBOLIC"],
    [specOf("PROBE_SECTION", "Probe Source", ["record_key"]), "CONTEXT_SOURCE_KEY_NOT_SYMBOLIC"],
  ];
  for (const [spec, code] of cases) {
    assert.equal(codeOf(() => projectSelectedContext(policyWith({ DAILY: [spec] }), ["DAILY"], [])), code, spec.section_key + " " + spec.source_key);
    // Declared under a context this turn does NOT select: still refused, because the table is the contract.
    assert.equal(codeOf(() => projectSelectedContext(policyWith({ SETUP: [spec] }), ["DAILY"], [])), code, "unselected context must be checked too");
    assert.equal(codeOf(() => packFor("META", "CURRENT_WORK", { context_policy: policyWith({ EXTERNAL_ACTION: [spec] }) })), code, "the pack route is checked too");
  }
});

test("PT-CP-011/k (S6 boundary): no projection may publish a continuation handle, whatever its case", () => {
  for (const reserved of ["cursor", "token", "offset", "next_cursor", "has_more", "Cursor", "HAS_MORE", "Next_Cursor"]) {
    const spec = specOf("PROBE_SECTION", "PROBE_SOURCE", ["record_key", reserved]);
    assert.equal(codeOf(() => projectSelectedContext(policyWith({ DAILY: [spec] }), ["DAILY"], [])), "CONTEXT_PROJECTED_KEY_RESERVED", reserved);
  }
  // A key that merely mentions one of those words is not a handle and stays admissible.
  const ok = specOf("PROBE_SECTION", "PROBE_SOURCE", ["record_key", "cursor_owner_label"]);
  assert.equal(codeOf(() => projectSelectedContext(policyWith({ DAILY: [ok] }), ["DAILY"], [])), "NO_THROW");
});

test("PT-CP-011/l: a source declared ABSENT serves none of its rows, even when the caller contradicts itself", () => {
  const policy = policyWith({ DAILY: [PROBE] });
  const contradictory: ContextSource = { source_key: PROBE.source_key, status: "ABSENT", rows: [sellerRow(false), sellerRow(true)] };
  const sc = projectSelectedContext(policy, ["DAILY"], [contradictory]);
  const s = sectionOf(sc, PROBE.section_key);
  assert.deepEqual([s.source_status, s.served, s.available, s.omitted, s.truncated_by], ["ABSENT", 0, 0, 0, "NONE"]);
  assert.deepEqual(s.items, []);
  assert.equal(sc.bounds.truncated, false, "an absent source omits nothing: it resolves nothing");
  // Not one value of those rows reaches the payload, by any route.
  const served = JSON.stringify(sc);
  for (const value of ["K-CollaboratorGamma", "ACME", UNGOVERNED_STATE]) assert.equal(served.includes(value), false, "ABSENT must serve nothing: " + value);
  const p = packFor("META", "CURRENT_WORK", { context_policy: policy, context_sources: [contradictory] });
  assert.equal(JSON.stringify(p.selected_context).includes("K-CollaboratorGamma"), false);
});
