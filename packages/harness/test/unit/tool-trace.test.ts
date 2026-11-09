import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beginToolTrace, finishToolTrace, traceHttpAuth, withHttpTrace, type HttpAuthDiagnostic } from "../../src/server/toolTrace.ts";
import * as tracing from "../../src/server/toolTrace.ts";
// Break: a forged runtime payload is logged as an installed update, leaks text,
// or expands the existing bounded terminal log with unbounded capsule contents.
test('bootstrap offer trace is closed and cannot imply client installation',t=>{
 const lines:string[]=[];t.mock.method(console,'error',(s:string)=>lines.push(s));
 const offer={protocol:'OWN_ACCOUNT_PLUGIN_UPDATE/1',status:'PROCEDURE_OFFERED',revision:1,authority_granted:false,payload_sha256:'a'.repeat(64),procedure:'PRIVATE_TEXT'};
 for(const [tool,status,update]of [['vertigo_sales_control','OBSERVED',offer],['vertigo_meta_control','OBSERVED',offer],['vertigo_sales_control','ACCESS_DENIED',offer],['vertigo_sales_control','OBSERVED',{...offer,revision:'PRIVATE_TEXT',payload_sha256:'PRIVATE_TEXT'}]] as const){
  tracing.finishNativeToolTrace(tracing.beginNativeToolTrace(tool,'seller','CONTEXT'),{status,runtime_contract:{bootstrap_update:update}});
 }
 const offers=lines.filter(s=>s.includes('event=BOOTSTRAP_OFFER'));
 assert.equal(offers.length,1);assert.match(offers[0]!,/offer=PROCEDURE_AVAILABLE update_revision=1 proof=SERVER_OFFER_ONLY/);
 assert.ok(lines.every(s=>s.length<=640&&!s.includes('PRIVATE_TEXT')&&!s.includes('installed=true')));
});
// Break: a partial Gmail failure disappears behind HTTP 200 or leaks raw error text.
test('native step diagnostics preserve declared partial counts without promoting source proof',t=>{
 const lines:string[]=[];t.mock.method(console,'error',(line:string)=>lines.push(line));
 tracing.finishNativeToolTrace(tracing.beginNativeToolTrace('vertigo_sales_control','seller','REPORT_STEP'),{status:'REPORTED',proof_level:'AGENT_REPORTED',step:{connector:'GMAIL',operation:'CREATE_DRAFT',outcome:'PARTIAL',reason:'PROVIDER_ERROR',attempted:150,confirmed:12},private:'NEVER_LOG'});
 assert.match(lines.at(-1)!,/action=REPORT_STEP outcome=REPORTED/);
 assert.match(lines.at(-1)!,/step_proof=AGENT_REPORTED connector=GMAIL operation=CREATE_DRAFT step_outcome=PARTIAL step_reason=PROVIDER_ERROR attempted=150 confirmed=12/);
 assert(!lines.join('').includes('NEVER_LOG'));
});

// Break: transport success hides the closed workflow issue, or emits arbitrary Notion prose in diagnostics.
test('native trace reports administrative workflow issues without source text or false global hold',t=>{
 const lines:string[]=[];t.mock.method(console,'error',(line:string)=>lines.push(line));
 const trace=tracing.beginNativeToolTrace('vertigo_sales_control','seller','CONTEXT');
 tracing.finishNativeToolTrace(trace,{status:'OBSERVED',workflow:{gate:'B7_DRY_RUN',issues:['RUN_STATE_GATE_MISMATCH','PRIVATE_SECRET/NEVER_LOG'],independent_work_blocked:false}});
 assert.match(lines.at(-1)!,/workflow_gate=B7_DRY_RUN workflow_issues=RUN_STATE_GATE_MISMATCH/);assert(!lines.join('').includes('PRIVATE_SECRET'));assert(lines.at(-1)!.length<640);
});

// Break: native control calls cannot be tied to their HTTP request/profile, or leak arguments.
test("native diagnostics correlate authenticated profile, action and duration without business content", async t => {
  const lines:string[]=[];t.mock.method(console,'error',(line:string)=>lines.push(line));
  const begin=(tracing as any).beginNativeToolTrace,finish=(tracing as any).finishNativeToolTrace;
  assert.equal(typeof begin,'function','native correlation is missing');assert.equal(typeof finish,'function');
  const res=Object.assign(new EventEmitter(),{statusCode:200})as unknown as ServerResponse;
  const secret='private@example.invalid/NEVER_LOG';
  await withHttpTrace({method:'POST'}as IncomingMessage,res,async()=>{
   const trace=begin('vertigo_sales_control','p-CollaboratorBeta-pilot','CONTEXT');
   finish(trace,{status:'OBSERVED',context:{mailbox:secret},reason:secret});res.emit('finish');
  });
  const starts=lines.filter(x=>x.includes('event=START')&&x.includes('tool=')),ends=lines.filter(x=>x.includes('event=END'));
  assert.equal(starts.length,1);assert.equal(ends.length,1);
  const request=lines[0]!.match(/request=([a-f0-9]{16})/)![1];
  assert.match(starts[0]!,new RegExp('request='+request));assert.match(ends[0]!,new RegExp('request='+request));
  assert.match(ends[0]!,/action=CONTEXT outcome=OBSERVED code=UNKNOWN .*elapsed_ms=\d+/);
  assert.match(ends[0]!,/profile=[a-f0-9]{16}/);
  assert(lines.every(x=>!x.includes(secret)&&!x.includes('p-CollaboratorBeta-pilot')&&x.length<640));
  const a=begin('vertigo_sales_control','p-CollaboratorGamma-pilot',secret);finish(a,{status:secret,reason:secret});
  assert.match(lines.at(-1)!,/action=UNKNOWN outcome=UNKNOWN code=UNKNOWN/);
  assert.notEqual(lines.at(-1)!.match(/profile=([a-f0-9]{16})/)![1],ends[0]!.match(/profile=([a-f0-9]{16})/)![1]);
});

test("real direction diagnostics distinguish approval and reception without logging payloads", t => {
  const lines:string[]=[];t.mock.method(console,"error",(line:string)=>lines.push(line));
  const secret="PRIVATE_DIRECTION_CONTENT@example.invalid";
  for(const [action,status] of [["APPROVE","APPROVED_PENDING_NOTION"],["CONSUME","CONSUMPTION_PENDING_NOTION"],["VERIFY_CONSUMPTION","CONSUMED"]]){
    tracing.finishNativeToolTrace(tracing.beginNativeToolTrace("vertigo_direction_control","seller",action),{status,direction:secret,confirmation:secret,receipt_id:secret});
    assert.match(lines.at(-1)!,new RegExp(`action=${action} outcome=${status} code=NONE`));
  }
  tracing.finishNativeToolTrace(tracing.beginNativeToolTrace("vertigo_direction_control","seller","VERIFY"),{status:"UNCONFIRMED",reason:"RECIPIENT_ASSIGNMENT_CHANGED",private:secret});
  assert.match(lines.at(-1)!,/code=RECIPIENT_ASSIGNMENT_CHANGED/);
  assert(lines.every(line=>!line.includes(secret)&&line.length<=640));
  tracing.finishNativeToolTrace(tracing.beginNativeToolTrace("vertigo_direction_control","owner","PREPARE"),{status:"DRAFT",direction:{title:secret}});
  assert(!lines.at(-1)!.includes("direction_status="));
});

test("seller diagnostics expose a localized direction refusal even when native context is observed", t=>{
  const lines:string[]=[];t.mock.method(console,"error",(line:string)=>lines.push(line));
  tracing.finishNativeToolTrace(tracing.beginNativeToolTrace("vertigo_sales_control","seller","CONTEXT"),{status:"OBSERVED",direction:{status:"UNCONFIRMED",reason:"MISSING_RECORD",direction:"NEVER_LOG_PRIVATE_META"}});
  assert.match(lines.at(-1)!,/outcome=OBSERVED.*direction_status=UNCONFIRMED direction_code=MISSING_RECORD/);
  assert(!lines.join("").includes("NEVER_LOG_PRIVATE_META"));
});
// Break: a successful Sales read hides which version was returned or whether its acknowledgement is still due.
for(const [tool,action,reply,want]of[
 ['vertigo_sales_control','CONTEXT',{status:'OBSERVED',direction:{status:'PUBLISHED_DIRECTION',version:7,needs_consumption:true}},'direction_version=7 direction_ack=DUE'],
 ['vertigo_sales_control','CONTEXT',{status:'OBSERVED',direction:{status:'PUBLISHED_DIRECTION',version:7,needs_consumption:false}},'direction_version=7 direction_ack=RECORDED'],
 ['vertigo_direction_control','CONTEXT',{status:'PUBLISHED_DIRECTION',version:7,needs_consumption:true},'direction_version=7 direction_ack=DUE'],
 ['vertigo_direction_control','CONSUME',{status:'CONSUMED',version:7},'receipt_version=7'],
 ['vertigo_direction_control','VERIFY_CONSUMPTION',{status:'CONSUMED',version:7},'receipt_version=7'],
]as const)test(`native direction trace projects the observed stage ${tool}/${action}/${want}`,t=>{
 const lines:string[]=[];t.mock.method(console,'error',(s:string)=>lines.push(s));const before=structuredClone(reply);
 tracing.finishNativeToolTrace(tracing.beginNativeToolTrace(tool,'seller',action),reply);
 assert(lines.at(-1)!.includes(want));assert.deepEqual(reply,before);assert(lines.at(-1)!.length<=640);
});

// Break: attacker-controlled strings/numbers become log fields, or an old journal flag is labelled fresh receipt verification.
test('direction diagnostic metadata is bounded and never coerces untrusted values',t=>{
 const lines:string[]=[];t.mock.method(console,'error',(s:string)=>lines.push(s));
 const secret='PRIVATE_META@example.invalid/NEVER_LOG';
 for(const value of[secret,-1,0,1.5,NaN,Infinity,1_000_001,Number.MAX_SAFE_INTEGER,{},null]){
  tracing.finishNativeToolTrace(tracing.beginNativeToolTrace('vertigo_sales_control','seller','CONTEXT'),{status:'OBSERVED',direction:{status:'PUBLISHED_DIRECTION',version:value,needs_consumption:secret,direction:{title:secret},receipt_id:secret}});
  assert.match(lines.at(-1)!,/direction_version=UNKNOWN direction_ack=UNKNOWN/);
 }
 assert(lines.every(line=>!line.includes(secret)&&!line.includes('VERIFIED')&&line.length<=640));
});

// Break: nested publication metadata makes a denied/expired/failed result look like a loaded or acknowledged version.
test('direction diagnostics do not project a version from a refused or unrelated action',t=>{
 const lines:string[]=[];t.mock.method(console,'error',(s:string)=>lines.push(s));
 for(const[tool,action,reply]of[
  ['vertigo_sales_control','CONTEXT',{status:'ACCESS_DENIED',direction:{status:'PUBLISHED_DIRECTION',version:7,needs_consumption:false}}],
  ['vertigo_sales_control','VERIFY_RECEIPT',{status:'OBSERVED',direction:{status:'PUBLISHED_DIRECTION',version:7,needs_consumption:false}}],
  ['vertigo_sales_control','CONTEXT',{status:'OBSERVED',direction:{status:'EXPIRED_DIRECTION',version:7,needs_consumption:false}}],
  ['vertigo_direction_control','VERIFY_CONSUMPTION',{status:'UNCONFIRMED',version:7}],
  ['vertigo_direction_control','APPROVE',{status:'CONSUMED',version:7}],
 ]as const){tracing.finishNativeToolTrace(tracing.beginNativeToolTrace(tool,'seller',action),reply);assert(!/direction_version=|direction_ack=|receipt_version=/.test(lines.at(-1)!));}
});

// Break: combining all supported bookkeeping diagnostics exceeds the operator log-line budget after metadata is added.
test('version and acknowledgement fit the worst supported Sales workflow log line',t=>{
 const lines:string[]=[];t.mock.method(console,'error',(s:string)=>lines.push(s));
 tracing.finishNativeToolTrace(tracing.beginNativeToolTrace('vertigo_sales_control','seller','CONTEXT'),{status:'OBSERVED',workflow:{gate:'B7_DRY_RUN',issues:['MANIFEST_STATE_GATE_MISMATCH','RUN_STATE_GATE_MISMATCH','GATE_TRANSITION_PROOF_MISSING','RUN_VERIFICATION_INCOMPLETE','RUN_MUTATION_REFS_MISSING','RUN_VERIFIED_AT_MISSING']},direction:{status:'PUBLISHED_DIRECTION',version:1_000_000,needs_consumption:false}});
 assert.match(lines.at(-1)!,/direction_version=1000000 direction_ack=RECORDED/);assert(lines.at(-1)!.length<=640);
});

test('orientation trace identifies its native phase and closed refusal without leaking a write plan',t=>{
  const lines:string[]=[];t.mock.method(console,'error',(s:string)=>lines.push(s));
  tracing.finishNativeToolTrace(tracing.beginNativeToolTrace('vertigo_direction_control','owner','VERIFY'),{status:'APPROVED_PENDING_NOTION',contract:'META_ORIENTATION/1.0',phase:'WRITE_CURRENT',writes:[{secret:'NEVER_LOG_PLAN'}]});
  assert.match(lines.at(-1)!,/orientation_contract=META_ORIENTATION\/1.0 orientation_phase=WRITE_CURRENT/);
  tracing.finishNativeToolTrace(tracing.beginNativeToolTrace('vertigo_direction_control','owner','VERIFY'),{status:'UNCONFIRMED',reason:'NATIVE_REFERENCE_MISMATCH',contract:'NEVER_LOG_PLAN',phase:'NEVER_LOG_PLAN'});
  assert.match(lines.at(-1)!,/code=NATIVE_REFERENCE_MISMATCH/);assert.match(lines.at(-1)!,/orientation_contract=UNKNOWN orientation_phase=UNKNOWN/);
  assert(lines.every(l=>!l.includes('NEVER_LOG_PLAN')&&l.length<640));
});

test("diagnostic projection retains only closed fields, unknowns and bounded counts", t => {
  const lines: string[] = []; t.mock.method(console, "error", (line: string) => lines.push(line));
  const secret = "PRIVATE@example.invalid/never-log-me";
  finishToolTrace(beginToolTrace("os_commit"), { kind: "INTERRUPTED", phase: "STATE_LAST", reason: "GUARD_DRIFT",
    writes_done: 6, writes_total: 7, plan_id: secret, failed_symbol: secret, evidence: [secret], say: secret });
  assert.match(lines[1]!, /outcome=INTERRUPTED .*phase=STATE_LAST progress=GUARD_DRIFT writes_done=6 writes_total=7/);
  finishToolTrace(beginToolTrace(secret), { kind: secret, code: secret, phase: secret, reason: secret,
    writes_done: -1, writes_total: Infinity, writes_sent: 1e12, next: { permitted_tool_call: secret, conduct: secret },
    source_identity_enrollment: { protocol: secret, stage: secret }, observations: { private: secret } });
  assert.match(lines[3]!, /tool=UNKNOWN outcome=UNKNOWN code=UNKNOWN/);
  assert.match(lines[3]!, /source_stage=UNKNOWN next=NONE/);
  assert.match(lines[3]!, /writes_done=UNKNOWN writes_total=UNKNOWN writes_sent=1000000/);
  finishToolTrace(beginToolTrace("os_commit"), { kind: "HELD", code: "HOLD_ACTION_NOT_AUTHORIZED", phase: "PREPARE",
    evidence: ["first-link challenge is invalid for the current binding and authority", "SOURCE_ENROLLMENT_AUTHORITY_MISMATCH:" + Array(2000).fill("principal").join(",")] });
  assert.match(lines[5]!, /diagnostic=OMITTED_BOUND$/);
  assert.ok(lines.every(l => l.length <= 640 && !l.includes(secret)));
  assert.equal(new Set(lines.filter(l => l.includes("event=START")).map(l => l.match(/call=([a-f0-9]{16})/)?.[1])).size, 3);
});

test("HTTP close before finish is interruption, not a successful delivery or authentication", async t => {
  const lines: string[] = []; t.mock.method(console, "error", (line: string) => lines.push(line));
  const response = Object.assign(new EventEmitter(), { statusCode: 200 }) as unknown as ServerResponse;
  const req = { method: "POST" } as IncomingMessage;
  await withHttpTrace(req, response, async () => { response.emit("close"); response.emit("finish"); });
  assert.equal(lines.length, 2);
  assert.match(lines[1]!, /delivery=CLOSED_BEFORE_FINISH http_status=UNKNOWN/);
  assert.ok(lines.every(l => !l.includes("auth=ACCEPTED")));
});

test("HTTP correlations are isolated across concurrent requests", async t => {
  const lines: string[] = []; t.mock.method(console, "error", (line: string) => lines.push(line));
  const exchange = (tool: string) => {
    const res = Object.assign(new EventEmitter(), { statusCode: 200 }) as unknown as ServerResponse;
    return withHttpTrace({ method: "POST" } as IncomingMessage, res, async () => {
      await Promise.resolve(); traceHttpAuth(true); const trace = beginToolTrace(tool);
      await Promise.resolve(); finishToolTrace(trace, { status: "OK", code: "RESUMED" }); res.emit("finish");
    });
  };
  await Promise.all([exchange("os_resume"), exchange("os_handoff")]);
  const starts = lines.filter(l => l.includes("event=HTTP_START")); assert.equal(starts.length, 2);
  const ids = starts.map(l => l.match(/request=([a-f0-9]{16})/)?.[1]); assert.notEqual(ids[0], ids[1]);
  for (const id of ids) {
    const own = lines.filter(l => l.includes(`request=${id}`)); assert.equal(own.length, 5);
    assert.equal(new Set(own.filter(l => l.includes("tool=")).map(l => l.match(/tool=(\w+)/)?.[1])).size, 1);
  }
});

test("HTTP auth diagnostic projection rejects untrusted enum values and never logs their content", async t => {
  const lines: string[] = []; t.mock.method(console, "error", (line: string) => lines.push(line));
  const secret = "secret@example.invalid/NEVER_LOG_ME";
  const res = Object.assign(new EventEmitter(), { statusCode: 401 }) as unknown as ServerResponse;
  await withHttpTrace({ method: "POST" } as IncomingMessage, res, async () => {
    traceHttpAuth(false, { bearer: secret, path: secret, pathEnabled: secret, source: secret } as unknown as HttpAuthDiagnostic);
    res.emit("finish");
  });
  assert.match(lines[1]!, /auth=DENIED bearer=UNKNOWN path=UNKNOWN path_enabled=UNKNOWN source=UNKNOWN$/);
  assert.ok(lines.every(line => line.length <= 640 && !line.includes(secret)));
});

test("META resume trace distinguishes returned business sources from selection failure without logging their contents", t => {
  const lines: string[] = []; t.mock.method(console, "error", (line: string) => lines.push(line));
  const secret = "private-user-binding@example.invalid/NEVER_LOG_THIS";
  finishToolTrace(beginToolTrace("os_resume"), {status:"OK",code:"RESUMED",binding:{lane:"META",principal_id:secret},result:{
    contract_pack:{normalized_needs:["CURRENT_WORK"],completeness_reason:"NONE"},
    local_meta_operating_context:{status:"PARTIAL",documents:[{items:[secret]},{items:[secret]}],tables:[{rows:Array(10).fill(secret)},{rows:Array(10).fill(secret)}]}
  }});
  assert.match(lines[1]!, /meta_needs=CURRENT_WORK meta_reason=NONE meta_context=PARTIAL meta_documents=2 meta_rows=20/);
  finishToolTrace(beginToolTrace("os_resume"), {status:"OK",code:"RESUMED",binding:{lane:"META"},result:{contract_pack:{normalized_needs:["CURRENT_WORK"],completeness_reason:"unknown_need_token"}}});
  assert.match(lines[3]!, /meta_needs=CURRENT_WORK meta_reason=unknown_need_token meta_context=NONE meta_documents=UNKNOWN meta_rows=UNKNOWN/);
  assert(lines.every(line=>!line.includes(secret)&&line.length<=640));
});

test("META context diagnostic rejects malformed enum or source data and leaves other lanes unchanged", t => {
  const lines: string[] = []; t.mock.method(console, "error", (line: string) => lines.push(line));
  const secret="BAD_SECRET@example.invalid/DO_NOT_LOG";
  finishToolTrace(beginToolTrace("os_resume"), {status:"OK",code:"RESUMED",binding:{lane:"META"},result:{contract_pack:{normalized_needs:[secret,"CURRENT_WORK"],completeness_reason:secret},local_meta_operating_context:{status:secret,documents:secret,tables:secret}}});
  assert.match(lines[1]!, /meta_needs=CURRENT_WORK meta_reason=UNKNOWN meta_context=UNKNOWN meta_documents=UNKNOWN meta_rows=UNKNOWN/);
  finishToolTrace(beginToolTrace("os_resume"), {status:"OK",code:"RESUMED",binding:{lane:"SALES"},result:{local_meta_operating_context:{status:"PARTIAL",documents:[],tables:[]}}});
  assert(!lines[3]!.includes("meta_context="));
  assert(lines.every(line=>!line.includes(secret)&&line.length<=640));
});
