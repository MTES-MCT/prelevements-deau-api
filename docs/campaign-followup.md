# Suivi de campagne et résultats

Ces trois lectures sont réservées aux utilisateurs autorisés à suivre la
campagne (`canFollowup`). Les droits et les points visibles sont revérifiés à
chaque requête par `getCampaignAccess`. Les réponses utilisent l’enveloppe
habituelle `{success: true, data: ...}` et ne sont pas mises en cache HTTP.

## Progression

`GET /campaigns/:campaignId/responses/summary`

- `preleveurCount` : préleveurs distincts ayant au moins un point visible.
- `expectedCount` : deux volets par préleveur, `INDEX` et `NEEDS`.
- `receivedCount` : volets disposant d’une dernière transmission officielle.
- `correctionCount` : sous-ensemble reçu, actuellement repassé en `DRAFT`.
- `byKind.INDEX` et `byKind.NEEDS` : les trois compteurs par volet.
- `scopeComplete` : indique si le périmètre couvre tous les points de campagne.

La jauge compte des réponses, pas des points ou des périodes. Une correction
ne retire pas la transmission précédente des résultats. Un relevé indisponible
justifié peut être transmis sans qu’un volume soit calculable : réception et
qualité des données sont deux informations différentes. Une campagne sans
point renvoie des compteurs à zéro.

## Avancement dans la liste des campagnes

`GET /campaigns` renvoie `campaign`, `permissions`, `counts` et `progress` pour
chaque élément de `data.items`. `counts.pointCount` et `counts.preleveurCount`
comptent uniquement les points et préleveurs autorisés. Les fiches des points,
compteurs, contacts et gestionnaires proposés ne sont plus chargées ni renvoyées
dans cette liste ; le détail conserve son contrat. Le format de `progress` est celui
du résumé ci-dessus, avec une jauge par volet. Il vaut `null` pour les campagnes
en brouillon et pour les utilisateurs sans `canFollowup`.

La liste charge les habilitations actives de l’agent en une fois, puis les
campagnes avec seulement leurs relations légères. Les brouillons non gérables
sont exclus avant la limite de 200 ; pour les autres campagnes, les droits sur
les zones des points sont pris en compte même si la zone de campagne diffère.
Une seule agrégation SQL couvre toutes les campagnes ouvertes ou clôturées.
Seuls les couples campagne /
préleveur autorisés sont joints ; un même préleveur visible dans une campagne
ne donne aucun droit supplémentaire dans une autre. Les réponses sans dernière
transmission ne sont pas comptées comme reçues, même si un brouillon existe.
Aucun brouillon, commentaire, snapshot ou publication n’est chargé pour ces
jauges. Une liste sans campagne éligible ne déclenche aucune agrégation.

## Liste paginée

`GET /campaigns/:campaignId/responses/overview`

Paramètres : `limit` de 1 à 100 (20 par défaut), `cursor` UUID renvoyé par la
page précédente, `q` de 100 caractères maximum et `status` :

- `all` : tous les préleveurs visibles ;
- `missing` : au moins un volet n’a jamais été reçu ;
- `received` : les deux volets ont déjà été reçus ;
- `correction` : au moins un volet reçu est actuellement en brouillon.

Les filtres `received` et `correction` peuvent se recouper. Une absence de
réponse donne `status: null`, pas un faux brouillon. Chaque volet expose
`status`, `received`, `correctionPending` et `latestSubmissionAt`.

La recherche ignore casse et accents dans le nom du préleveur et les noms de
ses points visibles. Elle conserve le nombre total de points visibles de ce
préleveur. Le tri est stable par nom français puis UUID. Recherche et filtre
précèdent la pagination ; `pagination.totalCount` porte sur ce résultat filtré.
Un curseur qui n’appartient plus à ce résultat renvoie `400` : le client doit
recommencer à la première page.

## Valeurs à la demande

`GET /campaigns/:campaignId/responses/results?preleveurUserId=:uuid`

Charge les points visibles et la dernière transmission officielle de chaque
volet de ce seul préleveur. La réponse ne contient aucun brouillon ni aucune
ancienne version. Les valeurs restent décimales textuelles, sans conversion
en nombres flottants :

- index : `responses.INDEX.latestSubmission.snapshot.readings` ;
- besoins : `responses.NEEDS.latestSubmission.snapshot.needs` ;
- volumes : `responses.INDEX.latestSubmission.publication.totals`.

Un volume `MISSING` ou `CONFLICT` garde sa valeur `null`, jamais zéro. Une
réponse sans transmission expose `latestSubmission: null`. Un volet jamais
enregistré vaut lui-même `null`.

Toutes les lignes et références sont filtrées par point autorisé. Le
commentaire et les informations globales sont retirés lorsque les points du
préleveur ne sont pas entièrement visibles. Un préleveur étranger au périmètre
est refusé avant toute lecture de ses réponses.

## Coût et compatibilité

Le résumé et la liste sélectionnent uniquement les métadonnées des réponses,
dans une requête bornée aux préleveurs autorisés. Ils ne chargent ni brouillons
ni snapshots/publications. Le regroupement et les filtres utilisent les points
déjà résolus par les droits ; il n’y a pas de requête par point ou préleveur.
Une campagne est limitée à 5 000 points lors de sa configuration.

Le détail lourd est chargé uniquement à l’ouverture des résultats d’un
préleveur. La liste des campagnes ne recharge plus un détail et les droits pour
chaque carte : son nombre de lectures groupées reste constant (au plus trois
appels Prisma pour un agent, hors lectures relationnelles groupées par Prisma).
L’ancien endpoint `/responses`, les exports et les
parcours de saisie restent inchangés. Aucune migration ni variable
d’environnement supplémentaire n’est nécessaire.

## Ancienne commande de réouverture

La réouverture manuelle n’est plus proposée. Le contexte renvoie toujours
`canReopen: false` ; l’ancien
`POST /campaigns/:campaignId/responses/:kind/reopen` est conservé pour répondre
explicitement `410 Gone`, sans lire ni modifier de données.

Ce retrait ne supprime aucun brouillon, aucune transmission ou publication,
aucun champ historique de réouverture. Les anciennes fenêtres `reopenUntil`
conservent leur effet jusqu’à leur échéance. L’enregistrement ordinaire pendant
une fenêtre autorisée, y compris la correction d’une réponse déjà transmise,
reste inchangé.

Les courriels d’ouverture et de confirmation de réception restent envoyés.
La confirmation renvoie à la réponse consultable ; elle ne promet plus un
récépissé téléchargeable ou un historique qui ne sont pas affichés dans l’espace.
