#!/usr/bin/env node
/**
 * Operator approval of a Sales Production Guard Index (W3.1R, Sales 0.5.11 candidate — NOT ADOPTED).
 *
 * Out of chat, out of the tool surface: this local command is the only writer of an approval. It reads the guard
 * snapshot of one principal's assigned Sales runtime, prints what identifies it — never a rule text or a value —
 * and persists the approval only when the operator repeats the exact digest they reviewed:
 *
 *   node src/cli/guard-approve.ts <principal_id> --operator <operator_id> [--project VERTIGO] [--index-page <page_id>]
 *   node src/cli/guard-approve.ts <principal_id> --operator <operator_id> --approve <digest_sha256> [--index-page <page_id>]
 *
 * The first form previews; the second approves, and refuses if the snapshot changed in between. A durable store
 * (DATABASE_URL) is required: an approval held in memory would vanish with this process.
 */
import { guardBindingId } from "../binding/guardIdentity.ts";
import { readGuardSnapshot } from "../guards/snapshot.ts";
import type { GuardApproval } from "../store/guardApprovals.ts";
import { resolveRuntimeFor, type HarnessDeps } from "../tools/handlers.ts";

export interface ApproveRequest {
  readonly principal_id: string;
  readonly project: string;
  readonly operator_id: string;
  readonly index_page_id?: string;
  /** Absent: preview only. Present: persist only if the fresh snapshot has exactly this digest. */
  readonly approve_digest?: string;
  readonly now: Date;
}

export type ApproveResult =
  | { readonly kind: "PREVIEW"; readonly digest_sha256: string; readonly index_page_id: string; readonly index_revision: number; readonly p0_rule_ids: readonly number[]; readonly constraint_ids: readonly number[]; readonly operation_classes: number; readonly predicate_sources: number }
  | { readonly kind: "APPROVED"; readonly approval: GuardApproval }
  | { readonly kind: "REFUSED"; readonly reason: string };

export async function approveGuard(deps: HarnessDeps, req: ApproveRequest): Promise<ApproveResult> {
  if (!deps.store.guardApprovals) return { kind: "REFUSED", reason: "this store keeps no guard approvals" };
  if (!req.operator_id.trim()) return { kind: "REFUSED", reason: "an operator identity is required" };
  const principal = await deps.principals.get(req.principal_id);
  if (!principal || principal.status !== "ACTIVE") return { kind: "REFUSED", reason: "the principal is unknown or inactive" };
  const resolved = await resolveRuntimeFor(deps, principal, req.project, "SALES");
  if (resolved.kind === "HOLD") return { kind: "REFUSED", reason: `the Sales runtime cannot be resolved (${resolved.code})` };
  const runtime = resolved.runtime;
  const spec = runtime.adapter.controlPlane.productionGuard;
  if (!spec) return { kind: "REFUSED", reason: "the governing Sales contract of this runtime declares no Production Guard" };
  const read = await readGuardSnapshot({ client: deps.notion, runtime, spec, t0: req.now, ...(req.index_page_id ? { indexPageId: req.index_page_id } : {}) });
  if (!read.ok) return { kind: "REFUSED", reason: `the guard snapshot cannot be proven: ${read.reason}` };
  const s = read.snapshot;
  if (req.approve_digest === undefined) {
    return { kind: "PREVIEW", digest_sha256: s.digest, index_page_id: s.index_page_id, index_revision: s.index.revision, p0_rule_ids: s.p0_rule_ids, constraint_ids: [...s.constraints.keys()], operation_classes: s.index.operation_classes.length, predicate_sources: s.refs.size };
  }
  if (req.approve_digest !== s.digest) return { kind: "REFUSED", reason: "the snapshot changed since it was reviewed; preview it again" };
  const approval: GuardApproval = {
    binding_id: guardBindingId({ project: req.project, lane: "SALES", principal_id: principal.principal_id, runtime_logical_key: runtime.logical_key, runtime_id: runtime.runtime_id }),
    runtime_id: runtime.runtime_id, runtime_generation: runtime.runtime_generation, guard_schema_version: spec.schemaVersion,
    index_page_id: s.index_page_id, digest_sha256: s.digest, approved_at: req.now, operator_id: req.operator_id.trim(),
  };
  await deps.store.guardApprovals.put(approval);
  return { kind: "APPROVED", approval };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const principal = args[0] && !args[0].startsWith("--") ? args[0] : undefined;
  const operator = flag("--operator");
  if (!principal || !operator) {
    console.error("usage: guard-approve <principal_id> --operator <operator_id> [--project VERTIGO] [--index-page <page_id>] [--approve <digest_sha256>]");
    process.exit(2);
  }
  const { buildLiveDeps } = await import("../index.ts");
  const deps = await buildLiveDeps();
  if (!deps.config.databaseUrl) {
    console.error("refused: DATABASE_URL is required, an approval must be durable");
    process.exit(2);
  }
  const indexPage = flag("--index-page");
  const approve = flag("--approve");
  const result = await approveGuard(deps, { principal_id: principal, project: flag("--project") ?? "VERTIGO", operator_id: operator, now: new Date(), ...(indexPage ? { index_page_id: indexPage } : {}), ...(approve ? { approve_digest: approve } : {}) });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.kind === "REFUSED" ? 1 : 0);
}
