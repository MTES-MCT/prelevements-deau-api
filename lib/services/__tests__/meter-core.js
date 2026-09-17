import test from 'ava'
import {
  parseMeterInstant, normalizeMeterReading, validateAllocationSnapshot, apportionMeterVolume,
  decimalString, scaledDecimal, shouldPromoteMeterRevision, planMeterInterval
} from '../meter-core.js'
import {authorizedMeterStreamsWhere} from '../meter-ingestion.js'
import {meterIngestionSchema} from '../../validation/meters.js'

const snapshot = [
  {key: 'a', percentage: '40', inScope: true},
  {key: 'b', percentage: '30', inScope: true},
  {key: 'external', percentage: '30', inScope: false}
]
const stream = {id: 'stream', enabled: true, activatedAt: new Date('2026-01-01Z'), allocationSnapshot: snapshot, allocationSnapshotValidated: true}
const exploitation = {id: 'exploitation', status: 'EN_ACTIVITE'}
const allocations = snapshot.filter(entry => entry.inScope).map(entry => ({
  sourceId: entry.key, exploitation,
  versions: [{id: entry.key, enabled: true, percentage: entry.percentage, startDate: new Date('2026-01-01Z')}]
}))
function reading(date, index, admissible = true) {
  return {observedAt: new Date(date), currentRevision: {index, admissible, streamId: stream.id, mode: 'LIVE'}}
}

test('normalized instants require explicit offsets and exact calendars, preserving milliseconds', t => {
  t.is(parseMeterInstant('2026-07-02T13:01:02.123+02:00').toISOString(), '2026-07-02T11:01:02.123Z')
  t.is(parseMeterInstant('2026-01-02T13:01:02Z').toISOString(), '2026-01-02T13:01:02.000Z')
  t.is(parseMeterInstant('2026-10-25T02:30:00'), null)
  t.is(parseMeterInstant('2026-02-30T10:00:00Z'), null)
  t.is(parseMeterInstant('2026-07-02T24:00:00Z'), null)
  t.is(parseMeterInstant('2026-07-02T13:01:02+24:00'), null)
})

test('quality and reason are opaque; normalized status alone determines admissibility', t => {
  const window = {windowStart: '2026-07-01Z', windowEnd: '2026-07-03Z'}
  const row = {externalId: 'ABC', observedAt: '2026-07-02T13:01:02Z', index: '100.1234', status: 'VALID', quality: 'anything'}
  t.is(normalizeMeterReading(row, window).index, '100.1234')
  t.true(normalizeMeterReading({...row, quality: 'PROVIDER_CUSTOM_CODE'}, window).admissible)
  const invalid = normalizeMeterReading({...row, status: 'INVALID', quality: 'OTHER_CODE', reason: 'producer_decision'}, window)
  t.false(invalid.admissible)
  t.is(invalid.reason, 'producer_decision')
  t.is(invalid.quality, 'OTHER_CODE')
  t.is(normalizeMeterReading({...row, observedAt: null, status: 'INVALID'}, window).reason, 'UNLOCATED_READING')
})

test('allocation validates full 100 including out-of-scope shares and conserves four decimals', t => {
  const valid = validateAllocationSnapshot(snapshot, true)
  const shares = apportionMeterVolume('0.0001', valid)
  t.is(shares.reduce((sum, share) => sum + share.volume, 0n), 1n)
  t.is(shares.find(share => share.key === 'a').volume, 1n)
  t.throws(() => validateAllocationSnapshot(snapshot, false))
  t.throws(() => validateAllocationSnapshot(snapshot.slice(0, 2), true))
  t.throws(() => validateAllocationSnapshot([...snapshot, snapshot[0]], true))
  t.is(decimalString(scaledDecimal('12345678912345.1234')), '12345678912345.1234')
})

test('contracts to one exploitation group after physical allocation', t => {
  const result = planMeterInterval(reading('2026-07-01Z', '100'), reading('2026-07-02Z', '110'), stream, allocations)
  t.is(result.groups.length, 1)
  t.is(result.groups[0].shares.length, 2)
  t.is(decimalString(result.groups[0].volume), '7.0000')
  t.is(decimalString(result.outOfScopeVolume), '3.0000')
  t.is(result.physicalVolume, result.inScopeVolume + result.outOfScopeVolume)
})

test('a decrease, invalid middle reading, unknown activation or cutoff blocks intervals', t => {
  const start = reading('2026-07-01Z', '100')
  const end = reading('2026-07-02Z', '99')
  t.is(planMeterInterval(start, end, stream, allocations).reason, 'INDEX_DECREASE')
  t.is(planMeterInterval(start, reading('2026-07-02Z', '101', false), stream, allocations).reason, 'BLOCKED_READING')
  t.is(planMeterInterval(start, reading('2026-07-02Z', '101'), {...stream, activatedAt: null}, allocations).reason, 'NOT_ACTIVATED')
  const closing = allocations.map(allocation => ({...allocation, versions: allocation.versions.map(version => ({...version, endDate: new Date('2026-07-01T12:00Z')}))}))
  t.is(planMeterInterval(start, reading('2026-07-02Z', '101'), stream, closing).reason, 'ALLOCATION_PERIOD_UNRESOLVED')
})

test('historical snapshot versions remain valid after current snapshot changes', t => {
  const versioned = allocations.map(allocation => ({...allocation, versions: allocation.versions.map(version => ({...version, metadata: {allocationSnapshot: snapshot, allocationSnapshotValidated: true}}))}))
  const result = planMeterInterval(reading('2026-07-01Z', '100'), reading('2026-07-02Z', '110'), {...stream, allocationSnapshot: []}, versioned)
  t.is(decimalString(result.inScopeVolume), '7.0000')
})

test('unlocatable LIVE row blocks its window but OFFLINE does not hide LIVE readings', t => {
  const blockedWindows = [{windowStart: '2026-07-01Z', windowEnd: '2026-07-03Z', mode: 'LIVE'}]
  const start = reading('2026-07-01Z', '100')
  const end = reading('2026-07-02Z', '110')
  t.is(planMeterInterval(start, end, {...stream, blockedWindows}, allocations).reason, 'UNLOCATED_READING_IN_WINDOW')
  blockedWindows[0].mode = 'OFFLINE'
  t.falsy(planMeterInterval(start, end, {...stream, blockedWindows}, allocations).reason)
})

test('LIVE cannot be overwritten by OFFLINE or a delayed fetch; identical fresh fetch advances the clock', t => {
  const existing = {currentRevisionId: 'r', currentMode: 'LIVE', lastFetchedAt: new Date('2026-07-02Z')}
  t.false(shouldPromoteMeterRevision(existing, 'OFFLINE', '2026-07-03Z'))
  t.false(shouldPromoteMeterRevision(existing, 'LIVE', '2026-07-01Z'))
  t.true(shouldPromoteMeterRevision(existing, 'LIVE', '2026-07-03Z'))
  t.true(shouldPromoteMeterRevision({...existing, currentMode: 'OFFLINE'}, 'LIVE', '2026-07-01Z'))
})

test('service accounts require explicit enabled stream bindings; OFFLINE is admin-only', t => {
  const namespace = {provider: 'sample-provider', scope: 'sample-scope'}
  t.deepEqual(authorizedMeterStreamsWhere({...namespace, serviceAccountId: 'sa'}), {...namespace, serviceAccountId: 'sa', enabled: true})
  t.is(t.throws(() => authorizedMeterStreamsWhere({...namespace, serviceAccountId: 'sa', mode: 'OFFLINE'})).status, 403)
  t.is(t.throws(() => authorizedMeterStreamsWhere({...namespace, user: {role: 'DECLARANT'}})).status, 403)
  t.false('serviceAccountId' in authorizedMeterStreamsWhere({...namespace, user: {role: 'ADMIN'}, mode: 'OFFLINE'}))
  t.is(t.throws(() => authorizedMeterStreamsWhere({serviceAccountId: 'sa'})).status, 400)
})

test('batch validation requires generic normalized envelopes, explicit namespaces and valid decimal strings', t => {
  const payload = {provider: 'sample-provider', scope: 'sample-scope', batchId: 'b', windowStart: '2026-07-01T00:00:00Z', windowEnd: '2026-07-16T00:00:00Z', fetchedAt: '2026-07-16T10:00:00Z', complete: true,
    readings: [{externalId: null, observedAt: null, index: null, status: 'INVALID', raw: 7}]}
  t.falsy(meterIngestionSchema.validate(payload).error)
  t.truthy(meterIngestionSchema.validate({...payload, complete: false}).error)
  t.truthy(meterIngestionSchema.validate({...payload, windowEnd: payload.windowStart}).error)
  t.truthy(meterIngestionSchema.validate({...payload, provider: undefined}).error)
  t.truthy(meterIngestionSchema.validate({...payload, readings: [{Date: '2026-07-02', Index: 100, NumeroSerieCompteur: 'ABC'}]}).error)
  for (const index of ['-1', '1,25', '1.12345', '1e3', '10000000000000000', 1]) {
    t.truthy(meterIngestionSchema.validate({...payload, readings: [{externalId: 'ABC', observedAt: '2026-07-02T00:00:00Z', index, status: 'VALID'}]}).error)
  }
  t.truthy(meterIngestionSchema.validate({...payload, readings: [{externalId: 'ABC', observedAt: '2026-07-02T00:00:00', index: '1', status: 'VALID'}]}).error)
  t.truthy(meterIngestionSchema.validate({...payload, readings: [{externalId: null, observedAt: null, index: null, status: 'VALID'}]}).error)
})
