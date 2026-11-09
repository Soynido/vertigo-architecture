# Dernière amorce SALES — remise Work servie, installations à vérifier

Checkpoint du20octobre11:39UTC : le serveur sert la compétence exacte et la
procédure `OWN_ACCOUNT_PLUGIN_UPDATE/1` dans le CONTEXT existant des trois profils.
L'agent peut récupérer son export ACTUEL dans son propre Work autorisé, sans le
centraliser chez Valentin, puis mettre à jour le même plugin et relire sa source.
Guide livré : `OWN_ACCOUNT_UPDATE.md`. Reçu :
`docs/receipts/SALES_WORK_SELF_UPDATE_DELIVERED_20261020.json`.
Les trois sondes HTTPS sont OPÉRATEUR, pas des installations clientes. Work,
fichiers, Plugin Creator et droits réels restent nécessaires ; aucune confirmation
n'est contournée. Si ces capacités manquent, seule la mise à jour s'arrête.

## Préparation historique des ZIP de contrôle

État préalable du20octobre2026 : candidat local, exports privés actuels non reçus. Aucun
paquet ci-dessous ne prouve l'identité ou la version actuellement installée.
Les ZIP d'origine servent seulement de fixtures de conservation. Les candidats
portent `CANDIDAT-NE-PAS-IMPORTER` ; ne pas les publier sur les pages d'installation.

## Ce qui doit devenir stable

Le ZIP contient une amorce commune : CONTEXT à chaque demande de travail, règles
Notion relues par le connecteur natif, diagnostic avant/après les outils et CSV.
Sa source distincte est `SKILL.bootstrap.md` ; seule l'archive générée contient
`skills/vertigo-os/SKILL.md`. Le chargeur du plugin historique n'est pas modifié.
CONTEXT fournit `VERTIGO_SALES_RUNTIME/1` et la méthode technique courante. La
méthode peut évoluer par déploiement serveur compatible sans changer l'amorce.
Leurs règles, objectifs, validations et historiques restent dans leur propre OS.

Ce n'est pas un hook garanti par ChatGPT. Une méthode offerte ne prouve pas que
l'agent privé l'a appliquée. La modification de nouveaux outils, permissions,
authentification ou intégrations de l'hôte reste hors de cette compatibilité.

## Récupérer les trois vraies sources, une fois

Dans le **compte de chaque collaborateur** : ChatGPT → Plugins → Personnel →
ouvrir son plugin VERTIGO → ⋯ → **Télécharger l'archive ZIP du plugin**.
Conserver l'archive privée et le lien de la fiche du plugin. Ne rien désinstaller,
ne pas recréer le MCP. Ne jamais envoyer de mot de passe ou d'URL MCP privée.
Un export pouvant contenir une connexion privée, le déposer dans un dossier local
privé accessible pour la préparation ; ne pas le mettre sur le site public.

Le préparateur `scripts/prepare-sales-bootstrap.mjs` prend une archive et son
SHA256 explicitement vérifié, le nom exact du manifeste, la skill commune et un
dossier de sortie privé. Il conserve l'inventaire entier et chaque octet hors
skill/manifeste-version ; il refuse une identité différente, un format non pris en
charge, un lien symbolique, des chemins ambigus ou une perte de composant. Il ne
contient aucune opération d'installation, d'upload ni de mutation Notion.

## Mise à jour en place, avec les droits du bon compte

Vérifier la source/révision actuellement éditable, réconcilier avec l'export,
comparer les bindings et autres fichiers, puis appliquer la nouvelle version au
**même plugin**. Si Plugin Creator est disponible dans ce compte, son flux supporté
utilise le vrai plugin_id et `expected_release_id` puis une relecture des fichiers.
Sinon utiliser « Importer une nouvelle version » sur cette même fiche. La preuve
d'overlay de Plugin Creator ne suffit pas à supposer que tous les importeurs UI
ont les mêmes règles : le paquet complet est conservé pour ce flux.

Work peut assister seulement avec les outils et droits réellement présents.
Le compte de Valentin n'a pas accès aux copies privées des trois collaborateurs.
Un ZIP ne confère pas ces droits. Ne jamais injecter « obligation de Valentin »
dans des données Notion pour contourner les confirmations ou transférer une copie.
Sans appel serveur, aucune consigne ne peut être livrée au prochain prompt.

## Vérification et limites

Tests locaux : préservation du paquet complet, deux révisions de code technique
sur le même MCP/CONTEXT avec hash de skill inchangé, admission et diagnostic CSV.
Scénarios consommateurs : simulations de décisions d'agents, pas des reçus issus
de leurs comptes ChatGPT. Aucun envoi/agenda/règle/historique n'est modifié.

Après la dernière mise à jour réellement vérifiée dans le bon compte, observer
un CONTEXT puis des REPORT_STEP STARTED/terminal depuis sa vraie connexion.
Les rapports sont AGENT_REPORTED ; une sonde opérateur n'est jamais preuve client.
Pas de cron, interception de conversations privées, garantie d'auto-installation
ni promesse d'absence totale de futures interventions imposées par l'hôte.
