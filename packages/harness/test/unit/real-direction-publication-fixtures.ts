import { createHash } from 'node:crypto';

export const id=(n:number)=>n.toString(16).padStart(32,'0');
export const url=(n:number)=>'https://app.notion.com/p/'+id(n);
export const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const rich=(s:string)=>({type:'rich_text',rich_text:[{type:'text',plain_text:s,text:{content:s}}]});
export const prop=(v:unknown,type='rich_text'):any=>type==='rich_text'?rich(v as string):{type,[type]:type==='select'?{name:v}:type==='date'?{start:v,end:null,time_zone:null}:v};
export const fixture=()=>{
  const scope={meta_root_id:id(1),meta_runtime_id:'META1',meta_schema_version:'TEST_META_SCHEMA/0.2.0',spec_version:'TEST_META_SPEC/0.6.0',control_version:'TEST_CONTROL/1.1',runs_source_id:id(2),ledger_source_id:id(3),decisions_source_id:id(4),definitions_source_id:id(5),gates_source_id:id(60),gate_page_id:id(61),recipient:{root_page_id:id(6),runtime_id:'SALES-A',manifest_page_id:id(7),manifest_source_id:id(8),schema_version:'TEST_SALES_SCHEMA/0.5.0',sales_contract_version:'TEST_SALES_CONTRACT/0.5.0'}};
  const packageText=JSON.stringify({kind:'RECIPIENT_DIRECTION/1',proposal_id:id(90),recipient_runtime_id:'SALES-A',classification:'RECIPIENT_SAFE',authority_change:false,direction:'Adapter le prochain travail sans modifier les règles locales.'});
  const decision:Record<string,string>={Status:'DECIDED',Type:'OBJECTIVE',Resolution:JSON.stringify({proposal_id:id(90),package_hash:digest({content:packageText}),classification:'RECIPIENT_SAFE',schema_version:scope.recipient.schema_version,sales_contract_version:scope.recipient.sales_contract_version,authority_change:false}), 'Affected Objects':url(11)};
  const definition:Record<string,string>={'Definition Key':'REAL_DIRECTION:REP_A:1:'+id(90),Status:'APPROVED_FOR_VERSION',Content:'exact approved sealed payload','Decision Ref':url(12)};
  const gateBefore:Record<string,string>={Status:'OPEN','Control Confirmation State':'PENDING','Passed By Run Ref':'','Confirmed By Control Check Ref':'','Evidence Refs':'','Last Required Written At':''};
  const gateAfter:Record<string,string>={Status:'PROVISIONAL_PASS','Control Confirmation State':'PENDING','Passed By Run Ref':url(9),'Confirmed By Control Check Ref':'','Evidence Refs':JSON.stringify({proposal_id:id(90),definition_id:id(10),package_id:id(11),decision_id:id(12)}),'Last Required Written At':'2026-10-16T14:01:00.000Z'};
  const expected={proposal_id:id(90),run_id:id(9),definition_id:id(10),package_id:id(11),decision_id:id(12),package_text:packageText,definition_properties:definition,decision_properties:decision,previous_pointer:'',gate_before:gateBefore,gate_properties:gateAfter,mutations:[
    {id:id(20),key:'DIRECTION:'+id(90)+':DEFINITION',operation:'CREATE',target_id:id(10),after_hash:digest(definition),before_hash:digest(null)},
    {id:id(21),key:'DIRECTION:'+id(90)+':PACKAGE',operation:'CREATE',target_id:id(11),after_hash:digest({content:packageText}),before_hash:digest(null)},
    {id:id(22),key:'DIRECTION:'+id(90)+':DECISION',operation:'CREATE',target_id:id(12),after_hash:digest(decision),before_hash:digest(null)},
    {id:id(23),key:'DIRECTION:'+id(90)+':CURRENT',operation:'PUBLISH_POINTER',target_id:id(7),after_hash:digest({'Objective Package URL':url(11)}),before_hash:digest({'Objective Package URL':''})},
    {id:id(24),key:'DIRECTION:'+id(90)+':GATE',operation:'UPDATE',target_id:id(61),after_hash:digest(gateAfter),before_hash:digest(gateBefore)},
  ]};
  const pages=new Map<string,any>(),sourceRoots=new Map([[id(2),id(1)],[id(3),id(1)],[id(4),id(1)],[id(5),id(1)],[id(8),id(6)],[id(60),id(1)]]);
  const page=(n:number,parent:any,properties:any)=>({object:'page',id:id(n),archived:false,in_trash:false,last_edited_time:'2026-10-16T14:00:30Z',parent,properties});
  const dataPage=(n:number,ds:number,p:Record<string,unknown>,types:Record<string,string>={})=>page(n,{type:'data_source_id',data_source_id:id(ds)},Object.fromEntries(Object.entries(p).map(([k,v])=>[k,prop(v,types[k]??'rich_text')])));
  for(const n of [1,6])pages.set(id(n),page(n,{type:'workspace',workspace:true},{}));
  pages.set(id(7),dataPage(7,8,{'Instance ID':'SALES-A','Schema Version':scope.recipient.schema_version,'Sales Contract Version':scope.recipient.sales_contract_version,'Objective Package URL':url(11)},{'Objective Package URL':'url'}));
  pages.set(id(9),dataPage(9,2,{'Harness Plan ID':id(90),'Runtime ID':'META1','Spec Version':scope.spec_version,'META Schema Version':scope.meta_schema_version,'Control Version':scope.control_version,Status:'COMPLETED','Run Type':'PUBLISH',Origin:'PLUGIN','Recovery Required':false,'Mutation Count':4,'Verified Mutation Count':4,'Decisions Committed':url(12),'Publication Refs':url(11),Started:'2026-10-16T13:56:00Z',Finished:'2026-10-16T14:02:00Z'},{Status:'select','Run Type':'select',Origin:'select','Recovery Required':'checkbox','Mutation Count':'number','Verified Mutation Count':'number',Started:'date',Finished:'date'}));
  pages.get(id(9)).properties['Input Refs']=rich(JSON.stringify({pins:{sales_contract_version:'TEST_SALES_CONTRACT/0.5.0',recipient_schema_version:'TEST_SALES_SCHEMA/0.5.0',strategy:{state:'NOT_APPLICABLE',reason:'ADAPTABLE_RECIPIENT_RECOMMENDATION; no Strategy/Toolkit/Authority publication or adoption.'},toolkit:{state:'NOT_APPLICABLE',reason:'ADAPTABLE_RECIPIENT_RECOMMENDATION; no Strategy/Toolkit/Authority publication or adoption.'},authority:{state:'NOT_APPLICABLE',reason:'ADAPTABLE_RECIPIENT_RECOMMENDATION; no Strategy/Toolkit/Authority publication or adoption.'}}}));
  pages.get(id(9)).properties['Attempt Count']=prop(22,'number');pages.get(id(9)).properties['Opened Execution Attempt ID']=rich(id(90)+':PUBLISH:1');pages.get(id(9)).properties['Last Execution Attempt ID']=rich(id(90)+':PUBLISH:22');pages.get(id(9)).properties['Mutation Count']=prop(5,'number');pages.get(id(9)).properties['Verified Mutation Count']=prop(5,'number');
  pages.get(id(9)).properties['Gate Before']=rich(JSON.stringify(gateBefore));pages.get(id(9)).properties['Gate After Expected']=rich('PROVISIONAL_PASS');pages.get(id(9)).properties['Gate After Observed']=rich('PROVISIONAL_PASS');
  const phases=['OPEN_RUN',...['DEFINITION','PACKAGE','DECISION','CURRENT','GATE'].flatMap(r=>['PREPARE_','WRITE_','WRITTEN_','VERIFIED_'].map(p=>p+r)),'CLOSE_RUN'];
  pages.get(id(9)).properties.Actions=rich(JSON.stringify({kind:'NATIVE_PUBLICATION_ATTEMPTS/1',proposal_id:id(90),attempts:phases.map((phase,i)=>({attempt_id:id(90)+':PUBLISH:'+(i+1),phase}))}));
  pages.set(id(10),dataPage(10,5,definition,{Status:'select'}));
  pages.set(id(11),page(11,{type:'page_id',page_id:id(6)},{}));
  pages.set(id(12),dataPage(12,4,decision,{Status:'select',Type:'select'}));
  pages.set(id(61),dataPage(61,60,{'Gate Key':'G11',...gateAfter},{Status:'select','Control Confirmation State':'select','Last Required Written At':'date'}));
  for(const [i,m] of expected.mutations.entries())pages.set(m.id,dataPage(20+i,3,{'Harness Plan ID':id(90),'Idempotency Key':m.key,'Run Ref':url(9),'Target Ref':url(Number.parseInt(m.target_id,16)),Operation:m.operation,Status:'VERIFIED','Before Hash':m.before_hash,'After Expected Hash':m.after_hash,'After Observed Summary':JSON.stringify({target_id:m.target_id,hash:m.after_hash}),'Compared Fields':JSON.stringify(i===0?Object.keys(definition):i===1?['content']:i===2?Object.keys(decision):['Objective Package URL']),'Written At':i>=3?'2026-10-16T14:01:00Z':'2026-10-16T13:58:30Z','Verified At':i>=3?'2026-10-16T14:01:00Z':'2026-10-16T13:59:45Z'},{Operation:'select',Status:'select','Written At':'date','Verified At':'date'}));
  const children={object:'list',has_more:false,next_cursor:null,results:[{object:'block',id:id(50),type:'code',archived:false,in_trash:false,has_children:false,code:{language:'json',rich_text:[{type:'text',plain_text:packageText,text:{content:packageText}}]}}]};
  for(let i=0;i<5;i++){const p=pages.get(id(20+i));for(const [name,n]of [['Prepared Execution Attempt ID',2+4*i],['Written Execution Attempt ID',3+4*i],['Verified Execution Attempt ID',5+4*i]] as const)p.properties[name]=rich(id(90)+':PUBLISH:'+n);if(i===4){p.properties['After Observed Summary']=rich(JSON.stringify({target_id:id(61),hash:digest(gateAfter)}));p.properties['Compared Fields']=rich(JSON.stringify(Object.keys(gateAfter)));}}
  // Native data-source definitions, separate from row values. A well-shaped row
  // does not prove that the next phase can safely write the required columns.
  const definitions:Record<string,Record<string,string|readonly string[]>>={
    [id(2)]:{
      Run:'title','Harness Plan ID':'rich_text','Runtime ID':'rich_text','Spec Version':'rich_text','META Schema Version':'rich_text','Control Version':'rich_text','Input Refs':'rich_text','Observed Facts':'rich_text','Gate Before':'rich_text','Gate After Expected':'rich_text','Gate After Observed':'rich_text','Opened Execution Attempt ID':'rich_text','Last Execution Attempt ID':'rich_text',Actions:'rich_text','Decisions Committed':'rich_text','Publication Refs':'rich_text',
      Status:['RUNNING','COMPLETED','HOLD','FAILED'],'Run Type':['COMMIT','PUBLISH'],Origin:['PLUGIN','META_RUNTIME'],'Control Confirmation State':['PENDING','CONFIRMED'],
      'Recovery Required':'checkbox','Attempt Count':'number','Mutation Count':'number','Verified Mutation Count':'number',Started:'date',Finished:'date','Last Required Written At':'date',
    },
    [id(3)]:{
      Mutation:'title','Harness Plan ID':'rich_text','Idempotency Key':'rich_text','Natural Key':'rich_text','Run Ref':'rich_text','Target Ref':'rich_text','Before Hash':'rich_text','After Expected Hash':'rich_text','After Observed Summary':'rich_text','Compared Fields':'rich_text','Prepared Execution Attempt ID':'rich_text','Written Execution Attempt ID':'rich_text','Verified Execution Attempt ID':'rich_text',
      Operation:['CREATE','UPDATE','PUBLISH_POINTER'],Status:['PREPARED','WRITTEN','VERIFIED','FAILED'],'Written At':'date','Verified At':'date',
    },
    [id(4)]:{Decision:'title',Resolution:'rich_text','Affected Objects':'rich_text',Status:['OPEN','DECIDED'],Type:['OBJECTIVE','OTHER']},
    [id(5)]:{Definition:'title','Definition Key':'rich_text',Content:'rich_text','Decision Ref':'rich_text',Subtype:'rich_text','Target Version':'rich_text','Source Refs':'rich_text',Parameters:'rich_text','Definition Type':['TOOLKIT_ITEM','AUTHORITY_RULE'],Status:['DRAFT','APPROVED_FOR_VERSION','RETIRED']},
    [id(60)]:{'Gate Key':'rich_text',Status:['OPEN','PROVISIONAL_PASS','PASS','HOLD','FAIL'],'Control Confirmation State':['PENDING','CONFIRMED','FAILED'],'Passed By Run Ref':'rich_text','Confirmed By Control Check Ref':'rich_text','Evidence Refs':'rich_text','Last Required Written At':'date'},
    [id(8)]:{'Instance ID':'rich_text','Schema Version':'rich_text','Sales Contract Version':'rich_text','Objective Package URL':'url'},
  };
  const schemas=new Map<string,any>(Object.entries(definitions).map(([source,fields])=>[source,{object:'data_source',id:source,archived:false,in_trash:false,last_edited_time:'2026-10-16T13:55:00Z',request_id:'response-only-metadata',parent:{type:'database_id',database_id:id(100+Number.parseInt(source,16))},properties:Object.fromEntries(Object.entries(fields).map(([name,spec],i)=>{const type=typeof spec==='string'?spec:'select';return [name,{id:type==='title'?'title':'p'+i,name,type,[type]:type==='select'?{options:(spec as readonly string[]).map((name,n)=>({id:'o'+n,name,color:'gray'}))}:{}}];}))}]));
  const reads:any[]=[];
  const match=(p:any,f:any):boolean=>{
    if(f.and)return f.and.every((x:any)=>match(p,x));
    if(f.or)return f.or.some((x:any)=>match(p,x));
    const v=p.properties[f.property];
    if(f.select)return v?.type==='select'&&v.select?.name===f.select.equals;
    const text=v?.type==='rich_text'?v.rich_text.map((x:any)=>x.plain_text).join(''):undefined;
    if(f.rich_text?.equals!==undefined)return text===f.rich_text.equals;
    if(f.rich_text?.starts_with!==undefined)return typeof text==='string'&&text.startsWith(f.rich_text.starts_with);
    throw Error('Unsupported external Notion filter in fixture');
  };
  const reader:any={retrievePage:async(ref:string)=>{reads.push(['page',ref]);return structuredClone(pages.get(ref));},retrieveDataSource:async(ref:string)=>{reads.push(['schema',ref]);return structuredClone(schemas.get(ref));},retrieveDatabase:async(ref:string)=>({object:'database',id:ref,parent:{type:'page_id',page_id:sourceRoots.get(id(Number.parseInt(ref,16)-100))}}),retrieveBlockChildren:async(ref:string)=>{reads.push(['children',ref]);return structuredClone(children);},queryDataSource:async(ds:string,filter:any)=>{reads.push(['query',ds]);return {object:'list',has_more:false,next_cursor:null,results:structuredClone([...pages.values()].filter(p=>p.parent.data_source_id===ds&&match(p,filter)))};}};
  return {scope,expected,pages,reader,children,reads,sourceRoots,schemas};
};
