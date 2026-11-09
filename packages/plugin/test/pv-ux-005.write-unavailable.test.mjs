/**
 * PV-UX-005 (skill text) — a turn always ends with a sentence, and a write that cannot happen says so.
 *
 * Observed 2026-09-21, fresh chat: the seller answered B1 on a message that did not carry the Notion app.
 * `os_prepare` still succeeded (VERTIGO was exposed), so a plan was created and took the runtime's mutation
 * lease; the native writes then had nowhere to go. The model narrated its attempts and the turn simply stopped:
 * no sentence, no next step, a lease held for the plan's whole TTL. §2's pre-check exists, but it sits where the
 * model has no signal — exposure is only observable when the write fails. These pin the rule at the point where
 * the signal actually is.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const CANONICAL = new URL("../SKILL.md", import.meta.url);
const section = (skill) => skill.split("## 2. Durable change")[1].split("## 2a.")[0];

test("PV-UX-005/a: a rendered action that cannot be executed stops the chain and names the human action", async () => {
  const s2 = section(await readFile(CANONICAL, "utf8"));
  assert.ok(s2.includes("**If a rendered action cannot be executed**"), "§2 has no branch for a write that cannot happen");
  for (const must of [
    "Do not retry it, do not run the actions after it, do not call `os_verify`",
    "never describe the change as made",
    "Je n'ai pas pu écrire dans Notion",
    "Renvoyez votre réponse en gardant VERTIGO et Notion sélectionnés",
    "the backend reuses that same plan rather than opening a second one",
  ]) assert.ok(s2.includes(must), `§2 lacks: ${must}`);
});

test("PV-UX-006/skill: an interrupted plan is resumed from the actions the resume carries, never by re-verifying", async () => {
  const s2 = section(await readFile(CANONICAL, "utf8"));
  assert.ok(s2.includes("it carries that plan's own `stage1_actions` with it"), "§2 does not say the resume now carries the actions");
  assert.ok(s2.includes("**Never verify writes you have not executed.**"), "§2 does not forbid verifying writes that never happened");
  assert.ok(s2.includes("means the writes did not happen, not that the proof was early"), "§2 does not say what that hold means");
  assert.ok(s2.includes("Two identical verifications in a row are a loop"), "§2 does not name the loop the seller waits through");
});

test("PV-UX-007/skill: a reply that requires native actions permits no tool call until they are done", async () => {
  const s2 = section(await readFile(CANONICAL, "utf8"));
  assert.ok(s2.includes("**A reply that carries `next.native_actions_required` permits no tool call at all.**"), "§2 does not bind the caller to the native-actions field");
  assert.ok(s2.includes("`next.then_call` is the tool that becomes permitted afterwards"), "§2 does not say what unblocks the next tool");
  assert.ok(s2.includes("carries no `permitted_tool_call` precisely because"), "§2 does not explain the absent field");
  assert.ok(s2.includes("would hold on an unopened work journal"), "§2 does not name what verifying too early actually produces");
});

test("PV-UX-005/b: no turn may end on a tool call", async () => {
  const s2 = section(await readFile(CANONICAL, "utf8"));
  assert.ok(s2.includes("**Never end a turn without a sentence.**"), "§2 does not require a closing sentence");
  assert.ok(s2.includes("saying where their space stands and what they do next"), "§2 does not say what that sentence must carry");
  assert.ok(s2.includes("They cannot see your tool calls"), "§2 does not say why a silent stop is unusable");
});

/**
 * PV-UX-009 — the happy path, audited end to end rather than one failed test at a time.
 *
 * Four turn-level decisions had no single unambiguous rule: the caller was told to build the mutation and never
 * told to send it; told to refuse to prepare on an exposure it cannot observe; told to ask the next question
 * after the answer's transaction, one transaction before the step had actually moved; and handed an exception
 * list that counted four items and then said three. These pin each decision to one reading.
 */
test("PV-UX-009/a: building the mutation is followed by the call that sends it", async () => {
  const skill = await readFile(CANONICAL, "utf8");
  const s2b = skill.split("## 2b.")[1].split("## 2c.")[0];
  assert.ok(s2b.includes("call `os_prepare` with that one mutation as the `intent`"), "§2b builds a mutation it never tells anyone to send");
  assert.ok(/Building the mutation\s+is not persisting it/.test(s2b), "§2b does not say why stopping there loses the answer");
});

test("PV-UX-009/b: the answer's transaction is not the end of the step", async () => {
  const skill = await readFile(CANONICAL, "utf8");
  const s1d = skill.split("## 1d.")[1].split("## 1e.")[0];
  assert.ok(s1d.includes("Recording the answer has not moved the step"), "§1d still sends the caller to resume before the step moved");
  assert.ok(s1d.includes("Advance it through §1e"), "§1d does not route to the step movement");
  const voice = skill.split("## 0. Voice")[1].split("## 1.")[0];
  assert.ok(voice.includes("the step has not moved yet and no\n    next question is due"), "§0's completion template asks the next question one transaction too early");
  assert.ok(voice.includes("In all four, speak only the final user-facing reply"), "§0 lists four exceptions and then says three");
});
