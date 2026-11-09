/**
 * PT-GTM-002 — the campaign chain and the approach views, through the real six-tool protocol (PV-GTM-002).
 * Evidence candidates only: no PT case is marked PASS here.
 *
 * A: a complete chain — campaign (list, dedup), approach version, participation (task), enrollment (qualification,
 *    evidence) and exposure (message) — is linked by identifiers, and a broken link is refused.
 * B: one rep with two variants keeps them separately measurable.
 * C: one approach run by two reps is grouped while owner and runtime stay on each participation.
 * D: a successive account keeps exactly one ACTIVE enrollment, duplicates no account and preserves its history.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { approachViews } from "../../src/gtm/semantics.ts";
import { buildGtmRuntimeWorld, G, REP_GTM_INSTANCE, REP_GTM_KEY } from "./world.ts";
import { bindRep, commit, evidenceOf, exposureIntent, gtmIntent, OWNER_FIELDS, prepare } from "./drive.ts";

const textOf = (page: { properties: Record<string, unknown> }, prop: string): string =>
  ((page.properties[prop] as { rich_text?: Array<{ plain_text: string }> } | undefined)?.rich_text?.[0]?.plain_text) ?? "";

test("PT-GTM-002/A: the whole chain is linked by identifiers and a broken link is refused", async () => {
  const w = buildGtmRuntimeWorld();
  const h = await bindRep(w);

  await commit(w, h, gtmIntent("SALES:CAMPAIGNS", "CMP-2", {
    ...OWNER_FIELDS, "Configured Offer": "OFFER-STD", "Configured Price": "120000",
    "List Ref": "LIST-2", "Dedup Ref": "DEDUP-2", "Started At": "2026-09-07T09:00:00+02:00",
  }));
  await commit(w, h, gtmIntent("SALES:PARTICIPATIONS", "PART-2", {
    ...OWNER_FIELDS, "Approach Version": "AP-1/v1", Campaign: "CMP-2", "Task Ref": "TASK-2",
  }));
  await commit(w, h, gtmIntent("SALES:ENROLLMENTS", "ENR-CMP2-C01", {
    Campaign: "CMP-2", Contact: "C01", Account: "ACC-1", "Started At": "2026-09-07T09:00:00+02:00",
    "Qualification Ref": "QUAL-1", "Evidence Ref": "EV-QUAL-1",
  }));
  await commit(w, h, exposureIntent({ key: "EXP-C01", contact: "C01", message_ref: "MSG-C01", campaign: "CMP-2", participation: "PART-2" }));

  const campaign = w.rows(G.campaignsDs).find((r) => textOf(r, "Campaign Key") === "CMP-2");
  const participation = w.rows(G.participationsDs).find((r) => textOf(r, "Participation Key") === "PART-2");
  const enrollment = w.rows(G.enrollmentsDs)[0];
  const exposure = w.rows(G.exposuresDs)[0];
  assert.ok(campaign && participation && enrollment && exposure);
  assert.equal(textOf(participation, "Campaign"), textOf(campaign, "Campaign Key"));
  assert.equal(textOf(enrollment, "Campaign"), textOf(campaign, "Campaign Key"));
  assert.equal(textOf(exposure, "Campaign"), textOf(campaign, "Campaign Key"));
  assert.equal(textOf(exposure, "Participation"), textOf(participation, "Participation Key"));
  assert.equal(textOf(exposure, "Message Ref"), "MSG-C01");
  assert.equal(textOf(campaign, "List Ref"), "LIST-2");
  assert.equal(textOf(campaign, "Dedup Ref"), "DEDUP-2");
  assert.equal(textOf(enrollment, "Qualification Ref"), "QUAL-1");
  assert.equal(textOf(participation, "Task Ref"), "TASK-2");

  // A link that points at nothing is refused before any plan exists.
  const broken = await prepare(w, h, exposureIntent({ key: "EXP-GHOST", contact: "C02", message_ref: "MSG-C02", campaign: "CMP-404" }));
  assert.equal(broken.envelope.code, "HOLD_GTM_CONTRACT_VIOLATION", JSON.stringify(broken.envelope));
  assert.match(evidenceOf(broken.envelope), /names a campaign that does not exist in this runtime/);
});

test("PT-GTM-002/B: one rep running two variants keeps them separately measurable", async () => {
  const w = buildGtmRuntimeWorld();
  const h = await bindRep(w);
  await commit(w, h, gtmIntent("SALES:APPROACH_VERSIONS", "AP-1/v2", {
    "Approach Key": "AP-1", "Version Label": "v2", "Authority Scope": "SALES_OUTBOUND_EMAIL", "Variant Of": "AP-1/v1",
  }));
  await commit(w, h, gtmIntent("SALES:PARTICIPATIONS", "PART-2", { ...OWNER_FIELDS, "Approach Version": "AP-1/v2", Campaign: "CMP-1" }));

  const views = approachViews(w.rows(G.participationsDs).map((r) => ({
    participation_key: textOf(r, "Participation Key"),
    approach_version_key: textOf(r, "Approach Version"),
    approach_key: "AP-1",
    owner_rep: textOf(r, "Owner Rep"),
    runtime_id: textOf(r, "Runtime ID"),
  })));
  assert.deepEqual(views.by_version.map((v) => v.approach_version_key), ["AP-1/v1", "AP-1/v2"]);
  assert.deepEqual(views.by_version.map((v) => v.participations), [["PART-1"], ["PART-2"]], "the two variants are never merged");
  assert.deepEqual(views.by_approach[0]?.versions, ["AP-1/v1", "AP-1/v2"]);
});

test("PT-GTM-002/C: one approach run by two reps is grouped while owner and runtime are preserved", () => {
  const views = approachViews([
    { participation_key: "PART-1", approach_version_key: "AP-1/v1", approach_key: "AP-1", owner_rep: REP_GTM_KEY, runtime_id: REP_GTM_INSTANCE },
    { participation_key: "PART-B", approach_version_key: "AP-1/v1", approach_key: "AP-1", owner_rep: "rep-b", runtime_id: "SALESOS-FIXTURE-B" },
  ]);
  assert.equal(views.by_approach.length, 1, "the approach groups both reps");
  assert.deepEqual(views.by_approach[0]?.participations, [
    { participation_key: "PART-1", owner_rep: REP_GTM_KEY, runtime_id: REP_GTM_INSTANCE },
    { participation_key: "PART-B", owner_rep: "rep-b", runtime_id: "SALESOS-FIXTURE-B" },
  ]);
  assert.deepEqual(views.by_version[0]?.owners, ["rep-b", REP_GTM_KEY], "owner and runtime survive the grouping, in deterministic order");
});

test("PT-GTM-002/D: a successive account keeps one ACTIVE enrollment, duplicates nothing and keeps its history", async () => {
  const w = buildGtmRuntimeWorld();
  const h = await bindRep(w);
  await commit(w, h, gtmIntent("SALES:ENROLLMENTS", "ENR-CMP1-C01", { Campaign: "CMP-1", Contact: "C01", Account: "ACC-1", "Started At": "2026-09-07T09:00:00+02:00" }));

  const parallel = await prepare(w, h, gtmIntent("SALES:ENROLLMENTS", "ENR-CMP2-C01", { Campaign: "CMP-2", Contact: "C01", Account: "ACC-1", "Started At": "2026-09-14T09:00:00+02:00" }));
  assert.equal(parallel.envelope.code, "HOLD_GTM_CONTRACT_VIOLATION");
  assert.match(evidenceOf(parallel.envelope), /already holds 1 ACTIVE enrollment\(s\).*successive campaigns are temporal/);

  const reEnroll = await prepare(w, h, gtmIntent("SALES:ENROLLMENTS", "ENR-CMP1-C01-BIS", { Campaign: "CMP-1", Contact: "C01", Account: "ACC-1", State: "ENDED", "Started At": "2026-09-14T09:00:00+02:00" }));
  assert.equal(reEnroll.envelope.code, "HOLD_GTM_CONTRACT_VIOLATION");
  assert.match(evidenceOf(reEnroll.envelope), /already enrolled in that campaign; an account is never duplicated/);

  await commit(w, h, gtmIntent("SALES:ENROLLMENTS", "ENR-CMP1-C01", { State: "ENDED", "Ended At": "2026-09-13T18:00:00+02:00" }, "UPDATE"));
  await commit(w, h, gtmIntent("SALES:ENROLLMENTS", "ENR-CMP2-C01", { Campaign: "CMP-2", Contact: "C01", Account: "ACC-1", "Started At": "2026-09-14T09:00:00+02:00" }));
  const rows = w.rows(G.enrollmentsDs);
  assert.equal(rows.length, 2, "the ended enrollment stays durable: history is preserved");
  const active = rows.filter((r) => (r.properties["State"] as unknown as { select: { name: string } | null }).select?.name === "ACTIVE");
  assert.equal(active.length, 1);
  assert.equal(textOf(active[0] as never, "Campaign"), "CMP-2");

  // Re-activating the ended one would create a second ACTIVE enrollment: refused against durable state.
  const reactivate = await prepare(w, h, gtmIntent("SALES:ENROLLMENTS", "ENR-CMP1-C01", { State: "ACTIVE" }, "UPDATE"));
  assert.equal(reactivate.envelope.code, "HOLD_GTM_CONTRACT_VIOLATION");
  assert.match(evidenceOf(reactivate.envelope), /already holds 1 ACTIVE enrollment/);
});
