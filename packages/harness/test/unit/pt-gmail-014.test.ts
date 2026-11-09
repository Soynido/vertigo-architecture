/** W4.5: immutable event replay/rebinding, synthetic local MCP only. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/index.ts";
import { propText, type Page } from "../../src/notion/shapes.ts";
import { InMemorySalesRuntimeRegistry } from "../../src/registry/salesRuntimes.ts";
import { registerBuiltinSalesAdapters } from "../../src/versions/adapters/sales.ts";
import { EXTERNAL_INTERACTION_PROPERTIES, EXTERNAL_RECEIPT_PROPERTIES, EXTERNAL_RECEIPT_OPTIONS, SALES_CONTROL_PLANE_0513_CANDIDATE } from "../../src/versions/adapters/controlPlane.ts";
import { deriveExternalEvent, EXTERNAL_SPEC, EXTERNAL_SCHEMA, INTERACTIONS, RECEIPTS } from "../../src/effects/eventWrite.ts";
import { bindLive } from "../../src/tools/handlers.ts";
import { capabilityProofKey } from "../../src/resume/capabilities.ts";
import { externalIdentityKey, SnapshotCompetentSource } from "../../src/effects/gmail.ts";
import type { ExternalEventEvidence } from "../../src/tools/surface.ts";
import { OWNER } from "./binding-fixtures.ts";
import { synthetic, text } from "./meta-fixtures.ts";
import { IDS, CONTRACT_PAGE, registryEntries } from "./sales-fixtures.ts";
import { R, setRowsIn, runPage, ledgerRow } from "./resume-fixtures.ts";
import { G, guardWorld, index, putRows, rowsOf, NOW, type ClassEntry, rule, p0, eq, lit, CLASSES, b0Intent } from "../support/guard-fixtures.ts";

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
  return g;
}

async function ready(classes?: ClassEntry[]) { const g = world(classes); const h = await g.bind(); await g.approve(); return { g, h }; }


async function mcp(g: ReturnType<typeof world>, over: Partial<ReturnType<typeof world>["deps"]> = {}) {
 const server = createServer({...g.deps,...over}, OWNER.principal_id), [ct, st] = InMemoryTransport.createLinkedPair();
 await server.connect(st); const client = new Client({ name: "provenance-test", version: "0" }); await client.connect(ct);
 return { client, close: async () => { await client.close(); await server.close(); } };
}
const unpack = (r: unknown) => JSON.parse((r as { content: Array<{text:string}> }).content[0]!.text);
const INTENT = synthetic("provenance-intent");

const code = (out: Awaited<ReturnType<ReturnType<typeof world>["commit"]>>) => out.kind === "HELD" ? out.code : out.kind;
const pair = (g: ReturnType<typeof world>) => JSON.stringify([rowsOf(g.map,I),rowsOf(g.map,Q)]);
const capture = (g: ReturnType<typeof world>,h: string,e=evidence()) => g.commit(h,{external_event_evidence:e});

test("PT-GMAIL-014/a: exact real MCP replay reuses original TARGET/FINAL receipts and targets, writes nothing",async()=>{
 const {g,h}=await ready(), first=await capture(g,h);
 assert.equal(first.kind,"PERSISTED",JSON.stringify(first)); if(first.kind!=="PERSISTED") return;
 const old=pair(g), before=g.client.writes.length;
 const {client,close}=await mcp(g);
 try {
  const second=unpack(await client.callTool({name:"os_commit",arguments:{binding_handle:h,external_event_evidence:evidence()}}));
  assert.equal(second.kind,"PERSISTED",JSON.stringify(second));
  assert.equal(second.target_receipt_id,first.target_receipt_id); assert.equal(second.final_receipt_id,first.final_receipt_id);
  assert.deepEqual(second.targets,first.targets); assert.equal(second.writes_sent,0); assert.equal(second.step_moved,false);
  assert.equal(pair(g),old); assert.equal(g.client.writes.length,before);
  assert.match(second.say,/pas d'une vérification de l'envoi par le serveur/);
 }finally{await close();}
});

test("PT-GMAIL-014/b: fresh binding same runtime replays original pair without new journal or event keys",async()=>{
 const {g,h}=await ready(), first=await capture(g,h); assert.equal(first.kind,"PERSISTED");
 const old=pair(g), before=g.client.writes.length, h2=await g.bind();
 assert.notEqual(h2,h);
 const second=await capture(g,h2); assert.equal(second.kind,"PERSISTED",JSON.stringify(second));
 assert.equal(second.writes_sent,0); assert.equal(pair(g),old); assert.equal(g.client.writes.length,before);
 if(first.kind==="PERSISTED"&&second.kind==="PERSISTED") assert.equal(second.final_receipt_id,first.final_receipt_id);
});

test("PT-GMAIL-014/c: same identity changed durable payload holds, first capture remains immutable",async()=>{
 for(const field of ["thread","observed","date","evidence","recipient"]){
  const {g,h}=await ready(); assert.equal((await capture(g,h)).kind,"PERSISTED");
  const old=pair(g), before=g.client.writes.length, e=evidence();
  if(field==="thread") e.message.thread_id="other-thread";
  if(field==="observed") e.observed_at="2030-01-02T12:05:00.000Z";
  if(field==="date") e.message.date="2030-01-02T11:59:00.000Z";
  if(field==="evidence") e.evidence_ref="gmail:changed/ref";
  if(field==="recipient"){
   const contact=synthetic("other-contact");
   putRows(g.map,C,[...rowsOf(g.map,C),{...rowsOf(g.map,C)[0]!,id:contact,properties:{...rowsOf(g.map,C)[0]!.properties,Email:{type:"email",email:"other@example.invalid"}}}]);
   e.message.to=["other@example.invalid"]; e.contact_refs=[contact];
  }
  assert.equal(code(await capture(g,h,e)),"HOLD_DUPLICATE",field);
  assert.equal(pair(g),old,field); assert.equal(g.client.writes.length,before,field);
 }
});

test("PT-GMAIL-014/d: genuinely new message ID stays distinct and creates exactly its own pair",async()=>{
 const {g,h}=await ready(); assert.equal((await capture(g,h)).kind,"PERSISTED");
 const e=evidence(); e.message.message_id="event-two"; e.evidence_ref="gmail:message/event-two";
 const out=await capture(g,h,e); assert.equal(out.kind,"PERSISTED",JSON.stringify(out));
 assert.equal(rowsOf(g.map,I).length,2); assert.equal(rowsOf(g.map,Q).length,2);
 assert.notEqual(propText(rowsOf(g.map,Q)[0]!,"Idempotency Key"),propText(rowsOf(g.map,Q)[1]!,"Idempotency Key"));
 assert.equal(propText(rowsOf(g.map,Q)[0]!,"Verified"),"false"); assert.equal(propText(rowsOf(g.map,Q)[1]!,"Verified"),"false");
});

test("PT-GMAIL-014/e: missing, modified, duplicate or foreign final pair never recreates or overwrites a target",async()=>{
 for(const fault of ["missing","both-missing","modified","duplicate","foreign","upgraded","relation-pagination"]){
  const {g,h}=await ready(); assert.equal((await capture(g,h)).kind,"PERSISTED");
  const receipt=rowsOf(g.map,Q)[0]!;
  if(fault==="missing") putRows(g.map,I,[]);
  if(fault==="both-missing"){putRows(g.map,I,[]);putRows(g.map,Q,[]);}
  if(fault==="relation-pagination"){const interaction=rowsOf(g.map,I)[0]!;putRows(g.map,I,[{...interaction,properties:{...interaction.properties,Contacts:{type:"relation",relation:[{id:CONTACT}],has_more:true}}}]);}
  if(fault==="modified") putRows(g.map,Q,[{...receipt,properties:{...receipt.properties,"Thread ID":rt("changed")}}]);
  if(fault==="duplicate") putRows(g.map,Q,[receipt,{...receipt,id:synthetic("dupe")}]);
  if(fault==="foreign") putRows(g.map,Q,[{...receipt,parent:{type:"data_source_id",data_source_id:synthetic("other")}}]);
  if(fault==="upgraded") putRows(g.map,Q,[{...receipt,properties:{...receipt.properties,Verified:{type:"checkbox",checkbox:true}}}]);
  const old=pair(g), before=g.client.writes.length;
  assert.equal(code(await capture(g,h)),"HOLD_DUPLICATE",fault); assert.equal(pair(g),old); assert.equal(g.client.writes.length,before);
 }
});

test("PT-GMAIL-014/f: replay after schema/source/capability drift or recovery remains held, with zero writes",async()=>{
 for(const fault of ["schema","source","capability","recovery"]){
  const {g,h}=await ready(); assert.equal((await capture(g,h)).kind,"PERSISTED");
  if(fault==="schema") delete (g.map.get(`data_source:${Q}`) as {properties:Record<string,unknown>}).properties["Evidence Ref"];
  if(fault==="source") Object.assign(g.deps,{salesRegistry:new InMemorySalesRuntimeRegistry([...registryEntries(),{...registryEntries()[0]!,rep_identity_key:"other-rep"}])});
  if(fault==="capability") putRows(g.map,P,[]);
  if(fault==="recovery"){const ids=IDS("rep-a");const m=g.map.get(`page:${ids.manifestRow}`) as Page;setRowsIn(g.map,ids.manifestDs,[{...m,properties:{...m.properties,"Recovery Required":{type:"checkbox",checkbox:true}}}]);}
  const old=pair(g), before=g.client.writes.length, out=await capture(g,h);
  assert.equal(out.kind,"HELD",fault+JSON.stringify(out)); assert.equal(pair(g),old); assert.equal(g.client.writes.length,before);
 }
});

test("PT-GMAIL-014/g: partial original capture resumes through its own journal after new binding, never duplicates",async()=>{
 const {g,h}=await ready(); g.client.fault({symbol:"TARGET_0"},"APPLY_THEN_FAIL");
 const first=await capture(g,h); assert.equal(first.kind,"INTERRUPTED",JSON.stringify(first));
 assert.equal(rowsOf(g.map,I).length,1); assert.equal(rowsOf(g.map,Q).length,0);
 g.clock.t+=60_000; const h2=await g.bind(), second=await capture(g,h2);
 assert.equal(second.kind,"PERSISTED",JSON.stringify(second)); assert.equal(rowsOf(g.map,I).length,1); assert.equal(rowsOf(g.map,Q).length,1);
});

test("PT-GMAIL-014/h: pending event journal cannot be recovered by a different event or changed payload",async()=>{
 for(const change of ["event","thread"]){
  const {g,h}=await ready();g.client.fault({symbol:"TARGET_0"},"APPLY_THEN_FAIL");
  assert.equal((await capture(g,h)).kind,"INTERRUPTED");g.clock.t+=60_000;
  const old=pair(g), before=g.client.writes.length,e=evidence();
  if(change==="event") e.message.message_id="other-event";else e.message.thread_id="other-thread";
  const out=await capture(g,h,e);assert.equal(out.kind,"HELD",JSON.stringify(out));
  assert.equal(pair(g),old);assert.equal(g.client.writes.length,before);assert.equal(rowsOf(g.map,Q).length,0);
 }
});

test("PT-GMAIL-014/i: caller mailbox spelling normalizes but separate mailbox identity never reuses existing proof",async()=>{
 const {g,h}=await ready();assert.equal((await capture(g,h)).kind,"PERSISTED");
 const old=pair(g),before=g.client.writes.length,e=evidence();e.source_identity="REP-A@EXAMPLE.INVALID";e.message.from="REP-A@EXAMPLE.INVALID";
 assert.equal((await capture(g,h,e)).kind,"PERSISTED");
 const wrong=evidence();wrong.source_identity="other@example.invalid";wrong.message.from=wrong.source_identity;
 assert.equal(code(await capture(g,h,wrong)),"HOLD_MAILBOX_IDENTITY_MISMATCH");
 assert.equal(pair(g),old);assert.equal(g.client.writes.length,before);
});

test("PT-GMAIL-014/j: mailbox newly bound to same owned runtime is a distinct identity, not the old message claim",async()=>{
 const {g,h}=await ready();assert.equal((await capture(g,h)).kind,"PERSISTED");
 const ids=IDS("rep-a"),m=g.map.get(`page:${ids.manifestRow}`) as Page,source="new-mailbox@example.invalid";
 setRowsIn(g.map,ids.manifestDs,[{...m,properties:{...m.properties,"Gmail Identity":{type:"email",email:source}}}]);
 Object.assign(g.deps,{salesRegistry:new InMemorySalesRuntimeRegistry(registryEntries().map(r=>r.rep_identity_key==="rep-a"?{...r,expected_gmail_identity:source}:r))});
 const h2=await g.bind(),e=evidence();e.source_identity=source;e.message.from=source;
 const out=await capture(g,h2,e);assert.equal(out.kind,"PERSISTED",JSON.stringify(out));
 assert.equal(rowsOf(g.map,I).length,2);assert.equal(rowsOf(g.map,Q).length,2);
 assert.notEqual(propText(rowsOf(g.map,Q)[0]!,"Idempotency Key"),propText(rowsOf(g.map,Q)[1]!,"Idempotency Key"));
 assert.equal(propText(rowsOf(g.map,Q)[0]!,"Source Identity"),"rep-a@example.invalid");
 assert.equal(propText(rowsOf(g.map,Q)[1]!,"Source Identity"),source);
});

test("PT-GMAIL-014/k: complete pair without original backend journal is not a replay receipt",async()=>{
 const original=await ready();assert.equal((await capture(original.g,original.h)).kind,"PERSISTED");
 const {g,h}=await ready();putRows(g.map,I,rowsOf(original.g.map,I));putRows(g.map,Q,rowsOf(original.g.map,Q));
 const before=g.client.writes.length,old=pair(g);
 assert.equal(code(await capture(g,h)),"HOLD_DUPLICATE");assert.equal(g.client.writes.length,before);assert.equal(pair(g),old);
});

test("PT-GMAIL-014/l: expired or superseded partial journal cannot mint a new capture plan",async()=>{
 for(const state of ["EXPIRED","SUPERSEDED"] as const){
  const {g,h}=await ready();g.client.fault({symbol:"TARGET_0"},"APPLY_THEN_FAIL");
  assert.equal((await capture(g,h)).kind,"INTERRUPTED");g.clock.t+=60_000;
  const bound=await bindLive(h,{principal_id:OWNER.principal_id,now:new Date(g.clock.t)},g.deps);assert.ok(bound.ok);if(!bound.ok)return;
  const active=await g.deps.store.plans.findActive(bound.binding.project,bound.binding.lane,bound.binding.runtime_generation),plan=active[0]!;
  const {transition}=await import("../../src/plans/service.ts");await transition(g.deps.store,plan.plan_id,state,new Date(g.clock.t));
  const old=pair(g),before=g.client.writes.length,count=(await g.deps.store.plans.listByRuntime(bound.binding.project,bound.binding.lane,bound.binding.runtime_generation)).length;
  assert.equal(code(await capture(g,h)),"HOLD_DUPLICATE");assert.equal(pair(g),old);assert.equal(g.client.writes.length,before);
  assert.equal((await g.deps.store.plans.listByRuntime(bound.binding.project,bound.binding.lane,bound.binding.runtime_generation)).length,count);
 }
});

test("PT-GMAIL-014/m: opening recovery HOLD leaves original recoverable; second retry never creates a duplicate",async()=>{
 const {g,h}=await ready();g.client.fault({symbol:"TARGET_0"},"APPLY_THEN_FAIL");
 assert.equal((await capture(g,h)).kind,"INTERRUPTED");g.clock.t+=60_000;const h2=await g.bind();
 const runs=rowsOf(g.map,R.salesRunsDs),ownedRun=runs.find(r=>propText(r,"Harness Plan ID"));assert.ok(ownedRun);
 putRows(g.map,R.salesRunsDs,[...runs,{...ownedRun,id:synthetic("ambiguous-original-run")}]);
 const old=pair(g),before=g.client.writes.length;
 const first=await capture(g,h2),second=await capture(g,h2);
 assert.equal(first.kind,"HELD",JSON.stringify(first));assert.equal(second.kind,"HELD",JSON.stringify(second));
 assert.equal(g.client.writes.length,before);assert.equal(pair(g),old);assert.equal(rowsOf(g.map,I).length,1);assert.equal(rowsOf(g.map,Q).length,0);
 putRows(g.map,R.salesRunsDs,runs);
 assert.equal((await capture(g,h2)).kind,"PERSISTED","repairing ambiguity can still recover the original");
 assert.equal(rowsOf(g.map,I).length,1);assert.equal(rowsOf(g.map,Q).length,1);
});

test("PT-GMAIL-014/n: settled target missing in non-final journal is never recreated",async()=>{
 const {g,h}=await ready();g.client.fault({symbol:"TARGET_1"},"APPLY_THEN_FAIL");
 assert.equal((await capture(g,h)).kind,"INTERRUPTED");g.clock.t+=60_000;putRows(g.map,I,[]);
 const old=pair(g),before=g.client.writes.length;
 assert.equal(code(await capture(g,h)),"HOLD_DUPLICATE");assert.equal(g.client.writes.length,before);assert.equal(pair(g),old);
 const bound=await bindLive(h,{principal_id:OWNER.principal_id,now:new Date(g.clock.t)},g.deps);assert.ok(bound.ok);if(!bound.ok)return;
 const beforePlans=await g.deps.store.plans.listByRuntime(bound.binding.project,bound.binding.lane,bound.binding.runtime_generation),state=beforePlans.map(p=>[p.plan_id,p.plan_state]);
 const bare=await g.commit(h,{});assert.equal(code(bare),"HOLD_DUPLICATE");assert.equal(g.client.writes.length,before);
 const h2=await g.bind(),rebound=await g.commit(h2,{});assert.equal(code(rebound),"HOLD_DUPLICATE");
 assert.equal(g.client.writes.length,before);assert.equal(rowsOf(g.map,I).length,0);
 assert.deepEqual((await g.deps.store.plans.listByRuntime(bound.binding.project,bound.binding.lane,bound.binding.runtime_generation)).map(p=>[p.plan_id,p.plan_state]),state);
});
