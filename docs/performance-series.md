# Performance du graphe des prélèvements

La vue graphique garde toute la période historique et les règles de calcul des
volumes, débits et index. Aucun cache de résultat ou précalcul persistant n'est
nécessaire à cette optimisation.

## Contrat compact

`GET /aggregated-series?view=chart` conserve les valeurs et les métadonnées du
graphe, notamment `exactVolumesEstimated`. La réponse ne contient ni
`metadata.points` ni `exactPeriods`. La présence de périodes exactes est vérifiée
sans charger leurs détails. Les index physiques gardent leur pagination,
leurs avertissements et leurs permissions administrateur.

`GET /aggregated-series/options?view=chart` conserve tous les paramètres
disponibles et omet `points`. Les options d'index par exploitation et de lecture
physique restent négociées par leurs paramètres existants. Sans `view`, les
deux routes conservent leur réponse détaillée.

Le front utilise une route GET authentifiée du même domaine, sans cache HTTP ni
jeton transmis au navigateur. Les requêtes commencent pendant le chargement du
composant graphique ; les requêtes HTTP obsolètes sont annulées et leurs réponses
ignorées. Cette annulation ne garantit pas l'interruption d'une requête SQL déjà
démarrée. Le zoom et les totaux sur une période sélectionnée gardent leurs règles.

## Calcul et droits

La sélection des séries réutilise les filtres de `listSeries` sans charger les
acteurs ou les résumés inutiles. Le nombre de séries conserve sa définition :
groupes de chunk, métrique brute, unité et fréquence.

Les volumes `sum/sum` sont répartis directement sur la maille demandée au prorata
de l'intersection entre période source, période sélectionnée et maille. Le
dénominateur reste la durée source complète. Le calendrier Paris des publications
METER, les dates historiques ordinaires, les droits des bénéficiaires et
l'exclusion des sources incomplètes ou des chunks rejetés restent inchangés.
Les débits, moyennes et dédoublonnages d'index conservent le chemin quotidien.

Les phases `aggregation_resolve`, `aggregation_scope`,
`aggregation_series_scope`, `aggregation_values`, `aggregation_exact_exists`
(ou `aggregation_exact_periods` sans vue compacte) complètent les phases
`aggregation_options_*` existantes dans `Server-Timing` et les journaux de
performance. Ne pas journaliser les identifiants ou valeurs des paramètres.

## Benchmark reproductible

Le script crée puis supprime uniquement ses fixtures synthétiques. Il refuse
toute base applicative grâce à `requireDisposableDatabase`. Préparer une base
PostGIS jetable avec les migrations du dépôt, sur le port local **55439** ;
aucune option de connexion n'est autorisée dans l'URL.

```sh
NODE_ENV=test \
DATABASE_URL=postgresql://security_tests:security_tests_only@127.0.0.1:55439/security_tests \
npm run benchmark:series
```

Par défaut : 1 000 puis 10 000 points, trois ans de volumes annuels ordinaires et
mensuels METER, plus des débits mensuels ; cinq passages avec une puis cinq
consultations simultanées. La projection comporte 36 valeurs mensuelles par
mesure. Les totaux et débits synthétiques sont vérifiés à chaque passage.

Variables facultatives : `SERIES_BENCH_POINTS`, `SERIES_BENCH_CONCURRENCY`
(listes séparées par virgules), `SERIES_BENCH_ITERATIONS`,
`SERIES_BENCH_VIEW=legacy` et `SERIES_BENCH_REPOSITORY` (checkout local de
référence avec les mêmes dépendances et le même schéma).

Les lignes JSON distinguent le premier appel et les p50/p95 suivants, le calcul
des options/volumes/débits, et les tailles JSON/gzip. Le temps total comprend
l'enchaînement options puis volume et débit en parallèle, la sérialisation et la
compression de mesure. Il s'agit des handlers sur PostgreSQL local, **sans HTTP,
middleware d'authentification ni rendu navigateur**. Le premier appel n'est pas
une mesure de cache disque froid : la génération et l'analyse des fixtures
viennent de s'exécuter. Exécuter les références et les changements sur la même
machine, sans build ou autre benchmark simultané.

La cible de deux secondes pour un premier graphe exploitable reste à vérifier
sur l'environnement servi ; les mesures locales de calcul ne suffisent pas à
prouver le délai de bout en bout en testing.

### Comparaison locale du 29 septembre 2026

Référence : commit API `0d24845`. Node 24.21.0, PostgreSQL/PostGIS 17-3.5 jetable,
pool de cinq connexions, aucun cache de résultat. Même script et même profil de
données pour les deux versions. Les durées suivantes sont les p95 des cinq
passages (25 consultations pour la concurrence de cinq), en millisecondes.

| Points | Consultations simultanées | Avant | Vue optimisée |
| ---: | ---: | ---: | ---: |
| 1 000 | 1 | 856 | 172 |
| 1 000 | 5 | 1 693 | 252 |
| 10 000 | 1 | 14 666 | 1 725 |
| 10 000 | 5 | 23 117 | 2 330 |

À 10 000 points, options et deux courbes passent ensemble de 52 121 351 à
4 620 octets JSON (8 661 864 à 1 289 octets gzip). Les 36 valeurs par courbe et
les totaux sont conservés ; les 180 000 périodes METER détaillées et les listes
de points ne sont plus transférées au graphe. Le premier appel de cette vue
optimisée prend 1 986 ms, dans les limites de mesure décrites ci-dessus.
