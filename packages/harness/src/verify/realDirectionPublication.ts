/** Native publication proof, not a writer or a route. Expectations must be derived by the
 * admitted controller from the immutable owner-approved intent and operator-bound scope;
 * never accept them as model-supplied proof. The server journal alone proves none of this.
 */
import { createHash } from 'node:crypto';
import type { NotionReadClient } from '../notion/readClient.ts';

export interface DirectionPublicationScope {
  meta_root_id:string;meta_runtime_id:string;meta_schema_version:string;spec_version:string;control_version:string;
  runs_source_id:string;ledger_source_id:string;decisions_source_id:string;definitions_source_id:string;gates_source_id:string;gate_page_id:string;
  recipient:{root_page_id:string;runtime_id:string;manifest_page_id:string;manifest_source_id:string;schema_version:string;sales_contract_version:string};
}
/** A separate, explicitly admitted contract; never a reduced global G11 proof. */
export interface MetaOrientationScope extends Omit<DirectionPublicationScope,'gates_source_id'|'gate_page_id'> {
  kind:'META_ORIENTATION/1.0';
  journal_root_id:string;
  protected_source_ids:readonly string[];
}
type PublicationScope=DirectionPublicationScope|MetaOrientationScope;
const isOrientation=(s:PublicationScope):s is MetaOrientationScope=>'kind' in s&&s.kind==='META_ORIENTATION/1.0';
const rolesFor=(s:PublicationScope):readonly string[]=>isOrientation(s)?['DEFINITION','PACKAGE','DECISION','CURRENT']:['DEFINITION','PACKAGE','DECISION','CURRENT','GATE'];
const keyPrefix=(s:PublicationScope,plan:string)=>(isOrientation(s)?'ORIENTATION:':'DIRECTION:')+plan+':';
const scopeIds=(s:PublicationScope)=>[s.meta_root_id,s.runs_source_id,s.ledger_source_id,s.decisions_source_id,s.definitions_source_id,...(isOrientation(s)?[s.journal_root_id]:[s.gates_source_id,s.gate_page_id]),s.recipient.root_page_id,s.recipient.manifest_page_id,s.recipient.manifest_source_id];
interface MutationProof {id:string;key:string;operation:string;target_id:string;after_hash:string;before_hash:string}
export interface DirectionPublicationExpectation {
  proposal_id:string;run_id:string;definition_id:string;package_id:string;decision_id:string;package_text:string;
  definition_properties:Record<string,string>;decision_properties:Record<string,string>;previous_pointer:string;
  gate_before:Record<string,string>;gate_properties:Record<string,string>;
  mutations:MutationProof[];
}
type ObjectValue=Record<string,any>;
// Notion's per-response HTTP request ID is not a page identity, revision or proof.
// Keep every other native field; never remove it recursively from business data.
const stableRecord=(p:ObjectValue)=>{const out={...p};delete out.request_id;return out;};
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail=(reason:string):never=>{throw Error(reason);};
const object=(v:unknown):ObjectValue=>v&&typeof v==='object'&&!Array.isArray(v)?v as ObjectValue:fail('INCOMPLETE_NATIVE_READ');
const uuid=(v:unknown)=>typeof v==='string'&&/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(v)?v.replaceAll('-','').toLowerCase():fail('INVALID_NATIVE_BINDING');
const url=(id:string)=>'https://app.notion.com/p/'+id;
const reference=(v:unknown):string=>{
  if(typeof v!=='string')return fail('NATIVE_REFERENCE_MISMATCH');
  if(/^[a-f0-9-]+$/i.test(v))return uuid(v);
  try{const u=new URL(v);if(u.protocol==='https:'&&['app.notion.com','notion.so','www.notion.so'].includes(u.hostname)&&!u.username&&!u.password&&!u.search&&!u.hash)return uuid(u.pathname.match(/([a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/?$/i)?.[1]);}catch{}
  return fail('NATIVE_REFERENCE_MISMATCH');
};
function text(v:unknown):string {
  if(!Array.isArray(v)||v.length>=25)return fail('INCOMPLETE_NATIVE_READ');
  return v.map((x:unknown)=>{const r=object(x);if(typeof r.plain_text!=='string')return fail('INCOMPLETE_NATIVE_READ');return r.plain_text;}).join('');
}
function value(page:ObjectValue,name:string,type:string):any {
  const p=object(page.properties?.[name]);if(p.type!==type||p.has_more===true)return fail('NATIVE_FIELDS_MISMATCH');
  if(type==='rich_text'||type==='title')return text(p[type]);
  if(type==='select')return p.select?.name;
  if(type==='date')return p.date?.start;
  if(['number','checkbox','url'].includes(type))return p[type];
  return fail('NATIVE_FIELDS_MISMATCH');
}
function refValue(page:ObjectValue,name:string,expected:string){
  const p=object(page.properties?.[name]);
  if(p.type==='rich_text'&&p.has_more!==true&&Array.isArray(p.rich_text)&&p.rich_text.length===1){
    const r=object(p.rich_text[0]);
    if(r.type==='mention'&&r.mention?.type==='page'){if(uuid(r.mention.page?.id)!==expected)return fail('NATIVE_REFERENCE_MISMATCH');return;}
  }
  if(reference(value(page,name,p.type==='url'?'url':'rich_text'))!==expected)return fail('NATIVE_REFERENCE_MISMATCH');
}
function exact(page:ObjectValue,properties:Record<string,unknown>,types:Record<string,string>={}) {
  for(const [name,v] of Object.entries(properties)){
    if(name==='Affected Objects'||name==='Decision Ref'&&typeof v==='string'&&!v.startsWith('OWNER_SESSION:')){refValue(page,name,reference(v));continue;}
    if(value(page,name,types[name]??'rich_text')!==v)return fail('NATIVE_FIELDS_MISMATCH');
  }
}
function minute(v:unknown):number {
  if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(v)||!Number.isFinite(Date.parse(v)))return fail('NATIVE_TIMESTAMP_MISMATCH');
  return Math.floor(Date.parse(v)/60000);
}
function page(v:unknown,id:string,source?:string,root?:string):ObjectValue {
  const p=object(v);if(p.object!=='page'||uuid(p.id)!==id||p.archived!==false||p.in_trash!==false)return fail('NATIVE_SCOPE_MISMATCH');
  minute(p.last_edited_time);
  if(source&&(p.parent?.type!=='data_source_id'||uuid(p.parent.data_source_id)!==source))return fail('NATIVE_SCOPE_MISMATCH');
  if(root&&(p.parent?.type!=='page_id'||uuid(p.parent.page_id)!==root))return fail('NATIVE_SCOPE_MISMATCH');
  return p;
}
async function sourceUnder(reader:NotionReadClient,source:string,root:string){
  let p=object(await reader.retrieveDataSource(source));if(p.object!=='data_source'||uuid(p.id)!==source||p.archived===true||p.in_trash===true)return fail('NATIVE_SCOPE_MISMATCH');
  const schema=p;
  const seen=new Set([source]);
  for(let n=0;n<12;n++){
    const parent=object(p.parent),kind=parent.type,id=uuid(parent[kind]);
    if(seen.has(id))return fail('NATIVE_SCOPE_MISMATCH');seen.add(id);
    if(kind==='page_id'&&id===root)return schema;
    p=object(await(kind==='page_id'?reader.retrievePage(id):kind==='database_id'?reader.retrieveDatabase(id):Promise.reject(Error('NATIVE_SCOPE_MISMATCH'))));
    if(uuid(p.id)!==id||p.object!==(kind==='page_id'?'page':'database')||p.archived===true||p.in_trash===true)return fail('NATIVE_SCOPE_MISMATCH');
  }
  return fail('NATIVE_SCOPE_MISMATCH');
}
/** The binding is a new, physically isolated audit domain, never a relabelled
 * global source or a filtering exemption in an existing control consumer. */
async function orientationJournal(reader:NotionReadClient,s:MetaOrientationScope){
  const sources=[s.runs_source_id,s.ledger_source_id,s.decisions_source_id,s.definitions_source_id];
  if(!Array.isArray(s.protected_source_ids)||s.protected_source_ids.length<4||s.protected_source_ids.length>64||s.protected_source_ids.some(id=>uuid(id)!==id)||new Set(s.protected_source_ids).size!==s.protected_source_ids.length||sources.some(id=>s.protected_source_ids.includes(id)))return fail('NATIVE_SCOPE_MISMATCH');
  const root=page(await reader.retrievePage(s.journal_root_id),s.journal_root_id,undefined,s.meta_root_id);
  const children=object(await reader.retrieveBlockChildren(s.journal_root_id));
  if(children.object!=='list'||children.has_more!==false||children.next_cursor!=null||!Array.isArray(children.results))return fail('INCOMPLETE_NATIVE_READ');
  const markers=children.results.filter((b:any)=>b?.type==='code'&&b.code?.language==='json');
  if(markers.length!==1)return fail('NATIVE_FIELDS_MISMATCH');const marker=object(markers[0]);
  const expected={kind:'META_ORIENTATION_JOURNAL/1',contract:'META_ORIENTATION/1.0',meta_root_id:s.meta_root_id,meta_runtime_id:s.meta_runtime_id,sources:{runs:s.runs_source_id,ledger:s.ledger_source_id,decisions:s.decisions_source_id,definitions:s.definitions_source_id}};
  if(marker.object!=='block'||marker.archived!==false||marker.in_trash!==false||marker.has_children!==false||text(marker.code?.rich_text)!==JSON.stringify(expected))return fail('NATIVE_FIELDS_MISMATCH');
  return {root:stableRecord(root),marker:stableRecord(marker),protected_sources:s.protected_source_ids};
}
type SchemaNeed={type:string;options?:readonly string[]};
const fields=(type:string,names:readonly string[]):Record<string,SchemaNeed>=>Object.fromEntries(names.map(name=>[name,{type}]));
const select=(...options:string[]):SchemaNeed=>({type:'select',options});
/** Validate the entire transaction, not only the next phase. Row values cannot
 * substitute for source schema, and absent options must never be auto-created.
 * Project used identities/types/options only: request IDs and unrelated fields
 * are neither proof nor reasons to rewrite or block another local workflow.
 */
async function publicationSchemas(reader:NotionReadClient,s:PublicationScope,definition:Record<string,string>){
  const definitionFields:Record<string,SchemaNeed>={...fields('rich_text',['Definition Key','Content','Decision Ref'])};
  for(const [name,v]of Object.entries(definition)){
    if(typeof v!=='string')return fail('INVALID_NATIVE_BINDING');
    definitionFields[name]=name==='Definition'?{type:'title'}:name==='Definition Type'||name==='Status'?select(v):{type:'rich_text'};
  }
  const needs:[string,Record<string,SchemaNeed>][]=[
    [s.runs_source_id,{
      ...fields('title',['Run']),...fields('rich_text',['Harness Plan ID','Runtime ID','Spec Version','META Schema Version','Control Version','Input Refs','Observed Facts','Opened Execution Attempt ID','Last Execution Attempt ID','Actions','Decisions Committed','Publication Refs']),
      ...(isOrientation(s)?{}:fields('rich_text',['Gate Before','Gate After Expected','Gate After Observed'])),
      Status:select('RUNNING','COMPLETED'),'Run Type':select('PUBLISH'),Origin:select('PLUGIN'),...(isOrientation(s)?{}:{'Control Confirmation State':select('PENDING')}),
      ...fields('checkbox',['Recovery Required']),...fields('number',['Attempt Count','Mutation Count','Verified Mutation Count']),...fields('date',['Started','Finished','Last Required Written At']),
    }],
    [s.ledger_source_id,{
      ...fields('title',['Mutation']),...fields('rich_text',['Harness Plan ID','Idempotency Key','Natural Key','Run Ref','Target Ref','Before Hash','After Expected Hash','After Observed Summary','Compared Fields','Prepared Execution Attempt ID','Written Execution Attempt ID','Verified Execution Attempt ID']),
      Operation:select('CREATE','UPDATE','PUBLISH_POINTER'),Status:select('PREPARED','WRITTEN','VERIFIED'),...fields('date',['Written At','Verified At']),
    }],
    [s.decisions_source_id,{Decision:{type:'title'},...fields('rich_text',['Resolution','Affected Objects']),Status:select('DECIDED'),Type:select('OBJECTIVE')}],
    [s.definitions_source_id,definitionFields],
    [s.recipient.manifest_source_id,{...fields('rich_text',['Instance ID','Schema Version','Sales Contract Version']),...fields('url',['Objective Package URL'])}],
  ];
  if(!isOrientation(s))needs.push([s.gates_source_id,{...fields('rich_text',['Gate Key','Passed By Run Ref','Confirmed By Control Check Ref','Evidence Refs']),Status:select('OPEN','PROVISIONAL_PASS','PASS'),'Control Confirmation State':select('PENDING','CONFIRMED'),...fields('date',['Last Required Written At'])}]);
  const projection:ObjectValue[]=[];
  if(isOrientation(s))projection.push({isolation:await orientationJournal(reader,s)});
  for(const [source,required]of needs){
    const schema=await sourceUnder(reader,source,source===s.recipient.manifest_source_id?s.recipient.root_page_id:isOrientation(s)?s.journal_root_id:s.meta_root_id);
    try{
      const properties=object(schema.properties),ids=new Set<string>(),columns=[];
      for(const name of Object.keys(required).sort()){
        const need=required[name]!,p=object(properties[name]);
        if(p.name!==name||typeof p.id!=='string'||!p.id||ids.has(p.id)||p.type!==need.type||p.read_only===true||p.readOnly===true||p.has_more===true)return fail('NATIVE_SCHEMA_MISMATCH');
        ids.add(p.id);object(p[need.type]);
        const options:{id:string;name:string}[]=[];
        if(need.options){
          if(!Array.isArray(p.select.options)||p.select.options.length>1000)return fail('NATIVE_SCHEMA_MISMATCH');
          const names=new Set<string>(),optionIds=new Set<string>();
          for(const raw of p.select.options){const o=object(raw);if(typeof o.name!=='string'||!o.name||typeof o.id!=='string'||!o.id||names.has(o.name)||optionIds.has(o.id))return fail('NATIVE_SCHEMA_MISMATCH');names.add(o.name);optionIds.add(o.id);}
          for(const name of [...need.options].sort()){const o=p.select.options.find((v:any)=>v.name===name);if(!o)return fail('NATIVE_SCHEMA_MISMATCH');options.push({id:o.id,name});}
        }
        columns.push({name,id:p.id,type:p.type,...(need.options?{options}:{})});
      }
      projection.push({source_id:source,columns});
    }catch{return fail('NATIVE_SCHEMA_MISMATCH');}
  }
  return projection;
}
async function unique(reader:NotionReadClient,source:string,filter:unknown,id:string){
  const q=object(await reader.queryDataSource(source,filter,undefined,{page_size:2}));
  if(q.object!=='list'||q.has_more!==false||q.next_cursor!=null||!Array.isArray(q.results))return fail('INCOMPLETE_NATIVE_READ');
  if(q.results.length!==1)return fail(q.results.length===0?'MISSING_NATIVE_PROOF':'AMBIGUOUS_NATIVE_PROOF');
  return page(q.results[0],id,source);
}
const equals=(property:string,v:string,type='rich_text')=>({property,[type]:{equals:v}});
function publicationPins(s:PublicationScope){
  const na={state:'NOT_APPLICABLE',reason:'ADAPTABLE_RECIPIENT_RECOMMENDATION; no Strategy/Toolkit/Authority publication or adoption.'};
  return JSON.stringify({...(isOrientation(s)?{contract:s.kind}:{}),pins:{sales_contract_version:s.recipient.sales_contract_version,recipient_schema_version:s.recipient.schema_version,strategy:na,toolkit:na,authority:na}});
}
const gateFields=['Status','Control Confirmation State','Passed By Run Ref','Confirmed By Control Check Ref','Evidence Refs','Last Required Written At'] as const;
function gateProjection(p:ObjectValue):Record<string,string>{
  exact(p,{'Gate Key':'G11'});
  return Object.fromEntries(gateFields.map(name=>{
    if(name==='Status'||name==='Control Confirmation State')return [name,value(p,name,'select')];
    if(name==='Last Required Written At'){const raw=value(p,name,'date');return [name,raw==null?'':new Date(minute(raw)*60000).toISOString()];}
    const raw=value(p,name,'rich_text');
    if(name==='Passed By Run Ref'||name==='Confirmed By Control Check Ref'){
      if(raw==='')return [name,''];
      const prop=p.properties[name],entry=prop.rich_text?.[0];
      return [name,url(entry?.type==='mention'&&entry.mention?.type==='page'?uuid(entry.mention.page?.id):reference(raw))];
    }
    return [name,raw];
  }));
}
function validateGateBaseline(before:Record<string,string>){
  if(Object.keys(before).sort().join(',')!==[...gateFields].sort().join(',')||Object.values(before).some(v=>typeof v!=='string'))return fail('INVALID_NATIVE_BINDING');
  if(!['OPEN','PASS'].includes(before.Status!)||before['Control Confirmation State']!==(before.Status==='PASS'?'CONFIRMED':'PENDING'))return fail('NATIVE_GATE_HELD');
  if(before['Last Required Written At']&&new Date(minute(before['Last Required Written At'])*60000).toISOString()!==before['Last Required Written At'])return fail('INVALID_NATIVE_BINDING');
  for(const field of ['Passed By Run Ref','Confirmed By Control Check Ref'])if(before[field]&&url(reference(before[field]))!==before[field])return fail('INVALID_NATIVE_BINDING');
}
function gateExpected(plan:string,run:string,definition:string,pkg:string,decision:string,requiredMinute:number):Record<string,string>{
  return {Status:'PROVISIONAL_PASS','Control Confirmation State':'PENDING','Passed By Run Ref':url(run),'Confirmed By Control Check Ref':'','Evidence Refs':JSON.stringify({proposal_id:plan,definition_id:definition,package_id:pkg,decision_id:decision}),'Last Required Written At':new Date(requiredMinute*60000).toISOString()};
}
function gateUpdateProperties(properties:Record<string,string>):NativeProperties{
  const result:NativeProperties={...properties};delete result['Last Required Written At'];
  return {...result,'date:Last Required Written At:start':properties['Last Required Written At']!,'date:Last Required Written At:is_datetime':1};
}
/** Complete bounded window for this publication, not a whole-runtime clean claim.
 * A damaged plan field must not hide a row whose idempotency key still names it.
 * Six rows are enough to disprove this fixed five-mutation transaction.
 */
async function publicationLedger(reader:NotionReadClient,s:PublicationScope,plan:string,run?:string,complete=false){
  const roles=rolesFor(s),prefix=keyPrefix(s,plan),q=object(await reader.queryDataSource(s.ledger_source_id,{or:[equals('Harness Plan ID',plan),{property:'Idempotency Key',rich_text:{starts_with:prefix}}]},undefined,{page_size:6}));
  if(q.object!=='list'||q.has_more!==false||q.next_cursor!=null||!Array.isArray(q.results))return fail('INCOMPLETE_NATIVE_READ');
  if(!run&&q.results.length)return fail('ORPHAN_NATIVE_TARGET');
  if(q.results.length>roles.length)return fail('UNEXPECTED_NATIVE_MUTATION');
  const keys=new Set<string>(),ids=new Set<string>(),rows=q.results.map(raw=>{
    const row=page(raw,uuid(raw.id),s.ledger_source_id),key=value(row,'Idempotency Key','rich_text');
    if(value(row,'Harness Plan ID','rich_text')!==plan||!roles.some(role=>key===prefix+role)||keys.has(key)||ids.has(uuid(row.id)))return fail('UNEXPECTED_NATIVE_MUTATION');
    keys.add(key);ids.add(uuid(row.id));refValue(row,'Run Ref',run!);
    const status=value(row,'Status','select');if(!['PREPARED','WRITTEN','VERIFIED'].includes(status))return fail('UNEXPECTED_NATIVE_MUTATION');
    return row;
  }).sort((a,b)=>roles.indexOf(value(a,'Idempotency Key','rich_text').slice(prefix.length))-roles.indexOf(value(b,'Idempotency Key','rich_text').slice(prefix.length)));
  for(const [i,row]of rows.entries())if(value(row,'Idempotency Key','rich_text')!==prefix+roles[i]||i<rows.length-1&&value(row,'Status','select')!=='VERIFIED')return fail('UNEXPECTED_NATIVE_MUTATION');
  if(complete&&rows.length!==roles.length)return fail('MISSING_NATIVE_PROOF');
  return rows;
}
interface NativeAttempt {attempt_id:string;phase:string}
function attemptNumber(raw:unknown,plan:string,limit:number):number {
  const prefix=plan+':PUBLISH:';
  if(typeof raw!=='string'||!raw.startsWith(prefix))return fail('NATIVE_ATTEMPT_UNCONFIRMED');
  const suffix=raw.slice(prefix.length),n=Number(suffix);
  if(!/^[1-9]\d*$/.test(suffix)||!Number.isSafeInteger(n)||n>limit)return fail('NATIVE_ATTEMPT_UNCONFIRMED');
  return n;
}
function runAttempts(run:ObjectValue,plan:string,s:PublicationScope){
  const phases=new Set(['OPEN_RUN','CLOSE_RUN',...rolesFor(s).flatMap(r=>['PREPARE_','WRITE_','WRITTEN_','VERIFIED_'].map(p=>p+r))]);
  const count=value(run,'Attempt Count','number'),log=object(JSON.parse(value(run,'Actions','rich_text')));
  if(!Number.isSafeInteger(count)||count<1||count>150||Object.keys(log).sort().join(',')!=='attempts,kind,proposal_id'||log.kind!=='NATIVE_PUBLICATION_ATTEMPTS/1'||log.proposal_id!==plan||!Array.isArray(log.attempts)||log.attempts.length!==count)return fail('NATIVE_ATTEMPT_UNCONFIRMED');
  const entries:NativeAttempt[]=log.attempts.map((entry:unknown,i:number)=>{const a=object(entry);if(Object.keys(a).sort().join(',')!=='attempt_id,phase'||attemptNumber(a.attempt_id,plan,count)!==i+1||!phases.has(a.phase))return fail('NATIVE_ATTEMPT_UNCONFIRMED');return {attempt_id:a.attempt_id,phase:a.phase};});
  if(entries[0]!.phase!=='OPEN_RUN'||value(run,'Opened Execution Attempt ID','rich_text')!==entries[0]!.attempt_id||value(run,'Last Execution Attempt ID','rich_text')!==entries.at(-1)!.attempt_id)return fail('NATIVE_ATTEMPT_UNCONFIRMED');
  return {count,entries,serialized:JSON.stringify({kind:log.kind,proposal_id:plan,attempts:entries})};
}
function mutationAttempts(row:ObjectValue,plan:string,admission:ReturnType<typeof runAttempts>,role:string,status:string){
  const names=['Prepared Execution Attempt ID','Written Execution Attempt ID','Verified Execution Attempt ID'],expected=['PREPARE_','WRITE_','VERIFIED_'].map(p=>p+role),limit=status==='PREPARED'?1:status==='WRITTEN'?2:3;
  let last=0;
  for(let i=0;i<3;i++){
    const raw=value(row,names[i]!,'rich_text');
    if(i>=limit){if(raw!=='')return fail('NATIVE_ATTEMPT_UNCONFIRMED');continue;}
    const n=attemptNumber(raw,plan,admission.count);
    if(n<last||admission.entries[n-1]?.phase!==expected[i])return fail('NATIVE_ATTEMPT_UNCONFIRMED');last=n;
  }
}

/** Two bounded independent reads; no write, implicit repair, approval, or active pointer change.
 * A positive observation is not atomic, recipient adoption, policy change, or business success.
 */
export async function verifyRealDirectionPublication(reader:NotionReadClient,s:DirectionPublicationScope,e:DirectionPublicationExpectation):Promise<any>{
  // This entry point is always the original global contract, regardless of JS casts.
  if('kind' in s)return {status:'UNCONFIRMED',reason:'INVALID_NATIVE_BINDING',business_result_verified:false};
  return verifyPublication(reader,s,e);
}
export async function verifyMetaOrientationPublication(reader:NotionReadClient,s:MetaOrientationScope,e:DirectionPublicationExpectation):Promise<any>{
  if(!isOrientation(s)||'gates_source_id' in s||'gate_page_id' in s)return {status:'UNCONFIRMED',reason:'INVALID_NATIVE_BINDING',business_result_verified:false};
  return verifyPublication(reader,s,e);
}
async function verifyPublication(reader:NotionReadClient,s:PublicationScope,e:DirectionPublicationExpectation,observation?:{sealed_intent:string;at:number}):Promise<any>{
  try{
    const orientation=isOrientation(s),roles=rolesFor(s),count=roles.length;
    const physical=[...scopeIds(s),e.run_id,e.definition_id,e.package_id,e.decision_id,...e.mutations.map(m=>m.id)];
    if(physical.some(x=>uuid(x)!==x)||new Set(physical).size!==physical.length||!e.proposal_id||e.package_text.length>24000)return fail('INVALID_NATIVE_BINDING');
    if(!orientation)validateGateBaseline(e.gate_before);
    else if(Object.keys(e.gate_before).length||Object.keys(e.gate_properties).length)return fail('INVALID_NATIVE_BINDING');
    const targetIds=[e.definition_id,e.package_id,e.decision_id,s.recipient.manifest_page_id,...(!isOrientation(s)?[s.gate_page_id]:[])];
    const afterHashes=[hash(e.definition_properties),hash({content:e.package_text}),hash(e.decision_properties),hash({'Objective Package URL':url(e.package_id)}),...(!orientation?[hash(e.gate_properties)]:[])];
    if(e.mutations.length!==count||new Set(e.mutations.map(m=>m.key)).size!==count)return fail('INVALID_NATIVE_BINDING');
    for(const [i,m]of e.mutations.entries())if(m.target_id!==targetIds[i]||m.key!==keyPrefix(s,e.proposal_id)+roles[i]||m.operation!==(i===4?'UPDATE':i===3?'PUBLISH_POINTER':'CREATE')||m.after_hash!==afterHashes[i]||m.before_hash!==hash(i===4?e.gate_before:i===3?{'Objective Package URL':e.previous_pointer}:null))return fail('INVALID_NATIVE_BINDING');
    const pkg=object(JSON.parse(e.package_text)),decision=object(JSON.parse(e.decision_properties.Resolution??''));
    if(pkg.kind!=='RECIPIENT_DIRECTION/1'||pkg.proposal_id!==e.proposal_id||pkg.recipient_runtime_id!==s.recipient.runtime_id||pkg.classification!=='RECIPIENT_SAFE'||pkg.authority_change!==false||decision.proposal_id!==e.proposal_id||decision.package_hash!==afterHashes[1]||decision.classification!=='RECIPIENT_SAFE'||decision.schema_version!==s.recipient.schema_version||decision.sales_contract_version!==s.recipient.sales_contract_version||decision.authority_change!==false||e.decision_properties.Status!=='DECIDED'||e.decision_properties.Type!=='OBJECTIVE'||e.definition_properties.Status!=='APPROVED_FOR_VERSION')return fail('INVALID_NATIVE_BINDING');
    if(orientation&&(pkg.contract!=='META_ORIENTATION/1.0'||decision.contract!==pkg.contract))return fail('INVALID_NATIVE_BINDING');
    const attestation=e.definition_properties['Decision Ref'];
    if(attestation?.startsWith('OWNER_SESSION:')&&(attestation!=='OWNER_SESSION:'+e.proposal_id||decision.owner_session_ref!==attestation))return fail('INVALID_NATIVE_BINDING');
    const snapshot=async()=>{
      page(await reader.retrievePage(s.meta_root_id),s.meta_root_id);page(await reader.retrievePage(s.recipient.root_page_id),s.recipient.root_page_id);
      const schemas=await publicationSchemas(reader,s,e.definition_properties);
      const run=await unique(reader,s.runs_source_id,{and:[equals('Harness Plan ID',e.proposal_id),equals('Run Type','PUBLISH','select')]},e.run_id);
      exact(run,{'Harness Plan ID':e.proposal_id,'Runtime ID':s.meta_runtime_id,'Spec Version':s.spec_version,'META Schema Version':s.meta_schema_version,'Control Version':s.control_version,Status:'COMPLETED','Run Type':'PUBLISH',Origin:'PLUGIN','Recovery Required':false,'Mutation Count':count,'Verified Mutation Count':count,...(!orientation?{'Gate Before':JSON.stringify(e.gate_before),'Gate After Expected':'PROVISIONAL_PASS','Gate After Observed':'PROVISIONAL_PASS'}:{})},{Status:'select','Run Type':'select',Origin:'select','Recovery Required':'checkbox','Mutation Count':'number','Verified Mutation Count':'number'});
      exact(run,{'Input Refs':publicationPins(s)});
      if(observation)exact(run,{'Observed Facts':observation.sealed_intent});
      const admission=runAttempts(run,e.proposal_id,s);if(admission.entries.at(-1)?.phase!=='CLOSE_RUN')return fail('NATIVE_ATTEMPT_UNCONFIRMED');
      const ledgerWindow=await publicationLedger(reader,s,e.proposal_id,e.run_id,true);
      refValue(run,'Decisions Committed',e.decision_id);refValue(run,'Publication Refs',e.package_id);
      const started=minute(value(run,'Started','date')),finished=minute(value(run,'Finished','date'));if(finished<started)return fail('NATIVE_TIMESTAMP_MISMATCH');
      if(observation&&finished>observation.at)return fail('NATIVE_TIMESTAMP_MISMATCH');
      const definition=await unique(reader,s.definitions_source_id,equals('Definition Key',e.definition_properties['Definition Key']!),e.definition_id);
      exact(definition,e.definition_properties,{Definition:'title','Definition Type':'select',Status:'select'});if(!attestation?.startsWith('OWNER_SESSION:'))refValue(definition,'Decision Ref',e.decision_id);
      const d=await unique(reader,s.decisions_source_id,equals('Resolution',e.decision_properties.Resolution!),e.decision_id);
      exact(d,e.decision_properties,{Decision:'title',Status:'select',Type:'select'});refValue(d,'Affected Objects',e.package_id);
      const manifest=page(await reader.retrievePage(s.recipient.manifest_page_id),s.recipient.manifest_page_id,s.recipient.manifest_source_id);
      exact(manifest,{'Instance ID':s.recipient.runtime_id,'Schema Version':s.recipient.schema_version,'Sales Contract Version':s.recipient.sales_contract_version});refValue(manifest,'Objective Package URL',e.package_id);
      const packagePage=page(await reader.retrievePage(e.package_id),e.package_id,undefined,s.recipient.root_page_id);
      const gate=!isOrientation(s)?await unique(reader,s.gates_source_id,equals('Gate Key','G11'),s.gate_page_id):undefined;
      if(gate&&JSON.stringify(gateProjection(gate))!==JSON.stringify(e.gate_properties))return fail('NATIVE_GATE_CHANGED');
      const blocks=object(await reader.retrieveBlockChildren(e.package_id));
      if(blocks.object!=='list'||blocks.has_more!==false||blocks.next_cursor!=null||!Array.isArray(blocks.results)||blocks.results.length!==1)return fail('INCOMPLETE_NATIVE_READ');
      const block=object(blocks.results[0]);
      if(block.object!=='block'||block.type!=='code'||block.archived!==false||block.in_trash!==false||block.has_children!==false||block.code?.language!=='json'||text(block.code.rich_text)!==e.package_text)return fail('NATIVE_FIELDS_MISMATCH');
      const ledger:ObjectValue[]=[],times:{written:number;verified:number}[]=[];
      for(const [i,m] of e.mutations.entries()){
        const row=page(ledgerWindow[i],m.id,s.ledger_source_id);
        const fields=i===0?Object.keys(e.definition_properties):i===1?['content']:i===2?Object.keys(e.decision_properties):i===3?['Objective Package URL']:Object.keys(e.gate_properties);
        exact(row,{'Harness Plan ID':e.proposal_id,'Idempotency Key':m.key,Operation:m.operation,Status:'VERIFIED','Before Hash':m.before_hash,'After Expected Hash':m.after_hash,'After Observed Summary':JSON.stringify({target_id:m.target_id,hash:m.after_hash}),'Compared Fields':JSON.stringify(fields)},{Operation:'select',Status:'select'});
        refValue(row,'Run Ref',e.run_id);refValue(row,'Target Ref',m.target_id);
        mutationAttempts(row,e.proposal_id,admission,roles[i]!,'VERIFIED');
        const written=minute(value(row,'Written At','date')),verified=minute(value(row,'Verified At','date'));
        if(written<started||verified<written||verified>finished)return fail('NATIVE_TIMESTAMP_MISMATCH');
        ledger.push(row);times.push({written,verified});
      }
      if(times[3]!.written<Math.max(...times.slice(0,3).map(t=>t.verified)))return fail('CURRENT_NOT_LAST');
      if(!orientation&&(times[4]!.written<Math.max(...times.slice(0,4).map(t=>t.verified))||JSON.stringify(e.gate_properties)!==JSON.stringify(gateExpected(e.proposal_id,e.run_id,e.definition_id,e.package_id,e.decision_id,Math.max(...times.slice(0,4).map(t=>t.verified))))))return fail('NATIVE_GATE_CHANGED');
      return {schemas,run:stableRecord(run),definition:stableRecord(definition),decision:stableRecord(d),manifest:stableRecord(manifest),packagePage:stableRecord(packagePage),...(gate?{gate:stableRecord(gate)}:{}),block:stableRecord(block),ledger:ledger.map(stableRecord)};
    };
    const first=await snapshot(),last=await snapshot();
    if(JSON.stringify(first)!==JSON.stringify(last))return fail('NATIVE_CHANGED_DURING_READ');
    return {status:orientation?'ORIENTATION_NATIVE_VERIFIED':'NATIVE_RECORDS_VERIFIED_PENDING_CONTROL',...(orientation?{contract:'META_ORIENTATION/1.0',control_confirmed:false}:{}),...(orientation&&observation?{publication_completed_at:new Date(minute(value(last.run,'Finished','date'))*60000).toISOString(),publication_time_precision:'UTC_MINUTE'}:{}),proposal_id:e.proposal_id,package_id:e.package_id,run_id:e.run_id,native_chain_verified:true,control_confirmation_required:!orientation,atomic:false,business_result_verified:false,recipient_consumption_verified:false};
  }catch(error){
    const allowed=['INCOMPLETE_NATIVE_READ','INVALID_NATIVE_BINDING','NATIVE_REFERENCE_MISMATCH','NATIVE_FIELDS_MISMATCH','NATIVE_SCHEMA_MISMATCH','NATIVE_SCOPE_MISMATCH','NATIVE_TIMESTAMP_MISMATCH','MISSING_NATIVE_PROOF','AMBIGUOUS_NATIVE_PROOF','CURRENT_NOT_LAST','NATIVE_CHANGED_DURING_READ','NATIVE_ATTEMPT_UNCONFIRMED','NATIVE_GATE_CHANGED','NATIVE_GATE_HELD','UNEXPECTED_NATIVE_MUTATION','ORPHAN_NATIVE_TARGET'];
    return {status:'UNCONFIRMED',reason:error instanceof Error&&allowed.includes(error.message)?error.message:'NATIVE_PROOF_UNAVAILABLE',atomic:false,business_result_verified:false};
  }
}

export interface NativeDirectionIntent {
  proposal_id:string;definition_properties:Record<string,string>;package_text:string;
  previous_pointer:string;gate_before:Record<string,string>;approved_at:string;sealed_intent:string;
}
type NativeProperties=Record<string,string|number|null>;
export type NativePublicationWrite=
  |{operation:'CREATE_IF_ABSENT';data_source_id:string;key_property:string;key:string;key_filter?:Record<string,unknown>;properties:NativeProperties}
  |{operation:'CREATE_CHILD_IF_ABSENT';parent_page_id:string;title:string;content:string}
  |{operation:'UPDATE_IF_MATCH';page_id:string;expected_revision:string;before:NativeProperties;properties:NativeProperties};

/** An admitted controller asks for the next bounded native phase. This function performs no write.
 * The approved intent is fixed, and every retry discovers the actual native records.
 * Native connectors must fresh-compare before applying returned UPDATE_IF_MATCH.
 */
export async function nextRealDirectionPublication(reader:NotionReadClient,s:DirectionPublicationScope,intent:NativeDirectionIntent,clock=()=>new Date()):Promise<any>{
  if('kind' in s)return {status:'UNCONFIRMED',reason:'INVALID_NATIVE_BINDING',business_result_verified:false};
  return nextPublication(reader,s,intent,clock);
}
export async function nextMetaOrientationPublication(reader:NotionReadClient,s:MetaOrientationScope,intent:Omit<NativeDirectionIntent,'gate_before'>,clock=()=>new Date()):Promise<any>{
  if(!isOrientation(s)||'gates_source_id' in s||'gate_page_id' in s||'gate_before' in intent&&Object.keys(object(intent.gate_before)).length)return {status:'UNCONFIRMED',reason:'INVALID_NATIVE_BINDING',business_result_verified:false};
  return nextPublication(reader,s,{...intent,gate_before:{}},clock);
}
/** Read-only observation of an already-published orientation. Discovery supplies
 * candidate identities only: the unchanged two-pass verifier proves their facts.
 * Never returns a write or reuses a proof from a prior request.
 */
export async function observeMetaOrientationPublication(reader:NotionReadClient,s:MetaOrientationScope,intent:Omit<NativeDirectionIntent,'gate_before'>,clock=()=>new Date()):Promise<any>{
  if(!isOrientation(s)||'gates_source_id' in s||'gate_page_id' in s||'gate_before' in intent&&Object.keys(object(intent.gate_before)).length)return {status:'UNCONFIRMED',reason:'INVALID_NATIVE_BINDING',business_result_verified:false};
  return nextPublication(reader,s,{...intent,gate_before:{}},clock,true);
}
async function nextPublication(reader:NotionReadClient,s:PublicationScope,intent:NativeDirectionIntent,clock:()=>Date,observationOnly=false):Promise<any>{
  try{
    const orientation=isOrientation(s),roles=rolesFor(s),count=roles.length;
    const stamp=clock().toISOString().slice(0,16)+':00.000Z',planId=intent.proposal_id,sessionRef='OWNER_SESSION:'+planId;
    const pkg=object(JSON.parse(intent.package_text)),definition=intent.definition_properties,packageHash=hash({content:intent.package_text}),packageTitle='META — Orientation — '+planId;
    if(!planId||intent.sealed_intent.length>24000||intent.package_text.length>24000||definition['Decision Ref']!==sessionRef||definition.Status!=='APPROVED_FOR_VERSION'||pkg.kind!=='RECIPIENT_DIRECTION/1'||pkg.proposal_id!==planId||pkg.recipient_runtime_id!==s.recipient.runtime_id||pkg.classification!=='RECIPIENT_SAFE'||pkg.authority_change!==false)return fail('INVALID_NATIVE_BINDING');
    minute(intent.approved_at);
    if(orientation&&pkg.contract!=='META_ORIENTATION/1.0')return fail('INVALID_NATIVE_BINDING');
    if(!orientation)validateGateBaseline(intent.gate_before);
    const roots=scopeIds(s);
    if(roots.some(x=>uuid(x)!==x)||new Set(roots).size!==roots.length)return fail('INVALID_NATIVE_BINDING');
    if(!observationOnly){
      page(await reader.retrievePage(s.meta_root_id),s.meta_root_id);page(await reader.retrievePage(s.recipient.root_page_id),s.recipient.root_page_id);
      await publicationSchemas(reader,s,definition);
    }
    const find=async(source:string,filter:unknown)=>{
      const q=object(await reader.queryDataSource(source,filter,undefined,{page_size:2}));
      if(q.object!=='list'||q.has_more!==false||q.next_cursor!=null||!Array.isArray(q.results))return fail('INCOMPLETE_NATIVE_READ');
      if(q.results.length>1)return fail('AMBIGUOUS_NATIVE_PROOF');
      return q.results.length?page(q.results[0],uuid(q.results[0].id),source):undefined;
    };
    const runBinding={'Harness Plan ID':planId,'Runtime ID':s.meta_runtime_id,'Spec Version':s.spec_version,'META Schema Version':s.meta_schema_version,'Control Version':s.control_version,'Input Refs':publicationPins(s),'Run Type':'PUBLISH',Origin:'PLUGIN','Observed Facts':intent.sealed_intent,...(!orientation?{'Gate Before':JSON.stringify(intent.gate_before),'Gate After Expected':'PROVISIONAL_PASS'}:{})};
    if(observationOnly){
      if(!orientation)return fail('INVALID_NATIVE_BINDING');
      const run=await find(s.runs_source_id,{and:[equals('Harness Plan ID',planId),equals('Run Type','PUBLISH','select')]});
      if(!run)return fail('MISSING_NATIVE_PROOF');
      exact(run,{...runBinding,Status:'COMPLETED'},{'Run Type':'select',Origin:'select',Status:'select'});
      const runId=uuid(run.id),rows=await publicationLedger(reader,s,planId,runId,true);
      const targetId=(row:ObjectValue)=>{
        const p=object(row.properties?.['Target Ref']);
        if(p.type==='rich_text'&&p.has_more!==true&&Array.isArray(p.rich_text)&&p.rich_text.length===1){
          const r=object(p.rich_text[0]);if(r.type==='mention'&&r.mention?.type==='page')return uuid(r.mention.page?.id);
        }
        return reference(value(row,'Target Ref',p.type==='url'?'url':'rich_text'));
      };
      const [definitionId,packageId,decisionId]=rows.slice(0,3).map(targetId) as [string,string,string];
      const children=object(await reader.retrieveBlockChildren(s.recipient.root_page_id));
      if(children.object!=='list'||children.has_more!==false||children.next_cursor!=null||!Array.isArray(children.results))return fail('INCOMPLETE_NATIVE_READ');
      const matches=children.results.filter((b:any)=>b?.type==='child_page'&&b.child_page?.title===packageTitle);
      if(matches.length!==1)return fail(matches.length?'AMBIGUOUS_NATIVE_PROOF':'MISSING_NATIVE_PROOF');
      if(uuid(matches[0].id)!==packageId)return fail('NATIVE_REFERENCE_MISMATCH');
      const decision={Decision:'Publication orientation — '+planId,Status:'DECIDED',Type:'OBJECTIVE',Resolution:JSON.stringify({contract:'META_ORIENTATION/1.0',proposal_id:planId,package_hash:packageHash,classification:'RECIPIENT_SAFE',schema_version:s.recipient.schema_version,sales_contract_version:s.recipient.sales_contract_version,authority_change:false,owner_session_ref:sessionRef}),'Affected Objects':url(packageId)};
      const properties=[definition,{content:intent.package_text},decision,{'Objective Package URL':url(packageId)}];
      // All expected keys, digests, operations and targets come from the admitted
      // immutable intent/scope, never from model claims or Ledger hash fields.
      const mutations=rows.map((row,i)=>({id:uuid(row.id),key:keyPrefix(s,planId)+roles[i],operation:i===3?'PUBLISH_POINTER':'CREATE',target_id:[definitionId,packageId,decisionId,s.recipient.manifest_page_id][i]!,after_hash:hash(properties[i]),before_hash:hash(i===3?{'Objective Package URL':intent.previous_pointer}:null)}));
      return verifyPublication(reader,s,{proposal_id:planId,run_id:runId,definition_id:definitionId,package_id:packageId,decision_id:decisionId,package_text:intent.package_text,definition_properties:definition,decision_properties:decision,previous_pointer:intent.previous_pointer,gate_before:{},gate_properties:{},mutations},{sealed_intent:intent.sealed_intent,at:minute(stamp)});
    }
    const gate=!isOrientation(s)?await unique(reader,s.gates_source_id,equals('Gate Key','G11'),s.gate_page_id):undefined,observedGate=gate?gateProjection(gate):{},gateUnchanged=JSON.stringify(observedGate)===JSON.stringify(intent.gate_before);
    if(!gateUnchanged&&(observedGate.Status!=='PROVISIONAL_PASS'||observedGate['Control Confirmation State']!=='PENDING'))return fail('NATIVE_GATE_CHANGED');
    let admission:{run:ObjectValue;state:ReturnType<typeof runAttempts>}|undefined;
    const pending=(write:NativePublicationWrite,phase:string)=>{
      let writes=[write];
      if(admission){
        const {run,state}=admission,n=state.count+1;if(n>150)return fail('NATIVE_ATTEMPT_BOUND');
        const attempt=planId+':PUBLISH:'+n,actions=JSON.stringify({kind:'NATIVE_PUBLICATION_ATTEMPTS/1',proposal_id:planId,attempts:[...state.entries,{attempt_id:attempt,phase}]});
        if(phase.startsWith('PREPARE_')){if(write.operation!=='CREATE_IF_ABSENT')return fail('INVALID_NATIVE_BINDING');write={...write,properties:{...write.properties,'Prepared Execution Attempt ID':attempt,'Written Execution Attempt ID':'','Verified Execution Attempt ID':''}};}
        if(phase.startsWith('VERIFIED_')){if(write.operation!=='UPDATE_IF_MATCH')return fail('INVALID_NATIVE_BINDING');write={...write,properties:{...write.properties,'Verified Execution Attempt ID':attempt}};}
        const metadata:NativePublicationWrite={operation:'UPDATE_IF_MATCH',page_id:uuid(run.id),expected_revision:run.last_edited_time,before:{'Attempt Count':state.count,'Last Execution Attempt ID':value(run,'Last Execution Attempt ID','rich_text'),Actions:value(run,'Actions','rich_text')},properties:{'Attempt Count':n,'Last Execution Attempt ID':attempt,Actions:actions}};
        writes=write.operation==='UPDATE_IF_MATCH'&&write.page_id===uuid(run.id)?[{...write,before:{...metadata.before,...write.before},properties:{...write.properties,...metadata.properties}}]:[metadata,write];
      }
      return {status:'APPROVED_PENDING_NOTION',...(orientation?{contract:'META_ORIENTATION/1.0'}:{}),phase,approval_required:false,proposal_id:planId,ordered:true,stop_on_failed_precondition:true,writes,next_action:'Exécuter les writes dans leur ordre, après comparaison fraîche et recherche de clé (key_filter si fourni). Si le premier compare échoue, ne pas exécuter la suite. Relire puis reprendre VERIFY dans ce même tour ; mêmes clés/UUID réussis, aucune nouvelle validation, aucun autre champ ni effet externe. Un plan retourné ne signifie pas écrit.'};
    };
    const create=(source:string,property:string,key:string,properties:NativeProperties,phase:string,keyFilter?:Record<string,unknown>)=>pending({operation:'CREATE_IF_ABSENT',data_source_id:source,key_property:property,key,...(keyFilter?{key_filter:keyFilter}:{}),properties},phase);
    const update=(p:ObjectValue,before:NativeProperties,properties:NativeProperties,phase:string)=>{
      if(p.parent?.type==='data_source_id'&&uuid(p.parent.data_source_id)===s.ledger_source_id)for(const name of ['Prepared Execution Attempt ID','Written Execution Attempt ID','Verified Execution Attempt ID'])before={...before,[name]:value(p,name,'rich_text')};
      return pending({operation:'UPDATE_IF_MATCH',page_id:uuid(p.id),expected_revision:p.last_edited_time,before,properties},phase);
    };
    const manifest=page(await reader.retrievePage(s.recipient.manifest_page_id),s.recipient.manifest_page_id,s.recipient.manifest_source_id);
    exact(manifest,{'Instance ID':s.recipient.runtime_id,'Schema Version':s.recipient.schema_version,'Sales Contract Version':s.recipient.sales_contract_version});
    const pointer=value(manifest,'Objective Package URL','url')??'';
    if(typeof pointer!=='string')return fail('NATIVE_FIELDS_MISMATCH');
    const findPackage=async()=>{
      const blocks=object(await reader.retrieveBlockChildren(s.recipient.root_page_id));
      if(blocks.object!=='list'||blocks.has_more!==false||blocks.next_cursor!=null||!Array.isArray(blocks.results))return fail('INCOMPLETE_NATIVE_READ');
      const matches=blocks.results.filter((b:any)=>b?.type==='child_page'&&b.child_page?.title===packageTitle);
      if(matches.length>1)return fail('AMBIGUOUS_NATIVE_PROOF');
      if(!matches.length)return;
      const p=page(await reader.retrievePage(uuid(matches[0].id)),uuid(matches[0].id),undefined,s.recipient.root_page_id),q=object(await reader.retrieveBlockChildren(p.id));
      if(q.object!=='list'||q.has_more!==false||q.next_cursor!=null||!Array.isArray(q.results)||q.results.length!==1)return fail('INCOMPLETE_NATIVE_READ');
      const b=object(q.results[0]);if(b.object!=='block'||b.type!=='code'||b.archived!==false||b.in_trash!==false||b.has_children!==false||b.code?.language!=='json'||text(b.code.rich_text)!==intent.package_text)return fail('NATIVE_FIELDS_MISMATCH');
      return p;
    };
    const runFilter={and:[equals('Harness Plan ID',planId),equals('Run Type','PUBLISH','select')]},run=await find(s.runs_source_id,runFilter);
    await publicationLedger(reader,s,planId,run?uuid(run.id):undefined);
    if(!run){
      if(pointer!==intent.previous_pointer)return fail('NATIVE_FIELDS_MISMATCH');
      if(!gateUnchanged)return fail('NATIVE_GATE_CHANGED');
      if(await find(s.definitions_source_id,equals('Definition Key',definition['Definition Key']!))||await findPackage())return fail('ORPHAN_NATIVE_TARGET');
      return create(s.runs_source_id,'Harness Plan ID',planId,{Run:'Orientation personnelle — '+planId,...runBinding,Status:'RUNNING','Recovery Required':'__YES__','Mutation Count':count,'Verified Mutation Count':0,...(!orientation?{'Gate After Observed':'','Control Confirmation State':'PENDING'}:{}),'Attempt Count':1,'Opened Execution Attempt ID':planId+':PUBLISH:1','Last Execution Attempt ID':planId+':PUBLISH:1',Actions:JSON.stringify({kind:'NATIVE_PUBLICATION_ATTEMPTS/1',proposal_id:planId,attempts:[{attempt_id:planId+':PUBLISH:1',phase:'OPEN_RUN'}]}),'date:Started:start':stamp,'date:Started:is_datetime':1},'OPEN_RUN',runFilter);
    }
    exact(run,runBinding,{'Run Type':'select',Origin:'select'});
    const runStatus=value(run,'Status','select');if(!['RUNNING','COMPLETED'].includes(runStatus))return fail('NATIVE_RUN_HELD');
    admission={run,state:runAttempts(run,planId,s)};
    if(!gateUnchanged){
      const evidence=object(JSON.parse(observedGate['Evidence Refs']!));
      if(observedGate['Passed By Run Ref']!==url(uuid(run.id))||evidence.proposal_id!==planId)return fail('NATIVE_GATE_CHANGED');
    }
    const pointerChanged=pointer!==intent.previous_pointer,ownedPackage=pointerChanged?await findPackage():undefined;
    if(pointerChanged&&(!ownedPackage||reference(pointer)!==uuid(ownedPackage.id)))return fail('NATIVE_FIELDS_MISMATCH');
    const started=minute(value(run,'Started','date'));if(minute(stamp)<started)return fail('NATIVE_TIMESTAMP_MISMATCH');
    const runId=uuid(run.id),mutations:MutationProof[]=[],verifiedTimes:number[]=[];
    let definitionId='',packageId='',decisionId='';let decision:Record<string,string>={},expectedGate:Record<string,string>={};
    for(let index=0;index<count;index++){
      const role=roles[index]!,key=keyPrefix(s,planId)+role,operation=index===4?'UPDATE':index===3?'PUBLISH_POINTER':'CREATE';
      if(index===2){
        decision={Decision:'Publication orientation — '+planId,Status:'DECIDED',Type:'OBJECTIVE',Resolution:JSON.stringify({...(orientation?{contract:'META_ORIENTATION/1.0'}:{}),proposal_id:planId,package_hash:packageHash,classification:'RECIPIENT_SAFE',schema_version:s.recipient.schema_version,sales_contract_version:s.recipient.sales_contract_version,authority_change:false,owner_session_ref:sessionRef}),'Affected Objects':url(packageId)};
      }
      if(index===4)expectedGate=gateExpected(planId,runId,definitionId,packageId,decisionId,Math.max(...verifiedTimes));
      const properties:Record<string,string>=index===0?definition:index===1?{content:intent.package_text}:index===2?decision:index===3?{'Objective Package URL':url(packageId)}:expectedGate;
      const expectedHash=hash(properties),beforeHash=hash(index===4?intent.gate_before:index===3?{'Objective Package URL':intent.previous_pointer}:null);
      const ledger=await find(s.ledger_source_id,equals('Idempotency Key',key));
      const target=index===0?await find(s.definitions_source_id,equals('Definition Key',definition['Definition Key']!)):index===1?await findPackage():index===2?await find(s.decisions_source_id,equals('Resolution',decision.Resolution!)):index===3?manifest:gate;
      if(target&&index===0)exact(target,definition,{Definition:'title','Definition Type':'select',Status:'select'});
      if(target&&index===2)exact(target,decision,{Decision:'title',Status:'select',Type:'select'});
      const pointerAlready=index===3&&pointer===url(packageId),pointerUnchanged=pointer===intent.previous_pointer;
      const gateAlready=index===4&&JSON.stringify(observedGate)===JSON.stringify(expectedGate);
      if(!gateUnchanged&&index<4){
        if(!ledger||value(ledger,'Status','select')!=='VERIFIED')return fail('NATIVE_GATE_CHANGED');
      }
      if(index===4&&!gateUnchanged&&!gateAlready)return fail('NATIVE_GATE_CHANGED');
      if(!pointerUnchanged&&!(ownedPackage&&reference(pointer)===uuid(ownedPackage.id)))return fail('NATIVE_FIELDS_MISMATCH');
      const binding={'Harness Plan ID':planId,'Idempotency Key':key,Operation:operation,'Before Hash':beforeHash,'After Expected Hash':expectedHash};
      if(!ledger){
        if(pointerChanged&&index<3)return fail('CURRENT_NOT_LAST');
        if(runStatus==='COMPLETED')return fail('MISSING_NATIVE_PROOF');
        if(index===4?gateAlready:index===3?pointerAlready:target)return fail('ORPHAN_NATIVE_TARGET');
        if(index===3&&(!pointerUnchanged||minute(stamp)<Math.max(...verifiedTimes)))return fail('CURRENT_NOT_LAST');
        return create(s.ledger_source_id,'Idempotency Key',key,{Mutation:'Publication — '+role,...binding,'Natural Key':index===0?definition['Definition Key']!:index===1?packageTitle:index===2?'DECISION:'+planId:index===3?'CURRENT:'+s.recipient.runtime_id:'G11','Run Ref':url(runId),Status:'PREPARED'},'PREPARE_'+role);
      }
      exact(ledger,binding,{Operation:'select'});refValue(ledger,'Run Ref',runId);
      const status=value(ledger,'Status','select');if(!['PREPARED','WRITTEN','VERIFIED'].includes(status)||runStatus==='COMPLETED'&&status!=='VERIFIED')return fail('NATIVE_FIELDS_MISMATCH');
      mutationAttempts(ledger,planId,admission.state,role,status);
      if(pointerChanged&&index<3&&status!=='VERIFIED')return fail('CURRENT_NOT_LAST');
      if(!target||index===3&&!pointerAlready||index===4&&!gateAlready){
        if(status!=='PREPARED')return fail('MISSING_NATIVE_PROOF');
        if(index===0)return create(s.definitions_source_id,'Definition Key',definition['Definition Key']!,definition,'WRITE_DEFINITION');
        if(index===1)return pending({operation:'CREATE_CHILD_IF_ABSENT',parent_page_id:s.recipient.root_page_id,title:packageTitle,content:intent.package_text},'WRITE_PACKAGE');
        if(index===2)return create(s.decisions_source_id,'Resolution',decision.Resolution!,decision,'WRITE_DECISION');
        if(index===4){
          if(!gateUnchanged||minute(stamp)<Math.max(...verifiedTimes))return fail('NATIVE_GATE_CHANGED');
          const before=Object.fromEntries(gateFields.map(name=>[name,value(gate!,name,name==='Status'||name==='Control Confirmation State'?'select':name==='Last Required Written At'?'date':'rich_text')??null]));
          return update(gate!,before,gateUpdateProperties(expectedGate),'WRITE_GATE');
        }
        if(!pointerUnchanged||minute(stamp)<Math.max(...verifiedTimes))return fail('CURRENT_NOT_LAST');
        return update(manifest,{'Objective Package URL':value(manifest,'Objective Package URL','url')},{'Objective Package URL':url(packageId)},'WRITE_CURRENT');
      }
      const targetId=uuid(target.id),summary=JSON.stringify({target_id:targetId,hash:expectedHash}),fields=JSON.stringify(Object.keys(properties));
      if(status==='PREPARED'){
        const writer=[...admission.state.entries].reverse().find(a=>a.phase==='WRITE_'+role);if(!writer)return fail('NATIVE_WRITE_ATTEMPT_UNCONFIRMED');
        const occurred=new Date(Date.parse(target.last_edited_time)).toISOString().slice(0,16)+':00.000Z';
        return update(ledger,{Status:'PREPARED'},{Status:'WRITTEN','Target Ref':url(targetId),'After Observed Summary':summary,'Compared Fields':fields,'date:Written At:start':occurred,'date:Written At:is_datetime':1,'Written Execution Attempt ID':writer.attempt_id},'WRITTEN_'+role);
      }
      refValue(ledger,'Target Ref',targetId);exact(ledger,{'After Observed Summary':summary,'Compared Fields':fields});
      const written=minute(value(ledger,'Written At','date'));if(written<started||written>minute(stamp))return fail('NATIVE_TIMESTAMP_MISMATCH');
      if(index===3&&written<Math.max(...verifiedTimes))return fail('CURRENT_NOT_LAST');
      if(index===4&&written<Math.max(...verifiedTimes))return fail('NATIVE_GATE_CHANGED');
      if(status==='WRITTEN')return update(ledger,{Status:'WRITTEN'},{Status:'VERIFIED','date:Verified At:start':stamp,'date:Verified At:is_datetime':1},'VERIFIED_'+role);
      const verified=minute(value(ledger,'Verified At','date'));if(verified<written||verified>minute(stamp))return fail('NATIVE_TIMESTAMP_MISMATCH');verifiedTimes.push(verified);
      mutations.push({id:uuid(ledger.id),key,operation,target_id:targetId,after_hash:expectedHash,before_hash:beforeHash});
      if(index===0)definitionId=targetId;if(index===1)packageId=targetId;if(index===2)decisionId=targetId;
    }
    if(runStatus==='RUNNING')return update(run,{Status:'RUNNING',...(!orientation?{'Gate After Observed':''}:{})},{Status:'COMPLETED','Recovery Required':'__NO__','Mutation Count':count,'Verified Mutation Count':count,...(!orientation?{'Gate After Observed':'PROVISIONAL_PASS'}:{}),'Decisions Committed':url(decisionId),'Publication Refs':url(packageId),'date:Finished:start':stamp,'date:Finished:is_datetime':1,'date:Last Required Written At:start':stamp,'date:Last Required Written At:is_datetime':1},'CLOSE_RUN');
    return await verifyPublication(reader,s,{proposal_id:planId,run_id:runId,definition_id:definitionId,package_id:packageId,decision_id:decisionId,package_text:intent.package_text,definition_properties:definition,decision_properties:decision,previous_pointer:intent.previous_pointer,gate_before:intent.gate_before,gate_properties:expectedGate,mutations});
  }catch(error){
    const codes=['INCOMPLETE_NATIVE_READ','INVALID_NATIVE_BINDING','NATIVE_REFERENCE_MISMATCH','NATIVE_FIELDS_MISMATCH','NATIVE_SCHEMA_MISMATCH','NATIVE_SCOPE_MISMATCH','NATIVE_TIMESTAMP_MISMATCH','MISSING_NATIVE_PROOF','AMBIGUOUS_NATIVE_PROOF','CURRENT_NOT_LAST','NATIVE_CHANGED_DURING_READ','ORPHAN_NATIVE_TARGET','NATIVE_RUN_HELD','NATIVE_ATTEMPT_UNCONFIRMED','NATIVE_ATTEMPT_BOUND','NATIVE_WRITE_ATTEMPT_UNCONFIRMED','NATIVE_GATE_CHANGED','NATIVE_GATE_HELD','UNEXPECTED_NATIVE_MUTATION'];
    return {status:'UNCONFIRMED',reason:error instanceof Error&&codes.includes(error.message)?error.message:'NATIVE_PROOF_UNAVAILABLE',atomic:false,business_result_verified:false};
  }
}
