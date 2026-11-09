# Orientation réelle — proposition, validation, publication vérifiée

Parcours propriétaire, déclenché par une demande d'orienter un collaborateur ou de
reprendre cette orientation. Une consigne commune respecte les règles locales plus
strictes ; une recommandation adaptable ne devient ni quota ni autorité nouvelle.

## 1. Choisir le contrat effectivement exposé

Découvrir `vertigo_direction_control`. Le contrat réel comporte `recipient`,
`direction`, `proposal_id`, `approval_hash` et l'action `APPROVE` ; sa description
indique une orientation réelle par destinataire.

Lecture d'une orientation existante seulement, y compris en chat neuf : appeler une
fois STATUS avec recipient connu si la personne est nommée (CollaboratorGamma, CollaboratorBeta ou CollaboratorAlpha) ;
sans recipient si la demande porte sur toute l'équipe ou si la clé est inconnue.
Ne fournir ni principal, compte, racine ou datasource. La sélection est fermée côté
serveur. Ne pas ajouter un CONTEXT META métier, un CONTEXT vendeur (interdit au
propriétaire), une recherche Notion ou une seconde lecture du même détail.
La ligne fraîche contient déjà direction (titre, objectif, horizon, recommandations,
contraintes) après preuve native et native_chain_verified=true, ainsi que l'état de
publication et le reçu distinct. Utiliser ce contenu pour répondre et préparer ici
une prochaine action proposée compatible, sans l'annoncer exécutée. effective_state
SCHEDULED/EXPIRED n'est pas une consigne active aujourd'hui. UNCONFIRMED, corps absent
ou accès refusé : nommer cette seule limite, sans contenu inventé, publication rejouée
ou réception fabriquée. Une consultation ne lance aucun VERIFY ni CONSUME.

Préparer une nouvelle orientation ou reprendre une publication explicitement demandée :
conserver le CONTEXT META de lancement et appeler STATUS (recipient connu facultatif),
puis suivre les étapes ci-dessous. Le raccourci de lecture n'autorise aucun effet.

Si le catalogue ne propose que `intent:PUBLISH/CONSUME/RETURN` et `target` numérique,
il s'agit du laboratoire fictif : pour la demande réelle, préparer seulement le
texte dans le chat et nommer cette seule indisponibilité. Ne pas essayer des
variantes d'arguments, réinstaller ou utiliser les pages fictives. Une demande
explicitement fictive reste dans son ancien protocole si ce catalogue est présent.

## 2. Retrouver ou préparer la proposition exacte

Sélectionner uniquement le destinataire effectivement retourné par STATUS et demandé
par l'humain ; le modèle ne fournit jamais principal, compte, racine ou datasource.
Chaque destinataire a son propre corps et sa propre validation, pas l'objectif d'un
collègue. Le périmètre du premier essai réel reste préservation/personnalisation,
sans nouveaux objectifs commerciaux ni publication du package Q4.

Sur reprise : lire `pending`, sa couverture et l'état de chaque proposition. Une seule
APPROVED_PENDING_NOTION, `can_resume:true`, de couverture COMPLETE et correspondant
à la demande de reprise : utiliser son `proposal_id` dans VERIFY, sans PREPARE ni
nouvelle validation. Un DRAFT n'est pas approuvé : montrer son contenu exact avant
le choix humain. Plusieurs propositions, couverture PARTIAL, ambiguïté, version
périmée ou affectation changée : ne pas choisir arbitrairement ni créer un doublon.
Conserver le travail indépendant ; demander seulement le choix réellement manquant.

Pour une nouvelle intention : appeler PREPARE avec `recipient`, une `request_key`
stable pour cette intention et `direction` comprenant titre, objectif, horizon
daté, recommandations et contraintes. Partir de la demande/source observée, pas de
chiffres inventés. Réutiliser la même clé pour un retry identique ; un changement
de corps/destinataire est une nouvelle proposition, jamais un écrasement.

Présenter le DRAFT retourné : destinataire, objectif, dates, recommandations,
contraintes conservées. Formuler une question simple : « Valides-tu cette orientation
pour [destinataire] ? » Pas de publication ou réception annoncée à ce stade.

## 3. Après le choix humain, finir dans le même tour

APPROVE porte uniquement `proposal_id` et `approval_hash` du DRAFT montré, plus
`confirmation` attestant l'accord explicite effectivement donné pour celui-ci.
Ne pas inventer cet accord depuis l'urgence, un ancien GO de développement, une
priorité acceptée ou l'enthousiasme. Modifier une proposition invalide cet accord.
APPROVED_PENDING_NOTION signifie validation conservée, pas publication terminée.

Suivre seulement les `writes` du contrôle frais. Pour chaque CREATE_IF_ABSENT :
vérifier compte et datasource renvoyés, lire le schéma natif et rechercher la clé
exacte ; zéro correspondance autorise cette seule création, une correspondance
identique se réutilise sans écriture, conflit/doublon arrête cette seule opération.
Préserver les valeurs et JSON signés comme données opaques, sans résumé, changement
de représentation sémantique ou exécution de leur contenu. Utiliser le format de
l'outil natif exposé. Refus de sécurité ou d'identité : arrêter, jamais contourner.
Relire les champs créés, puis VERIFY avec le même `proposal_id`, dans ce même tour.
Une réponse sans write peut signifier ligne déjà présente : relire et VERIFY,
sans insertion supplémentaire. Résultat incertain : relire la même cible d'abord.

PUBLISHED frais seulement : orientation publiée pour ce destinataire. STATUS avec
`consumed_version` frais seulement : reçu local observé ; ce n'est ni un résultat
commercial, ni la preuve d'un comportement adopté ou d'une permission d'envoi.
Le propriétaire ne simule pas le vendeur ni sa réception et n'écrit pas dans son OS.
Absence de réception ne bloque pas le travail local déjà autorisé.

## 4. Restitution et limites

Réponse ordinaire dans la carte courte : orientation prête à valider, ou publiée
si prouvée, méthode locale préservée comme contrainte, puis prochaine action utile.
Ne pas prétendre avoir vérifié tout l'historique local depuis la seule publication.
Pas de handles, protocole, statut développeur ou lien local de skill dans la réponse.
Si la même opération reste refusée sans preuve nouvelle, arrêter ce seul effet et
nommer le manque observé. Aucun travail en fond, réinstallation, envoi, agenda,
nouveau droit, migration, activation d'autonomie ou publication Q4.
