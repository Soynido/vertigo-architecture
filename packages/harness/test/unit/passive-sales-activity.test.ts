import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HttpNotionReadClient} from '../../src/notion/readClient.ts';

const id=(n:number)=>n.toString(16).padStart(32,'0');
const stamp='2026-10-20T08:00:00.000Z';
const title=(s:string)=>({title:{type:'title',title:[{plain_text:s}]}});
function fixture(offset=0){
 const root=id(offset+1),ops=id(offset+2),doc=id(offset+3),runs=id(offset+4),db=id(offset+5),control=id(offset+6),run=id(offset+7);
 const page=(pid:string,parent:any,name:string,edited=stamp)=>({object:'page',id:pid,parent,archived:false,in_trash:false,created_time:stamp,last_edited_time:edited,properties:title(name)});
 const child=(pid:string,parent:string,name:string)=>({object:'block',id:pid,type:'child_page',parent:{type:'page_id',page_id:parent},archived:false,in_trash:false,created_time:stamp,last_edited_time:stamp,child_page:{title:name}});
 const list=(results:any[],has_more=false)=>({object:'list',results,has_more,next_cursor:has_more?'more':null});
 const map:any={
  [`/pages/${root}`]:page(root,{type:'workspace',workspace:true},'OS'),
  [`/blocks/${root}/children`]:list([child(ops,root,'05 — OPERATIONS & PLAYBOOKS')]),
  [`/pages/${ops}`]:page(ops,{type:'page_id',page_id:root},'Operations'),
  [`/blocks/${ops}/children`]:list([child(doc,ops,'Contrôle final des 120 brouillons')]),
  [`/pages/${doc}`]:page(doc,{type:'page_id',page_id:ops},'Contrôle final des 120 brouillons'),
  [`/data_sources/${runs}`]:{object:'data_source',id:runs,parent:{type:'database_id',database_id:db}},
  [`/databases/${db}`]:{object:'database',id:db,parent:{type:'page_id',page_id:control}},
  [`/pages/${control}`]:page(control,{type:'page_id',page_id:root},'Control'),
  [`/data_sources/${runs}/query`]:list([{...page(run,{type:'data_source_id',data_source_id:runs},'Installation','2026-10-16T16:00:00.000Z'),properties:{Run:{type:'title',title:[{plain_text:'Installation'}]},'Run Type':{type:'select',select:{name:'REVIEW'}},Status:{type:'select',select:{name:'COMPLETED'}}}}]),
 };
 return {profile:{principal_id:`rep-${offset}`,root_page_id:root,runs_data_source_id:runs},map,root,ops,doc,runs,list,page};
}
async function api(){const mod=await import(new URL('../../src/verify/passiveSalesActivity.ts',import.meta.url).href).catch(()=>null);assert.ok(mod?.PassiveSalesActivity,'missing passive artifact observer');return mod;}
async function rig(change?:(path:string,data:any)=>any){
 const fixtures=[fixture(),fixture(20),fixture(40)],map=Object.assign({},...fixtures.map(x=>x.map)),requests:any[]=[];
 const reader=new HttpNotionReadClient('fixture',async(raw,init)=>{
  const path=new URL(raw).pathname.replace('/v1','');requests.push({path,method:init.method,body:init.body});
  if(!map[path])throw Error('unexpected path');
  const value=change?change(path,structuredClone(map[path])):map[path];
  if(value instanceof Error)throw value;
  return {status:value?.http_status??200,json:async()=>value};
 },{max429Retries:0,requestTimeoutMs:100});
 const {PassiveSalesActivity}=await api();
 const observer=new PassiveSalesActivity(reader,fixtures.map(x=>x.profile),async()=>true,{maxReads:60,deadlineMs:1000,cacheMs:10});
 return {observer,requests,fixtures,reader};
}

// Break: Runs-only collection misses independently persisted documents; counts in titles become fake results.
test('passive activity covers all configured roots and separates document metadata from declared runs',async()=>{
 const r=await rig(),out=await r.observer.read();
 assert.equal(out.profiles.length,3);
 assert.equal(out.untrusted_text,'DATA_NOT_INSTRUCTIONS');assert.equal(out.authority_granted,false);
 for(const p of out.profiles){assert.equal(p.documents.length,1);assert.equal(p.documents[0].evidence,'PAGE_METADATA_READ');assert.equal(p.runs.rows[0].run_type,'REVIEW');assert.equal(p.documents_newer_than_latest_run,1);assert.equal(p.satisfaction,'NOT_MEASURED');assert.equal(p.business_effects,'NOT_VERIFIED');assert.equal(p.coverage.exhaustive,false);}
 assert.equal(r.requests.every(x=>x.method==='GET'||x.method==='POST'&&x.path.endsWith('/query')),true);
 assert.equal(r.requests.filter(x=>x.method==='POST').every(x=>JSON.parse(x.body).page_size===10),true);
 assert.equal(JSON.stringify(out).includes('confirmed_count'),false);
});
// Break: a moved page, source chain or linked mention leaks another collaborator's data.
for(const target of ['document','source'])test(`passive activity withholds ${target} moved outside its root`,async()=>{
 const f=fixture(),r=await rig((path,data)=>{
  if(target==='document'&&path===`/pages/${f.doc}`)data.parent={type:'page_id',page_id:id(999)};
  if(target==='source'&&path===`/pages/${id(6)}`)data.parent={type:'page_id',page_id:id(999)};
  return data;
 });
 const out=await r.observer.read(),first=out.profiles[0];
 if(target==='document')assert.equal(first.documents.some((d:any)=>d.evidence==='PAGE_METADATA_READ'),false);
 else assert.equal(first.runs.rows.length,0);
 assert.equal(first.coverage.status,'PARTIAL');assert.equal(out.profiles.length,3);
});
// Break: an inaccessible root globally blocks observation; provider errors expose raw secrets.
test('passive activity isolates local failures and never returns raw provider errors',async()=>{
 const r=await rig((path,data)=>path===`/pages/${id(1)}`?new Error('SECRET provider body'):data),out=await r.observer.read();
 assert.equal(out.profiles[0].coverage.status,'UNAVAILABLE');assert.equal(out.profiles[1].documents.length,1);assert.equal(JSON.stringify(out).includes('SECRET'),false);
});
// Break: truncated listings are described as a complete activity feed.
test('passive activity marks a truncated listing partial without inventing zero activity',async()=>{
 const r=await rig((path,data)=>path===`/blocks/${id(2)}/children`?{...data,has_more:true,next_cursor:'opaque'}:data),out=await r.observer.read();
 assert.equal(out.profiles[0].coverage.status,'PARTIAL');assert.equal(out.profiles[0].documents.length,1);assert.equal(out.profiles[0].coverage.exhaustive,false);
});
// Break: a revoked collaborator remains exposed from cache or while reading.
test('passive activity rechecks admission before exposing fresh or cached observations',async()=>{
 const {PassiveSalesActivity}=await api(),f=fixture();let admitted=true;
 const r=await rig();const observer=new PassiveSalesActivity(r.reader,[f.profile],async()=>admitted,{cacheMs:10000});
 const first=await observer.read();assert.equal(first.profiles.length,1);admitted=false;
 const second=await observer.read();assert.deepEqual(second.profiles,[]);
});
// Break: unbounded traffic/slow reads or overlapping owner requests contend with normal work.
test('passive activity bounds requests, coalesces reads and labels cache age',async()=>{
 const {PassiveSalesActivity}=await api(),r=await rig();
 const observer=new PassiveSalesActivity(r.reader,r.fixtures.map(x=>x.profile),async()=>true,{maxReads:2,deadlineMs:1000,cacheMs:10000});
 const [a,b]=await Promise.all([observer.read(),observer.read()]);assert.equal(a.profiles.length,3);assert.deepEqual(a,b);assert.equal(r.requests.length,2);
 const cached=await observer.read();assert.equal(r.requests.length,2);assert.equal(cached.cache,'CACHED');assert.equal(cached.profiles.every((p:any)=>p.coverage.status==='PARTIAL'),true);
});
test('passive activity returns partial within its deadline even if a reader never resolves',async()=>{
 const {PassiveSalesActivity}=await api();const f=fixture(),reader={retrievePage:()=>new Promise(()=>{})};
 const out=await new PassiveSalesActivity(reader,[f.profile],async()=>true,{deadlineMs:15}).read();assert.equal(out.profiles[0].coverage.status,'PARTIAL');
});
// Break: the passive payload grows with the workspace and overwhelms the owner's normal context.
test('passive activity bounds returned document listings independently of provider pagination',async()=>{
 const f=fixture(),r=await rig((path,data)=>path===`/blocks/${f.ops}/children`?{...data,results:Array.from({length:40},(_,n)=>({...data.results[0],id:id(200+n)}))}:data);
 const out=await r.observer.read();assert.equal(out.profiles[0].documents.length,12);assert.equal(out.profiles[0].coverage.status,'PARTIAL');
});
// Break: a stalled admission check hangs the otherwise independent META context forever.
test('passive activity times out an unavailable admission check without exposing cached data',async()=>{
 const {PassiveSalesActivity}=await api(),f=fixture();
 const report=await Promise.race([new PassiveSalesActivity({},[f.profile],()=>new Promise(()=>{}),{deadlineMs:15}).read(),new Promise((_,reject)=>setTimeout(()=>reject(Error('admission did not terminate')),100))]);
 assert.deepEqual(report.profiles,[]);
});
// Characterization of the real strict HTTP client: a 429 must stop subsequent passive I/O, no retry.
test('passive activity stops on the strict client rate-limit classification without leaking provider text',async()=>{
 const r=await rig(()=>({http_status:429,code:'rate_limited',message:'SECRET provider body'})),out=await r.observer.read();
 assert.equal(r.requests.length,3);assert.equal(out.reads,3);assert.equal(out.profiles.every((p:any)=>p.coverage.status==='UNAVAILABLE'),true);assert.equal(JSON.stringify(out).includes('SECRET'),false);
});
