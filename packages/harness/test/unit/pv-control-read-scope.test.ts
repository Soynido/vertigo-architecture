import{test}from'node:test';import assert from'node:assert/strict';
const id=(n:number)=>n.toString(16).padStart(32,'0'),url=(n:number)=>'https://app.notion.com/p/'+id(n),stamp='2026-10-16T17:00:00.000Z';
const rich=(s:string)=>({type:'rich_text',rich_text:[{type:'text',plain_text:s,text:{content:s}}]}),property=(v:any,type='rich_text')=>type==='rich_text'?rich(v):{type,[type]:type==='select'?{name:v}:v};
const globalRoles=['META_MANIFEST','META_RUNS','META_LEDGER','META_GATES','META_REGISTRY','META_MIRRORS','SHARED_ACCOUNTS','SHARED_CONTACTS','SHARED_INTERACTIONS','SHARED_ENROLLMENTS','SHARED_DECISIONS','PUBLISHED_CURRENT','PUBLISHED_PACKAGES','PUBLISHED_COMPATIBILITY'];
const personalRoles=['PERSONAL_MANIFEST','PERSONAL_RUNS','PERSONAL_LEDGER','PERSONAL_STATE','PERSONAL_INTENTS','PERSONAL_RECEIPTS'];
function fixture(){
 const pages=new Map<string,any>(),sources=new Map<string,any>(),databases=new Map<string,any>(),rows=new Map<string,any[]>(),blocks=new Map<string,any[]>(),reads:any[]=[];let serial=100;
 const page=(n:number,parent:any,properties:any={})=>({object:'page',id:id(n),parent,properties,archived:false,in_trash:false,last_edited_time:stamp});
 for(const n of[1,2,3,10,11])pages.set(id(n),page(n,{type:'workspace',workspace:true}));
 const source=(n:number,root:number,columns:Record<string,string>)=>{sources.set(id(n),{object:'data_source',id:id(n),parent:{type:'database_id',database_id:id(1000+n)},properties:Object.fromEntries(Object.entries(columns).map(([name,type],i)=>[name,{id:'p'+i,name,type,[type]:type==='select'?{options:[{id:'open',name:'OPEN',color:'gray'}]}:{}}])),last_edited_time:stamp,archived:false,in_trash:false});databases.set(id(1000+n),{object:'database',id:id(1000+n),parent:{type:'page_id',page_id:id(root)},last_edited_time:stamp,archived:false,in_trash:false});rows.set(id(n),[]);};
 source(50,1,{'Runtime ID':'rich_text','Root URL':'url','Source Manifest URL':'url','Runtime State':'select'});
 const runtimes=[{runtime_id:'SALES-A',root_page_id:id(10)},{runtime_id:'SALES-UNBOUND',root_page_id:id(11)}],edges:any[]=[];
 for(const [role,runtime]of[...globalRoles.map(role=>[role,undefined]),...runtimes.flatMap(r=>personalRoles.map(role=>[role,r]))]as any[]){
  const root=runtime?Number.parseInt(runtime.root_page_id,16):role.startsWith('SHARED_')?2:role.startsWith('PUBLISHED_')?3:1,n=serial++;
  source(n,root,{State:'rich_text'});const p=page(5000+n,{type:'data_source_id',data_source_id:id(n)},{State:rich('OPEN')});rows.get(id(n))!.push(p);pages.set(p.id,p);
  const isPage=['META_MANIFEST','PERSONAL_MANIFEST','PERSONAL_STATE','PUBLISHED_CURRENT','PUBLISHED_PACKAGES'].includes(role);
  edges.push({role,...(runtime?{runtime_id:runtime.runtime_id}:{}),kind:isPage?'page':'data_source',id:isPage?p.id:id(n),source_id:id(n),columns:{State:'rich_text'},...(role==='PUBLISHED_PACKAGES'?{children:true}:{})});
  if(role==='PUBLISHED_PACKAGES')blocks.set(p.id,[{object:'block',id:id(9000),parent:{type:'page_id',page_id:p.id},type:'code',code:{language:'json',rich_text:rich('{"version":1}').rich_text},has_children:false,archived:false,in_trash:false,last_edited_time:stamp}]);
 }
 for(const [i,r]of runtimes.entries()){const manifest=edges.find(e=>e.role==='PERSONAL_MANIFEST'&&e.runtime_id===r.runtime_id);const p=page(60+i,{type:'data_source_id',data_source_id:id(50)},{'Runtime ID':rich(r.runtime_id),'Root URL':property('https://app.notion.com/p/'+r.root_page_id,'url'),'Source Manifest URL':property('https://app.notion.com/p/'+manifest.id,'url'),'Runtime State':property(i?'UNBOUND':'SETUP','select')});rows.get(id(50))!.push(p);pages.set(p.id,p);}
 const binding={meta_root_id:id(1),os_registry_source_id:id(50),shared_root_id:id(2),published_root_id:id(3),edges};
 const reader:any={retrievePage:async(ref:string)=>{reads.push(['page',ref]);return structuredClone(pages.get(ref));},retrieveDataSource:async(ref:string)=>{reads.push(['source',ref]);return structuredClone(sources.get(ref));},retrieveDatabase:async(ref:string)=>{reads.push(['database',ref]);return structuredClone(databases.get(ref));},queryDataSource:async(ref:string,filter:any,cursor:any,options:any)=>{reads.push(['query',ref,cursor]);assert.equal(filter,undefined,'full control read, not a hidden filtered subset');assert.equal(options?.page_size,100);assert.equal(cursor,undefined);return{object:'list',results:structuredClone(rows.get(ref)),has_more:false,next_cursor:null};},retrieveBlockChildren:async(ref:string,cursor?:string)=>{reads.push(['blocks',ref,cursor]);assert.equal(cursor,undefined);return{object:'list',results:structuredClone(blocks.get(ref)??[]),has_more:false,next_cursor:null};}};
 return{binding,reader,pages,sources,databases,rows,blocks,reads,edges};
}
async function collect(r:ReturnType<typeof fixture>){const m=await import(new URL('../../src/verify/controlReadScope.ts',import.meta.url).href).catch((e:any)=>{if(e.code==='ERR_MODULE_NOT_FOUND')return null;throw e;});return m?m.collectControlReadScope(r.reader,r.binding):{status:'NOT_IMPLEMENTED'};}
test('control collector reads all registered runtimes including UNBOUND without claiming a gate or business result',async()=>{
 // Break caught: scope selected only from installed collaborators silently omits
 // a registered personal runtime. Only the external Notion boundary is doubled.
 const r=fixture(),result=await collect(r);assert.equal(result.status,'CONTROL_READ_SET_OBSERVED');assert.deepEqual(result.runtime_ids,['SALES-A','SALES-UNBOUND']);assert.equal(result.edges.length,26);assert.match(result.input_revision,/^[a-f0-9]{64}$/);assert.equal(result.control_confirmed,false);assert.equal(result.business_result_verified,false);assert.equal(result.writes,undefined);
});
test('control collector refuses a missing required source rather than treating it as an empty source',async()=>{const r=fixture();r.binding.edges=r.edges.filter(e=>e.role!=='SHARED_CONTACTS');const result=await collect(r);assert.equal(result.status,'UNCONFIRMED');assert.equal(result.reason,'CONTROL_BINDINGS_INCOMPLETE');});
test('control collector refuses omission of an unbound registered personal runtime',async()=>{const r=fixture();r.binding.edges=r.edges.filter(e=>e.runtime_id!=='SALES-UNBOUND');const result=await collect(r);assert.equal(result.status,'UNCONFIRMED');assert.equal(result.reason,'CONTROL_BINDINGS_INCOMPLETE');});
test('control collector rejects a personal Manifest that differs from the authoritative OS Registry pointer',async()=>{const r=fixture();r.rows.get(id(50))![0].properties['Source Manifest URL']=property(url(999),'url');const result=await collect(r);assert.equal(result.status,'UNCONFIRMED');assert.equal(result.reason,'CONTROL_SCOPE_MISMATCH');});
test('control collector refuses foreign source ancestry or a row returned from another source',async(t)=>{
 for(const change of[(r:ReturnType<typeof fixture>)=>{const e=r.edges.find(e=>e.role==='SHARED_CONTACTS');r.databases.get(id(1000+Number.parseInt(e.source_id,16))).parent.page_id=id(10);},(r:ReturnType<typeof fixture>)=>{const e=r.edges.find(e=>e.role==='SHARED_CONTACTS');r.rows.get(e.source_id)![0].parent.data_source_id=id(50);}]as const)await t.test('foreign binding',async()=>{const r=fixture();change(r);assert.equal((await collect(r)).reason,'CONTROL_SCOPE_MISMATCH');});
});
test('control collector follows data pagination including an empty intermediate page',async()=>{
 const r=fixture(),query=r.reader.queryDataSource,e=r.edges.find(e=>e.role==='SHARED_CONTACTS');
 r.reader.queryDataSource=async(ref:string,f:any,c:any,o:any)=>ref!==e.source_id?query(ref,f,c,o):c===undefined?{object:'list',results:[],has_more:true,next_cursor:'second'}:c==='second'?{object:'list',results:[],has_more:true,next_cursor:'third'}:{object:'list',results:structuredClone(r.rows.get(ref)),has_more:false,next_cursor:null};
 const result=await collect(r);assert.equal(result.status,'CONTROL_READ_SET_OBSERVED');assert.equal(result.edges.find((x:any)=>x.role==='SHARED_CONTACTS').records.length,1);
});
test('control collector rejects an absent or repeating pagination cursor',async(t)=>{
 for(const cursor of[null,'same'])await t.test(String(cursor),async()=>{const r=fixture(),query=r.reader.queryDataSource,e=r.edges.find(e=>e.role==='SHARED_CONTACTS');r.reader.queryDataSource=async(ref:string,...args:any[])=>ref===e.source_id?{object:'list',results:[],has_more:true,next_cursor:cursor}:query(ref,...args);const result=await collect(r);assert.equal(result.status,'UNCONFIRMED');assert.equal(result.reason,'CONTROL_READ_INCOMPLETE');});
});
test('control collector refuses a repeated physical row instead of silently deduplicating it',async()=>{const r=fixture(),e=r.edges.find(e=>e.role==='META_LEDGER');r.rows.get(e.source_id)!.push(structuredClone(r.rows.get(e.source_id)![0]));assert.equal((await collect(r)).reason,'CONTROL_READ_INCOMPLETE');});
test('control collector rejects truncated or wrong-typed selected properties',async(t)=>{
 for(const change of[(p:any)=>{p.State={...rich('OPEN'),has_more:true};},(p:any)=>{p.State=property('OPEN','select');},(p:any)=>{delete p.State;}]as const)await t.test('unreadable property',async()=>{const r=fixture(),e=r.edges.find(e=>e.role==='META_LEDGER');change(r.rows.get(e.source_id)![0].properties);assert.equal((await collect(r)).reason,'CONTROL_FIELDS_UNREADABLE');});
});
test('control collector refuses a selected schema property changed to an incompatible type',async()=>{const r=fixture(),e=r.edges.find(e=>e.role==='META_LEDGER');r.sources.get(e.source_id).properties.State.type='number';assert.equal((await collect(r)).reason,'CONTROL_FIELDS_UNREADABLE');});
test('control collector detects changed input fields or a newly registered runtime on its second pass',async(t)=>{
 for(const kind of['field','inventory'])await t.test(kind,async()=>{const r=fixture(),query=r.reader.queryDataSource,e=r.edges.find(e=>e.role==='META_LEDGER');let n=0;r.reader.queryDataSource=async(ref:string,...args:any[])=>{if(ref===id(50)&&++n===2){if(kind==='field')r.rows.get(e.source_id)![0].properties.State=rich('CHANGED');else{const p=structuredClone(r.rows.get(id(50))![0]);p.id=id(80);p.properties['Runtime ID']=rich('SALES-NEW');r.rows.get(id(50))!.push(p);}}return query(ref,...args);};assert.equal((await collect(r)).status,'UNCONFIRMED');});
});
test('control collector ignores response request IDs and result ordering, not native revisions',async()=>{
 const r=fixture(),query=r.reader.queryDataSource,get=r.reader.retrievePage;let n=0;r.reader.queryDataSource=async(...a:any[])=>{const q=await query(...a);return{...q,request_id:'query-'+ ++n,results:q.results.reverse()};};r.reader.retrievePage=async(ref:string)=>({...await get(ref),request_id:'page-'+ ++n});assert.equal((await collect(r)).status,'CONTROL_READ_SET_OBSERVED');
 const changed=fixture(),read=changed.reader.retrievePage;let roots=0;changed.reader.retrievePage=async(ref:string)=>{const p=await read(ref);if(ref===id(1)&&++roots>1)p.last_edited_time='2026-10-16T17:01:00Z';return p;};assert.equal((await collect(changed)).reason,'CONTROL_INPUT_CHANGED');
});
test('control collector observes configured package child blocks and refuses incomplete nested reads',async()=>{
 const r=fixture(),e=r.edges.find(e=>e.role==='PUBLISHED_PACKAGES'),result=await collect(r);assert.equal(result.status,'CONTROL_READ_SET_OBSERVED');assert.equal(result.edges.find((x:any)=>x.role==='PUBLISHED_PACKAGES').blocks.length,1);
 const bad=fixture(),get=bad.reader.retrieveBlockChildren;bad.reader.retrieveBlockChildren=async(ref:string,...a:any[])=>ref===e.id?{object:'list',results:[],has_more:true,next_cursor:null}:get(ref,...a);assert.equal((await collect(bad)).reason,'CONTROL_READ_INCOMPLETE');
});
test('control collector returns closed errors without connector secrets, business payloads or partial facts',async()=>{
 const r=fixture();r.reader.retrieveDataSource=async()=>{throw Error('Authorization Bearer SECRET_PRIVATE_MAIL_BODY');};const result=await collect(r);assert.equal(result.status,'UNCONFIRMED');assert.equal(result.reason,'CONTROL_SOURCE_UNAVAILABLE');assert.equal(result.edges,undefined);assert.ok(!JSON.stringify(result).includes('SECRET'));assert.equal(result.writes,undefined);
});
test('control collector rejects registry schema drift instead of trusting old-looking inventory rows',async(t)=>{
 // Break caught: row values alone cannot establish the identity/type of the
 // authoritative inventory's native properties.
 for(const change of[(r:ReturnType<typeof fixture>)=>{r.sources.get(id(50)).properties['Runtime ID'].type='number';},(r:ReturnType<typeof fixture>)=>{r.sources.get(id(50)).properties['Runtime State'].id=r.sources.get(id(50)).properties['Runtime ID'].id;}]as const)await t.test('inventory schema',async()=>{const r=fixture();change(r);assert.equal((await collect(r)).reason,'CONTROL_FIELDS_UNREADABLE');});
 const changed=fixture(),get=changed.reader.retrieveDataSource;let reads=0;changed.reader.retrieveDataSource=async(ref:string)=>{const s=await get(ref);if(ref===id(50)&&++reads===2)s.properties['Runtime ID'].id='replaced-native-id';return s;};assert.equal((await collect(changed)).reason,'CONTROL_INPUT_CHANGED');
});
test('control collector bounds a nonterminating data-source scan without certifying partial coverage',async()=>{
 const r=fixture(),query=r.reader.queryDataSource,e=r.edges.find(e=>e.role==='SHARED_CONTACTS');let requests=0;
 r.reader.queryDataSource=async(ref:string,...a:any[])=>ref===e.source_id?{object:'list',results:[],has_more:true,next_cursor:'unbounded-'+ ++requests}:query(ref,...a);
 const result=await collect(r);assert.equal(result.status,'UNCONFIRMED');assert.equal(result.reason,'CONTROL_READ_INCOMPLETE');assert.ok(requests<=20);assert.equal(result.edges,undefined);
});
test('control collector refuses cyclic ancestry and unavailable configured roots',async(t)=>{
 for(const change of[(r:ReturnType<typeof fixture>)=>{const e=r.edges.find(e=>e.role==='SHARED_CONTACTS'),db=r.databases.get(id(1000+Number.parseInt(e.source_id,16)));db.parent={type:'database_id',database_id:db.id};},(r:ReturnType<typeof fixture>)=>{r.pages.get(id(2)).archived=true;}]as const)await t.test('invalid scope',async()=>{const r=fixture();change(r);assert.equal((await collect(r)).reason,'CONTROL_SCOPE_MISMATCH');});
});
test('control collector follows nested package blocks and binds their actual content revisions',async()=>{
 const r=fixture(),e=r.edges.find(e=>e.role==='PUBLISHED_PACKAGES');r.blocks.get(e.id)![0].has_children=true;
 r.blocks.set(id(9000),[{object:'block',id:id(9001),parent:{type:'block_id',block_id:id(9000)},type:'paragraph',paragraph:{rich_text:rich('Nested immutable package content').rich_text},has_children:false,archived:false,in_trash:false,last_edited_time:stamp}]);
 const result=await collect(r);assert.equal(result.status,'CONTROL_READ_SET_OBSERVED');assert.equal(result.edges.find((x:any)=>x.role==='PUBLISHED_PACKAGES').blocks.length,2);
 const read=r.reader.retrieveBlockChildren;let n=0;r.reader.retrieveBlockChildren=async(ref:string,...a:any[])=>{const q=await read(ref,...a);if(ref===id(9001))throw Error('Unexpected child traversal');if(ref===id(9000)&&++n===2)q.results[0].paragraph.rich_text=rich('CHANGED').rich_text;return q;};assert.equal((await collect(r)).reason,'CONTROL_INPUT_CHANGED');
});
test('control collector includes canonical inventory property identities in its input revision',async()=>{
 const first=fixture(),before=await collect(first);assert.equal(before.status,'CONTROL_READ_SET_OBSERVED');
 const changed=fixture();changed.sources.get(id(50)).properties['Runtime ID'].id='different-native-property';const after=await collect(changed);assert.equal(after.status,'CONTROL_READ_SET_OBSERVED');assert.notEqual(after.input_revision,before.input_revision);
});
function packageSourceFixture(){
 const r=fixture(),edge=r.edges.find(e=>e.role==='PUBLISHED_PACKAGES'),first=r.rows.get(edge.source_id)![0],second=structuredClone(first);second.id=id(9900);r.rows.get(edge.source_id)!.push(second);r.pages.set(second.id,second);edge.kind='data_source';edge.id=edge.source_id;
 r.blocks.set(second.id,[{object:'block',id:id(9901),parent:{type:'page_id',page_id:second.id},type:'code',code:{language:'json',rich_text:rich('{"version":2}').rich_text},has_children:false,archived:false,in_trash:false,last_edited_time:stamp}]);return{...r,edge,first,second};
}
test('control collector reads the content of every package row in a data-source edge',async()=>{
 // Break caught: metadata from all package rows is observed, but only one
 // configured page body is read; other immutable versions could be altered.
 const r=packageSourceFixture(),result=await collect(r);assert.equal(result.status,'CONTROL_READ_SET_OBSERVED');const packages=result.edges.find((e:any)=>e.role==='PUBLISHED_PACKAGES');assert.equal(packages.records.length,2);assert.deepEqual(packages.blocks.map((b:any)=>b.parent).sort(),[r.first.id,r.second.id].sort());
});
test('control collector includes a nonfirst package body in the second-pass stability check',async()=>{
 const r=packageSourceFixture(),get=r.reader.retrieveBlockChildren;let n=0;r.reader.retrieveBlockChildren=async(ref:string,...args:any[])=>{const q=await get(ref,...args);if(ref===r.second.id&&++n===2)q.results[0].code.rich_text=rich('{"version":"tampered"}').rich_text;return q;};assert.equal((await collect(r)).reason,'CONTROL_INPUT_CHANGED');
});
test('control collector accepts an explicitly read empty package source without making an invalid source-level child read',async()=>{
 const r=packageSourceFixture();r.rows.set(r.edge.source_id,[]);const get=r.reader.retrieveBlockChildren;r.reader.retrieveBlockChildren=async(ref:string,...args:any[])=>{assert.notEqual(ref,r.edge.source_id,'data source is not a block/page');return get(ref,...args);};const result=await collect(r);assert.equal(result.status,'CONTROL_READ_SET_OBSERVED');const packages=result.edges.find((e:any)=>e.role==='PUBLISHED_PACKAGES');assert.equal(packages.records.length,0);assert.equal(packages.blocks.length,0);
});
test('control collector bounds total package block coverage across multiple rows, not just each row separately',async()=>{
 const r=packageSourceFixture(),get=r.reader.retrieveBlockChildren;let calls=0;
 r.reader.retrieveBlockChildren=async(ref:string,cursor?:string)=>{if(![r.first.id,r.second.id].includes(ref))return get(ref,cursor);calls++;const part=cursor?Number(cursor):0,start=part*100,offset=ref===r.first.id?10000:20000;
 return{object:'list',results:Array.from({length:100},(_,i)=>({object:'block',id:id(offset+start+i),parent:{type:'page_id',page_id:ref},type:'paragraph',paragraph:{rich_text:rich('Package fact').rich_text},has_children:false,archived:false,in_trash:false,last_edited_time:stamp})),has_more:part<10,next_cursor:part<10?String(part+1):null};};
 const result=await collect(r);assert.equal(result.status,'UNCONFIRMED');assert.equal(result.reason,'CONTROL_READ_INCOMPLETE');assert.ok(calls<=22);assert.equal(result.edges,undefined);
});
test('control collector refuses one physical block attributed to two package rows',async()=>{
 const r=packageSourceFixture();r.blocks.get(r.second.id)![0].id=id(9000);const result=await collect(r);assert.equal(result.status,'UNCONFIRMED');assert.equal(result.reason,'CONTROL_SCOPE_MISMATCH');
});
