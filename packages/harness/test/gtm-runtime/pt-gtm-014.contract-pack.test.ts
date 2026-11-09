/**
 * PT-GTM-014 — the candidate Contract Pack, through the real os_resume on both lanes (PV-GTM-002).
 * Evidence candidates only: no PT case is marked PASS here.
 *
 * A: the META analysis need selects only the admitted bounded pointers, under the candidate policy.
 * B: the SALES context need selects only the bound principal's own containers.
 * C: a cross-lane need is refused inside the pack; there is no wildcard and no read-all.
 * D: a changed ref, generation or capability changes the pack identity.
 * E: a stale pack cannot steer a new Run, and no pack confers mutation authority.
 * F: an unregistered selected resource is UNAVAILABLE_NOT_REGISTERED and NEEDS_EXPANSION, never COMPLETE.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../../src/tools/handlers.ts";
import { CANDIDATE_POLICY_VERSION, POLICY_VERSION } from "../../src/contractPack/catalog.ts";
import { handleOf } from "../unit/binding-fixtures.ts";
import { buildGtmRuntimeWorld, G } from "./world.ts";
import { bindRep, OWNER_CTX, REP_CTX, resume } from "./drive.ts";

type Pack = {
  policy_version: string; policy_role?: string; normalized_needs: string[]; completeness: string; completeness_reason: string;
  selected_pointers: Array<{ resource_key: string; refs: string[]; reason: string; availability?: string; provenance: Record<string, unknown> }>;
  omitted_resource_keys: string[]; allowed_needs_for_lane: string[]; pack_id: string; state_fingerprint: string;
};
const packOf = (payload: Record<string, unknown>): Pack => payload["contract_pack"] as Pack;

async function metaResume(w: ReturnType<typeof buildGtmRuntimeWorld>, topic_hint: string) {
  const handle = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, OWNER_CTX, w.deps));
  const envelope = await dispatch("os_resume", { binding_handle: handle, topic_hint }, OWNER_CTX, w.deps);
  const payload = (envelope.status === "OK" ? (envelope as { result: Record<string, unknown> }).result : envelope.observations) as Record<string, unknown>;
  return { handle, envelope, payload };
}

test("PT-GTM-014/A: the META analysis need selects only the admitted bounded pointers", async () => {
  const w = buildGtmRuntimeWorld();
  const { payload } = await metaResume(w, "META_GTM_ANALYSIS");
  const pack = packOf(payload);
  assert.equal(pack.policy_version, CANDIDATE_POLICY_VERSION);
  assert.equal(pack.policy_role, "CANDIDATE_NOT_ADOPTED");
  assert.deepEqual(pack.selected_pointers.map((p) => p.resource_key), ["META:SALES_RUNTIME_INPUTS", "META:GTM_METRIC_REFS"]);
  assert.deepEqual(pack.allowed_needs_for_lane, ["CURRENT_WORK", "META_SETUP_INPUTS", "META_GTM_ANALYSIS"]);
  assert.equal(pack.selected_pointers.some((p) => p.resource_key.startsWith("SALES:")), false, "no SALES pointer reaches a META pack");
  assert.equal(pack.selected_pointers.find((p) => p.resource_key === "META:GTM_METRIC_REFS")?.availability, "AVAILABLE");
});

test("PT-GTM-014/B: the SALES context need selects only the bound principal's own containers", async () => {
  const w = buildGtmRuntimeWorld();
  const { payload } = await resume(w, await bindRep(w), "SALES_GTM_CONTEXT");
  const pack = packOf(payload);
  assert.deepEqual(pack.selected_pointers.map((p) => p.resource_key), ["SALES:GTM_CAMPAIGN_CONTEXT"]);
  assert.equal(pack.selected_pointers[0]?.availability, "AVAILABLE");
  assert.equal(pack.selected_pointers[0]?.provenance["containers_found"], 10);
  assert.equal(pack.completeness, "COMPLETE");
  assert.equal(pack.selected_pointers.some((p) => p.resource_key.startsWith("META:")), false, "no private META pointer reaches SALES");
  // The refs are the bound runtime's own containers, and nobody else's.
  const own = new Set(pack.selected_pointers.flatMap((p) => p.refs));
  assert.ok(own.has(G.snapshotsDs) && own.has(G.exposuresDs));

  const otherHandle = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, { principal_id: "p-rep-b" }, w.deps));
  const other = await dispatch("os_resume", { binding_handle: otherHandle, topic_hint: "SALES_GTM_CONTEXT" }, { principal_id: "p-rep-b" }, w.deps);
  const otherPack = packOf((other.status === "OK" ? (other as { result: Record<string, unknown> }).result : other.observations) as Record<string, unknown>);
  assert.equal(otherPack.policy_version, POLICY_VERSION, "a runtime without the capability keeps the adopted policy");
  assert.equal(otherPack.completeness_reason, "gtm_capability_absent");
  assert.equal(JSON.stringify(other).includes(G.snapshotsDs), false, "another rep's response never contains our refs");
});

test("PT-GTM-014/C: a cross-lane need is refused inside the pack and there is no read-all symbol", async () => {
  const w = buildGtmRuntimeWorld();
  const { payload, envelope } = await resume(w, await bindRep(w), "SALES_GTM_CONTEXT,META_GTM_ANALYSIS");
  const pack = packOf(payload);
  assert.equal(pack.completeness, "HOLD");
  assert.equal(pack.completeness_reason, "cross_lane_rejected");
  assert.deepEqual(pack.selected_pointers.map((p) => p.resource_key), ["SALES:GTM_CAMPAIGN_CONTEXT"]);
  assert.equal(envelope.status, "OK", "the rejection lives inside the pack, never in the envelope");
  const symbols = [...pack.allowed_needs_for_lane, ...pack.selected_pointers.map((p) => p.resource_key), ...pack.omitted_resource_keys];
  assert.equal(symbols.some((s) => s.includes("*") || /\bALL\b/.test(s)), false, "no wildcard, no read-all");
});

test("PT-GTM-014/D: a changed ref, generation or capability changes the pack identity", async () => {
  const w = buildGtmRuntimeWorld();
  const handle = await bindRep(w);
  const first = packOf((await resume(w, handle, "SALES_GTM_CONTEXT")).payload);
  const again = packOf((await resume(w, handle, "SALES_GTM_CONTEXT")).payload);
  assert.equal(first.pack_id, again.pack_id, "same state, same identity");
  const other = packOf((await resume(w, handle, "CURRENT_WORK")).payload);
  assert.notEqual(first.pack_id, other.pack_id);

  const withRegistration = packOf((await metaResume(w, "META_GTM_ANALYSIS")).payload);
  w.setMetaGtmRegistration({ registered: true, pinned: true, lastVerified: "2030-02-02T00:00:00.000Z" });
  const changedRef = packOf((await metaResume(w, "META_GTM_ANALYSIS")).payload);
  assert.notEqual(withRegistration.pack_id, changedRef.pack_id, "a changed registered ref changes identity");

  w.setMetaGtmRegistration({ registered: false });
  const withoutCapability = packOf((await metaResume(w, "META_GTM_ANALYSIS")).payload);
  assert.notEqual(withRegistration.pack_id, withoutCapability.pack_id);
  assert.equal(withoutCapability.policy_version, POLICY_VERSION);
});

test("PT-GTM-014/E: a stale pack cannot steer a new Run and no pack confers mutation authority", async () => {
  const w = buildGtmRuntimeWorld();
  const handle = await bindRep(w);
  const pack = packOf((await resume(w, handle, "SALES_GTM_CONTEXT")).payload);

  // A pack is not an argument of any tool: handing one back is refused at the surface.
  const smuggled = await dispatch("os_prepare", {
    binding_handle: handle, pack_id: pack.pack_id, contract_pack: pack,
    intent: { action_class: "COMMIT", summary: "x", mutations: [{ logical_resource_key: "SALES:CAMPAIGNS", operation: "CREATE", record_selector: { natural_key: "CMP-9" }, desired_changes: { "Owner Rep": "rep-gtm" } }] },
  } as never, REP_CTX, w.deps);
  assert.equal(smuggled.code, "ERROR_INVALID_ARGUMENT", JSON.stringify(smuggled));

  // A read-selection symbol is not a mutation target either.
  const asTarget = await dispatch("os_prepare", {
    binding_handle: handle,
    intent: { action_class: "COMMIT", summary: "x", mutations: [{ logical_resource_key: "SALES:GTM_CAMPAIGN_CONTEXT", operation: "CREATE", record_selector: { natural_key: "X" }, desired_changes: { Any: "1" } }] },
  }, REP_CTX, w.deps);
  assert.equal(asTarget.code, "HOLD_RESOURCE_UNKNOWN", JSON.stringify(asTarget));

  // After a runtime rotation the binding that produced the pack is stale: nothing it carries can steer new work.
  w.setSalesRegistry([{ rep_identity_key: "rep-gtm", status: "KNOWN", root_ref: G.root, expected_instance_id: "SALESOS-FIXTURE-GTM", expected_gmail_identity: "rep-gtm@example.invalid", pointer_generation: "2" }]);
  const after = await resume(w, handle, "SALES_GTM_CONTEXT");
  assert.equal(after.envelope.code, "HOLD_BINDING_STALE_RUNTIME_ROTATED", JSON.stringify(after.envelope));
});

test("PT-GTM-014/F: an unregistered selected resource is UNAVAILABLE_NOT_REGISTERED and NEEDS_EXPANSION", async () => {
  const w = buildGtmRuntimeWorld();
  // The GTM registration is pinned, but the indexed source is absent: the pointer states its unavailability and
  // the pack can never report COMPLETE.
  w.setMetaGtmRegistration({ registered: true, pinned: true, sourceLastVerified: null });
  const pack = packOf((await metaResume(w, "META_GTM_ANALYSIS")).payload);
  assert.equal(pack.completeness, "NEEDS_EXPANSION");
  assert.equal(pack.completeness_reason, "context_not_registered");
  const inputs = pack.selected_pointers.find((p) => p.resource_key === "META:SALES_RUNTIME_INPUTS");
  assert.equal(inputs?.availability, "UNAVAILABLE_NOT_REGISTERED");
  assert.deepEqual(inputs?.refs, []);
  assert.match(inputs?.reason ?? "", /read nothing and do not improvise a target/);

  // No registration at all: the need is not even offered, and the adopted policy applies unchanged.
  w.setMetaGtmRegistration({ registered: false });
  const unregistered = packOf((await metaResume(w, "META_GTM_ANALYSIS")).payload);
  assert.equal(unregistered.policy_version, POLICY_VERSION);
  assert.equal(unregistered.completeness, "NEEDS_EXPANSION");
  assert.equal(unregistered.completeness_reason, "gtm_capability_absent");
  assert.deepEqual(unregistered.normalized_needs, ["CURRENT_WORK"]);
  assert.deepEqual(unregistered.allowed_needs_for_lane, ["CURRENT_WORK", "META_SETUP_INPUTS"]);

  // An unknown token is still an unknown token.
  const unknown = packOf((await metaResume(w, "META_SETUP_INPUTS,META_EVERYTHING")).payload);
  assert.equal(unknown.completeness_reason, "unknown_need_token");
});
