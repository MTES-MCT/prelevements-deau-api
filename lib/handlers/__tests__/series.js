import test from 'ava'
import {MongoMemoryServer} from 'mongodb-memory-server'
import mongo, {ObjectId} from '../../util/mongo.js'
import {insertSeriesWithValues} from '../../models/series.js'
import {buildSeriesListForAttachment, buildSeriesValuesPayload} from '../series.js'

let memoryServer

function buildDailySeries({pointPrelevement, days = 3}) {
  const today = new Date('2025-01-01')
  const data = []
  for (let i = 0; i < days; i++) {
    const d = new Date(today.getTime() + (i * 86_400_000))
    const date = d.toISOString().slice(0, 10)
    data.push({date, value: i + 1})
  }

  return {
    pointPrelevement,
    parameter: 'volume',
    unit: 'm3',
    frequency: '1 day',
    valueType: 'number',
    minDate: data[0].date,
    maxDate: data.at(-1).date,
    data
  }
}

function buildHourlySeries({pointPrelevement, hours = 6}) {
  const baseDate = '2025-02-01'
  const data = []
  for (let h = 0; h < hours; h++) {
    const time = String(h).padStart(2, '0') + ':00:00'
    data.push({date: baseDate, time, value: h})
  }

  return {
    pointPrelevement,
    parameter: 'temperature',
    unit: 'C',
    frequency: '1 hour',
    valueType: 'number',
    minDate: baseDate,
    maxDate: baseDate,
    data
  }
}

test.before(async () => {
  memoryServer = await MongoMemoryServer.create()
  const uri = memoryServer.getUri()
  await mongo.connect(uri)
})

test.after.always(async () => {
  await mongo.disconnect()
  if (memoryServer) {
    await memoryServer.stop()
  }
})

test('buildSeriesListForAttachment returns series with pointPrelevement', async t => {
  const attachmentId = 'att-xyz'
  const pointId = new ObjectId()
  const {insertedSeriesIds} = await insertSeriesWithValues({
    attachmentId,
    demarcheNumber: 1,
    dossierNumber: 10,
    territoire: 'TEST-TERR',
    series: [buildDailySeries({pointPrelevement: pointId})]
  })
  t.is(insertedSeriesIds.length, 1)

  const list = await buildSeriesListForAttachment({_id: attachmentId})
  t.is(list.length, 1)
  t.truthy(list[0].pointPrelevement)
  t.is(list[0].parameter, 'volume')
})

test('buildSeriesValuesPayload daily filtering', async t => {
  const attachmentId = 'att-1'
  const pointId = new ObjectId()
  const {insertedSeriesIds} = await insertSeriesWithValues({
    attachmentId,
    demarcheNumber: 1,
    dossierNumber: 11,
    territoire: 'TEST-TERR',
    series: [buildDailySeries({pointPrelevement: pointId, days: 5})]
  })
  const seriesId = insertedSeriesIds[0]

  const result = await buildSeriesValuesPayload(seriesId.toString(), {start: '2025-01-02', end: '2025-01-04'})
  t.is(result.values.length, 3)
  t.deepEqual(result.values.map(v => v.date), ['2025-01-02', '2025-01-03', '2025-01-04'])
})

test('buildSeriesValuesPayload hourly returns sub-daily shape', async t => {
  const attachmentId = 'att-2'
  const pointId = new ObjectId()
  const {insertedSeriesIds} = await insertSeriesWithValues({
    attachmentId,
    demarcheNumber: 1,
    dossierNumber: 12,
    territoire: 'TEST-TERR',
    series: [buildHourlySeries({pointPrelevement: pointId, hours: 3})]
  })
  const seriesId = insertedSeriesIds[0]

  const result = await buildSeriesValuesPayload(seriesId.toString(), {})
  t.is(result.values.length, 1) // Une seule date
  t.is(result.values[0].values.length, 3)
  t.truthy(result.series.hasSubDaily)
})

test('buildSeriesValuesPayload invalid date returns error', async t => {
  // Crée d'abord une série valide pour tester validation de date
  const attachmentId = 'att-invalid-date'
  const pointId = new ObjectId()
  const {insertedSeriesIds} = await insertSeriesWithValues({
    attachmentId,
    demarcheNumber: 1,
    dossierNumber: 14,
    territoire: 'TEST-TERR',
    series: [buildDailySeries({pointPrelevement: pointId, days: 1})]
  })
  const seriesId = insertedSeriesIds[0]

  const error = await t.throwsAsync(() => buildSeriesValuesPayload(seriesId.toString(), {start: '2025-13-01'}))
  t.regex(error.message, /invalide/)
})

test('buildSeriesValuesPayload start > end', async t => {
  const attachmentId = 'att-3'
  const pointId = new ObjectId()
  const {insertedSeriesIds} = await insertSeriesWithValues({
    attachmentId,
    demarcheNumber: 1,
    dossierNumber: 13,
    territoire: 'TEST-TERR',
    series: [buildDailySeries({pointPrelevement: pointId, days: 2})]
  })
  const seriesId = insertedSeriesIds[0]
  const error = await t.throwsAsync(() => buildSeriesValuesPayload(seriesId.toString(), {start: '2025-01-02', end: '2025-01-01'}))
  t.regex(error.message, /start doit être/)
})

test('insertSeriesWithValues sans territoire -> erreur', async t => {
  await t.throwsAsync(() => insertSeriesWithValues({
    attachmentId: 'att-err',
    demarcheNumber: 1,
    dossierNumber: 99,
    series: [buildDailySeries({pointPrelevement: new ObjectId(), days: 1})]
  }), {message: /territoire est obligatoire/})
})
