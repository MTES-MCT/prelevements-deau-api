import test from 'ava'

import {
  buildAggregationOptionGroupsQuery,
  buildAggregationOptionsPayload,
  listAggregationOptionGroups,
  validateOptionsQueryParams
} from '../series-aggregation-options.js'

const POINT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SOURCE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PRELEVEUR_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const COLLECTEUR_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

test('physical meter options are an explicit boolean opt-in for rolling compatibility', t => {
  t.is(validateOptionsQueryParams({pointIds: POINT_ID}).includeMeterReadings, undefined)
  t.true(validateOptionsQueryParams({pointIds: POINT_ID, includeMeterReadings: 'true'}).includeMeterReadings)
  t.false(validateOptionsQueryParams({pointIds: POINT_ID, includeMeterReadings: 'false'}).includeMeterReadings)
  t.is(t.throws(() => validateOptionsQueryParams({pointIds: POINT_ID, includeMeterReadings: 'invalid'})).status, 400)
})

test('la vue graphique des options exige un opt-in explicite', t => {
  t.is(validateOptionsQueryParams({pointIds: POINT_ID}).view, undefined)
  t.is(validateOptionsQueryParams({pointIds: POINT_ID, view: 'chart'}).view, 'chart')
  t.is(t.throws(() => validateOptionsQueryParams({pointIds: POINT_ID, view: 'invalid'})).status, 400)
})

test('validateOptionsQueryParams accepte les scopes UUID', t => {
  const value = validateOptionsQueryParams({
    pointIds: POINT_ID,
    sourceId: SOURCE_ID,
    preleveurId: PRELEVEUR_ID,
    collecteurId: COLLECTEUR_ID,
    ignored: 'value'
  })

  t.deepEqual(value, {
    pointIds: POINT_ID,
    sourceId: SOURCE_ID,
    preleveurId: PRELEVEUR_ID,
    collecteurId: COLLECTEUR_ID
  })
})

test('validateOptionsQueryParams exige au moins un scope', t => {
  const error = t.throws(() => validateOptionsQueryParams({}))

  t.regex(error.message, /pointIds, preleveurId, collecteurId ou sourceId/)
})

test('validateOptionsQueryParams rejette les anciens IDs non UUID', t => {
  const error = t.throws(() => validateOptionsQueryParams({
    pointIds: '1,2,3'
  }))

  t.regex(error.message, /UUID v4/)
})

test('buildAggregationOptionsPayload agrège par métrique et conserve l’unité disponible', t => {
  const payload = buildAggregationOptionsPayload({
    groupedBySeries: [
      {
        metricTypeCode: 'volume prélevé',
        unit: null,
        chunkId: 'chunk-1',
        _min: {
          periodStart: new Date('2026-06-01T00:00:00.000Z'),
          periodEnd: new Date('2026-07-01T00:00:00.000Z')
        },
        _max: {periodEnd: new Date('2026-07-01T00:00:00.000Z')}
      },
      {
        metricTypeCode: 'volume prélevé',
        unit: 'm³',
        chunkId: 'chunk-2',
        _min: {
          periodStart: new Date('2026-05-01T00:00:00.000Z'),
          periodEnd: new Date('2026-08-01T00:00:00.000Z')
        },
        _max: {periodEnd: new Date('2026-08-01T00:00:00.000Z')}
      },
      {
        metricTypeCode: 'UNKNOWN_METRIC',
        unit: 'u',
        chunkId: 'chunk-3',
        _min: {
          periodStart: new Date('2025-12-31T00:00:00.000Z'),
          periodEnd: new Date('2026-01-01T00:00:00.000Z')
        },
        _max: {periodEnd: new Date('2026-01-02T00:00:00.000Z')}
      },
      {
        metricTypeCode: 'index',
        flowType: 'REJET',
        unit: 'm³',
        chunkId: 'chunk-4',
        _min: {
          periodStart: new Date('2026-05-31T23:45:00.000Z'),
          periodEnd: new Date('2026-06-01T00:00:00.000Z')
        },
        _max: {periodEnd: new Date('2026-06-02T00:00:00.000Z')}
      }
    ],
    resolvedPoints: [
      {id: POINT_ID, point: {name: 'Point A'}}
    ]
  })

  t.is(payload.parameters.length, 2)
  t.like(payload.parameters.find(parameter => parameter.id === 'volume:PRELEVEMENT'), {
    id: 'volume:PRELEVEMENT',
    name: 'volume',
    label: 'Volume prélevé',
    flowType: 'PRELEVEMENT',
    unit: 'm³',
    minDate: '2026-05-01',
    maxDate: '2026-07-31',
    seriesCount: 2,
    hasTemporalOverlap: false,
    availableFrequencies: [
      '15 minutes',
      '1 hour',
      '6 hours',
      '1 day',
      '1 week',
      '1 month',
      '1 quarter',
      '1 year'
    ]
  })
  t.like(payload.parameters.find(parameter => parameter.id === 'index:REJET'), {
    id: 'index:REJET',
    name: 'index',
    label: 'Index de rejet',
    flowType: 'REJET',
    minDate: '2026-06-01',
    maxDate: '2026-06-02'
  })
  t.deepEqual(payload.points, [
    {id: POINT_ID, name: 'Point A', flowType: null}
  ])
})

test('buildAggregationOptionsPayload conserve le contrat avec les agrégats SQL compacts', t => {
  const resolvedPoints = [{
    id: POINT_ID,
    point: {name: 'Point A', flowType: 'PRELEVEMENT'}
  }]
  const legacyPayload = buildAggregationOptionsPayload({
    groupedBySeries: [
      {
        metricTypeCode: 'volume prélevé',
        unit: null,
        flowType: 'PRELEVEMENT',
        _min: {
          periodStart: new Date('2026-05-01T00:00:00.000Z'),
          periodEnd: new Date('2026-06-01T00:00:00.000Z')
        },
        _max: {periodEnd: new Date('2026-06-01T00:00:00.000Z')}
      },
      {
        metricTypeCode: 'volume prélevé',
        unit: 'm³',
        flowType: 'PRELEVEMENT',
        _min: {
          periodStart: new Date('2026-06-01T00:00:00.000Z'),
          periodEnd: new Date('2026-07-01T00:00:00.000Z')
        },
        _max: {periodEnd: new Date('2026-07-01T00:00:00.000Z')}
      }
    ],
    resolvedPoints
  })
  const sqlPayload = buildAggregationOptionsPayload({
    groupedBySeries: [
      {
        metricTypeCode: 'volume prélevé',
        unit: null,
        flowType: 'PRELEVEMENT',
        minPeriodStart: new Date('2026-05-01T00:00:00.000Z'),
        minPeriodEnd: new Date('2026-06-01T00:00:00.000Z'),
        maxPeriodEnd: new Date('2026-06-01T00:00:00.000Z'),
        seriesCount: 1
      },
      {
        metricTypeCode: 'volume prélevé',
        unit: 'm³',
        flowType: 'PRELEVEMENT',
        minPeriodStart: new Date('2026-06-01T00:00:00.000Z'),
        minPeriodEnd: new Date('2026-07-01T00:00:00.000Z'),
        maxPeriodEnd: new Date('2026-07-01T00:00:00.000Z'),
        seriesCount: 1
      }
    ],
    resolvedPoints
  })

  t.deepEqual(sqlPayload, legacyPayload)
})

test('la vue graphique omet uniquement les points et conserve toutes les options et métadonnées', t => {
  const input = {
    includeExploitationIndexes: true,
    groupedBySeries: [
      {
        metricTypeCode: 'volume',
        flowType: 'REJET',
        unit: 'm³',
        seriesCount: 3000,
        minPeriodStart: new Date('2025-01-01T00:00:00Z'),
        maxPeriodEnd: new Date('2026-01-01T00:00:00Z')
      },
      {
        metricTypeCode: 'relevé d\'index',
        flowType: 'PRELEVEMENT',
        exploitationId: 'exploitation-1',
        countingCode: 'C-01',
        pointName: 'Point A',
        unit: 'm³',
        seriesCount: 1,
        minPeriodEnd: new Date('2025-03-01T00:00:00Z'),
        maxPeriodEnd: new Date('2025-04-01T00:00:00Z')
      }
    ],
    resolvedPoints: [{id: POINT_ID, point: {name: 'Point A', flowType: 'PRELEVEMENT'}}]
  }
  const legacy = buildAggregationOptionsPayload(input)
  const chart = buildAggregationOptionsPayload({...input, view: 'chart'})

  t.deepEqual(chart, {parameters: legacy.parameters})
  t.is(chart.parameters.length, 2)
  t.like(chart.parameters.find(parameter => parameter.name === 'index'), {
    id: 'index:PRELEVEMENT:exploitation:exploitation-1',
    exploitationId: 'exploitation-1',
    countingCode: 'C-01',
    label: 'Index de prélèvement — Point A — Comptage C-01',
    minDate: '2025-03-01',
    maxDate: '2025-04-01'
  })
  t.deepEqual(buildAggregationOptionsPayload({
    groupedBySeries: [],
    resolvedPoints: [],
    view: 'chart'
  }), {parameters: []})
})

test('le groupage compact conserve le comptage des unités et alias sans fusionner les index', t => {
  const dates = {
    minPeriodStart: new Date('2026-01-01T00:00:00Z'),
    minPeriodEnd: new Date('2026-01-02T00:00:00Z'),
    maxPeriodEnd: new Date('2026-01-03T00:00:00Z')
  }
  const volumes = [
    {metricTypeCode: 'volume', unit: null, seriesCount: 2, ...dates},
    {metricTypeCode: 'volume', unit: 'm³', seriesCount: 3, ...dates},
    {metricTypeCode: 'volume prélevé', unit: 'm³', seriesCount: 1, ...dates}
  ]
  const indexes = ['exploitation-1', 'exploitation-2'].map(exploitationId => ({
    metricTypeCode: 'index',
    exploitationId,
    countingCode: exploitationId,
    pointName: 'Point partagé',
    flowType: 'PRELEVEMENT',
    seriesCount: 1,
    ...dates
  }))
  const legacyGroups = volumes.flatMap(group => Array.from({length: group.seriesCount}, (_, index) => ({
    ...group,
    exploitationId: `exploitation-${index}`,
    pointName: `Point ${index}`,
    flowType: 'PRELEVEMENT',
    seriesCount: 1
  }))).concat(indexes)
  const compactGroups = volumes.map(group => ({...group, flowType: 'PRELEVEMENT'})).concat(indexes)
  const input = {resolvedPoints: [], includeExploitationIndexes: true}
  const compact = buildAggregationOptionsPayload({...input, groupedBySeries: compactGroups})

  t.deepEqual(compact, buildAggregationOptionsPayload({...input, groupedBySeries: legacyGroups}))
  t.is(compact.parameters.find(parameter => parameter.name === 'volume').seriesCount, 6)
  t.is(compact.parameters.filter(parameter => parameter.name === 'index').length, 2)
})

test('la requête options agrège les séries et applique les scopes dans PostgreSQL', async t => {
  const query = buildAggregationOptionGroupsQuery({
    pointIds: [POINT_ID],
    sourceId: SOURCE_ID
  })
  let receivedQuery
  const rows = [{metricTypeCode: 'volume', seriesCount: 2}]
  const result = await listAggregationOptionGroups({
    client: {
      async $queryRaw(value) {
        receivedQuery = value
        return rows
      }
    },
    pointIds: [POINT_ID],
    sourceId: SOURCE_ID
  })

  t.is(result, rows)
  t.regex(query.sql, /count\(DISTINCT cv\."chunkId"\)::int/)
  t.regex(query.sql, /COALESCE\(c\."flowType", point\."flowType"\)/)
  t.regex(query.sql, /c\."pointPrelevementId" IN/)
  t.regex(query.sql, /c\."sourceId" =/)
  t.deepEqual(receivedQuery.values, query.values)
  t.true(query.values.includes(POINT_ID))
  t.true(query.values.includes(SOURCE_ID))
})

test('la requête options conserve les dimensions par exploitation uniquement pour les index demandés', async t => {
  const compact = buildAggregationOptionGroupsQuery({pointIds: [POINT_ID], includeExploitationIndexes: false})
  let indexed
  await listAggregationOptionGroups({
    client: {async $queryRaw(query) {
      indexed = query
      return []
    }},
    pointIds: [POINT_ID],
    includeExploitationIndexes: true
  })

  t.notRegex(compact.sql, /JOIN "DeclarantPointPrelevement"/)
  t.regex(compact.sql, /NULL::uuid AS "exploitationId"/)
  t.regex(indexed.sql, /CASE WHEN cv\."metricTypeCode" IN \([^)]*\) THEN c\."exploitationId" END/)
  t.regex(indexed.sql, /THEN exploitation\."countingCode" END/)
  t.regex(indexed.sql, /THEN point\.name END/)
  t.regex(indexed.sql, /GROUP BY 1, 2, 3, 4, 5, 6/)
  t.true(indexed.values.includes('index'))
  t.true(indexed.values.includes('relevé d\'index'))
  t.false(indexed.values.includes('volume'))
})

test('les helpers SQL conservent les index par exploitation par défaut pour leurs consommateurs internes', async t => {
  const options = {pointIds: [POINT_ID]}
  const expected = buildAggregationOptionGroupsQuery({...options, includeExploitationIndexes: true})
  const direct = buildAggregationOptionGroupsQuery(options)
  let receivedQuery
  await listAggregationOptionGroups({
    ...options,
    client: {async $queryRaw(query) {
      receivedQuery = query
      return []
    }}
  })

  t.is(direct.sql, expected.sql)
  t.deepEqual(direct.values, expected.values)
  t.is(receivedQuery.sql, expected.sql)
  t.deepEqual(receivedQuery.values, expected.values)
})
