# Contrats MCP et plans de droits

Ce tableau décrit les surfaces du code copié. Le catalogue servi dépend
du profil authentifié et de la configuration privée, exclue de ce dépôt.

| Outil / actions | Entrées essentielles | Retour / lecture / effet |
|---|---|---|
| `vertigo_sales_control` - CONTEXT | `action` | État limité Manifest/State/dernier Run, limites, protocole technique et orientation éventuelle ; lecture Notion, aucun envoi |
| Même outil - VERIFY_RECEIPT | Sélecteurs d’événement admis par le schéma | Champs Notion pris en charge relus ; ne certifie pas Gmail ni toute la transaction |
| Même outil - REPORT_STEP | `step.connector`, `operation`, `outcome`, `reason`, puis `step_ref` pour le terminal ; compteurs optionnels | Diagnostic AGENT_REPORTED ; référence temporaire et déduplication ; pas d’écriture métier |
| `vertigo_meta_control` - STATUS / CONTEXT | `action` | Identité et sources META configurées ; observation passive bornée des profils Sales autorisés |
| `vertigo_direction_control` - PREPARE | Destinataire configuré, clé de requête, titre/objectif/horizon/recommandations/contraintes | Proposition immuable versionnée et empreinte d’approbation ; journal technique |
| Même outil - APPROVE / VERIFY | Proposition, empreinte, confirmation ; puis référence de proposition | Plan d’écritures exécutées par Notion natif, relectures et état PUBLISHED si conformes |
| Même outil - CONTEXT / CONSUME / VERIFY_CONSUMPTION | Profil issu de l’authentification ; action | Orientation du seul destinataire, plan de reçu natif, relecture et CONSUMED si conforme |

Les schémas exacts sont dans [Sales](../packages/harness/src/verify/nativeSalesControl.ts)
et [orientations](../packages/harness/src/verify/realDirectionControl.ts).
Les tools de notes de laboratoire sont isolés du travail métier ; ils ne prouvent
pas le raccordement d’un OS réel.

## Diagnostic : exemple synthétique complet

```json
{"action":"REPORT_STEP","step":{"connector":"OTHER","operation":"READ","outcome":"STARTED","reason":"NONE"}}
```

Le terminal reprend la référence retournée par ce STARTED et le même connecteur/opération :

```json
{"action":"REPORT_STEP","step_ref":"00000000000000000000000000000001","step":{"connector":"OTHER","operation":"READ","outcome":"FAILED","reason":"PROVIDER_ERROR"}}
```

Cet exemple illustre un échec de lecture locale compatible CSV. Le tuple ne prouve
pas quel fichier ni quelle exception privée a échoué. Les références expirent
après trente minutes ou au redémarrage ; les recréer ne justifie pas de rejouer
une action métier réussie. Un HTTP 200 ne prouve pas un succès métier.

## Noyau candidat, distinct

`os_bind`, `os_resume`, `os_commit`, `os_handoff`, `os_control_status` : liaison de
la session au bon OS, reprise, transaction serveur, transmission et statut de contrôle.
La transaction relit les données, tient le journal puis met l’état de reprise à
jour en dernier : c’est l’ordre appelé `State-last` dans le code.
L’ancien protocole `os_prepare` / `os_verify` reste dans les documents historiques.
Ne pas additionner ces catalogues pour décrire le plugin d’un utilisateur.

## Droits : trois plans indépendants

1. Hôte ChatGPT/Codex : outils disponibles et confirmations propres à l’hôte.
2. Fournisseurs : compte et ACL Notion/Gmail/Calendar.
3. Harness : identité, profil et cibles admises sur ses propres appels.

Une page Notion, une orientation ou un nom dans un prompt n’accorde aucun droit.
Le backend ne peut pas bloquer tous les gestes réalisés directement via les autres
connecteurs. Le cloisonnement doit être évalué sur les trois plans.
