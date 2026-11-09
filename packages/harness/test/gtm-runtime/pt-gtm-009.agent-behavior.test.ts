/**
 * PT-GTM-009 — agent behavior and boundaries, through the real six-tool protocol (PV-GTM-002).
 * Evidence candidates only: no PT case is marked PASS here.
 *
 * A: thinking without being asked to modify produces no business mutation.
 * B: copying what works is a proposal inside Authority, never a cross-rep or uncontrolled publication.
 * C: an approved recipient package excludes another rep's private diagnostics and adopts the safe boundary.
 * D: with no pinned objective nothing activates, and safety consequences come first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../../src/tools/handlers.ts";
import { dispositionOf, filterPublication } from "../../src/gtm/semantics.ts";
import { handleOf } from "../unit/binding-fixtures.ts";
import { buildGtmRuntimeWorld, G, REP_GTM_KEY } from "./world.ts";
import { bindRep, commit, evidenceOf, exposureIntent, gtmIntent, OWNER_CTX, prepare, resume } from "./drive.ts";

test("PT-GTM-009/A: reading and thinking produce no business mutation at all", async () => {
  const w = buildGtmRuntimeWorld();
  const h = await bindRep(w);
  const before = [G.campaignsDs, G.exposuresDs, G.snapshotsDs, G.attributionsDs].map((ds) => w.rows(ds).length);

  const read = await resume(w, h, "SALES_GTM_CONTEXT");
  assert.equal(read.envelope.code, "RESUMED");
  await dispatch("os_handoff", { binding_handle: h }, { principal_id: "p-rep-gtm" }, w.deps);
  await dispatch("os_resume", { binding_handle: h, topic_hint: "CURRENT_WORK" }, { principal_id: "p-rep-gtm" }, w.deps);

  const after = [G.campaignsDs, G.exposuresDs, G.snapshotsDs, G.attributionsDs].map((ds) => w.rows(ds).length);
  assert.deepEqual(after, before, "no durable row appears from reading");
  const plans = await w.deps.store.plans.findActive("VERTIGO", "SALES", (read.envelope.binding as { runtime_generation: string }).runtime_generation);
  assert.deepEqual(plans, [], "no plan is created by reading");
});

test("PT-GTM-009/B: copying what works stays inside Authority and never crosses to another rep", async () => {
  const w = buildGtmRuntimeWorld();
  const h = await bindRep(w);

  // Adopting the better variant for oneself is allowed, inside the Authority of the version it derives from.
  await commit(w, h, gtmIntent("SALES:APPROACH_VERSIONS", "AP-1/v2", {
    "Approach Key": "AP-1", "Version Label": "v2", "Authority Scope": "SALES_OUTBOUND_EMAIL", "Variant Of": "AP-1/v1",
  }));

  // Widening Authority while copying is refused.
  const widened = await prepare(w, h, gtmIntent("SALES:APPROACH_VERSIONS", "AP-1/v3", {
    "Approach Key": "AP-1", "Version Label": "v3", "Authority Scope": "SALES_OUTBOUND_EMAIL_AND_CALL", "Variant Of": "AP-1/v1",
  }));
  assert.equal(widened.envelope.code, "HOLD_GTM_CONTRACT_VIOLATION");
  assert.match(evidenceOf(widened.envelope), /a variant never widens Authority/);

  // Rolling it out for another rep is refused: a record of this runtime never names another rep.
  const crossRep = await prepare(w, h, gtmIntent("SALES:PARTICIPATIONS", "PART-OTHER", {
    "Owner Rep": "rep-b", "Runtime ID": "SALESOS-FIXTURE-B", "Approach Version": "AP-1/v2", Campaign: "CMP-1",
  }));
  assert.equal(crossRep.envelope.code, "HOLD_GTM_CONTRACT_VIOLATION");
  assert.match(evidenceOf(crossRep.envelope), /never names another rep/);
  assert.match(evidenceOf(crossRep.envelope), /is not the bound runtime/);
});

test("PT-GTM-009/C: a recipient package excludes another rep's private diagnostics", async () => {
  const decision = filterPublication([
    { item_key: "DIAG-SHARED-1", owner_rep: "rep-b", visibility: "SHARED" },
    { item_key: "DIAG-PRIVATE-B", owner_rep: "rep-b", visibility: "PRIVATE_REP" },
    { item_key: "DIAG-PRIVATE-OWN", owner_rep: REP_GTM_KEY, visibility: "PRIVATE_REP" },
  ], REP_GTM_KEY);
  assert.deepEqual(decision.published, ["DIAG-PRIVATE-OWN", "DIAG-SHARED-1"]);
  assert.deepEqual(decision.excluded, [{ item_key: "DIAG-PRIVATE-B", reason: "private diagnostic of another rep; it never crosses into a recipient package" }]);
  assert.equal(decision.boundary, "SAFE_SHARED_ONLY");

  const w = buildGtmRuntimeWorld();
  const handle = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, OWNER_CTX, w.deps));
  const envelope = await dispatch("os_resume", { binding_handle: handle, topic_hint: "META_GTM_ANALYSIS" }, OWNER_CTX, w.deps);
  const payload = (envelope.status === "OK" ? (envelope as { result: Record<string, unknown> }).result : envelope.observations) as Record<string, unknown>;
  const policy = (payload["gtm_analysis"] as { publication_policy: { default: string; private_rep_diagnostics: string } }).publication_policy;
  assert.equal(policy.private_rep_diagnostics, "NEVER_CROSS_REP");
  assert.equal(policy.default, "NOT_PUBLISHED_WITHOUT_EXPLICIT_APPROVAL");
});

test("PT-GTM-009/D: with no pinned objective nothing activates, and safety comes before measurement", async () => {
  const w = buildGtmRuntimeWorld();
  const h = await bindRep(w);
  await commit(w, h, exposureIntent({ key: "EXP-C01", contact: "C01", message_ref: "MSG-C01" }));

  // An objective ("two replies, five meetings") cannot be activated: the production target is not set.
  const objective = await prepare(w, h, gtmIntent("SALES:GTM_SNAPSHOTS", "SNAP-objective", {
    "Metric Key": "weekly_replied_prospects", "Period Key": "W-2026-38", "Period Start": "2026-09-14T00:00:00+02:00",
    "Period End": "2026-09-21T00:00:00+02:00", "Observation Cutoff": "2026-09-28T09:00:00+02:00", Scope: "RUNTIME",
    Computability: "COMPUTED", Value: "2", "Evidence Refs": "EV-1", "Input Revision": "IR-x",
    "Metric Definitions Version": "gtm-metric-definitions/v1", "Metric Definitions Digest": "x",
    "Coverage Refs": "COV-MBX-W38", "Target Comparison": "MEETS_OBJECTIVE_TWO_REPLIES",
  }));
  assert.equal(objective.envelope.code, "HOLD_GTM_CONTRACT_VIOLATION");
  assert.match(evidenceOf(objective.envelope), /the production target of this metric is not set/);

  // Safety first: an undetermined inbound carries a takeover, and the record must carry it.
  const view = dispositionOf({ kind: "UNKNOWN", intent: "UNDETERMINED", party: "EXTERNAL_PROSPECT", attribution: "ATTRIBUTED" });
  assert.equal(view.follow_up, "HUMAN_TAKEOVER");
  assert.equal(view.safety_priority, true);
  assert.equal(view.counts_as_reply, false);
  const deferred = await prepare(w, h, gtmIntent("SALES:REPLY_ATTRIBUTIONS", "RA-TAKEOVER", {
    "Reply Ref": "IN-C01", Contact: "C01", "Identity Resolution": "CANONICAL", "Reply At": "2026-09-15T10:00:00+02:00",
    "In Reply To": "MSG-C01", "Prior Touches": "MSG-C01|CMP-1|AP-1/v1|PART-1|2026-09-14T09:00:00+02:00",
    "Attribution Status": "ATTRIBUTED", "Attributed To": "MSG-C01", Candidates: "MSG-C01",
    Disposition: "UNKNOWN_KIND_TAKEOVER", "Counts As Reply": "false", "Reply Kind": "UNKNOWN", "Reply Intent": "UNDETERMINED",
    Party: "EXTERNAL_PROSPECT",
  }));
  assert.equal(deferred.envelope.code, "HOLD_GTM_CONTRACT_VIOLATION");
  assert.match(evidenceOf(deferred.envelope), /carries a safety consequence \(HUMAN_TAKEOVER\)/);
});
