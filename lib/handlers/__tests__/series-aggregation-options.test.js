import test from 'ava'

import {
  buildAggregationOptionsPayload,
  validateOptionsQueryParams
} from '../series-aggregation-options.js'

const POINT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SOURCE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PRELEVEUR_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const COLLECTEUR_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

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
        _min: {periodEnd: new Date('2026-06-01T00:00:00.000Z')},
        _max: {periodEnd: new Date('2026-06-30T00:00:00.000Z')}
      },
      {
        metricTypeCode: 'volume prélevé',
        unit: 'm³',
        chunkId: 'chunk-2',
        _min: {periodEnd: new Date('2026-05-01T00:00:00.000Z')},
        _max: {periodEnd: new Date('2026-07-31T00:00:00.000Z')}
      },
      {
        metricTypeCode: 'UNKNOWN_METRIC',
        unit: 'u',
        chunkId: 'chunk-3',
        _min: {periodEnd: new Date('2026-01-01T00:00:00.000Z')},
        _max: {periodEnd: new Date('2026-01-02T00:00:00.000Z')}
      },
      {
        metricTypeCode: 'index',
        flowType: 'REJET',
        unit: 'm³',
        chunkId: 'chunk-4',
        _min: {periodEnd: new Date('2026-06-01T00:00:00.000Z')},
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
    hasTemporalOverlap: false
  })
  t.like(payload.parameters.find(parameter => parameter.id === 'index:REJET'), {
    id: 'index:REJET',
    name: 'index',
    label: 'Index de rejet',
    flowType: 'REJET'
  })
  t.deepEqual(payload.points, [
    {id: POINT_ID, name: 'Point A', flowType: null}
  ])
})
