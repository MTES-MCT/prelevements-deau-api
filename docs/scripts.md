# Scripts utilitaires

Ce document décrit l'ensemble des scripts disponibles pour gérer les données et les traitements de l'application.

## Table des matières

- [Initialisation](#initialisation)
- [Gestion des utilisateurs](#gestion-des-utilisateurs)
- [Synchronisation des dossiers](#synchronisation-des-dossiers)
- [Maintenance et retraitement](#maintenance-et-retraitement)
- [Validation de fichiers](#validation-de-fichiers)
- [Gestion des jobs BullMQ](#gestion-des-jobs-bullmq)
- [Workflows recommandés](#workflows-recommandés)
- [Notes techniques](#notes-techniques)

---

## Initialisation

### `download-csv`

Télécharge les fichiers CSV de référence depuis la source configurée.

```bash
npm run download-csv
```

**Prérequis :** Variable d'environnement `CSV_SOURCE_URL` configurée.

### `import-reference-data`

Importe les données de référence (BSS, BNPE, communes, etc.) depuis les fichiers CSV.

```bash
npm run import-reference-data <chemin-dossier-csv>
```

**Exemple :**
```bash
npm run import-reference-data ./data
```

---

## Gestion des utilisateurs

Ces scripts permettent de gérer les utilisateurs et leurs rôles d'accès aux territoires.

### `user:create`

Crée un nouvel utilisateur avec un rôle initial sur un territoire.

```bash
npm run user:create -- --email=<email> --nom=<nom> --prenom=<prenom> [--structure=<structure>] [--territoire=<code>] [--role=<reader|editor>]
```

**Exemple :**
```bash
npm run user:create -- \
  --email=alice.dupont@example.com \
  --nom=Dupont \
  --prenom=Alice \
  --structure="DREAL Réunion" \
  --territoire=DEP-974 \
  --role=editor
```

### `user:add-role`

Ajoute un rôle sur un territoire à un utilisateur existant.

```bash
npm run user:add-role -- --email=<email> --territoire=<code> --role=<reader|editor>
```

**Exemple :**
```bash
npm run user:add-role -- \
  --email=alice.dupont@example.com \
  --territoire=DEP-971 \
  --role=reader
```

### `user:remove-role`

Retire un rôle sur un territoire d'un utilisateur.

```bash
npm run user:remove-role -- --email=<email> --territoire=<code> --role=<reader|editor>
```

**Exemple :**
```bash
npm run user:remove-role -- \
  --email=alice.dupont@example.com \
  --territoire=DEP-971 \
  --role=reader
```

### `user:list`

Liste tous les utilisateurs avec leurs rôles.

```bash
npm run user:list
```

---

## Maintenance et retraitement

### `resync-all-dossiers`

Récupère **tous** les dossiers depuis Démarches Simplifiées et les traite (première synchronisation ou resynchronisation complète).

```bash
npm run resync-all-dossiers
```

**Actions effectuées :**
1. Récupération de tous les dossiers DS
2. Validation des données
3. Stockage des fichiers sur S3
4. Enregistrement en base de données
5. Traitement des pièces jointes
6. Consolidation des dossiers

**Utilisation :**
- Première synchronisation après installation
- Resynchronisation complète après modification majeure de la logique de traitement
- Récupération après suppression des collections

⚠️ **Attention :** Cette opération peut être longue selon le nombre de dossiers.

### `reconsolidate-all-dossiers`

Force la reconsolidation de **tous** les dossiers en les marquant comme non consolidés et en créant des jobs de consolidation.

```bash
npm run reconsolidate-all-dossiers
```

**Utilisation :** Après modification de la logique de consolidation ou correction de données de référence.

**Effet :**
- Retire le flag `consolidatedAt` de tous les dossiers
- Crée un job `consolidate-dossier` pour chaque dossier
- Les jobs sont traités par le worker BullMQ

### `reset-integrations`

Réinitialise complètement toutes les intégrations journalières.

```bash
npm run reset-integrations --force
```

**⚠️ Opération destructive** : Nécessite le flag `--force` pour confirmer.

**Actions effectuées :**
1. Vide complètement la collection `integrations_journalieres`
2. Réinitialise le champ `computed.integratedDays` de toutes les séries (mis à `[]`)

**Utilisation :**
- Après modification de la logique d'intégration
- Pour résoudre des problèmes d'intégrité des données d'intégration
- Pour repartir à zéro sur les intégrations

**Étape suivante :** Lancer `npm run reconsolidate-all-dossiers` pour reconsolider tous les dossiers et recalculer les intégrations.

### `reprocess-all-attachments`

Force le retraitement de **tous** les attachments.

```bash
npm run reprocess-all-attachments
```

**Utilisation :** Après mise à jour des parsers de fichiers ou correction de bugs de traitement.

**Effet :**
- Récupère tous les attachments avec `processed: false`
- Réinitialise leur statut de traitement
- Crée un job `process-attachment` pour chaque attachment
- Les jobs sont traités par le worker BullMQ

---

## Validation de fichiers

### `validate-declaration-file`

Valide un fichier de déclaration (camion citerne ou multi-paramètres) sans l'importer.

```bash
npm run validate-declaration-file <chemin-fichier> [type]
```

**Paramètres :**
- `<chemin-fichier>` : Chemin vers le fichier à valider
- `[type]` : Type de fichier (optionnel)
  - `camion-citerne` : Fichier camion citerne
  - `multi-params` : Fichier multi-paramètres (défaut)

**Exemples :**
```bash
npm run validate-declaration-file ./test.csv
npm run validate-declaration-file ./camion.csv camion-citerne
```

**Sortie :** Affiche les erreurs et avertissements de validation détectés.

---

## Gestion des jobs BullMQ

### `trigger-scheduled-job`

Lance manuellement et immédiatement n'importe quel job schedulé (cron).

```bash
npm run trigger-scheduled-job <nom-du-job>
```

**Jobs disponibles :**
- `process-attachments-maintenance` : Retraitement des attachments en erreur
- `consolidate-dossiers-maintenance` : Reconsolidation des dossiers non consolidés

**Exemples :**
```bash
# Lancer la maintenance des attachments
npm run trigger-scheduled-job process-attachments-maintenance

# Lancer la maintenance de consolidation
npm run trigger-scheduled-job consolidate-dossiers-maintenance
```

**Utilisation :** Test, debug, ou exécution manuelle sans attendre le cron.

**Monitoring :** Le script affiche l'ID du job créé et le lien vers BullBoard pour suivre l'exécution.

Sans argument, le script affiche la liste des jobs schedulés disponibles :
```bash
npm run trigger-scheduled-job
```

### `run-job-with-logs`

Exécute directement un job handler spécifique avec logs en temps réel, **sans passer par BullMQ**.

```bash
npm run run-job-with-logs <nom-job> <donnees-json>
```

**Jobs disponibles :**
- `consolidate-dossier` : Consolidation d'un dossier spécifique

**Exemples :**
```bash
# Consolider un dossier avec logs détaillés
npm run run-job-with-logs consolidate-dossier '{"dossierId":"6908db261a6a10831363dde3"}'
```

**Utilisation :** Debug, investigation de problèmes sur un dossier/attachment spécifique, ou test de modifications du code de consolidation.

**Avantages :**
- Exécution synchrone avec logs en temps réel dans le terminal
- Pas besoin de lancer le worker
- Pas de timeout
- Idéal pour le développement et le débogage

⚠️ **Note :** Ce script exécute directement le handler sans la queue BullMQ, il ne doit pas être utilisé en production pour les traitements de masse.

---

## Workflows recommandés

### Première installation

1. Télécharger les CSV de référence
2. Importer les données de référence
3. Importer les données du territoire
4. Synchroniser tous les dossiers DS

```bash
npm run download-csv
npm run import-reference-data ./data
npm run resync-all-dossiers
```

### Après mise à jour du code de validation ou des parsers

1. Retraiter tous les attachments
2. (Optionnel) Reconsolider tous les dossiers si la logique de consolidation a changé

```bash
npm run reprocess-all-attachments
npm run reconsolidate-all-dossiers  # Si nécessaire
```

### Après modification de la logique d'intégration

1. Réinitialiser toutes les intégrations
2. Reconsolider tous les dossiers pour recalculer les intégrations

```bash
npm run reset-integrations -- --force
npm run reconsolidate-all-dossiers
```

### Après modification majeure de la logique de traitement

Resynchroniser complètement depuis Démarches Simplifiées :

```bash
npm run resync-all-dossiers
```

**Avantage :** Récupère les dernières données DS et applique toute la logique de traitement.

### Test d'un fichier avant import

```bash
npm run validate-declaration-file ./mon-fichier.csv
```

---

## Notes techniques

- Tous les scripts nécessitent une connexion à MongoDB et Redis
- Les scripts de maintenance créent des jobs BullMQ qui sont traités par le worker
- Les connexions sont automatiquement fermées à la fin de l'exécution
- Les erreurs sont affichées dans la console avec des compteurs de succès/échec
- Voir [lib/queues/README.md](../lib/queues/README.md) pour plus de détails sur l'architecture des jobs
