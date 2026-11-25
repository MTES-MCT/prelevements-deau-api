# BullMQ

Ce dossier contient les files d'attente et workers BullMQ 6, avec Redis en RESP2.

Avant le premier déploiement de cette version, suivre le [contrôle et la bascule coordonnée API/worker/orchestrateur](../../docs/bullmq-6-migration.md). Les anciennes planifications `repeat` doivent être converties avec BullMQ 5, sans purger les tâches.

## Services

BullMQ utilise Redis comme backend. En local, Redis est démarré par `docker compose up -d`.

## Files

Le catalogue complet des files et planifications est dans [`config.js`](config.js).
Quelques exemples :

| Queue | Producteur | Consommateur |
| --- | --- | --- |
| `process-declaration` | orchestration, sur webhook signé de l’API | orchestration |
| `process-api-import` | API/scripts | worker API |
| `send-declaration-receipts` | Scheduler chaque minute | worker API |
| `reconstruct-volumes-from-index-for-point` | API/services | worker API |
| `sync-sandre-alert-zones` | Scheduler quotidien à 04:30 | worker API |

`WORKER_JOBS` limite les jobs consommés par `worker.js` aux traitements internes à l'API.

### Activer les mails récapitulatifs

Le worker envoie les récapitulatifs enregistrés dans `DeclarationReceipt` après le déploiement de la migration. Il utilise `FRONT_URL` pour les liens et `SMTP_FROM` pour l’expéditeur.

- En local, utiliser Mailpit avec `DECLARATION_RECEIPT_SMTP_HOST=localhost` et `DECLARATION_RECEIPT_SMTP_PORT=1025` (voir `.env.example`).
- Sur testing, définir sur le **worker** `DECLARATION_RECEIPT_SMTP_HOST` et `DECLARATION_RECEIPT_SMTP_PORT` avec le relais prévu pour la recette. Définir `DECLARATION_RECEIPT_SUBJECT_PREFIX="[TESTING] "` pour reprendre le préfixe de l’API. Il remplace `MAIL_SUBJECT_PREFIX` pour ces mails. Cette configuration ne modifie pas les autres envois.
- Pour utiliser le serveur SMTP habituel, définir explicitement le même hôte que `SMTP_HOST`. Le port par défaut est `SMTP_PORT`. Pour un autre hôte, renseigner `DECLARATION_RECEIPT_SMTP_USER` et `DECLARATION_RECEIPT_SMTP_PASSWORD` uniquement si le relais demande une authentification.

Si l’hôte n’est pas configuré, les messages attendent en base et le worker le signale dans ses logs. Le prochain passage les reprend après activation. Les erreurs temporaires donnent lieu à trois tentatives au total. Les états `FAILED` et `UNKNOWN` ainsi que `failureCode` permettent d’identifier les incidents, sans stocker la réponse brute du SMTP. Pour `UNKNOWN`, vérifier chez le relais si le message a été accepté à l’aide de son identifiant `<declaration-ID_DU_MAIL@partageonsleau.beta.gouv.fr>`.

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
