import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,writeFile,stat,chmod} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,dirname} from "node:path";
import {InMemoryPrincipalRegistry} from "../../src/auth/principal.ts";
import type {NotionReadClient} from "../../src/notion/readClient.ts";
import {NativeNoteControl} from "../../src/verify/nativeNoteControl.ts";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import {createServer,buildDeps} from "../../src/index.ts";
import {buildResumeWorld} from "./resume-fixtures.ts";

const M="0123456789abcdef0123456789abcdef",S=M.slice(0,-1)+"0";
const owner={principal_id:"owner",status:"ACTIVE" as const,allowed_projects:["PRIVATE"],allowed_lanes:["META" as const],meta_authority:"COMPANY_OWNER"};
const scope={principal_id:"manager-test",runtime_id:"META-TEST",runtime_generation:"1"};
const recipient={principal_id:"sales-test",runtime_id:"SALES-TEST",runtime_generation:"7",contract:"SALES/0.5.0"};
const horizon={start:"2026-10-15",end:"2026-10-21"};
const direction={kind:"DIRECTION_VERSION/1",direction_id:"CAP-TEST",version:1,status:"APPROVED",approval_id:"APPROVAL-1",approved_by:scope.principal_id,recipient,horizon,objective:{metric:"DISCOVERY_HELD",target:3,unit:"meetings"},constraints:["NO_AUTONOMOUS_SEND"],recommendations:["Choisir ses propres canaux."]};
const current={kind:"DIRECTION_CURRENT/1",direction_id:"CAP-TEST",version:1,recipient};
const consumption={kind:"DIRECTION_CONSUMPTION/1",direction_id:"CAP-TEST",version:1,recipient,local_run_id:"RUN-A",consumed_at:"2026-10-15T06:01:00.000Z"};
const event={kind:"SYNTHETIC_EVENT/1",source_id:"EVENT-A",local_object_id:"LEAD-A",recipient,occurred_at:"2026-10-16T10:00:00.000Z",stage:"HELD",value:1};
const outcome={kind:"SALES_OUTCOME/1",direction_id:"CAP-TEST",version:1,recipient,source_id:"EVENT-A",local_object_id:"LEAD-A",stage:"HELD",value:1,unit:"meetings",horizon};
const initial={kind:"SYNTHETIC_DIRECTION_CHECK/1",scope,stage:"RETURNED",meta:{page_id:M,marker:"H4-META"},sales:{page_id:S,marker:"H4-SALES"},recipient,versions:[direction],current,local_method:"Méthodes libres, comptes rendus le soir.",consumption,event,outcome};
async function rig(){
 const dir=await mkdtemp(join(tmpdir(),"direction-control-"));
 const profile={test_only:true,principal_id:"owner",initial,next_event:{...event,source_id:"EVENT-B",local_object_id:"LEAD-B"},journal_file:join(dir,"journal.json"),receipt_secret:"a".repeat(64)};
 const docs=new Map([[M,new Map<string,string>([["Orientation version 1",JSON.stringify(direction)],["CURRENT orientation",JSON.stringify(current)]])],[S,new Map<string,string>([["Méthode locale",initial.local_method],["Orientation reçue",JSON.stringify(consumption)],["Preuve d’essai",JSON.stringify(event)],["Résultat remonté",JSON.stringify(outcome)]])]]);
 let reads=0,unavailable=false;
 const block=(id:string,text:string,type="paragraph")=>({object:"block",id,type,has_children:false,archived:false,in_trash:false,[type]:{rich_text:[{type:"text",plain_text:text,text:{content:text}}]}});
 const client={retrievePage:async(id:string)=>{reads++;assert(docs.has(id));if(unavailable)throw Error("PRIVATE PROVIDER ERROR");return {object:"page",id,archived:false,in_trash:false,last_edited_time:"2026-10-15T06:00:00.000Z",parent:{type:"workspace",workspace:true}};},retrieveBlockChildren:async(id:string)=>{reads++;const doc=docs.get(id);assert(doc);return {object:"list",has_more:false,next_cursor:null,results:[block("marker",id===M?"H4-META":"H4-SALES"),...Array.from(doc).flatMap(([key,value],i)=>[block("h"+i,key,"heading_2"),block("v"+i,value)])]};}} as unknown as NotionReadClient;
 const module=await import(new URL("../../src/verify/nativeDirectionControl.ts",import.meta.url).href).catch((err:NodeJS.ErrnoException)=>{if(err.code==="ERR_MODULE_NOT_FOUND"&&String(err.message).includes("nativeDirectionControl.ts"))return null;throw err;});
 const controller=(p=profile,principals=new InMemoryPrincipalRegistry([owner]))=>module?new module.NativeDirectionControl(p,client,principals,()=>new Date("2026-10-15T06:02:00.000Z")):{run:async()=>({status:"NOT_IMPLEMENTED"})};
 const native=(writes:any[])=>{for(const w of writes){const doc=docs.get(w.page_id);assert(doc);if(w.operation==="APPEND_IF_ABSENT"){assert.equal(doc.has(w.section),false);doc.set(w.section,w.value);}else{assert.equal(w.operation,"REPLACE_IF_MATCH");assert.equal(doc.get(w.section),w.previous);doc.set(w.section,w.value);}}};
 return {profile,docs,controller,native,reads:()=>reads,unavailable:()=>{unavailable=true;}};
}

// Break caught: issuing a receipt before actual independent readback or publishing CURRENT before package proof.
test("direction control: durable intent, package proof, CURRENT last and replay survive a new controller",async()=>{
 const r=await rig(),p=await r.controller().run("owner",{action:"PREPARE",intent:"PUBLISH",target:4});
 assert.equal(p.status,"PREPARED");assert.ok(p.operation_id);assert.equal(p.receipt,undefined);
 assert.deepEqual(p.writes.map((w:any)=>w.section),["Orientation version 2"]);
 assert.equal((await stat(r.profile.journal_file)).mode&0o777,0o600);
 const repeat=await r.controller().run("owner",{action:"STATUS"});assert.equal(repeat.operation_id,p.operation_id);assert.equal(repeat.status,"PREPARED");
 r.native(p.writes);
 const ready=await r.controller().run("owner",{action:"VERIFY"});assert.equal(ready.status,"PACKAGE_READY");assert.equal(ready.operation_id,p.operation_id);
 assert.equal(r.docs.get(M)!.get("CURRENT orientation"),JSON.stringify(current));
 assert.deepEqual(ready.writes.map((w:any)=>w.section),["CURRENT orientation"]);r.native(ready.writes);
 const verified=await r.controller().run("owner",{action:"VERIFY"});assert.equal(verified.status,"VERIFIED");assert.equal(verified.stage,"PUBLISHED");assert.ok(verified.receipt);
 assert.equal(JSON.parse(verified.receipt.payload).kind,"SYNTHETIC_DIRECTION_RECEIPT/1");
 assert.equal(JSON.parse(r.docs.get(M)!.get("CURRENT orientation")!).version,2);
 assert.equal(JSON.parse(r.docs.get(M)!.get("Orientation version 1")!).objective.target,3);
 const replay=await r.controller().run("owner",{action:"PREPARE",intent:"PUBLISH",target:4});assert.equal(replay.operation_id,p.operation_id);assert.equal(replay.status,"VERIFIED");assert.equal(replay.writes,undefined);
});

// Break caught: same-owner calls being misrepresented as real recipient identity, or past records being erased.
test("direction control: consume and return append history and retain explicit synthetic-only proof",async()=>{
 const r=await rig();let p=await r.controller().run("owner",{action:"PREPARE",intent:"PUBLISH",target:4});assert.equal(p.status,"PREPARED");r.native(p.writes);p=await r.controller().run("owner",{action:"VERIFY"});r.native(p.writes);await r.controller().run("owner",{action:"VERIFY"});
 const consume=await r.controller().run("owner",{action:"PREPARE",intent:"CONSUME"});assert.equal(consume.status,"PREPARED");assert.deepEqual(consume.writes.map((w:any)=>w.section),["Orientation reçue version 2"]);r.native(consume.writes);
 assert.equal((await r.controller().run("owner",{action:"VERIFY"})).stage,"CONSUMED");
 const ret=await r.controller().run("owner",{action:"PREPARE",intent:"RETURN"});assert.equal(ret.status,"PREPARED");assert.deepEqual(ret.writes.map((w:any)=>w.section),["Preuve d’essai EVENT-B","Résultat version 2"]);r.native(ret.writes);
 const observed=await r.controller().run("owner",{action:"VERIFY"});assert.equal(observed.status,"VERIFIED");assert.equal(observed.stage,"RETURNED");assert.equal(observed.claim,"POINT_IN_TIME_SYNTHETIC_RECORD_MATCH_ONLY");
 assert.equal(r.docs.get(S)!.get("Méthode locale"),initial.local_method);assert.equal(r.docs.get(S)!.get("Résultat remonté"),JSON.stringify(outcome));
 const resumed=await r.controller().run("owner",{action:"STATUS"});assert.equal(resumed.operation_id,ret.operation_id);assert.equal(resumed.stage,"RETURNED");assert.equal(resumed.writes,undefined);
});

// Break caught: a save failure after native success must not escape as a raw fs error/path.
test("direction control: journal save failure during fresh STATUS or VERIFY remains a localized reply",async()=>{
 const r=await rig();let p=await r.controller().run("owner",{action:"PREPARE",intent:"PUBLISH",target:4});r.native(p.writes);p=await r.controller().run("owner",{action:"VERIFY"});r.native(p.writes);
 const dir=dirname(r.profile.journal_file);await chmod(dir,0o500);
 try{for(const action of ["STATUS","VERIFY"]){const result=await r.controller().run("owner",{action});assert.equal(result.status,"UNCONFIRMED");assert.equal(result.reason,"JOURNAL_UNAVAILABLE");assert(!JSON.stringify(result).includes(dir));}}
 finally{await chmod(dir,0o700);}
 assert.equal((await r.controller().run("owner",{action:"VERIFY"})).status,"VERIFIED");
});

// Break caught: caller target/authority/success injection or an inactive/foreign owner touching the journal/source.
test("direction control: authority and strict arguments are checked before I/O",async()=>{
 const r=await rig();
 for(const principal of [undefined,"other"])assert.equal((await r.controller().run(principal,{action:"STATUS"})).status,"ACCESS_DENIED");
 const suspended=r.controller(r.profile,new InMemoryPrincipalRegistry([{...owner,status:"SUSPENDED"}]));assert.equal((await suspended.run("owner",{action:"STATUS"})).status,"ACCESS_DENIED");
 for(const args of [{action:"STATUS",page_id:M},{action:"VERIFY",verified:true},{action:"PREPARE",intent:"PUBLISH",target:4,principal_id:"owner"},{action:"PREPARE",intent:"CONSUME",target:4},{action:"PREPARE",intent:"PUBLISH",target:-1}])assert.equal((await r.controller().run("owner",args)).status,"INVALID_ARGUMENT");
 assert.equal(r.reads(),0);
});

// Break caught: a failed principal registry leaking an exception through the MCP boundary.
test("direction control: unreadable authority refuses locally without provider error",async()=>{
 const r=await rig(),module=await import(new URL("../../src/verify/nativeDirectionControl.ts",import.meta.url).href);
 const c=new module.NativeDirectionControl(r.profile,{} as NotionReadClient,{get:async()=>{throw Error("PRIVATE AUTH ERROR");}});
 let reply:any;await assert.doesNotReject(async()=>{reply=await c.run("owner",{action:"STATUS"});});assert.equal(reply.status,"ACCESS_DENIED");assert.equal(JSON.stringify(reply).includes("PRIVATE AUTH ERROR"),false);assert.equal(r.reads(),0);
});

// Break caught: source unavailability or an obsolete receipt permitting a blind newer write.
test("direction control: foreign native CURRENT is not overwritten or reported verified",async()=>{
 const r=await rig();r.docs.get(M)!.set("CURRENT orientation",JSON.stringify({...current,version:9}));
 const before=Array.from(r.docs.get(M)!);const reply=await r.controller().run("owner",{action:"PREPARE",intent:"PUBLISH",target:4});
 assert.equal(reply.status,"UNCONFIRMED");assert.equal(reply.writes,undefined);assert.equal(reply.receipt,undefined);assert.deepEqual(Array.from(r.docs.get(M)!),before);
});

// Break caught: recognizing final shape despite CURRENT having advanced before a durable package proof.
test("direction control: publication without prior package checkpoint is not retrospectively certified",async()=>{
 const r=await rig();const p=await r.controller().run("owner",{action:"PREPARE",intent:"PUBLISH",target:4});assert.equal(p.status,"PREPARED");r.native(p.writes);
 r.docs.get(M)!.set("CURRENT orientation",JSON.stringify({...current,version:2}));
 const v=await r.controller().run("owner",{action:"VERIFY"});assert.equal(v.status,"UNCONFIRMED");assert.equal(v.reason,"PUBLICATION_ORDER_UNCONFIRMED");assert.equal(v.receipt,undefined);assert.equal(v.writes,undefined);
});

// Break caught: invalid operator expectations reaching native write instructions.
test("direction control: incompatible initial scope and out-of-horizon test source are rejected",async()=>{
 const r=await rig();assert.throws(()=>r.controller({...r.profile,initial:{...initial,sales:initial.meta}}));
 assert.throws(()=>r.controller({...r.profile,next_event:{...r.profile.next_event,occurred_at:"2027-01-01T12:00:00.000Z"}}));assert.equal(r.reads(),0);
});
test("direction control: source failure does not leak private payload or discard a pending intent",async()=>{
 const r=await rig();const p=await r.controller().run("owner",{action:"PREPARE",intent:"PUBLISH",target:4});assert.equal(p.status,"PREPARED");const before=await readFile(r.profile.journal_file,"utf8");r.unavailable();
 const reply=await r.controller().run("owner",{action:"STATUS"});assert.equal(reply.status,"UNCONFIRMED");assert.equal(JSON.stringify(reply).includes("PRIVATE PROVIDER ERROR"),false);assert.equal(reply.writes,undefined);assert.equal(await readFile(r.profile.journal_file,"utf8"),before);
});

// Break caught: independent per-request controllers generating duplicate durable operation identities.
test("direction control: simultaneous same intent shares one operation and unrelated intent stays local",async()=>{
 const r=await rig();const replies=await Promise.all(Array.from({length:4},()=>r.controller().run("owner",{action:"PREPARE",intent:"PUBLISH",target:4})));
 assert.equal(replies.every(v=>v.status==="PREPARED"),true);assert.equal(new Set(replies.map(v=>v.operation_id)).size,1);
 const newer=await r.controller().run("owner",{action:"PREPARE",intent:"PUBLISH",target:5});assert.equal(newer.status,"RESUME_REQUIRED");assert.equal(newer.operation_id,replies[0].operation_id);assert.ok(newer.next_action);
});

// Break caught: tampered or transplanted journals being adopted/reset after restart.
test("direction control: corrupted or different-profile journal fails closed without reset",async()=>{
 const r=await rig();assert.equal((await r.controller().run("owner",{action:"PREPARE",intent:"PUBLISH",target:4})).status,"PREPARED");
 const original=await readFile(r.profile.journal_file,"utf8");const changed=original.replace("CAP-TEST","FORGED");await writeFile(r.profile.journal_file,changed);
 assert.equal((await r.controller().run("owner",{action:"STATUS"})).reason,"JOURNAL_UNAVAILABLE");assert.equal(await readFile(r.profile.journal_file,"utf8"),changed);
 await writeFile(r.profile.journal_file,original);
 const other=r.controller({...r.profile,initial:{...initial,scope:{...scope,runtime_generation:"2"}}});assert.equal((await other.run("owner",{action:"STATUS"})).reason,"JOURNAL_UNAVAILABLE");
});

// Break caught: exposing direction on a collaborator's surface, or failing to wire the actual owner handler.
test("direction control: private owner MCP invokes it, others keep their original five tools",async()=>{
 const r=await rig(),world=buildResumeWorld();
 const note=new NativeNoteControl({principal_id:"owner",runtime_id:"PRIVATE_TEST",runtime_generation:"1",page_id:M,marker:"NOTE",section:"Note de test",note_key:"NOTE-1",initial_text:"Before",journal_file:r.profile.journal_file+".note",receipt_secret:"b".repeat(64)},{} as NotionReadClient,new InMemoryPrincipalRegistry([owner]));
 for(const [principal,names]of [["owner",["vertigo_direction_control","vertigo_note_control","vertigo_note_read"]],["rep-b",["os_bind","os_commit","os_control_status","os_handoff","os_resume"]]]as const){
  const server=createServer({...world.deps,nativeNotePilot:note,nativeDirectionPilot:r.controller()},principal),client=new Client({name:"direction-control-test",version:"1"});
  const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
  try{assert.deepEqual((await client.listTools()).tools.map(t=>t.name).sort(),[...names].sort());
   if(principal==="owner"){
    const result=await client.callTool({name:"vertigo_direction_control",arguments:{action:"PREPARE",intent:"PUBLISH",target:4}});
    const reply=JSON.parse((result.content as {text:string}[])[0]!.text);assert.equal(reply.status,"PREPARED");assert.equal(reply.test_only,true);assert.equal(reply.writes[0].page_id,M);
   }
  }finally{await client.close();await server.close();}
 }
});

// Break caught: serving code without loading the operator's optional direction profile.
test("direction control: optional configured profile reaches the owner server through real buildDeps",async()=>{
 const r=await rig();const profileFile=r.profile.journal_file+".profile",noteFile=r.profile.journal_file+".note-profile";
 await writeFile(profileFile,JSON.stringify(r.profile),{mode:0o600});
 await writeFile(noteFile,JSON.stringify({principal_id:"owner",runtime_id:"PRIVATE_TEST",runtime_generation:"1",page_id:M,marker:"NOTE",section:"Note de test",note_key:"NOTE-1",initial_text:"Before",journal_file:r.profile.journal_file+".note",receipt_secret:"b".repeat(64)}),{mode:0o600});
 const deps=buildDeps({HARNESS_ENV:"fixture",VERTIGO_META_SPEC_ROOT:M,PRINCIPALS_FILE:r.profile.journal_file+".principals",HARNESS_NATIVE_NOTE_PILOT_FILE:noteFile,HARNESS_NATIVE_DIRECTION_PILOT_FILE:profileFile});
 const server=createServer(deps,"owner"),client=new Client({name:"config-direction-test",version:"1"}),[ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
 try{assert.deepEqual((await client.listTools()).tools.map(t=>t.name).sort(),["vertigo_direction_control","vertigo_note_control","vertigo_note_read"]);}finally{await client.close();await server.close();}
});
