import test from 'ava'

import {
  createSessionToken,
  getSessionByToken,
  readSessionTokenTtl,
  requireActiveUserSession
} from '../session-token.js'

test('createSessionToken persiste les générations du compte et de l’auteur', async t => {
  let createdData
  const client = {
    sessionToken: {
      async create({data}) {
        createdData = data
        return {
          ...data,
          createdAt: new Date('2026-08-31T12:00:00.000Z')
        }
      }
    }
  }

  await createSessionToken('user-id', 'DECLARANT', 900, {
    client,
    authVersion: 4,
    impersonatedByUserId: 'admin-id',
    impersonatedByRole: 'ADMIN',
    impersonatedByAuthVersion: 7
  })

  t.like(createdData, {
    userId: 'user-id',
    authVersion: 4,
    impersonatedByUserId: 'admin-id',
    impersonatedByRole: 'ADMIN',
    impersonatedByAuthVersion: 7
  })
})

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

test('requireActiveUserSession revalide le propriétaire et la révocation', async t => {
  const active = await requireActiveUserSession('user-id', 'session', {
    async findSession() {
      return {userId: 'user-id', impersonatedByUserId: null}
    }
  })

  t.is(active.userId, 'user-id')

  await Promise.all([
    null,
    {userId: 'autre-user', impersonatedByUserId: null},
    {userId: 'user-id', impersonatedByUserId: 'admin-id'}
  ].map(async session => {
    const error = await t.throwsAsync(requireActiveUserSession(
      'user-id',
      'session',
      {
        async findSession() {
          return session
        }
      }
    ))
    t.is(error.status, 401)
  }))
})

test('requireActiveUserSession accepte explicitement une session d’assistance', async t => {
  const session = {
    userId: 'user-id',
    impersonatedByUserId: 'admin-id'
  }
  const active = await requireActiveUserSession('user-id', 'session', {
    allowImpersonated: true,
    async findSession() {
      return session
    }
  })

  t.is(active, session)
})
