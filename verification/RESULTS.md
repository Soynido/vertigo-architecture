# Résultats de la vérification locale

Date : 9 novembre 2026. Ces résultats concernent cette copie de revue.
Les tests utilisent des données fictives, des clients simulés et des serveurs
locaux. Ils ne sollicitent pas les comptes des collaborateurs.

| Contrôle | Résultat |
|---|---|
| Installation depuis le cache et le lockfile | 110 paquets réutilisés, zéro téléchargement ; scripts d’installation désactivés |
| Typage harness et mail-executor, compilateur direct | Réussi |
| Compilation des deux paquets | Réussie |
| Contrôles Sales, orientations, activité passive et traces | 223 tests réussis après correction des alias de la copie |
| Préparation et préservation des paquets Sales | 7 tests réussis |
| Architecture et contrôle des fichiers privés | 9 tests réussis après initialisation du nouveau dépôt Git |
| Suite mail-executor | 17 réussis, un test PostgreSQL non exécuté |
| Suite harness complète, premier passage | 1 777 réussis, deux échecs, cinq tests non exécutés |
| Reprise ciblée des deux échecs harness | Réussie : collision d’alias et absence du dépôt Git corrigées dans la copie |
| Suite plugin après préparation du dépôt | 89 réussis, trois échecs expliqués ci-dessous |

La suite harness complète n’a pas été relancée après ces corrections ; la reprise
cible les tests concernés et les contrôles natifs. Le rapport conserve chaque passage.

## Trois attentes de l’ancien dépôt restent en échec

1. **PT-PKG-008** attend l’ancien README produit en anglais. Le README de ce dossier
   explique l’architecture au CTO ; l’original figure dans l’archive.
2. **PT-PKG-009/i** calcule la version du ZIP avec le nombre de commits et attend
   qu’elle dépasse 1.0.142. Le nouvel historique commence à un commit, donc le script
   obtient 1.0.1. Ce dépôt ne fournit pas de nouvelle version installable du plugin.
3. **PT-PRO-007/c** attend un seul fichier `SKILL.md` dans le dépôt. La revue rassemble
   les compétences du pilote et celle de l’ancien plugin, avec leurs statuts.

Le préparateur conserve ces tests et leurs assertions. Il n’annonce pas une suite
produit entièrement verte et ne distribue aucun ZIP issu de ce dépôt.

## Essais de préparation conservés au rapport

Le premier `pnpm install --frozen-lockfile` a rencontré un écart de configuration
autoInstallPeers. L’option correspondant au lockfile a permis l’installation depuis
le cache, sans régénérer le lockfile. `pnpm typecheck` a ensuite tenté une
réconciliation du gestionnaire de paquets sans terminal interactif ; le préparateur
a lancé les compilateurs TypeScript directement, qui ont réussi.

Les premiers tests de paquets dépendaient aussi d’un dépôt Git initialisé et de
chemins documentaires historiques. Le préparateur a créé le nouveau dépôt local et
conservé les références historiques à leur chemin, avec une mention de leur statut.

Commandes, codes de sortie et compteurs : [rapport machine](local-checks.json).
Contrôle des fichiers : [audit du dossier](dossier-audit.json).
Comparaison privée sans export des valeurs : [résultat](private-value-check.json).
