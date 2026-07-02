import test from 'ava'

import {
  aggregateDailyValuesToPeriod,
  aggregateSpatialValues,
  applyAggregationOperator,
  extractPeriod,
  extractValuesFromDocument,
  filterPointsByIds,
  validateQueryParams
} from '../series-aggregation.js'

const POINT_ID_1 = '88888888-8888-4888-8888-888888888888'
const POINT_ID_2 = '99999999-9999-4999-8999-999999999999'
const POINT_ID_3 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DECLARANT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const COLLECTEUR_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

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
    metricTypeCode: 'volume prélevé',
    aggregationFrequency: '1 month',
    spatialOperator: 'sum',
    temporalOperator: 'mean',
    startDate: '2026-01-01',
    endDate: '2026-01-31'
  })
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
