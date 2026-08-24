import test from 'ava'

import {
  authorizeChunk,
  authorizeDeclarationPermission,
  authorizeDeclarant,
  authorizeSource,
  ensureNotImpersonating
} from '../middleware.js'

const now = new Date('2026-08-04T12:00:00.000Z')

test('ensureNotImpersonating interdit toute gestion de credential en impersonation', t => {
  let error

  ensureNotImpersonating({
    auth: {impersonation: {actor: {id: 'admin-id'}}}
  }, {}, nextError => {
    error = nextError
  })

  t.is(error.status, 403)
})

test('ensureNotImpersonating autorise une session humaine directe', t => {
  let nextCalled = false

  ensureNotImpersonating({auth: {type: 'USER_SESSION'}}, {}, error => {
    t.is(error, undefined)
    nextCalled = true
  })

  t.true(nextCalled)
})

test('authorizeDeclarant expose uniquement l’intersection des zones effectives et autorisées', async t => {
  let permissionQuery
  let nextError
  const client = {
    async $queryRaw() {
      return [
        {declarantUserId: 'declarant-1', zoneId: 'zone-1'},
        {declarantUserId: 'declarant-1', zoneId: 'zone-2'}
      ]
    },
    instructorZone: {
      async findMany(arguments_) {
        permissionQuery = arguments_
        return [{zoneId: 'zone-2'}]
      }
    }
  }
  const req = {
    params: {declarantId: 'declarant-1'},
    user: {id: 'instructor-1', role: 'INSTRUCTOR'}
  }
  const middleware = authorizeDeclarant(
    'read',
    'declarant.detail.read',
    {client, now}
  )

  await middleware(req, {}, error => {
    nextError = error
  })

  t.is(nextError, undefined)
  t.deepEqual(req.permittedZoneIds, ['zone-2'])
  t.deepEqual(permissionQuery.where.zoneId, {in: ['zone-1', 'zone-2']})
  t.deepEqual(permissionQuery.where.permissions, {
    some: {permission: 'declarant.detail.read'}
  })
  t.deepEqual(permissionQuery.where.AND, [
    {startDate: {lte: now}},
    {OR: [{endDate: null}, {endDate: {gte: now}}]}
  ])
})

test('authorizeDeclarant refuse un rattachement EXPLOITATION obsolète', async t => {
  let permissionQueryCount = 0
  let nextError
  const client = {
    async $queryRaw() {
      return []
    },
    instructorZone: {
      async findMany() {
        permissionQueryCount += 1
        return [{zoneId: 'stale-zone'}]
      }
    }
  }
  const req = {
    params: {declarantId: 'declarant-1'},
    user: {id: 'instructor-1', role: 'INSTRUCTOR'}
  }

  await authorizeDeclarant(
    'read',
    'declarant.detail.read',
    {client, now}
  )(req, {}, error => {
    nextError = error
  })

  t.is(nextError.status, 403)
  t.is(permissionQueryCount, 0)
  t.false(Object.hasOwn(req, 'permittedZoneIds'))
})

function createScopedResourceClient() {
  return {
    declaration: {
      async findUnique() {
        return {
          declarantUserId: 'declarant-1',
          createdByDeclarantUserId: null,
          source: {id: 'source-1'}
        }
      }
    },
    source: {
      async findUnique() {
        return {
          id: 'source-1',
          declaration: {
            declarantUserId: 'declarant-1',
            createdByDeclarantUserId: null
          },
          chunks: [{pointPrelevementId: 'point-1'}]
        }
      }
    },
    chunk: {
      async findUnique() {
        return {
          id: 'chunk-1',
          pointPrelevementId: 'point-1',
          sourceId: 'source-1',
          source: {
            declaration: {
              declarantUserId: 'declarant-1',
              createdByDeclarantUserId: null
            }
          }
        }
      }
    },
    pointPrelevementZone: {
      async findMany() {
        return [{zoneId: 'zone-1'}, {zoneId: 'zone-2'}]
      }
    },
    async $queryRaw() {
      return []
    },
    instructorZone: {
      async findMany() {
        return [{zoneId: 'zone-1'}]
      }
    }
  }
}

test('les middlewares déclaration, source et chunk ne propagent jamais les zones non autorisées', async t => {
  const cases = [
    {
      name: 'declaration',
      middleware: client => authorizeDeclarationPermission(
        'declaration.detail.read',
        {client, now}
      ),
      params: {declarationId: 'declaration-1'}
    },
    {
      name: 'source',
      middleware: client => authorizeSource(
        'read',
        'declaration.detail.read',
        {client, now}
      ),
      params: {sourceId: 'source-1'}
    },
    {
      name: 'chunk',
      middleware: client => authorizeChunk(
        'read',
        'declaration.detail.read',
        {client, now}
      ),
      params: {chunkId: 'chunk-1'}
    }
  ]

  for (const item of cases) {
    const client = createScopedResourceClient()
    const req = {
      params: item.params,
      user: {id: 'instructor-1', role: 'INSTRUCTOR'}
    }
    let nextError

    // eslint-disable-next-line no-await-in-loop
    await item.middleware(client)(req, {}, error => {
      nextError = error
    })

    t.is(nextError, undefined, `${item.name}`)
    t.deepEqual(req.permittedZoneIds, ['zone-1'], `${item.name}`)
  }
})
