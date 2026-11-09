/** Administrator diagnostics only. No arguments, business IDs, free text or authority are logged. */
import { createHash, randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ERROR_CODES, HOLD_CODES, OK_CODES, TRANSACTION_HOLD_CODES } from "../errors/codes.ts";
import { SOURCE_ENROLLMENT_PROTOCOL, sourceEnrollmentLogDiagnostic } from "../resume/sourceEnrollment.ts";
import { CONTEXT_NEEDS } from "../contractPack/catalog.ts";
import {nativeStepSchema} from '../verify/nativeSalesControl.ts';

const requests = new AsyncLocalStorage<string>();
const tools = ["os_bind", "os_resume", "os_commit", "os_handoff", "os_control_status"];
const codes = [...ERROR_CODES, ...HOLD_CODES, ...OK_CODES, ...TRANSACTION_HOLD_CODES, "HOLD_SCHEMA_VALUE_UNSUPPORTED", "NONE"];
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const closed = (v: unknown, allowed: readonly string[], fallback = "UNKNOWN") => typeof v === "string" && allowed.includes(v) ? v : fallback;
const count = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? String(Math.min(v, 1_000_000)) : "UNKNOWN";
const directionVersion = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= 1_000_000 ? String(v) : 'UNKNOWN';
const elapsed = (start: number) => count(Math.max(0, Math.floor(performance.now() - start)));
const emit = (fields: string) => console.error(`${new Date().toISOString()} ${fields}`);

/** The ID belongs to this HTTP exchange, not the token, principal, session or business transaction. */
export function withHttpTrace<T>(req: IncomingMessage, res: ServerResponse, fn: () => Promise<T>): Promise<T> {
  const id = randomBytes(8).toString("hex"), started = performance.now();
  const base = `request=${id} method=${closed(req.method, ["POST", "GET", "OPTIONS"], "OTHER")}`;
  emit(`event=HTTP_START ${base}`);
  let ended = false;
  const end = (delivery: "FINISHED" | "CLOSED_BEFORE_FINISH") => {
    if (ended) return; ended = true;
    const status = delivery === "FINISHED" && Number.isInteger(res.statusCode) && res.statusCode >= 100 && res.statusCode <= 599 ? String(res.statusCode) : "UNKNOWN";
    // finish proves only server-side response completion, NEVER rendering/receipt in the assistant.
    emit(`event=HTTP_END ${base} delivery=${delivery} http_status=${status} elapsed_ms=${elapsed(started)}`);
  };
  res.on("finish", () => end("FINISHED"));
  res.on("close", () => end("CLOSED_BEFORE_FINISH"));
  return requests.run(id, fn);
}

export interface HttpAuthDiagnostic {
  readonly bearer: "ABSENT" | "MALFORMED" | "UNMAPPED" | "MAPPED";
  readonly path: "ABSENT" | "MALFORMED" | "DISABLED" | "UNMAPPED" | "MAPPED" | "NOT_CHECKED";
  readonly pathEnabled: boolean;
  readonly source: "NONE" | "BEARER" | "PATH";
}

export function traceHttpAuth(accepted: boolean, diagnostic?: HttpAuthDiagnostic): void {
  const request = requests.getStore();
  const fields = diagnostic
    ? ` bearer=${closed(diagnostic.bearer, ["ABSENT", "MALFORMED", "UNMAPPED", "MAPPED"])}`
      + ` path=${closed(diagnostic.path, ["ABSENT", "MALFORMED", "DISABLED", "UNMAPPED", "MAPPED", "NOT_CHECKED"])}`
      + ` path_enabled=${typeof diagnostic.pathEnabled === "boolean" ? String(diagnostic.pathEnabled) : "UNKNOWN"}`
      + ` source=${closed(diagnostic.source, ["NONE", "BEARER", "PATH"])}`
    : "";
  if (request) emit(`event=HTTP_AUTH request=${request} auth=${accepted ? "ACCEPTED" : "DENIED"}${fields}`);
}

export interface ToolTrace { readonly id: string; readonly started: number; readonly tool: string; readonly request: string }
export interface NativeToolTrace extends ToolTrace {readonly profile:string;readonly action:string}
const orientationCodes=['PUBLICATION_UNCONFIRMED','UNMANAGED_CURRENT_POINTER','CURRENT_POINTER_CHANGED','INCOMPLETE_NATIVE_READ','INVALID_NATIVE_BINDING','NATIVE_REFERENCE_MISMATCH','NATIVE_FIELDS_MISMATCH','NATIVE_SCHEMA_MISMATCH','NATIVE_SCOPE_MISMATCH','NATIVE_TIMESTAMP_MISMATCH','MISSING_NATIVE_PROOF','AMBIGUOUS_NATIVE_PROOF','CURRENT_NOT_LAST','NATIVE_CHANGED_DURING_READ','ORPHAN_NATIVE_TARGET','NATIVE_RUN_HELD','NATIVE_ATTEMPT_UNCONFIRMED','NATIVE_ATTEMPT_BOUND','NATIVE_WRITE_ATTEMPT_UNCONFIRMED','UNEXPECTED_NATIVE_MUTATION','NATIVE_PROOF_UNAVAILABLE'];
/** Pseudonymous administrator correlation only; no argument or result payload is serialized. */
export function beginNativeToolTrace(tool:string,principalId:string,action:unknown):NativeToolTrace{
 const trace={id:randomBytes(8).toString('hex'),started:performance.now(),tool:closed(tool,['vertigo_sales_control','vertigo_meta_control','vertigo_note_control','vertigo_note_read','vertigo_direction_control']),request:requests.getStore()??'NONE',profile:createHash('sha256').update('VERTIGO_NATIVE_TRACE/1\0'+principalId).digest('hex').slice(0,16),action:closed(action,['CONTEXT','VERIFY_RECEIPT','REPORT_STEP','STATUS','PREPARE','VERIFY','READ','APPROVE','CONSUME','VERIFY_CONSUMPTION'])};
 emit(`tool=${trace.tool} event=START call=${trace.id} request=${trace.request} profile=${trace.profile} action=${trace.action}`);return trace;
}
export function finishNativeToolTrace(trace:NativeToolTrace,reply:unknown):void{
 const report=record(reply);if(trace.tool==='vertigo_sales_control'&&trace.action==='REPORT_STEP'&&report.status==='REPORTED'){
  const parsed=nativeStepSchema.safeParse(report.step);
  if(parsed.success){const s=parsed.data,ref=typeof report.step_ref==='string'&&/^[a-f0-9]{32}$/.test(report.step_ref)?report.step_ref:'UNKNOWN';emit(`tool=${trace.tool} event=END call=${trace.id} request=${trace.request} profile=${trace.profile} action=REPORT_STEP outcome=REPORTED code=NONE elapsed_ms=${elapsed(trace.started)} step_proof=AGENT_REPORTED connector=${s.connector} operation=${s.operation} step_outcome=${s.outcome} step_reason=${s.reason} attempted=${count(s.attempted)} confirmed=${count(s.confirmed)} step_ref=${ref} duplicate=${report.duplicate===true}`);return;}
 }
 const r=record(reply),outcome=closed(r.status,['OBSERVED','UNCONFIRMED','ACCESS_DENIED','INVALID_ARGUMENT','PREPARED','PACKAGE_READY','VERIFIED','RESUME_REQUIRED','INVALID_SEQUENCE','DRAFT','APPROVED_PENDING_NOTION','PUBLISHED','SUPERSEDED','NO_PUBLISHED_DIRECTION','PUBLISHED_DIRECTION','NOT_YET_EFFECTIVE','EXPIRED_DIRECTION','CONSUMPTION_REQUIRED','CONSUMPTION_PENDING_NOTION','CONSUMED','APPROVAL_REQUIRED','APPROVAL_MISMATCH','INVALID_RECIPIENT','REQUEST_KEY_CONFLICT','LIMIT_REACHED','STALE_PROPOSAL','PROPOSAL_EXPIRED','NOT_FOUND']);
 const update=record(record(r.runtime_contract).bootstrap_update);
 // Separate bounded line: offered source is NOT a client acknowledgement or install.
 if(trace.tool==='vertigo_sales_control'&&trace.action==='CONTEXT'&&['OBSERVED','UNCONFIRMED'].includes(outcome)&&update.protocol==='OWN_ACCOUNT_PLUGIN_UPDATE/1'&&update.status==='PROCEDURE_OFFERED'&&update.authority_granted===false&&directionVersion(update.revision)!=='UNKNOWN'&&typeof update.payload_sha256==='string'&&/^[a-f0-9]{64}$/.test(update.payload_sha256))emit(`tool=${trace.tool} event=BOOTSTRAP_OFFER call=${trace.id} request=${trace.request} profile=${trace.profile} offer=PROCEDURE_AVAILABLE update_revision=${directionVersion(update.revision)} proof=SERVER_OFFER_ONLY update_sha256=${update.payload_sha256}`);
 const code=r.reason===undefined?'NONE':closed(r.reason,['SCOPE_MISMATCH','INCOMPLETE_READ','FIELDS_MISMATCH','DUPLICATE_SOURCE_KEY','NOT_FOUND','CHANGED_DURING_READ','SOURCE_UNAVAILABLE','READ_INTERRUPTED','ACCESS_DENIED','RATE_LIMITED','REGISTRY_UNAVAILABLE','AUTHENTICATION_REQUIRED','IDENTITY_MISMATCH','CONTEXT_NOT_CONFIGURED','NOT_FOUND_OR_INACCESSIBLE','JOURNAL_UNAVAILABLE','CONTENT_MISMATCH','INVALID_JOURNAL','FOREIGN_JOURNAL','JOURNAL_BOUND','RECIPIENT_ASSIGNMENT_CHANGED','MISSING_RECORD','AMBIGUOUS_RECORD','RECEIPT_ID_CHANGED','SOURCE_OR_JOURNAL_UNAVAILABLE','JOURNAL_LOCK_UNAVAILABLE','IDENTITY_UNAVAILABLE',...orientationCodes]);
 const w=record(r.workflow),allowedIssues=['MANIFEST_STATE_GATE_MISMATCH','RUN_STATE_GATE_MISMATCH','GATE_TRANSITION_PROOF_MISSING','RUN_VERIFICATION_INCOMPLETE','RUN_MUTATION_REFS_MISSING','RUN_VERIFIED_AT_MISSING'];
 const rawIssues=Array.isArray(w.issues)?w.issues:undefined;
 const issues=rawIssues?allowedIssues.filter(v=>rawIssues.includes(v)).join('.')||'NONE':'UNKNOWN';
 const workflow=r.workflow===undefined?'':` workflow_gate=${closed(w.gate,['B0_DISCOVERY','B1_OFFER','B2_ICP','B3_DATA','B4_QUALIFICATION','B5_OUTREACH','B6_AUTHORITY','B7_DRY_RUN','READY'])} workflow_issues=${issues}`;
 const d=record(r.direction),direction=trace.tool!=='vertigo_sales_control'||r.direction===undefined?'':` direction_status=${closed(d.status,['NO_PUBLISHED_DIRECTION','PUBLISHED_DIRECTION','NOT_YET_EFFECTIVE','EXPIRED_DIRECTION','UNCONFIRMED','ACCESS_DENIED'])} direction_code=${d.reason===undefined?'NONE':closed(d.reason,['SCOPE_MISMATCH','INCOMPLETE_READ','FIELDS_MISMATCH','CHANGED_DURING_READ','INVALID_JOURNAL','FOREIGN_JOURNAL','RECIPIENT_ASSIGNMENT_CHANGED','MISSING_RECORD','AMBIGUOUS_RECORD','RECEIPT_ID_CHANGED','SOURCE_OR_JOURNAL_UNAVAILABLE','JOURNAL_LOCK_UNAVAILABLE','IDENTITY_UNAVAILABLE',...orientationCodes])}`;
 const orientation=trace.tool==='vertigo_direction_control'&&(r.contract!==undefined||r.phase!==undefined)?` orientation_contract=${closed(r.contract,['META_ORIENTATION/1.0'])} orientation_phase=${closed(r.phase,['OPEN_RUN','CLOSE_RUN',...['DEFINITION','PACKAGE','DECISION','CURRENT'].flatMap(role=>['PREPARE_','WRITE_','WRITTEN_','VERIFIED_'].map(prefix=>prefix+role))])}`:'';
 const loaded=trace.action==='CONTEXT'?(trace.tool==='vertigo_sales_control'&&r.status==='OBSERVED'&&d.status==='PUBLISHED_DIRECTION'?d:trace.tool==='vertigo_direction_control'&&r.status==='PUBLISHED_DIRECTION'?r:undefined):undefined;
 // RECORDED is the journal flag returned by CONTEXT, not a fresh native receipt check or agent delivery.
 const directionMetadata=loaded?` direction_version=${directionVersion(loaded.version)} direction_ack=${loaded.needs_consumption===true?'DUE':loaded.needs_consumption===false?'RECORDED':'UNKNOWN'}`:'';
 const receiptMetadata=trace.tool==='vertigo_direction_control'&&['CONSUME','VERIFY_CONSUMPTION'].includes(trace.action)&&r.status==='CONSUMED'?` receipt_version=${directionVersion(r.version)}`:'';
 emit(`tool=${trace.tool} event=END call=${trace.id} request=${trace.request} profile=${trace.profile} action=${trace.action} outcome=${outcome} code=${code} elapsed_ms=${elapsed(trace.started)}${workflow}${direction}${orientation}${directionMetadata}${receiptMetadata}`);
}
export function beginToolTrace(tool: string): ToolTrace {
  const trace = { id: randomBytes(8).toString("hex"), started: performance.now(), tool: closed(tool, tools), request: requests.getStore() ?? "NONE" };
  emit(`tool=${trace.tool} event=START call=${trace.id} request=${trace.request}`);
  return trace;
}

/** Project the final returned envelope/outcome into a closed, bounded vocabulary. Never serialize the reply. */
export function finishToolTrace(trace: ToolTrace, reply: unknown): void {
  const r = record(reply), observations = record(r.observations), next = record(r.next);
  const source = record(r.source_identity_enrollment ?? observations.source_identity_enrollment);
  const sourceStage = source.protocol === SOURCE_ENROLLMENT_PROTOCOL ? closed(source.stage, ["OBSERVE", "CONFIRM"]) : Object.keys(source).length ? "UNKNOWN" : "NONE";
  const plan = observations.open_backend_plan;
  const openPlan = plan === "NONE" ? "NONE" : plan && typeof plan === "object" ? (record(plan).expired === true ? "EXPIRED" : "ACTIVE") : "UNKNOWN";
  const result = r.status !== undefined ? `status=${closed(r.status, ["OK", "HOLD", "ERROR"])}` : `outcome=${closed(r.kind, ["PERSISTED", "IN_PROGRESS", "INTERRUPTED", "HELD"])}`;
  const code = closed(r.code ?? (r.kind !== "HELD" ? "NONE" : undefined), codes);
  const fields = `tool=${trace.tool} ${result} code=${code} event=END call=${trace.id} request=${trace.request} elapsed_ms=${elapsed(trace.started)}`
    + ` source_stage=${sourceStage} next=${closed(next.permitted_tool_call, tools, "NONE")}`
    + ` enrollment_enabled=${r.observations !== undefined ? String(observations.source_remediation_enabled === true) : "UNKNOWN"}`
    + ` capability_challenge=${Boolean(observations.capability_remediation)} open_plan=${openPlan}`
    + ` phase=${closed(r.phase, ["PREPARE", "STAGE1", "FINALIZATION", "STATE_LAST", "TARGET", "FINAL"], "NONE")}`
    + ` progress=${closed(r.reason, ["BUDGET", "CLAIMED_ELSEWHERE", "INDEX_LAG", "GUARD_DRIFT"], "NONE")}`
    + ` writes_done=${count(r.writes_done)} writes_total=${count(r.writes_total)} writes_sent=${count(r.writes_sent)}`;
  const diagnostic = r.kind === "HELD" && r.code === "HOLD_ACTION_NOT_AUTHORIZED" && Array.isArray(r.evidence)
    ? sourceEnrollmentLogDiagnostic(r.evidence) : undefined;
  let metaDiagnostic = "";
  if (trace.tool === "os_resume" && r.status === "OK" && r.code === "RESUMED" && record(r.binding).lane === "META") {
    const payload = record(r.result), pack = record(payload.contract_pack), context = record(payload.local_meta_operating_context);
    const needs = Array.isArray(pack.normalized_needs)
      ? CONTEXT_NEEDS.filter(n => (pack.normalized_needs as unknown[]).includes(n)).join(".") || "NONE" : "UNKNOWN";
    const rows = Array.isArray(context.tables) && context.tables.every(t => Array.isArray(record(t).rows))
      ? context.tables.reduce((n, t) => n + (record(t).rows as unknown[]).length, 0) : undefined;
    metaDiagnostic = ` meta_needs=${needs} meta_reason=${closed(pack.completeness_reason, ["NONE", "cross_lane_rejected", "unknown_need_token", "gtm_capability_absent", "context_not_registered"])}`
      + ` meta_context=${payload.local_meta_operating_context === undefined ? "NONE" : closed(context.status, ["NOT_SELECTED", "UNAVAILABLE", "PARTIAL", "COMPLETE"])}`
      + ` meta_documents=${count(Array.isArray(context.documents) ? context.documents.length : undefined)} meta_rows=${count(rows)}`;
  }
  // Even the legacy diagnostic grammar admits repeated field labels; never let it inflate a line.
  emit(fields + (diagnostic ? ` diagnostic=${diagnostic.length <= 200 ? diagnostic : "OMITTED_BOUND"}` : "") + metaDiagnostic);
}
