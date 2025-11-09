# @fabnum/prelevements-deau-timeseries-parsers

Ce package fournit les outils nécessaires pour analyser les fichiers déposés dans Démarches Simplifiées dans le cadre du suivi des prélèvements d'eau, et pour en extraire des séries temporelles normalisées.

## Objectifs

- garantir que le fichier remis par un préleveur correspond bien à l'un des modèles fournis (y compris leurs déclinaisons historiques) ;
- vérifier la cohérence des métadonnées et des valeurs avec les informations déclarées dans le formulaire DS ;
- fournir un retour actionnable à l'usager et à l'instructeur (erreurs bloquantes, avertissements, explications) ;
- consolider les données valides dans un format commun exploitable par la suite.

Un panorama plus détaillé du fonctionnement est disponible dans [`docs/overview.md`](docs/overview.md).

## Typologies de fichiers supportées

- **Camion citerne** — tableaux journaliers de volumes prélevés pour une liste fermée de points de prélèvement. Voir [`docs/camion-citerne.md`](docs/camion-citerne.md).
- **Fichiers multiparamètres** — classeurs comportant un onglet « A LIRE » et un ou plusieurs onglets `Data | T=...` contenant des séries de mesures (débit, volume, pH, etc.). Voir [`docs/multi-param.md`](docs/multi-param.md).

## Gestion des templates et du versioning

Plusieurs versions de modèles Excel ont été communiquées au fil du temps. Les parseurs normalisent les variations les plus courantes : espaces, casse, ponctuation des noms d'onglet, synonymes de fréquences, variantes d’unités ou encore valeurs numériques encodées en texte. Lorsqu’un élément attendu est modifié ou manquant, le validateur précise si l’écart est bloquant ou s’il peut être contourné. Les règles prises en compte sont décrites dans les documents spécifiques à chaque type de fichier.

## Installation

```bash
npm install @fabnum/prelevements-deau-timeseries-parsers
```

## CLI

Le package inclut un outil en ligne de commande pour inspecter rapidement les séries extraites d'un fichier.

```bash
# Utilisation avec npx
npx timeseries-inspect <fichier> --type <camion-citerne|multi-params>

# Exemples
npx timeseries-inspect mon-fichier.xlsx --type multi-params
npx timeseries-inspect volumes.xlsx --type camion-citerne
```

Le script affiche :
- Les erreurs et avertissements de validation
- Le nombre de séries extraites
- Pour chaque série : point de prélèvement, paramètre, unité, fréquence, type de valeur, période couverte, nombre de valeurs
- Un échantillon des premières valeurs de chaque série

## API

Les deux fonctions exposées prennent un `Buffer` (contenu binaire du fichier) et renvoient un objet `{data, rawData, errors}`. Les messages sont normalisés, avec une propriété `severity` à `error` ou `warning`.

### `extractCamionCiterne(buffer)`

- **Entrée** : le contenu d’un tableur Camion citerne (`xls`, `xlsx`, `ods`).
- **Sortie** :
  - `data.series` — une série par point de prélèvement détecté, fréquence journalière, valeur cumulée.
  - `rawData` — entêtes et lignes interprétées avant consolidation.
  - `errors` — liste de validations (voir [`docs/validation.md`](docs/validation.md)).
- **Comportement notable** : supprime les doublons de dates au sein d’une série et ajoute un avertissement global si c’est le cas. Détails dans [`docs/camion-citerne.md`](docs/camion-citerne.md).

### `extractMultiParamFile(buffer)`

- **Entrée** : le contenu d'un fichier multiparamètres DS.
- **Sortie** :
  - `data.series` — séries normalisées par paramètre (volume prélevé, débit, pH, etc.), avec fréquence (`1 day`, `15 minutes`, `1 hour`, `1 month`, `1 quarter`, `1 year`), nature (`valueType`) et éventuels commentaires/metadata. Pour les séries expansées depuis une fréquence > 1 jour, le champ `originalFrequency` indique la fréquence d'origine.
  - `rawData` — contenu extrait des onglets `A LIRE` et `Data | T=`.
  - `errors` — messages structurés, agrégés par plage quand c'est pertinent.
- **Comportement notable** : validation détaillée de chaque paramètre (métadonnées, pas de temps, cohérence des dates/heures), gestion des valeurs manquantes nécessitant une remarque, normalisation des fréquences/unités. Les paramètres cumulatifs (volumes) avec une fréquence > 1 jour sont automatiquement expansés en valeurs journalières avec préservation des métadonnées d'origine. Voir [`docs/multi-param.md`](docs/multi-param.md).

## Exemple d’utilisation

```javascript
import {
  extractCamionCiterne,
  extractMultiParamFile
} from '@fabnum/prelevements-deau-timeseries-parsers'

async function parseMultiParam(fileBuffer) {
  const {data, errors} = await extractMultiParamFile(fileBuffer)
  if (!data) {
    throw new Error(`Validation échouée: ${errors.map(e => e.message).join('; ')}`)
  }

  return {series: data.series, warnings: errors.filter(e => e.severity === 'warning')}
}

async function parseCamion(fileBuffer) {
  const {data, errors} = await extractCamionCiterne(fileBuffer)
  if (!data) {
    throw new Error(`Validation échouée: ${errors.map(e => e.message).join('; ')}`)
  }

  return data.series
}
```

## Structure des résultats

- `data.series[]` : chaque série contient au minimum `pointPrelevement`, `parameter`, `unit`, `frequency`, `valueType`, `minDate`, `maxDate`, `data[]`. Le champ optionnel `originalFrequency` est présent lorsque les données ont été expansées depuis une fréquence > 1 jour. Les points de données incluent `date`, et selon les cas `time` (fréquence infra-journalière), `remark`, et pour les données expansées : `originalValue`, `originalDate`, `originalFrequency`, `daysCovered`.
- `rawData` : représente une vue détaillée des éléments intermédiaires (en-têtes normalisés, lignes brutes, métadonnées) pour faciliter le diagnostic ou des traitements spécifiques.
- `errors[]` : chaque message possède `message`, `severity` et, selon les cas, `explanation` et `internalMessage`. Les agrégations d'erreurs de données regroupent plusieurs lignes en un seul message quand elles partagent la même cause.

## Validation et messages

Une liste exhaustive des messages produits (erreurs et avertissements) est tenue à jour dans [`docs/validation.md`](docs/validation.md). Elle constitue la référence pour adapter les retours utilisateurs côté interface.

## Ressources complémentaires

- [`docs/overview.md`](docs/overview.md) — architecture du validateur, structure du retour, stratégie de versioning.
- [`docs/camion-citerne.md`](docs/camion-citerne.md) — détails sur le parsing des tableaux Camion citerne.
- [`docs/multi-param.md`](docs/multi-param.md) — détails sur le parsing des fichiers multiparamètres.
- [`docs/validation.md`](docs/validation.md) — catalogue des messages.
