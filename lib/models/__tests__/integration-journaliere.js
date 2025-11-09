import test from 'ava'
import {ObjectId} from 'mongodb'
import {setupTestMongo} from '../../util/test-helpers/mongo.js'
import {insertIntegration, getIntegration, deleteIntegrationsByAttachment} from '../integration-journaliere.js'

setupTestMongo(test)

test('integration-journaliere: idempotence insertion', async t => {
  const preleveurId = new ObjectId()
  const pointId = new ObjectId()
  const date = '2024-01-01'

  const dossierId = new ObjectId()
  const first = await insertIntegration({preleveurId, pointId}, date, {dossierId, attachmentId: 'att-1'})
  const second = await insertIntegration({preleveurId, pointId}, date, {dossierId, attachmentId: 'att-1'})

  t.is(first._id.toString(), second._id.toString())

  const fetched = await getIntegration({preleveurId, pointId}, date)
  t.is(fetched._id.toString(), first._id.toString())
})

test('deleteIntegrationsByAttachment: delete all integrations for attachment', async t => {
  const preleveurId = new ObjectId()
  const pointId1 = new ObjectId()
  const pointId2 = new ObjectId()
  const dossierId = new ObjectId()
  const attachmentId = 'att-delete-test-1'

  // Insérer plusieurs intégrations pour le même attachment
  await insertIntegration({preleveurId, pointId: pointId1}, '2024-01-01', {dossierId, attachmentId})
  await insertIntegration({preleveurId, pointId: pointId1}, '2024-01-02', {dossierId, attachmentId})
  await insertIntegration({preleveurId, pointId: pointId2}, '2024-01-03', {dossierId, attachmentId})

  // Vérifier qu'elles existent
  const before1 = await getIntegration({preleveurId, pointId: pointId1}, '2024-01-01')
  const before2 = await getIntegration({preleveurId, pointId: pointId1}, '2024-01-02')
  const before3 = await getIntegration({preleveurId, pointId: pointId2}, '2024-01-03')
  t.truthy(before1)
  t.truthy(before2)
  t.truthy(before3)

  // Supprimer toutes les intégrations pour cet attachment
  const result = await deleteIntegrationsByAttachment(attachmentId)
  t.is(result.deletedCount, 3)

  // Vérifier qu'elles n'existent plus
  const after1 = await getIntegration({preleveurId, pointId: pointId1}, '2024-01-01')
  const after2 = await getIntegration({preleveurId, pointId: pointId1}, '2024-01-02')
  const after3 = await getIntegration({preleveurId, pointId: pointId2}, '2024-01-03')
  t.is(after1, null)
  t.is(after2, null)
  t.is(after3, null)
})

test('deleteIntegrationsByAttachment: delete specific dates only', async t => {
  const preleveurId = new ObjectId()
  const pointId = new ObjectId()
  const dossierId = new ObjectId()
  const attachmentId = 'att-delete-test-2'

  // Insérer plusieurs intégrations
  await insertIntegration({preleveurId, pointId}, '2024-02-01', {dossierId, attachmentId})
  await insertIntegration({preleveurId, pointId}, '2024-02-02', {dossierId, attachmentId})
  await insertIntegration({preleveurId, pointId}, '2024-02-03', {dossierId, attachmentId})

  // Supprimer uniquement les dates spécifiques
  const result = await deleteIntegrationsByAttachment(attachmentId, ['2024-02-01', '2024-02-03'])
  t.is(result.deletedCount, 2)

  // Vérifier que seules les dates spécifiées ont été supprimées
  const deleted1 = await getIntegration({preleveurId, pointId}, '2024-02-01')
  const kept = await getIntegration({preleveurId, pointId}, '2024-02-02')
  const deleted3 = await getIntegration({preleveurId, pointId}, '2024-02-03')

  t.is(deleted1, null)
  t.truthy(kept)
  t.is(deleted3, null)
})

test('deleteIntegrationsByAttachment: no dates specified deletes all', async t => {
  const preleveurId = new ObjectId()
  const pointId = new ObjectId()
  const dossierId = new ObjectId()
  const attachmentId = 'att-delete-test-3'

  await insertIntegration({preleveurId, pointId}, '2024-03-01', {dossierId, attachmentId})
  await insertIntegration({preleveurId, pointId}, '2024-03-02', {dossierId, attachmentId})

  // Passer null ou undefined devrait supprimer tout
  const result = await deleteIntegrationsByAttachment(attachmentId, null)
  t.is(result.deletedCount, 2)
})

test('deleteIntegrationsByAttachment: empty dates array deletes all', async t => {
  const preleveurId = new ObjectId()
  const pointId = new ObjectId()
  const dossierId = new ObjectId()
  const attachmentId = 'att-delete-test-4'

  await insertIntegration({preleveurId, pointId}, '2024-04-01', {dossierId, attachmentId})
  await insertIntegration({preleveurId, pointId}, '2024-04-02', {dossierId, attachmentId})

  // Passer un tableau vide devrait supprimer tout
  const result = await deleteIntegrationsByAttachment(attachmentId, [])
  t.is(result.deletedCount, 2)
})

test('deleteIntegrationsByAttachment: non-existent attachment returns 0', async t => {
  const result = await deleteIntegrationsByAttachment('non-existent-attachment')
  t.is(result.deletedCount, 0)
})

test('deleteIntegrationsByAttachment: does not delete other attachments', async t => {
  const preleveurId = new ObjectId()
  const pointId = new ObjectId()
  const dossierId = new ObjectId()
  const attachmentId1 = 'att-delete-test-5'
  const attachmentId2 = 'att-delete-test-6'

  // Créer des intégrations pour deux attachments différents
  await insertIntegration({preleveurId, pointId}, '2024-05-01', {dossierId, attachmentId: attachmentId1})
  await insertIntegration({preleveurId, pointId}, '2024-05-02', {dossierId, attachmentId: attachmentId2})

  // Supprimer seulement le premier attachment
  const result = await deleteIntegrationsByAttachment(attachmentId1)
  t.is(result.deletedCount, 1)

  // Vérifier que le deuxième attachment n'a pas été supprimé
  const kept = await getIntegration({preleveurId, pointId}, '2024-05-02')
  t.truthy(kept)
  t.is(kept.attachmentId, attachmentId2)
})
