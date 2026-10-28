import process from 'node:process'
import {randomUUID} from 'node:crypto'
import {stat} from 'node:fs/promises'
import path from 'node:path'
import test from 'ava'
import ExcelJS from 'exceljs'
import {prisma, pgPool} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {normalizeExportFilters, processDataExport, queryExportRows, rowToExportObject} from '../data-exports.js'

const integration = process.env.METER_INTEGRATION_TESTS === '1' ? test.serial : test.skip
const logger = {log() {}}
test.before(() => { if (process.env.METER_INTEGRATION_TESTS === '1') requireDisposableDatabase() })
test.after.always(async () => { await prisma.$disconnect(); await pgPool.end() })

async function withFixture(operation) {
  const ids = Object.fromEntries(['admin', 'owner', 'point', 'usage', 'zone', 'source', 'export'].map(key => [key, randomUUID()]))
  try {
    await prisma.user.create({data: {id: ids.admin, role: 'ADMIN'}})
    await prisma.user.create({data: {id: ids.owner, role: 'DECLARANT', declarant: {create: {preleveurType: 'IRRIGANT'}}}})
    await prisma.sandreWaterUse.create({data: {id: ids.usage, code: ids.usage.slice(0, 8), label: 'Usage synthétique export', kind: 'USAGE'}})
    await prisma.pointPrelevement.create({data: {id: ids.point, name: 'Point synthétique export', flowType: 'PRELEVEMENT', waterBodyType: 'SUPERFICIELLE'}})
    await prisma.$executeRaw`INSERT INTO "Zone" (id,code,type,name,coordinates,"createdAt","updatedAt")
      VALUES (${ids.zone}::uuid, ${ids.zone}, 'SAGE', 'Zone synthétique export',
        ST_Multi(ST_GeomFromText('POLYGON((0 0,0 1,1 1,1 0,0 0))',4326)), CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`
    await prisma.pointPrelevementZone.create({data: {pointPrelevementId: ids.point, zoneId: ids.zone}})
    await prisma.source.create({data: {id: ids.source, type: 'API', status: 'COMPLETED', chunks: {create: {
      pointPrelevementId: ids.point, preleveurUserId: ids.owner, usageId: ids.usage, instructionStatus: 'VALIDATED',
      minDate: new Date('2026-09-27Z'), maxDate: new Date('2026-09-29Z'), metadata: {nativeTemporal: true, valueType: 'cumulative'},
      chunkValues: {create: [0, 1].map(index => ({metricTypeCode: 'volume', frequency: '1 day', unit: 'm³',
        valueKind: 'DECLARED', value: index ? '7.75' : '12.5000000000000001',
        periodStart: new Date(`2026-09-${27 + index}T20:00:00Z`), periodEnd: new Date(`2026-09-${28 + index}T20:00:00Z`)}))}
    }}}})
    await prisma.dataExport.create({data: {id: ids.export, requestedByUserId: ids.admin, requestedByRole: 'ADMIN',
      status: 'PROCESSING', startedAt: new Date('2026-01-01Z'),
      filters: normalizeExportFilters({startDate: '2026-09-28', endDate: '2026-09-29', zoneIds: [ids.zone]})}})
    await operation(ids)
  } finally {
    await prisma.dataExport.deleteMany({where: {id: ids.export}})
    await prisma.source.deleteMany({where: {id: ids.source}})
    await prisma.pointPrelevement.deleteMany({where: {id: ids.point}})
    await prisma.zone.deleteMany({where: {id: ids.zone}})
    await prisma.sandreWaterUse.deleteMany({where: {id: ids.usage}})
    await prisma.user.deleteMany({where: {id: {in: [ids.admin, ids.owner]}}})
  }
}

function storageFixture(upload = async () => {}) {
  const state = {uploads: [], deleted: []}
  const storage = {
    async uploadObject(key, input, options) {
      const chunks = []
      for await (const chunk of input) chunks.push(chunk)
      state.uploads.push({key, options, filename: input.path, bytes: Buffer.concat(chunks),
        mode: (await stat(input.path)).mode & 0o777, directoryMode: (await stat(path.dirname(input.path))).mode & 0o777})
      await upload(state)
    },
    async deleteObject(key) { state.deleted.push(key) }
  }
  return {state, storageClientFactory: () => storage}
}

integration('un export PROCESSING orphelin reprend, garde les valeurs exactes et devient idempotent', async t => {
  await withFixture(async ids => {
    const fixture = storageFixture()
    const result = await processDataExport(ids.export, logger, fixture)
    t.is(result.status, 'COMPLETED')
    t.is(result.rowCount, 2)
    const [upload] = fixture.state.uploads
    t.is(upload.mode, 0o600)
    t.is(upload.directoryMode, 0o700)
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(upload.bytes)
    const sheet = workbook.getWorksheet('Données'), headers = sheet.getRow(1).values
    t.is(sheet.rowCount, 3)
    t.is(sheet.getRow(2).getCell(headers.indexOf('Valeur')).value, '12.5000000000000001')
    t.is(sheet.getRow(3).getCell(headers.indexOf('Valeur')).value, '7.75')
    t.is(sheet.getRow(2).getCell(headers.indexOf('DateHeure de début de période')).value, '2026-09-28 00:00:00.000')
    t.is(sheet.getRow(3).getCell(headers.indexOf('DateHeure de fin de période')).value, '2026-09-30 00:00:00.000')
    await t.throwsAsync(stat(path.dirname(upload.filename)), {code: 'ENOENT'})
    t.is((await processDataExport(ids.export, logger, fixture)).status, 'COMPLETED')
    t.is(fixture.state.uploads.length, 1)
    t.deepEqual(fixture.state.deleted, [])
  })
})

integration('le verrou reste détenu pendant S3 et un second worker ne termine pas le job actif', async t => {
  await withFixture(async ids => {
    let releaseUpload
    const blocked = new Promise(resolve => { releaseUpload = resolve })
    let enteredUpload
    const entered = new Promise(resolve => { enteredUpload = resolve })
    const fixture = storageFixture(async () => { enteredUpload(); await blocked })
    const first = processDataExport(ids.export, logger, fixture)
    try {
      await entered
      const error = await t.throwsAsync(processDataExport(ids.export, logger, fixture))
      t.regex(error.message, /déjà en cours/)
      t.is((await prisma.dataExport.findUniqueOrThrow({where: {id: ids.export}})).status, 'PROCESSING')
    } finally {
      releaseUpload()
      await first
    }
    t.is(fixture.state.uploads.length, 1)
    t.is((await prisma.dataExport.findUniqueOrThrow({where: {id: ids.export}})).status, 'COMPLETED')
  })
})

integration('échec après upload : clé de tentative nettoyée, FAILED puis reprise avec une autre clé', async t => {
  await withFixture(async ids => {
    const fixture = storageFixture()
    let failCompletion = true
    const client = {dataExport: {
      findUnique: args => prisma.dataExport.findUnique(args),
      update: args => prisma.dataExport.update(args),
      updateMany: args => {
        if (args.data.status === 'COMPLETED' && failCompletion) {
          failCompletion = false
          throw new Error('Échec synthétique de publication')
        }
        return prisma.dataExport.updateMany(args)
      }
    }}
    await t.throwsAsync(processDataExport(ids.export, logger, {...fixture, client}), {message: 'Échec synthétique de publication'})
    const failed = await prisma.dataExport.findUniqueOrThrow({where: {id: ids.export}})
    t.is(failed.status, 'FAILED')
    t.deepEqual(fixture.state.deleted, [fixture.state.uploads[0].key])
    await t.throwsAsync(stat(path.dirname(fixture.state.uploads[0].filename)), {code: 'ENOENT'})
    t.is((await processDataExport(ids.export, logger, fixture)).status, 'COMPLETED')
    t.not(fixture.state.uploads[0].key, fixture.state.uploads[1].key)
  })
})

integration('une tentative ayant perdu sa propriété ne publie ni ne nettoie le fichier du successeur', async t => {
  await withFixture(async ids => {
    const successorKey = `exports/${ids.export}/synthetic-successor.xlsx`
    const fixture = storageFixture(async () => {
      await prisma.dataExport.update({where: {id: ids.export}, data: {
        startedAt: new Date('2030-01-01Z'), status: 'COMPLETED', storageKey: successorKey, rowCount: 99
      }})
    })
    const error = await t.throwsAsync(processDataExport(ids.export, logger, fixture))
    t.regex(error.message, /repris par un autre/)
    const row = await prisma.dataExport.findUniqueOrThrow({where: {id: ids.export}})
    t.is(row.status, 'COMPLETED')
    t.is(row.storageKey, successorKey)
    t.is(row.rowCount, 99)
    t.deepEqual(fixture.state.deleted, [fixture.state.uploads[0].key])
    t.false(fixture.state.deleted.includes(successorKey))
  })
})

integration('le curseur traverse plusieurs lots sans perte ni doublon, avec un résumé valide puis invalide', async t => {
  await withFixture(async ids => {
    const chunk = await prisma.chunk.findFirstOrThrow({where: {sourceId: ids.source}})
    await prisma.chunkValue.createMany({data: Array.from({length: 1001}, (_, index) => ({
      chunkId: chunk.id, metricTypeCode: 'volume', unit: 'm³', frequency: 'irregular', valueKind: 'DECLARED',
      value: String(1000 + index), periodStart: new Date('2026-09-28T10:00:00Z'), periodEnd: new Date('2026-09-28T10:01:00Z')
    }))})
    await prisma.$executeRaw`SELECT refresh_chunk_value_summaries(ARRAY[${chunk.id}::uuid])`
    const record = await prisma.dataExport.findUniqueOrThrow({where: {id: ids.export}})
    const options = {user: {role: 'ADMIN'}, filters: normalizeExportFilters(record.filters), allowedZoneIds: [ids.zone]}
    const expected = (await queryExportRows(options)).map(rowToExportObject)
    t.is(expected.length, 1003)
    const fixture = storageFixture()
    t.is((await processDataExport(ids.export, logger, fixture)).rowCount, 1003)
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(fixture.state.uploads[0].bytes)
    const sheet = workbook.getWorksheet('Données'), column = sheet.getRow(1).values.indexOf('Valeur')
    t.deepEqual(Array.from({length: 1003}, (_, index) => sheet.getRow(index + 2).getCell(column).value), expected.map(row => row.valeur))
    // An invalid cache must never suppress values; use the indexed fallback.
    await prisma.chunkValueSummary.update({where: {chunkId: chunk.id}, data: {valid: false, groups: []}})
    t.deepEqual((await queryExportRows(options)).map(rowToExportObject), expected)
  })
})
