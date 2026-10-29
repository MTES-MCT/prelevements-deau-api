import process from 'node:process'
import {randomUUID, randomBytes} from 'node:crypto'
import test from 'ava'
import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {ingestDeclarationSeries} from '../importer.js'

const enabled = process.env.METER_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
const logger = {log() {}, warn() {}, error() {}}
test.before(() => { if (enabled) requireDisposableDatabase() })
test.after.always(async () => { await prisma.$disconnect(); await globalThis.pgPool?.end() })

async function fixture(run) {
  const rollback = new Error('ROLLBACK_NATIVE_REPLAY_REVIEW')
  try {
    await prisma.$transaction(async client => {
      const owner = await client.user.create({data: {role: 'DECLARANT', declarant: {create: {preleveurType: 'GESTIONNAIRE_AEP'}}}})
      const usage = await client.sandreWaterUse.findUniqueOrThrow({where: {code: '2'}})
      const point = await client.pointPrelevement.create({data: {name: 'Point synthétique', sourceId: `reunion:review:${randomUUID()}`, waterBodyType: 'SOUTERRAIN', flowType: 'PRELEVEMENT'}})
      await client.declarantPointPrelevement.create({data: {declarantUserId: owner.id, pointPrelevementId: point.id, usageId: usage.id}})
      const declaration = await client.declaration.create({data: {code: randomBytes(3).toString('hex'), type: 'reunion_multi_param', declarantUserId: owner.id, waterWithdrawalType: 'unknown', dataSourceType: 'SPREADSHEET'}})
      const series = key => ({nativeTemporal: true, seriesKey: key, pointPrelevement: point.sourceId, parameter: 'température', unit: 'degrés Celsius', frequency: 'instant', valueType: 'instantaneous',
        metadata: {timezone: 'Indian/Reunion'}, data: [{date: '2026-01-01T20:00:00.123Z', periodStart: '2026-01-01T20:00:00.123Z', periodEnd: '2026-01-01T20:00:00.123Z', value: '12', metadata: {row: 13, cell: 'C13'}}]})
      const ingest = items => ingestDeclarationSeries({declarationId: declaration.id, data: {nativeTemporal: true, conflictPolicy: 'SKIP_NEW_CHUNK', series: items}, processingMetadata: {provenance: 'DN', historicalAccepted: true}, logger, client})
      const get = () => client.source.findUnique({where: {declarationId: declaration.id}, include: {chunks: {include: {chunkValues: true}}}})
      await run({client, series, ingest, get})
      throw rollback
    }, {timeout: 30000})
  } catch (error) { if (error !== rollback) throw error }
}

integration('deux séries contradictoires du même dossier historique ne sont pas toutes deux publiées', async t => {
  await fixture(async ({series, ingest, get}) => {
    const first = series('first'), second = series('second')
    second.data[0].value = '13'
    await ingest([first, second])
    const source = await get()
    t.is(source.chunks.filter(chunk => chunk.instructionStatus === 'VALIDATED').length, 1)
    t.is(source.chunks.filter(chunk => chunk.instructionStatus === 'REJECTED').length, 1)
    t.true(source.metadata.parsingErrors.some(error => error.code === 'OVERLAPPING_SERIES'))
  })
})

integration('une série inchangée acceptée empêche l’acceptation automatique d’une nouvelle série concurrente', async t => {
  await fixture(async ({series, ingest, get}) => {
    const original = series('first')
    await ingest([original])
    const before = await get()
    const newSeries = series('new')
    await ingest([original, newSeries])
    const after = await get()
    const kept = after.chunks.find(chunk => chunk.seriesKey === 'first')
    t.is(kept.instructionStatus, 'VALIDATED')
    t.is(kept.chunkValues[0].id, before.chunks[0].chunkValues[0].id)
    t.is(after.chunks.find(chunk => chunk.seriesKey === 'new').instructionStatus, 'REJECTED')
  })
})

integration('une série retirée puis réintroduite identique retrouve son rapprochement', async t => {
  await fixture(async ({series, ingest, get}) => {
    const original = series('first')
    await ingest([original])
    const before = await get()
    await ingest([])
    const removed = await get()
    t.is(removed.chunks[0].instructionStatus, 'REJECTED')
    t.true(removed.chunks[0].metadata.superseded)
    await ingest([original])
    const restored = await get()
    t.is(restored.chunks[0].id, before.chunks[0].id)
    t.is(restored.chunks[0].instructionStatus, 'VALIDATED')
    t.falsy(restored.chunks[0].metadata.superseded)
    t.is(restored.chunks[0].chunkValues[0].value.toString(), '12')
  })
})

integration('changer la nature de mesure conserve les révisions et actualise les mesures', async t => {
  await fixture(async ({series, ingest, get}) => {
    const original = series('nature')
    await ingest([original])
    const before = await get()
    await ingest([{...original, valueType: 'mean'}])
    const after = await get()
    t.is(after.chunks[0].id, before.chunks[0].id)
    t.not(after.chunks[0].contentHash, before.chunks[0].contentHash)
    t.is(after.chunks[0].metadata.valueType, 'mean')
    t.is(after.chunks[0].instructionStatus, 'VALIDATED')
    t.is(after.chunks[0].metadata.importHistory.length, 2)
    t.not(after.chunks[0].chunkValues[0].id, before.chunks[0].chunkValues[0].id)
  })
})
