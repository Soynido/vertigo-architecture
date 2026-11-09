/** PT-GTM-016 — backend-owned Gmail capability attestation from challenge through verified transaction. */
import { createHmac } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { hashHandle } from "../../src/binding/handle.ts";
import { SnapshotCompetentSource } from "../../src/effects/gmail.ts";
import type { Page } from "../../src/notion/shapes.ts";
import type { Plan } from "../../src/plans/store.ts";
import { capabilityProofKey } from "../../src/resume/capabilities.ts";
import { dispatch, handlers, type HarnessDeps } from "../../src/tools/handlers.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import type { SalesContractAdapter } from "../../src/versions/adapters/sales.ts";
import { handleOf } from "../unit/binding-fixtures.ts";
import { setRowsIn } from "../unit/resume-fixtures.ts";
import { executeWrites, mutatePage } from "../unit/target-fixtures.ts";
import { buildGtmRuntimeWorld, capabilityProofRow, G, REP_GTM, REP_GTM_INSTANCE, REP_GTM_KEY, REP_GTM_MAILBOX } from "./world.ts";

const T0 = new Date("2030-02-01T08:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const ctx = (seconds: number) => ({ principal_id: REP_GTM.principal_id, now: at(seconds) });
const rt = (value: string) => [{ type: "text" as const, text: { content: value }, plain_text: value }];

interface ChallengeView {
  challenge: string;
  capability: string;
  competent_source: string;
  issued_at: string;
  expires_at: string;
}

function pinVersionBySuffix(w: ReturnType<typeof buildGtmRuntimeWorld>, suffix: string): void {
  const version = w.deps.adapters.salesRuntime.supported().find((v) => v.endsWith(suffix));
  assert.ok(version, "no built-in non-GTM Sales line registered");
  const adapter = w.deps.adapters.salesRuntime.resolve(version) as SalesContractAdapter;
  const row = w.map.get(`page:${G.manifestRow}`) as Page;
  setRowsIn(w.map, G.manifestDs, [{
    ...row,
    properties: {
      ...row.properties,
      "Sales Contract Version": { type: "rich_text" as const, rich_text: rt(version) },
      "Schema Version": { type: "rich_text" as const, rich_text: rt(adapter.supportedSchemas[0] as string) },
    },
  }]);
  w.map.set(`page:${G.contractPage}`, { object: "page", id: G.contractPage, archived: false, properties: { title: { type: "title", title: rt(version) } } });
}

function pinBuiltin05(w: ReturnType<typeof buildGtmRuntimeWorld>): void {
  pinVersionBySuffix(w, "/0.5.0");
}

async function heldWorld() {
  const w = buildGtmRuntimeWorld();
  pinBuiltin05(w);
  w.setCapabilityProofs([]);
  const handle = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx(0), w.deps));
  const held = await dispatch("os_resume", { binding_handle: handle }, ctx(1), w.deps);
  assert.equal(held.code, "HOLD_REQUIRED_CAPABILITY_INCOMPLETE", JSON.stringify(held));
  const challenge = held.observations["capability_remediation"] as ChallengeView | undefined;
  assert.ok(challenge, "eligible Gmail HOLD must expose a bounded backend challenge");
  return { w, handle, held, challenge };
}

const evidence = (challenge: ChallengeView, patch: Partial<Record<"challenge" | "competent_source" | "source_identity" | "evidence_ref" | "verified_at", string>> = {}) => ({
  challenge: challenge.challenge,
  competent_source: challenge.competent_source,
  ...(challenge.competent_source === "GMAIL" ? { source_identity: REP_GTM_MAILBOX } : {}),
  evidence_ref: `${challenge.competent_source.toLowerCase()}-profile:fixture-rep-gtm`,
  verified_at: at(2).toISOString(),
  ...patch,
});

const candidateProof = (capability: "NOTION_RUNTIME_READ" | "GMAIL_READ") => capabilityProofRow({
  capability,
  source: capability === "NOTION_RUNTIME_READ" ? "NOTION" : "GMAIL",
  operatingMode: "GTM_OBSERVABILITY",
});

async function heldCandidateWorld(prior: Page[]) {
  const w = buildGtmRuntimeWorld();
  w.setCapabilityProofs(prior);
  const handle = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx(0), w.deps));
  const held = await dispatch("os_resume", { binding_handle: handle }, ctx(1), w.deps);
  assert.equal(held.code, "HOLD_REQUIRED_CAPABILITY_INCOMPLETE", JSON.stringify(held));
  const challenge = held.observations["capability_remediation"] as ChallengeView | undefined;
  assert.ok(challenge, "eligible candidate read HOLD must expose a bounded backend challenge");
  return { w, handle, held, challenge };
}

async function heldBridgeWorld(prior: Page[]) {
  const w = buildGtmRuntimeWorld();
  pinVersionBySuffix(w, "/0.5.2-candidate");
  w.setCapabilityProofs(prior);
  const handle = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx(0), w.deps));
  const held = await dispatch("os_resume", { binding_handle: handle }, ctx(1), w.deps);
  assert.equal(held.code, "HOLD_REQUIRED_CAPABILITY_INCOMPLETE", JSON.stringify(held));
  const challenge = held.observations["capability_remediation"] as ChallengeView | undefined;
  assert.ok(challenge, "eligible Calendar bridge HOLD must expose a bounded backend challenge");
  return { w, handle, held, challenge };
}

function payloadOf(token: string): Record<string, unknown> {
  const [, body] = token.split(".");
  assert.ok(body);
  return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
}

function resultOf(e: Envelope): Record<string, unknown> {
  assert.equal(e.status, "OK", JSON.stringify(e));
  return e.result as Record<string, unknown>;
}

test("PT-GTM-016/A: resume issues a ten-minute Gmail-only challenge with no public signing secret", async () => {
  const { held, challenge } = await heldWorld();
  assert.deepEqual({ capability: challenge.capability, source: challenge.competent_source }, { capability: "GMAIL_READ", source: "GMAIL" });
  assert.equal(Date.parse(challenge.expires_at) - Date.parse(challenge.issued_at), 10 * 60_000);
  assert.equal(held.next.permitted_tool_call, "os_prepare");
  const payload = payloadOf(challenge.challenge);
  assert.equal(payload["capability"], "GMAIL_READ");
  assert.equal(payload["competent_source"], "GMAIL");
  assert.equal(payload["accepted_state"], "READ_VERIFIED");
  assert.equal(payload["runtime_id"], REP_GTM_INSTANCE);
  assert.equal(typeof payload["runtime_generation"], "string");
  for (const secret of ["binding_id", "principal_id", "expected_source_identity", "handle_hash"]) assert.equal(secret in payload, false, `${secret} leaked in public challenge`);
});

test("PT-GTM-016/B: tamper, public-data forge, cross-binding, source, identity, TTL and XOR all fail closed without a plan", async () => {
  const { w, handle, challenge } = await heldWorld();
  const base = evidence(challenge);

  const [prefix, body] = challenge.challenge.split(".");
  assert.ok(prefix && body);
  const tamperedPayload: Record<string, unknown> = { ...payloadOf(challenge.challenge), capability: "GMAIL_SEND" };
  const tamperedBody = Buffer.from(JSON.stringify(tamperedPayload), "utf8").toString("base64url");
  const originalSignature = challenge.challenge.split(".")[2];
  assert.ok(originalSignature);
  assert.equal((await dispatch("os_prepare", { binding_handle: handle, capability_evidence: { ...base, challenge: `${prefix}.${tamperedBody}.${originalSignature}` } }, ctx(3), w.deps)).code, "HOLD_ACTION_NOT_AUTHORIZED");
  // Regression for the former forge: every public challenge field plus the public handle hash is still
  // insufficient because the signing key also contains a backend-only random binding id.
  const publicOnlyKey = `${String(tamperedPayload["binding_id"])}:${hashHandle(handle)}`;
  const forgedSignature = createHmac("sha256", publicOnlyKey).update(tamperedBody, "utf8").digest("base64url");
  const forged = `${prefix}.${tamperedBody}.${forgedSignature}`;
  assert.equal((await dispatch("os_prepare", { binding_handle: handle, capability_evidence: { ...base, challenge: forged } }, ctx(3), w.deps)).code, "HOLD_ACTION_NOT_AUTHORIZED");

  const otherHandle = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx(3), w.deps));
  assert.equal((await dispatch("os_prepare", { binding_handle: otherHandle, capability_evidence: base }, ctx(4), w.deps)).code, "HOLD_ACTION_NOT_AUTHORIZED");
  assert.equal((await dispatch("os_prepare", { binding_handle: handle, capability_evidence: evidence(challenge, { competent_source: "NOTION" }) }, ctx(4), w.deps)).code, "HOLD_REQUIRED_CAPABILITY_INCOMPLETE");
  assert.equal((await dispatch("os_prepare", { binding_handle: handle, capability_evidence: evidence(challenge, { source_identity: "other@example.invalid" }) }, ctx(4), w.deps)).code, "HOLD_MAILBOX_IDENTITY_MISMATCH");
  const { source_identity: _omitted, ...missingGmailIdentity } = base;
  assert.equal((await dispatch("os_prepare", { binding_handle: handle, capability_evidence: missingGmailIdentity }, ctx(4), w.deps)).code, "HOLD_MAILBOX_IDENTITY_MISMATCH");
  const { evidence_ref: _missingRef, ...missingReadEvidence } = base;
  assert.equal((await dispatch("os_prepare", { binding_handle: handle, capability_evidence: missingReadEvidence }, ctx(4), w.deps)).code, "ERROR_INVALID_ARGUMENT");
  assert.equal((await dispatch("os_prepare", { binding_handle: handle, capability_evidence: { ...base, evidence_ref: "" } }, ctx(4), w.deps)).code, "ERROR_INVALID_ARGUMENT");

  const mismatchedBackend: HarnessDeps = { ...w.deps, competentSource: new SnapshotCompetentSource("other@example.invalid", []) };
  assert.equal((await dispatch("os_prepare", { binding_handle: handle, capability_evidence: base }, ctx(4), mismatchedBackend)).code, "HOLD_MAILBOX_IDENTITY_MISMATCH");
  assert.equal((await dispatch("os_prepare", { binding_handle: handle, capability_evidence: base }, ctx(602), w.deps)).code, "HOLD_PLAN_EXPIRED");

  const rawIntent = {
    action_class: "COMMIT",
    summary: "forge proof",
    mutations: [{ logical_resource_key: "SALES:CAPABILITY_PROOFS", operation: "CREATE" as const, record_selector: { natural_key: "forged" }, desired_changes: { State: "READ_VERIFIED" } }],
  };
  assert.equal((await dispatch("os_prepare", { binding_handle: handle, intent: rawIntent }, ctx(4), w.deps)).code, "HOLD_ACTION_NOT_AUTHORIZED");
  assert.equal((await dispatch("os_prepare", { binding_handle: handle, intent: rawIntent, capability_evidence: base }, ctx(4), w.deps)).code, "ERROR_INVALID_ARGUMENT");
  assert.equal((await handlers.os_prepare({ binding_handle: handle, intent: rawIntent, capability_evidence: base }, ctx(4), w.deps)).code, "ERROR_INVALID_ARGUMENT", "handler defense-in-depth preserves XOR even when dispatch/schema are bypassed in-process");
  const generation = await heldGeneration(w, handle);
  assert.equal((await w.deps.store.plans.listByRuntime("VERTIGO", "SALES", generation)).length, 0);
  assert.equal(await w.deps.store.leases.current({ project: "VERTIGO", lane: "SALES", runtime_generation: generation }, at(4)), undefined, "refused raw or mixed proof creates no runtime lease");
  assert.equal((await w.deps.store.events.list({})).filter((event) => event.event_type === "PLAN_CREATED").length, 0);
});

test("PT-GTM-016/B2: a governing contract change invalidates the signed challenge without creating a plan", async () => {
  const { w, handle, challenge } = await heldWorld();
  pinVersionBySuffix(w, "/0.5.2-candidate");
  const out = await dispatch("os_prepare", { binding_handle: handle, capability_evidence: evidence(challenge) }, ctx(3), w.deps);
  assert.ok(["HOLD_BINDING_STALE", "HOLD_VERSION_CHANGED", "HOLD_CROSS_RUNTIME"].includes(out.code), JSON.stringify(out));
  assert.equal((await w.deps.store.events.list({})).filter((event) => event.event_type === "PLAN_CREATED").length, 0);
});

async function heldGeneration(w: ReturnType<typeof buildGtmRuntimeWorld>, handle: string): Promise<string> {
  const binding = await w.deps.store.bindings.findByHandleHash(hashHandle(handle));
  assert.ok(binding);
  return binding.runtime_generation;
}

test("PT-GTM-016/C: a challenge cannot manufacture a second proof after the capability is already complete", async () => {
  const { w, handle, challenge } = await heldWorld();
  w.setCapabilityProofs([capabilityProofRow({ capability: "GMAIL_READ", source: "GMAIL", operatingMode: "SALES_OPERATIONS" })]);
  const out = await dispatch("os_prepare", { binding_handle: handle, capability_evidence: evidence(challenge) }, ctx(3), w.deps);
  assert.equal(out.code, "HOLD_REQUIRED_CAPABILITY_INCOMPLETE");
  assert.equal((await w.deps.store.events.list({})).filter((event) => event.event_type === "PLAN_CREATED").length, 0);
});

test("PT-GTM-016/D: correct evidence deterministically derives one canonical proof, replays, and verifies end to end", async () => {
  const { w, handle, challenge } = await heldWorld();
  const deps: HarnessDeps = { ...w.deps, competentSource: new SnapshotCompetentSource(REP_GTM_MAILBOX, []) };
  const proofEvidence = evidence(challenge);
  const first = await dispatch("os_prepare", { binding_handle: handle, capability_evidence: proofEvidence }, ctx(3), deps);
  assert.equal(first.code, "PLAN_PREPARED", JSON.stringify(first));
  const firstResult = resultOf(first);
  assert.equal(firstResult["replayed"], false);
  const plan = await w.deps.store.plans.get(firstResult["plan_id"] as string) as Plan;
  assert.ok(plan);
  assert.equal(plan.operations.length, 1);
  const op = plan.operations[0]!;
  assert.equal(op.logical_resource_key, "SALES:CAPABILITY_PROOFS");
  assert.equal(op.operation, "CREATE");
  const notionVerifiedAt = at(0).toISOString();
  assert.notEqual(proofEvidence.verified_at, notionVerifiedAt, "fixture keeps source evidence at second precision");
  const expectedKey = capabilityProofKey({
    runtimeId: REP_GTM_INSTANCE,
    principalKey: REP_GTM_KEY,
    capability: "GMAIL_READ",
    operatingMode: "SALES_OPERATIONS",
    verifiedAt: notionVerifiedAt,
    evidenceRef: proofEvidence.evidence_ref,
  });
  assert.equal(op.natural_key, expectedKey);
  const desired = { ...op.expected_values };
  assert.equal(desired["Capability Proof Key"], expectedKey);
  delete desired["Capability Proof Key"];
  assert.deepEqual(desired, {
    "Capability Proof": "GMAIL_READ verified by GMAIL",
    "Capability Key": "GMAIL_READ",
    State: "READ_VERIFIED",
    "Runtime ID": REP_GTM_INSTANCE,
    "Principal Key": REP_GTM_KEY,
    "Operating Mode": "SALES_OPERATIONS",
    "Competent Source": "GMAIL",
    "Evidence Ref": proofEvidence.evidence_ref,
    "Verified At": notionVerifiedAt,
    Scope: `principal:${REP_GTM_KEY};runtime:${REP_GTM_INSTANCE};source:GMAIL;identity:${REP_GTM_MAILBOX};access:read`,
  }, "backend derives exactly the ten canonical proof fields with Notion-compatible minute precision");

  const replay = await dispatch("os_prepare", { binding_handle: handle, capability_evidence: proofEvidence }, ctx(4), deps);
  assert.equal(replay.code, "PLAN_PREPARED", JSON.stringify(replay));
  assert.equal(resultOf(replay)["plan_id"], plan.plan_id);
  assert.equal(resultOf(replay)["replayed"], true);
  assert.equal((await w.deps.store.events.list({})).filter((event) => event.event_type === "PLAN_CREATED").length, 1);

  const symbols = executeWrites(w, plan.stage1_writes, plan.plan_id, { now: at(5).toISOString() });
  const target = await dispatch("os_verify", { binding_handle: handle, plan_id: plan.plan_id, phase: "TARGET" }, ctx(6), deps);
  assert.equal(target.code, "TARGET_VERIFIED", JSON.stringify(target));
  const targetResult = resultOf(target);
  const verifiedSymbols = (target.observations["symbols"] as Record<string, string> | undefined) ?? symbols;
  executeWrites(w, plan.finalization_writes, plan.plan_id, { ...({ now: at(7).toISOString() }), created: verifiedSymbols, target_receipt_id: targetResult["target_receipt_id"] as string });
  executeWrites(w, [plan.state_last_write], plan.plan_id, { ...({ now: at(8).toISOString() }), created: verifiedSymbols, target_receipt_id: targetResult["target_receipt_id"] as string });
  const final = await dispatch("os_verify", { binding_handle: handle, plan_id: plan.plan_id, phase: "FINAL" }, ctx(9), deps);
  assert.equal(final.code, "TRANSACTION_VERIFIED", JSON.stringify(final));

  const resumed = await dispatch("os_resume", { binding_handle: handle }, ctx(10), deps);
  assert.equal(resumed.code, "RESUMED", JSON.stringify(resumed));
  const complete = resultOf(resumed)["capability_completeness"] as { complete: boolean; required_verified: number };
  assert.equal(complete.complete, true);
  assert.equal(complete.required_verified, 1);
  assert.equal(w.rows(G.capabilityDs).filter((row) => JSON.stringify(row).includes("GMAIL_READ")).length, 1);
});

test("PT-GTM-016/E: candidate 0.6 challenges REQUIRED reads in deterministic Notion, Gmail, Calendar order", async () => {
  const notion = await heldCandidateWorld([]);
  assert.deepEqual({ capability: notion.challenge.capability, source: notion.challenge.competent_source }, { capability: "NOTION_RUNTIME_READ", source: "NOTION" });

  const gmail = await heldCandidateWorld([candidateProof("NOTION_RUNTIME_READ")]);
  assert.deepEqual({ capability: gmail.challenge.capability, source: gmail.challenge.competent_source }, { capability: "GMAIL_READ", source: "GMAIL" });

  const calendar = await heldCandidateWorld([candidateProof("NOTION_RUNTIME_READ"), candidateProof("GMAIL_READ")]);
  assert.deepEqual({ capability: calendar.challenge.capability, source: calendar.challenge.competent_source }, { capability: "CALENDAR_READ", source: "GOOGLE_CALENDAR" });
});

test("PT-GTM-016/E2: 0.5.2 bridge challenges Gmail then Calendar without Notion or GTM resources", async () => {
  const gmail = await heldBridgeWorld([]);
  assert.deepEqual({ capability: gmail.challenge.capability, source: gmail.challenge.competent_source }, { capability: "GMAIL_READ", source: "GMAIL" });

  const calendar = await heldBridgeWorld([capabilityProofRow({ capability: "GMAIL_READ", source: "GMAIL", operatingMode: "SALES_OPERATIONS" })]);
  assert.deepEqual({ capability: calendar.challenge.capability, source: calendar.challenge.competent_source }, { capability: "CALENDAR_READ", source: "GOOGLE_CALENDAR" });
  const adapter = calendar.w.deps.adapters.salesRuntime.resolve(calendar.w.deps.adapters.salesRuntime.supported().find((v) => v.endsWith("/0.5.2-candidate")) as string) as SalesContractAdapter;
  assert.equal(adapter.capabilities.gtm, false);
  assert.equal(adapter.capabilities.operatingModeRequirements?.["SALES_OPERATIONS"]?.some((r) => r.capability === "NOTION_RUNTIME_READ"), false);
  assert.deepEqual(Object.keys(adapter.grammar.controlPlane.resources ?? {}).sort(), ["SALES:CAPABILITY_PROOFS", "SALES:EXTERNAL_ACTIONS", "SALES:INSTALL_MANIFEST", "SALES:INSTALL_REGISTRY"].sort());
});

test("PT-GTM-016/F: Calendar native evidence needs no fabricated internal identity and completes the 0.5.2 profile", async () => {
  const gmailProof = capabilityProofRow({ capability: "GMAIL_READ", source: "GMAIL", operatingMode: "SALES_OPERATIONS" });
  const { w, handle, challenge } = await heldBridgeWorld([gmailProof]);
  const calendarEvidence = evidence(challenge, { evidence_ref: "google-calendar:fixture-primary/read" });
  assert.equal("source_identity" in calendarEvidence, false, "Calendar native evidence does not invent the backend principal key");
  const externalActionsBefore = JSON.stringify(w.rows(G.extDs));
  const prepared = await dispatch("os_prepare", { binding_handle: handle, capability_evidence: calendarEvidence }, ctx(3), w.deps);
  assert.equal(prepared.code, "PLAN_PREPARED", JSON.stringify(prepared));
  const preparedResult = resultOf(prepared);
  const plan = await w.deps.store.plans.get(preparedResult["plan_id"] as string) as Plan;
  assert.ok(plan);
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0]?.expected_values["Capability Key"], "CALENDAR_READ");
  assert.equal(plan.operations[0]?.expected_values["Competent Source"], "GOOGLE_CALENDAR");
  assert.match(String(plan.operations[0]?.expected_values["Scope"]), new RegExp(`identity:${REP_GTM_KEY}`));
  assert.match(String(plan.operations[0]?.expected_values["Scope"]), /access:read/);
  assert.ok(plan.operations.every((operation) => operation.logical_resource_key === "SALES:CAPABILITY_PROOFS" && operation.operation === "CREATE"), "Calendar remediation can append only a proof, never create/update/delete an event");
  assert.equal(JSON.stringify(w.rows(G.extDs)), externalActionsBefore, "Calendar remediation creates no external action or event mutation");

  const symbols = executeWrites(w, plan.stage1_writes, plan.plan_id, { now: at(5).toISOString() });
  const target = await dispatch("os_verify", { binding_handle: handle, plan_id: plan.plan_id, phase: "TARGET" }, ctx(6), w.deps);
  assert.equal(target.code, "TARGET_VERIFIED", JSON.stringify(target));
  const targetResult = resultOf(target);
  const verifiedSymbols = (target.observations["symbols"] as Record<string, string> | undefined) ?? symbols;
  executeWrites(w, plan.finalization_writes, plan.plan_id, { ...({ now: at(7).toISOString() }), created: verifiedSymbols, target_receipt_id: targetResult["target_receipt_id"] as string });
  executeWrites(w, [plan.state_last_write], plan.plan_id, { ...({ now: at(8).toISOString() }), created: verifiedSymbols, target_receipt_id: targetResult["target_receipt_id"] as string });
  const final = await dispatch("os_verify", { binding_handle: handle, plan_id: plan.plan_id, phase: "FINAL" }, ctx(9), w.deps);
  assert.equal(final.code, "TRANSACTION_VERIFIED", JSON.stringify(final));

  const resumed = await dispatch("os_resume", { binding_handle: handle }, ctx(10), w.deps);
  assert.equal(resumed.code, "RESUMED", JSON.stringify(resumed));
  const complete = resultOf(resumed)["capability_completeness"] as { complete: boolean; required_verified: number };
  assert.deepEqual({ complete: complete.complete, required_verified: complete.required_verified }, { complete: true, required_verified: 2 });
});

test("PT-GTM-016/G: Calendar rejects wrong source but never trusts a caller identity for its proof scope", async () => {
  const gmailProof = capabilityProofRow({ capability: "GMAIL_READ", source: "GMAIL", operatingMode: "SALES_OPERATIONS" });
  const { w, handle, challenge } = await heldBridgeWorld([gmailProof]);
  const wrongSource = await dispatch("os_prepare", { binding_handle: handle, capability_evidence: evidence(challenge, { competent_source: "GMAIL" }) }, ctx(3), w.deps);
  assert.equal(wrongSource.code, "HOLD_REQUIRED_CAPABILITY_INCOMPLETE");
  const generation = await heldGeneration(w, handle);
  assert.equal((await w.deps.store.plans.listByRuntime("VERTIGO", "SALES", generation)).length, 0);

  const prepared = await dispatch("os_prepare", { binding_handle: handle, capability_evidence: evidence(challenge, { source_identity: "external-calendar@example.invalid" }) }, ctx(4), w.deps);
  assert.equal(prepared.code, "PLAN_PREPARED", JSON.stringify(prepared));
  const plan = await w.deps.store.plans.get(resultOf(prepared)["plan_id"] as string) as Plan;
  assert.match(String(plan.operations[0]?.expected_values["Scope"]), new RegExp(`identity:${REP_GTM_KEY}`));
  assert.doesNotMatch(String(plan.operations[0]?.expected_values["Scope"]), /external-calendar@example\.invalid/, "caller identity never controls Calendar proof scope");
});

test("PT-GTM-016/H: Notion evidence keeps second-precise validation but persists a minute-canonical proof and key", async () => {
  const { w, handle, challenge } = await heldCandidateWorld([]);
  const notionEvidence = evidence(challenge, { evidence_ref: "notion:fixture-runtime/read", verified_at: at(2).toISOString() });
  const prepared = await dispatch("os_prepare", { binding_handle: handle, capability_evidence: notionEvidence }, ctx(3), w.deps);
  assert.equal(prepared.code, "PLAN_PREPARED", JSON.stringify(prepared));
  const plan = await w.deps.store.plans.get(resultOf(prepared)["plan_id"] as string) as Plan;
  assert.ok(plan);
  const expectedVerifiedAt = at(0).toISOString();
  const expectedKey = capabilityProofKey({
    runtimeId: REP_GTM_INSTANCE,
    principalKey: REP_GTM_KEY,
    capability: "NOTION_RUNTIME_READ",
    operatingMode: "GTM_OBSERVABILITY",
    verifiedAt: expectedVerifiedAt,
    evidenceRef: notionEvidence.evidence_ref,
  });
  assert.equal(plan.operations[0]?.expected_values["Verified At"], expectedVerifiedAt);
  assert.equal(plan.operations[0]?.natural_key, expectedKey);
  assert.equal(plan.operations[0]?.expected_values["Capability Proof Key"], expectedKey);
});

test("PT-GTM-016/I: an expired legacy Gmail proof whose Verified At was rounded by Notion recovers without duplicate or update", async () => {
  const { w, handle, challenge } = await heldWorld();
  const deps: HarnessDeps = { ...w.deps, competentSource: new SnapshotCompetentSource(REP_GTM_MAILBOX, []) };
  const prepared = await dispatch("os_prepare", { binding_handle: handle, capability_evidence: evidence(challenge) }, ctx(3), deps);
  assert.equal(prepared.code, "PLAN_PREPARED", JSON.stringify(prepared));
  const plan = await w.deps.store.plans.get(resultOf(prepared)["plan_id"] as string) as Plan;
  const legacyVerifiedAt = "2030-02-01T08:00:30.000Z";
  const legacyKey = capabilityProofKey({ runtimeId: REP_GTM_INSTANCE, principalKey: REP_GTM_KEY, capability: "GMAIL_READ", operatingMode: "SALES_OPERATIONS", verifiedAt: legacyVerifiedAt, evidenceRef: evidence(challenge).evidence_ref });
  const legacyPlan: Plan = {
    ...plan,
    operations: plan.operations.map((op) => ({ ...op, natural_key: legacyKey, expected_values: { ...op.expected_values, "Capability Proof Key": legacyKey, "Verified At": legacyVerifiedAt } })),
    stage1_writes: plan.stage1_writes.map((write) => write.purpose === "WRITE_TARGET" ? { ...write, fields: { ...write.fields, "Capability Proof Key": legacyKey } } : write),
  };
  await w.deps.store.plans.insert(legacyPlan);
  executeWrites(w, legacyPlan.stage1_writes, legacyPlan.plan_id, { now: at(5).toISOString() });
  const proofBefore = JSON.stringify(w.rows(G.capabilityDs));

  const coldHandle = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx(904), deps));
  const opened = await dispatch("os_verify", { binding_handle: coldHandle, plan_id: legacyPlan.plan_id, phase: "TARGET" }, ctx(905), deps);
  assert.equal(opened.code, "PLAN_PREPARED", JSON.stringify(opened));
  const recovery = await w.deps.store.plans.get(resultOf(opened)["plan_id"] as string) as Plan;
  assert.equal(recovery.run_mode, "RECOVER_EXISTING");
  assert.ok(!recovery.stage1_writes.some((write) => write.purpose === "WRITE_TARGET"), "same UTC minute is observed as the existing target, never rewritten");
  executeWrites(w, recovery.stage1_writes, recovery.plan_id, { now: at(906).toISOString() });
  const target = await dispatch("os_verify", { binding_handle: coldHandle, plan_id: recovery.plan_id, phase: "TARGET" }, ctx(907), deps);
  assert.equal(target.code, "TARGET_VERIFIED", JSON.stringify(target));
  const targetResult = resultOf(target);
  const symbols = target.observations["symbols"] as Record<string, string>;
  executeWrites(w, recovery.finalization_writes, recovery.plan_id, { ...({ now: at(908).toISOString() }), created: symbols, target_receipt_id: targetResult["target_receipt_id"] as string });
  executeWrites(w, [recovery.state_last_write], recovery.plan_id, { ...({ now: at(909).toISOString() }), created: symbols, target_receipt_id: targetResult["target_receipt_id"] as string });
  assert.equal((await dispatch("os_verify", { binding_handle: coldHandle, plan_id: recovery.plan_id, phase: "FINAL" }, ctx(910), deps)).code, "TRANSACTION_VERIFIED");
  assert.equal(JSON.stringify(w.rows(G.capabilityDs)), proofBefore, "recovery neither duplicates nor updates the legacy proof row");
});

test("PT-GTM-016/J: the minute exception does not hide any other capability-proof divergence", async () => {
  const { w, handle, challenge } = await heldWorld();
  const deps: HarnessDeps = { ...w.deps, competentSource: new SnapshotCompetentSource(REP_GTM_MAILBOX, []) };
  const prepared = await dispatch("os_prepare", { binding_handle: handle, capability_evidence: evidence(challenge) }, ctx(3), deps);
  const plan = await w.deps.store.plans.get(resultOf(prepared)["plan_id"] as string) as Plan;
  const legacyVerifiedAt = "2030-02-01T08:00:30.000Z";
  const legacyKey = capabilityProofKey({ runtimeId: REP_GTM_INSTANCE, principalKey: REP_GTM_KEY, capability: "GMAIL_READ", operatingMode: "SALES_OPERATIONS", verifiedAt: legacyVerifiedAt, evidenceRef: evidence(challenge).evidence_ref });
  const legacyPlan: Plan = {
    ...plan,
    operations: plan.operations.map((op) => ({ ...op, natural_key: legacyKey, expected_values: { ...op.expected_values, "Capability Proof Key": legacyKey, "Verified At": legacyVerifiedAt } })),
    stage1_writes: plan.stage1_writes.map((write) => write.purpose === "WRITE_TARGET" ? { ...write, fields: { ...write.fields, "Capability Proof Key": legacyKey } } : write),
  };
  await w.deps.store.plans.insert(legacyPlan);
  const created = executeWrites(w, legacyPlan.stage1_writes, legacyPlan.plan_id, { now: at(5).toISOString() });
  mutatePage(w, created["TARGET_0"] as string, { Scope: "principal:other;runtime:other;source:GMAIL;identity:other;access:read" }, at(6).toISOString());
  const coldHandle = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx(904), deps));
  const blocked = await dispatch("os_verify", { binding_handle: coldHandle, plan_id: legacyPlan.plan_id, phase: "TARGET" }, ctx(905), deps);
  assert.equal(blocked.code, "HOLD_CONFLICT", JSON.stringify(blocked));
});
