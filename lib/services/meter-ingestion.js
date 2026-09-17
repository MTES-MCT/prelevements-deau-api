/* eslint-disable no-await-in-loop -- Each canonical revision is selected under ordered transaction locks. */
import createHttpError from 'http-errors'
import {Prisma} from '@prisma/client'
import {prisma} from '../../db/prisma.js'
import {meterIngestionSchema, meterStreamQuerySchema} from '../validation/meters.js'
import {decimalString, scaledDecimal, meterHash, normalizeMeterReading, shouldPromoteMeterRevision} from './meter-core.js'
import {lockMeter, lockMeterPublicationPoints, reprocessMeterStreamInTransaction} from './meter-publication.js'

function isHumanAdmin({serviceAccountId, user}) {
  return !serviceAccountId && user?.role === 'ADMIN'
}

export function authorizedMeterStreamsWhere({serviceAccountId, user, mode = 'LIVE', provider, scope}) {
  const {error} = meterStreamQuerySchema.validate({provider, scope})
  if (error) throw createHttpError(400, error.message)
  if (isHumanAdmin({serviceAccountId, user})) return {provider, scope, ...(mode === 'LIVE' ? {enabled: true} : {})}
  if (!serviceAccountId || mode !== 'LIVE') throw createHttpError(403, 'Ce flux compteur n’est pas autorisé.')
  return {provider, scope, serviceAccountId, enabled: true}
}

export async function getMeterStreamContext(query, actor, {client = prisma} = {}) {
  const {value, error} = meterStreamQuerySchema.validate(query)
  if (error) throw createHttpError(400, error.message)
  const streams = await client.meterStream.findMany({
    where: authorizedMeterStreamsWhere({...actor, ...value}),
    select: {id: true, externalId: true, compteurId: true, activatedAt: true, lastSuccessAt: true, lastReadingAt: true},
    orderBy: {externalId: 'asc'}
  })
  return {...value, streams}
}

function semanticReading(normalized) {
  return {
    index: normalized.index === null || normalized.index === undefined ? null : decimalString(scaledDecimal(normalized.index)),
    quality: normalized.quality ?? null, origin: normalized.origin ?? null,
    admissible: normalized.admissible === true, reason: normalized.reason ?? null
  }
}

function prepareRows(readings, streams, window) {
  const rows = readings.map(row => {
    const normalized = normalizeMeterReading(row, window)
    const raw = Object.hasOwn(row, 'raw') ? row.raw : row
    return {raw, normalized, stream: streams.find(stream => stream.externalId === normalized.externalId)}
  })
  const identities = new Map()
  for (const row of rows) {
    if (!row.stream || !row.normalized.observedAt) continue
    const key = `${row.stream.compteurId}:${row.normalized.observedAt.toISOString()}`
    const entry = identities.get(key) ?? {hashes: new Set(), rows: []}
    entry.hashes.add(meterHash(semanticReading(row.normalized)))
    entry.rows.push(row)
    identities.set(key, entry)
  }
  for (const entry of identities.values()) {
    if (entry.hashes.size < 2) continue
    for (const row of entry.rows) Object.assign(row.normalized, {index: null, admissible: false, reason: 'BATCH_CONTRADICTION'})
  }
  return rows
}

async function persistReading(tx, row, ingestion, counts) {
  const {stream, raw, normalized} = row
  let semantic = semanticReading(normalized)
  let reading = await tx.meterReading.findUnique({
    where: {compteurId_observedAt: {compteurId: stream.compteurId, observedAt: normalized.observedAt}},
    include: {currentRevision: true}
  })
  const sameFetch = reading?.currentRevisionId && reading.currentMode === ingestion.mode
    && reading.lastFetchedAt.getTime() === ingestion.fetchedAt.getTime()
  if (sameFetch && meterHash(semanticReading(reading.currentRevision)) !== meterHash(semantic)) {
    semantic = {...semantic, index: null, admissible: false, reason: 'FETCH_ORDER_CONFLICT'}
    if (normalized.admissible) { counts.accepted--; counts.blocked++ }
  }
  if (!reading) reading = await tx.meterReading.create({data: {
    compteurId: stream.compteurId, observedAt: normalized.observedAt,
    lastFetchedAt: ingestion.fetchedAt, currentMode: ingestion.mode
  }})
  const payloadHash = meterHash(semantic)
  let revision = await tx.meterReadingRevision.findUnique({where: {
    readingId_streamId_mode_payloadHash: {readingId: reading.id, streamId: stream.id, mode: ingestion.mode, payloadHash}
  }})
  if (revision) counts.unchanged++
  else revision = await tx.meterReadingRevision.create({data: {
    readingId: reading.id, streamId: stream.id, ingestionId: ingestion.id, mode: ingestion.mode,
    ...semantic, payloadHash, raw: raw === null ? Prisma.JsonNull : raw
  }})
  const promote = shouldPromoteMeterRevision(reading, ingestion.mode, ingestion.fetchedAt)
    || (sameFetch && semantic.reason === 'FETCH_ORDER_CONFLICT')
  if (!promote) return false
  await tx.meterReading.update({where: {id: reading.id}, data: {
    currentRevisionId: revision.id, currentMode: ingestion.mode, lastFetchedAt: ingestion.fetchedAt
  }})
  return reading.currentRevisionId !== revision.id
}

function nextBlockedWindows(stream, rows, ingestion) {
  const previous = Array.isArray(stream.blockedWindows) ? stream.blockedWindows : []
  // An authoritative, newer complete window can clear a previous unlocatable
  // observation. OFFLINE must never clear a LIVE quarantine.
  const remaining = previous.filter(window => !(
    new Date(window.windowStart) >= ingestion.windowStart && new Date(window.windowEnd) <= ingestion.windowEnd
    && new Date(window.fetchedAt) < ingestion.fetchedAt && (ingestion.mode === 'LIVE' || window.mode === 'OFFLINE')
  ))
  if (rows.some(row => row.stream?.id === stream.id && !row.normalized.observedAt)) {
    remaining.push({windowStart: ingestion.windowStart.toISOString(), windowEnd: ingestion.windowEnd.toISOString(),
      fetchedAt: ingestion.fetchedAt.toISOString(), mode: ingestion.mode})
  }
  return remaining
}

export async function ingestMeterBatch(payload, actor, {client = prisma} = {}) {
  const {value, error} = meterIngestionSchema.validate(payload)
  if (error) throw createHttpError(400, error.message)
  const humanAdmin = isHumanAdmin(actor)
  const where = authorizedMeterStreamsWhere({...actor, mode: value.mode, provider: value.provider, scope: value.scope})
  const payloadHash = meterHash({provider: value.provider, scope: value.scope, mode: value.mode, fetchedAt: value.fetchedAt,
    windowStart: value.windowStart, windowEnd: value.windowEnd, readings: value.readings})
  return client.$transaction(async tx => {
    const batchLockKey = meterHash([value.provider, value.scope, value.batchId])
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('meter-ingestion'), hashtext(${batchLockKey}))`
    const previous = await tx.meterIngestion.findUnique({where: {provider_scope_batchId: {
      provider: value.provider, scope: value.scope, batchId: value.batchId
    }}})
    if (previous) {
      if (previous.payloadHash !== payloadHash || (!humanAdmin && previous.serviceAccountId !== actor.serviceAccountId)) {
        throw createHttpError(409, 'Cet identifiant de lot correspond à une autre ingestion.')
      }
      return previous.result
    }
    let streams = await tx.meterStream.findMany({where, orderBy: {compteurId: 'asc'}})
    if (!streams.length && !humanAdmin) throw createHttpError(403, 'Aucun flux compteur autorisé pour ce compte de service.')
    for (const compteurId of [...new Set(streams.map(stream => stream.compteurId))]) await lockMeter(tx, compteurId)
    // Configuration can change while the request waits for the meter locks.
    streams = await tx.meterStream.findMany({where, orderBy: {compteurId: 'asc'}})
    await lockMeterPublicationPoints(tx, streams.map(stream => stream.compteurId))
    const ingestion = await tx.meterIngestion.create({data: {
      provider: value.provider, scope: value.scope, batchId: value.batchId, mode: value.mode,
      serviceAccountId: actor.serviceAccountId ?? null, actorUserId: humanAdmin ? actor.user.id : null,
      fetchedAt: new Date(value.fetchedAt), windowStart: new Date(value.windowStart), windowEnd: new Date(value.windowEnd),
      payloadHash, rawPayload: value.readings
    }})
    const rows = prepareRows(value.readings, streams, ingestion)
    const counts = {received: rows.length, accepted: 0, blocked: 0, unknownMeters: 0, unchanged: 0, published: 0, conflicts: 0}
    const changed = new Set()
    const quarantine = []
    for (const row of rows) {
      if (!row.stream && row.normalized.externalId) { counts.unknownMeters++; continue }
      if (!row.stream || !row.normalized.observedAt) {
        counts.blocked++
        quarantine.push({externalId: row.normalized.externalId ?? null, reason: row.normalized.reason})
        continue
      }
      counts[row.normalized.admissible ? 'accepted' : 'blocked']++
      if (await persistReading(tx, row, ingestion, counts)) changed.add(row.stream.id)
    }
    for (const stream of streams) {
      const blockedWindows = nextBlockedWindows(stream, rows, ingestion)
      const blockedChanged = meterHash(blockedWindows) !== meterHash(stream.blockedWindows)
      if (blockedChanged) changed.add(stream.id)
      stream.blockedWindows = blockedWindows
      const result = changed.has(stream.id)
        ? await reprocessMeterStreamInTransaction(tx, stream, {from: ingestion.windowStart, to: ingestion.windowEnd})
        : {published: 0, conflicts: 0, issues: stream.lastIssue ? [stream.lastIssue] : []}
      counts.published += result.published
      counts.conflicts += result.conflicts
      const latest = await tx.meterReading.findFirst({where: {compteurId: stream.compteurId}, orderBy: {observedAt: 'desc'}, select: {observedAt: true}})
      const checkpoint = stream.checkpoint && stream.checkpoint > ingestion.windowEnd ? stream.checkpoint : ingestion.windowEnd
      await tx.meterStream.update({where: {id: stream.id}, data: {
        blockedWindows, lastSuccessAt: new Date(), lastReadingAt: latest?.observedAt ?? null,
        checkpoint, lastIssue: result.issues.join(',') || null
      }})
    }
    const result = {persisted: true, ingestionId: ingestion.id, counts, checkpoint: value.windowEnd}
    await tx.meterIngestion.update({where: {id: ingestion.id}, data: {result: {...result, quarantine}}})
    return {...result, quarantine}
  }, {timeout: 120_000, maxWait: 20_000})
}
