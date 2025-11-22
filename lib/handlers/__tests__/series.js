import test from 'ava'
import {ObjectId} from 'mongodb'
import {setupTestMongo} from '../../util/test-helpers/mongo.js'
import {insertSeriesWithValues} from '../../models/series.js'
import {buildSeriesListForAttachment, buildSeriesValuesPayload} from '../series.js'

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
    unit: 'm³',
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

setupTestMongo(test)

test('buildSeriesListForAttachment returns series with pointPrelevement', async t => {
  const attachmentId = 'att-xyz'
  const territoire = 'TEST-TERR'
  const pointId = new ObjectId()
  const dossierId = new ObjectId()
  const {insertedSeriesIds} = await insertSeriesWithValues({
    attachmentId,
    dossierId,
    territoire,
    series: [buildDailySeries({pointPrelevement: pointId})]
  })
  t.is(insertedSeriesIds.length, 1)

  const list = await buildSeriesListForAttachment({_id: attachmentId}, territoire)
  t.is(list.length, 1)
  t.truthy(list[0].pointPrelevement)
  t.is(list[0].parameter, 'volume')
  // Série journalière -> hasSubDaily ne doit pas être défini ou false
  t.true(list[0].hasSubDaily === undefined || list[0].hasSubDaily === false)
})

test('buildSeriesValuesPayload daily filtering', async t => {
  const attachmentId = 'att-1'
  const pointId = new ObjectId()
  const dossierId = new ObjectId()
  const {insertedSeriesIds} = await insertSeriesWithValues({
    attachmentId,
    dossierId,
    territoire: 'TEST-TERR',
    series: [buildDailySeries({pointPrelevement: pointId, days: 5})]
  })
  const seriesId = insertedSeriesIds[0]

  const result = await buildSeriesValuesPayload(seriesId.toString(), {startDate: '2025-01-02', endDate: '2025-01-04'})
  t.is(result.values.length, 3)
  t.deepEqual(result.values.map(v => v.date), ['2025-01-02', '2025-01-03', '2025-01-04'])
})

test('buildSeriesValuesPayload hourly returns sub-daily shape', async t => {
  const attachmentId = 'att-2'
  const pointId = new ObjectId()
  const dossierId = new ObjectId()
  const {insertedSeriesIds} = await insertSeriesWithValues({
    attachmentId,
    dossierId,
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
  const dossierId = new ObjectId()
  const {insertedSeriesIds} = await insertSeriesWithValues({
    attachmentId,
    dossierId,
    territoire: 'TEST-TERR',
    series: [buildDailySeries({pointPrelevement: pointId, days: 1})]
  })
  const seriesId = insertedSeriesIds[0]

  const error = await t.throwsAsync(() => buildSeriesValuesPayload(seriesId.toString(), {startDate: '2025-13-01'}))
  t.regex(error.message, /invalide/)
})

test('buildSeriesValuesPayload startDate > endDate', async t => {
  const attachmentId = 'att-3'
  const pointId = new ObjectId()
  const dossierId = new ObjectId()
  const {insertedSeriesIds} = await insertSeriesWithValues({
    attachmentId,
    dossierId,
    territoire: 'TEST-TERR',
    series: [buildDailySeries({pointPrelevement: pointId, days: 2})]
  })
  const seriesId = insertedSeriesIds[0]
  const error = await t.throwsAsync(() => buildSeriesValuesPayload(seriesId.toString(), {startDate: '2025-01-02', endDate: '2025-01-01'}))
  t.regex(error.message, /startDate doit être/)
})

test('insertSeriesWithValues sans territoire -> erreur', async t => {
  await t.throwsAsync(() => insertSeriesWithValues({
    attachmentId: 'att-err',
    dossierId: new ObjectId(),
    series: [buildDailySeries({pointPrelevement: new ObjectId(), days: 1})]
  }), {message: /territoire est obligatoire/})
})
