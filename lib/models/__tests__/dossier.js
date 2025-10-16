import test from 'ava'
import {MongoMemoryServer} from 'mongodb-memory-server'
import mongo, {ObjectId} from '../../util/mongo.js'
import {upsertDossier, markDossierForReconsolidation} from '../dossier.js'

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

test('markDossierForReconsolidation: removes consolidatedAt field', async t => {
  const demarcheNumber = 12_345
  const dossierNumber = 67_890

  // Créer un dossier avec consolidatedAt
  const dossier = await upsertDossier(demarcheNumber, {
    number: dossierNumber,
    status: 'accepte',
    consolidatedAt: new Date('2024-01-15T10:00:00Z')
  })

  t.truthy(dossier.consolidatedAt, 'Le dossier devrait avoir consolidatedAt initialement')

  // Marquer pour reconsolidation
  const updated = await markDossierForReconsolidation(dossier._id)

  t.is(updated.consolidatedAt, undefined, 'consolidatedAt devrait être supprimé')
  t.is(updated.status, 'accepte', 'Les autres champs devraient rester inchangés')
  t.is(updated.number, dossierNumber)
})

test('markDossierForReconsolidation: works on dossier without consolidatedAt', async t => {
  const demarcheNumber = 12_345
  const dossierNumber = 67_891

  // Créer un dossier sans consolidatedAt
  const dossier = await upsertDossier(demarcheNumber, {
    number: dossierNumber,
    status: 'en_construction'
  })

  t.is(dossier.consolidatedAt, undefined)

  // Marquer pour reconsolidation (devrait fonctionner même sans consolidatedAt)
  const updated = await markDossierForReconsolidation(dossier._id)

  t.is(updated.consolidatedAt, undefined)
  t.is(updated.status, 'en_construction')
})

test('markDossierForReconsolidation: returns null for non-existent dossier', async t => {
  const fakeId = new ObjectId()
  const result = await markDossierForReconsolidation(fakeId)

  t.is(result, null, 'Devrait retourner null pour un dossier inexistant')
})

test('markDossierForReconsolidation: multiple calls are idempotent', async t => {
  const demarcheNumber = 12_345
  const dossierNumber = 67_892

  const dossier = await upsertDossier(demarcheNumber, {
    number: dossierNumber,
    status: 'accepte',
    consolidatedAt: new Date('2024-02-01T12:00:00Z')
  })

  // Premier appel
  const first = await markDossierForReconsolidation(dossier._id)
  t.is(first.consolidatedAt, undefined)

  // Deuxième appel
  const second = await markDossierForReconsolidation(dossier._id)
  t.is(second.consolidatedAt, undefined)
  t.is(second._id.toString(), first._id.toString())
})
