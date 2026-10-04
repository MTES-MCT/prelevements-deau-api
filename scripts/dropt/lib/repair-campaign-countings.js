import {digest, stableId} from './epidropt.js'
import {buildCampaignPrefillPlan} from './campaign-prefill.js'
import {getTransactionTimeoutMs} from './import-options.js'
import {COLLECTION_CAMPAIGN_TYPE} from '../../../lib/validation/collection-campaigns.js'
import {campaignSerialKey, findAbsentCampaignSerialNumbers} from '../../../lib/services/campaign-meter-proposals.js'
import {assertConnectedProdAdminDatabase} from '../../network/prod-database-target.js'
import {assertConnectedTestingAdminDatabase} from '../../network/testing-database-target.js'
import {assertConnectedDemoAdminDatabase} from '../../demo/database-target.js'

const OPERATION = 'repair-campaign-countings'
const clean = value => String(value ?? '').trim()
const hash = value => digest(JSON.parse(JSON.stringify(value)))
const requireCondition = (condition, message) => { if (!condition) throw new Error(message) }
const rowsOf = records => [...new Set(records.flatMap(record => record.sourceRows))].sort((a, b) => a - b)
const untouched = response => response.revision === 0 && response.draftData === null && response.submittedData === null
  && !response.firstSubmittedAt && !response.lastSubmittedAt && !response.submittedHash && !response.declarationId
  && response.publicationStatus === 'NOT_SUBMITTED' && !(response.publicationIssues ?? []).length
const names = exploitation => [exploitation.pointPrelevement.name, ...(exploitation.pointPrelevementNameAliases ?? []),
  ...(exploitation.pointPrelevement.otherNames ?? '').split('|')].map(clean)
const CLONE_FIELDS = ['declarantUserId', 'pointPrelevementId', 'status', 'startDate', 'endDate', 'usageId',
  'pointPrelevementNameAliases', 'excludeFromQuickDeclaration', 'abandonReason', 'comment']
const DEPENDENCIES = ['meterAllocations', 'connectors', 'documents', 'documentLinks', 'rules', 'chunks']

function sourceGroups(source) {
  const groups = new Map()
  for (const record of source.records) {
    const key = JSON.stringify([record.identity.pointOugc, record.identity.siret])
    const group = groups.get(key) ?? []
    group.push(record)
    groups.set(key, group)
  }
  return [...groups.values()].filter(group => new Set(group.map(record => record.identity.countingOugc).filter(Boolean)).size > 1)
    .map(group => group.sort((a, b) => clean(a.identity.countingOugc).localeCompare(clean(b.identity.countingOugc))))
    .sort((a, b) => JSON.stringify(a[0].identity).localeCompare(JSON.stringify(b[0].identity)))
}

function validOldPrefill(response, source, records) {
  if (response.prefillData === null && response.prefillMetadata === null) return true
  const metadata = response.prefillMetadata
  if (metadata?.sourceSha256 !== source.source.sha256 || !Array.isArray(metadata.rows)
    || metadata.rows.some(row => !rowsOf(records).includes(row))) return false
  // The old historical repair only wrote meter proposals. Never distribute a
  // previously entered/aggregated need or comment over several new responses.
  const data = response.prefillData
  if (!data || Object.keys(data).some(key => !['meters', 'needs', 'comment'].includes(key)) || data.comment
    || Object.values(data.needs ?? {}).some(period => Object.keys(period).length)) return false
  return Array.isArray(data.meters) && data.meters.length <= 1 && data.meters.every(meter => !meter.compteurId
    && Object.keys(meter).every(key => ['compteurId', 'serialNumber', 'offSeason', 'season'].includes(key))
    && Object.keys(meter.season ?? {}).length === 0
    && Object.keys(meter.offSeason ?? {}).every(key => key === 'indexStart')
    && records.some(record => clean(record.identity.serialNumber) === clean(meter.serialNumber)
      && record.reading?.index === meter.offSeason?.indexStart))
}

function destinations(source, state, original, records) {
  const {campaign, usages, absentSerialNumbers} = state
  const anonymousIndexes = records.filter(record => !record.identity.serialNumber && record.reading)
    .map(record => record.reading.index)
  const readingNeedsReview = new Set(anonymousIndexes).size !== anonymousIndexes.length
  return records.map((record, index) => {
    const key = JSON.stringify([original.exploitation.pointPrelevementId, original.preleveurUserId, record.identity.countingOugc])
    const exploitationId = index === 0 ? original.exploitationId : stableId(`${OPERATION}:exploitation:${key}`)
    const responseId = index === 0 ? original.id : stableId(`${OPERATION}:response:${campaign.id}:${key}`)
    const exploitationData = {...Object.fromEntries(CLONE_FIELDS.map(field => [field, original.exploitation[field]])),
      countingCode: record.identity.countingOugc}
    const virtual = {...original, id: responseId, exploitationId, prefillData: null, prefillMetadata: null,
      exploitation: {...original.exploitation, ...exploitationData, id: exploitationId}}
    const proposal = buildCampaignPrefillPlan(source, [virtual], usages, [], {absentSerialNumbers}).entries[0]
    if (!proposal || !['PREFILL', 'EMPTY'].includes(proposal.action)) return null
    const meters = structuredClone(proposal.prefillData?.meters ?? [])
    // A repeated anonymous index may be a copied spreadsheet value, not two
    // independently identified observations. Restore the counting identities but
    // leave their readings to confirm; never attach the repeated value twice.
    if (readingNeedsReview) for (const meter of meters) delete meter.offSeason.indexStart
    return {exploitationId, responseId, isOriginal: index === 0, countingCode: record.identity.countingOugc,
      countingAeag: record.identity.countingAeag, sourceId: index === 0 ? original.exploitation.sourceId : `dropt-counting-repair:${digest(key)}`,
      exploitationData, collectors: original.exploitation.collecteurs.map(link => link.collecteurUserId).sort(),
      secondaryUsageIds: original.exploitation.secondaryUsageLinks.map(link => link.usageId).sort(),
      // This operation repairs counting identities/index proposals, not needs.
      // Authorization needs can be repeated across source rows: never copy them.
      prefillData: {meters, needs: {season: {}, offSeason: {}}, comment: ''},
      prefillMetadata: {version: 1, sourceSha256: source.source.sha256, rows: record.sourceRows,
        fields: ['meters'], sourceIndexDate: '2025-10-31',
        ...(readingNeedsReview ? {readingNeedsReview: true, readingReviewReason: 'SHARED_INDEX_WITHOUT_PHYSICAL_IDENTITY'} : {}),
        countingRepair: {version: 1, originExploitationId: original.exploitationId,
          countingOugc: record.identity.countingOugc, countingAeag: record.identity.countingAeag}}}
  })
}

function originalExclusion(original, {exploitations, unassignedChunks, campaign}) {
  const exploitation = original.exploitation
  if (!untouched(original)) return 'RESPONSE_ALREADY_STARTED'
  if (!exploitation.sourceId?.startsWith('dropt-epidropt:exploitation:') || exploitation.endDate
    || !['EN_ACTIVITE', 'NON_RENSEIGNE'].includes(exploitation.status) || exploitation.pointPrelevement.deletedAt
    || exploitation.declarant.user.deletedAt || original.preleveurUserId !== exploitation.declarantUserId) return 'INACTIVE_OR_NON_IMPORTED_IDENTITY'
  const siblings = exploitations.filter(item => item.pointPrelevementId === exploitation.pointPrelevementId
    && item.declarantUserId === exploitation.declarantUserId)
  if (siblings.length !== 1 || siblings[0].id !== exploitation.id) return 'EXISTING_SIBLING_EXPLOITATIONS'
  if (DEPENDENCIES.some(key => exploitation._count?.[key] !== 0)
    || exploitation._count.collectionResponses !== 1 || exploitation.mostRecentAvailableDate
    || unassignedChunks.some(chunk => chunk.pointPrelevementId === exploitation.pointPrelevementId
      && chunk.preleveurUserId === exploitation.declarantUserId)) return 'EXISTING_DEPENDENCIES_OR_HISTORY'
  if (!exploitation.collecteurs.some(link => link.collecteurUserId === campaign.collecteurUserId)) return 'MISSING_COLLECTOR_DELEGATION'
  return null
}

/** Only exact point + owner + counting identities can split an untouched import.
 * Equal indexes or absent serials never prove that two counting codes are equal.
 * No physical meters, histories, allocations or published volumes are changed.
 */
export function buildCampaignCountingRepairPlan(source, state) {
  const {campaign, responses, exploitations, usages, absentSerialNumbers = [], unassignedChunks = []} = state
  const entries = []
  for (const records of sourceGroups(source)) {
    const identity = records[0].identity
    const base = {pointOugc: identity.pointOugc, siret: identity.siret, rows: rowsOf(records),
      countingCodes: records.map(record => record.identity.countingOugc)}
    const reject = reason => entries.push({...base, action: 'EXCLUDED', reason})
    const matches = responses.filter(response => names(response.exploitation).includes(identity.pointOugc)
      && clean(response.exploitation.declarant.siret) === identity.siret)
    if (!matches.length) { reject('NO_EXACT_PARTICIPANT'); continue }
    if (records.some(record => !record.eligible || record.sourceRows.length !== 1 || !record.identity.countingAeag)
      || new Set(records.map(record => record.identity.countingAeag)).size !== records.length) {
      reject('AMBIGUOUS_SOURCE_COUNTINGS'); continue
    }
    const serials = records.map(record => campaignSerialKey(record.identity.serialNumber)).filter(Boolean)
    if (new Set(serials).size !== serials.length) { reject('SHARED_PHYSICAL_SERIAL'); continue }
    if (serials.some(serial => !absentSerialNumbers.map(campaignSerialKey).includes(serial))) {
      reject('EXISTING_OR_UNVERIFIED_PHYSICAL_SERIAL'); continue
    }
    const replay = matches.length === records.length && records.every(record => matches.some(response =>
      response.exploitation.countingCode === record.identity.countingOugc
      && response.prefillMetadata?.sourceSha256 === source.source.sha256
      && response.prefillMetadata?.countingRepair?.countingOugc === record.identity.countingOugc
      && response.prefillMetadata?.countingRepair?.countingAeag === record.identity.countingAeag))
    if (replay) { entries.push({...base, action: 'ALREADY_APPLIED', responseIds: matches.map(response => response.id).sort()}); continue }
    if (matches.length !== 1 || clean(matches[0].exploitation.countingCode)) { reject('AMBIGUOUS_EXISTING_EXPLOITATIONS'); continue }
    const original = matches[0]
    const exploitation = original.exploitation
    const reason = originalExclusion(original, {exploitations, unassignedChunks, campaign})
    if (reason) { reject(reason); continue }
    const proposed = destinations(source, {...state, usages, absentSerialNumbers}, original, records)
    if (proposed.some(item => !item)) { reject('NO_UNAMBIGUOUS_PREFILL'); continue }
    if (!validOldPrefill(original, source, records)) { reject('PRESERVED_PREFILL'); continue }
    entries.push({...base, action: 'SPLIT', originalResponseId: original.id, originalExploitationId: exploitation.id,
      pointPrelevementId: exploitation.pointPrelevementId, preleveurUserId: original.preleveurUserId, destinations: proposed})
  }
  // A source alias must not cause the same legacy response to be split twice.
  const duplicates = entries.filter(entry => entry.action === 'SPLIT').map(entry => entry.originalResponseId)
  for (const entry of entries) {
    if (entry.action === 'SPLIT' && duplicates.filter(id => id === entry.originalResponseId).length > 1) {
      entry.action = 'EXCLUDED'
      entry.reason = 'MULTIPLE_SOURCE_GROUPS_FOR_RESPONSE'
      delete entry.destinations
    }
  }
  return {entries, counts: {SPLIT: entries.filter(entry => entry.action === 'SPLIT').length,
    ALREADY_APPLIED: entries.filter(entry => entry.action === 'ALREADY_APPLIED').length,
    EXCLUDED: entries.filter(entry => entry.action === 'EXCLUDED').length,
    newResponses: entries.filter(entry => entry.action === 'SPLIT').reduce((sum, entry) => sum + entry.destinations.length - 1, 0)}}
}

async function snapshot(tx, source, campaignId, actorUserId) {
  const actor = await tx.user.findUnique({where: {id: actorUserId}, select: {id: true, role: true, deletedAt: true}})
  requireCondition(actor?.role === 'ADMIN' && !actor.deletedAt, 'Un administrateur actif est requis.')
  const campaign = await tx.collectionCampaign.findUnique({where: {id: campaignId}})
  requireCondition(campaign?.type === COLLECTION_CAMPAIGN_TYPE && campaign.status !== 'ARCHIVED' && !campaign.closedAt,
    'Campagne Dropt introuvable ou terminée.')
  const responses = await tx.collectionResponse.findMany({where: {campaignId}, orderBy: {id: 'asc'}, include: {exploitation: {include: {
    pointPrelevement: {select: {id: true, name: true, otherNames: true, deletedAt: true}},
    declarant: {select: {siret: true, user: {select: {deletedAt: true}}}},
    meterAllocations: {orderBy: {id: 'asc'}, include: {compteur: {select: {id: true, serialNumber: true, deletedAt: true}}}},
    collecteurs: {orderBy: {id: 'asc'}}, secondaryUsageLinks: {orderBy: {usageId: 'asc'}},
    _count: {select: Object.fromEntries([...DEPENDENCIES, 'collectionResponses'].map(key => [key, true]))}
  }}}})
  const pairs = responses.map(response => ({pointPrelevementId: response.exploitation.pointPrelevementId,
    declarantUserId: response.exploitation.declarantUserId}))
  const exploitations = pairs.length ? await tx.declarantPointPrelevement.findMany({where: {OR: pairs}, orderBy: {id: 'asc'}}) : []
  const unassignedChunks = pairs.length ? await tx.chunk.findMany({where: {exploitationId: null,
    OR: pairs.map(pair => ({pointPrelevementId: pair.pointPrelevementId, preleveurUserId: pair.declarantUserId}))},
  select: {id: true, pointPrelevementId: true, preleveurUserId: true}, orderBy: {id: 'asc'}}) : []
  const usages = await tx.sandreWaterUse.findMany({select: {id: true, code: true}, orderBy: {code: 'asc'}})
  const absentSerialNumbers = await findAbsentCampaignSerialNumbers(tx, source.records.map(record => record.identity.serialNumber))
  return {actor, campaign, responses, exploitations, unassignedChunks, usages, absentSerialNumbers}
}

function assertOptions(source, options) {
  requireCondition(['local', 'testing', 'demo', 'prod'].includes(options.target), 'Cible de réparation inconnue.')
  requireCondition(options.allowCountingSplit === true, 'Autorisation explicite --allow-counting-split requise.')
  requireCondition(/^[a-f0-9]{64}$/.test(source.source?.sha256 ?? ''), 'Empreinte source manquante.')
}

function assertReport(report, source, options, applied) {
  requireCondition(report?.version === 1 && report.operation === OPERATION && report.complete === true
    && report.applied === applied && report.target === options.target && report.campaignId === options.campaignId
    && report.actorUserId === options.actorUserId && report.sourceSha256 === source.source.sha256
    && report.allowCountingSplit === true && typeof report.planHash === 'string' && Array.isArray(report.entries),
  'Rapport de réparation incompatible avec la source, la cible, la campagne ou l’administrateur.')
}

async function assertConnectedTarget(client, target) {
  if (target === 'prod') await assertConnectedProdAdminDatabase(client)
  if (target === 'testing') await assertConnectedTestingAdminDatabase(client)
  if (target === 'demo') await assertConnectedDemoAdminDatabase(client)
}

export async function repairCampaignCountings(client, source, options = {}) {
  assertOptions(source, options)
  const {campaignId, actorUserId, target, apply = false, expectedReport, transactionTimeoutSeconds, onBeforeApply} = options
  if (apply) {
    assertReport(expectedReport, source, options, false)
    requireCondition(typeof onBeforeApply === 'function', 'Sauvegarde privée avant application requise.')
  }
  return client.$transaction(async tx => {
    if (!apply) await tx.$executeRaw`SET TRANSACTION READ ONLY`
    await assertConnectedTarget(tx, target)
    if (apply) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('collection-campaign'), hashtext(${campaignId}))`
      await tx.$queryRaw`SELECT id FROM "CollectionCampaign" WHERE id = ${campaignId}::uuid FOR UPDATE`
      // Lock existing parents too: allocations/delegations and response writes
      // cannot be inserted via foreign keys while their identities are repaired.
      await tx.$queryRaw`SELECT d.id FROM "DeclarantPointPrelevement" d
        JOIN "CollectionResponse" r ON r."exploitationId" = d.id
        WHERE r."campaignId" = ${campaignId}::uuid ORDER BY d.id FOR UPDATE OF d, r`
    }
    const state = await snapshot(tx, source, campaignId, actorUserId)
    const plan = buildCampaignCountingRepairPlan(source, state)
    const planHash = hash({state, plan, sourceSha256: source.source.sha256, campaignId, actorUserId, target, allowCountingSplit: true})
    requireCondition(!expectedReport || expectedReport.planHash === planHash, 'État modifié depuis la simulation ; aucune modification conservée.')
    const report = {version: 1, operation: OPERATION, target, campaignId, actorUserId, sourceSha256: source.source.sha256,
      allowCountingSplit: true, planHash, applied: apply, complete: true, ...plan, before: state}
    if (apply) {
      // The caller must durably write this private backup before any mutation.
      await onBeforeApply({...report, applied: false})
      for (const entry of plan.entries.filter(item => item.action === 'SPLIT')) {
        for (const destination of entry.destinations) {
          if (destination.isOriginal) {
            await tx.declarantPointPrelevement.update({where: {id: destination.exploitationId}, data: {countingCode: destination.countingCode}})
            await tx.collectionResponse.update({where: {id: destination.responseId}, data: {
              prefillData: destination.prefillData, prefillMetadata: destination.prefillMetadata}})
          } else {
            // No upsert: a collision or concurrent import must abort, never overwrite.
            await tx.declarantPointPrelevement.create({data: {id: destination.exploitationId,
              sourceId: destination.sourceId, ...destination.exploitationData,
              collecteurs: {create: destination.collectors.map(collecteurUserId => ({collecteurUserId}))},
              secondaryUsageLinks: {create: destination.secondaryUsageIds.map(usageId => ({usageId}))}}})
            await tx.collectionResponse.create({data: {id: destination.responseId, campaignId,
              exploitationId: destination.exploitationId, preleveurUserId: entry.preleveurUserId,
              prefillData: destination.prefillData, prefillMetadata: destination.prefillMetadata}})
          }
        }
      }
    }
    return report
  }, {isolationLevel: 'Serializable', maxWait: 10_000, timeout: getTransactionTimeoutMs(transactionTimeoutSeconds)})
}

export async function verifyCampaignCountingRepair(client, source, options = {}) {
  assertOptions(source, {...options, allowCountingSplit: options.expectedReport?.allowCountingSplit})
  assertReport(options.expectedReport, source, options, true)
  await assertConnectedTarget(client, options.target)
  const state = await snapshot(client, source, options.campaignId, options.actorUserId)
  const issues = []
  const expected = options.expectedReport.entries.filter(entry => entry.action === 'SPLIT').flatMap(entry => entry.destinations)
  for (const destination of expected) {
    const response = state.responses.find(item => item.id === destination.responseId)
    const exploitation = response?.exploitation
    if (!response || response.exploitationId !== destination.exploitationId
      || hash(Object.fromEntries(CLONE_FIELDS.map(key => [key, exploitation[key]]))) !== hash(Object.fromEntries(CLONE_FIELDS.map(key => [key, destination.exploitationData[key]])))
      || exploitation.countingCode !== destination.countingCode || exploitation.sourceId !== destination.sourceId
      || response.preleveurUserId !== destination.exploitationData.declarantUserId
      || hash(exploitation.collecteurs.map(link => link.collecteurUserId).sort()) !== hash(destination.collectors)
      || hash(exploitation.secondaryUsageLinks.map(link => link.usageId).sort()) !== hash(destination.secondaryUsageIds)
      || hash(response.prefillData) !== hash(destination.prefillData) || hash(response.prefillMetadata) !== hash(destination.prefillMetadata)) {
      issues.push({code: 'REPAIR_VERIFICATION_FAILED', responseId: destination.responseId})
    }
  }
  return {version: 1, operation: 'verify-campaign-countings', target: options.target, campaignId: options.campaignId,
    sourceSha256: source.source.sha256, applied: false, complete: issues.length === 0,
    counts: {verified: expected.length - issues.length}, issues}
}
