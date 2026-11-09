/** Operator-only canonical report persistence. Not an MCP tool or gate confirmer.
 * Inputs must come from the separate deterministic evaluator. This module checks
 * report structure and storage integrity, NOT the truth of supplied evaluations.
 * Local Unix modes do not prove credential separation from the Sales/META agent.
 */
import { z } from 'zod';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { canonicalJson, digestOf, type Canonical } from '../guards/canonical.ts';
import { supportsControlReportVersion } from '../versions/adapters/controlReport.ts';

const invariantNames = ['RUN_RECOVERY','GATE_PROOF','MUTATION_CLEAN','INHERITED_HISTORY','ATTEMPT_IDENTITY','ONE_ACTIVE_ENROLLMENT','HUMAN_TAKEOVER','DNC','VERSION_PIN','PUBLISH_INTEGRITY','EXTERNAL_RECEIPT','CONTROL_REPORT_TAMPER'] as const;
const nativeId = z.string().regex(/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i).transform(v=>v.replaceAll('-','').toLowerCase());
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime({offset:true}).transform(v=>new Date(v).toISOString());
const kindSchema = z.enum(['page','database','data_source','block']);
const refSchema = z.object({kind:kindSchema,id:nativeId}).strict();
const resourceSchema = refSchema.extend({revision:timestamp,projection_hash:hashSchema}).strict();
const resultSchema = z.enum(['PASS','HOLD','VIOLATION','UNKNOWN']);
const reasonSchema = z.enum(['INVARIANT_SATISFIED','INVARIANT_VIOLATED','RECOVERY_REQUIRED','REQUIRED_INPUT_MISSING','UNCONFIRMED_DEPENDENCY','SOURCE_UNAVAILABLE','ARTIFACT_CHAIN_MISMATCH','SCOPE_INCOMPLETE','VERSION_INCOMPATIBLE','MISSING_COMPETENT_SOURCE_RECEIPT']);
const invariantSchema = z.object({name:z.enum(invariantNames),result:resultSchema,reason:reasonSchema,resource_refs:z.array(refSchema).min(1).max(10000)}).strict();
const subjectSchema = z.object({meta_root_id:nativeId,meta_runtime_id:z.string().min(1).max(160),gate_key:z.literal('G11'),gate_page_id:nativeId,run_page_id:nativeId}).strict();
const formatVersionSchema = z.string().refine(supportsControlReportVersion);
const inputSchema = z.object({control_check_id:nativeId,control_version:formatVersionSchema,confirmation_mode:z.literal('ASYNC_PROVISIONAL'),checked_at:timestamp,input_revision:hashSchema,subject:subjectSchema,checked_resources:z.array(resourceSchema).min(1).max(10000),invariants:z.array(invariantSchema).length(12)}).strict();
const countsSchema = z.object({pass:z.number().int().min(0),hold:z.number().int().min(0),violation:z.number().int().min(0),unknown:z.number().int().min(0)}).strict();
const reportSchema = inputSchema.extend({store_id:nativeId,sequence:z.number().int().min(1).max(1024),previous_check_hash:hashSchema.nullable(),result:resultSchema,counts:countsSchema}).strict();
const envelopeSchema = z.object({report:reportSchema,report_sha256:hashSchema}).strict();
const bindingSchema = z.object({root:z.string().min(1),store_id:nativeId,meta_root_id:nativeId,meta_runtime_id:z.string().min(1).max(160)}).strict();
export type ControlReportStoreBinding = z.input<typeof bindingSchema>;
export type ControlReportInput = z.input<typeof inputSchema>;
type Binding = z.output<typeof bindingSchema>;
type Report = z.output<typeof reportSchema>;
type Entry = {report:Report;hash:string;artifact_name:string;artifact_uri:string};
const closedReasons = ['CONTROL_REPORT_INPUT_INVALID','CONTROL_REPORT_STORE_UNAVAILABLE','CONTROL_REPORT_STORE_TAMPERED','CONTROL_REPORT_STORE_CHANGED','CONTROL_REPORT_CHECK_ID_REUSED','CONTROL_REPORT_POSTWRITE_UNCERTAIN'] as const;
type Reason = typeof closedReasons[number];
class StoreError extends Error { readonly reason:Reason; constructor(reason:Reason){super(reason);this.reason=reason;} }
const fail = (reason:Reason):never=>{throw new StoreError(reason);};
const canon = (v:unknown)=>canonicalJson(v as Canonical);
const digest = (v:unknown)=>digestOf(v as Canonical);
const refKey = (v:{kind:string;id:string})=>v.kind+':'+v.id;
const fileName = (n:number)=>String(n).padStart(8,'0')+'.json';
const noAuthority = {control_confirmed:false,custody_verified:false,business_result_verified:false} as const;
function refused(error:unknown){return{status:'UNCONFIRMED',reason:error instanceof StoreError?error.reason:'CONTROL_REPORT_STORE_UNAVAILABLE',...noAuthority};}

function normalizedInput(raw:unknown,b:Binding):z.output<typeof inputSchema>{
  const parsed=inputSchema.safeParse(raw);if(!parsed.success)return fail('CONTROL_REPORT_INPUT_INVALID');const r=parsed.data;
  if(r.subject.meta_root_id!==b.meta_root_id||r.subject.meta_runtime_id!==b.meta_runtime_id)return fail('CONTROL_REPORT_INPUT_INVALID');
  const refs=new Set(r.checked_resources.map(refKey));
  if(refs.size!==r.checked_resources.length||new Set(r.invariants.map(i=>i.name)).size!==12||r.checked_resources.some(p=>Date.parse(p.revision)>Date.parse(r.checked_at)))return fail('CONTROL_REPORT_INPUT_INVALID');
  for(const i of r.invariants){
    if(new Set(i.resource_refs.map(refKey)).size!==i.resource_refs.length||i.resource_refs.some(p=>!refs.has(refKey(p)))||(i.result==='PASS')!==(i.reason==='INVARIANT_SATISFIED'))return fail('CONTROL_REPORT_INPUT_INVALID');
    i.resource_refs.sort((a,c)=>refKey(a).localeCompare(refKey(c)));
  }
  r.checked_resources.sort((a,c)=>refKey(a).localeCompare(refKey(c)));r.invariants.sort((a,c)=>invariantNames.indexOf(a.name)-invariantNames.indexOf(c.name));return r;
}
function makeReport(input:z.output<typeof inputSchema>,b:Binding,sequence:number,previous:string|null):Report{
  const counts={pass:0,hold:0,violation:0,unknown:0};for(const i of input.invariants)counts[i.result.toLowerCase() as keyof typeof counts]++;
  const result=counts.violation?'VIOLATION':counts.unknown?'UNKNOWN':counts.hold?'HOLD':'PASS';
  return{...input,store_id:b.store_id,sequence,previous_check_hash:previous,result,counts};
}
async function privateRoot(b:Binding){
  if(!isAbsolute(b.root)||normalize(b.root)!==b.root||await realpath(b.root)!==b.root)return fail('CONTROL_REPORT_STORE_UNAVAILABLE');
  const s=await lstat(b.root);if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o777)!==0o700||process.getuid&&s.uid!==process.getuid())return fail('CONTROL_REPORT_STORE_UNAVAILABLE');return{dev:s.dev,ino:s.ino};
}
async function readChain(b:Binding):Promise<{reports:Entry[];head_hash:string|null;root_identity:{dev:number;ino:number}}>{
  const identity=await privateRoot(b),files=(await readdir(b.root)).sort();
  if(files.length>1024||files.some((name,i)=>name!==fileName(i+1)))return fail('CONTROL_REPORT_STORE_TAMPERED');
  const reports:Entry[]=[],ids=new Set<string>();let previous:string|null=null;
  for(const [index,name]of files.entries()){
    const path=join(b.root,name),stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||(stat.mode&0o777)!==0o400||stat.size>8*1024*1024)return fail('CONTROL_REPORT_STORE_TAMPERED');
    const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);let bytes:string;
    try{const actual=await fd.stat();if(actual.ino!==stat.ino||actual.dev!==stat.dev||actual.nlink!==1||actual.size!==stat.size)return fail('CONTROL_REPORT_STORE_CHANGED');bytes=await fd.readFile({encoding:'utf8'});const after=await fd.stat();if(after.size!==actual.size||after.mtimeMs!==actual.mtimeMs||after.ctimeMs!==actual.ctimeMs)return fail('CONTROL_REPORT_STORE_CHANGED');}finally{await fd.close();}
    let value:unknown;try{value=JSON.parse(bytes);}catch{return fail('CONTROL_REPORT_STORE_TAMPERED');}
    const parsed=envelopeSchema.safeParse(value);if(!parsed.success)return fail('CONTROL_REPORT_STORE_TAMPERED');const envelope=parsed.data,report=envelope.report;
    const {store_id,sequence,previous_check_hash,result,counts,...input}=report;
    let expected:Report;try{expected=makeReport(normalizedInput(input,b),b,index+1,previous);}catch{return fail('CONTROL_REPORT_STORE_TAMPERED');}
    if(canon(report)!==canon(expected)||store_id!==b.store_id||sequence!==index+1||previous_check_hash!==previous||digest(report)!==envelope.report_sha256||bytes!==canon(envelope)+'\n'||ids.has(report.control_check_id)||reports.length&&Date.parse(report.checked_at)<Date.parse(reports.at(-1)!.report.checked_at))return fail('CONTROL_REPORT_STORE_TAMPERED');
    ids.add(report.control_check_id);previous=envelope.report_sha256;
    reports.push({report,hash:previous,artifact_name:name,artifact_uri:`urn:vertigo:control:${b.store_id}:${name}:${previous}`});
  }
  if(canon(files)!==canon((await readdir(b.root)).sort())||canon(identity)!==canon(await privateRoot(b)))return fail('CONTROL_REPORT_STORE_CHANGED');
  return{reports,head_hash:previous,root_identity:identity};
}

/** Complete bounded cold read. A valid prefix cannot prove that a tail was not
 * deleted: compare with the independently held mirror/head anchor as well. */
export async function readControlReportChain(rawBinding:ControlReportStoreBinding):Promise<any>{
  try{const b=bindingSchema.parse(rawBinding),chain=await readChain(b);return{status:'CONTROL_REPORT_CHAIN_OBSERVED',reports:chain.reports,head_hash:chain.head_hash,...noAuthority};}catch(error){return refused(error);}
}

/** Exclusive creation only. An interrupted/uncertain artifact is retained and
 * stops future appends; no repair, deletion, overwrite or permission reset. */
export async function appendControlReport(rawBinding:ControlReportStoreBinding,rawInput:unknown,expectedPreviousHash:string|null):Promise<any>{
  let created=false;
  try{
    const b=bindingSchema.parse(rawBinding),input=normalizedInput(rawInput,b);
    if(expectedPreviousHash!==null&&!hashSchema.safeParse(expectedPreviousHash).success)return fail('CONTROL_REPORT_INPUT_INVALID');
    const before=await readChain(b);if(before.head_hash!==expectedPreviousHash)return fail('CONTROL_REPORT_STORE_CHANGED');
    if(before.reports.some(p=>p.report.control_check_id===input.control_check_id))return fail('CONTROL_REPORT_CHECK_ID_REUSED');
    if(before.reports.length>=1024)return fail('CONTROL_REPORT_STORE_UNAVAILABLE');
    if(before.reports.length&&Date.parse(input.checked_at)<Date.parse(before.reports.at(-1)!.report.checked_at))return fail('CONTROL_REPORT_INPUT_INVALID');
    const report=makeReport(input,b,before.reports.length+1,before.head_hash),hash=digest(report),name=fileName(report.sequence),bytes=canon({report,report_sha256:hash})+'\n';
    if(Buffer.byteLength(bytes)>8*1024*1024)return fail('CONTROL_REPORT_INPUT_INVALID');
    if(canon(before.root_identity)!==canon(await privateRoot(b)))return fail('CONTROL_REPORT_STORE_CHANGED');
    const fd=await open(join(b.root,name),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);created=true;
    try{await fd.writeFile(bytes,{encoding:'utf8'});await fd.sync();await fd.chmod(0o400);await fd.sync();}finally{await fd.close();}
    const directory=await open(b.root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await directory.sync();}finally{await directory.close();}
    const after=await readChain(b);if(after.head_hash!==hash||after.reports.length!==report.sequence)return fail('CONTROL_REPORT_POSTWRITE_UNCERTAIN');
    return{status:'CONTROL_REPORT_STORED',hash,artifact_name:name,artifact_uri:after.reports.at(-1)!.artifact_uri,sequence:report.sequence,...noAuthority};
  }catch(error){
    if(created)return refused(new StoreError('CONTROL_REPORT_POSTWRITE_UNCERTAIN'));
    if((error as NodeJS.ErrnoException)?.code==='EEXIST')return refused(new StoreError('CONTROL_REPORT_STORE_CHANGED'));
    return refused(error);
  }
}

const mirrorSchema=z.object({control_check_id:nativeId,control_version:formatVersionSchema,scope:subjectSchema,checked_at:timestamp,input_revision:hashSchema,canonical_artifact_uri:z.string().min(1).max(512),canonical_artifact_hash:hashSchema,result:resultSchema,previous_check_hash:hashSchema.nullable(),counts:countsSchema});
/** Read actual canonical artifacts; never trust a Notion MATCH assertion.
 * Caller must establish completeness and ownership of native mirror reads. */
export async function verifyControlReportMirrors(rawBinding:ControlReportStoreBinding,rawMirrors:unknown):Promise<any>{
  const chain=await readControlReportChain(rawBinding);if(chain.status!=='CONTROL_REPORT_CHAIN_OBSERVED')return{...chain,invariant_result:chain.reason==='CONTROL_REPORT_STORE_TAMPERED'?'VIOLATION':'UNKNOWN'};
  const parsed=z.array(mirrorSchema).max(1024).safeParse(rawMirrors);
  const mismatch=()=>({status:'VIOLATION',reason:'CONTROL_REPORT_MIRROR_MISMATCH',...noAuthority});
  if(!parsed.success||parsed.data.length!==chain.reports.length||new Set(parsed.data.map(m=>m.control_check_id)).size!==parsed.data.length)return mismatch();
  for(const entry of chain.reports as Entry[]){
    const r=entry.report,m=parsed.data.find(v=>v.control_check_id===r.control_check_id);
    const expected={control_check_id:r.control_check_id,control_version:r.control_version,scope:r.subject,checked_at:r.checked_at,input_revision:r.input_revision,canonical_artifact_uri:entry.artifact_uri,canonical_artifact_hash:entry.hash,result:r.result,previous_check_hash:r.previous_check_hash,counts:r.counts};
    if(!m||canon(m)!==canon(expected))return mismatch();
  }
  return{status:'MATCH',reports:chain.reports.length,head_hash:chain.head_hash,...noAuthority};
}
