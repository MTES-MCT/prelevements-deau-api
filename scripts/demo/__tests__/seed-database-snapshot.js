import test from 'ava'

import {withSeedStateSnapshot} from '../lib/seed-database.js'

const DATABASE_URL = 'postgresql://demo:secret@database.example.test:5432/demo'
const EXPECTED_LOCK = 'partageonsleau:demo-seed:grivaise-v1'
const REPEATABLE_READ_OPTIONS = Object.freeze({
  maxWait: 30_000,
  timeout: 15 * 60_000,
  isolationLevel: 'RepeatableRead'
})

function buildHarness({collectError} = {}) {
  const events = []
  let transactionIndex = 0
  const lockClient = {
    async connect() {
      events.push(['connect'])
    },
    async query(sql, parameters) {
      events.push(['query', sql, parameters])
      return {rows: []}
    },
    async end() {
      events.push(['end'])
    }
  }
  const database = {
    async $queryRawUnsafe() {
      return []
    },
    async $executeRawUnsafe() {},
    async $transaction(operation, options) {
      transactionIndex += 1
      const transaction = {index: transactionIndex}
      events.push(['transaction', transactionIndex, options])
      return operation(transaction)
    }
  }
  const createLockClient = async options => {
    events.push(['client', options])
    return lockClient
  }

  const collect = async transaction => {
    events.push(['collect', transaction.index])
    if (collectError) {
      throw collectError
    }

    return {consistent: true}
  }

  return {collect, createLockClient, database, events}
}

test('garde le verrou de session pendant le snapshot REPEATABLE READ', async t => {
  const {collect, createLockClient, database, events} = buildHarness()

  const result = await withSeedStateSnapshot({
    database,
    databaseUrl: DATABASE_URL,
    collect,
    createLockClient
  })

  t.deepEqual(result, {consistent: true})
  t.deepEqual(events, [
    ['client', {connectionString: DATABASE_URL}],
    ['connect'],
    [
      'query',
      'SELECT pg_advisory_lock(hashtext($1)::bigint)',
      [EXPECTED_LOCK]
    ],
    ['transaction', 1, REPEATABLE_READ_OPTIONS],
    ['collect', 1],
    [
      'query',
      'SELECT pg_advisory_unlock(hashtext($1)::bigint)',
      [EXPECTED_LOCK]
    ],
    ['end']
  ])
})

test('libère le verrou et ferme la connexion si la collecte échoue', async t => {
  const collectError = new Error('collecte interrompue')
  const {collect, createLockClient, database, events} = buildHarness({collectError})

  const error = await t.throwsAsync(withSeedStateSnapshot({
    database,
    databaseUrl: DATABASE_URL,
    collect,
    createLockClient
  }))

  t.is(error, collectError)
  t.deepEqual(events.slice(-2), [
    [
      'query',
      'SELECT pg_advisory_unlock(hashtext($1)::bigint)',
      [EXPECTED_LOCK]
    ],
    ['end']
  ])
})

test('refuse une URL absente avant de créer le client dédié', async t => {
  const {collect, createLockClient, database, events} = buildHarness()

  await t.throwsAsync(
    withSeedStateSnapshot({database, collect, createLockClient}),
    {message: 'databaseUrl est requis'}
  )
  t.deepEqual(events, [])
})
