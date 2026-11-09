// Offline only: no connector, filesystem, runtime, installer or source writer.
// Native generated fields differ; exact source rows remain explicit JSON provenance.
import {createHash} from "node:crypto";
type JsonMap = Record<string, any>;
export type ReconstructionTable={key:string;typed_schema:{db_id:string;ds_id:string;properties:JsonMap};typed_rows:JsonMap[]};
export type ReconstructionContext={copy:"D1"|"D2";createdIds:string[];sourceIds:string[]};
const reserved=["W73 Source ID","W73 Nonactive"];
const norm=(id:string)=>id.replaceAll("-","");
const quoted=(s:string)=>'"'+s.replaceAll('"','""')+'"';
const literal=(s:string)=>"'"+s.replaceAll("'","''")+"'";
const colors=new Set(["default","gray","brown","orange","yellow","green","blue","purple","pink","red"]);
const simple=new Set(["title","rich_text","date","checkbox","url","email","phone_number","created_time","last_edited_time"]);
function target(id:string,map:Record<string,string>,context:ReconstructionContext):string{
  const result=map[id]??map[norm(id)];
  if(!result)throw Error("UNMAPPED_TARGET");
  if(norm(result)===norm(id)||context.sourceIds.some(x=>norm(x)===norm(result)))throw Error("SOURCE_TARGET");
  if(!context.createdIds.some(x=>norm(x)===norm(result)))throw Error("OUTSIDE_COPY");
  return result;
}
function checkSchema(t:ReconstructionTable){
  if(reserved.some(n=>Object.hasOwn(t.typed_schema.properties,n)))throw Error("RESERVED_PROPERTY");
  if(Object.values(t.typed_schema.properties).filter(p=>p.type==="title").length!==1)throw Error("INVALID_TITLE_SCHEMA");
}
function typeDDL(p:JsonMap,t:ReconstructionTable,context:ReconstructionContext):string{
  if(simple.has(p.type))return p.type.toUpperCase();
  if(p.type==="number")return "NUMBER FORMAT "+literal(p.number.format);
  if(p.type==="unique_id")return "UNIQUE_ID PREFIX "+literal("W73"+context.copy+"-"+t.key.replace(/[^A-Z0-9]/g,"").slice(0,4));
  if(p.type==="select"||p.type==="multi_select")return p.type.toUpperCase()+"("+p[p.type].options.map((o:JsonMap)=>{
    if(!colors.has(o.color))throw Error("UNSUPPORTED_COLOR");
    return literal(o.name)+":"+o.color;
  }).join(", ")+")";
  throw Error("UNSUPPORTED_PROPERTY_TYPE:"+p.type);
}
export function reconstructionSchema(t:ReconstructionTable,context:ReconstructionContext):string{
  checkSchema(t);
  if(!["D1","D2"].includes(context.copy))throw Error("INVALID_COPY");
  return "CREATE TABLE ("+[...Object.entries(t.typed_schema.properties).filter(([,p])=>p.type!=="relation").map(([n,p])=>{
    const generated=["unique_id","created_time","last_edited_time"].includes(p.type);
    const description=generated?"COPY-GENERATED; historical values retained in source provenance"+(p.description?"; "+p.description:""):p.description;
    return quoted(n)+" "+typeDDL(p,t,context)+(description?" COMMENT "+literal(description):"");
  }),
    '"W73 Source ID" RICH_TEXT','"W73 Nonactive" CHECKBOX'].join(", ")+")";
}
export function reconstructionRelations(t:ReconstructionTable,map:Record<string,string>,context:ReconstructionContext):string{
  checkSchema(t);
  return Object.entries(t.typed_schema.properties).filter(([,p])=>p.type==="relation").map(([n,p])=>{
    if(p.relation.type!=="single_property")throw Error("UNSUPPORTED_DUAL_RELATION");
    return "ADD COLUMN "+quoted(n)+" RELATION("+literal(target(p.relation.data_source_id,map,context))+")";
  }).join("; ");
}
export function reconstructionRichText(parts:JsonMap[],map:Record<string,string>,context:ReconstructionContext,outsideScope:string[]=[]):string{
  // Notion MCP property strings are LITERAL SQLite scalars, not Markdown.
  // Native fragment annotations/links remain exact in the source JSON provenance.
  return parts.map(v=>{
    if(v.type==="text"){
      return v.text.content;
    }else if(v.type==="mention"&&v.mention?.type==="page"){
      const id=v.mention.page.id;
      return 'https://www.notion.so/'+norm(outsideScope.some(x=>norm(x)===norm(id))?id:target(id,map,context));
    }else throw Error("UNSUPPORTED_RICH_TEXT_TYPE");
  }).join("");
}
export function reconstructionRow(t:ReconstructionTable,r:JsonMap,map:Record<string,string>,context:ReconstructionContext,deferReferences=false,outsideScope:string[]=[]){
  checkSchema(t);
  const parent=r.parent?.data_source_id??r.parent?.database_id;
  if(!parent||(norm(parent)!==norm(t.typed_schema.ds_id)&&norm(parent)!==norm(t.typed_schema.db_id)))throw Error("WRONG_SOURCE_PARENT");
  if(r.archived||r.in_trash)throw Error("UNSUPPORTED_ARCHIVED_ROW");
  if(Object.keys(r.properties).some(n=>!Object.hasOwn(t.typed_schema.properties,n)))throw Error("UNSCHEMED_PROPERTY");
  const properties:Record<string,string|number|string[]|null>={"W73 Source ID":r.id,"W73 Nonactive":"__YES__"};
  const deferred:string[]=[];
  for(const [n,schema]of Object.entries(t.typed_schema.properties)){
    const p=r.properties[n];
    if(!p||p.type!==schema.type)throw Error("MISSING_PROPERTY:"+n);
    if(p.has_more)throw Error("TRUNCATED_PROPERTY");
    const name=/^(id|url)$/i.test(n)?"userDefined:"+n:n;
    switch(p.type){
      case "title":case "rich_text":{
        const refs=p[p.type].filter((v:JsonMap)=>v.type==="mention");
        if(deferReferences&&refs.length){deferred.push(n);if(p.type==="title")throw Error("DEFERRED_TITLE");break;}
        properties[name]=reconstructionRichText(p[p.type],map,context,outsideScope);break;
      }
      case "select":properties[name]=p.select?.name??null;break;
      case "multi_select":properties[name]=p.multi_select.map((v:JsonMap)=>v.name);break;
      case "number":if(p.number!==null&&!Number.isFinite(p.number))throw Error("NON_JSON_NUMBER");properties[name]=p.number;break;
      case "checkbox":if(typeof p.checkbox!=="boolean")throw Error("INVALID_CHECKBOX");properties[name]=p.checkbox?"__YES__":"__NO__";break;
      case "url":case "email":case "phone_number":properties[name]=p[p.type];break;
      case "date":{
        if(p.date?.time_zone)throw Error("UNSUPPORTED_TIME_ZONE");
        properties["date:"+n+":start"]=p.date?.start??null;
        if(p.date){if(p.date.end)properties["date:"+n+":end"]=p.date.end;properties["date:"+n+":is_datetime"]=p.date.start.includes("T")?1:0;}
        break;
      }
      case "relation":
        if(deferReferences){if(p.relation.length)deferred.push(n);break;}
        properties[name]=p.relation.map((v:JsonMap)=>target(v.id,map,context));break;
      case "unique_id":case "created_time":case "last_edited_time":break;
      default:throw Error("UNSUPPORTED_PROPERTY_TYPE:"+p.type);
    }
  }
  return {properties,content:"Reconstitution partielle NONACTIVE. Valeurs historiques ci-dessous, sans preuve d'accès actuelle ni autorité d'exécution. Les métadonnées natives générées de cette copie sont nouvelles. Le contenu de page historique, versions, commentaires et vues ne sont pas reproduits.\n\n```json\n"+JSON.stringify(r).replaceAll("`","\\u0060")+"\n```",deferred};
}

/** DDL draft only, for observed D1 targets. Never a writer, restore proof or executable inverse. */
export function reconstructionAdditionPlan(dataSourceId:string,state:{schema:JsonMap;[key:string]:unknown},changes:{properties:string[];options:Record<string,string[]>},context:ReconstructionContext){
  if(context.copy!=="D1")throw Error("D1_ONLY");
  if(context.sourceIds.some(id=>norm(id)===norm(dataSourceId)))throw Error("SOURCE_TARGET");
  if(!context.createdIds.some(id=>norm(id)===norm(dataSourceId)))throw Error("OUTSIDE_COPY");
  if(!state.schema||Object.values(state.schema).filter(p=>p.type==="title").length!==1)throw Error("INVALID_NATIVE_SCHEMA");
  if(new Set(changes.properties).size!==changes.properties.length)throw Error("DUPLICATE_CHANGE");
  const statements:string[]=[];
  for(const name of changes.properties){
    if(typeof name!=="string"||!name.length)throw Error("INVALID_PROPERTY");
    if(Object.hasOwn(state.schema,name))throw Error("EXISTING_PROPERTY");
    statements.push("ADD COLUMN "+quoted(name)+" RICH_TEXT");
  }
  for(const [name,added]of Object.entries(changes.options)){
    const p=state.schema[name];
    if(!p||p.type!=="select"||p.readOnly||!Array.isArray(p.options))throw Error("UNSUPPORTED_OPTION_TYPE");
    if(!Array.isArray(added)||added.some(n=>typeof n!=="string"||!n.length)||new Set(added).size!==added.length)throw Error("DUPLICATE_OR_INVALID_OPTION_CHANGE");
    const old=p.options as {name:string;color:string}[];
    if(old.some(o=>typeof o.name!=="string"||!o.name.length||!colors.has(o.color))||new Set(old.map(o=>o.name)).size!==old.length)throw Error("INVALID_NATIVE_OPTIONS");
    if(added.some(n=>old.some(o=>o.name===n)))throw Error("EXISTING_OPTION");
    if(added.length)statements.push("ALTER COLUMN "+quoted(name)+" SET SELECT("+[
      ...old.map(o=>literal(o.name)+":"+o.color),...added.map(n=>literal(n)+":default")
    ].join(", ")+")");
  }
  const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v!==null&&typeof v==="object"?
    Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
  return {data_source_id:dataSourceId,expected_schema_sha256:createHash("sha256").update(JSON.stringify(canonical(state))).digest("hex"),
    statements:statements.join("; "),execution_authorized:false as const,native_restore_proved:false as const,
    rollback_prerequisites:{owned_added_properties:[...changes.properties],owned_added_options:structuredClone(changes.options),
      full_fresh_row_read_required:true as const,used_or_changed_addition:"REFUSE" as const}};
}
