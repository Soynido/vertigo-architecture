/** W7.3-R2: fixtures are local oracles, never evidence of CollaboratorGamma's native account or human consent. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/index.ts";
import type { CommitOutcome } from "../../src/transactions/commit.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import { synthetic, text } from "./meta-fixtures.ts";
import { IDS, CONTRACT_PAGE, registryEntries } from "./sales-fixtures.ts";
import { setRowsIn } from "./resume-fixtures.ts";
import { OWNER } from "./binding-fixtures.ts";
import { G, NOW, guardWorld, index, putRows, rowsOf, setIndex, type ClassEntry } from "../support/guard-fixtures.ts";
import { InMemorySalesRuntimeRegistry } from "../../src/registry/salesRuntimes.ts";
import { registerBuiltinSalesAdapters } from "../../src/versions/adapters/sales.ts";
import { SALES_CONTROL_PLANE_0513_CANDIDATE } from "../../src/versions/adapters/controlPlane.ts";
import { EXTERNAL_SPEC, EXTERNAL_SCHEMA } from "../../src/effects/eventWrite.ts";
import { bindLive, dispatch, dispatchCommit } from "../../src/tools/handlers.ts";
import { candidatePlainLanguage, candidateResume } from "../../src/tools/conduct.ts";
import { hold } from "../../src/tools/envelope.ts";
import { SOURCE_ENROLLMENT_PROTOCOL, sourceEnrollmentLogDiagnostic, deriveSourceEnrollment, issueSourceEnrollmentChallenge, resumeSourceEnrollmentChallenge, isBackendOwnedSourceEnrollmentMutation, isSourceEnrollmentPlan, type SourceEnrollmentChallenge } from "../../src/resume/sourceEnrollment.ts";
import { PostgresBackend } from "../../src/store/postgres.ts";
import { propText, type Page } from "../../src/notion/shapes.ts";
import { prepare } from "../../src/plans/prepare.ts";
import { describeActivePlan } from "../../src/plans/service.ts";
import type { Intent } from "../../src/plans/prepare.ts";
import { classify } from "../../src/guards/classify.ts";
import { openGuard } from "../../src/guards/preflight.ts";

const PROFILE = synthetic("first-link-profile"), DB = synthetic("first-link-profile-db");
const CLASS: ClassEntry = { class: "RECONCILE_AS_IS", resource_key: "SALES:SOURCE_IDENTITY", operation: "UPDATE", allowed_fields: ["Gmail Identity"] };
const rt = (s: string) => ({ type: "rich_text", rich_text: [text(s)] });
const list = (results: unknown[]) => ({ results, has_more: false, next_cursor: null });
const ctx = { principal_id: OWNER.principal_id, now: NOW };
function world(optIn = true) {
  const g = guardWorld({ doc: index([], [CLASS]) });
  Object.assign(g.deps, { salesRegistry: new InMemorySalesRuntimeRegistry(registryEntries().map(({ expected_gmail_identity: _ignored, ...entry }) => ({ ...entry, ...(optIn ? { source_identity_enrollment: ["GMAIL"] } : {}) }))) });
  registerBuiltinSalesAdapters(g.deps.adapters.salesRuntime);
  const ids = IDS("rep-a"), manifest = g.map.get(`page:${ids.manifestRow}`) as Page;
  setRowsIn(g.map, ids.manifestDs, [{ ...manifest, properties: { ...manifest.properties, "Gmail Identity": { type: "email", email: null }, "Sales Contract Version": rt(EXTERNAL_SPEC), "Schema Version": rt(EXTERNAL_SCHEMA) } } as Page]);
  g.map.set(`data_source:${ids.manifestDs}`, { properties: { Name: { type: "title" }, "Gmail Identity": { type: "email" } } });
  g.map.set(`page:${CONTRACT_PAGE}`, { object: "page", id: CONTRACT_PAGE, archived: false, properties: { title: { type: "title", title: [text(EXTERNAL_SPEC)] } } });
  const root = (g.map.get(`children:${G.root}`) as { results: Array<{ child_page?: { title: string } }> }).results;
  g.map.set(`children:${G.root}`, list(root.map(b => b.child_page?.title === "00 — BOOT" ? { ...b, child_page: { title: "00 — BOOT & INSTANCE" } } : b)));
  const cp = (g.map.get(`children:${G.cp}`) as { results: unknown[] }).results;
  g.map.set(`children:${G.cp}`, list([...cp, { object: "block", id: DB, type: "child_database", child_database: { title: "Capability Profile" } }]));
  g.map.set(`database:${DB}`, { object: "database", id: DB, data_sources: [{ id: PROFILE }] });
  const profile = SALES_CONTROL_PLANE_0513_CANDIDATE.installContract!.physicalResources.find(r => r.key === "CAPABILITY_PROFILE")!;
  g.map.set(`data_source:${PROFILE}`, { properties: Object.fromEntries(Object.entries(profile.requiredProperties!).map(([k, type]) => [k, { type, ...(type === "select" ? { select: { options: (profile.requiredSelectOptions?.[k] ?? []).map(name => ({ name })) } } : {}) }])) });
  putRows(g.map, PROFILE, []);
  return g;
}
async function observed(approve = false) {
  const g = world(), h = await g.bind();
  if (approve) await g.approve();
  const raw = await dispatch("os_resume", { binding_handle: h }, ctx, g.deps);
  assert.equal(raw.code, "HOLD_REQUIRED_CAPABILITY_INCOMPLETE", JSON.stringify(raw));
  const enrollment = raw.observations.source_identity_enrollment as SourceEnrollmentChallenge;
  assert.ok(enrollment, JSON.stringify(raw));
  assert.equal(enrollment.stage, "OBSERVE");
  const evidence = { challenge: enrollment.challenge, competent_source: "GMAIL", source_identity: "member@example.invalid", evidence_ref: "fixture:native-profile", verified_at: NOW.toISOString() };
  const question = await dispatchCommit({ binding_handle: h, capability_evidence: evidence }, ctx, g.deps);
  assert.equal(question.kind, "HELD", JSON.stringify(question));
  if (question.kind !== "HELD") throw new Error("expected first-link question");
  const confirmation = question.source_identity_enrollment!;
  assert.equal(confirmation.stage, "CONFIRM");
  assert.match(question.say, /member@example.invalid.*Utiliser ce compte/);
  assert.equal(g.client.writes.length, 0);
  assert.equal(rowsOf(g.map, PROFILE).length, 0);
  const confirmed = { ...evidence, challenge: confirmation.challenge, evidence_ref: `user-confirmed:${confirmation.evidence_ref}` };
  const bound = await bindLive(h, ctx, g.deps);
  assert.ok(bound.ok); if (!bound.ok) throw new Error("binding failed");
  return { g, h, raw, evidence, confirmation, confirmed, bound };
}

test("R2: repeated observation asks for confirmation, no Notion bytes or READ_VERIFIED claim", async () => {
  const { g, h, raw, evidence } = await observed();
  const candidate = candidatePlainLanguage("os_resume", candidateResume(raw));
  assert.match(candidate.next.conduct!, /ONE identity read/);
  assert.match(candidate.next.conduct!, /os_commit/);
  assert.doesNotMatch(candidate.next.conduct!, /os_prepare|os_verify/);
  const again = await dispatchCommit({ binding_handle: h, capability_evidence: evidence }, ctx, g.deps);
  assert.equal(again.kind, "HELD");
  assert.equal(g.client.writes.length, 0);
});

test("R2: forged, stale, substituted, cross-binding or disabled evidence cannot link", async () => {
  const { g, h, confirmed, evidence, bound } = await observed();
  for (const mutation of [{ ...confirmed, challenge: confirmed.challenge + ".forged" }, { ...confirmed, source_identity: "other@example.invalid" },
    { ...confirmed, evidence_ref: evidence.evidence_ref }, { ...confirmed, competent_source: "GOOGLE_CALENDAR" },
    { ...confirmed, verified_at: "2020-01-01T00:00:00Z" }]) {
    const rejected = await dispatchCommit({ binding_handle: h, capability_evidence: mutation }, ctx, g.deps);
    assert.equal(rejected.kind, "HELD");
    if (rejected.kind === "HELD") assert.equal(rejected.source_identity_enrollment, undefined);
  }
  for (const runtime of [{ ...bound.runtime, runtime_generation: "other" }, { ...bound.runtime, root_ref: synthetic("foreign") },
    { ...bound.runtime, observations: { ...bound.runtime.observations, source_identity_enrollment: [] } }])
    assert.equal((await deriveSourceEnrollment(g.deps.notion, bound.binding, runtime, confirmed, NOW)).kind, "HOLD");
  assert.equal((await deriveSourceEnrollment(g.deps.notion, { ...bound.binding, binding_id: "other" }, bound.runtime, confirmed, NOW)).kind, "HOLD");
  assert.equal((await deriveSourceEnrollment(g.deps.notion, bound.binding, bound.runtime, confirmed, new Date(NOW.getTime() + 600_001))).kind, "HOLD");
  assert.equal(g.client.writes.length, 0);
});

test("R2: refused challenge diagnostics distinguish transport from authority without exposing values", async () => {
  const { g, bound, confirmed } = await observed();
  const [prefix, body, sig] = confirmed.challenge.split(".") as [string, string, string];
  const changedSig = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
  const sign = (raw: string) => `sid1.${raw}.${createHmac("sha256", `${SOURCE_ENROLLMENT_PROTOCOL}:${bound.binding.binding_id}:${bound.binding.handle_hash}`).update(raw).digest("base64url")}`;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as Record<string, unknown>;
  const encode = (p: Record<string, unknown>) => Buffer.from(JSON.stringify(p)).toString("base64url");
  const cases = [
    { challenge: confirmed.challenge + ".extra", diagnostic: "SOURCE_ENROLLMENT_TOKEN_SHAPE_INVALID" },
    { challenge: `${prefix}.${body}.${changedSig}`, diagnostic: "SOURCE_ENROLLMENT_TOKEN_SIGNATURE_INVALID;UNTRUSTED_AUTHORITY_FIELDS_MATCH" },
    { challenge: `${prefix}.${Buffer.from("not-json").toString("base64url")}.${sig}`, diagnostic: "SOURCE_ENROLLMENT_TOKEN_SIGNATURE_INVALID;UNTRUSTED_BODY_UNPARSEABLE" },
    { challenge: `${prefix}.${encode({ ...payload, generation: "private-other-generation" })}.${sig}`, diagnostic: "SOURCE_ENROLLMENT_TOKEN_SIGNATURE_INVALID;UNTRUSTED_AUTHORITY_FIELDS_DIFFER:generation" },
    { challenge: `${prefix}.${"A".repeat(8193)}.${sig}`, diagnostic: "SOURCE_ENROLLMENT_TOKEN_SIGNATURE_INVALID;UNTRUSTED_BODY_NOT_INSPECTED" },
    { challenge: sign(Buffer.from("not-json").toString("base64url")), diagnostic: "SOURCE_ENROLLMENT_TOKEN_PAYLOAD_INVALID" },
    { challenge: sign(encode({ ...payload, protocol: "not-this-protocol" })), diagnostic: "SOURCE_ENROLLMENT_TOKEN_PAYLOAD_INVALID" },
  ];
  for (const { challenge, diagnostic } of cases) {
    const out = await deriveSourceEnrollment(g.deps.notion, bound.binding, bound.runtime, { ...confirmed, challenge }, NOW);
    assert.equal(out.kind, "HOLD"); if (out.kind !== "HOLD") continue;
    assert.equal(out.code, "HOLD_ACTION_NOT_AUTHORIZED");
    assert.deepEqual(out.evidence, ["first-link challenge is invalid for the current binding and authority", diagnostic]);
    assert.ok(!JSON.stringify(out).includes(challenge));
    assert.doesNotMatch(JSON.stringify(out), /private-other-generation|member@example.invalid/);
  }
  const wrongKey = await deriveSourceEnrollment(g.deps.notion, { ...bound.binding, handle_hash: "private-other-handle-hash" }, bound.runtime, confirmed, NOW);
  assert.equal(wrongKey.kind, "HOLD"); if (wrongKey.kind === "HOLD")
    assert.equal(wrongKey.evidence[1], "SOURCE_ENROLLMENT_TOKEN_SIGNATURE_INVALID;UNTRUSTED_AUTHORITY_FIELDS_MATCH");
  const drift = await deriveSourceEnrollment(g.deps.notion, bound.binding, { ...bound.runtime, runtime_generation: "private-other-generation" }, confirmed, NOW);
  assert.equal(drift.kind, "HOLD"); if (drift.kind === "HOLD")
    assert.equal(drift.evidence[1], "SOURCE_ENROLLMENT_AUTHORITY_MISMATCH:generation");
  assert.equal(g.client.writes.length, 0);
  assert.equal((await g.deps.store.plans.listByRuntime(bound.binding.project, bound.binding.lane, bound.binding.runtime_generation)).length, 0);
});

test("R2: operator log diagnostics accept only fixed labels, never arbitrary evidence or values", () => {
  const reason = "first-link challenge is invalid for the current binding and authority";
  const allowed = "SOURCE_ENROLLMENT_TOKEN_SIGNATURE_INVALID;UNTRUSTED_AUTHORITY_FIELDS_DIFFER:principal,generation";
  assert.equal(sourceEnrollmentLogDiagnostic([reason, allowed]), allowed);
  for (const value of [allowed + "\n", allowed + " private-value", "SOURCE_ENROLLMENT_AUTHORITY_MISMATCH:private-value", "sid1.private.signature", "https://private.invalid/mcp/private-value"])
    assert.equal(sourceEnrollmentLogDiagnostic([reason, value]), undefined);
  assert.equal(sourceEnrollmentLogDiagnostic(["some other refusal", allowed]), undefined);
});

test("R2: an existing registry identity claim cannot be replaced by observed native identity", async () => {
  const { g, bound, evidence, confirmed } = await observed();
  const constrained = { ...bound.runtime, observations: { ...bound.runtime.observations, registry_expected_gmail_identity: "assigned@example.invalid" } };
  for (const proof of [evidence, confirmed]) assert.equal((await deriveSourceEnrollment(g.deps.notion, bound.binding, constrained, proof, NOW)).kind, "HOLD");
  assert.equal(g.client.writes.length, 0);
});

test("R2: actual five-tool transport preserves CONFIRM across fresh resume and persists only afterward", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW.getTime() });
  const logs: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => logs.push(args.join(" ")));
  const g = world(), h = await g.bind(); await g.approve();
  const server = createServer(g.deps, OWNER.principal_id), [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "R2-fixture", version: "0" }); await client.connect(ct);
  const rpc = async <T>(name: string, input: Record<string, unknown>): Promise<T> => {
    const response = await client.callTool({ name, arguments: { binding_handle: h, ...input } });
    const first = (response.content as Array<{ type: string; text: string }>)[0]!;
    assert.equal(first.type, "text"); return JSON.parse(first.text) as T;
  };
  try {
    const resume = await rpc<Envelope>("os_resume", {});
    const observe = resume.observations.source_identity_enrollment as SourceEnrollmentChallenge;
    assert.equal(resume.next.permitted_tool_call, undefined, "native observation is required before a commit is proposed");
    const observeLog = logs.find(line => line.includes("tool=os_resume") && line.includes("event=END"));
    assert.ok(observeLog, "the actual served reply must leave a bounded decision trace");
    assert.match(observeLog, /source_stage=OBSERVE(?: |$)/);
    assert.match(observeLog, /next=NONE(?: |$)/);
    assert.match(observeLog, /enrollment_enabled=true(?: |$)/);
    assert.match(observeLog, /elapsed_ms=\d+(?: |$)/);
    const call = observeLog.match(/call=([a-f0-9]{16})(?: |$)/)?.[1];
    assert.ok(call);
    assert.equal(logs.filter(line => line.includes(`call=${call}`) && line.includes("event=START")).length, 1,
      "an unfinished request remains identifiable before any reply exists");
    const evidence = { challenge: observe.challenge, competent_source: observe.competent_source, source_identity: "member@example.invalid", evidence_ref: "fixture:current-native-profile", verified_at: NOW.toISOString() };
    const question = await rpc<CommitOutcome & { say: string }>("os_commit", { capability_evidence: evidence });
    assert.equal(question.kind, "HELD"); if (question.kind !== "HELD") return;
    const confirm = question.source_identity_enrollment!;
    assert.equal(confirm.stage, "CONFIRM"); assert.match(question.next!.conduct, /explicit affirmative HUMAN reply/);
    const questionLog = logs.find(line => line.includes("tool=os_commit") && line.includes("event=END"));
    assert.ok(questionLog);
    assert.match(questionLog, /source_stage=CONFIRM(?: |$)/);
    assert.match(questionLog, /phase=PREPARE(?: |$)/);
    assert.match(question.say, /member@example.invalid/); assert.equal(g.client.writes.length, 0);
    const nextTurn = await rpc<Envelope>("os_resume", {});
    const pending = nextTurn.observations.source_identity_enrollment as SourceEnrollmentChallenge & { completion_args: { capability_evidence: typeof evidence } };
    assert.equal(pending.stage, "CONFIRM");
    assert.equal(pending.challenge, confirm.challenge, "resume preserves the server-issued confirmation rather than starting again");
    assert.deepEqual(pending.completion_args.capability_evidence, { ...evidence, challenge: confirm.challenge, evidence_ref: `user-confirmed:${confirm.evidence_ref}` });
    assert.match(nextTurn.say!, /member@example.invalid.*Utiliser ce compte/);
    assert.match(nextTurn.next.conduct!, /Do not re-read or ask again/);
    assert.match(nextTurn.next.conduct!, /immediately preceding assistant message/);
    assert.equal(nextTurn.next.permitted_tool_call, "os_commit", "structured continuation must agree with the conditional CONFIRM conduct");
    assert.match(nextTurn.next.safe_action, /explicit current human reply/);
    assert.match(nextTurn.next.safe_action, /completion_args|decline_args/);
    const invalid = await rpc<CommitOutcome>("os_commit", { capability_evidence: { ...evidence, challenge: confirm.challenge + ".extra" } });
    assert.equal(invalid.kind, "HELD");
    assert.ok(logs.some(line => line.endsWith("diagnostic=SOURCE_ENROLLMENT_TOKEN_SHAPE_INVALID")));
    assert.ok(!logs.join("\n").includes(confirm.challenge));
    assert.doesNotMatch(logs.join("\n"), /member@example.invalid/);
    assert.ok(!logs.join("\n").includes(h), "binding handles never enter diagnostic traces");
    assert.ok(!logs.join("\n").includes(OWNER.principal_id), "no business identity is used as a correlation key");
    assert.ok(logs.every(line => line.length <= 640), "trace volume is bounded independently of payload size");
    assert.equal(g.client.writes.length, 0);
    const committed = await rpc<CommitOutcome>("os_commit", pending.completion_args);
    assert.equal(committed.kind, "PERSISTED", JSON.stringify(committed));
    if (committed.kind === "PERSISTED") { assert.equal(committed.step_moved, false); assert.equal(committed.derived_move, "NONE"); }
    assert.ok(logs.some(line => line.includes("event=END") && line.includes("outcome=PERSISTED")),
      "server-side persistence is distinguishable from a refusal, independently of chat rendering");
    assert.ok(logs.every(line => line.length <= 640));
  } finally { await client.close(); await server.close(); }
});

test("R2: no opt-in or linked mailbox means no enrollment; public intent is refused", async () => {
  const g = world(false), h = await g.bind();
  const raw = await dispatch("os_resume", { binding_handle: h }, ctx, g.deps);
  assert.equal(raw.observations.source_identity_enrollment, undefined);
  const { g: yes, h: yh, bound, confirmed } = await observed();
  const derived = await deriveSourceEnrollment(yes.deps.notion, bound.binding, bound.runtime, confirmed, NOW);
  assert.equal(derived.kind, "READY"); if (derived.kind !== "READY") return;
  for (const action of ["COMMIT", "RECONCILE"]) {
    const intent: Intent = { ...structuredClone(derived.intent), action_class: action,
      mutations: derived.intent.mutations.map(m => ({ ...m, ...(action === "RECONCILE" ? { desired_changes: {} } : {}) })) };
    assert.equal((await dispatchCommit({ binding_handle: yh, intent }, ctx, yes.deps)).kind, "HELD");
    assert.equal((await prepare(yes.deps, bound.binding, bound.runtime, intent, NOW)).kind, "HOLD");
  }
  assert.equal(issueSourceEnrollmentChallenge(bound.binding, { ...bound.runtime, observations: { ...bound.runtime.observations, mailbox_identity: "already@example.invalid" } }, raw.observations, NOW), undefined);
  assert.equal(yes.client.writes.length, 0);
});

test("R2: pending resume is bounded, byte-exact and never renews expiry or performs an identity read", async () => {
  const { g, h, raw, evidence, confirmation, bound } = await observed();
  const queries: unknown[] = [], listEvents = g.deps.store.events.list;
  g.deps.store.events.list = async filter => { queries.push(filter); return listEvents(filter); };
  const resumed = await resumeSourceEnrollmentChallenge(g.deps.store, bound.binding, bound.runtime, raw.observations, new Date(NOW.getTime() + 60_000));
  assert.equal(resumed?.challenge, confirmation.challenge);
  assert.equal(resumed?.expires_at, confirmation.expires_at);
  assert.deepEqual(queries, [{ binding_id: bound.binding.binding_id, runtime_id: bound.runtime.runtime_id, event_type: "SOURCE_ENROLLMENT_CONFIRMATION", newest_first: true, limit: 1 }]);
  const reissued = await dispatchCommit({ binding_handle: h, capability_evidence: evidence }, ctx, g.deps);
  assert.equal(reissued.kind, "HELD"); if (reissued.kind !== "HELD") return;
  assert.notEqual(reissued.source_identity_enrollment?.challenge, confirmation.challenge, "a new emission cannot resurrect an earlier confirmation even at the same clock time");
  assert.equal(reissued.source_identity_enrollment?.expires_at, confirmation.expires_at, "re-emission never extends the original TTL");
  assert.equal((await listEvents({ event_type: "SOURCE_ENROLLMENT_CONFIRMATION" })).length, 2);
  assert.equal(g.client.writes.length, 0);
});

test("R2: expired, drifted, filled, wrong-binding or changed first requirement cannot resume pending CONFIRM", async () => {
  const { g, raw, bound } = await observed();
  const resume = (b = bound.binding, r = bound.runtime, s = raw.observations, at = NOW) => resumeSourceEnrollmentChallenge(g.deps.store, b, r, s, at);
  assert.equal((await resume(bound.binding, bound.runtime, raw.observations, new Date(NOW.getTime() + 600_001)))?.stage, "OBSERVE");
  assert.equal((await resume({ ...bound.binding, binding_id: "other" }))?.stage, "OBSERVE");
  for (const runtime of [
    { ...bound.runtime, root_ref: synthetic("drift") },
    { ...bound.runtime, versions: { ...bound.runtime.versions, governing_spec: "UNKNOWN" as const } },
    { ...bound.runtime, observations: { ...bound.runtime.observations, registry_expected_gmail_identity: "other@example.invalid" } },
  ]) assert.equal((await resume(bound.binding, runtime))?.stage, "OBSERVE");
  assert.equal(await resume(bound.binding, { ...bound.runtime, runtime_generation: "different" }), undefined);
  assert.equal(await resume(bound.binding, { ...bound.runtime, observations: { ...bound.runtime.observations, mailbox_identity: "linked@example.invalid" } }), undefined);
  assert.equal(await resume(bound.binding, { ...bound.runtime, observations: { ...bound.runtime.observations, source_identity_enrollment: [] } }), undefined);
  const comparisons = raw.observations.capability_completeness as { comparisons: Array<{ capability: string; competent_source: string }> };
  assert.equal(await resume(bound.binding, bound.runtime, { ...raw.observations, capability_completeness: { ...comparisons, comparisons: comparisons.comparisons.map(c => ({ ...c, capability: "DIFFERENT_READ", competent_source: "DIFFERENT" })) } }), undefined);
  assert.equal(g.client.writes.length, 0);
});

test("R2: explicit decline writes no Notion bytes, skips business recovery and invalidates that pending reply", async () => {
  const { g, h, confirmation, confirmed } = await observed(true);
  const listPlans = g.deps.store.plans.listByRuntime;
  g.deps.store.plans.listByRuntime = async () => { throw new Error("decline must not recover business plans"); };
  const declined = await dispatchCommit({ binding_handle: h, ...confirmation.decline_args }, ctx, g.deps);
  g.deps.store.plans.listByRuntime = listPlans;
  assert.equal(declined.kind, "HELD"); assert.match(declined.say, /je ne rattache pas ce compte/);
  assert.equal(g.client.writes.length, 0); assert.equal(rowsOf(g.map, PROFILE).length, 0);
  const resumed = await dispatch("os_resume", { binding_handle: h }, ctx, g.deps);
  assert.equal((resumed.observations.source_identity_enrollment as SourceEnrollmentChallenge).stage, "OBSERVE");
  const rejected = await dispatchCommit({ binding_handle: h, capability_evidence: confirmed }, ctx, g.deps);
  assert.equal(rejected.kind, "HELD"); if (rejected.kind === "HELD") assert.deepEqual(rejected.evidence, ["first-link confirmation is no longer pending"]);
  assert.equal(g.client.writes.length, 0);
});

test("R2: superseded confirmation cannot link an older observed account", async () => {
  const { g, h, evidence, confirmed } = await observed(true);
  const next = await dispatchCommit({ binding_handle: h, capability_evidence: { ...evidence, source_identity: "new@example.invalid", evidence_ref: "fixture:new-profile" } }, ctx, g.deps);
  assert.equal(next.kind, "HELD"); if (next.kind !== "HELD") return;
  const resumed = await dispatch("os_resume", { binding_handle: h }, ctx, g.deps);
  assert.equal((resumed.observations.source_identity_enrollment as SourceEnrollmentChallenge).source_identity, "new@example.invalid");
  const old = await dispatchCommit({ binding_handle: h, capability_evidence: confirmed }, ctx, g.deps);
  assert.equal(old.kind, "HELD"); if (old.kind === "HELD") assert.deepEqual(old.evidence, ["first-link confirmation is no longer pending"]);
  assert.equal(g.client.writes.length, 0);
});

test("R2: replaying OBSERVE after decline or supersession never resurrects the old completion arguments", async () => {
  for (const decision of ["DECLINE", "SUPERSEDE"]) {
    const { g, h, evidence, confirmation } = await observed(true);
    if (decision === "DECLINE") await dispatchCommit({ binding_handle: h, ...confirmation.decline_args }, ctx, g.deps);
    else await dispatchCommit({ binding_handle: h, capability_evidence: { ...evidence, source_identity: "new@example.invalid", evidence_ref: "fixture:new-profile" } }, ctx, g.deps);
    const replay = await dispatchCommit({ binding_handle: h, capability_evidence: evidence }, ctx, g.deps);
    assert.equal(replay.kind, "HELD"); if (replay.kind !== "HELD") continue;
    assert.notEqual(replay.source_identity_enrollment?.challenge, confirmation.challenge);
    assert.equal(replay.source_identity_enrollment?.expires_at, confirmation.expires_at);
    const stale = await dispatchCommit({ binding_handle: h, ...confirmation.completion_args }, ctx, g.deps);
    assert.equal(stale.kind, "HELD"); if (stale.kind === "HELD") assert.deepEqual(stale.evidence, ["first-link confirmation is no longer pending"]);
    assert.equal(g.client.writes.length, 0);
  }
});

test("R2: PostgreSQL restart preserves the exact pending confirmation and permits only guarded completion", { skip: !process.env["HARNESS_TEST_DATABASE_URL"] && "HARNESS_TEST_DATABASE_URL not set" }, async () => {
  const url = process.env["HARNESS_TEST_DATABASE_URL"]!;
  const admin = new PostgresBackend(url);
  await admin.pool.query("create schema if not exists pt_source_enrollment"); await admin.close();
  const scoped = `${url}${url.includes("?") ? "&" : "?"}options=${encodeURIComponent("-c search_path=pt_source_enrollment")}`;
  let backend = new PostgresBackend(scoped);
  try {
    await backend.migrateAll(new URL("../../migrations/", import.meta.url));
    await backend.pool.query("truncate plan_writes, transaction_events, receipts, runtime_leases, plan_operations, plans, bindings, principals cascade");
    const g = world(); Object.assign(g.deps, { store: backend.store() });
    const h = await g.bind(); await g.approve();
    const initial = await dispatch("os_resume", { binding_handle: h }, ctx, g.deps);
    const observe = initial.observations.source_identity_enrollment as SourceEnrollmentChallenge;
    const question = await dispatchCommit({ binding_handle: h, capability_evidence: { challenge: observe.challenge, competent_source: observe.competent_source, source_identity: "member@example.invalid", evidence_ref: "fixture:pg-native", verified_at: NOW.toISOString() } }, ctx, g.deps);
    assert.equal(question.kind, "HELD"); if (question.kind !== "HELD") return;
    const confirmation = question.source_identity_enrollment!;
    await backend.close(); backend = new PostgresBackend(scoped); Object.assign(g.deps, { store: backend.store() });
    const resumed = await dispatch("os_resume", { binding_handle: h }, ctx, g.deps);
    const pending = resumed.observations.source_identity_enrollment as SourceEnrollmentChallenge;
    assert.equal(pending.stage, "CONFIRM"); assert.equal(pending.challenge, confirmation.challenge);
    assert.deepEqual(pending.completion_args, confirmation.completion_args); assert.equal(g.client.writes.length, 0);
    Object.assign(g.deps, { clock: () => NOW, commitBudgetMs: 0 });
    const paused = await dispatchCommit({ binding_handle: h, ...pending.completion_args }, ctx, g.deps);
    assert.equal(paused.kind, "IN_PROGRESS"); if (paused.kind !== "IN_PROGRESS") return;
    assert.equal(g.client.writes.length, 0);
    await backend.close(); backend = new PostgresBackend(scoped);
    Object.assign(g.deps, { store: backend.store(), commitBudgetMs: 35_000 });
    const completed = candidateResume(await dispatch("os_resume", { binding_handle: h }, { ...ctx, candidate_resume: true }, g.deps));
    assert.match(completed.say ?? "", /enregistré et vérifié/);
    assert.doesNotMatch(completed.say ?? "", /Utiliser ce compte/);
    assert.equal((await g.deps.store.plans.get(paused.plan_id))?.plan_state, "FINAL_VERIFIED");
    assert.equal((await g.deps.store.receipts.findByPlan(paused.plan_id, "FINAL")).filter(r => r.status === "VALID").length, 1);
    assert.equal(propText(g.map.get(`page:${IDS("rep-a").manifestRow}`) as Page, "Gmail Identity"), "member@example.invalid");
    assert.equal(rowsOf(g.map, PROFILE).length, 0);
  } finally { await backend.close(); }
});

test("R2: non-opted-in capability conduct remains byte-exact stop, even with a valid challenge", () => {
  const legacy = candidateResume(hold("HOLD_REQUIRED_CAPABILITY_INCOMPLETE", "verify", []));
  for (const source of ["GMAIL", "GOOGLE_CALENDAR", "FUTURE_CRM"]) {
    const raw = hold("HOLD_REQUIRED_CAPABILITY_INCOMPLETE", "verify", [], { observations: { capability_remediation: { challenge: "opaque", capability: `${source}_READ`, competent_source: source } } });
    const reply = candidateResume(raw);
    assert.equal(reply.next.conduct, legacy.next.conduct);
    assert.equal(reply.say, legacy.say);
  }
});

test("R2: exact factory classification only; missing approval never auto-approved", async () => {
  const { g, h, bound, confirmed } = await observed(true);
  const derived = await deriveSourceEnrollment(g.deps.notion, bound.binding, bound.runtime, confirmed, NOW);
  assert.equal(derived.kind, "READY"); if (derived.kind !== "READY") return;
  const m = derived.intent.mutations[0]!;
  const guard = await openGuard(g.deps, bound.binding, bound.runtime, NOW);
  assert.equal(guard.kind, "OPEN"); if (guard.kind !== "OPEN") return;
  assert.equal(isBackendOwnedSourceEnrollmentMutation(bound.runtime, m), true);
  assert.deepEqual(await classify(g.deps.notion, bound.runtime, "BUSINESS", m, guard.snapshot), { kind: "CLASS", cls: "RECONCILE_AS_IS" });
  assert.equal((await classify(g.deps.notion, bound.runtime, "BUSINESS", structuredClone(m), guard.snapshot)).kind, "UNCLASSIFIED");
  const missing = await observed(false);
  const held = await dispatchCommit({ binding_handle: missing.h, capability_evidence: missing.confirmed }, ctx, missing.g.deps);
  assert.equal(held.kind, "HELD");
  if (held.kind === "HELD") assert.equal(held.code, "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE");
  assert.equal(missing.g.client.writes.length, 0);
  void h;
});

test("R2: guarded link is TARGET+FINAL verified, State last, capabilities still required", async () => {
  const { g, h, confirmed } = await observed(true);
  const committed = await dispatchCommit({ binding_handle: h, capability_evidence: confirmed }, ctx, g.deps);
  assert.equal(committed.kind, "PERSISTED", JSON.stringify(committed));
  if (committed.kind !== "PERSISTED") return;
  assert.equal(committed.step_moved, false); assert.equal(committed.derived_move, "NONE");
  assert.equal(propText(g.map.get(`page:${IDS("rep-a").manifestRow}`) as Page, "Gmail Identity"), "member@example.invalid");
  assert.equal(rowsOf(g.map, PROFILE).length, 0);
  const plan = await g.deps.store.plans.get(committed.plan_id);
  assert.ok(plan); if (!plan) return;
  const bound = await bindLive(h, ctx, g.deps); assert.ok(bound.ok); if (!bound.ok) return;
  assert.equal(isSourceEnrollmentPlan(bound.runtime, plan), true);
  assert.equal(plan.state_last_write.source_identity_enrollment?.confirmation, "ASSISTANT_ATTESTED_EXPLICIT_USER_REPLY");
  const rows = await g.deps.store.planWrites.list(plan.plan_id);
  assert.equal(rows.at(-1)?.symbol, plan.state_last_write.symbol);
  const count = g.client.writes.length;
  assert.equal((await dispatchCommit({ binding_handle: h, capability_evidence: confirmed }, ctx, g.deps)).kind, "HELD");
  assert.equal(g.client.writes.length, count);
  const raw = await dispatch("os_resume", { binding_handle: h }, ctx, g.deps);
  assert.equal(raw.code, "HOLD_REQUIRED_CAPABILITY_INCOMPLETE");
  assert.equal(raw.observations.source_identity_enrollment, undefined);
  assert.equal((raw.observations.capability_remediation as { capability: string }).capability, "GMAIL_READ");
});

// Catches the generic unsent-draft capability check rejecting the backend's already-confirmed
// identity-only plan before its first byte. A bounded call is not a new request for consent.
test("R2: a confirmed identity plan with no first byte resumes on the same binding", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW.getTime() });
  t.mock.method(console, "error", () => {});
  const { g, h, confirmed } = await observed(true);
  const server = createServer(g.deps, OWNER.principal_id), [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "R2-zero-byte-resume", version: "0" }); await client.connect(ct);
  const rpc = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const response = await client.callTool({ name, arguments: { binding_handle: h, ...args } });
    return JSON.parse((response.content as Array<{ text: string }>)[0]!.text) as T;
  };
  try {
  Object.assign(g.deps, { clock: () => NOW, commitBudgetMs: 0 });
  const paused = await rpc<CommitOutcome>("os_commit", { capability_evidence: confirmed });
  assert.equal(paused.kind, "IN_PROGRESS", JSON.stringify(paused));
  if (paused.kind !== "IN_PROGRESS") return;
  assert.equal(paused.writes_done, 0);
  assert.equal(g.client.writes.length, 0);
  Object.assign(g.deps, { commitBudgetMs: 35_000 });

  const resumed = await rpc<Envelope>("os_resume", {});
  assert.equal(propText(g.map.get(`page:${IDS("rep-a").manifestRow}`) as Page, "Gmail Identity"), "member@example.invalid", JSON.stringify(resumed));
  assert.equal((await g.deps.store.plans.get(paused.plan_id))?.plan_state, "FINAL_VERIFIED");
  const receipts = await g.deps.store.receipts.findByPlan(paused.plan_id);
  assert.equal(receipts.filter(r => r.type === "FINAL" && r.status === "VALID").length, 1);
  assert.equal(g.client.writes.at(-1)?.ctx.symbol, "STATE_LAST");
  assert.equal(rowsOf(g.map, PROFILE).length, 0, "identity linking grants no operational read proof");
  assert.equal(resumed.code, "HOLD_REQUIRED_CAPABILITY_INCOMPLETE");
  assert.match(resumed.say ?? "", /enregistré et vérifié/);
  assert.doesNotMatch(resumed.say ?? "", /Utiliser ce compte/, "no repeated account question after FINAL");
  assert.equal(resumed.next.permitted_tool_call, undefined, "no stale confirmation submission after FINAL");
  const writes = g.client.writes.length;
  const next = await rpc<Envelope>("os_resume", {});
  assert.equal(g.client.writes.length, writes, "completed link is not replayed");
  assert.equal(next.observations.source_identity_enrollment, undefined);
  assert.equal((next.observations.capability_remediation as { capability: string }).capability, "GMAIL_READ");
  } finally { await client.close(); await server.close(); }
});

test("R2: a real bounded journal reply continues the confirmed plan, not the account question", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW.getTime() });
  t.mock.method(console, "error", () => {});
  const { g, h, confirmed } = await observed(true);
  // One real fixture write consumes the call budget, forcing every protocol boundary to be resumed.
  g.client.onWrite = () => { g.clock.t += 32_000; };
  const server = createServer(g.deps, OWNER.principal_id), [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "R2-bounded-journal", version: "0" }); await client.connect(ct);
  const rpc = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const response = await client.callTool({ name, arguments: { binding_handle: h, ...args } });
    return JSON.parse((response.content as Array<{ text: string }>)[0]!.text) as T;
  };
  try {
    const paused = await rpc<CommitOutcome>("os_commit", { capability_evidence: confirmed });
    assert.equal(paused.kind, "IN_PROGRESS"); if (paused.kind !== "IN_PROGRESS") return;
    assert.equal(paused.writes_done, 1);
    const first = await rpc<Envelope>("os_resume", {});
    assert.equal(first.code, "HOLD_RECOVERY_REQUIRED");
    assert.equal(first.next.permitted_tool_call, "os_resume", "a genuine budget boundary is not an administrator-only stop");
    assert.match(first.next.conduct!, /at most TWO/);
    assert.match(first.next.conduct!, /no progress/i);
    assert.doesNotMatch(first.say ?? "", /Utiliser ce compte|personne qui a installé|enregistré et vérifié/);
    assert.equal((first.observations["ledger_continuation"] as { plan_id: string }).plan_id, paused.plan_id);
    assert.equal(rowsOf(g.map, PROFILE).length, 0);
    let reply: Envelope = first;
    // Several hypothetical human turns, each still bounded by the served TWO-follow-up limit.
    for (let n = 0; n < 7 && reply.next.permitted_tool_call === "os_resume"; n++) reply = await rpc<Envelope>("os_resume", {});
    assert.equal((await g.deps.store.plans.get(paused.plan_id))?.plan_state, "FINAL_VERIFIED", JSON.stringify({ code: reply.code, continuation: reply.observations["ledger_continuation"], hold: reply.observations["durable_hold"], writes: g.client.writes.map(w => w.ctx.symbol), events: (await g.deps.store.events.list({ plan_id: paused.plan_id })).filter(e => /HELD|HOLD/.test(e.event_type)).map(e => ({ type: e.event_type, result: e.result, evidence: e.detail?.["evidence"] })) }));
    assert.equal((await g.deps.store.receipts.findByPlan(paused.plan_id, "FINAL")).filter(r => r.status === "VALID").length, 1);
    assert.equal(g.client.writes.length, 7, "already completed writes never replay");
    assert.equal(g.client.writes.at(-1)?.ctx.symbol, "STATE_LAST");
    assert.match(reply.say ?? "", /enregistré et vérifié/);
    assert.equal(reply.next.permitted_tool_call, undefined);
    assert.equal(reply.observations["ledger_continuation"], undefined);
    assert.equal(rowsOf(g.map, PROFILE).length, 0, "the journal completion grants no connector read capability");
    const count = g.client.writes.length;
    await rpc<Envelope>("os_resume", {});
    assert.equal(g.client.writes.length, count);
  } finally { await client.close(); await server.close(); }
});

test("R2: only the exact owned active journal progress may request another bounded resume", () => {
  const open = { plan_id: "fixture-owned-plan", plan_state: "TARGET_VERIFIED", owned_by_caller: true, same_binding: true, expired: false };
  const continuation = { protocol: "LEDGER_CONTINUATION/1", plan_id: open.plan_id, phase: "FINALIZATION", reason: "BUDGET", writes_done: 0, writes_total: 3 };
  const observations = { adoption_in_progress: true, open_backend_plan: open, ledger_continuation: continuation };
  const reply = candidateResume(hold("HOLD_RECOVERY_REQUIRED", "unfinished", [], { observations }));
  assert.equal(reply.next.permitted_tool_call, "os_resume");
  assert.doesNotMatch(reply.next.conduct!, /os_commit|os_prepare|os_verify/);
  const missingState = { ...observations, ledger_continuation: { ...continuation, phase: "STATE_LAST" },
    pending_state_last_plan_id: open.plan_id, current_run: { harness_plan_id: open.plan_id, status: "COMPLETED" }, mutations: { incomplete_count: 0 } };
  assert.equal(candidateResume(hold("HOLD_STATE_DIVERGENCE", "missing last write", [], { observations: missingState })).next.permitted_tool_call, "os_resume");
  const recovery = { ...missingState, open_backend_plan: { ...open, recovers_plan_id: "fixture-original" },
    pending_state_last_plan_id: "fixture-original", current_run: { harness_plan_id: "fixture-original", status: "COMPLETED" } };
  assert.equal(candidateResume(hold("HOLD_STATE_DIVERGENCE", "recovery last write", [], { observations: recovery })).next.permitted_tool_call, "os_resume");
  assert.equal(candidateResume(hold("HOLD_STATE_DIVERGENCE", "wrong lineage", [], { observations: { ...recovery, open_backend_plan: { ...open, recovers_plan_id: "other" } } })).next.permitted_tool_call, undefined);
  assert.equal(candidateResume(hold("HOLD_STATE_DIVERGENCE", "unproved lineage", [], { observations: { ...recovery, open_backend_plan: open } })).next.permitted_tool_call, undefined);
  for (const change of [{ pending_state_last_plan_id: "other" }, { current_run: { harness_plan_id: "other", status: "COMPLETED" } },
    { current_run: { harness_plan_id: open.plan_id, status: "RUNNING" } }, { mutations: { incomplete_count: 1 } }, { pending_state_last_plan_id: undefined }])
    assert.equal(candidateResume(hold("HOLD_STATE_DIVERGENCE", "independent divergence", [], { observations: { ...missingState, ...change } })).next.permitted_tool_call, undefined);
  for (const fault of [
    { ...observations, ledger_continuation: undefined },
    { ...observations, adoption_in_progress: false },
    { ...observations, durable_hold: { code: "HOLD_CONFLICT" } },
    { ...observations, open_backend_plan: "NONE" },
    ...[{ owned_by_caller: false }, { same_binding: false }, { expired: true }, { plan_id: "other" }, { plan_state: "FINAL_VERIFIED" }]
      .map(change => ({ ...observations, open_backend_plan: { ...open, ...change } })),
    ...[{ protocol: "other" }, { reason: "CLAIMED_ELSEWHERE" }, { reason: "INTERRUPTED" }, { phase: "PREPARE" }, { writes_done: -1 }, { writes_total: 0 }, { writes_done: 4 }, { writes_done: 0.5 }]
      .map(change => ({ ...observations, ledger_continuation: { ...continuation, ...change } })),
  ]) {
    const stopped = candidateResume(hold("HOLD_RECOVERY_REQUIRED", "unfinished", [], { observations: fault }));
    assert.equal(stopped.next.permitted_tool_call, undefined, JSON.stringify(fault));
  }
});

test("R2: an expired partly written confirmed link resumes by observation, without replay or new consent", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW.getTime() });
  t.mock.method(console, "error", () => {});
  const { g, h, confirmed } = await observed(true);
  g.client.onWrite = () => { g.clock.t += 32_000; };
  const server = createServer(g.deps, OWNER.principal_id), [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "R2-expired-journal", version: "0" }); await client.connect(ct);
  const rpc = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const response = await client.callTool({ name, arguments: { binding_handle: h, ...args } });
    return JSON.parse((response.content as Array<{ text: string }>)[0]!.text) as T;
  };
  try {
    const paused = await rpc<CommitOutcome>("os_commit", { capability_evidence: confirmed });
    assert.equal(paused.kind, "IN_PROGRESS"); if (paused.kind !== "IN_PROGRESS") return;
    g.clock.t += 21 * 60_000; t.mock.timers.setTime(g.clock.t);
    let reply = await rpc<Envelope>("os_resume", {});
    for (let n = 0; n < 10 && reply.next.permitted_tool_call === "os_resume"; n++) reply = await rpc<Envelope>("os_resume", {});
    const plans = await g.deps.store.plans.listByRuntime("VERTIGO", "SALES", (await g.deps.store.plans.get(paused.plan_id))!.runtime_generation);
    const recovered = plans.find(p => p.recovers_plan_id === paused.plan_id && p.plan_state === "FINAL_VERIFIED");
    assert.ok(recovered, JSON.stringify({ code: reply.code, hold: reply.observations["durable_hold"], continuation: reply.observations["ledger_continuation"], plans: plans.map(p => ({ state: p.plan_state, origin: p.plan_origin })), writes: g.client.writes.map(w => w.ctx.symbol) }));
    const owned = describeActivePlan([recovered], undefined, { principal_id: recovered.principal_id, binding_id: recovered.binding_id }, new Date(g.clock.t));
    assert.notEqual(owned, "NONE"); if (owned !== "NONE") assert.equal(owned.recovers_plan_id, paused.plan_id);
    const foreign = describeActivePlan([recovered], undefined, { principal_id: "other", binding_id: "other" }, new Date(g.clock.t));
    assert.notEqual(foreign, "NONE"); if (foreign !== "NONE") assert.equal(foreign.recovers_plan_id, undefined);
    assert.equal(g.client.writes.filter(w => w.target === IDS("rep-a").manifestRow).length, 1);
    assert.equal((await g.deps.store.receipts.findByPlan(recovered.plan_id, "FINAL")).filter(r => r.status === "VALID").length, 1);
    assert.equal(g.client.writes.at(-1)?.ctx.symbol, "STATE_LAST");
    assert.match(reply.say ?? "", /enregistré et vérifié/);
    assert.equal(reply.next.permitted_tool_call, undefined);
    assert.equal(rowsOf(g.map, PROFILE).length, 0);
  } finally { await client.close(); await server.close(); }
});

test("R2: confirmed zero-byte resume still refuses changed source, revoked class or invalid attestation", async () => {
  for (const fault of ["source", "approved-class", "attestation"] as const) {
    const { g, h, confirmed } = await observed(true);
    Object.assign(g.deps, { clock: () => NOW, commitBudgetMs: 0 });
    const paused = await dispatchCommit({ binding_handle: h, capability_evidence: confirmed }, ctx, g.deps);
    assert.equal(paused.kind, "IN_PROGRESS", fault); if (paused.kind !== "IN_PROGRESS") continue;
    Object.assign(g.deps, { commitBudgetMs: 35_000 });
    if (fault === "source") {
      const ids = IDS("rep-a"), manifest = g.map.get(`page:${ids.manifestRow}`) as Page;
      setRowsIn(g.map, ids.manifestDs, [{ ...manifest, properties: { ...manifest.properties, "Gmail Identity": { type: "email", email: "different@example.invalid" } } } as Page]);
    } else if (fault === "approved-class") {
      setIndex(g.map, index([], [])); await g.approve();
    } else {
      const plan = await g.deps.store.plans.get(paused.plan_id);
      assert.ok(plan);
      Object.assign(plan.state_last_write, { source_identity_enrollment: { ...plan.state_last_write.source_identity_enrollment, principal_id: "another-principal" } });
    }
    await dispatch("os_resume", { binding_handle: h }, { ...ctx, candidate_resume: true }, g.deps);
    assert.equal(g.client.writes.length, 0, fault);
    assert.equal((await g.deps.store.receipts.findByPlan(paused.plan_id, "FINAL")).length, 0, fault);
    assert.equal(propText(g.map.get(`page:${IDS("rep-a").manifestRow}`) as Page, "Gmail Identity"), fault === "source" ? "different@example.invalid" : undefined, fault);
  }
});

test("R2: zero-byte resume cannot outlive a declined or superseded account confirmation", async () => {
  for (const reply of ["unchanged", "declined", "superseded-same-account", "superseded-other-account", "legacy-unbound"] as const) {
    const { g, h, evidence, confirmation, confirmed } = await observed(true);
    Object.assign(g.deps, { clock: () => NOW, commitBudgetMs: 0 });
    const paused = await dispatchCommit({ binding_handle: h, capability_evidence: confirmed }, ctx, g.deps);
    assert.equal(paused.kind, "IN_PROGRESS", reply); if (paused.kind !== "IN_PROGRESS") continue;
    Object.assign(g.deps, { commitBudgetMs: 35_000 });
    setIndex(g.map, index([], [])); await g.approve();
    await dispatch("os_resume", { binding_handle: h }, ctx, g.deps);
    assert.equal(g.client.writes.length, 0, "retryable guard hold precedes the new reply");
    if (reply === "declined") {
      const no = await dispatchCommit({ binding_handle: h, ...confirmation.decline_args }, ctx, g.deps);
      assert.equal(no.kind, "HELD");
      if (no.kind === "HELD") assert.deepEqual(no.evidence, ["SOURCE_ENROLLMENT_DECLINED"]);
    } else if (reply === "legacy-unbound") {
      const plan = await g.deps.store.plans.get(paused.plan_id); assert.ok(plan);
      const { confirmation_challenge_sha256: _unrecorded, ...legacy } = plan.state_last_write.source_identity_enrollment!;
      Object.assign(plan.state_last_write, { source_identity_enrollment: legacy });
    } else if (reply !== "unchanged") {
      const replacement = await dispatchCommit({ binding_handle: h, capability_evidence: { ...evidence,
        ...(reply === "superseded-other-account" ? { source_identity: "other@example.invalid" } : {}) } }, ctx, g.deps);
      assert.equal(replacement.kind, "HELD");
      if (replacement.kind === "HELD") assert.notEqual(replacement.source_identity_enrollment?.challenge, confirmation.challenge);
    }
    setIndex(g.map, index([], [CLASS])); await g.approve();
    await dispatch("os_resume", { binding_handle: h }, { ...ctx, candidate_resume: true }, g.deps);
    if (reply === "unchanged") {
      assert.equal(g.client.writes.length, 7, "unchanged consent resumes after the transient guard hold");
      assert.equal((await g.deps.store.plans.get(paused.plan_id))?.plan_state, "FINAL_VERIFIED");
      assert.equal((await g.deps.store.receipts.findByPlan(paused.plan_id, "FINAL")).filter(r => r.status === "VALID").length, 1);
      assert.equal(g.client.writes.at(-1)?.ctx.symbol, "STATE_LAST");
      assert.equal(rowsOf(g.map, PROFILE).length, 0);
      continue;
    }
    assert.equal(g.client.writes.length, 0, reply);
    assert.equal((await g.deps.store.receipts.findByPlan(paused.plan_id, "FINAL")).length, 0, reply);
    assert.equal(propText(g.map.get(`page:${IDS("rep-a").manifestRow}`) as Page, "Gmail Identity"), undefined, reply);
  }
});

test("R2: same live conduct handles declared Calendar or future tools; no blanket auto-support", () => {
  for (const source of ["GMAIL", "GOOGLE_CALENDAR", "FUTURE_CRM"]) {
    const raw = hold("HOLD_REQUIRED_CAPABILITY_INCOMPLETE", "verify", [], { observations: { source_remediation_enabled: true, capability_remediation: { challenge: "opaque", capability: `${source}_READ`, competent_source: source } } });
    const reply = candidatePlainLanguage("os_resume", candidateResume(raw));
    assert.match(reply.next.conduct!, /os_commit/); assert.ok(reply.next.conduct!.includes(source));
    assert.match(reply.next.conduct!, /If unavailable/); assert.match(reply.next.conduct!, /Never write/);
    assert.doesNotMatch(reply.next.conduct!, /os_prepare|os_verify/);
  }
});

test("R2: an identity changed after the first byte is never overwritten; recovery keeps the guards", async () => {
  const { g, h, confirmed } = await observed(true);
  const id = IDS("rep-a");
  g.client.onWrite = () => {
    delete g.client.onWrite;
    const manifest = g.map.get(`page:${id.manifestRow}`) as Page;
    setRowsIn(g.map, id.manifestDs, [{ ...manifest, properties: { ...manifest.properties, "Gmail Identity": { type: "email", email: "concurrent@example.invalid" } } } as Page]);
  };
  const interrupted = await dispatchCommit({ binding_handle: h, capability_evidence: confirmed }, ctx, g.deps);
  assert.equal(interrupted.kind, "INTERRUPTED", JSON.stringify(interrupted));
  assert.equal(propText(g.map.get(`page:${id.manifestRow}`) as Page, "Gmail Identity"), "concurrent@example.invalid");
  assert.ok(g.client.writes.length > 0);
  const count = g.client.writes.length;
  await dispatchCommit({ binding_handle: h }, ctx, g.deps);
  assert.equal(g.client.writes.length, count);
});

test("R2: own lost response after Manifest resumes journal, never repeats the link or moves a business step", async () => {
  const { g, h, confirmed } = await observed(true);
  const manifest = IDS("rep-a").manifestRow;
  g.client.onWrite = entry => {
    if (entry.target !== manifest) return;
    delete g.client.onWrite;
    g.client.fault({ times: 2 }, "LOSE");
  };
  const interrupted = await dispatchCommit({ binding_handle: h, capability_evidence: confirmed }, ctx, g.deps);
  assert.equal(interrupted.kind, "INTERRUPTED", JSON.stringify(interrupted));
  if (interrupted.kind !== "INTERRUPTED") return;
  const held = await dispatch("os_resume", { binding_handle: h }, ctx, g.deps);
  assert.equal(held.code, "HOLD_RECOVERY_REQUIRED", JSON.stringify(held));
  assert.equal(held.observations.source_identity_enrollment, undefined);
  const recovered = await dispatchCommit({ binding_handle: h }, ctx, g.deps);
  assert.equal(recovered.kind, "PERSISTED", JSON.stringify(recovered));
  if (recovered.kind !== "PERSISTED") return;
  assert.equal(recovered.step_moved, false); assert.equal(recovered.derived_move, "NONE");
  assert.equal(g.client.writes.filter(w => w.target === manifest).length, 1);
  assert.equal((await g.deps.store.receipts.get(recovered.target_receipt_id))?.status, "CONSUMED", "TARGET was valid and consumed by FINAL");
  assert.equal((await g.deps.store.receipts.get(recovered.final_receipt_id))?.status, "VALID");
  assert.equal((await g.deps.store.plans.get(recovered.plan_id))?.plan_state, "FINAL_VERIFIED");
  assert.equal(g.client.writes.at(-1)?.ctx.symbol, "STATE_LAST");
});
