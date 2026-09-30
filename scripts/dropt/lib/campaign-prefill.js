import {Prisma} from '@prisma/client'
import {digest} from './epidropt.js'
import {getTransactionTimeoutMs} from './import-options.js'
import {validateCollectionResponseData, COLLECTION_CAMPAIGN_TYPE} from '../../../lib/validation/collection-campaigns.js'
import {getCompatibleMetricTypeCodes} from '../../../lib/constants/metric-type-codes.js'
import {CAMPAIGN_READING_DATES} from '../../../lib/services/campaign-readings.js'
import {campaignSerialKey, findAbsentCampaignSerialNumbers} from '../../../lib/services/campaign-meter-proposals.js'

const clean = value => String(value ?? '').trim()
const stateHash = value => digest(JSON.parse(JSON.stringify(value)))
const requireCondition = (condition, message) => { if (!condition) throw new Error(message) }
const assertTarget = target => requireCondition(['local', 'testing', 'prod'].includes(target), 'Cible de préremplissage local, testing ou prod requise.')
const untouched = response => response.revision === 0 && response.draftData === null && response.submittedData === null
  && !response.firstSubmittedAt && !response.lastSubmittedAt && !response.submittedHash && !response.declarationId && response.publicationStatus === 'NOT_SUBMITTED'
const sourceRows = records => [...new Set(records.flatMap(record => record.sourceRows))].sort((a, b) => a - b)

function pointNames(exploitation) {
  return new Set([exploitation.pointPrelevement.name, ...(exploitation.pointPrelevementNameAliases ?? []),
    ...(exploitation.pointPrelevement.otherNames ?? '').split('|')].map(clean).filter(Boolean))
}

function active(response) {
  const exploitation = response.exploitation
  return response.preleveurUserId === exploitation.declarantUserId && !exploitation.pointPrelevement.deletedAt
    && !exploitation.declarant.user.deletedAt && !exploitation.endDate
    && ['EN_ACTIVITE', 'NON_RENSEIGNE'].includes(exploitation.status)
}

function matchMeter(record, response) {
  const meters = [...new Map(response.exploitation.meterAllocations.filter(link => !link.compteur.deletedAt)
    .map(link => [link.compteur.id, link.compteur])).values()]
  const candidates = record.identity.serialNumber
    ? meters.filter(meter => clean(meter.serialNumber) === record.identity.serialNumber)
    : meters
  return candidates.length === 1 ? candidates[0] : null
}

function matchResponses(identity, responses, names) {
  return responses.filter(response => active(response)
    && clean(response.exploitation.declarant.siret) === identity.siret
    && clean(response.exploitation.countingCode) === identity.countingOugc
    && names.get(response.id).has(identity.pointOugc))
}

function indexSources(record) {
  if (record.indexSources) return record.indexSources
  const values = record.indexEvidenceValues ?? (record.indexEvidence == null ? [] : [record.indexEvidence])
  return values.map(indexEvidence => ({identity: record.identity, indexEvidence}))
}

function mapSourceRecords(records, responses, issues) {
  const byResponse = new Map()
  const byMeter = new Map()
  const bySerial = new Map()
  const matchedRecordCounts = new Map()
  const names = new Map(responses.map(response => [response.id, pointNames(response.exploitation)]))
  for (const record of records) {
    // A rejected duplicate can name several meters. Map each original row's
    // evidence before checking eligibility, not all values to its first serial.
    for (const evidence of indexSources(record)) {
      if (evidence.indexEvidence == null) continue
      const serial = campaignSerialKey(evidence.identity.serialNumber)
      if (serial) {
        const values = bySerial.get(serial) ?? new Set()
        values.add(evidence.indexEvidence)
        bySerial.set(serial, values)
      }
      const owners = matchResponses(evidence.identity, responses, names)
      const meter = owners.length === 1 ? matchMeter(evidence, owners[0]) : null
      if (!meter) continue
      const values = byMeter.get(meter.id) ?? new Set()
      values.add(evidence.indexEvidence)
      byMeter.set(meter.id, values)
    }
    const candidates = matchResponses(record.identity, responses, names)
    if (candidates.length !== 1) {
      issues.push({code: candidates.length ? 'ambiguous_response' : 'unmatched_response', sourceRows: record.sourceRows})
      continue
    }
    const response = candidates[0]
    matchedRecordCounts.set(response.id, (matchedRecordCounts.get(response.id) ?? 0) + 1)
    if (!record.eligible) continue
    const group = byResponse.get(response.id) ?? []
    group.push({record, meter: matchMeter(record, response)})
    byResponse.set(response.id, group)
  }
  return {byResponse, byMeter, bySerial, matchedRecordCounts}
}

function mergeField(destination, key, value) {
  if (Object.hasOwn(destination, key) && destination[key] !== value) return true
  destination[key] = value
  return false
}

function addNeedsProposal(needs, record, useIds, issues) {
  let conflicting = false
  for (const period of ['season', 'offSeason']) {
    for (const [key, value] of Object.entries(record.needs[period] ?? {})) {
      if (key === 'usageCode' && !useIds.has(value)) {
        issues.push({code: 'usage_reference_missing', field: `needs.${period}.usageId`, sourceRows: record.sourceRows})
        continue
      }
      conflicting = mergeField(needs[period], key === 'usageCode' ? 'usageId' : key,
        key === 'usageCode' ? useIds.get(value) : value) || conflicting
    }
  }
  return conflicting
}

function observedReadingIssue(record, meter, response, observations) {
  const existing = observations.filter(value => value.chunk.compteurId === meter.id)
  if (existing.some(value => String(value.value) !== record.reading.index)) return 'existing_index_conflict'
  // Another beneficiary's consistent physical index is not exposed by the
  // runtime. Keep this beneficiary's own source proposal when no own value exists.
  const own = existing.some(value => value.chunk.exploitationId === response.exploitationId
    && value.chunk.preleveurUserId === response.preleveurUserId)
  return own ? 'existing_index_preserved' : null
}

function addIndexProposal(data, {record, meter}, {response, byMeter, bySerial, observations, issues, allowUnallocated}) {
  if (!record.reading) return false
  if (!meter && allowUnallocated) {
    data.meters.push({compteurId: null, serialNumber: record.identity.serialNumber ?? null, offSeason: {indexStart: record.reading.index}, season: {}})
    return false
  }
  const issue = !meter ? (bySerial.get(campaignSerialKey(record.identity.serialNumber))?.size > 1 ? 'source_serial_index_conflict' : 'unresolved_meter')
    : byMeter.get(meter.id)?.size > 1 ? 'mapped_meter_index_conflict'
      : observedReadingIssue(record, meter, response, observations)
  if (issue) {
    issues.push({code: issue, sourceRows: record.sourceRows})
    return false
  }
  let target = data.meters.find(item => item.compteurId === meter.id)
  if (!target) {
    target = {compteurId: meter.id, serialNumber: meter.serialNumber ?? '', offSeason: {}, season: {}}
    data.meters.push(target)
  }
  return mergeField(target.offSeason, 'indexStart', record.reading.index)
}

function canProposeUnallocatedMeter(response, records, context) {
  // One source row can propose an unanswered meter, never establish its physical
  // identity. Existing (even deleted) allocations and other source evidence must
  // not be replaced with a proposed meter. A source serial requires explicit
  // evidence that it does not already identify any physical meter.
  const serial = campaignSerialKey(records[0]?.identity.serialNumber)
  return records.length === 1 && context.matchedRecordCounts.get(response.id) === 1
    && records[0].sourceRows.length === 1
    && (!serial || (context.absentSerialNumbers.has(serial) && context.bySerial.get(serial)?.size === 1))
    && response.exploitation.meterAllocations.length === 0
    && !context.observations.some(value => value.chunk.exploitationId === response.exploitationId
      && value.chunk.preleveurUserId === response.preleveurUserId)
}

function proposalEntry(response, matches, context) {
  const {issues, useIds, sourceSha256} = context
  const records = matches.map(match => match.record)
  const rows = sourceRows(records)
  if (!untouched(response)) return {responseId: response.id, action: 'PRESERVED_RESPONSE', rows}
  const data = {meters: [], needs: {season: {}, offSeason: {}}, comment: ''}
  const allowUnallocated = canProposeUnallocatedMeter(response, records, context)
  let conflicting = false
  for (const match of matches) {
    conflicting = addNeedsProposal(data.needs, match.record, useIds, issues) || conflicting
    conflicting = addIndexProposal(data, match, {...context, response, allowUnallocated}) || conflicting
  }
  const authorizations = new Set(records.map(record => record.metadata.noAuthorizedOffSeasonUsage))
  if (conflicting || authorizations.size > 1) {
    issues.push({code: 'conflicting_response_proposals', sourceRows: rows})
    return {responseId: response.id, action: 'EXCLUDED_CONFLICT', rows}
  }
  data.meters.sort((a, b) => (a.compteurId ?? '').localeCompare(b.compteurId ?? ''))
  const hasData = data.meters.length || Object.values(data.needs).some(period => Object.keys(period).length)
  const noAuthorizedOffSeasonUsage = records[0].metadata.noAuthorizedOffSeasonUsage === true
  if (!hasData && !noAuthorizedOffSeasonUsage) return {responseId: response.id, action: 'EMPTY', rows}
  const prefillData = validateCollectionResponseData(data)
  const prefillMetadata = {version: 1, sourceSha256, rows, noAuthorizedOffSeasonUsage}
  const alreadySame = response.prefillData !== null && stateHash(response.prefillData) === stateHash(prefillData)
    && stateHash(response.prefillMetadata) === stateHash(prefillMetadata)
  const action = alreadySame ? 'ALREADY_APPLIED' : response.prefillData !== null || response.prefillMetadata !== null ? 'PRESERVED_PREFILL' : 'PREFILL'
  return {responseId: response.id, exploitationId: response.exploitationId, preleveurUserId: response.preleveurUserId,
    action, rows, ...(action === 'PREFILL' || action === 'ALREADY_APPLIED' ? {prefillData, prefillMetadata} : {})}
}

// Match the three independent identities exactly. Neither a shared point nor a
// counting code alone proves ownership. Never invent a meter from a source row.
export function buildCampaignPrefillPlan(source, responses, usages, observations = [], {absentSerialNumbers = []} = {}) {
  const issues = [...source.issues]
  const {byResponse, byMeter, bySerial, matchedRecordCounts} = mapSourceRecords(source.records, responses, issues)
  const context = {issues, byMeter, bySerial, matchedRecordCounts, observations,
    absentSerialNumbers: new Set(absentSerialNumbers.map(campaignSerialKey).filter(Boolean)),
    sourceSha256: source.source.sha256, useIds: new Map(usages.map(usage => [usage.code, usage.id]))}
  const entries = responses.flatMap(response => {
    const matches = byResponse.get(response.id)
    return matches ? [proposalEntry(response, matches, context)] : []
  })
  return {entries, issues, counts: Object.fromEntries(['PREFILL', 'ALREADY_APPLIED', 'PRESERVED_RESPONSE', 'PRESERVED_PREFILL', 'EXCLUDED_CONFLICT', 'EMPTY']
    .map(action => [action, entries.filter(entry => entry.action === action).length]))}
}

async function snapshot(tx, campaignId, actorUserId, source) {
  const actor = await tx.user.findUnique({where: {id: actorUserId}, select: {id: true, role: true, deletedAt: true}})
  requireCondition(actor?.role === 'ADMIN' && !actor.deletedAt, 'Un administrateur actif est requis pour le préremplissage.')
  const campaign = await tx.collectionCampaign.findUnique({where: {id: campaignId}})
  requireCondition(campaign?.type === COLLECTION_CAMPAIGN_TYPE && campaign.status !== 'ARCHIVED' && !campaign.closedAt,
    'Campagne Dropt introuvable ou terminée.')
  const responses = await tx.collectionResponse.findMany({where: {campaignId}, orderBy: {id: 'asc'}, include: {exploitation: {include: {
    pointPrelevement: {select: {id: true, name: true, otherNames: true, deletedAt: true}},
    declarant: {select: {siret: true, user: {select: {deletedAt: true}}}},
    meterAllocations: {orderBy: {id: 'asc'}, include: {compteur: {select: {id: true, serialNumber: true, deletedAt: true}}}}
  }}}})
  const usages = await tx.sandreWaterUse.findMany({select: {id: true, code: true}, orderBy: {code: 'asc'}})
  const observations = responses.length ? await tx.chunkValue.findMany({where: {valueKind: 'DECLARED',
    metricTypeCode: {in: getCompatibleMetricTypeCodes('index')}, periodStart: new Date(`${CAMPAIGN_READING_DATES[0]}T00:00:00Z`),
    chunk: {calculationStrategy: 'GENERIC', instructionStatus: {not: 'REJECTED'}, source: {status: 'COMPLETED'},
      OR: responses.map(response => ({exploitationId: response.exploitationId, preleveurUserId: response.preleveurUserId}))}},
  select: {id: true, value: true, chunk: {select: {compteurId: true, exploitationId: true, preleveurUserId: true}}}, orderBy: {id: 'asc'}}) : []
  const absentSerialNumbers = await findAbsentCampaignSerialNumbers(tx, source.records.map(record => record.identity.serialNumber))
  return {actor, campaign, responses, usages, observations, absentSerialNumbers}
}

function assertReport(report, source, options, applied) {
  requireCondition(report?.version === 1 && report.operation === 'prefill-campaign' && report.complete === true
    && report.applied === applied && report.sourceSha256 === source.source.sha256
    && report.target === options.target && report.campaignId === options.campaignId && report.actorUserId === options.actorUserId
    && typeof report.planHash === 'string' && Array.isArray(report.entries),
  'Rapport de préremplissage incompatible avec la source, la campagne, la cible ou l’administrateur.')
}

export async function prefillCampaign(client, source, {campaignId, actorUserId, target, apply = false, expectedReport, transactionTimeoutSeconds} = {}) {
  assertTarget(target)
  requireCondition(/^[a-f0-9]{64}$/.test(source.source?.sha256 ?? ''), 'Empreinte de la source manquante.')
  if (apply) assertReport(expectedReport, source, {campaignId, actorUserId, target}, false)
  return client.$transaction(async tx => {
    // Same lock as manual draft/submission: inspect and write one immutable plan.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('collection-campaign'), hashtext(${campaignId}))`
    await tx.$queryRaw`SELECT id FROM "CollectionCampaign" WHERE id = ${campaignId}::uuid FOR UPDATE`
    const state = await snapshot(tx, campaignId, actorUserId, source)
    const plan = buildCampaignPrefillPlan(source, state.responses, state.usages, state.observations, state)
    const planHash = stateHash({state, plan, sourceSha256: source.source.sha256, campaignId, actorUserId, target})
    requireCondition(!expectedReport || expectedReport.planHash === planHash, 'État modifié depuis la simulation ; relancer le préremplissage sans --apply.')
    if (apply) {
      for (const entry of plan.entries.filter(entry => entry.action === 'PREFILL')) {
        const updated = await tx.collectionResponse.updateMany({where: {id: entry.responseId, campaignId, revision: 0,
          draftData: {equals: Prisma.DbNull}, submittedData: {equals: Prisma.DbNull}, prefillData: {equals: Prisma.DbNull},
          prefillMetadata: {equals: Prisma.DbNull}, firstSubmittedAt: null, lastSubmittedAt: null, submittedHash: null, declarationId: null, publicationStatus: 'NOT_SUBMITTED'},
        data: {prefillData: entry.prefillData, prefillMetadata: entry.prefillMetadata}})
        requireCondition(updated.count === 1, 'Réponse modifiée pendant le préremplissage ; aucune modification conservée.')
      }
    }
    return {version: 1, operation: 'prefill-campaign', target, campaignId, actorUserId, sourceSha256: source.source.sha256,
      planHash, applied: apply, complete: true, ...plan}
  }, {isolationLevel: 'Serializable', maxWait: 10_000, timeout: getTransactionTimeoutMs(transactionTimeoutSeconds)})
}

export async function verifyCampaignPrefill(client, source, {campaignId, actorUserId, target, expectedReport} = {}) {
  assertTarget(target)
  assertReport(expectedReport, source, {campaignId, actorUserId, target}, true)
  const {responses} = await snapshot(client, campaignId, actorUserId, source)
  const byId = new Map(responses.map(response => [response.id, response]))
  const issues = []
  const expected = expectedReport.entries.filter(entry => ['PREFILL', 'ALREADY_APPLIED'].includes(entry.action))
  for (const entry of expected) {
    const response = byId.get(entry.responseId)
    if (!response || response.exploitationId !== entry.exploitationId || response.preleveurUserId !== entry.preleveurUserId
      || response.exploitation.declarantUserId !== entry.preleveurUserId || stateHash(response.prefillData) !== stateHash(entry.prefillData)
      || stateHash(response.prefillMetadata) !== stateHash(entry.prefillMetadata)) issues.push({code: 'prefill_verification_failed', responseId: entry.responseId})
  }
  return {version: 1, operation: 'verify-prefill-campaign', campaignId, target, sourceSha256: source.source.sha256,
    complete: issues.length === 0, applied: false, counts: {verified: expected.length - issues.length}, issues}
}
