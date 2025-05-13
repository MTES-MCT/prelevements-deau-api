# Prélèvement d’Eau Back

Ce projet vise à collecter, organiser et analyser les données de prélèvement d'eau provenant de Démarche Simplifiée. Il fournit divers scripts pour récupérer les dossiers de prélèvements, extraire des données précises et générer des rapports.

## Installation

Ce projet utilise `yarn` comme gestionnaire de paquets. Assurez-vous d'avoir Node.js (version ≥ 22.11) installé avant de commencer.

1. Installez les dépendances :

   ```bash
   yarn install
   ```

2. Créez un fichier `.env` en utilisant `.env.example` comme modèle et complétez la valeur `API_TOKEN`.

## Initialisation

**Initialiser la base de donneés** :

Ce script lancera la récupération des dossiers déposés sur Démarches Simplifiées. Ces dossiers seront traités :
1. Validation des données
2. Stockage en ligne des fichiers en pièce jointe
3. Enregistrement en base de donnée des dossiers

```bash
yarn update-db
```

## Scripts

**update-db** :

Récupère et traite tous les dossiers déposés sur Démarches Simplifiées qui n'ont pas encore été collectés.

### Récupérer les fichiers CSV :

- Remplir les informations dans le fichier `.env` (`CSV_SOURCE_URL`):
- Lancer le script de téléchargement :
```bash
yarn download-csv
```
- Puis importer les fichiers dans la base MongoDB :
```bash
yarn mongo-import
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
| `/points-prelevement/:id`| **DELETE** * | *Supprime le point de prélèvement* |
| `/points-prelevement/:id/exploitations`| **GET** | *Retourne la liste des exploitations du point* |
| `/exploitations:id`| **GET** | *Retourne l'exploitation* |
| `/exploitations/:id/volumes-preleves`| **GET** | *Retourne les volumes prélevés de l'exploitations* |
| `/beneficiaires`| **GET** | *Retourne la liste des préleveurs* |
| `/beneficiaires/:id`| **GET** | *Retourne le préleveur* |
| `/beneficiaires/:id/points-prelevement`| **GET** | *Retourne les points exploités par le préleveur* |
| `/stats`| **GET** | *Retourne les données pour la page `/statistiques`* |

> [!info]
> *Les routes avec une `*` sont protégées par un jeton*

---

## License

Ce projet est sous licence MIT. Voir le fichier LICENSE pour plus de détails.

