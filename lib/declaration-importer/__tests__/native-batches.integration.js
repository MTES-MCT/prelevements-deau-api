import process from 'node:process'
import {randomUUID, randomBytes} from 'node:crypto'
import test from 'ava'
import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {ingestDeclarationSeries} from '../importer.js'
import {listSeries, getSeriesById, getSeriesValuesInRange} from '../../models/series.js'
import {normalizeExportFilters, queryExportRows} from '../../services/data-exports.js'

const enabled = process.env.METER_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
const logger = {log() {}, warn() {}, error() {}}
test.before(() => { if (enabled) requireDisposableDatabase() })
test.after.always(async () => { await prisma.$disconnect(); await globalThis.pgPool?.end() })

async function fixture(run) {
  const rollback = new Error('ROLLBACK_NATIVE_BATCH_TEST')
  try {
    await prisma.$transaction(async client => {
      const owner = await client.user.create({data: {role: 'DECLARANT', declarant: {create: {preleveurType: 'GESTIONNAIRE_AEP'}}}})
      const usage = await client.sandreWaterUse.findUniqueOrThrow({where: {code: '2'}})
      const point = await client.pointPrelevement.create({data: {name: 'Point synthétique', sourceId: `reunion:batch:${randomUUID()}`, waterBodyType: 'SOUTERRAIN', flowType: 'PRELEVEMENT'}})
      const exploitation = await client.declarantPointPrelevement.create({data: {declarantUserId: owner.id, pointPrelevementId: point.id, usageId: usage.id}})
      const declaration = await client.declaration.create({data: {code: randomBytes(3).toString('hex'), type: 'reunion_multi_param', declarantUserId: owner.id, waterWithdrawalType: 'unknown', dataSourceType: 'SPREADSHEET'}})
      const series = (key, day = 1) => ({nativeTemporal: true, seriesKey: key, pointPrelevement: point.sourceId, parameter: 'volume', unit: 'm³', frequency: '1 day', valueType: 'cumulative',
        metadata: {timezone: 'Indian/Reunion'}, data: [{date: `2026-01-${String(day).padStart(2, '0')}T20:00:00.000Z`, periodStart: `2026-01-${String(day).padStart(2, '0')}T20:00:00.000Z`, periodEnd: `2026-01-${String(day + 1).padStart(2, '0')}T20:00:00.000Z`, value: '12.125', metadata: {row: 13, cell: 'C13'}}]})
      const ingest = async (items, batch, errors = []) => {
        // Production creates one transaction per part. Savepoints model that atomicity
        // while keeping this entire fixture invisible to concurrent test files.
        await client.$executeRaw`SAVEPOINT native_batch_part`
        try {
          const result = await ingestDeclarationSeries({declarationId: declaration.id,
            data: {nativeTemporal: true, conflictPolicy: 'SKIP_NEW_CHUNK', series: items, ...(batch ? {batch} : {})}, errors,
            processingMetadata: {provenance: 'DN', historicalAccepted: true}, logger, client})
          await client.$executeRaw`RELEASE SAVEPOINT native_batch_part`
          return result
        } catch (error) {
          await client.$executeRaw`ROLLBACK TO SAVEPOINT native_batch_part`
          throw error
        }
      }
      const get = () => client.source.findUnique({where: {declarationId: declaration.id}, include: {chunks: {include: {chunkValues: true}}}})
      await run({client, owner, point, exploitation, declaration, series, ingest, get})
      throw rollback
    }, {timeout: 30000})
  } catch (error) { if (error !== rollback) throw error }
}

const batch = (index, total = 2, id = 'test-native-batch-v1') => ({id, index, total})
async function expectStatus(t, action, status) { t.is((await t.throwsAsync(action)).status, status) }

integration('lot natif : aucune publication, date ou volume avant sa dernière partie', async t => {
  await fixture(async ({client, owner, point, exploitation, declaration, series, ingest, get}) => {
    const first = await ingest([series('one')], batch(0), [{code: 'FIRST_WARNING', severity: 'warning'}])
    const pending = await get()
    t.false(first.completed)
    t.is(pending.status, 'PROCESSING')
    t.is(pending.chunks[0].instructionStatus, 'VALIDATED')
    t.is(pending.metadata.totalWaterVolumeWithdrawn, 0)
    t.is(pending.chunks[0].metadata.totalWaterVolume, 0)
    t.is((await client.declaration.findUnique({where: {id: declaration.id}})).processingStatus, 'PROCESSING')
    t.is((await client.declarant.findUnique({where: {userId: owner.id}})).lastDeclarationAt, null)
    t.is((await client.declarantPointPrelevement.findUnique({where: {id: exploitation.id}})).mostRecentAvailableDate, null)
    t.deepEqual(await listSeries({pointIds: [point.id]}, {client}), [])
    const seriesId = `${pending.chunks[0].id}:volume`
    t.is(await getSeriesById(seriesId, client), null)
    t.deepEqual(await getSeriesValuesInRange(seriesId, {}, client), [])
    const exports = () => queryExportRows({user: {role: 'ADMIN'}, filters: normalizeExportFilters({startDate: '2026-01-01', endDate: '2026-01-31'}), allowedZoneIds: [], client})
    t.is((await exports()).filter(row => row.pointPrelevementId === point.id).length, 0)
    const final = await ingest([series('two', 4)], batch(1), [{code: 'SECOND_WARNING', severity: 'warning'}])
    const completed = await get()
    t.true(final.completed)
    t.is(completed.status, 'COMPLETED')
    t.is(completed.chunks.length, 2)
    t.is(completed.metadata.totalWaterVolumeWithdrawn, 24.25)
    t.deepEqual(completed.metadata.parsingErrors.map(error => error.code), ['FIRST_WARNING', 'SECOND_WARNING'])
    t.is((await listSeries({pointIds: [point.id]}, {client})).length, 2)
    t.is((await exports()).filter(row => row.pointPrelevementId === point.id).length, 2)
    t.truthy((await client.declarant.findUnique({where: {userId: owner.id}})).lastDeclarationAt)
  })
})

integration('lot natif : rejeu exact sans doublon et refus des parties modifiées ou reçues dans le désordre', async t => {
  await fixture(async ({series, ingest, get}) => {
    await expectStatus(t, () => ingest([series('two', 4)], batch(1)), 409)
    t.is(await get(), null)
    await ingest([series('one')], batch(0, 3))
    const before = await get()
    const replay = await ingest([series('one')], batch(0, 3))
    t.like(replay, {replayed: true, completed: false})
    t.deepEqual(await get(), before)
    const changed = series('one'); changed.data[0].value = '13'
    await expectStatus(t, () => ingest([changed], batch(0, 3)), 409)
    await expectStatus(t, () => ingest([series('two', 4)], batch(1, 2)), 409)
    await expectStatus(t, () => ingest([series('three', 7)], batch(2, 3)), 409)
    t.deepEqual(await get(), before)
    await ingest([series('two', 4)], batch(1, 3))
    await ingest([], batch(2, 3), [{code: 'ATTACHMENT_ONLY', severity: 'warning'}])
    const completed = await get()
    t.like(await ingest([series('one')], batch(0, 3)), {replayed: true, completed: true})
    t.deepEqual(await get(), completed)
    t.is(completed.metadata.nativeBatch.nextIndex, 3)
    t.is(completed.metadata.nativeBatch.hashes.length, 3)
  })
})

integration('lot natif : un réimport retire les absentes uniquement à la fin et conserve les parties précédentes', async t => {
  await fixture(async ({series, ingest, get}) => {
    await ingest([series('one'), series('two', 4), series('removed', 7)])
    const original = await get()
    await ingest([series('one')], batch(0))
    const pending = await get()
    t.true(pending.chunks.every(chunk => chunk.instructionStatus === 'VALIDATED'))
    t.true(pending.chunks.every(chunk => !chunk.metadata.superseded))
    await ingest([series('two', 4)], batch(1))
    const completed = await get()
    t.deepEqual(completed.chunks.filter(chunk => chunk.instructionStatus === 'VALIDATED').map(chunk => chunk.seriesKey).sort(), ['one', 'two'])
    const removed = completed.chunks.find(chunk => chunk.seriesKey === 'removed')
    t.is(removed.instructionStatus, 'REJECTED')
    t.true(removed.metadata.superseded)
    t.is(removed.chunkValues[0].id, original.chunks.find(chunk => chunk.seriesKey === 'removed').chunkValues[0].id)
    t.is(completed.metadata.totalWaterVolumeWithdrawn, 24.25)
  })
})

integration('lot natif : partie invalide atomique, puis reprise sans perdre la première partie', async t => {
  await fixture(async ({series, ingest, get}) => {
    await ingest([series('one')], batch(0))
    const before = await get()
    await expectStatus(t, () => ingest([series('two', 4), series('one', 7)], batch(1)), 400)
    t.deepEqual(await get(), before)
    await ingest([series('two', 4)], batch(1))
    const completed = await get()
    t.is(completed.status, 'COMPLETED')
    t.is(completed.chunks.length, 2)
    t.is(completed.chunks.find(chunk => chunk.seriesKey === 'one').chunkValues[0].id, before.chunks[0].chunkValues[0].id)
  })
})

integration('lot natif : une panne après le dernier reçu est récupérable sans recréer les valeurs', async t => {
  await fixture(async ({client, declaration, series, ingest, get}) => {
    await ingest([series('one')], batch(0, 1))
    const completed = await get()
    await client.source.update({where: {id: completed.id}, data: {status: 'FAILED'}})
    await client.declaration.update({where: {id: declaration.id}, data: {processingStatus: 'FAILED'}})
    t.like(await ingest([series('one')], batch(0, 1)), {replayed: true, completed: true})
    const recovered = await get()
    t.is(recovered.status, 'COMPLETED')
    t.is(recovered.chunks[0].chunkValues[0].id, completed.chunks[0].chunkValues[0].id)
    t.is((await client.declaration.findUnique({where: {id: declaration.id}})).processingStatus, 'COMPLETED')
  })
})
