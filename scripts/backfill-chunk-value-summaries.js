import process from 'node:process'
import {parseArgs} from 'node:util'
import pg from 'pg'
import {getPostgresConnectionOptions} from '../db/connection-options.js'
import {validateTestingAdminDatabaseUrl, assertConnectedTestingAdminDatabase} from './network/testing-database-target.js'
import {validateProdAdminDatabaseUrl, assertConnectedProdAdminDatabase} from './network/prod-database-target.js'
import {backfillChunkValueSummaries} from './lib/chunk-value-summary-backfill.js'

// No automatic dotenv load: a maintenance operation must choose its target
// explicitly, including when run from a developer's checkout.
const {values} = parseArgs({options: {
  environment: {type: 'string'}, apply: {type: 'boolean', default: false},
  'batch-size': {type: 'string', default: '25'}, 'max-batches': {type: 'string', default: '1000'},
  after: {type: 'string'}
}})
const guards = {
  testing: [validateTestingAdminDatabaseUrl, assertConnectedTestingAdminDatabase],
  prod: [validateProdAdminDatabaseUrl, assertConnectedProdAdminDatabase]
}[values.environment]
if (!guards) throw new Error('Choisir explicitement --environment testing ou prod.')
guards[0](process.env.DATABASE_URL)
const client = new pg.Client(getPostgresConnectionOptions(process.env.DATABASE_URL, {
  application_name: 'pe-chunk-value-summary-backfill', connectionTimeoutMillis: 10000
}))
try {
  await client.connect()
  await guards[1](client)
  const report = await backfillChunkValueSummaries(client, {
    apply: values.apply, batchSize: Number(values['batch-size']), maxBatches: Number(values['max-batches']),
    after: values.after ?? null, onProgress: progress => console.log(JSON.stringify({event: 'committed-batch', ...progress}))
  })
  console.log(JSON.stringify({event: 'summary', ...report}))
  if (values.apply && !report.complete) process.exitCode = 2
} catch (error) {
  // Never serialize a PostgreSQL error carrying query parameters or credentials.
  console.error(JSON.stringify({event: 'failed', code: error.code ?? 'BACKFILL_FAILED'}))
  process.exitCode = 1
} finally {
  await client.end()
}
