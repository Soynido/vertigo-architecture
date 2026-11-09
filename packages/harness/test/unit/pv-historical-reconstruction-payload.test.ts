import {test} from "node:test";
import assert from "node:assert/strict";
import * as reconstruction from "../support/historical-reconstruction-payload.ts";

const prop=(type:string,v:unknown)=>({id:`p-${type}`,type,[type]:v});
function fixture(){return {key:"HISTORICAL",typed_schema:{db_id:"source-db",ds_id:"source-ds",properties:{
  Name:{type:"title",title:{}},Notes:{type:"rich_text",rich_text:{}},State:{type:"select",select:{options:[{name:"O'Reilly",color:"gray"}]}},
  When:{type:"date",date:{}},Count:{type:"number",number:{format:"number"}},Done:{type:"checkbox",checkbox:{}},
  Ref:{type:"relation",relation:{data_source_id:"source-target",type:"single_property"}},ID:{type:"unique_id",unique_id:{prefix:"OLD"}}
}},typed_rows:[{id:"source-row",parent:{data_source_id:"source-ds"},created_time:"2020-01-01T00:00:00Z",properties:{
  Name:prop("title",[{type:"text",text:{content:"Old *account*",link:null},annotations:{bold:false,color:"default"}}]),
  Notes:prop("rich_text",[{type:"text",text:{content:"Keep this",link:{url:"https://example.org/a"}},annotations:{bold:true,color:"default"}},
    {type:"mention",mention:{type:"page",page:{id:"source-related"}},plain_text:"Related",annotations:{color:"default"}}]),
  State:prop("select",{name:"O'Reilly",color:"gray"}),When:prop("date",{start:"2020-01-02",end:"2020-01-03",time_zone:null}),
  Count:prop("number",0),Done:prop("checkbox",false),Ref:prop("relation",[{id:"source-related"}]),ID:prop("unique_id",{number:42,prefix:"OLD"})
}}]};}
const context={copy:"D1",createdIds:["copy-related","copy-target"],sourceIds:["source-row","source-related","source-target","source-db","source-ds","source-other"]};
function api(){assert.equal(typeof reconstruction.reconstructionSchema,"function","native reconstruction payload compiler is missing");return reconstruction as any;}
// Break caught: flattening old rich-text/date/zero/false cells or assigning old generated metadata as new native values.
test("reconstruction emits typed schema and historical provenance without generated-value writes",()=>{
  const f=fixture(),a=api();
  assert.equal(a.reconstructionSchema(f,context),`CREATE TABLE ("Name" TITLE, "Notes" RICH_TEXT, "State" SELECT('O''Reilly':gray), "When" DATE, "Count" NUMBER FORMAT 'number', "Done" CHECKBOX, "ID" UNIQUE_ID PREFIX 'W73D1-HIST' COMMENT 'COPY-GENERATED; historical values retained in source provenance', "W73 Source ID" RICH_TEXT, "W73 Nonactive" CHECKBOX)`);
  const row=a.reconstructionRow(f,f.typed_rows[0],{"source-related":"copy-related"},context);
  assert.equal(row.properties.Name,"Old *account*");
  assert.equal(row.properties.Notes,'Keep thishttps://www.notion.so/copyrelated');
  assert.deepEqual(row.properties.Ref,["copy-related"]);
  assert.equal(row.properties.Count,0);assert.equal(row.properties.Done,"__NO__");
  assert.equal(row.properties["date:When:end"],"2020-01-03");assert.equal(row.properties["date:When:is_datetime"],0);
  assert.equal(row.properties["W73 Nonactive"],"__YES__");assert.equal(row.properties["W73 Source ID"],"source-row");
  assert.equal(Object.hasOwn(row.properties,"ID"),false);
  assert.deepEqual(JSON.parse(row.content.split('```json\n')[1].split('\n```')[0]),f.typed_rows[0]);
});
// Break caught: pointing a test-copy relation at a source row or the other copy because the target map is incomplete.
test("reconstruction holds missing relation maps and maps schemas only after targets exist",()=>{
  const f=fixture(),a=api();assert.throws(()=>a.reconstructionRow(f,f.typed_rows[0],{},context),/UNMAPPED/);
  assert.throws(()=>a.reconstructionRelations(f,{},context),/UNMAPPED/);
  assert.equal(a.reconstructionRelations(f,{"source-target":"copy-target"},context),`ADD COLUMN "Ref" RELATION('copy-target')`);
  assert.throws(()=>a.reconstructionRow(f,f.typed_rows[0],{"source-related":"source-related"},context),/SOURCE_TARGET/);
  assert.throws(()=>a.reconstructionRow(f,f.typed_rows[0],{"source-related":"source-other"},context),/SOURCE_TARGET/);
  assert.throws(()=>a.reconstructionRow(f,f.typed_rows[0],{"source-related":"copy-D2"},context),/OUTSIDE_COPY/);
});
test("reconstruction rejects unsupported or truncated input instead of dropping source information",()=>{
  const a=api(),f=fixture();(f.typed_rows[0]!.properties.Ref as any).has_more=true;
  assert.throws(()=>a.reconstructionRow(f,f.typed_rows[0],{"source-related":"copy-related"},context),/TRUNCATED/);
  const missing=fixture();delete (missing.typed_rows[0]!.properties as any).Count;
  assert.throws(()=>a.reconstructionRow(missing,missing.typed_rows[0],{"source-related":"copy-related"},context),/MISSING_PROPERTY/);
  const collision=fixture();(collision.typed_schema.properties as any)["W73 Source ID"]={type:"rich_text",rich_text:{}};
  assert.throws(()=>a.reconstructionSchema(collision,context),/RESERVED_PROPERTY/);
});
// Break caught: recreating a page outside the approved twenty-table scope or treating a source-only mention as a copied relation.
test("explicit outside-scope mentions remain readonly source links with exact raw provenance",()=>{
  const f=fixture(),a=api();(f.typed_rows[0]!.properties.Ref as any).relation=[];
  const row=a.reconstructionRow(f,f.typed_rows[0],{},context,false,["source-related"]);
  assert.equal(row.properties.Notes,'Keep thishttps://www.notion.so/sourcerelated');
  assert.deepEqual(row.properties.Ref,[]);
  assert.deepEqual(JSON.parse(row.content.split('```json\n')[1].split('\n```')[0]),f.typed_rows[0]);
});
test("raw provenance escapes fence delimiters and refuses unschemed or parentless source rows",()=>{
  const f=fixture(),a=api();(f.typed_rows[0]!.properties.Notes as any).rich_text[0].text.content='```<database url="https://notion.so/source"/>```';
  const row=a.reconstructionRow(f,f.typed_rows[0],{"source-related":"copy-related"},context);
  const raw=row.content.split('```json\n')[1].split('\n```')[0];assert.equal(raw.includes('```'),false);
  assert.deepEqual(JSON.parse(raw),f.typed_rows[0]);
  const extra=fixture();(extra.typed_rows[0]!.properties as any).Hidden=prop("rich_text",[]);
  assert.throws(()=>a.reconstructionRow(extra,extra.typed_rows[0],{"source-related":"copy-related"},context),/UNSCHEMED_PROPERTY/);
  const noParent=fixture();delete (noParent.typed_rows[0] as any).parent;
  assert.throws(()=>a.reconstructionRow(noParent,noParent.typed_rows[0],{"source-related":"copy-related"},context),/WRONG_SOURCE_PARENT/);
});

const nativeSchema=()=>({name:"Isolated test copy",schema:{Name:{type:"title"},Origin:{type:"select",options:[
  {name:"USER",color:"blue",url:"old-user-option"},{name:"O'Reilly",color:"gray",url:"old-quoted-option"}
]}}});
function additionsApi(){const a=reconstruction as any;assert.equal(typeof a.reconstructionAdditionPlan,"function","copy-only addition planner is missing");return a;}
// Break caught: replacing existing select choices or editing old columns while preparing a copy rehearsal.
test("copy addition plan preserves every old option and emits only owned additive DDL",()=>{
  const a=additionsApi(),state=nativeSchema(),before=structuredClone(state),ctx={...context,createdIds:[...context.createdIds,"copy-ds"]};
  const p=a.reconstructionAdditionPlan("copy-ds",state,{properties:['New "field'],options:{Origin:["PLUGIN"]}},ctx);
  assert.equal(p.statements,`ADD COLUMN "New ""field" RICH_TEXT; ALTER COLUMN "Origin" SET SELECT('USER':blue, 'O''Reilly':gray, 'PLUGIN':default)`);
  assert.deepEqual(state,before);
  assert.equal(p.execution_authorized,false);assert.equal(p.native_restore_proved,false);
  assert.deepEqual(p.rollback_prerequisites.owned_added_properties,['New "field']);
  assert.deepEqual(p.rollback_prerequisites.owned_added_options,{Origin:["PLUGIN"]});
  assert.equal(p.rollback_prerequisites.full_fresh_row_read_required,true);
  assert.equal(p.rollback_prerequisites.used_or_changed_addition,"REFUSE");
  assert.equal(p.statements.includes("DROP"),false);
  assert.match(p.expected_schema_sha256,/^[a-f0-9]{64}$/);
  const changed=nativeSchema();changed.schema.Origin.options[0]!.name="CONCURRENT";
  assert.notEqual(a.reconstructionAdditionPlan("copy-ds",changed,{properties:['New "field'],options:{Origin:["PLUGIN"]}},ctx).expected_schema_sha256,p.expected_schema_sha256);
});
// Break caught: handing a seemingly harmless schema command to the original or a different test copy.
test("copy addition plan rejects source targets and anything outside its single D1 allowlist",()=>{
  const a=additionsApi(),state=nativeSchema(),change={properties:["Harness Plan ID"],options:{}};
  assert.throws(()=>a.reconstructionAdditionPlan("source-ds",state,change,{...context,createdIds:["source-ds"]}),/SOURCE_TARGET/);
  assert.throws(()=>a.reconstructionAdditionPlan("D2-ds",state,change,context),/OUTSIDE_COPY/);
  assert.throws(()=>a.reconstructionAdditionPlan("copy-related",state,change,{...context,copy:"D2"}),/D1_ONLY/);
});
// Break caught: treating an uncertain prior write or a non-select type conflict as permission to overwrite it.
test("copy addition plan holds collisions, duplicate changes and unsupported option types",()=>{
  const a=additionsApi(),state=nativeSchema(),ctx={...context,createdIds:["copy-ds"]};
  assert.throws(()=>a.reconstructionAdditionPlan("copy-ds",state,{properties:["Name"],options:{}},ctx),/EXISTING_PROPERTY/);
  assert.throws(()=>a.reconstructionAdditionPlan("copy-ds",state,{properties:["New","New"],options:{}},ctx),/DUPLICATE/);
  assert.throws(()=>a.reconstructionAdditionPlan("copy-ds",state,{properties:[],options:{Origin:["USER"]}},ctx),/EXISTING_OPTION/);
  assert.throws(()=>a.reconstructionAdditionPlan("copy-ds",state,{properties:[],options:{Origin:["NEW","NEW"]}},ctx),/DUPLICATE/);
  assert.throws(()=>a.reconstructionAdditionPlan("copy-ds",state,{properties:[],options:{Name:["NEW"]}},ctx),/UNSUPPORTED_OPTION_TYPE/);
});
