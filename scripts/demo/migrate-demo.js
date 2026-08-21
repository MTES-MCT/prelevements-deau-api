import {spawnSync} from 'node:child_process'
import process from 'node:process'

import {validateDemoAdminDatabaseUrl} from './database-target.js'

const EXPECTED_ENVIRONMENT = 'demo'

function fail(message) {
  console.error(message)
  process.exit(1)
}

if (process.env.APP_ENV !== EXPECTED_ENVIRONMENT) {
  fail('Refus de migrer : APP_ENV doit être exactement "demo".')
}

try {
  validateDemoAdminDatabaseUrl(process.env.DATABASE_URL)
} catch (error) {
  fail(error.message.replace(/^Refus :/, 'Refus de migrer :'))
}

const migration = spawnSync(
  'npx',
  ['--no-install', 'prisma', 'migrate', 'deploy'],
  {stdio: 'inherit'}
)

if (migration.error) {
  fail(`Échec du lancement de Prisma : ${migration.error.message}`)
}

if (migration.status !== 0) {
  fail(`Les migrations Prisma ont échoué avec le statut ${migration.status}.`)
}

console.log('Migrations demo terminées sur la base attendue.')
