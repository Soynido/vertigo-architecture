/**
 * PT-ISO-002 — one workspace integration, one member's space: a write outside the authenticated principal's own
 * runtime is HOLD_CROSS_RUNTIME with zero bytes sent (PV-WRITE-001 / W1.4, decision D1).
 *
 * Six cases, each against a writer whose HTTP layer counts every byte: a principal replaying another's plan; a
 * SALES binding aimed at a META page; a plan prepared before a rotation; a plan stored before the registry
 * moved the runtime; a valid id outside the root; a relation outside the runtime. A control case proves the
 * same plan, untouched and in scope, is READY — with the exact encoded request and still zero bytes sent,
 * because the W1.4 skeleton never sends.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpNotionClient, type NotionHttp } from "../../src/notion/client.ts";
import type { Plan, WriteInstruction } from "../../src/plans/store.ts";
import { journaledWrite, resolveInstruction, stampNow, type JournaledWriteContext, type WriteScope } from "../../src/transactions/write.ts";
import { synthetic } from "../unit/meta-fixtures.ts";

const ID = {
  runs: synthetic("iso-runs"), ledger: synthetic("iso-ledger"), contacts: synthetic("iso-contacts"),
  target: synthetic("iso-target"), company: synthetic("iso-company"), cursor: synthetic("iso-cursor"),
  run: synthetic("iso-created-run"), ledgerRow: synthetic("iso-created-ledger"),
  metaManifest: synthetic("iso-meta-manifest"), foreign: synthetic("iso-foreign-page"), foreignDs: synthetic("iso-foreign-ds"),
  rootA: synthetic("iso-root-rep-a"), rootB: synthetic("iso-root-rep-b"),
};
const NOW = new Date("2030-01-03T10:15:42.123Z");

function counting(): { bytes: () => number; calls: () => number; writer: HttpNotionClient } {
  let bytes = 0;
  let calls = 0;
  const http: NotionHttp = async (_url, init) => { calls += 1; bytes += Buffer.byteLength(init.body ?? ""); return { status: 200, json: async () => ({ id: ID.run, last_edited_time: "t" }) }; };
  return { bytes: () => bytes, calls: () => calls, writer: new HttpNotionClient("token", http, { retryBaseMs: 0 }) };
}

const W = {
  openRun: { ordinal: 0, symbol: "OPEN_RUN", target_ref: ID.runs, operation: "CREATE", purpose: "OPEN_RUN", fields: { Name: "PLUGIN — contact", Status: "RUNNING" }, property_types: { Name: "title", Status: "select" } },
  ledger: { ordinal: 1, symbol: "LEDGER_1", target_ref: ID.ledger, operation: "CREATE", purpose: "PREPARE_LEDGER", fields: { Name: "SALES:CONTACTS UPDATE", Status: "PREPARED", Run: "$created:OPEN_RUN", Target: ID.target }, property_types: { Name: "title", Status: "select", Run: "relation", Target: "relation" } },
  target: { ordinal: 2, symbol: "TARGET_1", target_ref: ID.target, operation: "UPDATE", purpose: "WRITE_TARGET", fields: { Stage: "Qualified", Company: `page:${ID.company}`, "Last Touch": "$now" }, property_types: { Stage: "select", Company: "relation", "Last Touch": "date" } },
  finalize: { ordinal: 3, symbol: "FINALIZE_RUN", target_ref: "$created:OPEN_RUN", operation: "UPDATE", purpose: "FINALIZE_RUN", fields: { Status: "COMPLETED", Receipt: "$receipt:TARGET" }, property_types: { Status: "select", Receipt: "rich_text" } },
  stateLast: { ordinal: 4, symbol: "STATE_LAST", target_ref: ID.cursor, operation: "UPDATE", purpose: "STATE_LAST", fields: { "Current Step": "B4" }, property_types: { "Current Step": "rich_text" } },
} satisfies Record<string, WriteInstruction>;

function plan(over: Partial<Record<keyof Plan, unknown>> = {}, writes: Partial<typeof W> = {}): Plan {
  const w = { ...W, ...writes };
  return {
    plan_id: "plan-rep-a-1", principal_id: "p-rep-a", binding_id: "b-rep-a", project: "VERTIGO", lane: "SALES",
    runtime_logical_key: "SALES:rep-a", runtime_id: ID.rootA, runtime_generation: "g1",
    operations: [{ operation_id: "op1", ordinal: 1, logical_resource_key: "SALES:CONTACTS", physical_target_ref: ID.target, target_data_source_ref: ID.contacts, idempotency_key: "k1", operation: "UPDATE", compared_fields: ["Stage"], before_values: {}, expected_values: w.target.fields }],
    stage1_writes: [w.openRun, w.ledger, w.target], finalization_writes: [w.finalize], state_last_write: w.stateLast,
    ...over,
  } as unknown as Plan;
}

const scopeA: WriteScope = {
  principal_id: "p-rep-a",
  binding: { binding_id: "b-rep-a", principal_id: "p-rep-a", project: "VERTIGO", lane: "SALES", runtime_logical_key: "SALES:rep-a", runtime_id: ID.rootA, runtime_generation: "g1", status: "BOUND" },
  runtime: { lane: "SALES", logical_key: "SALES:rep-a", runtime_id: ID.rootA, runtime_generation: "g1", root_ref: ID.rootA },
  control_sources: new Set([ID.runs, ID.ledger]),
  cursor_ref: ID.cursor,
  proven_pages: new Set([ID.company]),
};
const created = { OPEN_RUN: ID.run, LEDGER_1: ID.ledgerRow };
const options = { Status: ["RUNNING", "PREPARED", "COMPLETED"], Stage: ["New", "Qualified"] };

function run(p: Plan, scope: WriteScope, symbols: readonly string[] = ["OPEN_RUN", "LEDGER_1", "TARGET_1", "FINALIZE_RUN", "STATE_LAST"]) {
  const c = counting();
  const ctx: JournaledWriteContext = { scope, plan: p, resolve: { created, target_receipt_id: "rcpt-target-1", now: NOW }, options, writer: c.writer };
  const all = [...p.stage1_writes, ...p.finalization_writes, p.state_last_write];
  const results = symbols.map((s) => journaledWrite(ctx, all.find((x) => x.symbol === s) as WriteInstruction));
  return { results, bytes: c.bytes(), calls: c.calls() };
}

function assertHeld(r: ReturnType<typeof run>, symbol: string, evidence: RegExp) {
  const held = r.results.find((x) => x.symbol === symbol);
  assert.ok(held && held.kind === "HELD", `${symbol} must be HELD: ${JSON.stringify(held)}`);
  assert.equal(held.code, "HOLD_CROSS_RUNTIME");
  assert.match(held.evidence.join(" | "), evidence);
  assert.equal(r.calls, 0, "no request reached the HTTP layer");
  assert.equal(r.bytes, 0, "zero bytes sent");
}

test("PT-ISO-002/control: the principal's own plan, in scope, is READY with the exact request — and the skeleton sends nothing", () => {
  const r = run(plan(), scopeA);
  assert.deepEqual(r.results.map((x) => x.kind), ["READY", "READY", "READY", "READY", "READY"]);
  const target = r.results[2] as Extract<(typeof r.results)[number], { kind: "READY" }>;
  assert.deepEqual(target.properties, { Stage: { select: { name: "Qualified" } }, Company: { relation: [{ id: ID.company }] }, "Last Touch": { date: { start: "2030-01-03T10:15:00.000Z" } } });
  const fin = r.results[3] as Extract<(typeof r.results)[number], { kind: "READY" }>;
  assert.equal(fin.target_id, ID.run);
  assert.deepEqual(fin.properties["Receipt"], { rich_text: [{ type: "text", text: { content: "rcpt-target-1" } }] });
  assert.match(target.payload_hash, /^[0-9a-f]{64}$/);
  assert.equal(r.calls, 0);
  assert.equal(r.bytes, 0);
});

test("PT-ISO-002/1: another principal replaying rep A's plan (rep B authenticated) is held, 0 bytes", () => {
  const repB: WriteScope = { ...scopeA, principal_id: "p-rep-b", binding: { ...scopeA.binding, binding_id: "b-rep-b", principal_id: "p-rep-b", runtime_logical_key: "SALES:rep-b", runtime_id: ID.rootB }, runtime: { ...scopeA.runtime, logical_key: "SALES:rep-b", runtime_id: ID.rootB, root_ref: ID.rootB } };
  assertHeld(run(plan(), repB, ["OPEN_RUN"]), "OPEN_RUN", /another principal/);
  // Even a binding forged to rep A's ids does not help a caller authenticated as rep B.
  assertHeld(run(plan(), { ...scopeA, principal_id: "p-rep-b" }, ["TARGET_1"]), "TARGET_1", /another principal/);
});

test("PT-ISO-002/2: a SALES binding aimed at a META page is held, 0 bytes", () => {
  const aimed = plan({}, { target: { ...W.target, target_ref: ID.metaManifest } });
  assertHeld(run(aimed, scopeA, ["TARGET_1"]), "TARGET_1", /neither created nor targets/);
  // And a META plan presented on the SALES binding never gets past the lane check.
  assertHeld(run(plan({ lane: "META", runtime_logical_key: "META:vertigo" }), scopeA, ["OPEN_RUN"]), "OPEN_RUN", /is for VERTIGO\/META/);
});

test("PT-ISO-002/3: a plan prepared before a runtime rotation is held, 0 bytes", () => {
  const rotated: WriteScope = { ...scopeA, binding: { ...scopeA.binding, runtime_generation: "g2" }, runtime: { ...scopeA.runtime, runtime_generation: "g2" } };
  assertHeld(run(plan(), rotated, ["OPEN_RUN"]), "OPEN_RUN", /generation g1; the runtime is now at g2/);
});

test("PT-ISO-002/4: a plan stored before the registry moved the runtime is held, 0 bytes", () => {
  const moved: WriteScope = { ...scopeA, runtime: { ...scopeA.runtime, logical_key: "SALES:rep-a-moved", runtime_id: synthetic("iso-root-moved"), root_ref: synthetic("iso-root-moved") } };
  assertHeld(run(plan(), moved, ["TARGET_1"]), "TARGET_1", /registry now resolves this binding to SALES:rep-a-moved/);
});

test("PT-ISO-002/5: a valid Notion id outside the root is held, 0 bytes — as an UPDATE target and as a CREATE source", () => {
  assertHeld(run(plan({}, { stateLast: { ...W.stateLast, target_ref: ID.foreign } }), scopeA, ["STATE_LAST"]), "STATE_LAST", new RegExp(`updates page ${ID.foreign}`));
  assertHeld(run(plan({}, { openRun: { ...W.openRun, target_ref: ID.foreignDs } }), scopeA, ["OPEN_RUN"]), "OPEN_RUN", new RegExp(`data source ${ID.foreignDs}`));
  // An instruction that is not the stored plan's own is refused too, whatever it targets.
  const c = counting();
  const forged = journaledWrite({ scope: scopeA, plan: plan(), resolve: { created, now: NOW }, options, writer: c.writer }, { ...W.stateLast, fields: { "Current Step": "B7" } });
  assert.ok(forged.kind === "HELD" && forged.code === "HOLD_CROSS_RUNTIME" && /not an instruction of stored plan/.test(forged.evidence.join(" ")));
  assert.equal(c.bytes(), 0);
});

test("PT-ISO-002/6: a relation to a page outside the runtime is held, 0 bytes", () => {
  const linked = plan({}, { target: { ...W.target, fields: { ...W.target.fields, Company: `page:${ID.foreign}` } } });
  assertHeld(run(linked, scopeA, ["TARGET_1"]), "TARGET_1", new RegExp(`Company links page ${ID.foreign}`));
  const rawId = plan({}, { ledger: { ...W.ledger, fields: { ...W.ledger.fields, Target: ID.foreign } } });
  assertHeld(run(rawId, scopeA, ["LEDGER_1"]), "LEDGER_1", /Target links page/);
});

test("PT-ISO-002/resolve: an unbound symbol is refused before scope and encoding; $now is stamped at the minute", () => {
  const r = resolveInstruction(W.finalize, { created: {}, now: NOW });
  assert.ok(!r.ok && r.code === "HOLD_SCHEMA_MISMATCH" && /\$created:OPEN_RUN/.test(r.evidence[0] as string) && /\$receipt:TARGET/.test(r.evidence[0] as string));
  assert.equal(stampNow(NOW), "2030-01-03T10:15:00.000Z");
});
