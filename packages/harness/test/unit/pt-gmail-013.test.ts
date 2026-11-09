/** W4.4: honest caller provenance and native receipt-linked resume, local synthetic MCP only. */
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

test("PT-GMAIL-013/a: native os_commit says Notion recording, not server verification of Gmail; protected INTENT stays unchanged", async () => {
 const {g,h}=await ready(), e=addIntent(g), before=JSON.stringify(rowsOf(g.map,R.salesExtDs));
 const {client,close}=await mcp(g);
 try {
  const out=unpack(await client.callTool({name:"os_commit",arguments:{binding_handle:h,external_event_evidence:e}}));
  assert.equal(out.kind,"PERSISTED",JSON.stringify(out)); assert.equal(out.step_moved,false);
  assert.match(out.say,/capture de l'envoi est enregistrée et relue dans Notion/);
  assert.match(out.say,/pas d'une vérification de l'envoi par le serveur/);
  assert.doesNotMatch(out.say,/envoi (est |a été )?vérifié|PRIVATE|@|EXTERNAL_EVENT|ATTESTED_SENT/);
  assert.equal(propText(rowsOf(g.map,Q)[0]!,"Verified"),"false");
  assert.equal(propText(rowsOf(g.map,Q)[0]!,"Provenance"),"SOURCE_ATTESTED_BY_NATIVE_READ");
  assert.equal(JSON.stringify(rowsOf(g.map,R.salesExtDs)),before);
 } finally {await close();}
});

test("PT-GMAIL-013/b: fresh real MCP resume projects the paired native receipt without upgrading competent-source proof or offering a resend",async()=>{
 const {g,h}=await ready(), e=addIntent(g); assert.equal((await g.commit(h,{external_event_evidence:e})).kind,"PERSISTED");
 const before=g.client.writes.length, oldIntent=JSON.stringify(rowsOf(g.map,R.salesExtDs));
 const {client,close}=await mcp(g);
 try {
  const out=unpack(await client.callTool({name:"os_resume",arguments:{binding_handle:h,topic_hint:"SALES_EXTERNAL_ACTION"}}));
  assert.equal(out.status,"OK",JSON.stringify(out).slice(0,1400));
  const row=out.result.external_actions.unresolved[0];
  assert.equal(row.native_reconciliation.status,"ATTESTED_SENT"); assert.equal(row.native_reconciliation.verified,false);
  assert.equal(row.native_reconciliation.receipt_ref,rowsOf(g.map,Q)[0]!.id);
  assert.equal(row.native_reconciliation.interaction_ref,rowsOf(g.map,I)[0]!.id);
  assert.equal(row.reconciliation.status,"NOT_RECONCILED","caller proof is not competent-source OBSERVED");
  assert.equal(row.effect_status,"PREPARED");
  assert.match(out.say,/ce reçu n'est pas une preuve de vérification de l'envoi par le serveur/); assert.match(out.next.conduct,/Do not resend/);
  assert.doesNotMatch(out.say,/PRIVATE|@|EXTERNAL_EVENT|ATTESTED_SENT/);
  assert.equal(g.client.writes.length,before,"resume read-only"); assert.equal(JSON.stringify(rowsOf(g.map,R.salesExtDs)),oldIntent);
 } finally {await close();}
});

test("PT-GMAIL-013/c: partial, foreign, duplicate, inconsistent or upgraded pairs never produce native terminal evidence",async()=>{
 for(const fault of ["missing","foreign","duplicate","key","source","verified","status","account","pagination","relation-pagination","contact-duplicate"]){
  const {g,h}=await ready(), e=addIntent(g); assert.equal((await g.commit(h,{external_event_evidence:e})).kind,"PERSISTED");
  const receipt=rowsOf(g.map,Q)[0]!, interaction=rowsOf(g.map,I)[0]!;
  if(fault==="missing") putRows(g.map,I,[]);
  if(fault==="foreign") putRows(g.map,Q,[{...receipt,parent:{type:"data_source_id",data_source_id:synthetic("foreign")}}]);
  if(fault==="duplicate") putRows(g.map,Q,[receipt,{...receipt,id:synthetic("duplicate-native")}]);
  if(fault==="key") putRows(g.map,I,[{...interaction,properties:{...interaction.properties,"Receipt Key":rt("wrong")}}]);
  if(fault==="source") putRows(g.map,Q,[{...receipt,properties:{...receipt.properties,"Source Identity":rt("other@example.invalid")}}]);
  if(fault==="verified") putRows(g.map,Q,[{...receipt,properties:{...receipt.properties,Verified:{type:"checkbox",checkbox:true}}}]);
  if(fault==="status") putRows(g.map,Q,[{...receipt,properties:{...receipt.properties,"Effect Status":{type:"select",select:{name:"OBSERVED"}}}}]);
  if(fault==="account") g.map.set(`page:${ACCOUNT}`,{...g.map.get(`page:${ACCOUNT}`) as Page,parent:{type:"data_source_id",data_source_id:synthetic("foreign")}});
  if(fault==="pagination") g.intercept(Q,(original)=>({...original as object,has_more:true}));
  if(fault==="relation-pagination") putRows(g.map,I,[{...interaction,properties:{...interaction.properties,Contacts:{...interaction.properties.Contacts!,has_more:true}}}]);
  if(fault==="contact-duplicate") {const p=rowsOf(g.map,C)[0]!;putRows(g.map,C,[p,{...p,id:synthetic("duplicate-contact-email")}]);}
  const {client,close}=await mcp(g), before=g.client.writes.length;
  try{
   const out=unpack(await client.callTool({name:"os_resume",arguments:{binding_handle:h}}));
   assert.equal(out.status,"HOLD",fault); assert.equal(out.code,"HOLD_RECOVERY_REQUIRED",fault);
   const row=out.observations?.external_actions?.unresolved?.[0];
   assert.ok(row,fault+" resume must retain unresolved intent"); assert.equal(row.native_reconciliation,undefined,fault);
   assert.doesNotMatch(out.say,/capture de l'envoi est déjà enregistrée/,fault);
   assert.equal(g.client.writes.length,before,fault);
  }finally{await close();}
 }
});

test("PT-GMAIL-013/e: capture reconciles only its exact sole pending intent, never another unresolved intent or unlinked send",async()=>{
 for(const fault of ["second-intent","unlinked","fresh-drift"]){
  const {g,h}=await ready(), e=addIntent(g);
  if(fault==="second-intent"){
   const p=rowsOf(g.map,R.salesExtDs)[0]!;
   putRows(g.map,R.salesExtDs,[p,{...p,id:synthetic("other-pending"),properties:{...p.properties,"Action Key":rt("other-action")}}]);
  }else if(fault==="unlinked") delete (e as {intent_ref?:string}).intent_ref;
  else g.intercept(R.salesExtDs,(original)=>({...original as {results:Page[]},results:(original as {results:Page[]}).results.map(p=>({...p,properties:{...p.properties,"Action Key":rt("changed-after-factory")}}))}));
  const before=g.client.writes.length, {client,close}=await mcp(g);
  try{
   const out=unpack(await client.callTool({name:"os_commit",arguments:{binding_handle:h,external_event_evidence:e}}));
   assert.equal(out.kind,"HELD",fault); assert.equal(out.code,"HOLD_RECOVERY_REQUIRED",fault);
   assert.equal(out.wrote_anything,false); assert.equal(g.client.writes.length,before);
   assert.equal(rowsOf(g.map,Q).length,0); assert.equal(rowsOf(g.map,I).length,0);
  }finally{await close();}
 }
});

test("PT-GMAIL-013/f: native admission preserves Manifest recovery, cursor blockers and required capabilities",async()=>{
 for(const fault of ["manifest-recovery","cursor-blocker","capability"]){
  const {g,h}=await ready(), e=addIntent(g), ids=IDS("rep-a");
  if(fault==="manifest-recovery"){
   const p=g.map.get(`page:${ids.manifestRow}`) as Page;
   setRowsIn(g.map,ids.manifestDs,[{...p,properties:{...p.properties,"Recovery Required":{type:"checkbox",checkbox:true}}}]);
  }else if(fault==="cursor-blocker"){
   const p=rowsOf(g.map,R.salesStateDs)[0]!;
   putRows(g.map,R.salesStateDs,[{...p,properties:{...p.properties,"Open Blocker":rt("owner-declared-blocker")}}]);
  }else putRows(g.map,P,[]);
  const before=g.client.writes.length,{client,close}=await mcp(g);
  try{
   const out=unpack(await client.callTool({name:"os_commit",arguments:{binding_handle:h,external_event_evidence:e}}));
   assert.equal(out.kind,"HELD",fault+JSON.stringify(out));
   assert.equal(out.code,fault==="manifest-recovery"?"HOLD_RECOVERY_REQUIRED":fault==="capability"?"HOLD_REQUIRED_CAPABILITY_INCOMPLETE":"HOLD_UNKNOWN_REQUIRED_FACT",fault);
   assert.equal(out.wrote_anything,false); assert.equal(g.client.writes.length,before);
   assert.equal(rowsOf(g.map,Q).length,0); assert.equal(rowsOf(g.map,I).length,0);
  }finally{await close();}
 }
});

test("PT-GMAIL-013/g: a serialized copy of the factory intent cannot admit its pending recovery",async()=>{
 const {g,h}=await ready(), e=addIntent(g);
 const live=await bindLive(h,{principal_id:OWNER.principal_id,now:NOW},g.deps); assert.equal(live.ok,true);
 if(!live.ok)return;
 const derived=await deriveExternalEvent(g.deps,live.binding,live.runtime,e); assert.equal(derived.kind,"READY");
 if(derived.kind!=="READY")return;
 const before=g.client.writes.length, {client,close}=await mcp(g);
 try{
  const out=unpack(await client.callTool({name:"os_commit",arguments:{binding_handle:h,intent:JSON.parse(JSON.stringify(derived.intent))}}));
  assert.equal(out.kind,"HELD"); assert.equal(out.code,"HOLD_ACTION_NOT_AUTHORIZED");
  assert.equal(out.wrote_anything,false); assert.equal(g.client.writes.length,before);
 }finally{await close();}
});

test("PT-GMAIL-013/h: native capture cannot leapfrog a foreign edit on another proved business object",async()=>{
 const classes: ClassEntry[]=[[INTERACTIONS,EXTERNAL_INTERACTION_PROPERTIES],[RECEIPTS,EXTERNAL_RECEIPT_PROPERTIES]].map(([resource_key,fields])=>({class:"RECONCILE_AS_IS",resource_key:resource_key as string,operation:"CREATE",allowed_fields:Object.keys(fields!)}));
 const {g,h}=await ready([...classes,{...CLASSES.b0Answer,allowed_fields:[...CLASSES.b0Answer.allowed_fields]},CLASSES.cursor()]);
 assert.equal((await g.commit(h,b0Intent())).kind,"PERSISTED");
 const config=rowsOf(g.map,G.configDs)[0]!;
 putRows(g.map,G.configDs,[{...config,properties:{...config.properties,Value:rt("foreign-edit")}}]);
 const e=addIntent(g); e.message.message_id="event-two";
 const before=g.client.writes.length,{client,close}=await mcp(g);
 try{
  const out=unpack(await client.callTool({name:"os_commit",arguments:{binding_handle:h,external_event_evidence:e}}));
  assert.equal(out.kind,"HELD",JSON.stringify(out)); assert.equal(out.wrote_anything,false);
  assert.equal(g.client.writes.length,before); assert.equal(rowsOf(g.map,I).length,0); assert.equal(rowsOf(g.map,Q).length,0);
 }finally{await close();}
});

test("PT-GMAIL-013/i: competent-source matches stay separate; contradictory reads HOLD without erasing native bookkeeping",async()=>{
 for(const fault of ["same","different","ambiguous","identity","unavailable","absent"]){
 const {g,h}=await ready(), e=addIntent(g); assert.equal((await g.commit(h,{external_event_evidence:e})).kind,"PERSISTED");
 const message={message_id:fault==="different"?"server-message":"event-one",thread_id:"thread-one",from:e.message.from,to:e.message.to,date:e.message.date,subject:"PRIVATE-INTENT-CONTENT native-action"};
 const competentSource=new SnapshotCompetentSource(fault==="identity"?"wrong@example.invalid":"rep-a@example.invalid",fault==="absent"?[]:fault==="ambiguous"?[message,{...message,message_id:"second-send"}]:[message],fault!=="unavailable");
 const before=g.client.writes.length,{client,close}=await mcp(g,{competentSource});
 try{
  const out=unpack(await client.callTool({name:"os_resume",arguments:{binding_handle:h}}));
  const conflict=["different","ambiguous","identity"].includes(fault);
  assert.equal(out.status,conflict?"HOLD":"OK",fault);
  if(conflict)assert.equal(out.code,fault==="identity"?"HOLD_MAILBOX_IDENTITY_MISMATCH":"HOLD_EXTERNAL_EFFECT_AMBIGUOUS",fault);
  const row=(out.result??out.observations).external_actions.unresolved[0];
  assert.equal(row.reconciliation.status,fault==="identity"?"IDENTITY_MISMATCH":fault==="unavailable"?"UNAVAILABLE":fault==="absent"?"NOT_OBSERVED":fault==="ambiguous"?"AMBIGUOUS":"OBSERVED",fault);
  assert.equal(row.native_reconciliation.status,"ATTESTED_SENT");
  assert.equal(row.native_reconciliation.verified,false); assert.equal(row.effect_status,"PREPARED");
  assert.equal(propText(rowsOf(g.map,Q)[0]!,"Verified"),"false"); assert.equal(g.client.writes.length,before);
  if(!conflict)assert.match(out.say,/ce reçu n'est pas une preuve de vérification de l'envoi par le serveur/);
  else{
   const nextEvidence={...evidence(),message:{...evidence().message,message_id:"another-event"}};
   const blocked=unpack(await client.callTool({name:"os_commit",arguments:{binding_handle:h,external_event_evidence:nextEvidence}}));
   assert.equal(blocked.kind,"HELD",fault);assert.equal(blocked.wrote_anything,false);assert.equal(g.client.writes.length,before);
  }
 }finally{await close();}
 }
});

test("PT-GMAIL-013/j: unfinished ledger work and divergent Runs are not native-capture remediations",async()=>{
 for(const fault of ["ledger","run-divergence"]){
  const {g,h}=await ready(),e=addIntent(g);
  if(fault==="ledger") putRows(g.map,R.salesLedgerDs,[ledgerRow(synthetic("unfinished-ledger"),"SMUT-2","PREPARED",R.salesRun1)]);
  else putRows(g.map,R.salesRunsDs,[...rowsOf(g.map,R.salesRunsDs),runPage({id:synthetic("unowned-incomplete"),label:"SRUN-2",status:"HOLD",lane:"SALES",lastEdited:NOW.toISOString()})]);
  const before=g.client.writes.length,{client,close}=await mcp(g);
  try{
   const out=unpack(await client.callTool({name:"os_commit",arguments:{binding_handle:h,external_event_evidence:e}}));
   assert.equal(out.kind,"HELD",fault+JSON.stringify(out));
   assert.equal(out.code,fault==="ledger"?"HOLD_RECOVERY_REQUIRED":"HOLD_STATE_DIVERGENCE",fault);
   assert.equal(out.wrote_anything,false); assert.equal(g.client.writes.length,before);
  }finally{await close();}
 }
});

test("PT-GMAIL-013/k: sole external HOLD serves bounded native capture guidance, other holds do not",async()=>{
 for(const fault of ["sole","ledger","capability"]){
  const {g,h}=await ready();addIntent(g);
  if(fault==="ledger")putRows(g.map,R.salesLedgerDs,[ledgerRow(synthetic("guidance-ledger"),"SMUT-2","PREPARED",R.salesRun1)]);
  if(fault==="capability")putRows(g.map,P,[]);
  const {client,close}=await mcp(g),before=g.client.writes.length;
  try{
   const out=unpack(await client.callTool({name:"os_resume",arguments:{binding_handle:h,topic_hint:"SALES_EMAIL_RECONCILIATION"}}));
   assert.equal(out.status,"HOLD"); assert.equal(out.code,"HOLD_RECOVERY_REQUIRED");
   if(fault==="sole"){
    assert.match(out.next.conduct,/external_event_evidence/,JSON.stringify({flag:out.observations?.native_capture_pending_ref,cap:out.observations?.capability_completeness?.complete,open:out.observations?.open_backend_plan,pointers:out.observations?.contract_pack?.selected_pointers,versions:out.versions}));assert.match(out.next.conduct,/read\/search only/);
    assert.match(out.next.conduct,/all other holds still apply/);assert.doesNotMatch(out.next.conduct,/a hold ends the turn/);
   }else assert.doesNotMatch(out.next.conduct,/external_event_evidence/);
   assert.equal(g.client.writes.length,before);
  }finally{await close();}
 }
});

test("PT-GMAIL-013/d: unlinked native capture already receives honest MCP wording, never a claim of server-verified Gmail",async()=>{
 const {g,h}=await ready(), {client,close}=await mcp(g);
 try {
  const out=unpack(await client.callTool({name:"os_commit",arguments:{binding_handle:h,external_event_evidence:evidence()}}));
  assert.equal(out.kind,"PERSISTED",JSON.stringify(out));
  assert.match(out.say,/capture de l'envoi est enregistrée et relue dans Notion/);
  assert.match(out.say,/pas d'une vérification de l'envoi par le serveur/);
  assert.equal(propText(rowsOf(g.map,Q)[0]!,"Verified"),"false");
  assert.equal(out.step_moved,false); assert.equal(out.derived_move,"NONE");
 }finally{await close();}
});
