# Statistiques publiques : définitions et limites

Cette documentation interne décrit les indicateurs de `/stats`. Les explications de calcul ne sont pas affichées sur la page publique. L’API `GET /api/stats/public` expose uniquement des agrégats : aucun identifiant utilisateur, e-mail, nom de compte ou événement individuel.

## Périodes et périmètre

- `month` est un mois terminé au format `AAAA-MM`, entre janvier 1900 et le dernier mois terminé. Par défaut, ce dernier mois est retenu. Le mois courant est déterminé dans le fuseau `Europe/Paris`.
- La page utilise son sélecteur uniquement pour les déclarations mensuelles par territoire. Les canaux restent sur le dernier mois terminé et l’activité présente les six derniers mois terminés. L’API conserve sa réponse complète par mois, pour compatibilité et réutilisation du cache.
- Les mois proposés commencent au premier mois de mesure connu ; les mois sans données intermédiaires restent sélectionnables. Le mois demandé reste présent même s’il précède la première mesure.
- Le référentiel des points, préleveurs et rattachements est le référentiel actuel, pas une photographie historique reconstruite pour chaque mois.

## Déploiement et territoires

Le périmètre comprend les SAGE et départements où au moins une donnée de prélèvement admissible existe, quel que soit son mois. Tous les points de prélèvement non supprimés de ces territoires sont ensuite comptés, y compris ceux sans donnée pendant le mois sélectionné. Les points de rejet sont exclus.

Un préleveur est un utilisateur non supprimé de rôle `DECLARANT`, avec `declarantRole = PRELEVEUR`. Les collecteurs ne font pas partie des préleveurs de cet indicateur. Les rattachements proviennent des liens territoriaux explicites (`CREATION`, `MANUAL`, `MIGRATION`), des exploitations, des données et des déclarations. Plusieurs rattachements ne multiplient jamais un même préleveur dans un territoire.

Les profils sont `IRRIGANT` (agriculteurs), `ICPE` (industriels), `GESTIONNAIRE_AEP` (eau potable), `AUTRE` et non renseigné. Les nombres de points et de préleveurs des totaux sont dédupliqués sur l’ensemble du périmètre. Chaque territoire déduplique aussi ses propres points et préleveurs, mais les territoires peuvent se chevaucher : leurs nombres ne sont pas additionnables.

### Cas des Pyrénées-Orientales

Vérification de la copie locale le 14 septembre 2026 :

| Rattachement | Points |
| --- | ---: |
| Nappes plio-quaternaires uniquement | 2 |
| Tech-Albères uniquement | 72 |
| Les deux SAGE | 259 |
| Département, points distincts | 333 |

Les chiffres des SAGE sont donc 261 et 331, avec **261 + 331 − 259 = 333** points distincts. Les associations correspondent aux intersections géographiques (`ST_Intersects`). Elles ne constituent pas une attribution exclusive selon le type de ressource ou l’organisme gestionnaire. Ne pas modifier ces associations pour forcer une addition : elles servent aussi aux autorisations. Ces nombres sont une observation datée, pas des constantes métier.

## Nombre de déclarations mensuelles par territoire

Le libellé public désigne **un préleveur ayant au moins une donnée de prélèvement pour le mois sélectionné**. L’unité de compte est donc le couple préleveur/mois dans chaque territoire, et non un dossier `Declaration`, un fichier, un envoi ou un point.

- Plusieurs transmissions ou plusieurs points d’un même préleveur comptent une seule fois par territoire et par mois.
- La télérelève (`Source.API`) et les campagnes (`Source.BATCH`) participent au comptage même sans dossier `Declaration`.
- Le mois concerne la mesure, pas la date de réception. Une déclaration couvrant une année peut contribuer à plusieurs mois.
- La source doit être `COMPLETED` et le bloc de données `PENDING`, `VALIDATED` ou `AUTOMATICALLY_VALIDATED`. Les sources incomplètes/échouées et les blocs rejetés sont exclus. Un bloc sans type de flux explicite reste admissible si son point est un prélèvement ; les flux explicitement `REJET` sont exclus.
- Sont retenus les volumes prélevés, index et débits compatibles avec les codes actuels et historiques. Pour un volume, la période doit chevaucher le mois (`periodStart < début du mois suivant` et `periodEnd > début du mois`). Pour un index ou débit, la date `periodEnd` doit appartenir au mois. Une valeur nulle en quantité (zéro) reste une donnée valide ; l’absence de mesure ne l’est pas.
- Les dates de mesure sont les dates métier stockées dans `ChunkValue` ; elles ne sont pas décalées selon le fuseau du navigateur. Le fuseau Europe/Paris s’applique aux mois d’activité utilisateur et à la détermination du dernier mois terminé.
- L’attribution utilise, par priorité, le préleveur du bloc, le préleveur du dossier, puis l’unique préleveur lié au point sur les dates du bloc. Un rattachement ambigu n’est pas arbitrairement attribué.

Le champ API reste `reportingPreleveursCount` pour compatibilité. `preleveursCount` et `reportingRate` restent disponibles dans le contrat, même si la page privilégie le nombre de déclarations plutôt que le taux. Le taux est `null`, pas zéro, lorsque le dénominateur est nul.

## Canaux de transmission

Chaque préleveur remontant des données est classé une seule fois selon les **points distincts**, pas selon le nombre de mesures ou de transmissions :

- `DIRECT` : déclaration manuelle ou tableur, sans provenance d’import historique ;
- `THIRD_PARTY` : source API ou déclaration de type API ;
- `MIXED` : même nombre de points directs et tiers, sans point de provenance inconnue ;
- `UNKNOWN` : provenance inconnue ou majorité impossible à garantir.

Un canal est majoritaire uniquement si son nombre de points dépasse celui de l’autre canal additionné aux points inconnus. Un même point transmis via plusieurs canaux participe aux comptes de ces canaux ; la classification finale reste unique pour le préleveur. Les campagnes et imports sans provenance directe/API prouvée peuvent ainsi être classés dans le canal non renseigné. Les pourcentages ont pour dénominateur tous les préleveurs classés ; ils sont `null` quand aucun préleveur ne remonte de donnée.

## Utilisateurs actifs par mois

### Collecte réelle

Une activité correspond à l’utilisation visible et authentifiée de l’espace connecté : ouverture, navigation, retour sur l’onglet ou interaction. Le navigateur envoie un signal dédupliqué à `POST /auth/activity` sur le front, qui authentifie la session et relaie le signal vers `POST /api/users/me/activity`. Cette route isolée ne partage pas la file des actions métier et refuse les requêtes inter-origines. Les pages publiques et les rafraîchissements automatiques en arrière-plan ne produisent pas de signal. Une session déjà ouverte peut produire un signal sans nouvelle connexion.

L’API détermine l’identité et le mois Europe/Paris ; elle n’accepte pas une identité ou une catégorie choisie par le navigateur. En impersonation, seul l’agent réel est compté. Les visiteurs anonymes et les comptes de service sont exclus. La catégorie est celle du premier signal du mois : `ADMIN`/`INSTRUCTOR` pour l’administration, `DECLARANT` pour les préleveurs et collecteurs. Un utilisateur ne peut pas apparaître dans deux catégories le même mois.

`UserMonthlyActivity` conserve un marqueur unique `(month, userId)` et le rôle au premier signal. Les limites côté navigateur et le cache borné côté API évitent une écriture par requête ; l’unicité en base garantit la déduplication entre processus et requêtes concurrentes. Une erreur de collecte est journalisée sans bloquer le parcours métier. Cette mesure demeure une mesure des signaux reçus, pas une garantie de capture parfaite en cas d’indisponibilité réseau.

### Historique et transition

`UserActivityCollectionState`, clé `active-users`, contient la date du premier signal réellement reçu. La migration ne crée pas cette date artificiellement.

- **Avant la collecte** : les connexions réussies donnent uniquement une borne basse de l’activité. Les mois comportant ces preuves sont `partial`. Sans preuve d’activité, le mois est `unavailable` avec des valeurs `null`, jamais un zéro artificiel.
- **Mois de démarrage** : union des marqueurs et des connexions réussies, dédupliquée par utilisateur/mois. Le rôle du marqueur est prioritaire ; sinon celui de la dernière connexion du mois est utilisé. Le mois reste `partial`.
- **Mois suivants** : seuls les marqueurs sont comptés. Un mois terminé sans marqueur peut être présenté à zéro avec le statut `available`.

Les connexions historiques retenues sont les événements d’audit réussis `AUTH.LOGIN_VERIFIED`, `AUTH.PASSWORD_LOGIN_VERIFIED` et `AUTH.PASSWORD_ACTIVATED`, avec un utilisateur et un rôle humain. Les événements d’authentification plus anciens permettent d’indiquer le début connu de l’historique mais pas d’inventer un volume d’utilisateurs actifs. Les visites avec une session persistante avant la nouvelle collecte ne peuvent pas être reconstituées.

Le champ public `activeUsers` contient six mois (`administration`, `declarants`, `total`, `status`), `availableSince` et `collectionStartedAt`. Il n’expose aucun marqueur individuel. `availableSince` est le premier audit d’authentification connu ou le début de collecte s’il est antérieur. `collectionStartedAt` est `null` tant qu’aucun signal réel n’a initialisé la collecte.

L’ancien champ `connections` est conservé sans changement de calcul pour les consommateurs existants : connexions réussies, rôle de la dernière connexion du mois, premier mois d’audit partiel. Il ne doit pas être présenté comme une mesure complète d’usage réel.

## Cache, disponibilité et validation

- Cache API en mémoire par client de base et par mois, TTL d’une heure, maximum 24 entrées, mutualisation des calculs concurrents ; une erreur n’est pas conservée dans le cache.
- Réponse HTTP publique cachable cinq minutes. Les erreurs sont `no-store`. Le front revalide sa lecture chaque minute et refuse un instantané trop ancien (plus de 65 minutes).
- Aucun accès public ne requiert de compte privilégié : la requête ne retourne que les agrégats prévus. Les erreurs de calcul doivent rester des indisponibilités explicites, pas des statistiques nulles fabriquées.
- Les tests unitaires couvrent les périodes, les statuts historiques, le cache et la sérialisation. Les intégrations PostgreSQL/PostGIS vérifient les exclusions, sources API/campagne, chevauchements territoriaux, déduplications et transition vers les marqueurs d’activité.
- Les tests d’intégration exigent une base jetable explicitement autorisée (`PUBLIC_STATS_TEST_DATABASE_URL`, `NODE_ENV=test`) et annulent leurs fixtures par transaction. Ne jamais les exécuter sur une copie de données réelles.

Le déploiement exige la migration additive des tables d’activité avant l’API, puis le front. Les secrets et variables d’environnement existants ne sont pas modifiés.
