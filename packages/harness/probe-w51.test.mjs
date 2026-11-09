/** Offline refusal tests, never evidence about CollaboratorGamma's real state. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertAssignment, assertVersions, assertReadRequest, assertDailyContext, assertReadonlyResume, assertCredentialFile, parseW51Credential, main, IDENTITY } from "./probe-w51.mjs";
import { CONTEXT_SECTIONS, CONTEXT_BOUNDS } from "./src/contractPack/catalog.ts";

const assignment = () => [{ principals: [{ principal_id: IDENTITY.principal, status: "ACTIVE", allowed_projects: ["VERTIGO"],
  allowed_lanes: ["SALES"], rep_identity_key: "CollaboratorGamma" }] }, { runtimes: [{ rep_identity_key: "CollaboratorGamma", status: "KNOWN",
  root_ref: IDENTITY.root, expected_instance_id: IDENTITY.instance, expected_gmail_identity: IDENTITY.mailbox, pointer_generation: "1" }] }];
function size(c) { for (let i = 0; i < 6; i++) c.bounds.serialized_bytes = Buffer.byteLength(JSON.stringify(c), "utf8"); return c; }
const context = () => size({ policy_version: "CONTRACT_PACK/0.3.1-candidate", policy_role: "CANDIDATE_NOT_ADOPTED",
  contexts: [{ context: "DAILY", sections: CONTEXT_SECTIONS.DAILY.map(s => ({ ...s, projected_keys: [...s.projected_keys],
    source_status: "PRESENT", items: [], served: 0, available: 0, omitted: 0, truncated_by: "NONE" })) }],
  bounds: { ...CONTEXT_BOUNDS, serialized_bytes: 0, truncated: false } });

test("W5.1 accepts only a separately supplied token, never inherited aliases or placeholders", () => {
  assert.equal(parseW51Credential("NOTION_TOKEN=offline-test-only"), "offline-test-only");
  for (const contents of ["", "NOTION_TOKEN=", "NOTION_TOKEN=COLLER_LE_NOUVEAU_JETON_ICI",
    "NOTION_READ_TOKEN=offline-test-only", "NOTION_TOKEN=offline-test-only\nOTHER=unexpected"]) {
    assert.throws(() => parseW51Credential(contents));
  }
});
test("W5.1 refuses non-private, non-regular or foreign-owned credential files", () => {
  const stat = { isFile: () => true, mode: 0o100600, uid: process.getuid() };
  assert.doesNotThrow(() => assertCredentialFile(stat));
  for (const change of [{ mode: 0o100644 }, { mode: 0o100660 }, { uid: stat.uid + 1 }, { isFile: () => false }]) {
    assert.throws(() => assertCredentialFile({ ...stat, ...change }));
  }
});

test("W5.1 offline check never reads credential or dispatches HTTP", async () => {
  const before = globalThis.fetch; let calls = 0; globalThis.fetch = () => { calls++; throw new Error("network forbidden"); };
  try { assert.deepEqual(await main(["--check"]), { result: "OFFLINE_CHECK_ONLY", assignment_valid: true, network_calls: 0 });
    await assert.rejects(main(["--root", "other"])); assert.equal(calls, 0);
  } finally { globalThis.fetch = before; }
});
test("W5.1 assignment is exact, not an operator identity borrowed from Valentin", () => {
  assert.doesNotThrow(() => assertAssignment(...assignment()));
  for (const change of [p => { p.principal_id = "p-valentin"; }, p => { p.rep_identity_key = "valentin"; },
    p => { p.allowed_lanes.push("META"); }, p => { p.meta_authority = "COMPANY_OWNER"; }, p => { p.status = "SUSPENDED"; }]) {
    const a = assignment(); change(a[0].principals[0]); assert.throws(() => assertAssignment(...a));
  }
});
test("W5.1 compares served version strings exactly, refusing repins or wrapper coercion", () => {
  const versions = { governing_spec: IDENTITY.spec, governing_schema: IDENTITY.schema };
  assert.doesNotThrow(() => assertVersions(versions));
  for (const change of [{ governing_spec: "SALES_RUNTIME_CONTRACT/0.5.13-candidate" },
    { governing_schema: "SALES_SCHEMA/0.5.8-candidate" }, { governing_spec: { value: IDENTITY.spec } }]) {
    assert.throws(() => assertVersions({ ...versions, ...change }));
  }
});
test("W5.1 refuses missing, installer, repinned or swapped runtime assignments", () => {
  for (const change of [r => { r.status = "INSTALL_PENDING"; }, r => { r.root_ref = "other"; },
    r => { r.expected_instance_id = "canary"; }, r => { r.expected_gmail_identity = "person@example.test"; },
    r => { r.activation_proof_plan_id = "install"; }]) {
    const a = assignment(); change(a[1].runtimes[0]); assert.throws(() => assertAssignment(...a));
  }
  const a = assignment(); a[1].runtimes = []; assert.throws(() => assertAssignment(...a));
});
test("W5.1 transport allows only supported Notion read endpoints", () => {
  const prefix = "https://api.notion.com/v1";
  for (const path of ["pages", "databases", "data_sources"]) assert.doesNotThrow(() => assertReadRequest(`${prefix}/${path}/${IDENTITY.root}`, { method: "GET" }));
  assert.doesNotThrow(() => assertReadRequest(`${prefix}/blocks/${IDENTITY.root}/children?start_cursor=x`, { method: "GET" }));
  assert.doesNotThrow(() => assertReadRequest(`${prefix}/data_sources/${IDENTITY.root}/query`, { method: "POST" }));
});
test("W5.1 rejects writes, redirects to another origin, Gmail, Calendar, search and unexpected routes", () => {
  for (const [url, method] of [[`https://api.notion.com/v1/pages/${IDENTITY.root}`, "PATCH"],
    ["https://api.notion.com/v1/pages", "POST"], ["https://api.notion.com/v1/search", "POST"],
    ["https://gmail.googleapis.com/gmail/v1/users/me", "GET"], ["https://www.googleapis.com/calendar/v3/calendars", "GET"],
    ["https://api.notion.com.evil.invalid/v1/pages/abc", "GET"], ["https://user@api.notion.com/v1/pages/abc", "GET"],
    [`https://api.notion.com/v1/pages/${IDENTITY.root}?unexpected=x`, "GET"]]) assert.throws(() => assertReadRequest(url, { method }));
});
test("W5.1 context proof accounts for exact full bytes, metadata and section order", () => {
  const c = context(); assert.equal(assertDailyContext(c).absent_sources.length, 0);
  c.bounds.serialized_bytes--; assert.throws(() => assertDailyContext(c));
  const swapped = context(); swapped.contexts[0].sections.reverse(); size(swapped); assert.throws(() => assertDailyContext(swapped));
});
test("W5.1 ABSENT is explicit and never replaced with an apparently empty PRESENT source", () => {
  const c = context(), s = c.contexts[0].sections[0]; s.source_status = "ABSENT"; size(c);
  assert.deepEqual(assertDailyContext(c).absent_sources, [s.source_key]);
  s.items = [{ source: { state: "VALUE", value: "GMAIL" } }]; s.served = s.available = 1; size(c);
  assert.throws(() => assertDailyContext(c));
});
test("W5.1 rejects unconfined fields, row overflow and inconsistent window counts", () => {
  for (const change of [s => { s.items = [{ secret: "unconfined" }]; s.served = s.available = 1; },
    s => { s.items = Array.from({ length: 11 }, () => ({})); s.served = s.available = 11; },
    s => { s.available = 2; s.omitted = 0; }]) {
    const c = context(); change(c.contexts[0].sections[0]); size(c); assert.throws(() => assertDailyContext(c));
  }
});

function heldContext() {
  const c = context(); c.policy_version = "CONTRACT_PACK/0.3.2-candidate";
  const resume = { status: "HOLD", code: "HOLD_REQUIRED_CAPABILITY_INCOMPLETE",
    versions: { governing_spec: IDENTITY.spec, governing_schema: IDENTITY.schema },
    evidence: ["GMAIL_READ=UNKNOWN: no competent-source proof exists for this runtime, principal and operating mode"],
    say: "Connectez votre propre boîte Gmail." };
  const holds = c.contexts[0].sections.find(s => s.section_key === "DAILY_HOLDS");
  holds.items = [{ code: resume.code, next_safe_action: resume.say }]; holds.served = holds.available = 1;
  return [resume, size(c)];
}
test("W5.1 read acceptance retains the exact Gmail HOLD without approving operational status or absences", () => {
  const [resume, c] = heldContext(), before = structuredClone([resume, c]);
  assert.equal(assertReadonlyResume(resume, c).absent_sources.length, 0);
  assert.deepEqual([resume, c], before);
  const absent = c.contexts[0].sections.find(s => s.section_key === "DAILY_UNPROCESSED_INTAKE");
  absent.source_status = "ABSENT"; size(c);
  assert.deepEqual(assertReadonlyResume(resume, c).absent_sources, [absent.source_key]);
  // This metadata is still INCOMPLETE_REQUIRES_CONTRACT_DIAGNOSIS, not a gate PASS.
});
test("W5.1 read acceptance rejects other holds, errors, mixed causes and version drift", () => {
  for (const change of [r => { r.status = "ERROR"; }, r => { r.code = "HOLD_RECOVERY_PENDING"; },
    r => { r.evidence = []; }, r => { r.evidence.push("CALENDAR_READ=UNKNOWN"); },
    r => { r.evidence[0] = "GMAIL_READ=INVALID"; }, r => { r.versions.governing_schema = "SALES_SCHEMA/0.5.8-candidate"; }]) {
    const [resume, c] = heldContext(); change(resume); assert.throws(() => assertReadonlyResume(resume, c));
  }
  const [resume, c] = heldContext(); c.policy_version = "CONTRACT_PACK/0.3.1-candidate"; size(c);
  assert.throws(() => assertReadonlyResume(resume, c));
});
test("W5.1 read acceptance rejects erased, mismatched or hidden HOLD/action context", () => {
  for (const change of [s => { s.source_status = "ABSENT"; s.items = []; s.served = s.available = 0; },
    s => { s.items[0].code = "NONE"; }, s => { s.items[0].next_safe_action = ""; },
    s => { s.items[0].next_safe_action = "Send now"; },
    s => { s.items.push({ code: "HOLD_OTHER", next_safe_action: "Other" }); s.served = s.available = 2; }]) {
    const [resume, c] = heldContext(); change(c.contexts[0].sections.find(s => s.section_key === "DAILY_HOLDS")); size(c);
    assert.throws(() => assertReadonlyResume(resume, c));
  }
});
