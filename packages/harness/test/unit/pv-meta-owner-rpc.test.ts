import {test} from "node:test";
import assert from "node:assert/strict";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {FileHttpTokenRegistry,sha256,startHttpServer} from "../../src/server/http.ts";
import {buildResumeWorld,gateRow,runPage,R} from "./resume-fixtures.ts";
import {OWNER} from "./binding-fixtures.ts";
import {createAdapterRegistries} from "../../src/versions/registry.ts";
import {GRAMMAR,specRootChildren} from "./meta-fixtures.ts";
import {registerBuiltinMetaAdapters,metaSpecAdapter,type MetaSpecAdapter} from "../../src/versions/adapters/meta.ts";
import {registerBuiltinControlAdapters} from "../../src/versions/adapters/control.ts";

test("real HTTP/MCP boundary admits the configured authenticated owner only, never a principal/tool-argument spoof",async t=>{
  t.mock.method(console,"error",()=>undefined);
  const w=buildResumeWorld(),a=createAdapterRegistries();registerBuiltinMetaAdapters(a.metaRuntime);registerBuiltinControlAdapters(a.control);
  const m=a.metaRuntime.resolve(a.metaRuntime.supported()[0]!) as MetaSpecAdapter;
  const spec=m.specVersion,schema=m.supportedSchemas[0]!,control=a.control.supported()[0]!;
  w.deps.adapters.metaRuntime.register(spec,metaSpecAdapter(spec,[schema],GRAMMAR));
  w.setSpecRoot(specRootChildren({spec,schema,control}));
  // Synthetic non-TEST identifier exercises the LIVE classification; still a local fixture, not Web evidence.
  w.rotateMeta({runtimeId:"RT-SYNTHETIC-OWNER"});
  w.setMetaManifest({runtimeId:"RT-SYNTHETIC-OWNER",spec,schema,control,setupGate:"M4",setupGateStatus:"PROVISIONAL_PASS",lastRunId:R.run1});
  w.setMetaRuns([runPage({id:R.run1,label:"TRUN-1",status:"HOLD",spec,schema,control,lastEdited:"2025-01-01T00:00:00.000Z",mutationCount:0,verified:0,nextAction:"Verify the historical integration"})]);
  w.setMetaLedger([]);w.setMetaGates([gateRow({id:R.gateM1,key:"M4",status:"PROVISIONAL_PASS",nextAction:"Keep business framing; verify integration before publication"})]);
  const other={...OWNER,principal_id:"p-other-owner"};w.setPrincipals([OWNER,other]);
  const deps={...w.deps,config:{...w.deps.config,metaRecoveryStatusPrincipalIds:[OWNER.principal_id]}};
  const tokens=new FileHttpTokenRegistry([{token_sha256:sha256("owner-fixture-token"),principal_id:OWNER.principal_id},{token_sha256:sha256("other-fixture-token"),principal_id:other.principal_id}]);
  const s=await startHttpServer(deps,tokens,0);const envelopes=[];
  try{
    for(const [token,want] of [["owner-fixture-token",true],["other-fixture-token",false]] as const){
      const c=new Client({name:"owner-admission-test",version:"1"});
      const transport=new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${s.port}/mcp`),{requestInit:{headers:{authorization:`Bearer ${token}`}}});
      await c.connect(transport as unknown as Parameters<typeof c.connect>[0]);
      try{
        const call=async(name:string,args:Record<string,unknown>)=>{const reply=await c.callTool({name,arguments:args});return JSON.parse((reply.content as Array<{text:string}>)[0]!.text);};
        const bound=await call("os_bind",{lane:"META"});assert.equal(bound.code,"BOUND");
        const state=await call("os_resume",{binding_handle:bound.result.binding_handle,topic_hint:"CURRENT_WORK"});
        assert.equal(state.code,"HOLD_RECOVERY_REQUIRED");assert.equal(state.binding.runtime_scope,"LIVE");
        assert.equal(state.observations.gate.gate_key,"M4");assert.equal(state.observations.current_run.harness_plan_id,"UNKNOWN");
        assert.equal(state.observations.open_backend_plan,"NONE");assert.equal(state.next.permitted_tool_call,undefined);
        assert.equal(state.next.conduct.includes("This reliable META recovery HOLD carries already-read state"),want);
        envelopes.push(state);
        const spoof=await c.callTool({name:"os_resume",arguments:{binding_handle:bound.result.binding_handle,principal_id:OWNER.principal_id,meta_recovery_status:true}});
        assert.equal(spoof.isError,true,"the MCP input schema rejects a caller-supplied principal or rollout flag");
        assert.doesNotMatch((spoof.content as Array<{text:string}>)[0]!.text,/This reliable META recovery HOLD/);
      }finally{await c.close();}
    }
  }finally{await s.close();}
  assert.deepEqual(envelopes[0].observations,envelopes[1].observations,"same observed state; admission changes presentation only");
});
