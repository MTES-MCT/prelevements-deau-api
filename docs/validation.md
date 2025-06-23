# Validation des fichiers

Ce dépôt fournit deux fonctions principales pour valider les fichiers provenant de Démarches Simplifiées :

- `validateCamionCiterneFile`
- `validateMultiParamFile`

Ces fonctions sont exposées par le package `@fabrique/timeseries-parsers`. Elles renvoient une liste d'objets contenant au moins la propriété `message` (et éventuellement `explanation`, `internalMessage` et `severity`). La sévérité est `error` par défaut et vaut `warning` lorsque le problème n'empêche pas l'import.

## Fonction `validateCamionCiterneFile`

Cette fonction vérifie la structure et le contenu d'un fichier « Camion citerne ». Les contrôles portent notamment sur :

- le format du fichier (xls, xlsx ou ods) ;
- la présence d'au moins une feuille ;
- la présence et la conformité des en‑têtes ;
- la validité des dates et des valeurs numériques ;
- l'absence de doublons de dates et de lignes vides.

### Erreurs possibles

- « Format de fichier incorrect » (avec une explication sur le format attendu)
- « Fichier illisible ou corrompu »
- « Format de date invalide : … »
- « Le fichier est vide ou ne contient pas de feuille. »
- « L'intitulé de la première colonne doit être 'Date'. … »
- « L'en-tête de la colonne X est manquant. »
- « L'en-tête de la colonne X n'est pas au format attendu. »
- « L'en-tête de la colonne X ne correspond pas. »
- « Le fichier ne contient pas de données à partir de la ligne 4. »
- « Ligne N : Format de date invalide : … »
- « Ligne N : La date … est déjà présente dans le fichier. »
- « Le fichier ne contient pas de données. »
- « Ligne N : La date est renseignée, mais aucune valeur n'est indiquée dans les colonnes B à K. »
- « Valeur numérique invalide »

### Avertissements

Aucun avertissement n'est émis par cette fonction.

## Fonction `validateMultiParamFile`

Cette fonction valide les fichiers « multiparamètres » composés d'un onglet « A LIRE » et d'au moins un onglet de données « Data | T=… ». Les vérifications portent sur la structure du classeur, les métadonnées de chaque paramètre et la cohérence des données.

### Erreurs possibles

- « Format de fichier incorrect »
- « Fichier illisible ou corrompu »
- « Format de date invalide : … »
- « Format horaire invalide : … »
- « L'onglet 'A LIRE' est manquant »
- « Aucun onglet 'Data | T=…' n'a été trouvé »
- « Le nom du point de prélèvement (cellule B3 de l'onglet 'A LIRE') est manquant »
- « L'intitulé de la colonne …12 dans l'onglet 'NomOnglet' a été modifié »
- « Fréquence non renseignée pour le paramètre X »
- « Le champ 'frequence' (cellule …4) a été modifié pour le paramètre 'X'. Attendu : … »
- « Valeur incorrecte pour le paramètre 'X' à la date Y et à l'heure Z : V »
- « Le champ 'champ' (cellule …) est manquant pour le paramètre 'X' »
- « Le champ 'champ' (cellule …) doit être l'une des valeurs suivantes : … »
- « Le champ 'champ' (cellule …) n'est pas valide pour le paramètre 'X' »
- « Le champ 'date_debut' (cellule …) doit être une date valide pour le paramètre 'X' »
- « Le champ 'date_fin' (cellule …) doit être une date valide pour le paramètre 'X' »
- « Impossible de déterminer le pas de temps attendu pour le paramètre X »
- « Le pas de temps entre les lignes … de l'onglet NomOnglet est incorrect »
- « Les dates dans l'onglet 'NomOnglet' ne sont pas valides pour les cellules … »
- « Les heures dans l'onglet 'NomOnglet' ne sont pas valides pour les cellules … »
- « Le champ 'date' est obligatoire dans l'onglet 'NomOnglet' pour les cellules … »
- « Le champ 'heure' est obligatoire dans l'onglet 'NomOnglet' à la fréquence '…' pour les cellules … »
- « Les dates dans l'onglet 'NomOnglet' doivent être comprises entre le … »
- « Le fichier ne contient pas de données à la maille journalière »
- « Le fichier ne contient pas de données de volume prélevé »

### Avertissements

- « Le champ 'Remarque' doit être renseigné si la valeur est manquante pour le paramètre 'X' dans l'onglet 'NomOnglet', cellules … »
