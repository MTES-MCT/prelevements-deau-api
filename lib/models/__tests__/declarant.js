import test from 'ava'

import {
  deleteDeclarantById,
  getCollecteurPreleveurs,
  getDeclarantById,
  getDeclarantOverviewById,
  getDeclarantsByInstructor,
  getDeclarantSearchExploitations,
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

function sqlText(query) {
  return query.strings.join('?')
}

test('getDeclarantSearchExploitations reste borné aux déclarants et zones autorisés', async t => {
  const declarantId = '73e76b9a-0b61-43e0-a45c-99052970ab14'
  const zoneId = '8c67a193-1c5c-4c9f-8ed3-6e4e6040ed37'
  let capturedQuery
  const client = {
    async $queryRaw(query) {
      capturedQuery = query
      return []
    }
  }

  t.deepEqual(await getDeclarantSearchExploitations([], undefined, {client}), [])
  t.deepEqual(await getDeclarantSearchExploitations([declarantId], [], {client}), [])
  t.is(capturedQuery, undefined)

  await getDeclarantSearchExploitations([declarantId], [zoneId], {client})
  const text = sqlText(capturedQuery)

  t.regex(text, /candidate_ids \(id\)/)
  t.regex(text, /exploitation\."declarantUserId" = candidate\.id/)
  t.regex(text, /collector_link\."collecteurUserId" = candidate\.id/)
  t.regex(text, /point_zone\."zoneId" IN/)
  t.regex(text, /active_collector_user\."deletedAt" IS NULL/)
  t.regex(text, /jsonb_agg\(jsonb_build_object/)
  t.true(capturedQuery.values.some(value =>
    Array.isArray(value) && value.includes(declarantId)))
  t.true(capturedQuery.values.includes(zoneId))
})

test('searchDeclarants filtre puis classe uniquement les déclarants autorisés', async t => {
  const now = new Date('2026-07-13T12:00:00.000Z')
  const preleveurId = '73e76b9a-0b61-43e0-a45c-99052970ab14'
  const collecteurId = '8c67a193-1c5c-4c9f-8ed3-6e4e6040ed37'
  const userQueries = []
  const rawQueries = []
  const baseRecords = [
    {
      id: preleveurId,
      email: 'preleveur@example.test',
      firstName: 'Élodie',
      lastName: 'Martin',
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      declarant: {
        declarantRole: 'PRELEVEUR',
        declarantType: 'LEGAL_PERSON',
        preleveurType: 'IRRIGANT',
        socialReason: 'Ferme des Prés',
        lastDeclarationAt: new Date('2026-07-01T00:00:00.000Z'),
        pointPrelevements: [{
          id: 'exploitation-1',
          status: 'EN_ACTIVITE',
          usage: {code: '2A', label: 'Irrigation par aspersion'},
          pointPrelevement: {
            waterBodyType: 'SOUTERRAIN',
            zones: [{
              zone: {
                id: 'zone-list',
                code: 'Z1',
                name: 'Zone 1',
                type: 'DEPARTEMENT'
              }
            }]
          },
          collecteurs: [{id: 'collector-link'}],
          connectors: []
        }],
        collecteurExploitations: []
      }
    },
    {
      id: collecteurId,
      email: null,
      firstName: 'Jean',
      lastName: 'Durand',
      createdAt: new Date('2025-02-01T00:00:00.000Z'),
      declarant: {
        declarantRole: 'COLLECTEUR',
        declarantType: 'NATURAL_PERSON',
        preleveurType: null,
        socialReason: null,
        lastDeclarationAt: null,
        pointPrelevements: [],
        collecteurExploitations: []
      }
    }
  ]
  const client = {
    instructorZone: {
      async findMany(arguments_) {
        const {permission} = arguments_.where.permissions.some

        return permission === 'declarant.list'
          ? [{zoneId: 'zone-list'}]
          : [{zoneId: 'zone-exploitation'}]
      }
    },
    async $queryRaw(query) {
      rawQueries.push(query)
      const text = sqlText(query)

      if (text.includes('active_collector_link')) {
        return [
          {
            declarantUserId: preleveurId,
            id: 'exploitation-1',
            status: 'EN_ACTIVITE',
            usageCode: '2A',
            usageLabel: 'Irrigation par aspersion',
            waterBodyType: 'SOUTERRAIN',
            zones: [{
              id: 'zone-list',
              code: 'Z1',
              name: 'Zone 1',
              type: 'DEPARTEMENT'
            }],
            hasCollecteur: true,
            hasConnector: false
          },
          {
            declarantUserId: preleveurId,
            id: 'exploitation-2',
            status: 'EN_ACTIVITE',
            usageCode: '2B',
            usageLabel: 'Irrigation gravitaire',
            waterBodyType: 'SOUTERRAIN',
            zones: [],
            hasCollecteur: false,
            hasConnector: false
          },
          {
            declarantUserId: preleveurId,
            id: 'exploitation-3',
            status: 'EN_ACTIVITE',
            usageCode: '5',
            usageLabel: 'Alimentation en eau potable',
            waterBodyType: 'SOUTERRAIN',
            zones: [],
            hasCollecteur: false,
            hasConnector: false
          },
          {
            declarantUserId: preleveurId,
            id: 'exploitation-4',
            status: 'EN_ACTIVITE',
            usageCode: '0',
            usageLabel: 'Usage inconnu',
            waterBodyType: 'SOUTERRAIN',
            zones: [],
            hasCollecteur: false,
            hasConnector: false
          },
          {
            declarantUserId: preleveurId,
            id: 'exploitation-5',
            status: 'EN_ACTIVITE',
            usageCode: '0',
            usageLabel: 'Usage inconnu',
            waterBodyType: 'SOUTERRAIN',
            zones: [],
            hasCollecteur: false,
            hasConnector: false
          }
        ]
      }

      if (text.includes('effective_declarant_zones')) {
        return [
          {declarantUserId: preleveurId, zoneId: 'zone-list'},
          {declarantUserId: collecteurId, zoneId: 'zone-list'}
        ]
      }

      return [{id: preleveurId, relevance: 875}]
    },
    zone: {
      async findMany() {
        return [{
          id: 'zone-list',
          code: 'Z1',
          name: 'Zone 1',
          type: 'DEPARTEMENT'
        }]
      }
    },
    user: {
      async findMany(arguments_) {
        userQueries.push(arguments_)
        return userQueries.length === 1
          ? baseRecords
          : [{id: preleveurId, declarant: {declarantRole: 'PRELEVEUR'}}]
      }
    }
  }

  const result = await searchDeclarants(
    {id: 'instructor-1', role: 'INSTRUCTOR'},
    {
      page: 1,
      pageSize: 25,
      query: 'ferme pres',
      role: 'PRELEVEUR',
      preleveurType: 'IRRIGANT',
      emailStatus: 'WITH_EMAIL',
      collecteurStatus: 'WITH_COLLECTEUR',
      activityRange: 'LT_30_DAYS',
      zoneIds: ['zone-list'],
      usageCodes: ['2'],
      waterBodyTypes: ['SOUTERRAIN'],
      exploitationStatuses: ['EN_ACTIVITE']
    },
    {client, now}
  )

  t.deepEqual(userQueries[0].where, {
    role: 'DECLARANT',
    deletedAt: null,
    id: {in: [preleveurId, collecteurId]}
  })
  t.false(Object.hasOwn(userQueries[0].select.declarant.select, 'pointPrelevements'))
  const exploitationQuery = rawQueries.find(query =>
    sqlText(query).includes('active_collector_link'))
  t.truthy(exploitationQuery)
  t.regex(sqlText(exploitationQuery), /point_zone\."zoneId" IN/)
  t.true(exploitationQuery.values.includes('zone-exploitation'))
  t.is(rawQueries.length, 4)
  t.deepEqual(result.items, [{
    id: preleveurId,
    declarant: {declarantRole: 'PRELEVEUR'},
    searchSummary: {
      usages: [
        {code: '2', label: 'Irrigation'},
        {code: '5', label: 'Alimentation en eau potable (AEP)'},
        {code: '0', label: 'Usage inconnu'}
      ]
    }
  }])
  t.is(result.total, 1)
  t.is(result.page, 1)
  t.is(result.pageSize, 25)
  t.is(result.totalPages, 1)
  t.deepEqual(result.counts, {
    total: 2,
    preleveurs: 1,
    collecteurs: 1,
    withoutEmail: 1
  })
  t.deepEqual(result.facets.preleveurTypes, [{
    value: 'IRRIGANT',
    label: 'Irrigant',
    count: 1
  }])
  t.deepEqual(result.facets.zoneIds, [{
    value: 'zone-list',
    label: 'Zone 1',
    code: 'Z1',
    type: 'DEPARTEMENT',
    count: 2
  }])
})

test('getCollecteurPreleveurs ignore les autres collecteurs supprimés dans les facettes', async t => {
  let linkQuery
  const client = {
    declarantCollecteurExploitation: {
      async findMany(query) {
        linkQuery = query
        return []
      }
    }
  }

  t.deepEqual(await getCollecteurPreleveurs('collecteur-actif', {client}), [])
  t.deepEqual(
    linkQuery.include.exploitation.include.collecteurs.where,
    {collecteur: {user: {deletedAt: null}}}
  )
})

test('searchDeclarants trie la dernière déclaration dans les deux sens avec les nulls à la fin', async t => {
  const records = [
    {
      id: '73e76b9a-0b61-43e0-a45c-99052970ab14',
      email: 'recent@example.test',
      firstName: 'Récent',
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      declarant: {
        declarantRole: 'PRELEVEUR',
        lastDeclarationAt: new Date('2026-07-01T00:00:00.000Z'),
        pointPrelevements: [],
        collecteurExploitations: []
      }
    },
    {
      id: '8c67a193-1c5c-4c9f-8ed3-6e4e6040ed37',
      email: 'never@example.test',
      firstName: 'Jamais',
      createdAt: new Date('2025-01-02T00:00:00.000Z'),
      declarant: {
        declarantRole: 'PRELEVEUR',
        lastDeclarationAt: null,
        pointPrelevements: [],
        collecteurExploitations: []
      }
    },
    {
      id: '84db3966-3e15-4a37-b576-1bb06d29397d',
      email: 'old@example.test',
      firstName: 'Ancien',
      createdAt: new Date('2025-01-03T00:00:00.000Z'),
      declarant: {
        declarantRole: 'PRELEVEUR',
        lastDeclarationAt: new Date('2025-01-01T00:00:00.000Z'),
        pointPrelevements: [],
        collecteurExploitations: []
      }
    }
  ]

  async function run(order) {
    let calls = 0
    const client = {
      async $queryRaw() {
        return []
      },
      user: {
        async findMany() {
          calls += 1
          return records
        }
      }
    }
    const result = await searchDeclarants(
      {id: 'admin-1', role: 'ADMIN'},
      {sort: 'LAST_DECLARATION', order},
      {client, now: new Date('2026-07-13T12:00:00.000Z')}
    )

    t.is(calls, 2)
    return result.items.map(item => item.id)
  }

  t.deepEqual(await run('DESC'), [records[0].id, records[2].id, records[1].id])
  t.deepEqual(await run('ASC'), [records[2].id, records[0].id, records[1].id])
})

test('searchDeclarants ignore les filtres et facettes exploitation sans zone autorisée', async t => {
  const declarantId = '73e76b9a-0b61-43e0-a45c-99052970ab14'
  const baseRecord = {
    id: declarantId,
    email: 'preleveur@example.test',
    firstName: 'Élodie',
    lastName: 'Martin',
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    declarant: {
      declarantRole: 'PRELEVEUR',
      declarantType: 'LEGAL_PERSON',
      preleveurType: 'IRRIGANT',
      socialReason: 'Ferme des Prés',
      lastDeclarationAt: new Date('2026-07-01T00:00:00.000Z'),
      pointPrelevements: [],
      collecteurExploitations: []
    }
  }
  const userQueries = []
  const client = {
    instructorZone: {
      async findMany(arguments_) {
        return arguments_.where.permissions.some.permission === 'declarant.list'
          ? [{zoneId: 'zone-list'}]
          : []
      }
    },
    async $queryRaw() {
      return [{declarantUserId: declarantId, zoneId: 'zone-list'}]
    },
    zone: {
      async findMany() {
        return [{
          id: 'zone-list',
          code: 'Z1',
          name: 'Zone 1',
          type: 'DEPARTEMENT'
        }]
      }
    },
    user: {
      async findMany(arguments_) {
        userQueries.push(arguments_)
        return userQueries.length === 1
          ? [baseRecord]
          : [{id: declarantId, declarant: {declarantRole: 'PRELEVEUR'}}]
      }
    }
  }

  const result = await searchDeclarants(
    {id: 'instructor-1', role: 'INSTRUCTOR'},
    {
      declarantType: 'LEGAL_PERSON',
      emailStatus: 'WITH_EMAIL',
      activityRange: 'LT_30_DAYS',
      collecteurStatus: 'WITH_COLLECTEUR',
      connectorStatus: 'WITH_CONNECTOR',
      usageCodes: ['2'],
      waterBodyTypes: ['SOUTERRAIN'],
      exploitationStatuses: ['EN_ACTIVITE']
    },
    {client, now: new Date('2026-07-13T12:00:00.000Z')}
  )

  t.false(Object.hasOwn(userQueries[0].select.declarant.select, 'pointPrelevements'))
  t.deepEqual(result.items, [{
    id: declarantId,
    declarant: {declarantRole: 'PRELEVEUR'}
  }])
  t.is(result.total, 1)
  t.deepEqual(result.counts, {
    total: 1,
    preleveurs: 1,
    collecteurs: 0,
    withoutEmail: 0
  })
  t.deepEqual(Object.keys(result.counts), [
    'total',
    'preleveurs',
    'collecteurs',
    'withoutEmail'
  ])
  t.false(Object.hasOwn(result.facets, 'collecteurStatuses'))
  t.false(Object.hasOwn(result.facets, 'connectorStatuses'))
  t.false(Object.hasOwn(result.facets, 'usageCodes'))
  t.false(Object.hasOwn(result.facets, 'waterBodyTypes'))
  t.false(Object.hasOwn(result.facets, 'exploitationStatuses'))
  t.deepEqual(result.facets.declarantTypes, [{
    value: 'LEGAL_PERSON',
    label: 'Personne morale',
    count: 1
  }])
  t.deepEqual(result.facets.activityRanges, [{
    value: 'LT_30_DAYS',
    label: 'Moins de 30 jours',
    count: 1
  }])
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
    async $queryRaw(query, declarantUserId) {
      calls.push(['user.lock', declarantUserId])
      t.regex(query.join(' '), /FOR UPDATE/)
      return [{id: declarantUserId}]
    },
    user: {
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
    ['user.lock', 'declarant-1'],
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
    async $queryRaw() {
      return []
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
