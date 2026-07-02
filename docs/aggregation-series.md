# Séries et agrégations

Les endpoints de séries utilisent les identifiants UUID actuels des points, préleveurs, déclarants et sources. Les anciens identifiants numériques ou ObjectId ne sont plus acceptés.

## Endpoints

- `GET /series` : recherche de métadonnées de séries.
- `GET /series/{seriesId}` : détail d'une série.
- `GET /series/{seriesId}/values` : valeurs d'une série.
- `GET /aggregated-series` : agrégation temporelle et/ou spatiale.
- `GET /aggregated-series/options` : options disponibles pour un périmètre donné.

## Paramètres de périmètre

Au moins un périmètre doit être fourni selon l'endpoint :

- `pointIds`
- `preleveurId`
- `collecteurId`
- `sourceId`

Les listes utilisent une séparation par virgule.

## Agrégation

Les paramètres attendus par l'agrégation sont :

- `metricTypeCode`
- `startDate`
- `endDate`
- `frequency`
- `operator` selon le type de métrique

Les volumes cumulatifs supportent la somme. Les débits et mesures instantanées supportent les opérateurs temporels adaptés (`mean`, `min`, `max` selon la configuration du paramètre).

## Tests associés

Les comportements d'agrégation sont couverts par :

- `lib/handlers/__tests__/series-aggregation.js`
- `lib/handlers/__tests__/series-aggregation-options.test.js`
- `lib/handlers/__tests__/series-aggregation-utils.js`
- `lib/models/__tests__/series.js`
