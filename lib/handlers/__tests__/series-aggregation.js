import test from 'ava'

import {
  aggregateDailyValuesToPeriod,
  aggregateSpatialValues,
  applyAggregationOperator,
  buildAggregationMetadata,
  distributeCumulativeValueByDay,
  extractPeriod,
  extractValuesFromDocument,
  filterPointsByIds,
  getExactMeterPeriods,
  hasExactMeterPeriods,
  resolvePointsForAggregation,
  scopeResolvedPointsForAggregation,
  validateQueryParams
} from '../series-aggregation.js'
import {parametersConfig} from '../../parameters-config.js'

const POINT_ID_1 = '88888888-8888-4888-8888-888888888888'
const POINT_ID_2 = '99999999-9999-4999-8999-999999999999'
const POINT_ID_3 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DECLARANT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const COLLECTEUR_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

test('physical meter series require explicit raw parameters without changing ordinary queries', t => {
  const base = {pointIds: POINT_ID_1, metricTypeCode: 'index'}
  t.is(validateQueryParams(base).aggregationFrequency, '1 day')
  const value = validateQueryParams({...base, meterId: POINT_ID_2, limit: '2'})
  t.is(value.temporalOperator, 'raw')
  t.is(value.aggregationFrequency, 'instantaneous')
  t.is(value.limit, 2)
  for (const invalid of [
    {cursor: POINT_ID_2}, {limit: 2}, {temporalOperator: 'raw'}, {aggregationFrequency: 'instantaneous'},
    {meterId: 'invalid'}, {meterId: POINT_ID_2, metricTypeCode: 'volume'},
    {meterId: POINT_ID_2, sourceId: POINT_ID_3}, {meterId: POINT_ID_2, spatialOperator: 'sum'},
    {meterId: POINT_ID_2, temporalOperator: 'max'}, {meterId: POINT_ID_2, aggregationFrequency: '1 day'},
    {meterId: POINT_ID_2, cursor: 'invalid'}, {meterId: POINT_ID_2, limit: 5001}, {meterId: POINT_ID_2, limit: 0}
  ]) {
    t.is(t.throws(() => validateQueryParams({...base, ...invalid})).status, 400)
  }
})

test('périodes de compteur exactes accompagnent la projection avec un avertissement explicite', async t => {
  let query
  const exact = await getExactMeterPeriods({
    chunkIds: ['authorized-chunk'], metricTypeCode: 'volume', startDate: new Date('2026-01-01'), endDate: new Date('2026-01-31'),
    client: {chunkValue: {async findMany(options) {
      query = options
      return [{id: 'value', periodStart: new Date('2025-11-01T00:11:43Z'), periodEnd: new Date('2026-06-01T00:11:42Z'), value: 100, unit: 'm³', chunk: {pointPrelevementId: POINT_ID_1, compteurId: 'meter'}}]
    }}}
  })
  t.deepEqual(query.where.chunkId.in, ['authorized-chunk'])
  t.is(query.where.chunk.calculationStrategy, 'METER')
  t.is(exact[0].value, '100')
  t.is(exact[0].periodStart.toISOString(), '2025-11-01T00:11:43.000Z')
  t.is(exact[0].periodEnd.toISOString(), '2026-06-01T00:11:42.000Z')
  t.is(exact[0].compteurId, 'meter')
  const metadata = buildAggregationMetadata({metricTypeCode: 'volume', aggregationFrequency: '1 day', resolvedPoints: [], exactVolumesEstimated: true})
  t.true(metadata.exactVolumesEstimated)
  t.true(metadata.distribution.applied)
})

for (const {name, startDate, endDate, expectedStart, expectedEnd} of [
  {
    name: 'dates HTTP de la période demandée',
    startDate: '2023-01-01',
    endDate: '2026-09-07',
    expectedStart: '2022-12-31T23:00:00.000Z',
    expectedEnd: '2026-09-07T22:00:00.000Z'
  },
  {
    name: 'passage à l’heure d’été',
    startDate: '2026-03-29',
    endDate: '2026-03-29',
    expectedStart: '2026-03-28T23:00:00.000Z',
    expectedEnd: '2026-03-29T22:00:00.000Z'
  },
  {
    name: 'passage à l’heure d’hiver',
    startDate: '2026-10-25',
    endDate: '2026-10-25',
    expectedStart: '2026-10-24T22:00:00.000Z',
    expectedEnd: '2026-10-25T23:00:00.000Z'
  },
  {
    name: 'jour bissextile',
    startDate: '2024-02-29',
    endDate: '2024-02-29',
    expectedStart: '2024-02-28T23:00:00.000Z',
    expectedEnd: '2024-02-29T23:00:00.000Z'
  },
  {
    name: 'objets Date existants sans mutation',
    startDate: new Date('2026-01-01T00:00:00.000Z'),
    endDate: new Date('2026-01-31T00:00:00.000Z'),
    expectedStart: '2025-12-31T23:00:00.000Z',
    expectedEnd: '2026-01-31T23:00:00.000Z'
  }
]) {
  test(`périodes de compteur exactes : instants UTC des jours Paris pour ${name}`, async t => {
    let query
    const originalStart = startDate instanceof Date ? startDate.getTime() : startDate
    const originalEnd = endDate instanceof Date ? endDate.getTime() : endDate

    const periods = await getExactMeterPeriods({
      chunkIds: ['authorized-chunk'],
      metricTypeCode: 'volume',
      startDate,
      endDate,
      client: {chunkValue: {async findMany(options) {
        query = options
        return []
      }}}
    })

    t.true(query.where.periodEnd.gt instanceof Date)
    t.true(query.where.periodStart.lt instanceof Date)
    t.is(query.where.periodEnd.gt.toISOString(), expectedStart)
    t.is(query.where.periodStart.lt.toISOString(), expectedEnd)
    t.deepEqual(query.where.chunkId.in, ['authorized-chunk'])
    t.is(query.where.valueKind, 'COMPUTED')
    t.is(query.where.chunk.calculationStrategy, 'METER')
    t.deepEqual(periods, [])
    t.is(startDate instanceof Date ? startDate.getTime() : startDate, originalStart)
    t.is(endDate instanceof Date ? endDate.getTime() : endDate, originalEnd)
  })
}

test('périodes de compteur exactes : les bornes absentes ne créent pas de filtre', async t => {
  let query
  await getExactMeterPeriods({
    chunkIds: ['authorized-chunk'],
    metricTypeCode: 'volume',
    client: {chunkValue: {async findMany(options) {
      query = options
      return []
    }}}
  })

  t.false(Object.hasOwn(query.where, 'periodEnd'))
  t.false(Object.hasOwn(query.where, 'periodStart'))
})

test('validateQueryParams accepte le contrat UUID actuel', t => {
  const result = validateQueryParams({
    pointIds: `${POINT_ID_1},${POINT_ID_2}`,
    preleveurId: DECLARANT_ID,
    collecteurId: COLLECTEUR_ID,
    metricTypeCode: 'volume prélevé',
    aggregationFrequency: '1 month',
    spatialOperator: 'sum',
    temporalOperator: 'mean',
    startDate: '2026-01-01',
    endDate: '2026-01-31',
    ignored: 'value'
  })

  t.deepEqual(result, {
    pointIds: `${POINT_ID_1},${POINT_ID_2}`,
    preleveurId: DECLARANT_ID,
    collecteurId: COLLECTEUR_ID,
    metricTypeCode: 'volume',
    pointFlowType: 'PRELEVEMENT',
    aggregationFrequency: '1 month',
    spatialOperator: 'sum',
    temporalOperator: 'mean',
    startDate: '2026-01-01',
    endDate: '2026-01-31'
  })
})

test('validateQueryParams accepte une résolution hebdomadaire pour les cumuls', t => {
  const result = validateQueryParams({
    pointIds: POINT_ID_1,
    metricTypeCode: 'volume',
    aggregationFrequency: '1 week'
  })

  t.is(result.aggregationFrequency, '1 week')
  t.true(parametersConfig.volume.availableFrequencies.includes('1 week'))
})

test('validateQueryParams rejette les anciens identifiants numériques ou ObjectId', t => {
  const numericError = t.throws(() => validateQueryParams({
    pointIds: '1,2,3',
    metricTypeCode: 'volume prélevé'
  }))

  const objectIdError = t.throws(() => validateQueryParams({
    preleveurId: '507f1f77bcf86cd799439011',
    metricTypeCode: 'volume prélevé'
  }))

  t.regex(numericError.message, /UUID v4/)
  t.regex(objectIdError.message, /valid GUID/)
})

test('validateQueryParams exige un scope et un metricTypeCode', t => {
  const error = t.throws(() => validateQueryParams({}))

  t.regex(error.message, /metricTypeCode/)
  t.regex(error.message, /pointIds, preleveurId, collecteurId ou sourceId/)
})

test('filterPointsByIds filtre les points par UUID', t => {
  const availablePoints = [
    {id: POINT_ID_1, point: {name: 'Point A'}},
    {id: POINT_ID_2, point: {name: 'Point B'}},
    {id: POINT_ID_3, point: {name: 'Point C'}}
  ]

  const result = filterPointsByIds(availablePoints, [POINT_ID_2, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'])

  t.deepEqual(result.found, [{id: POINT_ID_2, point: {name: 'Point B'}}])
  t.deepEqual(result.notFound, ['cccccccc-cccc-4ccc-8ccc-cccccccccccc'])
})

test('scopeResolvedPointsForAggregation filtre un scope collecteur dérivé au périmètre instructeur', async t => {
  const resolvedPoints = [
    {id: POINT_ID_1, point: {name: 'Point autorisé'}},
    {id: POINT_ID_2, point: {name: 'Point hors périmètre'}}
  ]
  const queries = []
  const client = {
    pointPrelevementZone: {
      async findMany(arguments_) {
        queries.push(arguments_)
        return [{pointPrelevementId: POINT_ID_1}]
      }
    }
  }

  const scopedPoints = await scopeResolvedPointsForAggregation({
    user: {id: 'instructor-1', role: 'INSTRUCTOR'},
    resolvedPoints,
    permittedZoneIds: ['zone-1'],
    collecteurId: COLLECTEUR_ID,
    client
  })

  t.deepEqual(scopedPoints, [resolvedPoints[0]])
  t.deepEqual(queries[0].where, {
    pointPrelevementId: {in: [POINT_ID_1, POINT_ID_2]},
    zoneId: {in: ['zone-1']}
  })
})

test('scopeResolvedPointsForAggregation retourne une liste vide quand aucun point dérivé n’est autorisé', async t => {
  const scopedPoints = await scopeResolvedPointsForAggregation({
    user: {id: 'instructor-1', role: 'INSTRUCTOR'},
    resolvedPoints: [{id: POINT_ID_1, point: {name: 'Point hors périmètre'}}],
    permittedZoneIds: ['zone-1'],
    preleveurId: DECLARANT_ID,
    client: {
      pointPrelevementZone: {
        async findMany() {
          return []
        }
      }
    }
  })

  t.deepEqual(scopedPoints, [])
})

test('scopeResolvedPointsForAggregation refuse toujours un point explicitement demandé hors périmètre', async t => {
  const error = await t.throwsAsync(() => scopeResolvedPointsForAggregation({
    user: {id: 'instructor-1', role: 'INSTRUCTOR'},
    resolvedPoints: [
      {id: POINT_ID_1, point: {name: 'Point autorisé'}},
      {id: POINT_ID_2, point: {name: 'Point hors périmètre'}}
    ],
    permittedZoneIds: ['zone-1'],
    pointIdsStr: `${POINT_ID_1},${POINT_ID_2}`,
    collecteurId: COLLECTEUR_ID,
    client: {
      pointPrelevementZone: {
        async findMany() {
          return [{pointPrelevementId: POINT_ID_1}]
        }
      }
    }
  }))

  t.is(error.status, 403)
  t.regex(error.message, /périmètre de consultation/)
})

test('applyAggregationOperator agrège valeurs et remarques', t => {
  const result = applyAggregationOperator([
    {value: 10, remark: 'Estimation'},
    {value: 20, remarks: ['Valeur partielle', 'Estimation']},
    Number.NaN,
    {value: 30}
  ], 'sum')

  t.deepEqual(result, {
    value: 60,
    remarks: ['Estimation', 'Valeur partielle']
  })
})

test('aggregateSpatialValues utilise l’opérateur temporel quand l’agrégation spatiale est neutre', t => {
  const result = aggregateSpatialValues([
    {value: 10},
    {value: 20}
  ], '2026-06-01', null, 'mean')

  t.deepEqual(result, {
    date: '2026-06-01',
    value: 15
  })
})

test('aggregateSpatialValues garde la dernière saisie index pour un même point', t => {
  const result = aggregateSpatialValues([
    {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      pointId: POINT_ID_1,
      metricTypeCode: 'relevé d\'index',
      value: 20,
      createdAt: '2026-07-02T09:00:00.000Z'
    },
    {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      pointId: POINT_ID_1,
      metricTypeCode: 'relevé d\'index',
      value: 12,
      createdAt: '2026-07-02T10:00:00.000Z'
    }
  ], '2026-07-02', null, 'max')

  t.deepEqual(result, {
    date: '2026-07-02',
    value: 12
  })
})

test('aggregateSpatialValues dédoublonne les index par point avant agrégation', t => {
  const result = aggregateSpatialValues([
    {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      pointId: POINT_ID_1,
      metricTypeCode: 'relevé d\'index',
      value: 10,
      createdAt: '2026-07-02T09:00:00.000Z'
    },
    {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      pointId: POINT_ID_1,
      metricTypeCode: 'relevé d\'index',
      value: 35,
      createdAt: '2026-07-02T10:00:00.000Z'
    },
    {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      pointId: POINT_ID_2,
      metricTypeCode: 'relevé d\'index',
      value: 20,
      createdAt: '2026-07-02T09:00:00.000Z'
    },
    {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      pointId: POINT_ID_2,
      metricTypeCode: 'relevé d\'index',
      value: 45,
      createdAt: '2026-07-02T10:00:00.000Z'
    }
  ], '2026-07-02', null, 'mean')

  t.deepEqual(result, {
    date: '2026-07-02',
    value: 40
  })
})

test('extractValuesFromDocument ne lit que les valeurs journalières actuelles', t => {
  t.deepEqual(extractValuesFromDocument({
    date: '2026-06-01',
    values: {value: 12, remark: 'Contrôle'}
  }), [
    {period: '2026-06-01', value: 12, remark: 'Contrôle'}
  ])

  t.deepEqual(extractValuesFromDocument({
    date: '2026-06-01',
    values: {value: null}
  }), [])
})

test('aggregateDailyValuesToPeriod agrège par mois, semaine ISO et année', t => {
  const dailyValues = [
    {date: '2026-01-01', value: 10},
    {date: '2026-01-02', value: 20},
    {date: '2026-02-01', value: 5}
  ]

  t.deepEqual(aggregateDailyValuesToPeriod(dailyValues, '1 month', 'sum'), [
    {date: '2026-01', value: 30},
    {date: '2026-02', value: 5}
  ])
  t.deepEqual(aggregateDailyValuesToPeriod(dailyValues, '1 year', 'max'), [
    {date: '2026', value: 20}
  ])
  t.is(extractPeriod('2026-01-01', '1 week'), '2026-W01')
})

test('distributeCumulativeValueByDay répartit 45 000 m³ sur 45 jours', t => {
  const distributed = distributeCumulativeValueByDay({
    periodStart: '2026-01-01T00:00:00.000Z',
    periodEnd: '2026-02-15T00:00:00.000Z',
    value: 45_000
  })

  t.is(distributed.length, 45)
  t.true(distributed.every(item => item.value === 1000))
  t.is(distributed.reduce((sum, item) => sum + item.value, 0), 45_000)
})

test('distributeCumulativeValueByDay conserve le dénominateur sur une fenêtre partielle', t => {
  const distributed = distributeCumulativeValueByDay({
    periodStart: '2026-01-01T00:00:00.000Z',
    periodEnd: '2026-02-15T00:00:00.000Z',
    value: 45_000,
    startDate: '2026-01-11',
    endDate: '2026-01-20'
  })

  t.is(distributed.length, 10)
  t.is(distributed.reduce((sum, item) => sum + item.value, 0), 10_000)
})

test('distributeCumulativeValueByDay répartit les journées partielles au prorata exact', t => {
  const distributed = distributeCumulativeValueByDay({
    periodStart: '2026-01-30T12:00:00.000Z',
    periodEnd: '2026-02-01T12:00:00.000Z',
    value: 2400
  })

  t.deepEqual(distributed, [
    {date: '2026-01-30', value: 600},
    {date: '2026-01-31', value: 1200},
    {date: '2026-02-01', value: 600}
  ])
  t.deepEqual(aggregateDailyValuesToPeriod(distributed, '1 month', 'sum'), [
    {date: '2026-01', value: 1800},
    {date: '2026-02', value: 600}
  ])
})

test('buildAggregationMetadata expose une distribution stable sans modifier les instantanés', t => {
  const common = {
    pointFlowType: 'PRELEVEMENT',
    unit: 'm³',
    spatialOperator: 'sum',
    temporalOperator: 'sum',
    aggregationFrequency: '1 day',
    pointIdsStr: POINT_ID_1,
    resolvedPoints: [{id: POINT_ID_1, point: {name: 'Point A'}}],
    notFound: [],
    startDate: '2026-01-01',
    endDate: '2026-01-31'
  }
  const cumulative = buildAggregationMetadata({...common, metricTypeCode: 'volume'})
  const instantaneous = buildAggregationMetadata({
    ...common,
    metricTypeCode: 'index',
    spatialOperator: null,
    temporalOperator: 'max'
  })

  t.deepEqual(cumulative.distribution, {
    applied: true,
    method: 'uniform-over-period',
    purpose: 'display'
  })
  t.deepEqual(instantaneous.distribution, {
    applied: false,
    method: 'uniform-over-period',
    purpose: 'display'
  })
})


test('la projection graphique conserve les métadonnées métier sans les points détaillés', t => {
  const options = {metricTypeCode: 'volume', aggregationFrequency: '1 month',
    resolvedPoints: [{id: POINT_ID_1, point: {name: 'Point'}}], exactVolumesEstimated: true}
  const detailed = buildAggregationMetadata(options)
  const chart = buildAggregationMetadata({...options, view: 'chart'})
  const {points, ...expected} = detailed
  t.is(points.length, 1)
  t.deepEqual(chart, expected)
  t.is(validateQueryParams({pointIds: POINT_ID_1, metricTypeCode: 'volume', view: 'chart'}).view, 'chart')
  t.is(t.throws(() => validateQueryParams({pointIds: POINT_ID_1, metricTypeCode: 'volume', view: 'invalid'})).status, 400)
})

test('le témoin METER graphique utilise le même périmètre que les périodes détaillées', async t => {
  const options = {chunkIds: ['chunk'], metricTypeCode: 'volume', startDate: '2026-03-29', endDate: '2026-03-29',
    user: {role: 'DECLARANT', id: DECLARANT_ID}, preleveurId: DECLARANT_ID, pointIds: [POINT_ID_1]}
  let detailedQuery
  let existsQuery
  const client = {chunkValue: {
    async findMany(query) {
      if (query.take === 1) {existsQuery = query; return [{id: 'value'}]}
      detailedQuery = query
      return []
    }
  }}
  await getExactMeterPeriods({...options, client})
  t.true(await hasExactMeterPeriods(options, {client}))
  t.deepEqual(existsQuery.where, detailedQuery.where)
  t.deepEqual(existsQuery.select, {id: true})
  t.is(existsQuery.take, 1)
  t.false(await hasExactMeterPeriods({...options, metricTypeCode: 'index'}, {client: {}}))
  t.false(await hasExactMeterPeriods({...options, chunkIds: []}, {client: {}}))
  t.false(await hasExactMeterPeriods(options, {client: {chunkValue: {async findMany() {return []}}}}))
})

test('le témoin METER borne ses requêtes et s’arrête dès la première période trouvée', async t => {
  const chunkIds = Array.from({length: 20003}, (_, index) => `chunk-${index}`)
  const batches = []
  const client = {chunkValue: {async findMany(query) {
    batches.push(query.where.chunkId.in)
    t.is(query.take, 1)
    t.deepEqual(query.select, {id: true})
    return query.where.chunkId.in.includes('chunk-10001') ? [{id: 'value'}] : []
  }}}
  t.true(await hasExactMeterPeriods({chunkIds, metricTypeCode: 'volume'}, {client}))
  t.deepEqual(batches.map(batch => batch.length), [10000, 10000])
  t.deepEqual(batches.flat(), chunkIds.slice(0, 20000))
})

test('les points explicites sont résolus en lot en conservant ordre, doublons et absences', async t => {
  const queries = []
  const point = {id: POINT_ID_1, name: 'Point supprimé', flowType: 'PRELEVEMENT'}
  const result = await resolvePointsForAggregation({pointIdsStr: `${POINT_ID_1},${POINT_ID_2},${POINT_ID_1}`}, {
    client: {pointPrelevement: {async findMany(query) {queries.push(query); return [point]}}}
  })
  t.is(queries.length, 1)
  t.deepEqual(queries[0], {where: {id: {in: [POINT_ID_1, POINT_ID_2]}}, select: {id: true, name: true, flowType: true}})
  t.deepEqual(result.resolvedPoints, [{id: POINT_ID_1, point}, {id: POINT_ID_1, point}])
  t.deepEqual(result.notFound, [POINT_ID_2])
})

test('le périmètre préleveur garde les exploitations historiques et exclut les points supprimés', async t => {
  let pointQuery
  let declarantQuery
  const client = {
    user: {async findFirst(query) {declarantQuery = query; return {id: DECLARANT_ID}}},
    pointPrelevement: {async findMany(query) {pointQuery = query; return []}}
  }
  const result = await resolvePointsForAggregation({preleveurId: DECLARANT_ID}, {client})
  t.deepEqual(declarantQuery, {where: {id: DECLARANT_ID, role: 'DECLARANT', deletedAt: null}, select: {id: true}})
  t.deepEqual(pointQuery.where, {deletedAt: null, declarants: {some: {declarantUserId: DECLARANT_ID}}})
  t.deepEqual(result, {resolvedPoints: [], notFound: []})
  t.is((await t.throwsAsync(() => resolvePointsForAggregation({preleveurId: DECLARANT_ID}, {
    client: {user: {async findFirst() {return null}}}
  }))).status, 404)
})


test('la résolution en lot accepte les UUID explicites en majuscules comme findUnique', async t => {
  const point = {id: POINT_ID_3, name: 'Point', flowType: null}
  const result = await resolvePointsForAggregation({pointIdsStr: POINT_ID_3.toUpperCase()}, {
    client: {pointPrelevement: {async findMany() {return [point]}}}
  })
  t.deepEqual(result, {resolvedPoints: [{id: POINT_ID_3, point}], notFound: []})
})
