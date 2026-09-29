/* eslint-disable no-await-in-loop -- Ordered meter/point locks and publication writes share one transaction. */
import createHttpError from 'http-errors'
import {prisma} from '../../db/prisma.js'
import {getCompatibleMetricTypeCodes} from '../constants/metric-type-codes.js'
import {refreshVolumeMetadataForSourceIds} from './volume-totals.js'
import {refreshSourceDeclarantsLastDeclarationAt} from '../models/declarant.js'
import {decimalString, meterHash, planMeterInterval} from './meter-core.js'

export async function lockMeter(tx, compteurId) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('physical-meter'), hashtext(${compteurId}))`
}

export async function lockMeterPublicationPoints(tx, compteurIds) {
  const allocations = await tx.meterAllocation.findMany({
    where: {compteurId: {in: compteurIds}}, select: {exploitation: {select: {pointPrelevementId: true}}}
  })
  for (const pointId of [...new Set(allocations.map(allocation => allocation.exploitation.pointPrelevementId))].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('volumes-from-index'), hashtext(${pointId}))`
  }
}

async function supersedePublications(tx, publications) {
  if (!publications.length) return
  const ids = publications.map(publication => publication.id)
  const sourceIds = publications.map(publication => publication.sourceId)
  await tx.meterPublication.updateMany({where: {id: {in: ids}}, data: {active: false, supersededAt: new Date()}})
  await tx.chunk.updateMany({where: {sourceId: {in: sourceIds}}, data: {instructionStatus: 'REJECTED'}})
  await tx.source.updateMany({where: {id: {in: sourceIds}}, data: {globalInstructionStatus: 'REJECTED'}})
  await refreshVolumeMetadataForSourceIds(sourceIds, tx)
}

async function collectConflicts(tx, stream, start, end, plan, {preserveOrdinary = false} = {}) {
  const replacements = []
  for (const group of plan.groups) {
    const {pointPrelevementId, declarantUserId} = group.exploitation
    const existing = await tx.chunkValue.findMany({
      where: {
        metricTypeCode: {in: getCompatibleMetricTypeCodes('volume')},
        periodStart: {lt: end.observedAt}, periodEnd: {gt: start.observedAt},
        chunk: {
          pointPrelevementId,
          OR: [{preleveurUserId: declarantUserId}, {preleveurUserId: null}],
          AND: [{OR: [{exploitationId: group.exploitation.id}, {exploitationId: null}]}],
          instructionStatus: {not: 'REJECTED'}, source: {status: 'COMPLETED'}
        }
      },
      include: {chunk: {include: {source: {include: {meterPublication: true}}}}}
    })
    for (const value of existing) {
      if ((preserveOrdinary || plan.historical || plan.preserveOrdinary) && value.chunk.calculationStrategy === 'GENERIC') {
        return {reason: 'ORDINARY_VOLUME_PRESERVED'}
      }
      if (value.chunk.compteurId === stream.compteurId && value.chunk.calculationStrategy === 'GENERIC') {
        if (!stream.supersedeSameMeter) return {reason: 'SAME_CONSUMPTION_REPLACEMENT_NOT_VALIDATED'}
        if (value.periodStart < start.observedAt || value.periodEnd > end.observedAt) return {reason: 'PARTIAL_ORDINARY_OVERLAP'}
        if (replacements.some(replacement => replacement.value.id === value.id)) return {reason: 'AMBIGUOUS_ORDINARY_SCOPE'}
        replacements.push({value, exploitationId: group.exploitation.id})
        continue
      }
      if (!value.chunk.compteurId || value.chunk.compteurId === stream.compteurId || !group.additive) return {reason: 'UNRESOLVED_VOLUME_CONFLICT'}
      // A different physical meter is additive only when both allocations have
      // an explicit, effective additive validation for this exploitation.
      const additive = await tx.meterAllocationVersion.findFirst({
        where: {
          enabled: true, additive: true, startDate: {lte: start.observedAt},
          OR: [{endDate: null}, {endDate: {gte: end.observedAt}}],
          allocation: {compteurId: value.chunk.compteurId, exploitationId: group.exploitation.id}
        }
      })
      if (!additive) return {reason: 'ADDITIVE_NOT_VALIDATED'}
    }
  }
  return {replacements}
}

async function archiveOrdinaryValues(tx, replacements, publication, valueByExploitation) {
  const sourceIds = []
  for (const {value, exploitationId} of replacements) {
    const replacement = valueByExploitation.get(exploitationId)
    await tx.chunkValueReplacement.create({data: {
      replacedChunkValueId: value.id, replacedChunkId: value.chunkId, replacedSourceId: value.chunk.sourceId,
      replacementChunkValueId: replacement.id, replacementChunkId: replacement.chunkId,
      replacementSourceId: publication.sourceId, pointPrelevementId: value.chunk.pointPrelevementId,
      metricTypeCode: value.metricTypeCode, unit: value.unit, frequency: value.frequency,
      periodStart: value.periodStart, periodEnd: value.periodEnd, valueKind: value.valueKind, value: value.value,
      conflictPolicy: 'METER_KNOWN_SAME_CONSUMPTION', replaceComment: 'Remplacement explicitement validé de la même consommation sur un compteur identifié.',
      metadata: {meterPublicationId: publication.id, compteurId: value.chunk.compteurId}
    }})
    // Only ordinary values can be replaced. Meter provenance is FK-protected
    // and historical meter publications are rejected, never deleted.
    await tx.chunkValue.delete({where: {id: value.id}})
    sourceIds.push(value.chunk.sourceId)
  }
  await refreshVolumeMetadataForSourceIds(sourceIds, tx)
}

function publicationIdentity(stream, start, end, plan) {
  return meterHash({
    streamId: stream.id, startRevisionId: start.currentRevisionId, endRevisionId: end.currentRevisionId,
    allocationSnapshot: plan.allocationSnapshot,
    groups: plan.groups.map(group => ({
      exploitationId: group.exploitation.id,
      usageId: group.exploitation.usageId,
      versions: group.shares.map(share => share.version.id).sort()
    })).sort((a, b) => a.exploitationId.localeCompare(b.exploitationId))
  })
}

async function publishInterval(tx, stream, start, end, plan, publicationKey, replacements) {
  const existing = await tx.meterPublication.findUnique({where: {publicationKey}, include: {contributions: {include: {chunkValue: true, allocationVersion: {include: {allocation: true}}}}}})
  let publication
  const valueByExploitation = new Map()
  if (existing) {
    publication = await tx.meterPublication.update({where: {id: existing.id}, data: {active: true, supersededAt: null}})
    await tx.chunk.updateMany({where: {sourceId: publication.sourceId}, data: {instructionStatus: 'AUTOMATICALLY_VALIDATED'}})
    await tx.source.update({where: {id: publication.sourceId}, data: {status: 'COMPLETED', globalInstructionStatus: 'VALIDATED'}})
    for (const contribution of existing.contributions) valueByExploitation.set(contribution.allocationVersion.allocation.exploitationId, contribution.chunkValue)
  } else {
    const source = await tx.source.create({data: {
      type: 'API', status: 'COMPLETED', globalInstructionStatus: 'VALIDATED',
      metadata: {provider: stream.provider, scope: stream.scope, meterStreamId: stream.id, calculationStrategy: 'METER'}
    }})
    publication = await tx.meterPublication.create({data: {
      publicationKey, streamId: stream.id, compteurId: stream.compteurId,
      startRevisionId: start.currentRevisionId, endRevisionId: end.currentRevisionId,
      periodStart: start.observedAt, periodEnd: end.observedAt,
      physicalVolume: decimalString(plan.physicalVolume), inScopeVolume: decimalString(plan.inScopeVolume),
      outOfScopeVolume: decimalString(plan.outOfScopeVolume), allocationSnapshot: plan.allocationSnapshot,
      sourceId: source.id
    }})
    for (const group of plan.groups) {
      const exploitation = group.exploitation
      const chunk = await tx.chunk.create({data: {
        sourceId: source.id, compteurId: stream.compteurId, calculationStrategy: 'METER',
        exploitationId: exploitation.id,
        pointPrelevementId: exploitation.pointPrelevementId, preleveurUserId: exploitation.declarantUserId,
        usageId: exploitation.usageId, flowType: exploitation.pointPrelevement.flowType,
        instructionStatus: 'AUTOMATICALLY_VALIDATED',
        minDate: start.observedAt, maxDate: end.observedAt,
        metadata: {meterPublicationId: publication.id, exploitationId: exploitation.id},
        parsingInfo: {provider: stream.provider}
      }})
      const value = await tx.chunkValue.create({data: {
        chunkId: chunk.id, metricTypeCode: 'volume', unit: 'm³', frequency: 'irregular',
        periodStart: start.observedAt, periodEnd: end.observedAt,
        valueKind: 'COMPUTED', value: decimalString(group.volume)
      }})
      valueByExploitation.set(exploitation.id, value)
      await tx.meterVolumeContribution.createMany({data: group.shares.map(share => ({
        publicationId: publication.id, allocationVersionId: share.version.id,
        chunkValueId: value.id, volume: decimalString(share.volume)
      }))})
    }
  }
  await archiveOrdinaryValues(tx, replacements, publication, valueByExploitation)
  await refreshVolumeMetadataForSourceIds([publication.sourceId], tx)
  await refreshSourceDeclarantsLastDeclarationAt(publication.sourceId, {client: tx})
  return publication
}

// Cursor pages preserve the predecessor, including inadmissible observations:
// crossing a page boundary must never bridge an invalid reading.
export async function* meterReadingIntervals(client, compteurId, {pageSize = 1000} = {}) {
  let cursor
  let previous
  while (true) {
    const readings = await client.meterReading.findMany({
      where: {compteurId}, include: {currentRevision: true},
      orderBy: [{observedAt: 'asc'}, {id: 'asc'}], take: pageSize,
      ...(cursor ? {cursor: {id: cursor}, skip: 1} : {})
    })
    for (const reading of readings) {
      if (previous) yield [previous, reading]
      previous = reading
    }
    if (readings.length < pageSize) return
    cursor = readings.at(-1).id
  }
}

export async function reprocessMeterStreamInTransaction(tx, streamOrId, {from, to, contained = false, preserveOrdinary = false} = {}) {
  let stream = streamOrId
  if (typeof streamOrId === 'string') {
    stream = await tx.meterStream.findUnique({where: {id: streamOrId}})
    if (!stream) throw createHttpError(404, 'Flux compteur introuvable.')
    await lockMeter(tx, stream.compteurId)
    stream = await tx.meterStream.findUnique({where: {id: streamOrId}})
  }
  const allocations = await tx.meterAllocation.findMany({
    where: {compteurId: stream.compteurId, provider: stream.provider, scope: stream.scope},
    include: {versions: true, exploitation: {include: {pointPrelevement: true}}}
  })
  const pointIds = [...new Set(allocations.map(allocation => allocation.exploitation.pointPrelevementId))].sort()
  for (const pointId of pointIds) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('volumes-from-index'), hashtext(${pointId}))`
  let published = 0
  let conflicts = 0
  const issues = new Set()
  const intervals = {examined: 0, unchanged: 0, blocked: 0, reasons: {}}
  const block = reason => {
    intervals.blocked++
    intervals.reasons[reason] = (intervals.reasons[reason] ?? 0) + 1
  }
  for await (const [start, end] of meterReadingIntervals(tx, stream.compteurId)) {
    if ((from && end.observedAt < from) || (to && start.observedAt > to)) continue
    if (contained && ((from && start.observedAt < from) || (to && end.observedAt > to))) continue
    intervals.examined++
    const plan = planMeterInterval(start, end, stream, allocations)
    const active = await tx.meterPublication.findMany({where: {
      compteurId: stream.compteurId, active: true, periodStart: {lt: end.observedAt}, periodEnd: {gt: start.observedAt}
    }})
    if (contained && active.some(publication => publication.streamId !== stream.id
      || (from && publication.periodStart < from) || (to && publication.periodEnd > to))) {
      block('PUBLICATION_OUTSIDE_REPLAY_SCOPE')
      issues.add('PUBLICATION_OUTSIDE_REPLAY_SCOPE')
      conflicts++
      continue
    }
    const key = plan.reason ? null : publicationIdentity(stream, start, end, plan)
    if (active.length === 1 && active[0].publicationKey === key) {
      intervals.unchanged++
      continue
    }
    await supersedePublications(tx, active)
    if (plan.reason) {
      block(plan.reason)
      if (plan.reason !== 'NOT_ACTIVATED') issues.add(plan.reason)
      continue
    }
    const conflictResult = await collectConflicts(tx, stream, start, end, plan, {preserveOrdinary})
    if (conflictResult.reason) {
      block(conflictResult.reason)
      issues.add(conflictResult.reason)
      conflicts++
      continue
    }
    await publishInterval(tx, stream, start, end, plan, key, conflictResult.replacements)
    published++
  }
  return {published, conflicts, issues: [...issues], intervals}
}

// Used after a committed import/allocation change; the same meter lock and
// atomic supersession rules apply as for ingestion.
export async function reprocessMeterStream(streamId, {client = prisma} = {}) {
  return client.$transaction(async tx => {
    const stream = await tx.meterStream.findUnique({where: {id: streamId}})
    if (!stream) throw createHttpError(404, 'Flux compteur introuvable.')
    await lockMeter(tx, stream.compteurId)
    const result = await reprocessMeterStreamInTransaction(tx, stream)
    await tx.meterStream.update({where: {id: stream.id}, data: {lastIssue: result.issues.join(',') || null}})
    return result
  }, {timeout: 120_000, maxWait: 20_000})
}
