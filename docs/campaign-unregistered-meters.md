# Changements de compteur sans ancien inventaire

Le parcours déclarant accepte un ancien compteur non référencé : son identifiant
reste `null`. Aucune fiche de compteur fictive ni affectation fictive n’est créée.
Les droits de saisie, la fenêtre de réponse et le contrôle de version restent
ceux de la campagne.

## Contrat des événements

- Remise à zéro : `type: "RESET"`, `previousCompteurId: null` et
  `nextCompteurId: null` (ce dernier champ peut être omis).
- Remplacement : `type: "REPLACEMENT"`, `previousCompteurId: null` et
  `nextMeter: {serialNumber, identifier}` avec au moins une identification.
  Un `nextCompteurId` déjà autorisé sur cette cible peut aussi être utilisé,
  exclusivement à la place de `nextMeter`.
- La date, les deux index ou leur absence justifiée, et le motif restent
  nécessaires. Les index restent des chaînes décimales exactes.

Le brouillon conserve `nextMeter`. L’API calcule un identifiant virtuel stable
pour les champs du nouveau compteur. Sa fiche et son affectation ne sont créées
qu’à la transmission, dans la transaction existante. Un échec annule aussi ces
créations. Une annulation du changement avant transmission ne laisse aucun
compteur dans l’inventaire.

## Modification d’un changement enregistré dans le brouillon

L’action « Modifier » transmet sur l’événement un marqueur temporaire
`previousEvent: {at, previousCompteurId, nextMeter?}` désignant sa version dans
le brouillon courant. `nextMeter`, lorsqu’il existe, contient l’ancienne
identification. Les droits et la version du brouillon sont contrôlés avant
toute réconciliation.

L’API met à jour les identifiants virtuels dans les relevés et dans les
changements suivants, sans modifier les valeurs ni leurs références sources.
Le marqueur est supprimé avant l’enregistrement. Un snapshot déjà en attente
peut le rejouer uniquement si l’identité éditée correspond au brouillon déjà
normalisé. Aucune correction d’identité n’est déduite sans ce marqueur.

Une date qui atteint ou traverse un relevé concerné est refusée, plutôt que de
changer son compteur implicitement. Modifier le type ou les compteurs d’un
changement est également refusé si des relevés ou changements en dépendent.
Les corrections d’index et de motif restent possibles. Cette édition ne
renomme et ne recrée jamais une fiche de compteur déjà enregistrée.

## Dates et suppression des cartes

Dès la sauvegarde, la date doit appartenir à la campagne et aux affectations de
l’ancien et du nouveau compteur. Un changement sur un compteur doit se situer
après son entrée et avant sa sortie déclarées. Deux changements en chaîne le
même jour, plusieurs remplacements du même compteur et les boucles sont
refusés. Des changements indépendants peuvent partager une date, et l’ordre
d’affichage des cartes n’a pas d’effet sur leur validité.

Ces erreurs sont exposées dans `data.issues` de la réponse HTTP 400, avec
`targetId`, `compteurId`, `at`, `field`, `code` et `message`. Les incohérences
d’anciens brouillons apparaissent également dans `calculation.issues`. Ces
contrôles ne demandent pas de compléter les relevés encore manquants.

Un ancien brouillon déjà incohérent peut être corrigé progressivement en
retirant des cartes : les autres événements, les valeurs et les références
doivent rester inchangés, hors rattachement déterministe des relevés du compteur
virtuel retiré à son ancien compteur. Aucune nouvelle erreur structurelle
n’est admise. Les erreurs restantes demeurent visibles et bloquent toujours
la transmission ; cette exception ne s’applique pas aux éditions ordinaires.

Chaque carte peut être retirée indépendamment. En retirant un remplacement
virtuel, le client peut rattacher ses relevés à l’ancien compteur lorsque les
dates et les autres changements le permettent, sans changer leurs valeurs.
L’API ne supprime jamais ces relevés ni les fiches de l’inventaire. Les
références historiques, leurs versions et les motifs de correction sont
conservés. Une source identifiée sur un autre compteur reste incompatible et
bloque la transmission ; une source anonyme conserve son contrôle explicite
d’identité. Une éventuelle baisse d’index reste signalée dans le calcul, sans
empêcher de conserver le brouillon à corriger.

## Relevés déjà saisis

Lorsque l’utilisateur clique sur « Valider le changement » pour un remplacement
dont l’ancien compteur est `null`, le client envoie
`reassignFollowingReadings: true` si des relevés anonymes postérieurs sont déjà
saisis. Cette validation du formulaire demande leur rattachement au nouveau
compteur, sans confirmation séparée.

L’API rattache alors au nouveau compteur uniquement les relevés encore sans
identité de cette même cible, strictement après la date du changement et dans la
période du nouveau compteur. Elle conserve leurs valeurs et leurs références
historiques. La validation du changement renseigne l’identité pour ces seuls
relevés (`meterConfirmed: true`). Les relevés du jour du changement restent du
côté de l’ancien compteur. Un doublon est refusé, jamais écrasé.

Le flag de rattachement est consommé : il n’est pas conservé dans le brouillon.
Le client doit adopter les relevés normalisés renvoyés par la sauvegarde, sans
écraser une édition plus récente. Sans cette demande issue de la validation du
changement, aucune réattribution automatique n’a lieu, notamment au chargement
du brouillon. Un relevé anonyme situé après sa phase autorisée est refusé.

## Contexte de saisie et calcul

La phase sans compteur identifié ne demande pas de confirmation manuelle de
continuité. L’API n’ajoute pas de `meterConfirmed` à ces relevés. Les anciens
brouillons qui contiennent ce champ restent compatibles.

La reprise d’un relevé historique exige toujours de sélectionner explicitement
sa source et de conserver sa version. Une source sans compteur reste sans
identité lorsqu’elle est reprise dans la phase `null`, sans confirmation
artificielle. Son rattachement à un vrai compteur reste soumis à une confirmation
explicite d’identité. Les contrôles de provenance, de dates, de baisse d’index et
de transition entre compteurs restent inchangés.

Les cibles du contexte de saisie exposent deux indications calculées côté API :

- `meterlessInitial` indique l’existence d’une phase initiale sans identité.
- `meterlessEndDate` indique sa dernière borne, ou `null` si l’inventaire réel ne
  contient pas encore de compteur qui termine cette phase. Les compteurs
  virtuels ne modifient pas cette indication ; le client utilise aussi les
  événements courants pour afficher les bonnes périodes.

Ces indications d’affichage ne sont jamais acceptées comme une autorisation en
entrée. Validation et calcul reconstruisent les périodes depuis l’inventaire
daté, y compris les nouveaux compteurs préparés. Un compteur déjà connu sur la
phase initiale interdit de la remplacer par une identité `null`.

La phase initiale est conservée après publication et rechargement. Le calcul
additionne les segments de l’ancien puis du nouveau compteur, sans soustraire
leurs index entre eux. Une transition vers un compteur connu qui commence plus
tard doit être déclarée explicitement. Les remises à zéro et remplacements
chaînés, les bornes partagées et les absences justifiées suivent les mêmes règles
que les compteurs déjà référencés. Une retransmission de commentaire réutilise
les relevés canoniques et leurs références ; les anciennes mesures restent
conservées.

Aucune migration, variable d’environnement ou opération sur les inventaires
partagés n’est nécessaire en dehors de la transmission demandée.
