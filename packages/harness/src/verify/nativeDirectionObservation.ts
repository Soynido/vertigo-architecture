/** H4 local foundation only. No MCP handler, writer, publication authority or receipt issuer. */
import {createHash} from "node:crypto";
import {z} from "zod";
import {NotionApiError,type NotionReadClient} from "../notion/readClient.ts";
import type {NativeNoteReason} from "./nativeNoteObservation.ts";

const text=z.string().trim().min(1).max(2000);
const scope=z.object({principal_id:text,runtime_id:text,runtime_generation:text}).strict();
const recipient=scope.extend({contract:text}).strict();
const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s);
const horizon=z.object({start:day,end:day}).strict().refine(v=>v.start<=v.end);
const stamp=z.string().datetime({offset:true});
const direction=z.object({
 kind:z.literal("DIRECTION_VERSION/1"),direction_id:text,version:z.number().int().positive(),
 status:z.literal("APPROVED"),approval_id:text,approved_by:text,recipient,horizon,
 objective:z.object({metric:z.literal("DISCOVERY_HELD"),target:z.number().int().nonnegative(),unit:z.literal("meetings")}).strict(),
 constraints:z.array(text).max(20),recommendations:z.array(text).max(20),
}).strict();
const current=z.object({kind:z.literal("DIRECTION_CURRENT/1"),direction_id:text,version:z.number().int().nonnegative(),recipient}).strict();
const consumption=z.object({kind:z.literal("DIRECTION_CONSUMPTION/1"),direction_id:text,version:z.number().int().positive(),recipient,local_run_id:text,consumed_at:stamp}).strict();
const event=z.object({kind:z.literal("SYNTHETIC_EVENT/1"),source_id:text,local_object_id:text,recipient,occurred_at:stamp,stage:z.enum(["PROPOSED","SCHEDULED","HELD"]),value:z.number().int().positive()}).strict();
const outcome=z.object({kind:z.literal("SALES_OUTCOME/1"),direction_id:text,version:z.number().int().positive(),recipient,source_id:text,local_object_id:text,stage:z.literal("HELD"),value:z.number().int().positive(),unit:z.literal("meetings"),horizon}).strict();
const target=z.object({page_id:z.string().regex(/^[a-f0-9]{32}$/),marker:text}).strict();
export const nativeDirectionExpectationSchema=z.object({
 kind:z.literal("SYNTHETIC_DIRECTION_CHECK/1"),scope,stage:z.enum(["PACKAGE_READY","PUBLISHED","CONSUMED","RETURNED"]),
 meta:target,sales:target,recipient,versions:z.array(direction).min(1).max(10),current,local_method:text,consumption,event,outcome,
}).strict();
/** Trusted operator/journal input ONLY; deliberately not an exposed chat argument schema. */
export type NativeDirectionExpectation=z.infer<typeof nativeDirectionExpectationSchema>;
export type NativeDirectionObservation=
 |{readonly kind:"OBSERVED";readonly stage:NativeDirectionExpectation["stage"];readonly claim:"POINT_IN_TIME_SYNTHETIC_RECORD_MATCH_ONLY";readonly direction_id:string;readonly version:number;readonly observed_at:string;readonly content_sha256:string}
 |{readonly kind:"UNCONFIRMED";readonly reason:NativeNoteReason};
type Refusal=Extract<NativeDirectionObservation,{kind:"UNCONFIRMED"}>;
type Reader=Pick<NotionReadClient,"retrievePage"|"retrieveBlockChildren">;
type Document={kind:"DOCUMENT";page_id:string;revision:string;parent:string;lines:string[];sections:Map<string,string[]>};
const refuse=(reason:NativeNoteReason):Refusal=>({kind:"UNCONFIRMED",reason});
const obj=(v:unknown):Record<string,unknown>|undefined=>v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:undefined;
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const norm=(v:unknown)=>typeof v==="string"?v.replaceAll("-","").toLowerCase():undefined;
function metadata(raw:unknown,pageId:string):{revision:string;parent:string}|undefined{
 const p=obj(raw),parent=obj(p?.parent);
 if(!p||p.object!=="page"||norm(p.id)!==pageId||p.archived!==false||p.in_trash!==false||!parent||typeof parent.type!=="string"||typeof p.last_edited_time!=="string"||!Number.isFinite(Date.parse(p.last_edited_time)))return;
 // Parent order is not meaningful in JSON, but an actual parent change invalidates the read.
 const stableParent=JSON.stringify(Object.keys(parent).sort().map(k=>[k,parent[k]]));
 return {revision:p.last_edited_time,parent:stableParent};
}
async function readDocument(client:Reader,t:z.infer<typeof target>):Promise<Document|Refusal>{
 const before=metadata(await client.retrievePage(t.page_id),t.page_id);
 if(!before)return refuse("INCOMPLETE_READ");
 const sections=new Map<string,string[]>(),lines:string[]=[],ids=new Set<string>(),cursors=new Set<string>();
 let cursor:string|undefined,heading:string|undefined,total=0,complete=false;
 for(let n=0;n<10;n++){
  const list=obj(await client.retrieveBlockChildren(t.page_id,cursor));
  if(!list||list.object!=="list"||!Array.isArray(list.results)||typeof list.has_more!=="boolean")return refuse("INCOMPLETE_READ");
  for(const raw of list.results){
   const block=obj(raw),type=String(block?.type);
   if(!block||block.object!=="block"||typeof block.id!=="string"||!block.id||ids.has(block.id)||ids.size>=500||block.has_children!==false||block.archived===true||block.in_trash===true||!["paragraph","heading_1","heading_2","heading_3","bulleted_list_item","numbered_list_item"].includes(type))return refuse("INCOMPLETE_READ");
   ids.add(block.id);
   const body=obj(block[type]);if(!body||!Array.isArray(body.rich_text))return refuse("INCOMPLETE_READ");
   let value="";
   for(const rawPart of body.rich_text){const part=obj(rawPart);if(typeof part?.plain_text!=="string")return refuse("INCOMPLETE_READ");value+=part.plain_text;}
   total+=value.length;if(total>65536)return refuse("INCOMPLETE_READ");
   if(type.startsWith("heading_")){
    // A duplicate heading is ambiguous, even when its first occurrence looks correct.
    if(sections.has(value))return refuse("CONTENT_MISMATCH");
    heading=value;sections.set(heading,[]);
   }else{lines.push(...value.split("\n"));if(heading)sections.get(heading)!.push(value);}
  }
  if(!list.has_more){complete=true;break;}
  if(typeof list.next_cursor!=="string"||!list.next_cursor||cursors.has(list.next_cursor))return refuse("INCOMPLETE_READ");
  cursor=list.next_cursor;cursors.add(cursor);
 }
 if(!complete)return refuse("INCOMPLETE_READ");
 const after=metadata(await client.retrievePage(t.page_id),t.page_id);
 if(!after||!same(before,after))return refuse("CHANGED_DURING_READ");
 if(lines.filter(v=>v===t.marker).length!==1)return refuse("CONTENT_MISMATCH");
 return {kind:"DOCUMENT",page_id:t.page_id,...before,lines,sections};
}
function matches(doc:Document,key:string,schema:z.ZodTypeAny,expected:unknown):boolean{
 const parts=doc.sections.get(key);if(!parts)return false;
 try{const parsed=schema.safeParse(JSON.parse(parts.join("\n")));return parsed.success&&same(parsed.data,expected);}catch{return false;}
}
function versioned(doc:Document,key:string,legacy:string,schema:z.ZodTypeAny,expected:Record<string,unknown>,identity:readonly string[]):boolean{
 const relevant:unknown[]=[];
 for(const heading of [key,legacy]){
  const parts=doc.sections.get(heading);if(!parts)continue;
  try{
   const parsed=schema.safeParse(JSON.parse(parts.join("\n")));if(!parsed.success)return false;
   const record=parsed.data as Record<string,unknown>;
   if(heading===key||identity.every(k=>same(record[k],expected[k])))relevant.push(record);
  }catch{return false;}
 }
 return relevant.length===1&&same(relevant[0],expected);
}
function coherent(p:NativeDirectionExpectation):boolean{
 const last=p.versions.at(-1)!;
 if(p.meta.page_id===p.sales.page_id||p.meta.marker===p.sales.marker||new Set(p.versions.map(v=>v.approval_id)).size!==p.versions.length)return false;
 if(p.versions.some((v,i)=>v.version!==i+1||v.direction_id!==last.direction_id||v.approved_by!==p.scope.principal_id||!same(v.recipient,p.recipient)))return false;
 if(p.current.direction_id!==last.direction_id||!same(p.current.recipient,p.recipient)||p.current.version!==(p.stage==="PACKAGE_READY"?last.version-1:last.version))return false;
 if(p.stage==="CONSUMED"||p.stage==="RETURNED"){
  if(p.consumption.direction_id!==last.direction_id||p.consumption.version!==last.version||!same(p.consumption.recipient,p.recipient))return false;
 }
 if(p.stage==="RETURNED"){
  const e=p.event,o=p.outcome;
  if(o.direction_id!==last.direction_id||o.version!==last.version||!same(o.recipient,p.recipient)||!same(e.recipient,p.recipient)||o.source_id!==e.source_id||o.local_object_id!==e.local_object_id||o.stage!==e.stage||o.value!==e.value||o.unit!==last.objective.unit||!same(o.horizon,last.horizon))return false;
  const d=new Date(e.occurred_at).toISOString().slice(0,10);
  if(d<last.horizon.start||d>last.horizon.end||Date.parse(e.occurred_at)<Date.parse(p.consumption.consumed_at))return false;
 }
 return true;
}
/** Internal configuration/journal validator, not a chat tool argument or authority source. */
export function parseNativeDirectionExpectation(value:unknown):NativeDirectionExpectation{
 const p=nativeDirectionExpectationSchema.parse(value);if(!coherent(p))throw Error("incoherent direction expectation");return p;
}

/**
 * Reads exact synthetic records; does NOT authenticate approval/consumption from a Notion label,
 * prove an email/event really happened, establish recipient identity or make Notion transactional.
 * The trusted plan fixes every expected identity/value. Nothing writes or adopts a version here.
 */
export async function observeNativeDirection(client:Reader,binding:unknown,expected:unknown):Promise<NativeDirectionObservation>{
 const bound=scope.safeParse(binding),wanted=nativeDirectionExpectationSchema.safeParse(expected);
 if(!wanted.success)return refuse("INVALID_EXPECTATION");
 const p=wanted.data;
 if(!bound.success||!same(bound.data,p.scope))return refuse("SCOPE_MISMATCH");
 if(!coherent(p))return refuse("INVALID_EXPECTATION");
 try{
  const meta=await readDocument(client,p.meta);if(meta.kind!=="DOCUMENT")return meta;
  if(p.versions.some(v=>!matches(meta,`Orientation version ${v.version}`,direction,v))||!matches(meta,"CURRENT orientation",current,p.current))return refuse("CONTENT_MISMATCH");
  const revisions=[{page_id:meta.page_id,revision:meta.revision,parent:meta.parent}];
  if(p.stage==="CONSUMED"||p.stage==="RETURNED"){
   const sales=await readDocument(client,p.sales);if(sales.kind!=="DOCUMENT")return sales;
   if(sales.sections.get("Méthode locale")?.join("\n")!==p.local_method||!versioned(sales,`Orientation reçue version ${p.consumption.version}`,"Orientation reçue",consumption,p.consumption,["direction_id","version"]))return refuse("CONTENT_MISMATCH");
   if(p.stage==="RETURNED"&&(!versioned(sales,`Preuve d’essai ${p.event.source_id}`,"Preuve d’essai",event,p.event,["source_id"])||!versioned(sales,`Résultat version ${p.outcome.version}`,"Résultat remonté",outcome,p.outcome,["direction_id","version"])))return refuse("CONTENT_MISMATCH");
   revisions.push({page_id:sales.page_id,revision:sales.revision,parent:sales.parent});
   // A full second page read can race publication. Check the META anchor again, not an old receipt.
   const anchor=metadata(await client.retrievePage(p.meta.page_id),p.meta.page_id);
   if(!anchor||anchor.revision!==meta.revision||anchor.parent!==meta.parent)return refuse("CHANGED_DURING_READ");
  }
  const last=p.versions.at(-1)!;
  return {kind:"OBSERVED",stage:p.stage,claim:"POINT_IN_TIME_SYNTHETIC_RECORD_MATCH_ONLY",direction_id:last.direction_id,version:last.version,observed_at:new Date().toISOString(),content_sha256:createHash("sha256").update(JSON.stringify({expected:p,revisions})).digest("hex")};
 }catch(err){
  if(err instanceof Error&&(err.name==="AbortError"||err.name==="TimeoutError"))return refuse("READ_INTERRUPTED");
  if(err instanceof NotionApiError){const reasons:Record<string,NativeNoteReason>={"401":"AUTHENTICATION_REQUIRED","403":"ACCESS_DENIED","404":"NOT_FOUND_OR_INACCESSIBLE","429":"RATE_LIMITED",TIMEOUT:"READ_INTERRUPTED",TRANSPORT:"READ_INTERRUPTED"};return refuse(reasons[String(err.status)]??"SOURCE_UNAVAILABLE");}
  return refuse("SOURCE_UNAVAILABLE");
 }
}
