/** Local HTTP oracles for fixed-owner context. No real Notion or business authority. */
import {test,type TestContext} from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {createHmac} from "node:crypto";
import {HttpNotionReadClient} from "../../src/notion/readClient.ts";
import {InMemoryPrincipalRegistry} from "../../src/auth/principal.ts";
import {NativeMetaControl} from "../../src/verify/nativeMetaControl.ts";
import {createNativePilotServer} from "../../src/server/nativePilot.ts";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";

const id=(n:string)=>"0123456789abcdef0123456789abcdef".slice(0,-n.length)+n;
const ROOT=id("fff"),MF=id("000"),PERSON=id("111"),MFDS=id("222"),PEOPLE=id("333"),USER=id("444");
const DDB=id("555"),DDS=id("666"),WDB=id("777"),WDS=id("888"),CANON=id("999");
const STAMP="2026-10-15T07:00:00.000Z",OLD="2026-10-07T14:37:52.353Z",NEXT="2026-10-13T15:00:33.092Z";
const owner={principal_id:"manager",status:"ACTIVE" as const,meta_authority:"COMPANY_OWNER",allowed_projects:["VERTIGO_META_OS"],allowed_lanes:["META" as const]};
const sources={decisions_database_id:DDB,decisions_data_source_id:DDS,weekly_reviews_database_id:WDB,weekly_reviews_data_source_id:WDS,business_decision_page_id:CANON};
const profile={kind:"REAL_META_PROFILE/1" as const,principal_id:"manager",project:"VERTIGO_META_OS" as const,runtime_id:"META-REAL",runtime_generation:"1",root_page_id:ROOT,manifest_page_id:MF,manifest_data_source_id:MFDS,person_page_id:PERSON,people_data_source_id:PEOPLE,notion_user_id:USER,person_key:"OWNER",receipt_secret:"a".repeat(64),operating_sources:sources};
const rich=(s:string,type="rich_text")=>({type,[type]:[{type:"text",plain_text:s,text:{content:s}}]});
const select=(name:string)=>({type:"select",select:{name}});
const date=(start:string)=>({type:"date",date:{start,end:null,time_zone:null}});
const entity=(object:string,ref:string,parent:any,properties:any={},stamp=STAMP)=>({object,id:ref,archived:false,in_trash:false,last_edited_time:stamp,parent,properties});
const decision=(ref=CANON)=>entity("page",ref,{type:"data_source_id",data_source_id:DDS},{Decision:rich("Freeze private Q4 business canon","title"),Status:select("DECIDED"),Reason:rich("Qualification is sufficiently explicit"),Resolution:rich("Freeze business canon; publication/runtime/adoption unproved"),"Decided At":date("2026-10-07T14:45:00Z"),"Effective At":date("2026-10-07"),"PRIVATE NOTES":rich("DO NOT EXPOSE")},OLD);
const review=(ref=id("aaa"))=>entity("page",ref,{type:"data_source_id",data_source_id:WDS},{Review:rich("Weekly owner review","title"),Status:select("DRAFT"),"Week Start":date("2026-10-12"),"Business State":rich("One delivery decision pending"),"Human Decisions":rich("Confirm proposed delivery slot"),"Output Refs":rich("PRIVATE-META-WORK-1"),"Coverage Notes":rich("Sales outcomes not assessed"),"PRIVATE NOTES":rich("DO NOT EXPOSE")});
const decisionTypes={Decision:"title",Status:"select",Reason:"rich_text",Resolution:"rich_text","Decided At":"date","Effective At":"date"};
const weeklyTypes={Review:"title",Status:"select","Week Start":"date","Business State":"rich_text","Human Decisions":"rich_text","Output Refs":"rich_text","Coverage Notes":"rich_text"};
const schema=(ref:string,db:string,types:Record<string,string>)=>entity("data_source",ref,{type:"database_id",database_id:db},Object.fromEntries(Object.entries(types).map(([name,type])=>[name,{type,[type]:{}}])));
function fixture(path:string):any{
 if(path===`/v1/pages/${ROOT}`)return entity("page",ROOT,{type:"workspace",workspace:true},{title:rich("Owner META","title")});
 if(path===`/v1/pages/${PERSON}`)return entity("page",PERSON,{type:"data_source_id",data_source_id:PEOPLE},{"Person Key":rich("OWNER"),"Notion User":{type:"people",people:[{object:"user",id:USER}]},Roles:{type:"multi_select",multi_select:[{name:"COMPANY_OWNER"},{name:"MANAGER"}]},"Sales Runtime ID":{type:"rich_text",rich_text:[]},"Sales Runtime Ref":{type:"url",url:null}});
 if(path===`/v1/pages/${MF}`)return entity("page",MF,{type:"data_source_id",data_source_id:MFDS},{"Meta Runtime ID":rich("META-REAL"),"Meta Root URL":{type:"url",url:`https://app.notion.com/p/${ROOT}`},State:select("BUILDING"),"Runtime State":select("SETUP"),"Current Setup Gate":rich("M4 Toolkit"),"Current Setup Gate Status":select("OPEN"),"Recovery Required":{type:"checkbox",checkbox:false},Health:select("HEALTHY"),"Persistence Health":select("PASS"),"Current Authority Version":{type:"rich_text",rich_text:[]},"Current Strategy Version":{type:"rich_text",rich_text:[]},"Current Toolkit Version":{type:"rich_text",rich_text:[]},"Published GTM Root":{type:"url",url:null},"Next Action":rich("Qualification standard is next; runtime provenance unproved")},NEXT);
 if(path===`/v1/pages/${CANON}`)return decision();
 for(const [db,ds]of [[DDB,DDS],[WDB,WDS]]as const)if(path===`/v1/databases/${db}`)return {...entity("database",db,{type:"page_id",page_id:ROOT}),data_sources:[{id:ds,name:"fixture"}]};
 if(path===`/v1/data_sources/${DDS}`)return schema(DDS,DDB,decisionTypes);
 if(path===`/v1/data_sources/${WDS}`)return schema(WDS,WDB,weeklyTypes);
 if(path===`/v1/data_sources/${DDS}/query`)return {object:"list",results:[decision()],has_more:false,next_cursor:null};
 if(path===`/v1/data_sources/${WDS}/query`)return {object:"list",results:[],has_more:false,next_cursor:null};
 throw Error("unexpected fixture path "+path);
}
async function rig(t:TestContext,change?:(v:any,path:string,count:number)=>any,registry:any=new InMemoryPrincipalRegistry([owner]),activity?:()=>Promise<any>){
 const requests:{method:string;path:string;body:any}[]=[];
 const server=createServer(async(req,res)=>{const path=req.url??"";let raw="";for await(const p of req)raw+=p;requests.push({method:req.method??"",path,body:raw?JSON.parse(raw):null});
  let value;try{value=change?.(fixture(path),path,requests.length)??fixture(path);}catch{value={http_status:500,message:"PRIVATE FIXTURE ERROR"};}
  res.writeHead(value.http_status??200,{"content-type":"application/json"});res.end(JSON.stringify(value));});
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));t.after(()=>new Promise<void>((r,j)=>{server.closeAllConnections();server.close(e=>e?j(e):r());}));
 const addr=server.address();assert.ok(addr&&typeof addr!=="string");
 const notion=new HttpNotionReadClient("fixture",async(u,i)=>fetch(`http://127.0.0.1:${addr.port}${new URL(u).pathname}`,i),{max429Retries:0,requestTimeoutMs:1000});
 let control:NativeMetaControl|undefined;
 assert.doesNotThrow(()=>{control=new NativeMetaControl(profile,notion,registry,activity);},"optional fixed source mapping must be supported without changing old profiles");
 return {control:control!,requests};
}

// Break: passive evidence is lost, confused with primary context proof, or escalated into a business HOLD.
test('meta context: includes separately qualified passive activity in its signed observation',async t=>{
 const evidence={kind:'PASSIVE_SALES_ACTIVITY/1',profiles:[{principal_id:'rep',business_effects:'NOT_VERIFIED'}]};let calls=0;
 const r=await rig(t,undefined,undefined,async()=>{calls++;return evidence;});
 const out:any=await r.control.run('manager',{action:'CONTEXT'});assert.equal(out.status,'OBSERVED');assert.equal(calls,1);
 assert.deepEqual(out.activity,evidence);assert.deepEqual(JSON.parse(out.receipt.payload).observation.activity,evidence);
});
test('meta context: unavailable passive reader does not block core META or expose its error',async t=>{
 const r=await rig(t,undefined,undefined,async()=>{throw Error('SECRET observer failure');});
 const out:any=await r.control.run('manager',{action:'CONTEXT'});assert.equal(out.status,'OBSERVED');
 assert.equal(out.activity.status,'UNAVAILABLE');assert.equal(JSON.stringify(out).includes('SECRET'),false);
});
test('meta context: a foreign principal never triggers passive collection',async t=>{
 let calls=0;const r=await rig(t,undefined,undefined,async()=>{calls++;return {};});
 assert.equal((await r.control.run('seller',{action:'CONTEXT'})).status,'ACCESS_DENIED');assert.equal(calls,0);
});
test('meta context: owner revocation during passive read withholds all context',async t=>{
 let revoked=false;const registry={get:async()=>({...owner,status:revoked?'REVOKED':'ACTIVE'})};
 const r=await rig(t,undefined,registry,async()=>{revoked=true;return {};});
 const out:any=await r.control.run('manager',{action:'CONTEXT'});assert.equal(out.status,'ACCESS_DENIED');assert.equal(out.activity,undefined);assert.equal(out.receipt,undefined);
});
// Break: adding passive snapshots silently changes the existing primary context hash contract.
test('meta context: passive changes keep the primary hash stable and have their own digest',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-20T08:00:00Z')});let count=0;
 const r=await rig(t,undefined,undefined,async()=>({kind:'PASSIVE_SALES_ACTIVITY/1',count:++count}));
 const a:any=await r.control.run('manager',{action:'CONTEXT'}),b:any=await r.control.run('manager',{action:'CONTEXT'});
 assert.equal(a.status,'OBSERVED');assert.equal(b.status,'OBSERVED');assert.equal(a.content_sha256,b.content_sha256);
 assert.notEqual(a.activity_sha256,b.activity_sha256);assert.notEqual(a.receipt.signature,b.receipt.signature);
});

// Break caught: interpreting an edit date or empty work view as business authority, or merely
// adding CONTEXT to the enum without actually fetching and independently rechecking its sources.
test("meta context: newer technical Next and dated decision remain unresolved beside an empty work window",async t=>{
 const r=await rig(t),out:any=await r.control.run("manager",{action:"CONTEXT"});
 assert.equal(out.status,"OBSERVED");assert.equal(out.claim,"POINT_IN_TIME_META_CONTEXT_ONLY");
 assert.equal(out.context.trust,"SOURCE_DATA_ONLY");assert.equal(out.context.atomic,false);
 assert.equal(out.context.manifest_next.text,"Qualification standard is next; runtime provenance unproved");
 assert.equal(out.context.selected_decision.row.values.Resolution,"Freeze business canon; publication/runtime/adoption unproved");
 assert.equal(out.context.edit_order,"MANIFEST_EDITED_AFTER_SELECTED_DECISION");
 assert.equal(out.context.applicability,"NOT_ESTABLISHED");assert.equal(out.context.supersession,"NOT_ESTABLISHED");
 assert.equal(out.context.priority_basis,"NOT_ASSESSED");assert.equal(out.context.weekly_reviews.status,"OBSERVED_WINDOW");
 assert.deepEqual(out.context.weekly_reviews.rows,[]);assert.equal(out.context.weekly_reviews.coverage,"WINDOW_ONLY");
 assert.equal(out.context.weekly_reviews.has_more,false);assert.equal(out.context.stability,"MATCHED_SELECTED_READS");
 assert.equal(out.context.recommendation,undefined);assert.equal(JSON.stringify(out).includes("DO NOT EXPOSE"),false);
 assert.equal(r.requests.length,20);assert.equal(r.requests.filter(x=>x.method==="POST").length,4);
 for(const q of r.requests.filter(x=>x.method==="POST")){assert.match(q.path,/^\/v1\/data_sources\/[a-f0-9]{32}\/query$/);assert.equal(q.body.page_size,4);assert.equal(q.body.start_cursor,undefined);}
 const payload=JSON.parse(out.receipt.payload);assert.equal(payload.kind,"META_CONTEXT_RECEIPT/1");
 assert.equal(payload.observation.context.supersession,"NOT_ESTABLISHED");
 assert.equal(out.receipt.signature,createHmac("sha256",profile.receipt_secret).update("VERTIGO_META_CONTEXT_RECEIPT/1\n"+out.receipt.payload).digest("hex"));
});

// Break caught: signing a temporal ordering when the provider exposes equal minute-rounded revisions.
test("meta context: equal minute revisions do not establish the edit order",async t=>{
 const minute="2026-10-15T07:00:00.000Z";
 const r=await rig(t,(v,p)=>{
  if(p===`/v1/pages/${MF}`||p===`/v1/pages/${CANON}`)v.last_edited_time=minute;
  if(p===`/v1/data_sources/${DDS}/query`)v.results[0].last_edited_time=minute;
  return v;
 }),out:any=await r.control.run("manager",{action:"CONTEXT"});
 assert.equal(out.status,"OBSERVED");
 assert.equal(out.context.edit_order,"NOT_ESTABLISHED");
 assert.equal(JSON.parse(out.receipt.payload).observation.context.edit_order,"NOT_ESTABLISHED");
 assert.equal(out.context.applicability,"NOT_ESTABLISHED");
});

for(const args of [{action:"CONTEXT",page_id:ROOT},{action:"CONTEXT",link_id:"foreign"},{action:"CONTEXT",cursor:"opaque"}])test("meta context: chat cannot choose targets "+JSON.stringify(args),async t=>{const r=await rig(t);assert.equal((await r.control.run("manager",args)).status,"INVALID_ARGUMENT");assert.equal(r.requests.length,0);});
test("meta context: foreign principal cannot read configured operating sources",async t=>{const r=await rig(t);assert.equal((await r.control.run("seller",{action:"CONTEXT"})).status,"ACCESS_DENIED");assert.equal(r.requests.length,0);});
test("meta context: foreign database parent is local, never queried or exposed",async t=>{
 const r=await rig(t,(v,p)=>p===`/v1/databases/${DDB}`?{...v,parent:{type:"page_id",page_id:PERSON}}:v),out:any=await r.control.run("manager",{action:"CONTEXT"});
 assert.equal(out.status,"OBSERVED");assert.equal(out.context.status,"PARTIAL");
 assert.equal(out.context.decisions.status,"UNAVAILABLE");assert.equal(out.context.decisions.issue,"SCOPE_MISMATCH");
 assert.equal(out.context.selected_decision.row,undefined);assert.equal(out.context.weekly_reviews.status,"OBSERVED_WINDOW");
 assert.equal(r.requests.some(q=>q.path===`/v1/data_sources/${DDS}/query`),false);
});
test("meta context: partial work window is not exhaustive or proof of missing later decisions",async t=>{
 const r=await rig(t,(v,p)=>p===`/v1/data_sources/${WDS}/query`?{object:"list",results:[review(id("aaa")),review(id("bbb")),review(id("ccc")),review(id("ddd"))],has_more:true,next_cursor:"PRIVATE_CURSOR"}:v),out:any=await r.control.run("manager",{action:"CONTEXT"});
 assert.equal(out.context.weekly_reviews.rows.length,3);assert.equal(out.context.weekly_reviews.has_more,true);
 assert.equal(out.context.weekly_reviews.status,"PARTIAL");assert.equal(out.context.supersession,"NOT_ESTABLISHED");
 assert.equal(out.context.priority_basis,"NOT_ASSESSED");assert.equal(JSON.stringify(out).includes("PRIVATE_CURSOR"),false);
});
test("meta context: moved row invalidates only its work window without leaking values",async t=>{
 const r=await rig(t,(v,p)=>p===`/v1/data_sources/${WDS}/query`?{object:"list",results:[{...review(),parent:{type:"data_source_id",data_source_id:DDS}}],has_more:false,next_cursor:null}:v),out:any=await r.control.run("manager",{action:"CONTEXT"});
 assert.equal(out.context.weekly_reviews.status,"UNAVAILABLE");assert.equal(out.context.weekly_reviews.issue,"SCOPE_MISMATCH");
 assert.deepEqual(out.context.weekly_reviews.rows,[]);assert.equal(JSON.stringify(out).includes("One delivery decision pending"),false);
 assert.equal(out.context.selected_decision.row.page_id,CANON);
});
test("meta context: selected-value drift within one source revision removes the receipt",async t=>{
 let reads=0;const r=await rig(t,(v,p)=>{if(p===`/v1/pages/${CANON}`&&++reads===2)v.properties.Resolution=rich("CHANGED AT SAME REVISION");return v;}),out:any=await r.control.run("manager",{action:"CONTEXT"});
 assert.equal(out.status,"UNCONFIRMED");assert.equal(out.reason,"CHANGED_DURING_READ");assert.equal(out.context,undefined);assert.equal(out.receipt,undefined);
});
test("meta context: coherently changed direct and query values still invalidate the inter-pass receipt",async t=>{
 let reads=0;const r=await rig(t,(v,p)=>{
  if(p===`/v1/pages/${CANON}`)reads++;
  if(reads===2){
   if(p===`/v1/pages/${CANON}`)v.properties.Resolution=rich("COHERENT SECOND PASS");
   if(p===`/v1/data_sources/${DDS}/query`)v.results[0].properties.Resolution=rich("COHERENT SECOND PASS");
  }
  return v;
 }),out:any=await r.control.run("manager",{action:"CONTEXT"});
 assert.equal(out.status,"UNCONFIRMED");assert.equal(out.reason,"CHANGED_DURING_READ");
 assert.equal(out.context,undefined);assert.equal(out.receipt,undefined);
});
test("meta context: source provider refusal preserves independent context and hides raw errors",async t=>{
 const r=await rig(t,(v,p)=>p===`/v1/data_sources/${WDS}/query`?{http_status:403,message:"PRIVATE PROVIDER BODY"}:v),out:any=await r.control.run("manager",{action:"CONTEXT"});
 assert.equal(out.status,"OBSERVED");assert.equal(out.context.status,"PARTIAL");assert.equal(out.context.weekly_reviews.status,"UNAVAILABLE");
 assert.equal(out.context.weekly_reviews.issue,"ACCESS_DENIED");assert.equal(out.context.selected_decision.row.page_id,CANON);
 assert.equal(JSON.stringify(out).includes("PRIVATE PROVIDER BODY"),false);
});
test("meta context: revocation during operating reads prevents all context disclosure",async t=>{
 let revoked=false;const registry={get:async()=>({...owner,status:revoked?"REVOKED":"ACTIVE"})};
 const r=await rig(t,(v,p)=>{if(p===`/v1/data_sources/${WDS}/query`)revoked=true;return v;},registry),out:any=await r.control.run("manager",{action:"CONTEXT"});
 assert.equal(out.status,"ACCESS_DENIED");assert.equal(out.context,undefined);assert.equal(out.receipt,undefined);
});

// Break caught: internally inconsistent native snapshots masquerading as a stable decision,
// even if two independent passes repeat the same inconsistent direct/query results.
test("meta context: direct and queried versions of the same decision cannot silently disagree",async t=>{
 const r=await rig(t,(v,p)=>{if(p===`/v1/data_sources/${DDS}/query`)v.results[0].properties.Resolution=rich("CONFLICTING QUERY VERSION");return v;}),out:any=await r.control.run("manager",{action:"CONTEXT"});
 assert.equal(out.context.decisions.status,"UNAVAILABLE");assert.equal(out.context.decisions.issue,"INCONSISTENT_READ");
 assert.equal(out.context.selected_decision.status,"UNAVAILABLE");assert.equal(out.context.selected_decision.row,undefined);
 assert.equal(out.context.weekly_reviews.status,"OBSERVED_WINDOW");assert.equal(out.context.status,"PARTIAL");
 assert.equal(JSON.stringify(out).includes("CONFLICTING QUERY VERSION"),false);
});
test("meta context: an impossible civil date is not presented as an observed work date",async t=>{
 const r=await rig(t,(v,p)=>{if(p===`/v1/data_sources/${WDS}/query`){const a=review();a.properties["Week Start"]=date("2026-02-30");return {...v,results:[a]};}return v;}),out:any=await r.control.run("manager",{action:"CONTEXT"});
 assert.equal(out.context.weekly_reviews.status,"UNAVAILABLE");assert.equal(out.context.weekly_reviews.issue,"INCOMPLETE_READ");
 assert.equal(JSON.stringify(out).includes("2026-02-30"),false);assert.equal(out.context.selected_decision.row.page_id,CANON);
});
for(const [name,mutate,issue]of [
 ["foreign data source parent",(v:any,p:string)=>p===`/v1/data_sources/${WDS}`?{...v,parent:{type:"database_id",database_id:DDB}}:v,"SCOPE_MISMATCH"],
 ["incompatible schema",(v:any,p:string)=>{if(p===`/v1/data_sources/${WDS}`)v.properties["Business State"].type="formula";return v;},"INCOMPLETE_READ"],
 ["oversized selected value",(v:any,p:string)=>p===`/v1/data_sources/${WDS}/query`?{...v,results:[{...review(),properties:{...review().properties,"Business State":rich("X".repeat(4097))}}]}:v,"INCOMPLETE_READ"],
 ["provider exceeds requested page size",(v:any,p:string)=>p===`/v1/data_sources/${WDS}/query`?{...v,results:[review(id("aaa")),review(id("bbb")),review(id("ccc")),review(id("ddd")),review(id("eee"))]}:v,"INCOMPLETE_READ"],
]as const)test("meta context: "+name+" stays local with no leaked rows",async t=>{
 const r=await rig(t,mutate),out:any=await r.control.run("manager",{action:"CONTEXT"});
 assert.equal(out.context.weekly_reviews.status,"UNAVAILABLE");assert.equal(out.context.weekly_reviews.issue,issue);
 assert.deepEqual(out.context.weekly_reviews.rows,[]);assert.equal(out.context.selected_decision.row.page_id,CANON);
});
test("meta context: the MCP read tool exposes and routes CONTEXT without caller source IDs",async t=>{
 const r=await rig(t),server=createNativePilotServer({}as any,"manager","fixture",undefined,r.control),client=new Client({name:"context-boundary",version:"1"});
 const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
 try{
  const tool=(await client.listTools()).tools.find(x=>x.name==="vertigo_meta_control");assert.equal(tool?.annotations?.readOnlyHint,true);
  const result=await client.callTool({name:"vertigo_meta_control",arguments:{action:"CONTEXT"}}),parsed=JSON.parse((result.content as any)[0].text);
  assert.equal(parsed.claim,"POINT_IN_TIME_META_CONTEXT_ONLY");assert.equal(parsed.context.supersession,"NOT_ESTABLISHED");assert.equal(r.requests.length,20);
  const invalid=await client.callTool({name:"vertigo_meta_control",arguments:{action:"CONTEXT",page_id:ROOT}});
  assert.equal(invalid.isError,true);assert.equal(r.requests.length,20);
 }finally{await client.close();await server.close();}
});
test("meta context: a configured profile still keeps STATUS at its original six GETs",async t=>{
 const r=await rig(t,(_v,p)=>{assert.equal(p.includes("/data_sources/"),false);assert.equal(p.includes("/databases/"),false);return _v;}),out:any=await r.control.run("manager",{action:"STATUS"});
 assert.equal(out.status,"OBSERVED");assert.equal(out.claim,"POINT_IN_TIME_NOTION_FIELDS_ONLY");assert.equal(out.context,undefined);
 assert.deepEqual(r.requests.map(x=>x.path),[ROOT,MF,PERSON,ROOT,MF,PERSON].map(v=>`/v1/pages/${v}`));
});
test("meta context: a read work record keeps its source, concrete decision and coverage separate from priority",async t=>{
 const r=await rig(t,(v,p)=>p===`/v1/data_sources/${WDS}/query`?{...v,results:[review()]}:v),out:any=await r.control.run("manager",{action:"CONTEXT"});
 assert.equal(out.context.weekly_reviews.rows[0].page_id,id("aaa"));
 assert.equal(out.context.weekly_reviews.rows[0].values["Human Decisions"],"Confirm proposed delivery slot");
 assert.equal(out.context.weekly_reviews.rows[0].values["Output Refs"],"PRIVATE-META-WORK-1");
 assert.equal(out.context.weekly_reviews.rows[0].revision,STAMP);
 assert.equal(out.context.weekly_reviews.coverage,"WINDOW_ONLY");assert.equal(out.context.priority_basis,"NOT_ASSESSED");
});
// Break caught: guessed CamelCase labels silently discard the existing real Notion weekly schema.
test("meta context: reads the real weekly property names without a schema migration",async t=>{
 const r=await rig(t,(v,p)=>{
  if(p===`/v1/data_sources/${WDS}`)return schema(WDS,WDB,{Review:"title",Status:"select","Week Start":"date","Business State":"rich_text","Human Decisions":"rich_text","Output Refs":"rich_text","Coverage Notes":"rich_text"});
  if(p===`/v1/data_sources/${WDS}/query`)return {...v,results:[entity("page",id("aaa"),{type:"data_source_id",data_source_id:WDS},{
   Review:rich("Real schema fixture","title"),Status:select("REVIEWED"),"Week Start":date("2026-10-12"),
   "Business State":rich("One delivery decision pending"),"Human Decisions":rich("Confirm proposed delivery slot"),
   "Output Refs":rich("PRIVATE-META-WORK-1"),"Coverage Notes":rich("Sales outcomes not assessed"),
  })]};
  return v;
 }),out:any=await r.control.run("manager",{action:"CONTEXT"});
 assert.equal(out.context.weekly_reviews.status,"OBSERVED_WINDOW");
 assert.equal(out.context.weekly_reviews.rows[0].values["Human Decisions"],"Confirm proposed delivery slot");
 assert.equal(out.context.weekly_reviews.rows[0].values["Week Start"].start,"2026-10-12");
 assert.equal(out.context.weekly_reviews.coverage,"WINDOW_ONLY");
});
