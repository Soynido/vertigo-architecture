/** Owner-only TEST_ONLY pilot. Native Notion writes stay outside this read-only controller. */
import {createHash,createHmac,randomUUID,timingSafeEqual} from "node:crypto";
import {readFileSync} from "node:fs";
import {open,readFile,rename,unlink,lstat} from "node:fs/promises";
import {dirname,isAbsolute} from "node:path";
import {z} from "zod";
import type {PrincipalRegistry} from "../auth/principal.ts";
import type {NotionReadClient} from "../notion/readClient.ts";
import {observeNativeNote,type NativeNoteObservation,type NativeNoteScope} from "./nativeNoteObservation.ts";

const profileSchema=z.object({
 principal_id:z.string().min(1),runtime_id:z.string().min(1),runtime_generation:z.string().min(1),
 page_id:z.string().regex(/^[a-f0-9]{32}$/),marker:z.string().min(1),section:z.string().min(1),note_key:z.string().min(1),
 initial_text:z.string().min(1),journal_file:z.string().refine(isAbsolute),receipt_secret:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type NativeNotePilotProfile=z.infer<typeof profileSchema>;
export const nativeNoteInput=z.object({action:z.enum(["STATUS","PREPARE","VERIFY"]),note_text:z.string().trim().min(1).max(2000).refine(s=>!s.includes("\n")).optional()}).strict();
export const nativeNoteReadInput=z.object({}).strict();
type Observation=Extract<NativeNoteObservation,{kind:"OBSERVED"}>;
interface Operation {id:string;text:string;previous_text:string;created_at:string;observation?:Observation}
interface Journal {version:1;scope:string;sequence:number;operation:Operation|null}
export interface NativeNoteReply {
 status:"ACCESS_DENIED"|"INVALID_ARGUMENT"|"PREPARED"|"VERIFIED"|"UNCONFIRMED"|"EMPTY";
 reason?:string;operation_id?:string;note_text?:string;page_id?:string;note_key?:string;previous_text?:string;
 receipt?:{payload:string;signature:string};next_action:string;
}
/** One server process is the writer of this private file. Serialize across per-request controller instances. */
const queues=new Map<string,Promise<unknown>>();
async function serial<T>(key:string,fn:()=>Promise<T>):Promise<T>{
 const prior=queues.get(key)??Promise.resolve();const next=prior.catch(()=>{}).then(fn);queues.set(key,next);
 try{return await next;}finally{if(queues.get(key)===next)queues.delete(key);}
}
export function loadNativeNoteProfile(path:string):NativeNotePilotProfile {
 const p=profileSchema.parse(JSON.parse(readFileSync(path,"utf8")));
 return Object.freeze(p);
}

export class NativeNoteControl {
 readonly #p:NativeNotePilotProfile;readonly #notion:NotionReadClient;readonly #principals:PrincipalRegistry;readonly #scope:NativeNoteScope;readonly #digest:string;
 constructor(profile:NativeNotePilotProfile,notion:NotionReadClient,principals:PrincipalRegistry){
  this.#p=profileSchema.parse(profile);this.#notion=notion;this.#principals=principals;
  this.#scope={principal_id:profile.principal_id,runtime_id:profile.runtime_id,runtime_generation:profile.runtime_generation};
  this.#digest=createHash("sha256").update(JSON.stringify([this.#scope,profile.page_id,profile.marker,profile.section,profile.note_key])).digest("hex");
 }
 owns(principalId:string|undefined):boolean{return Boolean(principalId&&principalId===this.#p.principal_id);}
 #sign(value:string):string{return createHmac("sha256",this.#p.receipt_secret).update(value).digest("hex");}
 async #load():Promise<Journal>{
  try{
   const st=await lstat(this.#p.journal_file);if(!st.isFile()||st.isSymbolicLink()||st.size>32768)throw Error("journal invalid");
   const e=JSON.parse(await readFile(this.#p.journal_file,"utf8")) as {payload:string;signature:string};
   if(typeof e.payload!=="string"||typeof e.signature!=="string"||!/^[a-f0-9]{64}$/.test(e.signature)||!timingSafeEqual(Buffer.from(e.signature,"hex"),Buffer.from(this.#sign(e.payload),"hex")))throw Error("journal invalid");
   const j=JSON.parse(e.payload) as Journal;
   if(j.version!==1||j.scope!==this.#digest||!Number.isSafeInteger(j.sequence)||j.sequence<0||
    (j.operation!==null&&(!j.operation||typeof j.operation.id!=="string"||typeof j.operation.text!=="string"||!j.operation.text||typeof j.operation.previous_text!=="string")))throw Error("journal invalid");
   return j;
  }catch(err){if((err as NodeJS.ErrnoException).code==="ENOENT")return {version:1,scope:this.#digest,sequence:0,operation:null};throw err;}
 }
 async #save(j:Journal):Promise<void>{
  const payload=JSON.stringify(j),temp=`${this.#p.journal_file}.${randomUUID()}.tmp`;
  try{
   const f=await open(temp,"wx",0o600);try{await f.writeFile(JSON.stringify({payload,signature:this.#sign(payload)}));await f.sync();}finally{await f.close();}
   await rename(temp,this.#p.journal_file);const dir=await open(dirname(this.#p.journal_file),"r");try{await dir.sync();}finally{await dir.close();}
  }finally{await unlink(temp).catch(()=>{});}
 }
 async #observe(text:string){return observeNativeNote(this.#notion,this.#scope,{scope:this.#scope,page_id:this.#p.page_id,marker:this.#p.marker,section:this.#p.section,note_key:this.#p.note_key,note_text:text});}
 #result(j:Journal,observation:NativeNoteObservation):NativeNoteReply {
  const op=j.operation;
  if(observation.kind!=="OBSERVED")return {status:"UNCONFIRMED",reason:observation.reason,...(op?{operation_id:op.id,note_text:op.text}:{}),next_action:"Relire la note native sans l'écraser. Ce contrôle concerne seulement l'essai ; continuer les lectures métier autorisées, sans déclarer la note vérifiée."};
  const payload=JSON.stringify({version:1,scope:this.#digest,sequence:j.sequence,operation_id:op?.id??null,section:this.#p.section,...observation});
  return {status:op?"VERIFIED":"EMPTY",...(op?{operation_id:op.id,note_text:op.text}:{}),receipt:{payload,signature:this.#sign(payload)},next_action:op?"Restituer la note lue puis proposer de la retrouver dans un nouveau chat, ou de choisir la prochaine fonction de l'essai. Aucun travail en fond.":"Le contrôle est prêt. Proposer une note d'essai ; aucune écriture métier."};
 }
 /** A fresh signed observation only: never persist an observation or finish a pending intent. */
 async read(principalId:string|undefined,raw:unknown={}):Promise<NativeNoteReply>{
  const denied=():NativeNoteReply=>({status:"ACCESS_DENIED",next_action:"Arrêter ce seul contrôle privé ; ne pas utiliser un autre compte."});
  if(!this.owns(principalId))return denied();
  if(!nativeNoteReadInput.safeParse(raw).success)return {status:"INVALID_ARGUMENT",next_action:"Lire la note privée sans aucun argument ni action de modification."};
  return serial(this.#p.journal_file,async()=>{
   try{
    const before=await this.#principals.get(principalId as string);
    if(before?.status!=="ACTIVE"||before.meta_authority!=="COMPANY_OWNER")return denied();
    const j=await this.#load(),observation=await this.#observe(j.operation?.text??this.#p.initial_text);
    const after=await this.#principals.get(principalId as string);
    if(after?.status!=="ACTIVE"||after.meta_authority!=="COMPANY_OWNER")return denied();
    return this.#result(j,observation);
   }catch{return {status:"UNCONFIRMED",reason:"READ_UNAVAILABLE",next_action:"Conserver la note native ; ce contrôle de lecture ne peut pas confirmer son état. Ne pas réécrire ni réinitialiser le journal."};}
  });
 }
 async run(principalId:string|undefined,raw:unknown):Promise<NativeNoteReply>{
  if(!this.owns(principalId))return {status:"ACCESS_DENIED",next_action:"Arrêter ce seul contrôle privé ; ne pas utiliser un autre compte."};
  const principal=await this.#principals.get(principalId as string);
  if(principal?.status!=="ACTIVE"||principal.meta_authority!=="COMPANY_OWNER")return {status:"ACCESS_DENIED",next_action:"Faire vérifier l'accès au contrôle privé ; aucune mutation autorisée par ce refus."};
  const parsed=nativeNoteInput.safeParse(raw);
  if(!parsed.success||(parsed.data.action==="PREPARE")!==Boolean(parsed.data.note_text))return {status:"INVALID_ARGUMENT",next_action:"Utiliser STATUS ou VERIFY sans autre champ, ou PREPARE avec la seule note naturelle de l'utilisateur."};
  return serial(this.#p.journal_file,async()=>{
   try{
    let j=await this.#load();const op=j.operation;const input=parsed.data;
    if(input.action==="PREPARE"&&input.note_text!==op?.text){
     // A new intent never treats an old receipt as a current snapshot or overwrites an unknown native edit.
     const observation=await this.#observe(op?.text??this.#p.initial_text);
     if(observation.kind!=="OBSERVED")return this.#result(j,observation);
     j={...j,sequence:j.sequence+1,operation:{id:randomUUID(),text:input.note_text as string,previous_text:op?.text??this.#p.initial_text,created_at:new Date().toISOString()}};
     await this.#save(j);
     return {status:"PREPARED",operation_id:j.operation!.id,note_text:j.operation!.text,page_id:this.#p.page_id,note_key:this.#p.note_key,previous_text:op?.text??this.#p.initial_text,next_action:"Lire la cible native attendue, remplacer seulement cette note si sa valeur correspond à previous_text, relire, puis appeler VERIFY dans ce même tour. Aucun autre champ ni section à modifier."};
    }
    const observation=await this.#observe(op?.text??this.#p.initial_text);
    if(observation.kind==="OBSERVED"&&op){j={...j,operation:{...op,observation}};await this.#save(j);}
    // Replayed PREPARE before the native write returns the SAME operation, not a new intent or blind rewrite.
    if(input.action==="PREPARE"&&observation.kind==="UNCONFIRMED"&&observation.reason==="CONTENT_MISMATCH"&&op&&!op.observation){
     const before=await this.#observe(op.previous_text);
     if(before.kind==="OBSERVED")return {status:"PREPARED",operation_id:op.id,note_text:op.text,page_id:this.#p.page_id,note_key:this.#p.note_key,previous_text:op.previous_text,next_action:"Reprendre cette même note préparée, sans créer une autre opération ; écriture native ciblée puis VERIFY."};
    }
    return this.#result(j,observation);
   }catch{return {status:"UNCONFIRMED",reason:"JOURNAL_UNAVAILABLE",next_action:"Conserver la note native et signaler que le contrôle privé ne peut pas confirmer sa reprise. Ne pas réécrire ni réinitialiser le journal ; les autres lectures autorisées restent possibles."};}
  });
 }
}
