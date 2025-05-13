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

Récupère tous les dossiers déposés sur Démarches Simplifiées qui n'ont pas encore étaient collectés puis les traites.

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

## License

Ce projet est sous licence MIT. Voir le fichier LICENSE pour plus de détails.

