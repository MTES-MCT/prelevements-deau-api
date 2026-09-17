/* eslint-disable no-await-in-loop -- Synthetic fixtures are bounded and created inside a rollback-only transaction. */
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import test from 'ava'
import ExcelJS from 'exceljs'
import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {
  buildXlsxBuffer, createDataExport, getDataExportDownloadUrl, meterReadingToExportObject,
  normalizeExportFilters, processDataExport, queryExportRows, queryMeterReadingExportRows, rowToExportObject
} from '../data-exports.js'

const integration = process.env.METER_INTEGRATION_TESTS === '1' ? test.serial : test.skip
test.before(() => { if (process.env.METER_INTEGRATION_TESTS === '1') requireDisposableDatabase() })
test.after.always(async () => {
  await prisma.$disconnect()
  await globalThis.pgPool?.end()
})

async function withFixtures(operation) {
  const rollback = new Error('ROLLBACK_EXPORT_FIXTURES')
  try {
    await prisma.$transaction(async client => {
      const fixture = await createFixture(client)
      await operation(client, fixture)
      throw rollback
    }, {timeout: 30000})
  } catch (error) {
    if (error !== rollback) throw error
  }
}

async function createFixture(client) {
  const key = randomUUID()
  const owner = await client.user.create({data: {role: 'DECLARANT', declarant: {create: {preleveurType: 'IRRIGANT'}}}})
  const other = await client.user.create({data: {role: 'DECLARANT', declarant: {create: {preleveurType: 'IRRIGANT'}}}})
  const usages = []
  const points = []
  const zones = []
  for (let index = 0; index < 2; index++) {
    usages.push(await client.sandreWaterUse.create({data: {code: `x${key.slice(0, 8)}${index}`, label: `Usage export ${index}`, kind: 'USAGE'}}))
    points.push(await client.pointPrelevement.create({data: {name: `Export synthetic ${key}-${index}`, flowType: 'PRELEVEMENT',
      waterBodyType: index === 0 ? 'SUPERFICIELLE' : 'SOUTERRAIN'}}))
    const zoneId = randomUUID()
    await client.$executeRaw`INSERT INTO "Zone" (id,code,type,name,coordinates,"createdAt","updatedAt")
      VALUES (${zoneId}::uuid, ${`${key}-${index}`}, 'SAGE', 'Zone export synthétique',
        ST_Multi(ST_GeomFromText('POLYGON((0 0,0 1,1 1,1 0,0 0))',4326)), CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`
    zones.push(zoneId)
    await client.pointPrelevementZone.create({data: {pointPrelevementId: points[index].id, zoneId}})
  }
  const meter = await client.compteur.create({data: {serialNumber: `001-${key}`, identifier: `reference-${key}`}})
  const legacyMeter = await client.compteur.create({data: {serialNumber: `002-${key}`}})
  for (const [pointIndex, user] of [[0, owner], [0, other], [1, owner]]) {
    const exploitation = await client.declarantPointPrelevement.create({data: {
      declarantUserId: user.id, pointPrelevementId: points[pointIndex].id, usageId: usages[pointIndex].id
    }})
    await client.meterAllocation.create({data: {sourceId: randomUUID(), provider: 'synthetic-export', scope: key,
      compteurId: meter.id, exploitationId: exploitation.id}})
  }
  const stream = await client.meterStream.create({data: {provider: 'synthetic-export', scope: key, externalId: key,
    compteurId: meter.id, enabled: false}})
  const ingestion = await client.meterIngestion.create({data: {provider: 'synthetic-export', scope: key, batchId: key,
    mode: 'LIVE', fetchedAt: new Date('2026-03-30T10:00:00Z'), windowStart: new Date('2026-03-28T00:00:00Z'),
    windowEnd: new Date('2026-03-31T00:00:00Z'), payloadHash: key, rawPayload: []}})
  const observations = [
    ['2026-03-28T22:59:59.999Z', '1', true, null],
    ['2026-03-28T23:00:00.000Z', '1234567890123456.1234', true, null],
    ['2026-03-29T00:59:59.999Z', null, false, 'MISSING_INDEX'],
    ['2026-03-29T01:00:00.000Z', '1234567890123456.1235', false, 'EXCLUDED_QUALITY'],
    ['2026-03-29T21:59:59.999Z', '1234567890123456.1236', true, null],
    ['2026-03-29T22:00:00.000Z', '999', true, null]
  ]
  const readings = []
  for (const [observedAt, index, admissible, reason] of observations) {
    const reading = await client.meterReading.create({data: {compteurId: meter.id, observedAt: new Date(observedAt),
      lastFetchedAt: ingestion.fetchedAt, currentMode: 'LIVE'}})
    const revision = await client.meterReadingRevision.create({data: {readingId: reading.id, streamId: stream.id,
      ingestionId: ingestion.id, mode: 'LIVE', index, admissible, reason, quality: admissible ? 'A' : 'Y',
      origin: 'synthetic', payloadHash: randomUUID(), raw: {synthetic: true}}})
    await client.meterReading.update({where: {id: reading.id}, data: {currentRevisionId: revision.id}})
    readings.push(reading)
  }
  const currentRevision = await client.meterReadingRevision.create({data: {readingId: readings[1].id, streamId: stream.id,
    ingestionId: ingestion.id, mode: 'LIVE', index: '1234567890123456.5678', admissible: true,
    quality: 'A', origin: 'synthetic-correction', payloadHash: randomUUID(), raw: {synthetic: true}}})
  await client.meterReading.update({where: {id: readings[1].id}, data: {currentRevisionId: currentRevision.id}})

  for (const [strategy, compteurId, value, sourceStatus, instructionStatus] of [
    ['METER', meter.id, '12.3456', 'COMPLETED', 'AUTOMATICALLY_VALIDATED'],
    ['GENERIC', legacyMeter.id, '7.125', 'COMPLETED', 'VALIDATED'],
    ['GENERIC', null, '9', 'COMPLETED', 'PENDING'],
    ['METER', meter.id, '777', 'FAILED', 'AUTOMATICALLY_VALIDATED'],
    ['METER', meter.id, '888', 'COMPLETED', 'REJECTED']
  ]) {
    await client.source.create({data: {type: 'API', status: sourceStatus, chunks: {create: {
      calculationStrategy: strategy, compteurId, pointPrelevementId: points[0].id, preleveurUserId: owner.id,
      usageId: usages[0].id, flowType: 'PRELEVEMENT', instructionStatus,
      minDate: new Date('2026-03-29Z'), maxDate: new Date('2026-03-29Z'), chunkValues: {create: {
        metricTypeCode: 'volume', frequency: strategy === 'METER' ? 'irregular' : '1 day', unit: 'm³',
        valueKind: strategy === 'METER' ? 'COMPUTED' : 'DECLARED', value,
        periodStart: new Date('2026-03-29T00:00:00Z'), periodEnd: new Date('2026-03-29T12:00:00Z')
      }}
    }}}})
  }
  return {owner, meter, legacyMeter, readings, points, usages, zones,
    filters: normalizeExportFilters({startDate: '2026-03-29', endDate: '2026-03-29', includeMeterReadings: true, zoneIds: [zones[0]]})}
}

integration('les index exportés sont canoniques et dédupliqués, avec seulement les PP du périmètre demandé', async t => {
  await withFixtures(async (client, f) => {
    const user = {role: 'ADMIN'}
    const selected = await queryMeterReadingExportRows({user, filters: f.filters, allowedZoneIds: f.zones, client})
    t.is(selected.length, 4)
    t.is(new Set(selected.map(row => row.readingId)).size, 4)
    t.true(selected.every(row => row.meterId === f.meter.id && row.pointIds === f.points[0].id && row.pointNames === f.points[0].name))
    t.is(selected[0].index, '1234567890123456.5678')
    t.false(selected.some(row => row.index === '1234567890123456.1234'))
    t.deepEqual(selected.map(row => row.observedAt.toISOString()), f.readings.slice(1, 5).map(row => row.observedAt.toISOString()))
    t.deepEqual(selected.map(row => row.localDateTime), [
      '2026-03-29 00:00:00.000', '2026-03-29 01:59:59.999', '2026-03-29 03:00:00.000', '2026-03-29 23:59:59.999'
    ])
    const both = await queryMeterReadingExportRows({user, filters: {...f.filters, zoneIds: f.zones}, allowedZoneIds: f.zones, client})
    t.is(both.length, 4)
    t.deepEqual(both[0].pointIds.split('; ').sort(), f.points.map(point => point.id).sort())
    const usage = await queryMeterReadingExportRows({user, filters: {...f.filters, zoneIds: f.zones, usageIds: [f.usages[1].id]}, allowedZoneIds: f.zones, client})
    t.true(usage.every(row => row.pointIds === f.points[1].id))
    t.is(usage.length, 4)
    const groundwater = await queryMeterReadingExportRows({user, filters: {...f.filters, zoneIds: f.zones, waterBodyTypes: ['SOUTERRAIN']}, allowedZoneIds: f.zones, client})
    t.is(groundwater.length, 4)
    t.true(groundwater.every(row => row.pointIds === f.points[1].id))
    t.deepEqual(await queryMeterReadingExportRows({user, filters: {...f.filters, zoneIds: [randomUUID()]}, allowedZoneIds: [], client}), [])
    t.is((await t.throwsAsync(queryMeterReadingExportRows({user: {role: 'INSTRUCTOR'}, filters: f.filters, allowedZoneIds: f.zones, client}))).status, 403)
  })
})

integration('les volumes exportés préservent METER et legacy, identités des compteurs et périmètres territoriaux', async t => {
  await withFixtures(async (client, f) => {
    const rows = await queryExportRows({user: {role: 'INSTRUCTOR'}, filters: f.filters, allowedZoneIds: [f.zones[0]], client})
    t.is(rows.length, 3)
    const metered = rows.find(row => row.calculationStrategy === 'METER')
    t.is(metered.value.toString(), '12.3456')
    t.is(metered.compteurId, f.meter.id)
    t.is(metered.serialNumber, f.meter.serialNumber)
    t.is(metered.identifier, f.meter.identifier)
    t.is(metered.preleveurId, f.owner.id)
    t.is(metered.valueKind, 'COMPUTED')
    t.is(rows.find(row => row.compteurId === f.legacyMeter.id).value.toString(), '7.125')
    t.is(rows.find(row => row.compteurId === null).value.toString(), '9')
    t.true(rows.every(row => row.pointPrelevementId === f.points[0].id))
    t.deepEqual(await queryExportRows({user: {role: 'INSTRUCTOR'}, filters: {...f.filters, zoneIds: []}, allowedZoneIds: [], client}), [])
    t.deepEqual(await queryExportRows({user: {role: 'ADMIN'}, filters: {...f.filters, zoneIds: [f.zones[1]]}, allowedZoneIds: f.zones, client}), [])
  })
})

integration('les volumes METER respectent le jour Paris de 23 heures sans changer les bornes UTC legacy', async t => {
  await withFixtures(async (client, f) => {
    for (const [strategy, value, start, end] of [
      // Paris 29 March starts at 23Z on the previous day and ends at 22Z.
      ['METER', '101', '2026-03-28T23:00:00Z', '2026-03-28T23:10:00Z'],
      ['METER', '102', '2026-03-29T22:00:00Z', '2026-03-29T22:10:00Z'],
      ['GENERIC', '103', '2026-03-29T22:00:00Z', '2026-03-29T22:10:00Z'],
      ['GENERIC', '104', '2026-03-28T23:00:00Z', '2026-03-28T23:10:00Z'],
      // Intervals are half-open: merely touching the start does not overlap.
      ['METER', '105', '2026-03-28T22:50:00Z', '2026-03-28T23:00:00Z'],
      ['METER', '106', '2026-03-29T21:50:00Z', '2026-03-29T22:00:00Z']
    ]) {
      await client.source.create({data: {type: 'API', status: 'COMPLETED', chunks: {create: {
        calculationStrategy: strategy, compteurId: strategy === 'METER' ? f.meter.id : f.legacyMeter.id,
        pointPrelevementId: f.points[0].id, preleveurUserId: f.owner.id, usageId: f.usages[0].id,
        flowType: 'PRELEVEMENT', instructionStatus: 'AUTOMATICALLY_VALIDATED',
        minDate: new Date(start), maxDate: new Date(end), chunkValues: {create: {
          metricTypeCode: 'volume', frequency: strategy === 'METER' ? 'irregular' : '1 day', unit: 'm³',
          valueKind: strategy === 'METER' ? 'COMPUTED' : 'DECLARED', value,
          periodStart: new Date(start), periodEnd: new Date(end)
        }}
      }}}})
    }
    const rows = await queryExportRows({user: {role: 'ADMIN'}, filters: f.filters, allowedZoneIds: f.zones, client})
    const edges = rows.filter(row => Number(row.value) >= 100)
    t.deepEqual(edges.map(row => row.value.toString()).sort(), ['101', '103', '106'])
    t.is(edges.find(row => row.value.toString() === '101').periodStart.toISOString(), '2026-03-28T23:00:00.000Z')
    t.is(edges.find(row => row.value.toString() === '106').periodEnd.toISOString(), '2026-03-29T22:00:00.000Z')
    t.is(edges.find(row => row.value.toString() === '103').calculationStrategy, 'GENERIC')
    t.like(rowToExportObject(edges.find(row => row.value.toString() === '101')), {
      dateHeureDebutPeriode: '2026-03-29 00:00:00', dateHeureFinPeriode: '2026-03-29 00:10:00'
    })
    t.like(rowToExportObject(edges.find(row => row.value.toString() === '103')), {
      dateHeureDebutPeriode: '2026-03-29 22:00:00'
    })
    t.is(rows.length, 6)
  })
})

integration('le XLSX issu du SQL conserve les décimales exactes et les index exclus dans un onglet séparé', async t => {
  await withFixtures(async (client, f) => {
    const query = {user: {role: 'ADMIN'}, filters: f.filters, allowedZoneIds: f.zones, client}
    const volumes = (await queryExportRows(query)).map(rowToExportObject)
    const readings = (await queryMeterReadingExportRows(query)).map(meterReadingToExportObject)
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(await buildXlsxBuffer(volumes, {meterRows: readings}))
    t.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['Données', 'Index des compteurs'])
    const dataSheet = workbook.getWorksheet('Données')
    const meterSheet = workbook.getWorksheet('Index des compteurs')
    t.is(dataSheet.rowCount, 4)
    t.is(meterSheet.rowCount, 5)
    t.is(meterSheet.getRow(2).getCell(9).value, '1234567890123456.5678')
    t.is(meterSheet.getRow(2).getCell(9).type, ExcelJS.ValueType.String)
    t.is(meterSheet.getRow(2).getCell(3).value, f.meter.serialNumber)
    t.is(meterSheet.getRow(2).getCell(5).value, f.points[0].id)
    t.is(meterSheet.getRow(3).getCell(10).value, 'Exclu')
    t.is(meterSheet.getRow(3).getCell(13).value, 'MISSING_INDEX')
    t.is(meterSheet.getRow(4).getCell(9).value, '1234567890123456.1235')
    t.is(meterSheet.getRow(4).getCell(10).value, 'Exclu')
    t.is(meterSheet.getRow(4).getCell(13).value, 'EXCLUDED_QUALITY')
    t.true(volumes.some(row => row.origineDonnee === 'Calculée à partir des index du compteur' && row.valeur === 12.3456))
    t.true(volumes.some(row => row.origineDonnee === 'Donnée brute' && row.valeur === 9))
  })
})

integration('un compte nonADMIN ne peut créer, traiter ni télécharger un export d’index physiques', async t => {
  const userId = randomUUID()
  const exportId = randomUUID()
  const filters = normalizeExportFilters({startDate: '2026-03-29', endDate: '2026-03-29', includeMeterReadings: true})
  try {
    // This fixture alone must be committed because lifecycle services use their
    // global Prisma client. Exact IDs are cleaned in finally, even on assertion failure.
    await prisma.user.create({data: {id: userId, role: 'ADMIN', email: null}})
    await prisma.dataExport.create({data: {id: exportId, requestedByUserId: userId, requestedByRole: 'ADMIN', filters}})
    const user = await prisma.user.update({where: {id: userId}, data: {role: 'INSTRUCTOR'}})
    const before = await prisma.dataExport.count({where: {requestedByUserId: userId}})
    t.is((await t.throwsAsync(createDataExport({user, filters}))).status, 403)
    t.is(await prisma.dataExport.count({where: {requestedByUserId: userId}}), before)
    t.is((await t.throwsAsync(processDataExport(exportId, {log() {}}))).status, 403)
    const failed = await prisma.dataExport.findUniqueOrThrow({where: {id: exportId}})
    t.is(failed.status, 'FAILED')
    t.is(failed.storageKey, null)
    t.regex(failed.errorMessage, /administrateurs/)
    await prisma.dataExport.update({where: {id: exportId}, data: {status: 'COMPLETED', storageKey: `synthetic-never-uploaded/${exportId}.xlsx`}})
    t.is((await t.throwsAsync(getDataExportDownloadUrl(user, exportId))).status, 403)
    t.is(await getDataExportDownloadUrl({id: randomUUID(), role: 'ADMIN'}, exportId), null)
    const declarant = await prisma.user.update({where: {id: userId}, data: {role: 'DECLARANT'}})
    t.is((await t.throwsAsync(createDataExport({user: declarant, filters}))).status, 403)
    t.is((await t.throwsAsync(getDataExportDownloadUrl(declarant, exportId))).status, 403)
  } finally {
    // Deliberately bypass deleteDataExport: no S3 object exists or may be contacted.
    await prisma.dataExport.deleteMany({where: {id: exportId, requestedByUserId: userId}})
    await prisma.user.deleteMany({where: {id: userId, email: null}})
    t.is(await prisma.dataExport.count({where: {id: exportId}}), 0)
    t.is(await prisma.user.count({where: {id: userId}}), 0)
  }
})
