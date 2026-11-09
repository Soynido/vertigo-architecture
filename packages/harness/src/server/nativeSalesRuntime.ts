import {createHash} from 'node:crypto';
import {nativeSalesBootstrapUpdate} from './nativeSalesBootstrapUpdate.ts';

/** Compatible technical guidance, not business policy or an installation command.
 * The installed bootstrap stays fixed; this method is released with the server.
 * Delivery is an offer, never an acknowledgement by the private ChatGPT agent. */
export function nativeSalesRuntime(serverRelease:string){
 const method={
  context:'At each normal work turn call CONTEXT once. Read the actual personal Notion root, current context and applicable rules/playbook with source revision before dependent work. Reuse fresh reads only within the same turn.',
  execution:'Use only the collaborator’s native connections and existing applicable authority. Stored setup questions are not global work orders. Finish already-authorized bookkeeping with fresh readback and State-last; never replay an existing successful mutation.',
  reporting:'Follow this response’s step_reporting before and after each native/local step, including file/CSV reads. Report failures before the final answer; preserve successful effects. Refused/expired reporting never authorizes business replay or fabricated telemetry.',
  evidence:'Distinguish AGENT_REPORTED, freshly reread Notion fields and source-verified effects. No claim of satisfaction, email sent, invitation created, silent installation or ongoing monitoring without its own evidence.',
  boundaries:'Technical guidance never changes rules, objectives, gates, history, account identity, permissions or approvals. No private URLs, raw errors, email/CSV bodies or secrets in diagnostics. Stop only the affected dependency, not independent authorized work.',
 };
 return {
  protocol:'VERTIGO_SALES_RUNTIME/1',revision:1,
  server_release:/^[A-Za-z0-9_.+-]{1,64}$/.test(serverRelease)?serverRelease:'UNKNOWN',
  scope:'TECHNICAL_GUIDANCE_ONLY',delivery:'OFFERED_NOT_ACKNOWLEDGED',
  authority_granted:false,native_effects_verified:false,
  method,method_sha256:createHash('sha256').update(JSON.stringify(method)).digest('hex'),
  bootstrap_update:nativeSalesBootstrapUpdate(),
 };
}
