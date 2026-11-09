/** Bounded owner META source projection. No writer, planner, semantic authority or native-tool attestation. */
import {z} from "zod";
import {NotionApiError,type NotionReadClient} from "../notion/readClient.ts";

const uuid=z.string().regex(/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i).transform(v=>v.replaceAll("-","").toLowerCase());
export const nativeMetaSourcesSchema=z.object({decisions_database_id:uuid,decisions_data_source_id:uuid,weekly_reviews_database_id:uuid,weekly_reviews_data_source_id:uuid,business_decision_page_id:uuid}).strict().refine(v=>new Set(Object.values(v)).size===5);
type Sources=z.infer<typeof nativeMetaSourcesSchema>;
export type NativeMetaContextReader=Pick<NotionReadClient,"retrievePage"|"retrieveDatabase"|"retrieveDataSource"|"queryDataSource">;
type RecordValue=Record<string,unknown>;
type Issue="SCOPE_MISMATCH"|"INCOMPLETE_READ"|"INCONSISTENT_READ"|"ACCESS_DENIED"|"AUTHENTICATION_REQUIRED"|"NOT_FOUND_OR_INACCESSIBLE"|"RATE_LIMITED"|"READ_INTERRUPTED"|"SOURCE_UNAVAILABLE";
type Row={page_id:string;revision:string;values:RecordValue};
type Window={database_id:string;data_source_id:string;status:"OBSERVED_WINDOW"|"PARTIAL"|"UNAVAILABLE";coverage:"WINDOW_ONLY";has_more:boolean|null;rows:Row[];database_revision?:string;source_revision?:string;issue?:Issue};
type Selected={status:"OBSERVED_RECORD"|"UNAVAILABLE";row?:Row;issue?:Issue};
export type ManifestNext={page_id:string;revision:string;text:string|null;status:"OBSERVED_FIELD"|"UNAVAILABLE"};
export type NativeMetaContext={kind:"META_OPERATING_CONTEXT/1";trust:"SOURCE_DATA_ONLY";atomic:false;stability:"NOT_VERIFIED"|"MATCHED_SELECTED_READS";status:"OBSERVED"|"PARTIAL"|"UNAVAILABLE";manifest_next:ManifestNext;selected_decision:Selected;decisions:Window;weekly_reviews:Window;edit_order:"MANIFEST_EDITED_AFTER_SELECTED_DECISION"|"MANIFEST_NOT_EDITED_AFTER_SELECTED_DECISION"|"NOT_ESTABLISHED";applicability:"NOT_ESTABLISHED";supersession:"NOT_ESTABLISHED";priority_basis:"NOT_ASSESSED"};
const DECISIONS={Decision:"title",Status:"select",Reason:"rich_text",Resolution:"rich_text","Decided At":"date","Effective At":"date"}as const;
const WEEKLY={Review:"title",Status:"select","Week Start":"date","Business State":"rich_text","Human Decisions":"rich_text","Output Refs":"rich_text","Coverage Notes":"rich_text"}as const;
const obj=(v:unknown):RecordValue|undefined=>v!==null&&typeof v==="object"&&!Array.isArray(v)?v as RecordValue:undefined;
const id=(v:unknown)=>{const p=uuid.safeParse(v);return p.success?p.data:undefined;};
class Refused extends Error{readonly issue:Issue;constructor(issue:Issue){super(issue);this.issue=issue;}}
const fail=(issue:Issue):never=>{throw new Refused(issue);};
function reason(e:unknown):Issue{
 if(e instanceof Refused)return e.issue;
 if(e instanceof Error&&["AbortError","TimeoutError"].includes(e.name))return "READ_INTERRUPTED";
 if(e instanceof NotionApiError){const codes:Record<string,Issue>={"401":"AUTHENTICATION_REQUIRED","403":"ACCESS_DENIED","404":"NOT_FOUND_OR_INACCESSIBLE","429":"RATE_LIMITED",TIMEOUT:"READ_INTERRUPTED",TRANSPORT:"READ_INTERRUPTED"};return codes[String(e.status)]??"SOURCE_UNAVAILABLE";}
 return "SOURCE_UNAVAILABLE";
}
function stamp(v:unknown):string{
 if(typeof v!=="string"||!/^\d{4}-\d{2}-\d{2}T/.test(v)||!Number.isFinite(Date.parse(v)))return fail("INCOMPLETE_READ");return v;
}
function validWhen(v:unknown):v is string{
 if(typeof v!=="string"||!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(v)||!Number.isFinite(Date.parse(v)))return false;
 return v.length!==10||new Date(v).toISOString().slice(0,10)===v;
}
function entity(v:unknown,kind:string,ref:string,parentType:string,parentId:string):RecordValue{
 const p=obj(v),parent=obj(p?.parent);
 if(!p||p.object!==kind||id(p.id)!==ref||!parent||parent.type!==parentType||id(parent[parentType])!==parentId)return fail("SCOPE_MISMATCH");
 if(p.archived!==false||p.in_trash===true)return fail("INCOMPLETE_READ");stamp(p.last_edited_time);return p;
}
function cell(v:unknown,type:string):unknown{
 const p=obj(v);if(!p||p.type!==type||p.has_more===true)return fail("INCOMPLETE_READ");const value=p[type];
 if(type==="title"||type==="rich_text"){
  if(!Array.isArray(value)||value.length>=25)return fail("INCOMPLETE_READ");let s="";
  for(const part of value){const r=obj(part);if(typeof r?.plain_text!=="string")return fail("INCOMPLETE_READ");s+=r.plain_text;}
  if(Buffer.byteLength(s)>4096)return fail("INCOMPLETE_READ");return s||null;
 }
 if(type==="select"){if(value===null)return null;const s=obj(value)?.name;if(typeof s!=="string"||!s||s.length>256)return fail("INCOMPLETE_READ");return s;}
 if(type==="date"){
  if(value===null)return null;const d=obj(value);if(!d||!validWhen(d.start))return fail("INCOMPLETE_READ");
  if(d.end!==null&&!validWhen(d.end))return fail("INCOMPLETE_READ");
  if(d.time_zone!==null&&typeof d.time_zone!=="string")return fail("INCOMPLETE_READ");
  return {start:d.start,end:d.end,time_zone:d.time_zone};
 }
 return fail("INCOMPLETE_READ");
}
function row(v:unknown,source:string,fields:Record<string,string>,expected?:string):Row{
 const p=obj(v),ref=id(p?.id);if(!ref||expected&&ref!==expected)return fail("SCOPE_MISMATCH");
 const valid=entity(v,"page",ref,"data_source_id",source),props=obj(valid.properties);if(!props)return fail("INCOMPLETE_READ");
 const values=Object.fromEntries(Object.entries(fields).map(([key,type])=>[key,cell(props[key],type)]));
 const result={page_id:ref,revision:stamp(valid.last_edited_time),values};if(Buffer.byteLength(JSON.stringify(result))>8192)return fail("INCOMPLETE_READ");return result;
}

/** Admission/identity belongs to NativeMetaControl. These fixed mappings never come from the chat. */
export async function readNativeMetaContext(reader:NativeMetaContextReader,root:string,s:Sources,manifest:ManifestNext):Promise<NativeMetaContext>{
 let selected:Selected={status:"UNAVAILABLE",issue:"SOURCE_UNAVAILABLE"};
 async function table(database:string,source:string,fields:Record<string,string>,decision=false):Promise<Window>{
  const empty:Window={database_id:database,data_source_id:source,status:"UNAVAILABLE",coverage:"WINDOW_ONLY",has_more:null,rows:[]};
  try{
   const db=entity(await reader.retrieveDatabase(database),"database",database,"page_id",root);
   if(!Array.isArray(db.data_sources)||db.data_sources.filter(v=>id(obj(v)?.id)===source).length!==1)return fail("SCOPE_MISMATCH");
   const ds=entity(await reader.retrieveDataSource(source),"data_source",source,"database_id",database),props=obj(ds.properties);if(!props)return fail("INCOMPLETE_READ");
   for(const[key,type]of Object.entries(fields))if(obj(props[key])?.type!==type)return fail("INCOMPLETE_READ");
   if(decision){try{selected={status:"OBSERVED_RECORD",row:row(await reader.retrievePage(s.business_decision_page_id),source,fields,s.business_decision_page_id)};}catch(e){selected={status:"UNAVAILABLE",issue:reason(e)};}}
   const q=obj(await reader.queryDataSource(source,undefined,undefined,{page_size:4,sorts:[{timestamp:"last_edited_time",direction:"descending"}]}));
   if(!q||q.object!=="list"||!Array.isArray(q.results)||q.results.length>4||typeof q.has_more!=="boolean"||(q.has_more?typeof q.next_cursor!=="string"||!q.next_cursor:q.next_cursor!==null))return fail("INCOMPLETE_READ");
   const rows=q.results.map(v=>row(v,source,fields));if(new Set(rows.map(v=>v.page_id)).size!==rows.length)return fail("INCOMPLETE_READ");
   if(decision&&selected.row){const repeated=rows.find(v=>v.page_id===selected.row!.page_id);if(repeated&&JSON.stringify(repeated)!==JSON.stringify(selected.row)){selected={status:"UNAVAILABLE",issue:"INCONSISTENT_READ"};return fail("INCONSISTENT_READ");}}
   const result:Window={...empty,status:q.has_more||rows.length>3?"PARTIAL":"OBSERVED_WINDOW",has_more:q.has_more||rows.length>3,rows:rows.slice(0,3),database_revision:stamp(db.last_edited_time),source_revision:stamp(ds.last_edited_time)};
   if(Buffer.byteLength(JSON.stringify(result))>24576)return fail("INCOMPLETE_READ");return result;
  }catch(e){const issue=reason(e);if(decision&&selected.status!=="OBSERVED_RECORD")selected={status:"UNAVAILABLE",issue};return {...empty,issue};}
 }
 const decisions=await table(s.decisions_database_id,s.decisions_data_source_id,DECISIONS,true);
 const weekly_reviews=await table(s.weekly_reviews_database_id,s.weekly_reviews_data_source_id,WEEKLY);
 const all=[decisions.status,weekly_reviews.status,selected.status,manifest.status];
 const status=all.every(v=>v==="UNAVAILABLE")?"UNAVAILABLE":all.some(v=>v==="UNAVAILABLE"||v==="PARTIAL")?"PARTIAL":"OBSERVED";
 const edit_order=selected.row&&Date.parse(manifest.revision)!==Date.parse(selected.row.revision)?(Date.parse(manifest.revision)>Date.parse(selected.row.revision)?"MANIFEST_EDITED_AFTER_SELECTED_DECISION":"MANIFEST_NOT_EDITED_AFTER_SELECTED_DECISION"):"NOT_ESTABLISHED";
 return {kind:"META_OPERATING_CONTEXT/1",trust:"SOURCE_DATA_ONLY",atomic:false,stability:"NOT_VERIFIED",status,manifest_next:manifest,selected_decision:selected,decisions,weekly_reviews,edit_order,applicability:"NOT_ESTABLISHED",supersession:"NOT_ESTABLISHED",priority_basis:"NOT_ASSESSED"};
}
