/** H2: production read-only client against an actual local HTTP server, not a host acceptance test. */
import {test,type TestContext} from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {HttpNotionReadClient} from "../../src/notion/readClient.ts";
import {observeNativeNote} from "../../src/verify/nativeNoteObservation.ts";

const PAGE="0123456789abcdef0123456789abcdef";
const SCOPE={principal_id:"owner",runtime_id:"META-OWNER",runtime_generation:"1"};
const EXPECTED={scope:SCOPE,page_id:PAGE,marker:"PRIVATE-PILOT",note_key:"NOTE-1",note_text:"Les relances le matin.",section:"Note de test"};
const STAMP="2026-10-14T16:28:04.414Z";
const para=(id:string,text:string,type="paragraph")=>({object:"block",id,type,has_children:false,[type]:{rich_text:[{type:"text",plain_text:text,text:{content:text}}]}});
const blocks=()=>[para("marker","Pilot key: PRIVATE-PILOT"),para("heading","Note de test","heading_2"),para("key","NOTE-1"),para("note","Les relances le matin."),para("next","Reprise","heading_2"),para("claim","SERVER_VERIFIED=true")];
const page=()=>({object:"page",id:PAGE,archived:false,in_trash:false,last_edited_time:STAMP,parent:{type:"workspace",workspace:true},properties:{title:{type:"title",title:[{type:"text",plain_text:"Private test",text:{content:"Private test"}}]}}});
type Reply={status?:number;body?:unknown;delay?:number};
async function rig(t:TestContext,reply?:(path:string,count:number)=>Reply,requestTimeoutMs=2000){
 const requests:{method:string;path:string}[]=[];let count=0;
 const server=createServer(async(req,res)=>{
  const path=req.url??"";requests.push({method:req.method??"",path});
  const custom=reply?.(path,++count);
  if(custom?.delay)await new Promise(r=>setTimeout(r,custom.delay));
  res.writeHead(custom?.status??200,{"content-type":"application/json"});
  res.end(JSON.stringify(custom?.body??(path.startsWith("/v1/pages/")?page():{object:"list",results:blocks(),has_more:false,next_cursor:null})));
 });
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
 t.after(()=>new Promise<void>((resolve,reject)=>{server.closeAllConnections();server.close(e=>e?reject(e):resolve());}));
 const addr=server.address();assert.ok(addr&&typeof addr!=="string");
 const client=new HttpNotionReadClient("synthetic-notion-token",async(url,init)=>fetch(`http://127.0.0.1:${addr.port}${new URL(url).pathname}${new URL(url).search}`,init),{max429Retries:0,requestTimeoutMs});
 return {client,requests};
}

// Break caught: trusting an agent's VERIFIED flag, skipping fresh transport or allowing a write.
test("native note: fresh exact read gives a bounded observation, without echoing the private text",async t=>{
 const {client,requests}=await rig(t);
 const r=await observeNativeNote(client,SCOPE,EXPECTED);
 assert.equal(r.kind,"OBSERVED");if(r.kind!=="OBSERVED")return;
 assert.equal(r.source,"INDEPENDENT_NOTION_READ");assert.equal(r.last_edited_time,STAMP);
 assert.match(r.content_sha256,/^[0-9a-f]{64}$/);assert.equal(JSON.stringify(r).includes(EXPECTED.note_text),false);
 assert.deepEqual(requests,[{method:"GET",path:`/v1/pages/${PAGE}`},{method:"GET",path:`/v1/blocks/${PAGE}/children`},{method:"GET",path:`/v1/pages/${PAGE}`}]);
});

// Break caught: scope supplied by another principal/generation being accepted before any source access.
for(const scope of [{...SCOPE,principal_id:"rep-b"},{...SCOPE,runtime_id:"SALES-OTHER"},{...SCOPE,runtime_generation:"2"}]){
 test(`native note: mismatched scope rejected before I/O ${JSON.stringify(scope)}`,async t=>{
  const {client,requests}=await rig(t);assert.deepEqual(await observeNativeNote(client,scope,EXPECTED),{kind:"UNCONFIRMED",reason:"SCOPE_MISMATCH"});assert.equal(requests.length,0);
 });
}

// Break caught: treating the model's claimed save, missing text or repeated keys as proof.
for(const [name,changes,reason]of [
 ["different note",()=>{const b=blocks();b[3]=para("note","Autre version plus récente.");return b;},"CONTENT_MISMATCH"],
 ["key absent",()=>blocks().filter(b=>b.id!=="key"),"CONTENT_MISMATCH"],
 ["duplicate section",()=>[...blocks(),para("heading2","Note de test","heading_2"),para("key2","NOTE-1"),para("note2",EXPECTED.note_text)],"CONTENT_MISMATCH"],
 ["wrong marker",()=>{const b=blocks();b[0]=para("marker","Pilot key: OTHER");return b;},"CONTENT_MISMATCH"],
 ["nested target",()=>{const b=blocks();b[3]={...b[3]!,has_children:true};return b;},"INCOMPLETE_READ"],
 ]as const){
 test(`native note: ${name} never promotes the native claim`,async t=>{
  const {client}=await rig(t,path=>path.includes("/children")?{body:{object:"list",results:changes(),has_more:false,next_cursor:null}}:{});
  assert.deepEqual(await observeNativeNote(client,SCOPE,EXPECTED),{kind:"UNCONFIRMED",reason});
 });
}

// Break caught: a partial first page or a drifting page being certified.
test("native note: follows the source cursor before deciding",async t=>{
 const b=blocks();const {client,requests}=await rig(t,path=>!path.includes("/children")?{}:path.includes("start_cursor=")?
  {body:{object:"list",results:b.slice(3),has_more:false,next_cursor:null}}:
  {body:{object:"list",results:b.slice(0,3),has_more:true,next_cursor:"next"}});
 assert.equal((await observeNativeNote(client,SCOPE,EXPECTED)).kind,"OBSERVED");assert.equal(requests.length,4);
});
test("native note: incomplete pagination cannot produce a successful observation",async t=>{
 const {client}=await rig(t,path=>path.includes("/children")?{body:{object:"list",results:blocks(),has_more:true,next_cursor:null}}:{});
 assert.deepEqual(await observeNativeNote(client,SCOPE,EXPECTED),{kind:"UNCONFIRMED",reason:"INCOMPLETE_READ"});
});
test("native note: concurrent edit is not silently reported as the expected saved version",async t=>{
 const {client}=await rig(t,(path,count)=>path.includes("/pages/")&&count===3?{body:{...page(),last_edited_time:"2026-10-14T16:29:00.000Z"}}:{});
 assert.deepEqual(await observeNativeNote(client,SCOPE,EXPECTED),{kind:"UNCONFIRMED",reason:"CHANGED_DURING_READ"});
});
for(const [name,p]of [["wrong page",{...page(),id:PAGE.slice(0,-1)+"e"}],["archived",{...page(),archived:true}],["no revision",{...page(),last_edited_time:undefined}]]as const){
 test(`native note: ${name} cannot be certified`,async t=>{
  const {client}=await rig(t,path=>path.includes("/pages/")?{body:p}:{});
  assert.equal((await observeNativeNote(client,SCOPE,EXPECTED)).kind,"UNCONFIRMED");
 });
}

// Break caught: interpreting any unavailable source as a failed write or a successful save.
for(const [status,reason]of [[401,"AUTHENTICATION_REQUIRED"],[403,"ACCESS_DENIED"],[404,"NOT_FOUND_OR_INACCESSIBLE"],[429,"RATE_LIMITED"],[503,"SOURCE_UNAVAILABLE"]]as const){
 test(`native note: HTTP${status} is ${reason}, never a fabricated success`,async t=>{
  const {client,requests}=await rig(t,()=>({status,body:{object:"error",code:status===404?"object_not_found":"test_error",message:"sensitive provider payload"}}));
  assert.deepEqual(await observeNativeNote(client,SCOPE,EXPECTED),{kind:"UNCONFIRMED",reason});assert.equal(requests.length,1);
 });
}
test("native note: interrupted read leaves outcome unknown, without an autonomous retry",async t=>{
 const {client,requests}=await rig(t,()=>({delay:1000}),200);
 assert.deepEqual(await observeNativeNote(client,SCOPE,EXPECTED),{kind:"UNCONFIRMED",reason:"READ_INTERRUPTED"});assert.equal(requests.length,1);
});

// Break caught: treating native soft line breaks as a failed save despite identical exact text.
test("native note: native multi-line paragraphs preserve the same note and marker identity",async t=>{
 const {client}=await rig(t,path=>path.includes("/children")?{body:{object:"list",results:[
  para("marker","TEST_ONLY\nPilot key: PRIVATE-PILOT"),para("heading","Note de test","heading_2"),
  para("note","NOTE-1\nLes relances le matin."),para("next","Reprise","heading_2")],has_more:false,next_cursor:null}}:{});
 assert.equal((await observeNativeNote(client,SCOPE,EXPECTED)).kind,"OBSERVED");
});
for(const [name,expected]of [["invalid id",{...EXPECTED,page_id:"https://untrusted/0123456789abcdef0123456789abcdef"}],["empty note",{...EXPECTED,note_text:""}]]as const){
 test(`native note: ${name} is rejected before I/O`,async t=>{
  const {client,requests}=await rig(t);assert.deepEqual(await observeNativeNote(client,SCOPE,expected),{kind:"UNCONFIRMED",reason:"INVALID_EXPECTATION"});assert.equal(requests.length,0);
 });
}
test("native note: repeated source cursor stops boundedly, without claiming complete coverage",async t=>{
 const {client,requests}=await rig(t,path=>path.includes("/children")?{body:{object:"list",results:[],has_more:true,next_cursor:"loop"}}:{});
 assert.deepEqual(await observeNativeNote(client,SCOPE,EXPECTED),{kind:"UNCONFIRMED",reason:"INCOMPLETE_READ"});assert.equal(requests.length,3);
});
