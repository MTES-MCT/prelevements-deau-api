import {Buffer} from 'node:buffer'
import test from 'ava'
import {ObjectId} from 'mongodb'
import {setupTestMongo, cleanupCollections} from '../../util/test-helpers/mongo.js'
import * as DocumentService from '../document.js'
import * as DocumentModel from '../../models/document.js'
import * as RegleModel from '../../models/regle.js'
import * as ExploitationModel from '../../models/exploitation.js'

// Mock S3
const mockS3 = () => ({
  objectExists: async () => false,
  uploadObject: async () => true,
  deleteObject: async () => true,
  getPresignedUrl: async objectKey => `https://s3.mock/${objectKey}`
})

setupTestMongo(test)
cleanupCollections(test, ['documents', 'regles', 'exploitations', 'sequences'])

test.serial('uploadDocumentToS3 / génère une clé S3 avec hash', async t => {
  const buffer = Buffer.from('test content')
  const result = await DocumentService.uploadDocumentToS3({
    buffer,
    filename: 'test.pdf',
    codeTerritoire: 'TEST-001',
    preleveurSeqId: 123,
    s3: mockS3
  })

  t.truthy(result.objectKey)
  t.true(result.objectKey.startsWith('TEST-001/123/'))
  t.true(result.objectKey.endsWith('/test.pdf'))
  t.is(typeof result.skipped, 'boolean')
})

test.serial('createDocument / crée un document avec validation', async t => {
  const preleveurId = new ObjectId()
  const payload = {
    nom_fichier: 'arrete.pdf',
    reference: 'REF-001',
    nature: 'Autorisation IOTA',
    date_signature: '2024-01-01',
    date_ajout: '2024-01-01',
    remarque: 'Document de test'
  }

  const file = {
    originalname: 'arrete.pdf',
    buffer: Buffer.from('test content'),
    size: 1024
  }

  const document = await DocumentService.createDocument({
    payload,
    file,
    preleveurSeqId: 123,
    preleveurObjectId: preleveurId,
    codeTerritoire: 'TEST-001',
    s3: mockS3
  })

  t.truthy(document._id)
  t.is(document.nom_fichier, 'arrete.pdf')
  t.is(document.taille, 1024)
  t.truthy(document.objectKey)
  t.deepEqual(document.preleveur, preleveurId)
})

test.serial('createDocument / lance une erreur si pas de fichier', async t => {
  const payload = {
    nom_fichier: 'test.pdf',
    reference: 'REF-001',
    nature: 'Autorisation IOTA',
    date_signature: '2024-01-01',
    date_ajout: '2024-01-01'
  }

  const file = {
    originalname: 'test.pdf',
    size: 1024
    // Buffer manquant
  }

  await t.throwsAsync(
    async () => DocumentService.createDocument({
      payload,
      file,
      preleveurSeqId: 123,
      preleveurObjectId: new ObjectId(),
      codeTerritoire: 'TEST-001',
      s3: mockS3
    }),
    {message: /Aucun fichier envoyé/}
  )
})

test.serial('updateDocument / met à jour un document', async t => {
  const document = await DocumentModel.insertDocument({
    preleveur: new ObjectId(),
    nom_fichier: 'initial.pdf',
    reference: 'REF-001',
    nature: 'Autorisation IOTA',
    date_signature: '2024-01-01',
    date_ajout: '2024-01-01',
    taille: 1024,
    objectKey: 'territoire/123/abc123/initial.pdf'
  }, 'TEST-001')

  const updated = await DocumentService.updateDocument(document._id, {
    reference: 'REF-002',
    remarque: 'Mise à jour'
  })

  t.is(updated.reference, 'REF-002')
  t.is(updated.remarque, 'Mise à jour')
})

test.serial('updateDocument / lance une erreur si aucun champ valide', async t => {
  const document = await DocumentModel.insertDocument({
    preleveur: new ObjectId(),
    nom_fichier: 'test.pdf',
    reference: 'REF-001',
    nature: 'Autorisation IOTA',
    date_signature: '2024-01-01',
    date_ajout: '2024-01-01',
    taille: 1024,
    objectKey: 'territoire/123/def456/test.pdf'
  }, 'TEST-001')

  await t.throwsAsync(
    async () => DocumentService.updateDocument(document._id, {}),
    {message: /Aucun champ valide/}
  )
})

test.serial('deleteDocument / supprime un document si pas de dépendances', async t => {
  const document = await DocumentModel.insertDocument({
    preleveur: new ObjectId(),
    nom_fichier: 'delete.pdf',
    reference: 'REF-001',
    nature: 'Autorisation IOTA',
    date_signature: '2024-01-01',
    date_ajout: '2024-01-01',
    taille: 512,
    objectKey: 'territoire/123/ghi789/delete.pdf'
  }, 'TEST-001')

  const deleted = await DocumentService.deleteDocument(document._id)

  t.truthy(deleted)
  t.truthy(deleted.deletedAt)
})

test.serial('deleteDocument / lance une erreur si document lié à des règles', async t => {
  const documentId = new ObjectId()

  // Créer un document
  await DocumentModel.insertDocument({
    _id: documentId,
    preleveur: new ObjectId(),
    nom_fichier: 'avec_regles.pdf',
    reference: 'REF-001',
    nature: 'Autorisation IOTA',
    date_signature: '2024-01-01',
    date_ajout: '2024-01-01',
    taille: 1024,
    objectKey: 'territoire/123/jkl012/avec_regles.pdf'
  }, 'TEST-001')

  // Créer une règle qui référence ce document
  await RegleModel.insertRegle({
    preleveur: new ObjectId(),
    exploitations: [new ObjectId()],
    parametre: 'volume prélevé',
    unite: 'm³',
    valeur: 100,
    contrainte: 'max',
    debut_validite: '2024-01-01',
    document: documentId
  }, 'TEST-001')

  await t.throwsAsync(
    async () => DocumentService.deleteDocument(documentId),
    {message: /lié à une ou plusieurs règles/}
  )
})

test.serial('deleteDocument / lance une erreur si document lié à des exploitations', async t => {
  const documentId = new ObjectId()

  // Créer un document
  await DocumentModel.insertDocument({
    _id: documentId,
    preleveur: new ObjectId(),
    nom_fichier: 'avec_exploitations.pdf',
    reference: 'REF-001',
    nature: 'Autorisation IOTA',
    date_signature: '2024-01-01',
    date_ajout: '2024-01-01',
    taille: 512,
    objectKey: 'territoire/123/mno345/avec_exploitations.pdf'
  }, 'TEST-001')

  // Créer une exploitation qui référence ce document
  await ExploitationModel.insertExploitation({
    preleveur: new ObjectId(),
    point: new ObjectId(),
    usages: ['Agriculture'],
    statut: 'En activité',
    date_debut: '2024-01-01',
    documents: [documentId]
  }, 'TEST-001')

  await t.throwsAsync(
    async () => DocumentService.deleteDocument(documentId),
    {message: /lié à une ou plusieurs exploitations/}
  )
})

test.serial('decorateDocument / ajoute l\'URL de téléchargement', async t => {
  const document = {
    _id: new ObjectId(),
    nom_fichier: 'test.pdf',
    reference: 'REF-001',
    nature: 'Autorisation IOTA',
    objectKey: 'territoire/123/pqr678/test.pdf'
  }

  const decorated = await DocumentService.decorateDocument(document, {s3: mockS3})

  t.truthy(decorated.downloadUrl)
  t.is(decorated.nom_fichier, 'test.pdf')
  t.is(decorated._id, document._id)
  t.is(decorated.hasRegles, undefined)
  t.is(decorated.hasExploitations, undefined)
})

test.serial('decorateDocument / indique si le document a des règles', async t => {
  // Créer un document sans spécifier l'_id
  const document = await DocumentModel.insertDocument({
    preleveur: new ObjectId(),
    nom_fichier: 'avec_regles.pdf',
    reference: 'REF-001',
    nature: 'Autorisation IOTA',
    date_signature: '2024-01-01',
    date_ajout: '2024-01-01',
    taille: 1024,
    objectKey: 'territoire/123/test1/avec_regles.pdf'
  }, 'TEST-001')

  // Créer une règle liée
  const regle = await RegleModel.insertRegle({
    preleveur: new ObjectId(),
    exploitations: [new ObjectId()],
    parametre: 'volume prélevé',
    unite: 'm³',
    valeur: 100,
    contrainte: 'max',
    debut_validite: '2024-01-01',
    document: document._id
  }, 'TEST-001')

  // Vérifier que la règle est bien créée avec le bon documentId
  t.truthy(regle.document)
  t.deepEqual(regle.document, document._id)

  // Vérifier manuellement que documentHasRegles fonctionne
  const hasRegles = await RegleModel.documentHasRegles(document._id)
  t.is(hasRegles, true, 'documentHasRegles devrait retourner true')

  // Vérifier que document._id est bien défini
  t.truthy(document._id, 'document._id should be truthy')

  const decorated = await DocumentService.decorateDocument(document, {includeRelations: true, s3: mockS3})

  t.is(decorated.hasRegles, true)
  t.is(decorated.hasExploitations, false)
})

test.serial('decorateDocument / indique si le document a des exploitations', async t => {
  // Créer un document sans spécifier l'_id
  const document = await DocumentModel.insertDocument({
    preleveur: new ObjectId(),
    nom_fichier: 'avec_exploitations.pdf',
    reference: 'REF-001',
    nature: 'Autorisation IOTA',
    date_signature: '2024-01-01',
    date_ajout: '2024-01-01',
    taille: 512,
    objectKey: 'territoire/123/test2/avec_exploitations.pdf'
  }, 'TEST-001')

  // Créer une exploitation liée
  await ExploitationModel.insertExploitation({
    preleveur: new ObjectId(),
    point: new ObjectId(),
    usages: ['Agriculture'],
    statut: 'En activité',
    date_debut: '2024-01-01',
    documents: [document._id]
  }, 'TEST-001')

  const decorated = await DocumentService.decorateDocument(document, {includeRelations: true, s3: mockS3})

  t.is(decorated.hasRegles, false)
  t.is(decorated.hasExploitations, true)
})
