/**
 * PT-CP-010 (local part) — the packaged surface and trust boundaries are unchanged by Contract Pack, and the
 * telemetry projection obeys the allowlist. The fresh-lane halves (PT-CP-008/009) stay NOT_RUN: they require
 * ordinary ChatGPT lanes and a controlled second SALES fixture (PV0-024F).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { TOOL_NAMES, toolInputSchemas } from "../../src/tools/surface.ts";
import { buildContractPack, packTelemetry } from "../../src/contractPack/pack.ts";
import { POLICY_VERSION } from "../../src/contractPack/catalog.ts";
import { dispatch } from "../../src/tools/handlers.ts";
import { handleOf, OWNER, T0 } from "./binding-fixtures.ts";
import { buildResumeWorld, extIntent, R } from "./resume-fixtures.ts";
import { text } from "./meta-fixtures.ts";
import type { Page } from "../../src/notion/shapes.ts";

const ctx = { principal_id: OWNER.principal_id, now: T0 };

test("PT-CP-010/a: exactly five tools (W3.3), and os_resume still accepts only binding_handle and topic_hint", () => {
  assert.deepEqual([...TOOL_NAMES], ["os_bind", "os_resume", "os_commit", "os_handoff", "os_control_status"]);
  const shape = toolInputSchemas.os_resume;
  assert.equal(shape.safeParse({ binding_handle: "h" }).success, true);
  assert.equal(shape.safeParse({ binding_handle: "h", topic_hint: "CURRENT_WORK" }).success, true);
  for (const extra of ["pack_id", "state_fingerprint", "contract_pack", "needs", "resource_key", "runtime_id"]) {
    assert.equal(shape.safeParse({ binding_handle: "h", [extra]: "x" }).success, false, `${extra} must be refused`);
  }
});

test("PT-CP-010/b: the Contract Pack module introduces no Notion write path and no Gmail send capability", async () => {
  const markers = ["api.notion.com", "sendMessage", "searchSent(", "fetch(", "http", "credential"];
  for (const f of ["../../src/contractPack/pack.ts", "../../src/contractPack/catalog.ts"]) {
    const src = await readFile(fileURLToPath(new URL(f, import.meta.url)), "utf8");
    for (const m of markers) assert.equal(src.includes(m), false, `${f} must not reference ${m}`);
  }
});

test("PT-CP-010/c: the pack is served on a successful resume and carries the frozen policy version", async () => {
  const w = buildResumeWorld();
  const h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps));
  const r = await dispatch("os_resume", { binding_handle: h, topic_hint: "CURRENT_WORK" }, ctx, w.deps);
  assert.equal(r.code, "RESUMED");
  const pack = (r.result as Record<string, unknown>)["contract_pack"] as { policy_version: string };
  assert.equal(pack.policy_version, POLICY_VERSION);
});

test("PT-CP-010/d: telemetry carries only symbolic values — never a ref, URL, recipient, subject or thread id", async () => {
  const w = buildResumeWorld();
  const intent = extIntent(R.run3, "NOT_OBSERVED");
  w.setSalesExternal([{ ...intent, properties: { ...intent.properties, Recipient: { type: "email", email: "prospect@example.invalid" }, "Thread ID / Context": { type: "rich_text", rich_text: [text("thread-42")] } } as Page["properties"] }]);
  const h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, ctx, w.deps));
  const r = await dispatch("os_resume", { binding_handle: h, topic_hint: "SALES_EMAIL_RECONCILIATION" }, ctx, w.deps);
  const pack = ((r.status === "OK" ? (r.result as Record<string, unknown>) : r.observations)["contract_pack"]) as Parameters<typeof packTelemetry>[0];
  // The bound response legitimately carries the narrow Gmail selector...
  assert.ok(JSON.stringify(pack).includes("prospect@example.invalid"), "the pointer keeps the routing selector the native read needs");
  // ...but the telemetry projection must not.
  const t = JSON.stringify(packTelemetry(pack));
  for (const leak of ["@", "thread-42", "example.invalid", R.run3, pack.state_fingerprint, pack.pack_id]) {
    assert.equal(t.includes(leak), false, `telemetry must not contain ${leak}`);
  }
  assert.deepEqual(Object.keys(JSON.parse(t) as object).sort(), ["completeness", "completeness_reason", "normalized_needs", "pointer_count", "policy_version", "resource_keys"]);
});

test("PT-CP-010/e: an empty pack telemetry is still well formed", () => {
  const { pack } = buildContractPack({ lane: "META", runtime_generation: "g", versions: { governing_spec: "S", governing_schema: "H", governing_control: "C", candidate_versions: [] }, safety: {}, open_backend_plan: "NONE" });
  assert.deepEqual(packTelemetry(pack), { policy_version: POLICY_VERSION, normalized_needs: ["CURRENT_WORK"], resource_keys: [], pointer_count: 0, completeness: "COMPLETE", completeness_reason: "NONE" });
});
