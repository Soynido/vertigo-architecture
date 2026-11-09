/**
 * W3.3 — the server-side installer (PV-WRITE-001, PDEC-018 / PLUGIN_SPEC/0.5.0-candidate — CANDIDATE, NOT ADOPTED).
 *
 * An INSTALL_ONLY `os_resume` no longer hands native actions to the chat: it runs one bounded batch of the existing
 * INSTALL_ONLY plan machinery (install/plan.ts) itself. Each step of the batch is derived afresh from live Notion by
 * `resumeInstallContinuation`, so a batch never trusts the previous call's boundary:
 *
 *   ACTION        → one confined write, journaled PENDING → SENT → DONE before the next observation;
 *   VERIFY TARGET → the existing verifier; its intermediate canary step is written the same way;
 *   VERIFY FINAL  → the existing verifier. A verified structural mapping ENDS the call (the promotion is never
 *                   started in the call that proved the mapping); a verified promotion stales the binding.
 *
 * K = 30 counts the Notion write requests SENT by one call — mapping rows, the canary CREATE and its updates, and
 * every UPDATE resend — never the reads. A CREATE whose answer is lost is never resent in the call that lost it; a
 * later call adopts the row by its plan-bound Key, waits out the index lag, or resends the identical payload. A
 * write is confined to the exact operation and row of its durably stored plan instruction, the plan-bound
 * verification row, and (CREATE only) the assigned clone's Registry; anything else is refused with nothing sent.
 */
import { randomBytes } from "node:crypto";
import type { Principal } from "../auth/principal.ts";
import type { BindingRecord } from "../binding/store.ts";
import { HOLD_CODES, type HoldCode } from "../errors/codes.ts";
import { NotionApiError, NotionWriteRefused, type NotionWriter } from "../notion/client.ts";
import { encodeProperty } from "../notion/properties.ts";
import { normalizeId, type Page } from "../notion/shapes.ts";
import { StructureCache } from "../notion/structureCache.ts";
import type { Intent } from "../plans/prepare.ts";
import { readSchema } from "../plans/resources.ts";
import type { Plan, PlanWritePhase, PlanWriteRow, WriteInstruction } from "../plans/store.ts";
import type { ResolvedRuntime } from "../resolvers/types.ts";
import type { HarnessDeps } from "../tools/handlers.ts";
import { type Deadline, WRITE_RESERVE_MS } from "../transactions/budget.ts";
import { INDEX_LAG_WINDOW_MS } from "../transactions/execute.ts";
import { payloadHash, sendWrite, type ReadyWrite } from "../transactions/write.ts";
import { inspectInstallBootstrap, installManifestTemplate, mappingIntentTemplate, resolveInstallRegistry } from "./bootstrap.ts";
import { hasFinalizedInstallMapping, isInstallPromotionPlan, prepareInstall, queryCanaryRows, resumeInstallContinuation, verifyInstallMappingFinal, verifyInstallPromotionFinal, verifyInstallTarget } from "./plan.ts";

/** Notion write requests one installation call may send (W3.3S): canary and UPDATE resends included, reads excluded. */
export const INSTALL_WRITES_PER_CALL = 30;
/** Observation steps one call may take; every step either sends, advances backend state, or ends the call. */
const MAX_STEPS = 4 * INSTALL_WRITES_PER_CALL + 16;
/** Symbols the installer writes onto the plan-bound verification row rather than onto a plan operation target. */
/** How long a batch's plan claim outlives the call's own deadline, so a crashed call's plan frees itself. */
const CLAIM_MARGIN_MS = 30_000;
const CANARY_SYMBOLS = new Set(["INSTALL_VERIFICATION_UPDATED", "INSTALL_VERIFICATION_RESOLVED"]);

export type InstallPhase = "CARTOGRAPHIE" | "ACTIVATION";

export type InstallBatchOutcome =
  /** The call stopped at a write boundary; the next os_resume continues from durable state. */
  | { readonly kind: "CONTINUE"; readonly reason: "BATCH_LIMIT" | "BUDGET" | "INDEX_LAG" | "INTERRUPTED" | "CLAIMED_ELSEWHERE"; readonly phase: InstallPhase; readonly writes_sent: number; readonly plan_id?: string }
  /** The structural mapping is FINAL verified; the promotion starts on the next call, never in this one. */
  | { readonly kind: "MAPPING_VERIFIED"; readonly writes_sent: number; readonly plan_id: string; readonly receipt_id: string }
  /** The promotion is FINAL verified: the assignment is active and this INSTALL_ONLY binding is STALE. */
  | { readonly kind: "PROMOTED"; readonly writes_sent: number; readonly plan_id: string; readonly receipt_id: string }
  | { readonly kind: "HOLD"; readonly code: HoldCode; readonly evidence: readonly string[]; readonly safe_action: string; readonly writes_sent: number };

export interface InstallBatchContext {
  readonly binding: BindingRecord;
  readonly runtime: ResolvedRuntime;
  readonly principal: Principal;
  readonly writer: NotionWriter;
  readonly deadline: Deadline;
  readonly clock: () => Date;
}

type WriteResult =
  | { readonly kind: "DONE"; readonly sends: number }
  | { readonly kind: "INDEX_LAG" }
  | { readonly kind: "INTERRUPTED"; readonly sends: number }
  | { readonly kind: "LIMIT"; readonly sends: number }
  | { readonly kind: "HOLD"; readonly code: HoldCode; readonly evidence: readonly string[]; readonly sends: number };

const asHoldCode = (code: string, fallback: HoldCode): HoldCode => ((HOLD_CODES as readonly string[]).includes(code) ? (code as HoldCode) : fallback);
const phaseOf = (plan: Plan): InstallPhase => (isInstallPromotionPlan(plan) ? "ACTIVATION" : "CARTOGRAPHIE");
const pageDs = (p: Page): string | undefined => normalizeId(p.parent?.data_source_id) ?? normalizeId(p.parent?.database_id);

/**
 * One bounded installation batch. The caller has checked the binding live and holds a Notion writer. A plan is
 * claimed before its first write of the batch, so two overlapping calls never write the same plan at once.
 */
export async function runInstallBatch(deps: HarnessDeps, ctx: InstallBatchContext): Promise<InstallBatchOutcome> {
  const token = randomBytes(16).toString("hex");
  const claimed = new Set<string>();
  // Only structure is shared within this batch; row/query proofs remain fresh and the writer is unchanged.
  const scopedDeps = { ...deps, notion: new StructureCache(deps.notion) };
  try { return await batch(scopedDeps, ctx, token, claimed); }
  finally { for (const planId of claimed) await deps.store.claims.release(planId, token); }
}

async function batch(deps: HarnessDeps, ctx: InstallBatchContext, token: string, claimed: Set<string>): Promise<InstallBatchOutcome> {
  const { binding, runtime } = ctx;
  let sent = 0;
  let phase: InstallPhase = "CARTOGRAPHIE";
  let lastPlan: string | undefined;
  /** plan:symbol written in THIS call: asked again by a fresh observation means the write did not read back. */
  const written = new Set<string>();
  const holdOut = (code: HoldCode, evidence: readonly string[], safe_action: string): InstallBatchOutcome => ({ kind: "HOLD", code, evidence, safe_action, writes_sent: sent });
  const cont = (reason: Extract<InstallBatchOutcome, { kind: "CONTINUE" }>["reason"]): InstallBatchOutcome => ({ kind: "CONTINUE", reason, phase, writes_sent: sent, ...(lastPlan ? { plan_id: lastPlan } : {}) });

  const write = async (plan: Plan, w: WriteInstruction, journalPhase: PlanWritePhase): Promise<InstallBatchOutcome | undefined> => {
    const key = `${plan.plan_id}:${w.symbol}`;
    // A row this call created and cannot find yet is an index that has not caught up, never a reason to create it again.
    if (written.has(key) && w.operation === "CREATE") return cont("INDEX_LAG");
    if (written.has(key)) return holdOut("HOLD_TARGET_WRONG_VALUE", [`${w.symbol} was written in this call but does not read back as planned`], "reprendre l'installation depuis l'état actuel");
    if (sent >= INSTALL_WRITES_PER_CALL) return cont("BATCH_LIMIT");
    if (!ctx.deadline.allows(WRITE_RESERVE_MS)) return cont("BUDGET");
    if (!claimed.has(plan.plan_id)) {
      const now = ctx.clock();
      if (!(await deps.store.claims.claim(plan.plan_id, token, now, new Date(now.getTime() + ctx.deadline.remaining() + CLAIM_MARGIN_MS)))) return cont("CLAIMED_ELSEWHERE");
      claimed.add(plan.plan_id);
    }
    const r = await confinedWrite(deps, ctx, plan, w, journalPhase, INSTALL_WRITES_PER_CALL - sent);
    if (r.kind !== "INDEX_LAG") sent += r.sends;
    if (r.kind === "HOLD") return holdOut(r.code, r.evidence, "reprendre l'installation depuis l'état actuel ; rien n'est réécrit à l'aveugle");
    if (r.kind === "INDEX_LAG") return cont("INDEX_LAG");
    if (r.kind === "INTERRUPTED") return cont("INTERRUPTED");
    if (r.kind === "LIMIT") return cont("BATCH_LIMIT");
    written.add(key);
    return undefined;
  };

  for (let step = 0; step < MAX_STEPS; step += 1) {
    // Every step reads the clone again; none starts once the call's budget is spent.
    if (step > 0 && !ctx.deadline.allows(WRITE_RESERVE_MS)) return cont("BUDGET");
    const now = ctx.clock();
    const c = await resumeInstallContinuation(deps, binding, runtime, now);
    if (c.kind === "HOLD") return holdOut(c.code, c.evidence, c.safe_action);
    if (c.kind === "NONE") {
      const opened = await openInstallPlan(deps, ctx, now);
      if (opened) return { ...opened, writes_sent: sent };
      continue;
    }
    const plan = c.plan;
    phase = phaseOf(plan);
    lastPlan = plan.plan_id;
    await reconcileLostCreates(deps, runtime, plan, now);
    if (c.kind === "ACTION") {
      const stop = await write(plan, c.write, c.phase);
      if (stop) return stop;
      continue;
    }
    if (c.phase === "TARGET") {
      const v = await verifyInstallTarget(deps, binding, runtime, plan, now);
      if (v.kind === "HOLD") return holdOut(v.code, v.evidence, v.safe_action);
      if (v.kind === "STEP") {
        const stop = await write(plan, v.write, v.step === "CANARY_UPDATE" ? "FINALIZATION" : "STATE_LAST");
        if (stop) return stop;
      }
      continue;
    }
    if (isInstallPromotionPlan(plan)) {
      const f = await verifyInstallPromotionFinal(deps, binding, runtime, plan, now);
      if (f.kind === "HOLD") return holdOut(f.code, [...f.evidence, "the clone remains INSTALL_PENDING and business progression is blocked"], f.safe_action);
      return { kind: "PROMOTED", writes_sent: sent, plan_id: plan.plan_id, receipt_id: f.receipt_id };
    }
    const f = await verifyInstallMappingFinal(deps, binding, runtime, plan, now);
    if (f.kind === "HOLD") return holdOut(f.code, [...f.evidence, "the clone remains INSTALL_PENDING and business progression is blocked"], f.safe_action);
    return { kind: "MAPPING_VERIFIED", writes_sent: sent, plan_id: plan.plan_id, receipt_id: f.receipt_id };
  }
  return holdOut("HOLD_PLAN_REPLAY_INVALID", ["the installation made no observable progress within one call"], "reprendre l'installation depuis l'état actuel");
}

/**
 * The next installation intent the assigned clone authorizes, derived by the server alone: the contract-derived
 * structural mapping, or — once a mapping proof exists for this assignment — the separate Manifest promotion.
 */
export async function deriveInstallIntent(deps: HarnessDeps, binding: BindingRecord, runtime: ResolvedRuntime, principal: Principal): Promise<{ readonly kind: "INTENT"; readonly intent: Intent } | Omit<Extract<InstallBatchOutcome, { kind: "HOLD" }>, "writes_sent">> {
  let inspection;
  try { inspection = await inspectInstallBootstrap(deps.notion, runtime); }
  catch (err) { return { kind: "HOLD", code: "HOLD_REQUIRED_RESOURCE_MISSING", evidence: [`INSTALL inspection failed: ${(err as Error).message}`], safe_action: "restore/share the clone Registry, then resume installation" }; }
  if (inspection.violations.length > 0) return { kind: "HOLD", code: "HOLD_INSTALL_REQUIRED", evidence: inspection.violations, safe_action: "corriger la structure du clone indiquée, puis dites simplement « on continue »" };
  const intent: Intent = (await hasFinalizedInstallMapping(deps, binding, runtime))
    ? { action_class: "INSTALL_PROMOTE", summary: "promote the structurally verified assigned clone", mutations: [{ logical_resource_key: "SALES:INSTALL_MANIFEST", operation: "UPDATE", record_selector: { natural_key: "CURRENT" }, desired_changes: installManifestTemplate(principal, runtime) }] }
    : mappingIntentTemplate(inspection);
  return { kind: "INTENT", intent };
}

/** No plan in flight: prepare the next installation step. Undefined = prepared. */
async function openInstallPlan(deps: HarnessDeps, ctx: InstallBatchContext, now: Date): Promise<Omit<Extract<InstallBatchOutcome, { kind: "HOLD" }>, "writes_sent"> | undefined> {
  const derived = await deriveInstallIntent(deps, ctx.binding, ctx.runtime, ctx.principal);
  if (derived.kind === "HOLD") return derived;
  const prepared = await prepareInstall(deps, ctx.binding, ctx.runtime, derived.intent, now);
  if (prepared.kind === "HOLD") return { kind: "HOLD", code: prepared.code, evidence: [...prepared.evidence, "no business plan or copied-history recovery was opened"], safe_action: prepared.safe_action };
  return undefined;
}

/** A CREATE journaled SENT whose row is now observable is adopted (OBSERVED), never created twice. */
async function reconcileLostCreates(deps: HarnessDeps, runtime: ResolvedRuntime, plan: Plan, now: Date): Promise<void> {
  const lost = (await deps.store.planWrites.list(plan.plan_id)).filter((r) => r.operation === "CREATE" && r.status === "SENT");
  if (lost.length === 0) return;
  const rows = await queryCanaryRows(deps, runtime, plan);
  if (rows.length !== 1) return;
  const id = normalizeId((rows[0] as Page).id) as string;
  for (const r of lost) await deps.store.planWrites.transition(plan.plan_id, r.symbol, "SENT", "OBSERVED", { at: now, created_id: id });
}

/** The stored instruction a write must match, when the symbol is one of the plan's own. */
const storedInstruction = (plan: Plan, symbol: string): WriteInstruction | undefined =>
  [...plan.stage1_writes, ...plan.finalization_writes, plan.state_last_write].find((x) => x.symbol === symbol);

/**
 * Pure checks first, then fresh reads: whose plan, which runtime, which instruction, which row. Returns the physical
 * target, or the evidence of the refusal (nothing sent).
 */
async function confine(deps: HarnessDeps, ctx: InstallBatchContext, plan: Plan, w: WriteInstruction): Promise<{ readonly ok: true; readonly target: string; readonly operation: "CREATE" | "UPDATE" } | { readonly ok: false; readonly evidence: readonly string[] }> {
  const { binding, runtime } = ctx;
  const refuse = (...evidence: string[]) => ({ ok: false as const, evidence: [...evidence, "nothing was sent to Notion"] });
  if (binding.status !== "BOUND" || binding.binding_mode !== "INSTALL_ONLY") return refuse(`the binding is ${binding.status}/${binding.binding_mode}, not a bound installation`);
  if (plan.principal_id !== binding.principal_id || plan.project !== binding.project || plan.lane !== binding.lane) return refuse(`plan ${plan.plan_id} belongs to another principal or space`);
  if (plan.runtime_id !== runtime.runtime_id || plan.runtime_generation !== runtime.runtime_generation || plan.runtime_logical_key !== runtime.logical_key) return refuse(`plan ${plan.plan_id} targets another runtime or generation than the one resolved now`);

  // The instruction is checked against the plan as durably stored, never against the copy the continuation handed in.
  const durable = await deps.store.plans.get(plan.plan_id);
  if (!durable) return refuse(`plan ${plan.plan_id} is not a stored plan`);
  const stored = storedInstruction(durable, w.symbol);
  const canary = CANARY_SYMBOLS.has(w.symbol);
  if (stored && (stored.operation !== w.operation || JSON.stringify(stored.fields) !== JSON.stringify(w.fields))) return refuse(`${w.symbol} differs from the stored plan's instruction`);
  if (!stored && !(w.symbol === "INSTALL_VERIFICATION_UPDATED" && JSON.stringify(w.fields) === JSON.stringify({ Status: "EXPECTED" }))) return refuse(`${w.symbol} is not an installation instruction of plan ${plan.plan_id}`);

  if (w.operation === "CREATE") {
    if (w.symbol !== "INSTALL_VERIFICATION" || !stored || stored.target_ref !== w.target_ref) return refuse(`${w.symbol} is not the plan-bound verification row`);
    const registry = await resolveInstallRegistry(deps.notion, runtime);
    const target = normalizeId(w.target_ref);
    if (!registry || target !== registry) return refuse(`${w.symbol} creates a row outside the assigned clone's Registry`);
    return { ok: true, target, operation: "CREATE" };
  }
  if (w.operation !== "UPDATE") return refuse(`${w.symbol} is a ${w.operation}, not an installation update`);
  const target = normalizeId(w.target_ref);
  if (!target) return refuse(`${w.symbol} has no physical target`);
  if (canary) {
    const rows = await queryCanaryRows(deps, runtime, plan);
    if (rows.length !== 1 || normalizeId((rows[0] as Page).id) !== target) return refuse(`${w.symbol} updates a row that is not the unique plan-bound verification row`);
    return { ok: true, target, operation: "UPDATE" };
  }
  // Outside the canary, an update goes exactly where its stored instruction points — never to another plan row.
  if (!stored || normalizeId(stored.target_ref) !== target) return refuse(`${w.symbol} updates another row than its stored plan instruction targets`);
  const targets = new Set(durable.operations.map((o) => normalizeId(o.physical_target_ref)).filter((id): id is string => id !== undefined));
  if (!targets.has(target)) return refuse(`${w.symbol} updates a row the installation plan does not target`);
  return { ok: true, target, operation: "UPDATE" };
}

/** The journal row for this write: the plan's own, or a numbered repair attempt when an earlier one is final. */
async function journalRow(deps: HarnessDeps, plan: Plan, w: WriteInstruction, phase: PlanWritePhase, target: string, operation: "CREATE" | "UPDATE"): Promise<PlanWriteRow> {
  const rows = await deps.store.planWrites.list(plan.plan_id);
  const own = rows.filter((r) => r.symbol === w.symbol || r.symbol.startsWith(`${w.symbol}~`));
  const live = own.find((r) => r.status === "PENDING" || r.status === "SENT");
  if (live) return live;
  if (operation === "CREATE" && own.some((r) => r.status !== "FAILED_FINAL")) throw new Error(`${w.symbol}: a CREATE journaled ${own.map((r) => r.status).join("/")} is never opened again`);
  const symbol = own.length === 0 ? w.symbol : `${w.symbol}~${own.length + 1}`;
  const seeded = await deps.store.planWrites.ensure(plan.plan_id, [{ symbol, phase, ordinal: w.ordinal, operation, target_ref: target }]);
  return seeded.find((r) => r.symbol === symbol) as PlanWriteRow;
}

async function confinedWrite(deps: HarnessDeps, ctx: InstallBatchContext, plan: Plan, w: WriteInstruction, phase: PlanWritePhase, allowance: number): Promise<WriteResult> {
  const now = ctx.clock();
  const scope = await confine(deps, ctx, plan, w);
  if (!scope.ok) return { kind: "HOLD", code: "HOLD_CROSS_RUNTIME", evidence: scope.evidence, sends: 0 };

  let ds: string | undefined = scope.operation === "CREATE" ? scope.target : undefined;
  if (!ds) {
    try { ds = pageDs((await deps.notion.retrievePage(scope.target)) as Page); } catch { ds = undefined; }
  }
  const schema = ds ? await readSchema(deps.notion, ds) : undefined;
  const properties: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const [field, value] of Object.entries(w.fields)) {
    const options = schema?.options.get(field);
    const encoded = encodeProperty(w.property_types?.[field] ?? "UNKNOWN", value, options ? { options } : {});
    if (!encoded.ok) return { kind: "HOLD", code: asHoldCode(encoded.code, "HOLD_SCHEMA_MISMATCH"), evidence: [`${w.symbol}.${field}: ${encoded.evidence}`, "nothing was sent to Notion"], sends: 0 };
    properties[field] = encoded.value;
  }
  const request = { operation: scope.operation, target_id: scope.target, properties };
  const ready: ReadyWrite = { kind: "READY", symbol: w.symbol, ...request, payload_hash: payloadHash(request) };

  if (scope.operation === "CREATE") {
    // Never a second CREATE for a row this plan already created: the fresh observation that asks for it again is
    // an index that has not caught up yet, or a row removed after creation — never a reason to create it twice.
    // Read right before the journal row is chosen, under this call's plan claim.
    const done = (await deps.store.planWrites.list(plan.plan_id)).find((r) => (r.symbol === w.symbol || r.symbol.startsWith(`${w.symbol}~`)) && (r.status === "DONE" || r.status === "OBSERVED"));
    if (done) {
      if (done.done_at && now.getTime() - done.done_at.getTime() < INDEX_LAG_WINDOW_MS) return { kind: "INDEX_LAG" };
      return { kind: "HOLD", code: "HOLD_TARGET_NOT_WRITTEN", evidence: ["the plan-bound verification row created earlier is no longer observable; CREATE will not be replayed"], sends: 0 };
    }
  }
  const row = await journalRow(deps, plan, w, phase, scope.target, scope.operation);
  if (row.status === "SENT" && row.payload_hash && row.payload_hash !== ready.payload_hash) {
    return { kind: "HOLD", code: "HOLD_PLAN_REPLAY_INVALID", evidence: [`${w.symbol}: a resend would not carry the payload first sent`], sends: 0 };
  }
  if (row.status === "SENT" && scope.operation === "CREATE" && row.sent_at && now.getTime() - row.sent_at.getTime() < INDEX_LAG_WINDOW_MS) return { kind: "INDEX_LAG" };

  let sends = 0;
  let from: "PENDING" | "SENT" = row.status === "SENT" ? "SENT" : "PENDING";
  // An UPDATE whose answer is lost is resent once in the same call (idempotent); a CREATE never is.
  for (let attempt = 0; attempt < (scope.operation === "UPDATE" ? 2 : 1); attempt += 1) {
    if (sends >= allowance) return { kind: "LIMIT", sends };
    const journaled = await deps.store.planWrites.transition(plan.plan_id, row.symbol, from, "SENT", { at: ctx.clock(), payload_hash: ready.payload_hash });
    if (!journaled) return { kind: "INTERRUPTED", sends };
    from = "SENT";
    sends += 1;
    try {
      const r = await sendWrite(ctx.writer, plan.plan_id, ready);
      await deps.store.planWrites.transition(plan.plan_id, row.symbol, "SENT", "DONE", { at: ctx.clock(), ...(r.created_id ? { created_id: normalizeId(r.created_id) ?? r.created_id } : {}) });
      return { kind: "DONE", sends };
    } catch (err) {
      if (err instanceof NotionApiError && err.ambiguous) continue;
      if (err instanceof NotionApiError || err instanceof NotionWriteRefused) {
        const status = err instanceof NotionApiError ? err.status : "REFUSED";
        await deps.store.planWrites.transition(plan.plan_id, row.symbol, "SENT", "FAILED_FINAL", { at: ctx.clock(), last_error: `${status}` });
        return { kind: "HOLD", code: "HOLD_TARGET_NOT_WRITTEN", evidence: [`Notion refused ${w.symbol} (${status}); it was not applied`], sends };
      }
      throw err;
    }
  }
  return { kind: "INTERRUPTED", sends };
}
