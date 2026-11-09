# Choix techniques, incidents et limites

| Choix | Pourquoi | Compromis / limite |
|---|---|---|
| Notion comme mémoire métier | Modifier le contexte et les méthodes sans reconstruire l’application | Relecture nécessaire ; schémas versionnés ; plusieurs écritures non atomiques |
| Connecteurs natifs du compte | Travailler avec ses outils et ses droits existants | Le harness ne voit pas l’intérieur des appels privés |
| Profils fixes côté serveur | Ne pas accepter une cible arbitraire fournie par le modèle | Ce n’est pas une plateforme multi-locataire générique |
| Skills + protocoles codés | Séparer conduite conversationnelle et validation structurée | Une consigne au modèle reste faillible |
| Journal d’orientation séparé | Éviter que la journalisation META perturbe les contrôles Sales | Publication, réception et effet métier restent trois preuves |
| Relectures et State-last | Limiter les faux succès et permettre une reprise contrôlée | Ne rend pas Notion transactionnel et ne résout pas tout effet externe |
| Logs à champs fermés | Diagnostiquer sans copier mails, CSV ou conversations | Causes privées exactes et activité hors appels restent invisibles |
| Observation passive bornée | Donner au manager des pistes accessibles | Échantillon non atomique, pas activité exhaustive ni satisfaction |
| Version d’archive calculée sur le nombre de commits | Produire une version croissante dans l’historique d’origine | Un nouvel historique remet ce compteur à zéro ; ce dossier ne distribue pas de ZIP |

## Ce que les incidents ont appris

- **La reprise peut réutiliser une ancienne consigne technique.** Le bootstrap
  prescrit un CONTEXT frais et les lectures Notion pertinentes à chaque demande ;
  le serveur ne peut pas forcer un chat qui ne l’appelle pas.
- **La journalisation META pouvait interférer avec des contrôles Sales.** Le
  contrat d’orientation possède son domaine de journal et ses preuves propres ;
  les tests couvrent la coexistence et les dépendances.
- **Un paquet peut être valide en source et échouer à l’import.** Les scripts
  conservent l’identité et les connexions du paquet existant ; la compatibilité
  du ZIP ne vaut pas preuve d’installation sur l’hôte privé.
- **Une erreur CSV peut rester invisible.** REPORT_STEP fournit un canal de
  déclaration, pas une interception. Une sonde opérateur n’est pas une preuve client.

## Limites que ce dossier ne masque pas

- La version de production et les installations privées n’ont pas été revalidées le jour de cette revue.
- L’absence de logs ne prouve ni panne ni absence de travail.
- La réception d’une orientation ne prouve pas son application ni une vente.
- Les quatre horizons d’objectifs ne forment pas ici une cascade générique
  automatiquement recalculée et mesurée.
- Une fabrique d’OS, Content OS et DEV OS restent des perspectives documentées.
- Aucun chiffre de gain de temps, satisfaction, ROI ou coût mensuel n’est certifié.

## Coût à évaluer

Le coût complet inclut abonnements et crédits IA, hébergement, construction/tests,
maintenance et onboarding. Les temps serveur ne représentent pas du temps humain.
Le dossier explique les mécanismes ; il ne présente pas de prix de fournisseurs
historique comme un tarif actuel.
