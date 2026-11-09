import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp,writeFile,readFile,rm,stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {FileSalesRuntimeRegistry} from "../../src/registry/salesRuntimes.ts";
import {synthetic} from "./meta-fixtures.ts";
const hash=(x:Buffer|string)=>createHash("sha256").update(x).digest("hex");
const original='{"other":"unchanged spacing", "runtimes":[{"rep_identity_key":"rep-a","status":"KNOWN","root_ref":"'+synthetic("old-root")+'","expected_instance_id":"SALESOS-OLD","pointer_generation":"2","expected_gmail_identity":"rep-a@example.invalid","activation_proof_plan_id":"old-pilot-proof","snapshot":{"current_gate":"B0_DISCOVERY"}},{"rep_identity_key":"rep-b","status":"NOT_YET_CREATED","note":"preserve"}]}\n';
const target={rep_identity_key:"rep-a",root_ref:synthetic("new-root"),expected_instance_id:"SALESOS-HISTORICAL"};
type Target=typeof target;
type Future=FileSalesRuntimeRegistry&{bridgeLegacyRead?:(sha:string,candidate:Target,backup:string)=>Promise<any>;restoreLegacyRead?:(receipt:any)=>Promise<boolean>};

test("legacy registry: one-entry CAS backup and rollback restore byte-identical registry",async t=>{
 const dir=await mkdtemp(join(tmpdir(),"vertigo-registry-cas-test-"));t.after(()=>rm(dir,{recursive:true}));const path=join(dir,"registry.json"),backup=join(dir,"before.private.json");await writeFile(path,original,{mode:0o600});
 const registry=new FileSalesRuntimeRegistry(path) as Future,r=await registry.bridgeLegacyRead?.(hash(original),target,backup);
 assert.equal(r?.changed,true,"migration routing must have an exact-byte CAS and recoverable backup before use");
 assert.equal((await readFile(backup)).toString(),original);assert.equal((await stat(backup)).mode&0o777,0o600);
 const changed=JSON.parse(await readFile(path,"utf8")),before=JSON.parse(original);assert.deepEqual(changed.runtimes[1],before.runtimes[1]);assert.equal(changed.other,before.other);
 assert.equal(changed.runtimes[0].operation_policy,"LEGACY_READ_ONLY");assert.equal(changed.runtimes[0].pointer_generation,"3");assert.equal(changed.runtimes[0].expected_gmail_identity,"rep-a@example.invalid");
 assert.equal(changed.runtimes[0].activation_proof_plan_id,undefined);assert.equal(changed.runtimes[0].snapshot,undefined);
 assert.equal(await registry.restoreLegacyRead?.(r),true);assert.deepEqual(await readFile(path),Buffer.from(original));
});

test("legacy registry: concurrent edit blocks swap and rollback without overwriting it",async t=>{
 const dir=await mkdtemp(join(tmpdir(),"vertigo-registry-race-test-"));t.after(()=>rm(dir,{recursive:true}));const path=join(dir,"registry.json"),backup=join(dir,"before.private.json");await writeFile(path,original);
 const registry=new FileSalesRuntimeRegistry(path) as Future,stale=await registry.bridgeLegacyRead?.(hash("stale"),target,backup);assert.equal(stale,null);
 assert.deepEqual(await readFile(path),Buffer.from(original));
 const r=await registry.bridgeLegacyRead?.(hash(original),target,backup);assert.equal(r?.changed,true);const concurrent=JSON.stringify({...JSON.parse(await readFile(path,"utf8")),new_owner_change:"preserve"});await writeFile(path,concurrent);
 assert.equal(await registry.restoreLegacyRead?.(r),false);assert.equal(await readFile(path,"utf8"),concurrent);
});
