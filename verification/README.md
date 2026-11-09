# Vérifications de ce dossier

Le CTO n’a rien à installer pour lire ce dépôt. Les commandes ci-dessous sont des
vérifications facultatives ; le rapport contient leurs résultats.
Les tests ne doivent utiliser que des fixtures synthétiques et ressources locales.

- Installation verrouillée : `pnpm install --offline --frozen-lockfile --ignore-scripts --config.auto-install-peers=true --config.exclude-links-from-lockfile=false`.
- Typage vérifié : compilateur TypeScript direct pour chaque paquet ; commandes au rapport.
- Tests ciblés : contrôles Sales, orientation, observation passive, logs et paquet.
- Contrôle du dossier : `python3 audit/check_dossier.py`.

La configuration autoInstallPeers explicite correspond au lockfile existant ;
elle ne demande pas de le régénérer. Le premier essai sans cette option a échoué
sur une différence de configuration pnpm et est conservé au rapport.

La [synthèse des résultats](RESULTS.md) explique les réussites et les trois attentes
de l’ancien dépôt qui restent en échec. Le [rapport local](local-checks.json)
conserve les commandes, codes de sortie et compteurs de chaque passage.
La [revue indépendante](independent-review.md) porte sur documentation et anonymisation.
Les contrôles ne certifient ni la production ni un compte privé ChatGPT.

Après l’alerte GitGuardian : [analyse et correction](GITGUARDIAN-20261109.md),
[scan standard complémentaire](secret-scan.json).
