# Traitement des attachments

Ce module gère le traitement des pièces jointes issues de Démarches Simplifiées.

## Pipeline de traitement

Le traitement d'un attachment suit ces étapes :

### 1. Extraction et validation

Via le package `@fabnum/prelevements-deau-timeseries-parsers` :
- Extraction des séries temporelles depuis les fichiers Excel
- Validation des structures, formats et cohérence des données
- Production d'une liste d'erreurs et avertissements

Voir [documentation de validation](../../../packages/timeseries-parsers/docs/validation.md) pour les détails.

### 2. Normalisation des séries (`normalize.js`)

Après l'extraction, les séries temporelles sont normalisées pour garantir leur cohérence et leur exploitabilité.

#### 2.1 Expansion des données cumulatives

Les valeurs cumulatives supra-journalières (mensuelles, trimestrielles, annuelles) pour les paramètres de type "cumulative" (volumes prélevés) sont réparties au prorata sur les jours de la période.

**Exemple** :
- Volume mensuel : 3100 m³ pour janvier (31 jours)
- Expansion : 31 valeurs journalières de 100 m³ chacune

#### 2.2 Conversion d'unités

Les valeurs sont converties vers l'unité de référence du paramètre :
- Débits : m³/h → L/s (division par 3.6)
- Autres paramètres : selon configuration dans `parameters-config.js`

Les valeurs originales et unités sont préservées dans les métadonnées (`originalValue`, `originalUnit`).

#### 2.3 Filtrage des valeurs invalides

Les valeurs qui ne respectent pas les contraintes du paramètre sont **filtrées** :
- Débits négatifs
- Valeurs hors bornes (min/max définis dans `timeseries-parsers`)
- Valeurs non numériques (NaN, Infinity)

**Comportement** :
- Si **toutes** les valeurs d'une série sont invalides → série entière rejetée
- Si **certaines** valeurs sont invalides → seules ces valeurs sont filtrées
- Les dates min/max de la série sont recalculées après filtrage

#### 2.4 Agrégation des débits

Les séries de débit (`débit prélevé`, `débit restitué`, `débit réservé`) concernant le **même point de prélèvement** sont automatiquement agrégées par **somme**.

**Critère de groupement** : `pointPrelevement` + `parameter` + `frequency` + `unit`

**Règle critique** : Un point temporel n'est conservé **que si toutes les sources ont une valeur valide** à cet instant.

**Justification** : Cette règle évite de sous-estimer le débit total d'une installation. Si une installation a N captages, on ne peut affirmer le débit total que si on a les N mesures simultanées.

**Exemple concret** :
```javascript
// Série 1 (captage A)
[
  {date: '2025-08-01', time: '10:00', value: 50},  // Valide
  {date: '2025-08-01', time: '11:00', value: -10}, // Invalide (filtré)
  {date: '2025-08-01', time: '12:00', value: 55}   // Valide
]

// Série 2 (captage B)
[
  {date: '2025-08-01', time: '10:00', value: 60},  // Valide
  {date: '2025-08-01', time: '11:00', value: 62},  // Valide
  {date: '2025-08-01', time: '12:00', value: 65}   // Valide
]

// Série agrégée (résultat)
[
  {date: '2025-08-01', time: '10:00', value: 110, sources: [{originalValue: 50}, {originalValue: 60}]},
  // 11:00 ABSENT (captage A invalide)
  {date: '2025-08-01', time: '12:00', value: 120, sources: [{originalValue: 55}, {originalValue: 65}]}
]
```

**Impact** : Cette règle peut réduire significativement le nombre de points si les sources ont des défaillances décalées. C'est un choix conservateur qui privilégie la **qualité** des données sur la **quantité**.

**Métadonnées de la série agrégée** :
- `aggregated: true`
- `sourceCount: N` (nombre de séries source)
- `sources` dans chaque point de données (valeurs originales)

### 3. Consolidation

Les séries normalisées sont ensuite consolidées en base de données pour permettre l'agrégation et l'analyse.

## Fonctions principales

### `normalizeSeries(series)`

Point d'entrée principal de la normalisation.

**Paramètres** :
- `series` : tableau de séries temporelles extraites

**Retour** :
- Tableau de séries normalisées (converties, filtrées, agrégées)

**Traitement** :
1. Expansion des données cumulatives
2. Conversion d'unités
3. Filtrage des valeurs invalides
4. Agrégation des débits par point

### `aggregateFlowSeries(series)`

Agrège les séries de débit pour un même point.

**Paramètres** :
- Débits concernés : `débit prélevé`, `débit restitué`, `débit réservé`

**Retour** :
- Séries agrégées + séries non-débit inchangées

### `aggregateMultipleSeries(seriesGroup)`

Implémente la logique d'agrégation stricte (somme avec filtrage).

**Comportement** :
- Collecte toutes les valeurs par timestamp
- **Filtre** les timestamps où `sources.length !== expectedSourceCount`
- Trie et retourne les points complets

## Tests

Voir `__tests__/normalize.js` pour les cas de test :
- Conversion d'unités
- Expansion de données cumulatives
- Filtrage de valeurs invalides
- Agrégation avec sources incomplètes
- Gestion des timestamps non alignés

## Configuration

Les paramètres supportés et leurs contraintes sont définis dans :
- `lib/parameters-config.js` (metadata métier)
- `packages/timeseries-parsers/lib/multi-params/parameter.js` (bornes de validation)
