import test from 'ava'

import {
  deleteDeclarantById,
  getDeclarantById,
  getDeclarantOverviewById,
  getDeclarantsByInstructor,
  searchDeclarants
} from '../declarant.js'

function exploitationZoneWhere(zoneIds) {
  return {
    pointPrelevement: {
      zones: {
        some: {zoneId: {in: zoneIds}}
      }
    }
  }
}

test('searchDeclarants applique le périmètre, les filtres et une pagination bornée côté base', async t => {
  const now = new Date('2026-07-13T12:00:00.000Z')
  let findQuery
  const countQueries = []
  const countResults = [2, 10, 7, 3, 1]
  const client = {
    instructorZone: {
      async findMany(arguments_) {
        const {permission} = arguments_.where.permissions.some

        return permission === 'declarant.list'
          ? [{zoneId: 'zone-list'}]
          : [{zoneId: 'zone-exploitation'}]
      }
    },
    async $queryRaw() {
      return [
        {declarantUserId: 'declarant-1', zoneId: 'zone-list'},
        {declarantUserId: 'declarant-2', zoneId: 'zone-list'}
      ]
    },
    user: {
      async findMany(arguments_) {
        findQuery = arguments_
        return [{id: 'declarant-1'}]
      },
      async count(arguments_) {
        countQueries.push(arguments_)
        return countResults[countQueries.length - 1]
      }
    }
  }

  const result = await searchDeclarants(
    {id: 'instructor-1', role: 'INSTRUCTOR'},
    {
      page: 2,
      pageSize: 25,
      query: '123 456',
      role: 'PRELEVEUR',
      emailStatus: 'WITH_EMAIL'
    },
    {client, now}
  )

  t.is(findQuery.skip, 25)
  t.is(findQuery.take, 25)
  t.deepEqual(findQuery.where.AND[0], {
    role: 'DECLARANT',
    deletedAt: null,
    id: {in: ['declarant-1', 'declarant-2']}
  })
  t.deepEqual(findQuery.where.AND.slice(2), [
    {declarant: {declarantRole: 'PRELEVEUR'}},
    {email: {not: null}}
  ])
  t.true(findQuery.where.AND[1].OR.some(condition =>
    condition.declarant?.siret?.contains === '123456'))
  t.deepEqual(
    findQuery.include.declarant.include._count.select.pointPrelevements,
    {
      where: {
        pointPrelevement: {
          zones: {some: {zoneId: {in: ['zone-exploitation']}}}
        }
      }
    }
  )
  t.deepEqual(
    findQuery.include.declarant.include._count.select.collecteurExploitations,
    {
      where: {
        exploitation: {
          pointPrelevement: {
            zones: {some: {zoneId: {in: ['zone-exploitation']}}}
          }
        }
      }
    }
  )
  t.is(countQueries.length, 5)
  t.deepEqual(result, {
    items: [{id: 'declarant-1'}],
    total: 2,
    page: 2,
    pageSize: 25,
    totalPages: 1,
    counts: {
      total: 10,
      preleveurs: 7,
      collecteurs: 3,
      withoutEmail: 1
    }
  })
})

test('getDeclarantsByInstructor utilise le périmètre effectif et des compteurs filtrés sans N+1', async t => {
  const now = new Date('2026-08-04T12:00:00.000Z')
  const permissionQueries = []
  let userQuery
  const client = {
    instructorZone: {
      async findMany(arguments_) {
        permissionQueries.push(arguments_)
        const {permission} = arguments_.where.permissions.some

        return permission === 'declarant.list'
          ? [{zoneId: 'zone-list'}]
          : [{zoneId: 'zone-exploitation'}]
      }
    },
    async $queryRaw() {
      return [{declarantUserId: 'declarant-visible', zoneId: 'zone-list'}]
    },
    user: {
      async findMany(arguments_) {
        userQuery = arguments_
        return [{id: 'declarant-visible'}]
      }
    }
  }

  const result = await getDeclarantsByInstructor(
    'instructor-1',
    false,
    now,
    {client}
  )

  t.deepEqual(result, [{id: 'declarant-visible'}])
  t.is(permissionQueries.length, 2)
  t.deepEqual(userQuery.where, {
    role: 'DECLARANT',
    deletedAt: null,
    id: {in: ['declarant-visible']}
  })
  t.deepEqual(
    userQuery.include.declarant.include._count.select.pointPrelevements
      .where.pointPrelevement.zones.some.zoneId,
    {in: ['zone-exploitation']}
  )
  t.deepEqual(
    userQuery.include.declarant.include._count.select.collecteurExploitations
      .where.exploitation.pointPrelevement.zones.some.zoneId,
    {in: ['zone-exploitation']}
  )
})

test('getDeclarantOverviewById limite les relations lourdes et conserve les statistiques utiles', async t => {
  let declarantQuery
  let chunkQuery
  const createdAt = new Date('2026-06-20T12:00:00.000Z')
  const minDate = new Date('2026-01-01T00:00:00.000Z')
  const maxDate = new Date('2026-05-31T00:00:00.000Z')
  const client = {
    declarant: {
      async findUnique(arguments_) {
        declarantQuery = arguments_
        return {
          userId: 'declarant-1',
          socialReason: 'Entreprise',
          user: {
            id: 'declarant-1',
            email: 'contact@example.test',
            firstName: null,
            lastName: null
          },
          pointPrelevements: [{
            id: 'exploitation-1',
            pointPrelevementId: 'point-1'
          }],
          collecteurExploitations: []
        }
      }
    },
    chunk: {
      async findMany(arguments_) {
        chunkQuery = arguments_
        return [{
          pointPrelevementId: 'point-1',
          minDate,
          maxDate,
          source: {declaration: {createdAt}}
        }]
      }
    }
  }

  const overview = await getDeclarantOverviewById('declarant-1', {client})
  const exploitationInclude = declarantQuery.include.pointPrelevements.include

  t.false(Object.hasOwn(declarantQuery.include, 'zones'))
  t.false(Object.hasOwn(declarantQuery.include.pointPrelevements, 'where'))
  t.false(Object.hasOwn(declarantQuery.include.collecteurExploitations, 'where'))
  t.false(Object.hasOwn(exploitationInclude, 'connectors'))
  t.false(Object.hasOwn(exploitationInclude, 'documents'))
  t.deepEqual(exploitationInclude.pointPrelevement, {
    select: {id: true, name: true}
  })
  t.deepEqual(chunkQuery.where.pointPrelevementId, {in: ['point-1']})
  t.is(chunkQuery.where.source.declaration.declarantUserId, 'declarant-1')
  t.like(overview, {
    id: 'declarant-1',
    email: 'contact@example.test',
    socialReason: 'Entreprise'
  })
  t.like(overview.pointPrelevements[0], {
    lastDeclarationAt: createdAt,
    minDeclaredDate: minDate,
    maxDeclaredDate: maxDate
  })
})

test('getDeclarantById et son overview filtrent les exploitations en base, y compris avec un périmètre vide', async t => {
  const queries = []
  const client = {
    declarant: {
      async findUnique(arguments_) {
        queries.push(arguments_)
        return {
          userId: 'declarant-1',
          user: {id: 'declarant-1'},
          pointPrelevements: [],
          collecteurExploitations: [],
          zones: []
        }
      }
    }
  }

  await getDeclarantById('declarant-1', {
    client,
    exploitationZoneIds: ['zone-1', 'zone-1', 'zone-2']
  })
  await getDeclarantOverviewById('declarant-1', {
    client,
    exploitationZoneIds: []
  })

  const detailWhere = exploitationZoneWhere(['zone-1', 'zone-2'])
  t.deepEqual(queries[0].include.pointPrelevements.where, detailWhere)
  t.deepEqual(queries[0].include.collecteurExploitations.where, {
    exploitation: detailWhere
  })

  const emptyWhere = exploitationZoneWhere([])
  t.deepEqual(queries[1].include.pointPrelevements.where, emptyWhere)
  t.deepEqual(queries[1].include.collecteurExploitations.where, {
    exploitation: emptyWhere
  })
})

test('deleteDeclarantById libère les emails et révoque les accès dans une transaction', async t => {
  const now = new Date('2026-08-11T12:00:00.000Z')
  const calls = []
  const deletedUser = {
    id: 'declarant-1',
    email: null,
    deletedAt: now
  }
  const tx = {
    user: {
      async findFirst(arguments_) {
        calls.push(['user.findFirst', arguments_])
        return {id: 'declarant-1'}
      },
      async update(arguments_) {
        calls.push(['user.update', arguments_])
        return deletedUser
      }
    },
    userEmailAlias: {
      async deleteMany(arguments_) {
        calls.push(['userEmailAlias.deleteMany', arguments_])
      }
    },
    authToken: {
      async deleteMany(arguments_) {
        calls.push(['authToken.deleteMany', arguments_])
      }
    },
    sessionToken: {
      async deleteMany(arguments_) {
        calls.push(['sessionToken.deleteMany', arguments_])
      }
    },
    serviceAccountToken: {
      async updateMany(arguments_) {
        calls.push(['serviceAccountToken.updateMany', arguments_])
      }
    }
  }
  const client = {
    async $transaction(callback) {
      calls.push(['transaction'])
      return callback(tx)
    }
  }

  const result = await deleteDeclarantById('declarant-1', {client, now})

  t.is(result, deletedUser)
  t.deepEqual(calls, [
    ['transaction'],
    ['user.findFirst', {
      where: {id: 'declarant-1', role: 'DECLARANT', deletedAt: null},
      select: {id: true}
    }],
    ['userEmailAlias.deleteMany', {where: {userId: 'declarant-1'}}],
    ['authToken.deleteMany', {where: {userId: 'declarant-1'}}],
    ['sessionToken.deleteMany', {
      where: {
        OR: [
          {userId: 'declarant-1'},
          {impersonatedByUserId: 'declarant-1'}
        ]
      }
    }],
    ['serviceAccountToken.updateMany', {
      where: {declarantUserId: 'declarant-1', revokedAt: null},
      data: {revokedAt: now}
    }],
    ['user.update', {
      where: {id: 'declarant-1'},
      data: {email: null, deletedAt: now}
    }]
  ])
})

test('deleteDeclarantById ne nettoie rien si le déclarant est déjà supprimé', async t => {
  let cleanupCalled = false
  const tx = {
    user: {
      async findFirst() {
        return null
      }
    },
    userEmailAlias: {
      async deleteMany() {
        cleanupCalled = true
      }
    }
  }
  const client = {
    async $transaction(callback) {
      return callback(tx)
    }
  }

  const error = await t.throwsAsync(
    deleteDeclarantById('declarant-1', {client}),
    {message: 'Ce déclarant est introuvable.'}
  )

  t.is(error.status, 404)
  t.false(cleanupCalled)
})
