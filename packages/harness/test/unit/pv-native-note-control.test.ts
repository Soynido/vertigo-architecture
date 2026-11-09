import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,writeFile,stat,readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NativeNoteControl,type NativeNotePilotProfile} from "../../src/verify/nativeNoteControl.ts";
import {InMemoryPrincipalRegistry,type PrincipalRegistry} from "../../src/auth/principal.ts";
import type {NotionReadClient} from "../../src/notion/readClient.ts";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import {createServer} from "../../src/index.ts";
import {buildResumeWorld} from "./resume-fixtures.ts";

const PAGE="0123456789abcdef0123456789abcdef";
const owner={principal_id:"owner",status:"ACTIVE" as const,allowed_projects:["PRIVATE"],allowed_lanes:["META" as const],meta_authority:"COMPANY_OWNER"};
const principals=new InMemoryPrincipalRegistry([owner]);
async function rig(){
 const dir=await mkdtemp(join(tmpdir(),"native-note-control-"));
 const profile:NativeNotePilotProfile={principal_id:"owner",runtime_id:"PRIVATE_TEST",runtime_generation:"1",page_id:PAGE,marker:"PRIVATE-PILOT",section:"Note de test",note_key:"NOTE-1",initial_text:"Avant.",journal_file:join(dir,"journal.json"),receipt_secret:"a".repeat(64)};
 let text="Avant.",reads=0,unavailable=false;
 const block=(id:string,t:string,type="paragraph")=>({object:"block",id,type,has_children:false,[type]:{rich_text:[{plain_text:t}]}});
 const client={retrievePage:async()=>{reads++;if(unavailable)throw Error("private provider message");return {object:"page",id:PAGE,archived:false,in_trash:false,last_edited_time:"2026-10-14T16:28:00.000Z",parent:{type:"workspace",workspace:true}};},retrieveBlockChildren:async()=>{reads++;return {object:"list",results:[block("m","Pilot key: PRIVATE-PILOT"),block("h","Note de test","heading_2"),block("n",`NOTE-1\n${text}`)],has_more:false,next_cursor:null};}} as unknown as NotionReadClient;
 const controller=(registry:PrincipalRegistry=principals)=>new NativeNoteControl(profile,client,registry);
 return {dir,profile,controller,setText:(v:string)=>{text=v;},setUnavailable:()=>{unavailable=true;},reads:()=>reads};
}

test("native read: MCP independently observes a pending native save without changing its journal",async()=>{
 const r=await rig(),prepared=await r.controller().run("owner",{action:"PREPARE",note_text:"Après."});r.setText("Après.");
 const before=await readFile(r.profile.journal_file,"utf8"),metadata=await stat(r.profile.journal_file),files=await readdir(r.dir);
 const server=createServer({...buildResumeWorld().deps,nativeNotePilot:r.controller()},"owner"),client=new Client({name:"pure-read",version:"1"});
 const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
 try{
  // A missing route or delegating to mutating STATUS must fail this behavioral contract.
  const reply=await client.callTool({name:"vertigo_note_read",arguments:{}});
  assert.notEqual(reply.isError,true,"a read-only entry must return an actual observation");
  const value=JSON.parse((reply.content as {text:string}[])[0]!.text);
  assert.equal(value.status,"VERIFIED");assert.equal(value.operation_id,prepared.operation_id);assert.equal(value.note_text,"Après.");assert.ok(value.receipt);
  const catalogue=(await client.listTools()).tools;
  assert.equal(catalogue.find(t=>t.name==="vertigo_note_read")?.annotations?.readOnlyHint,true);
  assert.equal(catalogue.find(t=>t.name==="vertigo_note_control")?.annotations?.readOnlyHint,false);
  assert.equal(await readFile(r.profile.journal_file,"utf8"),before);
  const after=await stat(r.profile.journal_file);assert.equal(after.ino,metadata.ino);assert.equal(after.mtimeMs,metadata.mtimeMs);assert.deepEqual(await readdir(r.dir),files);
  assert.equal(JSON.parse(JSON.parse(before).payload).operation.observation,undefined,"a read cannot finalize the pending journal");
 }finally{await client.close();await server.close();}
});
test("native read: an initial or pending note never creates or finalizes its journal",async()=>{
 const r=await rig();
 const initial=await r.controller().read("owner",{});assert.equal(initial.status,"EMPTY");assert.ok(initial.receipt);assert.deepEqual(await readdir(r.dir),[]);
 await r.controller().run("owner",{action:"PREPARE",note_text:"Après."});
 const before=await readFile(r.profile.journal_file,"utf8"),metadata=await stat(r.profile.journal_file);
 const pending=await r.controller().read("owner",{});assert.equal(pending.status,"UNCONFIRMED");assert.equal(pending.reason,"CONTENT_MISMATCH");assert.equal(pending.receipt,undefined);
 assert.equal(await readFile(r.profile.journal_file,"utf8"),before);assert.equal((await stat(r.profile.journal_file)).ino,metadata.ino);
});
test("native read: repeated fresh instances observe native changes but never rewrite signed state",async()=>{
 const r=await rig();await r.controller().run("owner",{action:"PREPARE",note_text:"Après."});r.setText("Après.");await r.controller().run("owner",{action:"VERIFY"});
 const before=await readFile(r.profile.journal_file,"utf8"),metadata=await stat(r.profile.journal_file),readCount=r.reads();
 for(let n=0;n<2;n++){const v=await r.controller().read("owner",{});assert.equal(v.status,"VERIFIED");assert.ok(v.receipt);}
 assert.ok(r.reads()>readCount);
 r.setText("Version native plus récente.");const changed=await r.controller().read("owner",{});
 assert.equal(changed.status,"UNCONFIRMED");assert.equal(changed.reason,"CONTENT_MISMATCH");assert.equal(changed.receipt,undefined);
 assert.equal(await readFile(r.profile.journal_file,"utf8"),before);const after=await stat(r.profile.journal_file);assert.equal(after.ino,metadata.ino);assert.equal(after.mtimeMs,metadata.mtimeMs);
});
test("native read: foreign, inactive or non-owner identities cannot read the note",async()=>{
 const r=await rig();for(const id of [undefined,"rep-b"])assert.equal((await r.controller().read(id,{})).status,"ACCESS_DENIED");
 for(const principal of [{...owner,status:"SUSPENDED" as const},{...owner,meta_authority:"VIEWER"}]){
  assert.equal((await r.controller(new InMemoryPrincipalRegistry([principal])).read("owner",{})).status,"ACCESS_DENIED");
 }
 assert.equal(r.reads(),0);assert.deepEqual(await readdir(r.dir),[]);
});
test("native read: revocation during observation suppresses the note and receipt",async()=>{
 const r=await rig();let lookups=0;
 const registry:PrincipalRegistry={get:async()=>++lookups===1?owner:{...owner,status:"REVOKED"}};
 const v=await r.controller(registry).read("owner",{});assert.equal(v.status,"ACCESS_DENIED");assert.equal(v.note_text,undefined);assert.equal(v.receipt,undefined);assert.ok(r.reads()>0);assert.deepEqual(await readdir(r.dir),[]);
});
test("native read: injected targets and actions cannot reach source or journal I/O",async()=>{
 const r=await rig();
 for(const input of [{page_id:PAGE},{principal_id:"owner"},{action:"STATUS"},{note_text:"Forged"},{verified:true}])assert.equal((await r.controller().read("owner",input)).status,"INVALID_ARGUMENT");
 assert.equal(r.reads(),0);assert.deepEqual(await readdir(r.dir),[]);
});
test("native read: corrupt journals and provider errors remain local without reset or raw disclosure",async()=>{
 const r=await rig();await r.controller().run("owner",{action:"PREPARE",note_text:"Après."});
 const original=await readFile(r.profile.journal_file,"utf8"),corrupt=original.replace("Après.","Forged");await writeFile(r.profile.journal_file,corrupt);const count=r.reads();
 const bad=await r.controller().read("owner",{});assert.equal(bad.status,"UNCONFIRMED");assert.equal(bad.receipt,undefined);assert.equal(r.reads(),count);assert.equal(await readFile(r.profile.journal_file,"utf8"),corrupt);
 await writeFile(r.profile.journal_file,original);const metadata=await stat(r.profile.journal_file);r.setUnavailable();
 const missing=await r.controller().read("owner",{});assert.equal(missing.status,"UNCONFIRMED");assert.equal(missing.receipt,undefined);assert.equal(JSON.stringify(missing).includes("private provider"),false);assert.equal(await readFile(r.profile.journal_file,"utf8"),original);assert.equal((await stat(r.profile.journal_file)).ino,metadata.ino);
});

test("native control: preparation is durable but cannot certify a model claim",async()=>{
 const r=await rig(),c=r.controller();
 const p=await c.run("owner",{action:"PREPARE",note_text:"Après."});assert.equal(p.status,"PREPARED");
 assert.equal((await r.controller().run("owner",{action:"VERIFY"})).status,"UNCONFIRMED");
 r.setText("Après.");const v=await r.controller().run("owner",{action:"STATUS"});
 assert.equal(v.status,"VERIFIED");assert.ok(v.receipt);assert.equal(v.note_text,"Après.");
 assert.equal((await c.run("owner",{action:"PREPARE",note_text:"Après."})).operation_id,p.operation_id);
 assert.equal((await r.controller().run("owner",{action:"STATUS"})).operation_id,p.operation_id);
 const j=await readFile(r.profile.journal_file,"utf8");assert.equal(j.includes(r.profile.receipt_secret),false);
});
test("native control: transport owner and current active registry authorize before any I/O",async()=>{
 const r=await rig(),c=r.controller();
 for(const p of [undefined,"rep-b"]){assert.equal((await c.run(p,{action:"STATUS"})).status,"ACCESS_DENIED");}
 const suspended=new NativeNoteControl(r.profile,{} as NotionReadClient,new InMemoryPrincipalRegistry([{...owner,status:"SUSPENDED"}]));
 assert.equal((await suspended.run("owner",{action:"STATUS"})).status,"ACCESS_DENIED");assert.equal(r.reads(),0);
});
test("native control: arbitrary target, authority and model verification flags are rejected",async()=>{
 const r=await rig();
 for(const args of [{action:"STATUS",page_id:PAGE},{action:"VERIFY",verified:true},{action:"PREPARE",note_text:"X",principal_id:"owner"},{action:"PREPARE",note_text:" "}]){
  assert.equal((await r.controller().run("owner",args)).status,"INVALID_ARGUMENT");
 }
 assert.equal(r.reads(),0);
});
test("native control: fresh read always outranks a historical signed receipt",async()=>{
 const r=await rig(),c=r.controller();await c.run("owner",{action:"PREPARE",note_text:"Après."});r.setText("Après.");assert.equal((await c.run("owner",{action:"VERIFY"})).status,"VERIFIED");
 r.setText("Autre version.");const conflict=await c.run("owner",{action:"STATUS"});assert.equal(conflict.status,"UNCONFIRMED");assert.equal(conflict.reason,"CONTENT_MISMATCH");assert.equal(conflict.receipt,undefined);
});
test("native control: source failure is local, not a fabricated save or leaked provider error",async()=>{
 const r=await rig(),c=r.controller();await c.run("owner",{action:"PREPARE",note_text:"Après."});r.setUnavailable();
 const v=await c.run("owner",{action:"STATUS"});assert.equal(v.status,"UNCONFIRMED");assert.equal(JSON.stringify(v).includes("private provider"),false);assert.ok(v.next_action);
});
test("native control: corrupted or foreign-scope journal is not accepted or reset",async()=>{
 const r=await rig(),c=r.controller();await c.run("owner",{action:"PREPARE",note_text:"Après."});
 const original=await readFile(r.profile.journal_file,"utf8");await writeFile(r.profile.journal_file,original.replace("Après.","Forged"));
 assert.equal((await c.run("owner",{action:"STATUS"})).reason,"JOURNAL_UNAVAILABLE");assert.equal(await readFile(r.profile.journal_file,"utf8"),original.replace("Après.","Forged"));
 await writeFile(r.profile.journal_file,original);
 const other=new NativeNoteControl({...r.profile,runtime_generation:"2"},{} as NotionReadClient,principals);
 assert.equal((await other.run("owner",{action:"STATUS"})).reason,"JOURNAL_UNAVAILABLE");
});
test("native control: concurrent duplicate intents share one durable operation",async()=>{
 const r=await rig(),c=r.controller();const results=await Promise.all(Array.from({length:5},()=>c.run("owner",{action:"PREPARE",note_text:"Après."})));
 assert.equal(new Set(results.map(x=>x.operation_id)).size,1);assert.equal(results.every(x=>x.status==="PREPARED"),true);
});
test("native control: a second pending note replays against its actual previous value",async()=>{
 const r=await rig(),c=r.controller();await c.run("owner",{action:"PREPARE",note_text:"Après."});r.setText("Après.");await c.run("owner",{action:"VERIFY"});
 const first=await c.run("owner",{action:"PREPARE",note_text:"Encore."});const retry=await r.controller().run("owner",{action:"PREPARE",note_text:"Encore."});
 assert.equal(retry.status,"PREPARED");assert.equal(retry.operation_id,first.operation_id);assert.equal(retry.previous_text,"Après.");
});
test("native control: owner MCP publishes only its private control; another principal keeps the five existing tools",async()=>{
 const r=await rig(),w=buildResumeWorld();const deps={...w.deps,nativeNotePilot:r.controller()};
 for(const [principal,names]of [["owner",["vertigo_note_control","vertigo_note_read"]],["rep-b",["os_bind","os_commit","os_control_status","os_handoff","os_resume"]]] as const){
  const s=createServer(deps,principal),c=new Client({name:"private-control-test",version:"1"});const [ct,st]=InMemoryTransport.createLinkedPair();
  await s.connect(st);await c.connect(ct);
  try{
   assert.deepEqual((await c.listTools()).tools.map(x=>x.name).sort(),[...names].sort());
   if(principal==="owner"){
    const reply=await c.callTool({name:"vertigo_note_control",arguments:{action:"STATUS"}});
    assert.equal(JSON.parse((reply.content as {text:string}[])[0]!.text).status,"EMPTY");
    assert.equal(c.getInstructions()?.includes("os_bind"),true); // Explicit exclusion, not legacy choreography.
    assert.equal(c.getInstructions()?.includes("This server only records an intent"),true);
   }
  }finally{await c.close();await s.close();}
 }
});
