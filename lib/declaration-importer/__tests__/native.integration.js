import process from 'node:process'
import {randomBytes, randomUUID} from 'node:crypto'
import test from 'ava'
import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {ingestDeclarationSeries} from '../importer.js'
import {exactDecimal, normalizeNativeValues, periodsOverlap} from '../native.js'

const enabled = process.env.METER_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
const logger = {log() {}, warn() {}, error() {}}
test.before(() => { if (enabled) requireDisposableDatabase() })
test.after.always(async () => { await prisma.$disconnect(); await globalThis.pgPool?.end() })

async function fixture(run) {
  const owner = await prisma.user.create({data: {role: 'DECLARANT', declarant: {create: {preleveurType: 'IRRIGANT'}}}})
  const admin = await prisma.user.create({data: {role: 'ADMIN'}})
  const usage = await prisma.sandreWaterUse.findUniqueOrThrow({where: {code: '2'}})
  const point = await prisma.pointPrelevement.create({data: {name: `Forage synthétique Réunion ${randomUUID()}`, sourceId: `reunion:fixture:${randomUUID()}`, waterBodyType: 'SOUTERRAIN', flowType: 'PRELEVEMENT'}})
  await prisma.declarantPointPrelevement.create({data: {declarantUserId: owner.id, pointPrelevementId: point.id, usageId: usage.id}})
  const createDeclaration = () => prisma.declaration.create({data: {code: randomBytes(3).toString('hex'), type: 'reunion_multi_param', declarantUserId: owner.id, waterWithdrawalType: 'unknown', dataSourceType: 'SPREADSHEET'}})
  const declaration = await createDeclaration()
  const payload = {nativeTemporal: true, conflictPolicy: 'SKIP_NEW_CHUNK', series: [{nativeTemporal: true, seriesKey: 'file:sheet:column', pointPrelevement: point.sourceId,
    parameter: 'température', unit: '°C', frequency: 'instant', valueType: 'instantaneous', metadata: {timezone: 'Indian/Reunion', detailPointSuivi: 'sortie', profondeur: '2'},
    data: [{date: '2026-01-01T20:00:00.123Z', periodStart: '2026-01-01T20:00:00.123Z', periodEnd: '2026-01-01T20:00:00.123Z', value: '12.12345678901234567890123456789', remark: 'observée', metadata: {row: 13, cell: 'D13'}}]}]}
  const ingest = (data = payload, historicalAccepted = false, declarationId = declaration.id) => ingestDeclarationSeries({declarationId, data, processingMetadata: {provenance: 'DN', historicalAccepted}, logger})
  const get = () => prisma.source.findUnique({where: {declarationId: declaration.id}, include: {chunks: {include: {chunkValues: true}}}})
  try { await run({owner, admin, point, declaration, payload, ingest, get, createDeclaration}) } finally {
    await prisma.chunkValueReplacement.deleteMany({where: {pointPrelevementId: point.id}})
    await prisma.chunk.deleteMany({where: {source: {declaration: {declarantUserId: owner.id}}}})
    await prisma.user.deleteMany({where: {id: {in: [owner.id, admin.id]}}})
    await prisma.pointPrelevement.delete({where: {id: point.id}})
  }
}

test('decimal exact, precision excessive explicite et intervalles ponctuels', t => {
  t.is(exactDecimal('99999999999999999999999.12345678901234567890123456789'), '99999999999999999999999.12345678901234567890123456789')
  t.throws(() => exactDecimal('1.1234567890123456789012345678901'))
  t.throws(() => exactDecimal('100000000000000000000000'))
  t.true(periodsOverlap({periodStart: 0, periodEnd: 0}, {periodStart: 0, periodEnd: 100}))
  t.false(periodsOverlap({periodStart: 100, periodEnd: 100}, {periodStart: 0, periodEnd: 100}))
  const {values, errors} = normalizeNativeValues({seriesKey: 'x', parameter: 'index', unit: 'm³', frequency: 'instant', data: [{periodStart: 'bad', value: '0'}]})
  t.is(values.length, 0); t.is(errors[0].code, 'INVALID_VALUE')
})

integration('précision native, rapprochement existant et rejeu stable sans nouveau circuit', async t => {
  await fixture(async ({ingest, get, payload}) => {
    await ingest()
    const source = await get(), chunk = source.chunks[0]
    t.true(source.metadata.nativeTemporal)
    t.is(chunk.instructionStatus, 'VALIDATED')
    t.is(chunk.minDate.toISOString().slice(0, 10), '2026-01-02')
    t.is(chunk.chunkValues[0].value.toString(), '12.12345678901234567890123456789')
    t.is(chunk.chunkValues[0].periodStart.toISOString(), payload.series[0].data[0].periodStart)
    t.is(chunk.chunkValues[0].remark, 'observée')
    await ingest()
    const replay = await get()
    // The existing totals refresh updates updatedAt; stored measures and revisions stay identical.
    t.deepEqual(replay.chunks.map(({updatedAt, ...stored}) => stored), source.chunks.map(({updatedAt, ...stored}) => stored))
    t.is(replay.globalInstructionStatus, 'VALIDATED')
  })
})

integration('historique conservé et modification rapprochée avec archive de la valeur', async t => {
  await fixture(async ({ingest, get, payload}) => {
    await ingest(payload, true)
    const before = await get()
    t.is(before.chunks[0].instructionStatus, 'VALIDATED')
    payload.series[0].data[0].value = '13.5'
    await ingest(payload, true)
    const after = await get()
    t.is(after.chunks[0].instructionStatus, 'VALIDATED')
    t.is(after.chunks[0].id, before.chunks[0].id)
    t.is(await prisma.chunkValueReplacement.count({where: {replacedChunkId: after.chunks[0].id}}), 1)
  })
})

integration('conflit écarté du double comptage, dimensions différentes conservées', async t => {
  await fixture(async ({ingest, get, payload, createDeclaration}) => {
    await ingest(payload, true)
    const second = await createDeclaration()
    const result = await ingest(payload, true, second.id)
    let chunks = await prisma.chunk.findMany({where: {sourceId: result.sourceId}})
    t.is(chunks[0].instructionStatus, 'REJECTED')
    const other = structuredClone(payload)
    other.series[0].metadata.profondeur = '3'
    await ingest(other, false, second.id)
    chunks = await prisma.chunk.findMany({where: {sourceId: result.sourceId}})
    t.is(chunks[0].instructionStatus, 'VALIDATED')
    t.is((await get()).chunks[0].instructionStatus, 'VALIDATED')
  })
})

integration('données valides conservées malgré une erreur; point non résolu reste à rapprocher', async t => {
  await fixture(async ({ingest, get, payload}) => {
    payload.series[0].pointPrelevement = ''
    payload.series[0].data.push({...payload.series[0].data[0], value: 'illisible'})
    await ingest(payload, true)
    const source = await get()
    t.is(source.chunks[0].chunkValues.length, 1)
    t.is(source.chunks[0].instructionStatus, 'PENDING')
    t.true(source.metadata.hasAnomalies)
    t.true(source.metadata.parsingErrors.some(e => e.code === 'INVALID_VALUE'))
  })
})
