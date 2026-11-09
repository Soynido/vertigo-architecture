/** Named acceptance matrix, synthetic only: NOT five live ChatGPT account proofs. */
import assert from "node:assert/strict";
import {test} from "node:test";
import {buildWorld, handleOf, T0} from "./binding-fixtures.ts";
import {IDS, installRuntime} from "./sales-fixtures.ts";
import {ID as META_ID} from "./meta-fixtures.ts";
import {dispatch} from "../../src/tools/handlers.ts";
import type {Principal} from "../../src/auth/principal.ts";

const cases = [
  {name:"Member C", key:"fleet-member-c", principal:"fixture-member-c", runtime:"SALESOS-FLEET-C", state:"SETUP"},
  {name:"Member A", key:"fleet-member-a", principal:"fixture-member-a", runtime:"SALESOS-FLEET-A", state:"READY"},
  {name:"Owner", key:"fleet-owner", principal:"fixture-owner", runtime:"SALESOS-FLEET-OWNER", state:"READY"},
  {name:"Member J", key:"fleet-member-j", principal:"fixture-member-j", runtime:"SALESOS-FLEET-J", state:"SETUP"},
] as const;
function world() {
  const w=buildWorld();
  const principals:Principal[]=cases.map(c=>({principal_id:c.principal,display_name:"Same display name",status:"ACTIVE",allowed_projects:["VERTIGO"],allowed_lanes:c.name==="Owner"?["SALES","META"]:["SALES"],rep_identity_key:c.key,...(c.name==="Owner"?{meta_authority:"COMPANY_OWNER"}:{})}));
  w.setPrincipals(principals);
  for(const c of cases) installRuntime(w.map,{key:c.key,rootTitle:`${c.name} SALES historical fixture`,instanceId:c.runtime,owner:"Same display name",gmail:`${c.key}@example.invalid`,installState:c.state});
  w.setSalesRegistry(cases.map(c=>({rep_identity_key:c.key,status:"KNOWN",root_ref:IDS(c.key).root,expected_instance_id:c.runtime,expected_gmail_identity:`${c.key}@example.invalid`,pointer_generation:"1"})));
  return w;
}
for(const c of cases) test(`five OS matrix: ${c.name} SALES fresh bindings resolve its own existing runtime, without root mutation`,async()=>{
  const w=world(),before=structuredClone([...w.map]),ctx={principal_id:c.principal,now:T0};
  const a=await dispatch("os_bind",{lane:"SALES"},ctx,w.deps);
  const b=await dispatch("os_bind",{lane:"SALES"},ctx,w.deps);
  for(const r of [a,b]) {
    assert.equal(r.code,"BOUND");
    assert.notEqual(r.binding,"UNKNOWN");
    if(r.binding==="UNKNOWN") throw Error("missing binding");
    assert.equal(r.binding.runtime_id,c.runtime);
    assert.equal((r.observations as {root_ref:string}).root_ref,IDS(c.key).root);
    assert.equal((r.observations as {lifecycle_state:string}).lifecycle_state,c.state);
    assert.equal(r.next.permitted_tool_call,"os_resume");
  }
  assert.notEqual(handleOf(a),handleOf(b),"a fresh chat gets a new handle, not another member's state");
  assert.deepEqual([...w.map],before,"bind must not rewrite progression or source data");
});
test("five OS matrix: owner META and owner SALES stay distinct without borrowing collaborator authority",async()=>{
  const w=world(),ctx={principal_id:"fixture-owner",now:T0};
  const meta=await dispatch("os_bind",{lane:"META"},ctx,w.deps);
  const sales=await dispatch("os_bind",{lane:"SALES"},ctx,w.deps);
  assert.equal(meta.code,"BOUND");assert.equal(sales.code,"BOUND");
  if(meta.binding==="UNKNOWN"||sales.binding==="UNKNOWN") throw Error("missing binding");
  assert.equal(meta.binding.runtime_id,"RT-TEST-01");
  assert.equal((meta.observations as {root_ref:string}).root_ref,META_ID.rootA);
  assert.equal(sales.binding.runtime_id,"SALESOS-FLEET-OWNER");
  assert.notEqual(handleOf(meta),handleOf(sales));
  for(const c of cases.filter(c=>c.name!=="Owner")) {
    const denied=await dispatch("os_bind",{lane:"META"},{principal_id:c.principal,now:T0},w.deps);
    assert.equal(denied.code,"HOLD_UNAUTHORIZED_LANE");
  }
});
test("five OS matrix: every foreign SALES handle is rejected before a source read",async()=>{
  const w=world(),handles=new Map<string,string>();
  for(const c of cases) handles.set(c.principal,handleOf(await dispatch("os_bind",{lane:"SALES"},{principal_id:c.principal,now:T0},w.deps)));
  const forbidden=async()=>{throw Error("FOREIGN_SOURCE_READ");};
  const deps={...w.deps,notion:{retrievePage:forbidden,retrieveDatabase:forbidden,retrieveDataSource:forbidden,retrieveBlockChildren:forbidden,queryDataSource:forbidden}};
  for(const a of cases) for(const b of cases) if(a!==b) {
    const denied=await dispatch("os_resume",{binding_handle:handles.get(a.principal)!},{principal_id:b.principal,now:T0},deps);
    assert.equal(denied.code,"ERROR_PRINCIPAL_MISMATCH",`${b.name} must never consume ${a.name}'s context`);
    assert.deepEqual(denied.observations,{},"refusal carries no foreign source observations");
  }
});
