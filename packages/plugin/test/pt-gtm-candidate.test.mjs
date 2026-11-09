/** The GTM candidate ships beside the governing package without touching it (PV-GTM-002). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = async (p) => JSON.parse(await readFile(new URL(p, import.meta.url), "utf8"));

test("the governing manifest is untouched: PLUGIN_SPEC 0.3.0 and exactly six tools", async () => {
  const manifest = await read("../manifest.json");
  assert.equal(manifest.spec, "PLUGIN_SPEC/0.3.0");
  assert.deepEqual(manifest.tools, ["os_bind", "os_resume", "os_prepare", "os_verify", "os_handoff", "os_control_status"]);
  assert.equal(manifest.harness.notion_access, "read-only");
  assert.equal(manifest.harness.gmail_access, "none");
});

test("the candidate declares itself a candidate, changes no tool and claims no adoption", async () => {
  const candidate = await read("../candidates/manifest.candidate.json");
  const manifest = await read("../manifest.json");
  assert.equal(candidate.spec, "PLUGIN_SPEC/0.4.0");
  assert.equal(candidate.status, "CANDIDATE_NOT_ADOPTED");
  assert.equal(candidate.adopted, false);
  assert.deepEqual(candidate.tools, manifest.tools);
  for (const v of Object.values(candidate.candidate_versions)) assert.equal(v.role, "CANDIDATE_NOT_ADOPTED");
  assert.deepEqual(Object.keys(candidate.candidate_needs).sort(), ["META_GTM_ANALYSIS", "SALES_GTM_CONTEXT"]);
  assert.equal(candidate.candidate_resources.length, 11);
  assert.equal(candidate.append_only_resources.length, 6);
  assert.ok(candidate.candidate_resources.includes("SALES:CAPABILITY_PROOFS"));
  assert.equal(candidate.required_capability_completeness.hold, "HOLD_REQUIRED_CAPABILITY_INCOMPLETE");
  assert.deepEqual(candidate.required_capability_completeness.fail_closed, ["UNKNOWN", "HUMAN_AUTH_PENDING", "PARTIAL", "ERROR"]);
  assert.match(candidate.required_capability_completeness.seller_experience, /no admin-relayed technical prompt/);
  assert.match(candidate.capability_gates.meta, /explicitly pins the candidate Contract Pack version/);
  assert.match(candidate.capability_gates.caller, /no hint, tool argument, environment variable or package flag/);
  assert.ok(candidate.versioned_identities.snapshot_identity.includes("the same input revision"));
  assert.ok(candidate.invariants_preserved.some((i) => /exactly six tools/.test(i)));
  assert.ok(candidate.invariants_preserved.some((i) => /no Gmail send or Calendar write/.test(i)));
  assert.ok(candidate.invariants_preserved.some((i) => /half-open Europe\/Paris CALENDAR week/.test(i)));
  assert.ok(candidate.invariants_preserved.some((i) => /reported by redacted token/.test(i)));
  assert.equal(candidate.unchanged_versions.meta_spec.version, "0.6.0");
  assert.equal(candidate.unchanged_versions.meta_schema.version, "0.2.0");
});

test("the candidate note states the adoption path and never claims to govern", async () => {
  const doc = await readFile(new URL("../candidates/PLUGIN_SPEC-0.4.0.md", import.meta.url), "utf8");
  assert.match(doc, /CANDIDATE, NOT ADOPTED/);
  assert.match(doc, /The governing package spec stays PLUGIN_SPEC 0\.3\.0/);
  assert.match(doc, /the six tools are unchanged/);
  assert.match(doc, /Required Capability completeness/);
  assert.match(doc, /exact prior gate/);
  assert.equal(/\bPASS\b/.test(doc), false, "a candidate note never claims a verdict");
});

test("PV-GTM-002F ships an explicit SALES-lane diff without claiming a canonical OS edit", async () => {
  const diff = await readFile(new URL("../candidates/PV-GTM-002F-SALES-CONTRACT-DIFF.md", import.meta.url), "utf8");
  assert.match(diff, /Plugin Engineering did not edit any canonical OS\s+source in Notion/);
  assert.match(diff, /Capability Profile/);
  assert.match(diff, /CALENDAR_READ \| REQUIRED \| READ_VERIFIED/);
  assert.match(diff, /MAIL_TRACKER_READ \| OPTIONAL/);
  assert.match(diff, /resume the same gate/);
  assert.match(diff, /Do not migrate a second runtime/);
});
