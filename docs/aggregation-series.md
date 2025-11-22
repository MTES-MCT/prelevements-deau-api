# Système d'Agrégation des Séries Temporelles

## Vue d'ensemble

Le système d'agrégation permet de combiner des données de prélèvements provenant de plusieurs points et/ou périodes de temps. Il offre une API flexible pour analyser les volumes prélevés et autres paramètres selon différentes granularités temporelles.

## Routes API

### Route principale : Agrégation de séries

```
GET /aggregated-series
```

**Restriction** : Route réservée aux administrateurs uniquement.

Cette route permet d'agréger les données de séries temporelles selon différentes modalités spatiales et temporelles.

### Route de découverte : Options disponibles

```
GET /aggregated-series/options
```

**Restriction** : Route réservée aux administrateurs uniquement.

Cette route complémentaire permet de **découvrir quelles données sont disponibles** avant d'effectuer une agrégation. Elle retourne :
- La liste des **paramètres disponibles** pour le ciblage donné (préleveur et/ou points)
- Les **plages de dates** (min/max) pour chaque paramètre, basées sur les données réellement intégrées
- Les **métadonnées** de chaque paramètre (type, unité, nombre de séries)
- La liste des **points résolus**

**Cas d'usage** :
- Pré-remplir un formulaire avec les options disponibles côté frontend
- Valider que des données existent avant de lancer une agrégation
- Découvrir quels paramètres sont mesurés sur un ensemble de points

**Exemple de requête** :
```bash
GET /aggregated-series/options?preleveurId=42
```

**Exemple de réponse** :
```json
{
  "parameters": [
    {
      "name": "volume prélevé",
      "unit": "m³",
      "valueType": "cumulative",
      "spatialOperators": ["sum"],
      "temporalOperators": ["sum"],
      "defaultSpatialOperator": "sum",
      "defaultTemporalOperator": "sum",
      "hasTemporalOverlap": false,
      "minDate": "2023-01-01",
      "maxDate": "2024-12-31",
      "seriesCount": 5
    },
    {
      "name": "débit prélevé",
      "unit": "L/s",
      "valueType": "instantaneous",
      "spatialOperators": ["sum"],
      "temporalOperators": ["mean", "min", "max"],
      "defaultSpatialOperator": "sum",
      "defaultTemporalOperator": "mean",
      "hasTemporalOverlap": true,
      "minDate": "2023-01-01",
      "maxDate": "2024-12-31",
      "seriesCount": 3
    }
  ],
  "points": [
    {
      "_id": "507f1f77bcf86cd799439011",
      "id_point": 207,
      "nom": "Captage Ruban"
    }
  ]
}
```

**Champ `hasTemporalOverlap`** : Indique si plusieurs séries du paramètre ont des données simultanées (plusieurs préleveurs actifs en même temps). Si `true` et que le paramètre ne supporte pas `sum` en spatial (température, chimie, piézométrie), une erreur 400 sera retournée lors de l'agrégation.

**Note importante** : Cette route ne récupère que les séries avec des données intégrées (`computed.integratedDays`). Les dates retournées correspondent aux dates réellement consolidées dans le système.

**Fail-fast sur overlap** : Si plusieurs séries d'un même paramètre ont des périodes qui se chevauchent (plusieurs préleveurs actifs simultanément) ET que le paramètre ne supporte pas `sum` en spatial (température, chimie, piézométrie), une erreur 400 est retournée. Ces paramètres ne peuvent être agrégés que temporellement, pas spatialement.

## Agrégation spatiale vs temporelle

Le système distingue **deux types d'agrégation** avec des opérateurs différents :

### Agrégation spatiale (multi-points)

Combine les valeurs de **plusieurs points à un même instant** (phase 6 du traitement).

**Exemple** : Débit total d'une installation avec 3 captages
- Point A : 10 L/s
- Point B : 15 L/s
- Point C : 12 L/s
- **Résultat spatial** : 37 L/s (sum)

**Opérateurs autorisés selon le paramètre** :
- **Volumes et débits** : `sum` uniquement (agrégation spatiale cohérente)
- **Autres paramètres** (température, chimie, piézométrie) : **aucun opérateur spatial** (pas d'agrégation possible si overlap temporel)

### Agrégation temporelle

Combine les valeurs d'une **même série sur plusieurs périodes** (phase 7 du traitement).

**Exemple** : Débit moyen mensuel à partir de valeurs journalières
- Jour 1 : 10 L/s
- Jour 2 : 12 L/s
- Jour 3 : 11 L/s
- **Résultat temporal** : 11 L/s (mean)

**Opérateurs autorisés selon le paramètre** :
- **Volumes** : `sum` (cumul de la période)
- **Débits** : `mean`, `min`, `max` uniquement (pas de sum)
- **Autres paramètres** : `mean`, `min`, `max` uniquement

**Note importante** : La somme (`sum`) sur des débits n'a pas de sens temporellement (on ne peut pas additionner des débits dans le temps), mais elle est valide spatialement (débit total de plusieurs points).

## Modes d'utilisation

Le système propose **3 modes d'opération** distincts :

### Mode 1 : Liste explicite de points (`pointIds`)

Agrégation sur une liste définie de points de prélèvement.

```bash
GET /aggregated-series?pointIds=207,208,209&parameter=volume prélevé&spatialOperator=sum&temporalOperator=sum&aggregationFrequency=1 month
```

**Cas d'usage** : Analyse d'un groupe spécifique de points (zone géographique, type d'ouvrage, etc.)

### Mode 2 : Tous les points d'un préleveur (`preleveurId`)

Agrégation sur l'ensemble des points exploités par un préleveur.

```bash
GET /aggregated-series?preleveurId=42&parameter=volume prélevé&spatialOperator=sum&temporalOperator=sum&aggregationFrequency=1 month
```

**Cas d'usage** : Bilan global d'un préleveur, suivi de sa consommation totale.

### Mode 3 : Filtrage combiné (`preleveurId` + `pointIds`)

Agrégation sur un sous-ensemble des points d'un préleveur.

```bash
GET /aggregated-series?preleveurId=42&pointIds=207,208&parameter=volume prélevé&spatialOperator=sum&temporalOperator=sum&aggregationFrequency=1 month
```

**Cas d'usage** : Analyse d'une partie des installations d'un préleveur (ex : uniquement les captages en nappe).

## Support des identifiants

Le système accepte **deux formats d'identifiants** :

### 1. Identifiants numériques séquentiels
Format historique basé sur `id_point` et `id_preleveur`.

```bash
pointIds=207,208,209
preleveurId=42
```

### 2. MongoDB ObjectIds
Format natif de la base de données (24 caractères hexadécimaux).

```bash
pointIds=507f1f77bcf86cd799439011,507f191e810c19729de860ea
preleveurId=507f1f77bcf86cd799439022
```

### 3. Format mixte
Combinaison des deux formats dans une même requête.

```bash
pointIds=207,507f1f77bcf86cd799439011,209
```

**Validation** : Un pattern regex strict garantit que seuls les formats valides sont acceptés :
- Numérique : `\d+`
- ObjectId : `[\da-fA-F]{24}` (exactement 24 caractères hexadécimaux)

## Paramètres de la requête

### Paramètres obligatoires

| Paramètre | Type | Description |
|-----------|------|-------------|
| `pointIds` OU `preleveurId` | string / number | Au moins un des deux doit être fourni |
| `parameter` | string | Nom du paramètre (ex: "volume prélevé", "débit") |
| `aggregationFrequency` | string | Fréquence d'agrégation temporelle |

### Fréquences d'agrégation disponibles

**Infra-journalières** (séries brutes) :
- `15 minutes` : Agrégation par tranches de 15 minutes
- `1 hour` : Agrégation horaire
- `6 hours` : Agrégation par tranches de 6 heures

**Journalières et supérieures** :
- `1 day` : Valeurs quotidiennes (pas d'agrégation temporelle)
- `1 month` : Agrégation mensuelle
- `1 quarter` : Agrégation trimestrielle
- `1 year` : Agrégation annuelle

### Paramètres optionnels

| Paramètre | Type | Description | Défaut |
|-----------|------|-------------|--------|
| `spatialOperator` | string | Opérateur d'agrégation spatiale (sum uniquement pour volumes/débits) | Défini par le paramètre* |
| `temporalOperator` | string | Opérateur d'agrégation temporelle (sum, mean, min, max) | Défini par le paramètre* |
| `startDate` | string | Date de début (YYYY-MM-DD) | Toutes les données |
| `endDate` | string | Date de fin (YYYY-MM-DD) | Toutes les données |

\* *Opérateurs par défaut selon le paramètre (ex: sum/sum pour "volume prélevé", sum/mean pour "débit prélevé").*

**Note** : La validation vérifie que chaque opérateur est autorisé dans son contexte (spatial vs temporal).

## Architecture du code

### Fichier principal : `lib/handlers/series-aggregation.js`

Handler pour l'agrégation de séries temporelles.

```
validateQueryParams()           → Validation Joi des paramètres
  ├─ Accepte pointIds OU preleveurId (ou les deux)
  └─ Valide les formats d'identifiants (numériques + ObjectId)

resolvePointsForAggregation()   → Résolution des points selon le mode
  ├─ Mode 1: resolvePointIds()
  ├─ Mode 2: resolvePreleveurPoints()
  └─ Mode 3: Filtrage combiné

listSeries()                    → Récupération des séries MongoDB (appel direct avec pointIds)

fetchAllSeriesValues()          → Récupération des valeurs
  ├─ Détection séries infra-journalières
  └─ Choix entre valeurs brutes ou dailyAggregates

aggregateValuesByDate()         → Agrégation spatiale (multi-points)
  ├─ extractValuesFromDocument() pour chaque série
  └─ applyAggregationOperator() par période

aggregateValuesByPeriod()       → Agrégation temporelle (mois/année)
  ├─ extractPeriod() : extraction de la période
  └─ applyAggregationOperator() par période

buildAggregationMetadata()      → Construction des métadonnées de réponse
```

### Fichier de découverte : `lib/handlers/series-aggregation-options.js`

Handler pour la récupération des options disponibles.

```
validateQueryParams()                      → Validation Joi des paramètres
  ├─ Accepte pointIds OU preleveurId (ou les deux)
  └─ Valide les formats d'identifiants (numériques + ObjectId)

resolvePointsForAggregation()              → Résolution des points (réutilisé)
  └─ Importé depuis series-aggregation.js

listSeries()                               → Récupération des séries MongoDB
  └─ Avec onlyIntegratedDays=true pour ne récupérer que les séries intégrées

calculateDateRangeFromIntegratedDays()     → Calcul des dates min/max
  └─ Parcourt computed.integratedDays de toutes les séries

groupSeriesByParameter()                   → Groupement par paramètre
  ├─ Crée un Map de séries par paramètre
  ├─ Filtre les paramètres non supportés
  ├─ Enrichit avec les métadonnées de parametersConfig
  └─ Retourne la liste triée par nom de paramètre

getAggregatedSeriesOptionsHandler()        → Handler principal
  └─ Retourne {parameters: [...], points: [...]}
```

**Fonction exportée** :
- `calculateDateRangeFromIntegratedDays(series)` : Exportée pour les tests unitaires

**Réutilisation** : Le handler réutilise `resolvePointsForAggregation()` du fichier principal pour garantir une cohérence dans la résolution des points entre les deux endpoints.

### Fonctions utilitaires

#### Détection et résolution des identifiants

```javascript
isObjectId(id)
// Détecte si un identifiant est un ObjectId MongoDB valide
// Retourne: boolean

resolvePointById(pointId, territoire)
// Résout un ID (numérique ou ObjectId) vers un objet point
// Retourne: Promise<Object|null>

resolvePreleveurById(preleveurId, territoire)
// Résout un ID (numérique ou ObjectId) vers un objet préleveur
// Retourne: Promise<Object|null>
```

#### Résolution de points

```javascript
resolvePointIds(pointIds, territoire)
// Résout une liste d'IDs vers des points
// Retourne: Promise<{found: Array, notFound: Array}>

resolvePreleveurPoints(preleveurId, territoire)
// Récupère tous les points d'un préleveur
// Retourne: Promise<{found: Array, notFound: Array}>
```

#### Extraction et agrégation

```javascript
extractPeriod(date, frequency)
// Extrait la période (mois, trimestre ou année) d'une date
// '2024-01-15', '1 month'   → '2024-01'
// '2024-01-15', '1 quarter' → '2024-Q1'
// '2024-01-15', '1 year'    → '2024'

extractSubDailyPeriod(date, time, frequency)
// Extrait la période infra-journalière
// '2024-01-15', '12:07', '15 minutes' → '2024-01-15 12:00'
// '2024-01-15', '12:30', '1 hour'     → '2024-01-15 12:00'

extractValuesFromDocument(valueDoc, context)
// Extrait les valeurs d'un document selon le type de série
// Gère séries journalières, infra-journalières, et dailyAggregates

applyAggregationOperator(values, operator)
// Applique sum, mean, min ou max sur un tableau de valeurs
// Filtre automatiquement les valeurs invalides (null, NaN, Infinity)

aggregateValuesByPeriod(dailyValues, frequency, operator)
// Agrège des valeurs journalières par mois, trimestre ou année
```

## Optimisation : dailyAggregates

Pour les séries infra-journalières, le système peut utiliser des **agrégats quotidiens pré-calculés** au lieu de récupérer toutes les valeurs brutes.

### Structure des dailyAggregates

```javascript
{
  date: '2024-01-15',
  dailyAggregates: {
    sum: 1250.5,    // Somme des valeurs de la journée
    mean: 52.1,     // Moyenne des valeurs
    min: 10.2,      // Valeur minimale
    max: 98.7,      // Valeur maximale
    count: 24       // Nombre de valeurs
  }
}
```

### Logique d'utilisation

```javascript
// Utilise dailyAggregates SI :
// 1. La série est infra-journalière (frequency !== '1 day')
// 2. La fréquence d'agrégation n'est PAS infra-journalière
//    (pas '15 minutes', '1 hour', '6 hours')

const needsRawValues = ['15 minutes', '1 hour', '6 hours'].includes(aggregationFrequency)
const useAggregates = hasSubDailySeries && !needsRawValues
```

**Principe** : Les `dailyAggregates` contiennent les valeurs pré-calculées pour tous les opérateurs (sum, mean, min, max). Dès que la fréquence d'agrégation est >= 1 jour, le système utilise ces agrégats au lieu de charger toutes les valeurs brutes infra-journalières.

**Avantage** : Performance significativement améliorée pour les agrégations mensuelles ou annuelles sur des séries à haute fréquence (ex: mesures toutes les 15 minutes).

**Exemple** :
- Agrégation mensuelle de débits mesurés toutes les 15 minutes → utilise `dailyAggregates.mean`
- Agrégation annuelle de volumes → utilise `dailyAggregates.sum`
- Agrégation horaire de niveaux → charge les valeurs brutes pour calculer les moyennes horaires

## Gestion des erreurs

### Validation des paramètres (400)

```json
{
  "code": 400,
  "message": "Le paramètre pointIds doit être une liste d'identifiants (numériques ou ObjectId) séparés par des virgules"
}
```

**Causes** :
- Format d'identifiants invalide
- Ni pointIds ni preleveurId fourni
- Dates invalides (format ou chronologie)
- Paramètre non supporté

### Paramètre non éligible (400)

**Cause** : Le paramètre demandé a des séries avec overlap temporel (plusieurs préleveurs actifs en même temps) et ne supporte pas l'agrégation spatiale. L'agrégation spatiale n'a pas de sens métier pour ce paramètre.

**Solution** : Utiliser `/aggregated-series/options` pour obtenir uniquement les paramètres éligibles.

**Note** : Le message d'erreur exact est généré dynamiquement par le code selon le contexte.

### Accès non autorisé (403)

```json
{
  "code": 403,
  "message": "Accès non autorisé"
}
```

**Cause** : Utilisateur sans privilèges administrateur.

### Ressources introuvables (404)

```json
{
  "code": 404,
  "message": "Aucun point trouvé avec les identifiants: 999"
}
```

**Causes** :
- Points inexistants
- Préleveur inexistant
- Aucune série disponible pour les critères donnés

## Format de réponse

### Structure générale

```json
{
  "metadata": {
    "parameter": "volume prélevé",
    "unit": "m³",
    "spatialOperator": "sum",
    "temporalOperator": "sum",
    "frequency": "1 month",
    "startDate": "2024-01-01",
    "endDate": "2024-12-31",
    "points": [
      {
        "_id": "507f1f77bcf86cd799439011",
        "id_point": 207,
        "nom": "Captage Ruban"
      }
    ],
    "pointsNotFound": [],
    "usesDailyAggregates": false,
    "minDate": "2024-01",
    "maxDate": "2024-12",
    "seriesCount": 5,
    "valuesCount": 1250
  },
  "values": [
    {
      "date": "2024-01",
      "value": 1250.5
    },
    {
      "date": "2024-02",
      "value": 980.3
    }
  ]
}
```

### Métadonnées spécifiques au mode préleveur

Lorsque `preleveurId` est utilisé :

```json
{
  "metadata": {
    "preleveurId": 42,
    "preleveur": {
      "_id": "507f1f77bcf86cd799439011",
      "nom": "Dupont",
      "raison_sociale": "EARL Dupont"
    },
    "points": [...]
  }
}
```

### Cas particuliers

**Aucune donnée disponible** :

```json
{
  "metadata": {...},
  "data": []
}
```

**Points non trouvés** (mode 1 ou 3) :

```json
{
  "metadata": {
    "pointsNotFound": [999, "507f1f77bcf86cd799439099"],
    ...
  }
}
```

## Configuration des paramètres

Les paramètres supportés sont définis dans `lib/parameters-config.js`.

**Structure de configuration** :
- `valueType` : `'cumulative'` (incréments) ou `'instantaneous'` (valeurs ponctuelles)
- `spatialOperators` : Liste des opérateurs spatiaux autorisés (`['sum']` ou `[]`)
- `temporalOperators` : Liste des opérateurs temporels autorisés
- `defaultSpatialOperator` : Opérateur spatial par défaut (`'sum'` ou `null`)
- `defaultTemporalOperator` : Opérateur temporel par défaut
- `unit` : Unité de mesure
- `warning` : Avertissement optionnel (ex: pH avec échelle logarithmique)

**Catégories** :
- **Volumes** : `spatialOperators: ['sum']`, `temporalOperators: ['sum']`
- **Débits** : `spatialOperators: ['sum']`, `temporalOperators: ['mean', 'min', 'max']`
- **Autres paramètres** : `spatialOperators: []`, `temporalOperators: ['mean', 'min', 'max']`

### Ajout d'un nouveau paramètre

1. Ajouter la configuration dans `lib/parameters-config.js` en suivant la structure documentée ci-dessus
2. Appliquer les règles métier :
   - **Volumes et débits** : `spatialOperators: ['sum']` (agrégation cohérente)
   - **Autres paramètres** : `spatialOperators: []` (pas d'agrégation spatiale)
3. Vérifier que les tests passent : `npm test`

**Comportement** :
- **Séries avec overlap** : Erreur 400 si paramètre sans opérateurs spatiaux
- **Séries consécutives** : Concaténation automatique sans erreur

## Cas d'usage avancés

### Analyse d'un bassin versant

Obtenir les prélèvements totaux mensuels de tous les points d'un bassin :

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:5000/aggregated-series?\
pointIds=207,208,209,210,211&\
parameter=volume%20prélevé&\
spatialOperator=sum&\
temporalOperator=sum&\
aggregationFrequency=1%20month&\
startDate=2024-01-01&\
endDate=2024-12-31"
```

### Suivi multi-préleveurs

Comparer les consommations de plusieurs préleveurs (requêtes séparées) :

```bash
# Préleveur A
curl ... "?preleveurId=42&parameter=volume prélevé&spatialOperator=sum&temporalOperator=sum&..."

# Préleveur B
curl ... "?preleveurId=43&parameter=volume prélevé&spatialOperator=sum&temporalOperator=sum&..."
```

### Analyse de débit : total spatial, moyenne temporelle

Obtenir le débit total d'une installation (somme spatiale) avec moyennes mensuelles (temporelle) :

```bash
curl ... "?pointIds=207,208,209&parameter=débit%20prélevé&\
spatialOperator=sum&\
temporalOperator=mean&\
aggregationFrequency=1%20month&startDate=2024-01-01&endDate=2024-12-31"
```

### Analyse horaire fine

Observer les variations horaires de débit sur un point (pas d'agrégation spatiale) :

```bash
curl ... "?pointIds=207&parameter=débit%20prélevé&\
temporalOperator=mean&\
aggregationFrequency=1%20hour&startDate=2024-06-15&endDate=2024-06-15"
```

## Performance et limitations

### Optimisations appliquées

1. **Parallélisation** : Récupération des séries et valeurs en parallèle
2. **dailyAggregates** : Évite de charger toutes les valeurs infra-journalières
3. **Index MongoDB** : Sur `seriesId` et `date` dans `series_values`

### Limites actuelles

- **Pas de pagination** : Toutes les valeurs agrégées sont retournées d'un coup
- **Mémoire** : Agrégation en mémoire, limite pratique ~100k valeurs
- **Pas de cache** : Chaque requête recalcule l'agrégation

### Recommandations

- Utiliser des plages de dates raisonnables
- Préférer les fréquences d'agrégation élevées (mensuel, annuel) pour de longues périodes
- Pour des analyses sur plusieurs années, utiliser `1 year` plutôt que `1 day`

## Évolutions futures possibles

### Court terme
- [ ] Pagination des résultats pour grandes plages
- [ ] Cache Redis pour requêtes fréquentes
- [ ] Export CSV/Excel des résultats

### Moyen terme
- [ ] Agrégation multi-préleveurs en une seule requête
- [ ] Comparaisons temporelles (année N vs année N-1)
- [ ] Alertes sur dépassements de seuils

### Long terme
- [ ] Pré-calcul des agrégations courantes
- [ ] Visualisations graphiques intégrées
- [ ] API GraphQL pour requêtes complexes

## Dépannage

### Erreur : "Aucune série trouvée"

**Causes possibles** :
- Points sans données dans la période demandée
- Paramètre mal orthographié (sensible à la casse)
- Données non consolidées

**Solution** :
```bash
# Vérifier les séries disponibles
GET /series?pointId=207&parameter=volume%20prélevé
```

### Erreur : "Points non trouvés"

**Causes** :
- IDs invalides ou inexistants
- Points supprimés du référentiel

**Solution** :
```bash
# Vérifier l'existence du point
GET /points-prelevement/207
```

### Performances dégradées

**Symptômes** : Temps de réponse > 5 secondes

**Diagnostics** :
1. Vérifier le nombre de séries (`seriesCount` dans metadata)
2. Vérifier le nombre de valeurs (`valuesCount`)
3. Tester avec `aggregationFrequency=1 year` pour réduire la granularité

**Solution** : Réduire la plage de dates ou utiliser une fréquence plus large.
