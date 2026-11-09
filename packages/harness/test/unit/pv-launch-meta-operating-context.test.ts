import assert from "node:assert/strict";
import { test } from "node:test";
import { buildResumeWorld, R } from "./resume-fixtures.ts";
import { ID, V, synthetic, text } from "./meta-fixtures.ts";
import { OWNER, handleOf, T0 } from "./binding-fixtures.ts";
import { dispatch } from "../../src/tools/handlers.ts";
import type { NotionReadClient } from "../../src/notion/readClient.ts";
import { MetaRuntimeResolver } from "../../src/resolvers/meta.ts";
import { readMetaOperatingContext } from "../../src/contractPack/metaOperatingContext.ts";
import { runPage } from "./resume-fixtures.ts";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {FileHttpTokenRegistry,sha256,startHttpServer} from "../../src/server/http.ts";
import type {Envelope} from "../../src/tools/envelope.ts";
import { createServer } from "../../src/index.ts";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
const frame = synthetic("meta-frame"), pkg = synthetic("meta-private-package"), decisionDb = synthetic("meta-decisions-db"), decisionDs = synthetic("meta-decisions-ds"), objectiveDb = synthetic("meta-objectives-db"), objectiveDs = synthetic("meta-objectives-ds");
const list = (results: unknown[], more = false, cursor: string | null = null) => ({ results, has_more: more, next_cursor: cursor });
const page = (id: string, parent?: string) => ({ object: "page", id, archived: false, in_trash: false, last_edited_time: "2030-01-01T00:00:00.000Z", ...(parent ? { parent: { type: "page_id", page_id: parent } } : {}) });
const block = (id: string, parent: string, value: string, type = "paragraph", has_children = false) => ({ object: "block", id, type, archived: false, in_trash: false, has_children, parent: { type: "page_id", page_id: parent }, [type]: { rich_text: [text(value)] } });
const child = (id: string, title: string, type = "child_page") => ({ ...block(id, ID.rootA, "", type), [type]: { title } });
const rich = (s: string) => ({ type: "rich_text", rich_text: [text(s)] }), title = (s: string) => ({ type: "title", title: [text(s)] }), state = (s: string) => ({ type: "select", select: { name: s } });
function world(optIn = true) {
    const w = buildResumeWorld(), values = new Map<string, unknown>(), calls: string[] = [];
    const children = (w.map.get(`children:${ID.rootA}`) as {
        results: unknown[];
    }).results as Record<string, unknown>[];
    w.map.set(`children:${ID.rootA}`, list([...children.map(b => ({ ...b, object: "block", archived: false, in_trash: false, has_children: false, parent: { type: "page_id", page_id: ID.rootA } })), child(frame, "01 — COMPANY FRAME & GOVERNANCE"), child(pkg, "VERTIGO_GTM_TEST/1.0 — BUSINESS PACKAGE — NOT PUBLISHED"), child(decisionDb, "META — DECISIONS", "child_database"), child(objectiveDb, "META — OBJECTIVES", "child_database")]));
    const key = (method: string, id: string, cursor?: string) => JSON.stringify([method, id, cursor ?? null]);
    values.set(key("page", frame), page(frame, ID.rootA));
    values.set(key("page", pkg), page(pkg, ID.rootA));
    values.set(key("children", frame), list([block(synthetic("frame-text"), frame, "CONFIRMED: project studio, existing client assets. Owner is not a seller.")]));
    values.set(key("children", pkg), list([block(synthetic("package-text"), pkg, "Consolidated business, NOT PUBLISHED. New amendments remain candidates.")]));
    const registry = { ...(w.map.get(`database:${R.metaRegistryDb}`) as object), archived: false, in_trash: false, parent: { type: "page_id", page_id: ID.rootA } };
    w.map.set(`database:${R.metaRegistryDb}`, registry);
    const registryRows = [{ k: "META_COMPANY_FRAME", ref: frame, type: "PAGE" }, { k: "META_DECISIONS", ref: decisionDb, type: "DATABASE" }, { k: "META_OBJECTIVES", ref: objectiveDb, type: "DATABASE" }].map(({ k, ref, type }) => ({ ...page(synthetic(k)), parent: { type: "data_source_id", data_source_id: R.metaRegistryDs }, properties: { "Resource Key": rich(k), "Resource URL": { type: "url", url: `https://example.invalid/p/${ref}` }, "Parent URL": { type: "url", url: `https://example.invalid/p/${ID.rootA}` }, "Resource Type": state(type), Scope: state("PRIVATE_META"), Status: state("RESOLVED"), "Schema Version": rich(V.schema) } }));
    for (const [db, ds, name, properties] of [[decisionDb, decisionDs, "META — DECISIONS", { Decision: { type: "title" }, Resolution: { type: "rich_text" }, Status: { type: "select" } }], [objectiveDb, objectiveDs, "META — OBJECTIVES", { Objective: { type: "title" }, Target: { type: "number" }, Status: { type: "select" } }]] as const) {
        values.set(key("database", db), { object: "database", id: db, archived: false, in_trash: false, parent: { type: "page_id", page_id: ID.rootA }, title: [text(name)], data_sources: [{ id: ds, name }] });
        values.set(key("source", ds), { object: "data_source", id: ds, archived: false, in_trash: false, parent: { type: "database_id", database_id: db }, properties });
    }
    values.set(key("query", decisionDs), list([{ ...page(synthetic("d1")), parent: { type: "data_source_id", data_source_id: decisionDs }, properties: { Decision: title("Q4 approved frame"), Resolution: rich("Reuse known answers; do not restart workshop"), Status: state("DECIDED") } }, { ...page(synthetic("d0")), parent: { type: "data_source_id", data_source_id: decisionDs }, properties: { Decision: title("Old seller allocation"), Resolution: rich("Superseded, not current"), Status: state("SUPERSEDED") } }]));
    values.set(key("query", objectiveDs), list([{ ...page(synthetic("o1")), parent: { type: "data_source_id", data_source_id: objectiveDs }, properties: { Objective: title("Company Q4 objective"), Target: { type: "number", number: 6 }, Status: state("APPROVED") } }]));
    const base = w.deps.notion;
    async function read(method: string, id: string, cursor?: string) { calls.push(key(method, id, cursor)); const v = values.get(key(method, id, cursor)); if (v instanceof Error)
        throw v; if (v !== undefined)
        return v; return method === "page" ? base.retrievePage(id) : method === "database" ? base.retrieveDatabase(id) : method === "source" ? base.retrieveDataSource(id) : base.retrieveBlockChildren(id, cursor); }
    const notion: NotionReadClient = { retrievePage: id => read("page", id), retrieveDatabase: id => read("database", id), retrieveDataSource: id => read("source", id), retrieveBlockChildren: (id, c) => read("children", id, c), queryDataSource: async (id, f, c, o) => {
            if (id === R.metaRegistryDs && JSON.stringify(f).includes("META_COMPANY_FRAME")) {
                calls.push(key("registry", id, c));
                return list(registryRows);
            }
            if (id === decisionDs || id === objectiveDs) {
                assert.equal(o?.page_size, 11);
                assert.deepEqual(o?.sorts, [{ timestamp: "last_edited_time", direction: "descending" }]);
                return read("query", id, c);
            }
            return base.queryDataSource(id, f, c, o);
        } };
    const deps = { ...w.deps, notion, config: { ...w.deps.config, metaRecoveryStatusPrincipalIds: optIn ? [OWNER.principal_id] : [] } };
    const ctx = { principal_id: OWNER.principal_id, now: T0 };
    let handle: string | undefined;
    const resume = async (hint = "CURRENT_WORK") => { handle ??= handleOf(await dispatch("os_bind", { lane: "META" }, ctx, deps)); return dispatch("os_resume", { binding_handle: handle, topic_hint: hint }, ctx, deps); };
    const context = async () => { const r = await new MetaRuntimeResolver(notion, `https://example.invalid/p/${ID.specRoot}`, "VERTIGO", deps.adapters.metaRuntime).resolve(); assert.equal(r.kind, "RESOLVED"); if (r.kind !== "RESOLVED")
        throw Error("runtime"); return readMetaOperatingContext(notion, r.runtime, true); };
    return { w, deps, ctx, values, calls, key, registryRows, resume, context };
}
async function firstBinding(f: ReturnType<typeof world>, args: Record<string, unknown> = { lane: "META" }) {
    const server = createServer(f.deps, OWNER.principal_id);
    const client = new Client({ name: "owner-cold-start-fixture", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st); await client.connect(ct);
    try {
        const reply = await client.callTool({ name: "os_bind", arguments: args });
        return { wire: reply, envelope: reply.isError ? undefined : JSON.parse((reply.content as Array<{text: string}>)[0]!.text) };
    } finally { await client.close(); await server.close(); }
}
test("owner cold start: the first binding response carries a fresh passive state and business sources without a second client call", async () => {
    const f = world(), before = structuredClone([...f.w.map]);
    const { envelope: bound } = await firstBinding(f);
    assert.equal(bound.code, "BOUND");
    const initial = bound.result.initial_read;
    assert.equal(initial?.code, "RESUMED", "cold start must return state, not only a handle that needs another host round trip");
    const context = bound.result.local_meta_operating_context;
    assert.ok(context, "fresh conduct's result.local_meta_operating_context path must resolve in the actual wire reply");
    assert.equal(context.trust, "SOURCE_DATA_ONLY");
    assert.equal(context.tables[1].rows[0].values.Target, 6);
    assert.equal(context.effectivity, "NOT_EVALUATED");
    assert.equal(context.documents[0].role, "PRIVATE_BUSINESS_PACKAGE", "first-message business reading must expose the consolidated source before the older company frame");
    assert.equal(context.documents.length, 2);
    assert.equal(context.documents[1].items[0].text, "CONFIRMED: project studio, existing client assets. Owner is not a seller.");
    assert.equal(initial.result, undefined, "the business payload is served once, not duplicated in an inaccessible nested result");
    assert.equal(bound.next.permitted_tool_call, undefined);
    assert.ok(bound.next.conduct.includes(initial.next.conduct), "the exact fresh state's stops and presentation must reach the caller");
    assert.deepEqual([...f.w.map], before, "launch must not modify Notion");
    assert.equal((await f.deps.store.plans.listByRuntime(bound.binding.project, bound.binding.lane, bound.binding.runtime_generation)).length, 0);
});
test("owner cold start: recovery remains a HOLD, with no source reads or manufactured success", async () => {
    const f = world();
    f.w.setMetaRuns([runPage({ id: R.run2, label: "TRUN-2", status: "RUNNING" })]);
    f.w.setMetaManifest({ lastRunId: R.run2, recovery: true });
    const before = structuredClone([...f.w.map]);
    const { envelope: bound } = await firstBinding(f);
    assert.equal(bound.result.initial_read?.status, "HOLD");
    assert.equal(bound.result.initial_read?.code, "HOLD_RECOVERY_REQUIRED");
    assert(!f.calls.some(k => k.includes(frame) || k.includes(pkg)));
    assert.deepEqual([...f.w.map], before);
});
test("owner cold start: no opt-in or non-owner authority keeps the old bind-only response, and callers cannot forge passive mode", async () => {
    for (const f of [world(false), world()]) {
        if (f.deps.config.metaRecoveryStatusPrincipalIds?.length) f.w.setPrincipals([{ ...OWNER, meta_authority: "VIEWER" }]);
        const { envelope: bound } = await firstBinding(f);
        assert.equal(bound.result.initial_read, undefined);
        assert.equal(bound.next.permitted_tool_call, "os_resume");
        assert(!f.calls.some(k => k.includes(frame) || k.includes(pkg)));
    }
    const { wire } = await firstBinding(world(), { lane: "META", readonly_initial_read: true });
    assert.equal(wire.isError, true);
});
test("owner cold start: revocation during initial read withholds the entire initial state", async () => {
    const f = world(), base = f.deps.notion;
    f.deps.notion = { ...base, retrieveBlockChildren: async (id, c) => {
        const result = await base.retrieveBlockChildren(id, c);
        if (id === pkg) f.w.setPrincipals([{ ...OWNER, status: "SUSPENDED" }]);
        return result;
    } };
    const { wire } = await firstBinding(f);
    assert.equal(wire.isError, true);
    const response = (wire.content as Array<{text: string}>)[0]!.text;
    assert(!response.includes("CONFIRMED: project studio"));
    assert(!response.includes("local_meta_operating_context"));
    assert(!response.includes("initial_read"));
});
test("META launch: opt-in resume delivers existing business text and declared states on both admitted needs without changing safety", async () => {
    const f = world(), protectedBefore = structuredClone([...f.w.map]);
    for (const hint of ["CURRENT_WORK", "META_SETUP_INPUTS"]) {
        const reply = await f.resume(hint);
        assert.equal(reply.status, "OK");
        assert.equal(reply.code, "RESUMED");
        if (reply.status !== "OK")
            throw Error("resume");
        const data = reply.result.local_meta_operating_context as {
            trust: string;
            status: string;
            documents: Array<{
                items: Array<{
                    text: string;
                }>;
            }>;
            tables: Array<{
                rows: Array<{
                    values: Record<string, unknown>;
                }>;
            }>;
            effectivity: string;
        };
        assert.ok(data, "business data must reach the actual returned envelope, not remain a locator");
        assert.equal(data.trust, "SOURCE_DATA_ONLY");
        assert.equal(data.effectivity, "NOT_EVALUATED");
        assert.ok(data.documents[0], JSON.stringify(data));
        assert.equal(data.documents[0]!.items[0]!.text, "CONFIRMED: project studio, existing client assets. Owner is not a seller.");
        assert.equal(data.tables[0]!.rows[0]!.values.Status, "DECIDED");
        assert.equal(data.tables[0]!.rows[1]!.values.Status, "SUPERSEDED");
        assert.equal(data.tables[1]!.rows[0]!.values.Target, 6);
        assert.equal(data.tables[1]!.rows[0]!.values.Status, "APPROVED");
        assert.match(JSON.stringify(reply.result), /NOT PUBLISHED/);
        assert.equal(reply.next.permitted_tool_call, undefined);
    }
    assert.deepEqual([...f.w.map], protectedBefore, "readonly launch cannot mutate durable fixture state");
});
test("META launch: default caller and other-lane request receive no private operating context", async () => {
    const f = world(false), r = await f.resume();
    assert.equal(r.status, "OK");
    if (r.status !== "OK")
        throw Error("resume");
    assert.equal(r.result.local_meta_operating_context, undefined);
    assert(!f.calls.some(k => k.includes(frame) || k.includes(pkg)));
    const g = world(), x = await g.resume("SALES_SETUP_INPUTS");
    assert.equal(x.status, "OK");
    if (x.status !== "OK")
        throw Error("resume");
    assert.equal(x.result.local_meta_operating_context, undefined);
    assert(!g.calls.some(k => k.includes(frame) || k.includes(pkg)));
});
test("META launch: held recovery, unknown need and non-owner authority do not read business sources", async () => {
    const held = world();
    held.w.setMetaRuns([runPage({ id: R.run2, label: "TRUN-2", status: "RUNNING" })]);
    held.w.setMetaManifest({ lastRunId: R.run2, recovery: true });
    const h = await held.resume();
    assert.equal(h.status, "HOLD");
    assert(!held.calls.some(k => k.includes(frame) || k.includes(pkg)));
    const unknown = world(), u = await unknown.resume("UNKNOWN_REQUEST");
    assert.equal(u.status, "OK");
    if (u.status !== "OK")
        throw Error("resume");
    assert.equal(u.result.local_meta_operating_context, undefined);
    assert(!unknown.calls.some(k => k.includes(frame) || k.includes(pkg)));
    const member = world();
    member.w.setPrincipals([{ ...OWNER, meta_authority: "VIEWER" }]);
    const m = await member.resume();
    if (m.status === "OK")
        assert.equal(m.result.local_meta_operating_context, undefined);
    assert(!member.calls.some(k => k.includes(frame) || k.includes(pkg)));
});
test("META launch: revoked authority during the new read suppresses its returned content", async () => {
    const f = world(), base = f.deps.notion;
    f.deps.notion = { ...base, retrieveBlockChildren: async (id, c) => { const r = await base.retrieveBlockChildren(id, c); if (id === pkg)
            f.w.setPrincipals([{ ...OWNER, status: "SUSPENDED" }]); return r; } };
    const r = await f.resume();
    if (r.status === "OK")
        assert.equal(r.result.local_meta_operating_context, undefined);
    assert(f.calls.some(k => k.includes(pkg)), "revocation happens inside the business read, not before admission");
});
test("META sources: containment and selected registry mappings fail closed", async () => {
    for (const change of [
        (f: ReturnType<typeof world>) => { (f.registryRows[0]!.properties.Scope as {
            select: {
                name: string;
            };
        }).select.name = "SHARED"; },
        (f: ReturnType<typeof world>) => { f.registryRows.push(structuredClone(f.registryRows[0]!)); },
        (f: ReturnType<typeof world>) => { f.registryRows[0]!.properties["Parent URL"].url = `https://example.invalid/p/${ID.rootB}`; },
        (f: ReturnType<typeof world>) => { f.registryRows[0]!.properties["Resource URL"].url = `https://example.invalid/p/${ID.rootB}`; },
        (f: ReturnType<typeof world>) => { f.registryRows[0]!.properties["Schema Version"] = rich("TEST_SCHEMA/99.0.0"); },
        (f: ReturnType<typeof world>) => { f.values.set(f.key("page", frame), { ...page(frame, ID.rootB) }); },
        (f: ReturnType<typeof world>) => { f.values.set(f.key("page", frame), { ...page(frame, ID.rootA), archived: true }); },
        (f: ReturnType<typeof world>) => { f.values.set(f.key("database", decisionDb), { object: "database", id: decisionDb, archived: false, parent: { type: "page_id", page_id: ID.rootB }, data_sources: [{ id: decisionDs }] }); },
        (f: ReturnType<typeof world>) => { f.values.set(f.key("source", decisionDs), { object: "data_source", id: decisionDs, archived: false, parent: { type: "database_id", database_id: objectiveDb }, properties: {} }); },
    ]) {
        const f = world();
        change(f);
        const c = await f.context();
        assert.equal(c.status, "PARTIAL");
        assert(c.issues.length || c.tables.some(t => t.issues.length));
        assert(!f.calls.some(k => k.includes(ID.rootB)), "a tampered pointer must never trigger an external read");
        if (!c.tables.find(t => t.role === "DECISIONS")?.rows.length)
            assert(!JSON.stringify(c).includes("Q4 approved frame"));
    }
});
test("META sources: root pagination completes before package uniqueness and parent checks", async () => {
    const f = world(), first = f.w.map.get(`children:${ID.rootA}`) as {
        results: unknown[];
    };
    f.values.set(f.key("children", ID.rootA), list(first.results, true, "second"));
    f.values.set(f.key("children", ID.rootA, "second"), list([child(synthetic("second-package"), "VERTIGO_GTM_SECOND/1.0 — BUSINESS PACKAGE — NOT PUBLISHED")]));
    const c = await f.context();
    assert.equal(c.status, "PARTIAL");
    assert(!c.documents.some(d => d.role === "PRIVATE_BUSINESS_PACKAGE"));
    assert(!f.calls.some(k => k === f.key("page", pkg)), "never choose the first package when another exists on the next page");
    const g = world();
    g.values.set(g.key("children", ID.rootA), list([], true, "loop"));
    g.values.set(g.key("children", ID.rootA, "loop"), list([], true, "loop"));
    const cycle = await g.context();
    assert.equal(cycle.status, "UNAVAILABLE");
    assert(cycle.issues.some(i => i.code === "PAGINATION_CYCLE"));
});
test("META sources: nested blocks and pagination are read; references remain explicitly partial and unfollowed", async () => {
    const f = world(), nested = synthetic("nested"), ref = synthetic("mentioned-page"), leaf = synthetic("nested-leaf");
    f.values.set(f.key("children", frame), list([block(nested, frame, "Existing objective", "bulleted_list_item", true)], true, "frame-second"));
    f.values.set(f.key("children", nested), list([{ ...block(leaf, nested, "6 projects"), parent: { type: "block_id", block_id: nested } }]));
    f.values.set(f.key("children", frame, "frame-second"), list([{ ...block(synthetic("mention"), frame, ""), paragraph: { rich_text: [{ type: "mention", plain_text: "Further detail", mention: { type: "page", page: { id: ref } } }] } },
        { ...block(synthetic("external-sync"), frame, "", "synced_block", true), synced_block: { synced_from: { type: "block_id", block_id: ref } } },
        { ...block(synthetic("child-reference"), frame, "", "child_page"), child_page: { title: "Do not traverse" } }]));
    const c = await f.context(), d = c.documents.find(d => d.role === "COMPANY_FRAME")!;
    assert.equal(d.items[1]!.text, "6 projects");
    assert.equal(d.status, "PARTIAL");
    assert(d.issues.some(i => i.code === "MENTION_NOT_FOLLOWED"));
    assert(d.issues.some(i => i.code === "EXTERNAL_SYNC_NOT_FOLLOWED"));
    assert.equal(c.references_followed, false);
    assert(!f.calls.some(k => k.includes(ref)));
});
test("META sources: malformed blocks and rows are not accepted as complete business evidence", async () => {
    const f = world();
    f.values.set(f.key("children", frame), list([{ ...block(synthetic("wrong-object"), frame, "SHOULD NOT APPEAR"), object: "page" }]));
    const c = await f.context();
    assert.equal(c.documents[0]!.status, "UNAVAILABLE");
    assert(!JSON.stringify(c).includes("SHOULD NOT APPEAR"));
    const g = world(), q = g.values.get(g.key("query", decisionDs)) as {
        results: Array<Record<string, unknown>>;
    };
    q.results[0]!.parent = { type: "data_source_id", data_source_id: objectiveDs };
    const r = await g.context();
    assert.equal(r.tables[0]!.status, "PARTIAL");
    assert.equal(r.tables[0]!.rows.length, 1);
    assert.equal(r.tables[0]!.rows[0]!.values.Status, "SUPERSEDED");
});
test("META sources: truncated table window preserves source states and reports partial; source failure is qualified", async () => {
    const f = world(), q = f.values.get(f.key("query", decisionDs)) as {
        results: unknown[];
    };
    f.values.set(f.key("query", decisionDs), list(q.results, true, "next-window"));
    const c = await f.context();
    assert.equal(c.status, "PARTIAL");
    assert.equal(c.tables[0]!.has_more, true);
    assert(c.tables[0]!.issues.some(i => i.code === "ROW_WINDOW_LIMIT"));
    assert(!f.calls.some(k => k === f.key("query", decisionDs, "next-window")));
    const g = world();
    g.values.set(g.key("children", pkg), new Error("SECRET_TOKEN must not be echoed"));
    const r = await g.context();
    assert.equal(r.documents[1]!.status, "UNAVAILABLE");
    assert.equal(r.status, "PARTIAL");
    assert(r.issues.some(i => i.code === "READ_FAILED"));
    assert(!JSON.stringify(r).includes("SECRET_TOKEN"));
});
test("META sources: response bytes, depth and read budgets terminate with partial data", async () => {
    const f = world();
    f.values.set(f.key("children", frame), list([block(synthetic("small"), frame, "Useful partial answer"), block(synthetic("large"), frame, "x".repeat(100000))]));
    const bytes = await f.context();
    assert.equal(bytes.status, "PARTIAL");
    assert(Buffer.byteLength(JSON.stringify(bytes)) <= bytes.limits.response_bytes);
    assert(bytes.documents[0]!.issues.some(i => i.code === "BYTE_LIMIT"));
    const deep = world();
    let p = frame;
    for (let i = 0; i < 6; i++) {
        const id = synthetic(`depth-${i}`);
        deep.values.set(deep.key("children", p), list([block(id, p, `Level ${i}`, "toggle", true)]));
        p = id;
    }
    const depth = await deep.context();
    assert.equal(depth.status, "PARTIAL");
    assert(depth.documents[0]!.issues.some(i => i.code === "DEPTH_OR_CYCLE" || i.code === "DOCUMENT_READ_LIMIT"));
    assert(!deep.calls.some(k=>k===deep.key("children",synthetic("depth-5"))),"the stricter read quota may stop first; no deeper traversal is permitted");
    const reads = world();
    reads.values.set(reads.key("children", frame), list([], true, "c0"));
    for (let i = 0; i < 25; i++)
        reads.values.set(reads.key("children", frame, `c${i}`), list([block(synthetic(`budget-${i}`), frame, `Page ${i}`)], true, `c${i + 1}`));
    const bounded = await reads.context();
    assert.equal(bounded.status, "PARTIAL");
    assert(bounded.reads <= 20);
    assert(bounded.documents[0]!.issues.some(i => i.code === "DOCUMENT_READ_LIMIT"));
});
test("META launch: changed business values are read afresh on the next ordinary resume", async () => {
    const f = world(), a = await f.resume();
    assert.equal(a.status, "OK");
    f.values.set(f.key("children", frame), list([block(synthetic("fresh-text"), frame, "Updated business answer")]));
    const b = await f.resume();
    assert.equal(b.status, "OK");
    if (b.status !== "OK")
        throw Error("resume");
    assert.match(JSON.stringify(b.result.local_meta_operating_context), /Updated business answer/);
    assert(!JSON.stringify(b.result.local_meta_operating_context).includes("Owner is not a seller"));
});
test("META sources: large documents cannot starve decisions, objectives or one another within the total budget", async () => {
    const f = world();
    for (const [label, id] of [["frame", frame], ["package", pkg]] as const)
        f.values.set(f.key("children", id), list(Array.from({ length: 100 }, (_, i) => block(synthetic(`${label}-size-${i}`), id, `${label}: ${"x".repeat(280)}`))));
    const c = await f.context();
    assert.equal(c.status, "PARTIAL");
    assert.equal(c.documents.length, 2);
    assert(c.documents.every(d => d.items.length > 0 && d.status === "PARTIAL"));
    assert.equal(c.tables.length, 2);
    assert(c.tables.every(t => t.rows.length > 0));
    assert(Buffer.byteLength(JSON.stringify(c)) <= c.limits.response_bytes);
    assert(c.reads <= 20);
});

test("META launch HTTP MCP: all four business sources survive actual five-tool serialization without hidden fields or write events",async t=>{
    t.mock.timers.enable({apis:["Date"],now:T0});
    const f=world(),expected=await f.context(),before=structuredClone([...f.w.map]);
    const token="synthetic-meta-context-http-token";
    const server=await startHttpServer(f.deps,new FileHttpTokenRegistry([{token_sha256:sha256(token),principal_id:OWNER.principal_id}]),0);
    const client=new Client({name:"meta-context-oracle",version:"0"});
    try{
        const transport=new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`),{requestInit:{headers:{authorization:`Bearer ${token}`}}});
        await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
        const bound=await client.callTool({name:"os_bind",arguments:{lane:"META"}});
        const binding=JSON.parse((bound.content as Array<{text:string}>)[0]!.text) as Envelope;
        const eventsAfterBind=await f.deps.store.events.list();
        const response=await client.callTool({name:"os_resume",arguments:{binding_handle:handleOf(binding),topic_hint:"CURRENT_WORK"}});
        assert.equal(response.isError,false);assert.equal(response.structuredContent,undefined);assert.equal(response._meta,undefined);
        const content=response.content as Array<{type:string;text:string}>;assert.equal(content.length,1);assert.equal(content[0]!.type,"text");
        const delivered=JSON.parse(content[0]!.text) as Envelope;assert.equal(delivered.status,"OK");if(delivered.status!=="OK")throw Error("resume");
        assert.deepEqual(delivered.result.local_meta_operating_context,expected,"business facts must be in the actual model-visible text envelope");
        assert.deepEqual([...f.w.map],before);assert.deepEqual(await f.deps.store.events.list(),eventsAfterBind);
        assert.match(delivered.next.conduct!,/CURRENT human/);assert.equal(delivered.next.permitted_tool_call,undefined);
    }finally{await client.close();await server.close()}
});

test("META B1: many nested branches cannot spend the reads reserved for either table or the other document",async()=>{
    const f=world(),branches=Array.from({length:9},(_,i)=>synthetic(`wide-branch-${i}`));
    f.values.set(f.key("children",frame),list(branches.map(id=>block(id,frame,"Known frame answer","toggle",true))));
    for(const id of branches)f.values.set(f.key("children",id),list([{...block(synthetic(`leaf-${id}`),id,"Nested detail"),parent:{type:"block_id",block_id:id}}]));
    const c=await f.context();assert.equal(c.status,"PARTIAL");assert(c.reads<=20);
    assert.equal(c.tables.length,2);assert(c.tables.every(t=>t.rows.length>0),"each valid table must retain its reserved reads");
    assert(c.documents[0]!.issues.some(i=>i.code==="DOCUMENT_READ_LIMIT"));assert(c.documents[1]!.items.length>0,"nested first document cannot starve the second");
});

test("META B1: a selected but unreadable table remains explicitly unavailable, without invented source ID or empty-window claim",async()=>{
    const f=world();f.values.set(f.key("database",decisionDb),new Error("Unreadable"));
    const c=await f.context();assert.equal(c.tables.length,2);const t=c.tables.find(t=>t.role==="DECISIONS")!;
    assert.equal(t.status,"UNAVAILABLE");assert.equal(t.registry_key,"META_DECISIONS");assert.equal(t.has_more,"UNKNOWN");assert.equal(t.data_source_ref,undefined);assert(t.issues.length>0);assert.equal(t.rows.length,0);
    assert(c.tables.find(t=>t.role==="OBJECTIVES")!.rows.length>0);
});

// Projection-review characterization: disproves a claimed global-failure path using real dispatch.
test("META projection: additive Notion API failure stays qualified source data, not a failed resume",async()=>{
    const f=world(),before=structuredClone([...f.w.map]);
    f.values.set(f.key("children",pkg),new Error("provider unavailable; SECRET_NOT_TO_REFLECT"));
    const r=await f.resume();assert.equal(r.status,"OK");assert.equal(r.code,"RESUMED");if(r.status!=="OK")throw Error("resume");
    const c=r.result.local_meta_operating_context as {status:string;documents:Array<{role:string;status:string}>;issues:Array<{code:string}>};
    assert.equal(c.status,"PARTIAL");assert.equal(c.documents.find(d=>d.role==="PRIVATE_BUSINESS_PACKAGE")!.status,"UNAVAILABLE");assert(c.issues.some(i=>i.code==="READ_FAILED"));
    assert(!JSON.stringify(r).includes("SECRET_NOT_TO_REFLECT"));assert.deepEqual([...f.w.map],before);
});

test("META projection HTTP MCP: failed fresh post-read authority must stop without leaking the new context",async t=>{
    t.mock.timers.enable({apis:["Date"],now:T0});const f=world(),base=f.deps.notion,registry=f.deps.principals;let deny=false;
    f.deps.notion={...base,retrieveBlockChildren:async(id,c)=>{const r=await base.retrieveBlockChildren(id,c);if(id===pkg)deny=true;return r}};
    f.deps.principals={get:async id=>{if(deny)throw Error("fresh authority unavailable");return registry.get(id)}};
    const token="synthetic-auth-failure-token",server=await startHttpServer(f.deps,new FileHttpTokenRegistry([{token_sha256:sha256(token),principal_id:OWNER.principal_id}]),0),client=new Client({name:"auth-stop-oracle",version:"0"});
    try{const tr=new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`),{requestInit:{headers:{authorization:`Bearer ${token}`}}});await client.connect(tr as unknown as Parameters<typeof client.connect>[0]);
        const b=await client.callTool({name:"os_bind",arguments:{lane:"META"}}),binding=JSON.parse((b.content as Array<{text:string}>)[0]!.text) as Envelope;
        assert(deny,"failure is the mandatory post-read authority check, now reached on the first bind");assert.equal(b.isError,true);assert.equal(binding.status,"ERROR");assert.equal(binding.next.permitted_tool_call,undefined);assert(!JSON.stringify(binding).includes("local_meta_operating_context"));assert(!JSON.stringify(binding).includes("CONFIRMED: project studio"));
    }finally{await client.close();await server.close()}
});
