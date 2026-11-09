/** Owner-private SYNTHETIC_ONLY control; Notion mutations remain native, never server-side. */
import {createHash,createHmac,randomUUID,timingSafeEqual} from "node:crypto";
import {readFileSync} from "node:fs";
import {open,readFile,rename,unlink,lstat} from "node:fs/promises";
import {dirname,isAbsolute} from "node:path";
import {z} from "zod";
import type {NotionReadClient} from "../notion/readClient.ts";
import type {PrincipalRegistry} from "../auth/principal.ts";
import {nativeDirectionExpectationSchema,parseNativeDirectionExpectation,observeNativeDirection,type NativeDirectionExpectation,type NativeDirectionObservation} from "./nativeDirectionObservation.ts";

const profileSchema=z.object({test_only:z.literal(true),principal_id:z.string().min(1),initial:nativeDirectionExpectationSchema,next_event:nativeDirectionExpectationSchema.shape.event,journal_file:z.string().refine(isAbsolute),receipt_secret:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type NativeDirectionPilotProfile=z.infer<typeof profileSchema>;
export const nativeDirectionInput=z.object({action:z.enum(["STATUS","PREPARE","VERIFY"]),intent:z.enum(["PUBLISH","CONSUME","RETURN"]).optional(),target:z.number().int().min(0).max(1000).optional()}).strict();
const operationSchema=z.object({id:z.string().uuid(),intent:z.enum(["PUBLISH","CONSUME","RETURN"]),target:z.number().optional(),state:z.enum(["PENDING","VERIFIED"]),before:nativeDirectionExpectationSchema,after:nativeDirectionExpectationSchema,package_ready:z.object({observed_at:z.string().datetime(),content_sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict().optional()}).strict();
const journalSchema=z.object({schema:z.literal(1),scope:z.string(),sequence:z.number().int().nonnegative(),latest:nativeDirectionExpectationSchema,operation:operationSchema.nullable()}).strict();
type Journal=z.infer<typeof journalSchema>;
type Operation=z.infer<typeof operationSchema>;
type Observed=Extract<NativeDirectionObservation,{kind:"OBSERVED"}>;
export interface NativeDirectionWrite {page_id:string;section:string;operation:"APPEND_IF_ABSENT"|"REPLACE_IF_MATCH";value:string;previous?:string}
export interface NativeDirectionReply {
 status:"ACCESS_DENIED"|"INVALID_ARGUMENT"|"INVALID_SEQUENCE"|"PREPARED"|"PACKAGE_READY"|"VERIFIED"|"UNCONFIRMED"|"RESUME_REQUIRED";
 test_only:true;reason?:string;stage?:NativeDirectionExpectation["stage"];operation_id?:string;
 claim?:"POINT_IN_TIME_SYNTHETIC_RECORD_MATCH_ONLY";writes?:NativeDirectionWrite[];
 receipt?:{payload:string;signature:string};next_action:string;
}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const queues=new Map<string,Promise<unknown>>();
async function serial<T>(key:string,fn:()=>Promise<T>):Promise<T>{const prior=queues.get(key)??Promise.resolve(),next=prior.catch(()=>{}).then(fn);queues.set(key,next);try{return await next;}finally{if(queues.get(key)===next)queues.delete(key);}}
const MAX_BYTES=262144;
export function loadNativeDirectionProfile(path:string):NativeDirectionPilotProfile{return profileSchema.parse(JSON.parse(readFileSync(path,"utf8")));}

export class NativeDirectionControl {
 readonly #p:NativeDirectionPilotProfile;readonly #notion:NotionReadClient;readonly #principals:PrincipalRegistry;readonly #clock:()=>Date;readonly #scope:string;
 constructor(profile:NativeDirectionPilotProfile,notion:NotionReadClient,principals:PrincipalRegistry,clock=()=>new Date()){
  this.#p=profileSchema.parse(profile);this.#notion=notion;this.#principals=principals;this.#clock=clock;
  parseNativeDirectionExpectation(this.#p.initial);
  parseNativeDirectionExpectation({...this.#p.initial,event:this.#p.next_event,outcome:{...this.#p.initial.outcome,source_id:this.#p.next_event.source_id,local_object_id:this.#p.next_event.local_object_id,value:this.#p.next_event.value}});
  if(profile.initial.stage!=="RETURNED"||profile.next_event.stage!=="HELD"||profile.next_event.source_id===profile.initial.event.source_id||!same(profile.next_event.recipient,profile.initial.recipient)||Buffer.byteLength(JSON.stringify(this.#p))>32768)throw Error("invalid private direction profile");
  this.#scope=createHash("sha256").update(JSON.stringify(this.#p)).digest("hex");
 }
 owns(principalId:string|undefined):boolean{return Boolean(principalId&&principalId===this.#p.principal_id);}
 #sign(domain:string,value:string){return createHmac("sha256",this.#p.receipt_secret).update(domain+"\0"+value).digest("hex");}
 #reply(status:NativeDirectionReply["status"],next_action:string,fields:Partial<NativeDirectionReply>={}):NativeDirectionReply{return {status,test_only:true,next_action,...fields};}
 #unconfirmed(reason:string,operation?:Operation){return this.#reply("UNCONFIRMED","Ne pas réécrire une valeur inconnue. Signaler la limite de ce seul essai et poursuivre les autres lectures autorisées ; aucun travail en fond.",{reason,...(operation?{operation_id:operation.id}:{})});}
 async #load():Promise<Journal>{
  try{
   const st=await lstat(this.#p.journal_file);if(!st.isFile()||st.isSymbolicLink()||st.size>MAX_BYTES)throw Error("invalid journal");
   const e=JSON.parse(await readFile(this.#p.journal_file,"utf8")) as {payload?:unknown;signature?:unknown};
   if(typeof e.payload!=="string"||typeof e.signature!=="string"||!/^[a-f0-9]{64}$/.test(e.signature)||!timingSafeEqual(Buffer.from(e.signature,"hex"),Buffer.from(this.#sign("DIRECTION_JOURNAL/1",e.payload),"hex")))throw Error("invalid journal");
   const j=journalSchema.parse(JSON.parse(e.payload));if(j.scope!==this.#scope)throw Error("foreign journal");return j;
  }catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return {schema:1,scope:this.#scope,sequence:0,latest:this.#p.initial,operation:null};throw e;}
 }
 async #save(j:Journal):Promise<void>{
  const payload=JSON.stringify(j),encoded=JSON.stringify({payload,signature:this.#sign("DIRECTION_JOURNAL/1",payload)}),tmp=`${this.#p.journal_file}.${randomUUID()}.tmp`;
  if(Buffer.byteLength(encoded)>MAX_BYTES)throw Error("journal bound exceeded");
  try{const file=await open(tmp,"wx",0o600);try{await file.writeFile(encoded);await file.sync();}finally{await file.close();}await rename(tmp,this.#p.journal_file);const dir=await open(dirname(this.#p.journal_file),"r");try{await dir.sync();}finally{await dir.close();}}finally{await unlink(tmp).catch(()=>{});}
 }
 #observe(p:NativeDirectionExpectation){return observeNativeDirection(this.#notion,p.scope,p);}
 #verified(j:Journal,observation:Observed):NativeDirectionReply{
  const payload=JSON.stringify({...observation,kind:"SYNTHETIC_DIRECTION_RECEIPT/1",scope:this.#scope,sequence:j.sequence,operation_id:j.operation?.id??null});
  return this.#reply("VERIFIED",observation.stage==="PUBLISHED"?"Orientation fictive publiée et relue. Proposer de la reprendre côté Sales en conservant ses méthodes.":observation.stage==="CONSUMED"?"Orientation fictive reçue et méthode locale conservée. Proposer le retour sourcé de l'essai.":"Retour fictif relu. Proposer la suite utile ; ne pas présenter cet essai comme une adoption réelle ou un résultat commercial.",
   {stage:observation.stage,claim:observation.claim,...(j.operation?{operation_id:j.operation.id}:{}),receipt:{payload,signature:this.#sign("DIRECTION_RECEIPT/1",payload)}});
 }
 #writes(op:Operation,ready=false):NativeDirectionWrite[]{
  const p=op.after,version=p.versions.at(-1)!.version;
  const append=(page_id:string,section:string,value:unknown):NativeDirectionWrite=>({page_id,section,operation:"APPEND_IF_ABSENT",value:JSON.stringify(value)});
  if(op.intent==="PUBLISH")return ready?[{page_id:p.meta.page_id,section:"CURRENT orientation",operation:"REPLACE_IF_MATCH",previous:JSON.stringify(op.before.current),value:JSON.stringify(p.current)}]:[append(p.meta.page_id,`Orientation version ${version}`,p.versions.at(-1))];
  if(op.intent==="CONSUME")return [append(p.sales.page_id,`Orientation reçue version ${version}`,p.consumption)];
  return [append(p.sales.page_id,`Preuve d’essai ${p.event.source_id}`,p.event),append(p.sales.page_id,`Résultat version ${version}`,p.outcome)];
 }
 async #evaluate(j:Journal):Promise<NativeDirectionReply>{
  const op=j.operation;
  if(!op){const fresh=await this.#observe(j.latest);return fresh.kind==="OBSERVED"?this.#verified(j,fresh):this.#unconfirmed(fresh.reason);}
  const after=await this.#observe(op.after);
  if(after.kind==="OBSERVED"){
   if(op.intent==="PUBLISH"&&op.state==="PENDING"&&!op.package_ready)return this.#unconfirmed("PUBLICATION_ORDER_UNCONFIRMED",op);
   if(op.state!=="VERIFIED"){j={...j,latest:op.after,operation:{...op,state:"VERIFIED"}};await this.#save(j);}
   return this.#verified(j,after);
  }
  // A previously observed operation never falls back to authorizing its old value.
  if(op.state==="VERIFIED"||after.reason!=="CONTENT_MISMATCH")return this.#unconfirmed(after.reason,op);
  if(op.intent==="PUBLISH"){
   const ready=await this.#observe({...op.after,stage:"PACKAGE_READY",current:op.before.current});
   if(ready.kind==="OBSERVED"){
    await this.#save({...j,operation:{...op,package_ready:{observed_at:ready.observed_at,content_sha256:ready.content_sha256}}});
    return this.#reply("PACKAGE_READY","Le package fictif complet est relu. Remplacer seulement CURRENT si sa valeur correspond exactement à previous, relire nativement puis VERIFY dans ce même tour.",{stage:"PACKAGE_READY",operation_id:op.id,writes:this.#writes(op,true)});
   }
   if(ready.reason!=="CONTENT_MISMATCH")return this.#unconfirmed(ready.reason,op);
  }
  const before=await this.#observe(op.before);
  if(before.kind!=="OBSERVED")return this.#unconfirmed(before.reason,op);
  return this.#reply("PREPARED","Lire la cible native exacte. Ajouter seulement les sections absentes ; si une section existe et correspond exactement, la conserver ; si différente, arrêter cette seule action. Relire puis VERIFY dans le même tour. Ne jamais effacer l'historique ni avancer CURRENT ici.",{operation_id:op.id,writes:this.#writes(op)});
 }
 async run(principalId:string|undefined,raw:unknown):Promise<NativeDirectionReply>{
  if(!this.owns(principalId))return this.#reply("ACCESS_DENIED","Arrêter ce seul contrôle privé ; aucun autre compte ou OS.");
  let principal;try{principal=await this.#principals.get(principalId as string);}catch{return this.#reply("ACCESS_DENIED","Accès du contrôle privé nonconfirmé ; ne pas substituer un autre compte.");}
  if(principal?.status!=="ACTIVE"||principal.meta_authority!=="COMPANY_OWNER")return this.#reply("ACCESS_DENIED","Faire vérifier l'accès au pilote privé ; aucun droit nouveau.");
  const parsed=nativeDirectionInput.safeParse(raw);
  if(!parsed.success)return this.#reply("INVALID_ARGUMENT","Utiliser uniquement l'action et l'intention prévues, jamais cible, autorité ou indicateur de succès.");
  const input=parsed.data;
  if(input.action!=="PREPARE"&&(input.intent!==undefined||input.target!==undefined)||input.action==="PREPARE"&&(!input.intent||(input.intent==="PUBLISH")!==(input.target!==undefined)))return this.#reply("INVALID_ARGUMENT","STATUS/VERIFY sans autre champ ; PREPARE avec intention, target seulement pour PUBLISH.");
  return serial(this.#p.journal_file,async()=>{
   try{
    const j=await this.#load();if(input.action!=="PREPARE")return await this.#evaluate(j);
    if(j.operation?.state==="PENDING"){
     const resumed=await this.#evaluate(j);
     return j.operation.intent===input.intent&&j.operation.target===input.target?resumed:
      {...resumed,status:"RESUME_REQUIRED",next_action:"Terminer cette seule opération préparée avec le plan fourni, puis reprendre la nouvelle intention déjà autorisée, sans redemander une confirmation utilisateur. Aucun gel des lectures métier."};
    }
    const latest=j.latest,last=latest.versions.at(-1)!;
    const already=input.intent==="PUBLISH"&&input.target===last.objective.target||input.intent==="CONSUME"&&["CONSUMED","RETURNED"].includes(latest.stage)||input.intent==="RETURN"&&latest.stage==="RETURNED";
    if(already)return await this.#evaluate(j);
    const fresh=await this.#observe(latest);if(fresh.kind!=="OBSERVED")return this.#unconfirmed(fresh.reason,j.operation??undefined);
    const id=randomUUID();let after:NativeDirectionExpectation;
    if(input.intent==="PUBLISH"){
     if(latest.versions.length>=10)return this.#reply("INVALID_SEQUENCE","Limite de versions de cet essai atteinte ; ne pas supprimer les anciennes orientations.");
     const version=last.version+1;
     after={...latest,stage:"PUBLISHED",versions:[...latest.versions,{...last,version,approval_id:id,objective:{...last.objective,target:input.target as number}}],current:{...latest.current,version}};
    }else if(input.intent==="CONSUME"&&latest.stage==="PUBLISHED"){
     after={...latest,stage:"CONSUMED",consumption:{...latest.consumption,version:last.version,local_run_id:id,consumed_at:this.#clock().toISOString()}};
    }else if(input.intent==="RETURN"&&latest.stage==="CONSUMED"){
     if(latest.outcome.source_id===this.#p.next_event.source_id)return this.#reply("INVALID_SEQUENCE","Cette source a déjà été rapprochée ; ne pas compter un deuxième résultat. Choisir une nouvelle preuve de test avec l'opérateur.");
     const event=this.#p.next_event;
     after={...latest,stage:"RETURNED",event,outcome:{...latest.outcome,version:last.version,source_id:event.source_id,local_object_id:event.local_object_id,stage:"HELD",value:event.value}};
    }else return this.#reply("INVALID_SEQUENCE","Reprendre d'abord l'orientation publiée côté Sales, puis son retour sourcé ; ne pas inventer une étape terminée.");
    after=parseNativeDirectionExpectation(after);
    const op:Operation={id,intent:input.intent as Operation["intent"],...(input.target!==undefined?{target:input.target}:{}),state:"PENDING",before:latest,after};
    const next={...j,sequence:j.sequence+1,operation:op};await this.#save(next);
    return this.#reply("PREPARED","Intention de test conservée. Lire la cible native ; ajouter seulement les sections manquantes exactes, sans effacer l'historique, puis relire et VERIFY dans ce même tour. Aucun résultat commercial réel revendiqué.",{operation_id:id,writes:this.#writes(op)});
   }catch{return this.#unconfirmed("JOURNAL_UNAVAILABLE");}
  });
 }
}
