/** Operator-only input collector for the independent CONTROL verifier.
 * This module is not an MCP route and performs no write. A complete declared
 * read set is NOT an invariant result, canonical artifact or gate confirmation.
 */
import{z}from'zod';
import type{NotionReadClient}from'../notion/readClient.ts';
import{canonicalJson,digestOf,type Canonical}from'../guards/canonical.ts';

const globalRoles=['META_MANIFEST','META_RUNS','META_LEDGER','META_GATES','META_REGISTRY','META_MIRRORS','SHARED_ACCOUNTS','SHARED_CONTACTS','SHARED_INTERACTIONS','SHARED_ENROLLMENTS','SHARED_DECISIONS','PUBLISHED_CURRENT','PUBLISHED_PACKAGES','PUBLISHED_COMPATIBILITY']as const;
const personalRoles=['PERSONAL_MANIFEST','PERSONAL_RUNS','PERSONAL_LEDGER','PERSONAL_STATE','PERSONAL_INTENTS','PERSONAL_RECEIPTS']as const;
const roles=[...globalRoles,...personalRoles]as const;
const nativeId=z.string().regex(/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i).transform(s=>s.replaceAll('-','').toLowerCase());
const fieldType=z.enum(['title','rich_text','url','email','checkbox','select','status','number','date','relation','unique_id']);
const edgeSchema=z.object({role:z.enum(roles),runtime_id:z.string().min(1).max(160).optional(),kind:z.enum(['page','data_source']),id:nativeId,source_id:nativeId,columns:z.record(fieldType).refine(x=>Object.keys(x).length>0&&Object.keys(x).length<=40),children:z.boolean().optional()}).strict();
const bindingSchema=z.object({meta_root_id:nativeId,os_registry_source_id:nativeId,shared_root_id:nativeId,published_root_id:nativeId,edges:z.array(edgeSchema).max(128)}).strict();
export type ControlReadScopeBinding=z.input<typeof bindingSchema>;
type ObjectValue=Record<string,any>;
const errors=['CONTROL_BINDINGS_INCOMPLETE','CONTROL_SCOPE_MISMATCH','CONTROL_READ_INCOMPLETE','CONTROL_FIELDS_UNREADABLE','CONTROL_INPUT_CHANGED','CONTROL_SOURCE_UNAVAILABLE']as const;
type Reason=typeof errors[number];
const fail=(reason:Reason):never=>{throw Error(reason);};
const obj=(v:unknown,reason:Reason='CONTROL_READ_INCOMPLETE'):ObjectValue=>v&&typeof v==='object'&&!Array.isArray(v)?v as ObjectValue:fail(reason);
const id=(v:unknown)=>{const p=nativeId.safeParse(v);return p.success?p.data:fail('CONTROL_SCOPE_MISMATCH');};
const revision=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v))?new Date(v).toISOString():fail('CONTROL_READ_INCOMPLETE');
const canon=(v:unknown)=>canonicalJson(v as Canonical);
const digest=(v:unknown)=>digestOf(v as Canonical);

function selected(raw:unknown,expected:string):Canonical{
 const p=obj(raw,'CONTROL_FIELDS_UNREADABLE');if(p.type!==expected||p.has_more===true)return fail('CONTROL_FIELDS_UNREADABLE');
 const v=p[expected];
 if(expected==='title'||expected==='rich_text'){
  if(!Array.isArray(v)||v.length>=25)return fail('CONTROL_FIELDS_UNREADABLE');
  return v.map(entry=>{const r=obj(entry,'CONTROL_FIELDS_UNREADABLE');if(typeof r.plain_text!=='string'||!['text','mention','equation'].includes(r.type))return fail('CONTROL_FIELDS_UNREADABLE');
   return{type:r.type,text:r.plain_text,...(r.type==='mention'&&r.mention?.type==='page'?{page_id:id(r.mention.page?.id)}:{})};});
 }
 if(v===null)return null;
 if(expected==='url'||expected==='email'){if(typeof v!=='string')return fail('CONTROL_FIELDS_UNREADABLE');return v;}
 if(expected==='checkbox'){if(typeof v!=='boolean')return fail('CONTROL_FIELDS_UNREADABLE');return v;}
 if(expected==='number'){if(typeof v!=='number'||!Number.isFinite(v))return fail('CONTROL_FIELDS_UNREADABLE');return v;}
 if(expected==='select'||expected==='status'){if(typeof v?.name!=='string')return fail('CONTROL_FIELDS_UNREADABLE');return v.name;}
 if(expected==='date'){if(typeof v?.start!=='string'||!Number.isFinite(Date.parse(v.start)))return fail('CONTROL_FIELDS_UNREADABLE');return{start:v.start,end:v.end??null,time_zone:v.time_zone??null};}
 if(expected==='relation'){if(!Array.isArray(v)||v.length>=25)return fail('CONTROL_FIELDS_UNREADABLE');return v.map(r=>id(r?.id)).sort();}
 if(expected==='unique_id'){if(!Number.isSafeInteger(v?.number)||v.number<0||v.prefix!==null&&typeof v.prefix!=='string')return fail('CONTROL_FIELDS_UNREADABLE');return{number:v.number,prefix:v.prefix};}
 return fail('CONTROL_FIELDS_UNREADABLE');
}
function textProperty(p:ObjectValue,name:string){const x=obj(p.properties?.[name],'CONTROL_FIELDS_UNREADABLE'),v=selected(x,x.type);if(x.type==='url')return v as string; if(x.type!=='rich_text'||!Array.isArray(v))return fail('CONTROL_FIELDS_UNREADABLE');return(v as {text:string}[]).map(r=>r.text).join('');}
function pageReference(p:ObjectValue,name:string){
 const property=obj(p.properties?.[name],'CONTROL_FIELDS_UNREADABLE');
 if(property.type==='rich_text'&&property.rich_text?.length===1&&property.rich_text[0]?.mention?.type==='page'){selected(property,'rich_text');return id(property.rich_text[0].mention.page?.id);}
 const text=textProperty(p,name);try{const u=new URL(text);if(u.protocol==='https:'&&['app.notion.com','notion.so','www.notion.so'].includes(u.hostname)&&!u.username&&!u.password&&!u.search&&!u.hash)return id(u.pathname.match(/([a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/?$/i)?.[1]);}catch{}
 return fail('CONTROL_SCOPE_MISMATCH');
}

/** Fresh two-pass, bounded reads. Bindings are trusted operator configuration,
 * but the runtime inventory is independently read from the scoped META registry.
 * Selected field semantics and every CONTROL invariant remain the next layer's
 * responsibility: do not expose this read-only observation as a PASS producer.
 */
export async function collectControlReadScope(reader:NotionReadClient,rawBinding:ControlReadScopeBinding):Promise<any>{
 try{
  const parsed=bindingSchema.safeParse(rawBinding);if(!parsed.success)return fail('CONTROL_BINDINGS_INCOMPLETE');const b=parsed.data;
  if(new Set([b.meta_root_id,b.shared_root_id,b.published_root_id]).size!==3)return fail('CONTROL_SCOPE_MISMATCH');
  const edgeKeys=b.edges.map(e=>e.role+':'+(e.runtime_id??''));
  if(new Set(edgeKeys).size!==edgeKeys.length||new Set(b.edges.map(e=>e.id)).size!==b.edges.length)return fail('CONTROL_SCOPE_MISMATCH');
  for(const e of b.edges)if(e.role.startsWith('PERSONAL_')!==Boolean(e.runtime_id)||e.kind==='data_source'&&e.id!==e.source_id)return fail('CONTROL_SCOPE_MISMATCH');
  const snapshot=async()=>{
   const nodes=new Map<string,ObjectValue>(),resources=new Map<string,{kind:string;id:string;revision:string;parts:Record<string,string>}>();
   const remember=(kind:string,p:ObjectValue,part:string,payload:unknown)=>{const key=kind+':'+id(p.id),rev=revision(p.last_edited_time),old=resources.get(key);if(old&&old.revision!==rev)return fail('CONTROL_INPUT_CHANGED');const value=old??{kind,id:id(p.id),revision:rev,parts:{}};value.parts[part]=digest(payload);resources.set(key,value);};
   const get=async(kind:'page'|'database'|'data_source',ref:string)=>{
    const key=kind+':'+ref;if(nodes.has(key))return nodes.get(key)!;
    const p=obj(await(kind==='page'?reader.retrievePage(ref):kind==='database'?reader.retrieveDatabase(ref):reader.retrieveDataSource(ref)),'CONTROL_SOURCE_UNAVAILABLE');
    if(p.object!==kind||id(p.id)!==ref||p.archived===true||p.in_trash===true||kind==='page'&&(p.archived!==false||p.in_trash!==false))return fail('CONTROL_SCOPE_MISMATCH');
    remember(kind,p,'identity',{id:ref,parent:p.parent??null});nodes.set(key,p);return p;
   };
   const sourceUnder=async(source:string,root:string)=>{
    await get('page',root);const first=await get('data_source',source);let p=first;const seen=new Set([source]);
    for(let n=0;n<12;n++){const parent=obj(p.parent,'CONTROL_SCOPE_MISMATCH'),kind=parent.type,ref=id(parent[kind]);if(seen.has(ref))return fail('CONTROL_SCOPE_MISMATCH');seen.add(ref);if(kind==='page_id'&&ref===root)return first;if(kind!=='page_id'&&kind!=='database_id')return fail('CONTROL_SCOPE_MISMATCH');p=await get(kind==='page_id'?'page':'database',ref);}
    return fail('CONTROL_SCOPE_MISMATCH');
   };
   const queryAll=async(source:string)=>{
    const rows:ObjectValue[]=[],ids=new Set<string>(),cursors=new Set<string>();let cursor:string|undefined;
    for(let n=0;n<20;n++){
     const q=obj(await reader.queryDataSource(source,undefined,cursor,{page_size:100}));
     if(q.object!=='list'||!Array.isArray(q.results)||typeof q.has_more!=='boolean'||q.results.length>100)return fail('CONTROL_READ_INCOMPLETE');
     for(const raw of q.results){const p=obj(raw),ref=id(p.id);if(ids.has(ref))return fail('CONTROL_READ_INCOMPLETE');ids.add(ref);if(p.object!=='page'||p.archived!==false||p.in_trash!==false||p.parent?.type!=='data_source_id'||id(p.parent.data_source_id)!==source)return fail('CONTROL_SCOPE_MISMATCH');revision(p.last_edited_time);rows.push(p);}
     if(!q.has_more){if(q.next_cursor!=null)return fail('CONTROL_READ_INCOMPLETE');return rows.sort((a,b)=>id(a.id).localeCompare(id(b.id)));}
     if(typeof q.next_cursor!=='string'||!q.next_cursor||q.next_cursor.length>1000||cursors.has(q.next_cursor))return fail('CONTROL_READ_INCOMPLETE');cursors.add(q.next_cursor);cursor=q.next_cursor;
    }return fail('CONTROL_READ_INCOMPLETE');
   };
   const registrySchema=await sourceUnder(b.os_registry_source_id,b.meta_root_id),registry=await queryAll(b.os_registry_source_id),inventory=[];
   const inventoryTypes:Record<string,string[]>={'Runtime ID':['rich_text'],'Root URL':['url','rich_text'],'Source Manifest URL':['url','rich_text'],'Runtime State':['select']},inventoryColumns=[],inventoryPropertyIds=new Set<string>();
   for(const [name,types]of Object.entries(inventoryTypes).sort(([a],[c])=>a.localeCompare(c))){const p=obj(registrySchema.properties?.[name],'CONTROL_FIELDS_UNREADABLE');if(p.name!==name||!types.includes(p.type)||typeof p.id!=='string'||!p.id||inventoryPropertyIds.has(p.id))return fail('CONTROL_FIELDS_UNREADABLE');inventoryPropertyIds.add(p.id);inventoryColumns.push({name,id:p.id,type:p.type});}
   remember('data_source',registrySchema,'inventory-schema',inventoryColumns);
   const runtimeIds=new Set<string>(),roots=new Set([b.meta_root_id,b.shared_root_id,b.published_root_id]);
   for(const p of registry){
    const runtime=textProperty(p,'Runtime ID'),state=selected(p.properties['Runtime State'],'select');
    if(!runtime||runtime.length>160||typeof state!=='string'||!['NOT_FOUND','DISCOVERED','UNBOUND','SETUP','DRY_RUN','READY','PAUSED','RETIRED'].includes(state))return fail('CONTROL_FIELDS_UNREADABLE');
    const root=pageReference(p,'Root URL'),manifest=pageReference(p,'Source Manifest URL');
    if(runtimeIds.has(runtime)||roots.has(root))return fail('CONTROL_SCOPE_MISMATCH');runtimeIds.add(runtime);roots.add(root);
    const record={runtime_id:runtime,root_page_id:root,manifest_page_id:manifest,state};remember('page',p,'inventory',record);inventory.push(record);
   }
   inventory.sort((a,b)=>a.runtime_id.localeCompare(b.runtime_id));if(inventory.length>16)return fail('CONTROL_READ_INCOMPLETE');
   // Retirement remains observed history, not an implicit permission to omit a runtime.
   const required=[...globalRoles.map(role=>role+':'),...inventory.flatMap(r=>personalRoles.map(role=>role+':'+r.runtime_id))];
   if(required.length!==edgeKeys.length||required.some(key=>!edgeKeys.includes(key)))return fail('CONTROL_BINDINGS_INCOMPLETE');
   const edges=[];
   const fields=(p:ObjectValue,columns:Record<string,string>,part:string)=>{
    const properties:Record<string,Canonical>={};for(const name of Object.keys(columns).sort())properties[name]=selected(p.properties?.[name],columns[name]!);
    remember('page',p,part,properties);return{id:id(p.id),revision:revision(p.last_edited_time),properties};
   };
   let blockCount=0;const blockIds=new Set<string>();
   const blockTree=async(parent:string)=>{
    const blocks:ObjectValue[]=[];
    const walk=async(ref:string,depth:number):Promise<void>=>{
     if(depth>12)return fail('CONTROL_READ_INCOMPLETE');let cursor:string|undefined;const cursors=new Set<string>();
     for(let n=0;n<20;n++){
      const q=obj(await reader.retrieveBlockChildren(ref,cursor));if(q.object!=='list'||!Array.isArray(q.results)||typeof q.has_more!=='boolean'||q.results.length>100)return fail('CONTROL_READ_INCOMPLETE');
      for(const raw of q.results){if(blockCount>=2000)return fail('CONTROL_READ_INCOMPLETE');const p=obj(raw),refId=id(p.id);if(p.object!=='block'||p.archived!==false||p.in_trash!==false||typeof p.has_children!=='boolean'||blockIds.has(refId)||!['page_id','block_id'].includes(p.parent?.type)||id(p.parent[p.parent.type])!==ref)return fail('CONTROL_SCOPE_MISMATCH');blockIds.add(refId);blockCount++;const body=obj(p[p.type],'CONTROL_FIELDS_UNREADABLE');const projection={id:refId,revision:revision(p.last_edited_time),parent:ref,type:p.type,has_children:p.has_children,body};remember('block',p,'body',projection);blocks.push(projection);if(p.type==='child_database'||p.type==='synced_block')return fail('CONTROL_READ_INCOMPLETE');if(p.has_children||p.type==='child_page')await walk(refId,depth+1);}
      if(!q.has_more){if(q.next_cursor!=null)return fail('CONTROL_READ_INCOMPLETE');return;}
      if(typeof q.next_cursor!=='string'||!q.next_cursor||cursors.has(q.next_cursor))return fail('CONTROL_READ_INCOMPLETE');cursors.add(q.next_cursor);cursor=q.next_cursor;
     }return fail('CONTROL_READ_INCOMPLETE');
    };await walk(parent,0);return blocks;
   };
   for(const e of [...b.edges].sort((a,c)=>(a.role+':'+(a.runtime_id??'')).localeCompare(c.role+':'+(c.runtime_id??'')))){
    const personal=inventory.find(r=>r.runtime_id===e.runtime_id),root=e.role.startsWith('PERSONAL_')?personal!.root_page_id:e.role.startsWith('SHARED_')?b.shared_root_id:e.role.startsWith('PUBLISHED_')?b.published_root_id:b.meta_root_id;
    if(e.role==='PERSONAL_MANIFEST'&&(e.kind!=='page'||e.id!==personal!.manifest_page_id))return fail('CONTROL_SCOPE_MISMATCH');
    const schema=await sourceUnder(e.source_id,root),columns=[];
    const propertyIds=new Set<string>();for(const [name,type]of Object.entries(e.columns).sort(([a],[c])=>a.localeCompare(c))){const p=obj(schema.properties?.[name],'CONTROL_FIELDS_UNREADABLE');if(p.name!==name||typeof p.id!=='string'||!p.id||propertyIds.has(p.id)||p.type!==type)return fail('CONTROL_FIELDS_UNREADABLE');propertyIds.add(p.id);columns.push({name,id:p.id,type});}remember('data_source',schema,e.role+':'+(e.runtime_id??''),columns);
    let rows:ObjectValue[];
    if(e.kind==='data_source')rows=await queryAll(e.source_id);else{const p=await get('page',e.id);if(p.parent?.type!=='data_source_id'||id(p.parent.data_source_id)!==e.source_id)return fail('CONTROL_SCOPE_MISMATCH');rows=[p];}
    const records=rows.map(p=>fields(p,e.columns,e.role)),blocks:ObjectValue[]=[];
    if(e.children)for(const row of rows)blocks.push(...await blockTree(id(row.id)));
    edges.push({role:e.role,runtime_id:e.runtime_id??null,id:e.id,source_id:e.source_id,columns,records,blocks});
   }
   return{binding_hash:digest(b),runtime_ids:inventory.map(r=>r.runtime_id),inventory,edges,resources:[...resources.values()].sort((a,c)=>(a.kind+':'+a.id).localeCompare(c.kind+':'+c.id))};
  };
  const first=await snapshot(),last=await snapshot(),serialized=canon(first);if(Buffer.byteLength(serialized)>8*1024*1024)return fail('CONTROL_READ_INCOMPLETE');if(serialized!==canon(last))return fail('CONTROL_INPUT_CHANGED');
  return{status:'CONTROL_READ_SET_OBSERVED',input_revision:digest(first),observed_at:new Date().toISOString(),...first,atomic:false,control_confirmed:false,business_result_verified:false,not_proved:['CONTROL_INVARIANT_RESULTS','CANONICAL_ARTIFACT_CUSTODY','G11_CONFIRMATION','GMAIL_TRUTH','RECIPIENT_CONSUMPTION']};
 }catch(error){return{status:'UNCONFIRMED',reason:error instanceof Error&&errors.includes(error.message as Reason)?error.message:'CONTROL_SOURCE_UNAVAILABLE',atomic:false,control_confirmed:false,business_result_verified:false};}
}
