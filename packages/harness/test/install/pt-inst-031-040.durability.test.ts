/**
 * PT-INST-031..040 — the durability the activation actually rests on.
 *
 * P0-3: the backend INSTALL_PENDING → KNOWN transition must be a real compare-and-swap. The file registry is a
 * SINGLE-HOST, LOCAL-FILESYSTEM deployment, so the invariant proved here is: an exclusive mkdir lock directory
 * that fails closed on an existing lock, an unpredictable owner token for owner-safe release, a re-read inside
 * that lock, an fsync'd temp file renamed into place, and an fsync of the directory. These cases run REAL child
 * processes, because a Promise-local mutation queue would pass every in-process test and still let two harness
 * processes both activate.
 *
 * P0-4: receipt issuance must be idempotent and concurrency-safe, and the install FINAL phases must validate
 * their target receipt through checkTargetReceipt (TTL, ownership, consumption) rather than a bare status read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, stat, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { FileSalesRuntimeRegistry, InMemorySalesRuntimeRegistry, installAssignmentSnapshot, withRegistryLock, type InstallAssignmentSnapshot, type SalesRuntimeEntry } from "../../src/registry/salesRuntimes.ts";
import { createPlan, issueFinalReceipt, issueTargetReceipt } from "../../src/plans/service.ts";
import { loadConfig } from "../../src/config/index.ts";
import { createMemoryStore } from "../../src/store/memory.ts";
import type { BindingRecord } from "../../src/binding/store.ts";
import type { Plan } from "../../src/plans/store.ts";
import type { ReceiptRecord } from "../../src/verify/engine.ts";
import { buildInstallWorld } from "../unit/install-fixtures.ts";
import { draftFor } from "../unit/plan-fixtures.ts";
import { boundHandle, detail, preparePromotion, finishPromotion, resume, result, runMapping, verify } from "./drive.ts";

const run = promisify(execFile);
// fileURLToPath, not .pathname: this repository path contains a space and would arrive percent-encoded.
const CHILD = fileURLToPath(new URL("../support/install-activation-child.ts", import.meta.url));

const PENDING: SalesRuntimeEntry = {
  rep_identity_key: "rep-fixture", status: "INSTALL_PENDING", root_ref: "fixture-root",
  expected_instance_id: "SALESOS-FIXTURE-INSTALL", expected_gmail_identity: "rep-fixture@example.invalid", pointer_generation: "7",
};
const EXPECTED = installAssignmentSnapshot(PENDING) as InstallAssignmentSnapshot;

async function registryFile(entry: SalesRuntimeEntry = PENDING): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vertigo-install-"));
  const file = join(dir, "sales-runtimes.json");
  await writeFile(file, `${JSON.stringify({ runtimes: [entry] }, null, 2)}\n`, { mode: 0o600 });
  return file;
}

const read = async (file: string): Promise<SalesRuntimeEntry> =>
  (JSON.parse(await readFile(file, "utf8")) as { runtimes: SalesRuntimeEntry[] }).runtimes[0] as SalesRuntimeEntry;

/* ─────────────────────────── PT-INST-031: cross-process compare-and-swap ─────────────────────────── */

test("PT-INST-031/a: eight competing PROCESSES race the activation and exactly one wins", async () => {
  const file = await registryFile();
  const proofs = Array.from({ length: 8 }, (_, i) => `proof-${i}`);

  const outputs = await Promise.all(proofs.map((proof) =>
    run(process.execPath, [CHILD, file, JSON.stringify(EXPECTED), proof]).then((r) => JSON.parse(r.stdout.trim()) as { proof: string; won: boolean; error?: string })));

  const winners = outputs.filter((o) => o.won);
  assert.equal(winners.length, 1, `expected one winner, got ${JSON.stringify(outputs)}`);
  for (const loser of outputs.filter((o) => !o.won)) assert.equal(loser.error, undefined, `a loser errored instead of losing cleanly: ${loser.error}`);

  const entry = await read(file);
  assert.equal(entry.status, "KNOWN");
  assert.equal(entry.pointer_generation, "8", "the generation was bumped more than once");
  assert.equal(entry.activation_proof_plan_id, (winners[0] as { proof: string }).proof);
});

test("PT-INST-031/b: the race leaves no lock, no temp file and a 0600 registry", async () => {
  const file = await registryFile();
  await Promise.all(["a", "b", "c", "d"].map((p) => run(process.execPath, [CHILD, file, JSON.stringify(EXPECTED), p])));
  const left = await readdir(join(file, ".."));
  assert.deepEqual(left, ["sales-runtimes.json"], `leftover artifacts: ${left.join(", ")}`);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  // The file is whole: a torn write would not parse.
  assert.equal((await read(file)).status, "KNOWN");
});

test("PT-INST-031/c: a second process cannot re-activate an already activated assignment", async () => {
  const file = await registryFile();
  const first = JSON.parse((await run(process.execPath, [CHILD, file, JSON.stringify(EXPECTED), "p1"])).stdout.trim()) as { won: boolean };
  assert.equal(first.won, true);
  // Neither the old generation nor the new one may swap again: the status is no longer INSTALL_PENDING.
  for (const generation of ["7", "8"]) {
    const again = JSON.parse((await run(process.execPath, [CHILD, file, JSON.stringify({ ...EXPECTED, pointer_generation: generation }), "p2"])).stdout.trim()) as { won: boolean };
    assert.equal(again.won, false, `a re-activation succeeded at generation ${generation}`);
  }
  assert.equal((await read(file)).activation_proof_plan_id, "p1");
});

test("PT-INST-031/d: the compare half is honoured — a stale generation, a wrong key and a non-pending status all lose", async () => {
  const file = await registryFile();
  const registry = new FileSalesRuntimeRegistry(file);
  assert.equal(await registry.activateInstallation({ ...EXPECTED, pointer_generation: "6" }, "stale"), undefined);
  assert.equal(await registry.activateInstallation({ ...EXPECTED, pointer_generation: null }, "absent"), undefined);
  assert.equal(await registry.activateInstallation({ ...EXPECTED, rep_identity_key: "someone-else" }, "wrong-key"), undefined);
  assert.equal((await read(file)).status, "INSTALL_PENDING", "a losing CAS still rewrote the file");

  const known = await registryFile({ ...PENDING, status: "KNOWN" });
  assert.equal(await new FileSalesRuntimeRegistry(known).activateInstallation(EXPECTED, "p"), undefined);
});

test("PT-INST-031/e: the in-memory registry applies exactly the same compare half", async () => {
  const memory = new InMemorySalesRuntimeRegistry([PENDING]);
  assert.equal(await memory.activateInstallation({ ...EXPECTED, pointer_generation: "6" }, "stale"), undefined);
  const won = await memory.activateInstallation(EXPECTED, "p1");
  assert.equal(won?.pointer_generation, "8");
  assert.equal(await memory.activateInstallation({ ...EXPECTED, pointer_generation: "8" }, "p2"), undefined);
});

test("PT-INST-031/e2: assignment drift immediately before CAS always loses", async () => {
  const mutations: readonly SalesRuntimeEntry[] = [
    { ...PENDING, root_ref: "replacement-root" },
    { ...PENDING, expected_instance_id: "SALESOS-REASSIGNED" },
    { ...PENDING, expected_gmail_identity: "reassigned@example.invalid" },
    { ...PENDING, objective_package_ref: "objective/reassigned" },
  ];
  for (const [index, changed] of mutations.entries()) {
    const file = await registryFile(changed);
    assert.equal(await new FileSalesRuntimeRegistry(file).activateInstallation(EXPECTED, `file-drift-${index}`), undefined);
    assert.equal((await read(file)).status, "INSTALL_PENDING");

    const memory = new InMemorySalesRuntimeRegistry([changed]);
    assert.equal(await memory.activateInstallation(EXPECTED, `memory-drift-${index}`), undefined);
    assert.equal((await memory.lookup(PENDING.rep_identity_key))?.status, "INSTALL_PENDING");
  }
});

test("PT-INST-031/f: the lock is exclusive and is released even when the critical section throws", async () => {
  const file = await registryFile();
  let inside = 0;
  let overlap = 0;
  await Promise.all(Array.from({ length: 6 }, () => withRegistryLock(file, async () => {
    inside += 1;
    if (inside > 1) overlap += 1;
    await new Promise((r) => { setTimeout(r, 5); });
    inside -= 1;
  })));
  assert.equal(overlap, 0, "two critical sections overlapped");

  await assert.rejects(withRegistryLock(file, async () => { throw new Error("boom"); }), /boom/);
  // The lock must be gone, so the next writer is not blocked for the whole timeout.
  assert.equal(await withRegistryLock(file, async () => "free"), "free");
});

test("PT-INST-031/g: an abandoned lock fails closed and is never age-reaped", async () => {
  const file = await registryFile();
  const lock = `${file}.lock`;
  await mkdir(lock, { mode: 0o700 });
  await writeFile(join(lock, "owner-crashed"), "crash footprint", { mode: 0o600 });

  await assert.rejects(
    withRegistryLock(file, async () => "must-not-run", { acquireTimeoutMs: 30, retryMs: 2 }),
    /is held; activation was not attempted/,
  );
  assert.equal(await readFile(join(lock, "owner-crashed"), "utf8"), "crash footprint", "contender reaped an existing lock");
  await rm(lock, { recursive: true });
});

test("PT-INST-031/h: release never removes a replacement owner's lock", async () => {
  const file = await registryFile();
  const lock = `${file}.lock`;
  const displaced = `${file}.lock.displaced`;
  await withRegistryLock(file, async () => {
    // Simulate explicit operator intervention at the worst instant: our inode is moved away and a new owner has
    // already acquired the public path before our finally block runs.
    await rename(lock, displaced);
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, "owner-replacement"), "new owner", { mode: 0o600 });
  });
  assert.equal(await readFile(join(lock, "owner-replacement"), "utf8"), "new owner", "owner-blind release deleted a replacement lock");
  await rm(lock, { recursive: true });
  await rm(displaced, { recursive: true });
});

/* ─────────────────────────── PT-INST-032: receipt issuance is idempotent and TTL-checked ─────────────────────────── */

test("PT-INST-032/a: concurrent TARGET issuance yields exactly one receipt", async () => {
  const w = buildInstallWorld();
  const handle = await boundHandle(w);
  const resumed = await resume(w, handle);
  const prepared = await (await import("./drive.ts")).prepare(w, handle, (result(resumed)["installation"] as { prepare_intent: never }).prepare_intent);
  const plan = (await w.deps.store.plans.get(result(prepared)["plan_id"] as string))!;
  const now = new Date("2030-01-02T00:00:00.000Z");

  const issued = await Promise.all(Array.from({ length: 5 }, () => issueTargetReceipt(w.deps.store, w.deps.config, plan, { install_phase: "CANARY_CREATED_AND_FETCHED" }, now)));
  assert.equal(new Set(issued.map((r) => r.receipt_id)).size, 1, "concurrent issuance minted more than one receipt");
  assert.equal((await w.deps.store.receipts.findByPlan(plan.plan_id, "TARGET")).length, 1);
});

test("PT-INST-032/b: a target receipt past its TTL can no longer carry the mapping to FINAL", async () => {
  const w = buildInstallWorld();
  const handle = await boundHandle(w);
  const mapping = await runMappingUpToTarget(w, handle);

  // The receipt's window closes before FINAL is attempted.
  const receipt = (await w.deps.store.receipts.get(mapping.targetReceiptId))!;
  await w.deps.store.receipts.insert({ ...receipt, expires_at: new Date(Date.now() - 60_000) });

  const e = await verify(w, handle, mapping.planId, "FINAL");
  assert.equal(e.status, "HOLD", detail(e));
  assert.equal(e.code, "HOLD_TARGET_RECEIPT_INVALID", detail(e));
  assert.match(detail(e), /mapping target receipt is EXPIRED/);
  assert.equal((await w.deps.store.receipts.findByPlan(mapping.planId, "FINAL")).length, 0);
});

test("PT-INST-032/c: TTLs are server configuration, never caller input", async () => {
  const config = loadConfig({ VERTIGO_META_SPEC_ROOT: "https://example.invalid/root", HARNESS_ENV: "fixture", PRINCIPALS_FILE: "x" });
  assert.ok(config.targetReceiptTtlMinutes > 0);
  assert.ok(config.planTtlMinutes > 0);
});

/** Runs the mapping through TARGET (canary fully terminal, finalization written) but stops before FINAL. */
async function runMappingUpToTarget(w: ReturnType<typeof buildInstallWorld>, handle: string): Promise<{ planId: string; targetReceiptId: string }> {
  const { executeWrites, mutatePage } = await import("../unit/target-fixtures.ts");
  const drive = await import("./drive.ts");
  const resumed = await resume(w, handle);
  const prepared = await drive.prepare(w, handle, await drive.installerIntent(w, handle));
  const plan = (await w.deps.store.plans.get(result(prepared)["plan_id"] as string))!;
  const created = executeWrites(w, plan.stage1_writes, plan.plan_id, { now: "2030-01-02T00:00:00.000Z" });
  const canaryRef = created["INSTALL_CANARY"] as string;
  await verify(w, handle, plan.plan_id, "TARGET");
  mutatePage(w, canaryRef, { Status: "EXPECTED" }, "2030-01-02T00:05:00.000Z");
  await verify(w, handle, plan.plan_id, "TARGET");
  mutatePage(w, canaryRef, { Status: "RESOLVED" }, "2030-01-02T00:06:00.000Z");
  const target = await verify(w, handle, plan.plan_id, "TARGET");
  assert.equal(target.code, "TARGET_VERIFIED", detail(target));
  executeWrites(w, plan.finalization_writes, plan.plan_id, { ...({ now: "2030-01-02T00:07:00.000Z" }), created: created, target_receipt_id: "receipt" });
  return { planId: plan.plan_id, targetReceiptId: result(target)["target_receipt_id"] as string };
}

/* ─────────────────────────── PT-INST-033: the promotion's own receipt is TTL-checked too ─────────────────────────── */

test("PT-INST-033: an expired promotion target receipt cannot activate the backend", async () => {
  const w = buildInstallWorld();
  const handle = await boundHandle(w);
  await runMapping(w, handle);
  const { plan, target } = await preparePromotion(w, handle);
  assert.equal(target.code, "TARGET_VERIFIED", detail(target));

  const receiptId = result(target)["target_receipt_id"] as string;
  const receipt = (await w.deps.store.receipts.get(receiptId))!;
  await w.deps.store.receipts.insert({ ...receipt, expires_at: new Date(Date.now() - 60_000) });

  const e = await finishPromotion(w, handle, plan);
  assert.equal(e.status, "HOLD", detail(e));
  assert.match(detail(e), /promotion target receipt is EXPIRED/);
  assert.equal((await w.lookupRegistry())?.status, "INSTALL_PENDING");
});

test("PT-INST-033/b: assignment drift injected at the CAS boundary cannot activate or finalize", async () => {
  const changes: readonly Partial<SalesRuntimeEntry>[] = [
    { root_ref: "reassigned-root" },
    { expected_instance_id: "SALESOS-REASSIGNED" },
    { expected_gmail_identity: "reassigned@example.invalid" },
  ];
  for (const [index, change] of changes.entries()) {
    const w = buildInstallWorld();
    const handle = await boundHandle(w);
    await runMapping(w, handle);
    const { plan, target } = await preparePromotion(w, handle);
    assert.equal(target.code, "TARGET_VERIFIED", detail(target));
    const pending = await w.lookupRegistry();
    assert.ok(pending);

    const registry = w.deps.salesRegistry as { activateInstallation: typeof w.deps.salesRegistry.activateInstallation };
    const activate = registry.activateInstallation.bind(registry);
    registry.activateInstallation = async (expected, proof) => {
      w.setRegistry([{ ...pending, ...change }]);
      return activate(expected, proof);
    };

    const held = await finishPromotion(w, handle, plan);
    assert.equal(held.code, "HOLD_CONFLICT", `${index}: ${detail(held)}`);
    assert.equal((await w.lookupRegistry())?.status, "INSTALL_PENDING");
    assert.equal((await w.lookupRegistry())?.activation_proof_plan_id, undefined);
    assert.equal((await w.deps.store.receipts.findByPlan(plan.plan_id, "FINAL")).length, 0);
  }
});

/* ───────────────────── PT-INST-034..037: receipt/plan crash convergence ───────────────────── */

const TERMINAL_NOW = new Date("2030-02-01T00:00:00.000Z");

async function terminalFixture(kind: "BUSINESS" | "INSTALL_MAPPING" = "INSTALL_MAPPING"): Promise<{
  store: ReturnType<typeof createMemoryStore>;
  config: ReturnType<typeof loadConfig>;
  binding: BindingRecord;
  plan: Plan;
}> {
  const store = createMemoryStore();
  const config = loadConfig({ VERTIGO_META_SPEC_ROOT: "https://example.invalid/root", HARNESS_ENV: "fixture", PRINCIPALS_FILE: "x" });
  const binding: BindingRecord = {
    binding_id: "b-terminal-1", handle_hash: "f".repeat(64), principal_id: "p-terminal", project: "VERTIGO", lane: "SALES",
    runtime_logical_key: "VERTIGO/SALES/p-terminal", runtime_id: "rt-terminal", runtime_generation: "gen-terminal",
    binding_mode: kind === "BUSINESS" ? "BUSINESS" : "INSTALL_ONLY", install_phase: kind === "BUSINESS" ? "NOT_APPLICABLE" : "INSTALL_PENDING",
    resolved_manifest_ref: "manifest-terminal", governing_versions_snapshot: { spec: "s" }, status: "BOUND",
    created_at: TERMINAL_NOW, expires_at: new Date(TERMINAL_NOW.getTime() + 3_600_000),
  };
  await store.bindings.insert(binding);
  const created = await createPlan(store, config, { ...draftFor(binding, ["terminal-op"]), plan_kind: kind }, TERMINAL_NOW);
  assert.equal(created.kind, "CREATED");
  return { store, config, binding, plan: (created as { plan: Plan }).plan };
}

const targetRow = (plan: Plan, id: string): ReceiptRecord => ({
  receipt_id: id, type: "TARGET", plan_id: plan.plan_id, principal_id: plan.principal_id,
  runtime_id: plan.runtime_id, runtime_generation: plan.runtime_generation, observed_at: TERMINAL_NOW,
  observations: { checked: true }, expires_at: new Date(TERMINAL_NOW.getTime() + 600_000), status: "VALID",
});

test("PT-INST-034: an incumbent TARGET heals a plan transition missed before crash", async () => {
  const { store, config, plan } = await terminalFixture();
  const inserted = targetRow(plan, "target-before-transition");
  await store.receipts.insert(inserted); // historical crash: receipt commit won, process died before plan transition

  const recovered = await issueTargetReceipt(store, config, plan, { retry: true }, TERMINAL_NOW);
  assert.equal(recovered.receipt_id, inserted.receipt_id);
  assert.equal((await store.plans.get(plan.plan_id))?.plan_state, "TARGET_VERIFIED");
  const events = await store.events.list({ plan_id: plan.plan_id });
  assert.ok(events.some((e) => e.event_type === "PLAN_TARGET_VERIFIED"));
  assert.ok(events.some((e) => e.event_type === "TARGET_RECEIPT_ISSUED" && e.receipt_id === inserted.receipt_id));
});

test("PT-INST-035: a consumed TARGET without FINAL is recovered atomically", async () => {
  const { store, config, plan } = await terminalFixture();
  const target = await issueTargetReceipt(store, config, plan, { checked: true }, TERMINAL_NOW);
  await store.receipts.setStatus(target.receipt_id, "CONSUMED"); // historical crash between the first two writes
  const consumed = (await store.receipts.get(target.receipt_id)) as ReceiptRecord;

  const final = await issueFinalReceipt(store, plan, consumed, { recovered: "after-target-consume" }, TERMINAL_NOW);
  assert.equal((await store.plans.get(plan.plan_id))?.plan_state, "FINAL_VERIFIED");
  assert.equal((await store.receipts.get(target.receipt_id))?.status, "CONSUMED");
  assert.equal((await store.receipts.findByPlan(plan.plan_id, "FINAL")).length, 1);
  assert.equal((await store.receipts.findByPlan(plan.plan_id, "FINAL"))[0]?.receipt_id, final.receipt_id);
  assert.equal(await store.leases.current({ project: plan.project, lane: plan.lane, runtime_generation: plan.runtime_generation }, TERMINAL_NOW), undefined);
});

test("PT-INST-036: an inserted FINAL heals plan/lease/events and never mints a second receipt", async () => {
  const { store, config, plan } = await terminalFixture();
  const target = await issueTargetReceipt(store, config, plan, { checked: true }, TERMINAL_NOW);
  const incumbent: ReceiptRecord = {
    receipt_id: "final-before-transition", type: "FINAL", plan_id: plan.plan_id, principal_id: plan.principal_id,
    runtime_id: plan.runtime_id, runtime_generation: plan.runtime_generation, target_receipt_id: target.receipt_id,
    observed_at: TERMINAL_NOW, observations: { recovered: "after-final-insert" }, status: "VALID",
  };
  await store.receipts.insert(incumbent); // historical crash: FINAL commit won, bookkeeping did not

  const returned = await issueFinalReceipt(store, plan, target, { ignored: "incumbent-wins" }, TERMINAL_NOW);
  assert.equal(returned.receipt_id, incumbent.receipt_id);
  assert.equal((await store.plans.get(plan.plan_id))?.plan_state, "FINAL_VERIFIED");
  assert.equal((await store.receipts.get(target.receipt_id))?.status, "CONSUMED");
  assert.equal((await store.receipts.findByPlan(plan.plan_id, "FINAL")).length, 1);
  const events = await store.events.list({ plan_id: plan.plan_id });
  for (const type of ["PLAN_FINAL_VERIFIED", "FINAL_RECEIPT_ISSUED", "LEASE_RELEASED"]) assert.equal(events.filter((e) => e.event_type === type).length, 1, `${type} did not converge exactly once`);
});

test("PT-INST-037: concurrent FINAL calls return one receipt and one terminal audit sequence", async () => {
  const { store, config, plan } = await terminalFixture();
  const target = await issueTargetReceipt(store, config, plan, { checked: true }, TERMINAL_NOW);
  const finals = await Promise.all(Array.from({ length: 8 }, (_, i) => issueFinalReceipt(store, plan, target, { contender: i }, TERMINAL_NOW)));
  assert.equal(new Set(finals.map((r) => r.receipt_id)).size, 1);
  assert.equal((await store.receipts.findByPlan(plan.plan_id, "FINAL")).length, 1);
  const events = await store.events.list({ plan_id: plan.plan_id });
  for (const type of ["PLAN_FINAL_VERIFIED", "FINAL_RECEIPT_ISSUED", "LEASE_RELEASED"]) assert.equal(events.filter((e) => e.event_type === type).length, 1, `${type} duplicated under concurrency`);
});

test("PT-INST-038: INSTALL plans resume across a fresh binding; BUSINESS plans remain binding-scoped", async () => {
  const install = await terminalFixture("INSTALL_MAPPING");
  const freshBinding: BindingRecord = { ...install.binding, binding_id: "b-terminal-2", handle_hash: "e".repeat(64) };
  await install.store.bindings.insert(freshBinding);
  const resumed = await createPlan(install.store, install.config, { ...draftFor(freshBinding, ["terminal-op"]), plan_kind: "INSTALL_MAPPING" }, TERMINAL_NOW);
  assert.equal(resumed.kind, "EXISTING");
  assert.equal((resumed as { plan: Plan }).plan.plan_id, install.plan.plan_id);

  const business = await terminalFixture("BUSINESS");
  const otherBusinessBinding: BindingRecord = { ...business.binding, binding_id: "b-business-2", handle_hash: "d".repeat(64) };
  await business.store.bindings.insert(otherBusinessBinding);
  const blocked = await createPlan(business.store, business.config, draftFor(otherBusinessBinding, ["terminal-op"]), TERMINAL_NOW);
  assert.equal(blocked.kind, "BUSY", "BUSINESS plan from a fresh binding was incorrectly treated as the same plan");
});
