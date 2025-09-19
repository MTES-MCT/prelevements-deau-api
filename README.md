# Prélèvement d’Eau Back

Ce projet vise à collecter, organiser et analyser les données de prélèvement d'eau provenant de Démarche Simplifiée. Il fournit divers scripts pour récupérer les dossiers de prélèvements, extraire des données précises et générer des rapports.

Consultez la [documentation de validation](packages/timeseries-parsers/docs/validation.md) pour les erreurs et avertissements possibles.

## Installation

Ce projet utilise `yarn` comme gestionnaire de paquets. Assurez-vous d'avoir Node.js (version ≥ 22.11) installé avant de commencer.

1. Installez les dépendances :

   ```bash
   yarn install
   ```

2. Créez un fichier `.env` en utilisant `.env.example` comme modèle et complétez les variables obligatoires.

## Initialisation

**Initialiser la base de donneés** :

Ce script lancera la récupération des dossiers déposés sur Démarches Simplifiées. Ces dossiers seront traités :
1. Validation des données
2. Stockage en ligne des fichiers en pièce jointe
3. Enregistrement en base de donnée des dossiers

```bash
yarn resync-all-dossiers
```

## Scripts

### Préparation du territoire

- Ajouter une entrée dans la base MongoDB _("à la main" pour l'instant)_
- Exemple :

```mongo
db.territoires.insertOne({nom: 'La Réunion', bbox: [[55.25, -21.45], [55.8, -20.85]], code: 'DEP-974'})
```

- Exemple (Démarches Simplifiées) :

```mongo
db.territoires.insertOne({nom: 'La Réunion', bbox: [[55.25, -21.45], [55.8, -20.85]], code: 'DEP-974', demarcheNumber: 1234})
```

- Ajouter un jeton d'accès dans la collection `tokens` :
- Exemple :

```mongo
db.tokens.insertOne({token: '<votre_token>', territoire: 'DEP-974'})
```

 - Importe les données de référence :
 _(Il faut préciser le chemin du dossier contenant les fichiers CSV)_

 ```bash
 yarn import-reference-data /chemin/du/dossier
 ```

- Importer les points / préleveurs / exploitations / règles / documents / modalités :
_(Il faut préciser le code du territoire ainsi que le chemin du dossier contenant les fichiers CSV)_

```bash
yarn import-territoire-data DEP-974 /chemin/du/dossier
```

 - Importer les données historiques (optionnel) :

Importe les anciens volumes journaliers prélevés à partir de fichiers CSV (`serie-donnees.csv`, `resultat-suivi.csv`, `exploitation-serie.csv`) en les enregistrant dans la base MongoDB. Ce script doit être utilisé pour migrer des données historiques non présentes sur Démarches Simplifiées.
_(Il faut préciser le chemin du dossier contenant les fichiers CSV)_

 ```bash
 yarn import-territoire-historical-data /chemin/du/dossier
 ```

### Autres scripts utiles

- **download-csv** : télécharge l'ensemble des fichiers CSV depuis la source indiquée par `CSV_SOURCE_URL`.
  ```bash
  yarn download-csv
  ```
- **sync-updated-dossiers** : synchronise uniquement les dossiers modifiés sur Démarches Simplifiées.
  ```bash
  yarn sync-updated-dossiers
  ```
- **read-multi-params** : valide un fichier multi-paramètres avant import.
  ```bash
  node scripts/read-multi-params.js <fichier.csv>
  ```
- **validate-declaration-file** : valide un fichier de déclaration (camion citerne ou multi-paramètres).
  ```bash
  node scripts/validate-declaration-file.js <filePath> [camion-citerne|multi-params]
  ```

### Lancer l'application :
```bash
yarn start
```

## Linter

Le projet utilise **xo** comme linter pour assurer la qualité du code. Exécutez la commande suivante pour lancer le linter :

```bash
yarn lint
```

## Prérequis

- Node.js version 22 LTS (22.11+)
- MongoDB version 4.4.29

## Routes de l'API :
| Route | Type | Description |
|-------|------|-------------|
| `/points-prelevement`| **GET** * | *Retourne la liste des points de prélèvement* |
| `/points-prelevement`| **POST** * | *Permet d'ajouter un point de prélèvement* |
| `/points-prelevement/:id`| **GET** * | *Retourne le point de prélèvement* |
| `/points-prelevement/:id`| **PUT** * | *Modifie le point de prélèvement* |
| `/points-prelevement/:id`| **DELETE** * | *Supprime le point de prélèvement* |
| `/points-prelevement/:id/exploitations`| **GET** * | *Retourne la liste des exploitations du point* |
| `/exploitations`| **POST** * | *Crée une exploitation* |
| `/exploitations:id`| **GET** * | *Retourne l'exploitation* |
| `/exploitations:id`| **PUT** * | *Modifie l'exploitation* |
| `/exploitations:id`| **DELETE** * | *Supprime l'exploitation* |
| `/exploitations/:id/volumes-preleves`| **GET** * | *Retourne les volumes prélevés de l'exploitations* |
| `/preleveurs`| **GET** * | *Retourne la liste des préleveurs* |
| `/preleveurs/:id`| **GET** * | *Retourne le préleveur* |
| `/preleveurs/:id/points-prelevement`| **GET** * | *Retourne les points exploités par le préleveur* |
| `/preleveurs/:id/documents`| **GET** * | *Retourne les documents associés à un préleveur* |
| `/preleveurs/:id/documents`| **POST** * | *Associe un document à un préleveur* |
| `/preleveurs/:id/documents/:documentId`| **DELETE** * | *Supprime un document* |
| `/preleveurs/:id/documents/upload`| **POST** * | *Upload le document sur le S3* |
| `/territoires/:codeTerritoire/points-prelevement` | **GET** * | *Retourne les points à partir du code territoire* |
| `/territoires/:codeTerritoire/preleveurs` | **GET** * | *Retourne les préleveurs à partir du code territoire* |
| `/stats`| **GET** | *Retourne les données pour la page `/statistiques`* |
| `/dossiers/stats` | **GET** * | *Retourne le nombre de dossiers par `status`* |

> [!NOTE]
> *Les routes avec une `*` sont protégées par un jeton*

### Objet `point_prelevement` :

| Propriété | Type | Obligatoire |
|-----------|------|-------------|
| `nom` | string | oui |
| `autres_noms` | string | non |
| `code_aiot` | string | non |
| `type_milieu` | string | oui |
| `profondeur` | number | non |
| `zre` | bool | non |
| `reservoir_biologique` | bool | non |
| `cours_eau` | string | non |
| `detail_localisation` | string | non |
| `geom` | Feature Point | oui |
| `precision_geom` | string | oui |
| `remarque` | string | non |
| `bss` | string | non |
| `bnpe` | string | non |
| `meso` | string | non |
| `meContinentalesBv` | string | non |
| `bvBdCarthage` | string | non |
| `commune` | string | oui |

### Objet `exploitation` :

| Propriété | Type | Obligatoire |
|-----------|------|-------------|
| `date_debut` | string | oui |
| `date_fin` | string | non |
| `statut` | string | oui |
| `raison_abandon` | string | non |
| `remarque` | string | non |
| `point` | ObjectId | oui |
| `preleveur` | ObjectId | oui |
| `usages` | array | oui |
| `regles` | array | non |
| `documents` | array | non |
| `modalites` | array | non |

### Objet `preleveur` :

| Propriété | Type | Obligatoire |
|-----------|------|-------------|
| `raison_sociale` | string | non |
| `sigle` | string | non |
| `civilite` | string | non |
| `nom` | string | non |
| `prenom` | string | non |
| `email` | string | non |
| `adresse_1` | string | non |
| `adresse_2` | string | non |
| `bp` | string | non |
| `code_postal` | string | non |
| `commune` | string | non |
| `numero_telephone` | string | non |

---

## License

Ce projet est sous licence MIT. Voir le fichier LICENSE pour plus de détails.

