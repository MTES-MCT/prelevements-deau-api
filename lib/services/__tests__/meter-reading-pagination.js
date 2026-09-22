import test from 'ava'
import {meterReadingIntervals} from '../meter-publication.js'

test('historical meter pagination preserves every predecessor including invalid observations', async t => {
  const readings = Array.from({length: 20_005}, (_, index) => ({
    id: String(index), observedAt: new Date(index * 1000),
    currentRevision: {admissible: index !== 999, index}
  }))
  let requests = 0
  const client = {meterReading: {async findMany({cursor, skip = 0, take, where}) {
    t.deepEqual(where, {compteurId: 'meter'})
    requests++
    const start = cursor ? Number(cursor.id) + skip : 0
    return readings.slice(start, start + take)
  }}}
  let count = 0
  let invalidBoundary = 0
  for await (const [start, end] of meterReadingIntervals(client, 'meter')) {
    t.is(Number(end.id), Number(start.id) + 1)
    if (!start.currentRevision.admissible || !end.currentRevision.admissible) invalidBoundary++
    count++
  }
  t.is(count, 20_004)
  t.is(invalidBoundary, 2)
  t.is(requests, 21)
})

test('empty meter history emits no interval', async t => {
  const intervals = []
  for await (const interval of meterReadingIntervals({meterReading: {findMany: async () => []}}, 'meter')) intervals.push(interval)
  t.deepEqual(intervals, [])
})
