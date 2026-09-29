# Performance des recherches métier

## Objectifs

- `/api/declarants/search` : p95 API à chaud inférieur à 500 ms.
- Résultat perçu avec le debounce front : p95 inférieur à 800 ms.
- Gestion des associations d'un collecteur : p95 inférieur à 300 ms.
- Carte des points : réponse JSON compressée inférieure à 100 Kio.

Les mesures doivent couvrir au minimum un administrateur et un instructeur avec
un périmètre partiel. Les requêtes, identifiants et jetons ne doivent jamais être
écrits dans les journaux de performance.

## Benchmark HTTP en lecture seule

Le script ne réalise que des requêtes `GET`. Utiliser un jeton de courte durée et
ne jamais le placer dans l'historique du shell :

```bash
BENCHMARK_API_URL=https://api.example.test \
BENCHMARK_TOKEN="$TOKEN_TEMPORAIRE" \
BENCHMARK_ITERATIONS=12 \
BENCHMARK_CONCURRENCY=1 \
npm run benchmark:search
```

Rejouer ensuite avec une concurrence de 5, puis 10. Le résultat JSON expose les
p50/p95 globaux, le détail des phases `Server-Timing`, la taille logique, la
taille transférée lorsqu'elle est annoncée par le serveur et l'encodage HTTP.
Comparer le même commit et les mêmes scénarios entre testing et production.

## Indicateurs serveur

Les journaux `[API_PERF]` regroupent les phases applicatives, l'attente du pool,
la taille logique et les octets transférés. Les journaux `[DB_POOL_PERF]` ne
doivent apparaître que lorsqu'une acquisition dépasse le seuil configuré.

Activer sur PostgreSQL, pendant la phase d'observation :

- `pg_stat_statements` ;
- `track_io_timing` ;
- un seuil de requête lente de 500 ms en production ;
- un `application_name` distinct pour l'API et le worker.

## Cache API optionnel

Le cache reste désactivé tant que `SEARCH_CACHE_REDIS_URL` et un namespace
d'environnement ne sont pas tous les deux définis. Le namespace vient de
`SEARCH_CACHE_NAMESPACE`, ou de `APP_ENV` si cette variable existe réellement au
runtime. `NODE_ENV` n'est jamais utilisé car testing et production exécutent tous
deux Node en mode production. L'URL BullMQ n'est jamais reprise : deux URL qui
désignent le même hôte et le même port Redis sont refusées, même si leurs
credentials ou numéros de base diffèrent. Le certificat TLS éventuel vient
uniquement de `SEARCH_CACHE_REDIS_TLS_CA_FILE_PATH`.
Si une URL de cache est présente mais que ces garde-fous la refusent, l'API
continue sans cache et écrit une seule alerte non sensible, sans URL ni scope.

Deux corpus déclarants sont conservés par utilisateur et périmètre de droits :
un corpus léger pour l'affichage initial, puis un corpus enrichi partagé par
toutes les recherches non vides, quelle que soit la frappe. La recherche des
préleveurs d'un collecteur possède un corpus distinct pour chaque collecteur.
Les réponses finales des listes et leurs droits ne sont pas mises en cache.

La carte met en cache son résultat API déjà sérialisé. Sa clé comprend
l'utilisateur, son rôle, les zones où la carte est visible et les trois
périmètres qui contrôlent le détail, les exploitations et les déclarants. Ces
droits sont recalculés avant chaque lecture. Toutes ces valeurs sont hachées :
aucun identifiant d'utilisateur, de déclarant ou de zone n'apparaît dans une clé.

Le TTL vaut 30 secondes par défaut et reste borné entre 5 et 60 secondes. Un
corpus dépassant la limite configurée (5 Mio par défaut, 10 Mio au maximum)
n'est pas écrit. Un verrou Redis et un anti-double calcul local empêchent les
chargements simultanés du même corpus. Un follower attend au plus une seconde un
leader qui calcule déjà, mais rend dès que le corpus est disponible. En cas
d'indisponibilité Redis, PostgreSQL reste la source directe. Un échec ouvre un
circuit de 15 secondes par défaut, configurable entre 1 et 60 secondes, pour ne
pas repayer le timeout à chaque frappe ; ce mode est toujours compté comme un
cache miss.

Après le commit de chaque mutation HTTP réussie, une version globale sans donnée
métier est incrémentée avant que la réponse soit finalisée. Une requête lancée
après ce succès utilise donc une nouvelle clé. Les écritures réalisées directement
par les workers ne déclenchent pas cette invalidation HTTP ; le TTL borné
constitue alors la protection contre un résultat trop ancien. Si Redis est
indisponible au moment d'une invalidation, une entrée métier peut rester lisible
au plus jusqu'à ce TTL. Un changement de droits modifie toutefois immédiatement
le scope haché recalculé et ne réutilise pas l'ancien périmètre.

Les phases `search_cache_*`, `collector_cache_*` et `map_cache_*` apparaissent
dans `Server-Timing`. Aucune clé, requête, donnée ou valeur de périmètre n'est
écrite dans les journaux. Ce mécanisme concerne uniquement les données API :
aucun cache public n'est ajouté aux pages HTML ou RSC authentifiées.
