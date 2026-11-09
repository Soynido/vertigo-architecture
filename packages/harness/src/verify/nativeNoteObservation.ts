/** R19-H2 candidate only: no handler, writer, store mutation or transaction FINAL issuance. */
import type {NotionReadClient} from "../notion/readClient.ts";
import {NotionApiError} from "../notion/readClient.ts";
import {createHash} from "node:crypto";

export interface NativeNoteScope {
 readonly principal_id:string;
 readonly runtime_id:string;
 readonly runtime_generation:string;
}
/** Internal expectation from trusted server configuration/journal, never direct chat arguments. */
export interface NativeNoteExpectation {
 readonly scope:NativeNoteScope;
 readonly page_id:string;
 readonly marker:string;
 readonly section:string;
 readonly note_key:string;
 readonly note_text:string;
}
export type NativeNoteReason="SCOPE_MISMATCH"|"INVALID_EXPECTATION"|"CONTENT_MISMATCH"|"INCOMPLETE_READ"|"CHANGED_DURING_READ"|"AUTHENTICATION_REQUIRED"|"ACCESS_DENIED"|"NOT_FOUND_OR_INACCESSIBLE"|"RATE_LIMITED"|"READ_INTERRUPTED"|"SOURCE_UNAVAILABLE";
export type NativeNoteObservation=
 |{readonly kind:"OBSERVED";readonly source:"INDEPENDENT_NOTION_READ";readonly page_id:string;readonly last_edited_time:string;readonly content_sha256:string;readonly observed_at:string}
 |{readonly kind:"UNCONFIRMED";readonly reason:NativeNoteReason};

const unconfirmed=(reason:NativeNoteReason):NativeNoteObservation=>({kind:"UNCONFIRMED",reason});
const id=(value:unknown):string|undefined=>typeof value==="string"&&/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(value)?value.replaceAll("-","").toLowerCase():undefined;
const object=(value:unknown):Record<string,unknown>|undefined=>value!==null&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:undefined;

/** Point-in-time evidence only. No proof of Gmail truth, atomic Notion snapshot or ongoing stability. */
export async function observeNativeNote(client:Pick<NotionReadClient,"retrievePage"|"retrieveBlockChildren">,binding:NativeNoteScope,expected:NativeNoteExpectation):Promise<NativeNoteObservation>{
 const scopeKeys=["principal_id","runtime_id","runtime_generation"] as const;
 if(scopeKeys.some(k=>!binding?.[k]||binding[k]!==expected?.scope?.[k]))return unconfirmed("SCOPE_MISMATCH");
 const pageId=id(expected.page_id);
 if(!pageId||[expected.marker,expected.section,expected.note_key,expected.note_text].some(v=>typeof v!=="string"||!v.trim()||v.length>16384))return unconfirmed("INVALID_EXPECTATION");
 try{
  const before=object(await client.retrievePage(pageId));
  if(!before||before.object!=="page"||id(before.id)!==pageId||before.archived!==false||before.in_trash!==false||typeof before.last_edited_time!=="string"||!Number.isFinite(Date.parse(before.last_edited_time)))return unconfirmed("INCOMPLETE_READ");
  const texts:string[]=[];let cursor:string|undefined;const cursors=new Set<string>(),blockIds=new Set<string>();let complete=false,total=0;
  for(let n=0;n<10;n++){
   const list=object(await client.retrieveBlockChildren(pageId,cursor));
   if(!list||list.object!=="list"||!Array.isArray(list.results)||typeof list.has_more!=="boolean")return unconfirmed("INCOMPLETE_READ");
   for(const raw of list.results){
    const block=object(raw);
    if(!block||block.object!=="block"||typeof block.id!=="string"||!block.id||blockIds.has(block.id)||block.has_children!==false||block.archived===true||block.in_trash===true)return unconfirmed("INCOMPLETE_READ");
    blockIds.add(block.id);
    if(!["paragraph","heading_1","heading_2","heading_3","bulleted_list_item","numbered_list_item"].includes(String(block.type)))return unconfirmed("INCOMPLETE_READ");
    const body=object(block[String(block.type)]);
    if(!body||!Array.isArray(body.rich_text))return unconfirmed("INCOMPLETE_READ");
    let text="";
    for(const rawPart of body.rich_text){const part=object(rawPart);if(typeof part?.plain_text!=="string")return unconfirmed("INCOMPLETE_READ");text+=part.plain_text;}
    total+=text.length;if(total>65536||texts.length>=500)return unconfirmed("INCOMPLETE_READ");
    // Tag the structural boundary, not a substring a paragraph can impersonate.
    texts.push(`${String(block.type).startsWith("heading_")?"H":"T"}:${text}`);
   }
   if(!list.has_more){complete=true;break;}
   if(typeof list.next_cursor!=="string"||!list.next_cursor||cursors.has(list.next_cursor))return unconfirmed("INCOMPLETE_READ");
   cursor=list.next_cursor;cursors.add(cursor);
  }
  if(!complete)return unconfirmed("INCOMPLETE_READ");
  const after=object(await client.retrievePage(pageId));
  if(!after||after.object!=="page"||id(after.id)!==pageId||after.archived!==false||after.in_trash!==false||after.last_edited_time!==before.last_edited_time||JSON.stringify(after.parent)!==JSON.stringify(before.parent))return unconfirmed("CHANGED_DURING_READ");
  const heading=`H:${expected.section}`,start=texts.indexOf(heading);
  const end=texts.findIndex((v,i)=>i>start&&v.startsWith("H:"));
  const lines=texts.filter(t=>t.startsWith("T:")).flatMap(t=>t.slice(2).split("\n"));
  if(lines.filter(t=>t===`Pilot key: ${expected.marker}`).length!==1||start<0||texts.lastIndexOf(heading)!==start)return unconfirmed("CONTENT_MISMATCH");
  const note=texts.slice(start+1,end<0?undefined:end).map(t=>t.slice(2)).join("\n");
  if(note!==`${expected.note_key}\n${expected.note_text}`||lines.filter(t=>t===expected.note_key).length!==1)return unconfirmed("CONTENT_MISMATCH");
  return {kind:"OBSERVED",source:"INDEPENDENT_NOTION_READ",page_id:pageId,last_edited_time:before.last_edited_time,
   content_sha256:createHash("sha256").update(JSON.stringify([binding.principal_id,binding.runtime_id,binding.runtime_generation,pageId,expected.marker,expected.note_key,expected.note_text])).digest("hex"),observed_at:new Date().toISOString()};
 }catch(error){
  // The existing read client lets native AbortSignal failures through unwrapped.
  if(error instanceof Error&&(error.name==="AbortError"||error.name==="TimeoutError"))return unconfirmed("READ_INTERRUPTED");
  if(error instanceof NotionApiError){
   const reasons:Record<string,NativeNoteReason>={"401":"AUTHENTICATION_REQUIRED","403":"ACCESS_DENIED","404":"NOT_FOUND_OR_INACCESSIBLE","429":"RATE_LIMITED",TIMEOUT:"READ_INTERRUPTED",TRANSPORT:"READ_INTERRUPTED"};
   return unconfirmed(reasons[String(error.status)]??"SOURCE_UNAVAILABLE");
  }
  return unconfirmed("SOURCE_UNAVAILABLE");
 }
}
