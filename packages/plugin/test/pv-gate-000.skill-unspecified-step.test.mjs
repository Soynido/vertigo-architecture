/**
 * PV-GATE-000 (skill text) — an unspecified step is said, never improvised.
 *
 * The backend now refuses to advance a step the governing contract never specified. That refusal only reaches
 * the user if the shipped text carries it: §1e used to fold every non-plan answer into "resume and continue",
 * which would have shown the step's own question again and told the user nothing, and §2b told the model to ask
 * a business question of its own whenever no canonical record was served — which at an unspecified step is the
 * model writing the gate's question itself, the exact fabrication PV-GATE-000 exists to stop.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const CANONICAL = new URL("../SKILL.md", import.meta.url);
const between = (skill, from, to) => skill.split(from)[1].split(to)[0];

test("PV-GATE-000/skill-a: §1e says an unspecified step out loud instead of resuming past it", async () => {
  const s1e = between(await readFile(CANONICAL, "utf8"), "## 1e.", "## 1r.");
  assert.ok(s1e.includes("`HOLD_GATE_UNSPECIFIED` → repeat its `say` and stop"), "§1e lacks the branch that speaks the refusal");
  assert.ok(s1e.includes("this step does not exist yet"), "§1e does not say what the refusal means");
  assert.ok(s1e.includes("asking the user anything here would be inventing the step"), "§1e does not forbid improvising the step's question");
  assert.ok(s1e.indexOf("`HOLD_GATE_UNSPECIFIED`") < s1e.indexOf("- Anything else"), "the refusal must be handled before the catch-all that resumes and continues");
});

test("PV-GATE-000/skill-b: §2b asks the backend when no record is served, and never guesses why", async () => {
  const s2b = between(await readFile(CANONICAL, "utf8"), "## 2b.", "## 2c.");
  assert.ok(s2b.includes("If `pending_step_input` is absent"), "§2b still addresses the absent declaration");
  for (const must of [
    "either its answer is already durable, or the",
    "contract does not specify this step at all",
    "do not invent the step's own question",
    "ask the backend instead, with `os_prepare` and no intent",
  ]) assert.ok(s2b.includes(must), `§2b lacks: ${must}`);
  assert.ok(s2b.includes("never fall back to\nthe META recipe below"), "the cross-lane fallback stays forbidden");
});
