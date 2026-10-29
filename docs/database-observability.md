# Observation et indexation PostgreSQL

Cette procédure s'applique à un environnement explicitement autorisé. L'accès
doit valider la base, le rôle, l'hôte natif et le certificat TLS avec les gardes
`scripts/network/*-database-target.js`. Une mesure sur testing ne constitue pas
une validation de capacité pour la production.

## Statistiques des requêtes

Sur testing, `pg_stat_statements` 1.11 est installé dans `public` depuis le
27 octobre 2026. Le module était déjà préchargé et collectait avant cette date :
ne pas considérer ses cumuls comme une mesure du seul déploiement courant.
Les paramètres restent `track=top`, `max=5000`, `track_planning=off`. Aucun rôle
supplémentaire n'a été accordé et aucun redémarrage n'a été nécessaire.

Pour un autre environnement, commencer par les lectures suivantes :

```sql
SELECT name, default_version, installed_version
FROM pg_available_extensions WHERE name = 'pg_stat_statements';
SELECT name, setting, context, pending_restart
FROM pg_settings
WHERE name LIKE 'pg_stat_statements.%'
   OR name IN ('compute_query_id', 'track_io_timing');
SELECT has_database_privilege(current_database(), 'CREATE'),
       has_parameter_privilege(current_user, 'track_io_timing', 'SET');
```

Après autorisation de l'installation, sur un client d'administration attesté,
créer l'extension et vérifier qu'elle fonctionne dans la même transaction :

```sql
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
CREATE EXTENSION pg_stat_statements;
SELECT count(*) FROM public.pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database());
COMMIT;
```

Si l'extension existe déjà, la vérifier sans la recréer. Si l'installation ou
la lecture échoue, faire `ROLLBACK` et instruire l'erreur ; ne pas modifier les
rôles ou redémarrer le serveur pour contourner ce blocage. Le retour arrière
d'une installation nouvelle est `DROP EXTENSION pg_stat_statements`, seulement
après vérification de l'absence de dépendances nouvelles, sans `CASCADE`.

Deux relevés horodatés permettent de calculer le nombre d'appels et le temps
d'exécution sur une fenêtre. Collecter les compteurs, pas les paramètres SQL :

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';
SELECT clock_timestamp() AS captured_at, dealloc, stats_reset
FROM public.pg_stat_statements_info;
SELECT userid, dbid, queryid::text, toplevel, calls,
       total_exec_time, min_exec_time, max_exec_time, mean_exec_time,
       rows, shared_blks_hit, shared_blks_read,
       temp_blks_read, temp_blks_written, wal_bytes,
       stats_since, minmax_stats_since
FROM public.pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
ORDER BY total_exec_time DESC;
COMMIT;
```

Conserver les mêmes clés `(userid, dbid, queryid, toplevel)` et contrôler les
dates de remise à zéro ainsi que les évictions avant de soustraire les
compteurs. Ne pas appeler `pg_stat_statements_reset` pour une mesure ordinaire.
Ces agrégats donnent des moyennes et maxima, pas un p95 des requêtes.

`track_io_timing` reste désactivé sur testing : le rôle actuel ne peut pas le
modifier, et le catalogue Scaleway PostgreSQL 17 ne propose pas ce réglage.
Les compteurs de blocs restent utilisables ; ne pas interpréter un temps
d'entrées-sorties nul comme une absence d'attente disque. Une activation
nécessite une option ou une habilitation explicitement prise en charge par
le fournisseur, sans contournement de privilèges.

## Application et infrastructure

L'API journalise déjà les requêtes d'au moins 1 000 ms sous `[API_PERF]` et les
attentes du pool d'au moins 100 ms sous `[DB_POOL_PERF]`. Les routes sont
normalisées ; les valeurs SQL, les paramètres HTTP et les identités ne doivent
pas être ajoutés à ces événements. `API_SLOW_REQUEST_MS` et
`DATABASE_POOL_SLOW_WAIT_MS` règlent les seuils. `API_PERF_LOG=1` journalise
toutes les requêtes et n'est pas nécessaire au suivi des requêtes lentes.

Les événements exposent la durée, le statut, les octets transférés, les phases
instrumentées et l'attente du pool. Les en-têtes `Server-Timing` complètent le
diagnostic navigateur. Les traces limitées aux requêtes lentes ne permettent
pas de calculer le p95 de toutes les requêtes.

Les métriques RDB se lisent dans Cockpit, en filtrant le projet et le
`resource_id` exacts. Pour les IOPS, sélectionner le disque de données
(`mounted_device!=""`) ; pour l'espace, `mountpoint="/data"`. Séparer les
imports, indexations et audits des usages ordinaires. Un jeton temporaire doit
avoir le seul scope `read_only_metrics`, rester en mémoire et être révoqué
dans un `finally`.

## Index de pagination des valeurs natives

La migration `20261027190000_add_native_value_pagination_index` contient une
seule instruction `CREATE INDEX CONCURRENTLY`. Prisma la lance sans bloc de
transaction explicite, comme les index concurrents déjà livrés. Ne pas
ajouter `BEGIN`, ni regrouper ce SQL avec une autre instruction de migration.

Avant le push autorisé, vérifier sur la cible :

- absence de migration inachevée ;
- index absent, ou présent avec la définition exacte, `indisvalid=true` et
  `indisready=true` ; `IF NOT EXISTS` ne valide pas un index existant ;
- aucune autre construction d'index et aucune transaction ancienne pouvant
  retenir son instantané ; identifier l'application avant toute annulation ;
- espace disponible pour l'index, le tri temporaire, le WAL et la marge de
  fonctionnement. L'estimation n'est pas une garantie de consommation.

Le migrateur privé borne l'ensemble de `prisma migrate deploy` à 1 140 s.
Suivre `pg_stat_progress_create_index`, `pg_stat_activity`, l'espace disponible
et la santé de l'API pendant cette étape. La construction concurrente laisse
les écritures ordinaires possibles, mais ajoute du travail disque et CPU.

Après succès, vérifier la définition et la validité dans `pg_index`, le ledger
Prisma, puis le plan et la durée d'une pagination bornée représentative.
Après échec ou délai dépassé, ne pas relancer aveuglément : le SQL peut avoir
laissé un index invalide, voire avoir terminé après une réponse perdue.
Vérifier d'abord l'absence de constructeur actif, l'état exact de l'index et
la migration en échec. La reprise nécessite une décision explicite :
supprimer **uniquement l'index invalide attendu** avec `DROP INDEX CONCURRENTLY`,
marquer cette migration comme annulée via `prisma migrate resolve --rolled-back`,
puis rejouer la CI ; ou, si l'index est intégralement valide et correspond au
SQL, résoudre la migration comme appliquée après contrôle. Ne jamais modifier
directement `_prisma_migrations` ni marquer un index invalide comme appliqué.
La CI exige aussi que `/status` du migrateur soit `idle` ou `succeeded` avant
une livraison. Après résolution du ledger, un redémarrage opérationnel
explicitement autorisé du seul migrateur, avec la même image et la même
configuration, peut être nécessaire pour effacer son ancien état mémoire
`failed` ou `unknown`. Ne pas relancer pendant une construction encore active.

## Résumés des valeurs et reprise de l'historique

`ChunkValueSummary` contient uniquement des faits calculés à partir des valeurs :
comptage exact, groupes `(métrique brute, unité, fréquence)` et bornes temporelles.
Les valeurs, leurs décimales et leur historique restent dans `ChunkValue`.
Les permissions, les statuts et les rattachements sont filtrés à chaque lecture.

Des triggers par instruction invalident les résumés dans la transaction de tout
INSERT, UPDATE, DELETE ou TRUNCATE des valeurs, y compris via SQL direct. La
finalisation des imports et calculs reconstruit les résumés concernés sous verrou.
Un résumé absent, invalide ou d'une autre version entraîne un calcul direct des
valeurs dans le même instantané SQL. Un GET n'écrit jamais dans le cache.
La migration ne parcourt pas l'historique : le remplissage est une opération
distincte, progressive, après livraison.

Sur une cible explicitement autorisée, avec `DATABASE_URL` injectée depuis le
gestionnaire de secrets, commencer par une simulation :

```sh
node scripts/backfill-chunk-value-summaries.js --environment testing
node scripts/backfill-chunk-value-summaries.js --environment testing --apply --batch-size 25 --max-batches 1000
```

La commande vérifie l'URL native, le certificat TLS, puis l'identité connectée.
Pour une connexion par tunnel, le wrapper d'exploitation doit effectuer ces
mêmes contrôles et peut appeler `backfillChunkValueSummaries` avec son client
attesté. Ne pas désactiver TLS ou modifier les gardes pour accepter localhost.
L'option `prod` existe pour une livraison ultérieure explicitement autorisée.

Chaque instruction SQL est limitée à 30 secondes, avec trois secondes d'attente de verrou.
Les progrès ne sont émis qu'après COMMIT ; une erreur annule le lot courant,
sans annuler ceux déjà terminés. `--after UUID` reprend après le dernier curseur
confirmé. Diminuer la taille des lots après un timeout ou un conflit de verrou,
puis reprendre. Ne jamais garder une transaction ouverte entre deux lots.

Rejouer ensuite sans curseur pour reprendre les éventuelles invalidations dues
aux imports concurrents. Le rapport final doit indiquer `remaining: 0` et
`complete: true`. Un second passage sans écriture concurrente doit produire
`refreshed: 0`. Un code de sortie 2 signifie que des résumés restent à traiter ;
ce n'est pas une validation complète. Conserver les rapports hors Git.

Vérifier après reprise les compteurs et options des mêmes dossiers, les plans
SQL (branche brute non exécutée avec un résumé valide), la pagination et les
durées. Les données brutes restent la référence et servent au contrôle exact.
La suppression des résumés rétablit les calculs directs ; elle n'est pas
nécessaire lors d'une simple invalidation.

Références : [pg_stat_statements PostgreSQL 17](https://www.postgresql.org/docs/17/pgstatstatements.html),
[CREATE INDEX PostgreSQL 17](https://www.postgresql.org/docs/17/sql-createindex.html),
[extensions Scaleway](https://www.scaleway.com/en/docs/managed-databases-for-postgresql-and-mysql/reference-content/postgresql-extensions/),
[paramètres d'instance Scaleway](https://www.scaleway.com/en/developers/api/managed-database-postgre-mysql/instance-settings).
