/**
 * PT-INST-051..057 — W3.3 (BUILD TARGET, PLUGIN_SPEC/0.5.0-candidate, NOT ADOPTED): an INSTALL_ONLY os_resume installs
 * on the server, by batches of at most K = 30 Notion write requests per call, and never hands a native action or a
 * retired tool to the chat.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { INSTALL_WRITES_PER_CALL } from "../../src/install/execute.ts";
import { normalizeId, propText, type Page } from "../../src/notion/shapes.ts";
import type { Plan } from "../../src/plans/store.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import { dispatch } from "../../src/tools/handlers.ts";
import type { TransactionDeps } from "../../src/transactions/execute.ts";
import { buildInstallWorld, type InstallWorld } from "../unit/install-fixtures.ts";
import { REP_A } from "../unit/sales-fixtures.ts";
import { rowsOf } from "../unit/target-fixtures.ts";
import {
  assertNoNativeAction, bindingOf, boundHandle, CTX, detail, installationOf, installFully, installUntil, resume,
  resumeWithoutWriter, served, writerOf, writesSentOf,
} from "./drive.ts";

const T0 = new Date("2030-01-02T00:00:00.000Z");
const at = (ms: number) => ({ principal_id: REP_A.principal_id, now: new Date(T0.getTime() + ms) });
const resumeAt = (w: InstallWorld, handle: string, ms: number): Promise<Envelope> => dispatch("os_resume", { binding_handle: handle }, at(ms), served(w));
const plansOf = async (w: InstallWorld, handle: string) => {
  const b = await bindingOf(w, handle);
  return w.deps.store.plans.listByRuntime(b!.project, b!.lane, b!.runtime_generation);
};
const canaryRows = (w: InstallWorld): Page[] => rowsOf(w, w.ids.registryDs).filter((r) => (propText(r, "Key") ?? "").startsWith("VERIFICATION_INSTALLATION:"));

test("PT-INST-051: without a Notion writer os_resume answers HOLD_INSTALL_REQUIRED — no plan, no write, no native action", async () => {
  const w = buildInstallWorld();
  const handle = await boundHandle(w);
  const before = JSON.stringify([...w.map.entries()].sort(([a], [b]) => a.localeCompare(b)));
  for (let i = 0; i < 2; i += 1) {
    const e = await resumeWithoutWriter(w, handle);
    assert.equal(e.status, "HOLD", detail(e));
    assert.equal(e.code, "HOLD_INSTALL_REQUIRED", detail(e));
    assert.match(detail(e), /no Notion writer/);
    assert.equal(e.next.permitted_tool_call, undefined, "a refusal without writer must not route the chat anywhere");
    assert.equal(e.next.native_actions_required, undefined);
    assertNoNativeAction(e);
  }
  assert.equal((await plansOf(w, handle)).length, 0, "a plan was opened without a writer");
  assert.equal(JSON.stringify([...w.map.entries()].sort(([a], [b]) => a.localeCompare(b))), before, "the clone changed without a writer");
});

test("PT-INST-052: every call sends at most K = 30 writes, and the verified mapping never crosses into promotion in the same call", async () => {
  assert.equal(INSTALL_WRITES_PER_CALL, 30);
  const w = buildInstallWorld();
  const handle = await boundHandle(w);
  const client = writerOf(w);
  const counts: number[] = [];
  let e: Envelope;
  do {
    const before = client.writes.length;
    e = await resume(w, handle);
    assert.equal(e.code, "RESUMED", detail(e));
    assertNoNativeAction(e);
    counts.push(client.writes.length - before);
    assert.equal(writesSentOf(e), client.writes.length - before, "writes_sent is not the number of requests actually sent");
    assert.ok(client.writes.length - before <= INSTALL_WRITES_PER_CALL, `a call sent ${client.writes.length - before} writes`);
  } while (installationOf(e)["phase"] !== "structure vérifiée" && counts.length < 10);
  assert.ok(counts.length > 1 && counts.slice(0, -1).every((n) => n === INSTALL_WRITES_PER_CALL), `the mapping was not batched by K: ${counts.join(", ")}`);

  // The call that proved the mapping prepared nothing further and wrote nothing of the promotion.
  assert.equal((await plansOf(w, handle)).filter((p) => p.plan_kind === "INSTALL_PROMOTION").length, 0, "the mapping call crossed into promotion");
  assert.equal(propText(w.map.get(`page:${w.ids.manifestRow}`) as Page, "Install State"), "UNBOUND");
  assert.equal(e.next.permitted_tool_call, "os_resume");

  // The next call is the promotion alone.
  const promoted = await resume(w, handle);
  assert.equal(installationOf(promoted)["phase"], "reconnexion requise", detail(promoted));
  assert.equal(writesSentOf(promoted), 2);
});

test("PT-INST-053: promotion FINAL stales the binding; the next call is os_bind and the old handle runs nothing", async () => {
  const w = buildInstallWorld();
  const { handle, promotion } = await installFully(w);
  const final = promotion.finalEnvelope;
  assert.equal(final.next.permitted_tool_call, "os_bind");
  assert.match(final.next.conduct ?? "", /os_bind/);
  assert.doesNotMatch(final.next.conduct ?? "", /os_prepare|os_verify/);
  assert.equal((await bindingOf(w, handle))?.status, "STALE");
  const writes = writerOf(w).writes.length;
  const reused = await resume(w, handle);
  assert.equal(reused.code, "HOLD_BINDING_STALE", detail(reused));
  assert.equal(writerOf(w).writes.length, writes, "a stale installer handle still wrote");
  const fresh = await boundHandle(w);
  assert.equal((await bindingOf(w, fresh))?.binding_mode, "BUSINESS");
});

test("PT-INST-054: a lost canary CREATE is never resent in the call that lost it; it waits out the index lag, then resends the same payload once", async () => {
  const w = buildInstallWorld();
  // Bound at the same pinned instant as every call below, so the handle's TTL is measured on one clock.
  const bound = await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, at(0), w.deps);
  assert.equal(bound.code, "BOUND", detail(bound));
  const handle = (bound as Extract<Envelope, { status: "OK" }>).result["binding_handle"] as string;
  const client = writerOf(w);
  client.fault({ symbol: "INSTALL_VERIFICATION", method: "createPage" }, "LOSE");
  let e = await resumeAt(w, handle, 0);
  for (let i = 0; i < 5 && !client.writes.some((x) => x.fault === "LOSE"); i += 1) e = await resumeAt(w, handle, 1);
  assert.ok(client.writes.some((x) => x.fault === "LOSE"), `the canary CREATE was never attempted: ${detail(e)}`);
  assert.equal(e.code, "RESUMED", detail(e));
  assert.equal(installationOf(e)["stopped_at"], "INTERRUPTED", detail(e));
  assert.equal(client.writes.filter((x) => x.method === "createPage").length, 1, "the lost CREATE was resent in the same call");

  // Inside the index-lag window the row may simply not be visible yet: nothing is sent.
  const sent = client.writes.length;
  e = await resumeAt(w, handle, 10_000);
  assert.equal(installationOf(e)["stopped_at"], "INDEX_LAG", detail(e));
  assert.equal(client.writes.length, sent);

  // Past the window and still absent: the identical payload is sent once more, and journaled as the same write.
  e = await resumeAt(w, handle, 60_000);
  const createsSent = client.writes.filter((x) => x.method === "createPage");
  assert.equal(createsSent.length, 2);
  assert.deepEqual(createsSent[1]?.properties, createsSent[0]?.properties, "the resend carried another payload");
  assert.equal(canaryRows(w).length, 1);
  const mapping = (await plansOf(w, handle)).find((p) => p.plan_kind === "INSTALL_MAPPING");
  const row = (await w.deps.store.planWrites.list(mapping!.plan_id)).find((r) => r.symbol === "INSTALL_VERIFICATION");
  assert.equal(row?.status, "DONE");
  assert.equal(row?.attempts, 2);
});

test("PT-INST-055: a CREATE applied but unanswered is adopted by its plan-bound Key on the next call, never created twice", async () => {
  const w = buildInstallWorld();
  const handle = await boundHandle(w);
  const client = writerOf(w);
  client.fault({ symbol: "INSTALL_VERIFICATION", method: "createPage" }, "APPLY_THEN_FAIL");
  let e: Envelope;
  let calls = 0;
  do { e = await resume(w, handle); calls += 1; } while (calls < 5 && installationOf(e)["phase"] !== "structure vérifiée" && !client.writes.some((x) => x.fault === "APPLY_THEN_FAIL"));
  assert.ok(client.writes.some((x) => x.fault === "APPLY_THEN_FAIL"), detail(e));
  if (installationOf(e)["phase"] !== "structure vérifiée") await installUntil(w, handle, "structure vérifiée");
  assert.equal(client.writes.filter((x) => x.method === "createPage").length, 1);
  assert.equal(canaryRows(w).length, 1);
  const mapping = (await plansOf(w, handle)).find((p) => p.plan_kind === "INSTALL_MAPPING");
  const row = (await w.deps.store.planWrites.list(mapping!.plan_id)).find((r) => r.symbol === "INSTALL_VERIFICATION");
  assert.equal(row?.status, "OBSERVED");
  assert.equal(row?.created_id, normalizeId((canaryRows(w)[0] as Page).id));
});

test("PT-INST-056: a lost UPDATE is resent once in the same call, and the resend counts against K", async () => {
  const w = buildInstallWorld();
  const handle = await boundHandle(w);
  const client = writerOf(w);
  client.fault({ nth: 3 }, "LOSE");
  const e = await resume(w, handle);
  assert.equal(e.code, "RESUMED", detail(e));
  assert.equal(client.writes.length, INSTALL_WRITES_PER_CALL, "the resend was not counted against the batch");
  assert.equal(writesSentOf(e), INSTALL_WRITES_PER_CALL);
  const [lost, resent] = client.writes.slice(2, 4);
  assert.equal(lost?.fault, "LOSE");
  assert.equal(resent?.target, lost?.target);
  assert.deepEqual(resent?.properties, lost?.properties);
});

test("PT-INST-057: every installation write is confined to the assigned clone's Registry, its Manifest and OS State rows", async () => {
  const w = buildInstallWorld();
  await installFully(w);
  const registry = new Set(Object.values(w.ids.registryRows).map((id) => normalizeId(id)));
  const canaries = new Set(canaryRows(w).map((r) => normalizeId(r.id)));
  const allowed = new Set([...registry, ...canaries, normalizeId(w.ids.manifestRow), normalizeId(w.ids.stateRow)]);
  for (const x of writerOf(w).writes) {
    if (x.method === "createPage") assert.equal(normalizeId(x.target), normalizeId(w.ids.registryDs), "a row was created outside the clone Registry");
    else assert.ok(allowed.has(normalizeId(x.target)), `an update reached ${x.target}, outside the installation's rows`);
  }
  // Copied history is never touched: no Run, Ledger or business row was written.
  assert.ok(!writerOf(w).writes.some((x) => normalizeId(x.target) === normalizeId(w.ids.foreignMaster)));
});

test("PT-INST-058: a canary this call created but cannot find yet is index lag, never a false HOLD nor a second CREATE", async () => {
  const w = buildInstallWorld();
  const handle = await boundHandle(w);
  const client = writerOf(w);
  client.fault({ symbol: "INSTALL_VERIFICATION", method: "createPage" }, "HIDE_FROM_QUERIES");
  // Reads go through the writer's own client here, so its query index can lag behind the row it just created.
  const lagging = (): Promise<Envelope> => dispatch("os_resume", { binding_handle: handle }, { principal_id: REP_A.principal_id }, { ...served(w), notion: client });
  let e: Envelope = await lagging();
  for (let i = 0; i < 4 && !client.writes.some((x) => x.fault === "HIDE_FROM_QUERIES"); i += 1) e = await lagging();
  assert.equal(e.code, "RESUMED", detail(e));
  assert.equal(installationOf(e)["stopped_at"], "INDEX_LAG", detail(e));
  assert.equal(client.writes.filter((x) => x.method === "createPage").length, 1);
});

test("PT-INST-059: two overlapping installation calls never write the same plan at once, and create the canary once", async () => {
  const w = buildInstallWorld();
  const first = await boundHandle(w);
  const second = await boundHandle(w);
  for (let round = 0; round < 6; round += 1) {
    const replies = await Promise.all([resume(w, first), resume(w, second)]);
    for (const r of replies) assertNoNativeAction(r);
    if (replies.some((r) => installationOf(r)["phase"] === "structure vérifiée")) break;
  }
  assert.equal(writerOf(w).writes.filter((x) => x.method === "createPage").length, 1, "overlapping calls created the canary twice");
  assert.equal(canaryRows(w).length, 1);
});

test("PT-INST-060: an update substituted onto another row of the same plan is refused — zero writes, nothing journaled, no row modified", async () => {
  const w = buildInstallWorld();
  const handle = await boundHandle(w);
  const client = writerOf(w);
  const real = w.deps.store.plans;
  // The continuation is handed a plan whose MAP_0 points at MAP_1's row: a row the plan targets, but not for MAP_0.
  const substitute = (p: Plan): Plan => {
    if (p.plan_kind !== "INSTALL_MAPPING") return p;
    const other = p.stage1_writes.find((x) => x.symbol === "MAP_1");
    assert.ok(other, "the mapping plan has fewer than two rows");
    return { ...p, stage1_writes: p.stage1_writes.map((x) => (x.symbol === "MAP_0" ? { ...x, target_ref: other.target_ref } : x)) };
  };
  const tampered: TransactionDeps = { ...served(w), store: { ...w.deps.store, plans: { ...real, findActive: async (...a: Parameters<typeof real.findActive>) => (await real.findActive(...a)).map(substitute) } } };
  const before = JSON.stringify([...w.map.entries()].sort(([a], [b]) => a.localeCompare(b)));

  const e = await dispatch("os_resume", { binding_handle: handle }, CTX, tampered);
  assert.equal(e.status, "HOLD", detail(e));
  assert.equal(e.code, "HOLD_CROSS_RUNTIME", detail(e));
  assert.match(detail(e), /MAP_0 updates another row than its stored plan instruction targets/);
  assert.match(detail(e), /nothing was written by this call/);
  assertNoNativeAction(e);
  assert.equal(client.writes.length, 0, "a substituted target was sent to Notion");
  assert.equal(JSON.stringify([...w.map.entries()].sort(([a], [b]) => a.localeCompare(b))), before, "a row of the clone was modified");

  // The refusal opened no journal row (no PENDING/SENT left behind) and the batch event records the HOLD with zero writes.
  const mapping = (await plansOf(w, handle)).find((p) => p.plan_kind === "INSTALL_MAPPING");
  assert.ok(mapping, "the installation plan was not opened");
  assert.deepEqual(await w.deps.store.planWrites.list(mapping.plan_id), []);
  const binding = await bindingOf(w, handle);
  const batches = (await w.deps.store.events.list({ binding_id: binding!.binding_id })).filter((x) => x.event_type === "INSTALL_BATCH");
  assert.equal(batches.length, 1);
  assert.equal(batches[0]?.result, "HOLD_CROSS_RUNTIME");
  assert.deepEqual(batches[0]?.detail, { writes_sent: 0 });
});
