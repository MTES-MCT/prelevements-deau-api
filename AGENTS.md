## Stack
Node.js 24 (ESM), MongoDB 4.4, Redis, BullMQ v5, Express v5, AVA, XO, c8

Internal packages:
- `@fabnum/prelevements-deau-timeseries-parsers`: file validation & timeseries extraction

## Code Style (XO)
```javascript
import {ObjectId} from 'mongodb'
import mongo from './lib/util/mongo.js'

export async function getDossier(dossierId) {
  const db = mongo.db
  const dossier = await db.collection('dossiers').findOne({
    _id: new ObjectId(dossierId)
  })

  if (!dossier) {
    throw createError(404, 'Dossier non trouvé')
  }

  return dossier
}
```
No semicolons • 2 spaces • `snake_case` for DB • No trailing commas • `.js` extensions • `async/await`

## Architecture
```
lib/
├── models/          # MongoDB CRUD
├── handlers/        # Route logic
├── validation/      # Joi schemas
├── services/        # Business logic
├── queues/          # BullMQ (config, workers, jobs)
└── util/            # mongo, errors

api.js (HTTP) ←→ worker.js (BullMQ) → Redis + MongoDB
```

## Essentials

**MongoDB**: `mongo.db` singleton, `new ObjectId()`, projections
```javascript
await db.collection('dossiers').findOne(
  {_id: new ObjectId(id)},
  {projection: {numero: 1}}
)
```

**Validation**: Joi in `lib/validation/`
```javascript
const {error} = schema.validate(req.body)
if (error) throw createError(400, error.message)
```

**BullMQ**: See `lib/queues/README.md`
- Cron: sync DS (1h), maintenance (3h), consolidation (4h)
- On-demand: `addJobProcessAttachment(id)`, `addJobConsolidateDossier(id)`

**File parsing**: `@fabnum/prelevements-deau-timeseries-parsers`
```javascript
const {data, errors} = await extractMultiParamFile(buffer)
if (!data) throw createError(400, 'Invalid', {errors})
```

## Commands
```bash
npm start              # API
npm run start:worker   # Workers
npm run lint           # XO
npm test               # AVA
```

## Docs
- `README.md`: complete guide
- `lib/queues/README.md`: BullMQ
- `docs/openapi.yaml`: API spec
- `packages/timeseries-parsers/docs/`: validation

## Rules
- Errors via `http-errors`
- ESM with `.js` extensions
- MongoDB via `mongo.db`
- npm workspaces (`packages/*`)
- **PRs in French**
- **Conventional commits**
