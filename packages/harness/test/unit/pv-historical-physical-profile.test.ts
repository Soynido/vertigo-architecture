import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as profiles from '../../src/migration/historicalPhysicalProfile.ts';
import {materializeProperty} from '../../src/notion/properties.ts';

const fixture=()=>({contract:{connectorCapabilities:[{key:'GMAIL_READ',requirement:'REQUIRED',competentSource:'GMAIL'}],physicalResources:[
 {key:'INSTANCE_MANIFEST',objectType:'DATABASE',required:true,path:['BOOT','Manifest'],requiredProperties:{Name:'title','Current Gate':'select'}},
 {key:'RECEIPTS',objectType:'DATABASE',required:true,path:['CONTROL','Receipts'],requiredProperties:{Receipt:'title','Observed At':'rich_text',Provider:'select'},requiredSelectOptions:{Provider:['GMAIL']}},
 {key:'CAPABILITY_PROFILE',objectType:'DATABASE',required:true,path:['CONTROL','Capability Profile'],requiredProperties:{Proof:'title',State:'select'},requiredSelectOptions:{State:['UNKNOWN','READ_VERIFIED']}},
 {key:'INTERACTIONS',objectType:'DATABASE',required:true,path:['DATA','Interactions'],requiredProperties:{Interaction:'title',Accounts:'relation',Contacts:'relation'}}
 ]},observed:{INSTANCE_MANIFEST:{id:'historical-manifest',parent:{database_id:'old-manifest-db'},properties:{Name:{type:'title',title:{}},'Current Gate':{id:'gate',type:'rich_text',rich_text:{},extra:'keep'}}},
 RECEIPTS:{id:'historical-receipts',parent:{database_id:'old-receipts-db'},properties:{Receipt:{type:'title',title:{}},'Observed At':{id:'observed',type:'date',date:{},extra:'keep'},Provider:{type:'select',select:{options:[{id:'old-option',name:'INTERNAL',color:'gray'}]}}}}}});
const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
function api(){const m=profiles as any;assert.equal(typeof m.draftHistoricalPhysicalProfile,'function','historical physical profile compiler is missing');assert.equal(typeof m.encodeHistoricalProfileField,'function','typed profile encoding is missing');return m;}
const draft=(f=fixture())=>api().draftHistoricalPhysicalProfile(f.contract,f.observed,hash(f.contract));

// Break caught: adapting old data by changing its physical type or silently changing the candidate contract.
test('historical physical profile declares exactly two preserved physical types without mutating either input',()=>{
 const f=fixture(),before=structuredClone(f),r=draft(f);
 assert.equal(r.status,'DRAFT_PHYSICAL_PROFILE');assert.equal(r.profile,'HISTORICAL_SALES_PHYSICAL_TYPES/1-draft');
 assert.deepEqual(r.preserved_types,[{resource:'INSTANCE_MANIFEST',property:'Current Gate',candidate_type:'select',physical_type:'rich_text'},
  {resource:'RECEIPTS',property:'Observed At',candidate_type:'rich_text',physical_type:'date'}]);
 assert.equal(r.resources.find((x:any)=>x.key==='INSTANCE_MANIFEST').requiredProperties['Current Gate'],'rich_text');
 assert.equal(r.resources.find((x:any)=>x.key==='RECEIPTS').requiredProperties['Observed At'],'date');
 assert.deepEqual(f,before);assert.equal(r.adopted,false);assert.equal(r.execution_authorized,false);assert.equal(r.writer_authorized,false);
 assert.deepEqual(r.tables.find((x:any)=>x.key==='RECEIPTS').draft.projected_schema.properties.Provider.select.options,[{id:'old-option',name:'INTERNAL',color:'gray'},{name:'GMAIL'}]);
});

// Break caught: treating absent access evidence or interactions as optional, or fabricating ready rows/target IDs.
test('missing required resources retain their entire declaration and symbolic relation targets, without minting evidence',()=>{
 const r=draft();assert.deepEqual(r.missing_required_resources.map((x:any)=>x.resource.key),['CAPABILITY_PROFILE','INTERACTIONS']);
 assert.equal(r.missing_required_resources[0].resource.required,true);
 assert.deepEqual(r.missing_required_resources[0].resource.requiredSelectOptions,{State:['UNKNOWN','READ_VERIFIED']});
 assert.deepEqual(r.missing_required_resources[1].relation_targets,{Accounts:'ACCOUNTS',Contacts:'CONTACTS'});
 for(const m of r.missing_required_resources){assert.deepEqual(m.seed_rows,[]);assert.equal(m.native_evidence_proved,false);assert.equal(Object.hasOwn(m,'data_source_id'),false);}
 assert.equal(r.schema_admitted,false);assert.equal(r.production_ready,false);
});

// Break caught: using a permissive type fallback to force another schema or changed contract through the profile.
test('other type conflicts and a changed contract fingerprint HOLD without allowing encoding',()=>{
 const f=fixture();(f.observed.INSTANCE_MANIFEST.properties['Current Gate'] as any).type='number';
 const r=draft(f);assert.equal(r.status,'HOLD_PHYSICAL_PROFILE');assert(r.holds.some((h:any)=>h.code==='PRESERVE_TYPE_CONFLICT'));
 assert.equal(api().encodeHistoricalProfileField(r,'INSTANCE_MANIFEST','Current Gate','B0').ok,false);
 const good=fixture();const mismatch=api().draftHistoricalPhysicalProfile(good.contract,good.observed,'not-the-contract-digest');
 assert.equal(mismatch.status,'HOLD_PHYSICAL_PROFILE');assert(mismatch.holds.some((h:any)=>h.code==='CONTRACT_FINGERPRINT_MISMATCH'));
 const arbitrary=fixture();(arbitrary.observed.RECEIPTS.properties.Provider as any).type='rich_text';
 assert.equal(draft(arbitrary).status,'HOLD_PHYSICAL_PROFILE');
});

// Break caught: trimming/defaulting an old gate or converting a real date into rich text.
test('profile field encoding uses the declared physical type and preserves the exact literal or offset',()=>{
 const r=draft(),a=api();
 const gate=a.encodeHistoricalProfileField(r,'INSTANCE_MANIFEST','Current Gate',' unknown historical gate ');
 assert.equal(gate.ok,true);assert.deepEqual(gate.property,{rich_text:[{type:'text',text:{content:' unknown historical gate '}}]});
 const observed=a.encodeHistoricalProfileField(r,'RECEIPTS','Observed At','2001-04-05T06:07:08+02:00');
 assert.equal(observed.ok,true);assert.deepEqual(observed.property,{date:{start:'2001-04-05T06:07:08+02:00'}});
 assert.deepEqual(materializeProperty('date',observed.property),{type:'date',date:{start:'2001-04-05T06:07:08+02:00'}});
 assert.equal(a.encodeHistoricalProfileField(r,'RECEIPTS','Observed At','not-a-date').ok,false);
 assert.equal(a.encodeHistoricalProfileField(r,'OS_STATE','Current Gate','READY').ok,false);
 assert.equal(a.encodeHistoricalProfileField(r,'RECEIPTS','Verified',true).ok,false);
});

// Break caught: lending this local draft a source alias or weakening its retained required structure.
test('draft result is isolated, still requires missing structure/adoption, and never resets a historical value',()=>{
 const f=fixture(),before=structuredClone(f),r=draft(f);
 r.resources[0].path[0]='changed locally';r.tables[0].draft.projected_schema.properties.Name.extra='not source';
 assert.deepEqual(f,before);assert.equal(r.native_capabilities_verified,false);
 assert(r.required_before_use.includes('ADOPTED_COMPATIBILITY_CONTRACT_AND_BOUND_GUARD'));
 assert(r.required_before_use.includes('MISSING_REQUIRED_RESOURCES_AND_RELATION_MAPPING'));
 assert(r.required_before_use.includes('SERVED_ADAPTER_AND_EVENT_WRITER_INTEGRATION'));
 assert.equal(Object.hasOwn(r,'CURRENT'),false);assert.equal(Object.hasOwn(r,'mutations'),false);
});

// Break caught: encoding a forged or caller-mutated profile as though its physical types had been observed.
test('field encoding refuses serialized profiles and cannot be redirected by mutating the public draft',()=>{
 const r=draft(),a=api();
 assert.equal(a.encodeHistoricalProfileField(JSON.parse(JSON.stringify(r)),'RECEIPTS','Observed At','2001-01-01').ok,false);
 r.resources.find((x:any)=>x.key==='RECEIPTS').requiredProperties['Observed At']='rich_text';
 const encoded=a.encodeHistoricalProfileField(r,'RECEIPTS','Observed At','2001-01-01');
 assert.deepEqual(encoded.property,{date:{start:'2001-01-01'}});
});
