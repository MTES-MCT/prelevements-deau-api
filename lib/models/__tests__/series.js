import test from 'ava'
import {MongoMemoryServer} from 'mongodb-memory-server'
import mongo, {ObjectId} from '../../util/mongo.js'
import {buildValueObject, insertSeriesWithValues, getSeriesById, getSeriesValues, deleteSeriesByIds, buildPointPreleveurQuery, listSeries, updateSeriesIntegratedDays, updateSeriesComputed} from '../series.js'

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

// Tests pour dailyAggregates

test('insertSeriesWithValues - série infra-journalière calcule dailyAggregates', async t => {
  const attachmentId = new ObjectId()
  const dossierId = new ObjectId()
  const territoire = 'TEST'

  const series = [{
    pointPrelevement: 123,
    parameter: 'température',
    unit: '°C',
    frequency: '1 hour',
    valueType: 'instantaneous',
    minDate: '2024-01-01',
    maxDate: '2024-01-01',
    data: [
      {date: '2024-01-01', time: '00:00', value: 10},
      {date: '2024-01-01', time: '01:00', value: 12},
      {date: '2024-01-01', time: '02:00', value: 15},
      {date: '2024-01-01', time: '03:00', value: 11}
    ]
  }]

  const result = await insertSeriesWithValues({attachmentId, dossierId, territoire, series})
  const seriesId = result.insertedSeriesIds[0]
  const values = await getSeriesValues(seriesId)

  t.is(values.length, 1)
  t.truthy(values[0].dailyAggregates)
  t.is(values[0].dailyAggregates.min, 10)
  t.is(values[0].dailyAggregates.max, 15)
  t.is(values[0].dailyAggregates.mean, 12)
  t.is(values[0].dailyAggregates.count, 4)
  t.is(values[0].dailyAggregates.coverageHours, 4)
})

test('insertSeriesWithValues - série infra-journalière cumulative calcule sum', async t => {
  const attachmentId = new ObjectId()
  const dossierId = new ObjectId()
  const territoire = 'TEST'

  const series = [{
    pointPrelevement: 456,
    parameter: 'volume prélevé',
    unit: 'm3',
    frequency: '1 hour',
    valueType: 'cumulative',
    minDate: '2024-01-01',
    maxDate: '2024-01-01',
    data: [
      {date: '2024-01-01', time: '00:00', value: 10},
      {date: '2024-01-01', time: '01:00', value: 20},
      {date: '2024-01-01', time: '02:00', value: 30}
    ]
  }]

  const result = await insertSeriesWithValues({attachmentId, dossierId, territoire, series})
  const seriesId = result.insertedSeriesIds[0]
  const values = await getSeriesValues(seriesId)

  t.truthy(values[0].dailyAggregates)
  t.is(values[0].dailyAggregates.sum, 60)
  t.is(values[0].dailyAggregates.mean, 20)
})

test('insertSeriesWithValues - série infra-journalière avec 96 valeurs (15 minutes)', async t => {
  const attachmentId = new ObjectId()
  const dossierId = new ObjectId()
  const territoire = 'TEST'

  const data = []
  for (let i = 0; i < 96; i++) {
    const hour = Math.floor(i / 4)
    const min = (i % 4) * 15
    const time = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`
    data.push({date: '2024-01-01', time, value: 10 + (i * 0.1)})
  }

  const series = [{
    pointPrelevement: 789,
    parameter: 'débit',
    unit: 'L/s',
    frequency: '15 minutes',
    valueType: 'instantaneous',
    minDate: '2024-01-01',
    maxDate: '2024-01-01',
    data
  }]

  const result = await insertSeriesWithValues({attachmentId, dossierId, territoire, series})
  const seriesId = result.insertedSeriesIds[0]
  const values = await getSeriesValues(seriesId)

  t.is(values[0].dailyAggregates.count, 96)
  t.is(values[0].dailyAggregates.coverageHours, 24)
  t.is(values[0].dailyAggregates.min, 10)
  t.true(Math.abs(values[0].dailyAggregates.max - 19.5) < 0.01)
})

test('insertSeriesWithValues - série avec remarques', async t => {
  const attachmentId = new ObjectId()
  const dossierId = new ObjectId()
  const territoire = 'TEST'

  const series = [{
    pointPrelevement: 111,
    parameter: 'température',
    unit: '°C',
    frequency: '1 hour',
    valueType: 'instantaneous',
    minDate: '2024-01-01',
    maxDate: '2024-01-01',
    data: [
      {date: '2024-01-01', time: '00:00', value: 10.5, remark: 'Valeur estimée'},
      {date: '2024-01-01', time: '01:00', value: 11.2},
      {date: '2024-01-01', time: '02:00', value: 12, remark: 'Valeur estimée'},
      {date: '2024-01-01', time: '03:00', value: 13.5, remark: 'Capteur défectueux'}
    ]
  }]

  const result = await insertSeriesWithValues({attachmentId, dossierId, territoire, series})
  const seriesId = result.insertedSeriesIds[0]
  const values = await getSeriesValues(seriesId)

  t.truthy(values[0].dailyAggregates)
  t.is(values[0].dailyAggregates.hasRemark, true)
  t.is(values[0].dailyAggregates.uniqueRemarks.length, 2)
  t.true(values[0].dailyAggregates.uniqueRemarks.includes('Valeur estimée'))
  t.true(values[0].dailyAggregates.uniqueRemarks.includes('Capteur défectueux'))
})

test('insertSeriesWithValues - série avec plus de 10 remarques uniques (limite à 10)', async t => {
  const attachmentId = new ObjectId()
  const dossierId = new ObjectId()
  const territoire = 'TEST'

  const data = []
  for (let i = 0; i < 15; i++) {
    data.push({
      date: '2024-01-01',
      time: `${String(i).padStart(2, '0')}:00`,
      value: 10 + i,
      remark: `Remarque ${i}`
    })
  }

  const series = [{
    pointPrelevement: 222,
    parameter: 'température',
    unit: '°C',
    frequency: '1 hour',
    valueType: 'instantaneous',
    minDate: '2024-01-01',
    maxDate: '2024-01-01',
    data
  }]

  const result = await insertSeriesWithValues({attachmentId, dossierId, territoire, series})
  const seriesId = result.insertedSeriesIds[0]
  const values = await getSeriesValues(seriesId)

  t.is(values[0].dailyAggregates.hasRemark, true)
  t.is(values[0].dailyAggregates.uniqueRemarks.length, 10) // Limité à 10
})

test('insertSeriesWithValues - série avec valeurs invalides (null, NaN, Infinity)', async t => {
  const attachmentId = new ObjectId()
  const dossierId = new ObjectId()
  const territoire = 'TEST'

  const series = [{
    pointPrelevement: 333,
    parameter: 'température',
    unit: '°C',
    frequency: '1 hour',
    valueType: 'instantaneous',
    minDate: '2024-01-01',
    maxDate: '2024-01-01',
    data: [
      {date: '2024-01-01', time: '00:00', value: 10},
      {date: '2024-01-01', time: '01:00', value: null},
      {date: '2024-01-01', time: '02:00', value: 20},
      {date: '2024-01-01', time: '03:00', value: Number.NaN},
      {date: '2024-01-01', time: '04:00', value: 30},
      {date: '2024-01-01', time: '05:00', value: Number.POSITIVE_INFINITY}
    ]
  }]

  const result = await insertSeriesWithValues({attachmentId, dossierId, territoire, series})
  const seriesId = result.insertedSeriesIds[0]
  const values = await getSeriesValues(seriesId)

  // Seules les 3 valeurs valides doivent être prises en compte
  t.is(values[0].dailyAggregates.count, 3)
  t.is(values[0].dailyAggregates.min, 10)
  t.is(values[0].dailyAggregates.max, 30)
  t.is(values[0].dailyAggregates.mean, 20)
})

test('insertSeriesWithValues - série journalière ne calcule pas d\'agrégats', async t => {
  const attachmentId = new ObjectId()
  const dossierId = new ObjectId()
  const territoire = 'TEST'

  const series = [{
    pointPrelevement: 444,
    parameter: 'volume prélevé',
    unit: 'm3',
    frequency: '1 day',
    valueType: 'cumulative',
    minDate: '2024-01-01',
    maxDate: '2024-01-03',
    data: [
      {date: '2024-01-01', value: 100},
      {date: '2024-01-02', value: 150},
      {date: '2024-01-03', value: 120}
    ]
  }]

  const result = await insertSeriesWithValues({attachmentId, dossierId, territoire, series})
  const seriesId = result.insertedSeriesIds[0]
  const values = await getSeriesValues(seriesId)

  t.is(values.length, 3)
  // Les séries journalières n'ont pas de dailyAggregates
  t.is(values[0].dailyAggregates, undefined)
  t.is(values[0].values.value, 100)
})

test('insertSeriesWithValues - plusieurs jours dans une série infra-journalière', async t => {
  const attachmentId = new ObjectId()
  const dossierId = new ObjectId()
  const territoire = 'TEST'

  const series = [{
    pointPrelevement: 555,
    parameter: 'température',
    unit: '°C',
    frequency: '1 hour',
    valueType: 'instantaneous',
    minDate: '2024-01-01',
    maxDate: '2024-01-02',
    data: [
      {date: '2024-01-01', time: '10:00', value: 10},
      {date: '2024-01-01', time: '11:00', value: 12},
      {date: '2024-01-02', time: '10:00', value: 15},
      {date: '2024-01-02', time: '11:00', value: 18},
      {date: '2024-01-02', time: '12:00', value: 20}
    ]
  }]

  const result = await insertSeriesWithValues({attachmentId, dossierId, territoire, series})
  const seriesId = result.insertedSeriesIds[0]
  const values = await getSeriesValues(seriesId)

  t.is(values.length, 2) // Deux jours

  // Jour 1
  t.is(values[0].date, '2024-01-01')
  t.is(values[0].dailyAggregates.count, 2)
  t.is(values[0].dailyAggregates.min, 10)
  t.is(values[0].dailyAggregates.max, 12)
  t.is(values[0].dailyAggregates.mean, 11)

  // Jour 2
  t.is(values[1].date, '2024-01-02')
  t.is(values[1].dailyAggregates.count, 3)
  t.is(values[1].dailyAggregates.min, 15)
  t.is(values[1].dailyAggregates.max, 20)
  t.is(Math.round(values[1].dailyAggregates.mean * 10) / 10, 17.7)
})

// Tests pour buildPointPreleveurQuery et listSeries avec onlyIntegratedDays

test('buildPointPreleveurQuery - avec onlyIntegratedDays mais sans contraintes de dates', t => {
  const query = buildPointPreleveurQuery({
    territoire: 'TEST',
    pointId: new ObjectId(),
    onlyIntegratedDays: true
  })

  t.is(query.territoire, 'TEST')
  t.truthy(query['computed.integratedDays'])
  t.is(query['computed.integratedDays'].$exists, true)
  t.is(query['computed.integratedDays'].$type, 'array')
  t.deepEqual(query['computed.integratedDays'].$not, {$size: 0})
})

test('buildPointPreleveurQuery - avec onlyIntegratedDays et contraintes de dates', t => {
  const query = buildPointPreleveurQuery({
    territoire: 'TEST',
    pointId: new ObjectId(),
    from: '2024-01-01',
    to: '2024-12-31',
    onlyIntegratedDays: true
  })

  t.is(query.territoire, 'TEST')
  t.truthy(query['computed.integratedDays'])
  t.truthy(query['computed.integratedDays'].$elemMatch)
  t.is(query['computed.integratedDays'].$elemMatch.$gte, '2024-01-01')
  t.is(query['computed.integratedDays'].$elemMatch.$lte, '2024-12-31')
})

test('buildPointPreleveurQuery - sans onlyIntegratedDays utilise minDate/maxDate', t => {
  const query = buildPointPreleveurQuery({
    territoire: 'TEST',
    pointId: new ObjectId(),
    from: '2024-01-01',
    to: '2024-12-31',
    onlyIntegratedDays: false
  })

  t.is(query.territoire, 'TEST')
  t.is(query['computed.integratedDays'], undefined)
  t.truthy(query.maxDate)
  t.is(query.maxDate.$gte, '2024-01-01')
  t.truthy(query.minDate)
  t.is(query.minDate.$lte, '2024-12-31')
})

test('listSeries - avec onlyIntegratedDays=true sans dates retourne séries avec integratedDays', async t => {
  const territoire = 'TEST_INTEGRATED'
  const pointOid = new ObjectId()
  const attachmentId = new ObjectId()
  const dossierId = new ObjectId()

  // Créer une série
  const series = [{
    pointPrelevement: 999,
    parameter: 'volume prélevé',
    unit: 'm3',
    frequency: '1 day',
    valueType: 'cumulative',
    minDate: '2024-01-01',
    maxDate: '2024-01-05',
    data: [
      {date: '2024-01-01', value: 100},
      {date: '2024-01-02', value: 150},
      {date: '2024-01-03', value: 120},
      {date: '2024-01-04', value: 180},
      {date: '2024-01-05', value: 90}
    ]
  }]

  const {insertedSeriesIds} = await insertSeriesWithValues({
    attachmentId,
    dossierId,
    territoire,
    series
  })

  // Mettre à jour computed.point et computed.integratedDays
  await updateSeriesComputed(insertedSeriesIds, {pointId: pointOid})
  await updateSeriesIntegratedDays(insertedSeriesIds, [
    '2024-01-01',
    '2024-01-02',
    '2024-01-03',
    '2024-01-04',
    '2024-01-05'
  ])

  // Test: récupérer avec onlyIntegratedDays=true sans contraintes de dates
  const result = await listSeries({
    territoire,
    pointId: pointOid,
    onlyIntegratedDays: true
  })

  t.is(result.length, 1)
  t.is(result[0].parameter, 'volume prélevé')

  // Cleanup
  await deleteSeriesByIds(insertedSeriesIds)
})

test('listSeries - avec onlyIntegratedDays=true sans dates ne retourne pas séries sans integratedDays', async t => {
  const territoire = 'TEST_NO_INTEGRATED'
  const pointOid = new ObjectId()
  const attachmentId = new ObjectId()
  const dossierId = new ObjectId()

  // Créer une série sans integratedDays
  const series = [{
    pointPrelevement: 888,
    parameter: 'température',
    unit: '°C',
    frequency: '1 day',
    valueType: 'instantaneous',
    minDate: '2024-01-01',
    maxDate: '2024-01-03',
    data: [
      {date: '2024-01-01', value: 15},
      {date: '2024-01-02', value: 18},
      {date: '2024-01-03', value: 16}
    ]
  }]

  const {insertedSeriesIds} = await insertSeriesWithValues({
    attachmentId,
    dossierId,
    territoire,
    series
  })

  // Mettre à jour computed.point mais PAS integratedDays
  await updateSeriesComputed(insertedSeriesIds, {pointId: pointOid})

  // Test: récupérer avec onlyIntegratedDays=true sans contraintes de dates
  const result = await listSeries({
    territoire,
    pointId: pointOid,
    onlyIntegratedDays: true
  })

  // Doit retourner une liste vide car pas de integratedDays
  t.is(result.length, 0)

  // Cleanup
  await deleteSeriesByIds(insertedSeriesIds)
})

test('listSeries - avec onlyIntegratedDays=true et dates filtre correctement', async t => {
  const territoire = 'TEST_FILTER_DATES'
  const pointOid = new ObjectId()
  const attachmentId = new ObjectId()
  const dossierId = new ObjectId()

  // Créer une série
  const series = [{
    pointPrelevement: 777,
    parameter: 'débit',
    unit: 'L/s',
    frequency: '1 day',
    valueType: 'instantaneous',
    minDate: '2024-01-01',
    maxDate: '2024-12-31',
    data: [
      {date: '2024-01-15', value: 10},
      {date: '2024-06-15', value: 20},
      {date: '2024-12-15', value: 15}
    ]
  }]

  const {insertedSeriesIds} = await insertSeriesWithValues({
    attachmentId,
    dossierId,
    territoire,
    series
  })

  await updateSeriesComputed(insertedSeriesIds, {pointId: pointOid})
  await updateSeriesIntegratedDays(insertedSeriesIds, [
    '2024-01-15',
    '2024-06-15',
    '2024-12-15'
  ])

  // Test: récupérer avec onlyIntegratedDays=true et filtre sur juin seulement
  const result = await listSeries({
    territoire,
    pointId: pointOid,
    from: '2024-06-01',
    to: '2024-06-30',
    onlyIntegratedDays: true
  })

  // Doit retourner la série car elle contient au moins une date dans l'intervalle
  t.is(result.length, 1)

  // Test: récupérer avec une plage où il n'y a aucune date intégrée
  const resultEmpty = await listSeries({
    territoire,
    pointId: pointOid,
    from: '2024-02-01',
    to: '2024-02-28',
    onlyIntegratedDays: true
  })

  t.is(resultEmpty.length, 0)

  // Cleanup
  await deleteSeriesByIds(insertedSeriesIds)
})
