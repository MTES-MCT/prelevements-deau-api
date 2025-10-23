# Traitement des fichiers « Camion citerne »

## Structure attendue

- Classeur `xls`, `xlsx` ou `ods`.
- La première feuille est utilisée ; les autres sont ignorées.
- Ligne 3 (index 2) : en-tête avec la colonne `Date`, suivie d’une liste de points de prélèvement au format `code nom`.
  - Les codes doivent appartenir à la liste de référence définie dans le code (412 à 423).
  - Les noms sont comparés en ignorant la casse et les espaces multiples.
- Les lignes de données commencent à la ligne 4 (index 3) et contiennent une date et, en colonnes suivantes, les volumes journaliers de chaque point.

Le parseur tolère les retours à la ligne et les espaces superflus dans les en-têtes, ainsi que les dates Excel (numériques) ou textuelles (`26/02/2025`, `26 février 2025`, `26/02/2025 00:00:00`, etc.).

## Variantes gérées

- Colonnes vides en fin de feuille : elles sont ignorées.
- Lignes complètement vides intercalées : elles sont sautées sans erreur.
- Valeurs saisies en texte mais interprétables comme nombre (`"1,5"`, `"3"`).
- Doublons de colonnes : signalés comme erreurs pour éviter les ambiguïtés.

## Validation métier

1. **Structure minimale** : au moins une feuille, une plage `!ref` définie, un en-tête conforme.
2. **Dates** :
   - format lisible ou convertible ;
   - absence de doublons (même date plusieurs fois) ;
   - présence d’au moins une date avec données.
3. **Valeurs** :
   - chaque cellule doit contenir un nombre ≥ 0 ou rester vide ;
   - si la date est renseignée mais toutes les valeurs sont vides, une erreur est levée (l’utilisateur doit saisir `0` ou supprimer la ligne).
4. **Déduplication** : après consolidation, des doublons de `(date, point)` éventuels sont supprimés et un avertissement global est ajouté.

La liste exhaustive des messages possibles est disponible dans [`docs/validation.md`](validation.md).

## Données restituées

`extractCamionCiterne` renvoie une unique série par point de prélèvement détecté :

- `parameter` : `volume prélevé` ;
- `unit` : `m3` ;
- `frequency` : `1 day` ;
- `valueType` : `cumulative` ;
- `data[]` : couples `{date, value}` sans doublon.

`rawData.headers` conserve les informations sur les colonnes (code, libellé, index) et `rawData.dailyValues` contient les lignes telles que lues avant la consolidation.
