/**
 * User-facing sentences (PV0-020B). The harness, not the model, decides what the user hears: every code maps to a
 * French sentence with no code, no identifier and no tool vocabulary; `ask` is present only when a human answer is
 * required. The model repeats `say` verbatim (SKILL §Voice). Deterministic: same envelope ⇒ same sentence.
 */
import type { Code, ErrorCode, HoldCode, OkCode } from "../errors/codes.ts";
import type { Envelope } from "./envelope.ts";
import type { ToolName } from "./surface.ts";

/**
 * Per-message app reminder (PV0-020E). Whenever `ask` is present, `say` is the COMPLETE rendered turn in the fixed
 * order « state. canonical question reminder » — the reminder last, never duplicated — because the user's reply to any
 * question is a tool-required message and ChatGPT exposes apps per message. Emitted by the harness so it never
 * depends on the Skill being loaded that turn. `ask` stays pure data (the canonical question, copied into the
 * persisted `Question`) and is never re-displayed by the model.
 */
export const APP_REMINDER = "Gardez VERTIGO et Notion sélectionnés sur votre réponse.";
/** Said once on a fixture binding: a test runtime says nothing about the live company sources (PV0-020C). */
export const FIXTURE_SENTENCE = "Attention : ceci est un espace de test. Il ne contient pas les sources vivantes de l'entreprise ; leur absence ici ne dit rien de leur existence.";
const LANE_LABEL: Record<string, string> = { META: "votre espace de pilotage VERTIGO", SALES: "votre espace de prospection" };

export const HOLD_SAY: Readonly<Record<HoldCode, string>> = {
  HOLD_UNAUTHORIZED_LANE: "Cet espace ne vous est pas ouvert. Je reste sur les espaces qui vous sont attribués.",
  HOLD_LANE_REQUIRED: "Il me faut une précision avant de commencer.",
  HOLD_RUNTIME_NOT_FOUND: "Je ne trouve pas votre espace de travail. Il doit être créé ou partagé avant de continuer.",
  HOLD_RUNTIME_NOT_YET_CREATED: "Votre espace de travail n'a pas encore été créé. Je ne peux rien faire avant sa mise en place.",
  HOLD_RUNTIME_AMBIGUOUS: "Plusieurs espaces de travail correspondent à votre profil. Une vérification humaine est nécessaire avant de continuer.",
  HOLD_BOOTSTRAP_DISCOVERY: "Je n'arrive pas à lire la page de référence de l'espace. Vérifiez qu'elle est partagée, puis réessayez.",
  HOLD_RUNTIME_MANIFEST_MISMATCH: "Les informations de votre espace ne concordent pas entre elles. Une vérification humaine est nécessaire.",
  HOLD_RUNTIME_TEMPLATE_NOT_INSTANCE: "L'espace trouvé est un modèle vierge, pas votre espace. Il faut d'abord l'installer.",
  HOLD_INSTALL_REQUIRED: "Votre espace est bien attribué, mais son installation n'est pas encore vérifiée. Je limite les actions à cette installation.",
  HOLD_BINDING_STALE_RUNTIME_ROTATED: "Votre espace a changé d'adresse depuis le début de la conversation. Je me reconnecte avant de continuer.",
  HOLD_VERSION_RESOLUTION: "La version de référence de l'espace n'est pas lisible. Une vérification humaine est nécessaire.",
  HOLD_UNSUPPORTED_GOVERNING_VERSION: "Cet espace utilise une version que je ne sais pas encore opérer. Une mise à jour est nécessaire.",
  HOLD_RUN_AMBIGUOUS: "Plusieurs travaux inachevés se disputent l'état courant. Il faut d'abord les réconcilier dans Notion.",
  HOLD_RECOVERY_REQUIRED: "Un travail précédent n'a pas été terminé. Je dois d'abord le reprendre avant toute nouvelle action.",
  HOLD_STATE_DIVERGENCE: "L'état enregistré n'est pas cohérent : un travail inachevé n'est pas référencé. Il faut le réconcilier dans Notion avant de continuer.",
  HOLD_REQUIRED_RESOURCE_MISSING: "Il manque une base indispensable dans votre espace. Elle doit être créée avant de continuer.",
  HOLD_UNKNOWN_REQUIRED_FACT: "Une information indispensable est introuvable. Je ne fais aucune supposition à sa place.",
  HOLD_REQUIRED_CAPABILITY_INCOMPLETE: "Votre espace n'a pas encore toutes les autorisations indispensables pour ce mode. Je suspends la suite jusqu'à leur vérification.",
  HOLD_BINDING_STALE: "La connexion à votre espace a expiré. Je me reconnecte avant de continuer.",
  HOLD_RUNTIME_BUSY: "Une autre modification est en cours sur cet espace. Je patiente qu'elle se termine.",
  HOLD_VERSION_CHANGED: "La version de référence a changé pendant notre travail. Je recommence à partir de l'état actuel.",
  HOLD_PERMISSION_UNKNOWN: "Je ne peux pas confirmer que cette action vous est permise. Une vérification humaine est nécessaire.",
  HOLD_ACTION_NOT_AUTHORIZED: "Cette action n'est pas autorisée pour votre profil.",
  HOLD_RESOURCE_UNKNOWN: "Je ne connais pas l'élément visé par cette demande.",
  HOLD_TARGET_NOT_FOUND: "L'élément à modifier est introuvable dans Notion.",
  HOLD_TARGET_AMBIGUOUS: "Plusieurs éléments correspondent à cette demande. Il faut d'abord lever l'ambiguïté dans Notion.",
  HOLD_GATE_UNSPECIFIED: "Cette étape n'est pas encore définie dans le contrat qui gouverne votre espace. Je ne peux pas la faire avancer tant qu'elle ne l'est pas.",
  HOLD_SCHEMA_MISMATCH: "La structure de votre espace ne permet pas encore cette modification. Une mise à niveau de l'espace est nécessaire.",
  HOLD_UNSUPPORTED_OPERATION: "Ce type de modification n'est pas pris en charge.",
  HOLD_FIXTURE_CONTRACT_VIOLATION: "Cette demande ne correspond pas exactement à ce que cet espace de test autorise. Je n'enregistre rien.",
  HOLD_GTM_CONTRACT_VIOLATION: "Cette fiche affirme plus que ses preuves ne permettent. Je ne l'enregistre pas en l'état.",
  HOLD_EXISTING_PLAN_ACTIVE: "Une modification est déjà en préparation. Je la termine avant d'en commencer une autre.",
  HOLD_PLAN_EXPIRED: "La préparation de cette modification a expiré. Je la reprends depuis le début.",
  HOLD_PLAN_BINDING_MISMATCH: "Cette modification appartient à une autre conversation. Je ne peux pas la vérifier d'ici.",
  HOLD_PLAN_RUNTIME_MISMATCH: "Cette modification concerne un autre espace. Je ne peux pas la vérifier d'ici.",
  HOLD_PLAN_REPLAY_INVALID: "Cette vérification a déjà été faite et ne peut pas être rejouée.",
  HOLD_TARGET_NOT_WRITTEN: "L'écriture n'apparaît pas encore dans Notion. Je la refais, puis je vérifie à nouveau.",
  HOLD_TARGET_WRONG_VALUE: "La valeur écrite dans Notion n'est pas celle prévue. Je corrige, puis je vérifie à nouveau.",
  HOLD_TARGET_WRONG_FIELD: "L'écriture a touché le mauvais champ dans Notion. Je corrige, puis je vérifie à nouveau.",
  HOLD_TARGET_WRONG_RECORD: "L'écriture a touché le mauvais élément dans Notion. Je corrige, puis je vérifie à nouveau.",
  HOLD_LEDGER_PREPARE_MISSING: "La trace de préparation est absente dans Notion. Je la refais, puis je vérifie à nouveau.",
  HOLD_RUN_NOT_OPENED: "Le journal de travail n'a pas été ouvert dans Notion. Je le refais, puis je vérifie à nouveau.",
  HOLD_VERSION_CHANGED_DURING_TRANSACTION: "La version de référence a changé pendant la modification. Je recommence depuis l'état actuel.",
  HOLD_FINAL_WITHOUT_TARGET_VERIFICATION: "La vérification intermédiaire n'a pas encore été faite. Je la fais d'abord.",
  HOLD_TARGET_RECEIPT_EXPIRED: "La vérification intermédiaire a expiré. Je la refais avant de terminer.",
  HOLD_TARGET_RECEIPT_INVALID: "La vérification intermédiaire n'est plus valable. Je la refais avant de terminer.",
  HOLD_TARGET_RECEIPT_REPLAY: "Cette vérification a déjà servi et ne peut pas être réutilisée.",
  HOLD_TARGET_CHANGED_AFTER_TARGET_VERIFY: "L'élément a été modifié après la vérification intermédiaire. Je recommence la vérification.",
  HOLD_LEDGER_NOT_VERIFIED: "La trace de validation n'est pas encore écrite dans Notion. Je termine l'enregistrement, puis je vérifie à nouveau.",
  HOLD_LEDGER_RECEIPT_MISMATCH: "La trace de validation ne correspond pas à cette modification. Je corrige, puis je vérifie à nouveau.",
  HOLD_RUN_INCOMPLETE: "Le journal de travail n'est pas encore clôturé dans Notion. Je le clôture, puis je vérifie à nouveau.",
  HOLD_RUN_COUNT_MISMATCH: "Le décompte du journal de travail ne correspond pas. Je corrige, puis je vérifie à nouveau.",
  HOLD_STATE_LAST_NOT_PROVEN: "La mise à jour finale de l'état n'est pas encore prouvée. Je la termine, puis je vérifie à nouveau.",
  HOLD_FINAL_RUNTIME_CONFLICT: "L'état de l'espace a changé en parallèle. Je repars de l'état actuel avant de terminer.",
  HOLD_FINAL_GATE_INVALID: "Le passage d'étape demandé n'est pas valide. Je n'enregistre pas ce passage.",
  HOLD_FINAL_VERSION_CONFLICT: "La version de référence a changé avant la fin. Je repars de l'état actuel.",
  HOLD_CONFLICT: "L'état trouvé dans Notion ne correspond ni à l'avant ni à l'après attendu. Une vérification humaine est nécessaire.",
  HOLD_DUPLICATE: "Un doublon existe dans Notion. Il faut le résoudre avant de continuer.",
  HOLD_NO_DURABLE_HANDOFF: "Je ne peux pas produire de relais fiable : l'état courant est incomplet ou ambigu.",
  HOLD_UNSUPPORTED_CONTROL_VERSION: "La version de contrôle en vigueur n'est pas prise en charge.",
  HOLD_CONTROL_PROOF_MISSING: "Aucun contrôle indépendant récent n'existe. L'état reste provisoire.",
  HOLD_CONTROL_STALE: "Le dernier contrôle indépendant est antérieur aux dernières écritures. L'état reste provisoire.",
  HOLD_CONTROL_SCOPE_INCOMPLETE: "Le contrôle ne couvre pas tout le périmètre requis. L'état reste provisoire.",
  HOLD_CONTROL_UNKNOWN: "Le contrôle n'a pas pu conclure. L'état reste provisoire.",
  HOLD_CONTROL_VIOLATION: "Le contrôle a relevé une anomalie. Elle doit être corrigée dans Notion avant d'avancer.",
  HOLD_CONTROL_GOVERNANCE_AMBIGUOUS: "La gouvernance du contrôle est ambiguë. Une décision humaine est nécessaire.",
  HOLD_CROSS_LANE: "Cette demande vise un autre espace que celui de cette conversation.",
  HOLD_CROSS_RUNTIME: "Cette demande vise l'espace de quelqu'un d'autre.",
  HOLD_EXTERNAL_INTENT_NOT_VERIFIED: "L'envoi n'est pas encore enregistré et vérifié. Rien ne part avant cela.",
  HOLD_EXTERNAL_SOURCE_UNAVAILABLE: "La messagerie n'est pas accessible. Aucun envoi ni relance tant qu'elle ne l'est pas.",
  HOLD_EXTERNAL_EFFECT_AMBIGUOUS: "Je ne peux pas savoir avec certitude si ce message est déjà parti. Une vérification humaine de la boîte mail est nécessaire ; rien ne sera renvoyé.",
  HOLD_EXTERNAL_EFFECT_OBSERVED: "Ce message est déjà parti. Je ne le renvoie pas ; j'enregistre ce qui s'est passé.",
  HOLD_MAILBOX_IDENTITY_MISMATCH: "La messagerie connectée n'est pas celle de cet espace. Aucun envoi.",
  HOLD_INBOUND_BEFORE_DISPATCH: "Le contact a répondu entre-temps. Aucun envoi automatique : la conversation passe en main humaine.",
  HOLD_EXECUTOR_REQUIRED: "Cet envoi automatique passe obligatoirement par l'exécuteur protégé. Je ne peux pas l'envoyer moi-même.",
  HOLD_TEST_SCOPE_NOT_APPROVED: "Cet envoi de test n'est pas dans le périmètre approuvé. Aucun envoi.",
};

export const ERROR_SAY: Readonly<Record<ErrorCode, string>> = {
  ERROR_AUTH_REQUIRED: "Je ne vous reconnais pas. La connexion doit être rétablie avant de continuer.",
  ERROR_INVALID_ARGUMENT: "Ma demande interne était mal formée. Je la reformule.",
  ERROR_PROJECT_UNKNOWN: "Ce projet ne vous est pas ouvert.",
  ERROR_PRINCIPAL_MISMATCH: "Cet élément appartient à une autre personne. Je ne peux pas y toucher.",
  ERROR_PLAN_NOT_FOUND: "Je ne retrouve pas la modification en cours. Je la reprends depuis le début.",
  ERROR_NOT_IMPLEMENTED: "Cette fonction n'est pas encore disponible.",
  ERROR_INTERNAL: "Une erreur interne m'empêche de continuer. Rien n'a été enregistré. Réessayez dans un instant ; si cela persiste, prévenez la personne qui administre votre espace.",
};

export const OK_SAY: Readonly<Record<OkCode, string>> = {
  BOUND: "Connexion établie.",
  RESUMED: "Reprise faite depuis Notion.",
  PLAN_PREPARED: "Je prépare l'enregistrement dans Notion.",
  TARGET_VERIFIED: "Écriture vérifiée. Je termine l'enregistrement.",
  TRANSACTION_VERIFIED: "C'est enregistré et vérifié dans Notion.",
  HANDOFF_READY: "Voici le relais à transmettre.",
  CONTROL_STATUS: "Contrôle effectué.",
};

export const SAY: Readonly<Record<Code, string>> = { ...HOLD_SAY, ...ERROR_SAY, ...OK_SAY };

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() && v !== "UNKNOWN" && v !== "NOT_FOUND" && v !== "NOT_APPLICABLE" ? v.trim() : undefined);

// ──────────── PT-VOICE-001 (W3.4): what the served selected_context obliges the voice to say ────────────
// Read-only views over `contract_pack.selected_context`, exactly as served. They classify nothing the source did not
// already declare: no coverage, no breach and no rule is computed here; a HOLD is transported, never derived.

type Row = Readonly<Record<string, unknown>>;
const obj = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});
const list = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);

/** One served section of one context, or undefined when that context or section was not served this turn. */
export function servedSection(result: unknown, context: string, sectionKey: string): { readonly status: string; readonly items: readonly Row[] } | undefined {
  const block = list(obj(obj(obj(result)["contract_pack"])["selected_context"])["contexts"]).map(obj).find((c) => c["context"] === context);
  const section = list(block?.["sections"]).map(obj).find((s) => s["section_key"] === sectionKey);
  return section ? { status: String(section["source_status"]), items: list(section["items"]).map(obj) } : undefined;
}

/** The production health values an OS may declare (W3.4R), with their French labels. Nothing else is voiced. */
export const PRODUCTION_HEALTH_LABEL = { ON_TARGET: "dans l'objectif", AT_RISK: "à risque", PRODUCTION_BREACH: "en rupture" } as const;
export type DeclaredProductionHealth = keyof typeof PRODUCTION_HEALTH_LABEL;

/** The production health the OS itself declared and the harness transported, or undefined (ABSENT, omitted, other). */
export function declaredProductionHealth(result: unknown): DeclaredProductionHealth | undefined {
  const s = servedSection(result, "DAILY", "DAILY_PRODUCTION_HEALTH");
  if (s?.status !== "PRESENT" || s.items.length !== 1) return undefined;
  const v = s.items[0]!["production_health"];
  return typeof v === "string" && (Object.keys(PRODUCTION_HEALTH_LABEL) as readonly string[]).includes(v) ? (v as DeclaredProductionHealth) : undefined;
}

/** Reread statuses of a declared constraint that prove it (or declare no pointer to prove). Anything else is unverifiable. */
const CONSTRAINT_PROVEN: readonly unknown[] = ["MATCH", "NO_POINTER"];

/**
 * The P0 HOLD the served DAILY context carries (PT-VOICE-001/c): a P0 rule whose declared disposition is HOLD, or a
 * declared constraint whose reread does not prove it. Transported, never interpreted: no rule is evaluated here.
 */
export function carriedP0Hold(result: unknown): "P0_RULE" | "CONSTRAINT_UNVERIFIABLE" | undefined {
  if (servedSection(result, "DAILY", "DAILY_P0_RULES")?.items.some((i) => i["default_disposition"] === "HOLD")) return "P0_RULE";
  if (servedSection(result, "DAILY", "DAILY_RUNTIME_CONSTRAINTS")?.items.some((i) => i["reread_status"] !== undefined && !CONSTRAINT_PROVEN.includes(i["reread_status"]))) return "CONSTRAINT_UNVERIFIABLE";
  return undefined;
}

/** The governed `Effect Status` values of an outbound intent, in voicing order; any other value is voiced as unknown. */
const EFFECT_STATES = ["PREPARED", "APPROVED", "NOT_OBSERVED", "AMBIGUOUS", "OBSERVED"] as const;
export type OutboundState = (typeof EFFECT_STATES)[number] | "UNQUALIFIED";

/** The distinct material states of the outbound intents served this turn, in a fixed order. */
export function servedOutboundStates(result: unknown): readonly OutboundState[] {
  const s = servedSection(result, "EXTERNAL_ACTION", "EXTERNAL_INTENTS");
  if (s?.status !== "PRESENT") return [];
  const seen = new Set(s.items.map((i) => ((EFFECT_STATES as readonly unknown[]).includes(i["effect_status"]) ? (i["effect_status"] as OutboundState) : "UNQUALIFIED")));
  return [...EFFECT_STATES, "UNQUALIFIED" as const].filter((x) => seen.has(x));
}

const REPAIR_OFFER = "Je peux en revanche vous aider à réconcilier l'existant, à reprendre un travail interrompu ou à protéger les prochains jours.";
/** Said when the served context carries a P0 HOLD: the hold in human words, then only reconcile / repair / protect. */
export const P0_HOLD_SAY: Readonly<Record<"P0_RULE" | "CONSTRAINT_UNVERIFIABLE", string>> = {
  P0_RULE: `Une règle prioritaire de votre espace suspend toute nouvelle production pour l'instant. ${REPAIR_OFFER}`,
  CONSTRAINT_UNVERIFIABLE: `Je ne peux pas démontrer que les garde-fous de votre espace permettent une nouvelle production pour l'instant. ${REPAIR_OFFER}`,
};
/** Said when the OS declared its production health: the OS's own verdict, carried as declared. */
export const productionHealthSay = (h: DeclaredProductionHealth): string => `Santé de production déclarée aujourd'hui par votre espace : ${PRODUCTION_HEALTH_LABEL[h]}.`;
/** One orientation per material outbound state: the next useful step or the one human question. Approval never sends. */
export const OUTBOUND_SAY: Readonly<Record<OutboundState, string>> = {
  PREPARED: "Un message est préparé : il attend votre décision avant tout envoi, et rien ne part depuis cette conversation.",
  APPROVED: "Un message est approuvé, mais une approbation n'est pas un envoi : il ne peut partir que par l'exécuteur protégé de votre espace, jamais depuis cette conversation.",
  NOT_OBSERVED: "Un message préparé n'apparaît pas dans la messagerie : rien n'indique qu'il soit parti, et il ne sera pas renvoyé d'ici sans une nouvelle décision de votre part.",
  AMBIGUOUS: "Je ne peux pas savoir avec certitude si un message est déjà parti : une vérification humaine de la boîte mail est nécessaire ; rien ne sera renvoyé.",
  OBSERVED: "Un message est déjà parti : il ne sera pas renvoyé.",
  UNQUALIFIED: "Un message est dans un état que je ne sais pas qualifier : une vérification humaine est nécessaire ; rien ne part depuis cette conversation.",
};

/** The sentences a business RESUMED turn owes to its served context, in order: health, P0 HOLD, outbound states. */
function contextVoice(result: unknown): string {
  const health = declaredProductionHealth(result);
  const p0 = carriedP0Hold(result);
  return [health ? productionHealthSay(health) : undefined, p0 ? P0_HOLD_SAY[p0] : undefined, ...servedOutboundStates(result).map((s) => OUTBOUND_SAY[s])]
    .filter((x): x is string => x !== undefined).map((x) => ` ${x}`).join("");
}

/** Attaches `say` (normally) and `ask` (only when a human answer is required) to an envelope. Pure.
 *
 * An eligible cross-binding recovery HOLD is the one exception: it is a backend-directed internal continuation,
 * not a user-facing turn.  Emitting the generic HOLD sentence here conflicts with the more specific continuation
 * contract and causes a normal chat to stop before calling os_verify.  Keep the envelope silent so the model can
 * execute the single permitted read-only continuation carried by `next`.
 */
export function withUserSentence<E extends Envelope>(tool: ToolName, e: E): E {
  if (e.code === "HOLD_RECOVERY_REQUIRED" && e.next.permitted_tool_call === "os_verify") {
    const { say: _say, ask: _ask, ...silent } = e;
    return silent as E;
  }
  const r = (e.status === "OK" ? (e.result as Record<string, unknown>) : {}) ?? {};
  let say = SAY[e.code];
  let ask: string | undefined;
  switch (e.code) {
    case "BOUND": {
      const lane = e.binding !== "UNKNOWN" ? LANE_LABEL[e.binding.lane] : undefined;
      say = lane ? `Connexion établie à ${lane}.` : say;
      if (e.binding !== "UNKNOWN" && e.binding.runtime_scope === "FIXTURE") say += " " + FIXTURE_SENTENCE;
      break;
    }
    case "RESUMED": {
      const gate = r["gate"] as { gate_key?: unknown; status?: unknown; formal_next_question?: unknown; formal_next_action?: unknown } | undefined;
      const step = text(gate?.gate_key);
      const question = text(gate?.formal_next_question);
      const action = text(gate?.formal_next_action) ?? text(r["next_action"]);
      // A row the seller changed outside the system is asked about first: it is their decision to confirm, and
      // confirming it is one word. The step's own question follows on the next turn.
      const confirm = r["pending_confirmation"] as { question?: unknown } | undefined;
      const confirmQuestion = text(confirm?.question);
      // PT-VOICE-001: declared production health, a carried P0 HOLD and each outbound state are said by the harness.
      const voice = contextVoice(r);
      if (confirmQuestion) {
        say = `Reprise faite depuis Notion.${step ? ` Étape en cours : ${step}.` : ""}${voice}`;
        ask = confirmQuestion;
        break;
      }
      // Under a carried P0 HOLD no next production action is voiced: the turn only explains and offers repair.
      const nextAction = question || carriedP0Hold(r) ? "" : action ? ` Prochaine action : ${action}` : "";
      say = `Reprise faite depuis Notion.${step ? ` Étape en cours : ${step}.` : ""}${voice}${nextAction}`;
      if (question) ask = question;
      break;
    }
    case "PLAN_PREPARED": {
      const n = Array.isArray(r["stage1_actions"]) ? (r["stage1_actions"] as unknown[]).length : undefined;
      say = n ? `Je prépare l'enregistrement dans Notion (${n} écriture${n > 1 ? "s" : ""}).` : say;
      break;
    }
    case "CONTROL_STATUS": {
      const res = text(r["result"]);
      say = res === "CONFIRMED" ? "Contrôle effectué : l'état est confirmé par le vérificateur indépendant." : res === "OPERATIONAL_PASS" ? "Contrôle effectué : l'état est cohérent (contrôle opérationnel, non attesté)." : say;
      break;
    }
    case "HOLD_LANE_REQUIRED": {
      const choices = (e.observations["choices"] as string[] | undefined) ?? [];
      ask = choices.length > 0 && choices.every((c) => LANE_LABEL[c]) ? `Souhaitez-vous travailler sur ${choices.map((c) => LANE_LABEL[c]).join(" ou ")} ?` : `Sur quel projet souhaitez-vous travailler ? (${choices.join(", ")})`;
      break;
    }
    case "HOLD_RECOVERY_REQUIRED": {
      // Two very different situations reach this one code. Unfinished work is something the conversation can
      // resume. A space its own Manifest declares not operational is neither the seller's fault nor, usually,
      // theirs to fix — so say what still works and who unblocks it, instead of promising a resumption.
      const notOperational = e.evidence.some((x) => /Manifest declares (Health Status|persistence health)/.test(x));
      if (notOperational) say = "Votre espace n'est pas encore prêt à enregistrer vos décisions : son installation doit être terminée. En attendant, je peux réfléchir avec vous, mais rien ne sera inscrit. Prévenez la personne qui a installé votre espace, et on reprend ici.";
      break;
    }
    case "HOLD_RUNTIME_BUSY": {
      // The lease holder is often the caller's own plan, prepared a moment ago in this very conversation and
      // still waiting for its writes. « Une autre modification est en cours » then tells the seller to wait for
      // their own work to expire (observed 2026-09-23 17:48). Say what is true: the recording resumes.
      const plan = e.observations["open_backend_plan"] as { owned_by_caller?: unknown; same_binding?: unknown; expired?: unknown; plan_state?: unknown } | undefined;
      if (plan?.owned_by_caller === true && plan.same_binding === true && plan.expired !== true && plan.plan_state === "AWAITING_STAGE1_WRITES") say = "Je reprends l'enregistrement déjà préparé.";
      break;
    }
    case "HOLD_REQUIRED_CAPABILITY_INCOMPLETE": {
      // This action is contract-derived and separately validated as seller-facing. Keep it inside `say`: a cold
      // black-box chat must remain actionable even when the model correctly repeats only the canonical sentence.
      const action = text(e.next.safe_action);
      if (action) say = `${say} ${action}`;
      break;
    }
    default:
      break;
  }
  void tool;
  // A question means the next user message must carry the apps. `say` renders the whole turn: state, then the
  // canonical question, then the reminder LAST. `ask` stays the pure question and is never re-displayed.
  if (ask) say = `${say} ${ask} ${APP_REMINDER}`;
  return { ...e, say, ...(ask ? { ask } : {}) };
}
