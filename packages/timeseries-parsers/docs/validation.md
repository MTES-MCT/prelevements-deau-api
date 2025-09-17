# Validation des fichiers

Ce dépôt fournit deux fonctions principales pour valider les fichiers provenant de Démarches Simplifiées :

- `validateCamionCiterneFile`
- `validateMultiParamFile`

Ces fonctions sont exposées par le package `@fabnum/prelevements-deau-timeseries-parsers`. Elles renvoient une liste d'objets contenant au moins la propriété `message` (et éventuellement `explanation`, `internalMessage` et `severity`). La sévérité est `error` par défaut et vaut `warning` lorsque le problème n'empêche pas l'import.

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
- « Le fichier est vide ou ne contient pas de feuille. »
- « La feuille de calcul est vide. »
- « L'intitulé de la première colonne doit être 'Date'. Trouvé : '...' »
- « L'en-tête de la colonne X n'est pas au format attendu. Trouvé : '...'. » (avec une explication e format attendu)
- « Le point de prélèvement X est un doublon. »
- « Le fichier ne contient pas de données à partir de la ligne 4. »
- « Le fichier ne contient pas de données. »
- « Le fichier ne contient pas de données journalières »
- « Ligne N : Format de date invalide : ... »
- « Ligne N : La date ... est déjà présente dans le fichier. » (avec une explication sur la manière de gérer les doublons)
- « Ligne N : La date est renseignée, mais aucune valeur n'est indiquée dans les colonnes des points de prélèvement. » (avec une explication sur la manière de gérer les valeurs manquantes)
- « Ligne N - colonne X: Valeur numérique invalide » (avec une explication sur la valeur attendue) 

### Avertissements

Aucun avertissement n'est émis pour ce type de fichier.

## Fonction `validateMultiParamFile`

Cette fonction valide les fichiers « multiparamètres » composés d'un onglet « A LIRE » et d'au moins un onglet de données « Data | T=… ». Les vérifications portent sur la structure du classeur, les métadonnées de chaque paramètre et la cohérence des données.

### Erreurs possibles

- « Format de fichier incorrect »
- « Fichier illisible ou corrompu »
- « L'onglet 'A LIRE' est manquant »
- « Aucun onglet 'Data | T=…' n'a été trouvé »
- « Le nom du point de prélèvement (cellule B3 de l'onglet 'A LIRE') est manquant »
- « Point de prélèvement invalide : {valeur} »
- « L'intitulé de la colonne {colonne}{ligne} dans l'onglet '{NomOnglet}' a été modifié. Attendu : '{attendu}', trouvé : '{trouvé}' »
- « Fréquence non renseignée pour le paramètre {NomParamètre} »
- « Le champ 'frequence' (cellule {colonne}{ligne}) a été modifié pour le paramètre '{NomParamètre}'. Attendu : '{valeursAttendues}', trouvé : '{valeurTrouvée}' »
- « Le champ '{nomChamp}' (cellule {colonne}{ligne}) n'est pas valide pour le paramètre '{NomParamètre}' »
- « Le champ '{nomChamp}' (cellule {colonne}{ligne}) est manquant pour le paramètre '{NomParamètre}' »
- « Le champ '{nomChamp}' (cellule {colonne}{ligne}) doit être l'une des valeurs suivantes : {valeursAttendues} »
- « La date de début pour le paramètre '{NomParamètre}' ne peut pas être postérieure à la date de fin. »
- « Valeur incorrecte pour le paramètre '{NomParamètre}' à la date {date} et à l'heure {heure} : {valeur} »
- « Les dates pour {intervalles} de l'onglet '{NomOnglet}' ne sont pas valides. »
- « Les heures pour {intervalles} de l'onglet '{NomOnglet}' ne sont pas valides. »
- « Le champ 'date' est obligatoire pour {intervalles} de l'onglet '{NomOnglet}'. »
- « Le champ 'heure' est obligatoire pour {intervalles} de l'onglet '{NomOnglet}'. »
- « Les dates pour {intervalles} de l'onglet '{NomOnglet}' doivent être comprises entre le {dateDebut} et le {dateFin}. »
- « Le pas de temps est incorrect pour {intervalles} de l'onglet '{NomOnglet}'. »
- « Impossible de déterminer le pas de temps attendu pour le paramètre {NomParamètre} »
- « Le fichier ne contient pas de données à la maille journalière »
- « Le fichier ne contient pas de données de volume prélevé »

### Avertissements

- « Le champ 'Remarque' doit être renseigné si la valeur est manquante pour le paramètre '{NomParamètre}' pour {intervalles} de l'onglet '{NomOnglet}'. »
