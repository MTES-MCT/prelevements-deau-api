import '../lib/config/env.js'
import process from 'node:process'
import pg from 'pg'
import {getPostgresConnectionOptions} from '../db/connection-options.js'
import {importPtge} from '../lib/services/ptge-import.js'

const client = new pg.Client(getPostgresConnectionOptions(process.env.DATABASE_URL))
try {
  const args = process.argv.slice(2)
  if (args.length !== 1 || !['--dry-run', '--apply'].includes(args[0])) {
    throw new Error('Usage : npm run import:ptge -- --dry-run ou --apply.')
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL est requis pour importer les PTGE.')
  await client.connect()
  console.log(JSON.stringify(await importPtge(client, {apply: args[0] === '--apply'}), null, 2))
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  await client.end()
}
