import test from 'ava'

import {
  canCreateDeclarant,
  canEditPointUsageName,
  decorateDeclarantsRights,
  getDeclarantRight,
  getDeclarantRights
} from '../resource-permissions.js'

test('canCreateDeclarant autorise un administrateur global', async t => {
  const canCreate = await canCreateDeclarant({id: 'admin-1', role: 'ADMIN'}, {
    client: {}
  })

  t.true(canCreate)
})

test('canCreateDeclarant autorise un agent qui possède le droit sur une zone active', async t => {
  let query
  const client = {
    instructorZone: {
      async findMany(arguments_) {
        query = arguments_
        return [{zoneId: 'zone-1'}]
      }
    }
  }

  const canCreate = await canCreateDeclarant({id: 'instructor-1', role: 'INSTRUCTOR'}, {client})

  t.true(canCreate)
  t.is(query.where.instructorUserId, 'instructor-1')
  t.deepEqual(query.where.permissions, {
    some: {permission: 'declarant.create'}
  })
})

test('canCreateDeclarant refuse un agent sans zone administrée', async t => {
  const client = {
    instructorZone: {
      findMany: async () => []
    }
  }

  const canCreate = await canCreateDeclarant({id: 'instructor-1', role: 'INSTRUCTOR'}, {client})

  t.false(canCreate)
})

test('canCreateDeclarant refuse les autres rôles', async t => {
  const canCreate = await canCreateDeclarant({id: 'declarant-1', role: 'DECLARANT'}, {
    client: {}
  })

  t.false(canCreate)
})

test('canEditPointUsageName autorise un rattachement actif direct ou collecteur', async t => {
  const queries = []
  const client = {
    declarantPointPrelevement: {
      async findFirst(arguments_) {
        queries.push(arguments_)
        return {id: 'exploitation-1'}
      }
    }
  }
  const now = new Date('2026-07-13T12:00:00.000Z')
  const canEdit = await canEditPointUsageName(
    {id: 'declarant-1', role: 'DECLARANT'},
    'point-1',
    {client, now}
  )

  t.true(canEdit)
  t.is(queries[0].where.pointPrelevementId, 'point-1')
  t.deepEqual(queries[0].where.OR, [
    {declarantUserId: 'declarant-1'},
    {collecteurs: {some: {collecteurUserId: 'declarant-1'}}}
  ])
  t.deepEqual(queries[0].where.AND, [
    {OR: [{startDate: null}, {startDate: {lte: now}}]},
    {OR: [{endDate: null}, {endDate: {gte: now}}]}
  ])
})

test('canEditPointUsageName refuse un déclarant sans rattachement actif', async t => {
  const client = {
    declarantPointPrelevement: {
      findFirst: async () => null
    }
  }

  t.false(await canEditPointUsageName(
    {id: 'declarant-1', role: 'DECLARANT'},
    'point-1',
    {client}
  ))
})

test('canEditPointUsageName refuse les autres rôles sans interroger la base', async t => {
  t.false(await canEditPointUsageName(
    {id: 'admin-1', role: 'ADMIN'},
    'point-1',
    {client: {}}
  ))
})

test('getDeclarantRights charge les zones et droits instructeur en deux requêtes fixes', async t => {
  const now = new Date('2026-07-13T12:00:00.000Z')
  const queries = []
  const client = {
    async $queryRaw(query) {
      queries.push(['effectiveDeclarantZones', query])
      return [
        {declarantUserId: 'declarant-1', zoneId: 'zone-1'},
        {declarantUserId: 'declarant-1', zoneId: 'zone-2'},
        {declarantUserId: 'declarant-2', zoneId: 'zone-2'}
      ]
    },
    instructorZone: {
      async findMany(arguments_) {
        queries.push(['instructorZone', arguments_])
        return [
          {
            zoneId: 'zone-1',
            permissions: [{permission: 'declarant.detail.read'}]
          },
          {
            zoneId: 'zone-2',
            permissions: [
              {permission: 'declarant.detail.read'},
              {permission: 'declarant.update'}
            ]
          }
        ]
      }
    }
  }

  const rights = await getDeclarantRights(
    {id: 'instructor-1', role: 'INSTRUCTOR'},
    ['declarant-1', 'declarant-2', 'declarant-3'],
    {client, now}
  )

  t.is(queries.length, 2)
  t.true(queries[0][1].values.includes('declarant-3'))
  t.is(queries[1][1].where.instructorUserId, 'instructor-1')
  t.deepEqual(queries[1][1].where.zoneId, {in: ['zone-1', 'zone-2']})
  t.deepEqual(queries[1][1].where.AND, [
    {startDate: {lte: now}},
    {OR: [{endDate: null}, {endDate: {gte: now}}]}
  ])
  t.like(rights.get('declarant-1'), {
    canRead: true,
    canEdit: true,
    isAdmin: false
  })
  t.like(rights.get('declarant-2'), {
    canRead: true,
    canEdit: true,
    isAdmin: false
  })
  t.like(rights.get('declarant-3'), {
    canRead: false,
    canEdit: false,
    isAdmin: false
  })
})

test('decorateDeclarantsRights conserve l’ordre et ne requête pas la base pour un administrateur', async t => {
  const declarants = [
    {id: 'declarant-2', label: 'Deux'},
    {userId: 'declarant-1', label: 'Un'}
  ]
  const decorated = await decorateDeclarantsRights(
    declarants,
    {id: 'admin-1', role: 'ADMIN'},
    {client: {}}
  )

  t.deepEqual(decorated.map(item => item.label), ['Deux', 'Un'])
  t.true(decorated.every(item => item.right.isAdmin))
  t.true(decorated.every(item => item.right.canRead && item.right.canEdit))
})

test('getDeclarantRight ignore un ancien rattachement EXPLOITATION sans preuve effective', async t => {
  let permissionQueryCount = 0
  const client = {
    async $queryRaw() {
      return []
    },
    instructorZone: {
      async findMany() {
        permissionQueryCount += 1
        return [{permissions: [{permission: 'declarant.detail.read'}]}]
      }
    }
  }

  const right = await getDeclarantRight(
    {id: 'instructor-1', role: 'INSTRUCTOR'},
    'declarant-1',
    {client}
  )

  t.false(right.canRead)
  t.false(right.canEdit)
  t.is(permissionQueryCount, 0)
})

test('getDeclarantRights groupe aussi les accès d’un collecteur', async t => {
  let query
  const client = {
    declarantCollecteurExploitation: {
      async findMany(arguments_) {
        query = arguments_
        return [{exploitation: {declarantUserId: 'preleveur-1'}}]
      }
    }
  }
  const rights = await getDeclarantRights(
    {id: 'collecteur-1', role: 'DECLARANT'},
    ['collecteur-1', 'preleveur-1', 'preleveur-2'],
    {client}
  )

  t.deepEqual(query.where, {
    collecteurUserId: 'collecteur-1',
    exploitation: {
      declarantUserId: {in: ['preleveur-1', 'preleveur-2']}
    }
  })
  t.true(rights.get('collecteur-1').canRead)
  t.true(rights.get('preleveur-1').canRead)
  t.false(rights.get('preleveur-2').canRead)
})
