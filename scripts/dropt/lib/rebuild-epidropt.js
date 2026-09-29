import process from 'node:process'
import {applyRebuiltManifestInTransaction, verifyManifest} from './apply-epidropt.js'
import {digest, SCOPE} from './epidropt.js'
import {getTransactionTimeoutMs} from './import-options.js'
import {lockMeter, reprocessMeterStreamInTransaction} from '../../../lib/services/meter-publication.js'
import {requireDisposableDatabase} from '../../../lib/util/test-helpers/disposable-database.js'

const POINT_PREFIX = 'dropt-epidropt:point:'
const EXPLOITATION_PREFIX = 'dropt-epidropt:exploitation:'
const PROVIDERS = ['epidropt', 'rives-et-eaux']
const order = {id: 'asc'}
const ids = rows => rows.map(row => row.id).sort()
const inIds = rows => ({in: rows})
const requireCondition = (condition, code) => { if (!condition) throw new Error(code) }
const valueHash = value => digest(JSON.parse(JSON.stringify(value)))

export async function assertRebuildTarget(client, target) {
  const [identity] = await client.$queryRaw`SELECT current_database() AS name, current_user AS username,
    (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls`
  if (target === 'testing') {
    requireCondition(identity.name === 'testing-partageons-leau-api' && identity.username === 'testing-partageons-leau-api' && identity.tls,
      'REBUILD_TESTING_IDENTITY_OR_TLS_INVALID')
  } else if (target === 'disposable') {
    const url = requireDisposableDatabase()
    requireCondition(identity.name === decodeURIComponent(url.pathname.slice(1)), 'REBUILD_DISPOSABLE_IDENTITY_INVALID')
  } else if (target === 'restored-copy') {
    const url = new URL(process.env.DATABASE_URL)
    requireCondition(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      && url.port === '55439' && !url.search && !url.hash
      && /^(meter_backup_|dropt_rebuild_)[a-z0-9_]+$/.test(identity.name)
      && decodeURIComponent(url.pathname.slice(1)) === identity.name, 'REBUILD_RESTORED_COPY_INVALID')
  } else throw new Error('REBUILD_TARGET_FORBIDDEN')
  return {target, database: identity.name}
}

// Fixed table names and parameterized IDs only. Hash each row on the database:
// raw payloads and readings must not transit through logs or fill JS memory.
async function fingerprint(client, table, predicate, parameters) {
  const [result] = await client.$queryRawUnsafe(`SELECT count(*)::int AS count,
    md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' ORDER BY t.id), '')) AS hash
    FROM "${table}" t WHERE ${predicate}`, ...parameters)
  return result
}

export async function inspectRebuildScope(client, manifest) {
  requireCondition(manifest?.scope === SCOPE, 'REBUILD_SCOPE_INVALID')
  const points = await client.pointPrelevement.findMany({where: {sourceId: {startsWith: POINT_PREFIX}}, orderBy: order})
  requireCondition(points.length > 0, 'REBUILD_EMPTY_EXISTING_SCOPE')
  const pointIds = ids(points)
  const pointIdSet = new Set(pointIds)
  const pointReferences = await client.externalReference.findMany({where: {OR: [
    {pointPrelevementId: inIds(pointIds)}, {scope: SCOPE, kind: 'POINT'}
  ]}, orderBy: order})
  const exploitations = await client.declarantPointPrelevement.findMany({where: {OR: [
    {pointPrelevementId: inIds(pointIds)}, {sourceId: {startsWith: EXPLOITATION_PREFIX}}
  ]}, orderBy: order})
  const exploitationIds = ids(exploitations)
  const exploitationIdSet = new Set(exploitationIds)
  const errors = []
  const check = (valid, code, count) => { if (!valid) errors.push({code, ...(count === undefined ? {} : {count})}) }
  check(pointReferences.every(ref => ref.scope === SCOPE && ref.kind === 'POINT' && PROVIDERS.includes(ref.provider)
    && pointIdSet.has(ref.pointPrelevementId)), 'REBUILD_POINT_REFERENCE_OUTSIDE_SCOPE')
  check(points.every(point => pointReferences.some(ref => ref.pointPrelevementId === point.id && ref.provider === 'epidropt')),
    'REBUILD_POINT_PROVENANCE_MISSING')
  check(points.every(point => !point.deletedAt), 'REBUILD_DELETED_POINT')
  check(exploitations.every(item => item.sourceId?.startsWith(EXPLOITATION_PREFIX) && pointIdSet.has(item.pointPrelevementId)),
    'REBUILD_EXPLOITATION_OUTSIDE_SCOPE')
  check(exploitations.every(item => item.status === 'NON_RENSEIGNE' && !item.startDate && !item.endDate && !item.comment && !item.abandonReason),
    'REBUILD_MANUAL_EXPLOITATION_FIELDS')
  const geometry = await client.$queryRaw`SELECT id, ST_X(coordinates) AS x, ST_Y(coordinates) AS y FROM "PointPrelevement" WHERE id = ANY(${pointIds}::uuid[])`
  const coordinatesByPoint = new Map(geometry.map(row => [row.id, row.x === null || row.y === null ? null : [row.x, row.y]]))
  for (const point of points) {
    const imported = pointReferences.filter(ref => ref.pointPrelevementId === point.id && ref.metadata?.imported).map(ref => ref.metadata.imported)
    check(imported.length > 0 && imported.some(baseline => Object.entries(baseline).every(([field, value]) => field === 'coordinates'
      || valueHash(point[field] ?? null) === valueHash(value))), 'REBUILD_MANUAL_POINT_FIELDS')
    check(imported.some(baseline => Array.isArray(baseline.coordinates) && baseline.coordinates.every((value, index) =>
      Math.abs(value - coordinatesByPoint.get(point.id)?.[index]) < 1e-10)), 'REBUILD_MANUAL_POINT_COORDINATES')
  }
  const scopedReferences = await client.externalReference.findMany({where: {scope: SCOPE, kind: 'METER'}})
  const initialAllocations = await client.meterAllocation.findMany({where: {exploitationId: inIds(exploitationIds)}})
  const meterIds = [...new Set([...scopedReferences.map(ref => ref.compteurId), ...initialAllocations.map(item => item.compteurId),
    ...manifest.meters.map(item => item.id)].filter(Boolean))].sort()
  const meterIdSet = new Set(meterIds)
  const allocations = await client.meterAllocation.findMany({where: {OR: [
    {exploitationId: inIds(exploitationIds)}, {compteurId: inIds(meterIds)}
  ]}, orderBy: order})
  check(allocations.every(item => exploitationIdSet.has(item.exploitationId) && item.scope === SCOPE
    && PROVIDERS.includes(item.provider) && /^(dropt-rives|dropt-epidropt):allocation:/.test(item.sourceId)),
  'REBUILD_METER_ALLOCATION_OUTSIDE_SCOPE')
  const [editedAllocations] = await client.$queryRaw`SELECT count(*)::int AS count FROM "MeterAllocationVersion"
    WHERE "allocationId" = ANY(${ids(allocations)}::uuid[]) AND metadata ? 'allocationEdit'`
  check(editedAllocations.count === 0, 'REBUILD_MANUAL_ALLOCATION_EDIT', editedAllocations.count)
  const streams = await client.meterStream.findMany({where: {OR: [{compteurId: inIds(meterIds)}, {provider: 'rives-et-eaux', scope: SCOPE}]}, orderBy: order})
  check(streams.every(stream => stream.provider === 'rives-et-eaux' && stream.scope === SCOPE && meterIdSet.has(stream.compteurId)),
    'REBUILD_METER_STREAM_OUTSIDE_SCOPE')
  const streamIds = ids(streams)
  const streamIdSet = new Set(streamIds)
  const publications = await client.meterPublication.findMany({where: {OR: [{compteurId: inIds(meterIds)}, {streamId: inIds(streamIds)}]}, orderBy: order})
  check(publications.every(row => streamIdSet.has(row.streamId) && meterIdSet.has(row.compteurId)), 'REBUILD_PUBLICATION_OUTSIDE_SCOPE')
  const sourceIds = publications.map(row => row.sourceId).sort()
  const sourceIdSet = new Set(sourceIds)
  const chunks = await client.$queryRaw`SELECT id, "sourceId", "calculationStrategy", "pointPrelevementId", "exploitationId", "compteurId",
      "instructedByInstructorUserId", "instructionComment", "submittedByDeclarantUserId", "collecteurUserId"
    FROM "Chunk" WHERE "sourceId" = ANY(${sourceIds}::uuid[]) OR "pointPrelevementId" = ANY(${pointIds}::uuid[])
    OR "exploitationId" = ANY(${exploitationIds}::uuid[]) OR "compteurId" = ANY(${meterIds}::uuid[]) ORDER BY id`
  check(chunks.every(row => row.calculationStrategy === 'METER' && sourceIdSet.has(row.sourceId)
    && pointIdSet.has(row.pointPrelevementId) && exploitationIdSet.has(row.exploitationId) && meterIdSet.has(row.compteurId)),
  'REBUILD_MANUAL_OR_SHARED_SOURCE')
  check(chunks.every(row => !row.instructedByInstructorUserId && !row.instructionComment && !row.submittedByDeclarantUserId && !row.collecteurUserId),
    'REBUILD_MANUAL_CHUNK_INTERVENTION')
  const sources = await client.$queryRaw`SELECT id, type, "declarationId", "apiImportId" FROM "Source" WHERE id = ANY(${sourceIds}::uuid[])`
  check(sources.every(row => row.type === 'API' && !row.declarationId && !row.apiImportId), 'REBUILD_MANUAL_SOURCE')
  const prohibited = [
    ['documents', 'resourceDocument', {declarantPointPrelevementId: inIds(exploitationIds)}],
    ['documentLinks', 'resourceDocumentExploitation', {declarantPointPrelevementId: inIds(exploitationIds)}],
    ['rules', 'resourceRuleExploitation', {declarantPointPrelevementId: inIds(exploitationIds)}],
    ['collecteurs', 'declarantCollecteurExploitation', {exploitationId: inIds(exploitationIds)}],
    ['connectors', 'declarantPointPrelevementConnector', {declarantPointPrelevementId: inIds(exploitationIds)}],
    ['secondaryUsages', 'declarantPointPrelevementSecondaryUsage', {exploitationId: inIds(exploitationIds)}]
  ]
  for (const [kind, model, where] of prohibited) {
    const count = await client[model].count({where})
    check(count === 0, `REBUILD_DEPENDENCY_${kind.toUpperCase()}`, count)
  }
  const [replacements] = await client.$queryRaw`SELECT count(*)::int AS count FROM "ChunkValueReplacement"
    WHERE "pointPrelevementId" = ANY(${pointIds}::uuid[]) OR "replacedSourceId" = ANY(${sourceIds}::uuid[])
    OR "replacementSourceId" = ANY(${sourceIds}::uuid[])`
  check(replacements.count === 0, 'REBUILD_DEPENDENCY_ORDINARYREPLACEMENTHISTORY', replacements.count)
  const [outsideContributions] = await client.$queryRaw`SELECT count(*)::int AS count FROM "MeterVolumeContribution" c
    JOIN "MeterAllocationVersion" v ON v.id = c."allocationVersionId"
    JOIN "MeterPublication" p ON p.id = c."publicationId"
    JOIN "ChunkValue" cv ON cv.id = c."chunkValueId" JOIN "Chunk" ch ON ch.id = cv."chunkId"
    WHERE (c."publicationId" = ANY(${ids(publications)}::uuid[])) <> (v."allocationId" = ANY(${ids(allocations)}::uuid[]))
      OR (c."publicationId" = ANY(${ids(publications)}::uuid[]) AND ch."sourceId" <> p."sourceId")`
  check(outsideContributions.count === 0, 'REBUILD_CONTRIBUTION_OUTSIDE_SCOPE', outsideContributions.count)
  const ownerIds = [...new Set([...exploitations.map(row => row.declarantUserId), ...manifest.declarants.map(row => row.id)])].sort()
  const fingerprints = {}
  for (const [table, predicate, parameters] of [
    ['PointPrelevement', 't.id = ANY($1::uuid[])', [pointIds]],
    ['PointPrelevementZone', 't."pointPrelevementId" = ANY($1::uuid[])', [pointIds]],
    ['DeclarantPointPrelevement', 't.id = ANY($1::uuid[])', [exploitationIds]],
    ['User', 't.id = ANY($1::uuid[])', [ownerIds]],
    ['ExternalReference', 't."pointPrelevementId" = ANY($1::uuid[]) OR t."compteurId" = ANY($2::uuid[]) OR t."declarantUserId" = ANY($3::uuid[])', [pointIds, meterIds, ownerIds]],
    ['Compteur', 't.id = ANY($1::uuid[])', [meterIds]],
    ['MeterAllocation', 't.id = ANY($1::uuid[])', [ids(allocations)]],
    ['MeterAllocationVersion', 't."allocationId" = ANY($1::uuid[])', [ids(allocations)]],
    ['MeterStream', 't.id = ANY($1::uuid[])', [streamIds]],
    ['MeterReading', 't."compteurId" = ANY($1::uuid[])', [meterIds]],
    ['MeterReadingRevision', 't."readingId" IN (SELECT id FROM "MeterReading" WHERE "compteurId" = ANY($1::uuid[]))', [meterIds]],
    ['MeterIngestion', 't.provider = $1 AND t.scope = $2', ['rives-et-eaux', SCOPE]],
    ['MeterPublication', 't.id = ANY($1::uuid[])', [ids(publications)]],
    ['MeterVolumeContribution', 't."publicationId" = ANY($1::uuid[])', [ids(publications)]],
    ['Source', 't.id = ANY($1::uuid[])', [sourceIds]],
    ['Chunk', 't.id = ANY($1::uuid[])', [ids(chunks)]],
    ['ChunkValue', 't."chunkId" = ANY($1::uuid[])', [ids(chunks)]]
  ]) fingerprints[table] = await fingerprint(client, table, predicate, parameters)
  // Declarant has userId rather than id; preserve its values in the scope hash too.
  const declarants = await client.declarant.findMany({where: {userId: inIds(ownerIds)}, orderBy: {userId: 'asc'}})
  fingerprints.Declarant = {count: declarants.length, hash: digest(declarants)}
  const scopeStateHash = digest(fingerprints)
  return {scopeStateHash, fingerprints, errors, pointIds, exploitationIds, meterIds, streamIds,
    allocationIds: ids(allocations), publicationIds: ids(publications), sourceIds, pointReferences,
    counts: {points: points.length, exploitations: exploitations.length, meters: meterIds.length,
      allocations: allocations.length, streams: streams.length, publications: publications.length, chunks: chunks.length}}
}

function assertBackup(evidence, scopeStateHash) {
  requireCondition(evidence?.target === 'testing' && evidence.completed === true && evidence.restored === true
    && /^[a-f\d]{64}$/.test(evidence.backupSha256 ?? '') && Number.isFinite(Date.parse(evidence.restoredAt))
    && evidence.scopeStateHash === scopeStateHash, 'REBUILD_VERIFIED_RESTORED_BACKUP_REQUIRED')
}

async function allocationStateHash(client, meterIds) {
  const allocations = await client.meterAllocation.findMany({where: {compteurId: inIds(meterIds)}, orderBy: order,
    include: {versions: {orderBy: order}, exploitation: {select: {id: true, countingCode: true, pointPrelevementId: true,
      declarantUserId: true, usageId: true, startDate: true, endDate: true, pointPrelevement: {select: {flowType: true}}}}}})
  return valueHash(allocations)
}

export async function rebuildManifest(client, manifest, {target, apply = false, activateAt, serviceAccountId,
  expectedReport, backupEvidence, transactionTimeoutSeconds} = {}) {
  await assertRebuildTarget(client, target)
  requireCondition(typeof activateAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(activateAt)
    && Number.isFinite(Date.parse(activateAt)), 'REBUILD_EXPLICIT_ACTIVATION_DATE_REQUIRED')
  if (apply) requireCondition(expectedReport?.operation === 'rebuild' && expectedReport.complete && !expectedReport.applied
    && expectedReport.manifestHash === manifest.manifestHash && expectedReport.planHash, 'REBUILD_APPROVED_SIMULATION_REQUIRED')
  const timeout = getTransactionTimeoutMs(transactionTimeoutSeconds)
  try {
    return await client.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('dropt-referential'), hashtext(${SCOPE}))`
      // Match ingestion's order: physical meter first, then referential rows.
      // Otherwise a writer holding the meter lock and inserting a PP-linked
      // chunk could deadlock with this rebuild's PP row lock.
      const knownMeters = await tx.externalReference.findMany({where: {scope: SCOPE, kind: 'METER'}, select: {compteurId: true}})
      const attachedMeters = await tx.meterAllocation.findMany({where: {exploitation: {sourceId: {startsWith: EXPLOITATION_PREFIX}}}, select: {compteurId: true}})
      const lockedMeters = new Set([...knownMeters, ...attachedMeters].map(row => row.compteurId).filter(Boolean))
      for (const meter of manifest.meters) lockedMeters.add(meter.id)
      for (const id of [...lockedMeters].sort()) await lockMeter(tx, id)
      // Row locks block new FK dependencies while leaving other territories writable.
      await tx.$queryRaw`SELECT id FROM "PointPrelevement" WHERE "sourceId" LIKE 'dropt-epidropt:point:%' ORDER BY id FOR UPDATE`
      await tx.$queryRaw`SELECT id FROM "DeclarantPointPrelevement" WHERE "sourceId" LIKE 'dropt-epidropt:exploitation:%' ORDER BY id FOR UPDATE`
      const scope = await inspectRebuildScope(tx, manifest)
      requireCondition(scope.meterIds.every(id => lockedMeters.has(id)), 'REBUILD_METER_IDENTITIES_CHANGED')
      requireCondition(scope.errors.length === 0, `REBUILD_UNSAFE_SCOPE:${scope.errors.map(item => item.code).join(',')}`)
      if (apply) {
        requireCondition(expectedReport.scopeStateHash === scope.scopeStateHash, 'REBUILD_SCOPE_CHANGED_SINCE_SIMULATION')
        assertBackup(backupEvidence, scope.scopeStateHash)
      }
      await tx.$executeRaw`DELETE FROM "MeterVolumeContribution" WHERE "publicationId" = ANY(${scope.publicationIds}::uuid[])`
      await tx.$executeRaw`DELETE FROM "MeterPublication" WHERE id = ANY(${scope.publicationIds}::uuid[])`
      await tx.$executeRaw`DELETE FROM "Source" WHERE id = ANY(${scope.sourceIds}::uuid[])`
      await tx.meterAllocationVersion.deleteMany({where: {allocationId: inIds(scope.allocationIds)}})
      await tx.meterAllocation.deleteMany({where: {id: inIds(scope.allocationIds)}})
      await tx.declarantPointPrelevement.deleteMany({where: {id: inIds(scope.exploitationIds)}})
      await tx.externalReference.deleteMany({where: {pointPrelevementId: inIds(scope.pointIds)}})
      await tx.pointPrelevementZone.deleteMany({where: {pointPrelevementId: inIds(scope.pointIds)}})
      await tx.pointPrelevement.deleteMany({where: {id: inIds(scope.pointIds)}})
      // Keep stream IDs, readings, revisions, ingestions and operational checkpoints.
      // Reset only activation/snapshot state invalidated by this full reconstruction.
      await tx.meterStream.updateMany({where: {id: inIds(scope.streamIds)}, data: {
        enabled: false, activatedAt: null, allocationSnapshot: [], allocationSnapshotValidated: false
      }})
      const imported = await applyRebuiltManifestInTransaction(tx, manifest, {activateAt, serviceAccountId, transactionTimeoutSeconds})
      requireCondition(imported.complete, `REBUILD_IMPORT_FAILED:${imported.executionIssues.map(item => item.code).join(',')}`)
      const pointMappings = scope.pointIds.map(oldId => ({oldId, newIds: [...new Set(manifest.points.filter(point => point.references.some(incoming =>
        scope.pointReferences.some(ref => ref.pointPrelevementId === oldId && ref.provider === incoming.provider && ref.externalId === incoming.externalId)
      )).map(point => imported.mappings.points.find(row => row.manifestId === point.id).id))].sort()}))
      const streams = await tx.meterStream.findMany({where: {provider: 'rives-et-eaux', scope: SCOPE,
        externalId: {in: manifest.meters.filter(row => row.provider === 'rives-et-eaux').map(row => row.serial)}}, orderBy: order,
      select: {id: true, compteurId: true, enabled: true, activatedAt: true, allocationSnapshot: true, allocationSnapshotValidated: true}})
      const result = {...imported, operation: 'rebuild', target, applied: apply, before: scope.counts,
        scopeStateHash: scope.scopeStateHash, fingerprints: scope.fingerprints, pointMappings, streams,
        allocationStateHash: await allocationStateHash(tx, streams.map(stream => stream.compteurId)),
        recomputationRequired: true, backupSha256: backupEvidence?.backupSha256 ?? null}
      result.planHash = valueHash({manifestHash: manifest.manifestHash, scopeStateHash: scope.scopeStateHash,
        activateAt, serviceAccountId: serviceAccountId ?? null, mappings: imported.mappings, streams})
      if (apply) requireCondition(expectedReport.planHash === result.planHash, 'REBUILD_PLAN_CHANGED_SINCE_SIMULATION')
      if (!apply) throw Object.assign(new Error('REBUILD_SIMULATION_ROLLBACK'), {rebuildResult: result})
      return result
    }, {timeout, maxWait: 10_000})
  } catch (error) {
    if (error.rebuildResult) return error.rebuildResult
    throw error
  }
}

export async function recomputeRebuiltManifest(client, manifest, {target, apply = false, report, resume, onProgress,
  transactionTimeoutSeconds} = {}) {
  await assertRebuildTarget(client, target)
  requireCondition(report?.operation === 'rebuild' && report.applied && report.complete && report.manifestHash === manifest.manifestHash
    && Array.isArray(report.streams), 'REBUILD_APPLIED_REPORT_REQUIRED')
  requireCondition((await verifyManifest(client, manifest, {report})).complete, 'REBUILD_REFERENTIAL_CHANGED')
  requireCondition(report.allocationStateHash === await allocationStateHash(client, report.streams.map(stream => stream.compteurId)),
    'REBUILD_ALLOCATION_STATE_CHANGED')
  const operationId = digest({manifestHash: report.manifestHash, planHash: report.planHash})
  requireCondition(!resume || (resume.operationId === operationId && resume.target === target), 'REBUILD_REPLAY_RESUME_MISMATCH')
  const progress = {operation: 'recompute-rebuild', operationId, target, manifestHash: report.manifestHash, complete: false,
    streams: resume?.streams ?? [], updatedAt: new Date().toISOString()}
  const streamIds = new Set(report.streams.map(stream => stream.id))
  requireCondition(progress.streams.every(row => streamIds.has(row.id)), 'REBUILD_REPLAY_RESUME_OUTSIDE_SCOPE')
  if (!apply) return {...progress, applied: false, plannedStreams: report.streams.length}
  progress.applied = true
  for (const expected of report.streams) {
    if (progress.streams.some(row => row.id === expected.id && row.complete)) continue
    const result = await client.$transaction(async tx => {
      await lockMeter(tx, expected.compteurId)
      const stream = await tx.meterStream.findUnique({where: {id: expected.id}})
      requireCondition(stream?.provider === 'rives-et-eaux' && stream.scope === SCOPE && stream.compteurId === expected.compteurId
        && stream.enabled === expected.enabled && (stream.activatedAt?.toISOString() ?? null) === (expected.activatedAt ? new Date(expected.activatedAt).toISOString() : null)
        && stream.allocationSnapshotValidated === expected.allocationSnapshotValidated
        && digest(stream.allocationSnapshot) === digest(expected.allocationSnapshot), 'REBUILD_REPLAY_STREAM_CHANGED')
      const replay = await reprocessMeterStreamInTransaction(tx, stream, {preserveOrdinary: true})
      await tx.meterStream.update({where: {id: stream.id}, data: {lastIssue: replay.issues.join(',') || null}})
      return replay
    }, {timeout: getTransactionTimeoutMs(transactionTimeoutSeconds), maxWait: 20_000})
    progress.streams = [...progress.streams.filter(row => row.id !== expected.id), {id: expected.id, complete: true, ...result}]
    progress.updatedAt = new Date().toISOString()
    await onProgress?.(progress)
  }
  progress.complete = progress.streams.filter(row => row.complete).length === report.streams.length
  await onProgress?.(progress)
  return progress
}
