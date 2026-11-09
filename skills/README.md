# Compétences : contenu, provenance et chargement

| Contenu | Origine de cette copie | Statut |
|---|---|---|
| [Bootstrap Sales](../packages/native-sales-bootstrap/SKILL.bootstrap.md) | Dépôt de développement, fichier non committé au moment de la capture | Prescription de CONTEXT frais, lectures natives et reporting |
| [Orchestrateur natif](pilot-snapshot/vertigo-native-orchestrator/SKILL.md) | Cache local du pilote 0.1.19 | Copie de source, pas preuve des copies collaborateur |
| [Coach / Daily GO](pilot-snapshot/vertigo-adaptive-coach/SKILL.md) | Même cache local | Analyse et travail préparé, pas scheduler |
| [Skill historique](../packages/plugin/SKILL.md) | Dépôt de développement | Ancien parcours, statut à lire dans son contexte |
| [Skill candidate](../packages/plugin/SKILL.candidate.md) | Dépôt de développement | Noyau cinq outils, distinct du natif |

Le [manifeste du pilote](pilot-snapshot/plugin.json) est anonymisé ; ce n’est pas
une archive importable ni un accès MCP. Aucun export privé de connexion n’est inclus.

## Mécanisme de chargement

La compétence installée prescrit le parcours ; le serveur peut renvoyer les
instructions compatibles dans la réponse CONTEXT ; Notion contient la méthode
métier évolutive. Les trois sources ne se remplacent pas. L’agent doit lire les
corps pertinents de Notion, pas seulement une version dans Manifest.

Le coach doit être lu avec son orchestrateur, dont il hérite les droits et limites.
Une nouvelle méthode métier n’ajoute pas à elle seule un outil ou une autorité.
La présence du fichier dans ce dépôt ne certifie pas son activation dans un compte privé.

L’ancienne compétence proposition est dans [l’archive](../archive/retired-proposition/SKILL.md).
Elle n’est pas une commande active revendiquée par ce dossier.
