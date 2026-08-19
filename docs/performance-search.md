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

## Mesures de référence du 19 août 2026

Les mesures ci-dessous ont été réalisées en lecture seule sur les données de
production. Elles servent de point de comparaison ; elles ne constituent pas
une garantie de service avant une mesure depuis les conteneurs déployés.

### Liste des déclarants

| Mesure | Avant | Candidat optimisé |
| --- | ---: | ---: |
| Lignes d'exploitations remontées par la requête principale | 2 801 | 444 agrégats déclarants |
| Volume interne de cette requête | environ 1,67 Mo | 386 871 octets |
| Agrégat, p50 | environ 602 ms | 264 ms |
| Agrégat, p95 | non mesuré | 314 ms |
| Réponse compacte, 10 éléments | environ 70 Ko pour les éléments historiques | 7,8 Ko, soit 2,2 Ko gzip |

Sur une période calme, 15 appels séquentiels du candidat donnent un p95 de 426
ms sans recherche, 420 ms en recherche approximative et 418 ms en recherche
exacte. Un échantillon exact plus chargé porte toutefois le p95 combiné à
environ 582 ms. À concurrence 5, les lots prennent encore 0,97 à 1,37 seconde :
le cache conditionnel et les mesures après déploiement restent donc nécessaires
avant d'annoncer durablement un p95 inférieur à 500 ms.

### Associations d'un collecteur

Sur le plus gros périmètre observé (740 associations et 449 candidats), le
chargement passe de 16 à 3 requêtes SQL et de 6 985 à 742–1 190 lignes lues.

| Vue | p95 avant | p95 candidat |
| --- | ---: | ---: |
| Associations existantes | 204 ms | 152 ms |
| Exploitations disponibles | 211 ms | 142 ms |

### Carte et transport

- carte de 1 170 points : 1 265 070 octets logiques, 88 977 octets gzip (87 Kio) ;
- image API : environ 1,46 Go avant optimisation, 734 Mio pour le candidat ;
- les assets Next.js restent immuables et compressés ; les pages et flux RSC
  authentifiés restent dynamiques et sans cache partagé.
