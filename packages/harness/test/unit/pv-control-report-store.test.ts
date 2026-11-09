import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readdir, readFile, writeFile, chmod, mkdir, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { supportedControlReportVersions } from '../../src/versions/adapters/controlReport.ts';

// Boundary under test is real filesystem I/O, hashing and validation. These are
// synthetic evaluator outputs, not a claim that any live invariant has passed.
const names = ['RUN_RECOVERY','GATE_PROOF','MUTATION_CLEAN','INHERITED_HISTORY','ATTEMPT_IDENTITY','ONE_ACTIVE_ENROLLMENT','HUMAN_TAKEOVER','DNC','VERSION_PIN','PUBLISH_INTEGRITY','EXTERNAL_RECEIPT','CONTROL_REPORT_TAMPER'];
const id = (n: number) => n.toString(16).padStart(32,'0');
const time = '2026-10-16T17:30:00.000Z';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
async function fixture(t: any) {
  const root = await realpath(await mkdtemp(join(tmpdir(),'vertigo-control-chain-')));
  await chmod(root,0o700); t.after(() => rm(root,{recursive:true,force:true}));
  const binding = { root, store_id:id(1), meta_root_id:id(2), meta_runtime_id:'META-TEST' };
  const input = (n = 1): any => ({ control_check_id:id(100+n),control_version:supportedControlReportVersions()[0],confirmation_mode:'ASYNC_PROVISIONAL',checked_at:time,input_revision:hash('observed-input-'+n),subject:{meta_root_id:id(2),meta_runtime_id:'META-TEST',gate_key:'G11',gate_page_id:id(3),run_page_id:id(4)},checked_resources:[{kind:'page',id:id(3),revision:'2026-10-16T17:29:00.000Z',projection_hash:hash('gate')}],invariants:names.map(name=>({name,result:'PASS',reason:'INVARIANT_SATISFIED',resource_refs:[{kind:'page',id:id(3)}]})) });
  const module = await import(new URL('../../src/verify/controlReportStore.ts',import.meta.url).href).catch((e:any)=>{if(e.code==='ERR_MODULE_NOT_FOUND')return null;throw e;});
  const api = module ?? {appendControlReport:async()=>({status:'NOT_IMPLEMENTED'}),readControlReportChain:async()=>({status:'NOT_IMPLEMENTED'}),verifyControlReportMirrors:async()=>({status:'NOT_IMPLEMENTED'})};
  const append = (raw = input(), previous: string|null = null) => api.appendControlReport(binding,raw,previous);
  const mirror = (entry: any) => ({control_check_id:entry.report.control_check_id,control_version:entry.report.control_version,scope:entry.report.subject,checked_at:entry.report.checked_at,input_revision:entry.report.input_revision,canonical_artifact_uri:entry.artifact_uri,canonical_artifact_hash:entry.hash,result:entry.report.result,previous_check_hash:entry.report.previous_check_hash,counts:entry.report.counts});
  return {root,binding,input,api,append,mirror};
}

test('canonical report append and cold read preserve all twelve results without granting gate authority',async t=>{
  // Break caught: a write acknowledgement or self-labelled result is used as
  // confirmation without a canonical readback or independent custody proof.
  const f=await fixture(t),saved=await f.append();assert.equal(saved.status,'CONTROL_REPORT_STORED');assert.equal(saved.control_confirmed,false);assert.equal(saved.custody_verified,false);
  const chain=await f.api.readControlReportChain(f.binding);assert.equal(chain.status,'CONTROL_REPORT_CHAIN_OBSERVED');assert.equal(chain.reports.length,1);assert.equal(chain.reports[0].report.sequence,1);assert.equal(chain.reports[0].report.previous_check_hash,null);assert.equal(chain.reports[0].report.invariants.length,12);assert.deepEqual(chain.reports[0].report.counts,{pass:12,hold:0,violation:0,unknown:0});assert.equal(chain.head_hash,saved.hash);
  const envelope=JSON.parse(await readFile(join(f.root,saved.artifact_name),'utf8'));assert.equal(envelope.report_sha256,saved.hash);assert.equal(saved.hash,hash((await import('../../src/guards/canonical.ts')).canonicalJson(envelope.report)));
});
test('report format registry stays single-capability and unknown versions fail before writing',async t=>{
  assert.equal(supportedControlReportVersions().length,1);
  for(const version of ['TEST_CONTROL/999','',supportedControlReportVersions()[0]+'-candidate']){
    const f=await fixture(t),raw=f.input();raw.control_version=version;
    assert.equal((await f.append(raw)).reason,'CONTROL_REPORT_INPUT_INVALID');assert.deepEqual(await readdir(f.root),[]);
  }
});
test('canonical append requires every invariant once rather than promoting a missing result',async t=>{
  for(const change of[(r:any)=>r.invariants.pop(),(r:any)=>r.invariants[11]=structuredClone(r.invariants[0]),(r:any)=>r.invariants[0].result='NOT_APPLICABLE',(r:any)=>r.invariants[0].resource_refs=[],(r:any)=>r.invariants[0].reason='SOURCE_UNAVAILABLE'])await t.test('incomplete evaluator output',async tt=>{const f=await fixture(tt),r=f.input();change(r);const result=await f.append(r);assert.equal(result.status,'UNCONFIRMED');assert.equal(result.reason,'CONTROL_REPORT_INPUT_INVALID');assert.deepEqual(await readdir(f.root),[]);});
});
test('canonical result is computed from all results and cannot be overridden by caller counters',async t=>{
  const f=await fixture(t),r=f.input();r.invariants[0].result='HOLD';r.invariants[0].reason='RECOVERY_REQUIRED';r.invariants[1].result='UNKNOWN';r.invariants[1].reason='REQUIRED_INPUT_MISSING';r.invariants[2].result='VIOLATION';r.invariants[2].reason='INVARIANT_VIOLATED';
  const saved=await f.append(r);assert.equal(saved.status,'CONTROL_REPORT_STORED');const chain=await f.api.readControlReportChain(f.binding);assert.equal(chain.reports[0].report.result,'VIOLATION');assert.deepEqual(chain.reports[0].report.counts,{pass:9,hold:1,violation:1,unknown:1});
  const forged=f.input(2);forged.result='PASS';forged.counts={pass:12};assert.equal((await f.append(forged,saved.hash)).reason,'CONTROL_REPORT_INPUT_INVALID');
});
test('report refuses foreign scope, absent observed evidence and post-check revisions before writing',async t=>{
  for(const change of[(r:any)=>r.subject.meta_runtime_id='SALES-OTHER',(r:any)=>r.subject.meta_root_id=id(99),(r:any)=>r.invariants[0].resource_refs[0].id=id(99),(r:any)=>r.checked_resources[0].revision='2026-10-16T17:31:00Z',(r:any)=>r.checked_resources.push(structuredClone(r.checked_resources[0]))])await t.test('invalid scope or freshness',async tt=>{const f=await fixture(tt),r=f.input();change(r);assert.equal((await f.append(r)).status,'UNCONFIRMED');assert.deepEqual(await readdir(f.root),[]);});
});
test('report field order does not change the canonical bytes while selected evidence does',async t=>{
  const a=await fixture(t),b=await fixture(t),c=await fixture(t),r=b.input();r.invariants.reverse();r.subject=Object.fromEntries(Object.entries(r.subject).reverse());
  const first=await a.append(),second=await b.append(r),changed=c.input();changed.checked_resources[0].projection_hash=hash('different evidence');const third=await c.append(changed);
  assert.equal(first.status,'CONTROL_REPORT_STORED');assert.equal(first.hash,second.hash);assert.notEqual(first.hash,third.hash);
});
test('subsequent report links actual previous hash, preserves bytes and survives a cold restart',async t=>{
  const f=await fixture(t),first=await f.append();assert.equal(first.status,'CONTROL_REPORT_STORED');const before=await readFile(join(f.root,first.artifact_name));
  const second=await f.append(f.input(2),first.hash);assert.equal(second.status,'CONTROL_REPORT_STORED');assert.deepEqual(await readFile(join(f.root,first.artifact_name)),before);
  const chain=await f.api.readControlReportChain(structuredClone(f.binding));assert.equal(chain.reports.length,2);assert.equal(chain.reports[1].report.sequence,2);assert.equal(chain.reports[1].report.previous_check_hash,first.hash);assert.equal(chain.head_hash,second.hash);
});
test('genesis null is refused on a nonempty store and repeated check IDs do not add another artifact',async t=>{
  const f=await fixture(t),first=await f.append();assert.equal(first.status,'CONTROL_REPORT_STORED');
  assert.equal((await f.append(f.input(2))).reason,'CONTROL_REPORT_STORE_CHANGED');assert.equal((await f.append(f.input(),first.hash)).reason,'CONTROL_REPORT_CHECK_ID_REUSED');assert.equal((await readdir(f.root)).length,1);
});
test('concurrent appends from one previous hash have one winner, never an overwrite',async t=>{
  const f=await fixture(t),a=f.input(),b=f.input(2),results=await Promise.all([f.append(a),f.append(b)]);assert.equal(results.filter((r:any)=>r.status==='CONTROL_REPORT_STORED').length,1);assert.equal(results.filter((r:any)=>r.status==='UNCONFIRMED').length,1);
  const chain=await f.api.readControlReportChain(f.binding);assert.equal(chain.status,'CONTROL_REPORT_CHAIN_OBSERVED');assert.equal(chain.reports.length,1);assert.ok([a.control_check_id,b.control_check_id].includes(chain.reports[0].report.control_check_id));
});
test('readback detects modified bytes and never repairs or erases the historical artifact',async t=>{
  const f=await fixture(t),saved=await f.append();assert.equal(saved.status,'CONTROL_REPORT_STORED');const path=join(f.root,saved.artifact_name);await chmod(path,0o600);const raw=JSON.parse(await readFile(path,'utf8'));raw.report.input_revision=hash('tampered');await writeFile(path,JSON.stringify(raw));await chmod(path,0o400);
  const before=await readFile(path),read=await f.api.readControlReportChain(f.binding);assert.equal(read.status,'UNCONFIRMED');assert.equal(read.reason,'CONTROL_REPORT_STORE_TAMPERED');assert.equal((await f.append(f.input(2),saved.hash)).status,'UNCONFIRMED');assert.deepEqual(await readFile(path),before);
});
test('readback refuses truncated artifact, unexpected entries and a deleted chain predecessor',async t=>{
  for(const kind of['truncated','extra','gap'])await t.test(kind,async tt=>{const f=await fixture(tt),first=await f.append();assert.equal(first.status,'CONTROL_REPORT_STORED');
    if(kind==='truncated'){await chmod(join(f.root,first.artifact_name),0o600);await writeFile(join(f.root,first.artifact_name),'{');await chmod(join(f.root,first.artifact_name),0o400);}
    if(kind==='extra')await writeFile(join(f.root,'unrecognized.json'),'{}',{mode:0o400});
    if(kind==='gap'){assert.equal((await f.append(f.input(2),first.hash)).status,'CONTROL_REPORT_STORED');await rm(join(f.root,first.artifact_name));}
    assert.equal((await f.api.readControlReportChain(f.binding)).reason,'CONTROL_REPORT_STORE_TAMPERED');
  });
});
test('store refuses symlink roots, symlink artifacts and hard-linked artifacts',async t=>{
  for(const kind of['root','artifact','hardlink'])await t.test(kind,async tt=>{const f=await fixture(tt),outside=join(f.root,'outside');await mkdir(outside,{mode:0o700});
    if(kind==='root'){const alias=join(f.root,'alias');await symlink(outside,alias);const b={...f.binding,root:alias};assert.equal((await f.api.appendControlReport(b,f.input(),null)).status,'UNCONFIRMED');assert.deepEqual(await readdir(outside),[]);}
    else {const inner={...f.binding,root:outside},first=await f.api.appendControlReport(inner,f.input(),null);assert.equal(first.status,'CONTROL_REPORT_STORED');const path=join(outside,first.artifact_name),target=join(f.root,'target');if(kind==='artifact'){await rm(path);await writeFile(target,'{}',{mode:0o400});await symlink(target,path);}else await link(path,target);assert.equal((await f.api.readControlReportChain(inner)).status,'UNCONFIRMED');}
  });
});
test('store must already be private and bound to one META identity; it is not silently created or re-permissioned',async t=>{
  const f=await fixture(t);await chmod(f.root,0o755);assert.equal((await f.append()).status,'UNCONFIRMED');assert.deepEqual(await readdir(f.root),[]);await chmod(f.root,0o700);
  const missing={...f.binding,root:join(f.root,'not-created')};assert.equal((await f.api.appendControlReport(missing,f.input(),null)).status,'UNCONFIRMED');assert.deepEqual(await readdir(f.root),[]);
  const saved=await f.append();assert.equal(saved.status,'CONTROL_REPORT_STORED');const alien={...f.binding,store_id:id(99)};assert.equal((await f.api.readControlReportChain(alien)).status,'UNCONFIRMED');
});
test('mirror comparison recomputes identity/hash/chain and ignores a self-labelled MATCH as proof',async t=>{
  const f=await fixture(t),saved=await f.append();assert.equal(saved.status,'CONTROL_REPORT_STORED');const chain=await f.api.readControlReportChain(f.binding),mirror=f.mirror(chain.reports[0]);
  const match=await f.api.verifyControlReportMirrors(f.binding,[mirror]);assert.equal(match.status,'MATCH');assert.equal(match.control_confirmed,false);assert.equal(match.custody_verified,false);
  assert.equal((await f.api.verifyControlReportMirrors(f.binding,[{...mirror,mirror_integrity_status:'MATCH',canonical_artifact_hash:hash('false')}])).status,'VIOLATION');
});
test('mirror comparison refuses missing, duplicate, stale or foreign report links',async t=>{
  const f=await fixture(t),saved=await f.append();assert.equal(saved.status,'CONTROL_REPORT_STORED');const first=(await f.api.readControlReportChain(f.binding)).reports[0],mirror=f.mirror(first);
  for(const rows of[[],[mirror,mirror],[{...mirror,control_check_id:id(99)}],[{...mirror,checked_at:'2026-10-16T17:29:00Z'}],[{...mirror,previous_check_hash:hash('wrong')}],[{...mirror,result:'UNKNOWN'}]])assert.equal((await f.api.verifyControlReportMirrors(f.binding,rows)).status,'VIOLATION');
  assert.equal((await f.append(f.input(2),saved.hash)).status,'CONTROL_REPORT_STORED');assert.equal((await f.api.verifyControlReportMirrors(f.binding,[mirror])).status,'VIOLATION');
  const full=await f.api.readControlReportChain(f.binding);assert.equal((await f.api.verifyControlReportMirrors(f.binding,full.reports.map(f.mirror))).status,'MATCH');
});
test('unavailable store and malformed inputs return closed diagnostics without keys or free-form data',async t=>{
  const f=await fixture(t),bad=f.input();bad.untrusted='SECRET_PRIVATE_EMAIL_BODY';const result=await f.append(bad);assert.equal(result.status,'UNCONFIRMED');assert.equal(result.reason,'CONTROL_REPORT_INPUT_INVALID');assert.ok(!JSON.stringify(result).includes('SECRET'));assert.equal(result.report,undefined);
});
test('mirror with valid hash but altered transition scope cannot confirm another gate or Run',async t=>{
  // Break caught: accepting only the hash while ignoring the mirrored scope
  // makes an authentic report appear to cover an unrelated transition.
  const f=await fixture(t),saved=await f.append();assert.equal(saved.status,'CONTROL_REPORT_STORED');const entry=(await f.api.readControlReportChain(f.binding)).reports[0],mirror=f.mirror(entry);
  for(const field of['meta_root_id','meta_runtime_id','gate_page_id','run_page_id']){const changed=structuredClone(mirror);changed.scope[field]=field==='meta_runtime_id'?'OTHER-RUNTIME':id(99);assert.equal((await f.api.verifyControlReportMirrors(f.binding,[changed])).status,'VIOLATION');}
});
test('tail deletion is caught against the external mirror anchor even when the remaining prefix is valid',async t=>{
  const f=await fixture(t),first=await f.append();assert.equal(first.status,'CONTROL_REPORT_STORED');const second=await f.append(f.input(2),first.hash);assert.equal(second.status,'CONTROL_REPORT_STORED');const before=await f.api.readControlReportChain(f.binding),mirrors=before.reports.map(f.mirror);await rm(join(f.root,second.artifact_name));
  assert.equal((await f.api.readControlReportChain(f.binding)).status,'CONTROL_REPORT_CHAIN_OBSERVED');assert.equal((await f.api.verifyControlReportMirrors(f.binding,mirrors)).status,'VIOLATION');assert.equal((await f.append(f.input(3),second.hash)).reason,'CONTROL_REPORT_STORE_CHANGED');
});
test('rehashing a structurally forged PASS counter does not bypass deterministic report readback',async t=>{
  const f=await fixture(t),r=f.input();r.invariants[0].result='UNKNOWN';r.invariants[0].reason='REQUIRED_INPUT_MISSING';const saved=await f.append(r);assert.equal(saved.status,'CONTROL_REPORT_STORED');const path=join(f.root,saved.artifact_name),raw=JSON.parse(await readFile(path,'utf8')),canonical=(await import('../../src/guards/canonical.ts')).canonicalJson;
  raw.report.result='PASS';raw.report.counts={pass:12,hold:0,violation:0,unknown:0};raw.report_sha256=hash(canonical(raw.report));await chmod(path,0o600);await writeFile(path,canonical(raw)+'\n');await chmod(path,0o400);assert.equal((await f.api.readControlReportChain(f.binding)).reason,'CONTROL_REPORT_STORE_TAMPERED');
});
