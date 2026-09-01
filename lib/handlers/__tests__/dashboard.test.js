import test from 'ava'

import {
  buildDashboardMapPayload,
  buildUsageDistributionFromDashboardPoints,
  buildVolumeCharts,
  DASHBOARD_SOURCE_TYPES,
  getCompletedDashboardSourceWhere,
  getDeclarationPeriodOptions,
  getDashboardTerritoryPointData,
  getRegisteredPrelevementsByUsage,
  getUsageDistribution,
  getVolumeYearOptions,
  getVolumesByUsage,
  parseDashboardIncludePoints,
  parseDashboardMapScope
} from '../dashboard.js'

function createUsage(id, code, label) {
  return {
    id,
    code,
    kind: 'USAGE',
    parentId: null,
    mnemonic: null,
    label,
    definition: null,
    status: null,
    color: '#000091',
    dashboardVisible: true
  }
}

function createVolumeRow({flowType, month, usage, volume}) {
  return {
    flowType,
    month,
    usageId: usage.id,
    usageCode: usage.code,
    usageMnemonic: usage.mnemonic,
    usageLabel: usage.label,
    usageColor: usage.color,
    volume
  }
}

function assertCompletedDashboardSourceSql(t, query) {
  const sql = query.strings.join(' ')
  const sourceTypeValues = query.values.filter(value =>
    DASHBOARD_SOURCE_TYPES.includes(value))
  const sourceStatusValues = query.values.filter(value =>
    ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'].includes(value))

  t.regex(sql, /s\.type IN/)
  t.regex(sql, /::"SourceType"/)
  t.regex(sql, /s\.status =/)
  t.regex(sql, /::"SourceStatus"/)
  t.regex(query.sql, /s\.type IN \(\?::"SourceType",\?::"SourceType"\)/)
  t.regex(query.sql, /s\.status = \?::"SourceStatus"/)
  t.regex(sql, /c\."instructionStatus" <> 'REJECTED'/)
  t.deepEqual(sourceTypeValues, ['DECLARATION', 'API'])
  t.deepEqual(sourceStatusValues, ['COMPLETED'])
  t.false(query.values.includes('BATCH'))
}

test('le tableau de bord accepte uniquement les déclarations et télérelèves terminées', t => {
  t.deepEqual(DASHBOARD_SOURCE_TYPES, ['DECLARATION', 'API'])
  t.deepEqual(getCompletedDashboardSourceWhere(), {
    type: {
      in: ['DECLARATION', 'API']
    },
    status: 'COMPLETED'
  })
})

test('getDeclarationPeriodOptions inclut les télérelèves valides et exclut les chunks rejetés', async t => {
  const irrigation = createUsage('irrigation', '2', 'Irrigation')
  let query
  const client = {
    chunk: {
      async findMany(options) {
        query = options

        return [{
          minDate: new Date('2025-07-01T00:00:00.000Z'),
          maxDate: new Date('2025-07-31T00:00:00.000Z'),
          usage: irrigation
        }]
      }
    }
  }

  const options = await getDeclarationPeriodOptions(['zone-1'], 'month', {
    client,
    declarantUserIds: ['actor-1']
  })

  t.deepEqual(query.where.source, getCompletedDashboardSourceWhere())
  t.deepEqual(query.where.instructionStatus, {not: 'REJECTED'})
  t.deepEqual(query.where.OR[0], {
    source: {
      declaration: {
        OR: [
          {declarantUserId: {in: ['actor-1']}},
          {createdByDeclarantUserId: {in: ['actor-1']}}
        ]
      }
    }
  })
  t.deepEqual(query.where.OR[1], {
    source: {
      type: 'API'
    },
    OR: [
      {preleveurUserId: {in: ['actor-1']}},
      {submittedByDeclarantUserId: {in: ['actor-1']}},
      {collecteurUserId: {in: ['actor-1']}}
    ]
  })
  t.true(options.some(option => option.value === '2025-07'))
})

test('getRegisteredPrelevementsByUsage déduplique un point déclaré plusieurs fois', async t => {
  const irrigation = createUsage('irrigation', '2', 'Irrigation')
  let chunkQuery
  const client = {
    declarantPointPrelevement: {
      async findMany() {
        return [
          {pointPrelevementId: 'point-1', usage: irrigation},
          {pointPrelevementId: 'point-2', usage: irrigation}
        ]
      }
    },
    chunk: {
      async findMany(options) {
        chunkQuery = options

        return [
          {pointPrelevementId: 'point-1', usage: irrigation},
          {pointPrelevementId: 'point-1', usage: irrigation}
        ]
      }
    }
  }

  const rows = await getRegisteredPrelevementsByUsage(
    ['zone-1'],
    'month',
    '2026-08',
    {client}
  )

  t.deepEqual(chunkQuery.where.source, getCompletedDashboardSourceWhere())
  t.deepEqual(chunkQuery.where.instructionStatus, {not: 'REJECTED'})
  t.like(rows[0], {
    declaredPointsCount: 1,
    missingPointsCount: 1,
    totalPointsCount: 2
  })
})

test('getRegisteredPrelevementsByUsage inclut un usage secondaire sans dupliquer les points', async t => {
  const irrigation = createUsage('irrigation', '2', 'Irrigation')
  const industry = createUsage('industry', '4', 'Industrie')
  let exploitationQuery
  const client = {
    declarantPointPrelevement: {
      async findMany(query) {
        exploitationQuery = query
        return [{
          pointPrelevementId: 'point-1',
          usage: irrigation,
          secondaryUsageLinks: [{usage: industry}, {usage: industry}]
        }]
      }
    },
    chunk: {
      async findMany() {
        return []
      }
    }
  }

  const rows = await getRegisteredPrelevementsByUsage(
    ['zone-1'],
    'month',
    '2026-08',
    {client}
  )
  const rowsByUsageId = new Map(rows.map(row => [row.usage.id, row]))

  t.false(Object.hasOwn(exploitationQuery.where, 'usageId'))
  t.truthy(exploitationQuery.select.secondaryUsageLinks)
  t.is(rowsByUsageId.get(irrigation.id).totalPointsCount, 1)
  t.is(rowsByUsageId.get(industry.id).totalPointsCount, 1)
})

test('getVolumeYearOptions applique la politique de sources aux années', async t => {
  let query
  const client = {
    async $queryRaw(value) {
      query = value
      return [{year: 2024}]
    }
  }

  const years = await getVolumeYearOptions(['zone-1'], null, {client})

  assertCompletedDashboardSourceSql(t, query)
  t.true(years.includes(2024))
})

test('getVolumesByUsage agrège les volumes des sources éligibles', async t => {
  const irrigation = createUsage('irrigation', '2', 'Irrigation')
  let query
  let expectedUsageQuery
  const client = {
    async $queryRaw(value) {
      query = value
      return [createVolumeRow({
        flowType: 'PRELEVEMENT',
        month: 7,
        usage: irrigation,
        volume: 125
      })]
    },
    declarantPointPrelevement: {
      async findMany(options) {
        expectedUsageQuery = options
        return []
      }
    }
  }

  const charts = await getVolumesByUsage(['zone-1'], 2026, null, {client})

  assertCompletedDashboardSourceSql(t, query)
  t.false(Object.hasOwn(expectedUsageQuery.where, 'usageId'))
  t.like(charts.withdrawn.usages[0], {
    usage: irrigation,
    total: 125,
    hasData: true
  })
})

test('getUsageDistribution ne filtre pas un usage principal obligatoire contre null', async t => {
  let exploitationQuery
  const client = {
    declarantPointPrelevement: {
      async findMany(options) {
        exploitationQuery = options
        return []
      }
    }
  }

  const distribution = await getUsageDistribution(['zone-1'], {client})

  t.deepEqual(distribution, [])
  t.false(Object.hasOwn(exploitationQuery.where, 'usageId'))
})

test('buildVolumeCharts conserve les usages attendus sans volume dans la légende', t => {
  const irrigation = createUsage('irrigation', '2', 'Irrigation')
  const industry = createUsage('industry', '4', 'Industrie')
  const drinkingWater = createUsage('drinking-water', '1', 'Alimentation en eau potable')
  const sanitation = createUsage('sanitation', '6', 'Assainissement')
  const charts = buildVolumeCharts([
    createVolumeRow({
      flowType: 'PRELEVEMENT',
      month: 3,
      usage: irrigation,
      volume: 125
    }),
    createVolumeRow({
      flowType: 'PRELEVEMENT',
      month: 4,
      usage: drinkingWater,
      volume: 0
    })
  ], 2026, [
    {flowType: 'PRELEVEMENT', usage: irrigation},
    {flowType: 'PRELEVEMENT', usage: industry},
    {flowType: 'REJET', usage: sanitation}
  ])

  const withdrawnUsages = new Map(
    charts.withdrawn.usages.map(item => [item.usage.id, item])
  )

  t.like(withdrawnUsages.get(irrigation.id), {
    total: 125,
    hasData: true
  })
  t.like(withdrawnUsages.get(industry.id), {
    total: 0,
    hasData: false
  })
  t.like(withdrawnUsages.get(drinkingWater.id), {
    total: 0,
    hasData: false
  })
  t.like(charts.discharged.usages[0], {
    usage: sanitation,
    total: 0,
    hasData: false
  })
  t.deepEqual(charts.withdrawn.months[2].usages, [{
    usage: irrigation,
    volume: 125,
    percentage: 100
  }])
})

test('parseDashboardIncludePoints conserve le payload historique par défaut', t => {
  t.true(parseDashboardIncludePoints())
  t.true(parseDashboardIncludePoints('true'))
  t.false(parseDashboardIncludePoints('false'))

  const error = t.throws(() => parseDashboardIncludePoints('non'))
  t.is(error.statusCode, 400)
})

test('parseDashboardMapScope valide les deux cartes disponibles', t => {
  t.is(parseDashboardMapScope(), 'territory')
  t.is(parseDashboardMapScope('territory'), 'territory')
  t.is(parseDashboardMapScope('activity'), 'activity')

  const error = t.throws(() => parseDashboardMapScope('all'))
  t.is(error.statusCode, 400)
})

test('la distribution issue du corpus de points conserve les usages secondaires', t => {
  const irrigation = createUsage('irrigation', '2', 'Irrigation')
  const industry = createUsage('industry', '4', 'Industrie')
  const distribution = buildUsageDistributionFromDashboardPoints([
    {
      declarants: [
        {
          usage: irrigation,
          secondaryUsageLinks: [{usage: industry}, {usage: industry}]
        },
        {usage: irrigation, secondaryUsageLinks: []}
      ]
    }
  ])

  t.deepEqual(distribution.map(item => [item.usage.id, item.count]), [
    ['irrigation', 2],
    ['industry', 1]
  ])
})

test('includePoints=false calcule les métriques sans charger les cartes', async t => {
  const usageDistribution = [{usage: createUsage('irrigation', '2', 'Irrigation'), count: 3}]
  const pointData = await getDashboardTerritoryPointData({
    declarantUserIds: ['declarant-1'],
    includePoints: false,
    shouldLoadActivityPoints: true,
    zoneIds: ['zone-1']
  }, {
    async countPoints(zoneIds, options) {
      t.deepEqual(zoneIds, ['zone-1'])
      t.deepEqual(options, {declarantUserIds: ['declarant-1']})
      return 12
    },
    async getDistribution(zoneIds, options) {
      t.deepEqual(zoneIds, ['zone-1'])
      t.deepEqual(options, {declarantUserIds: ['declarant-1']})
      return usageDistribution
    },
    async listPoints() {
      throw new Error('La carte activité ne doit pas être chargée')
    },
    async loadPointCorpus() {
      throw new Error('Le corpus cartographique ne doit pas être chargé')
    }
  })

  t.deepEqual(pointData, {
    activityPoints: [],
    points: [],
    totalPoints: 12,
    usageDistribution
  })
})

test('includePoints=true réutilise le corpus territoire pour les points et les usages', async t => {
  const irrigation = createUsage('irrigation', '2', 'Irrigation')
  const coordinates = {type: 'Point', coordinates: [2.3, 48.8]}
  let corpusLoads = 0
  const pointData = await getDashboardTerritoryPointData({
    declarantUserIds: ['declarant-1'],
    includePoints: true,
    shouldLoadActivityPoints: true,
    zoneIds: ['zone-1']
  }, {
    async listPoints(zoneIds, options) {
      t.deepEqual(zoneIds, [])
      t.deepEqual(options, {
        declarantUserIds: ['declarant-1'],
        requireZoneFilter: false
      })
      return [{id: 'activity-point'}]
    },
    async loadPointCorpus(zoneIds, options) {
      corpusLoads++
      t.deepEqual(zoneIds, ['zone-1'])
      t.deepEqual(options, {declarantUserIds: ['declarant-1']})

      return {
        coordinatesById: new Map([['territory-point', coordinates]]),
        points: [{
          id: 'territory-point',
          name: 'Point territoire',
          usageName: null,
          flowType: 'PRELEVEMENT',
          nature: 'NAPPE',
          withdrawalType: 'SOUTERRAIN',
          declarants: [{
            declarantUserId: 'declarant-1',
            usage: irrigation,
            secondaryUsageLinks: []
          }]
        }]
      }
    }
  })

  t.is(corpusLoads, 1)
  t.deepEqual(pointData, {
    activityPoints: [{id: 'activity-point'}],
    points: [{
      id: 'territory-point',
      name: 'Point territoire',
      usageName: null,
      flowType: 'PRELEVEMENT',
      nature: 'NAPPE',
      withdrawalType: 'SOUTERRAIN',
      coordinates,
      usages: [irrigation]
    }],
    totalPoints: 1,
    usageDistribution: [{usage: irrigation, count: 1}]
  })
})

test('la carte territory applique la sélection de zones accessible', async t => {
  const territoryPoints = [{id: 'point-1'}]
  let listOptions
  const payload = await buildDashboardMapPayload({
    requestedZoneCodes: 'Z1,INCONNUE',
    scope: 'territory',
    user: {id: 'instructor-1', role: 'INSTRUCTOR'}
  }, {
    async listPoints(zoneIds, options) {
      t.deepEqual(zoneIds, ['zone-1'])
      listOptions = options
      return territoryPoints
    },
    async resolveZoneSelection(user, requestedZoneCodes) {
      t.is(user.id, 'instructor-1')
      t.is(requestedZoneCodes, 'Z1,INCONNUE')

      return {
        declarantUserIds: null,
        requestedZoneCodes: ['Z1', 'INCONNUE'],
        selectedZones: [{
          id: 'zone-1',
          code: 'Z1',
          permissions: [
            'zone.dashboard.read',
            'exploitation.list',
            'declarant.list',
            'pp.detail.read'
          ]
        }],
        accessibleZones: [
          {
            id: 'zone-1',
            code: 'Z1',
            permissions: [
              'zone.dashboard.read',
              'exploitation.list',
              'declarant.list',
              'pp.detail.read'
            ]
          },
          {id: 'zone-2', code: 'Z2', permissions: []}
        ]
      }
    }
  })

  t.deepEqual(listOptions, {collecteurUserId: null, declarantUserIds: null})
  t.deepEqual(payload, {
    scope: 'territory',
    selectedZoneCodes: ['Z1'],
    unknownZoneCodes: ['INCONNUE'],
    capabilities: {readPointActors: true, readPointDetails: true},
    points: territoryPoints
  })
})

test('la carte activity retourne uniquement les points du déclarant', async t => {
  const activityPoints = [{id: 'point-activity'}]
  const payload = await buildDashboardMapPayload({
    requestedZoneCodes: 'IGNOREE',
    scope: 'activity',
    user: {
      id: 'declarant-1',
      role: 'DECLARANT',
      declarant: {declarantRole: 'PRELEVEUR'}
    }
  }, {
    async listPoints(zoneIds, options) {
      t.deepEqual(zoneIds, [])
      t.deepEqual(options, {
        collecteurUserId: null,
        declarantUserIds: ['declarant-1'],
        requireZoneFilter: false
      })
      return activityPoints
    }
  })

  t.deepEqual(payload, {
    scope: 'activity',
    selectedZoneCodes: [],
    unknownZoneCodes: [],
    capabilities: {readPointActors: true, readPointDetails: true},
    points: activityPoints
  })
})

test('la carte activity reste interdite aux comptes territoriaux', async t => {
  const error = await t.throwsAsync(() => buildDashboardMapPayload({
    scope: 'activity',
    user: {id: 'instructor-1', role: 'INSTRUCTOR'}
  }))

  t.is(error.statusCode, 403)
})
