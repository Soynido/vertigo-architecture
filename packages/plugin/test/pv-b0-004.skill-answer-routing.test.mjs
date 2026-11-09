/**
 * PV-B0-004 (skill text) — where a SALES answer goes, and where it never goes.
 *
 * The replay of 2026-09-19 invented a key for the B0 answer and then told the seller the subject belonged to
 * META. §2b carried only the META recipe, so a SALES step had no canonical record in the shipped text at all.
 * The backend now SERVES that record on every resume (PV-B0-004, harness); this pins that the served copy tells
 * the model to obey it, and never to route a seller's answer — or the seller — to the other space.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const CANONICAL = new URL("../SKILL.md", import.meta.url);
const section = (skill) => skill.split("## 2b.")[1].split("## 2c.")[0];

test("PV-B0-004/skill-a: §2b names the served record as the canonical target of a SALES answer", async () => {
  const s2b = section(await readFile(CANONICAL, "utf8"));
  for (const must of [
    "When `os_resume` returns `pending_step_input`, that is the canonical\nrecord for the pending answer",
    "`record_selector.natural_key` = its `natural_key`, copied character for character",
    "`desired_changes` = every pair of its `required_values` exactly as served",
    "in each property its `required_non_empty` names",
    "If `pending_step_input` is absent",
    "ask one short business question and stop",
  ]) assert.ok(s2b.includes(must), `§2b lacks: ${must}`);
});

test("PV-B0-004/skill-d: §2b makes verbatim literal, because no later reader can tell the seller's words from ours", async () => {
  const s2b = section(await readFile(CANONICAL, "utf8"));
  assert.ok(/Verbatim is\s+literal\./.test(s2b), "§2b does not say that verbatim admits no paraphrase");
  assert.ok(s2b.includes("never improve the wording, the"), "§2b does not forbid the improvement that reads as harmless");
  assert.ok(s2b.includes("the record becomes their durable decision"), "§2b does not say what a rewrite costs the seller");
});

test("PV-B0-004/skill-b: a SALES answer is never recorded in META, and the seller is never sent there", async () => {
  const skill = await readFile(CANONICAL, "utf8");
  const s2b = section(skill);
  assert.ok(s2b.includes("never send a seller to the pilotage/META space to record it"), "§2b forbids the redirection that was observed");
  assert.ok(s2b.includes("never\ntarget a `META:` resource from a SALES binding"), "§2b forbids the cross-lane target");
  assert.ok(s2b.includes("never fall back to\nthe META recipe below"), "an absent declaration is a question, not the META recipe");
  assert.ok(skill.includes("- Never tell a seller that their Personal SALES work, question or answer belongs to META"), "the Never list carries the rule");
});

test("PV-B0-004/skill-c: the META recipe is kept, but is explicitly the META branch", async () => {
  const s2b = section(await readFile(CANONICAL, "utf8"));
  assert.ok(s2b.includes("**META — setup answers (fixture contract v2).**"), "the META recipe is scoped to its lane");
  assert.ok(s2b.includes("`F1:PRIMARY_OFFER`"), "the META governed-key example survives");
  const salesFirst = s2b.indexOf("**SALES — the record the contract serves.**");
  assert.ok(salesFirst >= 0 && salesFirst < s2b.indexOf("**META — setup answers"), "the SALES branch is stated before the META one");
});
