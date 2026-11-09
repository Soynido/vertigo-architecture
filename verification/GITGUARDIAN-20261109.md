# Alerte GitGuardian du 9 novembre 2026

GitGuardian a signalé la ligne 13 de `deploy/docker-compose.yml` dans le premier
commit publié. L’inspection de l’incident a confirmé que le détecteur avait
interprété le début du message d’erreur de l’interpolation Compose comme un mot
de passe. La ligne demande une variable d’environnement ; elle ne contient pas
de valeur d’authentification.

Le préparateur a classé cet incident dans GitGuardian comme **Not a secret
(false positive)** et a relu ce statut. Le détecteur reste activé. Le dépôt reste privé.

## Correction de la copie de revue

La référence Compose utilise maintenant `${POSTGRES_PASSWORD:?}`. Elle exige
toujours une variable définie et non vide ; le texte du message d’erreur a changé.
La configuration de production et le dépôt source restent intacts. Aucun mot de
passe n’a été révoqué ou remplacé pour cette alerte.

Référence : [interpolation des variables Compose](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/).
L’opérateur ne dispose pas du CLI Docker dans cet environnement ; il n’a lancé ni
`docker compose config` ni conteneur pour cette correction documentaire.

## Contrôle complémentaire

Le scan Gitleaks a signalé six autres chaînes : des clés symboliques de runtime,
d’action et de couverture dans le code ou les tests. Ce ne sont pas des valeurs
d’authentification. Le [rapport](secret-scan.json) conserve leur nombre et leurs
emplacements.

Le classement repose sur le chemin, le détecteur et l’empreinte de la ligne entière.
Changer la ligne, le fichier ou le type de détection impose une nouvelle revue.
Le script ne désactive aucun détecteur et n’exclut aucun répertoire. Ce scan
complète la comparaison privée et le contrôle des identifiants ; il ne garantit
pas l’absence de tout secret et ne remplace pas GitGuardian.
