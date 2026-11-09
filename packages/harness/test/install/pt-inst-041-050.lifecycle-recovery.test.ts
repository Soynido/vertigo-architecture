/** INSTALL lifecycle recovery: cold restart, TTL expiry and live authority invalidation. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../../src/tools/handlers.ts";
import { expireIfDue, issueFinalReceipt, transition } from "../../src/plans/service.ts";
import { salesContractAdapter } from "../../src/versions/adapters/sales.ts";
import type { Plan } from "../../src/plans/store.ts";
import { installAssignmentSnapshot } from "../../src/registry/salesRuntimes.ts";
import { buildInstallWorld } from "../unit/install-fixtures.ts";
import { propText, type Page } from "../../src/notion/shapes.ts";
import { executeWrites, mutatePage, rowsOf } from "../unit/target-fixtures.ts";
import { REP_A, SGRAMMAR, SV } from "../unit/sales-fixtures.ts";
import {
  assertNoNativeAction, bindingOf, boundHandle, detail, finishPromotion, installerIntent, installationOf, planOf,
  prepare, preparePromotion, resume, result, runMapping, served, verify, writerOf,
} from "./drive.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import type { InstallWorld } from "../unit/install-fixtures.ts";

const at = (iso: Date) => ({ principal_id: REP_A.principal_id, now: iso });
const after = (date: Date, milliseconds = 1): Date => new Date(date.getTime() + milliseconds);
/** Public os_resume on the server writer at a pinned instant (cold restarts after an expiry). */
const resumeAt = (w: InstallWorld, handle: string, when: Date): Promise<Envelope> => dispatch("os_resume", { binding_handle: handle }, at(when), served(w));
/** Server os_resume from `when` until the installation reports `until`; every reply continues, none is native. */
async function settleAt(w: InstallWorld, handle: string, when: Date, until: string): Promise<Envelope[]> {
  const replies: Envelope[] = [];
  for (let i = 0; i < 12; i += 1) {
    const e = await resumeAt(w, handle, after(when, i));
    replies.push(e);
    assert.equal(e.code, "RESUMED", detail(e));
    assertNoNativeAction(e);
    if (installationOf(e)["phase"] === until) return replies;
  }
  assert.fail(`the installation did not reach « ${until} »`);
}
const creates = (w: InstallWorld): number => writerOf(w).writes.filter((x) => x.method === "createPage").length;
const recoveriesOf = async (w: InstallWorld, original: Plan): Promise<Plan[]> =>
  (await w.deps.store.plans.listByRuntime(original.project, original.lane, original.runtime_generation)).filter((p) => p.recovers_plan_id === original.plan_id);
/** The newest installation plan of this handle's assignment (what the server installer opened). */
async function newestInstallPlan(w: InstallWorld, handle: string): Promise<Plan> {
  const binding = await bindingOf(w, handle);
  const plans = (await w.deps.store.plans.listByRuntime(binding!.project, binding!.lane, binding!.runtime_generation)).filter((p) => p.plan_kind === "INSTALL_MAPPING" || p.plan_kind === "INSTALL_PROMOTION");
  const newest = [...plans].sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0];
  assert.ok(newest, "the server opened no installation plan");
  return newest;
}

test("PT-INST-041: duplicate os_prepare observes the existing plan and never replays an observed CREATE", async () => {
  const w = buildInstallWorld();
  const handle = await boundHandle(w);
  const intent = await installerIntent(w, handle);
  const first = await prepare(w, handle, intent);
  const plan = await planOf(w, first);
  const made = executeWrites(w, plan.stage1_writes, plan.plan_id, { now: "2030-01-02T00:00:00.000Z" });
  assert.ok(made["INSTALL_CANARY"]);

  const duplicate = await prepare(w, handle, intent);
  assert.equal(duplicate.code, "PLAN_PREPARED", detail(duplicate));
  assert.equal(result(duplicate)["replayed"], true);
  assert.equal(result(duplicate)["stage1_actions"], undefined);
  assert.deepEqual(result(duplicate)["verify"], { plan_id: plan.plan_id, phase: "TARGET" });
  assert.equal(rowsOf(w, w.ids.registryDs).filter((r) => JSON.stringify(r).includes(`VERIFICATION_INSTALLATION:${plan.plan_id}`)).length, 1);
});

test("PT-INST-042: an expired mapping plan cold-resumes under one lineage without replaying CREATE", async () => {
  const w = buildInstallWorld();
  const handle = await boundHandle(w);
  const prepared = await prepare(w, handle, await installerIntent(w, handle));
  const original = await planOf(w, prepared);
  executeWrites(w, original.stage1_writes, original.plan_id, { now: "2030-01-02T00:00:00.000Z" });

  const cold = await resumeAt(w, handle, after(original.expires_at));
  assert.equal(cold.code, "RESUMED", detail(cold));
  assertNoNativeAction(cold);
  const family = await recoveriesOf(w, original);
  assert.equal(family.length, 1, "the cold resume opened more than one recovery lineage");
  assert.equal((await w.deps.store.plans.get(original.plan_id))?.plan_state, "EXPIRED");
  assert.equal(rowsOf(w, w.ids.registryDs).filter((r) => JSON.stringify(r).includes(`VERIFICATION_INSTALLATION:${original.plan_id}`)).length, 1);

  // The server continues the recovered lineage to its structural proof without ever creating the row again.
  await settleAt(w, handle, after(original.expires_at, 10), "structure vérifiée");
  assert.equal((await w.deps.store.plans.get((family[0] as Plan).plan_id))?.plan_state, "FINAL_VERIFIED");
  assert.equal(creates(w), 0, "the server replayed the verification CREATE");
  assert.equal(rowsOf(w, w.ids.registryDs).filter((r) => JSON.stringify(r).includes(`VERIFICATION_INSTALLATION:${original.plan_id}`)).length, 1);
});

test("PT-INST-043: an expired mapping TARGET is re-proved on cold resume, preserving the canary", async () => {
  const w = buildInstallWorld();
  const handle = await boundHandle(w);
  const plan = await planOf(w, await prepare(w, handle, await installerIntent(w, handle)));
  const made = executeWrites(w, plan.stage1_writes, plan.plan_id, { now: "2030-01-02T00:00:00.000Z" });
  const canary = made["INSTALL_CANARY"] as string;
  const first = await verify(w, handle, plan.plan_id, "TARGET");
  assert.equal(result(first)["verification_step"], "étape intermédiaire", detail(first));
  mutatePage(w, canary, { Status: "EXPECTED" });
  const oldTarget = (await w.deps.store.receipts.findByPlan(plan.plan_id, "TARGET"))[0]!;
  await w.deps.store.receipts.insert({ ...oldTarget, expires_at: new Date(0) });

  const fresh = await boundHandle(w);
  const cold = await resume(w, fresh);
  assert.equal(cold.code, "RESUMED", detail(cold));
  assertNoNativeAction(cold);
  assert.equal((await w.deps.store.receipts.get(oldTarget.receipt_id))?.status, "EXPIRED");
  assert.equal((await w.deps.store.plans.get(plan.plan_id))?.plan_state, "SUPERSEDED");
  const family = await recoveriesOf(w, plan);
  assert.equal(family.length, 1);
  // The canary already said EXPECTED: the recovery re-proves that boundary and resolves the SAME row.
  assert.equal(creates(w), 0, "the canary was created again");
  assert.equal(rowsOf(w, w.ids.registryDs).filter((r) => JSON.stringify(r).includes(`VERIFICATION_INSTALLATION:${plan.plan_id}`)).length, 1);
  assert.equal(propText(w.map.get(`page:${canary}`) as Page, "Status"), "RESOLVED");
});

test("PT-INST-043/b: FINAL on a recovered descendant closes the whole mapping lineage and exposes promotion", async () => {
  const w = buildInstallWorld();
  const handle = await boundHandle(w);
  const original = await planOf(w, await prepare(w, handle, await installerIntent(w, handle)));
  const made = executeWrites(w, original.stage1_writes, original.plan_id, { now: "2030-01-02T00:00:00.000Z" });
  const canary = made["INSTALL_CANARY"] as string;
  const t0 = after(original.expires_at);

  // The server continues the recovered descendant to its FINAL structural proof.
  await settleAt(w, handle, t0, "structure vérifiée");
  const recovered = (await recoveriesOf(w, original))[0] as Plan;
  assert.equal((await w.deps.store.plans.get(recovered.plan_id))?.plan_state, "FINAL_VERIFIED");
  assert.equal(propText(w.map.get(`page:${canary}`) as Page, "Status"), "RESOLVED");

  // That FINAL closes the whole lineage: the next call promotes and never clones the EXPIRED ancestor again.
  const next = await resumeAt(w, handle, after(t0, 50));
  assert.equal(next.code, "RESUMED", detail(next));
  assert.equal(installationOf(next)["phase"], "reconnexion requise", detail(next));
  const afterResume = await w.deps.store.plans.listByRuntime(recovered.project, recovered.lane, recovered.runtime_generation);
  assert.equal(afterResume.filter((p) => p.plan_kind === "INSTALL_MAPPING" && p.recovers_plan_id === original.plan_id).length, 1, "resume cloned an EXPIRED/SUPERSEDED mapping ancestor after lineage FINAL");
  assert.equal(afterResume.filter((p) => p.plan_kind === "INSTALL_MAPPING" && p.plan_state === "AWAITING_STAGE1_WRITES").length, 0);
  assert.equal(afterResume.find((p) => p.plan_kind === "INSTALL_PROMOTION")?.install_mapping_plan_id, recovered.plan_id);
});

test("PT-INST-044: an expired promotion TARGET cold-resumes and can activate exactly once", async () => {
  const w = buildInstallWorld();
  const handle = await boundHandle(w);
  await runMapping(w, handle);
  const { plan, target } = await preparePromotion(w, handle);
  assert.equal(target.code, "TARGET_VERIFIED", detail(target));
  const oldTarget = (await w.deps.store.receipts.findByPlan(plan.plan_id, "TARGET"))[0]!;
  await w.deps.store.receipts.insert({ ...oldTarget, expires_at: new Date(0) });

  const fresh = await boundHandle(w);
  const cold = await resume(w, fresh);
  assert.equal(cold.code, "RESUMED", detail(cold));
  assertNoNativeAction(cold);
  assert.equal(installationOf(cold)["phase"], "reconnexion requise", detail(cold));
  const [recovered, ...others] = await recoveriesOf(w, plan);
  assert.ok(recovered);
  assert.equal(others.length, 0);
  assert.equal((await w.lookupRegistry())?.activation_proof_plan_id, recovered.plan_id);
  assert.equal((await w.deps.store.receipts.findByPlan(recovered.plan_id, "FINAL")).length, 1);
  assert.equal((await bindingOf(w, fresh))?.status, "STALE");
});

test("PT-INST-045: a committed activation reconciles after both plan and TARGET have expired", async () => {
  const w = buildInstallWorld();
  const handle = await boundHandle(w);
  await runMapping(w, handle);
  const { plan, target } = await preparePromotion(w, handle);
  assert.equal(target.code, "TARGET_VERIFIED", detail(target));
  executeWrites(w, plan.finalization_writes, plan.plan_id, { now: "2030-01-02T00:09:00.000Z" });
  executeWrites(w, [plan.state_last_write], plan.plan_id, { now: "2030-01-02T00:09:00.000Z" });
  const expectedAssignment = installAssignmentSnapshot(await w.lookupRegistry());
  assert.ok(expectedAssignment);
  assert.ok(await w.deps.salesRegistry.activateInstallation(expectedAssignment, plan.plan_id));
  const targetReceipt = (await w.deps.store.receipts.findByPlan(plan.plan_id, "TARGET"))[0]!;
  await w.deps.store.receipts.setStatus(targetReceipt.receipt_id, "EXPIRED");
  const recoveryTime = after(plan.expires_at);
  await expireIfDue(w.deps.store, plan, recoveryTime);
  assert.equal((await w.deps.store.plans.get(plan.plan_id))?.plan_state, "EXPIRED");

  const business = await boundHandle(w);
  assert.equal((await bindingOf(w, business))?.binding_mode, "BUSINESS");
  const resumed = await dispatch("os_resume", { binding_handle: business }, at(recoveryTime), w.deps);
  assert.equal((await w.deps.store.plans.get(plan.plan_id))?.plan_state, "FINAL_VERIFIED", detail(resumed));
  assert.equal((await w.deps.store.receipts.get(targetReceipt.receipt_id))?.status, "CONSUMED");
  assert.equal((await w.deps.store.receipts.findByPlan(plan.plan_id, "FINAL")).length, 1);
  assert.equal((await w.lookupRegistry())?.pointer_generation, "8");
});

test("PT-INST-045/b: committed activation survives a concurrent SUPERSEDED transition and converges once", async () => {
  const w = buildInstallWorld();
  const handle = await boundHandle(w);
  await runMapping(w, handle);
  const { plan, target } = await preparePromotion(w, handle);
  assert.equal(target.code, "TARGET_VERIFIED", detail(target));
  executeWrites(w, plan.finalization_writes, plan.plan_id, { now: "2030-01-02T00:09:00.000Z" });
  executeWrites(w, [plan.state_last_write], plan.plan_id, { now: "2030-01-02T00:09:00.000Z" });
  const expectedAssignment = installAssignmentSnapshot(await w.lookupRegistry());
  assert.ok(expectedAssignment);
  assert.ok(await w.deps.salesRegistry.activateInstallation(expectedAssignment, plan.plan_id));
  const targetReceipt = (await w.deps.store.receipts.findByPlan(plan.plan_id, "TARGET"))[0]!;
  await w.deps.store.receipts.setStatus(targetReceipt.receipt_id, "CONSUMED");
  await transition(w.deps.store, plan.plan_id, "SUPERSEDED", after(plan.created_at), { concurrent_cold_recovery: true });
  await assert.rejects(
    issueFinalReceipt(w.deps.store, plan, (await w.deps.store.receipts.get(targetReceipt.receipt_id))!, { must_not_commit: true }, after(plan.created_at, 2), { committed_install_proof_plan_id: "wrong-plan" }),
    /cannot finalize from SUPERSEDED/,
  );

  const first = await boundHandle(w);
  const second = await boundHandle(w);
  await Promise.all([resume(w, first), resume(w, second)]);
  assert.equal((await w.deps.store.plans.get(plan.plan_id))?.plan_state, "FINAL_VERIFIED");
  assert.equal((await w.deps.store.receipts.get(targetReceipt.receipt_id))?.status, "CONSUMED");
  assert.equal((await w.deps.store.receipts.findByPlan(plan.plan_id, "FINAL")).length, 1);
  const events = await w.deps.store.events.list({ plan_id: plan.plan_id });
  for (const type of ["PLAN_FINAL_VERIFIED", "FINAL_RECEIPT_ISSUED"]) {
    assert.equal(events.filter((event) => event.event_type === type).length, 1, `${type} did not converge once`);
  }
  assert.equal(events.filter((event) => event.event_type === "LEASE_RELEASED" && event.result === "FINAL_VERIFIED").length, 1, "FINAL lease reconciliation did not converge once");
});

test("PT-INST-046: a governing 0.5 -> 0.6 change stales the binding and invalidates the old plan", async () => {
  const w = buildInstallWorld();
  const handle = await boundHandle(w);
  const oldPlan = await planOf(w, await prepare(w, handle, await installerIntent(w, handle)));
  const nextSchema = "TEST_SALES_SCHEMA/2.0.0";
  w.deps.adapters.salesRuntime.register(SV.contractNext, salesContractAdapter(SV.contractNext, [nextSchema], SGRAMMAR));
  w.setManifest({ "Sales Contract Version": SV.contractNext, "Schema Version": nextSchema });

  const stale = await resume(w, handle);
  assert.equal(stale.code, "HOLD_VERSION_CHANGED", detail(stale));
  const fresh = await boundHandle(w);
  const restarted = await resume(w, fresh);
  assert.equal(restarted.code, "RESUMED", detail(restarted));
  const newPlan = await newestInstallPlan(w, fresh);
  assert.notEqual(newPlan.plan_id, oldPlan.plan_id);
  assert.equal(newPlan.governing_spec_version, SV.contractNext);
  assert.equal((await w.deps.store.plans.get(oldPlan.plan_id))?.plan_state, "SUPERSEDED");
});

test("PT-INST-047: changed expected Gmail invalidates the plan even when the physical generation is unchanged", async () => {
  const w = buildInstallWorld();
  const handle = await boundHandle(w);
  const oldPlan = await planOf(w, await prepare(w, handle, await installerIntent(w, handle)));
  const current = await w.lookupRegistry();
  assert.ok(current);
  w.setRegistry([{ ...current, expected_gmail_identity: "new-assignment@example.invalid" }]);

  const restarted = await resume(w, handle);
  assert.equal(restarted.code, "RESUMED", detail(restarted));
  const newPlan = await newestInstallPlan(w, handle);
  assert.notEqual(newPlan.install_context_fingerprint, oldPlan.install_context_fingerprint);
  assert.equal((await w.deps.store.plans.get(oldPlan.plan_id))?.plan_state, "SUPERSEDED");
});

test("PT-INST-048: reassigned runtime id stales the old handle and the fresh assignment starts a new plan", async () => {
  const w = buildInstallWorld();
  const handle = await boundHandle(w);
  const oldPlan = await planOf(w, await prepare(w, handle, await installerIntent(w, handle)));
  const current = await w.lookupRegistry();
  assert.ok(current);
  w.setRegistry([{ ...current, expected_instance_id: "SALESOS-INSTALL-B" }]);

  const stale = await resume(w, handle);
  assert.equal(stale.code, "HOLD_BINDING_STALE_RUNTIME_ROTATED", detail(stale));
  const fresh = await boundHandle(w);
  assert.equal((await bindingOf(w, fresh))?.runtime_id, "SALESOS-INSTALL-B");
  const restarted = await resume(w, fresh);
  assert.equal(restarted.code, "RESUMED", detail(restarted));
  const newPlan = await newestInstallPlan(w, fresh);
  assert.equal(newPlan.runtime_id, "SALESOS-INSTALL-B");
  assert.equal((await w.deps.store.plans.get(oldPlan.plan_id))?.plan_state, "SUPERSEDED");
});

test("PT-INST-049: concurrent cold recovery converges on one active lineage and one CREATE", async () => {
  const w = buildInstallWorld();
  const handle = await boundHandle(w);
  const original = await planOf(w, await prepare(w, handle, await installerIntent(w, handle)));
  executeWrites(w, original.stage1_writes, original.plan_id, { now: "2030-01-02T00:00:00.000Z" });
  const recoveryTime = after(original.expires_at);

  const attempts = await Promise.all([resumeAt(w, handle, recoveryTime), resumeAt(w, handle, recoveryTime)]);
  assert.ok(attempts.some((attempt) => attempt.code === "RESUMED"), attempts.map(detail).join("\n"));
  for (const attempt of attempts) assertNoNativeAction(attempt);

  const family = (await w.deps.store.plans.listByRuntime("VERTIGO", "SALES", original.runtime_generation))
    .filter((plan) => plan.plan_id === original.plan_id || plan.recovers_plan_id === original.plan_id);
  const live = family.filter((plan) => plan.recovers_plan_id === original.plan_id && plan.plan_state !== "SUPERSEDED" && plan.plan_state !== "EXPIRED");
  assert.equal(live.length, 1, JSON.stringify({ attempts: attempts.map((attempt) => ({ code: attempt.code, detail: detail(attempt) })), family: family.map((plan) => ({ id: plan.plan_id, recovers: plan.recovers_plan_id, state: plan.plan_state })) }));
  assert.equal(creates(w), 0, "a concurrent recovery replayed the verification CREATE");
  assert.equal(rowsOf(w, w.ids.registryDs).filter((row) => JSON.stringify(row).includes(`VERIFICATION_INSTALLATION:${original.plan_id}`)).length, 1);
});
