## Stack

Node.js 24, ESM, Express 5, Prisma/PostgreSQL/PostGIS, Redis, BullMQ v5, S3 compatible storage, AVA, XO, c8.

Internal package:

- `@fabnum/prelevements-deau-timeseries-parsers`: validation and timeseries extraction for declaration files.

## Code Style

No semicolons. Two spaces. Explicit `.js` extensions. Prefer `async`/`await`. Keep API/database payloads aligned with Prisma field names.

```javascript
import {prisma} from './db/prisma.js'

export async function getDeclaration(declarationId) {
  return prisma.declaration.findUnique({
    where: {id: declarationId},
    include: {files: true}
  })
}
```

## Architecture

```text
lib/
├── handlers/        # Express route logic
├── models/          # Prisma-facing model helpers
├── services/        # Business logic
├── validation/      # Joi schemas
├── queues/          # BullMQ config, workers, jobs
└── util/            # shared helpers

api.js (HTTP) -> Redis/BullMQ -> worker.js
                 PostgreSQL/PostGIS via Prisma
                 S3 compatible object storage
```

## Essentials

**Database**: use Prisma from `db/prisma.js`.

```javascript
const declaration = await prisma.declaration.findUnique({
  where: {id},
  include: {files: true}
})
```

**Validation**: Joi schemas live in `lib/validation/`.

```javascript
const {error, value} = schema.validate(req.body)
if (error) {
  throw createError(400, error.message)
}
```

**BullMQ**: see `lib/queues/README.md`.

Current queues:

- `process-declaration`
- `process-api-import`
- `reconstruct-volumes-from-index-for-point`

**File parsing**: use `@fabnum/prelevements-deau-timeseries-parsers`.

```javascript
const {data, errors} = await extractMultiParamFile(buffer)
if (!data) {
  throw createError(400, 'Fichier invalide', {errors})
}
```

## Commands

```bash
npm start
npm run start:worker
npm run lint
npm test
npm run coverage
```

## Rules

- Errors via `http-errors`.
- PRs and user-facing wording in French.
- Conventional commits when committing.
- Do not reintroduce legacy Mongo/DS import code.
