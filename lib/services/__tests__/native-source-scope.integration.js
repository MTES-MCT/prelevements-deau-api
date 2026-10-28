import process from 'node:process'
import {randomUUID, randomBytes} from 'node:crypto'
import test from 'ava'
import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {getSourceForInstructor, listSourcesForInstructor} from '../instructor-sources.js'

const enabled = process.env.METER_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
test.before(() => { if (enabled) requireDisposableDatabase() })
test.after.always(async () => { await prisma.$disconnect(); await globalThis.pgPool?.end() })

integration('source native partiellement visible : métadonnées, erreurs et totaux restent dans le périmètre agent', async t => {
  const rollback = new Error('ROLLBACK_NATIVE_SOURCE_SCOPE')
  try {
    await prisma.$transaction(async client => {
      const zoneId = randomUUID(), hiddenZoneId = randomUUID()
      await client.$executeRaw`INSERT INTO "Zone" (id,code,type,name,coordinates,"createdAt","updatedAt") VALUES
        (${zoneId}::uuid, ${zoneId}, 'SAGE', 'Zone visible synthétique', ST_Multi(ST_GeomFromText('POLYGON((0 0,0 1,1 1,1 0,0 0))',4326)), now(),now()),
        (${hiddenZoneId}::uuid, ${hiddenZoneId}, 'SAGE', 'Zone masquée synthétique', ST_Multi(ST_GeomFromText('POLYGON((0 0,0 1,1 1,1 0,0 0))',4326)), now(),now())`
      const user = await client.user.create({data: {role: 'DECLARANT', declarant: {create: {preleveurType: 'GESTIONNAIRE_AEP'}}}})
      const usage = await client.sandreWaterUse.findUniqueOrThrow({where: {code: '2'}})
      const visiblePoint = await client.pointPrelevement.create({data: {name: 'Point visible', waterBodyType: 'SOUTERRAIN', flowType: 'PRELEVEMENT', zones: {create: {zoneId}}}})
      const hiddenPoint = await client.pointPrelevement.create({data: {name: 'Point masqué', waterBodyType: 'SOUTERRAIN', flowType: 'PRELEVEMENT', zones: {create: {zoneId: hiddenZoneId}}}})
      await client.$executeRaw`UPDATE "PointPrelevement" SET coordinates = ST_SetSRID(ST_MakePoint(55.5, -21), 4326) WHERE id = ${visiblePoint.id}::uuid`
      await client.$executeRaw`UPDATE "PointPrelevement" SET coordinates = ST_SetSRID(ST_MakePoint(56, -20), 4326) WHERE id = ${hiddenPoint.id}::uuid`
      await client.declarantZone.create({data: {declarantUserId: user.id, zoneId, source: 'MIGRATION'}})
      const declaration = await client.declaration.create({data: {code: randomBytes(3).toString('hex'), type: 'reunion_multi_param', declarantUserId: user.id, waterWithdrawalType: 'unknown'}})
      await client.declarationFile.create({data: {declarationId: declaration.id, type: 'data', filename: 'deux-territoires.xlsx', storageKey: `synthetic/${randomUUID()}/original.xlsx`}})
      const source = await client.source.create({data: {declarationId: declaration.id, type: 'DECLARATION', status: 'COMPLETED',
        metadata: {nativeTemporal: true, provenance: 'DN', totalWaterVolumeWithdrawn: 1000, totalWaterVolumeDischarged: 0,
          nativeBatch: {id: 'synthetic-secret-batch', keys: ['visible', 'hidden']},
          parsingErrors: [{code: 'VISIBLE_ERROR', seriesKey: 'visible', rawValue: '12'}, {code: 'HIDDEN_ERROR', seriesKey: 'hidden', rawValue: '988'}]},
        chunks: {create: [{seriesKey: 'visible', pointPrelevementId: visiblePoint.id, preleveurUserId: user.id, usageId: usage.id, instructionStatus: 'VALIDATED', minDate: new Date('2026-01-01'), maxDate: new Date('2026-01-02'), metadata: {nativeTemporal: true, totalWaterVolumeWithdrawn: 12, totalWaterVolumeDischarged: 0}},
          {seriesKey: 'hidden', pointPrelevementId: hiddenPoint.id, preleveurUserId: user.id, usageId: usage.id, instructionStatus: 'VALIDATED', minDate: new Date('2026-01-01'), maxDate: new Date('2026-01-02'), metadata: {nativeTemporal: true, totalWaterVolumeWithdrawn: 988, totalWaterVolumeDischarged: 0}}]}}})
      const chunks = await client.chunk.findMany({where: {sourceId: source.id}, select: {id: true, seriesKey: true}})
      const visibleChunk = chunks.find(chunk => chunk.seriesKey === 'visible')
      const hiddenChunk = chunks.find(chunk => chunk.seriesKey === 'hidden')
      const value = {metricTypeCode: 'index', unit: 'm³', frequency: 'instant', metadata: {nativeTemporal: true}}
      await client.chunkValue.createMany({data: [
        {...value, chunkId: visibleChunk.id, periodStart: new Date('2026-01-01'), periodEnd: new Date('2026-01-01'), value: '12.123456789'},
        {...value, chunkId: visibleChunk.id, periodStart: new Date('2026-01-02'), periodEnd: new Date('2026-01-02'), value: '13.123456789'},
        {...value, chunkId: hiddenChunk.id, periodStart: new Date('2026-01-01'), periodEnd: new Date('2026-01-01'), value: '988'}
      ]})
      const detail = await getSourceForInstructor(source.id, {readZoneIds: [zoneId], canDownloadFiles: true}, {client})
      t.deepEqual(detail.chunks[0].pointPrelevement.coordinates, {type: 'Point', coordinates: [55.5, -21]})
      t.false(detail.chunks[0].canInstruct)
      t.false(detail.chunks[0].canReconcile)
      const access = await getSourceForInstructor(source.id, {readZoneIds: [zoneId]}, {client, accessOnly: true})
      t.deepEqual(access, {id: source.id, chunks: detail.chunks.map(({id}) => ({id}))})
      const page = await listSourcesForInstructor({zoneIds: [zoneId], provenance: 'DN', view: 'summary'}, {client})
      const listItem = page.items.find(item => item.id === source.id)
      const fullPage = await listSourcesForInstructor({zoneIds: [zoneId], provenance: 'DN'}, {client})
      for (const item of [detail, listItem, fullPage.items.find(item => item.id === source.id)]) {
        t.truthy(item)
        t.is(item.chunks.length, 1)
        t.is(item.chunks[0]._count.chunkValues, 2)
        t.deepEqual(item.chunks[0].chunkValues ?? [], [])
        t.is(item.metadata.totalWaterVolumeWithdrawn, 12)
        t.false(JSON.stringify(item.metadata).includes('HIDDEN_ERROR'))
        t.false(JSON.stringify(item.metadata).includes('988'))
        t.falsy(item.metadata.nativeBatch)
        if (item._count) t.is(item._count.chunks, 1)
        t.deepEqual(item.declaration.files, [])
      }
      throw rollback
    }, {timeout: 30000})
  } catch (error) { if (error !== rollback) throw error }
})
