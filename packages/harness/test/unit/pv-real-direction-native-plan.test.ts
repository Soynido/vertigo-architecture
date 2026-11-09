import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture,id,url,rich,prop } from './real-direction-publication-fixtures.ts';
import * as publication from '../../src/verify/realDirectionPublication.ts';

// The only double is the external Notion read/write boundary: real orchestration and
// independent verification execute; writes happen only when explicitly applied below.
function fresh(orientation=false){
  const r=fixture(),bodies=new Map<string,string>(),effects:any[]=[];let serial=0;
  for(const key of [...r.pages.keys()])if(![id(1),id(6),id(7),id(61)].includes(key))r.pages.delete(key);
  r.pages.get(id(7)).properties['Objective Package URL']=prop(null,'url');r.pages.get(id(7)).properties['Local Method']=rich('Email first; keep individual approvals');
  const definition:Record<string,string>={Definition:'Cap de la semaine','Definition Key':'REAL_DIRECTION:REP_A:1:'+id(90),'Definition Type':'TOOLKIT_ITEM',Status:'APPROVED_FOR_VERSION',Content:'owner-approved signed envelope','Decision Ref':'OWNER_SESSION:'+id(90),Subtype:'ADAPTABLE_MANAGEMENT_DIRECTION'};
  const intent={proposal_id:id(90),definition_properties:definition,package_text:r.expected.package_text,previous_pointer:'',gate_before:r.expected.gate_before,approved_at:'2026-10-16T14:00:00Z',sealed_intent:'sealed exact approved proposal; private META only'};
  for(const [name,v]of Object.entries(intent.gate_before))r.pages.get(id(61)).properties[name]=['Status','Control Confirmation State'].includes(name)?prop(v,'select'):name==='Last Required Written At'?prop(null,'date'):rich(v);
  r.reader.retrieveBlockChildren=async(ref:string)=>({object:'list',has_more:false,next_cursor:null,results:ref===id(6)?[...r.pages.values()].filter(p=>p.parent?.type==='page_id'&&p.parent.page_id===id(6)).map(p=>({object:'block',id:p.id,type:'child_page',archived:false,in_trash:false,has_children:false,child_page:{title:p.properties.title.title.map((x:any)=>x.plain_text).join('')}})):[{object:'block',id:id(700),type:'code',archived:false,in_trash:false,has_children:false,code:{language:'json',rich_text:rich(bodies.get(ref)??'').rich_text}}]});
  const field=(p:any,k:string)=>{const v=p.properties[k];return v?.type==='rich_text'||v?.type==='title'?v[v.type].map((x:any)=>x.plain_text).join(''):v?.type==='select'?v.select?.name:v?.type==='date'?v.date?.start:v?.[v?.type];};
  const set=(p:any,k:string,v:any)=>{
    if(k.startsWith('date:')){if(k.endsWith(':start'))p.properties[k.slice(5,-6)]=prop(v,'date');return;}
    const type=['Run','Mutation','Definition','Decision','title'].includes(k)?'title':['Status','Origin','Run Type','Operation','Definition Type','Type','Control Confirmation State'].includes(k)?'select':k==='Recovery Required'?'checkbox':k==='Objective Package URL'?'url':typeof v==='number'?'number':'rich_text';
    p.properties[k]=type==='title'?{type,title:rich(v).rich_text}:prop(type==='checkbox'?v==='__YES__':v,type);
  };
  const apply=(w:any)=>{
    effects.push(structuredClone(w));let p:any;
    if(w.operation==='CREATE_IF_ABSENT'){
      assert.ok(![...r.pages.values()].some(p=>p.parent.data_source_id===w.data_source_id&&field(p,w.key_property)===w.key),'never replay a successful CREATE');
      p={object:'page',id:id(100+serial),archived:false,in_trash:false,last_edited_time:'',parent:{type:'data_source_id',data_source_id:w.data_source_id},properties:{}};
    }else if(w.operation==='CREATE_CHILD_IF_ABSENT'){
      p={object:'page',id:id(100+serial),archived:false,in_trash:false,last_edited_time:'',parent:{type:'page_id',page_id:w.parent_page_id},properties:{}};
      set(p,'title',w.title);bodies.set(p.id,w.content);
    }else{
      assert.equal(w.operation,'UPDATE_IF_MATCH');p=r.pages.get(w.page_id);assert.ok(p,'update only an existing exact page');assert.equal(w.expected_revision,p.last_edited_time,'fresh compare before native update');
      for(const [key,v]of Object.entries(w.before))assert.equal(field(p,key),v,'exact precondition '+key);
    }
    for(const [key,v]of Object.entries(w.properties??{}))set(p,key,v);
    p.last_edited_time=new Date(Date.parse('2026-10-16T14:02:00Z')+ ++serial).toISOString();r.pages.set(p.id,p);return p.id;
  };
  let scope:any=r.scope;
  if(orientation){
    const {gates_source_id,gate_page_id,...rest}=r.scope;
    scope={...rest,kind:'META_ORIENTATION/1.0',journal_root_id:id(62),protected_source_ids:[id(80),id(81),id(82),id(83)]};
    r.pages.set(id(62),{object:'page',id:id(62),archived:false,in_trash:false,last_edited_time:'2026-10-16T13:00:00Z',parent:{type:'page_id',page_id:id(1)},properties:{title:{type:'title',title:rich('META — Journal des orientations').rich_text}}});
    for(const source of [2,3,4,5])r.sourceRoots.set(id(source),id(62));
    bodies.set(id(62),JSON.stringify({kind:'META_ORIENTATION_JOURNAL/1',contract:'META_ORIENTATION/1.0',meta_root_id:id(1),meta_runtime_id:'META1',sources:{runs:id(2),ledger:id(3),decisions:id(4),definitions:id(5)}}));
    intent.gate_before={};
    const pkg=JSON.parse(intent.package_text);pkg.contract=scope.kind;intent.package_text=JSON.stringify(pkg);
    const retrievePage=r.reader.retrievePage,retrieveDataSource=r.reader.retrieveDataSource,query=r.reader.queryDataSource;
    r.reader.retrievePage=async(ref:string)=>{assert.notEqual(ref,gate_page_id,'orientation must not read or alter global G11');return retrievePage(ref);};
    r.reader.retrieveDataSource=async(ref:string)=>{assert.notEqual(ref,gates_source_id,'orientation must not require global G11 schema');return retrieveDataSource(ref);};
    r.reader.queryDataSource=async(ref:string,...args:any[])=>{assert.notEqual(ref,gates_source_id,'orientation must not query global G11');return query(ref,...args);};
  }
  const next=async()=>typeof(publication as any)[orientation?'nextMetaOrientationPublication':'nextRealDirectionPublication']==='function'?(publication as any)[orientation?'nextMetaOrientationPublication':'nextRealDirectionPublication'](r.reader,scope,intent,()=>new Date('2026-10-16T14:02:00Z')):{status:'NOT_IMPLEMENTED'};
  const applyResponse=(p:any)=>{assert.ok(p.writes.length>=1&&p.writes.length<=2);let last='';for(const w of p.writes)last=apply(w);return last;};
  const finish=async()=>{for(let n=0;n<30;n++){const result=await next();if(result.status===(orientation?'ORIENTATION_NATIVE_VERIFIED':'NATIVE_RECORDS_VERIFIED_PENDING_CONTROL'))return result;assert.equal(result.status,'APPROVED_PENDING_NOTION',JSON.stringify(result));applyResponse(result);}assert.fail('bounded native journalization must terminate without claiming control confirmation');};
  return {...r,scope,intent,next,apply,applyResponse,finish,effects,bodies,field};
}
test('dedicated orientation verifies four native mutations without touching global G11 or local rules/history',async()=>{
  const r=fresh(true),gate=structuredClone(r.pages.get(id(61))),manifest=structuredClone(r.pages.get(id(7)));
  const done=await r.finish();assert.equal(done.contract,'META_ORIENTATION/1.0');assert.equal(done.control_confirmed,false);assert.equal(done.business_result_verified,false);assert.equal(done.recipient_consumption_verified,false);
  assert.deepEqual(r.pages.get(id(61)),gate);assert.equal([...r.pages.values()].filter(p=>p.parent.data_source_id===id(3)).length,4);
  for(const [k,v]of Object.entries(manifest.properties))if(k!=='Objective Package URL')assert.deepEqual(r.pages.get(id(7)).properties[k],v);
  for(const w of r.effects.filter(w=>w.page_id===id(7)))assert.deepEqual(Object.keys(w.properties),['Objective Package URL']);
  const run=[...r.pages.values()].find(p=>p.parent.data_source_id===id(2));assert.equal(JSON.parse(r.field(run,'Input Refs')).contract,'META_ORIENTATION/1.0');
  assert.equal(r.field(run,'Gate After Observed'),undefined,'no fake G11 status stored on the dedicated run');
  assert.equal((await r.next()).status,'ORIENTATION_NATIVE_VERIFIED');
});
test('dedicated orientation does not depend on the existence of the global gate source',async()=>{
  const r=fresh(true);r.pages.delete(id(61));r.schemas.delete(id(60));assert.equal((await r.finish()).status,'ORIENTATION_NATIVE_VERIFIED');
});
test('dedicated orientation refuses a legacy/global package without its explicit contract',async()=>{
  const r=fresh(true),p=JSON.parse(r.intent.package_text);delete p.contract;r.intent.package_text=JSON.stringify(p);
  const result=await r.next();assert.equal(result.status,'UNCONFIRMED');assert.equal(result.writes,undefined);assert.equal(r.effects.length,0);
});
test('dedicated orientation refuses a concurrent personal pointer and never overwrites it',async()=>{
  const r=fresh(true);r.applyResponse(await r.next());r.pages.get(id(7)).properties['Objective Package URL']=prop(url(999),'url');
  const result=await r.next();assert.equal(result.status,'UNCONFIRMED');assert.equal(result.writes,undefined);assert.equal(r.field(r.pages.get(id(7)),'Objective Package URL'),url(999));
});
test('dedicated orientation reconstructs every native interruption without duplicate or rewritten successful phase IDs',async()=>{
  const phases=['OPEN_RUN',...['DEFINITION','PACKAGE','DECISION','CURRENT'].flatMap(role=>['PREPARE_','WRITE_','WRITTEN_','VERIFIED_'].map(p=>p+role)),'CLOSE_RUN'];
  for(let cut=0;cut<phases.length;cut++)for(const mode of ['none','admission_only','all']){
    const r=fresh(true);for(let n=0;n<cut;n++)r.applyResponse(await r.next());
    const before=await r.next();assert.equal(before.phase,phases[cut]);if(mode==='all'||mode==='admission_only'&&before.writes.length===1)r.applyResponse(before);else if(mode==='admission_only')r.apply(before.writes[0]);
    const earlier=[...r.pages.values()].filter(p=>p.parent.data_source_id===id(3)).map(p=>({id:p.id,attempts:Object.fromEntries(['Prepared Execution Attempt ID','Written Execution Attempt ID','Verified Execution Attempt ID'].flatMap(k=>r.field(p,k)?[[k,r.field(p,k)]]:[]))}));
    assert.equal((await r.finish()).status,'ORIENTATION_NATIVE_VERIFIED',phases[cut]+'/'+mode);
    for(const p of earlier)for(const [k,v]of Object.entries(p.attempts))assert.equal(r.field(r.pages.get(p.id),k),v);
    assert.equal([...r.pages.values()].filter(p=>p.parent.data_source_id===id(5)).length,1);assert.equal([...r.pages.values()].filter(p=>p.parent.data_source_id===id(3)).length,4);
  }
});
test('dedicated orientation rejects corrupted Ledger relations even on an HTTP-successful completed run',async()=>{
  const r=fresh(true);await r.finish();const row=[...r.pages.values()].find(p=>p.parent.data_source_id===id(3));row.properties['Run Ref']=rich(url(999));
  const p=await r.next();assert.equal(p.status,'UNCONFIRMED');assert.equal(p.writes,undefined);
});
test('isolated orientation refuses a shared source before its first native write',async()=>{
  const r=fresh(true);r.sourceRoots.set(id(2),id(1));
  const p=await r.next();assert.equal(p.status,'UNCONFIRMED');assert.equal(p.writes,undefined);assert.equal(r.effects.length,0);
});
test('isolated orientation requires an explicit private journal binding instead of falling back to the META root',async()=>{
  const r=fresh(true);delete r.scope.journal_root_id;
  const p=await r.next();assert.equal(p.status,'UNCONFIRMED');assert.equal(p.writes,undefined);
});
test('isolated orientation refuses a protected global source even after it was incorrectly reparented',async()=>{
  const r=fresh(true);r.scope.protected_source_ids.push(id(2));
  const p=await r.next();assert.equal(p.status,'UNCONFIRMED');assert.equal(p.writes,undefined);
});
test('isolated orientation refuses foreign, tampered, ambiguous or partial journal markers',async(t)=>{
  for(const kind of ['foreign','tampered','ambiguous','partial'])await t.test(kind,async()=>{
    const r=fresh(true),get=r.reader.retrieveBlockChildren;
    if(kind==='foreign')r.pages.get(id(62)).parent.page_id=id(999);
    if(kind==='tampered')r.bodies.set(id(62),'{"kind":"META_ORIENTATION_JOURNAL/1"}');
    r.reader.retrieveBlockChildren=async(ref:string,...args:any[])=>{const q=await get(ref,...args);if(ref===id(62)){if(kind==='ambiguous')q.results.push({...structuredClone(q.results[0]),id:id(701)});if(kind==='partial'){q.has_more=true;q.next_cursor='more';}}return q;};
    const p=await r.next();assert.equal(p.status,'UNCONFIRMED');assert.equal(p.writes,undefined);
  });
});
test('native publication opens its Run before returning a definition write and never performs writes itself',async()=>{
  const r=fresh(),before=JSON.stringify([...r.pages]),p=await r.next();assert.equal(p.status,'APPROVED_PENDING_NOTION');assert.equal(p.writes.length,1);assert.equal(p.writes[0].data_source_id,id(2));assert.equal(p.writes[0].properties.Status,'RUNNING');assert.equal(p.writes[0].properties['Observed Facts'],r.intent.sealed_intent);assert.equal(JSON.stringify([...r.pages]),before);
});
test('native planner refuses publication Ledger rows without a Run instead of adopting them',async()=>{
  const r=fresh(),extra=fixture().pages.get(id(20));r.pages.set(extra.id,structuredClone(extra));
  const before=JSON.stringify([...r.pages]),result=await r.next();assert.equal(result.status,'UNCONFIRMED');assert.equal(result.reason,'ORPHAN_NATIVE_TARGET');assert.equal(result.writes,undefined);assert.equal(JSON.stringify([...r.pages]),before);
});
test('native planner refuses an unknown mutation before returning another admitted write',async()=>{
  const r=fresh(),first=await r.next();r.applyResponse(first);
  const extra=structuredClone(fixture().pages.get(id(20)));extra.id=id(81);extra.properties['Run Ref']=rich('https://app.notion.com/p/'+[...r.pages.values()].find(p=>p.parent.data_source_id===id(2)).id);extra.properties['Idempotency Key']=rich('DIRECTION:'+id(90)+':UNEXPECTED');r.pages.set(extra.id,extra);
  const count=r.effects.length,result=await r.next();assert.equal(result.status,'UNCONFIRMED');assert.equal(result.reason,'UNEXPECTED_NATIVE_MUTATION');assert.equal(result.writes,undefined);assert.equal(r.effects.length,count);
});
test('native planner refuses a future phase journal row before reconstructing missing earlier phases',async()=>{
  const r=fresh(),first=await r.next();r.applyResponse(first);
  const extra=structuredClone(fixture().pages.get(id(21)));extra.properties['Run Ref']=rich('https://app.notion.com/p/'+[...r.pages.values()].find(p=>p.parent.data_source_id===id(2)).id);r.pages.set(extra.id,extra);
  const result=await r.next();assert.equal(result.status,'UNCONFIRMED');assert.equal(result.reason,'UNEXPECTED_NATIVE_MUTATION');assert.equal(result.writes,undefined);
});
test('native publication reaches governed proof through real returned writes while preserving local rules',async()=>{
  const r=fresh(),done=await r.finish();assert.equal(done.business_result_verified,false);assert.equal(done.recipient_consumption_verified,false);
  const manifest=r.pages.get(id(7));assert.equal(r.field(manifest,'Local Method'),'Email first; keep individual approvals');assert.equal(r.field(manifest,'Objective Package URL'),url(Number.parseInt(done.package_id,16)));
  const ledger=[...r.pages.values()].filter(p=>p.parent.data_source_id===id(3));assert.equal(ledger.length,5);assert.ok(ledger.every(p=>r.field(p,'Status')==='VERIFIED'));
  const pointer=r.effects.findIndex(w=>w.page_id===id(7)),verifiedBefore=r.effects.slice(0,pointer).filter(w=>w.properties?.Status==='VERIFIED');assert.equal(verifiedBefore.length,3,'CURRENT only after all upstream proofs');
  const created=r.effects.filter(w=>w.operation==='CREATE_CHILD_IF_ABSENT');assert.equal(created.length,1);assert.equal(created[0].parent_page_id,id(6));assert.ok(!created[0].content.includes('sealed exact approved proposal'),'never leak private META journal to recipient package');
  assert.equal(r.effects.at(-1).properties.Status,'COMPLETED');const count=r.effects.length;assert.equal((await r.next()).status,'NATIVE_RECORDS_VERIFIED_PENDING_CONTROL');assert.equal(r.effects.length,count,'successful replay returns no writes');
});
test('native publication resumes a successful target write without duplicating it after interruption',async()=>{
  const r=fresh();for(let i=0;i<3;i++){const p=await r.next();assert.equal(p.status,'APPROVED_PENDING_NOTION');r.applyResponse(p);}
  const definition=[...r.pages.values()].find(p=>p.parent.data_source_id===id(5));assert.ok(definition);
  const resume=await r.next();assert.equal(resume.status,'APPROVED_PENDING_NOTION');assert.equal(resume.writes.at(-1).operation,'UPDATE_IF_MATCH');assert.equal(resume.writes.at(-1).properties.Status,'WRITTEN');
  r.applyResponse(resume);await r.finish();assert.equal([...r.pages.values()].filter(p=>p.parent.data_source_id===id(5)).length,1);assert.equal(definition.id,[...r.pages.values()].find(p=>p.parent.data_source_id===id(5)).id);
});
test('native publication refuses a changed CURRENT without overwriting an existing package',async()=>{
  const r=fresh();r.pages.get(id(7)).properties['Objective Package URL']=prop(url(999),'url');const before=JSON.stringify([...r.pages]),p=await r.next();assert.equal(p.status,'UNCONFIRMED');assert.equal(p.writes,undefined);assert.equal(JSON.stringify([...r.pages]),before);
});
test('native publication does not repair a ledger with a wrong Run Ref or an orphan target',async()=>{
  const r=fresh();for(let i=0;i<2;i++){const p=await r.next();assert.equal(p.status,'APPROVED_PENDING_NOTION');r.applyResponse(p);}
  const ledger=[...r.pages.values()].find(p=>p.parent.data_source_id===id(3));ledger.properties['Run Ref']=rich(url(999));const p=await r.next();assert.equal(p.status,'UNCONFIRMED');assert.equal(p.writes,undefined);
  const orphan=fresh();orphan.pages.set(id(400),{object:'page',id:id(400),archived:false,in_trash:false,last_edited_time:'2026-10-16T14:00:00Z',parent:{type:'data_source_id',data_source_id:id(5)},properties:Object.fromEntries(Object.entries(orphan.intent.definition_properties).map(([k,v])=>[k,k==='Status'||k==='Definition Type'?prop(v,'select'):k==='Definition'?{type:'title',title:rich(v).rich_text}:rich(v)]))});
  assert.equal((await orphan.next()).status,'UNCONFIRMED');
});
test('native publication rejects partial reads without creating a replacement Run',async()=>{
  const r=fresh(),query=r.reader.queryDataSource;r.reader.queryDataSource=async(...args:any[])=>({...await query(...args),has_more:true,next_cursor:'more'});const p=await r.next();assert.equal(p.status,'UNCONFIRMED');assert.equal(p.writes,undefined);
});
test('native publication keeps the prior CURRENT while incomplete and retains its historical page',async()=>{
  const r=fresh();r.intent.previous_pointer=url(900);r.pages.get(id(7)).properties['Objective Package URL']=prop(url(900),'url');
  const old={object:'page',id:id(900),archived:false,in_trash:false,last_edited_time:'2026-10-15T14:00:00Z',parent:{type:'page_id',page_id:id(6)},properties:{title:{type:'title',title:rich('Version précédente').rich_text}}};r.pages.set(id(900),structuredClone(old));
  for(let n=0;n<8;n++){const p=await r.next();assert.equal(p.status,'APPROVED_PENDING_NOTION');r.applyResponse(p);assert.equal(r.field(r.pages.get(id(7)),'Objective Package URL'),url(900));}
  const result=await r.finish();assert.equal(result.status,'NATIVE_RECORDS_VERIFIED_PENDING_CONTROL');assert.deepEqual(r.pages.get(id(900)),old);
});
test('native publication refuses duplicate native child pages rather than selecting or recreating one',async()=>{
  const r=fresh();for(let n=0;n<20;n++){const p=await r.next();assert.equal(p.status,'APPROVED_PENDING_NOTION');const w=p.writes.at(-1),target=r.applyResponse(p);if(w.operation==='CREATE_CHILD_IF_ABSENT'){r.pages.set(id(901),{...structuredClone(r.pages.get(target)),id:id(901)});break;}}
  const p=await r.next();assert.equal(p.status,'UNCONFIRMED');assert.equal(p.reason,'AMBIGUOUS_NATIVE_PROOF');assert.equal(p.writes,undefined);
});
test('native publication refuses an early CURRENT without retroactively repairing upstream proof',async()=>{
  const r=fresh();for(let n=0;n<20;n++){const p=await r.next();assert.equal(p.status,'APPROVED_PENDING_NOTION');const w=p.writes.at(-1),target=r.applyResponse(p);if(w.operation==='CREATE_CHILD_IF_ABSENT'){r.pages.get(id(7)).properties['Objective Package URL']=prop(url(Number.parseInt(target,16)),'url');break;}}
  const p=await r.next();assert.equal(p.status,'UNCONFIRMED');assert.equal(p.reason,'CURRENT_NOT_LAST');assert.equal(p.writes,undefined);
});
test('native publication does not bless a changed sealed owner intent or reopen a completed Run',async()=>{
  const r=fresh();await r.finish();r.intent.sealed_intent='different approved-looking intent';const p=await r.next();assert.equal(p.status,'UNCONFIRMED');assert.equal(p.writes,undefined);
});
test('native publication keeps a separate COMMIT Run from poisoning its PUBLISH lookup',async()=>{
  const r=fresh(),first=await r.next();assert.equal(first.status,'APPROVED_PENDING_NOTION');r.apply(first.writes[0]);
  const committed={...structuredClone([...r.pages.values()].find(p=>p.parent.data_source_id===id(2))),id:id(902)};committed.properties['Run Type']=prop('COMMIT','select');r.pages.set(id(902),committed);
  const next=await r.next();assert.equal(next.status,'APPROVED_PENDING_NOTION');assert.equal(next.phase,'PREPARE_DEFINITION');assert.equal(r.field(r.pages.get(id(902)),'Run Type'),'COMMIT');
});
test('native publication pins the intended recipient contract without inventing new schema fields',async()=>{
  const r=fresh(),first=await r.next();assert.equal(first.status,'APPROVED_PENDING_NOTION');
  assert.equal(typeof first.writes[0].properties['Input Refs'],'string');const pins=JSON.parse(first.writes[0].properties['Input Refs']).pins;
  assert.equal(pins.sales_contract_version,'TEST_SALES_CONTRACT/0.5.0');assert.equal(pins.recipient_schema_version,'TEST_SALES_SCHEMA/0.5.0');
  for(const name of ['strategy','toolkit','authority']){assert.equal(pins[name].state,'NOT_APPLICABLE');assert.ok(pins[name].reason.length>20);}
});
test('native publication increments a durable attempt before its phase and resumes after only the admission write',async()=>{
  const r=fresh();r.applyResponse(await r.next());const run=[...r.pages.values()].find(p=>p.parent.data_source_id===id(2)),opened=r.field(run,'Opened Execution Attempt ID');
  const first=await r.next();assert.equal(first.writes.length,2,'admission before the targeted native write');
  assert.equal(first.writes[0].page_id,run.id);assert.equal(first.writes[0].properties['Attempt Count'],2);r.apply(first.writes[0]);
  const next=await r.next();assert.equal(next.writes[0].properties['Attempt Count'],3);assert.notEqual(next.writes[0].properties['Last Execution Attempt ID'],first.writes[0].properties['Last Execution Attempt ID']);r.applyResponse(next);
  const ledger=[...r.pages.values()].find(p=>p.parent.data_source_id===id(3)),prepared=r.field(ledger,'Prepared Execution Attempt ID');assert.equal(prepared,next.writes[0].properties['Last Execution Attempt ID']);
  await r.finish();assert.equal(r.field(run,'Opened Execution Attempt ID'),opened);assert.equal(r.field(ledger,'Prepared Execution Attempt ID'),prepared);assert.notEqual(r.field(ledger,'Written Execution Attempt ID'),prepared);assert.notEqual(r.field(ledger,'Verified Execution Attempt ID'),r.field(ledger,'Written Execution Attempt ID'));
});
test('native publication attributes a successful target to its WRITE attempt, not the later recovery call',async()=>{
  const r=fresh();for(let i=0;i<3;i++)r.applyResponse(await r.next());const run=[...r.pages.values()].find(p=>p.parent.data_source_id===id(2)),writeAttempt=r.field(run,'Last Execution Attempt ID'),target=[...r.pages.values()].find(p=>p.parent.data_source_id===id(5));
  const recovered=await r.next();assert.equal(recovered.writes.at(-1).properties['Written Execution Attempt ID'],writeAttempt);assert.ok(recovered.writes.at(-1).before['Prepared Execution Attempt ID'],'protect previous phase identity');
  assert.notEqual(recovered.writes[0].properties['Last Execution Attempt ID'],writeAttempt);r.applyResponse(recovered);await r.finish();assert.equal([...r.pages.values()].find(p=>p.parent.data_source_id===id(5)).id,target.id);
});
test('native publication refuses to invent a writer after the native write admission was skipped',async()=>{
  const r=fresh();r.applyResponse(await r.next());r.applyResponse(await r.next());const write=await r.next();r.apply(write.writes.at(-1));
  const p=await r.next();assert.equal(p.status,'UNCONFIRMED');assert.equal(p.reason,'NATIVE_WRITE_ATTEMPT_UNCONFIRMED');assert.equal(p.writes,undefined);
});
test('native publication survives every native interruption boundary without rewriting earlier phase IDs',async()=>{
  const phases=['OPEN_RUN',...['DEFINITION','PACKAGE','DECISION','CURRENT','GATE'].flatMap(role=>['PREPARE_','WRITE_','WRITTEN_','VERIFIED_'].map(p=>p+role)),'CLOSE_RUN'];
  for(let cut=0;cut<phases.length;cut++)for(const mode of ['none','admission_only','all']){
    const r=fresh();for(let i=0;i<cut;i++){const p=await r.next();assert.equal(p.phase,phases[i]);r.applyResponse(p);}
    const phase=await r.next();assert.equal(phase.phase,phases[cut]);
    if(mode==='all'||mode==='admission_only'&&phase.writes.length===1)r.applyResponse(phase);else if(mode==='admission_only')r.apply(phase.writes[0]);
    const earlier=[...r.pages.values()].filter(p=>p.parent.data_source_id===id(3)).map(p=>({id:p.id,fields:Object.fromEntries(['Prepared Execution Attempt ID','Written Execution Attempt ID','Verified Execution Attempt ID'].flatMap(k=>r.field(p,k)?[[k,r.field(p,k)]]:[]))}));
    let result:any;try{result=await r.finish();}catch(e){assert.fail(phases[cut]+' / '+mode+': '+String(e));}
    assert.equal(result.status,'NATIVE_RECORDS_VERIFIED_PENDING_CONTROL');
    for(const previous of earlier)for(const [key,expected]of Object.entries(previous.fields))assert.equal(r.field(r.pages.get(previous.id),key),expected,phases[cut]+' must preserve '+key);
    assert.equal([...r.pages.values()].filter(p=>p.parent.data_source_id===id(5)).length,1);assert.equal([...r.pages.values()].filter(p=>p.parent.data_source_id===id(3)).length,5);
  }
});
test('native publication refuses to discard unknown native admission history',async()=>{
  const r=fresh();r.applyResponse(await r.next());const run=[...r.pages.values()].find(p=>p.parent.data_source_id===id(2)),log=JSON.parse(r.field(run,'Actions'));log.attempts[0].prior_note='must not disappear';run.properties.Actions=rich(JSON.stringify(log));
  const p=await r.next();assert.equal(p.status,'UNCONFIRMED');assert.equal(p.writes,undefined);assert.ok(r.field(run,'Actions').includes('must not disappear'));
});
test('native publication refuses an absent G11 before opening its Run',async()=>{
  const r=fresh();r.pages.delete(id(61));const p=await r.next();assert.equal(p.status,'UNCONFIRMED');assert.equal(p.writes,undefined);
});
test('native publication records only a provisional G11 transition after CURRENT proof',async()=>{
  const r=fresh(),done=await r.finish(),run=[...r.pages.values()].find(p=>p.parent.data_source_id===id(2));
  assert.equal(done.status,'NATIVE_RECORDS_VERIFIED_PENDING_CONTROL');assert.equal(r.field(r.pages.get(id(61)),'Status'),'PROVISIONAL_PASS');assert.equal(r.field(r.pages.get(id(61)),'Control Confirmation State'),'PENDING');assert.equal(r.field(run,'Gate After Observed'),'PROVISIONAL_PASS');
  assert.equal(JSON.parse(r.field(run,'Gate Before')).Status,'OPEN');assert.equal(r.field(run,'Mutation Count'),5);
  const gateWrite=r.effects.findIndex(w=>w.page_id===id(61)),proofBefore=r.effects.slice(0,gateWrite).filter(w=>w.properties?.Status==='VERIFIED');assert.equal(proofBefore.length,4);
});
test('native publication refuses a concurrent G11 change rather than resetting its history',async()=>{
  const r=fresh();r.applyResponse(await r.next());r.pages.get(id(61)).properties.Status=prop('PASS','select');r.pages.get(id(61)).properties['Evidence Refs']=rich('later publication');const p=await r.next();assert.equal(p.status,'UNCONFIRMED');assert.equal(p.writes,undefined);assert.equal(r.field(r.pages.get(id(61)),'Evidence Refs'),'later publication');
});
test('native publication retains a prior G11 baseline with native page mentions without rewriting its history',async()=>{
  const r=fresh(),gate=r.pages.get(id(61));Object.assign(r.intent.gate_before,{Status:'PASS','Control Confirmation State':'CONFIRMED','Passed By Run Ref':url(997),'Confirmed By Control Check Ref':url(998),'Evidence Refs':'previous publication proof'});
  gate.properties.Status=prop('PASS','select');gate.properties['Control Confirmation State']=prop('CONFIRMED','select');gate.properties['Evidence Refs']=rich('previous publication proof');gate.properties['Local Notes']=rich('retain this gate annotation');
  for(const [name,n]of [['Passed By Run Ref',997],['Confirmed By Control Check Ref',998]] as const)gate.properties[name]={type:'rich_text',rich_text:[{type:'mention',plain_text:'Previous native proof '+n,mention:{type:'page',page:{id:id(n)}}}]};
  assert.equal((await r.finish()).status,'NATIVE_RECORDS_VERIFIED_PENDING_CONTROL');const run=[...r.pages.values()].find(p=>p.parent.data_source_id===id(2));
  assert.deepEqual(JSON.parse(r.field(run,'Gate Before')),r.intent.gate_before);assert.equal(r.field(gate,'Local Notes'),'retain this gate annotation');
});
test('native publication preflights the complete later transaction schema before opening a Run',async(t)=>{
  // Missing late fields or select options must refuse the first write, not leave
  // a half-open native transaction or silently create options through the API.
  for(const change of [
    (r:ReturnType<typeof fresh>)=>{delete r.schemas.get(id(3))!.properties['Verified Execution Attempt ID'];},
    (r:ReturnType<typeof fresh>)=>{r.schemas.get(id(8))!.properties['Objective Package URL'].type='rich_text';},
    (r:ReturnType<typeof fresh>)=>{r.schemas.get(id(3))!.properties.Operation.select.options=r.schemas.get(id(3))!.properties.Operation.select.options.filter((o:any)=>o.name!=='PUBLISH_POINTER');},
    (r:ReturnType<typeof fresh>)=>{r.schemas.get(id(4))!.properties.Status.select.options=[];},
    (r:ReturnType<typeof fresh>)=>{delete r.schemas.get(id(5))!.properties.Content;},
    (r:ReturnType<typeof fresh>)=>{r.schemas.get(id(60))!.properties.Status.select.options=r.schemas.get(id(60))!.properties.Status.select.options.filter((o:any)=>o.name!=='PROVISIONAL_PASS');},
    (r:ReturnType<typeof fresh>)=>{r.schemas.get(id(2))!.properties.Actions.read_only=true;},
  ].entries()){await t.test('schema variant '+change[0],async()=>{const r=fresh();change[1](r);const before=JSON.stringify([...r.pages]),result=await r.next();assert.equal(result.status,'UNCONFIRMED');assert.equal(result.reason,'NATIVE_SCHEMA_MISMATCH');assert.equal(result.writes,undefined);assert.equal(JSON.stringify([...r.pages]),before);});}
});
test('native publication rechecks a changed schema after interruption without advancing the attempt',async()=>{
  const r=fresh();r.applyResponse(await r.next());delete r.schemas.get(id(3))!.properties['Compared Fields'];const before=JSON.stringify([...r.pages]),result=await r.next();assert.equal(result.status,'UNCONFIRMED');assert.equal(result.reason,'NATIVE_SCHEMA_MISMATCH');assert.equal(result.writes,undefined);assert.equal(JSON.stringify([...r.pages]),before);
});
test('native publication refuses an undeclared definition property before any native admission',async()=>{
  const r=fresh();r.intent.definition_properties['Unconfigured New Field']='not an automatic schema migration';const result=await r.next();assert.equal(result.status,'UNCONFIRMED');assert.equal(result.writes,undefined);assert.equal(r.effects.length,0);
});
