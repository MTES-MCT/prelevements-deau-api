import test from 'ava'

import {
  getSessionByToken,
  readSessionTokenTtl
} from '../session-token.js'

test('readSessionTokenTtl conserve 30 jours par défaut et exige un entier positif', t => {
  t.is(readSessionTokenTtl(undefined), 2_592_000)
  t.is(readSessionTokenTtl('28800'), 28_800)
  t.throws(() => readSessionTokenTtl('0'))
  t.throws(() => readSessionTokenTtl('-1'))
  t.throws(() => readSessionTokenTtl('1.5'))
  t.throws(() => readSessionTokenTtl('invalide'))
})

test('getSessionByToken borne une ancienne session à createdAt + TTL runtime', async t => {
  const now = new Date('2026-08-21T12:00:00.000Z')
  const createdAt = new Date('2026-08-21T05:00:00.000Z')
  const databaseExpiresAt = new Date('2026-09-20T05:00:00.000Z')
  let query
  const client = {
    sessionToken: {
      async findFirst(operation) {
        query = operation
        return {token: 'session', createdAt, expiresAt: databaseExpiresAt}
      }
    }
  }

  const session = await getSessionByToken('session', {client, now, ttl: 28_800})

  t.deepEqual(query.where, {
    token: 'session',
    expiresAt: {gt: now},
    createdAt: {gt: new Date('2026-08-21T04:00:00.000Z')}
  })
  t.deepEqual(session.expiresAt, new Date('2026-08-21T13:00:00.000Z'))
})

test('getSessionByToken conserve une expiration DB plus courte', async t => {
  const now = new Date('2026-08-21T12:00:00.000Z')
  const databaseExpiresAt = new Date('2026-08-21T12:30:00.000Z')
  const client = {
    sessionToken: {
      async findFirst() {
        return {
          token: 'session',
          createdAt: new Date('2026-08-21T11:00:00.000Z'),
          expiresAt: databaseExpiresAt
        }
      }
    }
  }

  const session = await getSessionByToken('session', {client, now, ttl: 28_800})
  t.deepEqual(session.expiresAt, databaseExpiresAt)
})

test('getSessionByToken refuse défensivement une session plus ancienne que le TTL runtime', async t => {
  const now = new Date('2026-08-21T12:00:00.000Z')
  const client = {
    sessionToken: {
      async findFirst() {
        return {
          token: 'session',
          createdAt: new Date('2026-08-21T03:00:00.000Z'),
          expiresAt: new Date('2026-09-20T03:00:00.000Z')
        }
      }
    }
  }

  t.is(await getSessionByToken('session', {client, now, ttl: 28_800}), null)
})
