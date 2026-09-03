import {spawnSync} from 'node:child_process'
import process from 'node:process'

import pgPkg from 'pg'

import {
  assertConnectedDemoAdminDatabase,
  validateDemoAdminDatabaseUrl
} from './database-target.js'

const EXPECTED_ENVIRONMENT = 'demo'
const {Client} = pgPkg

function fail(message) {
  throw new Error(message)
}

async function assertMigrationTarget(databaseUrl) {
  const client = new Client({connectionString: databaseUrl})

  try {
    await client.connect()
    await assertConnectedDemoAdminDatabase(client)
  } finally {
    await client.end()
  }
}

async function main() {
  if (process.env.APP_ENV !== EXPECTED_ENVIRONMENT) {
    fail('Refus de migrer : APP_ENV doit être exactement "demo".')
  }

  try {
    validateDemoAdminDatabaseUrl(process.env.DATABASE_URL)
  } catch (error) {
    fail(error.message.replace(/^Refus :/, 'Refus de migrer :'))
  }

  await assertMigrationTarget(process.env.DATABASE_URL)

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
}

main().catch(error => {
  console.error(error?.message ?? error)
  process.exitCode = 1
})
