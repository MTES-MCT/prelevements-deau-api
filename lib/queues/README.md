# Architecture BullMQ

Ce dossier contient l'implémentation du système de files d'attente et de tâches planifiées basé sur [BullMQ](https://docs.bullmq.io/).

## Vue d'ensemble

Le système utilise **BullMQ v5** avec Redis comme backend pour gérer deux types de tâches :
- **Tâches planifiées (cron)** : exécutées automatiquement selon un calendrier
- **Tâches à la demande** : déclenchées par l'API ou d'autres processus

## Architecture

```
┌─────────────┐       ┌─────────────┐
│   api.js    │       │  worker.js  │
│  (HTTP API) │       │  (Workers)  │
└──────┬──────┘       └──────┬──────┘
       │                     │
       │  addJob()           │  processJob()
       ├─────────────────────┤
       │                     │
       └──────┬──────────────┘
              │
        ┌─────▼─────┐
        │   Redis   │
        │  (Queues) │
        └───────────┘
```

## Fichiers

### `config.js`
Configuration centrale : connexion Redis, définition des files d'attente et des jobs.

**Exports :**
- `getConnection()` : Instance Redis partagée
- `getQueue(name)` : Crée/récupère une queue
- `JOBS` : Liste de tous les jobs (avec/sans cron)

**Jobs configurés :**
| Nom | Type | Fréquence | Description |
|-----|------|-----------|-------------|
| `sync-updated-dossiers` | Cron | Toutes les heures | Synchronise les dossiers modifiés depuis DS |
| `process-attachments-maintenance` | Cron | 1x/jour à 3h | Retraite les attachments en erreur |
| `consolidate-dossiers-maintenance` | Cron | 1x/jour à 4h | Reconsolide les dossiers marqués |
| `process-attachment` | On-demand | - | Traite une pièce jointe spécifique |
| `consolidate-dossier` | On-demand | - | Consolide un dossier spécifique |

### `scheduler.js`
Planificateur qui configure les jobs récurrents au démarrage du worker.

**Export :**
- `startScheduler()` : Initialise les crons via `upsertJobScheduler`

**Note importante :** Avec BullMQ v5, les options de répétition sont passées directement (pas dans un objet `repeat`).

### `workers.js`
Démarrage des workers qui consomment les jobs des queues.

**Exports :**
- `startWorkers()` : Crée un Worker par queue

**Handlers :**
Chaque job est mappé à une fonction de traitement :
```javascript
{
  'sync-updated-dossiers': syncUpdatedDossiers,
  'process-attachment': async job => processAttachment(job.data.attachmentId),
  // ...
}
```

**Concurrence :**
- `process-attachment` : 1 (séquentiel, pour éviter conflits d'écriture)
- `consolidate-dossier` : 4 (parallélisation possible)
- Autres : 1 (par défaut)

### `jobs.js`
Fonctions utilitaires pour créer des jobs à la demande.

**Exports :**
- `addJobProcessAttachment(attachmentId)` : Déclenche le traitement d'un attachment
- `addJobConsolidateDossier(dossierId)` : Déclenche la consolidation d'un dossier

**Déduplication :**
Les jobs utilisent un `jobId` stable (`attachment-${id}` ou `dossier-${id}`) pour éviter les doublons.

**Debounce :**
- `process-attachment` : 2s (évite les traitements multiples lors de modifications rapides)
- `consolidate-dossier` : 5s

## Utilisation

### Démarrer les workers

```bash
yarn start:worker
```

Cette commande :
1. Se connecte à MongoDB
2. Configure les schedulers (crons)
3. Démarre les workers pour chaque queue

### Ajouter un job depuis le code

```javascript
import {addJobProcessAttachment} from './lib/queues/jobs.js'

// Déclenche le traitement d'un attachment
await addJobProcessAttachment('67890abcdef')
```

### Mode test

En mode test (`NODE_ENV=test`), `getConnection()` retourne `null` et les jobs ne sont pas créés (évite les dépendances Redis).

## Flux de traitement

### 1. Synchronisation DS → Traitement → Consolidation

```
sync-updated-dossiers (cron)
    ↓
Récupère dossiers modifiés depuis DS
    ↓
Pour chaque attachment nouveau/modifié
    ↓
addJobProcessAttachment(attachmentId)
    ↓
Worker process-attachment
    ↓
Parse fichier → Crée series/series_values
    ↓
addJobConsolidateDossier(dossierId)
    ↓
Worker consolidate-dossier
    ↓
Crée integrations_journalieres
```

### 2. Maintenance nocturne

```
3h : process-attachments-maintenance
    ↓
Retraite tous les attachments en erreur/warning
    ↓
4h : consolidate-dossiers-maintenance
    ↓
Reconsolide tous les dossiers non consolidés
```

## Retry & Gestion d'erreurs

**Configuration par défaut** (dans `config.js`) :
- `attempts: 3` (3 tentatives max)
- `backoff: exponential, 5000ms` (délai progressif : 5s, 25s, 125s)
- `removeOnComplete: true` (supprime jobs réussis automatiquement)
- `removeOnFail: false` (conserve jobs en erreur pour investigation)

Les jobs échoués restent dans Redis jusqu'à suppression manuelle ou retraitement.

## Monitoring

### Via CLI (bullmq-cli)

```bash
# Installer l'outil (optionnel)
npm install -g bullmq-cli

# Voir les jobs en attente
bullmq jobs sync-updated-dossiers waiting

# Voir les jobs échoués
bullmq jobs process-attachment failed
```

### Via code

```javascript
import {getQueue} from './lib/queues/config.js'

const queue = getQueue('process-attachment')
const failedJobs = await queue.getFailed()
console.log(failedJobs)
```

## Dépendances

- **bullmq** v5.61.0+ : Librairie de gestion de queues
- **ioredis** v5.8.1+ : Client Redis
- **redis-server** : Instance Redis locale ou distante

## Variables d'environnement

```bash
# URL de connexion Redis (optionnel)
REDIS_URL=redis://localhost:6379

# Mode test (désactive Redis)
NODE_ENV=test
```

## Évolutions possibles

- [ ] Dashboard de monitoring (BullBoard)
- [ ] Métriques Prometheus/Grafana
- [ ] Jobs prioritaires (via options `priority`)
- [ ] Pause/reprise de queues dynamique
- [ ] Notifications d'échec (email/Slack)
- [ ] Nettoyage automatique des jobs anciens

## Ressources

- [Documentation BullMQ](https://docs.bullmq.io/)
- [Guide de migration v4 → v5](https://docs.bullmq.io/guide/migration-to-v5)
- [Patterns de retry](https://docs.bullmq.io/guide/retrying-failing-jobs)
