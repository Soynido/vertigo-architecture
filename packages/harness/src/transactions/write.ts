/**
 * The single write path of the harness (PV-WRITE-001, decision PDEC-018 — CANDIDATE, NOT ADOPTED).
 *
 * The write SCOPE and the order of the checks come before anything else (W1.4). One workspace integration
 * can write every root the owner shared with it, so the member → space isolation is enforced here, before any
 * byte leaves the process: a write is allowed only for the authenticated principal's own plan, on its current
 * binding and runtime generation, and only onto the pages that plan may touch —
 *
 *   CREATE  into the Runs / Ledger data sources freshly discovered under `runtime.root_ref`, or into a data
 *           source one of the plan's own CREATE operations targets;
 *   UPDATE  of a page this plan created, a page one of its operations targets, or the runtime cursor;
 *   and every relation value it carries points to such a page or to one proven, by fresh reads in this call,
 *   to belong to the bound runtime.
 *
 * Anything else is HOLD_CROSS_RUNTIME with zero bytes sent. `journaledWrite` resolves, checks, encodes and hashes
 * one write; `sendWrite` is the only call site of `createPage` / `updatePage` in the harness (PT-ARCH-004/c),
 * and the executor (execute.ts) calls it only with a READY request journaled SENT first.
 */
import { createHash } from "node:crypto";
import type { BindingRecord } from "../binding/store.ts";
import { encodeProperty, type PropertyRefusal } from "../notion/properties.ts";
import type { NotionWriter } from "../notion/client.ts";
import { normalizeId } from "../notion/shapes.ts";
import type { Plan, WriteInstruction } from "../plans/store.ts";
import type { ResolvedRuntime } from "../resolvers/types.ts";

/** What a write may touch in this call. Every field is established by the caller from fresh reads, never from the plan alone. */
export interface WriteScope {
  /** The principal authenticated on this request. */
  readonly principal_id: string;
  /** The binding of this request, already checked live (not STALE / REVOKED / EXPIRED). */
  readonly binding: Pick<BindingRecord, "binding_id" | "principal_id" | "project" | "lane" | "runtime_logical_key" | "runtime_id" | "runtime_generation" | "status">;
  /** The runtime as resolved NOW from the registry and the Manifest — not as the plan remembers it. */
  readonly runtime: Pick<ResolvedRuntime, "lane" | "logical_key" | "runtime_id" | "runtime_generation" | "root_ref">;
  /** Runs and Ledger data sources discovered under `runtime.root_ref` in this call. */
  readonly control_sources: ReadonlySet<string>;
  /** The runtime cursor (META Manifest / SALES OS State CURRENT row), resolved in this call. */
  readonly cursor_ref: string;
  /** Pages proven by fresh reads in this call to belong to the bound runtime (relation targets). */
  readonly proven_pages: ReadonlySet<string>;
}

export type ScopeResult = { readonly ok: true } | { readonly ok: false; readonly code: "HOLD_CROSS_RUNTIME"; readonly evidence: readonly string[] };

/** A write instruction with every symbol bound: the physical target and the field values the writer will encode. */
export interface ResolvedInstruction {
  readonly symbol: string;
  readonly operation: "CREATE" | "UPDATE";
  /** CREATE: the data source id; UPDATE: the page id. Normalized 32-hex. */
  readonly target_id: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly property_types: Readonly<Record<string, string>>;
}

export interface ResolveContext {
  /** symbol → page id created by THIS plan (from its own journal). */
  readonly created: Readonly<Record<string, string>>;
  readonly target_receipt_id?: string;
  /** Wall clock of this write; `$now` is stamped once, at the minute (A.4). */
  readonly now: Date;
}

export type Resolved = { readonly ok: true; readonly instruction: ResolvedInstruction } | { readonly ok: false; readonly code: "HOLD_SCHEMA_MISMATCH"; readonly evidence: readonly string[] };

/** `$now` for one write: UTC, truncated to the minute, identical for every field of that write. */
export function stampNow(now: Date): string {
  return new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString();
}

/**
 * Binds `$created:<symbol>` (target → page id, field → `page:<id>`), `$receipt:TARGET` and `$now`.
 * Replaces render.ts `bindSymbols`: an unbound symbol is refused here instead of reaching Notion as text.
 */
export function resolveInstruction(w: WriteInstruction, ctx: ResolveContext): Resolved {
  const missing: string[] = [];
  const now = stampNow(ctx.now);
  const sub = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sub);
    if (typeof v !== "string") return v;
    if (v.startsWith("$created:")) {
      const id = ctx.created[v.slice("$created:".length)];
      if (!id) { missing.push(v); return v; }
      return `page:${id}`;
    }
    if (v === "$receipt:TARGET") {
      if (!ctx.target_receipt_id) { missing.push(v); return v; }
      return ctx.target_receipt_id;
    }
    return v === "$now" ? now : v;
  };
  let target = w.target_ref;
  if (target.startsWith("$created:")) {
    const id = ctx.created[target.slice("$created:".length)];
    if (!id) missing.push(target); else target = id;
  }
  const fields = Object.fromEntries(Object.entries(w.fields).map(([k, v]) => [k, sub(v)]));
  const targetId = normalizeId(target);
  if (!targetId && missing.length === 0) missing.push(`target ${w.target_ref} is not a Notion id`);
  if (missing.length > 0) return { ok: false, code: "HOLD_SCHEMA_MISMATCH", evidence: [`${w.symbol}: unbound ${missing.join(", ")}; nothing is written`] };
  return { ok: true, instruction: { symbol: w.symbol, operation: w.operation === "CREATE" ? "CREATE" : "UPDATE", target_id: targetId as string, fields, property_types: w.property_types ?? {} } };
}

function instructionsOf(plan: Plan): readonly WriteInstruction[] {
  return [...plan.stage1_writes, ...plan.finalization_writes, plan.state_last_write];
}

function idsIn(value: unknown): string[] {
  return (Array.isArray(value) ? value : value === null || value === undefined ? [] : [value])
    .map((v) => (typeof v === "string" ? normalizeId(v.replace(/^page:/, "")) : undefined))
    .filter((id): id is string => id !== undefined);
}

/**
 * Pure: reads nothing, sends nothing. The plan-level checks (whose plan, which binding, which generation, which
 * runtime) run before the instruction-level ones (which page, which relation), and the first failure holds.
 */
export function assertWriteScope(scope: WriteScope, plan: Plan, w: WriteInstruction, resolved: ResolvedInstruction, created: Readonly<Record<string, string>>): ScopeResult {
  const hold = (...evidence: string[]): ScopeResult => ({ ok: false, code: "HOLD_CROSS_RUNTIME", evidence: [...evidence, "nothing was sent to Notion"] });
  const { binding, runtime } = scope;

  // 1. Whose plan, on which binding.
  if (plan.principal_id !== scope.principal_id || binding.principal_id !== scope.principal_id) return hold(`plan ${plan.plan_id} belongs to another principal than the one authenticated on this request`);
  if (binding.status !== "BOUND") return hold(`the binding is ${binding.status}`);
  if (plan.binding_id !== binding.binding_id) return hold(`plan ${plan.plan_id} was prepared on another binding`);
  if (plan.project !== binding.project || plan.lane !== binding.lane || plan.lane !== runtime.lane) return hold(`plan ${plan.plan_id} is for ${plan.project}/${plan.lane}; this binding is ${binding.project}/${binding.lane}`);

  // 2. Which runtime, now: a rotation or a registry change after the plan was stored invalidates it.
  if (plan.runtime_generation !== binding.runtime_generation || plan.runtime_generation !== runtime.runtime_generation) return hold(`plan ${plan.plan_id} was prepared for runtime generation ${plan.runtime_generation}; the runtime is now at ${runtime.runtime_generation}`);
  if (plan.runtime_id !== binding.runtime_id || plan.runtime_id !== runtime.runtime_id || plan.runtime_logical_key !== runtime.logical_key || binding.runtime_logical_key !== runtime.logical_key) return hold(`plan ${plan.plan_id} targets runtime ${plan.runtime_logical_key}; the registry now resolves this binding to ${runtime.logical_key}`);

  // 3. The instruction is one of the stored plan's, byte for byte.
  const stored = instructionsOf(plan).find((x) => x.symbol === w.symbol);
  if (!stored || JSON.stringify(stored) !== JSON.stringify(w)) return hold(`${w.symbol} is not an instruction of stored plan ${plan.plan_id}`);

  // 4. Which page.
  const createdIds = new Set(Object.values(created).map((id) => normalizeId(id)).filter((id): id is string => id !== undefined));
  const opTargets = new Set(plan.operations.map((o) => normalizeId(o.physical_target_ref)).filter((id): id is string => id !== undefined));
  const cursor = normalizeId(scope.cursor_ref);
  if (resolved.operation === "CREATE") {
    const planSources = new Set(plan.operations.filter((o) => !o.physical_target_ref).map((o) => normalizeId(o.target_data_source_ref)).filter((id): id is string => id !== undefined));
    const control = new Set([...scope.control_sources].map((id) => normalizeId(id)).filter((id): id is string => id !== undefined));
    if (!control.has(resolved.target_id) && !planSources.has(resolved.target_id)) return hold(`${w.symbol} creates a row in data source ${resolved.target_id}, which is neither this runtime's Runs / Ledger nor a source of this plan`);
  } else if (!createdIds.has(resolved.target_id) && !opTargets.has(resolved.target_id) && resolved.target_id !== cursor) {
    return hold(`${w.symbol} updates page ${resolved.target_id}, which this plan neither created nor targets, and which is not the runtime cursor`);
  }

  // 5. Which relations.
  const proven = new Set([...scope.proven_pages].map((id) => normalizeId(id)).filter((id): id is string => id !== undefined));
  for (const [field, value] of Object.entries(resolved.fields)) {
    if (resolved.property_types[field] !== "relation") continue;
    for (const id of idsIn(value)) {
      if (!createdIds.has(id) && !opTargets.has(id) && id !== cursor && !proven.has(id)) return hold(`${w.symbol}.${field} links page ${id}, whose membership in the bound runtime is not proven`);
    }
  }
  return { ok: true };
}

/** Canonical JSON (sorted keys) → SHA-256: the idempotence fingerprint of one request (A.4, A.5 `payload_hash`). */
export function payloadHash(value: unknown): string {
  const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
  return createHash("sha256").update(JSON.stringify(canon(value))).digest("hex");
}

export interface JournaledWriteContext {
  readonly scope: WriteScope;
  readonly plan: Plan;
  readonly resolve: ResolveContext;
  /** property name → option names of governed enumerations on the target (readSchema), and the contract's extensible ones. */
  readonly options?: Readonly<Record<string, readonly string[]>>;
  readonly extensible?: ReadonlySet<string>;
  /** The writer `sendWrite` will use. `journaledWrite` itself never calls it. */
  readonly writer: NotionWriter;
}

export type JournaledWrite =
  | { readonly kind: "READY"; readonly symbol: string; readonly operation: "CREATE" | "UPDATE"; readonly target_id: string; readonly properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>; readonly payload_hash: string }
  | { readonly kind: "HELD"; readonly symbol: string; readonly code: "HOLD_CROSS_RUNTIME" | PropertyRefusal; readonly evidence: readonly string[] };

/**
 * One write, in the fixed order: resolve → scope → encode → hash. A READY request is returned, never sent: the
 * executor journals it SENT, then hands it to `sendWrite`. A HELD write has sent nothing.
 */
export function journaledWrite(ctx: JournaledWriteContext, w: WriteInstruction): JournaledWrite {
  const r = resolveInstruction(w, ctx.resolve);
  if (!r.ok) return { kind: "HELD", symbol: w.symbol, code: r.code, evidence: r.evidence };
  const scope = assertWriteScope(ctx.scope, ctx.plan, w, r.instruction, ctx.resolve.created);
  if (!scope.ok) return { kind: "HELD", symbol: w.symbol, code: scope.code, evidence: scope.evidence };
  const properties: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const [field, value] of Object.entries(r.instruction.fields)) {
    const type = r.instruction.property_types[field] ?? "UNKNOWN";
    const options = ctx.options?.[field];
    const encoded = encodeProperty(type, value, { ...(options ? { options } : {}), extensible: ctx.extensible?.has(field) ?? false });
    if (!encoded.ok) return { kind: "HELD", symbol: w.symbol, code: encoded.code, evidence: [`${w.symbol}.${field}: ${encoded.evidence}`, "nothing was sent to Notion"] };
    properties[field] = encoded.value;
  }
  const request = { operation: r.instruction.operation, target_id: r.instruction.target_id, properties };
  return { kind: "READY", symbol: w.symbol, ...request, payload_hash: payloadHash(request) };
}

export type ReadyWrite = Extract<JournaledWrite, { kind: "READY" }>;

/**
 * The single place the harness writes to Notion. Throws what the writer throws (NotionApiError, classified);
 * the executor decides what an error means for the journal. `created_id` is set for a CREATE only.
 */
export async function sendWrite(writer: NotionWriter, planId: string, ready: ReadyWrite): Promise<{ readonly created_id?: string; readonly last_edited_time: string }> {
  const ctx = { plan_id: planId, symbol: ready.symbol };
  if (ready.operation === "CREATE") {
    const r = await writer.createPage(ready.target_id, ready.properties, ctx);
    return { created_id: r.id, last_edited_time: r.last_edited_time };
  }
  const r = await writer.updatePage(ready.target_id, ready.properties, ctx);
  return { last_edited_time: r.last_edited_time };
}
