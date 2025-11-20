import test from 'ava'
import {ObjectId} from 'mongodb'
import mongo from '../../util/mongo.js'
import * as SerieService from '../serie.js'

test.before(async () => {
  await mongo.connect()
})

test.after.always(async () => {
  await mongo.disconnect()
})

test.beforeEach(async () => {
  await mongo.db.collection('series').deleteMany({})
  await mongo.db.collection('series_values').deleteMany({})
  await mongo.db.collection('integrations_journalieres').deleteMany({})
  await mongo.db.collection('dossier_attachments').deleteMany({})
})

test('compareSeries: identifies series to delete, create, and unchanged', t => {
  const existingSeries = [
    {_id: new ObjectId(), hash: 'aaa111'},
    {_id: new ObjectId(), hash: 'bbb222'},
    {_id: new ObjectId(), hash: 'ccc333'}
  ]

  const newSeries = [
    {hash: 'bbb222', data: []}, // Unchanged
    {hash: 'ddd444', data: []}, // New
    {hash: 'eee555', data: []} // New
  ]

  const result = SerieService.compareSeries(existingSeries, newSeries)

  t.is(result.toDelete.length, 2) // Aaa111 et ccc333
  t.is(result.toCreate.length, 2) // Ddd444 et eee555
  t.is(result.unchangedCount, 1) // Bbb222

  t.true(result.toDelete.includes(existingSeries[0]._id))
  t.true(result.toDelete.includes(existingSeries[2]._id))
})

test('compareSeries: handles empty existing series', t => {
  const existingSeries = []
  const newSeries = [
    {hash: 'aaa111', data: []},
    {hash: 'bbb222', data: []}
  ]

  const result = SerieService.compareSeries(existingSeries, newSeries)

  t.is(result.toDelete.length, 0)
  t.is(result.toCreate.length, 2)
  t.is(result.unchangedCount, 0)
})

test('compareSeries: handles empty new series (delete all)', t => {
  const existingSeries = [
    {_id: new ObjectId(), hash: 'aaa111'},
    {_id: new ObjectId(), hash: 'bbb222'}
  ]
  const newSeries = []

  const result = SerieService.compareSeries(existingSeries, newSeries)

  t.is(result.toDelete.length, 2)
  t.is(result.toCreate.length, 0)
  t.is(result.unchangedCount, 0)
})

test.serial('deleteSeriesByAttachmentWithIntegrations: deletes series, values and integrations', async t => {
  const dossierId = new ObjectId()
  const attachmentId = new ObjectId()
  const preleveurId = new ObjectId()
  const pointId = new ObjectId()

  // Créer des séries
  const {insertedIds} = await mongo.db.collection('series').insertMany([
    {attachmentId, dossierId, territoire: '01', parameter: 'débit', frequency: '1 day'},
    {attachmentId, dossierId, territoire: '01', parameter: 'volume prélevé', frequency: '1 day'}
  ])

  const seriesIds = Object.values(insertedIds)

  // Créer des valeurs
  await mongo.db.collection('series_values').insertMany([
    {seriesId: seriesIds[0], date: '2024-01-01', values: {value: 10}},
    {seriesId: seriesIds[1], date: '2024-01-01', values: {value: 100}}
  ])

  // Créer des intégrations
  await mongo.db.collection('integrations_journalieres').insertOne({
    preleveur: preleveurId,
    point: pointId,
    date: '2024-01-01',
    dossierId,
    attachmentId
  })

  // Supprimer via le service
  const result = await SerieService.deleteSeriesByAttachmentWithIntegrations(attachmentId)

  t.is(result.deletedSeries, 2)
  t.is(result.deletedValues, 2)
  t.is(result.deletedIntegrations, 1)

  // Vérifier que tout est supprimé
  const remainingSeries = await mongo.db.collection('series').find({attachmentId}).toArray()
  const remainingValues = await mongo.db.collection('series_values').find({seriesId: {$in: seriesIds}}).toArray()
  const remainingIntegrations = await mongo.db.collection('integrations_journalieres').find({attachmentId}).toArray()

  t.is(remainingSeries.length, 0)
  t.is(remainingValues.length, 0)
  t.is(remainingIntegrations.length, 0)
})

test.serial('deleteSeriesByAttachmentWithIntegrations: handles attachment without data', async t => {
  const attachmentId = new ObjectId()

  const result = await SerieService.deleteSeriesByAttachmentWithIntegrations(attachmentId)

  t.is(result.deletedSeries, 0)
  t.is(result.deletedValues, 0)
  t.is(result.deletedIntegrations, 0)
})
