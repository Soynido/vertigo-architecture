/**
 * PV-GATE-002 (skill text) — the native Notion app is not a way around the product.
 *
 * Incident 2026-09-21. `os_bind` answered `HOLD_LANE_REQUIRED` — a normal answer, HTTP 200, carrying its
 * question. The model never called it again. It then told the seller « le connecteur refuse l'exécution », and
 * on the next message did the work itself with native Notion: eleven business rows created in the company's
 * live outreach pipeline and a task advanced to Review, with no binding, no plan, no Run, no ledger, no TARGET
 * and no FINAL — then announced that it had resumed the Sales OS and executed the work.
 *
 * The harness was right throughout; it simply was not asked. The text said what to do WITH the tools and never
 * said that without them there is nothing to do. These pin that sentence, because nothing in the backend can
 * enforce it: the model holds an independent write tool, so the only defence is that it is told, unmistakably,
 * never to use it that way.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const CANONICAL = new URL("../SKILL.md", import.meta.url);
const header = (skill) => skill.split("## 0. Voice")[0];
const never = (skill) => skill.split("## 6. Never")[1];

test("PV-GATE-002/a: the header states the boundary before any procedure does", async () => {
  const head = header(await readFile(CANONICAL, "utf8"));
  for (const must of [
    "**The native Notion app is never a substitute for these six tools.**",
    "only to execute an action a VERTIGO plan rendered in this same turn",
    "most forbidden precisely when VERTIGO is unavailable",
    "this turn changes nothing and claims nothing",
    "Doing the work by hand is not a fallback",
    "rows that no Run justifies",
  ]) assert.ok(head.includes(must), `the header lacks: ${must}`);
});

test("PV-GATE-002/b: no binding means no work, and a bind HOLD is answered rather than walked around", async () => {
  const skill = await readFile(CANONICAL, "utf8");
  const ritual = skill.split("## 1. Opening ritual")[1].split("## 1d.")[0];
  assert.ok(ritual.includes("Until `os_bind` has returned `BOUND` you have no"), "§1 does not say a missing binding ends the turn");
  assert.ok(ritual.includes("write nothing anywhere"), "§1 does not forbid writing without a binding");
  assert.ok(ritual.includes("never a closed\n   door to walk around"), "§1 does not say a bind HOLD is an answer to act on");
});

test("PV-GATE-002/c: the Never list carries the three rules the incident broke", async () => {
  const n = never(await readFile(CANONICAL, "utf8"));
  assert.ok(n.includes("Never write to Notion except by executing, verbatim, an action a VERTIGO plan rendered in this same turn"), "the write rule is missing");
  assert.ok(n.includes("Never do the work yourself because a tool is unavailable"), "the fallback rule is missing");
  assert.ok(n.includes("Reporting a tool as refusing when you did not call it again is worse still"), "the false-refusal rule is missing");
  assert.ok(n.includes("unless this turn holds a binding and ended in `TRANSACTION_VERIFIED`"), "the claim rule is missing");
});
