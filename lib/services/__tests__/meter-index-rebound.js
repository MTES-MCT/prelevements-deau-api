import test from 'ava'
import {isUnresolvedMeterIndexRebound, meterReadingIntervals} from '../meter-publication.js'

const reading = (day, index, admissible = true) => ({
  id: String(day), observedAt: new Date(Date.UTC(2026, 6, day)),
  currentRevision: {index, admissible, streamId: 'synthetic-stream'}
})

test('a transient admissible index dip cannot create an artificial rebound volume', t => {
  t.true(isUnresolvedMeterIndexRebound(reading(1, '1000'), reading(2, '200'), reading(3, '1015')))
  t.true(isUnresolvedMeterIndexRebound(reading(1, '1000.0001'), reading(2, '1000.0000'), reading(3, '1000.0001')))
  t.false(isUnresolvedMeterIndexRebound(reading(1, '1000'), reading(2, '1000'), reading(3, '1015')))
})

test('a lasting reset and invalid observations keep their existing interval semantics', t => {
  t.false(isUnresolvedMeterIndexRebound(reading(1, '1000'), reading(2, '200'), reading(3, '215')))
  t.false(isUnresolvedMeterIndexRebound(undefined, reading(2, '200'), reading(3, '1015')))
  for (const invalid of [0, 1, 2]) {
    const rows = [reading(1, '1000'), reading(2, '200'), reading(3, '1015')]
    rows[invalid].currentRevision = {admissible: false, index: null}
    t.false(isUnresolvedMeterIndexRebound(...rows))
  }
})

test('provider switches do not inherit a prior provider index reference', t => {
  const rows = [reading(1, '1000'), reading(2, '200'), reading(3, '1015')]
  rows[0].currentRevision.streamId = 'another-provider-stream'
  t.false(isUnresolvedMeterIndexRebound(...rows))
  rows[0].currentRevision.streamId = rows[1].currentRevision.streamId
  rows[2].currentRevision.streamId = 'another-provider-stream'
  t.false(isUnresolvedMeterIndexRebound(...rows))
})

test('ordinary increasing indexes from any opaque provider remain publishable', t => {
  const rows = [reading(1, '365123'), reading(2, '365456'), reading(3, '366000')]
  for (const row of rows) row.currentRevision.streamId = 'synthetic-other-provider'
  t.false(isUnresolvedMeterIndexRebound(...rows))
})

function clientFor(readings) {
  const matching = query => {
    const bounds = query.where.observedAt ?? {}
    const rows = readings.filter(row => (!bounds.lt || row.observedAt < bounds.lt)
      && (!bounds.gt || row.observedAt > bounds.gt)
      && (!bounds.lte || row.observedAt <= bounds.lte)
      && (!bounds.gte || row.observedAt >= bounds.gte))
    return query.orderBy[0].observedAt === 'desc' ? rows.reverse() : rows
  }
  return {meterReading: {
    async findFirst(query) { return matching(query)[0] ?? null },
    async findMany(query) {
      const rows = matching(query)
      const offset = query.cursor ? rows.findIndex(row => row.id === query.cursor.id) + query.skip : 0
      return rows.slice(offset, offset + query.take)
    }
  }}
}

test('rebound context is preserved across cursor pages and bounded replay starts', async t => {
  const rows = [reading(1, '1000'), reading(2, '200'), reading(3, '1015'), reading(4, '1020')]
  for (const from of [undefined, rows[1].observedAt, rows[2].observedAt]) {
    for (const pageSize of [1, 2, 1000]) {
      const intervals = []
      // eslint-disable-next-line no-await-in-loop -- Independent bounded pagination cases use a pure synthetic client.
      for await (const [start, end, preceding] of meterReadingIntervals(clientFor(rows), 'meter', {from, pageSize, includeContext: true})) {
        if (isUnresolvedMeterIndexRebound(preceding, start, end)) intervals.push([start.id, end.id])
      }
      t.deepEqual(intervals, [['2', '3']])
    }
  }
})
