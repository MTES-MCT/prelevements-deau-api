import {NATIVE_CHUNK_WHERE, NON_NATIVE_CHUNK_WHERE} from '../../util/native-temporal.js'
import test from 'ava'

import {
  buildPeriodEndRangeFilter,
  buildPeriodOverlapFilter,
  decodeSeriesId,
  encodeSeriesId,
  getSeriesValuesInRange,
  getAggregationSeriesScope,
  listSeries
} from '../series.js'

const CHUNK_ID = '77777777-7777-4777-8777-777777777777'

test('la lecture native accepte exactement 50 000 valeurs, refuse au-delà et laisse le legacy inchangé', async t => {
  const value = {id: 'synthetic', periodStart: new Date('2026-01-01Z'), periodEnd: new Date('2026-01-01Z'),
    value: '1.123456789012345', chunk: {metadata: {nativeTemporal: true}}}
  let native = true
  let count = 50_000
  let valuesQuery
  const client = {
    chunk: {async findFirst(query) {
      t.deepEqual(query, {where: {id: CHUNK_ID, ...NATIVE_CHUNK_WHERE}, select: {id: true}})
      return native ? {id: CHUNK_ID} : null
    }},
    chunkValue: {async findMany(query) {
      valuesQuery = query
      return Array.from({length: count}, () => native ? value : {...value, chunk: {}})
    }}
  }
  const atLimit = await getSeriesValuesInRange(`${CHUNK_ID}:pH`, {}, client)
  t.is(valuesQuery.take, 50_001)
  t.is(atLimit.length, 50_000)
  t.is(atLimit.at(-1).values.value, value.value)
  count = 50_001
  const error = await t.throwsAsync(getSeriesValuesInRange(`${CHUNK_ID}:pH`, {}, client))
  t.is(error.status, 400)
  t.regex(error.message, /50 000.*lecture paginée/)
  t.is(valuesQuery.take, 50_001)
  native = false
  const legacy = await getSeriesValuesInRange(`${CHUNK_ID}:pH`, {}, client)
  t.false(Object.hasOwn(valuesQuery, 'take'))
  t.is(legacy.length, 50_001)
  t.is(typeof legacy[0].values.value, 'number')
})

test('les lectures METER conservent les intervalles exacts et le filtre legacy reste distinct', async t => {
  let query
  const periodStart = new Date('2026-07-01T22:11:43.000Z')
  const periodEnd = new Date('2026-07-03T22:11:41.000Z')
  const rows = await getSeriesValuesInRange(`${CHUNK_ID}:volume`, {
    startDate: '2026-07-02', endDate: '2026-07-02'
  }, {chunk: {async findFirst() { return null }}, chunkValue: {async findMany(options) {
    query = options
    return [{id: 'value', periodStart, periodEnd, value: '17.125', chunk: {calculationStrategy: 'METER', compteurId: 'meter'}}]
  }}})

  t.deepEqual(query.where.OR[0], {
    chunk: {calculationStrategy: 'METER'},
    frequency: 'irregular',
    periodEnd: {gt: new Date('2026-07-01T22:00:00Z')}, periodStart: {lt: new Date('2026-07-02T22:00:00Z')}
  })
  t.deepEqual(query.where.OR[1], {
    NOT: {frequency: 'irregular', chunk: {calculationStrategy: 'METER'}},
    chunk: NON_NATIVE_CHUNK_WHERE,
    periodEnd: {gte: new Date('2026-07-02'), lt: new Date('2026-07-03')}
  })
  t.is(query.where.chunk.source.status, 'COMPLETED')
  t.false(query.where.chunk.instructionStatus.in.includes('REJECTED'))
  t.is(rows[0].periodStart, periodStart)
  t.is(rows[0].periodEnd, periodEnd)
  t.is(rows[0].compteurId, 'meter')
  t.is(rows[0].values.value, 17.125)
})

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


test('la sélection agrégée partage les filtres de séries et ne charge aucun acteur', async t => {
  const groups = [
    {chunkId: CHUNK_ID, metricTypeCode: 'volume', unit: 'm³', frequency: '1 day'},
    {chunkId: CHUNK_ID, metricTypeCode: 'volume prélevé', unit: null, frequency: '1 month'},
    {chunkId: 'other-chunk', metricTypeCode: 'volume', unit: 'm³', frequency: '1 day'}
  ]
  const queries = []
  const options = {pointIds: ['point'], preleveurId: 'owner', collecteurId: 'collector',
    user: {id: 'owner', role: 'DECLARANT'}, parameter: 'volume', flowType: 'PRELEVEMENT',
    startDate: '2026-01-01', endDate: '2026-01-31', includeOverlappingPeriods: true}
  const client = {
    declarantPointPrelevement: {async findMany() {return [{pointPrelevementId: 'point'}]}},
    chunkValue: {async groupBy(query) {queries.push(query); return queries.length === 1 ? [] : groups}}
  }
  t.deepEqual(await listSeries(options, {client}), [])
  t.deepEqual(await getAggregationSeriesScope(options, {client}), {chunkIds: [CHUNK_ID, 'other-chunk'], seriesCount: 3})
  t.deepEqual(queries[0].where, queries[1].where)
  t.deepEqual(queries[0].by, queries[1].by)
  t.deepEqual(Object.keys(queries[1]).sort(), ['by', 'where'])
  t.deepEqual(await getAggregationSeriesScope({}, {client: {}}), {chunkIds: [], seriesCount: 0})
})
