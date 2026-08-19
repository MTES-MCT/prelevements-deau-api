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
p50/p95 globaux, le temps interne `Server-Timing`, la taille logique et
l'encodage HTTP. Comparer le même commit et les mêmes scénarios entre testing et
production.

## Indicateurs serveur

Les journaux `[API_PERF]` regroupent les phases applicatives, l'attente du pool,
la taille logique et les octets transférés. Les journaux `[DB_POOL_PERF]` ne
doivent apparaître que lorsqu'une acquisition dépasse le seuil configuré.

Activer sur PostgreSQL, pendant la phase d'observation :

- `pg_stat_statements` ;
- `track_io_timing` ;
- un seuil de requête lente de 500 ms en production ;
- un `application_name` distinct pour l'API et le worker.

## Décisions après mesure

1. Corriger d'abord les agrégations SQL, les DTO et la compression.
2. Benchmarker une instance PostgreSQL génération 2 de 4 Go avec le même stockage.
3. Migrer si le benchmark représentatif confirme au moins 25 % de gain.
4. N'ajouter un cache que si le p95 recherche reste supérieur à 500 ms ou si la
   carte reste supérieure à 800 ms.

Si ce cache devient nécessaire, il doit utiliser une instance Redis séparée de
BullMQ, un périmètre de droits dans chaque clé, une invalidation après commit, un
anti-double calcul et un TTL de secours de 30 secondes. Les pages HTML/RSC
authentifiées ne doivent jamais être mises en cache publiquement.
