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
import {captureNativeOverlapSnapshot, reconcileNativeOverlaps, assertNativeOverlapSnapshot, OVERLAP_OPERATION} from '../recover-native-overlaps.js'

const enabled = process.env.METER_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
const logger = {log() {}, warn() {}, error() {}}
const helpers = {computeGlobalPointMatchingStatus, refreshMostRecentAvailableDateForDeclarantPoints, refreshSourceDeclarantsLastDeclarationAt, refreshChunkValueSummaries}
const json = value => JSON.parse(JSON.stringify(value))
const batch = (index, id = 'native-recovery-replay') => ({index, total: 2, id})
test.before(() => { if (enabled) requireDisposableDatabase() })
test.after.always(async () => { await prisma.$disconnect(); await globalThis.pgPool?.end() })

async function fixture(run) {
  const rollback = new Error('ROLLBACK_NATIVE_OVERLAP_RECOVERY')
  try {
    await prisma.$transaction(async client => {
      const owner = await client.user.create({data: {role: 'DECLARANT', declarant: {create: {preleveurType: 'GESTIONNAIRE_AEP'}}}})
      const usage = await client.sandreWaterUse.findUniqueOrThrow({where: {code: '2'}})
      const reference = String(randomInt(100000, 999999))
      const point = await client.pointPrelevement.create({data: {name: 'Point synthétique', sourceId: `reunion:DEP-974:point:${reference}`,
        identifiers: {REUNION: reference}, waterBodyType: 'SOUTERRAIN', flowType: 'PRELEVEMENT'}})
      await client.declarantPointPrelevement.create({data: {declarantUserId: owner.id, pointPrelevementId: point.id, usageId: usage.id}})
      const createDeclaration = () => client.declaration.create({data: {code: randomBytes(3).toString('hex'), importSourceId: `reunion:test:${randomBytes(6).toString('hex')}`,
        type: 'reunion_multi_param', declarantUserId: owner.id, waterWithdrawalType: 'unknown', dataSourceType: 'SPREADSHEET'}})
      const declaration = await createDeclaration(), baseline = await createDeclaration()
      const series = (key, days) => ({nativeTemporal: true, seriesKey: key, pointPrelevement: point.sourceId,
        parameter: 'volume', unit: 'm³', frequency: '1 day', valueType: 'cumulative', metadata: {timezone: 'Indian/Reunion'},
        data: days.map(day => ({date: new Date(Date.UTC(2026, 0, day, 20)).toISOString(), periodStart: new Date(Date.UTC(2026, 0, day, 20)).toISOString(),
          periodEnd: new Date(Date.UTC(2026, 0, day + 1, 20)).toISOString(), value: String(day * 100), metadata: {row: day + 12}}))})
      const ingest = (items, part, target = declaration) => ingestDeclarationSeries({declarationId: target.id,
        data: {nativeTemporal: true, conflictPolicy: 'SKIP_NEW_CHUNK', series: items, ...(part ? {batch: part} : {})},
        processingMetadata: {provenance: 'DN', historicalAccepted: true}, logger, client})
      const get = () => client.source.findUnique({where: {declarationId: declaration.id}, include: {chunks: {orderBy: {id: 'asc'}, include: {chunkValues: {orderBy: {id: 'asc'}}}}}})
      await ingest([series('baseline', [1])], null, baseline)
      const original = series('original', [1, 2, 3])
      await ingest([original])
      const parent = (await get()).chunks[0]
      const snapshot = await captureNativeOverlapSnapshot(client, {chunkIds: [parent.id]})
      const reconcile = options => reconcileNativeOverlaps(client, {snapshot, helpers, ...options})
      await run({client, declaration, createDeclaration, series, ingest, get, original, parent, snapshot, reconcile})
      throw rollback
    }, {timeout: 60000})
  } catch (error) { if (error !== rollback) throw error }
}

integration('reprise : simulation, copies seules, provenance, résumés et rejeu sans nouvelle écriture', async t => {
  await fixture(async ({client, get, parent, snapshot, reconcile}) => {
    t.is(parent.instructionStatus, 'REJECTED')
    const before = json(await get())
    const preview = await reconcile({})
    t.deepEqual(json(await get()), before)
    t.is(preview.publications.length, 1)
    t.is(preview.publications[0].values.length, 2)
    t.is(preview.decisions[0].excluded[0].reason, 'IDENTICAL_ALREADY_PUBLISHED')
    const result = await reconcile({apply: true, validatePlan: plan => t.is(plan.planHash, preview.planHash)})
    const after = await get(), child = after.chunks.find(row => row.id !== parent.id)
    t.true(result.verified)
    t.deepEqual(json(after.chunks.find(row => row.id === parent.id)), json(parent))
    t.is(child.instructionStatus, 'VALIDATED')
    t.is(after.metadata.totalWaterVolumeWithdrawn, 500)
    t.is(child.metadata.nativeOverlapRecovery.parentChunkId, parent.id)
    t.is(child.metadata.nativeOverlapRecovery.parentContentHash, parent.contentHash)
    t.deepEqual(child.chunkValues.map(value => value.metadata.nativeOverlapRecovery.originalValueId).sort(),
      snapshot.values.filter(value => value.value !== '100').map(value => value.id).sort())
    t.true((await client.chunkValueSummary.findUnique({where: {chunkId: child.id}})).valid)
    const previousReport = {...result, operation: OVERLAP_OPERATION, complete: true}
    const replay = await reconcile({apply: true, previousReport})
    t.true(replay.alreadyApplied)
    t.deepEqual(replay.publications, [])
    t.deepEqual(json(await get()), json(after))
    const simulatedReplay = await reconcile({previousReport})
    t.true((await reconcile({apply: true, previousReport: {...simulatedReplay, operation: OVERLAP_OPERATION, complete: true}})).alreadyApplied)
    const newSnapshot = await captureNativeOverlapSnapshot(client, {chunkIds: snapshot.chunkIds})
    t.deepEqual((await reconcileNativeOverlaps(client, {snapshot: newSnapshot, helpers})).publications, [])
    await client.chunkValue.update({where: {id: child.chunkValues[0].id}, data: {value: '999'}})
    await t.throwsAsync(() => reconcile({previousReport: {...simulatedReplay, operation: OVERLAP_OPERATION, complete: true}}), {message: /Publication dérivée modifiée/})
  })
})

integration('reprise : refuse les changements d’original et les nouveaux conflits depuis la simulation', async t => {
  await fixture(async ({client, parent, snapshot, reconcile, get}) => {
    const preview = await reconcile({})
    const published = await client.chunkValue.findFirstOrThrow({where: {chunk: {pointPrelevementId: parent.pointPrelevementId, instructionStatus: 'VALIDATED'}}})
    const {id: _id, createdAt: _created, updatedAt: _updated, ...existing} = published
    await client.chunkValue.create({data: {...existing, periodStart: new Date('2026-01-02T20:00:00.000Z'), periodEnd: new Date('2026-01-03T20:00:00.000Z')}})
    await t.throwsAsync(() => reconcile({apply: true, validatePlan: plan => {
      if (plan.planHash !== preview.planHash) throw new Error('PLAN_CHANGED')
    }}), {message: 'PLAN_CHANGED'})
    t.is((await get()).chunks.length, 1)
    const refreshed = await reconcile({})
    t.is(refreshed.publications[0].values.length, 1)
    await client.chunk.update({where: {id: parent.id}, data: {instructionComment: 'Decision manuelle'}})
    await t.throwsAsync(() => reconcile({apply: true}), {message: /État courant différent/})
    t.notThrows(() => assertNativeOverlapSnapshot(snapshot))
  })
})

integration('reprise : arbitre seulement les doublons exacts entre dossiers, conserve toutes les contradictions', async t => {
  await fixture(async ({client, snapshot, parent, series, ingest, createDeclaration}) => {
    const peer = series('peer', [1, 2, 3, 4])
    peer.data[2].value = '550'
    const other = await createDeclaration()
    await ingest([peer], null, other)
    const otherChunk = await client.chunk.findFirstOrThrow({where: {source: {declarationId: other.id}}})
    const fullSnapshot = await captureNativeOverlapSnapshot(client, {chunkIds: [...snapshot.chunkIds, otherChunk.id]})
    const plan = await reconcileNativeOverlaps(client, {snapshot: fullSnapshot, helpers})
    t.is(plan.publications.flatMap(row => row.values).length, 2)
    t.deepEqual(plan.publications.flatMap(row => row.values.map(value => value.value)).sort(), ['200', '400'])
    for (const id of [parent.id, otherChunk.id]) {
      t.true(plan.decisions.find(row => row.chunkId === id).excluded.some(row => row.reason === 'CONTRADICTORY_RECOVERY_COHORT'))
    }
  })
})

integration('reprise : rejeu natif inchangé conserve la publication, nouvelle révision la retire avant comparaison', async t => {
  await fixture(async ({reconcile, get, ingest, original, series, parent}) => {
    const repair = await reconcile({apply: true})
    const childId = repair.publications[0].chunk.id
    await ingest([original])
    const replay = await get()
    t.is(replay.chunks.find(row => row.id === childId).instructionStatus, 'VALIDATED')
    t.is(replay.chunks.find(row => row.id === parent.id).instructionStatus, 'REJECTED')
    t.is(replay.metadata.totalWaterVolumeWithdrawn, 500)
    await ingest([series('original', [2, 3, 4])])
    const revised = await get(), child = revised.chunks.find(row => row.id === childId)
    t.is(child.instructionStatus, 'REJECTED')
    t.true(child.metadata.superseded)
    t.is(child.chunkValues.length, 2)
    t.is(revised.chunks.find(row => row.id === parent.id).instructionStatus, 'VALIDATED')
    t.is(revised.metadata.totalWaterVolumeWithdrawn, 900)
  })
})

integration('reprise : retrait de la série d’origine retire sa publication et ses totaux', async t => {
  await fixture(async ({reconcile, get, ingest}) => {
    await reconcile({apply: true})
    await ingest([])
    const removed = await get()
    t.true(removed.chunks.every(row => row.instructionStatus === 'REJECTED' && row.metadata.superseded))
    t.is(removed.metadata.totalWaterVolumeWithdrawn, 0)
    t.is(removed.chunks.reduce((count, row) => count + row.chunkValues.length, 0), 5)
  })
})

integration('reprise : rejeu natif par lots conserve les copies puis retire le parent absent à la finalisation', async t => {
  await fixture(async ({reconcile, get, ingest, original, series}) => {
    const repair = await reconcile({apply: true}), childId = repair.publications[0].chunk.id
    await ingest([original], batch(0))
    await ingest([series('extra', [8])], batch(1))
    t.is((await get()).chunks.find(row => row.id === childId).instructionStatus, 'VALIDATED')
    t.is((await get()).metadata.totalWaterVolumeWithdrawn, 1300)
    await ingest([series('extra', [8])], batch(0, 'native-remove-parent'))
    await ingest([], batch(1, 'native-remove-parent'))
    const removed = await get()
    t.true(removed.chunks.find(row => row.id === childId).metadata.superseded)
    t.is(removed.metadata.totalWaterVolumeWithdrawn, 800)
  })
})
