#!/usr/bin/env node
import process from 'node:process'
import path from 'node:path'
import {readFile} from 'node:fs/promises'
import {parseArgs} from 'node:util'
import {Prisma} from '@prisma/client'
import {isVolumeMetricTypeCode} from '../../lib/constants/metric-type-codes.js'
import {sha256} from './lib/core.js'
import {loadEnv} from './lib/runtime.js'
import {reservePrivateReport} from './lib/access-cli.js'
import {historyTarget, historyPlanHash, assertHistorySimulation, bindHistoryTargetGlobals,
  HISTORY_TARGET_OPTIONS, historyTargetArguments} from './lib/history-target.js'

export const ASSOCIATION_REPAIR_VERSION = 1
const OPERATION = 'reunion-native-point-associations'
const TOTAL_KEYS = ['totalWaterVolume', 'totalWaterVolumeWithdrawn', 'totalWaterVolumeDischarged']
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
const normalized = value => JSON.parse(JSON.stringify(value))
const ExactDecimal = Prisma.Decimal.clone({precision: 80})

export function associationRepairScope(snapshot) {
  const ids = snapshot.chunkIds
  if (!Array.isArray(ids) || ids.length !== 291 || new Set(ids).size !== ids.length || ids.some(id => !uuid.test(id))
    || snapshot.sources?.length !== 59 || snapshot.points?.length !== 11 || snapshot.chunks?.length !== ids.length) {
    throw new Error('Sauvegarde explicite des 291 séries, 59 sources et 11 points requise')
  }
  const points = new Map(snapshot.points.map(point => [point.sourceId, point]))
  for (const chunk of snapshot.chunks) {
    const reference = chunk.metadata?.sourcePointReference
    const point = points.get(reference)
    if (!ids.includes(chunk.id) || !/^reunion:DEP-974:point:\d+$/.test(reference ?? '') || !point || point.deletedAt
      || point.identifiers?.REUNION !== reference.split(':').at(-1)) {
      throw new Error('Identité source Réunion explicite et non ambiguë requise')
    }
  }
  return {chunkIds: [...ids].sort(), sourceIds: snapshot.sources.map(row => row.id).sort(), pointIds: snapshot.points.map(row => row.id).sort()}
}

function snapshotState(snapshot) {
  return {sources: snapshot.sources, declarations: snapshot.declarations, chunks: snapshot.sourceChunks,
    points: snapshot.points, exploitations: snapshot.exploitations, usages: snapshot.usages,
    actorActivity: snapshot.actorActivity ?? []}
}

async function readState(client, scope, snapshot) {
  const read = async (table, column, ids) => (await client.$queryRawUnsafe(
    `SELECT to_jsonb(t) AS row FROM "${table}" t WHERE "${column}" = ANY($1::uuid[]) ORDER BY id`, ids)).map(item => item.row)
  return {sources: await read('Source', 'id', scope.sourceIds),
    declarations: await read('Declaration', 'id', snapshot.declarations.map(row => row.id)),
    chunks: await read('Chunk', 'sourceId', scope.sourceIds), points: await read('PointPrelevement', 'id', scope.pointIds),
    exploitations: await read('DeclarantPointPrelevement', 'pointPrelevementId', scope.pointIds),
    usages: await read('SandreWaterUse', 'id', snapshot.usages.map(row => row.id)),
    actorActivity: snapshot.actorActivity?.length ? await client.$queryRawUnsafe(
      'SELECT "userId", "lastDeclarationAt"::text AS "lastDeclarationAt" FROM "Declarant" WHERE "userId"=ANY($1::uuid[]) ORDER BY "userId"',
      snapshot.actorActivity.map(row => row.userId)) : []}
}

async function assertActivityUnchanged(client, snapshot, changes, before) {
  const rejectedIds = changes.filter(change => change.data.instructionStatus === 'REJECTED').map(change => change.id)
  const sourceIds = new Set(changes.filter(change => rejectedIds.includes(change.id)).map(change => change.sourceId))
  const declarationIds = new Set(before.sources.filter(source => sourceIds.has(source.id)).map(source => source.declarationId))
  const actorIds = [...new Set([
    ...before.declarations.filter(declaration => declarationIds.has(declaration.id)).flatMap(declaration => [declaration.declarantUserId, declaration.createdByDeclarantUserId]),
    ...before.chunks.filter(chunk => sourceIds.has(chunk.sourceId)).flatMap(chunk => [chunk.preleveurUserId, chunk.submittedByDeclarantUserId, chunk.collecteurUserId])
  ].filter(Boolean))].sort()
  if (historyPlanHash(actorIds) !== historyPlanHash((snapshot.actorActivity ?? []).map(row => row.userId).sort())) {
    throw new Error('Les acteurs des séries rejetées doivent être sauvegardés explicitement')
  }
  if (!actorIds.length) return
  // Same activity rule as declarant.js, with the planned rejections excluded in the read-only preview.
  const activity = await client.$queryRawUnsafe(`SELECT d."userId", (
    SELECT MAX(CASE WHEN s.type='DECLARATION' THEN declaration."createdAt" ELSE s."createdAt" END)
    FROM (
      SELECT chunk."sourceId" FROM "Chunk" chunk
      WHERE chunk."instructionStatus"<>'REJECTED' AND NOT(chunk.id=ANY($2::uuid[]))
        AND (chunk."preleveurUserId"=d."userId" OR chunk."submittedByDeclarantUserId"=d."userId" OR chunk."collecteurUserId"=d."userId")
      UNION SELECT declared_source.id FROM "Source" declared_source
      JOIN "Declaration" linked_declaration ON linked_declaration.id=declared_source."declarationId"
      WHERE (linked_declaration."declarantUserId"=d."userId" OR linked_declaration."createdByDeclarantUserId"=d."userId")
        AND EXISTS (SELECT 1 FROM "Chunk" declared_chunk WHERE declared_chunk."sourceId"=declared_source.id
          AND declared_chunk."instructionStatus"<>'REJECTED' AND NOT(declared_chunk.id=ANY($2::uuid[])))
    ) candidates JOIN "Source" s ON s.id=candidates."sourceId"
    LEFT JOIN "Declaration" declaration ON declaration.id=s."declarationId"
    WHERE s.type IN ('DECLARATION','API') AND s.status='COMPLETED'
  )::text AS "lastDeclarationAt" FROM "Declarant" d WHERE d."userId"=ANY($1::uuid[]) ORDER BY d."userId"`, actorIds, rejectedIds)
  if (historyPlanHash(activity) !== historyPlanHash(before.actorActivity)) throw new Error('La reprise modifierait la dernière activité : nouvelle revue requise')
}

export function associationPreservedState(state, chunkIds, availabilityIds = []) {
  const selected = new Set(chunkIds)
  return {...state, exploitations: state.exploitations.map(exploitation => {
    if (!availabilityIds.includes(exploitation.id)) return exploitation
    const {mostRecentAvailableDate: _date, updatedAt: _updated, ...rest} = exploitation
    return rest
  }), chunks: state.chunks.map(chunk => {
    if (!selected.has(chunk.id)) return chunk
    const {pointPrelevementId: _point, exploitationId: _exploitation, flowType: _flow,
      usageId: _usage, instructionStatus: _status, parsingInfo: _parsing, updatedAt: _updated, metadata, ...rest} = chunk
    return {...rest, metadata: Object.fromEntries(Object.entries(metadata).filter(([key]) => !TOTAL_KEYS.includes(key)))}
  }), sources: state.sources.map(source => {
    const {globalInstructionStatus: _status, updatedAt: _updated, metadata, ...rest} = source
    const allowed = [...TOTAL_KEYS, 'parsingErrors', 'parsingErrorCounts', 'parsingErrorsSampled', 'hasAnomalies']
    return {...rest, metadata: Object.fromEntries(Object.entries(metadata ?? {}).filter(([key]) => !allowed.includes(key)))}
  })}
}

async function readValues(client, chunkId, snapshot) {
  // Exact row fingerprint, scoped by the indexed chunk UUID; no global count or value rewrite.
  const [row] = await client.$queryRawUnsafe(`SELECT count(*)::integer AS count,
    md5(string_agg(md5(to_jsonb(v)::text), '' ORDER BY v.id)) AS "orderedRowsMd5",
    COALESCE(jsonb_agg(jsonb_build_object('periodStart', v."periodStart", 'periodEnd', v."periodEnd",
      'metricTypeCode', v."metricTypeCode", 'value', v.value::text) ORDER BY v.id), '[]'::jsonb) AS values
    FROM "ChunkValue" v WHERE v."chunkId"=$1::uuid`, chunkId)
  const expected = snapshot.valueFingerprints.find(item => item.chunkId === chunkId)
  if (!expected || row.count !== expected.count || row.orderedRowsMd5 !== expected.orderedRowsMd5) {
    throw new Error(`Valeurs différentes de la sauvegarde : ${chunkId}`)
  }
  return row.values.map(value => ({...value, periodStart: new Date(`${value.periodStart}Z`), periodEnd: new Date(`${value.periodEnd}Z`)}))
}

export function repairChunkTotals(values, flowType) {
  if (!['PRELEVEMENT', 'REJET'].includes(flowType)) throw new Error('Fonction du point absente')
  const totalWaterVolume = values.filter(value => isVolumeMetricTypeCode(value.metricTypeCode))
    .reduce((sum, value) => sum.plus(value.value), new ExactDecimal(0)).toNumber()
  if (!Number.isFinite(totalWaterVolume)) throw new Error('Total de volume non fini')
  return {totalWaterVolume, totalWaterVolumeWithdrawn: flowType === 'PRELEVEMENT' ? totalWaterVolume : 0,
    totalWaterVolumeDischarged: flowType === 'REJET' ? totalWaterVolume : 0}
}

function sourceTotals(chunks) {
  return Object.fromEntries(['totalWaterVolumeWithdrawn', 'totalWaterVolumeDischarged'].map(key => [key,
    chunks.filter(chunk => chunk.instructionStatus !== 'REJECTED')
      .reduce((sum, chunk) => sum.plus(chunk.metadata?.[key] ?? 0), new ExactDecimal(0)).toNumber()]))
}

async function planAvailabilityDates(client, changes, before) {
  const sources = new Map(before.sources.map(source => [source.id, source]))
  const declarations = new Map(before.declarations.map(declaration => [declaration.id, declaration]))
  const chunks = new Map(before.chunks.map(chunk => [chunk.id, chunk]))
  const actor = change => declarations.get(sources.get(change.sourceId).declarationId).declarantUserId
  const pairs = [...new Map(changes.map(change => {
    const item = {actor: actor(change), point: change.data.pointPrelevementId}
    return [`${item.actor}:${item.point}`, item]
  })).values()]
  const existing = await client.$queryRawUnsafe(`WITH pairs AS (
    SELECT * FROM unnest($1::uuid[], $2::uuid[]) AS pair(actor, point)
  ) SELECT pair.actor, pair.point, chunk."exploitationId", MAX(chunk."maxDate")::text AS "maxDate"
    FROM pairs pair JOIN "Declaration" declaration ON declaration."declarantUserId"=pair.actor
    JOIN "Source" source ON source."declarationId"=declaration.id AND source.status='COMPLETED'
    JOIN "Chunk" chunk ON chunk."sourceId"=source.id AND chunk."pointPrelevementId"=pair.point
      AND chunk."instructionStatus" IN ('PENDING','VALIDATED','AUTOMATICALLY_VALIDATED')
    GROUP BY pair.actor, pair.point, chunk."exploitationId"`, pairs.map(pair => pair.actor), pairs.map(pair => pair.point))
  const maximum = new Map(existing.map(row => [`${row.actor}:${row.exploitationId ?? row.point}`, row.maxDate]))
  for (const change of changes.filter(change => change.data.instructionStatus !== 'REJECTED')) {
    const key = `${actor(change)}:${change.data.exploitationId ?? change.data.pointPrelevementId}`
    const date = chunks.get(change.id).maxDate
    if (!maximum.has(key) || maximum.get(key) < date) maximum.set(key, date)
  }
  const pairKeys = new Set(pairs.map(pair => `${pair.actor}:${pair.point}`))
  const exploitations = before.exploitations.filter(row => pairKeys.has(`${row.declarantUserId}:${row.pointPrelevementId}`))
  return exploitations.flatMap(row => {
    const count = exploitations.filter(item => item.declarantUserId === row.declarantUserId && item.pointPrelevementId === row.pointPrelevementId).length
    const date = maximum.get(`${row.declarantUserId}:${row.id}`)
      ?? (count === 1 ? maximum.get(`${row.declarantUserId}:${row.pointPrelevementId}`) : null) ?? null
    const after = date ? new Date(`${date}T00:00:00Z`) : null
    const current = row.mostRecentAvailableDate ? new Date(`${row.mostRecentAvailableDate}Z`) : null
    return (current?.getTime() ?? null) === (after?.getTime() ?? null) ? [] : [{id: row.id, data: {mostRecentAvailableDate: after}}]
  })
}

export function assertAssociationBackup(evidence, snapshot, {sourceHash, planHash, snapshotSha256}) {
  if (evidence?.operation !== OPERATION || evidence.sourceHash !== sourceHash || evidence.planHash !== planHash
    || evidence.backup?.sha256 !== snapshotSha256 || evidence.rowsSha256 !== historyPlanHash(snapshotState(snapshot))) {
    throw new Error('Sauvegarde restaurée de la même cohorte et du même plan obligatoire')
  }
}

export async function reconcilePointAssociations(client, {snapshot, apply = false, previousReport, helpers, validatePlan = () => {}}) {
  const scope = associationRepairScope(snapshot)
  if (apply) {
    await client.$queryRawUnsafe('SELECT id FROM "Declaration" WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', snapshot.declarations.map(row => row.id).sort())
    await client.$queryRawUnsafe('SELECT id FROM "Source" WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', scope.sourceIds)
    await client.$queryRawUnsafe('SELECT id FROM "PointPrelevement" WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', scope.pointIds)
    await client.$queryRawUnsafe('SELECT id FROM "DeclarantPointPrelevement" WHERE "pointPrelevementId"=ANY($1::uuid[]) ORDER BY id FOR UPDATE', scope.pointIds)
    await client.$queryRawUnsafe('SELECT id FROM "Chunk" WHERE "sourceId"=ANY($1::uuid[]) ORDER BY id FOR UPDATE', scope.sourceIds)
  }
  const before = await readState(client, scope, snapshot)
  const beforeHash = historyPlanHash(before)
  if ((previousReport?.apply === true || previousReport?.alreadyApplied === true) && previousReport.complete === true && previousReport.operation === OPERATION
    && previousReport.afterState && beforeHash === historyPlanHash(previousReport.afterState)
    && historyPlanHash(previousReport.chunkIds) === historyPlanHash(scope.chunkIds)) {
    for (const chunkId of scope.chunkIds) await readValues(client, chunkId, snapshot)
    const planHash = historyPlanHash({version: ASSOCIATION_REPAIR_VERSION, beforeHash, changes: []})
    await validatePlan({planHash, before, alreadyApplied: true})
    return {chunkIds: scope.chunkIds, before, afterState: before, changes: [], sourceChanges: [], availabilityChanges: [], alreadyApplied: true, planHash, verified: true}
  }
  if (beforeHash !== historyPlanHash(snapshotState(snapshot))) throw new Error('État courant différent de la sauvegarde : nouvelle revue requise')
  const sourceById = new Map(before.sources.map(source => [source.id, source]))
  const declarationById = new Map(before.declarations.map(declaration => [declaration.id, declaration]))
  const pointBySourceId = new Map(before.points.map(point => [point.sourceId, point]))
  const chunkById = new Map(before.chunks.map(chunk => [chunk.id, chunk]))
  const selected = scope.chunkIds.map(id => chunkById.get(id)).sort((a, b) =>
    sourceById.get(a.sourceId).createdAt.localeCompare(sourceById.get(b.sourceId).createdAt) || a.id.localeCompare(b.id))
  const additions = new Map()
  const changes = []
  for (const chunk of selected) {
    const source = sourceById.get(chunk.sourceId)
    const declaration = declarationById.get(source?.declarationId)
    const point = pointBySourceId.get(chunk.metadata?.sourcePointReference)
    if (source?.status !== 'COMPLETED' || !declaration?.importSourceId?.startsWith('reunion:')
      || chunk.preleveurUserId !== declaration.declarantUserId
      || !helpers.canRepairNativePointAssociation(chunk) || !point || point.deletedAt) throw new Error(`Série hors périmètre : ${chunk.id}`)
    const values = await readValues(client, chunk.id, snapshot)
    const key = `${point.id}:${declaration.declarantUserId}`
    const data = await helpers.planNativePointAssociationRepair(client, {chunk: {...chunk,
      minDate: new Date(chunk.minDate), maxDate: new Date(chunk.maxDate)}, point,
    declarantUserId: declaration.declarantUserId, values, additionalChunkIds: additions.get(key) ?? []})
    if (!data || data.exploitationId) throw new Error('La cohorte revue doit conserver les exploitations absentes')
    data.metadata = {...chunk.metadata, ...repairChunkTotals(values, data.flowType)}
    changes.push({id: chunk.id, sourceId: chunk.sourceId, data})
    if (data.instructionStatus !== 'REJECTED') additions.set(key, [...(additions.get(key) ?? []), chunk.id])
  }
  const plannedChunks = before.chunks.map(chunk => ({...chunk, ...(changes.find(change => change.id === chunk.id)?.data ?? {})}))
  const sourceChanges = before.sources.map(source => {
    const chunks = plannedChunks.filter(chunk => chunk.sourceId === source.id)
    return {id: source.id, data: {globalInstructionStatus: helpers.computeGlobalPointMatchingStatus(chunks.filter(chunk => !chunk.metadata?.superseded)),
      metadata: {...source.metadata, ...helpers.refreshNativeAssociationDiagnostics(source.metadata, chunks), ...sourceTotals(chunks)}}}
  })
  const planned = {...before, chunks: plannedChunks, sources: before.sources.map(source => ({...source, ...sourceChanges.find(change => change.id === source.id).data}))}
  await assertActivityUnchanged(client, snapshot, changes, before)
  const availabilityChanges = await planAvailabilityDates(client, changes, before)
  const availabilityIds = availabilityChanges.map(change => change.id)
  const preservedHash = historyPlanHash(associationPreservedState(before, scope.chunkIds, availabilityIds))
  if (preservedHash !== historyPlanHash(associationPreservedState(planned, scope.chunkIds, availabilityIds))) throw new Error('Plan hors des champs autorisés')
  const planHash = historyPlanHash(normalized({version: ASSOCIATION_REPAIR_VERSION, beforeHash, changes, sourceChanges, availabilityChanges}))
  await validatePlan({planHash, before})
  if (apply) {
    for (const change of changes) await client.chunk.update({where: {id: change.id}, data: change.data})
    for (const change of sourceChanges) await client.source.update({where: {id: change.id}, data: change.data})
    for (const change of availabilityChanges) await client.declarantPointPrelevement.update({where: {id: change.id}, data: change.data})
    const after = await readState(client, scope, snapshot)
    await assertActivityUnchanged(client, snapshot, changes, after)
    if (preservedHash !== historyPlanHash(associationPreservedState(after, scope.chunkIds, availabilityIds))) throw new Error('Champs préservés modifiés : transaction annulée')
    for (const change of changes) {
      const row = after.chunks.find(chunk => chunk.id === change.id)
      if (historyPlanHash(Object.fromEntries(Object.keys(change.data).map(key => [key, row[key]]))) !== historyPlanHash(change.data)) throw new Error('Association après écriture différente')
    }
    for (const change of sourceChanges) {
      const row = after.sources.find(source => source.id === change.id)
      if (historyPlanHash({metadata: row.metadata, globalInstructionStatus: row.globalInstructionStatus}) !== historyPlanHash(change.data)) throw new Error('Source après écriture différente')
    }
    for (const change of availabilityChanges) {
      const row = after.exploitations.find(exploitation => exploitation.id === change.id)
      const actual = row.mostRecentAvailableDate ? +new Date(`${row.mostRecentAvailableDate}Z`) : null
      const expected = change.data.mostRecentAvailableDate ? +change.data.mostRecentAvailableDate : null
      if (actual !== expected) throw new Error('Date de dernière donnée après écriture différente')
    }
    return {chunkIds: scope.chunkIds, before, afterState: after, changes, sourceChanges, availabilityChanges, planHash, preservedHash, alreadyApplied: false, verified: true}
  }
  return {chunkIds: scope.chunkIds, before, changes, sourceChanges, availabilityChanges, planHash, preservedHash, alreadyApplied: false, verified: false}
}

export async function repairPointAssociations({snapshotFile, targetEnv, reportFile, apply = false, target = 'local', ...targetOptions}) {
  process.umask(0o077)
  const content = await readFile(path.resolve(snapshotFile), 'utf8'), snapshot = JSON.parse(content)
  associationRepairScope(snapshot)
  const snapshotSha256 = sha256(content)
  const sourceHash = historyPlanHash({snapshotSha256, operation: OPERATION, version: ASSOCIATION_REPAIR_VERSION})
  const configuration = await loadEnv(targetEnv)
  const context = await historyTarget({target, configuration, sourceHash, targetEnv, apply, withStorage: false, ...targetOptions})
  const {prisma, close, attestation, expected, backup} = context
  let output, restoreGlobals
  const persist = async report => {await output.truncate(0); await output.write(`${JSON.stringify(report, null, 2)}\n`, 0, 'utf8'); await output.sync()}
  try {
    output = await reservePrivateReport(reportFile)
    if (expected && (expected.sourceHash !== sourceHash || expected.attestation?.fingerprint !== attestation.fingerprint)) {
      throw new Error('Le rapport précédent ne correspond pas à cette cohorte et cette cible')
    }
    restoreGlobals = bindHistoryTargetGlobals(context)
    const helpers = {...await import('../../lib/declaration-importer/native-point-association.js'),
      ...await import('../../lib/handlers/chunks.js')}
    const evidence = apply && target === 'testing' ? JSON.parse(await readFile(targetOptions.backupEvidence, 'utf8')) : undefined
    const reportBase = {createdAt: new Date().toISOString(), target, operation: OPERATION, apply,
      attestation, backup, sourceHash, snapshotSha256, version: ASSOCIATION_REPAIR_VERSION}
    const result = await prisma.$transaction(async tx => {
      if (!apply) await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
      await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'")
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '30s'")
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '3s'")
      const result = await reconcilePointAssociations(tx, {snapshot, apply, previousReport: expected, helpers, validatePlan: plan => {
        if (apply && target === 'testing') {
          assertHistorySimulation(expected, {target, operation: OPERATION, sourceHash, planHash: plan.planHash, attestation})
          if (!plan.alreadyApplied) assertAssociationBackup(evidence, snapshot, {sourceHash, planHash: plan.planHash, snapshotSha256})
        }
      }})
      if (apply) await persist({...reportBase, complete: false, phase: 'PREPARED', ...result})
      return result
    }, {timeout: 1200000, isolationLevel: 'RepeatableRead'})
    const report = {...reportBase, complete: true, phase: apply ? 'COMMITTED' : 'SIMULATED', ...result}
    await persist(report)
    console.log(JSON.stringify({target, operation: OPERATION, apply, complete: true, changes: result.changes.length,
      sources: result.sourceChanges.length, alreadyApplied: result.alreadyApplied, verified: result.verified}))
    return report
  } finally {restoreGlobals?.(); await output?.close(); await close()}
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const {values} = parseArgs({options: {...HISTORY_TARGET_OPTIONS, snapshot: {type: 'string'},
    'target-env': {type: 'string'}, report: {type: 'string'}, apply: {type: 'boolean', default: false}}})
  repairPointAssociations({snapshotFile: values.snapshot, targetEnv: values['target-env'], reportFile: values.report,
    apply: values.apply, ...historyTargetArguments(values)})
    .catch(error => {console.error(JSON.stringify({operation: OPERATION, error: error.name, code: error.code ?? null, message: error.message})); process.exitCode = 1})
}
