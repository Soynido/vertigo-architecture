# VERTIGO - de la prospection dispersée à l’assistant d’équipe

**Revue technique privée · 9 novembre 2026.**
Tout se lit ici, sans installer de plugin, connecter Notion ou fournir une clé.

**[Voir l’équipe au travail](docs/UTILISER-VERTIGO.md)** : des cas réels illustrés,
les demandes dans le chat, les résultats et leur utilité, avec les liens vers les preuves.

## Le système en un coup d’œil

**L’équipe ne code pas.** Après la mise en place du plugin et de ses connexions,
chaque collaborateur travaille dans son ChatGPT : il demande de reprendre un
dossier, préparer un message ou organiser sa journée. Le manager utilise le même
principe pour piloter le META OS.

**Le parcours quotidien utilise leurs abonnements existants.** Le modèle travaille
dans ChatGPT ; le harness n’appelle pas d’API de modèle payante en supplément.
Les quotas et les accès des comptes restent applicables. Les abonnements aux
outils, l’hébergement du serveur et sa maintenance restent des coûts à distinguer.

```mermaid
flowchart TB
 M[Manager : donne le cap et valide] --> C[ChatGPT individuel : abonnement existant]
 U[Collaborateur : travaille en conversation] --> C
 P[PLUGIN : compétences et méthode de travail] --> C
 C <--> T[CONNEXIONS DU COMPTE : Notion, Gmail, Calendar, Web, fichiers]
 C <--> H[HARNESS : identité, cibles autorisées, contrôles et reçus]
 T <--> N[NOTION : sources accessibles selon les droits du compte]
 N --> META[META OS : cap, décisions et orientations du manager]
 N --> SALES[SALES OS : contexte, règles et dossiers de chacun]
 H -. relectures ciblées .-> N
 SALES -. mémoire relue lors de la reprise .-> C
 classDef chat fill:#e1e9d2,stroke:#245b47,color:#172a24
 classDef control fill:#e1e8fc,stroke:#3158d9,color:#172a24
 classDef memory fill:#f0e9cf,stroke:#647169,color:#172a24
 class C,P chat
 class H control
 class N,META,SALES memory
```

| Élément | Son rôle dans le travail quotidien |
|---|---|
| **META OS** | Le manager consulte le contexte de l’entreprise et prépare les orientations destinées à l’équipe. |
| **SALES OS** | Chaque commercial retrouve ses dossiers, son contexte et ses règles. |
| **PLUGIN** | Il apporte à l’agent les compétences et les étapes à suivre. |
| **HARNESS** | Le serveur applique ses contrôles codés aux appels qu’il reçoit. |
| **CONNEXIONS** | L’agent utilise les outils du compte, avec leurs droits et validations. |
| **PERSISTANCE** | L’agent fait enregistrer le travail autorisé dans Notion, puis le relit. Cette mémoire permet de reprendre dans une autre conversation. |

La conversation sert à demander et décider. Notion conserve les enregistrements.
Le harness vérifie les champs et protocoles qu’il prend en charge ; il ne voit pas
tous les gestes réalisés dans les outils natifs.

## Le problème rencontré

Je développais les sites web des client de l'agence web Vertigo. Je disposais de mon propre espace de travail sur Notion et structurait le knowledge par projet (client, audit site web, remontées des informations, structuration de la doc technique, priorisation, validation, état d'avancement, livraison, maintenance, etc). 

En travaillant avec les founders, j’ai constaté un autre problème : ils pouvaient se marcher dessus dans la
prospection. Qui suivait le prospect ? Quelle avait été la dernière action ?
Quelles consignes étaient encore valables ? Le contexte restait dispersé dans
leurs outils et leurs conversations sur ChatGPT.

La construction a suivi ce besoin : **conserver le contexte dans Notion → contrôler
les enregistrements → guider leurs propres agents via ChatGPT avec des compétences → organiser les rôles
META (admin) /SALES (ops) → rendre ce parcours accessible dans le chat habituel.**
Ces couches expliquent les choix ; ce n’est pas une chronologie datée de chaque commit.

**OS** : organisation de données, règles et mémoire dans Notion.
**Plugin** : compétences et connexion aux contrôles, pas un modèle entraîné.
**Agent** : interprétation, priorisation et utilisation des outils natifs.
**Harness** : serveur MCP avec identité, périmètres, protocoles et relectures vérifiées.
MCP est le protocole qui permet à l’agent d’appeler les outils du serveur.

## Lecture en cinq minutes

1. [Cas réels : demandes, résultats et utilité](docs/UTILISER-VERTIGO.md).
2. [Architecture et séparation des responsabilités](docs/ARCHITECTURE.md).
3. [Trois parcours concrets, de la demande aux preuves](docs/PARCOURS.md).
4. [Ce qui est prouvé, déclaré ou encore inconnu](docs/STATE-OF-EVIDENCE.md).

Pour aller jusqu’aux sources : [carte du code](docs/CODE-MAP.md),
[contrats MCP](docs/MCP-CONTRACTS.md), [schémas Notion](notion/README.md),
[choix techniques et limites](docs/DECISIONS-AND-LIMITS.md),
[compétences](skills/README.md), [preuves anonymisées](evidence/README.md),
[vérifications du dossier](verification/README.md).

La [revue Codex indépendante](verification/independent-review.md) approuve ce
dossier de lecture. Le [rapport de tests](verification/RESULTS.md) expose aussi
les trois attentes de l’ancien dépôt qui restent en échec dans cette copie.

## Le Daily GO, résultat concret de cette construction

À « On reprend ? », la méthode demande de relire le cap applicable, les règles et
le travail accessible, puis de proposer une priorité expliquée **avec un travail
préparé**. Exemple fictif : fiche client et trame prêtes, créneau laissé au choix
humain. Le modèle fait cette analyse ; le harness ne calcule pas un score universel.
Le propriétaire rapporte avoir vu ce parcours fonctionner. Cela ne remplace pas
une trace indépendante de chaque reprise dans chaque compte.

## Comment lire le statut du produit

| Ensemble | Statut dans ce dossier |
|---|---|
| Circuit hybride META/SALES natif | Sources présentes et reçus opérateur historiques, portée détaillée par preuve |
| Noyau transactionnel à cinq outils | Candidat distinct ; présence dans le code ≠ adoption par l’équipe |
| Ancien parcours à six outils | Historique, conservé pour comprendre la construction |
| Content OS, DEV OS, fabrique générique d’OS | Perspectives, pas capacités certifiées ici |
| Génération de propositions | Dépôt externe distinct ; l’ancienne commande est archivée |

**Cette copie n’est pas une nouvelle version de production.** Elle comprend les
modifications locales pertinentes, y compris des fichiers non committés dans le
dépôt source. La révision actuellement servie et les versions privées installées
n’ont pas été revalidées pour cette revue. Voir le
[manifeste de provenance](provenance/source-manifest.json).

## Ce qu'on peut évaluer :

- La séparation entre consigne au modèle, contrôle déterministe et validation humaine.
- Le chemin d’une orientation jusqu’à son reçu, sans écraser les règles locales.
- La portée des schémas, la reprise, l’idempotence et les modes d’échec.
- Les tests et leurs résultats, sans assimiler test opérateur et usage client.
- Les limites de visibilité : ni interception des outils privés, ni surveillance permanente.

Mon rôle : cadrage du besoin, conception du workflow et de ses contrats,
orchestration de l’implémentation assistée par IA, tests et accompagnement de l’équipe.
Temps gagné, satisfaction et ROI chiffré restent non établis par ce dossier.

Code et dépendances sont fournis pour audit. Les secrets, configurations réelles,
données clients et conversations privées sont exclus. [Conditions et dépendances](THIRD_PARTY_NOTICES.md).
