/**
 * PT-PRO-001 FIXTURE CONTRACT v2 — prepare-time preflight (PV0-020E).
 *
 * TEMPORARY, CONTRACT-SCOPED MODULE. It encodes ONLY what the governing Notion page "PT-PRO-001 — FIXTURE CONTRACT v2
 * (META:INPUTS)" states verbatim, for ONE controlled test runtime. It is not a general rule of the META lane
 * and it is not a grammar: it recognises exactly the one intent that contract permits, on exactly the one runtime
 * that contract governs, and refuses everything else. DELETE THIS MODULE WHEN THE FIXTURE IS RETIRED.
 *
 * Scope is decided from the authenticated binding and the freshly resolved runtime — never from a marker inside an
 * identifier. Any other runtime, any other lane, is untouched: the function returns undefined.
 *
 * Placement: it runs as step 0 of the os_prepare preflight (05 — TRANSACTION PROTOCOL), BEFORE the active-plan scan,
 * the expiry sweep, the lease check and the rehydration. A refused intent therefore expires nothing, supersedes
 * nothing, touches no lease and reads nothing from Notion beyond the runtime resolution already performed.
 *
 * Pure: no client, no store, no clock, no I/O. It compares strings byte for byte and never trims, normalises or
 * rewrites a submitted value.
 */
import type { BindingRecord } from "../binding/store.ts";
import type { Intent } from "../plans/prepare.ts";
import type { ResolvedRuntime } from "../resolvers/types.ts";

/** The controlled runtime this contract governs, named in the contract page's callout. */
export const FIXTURE_RUNTIME_ID = "META-FIXTURE-PTPRO-20260918-01";
/** The single logical resource the contract allows an intent to address (page: "Logical resource: META:INPUTS"). */
export const FIXTURE_RESOURCE = "META:INPUTS";
/** Page: "Record selector / natural key: Input Key = F1:PRIMARY_OFFER for gate F1". */
export const FIXTURE_NATURAL_KEY = "F1:PRIMARY_OFFER";
/** Page: "desired changes { Input, Gate Key = F1, Question = the question asked, Answer = exact answer }". */
export const FIXTURE_DESIRED_FIELDS = ["Input", "Gate Key", "Question", "Answer"] as const;
export const FIXTURE_GATE_KEY = "F1";
/** The question actually asked by the fixture gate F1 (its Next Question), which the page refers to as "the question asked". */
export const FIXTURE_QUESTION = "Quelle est l'offre principale que vous vendez, en une phrase ?";
/** Page: "User answer of the form `TEST FIXTURE — …`". */
export const FIXTURE_ANSWER_PREFIX = "TEST FIXTURE — ";
const PROOF = "no plan and no lease were created: the intent was refused before the active-plan scan, the expiry sweep, the lease check and any Notion read";

/** True when this contract governs the call at hand. Decided from the binding's lane and the resolved runtime id. */
export function governsFixture(binding: Pick<BindingRecord, "lane">, runtime: Pick<ResolvedRuntime, "runtime_id">): boolean {
  return binding.lane === "META" && runtime.runtime_id === FIXTURE_RUNTIME_ID;
}

/**
 * Validates the COMPLETE intent against the fixture contract. Returns every violation found, or undefined when the
 * contract does not govern this call or when the intent is exactly the one it permits.
 */
export function validateFixturePrepareIntent(binding: Pick<BindingRecord, "lane">, runtime: Pick<ResolvedRuntime, "runtime_id">, intent: Intent): readonly string[] | undefined {
  if (!governsFixture(binding, runtime)) return undefined;
  const v: string[] = [];
  const q = (x: unknown) => JSON.stringify(x);

  // action_class and summary are NOT constrained: Notion fixes the intent's shape (03 — SIX TOOL CONTRACTS:
  // "intent {action_class, summary, mutations[]}") but no governing page fixes their values. The literals
  // "COMMIT" and « persist <gate key> answer » come from SKILL.md, a repo artifact, so the harness does not
  // elevate them to a refusal (PV0-020E authority audit).
  if (intent.mutations.length !== 1) {
    v.push(`the contract permits exactly one mutation; this intent carries ${intent.mutations.length}`);
    return [...v, PROOF];
  }
  const m = intent.mutations[0] as Intent["mutations"][number];
  if (m.logical_resource_key !== FIXTURE_RESOURCE) v.push(`logical_resource_key ${q(m.logical_resource_key)} is not ${q(FIXTURE_RESOURCE)}`);
  if (m.operation !== "UPSERT") v.push(`operation ${q(m.operation)} is not "UPSERT"`);

  const selectorKeys = Object.keys(m.record_selector ?? {}).filter((k) => (m.record_selector as Record<string, unknown>)[k] !== undefined);
  if (selectorKeys.length !== 1 || selectorKeys[0] !== "natural_key") v.push(`record_selector must name natural_key and nothing else; it names ${selectorKeys.length === 0 ? "nothing" : selectorKeys.map(q).join(", ")}`);
  if (m.record_selector?.natural_key !== FIXTURE_NATURAL_KEY) v.push(`record_selector.natural_key ${q(m.record_selector?.natural_key)} is not ${q(FIXTURE_NATURAL_KEY)}`);

  const changes = (m.desired_changes ?? {}) as Record<string, unknown>;
  const present = Object.keys(changes);
  const missing = FIXTURE_DESIRED_FIELDS.filter((f) => !present.includes(f));
  const extra = present.filter((f) => !(FIXTURE_DESIRED_FIELDS as readonly string[]).includes(f));
  if (missing.length > 0) v.push(`desired_changes is missing ${missing.map(q).join(", ")}`);
  if (extra.length > 0) v.push(`desired_changes carries fields the contract does not allow: ${extra.map(q).join(", ")}`);

  const input = changes["Input"];
  if (present.includes("Input") && (typeof input !== "string" || input.trim() === "")) v.push(`Input must be a non-empty string; got ${q(input)}`);
  if (present.includes("Gate Key") && changes["Gate Key"] !== FIXTURE_GATE_KEY) v.push(`Gate Key ${q(changes["Gate Key"])} is not ${q(FIXTURE_GATE_KEY)}`);
  if (present.includes("Question") && changes["Question"] !== FIXTURE_QUESTION) v.push(`Question ${q(changes["Question"])} is not the question the fixture gate asks`);
  const answer = changes["Answer"];
  if (present.includes("Answer")) {
    if (typeof answer !== "string") v.push(`Answer must be a string; got ${q(answer)}`);
    else if (!answer.startsWith(FIXTURE_ANSWER_PREFIX)) v.push(`Answer must start with ${q(FIXTURE_ANSWER_PREFIX)}; it starts with ${q(answer.slice(0, FIXTURE_ANSWER_PREFIX.length))}`);
    else if (answer.length === FIXTURE_ANSWER_PREFIX.length) v.push("Answer carries no text after the prefix");
  }
  return v.length === 0 ? undefined : [...v, PROOF];
}
