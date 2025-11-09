import test from 'ava'
import {ObjectId} from 'mongodb'
import mongo from '../../util/mongo.js'
import {setupTestMongo, cleanupCollections} from '../../util/test-helpers/mongo.js'
import {
  insertRegle,
  getRegle,
  updateRegleById,
  deleteRegle,
  getPreleveurRegles,
  documentHasRegles,
  bulkInsertRegles,
  bulkDeleteRegles
} from '../regle.js'

setupTestMongo(test)
cleanupCollections(test, ['regles'])

test.serial('insertRegle / crée une règle', async t => {
  const regle = {
    preleveur: new ObjectId(),
    exploitations: [new ObjectId()],
    parametre: 'Volume journalier',
    unite: 'm3',
    valeur: 100,
    contrainte: 'maximum',
    debut_validite: '2024-01-01',
    fin_validite: null,
    debut_periode: null,
    fin_periode: null,
    remarque: null,
    document: null
  }

  const inserted = await insertRegle(regle)

  t.truthy(inserted._id)
  t.is(inserted.parametre, 'Volume journalier')
  t.is(inserted.valeur, 100)
})

test.serial('getRegle / récupère une règle', async t => {
  const regle = {
    preleveur: new ObjectId(),
    exploitations: [new ObjectId()],
    parametre: 'Volume journalier',
    unite: 'm3',
    valeur: 100,
    contrainte: 'maximum',
    debut_validite: '2024-01-01'
  }

  const inserted = await insertRegle(regle)
  const found = await getRegle(inserted._id)

  t.truthy(found)
  t.deepEqual(found._id, inserted._id)
  t.is(found.parametre, 'Volume journalier')
})

test.serial('getRegle / retourne null si non trouvé', async t => {
  const found = await getRegle(new ObjectId())
  t.is(found, null)
})

test.serial('updateRegleById / met à jour une règle', async t => {
  const regle = {
    preleveur: new ObjectId(),
    exploitations: [new ObjectId()],
    parametre: 'Volume journalier',
    unite: 'm3',
    valeur: 100,
    contrainte: 'maximum',
    debut_validite: '2024-01-01'
  }

  const inserted = await insertRegle(regle)
  const updated = await updateRegleById(inserted._id, {valeur: 200, remarque: 'Modifié'})

  t.truthy(updated)
  t.is(updated.valeur, 200)
  t.is(updated.remarque, 'Modifié')
  t.is(updated.parametre, 'Volume journalier') // Inchangé
})

test.serial('deleteRegle / supprime une règle (soft delete)', async t => {
  const regle = {
    preleveur: new ObjectId(),
    exploitations: [new ObjectId()],
    parametre: 'Volume journalier',
    unite: 'm3',
    valeur: 100,
    contrainte: 'maximum',
    debut_validite: '2024-01-01'
  }

  const inserted = await insertRegle(regle)
  const deleted = await deleteRegle(inserted._id)

  t.truthy(deleted)
  t.truthy(deleted.deletedAt)

  // Vérifier que la règle n'est plus récupérable
  const found = await getRegle(inserted._id)
  t.is(found, null)
})

test.serial('getPreleveurRegles / récupère les règles d\'un préleveur', async t => {
  const preleveurId = new ObjectId()
  const autrePreleveurId = new ObjectId()

  await insertRegle({
    preleveur: preleveurId,
    exploitations: [new ObjectId()],
    parametre: 'Volume journalier',
    unite: 'm3',
    valeur: 100,
    contrainte: 'maximum',
    debut_validite: '2024-01-01'
  })

  await insertRegle({
    preleveur: preleveurId,
    exploitations: [new ObjectId()],
    parametre: 'Volume mensuel',
    unite: 'm3',
    valeur: 1000,
    contrainte: 'maximum',
    debut_validite: '2024-01-01'
  })

  await insertRegle({
    preleveur: autrePreleveurId,
    exploitations: [new ObjectId()],
    parametre: 'Volume annuel',
    unite: 'm3',
    valeur: 10_000,
    contrainte: 'maximum',
    debut_validite: '2024-01-01'
  })

  const regles = await getPreleveurRegles(preleveurId)

  t.is(regles.length, 2)
  t.true(regles.every(r => r.preleveur.equals(preleveurId)))
})

test.serial('documentHasRegles / vérifie si un document est lié à des règles', async t => {
  const documentId = new ObjectId()

  // Pas de règle au départ
  let hasRegles = await documentHasRegles(documentId)
  t.false(hasRegles)

  // Créer une règle avec ce document
  await insertRegle({
    preleveur: new ObjectId(),
    exploitations: [new ObjectId()],
    parametre: 'Volume journalier',
    unite: 'm3',
    valeur: 100,
    contrainte: 'maximum',
    debut_validite: '2024-01-01',
    document: documentId
  })

  hasRegles = await documentHasRegles(documentId)
  t.true(hasRegles)
})

test.serial('bulkInsertRegles / insère plusieurs règles', async t => {
  const codeTerritoire = 'TEST-001'
  const regles = [
    {
      preleveur: new ObjectId(),
      exploitations: [new ObjectId()],
      parametre: 'Volume journalier',
      unite: 'm3',
      valeur: 100,
      contrainte: 'maximum',
      debut_validite: '2024-01-01'
    },
    {
      preleveur: new ObjectId(),
      exploitations: [new ObjectId()],
      parametre: 'Volume mensuel',
      unite: 'm3',
      valeur: 1000,
      contrainte: 'maximum',
      debut_validite: '2024-01-01'
    }
  ]

  const result = await bulkInsertRegles(codeTerritoire, regles)

  t.is(result.insertedCount, 2)

  const allRegles = await mongo.db.collection('regles').find({territoire: codeTerritoire}).toArray()
  t.is(allRegles.length, 2)
})

test.serial('bulkDeleteRegles / supprime toutes les règles d\'un territoire', async t => {
  const codeTerritoire = 'TEST-001'

  await bulkInsertRegles(codeTerritoire, [
    {
      preleveur: new ObjectId(),
      exploitations: [new ObjectId()],
      parametre: 'Volume journalier',
      unite: 'm3',
      valeur: 100,
      contrainte: 'maximum',
      debut_validite: '2024-01-01'
    }
  ])

  const result = await bulkDeleteRegles(codeTerritoire)
  t.is(result.deletedCount, 1)

  const remaining = await mongo.db.collection('regles').find({territoire: codeTerritoire}).toArray()
  t.is(remaining.length, 0)
})
