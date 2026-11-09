# D’où viennent les fichiers ?

Le manifeste décrit les fichiers copiés : code, tests, migrations, scripts,
manifestes et compétences. Chaque entrée donne l’origine relative, la révision,
l’empreinte du fichier source et celle de la copie.

Le checkout source avait des modifications et des fichiers non committés. La copie
les inclut et distingue `HEAD_IDENTICAL`, `MODIFIED_FROM_HEAD` et
`UNTRACKED_AT_CAPTURE`. Un commit source ne suffit donc pas à reconstruire ce dossier.

Les compétences du pilote viennent d’un cache local versionné 0.1.19. Ce relevé
ne confirme pas les versions installées dans les comptes des collaborateurs.

## Transformations

Le préparateur remplace les noms et les identifiants privés par des alias cohérents.
Il remplace aussi les adresses personnelles, liens de chat, chemins locaux et
connexions privées. Le manifeste signale les fichiers transformés. Le code copié
ne correspond donc pas toujours octet pour octet à sa source ; ces transformations
n’ajoutent pas de fonctionnalité produit.

Les documents écrits pour la revue et les exports de schémas ont leur propre
inventaire dans le manifeste de livraison. L’ancien historique Git, les fichiers
de configuration privés, les données clients, dumps et archives de connexion
restent hors du dépôt. Les reçus choisis donnent lieu à des résumés anonymisés ;
le dossier n’importe pas le journal de travail complet.

Le contrôle privé compare les fichiers aux valeurs confidentielles connues sans
exporter ces valeurs. Le contrôle public recherche aussi des motifs sensibles,
les liens cassés et les incohérences de l’exemple.

Le propriétaire conserve ses modifications et ses signatures GitHub dans l’historique.
Les contrôles d’anonymisation visent les données des collaborateurs, les accès et
les preuves copiées ; ils ne réécrivent pas ses signatures de compte.

## Cas opérationnels ajoutés le 9 novembre

À la demande du propriétaire, le README, la page d’usage et ses illustrations conservent
les prénoms Célia, Aron et Julian. Célia y figure comme manager. Les nouvelles
pièces documentent des contenus réels consultés dans Notion et des usages
rapportés ; leurs résumés retirent identifiants, coordonnées et données clients.
Les réponses privées ne sont pas reconstituées. Cette autorisation sur les prénoms
ne réintroduit pas les identités privées dans les sources anonymisées.
