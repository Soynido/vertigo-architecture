import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {nativeNoteInput,nativeNoteReadInput,type NativeNoteControl} from "../verify/nativeNoteControl.ts";
import {nativeDirectionInput,type NativeDirectionControl} from "../verify/nativeDirectionControl.ts";
import {nativeMetaInput,type NativeMetaControl} from "../verify/nativeMetaControl.ts";
import type {RealDirectionControl} from '../verify/realDirectionControl.ts';
import {registerRealDirectionTool,realDirectionInstructions} from './realDirection.ts';

/** Served ONLY for the exact operator-configured owner, never other principals. No legacy OS ritual. */
export function createNativePilotServer(control:NativeNoteControl,principalId:string,version:string,direction?:NativeDirectionControl,meta?:NativeMetaControl,realDirection?:RealDirectionControl):McpServer{
 const server=new McpServer({name:"vertigo-private-note-control",version},{instructions:
  (realDirection?realDirectionInstructions+' ':'')+"For a read-only private-note request or cold note lookup use vertigo_note_read with no arguments. It independently reads the existing note and signed journal without changing either. An absent or conflicting result never authorizes repair, a new intent or a write. The mixed vertigo_note_control remains for explicitly requested note-save workflows only. "+(direction&&!realDirection?
  "Private owner SYNTHETIC_ONLY controls. Native Notion remains the read/write connector. The note control retains its exact single-page journal/protocol. vertigo_direction_control concerns ONLY the operator-configured two fictional META/Sales pages, never real OS, Q4 publication, collaborators, mail or calendar. For an explicitly requested direction test, STATUS resumes its durable state; PREPARE PUBLISH with the user's numerical test objective, CONSUME or RETURN, follow ONLY returned writes and fresh native compare/readback, then VERIFY in the SAME turn. PUBLISH must independently observe PACKAGE_READY before changing CURRENT. Append immutable versioned records; never erase earlier versions or local methods. Replay/resume the same operation, no user 'Continue' ritual or invented background work. Refusals are local to this check, not native business-read denial. Every receipt attests exact fictional records at a moment, not authenticated real recipient use, real-world performance or atomicity. Ordinary real business reads must not consume these test goals. Short French business response and concrete next step. No legacy os_bind/os_commit or onboarding ritual." :
  "Private owner TEST_ONLY control. Native Notion remains the read/write connector. This server only records an intent and independently reads ONE operator-configured synthetic page. It cannot authorize any OS, mail, calendar, campaign, migration or other page write. For an explicitly requested test-note save, use vertigo_note_control STATUS then PREPARE, native targeted write/readback then VERIFY in the SAME turn. Never let an old receipt override a newer native read. Never invent success or deferred background work. A refusal concerns only this private check, not other authorized native reads. Respond in short French business language, with a concrete next step. No legacy os_bind/os_commit or onboarding ritual belongs to this private pilot.")});
 server.registerTool("vertigo_note_read",{
  description:"Lecture seule de la note privée du propriétaire : relit la cible fixe et son journal signé, retourne une observation fraîche sans écrire dans Notion ni dans le journal. Aucun argument. Une note vérifiée signifie seulement présence exacte observée maintenant, pas décision META publiée ni transaction atomique. Un conflit reste local et ne doit pas être réparé par cette lecture.",
  inputSchema:nativeNoteReadInput,annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
 },async input=>{
  const result=await control.read(principalId,input);
  console.error(`${new Date().toISOString()} tool=vertigo_note_read outcome=${result.status} code=${result.reason??"NONE"}`);
  return {content:[{type:"text" as const,text:JSON.stringify(result)}],isError:result.status==="ACCESS_DENIED"||result.status==="INVALID_ARGUMENT"};
 });
 server.registerTool("vertigo_note_control",{
  description:"Contrôle privé de la note d'essai du propriétaire : STATUS reprend le journal durable et relit Notion ; PREPARE conserve une note demandée avant l'écriture native ; VERIFY relit indépendamment après sauvegarde. Ne fournit jamais de page, principal, reçu ou indicateur de succès en entrée. Un statut VERIFIED vaut seulement présence exacte observée à cette heure, pas autorisation métier ni transaction atomique.",
  inputSchema:nativeNoteInput,
  annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true},
 },async input=>{
  const result=await control.run(principalId,input);
  // Closed enums only. No text, targets, operation handles, signatures, credentials or raw errors in logs.
  console.error(`${new Date().toISOString()} tool=vertigo_note_control outcome=${result.status} code=${result.reason??"NONE"}`);
  return {content:[{type:"text" as const,text:JSON.stringify(result)}],isError:result.status==="ACCESS_DENIED"||result.status==="INVALID_ARGUMENT"};
 });
 if(realDirection)registerRealDirectionTool(server,realDirection,principalId);
 else if(direction)server.registerTool("vertigo_direction_control",{
  description:"Pilote privé fictif META/Sales. STATUS relit l'état courant et reprend le journal ; PREPARE conserve une intention PUBLISH (target numérique), CONSUME ou RETURN ; VERIFY relit indépendamment les records natifs. Suivre seulement les writes renvoyés, garder les méthodes et versions passées ; CURRENT après PACKAGE_READY seulement. Aucun page/principal/record/receipt/PASS fourni par le modèle. Les preuves portent sur des données fictives, pas une adoption réelle.",
  inputSchema:nativeDirectionInput,annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true},
 },async input=>{
  const result=await direction.run(principalId,input);
  console.error(`${new Date().toISOString()} tool=vertigo_direction_control outcome=${result.status} code=${result.reason??"NONE"}`);
  return {content:[{type:"text" as const,text:JSON.stringify(result)}],isError:result.status==="ACCESS_DENIED"||result.status==="INVALID_ARGUMENT"};
 });
 if(meta)server.registerTool("vertigo_meta_control",{
  description:"Lecture du vrai META propriétaire manager : STATUS observe les champs du profil ; CONTEXT assemble les décisions et bilans des seules sources opérateur configurées, avec portée, dates et couverture bornée. Cibles/identités fixes, relecture indépendante et reçu signé. Aucun ID ni compte fourni en entrée. OBSERVED n'est ni une priorité validée, ni autorité sémantique, transaction, publication/adoption ou vérité Gmail/Calendar. Les limites sont locales, aucun Sales propriétaire requis ni écriture.",
  inputSchema:nativeMetaInput,annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
 },async input=>{
  const result=await meta.run(principalId,input);
  console.error(`${new Date().toISOString()} tool=vertigo_meta_control outcome=${result.status} code=${result.status==="OBSERVED"?"NONE":result.reason??"NONE"}`);
  return {content:[{type:"text" as const,text:JSON.stringify(result)}],isError:result.status==="ACCESS_DENIED"||result.status==="INVALID_ARGUMENT"};
 });
 return server;
}
