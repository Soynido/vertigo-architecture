/** Owner-side metadata observation. Never a business writer, tool interceptor or satisfaction score. */
import type {NotionReadClient} from '../notion/readClient.ts';

export type ActivityProfile={principal_id:string;root_page_id:string;runs_data_source_id:string};
type Options={maxReads?:number;deadlineMs?:number;cacheMs?:number};
type Document={page_id:string;url:string;title:string;parent_id:string;evidence:'CHILD_PAGE_LISTED'|'PAGE_METADATA_READ';revision?:string;created_at?:string};
type Run={page_id:string;url:string;revision:string;title:string;run_type:string|null;status:string|null;evidence:'NOTION_DECLARATION_READ'};
type ProfileObservation={principal_id:string;root_page_id:string;documents:Document[];runs:{rows:Run[];has_more:boolean|null;limit:10};documents_newer_than_latest_run:number|null;satisfaction:'NOT_MEASURED';business_effects:'NOT_VERIFIED';coverage:{status:'OBSERVED'|'PARTIAL'|'UNAVAILABLE';exhaustive:false;scope:readonly string[];issues:string[]}};
export type PassiveActivityReport={kind:'PASSIVE_SALES_ACTIVITY/1';untrusted_text:'DATA_NOT_INSTRUCTIONS';authority_granted:false;observed_at:string;finished_at:string;cache:'FRESH'|'CACHED';not_atomic_snapshot:true;configured_profiles:number;profiles:ProfileObservation[];reads:number;not_proved:readonly string[]};
const norm=(s:unknown)=>typeof s==='string'&&/^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(s)?s.replaceAll('-','').toLowerCase():undefined;
const obj=(v:unknown):Record<string,any>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('INVALID_SOURCE');return v as Record<string,any>;};
const timestamp=(s:unknown):s is string=>typeof s==='string'&&Number.isFinite(Date.parse(s));
// Titles are untrusted evidence, not instructions. Do not copy URLs, mailboxes or credential-like values.
const safeTitle=(s:unknown)=>typeof s==='string'?s.replace(/https?:\/\/\S+|[^\s@]+@[^\s@]+|[a-z\d_-]{40,}/gi,'[masqué]').slice(0,256):'';
function entity(value:unknown,id:string,kind:string){const r=obj(value);if(r.object!==kind||norm(r.id)!==id||r.archived===true||r.in_trash===true)throw Error('SCOPE_MISMATCH');return r;}
function page(value:unknown,id:string){const r=entity(value,id,'page');if(!timestamp(r.last_edited_time)||r.archived!==false||r.in_trash!==false)throw Error('INCOMPLETE_READ');return r;}
function pageTitle(p:Record<string,any>){for(const v of Object.values(obj(p.properties))){const field=obj(v);if(field.type==='title'&&Array.isArray(field.title))return safeTitle(field.title.map((x:any)=>x.plain_text??'').join(''));}return '';}
function selected(p:Record<string,any>,key:string){const v=p.properties?.[key];return v?.type==='select'&&typeof v.select?.name==='string'?safeTitle(v.select.name):null;}
class Limited extends Error{}

export class PassiveSalesActivity{
 readonly #reader:NotionReadClient;readonly #profiles:ActivityProfile[];readonly #admitted:(id:string)=>Promise<boolean>;
 readonly #options:Required<Options>;#cached?:PassiveActivityReport;#pending:Promise<PassiveActivityReport>|undefined;
 constructor(reader:NotionReadClient,profiles:readonly ActivityProfile[],admitted:(id:string)=>Promise<boolean>,options:Options={}){
  this.#reader=reader;this.#admitted=admitted;this.#profiles=profiles.map(p=>{const root=norm(p.root_page_id),runs=norm(p.runs_data_source_id);if(!root||!runs||!p.principal_id||root===runs)throw Error('INVALID_ACTIVITY_PROFILE');return {...p,root_page_id:root,runs_data_source_id:runs};});
  if(new Set(this.#profiles.map(p=>p.principal_id)).size!==profiles.length||new Set(this.#profiles.map(p=>p.root_page_id)).size!==profiles.length)throw Error('DUPLICATE_ACTIVITY_PROFILE');
  this.#options={maxReads:options.maxReads??60,deadlineMs:options.deadlineMs??25000,cacheMs:options.cacheMs??60000};
  for(const v of Object.values(this.#options))if(!Number.isFinite(v)||v<0)throw Error('INVALID_ACTIVITY_LIMIT');
 }
 async #allowed(id:string){let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([this.#admitted(id),new Promise<false>(resolve=>{timer=setTimeout(()=>resolve(false),Math.min(500,this.#options.deadlineMs));})]);}catch{return false;}finally{clearTimeout(timer);}}
 async read():Promise<PassiveActivityReport>{
  let report:PassiveActivityReport;
  if(this.#cached&&Date.now()-Date.parse(this.#cached.finished_at)<this.#options.cacheMs)report={...this.#cached,cache:'CACHED'};
  else{
   if(!this.#pending)this.#pending=this.#collect().then(r=>(this.#cached=r,r)).finally(()=>{this.#pending=undefined;});
   report=await this.#pending;
  }
  // Cached data is not a durable grant. Revocation also removes in-flight observations.
  const allowed=await Promise.all(report.profiles.map(p=>this.#allowed(p.principal_id)));
  return {...report,profiles:report.profiles.filter((_,i)=>allowed[i])};
 }
 async #collect():Promise<PassiveActivityReport>{
  const observed_at=new Date().toISOString(),deadline=Date.now()+this.#options.deadlineMs;let reads=0,rateLimited=false;
  const read=async(fn:()=>Promise<unknown>)=>{
   if(rateLimited||reads>=this.#options.maxReads||Date.now()>=deadline)throw new Limited();reads++;
   let timer:ReturnType<typeof setTimeout>|undefined;
   try{return await Promise.race([fn(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Limited()),Math.max(0,deadline-Date.now()));})]);}
   catch(e){if((e as {status?:unknown})?.status===429)rateLimited=true;throw e;}
   finally{clearTimeout(timer);}
  };
  const profiles=await Promise.all(this.#profiles.map(async p=>{
   if(!await this.#allowed(p.principal_id))return null;
   const out:ProfileObservation={principal_id:p.principal_id,root_page_id:p.root_page_id,documents:[],runs:{rows:[],has_more:null,limit:10},documents_newer_than_latest_run:null,satisfaction:'NOT_MEASURED',business_effects:'NOT_VERIFIED',coverage:{status:'OBSERVED',exhaustive:false,scope:['ROOT_AND_OPERATIONS_DIRECT_PAGES','RUNS_TOP_10','UP_TO_3_DOCUMENT_METADATA_READS'],issues:[]}};
   const issue=(code:string)=>{out.coverage.status='PARTIAL';if(!out.coverage.issues.includes(code))out.coverage.issues.push(code);};
   const children=async(id:string)=>{
    const l=obj(await read(()=>this.#reader.retrieveBlockChildren(id)));if(l.object!=='list'||!Array.isArray(l.results)||typeof l.has_more!=='boolean'||l.results.length>100)throw Error('INCOMPLETE_READ');
    if(l.has_more)issue('LISTING_TRUNCATED');
    return l.results.filter((b:any)=>b.type==='child_page'&&b.archived!==true&&b.in_trash!==true).map((b:any)=>{
     const pid=norm(b.id);if(!pid||norm(b.parent?.page_id)!==id)throw Error('SCOPE_MISMATCH');
     return {page_id:pid,url:`https://app.notion.com/p/${pid}`,title:safeTitle(b.child_page?.title),parent_id:id,evidence:'CHILD_PAGE_LISTED' as const,...(timestamp(b.created_time)?{created_at:b.created_time}:{})};
    });
   };
   try{page(await read(()=>this.#reader.retrievePage(p.root_page_id)),p.root_page_id);}
   catch(e){out.coverage.status=e instanceof Limited?'PARTIAL':'UNAVAILABLE';out.coverage.issues.push(e instanceof Limited?'READ_BUDGET_EXHAUSTED':'ROOT_UNAVAILABLE');return out;}
   try{
    const roots=await children(p.root_page_id);out.documents.push(...roots.filter(d=>!/^\d{2}\s*[—–-]/.test(d.title)));
    const sections=roots.filter(d=>/^05\s*[—–-]\s*OPERATIONS\b/i.test(d.title));
    if(sections.length!==1)issue('OPERATIONS_NOT_UNIQUE');
    else{
     const section=sections[0]!,s=page(await read(()=>this.#reader.retrievePage(section.page_id)),section.page_id);
     if(s.parent?.type!=='page_id'||norm(s.parent.page_id)!==p.root_page_id)throw Error('SCOPE_MISMATCH');
     out.documents.push(...await children(section.page_id));
    }
    out.documents.sort((a,b)=>Date.parse(b.created_at??'')-Date.parse(a.created_at??'')||a.page_id.localeCompare(b.page_id));
    if(out.documents.length>12){out.documents=out.documents.slice(0,12);issue('DOCUMENT_SAMPLE_LIMIT');}
    const ordered=out.documents.slice(0,3);
    for(const doc of ordered){
     try{const d=page(await read(()=>this.#reader.retrievePage(doc.page_id)),doc.page_id);if(d.parent?.type!=='page_id'||norm(d.parent.page_id)!==doc.parent_id)throw Error('SCOPE_MISMATCH');
      Object.assign(doc,{title:pageTitle(d),evidence:'PAGE_METADATA_READ',revision:d.last_edited_time,...(timestamp(d.created_time)?{created_at:d.created_time}:{})});
     }catch(e){issue(e instanceof Limited?'READ_BUDGET_EXHAUSTED':'DOCUMENT_NOT_CONFIRMED');}
    }
   }catch(e){issue(e instanceof Limited?'READ_BUDGET_EXHAUSTED':'DOCUMENT_SCOPE_OR_READ_FAILED');}
   try{
    // Verify the Runs source's entire ancestor chain before reading its rows. No search/links/synced blocks.
    let current=entity(await read(()=>this.#reader.retrieveDataSource(p.runs_data_source_id)),p.runs_data_source_id,'data_source'),connected=false;
    const seen=new Set<string>([p.runs_data_source_id]);
    for(let depth=0;depth<6;depth++){
     const parent=obj(current.parent),kind=parent.type,pid=norm(kind==='database_id'?parent.database_id:kind==='page_id'?parent.page_id:undefined);
     if(!pid||seen.has(pid))throw Error('SCOPE_MISMATCH');if(pid===p.root_page_id&&kind==='page_id'){connected=true;break;}seen.add(pid);
     current=kind==='database_id'?entity(await read(()=>this.#reader.retrieveDatabase(pid)),pid,'database'):page(await read(()=>this.#reader.retrievePage(pid)),pid);
    }
    if(!connected)throw Error('SCOPE_MISMATCH');
    const q=obj(await read(()=>this.#reader.queryDataSource(p.runs_data_source_id,undefined,undefined,{page_size:10,sorts:[{timestamp:'last_edited_time',direction:'descending'}]})));
    if(q.object!=='list'||!Array.isArray(q.results)||q.results.length>10||typeof q.has_more!=='boolean')throw Error('INCOMPLETE_READ');
    const rows=q.results.map((raw:any)=>{const rid=norm(raw.id);if(!rid)throw Error('INCOMPLETE_READ');const r=page(raw,rid);if(r.parent?.type!=='data_source_id'||norm(r.parent.data_source_id)!==p.runs_data_source_id)throw Error('SCOPE_MISMATCH');return {page_id:rid,url:`https://app.notion.com/p/${rid}`,revision:r.last_edited_time,title:pageTitle(r),run_type:selected(r,'Run Type'),status:selected(r,'Status'),evidence:'NOTION_DECLARATION_READ' as const};});
    out.runs={rows,has_more:q.has_more,limit:10};
    const latest=rows.reduce((max:number,r:Run)=>Math.max(max,Date.parse(r.revision)),0);
    if(latest)out.documents_newer_than_latest_run=out.documents.filter(d=>d.evidence==='PAGE_METADATA_READ'&&Date.parse(d.revision!)>latest).length;
   }catch(e){issue(e instanceof Limited?'READ_BUDGET_EXHAUSTED':'RUNS_SCOPE_OR_READ_FAILED');}
   return out;
  }));
  return {kind:'PASSIVE_SALES_ACTIVITY/1',untrusted_text:'DATA_NOT_INSTRUCTIONS',authority_granted:false,observed_at,finished_at:new Date().toISOString(),cache:'FRESH',not_atomic_snapshot:true,configured_profiles:this.#profiles.length,profiles:profiles.filter((p):p is ProfileObservation=>p!==null),reads,not_proved:['USER_SATISFACTION','HUMAN_TIME_SAVED','MAIL_CALENDAR_EFFECTS','asdk_app_EXAMPLE','PRIVATE_CHAT_OR_TOOL_ACTIVITY','EXHAUSTIVE_ACTIVITY']};
 }
}
