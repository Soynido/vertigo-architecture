/**
 * Drives the INSTALL_ONLY provisioning of a backend-assigned, non-template Personal SALES clone.
 *
 * W3.3 (BUILD TARGET, PLUGIN_SPEC/0.5.0-candidate): the public path is the server installer. `os_resume` on an
 * INSTALL_ONLY handle writes one bounded batch (K = 30 Notion write requests) through the process's Notion writer —
 * here a FixtureNotionClient over the same map — and returns no native action:
 *
 *   os_bind → os_resume ×n (mapping writes, canary CREATE/update/resolve, RESOLVED finalization, mapping FINAL)
 *   → os_resume ×n (promotion TARGET, OS State normalization, Manifest state-last, activation FINAL)
 *   → os_bind (fresh BUSINESS binding on the bumped generation)
 *
 * The same plan machinery (install/plan.ts) is also driven white-box through the internal handlers `os_prepare` /
 * `os_verify` — no longer announced and inert over MCP (W3.2) — with the fixture "native writer", where a case must
 * stop between two boundaries to tamper with the clone. The installer intent those cases prepare is always the one
 * the server derives (`deriveInstallIntent`); nothing in a test ever invents one.
 */
import assert from "node:assert/strict";
import { hashHandle } from "../../src/binding/handle.ts";
import type { BindingRecord } from "../../src/binding/store.ts";
import { deriveInstallIntent } from "../../src/install/execute.ts";
import { FixtureNotionClient } from "../../src/notion/fixtureClient.ts";
import { propText, type Page } from "../../src/notion/shapes.ts";
import type { Intent } from "../../src/plans/prepare.ts";
import type { Plan } from "../../src/plans/store.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import { bindLive, dispatch } from "../../src/tools/handlers.ts";
import type { TransactionDeps } from "../../src/transactions/execute.ts";
import { REP_A } from "../unit/sales-fixtures.ts";
import { executeWrites } from "../unit/target-fixtures.ts";
import type { InstallWorld } from "../unit/install-fixtures.ts";

export type Ok = Extract<Envelope, { status: "OK" }>;
export const CTX = { principal_id: REP_A.principal_id } as const;

export const result = (e: Envelope): Record<string, unknown> => (e.status === "OK" ? (e as Ok).result : {});
export const evidenceOf = (e: Envelope): string => (e.status === "HOLD" ? e.evidence.join(" | ") : e.status === "ERROR" ? e.message : "");
export const detail = (e: Envelope): string => `${e.status} ${e.code} :: ${evidenceOf(e)}`;

export const bind = (w: InstallWorld, ctx: { principal_id: string | undefined } = CTX): Promise<Envelope> =>
  dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps);

export async function boundHandle(w: InstallWorld, ctx: { principal_id: string | undefined } = CTX): Promise<string> {
  const e = await bind(w, ctx);
  assert.equal(e.code, "BOUND", detail(e));
  return (e as Ok).result["binding_handle"] as string;
}

export const bindingOf = (w: InstallWorld, handle: string): Promise<BindingRecord | undefined> =>
  w.deps.store.bindings.findByHandleHash(hashHandle(handle));

/* ───────────────────────── the server writer (W3.3) ───────────────────────── */

/** Select options a real clone's schema carries for the fields the installer writes and the fixture leaves undeclared. */
const INSTALL_OPTION_VALUES = ["SETUP", "ACTIVE", "UNKNOWN", "HEALTHY", "PASS", "B0_DISCOVERY", "OPEN"] as const;
const WRITERS = new WeakMap<InstallWorld, FixtureNotionClient>();

/**
 * Gives the Manifest and OS State data sources the select properties a real Notion schema has: every select the
 * CURRENT row carries, with its present value and the installation's values. A field that already declares options
 * is left exactly as the fixture built it (a deliberately broken option stays broken).
 */
function declareInstallSchema(w: InstallWorld): void {
  for (const [ds, row] of [[w.ids.manifestDs, w.ids.manifestRow], [w.ids.stateDs, w.ids.stateRow]] as const) {
    const source = w.map.get(`data_source:${ds}`) as { properties: Record<string, { type: string; select?: { options: Array<{ name: string }> } }> } | undefined;
    const page = w.map.get(`page:${row}`) as Page | undefined;
    if (!source || !page) continue;
    const properties = { ...source.properties };
    for (const [name, prop] of Object.entries(page.properties)) {
      if ((prop as { type?: string }).type !== "select") continue;
      if ((properties[name]?.select?.options.length ?? 0) > 0) continue;
      const present = propText(page, name);
      properties[name] = { type: "select", select: { options: [...new Set([...(present ? [present] : []), ...INSTALL_OPTION_VALUES])].map((n) => ({ name: n })) } };
    }
    w.map.set(`data_source:${ds}`, { ...source, properties });
  }
}

/** The world's server Notion writer: one FixtureNotionClient over the same map, its `writes` the request log. */
export function writerOf(w: InstallWorld): FixtureNotionClient {
  let client = WRITERS.get(w);
  if (!client) {
    declareInstallSchema(w);
    client = new FixtureNotionClient(w.map);
    WRITERS.set(w, client);
  }
  return client;
}

/** The harness dependencies of a process that holds a Notion writer; reads stay the world's own (spies included). */
export const served = (w: InstallWorld): TransactionDeps => ({ ...w.deps, notionWriter: writerOf(w) });

/** Public os_resume, on a process holding the server writer. */
export const resume = (w: InstallWorld, handle: string, ctx: { principal_id: string | undefined } = CTX): Promise<Envelope> =>
  dispatch("os_resume", { binding_handle: handle }, ctx, served(w));

/** Public os_resume on a process WITHOUT a Notion writer (server writes unavailable). */
export const resumeWithoutWriter = (w: InstallWorld, handle: string, ctx: { principal_id: string | undefined } = CTX): Promise<Envelope> =>
  dispatch("os_resume", { binding_handle: handle }, ctx, w.deps);

export const installationOf = (e: Envelope): Record<string, unknown> => (result(e)["installation"] as Record<string, unknown> | undefined) ?? {};
export const phaseOf = (e: Envelope): unknown => installationOf(e)["phase"];
export const writesSentOf = (e: Envelope): number => (installationOf(e)["writes_sent"] ?? e.observations["writes_sent"] ?? 0) as number;

/**
 * Calls os_resume until the installation reaches `until` — the verified structural mapping or the activation —
 * asserting that every intermediate reply continues the installation (never a HOLD, never a native action).
 */
export async function installUntil(w: InstallWorld, handle: string, until: "structure vérifiée" | "reconnexion requise", maxCalls = 12): Promise<Envelope[]> {
  const replies: Envelope[] = [];
  for (let i = 0; i < maxCalls; i += 1) {
    const e = await resume(w, handle);
    replies.push(e);
    assert.equal(e.code, "RESUMED", detail(e));
    assert.equal(result(e)["install_only"], true, detail(e));
    assertNoNativeAction(e);
    if (phaseOf(e) === until) return replies;
    assert.equal(e.next.permitted_tool_call, "os_resume", detail(e));
  }
  assert.fail(`the installation did not reach « ${until} » within ${maxCalls} calls`);
}

/** An installer reply carries no native action, no rendered write and never names a retired tool. */
export function assertNoNativeAction(e: Envelope): void {
  const text = JSON.stringify(e);
  assert.doesNotMatch(text, /stage1_actions|finalization_actions|state_last_action|"actions"|native_actions_required|prepare_intent/, "an installer reply carried native actions");
  assert.doesNotMatch(text, /os_prepare|os_verify/, "an installer reply named a retired tool");
}

/* ───────────────────────── the internal plan machinery (white-box) ───────────────────────── */

export const prepare = (w: InstallWorld, handle: string, intent?: Intent, ctx: { principal_id: string | undefined } = CTX): Promise<Envelope> =>
  dispatch("os_prepare", { binding_handle: handle, ...(intent ? { intent } : {}) }, ctx, w.deps);

export const verify = (w: InstallWorld, handle: string, planId: string, phase: "TARGET" | "FINAL", ctx: { principal_id: string | undefined } = CTX): Promise<Envelope> =>
  dispatch("os_verify", { binding_handle: handle, plan_id: planId, phase }, ctx, w.deps);

export const planOf = async (w: InstallWorld, e: Envelope): Promise<Plan> =>
  (await w.deps.store.plans.get(result(e)["plan_id"] as string)) as Plan;

/** The exact installer intent the server derives for this handle's assignment now. */
export async function installerIntent(w: InstallWorld, handle: string, ctx: { principal_id: string | undefined } = CTX): Promise<Intent> {
  const live = await bindLive(handle, ctx, w.deps);
  assert.ok(live.ok, live.ok ? "" : detail(live.envelope));
  const principal = await w.deps.principals.get(live.binding.principal_id);
  assert.ok(principal, "the principal is not resolvable");
  const derived = await deriveInstallIntent(w.deps, live.binding, live.runtime, principal);
  assert.equal(derived.kind, "INTENT", derived.kind === "HOLD" ? `${derived.code} :: ${derived.evidence.join(" | ")}` : "");
  return (derived as { intent: Intent }).intent;
}

/** The contract-derived mapping intent, taken from a throwaway fresh binding (a mapping proof is binding-scoped). */
export async function mappingIntent(w: InstallWorld): Promise<Intent> {
  return installerIntent(w, await boundHandle(w));
}

export interface MappingRun {
  readonly plan: Plan;
  readonly canaryRef: string;
  readonly targetReceiptId: string;
  readonly finalReceiptId: string;
  readonly replies: readonly Envelope[];
}

/** Runs the structural mapping to its FINAL proof through the server installer, then reads that proof back. */
export async function runMapping(w: InstallWorld, handle: string): Promise<MappingRun> {
  const replies = await installUntil(w, handle, "structure vérifiée");
  const binding = await bindingOf(w, handle);
  const plans = await w.deps.store.plans.listByRuntime(binding!.project, binding!.lane, binding!.runtime_generation);
  const plan = [...plans].reverse().find((p) => p.plan_kind === "INSTALL_MAPPING" && p.plan_state === "FINAL_VERIFIED" && p.principal_id === binding!.principal_id);
  assert.ok(plan, "no FINAL_VERIFIED structural mapping plan");
  const final = (await w.deps.store.receipts.findByPlan(plan.plan_id, "FINAL")).find((r) => r.status === "VALID");
  assert.ok(final?.target_receipt_id, "the mapping has no VALID FINAL receipt");
  return { plan, canaryRef: final.observations["canary_ref"] as string, targetReceiptId: final.target_receipt_id, finalReceiptId: final.receipt_id, replies };
}

export interface PromotionRun {
  readonly plan: Plan;
  readonly finalEnvelope: Envelope;
  readonly replies: readonly Envelope[];
}

/** White-box: prepares and target-verifies the separate Manifest promotion, WITHOUT performing the state-last write. */
export async function preparePromotion(w: InstallWorld, handle: string): Promise<{ plan: Plan; target: Envelope }> {
  const prepared = await prepare(w, handle, await installerIntent(w, handle));
  assert.equal(prepared.code, "PLAN_PREPARED", detail(prepared));
  const plan = await planOf(w, prepared);
  const target = await verify(w, handle, plan.plan_id, "TARGET");
  return { plan, target };
}

/** White-box: the promotion state-last Manifest write, then FINAL (the only step that may activate the backend). */
export async function finishPromotion(w: InstallWorld, handle: string, plan: Plan, at = "2030-01-02T00:09:00.000Z"): Promise<Envelope> {
  executeWrites(w, plan.finalization_writes, plan.plan_id, { now: at });
  executeWrites(w, [plan.state_last_write], plan.plan_id, { now: at });
  return verify(w, handle, plan.plan_id, "FINAL");
}

/** The whole provisioning through the server installer, asserted green at every call. */
export async function installFully(w: InstallWorld): Promise<{ handle: string; mapping: MappingRun; promotion: PromotionRun }> {
  const handle = await boundHandle(w);
  const mapping = await runMapping(w, handle);
  const replies = await installUntil(w, handle, "reconnexion requise");
  const finalEnvelope = replies[replies.length - 1] as Envelope;
  const plans = await w.deps.store.plans.listByRuntime("VERTIGO", "SALES", mapping.plan.runtime_generation);
  const plan = [...plans].reverse().find((p) => p.plan_kind === "INSTALL_PROMOTION" && p.plan_state === "FINAL_VERIFIED");
  assert.ok(plan, "no FINAL_VERIFIED promotion plan");
  return { handle, mapping, promotion: { plan, finalEnvelope, replies } };
}

/** An ordinary business intent, used to prove business work never runs on an INSTALL_ONLY handle. */
export const businessIntent = (): Intent => ({
  action_class: "COMMIT",
  summary: "create an external action intent",
  mutations: [{ logical_resource_key: "SALES:EXTERNAL_ACTIONS", operation: "CREATE", record_selector: { natural_key: "AK-INSTALL-PROBE" }, desired_changes: { Action: "send" } }],
});
