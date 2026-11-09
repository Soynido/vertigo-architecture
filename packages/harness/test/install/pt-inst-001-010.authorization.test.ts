/**
 * PT-INST-001..010 — dedicated INSTALL_ONLY provisioning: who may enter it, and what it may never become.
 *
 * The premise of every case below: a provisioner duplicated the MASTER/template Personal SALES space and assigned
 * the clone to a rep. The clone therefore still carries the MASTER's Registry rows, Notes, PII, Last Run pointer,
 * Sales Contract URL and Root URL. All of it is hostile input. Authorization comes from the backend registry
 * alone, and a Notion edit can never manufacture it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInstallWorld } from "../unit/install-fixtures.ts";
import { REP_A } from "../unit/sales-fixtures.ts";
import { bind, bindingOf, boundHandle, businessIntent, detail, installationOf, prepare, resume, result, served, writerOf } from "./drive.ts";
import { dispatch, dispatchCommit } from "../../src/tools/handlers.ts";

/* ─────────────────────────── PT-INST-001: the backend status matrix ─────────────────────────── */

test("PT-INST-001/a: INSTALL_PENDING is the ONLY backend status that opens the dedicated installer", async () => {
  const w = buildInstallWorld({ registryStatus: "INSTALL_PENDING" });
  const handle = await boundHandle(w);
  const binding = await bindingOf(w, handle);
  assert.equal(binding?.binding_mode, "INSTALL_ONLY");
  assert.equal(binding?.install_phase, "INSTALL_PENDING");
});

test("PT-INST-001/b: KNOWN alone never authorizes bootstrap — an UNBOUND clone under KNOWN is refused", async () => {
  // The clone is byte-identical to the INSTALL_PENDING case; only the backend status differs.
  const w = buildInstallWorld({ registryStatus: "KNOWN" });
  const e = await bind(w);
  assert.equal(e.status, "HOLD", detail(e));
  assert.equal(e.code, "HOLD_RUNTIME_TEMPLATE_NOT_INSTANCE", detail(e));
  assert.match(detail(e), /explicitly INSTALL_PENDING/);
});

test("PT-INST-001/c: NOT_YET_CREATED and an absent entry both refuse, and neither reaches the installer", async () => {
  for (const entries of [
    [{ rep_identity_key: REP_A.rep_identity_key as string, status: "NOT_YET_CREATED" as const }],
    [],
  ]) {
    const w = buildInstallWorld();
    w.setRegistry(entries);
    const e = await bind(w);
    assert.equal(e.status, "HOLD", detail(e));
    assert.notEqual(e.code, "BOUND");
    assert.doesNotMatch(detail(e), /INSTALL_ONLY/);
  }
});

/* ─────────────────────────── PT-INST-002: the MASTER/template is never installable ─────────────────────────── */

test("PT-INST-002/a: a MASTER/template root is rejected even when the backend says INSTALL_PENDING", async () => {
  const w = buildInstallWorld({ rootTitle: "TEMPLATE — SALES AGENT OS (MASTER)", registryStatus: "INSTALL_PENDING" });
  const e = await bind(w);
  assert.equal(e.code, "HOLD_RUNTIME_TEMPLATE_NOT_INSTANCE", detail(e));
  assert.match(detail(e), /a provisioning assignment can never target the MASTER\/template root/);
});

test("PT-INST-002/b: INSTALL_PENDING without a non-template assigned instance id is refused", async () => {
  for (const options of [{ omitExpectedInstanceId: true }, { expectedInstanceId: "TEMPLATE-UNBOUND" }]) {
    const w = buildInstallWorld(options);
    const e = await bind(w);
    assert.equal(e.code, "HOLD_UNKNOWN_REQUIRED_FACT", detail(e));
    assert.match(detail(e), /non-template expected_instance_id/);
  }
});

test("PT-INST-002/c: the bound runtime id is the backend-assigned id, never the copied template marker", async () => {
  const w = buildInstallWorld();
  const e = await bind(w);
  assert.equal(e.code, "BOUND", detail(e));
  assert.notEqual(e.binding, "UNKNOWN");
  assert.equal((e.binding as { runtime_id: string }).runtime_id, "SALESOS-INSTALL-A");
  // The clone's own Manifest still says TEMPLATE-UNBOUND; it is reported as an observation, never as identity.
  const resumed = await resume(w, (result(e)["binding_handle"]) as string);
  assert.equal(resumed.observations["runtime_id"], "SALESOS-INSTALL-A");
});

/* ─────────────────────────── PT-INST-003: no Notion edit may open BUSINESS ─────────────────────────── */

test("PT-INST-003/a: INSTALL_ONLY survives every partial Manifest state a half-done install can produce", async () => {
  // Each row is a Manifest a human or a crashed install could leave behind, including one that looks complete.
  const partials: Record<string, unknown>[] = [
    { "Install State": "SETUP" },
    { "Install State": "SETUP", Owner: "Rep A" },
    { "Install State": "SETUP", Owner: "Rep A", "Instance ID": "SALESOS-INSTALL-A" },
    { "Install State": "SETUP", Owner: "Rep A", "Instance ID": "SALESOS-INSTALL-A", "Instance Status": "ACTIVE", "Gmail Identity": "rep-a@example.invalid" },
  ];
  for (const manifest of partials) {
    const w = buildInstallWorld({ manifest });
    const handle = await boundHandle(w);
    const binding = await bindingOf(w, handle);
    assert.equal(binding?.binding_mode, "INSTALL_ONLY", JSON.stringify(manifest));
    assert.equal(binding?.install_phase, "INSTALL_PENDING", JSON.stringify(manifest));
    const resumed = await resume(w, handle);
    assert.equal(installationOf(resumed)["business_progression"], "bloquée");
  }
});

test("PT-INST-003/b: a Manifest hand-edited to a fully installed instance still yields INSTALL_ONLY", async () => {
  // The seller (or an attacker with clone access) writes the complete promotion payload by hand. Authority is
  // held by the backend registry, so the plugin still refuses to treat the runtime as a business instance.
  const w = buildInstallWorld({
    manifest: {
      "Install State": "SETUP", "Instance Status": "ACTIVE", Owner: "Rep A",
      "Instance ID": "SALESOS-INSTALL-A", "Gmail Identity": "rep-a@example.invalid",
      "Read Scope": "INSTANCE_ROOT", "Write Scope": "INSTANCE_ROOT",
    },
  });
  const handle = await boundHandle(w);
  assert.equal((await bindingOf(w, handle))?.binding_mode, "INSTALL_ONLY");
  assert.equal((await w.lookupRegistry())?.status, "INSTALL_PENDING");
});

test("PT-INST-003/c: an Install State the contract does not know keeps the clone out of the installer", async () => {
  const w = buildInstallWorld({ manifest: { "Install State": "READY" } });
  const e = await bind(w);
  assert.equal(e.code, "HOLD_RUNTIME_MANIFEST_MISMATCH", detail(e));
  assert.match(detail(e), /unsupported Install State READY/);
});

test("PT-INST-003/d: a clone whose Manifest names a different owner is refused", async () => {
  const w = buildInstallWorld({ manifest: { Owner: "Someone Else" } });
  const e = await bind(w);
  assert.equal(e.code, "HOLD_RUNTIME_MANIFEST_MISMATCH", detail(e));
  assert.match(detail(e), /owner different from the assigned principal/);
});

test("PT-INST-003/e: a principal without a stable display name cannot create an installation plan", async () => {
  const { display_name: _missing, ...principal } = REP_A;
  const w = buildInstallWorld({ principal });
  const handle = await boundHandle(w);
  const e = await resume(w, handle);
  assert.equal(e.code, "HOLD_PERMISSION_UNKNOWN", detail(e));
  assert.match(detail(e), /no stable display_name/);
  assert.equal(writerOf(w).writes.length, 0, "no installation write without a stable owner identity");
  const binding = await bindingOf(w, handle);
  assert.equal((await w.deps.store.plans.listByRuntime("VERTIGO", "SALES", binding?.runtime_generation as string)).length, 0);
});

test("PT-INST-003/f: server-derived install preparation exposes exactly one action, not the batch", async () => {
  const w = buildInstallWorld();
  const handle = await boundHandle(w);
  const e = await prepare(w, handle);
  assert.equal(e.code, "PLAN_PREPARED", detail(e));
  const plan = await w.deps.store.plans.get(result(e)["plan_id"] as string);
  assert.ok(plan);
  assert.ok(plan.operations.length > 1, "the durable plan must retain the complete mapping");
  assert.equal(result(e)["operation_count"], plan.operations.length);
  assert.equal(result(e)["stage1_actions"], undefined);
  assert.equal(result(e)["pending_write_symbol"], plan.stage1_writes[0]!.symbol);
  assert.equal(result(e)["operations"], undefined, "the tool response must not expose the full operation batch");
});

/* ─────────────────────────── PT-INST-004: no business surface on an INSTALL_ONLY handle ─────────────────────────── */

test("PT-INST-004/a: every business tool refuses an INSTALL_ONLY handle and creates no plan", async () => {
  const w = buildInstallWorld();
  const handle = await boundHandle(w);

  // A business intent never even reaches the business engine: os_prepare routes an INSTALL_ONLY handle to the
  // installer, which refuses anything that is not the exact contract-derived mapping it just derived.
  const business = await prepare(w, handle, businessIntent());
  assert.equal(business.status, "HOLD", detail(business));
  assert.equal(business.code, "HOLD_INSTALL_REQUIRED", detail(business));
  assert.match(detail(business), /mapping accepts only UPDATE of SALES:INSTALL_REGISTRY/);
  assert.match(detail(business), /Registry key AK-INSTALL-PROBE is not part of the governing install contract/);
  assert.match(detail(business), /no business plan or copied-history recovery was opened/);

  const handoff = await dispatch("os_handoff", { binding_handle: handle }, { principal_id: REP_A.principal_id }, w.deps);
  assert.equal(handoff.code, "HOLD_INSTALL_REQUIRED", detail(handoff));

  const control = await dispatch("os_control_status", { binding_handle: handle }, { principal_id: REP_A.principal_id }, w.deps);
  assert.equal(control.code, "HOLD_INSTALL_REQUIRED", detail(control));

  // The published os_commit keeps its own candidate refusal: it carries no installation step, even with a writer.
  const commit = await dispatchCommit({ binding_handle: handle, intent: businessIntent() }, { principal_id: REP_A.principal_id }, served(w));
  assert.equal(commit.kind, "HELD");
  assert.equal(commit.kind === "HELD" && commit.code, "HOLD_INSTALL_REQUIRED");
  assert.equal(writerOf(w).writes.length, 0);

  const binding = await bindingOf(w, handle);
  const plans = await w.deps.store.plans.listByRuntime("VERTIGO", "SALES", binding?.runtime_generation as string);
  assert.equal(plans.length, 0, "no plan may exist after a refused business call");
});

test("PT-INST-004/b: os_resume on an INSTALL_ONLY handle runs the installer, never the business rehydrate engine", async () => {
  const w = buildInstallWorld();
  const resumed = await resume(w, await boundHandle(w));
  assert.equal(resumed.code, "RESUMED", detail(resumed));
  assert.equal(result(resumed)["install_only"], true);
  assert.equal(result(resumed)["runtime_state"], "UNBOUND");
  assert.equal(installationOf(resumed)["mode"], "installation serveur par lots");
  assert.equal(installationOf(resumed)["phase"], "cartographie en cours");
  // The business rehydrate engine would have reported an OS State cursor; the installer reports none.
  assert.equal(result(resumed)["cursor"], undefined);
  assert.equal(result(resumed)["recovery"], undefined);
});

test("PT-INST-004/c: the reverse guard holds — a BUSINESS binding can never address the INSTALL resources", async () => {
  // Same clone, but the backend has already activated it, so os_bind yields an ordinary business binding.
  const w = buildInstallWorld({ registryStatus: "KNOWN", manifest: { "Install State": "SETUP", Owner: "Rep A", "Instance ID": "SALESOS-INSTALL-A", "Gmail Identity": "rep-a@example.invalid", "Root URL": `https://www.notion.so/${buildInstallWorld().ids.root}` } });
  w.setManifest({ "Root URL": `https://www.notion.so/${w.ids.root}` });
  const e = await bind(w);
  assert.equal(e.code, "BOUND", detail(e));
  const handle = result(e)["binding_handle"] as string;
  assert.equal((await bindingOf(w, handle))?.binding_mode, "BUSINESS");

  for (const key of ["SALES:INSTALL_REGISTRY", "SALES:INSTALL_MANIFEST"]) {
    const attempt = await prepare(w, handle, {
      action_class: "COMMIT", summary: "reach into the installer surface",
      mutations: [{ logical_resource_key: key, operation: "UPDATE", record_selector: { natural_key: "ROOT" }, desired_changes: { Status: "RESOLVED" } }],
    });
    assert.equal(attempt.status, "HOLD", detail(attempt));
    assert.equal(attempt.code, "HOLD_UNSUPPORTED_OPERATION", detail(attempt));
    assert.match(detail(attempt), /INSTALL resources are unavailable after the runtime leaves UNBOUND/);
  }
});

test("PT-INST-004/d: a BUSINESS binding still requires explicit business intent", async () => {
  const w = buildInstallWorld({ registryStatus: "KNOWN", manifest: { "Install State": "SETUP", Owner: "Rep A", "Instance ID": "SALESOS-INSTALL-A", "Gmail Identity": "rep-a@example.invalid", "Root URL": `https://www.notion.so/${buildInstallWorld().ids.root}` } });
  w.setManifest({ "Root URL": `https://www.notion.so/${w.ids.root}` });
  const handle = result(await bind(w))["binding_handle"] as string;
  const e = await dispatch("os_prepare", { binding_handle: handle }, { principal_id: REP_A.principal_id }, w.deps);
  assert.equal(e.code, "ERROR_INVALID_ARGUMENT", detail(e));
  assert.match(detail(e), /intent is required for a business binding/);
});
