/**
 * PV-SURFACE-001 — the rules that decide a business turn live where the caller actually reads them.
 *
 * Six fresh conversations, one pattern. What the TOOL DESCRIPTIONS say was obeyed every single time: os_bind
 * retried silently with the lane the message named, and every reply's `say` came back verbatim. What only
 * SKILL.md said was obeyed none of the time: the seller's answer was never captured, os_prepare was never
 * called, and the writes were never executed before verifying.
 *
 * The descriptions were the first fix — but a client caches them at initialize for the connector's lifetime, and
 * ChatGPT flagged a description written as a page of imperatives as a suspicious instruction. So the three
 * decisions that carry a business turn — capture the answer, run the writes before TARGET, run the finalization
 * before FINAL — now travel on the reply itself as `next.conduct` (PV-CONDUCT-001), computed live from the
 * envelope. The descriptions are facts; the skill keeps the stable rules.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { toolDescriptions, TOOL_NAMES } from "../../src/tools/surface.ts";
import { ok } from "../../src/tools/envelope.ts";
import { withUserSentence } from "../../src/tools/messages.fr.ts";
import { withConduct, WRITE_UNAVAILABLE_SENTENCE } from "../../src/tools/conduct.ts";

test("PV-SURFACE-001/a: the RESUMED reply that carries a pending answer carries the capture decision on itself", () => {
  const e = withConduct("os_resume", withUserSentence("os_resume", ok("RESUMED", {
    gate: { gate_key: "B1_OFFER", status: "OPEN", formal_next_question: "Quelle offre précise veux-tu vendre ?", formal_next_action: "x" },
    pending_step_input: { logical_resource_key: "SALES:BUSINESS_CONFIG", natural_key: "B1_OFFER:SELLABLE_OFFER" },
  }, { next: { safe_action: "answer", permitted_tool_call: "os_prepare", prepare_intent: { action_class: "COMMIT", summary: "s", mutations: [] } } })));
  const d = e.next.conduct ?? "";
  assert.match(d, /Read the user's CURRENT message before you say anything/);
  assert.match(d, /do not say `say`, do not ask the question again, do not call os_resume again/);
  assert.match(d, /take next\.prepare_intent exactly as given/);
  assert.match(d, /replace its \$answer placeholder with the seller's own words copied verbatim/);
  assert.match(d, /loses it; they will not type it twice/);
  assert.match(d, /never reword, improve, merge or reorder/);
});

test("PV-SURFACE-001/b: the PLAN_PREPARED reply says on itself that nothing is saved and that the writes come first", () => {
  const e = withConduct("os_prepare", withUserSentence("os_prepare", ok("PLAN_PREPARED", { plan_id: "PLAN-1", stage1_actions: [{}, {}] }, {
    next: { safe_action: "execute", native_actions_required: { app: "NOTION", count: 2, source_field: "stage1_actions", then_call: "os_verify" } },
  })));
  const d = e.next.conduct ?? "";
  assert.match(d, /NOTHING IS SAVED YET/);
  assert.match(d, /through os_commit/);
  assert.match(d, /only the guarded backend executor/);
  assert.match(d, /Never execute a native Notion write/);
  assert.match(d, /never claim completion without the backend FINAL proof/);
  assert.doesNotMatch(d, /create_pages →|Execute every entry of stage1_actions/);
});

test("PV-SURFACE-001/c: the TARGET_VERIFIED reply carries the same trap before FINAL", () => {
  const e = withConduct("os_verify", withUserSentence("os_verify", ok("TARGET_VERIFIED", { plan_id: "PLAN-1", finalization_actions: [{}], state_last_action: {} }, {
    next: { safe_action: "finalize", native_actions_required: { app: "NOTION", count: 2, source_field: "finalization_actions", then_call: "os_verify" } },
  })));
  const d = e.next.conduct ?? "";
  assert.match(d, /NOT DONE YET/);
  assert.match(d, /finalize State LAST and verify TARGET\/FINAL/);
  assert.match(d, /only the guarded backend executor/);
  assert.match(d, /never claim completion without the backend FINAL proof/);
  assert.doesNotMatch(d, /Execute finalization_actions|create_pages →/);
});

test("PV-SURFACE-001/e: the served prepare_intent is accepted by os_commit (and the internal os_prepare) exactly as served, once $answer is filled", async () => {
  // Observed 2026-09-23 17:26 on the seller's real B3 answer: the intent carried a `replace` hint INSIDE it, the
  // strict schema refused it, and the seller's first answer cost a round trip. The intent must be byte-for-byte
  // what os_prepare accepts; any instruction about it travels beside it (next.prepare_note), never in it.
  const { toolInputSchemas } = await import("../../src/tools/surface.ts");
  const { prepareIntentFor, PREPARE_NOTE } = await import("../../src/resume/pendingInput.ts");
  const intent = prepareIntentFor({ gate_key: "B3_DATA", logical_resource_key: "SALES:BUSINESS_CONFIG", natural_key: "B3_DATA:CANONICAL_SOURCE", required_values: { Category: "OTHER", State: "CONFIRMED", Version: "SALES_INPUT/1", Source: "CHAT_USER_EXPLICIT" }, required_non_empty: ["Value"] });
  assert.ok(!("replace" in intent), "no field outside the intent contract");
  const filled = JSON.parse(JSON.stringify(intent).replace("$answer", "Mes comptes viennent de la base GTM existante.")) as unknown;
  const parsed = toolInputSchemas.os_prepare.safeParse({ binding_handle: "h", intent: filled });
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues));
  // W3.4: the candidate skill routes that same served intent to os_commit, the public write of the five-tool surface.
  const committed = toolInputSchemas.os_commit.safeParse({ binding_handle: "h", intent: filled });
  assert.ok(committed.success, committed.success ? "" : JSON.stringify(committed.error.issues));
  assert.match(PREPARE_NOTE, /\$answer/);
});

test("PV-SURFACE-001/d: none of it introduces a send, and the surface is the five W3.3 tools", () => {
  assert.deepEqual([...TOOL_NAMES], ["os_bind", "os_resume", "os_commit", "os_handoff", "os_control_status"]);
  for (const n of TOOL_NAMES) assert.doesNotMatch(toolDescriptions[n], /\bsends?\b|\bsending\b|e-?mail/i, `${n} must not read as able to send`);
});
