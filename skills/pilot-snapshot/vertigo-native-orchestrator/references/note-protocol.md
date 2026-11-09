# Note isolée — lecture, sauvegarde et reprise

Ce protocole a une seule cible définie dans pilot-scope.md. Pas de CREATE, pas de nouvelle
table ou page. La note n'entre dans aucune décision, métrique, campagne ou règle de production.

## Retrouver ou consulter la note

Découvrir `vertigo_note_read` et appeler cet outil avec les arguments vides `{}`.
Il relit la note native et le journal signé sans écrire dans Notion ni dans le journal.
Sur VERIFIED frais, restituer la note observée et une prochaine petite étape de l'essai.
EMPTY signifie qu'aucune note sauvegardée n'est confirmée par ce contrôle.
Si le lecteur est indisponible ou ne confirme pas la note, une lecture Notion native
de la cible fixe peut établir sa présence, pas le contrôle indépendant. Distinguer
les deux preuves ; ne pas préparer ni réparer la sauvegarde depuis cette consultation.
Une intention pending, un conflit ou un journal absent restent inchangés. Pour cette
branche, STATUS, PREPARE et VERIFY ne sont pas des outils de lecture pure.

## Enregistrer ou poursuivre explicitement une sauvegarde

1. Après STATUS, pour une sauvegarde explicitement demandée, appeler `vertigo_note_control`
   avec `action: PREPARE` et `note_text`: le texte naturel exact (sans l'introduction « note pour notre essai »).
   Ne jamais fournir page, principal, opération, signature ou indicateur de succès en entrée.
   PREPARED conserve l'intention durablement et donne la cible fixe, la clé et previous_text.
   VERIFIED pour la même note signifie qu'elle vient d'être relue : aucune nouvelle écriture.
   Avant toute mutation, lire la page et les contraintes de son connecteur. Si `truncated`, bloc inconnu ou lecture
   insuffisante empêche de contrôler la section concernée, ne pas modifier cette section.
2. Clé stable de cette note : HYBRID-OWNER-20261014-NOTE-1. Le texte est la préférence effectivement
   donnée par l'utilisateur, sans invention. Sous « Note de test », remplacer seulement le texte
   identique à previous_text par le nouveau texte, en conservant cette clé. Si la valeur native
   diffère, ne pas l'écraser : exposer le conflit de cette seule note. Ne pas modifier la reprise
   ni une autre section, même pour ajouter une preuve ou faciliter le contrôle.
   Laisser la section de vérification indépendante inchangée : elle appartient à l'opérateur.
3. Si la même clé et le même texte sont déjà présents une seule fois, relire et réutiliser,
   sans écriture. Pour une modification explicite de la note, relire la version courante puis
   effectuer un remplacement ciblé : la section ne contient que la clé et le texte courant,
   sans ligne d'historique ajoutée. Le journal serveur conserve le suivi technique. Ce pilote n'est pas une preuve
   de gestion atomique de writers concurrents ; conflit/doublon/valeurs inattendues → arrêt ciblé.
4. Utiliser l'action native de mise à jour, avec le plus petit old_str unique issu de la lecture.
   Aucune réécriture globale. Si l'outil rend une tâche asynchrone, attendre son résultat réel
   avant la relecture. Rechercher et lire les capacités manquantes avant d'accuser le fournisseur.
5. Relire la cible après mutation : texte exact, une seule clé, titre et marqueur préservés,
   reprise inchangée. Puis appeler automatiquement `vertigo_note_control` avec `action: VERIFY`
   dans ce même tour. Le serveur relit Notion ; ne dire « contrôlée indépendamment » que sur
   VERIFIED frais. Une signature copiée, l'affirmation du modèle ou l'accusé natif ne suffisent pas.
6. Timeout/résultat ambigu : relire d'abord. Déjà présent → ne pas réécrire ; absence certaine
   et cible inchangée → une tentative corrigée au plus ; état inconnu → aucune répétition aveugle.
   Appeler VERIFY après la relecture, même si le retour de la mutation a été perdu. Si la note
   est présente, ne pas la réécrire. Une panne identique ne justifie pas une boucle sans nouvel indice.
7. Pour retrouver la note dans un chat neuf, utiliser la branche de lecture `vertigo_note_read`. Restituer la note enregistrée,
   distinguer son statut de l'état du vrai META OS et proposer la prochaine action. Aucun
   changement de cible, nouvel onboarding, demande de recopier la note accessible ou nouveau test.

Dans ce parcours de sauvegarde seulement, STATUS/VERIFY peuvent conserver la preuve
de leur lecture dans le journal privé serveur. Une demande en lecture seule suit
la branche de consultation ci-dessus et ne conserve aucune nouvelle observation.
Si une reprise de sauvegarde est explicitement demandée et STATUS retrouve une intention non confirmée,
relire la cible. Présente → VERIFY, sans nouvelle écriture Notion.
Absente → PREPARE avec le même texte conservé pour reprendre la même opération seulement si
l'utilisateur demande bien de continuer la sauvegarde ; sinon restituer honnêtement ce qui reste à faire.
Si la note native est plus récente/différente du journal, ne pas la remplacer par l'ancienne version.
Toujours une prochaine action concrète, aucun prétendu travail en fond.
