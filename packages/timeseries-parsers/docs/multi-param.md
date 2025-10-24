# Traitement des fichiers « multiparamètres »

## Structure attendue

- Onglet `A LIRE` contenant les métadonnées du point de prélèvement (cellule B3 notamment).
- Un ou plusieurs onglets dont le nom commence par `Data | T=`. Les variantes `Data|T=...`, espaces multiples ou différences de casse sont acceptées.
- Chaque onglet `Data | T=` présente :
  - des métadonnées par paramètre dans les lignes 2 à 10 (index 1 à 9) :
    - `nom_parametre`, `type`, `frequence`, `unite`, `detail_point_suivi`, `profondeur`, `date_debut`, `date_fin`, `remarque` ;
  - une ligne d’en-tête (ligne 12) : `date`, `heure`, `valeur_parametreX...`, `Remarque` ;
  - des lignes de données à partir de la ligne 13.

## Variantes gérées

- Noms d'onglets `Data | T=` avec espaces ou casse différents.
- Périodes abrégées : `15 min`, `15mn`, `15m`, `1jour`, `jour`, `1 trimestre`, etc.
- Unités alternatives : `µS/cm` ↔ `uS/cm`, `degrés Celsius` ↔ `degres Celsius`, etc.
- Nombres encodés sous forme de texte avec virgule ou point.
- Dates et heures saisies au format Excel ou en texte (`01/02/2025`, `1 février 2025`, `08:05`, `12h34`, …).

## Fréquences supportées

Le validateur accepte désormais **toutes les fréquences**, y compris celles supérieures à 1 jour :

### Fréquences infra-journalières (sub-daily)
- `seconde`, `minute`, `15 minutes`, `heure`
- Nécessitent la présence du champ `heure` dans les données
- Stockées avec regroupement par date : un document par jour contenant un tableau de valeurs avec timestamps

### Fréquence journalière
- `jour`, `1 jour`
- Fréquence standard, stockée directement : un document par date

### Fréquences supra-journalières (super-daily)
- `mois`, `trimestre`, `année`
- Traitement différencié selon le type de paramètre :

#### Paramètres cumulatifs (volumes)
Les paramètres de type **volume prélevé** et **volume restitué** sont automatiquement expansés en valeurs journalières :
- La valeur mensuelle/trimestrielle/annuelle est divisée par le nombre de jours de la période
- Une entrée est créée pour chaque jour avec métadonnées de traçabilité :
  - `value` : valeur journalisée (divisée)
  - `originalValue` : valeur d'origine
  - `originalDate` : date de début de période
  - `originalFrequency` : fréquence d'origine (`1 month`, `1 quarter`, `1 year`)
  - `daysCovered` : nombre de jours couverts
- La série résultante a `frequency = '1 day'` et `originalFrequency = '1 month'` (ou autre)

**Exemple** : Volume mensuel de 3100 m³ pour janvier 2025
```javascript
// Résultat : 31 entrées journalières
{
  frequency: '1 day',
  originalFrequency: '1 month',
  data: [
    {date: '2025-01-01', value: 100, originalValue: 3100, originalFrequency: '1 month', daysCovered: 31},
    {date: '2025-01-02', value: 100, originalValue: 3100, originalFrequency: '1 month', daysCovered: 31},
    // ... jusqu'au 2025-01-31
  ]
}
```

#### Paramètres non-cumulatifs
Les autres paramètres (température, pH, débit, conductivité, etc.) **conservent leur fréquence d'origine** :
- Aucune expansion n'est effectuée
- La série garde `frequency = '1 month'` (ou autre)
- Pas de champ `originalFrequency`
- Stockage direct : un document par période

**Exemple** : Température moyenne mensuelle de 15°C pour janvier 2025
```javascript
{
  frequency: '1 month',
  data: [{date: '2025-01-01', value: 15}]
}
```

### Gestion des années bissextiles
L'expansion des valeurs annuelles et trimestrielles prend en compte les années bissextiles :
- Année 2024 : 366 jours
- Année 2025 : 365 jours
- Trimestre incluant février : calcul précis du nombre de jours

## Validation étape par étape

1. **Structure globale** :
   - présence obligatoire de l’onglet `A LIRE` ;
   - existence d’au moins un onglet `Data | T=...`.
2. **Métadonnées (onglet `A LIRE`)** :
   - vérification du point de prélèvement (B3) ;
   - formatage du code via `parsePointPrelevement`, avec support des notations `123 | Nom`, `123 - Nom` ou `123 Nom`.
3. **Structure des onglets de données** :
   - contrôle des intitulés de la ligne 12 (`date`, `heure`, `Remarque`, colonnes `valeur_parametreX`) ;
   - détection des colonnes de paramètres effectivement utilisées.
4. **Métadonnées des paramètres** :
   - présence des champs obligatoires (`nom_parametre`, `type`, `frequence`, `unite`) ;
   - conformité aux listes autorisées et normalisation éventuelle ;
   - cohérence des dates (`date_debut` ≤ `date_fin` quand les deux sont renseignées).
5. **Données** :
   - validation des dates et heures ligne par ligne (regroupement des erreurs sur plusieurs lignes en un seul message) ;
   - vérification du pas de temps attendu selon la fréquence (`missingHeure` quand obligatoire, `invalidInterval` si l’écart est incohérent) ;
   - présence d’une `Remarque` lorsque la valeur est vide (sous forme d’avertissement) ;
   - contrôle des plages de dates par rapport aux métadonnées.
6. **Extraction des valeurs** :
   - filtrage des lignes dépourvues de date ;
   - validation spécifique selon le paramètre (`volume prélevé` ≥ 0, `volume restitué` ≥ 0, etc.) ;
   - expansion automatique des valeurs cumulatives avec fréquence > 1 jour.

Les erreurs récurrentes sur un même type (ex. 20 lignes avec une date invalide) sont agrégées par l’`ErrorCollector` afin de conserver une lecture lisible.

## Consolidation des séries

- Les fréquences sont normalisées via `normalizeOutputFrequency` :
  - Fréquences sub-daily : `1 second`, `1 minute`, `15 minutes`, `1 hour`
  - Fréquence journalière : `1 day`
  - Fréquences super-daily : `1 month`, `1 quarter`, `1 year`
- Les séries conservent :
  - `pointPrelevement` (numérique si convertible) ;
  - `parameter`, `unit`, `frequency`, `valueType` (mapping : `valeur brute` → `instantaneous`, `moyenne` → `average`, `différence d'index` → `delta-index`, `volume prélevé` / `volume restitué` → `cumulative`, etc.) ;
  - `originalFrequency` (optionnel) : présent uniquement si les données ont été expansées depuis une fréquence > 1 jour ;
  - `data[]` avec `date`, et `time` si la fréquence est infra-journalière ; `remark` est renseigné si la colonne `Remarque` est remplie dans la ligne source.
  - Pour les données expansées : chaque entrée `data[]` contient aussi `originalValue`, `originalDate`, `originalFrequency` et `daysCovered`.
- Les métadonnées facultatives alimentent `series.extras` :
  - `detailPointSuivi`, `profondeur` (numérique), `commentaire` (remarque sur le paramètre).
- Après consolidation, un passage de déduplication supprime les doublons temporels et ajoute, le cas échéant, un avertissement global.

## Avertissements et erreurs

- `error` : toute incohérence structurelle ou métier empêchant d’exploiter un paramètre (ex. fréquence absente, en-tête modifié, date invalide, pas de temps incohérent).
- `warning` : cas non bloquants comme l’absence de remarque pour une valeur manquante ou la suppression de doublons.

La liste complète des messages générés est référencée dans [`docs/validation.md`](validation.md).
