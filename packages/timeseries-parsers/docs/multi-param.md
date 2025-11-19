# Traitement des fichiers « multiparamètres »

## Structure attendue

- Onglet `A LIRE` contenant les métadonnées du point de prélèvement (cellule B3 notamment).
- Un ou plusieurs onglets dont le nom commence par `Data | T=`. Les variantes `Data|T=...`, espaces multiples ou différences de casse sont acceptées.
- Chaque onglet `Data | T=` présente :
  - des métadonnées par paramètre dans les lignes 2 à 10 (index 1 à 9) :
    - `nom_parametre`, `type`, `frequence`, `unite`, `detail_point_suivi`, `profondeur`, `date_debut`, `date_fin`, `remarque` ;
  - une ligne d'en-tête (ligne 12) : `date`, `heure`, `valeur_parametreX...`, `Remarque` ;
  - des lignes de données à partir de la ligne 13.

### Onglets standards supportés

Le format multi-paramètres supporte plusieurs onglets standards avec des périodes fixes :

- **`Data | T=15 minutes`** : données avec fréquence de 15 minutes (obligatoire si utilisé)
- **`Data | T=1 heure`** : données avec fréquence horaire (optionnel, ajouté dans v2.10)
- **`Data | T=1 jour`** : données avec fréquence journalière (standard)
- **`Data | T=1 mois`** : données avec fréquence mensuelle (optionnel, ajouté dans v2.10)
- **`Data | T=1 trimestre`** : données avec fréquence trimestrielle
- **`Data | T=autre`** : onglet flexible où la fréquence est définie au niveau de chaque paramètre

Les onglets sont **optionnels** : un fichier peut contenir un ou plusieurs de ces onglets selon les besoins. Les onglets avec périodes fixes valident que la fréquence déclarée dans les métadonnées des paramètres correspond bien au nom de l'onglet.

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
- **Onglets dédiés** : `Data | T=15 minutes` et `Data | T=1 heure` (ce dernier ajouté dans v2.10)

### Fréquence journalière
- `jour`, `1 jour`
- Fréquence standard, stockée directement : un document par date

### Fréquences supra-journalières (super-daily)
- `mois`, `trimestre`, `année`
- **Onglets dédiés** : `Data | T=1 mois` (ajouté dans v2.10) et `Data | T=1 trimestre`

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
   - validation de l'unité par rapport au paramètre (via configuration canonique) ;
   - cohérence des dates (`date_debut` ≤ `date_fin` quand les deux sont renseignées).
5. **Données** :
   - validation des dates et heures ligne par ligne (regroupement des erreurs sur plusieurs lignes en un seul message) ;
   - vérification du pas de temps attendu selon la fréquence (`missingHeure` quand obligatoire, `invalidInterval` si l’écart est incohérent) ;
   - présence d’une `Remarque` lorsque la valeur est vide (sous forme d’avertissement) ;
   - contrôle des plages de dates par rapport aux métadonnées.
6. **Extraction des valeurs** :
   - filtrage des lignes dépourvues de date ;
   - validation des valeurs (min/max) selon l'unité déclarée.

Les erreurs récurrentes sur un même type (ex. 20 lignes avec une date invalide) sont agrégées par l'`ErrorCollector` afin de conserver une lecture lisible.

## Exemples d'utilisation des onglets

### Onglet horaire (`Data | T=1 heure`)

L'onglet horaire permet de saisir des données avec un pas de temps d'une heure. Il est particulièrement utile pour :
- Le suivi de paramètres physico-chimiques (température, pH, conductivité)
- Le suivi de débits horaires
- Les niveaux d'eau avec relevé horaire

**Caractéristiques :**
- La fréquence dans les métadonnées doit être `heure` ou `1 heure`
- Le champ `heure` est **obligatoire** pour chaque ligne de données
- Format de l'heure : `HH:mm` ou `HH:mm:ss`
- Les données sont stockées avec regroupement par date

**Exemple de métadonnées :**
```
nom_parametre: température
type: moyenne
frequence: heure
unite: degrés Celsius
```

### Onglet mensuel (`Data | T=1 mois`)

L'onglet mensuel permet de saisir des données avec un pas de temps mensuel.

**Caractéristiques :**
- La fréquence dans les métadonnées doit être `mois` ou `1 mois`
- Le champ `heure` n'est **pas nécessaire**
- Date au format `YYYY-MM-DD` (généralement le 1er du mois)

**Exemple pour un volume mensuel :**
```
nom_parametre: volume prélevé
type: valeur brute
frequence: mois
unite: m³
```

## Consolidation des séries

- Les fréquences sont normalisées via `normalizeOutputFrequency` :
  - Fréquences sub-daily : `1 second`, `1 minute`, `15 minutes`, `1 hour`
  - Fréquence journalière : `1 day`
  - Fréquences super-daily : `1 month`, `1 quarter`, `1 year`
- Les séries conservent :
  - `pointPrelevement` (numérique si convertible) ;
  - `parameter`, `unit`, `frequency`, `valueType` (mapping : `valeur brute` → `instantaneous`, `moyenne` → `average`, `différence d'index` → `delta-index`, `volume prélevé` / `volume restitué` → `cumulative`, etc.) ;
  - `data[]` avec `date`, et `time` si la fréquence est infra-journalière ; `remark` est renseigné si la colonne `Remarque` est remplie dans la ligne source.
- Les métadonnées facultatives alimentent `series.extras` :
  - `detailPointSuivi`, `profondeur` (numérique), `commentaire` (remarque sur le paramètre).
- Après consolidation, un passage de déduplication supprime les doublons temporels et ajoute, le cas échéant, un avertissement global.

## Avertissements et erreurs

- `error` : toute incohérence structurelle ou métier empêchant d’exploiter un paramètre (ex. fréquence absente, en-tête modifié, date invalide, pas de temps incohérent).
- `warning` : cas non bloquants comme l’absence de remarque pour une valeur manquante ou la suppression de doublons.

La liste complète des messages générés est référencée dans [`docs/validation.md`](validation.md).
