/** PT-GTM-015 — self-onboarding REQUIRED capability completeness on ordinary SALES resume. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { capabilityProofKey } from "../../src/resume/capabilities.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import type { Page } from "../../src/notion/shapes.ts";
import type { SalesContractAdapter } from "../../src/versions/adapters/sales.ts";
import { setRowsIn } from "../unit/resume-fixtures.ts";
import { buildGtmRuntimeWorld, capabilityProofRow, G, REP_GTM_INSTANCE, REP_GTM_KEY } from "./world.ts";
import { bindRep, gtmIntent, OWNER_FIELDS, prepare, resume, target } from "./drive.ts";

const required = () => [
  capabilityProofRow({ capability: "NOTION_RUNTIME_READ", source: "NOTION" }),
  capabilityProofRow({ capability: "GMAIL_READ", source: "GMAIL" }),
  capabilityProofRow({ capability: "CALENDAR_READ", source: "GOOGLE_CALENDAR" }),
];
const optionalPending = () => capabilityProofRow({ capability: "MAIL_TRACKER_READ", source: "MAIL_TRACKER", state: "HUMAN_AUTH_PENDING" });
const completeness = (e: Envelope) => e.observations["capability_completeness"] as {
  complete: boolean; required_total: number; required_verified: number; incomplete_required: string[];
  next_human_action: string; comparisons: Array<{ capability: string; requirement: string; state: string; satisfied: boolean }>;
};

const rt = (value: string) => [{ type: "text" as const, text: { content: value }, plain_text: value }];

function pinBuiltin05(w: ReturnType<typeof buildGtmRuntimeWorld>): void {
  const version = w.deps.adapters.salesRuntime.supported().find((v) => v.endsWith("/0.5.0"));
  assert.ok(version, "no built-in non-GTM Sales line registered");
  pinVersion(w, version);
}

function pinVersion(w: ReturnType<typeof buildGtmRuntimeWorld>, version: string): void {
  const adapter = w.deps.adapters.salesRuntime.resolve(version) as SalesContractAdapter;
  const row = w.map.get(`page:${G.manifestRow}`) as Page;
  const properties = {
    ...row.properties,
    "Sales Contract Version": { type: "rich_text" as const, rich_text: rt(version) },
    "Schema Version": { type: "rich_text" as const, rich_text: rt(adapter.supportedSchemas[0] as string) },
  };
  setRowsIn(w.map, G.manifestDs, [{ ...row, properties }]);
  w.map.set(`page:${G.contractPage}`, { object: "page", id: G.contractPage, archived: false, properties: { title: { type: "title", title: rt(version) } } });
}

function withNotionDateSpelling(page: Page, start: string): Page {
  return { ...page, properties: { ...page.properties, "Verified At": { type: "date", date: { start } } } };
}

test("PT-GTM-015/versions: 0.5.1 needs Gmail, 0.5.2 needs Gmail then Calendar, and 0.6 keeps the GTM triple", async () => {
  const adapters = buildGtmRuntimeWorld().deps.adapters.salesRuntime;
  const lines = adapters.supported();
  const install = lines.find((v) => v.endsWith("/0.5.1-candidate"));
  const bridge = lines.find((v) => v.endsWith("/0.5.2-candidate"));
  const gtm = lines.find((v) => (adapters.resolve(v) as SalesContractAdapter | undefined)?.capabilities.gtm);
  assert.ok(install && bridge && gtm);

  const expectations: Array<[string, string[], string]> = [
    [install, ["GMAIL_READ"], "SALES_OPERATIONS"],
    [bridge, ["GMAIL_READ", "CALENDAR_READ"], "SALES_OPERATIONS"],
    [gtm, ["NOTION_RUNTIME_READ", "GMAIL_READ", "CALENDAR_READ"], "GTM_OBSERVABILITY"],
  ];
  for (const [version, expected, mode] of expectations) {
    const adapter = adapters.resolve(version) as SalesContractAdapter;
    assert.deepEqual(adapter.capabilities.operatingModeRequirements?.[mode]?.filter((r) => r.requirement === "REQUIRED").map((r) => r.capability), expected);
  }
});

test("PT-GTM-015/live-date: equivalent Notion UTC spelling preserves immutable capability provenance", async () => {
  const w = buildGtmRuntimeWorld();
  const bridge = w.deps.adapters.salesRuntime.supported().find((v) => v.endsWith("/0.5.2-candidate"));
  assert.ok(bridge);
  pinVersion(w, bridge);

  const gmail = capabilityProofRow({
    capability: "GMAIL_READ", source: "GMAIL", operatingMode: "SALES_OPERATIONS",
    verifiedAt: "2030-01-02T08:00:00.000Z", evidenceRef: "gmail:message:live-shape",
  });
  w.setCapabilityProofs([withNotionDateSpelling(gmail, "2030-01-02T08:00:00.000+00:00")]);

  const held = await resume(w, await bindRep(w));
  assert.equal(held.envelope.code, "HOLD_REQUIRED_CAPABILITY_INCOMPLETE");
  const c = completeness(held.envelope);
  assert.equal(c.comparisons.find((x) => x.capability === "GMAIL_READ")?.state, "READ_VERIFIED");
  assert.deepEqual(c.incomplete_required, ["CALENDAR_READ"]);
});

test("PT-GTM-015/live-date-negative: a different instant still invalidates immutable capability provenance", async () => {
  const w = buildGtmRuntimeWorld();
  const bridge = w.deps.adapters.salesRuntime.supported().find((v) => v.endsWith("/0.5.2-candidate"));
  assert.ok(bridge);
  pinVersion(w, bridge);

  const gmail = capabilityProofRow({
    capability: "GMAIL_READ", source: "GMAIL", operatingMode: "SALES_OPERATIONS",
    verifiedAt: "2030-01-02T08:00:00.000Z", evidenceRef: "gmail:message:live-shape",
  });
  w.setCapabilityProofs([withNotionDateSpelling(gmail, "2030-01-02T08:01:00.000+00:00")]);

  const held = await resume(w, await bindRep(w));
  assert.equal(held.envelope.code, "HOLD_REQUIRED_CAPABILITY_INCOMPLETE");
  assert.equal(completeness(held.envelope).comparisons.find((x) => x.capability === "GMAIL_READ")?.state, "ERROR");
});

test("PT-GTM-015/0.5: Gmail is REQUIRED on ordinary BUSINESS resume, independently of GTM adoption", async () => {
  const w = buildGtmRuntimeWorld();
  pinBuiltin05(w);
  w.setCapabilityProofs([]);
  const handle = await bindRep(w);
  const held = await resume(w, handle);
  assert.equal(held.envelope.code, "HOLD_REQUIRED_CAPABILITY_INCOMPLETE", JSON.stringify(held.envelope));
  assert.deepEqual(completeness(held.envelope).incomplete_required, ["GMAIL_READ"]);
  assert.match(completeness(held.envelope).next_human_action, /Gmail/i);
  assert.match(String(held.envelope.say), /Connectez la boîte Gmail/i, "the canonical user sentence must expose the next human action");
  assert.doesNotMatch(String(held.envelope.say), /HOLD_|GMAIL_READ|runtime|principal|MCP/i);

  const verifiedAt = "2030-02-01T08:00:00+01:00";
  const evidenceRef = "fixture://not-gmail/readback";
  const key = capabilityProofKey({ runtimeId: REP_GTM_INSTANCE, principalKey: REP_GTM_KEY, capability: "GMAIL_READ", operatingMode: "SALES_OPERATIONS", verifiedAt, evidenceRef });
  const forged = await prepare(w, handle, gtmIntent("SALES:CAPABILITY_PROOFS", key, {
    "Capability Proof": "claimed Gmail read", "Capability Key": "GMAIL_READ", State: "READ_VERIFIED",
    "Runtime ID": REP_GTM_INSTANCE, "Principal Key": REP_GTM_KEY, "Operating Mode": "SALES_OPERATIONS",
    "Competent Source": "NOTION", "Evidence Ref": evidenceRef, "Verified At": verifiedAt,
    Scope: `principal:${REP_GTM_KEY};runtime:${REP_GTM_INSTANCE};access:read`,
  }));
  assert.equal(forged.envelope.code, "HOLD_ACTION_NOT_AUTHORIZED", "0.5 accepted a caller-built capability proof");

  w.setCapabilityProofs([capabilityProofRow({ capability: "GMAIL_READ", source: "GMAIL", operatingMode: "SALES_OPERATIONS" })]);
  const resumed = await resume(w, handle);
  assert.equal(resumed.envelope.code, "RESUMED", JSON.stringify(resumed.envelope));
  assert.equal((resumed.payload["capability_completeness"] as { complete: boolean }).complete, true);
});

test("PT-GTM-015/A: an ordinary cold/resumed SALES chat discovers a missing REQUIRED capability and asks the seller itself", async () => {
  const w = buildGtmRuntimeWorld();
  w.setCapabilityProofs([...required().filter((r) => !JSON.stringify(r).includes("CALENDAR_READ")), optionalPending()]);
  const handle = await bindRep(w);

  // The user has said only the ordinary phrase “on continue”; os_resume has no admin/capability override input.
  const out = await resume(w, handle);
  assert.equal(out.envelope.code, "HOLD_REQUIRED_CAPABILITY_INCOMPLETE");
  assert.equal(out.envelope.status, "HOLD");
  assert.match(String(out.envelope.say), /autorisations indispensables/i);
  assert.match(String(out.envelope.say), /Connectez votre Google Calendar/i, "the cold chat must not hide the contract-derived action behind a generic hold");
  assert.match(String(out.envelope.next.safe_action), /Connectez votre Google Calendar/i);
  assert.doesNotMatch(String(out.envelope.next.safe_action), /admin|prompt|identifiant|MCP|technique/i);
  assert.deepEqual(completeness(out.envelope).incomplete_required, ["CALENDAR_READ"]);
  assert.equal(completeness(out.envelope).required_verified, 2);
  assert.equal(out.payload["gate"] && (out.payload["gate"] as { gate_key: string }).gate_key, "B2_ICP");
  assert.equal((await w.deps.store.plans.listByRuntime("VERTIGO", "SALES", (out.envelope.binding as { runtime_generation: string }).runtime_generation)).length, 0);
});

test("PT-GTM-015/B: UNKNOWN, HUMAN_AUTH_PENDING, PARTIAL and ERROR all fail closed", async () => {
  for (const state of ["UNKNOWN", "HUMAN_AUTH_PENDING", "PARTIAL", "ERROR"] as const) {
    const w = buildGtmRuntimeWorld();
    w.setCapabilityProofs([
      ...required().filter((r) => !JSON.stringify(r).includes("CALENDAR_READ")),
      capabilityProofRow({ capability: "CALENDAR_READ", source: "GOOGLE_CALENDAR", state }),
    ]);
    const out = await resume(w, await bindRep(w));
    assert.equal(out.envelope.code, "HOLD_REQUIRED_CAPABILITY_INCOMPLETE", state);
    const calendar = completeness(out.envelope).comparisons.find((c) => c.capability === "CALENDAR_READ");
    assert.equal(calendar?.state, state);
    assert.equal(calendar?.satisfied, false);
  }
});

test("PT-GTM-015/C: an OPTIONAL capability is visible but never creates the global HOLD", async () => {
  for (const optional of [undefined, optionalPending()]) {
    const w = buildGtmRuntimeWorld();
    w.setCapabilityProofs([...required(), ...(optional ? [optional] : [])]);
    const out = await resume(w, await bindRep(w));
    assert.equal(out.envelope.code, "RESUMED");
    const c = (out.payload["capability_completeness"] ?? out.envelope.observations["capability_completeness"]) as ReturnType<typeof completeness>;
    assert.equal(c.complete, true);
    assert.equal(c.required_total, 3);
    assert.equal(c.required_verified, 3);
  }
});

test("PT-GTM-015/D: dependent business work remains blocked and a raw proof intent is refused", async () => {
  const w = buildGtmRuntimeWorld();
  w.setCapabilityProofs(required().filter((r) => !JSON.stringify(r).includes("CALENDAR_READ")));
  const handle = await bindRep(w);
  const business = await prepare(w, handle, gtmIntent("SALES:CAMPAIGNS", "CMP-BLOCKED", { ...OWNER_FIELDS, "Configured Offer": "OFFER-X" }));
  assert.equal(business.envelope.code, "HOLD_REQUIRED_CAPABILITY_INCOMPLETE");
  assert.equal(business.plan, undefined);

  const verifiedAt = "2030-02-01T09:00:00+01:00";
  const evidenceRef = "fixture://google-calendar/readback/pt-gtm-015";
  const key = capabilityProofKey({ runtimeId: REP_GTM_INSTANCE, principalKey: REP_GTM_KEY, capability: "CALENDAR_READ", operatingMode: "GTM_OBSERVABILITY", verifiedAt, evidenceRef });
  const proof = gtmIntent("SALES:CAPABILITY_PROOFS", key, {
    "Capability Proof": "Calendar read verified", "Capability Key": "CALENDAR_READ", State: "READ_VERIFIED",
    "Runtime ID": REP_GTM_INSTANCE, "Principal Key": REP_GTM_KEY, "Operating Mode": "GTM_OBSERVABILITY",
    "Competent Source": "GOOGLE_CALENDAR", "Evidence Ref": evidenceRef, "Verified At": verifiedAt,
    Scope: `principal:${REP_GTM_KEY};runtime:${REP_GTM_INSTANCE};calendar:primary;access:read`,
  });
  const remediation = await prepare(w, handle, proof);
  assert.equal(remediation.envelope.code, "HOLD_ACTION_NOT_AUTHORIZED", JSON.stringify(remediation.envelope));
  assert.equal(remediation.plan, undefined);
  assert.equal((await w.deps.store.events.list({})).filter((e) => e.event_type === "PLAN_CREATED").length, 0);
});

test("PT-GTM-015/E: verified proof persists and resume returns to the exact previous gate without replaying setup", async () => {
  const w = buildGtmRuntimeWorld();
  const beforeCampaigns = w.rows(G.campaignsDs).map((r) => r.id);
  const beforeVersions = w.rows(G.versionsDs).map((r) => r.id);
  w.setCapabilityProofs(required().filter((r) => !JSON.stringify(r).includes("CALENDAR_READ")));
  const handle = await bindRep(w);
  const held = await resume(w, handle);
  assert.equal(held.envelope.code, "HOLD_REQUIRED_CAPABILITY_INCOMPLETE");
  assert.equal((held.payload["gate"] as { gate_key: string }).gate_key, "B2_ICP");

  w.setCapabilityProofs(required());

  const resumed = await resume(w, handle);
  assert.equal(resumed.envelope.code, "RESUMED", JSON.stringify(resumed.envelope));
  const c = resumed.payload["capability_completeness"] as ReturnType<typeof completeness>;
  assert.equal(c.complete, true);
  assert.equal(c.required_verified, 3);
  assert.equal((resumed.payload["gate"] as { gate_key: string }).gate_key, "B2_ICP");
  assert.deepEqual(w.rows(G.campaignsDs).map((r) => r.id), beforeCampaigns, "durable business setup is not replayed");
  assert.deepEqual(w.rows(G.versionsDs).map((r) => r.id), beforeVersions, "approach setup is not replayed");
  assert.equal(w.rows(G.capabilityDs).filter((r) => JSON.stringify(r).includes("CALENDAR_READ")).length, 1, "one append-only proof");
});

test("PT-GTM-015/F: a newly REQUIRED gap blocks active-plan replay and TARGET blessing", async () => {
  const w = buildGtmRuntimeWorld();
  const handle = await bindRep(w);
  const intent = gtmIntent("SALES:CAMPAIGNS", "CMP-PRE-ADOPTION", { ...OWNER_FIELDS, "Configured Offer": "OFFER-X" });
  const first = await prepare(w, handle, intent);
  assert.equal(first.envelope.code, "PLAN_PREPARED");

  w.setCapabilityProofs(required().filter((r) => !JSON.stringify(r).includes("CALENDAR_READ")));
  const replay = await prepare(w, handle, intent);
  assert.equal(replay.envelope.code, "HOLD_REQUIRED_CAPABILITY_INCOMPLETE", "an active business plan is not replayed across the capability gap");

  const verified = await target(w, handle, first.plan!);
  assert.equal(verified.envelope.code, "HOLD_REQUIRED_CAPABILITY_INCOMPLETE", "a pre-existing business plan receives no TARGET receipt");
  assert.equal((await w.deps.store.receipts.findByPlan(first.plan!.plan_id, "TARGET")).length, 0);
});

test("PT-GTM-015/G: a newer wrong-source proof invalidates the older good proof instead of being ignored", async () => {
  const w = buildGtmRuntimeWorld();
  w.setCapabilityProofs([
    ...required(),
    capabilityProofRow({ capability: "CALENDAR_READ", source: "GMAIL", verifiedAt: "2030-03-01T09:00:00+01:00", evidenceRef: "fixture://wrong-source" }),
  ]);
  const out = await resume(w, await bindRep(w));
  assert.equal(out.envelope.code, "HOLD_REQUIRED_CAPABILITY_INCOMPLETE");
  const calendar = completeness(out.envelope).comparisons.find((c) => c.capability === "CALENDAR_READ");
  assert.equal(calendar?.state, "ERROR");
  assert.equal(calendar?.satisfied, false);
});
