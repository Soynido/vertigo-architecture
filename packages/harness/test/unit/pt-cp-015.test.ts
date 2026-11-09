/**
 * PT-CP-015 — W2.5 privacy / bounds (CONTRACT_PACK/0.3.0-candidate, D7, S4–S6).
 *
 * Rep A's Personal SALES runtime with proved Business Configuration answers (redactValues), and rep B, an active
 * principal of the same project with a runtime of their own. The answers are served inside `selected_context` to
 * the principal the binding belongs to, for a need the candidate catalogue selects, and to nobody else. They never
 * reach a log line, an event, HOLD evidence, a warning or the pack telemetry — through the real MCP transport too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { CONTEXT_BOUNDS } from "../../src/contractPack/catalog.ts";
import { packTelemetry, type ContractPack, type SelectedContext } from "../../src/contractPack/pack.ts";
import { createServer } from "../../src/index.ts";
import type { NotionReadClient } from "../../src/notion/readClient.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import { dispatch, type HarnessDeps } from "../../src/tools/handlers.ts";
import { handleOf, OWNER, REP_B, T0 } from "./binding-fixtures.ts";
import { answerRow, BC, bindSales, buildSetupWorld, NOTE_MARK, proveRows, resume, RIVAL_MARK, stepOf, STEPS, type Bound, type SetupWorld } from "./pt-cp-012.fixtures.ts";

const HINT = "SALES_SETUP_INPUTS";
const SERVED = STEPS.slice(0, 5);
const rowsThrough = (n: number) => STEPS.slice(0, n).map((s) => answerRow(BC("rep-a").ds, s));

const bag = (e: Envelope): Record<string, unknown> => (e.status === "OK" ? (e.result as Record<string, unknown>) : e.observations);
const packOf = (e: Envelope): ContractPack | undefined => bag(e)?.["contract_pack"] as ContractPack | undefined;

/** Everything a console method prints while `run` is in flight. */
async function capturingLogs<T>(run: () => Promise<T>): Promise<{ readonly value: T; readonly logs: string }> {
  const lines: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const saved = methods.map((m) => console[m]);
  methods.forEach((m) => { console[m] = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); }; });
  try { return { value: await run(), logs: lines.join("\n") }; } finally { methods.forEach((m, i) => { console[m] = saved[i]!; }); }
}

/** Rep A on B5 with the five B0 → B4 answers proved by a FINAL of this runtime. */
async function provedWorld(): Promise<{ readonly sw: SetupWorld; readonly bound: Bound }> {
  const sw = buildSetupWorld("B5_OUTREACH", 5);
  const bound = await bindSales(sw);
  await proveRows(sw, bound, rowsThrough(5));
  sw.client.reset();
  return { sw, bound };
}

/** The envelope with `selected_context` removed: where a business value must never be. */
function outsideSelectedContext(e: Envelope): string {
  const c = JSON.parse(JSON.stringify(e)) as { result?: Record<string, unknown>; observations?: Record<string, unknown> };
  for (const b of [c.result, c.observations]) {
    const p = b?.["contract_pack"] as { selected_context?: unknown } | undefined;
    if (p) delete p.selected_context;
  }
  return JSON.stringify(c);
}

function assertNoValue(where: string, text: string, values: readonly string[] = SERVED.map((s) => s.value)): void {
  for (const v of values) assert.equal(text.includes(v), false, `a business value leaked into ${where}: ${v}`);
  assert.equal(text.includes("SENTINEL"), false, "a sentinel leaked into " + where);
  assert.equal(text.includes(NOTE_MARK), false, "a non-projected column leaked into " + where);
}

/** Every key of the served content, at any depth. */
function keysOf(v: unknown, into: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) keysOf(x, into);
  else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) { into.push(k); keysOf(x, into); }
  return into;
}

/** A read client that fails every read of one page after the first, as a row that became unreadable would. */
function flakyAfterFirst(inner: NotionReadClient, pageId: string): NotionReadClient {
  let seen = 0;
  return {
    retrievePage: async (id: string) => { if (id === pageId && ++seen > 1) throw new Error(`fixture: ${id} unreadable`); return inner.retrievePage(id); },
    retrieveDatabase: (id: string) => inner.retrieveDatabase(id),
    retrieveDataSource: (id: string) => inner.retrieveDataSource(id),
    retrieveBlockChildren: (id: string) => inner.retrieveBlockChildren(id),
    queryDataSource: (id: string, filter: unknown) => inner.queryDataSource(id, filter as never),
  } as NotionReadClient;
}

// ─────────────────────────────── cross-principal ───────────────────────────────

test("PT-CP-015/a: another principal holding the handle, or none at all, gets no selected_context and causes zero reads", async () => {
  const { sw, bound } = await provedWorld();
  const own = await resume(sw, bound.handle, HINT);
  assert.equal(own.code, "RESUMED");
  const served = JSON.stringify(packOf(own)!.selected_context);
  for (const s of SERVED) assert.ok(served.includes(s.value), "served to the bound principal: " + s.gate);
  sw.client.reset();

  for (const [who, ctx, code] of [
    ["rep B", { principal_id: REP_B.principal_id, now: T0 }, "ERROR_PRINCIPAL_MISMATCH"],
    ["an unknown principal", { principal_id: "p-nobody", now: T0 }, undefined],
    ["no principal", { principal_id: undefined, now: T0 }, "ERROR_AUTH_REQUIRED"],
  ] as const) {
    const { value: e, logs } = await capturingLogs(() => dispatch("os_resume", { binding_handle: bound.handle, topic_hint: HINT }, ctx, sw.deps));
    assert.equal(e.status, "ERROR", who);
    if (code) assert.equal(e.code, code, who);
    assert.equal(packOf(e), undefined, `${who} gets no contract pack`);
    assertNoValue(`${who}'s envelope`, JSON.stringify(e));
    assertNoValue(`${who}'s logs`, logs);
    assert.deepEqual(sw.client.reads, [], `${who} causes no Notion read at all`);
  }
});

test("PT-CP-015/b: rep B's own binding never serves nor reads rep A's Business Configuration", async () => {
  const { sw } = await provedWorld();
  const repB = { principal_id: REP_B.principal_id, now: T0 };
  const handle = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, repB, sw.deps));
  sw.client.reset();
  const e = await dispatch("os_resume", { binding_handle: handle, topic_hint: HINT }, repB, sw.deps);
  assertNoValue("rep B's envelope", JSON.stringify(e));
  assert.deepEqual(sw.client.on(BC("rep-a").ds), [], "rep A's Business Configuration is never read for rep B");
  assert.deepEqual(sw.client.on(BC("rep-a").db), []);
  // And the converse: rep A's served content never carries rep B's rival answers.
  const { sw: a, bound } = await provedWorld();
  assert.equal(JSON.stringify(await resume(a, bound.handle, HINT)).includes(RIVAL_MARK), false);
});

// ─────────────────────────────── D7 through the real transport ───────────────────────────────

async function connected(deps: HarnessDeps, principalId: string | undefined): Promise<Client> {
  const server = createServer(deps, principalId);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "pt-cp-015", version: "0" });
  await client.connect(clientTransport);
  return client;
}
const envelopeOf = (r: unknown): Envelope => JSON.parse((r as { content: { text: string }[] }).content[0]!.text) as Envelope;

test("PT-CP-015/c: over MCP the values reach the bound principal inside selected_context; the log line carries closed enums only", async () => {
  const sw = buildSetupWorld("B5_OUTREACH", 5);
  const owner = await connected(sw.deps, OWNER.principal_id);
  const rival = await connected(sw.deps, REP_B.principal_id);
  const { value, logs } = await capturingLogs(async () => {
    const bindEnvelope = envelopeOf(await owner.callTool({ name: "os_bind", arguments: { project: "VERTIGO", lane: "SALES" } }));
    const b = (bindEnvelope as unknown as { binding: { runtime_id: string; runtime_generation: string } }).binding;
    const bound: Bound = { handle: handleOf(bindEnvelope), runtime_id: b.runtime_id, runtime_generation: b.runtime_generation };
    await proveRows(sw, bound, rowsThrough(5));
    const mine = envelopeOf(await owner.callTool({ name: "os_resume", arguments: { binding_handle: bound.handle, topic_hint: HINT } }));
    sw.client.reset();
    const stolen = await rival.callTool({ name: "os_resume", arguments: { binding_handle: bound.handle, topic_hint: HINT } });
    return { mine, stolen, readsByRival: [...sw.client.reads] };
  });
  await owner.close();
  await rival.close();

  assert.equal(value.mine.code, "RESUMED");
  const served = JSON.stringify(packOf(value.mine)!.selected_context);
  for (const s of SERVED) assert.ok(served.includes(s.value), "served over MCP: " + s.gate);
  assertNoValue("the envelope outside selected_context", outsideSelectedContext(value.mine));
  assertNoValue("the pack telemetry", JSON.stringify(packTelemetry(packOf(value.mine)!)));

  assert.equal(value.stolen.isError, true);
  const stolen = envelopeOf(value.stolen);
  assert.equal(stolen.code, "ERROR_PRINCIPAL_MISMATCH");
  assertNoValue("the cross-principal result", JSON.stringify(value.stolen));
  assert.deepEqual(value.readsByRival, [], "a foreign handle reads nothing");

  // Paired lifecycle traces: closed enums and server-generated correlation, never selected context.
  const lines = logs.split("\n").filter((l) => l.includes("tool="));
  assert.equal(lines.length, 6);
  const starts = lines.filter(l => l.includes("event=START")), ends = lines.filter(l => l.includes("event=END"));
  assert.equal(starts.length, 3); assert.equal(ends.length, 3);
  for (const l of starts) assert.match(l, /^\S+ tool=os_(bind|resume) event=START call=[a-f0-9]{16} request=NONE$/);
  for (const l of ends) {
    assert.match(l, /^\S+ tool=os_(bind|resume) status=(OK|HOLD|ERROR) code=[A-Z][A-Z0-9_]* event=END call=[a-f0-9]{16} request=NONE /);
    assert.ok(l.length <= 640);
    const id = l.match(/call=([a-f0-9]{16})/)![1];
    assert.equal(starts.filter(s => s.includes(`call=${id}`)).length, 1);
  }
  assertNoValue("the logs", logs);
  for (const id of [OWNER.principal_id, REP_B.principal_id, BC("rep-a").ds]) assert.equal(logs.includes(id), false, "no id in the logs: " + id);
});

// ─────────────────────────────── D7 on HOLD and on the foreign-write path ───────────────────────────────

test("PT-CP-015/d: an outer HOLD serves no value and its evidence, warnings and events carry none", async () => {
  const { sw, bound } = await provedWorld();
  sw.setGate("B5_OUTREACH", { recovery: true });
  const { value: e, logs } = await capturingLogs(() => resume(sw, bound.handle, HINT));
  assert.equal(e.status, "HOLD");
  assertNoValue("the HOLD envelope", JSON.stringify(e));
  assertNoValue("the HOLD evidence", JSON.stringify((e as { evidence?: unknown }).evidence ?? null));
  assertNoValue("the events", JSON.stringify(await sw.deps.store.events.list()));
  assertNoValue("the logs", logs);
});

test("PT-CP-015/e: a changed proved row is asked to the bound principal; no warning, evidence, event or log names its value", async () => {
  const { sw, bound } = await provedWorld();
  const changed = "SENTINEL-FOREIGN nouvelle cible décidée hors produit";
  const b2 = stepOf("B2_ICP");
  const b2Id = answerRow(BC("rep-a").ds, b2).id;
  sw.setRows([...rowsThrough(5).filter((r) => r.id !== b2Id), answerRow(BC("rep-a").ds, b2, { value: changed })]);
  const values = [...SERVED.map((s) => s.value), changed];

  const { value: e, logs } = await capturingLogs(() => resume(sw, bound.handle, HINT));
  const confirmation = bag(e)["pending_confirmation"] as { kind: string; natural_key: string } | undefined;
  assert.equal(confirmation?.kind, "FOREIGN_WRITE", "the change is asked, not refused");
  assert.equal(confirmation?.natural_key, b2.key);
  for (const [where, text] of [
    ["warnings", JSON.stringify(e.warnings)],
    ["evidence", JSON.stringify((e as { evidence?: unknown }).evidence ?? null)],
    ["events", JSON.stringify(await sw.deps.store.events.list())],
    ["telemetry", JSON.stringify(packOf(e) ? packTelemetry(packOf(e)!) : null)],
    ["logs", logs],
  ] as const) assertNoValue(where, text, values);

  // The same row unreadable between the check and the question: the warning says so without its value.
  const flaky: HarnessDeps = { ...sw.deps, notion: flakyAfterFirst(sw.client, b2Id) };
  const u = await dispatch("os_resume", { binding_handle: bound.handle, topic_hint: HINT }, { principal_id: OWNER.principal_id, now: T0 }, flaky);
  const unconfirmable = u.warnings.filter((w) => w.startsWith("foreign_write_unconfirmable:"));
  assert.equal(unconfirmable.length, 1, JSON.stringify(u.warnings));
  assertNoValue("the unconfirmable warning", JSON.stringify(u.warnings), values);
  assertNoValue("the unconfirmable evidence", JSON.stringify((u as { evidence?: unknown }).evidence ?? null), values);
});

// ─────────────────────────────── S4–S6 preserved ───────────────────────────────

test("PT-CP-015/f: S4 bounds are unchanged and measured; S6 omission is announced; no cursor is ever served", async () => {
  assert.deepEqual(CONTEXT_BOUNDS, { max_rows_per_section: 10, max_serialized_bytes: 16384 });
  const { sw, bound } = await provedWorld();
  const e = await resume(sw, bound.handle, HINT);
  const sc: SelectedContext = packOf(e)!.selected_context;
  assert.equal(sc.bounds.max_rows_per_section, 10);
  assert.equal(sc.bounds.max_serialized_bytes, 16384);
  assert.equal(sc.bounds.serialized_bytes, Buffer.byteLength(JSON.stringify(sc), "utf8"), "measured on the complete payload");
  assert.ok(sc.bounds.serialized_bytes <= 16384);
  for (const block of sc.contexts) {
    for (const s of block.sections) {
      assert.ok(s.items.length <= 10, s.section_key);
      assert.equal(s.served, s.items.length, s.section_key);
      assert.equal(s.omitted, Math.max(0, s.available - s.served), `${s.section_key}: every row not served is announced`);
    }
  }
  assert.deepEqual(keysOf(sc).filter((k) => /cursor/i.test(k)), [], "no pagination cursor, public or otherwise");
});
