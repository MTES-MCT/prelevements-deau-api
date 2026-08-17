# BullMQ

Ce dossier contient les files d'attente et workers BullMQ.

## Services

BullMQ utilise Redis comme backend. En local, Redis est démarré par `docker compose up -d`.

## Files

Les files déclarées dans `config.js` sont :

| Queue | Producteur | Consommateur |
| --- | --- | --- |
| `process-declaration` | API | orchestration |
| `process-api-import` | API/scripts | worker API |
| `reconstruct-volumes-from-index-for-point` | API/services | worker API |
| `sync-sandre-alert-zones` | Scheduler quotidien à 04:30 | worker API |

`WORKER_JOBS` limite les jobs consommés par `worker.js` aux traitements internes à l'API.

## Fichiers

- `config.js` : connexion Redis, options par défaut, création des queues.
- `jobs.js` : helpers d'ajout de jobs.
- `workers.js` : création des workers locaux.
- `scheduler.js` : synchronisation des schedulers BullMQ.
- `board.js` : montage BullBoard.

## Options par défaut

- `attempts: 3`
- backoff exponentiel de 5 secondes
- suppression automatique des jobs réussis
- conservation des jobs échoués pour investigation

## BullBoard

Si `BULLBOARD_PASSWORD` est défini, BullBoard est disponible sur :

```text
http://localhost:5000/admin/queues
```

L'authentification est en Basic Auth. Le nom d'utilisateur est libre.
