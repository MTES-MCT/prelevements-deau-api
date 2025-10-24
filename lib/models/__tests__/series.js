import test from 'ava'
import {MongoMemoryServer} from 'mongodb-memory-server'
import mongo from '../../util/mongo.js'
import {buildValueObject, insertSeriesWithValues, getSeriesById, getSeriesValues, deleteSeriesByIds} from '../series.js'

let memoryServer

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

test('buildValueObject - valeur simple sans métadonnées', t => {
  const result = buildValueObject({date: '2025-01-01', value: 100})
  t.deepEqual(result, {value: 100})
})

test('buildValueObject - valeur avec remarque', t => {
  const result = buildValueObject({date: '2025-01-01', value: 50, remark: 'Estimation'})
  t.deepEqual(result, {value: 50, remark: 'Estimation'})
})

test('buildValueObject - valeur avec métadonnées d\'expansion complètes', t => {
  const result = buildValueObject({
    date: '2025-01-01',
    value: 100,
    originalValue: 3100,
    originalDate: '2025-01-01',
    originalFrequency: '1 month',
    daysCovered: 31
  })
  t.deepEqual(result, {
    value: 100,
    originalValue: 3100,
    originalDate: '2025-01-01',
    originalFrequency: '1 month',
    daysCovered: 31
  })
})

test('buildValueObject - valeur avec métadonnées d\'expansion et remarque', t => {
  const result = buildValueObject({
    date: '2025-01-15',
    value: 100,
    remark: 'Compteur défectueux',
    originalValue: 9000,
    originalDate: '2025-01-01',
    originalFrequency: '1 quarter',
    daysCovered: 90
  })
  t.deepEqual(result, {
    value: 100,
    remark: 'Compteur défectueux',
    originalValue: 9000,
    originalDate: '2025-01-01',
    originalFrequency: '1 quarter',
    daysCovered: 90
  })
})

test('buildValueObject - valeur 0 est conservée', t => {
  const result = buildValueObject({
    date: '2025-01-01',
    value: 0,
    originalValue: 0,
    daysCovered: 31
  })
  t.deepEqual(result, {
    value: 0,
    originalValue: 0,
    daysCovered: 31
  })
})

test('buildValueObject - ignore les propriétés non définies', t => {
  const result = buildValueObject({
    date: '2025-01-01',
    value: 100,
    originalValue: undefined,
    originalDate: undefined,
    originalFrequency: undefined,
    daysCovered: undefined,
    remark: undefined
  })
  t.deepEqual(result, {value: 100})
})

test('insertSeriesWithValues persiste les métadonnées d\'expansion pour volumes mensuels', async t => {
  const series = [{
    pointPrelevement: 12_345,
    parameter: 'volume prélevé',
    unit: 'm3',
    frequency: '1 day',
    valueType: 'cumulative',
    originalFrequency: '1 month',
    minDate: '2025-01-01',
    maxDate: '2025-01-03',
    data: [
      {
        date: '2025-01-01',
        value: 100,
        originalValue: 3100,
        originalDate: '2025-01-01',
        originalFrequency: '1 month',
        daysCovered: 31
      },
      {
        date: '2025-01-02',
        value: 100,
        originalValue: 3100,
        originalDate: '2025-01-01',
        originalFrequency: '1 month',
        daysCovered: 31
      },
      {
        date: '2025-01-03',
        value: 100,
        originalValue: 3100,
        originalDate: '2025-01-01',
        originalFrequency: '1 month',
        daysCovered: 31
      }
    ],
    hash: 'test-hash-monthly'
  }]

  const {insertedSeriesIds} = await insertSeriesWithValues({
    attachmentId: 'test-attachment-monthly',
    dossierId: 'test-dossier-monthly',
    territoire: 'test-territoire',
    series
  })

  t.is(insertedSeriesIds.length, 1)

  const insertedSeries = await getSeriesById(insertedSeriesIds[0])
  t.is(insertedSeries.frequency, '1 day')
  t.is(insertedSeries.originalFrequency, '1 month')

  const values = await getSeriesValues(insertedSeriesIds[0])
  t.is(values.length, 3)

  // Vérifier que toutes les valeurs ont les métadonnées d'expansion
  for (const v of values) {
    t.is(v.values.value, 100)
    t.is(v.values.originalValue, 3100)
    t.is(v.values.originalDate, '2025-01-01')
    t.is(v.values.originalFrequency, '1 month')
    t.is(v.values.daysCovered, 31)
  }

  // Cleanup
  await deleteSeriesByIds(insertedSeriesIds)
})

test('insertSeriesWithValues ne persiste pas de métadonnées d\'expansion pour valeurs non-expansées', async t => {
  const series = [{
    pointPrelevement: 12_346,
    parameter: 'température',
    unit: '°C',
    frequency: '1 day',
    valueType: 'average',
    minDate: '2025-01-01',
    maxDate: '2025-01-02',
    data: [
      {date: '2025-01-01', value: 15.5},
      {date: '2025-01-02', value: 16.2}
    ],
    hash: 'test-hash-daily'
  }]

  const {insertedSeriesIds} = await insertSeriesWithValues({
    attachmentId: 'test-attachment-daily',
    dossierId: 'test-dossier-daily',
    territoire: 'test-territoire',
    series
  })

  t.is(insertedSeriesIds.length, 1)

  const insertedSeries = await getSeriesById(insertedSeriesIds[0])
  t.is(insertedSeries.frequency, '1 day')
  t.is(insertedSeries.originalFrequency, null)

  const values = await getSeriesValues(insertedSeriesIds[0])
  t.is(values.length, 2)

  // Vérifier qu'aucune métadonnée d'expansion n'est présente
  for (const v of values) {
    t.is(v.values.originalValue, undefined)
    t.is(v.values.originalDate, undefined)
    t.is(v.values.originalFrequency, undefined)
    t.is(v.values.daysCovered, undefined)
  }

  // Cleanup
  await deleteSeriesByIds(insertedSeriesIds)
})

test('insertSeriesWithValues persiste les métadonnées d\'expansion avec remarque', async t => {
  const series = [{
    pointPrelevement: 12_347,
    parameter: 'volume restitué',
    unit: 'm3',
    frequency: '1 day',
    valueType: 'cumulative',
    originalFrequency: '1 quarter',
    minDate: '2025-01-01',
    maxDate: '2025-01-02',
    data: [
      {
        date: '2025-01-01',
        value: 100,
        remark: 'Estimation',
        originalValue: 9000,
        originalDate: '2025-01-01',
        originalFrequency: '1 quarter',
        daysCovered: 90
      },
      {
        date: '2025-01-02',
        value: 100,
        originalValue: 9000,
        originalDate: '2025-01-01',
        originalFrequency: '1 quarter',
        daysCovered: 90
      }
    ],
    hash: 'test-hash-quarterly'
  }]

  const {insertedSeriesIds} = await insertSeriesWithValues({
    attachmentId: 'test-attachment-quarterly',
    dossierId: 'test-dossier-quarterly',
    territoire: 'test-territoire',
    series
  })

  t.is(insertedSeriesIds.length, 1)

  const values = await getSeriesValues(insertedSeriesIds[0])
  t.is(values.length, 2)

  // Première valeur avec remarque
  t.is(values[0].values.value, 100)
  t.is(values[0].values.remark, 'Estimation')
  t.is(values[0].values.originalValue, 9000)
  t.is(values[0].values.originalFrequency, '1 quarter')
  t.is(values[0].values.daysCovered, 90)

  // Deuxième valeur sans remarque mais avec métadonnées
  t.is(values[1].values.value, 100)
  t.is(values[1].values.remark, undefined)
  t.is(values[1].values.originalValue, 9000)
  t.is(values[1].values.daysCovered, 90)

  // Cleanup
  await deleteSeriesByIds(insertedSeriesIds)
})
