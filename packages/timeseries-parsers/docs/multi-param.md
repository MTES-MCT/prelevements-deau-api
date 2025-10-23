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

- Noms d’onglets `Data | T=` avec espaces ou casse différents.
- Périodes abrégées : `15 min`, `15mn`, `15m`, `1jour`, `jour`, `1 trimestre`, etc.
- Unités alternatives : `µS/cm` ↔ `uS/cm`, `degrés Celsius` ↔ `degres Celsius`, etc.
- Nombres encodés sous forme de texte avec virgule ou point.
- Dates et heures saisies au format Excel ou en texte (`01/02/2025`, `1 février 2025`, `08:05`, `12h34`, …).

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
   - validation spécifique selon le paramètre (`volume prélevé` ≥ 0, etc.).

Les erreurs récurrentes sur un même type (ex. 20 lignes avec une date invalide) sont agrégées par l’`ErrorCollector` afin de conserver une lecture lisible.

## Consolidation des séries

- Les fréquences sont normalisées (`15 minutes`, `1 hour`, `1 day`, ...) via `normalizeOutputFrequency`.
- Les séries sous-jacentes conservent :
  - `pointPrelevement` (numérique si convertible) ;
  - `parameter`, `unit`, `frequency`, `valueType` (mapping : `valeur brute` → `instantaneous`, `moyenne` → `average`, `différence d’index` → `delta-index`, `volume prélevé` → `cumulative`, etc.) ;
  - `data[]` avec `date`, et `time` si la fréquence est infra-journalière ; `remark` est renseigné si la colonne `Remarque` est remplie dans la ligne source.
- Les métadonnées facultatives alimentent `series.extras` :
  - `detailPointSuivi`, `profondeur` (numérique), `commentaire` (remarque sur le paramètre).
- Après consolidation, un passage de déduplication supprime les doublons temporels et ajoute, le cas échéant, un avertissement global.

## Avertissements et erreurs

- `error` : toute incohérence structurelle ou métier empêchant d’exploiter un paramètre (ex. fréquence absente, en-tête modifié, date invalide, pas de temps incohérent).
- `warning` : cas non bloquants comme l’absence de remarque pour une valeur manquante ou la suppression de doublons.

La liste complète des messages générés est référencée dans [`docs/validation.md`](validation.md).
