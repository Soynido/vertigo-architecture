import assert from "node:assert/strict";
import {test} from "node:test";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import {createServer} from "../../src/index.ts";
import {dispatch,dispatchCommit} from "../../src/tools/handlers.ts";
import {buildWorld,T0} from "./binding-fixtures.ts";
import {REP_A,SGRAMMAR} from "./sales-fixtures.ts";
import {synthetic,text} from "./meta-fixtures.ts";
import {salesContractAdapter} from "../../src/versions/adapters/sales.ts";
import {InMemorySalesRuntimeRegistry,type SalesRuntimeEntry} from "../../src/registry/salesRuntimes.ts";
import type {NotionReadClient} from "../../src/notion/readClient.ts";

const root=synthetic("legacy-read-root"),boot=synthetic("legacy-read-boot"),setup=synthetic("legacy-read-setup"),control=synthetic("legacy-read-control");
const ref=(key:string)=>synthetic(`legacy-read-${key}`);
const LEGACY_CONTRACT="TEST_LEGACY_CONTRACT/1",LEGACY_SCHEMA="TEST_LEGACY_SCHEMA/1";
const list=(results:unknown[])=>({results,has_more:false,next_cursor:null});
const property=(type:string,value:unknown)=>({type,[type]:type==="title"||type==="rich_text"?[text(String(value))]:type==="select"?{name:value}:type==="date"?(value===null?null:{start:value,end:null,time_zone:null}):value});
const page=(id:string,parent?:string,properties:Record<string,unknown>={})=>({object:"page",id,archived:false,in_trash:false,last_edited_time:"2030-01-01T09:00:00.000Z",...(parent?{parent:{type:"page_id",page_id:parent}}:{}),properties});
const child=(id:string,parent:string,title:string,type="child_page")=>({object:"block",id,archived:false,in_trash:false,has_children:false,parent:{type:"page_id",page_id:parent},type,[type]:{title}});
function fixture(policy:unknown="LEGACY_READ_ONLY") {
 const w=buildWorld();w.setPrincipals([REP_A]);w.deps.adapters.salesRuntime.register(LEGACY_CONTRACT,Object.assign(salesContractAdapter(LEGACY_CONTRACT,[LEGACY_SCHEMA],{...SGRAMMAR,bootTitle:"00 — BOOT & INSTANCE"}),{legacyReadBridgeSchema:LEGACY_SCHEMA}));
 const entry={rep_identity_key:REP_A.rep_identity_key!,status:"KNOWN",root_ref:root,expected_instance_id:"SALESOS-FIXTURE-LEGACY",expected_gmail_identity:"rep-a@example.invalid",pointer_generation:"3",...(policy===undefined||policy===null?{}:{operation_policy:policy})} as SalesRuntimeEntry;
 const map=new Map<string,unknown>(),calls:string[]=[];
 map.set(`page:${root}`,page(root,undefined,{title:property("title","Existing Sales OS")}));
 map.set(`children:${root}`,list([child(boot,root,"00 — BOOT & INSTANCE"),child(setup,root,"02 — SETUP & BUSINESS CONFIG"),child(control,root,"03 — CONTROL PLANE")]));
 for(const [id,title]of [[boot,"00 — BOOT & INSTANCE"],[setup,"02 — SETUP & BUSINESS CONFIG"],[control,"03 — CONTROL PLANE"]])map.set(`page:${id}`,page(id!,root,{title:property("title",title)}));
 const definitions=[
  {role:"MANIFEST",parent:boot,title:"Instance Manifest",fields:{Name:"title","Root URL":"url","Instance ID":"rich_text",Owner:"rich_text","Gmail Identity":"email","Install State":"select","Instance Status":"select","Sales Contract Version":"rich_text","Schema Version":"rich_text","Current Gate":"rich_text","Last Verified At":"date"},rows:[{Name:"CURRENT","Root URL":`https://example.invalid/p/${root}`,"Instance ID":"SALESOS-FIXTURE-LEGACY",Owner:"Rep A","Gmail Identity":"rep-a@example.invalid","Install State":"READY","Instance Status":"ACTIVE","Sales Contract Version":LEGACY_CONTRACT,"Schema Version":LEGACY_SCHEMA,"Current Gate":"READY","Last Verified At":"2030-01-01T09:00:00Z"}]},
  {role:"STATE",parent:control,title:"OS State",fields:{Name:"title","Current Gate":"select","Current Gate Status":"select","Next Action":"rich_text","Next Question":"rich_text","Last Verified At":"date","Open Blocker":"rich_text","Recovery Required":"checkbox","Last Run Ref":"rich_text","Last Verified Mutation":"rich_text"},rows:[{Name:"CURRENT","Current Gate":"READY","Current Gate Status":"PASS","Next Action":"Reconcile the declared existing evidence; do not send.","Next Question":"Confirm the existing creative experiment?","Last Verified At":"2030-01-01T09:00:00Z","Open Blocker":"Historical data coverage incomplete","Recovery Required":false,"Last Run Ref":"Run61","Last Verified Mutation":"MUT-342"}]},
  {role:"RUNS",parent:control,title:"Runs",fields:{Run:"title",Status:"select","Recovery Required":"checkbox","Next Action":"rich_text",Started:"date","Verified At":"date"},rows:[{Run:"Run62 — partial reconciliation",Status:"HOLD","Recovery Required":false,"Next Action":"Continue checking unprocessed source events; preserve the reconciliation cursor.",Started:null,"Verified At":null}]},
  {role:"LEDGER",parent:control,title:"Mutation Ledger",fields:{Mutation:"title",Status:"select",Run:"relation","Target URL":"url","Compared Fields":"rich_text","Verified At":"date"},rows:[{Mutation:"MUT-343",Status:"VERIFIED",Run:[{id:ref("RUNSrow0")}],"Target URL":`https://example.invalid/p/${ref("RECEIPTSrow0")}`,"Compared Fields":"","Verified At":null}]},
  {role:"RECEIPTS",parent:control,title:"Receipts",fields:{Receipt:"title",Verified:"checkbox","Gmail Message ID":"rich_text","Idempotency Key":"rich_text","Observed At":"date"},rows:[{Receipt:"433 — source event",Verified:true,"Gmail Message ID":"native-event-433","Idempotency Key":"GMAIL:native-event-433","Observed At":null}]},
  {role:"BUSINESS",parent:setup,title:"Business Configuration",fields:{"Config Item":"title",Category:"select",State:"select",Value:"rich_text",Version:"rich_text",Source:"rich_text"},rows:[{"Config Item":"Existing offer",Category:"OFFER",State:"CONFIRMED",Value:"Recorded immersive studio offer",Version:"v2",Source:"existing decision"},{"Config Item":"Retired goal",Category:"GOAL",State:"RETIRED",Value:"Do not reactivate",Version:"v1",Source:"historical decision"}]},
  {role:"RUNTIME",parent:setup,title:"Runtime Configuration",fields:{Config:"title",Type:"select",State:"select",Value:"rich_text",Source:"rich_text"},rows:[{Config:"Gmail Connector",Type:"CONNECTOR",State:"CONFIRMED",Value:"Dated observation only",Source:"historical native read"}]},
 ] as const;
 for(const d of definitions){const db=ref(d.role+"db"),ds=ref(d.role+"ds");
  const existing=(map.get(`children:${d.parent}`) as {results:unknown[]}|undefined)?.results??[];map.set(`children:${d.parent}`,list([...existing,child(db,d.parent,d.title,"child_database")]));
  map.set(`database:${db}`,{object:"database",id:db,archived:false,in_trash:false,parent:{type:"page_id",page_id:d.parent},title:[text(d.title)],data_sources:[{id:ds}]});
  map.set(`source:${ds}`,{object:"data_source",id:ds,archived:false,in_trash:false,parent:{type:"database_id",database_id:db},title:[text(d.title)],properties:Object.fromEntries(Object.entries(d.fields).map(([k,t])=>[k,{type:t,[t]:{}}]))});
  const rows=d.rows.map((values,i)=>({...page(ref(d.role+"row"+i)),parent:{type:"data_source_id",data_source_id:ds},properties:Object.fromEntries(Object.entries(values).map(([k,v])=>[k,property((d.fields as Record<string,string>)[k]!,v)]))}));
  map.set(`query:${ds}`,list(rows));for(const row of rows)map.set(`page:${row.id}`,row);
 }
 const read=async(method:string,id:string)=>{calls.push(`${method}:${id}`);if(!map.has(`${method}:${id}`))throw Error("READ_OUTSIDE_FIXTURE");return map.get(`${method}:${id}`);};
 const notion:NotionReadClient={retrievePage:id=>read("page",id),retrieveDatabase:id=>read("database",id),retrieveDataSource:id=>read("source",id),retrieveBlockChildren:id=>read("children",id),queryDataSource:async(id,_filter,_cursor,options)=>{
  const result=structuredClone(await read("query",id)) as {results:any[];has_more:boolean;next_cursor:string|null};
  if(options?.sorts?.some(s=>s.timestamp==="last_edited_time"&&s.direction==="descending")){
   result.results.sort((a,b)=>String(b.last_edited_time).localeCompare(String(a.last_edited_time)));
   if(options.page_size&&result.results.length>options.page_size){result.results=result.results.slice(0,options.page_size);result.has_more=true;result.next_cursor="private-provider-cursor";}
  }return result;
 }};
 const deps={...w.deps,notion,salesRegistry:new InMemorySalesRuntimeRegistry([entry])};
 return {w,map,calls,deps,entry,ctx:{principal_id:REP_A.principal_id,now:T0}};
}
const rec=(v:unknown)=>v as Record<string,any>;
async function first(f:ReturnType<typeof fixture>){
 const server=createServer(f.deps,REP_A.principal_id),client=new Client({name:"legacy-first-message",version:"1"});
 const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
 try{return rec(JSON.parse((rec(await client.callTool({name:"os_bind",arguments:{}})).content[0].text)));}finally{await client.close();await server.close();}
}

// Break caught: a successful resume serving only stale CURRENT and hiding real native partial work.
test("legacy read bridge: partial native work is visible beside CURRENT without replay or source-proof inflation",async()=>{
 const f=fixture(),before=structuredClone([...f.map]),r=rec((await first(f)).result.legacy_read_only);
 assert.equal(r.recorded_state.last_run_ref,"Run61");assert.equal(r.recorded_state.last_verified_mutation,"MUT-342");
 assert.equal(r.transaction_history.runs.observed_rows[0].values.Run,"Run62 — partial reconciliation");
 assert.equal(r.transaction_history.runs.observed_rows[0].values.Status,"HOLD");
 assert.equal(r.transaction_history.runs.observed_rows[0].values.Started,null);
 assert.equal(r.transaction_history.runs.observed_rows[0].values["Next Action"],"Continue checking unprocessed source events; preserve the reconciliation cursor.");
 assert.deepEqual(r.transaction_history.mutations.observed_rows[0].values.Run,[ref("RUNSrow0")]);
 assert.equal(r.transaction_history.receipts.observed_rows[0].values["Gmail Message ID"],"native-event-433");
 assert.equal(r.transaction_history.receipts.observed_rows[0].values["Observed At"],null);
 assert.equal(r.transaction_history.trust,"SOURCE_DATA_ONLY");assert.equal(r.transaction_history.adopted,false);
 assert.equal(r.transaction_history.source_verified,false);assert.equal(r.write_capability,"DENIED");
 assert.deepEqual([...f.map],before);
});

// Break caught: choosing oldest rows or nullable Started over recent partial work in a bounded journal window.
test("legacy read bridge: journal windows expose newest edits, retain pagination limits and never claim completeness",async()=>{
 const f=fixture(),sample=rec(f.map.get(`query:${ref("RUNSds")}`)).results[0];
 f.map.set(`query:${ref("RUNSds")}`,list(Array.from({length:25},(_,i)=>({...structuredClone(sample),id:ref(`journal-run-${i}`),last_edited_time:`2030-01-${String(i+1).padStart(2,"0")}T09:00:00.000Z`}))));
 const r=rec((await first(f)).result.legacy_read_only),runs=r.transaction_history.runs;
 assert.equal(runs.observed_rows.length,5);assert.equal(runs.observed_rows[0].page_ref,ref("journal-run-24"));
 assert.equal(runs.has_more,true);assert.equal(runs.status,"PARTIAL");assert.equal(r.status,"PARTIAL");
 assert(r.issues.some((x:any)=>x.role==="RUNS"&&x.code==="ROW_WINDOW_PARTIAL"));
 assert(!JSON.stringify(r).includes("private-provider-cursor"));assert.equal(r.transaction_history.adopted,false);
});

// Break caught: adding transaction history consuming the budget previously used for the existing business context.
test("legacy read bridge: recent journals do not evict the existing business and runtime configuration",async()=>{
 const f=fixture(),runs=rec(f.map.get(`query:${ref("RUNSds")}`)),sample=runs.results[0];
 runs.results=Array.from({length:25},(_,i)=>({...structuredClone(sample),id:ref(`budget-run-${i}`),properties:{...structuredClone(sample.properties),"Next Action":property("rich_text","x".repeat(1600))}}));
 const business=rec(f.map.get(`query:${ref("BUSINESSds")}`)).results[0],payload="Existing business context ".repeat(1300);
 business.properties.Value=property("rich_text",payload);
 const r=rec((await first(f)).result.legacy_read_only);
 assert(r.business_configuration.observed_rows[0]?.values.Value===payload,"existing business value must remain present and byte-exact");
 assert.equal(r.business_configuration.status,"COMPLETE");assert.equal(r.runtime_configuration.observed_rows.length,1);
 assert(Buffer.byteLength(JSON.stringify(r))<=64*1024);assert.equal(r.transaction_history.adopted,false);
});

// Break caught: a later turn reusing the first journal snapshot after a native writer has progressed.
test("legacy read bridge: the same binding re-reads native progress on the next turn",async()=>{
 const f=fixture(),bound=await dispatch("os_bind",{},f.ctx,f.deps);assert.equal(bound.status,"OK");if(bound.status!=="OK")throw Error("bind");
 const args={binding_handle:String(bound.result.binding_handle)};
 const first=await dispatch("os_resume",args,f.ctx,f.deps);assert.equal(first.status,"OK");
 const run=rec(f.map.get(`query:${ref("RUNSds")}`)).results[0];run.properties["Next Action"]=property("rich_text","Newly recorded continuation, not the old configuration question.");
 const second=await dispatch("os_resume",args,f.ctx,f.deps);assert.equal(second.status,"OK");if(second.status!=="OK")throw Error("resume");
 assert.equal(rec(second.result.legacy_read_only).transaction_history.runs.observed_rows[0].values["Next Action"],"Newly recorded continuation, not the old configuration question.");
 assert.equal(rec(second.result.legacy_read_only).write_capability,"DENIED");
});

// Break caught: accepting a malformed Run relation or treating an unreadable journal as an empty completed one.
test("legacy read bridge: malformed journal relations and unavailable sources remain explicitly unknown",async()=>{
 const f=fixture(),row=rec(f.map.get(`query:${ref("LEDGERds")}`)).results[0];row.properties.Run.relation=[{id:"not-an-id"}];
 f.map.delete(`source:${ref("RECEIPTSds")}`);
 const r=rec((await first(f)).result.legacy_read_only);
 assert.equal(r.transaction_history.mutations.status,"UNAVAILABLE");assert.equal(r.transaction_history.receipts.status,"UNAVAILABLE");
 assert.equal(r.transaction_history.receipts.has_more,"UNKNOWN");assert.equal(r.transaction_history.source_verified,false);
 assert.equal(r.status,"PARTIAL");assert.equal(r.recorded_state.last_run_ref,"Run61");
});

// Break caught: a registry policy being ignored and a first bind exposing only an empty/onboarding state.
test("legacy read bridge: first binding contains real dated state and configuration without onboarding or mutation",async()=>{
 const f=fixture(),before=structuredClone([...f.map]),bound=await first(f);
 assert.equal(bound.code,"BOUND");assert.equal(bound.result.legacy_read_only?.mode,"LEGACY_READ_ONLY","legacy migration policy must return fresh state on the initial bind");
 const r=bound.result.legacy_read_only;
 assert.equal(r.trust,"SOURCE_DATA_ONLY");assert.equal(r.write_capability,"DENIED");assert.equal(r.native_capabilities,"NOT_VERIFIED");assert.equal(r.production_readiness,"NOT_VERIFIED");
 assert.equal(r.recorded_state.current_gate,"READY");assert.equal(r.recorded_state.last_verified_at,"2030-01-01T09:00:00Z");assert.equal(r.recorded_state.next_question,"Confirm the existing creative experiment?");
 assert.equal(r.business_configuration.observed_rows[0].values.Value,"Recorded immersive studio offer");assert.equal(r.business_configuration.observed_rows[1].values.State,"RETIRED");
 assert.equal(r.runtime_configuration.observed_rows.length,1);assert.equal(bound.next.permitted_tool_call,undefined);assert(bound.next.conduct.includes("SOURCE_DATA_ONLY"));
 assert.deepEqual([...f.map],before);
});

// Break caught: automatic settle/recovery or an input class reaching plan/lease/Notion effects in read-only mode.
test("legacy read bridge: all commit classes stop before plans, claims, leases or Notion effects",async()=>{
 const f=fixture(),bound=await dispatch("os_bind",{},f.ctx,f.deps);assert.equal(bound.status,"OK");if(bound.status!=="OK")throw Error("bind");const handle=String(bound.result.binding_handle);
 const forbidden=()=>{throw Error("BUSINESS_STORE_TOUCHED");};
 const store=new Proxy(f.deps.store,{get(target,key,receiver){if(key==="bindings")return Reflect.get(target,key,receiver);return new Proxy({},{get:()=>forbidden});}});
 const deps={...f.deps,store,notionWriter:{createPage:forbidden,updatePage:forbidden}} as unknown as Parameters<typeof dispatchCommit>[2];
 for(const extras of [{},{intent:{action_class:"SAVE",summary:"record answer",mutations:[{logical_resource_key:"SALES:EXTERNAL_ACTIONS",operation:"CREATE",record_selector:{natural_key:"test"},desired_changes:{}}]}},{capability_evidence:{challenge:"untrusted",competent_source:"GMAIL",evidence_ref:"native-ref",verified_at:"2030-01-01T09:00:00Z"}},
  {external_event_evidence:{provider:"GMAIL",source_identity:"rep-a@example.invalid",evidence_ref:"native-ref",observed_at:"2030-01-01T09:00:00Z",message:{message_id:"m1",thread_id:"t1",from:"rep-a@example.invalid",to:["lead@example.invalid"],date:"2030-01-01T09:00:00Z"},contact_refs:[ref("contact")]}}]){
  const result=await dispatchCommit({binding_handle:handle,...extras},f.ctx,deps);assert.equal(result.kind,"HELD");if(result.kind!=="HELD")throw Error("commit");assert.equal(result.code,"HOLD_ACTION_NOT_AUTHORIZED");assert.equal(result.wrote_anything,false);assert(result.safe_action.includes("migration"));
 }
 const resumed=await dispatch("os_resume",{binding_handle:handle},{...f.ctx,candidate_resume:true},deps);assert.equal(resumed.status,"OK");if(resumed.status!=="OK")throw Error("resume");assert.equal(rec(resumed.result.legacy_read_only).write_capability,"DENIED");
 for(const [tool,args]of [["os_prepare",{}],["os_verify",{plan_id:"untrusted-plan",phase:"FINAL"}]] as const){const e=await dispatch(tool,{binding_handle:handle,...args},f.ctx,deps);assert.equal(e.status,"HOLD");assert.equal(e.code,"HOLD_ACTION_NOT_AUTHORIZED");}
});

test("legacy read bridge: unknown backend policy fails closed and caller cannot request read policy",async()=>{
 const f=fixture("READ_AND_WRITE"),b=await dispatch("os_bind",{},f.ctx,f.deps);assert.equal(b.status,"HOLD");
 const normal=fixture(null);const forged=await dispatch("os_bind",{operation_policy:"LEGACY_READ_ONLY"} as any,normal.ctx,normal.deps);assert.equal(forged.status,"ERROR");
 const unchanged=await first(normal);assert.equal(unchanged.result.initial_read,undefined);assert.equal(unchanged.result.legacy_read_only,undefined);assert.equal(unchanged.next.permitted_tool_call,"os_resume");
});

test("legacy read bridge: removing read policy invalidates the old handle even without a pointer bump",async()=>{
 const f=fixture(),b=await dispatch("os_bind",{},f.ctx,f.deps);assert.equal(b.status,"OK");if(b.status!=="OK")throw Error("bind");
 const {operation_policy:_removed,...unrestricted}=f.entry;f.deps.salesRegistry=new InMemorySalesRuntimeRegistry([unrestricted]);
 const r=await dispatchCommit({binding_handle:String(b.result.binding_handle)},f.ctx,f.deps as Parameters<typeof dispatchCommit>[2]);assert.equal(r.kind,"HELD");if(r.kind!=="HELD")throw Error("commit");assert.equal(r.code,"HOLD_BINDING_STALE_RUNTIME_ROTATED");assert.equal(r.wrote_anything,false);
});

test("legacy read bridge: internal commit entry cannot recover an existing journal",async()=>{
 const f=fixture(),b=await dispatch("os_bind",{},f.ctx,f.deps);assert.equal(b.status,"OK");if(b.status!=="OK")throw Error("bind");
 const binding=await f.deps.store.bindings.findByHandleHash((await import("../../src/binding/handle.ts")).hashHandle(String(b.result.binding_handle)));assert(binding);
 const resolved=await (await import("../../src/tools/handlers.ts")).resolveRuntimeFor(f.deps,REP_A,"VERTIGO","SALES");assert.equal(resolved.kind,"RESOLVED");if(resolved.kind!=="RESOLVED")throw Error("runtime");
 const forbidden=()=>{throw Error("BUSINESS_STORE_TOUCHED");},store=new Proxy(f.deps.store,{get:()=>new Proxy({},{get:()=>forbidden})});
 const {commit}=await import("../../src/transactions/commit.ts");
 const r=await commit({...f.deps,store} as Parameters<typeof commit>[0],binding,resolved.runtime,{},f.ctx);assert.equal(r.kind,"HELD");if(r.kind!=="HELD")throw Error("commit");assert.equal(r.code,"HOLD_ACTION_NOT_AUTHORIZED");assert.equal(r.wrote_anything,false);
});

test("legacy read bridge: an assignment changed during source reads withholds all old source data",async()=>{
 const f=fixture(),registry=f.deps.salesRegistry,base=f.deps.notion;
 f.deps.notion={...base,queryDataSource:async(id,...args)=>{const q=await base.queryDataSource(id,...args);if(id===ref("RUNTIMEds")){
  f.deps.salesRegistry=new InMemorySalesRuntimeRegistry([{...f.entry,pointer_generation:"4"}]);
 }return q;}};
 const reply=await first(f);assert.equal(reply.result?.legacy_read_only,undefined,"rotated assignment cannot reveal the former snapshot");
 assert(!JSON.stringify(reply).includes("Recorded immersive studio offer"));f.deps.salesRegistry=registry;
});

test("legacy read bridge: oversized provider row window stops at declared bound and remains partial",async()=>{
 const f=fixture(),sample=rec(f.map.get(`query:${ref("BUSINESSds")}`)).results[0];
 f.map.set(`query:${ref("BUSINESSds")}`,list(Array.from({length:101},(_,i)=>({...structuredClone(sample),id:ref(`large-row-${i}`)}))));
 const r=rec((await first(f)).result.legacy_read_only);assert.equal(r.status,"PARTIAL");assert.equal(r.business_configuration.status,"PARTIAL");assert.equal(r.business_configuration.observed_rows.length,100);
 assert(r.issues.some((x:any)=>x.code==="ROW_LIMIT"));
});

test("legacy read bridge: root refusal exposes no provider secrets or fabricated state",async()=>{
 const f=fixture(),base=f.deps.notion;
 // Bind and liveness resolve normally; only the snapshot's independent read is refused.
 let reads=0;f.deps.notion={...base,retrieveBlockChildren:async id=>{if(id===root&&++reads===3)throw Error("provider private token secret");return base.retrieveBlockChildren(id);}};
 const reply=await first(f),r=rec(reply.result.legacy_read_only);assert.equal(r.status,"UNAVAILABLE");assert.equal(r.recorded_state.current_gate,null);assert(!JSON.stringify(reply).includes("provider private token secret"));
 assert(!reply.say.startsWith("Je retrouve"));
});
