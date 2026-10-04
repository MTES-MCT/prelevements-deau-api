import {digest, stableId} from './epidropt.js'
import {getTransactionTimeoutMs} from './import-options.js'
import {validateCollectionResponseData, COLLECTION_CAMPAIGN_TYPE} from '../../../lib/validation/collection-campaigns.js'
import {assertConnectedProdAdminDatabase} from '../../network/prod-database-target.js'
import {assertConnectedTestingAdminDatabase} from '../../network/testing-database-target.js'
import {assertConnectedDemoAdminDatabase} from '../../demo/database-target.js'

const OPERATION = 'reviewed-physical-campaign-repair'
const hash = value => digest(JSON.parse(JSON.stringify(value)))
const requireCondition = (condition, message) => { if (!condition) throw new Error(message) }
const uuid = value => /^[a-f0-9-]{36}$/i.test(value ?? '')
const untouched = response => response.revision === 0 && response.draftData === null && response.submittedData === null
  && !response.firstSubmittedAt && !response.lastSubmittedAt && !response.submittedHash && !response.declarationId
  && response.publicationStatus === 'NOT_SUBMITTED' && !(response.publicationIssues ?? []).length
const meterId = (entry, meter) => meter.compteurId ?? stableId(`${OPERATION}:${entry.exploitationId}:${meter.anonymousKey}`)
const anonymousIdentifier = (entry, meter) => `${OPERATION}:${digest([entry.exploitationId, meter.anonymousKey])}`

function validateMeter(meter) {
  const existing = uuid(meter.compteurId) && !meter.anonymousKey && typeof meter.expectedSerialNumber === 'string' && meter.expectedSerialNumber.trim()
  const anonymous = !meter.compteurId && /^[a-z0-9-]{1,80}$/.test(meter.anonymousKey ?? '') && meter.indexStart === null
  requireCondition((existing || anonymous) && (meter.indexStart === null || /^[0-9]+(?:\.[0-9]{1,4})?$/.test(meter.indexStart ?? '')),
    'Compteur existant identifié ou compteur anonyme confirmé, sans index inventé, requis.')
}

function validatePlan(plan) {
  requireCondition(plan?.version === 1 && uuid(plan.campaignId) && Array.isArray(plan.entries) && plan.entries.length > 0,
    'Plan physique explicite requis.')
  requireCondition(Array.isArray(plan.evidence) && plan.evidence.length > 0 && plan.evidence.every(item =>
    /^[a-f0-9]{64}$/.test(item.sha256 ?? '') && typeof item.fileName === 'string' && item.fileName
    && typeof item.sheet === 'string' && item.sheet && Array.isArray(item.rows) && item.rows.length > 0
    && item.rows.every(row => Number.isInteger(row) && row > 0)), 'Provenance privée vérifiée requise.')
  for (const entry of plan.entries) {
    requireCondition(['responseId', 'exploitationId', 'pointPrelevementId', 'preleveurUserId'].every(key => uuid(entry[key]))
      && /^[a-f0-9]{64}$/.test(entry.expectedPrefillHash ?? '') && Array.isArray(entry.meters) && entry.meters.length > 0,
    'Identités et empreinte de la proposition précédente requises.')
    for (const meter of entry.meters) validateMeter(meter)
  }
  requireCondition(new Set(plan.entries.map(entry => entry.responseId)).size === plan.entries.length, 'Réponse répétée dans le plan.')
  const ids = plan.entries.flatMap(entry => entry.meters.map(meter => meterId(entry, meter)))
  requireCondition(new Set(ids).size === ids.length, 'Un compteur ne peut pas être réaffecté à plusieurs bénéficiaires par ce correctif.')
}

async function assertTarget(client, target) {
  requireCondition(['local', 'testing', 'demo', 'prod'].includes(target), 'Cible explicite requise.')
  if (target === 'prod') await assertConnectedProdAdminDatabase(client)
  if (target === 'testing') await assertConnectedTestingAdminDatabase(client)
  if (target === 'demo') await assertConnectedDemoAdminDatabase(client)
}

async function snapshot(tx, plan, actorUserId) {
  const actor = await tx.user.findUnique({where: {id: actorUserId}, select: {id: true, role: true, deletedAt: true}})
  requireCondition(actor?.role === 'ADMIN' && !actor.deletedAt, 'Administrateur actif requis.')
  const campaign = await tx.collectionCampaign.findUnique({where: {id: plan.campaignId}})
  requireCondition(campaign?.type === COLLECTION_CAMPAIGN_TYPE && campaign.status !== 'ARCHIVED' && !campaign.closedAt, 'Campagne fermée ou inconnue.')
  const responses = await tx.collectionResponse.findMany({where: {id: {in: plan.entries.map(entry => entry.responseId)}}, orderBy: {id: 'asc'},
    include: {exploitation: {include: {pointPrelevement: {select: {deletedAt: true}}, declarant: {select: {user: {select: {deletedAt: true}}}},
      collecteurs: {orderBy: {id: 'asc'}}, meterAllocations: {orderBy: {id: 'asc'}, include: {versions: {orderBy: {version: 'asc'}}}},
      _count: {select: {connectors: true, chunks: true}}}}}})
  const meters = await tx.compteur.findMany({where: {id: {in: plan.entries.flatMap(entry => entry.meters.map(meter => meterId(entry, meter)))}},
    orderBy: {id: 'asc'}, include: {meterAllocations: {orderBy: {id: 'asc'}, include: {versions: {orderBy: {version: 'asc'}}}},
      externalReferences: {orderBy: {id: 'asc'}}, _count: {select: {chunks: true, meterStreams: true, meterReadings: true, meterPublications: true}}}})
  const chunks = await tx.chunk.findMany({where: {OR: plan.entries.map(entry => ({pointPrelevementId: entry.pointPrelevementId,
    preleveurUserId: entry.preleveurUserId}))}, select: {id: true, pointPrelevementId: true, preleveurUserId: true}, orderBy: {id: 'asc'}})
  return {actor, campaign, responses, meters, chunks}
}

function prepareEntry(plan, entry, state) {
  const response = state.responses.find(item => item.id === entry.responseId)
  const exploitation = response?.exploitation
  requireCondition(response && response.campaignId === plan.campaignId && response.exploitationId === entry.exploitationId
    && response.preleveurUserId === entry.preleveurUserId && exploitation.declarantUserId === entry.preleveurUserId
    && exploitation.pointPrelevementId === entry.pointPrelevementId, 'Identité de réponse ou de bénéficiaire modifiée.')
  const planHash = hash(plan)
  if (response.prefillMetadata?.physicalRepair?.planHash === planHash) return {...entry, action: 'ALREADY_APPLIED'}
  requireCondition(untouched(response) && hash({prefillData: response.prefillData, prefillMetadata: response.prefillMetadata}) === entry.expectedPrefillHash,
    'Réponse commencée ou proposition modifiée : aucune écriture.')
  requireCondition(!exploitation.pointPrelevement.deletedAt && !exploitation.declarant.user.deletedAt && !exploitation.endDate
    && ['EN_ACTIVITE', 'NON_RENSEIGNE'].includes(exploitation.status)
    && exploitation.sourceId?.startsWith('dropt-epidropt:exploitation:')
    && exploitation.collecteurs.some(link => link.collecteurUserId === state.campaign.collecteurUserId), 'Exploitation inactive, non importée ou non déléguée.')
  requireCondition(exploitation._count.connectors === 0 && exploitation._count.chunks === 0
    && !state.chunks.some(chunk => chunk.pointPrelevementId === entry.pointPrelevementId && chunk.preleveurUserId === entry.preleveurUserId),
  'Historique ou connecteur existant : revue manuelle requise.')
  const ids = entry.meters.map(meter => meterId(entry, meter))
  requireCondition(exploitation.meterAllocations.every(allocation => ids.includes(allocation.compteurId)), 'Un rattachement existant manquerait au plan.')
  const destinations = entry.meters.map(input => {
    const id = meterId(entry, input)
    const meter = state.meters.find(item => item.id === id)
    requireCondition(input.compteurId ? meter && meter.serialNumber === input.expectedSerialNumber : !meter,
      'Compteur absent, identité différente ou collision avec le compteur anonyme.')
    if (meter) {
      requireCondition(!meter.deletedAt && Object.values(meter._count).every(count => count === 0), 'Compteur supprimé, connecté ou possédant un historique.')
      requireCondition(meter.externalReferences.every(reference => (!reference.pointPrelevementId || reference.pointPrelevementId === entry.pointPrelevementId)
        && (!reference.declarantUserId || reference.declarantUserId === entry.preleveurUserId)), 'Référence de compteur rattachée ailleurs.')
      requireCondition(meter.meterAllocations.every(allocation => allocation.exploitationId === entry.exploitationId
        && allocation.versions.every(version => !version.enabled && version.percentage === null)), 'Compteur partagé ou répartition active/configurée.')
      requireCondition(meter.meterAllocations.length <= 1, 'Rattachements multiples ambigus.')
    }
    return {id, serialNumber: meter?.serialNumber ?? null, indexStart: input.indexStart,
      createMeter: !input.compteurId, identifier: input.compteurId ? null : anonymousIdentifier(entry, input),
      createAllocation: !meter?.meterAllocations.length,
      allocationSourceId: `${OPERATION}:${digest([entry.exploitationId, id])}`}
  })
  const prefillData = validateCollectionResponseData({...response.prefillData,
    meters: destinations.map(meter => ({compteurId: meter.id, serialNumber: meter.serialNumber,
      offSeason: meter.indexStart === null ? {} : {indexStart: meter.indexStart}, season: {}}))})
  const prefillMetadata = {...response.prefillMetadata, physicalRepair: {version: 1, planHash, evidence: plan.evidence}}
  return {...entry, action: 'REPAIR', destinations, prefillData, prefillMetadata}
}

export async function reviewedPhysicalCampaignRepair(client, plan, options = {}) {
  validatePlan(plan)
  const {target, actorUserId, apply = false, expectedReport, onBeforeApply, transactionTimeoutSeconds} = options
  const sourceHash = hash(plan)
  if (apply) requireCondition(expectedReport?.operation === OPERATION && expectedReport.version === 1 && expectedReport.complete
    && !expectedReport.applied && expectedReport.target === target && expectedReport.actorUserId === actorUserId
    && expectedReport.sourceHash === sourceHash && typeof onBeforeApply === 'function', 'Simulation revue et sauvegarde privée requises.')
  return client.$transaction(async tx => {
    if (!apply) await tx.$executeRaw`SET TRANSACTION READ ONLY`
    await assertTarget(tx, target)
    if (apply) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('collection-campaign'), hashtext(${plan.campaignId}))`
      await tx.$queryRaw`SELECT id FROM "CollectionCampaign" WHERE id = ${plan.campaignId}::uuid FOR UPDATE`
      for (const entry of [...plan.entries].sort((a, b) => a.exploitationId.localeCompare(b.exploitationId))) {
        await tx.$queryRaw`SELECT id FROM "DeclarantPointPrelevement" WHERE id = ${entry.exploitationId}::uuid FOR UPDATE`
        await tx.$queryRaw`SELECT id FROM "CollectionResponse" WHERE id = ${entry.responseId}::uuid FOR UPDATE`
        await tx.$queryRaw`SELECT id FROM "PointPrelevement" WHERE id = ${entry.pointPrelevementId}::uuid FOR UPDATE`
        for (const id of entry.meters.map(meter => meterId(entry, meter)).sort()) {
          await tx.$queryRaw`SELECT id FROM "Compteur" WHERE id = ${id}::uuid FOR UPDATE`
          await tx.$queryRaw`SELECT id FROM "MeterAllocation" WHERE "compteurId" = ${id}::uuid ORDER BY id FOR UPDATE`
          await tx.$queryRaw`SELECT v.id FROM "MeterAllocationVersion" v JOIN "MeterAllocation" a ON a.id = v."allocationId"
            WHERE a."compteurId" = ${id}::uuid ORDER BY v.id FOR UPDATE OF v`
        }
      }
    }
    const before = await snapshot(tx, plan, actorUserId)
    const entries = plan.entries.map(entry => prepareEntry(plan, entry, before))
    const planHash = hash({sourceHash, before, entries, target, actorUserId})
    requireCondition(!expectedReport || expectedReport.planHash === planHash, 'État modifié depuis la simulation.')
    const report = {version: 1, operation: OPERATION, target, actorUserId, sourceHash, planHash, applied: apply, complete: true,
      before, entries, counts: {REPAIR: entries.filter(entry => entry.action === 'REPAIR').length,
        ALREADY_APPLIED: entries.filter(entry => entry.action === 'ALREADY_APPLIED').length}}
    if (apply) {
      await onBeforeApply({...report, applied: false})
      for (const entry of entries.filter(item => item.action === 'REPAIR')) {
        for (const meter of entry.destinations) {
          if (meter.createMeter) await tx.compteur.create({data: {id: meter.id, identifier: meter.identifier, serialNumber: null}})
          // No allocation version is created: these links cannot publish volumes.
          if (meter.createAllocation) await tx.meterAllocation.create({data: {sourceId: meter.allocationSourceId,
            provider: 'campaign-repair', scope: plan.campaignId, compteurId: meter.id, exploitationId: entry.exploitationId,
            metadata: {planHash: sourceHash, evidence: plan.evidence}}})
        }
        await tx.collectionResponse.update({where: {id: entry.responseId}, data: {prefillData: entry.prefillData, prefillMetadata: entry.prefillMetadata}})
      }
    }
    return report
  }, {isolationLevel: 'Serializable', maxWait: 10_000, timeout: getTransactionTimeoutMs(transactionTimeoutSeconds)})
}

function meterMatches(meter, expected, exploitationId) {
  const allocations = meter?.meterAllocations ?? []
  return meter && !meter.deletedAt && meter.serialNumber === expected.serialNumber
    && (!expected.createMeter || meter.identifier === expected.identifier) && allocations.length === 1
    && allocations[0].exploitationId === exploitationId
    && allocations[0].versions.every(version => !version.enabled && version.percentage === null)
    && Object.values(meter._count).every(count => count === 0)
}

export async function verifyReviewedPhysicalCampaignRepair(client, plan, {target, actorUserId, expectedReport} = {}) {
  validatePlan(plan)
  requireCondition(expectedReport?.operation === OPERATION && expectedReport.applied && expectedReport.complete
    && expectedReport.sourceHash === hash(plan) && expectedReport.target === target && expectedReport.actorUserId === actorUserId,
  'Rapport appliqué correspondant requis.')
  await assertTarget(client, target)
  const current = await snapshot(client, plan, actorUserId)
  const issues = []
  for (const entry of expectedReport.entries.filter(item => item.action === 'REPAIR')) {
    const response = current.responses.find(item => item.id === entry.responseId)
    if (!response || hash(response.prefillData) !== hash(entry.prefillData) || hash(response.prefillMetadata) !== hash(entry.prefillMetadata)) {
      issues.push({code: 'PREFILL_MISMATCH', responseId: entry.responseId})
    }
    for (const expected of entry.destinations) {
      const meter = current.meters.find(item => item.id === expected.id)
      if (!meterMatches(meter, expected, entry.exploitationId)) issues.push({code: 'METER_VERIFICATION_FAILED', compteurId: expected.id})
    }
  }
  return {version: 1, operation: `verify-${OPERATION}`, target, complete: issues.length === 0, applied: false, issues}
}
