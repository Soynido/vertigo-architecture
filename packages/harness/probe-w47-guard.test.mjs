/** Offline engineering-helper tests, not a runtime/gate acceptance. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertLimitedIndex, checkedPreview, diagnosticMessage } from "./probe-w47-guard.mjs";

const doc = await readFile(new URL("../../docs/W4_7_GUARD_OPERATOR_REVIEW.md", import.meta.url), "utf8");
const proposal = [...doc.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1])).find((v) => v.schema_version);
const helper = fileURLToPath(new URL("./probe-w47-guard.mjs", import.meta.url));

test("exact accepted classes and fields only", () => assert.equal(assertLimitedIndex(proposal), proposal));
test("production, generic write, extra field and forged predicates are refused", () => {
  for (const change of [
    (p) => p.operation_classes[0].class = "PRODUCTION",
    (p) => p.operation_classes[0].operation = "UPDATE",
    (p) => p.operation_classes[0].allowed_fields.push("Extra"),
    (p) => p.p0_rules.push({ rule_id: 1, predicate: { op: "PRESENT", operand: { literal: { value_type: "TEXT", value: "always" } } } }),
    (p) => p.operation_classes.pop(),
  ]) {
    const p = structuredClone(proposal); change(p); assert.throws(() => assertLimitedIndex(p));
  }
});
test("empty index cannot be approved as proposal", () => assert.throws(() => assertLimitedIndex({ schema_version: "SALES_GUARD_INDEX/1", revision: 1, p0_rules: [], operation_classes: [] })));
test("digest preview validates its own exact index and P0 inventory, not a previous block read", () => {
  const snapshot = () => ({ index: structuredClone(proposal), index_page_id: "7b8b066ad3c1542fbe7c5139fb225373",
    digest: "a".repeat(64), p0_rule_ids: [], constraints: new Map(), refs: new Map() });
  assert.equal(checkedPreview(snapshot()).digest_sha256, "a".repeat(64));
  for (const change of [
    (s) => s.index.operation_classes[0].allowed_fields.push("UNREVIEWED_FIELD"),
    (s) => s.p0_rule_ids = [1, 3],
    (s) => s.p0_rule_ids.push(9),
    (s) => s.constraints.set(1, {}),
    (s) => s.refs.set("new", {}),
    (s) => s.index_page_id = "other",
  ]) { const s = snapshot(); change(s); assert.throws(() => checkedPreview(s)); }
});
test("diagnostics identify the refused check without actual-value dumps or raw API bodies", () => {
  assert.equal(diagnosticMessage({ name: "AssertionError", message: "governing P0 HOLD inventory changed\nSECRET_ACTUAL_VALUE" }), "governing P0 HOLD inventory changed");
  assert.doesNotMatch(diagnosticMessage(new Error("SECRET_API_BODY")), /SECRET/);
});
test("check runs offline and does not read a credential", () => {
  const child = spawnSync(process.execPath, ["--experimental-strip-types", helper, "--check"], { encoding: "utf8", cwd: "/tmp", timeout: 10_000 });
  assert.equal(child.status, 0); assert.match(child.stdout, /zero API\/DB\/approval\/send/);
});
test("piped operator execution and unknown flags refuse before any network or credential read", () => {
  for (const args of [["--operator", "Valentin"], ["--approve", "fake"], []]) {
    const child = spawnSync(process.execPath, ["--experimental-strip-types", helper, ...args], { encoding: "utf8", cwd: "/tmp", timeout: 10_000 });
    assert.equal(child.status, 1); assert.match(child.stderr, /STOP W4.7/); assert.equal(child.stdout, "");
  }
});
