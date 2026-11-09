/** Offline-only draft reversal oracle. Never an API payload, native restore, full backup or permission. */
type Obj=Record<string,any>;
export interface HistoricalRollbackQualification {
  status:"LOCAL_ROLLBACK_SAFE"|"HOLD";
  code:string;
  schema:Obj|null;
  rows:Obj[]|null;
  native_restore_proved:false;
  execution_authorized:false;
}
const object=(v:unknown):Obj|undefined=>v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Obj:undefined;
const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):object(v)?Object.fromEntries(Object.entries(v as Obj).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,canonical(x)])):v;
const same=(a:unknown,b:unknown)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const own=(o:Obj,k:string)=>Object.hasOwn(o,k);
const scalars=new Set(["rich_text","number","checkbox","url","email","phone_number","date","select","multi_select"]);
const empty=(p:Obj,type:string):boolean=>p.type===type&&(type==="checkbox"?p.checkbox===false:
  ["rich_text","multi_select"].includes(type)?Array.isArray(p[type])&&p[type].length===0:p[type]===null);
const choices=(p:Obj,type:string):unknown=>type==="select"?p.select===null?[]:[p.select]:p.multi_select;
function jsonValue(v:unknown,path=new Set<object>(),depth=0):boolean {
  if(v===null||typeof v==="string"||typeof v==="boolean")return true;
  if(typeof v==="number")return Number.isFinite(v)&&!Object.is(v,-0);
  if(typeof v!=="object"||depth>80||path.has(v))return false;
  const array=Array.isArray(v),prototype=Object.getPrototypeOf(v);
  if(!array&&prototype!==Object.prototype&&prototype!==null)return false;
  const keys=Reflect.ownKeys(v);
  if(array&&(keys.length!==v.length+1||Object.keys(v).some((k,i)=>k!==String(i))))return false;
  path.add(v);
  for(const key of keys){
    if(array&&key==="length")continue;
    const d=Object.getOwnPropertyDescriptor(v,key);
    if(typeof key!=="string"||!d?.enumerable||!("value" in d)||!jsonValue(d.value,path,depth+1)){path.delete(v);return false;}
  }
  path.delete(v);return true;
}

/** Source and applied are local schema witnesses; coverage is the supplied row window, not a server attestation. */
export function qualifyHistoricalRollback(sourceInput:unknown,appliedInput:unknown,currentInput:unknown,pagesInput:unknown):HistoricalRollbackQualification {
  const flags={native_restore_proved:false as const,execution_authorized:false as const};
  const hold=(code:string):HistoricalRollbackQualification=>({status:"HOLD",code,schema:null,rows:null,...flags});
  let source:Obj|undefined,applied:Obj|undefined,current:Obj|undefined,pages:unknown;
  try {
    if(!jsonValue([sourceInput,appliedInput,currentInput,pagesInput]))return hold("INVALID_LOCAL_INPUT");
    // Isolate captured JSON only, without dropping unsupported values or invoking toJSON/getters.
    const raw=JSON.stringify([sourceInput,appliedInput,currentInput,pagesInput]);
    [source,applied,current,pages]=JSON.parse(raw);
  }catch{return hold("INVALID_LOCAL_INPUT");}
  if(!object(source)||!object(applied)||!object(current)||!object(source!.properties)||!object(applied!.properties)||!object(current!.properties))return hold("INVALID_LOCAL_INPUT");
  const original=source!.properties as Obj,after=applied!.properties as Obj,live=current!.properties as Obj;
  if(typeof source!.id!=="string"||source!.id!==applied!.id||source!.id!==current!.id||!same(source!.parent,applied!.parent)||!same(source!.parent,current!.parent))return hold("SOURCE_IDENTITY_CHANGED");
  const sourceHeader=structuredClone(source!),appliedHeader=structuredClone(applied!);
  delete sourceHeader.properties;delete appliedHeader.properties;
  if(!same(sourceHeader,appliedHeader))return hold("NOT_AN_ADDITIVE_DELTA");
  if(Object.values(original).filter(p=>object(p)?.type==="title").length!==1)return hold("INVALID_LOCAL_INPUT");
  const addedFields:string[]=[],addedOptions=new Map<string,Obj[]>();
  for(const [name,p]of Object.entries(original)) {
    const a=object(after[name]);if(!object(p)||!a||p.type!==a.type)return hold("NOT_AN_ADDITIVE_DELTA");
    if(p.type==="select"||p.type==="multi_select"){
      const old=p[p.type]?.options,next=a[a.type]?.options;
      if(!Array.isArray(old)||!Array.isArray(next)||!same(next.slice(0,old.length),old))return hold("NOT_AN_ADDITIVE_DELTA");
      const stripped=structuredClone(a);stripped[a.type].options=old;
      if(!same(stripped,p))return hold("NOT_AN_ADDITIVE_DELTA");
      const additions=next.slice(old.length);
      if(next.some(x=>!object(x)||typeof x.name!=="string"||!x.name.length)||new Set(next.map(x=>x.name)).size!==next.length)return hold("NOT_AN_ADDITIVE_DELTA");
      if(additions.length)addedOptions.set(name,additions);
    } else if(!same(p,a))return hold("NOT_AN_ADDITIVE_DELTA");
  }
  for(const name of Object.keys(after))if(!own(original,name)){
    const p=object(after[name]);if(!p||!scalars.has(p.type))return hold("NOT_AN_ADDITIVE_DELTA");
    if(!own(live,name)||!same(live[name],p))return hold("OWN_SCHEMA_DELTA_CHANGED");addedFields.push(name);
  }
  for(const [name,options]of addedOptions){
    const p=object(live[name]),type=after[name].type,all=p?.[type]?.options;
    if(p?.type!==type||!Array.isArray(all)||all.some(x=>!object(x)||typeof x.name!=="string")||new Set(all.map(x=>x.name)).size!==all.length)return hold("OWN_SCHEMA_DELTA_CHANGED");
    for(const added of options)if(!same(all.find(x=>x.name===added.name),added))return hold("OWN_SCHEMA_DELTA_CHANGED");
  }
  if(!Array.isArray(pages)||!pages.length||pages.length>100)return hold("ROW_WINDOW_INCOMPLETE");
  const rows:Obj[]=[],ids=new Set<string>(),cursors=new Set<string>();
  for(let i=0;i<pages.length;i++){
    const page=object(pages[i]);if(!page||!Array.isArray(page.results)||typeof page.has_more!=="boolean")return hold("ROW_WINDOW_INVALID");
    if(i===pages.length-1){if(page.has_more||page.next_cursor!=null)return hold("ROW_WINDOW_INCOMPLETE");}
    else if(!page.has_more||typeof page.next_cursor!=="string"||!page.next_cursor.length||cursors.has(page.next_cursor))return hold("ROW_WINDOW_INVALID");
    if(typeof page.next_cursor==="string")cursors.add(page.next_cursor);
    for(const value of page.results){
      const row=object(value);if(!row||typeof row.id!=="string"||!row.id.length||ids.has(row.id)||row.archived===true||row.in_trash===true||!object(row.properties)||row.parent?.data_source_id!==source!.id)return hold("ROW_WINDOW_INVALID");
      ids.add(row.id);rows.push(row);if(rows.length>25000)return hold("ROW_WINDOW_INVALID");
      for(const p of Object.values(row.properties)){const cell=object(p);if(!cell||cell.has_more===true||cell.rollup?.type==="incomplete")return hold("ROW_WINDOW_INVALID");}
      for(const name of addedFields){const p=object(row.properties[name]);if(!p||p.type!==after[name].type)return hold("ROW_WINDOW_INVALID");if(!empty(p,after[name].type))return hold("ADDED_FIELD_IN_USE");}
      for(const [name,options]of addedOptions){
        const p=object(row.properties[name]),type=after[name].type;if(!p||p.type!==type)return hold("ROW_WINDOW_INVALID");
        const selected=choices(p,type);if(!Array.isArray(selected)||selected.some(x=>!object(x)||typeof x.name!=="string"))return hold("ROW_WINDOW_INVALID");
        if(selected.some(x=>options.some(o=>o.name===x.name||o.id&&o.id===x.id)))return hold("ADDED_OPTION_IN_USE");
      }
    }
  }
  // Modify the fresh local observation, never restore the old snapshot wholesale.
  const schema=structuredClone(current!),restoredRows=structuredClone(rows);
  for(const name of addedFields){delete schema.properties[name];for(const row of restoredRows)delete row.properties[name];}
  for(const [name,options]of addedOptions){const type=after[name].type;schema.properties[name][type].options=schema.properties[name][type].options.filter((x:Obj)=>!options.some(o=>o.name===x.name));}
  return {status:"LOCAL_ROLLBACK_SAFE",code:"OWN_ADDITIONS_ONLY",schema,rows:restoredRows,...flags};
}
