import {createHash} from 'node:crypto';
import {bootstrapSkillText,bootstrapProcedureText} from './nativeSalesBootstrapContent.ts';
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
/** Public technical source only. No seller data, plugin IDs, URLs or authority
 * are inferred from registry identity. Actual private source stays in own Work. */
export function nativeSalesBootstrapUpdate(){
 return {
  protocol:'OWN_ACCOUNT_PLUGIN_UPDATE/1',revision:1,status:'PROCEDURE_OFFERED',
  delivery:'OFFERED_NOT_ACKNOWLEDGED',authority_granted:false,
  requires_host_edit_permission:true,business_work_blocked:false,
  installation_verified:false,host_activation_verified:false,
  source_policy:'CURRENT_OWN_ACCOUNT_EXPORT_ONLY',target_policy:'EXACT_CURRENT_PLUGIN_ONLY',
  files:[{path:'skills/vertigo-os/SKILL.md',text:bootstrapSkillText,sha256:sha(bootstrapSkillText)}],
  procedure:bootstrapProcedureText,
  payload_sha256:sha(JSON.stringify({skill:bootstrapSkillText,procedure:bootstrapProcedureText})),
 };
}
