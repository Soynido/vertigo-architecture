# Preuves anonymisées : portée et limites

| Pièce | Niveau et résultat |
|---|---|
| [Publication META](01-direction-publication.json) | Reçu opérateur ; publication et reprise propriétaire, réception privée non prouvée |
| [Manque de reçu destinataire](02-direction-reception-gap.json) | Relecture opérateur ; conserve explicitement le manque de preuve |
| [Reprise administrative](03-admin-recovery.json) | Enregistrement relu rapporté par reçu ; aucun PASS global |
| [Reporting CSV](04-csv-reporting.json) | Sondes serveur opérateur ; aucune preuve client dans sa fenêtre |
| [Activité passive](05-passive-activity.json) | Observation propriétaire bornée ; pas de satisfaction ni exhaustivité |
| [Daily GO et reprise](06-owner-reported-daily-go.json) | Usage rapporté par le propriétaire, pas une trace privée reconstituée |
| [Documents opérationnels Notion](07-notion-operational-artifacts.json) | Consultation ciblée du 9 novembre ; répartition, méthodes et positionnement présents dans les instantanés datés retournés |
| [Usages transmis par le propriétaire](08-owner-reported-operational-usage.json) | Reprise, ajout de méthodes, répartition et incidents rapportés ; aucune réponse privée reconstituée |

Ce sont des **documents dérivés** de reçus historiques, pas des originaux signés.
Les empreintes sources servent à identifier la pièce sélectionnée, sans conférer
une validité cryptographique à la version transformée. Identifiants, connexions,
signatures, contenus métier et captures privées ne sont pas publiés.

Les [cas réels illustrés](../docs/UTILISER-VERTIGO.md) montrent les usages et leur
utilité, avec leur niveau de preuve. Les prénoms autorisés par le propriétaire
y désignent les personnes concernées ; les coordonnées et identifiants restent exclus.
Les dates d’instantané de la pièce 07 limitent sa fraîcheur. Cette consultation
documentaire ne certifie pas les comptes ou la production actuelle.

Les objets d’exemple sont dans [examples](../examples/work-dossier.json), avec un
marquage SYNTHETIC distinct. Ils ne complètent pas les preuves manquantes.
