/**
 * PT-GTM-001 — the META index versus the source it indexes, through the real os_resume (PV-GTM-002).
 * Evidence candidates only: no PT case is marked PASS here.
 *
 * A: a stale index and a fresher source diverge; the source is read fresh and the divergence is attributed.
 * B: an inaccessible source concludes UNKNOWN; nothing is corrected and no consensus is invented.
 * C: a recent but hypothetical field stays unpublished, and configuration, execution and effectiveness are
 *    distinguished layer by layer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../../src/tools/handlers.ts";
import { CANDIDATE_POLICY_VERSION } from "../../src/contractPack/catalog.ts";
import { gtmCapability } from "../../src/gtm/context.ts";
import { handleOf } from "../unit/binding-fixtures.ts";
import { buildGtmRuntimeWorld } from "./world.ts";
import { OWNER_CTX } from "./drive.ts";

type Projection = {
  projection_version: string;
  metric_definitions_version: string;
  metric_definitions_digest: string;
  registered_resource: { ref: string; status: string; pinned_policy: string };
  freshness: { divergence: string; conclusion: string; attributed_to: string; corrected: boolean; rule: string };
  metrics: Array<{ metric_key: string; layer: string; publication: string; production_target_state: string }>;
  publication_policy: { default: string; private_rep_diagnostics: string; hypothetical_fields: string; layers_separated: string[] };
  values: string;
};

async function metaProjection(w: ReturnType<typeof buildGtmRuntimeWorld>): Promise<{ projection: Projection | undefined; payload: Record<string, unknown> }> {
  const handle = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, OWNER_CTX, w.deps));
  const envelope = await dispatch("os_resume", { binding_handle: handle, topic_hint: "META_GTM_ANALYSIS" }, OWNER_CTX, w.deps);
  const payload = (envelope.status === "OK" ? (envelope as { result: Record<string, unknown> }).result : envelope.observations) as Record<string, unknown>;
  return { projection: payload["gtm_analysis"] as Projection | undefined, payload };
}

test("PT-GTM-001/A: a stale index against a fresher source diverges, is attributed, and is never merged", async () => {
  const w = buildGtmRuntimeWorld();
  w.setMetaGtmRegistration({ registered: true, pinned: true, lastVerified: "2030-01-01T00:00:00.000Z", sourceLastVerified: "2030-01-05T00:00:00.000Z" });
  const { projection } = await metaProjection(w);
  assert.ok(projection !== undefined);
  assert.equal(projection.freshness.divergence, "INDEX_STALE");
  assert.equal(projection.freshness.conclusion, "USE_SOURCE");
  assert.equal(projection.freshness.attributed_to, "META_INDEX");
  assert.equal(projection.freshness.corrected, false, "no side is silently corrected");
  assert.match(projection.freshness.rule, /the source is read fresh/);

  // With both sides equally fresh the verdict is ALIGNED, and the source is still the thing read.
  const aligned = buildGtmRuntimeWorld();
  aligned.setMetaGtmRegistration({ registered: true, pinned: true, lastVerified: "2030-01-05T00:00:00.000Z", sourceLastVerified: "2030-01-05T00:00:00.000Z" });
  const second = await metaProjection(aligned);
  assert.equal(second.projection?.freshness.divergence, "ALIGNED");
  assert.equal(second.projection?.freshness.conclusion, "USE_SOURCE");
});

test("PT-GTM-001/B: an inaccessible source concludes UNKNOWN, with no fabricated correction or consensus", async () => {
  const w = buildGtmRuntimeWorld();
  w.setMetaGtmRegistration({ registered: true, pinned: true, lastVerified: "2030-01-01T00:00:00.000Z", sourceLastVerified: null });
  const { projection, payload } = await metaProjection(w);
  assert.ok(projection !== undefined);
  assert.equal(projection.freshness.divergence, "SOURCE_INACCESSIBLE");
  assert.equal(projection.freshness.conclusion, "UNKNOWN");
  assert.equal(projection.freshness.attributed_to, "NOT_APPLICABLE");
  assert.equal(projection.freshness.corrected, false);
  assert.match(projection.freshness.rule, /nothing is concluded, nothing is corrected and no consensus is invented/);
  assert.equal(projection.values, "NOT_COMPUTABLE_FROM_META");
  const pointer = (payload["contract_pack"] as { selected_pointers: Array<{ resource_key: string; refs: string[]; availability?: string }> })
    .selected_pointers.find((p) => p.resource_key === "META:SALES_RUNTIME_INPUTS");
  assert.deepEqual(pointer?.refs, [], "an unreadable source is read as nothing, never as a value");
  assert.equal(pointer?.availability, "UNAVAILABLE_NOT_REGISTERED");
});

test("PT-GTM-001/C: layers are distinguished and a definition is never implicitly published", async () => {
  const w = buildGtmRuntimeWorld();
  const { projection } = await metaProjection(w);
  assert.ok(projection !== undefined);
  const layers = [...new Set(projection.metrics.map((m) => m.layer))].sort();
  assert.deepEqual(layers, ["EFFECTIVENESS", "EXECUTION"], "the catalog separates what was done from what it obtained");
  assert.deepEqual(projection.publication_policy.layers_separated, ["CONFIGURATION", "EXECUTION", "EFFECTIVENESS"]);
  assert.equal(projection.publication_policy.default, "NOT_PUBLISHED_WITHOUT_EXPLICIT_APPROVAL");
  assert.equal(projection.publication_policy.hypothetical_fields, "NEVER_PUBLISHED");
  assert.ok(projection.metrics.every((m) => m.publication === "NOT_PUBLISHED_DEFINITION_ONLY"));
  assert.ok(projection.metrics.every((m) => m.production_target_state === "TARGET_NOT_SET"));
  assert.equal(projection.registered_resource.pinned_policy, CANDIDATE_POLICY_VERSION);
  assert.equal(projection.projection_version, "gtm-analysis-projection/v1");
  assert.equal(projection.metric_definitions_version, "gtm-metric-definitions/v1");
  assert.equal(projection.metric_definitions_digest.length, 16);
});

test("PT-GTM-001/C2: a registry row that does not pin the candidate policy adopts nothing", async () => {
  const w = buildGtmRuntimeWorld();
  w.setMetaGtmRegistration({ registered: true, pinned: false });
  const { projection, payload } = await metaProjection(w);
  assert.equal(projection, undefined, "no candidate projection is produced without an explicit pin");
  assert.equal(payload["meta_gtm_metrics"], undefined, "the adopted resume payload is unchanged");
  const pack = payload["contract_pack"] as { policy_version: string; completeness_reason: string; allowed_needs_for_lane: string[] };
  assert.equal(pack.policy_version, "CONTRACT_PACK/0.1.0");
  assert.equal(pack.completeness_reason, "gtm_capability_absent");
  assert.deepEqual(pack.allowed_needs_for_lane, ["CURRENT_WORK", "META_SETUP_INPUTS"]);

  // The capability function states the same thing directly, and names the unpinned registration.
  const runtime = { adapter: { version: "x", controlPlane: {}, capabilities: undefined } } as never;
  const unpinned = gtmCapability("META", runtime, { ref: "r", status: "RESOLVED", schema_version: "TEST_GTM_INDEX/1" });
  assert.equal(unpinned.enabled, false);
  assert.equal(unpinned.unpinned_registration, true);
  assert.match(unpinned.reason, /a registry row never adopts a policy/);
  const unresolved = gtmCapability("META", runtime, { ref: "r", status: "PENDING", schema_version: CANDIDATE_POLICY_VERSION });
  assert.equal(unresolved.enabled, false);
  assert.match(unresolved.reason, /not RESOLVED/);
});
