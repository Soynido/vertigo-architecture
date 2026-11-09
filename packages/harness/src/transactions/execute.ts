/**
 * The transaction executor (PV-WRITE-001, decision PDEC-018 — CANDIDATE, NOT ADOPTED).
 *
 * The executor takes a plan id, never a plan: it re-reads the stored plan, claims it (one executor per plan),
 * journals every instruction, and writes through `journaledWrite` and `sendWrite` only, in instruction order,
 * renewing plan and lease before each write. Every write is journaled SENT before it leaves and DONE after Notion
 * confirms it, so a later call knows exactly where it stopped:
 *
 *   - a CREATE left SENT (its response was lost) is first RELOCATED by its own keys — Run by Harness Plan ID,
 *     ledger row by plan id + idempotency key, target by natural key — and never resent within the call that
 *     lost it; found once ⇒ OBSERVED, found twice ⇒ HOLD_DUPLICATE, not found ⇒ resent with the same payload;
 *   - an UPDATE is idempotent: an ambiguous failure is resent once in the same call, with the same payload;
 *   - `$now` is stamped once per write, at its first send, and reused by every resend;
 *   - the call stops at a write boundary when its budget runs out (IN_PROGRESS), when Notion's answer is
 *     unknown (INTERRUPTED), or when a write is refused (HELD) — and says which.
 *
 * `executeTransaction` runs the whole transaction (W1.7): stage 1 → the existing TARGET verifier (created-id
 * hints, three re-reads 700 ms apart before a not-found HOLD) → TARGET receipt → finalization and STATE_LAST →
 * the existing FINAL verifier → atomic finalizePlan → PERSISTED. A finalization or STATE_LAST UPDATE whose answer
 * is lost twice is not guessed at: FINAL's readback decides. Nothing here is reachable from a tool yet.
 */
import { randomBytes } from "node:crypto";
import type { BindingRecord } from "../binding/store.ts";
import type { HarnessConfig } from "../config/index.ts";
import type { ERROR_CODES, HoldCode } from "../errors/codes.ts";
import { NotionApiError, NotionWriteRefused, type NotionWriter } from "../notion/client.ts";
import type { PropertyRefusal } from "../notion/properties.ts";
import type { NotionReadClient } from "../notion/readClient.ts";
import { normalizeId, propText, type Page } from "../notion/shapes.ts";
import { StructureCache } from "../notion/structureCache.ts";
import { naturalKeyFilter, queryAll, readSchema } from "../plans/resources.ts";
import { checkTargetReceipt, renew } from "../plans/service.ts";
import type { Plan, PlanOrigin, PlanWriteRow, PlanWriteSeed, WriteInstruction } from "../plans/store.ts";
import type { ResolvedRuntime } from "../resolvers/types.ts";
import { discoverControlPlane } from "../resume/readers.ts";
import { foreignRunStillOwned, isForeignRunImport } from "../resume/foreignRuns.ts";
import { isExternalEventPlan } from "../effects/eventWrite.ts";
import type { BackendStore } from "../store/memory.ts";
import type { HarnessDeps } from "../tools/handlers.ts";
import type { ReceiptRecord } from "../verify/engine.ts";
import { referencesId } from "../verify/target.ts";
import { type Deadline, WRITE_RESERVE_MS } from "./budget.ts";
import { journaledWrite, resolveInstruction, sendWrite, stampNow, type ReadyWrite, type WriteScope } from "./write.ts";

/** A CREATE whose response was lost less than this long ago may not be visible to queries yet (A.3 INDEX_LAG). */
export const INDEX_LAG_WINDOW_MS = 30_000;
/** TARGET re-reads before a not-found HOLD is believed (A.4). */
export const TARGET_REREADS = 3;
export const TARGET_REREAD_DELAY_MS = 700;
/** How long a claim outlives the call's own deadline, so a crashed executor's plan frees itself. */
const CLAIM_MARGIN_MS = 30_000;

export type ExecutorHoldCode = HoldCode | PropertyRefusal | (typeof ERROR_CODES)[number] | "HOLD_SERVER_WRITES_DISABLED" | "HOLD_NOTION_WRITE_REJECTED" | "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE";
export type WritePhase = PlanWriteRow["phase"];

export interface ExecutorDeps {
  readonly store: BackendStore;
  readonly notion: NotionReadClient;
  readonly notionWriter?: NotionWriter;
  readonly config: HarnessConfig;
}

/** The whole transaction reuses the existing verifiers, which read the full harness dependencies. */
export type TransactionDeps = HarnessDeps & { readonly notionWriter?: NotionWriter };

export interface ExecuteContext {
  /** The principal authenticated on this request. */
  readonly principal_id: string;
  /** This request's binding, already checked live by the caller. */
  readonly binding: BindingRecord;
  /** The runtime as resolved in this call. */
  readonly runtime: ResolvedRuntime;
  readonly plan_id: string;
  /** The runtime cursor as read by the caller's fresh rehydrate in this call. */
  readonly cursor_ref: string;
  readonly deadline: Deadline;
  readonly clock?: () => Date;
  /** Waits between TARGET re-reads; tests pass a no-op. */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * W3.1: re-proves the approved Production Guard before EVERY Notion write of a new plan — the first, each stage 1
   * write, each finalization write, STATE_LAST. False stops the call before that byte: HELD when nothing of the plan
   * was written, otherwise INTERRUPTED (GUARD_DRIFT) and only ledger recovery — which passes no check — continues
   * the plan. A check the budget cannot finish sends nothing more (IN_PROGRESS). Bytes already sent cannot be taken
   * back: this is fail-closed detection, never an atomic guarantee. Absent on the six historical tools and
   * historical own-journal recovery; candidate foreign-Run imports retain the check on every continuation.
   */
  readonly guardCheck?: () => Promise<boolean>;
}

interface Progress { readonly plan_id: string; readonly writes_done: number; readonly writes_total: number; readonly warnings: readonly string[] }

export type Stage1Outcome =
  | (Progress & { readonly kind: "STAGE1_DONE"; readonly created: Readonly<Record<string, string>> })
  | (Progress & { readonly kind: "IN_PROGRESS"; readonly phase: "STAGE1"; readonly reason: "BUDGET" | "CLAIMED_ELSEWHERE" | "INDEX_LAG" })
  | (Progress & { readonly kind: "INTERRUPTED"; readonly phase: "STAGE1"; readonly failed_symbol: string; readonly notion_status: number | "TRANSPORT" | "TIMEOUT" | "NOT_SENT"; readonly reason?: "GUARD_DRIFT" })
  | (Progress & { readonly kind: "HELD"; readonly phase: "STAGE1"; readonly code: ExecutorHoldCode; readonly evidence: readonly string[]; readonly wrote_anything: boolean });

/** The executor's answer for one call (A.3). */
export type TransactionOutcome =
  | { readonly kind: "PERSISTED"; readonly origin: PlanOrigin; readonly plan_id: string; readonly target_receipt_id: string; readonly final_receipt_id: string; readonly run_ref: string; readonly repeated: boolean; readonly step_moved: boolean; readonly writes_sent: number; readonly warnings: readonly string[] }
  | { readonly kind: "IN_PROGRESS"; readonly origin: PlanOrigin; readonly plan_id: string; readonly phase: WritePhase | "TARGET"; readonly writes_done: number; readonly writes_total: number; readonly reason: "BUDGET" | "CLAIMED_ELSEWHERE" | "INDEX_LAG"; readonly warnings: readonly string[] }
  | { readonly kind: "INTERRUPTED"; readonly origin: PlanOrigin; readonly plan_id: string; readonly phase: WritePhase; readonly writes_done: number; readonly writes_total: number; readonly failed_symbol: string; readonly notion_status: number | "TRANSPORT" | "TIMEOUT" | "NOT_SENT"; readonly reason?: "GUARD_DRIFT"; readonly warnings: readonly string[] }
  | { readonly kind: "HELD"; readonly origin: PlanOrigin; readonly plan_id: string; readonly phase: WritePhase | "TARGET" | "FINAL"; readonly code: ExecutorHoldCode; readonly evidence: readonly string[]; readonly safe_action: string; readonly wrote_anything: boolean; readonly warnings: readonly string[] };

function seedsOf(plan: Plan): PlanWriteSeed[] {
  const seed = (phase: PlanWriteSeed["phase"]) => (w: WriteInstruction): PlanWriteSeed => ({ symbol: w.symbol, phase, ordinal: w.ordinal, operation: w.operation === "CREATE" ? "CREATE" : "UPDATE", target_ref: w.target_ref });
  return [...plan.stage1_writes.map(seed("STAGE1")), ...plan.finalization_writes.map(seed("FINALIZATION")), seed("STATE_LAST")(plan.state_last_write)];
}

const instructionsOf = (plan: Plan): readonly WriteInstruction[] => [...plan.stage1_writes, ...plan.finalization_writes, plan.state_last_write];
const settled = (r: PlanWriteRow) => r.status === "DONE" || r.status === "OBSERVED";
const pageDs = (p: Page) => normalizeId(p.parent?.data_source_id) ?? normalizeId(p.parent?.database_id);

type Relocation = { readonly kind: "FOUND"; readonly id: string } | { readonly kind: "ABSENT" } | { readonly kind: "DUPLICATE"; readonly ids: readonly string[] } | { readonly kind: "NO_KEYS" };

/** The fields that identify what a CREATE made, taken from the instruction itself (A.4). */
function relocationKeys(plan: Plan, runtime: ResolvedRuntime, w: WriteInstruction): readonly string[] {
  const wp = runtime.adapter.controlPlane.writeProps;
  const keys = w.purpose === "OPEN_RUN" ? [wp?.runHarnessPlanId]
    : w.purpose === "PREPARE_LEDGER" ? [wp?.ledgerHarnessPlanId, wp?.ledgerIdempotencyKey]
    : w.purpose === "WRITE_TARGET" ? [plan.operations.find((o) => `TARGET_${o.ordinal}` === w.symbol)?.natural_key_property]
    : [];
  return keys.filter((k): k is string => typeof k === "string" && k in w.fields && typeof w.fields[k] === "string" && w.fields[k] !== "");
}

async function relocate(reads: NotionReadClient, plan: Plan, runtime: ResolvedRuntime, w: WriteInstruction, ds: string): Promise<Relocation> {
  const keys = relocationKeys(plan, runtime, w);
  if (keys.length === 0) return { kind: "NO_KEYS" };
  const first = keys[0] as string;
  const rows = await queryAll(reads, ds, naturalKeyFilter(w.property_types?.[first], first, String(w.fields[first])));
  // The filter is an optimization; the exact match is checked here on every key.
  const hits = rows.filter((p) => keys.every((k) => propText(p, k) === String(w.fields[k])));
  if (hits.length === 0) return { kind: "ABSENT" };
  if (hits.length > 1) return { kind: "DUPLICATE", ids: hits.map((p) => normalizeId(p.id) as string) };
  return { kind: "FOUND", id: normalizeId((hits[0] as Page).id) as string };
}

/** Schema facts one write needs: its target data source's enumeration options, and proof of its relation targets. */
async function writeFacts(reads: NotionReadClient, w: WriteInstruction, target: { operation: "CREATE" | "UPDATE"; target_id: string }, fields: Readonly<Record<string, unknown>>, known: ReadonlySet<string>) {
  let ds: string | undefined = target.operation === "CREATE" ? target.target_id : undefined;
  if (!ds) {
    try { ds = pageDs((await reads.retrievePage(target.target_id)) as Page); } catch { ds = undefined; }
  }
  const schema = ds ? await readSchema(reads, ds) : undefined;
  const options = schema ? Object.fromEntries([...schema.options].filter(([k]) => k in w.fields)) : undefined;
  const proven = new Set<string>();
  for (const [field, value] of Object.entries(fields)) {
    if (w.property_types?.[field] !== "relation") continue;
    const expected = schema?.relations.get(field);
    for (const raw of Array.isArray(value) ? value : [value]) {
      const id = typeof raw === "string" ? normalizeId(raw.replace(/^page:/, "")) : undefined;
      if (!id || known.has(id) || !expected) continue;
      try {
        const page = (await reads.retrievePage(id)) as Page;
        if (!page.archived && !page.in_trash && pageDs(page) === expected) proven.add(id);
      } catch { /* unreadable ⇒ unproven ⇒ the scope check holds */ }
    }
  }
  return { options, proven };
}

type WritesOutcome =
  | { readonly kind: "DONE"; readonly created: Readonly<Record<string, string>> }
  | { readonly kind: "IN_PROGRESS"; readonly reason: "BUDGET" | "CLAIMED_ELSEWHERE" | "INDEX_LAG" }
  | { readonly kind: "INTERRUPTED"; readonly symbol: string; readonly status: NotionApiError["status"]; readonly operation: "CREATE" | "UPDATE"; readonly ambiguous: boolean }
  | { readonly kind: "GUARD_DRIFT"; readonly symbol: string }
  | { readonly kind: "HELD"; readonly code: ExecutorHoldCode; readonly evidence: readonly string[] };

/** W3.1: whether the approved guard still holds right before a Notion byte, and the budget still fits that byte. */
async function guardHolds(ctx: ExecuteContext): Promise<"OK" | "DRIFT" | "BUDGET"> {
  if (!ctx.guardCheck) return "OK";
  if (!(await ctx.guardCheck())) return "DRIFT";
  return ctx.deadline.allows(WRITE_RESERVE_MS) ? "OK" : "BUDGET";
}

/** A drift before this plan's first byte writes nothing: a plain HOLD, the evidence structural only. */
const GUARD_DRIFT_UNWRITTEN = ["the approved Production Guard changed after the preflight, before this plan's first write", "nothing of this plan was written"] as const;
const GUARD_DRIFT_ACTION = "have the operator review and approve the Production Guard again; nothing is written for this plan before that";

interface Session {
  readonly deps: ExecutorDeps;
  readonly ctx: ExecuteContext;
  readonly plan: Plan;
  readonly writer: NotionWriter;
  readonly token: string;
  readonly clock: () => Date;
  readonly claimUntil: () => Date;
  readonly reads: StructureCache;
  readonly journal: PlanWriteRow[];
  readonly created: Record<string, string>;
  readonly control: ReadonlySet<string>;
  readonly warnings: string[];
  sent: number;
}

async function openSession(deps: ExecutorDeps, ctx: ExecuteContext, plan: Plan, writer: NotionWriter, token: string, clock: () => Date, claimUntil: () => Date): Promise<Session> {
  const reads = new StructureCache(deps.notion);
  const journal = [...(await deps.store.planWrites.ensure(plan.plan_id, seedsOf(plan)))];
  // A recovery plan continues the Run and ledger rows of the plan it recovers (its linkage): what that lineage's
  // own journal created counts as created by this plan, so its Run can be resumed and its rows completed. Only a
  // journal of the SAME principal and runtime generation is read; this plan's own journal wins on a symbol.
  const lineage: Record<string, string> = {};
  if (plan.recovers_plan_id) {
    for (const p of await deps.store.plans.listByRuntime(plan.project, plan.lane, plan.runtime_generation)) {
      if (p.plan_id === plan.plan_id || p.principal_id !== plan.principal_id || (p.plan_id !== plan.recovers_plan_id && p.recovers_plan_id !== plan.recovers_plan_id)) continue;
      for (const r of await deps.store.planWrites.list(p.plan_id)) if (r.created_id && (r.status === "DONE" || r.status === "OBSERVED")) lineage[r.symbol] = r.created_id;
    }
  }
  const created: Record<string, string> = { ...lineage, ...Object.fromEntries(journal.filter((r) => r.created_id).map((r) => [r.symbol, r.created_id as string])) };
  // This fresh, execution-local discovery defines CONTROL scope only for Runs/Ledger. The other
  // tables were hydrated by preparation and remain freshly read by their own verifier/guard paths.
  const disc = await discoverControlPlane(reads, ctx.runtime.root_ref, ctx.runtime.adapter.controlPlane, "RUN_AND_LEDGER");
  const control = new Set([disc.runs, disc.ledger].filter((x): x is string => x !== undefined));
  // E12 aliases mean observed, scoped objects to continue — not newly created objects or blanket UPDATE rights.
  const imported = isForeignRunImport(plan) ? plan : plan.recovers_plan_id && !isExternalEventPlan(plan) ? await deps.store.plans.get(plan.recovers_plan_id) : undefined;
  const sameImportScope = imported && ["principal_id", "project", "lane", "runtime_logical_key", "runtime_id", "runtime_generation"]
    .every(k => imported[k as keyof Plan] === plan[k as keyof Plan]);
  if (imported && sameImportScope && imported.plan_origin === "AUTO_RECONCILE" && plan.recovers_plan_id && plan.run_ref
    && imported.operations.every(o => o.before_hash === o.expected_hash)) {
    const g = ctx.runtime.adapter.controlPlane, wp = g.writeProps;
    const run = await reads.retrievePage(plan.run_ref) as Page;
    if (wp?.runHarnessPlanId && pageDs(run) === disc.runs && propText(run, wp.runHarnessPlanId) === imported.plan_id) {
      created["OPEN_RUN"] = plan.run_ref;
      if (disc.ledger && wp.ledgerHarnessPlanId && wp.ledgerIdempotencyKey) {
        const rows = await queryAll(reads, disc.ledger, { property: wp.ledgerHarnessPlanId, rich_text: { equals: imported.plan_id } });
        for (const op of plan.operations) {
          const hits = rows.filter(p => pageDs(p) === disc.ledger && propText(p, wp.ledgerHarnessPlanId!) === imported.plan_id
            && propText(p, wp.ledgerIdempotencyKey!) === op.idempotency_key && referencesId(p, g.ledgerProps.runRef, plan.run_ref!));
          if (hits.length === 1) created[`LEDGER_${op.ordinal}`] = normalizeId(hits[0]!.id)!;
        }
      }
    }
  }
  if (imported && sameImportScope && isForeignRunImport(imported) && await foreignRunStillOwned(deps, ctx.runtime, imported)) {
    const claim = imported.stage1_writes.find(w => w.symbol === "RESUME_RUN")!;
    if (claim.baseline_parent_ref === disc.runs) created["OPEN_RUN"] = imported.run_ref!;
    for (const seed of imported.stage1_writes.filter(w => w.purpose === "PREPARE_LEDGER" && w.operation === "UPDATE"))
      if (seed.baseline_parent_ref === disc.ledger) created[seed.symbol] = seed.target_ref;
    // A ledger CREATE can have landed before its response/journaled created_id survived the crash.
    // Admit only one fresh row with all its scoped linkage, never a row guessed from its title.
    const g = ctx.runtime.adapter.controlPlane, wp = g.writeProps;
    if (plan.recovers_plan_id && disc.ledger && wp?.ledgerHarnessPlanId && wp.ledgerIdempotencyKey) {
      const rows = await queryAll(reads, disc.ledger, { property: wp.ledgerHarnessPlanId, rich_text: { equals: imported.plan_id } });
      for (const op of plan.operations) {
        const hits = rows.filter(p => pageDs(p) === disc.ledger && propText(p, wp.ledgerHarnessPlanId!) === imported.plan_id
          && propText(p, wp.ledgerIdempotencyKey!) === op.idempotency_key && referencesId(p, g.ledgerProps.runRef, imported.run_ref!));
        if (hits.length === 1) created[`LEDGER_${op.ordinal}`] = normalizeId(hits[0]!.id)!;
      }
    }
  }
  return { deps, ctx, plan, writer, token, clock, claimUntil, reads, journal, created, control, warnings: [...disc.warnings], sent: 0 };
}

const phaseRows = (s: Session, phases: readonly WritePhase[]) => s.journal.filter((r) => phases.includes(r.phase)).sort((a, b) => a.ordinal - b.ordinal);
const progressOf = (s: Session, phases: readonly WritePhase[]) => { const rows = phaseRows(s, phases); return { writes_done: rows.filter(settled).length, writes_total: rows.length }; };

/** Writes every unsettled row of the given phases, in instruction order. */
async function runWrites(s: Session, phases: readonly WritePhase[], targetReceiptId?: string): Promise<WritesOutcome> {
  const { store } = s.deps;
  const { plan, ctx } = s;
  const setRow = (row: PlanWriteRow) => { s.journal[s.journal.findIndex((r) => r.symbol === row.symbol)] = row; };
  const opTargets = plan.operations.map((o) => normalizeId(o.physical_target_ref)).filter((x): x is string => x !== undefined);
  const held = (code: ExecutorHoldCode, evidence: readonly string[]): WritesOutcome => ({ kind: "HELD", code, evidence });

  for (const current of phaseRows(s, phases)) {
    let row = s.journal.find((r) => r.symbol === current.symbol) as PlanWriteRow;
    if (settled(row)) continue;
    if (row.status === "FAILED_FINAL") return held("HOLD_NOTION_WRITE_REJECTED", [`${row.symbol} was refused earlier (${row.last_error ?? "no detail"}); the plan cannot complete as prepared`]);
    const w = instructionsOf(plan).find((x) => x.symbol === row.symbol) as WriteInstruction;
    if (!ctx.deadline.allows(WRITE_RESERVE_MS)) return { kind: "IN_PROGRESS", reason: "BUDGET" };
    if (!(await store.claims.claim(plan.plan_id, s.token, s.clock(), s.claimUntil())) || !(await renew(store, s.deps.config, plan.plan_id, s.token, s.clock()))) return { kind: "IN_PROGRESS", reason: "CLAIMED_ELSEWHERE" };

    // A CREATE whose answer was lost: find what it made before anything is resent.
    if (row.status === "SENT" && row.operation === "CREATE") {
      const ds = normalizeId(w.target_ref);
      const found = ds ? await relocate(s.reads, plan, ctx.runtime, w, ds) : { kind: "NO_KEYS" as const };
      if (found.kind === "FOUND") {
        const moved = await store.planWrites.transition(plan.plan_id, row.symbol, "SENT", "OBSERVED", { at: s.clock(), created_id: found.id });
        if (!moved) return { kind: "IN_PROGRESS", reason: "CLAIMED_ELSEWHERE" };
        setRow(moved);
        s.created[row.symbol] = found.id;
        continue;
      }
      if (found.kind === "DUPLICATE") return held("HOLD_DUPLICATE", [`${row.symbol} was sent once and ${found.ids.length} rows now carry its keys; none is chosen`]);
      if (found.kind === "NO_KEYS") return held("HOLD_TARGET_AMBIGUOUS", [`${row.symbol} was sent and its answer lost; it carries no key to find what it created, so it is never resent blindly`]);
      if (row.sent_at && s.clock().getTime() - row.sent_at.getTime() < INDEX_LAG_WINDOW_MS) return { kind: "IN_PROGRESS", reason: "INDEX_LAG" };
    }

    const now = row.stamped_now ? new Date(row.stamped_now) : s.clock();
    const resolveCtx = { created: s.created, now, ...(targetReceiptId ? { target_receipt_id: targetReceiptId } : {}) };
    const bound = resolveInstruction(w, resolveCtx);
    const facts = bound.ok ? await writeFacts(s.reads, w, bound.instruction, bound.instruction.fields, new Set([...Object.values(s.created).map((x) => normalizeId(x) as string), ...opTargets, normalizeId(ctx.cursor_ref) as string])) : { options: undefined, proven: new Set<string>() };
    const scope: WriteScope = { principal_id: ctx.principal_id, binding: ctx.binding, runtime: ctx.runtime, control_sources: s.control, cursor_ref: ctx.cursor_ref, proven_pages: facts.proven };
    const jw = journaledWrite({ scope, plan, resolve: resolveCtx, ...(facts.options ? { options: facts.options } : {}), writer: s.writer }, w);
    if (jw.kind === "HELD") {
      if (row.status === "PENDING") {
        const failed = await store.planWrites.transition(plan.plan_id, row.symbol, "PENDING", "FAILED_FINAL", { at: s.clock(), last_error: jw.code });
        if (failed) setRow(failed);
      }
      return held(jw.code, jw.evidence);
    }

    // W3.1: the approved guard, re-proven right before this byte leaves.
    const guard = await guardHolds(ctx);
    if (guard === "DRIFT") return { kind: "GUARD_DRIFT", symbol: row.symbol };
    if (guard === "BUDGET") return { kind: "IN_PROGRESS", reason: "BUDGET" };

    const send = async (from: "PENDING" | "SENT"): Promise<PlanWriteRow | undefined> => {
      const sent = await store.planWrites.transition(plan.plan_id, row.symbol, from, "SENT", { at: s.clock(), payload_hash: jw.payload_hash, stamped_now: stampNow(now) });
      if (sent) setRow(sent);
      return sent;
    };
    const sent = await send(row.status === "PENDING" ? "PENDING" : "SENT");
    if (!sent) return { kind: "IN_PROGRESS", reason: "CLAIMED_ELSEWHERE" };
    row = sent;

    let result = await attempt(s, jw);
    // An UPDATE is idempotent: one ambiguous failure is resent once, same payload, same stamp — and only while the
    // guard still holds; otherwise the lost answer is left to the readback and the ledger, as when no budget remains.
    const resend = !result.ok && result.error instanceof NotionApiError && result.error.ambiguous && row.operation === "UPDATE" && ctx.deadline.allows(WRITE_RESERVE_MS) ? await guardHolds(ctx) : undefined;
    if (resend === "DRIFT") s.warnings.push(`${row.symbol}: the approved Production Guard changed; the write whose answer was lost is not resent`);
    if (resend === "OK") {
      const again = await send("SENT");
      if (!again) return { kind: "IN_PROGRESS", reason: "CLAIMED_ELSEWHERE" };
      result = await attempt(s, jw);
    }
    if (result.ok) {
      const done = await store.planWrites.transition(plan.plan_id, row.symbol, "SENT", "DONE", { at: s.clock(), ...(result.created_id ? { created_id: result.created_id } : {}) });
      if (!done) return { kind: "IN_PROGRESS", reason: "CLAIMED_ELSEWHERE" };
      setRow(done);
      if (result.created_id) s.created[row.symbol] = result.created_id;
      continue;
    }
    const err = result.error;
    if (err instanceof NotionApiError && (err.ambiguous || err.retryable)) return { kind: "INTERRUPTED", symbol: row.symbol, status: err.status, operation: row.operation, ambiguous: err.ambiguous };
    const reason = err instanceof NotionApiError ? `${err.status} ${err.notionCode}` : (err as Error).message;
    const failed = await store.planWrites.transition(plan.plan_id, row.symbol, "SENT", "FAILED_FINAL", { at: s.clock(), last_error: reason });
    if (failed) setRow(failed);
    return held("HOLD_NOTION_WRITE_REJECTED", [`Notion refused ${row.symbol}: ${reason}`, "this write was not applied; the plan cannot complete as prepared"]);
  }
  return { kind: "DONE", created: { ...s.created } };
}

async function attempt(s: Session, ready: ReadyWrite): Promise<{ ok: true; created_id?: string } | { ok: false; error: NotionApiError | NotionWriteRefused }> {
  s.sent += 1;
  try {
    const r = await sendWrite(s.writer, s.plan.plan_id, ready);
    return { ok: true, ...(r.created_id ? { created_id: r.created_id } : {}) };
  } catch (error) {
    if (error instanceof NotionApiError || error instanceof NotionWriteRefused) return { ok: false, error };
    throw error;
  }
}

type Claimed<T> = { readonly kind: "CLAIMED"; readonly value: T } | { readonly kind: "BUSY" };

/** Claims the plan for this call, runs `body`, releases. A thrown error (a crash) leaves the claim to lapse. */
async function withClaim<T>(deps: ExecutorDeps, ctx: ExecuteContext, plan: Plan, clock: () => Date, body: (token: string, claimUntil: () => Date) => Promise<T>): Promise<Claimed<T>> {
  const token = randomBytes(18).toString("base64url");
  const claimUntil = () => new Date(clock().getTime() + ctx.deadline.remaining() + CLAIM_MARGIN_MS);
  if (!(await deps.store.claims.claim(plan.plan_id, token, clock(), claimUntil()))) return { kind: "BUSY" };
  const value = await body(token, claimUntil);
  await deps.store.claims.release(plan.plan_id, token);
  return { kind: "CLAIMED", value };
}

/**
 * Stage 1 of one stored plan. Resumable: call it again with the same plan id and it continues from the journal.
 * Throws only what it cannot classify (a crashed process, a store failure): the journal then shows the truth.
 */
export async function executeStage1(deps: ExecutorDeps, ctx: ExecuteContext): Promise<Stage1Outcome> {
  const clock = ctx.clock ?? (() => new Date());
  const plan = await deps.store.plans.get(ctx.plan_id);
  const empty = { plan_id: ctx.plan_id, writes_done: 0, writes_total: 0, warnings: [] as string[] };
  const held = (code: ExecutorHoldCode, evidence: readonly string[]): Stage1Outcome => ({ kind: "HELD", phase: "STAGE1", code, evidence, wrote_anything: false, ...empty });
  if (!plan) return held("ERROR_PLAN_NOT_FOUND", [`no stored plan ${ctx.plan_id}`]);
  if (!deps.notionWriter) return held("HOLD_SERVER_WRITES_DISABLED", ["this process holds no Notion writer; nothing was written"]);
  const writer = deps.notionWriter;
  if (plan.plan_state !== "AWAITING_STAGE1_WRITES") return held(["EXPIRED", "ABORTED", "SUPERSEDED"].includes(plan.plan_state) ? "HOLD_PLAN_EXPIRED" : "HOLD_PLAN_REPLAY_INVALID", [`plan ${plan.plan_id} is ${plan.plan_state}; stage 1 runs only on a plan awaiting it`]);
  if (plan.expires_at.getTime() <= clock().getTime()) return held("HOLD_PLAN_EXPIRED", [`plan ${plan.plan_id} expired at ${plan.expires_at.toISOString()}`]);

  const out = await withClaim(deps, ctx, plan, clock, async (token, claimUntil): Promise<Stage1Outcome> => {
    const s = await openSession(deps, ctx, plan, writer, token, clock, claimUntil);
    const r = await runWrites(s, ["STAGE1"]);
    const progress = { plan_id: plan.plan_id, ...progressOf(s, ["STAGE1"]), warnings: s.warnings };
    switch (r.kind) {
      case "DONE": return { kind: "STAGE1_DONE", created: r.created, ...progress };
      case "IN_PROGRESS": return { kind: "IN_PROGRESS", phase: "STAGE1", reason: r.reason, ...progress };
      case "INTERRUPTED": return { kind: "INTERRUPTED", phase: "STAGE1", failed_symbol: r.symbol, notion_status: r.status, ...progress };
      case "GUARD_DRIFT": return s.journal.some((x) => x.status !== "PENDING")
        ? { kind: "INTERRUPTED", phase: "STAGE1", failed_symbol: r.symbol, notion_status: "NOT_SENT", reason: "GUARD_DRIFT", ...progress }
        : { kind: "HELD", phase: "STAGE1", code: "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE", evidence: [...GUARD_DRIFT_UNWRITTEN], wrote_anything: false, ...progress };
      case "HELD": return { kind: "HELD", phase: "STAGE1", code: r.code, evidence: r.evidence, wrote_anything: phaseRows(s, ["STAGE1"]).some((x) => x.status !== "PENDING"), ...progress };
    }
  });
  return out.kind === "BUSY" ? { kind: "IN_PROGRESS", phase: "STAGE1", reason: "CLAIMED_ELSEWHERE", ...empty } : out.value;
}

const NOT_YET_VISIBLE: ReadonlySet<string> = new Set(["HOLD_RUN_NOT_OPENED", "HOLD_LEDGER_PREPARE_MISSING", "HOLD_TARGET_NOT_WRITTEN"]);
const FINAL_NOT_YET_VISIBLE: ReadonlySet<string> = new Set(["HOLD_RUN_INCOMPLETE", "HOLD_LEDGER_NOT_VERIFIED", "HOLD_STATE_LAST_NOT_PROVEN"]);

/**
 * One stored plan, as far as this call can take it: stage 1, TARGET, finalization, STATE_LAST, FINAL. Resumable at
 * every step; a plan already FINAL_VERIFIED returns its stored result (`repeated`), writing nothing.
 */
export async function executeTransaction(deps: TransactionDeps, ctx: ExecuteContext): Promise<TransactionOutcome> {
  const clock = ctx.clock ?? (() => new Date());
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const { store } = deps;
  const plan = await store.plans.get(ctx.plan_id);
  const origin: PlanOrigin = plan?.plan_origin ?? "INTENT";
  const base = { origin, plan_id: ctx.plan_id };
  const heldEarly = (code: ExecutorHoldCode, evidence: readonly string[], safe_action: string, phase: "STAGE1" | "TARGET" | "FINAL" = "STAGE1"): TransactionOutcome => ({ kind: "HELD", ...base, phase, code, evidence, safe_action, wrote_anything: false, warnings: [] });
  if (!plan) return heldEarly("ERROR_PLAN_NOT_FOUND", [`no stored plan ${ctx.plan_id}`], "prepare the change again");
  const enrollmentKeys = (ctx.runtime.adapter.capabilities?.sourceIdentityEnrollment ?? []).map(d => d.resourceKey);
  if (plan.operations.some(o => enrollmentKeys.includes(o.logical_resource_key))) {
    const { isSourceEnrollmentPlan, sourceEnrollmentPlanStillValid } = await import("../resume/sourceEnrollment.ts");
    if (!isSourceEnrollmentPlan(ctx.runtime, plan)) return heldEarly("HOLD_ACTION_NOT_AUTHORIZED", ["first-link plan has no exact scoped backend attestation"], "resume; never submit or replace an identity from a public intent");
    const { openGuard, guardStillApproved } = await import("../guards/preflight.ts");
    const approval = await openGuard(deps, ctx.binding, ctx.runtime, clock());
    if (approval.kind === "HOLD") return heldEarly("HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE", approval.evidence, approval.safe_action);
    const prior = ctx.guardCheck;
    ctx = { ...ctx, guardCheck: async () => (prior ? await prior() : await guardStillApproved(deps, ctx.runtime, approval, clock()))
      && await sourceEnrollmentPlanStillValid(deps.notion, ctx.runtime, plan) };
  }
  if (!deps.notionWriter) return heldEarly("HOLD_SERVER_WRITES_DISABLED", ["this process holds no Notion writer; nothing was written"], "nothing to do until server writes are enabled; never fall back to writing from the chat");
  if (["EXPIRED", "ABORTED", "SUPERSEDED"].includes(plan.plan_state)) return heldEarly("HOLD_PLAN_EXPIRED", [`plan ${plan.plan_id} is ${plan.plan_state}`], "resume from the durable state; writes already made are reconciled there");
  if (plan.plan_state === "HOLD") return heldEarly("HOLD_PLAN_REPLAY_INVALID", [`plan ${plan.plan_id} is on HOLD after a detected divergence`], "resume and reconcile before any further write");
  if (plan.plan_state === "AWAITING_STAGE1_WRITES" && plan.expires_at.getTime() <= clock().getTime()) return heldEarly("HOLD_PLAN_EXPIRED", [`plan ${plan.plan_id} expired at ${plan.expires_at.toISOString()}`], "resume from the durable state, then prepare again");
  const writer = deps.notionWriter;

  // A transaction already FINAL_VERIFIED: its stored result, idempotently (verifyFinal converges on the incumbent).
  if (plan.plan_state === "FINAL_VERIFIED") return finalStep(deps, ctx, plan, undefined, clock, 0, []);

  const out = await withClaim(deps, ctx, plan, clock, async (token, claimUntil): Promise<TransactionOutcome> => {
    const s = await openSession(deps, ctx, plan, writer, token, clock, claimUntil);
    const all: WritePhase[] = ["STAGE1", "FINALIZATION", "STATE_LAST"];
    const wroteAnything = () => s.journal.some((x) => x.status !== "PENDING");
    const progress = (phases: readonly WritePhase[]) => ({ ...progressOf(s, phases), warnings: s.warnings });
    const fromWrites = (r: Exclude<WritesOutcome, { kind: "DONE" }>, phase: WritePhase, phases: readonly WritePhase[]): TransactionOutcome => {
      switch (r.kind) {
        case "IN_PROGRESS": return { kind: "IN_PROGRESS", ...base, phase, reason: r.reason, ...progress(phases) };
        case "INTERRUPTED": return { kind: "INTERRUPTED", ...base, phase, failed_symbol: r.symbol, notion_status: r.status, ...progress(phases) };
        case "GUARD_DRIFT": return wroteAnything()
          ? { kind: "INTERRUPTED", ...base, phase, failed_symbol: r.symbol, notion_status: "NOT_SENT", reason: "GUARD_DRIFT", ...progress(phases) }
          : { kind: "HELD", ...base, phase, code: "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE", evidence: [...GUARD_DRIFT_UNWRITTEN], safe_action: GUARD_DRIFT_ACTION, wrote_anything: false, warnings: s.warnings };
        case "HELD": return { kind: "HELD", ...base, phase, code: r.code, evidence: r.evidence, safe_action: "nothing more is written for this plan; resume from the durable state", wrote_anything: wroteAnything(), warnings: s.warnings };
      }
    };

    // 1. Stage 1, then TARGET.
    let targetReceipt: ReceiptRecord | undefined;
    let symbols: Readonly<Record<string, string>> = {};
    if (plan.plan_state === "AWAITING_STAGE1_WRITES") {
      const w1 = await runWrites(s, ["STAGE1"]);
      if (w1.kind !== "DONE") return fromWrites(w1, "STAGE1", ["STAGE1"]);
      let verified: Awaited<ReturnType<typeof import("../verify/target.ts").verifyTarget>> | undefined;
      const { verifyTarget } = await import("../verify/target.ts");
      for (let read = 0; read <= TARGET_REREADS; read += 1) {
        verified = await verifyTarget(deps, ctx.binding, ctx.runtime, plan, clock(), { created: s.created });
        if (verified.kind === "VERIFIED" || !NOT_YET_VISIBLE.has(verified.code) || read === TARGET_REREADS) break;
        if (!ctx.deadline.allows(TARGET_REREAD_DELAY_MS + WRITE_RESERVE_MS)) return { kind: "IN_PROGRESS", ...base, phase: "TARGET", reason: "INDEX_LAG", ...progress(all) };
        await sleep(TARGET_REREAD_DELAY_MS);
      }
      if (!verified || verified.kind === "HOLD") {
        const v = verified as Extract<NonNullable<typeof verified>, { kind: "HOLD" }>;
        await store.events.append({ event_type: "TARGET_VERIFY_HOLD", result: v.code, principal_id: ctx.binding.principal_id, binding_id: ctx.binding.binding_id, plan_id: plan.plan_id, runtime_id: ctx.binding.runtime_id, detail: { evidence: v.evidence, origin: "EXECUTOR" }, created_at: clock() });
        return { kind: "HELD", ...base, phase: "TARGET", code: v.code, evidence: [...v.evidence, "no target receipt issued"], safe_action: v.safe_action, wrote_anything: wroteAnything(), warnings: [...s.warnings, ...(v.warnings ?? [])] };
      }
      targetReceipt = verified.receipt;
      symbols = verified.symbols;
      s.warnings.push(...verified.warnings);
    } else {
      // Resuming after TARGET: its receipt, not a second verification (the Run may already be COMPLETED).
      const live = (await store.receipts.findByPlan(plan.plan_id, "TARGET")).find((r) => r.status === "VALID");
      const chk = live ? await checkTargetReceipt(store, plan, live.receipt_id, clock()) : undefined;
      if (!chk || !chk.ok) return { kind: "HELD", ...base, phase: "TARGET", code: chk && !chk.ok && chk.reason === "EXPIRED" ? "HOLD_TARGET_RECEIPT_EXPIRED" : "HOLD_TARGET_RECEIPT_INVALID", evidence: [live ? `target receipt ${live.receipt_id}: ${chk && !chk.ok ? chk.reason : "unusable"}` : `plan ${plan.plan_id} is ${plan.plan_state} without a valid target receipt`], safe_action: "resume from the durable state; the finalization cannot be proved without a valid target receipt", wrote_anything: wroteAnything(), warnings: s.warnings };
      targetReceipt = chk.receipt;
      symbols = (targetReceipt.observations["symbols"] as Record<string, string> | undefined) ?? {};
    }

    // What TARGET proved by readback and what the journal says were created must be the same pages.
    for (const [symbol, id] of Object.entries(symbols)) {
      const mine = s.created[symbol];
      if (mine && normalizeId(mine) !== normalizeId(id)) return { kind: "HELD", ...base, phase: "TARGET", code: "HOLD_TARGET_AMBIGUOUS", evidence: [`${symbol}: the journal created ${mine}, the verified readback found ${id}`], safe_action: "reconcile by hand; no finalization is written over two candidate records", wrote_anything: wroteAnything(), warnings: s.warnings };
      s.created[symbol] = normalizeId(id) as string;
    }

    // 2. Finalization, then STATE_LAST, last (each write re-proves the guard in runWrites, W3.1).
    for (const phase of ["FINALIZATION", "STATE_LAST"] as const) {
      const w = await runWrites(s, [phase], targetReceipt.receipt_id);
      if (w.kind === "DONE") continue;
      // An UPDATE whose answer was lost twice is not guessed at: FINAL's readback proves it or says what is missing.
      if (w.kind === "INTERRUPTED" && w.ambiguous && w.operation === "UPDATE") {
        s.warnings.push(`${w.symbol}: Notion's answer was lost twice; the final readback decides whether it landed`);
        break;
      }
      return fromWrites(w, phase, ["FINALIZATION", "STATE_LAST"]);
    }
    return finalStep(deps, ctx, plan, s, clock, s.sent, s.warnings);
  });
  if (out.kind === "BUSY") return { kind: "IN_PROGRESS", ...base, phase: "STAGE1", reason: "CLAIMED_ELSEWHERE", writes_done: 0, writes_total: 0, warnings: [] };
  return out.value;
}

async function finalStep(deps: TransactionDeps, ctx: ExecuteContext, plan: Plan, s: Session | undefined, clock: () => Date, sent: number, warnings: readonly string[]): Promise<TransactionOutcome> {
  const { store } = deps;
  const origin: PlanOrigin = plan.plan_origin ?? "INTENT";
  const { verifyFinal, parkOnDrift } = await import("../verify/final.ts");
  // When the journal proves every finalization write landed and FINAL's query still cannot see one, the index is
  // behind, not the data: re-read, as TARGET does, before believing the HOLD.
  const wroteAll = s !== undefined && s.journal.filter((r) => r.phase !== "STAGE1").every(settled);
  let outcome = await verifyFinal(deps, ctx.binding, ctx.runtime, plan, clock());
  for (let read = 0; wroteAll && outcome.kind === "HOLD" && FINAL_NOT_YET_VISIBLE.has(outcome.code) && read < TARGET_REREADS && ctx.deadline.allows(TARGET_REREAD_DELAY_MS + WRITE_RESERVE_MS); read += 1) {
    await (ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(TARGET_REREAD_DELAY_MS);
    outcome = await verifyFinal(deps, ctx.binding, ctx.runtime, plan, clock());
  }
  if (outcome.kind === "HOLD") {
    const notes = outcome.drift ? await parkOnDrift(deps, plan, clock(), `${outcome.code} observed at FINAL`) : [];
    await store.events.append({ event_type: "FINAL_VERIFY_HOLD", result: outcome.code, principal_id: ctx.binding.principal_id, binding_id: ctx.binding.binding_id, plan_id: plan.plan_id, runtime_id: ctx.binding.runtime_id, detail: { evidence: outcome.evidence, origin: "EXECUTOR" }, created_at: clock() });
    return { kind: "HELD", origin, plan_id: plan.plan_id, phase: "FINAL", code: outcome.code, evidence: [...outcome.evidence, ...notes, "no final receipt issued; the change is NOT complete"], safe_action: outcome.safe_action, wrote_anything: s ? s.journal.some((x) => x.status !== "PENDING") : true, warnings: [...warnings, ...(outcome.warnings ?? [])] };
  }
  // FINAL proved every write by readback: a finalization row whose answer was lost is now observed.
  if (s) {
    for (const row of s.journal) {
      if (row.status === "SENT" && row.phase !== "STAGE1" && row.operation === "UPDATE") await store.planWrites.transition(plan.plan_id, row.symbol, "SENT", "OBSERVED", { at: clock() });
    }
  }
  const derived = ctx.runtime.adapter.controlPlane.resources ?? {};
  return {
    kind: "PERSISTED", origin, plan_id: plan.plan_id,
    target_receipt_id: outcome.target_receipt.receipt_id, final_receipt_id: outcome.receipt.receipt_id,
    run_ref: String(outcome.observations["run_ref"] ?? "UNKNOWN"), repeated: outcome.repeated,
    step_moved: plan.operations.some((o) => derived[o.logical_resource_key]?.backendDerivedOnly === true
      && !(ctx.runtime.adapter.capabilities?.sourceIdentityEnrollment ?? []).some(d => d.resourceKey === o.logical_resource_key)),
    writes_sent: sent, warnings: [...warnings, ...outcome.warnings],
  };
}
