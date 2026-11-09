/** Real HTTP boundary fixtures, not real META business/readiness proof. */
import {test,type TestContext} from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {createHmac} from "node:crypto";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {HttpNotionReadClient} from "../../src/notion/readClient.ts";
import {InMemoryPrincipalRegistry} from "../../src/auth/principal.ts";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import {createServer as createHarness,buildDeps} from "../../src/index.ts";
import {buildResumeWorld} from "./resume-fixtures.ts";

const ROOT="0123456789abcdef0123456789abcdef",MANIFEST=ROOT.slice(0,-1)+"0",PERSON=ROOT.slice(0,-1)+"1";
const MANIFEST_DS=ROOT.slice(0,-1)+"2",PEOPLE_DS=ROOT.slice(0,-1)+"3",USER=ROOT.slice(0,-1)+"4";
const STAMP="2026-10-15T07:00:00.000Z";
const owner={principal_id:"manager",status:"ACTIVE" as const,meta_authority:"COMPANY_OWNER",allowed_projects:["VERTIGO_META_OS"],allowed_lanes:["META" as const]};
const profile={kind:"REAL_META_PROFILE/1",principal_id:"manager",project:"VERTIGO_META_OS",runtime_id:"META-REAL",runtime_generation:"1",root_page_id:ROOT,manifest_page_id:MANIFEST,manifest_data_source_id:MANIFEST_DS,person_page_id:PERSON,people_data_source_id:PEOPLE_DS,notion_user_id:USER,person_key:"OWNER",receipt_secret:"a".repeat(64)};
const rich=(v:string)=>({type:"rich_text",rich_text:v?[{type:"text",plain_text:v,text:{content:v}}]:[]});
const select=(name:string)=>({type:"select",select:{name}});
function page(id:string):any{
 const props:any=id===ROOT?{title:{type:"title",title:[{type:"text",plain_text:"Manager META",text:{content:"Manager META"}}]}}:id===PERSON?{
  "Person Key":rich("OWNER"),"Notion User":{type:"people",people:[{object:"user",id:USER}]},"Roles":{type:"multi_select",multi_select:[{name:"COMPANY_OWNER"},{name:"MANAGER"}]},
  "Sales Runtime ID":rich(""),"Sales Runtime Ref":{type:"url",url:null},"Notes":rich("PRIVATE NOTE: DO NOT FORWARD"),
 }:{"Meta Runtime ID":rich("META-REAL"),"Meta Root URL":{type:"url",url:`https://app.notion.com/p/${ROOT}`},"State":select("BUILDING"),"Runtime State":select("SETUP"),"Current Setup Gate":rich("Toolkit"),"Current Setup Gate Status":select("OPEN"),"Recovery Required":{type:"checkbox",checkbox:false},"Health":select("HEALTHY"),"Persistence Health":select("PASS"),"Current Authority Version":rich(""),"Current Strategy Version":rich(""),"Current Toolkit Version":rich(""),"Published GTM Root":{type:"url",url:null}};
 return {object:"page",id,archived:false,in_trash:false,last_edited_time:STAMP,parent:id===ROOT?{type:"workspace",workspace:true}:{type:"data_source_id",data_source_id:id===PERSON?PEOPLE_DS:MANIFEST_DS},properties:props};
}
// A missing module becomes an assertion failure for the missing feature, not an unresolved static import.
async function api(){const a=await import(new URL("../../src/verify/nativeMetaControl.ts",import.meta.url).href).catch(()=>null);assert.ok(a?.NativeMetaControl,"real META controller has not been implemented");return a;}
async function rig(t:TestContext,change?:(p:any,n:number)=>any,registry=new InMemoryPrincipalRegistry([owner])){
 const requests:{method:string;path:string}[]=[];
 const server=createServer((req,res)=>{const path=req.url??"";requests.push({method:req.method??"",path});const id=path.split("/").at(-1)!;
  const p=change?.(page(id),requests.length)??page(id);res.writeHead(p.http_status??200,{"content-type":"application/json"});res.end(JSON.stringify(p));});
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
 t.after(()=>new Promise<void>((r,j)=>{server.closeAllConnections();server.close(e=>e?j(e):r());}));
 const a=server.address();assert.ok(a&&typeof a!=="string");
 const notion=new HttpNotionReadClient("fixture-token",async(u,i)=>fetch(`http://127.0.0.1:${a.port}${new URL(u).pathname}`,i),{max429Retries:0,requestTimeoutMs:1000});
 const mod=await api();const control=new mod.NativeMetaControl(profile,notion,registry);
 return {control,notion,registry,requests,mod};
}

// Break caught: reading synthetic targets, requiring an owner Sales runtime, or certifying self-declared PASS.
test("meta control: manager without Sales runtime receives fresh scoped field observations only",async t=>{
 const r=await rig(t),out=await r.control.run("manager",{action:"STATUS"});
 assert.equal(out.status,"OBSERVED");assert.equal(out.claim,"POINT_IN_TIME_NOTION_FIELDS_ONLY");
 assert.equal(out.role,"META_MANAGER");assert.equal(out.declared.runtime_state,"SETUP");
 assert.equal(out.declared.persistence_health,"PASS");assert.equal(out.declared.recovery_required,false);
 assert.equal(out.declared.authority_version,null);assert.equal(out.declared.published_gtm_root,null);
 assert.equal(out.declared.seller_runtime_id,null);
 assert.deepEqual(out.not_proved,["BUSINESS_READINESS","TRANSACTION_PERSISTENCE","SELLER_ADOPTION","MAIL_CALENDAR_TRUTH"]);
 assert.equal(out.sources.length,3);assert.ok(out.next_action);
 assert.equal(JSON.stringify(out).includes("PRIVATE NOTE"),false);assert.equal(JSON.stringify(out).includes(profile.receipt_secret),false);
 assert.deepEqual(r.requests.map(x=>x.path),[ROOT,MANIFEST,PERSON,ROOT,MANIFEST,PERSON].map(id=>`/v1/pages/${id}`));
 assert.equal(r.requests.every(x=>x.method==="GET"),true);
 const payload=JSON.parse(out.receipt.payload);assert.equal(payload.kind,"META_SOURCE_RECEIPT/1");assert.equal(payload.observation.declared.runtime_state,"SETUP");
 assert.equal(out.receipt.signature,createHmac("sha256",profile.receipt_secret).update("VERTIGO_META_SOURCE_RECEIPT/1\n"+out.receipt.payload).digest("hex"));
});

// Break caught: caller-selected targets/authority or using a previously authorized identity after revocation.
for(const [name,identity,overrides]of [["foreign principal","seller",{}],["no principal",undefined,{}],["suspended","manager",{status:"SUSPENDED"}],["no owner authority","manager",{meta_authority:"MEMBER"}],["wrong project","manager",{allowed_projects:[]}],["wrong lane","manager",{allowed_lanes:[]}]]as const){
 test(`meta control: ${name} refuses before Notion I/O`,async t=>{
  const reg=new InMemoryPrincipalRegistry([{...owner,...overrides}as any]),r=await rig(t,undefined,reg);
  assert.equal((await r.control.run(identity,{action:"STATUS"})).status,"ACCESS_DENIED");assert.equal(r.requests.length,0);
 });
}
for(const args of [{action:"VERIFY"},{action:"STATUS",page_id:ROOT},{action:"STATUS",principal_id:"manager"},{action:"STATUS",verified:true},{action:"STATUS",expected:{State:"READY"}}]){
 test(`meta control: rejects caller authority ${JSON.stringify(args)}`,async t=>{const r=await rig(t);assert.equal((await r.control.run("manager",args)).status,"INVALID_ARGUMENT");assert.equal(r.requests.length,0);});
}

// Break caught: confusing a similarly named, moved, archived or foreign-identity record with the configured META.
for(const [name,mutate,reason]of [
 ["foreign user",(p:any)=>{if(p.id===PERSON)p.properties["Notion User"].people[0].id=ROOT;return p;},"IDENTITY_MISMATCH"],
 ["no manager role",(p:any)=>{if(p.id===PERSON)p.properties.Roles.multi_select=[{name:"SELLER"}];return p;},"IDENTITY_MISMATCH"],
 ["different person key",(p:any)=>{if(p.id===PERSON)p.properties["Person Key"]=rich("OTHER");return p;},"IDENTITY_MISMATCH"],
 ["different runtime",(p:any)=>{if(p.id===MANIFEST)p.properties["Meta Runtime ID"]=rich("OTHER");return p;},"SCOPE_MISMATCH"],
 ["different root",(p:any)=>{if(p.id===MANIFEST)p.properties["Meta Root URL"].url=`https://app.notion.com/p/${PERSON}`;return p;},"SCOPE_MISMATCH"],
 ["moved manifest",(p:any)=>{if(p.id===MANIFEST)p.parent.data_source_id=PEOPLE_DS;return p;},"SCOPE_MISMATCH"],
 ["forged response ID",(p:any)=>({...p,id:ROOT}),"SCOPE_MISMATCH"],
 ["archived source",(p:any)=>({...p,archived:true}),"INCOMPLETE_READ"],
 ["trashed source",(p:any)=>({...p,in_trash:true}),"INCOMPLETE_READ"],
 ["missing field",(p:any)=>{if(p.id===MANIFEST)delete p.properties["Runtime State"];return p;},"INCOMPLETE_READ"],
 ["mistyped checkbox",(p:any)=>{if(p.id===MANIFEST)p.properties["Recovery Required"].checkbox="false";return p;},"INCOMPLETE_READ"],
 ["truncated person list",(p:any)=>{if(p.id===PERSON)p.properties["Notion User"].has_more=true;return p;},"INCOMPLETE_READ"],
 ]as const){
 test(`meta control: ${name} cannot produce an observation`,async t=>{const r=await rig(t,mutate),out=await r.control.run("manager",{action:"STATUS"});assert.equal(out.status,"UNCONFIRMED");assert.equal(out.reason,reason);assert.equal(out.receipt,undefined);assert.equal(out.declared,undefined);assert.ok(out.next_action);});
}

// Break caught: trusting minute-resolution metadata while a selected value changes or replaying an old receipt.
test("meta control: same-revision field drift is unconfirmed, never cached",async t=>{
 let drift=false;const r=await rig(t,(p,n)=>{if(p.id===MANIFEST&&(drift||n===5))p.properties["State"]=select("READY");return p;});
 assert.equal((await r.control.run("manager",{action:"STATUS"})).reason,"CHANGED_DURING_READ");
 drift=true;const observed=await r.control.run("manager",{action:"STATUS"});assert.equal(observed.status,"OBSERVED");assert.equal(observed.declared.state,"READY");
 assert.equal(r.requests.length,11); // First check stops on its fifth GET; the second makes six fresh GETs.
});
test("meta control: revocation while reading removes the observation",async t=>{
 let revoked=false;const registry={get:async()=>({...owner,status:revoked?"REVOKED":"ACTIVE"})}as any;
 const r=await rig(t,(p,n)=>{if(n===6)revoked=true;return p;},registry);
 const out=await r.control.run("manager",{action:"STATUS"});assert.equal(out.status,"ACCESS_DENIED");assert.equal(out.receipt,undefined);
});
for(const [code,reason]of [[401,"AUTHENTICATION_REQUIRED"],[403,"ACCESS_DENIED"],[404,"NOT_FOUND_OR_INACCESSIBLE"],[429,"RATE_LIMITED"],[503,"SOURCE_UNAVAILABLE"]]as const){
 test(`meta control: provider ${code} remains a local refusal`,async t=>{const r=await rig(t,()=>({http_status:code,message:"SECRET PROVIDER BODY"})),out=await r.control.run("manager",{action:"STATUS"});assert.equal(out.status,"UNCONFIRMED");assert.equal(out.reason,reason);assert.equal(JSON.stringify(out).includes("SECRET"),false);assert.equal(out.receipt,undefined);});
}

// Break caught: leaking the owner read surface to a seller or failing to route the real controller result.
test("meta control: MCP adds only the authenticated owner's read tool",async t=>{
 const r=await rig(t),world=buildResumeWorld();
 for(const identity of ["manager","rep-b"]){
  const server=createHarness({...world.deps,nativeNotePilot:{owns:(p:string)=>p==="manager"}as any,nativeMetaControl:r.control}as any,identity),client=new Client({name:"meta-boundary",version:"1"});
  const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
  try{const tools=(await client.listTools()).tools;
   if(identity==="manager"){assert.ok(tools.find(x=>x.name==="vertigo_meta_control")?.annotations?.readOnlyHint);const result=await client.callTool({name:"vertigo_meta_control",arguments:{action:"STATUS"}});assert.equal(JSON.parse((result.content as any)[0].text).role,"META_MANAGER");}
   else assert.deepEqual(tools.map(x=>x.name).sort(),["os_bind","os_commit","os_control_status","os_handoff","os_resume"]);
  }finally{await client.close();await server.close();}
 }
});

// Break caught: a configured real control disappearing, a malformed profile breaking old controls,
// or a foreign optional profile granting a seller the owner surface.
test("meta control: real buildDeps loads only the optional same-owner profile",async t=>{
 const dir=await mkdtemp(join(tmpdir(),"native-meta-config-"));t.after(()=>rm(dir,{recursive:true,force:true}));
 const noteFile=join(dir,"note.json"),metaFile=join(dir,"meta.json");
 await writeFile(noteFile,JSON.stringify({principal_id:"manager",runtime_id:"PRIVATE_TEST",runtime_generation:"1",page_id:ROOT,marker:"NOTE",section:"Note de test",note_key:"NOTE-1",initial_text:"Before",journal_file:join(dir,"note-journal.json"),receipt_secret:"b".repeat(64)}),{mode:0o600});
 for(const [candidate,expected]of [[profile,true],[{...profile,principal_id:"seller"},false],[{...profile,page_id:ROOT},false]]as const){
  await writeFile(metaFile,JSON.stringify(candidate),{mode:0o600});
  const deps=buildDeps({HARNESS_ENV:"fixture",VERTIGO_META_SPEC_ROOT:ROOT,PRINCIPALS_FILE:join(dir,"principals.json"),HARNESS_NATIVE_NOTE_PILOT_FILE:noteFile,HARNESS_NATIVE_META_PROFILE_FILE:metaFile});
  const server=createHarness(deps,"manager"),client=new Client({name:"meta-config",version:"1"}),[ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
  try{const names=(await client.listTools()).tools.map(x=>x.name).sort();assert.deepEqual(names,expected?["vertigo_meta_control","vertigo_note_control","vertigo_note_read"]:["vertigo_note_control","vertigo_note_read"]);}finally{await client.close();await server.close();}
 }
});
// Break caught: an old OBSERVED receipt surviving a new failed source read.
test("meta control: fresh source failure never returns a previously signed observation",async t=>{
 let failed=false;const r=await rig(t,p=>failed?{http_status:503,message:"SECRET"}:p);
 assert.equal((await r.control.run("manager",{action:"STATUS"})).status,"OBSERVED");failed=true;
 const out=await r.control.run("manager",{action:"STATUS"});assert.equal(out.status,"UNCONFIRMED");assert.equal(out.receipt,undefined);assert.equal(out.declared,undefined);
});
test("meta control: native timeout is qualified without raw provider text",async()=>{
 const mod=await api(),notion=new HttpNotionReadClient("fixture",async()=>{throw new DOMException("SECRET","TimeoutError");});
 const out=await new mod.NativeMetaControl(profile,notion,new InMemoryPrincipalRegistry([owner])).run("manager",{action:"STATUS"});
 assert.equal(out.status,"UNCONFIRMED");assert.equal(out.reason,"READ_INTERRUPTED");assert.equal(out.receipt,undefined);assert.equal(JSON.stringify(out).includes("SECRET"),false);
});
// Break caught: confusing Notion's documentary project label with the existing authenticated tenant.
test("meta control: existing backend VERTIGO tenant works without a registry permission change",async t=>{
 const r=await rig(t),registry=new InMemoryPrincipalRegistry([{...owner,allowed_projects:["VERTIGO"]}]);
 let control:any;assert.doesNotThrow(()=>{control=new r.mod.NativeMetaControl({...profile,project:"VERTIGO"},r.notion,registry);});
 assert.equal((await control.run("manager",{action:"STATUS"})).status,"OBSERVED");
});

// Break caught: treating an old owner's missing optional work projection as a malformed
// request, discovering arbitrary targets instead, or poisoning the existing STATUS path.
test("meta context: missing configured source projection is local and preserves STATUS",async t=>{
 const r=await rig(t),out=await r.control.run("manager",{action:"CONTEXT"});
 assert.equal(out.status,"UNCONFIRMED");
 assert.equal(out.reason,"CONTEXT_NOT_CONFIGURED");
 assert.equal(out.receipt,undefined);assert.equal(out.context,undefined);
 assert.equal(r.requests.length,0,"an absent optional mapping must not discover or query another target");
 const status=await r.control.run("manager",{action:"STATUS"});
 assert.equal(status.status,"OBSERVED");
 assert.equal(status.role,"META_MANAGER");
 assert.deepEqual(r.requests.map(x=>x.path),[ROOT,MANIFEST,PERSON,ROOT,MANIFEST,PERSON].map(id=>`/v1/pages/${id}`));
 assert.equal(r.requests.every(x=>x.method==="GET"),true);
});
