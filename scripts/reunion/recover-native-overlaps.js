#!/usr/bin/env node
import process from 'node:process'
import path from 'node:path'
import {readFile} from 'node:fs/promises'
import {parseArgs} from 'node:util'
import {Prisma} from '@prisma/client'
import {nativeDimension, periodsOverlap} from '../../lib/declaration-importer/native-conflicts.js'
import {nativeRecoveryId, NATIVE_OVERLAP_RECOVERY_VERSION} from '../../lib/declaration-importer/native-overlap-recovery.js'
import {normalizeMetricTypeCode, getCompatibleMetricTypeCodes} from '../../lib/constants/metric-type-codes.js'
import {sha256} from './lib/core.js'
import {loadEnv} from './lib/runtime.js'
import {reservePrivateReport} from './lib/access-cli.js'
import {repairChunkTotals} from './repair-point-associations.js'
import {historyTarget, historyPlanHash, assertHistorySimulation, bindHistoryTargetGlobals,
  HISTORY_TARGET_OPTIONS, historyTargetArguments} from './lib/history-target.js'

export const OVERLAP_OPERATION = 'reunion-native-overlap-recovery'
const VERSION = NATIVE_OVERLAP_RECOVERY_VERSION
const VISIBLE = ['PENDING', 'VALIDATED', 'AUTOMATICALLY_VALIDATED']
const TYPES = new Set(['instantaneous', 'average', 'minimum', 'maximum', 'median', 'delta-index', 'raw', 'cumulative'])
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
const clean = value => JSON.parse(JSON.stringify(value))
const hash = value => historyPlanHash(clean(value))
const unique = values => [...new Set(values.filter(Boolean))].sort()
const businessDate = date => new Date(new Date(+new Date(date) + 4 * 3600000).toISOString().slice(0, 10))
const ExactDecimal = Prisma.Decimal.clone({precision: 80})
const valueFields = value => ({metricTypeCode: value.metricTypeCode, unit: value.unit, frequency: value.frequency,
  periodStart: new Date(value.periodStart), periodEnd: new Date(value.periodEnd), valueKind: value.valueKind,
  value: String(value.value), remark: value.remark, metadata: value.metadata})

function validateIds(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 500 || unique(ids).length !== ids.length || ids.some(id => !UUID.test(id))) {
    throw new Error('Liste explicite de 1 à 500 UUID distincts obligatoire')
  }
}

export async function captureNativeOverlapSnapshot(client, {chunkIds}) {
  validateIds(chunkIds)
  const selected = await client.chunk.findMany({where: {id: {in: chunkIds}}, orderBy: {id: 'asc'}})
  if (selected.length !== chunkIds.length) throw new Error('Série sélectionnée absente')
  const sourceIds = unique(selected.map(chunk => chunk.sourceId)), pointIds = unique(selected.map(chunk => chunk.pointPrelevementId))
  const sources = await client.source.findMany({where: {id: {in: sourceIds}}, orderBy: {id: 'asc'}})
  const declarations = await client.declaration.findMany({where: {id: {in: unique(sources.map(source => source.declarationId))}}, orderBy: {id: 'asc'}})
  const chunks = await client.chunk.findMany({where: {sourceId: {in: sourceIds}}, orderBy: {id: 'asc'}})
  const points = await client.pointPrelevement.findMany({where: {id: {in: pointIds}}, orderBy: {id: 'asc'}})
  const exploitations = await client.declarantPointPrelevement.findMany({where: {pointPrelevementId: {in: pointIds}}, orderBy: {id: 'asc'}})
  const actorIds = unique(declarations.flatMap(declaration => [declaration.declarantUserId, declaration.createdByDeclarantUserId])
    .concat(chunks.flatMap(chunk => [chunk.preleveurUserId, chunk.submittedByDeclarantUserId, chunk.collecteurUserId])))
  const actors = await client.declarant.findMany({where: {userId: {in: actorIds}}, select: {userId: true, lastDeclarationAt: true}, orderBy: {userId: 'asc'}})
  const values = []
  // One bounded, indexed equality per chunk avoids the global ANY/ORDER BY plan
  // on the eighteen-million-row table. Never scan unrelated source values.
  for (const id of [...chunkIds].sort()) {
    const rows = await client.chunkValue.findMany({where: {chunkId: id}, orderBy: {id: 'asc'}, take: 100001})
    if (rows.length > 100000) throw new Error('Série trop volumineuse pour cette reprise ciblée')
    values.push(...rows)
  }
  return clean({version: VERSION, chunkIds: [...chunkIds].sort(), sources, declarations, chunks, points, exploitations, actors, values})
}

export function assertNativeOverlapSnapshot(snapshot) {
  validateIds(snapshot.chunkIds)
  if (snapshot.version !== VERSION || !Array.isArray(snapshot.values)) throw new Error('Version de sauvegarde invalide')
  const selected = snapshot.chunkIds.map(id => snapshot.chunks.find(chunk => chunk.id === id))
  for (const chunk of selected) {
    const source = snapshot.sources.find(row => row.id === chunk?.sourceId)
    const declaration = snapshot.declarations.find(row => row.id === source?.declarationId)
    const point = snapshot.points.find(row => row.id === chunk?.pointPrelevementId)
    if (!chunk || chunk.instructionStatus !== 'REJECTED' || chunk.metadata?.nativeTemporal !== true
      || chunk.metadata.superseded || chunk.metadata.nativeOverlapRecovery || chunk.calculationStrategy !== 'GENERIC'
      || chunk.autoCalculateVolumes !== false || !chunk.contentHash || !chunk.seriesKey
      || chunk.instructedAt || chunk.instructedByInstructorUserId || chunk.instructionComment
      || !chunk.parsingInfo?.issues?.some(issue => issue.code === 'OVERLAPPING_SERIES')
      || source?.type !== 'DECLARATION' || source.status !== 'COMPLETED' || source.metadata?.provenance !== 'DN' || source.metadata?.historicalAccepted !== true
      || !declaration?.importSourceId?.startsWith('reunion:') || declaration.declarantUserId !== chunk.preleveurUserId
      || !point || point.deletedAt || point.sourceId !== chunk.metadata.sourcePointReference
      || !/^reunion:DEP-974:point:\d+$/.test(point.sourceId) || point.identifiers?.REUNION !== point.sourceId.split(':').at(-1)
      || point.flowType !== chunk.flowType || !snapshot.values.some(value => value.chunkId === chunk.id)) {
      throw new Error(`Série hors de la reprise automatique Réunion : ${chunk?.id ?? 'absente'}`)
    }
    if (chunk.exploitationId) {
      const exploitation = snapshot.exploitations.find(row => row.id === chunk.exploitationId)
      if (!exploitation || exploitation.pointPrelevementId !== chunk.pointPrelevementId || exploitation.declarantUserId !== chunk.preleveurUserId
        || exploitation.usageId !== chunk.usageId || (exploitation.startDate && +new Date(exploitation.startDate) > +new Date(chunk.minDate))
        || (exploitation.endDate && +new Date(exploitation.endDate) < +new Date(chunk.maxDate))) throw new Error('Exploitation originale incohérente : revue nécessaire')
    }
  }
  if (new Set(snapshot.values.map(value => value.id)).size !== snapshot.values.length
    || new Set(snapshot.values.map(value => JSON.stringify([value.chunkId, value.periodStart, value.periodEnd]))).size !== snapshot.values.length
    || snapshot.values.some(value => !snapshot.chunkIds.includes(value.chunkId) || value.valueKind !== 'DECLARED')) {
    throw new Error('Valeurs originales hors périmètre ou dupliquées')
  }
  return selected
}

function sameDimension(left, right) {
  return left.pointPrelevementId === right.pointPrelevementId && left.preleveurUserId === right.preleveurUserId
    && nativeDimension(left.metadata) === nativeDimension(right.metadata)
    && (!TYPES.has(left.metadata?.valueType) || !TYPES.has(right.metadata?.valueType) || left.metadata.valueType === right.metadata.valueType)
}

export function partitionNativeOverlapValues(chunk, values, candidates, {allowIdentical = false} = {}) {
  const applicable = candidates.filter(candidate => sameDimension(chunk, candidate.chunk))
    .sort((a, b) => +new Date(a.periodStart) - +new Date(b.periodStart) || a.id.localeCompare(b.id))
  let cursor = 0
  let active = []
  const accepted = [], excluded = []
  for (const value of [...values].sort((a, b) => +new Date(a.periodStart) - +new Date(b.periodStart) || a.id.localeCompare(b.id))) {
    const start = +new Date(value.periodStart), end = +new Date(value.periodEnd)
    while (cursor < applicable.length && +new Date(applicable[cursor].periodStart) <= end) active.push(applicable[cursor++])
    active = active.filter(candidate => +new Date(candidate.periodEnd) > start
      || (+new Date(candidate.periodEnd) === start && +new Date(candidate.periodStart) === start))
    const overlaps = active.filter(candidate => candidate.id !== value.id && normalizeMetricTypeCode(candidate.metricTypeCode) === normalizeMetricTypeCode(value.metricTypeCode)
      && periodsOverlap(value, candidate))
    if (!overlaps.length) accepted.push(value)
    else {
      const identical = overlaps.every(candidate => +new Date(candidate.periodStart) === start && +new Date(candidate.periodEnd) === end
        && candidate.unit === value.unit && new ExactDecimal(candidate.value).equals(value.value))
      if (identical && allowIdentical) accepted.push(value)
      else excluded.push({valueId: value.id, reason: identical ? 'IDENTICAL_ALREADY_PUBLISHED' : 'OVERLAPPING_VALUE_OR_PERIOD',
        candidateValueIds: unique(overlaps.map(candidate => candidate.id)), candidateFingerprint: hash(overlaps)})
    }
  }
  return {accepted, excluded}
}

async function readCandidates(client, chunk, values) {
  const min = new Date(Math.min(...values.map(value => +new Date(value.periodStart))))
  const max = new Date(Math.max(...values.map(value => +new Date(value.periodEnd))))
  const rows = await client.chunkValue.findMany({where: {
    metricTypeCode: {in: unique(values.flatMap(value => getCompatibleMetricTypeCodes(value.metricTypeCode)))},
    periodStart: {lte: max}, periodEnd: {gte: min}, chunk: {
      pointPrelevementId: chunk.pointPrelevementId, preleveurUserId: chunk.preleveurUserId,
      instructionStatus: {in: VISIBLE}, source: {status: 'COMPLETED'}
    }}, take: 200001, include: {chunk: {select: {id: true, pointPrelevementId: true, preleveurUserId: true, metadata: true}}}})
  if (rows.length > 200000) throw new Error('Périmètre de comparaison trop volumineux')
  return clean(rows).sort((a, b) => a.id.localeCompare(b.id))
}

function createRecovery(chunk, values) {
  const selectionHash = hash(values), id = nativeRecoveryId(OVERLAP_OPERATION, `${chunk.id}:${chunk.contentHash}:${selectionHash}`)
  const min = new Date(Math.min(...values.map(value => +new Date(value.periodStart))))
  const max = new Date(Math.max(...values.map(value => +new Date(value.periodEnd) - (+new Date(value.periodEnd) > +new Date(value.periodStart) ? 1 : 0))))
  const issues = (chunk.parsingInfo?.issues ?? []).filter(issue => issue.code !== 'OVERLAPPING_SERIES')
  const recovery = {version: VERSION, parentChunkId: chunk.id, parentSeriesKey: chunk.seriesKey,
    parentContentHash: chunk.contentHash, selectionHash, valueCount: values.length}
  const {id: _id, createdAt: _created, updatedAt: _updated, ...original} = chunk
  return {chunk: {...original, id, seriesKey: `${chunk.seriesKey}:recovery:${selectionHash.slice(0, 16)}`,
    contentHash: hash({parentContentHash: chunk.contentHash, selectionHash}),
    instructionStatus: chunk.exploitationId ? 'VALIDATED' : 'PENDING', minDate: businessDate(min), maxDate: businessDate(max),
    parsingInfo: {...chunk.parsingInfo, issues, issueCounts: {total: issues.length,
      byCode: Object.fromEntries(unique(issues.map(issue => issue.code)).map(code => [code, issues.filter(issue => issue.code === code).length])),
      bySeverity: Object.fromEntries(unique(issues.map(issue => issue.severity)).map(severity => [severity, issues.filter(issue => issue.severity === severity).length]))}, issuesSampled: false},
    metadata: {...chunk.metadata, ...repairChunkTotals(values, chunk.flowType), nativeOverlapRecovery: recovery}},
  values: values.map(value => ({...valueFields(value), id: nativeRecoveryId(OVERLAP_OPERATION, `${id}:${value.id}`), chunkId: id,
    metadata: {...value.metadata, nativeOverlapRecovery: {version: VERSION, originalChunkId: chunk.id, originalValueId: value.id}}}))}
}

function preservedState(snapshot) {
  return {...snapshot, sources: snapshot.sources.map(source => {
    const {updatedAt: _updated, globalInstructionStatus: _status, metadata, ...rest} = source
    return {...rest, metadata: Object.fromEntries(Object.entries(metadata ?? {}).filter(([key]) => !['totalWaterVolumeWithdrawn', 'totalWaterVolumeDischarged'].includes(key)))}
  }), exploitations: snapshot.exploitations.map(row => {
    const {updatedAt: _updated, mostRecentAvailableDate: _date, ...rest} = row
    return rest
  }), actors: snapshot.actors.map(row => ({userId: row.userId})),
  chunks: snapshot.chunks.filter(chunk => !chunk.metadata?.nativeOverlapRecovery)}
}

export async function planNativeOverlapRecovery(client, snapshot) {
  const selected = assertNativeOverlapSnapshot(snapshot)
  const allCandidates = [], publications = [], decisions = [], initial = new Map()
  for (const chunk of selected.sort((a, b) => a.id.localeCompare(b.id))) {
    const values = snapshot.values.filter(value => value.chunkId === chunk.id)
    const candidates = await readCandidates(client, chunk, values)
    initial.set(chunk.id, {values, candidates, partition: partitionNativeOverlapValues(chunk, values, candidates)})
    allCandidates.push({chunkId: chunk.id, fingerprint: hash(candidates)})
  }
  const possible = selected.flatMap(chunk => initial.get(chunk.id).partition.accepted.map(value => ({...value, chunk})))
  for (const chunk of selected) {
    const {values, candidates, partition: first} = initial.get(chunk.id)
    // Unknown conflicting readings inside this cohort are all withheld. Stable
    // order is used only to keep one of several strictly identical readings.
    const cohort = partitionNativeOverlapValues(chunk, first.accepted, possible, {allowIdentical: true})
    const comparison = [...candidates, ...publications.flatMap(publication => publication.values.map(value => ({...value, chunk: publication.chunk})))]
    const partition = partitionNativeOverlapValues(chunk, cohort.accepted, comparison)
    if (partition.accepted.length) publications.push(createRecovery(chunk, partition.accepted))
    decisions.push({chunkId: chunk.id, originalValues: values.length, recoverable: partition.accepted.length,
      excluded: [...first.excluded, ...cohort.excluded.map(item => ({...item, reason: 'CONTRADICTORY_RECOVERY_COHORT'})), ...partition.excluded]})
  }
  return {publications, decisions, candidateFingerprints: allCandidates,
    planHash: hash({version: VERSION, snapshotHash: hash(snapshot), publications, decisions, allCandidates})}
}

export function assertNativeOverlapBackup(evidence, snapshot, {sourceHash, planHash, snapshotSha256}) {
  if (evidence?.operation !== OVERLAP_OPERATION || evidence.sourceHash !== sourceHash || evidence.planHash !== planHash
    || evidence.backup?.sha256 !== snapshotSha256 || evidence.rowsSha256 !== hash(snapshot)) {
    throw new Error('Sauvegarde restaurée de la même cohorte et du même plan obligatoire')
  }
}

export function nativeOverlapTransactionOptions(apply = false) {
  // A repeatable-read snapshot taken by the first dossier lock would miss an
  // import committed before we acquire the point lock. APPLY re-reads only
  // after acquiring every lock; previews retain one consistent read snapshot.
  return {timeout: 1200000, isolationLevel: apply ? 'ReadCommitted' : 'RepeatableRead'}
}

export async function reconcileNativeOverlaps(client, {snapshot, apply = false, previousReport, validatePlan = () => {}, helpers}) {
  assertNativeOverlapSnapshot(snapshot)
  if (apply) {
    for (const [table, ids] of [['Declaration', snapshot.declarations.map(row => row.id)], ['Source', snapshot.sources.map(row => row.id)],
      ['PointPrelevement', snapshot.points.map(row => row.id)], ['DeclarantPointPrelevement', snapshot.exploitations.map(row => row.id)],
      ['Chunk', snapshot.chunks.map(row => row.id)]]) {
      await client.$queryRawUnsafe(`SELECT id FROM "${table}" WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`, ids.sort())
    }
    for (const pointId of snapshot.points.map(row => row.id).sort()) {
      await client.$queryRawUnsafe("SELECT pg_advisory_xact_lock(hashtext('volumes-from-index'), hashtext($1))::text", pointId)
    }
  }
  const before = await captureNativeOverlapSnapshot(client, {chunkIds: snapshot.chunkIds})
  if (previousReport?.complete && previousReport.operation === OVERLAP_OPERATION && previousReport.afterHash === hash(before)
    && previousReport.originalHash === hash(snapshot)) {
    for (const publication of previousReport.previousPublications ?? previousReport.publications ?? []) {
      const values = await client.chunkValue.findMany({where: {chunkId: publication.chunk.id}, orderBy: {id: 'asc'}})
      const expected = publication.values.map(({createdAt: _created, updatedAt: _updated, ...value}) => value).sort((a, b) => a.id.localeCompare(b.id))
      const actual = values.map(({createdAt: _created, updatedAt: _updated, ...value}) => value)
      if (hash(expected) !== hash(actual)) throw new Error('Publication dérivée modifiée depuis la reprise')
    }
    const planHash = hash({version: VERSION, beforeHash: hash(before), publications: []})
    await validatePlan({planHash, alreadyApplied: true})
    return {originalHash: hash(snapshot), afterHash: hash(before), publications: [], decisions: previousReport.decisions,
      previousPublications: previousReport.previousPublications ?? previousReport.publications, planHash, alreadyApplied: true, verified: true}
  }
  if (hash(before) !== hash(snapshot)) throw new Error('État courant différent de la sauvegarde : nouvelle revue requise')
  const plan = await planNativeOverlapRecovery(client, snapshot)
  await validatePlan({...plan, alreadyApplied: false})
  if (!apply) return {...plan, originalHash: hash(snapshot), alreadyApplied: false, verified: false}
  for (const publication of plan.publications) {
    await client.chunk.create({data: publication.chunk})
    for (let offset = 0; offset < publication.values.length; offset += 1000) {
      await client.chunkValue.createMany({data: publication.values.slice(offset, offset + 1000)})
    }
  }
  for (const source of snapshot.sources) {
    const additions = plan.publications.filter(publication => publication.chunk.sourceId === source.id)
    if (!additions.length) continue
    const chunks = [...snapshot.chunks.filter(chunk => chunk.sourceId === source.id), ...additions.map(item => item.chunk)]
    const metadata = {...source.metadata}
    for (const key of ['totalWaterVolumeWithdrawn', 'totalWaterVolumeDischarged']) {
      metadata[key] = additions.reduce((sum, addition) => sum.plus(addition.chunk.metadata[key] ?? 0), new ExactDecimal(metadata[key] ?? 0)).toNumber()
    }
    await client.source.update({where: {id: source.id}, data: {metadata,
      globalInstructionStatus: helpers.computeGlobalPointMatchingStatus(chunks.filter(chunk => !chunk.metadata?.superseded))}})
    const declaration = snapshot.declarations.find(item => item.id === source.declarationId)
    await helpers.refreshMostRecentAvailableDateForDeclarantPoints({declarantUserId: declaration.declarantUserId,
      pointPrelevementIds: additions.map(item => item.chunk.pointPrelevementId), client})
    await helpers.refreshSourceDeclarantsLastDeclarationAt(source.id, {client})
  }
  await helpers.refreshChunkValueSummaries(plan.publications.map(item => item.chunk.id), {client})
  const after = await captureNativeOverlapSnapshot(client, {chunkIds: snapshot.chunkIds})
  if (hash(preservedState(snapshot)) !== hash(preservedState(after))) throw new Error('Des données originales ont changé : transaction annulée')
  for (const publication of plan.publications) {
    const actual = await client.chunkValue.findMany({where: {chunkId: publication.chunk.id}, orderBy: {id: 'asc'}})
    if (hash(actual.map(({createdAt: _created, updatedAt: _updated, ...value}) => value))
      !== hash([...publication.values].sort((a, b) => a.id.localeCompare(b.id)))) throw new Error('Copie des valeurs différente : transaction annulée')
  }
  return {...plan, originalHash: hash(snapshot), afterHash: hash(after), alreadyApplied: false, verified: true}
}

export async function recoverNativeOverlaps({snapshotFile, targetEnv, reportFile, apply = false, target = 'local', ...targetOptions}) {
  process.umask(0o077)
  const bytes = await readFile(snapshotFile), snapshot = JSON.parse(bytes)
  assertNativeOverlapSnapshot(snapshot)
  const snapshotSha256 = sha256(bytes), sourceHash = hash({snapshotSha256, operation: OVERLAP_OPERATION, version: VERSION})
  const configuration = await loadEnv(targetEnv)
  const context = await historyTarget({target, configuration, sourceHash, targetEnv, apply, withStorage: false, ...targetOptions})
  const {prisma, expected, attestation, close} = context
  let output, restoreGlobals
  const persist = async report => {await output.truncate(0); await output.write(`${JSON.stringify(report, null, 2)}\n`, 0, 'utf8'); await output.sync()}
  try {
    output = await reservePrivateReport(reportFile)
    restoreGlobals = bindHistoryTargetGlobals(context)
    const helpers = {...await import('../../lib/handlers/chunks.js'), ...await import('../../lib/services/declaration-side-effects.js'),
      ...await import('../../lib/models/declarant.js'), ...await import('../../lib/services/chunk-value-summaries.js')}
    const evidence = apply && target === 'testing' ? JSON.parse(await readFile(targetOptions.backupEvidence, 'utf8')) : null
    const base = {createdAt: new Date().toISOString(), version: VERSION, operation: OVERLAP_OPERATION, target, apply, sourceHash, snapshotSha256, attestation}
    const result = await prisma.$transaction(async client => {
      if (!apply) await client.$queryRawUnsafe('SET TRANSACTION READ ONLY')
      await client.$queryRawUnsafe("SET LOCAL TIME ZONE 'UTC'")
      await client.$queryRawUnsafe("SET LOCAL statement_timeout='30s'")
      await client.$queryRawUnsafe("SET LOCAL lock_timeout='3s'")
      const result = await reconcileNativeOverlaps(client, {snapshot, apply, previousReport: expected, helpers,
        validatePlan: plan => {
          if (apply && target === 'testing') {
            assertHistorySimulation(expected, {...base, planHash: plan.planHash})
            if (!plan.alreadyApplied) assertNativeOverlapBackup(evidence, snapshot, {sourceHash, planHash: plan.planHash, snapshotSha256})
          }
        }})
      if (apply) await persist({...base, ...result, complete: false, phase: 'PREPARED'})
      return result
    }, nativeOverlapTransactionOptions(apply))
    const report = {...base, ...result, complete: true, phase: apply ? 'COMMITTED' : 'SIMULATED'}
    await persist(report)
    console.log(JSON.stringify({operation: OVERLAP_OPERATION, target, apply, complete: true, publications: result.publications.length,
      values: result.publications.reduce((sum, item) => sum + item.values.length, 0), alreadyApplied: result.alreadyApplied}))
    return report
  } finally {restoreGlobals?.(); await output?.close(); await close()}
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const {values} = parseArgs({options: {...HISTORY_TARGET_OPTIONS, snapshot: {type: 'string'},
    'target-env': {type: 'string'}, report: {type: 'string'}, apply: {type: 'boolean', default: false}}})
  recoverNativeOverlaps({snapshotFile: values.snapshot, targetEnv: values['target-env'], reportFile: values.report,
    apply: values.apply, ...historyTargetArguments(values)})
    .catch(error => {console.error(JSON.stringify({operation: OVERLAP_OPERATION, error: error.name, code: error.code ?? null, message: error.message})); process.exitCode = 1})
}
