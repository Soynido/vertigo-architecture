/**
 * PT-LEGACY-001 — legacy names inert (PV-WRITE-001 / W3.2, D4; PDEC-018 CANDIDATE — NOT ADOPTED).
 *
 * /a — MCP CallTool os_prepare, on a world where os_commit WOULD persist the same intent: HOLD_CLIENT_UPGRADE_REQUIRED,
 *      the exact sentence, 0 Notion write, 0 plan/lease/Run/ledger row/event; never routed to os_commit.
 * /b — MCP CallTool os_verify (valid, unknown or malformed arguments): the same refusal, no effect.
 * /c — W3.3: ListTools announces exactly the five BUILD TARGET names; the two retired names are absent (and stay inert).
 * /d — os_bind, os_resume, os_handoff and os_control_status still reach their own handlers; os_commit still commits.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { hashHandle } from "../../src/binding/handle.ts";
import { createServer } from "../../src/index.ts";
import { candidateResumeDescription, toolDescriptions, toolInputSchemas, TOOL_NAMES } from "../../src/tools/surface.ts";
import { OWNER } from "./binding-fixtures.ts";
import { R } from "./resume-fixtures.ts";
import { b0Intent, guardWorld, NOW, rowsOf, type GuardWorld } from "../support/guard-fixtures.ts";

const SENTENCE = "Cette version de l'application doit être rafraîchie : réajoutez VERTIGO à la conversation.";
const FIVE = ["os_bind", "os_resume", "os_commit", "os_handoff", "os_control_status"];

async function quietly<T>(f: () => Promise<T>): Promise<{ value: T; logged: string[] }> {
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try { return { value: await f(), logged }; } finally { console.error = original; }
}

async function connected(g: GuardWorld): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createServer(g.deps, OWNER.principal_id);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(ct);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const { value: r, logged } = await quietly(() => client.callTool({ name, arguments: args }));
  return { r, out: JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as Record<string, unknown>, logged };
}

/** Every durable surface the transaction path could touch, counted. */
async function footprint(g: GuardWorld, h: string) {
  const b = (await g.deps.store.bindings.findByHandleHash(hashHandle(h)))!;
  return {
    notion_writes: g.client.writes.length,
    plans: (await g.deps.store.plans.listByRuntime(b.project, b.lane, b.runtime_generation)).length,
    lease: await g.deps.store.leases.current({ project: b.project, lane: b.lane, runtime_generation: b.runtime_generation }, NOW),
    runs: rowsOf(g.map, R.salesRunsDs).length,
    ledger: rowsOf(g.map, R.salesLedgerDs).length,
    events: (await g.deps.store.events.list({})).length,
  };
}

function assertRefusal(out: Record<string, unknown>, isError: unknown, name: string, logged: readonly string[]): void {
  assert.equal(isError, false);
  assert.deepEqual(
    [out["kind"], out["code"], out["phase"], out["wrote_anything"], out["missing"], out["say"]],
    ["HELD", "HOLD_CLIENT_UPGRADE_REQUIRED", "PREPARE", false, [], SENTENCE],
    JSON.stringify(out),
  );
  assert.equal(out["plan_id"], undefined, "no plan is named");
  assert.equal(out["status"], undefined, "not a six-tool envelope");
  assert.deepEqual(logged.filter((l) => l.includes("tool=")).map((l) => l.replace(/^\S+ /, "")), [`tool=${name} outcome=HELD code=HOLD_CLIENT_UPGRADE_REQUIRED`], "one closed-enum trace, no commit line");
}

test("PT-LEGACY-001/a: os_prepare by CallTool is refused with the upgrade sentence, writes nothing and is never routed to os_commit", async () => {
  const g = guardWorld();
  const h = await g.bind();
  await g.approve(); // os_commit would persist this very intent here (see /d)
  const before = await footprint(g, h);
  const { client, close } = await connected(g);
  try {
    const { r, out, logged } = await call(client, "os_prepare", { binding_handle: h, ...b0Intent() });
    assertRefusal(out, r.isError, "os_prepare", logged);
    const { r: r2, out: out2, logged: logged2 } = await call(client, "os_prepare", { binding_handle: h });
    assertRefusal(out2, r2.isError, "os_prepare", logged2);
  } finally { await close(); }
  assert.deepEqual(await footprint(g, h), before, "0 write, 0 plan, 0 lease, 0 Run, 0 ledger row, 0 event");
});

test("PT-LEGACY-001/b: os_verify by CallTool is refused identically, whatever its arguments, with no effect", async () => {
  const g = guardWorld();
  const h = await g.bind();
  await g.approve();
  const before = await footprint(g, h);
  const { client, close } = await connected(g);
  try {
    for (const args of [{ binding_handle: h, plan_id: "plan-unknown", phase: "TARGET" }, { binding_handle: h, plan_id: "plan-unknown", phase: "FINAL" }, {}, { binding_handle: "foreign", phase: "BOGUS" }]) {
      const { r, out, logged } = await call(client, "os_verify", args);
      assertRefusal(out, r.isError, "os_verify", logged);
    }
  } finally { await close(); }
  assert.deepEqual(await footprint(g, h), before);
});

test("PT-LEGACY-001/c: ListTools announces exactly the five W3.3 names; os_prepare / os_verify are no longer announced", async () => {
  const g = guardWorld();
  const { client, close } = await connected(g);
  try {
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map((t) => t.name), FIVE);
    assert.deepEqual([...TOOL_NAMES], FIVE);
    for (const retired of ["os_prepare", "os_verify"]) assert.ok(!tools.some((t) => t.name === retired), `${retired} is still announced`);
    for (const t of tools) assert.equal(t.description, t.name === "os_resume" ? candidateResumeDescription : toolDescriptions[t.name as keyof typeof toolDescriptions]);
    const retiredInputs = ["binding_handle", "capability_evidence", "intent"];
    assert.deepEqual(Object.keys(toolInputSchemas.os_prepare.shape).sort(), retiredInputs, "the retired os_prepare input stays unchanged");
    assert.deepEqual(Object.keys(tools.find((t) => t.name === "os_commit")?.inputSchema.properties ?? {}).sort(), [...retiredInputs, "external_event_evidence"].sort(), "only the candidate native capture extends os_commit");
  } finally { await close(); }
});

test("PT-LEGACY-001/d: os_bind, os_resume, os_handoff and os_control_status keep their handlers; os_commit still persists after a legacy refusal", async () => {
  const g = guardWorld();
  await g.approve();
  const { client, close } = await connected(g);
  try {
    const bound = await call(client, "os_bind", { project: "VERTIGO", lane: "SALES" });
    assert.equal(bound.out["code"], "BOUND", JSON.stringify(bound.out));
    // The MCP os_bind above runs on the wall clock; os_commit runs on the fixture clock, so bind on that clock.
    const h = await g.bind();
    for (const name of ["os_resume", "os_handoff", "os_control_status"]) {
      const { out, logged } = await call(client, name, { binding_handle: h });
      assert.ok(["OK", "HOLD", "ERROR"].includes(out["status"] as string), `${name} answers its own envelope: ${JSON.stringify(out).slice(0, 200)}`);
      assert.notEqual(out["code"], "HOLD_CLIENT_UPGRADE_REQUIRED");
      assert.ok(logged.some((l) => l.includes(`tool=${name} status=`)));
    }
    const refused = await call(client, "os_prepare", { binding_handle: h, ...b0Intent() });
    assert.equal(refused.out["code"], "HOLD_CLIENT_UPGRADE_REQUIRED");
    assert.equal(g.client.writes.length, 0, "the refusal sent no Notion byte");
    const committed = await call(client, "os_commit", { binding_handle: h, ...b0Intent() });
    assert.equal(committed.out["kind"], "PERSISTED", JSON.stringify(committed.out));
    assert.ok(g.client.writes.length > 0, "the same intent persists only through os_commit");
  } finally { await close(); }
});
