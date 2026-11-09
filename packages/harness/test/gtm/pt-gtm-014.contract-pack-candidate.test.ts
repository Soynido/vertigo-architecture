/**
 * GTM-W03 world G — candidate context pack (PT-GTM-014 A–F). Entirely test-only: the adopted Contract Pack is
 * neither imported nor modified here, and this candidate is never adopted, installed or activated.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CANDIDATE_MARKERS, markerLabel } from "./catalog.ts";
import { buildGtmWorld, GTM_CONTEXT_KEYS, R_TEST, withExtraContextRef, withRotatedGeneration, withUnregisteredContext } from "./world.ts";
import { buildCandidatePack, isPackStale, LANE_AUTHORIZED_RESOURCES, steerNewRun, submitSymbolToMutationCatalog } from "./pack.ts";

const w = buildGtmWorld();
const metaPack = (world = w, needs: readonly string[] = ["META_GTM_ANALYSIS"]) =>
  buildCandidatePack({ world, lane: "META", principal_key: "CELIA_FIXTURE", needs });
const salesPack = (world = w, needs: readonly string[] = ["SALES_GTM_CONTEXT"], principal_key = "CELIA_FIXTURE") =>
  buildCandidatePack({ world, lane: "SALES", principal_key, needs });

test("PT-GTM-014 fixture: the candidate marker is a candidate and the selection has no wildcard", () => {
  const marker = CANDIDATE_MARKERS.find((m) => m.family === "CONTRACT_PACK");
  assert.equal(markerLabel(marker as never), "CONTRACT_PACK/0.2.0");
  assert.equal(marker?.role, "CANDIDATE_NOT_ADOPTED");
  assert.equal(metaPack().policy_role, "CANDIDATE_NOT_ADOPTED");
  const symbols = [...LANE_AUTHORIZED_RESOURCES.META, ...LANE_AUTHORIZED_RESOURCES.SALES];
  assert.equal(symbols.some((s) => s.includes("*") || /ALL/i.test(s)), false, "there is no read-all fallback symbol");
});

test("PT-GTM-014 fixture: each lane selects only its own admitted, registered, owner-bound pointers", () => {
  assert.deepEqual(metaPack().selected_pointers.map((p) => p.resource_key), ["META:SALES_RUNTIME_INPUTS", "META:GTM_METRIC_REFS"]);
  const sales = salesPack();
  assert.deepEqual(sales.selected_pointers.map((p) => p.resource_key), ["SALES:GTM_CAMPAIGN_CONTEXT"]);
  assert.equal(sales.selected_pointers.some((p) => p.resource_key.startsWith("META:")), false, "no private META pointer reaches SALES");
  const refs = sales.selected_pointers.flatMap((p) => p.refs);
  assert.equal(refs.some((r) => r.includes("CMP-4") || r.includes("PART-R2")), false, "no other rep's ref reaches this pack");

  const otherRep = salesPack(w, ["SALES_GTM_CONTEXT"], "JULIAN_FIXTURE");
  assert.deepEqual(otherRep.selected_pointers.flatMap((p) => p.refs), ["GTM_FIX:CAMPAIGN#CMP-4", "GTM_FIX:PARTICIPATION#PART-R2-A2V1"]);
  assert.equal(otherRep.selected_pointers.flatMap((p) => p.refs).some((r) => refs.includes(r)), false, "the two reps' packs share no ref");
});

test("PT-GTM-014 fixture: a cross-lane need is refused inside the pack, never silently served", () => {
  const mixed = salesPack(w, ["SALES_GTM_CONTEXT", "META_GTM_ANALYSIS"]);
  assert.equal(mixed.completeness, "HOLD");
  assert.equal(mixed.completeness_reason, "cross_lane_rejected");
  assert.deepEqual(mixed.selected_pointers.map((p) => p.resource_key), ["SALES:GTM_CAMPAIGN_CONTEXT"]);
});

test("PT-GTM-014 fixture: pack identity follows refs and generation; a stale pack cannot steer a new Run", () => {
  const base = salesPack();
  assert.equal(base.pack_id, salesPack().pack_id);
  assert.notEqual(base.pack_id, salesPack(withExtraContextRef(w, R_TEST, GTM_CONTEXT_KEYS.SALES_GTM_CAMPAIGN_CONTEXT, "GTM_FIX:EXPOSURE#EXP-NEW")).pack_id);
  const rotated = withRotatedGeneration(w, R_TEST);
  assert.notEqual(base.pack_id, salesPack(rotated).pack_id);
  assert.equal(isPackStale(base, rotated), true);
  assert.deepEqual(steerNewRun(base, rotated), { accepted: false, code: "REFUSED_STALE_PACK", reason: "the pack is pinned to a superseded runtime generation" });
  assert.deepEqual(steerNewRun(base, w), { accepted: true, rehydration: "FRESH_REQUIRED" });
});

test("PT-GTM-014 fixture: missing context expands or holds, and a read symbol is never mutation authority", () => {
  const missing = metaPack(withUnregisteredContext(w, R_TEST, GTM_CONTEXT_KEYS.META_GTM_METRIC_REFS));
  assert.equal(missing.completeness, "NEEDS_EXPANSION");
  assert.equal(missing.completeness_reason, "context_not_registered");
  const pointer = missing.selected_pointers.find((p) => p.resource_key === GTM_CONTEXT_KEYS.META_GTM_METRIC_REFS);
  assert.equal(pointer?.availability, "UNAVAILABLE_NOT_REGISTERED");
  assert.deepEqual(pointer?.refs, [], "an unavailable pointer states its unavailability instead of inventing refs");

  const unknown = metaPack(w, ["META_GTM_ANALYSIS", "META_EVERYTHING"]);
  assert.equal(unknown.completeness, "NEEDS_EXPANSION");
  assert.equal(unknown.completeness_reason, "unknown_need_token");

  const noRuntime = salesPack(w, ["SALES_GTM_CONTEXT"], "VALENTIN_FIXTURE");
  assert.equal(noRuntime.completeness, "HOLD");
  assert.deepEqual(noRuntime.selected_pointers, []);

  for (const pack of [metaPack(), salesPack()]) {
    assert.equal(pack.confers_mutation_authority, false);
    assert.equal(pack.fresh_rehydration_required, true, "the transaction path still rehydrates for itself");
  }
  assert.deepEqual(submitSymbolToMutationCatalog(GTM_CONTEXT_KEYS.SALES_GTM_CAMPAIGN_CONTEXT), {
    refused: true, code: "UNKNOWN_MUTATION_TARGET", symbol: "SALES:GTM_CAMPAIGN_CONTEXT",
  });
});
