import process from 'node:process'
import {randomBytes, randomInt} from 'node:crypto'
import test from 'ava'
import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../../lib/util/test-helpers/disposable-database.js'
import {ingestDeclarationSeries} from '../../../lib/declaration-importer/importer.js'
import {computeGlobalPointMatchingStatus} from '../../../lib/handlers/chunks.js'
import {refreshMostRecentAvailableDateForDeclarantPoints} from '../../../lib/services/declaration-side-effects.js'
import {refreshSourceDeclarantsLastDeclarationAt} from '../../../lib/models/declarant.js'
import {refreshChunkValueSummaries} from '../../../lib/services/chunk-value-summaries.js'
import {captureNativeOverlapSnapshot, reconcileNativeOverlaps, nativeOverlapTransactionOptions} from '../recover-native-overlaps.js'
import {captureLatestDepositSnapshot, reconcileLatestDeposits, LATEST_DEPOSIT_OPERATION} from '../resolve-latest-deposits.js'

const enabled = process.env.METER_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
const logger = {log() {}, warn() {}, error() {}}
const helpers = {computeGlobalPointMatchingStatus, refreshMostRecentAvailableDateForDeclarantPoints, refreshSourceDeclarantsLastDeclarationAt, refreshChunkValueSummaries}
const json = value => JSON.parse(JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? String(entry) : entry))
test.before(() => {if (enabled) requireDisposableDatabase()})
test.after.always(async () => {await prisma.$disconnect(); await globalThis.pgPool?.end()})

async function fixture(run, {kind = 'volume', extra = true, partial = false, committed = false, withExploitation = true} = {}) {
  const rollback = new Error('ROLLBACK_LATEST_DEPOSIT')
  const created = {}
  const work = async client => {
    const owner = await client.user.create({data: {role: 'DECLARANT', declarant: {create: {preleveurType: 'GESTIONNAIRE_AEP'}}}})
    created.ownerId = owner.id
    const usage = await client.sandreWaterUse.findUniqueOrThrow({where: {code: '2'}})
    const reference = String(randomInt(100000, 999999))
    const point = await client.pointPrelevement.create({data: {name: 'Point synthétique', sourceId: `reunion:DEP-974:point:${reference}`,
      identifiers: {REUNION: reference}, waterBodyType: 'SOUTERRAIN', flowType: 'PRELEVEMENT'}})
    created.pointId = point.id
    if (withExploitation) await client.declarantPointPrelevement.create({data: {declarantUserId: owner.id, pointPrelevementId: point.id, usageId: usage.id}})
    const dossier = String(randomInt(1000000, 9000000))
    const oldDeclaration = await client.declaration.create({data: {code: randomBytes(3).toString('hex'), importSourceId: `reunion:DN:80149:${dossier}`,
      type: 'reunion_multi_param', declarantUserId: owner.id, waterWithdrawalType: 'unknown', dataSourceType: 'SPREADSHEET', createdAt: new Date('2030-01-01')}})
    const newDossier = String(Number(dossier) + 1)
    const declaration = await client.declaration.create({data: {code: randomBytes(3).toString('hex'), importSourceId: `reunion:DN:80149:${newDossier}`,
      type: 'reunion_multi_param', declarantUserId: owner.id, waterWithdrawalType: 'unknown', dataSourceType: 'SPREADSHEET', createdAt: new Date('2020-01-01')}})
    const series = (key, days) => ({nativeTemporal: true, seriesKey: key, pointPrelevement: point.sourceId, parameter: kind, unit: 'm³',
      frequency: kind === 'index' ? 'instant' : '1 day', valueType: kind === 'index' ? 'raw' : 'cumulative', metadata: {timezone: 'Indian/Reunion'},
      data: days.map(([day, amount]) => ({periodStart: new Date(Date.UTC(2026, 0, day, 20)).toISOString(),
        periodEnd: new Date(Date.UTC(2026, 0, day + (kind === 'index' ? 0 : 1), 20)).toISOString(), value: String(amount), metadata: {row: day}}))})
    const oldSeries = series('old', [[1, 10], ...(extra ? [[3, 30]] : [])])
    const newSeries = series('new', [[1, 99], ...(extra ? [[2, 20]] : [])])
    if (partial) {
      oldSeries.data[0].periodStart = '2026-01-01T18:00:00.000Z'
      oldSeries.data[0].periodEnd = '2026-01-02T18:00:00.000Z'
    }
    const ingest = (target, item) => ingestDeclarationSeries({declarationId: target.id,
      data: {nativeTemporal: true, conflictPolicy: 'SKIP_NEW_CHUNK', series: [item]},
      processingMetadata: {provenance: 'DN', historicalAccepted: true}, logger, client})
    await ingest(oldDeclaration, oldSeries)
    await ingest(declaration, newSeries)
    const loser = await client.chunk.findFirstOrThrow({where: {source: {declarationId: oldDeclaration.id}}})
    const winner = await client.chunk.findFirstOrThrow({where: {source: {declarationId: declaration.id}}})
    const winnerValue = await client.chunkValue.findFirstOrThrow({where: {chunkId: winner.id}, orderBy: {periodStart: 'asc'}})
    const loserValue = await client.chunkValue.findFirstOrThrow({where: {chunkId: loser.id}, orderBy: {periodStart: 'asc'}})
    let existingRecovery
    if (extra) {
      const nativeSnapshot = await captureNativeOverlapSnapshot(client, {chunkIds: [winner.id]})
      existingRecovery = (await reconcileNativeOverlaps(client, {snapshot: nativeSnapshot, apply: true, helpers})).publications[0]
    }
    const side = (chunk, value, number, dateDepot) => ({dossier: number, sourceId: chunk.sourceId, chunkId: chunk.id, value: json(value), dateDepot,
      dateEvidence: {chosenDateField: 'dateDepot', dossier: number, dateDepot, provenance: 'DN_RAW_ARCHIVE'}})
    const review = {decisionField: 'dateDepot', pairs: [{case: 'synthetic', pointId: point.id, pointNumber: reference,
      winner: side(winner, winnerValue, newDossier, '2026-02-02T10:00:00Z'), loser: side(loser, loserValue, dossier, '2026-02-01T10:00:00Z')}]}
    const snapshot = await captureLatestDepositSnapshot(client, {review})
    const reconcile = options => reconcileLatestDeposits(client, {review, snapshot, helpers, ...options})
    await run({client, declaration, oldDeclaration, series, newSeries, oldSeries, ingest, snapshot, review, reconcile, winner, loser, winnerValue, loserValue, existingRecovery})
  }
  if (committed) {
    try {await work(prisma)} finally {
      if (created.pointId) await prisma.chunkValueReplacement.deleteMany({where: {pointPrelevementId: created.pointId}})
      if (created.ownerId) await prisma.declaration.deleteMany({where: {declarantUserId: created.ownerId}})
      if (created.pointId) await prisma.pointPrelevement.deleteMany({where: {id: created.pointId}})
      if (created.ownerId) await prisma.user.deleteMany({where: {id: created.ownerId}})
    }
    return
  }
  try {
    await prisma.$transaction(async client => {
      await work(client)
      throw rollback
    }, {timeout: 120000})
  } catch (error) {if (error !== rollback) throw error}
}

integration('arbitrage DN : remplace seulement la paire revue, archive complète, conserve les autres copies et rejoue sans écriture', async t => {
  await fixture(async ({client, snapshot, review, reconcile, winner, loser, winnerValue, loserValue, existingRecovery}) => {
    const preview = await reconcile({})
    t.deepEqual(await captureLatestDepositSnapshot(client, {review}), snapshot)
    t.is(preview.publications.length, 1)
    const result = await reconcile({apply: true, validatePlan: plan => t.is(plan.planHash, preview.planHash)})
    t.true(result.verified)
    t.deepEqual(json(await client.chunkValue.findUniqueOrThrow({where: {id: winnerValue.id}})), json(winnerValue))
    t.is(await client.chunkValue.findUnique({where: {id: loserValue.id}}), null)
    const archive = await client.chunkValueReplacement.findUniqueOrThrow({where: {id: result.archives[0].id}})
    t.deepEqual(archive.metadata.originalValue, json(loserValue))
    t.deepEqual(archive.metadata.originalChunk, json(loser))
    const source = await client.source.findUniqueOrThrow({where: {id: winner.sourceId}})
    t.is(source.metadata.totalWaterVolumeWithdrawn, 119)
    t.is((await client.source.findUniqueOrThrow({where: {id: loser.sourceId}})).metadata.totalWaterVolumeWithdrawn, 30)
    const remaining = await client.chunk.findUniqueOrThrow({where: {id: loser.id}})
    t.is(remaining.minDate.toISOString(), '2026-01-04T00:00:00.000Z')
    t.is(remaining.maxDate.toISOString(), '2026-01-04T00:00:00.000Z')
    t.is(remaining.instructionStatus, 'VALIDATED')
    t.is((await client.chunkValueSummary.findUniqueOrThrow({where: {chunkId: loser.id}})).valueCount, 1n)
    const existingCopy = await client.chunk.findUniqueOrThrow({where: {id: existingRecovery.chunk.id}})
    t.deepEqual(json(existingCopy), snapshot.chunks.find(row => row.id === existingCopy.id))
    t.is((await client.chunkValue.findMany({where: {chunkId: existingCopy.id}})).length, 1)
    const after = await captureLatestDepositSnapshot(client, {review})
    const previousReport = {...result, complete: true, operation: LATEST_DEPOSIT_OPERATION}
    const replay = await reconcile({apply: true, previousReport})
    t.true(replay.alreadyApplied)
    t.deepEqual(await captureLatestDepositSnapshot(client, {review}), after)
    const replayPreview = await reconcile({previousReport})
    t.true((await reconcile({apply: true, previousReport: {...replayPreview, complete: true, operation: LATEST_DEPOSIT_OPERATION}})).alreadyApplied)
  })
})

integration('arbitrage DN : les rejeux natifs du perdant et du gagnant conservent la décision ; une nouvelle révision retire les copies', async t => {
  await fixture(async ({client, reconcile, declaration, oldDeclaration, ingest, newSeries, oldSeries, loserValue, series, winner}) => {
    const result = await reconcile({apply: true})
    await ingest(oldDeclaration, oldSeries)
    t.is(await client.chunkValue.findUnique({where: {id: loserValue.id}}), null)
    t.false((await client.chunkValue.findMany({where: {chunkId: loserValue.chunkId}})).some(row => String(row.value) === '10'))
    await ingest(declaration, newSeries)
    t.is((await client.chunk.findUniqueOrThrow({where: {id: result.publications[0].chunk.id}})).instructionStatus, 'VALIDATED')
    t.is((await client.source.findUniqueOrThrow({where: {id: winner.sourceId}})).metadata.totalWaterVolumeWithdrawn, 119)
    await ingest(declaration, series('new', [[4, 40]]))
    const child = await client.chunk.findUniqueOrThrow({where: {id: result.publications[0].chunk.id}})
    t.is(child.instructionStatus, 'REJECTED')
    t.true(child.metadata.superseded)
    t.is((await client.source.findUniqueOrThrow({where: {id: winner.sourceId}})).metadata.totalWaterVolumeWithdrawn, 40)
  })
})

for (const kind of ['volume', 'index']) integration(`arbitrage DN : série ${kind} vidée rejetée, original archivé, gagnant publié`, async t => {
  await fixture(async ({client, reconcile, loser, winner, loserValue, oldDeclaration, oldSeries, ingest}) => {
    const result = await reconcile({apply: true})
    t.is((await client.chunk.findUniqueOrThrow({where: {id: loser.id}})).instructionStatus, 'REJECTED')
    t.is((await client.source.findUniqueOrThrow({where: {id: loser.sourceId}})).metadata.totalWaterVolumeWithdrawn, 0)
    t.is((await client.chunkValueSummary.findUniqueOrThrow({where: {chunkId: loser.id}})).valueCount, 0n)
    t.is((await client.source.findUniqueOrThrow({where: {id: winner.sourceId}})).metadata.totalWaterVolumeWithdrawn, kind === 'volume' ? 99 : 0)
    t.deepEqual(result.archives[0].metadata.originalValue, json(loserValue))
    await ingest(oldDeclaration, oldSeries)
    t.is((await client.chunkValue.findMany({where: {chunkId: loser.id}})).length, 0)
    t.is((await client.chunk.findUniqueOrThrow({where: {id: loser.id}})).instructionStatus, 'REJECTED')
  }, {kind, extra: false})
})

integration('arbitrage DN : périodes partielles remplacées entières, sans prorata ni découpage', async t => {
  await fixture(async ({reconcile, winnerValue, loserValue}) => {
    const result = await reconcile({apply: true})
    t.is(result.publications[0].values[0].value, '99')
    t.is(result.publications[0].values[0].periodStart.toISOString(), winnerValue.periodStart.toISOString())
    t.is(result.publications[0].values[0].periodEnd.toISOString(), winnerValue.periodEnd.toISOString())
    t.is(result.archives[0].periodStart.toISOString(), loserValue.periodStart.toISOString())
    t.is(result.archives[0].periodEnd.toISOString(), loserValue.periodEnd.toISOString())
  }, {extra: false, partial: true})
})

integration('arbitrage DN : refuse nouvelle valeur, copie dérivée concurrente ou revue différente avant toute mutation', async t => {
  await fixture(async ({client, reconcile, review, snapshot, winnerValue, existingRecovery}) => {
    const changedReview = structuredClone(review)
    changedReview.pairs[0].winner.dateDepot = '2026-02-03T10:00:00Z'
    changedReview.pairs[0].winner.dateEvidence.dateDepot = changedReview.pairs[0].winner.dateDepot
    await t.throwsAsync(() => reconcileLatestDeposits(client, {snapshot, review: changedReview, apply: true, helpers}), {message: /Revue différente/})
    // A new value inside an already existing derived chunk is not in the saved
    // originals. Candidate comparison must still detect it, never replace it.
    const {id: _id, createdAt: _created, updatedAt: _updated, ...fields} = winnerValue
    await client.chunkValue.create({data: {...fields, chunkId: existingRecovery.chunk.id}})
    await t.throwsAsync(() => reconcile({apply: true}), {message: /Chevauchement visible supplémentaire/})
    t.is(await client.chunkValueReplacement.count({where: {replacedChunkValueId: review.pairs[0].loser.value.id}}), 0)
  })
})

integration('arbitrage DN : détecte l’import terminé après le premier verrou et avant le verrou du point', async t => {
  await fixture(async ({client, declaration, series, snapshot, review, reconcile, loserValue, ingest}) => {
    const preview = await reconcile({})
    const other = await client.declaration.create({data: {code: randomBytes(3).toString('hex'), importSourceId: `reunion:DN:80149:${randomInt(10000000, 90000000)}`,
      type: 'reunion_multi_param', declarantUserId: declaration.declarantUserId, waterWithdrawalType: 'unknown', dataSourceType: 'SPREADSHEET', createdAt: new Date('2010-01-01')}})
    const concurrent = series('concurrent', [[1, 5]])
    concurrent.data[0].periodStart = '2026-01-02T19:00:00.000Z'
    concurrent.data[0].periodEnd = '2026-01-02T20:00:00.000Z'
    const error = await t.throwsAsync(() => prisma.$transaction(async recovery => {
      await recovery.$queryRaw`SELECT id FROM "Declaration" WHERE id = ${declaration.id}::uuid FOR UPDATE`
      await ingest(other, concurrent)
      await reconcileLatestDeposits(recovery, {snapshot, review, helpers, apply: true, validatePlan: plan => {
        if (plan.planHash !== preview.planHash) throw new Error('PLAN_CHANGED')
        throw new Error('STALE_PLAN_WOULD_BE_APPLIED')
      }})
    }, nativeOverlapTransactionOptions(true)))
    t.regex(error.message, /Chevauchement visible supplémentaire/)
    t.truthy(await client.chunkValue.findUnique({where: {id: loserValue.id}}))
    t.is(await client.chunkValueReplacement.count({where: {replacedChunkValueId: loserValue.id}}), 0)
  }, {extra: false, partial: true, committed: true, withExploitation: false})
})
