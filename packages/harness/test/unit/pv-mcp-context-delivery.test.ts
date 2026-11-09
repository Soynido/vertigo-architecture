import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer } from "../../src/index.ts";
import { FileHttpTokenRegistry, sha256, startHttpServer } from "../../src/server/http.ts";
import { dispatch, type HarnessDeps } from "../../src/tools/handlers.ts";
import { candidateAppAvailability, candidatePlainLanguage, candidateResume } from "../../src/tools/conduct.ts";
import type { Envelope } from "../../src/tools/envelope.ts";
import { buildResumeWorld, R } from "./resume-fixtures.ts";
import { OWNER, REP_B, T0 } from "./binding-fixtures.ts";
import { IDS } from "./sales-fixtures.ts";
import { synthetic, text } from "./meta-fixtures.ts";
import type { LocalOperatingDocuments } from "../../src/contractPack/localOperatingDocuments.ts";

const token = "synthetic-context-delivery-token", root = IDS("rep-a").root;
const pages = [synthetic("delivery-daily"), synthetic("delivery-engine")];
const titles = ["04 — DAILY GO PROTOCOL", "04A — DAILY DECISION ENGINE"];
const contents = pages.map((_page, d) => Array.from({ length: 22 }, (_v, i) =>
  `Document ${d}, paragraphe ${i} : ` + "Préserver l’expérience, le contexte et la progression. € • — ".repeat(23) + ` FIN-${d}-${i}`));
const list = (results: unknown[]) => ({ results, has_more: false, next_cursor: null });
const parent = (id: string) => ({ type: "page_id", page_id: id });
const body = (e: Envelope) => e.status === "OK" ? e.result : e.observations;
const present = (e: Envelope) => candidatePlainLanguage("os_resume", candidateAppAvailability(candidateResume(e)));

/** Synthetic fixture only: enough multibyte text to catch truncation, never private company data. */
function largeWorld() {
  const w = buildResumeWorld();
  w.map.set(`page:${root}`, { ...(w.map.get(`page:${root}`) as object), object: "page", id: root, archived: false, in_trash: false });
  w.map.set(`page:${R.salesCp}`, { object: "page", id: R.salesCp, archived: false, in_trash: false, parent: parent(root) });
  for (const id of [root, R.salesCp]) {
    const original = w.map.get(`children:${id}`) as { results: Record<string, unknown>[] };
    const extra = id === R.salesCp ? pages.map((p, i) => ({ id: p, type: "child_page", has_children: false,
      child_page: { title: titles[i] } })) : [];
    w.map.set(`children:${id}`, list([...original.results, ...extra].map(b => ({ ...b,
      archived: false, in_trash: false, has_children: false, parent: parent(id) }))));
  }
  pages.forEach((p, d) => {
    w.map.set(`page:${p}`, { object: "page", id: p, archived: false, in_trash: false, parent: parent(R.salesCp) });
    w.map.set(`children:${p}`, list(contents[d]!.map((value, i) => ({ id: synthetic(`delivery-${d}-${i}`),
      type: "paragraph", archived: false, in_trash: false, has_children: false, parent: parent(p),
      paragraph: { rich_text: [text(value)] } }))));
  });
  return w;
}

function normalized(e: Envelope) {
  const out = structuredClone(e);
  if (out.status === "OK" && typeof out.result["binding_handle"] === "string") delete out.result["binding_handle"];
  const remediation = body(out)["capability_remediation"] as { challenge?: string } | undefined;
  if (remediation) delete remediation.challenge;
  return out;
}

async function connected(deps: HarnessDeps, mode: "MEMORY" | "HTTP", principal = OWNER.principal_id) {
  const c = new Client({ name: "local-context-delivery", version: "0" });
  if (mode === "HTTP") {
    const s = await startHttpServer(deps, new FileHttpTokenRegistry([{ token_sha256: sha256(token), principal_id: principal }]), 0);
    try {
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${s.port}/mcp`),
        { requestInit: { headers: { authorization: `Bearer ${token}` } } });
      await c.connect(transport as unknown as Parameters<typeof c.connect>[0]);
      return { client: c, close: async () => { await c.close(); await s.close(); } };
    } catch (err) { await c.close(); await s.close(); throw err; }
  }
  const s = createServer(deps, principal), [ct, st] = InMemoryTransport.createLinkedPair();
  await s.connect(st); await c.connect(ct);
  return { client: c, close: async () => { await c.close(); await s.close(); } };
}

for (const mode of ["MEMORY", "HTTP"] as const) {
  test(`MCP context delivery ${mode}: full large SALES result, text/provenance/next intact, no hidden payload`, async t => {
    t.mock.timers.enable({ apis: ["Date"], now: T0 });
    const expectedWorld = largeWorld(), actualWorld = largeWorld();
    const expectedBind = await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, { principal_id: OWNER.principal_id }, expectedWorld.deps);
    assert.equal(expectedBind.status, "OK");
    const h = expectedBind.status === "OK" ? expectedBind.result["binding_handle"] : undefined;
    const raw = await dispatch("os_resume", { binding_handle: h, topic_hint: "CURRENT_WORK" },
      { principal_id: OWNER.principal_id, candidate_resume: true }, expectedWorld.deps);
    const expected = present(raw), snapshot = structuredClone([...actualWorld.map]);
    const docs = body(expected)["local_operating_documents"] as LocalOperatingDocuments;
    assert.equal(docs.status, "COMPLETE"); assert.equal(docs.documents.length, 2);
    assert.deepEqual(docs.documents.map(d => d.items.map(i => i.text)), contents);
    assert.deepEqual(body(expected)["local_operating_documents"], body(raw)["local_operating_documents"], "presentation must not filter source data");
    const connection = await connected(actualWorld.deps, mode);
    try {
      const bound = await connection.client.callTool({ name: "os_bind", arguments: { project: "VERTIGO", lane: "SALES" } });
      const binding = JSON.parse((bound.content as Array<{ text: string }>)[0]!.text) as Envelope;
      assert.equal(binding.status, "OK");
      const eventsAfterBind = await actualWorld.deps.store.events.list();
      const response = await connection.client.callTool({ name: "os_resume", arguments: {
        binding_handle: binding.status === "OK" ? binding.result["binding_handle"] : undefined, topic_hint: "CURRENT_WORK" } });
      assert.equal(response.isError, false); assert.equal(response.structuredContent, undefined); assert.equal(response._meta, undefined);
      const blocks = response.content as Array<{ type: string; text: string }>;
      assert.equal(blocks.length, 1); assert.equal(blocks[0]!.type, "text");
      assert.ok(Buffer.byteLength(blocks[0]!.text) > 64 * 1024, "test must cover a large multibyte result, not a small mock response");
      const delivered = JSON.parse(blocks[0]!.text) as Envelope;
      assert.deepEqual(normalized(delivered), normalized(expected), "the complete envelope reaches the SDK client");
      assert.deepEqual(body(delivered)["local_operating_documents"], docs);
      assert.equal(delivered.status, raw.status); assert.equal(delivered.code, raw.code);
      assert.deepEqual(delivered.next, expected.next); assert.deepEqual([...actualWorld.map], snapshot);
      assert.deepEqual(await actualWorld.deps.store.events.list(), eventsAfterBind, "resume adds no write/adoption event");
    } finally { await connection.close(); }
  });
}

test("MCP context delivery: META keeps its own result and no SALES documents or configuration", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const w = largeWorld(), before = structuredClone([...w.map]), connection = await connected(w.deps, "HTTP");
  try {
    const bound = await connection.client.callTool({ name: "os_bind", arguments: { project: "VERTIGO", lane: "META" } });
    const binding = JSON.parse((bound.content as Array<{ text: string }>)[0]!.text);
    const response = await connection.client.callTool({ name: "os_resume", arguments: { binding_handle: binding.result.binding_handle } });
    const e = JSON.parse((response.content as Array<{ text: string }>)[0]!.text) as Envelope;
    assert.equal(e.code, "RESUMED"); assert.equal(e.binding !== "UNKNOWN" && e.binding.lane, "META");
    assert.equal((body(e)["local_operating_documents"] as LocalOperatingDocuments).status, "NOT_SELECTED");
    assert.equal((body(e)["local_business_configuration"] as { status: string }).status, "NOT_SELECTED");
    assert.doesNotMatch(JSON.stringify(e), /FIN-0-0|FIN-1-21/);
    assert.deepEqual([...w.map], before);
  } finally { await connection.close(); }
});

test("MCP context delivery: foreign binding is refused without any source read or context disclosure", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const w = largeWorld(), bound = await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, { principal_id: OWNER.principal_id }, w.deps);
  assert.equal(bound.status, "OK");
  const noReads = new Proxy(w.deps.notion, { get: () => () => assert.fail("foreign binding must not read a source") });
  const connection = await connected({ ...w.deps, notion: noReads }, "MEMORY", REP_B.principal_id);
  try {
    const response = await connection.client.callTool({ name: "os_resume", arguments: { binding_handle: bound.status === "OK" ? bound.result["binding_handle"] : undefined } });
    const e = JSON.parse((response.content as Array<{ text: string }>)[0]!.text) as Envelope;
    assert.equal(response.isError, true); assert.equal(e.code, "ERROR_PRINCIPAL_MISMATCH");
    assert.doesNotMatch(JSON.stringify(e), /FIN-0-0|FIN-1-21|delivery-daily|delivery-engine/);
  } finally { await connection.close(); }
});
