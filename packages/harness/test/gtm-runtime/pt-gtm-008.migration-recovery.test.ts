/**
 * PT-GTM-008 — migration, interruption, unknown history, version change and isolation, through the real six-tool
 * protocol (PV-GTM-002). Evidence candidates only: no PT case is marked PASS here.
 *
 * A: rows written under an older shape keep their identity, owner and history when the candidate reads them.
 * B: an interruption after the write and before the receipt is recovered by exact lookup, never duplicated.
 * C: a missing historical price or campaign stays UNKNOWN and is never filled from today's configuration.
 * D: a governing version change holds the dependent action without destroying anything; the events survive.
 * E: the candidate is per runtime (a canary), and a concurrent writer holds.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../../src/tools/handlers.ts";
import type { Plan } from "../../src/plans/store.ts";
import { gtmCapableVersions, type SalesContractAdapter } from "../../src/versions/adapters/sales.ts";
import { handleOf } from "../unit/binding-fixtures.ts";
import { executeWrites } from "../unit/target-fixtures.ts";
import { buildGtmRuntimeWorld, G, gtmRow, GTM_SCHEMAS, REP_GTM_INSTANCE, REP_GTM_KEY } from "./world.ts";
import { bindRep, commit, evidenceOf, exposureIntent, finalize, gtmIntent, OWNER_FIELDS, prepare, REP_CTX, target } from "./drive.ts";
import { synthetic } from "../unit/meta-fixtures.ts";

const textOf = (page: { properties: Record<string, unknown> }, prop: string): string =>
  ((page.properties[prop] as { rich_text?: Array<{ plain_text: string }> } | undefined)?.rich_text?.[0]?.plain_text) ?? "";

test("PT-GTM-008/A: rows written under an older shape keep identity, owner and history", async () => {
  const w = buildGtmRuntimeWorld();
  // An older shape: a campaign and an enrollment carrying only the fields that existed then.
  w.setRows(G.campaignsDs, [
    ...w.rows(G.campaignsDs),
    gtmRow(synthetic("legacy-campaign"), "Campaign", "CMP-LEGACY", { "Campaign Key": "CMP-LEGACY", "Owner Rep": REP_GTM_KEY, "Runtime ID": REP_GTM_INSTANCE, Status: "ACTIVE" }, GTM_SCHEMAS.campaigns),
  ]);
  w.setRows(G.enrollmentsDs, [
    gtmRow(synthetic("legacy-enrollment"), "Enrollment", "ENR-LEGACY", { "Enrollment Key": "ENR-LEGACY", Campaign: "CMP-LEGACY", Contact: "C-LEGACY", State: "ENDED", "Ended At": "2026-08-01T09:00:00+02:00" }, GTM_SCHEMAS.enrollments),
  ]);
  const h = await bindRep(w);

  // New work happens beside the legacy rows; nothing is rewritten and the legacy identity is preserved.
  await commit(w, h, gtmIntent("SALES:ENROLLMENTS", "ENR-NEW", { Campaign: "CMP-1", Contact: "C-LEGACY", "Started At": "2026-09-07T09:00:00+02:00" }));
  const enrollments = w.rows(G.enrollmentsDs);
  assert.equal(enrollments.length, 2, "the legacy enrollment survives the migration");
  const legacy = enrollments.find((r) => textOf(r, "Enrollment Key") === "ENR-LEGACY");
  assert.equal(textOf(legacy as never, "Campaign"), "CMP-LEGACY");
  assert.equal((legacy?.properties["State"] as unknown as { select: { name: string } | null }).select?.name, "ENDED", "its history is untouched");
  const campaign = w.rows(G.campaignsDs).find((r) => textOf(r, "Campaign Key") === "CMP-LEGACY");
  assert.equal(textOf(campaign as never, "Owner Rep"), REP_GTM_KEY, "owner and setup are preserved");
});

test("PT-GTM-008/B: an interruption between the write and the receipt is recovered by exact lookup", async () => {
  const w = buildGtmRuntimeWorld();
  const h = await bindRep(w);
  const intent = exposureIntent({ key: "EXP-CRASH", contact: "C01", message_ref: "MSG-C01" });
  const prepared = await prepare(w, h, intent);
  const plan = prepared.plan as Plan;
  executeWrites(w, plan.stage1_writes, plan.plan_id, { now: "2030-01-03T00:30:00.000Z" });
  assert.equal(w.rows(G.exposuresDs).length, 1, "the row is durable, the receipt never arrived");

  // A new chat re-issues the same intent: it is recovered by observation, not repeated.
  const secondChat = await bindRep(w);
  const again = await prepare(w, secondChat, intent);
  assert.equal(again.envelope.code, "PLAN_PREPARED", JSON.stringify(again.envelope));
  assert.equal((again.plan as Plan).run_mode, "RECOVER_EXISTING");
  const t = await target(w, secondChat, again.plan as Plan, { now: "2030-01-03T00:40:00.000Z" });
  assert.equal(t.envelope.code, "TARGET_VERIFIED", JSON.stringify(t.envelope));
  const f = await finalize(w, secondChat, again.plan as Plan, (t.envelope as { result: Record<string, unknown> }).result["target_receipt_id"] as string, t.symbols, { fin: "2030-01-03T00:50:00.000Z", state: "2030-01-03T00:51:00.000Z" });
  assert.equal(f.code, "TRANSACTION_VERIFIED", JSON.stringify(f));
  assert.equal(w.rows(G.exposuresDs).length, 1, "one exposure, whatever the number of chats");
});

test("PT-GTM-008/C: a missing historical price or campaign stays UNKNOWN and is never filled from configuration", async () => {
  const w = buildGtmRuntimeWorld();
  w.setRows(G.campaignsDs, [
    ...w.rows(G.campaignsDs),
    gtmRow(synthetic("legacy-campaign-2"), "Campaign", "CMP-OLD", { "Campaign Key": "CMP-OLD", "Owner Rep": REP_GTM_KEY, "Runtime ID": REP_GTM_INSTANCE, Status: "ACTIVE" }, GTM_SCHEMAS.campaigns),
  ]);
  const h = await bindRep(w);

  // The historical campaign records no offer or price: today's configuration may not be borrowed for it.
  const borrowed = await prepare(w, h, exposureIntent({ key: "EXP-OLD", contact: "C01", message_ref: "MSG-OLD", campaign: "CMP-OLD" }));
  assert.equal(borrowed.envelope.code, "HOLD_GTM_CONTRACT_VIOLATION", JSON.stringify(borrowed.envelope));
  assert.match(evidenceOf(borrowed.envelope), /the override must pin its evidence/);

  // Stated for what it is — an exposure whose own evidence is pinned — it is accepted.
  await commit(w, h, exposureIntent({ key: "EXP-OLD", contact: "C01", message_ref: "MSG-OLD", campaign: "CMP-OLD", extra: { "Override Evidence": "EV-HISTORICAL-1" } }));
  assert.equal(w.rows(G.exposuresDs).length, 1);

  // A campaign that does not exist at all is refused outright.
  const ghost = await prepare(w, h, exposureIntent({ key: "EXP-GHOST", contact: "C01", message_ref: "MSG-GHOST", campaign: "CMP-404" }));
  assert.equal(ghost.envelope.code, "HOLD_GTM_CONTRACT_VIOLATION");
  assert.match(evidenceOf(ghost.envelope), /does not exist in this runtime/);
});

test("PT-GTM-008/D: a governing version change holds the dependent action and destroys nothing", async () => {
  const w = buildGtmRuntimeWorld();
  const h = await bindRep(w);
  await commit(w, h, exposureIntent({ key: "EXP-BEFORE", contact: "C01", message_ref: "MSG-C01" }));
  const before = w.rows(G.exposuresDs).length;
  const ledgerBefore = w.rows(G.ledgerDs).length;

  const adopted = w.deps.adapters.salesRuntime.supported().filter((v) => !gtmCapableVersions(w.deps.adapters.salesRuntime).includes(v));
  const candidate = w.deps.adapters.salesRuntime.resolve(w.contractVersion) as SalesContractAdapter;
  const fallback = adopted.find((v) => (w.deps.adapters.salesRuntime.resolve(v) as SalesContractAdapter).grammar.bootTitle === candidate.grammar.bootTitle) as string;
  const fallbackSchema = (w.deps.adapters.salesRuntime.resolve(fallback) as SalesContractAdapter).supportedSchemas[0] as string;
  const manifest = w.rows(G.manifestDs)[0] as { properties: Record<string, unknown>; id: string };
  w.setRows(G.manifestDs, [{
    ...manifest,
    properties: {
      ...manifest.properties,
      "Sales Contract Version": { type: "rich_text", rich_text: [{ type: "text", plain_text: fallback, annotations: {} }] },
      "Schema Version": { type: "rich_text", rich_text: [{ type: "text", plain_text: fallbackSchema, annotations: {} }] },
      "Sales Contract URL": { type: "url", url: null },
    },
  } as never]);

  const held = await prepare(w, h, exposureIntent({ key: "EXP-AFTER", contact: "C02", message_ref: "MSG-C02" }));
  assert.equal(held.envelope.code, "HOLD_VERSION_CHANGED", JSON.stringify(held.envelope));
  assert.equal(w.rows(G.exposuresDs).length, before, "nothing durable is destroyed by the version change");
  assert.equal(w.rows(G.ledgerDs).length, ledgerBefore, "the journal of what already happened survives");

  // Rolling the pin back restores the candidate behavior on a fresh binding, with the events intact.
  w.setRows(G.manifestDs, [manifest as never]);
  const rebound = await bindRep(w);
  await commit(w, rebound, exposureIntent({ key: "EXP-AFTER", contact: "C02", message_ref: "MSG-C02" }));
  assert.equal(w.rows(G.exposuresDs).length, before + 1);
});

test("PT-GTM-008/E: the candidate is a per-runtime canary, and a concurrent writer holds", async () => {
  const w = buildGtmRuntimeWorld();
  const h = await bindRep(w);

  // Another rep on the adopted line addresses no GTM resource at all: the canary does not spread.
  const otherHandle = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, { principal_id: "p-rep-b" }, w.deps));
  const other = await dispatch("os_prepare", { binding_handle: otherHandle, intent: exposureIntent({ key: "EXP-X", contact: "C01", message_ref: "MSG-X" }) }, { principal_id: "p-rep-b" }, w.deps);
  assert.equal(other.code, "HOLD_RESOURCE_UNKNOWN", JSON.stringify(other));
  assert.match(evidenceOf(other), /is not addressable under/);

  // A second plan on the same runtime waits instead of writing behind the first.
  const first = await prepare(w, h, exposureIntent({ key: "EXP-1", contact: "C01", message_ref: "MSG-1" }));
  assert.equal(first.envelope.code, "PLAN_PREPARED");
  const concurrent = await prepare(w, h, gtmIntent("SALES:CAMPAIGNS", "CMP-CONCURRENT", { ...OWNER_FIELDS, "Configured Offer": "OFFER-STD", "Configured Price": "120000" }));
  assert.equal(concurrent.envelope.code, "HOLD_RUNTIME_BUSY", JSON.stringify(concurrent.envelope));
  assert.equal(w.rows(G.campaignsDs).length, 1, "the waiting intent wrote nothing");
  void REP_CTX;
});
