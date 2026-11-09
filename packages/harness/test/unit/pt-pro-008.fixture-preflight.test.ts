/**
 * PT-PRO-008 (PV0-020E) — PT-PRO-001 FIXTURE CONTRACT v2 preflight.
 *
 * What the governing Notion page requires (read verbatim before writing this file):
 *   "Logical resource: META:INPUTS (META lane only; SALES bindings receive HOLD_CROSS_LANE)";
 *   "Record selector / natural key: Input Key = F1:PRIMARY_OFFER for gate F1";
 *   "intent: META:INPUTS, UPSERT, natural key F1:PRIMARY_OFFER, desired changes { Input, Gate Key = F1,
 *    Question = the question asked, Answer = exact answer }"; "User answer of the form `TEST FIXTURE — …`";
 *   "Writable semantic field: Answer = the EXACT submitted user answer string"; "Protected: Input Key, Source".
 * The contract governs ONE runtime, named in its callout. Scope therefore comes from the binding's lane and the
 * resolved runtime id, never from a marker inside an identifier.
 *
 * What these tests prove: the complete intent is validated at step 0 of the os_prepare preflight; a refused intent
 * leaves plan, lease, events and Notion untouched; every clause has its own negative; the exact intent passes and is
 * byte-preserved; a rebind is taken over; and the contract is inert on any other runtime, on LIVE and on SALES.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch, resolveRuntimeFor } from "../../src/tools/handlers.ts";
import { hashHandle } from "../../src/binding/handle.ts";
import { createPlan, leaseKeyOf } from "../../src/plans/service.ts";
import { FIXTURE_ANSWER_PREFIX, FIXTURE_RUNTIME_ID, governsFixture, validateFixturePrepareIntent } from "../../src/fixture/preflight.ts";
import type { Intent } from "../../src/plans/prepare.ts";
import type { NotionReadClient } from "../../src/notion/readClient.ts";
import type { Plan } from "../../src/plans/store.ts";
import type { HarnessDeps } from "../../src/tools/handlers.ts";
import { handleOf, OWNER, T0 } from "./binding-fixtures.ts";
import { buildResumeWorld, type ResumeWorld } from "./resume-fixtures.ts";
import { draftFor } from "./plan-fixtures.ts";

const ctx = { principal_id: OWNER.principal_id, now: T0 };
const QUESTION = "Quelle est l'offre principale que vous vendez, en une phrase ?";
const ANSWER = `${FIXTURE_ANSWER_PREFIX}J'aide les PME B2B à obtenir des rendez-vous qualifiés.`;
const EXACT: Intent = {
  action_class: "COMMIT",
  summary: "persist F1 answer",
  mutations: [{ logical_resource_key: "META:INPUTS", operation: "UPSERT", record_selector: { natural_key: "F1:PRIMARY_OFFER" }, desired_changes: { Input: "F1 — Offre principale", "Gate Key": "F1", Question: QUESTION, Answer: ANSWER } }],
};
const BINDING = { lane: "META" as const };
const RUNTIME = { runtime_id: FIXTURE_RUNTIME_ID };
/** The exact intent with one clause altered. */
const withMutation = (patch: Record<string, unknown>): Intent => ({ ...EXACT, mutations: [{ ...EXACT.mutations[0]!, ...patch } as Intent["mutations"][number]] });
const withChanges = (changes: Record<string, unknown>): Intent => withMutation({ desired_changes: changes });
const CHANGES = EXACT.mutations[0]!.desired_changes as Record<string, unknown>;

/** A test world whose resolved runtime is the one the contract governs. */
function fixtureWorld(): ResumeWorld {
  const w = buildResumeWorld();
  w.rotateMeta({ runtimeId: FIXTURE_RUNTIME_ID });
  w.setMetaManifest({ runtimeId: FIXTURE_RUNTIME_ID });
  return w;
}
const bind = async (w: ResumeWorld, at = ctx) => handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, at, w.deps));
const bindingOf = async (w: ResumeWorld, h: string) => (await w.deps.store.bindings.findByHandleHash(hashHandle(h)))!;
async function countReads(w: ResumeWorld, run: (deps: HarnessDeps) => Promise<unknown>): Promise<number> {
  let reads = 0;
  const counting = new Proxy(w.deps.notion as unknown as Record<string, unknown>, {
    get(t, p, r) { const v = Reflect.get(t, p, r); return typeof v === "function" ? (...a: unknown[]) => { reads += 1; return (v as (...x: unknown[]) => unknown).apply(t, a); } : v; },
  }) as unknown as NotionReadClient;
  await run({ ...w.deps, notion: counting });
  return reads;
}
/** Asserts one clause: the violation is reported, and the refusal is proven to have created nothing. */
function clause(name: string, intent: Intent, fragment: RegExp): void {
  const violations = validateFixturePrepareIntent(BINDING, RUNTIME, intent);
  assert.ok(violations, `${name}: expected a violation`);
  assert.ok(violations.some((x) => fragment.test(x)), `${name}: ${JSON.stringify(violations)}`);
  assert.ok(violations.some((x) => x.includes("no plan and no lease were created")), `${name}: missing proof line`);
}

test("PT-PRO-008/a: the complete intent is validated at step 0 — plan and lease byte-identical, no expire/supersede, no BUSY/recovery, no extra Notion read", async () => {
  const w = fixtureWorld();
  const h = await bind(w);
  const binding = await bindingOf(w, h);
  assert.equal(binding.runtime_id, FIXTURE_RUNTIME_ID, "the world resolves to the runtime the contract governs");
  const created = await createPlan(w.deps.store, w.deps.config, draftFor(binding), T0);
  const plan = (created as { plan: Plan }).plan;
  const leaseBefore = (await w.deps.store.leases.current(leaseKeyOf(binding), T0))!;
  const eventsBefore = (await w.deps.store.events.list({})).length;
  // The plan's TTL has elapsed: a check placed after step 1 would sweep it to EXPIRED and release the lease.
  const later = { principal_id: OWNER.principal_id, now: new Date(T0.getTime() + 3600_000) };
  const refused = await dispatch("os_prepare", { binding_handle: h, intent: withChanges({ ...CHANGES, "Gate Key": "F9" }) }, later, w.deps);

  assert.equal(refused.code, "HOLD_FIXTURE_CONTRACT_VIOLATION", JSON.stringify(refused));
  assert.notEqual(refused.code, "HOLD_RUNTIME_BUSY");
  assert.notEqual(refused.code, "HOLD_RECOVERY_REQUIRED");
  assert.ok(refused.evidence.some((e) => e.includes("no plan and no lease were created")), JSON.stringify(refused.evidence));
  assert.equal((await w.deps.store.plans.get(plan.plan_id))!.plan_state, "AWAITING_STAGE1_WRITES", "not EXPIRED, not SUPERSEDED");
  const leaseAfter = (await w.deps.store.leases.current(leaseKeyOf(binding), T0))!;
  assert.deepEqual({ p: leaseAfter.plan_id, e: leaseAfter.expires_at.toISOString() }, { p: leaseBefore.plan_id, e: leaseBefore.expires_at.toISOString() }, "lease row unchanged");
  assert.equal((await w.deps.store.events.list({})).length, eventsBefore, "no PLAN_EXPIRED, no LEASE_RELEASED, no PLAN_CREATED");

  const w2 = fixtureWorld();
  const h2 = await bind(w2);
  const baseline = await countReads(w2, async (deps) => resolveRuntimeFor(deps, OWNER, "VERTIGO", "META"));
  const onRefusal = await countReads(w2, async (deps) => dispatch("os_prepare", { binding_handle: h2, intent: withChanges({ ...CHANGES, "Gate Key": "F9" }) }, ctx, deps));
  assert.equal(onRefusal, baseline, `refusal reads ${onRefusal}, mandatory runtime resolution reads ${baseline}`);
  assert.ok((await countReads(w2, async (deps) => dispatch("os_prepare", { binding_handle: h2, intent: EXACT }, ctx, deps))) > baseline, "a permitted intent does read Notion");
});

test("PT-PRO-008/b1: action_class and summary are NOT constrained — Notion fixes the intent's shape, never their values", () => {
  // 03 — SIX TOOL CONTRACTS fixes "intent {action_class, summary, mutations[]}"; no governing page fixes a value.
  // The literals of SKILL.md are a repo convention and must not become a backend refusal (PV0-020E authority audit).
  assert.equal(validateFixturePrepareIntent(BINDING, RUNTIME, { ...EXACT, action_class: "DISCUSS" }), undefined);
  assert.equal(validateFixturePrepareIntent(BINDING, RUNTIME, { ...EXACT, summary: "n'importe quel résumé" }), undefined);
  assert.equal(validateFixturePrepareIntent(BINDING, RUNTIME, { ...EXACT, action_class: "X", summary: "Y" }), undefined);
  // What the page does fix is still refused, so the relaxation is scoped to these two fields only.
  assert.ok(validateFixturePrepareIntent(BINDING, RUNTIME, { ...EXACT, action_class: "X", summary: "Y", mutations: [{ ...EXACT.mutations[0]!, operation: "CREATE" } as Intent["mutations"][number]] }));
});
test("PT-PRO-008/b3: exactly one mutation", () => {
  clause("two mutations", { ...EXACT, mutations: [EXACT.mutations[0]!, EXACT.mutations[0]!] }, /exactly one mutation; this intent carries 2/);
  clause("zero mutations", { ...EXACT, mutations: [] }, /exactly one mutation; this intent carries 0/);
});
test("PT-PRO-008/b4: logical_resource_key must be META:INPUTS", () => clause("resource", withMutation({ logical_resource_key: "META:GATES" }), /logical_resource_key .* is not "META:INPUTS"/));
test("PT-PRO-008/b5: operation must be UPSERT", () => {
  for (const operation of ["CREATE", "UPDATE"]) clause(operation, withMutation({ operation }), /operation .* is not "UPSERT"/);
});
test("PT-PRO-008/b6: record_selector names natural_key only, equal to the governed key", () => {
  clause("wrong key", withMutation({ record_selector: { natural_key: "F1 — Offre principale" } }), /natural_key .* is not "F1:PRIMARY_OFFER"/);
  clause("extra selector", withMutation({ record_selector: { natural_key: "F1:PRIMARY_OFFER", existing_object_id: "abc" } }), /record_selector must name natural_key and nothing else/);
  clause("logical_record_key", withMutation({ record_selector: { logical_record_key: "F1:PRIMARY_OFFER" } }), /record_selector must name natural_key and nothing else/);
});
test("PT-PRO-008/b7: desired_changes must carry the four contract fields", () => {
  for (const f of ["Input", "Gate Key", "Question", "Answer"]) {
    const { [f]: _dropped, ...rest } = CHANGES; void _dropped;
    clause(`missing ${f}`, withChanges(rest), new RegExp(`missing "${f}"`));
  }
});
test("PT-PRO-008/b8: no extra field — Input Key and Source are protected, anything else is refused", () => {
  for (const f of ["Input Key", "Source", "State", "Run Ref"]) clause(f, withChanges({ ...CHANGES, [f]: "x" }), new RegExp(`does not allow: "${f}"`));
});
test("PT-PRO-008/b9: Input must be a non-empty string", () => {
  clause("empty Input", withChanges({ ...CHANGES, Input: "   " }), /Input must be a non-empty string/);
  clause("non-string Input", withChanges({ ...CHANGES, Input: 42 }), /Input must be a non-empty string/);
});
test("PT-PRO-008/b10: Gate Key must be F1", () => clause("gate", withChanges({ ...CHANGES, "Gate Key": "F2" }), /Gate Key .* is not "F1"/));
test("PT-PRO-008/b11: Question must be the question the fixture gate asks", () => {
  clause("other question", withChanges({ ...CHANGES, Question: "q ?" }), /is not the question the fixture gate asks/);
  clause("trimmed question", withChanges({ ...CHANGES, Question: `${QUESTION} ` }), /is not the question the fixture gate asks/);
});
test("PT-PRO-008/b12: Answer must be a string beginning exactly with the contract prefix", () => {
  clause("no prefix", withChanges({ ...CHANGES, Answer: "J'aide les PME." }), /Answer must start with "TEST FIXTURE — "/);
  clause("lowercase prefix", withChanges({ ...CHANGES, Answer: "test fixture — x" }), /Answer must start with/);
  clause("prefix only", withChanges({ ...CHANGES, Answer: FIXTURE_ANSWER_PREFIX }), /Answer carries no text after the prefix/);
  clause("non-string", withChanges({ ...CHANGES, Answer: 1 }), /Answer must be a string/);
});

test("PT-PRO-008/c: the exact intent passes, the Answer is preserved byte for byte, and a rebind is taken over", async () => {
  assert.equal(validateFixturePrepareIntent(BINDING, RUNTIME, EXACT), undefined, "the permitted intent raises nothing");
  const w = fixtureWorld();
  const hA = await bind(w);
  const first = await dispatch("os_prepare", { binding_handle: hA, intent: EXACT }, ctx, w.deps);
  assert.equal(first.code, "PLAN_PREPARED", JSON.stringify(first));
  const planA = (first as { result: Record<string, unknown> }).result["plan_id"] as string;
  const op = (await w.deps.store.plans.get(planA))!.operations[0]!;
  assert.equal(op.expected_values["Answer"], ANSWER, "byte for byte, prefix included, never trimmed");
  assert.equal(op.natural_key, "F1:PRIMARY_OFFER");
  assert.equal(op.expected_values["State"], "SUBMITTED", "create defaults stay backend-applied");
  assert.equal(op.expected_values["Source"], "USER_CONFIRMED_FIXTURE");
  // Idempotent rebind: same intent from a new binding supersedes, never duplicates.
  const later = { principal_id: OWNER.principal_id, now: new Date(T0.getTime() + 60_000) };
  const second = await dispatch("os_prepare", { binding_handle: await bind(w, later), intent: EXACT }, later, w.deps);
  assert.equal(second.code, "PLAN_PREPARED", JSON.stringify(second));
  assert.equal((await w.deps.store.plans.get(planA))!.plan_state, "SUPERSEDED");
  const gen = (second.binding as { runtime_generation: string }).runtime_generation;
  assert.equal((await w.deps.store.plans.findActive("VERTIGO", "META", gen)).length, 1, "one active plan");
});

test("PT-PRO-008/d: inert on any other runtime, on LIVE and on SALES — scope never comes from a marker in the id", async () => {
  const bad = withChanges({ ...CHANGES, "Gate Key": "F9" });
  // Another runtime whose id carries a TEST marker: the old scope heuristic caught it, the contract does not.
  assert.equal(governsFixture({ lane: "META" }, { runtime_id: "RT-TEST-01" }), false);
  assert.equal(validateFixturePrepareIntent({ lane: "META" }, { runtime_id: "RT-TEST-01" }, bad), undefined);
  assert.equal(validateFixturePrepareIntent({ lane: "META" }, { runtime_id: `${FIXTURE_RUNTIME_ID}-B` }, bad), undefined);
  // A live runtime and the SALES lane are untouched, even on the very runtime the contract names.
  assert.equal(validateFixturePrepareIntent({ lane: "META" }, { runtime_id: "META-OPERATIONAL-RUNTIME" }, bad), undefined);
  assert.equal(validateFixturePrepareIntent({ lane: "SALES" }, RUNTIME, bad), undefined, "SALES is out of scope; cross-lane is refused elsewhere");
  assert.equal(governsFixture({ lane: "SALES" }, RUNTIME), false);
  // Through the real dispatcher on a non-contract runtime: no fixture violation is raised.
  const w = buildResumeWorld();
  const h = await bind(w);
  const p = await dispatch("os_prepare", { binding_handle: h, intent: bad }, ctx, w.deps);
  assert.notEqual(p.code, "HOLD_FIXTURE_CONTRACT_VIOLATION", `a non-contract runtime is never judged by the fixture contract: ${p.code}`);
});
