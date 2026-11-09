/** H4: local HTTP boundary proof, not a real recipient or source-truth test. */
import {test,type TestContext} from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {HttpNotionReadClient} from "../../src/notion/readClient.ts";
import {observeNativeDirection as observe} from "../../src/verify/nativeDirectionObservation.ts";

const META="0123456789abcdef0123456789abcdef",SALES=META.slice(0,-1)+"0";
const STAMP="2026-10-15T06:00:00.000Z";
const SCOPE={principal_id:"manager-test",runtime_id:"META-TEST",runtime_generation:"1"};
const RECIPIENT={principal_id:"sales-test",runtime_id:"SALES-TEST",runtime_generation:"7",contract:"SALES/0.5.0"};
const METHOD="Préparer les appels le matin ; rédiger les comptes rendus après la séance.";
const direction=(version=1)=>({kind:"DIRECTION_VERSION/1",direction_id:"CAP-TEST",version,status:"APPROVED",approval_id:`APPROVAL-${version}`,approved_by:SCOPE.principal_id,recipient:RECIPIENT,horizon:{start:"2026-10-15",end:"2026-10-21"},objective:{metric:"DISCOVERY_HELD",target:3,unit:"meetings"},constraints:["NO_AUTONOMOUS_SEND"],recommendations:["Choisir ses propres canaux."]});
const current=(version=1)=>({kind:"DIRECTION_CURRENT/1",direction_id:"CAP-TEST",version,recipient:RECIPIENT});
const consumption=()=>({kind:"DIRECTION_CONSUMPTION/1",direction_id:"CAP-TEST",version:1,recipient:RECIPIENT,local_run_id:"RUN-A",consumed_at:"2026-10-15T06:01:00.000Z"});
const event=()=>({kind:"SYNTHETIC_EVENT/1",source_id:"EVENT-A",local_object_id:"LEAD-A",recipient:RECIPIENT,occurred_at:"2026-10-16T10:00:00.000Z",stage:"HELD",value:1});
const outcome=()=>({kind:"SALES_OUTCOME/1",direction_id:"CAP-TEST",version:1,recipient:RECIPIENT,source_id:"EVENT-A",local_object_id:"LEAD-A",stage:"HELD",value:1,unit:"meetings",horizon:{start:"2026-10-15",end:"2026-10-21"}});
const plan=(stage="PUBLISHED")=>({kind:"SYNTHETIC_DIRECTION_CHECK/1",scope:SCOPE,stage,meta:{page_id:META,marker:"H4-META"},sales:{page_id:SALES,marker:"H4-SALES"},recipient:RECIPIENT,versions:[direction()],current:current(),local_method:METHOD,consumption:consumption(),event:event(),outcome:outcome()});
const para=(id:string,text:string,type="paragraph")=>({object:"block",id,type,has_children:false,archived:false,in_trash:false,[type]:{rich_text:[{type:"text",plain_text:text,text:{content:text}}]}});
const section=(key:string,text:string|object)=>[para(`h-${key}`,key,"heading_2"),para(`v-${key}`,typeof text==="string"?text:JSON.stringify(text))];
const metaBlocks=()=>[para("marker","H4-META"),...section("Orientation version 1",direction()),...section("CURRENT orientation",current()),...section("Diagnostic privé","NEVER EXPOSE THIS PRIVATE NOTE")];
const salesBlocks=()=>[para("marker-sales","H4-SALES"),...section("Méthode locale",METHOD),...section("Orientation reçue",consumption()),...section("Preuve d’essai",event()),...section("Résultat remonté",outcome())];
const page=(id:string)=>({object:"page",id,archived:false,in_trash:false,last_edited_time:STAMP,parent:{type:"workspace",workspace:true},properties:{title:{type:"title",title:[]}}});
type Reply={status?:number;body?:unknown};
async function rig(t:TestContext,reply?:(path:string,n:number)=>Reply){
 const requests:{method:string;path:string}[]=[];
 const server=createServer((req,res)=>{
  const path=req.url??"";requests.push({method:req.method??"",path});
  const custom=reply?.(path,requests.length),target=path.includes(META)?META:SALES;
  res.writeHead(custom?.status??200,{"content-type":"application/json"});
  res.end(JSON.stringify(custom?.body??(path.startsWith("/v1/pages/")?page(target):{object:"list",results:target===META?metaBlocks():salesBlocks(),has_more:false,next_cursor:null})));
 });
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
 t.after(()=>new Promise<void>((resolve,reject)=>{server.closeAllConnections();server.close(e=>e?reject(e):resolve());}));
 const addr=server.address();assert.ok(addr&&typeof addr!=="string");
 const client=new HttpNotionReadClient("synthetic-token",async(url,init)=>fetch(`http://127.0.0.1:${addr.port}${new URL(url).pathname}${new URL(url).search}`,init),{max429Retries:0,requestTimeoutMs:1000});
 return {client,requests};
}
// Break caught: claiming a publication without fresh full package and CURRENT readback.
test("direction: approved compatible package and CURRENT are independently observed",async t=>{
 const {client,requests}=await rig(t);const r=await observe(client,SCOPE,plan());
 assert.equal(r.kind,"OBSERVED");assert.equal(r.stage,"PUBLISHED");assert.equal(r.version,1);
 assert.equal(r.claim,"POINT_IN_TIME_SYNTHETIC_RECORD_MATCH_ONLY");
 assert.match(r.content_sha256,/^[a-f0-9]{64}$/);
 assert.equal(JSON.stringify(r).includes("NEVER EXPOSE"),false);assert.equal(JSON.stringify(r).includes(METHOD),false);
 assert.deepEqual(requests,[{method:"GET",path:`/v1/pages/${META}`},{method:"GET",path:`/v1/blocks/${META}/children`},{method:"GET",path:`/v1/pages/${META}`}]);
});

// Break caught: accepting a caller-selected identity, target, approval or mismatched recipient contract.
for(const [name,mutate,reason] of [
 ["wrong binding",(p:any)=>p,"SCOPE_MISMATCH"],
 ["unknown authority field",(p:any)=>({...p,verified:true}),"INVALID_EXPECTATION"],
 ["same two targets",(p:any)=>({...p,sales:p.meta}),"INVALID_EXPECTATION"],
 ["not approved",(p:any)=>({...p,versions:[{...direction(),status:"DRAFT"}]}),"INVALID_EXPECTATION"],
 ["foreign approver",(p:any)=>({...p,versions:[{...direction(),approved_by:"other"}]}),"INVALID_EXPECTATION"],
 ["incompatible contract",(p:any)=>({...p,versions:[{...direction(),recipient:{...RECIPIENT,contract:"OTHER"}}]}),"INVALID_EXPECTATION"],
 ] as const){
 test(`direction: ${name} stops before source I/O`,async t=>{
  const {client,requests}=await rig(t);
  const r=await observe(client,name==="wrong binding"?{...SCOPE,principal_id:"stranger"}:SCOPE,mutate(plan()));
  assert.deepEqual(r,{kind:"UNCONFIRMED",reason});assert.equal(requests.length,0);
 });
}

// Break caught: a prepared package being presented as already current or an old published version rewritten.
test("direction: incomplete publication does not follow the successor into Sales",async t=>{
 const {client,requests}=await rig(t,path=>path.includes("/children")?{body:{object:"list",results:[para("marker","H4-META"),...section("Orientation version 1",direction()),...section("CURRENT orientation",current(0))],has_more:false,next_cursor:null}}:{});
 assert.deepEqual(await observe(client,SCOPE,plan("RETURNED")),{kind:"UNCONFIRMED",reason:"CONTENT_MISMATCH"});
 assert.equal(requests.some(r=>r.path.includes(SALES)),false);
});
test("direction: package-ready preserves the prior CURRENT without certifying publication",async t=>{
 const p=plan("PACKAGE_READY");p.current=current(0);
 const {client}=await rig(t,path=>path.includes("/children")?{body:{object:"list",results:[para("marker","H4-META"),...section("Orientation version 1",direction()),...section("CURRENT orientation",current(0))],has_more:false,next_cursor:null}}:{});
 const r=await observe(client,SCOPE,p);assert.equal(r.kind,"OBSERVED");assert.equal(r.stage,"PACKAGE_READY");
});
test("direction: altered older immutable package cannot pass a new version check",async t=>{
 const p=plan();p.versions=[direction(),direction(2)];p.current=current(2);
 const old={...direction(),objective:{metric:"DISCOVERY_HELD",target:99,unit:"meetings"}};
 const {client}=await rig(t,path=>path.includes("/children")?{body:{object:"list",results:[para("marker","H4-META"),...section("Orientation version 1",old),...section("Orientation version 2",direction(2)),...section("CURRENT orientation",current(2))],has_more:false,next_cursor:null}}:{});
 assert.deepEqual(await observe(client,SCOPE,p),{kind:"UNCONFIRMED",reason:"CONTENT_MISMATCH"});
});

// Break caught: mistaking publication for recipient consumption or overwriting local habits.
test("direction: consumed record requires the exact recipient version and preserved local method",async t=>{
 const {client,requests}=await rig(t);const r=await observe(client,SCOPE,plan("CONSUMED"));
 assert.equal(r.kind,"OBSERVED");assert.equal(r.stage,"CONSUMED");
 assert.equal(requests.length,7);assert.equal(requests.at(-1)?.path,`/v1/pages/${META}`);
});
for(const [name,blocks]of [
 ["different local method",()=>[para("marker-sales","H4-SALES"),...section("Méthode locale","Uniform method imposed by META"),...section("Orientation reçue",consumption())]],
 ["wrong consumed version",()=>[para("marker-sales","H4-SALES"),...section("Méthode locale",METHOD),...section("Orientation reçue",{...consumption(),version:0})]],
 ["foreign recipient",()=>[para("marker-sales","H4-SALES"),...section("Méthode locale",METHOD),...section("Orientation reçue",{...consumption(),recipient:{...RECIPIENT,principal_id:"another-sales"}})]],
 ]as const){
 test(`direction: ${name} is not consumed`,async t=>{
  const {client}=await rig(t,path=>path.includes(`/blocks/${SALES}`)?{body:{object:"list",results:blocks(),has_more:false,next_cursor:null}}:{});
  assert.deepEqual(await observe(client,SCOPE,plan("CONSUMED")),{kind:"UNCONFIRMED",reason:"CONTENT_MISMATCH"});
 });
}

// Break caught: a planned event, another object, missing source or a different horizon counted as a result.
test("direction: returned outcome matches its source, horizon, stage and local object",async t=>{
 const {client}=await rig(t);const r=await observe(client,SCOPE,plan("RETURNED"));
 assert.equal(r.kind,"OBSERVED");assert.equal(r.stage,"RETURNED");assert.equal(r.version,1);
});

// Break caught: forcing a new cap to erase the prior consumption/source/outcome records.
test("direction: versioned consumption and outcome coexist with prior history",async t=>{
 const p=plan("RETURNED");p.versions=[direction(),direction(2)];p.current=current(2);
 p.consumption={...consumption(),version:2,local_run_id:"RUN-B"};
 p.event={...event(),source_id:"EVENT-B",local_object_id:"LEAD-B"};
 p.outcome={...outcome(),version:2,source_id:"EVENT-B",local_object_id:"LEAD-B"};
 const {client}=await rig(t,path=>path.includes(`/blocks/${META}`)?{body:{object:"list",results:[para("marker","H4-META"),...section("Orientation version 1",direction()),...section("Orientation version 2",direction(2)),...section("CURRENT orientation",current(2))],has_more:false,next_cursor:null}}:
  path.includes(`/blocks/${SALES}`)?{body:{object:"list",results:[...salesBlocks(),...section("Orientation reçue version 2",p.consumption),...section("Preuve d’essai EVENT-B",p.event),...section("Résultat version 2",p.outcome)],has_more:false,next_cursor:null}}:{});
 assert.equal((await observe(client,SCOPE,p)).kind,"OBSERVED");
});

// Break caught: accepting two conflicting records with the same version identity.
test("direction: conflicting legacy and versioned consumption is ambiguous",async t=>{
 const {client}=await rig(t,path=>path.includes(`/blocks/${SALES}`)?{body:{object:"list",results:[...salesBlocks(),...section("Orientation reçue version 1",{...consumption(),local_run_id:"OTHER"})],has_more:false,next_cursor:null}}:{});
 assert.deepEqual(await observe(client,SCOPE,plan("CONSUMED")),{kind:"UNCONFIRMED",reason:"CONTENT_MISMATCH"});
});
for(const [name,source,returned]of [
 ["scheduled not held",{...event(),stage:"SCHEDULED"},outcome()],
 ["other local object",event(),{...outcome(),local_object_id:"OTHER-LEAD"}],
 ["event outside horizon",{...event(),occurred_at:"2026-10-22T00:00:00.000Z"},outcome()],
 ["unread source",{...event(),source_id:"OTHER-EVENT"},outcome()],
 ["inflated total",event(),{...outcome(),value:3}],
 ] as const){
 test(`direction: ${name} cannot become a sourced result`,async t=>{
  const {client}=await rig(t,path=>path.includes(`/blocks/${SALES}`)?{body:{object:"list",results:[para("marker-sales","H4-SALES"),...section("Méthode locale",METHOD),...section("Orientation reçue",consumption()),...section("Preuve d’essai",source),...section("Résultat remonté",returned)],has_more:false,next_cursor:null}}:{});
  assert.deepEqual(await observe(client,SCOPE,plan("RETURNED")),{kind:"UNCONFIRMED",reason:"CONTENT_MISMATCH"});
 });
}

// Break caught: incomplete/ambiguous transport promoted to success, or a cross-page CURRENT drift hidden.
for(const [name,body,reason] of [
 ["incomplete pagination",{object:"list",results:metaBlocks(),has_more:true,next_cursor:null},"INCOMPLETE_READ"],
 ["duplicate target",{object:"list",results:[...metaBlocks(),...section("CURRENT orientation",current()).map(b=>({...b,id:b.id+"-second"}))],has_more:false,next_cursor:null},"CONTENT_MISMATCH"],
 ["unknown nested blocks",{object:"list",results:[...metaBlocks(),{...para("nested","unread"),has_children:true}],has_more:false,next_cursor:null},"INCOMPLETE_READ"],
 ]as const){
 test(`direction: ${name} remains unconfirmed`,async t=>{
  const {client}=await rig(t,path=>path.includes("/children")?{body}:{});
  assert.deepEqual(await observe(client,SCOPE,plan()),{kind:"UNCONFIRMED",reason});
 });
}
test("direction: CURRENT changed while reading Sales invalidates the combined observation",async t=>{
 const {client}=await rig(t,(path,n)=>n===7?{body:{...page(META),last_edited_time:"2026-10-15T06:01:00.000Z"}}:{});
 assert.deepEqual(await observe(client,SCOPE,plan("RETURNED")),{kind:"UNCONFIRMED",reason:"CHANGED_DURING_READ"});
});
for(const [status,reason]of [[401,"AUTHENTICATION_REQUIRED"],[403,"ACCESS_DENIED"],[404,"NOT_FOUND_OR_INACCESSIBLE"],[429,"RATE_LIMITED"],[503,"SOURCE_UNAVAILABLE"]]as const){
 test(`direction: HTTP ${status} is localized without success or private payload`,async t=>{
  const {client}=await rig(t,()=>({status,body:{object:"error",code:"test_error",message:"DO NOT DISCLOSE"}}));
  assert.deepEqual(await observe(client,SCOPE,plan()),{kind:"UNCONFIRMED",reason});
 });
}
