# Preuves anonymisées : portée et limites

| Pièce | Niveau et résultat |
|---|---|
| [Publication META](01-direction-publication.json) | Reçu opérateur ; publication et reprise propriétaire, réception privée non prouvée |
| [Manque de reçu destinataire](02-direction-reception-gap.json) | Relecture opérateur ; conserve explicitement le manque de preuve |
| [Reprise administrative](03-admin-recovery.json) | Enregistrement relu rapporté par reçu ; aucun PASS global |
| [Reporting CSV](04-csv-reporting.json) | Sondes serveur opérateur ; aucune preuve client dans sa fenêtre |
| [Activité passive](05-passive-activity.json) | Observation propriétaire bornée ; pas de satisfaction ni exhaustivité |
| [Daily GO et reprise](06-owner-reported-daily-go.json) | Usage rapporté par le propriétaire, pas une trace privée reconstituée |

Ce sont des **documents dérivés** de reçus historiques, pas des originaux signés.
Les empreintes sources servent à identifier la pièce sélectionnée, sans conférer
une validité cryptographique à la version transformée. Identifiants, connexions,
signatures, contenus métier et captures privées ne sont pas publiés.

Les objets d’exemple sont dans [examples](../examples/work-dossier.json), avec un
marquage SYNTHETIC distinct. Ils ne complètent pas les preuves manquantes.
