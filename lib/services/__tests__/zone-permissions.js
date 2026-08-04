import test from 'ava'

import {
  activeInstructorZoneWhere,
  getDeclarantZoneIds,
  getEffectiveDeclarantZoneIds,
  getEffectiveDeclarantZoneLinks,
  getEffectiveDeclarantUserIdsByZone,
  getPermissionZoneIdsForUser,
  getSourceZoneIds,
  hasZonePermission,
  validateZonePermissions
} from '../zone-permissions.js'

const now = new Date('2026-07-14T12:00:00.000Z')

test('validateZonePermissions normalise une combinaison cohérente', t => {
  t.deepEqual(validateZonePermissions([
    'pp.update',
    'zone.detail.read',
    'zone.geometry.read',
    'pp.list',
    'pp.detail.read',
    'pp.update'
  ]), [
    'zone.detail.read',
    'zone.geometry.read',
    'pp.list',
    'pp.detail.read',
    'pp.update'
  ])
})

test('validateZonePermissions refuse les droits inconnus et les dépendances absentes', t => {
  const unknownError = t.throws(() => validateZonePermissions(['unknown.permission']))
  t.is(unknownError.statusCode, 400)
  t.regex(unknownError.message, /Droits inconnus/)

  const dependencyError = t.throws(() => validateZonePermissions(['pp.update']))
  t.is(dependencyError.statusCode, 400)
  t.regex(dependencyError.message, /pp\.update requiert pp\.detail\.read/)
})

test('activeInstructorZoneWhere inclut la période active et le droit demandé', t => {
  const where = activeInstructorZoneWhere('agent-1', {
    now,
    permission: 'declaration.instruct'
  })

  t.is(where.instructorUserId, 'agent-1')
  t.deepEqual(where.permissions, {
    some: {permission: 'declaration.instruct'}
  })
  t.deepEqual(where.AND, [
    {startDate: {lte: now}},
    {OR: [{endDate: null}, {endDate: {gte: now}}]}
  ])
})

test('getPermissionZoneIdsForUser donne toutes les zones filtrées à un administrateur', async t => {
  let query
  const client = {
    zone: {
      async findMany(arguments_) {
        query = arguments_
        return [{id: 'zone-2'}]
      }
    }
  }

  const zoneIds = await getPermissionZoneIdsForUser(
    {id: 'admin-1', role: 'ADMIN'},
    'pp.list',
    {client, zoneIds: ['zone-2', 'zone-2']}
  )

  t.deepEqual(zoneIds, ['zone-2'])
  t.deepEqual(query.where, {id: {in: ['zone-2']}})
})

test('getPermissionZoneIdsForUser filtre les habilitations actives par droit', async t => {
  let query
  const client = {
    instructorZone: {
      async findMany(arguments_) {
        query = arguments_
        return [{zoneId: 'zone-1'}]
      }
    }
  }

  const zoneIds = await getPermissionZoneIdsForUser(
    {id: 'agent-1', role: 'INSTRUCTOR'},
    'declaration.reconcile',
    {client, now, zoneIds: ['zone-1', 'zone-2']}
  )

  t.deepEqual(zoneIds, ['zone-1'])
  t.is(query.where.instructorUserId, 'agent-1')
  t.deepEqual(query.where.zoneId, {in: ['zone-1', 'zone-2']})
  t.deepEqual(query.where.permissions, {
    some: {permission: 'declaration.reconcile'}
  })
  t.deepEqual(query.where.AND, [
    {startDate: {lte: now}},
    {OR: [{endDate: null}, {endDate: {gte: now}}]}
  ])
})

test('hasZonePermission accepte une ressource liée à au moins une zone autorisée', async t => {
  const client = {
    instructorZone: {
      async findMany() {
        return [{zoneId: 'zone-2'}]
      }
    }
  }

  t.true(await hasZonePermission(
    {id: 'agent-1', role: 'INSTRUCTOR'},
    'pp.update',
    ['zone-1', 'zone-2'],
    {client, now}
  ))
  t.false(await hasZonePermission(
    {id: 'agent-1', role: 'INSTRUCTOR'},
    'pp.update',
    [],
    {client, now}
  ))
})

test('getPermissionZoneIdsForUser refuse implicitement les rôles non agents', async t => {
  t.deepEqual(await getPermissionZoneIdsForUser(
    {id: 'declarant-1', role: 'DECLARANT'},
    'zone.detail.read',
    {client: {}}
  ), [])
})

test('getPermissionZoneIdsForUser reste fermé quand un filtre de zones vide est explicite', async t => {
  const client = {
    zone: {
      findMany: () => t.fail('Un administrateur ne doit pas élargir un filtre vide.')
    },
    instructorZone: {
      findMany: () => t.fail('Un instructeur ne doit pas élargir un filtre vide.')
    }
  }

  t.deepEqual(await getPermissionZoneIdsForUser(
    {id: 'admin-1', role: 'ADMIN'},
    'declarant.detail.read',
    {client, zoneIds: []}
  ), [])
  t.deepEqual(await getPermissionZoneIdsForUser(
    {id: 'instructor-1', role: 'INSTRUCTOR'},
    'declarant.detail.read',
    {client, zoneIds: []}
  ), [])
})

test('getEffectiveDeclarantZoneLinks reconstruit toutes les preuves sans faire confiance aux liens EXPLOITATION stockés', async t => {
  let queryParts
  const rows = [
    {declarantUserId: 'declarant-1', zoneId: 'zone-1'},
    {declarantUserId: 'declarant-1', zoneId: 'zone-2'}
  ]
  const client = {
    async $queryRaw(query) {
      queryParts = query
      return rows
    }
  }

  const links = await getEffectiveDeclarantZoneLinks({
    client,
    declarantUserIds: ['declarant-1', 'declarant-1'],
    zoneIds: ['zone-1', 'zone-2']
  })
  const sql = queryParts.strings.join(' ')

  t.deepEqual(links, rows)
  t.regex(sql, /source IN/)
  t.regex(sql, /'CREATION'/)
  t.regex(sql, /'MANUAL'/)
  t.regex(sql, /'MIGRATION'/)
  t.notRegex(sql, /'DECLARATION'::"DeclarantZoneSource"/)
  t.notRegex(sql, /'RECONCILIATION'::"DeclarantZoneSource"/)
  t.regex(sql, /"DeclarantPointPrelevement" exploitation/)
  t.regex(sql, /"DeclarantCollecteurExploitation" collector_link/)
  t.regex(sql, /chunk\."preleveurUserId"/)
  t.regex(sql, /chunk\."submittedByDeclarantUserId"/)
  t.regex(sql, /chunk\."collecteurUserId"/)
  t.regex(sql, /declaration\."declarantUserId"/)
  t.regex(sql, /declaration\."createdByDeclarantUserId"/)
  t.true(queryParts.values.includes('declarant-1'))
  t.true(queryParts.values.includes('zone-1'))
  t.true(queryParts.values.includes('zone-2'))
})

test('getEffectiveDeclarantZoneIds déduplique les zones effectives et évite les filtres vides', async t => {
  let queryCount = 0
  const client = {
    async $queryRaw() {
      queryCount += 1
      return [
        {declarantUserId: 'declarant-1', zoneId: 'zone-1'},
        {declarantUserId: 'declarant-1', zoneId: 'zone-1'},
        {declarantUserId: 'declarant-1', zoneId: 'zone-2'}
      ]
    }
  }

  t.deepEqual(await getEffectiveDeclarantZoneIds('declarant-1', {client}), [
    'zone-1',
    'zone-2'
  ])
  t.deepEqual(await getDeclarantZoneIds('declarant-1', {client}), [
    'zone-1',
    'zone-2'
  ])
  t.deepEqual(await getEffectiveDeclarantZoneLinks({client, zoneIds: []}), [])
  t.is(queryCount, 2)
})

test('getSourceZoneIds combine les points de la source et les zones effectives de ses déclarants', async t => {
  let effectiveZoneQuery
  const client = {
    source: {
      async findUnique() {
        return {
          declaration: {
            declarantUserId: 'declarant-1',
            createdByDeclarantUserId: 'declarant-2'
          },
          chunks: [
            {pointPrelevementId: 'point-1'},
            {pointPrelevementId: 'point-1'}
          ]
        }
      }
    },
    pointPrelevementZone: {
      async findMany() {
        return [
          {zoneId: 'zone-1'},
          {zoneId: 'zone-2'}
        ]
      }
    },
    async $queryRaw(query) {
      effectiveZoneQuery = query
      return [
        {declarantUserId: 'declarant-1', zoneId: 'zone-2'},
        {declarantUserId: 'declarant-2', zoneId: 'zone-3'}
      ]
    }
  }

  t.deepEqual(await getSourceZoneIds('source-1', {client}), [
    'zone-1',
    'zone-2',
    'zone-3'
  ])
  t.true(effectiveZoneQuery.values.includes('declarant-1'))
  t.true(effectiveZoneQuery.values.includes('declarant-2'))
})

test('getEffectiveDeclarantUserIdsByZone résout plusieurs zones en une requête et reste fermé par défaut', async t => {
  let queryCount = 0
  const client = {
    async $queryRaw() {
      queryCount += 1
      return [
        {declarantUserId: 'declarant-1', zoneId: 'zone-1'},
        {declarantUserId: 'declarant-1', zoneId: 'zone-1'},
        {declarantUserId: 'declarant-2', zoneId: 'zone-2'},
        {declarantUserId: 'declarant-outside', zoneId: 'zone-outside'}
      ]
    }
  }

  const byZone = await getEffectiveDeclarantUserIdsByZone(
    ['zone-1', 'zone-2', 'zone-1'],
    {client}
  )

  t.deepEqual([...byZone], [
    ['zone-1', ['declarant-1']],
    ['zone-2', ['declarant-2']]
  ])
  t.deepEqual([...await getEffectiveDeclarantUserIdsByZone([], {client})], [])
  t.is(queryCount, 1)
})
