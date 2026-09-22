/* eslint-disable no-await-in-loop -- Bounded synthetic fixtures on the guarded disposable database only. */
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import test from 'ava'
import ExcelJS from 'exceljs'
import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {createQuickDeclarationHandler, previewQuickDeclarationConflictsHandler, getQuickDeclarationContextHandler, getAvailablePointsPrelevementsForDeclaration, getDeclarationDetailHandler} from '../../handlers/declarations.js'
import {listSeries} from '../../models/series.js'
import {getAggregatedValuesFromSql} from '../../handlers/series-aggregation.js'
import {listAggregationOptionGroups, buildAggregationOptionsPayload} from '../../handlers/series-aggregation-options.js'
import {queryExportRows, normalizeExportFilters, rowToExportObject, buildXlsxBuffer} from '../data-exports.js'
import {ingestDeclarationSeries} from '../../declaration-importer/importer.js'
import {updateChunkInstructionHandler} from '../../handlers/chunks.js'

const integration = process.env.METER_INTEGRATION_TESTS === '1' ? test.serial : test.skip
test.before(() => { if (process.env.METER_INTEGRATION_TESTS === '1') requireDisposableDatabase() })
test.after.always(async () => { await prisma.$disconnect(); await globalThis.pgPool?.end() })

async function fixture(codes = ['001', '002']) {
  const key = randomUUID()
  const owner = await prisma.user.create({data: {role: 'DECLARANT', declarant: {create: {preleveurType: 'IRRIGANT', quickDeclarationEnabled: true}}}, include: {declarant: true}})
  const point = await prisma.pointPrelevement.create({data: {name: `Comptages synthétiques ${key}`, waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT', collectionMode: 'MANUAL'}})
  const usage = await prisma.sandreWaterUse.findFirst({where: {kind: 'USAGE'}})
  const exploitations = []
  for (const countingCode of codes) exploitations.push(await prisma.declarantPointPrelevement.create({data: {
    declarantUserId: owner.id, pointPrelevementId: point.id, countingCode, usageId: usage.id, status: 'EN_ACTIVITE'
  }}))
  const zoneId = randomUUID()
  await prisma.$executeRaw`INSERT INTO "Zone" (id,code,type,name,coordinates,"createdAt","updatedAt")
    VALUES (${zoneId}::uuid, ${key}, 'SAGE', 'Zone de test comptage', ST_Multi(ST_GeomFromText('POLYGON((0 0,0 1,1 1,1 0,0 0))',4326)), now(),now())`
  await prisma.pointPrelevementZone.create({data: {pointPrelevementId: point.id, zoneId}})
  return {owner, point, usage, exploitations, zoneId}
}

async function invoke(handler, user, body, query = {}, params = {}) {
  let payload
  let status = 200
  let caught
  const response = {
    status(value) {status = value; return response},
    json(value) {payload = value; return response},
    send(value) {payload = value; return response}
  }
  await handler({user, body, query, params}, response, error => {caught = error})
  if (caught) throw caught
  return {status, payload}
}

function entry(f, index, value, explicit = true) {
  return {pointPrelevementId: f.point.id, usageId: f.usage.id, value,
    ...(explicit ? {exploitationId: f.exploitations[index].id} : {})}
}

async function quick(f, body) {
  return invoke(createQuickDeclarationHandler, f.owner, body)
}

integration('le détail expose les codes sans document et le rapprochement retrouve une exploitation historique', async t => {
  const f = await fixture()
  await quick(f, {readingDate: '2026-01-01', entries: [entry(f, 0, 100), entry(f, 1, 1000)]})
  const declaration = await prisma.declaration.findFirst({where: {declarantUserId: f.owner.id}, orderBy: {createdAt: 'desc'}})
  const {payload} = await invoke(getDeclarationDetailHandler, f.owner, {}, {}, {declarationId: declaration.id})
  t.deepEqual(payload.data.source.chunks.map(chunk => chunk.countingCode).sort(), ['001', '002'])
  await prisma.declarantPointPrelevement.update({where: {id: f.exploitations[0].id}, data: {endDate: new Date('2026-01-02Z')}})
  const points = await getAvailablePointsPrelevementsForDeclaration({declarationId: declaration.id, declarantUserId: f.owner.id})
  const candidates = points.find(point => point.id === f.point.id).exploitations
  t.is(candidates.length, 2)
  t.is(candidates.find(exploitation => exploitation.id === f.exploitations[0].id).endDate.toISOString().slice(0, 10), '2026-01-02')
})

integration('deux comptages au même PP gardent des index et des volumes calculés indépendants', async t => {
  const f = await fixture()
  await quick(f, {readingDate: '2026-01-01', entries: [entry(f, 0, 100), entry(f, 1, 1000)]})
  const created = await quick(f, {readingDate: '2026-01-11', entries: [entry(f, 0, 160), entry(f, 1, 1090)]})
  t.is(created.status, 201)
  const chunks = await prisma.chunk.findMany({where: {pointPrelevementId: f.point.id}, include: {chunkValues: true}})
  const volumes = chunks.flatMap(chunk => chunk.chunkValues.filter(value => value.metricTypeCode === 'volume').map(value => ({exploitationId: chunk.exploitationId, value: Number(value.value)})))
  t.deepEqual(volumes.sort((a, b) => a.value - b.value), [
    {exploitationId: f.exploitations[0].id, value: 60},
    {exploitationId: f.exploitations[1].id, value: 90}
  ])
  const {payload} = await invoke(getQuickDeclarationContextHandler, f.owner)
  const points = payload.data.points.filter(point => point.id === f.point.id || point.pointPrelevementId === f.point.id)
  t.is(points.length, 2)
  t.deepEqual(points.map(point => Number(point.lastReading.value)).sort((a, b) => a - b), [160, 1090])
  t.deepEqual([...new Set(points.map(point => point.countingCode))].sort(), ['001', '002'])
})

integration('aperçu et remplacement des volumes ne touchent pas le comptage voisin', async t => {
  const f = await fixture()
  const period = {measurementType: 'VOLUME', periodStartDate: '2026-02-01', periodEndDate: '2026-02-10'}
  await quick(f, {...period, entries: [entry(f, 0, 10), entry(f, 1, 20)]})
  const preview = await invoke(previewQuickDeclarationConflictsHandler, f.owner, {...period, entries: [entry(f, 0, 12)]})
  t.true(preview.payload.data.hasConflicts)
  t.is(preview.payload.data.conflicts.length, 1)
  await quick(f, {...period, entries: [entry(f, 0, 12)]})
  const values = await prisma.chunkValue.findMany({where: {metricTypeCode: 'volume', chunk: {
    pointPrelevementId: f.point.id, instructionStatus: {not: 'REJECTED'}, source: {status: 'COMPLETED'}
  }}, include: {chunk: true}})
  t.deepEqual(values.map(value => ({exploitationId: value.chunk.exploitationId, value: Number(value.value)})).sort((a, b) => a.value - b.value), [
    {exploitationId: f.exploitations[0].id, value: 12}, {exploitationId: f.exploitations[1].id, value: 20}
  ])
})

integration('un ancien payload reste accepté si unique, mais preview et écriture refusent une ambiguïté', async t => {
  const unique = await fixture([null])
  t.is((await quick(unique, {readingDate: '2026-01-01', entries: [entry(unique, 0, 100, false)]})).status, 201)
  const multiple = await fixture()
  const body = {readingDate: '2026-01-01', entries: [entry(multiple, 0, 100, false)]}
  for (const handler of [createQuickDeclarationHandler, previewQuickDeclarationConflictsHandler]) {
    const error = await t.throwsAsync(invoke(handler, multiple.owner, body))
    t.is(error.statusCode, 409)
  }
  t.is(await prisma.chunk.count({where: {pointPrelevementId: multiple.point.id}}), 0)
  const error = await t.throwsAsync(quick(multiple, {readingDate: '2026-01-01', entries: [{...entry(multiple, 0, 100), countingCode: '002'}]}))
  t.is(error.statusCode, 403)
})

integration('séries, options et exports distinguent les exploitations sans doubler les volumes', async t => {
  const f = await fixture()
  await quick(f, {readingDate: '2026-03-01', entries: [entry(f, 0, 100), entry(f, 1, 1000)]})
  await quick(f, {readingDate: '2026-03-11', entries: [entry(f, 0, 160), entry(f, 1, 1090)]})
  const user = {role: 'ADMIN'}
  const series = await listSeries({pointIds: [f.point.id], exploitationId: f.exploitations[0].id, parameter: 'volume', user})
  t.true(series.length > 0)
  t.true(series.every(item => item.exploitationId === f.exploitations[0].id && item.countingCode === '001'))
  const values = await getAggregatedValuesFromSql({chunkIds: series.map(item => item.computed.chunkId), metricTypeCode: 'volume',
    aggregationFrequency: '1 month', spatialOperator: 'sum', temporalOperator: 'sum', startDate: new Date('2026-03-01'), endDate: new Date('2026-03-31')})
  t.is(values.reduce((sum, value) => sum + Number(value.value), 0), 60)
  const grouped = await listAggregationOptionGroups({pointIds: [f.point.id], user})
  const resolvedPoints = [{id: f.point.id, point: f.point}]
  const options = buildAggregationOptionsPayload({groupedBySeries: grouped, resolvedPoints, includeExploitationIndexes: true})
  const indexOptions = options.parameters.filter(option => option.name === 'index')
  t.is(indexOptions.length, 2)
  t.deepEqual(indexOptions.map(option => option.exploitationId).sort(), f.exploitations.map(exploitation => exploitation.id).sort())
  t.is(options.parameters.filter(option => option.name === 'volume').length, 1)
  t.is(buildAggregationOptionsPayload({groupedBySeries: grouped, resolvedPoints}).parameters.filter(option => option.name === 'index').length, 1)
  const filters = normalizeExportFilters({startDate: '2026-03-01', endDate: '2026-03-31', zoneIds: [f.zoneId]})
  const rows = await queryExportRows({user, filters, allowedZoneIds: [f.zoneId]})
  t.is(rows.length, 6)
  const volumeRows = rows.filter(row => row.metricTypeCode === 'volume')
  t.is(volumeRows.length, 2)
  t.is(volumeRows.reduce((sum, row) => sum + Number(row.value), 0), 150)
  t.deepEqual([...new Set(rows.map(row => row.countingCode))].sort(), ['001', '002'])
  const objects = rows.map(rowToExportObject)
  t.deepEqual([...new Set(objects.map(row => row.countingCode))].sort(), ['001', '002'])
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(await buildXlsxBuffer(rows))
  const header = workbook.worksheets[0].getRow(1).values
  t.true(header.includes('Code comptage'))
  t.true(header.includes('ID de l’exploitation'))
})

integration('un fichier à deux codes conserve séparément les lignes ambiguës et se rejoue sans doublon', async t => {
  const f = await fixture()
  const declaration = await prisma.declaration.create({data: {
    code: randomUUID().slice(0, 6).toUpperCase(), type: 'template-file', declarantUserId: f.owner.id,
    createdByDeclarantUserId: f.owner.id, dataSourceType: 'MANUAL', waterWithdrawalType: 'unknown'
  }})
  const series = [
    {countingCode: '001', amount: 10}, {countingCode: '002', amount: 20}, {amount: 30}
  ].map(({countingCode, amount}) => ({
    pointPrelevement: f.point.name, countingCode, parameter: 'volume', unit: 'm³', frequency: '1 day',
    minDate: '2026-04-01', maxDate: '2026-04-01', usageId: f.usage.id,
    data: [{date: '2026-04-01', periodStart: '2026-04-01T00:00:00Z', periodEnd: '2026-04-02T00:00:00Z', value: amount}]
  }))
  const logger = {log() {}, warn() {}, error() {}}
  for (let replay = 0; replay < 2; replay++) {
    const result = await ingestDeclarationSeries({declarationId: declaration.id, data: {conflictPolicy: 'REPLACE_EXISTING', series}, logger})
    t.true(result.imported)
    const chunks = await prisma.chunk.findMany({where: {sourceId: result.sourceId}, include: {chunkValues: true}})
    t.is(chunks.length, 3)
    const matched = chunks.filter(chunk => chunk.exploitationId)
    t.deepEqual(matched.map(chunk => chunk.exploitationId).sort(), f.exploitations.map(exploitation => exploitation.id).sort())
    const ambiguous = chunks.find(chunk => !chunk.exploitationId)
    t.is(ambiguous.instructionStatus, 'PENDING')
    t.is(ambiguous.pointPrelevementId, null)
    t.is(ambiguous.parsingInfo.reason, 'EXPLOITATION_IDENTITY_UNRESOLVED')
    t.is(Number(ambiguous.chunkValues[0].value), 30)
    t.deepEqual(matched.map(chunk => chunk.metadata.countingCode).sort(), ['001', '002'])
  }
})

integration('l’instruction maintient la cohérence PP-exploitation et ne confond pas deux comptages', async t => {
  const f = await fixture()
  const admin = await prisma.user.create({data: {role: 'ADMIN'}})
  const submitted = await quick(f, {measurementType: 'VOLUME', periodStartDate: '2026-05-01', periodEndDate: '2026-05-02', entries: [entry(f, 0, 10), entry(f, 1, 20)]})
  const originalChunk = submitted.payload.data.source.chunks.find(chunk => chunk.exploitationId === f.exploitations[0].id)
  await prisma.chunk.update({where: {id: originalChunk.id}, data: {instructionStatus: 'PENDING', parsingInfo: {pointAssociationOrigin: 'MANUAL'}}})
  const instruct = body => invoke(updateChunkInstructionHandler, admin, body, {}, {chunkId: originalChunk.id})
  const validated = await instruct({instructionStatus: 'VALIDATED'})
  t.is(validated.status, 200)
  const displayed = validated.payload.data.chunks.find(chunk => chunk.id === originalChunk.id)
  t.is(displayed.exploitation.id, f.exploitations[0].id)
  t.is(displayed.countingCode, '001')

  const target = await prisma.pointPrelevement.create({data: {name: `Cible ${randomUUID()}`, waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT'}})
  const targetExploitation = await prisma.declarantPointPrelevement.create({data: {declarantUserId: f.owner.id, pointPrelevementId: target.id, usageId: f.usage.id, status: 'EN_ACTIVITE'}})
  t.is((await instruct({instructionStatus: 'VALIDATED', pointPrelevementId: target.id})).status, 200)
  const moved = await prisma.chunk.findUnique({where: {id: originalChunk.id}})
  t.is(moved.pointPrelevementId, target.id)
  t.is(moved.exploitationId, targetExploitation.id)
  const ambiguous = await instruct({instructionStatus: 'VALIDATED', pointPrelevementId: f.point.id})
  t.is(ambiguous.status, 409)
  t.is((await prisma.chunk.findUnique({where: {id: originalChunk.id}})).exploitationId, targetExploitation.id)
  t.is((await instruct({instructionStatus: 'VALIDATED', pointPrelevementId: f.point.id, exploitationId: f.exploitations[0].id})).status, 200)

  await prisma.chunk.update({where: {id: originalChunk.id}, data: {parsingInfo: {pointAssociationOrigin: 'AUTOMATIC'}}})
  t.is((await instruct({instructionStatus: 'VALIDATED', exploitationId: f.exploitations[1].id})).status, 409)
  await prisma.chunk.update({where: {id: originalChunk.id}, data: {parsingInfo: {pointAssociationOrigin: 'MANUAL'}}})
  t.is((await instruct({instructionStatus: 'PENDING', pointPrelevementId: null})).status, 200)
  const detached = await prisma.chunk.findUnique({where: {id: originalChunk.id}})
  t.is(detached.pointPrelevementId, null)
  t.is(detached.exploitationId, null)
})
