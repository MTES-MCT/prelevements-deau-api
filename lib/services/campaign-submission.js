/* eslint-disable no-await-in-loop -- Campaign receipts, meter locks and volume calculations are one atomic operation. */
import {randomBytes} from 'node:crypto'
import createHttpError from 'http-errors'
import {Prisma} from '@prisma/client'
import {prisma} from '../../db/prisma.js'
import {getAuthorizedCampaignResponseContext, assertCampaignResponseWritable, validateCollectionResponseData, runCollectionTransaction} from './collection-campaigns.js'
import {meterHash, scaledDecimal} from './meter-core.js'
import {lockMeter, lockMeterPublicationPoints} from './meter-publication.js'
import {reconstructVolumesFromIndexInTransaction, INDEX_METRIC_TYPE_CODES} from './volumes-from-index.js'
import {refreshVolumeMetadataForSourceIds} from './volume-totals.js'
import {refreshSourceDeclarantsLastDeclarationAt} from '../models/declarant.js'
import {addExploitationSecondaryUsage} from '../models/exploitation.js'
import {computeInstantPeriodEnd} from '../util/temporal-discretization.js'
import {getCompatibleMetricTypeCodes} from '../constants/metric-type-codes.js'
import {campaignMeterReadings, campaignMeterIndicesDecrease, campaignMeterFingerprint, campaignPublicationIssue, CAMPAIGN_MANUAL_PROVIDER} from './campaign-readings.js'
import {invalidateCampaignMeterPublication} from './campaign-meter-publication.js'

const options = {isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 20_000, timeout: 120_000}

async function resolveCampaignMeters(tx, response, data) {
  const links = await tx.meterAllocation.findMany({where: {exploitationId: response.exploitationId}, include: {compteur: true}})
  const requiredIds = new Set(links.filter(link => !link.compteur.deletedAt).map(link => link.compteurId))
  const resolved = []
  for (const meter of data.meters) {
    const serialNumber = meter.serialNumber.trim()
    const matches = await tx.compteur.findMany({where: {serialNumber: {equals: serialNumber, mode: 'insensitive'}}, take: 2})
    if (matches.length > 1 || matches[0]?.deletedAt) throw createHttpError(409, 'Ce numéro de compteur doit être vérifié par un administrateur.')
    let record = meter.compteurId ? await tx.compteur.findUnique({where: {id: meter.compteurId}}) : matches[0]
    if (meter.compteurId && (!record || record.deletedAt || record.serialNumber?.toLocaleUpperCase('fr') !== serialNumber.toLocaleUpperCase('fr'))) {
      throw createHttpError(409, 'Le numéro du compteur connu ne peut pas être modifié dans ce formulaire.')
    }
    if (!record) {
      record = await tx.compteur.create({data: {serialNumber}})
      await tx.meterAllocation.create({data: {
        sourceId: `collection:${response.campaignId}:${response.exploitationId}:${record.id}`,
        provider: CAMPAIGN_MANUAL_PROVIDER, scope: response.campaignId,
        compteurId: record.id, exploitationId: response.exploitationId,
        metadata: {collectionCampaignId: response.campaignId, declaredBy: response.preleveurUserId},
        versions: {create: {version: 1, enabled: false}}
      }})
    }
    resolved.push({...meter, compteurId: record.id, serialNumber: record.serialNumber})
  }
  const ids = new Set(resolved.map(meter => meter.compteurId))
  if (ids.size !== resolved.length) throw createHttpError(400, 'Un même compteur ne peut apparaître deux fois dans le formulaire.')
  if ([...requiredIds].some(id => !ids.has(id))) throw createHttpError(400, 'Tous les compteurs connus de cette exploitation doivent être renseignés.')
  return {...data, meters: resolved}
}

async function assertReadingsConsistent(tx, response, meter) {
  if (campaignMeterIndicesDecrease(meter)) throw createHttpError(409, 'Un index diminue : faites vérifier le compteur avant de soumettre le formulaire.')
  const existing = await tx.chunkValue.findMany({where: {
    valueKind: 'DECLARED', metricTypeCode: {in: INDEX_METRIC_TYPE_CODES},
    chunk: {compteurId: meter.compteurId, exploitationId: response.exploitationId,
      instructionStatus: {not: 'REJECTED'}, source: {status: 'COMPLETED',
        ...(response.declarationId ? {NOT: {declarationId: response.declarationId}} : {})}}
  }, select: {periodStart: true, value: true}})
  for (const reading of campaignMeterReadings(meter)) {
    const date = new Date(`${reading.date}T00:00:00Z`)
    const index = scaledDecimal(reading.value)
    for (const value of existing) {
      const other = scaledDecimal(value.value)
      if ((value.periodStart.getTime() === date.getTime() && other !== index)
        || (value.periodStart < date && other > index) || (value.periodStart > date && other < index)) {
        throw createHttpError(409, 'Ces index contredisent un relevé déjà déclaré. La déclaration existante reste inchangée.')
      }
    }
  }
}

async function publicationIssues(tx, response, data) {
  const issues = []
  for (const meter of data.meters) {
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
      periodStart: {lt: new Date('2026-10-31T00:15:00Z')}, periodEnd: {gt: new Date('2025-10-31T00:00:00Z')},
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

async function writeReceipt(tx, response, data, issues, actorId, now) {
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
        usageId: reading.usageId, instructionStatus: 'VALIDATED', calculationStrategy: 'GENERIC',
        autoCalculateVolumes: !blocked.has(meter.compteurId) && !chunk?.metadata?.physicalMeterRequired,
        minDate: date, maxDate: date,
        metadata: {quickDeclaration: true, collectionResponseId: response.id, collectionCampaignId: response.campaignId,
          readingDate: reading.date, measurementType: 'INDEX', serialNumber: meter.serialNumber,
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
      const usage = await tx.sandreWaterUse.findUnique({where: {id: reading.usageId}})
      if (!usage || usage.kind !== 'SUB_USAGE' || !usage.parentId) throw createHttpError(400, 'Choisissez un sous-usage valide.')
      await addExploitationSecondaryUsage(response.exploitationId, usage.parentId, {client: tx})
    }
  }
  await reconstructVolumesFromIndexInTransaction(tx, response.exploitation.pointPrelevementId)
  await refreshVolumeMetadataForSourceIds([source.id], tx)
  await refreshSourceDeclarantsLastDeclarationAt(source.id, {client: tx})
  await tx.declarantPointPrelevement.updateMany({where: {id: response.exploitationId,
    OR: [{mostRecentAvailableDate: null}, {mostRecentAvailableDate: {lt: new Date('2026-10-31Z')}}]},
  data: {mostRecentAvailableDate: new Date('2026-10-31Z')}})
  return declaration
}

export async function submitCampaignResponse({user, campaignId, responseId, body}, {client = prisma, now = new Date()} = {}) {
  const data = validateCollectionResponseData(body.data, {submitted: true})
  if (!Number.isInteger(body.revision) || body.revision < 0) throw createHttpError(400, 'La version du formulaire est obligatoire.')
  const hash = meterHash({...data, meters: data.meters.map(({compteurId: _compteurId, ...meter}) => ({...meter, serialNumber: meter.serialNumber.toUpperCase()}))})
  await runCollectionTransaction(client, async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('collection-campaign'), hashtext(${campaignId}))`
    await tx.$queryRaw`SELECT id FROM "CollectionResponse" WHERE id = ${responseId}::uuid FOR UPDATE`
    const context = await getAuthorizedCampaignResponseContext(user, campaignId, responseId, {client: tx})
    assertCampaignResponseWritable(context, user, {now, submitting: true})
    const response = {...context.response, exploitation: context.exploitation}
    if (response.submittedHash === hash) return
    if (response.revision !== body.revision) throw createHttpError(409, 'Ce formulaire a changé. Rechargez-le avant de soumettre.')
    const resolved = await resolveCampaignMeters(tx, response, data)
    const needUsageIds = [...new Set([data.needs.offSeason.usageId, data.needs.season.usageId])]
    if (await tx.sandreWaterUse.count({where: {id: {in: needUsageIds}, kind: 'SUB_USAGE'}}) !== needUsageIds.length) {
      throw createHttpError(400, 'Choisissez un sous-usage valide pour chaque besoin.')
    }
    for (const id of resolved.meters.map(meter => meter.compteurId).sort()) await lockMeter(tx, id)
    await lockMeterPublicationPoints(tx, resolved.meters.map(meter => meter.compteurId))
    for (const meter of resolved.meters) await assertReadingsConsistent(tx, response, meter)
    for (const meter of resolved.meters) {
      const previous = response.submittedData?.meters?.find(row => row.compteurId === meter.compteurId)
      if (previous && campaignMeterFingerprint(previous) !== campaignMeterFingerprint(meter)) {
        await invalidateCampaignMeterPublication(tx, campaignId, meter.compteurId)
      }
    }
    const issues = await publicationIssues(tx, response, resolved)
    const declaration = await writeReceipt(tx, response, resolved, issues, user.id, now)
    await tx.collectionResponse.update({where: {id: response.id}, data: {
      draftData: resolved, submittedData: resolved, submittedHash: hash, revision: {increment: 1},
      firstSubmittedAt: response.firstSubmittedAt ?? now, lastSubmittedAt: now, declarationId: declaration.id,
      publicationStatus: issues.length ? 'PENDING_REVIEW' : 'PUBLISHED', publicationIssues: issues
    }})
  }, options)
  return getAuthorizedCampaignResponseContext(user, campaignId, responseId, {client})
}
