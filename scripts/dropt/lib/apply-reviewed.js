import {applyRebuiltManifestInTransaction, validateManifest, verifyManifest} from './apply-epidropt.js'
import {consolidateReviewedInTransaction, inspectReviewedConsolidation, normalizeReviewedConsolidationPlan} from './consolidate-reviewed.js'
import {digest, stableId, SCOPE} from './epidropt.js'
import {getTransactionTimeoutMs} from './import-options.js'
import {assertRebuildTarget} from './rebuild-epidropt.js'

const OPERATION = 'apply-reviewed'
const POINT_PREFIX = 'dropt-epidropt:point:'
const EXPLOITATION_PREFIX = 'dropt-epidropt:exploitation:'
const COLLECTEUR_SOURCE_ID = 'dropt-epidropt:collecteur:ougc-dropt'
const hashPattern = /^[a-f\d]{64}$/
const unique = values => [...new Set(values.filter(Boolean))].sort()
const inIds = values => ({in: values})
const json = value => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? String(item) : item))
const stateDigest = value => digest(json(value))
const requireCondition = (condition, code) => { if (!condition) throw new Error(code) }

export function validateReviewedBackupEvidence(evidence, stateHash) {
  const backupSha256 = evidence?.backupSha256 ?? evidence?.backup?.sha256
  const restored = evidence?.restoreVerification ?? evidence?.restore
  requireCondition(evidence?.target === 'testing' && hashPattern.test(backupSha256 ?? '')
    && restored?.success === true && restored.matchesPreflight === true
    && hashPattern.test(evidence.reviewedStateHash ?? '') && evidence.reviewedStateHash === stateHash,
  'REVIEWED_VERIFIED_RESTORED_BACKUP_REQUIRED')
  return backupSha256
}

export function validateReviewedApplicationInput(manifest, options = {}) {
  validateManifest(manifest)
  requireCondition(manifest.complete !== false && manifest.points.length > 0, 'REVIEWED_MANIFEST_INCOMPLETE')
  requireCondition(['testing', 'restored-copy', 'disposable'].includes(options.target), 'REVIEWED_TARGET_FORBIDDEN')
  requireCondition(['activateAt', 'effectiveAt', 'serviceAccountId'].every(key => options[key] === undefined),
    'REVIEWED_ACTIVATION_OR_RECOMPUTATION_FORBIDDEN')
  const plan = normalizeReviewedConsolidationPlan(options.consolidationPlan ?? manifest.reviewedConsolidationPlan)
  const excludedPoints = [...plan.retirePointIds, ...plan.merges.map(item => item.sourcePointId)]
  const excludedExploitations = [...plan.retireExploitationIds, ...plan.merges.flatMap(item => item.exploitationMerges.map(pair => pair.sourceId))]
  requireCondition(!manifest.points.some(item => excludedPoints.includes(item.id))
    && !manifest.exploitations.some(item => excludedExploitations.includes(item.id)), 'REVIEWED_MANIFEST_REINTRODUCES_RETIRED_OBJECT')
  requireCondition(plan.merges.every(merge => manifest.points.some(item => item.id === merge.targetPointId)
    && merge.exploitationMerges.every(pair => manifest.exploitations.some(item => item.id === pair.targetId))),
  'REVIEWED_MANIFEST_MERGE_TARGET_MISSING')
  const {expectedReport, apply = false, target} = options
  requireCondition(!apply || expectedReport, 'REVIEWED_SIMULATION_REQUIRED')
  if (expectedReport) requireCondition(expectedReport.operation === OPERATION && expectedReport.target === target
    && expectedReport.manifestHash === manifest.manifestHash && expectedReport.consolidationPlanHash === digest(plan)
    && expectedReport.complete === true && expectedReport.applied === false
    && hashPattern.test(expectedReport.planHash ?? '') && hashPattern.test(expectedReport.stateHash ?? ''),
  'REVIEWED_SIMULATION_INCOMPATIBLE')
  return plan
}

// Fixed table/predicate/order expressions; only UUID arrays are bound parameters.
// Hash database rows in SQL: neither personal data nor raw readings enter reports.
async function fingerprint(tx, table, predicate, parameters, orderBy = 't.id') {
  const [result] = await tx.$queryRawUnsafe(`SELECT count(*)::int AS count,
    md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' ORDER BY ${orderBy}), '')) AS hash
    FROM "${table}" t WHERE ${predicate}`, ...parameters)
  return result
}

async function inspectExistingCollector(tx, exploitationIds) {
  const actor = await tx.declarant.findUnique({where: {sourceId: COLLECTEUR_SOURCE_ID},
    select: {userId: true, declarantRole: true, user: {select: {role: true, deletedAt: true}}}})
  if (!actor) return {id: null, eligible: false, reason: 'EXISTING_COLLECTOR_NOT_FOUND', previousExploitationIds: []}
  requireCondition(actor.declarantRole === 'COLLECTEUR' && actor.user?.role === 'DECLARANT' && !actor.user.deletedAt,
    'REVIEWED_EXISTING_COLLECTOR_INVALID')
  const links = await tx.declarantCollecteurExploitation.findMany({where: {collecteurUserId: actor.userId,
    exploitationId: inIds(exploitationIds)}, select: {exploitationId: true}, orderBy: {exploitationId: 'asc'}})
  return {id: actor.userId, eligible: links.length > 0,
    reason: links.length ? null : 'EXISTING_COLLECTOR_WITHOUT_DROPT_ACCESS', previousExploitationIds: links.map(item => item.exploitationId)}
}

async function inspectImportState(tx, manifest) {
  const importedPoints = await tx.pointPrelevement.findMany({where: {sourceId: {startsWith: POINT_PREFIX}},
    select: {id: true, deletedAt: true}, orderBy: {id: 'asc'}})
  const references = await tx.externalReference.findMany({where: {scope: SCOPE},
    select: {pointPrelevementId: true, declarantUserId: true, compteurId: true}})
  const pointIds = unique([...importedPoints.map(item => item.id), ...manifest.points.map(item => item.id), ...references.map(item => item.pointPrelevementId)])
  const exploitations = await tx.declarantPointPrelevement.findMany({where: {OR: [
    {pointPrelevementId: inIds(pointIds)}, {sourceId: {startsWith: EXPLOITATION_PREFIX}}, {id: inIds(manifest.exploitations.map(item => item.id))}
  ]}, select: {id: true, sourceId: true, declarantUserId: true, pointPrelevementId: true}, orderBy: {id: 'asc'}})
  const exploitationIds = exploitations.map(item => item.id)
  const importedIds = new Set(importedPoints.filter(item => !item.deletedAt).map(item => item.id))
  const collector = await inspectExistingCollector(tx, exploitations.filter(item => item.sourceId?.startsWith(EXPLOITATION_PREFIX)
    && importedIds.has(item.pointPrelevementId)).map(item => item.id))
  const ownerIds = unique([...manifest.declarants.map(item => item.id), ...references.map(item => item.declarantUserId),
    ...exploitations.map(item => item.declarantUserId), collector.id])
  const existingOwnerIds = (await tx.user.findMany({where: {id: inIds(ownerIds)}, select: {id: true}, orderBy: {id: 'asc'}}))
    .map(item => item.id)
  const allocations = await tx.meterAllocation.findMany({where: {exploitationId: inIds(exploitationIds)}, select: {compteurId: true}})
  const meterIds = unique([...manifest.meters.map(item => item.id), ...references.map(item => item.compteurId), ...allocations.map(item => item.compteurId)])
  const streams = await tx.meterStream.findMany({where: {compteurId: inIds(meterIds)},
    select: {id: true, compteurId: true, enabled: true, activatedAt: true}, orderBy: {id: 'asc'}})
  const fingerprints = {}
  for (const [table, predicate, parameters, orderBy] of [
    ['PointPrelevement', 't.id = ANY($1::uuid[])', [pointIds]],
    ['PointPrelevementZone', 't."pointPrelevementId" = ANY($1::uuid[])', [pointIds]],
    ['DeclarantPointPrelevement', 't.id = ANY($1::uuid[])', [exploitationIds]],
    ['Declarant', 't."userId" = ANY($1::uuid[])', [ownerIds], 't."userId"'],
    ['User', 't.id = ANY($1::uuid[])', [ownerIds]],
    ['DeclarantContactEmail', 't."declarantUserId" = ANY($1::uuid[])', [ownerIds]],
    ['DeclarantCollecteurExploitation', 't."exploitationId" = ANY($1::uuid[])', [exploitationIds]],
    ['ExternalReference', 't.scope = $1 OR t."pointPrelevementId" = ANY($2::uuid[]) OR t."declarantUserId" = ANY($3::uuid[]) OR t."compteurId" = ANY($4::uuid[])', [SCOPE, pointIds, ownerIds, meterIds]],
    ['Compteur', 't.id = ANY($1::uuid[])', [meterIds]],
    ['MeterAllocation', 't."compteurId" = ANY($1::uuid[])', [meterIds]],
    ['MeterAllocationVersion', 't."allocationId" IN (SELECT id FROM "MeterAllocation" WHERE "compteurId" = ANY($1::uuid[]))', [meterIds]],
    ['MeterStream', 't."compteurId" = ANY($1::uuid[])', [meterIds]],
    ['MeterReading', 't."compteurId" = ANY($1::uuid[])', [meterIds]],
    ['MeterReadingRevision', 't."readingId" IN (SELECT id FROM "MeterReading" WHERE "compteurId" = ANY($1::uuid[]))', [meterIds]],
    ['MeterPublication', 't."compteurId" = ANY($1::uuid[])', [meterIds]]
  ]) fingerprints[table] = await fingerprint(tx, table, predicate, parameters, orderBy)
  // Ignore technical timestamps in SAGE settings, which are configured separately
  // on the restored copy and target. Geometry and resource classification count.
  const zones = await tx.$queryRaw`SELECT id, type, code, "managedResourceType", md5(ST_AsEWKB(coordinates)::text) AS geometry
    FROM "Zone" ORDER BY id`
  fingerprints.ZoneSettings = {count: zones.length, hash: stateDigest(zones)}
  return {pointIds, activePointIds: importedPoints.filter(item => !item.deletedAt).map(item => item.id),
    exploitationIds, ownerIds, existingOwnerIds, meterIds, streams, collector, fingerprints}
}

export async function inspectReviewedApplication(tx, manifest, consolidationPlan, {target} = {}) {
  validateManifest(manifest)
  await assertRebuildTarget(tx, target)
  const plan = normalizeReviewedConsolidationPlan(consolidationPlan ?? manifest.reviewedConsolidationPlan)
  const consolidation = await inspectReviewedConsolidation(tx, plan, {target})
  const scope = await inspectImportState(tx, manifest)
  return {operation: OPERATION, target, manifestHash: manifest.manifestHash, consolidationPlanHash: digest(plan),
    stateHash: digest({consolidationStateHash: consolidation.stateHash, fingerprints: scope.fingerprints, collector: scope.collector}),
    consolidation, scope, complete: consolidation.complete}
}

async function addExistingCollectorLinks(tx, before, imported, manifest) {
  const createdIds = imported.objectIds.exploitations.filter(id => !before.exploitationIds.includes(id))
  if (!before.collector.eligible) return {...before.collector, addedExploitationIds: []}
  const mappings = new Map(imported.mappings.exploitations.map(item => [item.id, item.manifestId]))
  requireCondition(createdIds.every(id => manifest.exploitations.some(item => item.id === mappings.get(id)
    && item.sourceId?.startsWith(EXPLOITATION_PREFIX))), 'REVIEWED_COLLECTOR_NEW_EXPLOITATION_OUTSIDE_MANIFEST')
  const existing = await tx.declarantCollecteurExploitation.findMany({where: {collecteurUserId: before.collector.id,
    exploitationId: inIds(createdIds)}, select: {exploitationId: true}})
  const addedExploitationIds = createdIds.filter(id => !existing.some(item => item.exploitationId === id)).sort()
  if (addedExploitationIds.length) await tx.declarantCollecteurExploitation.createMany({data: addedExploitationIds.map(exploitationId => ({
    id: stableId(`dropt-reviewed:collector-link:${before.collector.id}:${exploitationId}`),
    collecteurUserId: before.collector.id, exploitationId
  }))})
  return {...before.collector, addedExploitationIds}
}

async function assertPostconditions(tx, before, consolidation, imported, plan) {
  const points = await tx.pointPrelevement.findMany({where: {id: inIds(before.activePointIds), deletedAt: null}, select: {id: true}})
  const exploitations = await tx.declarantPointPrelevement.findMany({where: {id: inIds(before.exploitationIds)}, select: {id: true}})
  const allowedPoints = [...consolidation.actions.merges.map(item => item.sourcePointId), ...consolidation.actions.retirePointIds]
  const allowedExploitations = [...consolidation.actions.mergeExploitations.map(item => item.sourceId), ...consolidation.actions.retireExploitationIds]
  requireCondition(before.activePointIds.every(id => points.some(item => item.id === id) || allowedPoints.includes(id))
    && before.exploitationIds.every(id => exploitations.some(item => item.id === id) || allowedExploitations.includes(id)),
  'REVIEWED_UNPLANNED_REMOVAL')
  for (const [table, predicate, parameters] of [
    ['User', 't.id = ANY($1::uuid[])', [before.existingOwnerIds]],
    ['MeterReading', 't."compteurId" = ANY($1::uuid[])', [before.meterIds]],
    ['MeterReadingRevision', 't."readingId" IN (SELECT id FROM "MeterReading" WHERE "compteurId" = ANY($1::uuid[]))', [before.meterIds]]
  ]) requireCondition(stateDigest(await fingerprint(tx, table, predicate, parameters)) === stateDigest(before.fingerprints[table]),
    'REVIEWED_PROTECTED_DATA_CHANGED')
  const streams = await tx.meterStream.findMany({where: {compteurId: inIds(unique([...before.meterIds, ...imported.objectIds.meters]))},
    select: {id: true, compteurId: true, enabled: true, activatedAt: true}})
  requireCondition(streams.every(stream => {
    const previous = before.streams.find(item => item.id === stream.id)
    if (plan.resetMeterIds.includes(stream.compteurId)) return !stream.enabled && !stream.activatedAt
    return (!stream.enabled || previous?.enabled) && stateDigest(stream.activatedAt ?? null) === stateDigest(previous?.activatedAt ?? null)
  }), 'REVIEWED_UNEXPECTED_STREAM_ACTIVATION')
}

export async function applyReviewedManifest(client, manifest, options = {}) {
  const plan = validateReviewedApplicationInput(manifest, options)
  const {target, apply = false, expectedReport, backupEvidence, transactionTimeoutSeconds} = options
  const rollback = new Error('REVIEWED_APPLICATION_ROLLBACK')
  let result
  try {
    return await client.$transaction(async tx => {
      await assertRebuildTarget(tx, target)
      await tx.$executeRaw`SET LOCAL lock_timeout = '10s'`
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('dropt-referential'), hashtext(${SCOPE}))`
      const before = await inspectReviewedApplication(tx, manifest, plan, {target})
      result = {operation: OPERATION, target, manifestHash: manifest.manifestHash, consolidationPlanHash: digest(plan),
        stateHash: before.stateHash, applied: false, complete: false, consolidation: before.consolidation,
        activationPerformed: false, recomputationPerformed: false}
      if (!before.complete) throw rollback
      requireCondition(!expectedReport || expectedReport.stateHash === before.stateHash, 'REVIEWED_STATE_CHANGED_SINCE_SIMULATION')
      const backupSha256 = apply ? validateReviewedBackupEvidence(backupEvidence, before.stateHash) : null
      const consolidation = await consolidateReviewedInTransaction(tx, plan, {target, expectedReport: before.consolidation})
      const imported = await applyRebuiltManifestInTransaction(tx, manifest, {transactionTimeoutSeconds})
      result = {...result, consolidation, imported, counts: imported.counts, changes: imported.changes,
        mappings: imported.mappings, objectIds: imported.objectIds, executionIssues: imported.executionIssues}
      if (!imported.complete) throw rollback
      const collector = await addExistingCollectorLinks(tx, before.scope, imported, manifest)
      const verification = await verifyManifest(tx, manifest, {report: imported})
      result = {...result, collector, verification}
      if (!verification.complete) throw rollback
      await assertPostconditions(tx, before.scope, consolidation, imported, plan)
      const planHash = digest({manifestHash: manifest.manifestHash, consolidationPlanHash: before.consolidationPlanHash,
        stateHash: before.stateHash, importPlanHash: imported.planHash, collector, verification})
      requireCondition(!expectedReport || expectedReport.planHash === planHash, 'REVIEWED_PLAN_CHANGED_SINCE_SIMULATION')
      result = {...result, planHash, backupSha256, complete: true,
        pausedMeterIds: consolidation.meterIds, recomputationRequired: consolidation.counts.publicationsDeleted > 0}
      if (!apply) throw rollback
      return {...result, applied: true}
    }, {isolationLevel: 'Serializable', maxWait: 10_000, timeout: getTransactionTimeoutMs(transactionTimeoutSeconds)})
  } catch (error) {
    if (error === rollback) return result
    throw error
  }
}
