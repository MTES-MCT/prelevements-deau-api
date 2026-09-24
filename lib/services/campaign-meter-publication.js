/* eslint-disable no-await-in-loop -- Physical observations and their allocations are reviewed and published under one meter lock. */
import createHttpError from 'http-errors'
import {Prisma} from '@prisma/client'
import {prisma} from '../../db/prisma.js'
import {assertCampaignAdmin, runCollectionTransaction} from './collection-campaigns.js'
import {meterHash, meterBusinessDateBoundary, validateAllocationSnapshot, scaledDecimal} from './meter-core.js'
import {lockMeter, lockMeterPublicationPoints, reprocessMeterStreamInTransaction} from './meter-publication.js'
import {persistMeterReadingInTransaction} from './meter-ingestion.js'
import {refreshVolumeMetadataForSourceIds} from './volume-totals.js'
import {reconstructVolumesFromIndexInTransaction} from './volumes-from-index.js'
import {CAMPAIGN_MANUAL_PROVIDER, CAMPAIGN_READING_DATES, campaignMeterReadings, campaignMeterFingerprint, campaignIndexFingerprint} from './campaign-readings.js'

const periodKeys = ['offSeason', 'season']
const boundaries = CAMPAIGN_READING_DATES.map(date => meterBusinessDateBoundary(date))

async function loadReview(client, campaignId, compteurId) {
  const campaign = await client.collectionCampaign.findUnique({where: {id: campaignId}})
  const meter = await client.compteur.findUnique({where: {id: compteurId}})
  if (!campaign || !meter || meter.deletedAt) throw createHttpError(404, 'Campagne ou compteur introuvable.')
  const allResponses = await client.collectionResponse.findMany({where: {campaignId},
    include: {exploitation: {include: {pointPrelevement: true, declarant: {include: {user: true}}}}}})
  const responses = allResponses.filter(response => response.submittedData?.meters?.some(row => row.compteurId === compteurId))
  if (!responses.length) throw createHttpError(404, 'Ce compteur n’a pas de réponse soumise dans cette campagne.')
  if (responses.some(response => response.preleveurUserId !== response.exploitation.declarantUserId
    || response.exploitation.declarant.user.deletedAt || response.exploitation.pointPrelevement.deletedAt
    || response.exploitation.pointPrelevement.collectionMode === 'EXTERNAL')) {
    throw createHttpError(409, 'Le propriétaire ou la disponibilité d’une exploitation a changé. Faites vérifier les réponses avant de publier.')
  }
  const links = await client.meterAllocation.findMany({where: {compteurId}, include: {versions: true,
    exploitation: {include: {pointPrelevement: true, declarant: {include: {user: true}}}}}})
  const exploitations = new Map(links.map(link => [link.exploitationId, link.exploitation]))
  for (const response of responses) exploitations.set(response.exploitationId, response.exploitation)
  const streams = await client.meterStream.findMany({where: {compteurId}})
  const foreignStreams = streams.filter(stream => stream.provider !== CAMPAIGN_MANUAL_PROVIDER || stream.scope !== campaignId)
  const beneficiaries = [...exploitations.values()].sort((a, b) => a.id.localeCompare(b.id)).map(exploitation => {
    const response = responses.find(row => row.exploitationId === exploitation.id)
    const meterResponse = response?.submittedData.meters.find(row => row.compteurId === compteurId)
    return {exploitationId: exploitation.id, responseId: response?.id ?? null,
      revision: response?.revision ?? null, countingCode: exploitation.countingCode,
      pointName: exploitation.pointPrelevement.usageName || exploitation.pointPrelevement.name,
      preleveurName: exploitation.declarant.socialReason || [exploitation.declarant.user.firstName, exploitation.declarant.user.lastName].filter(Boolean).join(' '),
      inCampaign: allResponses.some(row => row.exploitationId === exploitation.id),
      submitted: Boolean(response), meter: meterResponse ?? null}
  })
  const hash = meterHash(JSON.parse(JSON.stringify({campaignId, compteurId, campaignStatus: campaign.status,
    responses: responses.map(response => ({id: response.id, revision: response.revision,
      preleveurUserId: response.preleveurUserId, ownerUserId: response.exploitation.declarantUserId,
      exploitationStart: response.exploitation.startDate, exploitationEnd: response.exploitation.endDate,
      exploitationStatus: response.exploitation.status,
      fingerprint: campaignMeterFingerprint(response.submittedData.meters.find(row => row.compteurId === compteurId))})).sort((a, b) => a.id.localeCompare(b.id)),
    links: links.map(link => ({id: link.id, exploitationId: link.exploitationId, versions: link.versions})).sort((a, b) => a.id.localeCompare(b.id)), streams})))
  return {campaign, meter, responses, links, streams, foreignStreams, beneficiaries, expectedHash: hash}
}

export async function getCampaignMeterReview({user, campaignId, compteurId}, {client = prisma} = {}) {
  assertCampaignAdmin(user)
  const review = await loadReview(client, campaignId, compteurId)
  const blockedReasons = []
  if (review.foreignStreams.length) blockedReasons.push('Ce compteur possède déjà un autre flux. Sa publication ne peut pas être remplacée depuis la campagne.')
  if (review.beneficiaries.some(row => row.inCampaign && !row.submitted)) blockedReasons.push('Une réponse soumise est nécessaire pour chacune des exploitations bénéficiaires de la campagne.')
  const indexKeys = review.beneficiaries.filter(row => row.meter).map(row => campaignIndexFingerprint(row.meter))
  return {compteurId, serialNumber: review.meter.serialNumber, expectedHash: review.expectedHash,
    periods: [{key: 'offSeason', start: CAMPAIGN_READING_DATES[0], end: CAMPAIGN_READING_DATES[1]},
      {key: 'season', start: CAMPAIGN_READING_DATES[1], end: CAMPAIGN_READING_DATES[2]}],
    beneficiaries: review.beneficiaries, contradictoryReadings: new Set(indexKeys).size > 1,
    canApprove: blockedReasons.length === 0 && review.campaign.status !== 'ARCHIVED', blockedReasons}
}

export async function invalidateCampaignMeterPublication(tx, campaignId, compteurId) {
  const streams = await tx.meterStream.findMany({where: {provider: CAMPAIGN_MANUAL_PROVIDER, scope: campaignId, compteurId}})
  if (!streams.length) return
  const ids = streams.map(stream => stream.id)
  const publications = await tx.meterPublication.findMany({where: {streamId: {in: ids}, active: true}})
  const sourceIds = publications.map(publication => publication.sourceId)
  await tx.meterStream.updateMany({where: {id: {in: ids}}, data: {enabled: false, lastIssue: 'COLLECTION_REVIEW_REQUIRED'}})
  await tx.meterAllocationVersion.updateMany({where: {allocation: {provider: CAMPAIGN_MANUAL_PROVIDER, scope: campaignId, compteurId}}, data: {enabled: false}})
  if (sourceIds.length) {
    await tx.meterPublication.updateMany({where: {id: {in: publications.map(publication => publication.id)}}, data: {active: false, supersededAt: new Date()}})
    await tx.chunk.updateMany({where: {sourceId: {in: sourceIds}}, data: {instructionStatus: 'REJECTED'}})
    await tx.source.updateMany({where: {id: {in: sourceIds}}, data: {globalInstructionStatus: 'REJECTED'}})
    await refreshVolumeMetadataForSourceIds(sourceIds, tx)
  }
  const responses = await tx.collectionResponse.findMany({where: {campaignId, firstSubmittedAt: {not: null}}})
  for (const response of responses.filter(row => row.submittedData?.meters?.some(meter => meter.compteurId === compteurId))) {
    const issues = (response.publicationIssues ?? []).filter(issue => issue.compteurId !== compteurId)
    issues.push({code: 'METER_REVIEW_REQUIRED', compteurId, message: 'Les index ou les usages ont changé. Les volumes attendent une nouvelle validation.'})
    await tx.collectionResponse.update({where: {id: response.id}, data: {publicationStatus: 'PENDING_REVIEW', publicationIssues: issues}})
  }
}

function validateApproval(body, review) {
  if (body.confirmHistorical !== true || body.expectedHash !== review.expectedHash) {
    throw createHttpError(409, 'Confirmez la période historique et rechargez les données de validation si elles ont changé.')
  }
  if (review.campaign.status === 'ARCHIVED' || review.foreignStreams.length) throw createHttpError(409, 'Ce compteur ne peut pas être publié depuis cette campagne.')
  if (!Array.isArray(body.allocations) || body.allocations.length !== review.beneficiaries.length
    || review.beneficiaries.some(row => row.inCampaign && !row.submitted)
    || new Set(body.allocations.map(row => row.exploitationId)).size !== body.allocations.length
    || body.allocations.some(row => !review.beneficiaries.some(target => target.exploitationId === row.exploitationId))) {
    throw createHttpError(400, 'La répartition doit couvrir exactement les exploitations bénéficiaires ayant soumis une réponse.')
  }
  for (const key of periodKeys) {
    try {
      validateAllocationSnapshot(body.allocations.map(row => ({key: row.exploitationId,
        percentage: String(row[`${key}Percentage`]), inScope: review.beneficiaries.some(target => target.exploitationId === row.exploitationId && target.submitted)})), true)
    } catch {
      throw createHttpError(400, 'Pour chaque période, les pourcentages doivent totaliser exactement 100 %.')
    }
  }
  const candidates = review.beneficiaries.filter(row => row.meter).map(row => ({...row, fingerprint: campaignIndexFingerprint(row.meter)}))
  const canonical = body.canonicalResponseId ? candidates.find(row => row.responseId === body.canonicalResponseId) : candidates[0]
  if (!canonical || (new Set(candidates.map(row => row.fingerprint)).size > 1 && !body.canonicalResponseId)) {
    throw createHttpError(409, 'Les index diffèrent entre les réponses. Choisissez explicitement la réponse de référence après vérification.')
  }
  const readings = campaignMeterReadings(canonical.meter)
  if (readings.some((row, index) => index > 0 && scaledDecimal(row.value) < scaledDecimal(readings[index - 1].value))) throw createHttpError(400, 'Un index ne peut pas diminuer.')
  for (const row of body.allocations) {
    const response = review.responses.find(item => item.exploitationId === row.exploitationId)
    if (response?.submittedData.meters.length > 1 && row.additive !== true) throw createHttpError(400, 'Confirmez le cumul avec les autres compteurs de cette exploitation.')
  }
  return readings
}

function approvalFingerprints(review) {
  return review.responses.map(response => ({id: response.id,
    owner: response.exploitation.declarantUserId,
    fingerprint: campaignMeterFingerprint(response.submittedData.meters.find(row => row.compteurId === review.meter.id))
  })).sort((a, b) => a.id.localeCompare(b.id))
}

export async function approveCampaignMeter({user, campaignId, compteurId, body}, {client = prisma, now = new Date()} = {}) {
  assertCampaignAdmin(user)
  if (!body || typeof body !== 'object' || !/^[a-f0-9]{64}$/.test(body.expectedHash ?? '') || !Array.isArray(body.allocations)) {
    throw createHttpError(400, 'La version de la revue et les répartitions sont obligatoires.')
  }
  return runCollectionTransaction(client, async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('collection-campaign'), hashtext(${campaignId}))`
    await lockMeter(tx, compteurId)
    await lockMeterPublicationPoints(tx, [compteurId])
    const review = await loadReview(tx, campaignId, compteurId)
    const batchId = `approval:${compteurId}:${body.expectedHash}`
    const previous = await tx.meterIngestion.findUnique({where: {provider_scope_batchId: {
      provider: CAMPAIGN_MANUAL_PROVIDER, scope: campaignId, batchId}}})
    if (previous) {
      if (previous.result?.bodyHash !== meterHash(body)
        || meterHash(previous.result?.fingerprints) !== meterHash(approvalFingerprints(review))
        || review.foreignStreams.length
        || !review.streams.some(stream => stream.enabled && stream.provider === CAMPAIGN_MANUAL_PROVIDER)
        || await tx.meterPublication.count({where: {compteurId, active: true, stream: {provider: CAMPAIGN_MANUAL_PROVIDER, scope: campaignId}}}) !== 2) {
        throw createHttpError(409, 'Cette validation a changé. Rechargez la revue avant de poursuivre.')
      }
      return previous.result.publicationResult
    }
    const readings = validateApproval(body, review)
    await invalidateCampaignMeterPublication(tx, campaignId, compteurId)
    let stream = await tx.meterStream.findUnique({where: {provider_scope_externalId: {
      provider: CAMPAIGN_MANUAL_PROVIDER, scope: campaignId, externalId: compteurId}}})
    if (!stream) stream = await tx.meterStream.create({data: {provider: CAMPAIGN_MANUAL_PROVIDER, scope: campaignId,
      externalId: compteurId, compteurId, enabled: false}})
    const allocations = []
    for (const input of body.allocations) {
      const sourceId = `collection:${campaignId}:${input.exploitationId}:${compteurId}`
      const allocation = await tx.meterAllocation.upsert({where: {sourceId}, update: {}, create: {
        sourceId, provider: CAMPAIGN_MANUAL_PROVIDER, scope: campaignId, compteurId, exploitationId: input.exploitationId
      }, include: {versions: true}})
      allocations.push({input, allocation})
    }
    for (const [index, key] of periodKeys.entries()) {
      const snapshot = allocations.map(({input, allocation}) => ({key: allocation.sourceId,
        percentage: String(input[`${key}Percentage`]), inScope: review.responses.some(response => response.exploitationId === input.exploitationId)}))
      for (const {input, allocation} of allocations) {
        const response = review.responses.find(row => row.exploitationId === input.exploitationId)
        if (!response) continue
        const meter = response.submittedData.meters.find(row => row.compteurId === compteurId)
        await tx.meterAllocationVersion.create({data: {allocationId: allocation.id,
          version: Math.max(0, ...allocation.versions.map(version => version.version)) + index + 1,
          enabled: true, additive: input.additive === true, percentage: String(input[`${key}Percentage`]),
          usageId: meter[key].usageId, startDate: boundaries[index], endDate: boundaries[index + 1],
          metadata: {allocationSnapshot: snapshot, allocationSnapshotValidated: true, preserveOrdinary: true,
            collectionResponseId: response.id, submittedHash: response.submittedHash, approvalHash: body.expectedHash,
            historicalPublication: {reference: `collection:${campaignId}`, confirmedBy: user.id,
              confirmedAt: now.toISOString(), from: boundaries[index].toISOString(), to: boundaries[index + 1].toISOString()}}
        }})
      }
    }
    // Receipt index values remain visible but never calculate the shared physical volume.
    const receipts = await tx.chunk.findMany({where: {compteurId, metadata: {path: ['collectionCampaignId'], equals: campaignId}}, select: {id: true, sourceId: true, pointPrelevementId: true, metadata: true}})
    for (const receipt of receipts) await tx.chunk.update({where: {id: receipt.id}, data: {
      autoCalculateVolumes: false, metadata: {...receipt.metadata, physicalMeterRequired: true}
    }})
    await tx.chunkValue.deleteMany({where: {chunkId: {in: receipts.map(row => row.id)}, valueKind: 'COMPUTED'}})
    for (const pointId of [...new Set(receipts.map(row => row.pointPrelevementId))].sort()) await reconstructVolumesFromIndexInTransaction(tx, pointId)
    stream = await tx.meterStream.update({where: {id: stream.id}, data: {enabled: true, activatedAt: stream.activatedAt ?? now,
      allocationSnapshotValidated: true, lastIssue: null}})
    const ingestion = await tx.meterIngestion.create({data: {provider: CAMPAIGN_MANUAL_PROVIDER, scope: campaignId,
      batchId, actorUserId: user.id, mode: 'OFFLINE', fetchedAt: now,
      windowStart: boundaries[0], windowEnd: boundaries[2], payloadHash: meterHash(readings),
      rawPayload: {responseIds: review.responses.map(row => row.id), approvalHash: body.expectedHash, readings},
      result: {approvedBy: user.id, bodyHash: meterHash(body), fingerprints: approvalFingerprints(review),
        canonicalResponseId: body.canonicalResponseId ?? review.beneficiaries.find(row => row.submitted).responseId}}})
    const counts = {unchanged: 0, accepted: 0, blocked: 0}
    for (const [index, reading] of readings.entries()) {
      await persistMeterReadingInTransaction(tx, {stream, raw: {responseIds: review.responses.map(row => row.id), date: reading.date},
        normalized: {observedAt: boundaries[index], index: String(reading.value), admissible: true, quality: 'APPROVED', origin: 'COLLECTION', reason: null}}, ingestion, counts)
    }
    const result = await reprocessMeterStreamInTransaction(tx, stream, {from: boundaries[0], to: boundaries[2], contained: true, preserveOrdinary: true})
    await tx.meterStream.update({where: {id: stream.id}, data: {lastIssue: result.issues.join(',') || null, lastSuccessAt: now}})
    const publications = await tx.meterPublication.findMany({where: {streamId: stream.id, active: true}, select: {id: true, sourceId: true}})
    for (const response of review.responses) {
      const issues = (response.publicationIssues ?? []).filter(issue => issue.compteurId !== compteurId)
      if (result.conflicts || result.issues.length || publications.length !== 2) issues.push({code: 'PUBLICATION_CONFLICT', compteurId,
        message: 'La publication est bloquée par une donnée ou un rattachement existant.'})
      await tx.collectionResponse.update({where: {id: response.id}, data: {publicationStatus: issues.length ? 'PENDING_REVIEW' : 'PUBLISHED', publicationIssues: issues}})
      await tx.source.updateMany({where: {declarationId: response.declarationId}, data: {updatedAt: now}})
    }
    const publicationResult = {published: publications.length, status: publications.length === 2 && !result.conflicts ? 'PUBLISHED' : 'PENDING_REVIEW', issues: result.issues}
    await tx.meterIngestion.update({where: {id: ingestion.id}, data: {result: {...ingestion.result, publicationResult}}})
    return publicationResult
  }, {isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 20_000, timeout: 120_000})
}
