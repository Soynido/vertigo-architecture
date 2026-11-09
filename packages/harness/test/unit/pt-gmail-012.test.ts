/** W4.3 local synthetic acceptance: actual public dispatcher, registered adapter and strict transactional writer. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/index.ts";
import { hashHandle } from "../../src/binding/handle.ts";
import { normalizeId, propText, type Page } from "../../src/notion/shapes.ts";
import { InMemorySalesRuntimeRegistry } from "../../src/registry/salesRuntimes.ts";
import { registerBuiltinSalesAdapters } from "../../src/versions/adapters/sales.ts";
import { EXTERNAL_INTERACTION_PROPERTIES, EXTERNAL_RECEIPT_PROPERTIES, EXTERNAL_RECEIPT_OPTIONS, SALES_CONTROL_PLANE_0513_CANDIDATE } from "../../src/versions/adapters/controlPlane.ts";
import { deriveExternalEvent, externalEventJournalConsistent, externalEventPlanStillOwned, EXTERNAL_SPEC, EXTERNAL_SCHEMA, INTERACTIONS, RECEIPTS, isExternalEventMutation } from "../../src/effects/eventWrite.ts";
import { StructureCache } from "../../src/notion/structureCache.ts";
import type { NotionReadClient } from "../../src/notion/readClient.ts";
import { bindLive, dispatch } from "../../src/tools/handlers.ts";
import { classify } from "../../src/guards/classify.ts";
import { openGuard } from "../../src/guards/preflight.ts";
import type { GuardSnapshot } from "../../src/guards/snapshot.ts";
import { capabilityProofKey, evaluateCapabilityCompleteness } from "../../src/resume/capabilities.ts";
import { readCapabilitySnapshot } from "../../src/resume/readers.ts";
import { prepare, type Intent } from "../../src/plans/prepare.ts";
import { externalIdentityKey } from "../../src/effects/gmail.ts";
import { toolInputSchemas, type ExternalEventEvidence } from "../../src/tools/surface.ts";
import { OWNER } from "./binding-fixtures.ts";
import { synthetic, text } from "./meta-fixtures.ts";
import { IDS, CONTRACT_PAGE, registryEntries } from "./sales-fixtures.ts";
import { R, setRowsIn } from "./resume-fixtures.ts";
import { G, guardWorld, index, putRows, rowsOf, NOW, setIndex, type ClassEntry, rule, p0, eq, lit, b0Intent, CLASSES } from "../support/guard-fixtures.ts";

const DATA = synthetic("event-data"), I = synthetic("event-interactions"), Q = synthetic("event-receipts"), A = synthetic("event-accounts"), C = synthetic("event-contacts"), P = synthetic("event-capabilities");
const ACCOUNT = synthetic("event-account"), CONTACT = synthetic("event-contact");
const rt = (v: string) => ({ type: "rich_text", rich_text: [text(v)] });
const list = (results: unknown[]) => ({ results, has_more: false, next_cursor: null });
const key = externalIdentityKey({ provider: "GMAIL", source_identity: "rep-a@example.invalid", event_id: "event-one" })!;
const evidence = (): ExternalEventEvidence => ({ provider: "GMAIL", source_identity: "rep-a@example.invalid", evidence_ref: "gmail:message/event-one",
  observed_at: NOW.toISOString(), message: { message_id: "event-one", thread_id: "thread-one", from: "rep-a@example.invalid", to: ["prospect@example.invalid"], date: "2030-01-02T12:00:00.000Z", subject: "PRIVATE-NATIVE-SUBJECT" }, contact_refs: [CONTACT] });

function world(customClasses?: ClassEntry[], triggered = false) {
  const classes = [[INTERACTIONS, EXTERNAL_INTERACTION_PROPERTIES], [RECEIPTS, EXTERNAL_RECEIPT_PROPERTIES]] as const;
  const g = guardWorld({ doc: index(triggered ? [p0(1, eq(lit(true), lit(true)))] : [], customClasses ?? classes.map(([resource_key, fields]) => ({ class: "RECONCILE_AS_IS", resource_key, operation: "CREATE", allowed_fields: Object.keys(fields) }))), ...(triggered ? { rules: [rule("event-p0", 1)] } : {}) });
  Object.assign(g.deps, { salesRegistry: new InMemorySalesRuntimeRegistry(registryEntries()) });
  registerBuiltinSalesAdapters(g.deps.adapters.salesRuntime);
  const ids = IDS("rep-a");
  const manifest = g.map.get(`page:${ids.manifestRow}`) as Page;
  setRowsIn(g.map, ids.manifestDs, [{ ...manifest, properties: { ...manifest.properties, "Sales Contract Version": rt(EXTERNAL_SPEC), "Schema Version": rt(EXTERNAL_SCHEMA) } } as Page]);
  g.map.set(`page:${CONTRACT_PAGE}`, { object: "page", id: CONTRACT_PAGE, archived: false, properties: { title: { type: "title", title: [text(EXTERNAL_SPEC)] } } });
  const root = (g.map.get(`children:${G.root}`) as { results: Array<{ child_page?: { title: string } }> }).results;
  g.map.set(`children:${G.root}`, list([...root.map((b) => b.child_page?.title === "00 — BOOT" ? { ...b, child_page: { title: "00 — BOOT & INSTANCE" } } : b),
    { object: "block", id: DATA, type: "child_page", child_page: { title: "04 — DATA & EVIDENCE" } }]));
  const db = (ds: string, title: string) => ({ object: "block", id: synthetic(`db:${ds}`), type: "child_database", child_database: { title } });
  g.map.set(`children:${DATA}`, list([db(I, "Interactions"), db(A, "Accounts"), db(C, "Contacts")]));
  const cp = (g.map.get(`children:${G.cp}`) as { results: unknown[] }).results;
  g.map.set(`children:${G.cp}`, list([...cp, db(Q, "Receipts"), db(P, "Capability Profile")]));
  const schema = (ds: string, props: Record<string, string>, options: Record<string, readonly string[]> = {}, relations: Record<string, string> = {}) => {
    g.map.set(`database:${synthetic(`db:${ds}`)}`, { object: "database", id: synthetic(`db:${ds}`), data_sources: [{ id: ds }] });
    g.map.set(`data_source:${ds}`, { properties: Object.fromEntries(Object.entries(props).map(([k, type]) => [k, { type,
      ...(type === "select" ? { select: { options: (options[k] ?? []).map((name) => ({ name })) } } : {}),
      ...(type === "relation" ? { relation: { data_source_id: relations[k] } } : {}) }])) });
    putRows(g.map, ds, []);
  };
  schema(I, EXTERNAL_INTERACTION_PROPERTIES, { Provider: ["GMAIL"] }, { Accounts: A, Contacts: C });
  schema(Q, EXTERNAL_RECEIPT_PROPERTIES, EXTERNAL_RECEIPT_OPTIONS);
  schema(A, { Company: "title", Website: "url" });
  schema(C, { Contact: "title", Email: "email", Account: "relation" }, {}, { Account: A });
  putRows(g.map, A, [{ object: "page", id: ACCOUNT, properties: { Company: { type: "title", title: [text("Synthetic prospect")] }, Website: { type: "url", url: "https://prospect.example.invalid/" } } } as Page]);
  putRows(g.map, C, [{ object: "page", id: CONTACT, properties: { Contact: { type: "title", title: [text("Synthetic contact")] }, Email: { type: "email", email: "prospect@example.invalid" }, Account: { type: "relation", relation: [{ id: ACCOUNT }] } } } as Page]);
  const profile = SALES_CONTROL_PLANE_0513_CANDIDATE.installContract!.physicalResources.find((r) => r.key === "CAPABILITY_PROFILE")!;
  schema(P, { ...profile.requiredProperties }, { ...profile.requiredSelectOptions });
  putRows(g.map, P, ["GMAIL_READ", "CALENDAR_READ"].map((capability) => {
    const props: Record<string, unknown> = {};
    const source = capability === "GMAIL_READ" ? "GMAIL" : "GOOGLE_CALENDAR";
    for (const [name, value] of Object.entries({ "Capability Proof Key": capabilityProofKey({ runtimeId: "SALESOS-FIXTURE-A", principalKey: "rep-a", capability, operatingMode: "SALES_OPERATIONS", verifiedAt: NOW.toISOString(), evidenceRef: `fixture:${capability}` }),
      "Capability Key": capability, "Runtime ID": "SALESOS-FIXTURE-A", "Principal Key": "rep-a", "Operating Mode": "SALES_OPERATIONS", "Evidence Ref": `fixture:${capability}`, Scope: "principal:rep-a;runtime:SALESOS-FIXTURE-A" })) props[name] = rt(value);
    return { object: "page", id: synthetic(`proof:${capability}`), properties: { ...props, "Capability Proof": { type: "title", title: [text(capability)] }, State: { type: "select", select: { name: "READ_VERIFIED" } }, "Competent Source": { type: "select", select: { name: source } }, "Verified At": { type: "date", date: { start: NOW.toISOString() } } } } as Page;
  }));
  // The real Notion endpoint explicitly proves pagination end; the older shared cursor fixture omitted it.
  putRows(g.map, R.salesStateDs, rowsOf(g.map, R.salesStateDs));
  return g;
}

async function ready() { const g = world(); const h = await g.bind(); await g.approve(); return { g, h }; }
function code(out: Awaited<ReturnType<ReturnType<typeof world>["commit"]>>) { return out.kind === "HELD" ? out.code : out.kind; }

test("W6.1/native-resume: candidate resume finishes interrupted native bookkeeping, never repeats an effect", async () => {
  const { g, h } = await ready();
  g.client.fault({ symbol: "TARGET_0" }, "APPLY_THEN_FAIL");
  const partial = await g.commit(h, { external_event_evidence: evidence() });
  assert.equal(partial.kind, "INTERRUPTED");
  g.clock.t += 16 * 60_000;
  const fresh = await g.bind();
  const out = await dispatch("os_resume", { binding_handle: fresh }, { principal_id: OWNER.principal_id, now: new Date(g.clock.t), candidate_resume: true }, g.deps);
  assert.equal(out.status, "OK", JSON.stringify({ code: out.code, observations: out.observations }));
  assert.equal(out.result["durable_hold"], undefined);
  assert.equal(rowsOf(g.map, I).length, 1);
  assert.equal(rowsOf(g.map, Q).length, 1);
  const count = g.client.writes.length;
  await dispatch("os_resume", { binding_handle: fresh }, { principal_id: OWNER.principal_id, now: new Date(g.clock.t), candidate_resume: true }, g.deps);
  assert.equal(g.client.writes.length, count);
});

test("W6.1/native-resume: missing current guard prevents continuation but does not poison later approval", async () => {
  const { g, h } = await ready();
  g.client.fault({ symbol: "TARGET_0" }, "APPLY_THEN_FAIL");
  const partial = await g.commit(h, { external_event_evidence: evidence() });
  assert.equal(partial.kind, "INTERRUPTED");
  const count = g.client.writes.length;
  const readApproval = g.deps.store.guardApprovals!.get.bind(g.deps.store.guardApprovals!);
  g.deps.store.guardApprovals!.get = async () => undefined;
  const blocked = await dispatch("os_resume", { binding_handle: h }, { principal_id: OWNER.principal_id, now: new Date(g.clock.t), candidate_resume: true }, g.deps);
  assert.notEqual(blocked.status, "ERROR");
  assert.ok((blocked.status === "OK" ? blocked.result : blocked.observations)["durable_hold"]);
  assert.equal(g.client.writes.length, count);
  const stamped = await g.deps.store.events.list({ event_type: "AUTO_WORK_HELD" });
  assert.equal(stamped.length, 0, JSON.stringify(stamped.map(e => [e.result, e.detail])));
  g.deps.store.guardApprovals!.get = readApproval;
  const continued = await dispatch("os_resume", { binding_handle: h }, { principal_id: OWNER.principal_id, now: new Date(g.clock.t), candidate_resume: true }, g.deps);
  assert.equal(continued.status, "OK");
  assert.equal(continued.result["durable_hold"], undefined);
  assert.equal(rowsOf(g.map, I).length, 1);
  assert.equal(rowsOf(g.map, Q).length, 1);
});

test("W6.1/native-recovery: another writer's live claim cannot be stripped by a new chat", async () => {
  const { g, h } = await ready();
  g.client.fault({ symbol: "TARGET_0" }, "APPLY_THEN_FAIL");
  const partial = await g.commit(h, { external_event_evidence: evidence() });
  assert.equal(partial.kind, "INTERRUPTED");
  const plan = (await g.deps.store.plans.get(partial.plan_id!))!;
  const scope = { project: plan.project, lane: plan.lane, runtime_generation: plan.runtime_generation };
  const now = new Date(g.clock.t);
  const lease = await g.deps.store.leases.current(scope, now);
  assert.ok(await g.deps.store.claims.claim(plan.plan_id, "other-live-writer", now, new Date(g.clock.t + 60_000)));
  const fresh = await g.bind();
  const count = g.client.writes.length;
  const busy = await g.commit(fresh, {});
  assert.equal(busy.kind, "IN_PROGRESS");
  assert.equal(busy.kind === "IN_PROGRESS" ? busy.reason : undefined, "CLAIMED_ELSEWHERE");
  assert.deepEqual(await g.deps.store.leases.current(scope, now), lease);
  assert.equal((await g.deps.store.plans.get(plan.plan_id))!.plan_state, plan.plan_state);
  assert.equal(g.client.writes.length, count);
  await g.deps.store.claims.release(plan.plan_id, "other-live-writer");
  const completed = await g.commit(fresh, {});
  assert.equal(completed.kind, "PERSISTED");
  assert.equal(rowsOf(g.map, I).length, 1);
  assert.equal(rowsOf(g.map, Q).length, 1);
});

test("W6.1/native-recovery: completion between observation and claim never reopens the finalized plan", async () => {
  for (const route of ["commit", "resume"] as const) {
    const { g, h } = await ready();
    g.client.fault({ symbol: "TARGET_0" }, "APPLY_THEN_FAIL");
    const partial = await g.commit(h, { external_event_evidence: evidence() });
    assert.equal(partial.kind, "INTERRUPTED");
    const fresh = await g.bind();
    const claim = g.deps.store.claims.claim.bind(g.deps.store.claims);
    let completedWrites = 0, crossed = false;
    g.deps.store.claims.claim = async (...args) => {
      if (!crossed && args[0] === partial.plan_id) {
        crossed = true;
        const completed = await g.commit(h, {});
        assert.equal(completed.kind, "PERSISTED");
        completedWrites = g.client.writes.length;
      }
      return claim(...args);
    };
    if (route === "commit") {
      const out = await g.commit(fresh, {});
      assert.equal(out.kind, "IN_PROGRESS");
      assert.equal(out.kind === "IN_PROGRESS" ? out.reason : undefined, "INDEX_LAG");
    } else {
      await dispatch("os_resume", { binding_handle: fresh }, { principal_id: OWNER.principal_id, now: new Date(g.clock.t), candidate_resume: true }, g.deps);
    }
    assert.ok(crossed);
    assert.equal(g.client.writes.length, completedWrites, `${route}: no work after the original FINAL`);
    assert.equal((await g.deps.store.plans.get(partial.plan_id!))!.plan_state, "FINAL_VERIFIED");
    assert.equal(rowsOf(g.map, I).length, 1);
    assert.equal(rowsOf(g.map, Q).length, 1);
  }
});

function threeContacts(g: ReturnType<typeof world>) {
  const e = evidence(), first = rowsOf(g.map, C)[0]!;
  const extra = [1, 2].map((n) => ({ ...first, id: synthetic(`event-contact-${n}`), properties: {
    ...first.properties, Email: { type: "email", email: `prospect-${n}@example.invalid` },
  } } as Page));
  putRows(g.map, C, [first, ...extra]);
  e.message.to.push(...extra.map((p) => propText(p, "Email")!));
  e.contact_refs.push(...extra.map((p) => p.id));
  return e;
}

function countedReads(inner: NotionReadClient) {
  const counts = new Map<string, number>();
  const count = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
  const client: NotionReadClient = {
    retrieveDatabase(id) { count(`database:${id}`); return inner.retrieveDatabase(id); },
    retrieveDataSource(id) { count(`data_source:${id}`); return inner.retrieveDataSource(id); },
    retrieveBlockChildren(id, cursor) { count(`children:${id}:${cursor ?? ""}`); return inner.retrieveBlockChildren(id, cursor); },
    retrievePage(id) { count(`page:${id}`); return inner.retrievePage(id); },
    queryDataSource(id, filter, cursor, options) { count(`query:${id}`); return inner.queryDataSource(id, filter, cursor, options); },
  };
  return { client, counts };
}

test("R5 event: private derive cache reduces structure reads only; three Contacts keep every page/query fresh", async () => {
  const { g, h } = await ready(), e = threeContacts(g);
  const b = await bindLive(h, { principal_id: OWNER.principal_id, now: NOW }, g.deps);
  assert.ok(b.ok); if (!b.ok) return;
  const raw = countedReads(g.deps.notion), cached = countedReads(g.deps.notion);
  assert.equal((await deriveExternalEvent({ ...g.deps, notion: raw.client }, b.binding, b.runtime, e)).kind, "READY");
  assert.equal((await deriveExternalEvent({ ...g.deps, notion: new StructureCache(cached.client) }, b.binding, b.runtime, e)).kind, "READY");
  const facts = (counts: Map<string, number>) => [...counts].filter(([k]) => /^(page|query):/.test(k)).sort();
  assert.deepEqual(facts(cached.counts), facts(raw.counts));
  const structures = [...cached.counts].filter(([k]) => /^(children|database|data_source):/.test(k));
  assert.ok(structures.length > 0);
  assert.ok(structures.every(([, n]) => n === 1));
  assert.ok(raw.counts.get(`children:${G.root}:`)! > cached.counts.get(`children:${G.root}:`)!);
  assert.equal(cached.counts.get(`query:${C}`), 3);
  assert.equal(cached.counts.get(`page:${ACCOUNT}`), 1, "same-derive ownership is validated once; independent checks remain fresh");
  assert.equal(cached.counts.get(`page:${CONTACT}`), 1);
  assert.equal(g.client.writes.length, 0);
});

test("R5 event: schema, relation, option, duplicate and Contact drift after derive block the first byte", async () => {
  for (const drift of ["schema", "relation", "option", "duplicate", "contact", "account"] as const) {
    const { g, h } = await ready(), e = threeContacts(g);
    const inner = g.deps.notion; let injected = false;
    Object.assign(g.deps, { notion: { ...inner, retrievePage: async (id: string) => {
      if (!injected && id === G.indexPage) {
        injected = true; // openGuard AFTER derivation, before prepare or the first byte.
        const schema = g.map.get(`data_source:${I}`) as { properties: Record<string, unknown> };
        if (drift === "schema") { const { Provider: _removed, ...properties } = schema.properties; g.map.set(`data_source:${I}`, { ...schema, properties }); }
        if (drift === "relation") g.map.set(`data_source:${I}`, { ...schema, properties: { ...schema.properties, Contacts: { type: "relation", relation: { data_source_id: synthetic("foreign-contacts") } } } });
        if (drift === "option") g.map.set(`data_source:${I}`, { ...schema, properties: { ...schema.properties, Provider: { type: "select", select: { options: [] } } } });
        if (drift === "duplicate") putRows(g.map, I, [{ object: "page", id: synthetic("event-duplicate-after-derive"), properties: { "Event Key": rt(key) } } as Page]);
        if (drift === "contact") g.map.set(`page:${CONTACT}`, { ...g.map.get(`page:${CONTACT}`) as Page, archived: true });
        if (drift === "account") g.map.set(`page:${ACCOUNT}`, { ...g.map.get(`page:${ACCOUNT}`) as Page, archived: true });
      }
      return inner.retrievePage(id);
    } } });
    const result = await g.commit(h, { external_event_evidence: e });
    assert.ok(injected, `${drift} must be injected at the raw guard boundary`);
    assert.notEqual(result.kind, "PERSISTED", `${drift}: ${JSON.stringify(result)}`);
    assert.equal(g.client.writes.length, 0, `${drift} must stop all bytes, not just the business targets`);
  }
});

test("R5 event: independent pair checks reread structures/facts and see drift after a three-Contact replay", async () => {
  const { g, h } = await ready(), e = threeContacts(g);
  const persisted = await g.commit(h, { external_event_evidence: e });
  assert.equal(persisted.kind, "PERSISTED"); if (persisted.kind !== "PERSISTED") return;
  const writes = g.client.writes.length;
  const replay = await g.commit(h, { external_event_evidence: e });
  assert.equal(replay.kind, "PERSISTED"); if (replay.kind !== "PERSISTED") return;
  assert.equal(replay.repeated, true); assert.equal(g.client.writes.length, writes);
  const b = await bindLive(h, { principal_id: OWNER.principal_id, now: NOW }, g.deps);
  assert.ok(b.ok); if (!b.ok) return;
  const plan = await g.deps.store.plans.get(persisted.plan_id); assert.ok(plan);
  const c = countedReads(g.deps.notion), deps = { ...g.deps, notion: c.client };
  assert.equal(await externalEventJournalConsistent(deps, b.runtime, plan), true);
  assert.equal(await externalEventJournalConsistent(deps, b.runtime, plan), true);
  assert.equal(c.counts.get(`children:${G.root}:`), 2, "a new check never inherits the prior structure view");
  assert.equal(c.counts.get(`data_source:${I}`), 2);
  assert.equal(c.counts.get(`page:${ACCOUNT}`), 2);
  assert.equal(c.counts.get(`query:${I}`), 2);
  const schema = g.map.get(`data_source:${I}`) as { properties: Record<string, unknown> };
  g.map.set(`data_source:${I}`, { ...schema, properties: { ...schema.properties, Provider: { type: "select", select: { options: [] } } } });
  assert.equal(await externalEventJournalConsistent(deps, b.runtime, plan), false);
  assert.equal(c.counts.get(`data_source:${I}`), 3);
  assert.equal(g.client.writes.length, writes);
});

test("R5 delta2: positive capability reader exhausts pagination, rereads modes and refuses uncertain lists", async () => {
  const { g, h } = await ready();
  const b = await bindLive(h, { principal_id: OWNER.principal_id, now: NOW }, g.deps);
  assert.ok(b.ok); if (!b.ok) return;
  const original = g.deps.notion, proofs = rowsOf(g.map, P), cursors: Array<string | undefined> = [];
  const paged: NotionReadClient = { ...original, queryDataSource: async (id, filter, cursor, options) => {
    if (id !== P) return original.queryDataSource(id, filter, cursor, options);
    cursors.push(cursor); assert.equal(filter, undefined, "malformed/timeless proofs must not be filtered out");
    return cursor ? list([proofs[1]!]) : { results: [proofs[0]!], has_more: true, next_cursor: "second" };
  } };
  const snap = await readCapabilitySnapshot(paged, b.runtime);
  assert.ok(snap); assert.equal(evaluateCapabilityCompleteness(b.runtime, snap)?.complete, true);
  assert.deepEqual(cursors, [undefined, "second"]);
  for (const answer of [ { results: proofs, has_more: true, next_cursor: null },
    { results: proofs, has_more: true, next_cursor: "loop" }, { results: proofs },
    { results: proofs, has_more: true, next_cursor: "endless" } ]) {
    assert.equal(await readCapabilitySnapshot({ ...original, queryDataSource: async (id, f, c, o) =>
      id === P ? answer : original.queryDataSource(id, f, c, o) }, b.runtime), undefined);
  }
  const state = rowsOf(g.map, R.salesStateDs)[0]!;
  putRows(g.map, R.salesStateDs, [{ ...state, properties: { ...state.properties, "Operating Mode": rt("") } }]);
  const withModeField = { ...b.runtime, adapter: { ...b.runtime.adapter, controlPlane: { ...b.runtime.adapter.controlPlane,
    stateCursor: { ...b.runtime.adapter.controlPlane.stateCursor!, operatingModes: "Operating Mode" } } } };
  assert.equal(await readCapabilitySnapshot(original, withModeField), undefined, "unknown declared durable modes cannot certify a fast positive");
  putRows(g.map, R.salesStateDs, [state]);
  putRows(g.map, R.salesStateDs, [state, { ...state, id: synthetic("duplicate-current-capability-reader") }]);
  assert.equal(await readCapabilitySnapshot(original, b.runtime), undefined, "duplicate CURRENT cannot certify a fast positive");
  putRows(g.map, R.salesStateDs, [state]);
  putRows(g.map, P, [proofs[0]!]);
  const changed = await readCapabilitySnapshot(original, b.runtime);
  assert.ok(changed); assert.equal(evaluateCapabilityCompleteness(b.runtime, changed)?.complete, false);
  assert.equal(g.client.writes.length, 0);
});

test("R5 delta2: exact draft replay saves unrelated hydration only on positive capabilities; fallback preserves priority", async () => {
  for (const fault of ["none", "capability", "capability-and-recovery", "unreadable-once"] as const) {
    const { g, h } = await ready(), e = threeContacts(g);
    const draft = await g.commit(h, { external_event_evidence: e }, { commitBudgetMs: 1 });
    assert.equal(draft.kind, "IN_PROGRESS"); assert.equal(g.client.writes.length, 0);
    const b = await bindLive(h, { principal_id: OWNER.principal_id, now: NOW }, g.deps); assert.ok(b.ok); if (!b.ok) return;
    const d = await deriveExternalEvent(g.deps, b.binding, b.runtime, e); assert.equal(d.kind, "READY"); if (d.kind !== "READY") return;
    if (fault.startsWith("capability")) putRows(g.map, P, []);
    if (fault === "capability-and-recovery") {
      const p = g.map.get(`page:${b.runtime.manifest_ref}`) as Page;
      g.map.set(`page:${p.id}`, { ...p, properties: { ...p.properties, "Recovery Required": { type: "checkbox", checkbox: true } } });
    }
    let failed = false;
    const raw = g.deps.notion, reads = countedReads({ ...raw, queryDataSource: async (id, f, c, o) => {
      if (fault === "unreadable-once" && id === P && !failed) { failed = true; throw new Error("fixture unavailable"); }
      return raw.queryDataSource(id, f, c, o);
    } });
    const out = await prepare({ ...g.deps, notion: reads.client }, b.binding, b.runtime, d.intent, NOW);
    if (fault === "capability") { assert.equal(out.kind, "HOLD"); if (out.kind === "HOLD") assert.equal(out.code, "HOLD_REQUIRED_CAPABILITY_INCOMPLETE"); }
    else { assert.equal(out.kind, "PREPARED", fault + JSON.stringify(out)); if (out.kind === "PREPARED") assert.equal(out.plan.plan_id, draft.plan_id); }
    if (fault === "none") assert.equal(reads.counts.get(`query:${R.salesRunsDs}`), undefined);
    else assert.ok(reads.counts.get(`query:${R.salesRunsDs}`), "incomplete/error must use original full hydrate, including its recovery-before-capability priority");
    assert.equal(g.client.writes.length, 0);
  }
});

test("W7.1: ordinary SETUP skips only redundant full hydration on a fresh positive capability proof", async () => {
  const { g, h } = await ready();
  const b = await bindLive(h, { principal_id: OWNER.principal_id, now: NOW }, g.deps);
  assert.ok(b.ok); if (!b.ok) return;
  const reads = countedReads(g.deps.notion);
  const out = await prepare({ ...g.deps, notion: new StructureCache(reads.client) }, b.binding, b.runtime, b0Intent().intent as Intent, NOW);
  assert.equal(out.kind, "PREPARED", JSON.stringify(out));
  assert.equal(reads.counts.get(`query:${R.salesRunsDs}`), 2, "one full hydration: completed and open Runs queries, not two hydrations");
  assert.equal(reads.counts.get(`query:${P}`), 2, "capabilities remain freshly queried in preflight and full hydration");
  assert.equal(g.client.writes.length, 0);
});

test("W7.1: ordinary SETUP capability uncertainty preserves full-hydration hold priority", async () => {
  for (const fault of ["missing", "revoked", "missing-and-recovery", "unreadable-once"] as const) {
    const { g, h } = await ready();
    const b = await bindLive(h, { principal_id: OWNER.principal_id, now: NOW }, g.deps);
    assert.ok(b.ok); if (!b.ok) return;
    if (fault.startsWith("missing")) putRows(g.map, P, []);
    if (fault === "revoked") putRows(g.map, P, rowsOf(g.map, P).map(p => ({ ...p, properties: { ...p.properties, State: { type: "select", select: { name: "REVOKED" } } } })));
    if (fault === "missing-and-recovery") {
      const p = g.map.get(`page:${b.runtime.manifest_ref}`) as Page;
      g.map.set(`page:${p.id}`, { ...p, properties: { ...p.properties, "Recovery Required": { type: "checkbox", checkbox: true } } });
    }
    const raw = g.deps.notion; let failed = false;
    const reads = countedReads({ ...raw, queryDataSource: async (id, f, c, o) => {
      if (fault === "unreadable-once" && id === P && !failed) { failed = true; throw new Error("fixture unreadable"); }
      return raw.queryDataSource(id, f, c, o);
    } });
    const out = await prepare({ ...g.deps, notion: new StructureCache(reads.client) }, b.binding, b.runtime, b0Intent().intent as Intent, NOW);
    if (fault === "missing" || fault === "revoked") {
      assert.equal(out.kind, "HOLD");
      if (out.kind === "HOLD") assert.equal(out.code, "HOLD_REQUIRED_CAPABILITY_INCOMPLETE");
    } else if (fault === "missing-and-recovery") {
      assert.equal(out.kind, "HOLD");
      if (out.kind === "HOLD") assert.equal(out.code, "HOLD_RECOVERY_REQUIRED", "recovery still wins over incomplete capabilities");
    } else assert.equal(out.kind, "PREPARED", JSON.stringify(out));
    assert.ok(reads.counts.get(`query:${R.salesRunsDs}`), "uncertainty uses full reader, not a guessed positive");
    assert.equal(g.client.writes.length, 0);
  }
});

test("W7.1: revoked capabilities refuse a same-handle unsent SETUP continuation before its first byte", async () => {
  const g = world([{ ...CLASSES.b0Answer, allowed_fields: [...CLASSES.b0Answer.allowed_fields] }]); const h = await g.bind(); await g.approve();
  const pending = await g.commit(h, b0Intent(), { commitBudgetMs: 1 });
  assert.equal(pending.kind, "IN_PROGRESS", JSON.stringify(pending));
  assert.equal(g.client.writes.length, 0);
  putRows(g.map, P, []);
  const out = await dispatch("os_resume", { binding_handle: h }, { principal_id: OWNER.principal_id, now: NOW, candidate_resume: true }, g.deps);
  assert.equal(g.client.writes.length, 0);
  assert.ok(JSON.stringify(out).includes("HOLD_REQUIRED_CAPABILITY_INCOMPLETE"));
});

test("R5 delta2: known draft derives with one journal-aware pair check, never recreates inconsistent pair", async () => {
  const { g, h } = await ready(), e = threeContacts(g);
  assert.equal((await g.commit(h, { external_event_evidence: e }, { commitBudgetMs: 1 })).kind, "IN_PROGRESS");
  const b = await bindLive(h, { principal_id: OWNER.principal_id, now: NOW }, g.deps); assert.ok(b.ok); if (!b.ok) return;
  const c = countedReads(g.deps.notion), deps = { ...g.deps, notion: new StructureCache(c.client) };
  assert.equal((await deriveExternalEvent(deps, b.binding, b.runtime, e)).kind, "READY");
  assert.equal(c.counts.get(`page:${ACCOUNT}`), 1, "same-derive witness is private; pair queries still run once");
  assert.equal(c.counts.get(`query:${I}`), 1);
  putRows(g.map, I, [{ object: "page", id: synthetic("unowned-pair-delta2"), properties: { "Event Key": rt(key) } } as Page]);
  assert.equal((await deriveExternalEvent(g.deps, b.binding, b.runtime, e)).kind, "HOLD");
  assert.equal(g.client.writes.length, 0);
});

test("R5 delta2: paced three-Contact draft includes every before-byte check before first write", async () => {
  const { g, h } = await ready(), e = threeContacts(g);
  assert.equal((await g.commit(h, { external_event_evidence: e }, { commitBudgetMs: 1 })).kind, "IN_PROGRESS");
  const raw = g.deps.notion; let reads = 0, firstByteReads: number | undefined;
  const charged = countedReads(raw);
  const paced = Object.fromEntries(Object.entries(charged.client).map(([name, fn]) => [name, (...args: unknown[]) => {
    reads++; g.clock.t += 1000 / 2.8; return (fn as (...a: unknown[]) => unknown)(...args);
  }])) as unknown as NotionReadClient;
  g.client.onWrite = () => { firstByteReads ??= reads; };
  const out = await g.commit(h, { external_event_evidence: e }, { notion: paced });
  assert.ok(firstByteReads !== undefined, `no first byte: reads=${reads} ${JSON.stringify(out)}`);
  assert.ok(g.client.writes.length > 0);
  console.log(`R5 delta2 synthetic paced firstByteReads=${firstByteReads}; not a real latency proof`);
});

test("R5 delta3: four independent schema resolutions overlap, use one client, and refuse invalid schema", async () => {
  const { g, h } = await ready();
  const b = await bindLive(h, { principal_id: OWNER.principal_id, now: NOW }, g.deps); assert.ok(b.ok); if (!b.ok) return;
  const raw = g.deps.notion; let inFlight = 0, peak = 0;
  const reads: NotionReadClient = { ...raw, retrieveDataSource: async (id) => {
    inFlight++; peak = Math.max(peak, inFlight);
    try { await new Promise((resolve) => setTimeout(resolve, 5)); return await raw.retrieveDataSource(id); }
    finally { inFlight--; }
  } };
  assert.equal((await deriveExternalEvent({ ...g.deps, notion: new StructureCache(reads) }, b.binding, b.runtime, evidence())).kind, "READY");
  assert.ok(peak > 1 && peak <= 4, `bounded schema overlap: ${peak}`); assert.equal(inFlight, 0);
  const s = g.map.get(`data_source:${I}`) as { properties: Record<string, unknown> };
  g.map.set(`data_source:${I}`, { ...s, properties: { ...s.properties, Provider: { type: "select", select: { options: [] } } } });
  const refused = await deriveExternalEvent({ ...g.deps, notion: new StructureCache(reads) }, b.binding, b.runtime, evidence());
  assert.equal(refused.kind, "HOLD"); if (refused.kind === "HOLD") assert.equal(refused.code, "HOLD_SCHEMA_MISMATCH");
  assert.equal(g.client.writes.length, 0);
});

test("R5 delta4: only a bijective never-started same-binding journal saves target discovery", async () => {
  for (const fault of ["none", "duplicate-symbol", "wrong-target", "attempted", "other-binding", "expired"] as const) {
    const { g, h } = await ready(), e = threeContacts(g);
    const draft = await g.commit(h, { external_event_evidence: e }, { commitBudgetMs: 1 });
    assert.equal(draft.kind, "IN_PROGRESS"); if (draft.kind !== "IN_PROGRESS") return;
    const originalStore = g.deps.store;
    const store = { ...originalStore, planWrites: { ...originalStore.planWrites, list: async (id: string) => {
      const rows = [...await originalStore.planWrites.list(id)];
      if (id !== draft.plan_id) return rows;
      if (fault === "duplicate-symbol") rows[0] = { ...rows[0]!, symbol: rows[1]!.symbol };
      if (fault === "wrong-target") rows[0] = { ...rows[0]!, target_ref: "foreign-target" };
      if (fault === "attempted") rows[0] = { ...rows[0]!, attempts: 1 };
      return rows;
    } } };
    let handle = h;
    if (fault === "other-binding") handle = await g.bind();
    if (fault === "expired") g.clock.t += 16 * 60_000;
    const reads = countedReads(g.deps.notion);
    const result = await g.commit(handle, { external_event_evidence: e }, { store, notion: reads.client, commitBudgetMs: 1 });
    assert.equal(result.kind, "IN_PROGRESS", fault + JSON.stringify(result));
    assert.equal(g.client.writes.length, 0);
    assert.equal(reads.counts.get(`children:${DATA}:`), fault === "none" ? 1 : 2,
      "only the exact draft skips classification discovery; corrupted/foreign/expired uses the original path");
  }
});

test("R5 delta4: exact draft still refuses missing or divergent freshly approved classes", async () => {
  for (const change of ["missing", "extra-field"] as const) {
    const { g, h } = await ready(), e = threeContacts(g);
    assert.equal((await g.commit(h, { external_event_evidence: e }, { commitBudgetMs: 1 })).kind, "IN_PROGRESS");
    const entries = [INTERACTIONS, RECEIPTS].map((resource_key) => ({ class: "RECONCILE_AS_IS", resource_key,
      operation: "CREATE", allowed_fields: Object.keys(resource_key === INTERACTIONS ? EXTERNAL_INTERACTION_PROPERTIES : EXTERNAL_RECEIPT_PROPERTIES) }));
    if (change === "missing") entries.pop(); else entries[0]!.allowed_fields.push("Unapproved field");
    setIndex(g.map, index([], entries)); await g.approve();
    const reads = countedReads(g.deps.notion);
    const out = await g.commit(h, { external_event_evidence: e }, { notion: reads.client });
    assert.equal(code(out), "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE", change + JSON.stringify(out));
    assert.equal(g.client.writes.length, 0);
    assert.equal(reads.counts.get(`children:${DATA}:`), 2, "non-positive classes fall back to original classification");
  }
});

test("R5 delta4: private derive ownership never survives into an exact draft's before-byte check", async () => {
  for (const drift of ["contact", "account"] as const) {
    const { g, h } = await ready(), e = threeContacts(g);
    assert.equal((await g.commit(h, { external_event_evidence: e }, { commitBudgetMs: 1 })).kind, "IN_PROGRESS");
    const raw = g.deps.notion; let changed = false, guardReads = 0;
    const reads = countedReads({ ...raw, retrievePage: async (id) => {
      if (id === G.indexPage) guardReads++;
      if (!changed && guardReads === 2 && id === G.indexPage) {
        changed = true;
        const ref = drift === "contact" ? CONTACT : ACCOUNT;
        g.map.set(`page:${ref}`, { ...g.map.get(`page:${ref}`) as Page, archived: true });
      }
      return raw.retrievePage(id);
    } });
    const out = await g.commit(h, { external_event_evidence: e }, { notion: reads.client });
    assert.ok(changed); assert.notEqual(out.kind, "PERSISTED"); assert.equal(g.client.writes.length, 0);
    assert.ok(reads.counts.get(`page:${drift === "contact" ? CONTACT : ACCOUNT}`)! >= 2,
      "raw before-byte ownership must observe the new archive flag, never the derive witness");
  }
});

test("R5 delta5: T0 guard starts during derivation, but derive refusal still wins a rejected guard", async () => {
  for (const fault of [false, true]) {
    const { g, h } = await ready(); let guardStarted = false;
    const approvals = g.deps.store.guardApprovals!;
    const store = { ...g.deps.store, guardApprovals: { ...approvals, get: async (...args: Parameters<typeof approvals.get>) => {
      guardStarted = true; if (fault) throw new Error("guard unavailable"); return approvals.get(...args);
    } } };
    const raw = g.deps.notion;
    const notion = { ...raw, retrievePage: async (id: string) => {
      if (id === CONTACT) assert.equal(guardStarted, true, "guard must already run when derive reaches facts");
      return raw.retrievePage(id);
    } };
    const e = evidence(); if (fault) e.contact_refs.push(CONTACT);
    const out = await g.commit(h, { external_event_evidence: e }, { store, notion });
    assert.ok(guardStarted);
    if (fault) { assert.equal(code(out), "HOLD_TARGET_AMBIGUOUS"); assert.equal(g.client.writes.length, 0); }
    else assert.equal(out.kind, "PERSISTED", JSON.stringify(out));
  }
});

test("R5 delta5: started journal preserves serial derive refusal without unused T0 guard", async () => {
  const { g, h } = await ready(); g.client.fault({ symbol: "TARGET_0" }, "APPLY_THEN_FAIL");
  assert.equal((await g.commit(h, { external_event_evidence: evidence() })).kind, "INTERRUPTED");
  const writes = g.client.writes.length; let guardReads = 0;
  const approvals = g.deps.store.guardApprovals!;
  const store = { ...g.deps.store, guardApprovals: { ...approvals, get: async (...args: Parameters<typeof approvals.get>) => {
    guardReads++; return approvals.get(...args);
  } } };
  const e = evidence(); e.contact_refs.push(CONTACT);
  const out = await g.commit(h, { external_event_evidence: e }, { store });
  assert.equal(code(out), "HOLD_TARGET_AMBIGUOUS"); assert.equal(guardReads, 0);
  assert.equal(g.client.writes.length, writes);
});

test("R5 delta5: unreadable optimization prescan cannot mask an invalid capture or open a guard", async () => {
  const { g, h } = await ready(); let guardReads = 0;
  const approvals = g.deps.store.guardApprovals!;
  const store = { ...g.deps.store, plans: { ...g.deps.store.plans, findActive: async () => { throw new Error("store unavailable"); } },
    guardApprovals: { ...approvals, get: async (...args: Parameters<typeof approvals.get>) => { guardReads++; return approvals.get(...args); } } };
  const e = evidence(); e.contact_refs.push(CONTACT);
  assert.equal(code(await g.commit(h, { external_event_evidence: e }, { store })), "HOLD_TARGET_AMBIGUOUS");
  assert.equal(guardReads, 0); assert.equal(g.client.writes.length, 0);
});

test("R5 delta5: raw pair and guard overlap; lease LAST waits for both and sees expiry", async () => {
  for (const fault of ["none", "false", "reject", "expire"] as const) {
    const { g, h } = await ready(); const draft = await g.commit(h, { external_event_evidence: evidence() }, { commitBudgetMs: 1 });
    assert.equal(draft.kind, "IN_PROGRESS"); if (draft.kind !== "IN_PROGRESS") return;
    const b = await bindLive(h, { principal_id: OWNER.principal_id, now: NOW }, g.deps); assert.ok(b.ok); if (!b.ok) return;
    const plan = await g.deps.store.plans.get(draft.plan_id); assert.ok(plan);
    let done!: () => void, release!: () => void, guardFinished = false, leaseReads = 0;
    const pairReached = new Promise<void>((r) => { done = r; }), unblock = new Promise<void>((r) => { release = r; });
    const raw = g.deps.notion, leases = g.deps.store.leases;
    const deps = { ...g.deps, notion: { ...raw, queryDataSource: async (...args: Parameters<typeof raw.queryDataSource>) => {
      const result = await raw.queryDataSource(...args); if (args[0] === Q) done(); return result;
    } }, store: { ...g.deps.store, leases: { ...leases, current: async (...args: Parameters<typeof leases.current>) => {
      leaseReads++; assert.ok(guardFinished, "lease may not be read while the guard is pending");
      assert.equal(args[1].getTime(), g.clock.t, "lease uses clock after every awaited check"); return leases.current(...args);
    } } } };
    const checking = externalEventPlanStillOwned(deps, b.binding, b.runtime, plan, () => new Date(g.clock.t), async () => {
      await unblock; guardFinished = true;
      if (fault === "expire") g.clock.t += 24 * 60 * 60_000;
      if (fault === "reject") throw new Error("guard unreadable"); return fault !== "false";
    });
    await pairReached; assert.equal(leaseReads, 0, "pair must finish without waiting to start on the guard");
    release(); const owned = await checking;
    assert.equal(owned, fault === "none", fault);
    assert.equal(leaseReads, fault === "false" || fault === "reject" ? 0 : 1);
    assert.equal(g.client.writes.length, 0);
  }
});

test("R5 delta5: drift after early T0 is freshly refused before the first byte", async () => {
  const { g, h } = await ready(); const raw = g.deps.notion; let guardReads = 0;
  const notion = { ...raw, retrieveBlockChildren: async (...args: Parameters<typeof raw.retrieveBlockChildren>) => {
    // Before the second snapshot reads the JSON block, not after it already captured the old digest.
    if (args[0] === G.constitution && ++guardReads === 2) setIndex(g.map, index([]));
    return raw.retrieveBlockChildren(...args);
  } };
  const out = await g.commit(h, { external_event_evidence: evidence() }, { notion });
  assert.ok(guardReads >= 2); assert.equal(code(out), "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE");
  assert.equal(g.client.writes.length, 0);
});

test("R5 delta6: expired untouched event before a started one cannot hide guarded bare recovery", async () => {
  for (const drift of [false, true]) {
    const { g, h } = await ready();
    const empty = await g.commit(h, { external_event_evidence: evidence() }, { commitBudgetMs: 1 });
    assert.equal(empty.kind, "IN_PROGRESS"); if (empty.kind !== "IN_PROGRESS") return;
    g.clock.t += 16 * 60_000; const next = await g.bind();
    g.client.fault({ symbol: "TARGET_0" }, "APPLY_THEN_FAIL");
    const partial = await g.commit(next, { external_event_evidence: evidence() });
    assert.equal(partial.kind, "INTERRUPTED", JSON.stringify(partial)); if (partial.kind !== "INTERRUPTED") return;
    assert.equal((await g.deps.store.plans.get(empty.plan_id))!.plan_state, "EXPIRED");
    assert.ok((await g.deps.store.planWrites.list(empty.plan_id)).every((r) => r.status === "PENDING"));
    const writes = g.client.writes.length;
    if (drift) setIndex(g.map, index([]));
    const out = await g.commit(next, {});
    if (drift) { assert.equal(code(out), "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE"); assert.equal(g.client.writes.length, writes); }
    else { assert.equal(out.kind, "PERSISTED", JSON.stringify(out)); if (out.kind === "PERSISTED") assert.equal(out.plan_id, partial.plan_id); }
    assert.equal(rowsOf(g.map, I).length, 1, "first target never recreated by generic settlement");
    assert.equal(rowsOf(g.map, Q).length, drift ? 0 : 1);
  }
});

test("R5 delta7: prepared same-binding event recovery continues without reopening parent assessment", async () => {
  const { g, h } = await ready();
  g.client.fault({ symbol: "TARGET_0" }, "APPLY_THEN_FAIL");
  const partial = await g.commit(h, { external_event_evidence: evidence() });
  assert.equal(partial.kind, "INTERRUPTED"); if (partial.kind !== "INTERRUPTED") return;
  g.clock.t += 16 * 60_000; const next = await g.bind();
  const prepared = await g.commit(next, {}, { commitBudgetMs: 1 });
  assert.equal(prepared.kind, "IN_PROGRESS", JSON.stringify(prepared)); if (prepared.kind !== "IN_PROGRESS") return;
  const child = await g.deps.store.plans.get(prepared.plan_id); assert.ok(child);
  assert.equal(child.run_mode, "RECOVER_EXISTING"); assert.equal(child.recovers_plan_id, partial.plan_id);
  assert.ok((await g.deps.store.planWrites.list(child.plan_id)).every((r) => r.status === "PENDING"));
  const plans = g.deps.store.plans;
  const out = await g.commit(next, {}, { store: { ...g.deps.store, plans: { ...plans, get: async (id: string) => {
    if (id === partial.plan_id) throw new Error("redundant parent assessment reopened");
    return plans.get(id);
  } } } });
  assert.equal(out.kind, "PERSISTED", JSON.stringify(out)); if (out.kind === "PERSISTED") assert.equal(out.plan_id, child.plan_id);
  assert.equal(rowsOf(g.map, I).length, 1); assert.equal(rowsOf(g.map, Q).length, 1);
});

async function preparedEventRecovery() {
  const { g, h } = await ready();
  g.client.fault({ symbol: "TARGET_0" }, "APPLY_THEN_FAIL");
  const partial = await g.commit(h, { external_event_evidence: evidence() });
  assert.equal(partial.kind, "INTERRUPTED");
  if (partial.kind !== "INTERRUPTED") throw new Error("missing started event fixture");
  g.clock.t += 16 * 60_000;
  const next = await g.bind();
  const prepared = await g.commit(next, {}, { commitBudgetMs: 1 });
  assert.equal(prepared.kind, "IN_PROGRESS");
  if (prepared.kind !== "IN_PROGRESS") throw new Error("missing prepared recovery fixture");
  const child = await g.deps.store.plans.get(prepared.plan_id);
  assert.ok(child);
  assert.ok((await g.deps.store.planWrites.list(child.plan_id)).every((r) => r.status === "PENDING" && r.attempts === 0));
  return { g, next, child, root: partial.plan_id };
}

async function expiredPartialChild() {
  const { g, h } = await ready();
  g.client.onWrite = (w) => { if (w.ctx.symbol === "OPEN_RUN") g.clock.t += 35_000; };
  const first = await g.commit(h, { external_event_evidence: evidence() });
  assert.equal(first.kind, "IN_PROGRESS", JSON.stringify(first));
  if (first.kind !== "IN_PROGRESS") throw new Error("root checkpoint not created");
  assert.deepEqual((await g.deps.store.planWrites.list(first.plan_id)).filter((r) => r.status === "DONE").map((r) => r.symbol), ["OPEN_RUN"]);
  g.clock.t += 16 * 60_000; delete g.client.onWrite;
  const next = await g.bind();
  const prepared = await g.commit(next, {}, { commitBudgetMs: 1 });
  assert.equal(prepared.kind, "IN_PROGRESS", JSON.stringify(prepared));
  if (prepared.kind !== "IN_PROGRESS") throw new Error("child checkpoint not created");
  g.client.onWrite = (w) => { if (w.ctx.symbol === "LEDGER_1") g.clock.t += 35_000; };
  assert.equal((await g.commit(next, {})).kind, "IN_PROGRESS");
  const child = (await g.deps.store.plans.get(prepared.plan_id))!;
  assert.deepEqual((await g.deps.store.planWrites.list(child.plan_id)).filter((r) => r.status === "DONE").map((r) => r.symbol),
    ["RESUME_RUN", "LEDGER_0", "TARGET_0", "LEDGER_0_WRITTEN", "LEDGER_1"]);
  g.clock.t += 16 * 60_000; delete g.client.onWrite;
  return { g, fresh: await g.bind(), root: (await g.deps.store.plans.get(first.plan_id))!, child };
}

test("R5 root-lineage: expired root recognizes its exact expired partial child on fresh binding, no recreated Interaction or ledger", async () => {
  const { g, fresh, root } = await expiredPartialChild();
  const out = await g.commit(fresh, {});
  assert.equal(out.kind, "PERSISTED", JSON.stringify(out));
  assert.equal(rowsOf(g.map, I).length, 1); assert.equal(rowsOf(g.map, Q).length, 1);
  assert.equal(g.client.writes.filter((w) => w.ctx.symbol === "TARGET_0").length, 1);
  assert.equal(g.client.writes.filter((w) => w.ctx.symbol === "LEDGER_0").length, 1);
  assert.equal(g.client.writes.filter((w) => w.ctx.symbol === "LEDGER_1").length, 1);
  if (out.kind === "PERSISTED") {
    const successor = (await g.deps.store.plans.get(out.plan_id))!;
    assert.equal(successor.parent_plan_id, root.plan_id); assert.equal(successor.recovers_plan_id, root.plan_id);
    assert.deepEqual(successor.stage1_writes.map((w) => w.symbol), ["RESUME_RUN", "TARGET_1", "LEDGER_1_WRITTEN"]);
  }
});

for (const field of ["principal_id", "project", "lane", "runtime_logical_key", "runtime_id", "runtime_generation", "governing_spec_version",
  "governing_schema_version", "governing_control_version", "parent_plan_id", "run_ref", "plan_origin", "plan_kind"] as const) {
  test(`R5 root-lineage: foreign child ${field} cannot lend its journal witness`, async () => {
    const { g, fresh, child } = await expiredPartialChild();
    Object.assign(child, { [field]: "foreign" });
    const writes = g.client.writes.length;
    assert.equal(code(await g.commit(fresh, {})), "HOLD_DUPLICATE"); assert.equal(g.client.writes.length, writes);
  });
}

test("R5 root-lineage: changed operation target or idempotency key never lends witness even with identical expected values", async () => {
  for (const field of ["target_data_source_ref", "idempotency_key", "natural_key", "operation"] as const) {
    const { g, fresh, child } = await expiredPartialChild();
    const operations = structuredClone(child.operations); Object.assign(operations[0]!, { [field]: "foreign" }); Object.assign(child, { operations });
    const writes = g.client.writes.length;
    assert.equal(code(await g.commit(fresh, {})), "HOLD_DUPLICATE", field); assert.equal(g.client.writes.length, writes);
  }
});

test("R5 root-lineage: conflicting created IDs from a second exact child cannot hide behind the first valid witness", async () => {
  const { g, fresh, child } = await expiredPartialChild();
  const other = { ...child, plan_id: "other-expired-exact-child" };
  await g.deps.store.plans.insert(other);
  const journal = g.deps.store.planWrites, existing = await journal.list(child.plan_id), writes = g.client.writes.length;
  const out = await g.commit(fresh, {}, { store: { ...g.deps.store, planWrites: { ...journal,
    list: async (id: string) => id !== other.plan_id ? journal.list(id) : existing.map((r) => ({ ...r, plan_id: other.plan_id,
      ...(r.symbol === "TARGET_0" ? { created_id: synthetic("foreign-created-target") } : {}) })),
  } } });
  assert.equal(code(out), "HOLD_DUPLICATE"); assert.equal(g.client.writes.length, writes);
});

test("R5 root-lineage: fresh target drift is never replaced by an old child's journal witness", async () => {
  for (const fault of ["archived", "value"] as const) {
    const { g, fresh } = await expiredPartialChild(), target = rowsOf(g.map, I)[0]!;
    putRows(g.map, I, [{ ...target, ...(fault === "archived" ? { archived: true } :
      { properties: { ...target.properties, "Source Identity": rt("foreign@example.invalid") } }) } as Page]);
    const writes = g.client.writes.length;
    assert.equal(code(await g.commit(fresh, {})), "HOLD_DUPLICATE"); assert.equal(g.client.writes.length, writes);
  }
});

test("R5 delta7: prepared child rechecks fresh guard and emits no byte on drift", async () => {
  const { g, next, child } = await preparedEventRecovery();
  const writes = g.client.writes.length;
  setIndex(g.map, index([]));
  const out = await g.commit(next, {});
  assert.equal(code(out), "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE");
  assert.equal(g.client.writes.length, writes);
  assert.ok((await g.deps.store.planWrites.list(child.plan_id)).every((r) => r.status === "PENDING" && r.attempts === 0));
});

for (const [field, value] of [
  ["plan_kind", "INSTALL_MAPPING"], ["run_mode", "OPEN_NEW"], ["plan_origin", "INTENT"],
  ["parent_plan_id", "unrelated-parent"], ["run_ref", "unrelated-run"],
  ["runtime_logical_key", "unrelated-runtime"], ["runtime_id", "unrelated-runtime"],
  ["governing_spec_version", "unrelated-spec"], ["governing_schema_version", "unrelated-schema"],
  ["governing_control_version", "unrelated-control"],
] as const) {
  test(`R5 delta7: child ${field} mismatch refuses without bytes`, async () => {
    const { g, next, child } = await preparedEventRecovery();
    Object.assign(child, { [field]: value }); // Fault injection in the in-memory backend, never caller input.
    const writes = g.client.writes.length;
    const out = await g.commit(next, {});
    assert.equal(code(out), "HOLD_DUPLICATE", JSON.stringify(out));
    assert.equal(g.client.writes.length, writes);
  });
}

test("R5 delta7: changed immutable event capture refuses without bytes", async () => {
  const { g, next, child } = await preparedEventRecovery();
  const operations = structuredClone(child.operations);
  Object.assign(operations[0]!.expected_values, { "Evidence Ref": "gmail:message/different" });
  Object.assign(child, { operations });
  const writes = g.client.writes.length;
  assert.equal(code(await g.commit(next, {})), "HOLD_DUPLICATE");
  assert.equal(g.client.writes.length, writes);
});

test("R5 delta7: fresh source ownership drift refuses before child bytes", async () => {
  const { g, next } = await preparedEventRecovery();
  const contact = rowsOf(g.map, C)[0]!;
  putRows(g.map, C, [{ ...contact, archived: true }]);
  const writes = g.client.writes.length;
  const out = await g.commit(next, {});
  assert.equal(out.kind, "HELD", JSON.stringify(out));
  assert.equal(g.client.writes.length, writes);
});

for (const field of ["binding_id", "recovers_plan_id", "expires_at"] as const) {
  test(`R5 delta7: ineligible child ${field} is never executed as current-binding authority`, async () => {
    const { g, next, child } = await preparedEventRecovery();
    Object.assign(child, { [field]: field === "expires_at" ? new Date(g.clock.t - 1) : "unrelated-link" });
    const writes = g.client.writes.length;
    const out = await g.commit(next, {}, { commitBudgetMs: 1 });
    assert.notEqual(out.kind, "PERSISTED", JSON.stringify(out));
    assert.equal(g.client.writes.length, writes);
    assert.ok((await g.deps.store.planWrites.list(child.plan_id)).every((r) => r.status === "PENDING" && r.attempts === 0));
  });
}

test("R5 delta7: ambiguous live children refuse without bytes", async () => {
  const { g, next, child } = await preparedEventRecovery();
  await g.deps.store.plans.insert({ ...child, plan_id: "second-prepared-child" });
  const writes = g.client.writes.length;
  assert.equal(code(await g.commit(next, {})), "HOLD_RUNTIME_BUSY");
  assert.equal(g.client.writes.length, writes);
});

test("R5 delta7: missing durable original Run refuses without bytes", async () => {
  const { g, next, root } = await preparedEventRecovery();
  const parent = await g.deps.store.plans.get(root); assert.ok(parent);
  Object.assign(parent, { run_ref: undefined });
  const journal = g.deps.store.planWrites;
  const writes = g.client.writes.length;
  const out = await g.commit(next, {}, { store: { ...g.deps.store, planWrites: { ...journal,
    list: async (id: string) => (await journal.list(id)).map((r) => {
      if (id !== root || r.symbol !== "OPEN_RUN") return r;
      const { created_id: _missing, ...withoutCreatedId } = r;
      return withoutCreatedId;
    }),
  } } });
  assert.equal(code(out), "HOLD_DUPLICATE");
  assert.equal(g.client.writes.length, writes);
});

test("PT-GMAIL-012/a: real MCP os_commit persists exactly two canonical records, TARGET+FINAL, no step movement or subject leakage", async () => {
  const { g, h } = await ready();
  const previousIntents = JSON.stringify(rowsOf(g.map, R.salesExtDs));
  const server = createServer(g.deps, OWNER.principal_id); const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); const client = new Client({ name: "event-write-test", version: "0" }); await client.connect(ct);
  try {
    const response = await client.callTool({ name: "os_commit", arguments: { binding_handle: h, external_event_evidence: evidence() } });
    const out = JSON.parse((response.content as Array<{ text: string }>)[0]!.text);
    assert.equal(out.kind, "PERSISTED", JSON.stringify(out));
    assert.equal(out.step_moved, false); assert.equal(out.derived_move, "NONE");
    assert.deepEqual(out.targets.map((t: { logical_resource_key: string }) => t.logical_resource_key), [INTERACTIONS, RECEIPTS]);
    assert.ok(out.target_receipt_id && out.final_receipt_id);
    assert.equal(rowsOf(g.map, I).length, 1); assert.equal(rowsOf(g.map, Q).length, 1);
    assert.equal(propText(rowsOf(g.map, I)[0]!, "Event Key"), key);
    assert.equal(propText(rowsOf(g.map, Q)[0]!, "Interaction Key"), key);
    assert.equal(propText(rowsOf(g.map, Q)[0]!, "Effect Status"), "ATTESTED_SENT");
    assert.equal(propText(rowsOf(g.map, Q)[0]!, "Verified"), "false");
    assert.equal(propText(rowsOf(g.map, R.salesStateDs)[0]!, "Current Gate"), "B0_DISCOVERY");
    assert.ok(!JSON.stringify(out).includes("PRIVATE-NATIVE-SUBJECT"));
    assert.ok(!JSON.stringify(await g.deps.store.events.list({})).includes("PRIVATE-NATIVE-SUBJECT"));
    assert.equal(JSON.stringify(rowsOf(g.map, R.salesExtDs)), previousIntents);
  } finally { await client.close(); await server.close(); }
});

test("PT-GMAIL-012/b: missing property/type/ATTESTED_SENT/foreign relation refuses before any byte or plan", async () => {
  for (const failure of ["missing", "type", "option", "relation"]) {
    const { g, h } = await ready();
    const ds = g.map.get(`data_source:${Q}`) as { properties: Record<string, { type: string; select?: { options: unknown[] } }> };
    if (failure === "missing") delete ds.properties["Evidence Ref"];
    if (failure === "type") ds.properties["Event ID"] = { type: "number" };
    if (failure === "option") ds.properties["Effect Status"] = { type: "select", select: { options: [] } };
    if (failure === "relation") (g.map.get(`data_source:${I}`) as { properties: Record<string, unknown> }).properties["Contacts"] = { type: "relation", relation: { data_source_id: synthetic("foreign-contacts") } };
    assert.equal(code(await g.commit(h, { external_event_evidence: evidence() })), "HOLD_SCHEMA_MISMATCH", failure);
    assert.equal(g.client.writes.length, 0); const b = (await g.deps.store.bindings.findByHandleHash(hashHandle(h)))!;
    assert.equal((await g.deps.store.plans.listByRuntime(b.project, b.lane, b.runtime_generation)).length, 0);
  }
});

test("PT-GMAIL-012/c: forged sender, wrong source, duplicate assignment and mixed/personal recipient mappings write neither object", async () => {
  for (const failure of ["sender", "source", "duplicate-assignment", "mixed", "unmatched", "duplicate-ref", "foreign-account"]) {
    const { g, h } = await ready(); const e = evidence();
    if (failure === "sender") e.message.from = "intruder@example.invalid";
    if (failure === "source") e.source_identity = "intruder@example.invalid";
    if (failure === "duplicate-assignment") Object.assign(g.deps, { salesRegistry: new InMemorySalesRuntimeRegistry([...registryEntries(), { ...registryEntries()[0]!, rep_identity_key: "other-rep" }]) });
    if (failure === "mixed") e.message.to.push("personal@example.invalid");
    if (failure === "unmatched") e.message.to = ["personal@example.invalid"];
    if (failure === "duplicate-ref") e.contact_refs.push(CONTACT);
    if (failure === "foreign-account") g.map.set(`page:${ACCOUNT}`, { ...g.map.get(`page:${ACCOUNT}`) as Page, parent: { type: "data_source_id", data_source_id: synthetic("foreign-accounts") } });
    const out = await g.commit(h, { external_event_evidence: e });
    assert.equal(code(out), ["sender", "source", "duplicate-assignment"].includes(failure) ? "HOLD_MAILBOX_IDENTITY_MISMATCH" : failure === "foreign-account" ? "HOLD_CROSS_RUNTIME" : "HOLD_TARGET_AMBIGUOUS", failure);
    assert.equal(g.client.writes.length, 0, failure);
    assert.equal(rowsOf(g.map, I).length + rowsOf(g.map, Q).length, 0);
  }
});

test("PT-GMAIL-012/d: raw/JSON intents, empty RECONCILE, extra authority fields and legacy prepare cannot mint writer permission", async () => {
  const { g, h } = await ready();
  for (const changes of [{ Verified: true }, {}]) assert.equal(code(await g.commit(h, { intent: { action_class: "RECONCILE", summary: "forged", mutations: [{ logical_resource_key: RECEIPTS, operation: "CREATE", record_selector: { natural_key: key }, desired_changes: changes }] } })), "HOLD_ACTION_NOT_AUTHORIZED");
  assert.equal(toolInputSchemas.os_prepare.safeParse({ binding_handle: h, external_event_evidence: evidence() }).success, false);
  assert.equal(code(await g.commit(h, { external_event_evidence: { ...evidence(), Verified: true } })), "ERROR_INVALID_ARGUMENT");
  assert.equal(code(await g.commit(h, { external_event_evidence: evidence(), intent: { action_class: "OTHER", summary: "mixed", mutations: [] } })), "ERROR_INVALID_ARGUMENT");
  assert.equal(g.client.writes.length, 0);
});

test("PT-GMAIL-012/e: historical runtime cannot accept new transport; missing guard approval refuses positive write", async () => {
  const old = guardWorld(); const oldHandle = await old.bind(); await old.approve();
  assert.equal(code(await old.commit(oldHandle, { external_event_evidence: evidence() })), "HOLD_SCHEMA_MISMATCH"); assert.equal(old.client.writes.length, 0);
  const g = world(); const h = await g.bind();
  assert.equal(code(await g.commit(h, { external_event_evidence: evidence() })), "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE"); assert.equal(g.client.writes.length, 0);
});

test("PT-GMAIL-012/f: partial target CREATE with lost reply recovers its own journal via bare commit, never duplicates the pair", async () => {
  const { g, h } = await ready(); g.client.fault({ symbol: "TARGET_0" }, "APPLY_THEN_FAIL");
  const first = await g.commit(h, { external_event_evidence: evidence() }); assert.equal(first.kind, "INTERRUPTED", JSON.stringify(first));
  assert.equal(rowsOf(g.map, I).length, 1); assert.equal(rowsOf(g.map, Q).length, 0);
  g.clock.t += 60_000;
  const second = await g.commit(h, {}); assert.equal(second.kind, "PERSISTED", JSON.stringify(second));
  assert.equal(rowsOf(g.map, I).length, 1); assert.equal(rowsOf(g.map, Q).length, 1);
});

test("PT-GMAIL-012/g: candidate classification needs original immutable mutation objects and one exact approved class", async () => {
  const { g, h } = await ready();
  const bound = await bindLive(h, { principal_id: OWNER.principal_id, now: NOW }, g.deps);
  assert.ok(bound.ok); if (!bound.ok) return;
  const derived = await deriveExternalEvent(g.deps, bound.binding, bound.runtime, evidence());
  assert.equal(derived.kind, "READY"); if (derived.kind !== "READY") return;
  const opened = await openGuard(g.deps, bound.binding, bound.runtime, NOW);
  assert.equal(opened.kind, "OPEN"); if (opened.kind !== "OPEN") return;
  for (const m of derived.intent.mutations) {
    assert.ok(isExternalEventMutation(bound.runtime, m));
    assert.ok(Object.isFrozen(m.desired_changes) && Object.isFrozen(m.record_selector));
    assert.throws(() => { (m.desired_changes as Record<string, unknown>).Verified = true; }, TypeError);
    const contacts = m.desired_changes.Contacts;
    if (Array.isArray(contacts)) assert.throws(() => contacts.push(CONTACT), TypeError);
    assert.deepEqual(await classify(g.deps.notion, bound.runtime, "BUSINESS", m, opened.snapshot), { kind: "CLASS", cls: "RECONCILE_AS_IS" });
    for (const copy of [{ ...m }, structuredClone(m), JSON.parse(JSON.stringify(m)), { ...m, desired_changes: { ...m.desired_changes, Verified: true } }])
      assert.equal((await classify(g.deps.notion, bound.runtime, "BUSINESS", copy, opened.snapshot)).kind, "UNCLASSIFIED");
    const entry = opened.snapshot.index.operation_classes.find((e) => e.resource_key === m.logical_resource_key)!;
    for (const entries of [[], [entry, entry], [{ ...entry, allowed_fields: [...entry.allowed_fields, "EXTRA"] }],
      [{ ...entry, allowed_fields: entry.allowed_fields.slice(1) }], [{ ...entry, class: "PRODUCTION" as const }], [{ ...entry, date_field: "Occurred At" }]]) {
      const snapshot: GuardSnapshot = { ...opened.snapshot, index: { ...opened.snapshot.index, operation_classes: entries } };
      assert.equal((await classify(g.deps.notion, bound.runtime, "BUSINESS", m, snapshot)).kind, "UNCLASSIFIED");
    }
  }
  assert.equal(g.client.writes.length, 0);
});

test("PT-GMAIL-012/h: approved triggered P0 does not turn event attestation into production, malformed class sets hold", async () => {
  const base = [INTERACTIONS, RECEIPTS].map((resource_key) => ({ class: "RECONCILE_AS_IS", resource_key, operation: "CREATE", allowed_fields: Object.keys(resource_key === INTERACTIONS ? EXTERNAL_INTERACTION_PROPERTIES : EXTERNAL_RECEIPT_PROPERTIES) }));
  const g = world(undefined, true); const h = await g.bind(); await g.approve();
  assert.equal((await g.commit(h, { external_event_evidence: evidence() })).kind, "PERSISTED");
  for (const fields of [["EXTRA"], base[0]!.allowed_fields.slice(1)]) {
    const w = world([{ ...base[0]!, allowed_fields: fields }, base[1]!]); const handle = await w.bind(); await w.approve();
    assert.equal(code(await w.commit(handle, { external_event_evidence: evidence() })), "HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE");
    assert.equal(w.client.writes.length, 0);
  }
});

function bindIntent(g: ReturnType<typeof world>, e: ExternalEventEvidence) {
  const intent = rowsOf(g.map, R.salesExtDs)[0]!;
  putRows(g.map, R.salesExtDs, [{ ...intent, properties: { ...intent.properties, "Action Key": rt("event-action"), Recipient: rt(e.message.to[0]!),
    "Action Type": { type: "select", select: { name: "GMAIL_SEND" } }, "Record Type": { type: "select", select: { name: "INTENT" } },
    "Prepared At": { type: "date", date: { start: "2030-01-02T10:00:00.000Z" } } } } as Page]);
  e.intent_ref = intent.id; e.message.action_key = "event-action";
}

test("PT-GMAIL-012/i: interleaved different events for one Intent Ref retain one pair and never complete the intent twice", async () => {
  const { g, h } = await ready(); const first = evidence(); bindIntent(g, first);
  let signal!: () => void, release!: () => void;
  const entered = new Promise<void>((r) => { signal = r; }), unblock = new Promise<void>((r) => { release = r; });
  const create = g.client.createPage.bind(g.client);
  g.client.createPage = async (ds, props, ctx) => { if (ctx.symbol === "TARGET_0") { signal(); await unblock; } return create(ds, props, ctx); };
  const one = g.commit(h, { external_event_evidence: first });
  await entered;
  const second = { ...first, message: { ...first.message, message_id: "event-two" }, evidence_ref: "gmail:message/event-two" };
  let competing: Awaited<ReturnType<typeof g.commit>>;
  try { competing = await g.commit(h, { external_event_evidence: second }); } finally { release(); }
  assert.notEqual(competing.kind, "PERSISTED");
  assert.equal((await one).kind, "PERSISTED");
  assert.equal(rowsOf(g.map, I).length, 1); assert.equal(rowsOf(g.map, Q).length, 1);
  const later = await g.commit(h, { external_event_evidence: second });
  assert.equal(code(later), "HOLD_DUPLICATE");
  assert.equal(rowsOf(g.map, I).length, 1); assert.equal(rowsOf(g.map, Q).length, 1);
});

test("PT-GMAIL-012/j: lease is rechecked after awaited reads before each target byte", async () => {
  for (const partial of [false, true]) {
    const { g, h } = await ready(); const b = (await g.deps.store.bindings.findByHandleHash(hashHandle(h)))!;
    let armed = false, checked = false;
    g.client.onWrite = (w) => { if (partial ? w.ctx.symbol === "TARGET_0" : w.target !== I && w.target !== Q) armed = true; };
    const original = g.deps.notion.queryDataSource.bind(g.deps.notion);
    Object.assign(g.deps, { notion: { ...g.deps.notion, queryDataSource: async (...args: Parameters<typeof original>) => {
      const result = await original(...args);
      if (armed && !checked && args[0] === Q) {
        const leaseKey = { project: b.project, lane: b.lane, runtime_generation: b.runtime_generation };
        const lease = await g.deps.store.leases.current(leaseKey, new Date(g.clock.t)); assert.ok(lease);
        await g.deps.store.leases.release(leaseKey, lease.plan_id); checked = true;
      }
      return result;
    } } });
    const result = await g.commit(h, { external_event_evidence: evidence() });
    assert.ok(checked, "the injected loss must occur during the final ownership read");
    assert.notEqual(result.kind, "PERSISTED");
    assert.equal(rowsOf(g.map, I).length, partial ? 1 : 0); assert.equal(rowsOf(g.map, Q).length, 0);
  }
});

test("PT-GMAIL-012/k: another receipt arriving after prepare blocks both business writes for the same Intent Ref", async () => {
  const { g, h } = await ready(); const e = evidence(); bindIntent(g, e);
  let injected = false;
  g.client.onWrite = (w) => {
    if (injected || w.ctx.symbol !== "OPEN_RUN") return;
    injected = true;
    putRows(g.map, Q, [{ object: "page", id: synthetic("other-intent-receipt"), properties: {
      "Intent Ref": rt(normalizeId(e.intent_ref)!), "Interaction Key": rt("different-event-key"), "Event Type": { type: "select", select: { name: "GMAIL_SEND" } },
    } } as Page]);
  };
  const result = await g.commit(h, { external_event_evidence: e });
  assert.ok(injected); assert.notEqual(result.kind, "PERSISTED");
  assert.equal(rowsOf(g.map, I).length, 0);
  assert.equal(rowsOf(g.map, Q).length, 1); assert.equal(propText(rowsOf(g.map, Q)[0]!, "Interaction Key"), "different-event-key");
  assert.equal(g.client.writes.filter((w) => w.target === I || w.target === Q).length, 0);
});

test("PT-GMAIL-012/l: missing target fields cannot pass readback; recovery obeys guard and business ownership drift", async () => {
  const broken = await ready(); broken.g.client.fault({ symbol: "TARGET_1" }, "DROP_FIELDS", { fields: ["Verified"] });
  assert.notEqual((await broken.g.commit(broken.h, { external_event_evidence: evidence() })).kind, "PERSISTED");
  for (const drift of ["guard", "approved-guard", "account"]) {
    const { g, h } = await ready(); g.client.fault({ symbol: "TARGET_0" }, "APPLY_THEN_FAIL");
    assert.equal((await g.commit(h, { external_event_evidence: evidence() })).kind, "INTERRUPTED");
    g.clock.t += 60_000;
    if (drift === "guard" || drift === "approved-guard") {
      setIndex(g.map, index());
      if (drift === "approved-guard") await g.approve();
    }
    else g.map.set(`page:${ACCOUNT}`, { ...g.map.get(`page:${ACCOUNT}`) as Page, archived: true });
    const before = g.client.writes.length;
    assert.notEqual((await g.commit(h, {})).kind, "PERSISTED");
    assert.equal(g.client.writes.length, before); assert.equal(rowsOf(g.map, Q).length, 0);
  }
});

test("PT-GMAIL-012/m: same-plan claim expiry/reclaim while a check awaits cannot send the stale caller's next byte", async () => {
  const { g, h } = await ready(); let armed = false, injected = false;
  g.client.onWrite = (w) => { if (w.ctx.symbol === "TARGET_0") armed = true; };
  let entered!: () => void, release!: () => void;
  const secondAtByte = new Promise<void>((r) => { entered = r; }), unblock = new Promise<void>((r) => { release = r; });
  const create = g.client.createPage.bind(g.client);
  g.client.createPage = async (ds, props, ctx) => { if (ctx.symbol === "TARGET_1") { entered(); await unblock; } return create(ds, props, ctx); };
  let second: Promise<Awaited<ReturnType<typeof g.commit>>> | undefined;
  const original = g.deps.notion.queryDataSource.bind(g.deps.notion);
  Object.assign(g.deps, { notion: { ...g.deps.notion, queryDataSource: async (...args: Parameters<typeof original>) => {
    const result = await original(...args);
    if (armed && !injected && args[0] === Q) {
      injected = true; g.clock.t += 65_001; // 35s call deadline + 30s executor claim margin.
      second = g.commit(h, {});
      await secondAtByte; // same plan has a new live claim/lease, but its Receipt byte is paused.
    }
    return result;
  } } });
  const first = await g.commit(h, { external_event_evidence: evidence() });
  try {
    assert.ok(injected && second);
    assert.equal(first.kind, "IN_PROGRESS", JSON.stringify(first));
    if (first.kind === "IN_PROGRESS") assert.equal(first.reason, "BUDGET");
    assert.equal(g.client.writes.filter((w) => w.ctx.symbol === "TARGET_1").length, 0);
  } finally { release(); }
  assert.equal((await second!).kind, "PERSISTED");
  assert.equal(rowsOf(g.map, I).length, 1); assert.equal(rowsOf(g.map, Q).length, 1);
  assert.equal(g.client.writes.filter((w) => w.ctx.symbol === "TARGET_1").length, 1);
});
