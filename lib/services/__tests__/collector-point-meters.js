import test from 'ava'
import {collectorMeterCapabilities, saveCollectorExploitationMeters} from '../collector-point-meters.js'

const exploitation = {id: 'exploitation', pointPrelevementId: 'point', declarantUserId: 'owner'}
const makeMeter = extra => ({id: 'meter', serialNumber: '0012', updatedAt: new Date('2026-10-01'), deletedAt: null,
  meterAllocations: [{exploitationId: exploitation.id, provider: 'collector-form'}],
  meterStreams: [], externalReferences: [], chunks: [], ...extra})

test('a manual meter stays editable even when its manual campaign has a stream', t => {
  t.deepEqual(collectorMeterCapabilities(makeMeter({meterStreams: [{provider: 'manual-collection'}]}), exploitation),
    {canEditSerialNumber: true, reason: null})
})

test('historical sharing, supplier references and ambiguous legacy chunks are protected', t => {
  t.is(collectorMeterCapabilities(makeMeter({meterAllocations: [{exploitationId: 'other'}]}), exploitation).canEditSerialNumber, false)
  t.is(collectorMeterCapabilities(makeMeter({chunks: [{exploitationId: 'previous-owner'}]}), exploitation).reason, 'SHARED_METER')
  t.is(collectorMeterCapabilities(makeMeter({meterStreams: [{provider: 'willie'}]}), exploitation).reason, 'EXTERNAL_METER')
  t.is(collectorMeterCapabilities(makeMeter({externalReferences: [{id: 'reference'}]}), exploitation).reason, 'EXTERNAL_METER')
  t.is(collectorMeterCapabilities(makeMeter({chunks: [{exploitationId: exploitation.id, source: {apiImportId: 'legacy-import'}}]}), exploitation).reason, 'EXTERNAL_METER')
  t.is(collectorMeterCapabilities(makeMeter({chunks: [{exploitationId: null}]}), exploitation).reason, 'AMBIGUOUS_HISTORY')
  t.is(collectorMeterCapabilities(makeMeter({chunks: [{exploitationId: exploitation.id, preleveurUserId: 'other'}]}), exploitation).reason, 'AMBIGUOUS_HISTORY')
})

function client(record = makeMeter(), {collision = false} = {}) {
  const state = {record: structuredClone(record), writes: [], allocations: []}
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async () => collision ? [{id: 'private-meter'}] : [],
    compteur: {
      findUnique: async () => state.record,
      findUniqueOrThrow: async () => state.record,
      updateMany: async ({data}) => { state.writes.push(data); state.record = {...state.record, ...data}; return {count: 1} },
      create: async ({data}) => { state.writes.push(data); return {id: 'new-meter', ...data} }
    },
    meterAllocation: {create: async ({data}) => { state.allocations.push(data); return {id: 'allocation', ...data} }}
  }
  return {tx, state}
}

test('a new serial creates only its identity and an undated, disabled reference', async t => {
  const {tx, state} = client()
  const result = await saveCollectorExploitationMeters(tx, {exploitation, meters: [{serialNumber: ' 000123 '}], actorId: 'collector'})
  t.deepEqual(state.writes, [{serialNumber: '000123'}])
  t.deepEqual(state.allocations[0].versions, {create: {version: 1, enabled: false}})
  t.is(state.allocations[0].scope, exploitation.id)
  t.is(result.mutations.length, 2)
  t.true(result.mutations.every(mutation => mutation.scopes.some(scope => scope.resourceId === exploitation.id)))
})

test('correction and clearing keep the meter identity and allocations', async t => {
  const {tx, state} = client()
  const result = await saveCollectorExploitationMeters(tx, {exploitation, meters: [{id: 'meter', expectedUpdatedAt: '2026-10-01T00:00:00Z', serialNumber: null}]})
  t.is(state.record.id, 'meter')
  t.is(state.record.serialNumber, null)
  t.is(state.allocations.length, 0)
  t.is(result.mutations[0].before.serialNumber, '0012')
  t.is(result.mutations[0].operation, 'UPDATE')
})

test('stale versions, collisions and protected meters reject without any write', async t => {
  const cases = [
    {record: makeMeter(), options: {}, input: {expectedUpdatedAt: '2026-09-01'}, status: 409},
    {record: makeMeter(), options: {collision: true}, input: {}, status: 409},
    {record: makeMeter({externalReferences: [{id: 'private-reference'}]}), options: {}, input: {}, status: 403},
    {record: makeMeter({meterAllocations: [{exploitationId: 'private-exploitation'}]}), options: {}, input: {}, status: 403}
  ]
  for (const scenario of cases) {
    const {tx, state} = client(scenario.record, scenario.options)
    // eslint-disable-next-line no-await-in-loop
    const error = await t.throwsAsync(saveCollectorExploitationMeters(tx, {exploitation, meters: [{id: 'meter', serialNumber: 'NEW',
      expectedUpdatedAt: '2026-10-01T00:00:00Z', ...scenario.input}]}))
    t.is(error.status, scenario.status)
    t.deepEqual(state.writes, [])
    t.false(error.message.includes('private-'))
  }
})

test('blank new rows do not create meters and repeated normalized serials are refused', async t => {
  const {tx, state} = client()
  t.deepEqual(await saveCollectorExploitationMeters(tx, {exploitation, meters: [{serialNumber: ''}]}), {mutations: []})
  t.deepEqual(state.writes, [])
  const error = await t.throwsAsync(saveCollectorExploitationMeters(tx, {exploitation, meters: [{serialNumber: 'Ab'}, {serialNumber: ' ab '}]}))
  t.is(error.status, 400)
  t.deepEqual(state.writes, [])
})
