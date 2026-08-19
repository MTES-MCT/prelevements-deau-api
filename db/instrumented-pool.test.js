import process from 'node:process'

import test from 'ava'

import {
  InstrumentedPool,
  readDatabasePoolMax,
  readDatabasePoolSlowWaitMs
} from './instrumented-pool.js'

test.serial('lit la configuration du pool avec des valeurs par défaut sûres', t => {
  const previousMax = process.env.DATABASE_POOL_MAX
  const previousSlowWait = process.env.DATABASE_POOL_SLOW_WAIT_MS
  t.teardown(() => {
    if (previousMax === undefined) {
      delete process.env.DATABASE_POOL_MAX
    } else {
      process.env.DATABASE_POOL_MAX = previousMax
    }

    if (previousSlowWait === undefined) {
      delete process.env.DATABASE_POOL_SLOW_WAIT_MS
    } else {
      process.env.DATABASE_POOL_SLOW_WAIT_MS = previousSlowWait
    }
  })

  process.env.DATABASE_POOL_MAX = '12'
  process.env.DATABASE_POOL_SLOW_WAIT_MS = '75'
  t.is(readDatabasePoolMax(), 12)
  t.is(readDatabasePoolSlowWaitMs(), 75)

  process.env.DATABASE_POOL_MAX = '0'
  process.env.DATABASE_POOL_SLOW_WAIT_MS = 'invalid'
  t.is(readDatabasePoolMax(), 5)
  t.is(readDatabasePoolSlowWaitMs(), 100)
})

test.serial('journalise une acquisition lente sans exposer la connexion', async t => {
  const previousSlowWait = process.env.DATABASE_POOL_SLOW_WAIT_MS
  const originalConsoleLog = console.log
  const logs = []
  process.env.DATABASE_POOL_SLOW_WAIT_MS = '0'
  console.log = (...arguments_) => logs.push(arguments_.join(' '))
  t.teardown(() => {
    console.log = originalConsoleLog
    if (previousSlowWait === undefined) {
      delete process.env.DATABASE_POOL_SLOW_WAIT_MS
    } else {
      process.env.DATABASE_POOL_SLOW_WAIT_MS = previousSlowWait
    }
  })

  const pool = new InstrumentedPool({
    connectionString: 'postgresql://sensitive-user:sensitive-password@127.0.0.1:1/private-db',
    connectionTimeoutMillis: 50,
    max: 1
  })

  await t.throwsAsync(pool.connect())
  await pool.end()

  t.true(logs.some(line => line.startsWith('[DB_POOL_PERF]')))
  t.false(logs.some(line => line.includes('sensitive-user')))
  t.false(logs.some(line => line.includes('sensitive-password')))
  t.false(logs.some(line => line.includes('private-db')))
})
