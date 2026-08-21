import {spawnSync} from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'

import test from 'ava'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const migrationScript = path.resolve(testDirectory, '../migrate-demo.js')

function runMigrationGuard(environment = {}) {
  return spawnSync(process.execPath, [migrationScript], {
    env: {
      PATH: process.env.PATH,
      ...environment
    },
    encoding: 'utf8'
  })
}

test('refuse un environnement autre que demo', t => {
  const result = runMigrationGuard({
    APP_ENV: 'testing',
    DATABASE_URL: 'postgresql://demo_admin:secret@database/prelevements_demo'
  })

  t.is(result.status, 1)
  t.regex(result.stderr, /APP_ENV doit être exactement "demo"/)
})

test('refuse une URL non PostgreSQL', t => {
  const result = runMigrationGuard({
    APP_ENV: 'demo',
    DATABASE_URL: 'mysql://demo_admin:secret@database/prelevements_demo'
  })

  t.is(result.status, 1)
  t.regex(result.stderr, /doit utiliser PostgreSQL/)
})

test('refuse un autre nom de base', t => {
  const result = runMigrationGuard({
    APP_ENV: 'demo',
    DATABASE_URL: 'postgresql://demo_admin:secret@database/prelevements_testing'
  })

  t.is(result.status, 1)
  t.regex(result.stderr, /la base doit être prelevements_demo/)
})

test('refuse un autre utilisateur de migration', t => {
  const result = runMigrationGuard({
    APP_ENV: 'demo',
    DATABASE_URL: 'postgresql://postgres:secret@database/prelevements_demo'
  })

  t.is(result.status, 1)
  t.regex(result.stderr, /l'utilisateur doit être demo_admin/)
})
