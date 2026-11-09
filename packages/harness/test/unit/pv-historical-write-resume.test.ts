/** Local protocol rehearsal, not a historical OS migration or a real ChatGPT host test.
 * Real commit/executor/TARGET/FINAL/store and fresh MCP clients; only Notion transport is local.
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import {createServer} from "../../src/index.ts";
import {draftHistoricalSchemaAdditions} from "../../src/migration/historicalSchemaDraft.ts";
import {propText,type Page} from "../../src/notion/shapes.ts";
import {B0_KEY,configRow,G,guardWorld,index,rowsOf,NOW,type GuardWorld} from "../support/guard-fixtures.ts";
import {IDS} from "./sales-fixtures.ts";
import {R} from "./resume-fixtures.ts";
import {OWNER} from "./binding-fixtures.ts";
import {text} from "./meta-fixtures.ts";

type Schema={properties:Record<string,{type:string;select?:{options:{name:string}[]}}>};
const KEY="LOCAL_REHEARSAL:FOLLOWUP_NOTE";
const NOTE="J’ai eu le prospect : il préfère être recontacté mardi.";
const sourceGoal="Conserver le résultat commercial déjà confirmé";
const fields=["Category","State","Value","Version","Source"];
const intent={intent:{action_class:"COMMIT",summary:"Record the user's exact follow-up note",mutations:[{
 logical_resource_key:"SALES:BUSINESS_CONFIG",operation:"UPSERT",record_selector:{natural_key:KEY},
 desired_changes:{Category:"OTHER",State:"HYPOTHESIS",Value:NOTE,Version:"SALES_INPUT/1",Source:"CHAT_USER_EXPLICIT"},
}]}};

function world(){
 const g=guardWorld({gate:"B1_OFFER",configs:[configRow("historical-goal",B0_KEY,{category:"GOAL",value:sourceGoal})],
  doc:index([],[{class:"PRODUCTION",resource_key:"SALES:BUSINESS_CONFIG",operation:"UPSERT",allowed_fields:fields}])});
 const manifest=IDS("rep-a"),schema=structuredClone(g.map.get(`data_source:${manifest.manifestDs}`)??{properties:{Name:{type:"title"}}}) as Schema;
 schema.properties["Current Gate"]={type:"rich_text"};g.map.set(`data_source:${manifest.manifestDs}`,schema);
 const row=g.map.get(`page:${manifest.manifestRow}`) as Page;
 g.map.set(`page:${manifest.manifestRow}`,{...row,properties:{...row.properties,"Current Gate":{type:"rich_text",rich_text:[text("legacy gate literal remains unchanged")]}}});
 return {g,manifest};
}

async function session(g:GuardWorld){
 const server=createServer(g.deps,OWNER.principal_id),client=new Client({name:"historical-write-rehearsal",version:"1"});
 const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
 return {async call(name:string,args:Record<string,unknown>){const r=await client.callTool({name,arguments:args});assert.equal(r.isError,false);
  return JSON.parse((r.content as {text:string}[])[0]!.text) as Record<string,any>;},
  async close(){await client.close();await server.close();}};
}

// Break caught: missing backend journal links being detected only after an unfinished Run was opened.
test("historical write rehearsal: missing journal fields refuse without altering any historical value",async t=>{
 t.mock.timers.enable({apis:["Date"],now:NOW});
 const {g}=world(),s=await session(g);
 try{
  const bound=await s.call("os_bind",{lane:"SALES"});assert.equal(bound.status,"OK",JSON.stringify(bound));const handle=bound.result.binding_handle;await g.approve();
  for(const [ds,names]of [[R.salesRunsDs,["Harness Plan ID"]],[R.salesLedgerDs,["Harness Plan ID","Target Receipt ID"]]] as const){
   const schema=structuredClone(g.map.get(`data_source:${ds}`) as Schema);for(const name of names)delete schema.properties[name];g.map.set(`data_source:${ds}`,schema);
  }
  const before=structuredClone([...g.map]);
  const refused=await s.call("os_commit",{binding_handle:handle,...intent});
  assert.equal(refused.kind,"HELD");assert.equal(refused.code,"HOLD_SCHEMA_MISMATCH");assert.equal(refused.wrote_anything,false);
  assert.equal(g.client.writes.length,0);assert.deepEqual([...g.map],before);
  assert.deepEqual(await g.deps.store.plans.listByRuntime("VERTIGO","SALES",bound.binding.runtime_generation),[]);
 }finally{await s.close();}
});

// Break caught: additive preparation resetting old values, unverified writes being declared saved, or a fresh client replaying work.
test("historical write rehearsal: local additive journal preparation saves once and a fresh client resumes the same durable business state",async t=>{
 t.mock.timers.enable({apis:["Date"],now:NOW});
 const {g,manifest}=world(),oldGoal=structuredClone(rowsOf(g.map,G.configDs)[0]);
 const oldManifest=structuredClone(g.map.get(`page:${manifest.manifestRow}`)),first=await session(g);
 let handle:string,planId:string,runCount:number,writes:number;
 try{
  const bound=await first.call("os_bind",{lane:"SALES"});assert.equal(bound.status,"OK",JSON.stringify(bound));handle=String(bound.result.binding_handle);await g.approve();
  for(const [ds,properties]of [[R.salesRunsDs,{"Harness Plan ID":"rich_text"}],[R.salesLedgerDs,{"Harness Plan ID":"rich_text","Target Receipt ID":"rich_text"}]] as const){
   const schema=structuredClone(g.map.get(`data_source:${ds}`) as Schema);
   for(const key of Object.keys(properties))delete schema.properties[key];
   const projection=draftHistoricalSchemaAdditions(schema,{properties});assert.equal(projection.status,"DRAFT_ADDITIONS_ONLY");
   assert.equal(projection.writer_authorized,false);g.map.set(`data_source:${ds}`,projection.projected_schema);
  }
  const saved=await first.call("os_commit",{binding_handle:handle,...intent});
  assert.equal(saved.kind,"PERSISTED",JSON.stringify(saved));assert.equal(saved.step_moved,false);
  planId=String(saved.plan_id);assert.equal((await g.deps.store.plans.get(planId))?.plan_state,"FINAL_VERIFIED");
  const targets=await g.deps.store.receipts.findByPlan(planId,"TARGET"),finals=await g.deps.store.receipts.findByPlan(planId,"FINAL");
  assert.equal(targets.length,1);assert.equal(finals.length,1);assert.equal(finals[0]!.target_receipt_id,targets[0]!.receipt_id);
  const note=rowsOf(g.map,G.configDs).filter(p=>propText(p,"Config Item")===KEY);assert.equal(note.length,1);assert.equal(propText(note[0]!,"Value"),NOTE);
  writes=g.client.writes.length;runCount=rowsOf(g.map,R.salesRunsDs).length;
  const mapBeforeRepeat=structuredClone([...g.map]);
  const again=await first.call("os_commit",{binding_handle:handle,...intent});assert.equal(again.kind,"PERSISTED");assert.equal(again.repeated,true);
  assert.equal(again.plan_id,planId);assert.equal(g.client.writes.length,writes);assert.equal(rowsOf(g.map,R.salesRunsDs).length,runCount);
  assert.deepEqual([...g.map],mapBeforeRepeat,"a reported replay cannot hide a second Run, mutation or target write");
  assert.deepEqual(await g.deps.store.receipts.findByPlan(planId,"TARGET"),targets);
  assert.deepEqual(await g.deps.store.receipts.findByPlan(planId,"FINAL"),finals);
 }finally{await first.close();}
 const fresh=await session(g);
 try{
  const bound=await fresh.call("os_bind",{lane:"SALES"});assert.equal(bound.status,"OK",JSON.stringify(bound));const nextHandle=String(bound.result.binding_handle);assert.notEqual(nextHandle,handle!);
  const resumed=await fresh.call("os_resume",{binding_handle:nextHandle});assert.equal(resumed.code,"RESUMED",JSON.stringify(resumed));
  assert.equal(resumed.result.gate.gate_key,"B1_OFFER");assert.equal(g.client.writes.length,writes!);assert.equal(rowsOf(g.map,R.salesRunsDs).length,runCount!);
  assert.equal(rowsOf(g.map,G.configDs).filter(p=>propText(p,"Config Item")===KEY).length,1);
  assert.deepEqual(rowsOf(g.map,G.configDs).find(p=>propText(p,"Config Item")===B0_KEY),oldGoal);
  assert.deepEqual(g.map.get(`page:${manifest.manifestRow}`),oldManifest);
  assert.equal((await g.deps.store.plans.get(planId!))?.plan_state,"FINAL_VERIFIED");
 }finally{await fresh.close();}
});
