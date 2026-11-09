import {test} from "node:test";
import assert from "node:assert/strict";
import {qualifyHistoricalRollback} from "../support/historical-rollback-model.ts";

const property=(type:string,value:unknown)=>({id:`p-${type}`,type,[type]:value});
function fixture(){
  const source={id:"historical-source",parent:{database_id:"historical-db"},properties:{
    Name:{id:"title",type:"title",title:{}},
    Gate:{id:"gate",type:"rich_text",rich_text:{}},
    When:{id:"date",type:"date",date:{}},
    State:{id:"state",type:"select",select:{options:[{id:"old",name:"RETIRED",color:"gray"}]}},
    Related:{id:"relation",type:"relation",relation:{database_id:"another-historical-db"}}
  }};
  const applied=structuredClone(source) as any;
  applied.properties.HarnessNote={id:"added",type:"rich_text",rich_text:{}};
  applied.properties.State.select.options.push({id:"new",name:"ACTIVE",color:"green"});
  const rows=[{id:"historical-row",parent:{data_source_id:"historical-source"},last_edited_time:"2030-01-02T03:04:05+02:00",properties:{
    Name:property("title",[{text:{content:"Existing account"}}]),Gate:property("rich_text",[{text:{content:"READY"}}]),
    When:property("date",{start:"2029-12-31",end:"2030-01-02",time_zone:"Europe/Paris"}),
    State:property("select",{id:"old",name:"RETIRED",color:"gray"}),
    Related:property("relation",[{id:"historical-related-row"}]),HarnessNote:{id:"added",type:"rich_text",rich_text:[]}
  }}];
  return {source,applied,current:structuredClone(applied),pages:[{results:rows,has_more:false,next_cursor:null}]};
}
function run(f:ReturnType<typeof fixture>){
  assert.equal(typeof qualifyHistoricalRollback,"function","a rollback model is missing; schema-only drafts cannot prove row-safe reversal");
  return qualifyHistoricalRollback(f.source,f.applied,f.current,f.pages);
}
// Break caught: rolling back by restoring the whole old schema/row snapshot loses legitimate later edits.
test("historical rollback model preserves current old-field edits, dates, retired state and relations",()=>{
  const f=fixture(),before=structuredClone(f);
  f.current.properties.Gate.rich_text={annotation:"concurrent schema metadata"} as any;
  f.pages[0]!.results[0]!.properties.Gate.rich_text=[{text:{content:"Concurrent latest decision"}}];
  const current=structuredClone(f),r=run(f);assert.equal(r.status,"LOCAL_ROLLBACK_SAFE");
  assert.ok(r.schema);
  assert.deepEqual(r.schema.properties.Gate,f.current.properties.Gate);
  const expectedRow=structuredClone(f.pages[0]!.results[0]) as any;delete expectedRow.properties.HarnessNote;
  assert.deepEqual(r.rows,[expectedRow]);
  assert.deepEqual(r.schema.properties.When,before.source.properties.When);
  assert.deepEqual(r.schema.properties.Related,before.source.properties.Related);
  assert.deepEqual(r.schema.properties.State.select.options,[{id:"old",name:"RETIRED",color:"gray"}]);
  assert.equal(Object.hasOwn(r.schema.properties,"HarnessNote"),false);
  assert.deepEqual(f,current,"qualification must not mutate any input");
  assert.equal(r.native_restore_proved,false);assert.equal(r.execution_authorized,false);
});
// Break caught: deleting a migration column once a user has put information into it.
test("historical rollback model withholds every reversal when an added field contains data",()=>{
  const f=fixture();f.pages[0]!.results[0]!.properties.HarnessNote.rich_text=[{text:{content:"Do not lose me"}}] as any;
  const r=run(f);assert.equal(r.status,"HOLD");assert.equal(r.code,"ADDED_FIELD_IN_USE");assert.equal(r.schema,null);assert.equal(r.rows,null);
});
// Break caught: removing a select option still in use by a historical row.
test("historical rollback model refuses a used added select option",()=>{
  const f=fixture();f.pages[0]!.results[0]!.properties.State.select={id:"new",name:"ACTIVE",color:"green"};
  const r=run(f);assert.equal(r.status,"HOLD");assert.equal(r.code,"ADDED_OPTION_IN_USE");assert.equal(r.schema,null);
});
test("historical rollback model keeps unrelated concurrent options but refuses a changed own addition",()=>{
  const f=fixture();f.current.properties.State.select.options.push({id:"later",name:"LATER",color:"blue"});
  const r=run(f);assert.equal(r.status,"LOCAL_ROLLBACK_SAFE");
  assert.ok(r.schema);
  assert.deepEqual(r.schema.properties.State.select.options,[{id:"old",name:"RETIRED",color:"gray"},{id:"later",name:"LATER",color:"blue"}]);
  const changed=fixture();changed.current.properties.HarnessNote.rich_text={edited:true};
  assert.equal(run(changed).code,"OWN_SCHEMA_DELTA_CHANGED");
});
// Break caught: incomplete, duplicated or truncated provider rows being interpreted as a safe empty field.
test("historical rollback model rejects incomplete row coverage and source type replacement",()=>{
  const missing=fixture();missing.pages[0]!.has_more=true;
  assert.equal(run(missing).code,"ROW_WINDOW_INCOMPLETE");
  const duplicate=fixture();duplicate.pages[0]!.results.push(structuredClone(duplicate.pages[0]!.results[0]!));
  assert.equal(run(duplicate).code,"ROW_WINDOW_INVALID");
  const truncated=fixture();(truncated.pages[0]!.results[0]!.properties.Related as any).has_more=true;
  assert.equal(run(truncated).code,"ROW_WINDOW_INVALID");
  const lossy=fixture();lossy.applied.properties.Gate={id:"gate",type:"select",select:{options:[]}};
  assert.equal(run(lossy).code,"NOT_AN_ADDITIVE_DELTA");
});

// Break caught: JSON serialization silently dropping a cell/schema member or normalizing a number.
test("historical rollback model rejects non-JSON values instead of normalizing or dropping them",()=>{
  for(const value of [undefined,NaN,Infinity,()=>{},new Date("2030-01-01T00:00:00Z")]){
    const f=fixture();f.current.properties.Gate.extra=value;
    assert.equal(run(f).code,"INVALID_LOCAL_INPUT");
  }
});
test("historical rollback model treats zero in an added numeric field as data, not an empty default",()=>{
  const f=fixture();f.applied.properties.Count={id:"count",type:"number",number:{}};f.current=structuredClone(f.applied);
  (f.pages[0]!.results[0]!.properties as any).Count={id:"count",type:"number",number:0};
  assert.equal(run(f).code,"ADDED_FIELD_IN_USE");
});
// Break caught: a schema migration that also renames/edits native metadata being mislabeled additions-only.
test("historical rollback model rejects applied metadata edits but preserves later legitimate edits",()=>{
  const f=fixture();f.applied.title=[{plain_text:"Renamed during migration"}];f.current=structuredClone(f.applied);
  assert.equal(run(f).code,"NOT_AN_ADDITIVE_DELTA");
  const later=fixture();later.current.title=[{plain_text:"Later concurrent title"}];
  const r=run(later);assert.equal(r.status,"LOCAL_ROLLBACK_SAFE");assert.ok(r.schema);
  assert.deepEqual(r.schema.title,[{plain_text:"Later concurrent title"}]);
});
