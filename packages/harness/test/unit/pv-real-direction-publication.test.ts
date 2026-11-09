import { test } from 'node:test';
import assert from 'node:assert/strict';
import { id,url,digest,rich,prop,fixture } from './real-direction-publication-fixtures.ts';
async function verify(r:ReturnType<typeof fixture>){
  const mod=await import(new URL('../../src/verify/realDirectionPublication.ts',import.meta.url).href).catch((e:any)=>{if(e.code==='ERR_MODULE_NOT_FOUND')return null;throw e;});
  return mod?mod.verifyRealDirectionPublication(r.reader,r.scope,r.expected):{status:'NOT_IMPLEMENTED'};
}
test('native direction publication requires the complete native chain, not a signed definition alone',async()=>{
  const r=fixture();for(const n of [9,12,20,21,22,23])r.pages.delete(id(n));
  const result=await verify(r);assert.equal(result.status,'UNCONFIRMED');assert.equal(result.writes,undefined);
});
test('native direction publication independently verifies targets, references and CURRENT last',async()=>{
  const r=fixture(),result=await verify(r);assert.equal(result.status,'NATIVE_RECORDS_VERIFIED_PENDING_CONTROL');assert.equal(result.package_id,id(11));assert.equal(result.atomic,false);assert.equal(result.business_result_verified,false);assert.equal(result.writes,undefined);
  assert.ok(r.reads.filter(x=>x[0]==='children').length>=2,'independent full readback, not one cached target');
});
test('native direction publication does not accept a wrong Run Ref under HTTP success',async()=>{
  const r=fixture();r.pages.get(id(21)).properties['Run Ref']=rich(url(99));
  assert.equal((await verify(r)).status,'UNCONFIRMED');
});
test('native direction publication refuses a pointer before upstream verification',async()=>{
  const r=fixture();r.pages.get(id(23)).properties['Written At']=prop('2026-10-16T13:58:00Z','date');
  assert.equal((await verify(r)).status,'UNCONFIRMED');
});
test('native direction publication respects native minute precision rather than demanding a replay',async()=>{
  const r=fixture();r.pages.get(id(23)).properties['Written At']=prop('2026-10-16T14:01:00.000Z','date');r.pages.get(id(23)).properties['Verified At']=prop('2026-10-16T14:01:00.000Z','date');
  assert.equal((await verify(r)).status,'NATIVE_RECORDS_VERIFIED_PENDING_CONTROL');
});
test('native direction publication refuses a duplicate ledger key or incomplete query',async()=>{
  const r=fixture();r.pages.set(id(80),{...structuredClone(r.pages.get(id(21))),id:id(80)});
  assert.equal((await verify(r)).status,'UNCONFIRMED');
  const r2=fixture(),query=r2.reader.queryDataSource;r2.reader.queryDataSource=async(...args:any[])=>({...await query(...args),has_more:true,next_cursor:'unread'});
  assert.equal((await verify(r2)).status,'UNCONFIRMED');
});
test('native direction publication rejects private or foreign packages, incompatible pins, and a changed pointer',async()=>{
  for(const change of [
    (r:ReturnType<typeof fixture>)=>{r.pages.get(id(11)).parent={type:'page_id',page_id:id(1)};},
    (r:ReturnType<typeof fixture>)=>{r.pages.get(id(7)).properties['Sales Contract Version']=rich('TEST_SALES_CONTRACT/0.6.0');},
    (r:ReturnType<typeof fixture>)=>{r.pages.get(id(7)).properties['Objective Package URL']=prop(url(99),'url');},
    (r:ReturnType<typeof fixture>)=>{r.sourceRoots.set(id(3),id(6));},
  ]){const r=fixture();change(r);assert.equal((await verify(r)).status,'UNCONFIRMED');}
});
test('native direction publication rejects changed package content and a ledger digest that disagrees with readback',async()=>{
  const r=fixture();r.children.results[0]!.code.rich_text[0]!.plain_text+=' altered';assert.equal((await verify(r)).status,'UNCONFIRMED');
  const r2=fixture();r2.pages.get(id(21)).properties['After Expected Hash']=rich('a'.repeat(64));assert.equal((await verify(r2)).status,'UNCONFIRMED');
});
test('native direction publication catches an edit during its bounded two-pass read',async()=>{
  const r=fixture(),read=r.reader.retrievePage;let count=0;r.reader.retrievePage=async(ref:string)=>{const p=await read(ref);if(ref===id(7)&&++count>1)p.last_edited_time='2026-10-16T14:03:00Z';return p;};
  assert.equal((await verify(r)).status,'UNCONFIRMED');
});
test('native direction publication accepts the same native page mention without a representation rewrite',async()=>{
  const r=fixture();r.pages.get(id(10)).properties['Decision Ref']={type:'rich_text',rich_text:[{type:'mention',plain_text:'Décision approuvée',mention:{type:'page',page:{id:id(12)}}}]};
  r.pages.get(id(12)).properties['Affected Objects']={type:'rich_text',rich_text:[{type:'mention',plain_text:'Orientation individuelle',mention:{type:'page',page:{id:id(11)}}}]};
  assert.equal((await verify(r)).status,'NATIVE_RECORDS_VERIFIED_PENDING_CONTROL');
});
test('native direction publication rejects HTTP success with contradictory observed mutation proof',async()=>{
  const r=fixture();r.pages.get(id(21)).properties['After Observed Summary']=rich('VERIFIED unrelated target');
  assert.equal((await verify(r)).status,'UNCONFIRMED');
});
test('native direction publication resolves the pre-existing owner attestation key through the native decision without a creation cycle',async()=>{
  const r=fixture();r.expected.definition_properties['Decision Ref']='OWNER_SESSION:'+id(90);
  const resolution=JSON.parse(r.expected.decision_properties.Resolution!);resolution.owner_session_ref='OWNER_SESSION:'+id(90);r.expected.decision_properties.Resolution=JSON.stringify(resolution);
  r.pages.get(id(10)).properties['Decision Ref']=rich(r.expected.definition_properties['Decision Ref']);
  r.pages.get(id(12)).properties.Resolution=rich(r.expected.decision_properties.Resolution);
  for(const [i,target]of [r.expected.definition_properties,r.expected.decision_properties].entries()){
    const index=i===0?0:2,m=r.expected.mutations[index]!;m.after_hash=digest(target);
    r.pages.get(m.id).properties['After Expected Hash']=rich(m.after_hash);r.pages.get(m.id).properties['After Observed Summary']=rich(JSON.stringify({target_id:m.target_id,hash:m.after_hash}));
  }
  assert.equal((await verify(r)).status,'NATIVE_RECORDS_VERIFIED_PENDING_CONTROL');
});
test('native direction publication accepts actual native title and definition select properties',async()=>{
  const r=fixture();r.expected.definition_properties.Definition='Orientation personnelle';r.expected.definition_properties['Definition Type']='TOOLKIT_ITEM';r.expected.decision_properties.Decision='Publication de cette orientation';
  r.pages.get(id(10)).properties.Definition={type:'title',title:rich('Orientation personnelle').rich_text};r.pages.get(id(10)).properties['Definition Type']=prop('TOOLKIT_ITEM','select');r.pages.get(id(12)).properties.Decision={type:'title',title:rich('Publication de cette orientation').rich_text};
  for(const [index,properties]of [[0,r.expected.definition_properties],[2,r.expected.decision_properties]] as const){
    const m=r.expected.mutations[index]!;m.after_hash=digest(properties);
    r.pages.get(m.id).properties['After Expected Hash']=rich(m.after_hash);r.pages.get(m.id).properties['After Observed Summary']=rich(JSON.stringify({target_id:m.target_id,hash:m.after_hash}));r.pages.get(m.id).properties['Compared Fields']=rich(JSON.stringify(Object.keys(properties)));
  }
  assert.equal((await verify(r)).status,'NATIVE_RECORDS_VERIFIED_PENDING_CONTROL');
});
test('native chain readback cannot claim G11 publication while independent control is pending or only self-labelled',async()=>{
  for(const label of ['PENDING','CONFIRMED']){const r=fixture();r.pages.get(id(9)).properties['Control Confirmation State']=prop(label,'select');const result=await verify(r);assert.equal(result.status,'NATIVE_RECORDS_VERIFIED_PENDING_CONTROL');assert.equal(result.control_confirmation_required,true);assert.equal(result.recipient_consumption_verified,false);}
});
test('native chain refuses a publication Run without its recipient version pins',async()=>{
  const r=fixture();delete r.pages.get(id(9)).properties['Input Refs'];assert.equal((await verify(r)).status,'UNCONFIRMED');
});
test('native chain refuses missing, future or reversed phase-attempt attribution',async()=>{
  for(const change of [
    (r:ReturnType<typeof fixture>)=>{delete r.pages.get(id(20)).properties['Prepared Execution Attempt ID'];},
    (r:ReturnType<typeof fixture>)=>{r.pages.get(id(20)).properties['Verified Execution Attempt ID']=rich(id(90)+':PUBLISH:999');},
    (r:ReturnType<typeof fixture>)=>{r.pages.get(id(20)).properties['Written Execution Attempt ID']=rich(id(90)+':PUBLISH:1');},
  ]){const r=fixture();change(r);assert.equal((await verify(r)).status,'UNCONFIRMED');}
});
test('native chain refuses an absent, foreign or unproved G11 instead of claiming publication',async()=>{
  for(const change of [
    (r:ReturnType<typeof fixture>)=>{r.pages.delete(id(61));},
    (r:ReturnType<typeof fixture>)=>{r.pages.get(id(61)).parent.data_source_id=id(8);},
    (r:ReturnType<typeof fixture>)=>{r.pages.get(id(61)).properties.Status=prop('PASS','select');},
    (r:ReturnType<typeof fixture>)=>{r.pages.get(id(61)).properties['Passed By Run Ref']=rich(url(99));},
    (r:ReturnType<typeof fixture>)=>{r.pages.get(id(24)).properties['Written At']=prop('2026-10-16T13:59:00Z','date');},
    (r:ReturnType<typeof fixture>)=>{r.pages.get(id(9)).properties['Gate After Observed']=rich('PASS');},
  ]){const r=fixture();change(r);assert.equal((await verify(r)).status,'UNCONFIRMED');}
});
test('native chain requires source schemas even when all existing row values look correct',async(t)=>{
  for(const change of [
    (r:ReturnType<typeof fixture>)=>{delete (r.schemas.get(id(2)) as any).properties;},
    (r:ReturnType<typeof fixture>)=>{r.schemas.get(id(3))!.properties['Run Ref'].type='relation';},
    (r:ReturnType<typeof fixture>)=>{r.schemas.get(id(5))!.properties.Status.select.options=[];},
    (r:ReturnType<typeof fixture>)=>{r.schemas.get(id(4))!.properties.Decision.id=r.schemas.get(id(4))!.properties.Resolution.id;},
  ].entries()){await t.test('schema variant '+change[0],async()=>{const r=fixture();change[1](r);const result=await verify(r);assert.equal(result.status,'UNCONFIRMED');assert.equal(result.reason,'NATIVE_SCHEMA_MISMATCH');assert.equal(result.writes,undefined);});}
});
test('native chain catches a required native property replaced during its independent readback',async()=>{
  const r=fixture(),get=r.reader.retrieveDataSource;let n=0;r.reader.retrieveDataSource=async(ref:string)=>{const s=await get(ref);if(ref===id(3)&&++n===2)s.properties['Run Ref'].id='replacement-property';return s;};
  const result=await verify(r);assert.equal(result.status,'UNCONFIRMED');assert.equal(result.reason,'NATIVE_CHANGED_DURING_READ');
});
test('native schema proof ignores request metadata and unused columns without weakening required options',async()=>{
  const r=fixture(),get=r.reader.retrieveDataSource;let n=0;r.reader.retrieveDataSource=async(ref:string)=>{const s=await get(ref);s.request_id='response-'+ ++n;s.properties['Unrelated Notes']={id:'notes',name:'Unrelated Notes',type:'rich_text',rich_text:{}};for(const p of Object.values(s.properties)as any[])p.select?.options.reverse();return s;};
  assert.equal((await verify(r)).status,'NATIVE_RECORDS_VERIFIED_PENDING_CONTROL');
});
test('native proof ignores Notion response request IDs while preserving actual page revisions',async()=>{
  // Two real REST reads of the same unedited page differ only by request_id.
  // Treating that HTTP correlation as canonical content makes every proof stale.
  const r=fixture(),get=r.reader.retrievePage;let n=0;r.reader.retrievePage=async(ref:string)=>({...await get(ref),request_id:'http-response-'+ ++n});
  assert.equal((await verify(r)).status,'NATIVE_RECORDS_VERIFIED_PENDING_CONTROL');
});
test('native proof refuses an additional publication mutation instead of verifying only its five known keys',async(t)=>{
  // Break caught: checking expected keys only lets orphan/failed rows disappear
  // from a supposedly complete publication proof.
  for(const status of ['PREPARED','WRITTEN','FAILED','VERIFIED'])await t.test(status,async()=>{
    const r=fixture(),extra=structuredClone(r.pages.get(id(20)));extra.id=id(81);
    extra.properties['Idempotency Key']=rich('DIRECTION:'+id(90)+':UNEXPECTED');extra.properties.Status=prop(status,'select');r.pages.set(extra.id,extra);
    const before=JSON.stringify([...r.pages]);const result=await verify(r);
    assert.equal(result.status,'UNCONFIRMED');assert.equal(result.reason,'UNEXPECTED_NATIVE_MUTATION');assert.equal(result.writes,undefined);assert.equal(JSON.stringify([...r.pages]),before);
  });
});
test('native proof includes publication-prefixed rows whose plan field was lost or altered',async()=>{
  const r=fixture(),extra=structuredClone(r.pages.get(id(20)));extra.id=id(82);
  extra.properties['Harness Plan ID']=rich(id(91));extra.properties['Idempotency Key']=rich('DIRECTION:'+id(90)+':UNEXPECTED');r.pages.set(extra.id,extra);
  const result=await verify(r);assert.equal(result.status,'UNCONFIRMED');assert.equal(result.reason,'UNEXPECTED_NATIVE_MUTATION');
});
test('native proof rejects a partial publication ledger window even when every expected key is readable',async()=>{
  const r=fixture(),query=r.reader.queryDataSource;
  r.reader.queryDataSource=async(...args:any[])=>{const q=await query(...args);return args[0]===id(3)&&args[1]?.or?{...q,has_more:true,next_cursor:'unread-ledger-row'}:q;};
  const result=await verify(r);assert.equal(result.status,'UNCONFIRMED');assert.equal(result.reason,'INCOMPLETE_NATIVE_READ');
});
test('native proof catches an added publication mutation between its independent passes',async()=>{
  const r=fixture(),query=r.reader.queryDataSource;let reads=0;
  r.reader.queryDataSource=async(...args:any[])=>{if(args[0]===id(3)&&args[1]?.or&&++reads===2){const extra=structuredClone(r.pages.get(id(20)));extra.id=id(83);extra.properties['Idempotency Key']=rich('DIRECTION:'+id(90)+':UNEXPECTED');r.pages.set(extra.id,extra);}return query(...args);};
  const result=await verify(r);assert.equal(result.status,'UNCONFIRMED');assert.equal(result.reason,'UNEXPECTED_NATIVE_MUTATION');
});
test('native proof preserves unrelated publication history outside its exact plan and key prefix',async()=>{
  const r=fixture(),old=structuredClone(r.pages.get(id(20)));old.id=id(84);old.properties['Harness Plan ID']=rich(id(91));old.properties['Idempotency Key']=rich('DIRECTION:'+id(91)+':DEFINITION');r.pages.set(old.id,old);
  assert.equal((await verify(r)).status,'NATIVE_RECORDS_VERIFIED_PENDING_CONTROL');assert.deepEqual(r.pages.get(old.id),old);
});
