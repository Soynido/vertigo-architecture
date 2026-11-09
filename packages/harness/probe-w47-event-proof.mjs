/** Engineering probe only: pure readback predicates, never writer/approval/lease authority. */
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";

// READONLY backend checkpoint of 2026-10-07, not an approval or executable plan.
export const partialCheckpoint = Object.freeze({
  root_id: "EzNnzw-ZQJ9c6i15_6p_uX3cd-2U4KXj", child_id: "VIxazmjM5KwLXraYoty_Yur5L2tkIfZn",
  root_sha: "0862560521b75fb540f0260018eb80827b70672dec966dc8d86102d239930f7f",
  root_journal_sha: "90e6abf168ceb14980709880c2e8e94716ff8993a854b8c3e22e6b0eb926936f",
  child_sha: "655639e3c8a07fc2db1d99aed4db9f60ace6f7fb92c8c540e4886d6f5a279acb",
  child_journal_sha: "92d0d92b1d0f4d61b84a5852ebb82a47f130f6c107b0712fab736b5961e76016",
  run_ref: "f36a97f682a856fea2545069ec4c36b6", ledger1_ref: "14269ca788745d68bc3d8f0834fa7ee6",
  completed: ["DAAWO4xI5QAu39QjvKn6cU7JdWre1Hkk", "k8SzEOSXfb7AduKJbDs6Xnl8azJWv0rk"],
});
export const finalCheckpoint = Object.freeze({ ...partialCheckpoint,
  final_child_id: "BUhNZJTTJgi6RIZ1Z0Jz3Ev4MsghXMDP",
  final_child_sha: "a441741b4f6949a46d3bfdc2e1851bfe9cf071c36f12b84927e0b3668486fbf9",
  final_child_journal_sha: "071d75697ef7e994f8f9e3e7b3c1333e908aa248e545337201c9ada60b41161c",
});
export const cutoffCheckpoint = Object.freeze({ ...finalCheckpoint,
  cutoff_child_id: "NndrGGuzOxOhRWJYVmWZ-PeaawuuJcc8",
  cutoff_child_sha: "836f70c56f12680533d6fbfa626169b42564c92da891dff539ac918dd829b88b",
  cutoff_child_journal_sha: "2c6bc0d383dea42cf8bcac70c65aae924c90d6e0de279e79da5f3501ff853468",
});

export function checkpointHash(value) {
  const stable = (v) => v instanceof Date ? v.toISOString() : Array.isArray(v) ? v.map(stable)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, stable(v[k])])) : v;
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}
export function immutablePlanHash({ plan_state: _mutable, ...immutable }) { return checkpointHash(immutable); }

export function eventProbeMode(args) {
  const key = JSON.stringify(args);
  return new Map([
    [JSON.stringify([]), { mode: "CAPTURE", check: false }],
    [JSON.stringify(["--recover-started"]), { mode: "RECOVER_STARTED", check: false }],
    [JSON.stringify(["--recover-partial-burst10"]), { mode: "RECOVER_PARTIAL_BURST10", check: false }],
    [JSON.stringify(["--recover-partial-burst10", "--check"]), { mode: "RECOVER_PARTIAL_BURST10", check: true }],
    [JSON.stringify(["--recover-final-burst10"]), { mode: "RECOVER_FINAL_BURST10", check: false }],
    [JSON.stringify(["--recover-final-burst10", "--check"]), { mode: "RECOVER_FINAL_BURST10", check: true }],
    [JSON.stringify(["--recover-cutoff"]), { mode: "RECOVER_CUTOFF", check: false }],
    [JSON.stringify(["--recover-cutoff", "--check"]), { mode: "RECOVER_CUTOFF", check: true }],
  ]).get(key);
}

export function partialProbeStop(reply, http) {
  if (http.some((r) => r.status === 429)) return "HTTP429";
  return reply.kind === "PERSISTED" || (reply.kind === "IN_PROGRESS" && reply.reason === "BUDGET") ? undefined : "REFUSED_OR_INTERRUPTED";
}

/** Cutoff trial cannot skip its single pristine handoff or silently switch successor. */
export function cutoffContinuation(call, reply, before, after, handoffValid, successorId) {
  if (call !== 1) return successorId && reply.plan_id === successorId ? "CONTINUE" : "STOP";
  return handoffValid && reply.kind === "IN_PROGRESS" && reply.reason === "BUDGET" && reply.phase === "STAGE1"
    && reply.writes_done === 0 && before.active.length === 0 && after.active.length === 1
    && after.active[0] === reply.plan_id && after.plans === before.plans + 1
    && before.writes === after.writes && before.receipts === after.receipts ? "HANDOFF" : "STOP";
}

/** EXACT partial lineage only. Hashes bind ALL manifest/operation/journal fields, including timestamps. */
export function exactPartialEventCheckpoint(entries, binding, expected, key, now, lease, pins = partialCheckpoint) {
  if (!Array.isArray(entries) || !Number.isFinite(now) || (lease && (!(lease.expires_at instanceof Date)
    || !Number.isFinite(lease.expires_at.getTime()) || lease.expires_at.getTime() > now))) return false;
  const started = [];
  for (const { p, journal } of entries) {
    if (!p || !Array.isArray(journal)) return false;
    if (["AWAITING_STAGE1_WRITES", "TARGET_VERIFIED", "AWAITING_FINAL_VERIFY"].includes(p.plan_state)
      && (!(p.expires_at instanceof Date) || !Number.isFinite(p.expires_at.getTime()) || p.expires_at.getTime() > now)) return false;
    if (journal.some((r) => r.status !== "PENDING" || r.attempts !== 0 || r.sent_at || r.done_at || r.created_id || r.payload_hash || r.stamped_now || r.last_error)) {
      if (pins.completed.includes(p.plan_id) && p.plan_state === "FINAL_VERIFIED"
        && ["principal_id", "project", "lane", "runtime_logical_key", "runtime_id", "runtime_generation"].every((k) => p[k] === binding[k])
        && journal.length === 7 && journal.every((r) => r.status === "DONE" && r.attempts === 1 && !r.last_error)) continue;
      started.push({ p, journal });
    }
  }
  if (started.length !== 2) return false;
  const root = started.find(({ p }) => p.plan_id === pins.root_id), child = started.find(({ p }) => p.plan_id === pins.child_id);
  if (!root || !child || root.p.plan_state !== "EXPIRED"
    || !["AWAITING_STAGE1_WRITES", "EXPIRED"].includes(child.p.plan_state)
    || !fixedStartedEvent(root.p, root.journal, binding, expected, key)
    || child.p.plan_kind !== "BUSINESS" || child.p.run_mode !== "RECOVER_EXISTING" || child.p.plan_origin !== "AUTO_RECOVERY"
    || child.p.parent_plan_id !== root.p.plan_id || child.p.recovers_plan_id !== root.p.plan_id || child.p.run_ref !== pins.run_ref) return false;
  for (const entry of [root, child]) {
    if (!(entry.p.expires_at instanceof Date) || !Number.isFinite(entry.p.expires_at.getTime()) || entry.p.expires_at.getTime() > now) return false;
  }
  return immutablePlanHash(root.p) === pins.root_sha && checkpointHash(root.journal) === pins.root_journal_sha
    && immutablePlanHash(child.p) === pins.child_sha && checkpointHash(child.journal) === pins.child_journal_sha;
}

/** deriveRecoveryWrites, STAGE1 with op0 EXPECTED/ledger WRITTEN and op1 MISSING/ledger PREPARED.
 * No target0 or ledger CREATE is admitted. Notes do not grant authority; all executable fields must match. */
export function exactPreparedPartialRecovery(plan, journal, root, child, binding, now, pins = partialCheckpoint) {
  if (!plan || !root || !child || immutablePlanHash(root) !== pins.root_sha || immutablePlanHash(child) !== pins.child_sha
    || plan.plan_id === root.plan_id || plan.plan_id === child.plan_id || plan.binding_id !== binding.binding_id
    || plan.plan_kind !== "BUSINESS" || plan.plan_state !== "AWAITING_STAGE1_WRITES" || plan.run_mode !== "RECOVER_EXISTING"
    || plan.plan_origin !== "AUTO_RECOVERY" || plan.parent_plan_id !== root.plan_id || plan.recovers_plan_id !== root.plan_id
    || plan.run_ref !== pins.run_ref || !Number.isFinite(now) || !(plan.expires_at instanceof Date) || !(plan.expires_at.getTime() > now)) return false;
  for (const k of ["principal_id", "project", "lane", "runtime_logical_key", "runtime_id", "runtime_generation"])
    if (!binding[k] || plan[k] !== binding[k] || plan[k] !== root[k]) return false;
  for (const [k, field] of [["spec", "governing_spec_version"], ["schema", "governing_schema_version"], ["control", "governing_control_version"]])
    if (!binding.governing_versions_snapshot?.[k] || plan[field] !== binding.governing_versions_snapshot[k] || plan[field] !== root[field]) return false;
  const withoutIds = (p) => p.operations?.map(({ operation_id: _fresh, ...operation }) => operation);
  if (!isDeepStrictEqual(withoutIds(plan), withoutIds(root)) || !isDeepStrictEqual(plan.finalization_writes, root.finalization_writes)
    || !isDeepStrictEqual(plan.state_last_write, root.state_last_write)) return false;
  const bySymbol = (symbol) => child.stage1_writes.find((w) => w.symbol === symbol);
  const resume = bySymbol("RESUME_RUN"), target = bySymbol("TARGET_1"), written = bySymbol("LEDGER_1_WRITTEN");
  if (!resume || !target || !written) return false;
  const remaining = [
    { ...resume, fields: { Status: "RUNNING", "Attempt Count": 3,
      "Next Action": "recovery attempt 3: execute the recovery stage-1 actions (replay of operation(s) 1 permitted by the governing contract), then os_verify(TARGET)" } },
    { ...target, ordinal: 1 }, { ...written, ordinal: 2, target_ref: pins.ledger1_ref },
  ];
  const executable = ({ note: _note, ...w }) => w;
  if (!Array.isArray(plan.stage1_writes) || !isDeepStrictEqual(plan.stage1_writes.map(executable), remaining.map(executable))) return false;
  // Existing validator intentionally stays 11-row-only. This separate exact manifest has SEVEN rows.
  const manifest = [...plan.stage1_writes.map((w) => ({ ...w, phase: "STAGE1" })),
    ...plan.finalization_writes.map((w) => ({ ...w, phase: "FINALIZATION" })), { ...plan.state_last_write, phase: "STATE_LAST" }];
  if (!Array.isArray(journal) || journal.length !== 7 || manifest.length !== 7
    || new Set(journal.map((r) => r.symbol)).size !== 7 || new Set(manifest.map((w) => w.symbol)).size !== 7) return false;
  return manifest.every((w) => { const r = journal.find((x) => x.symbol === w.symbol);
    return r?.plan_id === plan.plan_id && r.ordinal === w.ordinal && r.phase === w.phase && r.operation === w.operation
      && r.target_ref === w.target_ref && r.status === "PENDING" && r.attempts === 0
      && !r.sent_at && !r.done_at && !r.created_id && !r.payload_hash && !r.stamped_now && !r.last_error;
  });
}

/** Only this expired three-started checkpoint; older admission remains unchanged. */
export function exactFinalEventCheckpoint(entries, binding, expected, key, now, lease, pins = finalCheckpoint) {
  if (!Array.isArray(entries) || !Number.isFinite(now)) return false;
  const matches = entries.filter(({ p }) => p?.plan_id === pins.final_child_id);
  if (matches.length !== 1) return false;
  const { p, journal } = matches[0];
  if (!["TARGET_VERIFIED", "EXPIRED"].includes(p.plan_state) || !(p.expires_at instanceof Date)
    || !Number.isFinite(p.expires_at.getTime()) || p.expires_at.getTime() > now
    || p.parent_plan_id !== pins.root_id || p.recovers_plan_id !== pins.root_id || p.run_ref !== pins.run_ref
    || immutablePlanHash(p) !== pins.final_child_sha || checkpointHash(journal) !== pins.final_child_journal_sha) return false;
  return exactPartialEventCheckpoint(entries.filter((entry) => entry !== matches[0]), binding, expected, key, now, lease, pins);
}

/** Actual FINALIZATION recovery: one RESUME_RUN UPDATE, inherited finalization/state-last only. */
export function exactPreparedFinalRecovery(plan, journal, root, child, binding, now, pins = finalCheckpoint) {
  if (!plan || !root || !child || immutablePlanHash(root) !== pins.root_sha || immutablePlanHash(child) !== pins.final_child_sha
    || [pins.root_id, pins.child_id, pins.final_child_id, ...(pins.forbidden_ids ?? [])].includes(plan.plan_id) || plan.binding_id !== binding.binding_id
    || plan.plan_kind !== "BUSINESS" || plan.plan_state !== "AWAITING_STAGE1_WRITES" || plan.run_mode !== "RECOVER_EXISTING"
    || plan.plan_origin !== "AUTO_RECOVERY" || plan.parent_plan_id !== root.plan_id || plan.recovers_plan_id !== root.plan_id
    || plan.run_ref !== pins.run_ref || !Number.isFinite(now) || !(plan.expires_at instanceof Date) || !(plan.expires_at.getTime() > now)) return false;
  for (const k of ["principal_id", "project", "lane", "runtime_logical_key", "runtime_id", "runtime_generation"])
    if (!binding[k] || plan[k] !== binding[k] || plan[k] !== root[k]) return false;
  for (const [k, field] of [["spec", "governing_spec_version"], ["schema", "governing_schema_version"], ["control", "governing_control_version"]])
    if (!binding.governing_versions_snapshot?.[k] || plan[field] !== binding.governing_versions_snapshot[k] || plan[field] !== root[field]) return false;
  const withoutIds = (p) => p.operations?.map(({ operation_id: _fresh, ...op }) => op);
  if (!isDeepStrictEqual(withoutIds(plan), withoutIds(root)) || !isDeepStrictEqual(plan.finalization_writes, root.finalization_writes)
    || !isDeepStrictEqual(plan.state_last_write, root.state_last_write)) return false;
  const resume = child.stage1_writes?.find((w) => w.symbol === "RESUME_RUN");
  if (!resume || resume.operation !== "UPDATE" || resume.target_ref !== pins.run_ref) return false;
  const attempt = pins.recovery_attempt ?? 4;
  const expected = [{ ...resume, ordinal: 0, fields: { Status: "RUNNING", "Attempt Count": attempt,
    "Next Action": `recovery attempt ${attempt}: execute RESUME_RUN, then os_verify(TARGET), then the finalization actions it returns, state-last LAST, then os_verify(FINAL)` } }];
  const executable = ({ note: _note, ...w }) => w;
  if (!Array.isArray(plan.stage1_writes) || !isDeepStrictEqual(plan.stage1_writes.map(executable), expected.map(executable))) return false;
  const manifest = [...plan.stage1_writes.map((w) => ({ ...w, phase: "STAGE1" })),
    ...plan.finalization_writes.map((w) => ({ ...w, phase: "FINALIZATION" })), { ...plan.state_last_write, phase: "STATE_LAST" }];
  if (!Array.isArray(journal) || journal.length !== 5 || manifest.length !== 5
    || new Set(journal.map((r) => r.symbol)).size !== 5 || new Set(manifest.map((w) => w.symbol)).size !== 5) return false;
  return manifest.every((w) => { const r = journal.find((x) => x.symbol === w.symbol);
    return r?.plan_id === plan.plan_id && r.ordinal === w.ordinal && r.phase === w.phase && r.operation === w.operation
      && r.target_ref === w.target_ref && r.status === "PENDING" && r.attempts === 0
      && !r.sent_at && !r.done_at && !r.created_id && !r.payload_hash && !r.stamped_now && !r.last_error;
  });
}

/** Four pinned started journals. SENT UPDATE is a checkpoint, never authority or proof of effect. */
export function exactCutoffEventCheckpoint(entries, binding, expected, key, now, lease, pins = cutoffCheckpoint) {
  if (!Array.isArray(entries) || !Number.isFinite(now)) return false;
  const matches = entries.filter(({ p }) => p?.plan_id === pins.cutoff_child_id);
  if (matches.length !== 1) return false;
  const { p, journal } = matches[0];
  if (!["TARGET_VERIFIED", "EXPIRED"].includes(p.plan_state) || !(p.expires_at instanceof Date)
    || !Number.isFinite(p.expires_at.getTime()) || p.expires_at.getTime() > now
    || p.parent_plan_id !== pins.root_id || p.recovers_plan_id !== pins.root_id || p.run_ref !== pins.run_ref
    || immutablePlanHash(p) !== pins.cutoff_child_sha || checkpointHash(journal) !== pins.cutoff_child_journal_sha) return false;
  return exactFinalEventCheckpoint(entries.filter((entry) => entry !== matches[0]), binding, expected, key, now, lease, pins);
}
export function exactPreparedCutoffRecovery(plan, journal, root, child, binding, now, pins = cutoffCheckpoint) {
  return exactPreparedFinalRecovery(plan, journal, root, child, binding, now, {
    ...pins, final_child_id: pins.cutoff_child_id, final_child_sha: pins.cutoff_child_sha,
    recovery_attempt: 5, forbidden_ids: [pins.final_child_id],
  });
}

export function replayUnchanged(before, after) {
  return ["writes", "receipts", "plans"].every((k) => Number.isInteger(before?.[k]) && before[k] >= 0 && before[k] === after?.[k]);
}

/** Exact OPEN_RUN-only checkpoint. A probe refusal never authorizes repairing its journal. */
export function fixedStartedEvent(plan, journal, binding, expected, key) {
  if (!plan || !binding || plan.plan_kind !== "BUSINESS" || plan.run_mode !== "OPEN_NEW"
    || plan.recovers_plan_id || plan.parent_plan_id || (plan.plan_origin ?? "INTENT") !== "INTENT"
    || !["AWAITING_STAGE1_WRITES", "EXPIRED"].includes(plan.plan_state)) return false;
  for (const k of ["principal_id", "project", "lane", "runtime_logical_key", "runtime_id", "runtime_generation"])
    if (!binding[k] || plan[k] !== binding[k]) return false;
  for (const [k, field] of [["spec", "governing_spec_version"], ["schema", "governing_schema_version"], ["control", "governing_control_version"]])
    if (!binding.governing_versions_snapshot?.[k] || plan[field] !== binding.governing_versions_snapshot[k]) return false;
  if (!key || expected?.length !== 2 || plan.operations?.length !== 2 || !plan.operations.every((op, i) =>
    op.ordinal === i && op.operation === "CREATE" && op.logical_resource_key === expected[i].resource
    && op.natural_key_property === expected[i].natural_key_property && op.natural_key === key
    && isDeepStrictEqual(op.expected_values, expected[i].values))) return false;
  if (!Array.isArray(journal) || journal.length !== 11) return false;
  const run = journal.find((r) => r.symbol === "OPEN_RUN");
  if (!run || run.status !== "DONE" || run.attempts !== 1 || !run.created_id || !run.done_at || !run.sent_at
    || !run.payload_hash || !run.stamped_now || run.last_error) return false;
  // Reuse only the exact bijection validator, not untouched-draft admission. Every other row stays pristine.
  const normalized = journal.map((r) => r === run ? { ...r, status: "PENDING", attempts: 0,
    created_id: undefined, done_at: undefined, sent_at: undefined, payload_hash: undefined, stamped_now: undefined } : r);
  return untouchedEventDraft(plan, normalized);
}

export function untouchedEventDraft(plan, journal) {
  if (!plan || plan.plan_kind !== "BUSINESS" || plan.run_mode !== "OPEN_NEW" || plan.recovers_plan_id
    || (plan.plan_origin ?? "INTENT") !== "INTENT" || plan.operations?.length !== 2) return false;
  return pristineManifestJournal(plan, journal);
}

function pristineManifestJournal(plan, journal) {
  if (!plan
    || plan.stage1_writes?.length !== 7 || plan.finalization_writes?.length !== 3 || !plan.state_last_write
    || !Array.isArray(journal) || journal.length !== 11) return false;
  const manifest = [...plan.stage1_writes.map((w) => ({ ...w, phase: "STAGE1" })),
    ...plan.finalization_writes.map((w) => ({ ...w, phase: "FINALIZATION" })), { ...plan.state_last_write, phase: "STATE_LAST" }];
  if (new Set(manifest.map((w) => w.symbol)).size !== 11 || new Set(journal.map((r) => r.symbol)).size !== 11) return false;
  return manifest.every((w) => {
    const r = journal.find((x) => x.symbol === w.symbol);
    return r?.plan_id === plan.plan_id && r.ordinal === w.ordinal && r.phase === w.phase
      && r.operation === w.operation && r.target_ref === w.target_ref && r.status === "PENDING" && r.attempts === 0
      && !r.sent_at && !r.done_at && !r.created_id && !r.payload_hash && !r.stamped_now && !r.last_error;
  });
}

/** One readback handoff only; the next public bare commit still performs every runtime check. */
export function exactPreparedEventRecovery(plan, journal, parent, parentJournal, binding, expected, key, now) {
  if (!fixedStartedEvent(parent, parentJournal, binding, expected, key) || !plan
    || plan.plan_kind !== "BUSINESS" || plan.plan_state !== "AWAITING_STAGE1_WRITES"
    || plan.run_mode !== "RECOVER_EXISTING" || plan.plan_origin !== "AUTO_RECOVERY"
    || plan.binding_id !== binding.binding_id || plan.plan_id === parent.plan_id
    || plan.parent_plan_id !== parent.plan_id || plan.recovers_plan_id !== parent.plan_id
    || !(plan.expires_at instanceof Date) || !(plan.expires_at.getTime() > now)) return false;
  for (const k of ["principal_id", "project", "lane", "runtime_logical_key", "runtime_id", "runtime_generation",
    "governing_spec_version", "governing_schema_version", "governing_control_version"])
    if (plan[k] !== parent[k]) return false;
  if (!Array.isArray(plan.operations)) return false;
  const withoutIds = (p) => p.operations.map(({ operation_id: _fresh, ...operation }) => operation);
  if (!isDeepStrictEqual(withoutIds(plan), withoutIds(parent))) return false;
  const run = parentJournal.find((r) => r.symbol === "OPEN_RUN").created_id;
  const first = plan.stage1_writes?.[0];
  return plan.run_ref === run && first?.symbol === "RESUME_RUN" && first.purpose === "RESUME_RUN"
    && first.operation === "UPDATE" && first.target_ref === run && pristineManifestJournal(plan, journal);
}

/** The caller FIRST validates the successor against the fixed canary binding/capture and sole active plan. */
export function exactUnwrittenPredecessor(previous, successor, journal) {
  if (!previous || !successor || previous.plan_state !== "SUPERSEDED" || previous.plan_id === successor.plan_id
    || previous.binding_id === successor.binding_id || !untouchedEventDraft(previous, journal)) return false;
  for (const field of ["principal_id", "project", "lane", "runtime_logical_key", "runtime_id", "runtime_generation",
    "governing_spec_version", "governing_schema_version", "governing_control_version"]) {
    if (previous[field] !== successor[field]) return false;
  }
  const capture = (p) => p.operations.map((op) => ({ logical_resource_key: op.logical_resource_key,
    operation: op.operation, target_data_source_ref: op.target_data_source_ref, natural_key: op.natural_key,
    natural_key_property: op.natural_key_property, idempotency_key: op.idempotency_key, expected_values: op.expected_values }));
  return isDeepStrictEqual(capture(previous), capture(successor));
}
