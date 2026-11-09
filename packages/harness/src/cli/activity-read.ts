/** One explicit operator read, not a watcher or a synthetic collaborator tool call. */
import {buildDeps} from '../index.ts';
import {loadNativeMetaProfile} from '../verify/nativeMetaControl.ts';

const deps=buildDeps();
if(!deps.config.nativeMetaProfileFile||!deps.nativeMetaControl)throw Error('Owner META observer unavailable');
const owner=loadNativeMetaProfile(deps.config.nativeMetaProfileFile);
const observed=await deps.nativeMetaControl.run(owner.principal_id,{action:'CONTEXT'});
console.log(JSON.stringify({origin:'OPERATOR_READ_ONLY_NOT_CLIENT',notion_writes:0,...(observed.status==='OBSERVED'&&'activity'in observed?{report:observed.activity}:{status:'UNCONFIRMED'})}));
