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
- `pointFlowType` (optionnel : `PRELEVEMENT` ou `REJET`)
- `startDate`
- `endDate`
- `aggregationFrequency`
- `spatialOperator` et `temporalOperator` selon le type de métrique

Les volumes cumulatifs supportent la somme. Les débits et mesures instantanées supportent les opérateurs temporels adaptés (`mean`, `min`, `max` selon la configuration du paramètre).

Les fréquences d'affichage disponibles sont `15 minutes`, `1 hour`, `6 hours`, `1 day`, `1 week`, `1 month`, `1 quarter` et `1 year`. La fréquence hebdomadaire utilise les semaines ISO.

### Répartition des valeurs cumulatives

`GET /aggregated-series` répartit uniformément chaque valeur cumulative sur sa période source semi-ouverte `[periodStart, periodEnd)`, avant de l'agréger au pas demandé. La contribution d'une journée correspond à :

```text
valeur déclarée × durée de chevauchement avec la journée / durée totale déclarée
```

La fenêtre demandée est elle aussi semi-ouverte : `[startDate, endDate + 1 jour)`. Une période source qui chevauche cette fenêtre est retenue, puis seules ses contributions comprises dans la fenêtre sont retournées. Le dénominateur reste la durée source complète : une fenêtre partielle ne renormalise donc jamais le volume.

Cette répartition sert uniquement à la visualisation. Elle ne modifie ni la valeur ni la période enregistrées. Les mesures instantanées, notamment les index et les débits, conservent leur traitement existant.

La réponse expose systématiquement le mode dans `metadata.distribution` :

```json
{
  "applied": true,
  "method": "uniform-over-period",
  "purpose": "display"
}
```

`applied` vaut `false` pour une mesure instantanée.

## Tests associés

Les comportements d'agrégation sont couverts par :

- `lib/handlers/__tests__/series-aggregation.js`
- `lib/handlers/__tests__/series-aggregation-options.test.js`
- `lib/handlers/__tests__/series-aggregation-utils.js`
- `lib/models/__tests__/series.js`
