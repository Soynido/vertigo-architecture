import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const builder=resolve(import.meta.dirname,'../scripts/prepare-sales-bootstrap.mjs');
const skill=resolve(import.meta.dirname,'../../native-sales-bootstrap/SKILL.bootstrap.md');
const sha=b=>createHash('sha256').update(b).digest('hex');
function fixture(t,{wrapper=false,symlink=false}={}){
 const dir=mkdtempSync(join(tmpdir(),'sales-bootstrap-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const source=join(dir,'source'),prefix=wrapper?`${typeof wrapper==='string'?wrapper:'vertigo-fixture'}/`:'',root=join(source,prefix),out=join(dir,'out');mkdirSync(root,{recursive:true});
 const portable={$schema:'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',name:'vertigo-fixture',version:'1.0.283',extensions:{'com.openai':{apps:'./.app.json',interface:{displayName:'Existing private app',defaultPrompt:['Prompt A','Prompt B']}}}};
 const files={'plugin.json':JSON.stringify(portable),'.codex-plugin/plugin.json':JSON.stringify({name:'vertigo-fixture',version:'1.0.283',apps:'./.app.json',interface:{defaultPrompt:['Prompt A','Prompt B']}}),'.app.json':'{"apps":{"existing":{"id":"asdk_app_EXAMPLE"}}}\n','mcp.json':'{"mcpServers":{"existing":{"url":"https://example.test/mcp/PRIVATE_TEST_KEY"}}}\n','skills/vertigo-os/SKILL.md':'---\nname: vertigo-os\ndescription: existing\n---\nOLD','skills/other-skill/SKILL.md':'---\nname: other-skill\ndescription: other\n---\nKEEP','assets/icon.bin':Buffer.from([0,1,254,255])};
 for(const [path,data]of Object.entries(files)){mkdirSync(resolve(root,path,'..'),{recursive:true});writeFileSync(join(root,path),data);}
 if(symlink)symlinkSync('/etc/passwd',join(root,'unsafe-link'));
 const zip=join(dir,'source.zip');execFileSync('zip',['-q','-r','-y',zip,'.'],{cwd:source});
 const run=(extra=[])=>spawnSync(process.execPath,[builder,'--source',zip,'--source-sha256',sha(readFileSync(zip)),'--name','vertigo-fixture','--skill',skill,'--out',out,...extra],{encoding:'utf8'});
 return {dir,source,root,out,zip,prefix,files,run};
}
// Break: a partial or regenerated package drops an App/MCP binding, presentation,
// binary asset, other skill or unknown field while claiming a safe in-place update.
for(const wrapper of [false,true])test(`complete bootstrap candidate retains every non-target byte (wrapper=${wrapper})`,t=>{
 const f=fixture(t,{wrapper}),original=sha(readFileSync(f.zip)),r=f.run();assert.equal(r.status,0,r.stderr);
 const receipt=JSON.parse(r.stdout);assert.equal(receipt.readiness,'CANDIDATE_NOT_FOR_IMPORT');assert.equal(receipt.current_account_source_verified,false);
 assert.equal(receipt.name,'vertigo-fixture');assert.equal(receipt.version,'1.0.284');assert.equal(receipt.source_sha256,original);
 assert.equal(sha(readFileSync(f.zip)),original);assert.equal((r.stdout+r.stderr).includes('PRIVATE_TEST_KEY'),false);
 const entries=execFileSync('unzip',['-Z1',receipt.archive],{encoding:'utf8'}).trim().split('\n');
 for(const [path,bytes]of Object.entries(f.files)){
  assert.ok(entries.includes(f.prefix+path));const actual=execFileSync('unzip',['-p',receipt.archive,f.prefix+path]);
  if(path==='skills/vertigo-os/SKILL.md')assert.deepEqual(actual,readFileSync(skill));
  else if(['plugin.json','.codex-plugin/plugin.json'].includes(path)){const before=JSON.parse(bytes),after=JSON.parse(actual);assert.equal(after.version,'1.0.284');delete before.version;delete after.version;assert.deepEqual(after,before);}
  else assert.deepEqual(actual,Buffer.from(bytes));
 }
});
// Break: a source mix-up overwrites a different person's package or a version
// conflict is hidden behind a new filename instead of rejecting the input.
for(const [label,args,code]of [['wrong identity',['--name','foreign'],'IDENTITY_MISMATCH'],['wrong source digest',['--source-sha256','0'.repeat(64)],'SOURCE_DIGEST_MISMATCH']])test(`candidate rejects ${label} before producing an archive`,t=>{
 const f=fixture(t),r=f.run(args);assert.notEqual(r.status,0);assert.ok(r.stderr.includes(code),r.stderr);assert.equal((r.stdout+r.stderr).includes('PRIVATE_TEST_KEY'),false);assert.equal(readdirSync(f.dir).includes('out'),false);
});
// Break: an archive containing a symlink is repackaged as a trusted update.
test('candidate refuses symlink source entries without extracting or publishing anything',t=>{
 const f=fixture(t,{symlink:true}),r=f.run();assert.notEqual(r.status,0);assert.ok(r.stderr.includes('UNSAFE_ENTRY_MODE'),r.stderr);assert.equal(readdirSync(f.dir).includes('out'),false);
});
// Break: an archive path becomes a command-line option before preservation
// checks can reject its result. No archive member may start an argv option.
test('candidate rejects option-shaped wrapper paths before invoking member operations',t=>{
 const f=fixture(t,{wrapper:'-Ox'}),r=f.run();assert.notEqual(r.status,0);assert.ok(r.stderr.includes('UNSAFE_ARCHIVE_PATH'),r.stderr);assert.equal(readdirSync(f.dir).includes('out'),false);
});
