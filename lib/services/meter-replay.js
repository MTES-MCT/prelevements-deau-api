/* eslint-disable no-await-in-loop -- Each explicitly selected stream is replayed atomically and reported independently. */
import createHttpError from 'http-errors'
import {prisma} from '../../db/prisma.js'
import {meterReplaySchema} from '../validation/meters.js'
import {coversHistoricalMeterPublication, meterHash, scaledDecimal, validateAllocationSnapshot} from './meter-core.js'
import {lockMeter, reprocessMeterStreamInTransaction} from './meter-publication.js'

class SimulationRollback extends Error {
  constructor(report) {
    super('METER_REPLAY_SIMULATION_ROLLBACK')
    this.report = report
  }
}

async function authorizeHistoricalAllocations(tx, stream, request, operationId) {
  const result = {created: 0, reused: 0}
  if (!request.historicalAuthorization) return result
  if (!stream.enabled || !stream.activatedAt) return {...result, reason: 'NOT_ACTIVATED'}
  const from = new Date(request.from)
  const to = new Date(request.to)
  if (to > stream.activatedAt) return {...result, reason: 'HISTORICAL_WINDOW_AFTER_ACTIVATION'}
  let snapshot
  try {
    snapshot = validateAllocationSnapshot(stream.allocationSnapshot, stream.allocationSnapshotValidated)
  } catch (error) {
    return {...result, reason: error.message}
  }
  const allocations = await tx.meterAllocation.findMany({
    where: {compteurId: stream.compteurId, provider: stream.provider, scope: stream.scope}, include: {versions: true}
  })
  const planned = []
  for (const share of snapshot.filter(entry => entry.inScope)) {
    const allocation = allocations.find(item => item.sourceId === share.key)
    if (!allocation) return {...result, reason: 'MISSING_ALLOCATION'}
    const overlapping = allocation.versions.filter(version => version.enabled && version.startDate
      && new Date(version.startDate) < to && (!version.endDate || new Date(version.endDate) > from))
    const existing = overlapping.length === 1 ? overlapping[0] : null
    if (existing && new Date(existing.startDate) <= from && existing.endDate && new Date(existing.endDate) >= to
      && coversHistoricalMeterPublication(existing, from, to)
      && scaledDecimal(existing.percentage) === share.percentage
      && meterHash(existing.metadata.allocationSnapshot) === meterHash(stream.allocationSnapshot)) {
      result.reused++
      continue
    }
    if (overlapping.length) return {...result, reason: 'HISTORICAL_ALLOCATION_OVERLAP'}
    const confirmedAt = new Date(request.historicalAuthorization.confirmedAt)
    const current = allocation.versions.filter(version => version.enabled && version.startDate
      && new Date(version.startDate) <= confirmedAt && (!version.endDate || new Date(version.endDate) > confirmedAt))
    if (current.length !== 1 || current[0].percentage === null || scaledDecimal(current[0].percentage) !== share.percentage
      || current[0].metadata?.allocationSnapshotValidated !== true
      || meterHash(current[0].metadata.allocationSnapshot) !== meterHash(stream.allocationSnapshot)) {
      return {...result, reason: 'CURRENT_ALLOCATION_UNRESOLVED'}
    }
    planned.push({allocation, template: current[0]})
  }
  if (!snapshot.some(entry => entry.inScope)) return {...result, reason: 'MISSING_ALLOCATION'}
  for (const {allocation, template} of planned) {
    await tx.meterAllocationVersion.create({data: {
      allocationId: allocation.id, version: Math.max(...allocation.versions.map(version => version.version), 0) + 1,
      percentage: template.percentage, additive: template.additive, enabled: true, startDate: from, endDate: to,
      metadata: {
        allocationSnapshot: stream.allocationSnapshot, allocationSnapshotValidated: true,
        historicalPublication: {...request.historicalAuthorization, from: from.toISOString(), to: to.toISOString(), operationId}
      }
    }})
    result.created++
  }
  return result
}

async function replayOneStream(client, streamId, request, operationId, apply) {
  try {
    return await client.$transaction(async tx => {
      let stream = await tx.meterStream.findUnique({where: {id: streamId}})
      if (!stream) throw createHttpError(404, 'Flux compteur introuvable.')
      await lockMeter(tx, stream.compteurId)
      stream = await tx.meterStream.findUnique({where: {id: streamId}})
      if (!stream || stream.provider !== request.provider || stream.scope !== request.scope) throw createHttpError(409, 'Le périmètre du flux a changé.')
      const versions = await authorizeHistoricalAllocations(tx, stream, request, operationId)
      if (versions.reason) return {streamId, status: 'SKIPPED', reason: versions.reason, versionsCreated: 0, versionsReused: versions.reused}
      const publicationsBefore = await tx.meterPublication.count({where: {streamId}})
      const result = await reprocessMeterStreamInTransaction(tx, stream, {
        from: new Date(request.from), to: new Date(request.to), contained: true, preserveOrdinary: true
      })
      const sourcesCreated = await tx.meterPublication.count({where: {streamId}}) - publicationsBefore
      const report = {streamId, status: 'COMPLETED', versionsCreated: versions.created, versionsReused: versions.reused, sourcesCreated, ...result}
      if (apply) {
        await tx.meterStream.update({where: {id: streamId}, data: {lastIssue: result.issues.join(',') || null}})
        await tx.auditEvent.create({data: {
          outcome: 'SUCCESS', completedAt: new Date(), actionType: 'METER.HISTORY_REPLAYED', actionCategory: 'DATA_INGESTION',
          actorLabel: request.historicalAuthorization?.confirmedBy ?? 'Opération de rejeu explicite',
          targetType: 'METER_STREAM', targetId: streamId, requestId: operationId, httpMethod: 'INTERNAL', route: 'meter-streams/replay',
          metadata: {provider: request.provider, scope: request.scope, from: request.from, to: request.to,
            preserveOrdinary: true, historicalAuthorization: request.historicalAuthorization ?? null, report}
        }})
        return report
      }
      throw new SimulationRollback(report)
    }, {timeout: 120_000, maxWait: 20_000})
  } catch (error) {
    if (error instanceof SimulationRollback) return error.report
    throw error
  }
}

// Internal operational service: the caller must authenticate/authorize its
// operator and exact database target. No provider-specific route or parser.
// [from, to) are explicit instants; only complete observation intervals inside
// this window are replayed. A dry run executes this same path then rolls back.
export async function replayMeterStreams(payload, {apply = false, client = prisma} = {}) {
  if (typeof apply !== 'boolean') throw createHttpError(400, 'Le mode application doit être un booléen explicite.')
  const {value: request, error} = meterReplaySchema.validate(payload)
  if (error) throw createHttpError(400, error.message)
  const streams = await client.meterStream.findMany({
    where: {provider: request.provider, scope: request.scope, id: {in: request.streamIds}},
    select: {id: true}, orderBy: {id: 'asc'}
  })
  if (streams.length !== request.streamIds.length) throw createHttpError(404, 'Un flux est absent du périmètre explicitement demandé.')
  const operationId = meterHash({...request, streamIds: streams.map(stream => stream.id)})
  const report = {operationId, applied: apply, completed: true, provider: request.provider, scope: request.scope,
    from: request.from, to: request.to, preserveOrdinary: true, streams: []}
  for (const stream of streams) {
    try {
      report.streams.push(await replayOneStream(client, stream.id, request, operationId, apply))
    } catch (error) {
      report.completed = false
      report.streams.push({streamId: stream.id, status: 'FAILED', reason: error.expose ? error.message : (error.code ?? 'REPLAY_FAILED')})
      break
    }
  }
  report.totals = report.streams.reduce((totals, stream) => {
    for (const key of ['versionsCreated', 'versionsReused', 'sourcesCreated', 'published', 'conflicts']) totals[key] += stream[key] ?? 0
    totals.unchanged += stream.intervals?.unchanged ?? 0
    for (const [reason, count] of Object.entries(stream.intervals?.reasons ?? {})) totals.blockedIntervals[reason] = (totals.blockedIntervals[reason] ?? 0) + count
    if (stream.status !== 'COMPLETED') totals.skippedStreams[stream.reason] = (totals.skippedStreams[stream.reason] ?? 0) + 1
    return totals
  }, {versionsCreated: 0, versionsReused: 0, sourcesCreated: 0, published: 0, conflicts: 0, unchanged: 0, blockedIntervals: {}, skippedStreams: {}})
  return report
}
