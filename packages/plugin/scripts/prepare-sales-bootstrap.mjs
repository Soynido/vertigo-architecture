#!/usr/bin/env node
/** Private candidate only. A local export checksum never establishes the release
 * currently installed in somebody else's account. No upload/install/server call. */
import {execFileSync} from 'node:child_process';
import {constants,mkdtempSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
const stop=code=>{throw new Error(code);};
const args=process.argv.slice(2),flags=['--source','--source-sha256','--name','--skill','--out'];
const option=key=>{const i=args.lastIndexOf(key);return i<0?undefined:args[i+1];};
const unzip=(zip,...args)=>execFileSync('unzip',args.concat(zip),{stdio:['ignore','pipe','pipe'],maxBuffer:6*1024*1024});
const list=zip=>unzip(zip,'-Z1').toString('utf8').trim().split('\n');
const bytes=(zip,path)=>execFileSync('unzip',['-p',zip,path],{stdio:['ignore','pipe','pipe'],maxBuffer:5*1024*1024});
const safePath=path=>path.length<=240&&/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\/?$/.test(path)&&path.split('/').every(p=>p!=='.'&&p!=='..'&&!p.startsWith('-'));
let scratch;
try{
 if(args.length%2||args.some((v,i)=>i%2===0&&!flags.includes(v))||flags.some(f=>!option(f)||option(f).startsWith('--')))stop('INVALID_ARGUMENT');
 const source=resolve(option('--source')),expected=option('--source-sha256'),name=option('--name');
 if(!/^[a-f0-9]{64}$/.test(expected)||!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(name)||name.length>64)stop('INVALID_ARGUMENT');
 if(!statSync(source).isFile()||statSync(source).size>16*1024*1024)stop('ARCHIVE_BOUND');
 const original=readFileSync(source);if(sha(original)!==expected)stop('SOURCE_DIGEST_MISMATCH');
 const newSkill=readFileSync(resolve(option('--skill')));
 if(newSkill.length>1024*1024||!/^---\r?\nname: vertigo-os\r?\ndescription: [^\r\n]+\r?\n---\r?\n/.test(newSkill.toString('utf8')))stop('INVALID_SKILL');
 scratch=mkdtempSync(join(tmpdir(),'vertigo-sales-package-'));
 const input=join(scratch,'source.zip');writeFileSync(input,original,{mode:0o600,flag:'wx'});
 const entries=list(input);
 if(entries.length>128||new Set(entries).size!==entries.length||entries.some(p=>!safePath(p)))stop('UNSAFE_ARCHIVE_PATH');
 const modes=unzip(input,'-Z','-l').toString('utf8').split('\n').filter(s=>/^[dl-][rwxstST-]{9}\s/.test(s));
 if(modes.length!==entries.length||modes.some(s=>s[0]==='l'))stop('UNSAFE_ENTRY_MODE');
 let total=0;for(const mode of modes){const size=Number(mode.match(/^[dl-][rwxstST-]{9}\s+\S+\s+\S+\s+(\d+)/)?.[1]);if(!Number.isSafeInteger(size)||size>5*1024*1024||(total+=size)>16*1024*1024)stop('ARCHIVE_BOUND');}
 const roots=entries.filter(p=>p==='plugin.json'||/^[^.\/][^/]*\/plugin\.json$/.test(p));if(roots.length!==1)stop('AMBIGUOUS_PLUGIN_ROOT');
 const prefix=roots[0].slice(0,-'plugin.json'.length),manifest=JSON.parse(bytes(input,roots[0]));
 const skillPath=prefix+'skills/vertigo-os/SKILL.md',legacyPath=prefix+'.codex-plugin/plugin.json';
 if(manifest.name!==name)stop('IDENTITY_MISMATCH');
 if(manifest.$schema!=='https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'||!entries.includes(skillPath))stop('UNSUPPORTED_PACKAGE');
 if(entries.some(p=>!p.startsWith(prefix)))stop('UNRELATED_SIBLING');
 const match=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(manifest.version??'');
 if(!match||match.slice(1).some(n=>!Number.isSafeInteger(Number(n)))||Number(match[3])>=Number.MAX_SAFE_INTEGER)stop('UNSUPPORTED_VERSION');
 const version=`${match[1]}.${match[2]}.${Number(match[3])+1}`;
 const changes=new Map([[roots[0],Buffer.from(JSON.stringify({...manifest,version},null,2)+'\n')],[skillPath,newSkill]]);
 if(entries.includes(legacyPath)){const legacy=JSON.parse(bytes(input,legacyPath));if(legacy.name!==name||legacy.version!==manifest.version)stop('MANIFEST_MISMATCH');changes.set(legacyPath,Buffer.from(JSON.stringify({...legacy,version},null,2)+'\n'));}
 const before=new Map();for(const path of entries)if(!path.endsWith('/'))before.set(path,bytes(input,path));
 const stage=join(scratch,'stage');mkdirSync(stage,{mode:0o700});
 for(const[path,data]of changes){mkdirSync(dirname(join(stage,path)),{recursive:true});writeFileSync(join(stage,path),data,{mode:0o600,flag:'wx'});}
 const candidate=join(scratch,'candidate.zip');copyFileSync(input,candidate,constants.COPYFILE_EXCL);
 execFileSync('zip',['-q','-d',candidate,...changes.keys()],{stdio:['ignore','pipe','pipe']});
 execFileSync('zip',['-q',candidate,...changes.keys()],{cwd:stage,stdio:['ignore','pipe','pipe']});
 const afterEntries=list(candidate);if(JSON.stringify([...afterEntries].sort())!==JSON.stringify([...entries].sort()))stop('INVENTORY_CHANGED');
 for(const[path,data]of before)if(!bytes(candidate,path).equals(changes.get(path)??data))stop('PRESERVATION_FAILED');
 const out=resolve(option('--out'));mkdirSync(out,{recursive:true,mode:0o700});
 const archive=join(out,`${name}-${version}-CANDIDAT-NE-PAS-IMPORTER.zip`),finalBytes=readFileSync(candidate);
 writeFileSync(archive,finalBytes,{mode:0o600,flag:'wx'});
 console.log(JSON.stringify({readiness:'CANDIDATE_NOT_FOR_IMPORT',current_account_source_verified:false,name,version,source_sha256:expected,skill_sha256:sha(newSkill),archive,archive_sha256:sha(finalBytes),changed_paths:[...changes.keys()],preserved_files:before.size-changes.size,installation:'NOT_PERFORMED',server_deployment:'NOT_PERFORMED'}));
}catch(error){
 const closed=['INVALID_ARGUMENT','ARCHIVE_BOUND','SOURCE_DIGEST_MISMATCH','INVALID_SKILL','UNSAFE_ARCHIVE_PATH','UNSAFE_ENTRY_MODE','AMBIGUOUS_PLUGIN_ROOT','IDENTITY_MISMATCH','UNSUPPORTED_PACKAGE','UNRELATED_SIBLING','UNSUPPORTED_VERSION','MANIFEST_MISMATCH','INVENTORY_CHANGED','PRESERVATION_FAILED'];
 console.error(JSON.stringify({error:closed.includes(error.message)?error.message:'PREPARATION_FAILED',source_contents_disclosed:false}));process.exitCode=1;
}finally{if(scratch)rmSync(scratch,{recursive:true,force:true});}
