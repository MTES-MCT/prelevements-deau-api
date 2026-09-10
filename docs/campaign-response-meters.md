# Changement de compteur dans une réponse de campagne

Cette saisie est limitée au volet `INDEX` et aux points que le déclarant ou son
mandataire peut modifier. Elle ne donne aucun droit sur les autres points.

## Brouillon

`PATCH /campaigns/:campaignId/responses/INDEX` conserve le contrôle
`expectedVersion`. Chaque événement de `data.meterEvents` indique le point,
la date, l’ancien compteur, les index avant/après et une raison.

- `RESET` conserve le même compteur.
- `REPLACEMENT` utilise soit `nextCompteurId` pour un compteur du point déjà
  connu, soit `nextMeter: {serialNumber?, identifier?}`. Au moins une chaîne
  non vide de 200 caractères au maximum est nécessaire. Les deux formes sont
  exclusives.
- Un index inconnu est explicitement `null`, jamais remplacé par zéro.
- La date doit être comprise entre les relevés extrêmes de la campagne et
  dans la période d’affectation de l’ancien compteur. Un même changement ne
  peut pas être envoyé deux fois.

L’enregistrement du brouillon ne crée aucune fiche ni affectation globale.
La réponse et le contexte renvoient `targets`. Pour chaque nouveau compteur,
`meters` contient un `compteurId` UUID stable, `pending: true` et
`pendingEvent: {previousCompteurId, at}`. Ce compteur virtuel peut être utilisé
dans les relevés suivants du même brouillon. L’événement conserve `nextMeter`
et n’est pas remplacé par `nextCompteurId` à ce stade.

En retirant l’événement, le client retire les relevés de son compteur virtuel.
Un compteur virtuel absent des événements du brouillon ne peut pas être utilisé.

## Transmission

La transmission revérifie le mandat, la fenêtre de réponse, la version et le
calcul. La nouvelle fiche, son affectation datée, le compteur de campagne et la
publication sont écrits dans la même transaction. Un échec annule l’ensemble.
Le compteur créé conserve l’UUID du brouillon. Si une identité identique est
déjà affectée au même point à cette même date, elle est réutilisée et les
références sont normalisées.

Une identité déjà utilisée ailleurs ou une affectation superposée renvoie un
conflit `409`, sans divulguer ni rattacher le compteur d’un autre point.
Le snapshot publié contient uniquement les identifiants réels. Les anciens
index, anciennes soumissions et affectations de l’ancien compteur ne sont pas
réécrits. Le rejeu d’une transmission reste protégé par sa clé d’idempotence.

Pour une campagne encore en préparation, les affectations sont bornées par les
changements de compteur des dernières réponses transmises sur ses points. Un
ancien compteur remplacé n'est donc plus demandé après sa date de remplacement.
Un brouillon de correction ne modifie pas cet historique : seule sa transmission
est prise en compte. Les campagnes déjà ouvertes conservent leur inventaire figé.

## Carte du contexte

`targets[].pointPrelevement.coordinates` est un point GeoJSON ou `null`.
Une seule requête spatiale charge les coordonnées après résolution du périmètre
du préleveur sélectionné. Aucun point supplémentaire n’est exposé.
