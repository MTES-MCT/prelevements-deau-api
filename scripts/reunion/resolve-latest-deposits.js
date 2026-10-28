#!/usr/bin/env node
import process from 'node:process'
import path from 'node:path'
import {readFile} from 'node:fs/promises'
import {parseArgs} from 'node:util'
import {Prisma} from '@prisma/client'
import {nativeDimension, periodsOverlap} from '../../lib/declaration-importer/native-conflicts.js'
import {nativeRecoveryId} from '../../lib/declaration-importer/native-overlap-recovery.js'
import {normalizeMetricTypeCode} from '../../lib/constants/metric-type-codes.js'
import {captureNativeOverlapSnapshot, createRecovery, readCandidates, partitionNativeOverlapValues,
  nativeOverlapTransactionOptions} from './recover-native-overlaps.js'
import {repairChunkTotals} from './repair-point-associations.js'
import {assertLatestDepositReview, verifyLatestDepositEvidence} from './lib/latest-deposit-evidence.js'
import {sha256} from './lib/core.js'
import {loadEnv} from './lib/runtime.js'
import {reservePrivateReport} from './lib/access-cli.js'
import {historyTarget, historyPlanHash, assertHistorySimulation, bindHistoryTargetGlobals,
  HISTORY_TARGET_OPTIONS, historyTargetArguments} from './lib/history-target.js'

export const LATEST_DEPOSIT_OPERATION = 'reunion-latest-dn-deposit'
const VERSION = 1
const VISIBLE = ['PENDING', 'VALIDATED', 'AUTOMATICALLY_VALIDATED']
const TOTALS = ['totalWaterVolume', 'totalWaterVolumeWithdrawn', 'totalWaterVolumeDischarged']
const clean = value => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item))
const hash = value => historyPlanHash(clean(value))
const unique = values => [...new Set(values)].sort()
const without = (object, keys) => Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)))
const businessDate = date => new Date(new Date(+new Date(date) + 4 * 3600000).toISOString().slice(0, 10))
const ExactDecimal = Prisma.Decimal.clone({precision: 80})

export async function captureLatestDepositSnapshot(client, {review}) {
  assertLatestDepositReview(review)
  const chunkIds = unique(review.pairs.flatMap(pair => [pair.winner.chunkId, pair.loser.chunkId]))
  const valueIds = review.pairs.flatMap(pair => [pair.winner.value.id, pair.loser.value.id])
  const snapshot = await captureNativeOverlapSnapshot(client, {chunkIds})
  const replacementAudits = await client.chunkValueReplacement.findMany({where: {replacedChunkValueId: {in: valueIds}}, orderBy: {id: 'asc'}})
  const summaries = await client.chunkValueSummary.findMany({where: {chunkId: {in: chunkIds}}, orderBy: {chunkId: 'asc'}})
  return clean({...snapshot, operation: LATEST_DEPOSIT_OPERATION, reviewHash: hash(review), replacementAudits, summaries})
}

function sameReviewedValue(actual, expected) {
  return actual && actual.id === expected.id && actual.chunkId === expected.chunkId
    && ['metricTypeCode', 'unit', 'frequency'].every(key => actual[key] === expected[key])
    && ['periodStart', 'periodEnd'].every(key => +new Date(actual[key]) === +new Date(expected[key]))
    && new ExactDecimal(actual.value).equals(expected.value) && hash(actual.metadata) === hash(expected.metadata)
}

function validateSide(snapshot, pair, side, winner) {
  const chunk = snapshot.chunks.find(row => row.id === side.chunkId)
  const source = snapshot.sources.find(row => row.id === side.sourceId)
  const declaration = snapshot.declarations.find(row => row.id === source?.declarationId)
  const point = snapshot.points.find(row => row.id === pair.pointId)
  const value = snapshot.values.find(row => row.id === side.value.id)
  if (!chunk || chunk.sourceId !== source?.id || chunk.pointPrelevementId !== pair.pointId
    || !sameReviewedValue(value, side.value) || value.valueKind !== 'DECLARED'
    || source.type !== 'DECLARATION' || source.status !== 'COMPLETED' || source.metadata?.provenance !== 'DN' || !source.metadata?.historicalAccepted
    || declaration?.importSourceId !== `reunion:DN:80149:${side.dossier}` || declaration.declarantUserId !== chunk.preleveurUserId
    || chunk.metadata?.nativeTemporal !== true || chunk.metadata.superseded || chunk.metadata.nativeOverlapRecovery
    || chunk.calculationStrategy !== 'GENERIC' || chunk.autoCalculateVolumes !== false || !chunk.contentHash || !chunk.seriesKey
    || chunk.instructedAt || chunk.instructedByInstructorUserId || chunk.instructionComment
    || !point || point.deletedAt || point.sourceId !== `reunion:DEP-974:point:${pair.pointNumber}`
    || point.identifiers?.REUNION !== pair.pointNumber || point.sourceId !== chunk.metadata.sourcePointReference || point.flowType !== chunk.flowType
    || (winner ? chunk.instructionStatus !== 'REJECTED' || !chunk.parsingInfo?.issues?.some(row => row.code === 'OVERLAPPING_SERIES')
      : !VISIBLE.includes(chunk.instructionStatus))) {
    throw new Error('Paire différente de la revue ou hors reprise native DN acceptée')
  }
  if (chunk.exploitationId) {
    const exploitation = snapshot.exploitations.find(row => row.id === chunk.exploitationId)
    if (!exploitation || exploitation.pointPrelevementId !== pair.pointId || exploitation.declarantUserId !== chunk.preleveurUserId
      || exploitation.usageId !== chunk.usageId || (exploitation.startDate && +new Date(exploitation.startDate) > +new Date(chunk.minDate))
      || (exploitation.endDate && +new Date(exploitation.endDate) < +new Date(chunk.maxDate))) throw new Error('Exploitation historique incohérente')
  }
  return {chunk, value}
}

export async function planLatestDepositResolution(client, {review, snapshot}) {
  assertLatestDepositReview(review)
  if (snapshot.operation !== LATEST_DEPOSIT_OPERATION || snapshot.reviewHash !== hash(review) || snapshot.replacementAudits.length) {
    throw new Error('Snapshot neuf lié à la même revue obligatoire')
  }
  const publications = [], archives = [], decisions = [], changes = [], candidates = [], winners = []
  for (const pair of review.pairs) {
    const winner = validateSide(snapshot, pair, pair.winner, true), loser = validateSide(snapshot, pair, pair.loser, false)
    if (winner.chunk.preleveurUserId !== loser.chunk.preleveurUserId || winner.chunk.flowType !== loser.chunk.flowType
      || nativeDimension(winner.chunk.metadata) !== nativeDimension(loser.chunk.metadata)
      || winner.chunk.metadata.valueType !== loser.chunk.metadata.valueType
      || normalizeMetricTypeCode(winner.value.metricTypeCode) !== normalizeMetricTypeCode(loser.value.metricTypeCode)
      || winner.value.unit !== loser.value.unit || !periodsOverlap(winner.value, loser.value)) throw new Error('Dimensions ou périodes de paire incompatibles')
    const visible = await readCandidates(client, winner.chunk, [winner.value])
    const overlap = partitionNativeOverlapValues(winner.chunk, [winner.value], visible).excluded[0]
    if (hash(overlap?.candidateValueIds) !== hash([loser.value.id])) throw new Error('Chevauchement visible supplémentaire ou perdant absent : nouvelle revue requise')
    candidates.push({valueId: winner.value.id, fingerprint: hash(visible)})
    winners.push({...winner.value, chunk: winner.chunk})
    const publication = createRecovery(winner.chunk, [winner.value])
    publication.chunk.metadata.nativeLatestDepositResolution = {version: VERSION, reviewHash: hash(review), decisionField: 'dateDepot'}
    publications.push(publication)
    const decision = {case: pair.case, pointId: pair.pointId, winnerValueId: winner.value.id, loserValueId: loser.value.id,
      winnerDossier: pair.winner.dossier, loserDossier: pair.loser.dossier,
      winnerDateDepot: pair.winner.dateDepot, loserDateDepot: pair.loser.dateDepot, publicationValueId: publication.values[0].id}
    decisions.push(decision)
    archives.push({id: nativeRecoveryId(LATEST_DEPOSIT_OPERATION, `${loser.value.id}:${publication.values[0].id}`),
      replacedChunkValueId: loser.value.id, replacedChunkId: loser.chunk.id, replacedSourceId: loser.chunk.sourceId,
      replacementChunkValueId: publication.values[0].id, replacementChunkId: publication.chunk.id, replacementSourceId: winner.chunk.sourceId,
      pointPrelevementId: pair.pointId, metricTypeCode: loser.value.metricTypeCode, unit: loser.value.unit, frequency: loser.value.frequency,
      periodStart: new Date(loser.value.periodStart), periodEnd: new Date(loser.value.periodEnd), valueKind: loser.value.valueKind, value: loser.value.value,
      conflictPolicy: 'REUNION_DN_LATEST_DEPOSIT', replaceComment: 'Arbitrage : conserver le dossier DN déposé le plus récemment, sans découper les périodes.',
      metadata: {version: VERSION, reviewHash: hash(review), decision, originalValue: loser.value,
        originalChunk: loser.chunk, winnerDateEvidence: pair.winner.dateEvidence, loserDateEvidence: pair.loser.dateEvidence}})
  }
  for (const winner of winners) {
    if (partitionNativeOverlapValues(winner.chunk, [winner], winners).excluded.length) throw new Error('Les gagnants de la revue se chevauchent')
  }
  for (const chunkId of unique(archives.map(row => row.replacedChunkId))) {
    const chunk = snapshot.chunks.find(row => row.id === chunkId)
    const remaining = snapshot.values.filter(row => row.chunkId === chunkId && !archives.some(archive => archive.replacedChunkValueId === row.id))
    const bounds = remaining.length ? {
      minDate: businessDate(Math.min(...remaining.map(row => +new Date(row.periodStart)))),
      maxDate: businessDate(Math.max(...remaining.map(row => +new Date(row.periodEnd) - (+new Date(row.periodEnd) > +new Date(row.periodStart) ? 1 : 0))))
    } : {instructionStatus: 'REJECTED'}
    changes.push({id: chunkId, data: {...bounds, metadata: {...chunk.metadata, ...repairChunkTotals(remaining, chunk.flowType),
      nativeLatestDepositResolution: {version: VERSION, reviewHash: hash(review), replacedValueIds: archives.filter(row => row.replacedChunkId === chunkId).map(row => row.replacedChunkValueId)}}}})
  }
  return {publications, archives, decisions, changes, candidateFingerprints: candidates,
    planHash: hash({version: VERSION, snapshotHash: hash(snapshot), publications, archives, decisions, changes, candidates})}
}

function preservedState(snapshot, {removed, changed, created}) {
  return {...snapshot, values: snapshot.values.filter(row => !removed.includes(row.id)), replacementAudits: [], summaries: [],
    sources: snapshot.sources.map(row => ({...without(row, ['updatedAt', 'globalInstructionStatus']), metadata: without(row.metadata, TOTALS)})),
    chunks: snapshot.chunks.filter(row => !created.includes(row.id)).map(row => changed.includes(row.id)
      ? {...without(row, ['updatedAt', 'instructionStatus', 'minDate', 'maxDate']), metadata: without(row.metadata, [...TOTALS, 'nativeLatestDepositResolution'])} : row),
    exploitations: snapshot.exploitations.map(row => without(row, ['updatedAt', 'mostRecentAvailableDate'])), actors: snapshot.actors.map(row => ({userId: row.userId}))}
}

async function verifyPublications(client, plan) {
  for (const publication of plan.publications) {
    const chunk = await client.chunk.findUniqueOrThrow({where: {id: publication.chunk.id}})
    if (hash(without(chunk, ['createdAt', 'updatedAt'])) !== hash(publication.chunk)) throw new Error('Série gagnante différente du plan')
    const rows = await client.chunkValue.findMany({where: {chunkId: publication.chunk.id}, orderBy: {id: 'asc'}})
    if (hash(rows.map(row => without(row, ['createdAt', 'updatedAt']))) !== hash(publication.values)) throw new Error('Copie gagnante différente du plan')
    const candidates = await readCandidates(client, publication.chunk, publication.values)
    if (partitionNativeOverlapValues(publication.chunk, publication.values, candidates).excluded.length) throw new Error('Conflit apparu après publication')
  }
  const archives = await client.chunkValueReplacement.findMany({where: {id: {in: plan.archives.map(row => row.id)}}, orderBy: {id: 'asc'}})
  if (hash(archives.map(row => without(row, ['createdAt']))) !== hash([...plan.archives].sort((a, b) => a.id.localeCompare(b.id)))) {
    throw new Error('Archive de remplacement différente du plan')
  }
  for (const change of plan.changes) {
    const chunk = await client.chunk.findUniqueOrThrow({where: {id: change.id}})
    if (hash(Object.fromEntries(Object.keys(change.data).map(key => [key, chunk[key]]))) !== hash(change.data)) throw new Error('Série remplacée différente du plan')
  }
}

export async function reconcileLatestDeposits(client, {review, snapshot, apply = false, previousReport, helpers, validatePlan = () => {}}) {
  assertLatestDepositReview(review)
  if (snapshot.reviewHash !== hash(review)) throw new Error('Revue différente du snapshot')
  if (apply) {
    for (const [table, ids] of [['Declaration', snapshot.declarations.map(row => row.id)], ['Source', snapshot.sources.map(row => row.id)],
      ['PointPrelevement', snapshot.points.map(row => row.id)], ['DeclarantPointPrelevement', snapshot.exploitations.map(row => row.id)], ['Chunk', snapshot.chunks.map(row => row.id)]]) {
      await client.$queryRawUnsafe(`SELECT id FROM "${table}" WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`, ids.sort())
    }
    for (const pointId of snapshot.points.map(row => row.id).sort()) {
      await client.$queryRawUnsafe("SELECT pg_advisory_xact_lock(hashtext('volumes-from-index'), hashtext($1))::text", pointId)
    }
  }
  const before = await captureLatestDepositSnapshot(client, {review})
  if (previousReport?.complete && previousReport.operation === LATEST_DEPOSIT_OPERATION && previousReport.afterHash === hash(before)
    && previousReport.originalHash === hash(snapshot)) {
    const originalPlan = previousReport.originalPlan ?? previousReport
    await verifyPublications(client, originalPlan)
    const planHash = hash({version: VERSION, beforeHash: hash(before), changes: []})
    await validatePlan({planHash, alreadyApplied: true})
    return {planHash, originalHash: hash(snapshot), afterHash: hash(before), originalPlan, publications: [], archives: [], changes: [],
      decisions: originalPlan.decisions, alreadyApplied: true, verified: true}
  }
  if (hash(before) !== hash(snapshot)) throw new Error('État courant différent de la sauvegarde : nouvelle revue requise')
  const plan = await planLatestDepositResolution(client, {review, snapshot})
  await validatePlan({...plan, alreadyApplied: false})
  if (!apply) return {...plan, originalHash: hash(snapshot), alreadyApplied: false, verified: false}
  // Archive the complete old rows before withdrawing their visibility. The raw
  // DN files and the rejected winning originals remain untouched.
  await client.chunkValueReplacement.createMany({data: plan.archives})
  const removed = plan.archives.map(row => row.replacedChunkValueId)
  const deletion = await client.chunkValue.deleteMany({where: {id: {in: removed}}})
  if (deletion.count !== removed.length) throw new Error('Nombre de remplacements différent du plan')
  for (const change of plan.changes) await client.chunk.update({where: {id: change.id}, data: change.data})
  for (const publication of plan.publications) {
    await client.chunk.create({data: publication.chunk})
    await client.chunkValue.createMany({data: publication.values})
  }
  for (const source of snapshot.sources) {
    const chunks = await client.chunk.findMany({where: {sourceId: source.id}})
    const metadata = {...source.metadata}
    for (const key of ['totalWaterVolumeWithdrawn', 'totalWaterVolumeDischarged']) metadata[key] = chunks.filter(row => VISIBLE.includes(row.instructionStatus))
      .reduce((sum, row) => sum.plus(row.metadata?.[key] ?? 0), new ExactDecimal(0)).toNumber()
    await client.source.update({where: {id: source.id}, data: {metadata, globalInstructionStatus: helpers.computeGlobalPointMatchingStatus(chunks.filter(row => !row.metadata?.superseded))}})
    const declaration = snapshot.declarations.find(row => row.id === source.declarationId)
    await helpers.refreshMostRecentAvailableDateForDeclarantPoints({declarantUserId: declaration.declarantUserId,
      pointPrelevementIds: unique(review.pairs.filter(pair => [pair.winner.sourceId, pair.loser.sourceId].includes(source.id)).map(pair => pair.pointId)), client})
    await helpers.refreshSourceDeclarantsLastDeclarationAt(source.id, {client})
  }
  await helpers.refreshChunkValueSummaries([...plan.changes.map(row => row.id), ...plan.publications.map(row => row.chunk.id)], {client})
  const after = await captureLatestDepositSnapshot(client, {review})
  const scope = {removed, changed: plan.changes.map(row => row.id), created: plan.publications.map(row => row.chunk.id)}
  if (hash(preservedState(snapshot, scope)) !== hash(preservedState(after, scope))) throw new Error('Des données hors arbitrage ont changé : transaction annulée')
  await verifyPublications(client, plan)
  return {...plan, originalHash: hash(snapshot), afterHash: hash(after), alreadyApplied: false, verified: true}
}

export function assertLatestDepositBackup(evidence, snapshot, {sourceHash, planHash, snapshotSha256}) {
  if (evidence?.operation !== LATEST_DEPOSIT_OPERATION || evidence.sourceHash !== sourceHash || evidence.planHash !== planHash
    || evidence.backup?.sha256 !== snapshotSha256 || evidence.rowsSha256 !== hash(snapshot)) {
    throw new Error('Sauvegarde restaurée de la même revue et du même plan obligatoire')
  }
}

export async function resolveLatestDeposits({reviewFile, snapshotFile, targetEnv, reportFile, apply = false, target = 'local', ...targetOptions}) {
  process.umask(0o077)
  const reviewBytes = await readFile(reviewFile), review = JSON.parse(reviewBytes)
  const dateEvidence = await verifyLatestDepositEvidence(review)
  const bytes = await readFile(snapshotFile), snapshot = JSON.parse(bytes), snapshotSha256 = sha256(bytes)
  const sourceHash = hash({snapshotSha256, reviewSha256: sha256(reviewBytes), operation: LATEST_DEPOSIT_OPERATION, version: VERSION})
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
    const base = {createdAt: new Date().toISOString(), version: VERSION, operation: LATEST_DEPOSIT_OPERATION, target, apply, sourceHash,
      snapshotSha256, reviewSha256: sha256(reviewBytes), dateEvidence, attestation}
    const result = await prisma.$transaction(async client => {
      if (!apply) await client.$queryRawUnsafe('SET TRANSACTION READ ONLY')
      await client.$queryRawUnsafe("SET LOCAL TIME ZONE 'UTC'")
      await client.$queryRawUnsafe("SET LOCAL statement_timeout='30s'")
      await client.$queryRawUnsafe("SET LOCAL lock_timeout='3s'")
      const result = await reconcileLatestDeposits(client, {review, snapshot, apply, previousReport: expected, helpers,
        validatePlan: plan => {
          if (apply && target === 'testing') {
            assertHistorySimulation(expected, {...base, planHash: plan.planHash})
            if (!plan.alreadyApplied) assertLatestDepositBackup(evidence, snapshot, {sourceHash, planHash: plan.planHash, snapshotSha256})
          }
        }})
      if (apply) await persist({...base, ...result, complete: false, phase: 'PREPARED'})
      return result
    }, nativeOverlapTransactionOptions(apply))
    const report = {...base, ...result, complete: true, phase: apply ? 'COMMITTED' : 'SIMULATED'}
    await persist(report)
    console.log(JSON.stringify({operation: LATEST_DEPOSIT_OPERATION, target, apply, complete: true,
      publications: result.publications.length, replacements: result.archives.length, alreadyApplied: result.alreadyApplied}))
    return report
  } finally {restoreGlobals?.(); await output?.close(); await close()}
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const {values} = parseArgs({options: {...HISTORY_TARGET_OPTIONS, review: {type: 'string'}, snapshot: {type: 'string'},
    'target-env': {type: 'string'}, report: {type: 'string'}, apply: {type: 'boolean', default: false}}})
  resolveLatestDeposits({reviewFile: values.review, snapshotFile: values.snapshot, targetEnv: values['target-env'], reportFile: values.report,
    apply: values.apply, ...historyTargetArguments(values)})
    .catch(error => {console.error(JSON.stringify({operation: LATEST_DEPOSIT_OPERATION, error: error.name, code: error.code ?? null, message: error.message})); process.exitCode = 1})
}
