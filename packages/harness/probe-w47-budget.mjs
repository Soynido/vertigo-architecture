/** Bounded engineering driver. No credentials, binding creation, writes or authority of its own. */
import { isDeepStrictEqual } from "node:util";

/** Read-only evidence of the exact factory draft. Missing/partial/foreign/started data fails closed. */
export function preparedCapabilityDraft({ plan, writes, binding, expected, now }) {
  if (!plan || !binding || !expected || !Array.isArray(writes) || !Number.isFinite(now)) return undefined;
  if (plan.plan_kind !== "BUSINESS" || plan.plan_state !== "AWAITING_STAGE1_WRITES" || plan.run_mode !== "OPEN_NEW"
    || plan.recovers_plan_id || (plan.plan_origin ?? "INTENT") !== "INTENT" || typeof plan.plan_id !== "string" || !plan.plan_id) return undefined;
  for (const key of ["binding_id", "principal_id", "project", "lane", "runtime_logical_key", "runtime_id", "runtime_generation"])
    if (typeof binding[key] !== "string" || !binding[key] || plan[key] !== binding[key]) return undefined;
  for (const [key, field] of [["spec", "governing_spec_version"], ["schema", "governing_schema_version"], ["control", "governing_control_version"]])
    if (plan[field] !== (binding.governing_versions_snapshot?.[key] ?? "UNKNOWN")) return undefined;
  const expires = new Date(plan.expires_at).getTime();
  const bindingExpiry = new Date(binding.expires_at).getTime();
  if (!Number.isFinite(expires) || expires <= now || !Number.isFinite(bindingExpiry) || bindingExpiry <= now) return undefined;
  const fields = ["Capability Proof", "Capability Proof Key", "Capability Key", "State", "Runtime ID", "Principal Key",
    "Operating Mode", "Competent Source", "Evidence Ref", "Verified At", "Scope"];
  if (!expected.values || !isDeepStrictEqual(Object.keys(expected.values).sort(), fields.sort())
    || expected.values.State !== "READ_VERIFIED" || expected.values["Capability Proof Key"] !== expected.natural_key) return undefined;
  const op = plan.operations?.[0];
  if (plan.operations?.length !== 1 || op?.operation !== "CREATE" || op.logical_resource_key !== "SALES:CAPABILITY_PROOFS"
    || typeof expected.natural_key !== "string" || !expected.natural_key || op.natural_key !== expected.natural_key
    || op.natural_key_property !== "Capability Proof Key" || !isDeepStrictEqual(op.expected_values, expected.values)) return undefined;
  if (!Array.isArray(plan.stage1_writes) || plan.stage1_writes.length !== 4
    || !Array.isArray(plan.finalization_writes) || plan.finalization_writes.length !== 2 || !plan.state_last_write) return undefined;
  const manifest = [...plan.stage1_writes.map((w) => ({ ...w, phase: "STAGE1" })),
    ...plan.finalization_writes.map((w) => ({ ...w, phase: "FINALIZATION" })), { ...plan.state_last_write, phase: "STATE_LAST" }];
  if (writes.length !== manifest.length || new Set(manifest.map((w) => w.symbol)).size !== manifest.length
    || new Set(writes.map((w) => w.symbol)).size !== writes.length) return undefined;
  for (const instruction of manifest) {
    const row = writes.find((w) => w.symbol === instruction.symbol);
    if (!row || row.plan_id !== plan.plan_id || row.ordinal !== instruction.ordinal || row.operation !== instruction.operation
      || row.target_ref !== instruction.target_ref || row.phase !== instruction.phase || row.status !== "PENDING" || row.attempts !== 0
      || row.sent_at || row.done_at || row.created_id || row.payload_hash || row.stamped_now || row.last_error) return undefined;
  }
  return { plan_id: plan.plan_id, expires_at: plan.expires_at };
}

export async function driveCapabilityCommit({ call, progress, expiresAt, clock = Date.now, report = () => {} }) {
  const calls = [];
  for (let n = 1; n <= 6; n += 1) {
    if (!Number.isFinite(Date.parse(expiresAt)) || clock() >= Date.parse(expiresAt)) return { calls, stopped_at: "EXPIRED" };
    const before = await progress();
    // Progress inspection itself can consume the remaining challenge lifetime.
    if (clock() >= Date.parse(expiresAt)) return { calls, stopped_at: "EXPIRED" };
    const started = clock();
    const reply = await call();
    calls.push(reply);
    const after = await progress();
    report({ call: n, elapsed_ms: clock() - started, kind: reply.kind, phase: reply.phase,
      reason: reply.reason, before, after });
    if (reply.kind === "PERSISTED") return { calls, stopped_at: "PERSISTED" };
    if (reply.kind !== "IN_PROGRESS" || reply.reason !== "BUDGET") return { calls, stopped_at: "REFUSED_OR_INTERRUPTED" };
    if (clock() >= Date.parse(expiresAt)) return { calls, stopped_at: "EXPIRED" };
    if (!(after.settled_writes > before.settled_writes || after.verified_receipts > before.verified_receipts)) {
      // a2: one newly durable PREPARED boundary may hand off to execution. This is never a write/receipt.
      const draft = after.prepared_capability;
      if (n === 1 && reply.phase === "STAGE1" && reply.writes_done === 0 && typeof reply.plan_id === "string"
        && Array.isArray(before.active_plan_ids) && before.active_plan_ids.length === 0
        && Array.isArray(after.active_plan_ids) && after.active_plan_ids.length === 1 && after.active_plan_ids[0] === reply.plan_id
        && draft?.plan_id === reply.plan_id && Number.isFinite(new Date(draft.expires_at).getTime()) && new Date(draft.expires_at).getTime() > clock()) {
        report({ call: n, prepared_handoff: draft.plan_id });
        continue;
      }
      return { calls, stopped_at: "NO_DURABLE_PROGRESS" };
    }
  }
  return { calls, stopped_at: "CALL_LIMIT" };
}
