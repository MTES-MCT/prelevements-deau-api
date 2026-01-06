# Prélèvement d’Eau Back

Ce projet vise à collecter, organiser et analyser les données de prélèvement d'eau provenant de Démarche Simplifiée. Il fournit divers scripts pour récupérer les dossiers de prélèvements, extraire des données précises et générer des rapports.

Consultez la [documentation de validation](packages/timeseries-parsers/docs/validation.md) pour les erreurs et avertissements possibles.

## Prérequis

- Node.js version 24 LTS (24.11+)
- `npm`
- Docker version >= 28

## Sous-module `data`

Le projet utilise un sous-module Git nommé `data` pour accéder à des ressources privées
(données relatives à des structures non versionnées dans ce dépôt principal).

```
git submodule init
git submodule update
```

## Installation

1. Installez les dépendances :

   ```bash
   npm install
   npm install -g migrate-mongo
   ```

2. Créez un fichier `.env` en utilisant `.env.example` comme modèle et complétez les variables obligatoires.

## Démarrage des conteneurs

   ```bash
   docker compose up -d
   ```

## Création des buckets

  ```bash
  docker compose exec minio mc alias set local http://localhost:9000 minio minio123
  docker compose exec minio mc mb local/prelevements-deau-documents
  docker compose exec minio mc mb local/prelevements-deau-ds
  ```

## Initialisation des données

**Note**
Sur Scalingo, MongoDB est limité à la version 4.0.4, les versions 5+ ne sont pas disponibles en raison des restrictions de licences (SSPL).

### À partir d'un dump de la base de données

Télécharger le fichier de dump de la base de données et placer le dans : `dump/mongo_dump.archive`

Lancer l'importation des données :

   ``` bash
   docker compose exec -T mongo mongorestore --archive --drop < ./dump/mongo_dump.archive
   ```

### Scripts utilitaires

Le projet dispose de nombreux scripts pour la gestion, la synchronisation et la maintenance des données.

**Principaux scripts :**
- `reprocess-all-attachments` : retraite tous les attachments
- `reconsolidate-all-dossiers` : force la reconsolidation de tous les dossiers
- `trigger-scheduled-job` : lance manuellement un job schedulé (cron)
- `validate-declaration-file` : valide un fichier avant import

### Emails

Sur l'environnement local, les emails sont capturés par `Mailpit`

```
http://localhost:8025/
```

📖 **Documentation complète :** Voir [docs/scripts.md](docs/scripts.md) pour la liste exhaustive des scripts, leurs usages et workflows recommandés.

## Lancer l'application

### 1. Démarrer l'API HTTP

```bash
npm start
```

### 2. Démarrer les workers BullMQ (dans un autre terminal)

```bash
npm run start:worker
```

Les workers gèrent les tâches planifiées et à la demande :

**Tâches planifiées (cron) :**
- **consolidate-dossiers-maintenance** : Reconsolidation des dossiers marqués (1x/jour à 4h)

**Tâches à la demande (déclenchées par l'API) :**
- **process-attachment** : Traite une pièce jointe spécifique
- **consolidate-dossier** : Consolide un dossier spécifique

Voir [lib/queues/README.md](lib/queues/README.md) pour plus de détails sur l'architecture BullMQ.

### Architecture

L'application est composée de deux processus séparés :
- **api.js** : Serveur HTTP Express (port 5000)
- **worker.js** : Workers BullMQ pour les tâches planifiées et à la demande

Les deux communiquent via Redis pour la gestion des files d'attente. Chaque processus peut être scalé indépendamment.

### 4. Monitoring avec BullBoard (optionnel)

Si vous définissez la variable `BULLBOARD_PASSWORD` dans votre `.env`, un dashboard de monitoring sera disponible sur :

```
http://localhost:5000/admin/queues
```

**Authentification :** Basic Auth (n'importe quel username, mot de passe = valeur de `BULLBOARD_PASSWORD`)

**Fonctionnalités :**
- Visualiser l'état des queues en temps réel
- Consulter les jobs en attente, actifs, réussis, échoués
- Relancer manuellement des jobs échoués
- Voir les détails et logs de chaque job
- Nettoyer les jobs terminés

## Linter

Le projet utilise **xo** comme linter pour assurer la qualité du code. Exécutez la commande suivante pour lancer le linter :

```bash
npm run lint
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
npm run lint:openapi
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

