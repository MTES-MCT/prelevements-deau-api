# Prélèvement d’Eau Back

Ce projet vise à collecter, organiser et analyser les données de prélèvement d'eau provenant de Démarche Simplifiée. Il fournit divers scripts pour récupérer les dossiers de prélèvements, extraire des données précises et générer des rapports.

Consultez la [documentation de validation](packages/timeseries-parsers/docs/validation.md) pour les erreurs et avertissements possibles.

## Prérequis

- Node.js version 22 LTS (22.11+)
- MongoDB version 4.4.29
- Redis (pour les tâches planifiées via BullMQ)

## Installation

Ce projet utilise `yarn` comme gestionnaire de paquets. Assurez-vous d'avoir Node.js (version ≥ 22.11) installé avant de commencer.

1. Installez les dépendances :

   ```bash
   yarn install
   ```

2. Créez un fichier `.env` en utilisant `.env.example` comme modèle et complétez les variables obligatoires.

## Initialisation

- Les données initiales doivent être ajoutées à la base MongoDB _("à la main" pour l'instant).

```mongo
db.territoires.insertOne({nom: 'La Réunion', bbox: [[55.25, -21.45], [55.8, -20.85]], code: 'DEP-974', demarcheNumber: <number>})
```

Remplacez <number> par le demarcheNumber correspondant à l’identifiant sur démarches simplifiées.

- Ajoutez un jeton d'accès dans la collection `tokens` :

```mongo
db.tokens.insertOne({token: '<votre_token>', territoire: 'DEP-974'})
```

Ce jeton sera utilisé en tant que mot de passe pour se connecter à l'application.

- Téléchargez les CSV de référence. Assurez-vous d'avoir rempli la variable d'environnement `CSV_SOURCE_URL` avant.

```bash
yarn download-csv
```

- Importez ensuite ces fichiers en base, le dernier paramètre correspond à l'emplacement des CSV.

```bash
yarn import-reference-data ./data
```

- Importez les points / préleveurs / exploitations / règles / documents / modalités :
  _(Il faut préciser le code du territoire ainsi que le chemin du dossier contenant les fichiers CSV)_

```bash
yarn import-territoire-data DEP-974 ./data
```

- Enfin, récupérez les dossiers déposés sur Démarches Simplifiées. Ces dossiers seront traités :
1. Validation des données
2. Stockage en ligne des fichiers en pièce jointe
3. Enregistrement en base de donnée des dossiers

```bash
yarn resync-all-dossiers
```

### Autres scripts utiles

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

## Lancer l'application

### 1. Démarrer Redis

```bash
# Option 1 : Homebrew
brew install redis
brew services start redis

# Option 2 : Docker
docker run -d -p 6379:6379 redis:alpine
```

### 2. Démarrer l'API HTTP

```bash
yarn start
```

### 3. Démarrer les workers BullMQ (dans un autre terminal)

```bash
yarn start:worker
```

Les workers gèrent les tâches planifiées :
- **sync-updated-dossiers** : Synchronisation des dossiers depuis Démarches Simplifiées (toutes les heures)
- **process-attachments** : Traitement des pièces jointes (chaque minute)
- **consolidate-dossiers** : Consolidation des dossiers (chaque minute)

### Architecture

L'application est composée de deux processus séparés :
- **api.js** : Serveur HTTP Express (port 5000)
- **worker.js** : Workers BullMQ pour les tâches planifiées

Les deux communiquent via Redis pour la gestion des files d'attente.

## Linter

Le projet utilise **xo** comme linter pour assurer la qualité du code. Exécutez la commande suivante pour lancer le linter :

```bash
yarn lint
```

## Documentation de l'API

La documentation complète et à jour des endpoints est maintenant centralisée dans un fichier OpenAPI :

`docs/openapi.yaml`

Vous pouvez :
- la visualiser dans un outil comme Swagger UI / Redoc ;
- générer des clients (TypeScript, Python, etc.) ;
- valider les modifications de contrats lors des PR.

### Lint de la spécification OpenAPI

Le lint est automatisé via [Spectral](https://github.com/stoplightio/spectral). Pour lancer une vérification locale :

```bash
yarn lint:openapi
```

Une action GitHub (`.github/workflows/openapi-lint.yml`) exécute ce lint sur chaque PR modifiant le fichier `docs/openapi.yaml`.

> Note : L’ancien tableau statique des routes a été retiré pour éviter les divergences.

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

