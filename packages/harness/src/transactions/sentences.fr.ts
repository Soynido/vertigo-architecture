/**
 * The French sentence of a candidate TransactionOutcome (os_commit, PV-WRITE-001 A.3 — PDEC-018 CANDIDATE, NOT
 * ADOPTED). One human sentence per outcome, never a code, an id or a value. These sentences belong to the
 * transaction and never enter the six-tool envelope's map (tools/messages.fr.ts).
 */
import type { CommitOutcome } from "./commit.ts";

const HELD_SAY: Readonly<Record<string, string>> = {
  HOLD_P0_PRODUCTION: "Une règle prioritaire de votre espace bloque cette action pour l'instant ; rien n'a été écrit.",
  HOLD_DECLARED_CONSTRAINT_UNVERIFIABLE: "Je ne peux pas démontrer que les garde-fous de votre espace permettent cette action ; rien n'a été écrit.",
  HOLD_ACTION_NOT_AUTHORIZED: "Cette modification n'est pas autorisée depuis la conversation ; rien n'a été écrit.",
  HOLD_INSTALL_REQUIRED: "L'installation de votre espace doit d'abord se terminer ; rien n'a été écrit.",
  HOLD_SERVER_WRITES_DISABLED: "L'enregistrement automatique est désactivé pour le moment ; rien n'a été écrit.",
};

export function commitSentence(o: CommitOutcome): string {
  switch (o.kind) {
    case "PERSISTED": {
      if (o.targets?.length === 1 && o.targets[0]?.logical_resource_key === "SALES:SOURCE_IDENTITY")
        return "Le compte que vous avez confirmé est rattaché à votre espace et l'enregistrement est vérifié. Je dois encore vérifier les accès nécessaires ; aucun message n'a été envoyé.";
      if (["AUTO_RECONCILE", "AUTO_RECOVERY"].includes(o.origin) && o.targets.length === 2
        && o.targets[0]?.logical_resource_key === "SALES:INTERACTIONS" && o.targets[1]?.logical_resource_key === "SALES:RECEIPTS"
        && o.targets.every((t) => t.operation === "CREATE"))
        return `${o.repeated ? "C'était déjà enregistré ; rien n'a été écrit une seconde fois." : "La capture de l'envoi est enregistrée et relue dans Notion."} Elle provient de la lecture Gmail fournie dans cette conversation, pas d'une vérification de l'envoi par le serveur. Aucun message ne sera renvoyé.`;
      const first = o.repeated ? "C'était déjà enregistré ; rien n'a été écrit une seconde fois." : o.step_moved ? "C'est enregistré et vérifié, et l'étape suivante est ouverte." : "C'est enregistré et vérifié dans Notion.";
      return o.derived_move === "DEFERRED" || o.derived_move === "IN_PROGRESS" || o.derived_move === "INTERRUPTED" ? `${first} Le passage à l'étape suivante se terminera au prochain échange.` : first;
    }
    case "IN_PROGRESS":
      return "L'enregistrement n'est pas encore terminé. Répondez « Continue » pour que je reprenne la sauvegarde déjà préparée, sans la recommencer.";
    case "INTERRUPTED":
      return "L'enregistrement s'est interrompu avant la fin. Répondez « Continue » pour que je reprenne à partir de ce qui est déjà écrit, sans rien dupliquer.";
    case "HELD":
      if (o.evidence?.[0] === "SOURCE_ENROLLMENT_DECLINED" && o.wrote_anything === false)
        return "D'accord, je ne rattache pas ce compte à votre espace. Rien n'a été enregistré.";
      if (o.source_identity_enrollment?.stage === "CONFIRM" && o.wrote_anything === false)
        return `Le profil ${o.source_identity_enrollment.source_label} lu dans ce chat indique ${o.source_identity_enrollment.source_identity}. Utiliser ce compte pour votre espace ? Rien n'a encore été enregistré.`;
      return HELD_SAY[o.code] ?? (o.wrote_anything
        ? "L'enregistrement s'est arrêté sur un point à vérifier ; ce qui est déjà écrit sera repris sans duplication."
        : "Rien n'a été écrit : un point doit d'abord être vérifié.");
  }
}
