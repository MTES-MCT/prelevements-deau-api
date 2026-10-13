/* eslint-disable no-await-in-loop -- Each canonical revision is selected under ordered transaction locks. */
import createHttpError from 'http-errors'
import {Prisma} from '@prisma/client'
import {prisma} from '../../db/prisma.js'
import {meterIngestionSchema, meterStreamQuerySchema} from '../validation/meters.js'
import {decimalString, scaledDecimal, meterHash, normalizeMeterReading, shouldPromoteMeterRevision} from './meter-core.js'
import {lockMeters, lockMeterPublicationPoints, reprocessMeterStreamInTransaction} from './meter-publication.js'

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

export async function persistMeterReadingInTransaction(tx, row, ingestion, counts) {
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

function dateTimestamp(value) {
  return value?.getTime() ?? null
}

export async function finalizeMeterStreamsInTransaction(tx, states, windowEnd) {
  if (!states.length) return
  // lastReadingAt describes the physical meter, including invalid observations
  // and revisions from other streams. Do not derive it from this batch alone.
  const latest = await tx.meterReading.groupBy({
    by: ['compteurId'], where: {compteurId: {in: [...new Set(states.map(({stream}) => stream.compteurId))]}},
    _max: {observedAt: true}
  })
  const latestByMeter = new Map(latest.map(reading => [reading.compteurId, reading._max.observedAt]))
  const groups = new Map()
  for (const {stream, blockedWindows, issues} of states) {
    const lastReadingAt = latestByMeter.get(stream.compteurId) ?? null
    const checkpoint = stream.checkpoint && stream.checkpoint > windowEnd ? stream.checkpoint : windowEnd
    const lastIssue = issues.join(',') || null
    const data = {}
    if (meterHash(blockedWindows) !== meterHash(stream.blockedWindows)) data.blockedWindows = blockedWindows
    if (dateTimestamp(lastReadingAt) !== dateTimestamp(stream.lastReadingAt)) data.lastReadingAt = lastReadingAt
    if (dateTimestamp(checkpoint) !== dateTimestamp(stream.checkpoint)) data.checkpoint = checkpoint
    if (lastIssue !== stream.lastIssue) data.lastIssue = lastIssue
    if (!Object.keys(data).length) continue
    // Serialize dates before hashing: meterHash deliberately handles plain JSON.
    const key = meterHash(JSON.parse(JSON.stringify(data)))
    const group = groups.get(key) ?? {ids: [], data}
    group.ids.push(stream.id)
    groups.set(key, group)
  }
  // One successful transaction has one completion instant, including streams
  // with no observations. Explicit updatedAt keeps subsequent patches aligned.
  const completedAt = new Date()
  const ids = states.map(({stream}) => stream.id)
  const updated = await tx.meterStream.updateMany({where: {id: {in: ids}}, data: {
    lastSuccessAt: completedAt, updatedAt: completedAt
  }})
  if (updated.count !== ids.length) throw createHttpError(409, 'Le périmètre des flux autorisés a changé.')
  for (const group of groups.values()) {
    const patched = await tx.meterStream.updateMany({where: {id: {in: group.ids}}, data: {...group.data, updatedAt: completedAt}})
    if (patched.count !== group.ids.length) throw createHttpError(409, 'Le périmètre des flux autorisés a changé.')
  }
}

export async function ingestMeterBatch(payload, actor, {client = prisma} = {}) {
  const {value, error} = meterIngestionSchema.validate(payload)
  if (error) throw createHttpError(400, error.message)
  const humanAdmin = isHumanAdmin(actor)
  const where = authorizedMeterStreamsWhere({...actor, mode: value.mode, provider: value.provider, scope: value.scope})
  if (value.streamIds) {
    value.streamIds = [...value.streamIds].sort()
    where.id = {in: value.streamIds}
  }
  const selection = value.streamIds ? {streamIds: value.streamIds} : {}
  // Omitted/false keeps the historical hash exactly, including retries of lots
  // persisted before this option existed. A protected batch cannot be weakened
  // by replaying the same batchId without its protection (or vice versa).
  const protection = value.preserveOrdinary ? {preserveOrdinary: true} : {}
  const payloadHash = meterHash({provider: value.provider, scope: value.scope, mode: value.mode, fetchedAt: value.fetchedAt,
    windowStart: value.windowStart, windowEnd: value.windowEnd, readings: value.readings, ...protection, ...selection})
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
    if (value.streamIds && streams.length !== value.streamIds.length) throw createHttpError(403, 'Un flux indiqué est absent du périmètre autorisé.')
    if (!streams.length && !humanAdmin) throw createHttpError(403, 'Aucun flux compteur autorisé pour ce compte de service.')
    await lockMeters(tx, streams.map(stream => stream.compteurId))
    // Configuration can change while the request waits for the meter locks.
    streams = await tx.meterStream.findMany({where, orderBy: {compteurId: 'asc'}})
    if (value.streamIds && streams.length !== value.streamIds.length) throw createHttpError(403, 'Le périmètre des flux autorisés a changé.')
    if (value.streamIds && value.readings.some(reading => reading.externalId && !streams.some(stream => stream.externalId === reading.externalId))) {
      throw createHttpError(400, 'Une observation ne correspond pas aux flux explicitement sélectionnés.')
    }
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
      if (await persistMeterReadingInTransaction(tx, row, ingestion, counts)) changed.add(row.stream.id)
    }
    const states = []
    for (const stream of streams) {
      const blockedWindows = nextBlockedWindows(stream, rows, ingestion)
      const blockedChanged = meterHash(blockedWindows) !== meterHash(stream.blockedWindows)
      if (blockedChanged) changed.add(stream.id)
      const result = changed.has(stream.id)
        ? await reprocessMeterStreamInTransaction(tx, {...stream, blockedWindows}, {
          from: ingestion.windowStart, to: ingestion.windowEnd, preserveOrdinary: value.preserveOrdinary
        })
        : {published: 0, conflicts: 0, issues: stream.lastIssue ? [stream.lastIssue] : []}
      counts.published += result.published
      counts.conflicts += result.conflicts
      states.push({stream, blockedWindows, issues: result.issues})
    }
    await finalizeMeterStreamsInTransaction(tx, states, ingestion.windowEnd)
    const result = {persisted: true, ingestionId: ingestion.id, counts, checkpoint: value.windowEnd, ...protection, ...selection}
    await tx.meterIngestion.update({where: {id: ingestion.id}, data: {result: {...result, quarantine}}})
    return {...result, quarantine}
  }, {timeout: 120_000, maxWait: 20_000})
}
