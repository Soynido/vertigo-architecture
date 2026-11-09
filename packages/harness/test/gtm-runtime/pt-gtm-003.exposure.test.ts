/**
 * PT-GTM-003 — exposure: what was actually communicated, through the real six-tool protocol (PV-GTM-002).
 * Evidence candidates only: no PT case is marked PASS here.
 *
 * A: an internal price that was never communicated is no price cause.
 * B: a communicated price states its amount, currency, unit and scope, and its history never mutates.
 * C: an accessible link is not a read link without read evidence.
 * D: an objection keeps its context and never becomes a certain counterfactual.
 * E: a personalized message is an observed override, never a template attached blindly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { exposureView } from "../../src/gtm/semantics.ts";
import { buildGtmRuntimeWorld, G } from "./world.ts";
import { bindRep, commit, evidenceOf, exposureIntent, gtmIntent, prepare } from "./drive.ts";

const base = { contact: "C01", message_ref: "MSG-C01" } as const;

test("PT-GTM-003/A: a price that was never communicated is configuration and can be no cause", async () => {
  const w = buildGtmRuntimeWorld();
  const h = await bindRep(w);

  // Pinning an internal price as communicated is refused.
  const pinned = await prepare(w, h, exposureIntent({
    key: "EXP-A", ...base,
    extra: { "Price Communicated": "false", "Communicated Price": "120000" },
  }));
  assert.equal(pinned.envelope.code, "HOLD_GTM_CONTRACT_VIOLATION", JSON.stringify(pinned.envelope));
  assert.match(evidenceOf(pinned.envelope), /a price that was not communicated is internal configuration/);
  assert.equal(evidenceOf(pinned.envelope).includes("120000"), false, "the refusal never echoes the price");

  // Claiming it as a cause is refused as well.
  const cause = await prepare(w, h, exposureIntent({
    key: "EXP-A2", ...base,
    extra: { "Price Communicated": "false", "Communicated Price": "", Currency: "", "Price Unit": "", "Price Scope": "", "Price Cause Claimed": "true" },
  }));
  assert.equal(cause.envelope.code, "HOLD_GTM_CONTRACT_VIOLATION");
  assert.match(evidenceOf(cause.envelope), /a price can only be a cause once it was actually communicated/);

  // Stated truthfully, the exposure is accepted with no price at all.
  await commit(w, h, exposureIntent({
    key: "EXP-A3", ...base,
    extra: { "Price Communicated": "false", "Communicated Price": "", Currency: "", "Price Unit": "", "Price Scope": "" },
  }));
  assert.equal(w.rows(G.exposuresDs).length, 1);
});

test("PT-GTM-003/B: a communicated price states amount, currency, unit and scope, and never mutates afterwards", async () => {
  const w = buildGtmRuntimeWorld();
  const h = await bindRep(w);

  const partial = await prepare(w, h, exposureIntent({ key: "EXP-B", ...base, extra: { Currency: "", "Price Scope": "" } }));
  assert.equal(partial.envelope.code, "HOLD_GTM_CONTRACT_VIOLATION");
  assert.match(evidenceOf(partial.envelope), /a communicated price states its amount, its currency, its unit and its scope/);

  await commit(w, h, exposureIntent({ key: "EXP-B", ...base }));
  const mutation = await prepare(w, h, gtmIntent("SALES:EXPOSURES", "EXP-B", { "Communicated Price": "1" }, "UPDATE"));
  assert.equal(mutation.envelope.code, "HOLD_UNSUPPORTED_OPERATION", JSON.stringify(mutation.envelope));
  assert.match(evidenceOf(mutation.envelope), /UPDATE is not permitted on SALES:EXPOSURES; permitted: CREATE/);

  // An override of the campaign configuration must pin its evidence; with it, it is accepted and immutable.
  const silent = await prepare(w, h, exposureIntent({ key: "EXP-B2", contact: "C02", message_ref: "MSG-C02", extra: { "Communicated Offer": "OFFER-PILOT", "Communicated Price": "90000" } }));
  assert.equal(silent.envelope.code, "HOLD_GTM_CONTRACT_VIOLATION");
  assert.match(evidenceOf(silent.envelope), /the override must pin its evidence/);
  assert.equal(evidenceOf(silent.envelope).includes("90000"), false, "the refusal never echoes the offer or the price");
  await commit(w, h, exposureIntent({ key: "EXP-B2", contact: "C02", message_ref: "MSG-C02", extra: { "Communicated Offer": "OFFER-PILOT", "Communicated Price": "90000", "Override Evidence": "EV-OVR-2" } }));
  assert.equal(w.rows(G.exposuresDs).length, 2);
});

test("PT-GTM-003/C: an accessible link is not a read link without its own read evidence", async () => {
  const w = buildGtmRuntimeWorld();
  const h = await bindRep(w);
  const claimed = await prepare(w, h, exposureIntent({ key: "EXP-C", ...base, extra: { "Link Sent": "true", "Link Read": "true" } }));
  assert.equal(claimed.envelope.code, "HOLD_GTM_CONTRACT_VIOLATION");
  assert.match(evidenceOf(claimed.envelope), /an accessible link is not a read link/);

  const unsent = await prepare(w, h, exposureIntent({ key: "EXP-C2", ...base, extra: { "Link Sent": "false", "Link Read Evidence": "EV-READ" } }));
  assert.equal(unsent.envelope.code, "HOLD_GTM_CONTRACT_VIOLATION");
  assert.match(evidenceOf(unsent.envelope), /a link that was never sent cannot carry read evidence/);

  await commit(w, h, exposureIntent({ key: "EXP-C3", ...base, extra: { "Link Sent": "true", "Link Read": "true", "Link Read Evidence": "EV-READ-1" } }));
  // The shared view says the same thing about the same evidence.
  const view = exposureView({
    configured_offer: "OFFER-STD", configured_price: "120000", communicated_offer: "OFFER-STD", communicated_price: "120000",
    price_communicated: true, currency: "EUR", price_unit: "PER_MONTH", price_scope: "PILOT",
    override_evidence: null, link_sent: true, link_read_evidence: null,
  });
  assert.equal(view.link_read_proven, false);
  assert.deepEqual(view.violations, []);
});

test("PT-GTM-003/D: an objection keeps its context and never becomes a certain counterfactual", async () => {
  const w = buildGtmRuntimeWorld();
  const h = await bindRep(w);
  await commit(w, h, exposureIntent({ key: "EXP-D", ...base }));
  const attribution = {
    "Reply Ref": "IN-C01", Contact: "C01", "Identity Resolution": "CANONICAL", "Reply At": "2026-09-15T10:00:00+02:00",
    "In Reply To": "MSG-C01", "Prior Touches": "MSG-C01|CMP-1|AP-1/v1|PART-1|2026-09-14T09:00:00+02:00",
    "Attribution Status": "ATTRIBUTED", "Attributed To": "MSG-C01", Candidates: "MSG-C01",
    Disposition: "ELIGIBLE_HUMAN_REPLY", "Counts As Reply": "true", "Reply Kind": "HUMAN", "Reply Intent": "OBJECTION",
    Party: "EXTERNAL_PROSPECT", "Objection Context": "OBJ-CTX-1",
  };
  const counterfactual = await prepare(w, h, gtmIntent("SALES:REPLY_ATTRIBUTIONS", "RA-D2", { ...attribution, Counterfactual: "would have booked at a lower price" }));
  assert.equal(counterfactual.envelope.code, "HOLD_GTM_CONTRACT_VIOLATION");
  assert.match(evidenceOf(counterfactual.envelope), /no counterfactual is certain/);

  await commit(w, h, gtmIntent("SALES:REPLY_ATTRIBUTIONS", "RA-D1", attribution));
  const row = w.rows(G.attributionsDs)[0];
  const context = (row?.properties["Objection Context"] as unknown as { rich_text: Array<{ plain_text: string }> }).rich_text[0]?.plain_text;
  assert.equal(context, "OBJ-CTX-1", "the objection context is retained");
});

test("PT-GTM-003/E: a personalized message is an observed override, never a template attached blindly", async () => {
  const w = buildGtmRuntimeWorld();
  const h = await bindRep(w);
  const blind = await prepare(w, h, exposureIntent({ key: "EXP-E", ...base, extra: { "Message Variant": "PERSONALIZED", "Template Ref": "TPL-1" } }));
  assert.equal(blind.envelope.code, "HOLD_GTM_CONTRACT_VIOLATION");
  assert.match(evidenceOf(blind.envelope), /a personalized message is an observed override; it pins its evidence/);

  await commit(w, h, exposureIntent({ key: "EXP-E", ...base, extra: { "Message Variant": "PERSONALIZED", "Template Ref": "TPL-1", "Override Evidence": "EV-PERSO-1" } }));
  await commit(w, h, exposureIntent({ key: "EXP-E2", contact: "C02", message_ref: "MSG-C02", extra: { "Message Variant": "TEMPLATE", "Template Ref": "TPL-1" } }));
  assert.equal(w.rows(G.exposuresDs).length, 2);
});
