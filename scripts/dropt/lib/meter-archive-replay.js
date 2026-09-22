import {createHash} from 'node:crypto'
import {digest} from './epidropt.js'

const sha256 = value => createHash('sha256').update(value).digest('hex')
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const sorted = values => [...values].sort()

export async function prepareMeterArchiveReplay({manifest, snapshot, archiveManifest, readArchiveFile}) {
  const {manifestHash, ...manifestPayload} = manifest
  assert(manifestHash === digest(manifestPayload), 'IMPORT_MANIFEST_HASH_MISMATCH')
  assert(snapshot.target === 'testing' && snapshot.readOnly && snapshot.completed, 'COMPLETE_TESTING_SNAPSHOT_REQUIRED')
  assert(archiveManifest.target === 'testing' && archiveManifest.format === 1 && Array.isArray(archiveManifest.files), 'INVALID_ARCHIVE_MANIFEST')
  const prior = snapshot.tables.streams.filter(stream => stream.provider === 'rives-et-eaux' && stream.scope === manifest.scope)
  const selected = manifest.meters.filter(meter => meter.provider === 'rives-et-eaux' && meter.allocationSnapshotValidated)
    .map(meter => ({meter, stream: prior.find(stream => stream.externalId === meter.serial)}))
    .filter(({stream}) => !stream?.enabled)
  assert(selected.length > 0 && selected.length <= 200 && selected.every(({meter, stream}) => stream && stream.compteurId === meter.id), 'NEW_VALIDATED_STREAM_IDENTITIES_REQUIRED')
  const selectedStreams = selected.map(({stream}) => ({id: stream.id, compteurId: stream.compteurId, externalId: stream.externalId})).sort((a, b) => a.id.localeCompare(b.id))
  const streamIds = selectedStreams.map(stream => stream.id)
  const externalIds = new Set(selectedStreams.map(stream => stream.externalId))
  assert(new Set(streamIds).size === streamIds.length && externalIds.size === streamIds.length, 'DUPLICATE_STREAM_IDENTITY')
  const batches = []
  const observationKeys = new Set()
  let invalidReadings = 0
  let windows = 0
  for (const entry of [...archiveManifest.files].sort((a, b) => a.filename.localeCompare(b.filename))) {
    assert(/^2026-\d{2}-\d{2}\.json$/.test(entry.filename), 'ARCHIVE_WINDOW_OUTSIDE_2026')
    const buffer = await readArchiveFile(entry.filename)
    assert(sha256(buffer) === entry.sha256, 'ARCHIVE_FILE_HASH_MISMATCH')
    const envelope = JSON.parse(buffer.toString('utf8'))
    const original = envelope.batch
    assert(envelope.batchHash === sha256(JSON.stringify(original)), 'ARCHIVE_BATCH_HASH_MISMATCH')
    assert(original.provider === 'rives-et-eaux' && original.scope === manifest.scope && original.mode === 'LIVE'
      && original.complete === true && original.preserveOrdinary === true, 'ARCHIVE_SCOPE_OR_PROTECTION_INVALID')
    assert(original.windowStart === entry.windowStart && original.windowEnd === entry.windowEnd && original.fetchedAt === entry.fetchedAt,
      'ARCHIVE_WINDOW_METADATA_MISMATCH')
    windows++
    const readings = original.readings.filter(reading => externalIds.has(reading.externalId))
    if (!readings.length) continue
    for (const reading of readings) {
      if (reading.status !== 'VALID') invalidReadings++
      if (reading.observedAt) observationKeys.add(`${reading.externalId}:${reading.observedAt}`)
    }
    const batch = {...original, streamIds, readings,
      batchId: `archive-replay:v1:${digest({archiveHash: entry.sha256, streamIds})}`}
    batches.push({filename: entry.filename, sha256: digest(batch), batch})
  }
  const plan = {format: 1, target: 'testing', provider: 'rives-et-eaux', scope: manifest.scope,
    manifestHash, snapshotStartedAt: snapshot.startedAt, archiveManifestHash: digest(archiveManifest), selectedStreams, batches,
    summary: {streams: selectedStreams.length, archivedWindows: windows, batches: batches.length,
      readings: batches.reduce((sum, item) => sum + item.batch.readings.length, 0), invalidReadings, uniqueObservations: observationKeys.size}}
  return {...plan, planHash: digest(plan)}
}

function assertReceipt(entry, receipt) {
  assert(receipt?.sha256 === entry.sha256 && receipt.batchId === entry.batch.batchId, 'RECEIPT_BATCH_MISMATCH')
  const result = receipt.result
  assert(result?.persisted === true && result.preserveOrdinary === true
    && result.counts?.received === entry.batch.readings.length && result.counts.unknownMeters === 0
    && Date.parse(result.checkpoint) >= Date.parse(entry.batch.windowEnd)
    && digest(sorted(result.streamIds ?? [])) === digest(sorted(entry.batch.streamIds)), 'INGESTION_ACKNOWLEDGEMENT_INVALID')
}

// No connection, credentials or provider fetch is hidden here. The caller owns
// target/authentication checks, HTTP submission and private durable receipts.
// A failed/uncertain submission reuses the exact same batch on the next run.
export async function replayPreparedMeterArchives(plan, {submit, readReceipt, writeReceipt, maxBatches = 20, signal} = {}) {
  const {planHash, ...payload} = plan
  assert(planHash === digest(payload) && plan.target === 'testing', 'REPLAY_PLAN_HASH_MISMATCH')
  assert(Number.isInteger(maxBatches) && maxBatches > 0 && maxBatches <= 200, 'REPLAY_BATCH_LIMIT_INVALID')
  assert(typeof submit === 'function' && typeof readReceipt === 'function' && typeof writeReceipt === 'function', 'REPLAY_IO_REQUIRED')
  const report = {planHash, appliedBatches: 0, reusedBatches: 0, pendingBatches: 0, counts: {received: 0, accepted: 0, blocked: 0, published: 0, conflicts: 0}}
  for (const entry of plan.batches) {
    signal?.throwIfAborted()
    assert(entry.sha256 === digest(entry.batch), 'REPLAY_BATCH_HASH_MISMATCH')
    const prior = await readReceipt(entry.batch.batchId)
    if (prior) {
      assertReceipt(entry, prior)
      report.reusedBatches++
      continue
    }
    if (report.appliedBatches >= maxBatches) { report.pendingBatches++; continue }
    const result = await submit(entry.batch)
    const receipt = {batchId: entry.batch.batchId, sha256: entry.sha256, result}
    assertReceipt(entry, receipt)
    await writeReceipt(receipt)
    report.appliedBatches++
    for (const key of Object.keys(report.counts)) report.counts[key] += result.counts[key] ?? 0
  }
  report.completed = report.pendingBatches === 0
  return report
}
