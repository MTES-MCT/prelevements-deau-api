# Prélèvements d'eau API

API Node.js/Express de Partageons l'eau.

Elle gère les déclarants, les déclarations, les fichiers déposés, les séries temporelles, les référentiels et les imports automatisés. Les données applicatives sont stockées dans PostgreSQL/PostGIS avec Prisma. Les fichiers sont stockés dans un bucket compatible S3. Les traitements asynchrones passent par Redis/BullMQ.

Le parsing des déclarations déposées est réalisé par l'orchestration. Les imports historiques BLV ont été retirés de l'API car les données ont déjà été importées.

## Prérequis

- Node.js 24 LTS
- npm
- Docker avec Docker Compose

## Installation

```bash
npm install
cp .env.example .env
```

Complétez ensuite les variables obligatoires dans `.env`.

## Services locaux

```bash
docker compose up -d
```

Le compose local démarre PostgreSQL/PostGIS, Redis, MinIO et Mailpit.

Créez les buckets MinIO nécessaires :

```bash
docker compose exec minio mc alias set local http://localhost:9000 minio minio123
docker compose exec minio mc mb local/prelevements-deau-documents
docker compose exec minio mc mb local/prelevements-deau-declarations
docker compose exec minio mc mb local/prelevements-deau-exports
```

Appliquez les migrations Prisma :

```bash
npm run migrate:prisma
```

Mailpit est disponible en local sur :

```text
http://localhost:8025/
```

## Lancer l'application

API HTTP :

```bash
npm start
```

Workers BullMQ :

```bash
npm run start:worker
```

Les workers traitent notamment :

- `process-api-import`
- `reconstruct-volumes-from-index-for-point`

La queue `process-declaration` est exposée pour le traitement des déclarations consommé par l'orchestration.

## Scripts npm

- `npm start` : démarre l'API Express.
- `npm run start-dev` : démarre l'API avec Nodemon.
- `npm run start:worker` : démarre les workers BullMQ.
- `npm run import-bvtech` : importe les données BVTech.
- `npm run migrate:prisma` : applique les migrations Prisma.
- `npm run user:create` : crée un utilisateur.
- `npm run lint` : lance XO.
- `npm run lint:openapi` : valide la spec OpenAPI.
- `npm test` : lance les tests AVA.
- `npm run coverage` : lance les tests avec c8.
- `npm run coverage:report` : génère un rapport de couverture HTML et texte.

## BullBoard

Si `BULLBOARD_PASSWORD` est défini, le dashboard BullBoard est disponible sur :

```text
http://localhost:5000/admin/queues
```

L'authentification est en Basic Auth. Le nom d'utilisateur est libre, le mot de passe est la valeur de `BULLBOARD_PASSWORD`.

## Documentation API

La spec OpenAPI est dans [docs/openapi.yaml](docs/openapi.yaml).

```bash
npm run lint:openapi
```

## Tests

```bash
npm test
npm run coverage
```

## Licence

MIT.
