import {randomUUID} from 'node:crypto'
import createError from 'http-errors'
import {campaignDate, calculateCampaignIndexTotals, loadCampaignExistingReadings} from './campaign-index.js'
import {
  classifyCampaignVolumeConflicts,
  findConflictingChunkValuesForIncomingChunkValues,
  refreshReplacedSourcesAfterConflict,
  supersedeCampaignVolumeConflicts
} from './chunk-value-conflicts.js'
import {refreshVolumeMetadataForSourceIds} from './volume-totals.js'

export {loadCampaignExistingReadings} from './campaign-index.js'

const overlaps = (a, b) => a.periodStart < b.periodEnd && a.periodEnd > b.periodStart

function baseChunk({target, sourceId, actorDeclarant, submission, campaign}) {
  const periods = campaign.periods.filter(period => period.kind === 'INDEX')
  return {
    id: randomUUID(),
    sourceId,
    pointPrelevementId: target.pointPrelevementId,
    preleveurUserId: target.preleveurUserId,
    submittedByDeclarantUserId: actorDeclarant?.userId ?? null,
    collecteurUserId: actorDeclarant?.declarantRole === 'COLLECTEUR' ? actorDeclarant.userId : null,
    usageId: target.usageId,
    flowType: target.flowType ?? 'PRELEVEMENT',
    calculationStrategy: 'CAMPAIGN',
    instructionStatus: 'VALIDATED',
    instructedAt: new Date(),
    parsingInfo: {},
    minDate: new Date(Math.min(...periods.map(period => new Date(period.startDate).getTime()))),
    maxDate: new Date(Math.max(...periods.map(period => new Date(period.endDate).getTime()))),
    metadata: {campaignId: campaign.id, submissionId: submission.id, targetId: target.id, calculationStrategy: 'CAMPAIGN'}
  }
}

/** Prépare les conflits sans écraser ni découper un intervalle ancien. */
export function planCampaignVolumePublication({totals, conflicts, coverages = []}) {
  let planned = totals.map(total => {
    const unattributed = conflicts.filter(conflict => conflict.preleveurUserId === null && overlaps(total, conflict))
    return unattributed.length > 0
      ? {
        ...total,
        computedValue: total.value,
        value: null,
        status: 'CONFLICT',
        conflicts: [...total.conflicts, ...unattributed.map(conflict => ({code: 'AMBIGUOUS_VOLUME_OWNER', chunkValueId: conflict.chunkValueId}))]
      }
      : total
  })
  // Une période bloquée peut rendre partiel un ancien intervalle qui couvrait
  // plusieurs périodes. Propagation jusqu'à un ensemble entièrement remplaçable.
  for (let iteration = 0; iteration < totals.length; iteration++) {
    const publishable = planned.filter(total => total.status !== 'CONFLICT')
    const {partial} = classifyCampaignVolumeConflicts({conflicts: [...conflicts, ...coverages], periods: publishable})
    if (partial.length === 0) {
      break
    }

    planned = planned.map(total => {
      const blocked = total.status === 'CONFLICT' ? [] : partial.filter(conflict => overlaps(total, conflict))
      return blocked.length > 0
        ? {
          ...total,
          computedValue: total.value,
          value: null,
          status: 'CONFLICT',
          conflicts: [...total.conflicts, ...blocked.map(conflict => ({
            code: 'PARTIAL_VOLUME_OVERLAP',
            chunkValueId: conflict.chunkValueId ?? null,
            coverageId: conflict.submissionId ? conflict.id : null,
            periodStart: conflict.periodStart,
            periodEnd: conflict.periodEnd
          }))]
        }
        : total
    })
  }

  return planned
}

async function writeDeclaredReadings({submission, campaign, target, sourceId, actorDeclarant, client, existingReadings}) {
  const readings = submission.snapshot.readings.filter(reading => reading.targetId === target.id
    && !reading.sourceChunkValueId && reading.value !== null && reading.value !== undefined && reading.value !== '')
  const readingsByMeter = Map.groupBy(readings, reading => reading.compteurId)
  const references = submission.snapshot.readings.filter(reading => reading.targetId === target.id && reading.sourceChunkValueId)
    .map(reading => ({targetId: target.id, compteurId: reading.compteurId, readingDate: reading.readingDate, chunkValueId: reading.sourceChunkValueId, sourceValueUpdatedAt: reading.sourceValueUpdatedAt}))
  for (const [compteurId, meterReadings] of readingsByMeter) {
    const chunk = baseChunk({target, sourceId, actorDeclarant, submission, campaign})
    const values = meterReadings.map(reading => ({
      id: randomUUID(),
      metricTypeCode: 'index',
      frequency: 'instant',
      unit: 'm³',
      valueKind: 'DECLARED',
      value: reading.value,
      createdAt: new Date(),
      updatedAt: new Date(),
      readingDate: new Date(`${campaignDate(reading.readingDate)}T00:00:00.000Z`),
      periodStart: new Date(`${campaignDate(reading.readingDate)}T00:00:00.000Z`),
      periodEnd: new Date(new Date(`${campaignDate(reading.readingDate)}T00:00:00.000Z`).getTime() + (15 * 60_000))
    }))
    chunk.minDate = new Date(Math.min(...values.map(value => value.periodStart.getTime())))
    chunk.maxDate = new Date(Math.max(...values.map(value => value.periodEnd.getTime())))
    // eslint-disable-next-line no-await-in-loop
    await client.chunk.create({data: {...chunk, compteurId, chunkValues: {create: values}}})
    for (const [index, reading] of meterReadings.entries()) {
      references.push({targetId: target.id, compteurId, readingDate: reading.readingDate, chunkValueId: values[index].id, sourceValueUpdatedAt: values[index].updatedAt})
      if (reading.correctionOfChunkValueId) {
        const old = existingReadings.find(value => value.id === reading.correctionOfChunkValueId)
        // La mesure précédente reste canonique et accessible dans l'historique.
        // eslint-disable-next-line no-await-in-loop
        await client.chunkValueReplacement.create({data: {
          replacedChunkValueId: old.id,
          replacedChunkId: old.chunkId,
          replacedSourceId: old.chunk.sourceId,
          replacementChunkValueId: values[index].id,
          replacementChunkId: chunk.id,
          replacementSourceId: sourceId,
          pointPrelevementId: target.pointPrelevementId,
          metricTypeCode: old.metricTypeCode,
          unit: old.unit,
          frequency: old.frequency,
          periodStart: old.periodStart,
          periodEnd: old.periodEnd,
          valueKind: old.valueKind,
          value: old.value,
          conflictPolicy: 'CAMPAIGN_READING_CORRECTION',
          replaceComment: reading.correctionReason,
          metadata: {campaignId: campaign.id, submissionId: submission.id, actorUserId: submission.createdByUserId}
        }})
      }
    }
  }

  return references
}

async function writeMeterEventReadings({submission, campaign, target, sourceId, actorDeclarant, client, readingReferences}) {
  const references = []
  for (const event of (submission.snapshot.meterEvents ?? []).filter(event => event.targetId === target.id)) {
    const eventReferences = {targetId: target.id, type: event.type, at: event.at}
    for (const phase of ['previous', 'next']) {
      const compteurId = phase === 'previous' || event.type === 'RESET' ? event.previousCompteurId : event.nextCompteurId
      const value = phase === 'previous' ? event.previousIndex : event.nextIndex
      if (value === null) {
        eventReferences[phase] = {compteurId, chunkValueId: null, missingReason: event[`${phase}MissingReason`] || event.reason}
        continue
      }

      const sameReading = submission.snapshot.readings.find(reading => reading.targetId === target.id && reading.compteurId === compteurId
        && reading.readingDate === event.at && String(reading.value) === String(value))
      const reused = sameReading && readingReferences.find(reference => reference.targetId === target.id && reference.compteurId === compteurId && reference.readingDate === event.at)
      if (reused) {
        eventReferences[phase] = reused
        continue
      }

      const eventMetadata = {type: event.type, phase, at: event.at, previousCompteurId: event.previousCompteurId, nextCompteurId: event.type === 'RESET' ? event.previousCompteurId : event.nextCompteurId}
      const date = new Date(`${campaignDate(event.at)}T00:00:00.000Z`)
      // Les retransmissions de commentaire réutilisent aussi les index de transition.
      // eslint-disable-next-line no-await-in-loop
      const existing = await client.chunkValue.findMany({where: {
        readingDate: date, metricTypeCode: 'index', valueKind: 'DECLARED', value,
        chunk: {
          pointPrelevementId: target.pointPrelevementId, preleveurUserId: target.preleveurUserId, compteurId,
          calculationStrategy: 'CAMPAIGN', instructionStatus: {not: 'REJECTED'}, source: {status: 'COMPLETED'},
          metadata: {path: ['campaignMeterEvent'], equals: eventMetadata}
        }
      }, select: {id: true, updatedAt: true}, take: 2})
      if (existing.length > 1) {
        throw createError(409, 'Plusieurs relevés de transition correspondent à cet événement.')
      }

      if (existing.length === 1) {
        eventReferences[phase] = {compteurId, chunkValueId: existing[0].id, sourceValueUpdatedAt: existing[0].updatedAt}
        continue
      }

      const chunk = baseChunk({target, sourceId, actorDeclarant, submission, campaign})
      chunk.minDate = date
      chunk.maxDate = date
      const measurement = {
        id: randomUUID(), metricTypeCode: 'index', frequency: 'instant', unit: 'm³', valueKind: 'DECLARED', value,
        readingDate: date, periodStart: date, periodEnd: new Date(date.getTime() + (15 * 60_000)), createdAt: new Date(), updatedAt: new Date()
      }
      // eslint-disable-next-line no-await-in-loop
      await client.chunk.create({data: {...chunk, compteurId, metadata: {...chunk.metadata, campaignMeterEvent: eventMetadata}, chunkValues: {create: [measurement]}}})
      eventReferences[phase] = {compteurId, chunkValueId: measurement.id, sourceValueUpdatedAt: measurement.updatedAt}
    }

    references.push(eventReferences)
  }

  return references
}

/** Appelé uniquement dans la transaction de transmission, après contrôle des droits. */
export async function publishCampaignIndexSubmission({submission, campaign, targets, actorUserId, client}) {
  if (!client || !submission?.id || !actorUserId || actorUserId !== submission.createdByUserId) {
    throw new Error('Contexte transactionnel de publication invalide.')
  }

  for (const pointId of [...new Set(targets.map(target => target.pointPrelevementId))].sort()) {
    // eslint-disable-next-line no-await-in-loop
    await client.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext('volumes-from-index'), hashtext(${pointId}))
    `
  }

  const previousPublication = await client.campaignSubmission.findUnique({where: {id: submission.id}, select: {publication: true}})
  if (previousPublication?.publication) {
    return previousPublication.publication
  }

  const existingReadings = await loadCampaignExistingReadings({campaign, targets, client})
  const calculation = calculateCampaignIndexTotals({campaign, targets, ...submission.snapshot, existingReadings})
  if (!calculation.canSubmit) {
    throw createError(409, 'Les relevés de la campagne doivent être corrigés ou leurs absences justifiées.', {issues: calculation.issues})
  }

  const resolvedSubmission = {...submission, snapshot: {...submission.snapshot, readings: calculation.resolvedReadings}}

  const sourceId = randomUUID()
  const plans = []
  for (const target of targets) {
    const totals = calculation.totals.filter(total => total.targetId === target.id)
    // eslint-disable-next-line no-await-in-loop
    const conflicts = await findConflictingChunkValuesForIncomingChunkValues({
      client, pointPrelevementId: target.pointPrelevementId, preleveurUserId: target.preleveurUserId,
      includeUnattributed: true,
      valueRows: totals.map(total => ({...total, metricTypeCode: 'volume'}))
    })
    // eslint-disable-next-line no-await-in-loop
    const coverages = await client.campaignCoverage.findMany({where: {
      pointPrelevementId: target.pointPrelevementId,
      preleveurUserId: target.preleveurUserId,
      active: true,
      OR: totals.map(total => ({periodStart: {lt: total.periodEnd}, periodEnd: {gt: total.periodStart}}))
    }})
    plans.push({target, conflicts, coverages, totals: planCampaignVolumePublication({totals, conflicts, coverages})})
  }

  const actorDeclarant = await client.declarant.findUnique({where: {userId: actorUserId}, select: {userId: true, declarantRole: true}})
  await client.source.create({data: {
    id: sourceId,
    type: 'BATCH',
    status: 'COMPLETED',
    globalInstructionStatus: 'VALIDATED',
    metadata: {campaignId: campaign.id, submissionId: submission.id, responseId: submission.responseId, submittedByUserId: actorUserId}
  }})
  const coverageIds = []
  const affectedSourceIds = new Set()
  const readingReferences = []
  const meterEventReferences = []
  for (const plan of plans) {
    const {target, conflicts, coverages, totals} = plan
    // eslint-disable-next-line no-await-in-loop
    readingReferences.push(...await writeDeclaredReadings({submission: resolvedSubmission, campaign, target, sourceId, actorDeclarant, client, existingReadings}))
    // eslint-disable-next-line no-await-in-loop
    meterEventReferences.push(...await writeMeterEventReadings({submission: resolvedSubmission, campaign, target, sourceId, actorDeclarant, client, readingReferences}))
    const publishable = totals.filter(total => total.status !== 'CONFLICT')
    if (publishable.length === 0) {
      continue
    }

    const chunk = baseChunk({target, sourceId, actorDeclarant, submission, campaign})
    const valueRows = publishable.filter(total => total.status === 'COMPLETE').map(total => ({
      id: randomUUID(), chunkId: chunk.id, metricTypeCode: 'volume', valueKind: 'COMPUTED',
      unit: 'm³', frequency: 'campaign', periodStart: total.periodStart, periodEnd: total.periodEnd, value: total.value
    }))
    const replacedCoverages = classifyCampaignVolumeConflicts({conflicts: coverages, periods: publishable}).complete
    // eslint-disable-next-line no-await-in-loop
    await client.campaignCoverage.updateMany({where: {id: {in: replacedCoverages.map(coverage => coverage.id)}}, data: {active: false, supersededAt: new Date()}})
    const replacedConflicts = classifyCampaignVolumeConflicts({conflicts, periods: publishable}).complete
    // eslint-disable-next-line no-await-in-loop
    const replacedSources = await supersedeCampaignVolumeConflicts({
      conflicts: replacedConflicts, periods: publishable, valueRows, sourceId,
      metadata: {campaignId: campaign.id, submissionId: submission.id, actorUserId}, client
    })
    for (const id of replacedSources) {
      affectedSourceIds.add(id)
    }

    // eslint-disable-next-line no-await-in-loop
    await client.chunk.create({data: {...chunk, metadata: {...chunk.metadata, exactPeriods: true}, chunkValues: {create: valueRows.map(({chunkId, ...value}) => value)}}})
    for (const total of publishable) {
      const id = randomUUID()
      coverageIds.push(id)
      // eslint-disable-next-line no-await-in-loop
      await client.campaignCoverage.create({data: {
        id,
        submissionId: submission.id,
        targetId: target.id,
        pointPrelevementId: target.pointPrelevementId,
        preleveurUserId: target.preleveurUserId,
        periodId: total.periodId,
        periodStart: total.periodStart,
        periodEnd: total.periodEnd,
        sourceId,
        chunkValueId: valueRows.find(row => row.periodStart.getTime() === total.periodStart.getTime() && row.periodEnd.getTime() === total.periodEnd.getTime())?.id ?? null
      }})
    }
  }

  await refreshReplacedSourcesAfterConflict([...affectedSourceIds], client)
  await refreshVolumeMetadataForSourceIds([sourceId], client)
  // Prisma Json attend des dates sérialisées, et non un clone conservant les Date.
  // eslint-disable-next-line unicorn/prefer-structured-clone
  return JSON.parse(JSON.stringify({sourceId, coverageIds, readingReferences, meterEventReferences, totals: plans.flatMap(plan => plan.totals)}))
}
