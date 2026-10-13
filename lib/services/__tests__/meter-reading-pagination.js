import test from 'ava'
import {Prisma} from '@prisma/client'
import {lockMeters, lockMeterPublicationPoints, meterReadingIntervals} from '../meter-publication.js'

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

function readingClient(readings) {
  const calls = []
  const matching = query => {
    const dates = query.where.observedAt ?? {}
    const filtered = readings.filter(reading => (
      (!dates.lt || reading.observedAt < dates.lt)
      && (!dates.lte || reading.observedAt <= dates.lte)
      && (!dates.gt || reading.observedAt > dates.gt)
      && (!dates.gte || reading.observedAt >= dates.gte)
    ))
    return query.orderBy[0].observedAt === 'desc' ? filtered.reverse() : filtered
  }
  return {calls, meterReading: {
    async findFirst(query) {
      const result = matching(query)[0] ?? null
      calls.push({method: 'findFirst', query, returned: result ? 1 : 0})
      return result
    },
    async findMany(query) {
      const filtered = matching(query)
      const start = query.cursor ? filtered.findIndex(reading => reading.id === query.cursor.id) + query.skip : 0
      const result = filtered.slice(start, start + query.take)
      calls.push({method: 'findMany', query, returned: result.length})
      return result
    }
  }}
}

async function readIntervals(client, options) {
  const intervals = []
  for await (const pair of meterReadingIntervals(client, 'meter', options)) intervals.push(pair)
  return intervals
}

const boundaryCases = [
  {name: 'exact endpoints including an invalid predecessor', from: 4, to: 8},
  {name: 'bounds between readings', from: 3.5, to: 8.5},
  {name: 'single exact instant', from: 4, to: 4},
  {name: 'whole history', from: 0, to: 12},
  {name: 'entirely before history', from: -2, to: -1},
  {name: 'entirely after history', from: 13, to: 15},
  {name: 'missing predecessor', from: -2, to: 4},
  {name: 'missing successor', from: 9, to: 15},
  {name: 'lower bound only', from: 9},
  {name: 'upper bound only', to: 4},
  {name: 'interval spanning a window with no inner reading', from: 4, to: 7, times: [1, 9]},
  {name: 'empty bounded history', from: 4, to: 7, times: []}
]

for (const boundaryCase of boundaryCases) {
  test(`bounded meter pagination equals the complete-history filter: ${boundaryCase.name}`, async t => {
    const times = boundaryCase.times ?? Array.from({length: 13}, (_, index) => index)
    const readings = times.map(index => ({
      id: String(index), observedAt: new Date(index * 1000),
      currentRevision: {admissible: ![3, 9].includes(index), index}
    }))
    const from = boundaryCase.from === undefined ? undefined : new Date(boundaryCase.from * 1000)
    const to = boundaryCase.to === undefined ? undefined : new Date(boundaryCase.to * 1000)
    const complete = await readIntervals(readingClient(readings))
    const expected = complete.filter(([start, end]) => (!from || end.observedAt >= from) && (!to || start.observedAt <= to))
    for (const pageSize of [1, 2, 4, 1000]) {
      // eslint-disable-next-line no-await-in-loop -- Exercise independent pagination sizes against the same complete-history oracle.
      const bounded = await readIntervals(readingClient(readings), {from, to, pageSize})
      t.deepEqual(bounded, expected)
      // The stricter historical replay still selects exactly the same fully contained intervals.
      const contained = pairs => pairs.filter(([start, end]) => (!from || start.observedAt >= from) && (!to || end.observedAt <= to))
      t.deepEqual(contained(bounded), contained(expected))
    }
  })
}

test('a narrow historical window reads only its range and immediate neighbors, retaining invalid rows', async t => {
  const readings = Array.from({length: 20_005}, (_, index) => ({
    id: String(index), observedAt: new Date(index * 1000),
    currentRevision: {admissible: ![9999, 10004].includes(index), index}
  }))
  const client = readingClient(readings)
  const from = new Date(10_000_000)
  const to = new Date(10_003_000)
  const intervals = await readIntervals(client, {from, to, pageSize: 2})
  t.deepEqual(intervals.map(([start, end]) => [start.id, end.id]), [
    ['9999', '10000'], ['10000', '10001'], ['10001', '10002'], ['10002', '10003'], ['10003', '10004']
  ])
  t.false(intervals[0][0].currentRevision.admissible)
  t.false(intervals.at(-1)[1].currentRevision.admissible)
  const pageCalls = client.calls.filter(call => call.method === 'findMany')
  t.true(pageCalls.every(call => call.query.where.compteurId === 'meter'
    && call.query.where.observedAt.gte.getTime() === from.getTime()
    && call.query.where.observedAt.lte.getTime() === 10_004_000))
  t.is(pageCalls.reduce((sum, call) => sum + call.returned, 0), 5)
  t.is(client.calls.filter(call => call.method === 'findFirst').length, 2)
  t.is(client.calls.length, 5)
})

test('meter locks use one ordered statement with the legacy namespace and unique keys', async t => {
  const statements = []
  const tx = {$executeRaw: async (strings, ...values) => statements.push(Prisma.sql(strings, ...values))}
  await lockMeters(tx, ['meter-b', 'meter-a', 'meter-b'])
  t.is(statements.length, 1)
  t.deepEqual(statements[0].values, ['physical-meter', 'meter-a', 'meter-b'])
  t.regex(statements[0].text, /pg_advisory_xact_lock\(hashtext\(/)
  t.regex(statements[0].text, /WITH ORDINALITY/)
  t.regex(statements[0].text, /ORDER BY ordinal OFFSET 0/)
  await lockMeters(tx, [])
  t.is(statements.length, 1)
})

test('point locks preserve unique sorted point keys in one statement and skip empty scopes', async t => {
  const statements = []
  let allocations = ['point-c', 'point-a', 'point-c', 'point-b'].map(pointPrelevementId => ({exploitation: {pointPrelevementId}}))
  const tx = {
    meterAllocation: {async findMany(query) {
      t.deepEqual(query.where, {compteurId: {in: ['meter-a', 'meter-b']}})
      return allocations
    }},
    $executeRaw: async (strings, ...values) => statements.push(Prisma.sql(strings, ...values))
  }
  await lockMeterPublicationPoints(tx, ['meter-a', 'meter-b'])
  t.is(statements.length, 1)
  t.deepEqual(statements[0].values, ['volumes-from-index', 'point-a', 'point-b', 'point-c'])
  allocations = []
  await lockMeterPublicationPoints(tx, ['meter-a', 'meter-b'])
  t.is(statements.length, 1)
})
