# Prélèvement d’Eau Back

Ce projet vise à collecter, organiser et analyser les données de prélèvement d'eau provenant de Démarche Simplifiée. Il fournit divers scripts pour récupérer les dossiers de prélèvements, extraire des données précises et générer des rapports.

## Installation

Ce projet utilise `yarn` comme gestionnaire de paquets. Assurez-vous d'avoir Node.js (version ≥ 20.9) installé avant de commencer.

1. Installez les dépendances :

   ```bash
   yarn install
   ```

2. Créez un fichier `.env` en utilisant `.env.example` comme modèle et complétez la valeur `API_TOKEN`.

## Importer la base de données

>_Vous devez avoir postgreSQL installé sur votre machine_

- Remplir les champs dans votre fichier `.env` :

```.env
POSTGRES_USER=
POSTGRES_HOST=
POSTGRES_DB=
```

- Lancer le script `scripts/import-pgsql-dump.sh` en précisant le chemin vers le fichier `.sql` :
```bash
scripts/import-pgsql-dump.sh chemin/vers/mon/fichier/sql
```

## Scripts

**get-dossiers** :

Récupère tous les dossiers déposés sur Démarche Simplifiée (toutes les informations disponibles) en utilisant l'API de Démarche Simplifiée. Voir la documentation : [API Démarche Simplifiée](https://doc.demarches-simplifiees.fr/~gitbook/pdf).

> **Stocké dans** : `/data/dossiers.json`

**get-files** :

**Prérequis** : `get-dossiers`

Récupère toutes les pièces jointes déposées par les préleveurs.

> **Stocké dans** : répertoire `/data/files`

> ⚠️ Attention : les liens vers les fichiers obtenus par `get-dossiers` ne sont valables que pendant 1h. Assurez-vous d'exécuter `get-files` avant l'expiration de ce délai.

**extract-preleveurs** :

Extrait la liste des préleveurs à partir des informations contenues dans les dossiers (civilité, nom, prénom, email, etc.).

> **Stocké dans** : `/data/preleveurs.csv`

**extract-points-prelevement** :

**Prérequis** : `get-dossiers`, `get-files`

Extrait les points de prélèvement à partir des dossiers et des fichiers Excel.

> **Stocké dans** : `/data/points-prelevement.csv`

**extract-xlsx-data** :

**Prérequis** : `get-files`

Extrait les données de prélèvement à partir des fichiers Excel, puis génère 4 fichiers CSV, chacun correspondant à une échelle de temps (15 minutes, 1 jour, trimestre, autre). Ces fichiers permettent de visualiser les données de manière structurée et adaptée à chaque échelle de temps.

> **Stocké dans** : `/data/files/output/<nom_fichier>_<échelle>.csv`

> ⚠️ Note : Ce script ne gère pas encore les fichiers de prélèvements par camion citerne.

Ce script produit également un rapport d'erreurs pour les fichiers qui n'ont pas pu être lus.

> Stocké dans : /data/files/output/reports.json

## Linter

Le projet utilise **xo** comme linter pour assurer la qualité du code. Exécutez la commande suivante pour lancer le linter :

```bash
yarn lint
```

## Prérequis

- Node.js version ≥ 20.9
- MongoDB
- PostgreSQL 17.2
- Postgis 3.5.1

## License

Ce projet est sous licence MIT. Voir le fichier LICENSE pour plus de détails.

