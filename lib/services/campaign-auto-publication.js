/* eslint-disable no-await-in-loop -- Publication, receipt flags and summaries must share the campaign and meter locks. */
import createHttpError from 'http-errors'
import {prisma} from '../../db/prisma.js'
import {runCollectionTransaction} from './collection-campaigns.js'
import {CAMPAIGN_MANUAL_PROVIDER, campaignMeterReadings, campaignIndexFingerprint, campaignPublicationIssue, METER_CHANGE_REPORTED} from './campaign-readings.js'
import {CAMPAIGN_VOLUME_BOUNDARIES, campaignAllocationPlans, campaignPublicationCoverage, campaignReadingsMatch} from './campaign-publication-plan.js'
import {meterHash, meterBusinessDateBoundary, planMeterInterval, scaledDecimal} from './meter-core.js'
import {lockMeter, reprocessMeterStreamInTransaction} from './meter-publication.js'
import {lockCampaignMeterPoints} from './campaign-meter-publication.js'
import {persistMeterReadingInTransaction} from './meter-ingestion.js'
import {reconstructVolumesFromIndexInTransaction, INDEX_METRIC_TYPE_CODES} from './volumes-from-index.js'
import {refreshVolumeMetadataForSourceIds} from './volume-totals.js'
import {getCompatibleMetricTypeCodes} from '../constants/metric-type-codes.js'

const includeExploitation = {include: {pointPrelevement: true, declarant: {include: {user: true}}}}
const [periodStart, , periodEnd] = CAMPAIGN_VOLUME_BOUNDARIES
const reasonMessages = {
  ATTACHMENT_REVIEW: 'Le rattachement historique de ce compteur à cette exploitation n’est pas établi.',
  ADDITIVE_NOT_VALIDATED: 'Le cumul des compteurs n’est pas établi pour toute la période déclarée.',
  PROVIDER_READING_COVERAGE: 'Les données du flux existant ne couvrent pas encore les deux périodes avec les trois relevés déclarés. Aucune confirmation administrative ne peut remplacer ces données manquantes.',
  READING_CONFLICT: 'Les index déclarés diffèrent des relevés physiques ou des réponses des autres bénéficiaires.',
  OWNERSHIP_CHANGED: 'Le propriétaire ou la disponibilité de l’exploitation a changé.',
  BENEFICIARY_RESPONSE_MISSING: 'Une réponse soumise manque pour un bénéficiaire de ce compteur dans la campagne.',
  HISTORICAL_ALLOCATION_UNRESOLVED: 'La répartition datée et validée ne couvre pas les deux périodes déclarées.',
  EXISTING_VOLUME: 'Des volumes existants recouvrent cette déclaration sans preuve de cumul : aucun volume supplémentaire n’a été créé.',
  UNIDENTIFIED_HISTORY: 'Des index sans compteur identifié doivent être rapprochés avant le calcul.',
  PUBLICATION_CONFLICT: 'Les relevés ou les répartitions ne permettent pas de publier les deux périodes.'
}

function issue(code, compteurId, detail) {
  return {...campaignPublicationIssue(code, compteurId, reasonMessages[code] ?? reasonMessages.HISTORICAL_ALLOCATION_UNRESOLVED), ...(detail ? {detail} : {})}
}

function validOwner(response) {
  const exploitation = response.exploitation
  return response.preleveurUserId === exploitation.declarantUserId && !exploitation.declarant.user.deletedAt
    && !exploitation.pointPrelevement.deletedAt && exploitation.pointPrelevement.collectionMode !== 'EXTERNAL'
    && ['EN_ACTIVITE', 'NON_RENSEIGNE'].includes(exploitation.status)
    && (!exploitation.startDate || meterBusinessDateBoundary(exploitation.startDate) <= periodStart)
    && (!exploitation.endDate || meterBusinessDateBoundary(exploitation.endDate, true) >= periodEnd)
}

function contributionsMatch(publication, group, response) {
  const contributions = publication.contributions.filter(row => group.shares.some(share => share.version.id === row.allocationVersionId))
  return contributions.length === group.shares.length && contributions.every(row => row.chunkValue.chunk.instructionStatus !== 'REJECTED'
    && row.chunkValue.chunk.source.status === 'COMPLETED' && row.chunkValue.chunk.exploitationId === response.exploitationId
    && row.chunkValue.chunk.preleveurUserId === response.preleveurUserId
    && scaledDecimal(row.volume) === group.shares.find(share => share.version.id === row.allocationVersionId).volume)
}

async function reusablePublications(tx, response, meter, stream, links) {
  const readings = await tx.meterReading.findMany({where: {compteurId: meter.compteurId,
    observedAt: {gte: periodStart, lte: periodEnd}}, include: {currentRevision: true}, orderBy: {observedAt: 'asc'}})
  if (!campaignReadingsMatch(meter, readings)) {
    const hasBoundaries = CAMPAIGN_VOLUME_BOUNDARIES.every(date => readings.some(reading => reading.observedAt.getTime() === date.getTime()))
    return {reason: hasBoundaries ? 'READING_CONFLICT' : 'PROVIDER_READING_COVERAGE'}
  }
  const publications = await tx.meterPublication.findMany({where: {compteurId: meter.compteurId, active: true,
    periodStart: {lt: periodEnd}, periodEnd: {gt: periodStart}}, include: {contributions: {include: {allocationVersion: true,
    chunkValue: {include: {chunk: {include: {source: true}}}}}}}})
  if (!campaignPublicationCoverage(publications)) return {reason: 'PROVIDER_READING_COVERAGE'}
  let additive = true
  for (const publication of publications) {
    const start = readings.find(row => row.observedAt.getTime() === publication.periodStart.getTime())
    const end = readings.find(row => row.observedAt.getTime() === publication.periodEnd.getTime())
    if (!start || !end || readings[readings.indexOf(start) + 1]?.id !== end.id
      || publication.streamId !== stream.id || start.currentRevisionId !== publication.startRevisionId
      || end.currentRevisionId !== publication.endRevisionId) return {reason: 'PUBLICATION_CONFLICT'}
    const plan = planMeterInterval(start, end, stream, links)
    if (plan.reason) return {reason: 'HISTORICAL_ALLOCATION_UNRESOLVED', detail: plan.reason}
    const group = plan.groups.find(row => row.exploitation.id === response.exploitationId)
    if (!group) return {reason: 'ATTACHMENT_REVIEW'}
    additive &&= group.additive
    if (response.submittedData.meters.length > 1 && !group.additive) return {reason: 'ADDITIVE_NOT_VALIDATED'}
    if (meterHash(plan.allocationSnapshot) !== meterHash(publication.allocationSnapshot)
      || scaledDecimal(publication.physicalVolume) !== plan.physicalVolume) return {reason: 'HISTORICAL_ALLOCATION_UNRESOLVED'}
    if (!contributionsMatch(publication, group, response)) return {reason: 'PUBLICATION_CONFLICT'}
  }
  return {publications, additive}
}

async function hasProvenAdditiveAllocation(tx, compteurId, exploitationId) {
  const [allocations, streams] = await Promise.all([
    tx.meterAllocation.findMany({where: {compteurId}, include: {versions: true, exploitation: includeExploitation}}),
    tx.meterStream.findMany({where: {compteurId, enabled: true}})
  ])
  if (streams.length > 1) return false
  const candidates = new Map()
  for (const allocation of allocations) {
    if (streams.length && (allocation.provider !== streams[0].provider || allocation.scope !== streams[0].scope)) continue
    const key = JSON.stringify([allocation.provider, allocation.scope])
    candidates.set(key, [...(candidates.get(key) ?? []), allocation])
  }
  const meter = {offSeason: {indexStart: '0', indexEnd: '0'}, season: {indexEnd: '0'}}
  const stream = streams[0] ?? {id: 'campaign-additive-proof', enabled: true, activatedAt: new Date()}
  return [...candidates.values()].filter(links => !campaignAllocationPlans(meter, stream, links, exploitationId, {additive: true}).reason).length === 1
}

async function conflictingVolume(tx, response, meter, {publicationIds = [], additive = false} = {}) {
  const values = await tx.chunkValue.findMany({where: {metricTypeCode: {in: getCompatibleMetricTypeCodes('volume')},
    periodStart: {lt: periodEnd}, periodEnd: {gt: periodStart}, chunk: {
      pointPrelevementId: response.exploitation.pointPrelevementId,
      OR: [{exploitationId: response.exploitationId}, {exploitationId: null}], instructionStatus: {not: 'REJECTED'},
      source: {status: 'COMPLETED', ...(response.declarationId ? {OR: [{declarationId: null}, {declarationId: {not: response.declarationId}}]} : {})}
    }}, include: {chunk: {include: {source: {select: {meterPublication: {select: {id: true}}}}}}}})
  for (const value of values) {
    if (publicationIds.includes(value.chunk.source.meterPublication?.id)) continue
    if (!additive || !value.chunk.compteurId || value.chunk.compteurId === meter.compteurId || value.chunk.exploitationId !== response.exploitationId) return true
    // Both physical identities need an effective additive version. A current
    // or undated checkbox never proves a historical overlap.
    if (!await hasProvenAdditiveAllocation(tx, value.chunk.compteurId, response.exploitationId)) return true
  }
  return false
}

async function publishFromHistoricalAllocations(tx, {response, meter, links, allResponses}, {now, preview = false}) {
  const candidates = new Map()
  for (const link of links.filter(link => link.provider !== CAMPAIGN_MANUAL_PROVIDER)) {
    const key = JSON.stringify([link.provider, link.scope])
    candidates.set(key, [...(candidates.get(key) ?? []), link])
  }
  const streamPlan = {id: 'campaign-historical-plan', enabled: true, activatedAt: now}
  const plans = [...candidates.values()].map(allocations => ({allocations,
    ...campaignAllocationPlans(meter, streamPlan, allocations, response.exploitationId, {additive: response.submittedData.meters.length > 1})}))
  const valid = plans.filter(plan => !plan.reason)
  if (valid.length !== 1) return {reason: 'HISTORICAL_ALLOCATION_UNRESOLVED', detail: valid.length ? 'AMBIGUOUS_ALLOCATION_SNAPSHOTS' : plans[0]?.reason}
  const selected = valid[0]
  const beneficiaries = [...new Set(selected.plans.flatMap(plan => plan.groups.map(group => group.exploitation.id)))]
  const campaignBeneficiaries = allResponses.filter(row => beneficiaries.includes(row.exploitationId))
  if (campaignBeneficiaries.some(row => !row.firstSubmittedAt || !row.submittedData?.meters?.some(row => row.compteurId === meter.compteurId))) {
    return {reason: 'BENEFICIARY_RESPONSE_MISSING'}
  }
  if (campaignBeneficiaries.some(row => !validOwner(row))) return {reason: 'OWNERSHIP_CHANGED'}
  for (const beneficiary of campaignBeneficiaries) {
    const declared = beneficiary.submittedData.meters.find(row => row.compteurId === meter.compteurId)
    if (declared.meterChanged || campaignIndexFingerprint(declared) !== campaignIndexFingerprint(meter)) return {reason: 'READING_CONFLICT'}
    const allocationPlan = campaignAllocationPlans(declared, streamPlan, selected.allocations, beneficiary.exploitationId,
      {additive: beneficiary.submittedData.meters.length > 1})
    if (allocationPlan.reason) return {reason: 'HISTORICAL_ALLOCATION_UNRESOLVED', detail: allocationPlan.reason}
    if (await conflictingVolume(tx, beneficiary, declared, {additive: allocationPlan.plans.every(plan => plan.groups.find(group => group.exploitation.id === beneficiary.exploitationId).additive)})) {
      return {reason: 'EXISTING_VOLUME'}
    }
  }
  // A supplier observation remains authoritative even if its stream was
  // disabled or removed from the current selection.
  if (await tx.meterReading.count({where: {compteurId: meter.compteurId, revisions: {some: {stream: {
    OR: [{provider: {not: CAMPAIGN_MANUAL_PROVIDER}}, {scope: {not: response.campaignId}}]
  }}}}})) return {reason: 'PROVIDER_READING_COVERAGE'}
  if (preview) return {plannedPublication: true}
  return persistHistoricalPublication(tx, {response, meter, selected, campaignBeneficiaries}, {now})
}

async function persistHistoricalPublication(tx, {response, meter, selected, campaignBeneficiaries}, {now}) {
  // Conflicts discovered by the physical engine must not leave half of the
  // seasons published, nor change the previously active allocation versions.
  await tx.$executeRawUnsafe('SAVEPOINT campaign_auto_publication')
  let stream = await tx.meterStream.upsert({where: {provider_scope_externalId: {
    provider: CAMPAIGN_MANUAL_PROVIDER, scope: response.campaignId, externalId: meter.compteurId}},
  update: {}, create: {provider: CAMPAIGN_MANUAL_PROVIDER, scope: response.campaignId,
    externalId: meter.compteurId, compteurId: meter.compteurId, enabled: false}})
  await tx.meterAllocationVersion.updateMany({where: {enabled: true, allocation: {
    provider: CAMPAIGN_MANUAL_PROVIDER, scope: response.campaignId, compteurId: meter.compteurId}}, data: {enabled: false}})
  const mapped = new Map()
  for (const allocation of selected.allocations) {
    const target = await tx.meterAllocation.upsert({where: {sourceId: `collection-auto:${response.campaignId}:${allocation.id}`},
      update: {}, create: {sourceId: `collection-auto:${response.campaignId}:${allocation.id}`, provider: CAMPAIGN_MANUAL_PROVIDER,
        scope: response.campaignId, compteurId: meter.compteurId, exploitationId: allocation.exploitationId,
        metadata: {authoritativeAllocationId: allocation.id}}, include: {versions: true}})
    mapped.set(allocation.sourceId, target)
  }
  for (const [index, plan] of selected.plans.entries()) {
    const snapshot = plan.allocationSnapshot.map(entry => ({...entry, key: mapped.get(entry.key)?.sourceId ?? entry.key,
      inScope: entry.inScope && campaignBeneficiaries.some(row => row.exploitationId === selected.allocations.find(link => link.sourceId === entry.key)?.exploitationId)}))
    for (const group of plan.groups) {
      const beneficiary = campaignBeneficiaries.find(row => row.exploitationId === group.exploitation.id)
      if (!beneficiary) continue
      for (const share of group.shares) {
        const target = mapped.get(share.key)
        const lastVersion = await tx.meterAllocationVersion.aggregate({where: {allocationId: target.id}, _max: {version: true}})
        await tx.meterAllocationVersion.create({data: {allocationId: target.id, version: (lastVersion._max.version ?? 0) + 1,
          enabled: true, percentage: share.version.percentage, additive: share.version.additive,
          usageId: beneficiary.submittedData.meters.find(row => row.compteurId === meter.compteurId)[index ? 'season' : 'offSeason'].usageId,
          startDate: CAMPAIGN_VOLUME_BOUNDARIES[index], endDate: CAMPAIGN_VOLUME_BOUNDARIES[index + 1],
          metadata: {...share.version.metadata, allocationSnapshot: snapshot, allocationSnapshotValidated: true, preserveOrdinary: true,
            collectionResponseId: beneficiary.id, authoritativeAllocationVersionId: share.version.id}}})
      }
    }
  }
  stream = await tx.meterStream.update({where: {id: stream.id}, data: {enabled: true, activatedAt: stream.activatedAt ?? now,
    allocationSnapshotValidated: true, lastIssue: null}})
  const readings = campaignMeterReadings(meter)
  const batchId = `automatic:${meter.compteurId}:${meterHash({readings,
    versions: selected.plans.flatMap(plan => plan.groups.flatMap(group => group.shares.map(share => share.version.id))).sort(),
    responses: campaignBeneficiaries.map(row => ({id: row.id, revision: row.revision})).sort((a, b) => a.id.localeCompare(b.id))})}`
  const ingestion = await tx.meterIngestion.upsert({where: {provider_scope_batchId: {provider: CAMPAIGN_MANUAL_PROVIDER, scope: response.campaignId, batchId}},
    update: {}, create: {provider: CAMPAIGN_MANUAL_PROVIDER, scope: response.campaignId, batchId, mode: 'OFFLINE', fetchedAt: now,
      windowStart: periodStart, windowEnd: periodEnd, payloadHash: meterHash(readings), rawPayload: {readings, automatic: true,
        responseIds: campaignBeneficiaries.map(row => row.id)}, result: {automatic: true}}})
  for (const [index, reading] of readings.entries()) await persistMeterReadingInTransaction(tx, {stream, raw: {date: reading.date, automatic: true},
    normalized: {observedAt: CAMPAIGN_VOLUME_BOUNDARIES[index], index: String(reading.value), admissible: true,
      quality: 'VALID', origin: 'COLLECTION', reason: null}}, ingestion, {unchanged: 0, accepted: 0, blocked: 0})
  const result = await reprocessMeterStreamInTransaction(tx, stream, {from: periodStart, to: periodEnd, contained: true, preserveOrdinary: true})
  const published = await tx.meterPublication.findMany({where: {streamId: stream.id, active: true}})
  const canonical = await tx.meterReading.findMany({where: {compteurId: meter.compteurId, observedAt: {in: CAMPAIGN_VOLUME_BOUNDARIES}}, include: {currentRevision: true}})
  if (result.conflicts || result.issues.length || !campaignPublicationCoverage(published) || !campaignReadingsMatch(meter, canonical)) {
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT campaign_auto_publication')
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT campaign_auto_publication')
    return {reason: 'PUBLICATION_CONFLICT', detail: result.issues.join(',')}
  }
  await tx.$executeRawUnsafe('RELEASE SAVEPOINT campaign_auto_publication')
  return {publications: published}
}

async function evaluateMeter(tx, response, meter, allResponses, options) {
  if (allResponses.some(row => row.firstSubmittedAt && row.submittedData?.meters?.some(row => row.compteurId === meter.compteurId && row.meterChanged))) {
    return {reason: METER_CHANGE_REPORTED}
  }
  if (!validOwner(response)) return {reason: 'OWNERSHIP_CHANGED'}
  const physicalMeter = await tx.compteur.findUnique({where: {id: meter.compteurId}})
  if (!physicalMeter || physicalMeter.deletedAt) return {reason: 'ATTACHMENT_REVIEW'}
  const links = await tx.meterAllocation.findMany({where: {compteurId: meter.compteurId},
    include: {versions: true, exploitation: includeExploitation}})
  if (!links.some(row => row.exploitationId === response.exploitationId)) return {reason: 'ATTACHMENT_REVIEW'}
  if (await tx.chunk.findFirst({where: {exploitationId: response.exploitationId, compteurId: null,
    instructionStatus: {not: 'REJECTED'}, source: {status: 'COMPLETED'}, chunkValues: {some: {metricTypeCode: {in: INDEX_METRIC_TYPE_CODES}}}}})) {
    return {reason: 'UNIDENTIFIED_HISTORY'}
  }
  const streams = await tx.meterStream.findMany({where: {compteurId: meter.compteurId}})
  const enabled = streams.filter(row => row.enabled)
  if (enabled.length === 1) {
    const stream = enabled[0]
    const result = await reusablePublications(tx, response, meter, stream, links.filter(row => row.provider === stream.provider && row.scope === stream.scope))
    if (!result.reason) {
      if (await conflictingVolume(tx, response, meter, {publicationIds: result.publications.map(row => row.id), additive: result.additive})) return {reason: 'EXISTING_VOLUME'}
      return {...result, mode: 'METER'}
    }
    if (stream.provider !== CAMPAIGN_MANUAL_PROVIDER || stream.scope !== response.campaignId) return result
  }
  if (streams.some(row => row.provider !== CAMPAIGN_MANUAL_PROVIDER || row.scope !== response.campaignId)) return {reason: 'PROVIDER_READING_COVERAGE'}
  const owners = new Set(links.map(row => row.exploitationId))
  const hasDatedHistory = links.some(row => row.versions.some(version => version.enabled || version.startDate || version.endDate || version.percentage !== null))
  if (!streams.length && owners.size === 1 && response.submittedData.meters.length === 1 && !hasDatedHistory) {
    if (await conflictingVolume(tx, response, meter)) return {reason: 'EXISTING_VOLUME'}
    return {mode: 'GENERIC'}
  }
  return {...await publishFromHistoricalAllocations(tx, {response, meter, links, allResponses}, options), mode: 'METER'}
}

async function updateReceiptPublication(tx, response, meter, result) {
  const generic = !result.reason && result.mode === 'GENERIC'
  const receipts = await tx.chunk.findMany({where: {compteurId: meter.compteurId, source: {declarationId: response.declarationId}}})
  const sourceIds = []
  let changed = false
  for (const receipt of receipts) {
    const metadata = {...receipt.metadata, physicalMeterRequired: result.mode === 'METER' || Boolean(result.reason),
      campaignPublicationIds: result.reason ? [] : (result.publications ?? []).map(row => row.id).sort()}
    if (receipt.autoCalculateVolumes !== generic || meterHash(metadata) !== meterHash(receipt.metadata)) {
      await tx.chunk.update({where: {id: receipt.id}, data: {autoCalculateVolumes: generic, metadata}})
      sourceIds.push(receipt.sourceId)
      changed = true
    }
    if (!generic) {
      const removed = await tx.chunkValue.deleteMany({where: {chunkId: receipt.id, valueKind: 'COMPUTED'}})
      changed ||= removed.count > 0
      if (removed.count) sourceIds.push(receipt.sourceId)
    }
  }
  return {generic, sourceIds, changed}
}

// This entry point intentionally updates only publication metadata and derived
// values. Drafts, receipts' declared indices, revisions and submission dates
// are never rewritten by a historical recheck.
export async function recheckCampaignResponsePublicationInTransaction(tx, responseId, {now = new Date()} = {}) {
  const initial = await tx.collectionResponse.findUnique({where: {id: responseId}})
  if (!initial?.firstSubmittedAt || !initial.submittedData || !initial.declarationId) throw createHttpError(409, 'Une réponse déjà soumise est nécessaire pour recalculer les volumes.')
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('collection-campaign'), hashtext(${initial.campaignId}))`
  await tx.$queryRaw`SELECT id FROM "CollectionResponse" WHERE id = ${responseId}::uuid FOR UPDATE`
  const allResponses = await tx.collectionResponse.findMany({where: {campaignId: initial.campaignId}, include: {exploitation: includeExploitation}})
  const response = allResponses.find(row => row.id === responseId)
  const compteurIds = response.submittedData.meters.map(row => row.compteurId).sort()
  for (const id of compteurIds) await lockMeter(tx, id)
  await lockCampaignMeterPoints(tx, response.campaignId, compteurIds, [response.exploitation.pointPrelevementId])
  const issues = []
  const genericIds = []
  const sourceIds = []
  let changed = false
  for (const meter of response.submittedData.meters) {
    const result = await evaluateMeter(tx, response, meter, allResponses, {now})
    if (result.reason) issues.push(result.reason === METER_CHANGE_REPORTED
      ? campaignPublicationIssue(METER_CHANGE_REPORTED, meter.compteurId, 'Non calculé : changement de compteur signalé.')
      : issue(result.reason, meter.compteurId, result.detail))
    const receipt = await updateReceiptPublication(tx, response, meter, result)
    if (receipt.generic) genericIds.push(meter.compteurId)
    sourceIds.push(...receipt.sourceIds)
    changed ||= receipt.changed
  }
  if (genericIds.length && changed) await reconstructVolumesFromIndexInTransaction(tx, response.exploitation.pointPrelevementId,
    {exploitationId: response.exploitationId, compteurIds: genericIds})
  if (sourceIds.length) await refreshVolumeMetadataForSourceIds([...new Set(sourceIds)], tx)
  const publicationStatus = issues.length ? 'PENDING_REVIEW' : 'PUBLISHED'
  if (response.publicationStatus !== publicationStatus || meterHash(response.publicationIssues ?? []) !== meterHash(issues)) {
    await tx.collectionResponse.update({where: {id: responseId}, data: {publicationStatus, publicationIssues: issues}})
    changed = true
  }
  return {responseId, publicationStatus, publicationIssues: issues, changed}
}

export async function recheckCampaignResponsePublication({responseId}, {client = prisma, now = new Date()} = {}) {
  return runCollectionTransaction(client, tx => recheckCampaignResponsePublicationInTransaction(tx, responseId, {now}),
    {isolationLevel: 'Serializable', maxWait: 20_000, timeout: 120_000})
}

export async function getCampaignResponsePublicationPlan(responseId, {client = prisma, now = new Date()} = {}) {
  const response = await client.collectionResponse.findUnique({where: {id: responseId}, include: {exploitation: includeExploitation}})
  if (!response?.firstSubmittedAt || !response.submittedData || !response.declarationId) throw createHttpError(409, 'Une réponse déjà soumise est nécessaire pour recalculer les volumes.')
  const allResponses = await client.collectionResponse.findMany({where: {campaignId: response.campaignId}, include: {exploitation: includeExploitation}})
  const meters = []
  const publicationIssues = []
  for (const meter of response.submittedData.meters) {
    const result = await evaluateMeter(client, response, meter, allResponses, {now, preview: true})
    const {publications, ...decision} = result
    meters.push({compteurId: meter.compteurId, ...decision, publicationIds: (publications ?? []).map(row => row.id).sort()})
    if (result.reason) publicationIssues.push(result.reason === METER_CHANGE_REPORTED
      ? campaignPublicationIssue(METER_CHANGE_REPORTED, meter.compteurId, 'Non calculé : changement de compteur signalé.')
      : issue(result.reason, meter.compteurId, result.detail))
  }
  return {responseId, publicationStatus: publicationIssues.length ? 'PENDING_REVIEW' : 'PUBLISHED', publicationIssues, meters}
}
