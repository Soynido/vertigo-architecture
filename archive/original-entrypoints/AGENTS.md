# Orchestration : coût et débit

## ATAWAI V2 (instruction propriétaire)

For ATAWAI V2 work, resume from the last verified receipt and current ticket/PR state. Do not re-read the full conversation, audit corpus, or worker cache on each turn. Read only the changed files and the evidence needed for the active blocker; use ATAWAI's bounded readback when it is current, and name staleness when it is not.

Keep WIP to one blocker. Run targeted tests during implementation, then one independent adversarial review and the heavy suite only at promotion. A non-blocking finding goes to the existing backlog without another review loop. Once the exact gate is green, merge and retire the branch/worktree before moving on. Never use a paid Anthropic API fallback; Claude work must use the Max subscription and stop at its limit.

## Application à VERTIGO dans ce dépôt

- Reprendre depuis `HEAD`, Notion `CURRENT` et le dernier reçu de gate. Un même état vérifié n'est pas relu à chaque tour : lire le delta utile à la task ou au blocage actif. Lire le canon Notion pertinent une fois à l'entrée d'une nouvelle task ou après un changement de version/contrat ; readback ciblé seulement après une écriture. Nommer explicitement toute preuve devenue obsolète.
- Un seul WIP/blocage. Instruction propriétaire du 03/10/2026 : Codex est le seul agent d'implémentation ; il écrit et corrige le code, utilise Plugin Creator pour les paquets/skills/connexions et tient Notion, scope, diff, tests et gates. Le backend reste dans son dépôt et son infrastructure propre ; Plugin Creator ne vaut pas déploiement du serveur. Claude Code Max Opus 5.5 High intervient uniquement pour la revue adversariale indépendante, en lecture seule : aucune délégation de coding à Claude. Les tests du host doivent être étiquetés avec leur environnement réel, jamais présentés comme une preuve ChatGPT ordinaire lorsqu'ils tournent en Codex/Work.
- Pour chaque invocation Claude autorisée : checkpoint bref et fichiers du delta seulement, jamais reprise d'un historique/cache volumineux. Limiter les permissions à la revue en lecture seule, sans édition, exécution de tests ni effet externe. Au premier refus de permission, arrêter : pas de variantes répétées du même appel. Les mentions historiques de Claude comme codeur ne constituent plus une instruction applicable.
- Tests ciblés pendant l'implémentation ; une revue adversariale indépendante et suites complètes uniquement à la gate de promotion, ou si le contrat les exige plus tôt. Ne pas répéter une vérification inchangée. Les observations non bloquantes vont au backlog sans boucle de revue.
- Garder LOT → TASK → GATE, une task = un commit local, `CURRENT` en dernier. Après PASS, intégrer et retirer toute branche/worktree de travail devenue inutile avant la task suivante. Aucun push, déploiement, VPS, runtime LIVE ou effet externe sans autorisation explicite. STOP sur ambiguïté sémantique, d'autorité, de version ou contradiction contrat/test. À la limite Claude Max, arrêter sans API payante de secours.

Cette règle de débit ne supprime jamais un contrôle bloquant explicitement exigé par la gate ou le canon.

## Délégation technique permanente — propriétaire, 05/10/2026

- Pour un bug dont l'attendu est déjà fixé dans le canon, Codex peut réparer en autonomie et étendre minimalement le scope de fichiers, en consignant le pourquoi et les invariants dans le plan/ticket avant le code. Pas de demande humaine répétée pour une simple frontière de fichier.
- Une revue indépendante Claude Max Opus 5.5 High bornée ; échanges supplémentaires uniquement sur objections bloquantes nouvelles. Pas de recherche de consensus artificiel ni relecture générale. Les décisions techniques arrêtées sont figées dans le plan avant reprise.
- La délégation ne couvre pas un nouveau comportement utilisateur, une nouvelle autorité, une version adoptée, un effet externe/LIVE/VPS/push/déploiement, ni une contradiction sémantique non résolue : accord propriétaire distinct requis. Toutes gates/protections et STOP Max sans API restent applicables.

## Résolution autonome des HOLD — propriétaire, 05/10/2026

- Un HOLD technique bloque la promotion, pas la résolution : diagnostic adversarial Claude Max borné si nécessaire, décision fondée sur le canon, clarification/scope minimal consignés avant code, correction par Codex, ciblés puis gate. Pas de validation humaine répétée pour une décision d'ingénierie déjà couverte par l'objectif et l'autorité déléguée.
- Une revue de promotion ; clôture seulement sur delta bloquant neuf. Non-bloquants au backlog. PASS exact → commit/fusion locale/nettoyage et task suivante, sans demander un nouveau GO technique.
- Ne pas confondre consensus et autorisation d'effet externe. Interpréter une réponse propriétaire dans le périmètre concret de la décision qu'elle traite et consigner cette interprétation ; ne pas élargir LIVE/VPS/push/déploiement ou produit par implication.
- Si une autorisation réellement nouvelle manque, une question précise seulement ; pas de boucles de relecture/revue/tests inchangés ou reprises automatiques prises pour un GO. Appliquer le seuil de blocage de l'objectif.
- Skill d'orchestration maintenu dans `docs/skills/vertigo-scope-control/SKILL.md`, installé localement sous `~/.codex/skills/vertigo-scope-control/SKILL.md`. Ce skill d'agent ne modifie pas la skill du plugin ni son comportement public.

## GO sans validation manuelle répétée — propriétaire, 09/10/2026

- Dans une lane explicitement autorisée, consensus adversarial Claude Max borné → correction technique/tests → commit/fusion → service de la révision corrigée et retest, sans demander un GO par hash. L'autorité couvre les correctifs successifs du même périmètre, pas uniquement le premier commit ; fixer ses bornes dans le plan avant les effets.
- GO courant : servir0e009d5 puis corriger/retester en autonomie les défauts de cette même gate sur backend existant/compte privé propriétaire/canary isolé ; backups/rollback obligatoires. Aucun changement de routage/auth/identité/droits/pins de contrat/adoption, OS historiques/META/collaborateurs, mail/Gmail/Calendar, nouveau service/coût/push/distribution. Aucun nouveau comportement hors contrat. Pas de nouvelle installation si skill/plugin inchangés.
- Cette clarification remplace uniquement la validation propriétaire répétée par révision dans ce périmètre. Les exclusions et LOT → TASK → GATE restent. Demander seulement une extension réelle d'autorité ou une action humaine indisponible ; à Max limité/refus de permission, STOP sans API.
