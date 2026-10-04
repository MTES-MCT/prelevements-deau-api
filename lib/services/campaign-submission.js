/* eslint-disable no-await-in-loop -- Campaign receipts, meter locks and volume calculations are one atomic operation. */
import {randomBytes} from 'node:crypto'
import createHttpError from 'http-errors'
import {Prisma} from '@prisma/client'
import {prisma} from '../../db/prisma.js'
import {getAuthorizedCampaignResponseContext, assertCampaignResponseWritable, validateCollectionResponseData, runCollectionTransaction} from './collection-campaigns.js'
import {scaledDecimal} from './meter-core.js'
import {lockMeter} from './meter-publication.js'
import {reconstructVolumesFromIndexInTransaction, suppressCampaignMeterVolumes, INDEX_METRIC_TYPE_CODES} from './volumes-from-index.js'
import {refreshVolumeMetadataForSourceIds} from './volume-totals.js'
import {refreshSourceDeclarantsLastDeclarationAt} from '../models/declarant.js'
import {addExploitationSecondaryUsage} from '../models/exploitation.js'
import {computeInstantPeriodEnd} from '../util/temporal-discretization.js'
import {getCompatibleMetricTypeCodes} from '../constants/metric-type-codes.js'
import {campaignMeterReadings, campaignMeterFingerprint, campaignPublicationIssue, CAMPAIGN_MANUAL_PROVIDER, CAMPAIGN_READING_DATES, METER_CHANGE_REPORTED} from './campaign-readings.js'
import {invalidateCampaignMeterPublication, lockCampaignMeterPoints} from './campaign-meter-publication.js'
import {getWaterUseRootId} from './sandre-water-uses.js'
import {campaignSubmissionHash, resolveCampaignMeters} from './campaign-meters.js'

const options = {isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 20_000, timeout: 120_000}

function responseFieldError(status, message, fields) {
  const error = createHttpError(status, message)
  error.data = {fields, validationErrors: fields}
  return error
}

async function validateCampaignUsages(tx, data) {
  const usageFields = data.meters.flatMap((meter, index) => ['offSeason', 'season'].map(period => [`meters.${index}.${period}.usageId`, meter[period].usageId]))
  usageFields.push(...['offSeason', 'season'].map(period => [`needs.${period}.usageId`, data.needs[period].usageId]))
  const usages = new Map((await tx.sandreWaterUse.findMany({where: {id: {in: [...new Set(usageFields.map(([, id]) => id))]}}, include: {parent: true}})).map(usage => [usage.id, usage]))
  const fields = Object.fromEntries(usageFields.filter(([, id]) => !getWaterUseRootId(usages.get(id)))
    .map(([path]) => [path, 'Choisissez un usage ou un sous-usage valide.']))
  if (Object.keys(fields).length) throw responseFieldError(400, 'Vérifiez les usages choisis.', fields)
  // Required agricultural fields depend on the actual referenced usage, never
  // on a client-provided code or the syntactic validity of its UUID.
  validateCollectionResponseData(data, {submitted: true, requireSerialNumber: false, waterUses: [...usages.values()]})
  return usages
}

async function conflictingReadingFields(tx, response, meter, meterIndex) {
  const fields = {}
  const existing = await tx.chunkValue.findMany({where: {
    valueKind: 'DECLARED', metricTypeCode: {in: INDEX_METRIC_TYPE_CODES},
    chunk: {compteurId: meter.compteurId, exploitationId: response.exploitationId,
      instructionStatus: {not: 'REJECTED'}, source: {status: 'COMPLETED',
        ...(response.declarationId ? {NOT: {declarationId: response.declarationId}} : {})}}
  }, select: {periodStart: true, value: true}})
  for (const [readingIndex, reading] of campaignMeterReadings(meter).entries()) {
    const date = new Date(`${reading.date}T00:00:00Z`)
    const index = scaledDecimal(reading.value)
    for (const value of existing) {
      const other = scaledDecimal(value.value)
      if ((value.periodStart.getTime() === date.getTime() && other !== index)
        || (value.periodStart < date && other > index) || (value.periodStart > date && other < index)) {
        const path = ['offSeason.indexStart', 'offSeason.indexEnd', 'season.indexEnd'][readingIndex]
        fields[`meters.${meterIndex}.${path}`] = 'Cet index contredit un relevé déjà déclaré pour ce compteur. Vérifiez votre saisie.'
      }
    }
  }
  return fields
}

async function publicationIssues(tx, response, data, reportedIds) {
  const issues = []
  for (const meter of data.meters) {
    if (reportedIds.has(meter.compteurId)) {
      issues.push(campaignPublicationIssue(METER_CHANGE_REPORTED, meter.compteurId, 'Non calculé : changement de compteur signalé.'))
      continue
    }
    const links = await tx.meterAllocation.findMany({where: {compteurId: meter.compteurId}})
    const owners = new Set(links.map(link => link.exploitationId))
    const streams = await tx.meterStream.findMany({where: {compteurId: meter.compteurId}})
    const previous = response.submittedData?.meters?.find(row => row.compteurId === meter.compteurId)
    const manual = streams.find(stream => stream.provider === CAMPAIGN_MANUAL_PROVIDER && stream.scope === response.campaignId && stream.enabled)
    if (manual && previous && campaignMeterFingerprint(previous) === campaignMeterFingerprint(meter)
      && !response.publicationIssues?.some(issue => issue.compteurId === meter.compteurId)
      && await tx.meterPublication.count({where: {streamId: manual.id, active: true}}) === 2) continue
    if (!owners.has(response.exploitationId)) {
      issues.push(campaignPublicationIssue('ATTACHMENT_REVIEW', meter.compteurId, 'Le rattachement de ce compteur doit être vérifié.'))
    }
    if (owners.size > 1) issues.push(campaignPublicationIssue('SHARED_METER', meter.compteurId, 'La répartition du compteur partagé doit être validée.'))
    if (data.meters.length > 1) issues.push(campaignPublicationIssue('ADDITIVE_REVIEW', meter.compteurId, 'Le cumul de plusieurs compteurs doit être validé.'))
    if (streams.length) issues.push(campaignPublicationIssue('METER_PUBLICATION', meter.compteurId,
      streams.some(stream => stream.provider !== CAMPAIGN_MANUAL_PROVIDER)
        ? 'Ce compteur possède un flux de données : aucune donnée fournisseur ne sera remplacée.'
        : 'La publication physique des volumes doit être validée.'))
    const conflicts = await tx.chunkValue.findFirst({where: {
      metricTypeCode: {in: getCompatibleMetricTypeCodes('volume')},
      periodStart: {lt: computeInstantPeriodEnd(new Date(`${CAMPAIGN_READING_DATES[2]}T00:00:00Z`))},
      periodEnd: {gt: new Date(`${CAMPAIGN_READING_DATES[0]}T00:00:00Z`)},
      chunk: {pointPrelevementId: response.exploitation.pointPrelevementId,
        OR: [{exploitationId: response.exploitationId}, {exploitationId: null}],
        instructionStatus: {not: 'REJECTED'},
        source: {status: 'COMPLETED', ...(response.declarationId ? {NOT: {declarationId: response.declarationId}} : {})}}
    }})
    if (conflicts) issues.push(campaignPublicationIssue('EXISTING_VOLUME', meter.compteurId, 'Des volumes existent déjà sur cette période : une vérification est nécessaire.'))
    const unidentified = await tx.chunk.findFirst({where: {
      exploitationId: response.exploitationId, compteurId: null, instructionStatus: {not: 'REJECTED'},
      source: {status: 'COMPLETED'}, chunkValues: {some: {metricTypeCode: {in: INDEX_METRIC_TYPE_CODES}}}
    }})
    if (unidentified) issues.push(campaignPublicationIssue('UNIDENTIFIED_HISTORY', meter.compteurId, 'Des index sans compteur identifié doivent être rapprochés avant le calcul.'))
  }
  return issues
}

async function writeReceipt(tx, response, data, issues, {actorId, now, usages}) {
  let declaration = response.declarationId
    ? await tx.declaration.findUnique({where: {id: response.declarationId}, include: {source: {include: {chunks: true}}}})
    : null
  if (!declaration) declaration = await tx.declaration.create({data: {
    code: randomBytes(3).toString('hex').toUpperCase(), type: 'quick-declaration',
    declarantUserId: response.preleveurUserId, createdByDeclarantUserId: actorId,
    dataSourceType: 'MANUAL', waterWithdrawalType: 'unknown', processingStatus: 'COMPLETED', processingCompletedAt: now,
    importSourceId: `collection-response:${response.id}`,
    source: {create: {type: 'DECLARATION', status: 'COMPLETED', globalInstructionStatus: 'VALIDATED',
      metadata: {manualQuickDeclaration: true, measurementType: 'INDEX', collectionCampaignId: response.campaignId, collectionResponseId: response.id}}}
  }, include: {source: {include: {chunks: true}}}})
  await tx.declaration.update({where: {id: declaration.id}, data: {comment: data.comment || null}})
  const source = declaration.source
  const blocked = new Set(issues.map(issue => issue.compteurId))
  const physical = new Set(issues.filter(issue => ['SHARED_METER', 'ADDITIVE_REVIEW', 'ATTACHMENT_REVIEW', 'METER_PUBLICATION'].includes(issue.code)).map(issue => issue.compteurId))
  for (const meter of data.meters) {
    for (const reading of campaignMeterReadings(meter)) {
      const date = new Date(`${reading.date}T00:00:00Z`)
      let chunk = source.chunks?.find(row => row.compteurId === meter.compteurId && row.metadata?.readingDate === reading.date)
      const fields = {
        compteurId: meter.compteurId, exploitationId: response.exploitationId,
        pointPrelevementId: response.exploitation.pointPrelevementId,
        pointPrelevementName: response.exploitation.pointPrelevement.name,
        flowType: response.exploitation.pointPrelevement.flowType,
        preleveurUserId: response.preleveurUserId, submittedByDeclarantUserId: actorId,
        collecteurUserId: actorId === response.preleveurUserId ? null : actorId,
        usageId: reading.usageId, instructionStatus: 'VALIDATED', calculationStrategy: 'GENERIC',
        autoCalculateVolumes: !blocked.has(meter.compteurId) && !chunk?.metadata?.physicalMeterRequired,
        minDate: date, maxDate: date,
        metadata: {quickDeclaration: true, collectionResponseId: response.id, collectionCampaignId: response.campaignId,
          readingDate: reading.date, measurementType: 'INDEX', serialNumber: meter.serialNumber,
          campaignMeterChangeBlocked: issues.some(issue => issue.compteurId === meter.compteurId && issue.code === METER_CHANGE_REPORTED),
          physicalMeterRequired: physical.has(meter.compteurId) || chunk?.metadata?.physicalMeterRequired === true},
        parsingInfo: {parser: 'collection-form', reason: 'MANUAL_QUICK_DECLARATION'}
      }
      chunk = chunk ? await tx.chunk.update({where: {id: chunk.id}, data: fields})
        : await tx.chunk.create({data: {...fields, sourceId: source.id}})
      await tx.chunkValue.deleteMany({where: {chunkId: chunk.id, valueKind: 'COMPUTED'}})
      const oldValue = await tx.chunkValue.findFirst({where: {chunkId: chunk.id, valueKind: 'DECLARED', metricTypeCode: 'index'}})
      const value = {metricTypeCode: 'index', unit: 'm³', frequency: 'instant', periodStart: date,
        periodEnd: computeInstantPeriodEnd(date), valueKind: 'DECLARED', value: reading.value}
      if (oldValue) await tx.chunkValue.update({where: {id: oldValue.id}, data: value})
      else await tx.chunkValue.create({data: {...value, chunkId: chunk.id}})
      await addExploitationSecondaryUsage(response.exploitationId, getWaterUseRootId(usages.get(reading.usageId)), {client: tx})
    }
  }
  await suppressCampaignMeterVolumes(tx, response.campaignId, data.meters.map(meter => meter.compteurId))
  const calculableIds = data.meters.filter(meter => !blocked.has(meter.compteurId)).map(meter => meter.compteurId)
  if (calculableIds.length) await reconstructVolumesFromIndexInTransaction(tx, response.exploitation.pointPrelevementId,
    {exploitationId: response.exploitationId, compteurIds: calculableIds})
  await refreshVolumeMetadataForSourceIds([source.id], tx)
  await refreshSourceDeclarantsLastDeclarationAt(source.id, {client: tx})
  await tx.declarantPointPrelevement.updateMany({where: {id: response.exploitationId,
    OR: [{mostRecentAvailableDate: null}, {mostRecentAvailableDate: {lt: new Date(`${CAMPAIGN_READING_DATES[2]}T00:00:00Z`)}}]},
  data: {mostRecentAvailableDate: new Date(`${CAMPAIGN_READING_DATES[2]}T00:00:00Z`)}})
  return declaration
}

export async function submitCampaignResponse({user, campaignId, responseId, body}, {client = prisma, now = new Date()} = {}) {
  const data = validateCollectionResponseData(body.data)
  if (!Number.isInteger(body.revision) || body.revision < 0) throw createHttpError(400, 'La version du formulaire est obligatoire.')
  await runCollectionTransaction(client, async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('collection-campaign'), hashtext(${campaignId}))`
    await tx.$queryRaw`SELECT id FROM "CollectionResponse" WHERE id = ${responseId}::uuid FOR UPDATE`
    const context = await getAuthorizedCampaignResponseContext(user, campaignId, responseId, {client: tx})
    assertCampaignResponseWritable(context, user, {now})
    const response = {...context.response, exploitation: context.exploitation}
    if (response.submittedData && campaignSubmissionHash(data, response.submittedData) === campaignSubmissionHash(response.submittedData)) return
    if (response.revision !== body.revision) throw createHttpError(409, 'Ce formulaire a changé. Rechargez-le avant de soumettre.')
    validateCollectionResponseData(data, {submitted: true, requireSerialNumber: false, deferAgriculturalRequirements: true})
    const usages = await validateCampaignUsages(tx, data)
    const resolved = await resolveCampaignMeters(tx, response, data, {actorId: user.id})
    validateCollectionResponseData(resolved, {submitted: true, waterUses: [...usages.values()]})
    const hash = campaignSubmissionHash(resolved)
    for (const id of resolved.meters.map(meter => meter.compteurId).sort()) await lockMeter(tx, id)
    await lockCampaignMeterPoints(tx, campaignId, resolved.meters.map(meter => meter.compteurId), [response.exploitation.pointPrelevementId])
    const conflictingFields = {}
    for (const [index, meter] of resolved.meters.entries()) {
      const conflicts = await conflictingReadingFields(tx, response, meter, index)
      if (Object.keys(conflicts).length && meter.meterChanged !== true) {
        conflictingFields[`meters.${index}.meterChanged`] = 'Signalez le changement de compteur pour conserver ces index en contradiction avec l’historique.'
        if (!meter.meterChangeReason) conflictingFields[`meters.${index}.meterChangeReason`] = 'Précisez le motif du changement de compteur.'
      }
    }
    if (Object.keys(conflictingFields).length) throw responseFieldError(409, 'Ces index contredisent un relevé déjà déclaré. La déclaration existante reste inchangée.', conflictingFields)
    const otherResponses = await tx.collectionResponse.findMany({where: {campaignId, id: {not: responseId}, firstSubmittedAt: {not: null}}, select: {submittedData: true}})
    const reportedIds = new Set([resolved, ...otherResponses.map(row => row.submittedData)].flatMap(value => (value?.meters ?? [])
      .filter(meter => meter.meterChanged === true).map(meter => meter.compteurId)))
    for (const meter of resolved.meters) {
      const previous = response.submittedData?.meters?.find(row => row.compteurId === meter.compteurId)
      if (reportedIds.has(meter.compteurId) || (previous && campaignMeterFingerprint(previous) !== campaignMeterFingerprint(meter))) {
        await invalidateCampaignMeterPublication(tx, campaignId, meter.compteurId, {reported: reportedIds.has(meter.compteurId)})
      }
    }
    const issues = await publicationIssues(tx, response, resolved, reportedIds)
    const declaration = await writeReceipt(tx, response, resolved, issues, {actorId: user.id, now, usages})
    await tx.collectionResponse.update({where: {id: response.id}, data: {
      draftData: resolved, submittedData: resolved, submittedHash: hash, revision: {increment: 1},
      firstSubmittedAt: response.firstSubmittedAt ?? now, lastSubmittedAt: now, declarationId: declaration.id,
      publicationStatus: issues.length ? 'PENDING_REVIEW' : 'PUBLISHED', publicationIssues: issues
    }})
  }, options)
  return getAuthorizedCampaignResponseContext(user, campaignId, responseId, {client})
}
