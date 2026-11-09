/**
 * PT-GMAIL-008 / 009 evidence runner: runs the harness routing gate over a captured Gmail snapshot for an intent
 * that is durably FINAL-verified (stubbed in the in-memory store with a FINAL receipt). Read-only: cannot send.
 * usage: live-gmail-gate.ts <snapshot.json> <intent.json> <mode> [approved_from] [approved_to]
 */
import { readFile } from "node:fs/promises";
import { createMemoryStore } from "../src/store/memory.ts";
import { routeExternalAction, SnapshotCompetentSource, type ExecutionMode, type IntentView, type MailboxMessage } from "../src/effects/gmail.ts";
import type { Plan } from "../src/plans/store.ts";

const [snapshotPath, intentPath, mode, from, to] = process.argv.slice(2);
if (!snapshotPath || !intentPath || !mode) { console.error("usage: live-gmail-gate.ts <snapshot.json> <intent.json> <mode> [approved_from] [approved_to]"); process.exit(2); }
const snap = JSON.parse(await readFile(snapshotPath, "utf8")) as { identity: string; messages: MailboxMessage[] };
const { intent } = JSON.parse(await readFile(intentPath, "utf8")) as { intent: IntentView };
const store = createMemoryStore();
const now = new Date();
const gen = "live-evidence-generation";
const plan: Plan = { plan_id: "plan-live-evidence", principal_id: "p-owner", binding_id: "b", project: "VERTIGO", lane: "SALES", runtime_logical_key: "VERTIGO/SALES/canary", runtime_id: "canary", runtime_generation: gen, governing_spec_version: process.env["EVIDENCE_SPEC_VERSION"] ?? "UNKNOWN", governing_schema_version: process.env["EVIDENCE_SCHEMA_VERSION"] ?? "UNKNOWN", governing_control_version: "UNKNOWN", run_mode: "OPEN_NEW", execution_attempt_id: "att", created_at: now, expires_at: new Date(now.getTime() + 900_000), baseline_runtime_revision: "r", operations: [{ operation_id: "op", ordinal: 0, logical_resource_key: "SALES:EXTERNAL_ACTIONS", natural_key: intent.action_key, natural_key_property: "Action Key", idempotency_key: "k", operation: "CREATE", compared_fields: [], before_values: {}, expected_values: {} }], stage1_writes: [], finalization_writes: [], state_last_write: { ordinal: 0, symbol: "S", target_ref: "x", operation: "UPDATE", fields: {}, purpose: "STATE_LAST" }, plan_state: "FINAL_VERIFIED" };
await store.plans.insert(plan);
await store.receipts.insert({ receipt_id: "final-live", type: "FINAL", plan_id: plan.plan_id, principal_id: "p-owner", runtime_id: "canary", runtime_generation: gen, observed_at: now, observations: {}, status: "VALID" });
const out = await routeExternalAction(store.receipts, { plan, intent, requested_action_key: intent.action_key, requested_intent_ref: intent.intent_ref, runtime_generation: gen, mode: mode as ExecutionMode, ...(from && to ? { approved_test_scope: { from: from.toLowerCase(), to: to.split(",").map((x) => x.toLowerCase()) } } : {}), source: new SnapshotCompetentSource(snap.identity, snap.messages) });
console.log(JSON.stringify({ ran_at: now.toISOString(), mode, intent_effect_status: intent.effect_status, approval_state: intent.approval_state ?? "NONE", outcome: out }, null, 2));
