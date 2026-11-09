/** W4.6 E1–E11 normative candidate oracles. All fixtures synthetic, no live/external effects. */
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

import { routeExternalAction, reconcileManualSends, classifyInbound, type MailboxMessage } from "../../src/effects/gmail.ts";
import { intentViewFromPlan } from "../../src/effects/adapter.ts";
import { dispatch, resolveRuntimeFor } from "../../src/tools/handlers.ts";
import { buildResumeWorld } from "./resume-fixtures.ts";
import { handleOf } from "./binding-fixtures.ts";
import { transact as nativeTransact } from "../support/transact.ts";
function addIntent(g: ReturnType<typeof world>) {
 const p = { object: "page", id: INTENT, archived: false, properties: {
  Action: { type: "title", title: [text("Synthetic send")] }, "Record Type": { type: "select", select: { name: "INTENT" } },
  "Action Type": { type: "select", select: { name: "GMAIL_SEND" } }, "Effect Status": { type: "select", select: { name: "PREPARED" } },
  "Approval State": { type: "select", select: { name: "APPROVED" } }, "Action Key": rt("native-action"),
  Recipient: { type: "email", email: "prospect@example.invalid" }, "Prepared At": { type: "date", date: { start: "2030-01-02T10:00:00.000Z" } },
  "Contact Ref": rt(CONTACT), "Account Ref": rt(ACCOUNT), "Subject / Content Hash": rt("PRIVATE-INTENT-CONTENT"),
 } } as Page;
 putRows(g.map, R.salesExtDs, [p]);
 return { ...evidence(), intent_ref: INTENT, message: { ...evidence().message, action_key: "native-action" } };
}


const MAILBOX="rep-a@example.invalid",RECIPIENT="prospect@example.invalid";
const code=(out:Awaited<ReturnType<ReturnType<typeof world>["commit"]>>)=>out.kind==="HELD"?out.code:out.kind;
const capture=(g:ReturnType<typeof world>,h:string,e=evidence())=>g.commit(h,{external_event_evidence:e});
async function resume(g:ReturnType<typeof world>,h:string,source?:SnapshotCompetentSource){
 const {client,close}=await mcp(g,source?{competentSource:source}:{});
 try{return unpack(await client.callTool({name:"os_resume",arguments:{binding_handle:h,topic_hint:"SALES_EMAIL_RECONCILIATION"}}));}finally{await close();}
}
async function verifiedIntent(){
 // Existing competent-reader effect plane is intentionally unchanged by GW4.3R.
 const w=buildResumeWorld(),ctx={principal_id:OWNER.principal_id,now:new Date("2030-01-03T00:29:00Z")},verifyCtx={...ctx,now:new Date("2030-01-03T00:33:00Z")};
 const actionSchema=w.map.get(`data_source:${R.salesExtDs}`) as {properties:Record<string,unknown>};
 actionSchema.properties["Thread ID / Context"]={type:"rich_text"}; // Existing effect-plane property, absent from the minimal fixture.
 const h=handleOf(await dispatch("os_bind",{project:"VERTIGO",lane:"SALES"},ctx,w.deps));
 const {plan,receipt:rid}=await nativeTransact(w,h,{action_class:"COMMIT",summary:"synthetic outreach",mutations:[{logical_resource_key:"SALES:EXTERNAL_ACTIONS",operation:"CREATE",record_selector:{natural_key:"e2e-action"},desired_changes:{Recipient:RECIPIENT,"Subject / Content Hash":"Hello e2e-action","Action Type":"GMAIL_SEND","Thread ID / Context":"thread-one"}}]},
 {ctx,verifyCtx,stamps:{stage1:"2030-01-03T00:30:00Z",fin:"2030-01-03T00:31:00Z",state:"2030-01-03T00:32:00Z"}});
 const principal=(await w.deps.principals.get(OWNER.principal_id))!,r=await resolveRuntimeFor(w.deps,principal,"VERTIGO","SALES");assert.equal(r.kind,"RESOLVED");if(r.kind!=="RESOLVED")throw Error("fixture runtime");
 const finalPlan=(await w.deps.store.plans.get(plan.plan_id))!,receipt=(await w.deps.store.receipts.get(rid))!,intent=intentViewFromPlan(r.runtime,finalPlan,receipt)!;
 assert.equal(intent.thread_ref,"thread-one");
 return {w,plan:finalPlan,intent};
}
const inbound=(date:string,over:Partial<MailboxMessage>={}):MailboxMessage=>({message_id:"human-inbound",thread_id:"thread-one",from:RECIPIENT,to:[MAILBOX],subject:"Re: Hello",date,...over});

test("PT-GMAIL-015/E1: PREPARED native event persists a complete paired terminal projection, INTENT unchanged",async()=>{
 const {g,h}=await ready(),e=addIntent(g),old=JSON.stringify(rowsOf(g.map,R.salesExtDs));
 const out=await capture(g,h,e);assert.equal(out.kind,"PERSISTED",JSON.stringify(out));assert.equal(out.step_moved,false);
 assert.equal(rowsOf(g.map,I).length,1);assert.equal(rowsOf(g.map,Q).length,1);
 assert.equal(propText(rowsOf(g.map,Q)[0]!,"Effect Status"),"ATTESTED_SENT");assert.equal(propText(rowsOf(g.map,Q)[0]!,"Source Identity"),MAILBOX);
 const r=await resume(g,h);assert.equal(r.status,"OK",JSON.stringify(r));
 assert.equal(r.result.external_actions.unresolved[0].native_reconciliation.status,"ATTESTED_SENT");
 assert.equal(r.result.external_actions.unresolved[0].reconciliation.status,"NOT_RECONCILED");
 assert.equal(JSON.stringify(rowsOf(g.map,R.salesExtDs)),old);
});
test("PT-GMAIL-015/E2: empty competent bounded read is NOT_OBSERVED readonly, not a one-event caller proof",async()=>{
 const {g,h}=await ready();addIntent(g);const before=g.client.writes.length;
 const r=await resume(g,h,new SnapshotCompetentSource(MAILBOX,[]));
 assert.equal(r.observations.external_actions.unresolved[0].reconciliation.status,"NOT_OBSERVED");
 assert.equal(rowsOf(g.map,I).length,0);assert.equal(rowsOf(g.map,Q).length,0);assert.equal(g.client.writes.length,before);
});
test("PT-GMAIL-015/E3: different source mailbox refuses all business writes",async()=>{
 const {g,h}=await ready(),e=evidence();e.source_identity="foreign@example.invalid";e.message.from=e.source_identity;
 assert.equal(code(await capture(g,h,e)),"HOLD_MAILBOX_IDENTITY_MISMATCH");assert.equal(g.client.writes.length,0);
});
test("PT-GMAIL-015/E4: exact replay new binding uses same event key/pair and receipts, no second effect",async()=>{
 const {g,h}=await ready(),first=await capture(g,h);assert.equal(first.kind,"PERSISTED");const before=g.client.writes.length;
 const second=await capture(g,await g.bind());assert.equal(second.kind,"PERSISTED",JSON.stringify(second));
 assert.equal(rowsOf(g.map,I).length,1);assert.equal(rowsOf(g.map,Q).length,1);assert.equal(propText(rowsOf(g.map,Q)[0]!,"Idempotency Key"),key);
 assert.equal(g.client.writes.length,before);if(first.kind==="PERSISTED"&&second.kind==="PERSISTED")assert.equal(second.final_receipt_id,first.final_receipt_id);
});
test("PT-GMAIL-015/E5: unlinked outbound creates one Interaction and operational Receipt, no ExternalActions Receipt",async()=>{
 const {g,h}=await ready(),old=JSON.stringify(rowsOf(g.map,R.salesExtDs));assert.equal((await capture(g,h)).kind,"PERSISTED");
 assert.equal(rowsOf(g.map,I).length,1);assert.equal(rowsOf(g.map,Q).length,1);assert.equal(propText(rowsOf(g.map,Q)[0]!,"Intent Ref"),"");
 assert.equal(JSON.stringify(rowsOf(g.map,R.salesExtDs)),old);
});
test("PT-GMAIL-015/E6: same message ID in another owned mailbox produces another identity and local pair",async()=>{
 const first=await ready();assert.equal((await capture(first.g,first.h)).kind,"PERSISTED");const source="second-owned@example.invalid";
 const g=world(),ids=IDS("rep-a"),m=g.map.get(`page:${ids.manifestRow}`) as Page;
 setRowsIn(g.map,ids.manifestDs,[{...m,properties:{...m.properties,"Gmail Identity":{type:"email",email:source}}}]);
 Object.assign(g.deps,{salesRegistry:new InMemorySalesRuntimeRegistry(registryEntries().map(r=>r.rep_identity_key==="rep-a"?{...r,expected_gmail_identity:source}:r))});
 const h=await g.bind();await g.approve();const e=evidence();e.source_identity=source;e.message.from=source;
 const decision=await reconcileManualSends(new SnapshotCompetentSource(source,[e.message as MailboxMessage]),source,RECIPIENT,{since:"2030-01-02T00:00:00Z",until:"2030-01-03T00:00:00Z"},[],new Set([key]));
 assert.equal(decision.candidates[0]!.disposition,"MATERIALIZE_ONCE");assert.notEqual(decision.candidates[0]!.external_identity_key,key);
 assert.equal((await capture(g,h,e)).kind,"PERSISTED");assert.equal(rowsOf(g.map,I).length,1);assert.equal(rowsOf(g.map,Q).length,1);
 assert.notEqual(propText(rowsOf(g.map,Q)[0]!,"Idempotency Key"),key);assert.equal(propText(rowsOf(g.map,Q)[0]!,"Source Identity"),source);
});
test("PT-GMAIL-015/E7: human inbound after prepare blocks dispatch, including equivalent instants with offsets",async()=>{
 const {w,plan,intent}=await verifiedIntent(),old=JSON.stringify(rowsOf(w.map,R.salesExtDs));
 for(const date of ["2030-01-03T01:00:00Z","2030-01-02T21:00:00-04:00"]){
  const out=await routeExternalAction(w.deps.store.receipts,{plan,intent,requested_action_key:intent.action_key,requested_intent_ref:intent.intent_ref,runtime_generation:plan.runtime_generation,
   mode:"EXTERNAL_ACTION_TEST",approved_test_scope:{from:MAILBOX,to:[RECIPIENT]},source:new SnapshotCompetentSource(MAILBOX,[inbound(date)])});
  assert.equal(out.kind,"HOLD",date+JSON.stringify(out));if(out.kind==="HOLD")assert.equal(out.code,"HOLD_INBOUND_BEFORE_DISPATCH");
 }
 assert.equal(JSON.stringify(rowsOf(w.map,R.salesExtDs)),old);
 const {g,h}=await ready(),e=evidence();e.message.from=RECIPIENT;e.message.to=[MAILBOX];
 assert.equal(code(await capture(g,h,e)),"HOLD_MAILBOX_IDENTITY_MISMATCH");assert.equal(g.client.writes.length,0);
});
test("PT-GMAIL-015/E8: auto reply, OOO and bounce remain TECHNICAL, no human takeover or intent change",async()=>{
 const {w,plan,intent}=await verifiedIntent(),old=JSON.stringify(rowsOf(w.map,R.salesExtDs));
 for(const [classification,over] of [["AUTO_REPLY",{headers:{"Auto-Submitted":"auto-replied"}}],["OOO",{subject:"Out of office"}],["BOUNCE",{from:"mailer-daemon@example.invalid",subject:"Delivery status notification"}]] as const){
  const message=inbound("2030-01-03T01:00:00Z",over);assert.deepEqual([classifyInbound(message,RECIPIENT).kind,classifyInbound(message,RECIPIENT).classification,classifyInbound(message,RECIPIENT).human_takeover],["TECHNICAL",classification,false]);
  const out=await routeExternalAction(w.deps.store.receipts,{plan,intent,requested_action_key:intent.action_key,requested_intent_ref:intent.intent_ref,runtime_generation:plan.runtime_generation,
   mode:"EXTERNAL_ACTION_TEST",approved_test_scope:{from:MAILBOX,to:[RECIPIENT]},source:new SnapshotCompetentSource(MAILBOX,[message])});
  assert.equal(out.kind,"ROUTED",JSON.stringify(out));if(out.kind==="ROUTED")assert.equal(out.inbound[0]!.classification.kind,"TECHNICAL");
 }
 assert.equal(JSON.stringify(rowsOf(w.map,R.salesExtDs)),old);
});
test("PT-GMAIL-015/E9: native create/replay/resume never sets Verified=true or OBSERVED",async()=>{
 const {g,h}=await ready(),e=addIntent(g);assert.equal((await capture(g,h,e)).kind,"PERSISTED");assert.equal((await capture(g,await g.bind(),e)).kind,"PERSISTED");
 const r=await resume(g,await g.bind());assert.equal(r.status,"OK");
 assert.equal(propText(rowsOf(g.map,Q)[0]!,"Verified"),"false");assert.equal(propText(rowsOf(g.map,Q)[0]!,"Effect Status"),"ATTESTED_SENT");
 assert.equal(propText(rowsOf(g.map,R.salesExtDs)[0]!,"Effect Status"),"PREPARED");assert.equal(r.result.external_actions.unresolved[0].native_reconciliation.verified,false);
 assert.doesNotMatch(r.say,/envoi.*vérifié/);
});
test("PT-GMAIL-015/E10: missing canonical ATTESTED_SENT enum refuses without silent migration",async()=>{
 const {g,h}=await ready(),s=g.map.get(`data_source:${Q}`) as {properties:Record<string,{select?:{options:Array<{name:string}>}}>};
 s.properties["Effect Status"]!.select!.options=s.properties["Effect Status"]!.select!.options.filter(o=>o.name!=="ATTESTED_SENT");
 assert.equal(code(await capture(g,h)),"HOLD_SCHEMA_MISMATCH");assert.equal(g.client.writes.length,0);assert.equal(rowsOf(g.map,Q).length,0);
});
test("PT-GMAIL-015/E11: inbound/spoofed claimed sender is not owned by bound source, zero writes",async()=>{
 const {g,h}=await ready(),e=evidence();e.message.from="intruder@example.invalid";
 assert.equal(code(await capture(g,h,e)),"HOLD_MAILBOX_IDENTITY_MISMATCH");assert.equal(g.client.writes.length,0);assert.equal(rowsOf(g.map,I).length,0);assert.equal(rowsOf(g.map,Q).length,0);
});
