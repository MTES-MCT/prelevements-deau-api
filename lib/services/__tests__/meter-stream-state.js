import test from 'ava'
import {finalizeMeterStreamsInTransaction} from '../meter-ingestion.js'

const windowEnd = new Date('2026-09-28T00:00:00Z')
const oldSuccess = new Date('2026-10-01T10:00:00Z')

function stream(id, data = {}) {
  return {id, compteurId: `meter-${id}`, blockedWindows: [], checkpoint: new Date('2026-10-01T00:00:00Z'),
    lastReadingAt: null, lastIssue: null, lastSuccessAt: oldSuccess, updatedAt: oldSuccess,
    provider: 'synthetic-provider', scope: 'synthetic-scope', enabled: true, ...data}
}

function state(value, changes = {}) {
  return {stream: value, blockedWindows: value.blockedWindows, issues: value.lastIssue ? [value.lastIssue] : [], ...changes}
}

function fakeTransaction(streams, readings, failUpdate) {
  const rows = structuredClone(streams)
  const calls = []
  let updates = 0
  const tx = {
    meterReading: {async groupBy(query) {
      calls.push({method: 'groupBy', query})
      const latest = new Map()
      for (const reading of readings) {
        if (!query.where.compteurId.in.includes(reading.compteurId)) continue
        const previous = latest.get(reading.compteurId)
        if (!previous || previous < reading.observedAt) latest.set(reading.compteurId, reading.observedAt)
      }
      return [...latest].map(([compteurId, observedAt]) => ({compteurId, _max: {observedAt}}))
    }},
    meterStream: {async updateMany(query) {
      calls.push({method: 'updateMany', query})
      updates++
      const matching = rows.filter(row => query.where.id.in.includes(row.id))
      if (updates === failUpdate) return {count: matching.length - 1}
      for (const row of matching) Object.assign(row, structuredClone(query.data))
      return {count: matching.length}
    }}
  }
  return {tx, calls, rows}
}

// Reference the previous per-stream algorithm, independently of the grouped
// patches: latest means every physical observation, regardless of its revision.
function legacyState(states, readings, completedAt) {
  return states.map(({stream: value, blockedWindows, issues}) => {
    const latest = readings.filter(reading => reading.compteurId === value.compteurId)
      .sort((a, b) => b.observedAt - a.observedAt)[0]
    return {...value, blockedWindows, lastSuccessAt: completedAt, updatedAt: completedAt,
      lastReadingAt: latest?.observedAt ?? null,
      checkpoint: value.checkpoint && value.checkpoint > windowEnd ? value.checkpoint : windowEnd,
      lastIssue: issues.join(',') || null}
  })
}

test('329 unchanged streams finalize in two calls despite distinct latest reading dates', async t => {
  const streams = Array.from({length: 329}, (_, index) => stream(String(index), {
    lastReadingAt: new Date(oldSuccess.getTime() + index * 1000)
  }))
  const readings = streams.map(value => ({compteurId: value.compteurId, observedAt: value.lastReadingAt}))
  const states = streams.map(value => state(value))
  const fixture = fakeTransaction(streams, readings)
  await finalizeMeterStreamsInTransaction(fixture.tx, states, windowEnd)
  t.deepEqual(fixture.calls.map(call => call.method), ['groupBy', 'updateMany'])
  t.deepEqual(fixture.calls[0].query, {
    by: ['compteurId'], where: {compteurId: {in: streams.map(value => value.compteurId)}}, _max: {observedAt: true}
  })
  const completedAt = fixture.calls[1].query.data.lastSuccessAt
  t.true(completedAt instanceof Date)
  t.true(completedAt > oldSuccess)
  t.deepEqual(fixture.rows, legacyState(states, readings, completedAt))
  t.deepEqual(streams.map(value => value.lastSuccessAt), Array.from({length: 329}, () => oldSuccess))
})

test('grouped finalization equals legacy states for invalid readings, shared meters, quarantine and monotone checkpoints', async t => {
  const quarantine = [{windowStart: '2026-09-13T00:00:00Z', windowEnd: windowEnd.toISOString(), mode: 'LIVE', fetchedAt: oldSuccess.toISOString()}]
  const selected = [
    stream('first', {checkpoint: null, blockedWindows: quarantine, lastIssue: 'OLD'}),
    stream('shared', {compteurId: 'meter-first', checkpoint: new Date('2026-09-15T00:00:00Z')}),
    stream('no-reading', {lastReadingAt: oldSuccess, lastIssue: 'UNCHANGED'}),
    stream('new-quarantine')
  ]
  const outside = stream('outside', {compteurId: 'meter-first'})
  const readings = [
    {compteurId: 'meter-first', observedAt: new Date('2026-09-20T00:00:00Z'), currentRevision: {admissible: true}},
    {compteurId: 'meter-first', observedAt: new Date('2026-10-02T00:00:00Z'), currentRevision: {admissible: false, mode: 'OFFLINE', streamId: 'outside'}},
    {compteurId: 'unselected-meter', observedAt: new Date('2026-12-01T00:00:00Z')}
  ]
  const states = [state(selected[0], {blockedWindows: [], issues: ['CONFLICT', 'INVALID']}),
    state(selected[1]), state(selected[2]), state(selected[3], {blockedWindows: quarantine, issues: ['UNLOCATED_READING']})]
  const original = structuredClone(states)
  const fixture = fakeTransaction([...selected, outside], readings)
  await finalizeMeterStreamsInTransaction(fixture.tx, states, windowEnd)
  t.deepEqual(fixture.rows.slice(0, selected.length), legacyState(states, readings, fixture.calls[1].query.data.lastSuccessAt))
  t.deepEqual(fixture.rows.at(-1), outside)
  t.deepEqual(states, original)
  t.deepEqual(fixture.calls[0].query.where.compteurId.in, ['meter-first', 'meter-no-reading', 'meter-new-quarantine'])
  t.true(fixture.calls.every(call => call.method !== 'updateMany' || !call.query.where.id.in.includes('outside')))
})

test('identical patches group together without rewriting distinct unchanged values or merging different dates', async t => {
  const selected = ['a', 'b', 'c', 'd'].map((id, index) => stream(id, {
    lastReadingAt: new Date(oldSuccess.getTime() + index * 1000)
  }))
  const readings = selected.map((value, index) => ({
    compteurId: value.compteurId, observedAt: new Date(value.lastReadingAt.getTime() + (index < 2 ? 0 : 10_000))
  }))
  const states = selected.map(value => state(value, {issues: ['NEW']}))
  const fixture = fakeTransaction(selected, readings)
  await finalizeMeterStreamsInTransaction(fixture.tx, states, windowEnd)
  const patches = fixture.calls.slice(2)
  t.is(patches.length, 3)
  t.deepEqual(patches[0].query.where.id.in, ['a', 'b'])
  t.deepEqual(Object.keys(patches[0].query.data).sort(), ['lastIssue', 'updatedAt'])
  t.notDeepEqual(patches[1].query.data.lastReadingAt, patches[2].query.data.lastReadingAt)
  t.deepEqual(fixture.rows, legacyState(states, readings, fixture.calls[1].query.data.lastSuccessAt))
  t.true(patches.every(call => call.query.data.updatedAt.getTime() === fixture.calls[1].query.data.updatedAt.getTime()))
})

test('an empty authorized scope performs no reads or writes', async t => {
  const fixture = fakeTransaction([], [])
  await finalizeMeterStreamsInTransaction(fixture.tx, [], windowEnd)
  t.deepEqual(fixture.calls, [])
})

for (const failure of [1, 2]) {
  test(`a missing stream during grouped update ${failure} aborts the enclosing transaction`, async t => {
    const selected = stream('selected', {checkpoint: null})
    const fixture = fakeTransaction([selected], [], failure)
    const error = await t.throwsAsync(finalizeMeterStreamsInTransaction(fixture.tx, [state(selected)], windowEnd))
    t.is(error.status, 409)
    t.is(fixture.calls.filter(call => call.method === 'updateMany').length, failure)
  })
}
