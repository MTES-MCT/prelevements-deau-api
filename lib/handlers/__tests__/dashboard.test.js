import test from 'ava'

import {
  buildVolumeCharts,
  DASHBOARD_SOURCE_TYPES,
  getCompletedDashboardSourceWhere,
  getDeclarationPeriodOptions,
  getRegisteredPrelevementsByUsage,
  getVolumeYearOptions,
  getVolumesByUsage
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
      async findMany() {
        return []
      }
    }
  }

  const charts = await getVolumesByUsage(['zone-1'], 2026, null, {client})

  assertCompletedDashboardSourceSql(t, query)
  t.like(charts.withdrawn.usages[0], {
    usage: irrigation,
    total: 125,
    hasData: true
  })
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
