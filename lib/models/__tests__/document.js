import test from 'ava'
import {ObjectId} from 'mongodb'
import mongo from '../../util/mongo.js'
import {
  insertDocument,
  getDocument,
  updateDocumentById,
  deleteDocument,
  getPreleveurDocuments,
  bulkInsertDocuments,
  bulkDeleteDocuments
} from '../document.js'

test.before(async () => {
  await mongo.connect()
})

test.after.always(async () => {
  await mongo.disconnect()
})

test.beforeEach(async () => {
  await mongo.db.collection('documents').deleteMany({})
})

test.serial('insertDocument / crée un document', async t => {
  const document = {
    preleveur: new ObjectId(),
    nom: 'Arrêté préfectoral',
    type: 'Arrêté préfectoral',
    nom_fichier: 'arrete.pdf',
    taille: 1024,
    objectKey: 'territoire/123/abc123/arrete.pdf',
    remarque: null
  }

  const inserted = await insertDocument(document, 'TEST-001')

  t.truthy(inserted._id)
  t.is(inserted.territoire, 'TEST-001')
  t.is(inserted.nom, 'Arrêté préfectoral')
  t.truthy(inserted.createdAt)
  t.truthy(inserted.updatedAt)
})

test.serial('getDocument / récupère un document', async t => {
  const document = {
    preleveur: new ObjectId(),
    nom: 'Document test',
    type: 'Autre',
    nom_fichier: 'test.pdf',
    taille: 512,
    objectKey: 'territoire/123/xyz456/test.pdf'
  }

  const inserted = await insertDocument(document, 'TEST-001')
  const found = await getDocument(inserted._id)

  t.truthy(found)
  t.deepEqual(found._id, inserted._id)
  t.is(found.nom, 'Document test')
})

test.serial('getDocument / retourne null si non trouvé', async t => {
  const found = await getDocument(new ObjectId())
  t.is(found, null)
})

test.serial('getDocument / ne retourne pas les documents supprimés', async t => {
  const document = {
    preleveur: new ObjectId(),
    nom: 'Document à supprimer',
    type: 'Autre',
    nom_fichier: 'deleted.pdf',
    taille: 256,
    objectKey: 'territoire/123/def789/deleted.pdf'
  }

  const inserted = await insertDocument(document, 'TEST-001')
  await deleteDocument(inserted._id)

  const found = await getDocument(inserted._id)
  t.is(found, null)
})

test.serial('updateDocumentById / met à jour un document', async t => {
  const document = {
    preleveur: new ObjectId(),
    nom: 'Document initial',
    type: 'Autre',
    nom_fichier: 'initial.pdf',
    taille: 1024,
    objectKey: 'territoire/123/ghi012/initial.pdf'
  }

  const inserted = await insertDocument(document, 'TEST-001')
  const updated = await updateDocumentById(inserted._id, {
    nom: 'Document modifié',
    remarque: 'Mis à jour'
  })

  t.truthy(updated)
  t.is(updated.nom, 'Document modifié')
  t.is(updated.remarque, 'Mis à jour')
  t.is(updated.type, 'Autre') // Inchangé
  t.truthy(updated.updatedAt)
})

test.serial('updateDocumentById / lance une erreur si document non trouvé', async t => {
  await t.throwsAsync(
    async () => updateDocumentById(new ObjectId(), {nom: 'Nouveau nom'}),
    {message: /introuvable/}
  )
})

test.serial('deleteDocument / supprime un document (soft delete)', async t => {
  const document = {
    preleveur: new ObjectId(),
    nom: 'Document à supprimer',
    type: 'Autre',
    nom_fichier: 'to_delete.pdf',
    taille: 512,
    objectKey: 'territoire/123/jkl345/to_delete.pdf'
  }

  const inserted = await insertDocument(document, 'TEST-001')
  const deleted = await deleteDocument(inserted._id)

  t.truthy(deleted)
  t.truthy(deleted.deletedAt)

  // Vérifier que le document n'est plus récupérable
  const found = await getDocument(inserted._id)
  t.is(found, null)
})

test.serial('deleteDocument / lance une erreur si document non trouvé', async t => {
  await t.throwsAsync(
    async () => deleteDocument(new ObjectId()),
    {message: /introuvable/}
  )
})

test.serial('getPreleveurDocuments / récupère les documents d\'un préleveur', async t => {
  const preleveurId = new ObjectId()
  const autrePreleveurId = new ObjectId()

  await insertDocument({
    preleveur: preleveurId,
    nom: 'Document 1',
    type: 'Arrêté préfectoral',
    nom_fichier: 'doc1.pdf',
    taille: 1024,
    objectKey: 'territoire/123/aaa111/doc1.pdf'
  }, 'TEST-001')

  await insertDocument({
    preleveur: preleveurId,
    nom: 'Document 2',
    type: 'Autre',
    nom_fichier: 'doc2.pdf',
    taille: 512,
    objectKey: 'territoire/123/bbb222/doc2.pdf'
  }, 'TEST-001')

  await insertDocument({
    preleveur: autrePreleveurId,
    nom: 'Document 3',
    type: 'Autre',
    nom_fichier: 'doc3.pdf',
    taille: 256,
    objectKey: 'territoire/123/ccc333/doc3.pdf'
  }, 'TEST-001')

  const documents = await getPreleveurDocuments(preleveurId)

  t.is(documents.length, 2)
  t.true(documents.every(d => d.preleveur.equals(preleveurId)))
})

test.serial('bulkInsertDocuments / insère plusieurs documents', async t => {
  const documents = [
    {
      preleveur: new ObjectId(),
      nom: 'Document bulk 1',
      type: 'Arrêté préfectoral',
      nom_fichier: 'bulk1.pdf',
      taille: 1024,
      objectKey: 'territoire/123/ddd444/bulk1.pdf'
    },
    {
      preleveur: new ObjectId(),
      nom: 'Document bulk 2',
      type: 'Autre',
      nom_fichier: 'bulk2.pdf',
      taille: 512,
      objectKey: 'territoire/123/eee555/bulk2.pdf'
    }
  ]

  const result = await bulkInsertDocuments('TEST-001', documents)

  t.is(result.insertedCount, 2)

  const allDocuments = await mongo.db.collection('documents').find({territoire: 'TEST-001'}).toArray()
  t.is(allDocuments.length, 2)
  t.true(allDocuments.every(d => d.territoire === 'TEST-001'))
})

test.serial('bulkInsertDocuments / retourne 0 pour tableau vide', async t => {
  const result = await bulkInsertDocuments('TEST-001', [])
  t.is(result.insertedCount, 0)
})

test.serial('bulkDeleteDocuments / supprime tous les documents d\'un territoire', async t => {
  await bulkInsertDocuments('TEST-001', [
    {
      preleveur: new ObjectId(),
      nom: 'Document à supprimer',
      type: 'Autre',
      nom_fichier: 'delete1.pdf',
      taille: 1024,
      objectKey: 'territoire/123/fff666/delete1.pdf'
    }
  ])

  await bulkDeleteDocuments('TEST-001')

  const remaining = await mongo.db.collection('documents').find({territoire: 'TEST-001'}).toArray()
  t.is(remaining.length, 0)
})
