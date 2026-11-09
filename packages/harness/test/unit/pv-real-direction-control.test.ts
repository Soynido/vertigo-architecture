import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { InMemoryPrincipalRegistry } from '../../src/auth/principal.ts';
import { InMemorySalesRuntimeRegistry } from '../../src/registry/salesRuntimes.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, buildDeps } from '../../src/index.ts';
import { buildResumeWorld,R } from './resume-fixtures.ts';
import {specRootChildren,V as metaV,ID as META_ID} from './meta-fixtures.ts';
import {dispatch} from '../../src/tools/handlers.ts';
import {handleOf,OWNER,T0} from './binding-fixtures.ts';
import { NativeNoteControl } from '../../src/verify/nativeNoteControl.ts';
import { NativeSalesControl } from '../../src/verify/nativeSalesControl.ts';
import {fixture,prop} from './real-direction-publication-fixtures.ts';
const id = (n: number) => n.toString(16).padStart(32, '0'), stamp = '2026-10-16T08:00:00.000Z';
const direction = { title: 'Cap personnel', objective: 'Préserver les règles locales et préparer la prochaine action utile.', horizon: { start: '2026-10-16', end: '2026-10-23' }, recommendations: ['Adapter le Daily GO à la capacité réellement disponible.'], constraints: ['Aucun nouvel envoi ni droit.'] };

// Break: an opt-in file being ignored, or wrong real roots silently replacing the existing seller route.
test('real direction buildDeps only enables the exact already configured META and seller profiles', async t => {
    const r = await rig(t), dir = join(r.profile.journal_file, '..');
    const note = { principal_id: 'owner', runtime_id: 'PRIVATE_TEST', runtime_generation: '1', page_id: id(90), marker: 'NOTE', section: 'Note de test', note_key: 'NOTE-1', initial_text: 'Before', journal_file: r.profile.journal_file + '.note', receipt_secret: 'b'.repeat(64) };
    const meta = { kind: 'REAL_META_PROFILE/1', principal_id: 'owner', project: 'VERTIGO', runtime_id: 'META1', runtime_generation: '1', root_page_id: id(1), manifest_page_id: id(91), manifest_data_source_id: id(92), person_page_id: id(93), people_data_source_id: id(94), notion_user_id: id(95), person_key: 'OWNER', receipt_secret: 'c'.repeat(64) };
    const seller = (r: any, base: number) => ({ kind: 'REAL_SALES_NATIVE/1', principal_id: r.principal_id, project: 'VERTIGO', rep_identity_key: r.rep_identity_key, runtime_id: r.runtime_id, expected_gmail_identity: r.mailbox, root_page_id: r.root_page_id, manifest_page_id: id(base), manifest_data_source_id: id(base + 1), state_page_id: id(base + 2), state_data_source_id: id(base + 3), runs_data_source_id: id(base + 4), receipts_data_source_id: r.receipts_source_id });
    for (const [name, value] of Object.entries({ note, meta, primary: seller(r.profile.recipients[0], 31), added: [seller(r.profile.recipients[1], 41)], real: r.profile })) await writeFile(join(dir, name + '.json'), JSON.stringify(value), { mode: 0o600 });
    const env = { HARNESS_ENV: 'fixture', VERTIGO_META_SPEC_ROOT: id(1), PRINCIPALS_FILE: join(dir, 'principals.json'), HARNESS_NATIVE_NOTE_PILOT_FILE: join(dir, 'note.json'), HARNESS_NATIVE_META_PROFILE_FILE: join(dir, 'meta.json'), HARNESS_NATIVE_SALES_PROFILE_FILE: join(dir, 'primary.json'), HARNESS_NATIVE_SALES_ADDITIONAL_PROFILES_FILE: join(dir, 'added.json'), HARNESS_NATIVE_REAL_DIRECTION_PROFILE_FILE: join(dir, 'real.json') };
    const ready = buildDeps(env) as any; assert.ok(ready.realDirectionControl); assert.ok(ready.nativeSalesControl); assert.equal(ready.nativeSalesControls.length, 1);
    await writeFile(join(dir, 'real.json'), JSON.stringify({ ...r.profile, meta_root_id: id(99) }));
    const mismatch = buildDeps(env) as any; assert.equal(mismatch.realDirectionControl, undefined); assert.ok(mismatch.nativeSalesControl); assert.equal(mismatch.nativeSalesControls.length, 1);
    const missing = buildDeps({ ...env, HARNESS_NATIVE_REAL_DIRECTION_PROFILE_FILE: '' }) as any; assert.equal(missing.realDirectionControl, undefined); assert.ok(missing.nativeSalesControl);
});

// Break: real direction being unreachable through the actual owner/seller MCP routes.
test('real direction MCP owner to seller to manager loop preserves the local OS and cold replay', async t => {
    const r = await rig(t), base = buildResumeWorld().deps;
    const rich = (s: string) => ({ type: 'rich_text', rich_text: [{ type: 'text', plain_text: s, text: { content: s } }] });
    const local = { object: 'page', id: id(70), archived: false, in_trash: false, last_edited_time: stamp, parent: { type: 'page_id', page_id: id(3) }, properties: { Method: rich('Email first, fit score, no colleague quota') } };
    r.rows.set(id(70), local);
    r.rows.set(id(31), { ...r.manifests.get(id(31)),properties:{...r.manifests.get(id(31)).properties,'Instance ID': rich('SALES-C'), 'Gmail Identity': { type: 'email', email: 'sellerA@example.test' }, 'Root URL': { type: 'url', url: 'https://app.notion.com/p/' + id(3) }} });
    r.rows.set(id(33), { object: 'page', id: id(33), archived: false, in_trash: false, last_edited_time: stamp, parent: { type: 'data_source_id', data_source_id: id(34) }, properties: { 'Current Gate': { type: 'select', select: { name: 'B7_DRY_RUN' } }, 'Run Mode': { type: 'select', select: { name: 'LEARN' } } } });
    const originalDS = r.reader.retrieveDataSource, originalDB = r.reader.retrieveDatabase;
    r.reader.retrieveDataSource = async (ds: string) => [id(32), id(34), id(36)].includes(ds) ? { ...await originalDS(ds), parent: { type: 'database_id', database_id: id(37) } } : originalDS(ds);
    r.reader.retrieveDatabase = async (db: string) => db === id(37) ? { object: 'database', id: db, parent: { type: 'page_id', page_id: id(3) } } : originalDB(db);
    const note = new NativeNoteControl({ principal_id: 'owner', runtime_id: 'PRIVATE_TEST', runtime_generation: '1', page_id: id(90), marker: 'NOTE', section: 'Note de test', note_key: 'NOTE-1', initial_text: 'Before', journal_file: r.profile.journal_file + '.note', receipt_secret: 'b'.repeat(64) }, r.reader, r.principals);
    const seller = new NativeSalesControl({ kind: 'REAL_SALES_NATIVE/1', principal_id: 'sellerA', project: 'VERTIGO', rep_identity_key: 'REP-C', runtime_id: 'SALES-C', expected_gmail_identity: 'sellerA@example.test', root_page_id: id(3), manifest_page_id: id(31), manifest_data_source_id: id(32), state_page_id: id(33), state_data_source_id: id(34), runs_data_source_id: id(36), receipts_data_source_id: id(4) }, r.reader, r.principals, r.registry);
    const clients: Client[] = [], servers: ReturnType<typeof createServer>[] = [];
    t.after(async () => { await Promise.all(clients.map(c => c.close())); await Promise.all(servers.map(s => s.close())); });
    const connect = async (identity: string) => {
        const server = createServer({ ...base, nativeNotePilot: note, nativeSalesControl: seller, realDirectionControl: r.make() } as any, identity), client = new Client({ name: 'real-direction-loop', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();
        clients.push(client); servers.push(server); await server.connect(st); await client.connect(ct); return client;
    };
    const invoke = async (client: Client, name: string, args: any) => { const result = await client.callTool({ name, arguments: args }); return JSON.parse((result.content as any)[0].text); };
    const owner = await connect('owner');
    assert.ok((await owner.listTools()).tools.some(tool => tool.name === 'vertigo_direction_control'));
    const draft = await invoke(owner, 'vertigo_direction_control', { action: 'PREPARE', recipient: 'REP_A', request_key: 'mcp-one', direction });
    assert.equal(draft.status, 'DRAFT');
    const approved = await invoke(owner, 'vertigo_direction_control', { action: 'APPROVE', proposal_id: draft.proposal_id, approval_hash: draft.approval_hash, confirmation: 'Je valide' });
    assert.equal(approved.status, 'APPROVED_PENDING_NOTION');
    assert.equal((await r.finish(draft.proposal_id,approved,(args:any)=>invoke(owner,'vertigo_direction_control',args))).status,'PUBLISHED');
    const sellerA = await connect('sellerA'), context = await invoke(sellerA, 'vertigo_sales_control', { action: 'CONTEXT' });
    assert.equal(context.status, 'OBSERVED'); assert.equal(context.direction.status, 'PUBLISHED_DIRECTION'); assert.equal(context.direction.direction.title, 'Cap personnel');
    const pending = await invoke(sellerA, 'vertigo_direction_control', { action: 'CONSUME' });
    assert.equal(pending.status, 'CONSUMPTION_PENDING_NOTION'); assert.equal(pending.writes[0].data_source_id, id(4)); r.apply(pending.writes[0]);
    assert.equal((await invoke(sellerA, 'vertigo_direction_control', { action: 'VERIFY_CONSUMPTION' })).status, 'CONSUMED');
    const coldOwner = await connect('owner'), status = await invoke(coldOwner, 'vertigo_direction_control', { action: 'STATUS' });
    assert.equal(status.recipients.find((x: any) => x.key === 'REP_A').consumed_version, 1);
    assert.equal(status.recipients.find((x: any) => x.key === 'REP_B').published_version, null);
    assert.deepEqual(r.rows.get(id(70)), local);
    const originalLookup=r.registry.lookup.bind(r.registry);
    r.registry.lookup=async key=>{const p=await originalLookup(key);return p?{...p,pointer_generation:'2'}:p;};
    const localRefusal=await invoke(sellerA,'vertigo_sales_control',{action:'CONTEXT'});
    assert.equal(localRefusal.status,'OBSERVED');assert.equal(localRefusal.direction.status,'ACCESS_DENIED');assert.equal(localRefusal.context.mailbox,'sellera@example.test');
    r.registry.lookup=originalLookup;
    const originalRun=seller.run.bind(seller),originalGet=r.principals.get.bind(r.principals);
    seller.run=async(...args)=>{const result=await originalRun(...args);r.principals.get=async key=>{const p=await originalGet(key);return p&&key==='sellerA'?{...p,status:'REVOKED'}:p;};return result;};
    const revoked=await invoke(sellerA,'vertigo_sales_control',{action:'CONTEXT'});assert.equal(revoked.status,'ACCESS_DENIED');assert.equal(revoked.context,undefined);
    seller.run=originalRun;r.principals.get=originalGet;
    const outsider = await connect('rep-b'); assert.deepEqual((await outsider.listTools()).tools.map(x => x.name).sort(), ['os_bind', 'os_commit', 'os_control_status', 'os_handoff', 'os_resume']);
});
// Break: STATUS exposes only a count, making an already approved cold resume depend on private chat memory.
test('real direction cold owner status supplies the exact approved proposal without mutating or approving it again', async t => {
    const r=await rig(t),draft=await r.control.run('owner',{action:'PREPARE',recipient:'REP_A',request_key:'cold-owned',direction});
    await r.control.run('owner',{action:'APPROVE',proposal_id:draft.proposal_id,approval_hash:draft.approval_hash,confirmation:'oui'});
    const journalBefore=await readFile(r.profile.journal_file,'utf8');
    const status=await r.make().run('owner',{action:'STATUS'}),row=status.recipients.find((x:any)=>x.key==='REP_A');
    assert.equal(row.pending_coverage,'COMPLETE');assert.equal(row.pending.length,1);
    assert.equal(row.pending[0].proposal_id,draft.proposal_id);assert.equal(row.pending[0].status,'APPROVED_PENDING_NOTION');
    assert.equal(row.pending[0].approval_required,false);assert.equal(row.pending[0].can_resume,true);assert.deepEqual(row.pending[0].direction,direction);
    assert.equal(row.pending[0].writes,undefined);assert.equal(await readFile(r.profile.journal_file,'utf8'),journalBefore);assert.equal(r.rows.size,0);
    const resumed=await r.make().run('owner',{action:'VERIFY',proposal_id:row.pending[0].proposal_id});
    assert.equal(resumed.status,'APPROVED_PENDING_NOTION');assert.equal(resumed.approval_required,false);r.apply(resumed.writes[0]);
    assert.equal((await r.finish(row.pending[0].proposal_id)).status,'PUBLISHED');
});
// Break: a durable DRAFT being presented as approved by a fresh session.
test('real direction cold status preserves exact draft approval requirements and never leaks drafts to sellers', async t => {
    const r=await rig(t),draft=await r.control.run('owner',{action:'PREPARE',recipient:'REP_A',request_key:'cold-draft',direction});
    const row=(await r.make().run('owner',{action:'STATUS'})).recipients.find((x:any)=>x.key==='REP_A');
    assert.ok(Array.isArray(row.pending),'fresh status must expose pending proposals');assert.equal(row.pending[0].status,'DRAFT');assert.equal(row.pending[0].approval_required,true);assert.equal(row.pending[0].approval_hash,draft.approval_hash);
    assert.equal(row.pending[0].can_resume,false);assert.equal((await r.make().run('owner',{action:'VERIFY',proposal_id:row.pending[0].proposal_id})).status,'APPROVAL_REQUIRED');
    const seller=await r.make().run('sellerA',{action:'CONTEXT'});assert.equal(seller.status,'NO_PUBLISHED_DIRECTION');assert.equal(seller.pending,undefined);
});
// Break: an old approved base advertised as safe to resume after another version has won.
test('real direction pending status labels superseded base proposals nonresumable without losing history', async t => {
    const r=await rig(t),draft=await r.control.run('owner',{action:'PREPARE',recipient:'REP_A',request_key:'losing-base',direction});
    await r.control.run('owner',{action:'APPROVE',proposal_id:draft.proposal_id,approval_hash:draft.approval_hash,confirmation:'oui'});
    await publish(r,'REP_A',{...direction,title:'Version gagnante'});
    const row=(await r.make().run('owner',{action:'STATUS'})).recipients.find((x:any)=>x.key==='REP_A');
    assert.equal(row.published_version,1);assert.ok(Array.isArray(row.pending),'fresh status must expose pending proposals');assert.equal(row.pending[0].proposal_id,draft.proposal_id);assert.equal(row.pending[0].status,'STALE_PROPOSAL');assert.equal(row.pending[0].can_resume,false);
    assert.equal((await r.make().run('owner',{action:'VERIFY',proposal_id:draft.proposal_id})).status,'STALE_PROPOSAL');assert.equal(r.rows.size,1);
});
// Break: old-assignment draft content exposed as current after recipient generation rotation.
test('real direction pending status suppresses rotated assignment payloads locally', async t => {
    const r=await rig(t);await r.control.run('owner',{action:'PREPARE',recipient:'REP_A',request_key:'old-assignment',direction});
    r.profile.recipients[0]!.generation='2';const lookup=r.registry.lookup.bind(r.registry);r.registry.lookup=async key=>{const a=await lookup(key);return a&&key==='REP-C'?{...a,pointer_generation:'2'}:a;};
    const status=await r.make().run('owner',{action:'STATUS'}),row=status.recipients.find((x:any)=>x.key==='REP_A');
    assert.equal(row.status,'UNCONFIRMED');assert.equal(row.reason,'RECIPIENT_ASSIGNMENT_CHANGED');assert.equal(row.pending,undefined);
    assert.equal(status.recipients.find((x:any)=>x.key==='REP_B').status,'NO_PUBLISHED_DIRECTION');
});
// Break: a bounded pending window silently claimed exhaustive or automatic selection of one among several.
test('real direction pending window reports partial coverage above five proposals', async t => {
    const r=await rig(t);for(let i=0;i<6;i++)await r.control.run('owner',{action:'PREPARE',recipient:'REP_A',request_key:'bounded-'+i,direction:{...direction,title:'Proposition '+i}});
    const row=(await r.make().run('owner',{action:'STATUS'})).recipients.find((x:any)=>x.key==='REP_A');
    assert.equal(row.pending_proposals,6);assert.ok(Array.isArray(row.pending),'fresh status must expose a bounded pending window');assert.equal(row.pending.length,5);assert.equal(row.pending_coverage,'PARTIAL');
    assert.deepEqual(row.pending.map((p:any)=>p.direction.title),['Proposition 1','Proposition 2','Proposition 3','Proposition 4','Proposition 5']);assert.equal(r.rows.size,0);
});
// Break: slow network proof holding the cross-instance journal lock and denying
// unrelated read-only sessions; no mocked lock or filesystem implementation.
for(const action of ['STATUS','CONTEXT'] as const)test('real direction '+action+' network proof does not exclude another reader',async t=>{
  const r=await rig(t);await publish(r);const packageId=[...r.bodies.keys()].find(k=>k!==id(85))!;
  let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve),read=r.reader.retrieveBlockChildren;let held=false;
  r.reader.retrieveBlockChildren=async(ref:string)=>{if(ref===packageId&&!held){held=true;entered();await gate;}return read(ref);};
  const slow=r.make().run(action==='STATUS'?'owner':'sellerA',{action});await started;
  const fast=r.make().run('sellerB',{action:'CONTEXT'});let timer:ReturnType<typeof setTimeout>|undefined;
  try{const result:any=await Promise.race([fast,new Promise(resolve=>timer=setTimeout(()=>resolve({status:'BLOCKED_BY_READER'}),250))]);assert.equal(result.status,'NO_PUBLISHED_DIRECTION');}
  finally{if(timer)clearTimeout(timer);release();await slow;await fast;}
});
// Break: an unlocked reader returning a snapshot after a concurrent authorized
// journal change; uses the actual writer, HMAC and durable journal replacement.
test('real direction refuses a read snapshot changed by a concurrent writer',async t=>{
  const r=await rig(t);await publish(r);const packageId=[...r.bodies.keys()].find(k=>k!==id(85))!;
  let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve),read=r.reader.retrieveBlockChildren;let held=false;
  r.reader.retrieveBlockChildren=async(ref:string)=>{if(ref===packageId&&!held){held=true;entered();await gate;}return read(ref);};
  const slow=r.make().run('sellerA',{action:'CONTEXT'});await started;
  const writer=r.make().run('owner',{action:'PREPARE',recipient:'REP_B',request_key:'concurrent-writer',direction});let timer:ReturnType<typeof setTimeout>|undefined;
  try{const result:any=await Promise.race([writer,new Promise(resolve=>timer=setTimeout(()=>resolve({status:'BLOCKED_BY_READER'}),250))]);assert.equal(result.status,'DRAFT');release();const observed=await slow;assert.equal(observed.status,'UNCONFIRMED');assert.equal(observed.reason,'CHANGED_DURING_READ');assert.equal(observed.direction,undefined);}
  finally{if(timer)clearTimeout(timer);release();await slow;await writer;}
});
// Break: a read of an already-published version reruns the write planner and
// spends the shared Notion request budget before the two independent proofs.
for(const action of ['STATUS','CONTEXT'] as const)test('published '+action+' keeps fresh double proof within 65 native reads',async t=>{
  const r=await rig(t);await publish(r);let reads=0;const counts:Record<string,number>={};
  for(const name of ['retrievePage','retrieveDataSource','retrieveDatabase','retrieveBlockChildren','queryDataSource']){
    const original=r.reader[name];r.reader[name]=async(...args:any[])=>{reads++;counts[name]=(counts[name]??0)+1;return original(...args);};
  }
  const before=await readFile(r.profile.journal_file,'utf8'),native=JSON.stringify([...r.native]),result=await r.make().run(action==='STATUS'?'owner':'sellerA',{action});
  if(action==='STATUS'){assert.equal(result.status,'OBSERVED');assert.equal(result.recipients[0].status,'PUBLISHED');assert.equal(result.recipients[0].consumed_version,null);}
  else{assert.equal(result.status,'PUBLISHED_DIRECTION');assert.equal(result.version,1);assert.equal(result.needs_consumption,true);assert.deepEqual(result.direction,direction);}
  assert.equal(await readFile(r.profile.journal_file,'utf8'),before);assert.equal(JSON.stringify([...r.native]),native);
  t.diagnostic(`fresh observation: ${reads} native reads ${JSON.stringify(counts)}`);
  assert.ok(reads<=65,`fresh publication observation cost ${reads} native reads: ${JSON.stringify(counts)}`);
});
// Break: using IDs from discovery as trusted facts, skipping the second proof,
// or reusing a cached success after actual native evidence changes.
test('published observation rejects second-pass sealed intent changes and never repairs native records',async t=>{
  const r=await rig(t);await publish(r);const run=[...r.native.values()].find(p=>p.parent.data_source_id===id(80)),query=r.reader.queryDataSource;let n=0;
  r.reader.queryDataSource=async(...args:any[])=>{const q=await query(...args);if(args[0]===id(80)&&++n>=3)for(const p of q.results)p.properties['Observed Facts']=prop('changed sealed intent');return q;};
  const before=JSON.stringify([...r.native]),result=await r.make().run('sellerA',{action:'CONTEXT'});
  assert.equal(result.status,'UNCONFIRMED');assert.equal(result.direction,undefined);assert.equal(result.writes,undefined);assert.equal(JSON.stringify([...r.native]),before);
  assert.ok(run);assert.equal(n,3,'the second independent Run read was actually changed');
});
// Break: owner reads only a label, then attempts seller CONTEXT for the detail.
test('META detail cold STATUS returns the exact native-proved published body without writes',async t=>{
  const r=await rig(t),{d}=await publish(r),before=await readFile(r.profile.journal_file,'utf8'),native=JSON.stringify([...r.native]),manifests=JSON.stringify([...r.manifests]);
  const all=await r.make().run('owner',{action:'STATUS'}),row=all.recipients.find((x:any)=>x.key==='REP_A');
  assert.deepEqual(row.direction,direction);assert.equal(row.proposal_id,d.proposal_id);assert.equal(row.native_chain_verified,true);assert.equal(row.does_not_change_local_authority,true);assert.equal(row.effective_state,'CURRENT');
  assert.equal(row.status,'PUBLISHED');assert.equal(row.consumed_version,null);assert.equal(row.writes,undefined);assert.equal(all.writes,undefined);
  assert.equal(await readFile(r.profile.journal_file,'utf8'),before);assert.equal(JSON.stringify([...r.native]),native);assert.equal(JSON.stringify([...r.manifests]),manifests);
});
// Break: a question about A reads B as well, wasting the shared native budget.
test('META detail targeted STATUS reads only the configured selected recipient within 55 fresh reads',async t=>{
  const r=await rig(t);await publish(r);let reads=0;const refs:string[]=[];
  for(const name of ['retrievePage','retrieveDataSource','retrieveDatabase','retrieveBlockChildren','queryDataSource']){const original=r.reader[name];r.reader[name]=async(...args:any[])=>{reads++;refs.push(args[0]);return original(...args);};}
  const result=await r.make().run('owner',{action:'STATUS',recipient:'REP_A'});
  assert.equal(result.status,'OBSERVED');assert.equal(result.recipients.length,1);assert.equal(result.recipients[0].key,'REP_A');assert.deepEqual(result.recipients[0].direction,direction);
  for(const ref of [id(5),id(6),id(41),id(42),id(1042)])assert.ok(!refs.includes(ref),'unrelated recipient read '+ref);
  // In this fixture #assignment costs 5 reads (root, source, database, Manifest twice).
  // Full STATUS remains 60; selection removes those 5, never either publication pass.
  t.diagnostic('targeted native reads '+reads);assert.equal(reads,55);
});
test('META detail selectors are closed and do not grant owner seller CONTEXT',async t=>{
  const r=await rig(t);let reads=0;const read=r.reader.retrievePage;r.reader.retrievePage=async(...args:any[])=>{reads++;return read(...args);};
  assert.equal((await r.make().run('owner',{action:'STATUS',recipient:'UNKNOWN'})).status,'INVALID_RECIPIENT');
  assert.equal((await r.make().run('owner',{action:'STATUS',recipient:id(3)})).status,'INVALID_ARGUMENT');
  assert.equal((await r.make().run('owner',{action:'STATUS',recipient:'REP_A',root_page_id:id(3)})).status,'INVALID_ARGUMENT');
  assert.equal((await r.make().run('owner',{action:'CONTEXT'})).status,'ACCESS_DENIED');
  assert.equal((await r.make().run('sellerA',{action:'STATUS',recipient:'REP_B'})).status,'ACCESS_DENIED');
  assert.equal((await r.make().run('sellerA',{action:'CONTEXT',recipient:'REP_B'})).status,'INVALID_ARGUMENT');assert.equal(reads,0);
});
test('META detail withholds a body on second-pass native changes',async t=>{
  const r=await rig(t);await publish(r);const read=r.reader.queryDataSource;let n=0;r.reader.queryDataSource=async(...args:any[])=>{const q=await read(...args);if(args[0]===id(80)&&++n>=3)for(const p of q.results)p.properties['Observed Facts']=prop('different sealed body');return q;};
  const result=await r.make().run('owner',{action:'STATUS',recipient:'REP_A'}),row=result.recipients?.[0];assert.equal(result.status,'OBSERVED');assert.equal(row.status,'UNCONFIRMED');assert.equal(row.direction,undefined);assert.equal(row.proposal_id,undefined);assert.equal(row.native_chain_verified,undefined);assert.equal(row.writes,undefined);assert.equal(n,3);
});
test('META detail rechecks recipient revocation after native proof before returning a body',async t=>{
  const r=await rig(t);await publish(r);const read=r.reader.queryDataSource,get=r.principals.get.bind(r.principals);let n=0,revoked=false;r.reader.queryDataSource=async(...args:any[])=>{const q=await read(...args);if(args[0]===id(80)&&++n>=3)revoked=true;return q;};r.principals.get=async k=>{const p=await get(k);return p&&k==='sellerA'&&revoked?{...p,status:'REVOKED'}:p;};
  const result=await r.make().run('owner',{action:'STATUS',recipient:'REP_A'}),row=result.recipients?.[0];assert.equal(result.status,'OBSERVED');assert.equal(row.status,'UNCONFIRMED');assert.equal(row.reason,'RECIPIENT_ASSIGNMENT_CHANGED');assert.equal(row.direction,undefined);assert.equal(row.pending,undefined);
});
test('META detail distinguishes native publication completion from owner approval time',async t=>{
  const r=await rig(t);await publish(r);const run=[...r.native.values()].find(p=>p.parent.data_source_id===id(80));
  run.properties.Finished=prop('2026-10-16T08:01:00.000Z','date');run.last_edited_time='2026-10-16T08:01:00.000Z';
  const before=await readFile(r.profile.journal_file,'utf8'),native=JSON.stringify([...r.native]),result=await r.make(()=>new Date('2026-10-16T08:02:00.000Z')).run('owner',{action:'STATUS',recipient:'REP_A'}),row=result.recipients?.[0];
  assert.equal(result.status,'OBSERVED');assert.equal(row.status,'PUBLISHED');assert.equal(row.approved_at,stamp);assert.equal(row.publication_completed_at,'2026-10-16T08:01:00.000Z');assert.notEqual(row.publication_completed_at,row.approved_at);assert.equal(row.publication_time_precision,'UTC_MINUTE');
  assert.equal(await readFile(r.profile.journal_file,'utf8'),before);assert.equal(JSON.stringify([...r.native]),native);
});
async function rig(t: any,metaRoot=id(1)) {
    const dir = await mkdtemp(join(tmpdir(), 'real-direction-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const rows = new Map<string, any>(), calls: any[] = [], rich = (v: string) => ({ type: 'rich_text', rich_text: [{ type: 'text', plain_text: v, text: { content: v } }] });
    const pins={schema_version:'TEST_SALES_SCHEMA/0.5.0',sales_contract_version:'TEST_SALES_CONTRACT/0.5.0'};
    const profile = { kind: 'REAL_DIRECTION_PROFILE/3' as const, owner_principal_id: 'owner', meta_root_id: metaRoot, definitions_source_id: id(2),publication:{contract:'META_ORIENTATION/1.0' as const,journal_root_id:id(85),protected_source_ids:[id(92),id(1101),id(1102),id(1103)],meta_runtime_id:'META1',meta_manifest_page_id:id(91),meta_manifest_source_id:id(92),meta_schema_version:'TEST_META_SCHEMA/0.2.0',spec_version:'TEST_META_SPEC/0.6.0',control_version:'TEST_CONTROL/1.1',runs_source_id:id(80),ledger_source_id:id(81),decisions_source_id:id(82)}, journal_file: join(dir, 'journal.json'), receipt_secret: 'a'.repeat(64), recipients: [{ key: 'REP_A', principal_id: 'sellerA', rep_identity_key: 'REP-C', runtime_id: 'SALES-C', root_page_id: id(3), receipts_source_id: id(4), manifest_page_id: id(31), manifest_data_source_id: id(32), mailbox: 'sellerA@example.test', generation: '1',...pins }, { key: 'REP_B', principal_id: 'sellerB', rep_identity_key: 'REP-J', runtime_id: 'SALES-J', root_page_id: id(5), receipts_source_id: id(6), manifest_page_id: id(41), manifest_data_source_id: id(42), mailbox: 'sellerB@example.test', generation: '1',...pins }] };
    const principals = new InMemoryPrincipalRegistry([{ principal_id: 'owner', status: 'ACTIVE', allowed_projects: ['VERTIGO'], allowed_lanes: ['META'], meta_authority: 'COMPANY_OWNER' }, { principal_id: 'sellerA', status: 'ACTIVE', allowed_projects: ['VERTIGO'], allowed_lanes: ['SALES'], rep_identity_key: 'REP-C' }, { principal_id: 'sellerB', status: 'ACTIVE', allowed_projects: ['VERTIGO'], allowed_lanes: ['SALES'], rep_identity_key: 'REP-J' }]);
    const registry = new InMemorySalesRuntimeRegistry(profile.recipients.map(r => ({ rep_identity_key: r.rep_identity_key, status: 'KNOWN' as const, root_ref: r.root_page_id, expected_instance_id: r.runtime_id, expected_gmail_identity: r.mailbox, pointer_generation: '1' })));
    const sources = new Map([[id(2), id(85)], [id(4), id(3)], [id(6), id(5)], [id(32), id(3)], [id(42), id(5)],[id(92),metaRoot],...[80,81,82].map(n=>[id(n),id(85)] as [string,string])]);
    const native=new Map<string,any>(),bodies=new Map<string,string>(),schemaFixture=fixture();let serial=0;
    const schemas=new Map([[80,2],[81,3],[82,4],[2,5],[32,8],[42,8]].map(([n,from])=>[id(n!),structuredClone(schemaFixture.schemas.get(id(from!)).properties)]));
    const manifests = new Map<string,any>(profile.recipients.map(r => [r.manifest_page_id, { object: 'page', id: r.manifest_page_id, archived: false, in_trash: false, last_edited_time: stamp, parent: { type: 'data_source_id', data_source_id: r.manifest_data_source_id }, properties: { 'Instance ID': rich(r.runtime_id), 'Gmail Identity': { type: 'email', email: r.mailbox }, 'Root URL': { type: 'url', url: 'https://app.notion.com/p/' + r.root_page_id },'Schema Version':rich(r.schema_version),'Sales Contract Version':rich(r.sales_contract_version),'Objective Package URL':prop(null,'url') } }]));
    manifests.set(id(91),{object:'page',id:id(91),archived:false,in_trash:false,last_edited_time:stamp,parent:{type:'data_source_id',data_source_id:id(92)},properties:{'Meta Runtime ID':rich('META1'),'Meta Root URL':prop('https://app.notion.com/p/'+metaRoot,'url'),'META Schema Version':rich(profile.publication.meta_schema_version),'Spec Version':rich(profile.publication.spec_version),'Control Version':rich(profile.publication.control_version)}});
    manifests.set(id(85),{object:'page',id:id(85),archived:false,in_trash:false,last_edited_time:stamp,parent:{type:'page_id',page_id:metaRoot},properties:{title:{type:'title',title:rich('META — Journal des orientations').rich_text}}});
    bodies.set(id(85),JSON.stringify({kind:'META_ORIENTATION_JOURNAL/1',contract:'META_ORIENTATION/1.0',meta_root_id:metaRoot,meta_runtime_id:'META1',sources:{runs:id(80),ledger:id(81),decisions:id(82),definitions:id(2)}}));
    const all=()=>[...rows.values(),...native.values()],field=(p:any,k:string)=>{const v=p.properties[k];return ['rich_text','title'].includes(v?.type)?v[v.type].map((x:any)=>x.plain_text).join(''):v?.type==='select'?v.select?.name:v?.type==='date'?v.date?.start:v?.[v?.type];};
    const match=(p:any,f:any):boolean=>!f||f.and?(!f||f.and.every((x:any)=>match(p,x))):f.or?f.or.some((x:any)=>match(p,x)):f.rich_text?.starts_with!==undefined?String(field(p,f.property)??'').startsWith(f.rich_text.starts_with):field(p,f.property)===(f.rich_text??f.select??f.title)?.equals;
    const reader: any = { retrievePage: async (page: string) => { calls.push(['page', page]); return structuredClone(rows.get(page) ?? native.get(page) ?? manifests.get(page) ?? { object: 'page', id: page, archived: false, in_trash: false, parent: { type: 'workspace', workspace: true }, last_edited_time: stamp, properties: { title: { type: 'title', title: [] } } }); }, retrieveDataSource: async (ds: string) => ({ object: 'data_source', id: ds, parent: { type: 'database_id', database_id: id(1000 + Number.parseInt(ds,16)) },properties:structuredClone(schemas.get(ds)??{}) }), retrieveDatabase: async (db: string) => ({ object: 'database', id: db, archived: false, in_trash: false, parent: { type: 'page_id', page_id: sources.get(id(Number.parseInt(db,16) - 1000)) } }), queryDataSource: async (ds: string, filter: any) => { calls.push(['query', ds, filter]); return { object: 'list', results: structuredClone(all().filter(p=>p.parent?.data_source_id===ds&&match(p,filter))), has_more: false, next_cursor: null }; },retrieveBlockChildren:async(ref:string)=>({object:'list',has_more:false,next_cursor:null,results:profile.recipients.some(r=>r.root_page_id===ref)?all().filter(p=>p.parent?.page_id===ref&&bodies.has(p.id)).map(p=>({object:'block',id:p.id,type:'child_page',archived:false,in_trash:false,has_children:false,child_page:{title:field(p,'title')}})):[{object:'block',id:id(950),type:'code',archived:false,in_trash:false,has_children:false,code:{language:'json',rich_text:rich(bodies.get(ref)??'').rich_text}}]}) };
    const mod = await import(new URL('../../src/verify/realDirectionControl.ts', import.meta.url).href).catch((e: any) => { if (e.code === 'ERR_MODULE_NOT_FOUND')
        return null; throw e; });
    const make = (clock = () => new Date(stamp)) => mod ? new mod.RealDirectionControl(profile, reader, principals, registry, clock) : { run: async () => ({ status: 'NOT_IMPLEMENTED' }) };
    const apply = (w: any) => {
      let p:any;if(w.operation==='CREATE_IF_ABSENT'){assert.ok(!all().some(p=>p.parent.data_source_id===w.data_source_id&&field(p,w.key_property)===w.key));p={object:'page',id:id(100+ ++serial),archived:false,in_trash:false,last_edited_time:stamp,parent:{type:'data_source_id',data_source_id:w.data_source_id},properties:{}};}
      else if(w.operation==='CREATE_CHILD_IF_ABSENT'){p={object:'page',id:id(100+ ++serial),archived:false,in_trash:false,last_edited_time:stamp,parent:{type:'page_id',page_id:w.parent_page_id},properties:{title:{type:'title',title:rich(w.title).rich_text}}};bodies.set(p.id,w.content);}
      else{assert.equal(w.operation,'UPDATE_IF_MATCH');p=rows.get(w.page_id)??native.get(w.page_id)??manifests.get(w.page_id);assert.ok(p);assert.equal(p.last_edited_time,w.expected_revision);for(const [k,v]of Object.entries(w.before))assert.equal(field(p,k),v);}
      for(const [k,v]of Object.entries(w.properties??{})){if(k.startsWith('date:')){if(k.endsWith(':start'))p.properties[k.slice(5,-6)]=prop(v,'date');continue;}
        const type=['Run','Mutation','Decision','Definition','Receipt'].includes(k)?'title':['Event Type','Source System','Source Confidence','Definition Type','Status','Run Type','Origin','Operation','Type','Control Confirmation State'].includes(k)?'select':['Verified','Recovery Required'].includes(k)?'checkbox':k==='Objective Package URL'?'url':typeof v==='number'?'number':'rich_text';p.properties[k]=type==='title'?{type,title:rich(v as string).rich_text}:prop(type==='checkbox'?v==='__YES__':v,type);}
      p.last_edited_time=new Date(Date.parse(stamp)+ ++serial).toISOString();
      if(w.operation==='UPDATE_IF_MATCH'&&manifests.has(p.id))manifests.set(p.id,p);else (p.parent.data_source_id===id(2)||[id(4),id(6)].includes(p.parent.data_source_id)?rows:native).set(p.id,p);return p.id;
    };
    const finish=async(proposal_id:string,first?:any,invoke=(args:any)=>make().run('owner',args))=>{let p=first??await invoke({action:'VERIFY',proposal_id}),previous='initial';for(let i=0;i<25;i++){if(p.status==='PUBLISHED')return p;assert.equal(p.status,'APPROVED_PENDING_NOTION',previous+' → '+JSON.stringify(p));previous=p.phase;for(const w of p.writes)apply(w);p=await invoke({action:'VERIFY',proposal_id});}assert.fail('native controller must terminate within the transaction bound');};
    return { profile, rows, calls, make, apply, reader, control: make(), principals, registry,native,manifests,bodies,finish,sources,schemas };
}
async function publish(r: any, key = 'REP_A', text = direction) { const d = await r.control.run('owner', { action: 'PREPARE', recipient: key, request_key: 'request-' + key + '-' + text.title, direction: text }); assert.equal(d.status, 'DRAFT'); const a = await r.control.run('owner', { action: 'APPROVE', proposal_id: d.proposal_id, approval_hash: d.approval_hash, confirmation: 'Je valide cette proposition pour ce destinataire.' }); assert.equal(a.status, 'APPROVED_PENDING_NOTION'); const p=await r.finish(d.proposal_id,a);return { d, a, p }; }
// Break: publishing a proposal without an exact explicit owner-session confirmation.
test('real direction remains draft and invisible to sellers until approved and independently read back', async (t) => { const r = await rig(t), d = await r.control.run('owner', { action: 'PREPARE', recipient: 'REP_A', request_key: 'one', direction }); assert.equal(d.status, 'DRAFT'); assert.equal((await r.control.run('sellerA', { action: 'CONTEXT' })).status, 'NO_PUBLISHED_DIRECTION'); assert.equal((await r.control.run('owner', { action: 'VERIFY', proposal_id: d.proposal_id })).status, 'APPROVAL_REQUIRED'); assert.equal((await r.control.run('owner', { action: 'APPROVE', proposal_id: d.proposal_id, approval_hash: 'b'.repeat(64), confirmation: 'oui' })).status, 'APPROVAL_MISMATCH'); });
test('real direction refuses an unmanaged pre-existing pointer rather than silently replacing its publication',async t=>{
  const r=await rig(t);r.manifests.get(id(31)).properties['Objective Package URL']=prop('https://app.notion.com/p/'+id(999),'url');
  const p=await r.control.run('owner',{action:'PREPARE',recipient:'REP_A',request_key:'foreign-pointer',direction});
  assert.equal(p.status,'UNCONFIRMED');assert.equal(p.reason,'UNMANAGED_CURRENT_POINTER');assert.equal(r.native.size,0);
});
test('real direction binds its preview to the prior native pointer and refuses a change before approval',async t=>{
  const r=await rig(t),draft=await r.control.run('owner',{action:'PREPARE',recipient:'REP_A',request_key:'changed-before-approve',direction});
  r.manifests.get(id(31)).properties['Objective Package URL']=prop('https://app.notion.com/p/'+id(999),'url');
  const result=await r.control.run('owner',{action:'APPROVE',proposal_id:draft.proposal_id,approval_hash:draft.approval_hash,confirmation:'oui'});
  assert.equal(result.status,'UNCONFIRMED');assert.equal(result.writes,undefined);assert.equal(r.native.size,0);
});
test('real direction never publishes a definition alone and refuses a damaged completed native chain',async t=>{
  const r=await rig(t),d=await r.control.run('owner',{action:'PREPARE',recipient:'REP_A',request_key:'definition-only',direction});
  let result=await r.control.run('owner',{action:'APPROVE',proposal_id:d.proposal_id,approval_hash:d.approval_hash,confirmation:'oui'});
  for(let n=0;n<3;n++){for(const w of result.writes)r.apply(w);result=await r.make().run('owner',{action:'VERIFY',proposal_id:d.proposal_id});}
  assert.equal(r.rows.size,1,'definition really exists');assert.equal(result.status,'APPROVED_PENDING_NOTION');assert.equal((await r.make().run('sellerA',{action:'CONTEXT'})).status,'NO_PUBLISHED_DIRECTION');
  await r.finish(d.proposal_id,result);const ledger=[...r.native.values()].find(p=>p.parent.data_source_id===id(81));ledger.properties['Run Ref']={type:'rich_text',rich_text:[{type:'text',plain_text:'https://app.notion.com/p/'+id(999),text:{content:'https://app.notion.com/p/'+id(999)}}]};
  const c=await r.make().run('sellerA',{action:'CONTEXT'});assert.equal(c.status,'UNCONFIRMED');assert.equal(c.direction,undefined);assert.equal(c.writes,undefined);
});
test('real direction rejects the obsolete profile contract without rewriting its journal',async t=>{
  const r=await rig(t),{RealDirectionControl}=await import('../../src/verify/realDirectionControl.ts');
  assert.throws(()=>new RealDirectionControl({...r.profile,kind:'REAL_DIRECTION_PROFILE/1'} as any,r.reader,r.principals,r.registry));
  await assert.rejects(readFile(r.profile.journal_file),{code:'ENOENT'});
});
test('real direction uses the exact configured META project without granting a different project',async t=>{
  const r=await rig(t);(r.profile as any).project='VERTIGO_META_OS';const original=r.principals.get.bind(r.principals);
  r.principals.get=async key=>{const p=await original(key);return p&&key==='owner'?{...p,allowed_projects:['VERTIGO_META_OS']}:p;};
  assert.equal((await r.make().run('owner',{action:'STATUS'})).status,'OBSERVED');
  r.principals.get=async key=>{const p=await original(key);return p&&key==='owner'?{...p,allowed_projects:['UNRELATED_PROJECT']}:p;};
  assert.equal((await r.make().run('owner',{action:'STATUS'})).status,'ACCESS_DENIED');
});
test('characterization: shared META sources expose an interrupted orientation to unchanged global controls',async t=>{
  const w=buildResumeWorld();w.setSpecRoot(specRootChildren({control:metaV.controlB}));
  const ctx={principal_id:OWNER.principal_id,now:T0},handle=handleOf(await dispatch('os_bind',{project:'VERTIGO',lane:'META'},ctx,w.deps));
  const before=await dispatch('os_control_status',{binding_handle:handle},ctx,w.deps);assert.equal(before.code,'CONTROL_STATUS');
  const r=await rig(t),draft=await r.control.run('owner',{action:'PREPARE',recipient:'REP_A',request_key:'global-coexistence',direction}),approved=await r.control.run('owner',{action:'APPROVE',proposal_id:draft.proposal_id,approval_hash:draft.approval_hash,confirmation:'oui'});
  for(const write of approved.writes)r.apply(write);
  const old=(w.map.get('query:'+R.metaRunsDs) as any).results;
  const opened=[...r.native.values()].filter(p=>p.parent.data_source_id===id(80)).map(p=>({...structuredClone(p),last_edited_time:new Date(T0.getTime()+4*86400000).toISOString(),parent:{type:'data_source_id',data_source_id:R.metaRunsDs}}));
  w.setMetaRuns([...old,...opened]);
  const after=await dispatch('os_control_status',{binding_handle:handle},ctx,w.deps);
  assert.notEqual(after.code,before.code,'shared-source design is NOT transparent; do not promote it '+JSON.stringify(after));
  assert.equal(after.status,'HOLD');assert.equal((await r.control.run('sellerA',{action:'CONTEXT'})).status,'NO_PUBLISHED_DIRECTION');
});
// Break: physically separate journal records being discovered as global Runs,
// or the journal being "isolated" only by a different label on the same source.
test('isolated orientation coexists under the same META root at every interruption and after cold completion',async t=>{
  const w=buildResumeWorld();w.setSpecRoot(specRootChildren({control:metaV.controlB}));
  const ctx={principal_id:OWNER.principal_id,now:T0},handle=handleOf(await dispatch('os_bind',{project:'VERTIGO',lane:'META'},ctx,w.deps));
  const baseline=await dispatch('os_control_status',{binding_handle:handle},ctx,w.deps);
  assert.equal(baseline.code,'CONTROL_STATUS');
  const r=await rig(t,META_ID.rootA),oldEntries=structuredClone([...w.map.entries()]);
  const isolated=[id(80),id(81),id(82),id(2)],rootKey='children:'+META_ID.rootA;
  const oldRoot=w.map.get(rootKey) as any;
  const mirror=async()=>{
    w.map.set(rootKey,{...oldRoot,results:[...oldRoot.results,{object:'block',id:id(85),type:'child_page',child_page:{title:'META — Journal des orientations'}}]});
    w.map.set('page:'+id(85),structuredClone(r.manifests.get(id(85))));
    w.map.set('children:'+id(85),{object:'list',has_more:false,next_cursor:null,results:[...(await r.reader.retrieveBlockChildren(id(85))).results,...isolated.map(ds=>({object:'block',id:id(1000+Number.parseInt(ds,16)),type:'child_database',child_database:{title:'Orientations — '+ds}}))]});
    for(const ds of isolated){
      w.map.set('data_source:'+ds,await r.reader.retrieveDataSource(ds));
      w.map.set('database:'+id(1000+Number.parseInt(ds,16)),await r.reader.retrieveDatabase(id(1000+Number.parseInt(ds,16))));
      w.map.set('query:'+ds,await r.reader.queryDataSource(ds,undefined));
    }
    for(const p of [...r.rows.values(),...r.native.values()])w.map.set('page:'+p.id,structuredClone(p));
  };
  const unchanged=async()=>{
    await mirror();
    assert.deepEqual(await dispatch('os_control_status',{binding_handle:handle},ctx,w.deps),baseline,'real unchanged global reader/motor must keep the same verdict and invariants');
    for(const [key,value]of oldEntries)if(key!==rootKey)assert.deepEqual(w.map.get(key),value,'existing source/history changed: '+key);
  };
  await unchanged();
  const draft=await r.control.run('owner',{action:'PREPARE',recipient:'REP_A',request_key:'physical-coexistence',direction});
  let result=await r.control.run('owner',{action:'APPROVE',proposal_id:draft.proposal_id,approval_hash:draft.approval_hash,confirmation:'oui'}),phases=0;
  while(result.status!=='PUBLISHED'){
    assert.equal(result.status,'APPROVED_PENDING_NOTION');assert.ok(++phases<25);
    for(const write of result.writes){r.apply(write);await unchanged();}
    result=await r.make().run('owner',{action:'VERIFY',proposal_id:draft.proposal_id});
  }
  assert.ok(phases>10,'exercise actual interrupted native transaction, not a stubbed verdict');
  assert.equal((await r.make().run('sellerA',{action:'CONTEXT'})).status,'PUBLISHED_DIRECTION');
  assert.equal((await r.make().run('sellerB',{action:'CONTEXT'})).status,'NO_PUBLISHED_DIRECTION');
  assert.equal([...r.native.values()].filter(p=>p.parent.data_source_id===id(81)).length,4);
  assert.equal((await r.make().run('owner',{action:'VERIFY',proposal_id:draft.proposal_id})).status,'PUBLISHED');
  await unchanged();
});
// Break: returning a colleague direction or a private owner record.
test('real direction publishes one recipient only and survives process reconstruction', async (t) => { const r = await rig(t); await publish(r); assert.equal((await r.make().run('sellerA', { action: 'CONTEXT' })).direction.objective, direction.objective); assert.equal((await r.control.run('sellerB', { action: 'CONTEXT' })).status, 'NO_PUBLISHED_DIRECTION'); assert.equal((await r.control.run('outsider', { action: 'CONTEXT' })).status, 'ACCESS_DENIED'); assert.equal((await r.control.run('sellerA', { action: 'CONTEXT', recipient: 'REP_B' })).status, 'INVALID_ARGUMENT'); });
// Break: a label or changed record replacing the sealed expected version.
test('real direction tampered published content is not trusted and does not authorize local changes', async (t) => { const r = await rig(t); await publish(r); const row = [...r.rows.values()][0]; row.properties.Content.rich_text[0].plain_text = '{"status":"APPROVED"}'; assert.equal((await r.control.run('sellerA', { action: 'CONTEXT' })).status, 'UNCONFIRMED'); assert.equal((await r.control.run('sellerA', { action: 'CONTEXT' })).writes, undefined); });
// Break: losing an old active direction when a new publication is incomplete.
test('real direction incomplete revision preserves previous version and older rows', async (t) => { const r = await rig(t); await publish(r); const old = JSON.stringify([...r.rows.values()]); const d = await r.control.run('owner', { action: 'PREPARE', recipient: 'REP_A', request_key: 'two', direction: { ...direction, title: 'Cap suivant' } }); await r.control.run('owner', { action: 'APPROVE', proposal_id: d.proposal_id, approval_hash: d.approval_hash, confirmation: 'oui' }); const pending=await r.control.run('owner', { action: 'VERIFY', proposal_id: d.proposal_id });assert.equal(pending.status, 'APPROVED_PENDING_NOTION');assert.equal(pending.approval_required,false);assert.equal((await r.control.run('sellerA', { action: 'CONTEXT' })).version, 1); assert.equal(JSON.stringify([...r.rows.values()]), old); });
// Break: collapsing retries into additional published versions.
test('real direction same request and verification replay are idempotent', async (t) => { const r = await rig(t), { d } = await publish(r); const again = await r.make().run('owner', { action: 'PREPARE', recipient: 'REP_A', request_key: 'request-REP_A-' + direction.title, direction }); assert.equal(again.proposal_id, d.proposal_id); assert.equal((await r.control.run('owner', { action: 'VERIFY', proposal_id: d.proposal_id })).version, 1); assert.equal(r.rows.size, 1); });
// Break: acknowledging consumption without a durable local receipt, or altering business settings.
test('real direction consumption is a local control receipt and owner sees only its verified acknowledgement', async (t) => { const r = await rig(t); await publish(r); const c = await r.control.run('sellerA', { action: 'CONSUME' }); assert.equal(c.status, 'CONSUMPTION_PENDING_NOTION'); assert.equal(c.writes.length, 1); assert.equal(c.writes[0].data_source_id, id(4)); assert.equal(c.writes[0].properties['Event Type'], 'OTHER'); assert.equal((await r.control.run('sellerA', { action: 'VERIFY_CONSUMPTION' })).status, 'UNCONFIRMED'); r.apply(c.writes[0]); assert.equal((await r.make().run('sellerA', { action: 'VERIFY_CONSUMPTION' })).status, 'CONSUMED'); const owner = await r.control.run('owner', { action: 'STATUS' }); assert.equal(owner.recipients.find((x: any) => x.key === 'REP_A').consumed_version, 1); assert.equal(r.rows.size, 2); });
// Break: one colleague can approve/publish, or an ambiguous source becomes a success.
test('real direction non-owner cannot prepare and duplicate publication records are refused', async (t) => { const r = await rig(t); assert.equal((await r.control.run('sellerA', { action: 'PREPARE', recipient: 'REP_A', request_key: 'x', direction })).status, 'ACCESS_DENIED'); await publish(r); const row = [...r.rows.values()][0]; r.rows.set(id(900), { ...row, id: id(900) }); assert.equal((await r.control.run('sellerA', { action: 'CONTEXT' })).status, 'UNCONFIRMED'); });
// Break: publishing to a rep whose registry assignment changed since the proposal.
test('real direction rechecks recipient assignment before returning a publication write', async (t) => { const r = await rig(t), d = await r.control.run('owner', { action: 'PREPARE', recipient: 'REP_A', request_key: 'rotate', direction }); const original = r.registry.lookup.bind(r.registry); r.registry.lookup = async (key) => { const p = await original(key); return p ? { ...p, pointer_generation: '2' } : p; }; const a = await r.control.run('owner', { action: 'APPROVE', proposal_id: d.proposal_id, approval_hash: d.approval_hash, confirmation: 'oui' }); assert.equal(a.status, 'UNCONFIRMED'); assert.equal(a.reason, 'RECIPIENT_ASSIGNMENT_CHANGED'); assert.equal(a.writes, undefined); });
// Break: duplicate local acknowledgements being treated as missing and recreated.
test('real direction duplicate local receipts never request another write', async (t) => { const r = await rig(t); await publish(r); const c = await r.control.run('sellerA', { action: 'CONSUME' }); const rid = r.apply(c.writes[0]); r.rows.set(id(901), { ...r.rows.get(rid), id: id(901) }); const repeated = await r.control.run('sellerA', { action: 'CONSUME' }); assert.equal(repeated.status, 'UNCONFIRMED'); assert.equal(repeated.reason, 'AMBIGUOUS_RECORD'); assert.equal(repeated.writes, undefined); });
// Break: a stale approved proposal returning write instructions after another version won.
test('real direction stale approved proposal cannot emit writes or supersede a newer publication', async (t) => { const r = await rig(t), first = await r.control.run('owner', { action: 'PREPARE', recipient: 'REP_A', request_key: 'a', direction }), second = await r.control.run('owner', { action: 'PREPARE', recipient: 'REP_A', request_key: 'b', direction: { ...direction, title: 'Autre proposition' } }); await r.control.run('owner', { action: 'APPROVE', proposal_id: second.proposal_id, approval_hash: second.approval_hash, confirmation: 'oui' }); const a = await r.control.run('owner', { action: 'APPROVE', proposal_id: first.proposal_id, approval_hash: first.approval_hash, confirmation: 'oui' }); assert.equal((await r.finish(first.proposal_id,a)).status, 'PUBLISHED'); const stale = await r.control.run('owner', { action: 'APPROVE', proposal_id: second.proposal_id, approval_hash: second.approval_hash, confirmation: 'oui' }); assert.equal(stale.status, 'STALE_PROPOSAL'); assert.equal(stale.writes, undefined); assert.equal((await r.control.run('sellerA', { action: 'CONTEXT' })).direction.title, 'Cap personnel'); });
// Break: cached journal acknowledgement surviving deletion of its actual Notion receipt.
test('real direction owner status rereads current acknowledgements instead of trusting a cached verified flag', async (t) => { const r = await rig(t); await publish(r); const c = await r.control.run('sellerA', { action: 'CONSUME' }), rid = r.apply(c.writes[0]); assert.equal((await r.control.run('sellerA', { action: 'VERIFY_CONSUMPTION' })).status, 'CONSUMED'); r.rows.delete(rid); const s = await r.control.run('owner', { action: 'STATUS' }), recipient = s.recipients.find((x: any) => x.key === 'REP_A'); assert.equal(recipient.consumed_version, null); assert.equal(recipient.status, 'UNCONFIRMED'); });
// Break: claiming DRAFT on replay after this exact request already published.
test('real direction request replay returns its durable published stage', async (t) => { const r = await rig(t), { d } = await publish(r); const replay = await r.make().run('owner', { action: 'PREPARE', recipient: 'REP_A', request_key: 'request-REP_A-' + direction.title, direction }); assert.equal(replay.status, 'PUBLISHED'); assert.equal(replay.proposal_id, d.proposal_id); assert.equal(replay.writes, undefined); });
// Break: accepting a datasource under a now archived root without reading that root.
test('real direction archived recipient root refuses acknowledgement instructions', async (t) => { const r = await rig(t); await publish(r); r.rows.set(id(3), { object: 'page', id: id(3), archived: true, in_trash: false, parent: { type: 'workspace', workspace: true }, last_edited_time: stamp, properties: {} }); const c = await r.control.run('sellerA', { action: 'CONSUME' }); assert.equal(c.status, 'UNCONFIRMED'); assert.equal(c.writes, undefined); });
// Break: letting two paths to an identical receipt silently replace a successful receipt ID.
test('real direction a verified receipt is not rebound to a cloned page', async (t) => { const r = await rig(t); await publish(r); const c = await r.control.run('sellerA', { action: 'CONSUME' }), rid = r.apply(c.writes[0]); assert.equal((await r.control.run('sellerA', { action: 'VERIFY_CONSUMPTION' })).status, 'CONSUMED'); r.rows.set(id(902), { ...r.rows.get(rid), id: id(902) }); r.rows.delete(rid); const changed = await r.control.run('sellerA', { action: 'VERIFY_CONSUMPTION' }); assert.equal(changed.status, 'UNCONFIRMED'); assert.equal(changed.reason, 'RECEIPT_ID_CHANGED'); assert.equal(changed.writes, undefined); });
// Break: two real processes overwriting signed proposals in the same journal.
test('real direction concurrent processes preserve every distinct proposal', async (t) => {
    const r = await rig(t);
    const source = `
import{RealDirectionControl}from ${JSON.stringify(new URL('../../src/verify/realDirectionControl.ts', import.meta.url).href)};
import{InMemoryPrincipalRegistry}from ${JSON.stringify(new URL('../../src/auth/principal.ts', import.meta.url).href)};
import{InMemorySalesRuntimeRegistry}from ${JSON.stringify(new URL('../../src/registry/salesRuntimes.ts', import.meta.url).href)};
let raw='';for await(const chunk of process.stdin)raw+=chunk;const {profile,direction,prefix}=JSON.parse(raw);
const principals=new InMemoryPrincipalRegistry([{principal_id:'owner',status:'ACTIVE',allowed_projects:['VERTIGO'],allowed_lanes:['META'],meta_authority:'COMPANY_OWNER'},...profile.recipients.map(r=>({principal_id:r.principal_id,status:'ACTIVE',allowed_projects:['VERTIGO'],allowed_lanes:['SALES'],rep_identity_key:r.rep_identity_key}))]);
const registry=new InMemorySalesRuntimeRegistry(profile.recipients.map(r=>({rep_identity_key:r.rep_identity_key,status:'KNOWN',root_ref:r.root_page_id,expected_instance_id:r.runtime_id,expected_gmail_identity:r.mailbox,pointer_generation:'1'})));
const reader={retrievePage:async id=>{const r=profile.recipients.find(r=>r.manifest_page_id===id);const rich=s=>({type:'rich_text',rich_text:[{type:'text',plain_text:s,text:{content:s}}]});return r?{object:'page',id,archived:false,in_trash:false,last_edited_time:'2026-10-16T08:00:00Z',parent:{type:'data_source_id',data_source_id:r.manifest_data_source_id},properties:{'Instance ID':rich(r.runtime_id),'Gmail Identity':{type:'email',email:r.mailbox},'Root URL':{type:'url',url:'https://app.notion.com/p/'+r.root_page_id},'Schema Version':rich(r.schema_version),'Sales Contract Version':rich(r.sales_contract_version),'Objective Package URL':{type:'url',url:null}}}:{object:'page',id,archived:false,in_trash:false};},retrieveDataSource:async id=>({object:'data_source',id,parent:{type:'page_id',page_id:id===profile.definitions_source_id?profile.meta_root_id:profile.recipients.find(r=>r.manifest_data_source_id===id).root_page_id}})};
const control=new RealDirectionControl(profile,reader,principals,registry,()=>new Date('2026-10-16T08:00:00.000Z'));
process.stdout.write('READY\\n');await new Promise(resolve=>setTimeout(resolve,100));
for(let i=0;i<12;i++){const result=await control.run('owner',{action:'PREPARE',recipient:'REP_A',request_key:prefix+i,direction});if(result.status!=='DRAFT')throw Error(result.status);}
`;
    const children = ['first-', 'second-'].map(prefix => new Promise<void>((resolve, reject) => { const child = spawn(process.execPath, ['--input-type=module', '--eval', source], { stdio: ['pipe', 'pipe', 'pipe'] }); let stderr = ''; child.stderr.on('data', data => stderr += data); child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(Error(stderr))); child.stdin.end(JSON.stringify({ profile: r.profile, direction, prefix })); }));
    await Promise.all(children);
    const result = await r.make().run('owner', { action: 'STATUS' });
    assert.equal(result.status, 'OBSERVED');
    assert.equal(result.recipients.find((x: any) => x.key === 'REP_A').pending_proposals, 24);
});
// Break: invalid calendar values throwing out of the tool boundary instead of refusing input.
test('real direction invalid dates are rejected without a journal side effect', async (t) => { const r = await rig(t); for (const start of ['2026-99-99', '2026-02-30']) {
    const result = await r.control.run('owner', { action: 'PREPARE', recipient: 'REP_A', request_key: start, direction: { ...direction, horizon: { start, end: '2026-12-31' } } });
    assert.equal(result.status, 'INVALID_ARGUMENT');
} assert.equal((await r.control.run('owner', { action: 'STATUS' })).recipients[0].pending_proposals, 0); });
// Break: the raw publication key matching a copied row with the wrong REST property types.
test('real direction wrong typed definition fields are refused even when their strings match', async (t) => { const r = await rig(t); await publish(r); const row = [...r.rows.values()][0], name = row.properties.Status.select.name; row.properties.Status = { type: 'rich_text', rich_text: [{ type: 'text', plain_text: name, text: { content: name } }] }; const result = await r.control.run('sellerA', { action: 'CONTEXT' }); assert.equal(result.status, 'UNCONFIRMED'); assert.equal(result.reason, 'PUBLICATION_UNCONFIRMED'); });
// Break: ordinary recommendation text equal to a native checkbox sentinel being miscompared.
test('real direction sentinel-looking prose is still text', async (t) => { const r = await rig(t); await publish(r, 'REP_A', { ...direction, title: '__YES__' }); const result = await r.control.run('sellerA', { action: 'CONTEXT' }); assert.equal(result.status, 'PUBLISHED_DIRECTION'); assert.equal(result.direction.title, '__YES__'); });
// Break: disclosure of a direction after this seller was revoked during the source read.
test('real direction refuses a reassigned Notion Manifest despite an unchanged server registry', async t => {
    const r=await rig(t), original=r.reader.retrievePage;
    r.reader.retrievePage=async(page:string)=>{const p=await original(page);return page===id(31)?{...p,properties:{...p.properties,'Gmail Identity':{type:'email',email:'another@example.test'}}}:p;};
    const d=await r.control.run('owner',{action:'PREPARE',recipient:'REP_A',request_key:'wrong-manifest',direction});
    assert.equal(d.status,'UNCONFIRMED');assert.equal(d.reason,'RECIPIENT_ASSIGNMENT_CHANGED');assert.equal(d.writes,undefined);
});

test('real direction confirms the actual Manifest mailbox when the registry mailbox is optional',async t=>{
    const r=await rig(t),original=r.registry.lookup.bind(r.registry);
    r.registry.lookup=async key=>{const p=await original(key);if(!p)return p;const {expected_gmail_identity:omitted,...rest}=p;return rest;};
    const d=await r.control.run('owner',{action:'PREPARE',recipient:'REP_A',request_key:'optional-mailbox',direction});
    assert.equal(d.status,'DRAFT');
});

test('real direction seller read checks its current Notion identity after publication',async t=>{
    const r=await rig(t);await publish(r);const original=r.reader.retrievePage;
    r.reader.retrievePage=async(page:string)=>{const p=await original(page);return page===id(31)?{...p,properties:{...p.properties,'Instance ID':{type:'rich_text',rich_text:[{plain_text:'REASSIGNED'}]}}}:p;};
    const result=await r.control.run('sellerA',{action:'CONTEXT'});assert.equal(result.status,'UNCONFIRMED');assert.equal(result.reason,'RECIPIENT_ASSIGNMENT_CHANGED');assert.equal(result.direction,undefined);
});

// Break: operator profile collisions granting two identities a shared physical target.
test('real direction profile rejects cross-role physical targets and case-insensitive mailbox collisions',async t=>{
    const r=await rig(t),mod=await import('../../src/verify/realDirectionControl.ts');
    const rejected=[];for(const profile of [
        {...r.profile,definitions_source_id:r.profile.recipients[0]!.manifest_page_id},
        {...r.profile,recipients:r.profile.recipients.map((p,i)=>i?{...p,mailbox:'SELLERA@example.test'}:p)},
    ]){try{new mod.RealDirectionControl(profile,r.reader,r.principals,r.registry);rejected.push(false);}catch{rejected.push(true);}}assert.deepEqual(rejected,[true,true]);
});

// Break: a profile change for one recipient invalidating another recipient's signed history.
test('real direction unrelated recipient profile changes do not invalidate published signatures',async t=>{
    const r=await rig(t);await publish(r);r.profile.recipients[1]!.generation='2';const original=r.registry.lookup.bind(r.registry);
    r.registry.lookup=async key=>{const p=await original(key);return p&&key==='REP-J'?{...p,pointer_generation:'2'}:p;};
    const result=await r.make().run('owner',{action:'STATUS'});assert.equal(result.status,'OBSERVED');assert.equal(result.recipients.find((x:any)=>x.key==='REP_A').published_version,1);
    assert.equal((await r.make().run('sellerA',{action:'CONTEXT'})).status,'PUBLISHED_DIRECTION');
});

test('real direction recipient rotation preserves old history and requires a new bound version',async t=>{
    const r=await rig(t);await publish(r,'REP_B');const before=JSON.stringify([...r.rows.values()]);r.profile.recipients[1]!.generation='2';const original=r.registry.lookup.bind(r.registry);
    r.registry.lookup=async key=>{const p=await original(key);return p&&key==='REP-J'?{...p,pointer_generation:'2'}:p;};
    const control=r.make(),status=await control.run('owner',{action:'STATUS'}),target=status.recipients.find((x:any)=>x.key==='REP_B');assert.equal(target.status,'UNCONFIRMED');assert.equal(target.reason,'RECIPIENT_ASSIGNMENT_CHANGED');assert.equal(JSON.stringify([...r.rows.values()]),before);
    const d=await control.run('owner',{action:'PREPARE',recipient:'REP_B',request_key:'new-assignment',direction});assert.equal(d.status,'DRAFT');assert.equal(d.version,2);assert.equal((await control.run('sellerB',{action:'CONTEXT'})).status,'UNCONFIRMED');
});

// Break: a cold request reclassifying an already APPROVED intent as DRAFT and demanding approval again.
test('real direction approved intent resumes after restart without a second confirmation',async t=>{
    const r=await rig(t),d=await r.control.run('owner',{action:'PREPARE',recipient:'REP_A',request_key:'resume-approved',direction});
    await r.control.run('owner',{action:'APPROVE',proposal_id:d.proposal_id,approval_hash:d.approval_hash,confirmation:'oui'});
    const resumed=await r.make().run('owner',{action:'PREPARE',recipient:'REP_A',request_key:'resume-approved',direction});
    assert.equal(resumed.status,'APPROVED_PENDING_NOTION');assert.equal(resumed.approval_required,false);assert.equal(resumed.proposal_id,d.proposal_id);assert.equal(resumed.writes.length,1);
    const verify=await r.make().run('owner',{action:'VERIFY',proposal_id:d.proposal_id});assert.equal(verify.status,'APPROVED_PENDING_NOTION');assert.equal(verify.approval_required,false);r.apply(verify.writes[0]);
    assert.equal((await r.finish(d.proposal_id)).status,'PUBLISHED');
});

// Break: emitting a native write after the fixed definition source moved outside the owner root.
test('real direction publication write is withheld when META source ancestry changes after preparation',async t=>{
    const r=await rig(t),d=await r.control.run('owner',{action:'PREPARE',recipient:'REP_A',request_key:'wrong-target',direction}),original=r.reader.retrieveDataSource;
    r.reader.retrieveDataSource=async(ds:string)=>ds===id(2)?{object:'data_source',id:ds,parent:{type:'page_id',page_id:id(99)}}:original(ds);
    const result=await r.control.run('owner',{action:'APPROVE',proposal_id:d.proposal_id,approval_hash:d.approval_hash,confirmation:'oui'});assert.equal(result.status,'UNCONFIRMED');assert.equal(result.writes,undefined);
});

// Break: an approval retry claiming PUBLISHED after its source contents were changed.
test('real direction published approval replay rereads the publication proof',async t=>{
    const r=await rig(t),{d}=await publish(r);const row=[...r.rows.values()][0];row.properties.Status.select.name='RETIRED';
    const result=await r.control.run('owner',{action:'APPROVE',proposal_id:d.proposal_id,approval_hash:d.approval_hash,confirmation:'oui'});assert.equal(result.status,'UNCONFIRMED');assert.equal(result.writes,undefined);
});

// Break: a tampered journal being silently reset, or a loose filesystem mode exposing its contents.
test('real direction signed journal survives restart and tamper fails closed without resetting',async t=>{
    const r=await rig(t);await publish(r);assert.equal((await stat(r.profile.journal_file)).mode&0o777,0o600);
    const original=await readFile(r.profile.journal_file,'utf8'),tampered=original.replace('Cap personnel','Tampered title');assert.notEqual(tampered,original);await writeFile(r.profile.journal_file,tampered);
    const result=await r.make().run('owner',{action:'STATUS'});assert.equal(result.status,'UNCONFIRMED');assert.equal(result.reason,'INVALID_JOURNAL');assert.equal(await readFile(r.profile.journal_file,'utf8'),tampered);
});

// Break: disclosure of a direction after this seller was revoked during the source read.
test('real direction revocation during read suppresses direction content', async (t) => { const r = await rig(t); await publish(r); const original = r.principals.get.bind(r.principals); let lookups = 0; r.principals.get = async (key) => { const p = await original(key); return p && key === 'sellerA' && ++lookups > 1 ? { ...p, status: 'REVOKED' } : p; }; const result = await r.control.run('sellerA', { action: 'CONTEXT' }); assert.equal(result.status, 'ACCESS_DENIED'); assert.equal(result.direction, undefined); assert.equal(result.writes, undefined); });
// Break: publishing an approved package after its recipient was rotated during independent readback.
test('real direction reassignment during verification does not advance the active version', async (t) => { const r = await rig(t), d = await r.control.run('owner', { action: 'PREPARE', recipient: 'REP_A', request_key: 'mid-read', direction }), a = await r.control.run('owner', { action: 'APPROVE', proposal_id: d.proposal_id, approval_hash: d.approval_hash, confirmation: 'oui' }); r.apply(a.writes[0]); const original = r.registry.lookup.bind(r.registry); let reads = 0; r.registry.lookup = async (key) => { const p = await original(key); return p && ++reads > 1 ? { ...p, pointer_generation: '2' } : p; }; const result = await r.control.run('owner', { action: 'VERIFY', proposal_id: d.proposal_id }); assert.equal(result.status, 'UNCONFIRMED'); assert.equal(result.reason, 'RECIPIENT_ASSIGNMENT_CHANGED'); r.registry.lookup = original; const s = await r.make().run('owner', { action: 'STATUS' }); assert.equal(s.recipients[0].published_version, null); });
// Break: a source-lookup exception leaking provider credentials in a consumption reply.
test('real direction consumption provider errors use closed diagnostics only', async (t) => { const r = await rig(t); await publish(r); const original = r.reader.queryDataSource; r.reader.queryDataSource = async (ds: string, ...args: any[]) => { if (ds === id(4))
    throw Error('PROVIDER_SECRET'); return original(ds, ...args); }; const result = await r.control.run('sellerA', { action: 'VERIFY_CONSUMPTION' }); assert.equal(result.status, 'CONSUMPTION_REQUIRED'); await r.control.run('sellerA', { action: 'CONSUME' }); const failed = await r.control.run('sellerA', { action: 'VERIFY_CONSUMPTION' }); assert.equal(failed.status, 'UNCONFIRMED'); assert.equal(failed.reason, 'SOURCE_OR_JOURNAL_UNAVAILABLE'); assert.equal(JSON.stringify(failed).includes('PROVIDER_SECRET'), false); });
// Break: resurrecting an obsolete package as if it were CURRENT on a verification retry.
test('real direction replay of superseded publication identifies it as historical', async (t) => { const r = await rig(t), { d } = await publish(r); await publish(r, 'REP_A', { ...direction, title: 'Cap v2' }); const old = await r.control.run('owner', { action: 'VERIFY', proposal_id: d.proposal_id }); assert.equal(old.status, 'SUPERSEDED'); assert.equal(old.version, 1); assert.equal(old.current_version, 2); assert.equal(old.writes, undefined); });
