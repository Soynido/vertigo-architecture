/**
 * PT-SCHEMA-001 — Mutation Ledger exposes structured Harness Plan/Receipt identity (INTEGRATION, blocking, PG4, PV0-013).
 * Procedure: inspect the fixture Mutation Ledger schema before/after the governed fixture migration; query plan/receipt
 * fields by exact property. Also re-runs PT-TARGET-009's schema branch against the contract detector.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../../src/tools/handlers.ts";
import { checkSchemaCompatibility, migrateFixtureSchema, schemaContractOf } from "../../src/verify/schemaContract.ts";
import { META_CONTROL_PLANE_06, SALES_CONTROL_PLANE_05 } from "../../src/versions/adapters/controlPlane.ts";
import { resolveRuntimeFor } from "../../src/tools/handlers.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import type { Plan } from "../../src/plans/store.ts";
import { handleOf, OWNER, T0 } from "./binding-fixtures.ts";
import { buildResumeWorld, R, SCHEMAS } from "./resume-fixtures.ts";
import { executeWrites, rowsOf } from "./target-fixtures.ts";

const ctx = { principal_id: OWNER.principal_id, now: T0 };
const intent = { action_class: "COMMIT", summary: "q", mutations: [{ logical_resource_key: "META:GATES", operation: "UPDATE" as const, record_selector: { natural_key: "T1" }, desired_changes: { "Next Question": "What is the offer?" } }] };

test("PT-SCHEMA-001/a: the contract names structured plan/receipt identity fields for both grammars", () => {
  for (const g of [META_CONTROL_PLANE_06, SALES_CONTROL_PLANE_05]) {
    const c = schemaContractOf(g);
    const names = (xs: readonly { name: string; level: string }[]) => xs.filter((x) => x.level === "REQUIRED").map((x) => x.name);
    assert.deepEqual(names(c.runs), ["Status", "Harness Plan ID"]);
    assert.deepEqual(names(c.ledger), ["Status", "Run Ref", "Harness Plan ID", "Idempotency Key", "Target Receipt ID"]);
  }
});

test("PT-SCHEMA-001/b: before migration the detector lists exact gaps and TARGET HOLDs; after the pure fixture migration it is compatible and the linkage is filterable", async () => {
  const w = buildResumeWorld();
  // Legacy ledger schema: no harness identity at all.
  const legacy = { properties: { Mutation: { type: "title" }, "Mutation ID": { type: "unique_id" }, Status: { type: "select" }, "Run Ref": { type: "rich_text" } } };
  w.map.set(`data_source:${R.metaLedgerDs}`, legacy);
  const { ["Harness Plan ID"]: _drop, ...runsRest } = SCHEMAS.metaRuns.properties as Record<string, unknown>;
  void _drop;
  w.map.set(`data_source:${R.metaRunsDs}`, { properties: runsRest });
  const principal = (await w.deps.principals.get(OWNER.principal_id))!;
  const resolved = await resolveRuntimeFor(w.deps, principal, "VERTIGO", "META");
  assert.equal(resolved.kind, "RESOLVED");
  const runtime = (resolved as { runtime: import("../../src/resolvers/types.ts").ResolvedRuntime }).runtime;

  const before = await checkSchemaCompatibility(w.deps.notion, runtime);
  assert.equal(before.compatible, false);
  assert.deepEqual(before.migration.map((m) => `${m.database}.${m.property}:${m.type}`), [
    "META — RUNS.Harness Plan ID:rich_text",
    "META — MUTATION LEDGER.Harness Plan ID:rich_text",
    "META — MUTATION LEDGER.Idempotency Key:rich_text",
    "META — MUTATION LEDGER.Target Receipt ID:rich_text",
  ]);
  assert.deepEqual(before.ledger.recommended_missing.map((m) => m.name), ["Target Ref", "Operation"]);

  // os_prepare warns (read-only) and still plans; TARGET then refuses with the exact migration.
  const h = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w.deps));
  const prep = await dispatch("os_prepare", { binding_handle: h, intent }, ctx, w.deps);
  assert.equal(prep.code, "PLAN_PREPARED");
  assert.ok(prep.warnings.some((x) => x.includes("control-plane schema incompatible")));
  assert.equal((prep.observations["control_plane_schema"] as { compatible: boolean }).compatible, false);
  const plan = (await w.deps.store.plans.get(((prep as Extract<Envelope, { status: "OK" }>).result as { plan_id: string }).plan_id))!;
  executeWrites(w, plan.stage1_writes, plan.plan_id);
  const v1 = await dispatch("os_verify", { binding_handle: h, plan_id: plan.plan_id, phase: "TARGET" }, ctx, w.deps);
  assert.equal(v1.code, "HOLD_SCHEMA_MISMATCH");
  assert.deepEqual((v1.observations["schema_migration"] as Array<{ property: string }>).map((m) => m.property), ["Harness Plan ID", "Harness Plan ID", "Idempotency Key", "Target Receipt ID"]);
  assert.deepEqual(await w.deps.store.receipts.findByPlan(plan.plan_id, "TARGET"), []);

  // Governed fixture migration (pure): the schema objects gain the required properties; Notion fixture rows untouched.
  const contract = schemaContractOf(runtime.adapter.controlPlane);
  const rowsBefore = JSON.stringify(rowsOf(w, R.metaLedgerDs));
  w.map.set(`data_source:${R.metaLedgerDs}`, migrateFixtureSchema(legacy, contract.ledger));
  w.map.set(`data_source:${R.metaRunsDs}`, migrateFixtureSchema({ properties: runsRest as Record<string, { type: string }> }, contract.runs));
  assert.equal(JSON.stringify(rowsOf(w, R.metaLedgerDs)), rowsBefore);
  const after = await checkSchemaCompatibility(w.deps.notion, runtime);
  assert.equal(after.compatible, true);
  assert.deepEqual(after.migration, []);
  assert.equal(((w.map.get(`data_source:${R.metaLedgerDs}`) as { properties: Record<string, { type: string }> }).properties["Target Receipt ID"] as { type: string }).type, "rich_text");

  // A plan prepared against the migrated schema (fresh runtime: the aborted plan's stage-1 Run would otherwise be a
  // legitimate recovery hold) writes the identity fields; verification filters by exact property.
  const w2 = buildResumeWorld();
  w2.map.set(`data_source:${R.metaLedgerDs}`, migrateFixtureSchema(legacy, contract.ledger));
  w2.map.set(`data_source:${R.metaRunsDs}`, migrateFixtureSchema({ properties: runsRest as Record<string, { type: string }> }, contract.runs));
  const h2 = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "META" }, ctx, w2.deps));
  const prep2 = await dispatch("os_prepare", { binding_handle: h2, intent }, ctx, w2.deps);
  assert.equal(prep2.code, "PLAN_PREPARED", JSON.stringify(prep2));
  assert.ok(!prep2.warnings.some((x) => x.includes("control-plane schema incompatible")));
  assert.equal((prep2.observations["control_plane_schema"] as { compatible: boolean }).compatible, true);
  const plan2 = (await w2.deps.store.plans.get(((prep2 as Extract<Envelope, { status: "OK" }>).result as { plan_id: string }).plan_id))! as Plan;
  const ledgerWrite = plan2.stage1_writes.find((s) => s.symbol === "LEDGER_0")!;
  assert.equal(ledgerWrite.fields["Harness Plan ID"], plan2.plan_id);
  assert.equal(ledgerWrite.fields["Idempotency Key"], plan2.operations[0]!.idempotency_key);
  const created = executeWrites(w2, plan2.stage1_writes, plan2.plan_id);
  const v2 = await dispatch("os_verify", { binding_handle: h2, plan_id: plan2.plan_id, phase: "TARGET" }, ctx, w2.deps);
  assert.equal(v2.code, "TARGET_VERIFIED", JSON.stringify(v2));
  const res = (v2 as Extract<Envelope, { status: "OK" }>).result as { target_receipt_id: string; run_ref: string; finalization_actions: Array<{ properties: Record<string, unknown> }> };
  assert.equal(res.run_ref, created["OPEN_RUN"]);
  // The ledger row is retrievable by exact plan id / idempotency key properties, and the receipt lands in a structured field.
  const row = rowsOf(w2, R.metaLedgerDs).find((p) => (p.properties["Harness Plan ID"] as unknown as { rich_text: Array<{ plain_text: string }> }).rich_text[0]?.plain_text === plan2.plan_id)!;
  assert.ok(row);
  assert.equal((row.properties["Idempotency Key"] as unknown as { rich_text: Array<{ plain_text: string }> }).rich_text[0]?.plain_text, plan2.operations[0]!.idempotency_key);
  assert.equal(res.finalization_actions, undefined);
  const { resolveInstruction } = await import("../../src/transactions/write.ts");
  const resolvedWrite = resolveInstruction(plan2.finalization_writes[0]!, { created, target_receipt_id: res.target_receipt_id, now: T0 });
  assert.ok(resolvedWrite.ok);
  assert.equal(resolvedWrite.instruction.fields["Target Receipt ID"], res.target_receipt_id);
});
