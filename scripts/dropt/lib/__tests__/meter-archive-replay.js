import test from 'ava'
import {createHash, randomUUID} from 'node:crypto'
import {digest} from '../epidropt.js'
import {prepareMeterArchiveReplay, replayPreparedMeterArchives} from '../meter-archive-replay.js'

const sha = value => createHash('sha256').update(value).digest('hex')
function fixture() {
  const selected = {id: randomUUID(), compteurId: randomUUID(), externalId: 'NEW', enabled: false, provider: 'rives-et-eaux', scope: 'epidropt'}
  const old = {id: randomUUID(), compteurId: randomUUID(), externalId: 'OLD', enabled: true, provider: 'rives-et-eaux', scope: 'epidropt'}
  const payload = {scope: 'epidropt', meters: [selected, old].map(stream => ({id: stream.compteurId, serial: stream.externalId, provider: stream.provider, allocationSnapshotValidated: true}))}
  const manifest = {...payload, manifestHash: digest(payload)}
  const batch = {provider: 'rives-et-eaux', scope: 'epidropt', mode: 'LIVE', complete: true, preserveOrdinary: true, batchId: 'already-ingested',
    windowStart: '2025-12-31T23:00:00.000Z', windowEnd: '2026-01-01T23:00:00.000Z', fetchedAt: '2026-09-17T10:00:00.000Z',
    readings: [{externalId: 'NEW', observedAt: '2026-01-01T12:00:00Z', status: 'VALID', index: '10'},
      {externalId: 'NEW', observedAt: '2026-01-01T13:00:00Z', status: 'INVALID', index: null},
      {externalId: 'OLD', observedAt: '2026-01-01T12:00:00Z', status: 'VALID', index: '20'}]}
  const buffer = Buffer.from(JSON.stringify({batch, batchHash: sha(JSON.stringify(batch))}))
  return {manifest, snapshot: {target: 'testing', readOnly: true, completed: true, tables: {streams: [selected, old]}},
    archiveManifest: {target: 'testing', format: 1, files: [{filename: '2026-01-01.json', sha256: sha(buffer),
      fetchedAt: batch.fetchedAt, windowStart: batch.windowStart, windowEnd: batch.windowEnd}]},
    readArchiveFile: async () => buffer}
}
const acknowledgement = batch => ({persisted: true, preserveOrdinary: true, streamIds: batch.streamIds,
  checkpoint: batch.windowEnd, counts: {received: batch.readings.length, accepted: 1, blocked: 1, unknownMeters: 0, published: 0, conflicts: 0}})

test('archive replay isolates newly validated streams, retains invalid observations and original fetch order', async t => {
  const input = fixture()
  const plan = await prepareMeterArchiveReplay(input)
  t.is(plan.summary.streams, 1)
  t.is(plan.summary.readings, 2)
  t.is(plan.summary.invalidReadings, 1)
  t.is(plan.summary.uniqueObservations, 2)
  t.is(plan.batches[0].batch.fetchedAt, '2026-09-17T10:00:00.000Z')
  t.not(plan.batches[0].batch.batchId, 'already-ingested')
  t.deepEqual(await prepareMeterArchiveReplay(input), plan)
})

test('archive preparation rejects changed frozen input and unsafe filenames', async t => {
  const input = fixture()
  input.archiveManifest.files[0].sha256 = 'incorrect'
  await t.throwsAsync(prepareMeterArchiveReplay(input), {message: 'ARCHIVE_FILE_HASH_MISMATCH'})
  input.archiveManifest.files[0].filename = '../other.json'
  await t.throwsAsync(prepareMeterArchiveReplay(input), {message: 'ARCHIVE_WINDOW_OUTSIDE_2026'})
})

test('replay persists receipts, skips acknowledged batches and rejects incomplete acknowledgements', async t => {
  const plan = await prepareMeterArchiveReplay(fixture())
  const receipts = new Map()
  let calls = 0
  const io = {submit: async batch => { calls++; return acknowledgement(batch) },
    readReceipt: async id => receipts.get(id), writeReceipt: async receipt => { receipts.set(receipt.batchId, receipt) }}
  const first = await replayPreparedMeterArchives(plan, io)
  t.true(first.completed)
  t.is(first.appliedBatches, 1)
  const second = await replayPreparedMeterArchives(plan, io)
  t.is(second.reusedBatches, 1)
  t.is(calls, 1)
  receipts.clear()
  await t.throwsAsync(replayPreparedMeterArchives(plan, {...io, submit: async () => ({persisted: false})}), {message: 'INGESTION_ACKNOWLEDGEMENT_INVALID'})
  t.is(receipts.size, 0)
})

test('an uncertain submit retries the identical batch and bounded execution remains resumable', async t => {
  const one = await prepareMeterArchiveReplay(fixture())
  const payload = {...one, batches: [...one.batches, ...one.batches.map(entry => {
    const batch = {...entry.batch, batchId: `${entry.batch.batchId}:second`}
    return {...entry, batch, sha256: digest(batch)}
  })]}
  delete payload.planHash
  const plan = {...payload, planHash: digest(payload)}
  const receipts = new Map()
  const io = {readReceipt: async id => receipts.get(id), writeReceipt: async receipt => { receipts.set(receipt.batchId, receipt) },
    submit: async batch => acknowledgement(batch), maxBatches: 1}
  const first = await replayPreparedMeterArchives(plan, io)
  t.false(first.completed)
  t.is(first.pendingBatches, 1)
  const second = await replayPreparedMeterArchives(plan, io)
  t.true(second.completed)
  t.is(second.reusedBatches, 1)
  const uncertainPayloads = []
  receipts.clear()
  await t.throwsAsync(replayPreparedMeterArchives(one, {...io, submit: async batch => {
    uncertainPayloads.push(batch)
    throw new Error('uncertain-network')
  }}), {message: 'uncertain-network'})
  await replayPreparedMeterArchives(one, {...io, submit: async batch => { uncertainPayloads.push(batch); return acknowledgement(batch) }})
  t.deepEqual(uncertainPayloads[0], uncertainPayloads[1])
})
