import test from 'ava'

import {
  buildPeriodEndRangeFilter,
  buildPeriodOverlapFilter,
  decodeSeriesId,
  encodeSeriesId
} from '../series.js'

const CHUNK_ID = '77777777-7777-4777-8777-777777777777'

test('encodeSeriesId et decodeSeriesId conservent chunk et métrique', t => {
  const encoded = encodeSeriesId({
    chunkId: CHUNK_ID,
    metricTypeCode: 'VOLUME_PRELEVE'
  })

  t.is(encoded, `${CHUNK_ID}:VOLUME_PRELEVE`)
  t.deepEqual(decodeSeriesId(encoded), {
    chunkId: CHUNK_ID,
    metricTypeCode: 'VOLUME_PRELEVE'
  })
})

test('decodeSeriesId accepte les codes métriques contenant des deux-points', t => {
  t.deepEqual(decodeSeriesId(`${CHUNK_ID}:CUSTOM:METRIC`), {
    chunkId: CHUNK_ID,
    metricTypeCode: 'CUSTOM:METRIC'
  })
})

test('decodeSeriesId retourne null pour les identifiants incomplets', t => {
  t.is(decodeSeriesId(null), null)
  t.is(decodeSeriesId(''), null)
  t.is(decodeSeriesId('missing-separator'), null)
  t.is(decodeSeriesId(`${CHUNK_ID}:`), null)
  t.is(decodeSeriesId(':VOLUME_PRELEVE'), null)
})

test('buildPeriodEndRangeFilter inclut toute la date de fin', t => {
  const filter = buildPeriodEndRangeFilter({
    startDate: '2026-07-02',
    endDate: '2026-07-02'
  })

  t.deepEqual({
    gte: filter.gte.toISOString(),
    lt: filter.lt.toISOString()
  }, {
    gte: '2026-07-02T00:00:00.000Z',
    lt: '2026-07-03T00:00:00.000Z'
  })
})

test('buildPeriodOverlapFilter conserve toute période chevauchant la fenêtre', t => {
  const filters = buildPeriodOverlapFilter({
    startDate: '2026-07-02',
    endDate: '2026-07-04'
  })

  t.deepEqual(filters.map(filter => {
    if (filter.periodEnd) {
      return {periodEnd: {gt: filter.periodEnd.gt.toISOString()}}
    }

    return {periodStart: {lt: filter.periodStart.lt.toISOString()}}
  }), [
    {periodEnd: {gt: '2026-07-02T00:00:00.000Z'}},
    {periodStart: {lt: '2026-07-05T00:00:00.000Z'}}
  ])
})
