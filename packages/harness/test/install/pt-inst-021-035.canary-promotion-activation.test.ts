/**
 * PT-INST-021..035 — the bounded install transaction itself.
 *
 * Terminal canary semantics (deliberate, documented in docs/INSTALL_PROVISIONING.md). The live Registry `Status`
 * select only offers EXPECTED / RESOLVED / MISSING / HOLD, and the native Notion connector cannot set
 * `archived: true` through update_page. A terminal phase is therefore represented by an ACTIVE, PLAN-BOUND row
 * whose title Key is `INSTALL_CANARY:<planId>` reaching `RESOLVED`. No unversioned select option is invented,
 * the row can never be confused with a contract resource (its key is not a contract key), and no business reader
 * consumes the clone's Registry at all — only this installer does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInstallWorld } from "../unit/install-fixtures.ts";
import { propText, type Page } from "../../src/notion/shapes.ts";
import { executeWrites, mutatePage, rowsOf } from "../unit/target-fixtures.ts";

import { lookupPlan } from "../../src/auth/ownership.ts";
import { installAssignmentSnapshot } from "../../src/registry/salesRuntimes.ts";
import {
  assertNoNativeAction, bindingOf, boundHandle, detail, finishPromotion, installerIntent, installFully, installationOf, installUntil,
  planOf, prepare, preparePromotion, prepare as prepareTool, resume, result, runMapping, verify, writerOf,
} from "./drive.ts";

/* ─────────────────────────── PT-INST-021: the complete canary lifecycle ─────────────────────────── */

test("PT-INST-021/a: create → fetch → update → fetch → terminal update → fetch, each phase independently proven", async () => {
  const w = buildInstallWorld();
  const handle = await boundHandle(w);
  const plan = await planOf(w, await prepare(w, handle, await installerIntent(w, handle)));

  const created = executeWrites(w, plan.stage1_writes, plan.plan_id, { now: "2030-01-02T00:00:00.000Z" });
  const canaryRef = created["INSTALL_CANARY"] as string;
  const canary = () => w.map.get(`page:${canaryRef}`) as Page;
  assert.equal(propText(canary(), "Key"), `VERIFICATION_INSTALLATION:${plan.plan_id}`);
  assert.equal(propText(canary(), "Scope"), "READ_WRITE");
  assert.equal(propText(canary(), "Status"), "MISSING");

  // fetch #1 — the create is read back and the EXPECTED update is issued.
  const one = await verify(w, handle, plan.plan_id, "TARGET");
  assert.equal(result(one)["verification_step"], "étape intermédiaire", detail(one));
  assert.deepEqual(result(one)["verify"], { plan_id: plan.plan_id, phase: "TARGET" }, "the canary update must name the exact follow-up phase");
  assert.equal((await w.deps.store.plans.get(plan.plan_id))?.plan_state, "TARGET_VERIFIED");

  // fetch #2 — verifying again WITHOUT performing the update must not advance the lifecycle.
  const stalled = await verify(w, handle, plan.plan_id, "TARGET");
  assert.equal(stalled.status, "HOLD", detail(stalled));
  assert.match(detail(stalled), /verification status is MISSING; expected EXPECTED after update and readback/);

  mutatePage(w, canaryRef, { Status: "EXPECTED" });
  const two = await verify(w, handle, plan.plan_id, "TARGET");
  assert.equal(result(two)["verification_step"], "mise à jour terminale du canari (encore TARGET)", detail(two));
  assert.deepEqual(result(two)["verify"], { plan_id: plan.plan_id, phase: "TARGET" }, "RESOLVED is still followed by TARGET, never FINAL");
  assert.equal((await w.deps.store.plans.get(plan.plan_id))?.plan_state, "AWAITING_FINAL_VERIFY");

  // fetch #3 — the terminal update must be real before TARGET is granted.
  const notTerminal = await verify(w, handle, plan.plan_id, "TARGET");
  assert.equal(notTerminal.status, "HOLD", detail(notTerminal));
  assert.match(detail(notTerminal), /not RESOLVED after its terminal update and readback/);

  mutatePage(w, canaryRef, { Status: "RESOLVED" });
  const three = await verify(w, handle, plan.plan_id, "TARGET");
  assert.equal(three.code, "TARGET_VERIFIED", detail(three));
  assert.equal(result(three)["verification_ref"], canaryRef);
  const next = ((result(three)["installation"] as { continuation: { pending_write_symbol: string; actions?: unknown[] } }).continuation);
  assert.equal(next.pending_write_symbol, plan.finalization_writes[0]!.symbol);
  assert.equal(next.actions, undefined, "no native instruction batch after cutover");
  assert.equal(result(three)["finalization_actions"], undefined, "the full finalization batch must stay backend-owned");
});

test("PT-INST-021/b: jumping straight to the terminal phase never satisfies the proof", async () => {
  const w = buildInstallWorld();
  const handle = await boundHandle(w);
  const plan = await planOf(w, await prepare(w, handle, await installerIntent(w, handle)));
  const created = executeWrites(w, plan.stage1_writes, plan.plan_id, { now: "2030-01-02T00:00:00.000Z" });
  mutatePage(w, created["INSTALL_CANARY"] as string, { Status: "RESOLVED" });
  const e = await verify(w, handle, plan.plan_id, "TARGET");
  assert.equal(e.status, "HOLD", detail(e));
  assert.match(detail(e), /verification status is RESOLVED; expected MISSING after creation and readback/);
});

test("PT-INST-021/c: a verification row whose Key no longer belongs to the plan cannot satisfy it", async () => {
  const w = buildInstallWorld();
  const handle = await boundHandle(w);
  const plan = await planOf(w, await prepare(w, handle, await installerIntent(w, handle)));
  const created = executeWrites(w, plan.stage1_writes, plan.plan_id, { now: "2030-01-03T00:00:00.000Z" });
  const verificationRef = created["INSTALL_CANARY"] as string;
  mutatePage(w, verificationRef, { Key: "VERIFICATION_INSTALLATION:another-plan" });

  const e = await verify(w, handle, plan.plan_id, "TARGET");
  assert.equal(e.status, "HOLD", detail(e));
  assert.match(detail(e), /the unique structural verification row is absent or duplicated/);
  assert.ok(rowsOf(w, w.ids.registryDs).some((r) => propText(r, "Key") === "VERIFICATION_INSTALLATION:another-plan"));
});

test("PT-INST-021/d: the mapping plan finalizes the Registry only — it never touches the Manifest", async () => {
  const w = buildInstallWorld();
  const handle = await boundHandle(w);
  const before = JSON.stringify(w.map.get(`page:${w.ids.manifestRow}`));
  const run = await runMapping(w, handle);

  const touched = [...run.plan.stage1_writes, ...run.plan.finalization_writes, run.plan.state_last_write];
  assert.ok(!touched.some((x) => x.target_ref === w.ids.manifestRow), "the mapping plan addressed the Manifest");
  assert.equal(JSON.stringify(w.map.get(`page:${w.ids.manifestRow}`)), before, "the Manifest changed during mapping");
  assert.ok(run.finalReceiptId, "the mapping produced no FINAL receipt");
  assert.equal((await w.lookupRegistry())?.status, "INSTALL_PENDING", "mapping activated the backend");
  assert.equal((await w.lookupRegistry())?.pointer_generation, "7");
});

/* ─────────────────────────── PT-INST-022: promotion is bound to ONE proof ─────────────────────────── */

test("PT-INST-022/a: promotion is a separate plan bound to the exact mapping plan AND its exact FINAL receipt", async () => {
  const w = buildInstallWorld();
  const handle = await boundHandle(w);
  const mapping = await runMapping(w, handle);
  const { plan, target } = await preparePromotion(w, handle);

  assert.equal(plan.plan_kind, "INSTALL_PROMOTION");
  assert.equal(plan.install_mapping_plan_id, mapping.plan.plan_id);
  assert.equal(plan.install_mapping_final_receipt_id, mapping.finalReceiptId);
  assert.equal(plan.state_last_write.target_ref, w.ids.manifestRow);
  assert.equal(plan.stage1_writes.length, 0, "promotion must open no stage-1 writes");
  assert.equal(plan.finalization_writes.length, 1, "promotion must normalize exactly one clone-local OS State cursor before SETUP");
  assert.equal(plan.finalization_writes[0]?.target_ref, w.ids.stateRow);
  assert.equal(result(target)["finalization_actions"], undefined);
  assert.equal(result(target)["state_last_action"], undefined);
  assert.equal(plan.finalization_writes[0]!.symbol, "NORMALIZE_OS_STATE");
  assert.equal(plan.state_last_write.symbol, "PROMOTE_MANIFEST");
  assert.ok(plan.finalization_writes[0]!.ordinal < plan.state_last_write.ordinal, "Manifest must follow OS State normalization");
});

test("PT-INST-022/b: invalidating the exact mapping proof bound to promotion stops activation", async () => {
  const w = buildInstallWorld();
  const handle = await boundHandle(w);
  const mapping = await runMapping(w, handle);
  const { plan: promotion, target } = await preparePromotion(w, handle);
  assert.equal(target.code, "TARGET_VERIFIED", detail(target));
  assert.equal(promotion.install_mapping_plan_id, mapping.plan.plan_id);
  assert.equal(promotion.install_mapping_final_receipt_id, mapping.finalReceiptId);

  await w.deps.store.receipts.setStatus(mapping.finalReceiptId, "INVALID");
  const e = await finishPromotion(w, handle, promotion);
  assert.equal(e.status, "HOLD", detail(e));
  assert.match(detail(e), /bound mapping FINAL receipt is INVALID/);
  assert.match(detail(e), /no backend activation was attempted/);
  assert.equal((await w.lookupRegistry())?.status, "INSTALL_PENDING");
});

test("PT-INST-022/c: promotion without any verified mapping proof is refused", async () => {
  const w = buildInstallWorld();
  const handle = await boundHandle(w);
  const e = await prepare(w, handle, {
    action_class: "INSTALL_PROMOTE", summary: "skip the structural proof",
    mutations: [{ logical_resource_key: "SALES:INSTALL_MANIFEST", operation: "UPDATE", record_selector: { natural_key: "CURRENT" }, desired_changes: { "Install State": "SETUP" } }],
  });
  assert.equal(e.code, "HOLD_INSTALL_REQUIRED", detail(e));
  assert.match(detail(e), /no verified structural mapping exists for this workspace version/);
});

test("PT-INST-022/d: promotion refuses a missing or duplicated OS State CURRENT cursor", async () => {
  for (const shape of ["MISSING", "DUPLICATE"] as const) {
    const w = buildInstallWorld();
    const handle = await boundHandle(w);
    await runMapping(w, handle);
    const current = w.map.get(`page:${w.ids.stateRow}`) as Page;
    const rows = shape === "MISSING" ? [] : [current, { ...current, id: `${current.id.slice(0, -1)}f` }];
    w.map.set(`query:${w.ids.stateDs}`, { results: rows, has_more: false, next_cursor: null });
    const e = await prepare(w, handle, await installerIntent(w, handle));
    assert.equal(e.code, "HOLD_INSTALL_REQUIRED", `${shape}: ${detail(e)}`);
    assert.match(detail(e), new RegExp(`OS State must contain exactly one live CURRENT row, found ${rows.length}`));
    assert.equal((await w.lookupRegistry())?.status, "INSTALL_PENDING");
  }
});

/* ─────────────────────────── PT-INST-023: tampering after TARGET must HOLD ─────────────────────────── */

const afterTargetTamper = async (mutate: (w: ReturnType<typeof buildInstallWorld>, canaryRef: string) => void, expected: RegExp) => {
  const w = buildInstallWorld();
  const handle = await boundHandle(w);
  const mapping = await runMapping(w, handle);
  const { plan, target } = await preparePromotion(w, handle);
  assert.equal(target.code, "TARGET_VERIFIED", detail(target));

  mutate(w, mapping.canaryRef);

  const e = await finishPromotion(w, handle, plan);
  assert.equal(e.status, "HOLD", detail(e));
  assert.match(detail(e), expected, detail(e));
  assert.match(detail(e), /no backend activation was attempted/);
  assert.equal((await w.lookupRegistry())?.status, "INSTALL_PENDING", "the backend was activated despite tampering");
  assert.equal((await w.lookupRegistry())?.pointer_generation, "7");
};

test("PT-INST-023/a: a Registry row repointed after TARGET stops the activation", async () => {
  await afterTargetTamper((w) => w.setRegistryRow("ACCOUNTS", { "Resource URL": `https://www.notion.so/${w.ids.foreignMaster}` }), /no longer points at its unique contract-derived clone resource/);
});

test("PT-INST-023/b: a Registry row demoted out of RESOLVED after TARGET stops the activation", async () => {
  await afterTargetTamper((w) => w.setRegistryRow("ACCOUNTS", { Status: "HOLD" }), /status is HOLD, expected RESOLVED/);
});

test("PT-INST-023/c: a terminal verification row reverted after TARGET stops the activation", async () => {
  await afterTargetTamper((w, canaryRef) => mutatePage(w, canaryRef, { Status: "EXPECTED" }), /terminal verification row is EXPECTED, expected RESOLVED/);
});

test("PT-INST-023/d: a terminal verification row archived after TARGET stops the activation", async () => {
  await afterTargetTamper((w, canaryRef) => {
    const row = w.map.get(`page:${canaryRef}`) as Page;
    w.map.set(`page:${canaryRef}`, { ...row, archived: true });
  }, /terminal verification row was archived or trashed after the structural proof/);
});

test("PT-INST-023/e: a Manifest that does not match the server-derived promotion stops the activation", async () => {
  const w = buildInstallWorld();
  const handle = await boundHandle(w);
  await runMapping(w, handle);
  const { plan, target } = await preparePromotion(w, handle);
  assert.equal(target.code, "TARGET_VERIFIED", detail(target));
  // The seller writes a DIFFERENT owner than the authenticated assignment.
  executeWrites(w, plan.finalization_writes, plan.plan_id, { now: "2030-01-02T00:09:00.000Z" });
  executeWrites(w, [plan.state_last_write], plan.plan_id, { now: "2030-01-02T00:09:00.000Z" });
  w.setManifest({ Owner: "Someone Else" });
  const e = await verify(w, handle, plan.plan_id, "FINAL");
  assert.equal(e.status, "HOLD", detail(e));
  assert.equal((await w.lookupRegistry())?.status, "INSTALL_PENDING");
});

test("PT-INST-023/f: OS State tampering after TARGET stops activation before the backend CAS", async () => {
  const w = buildInstallWorld();
  const handle = await boundHandle(w);
  await runMapping(w, handle);
  const { plan, target } = await preparePromotion(w, handle);
  assert.equal(target.code, "TARGET_VERIFIED", detail(target));
  executeWrites(w, plan.finalization_writes, plan.plan_id, { now: "2030-01-02T00:09:00.000Z" });
  executeWrites(w, [plan.state_last_write], plan.plan_id, { now: "2030-01-02T00:09:01.000Z" });
  w.setState({ "Persistence Health": "HOLD_REBIND_REQUIRED", "Open Blocker": "CONCURRENT_TAMPER" });

  const e = await verify(w, handle, plan.plan_id, "FINAL");
  assert.equal(e.code, "HOLD_STATE_LAST_NOT_PROVEN", detail(e));
  assert.match(detail(e), /OS State field (Open Blocker|Persistence Health)/);
  assert.equal((await w.lookupRegistry())?.status, "INSTALL_PENDING");
});

/* ─────────────────────────── PT-INST-024: activation, generation bump, fresh rebind ─────────────────────────── */

test("PT-INST-024/a: FINAL activates the backend atomically, bumps the generation and stales the handle", async () => {
  const w = buildInstallWorld();
  const before = await w.lookupRegistry();
  assert.equal(before?.pointer_generation, "7");

  const { handle, promotion, mapping } = await installFully(w);
  const after = await w.lookupRegistry();
  assert.equal(after?.status, "KNOWN");
  assert.equal(after?.pointer_generation, "8");
  assert.equal(after?.activation_proof_plan_id, promotion.plan.plan_id);
  assert.equal(installationOf(promotion.finalEnvelope)["phase"], "reconnexion requise");
  assert.equal(installationOf(promotion.finalEnvelope)["manifest_promoted"], true);
  assert.equal(promotion.finalEnvelope.next.permitted_tool_call, "os_bind", "after activation the next call is a fresh os_bind");
  assert.equal((promotion.finalEnvelope.binding as { binding_state: string }).binding_state, "STALE");

  // The spent INSTALL_ONLY binding is durably STALE, and the old handle is refused BEFORE any tool body runs.
  assert.equal((await bindingOf(w, handle))?.status, "STALE");
  const reused = await resume(w, handle);
  assert.equal(reused.code, "HOLD_BINDING_STALE", detail(reused));
  assert.equal(result(reused)["installation"], undefined, "a stale handle still produced an installer surface");

  const blocked = await prepareTool(w, handle, { action_class: "INSTALL", summary: "replay", mutations: mapping.plan.operations.map(() => ({ logical_resource_key: "SALES:INSTALL_REGISTRY", operation: "UPDATE" as const, record_selector: { natural_key: "ROOT" }, desired_changes: {} })) });
  assert.equal(blocked.status, "HOLD", detail(blocked));
  assert.equal(result(blocked)["plan_id"], undefined, "a stale handle created a plan");
});

test("PT-INST-024/b: the fresh rebind is BUSINESS on a new generation, and the installer surface is gone", async () => {
  const w = buildInstallWorld();
  const { handle: old } = await installFully(w);
  const oldBinding = await bindingOf(w, old);

  const fresh = await boundHandle(w);
  const binding = await bindingOf(w, fresh);
  assert.equal(binding?.binding_mode, "BUSINESS");
  assert.equal(binding?.install_phase, "NOT_APPLICABLE");
  assert.notEqual(binding?.runtime_generation, oldBinding?.runtime_generation, "the runtime generation was not bumped");

  // The new handle runs the ordinary business engine. The copied UNBOUND seed is gone, so the first safe blocker
  // is the real required Gmail capability — never a fictitious recovery incident.
  const resumed = await resume(w, fresh);
  assert.equal(resumed.status, "HOLD", detail(resumed));
  assert.equal(resumed.code, "HOLD_REQUIRED_CAPABILITY_INCOMPLETE", detail(resumed));
  assert.equal(result(resumed)["install_only"], undefined);
  assert.equal(result(resumed)["installation"], undefined);
  const state = w.map.get(`page:${w.ids.stateRow}`) as Page;
  assert.equal(propText(state, "Persistence Health"), "PASS");
  assert.equal(propText(state, "Current Gate Status"), "OPEN");
  assert.equal(propText(state, "Open Blocker"), "");
  assert.equal(propText(state, "Last Run Ref"), "");

  // The Manifest is authoritative for admission (ADMISSION-SALES-001), so its own fail-closed seed has to be
  // cleared by the same promotion. Until 2026-09-22 it was not: the master ships Health Status HOLD and
  // Persistence Health HOLD_REBIND_REQUIRED, promotion wrote neither, and every installed clone was therefore
  // refused on its first business turn — which is exactly what Valentin's live runtime was doing.
  const promoted = w.map.get(`page:${w.ids.manifestRow}`) as Page;
  assert.equal(propText(promoted, "Health Status"), "HEALTHY", "the clone is born on the master's HOLD seed");
  assert.equal(propText(promoted, "Persistence Health"), "PASS", "the clone is born needing a rebind it cannot do");
  assert.equal(propText(promoted, "Current Gate"), "B0_DISCOVERY");
  assert.equal(propText(promoted, "Current Gate Status"), "OPEN");
  assert.equal(propText(promoted, "Last Verified Mutation"), "", "a copied journal pointer names a row of another instance");
  const plans = await w.deps.store.plans.listByRuntime("VERTIGO", "SALES", binding?.runtime_generation as string);
  assert.equal(plans.length, 0, "business progression opened a plan on a freshly installed clone");
});

test("PT-INST-024/b2: activation clears copied Contract and Last Run pointers before BUSINESS can dereference them", async () => {
  const w = buildInstallWorld();
  await installFully(w);
  const manifest = w.map.get(`page:${w.ids.manifestRow}`) as Page;
  assert.equal(propText(manifest, "Sales Contract URL"), undefined);
  assert.equal(propText(manifest, "Last Run Ref"), "");
  const fresh = await boundHandle(w);
  const resumed = await resume(w, fresh);
  assert.doesNotMatch((resumed.warnings ?? []).join(" | "), /contract_page_unreadable|last_run_unreadable/);
});

test("PT-INST-024/c: concurrent FINALs activate exactly once", async () => {
  const w = buildInstallWorld();
  const handle = await boundHandle(w);
  await runMapping(w, handle);
  const { plan, target } = await preparePromotion(w, handle);
  assert.equal(target.code, "TARGET_VERIFIED", detail(target));
  executeWrites(w, plan.finalization_writes, plan.plan_id, { now: "2030-01-02T00:09:00.000Z" });
  executeWrites(w, [plan.state_last_write], plan.plan_id, { now: "2030-01-02T00:09:00.000Z" });

  const both = await Promise.all([verify(w, handle, plan.plan_id, "FINAL"), verify(w, handle, plan.plan_id, "FINAL")]);
  const verified = both.filter((e) => e.code === "TRANSACTION_VERIFIED");
  assert.equal(verified.length, 1, `expected exactly one activation, got ${both.map(detail).join(" // ")}`);
  const entry = await w.lookupRegistry();
  assert.equal(entry?.pointer_generation, "8", "the generation was bumped more than once");
  const finals = await w.deps.store.receipts.findByPlan(plan.plan_id, "FINAL");
  assert.equal(finals.length, 1, "two FINAL receipts were issued for one plan");
});

test("PT-INST-024/d: a crash between the backend swap and the receipt reconciles on the next bind, granting nothing", async () => {
  const w = buildInstallWorld();
  const handle = await boundHandle(w);
  await runMapping(w, handle);
  const { plan, target } = await preparePromotion(w, handle);
  assert.equal(target.code, "TARGET_VERIFIED", detail(target));
  executeWrites(w, plan.finalization_writes, plan.plan_id, { now: "2030-01-02T00:09:00.000Z" });
  executeWrites(w, [plan.state_last_write], plan.plan_id, { now: "2030-01-02T00:09:00.000Z" });

  // The compare-and-swap lands; the process dies before the FINAL receipt is written.
  const expectedAssignment = installAssignmentSnapshot(await w.lookupRegistry());
  assert.ok(expectedAssignment);
  const activated = await w.deps.salesRegistry.activateInstallation(expectedAssignment, plan.plan_id);
  assert.ok(activated);
  assert.equal((await w.deps.store.receipts.findByPlan(plan.plan_id, "FINAL")).length, 0);
  assert.equal((await w.deps.store.plans.get(plan.plan_id))?.plan_state, "TARGET_VERIFIED");

  const fresh = await boundHandle(w);
  assert.equal((await bindingOf(w, fresh))?.binding_mode, "BUSINESS");
  const resumed = await resume(w, fresh);
  assert.match((resumed.warnings ?? []).join(" | "), new RegExp(`La finalisation ${plan.plan_id.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")} a été confirmée après reconnexion et nouvelle lecture`));
  assert.equal((await w.deps.store.plans.get(plan.plan_id))?.plan_state, "FINAL_VERIFIED");
  assert.equal((await w.deps.store.receipts.findByPlan(plan.plan_id, "FINAL")).length, 1);
  // Reconciliation is bookkeeping only: it never bumps the generation a second time.
  assert.equal((await w.lookupRegistry())?.pointer_generation, "8");
});

/* ─────────────────────────── PT-INST-025: safe cold-resume across chat/process boundaries ─────────────────────────── */



test("PT-INST-025/a: a finalized structural proof is adopted by a fresh binding of the same principal/runtime/generation", async () => {
  const w = buildInstallWorld();
  const proving = await boundHandle(w);
  await runMapping(w, proving);

  // A new chat/process gets a fresh handle. The proof is not tied to chat memory: it is re-read and may drive the
  // separate identity finalization for this same authenticated principal/runtime/generation.
  const other = await boundHandle(w);
  assert.notEqual(other, proving);
  assert.equal((await installerIntent(w, other)).action_class, "INSTALL_PROMOTE");
  const mappingPlan = (await w.deps.store.plans.listByRuntime("VERTIGO", "SALES", (await bindingOf(w, other))!.runtime_generation)).find((p) => p.plan_kind === "INSTALL_MAPPING" && p.plan_state === "FINAL_VERIFIED");
  const replies = await installUntil(w, other, "reconnexion requise");
  assert.equal(replies.length, 1, "the adopted proof lets the fresh binding promote in one call");
  const promotion = (await w.deps.store.plans.listByRuntime("VERTIGO", "SALES", mappingPlan!.runtime_generation)).find((p) => p.plan_kind === "INSTALL_PROMOTION");
  assert.equal(promotion?.install_mapping_plan_id, mappingPlan?.plan_id, "the promotion is bound to the adopted mapping proof");
});

test("PT-INST-025/b: a process dying after any installation write resumes from Notion on a fresh binding and never replays CREATE", async () => {
  const w = buildInstallWorld();
  const client = writerOf(w);
  // Every call's first write is applied, then the process dies before journaling it DONE: the worst boundary.
  let crashes = 0;
  for (let i = 0; i < 200; i += 1) {
    client.fault({ times: 1 }, "CRASH_AFTER");
    const fresh = await boundHandle(w);
    let e: Awaited<ReturnType<typeof resume>> | undefined;
    try { e = await resume(w, fresh); } catch (err) { assert.equal((err as Error).name, "FixtureCrash", String(err)); crashes += 1; continue; }
    // A call that answers sent no write at all (a verification-only boundary); its armed crash waits for the next write.
    assert.equal(e.code, "RESUMED", detail(e));
    assertNoNativeAction(e);
    if (installationOf(e)["phase"] === "structure vérifiée") break;
  }
  assert.ok(crashes > 10, `the crash harness did not exercise enough boundaries (${crashes})`);
  assert.equal(client.writes.filter((x) => x.method === "createPage").length, 1, "the plan-bound verification row was created more than once");
  const binding = await bindingOf(w, await boundHandle(w));
  const plans = await w.deps.store.plans.listByRuntime("VERTIGO", "SALES", binding!.runtime_generation);
  const mapping = plans.find((p) => p.plan_kind === "INSTALL_MAPPING" && p.plan_state === "FINAL_VERIFIED");
  assert.ok(mapping, "the structural mapping never reached its FINAL proof");
  // The lost CREATE was adopted by its plan-bound Key, never guessed: journaled OBSERVED with the created row.
  const create = (await w.deps.store.planWrites.list(mapping.plan_id)).find((r) => r.operation === "CREATE");
  assert.equal(create?.status, "OBSERVED", JSON.stringify(create));
});

test("PT-INST-025/c: install adoption remains closed across principal, runtime id and generation boundaries", async () => {
  const w = buildInstallWorld();
  const handle = await boundHandle(w);
  const prepared = await prepare(w, handle, await installerIntent(w, handle));
  const plan = await planOf(w, prepared);
  const binding = await bindingOf(w, handle);
  assert.ok(binding);

  const same = await lookupPlan(w.deps.store.plans, plan.plan_id, binding.principal_id, { ...binding, binding_id: "fresh-binding" });
  assert.equal(same.ok, true, "same principal/runtime/generation must be adoptable after a new chat");
  const foreignPrincipal = await lookupPlan(w.deps.store.plans, plan.plan_id, "p-foreign", { ...binding, binding_id: "foreign", principal_id: "p-foreign" });
  assert.deepEqual(foreignPrincipal, { ok: false, reason: "PRINCIPAL_MISMATCH" });
  const foreignRuntime = await lookupPlan(w.deps.store.plans, plan.plan_id, binding.principal_id, { ...binding, binding_id: "other-runtime", runtime_id: "SALESOS-OTHER" });
  assert.deepEqual(foreignRuntime, { ok: false, reason: "PLAN_BINDING_MISMATCH" });
  const foreignGeneration = await lookupPlan(w.deps.store.plans, plan.plan_id, binding.principal_id, { ...binding, binding_id: "other-generation", runtime_generation: "other-generation" });
  assert.deepEqual(foreignGeneration, { ok: false, reason: "PLAN_BINDING_MISMATCH" });
});
