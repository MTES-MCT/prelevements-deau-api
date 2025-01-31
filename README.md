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

Ce script efface le contenu de la base de données MongoDB (si présente) et lancera la récupération des dossiers déposés sur Démarches Simplifiées. Ces dossiers seront traités : 
1. Validation des données
2. Stockage en ligne des fichiers en pièce jointe
3. Enregistrement en base de donnée des dossiers

```bash
yarn init-db
```

## Scripts

**files-validation** :

Lance une validation de tous les fichiers de données issue de Démarches Simplifiées.

**update-db** :

Récupère tous les dossiers déposés sur Démarches Simplifiées qui n'ont pas encore étaient collectés puis les traites.

**extract-preleveurs** :

Extrait la liste des préleveurs à partir des informations contenues dans les dossiers (civilité, nom, prénom, email, etc.).

> **Stocké dans** : `/data/preleveurs.csv`

**extract-points-prelevement** :

**Prérequis** : `get-dossiers`, `get-files`

Extrait les points de prélèvement à partir des dossiers et des fichiers Excel.

> **Stocké dans** : `/data/points-prelevement.csv`

## Récupérer les fichiers CSV :

- Remplir les informations dans le fichier `.env`
- Lancer le script de téléchargement :
```bash
node download-csv
```

## Linter

Le projet utilise **xo** comme linter pour assurer la qualité du code. Exécutez la commande suivante pour lancer le linter :

```bash
yarn lint
```

## Prérequis

- Node.js version 22 LTS (22.11+)

## License

Ce projet est sous licence MIT. Voir le fichier LICENSE pour plus de détails.

