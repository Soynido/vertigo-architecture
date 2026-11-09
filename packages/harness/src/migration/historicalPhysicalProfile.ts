/** Non-served physical compatibility draft. No client, runtime registration, adoption or writer.
 * Integrity fingerprints are not permissions. Captured values are never rewritten by this module.
 */
import {createHash} from 'node:crypto';
import type {InstallContract,InstallPhysicalResource} from '../versions/adapters/controlPlane.ts';
import {draftHistoricalSchemaAdditions,type HistoricalSchemaDraft} from './historicalSchemaDraft.ts';
import {encodeProperty} from '../notion/properties.ts';

type Obj=Record<string,unknown>;
type Hold={code:string;resource?:string;property?:string;observed_type?:string;expected_type?:string};
const object=(v:unknown):Obj|undefined=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Obj:undefined;
const differences=[
 {resource:'INSTANCE_MANIFEST',property:'Current Gate',candidate_type:'select',physical_type:'rich_text'},
 {resource:'RECEIPTS',property:'Observed At',candidate_type:'rich_text',physical_type:'date'},
] as const;
const relationTargets:Readonly<Record<string,Readonly<Record<string,string>>>>={INTERACTIONS:{Accounts:'ACCOUNTS',Contacts:'CONTACTS'}};
export interface HistoricalPhysicalProfile {
 readonly profile:'HISTORICAL_SALES_PHYSICAL_TYPES/1-draft';
 readonly status:'DRAFT_PHYSICAL_PROFILE'|'HOLD_PHYSICAL_PROFILE';
 readonly base_install_contract_sha256:string|null;
 readonly resources:readonly InstallPhysicalResource[];
 readonly preserved_types:readonly {resource:string;property:string;candidate_type:string;physical_type:string}[];
 readonly tables:readonly {key:string;draft:HistoricalSchemaDraft}[];
 readonly missing_required_resources:readonly {resource:InstallPhysicalResource;relation_targets:Readonly<Record<string,string>>;seed_rows:readonly never[];native_evidence_proved:false}[];
 readonly holds:readonly Hold[];
 readonly adopted:false;readonly schema_admitted:false;readonly execution_authorized:false;readonly writer_authorized:false;
 readonly production_ready:false;readonly native_capabilities_verified:false;
 readonly required_before_use:readonly string[];
}
// This is local draft provenance, NOT runtime identity, a write permission or a serialized admission.
const encodings=new WeakMap<HistoricalPhysicalProfile,ReadonlyMap<string,string>>();

export function draftHistoricalPhysicalProfile(contract:InstallContract,observed:Readonly<Record<string,unknown>>,expectedContractSha256:string):HistoricalPhysicalProfile{
 const holds:Hold[]=[],tables:{key:string;draft:HistoricalSchemaDraft}[]=[],preserved:HistoricalPhysicalProfile['preserved_types'][number][]=[];
 const missing:HistoricalPhysicalProfile['missing_required_resources'][number][]=[],types=new Map<string,string>();
 let copied:InstallContract|undefined,source:Record<string,unknown>|undefined,sha:string|null=null;
 try{copied=structuredClone(contract);source=structuredClone(observed);sha=createHash('sha256').update(JSON.stringify(contract)).digest('hex');}catch{holds.push({code:'INVALID_CAPTURE'});}
 const resources=copied?.physicalResources??[];
 if(sha!==expectedContractSha256)holds.push({code:'CONTRACT_FINGERPRINT_MISMATCH'});
 const captured=object(source);
 if(!Array.isArray(resources)||!captured){holds.push({code:'INVALID_CAPTURE'});}
 else{
  const keys=resources.map(r=>r.key);
  if(new Set(keys).size!==keys.length)holds.push({code:'AMBIGUOUS_RESOURCE_DECLARATION'});
  for(const rule of differences){
   const matches=resources.filter(r=>r.key===rule.resource),r=matches[0];
   if(matches.length!==1||!r||r.objectType!=='DATABASE'||r.requiredProperties?.[rule.property]!==rule.candidate_type){holds.push({code:'PHYSICAL_PROFILE_DECLARATION_MISMATCH',resource:rule.resource,property:rule.property});continue;}
   const schema=object(captured[rule.resource]),props=object(schema?.properties),actual=object(props?.[rule.property])?.type;
   if(actual===rule.physical_type){
    const replacement={...r,requiredProperties:{...r.requiredProperties,[rule.property]:rule.physical_type}};
    (resources as InstallPhysicalResource[])[resources.indexOf(r)]=replacement;preserved.push({...rule});
   }
   if(typeof actual==='string'&&(actual===rule.physical_type||actual===rule.candidate_type))types.set(rule.resource+'\0'+rule.property,actual);
  }
  for(const r of resources.filter(r=>r.required&&r.objectType==='DATABASE')){
   if(!Object.hasOwn(captured,r.key)){
    if(r.key!=='CAPABILITY_PROFILE'&&r.key!=='INTERACTIONS')holds.push({code:'UNDECLARED_MISSING_RESOURCE',resource:r.key});
    missing.push({resource:structuredClone(r),relation_targets:structuredClone(relationTargets[r.key]??{}),seed_rows:[],native_evidence_proved:false});continue;
   }
   const draft=draftHistoricalSchemaAdditions(captured[r.key],{properties:r.requiredProperties??{},selectOptions:r.requiredSelectOptions});
   tables.push({key:r.key,draft});for(const h of draft.holds)holds.push({...h,resource:r.key});
  }
 }
 const result:HistoricalPhysicalProfile={profile:'HISTORICAL_SALES_PHYSICAL_TYPES/1-draft',status:holds.length?'HOLD_PHYSICAL_PROFILE':'DRAFT_PHYSICAL_PROFILE',
  base_install_contract_sha256:sha,resources:Array.isArray(resources)?resources:[],preserved_types:preserved,tables,missing_required_resources:missing,holds,
  adopted:false,schema_admitted:false,execution_authorized:false,writer_authorized:false,production_ready:false,native_capabilities_verified:false,
  required_before_use:['ADOPTED_COMPATIBILITY_CONTRACT_AND_BOUND_GUARD','MISSING_REQUIRED_RESOURCES_AND_RELATION_MAPPING','SERVED_ADAPTER_AND_EVENT_WRITER_INTEGRATION','PHYSICAL_PATHS_AND_ACTUAL_HOST_NON_REGRESSION']};
 if(!holds.length)encodings.set(result,types);return result;
}

/** Encoded FIELD DRAFT only. No row, authority, native proof, current-gate mapping or permission is produced. */
export function encodeHistoricalProfileField(profile:HistoricalPhysicalProfile,resource:string,property:string,value:unknown){
 const type=encodings.get(profile)?.get(resource+'\0'+property);
 if(!type)return{ok:false as const,code:'UNDECLARED_PHYSICAL_PROFILE_FIELD',execution_authorized:false as const};
 const encoded=encodeProperty(type,value);
 return encoded.ok?{ok:true as const,property:encoded.value,execution_authorized:false as const,native_evidence_proved:false as const}
  :{...encoded,execution_authorized:false as const,native_evidence_proved:false as const};
}
