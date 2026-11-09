/** Bounded source/journal inspection, no installer, provider, writer, replay or adoption. */
import type {NotionReadClient} from "../notion/readClient.ts";
import {normalizeId} from "../notion/shapes.ts";
import type {ResolvedRuntime} from "../resolvers/types.ts";
type Obj=Record<string,unknown>;
const object=(x:unknown):x is Obj=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const LIMITS={reads:40,rows_per_table:100,journal_rows_per_table:5,response_bytes:64*1024} as const;
const FIELDS={
 INSTANCE_MANIFEST:{Name:"title","Instance ID":"rich_text",Owner:"rich_text","Install State":"select","Instance Status":"select","Current Gate":"rich_text","Current Gate Status":"select","Last Verified At":"date","Sales Contract Version":"rich_text","Schema Version":"rich_text"},
 OS_STATE:{Name:"title","Current Gate":"select","Current Gate Status":"select","Build State":"select","Next Action":"rich_text","Next Question":"rich_text","Last Verified At":"date","Open Blocker":"rich_text","Recovery Required":"checkbox","Persistence Health":"select","Last Run Ref":"rich_text","Last Verified Mutation":"rich_text"},
 BUSINESS_CONFIG:{"Config Item":"title",Category:"select",State:"select",Value:"rich_text",Version:"rich_text",Source:"rich_text","Effective At":"date",Notes:"rich_text","Config ID":"unique_id"},
 RUNTIME_CONFIG:{Config:"title",Type:"select",State:"select",Value:"rich_text",Source:"rich_text","Effective At":"date","Config ID":"unique_id",Created:"created_time","Last Edited":"last_edited_time"},
 RUNS:{Run:"title","Run ID":"unique_id",Status:"select","Run Type":"select",Origin:"select","Recovery Required":"checkbox","Next Action":"rich_text",Holds:"rich_text","Mutation Count":"number","Verified Mutation Count":"number",Started:"date",Finished:"date","Verified At":"date","Mutation IDs":"rich_text","Receipts Summary":"rich_text"},
 MUTATION_LEDGER:{Mutation:"title","Mutation ID":"unique_id",Status:"select",Run:"relation","Run Ref":"rich_text","Target URL":"url","Target Ref":"rich_text","Idempotency Key":"rich_text","Natural Key":"rich_text",Operation:"select","Compared Fields":"rich_text","After Expected Hash":"rich_text","After Observed Summary":"rich_text","Written At":"date","Verified At":"date"},
 RECEIPTS:{Receipt:"title","Receipt ID":"unique_id",Verified:"checkbox","Gmail Message ID":"rich_text","Gmail Thread ID":"rich_text","Idempotency Key":"rich_text","Source System":"select","Source Account":"rich_text","Source Event ID":"rich_text","Source Confidence":"select","Event Type":"select","Event Timestamp":"date","Observed At":"date",Account:"relation",Contact:"relation"},
} as const;
type Role=keyof typeof FIELDS;
type Table={status:"COMPLETE"|"PARTIAL"|"UNAVAILABLE";database_ref?:string;data_source_ref?:string;has_more:boolean|"UNKNOWN";omitted_columns:string[];observed_rows:{page_ref:string;last_edited_time?:string;values:Obj}[]};
// Preserve the existing operating context first; recent journal windows never evict it.
const ROLES:Role[]=["OS_STATE","INSTANCE_MANIFEST","BUSINESS_CONFIG","RUNTIME_CONFIG","RUNS","MUTATION_LEDGER","RECEIPTS"];
const JOURNALS=new Set<Role>(["RUNS","MUTATION_LEDGER","RECEIPTS"]);
const TITLES:Record<Role,string>={OS_STATE:"Name",INSTANCE_MANIFEST:"Name",BUSINESS_CONFIG:"Config Item",RUNTIME_CONFIG:"Config",RUNS:"Run",MUTATION_LEDGER:"Mutation",RECEIPTS:"Receipt"};
const REQUIRED:Record<Role,readonly string[]>={OS_STATE:["Name","Current Gate","Next Action","Next Question","Last Verified At"],INSTANCE_MANIFEST:["Name","Current Gate","Sales Contract Version","Schema Version"],BUSINESS_CONFIG:["Config Item","State","Value","Version"],RUNTIME_CONFIG:["Config","State","Value","Source"],RUNS:["Run","Status","Recovery Required","Next Action"],MUTATION_LEDGER:["Mutation","Status"],RECEIPTS:["Receipt","Verified","Idempotency Key"]};
const blank=():Table=>({status:"UNAVAILABLE",has_more:"UNKNOWN",omitted_columns:[],observed_rows:[]});
const active=(x:Obj)=>x.archived===false&&x.in_trash!==true;
function parent(x:Obj,kind:string,ref:string){return object(x.parent)&&x.parent.type===kind&&normalizeId(String(x.parent[kind]))===ref;}
function value(p:unknown,type:string):unknown{
 if(!object(p)||p.type!==type)throw Error("CELL_TYPE_MISMATCH");const v=p[type];
 if(type==="rich_text"||type==="title"){if(!Array.isArray(v)||v.some(x=>!object(x)||typeof x.plain_text!=="string"))throw Error("TEXT_INVALID");return v.map(x=>x.plain_text).join("");}
 if(type==="select"){if(v===null)return null;if(!object(v)||typeof v.name!=="string")throw Error("SELECT_INVALID");return v.name;}
 if(type==="checkbox"){if(typeof v!=="boolean")throw Error("CHECKBOX_INVALID");return v;}
 if(type==="date"){if(v===null)return null;if(!object(v)||typeof v.start!=="string"||(v.end!==null&&typeof v.end!=="string")||(v.time_zone!==null&&typeof v.time_zone!=="string"))throw Error("DATE_INVALID");return {start:v.start,end:v.end,time_zone:v.time_zone};}
 if(type==="unique_id"){if(!object(v)||!Number.isSafeInteger(v.number)||(v.prefix!==null&&typeof v.prefix!=="string"))throw Error("UNIQUE_ID_INVALID");return {number:v.number,prefix:v.prefix};}
 if(type==="number"){if(v!==null&&(typeof v!=="number"||!Number.isFinite(v)))throw Error("NUMBER_INVALID");return v;}
 if(type==="url"){if(v!==null&&typeof v!=="string")throw Error("URL_INVALID");return v;}
 if(type==="relation"){if(p.has_more===true||!Array.isArray(v)||v.some(x=>!object(x)||typeof x.id!=="string"||!normalizeId(x.id)))throw Error("RELATION_INCOMPLETE_OR_INVALID");return v.map(x=>normalizeId((x as Obj).id as string));}
 if(type==="created_time"||type==="last_edited_time"){if(typeof v!=="string")throw Error("TIMESTAMP_INVALID");return v;}
 throw Error("TYPE_UNSUPPORTED");
}
export async function readLegacyOperatingState(client:NotionReadClient,runtime:ResolvedRuntime){
 const tables:Record<Role,Table>={INSTANCE_MANIFEST:blank(),OS_STATE:blank(),BUSINESS_CONFIG:blank(),RUNTIME_CONFIG:blank(),RUNS:blank(),MUTATION_LEDGER:blank(),RECEIPTS:blank()},issues:{role:string;code:string}[]=[];
 let reads=0;const checked_at=new Date().toISOString(),root=normalizeId(runtime.root_ref),parents=new Map<string,{ref:string;blocks:Obj[]}>();
 const snapshot=()=>({mode:"LEGACY_READ_ONLY" as const,trust:"SOURCE_DATA_ONLY" as const,effectivity:"NOT_EVALUATED" as const,atomic:false as const,stability:"NOT_VERIFIED" as const,
  status:issues.length?(Object.values(tables).some(t=>t.observed_rows.length)?"PARTIAL":"UNAVAILABLE"):"COMPLETE",migration_pending:true,write_capability:"DENIED" as const,native_capabilities:"NOT_VERIFIED" as const,production_readiness:"NOT_VERIFIED" as const,
  checked_at,reads,limits:LIMITS,root_ref:root,recorded_state:{source_ref:tables.OS_STATE.observed_rows[0]?.page_ref,
   current_gate:tables.OS_STATE.observed_rows[0]?.values["Current Gate"]??null,last_verified_at:(tables.OS_STATE.observed_rows[0]?.values["Last Verified At"] as Obj|undefined)?.start??null,
   next_action:tables.OS_STATE.observed_rows[0]?.values["Next Action"]??null,next_question:tables.OS_STATE.observed_rows[0]?.values["Next Question"]??null,
   open_blocker:tables.OS_STATE.observed_rows[0]?.values["Open Blocker"]??null,
   last_run_ref:tables.OS_STATE.observed_rows[0]?.values["Last Run Ref"]??null,last_verified_mutation:tables.OS_STATE.observed_rows[0]?.values["Last Verified Mutation"]??null},
  transaction_history:{trust:"SOURCE_DATA_ONLY" as const,adopted:false as const,source_verified:false as const,ordering:"LAST_EDITED_DESC" as const,runs:tables.RUNS,mutations:tables.MUTATION_LEDGER,receipts:tables.RECEIPTS},
  manifest:tables.INSTANCE_MANIFEST,business_configuration:tables.BUSINESS_CONFIG,runtime_configuration:tables.RUNTIME_CONFIG,state:tables.OS_STATE,issues});
 const issue=(role:string,code:string)=>issues.push({role,code});
 if(!root||runtime.lane!=="SALES"||runtime.access_mode!=="BUSINESS"||runtime.operation_policy!=="LEGACY_READ_ONLY"
  ||!runtime.adapter.legacy_read_bridge_schema||runtime.manifest_pins.spec!==runtime.adapter.version
  ||runtime.manifest_pins.schema!==runtime.adapter.legacy_read_bridge_schema){
  issue("RUNTIME","LEGACY_READ_NOT_ADMITTED");return snapshot();
 }
 async function read(fn:()=>Promise<unknown>){if(reads>=LIMITS.reads)throw Error("READ_LIMIT");reads++;return fn();}
 async function children(ref:string){const x=await read(()=>client.retrieveBlockChildren(ref));if(!object(x)||!Array.isArray(x.results)||x.has_more!==false||x.next_cursor!==null)throw Error("INCOMPLETE_CHILD_WINDOW");
  const seen=new Set<string>();for(const b of x.results){if(!object(b)||!active(b)||!parent(b,"page_id",ref)||!normalizeId(String(b.id))||seen.has(String(b.id)))throw Error("CHILD_CONTAINMENT_INVALID");seen.add(String(b.id));}return x.results as Obj[];}
 function child(blocks:Obj[],kind:string,title:string){const found=blocks.filter(x=>x.type===kind&&object(x[kind])&&(x[kind] as Obj).title===title);if(found.length!==1)throw Error("CHILD_MISSING_OR_AMBIGUOUS");return normalizeId(String(found[0]!.id))!;}
 let top:Obj[];
 try{const p=await read(()=>client.retrievePage(root));if(!object(p)||!active(p)||normalizeId(String(p.id))!==root)throw Error("ROOT_INVALID");top=await children(root);}
 catch{issue("ROOT","ROOT_READ_UNAVAILABLE");return snapshot();}
 for(const role of ROLES){const table=tables[role];
  try{
   const specs=runtime.adapter.controlPlane.installContract?.physicalResources.filter(x=>x.key===role),spec=specs?.[0];
   if(specs?.length!==1||!spec||spec.objectType!=="DATABASE"||spec.path.length!==2)throw Error("DECLARED_PATH_INVALID");
   const parentTitle=spec.path[0]!,dbTitle=spec.path[1]!;
   if(!parents.has(parentTitle)){const ref=child(top,"child_page",parentTitle),p=await read(()=>client.retrievePage(ref));if(!object(p)||!active(p)||normalizeId(String(p.id))!==ref||!parent(p,"page_id",root))throw Error("PARENT_INVALID");parents.set(parentTitle,{ref,blocks:await children(ref)});}
   const holder=parents.get(parentTitle)!,dbRef=child(holder.blocks,"child_database",dbTitle),db=await read(()=>client.retrieveDatabase(dbRef));table.database_ref=dbRef;
   if(!object(db)||db.object!=="database"||!active(db)||normalizeId(String(db.id))!==dbRef||!parent(db,"page_id",holder.ref)||!Array.isArray(db.data_sources)||db.data_sources.length!==1||!object(db.data_sources[0]))throw Error("DATABASE_INVALID");
   const ds=normalizeId(String(db.data_sources[0].id));if(!ds)throw Error("DATASOURCE_INVALID");table.data_source_ref=ds;
   const schema=await read(()=>client.retrieveDataSource(ds));if(!object(schema)||schema.object!=="data_source"||!active(schema)||normalizeId(String(schema.id))!==ds||!parent(schema,"database_id",dbRef)||!object(schema.properties))throw Error("SCHEMA_PARENT_INVALID");
   const fields:Record<string,string>=FIELDS[role],titleField=TITLES[role];
   if(Object.values(schema.properties).filter(x=>object(x)&&x.type==="title").length!==1||!object(schema.properties[titleField])||(schema.properties[titleField] as Obj).type!=="title")throw Error("TITLE_INVALID");
   for(const [key,type]of Object.entries(fields))if(schema.properties[key]!==undefined&&(!object(schema.properties[key])||(schema.properties[key] as Obj).type!==type))throw Error("SCHEMA_TYPE_CONFLICT");
   const required=REQUIRED[role];
   if(required.some(k=>!object((schema.properties as Obj)[k])))throw Error("SCHEMA_REQUIRED_FIELD_MISSING");
   table.omitted_columns=Object.keys(schema.properties).filter(k=>!(k in fields));
   const rowLimit=JOURNALS.has(role)?LIMITS.journal_rows_per_table:LIMITS.rows_per_table;
   const q=await read(()=>client.queryDataSource(ds,(role==="OS_STATE"||role==="INSTANCE_MANIFEST")?{property:titleField,title:{equals:"CURRENT"}}:undefined,undefined,{page_size:rowLimit,...(JOURNALS.has(role)?{sorts:[{timestamp:"last_edited_time",direction:"descending"}]}:{})}));
   if(!object(q)||!Array.isArray(q.results)||typeof q.has_more!=="boolean"||(q.has_more?typeof q.next_cursor!=="string":q.next_cursor!==null))throw Error("QUERY_INVALID");table.has_more=q.has_more;
   const seen=new Set<string>();for(const row of q.results){if(table.observed_rows.length>=rowLimit)throw Error("ROW_LIMIT");if(!object(row)||row.object!=="page"||!active(row)||!parent(row,"data_source_id",ds)||!object(row.properties))throw Error("ROW_CONTAINMENT_INVALID");
    const ref=normalizeId(String(row.id));if(!ref||seen.has(ref))throw Error("DUPLICATE_ROW");seen.add(ref);
    const values:Obj={};for(const [key,type]of Object.entries(fields))if(schema.properties[key]!==undefined)values[key]=value(row.properties[key],type);
    if((role==="OS_STATE"||role==="INSTANCE_MANIFEST")&&values.Name!=="CURRENT")throw Error("CURRENT_QUERY_MISMATCH");
    table.observed_rows.push({page_ref:ref,...(typeof row.last_edited_time==="string"?{last_edited_time:row.last_edited_time}:{}),values});
    if(Buffer.byteLength(JSON.stringify(snapshot()))>LIMITS.response_bytes-1024){table.observed_rows.pop();throw Error("RESPONSE_LIMIT");}
   }
   if((role==="OS_STATE"||role==="INSTANCE_MANIFEST")&&(q.has_more||table.observed_rows.length!==1))throw Error("CURRENT_MISSING_OR_AMBIGUOUS");
   if(role==="INSTANCE_MANIFEST"&&(table.observed_rows[0]?.page_ref!==runtime.manifest_ref||table.observed_rows[0]?.values["Sales Contract Version"]!==runtime.manifest_pins.spec||table.observed_rows[0]?.values["Schema Version"]!==runtime.manifest_pins.schema))throw Error("MANIFEST_PIN_DRIFT");
   table.status=q.has_more?"PARTIAL":"COMPLETE";if(q.has_more)issue(role,"ROW_WINDOW_PARTIAL");
  }catch(e){table.status=table.observed_rows.length?"PARTIAL":"UNAVAILABLE";if(role==="OS_STATE"||role==="INSTANCE_MANIFEST")table.observed_rows=[];issue(role,e instanceof Error&&/^[A-Z_]+$/.test(e.message)?e.message:"READ_FAILED");}
 }
 return snapshot();
}
