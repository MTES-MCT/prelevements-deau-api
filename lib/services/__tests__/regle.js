import test from 'ava'
import {ObjectId} from 'mongodb'
import {setupTestMongo, cleanupCollections} from '../../util/test-helpers/mongo.js'
import * as RegleService from '../regle.js'
import * as PreleveurModel from '../../models/declarant.js'
import * as DocumentModel from '../../models/document.js'
import * as ExploitationModel from '../../models/exploitation.js'
import * as RegleModel from '../../models/regle.js'

setupTestMongo(test)
cleanupCollections(test, ['regles', 'preleveurs', 'documents', 'exploitations', 'sequences'])

test.serial('createRegle / crée une règle valide', async t => {
  // Créer un préleveur
  const preleveur = await PreleveurModel.insertDeclarant('TEST-001', {
    nom: 'Préleveur Test',
    statut: 'En activité'
  })

  // Créer une exploitation
  const exploitation = await ExploitationModel.insertExploitation({
    preleveur: preleveur._id,
    point: new ObjectId(),
    usage: 'Irrigation',
    statut: 'En activité',
    date_debut: '2024-01-01'
  }, 'TEST-001')

  const payload = {
    exploitations: [exploitation._id.toString()],
    parametre: 'volume prélevé',
    unite: 'm³',
    frequence: '1 month',
    valeur: 100,
    contrainte: 'max',
    debut_validite: '2024-01-01'
  }

  const regle = await RegleService.createRegle(payload, preleveur._id, 'TEST-001')

  t.truthy(regle._id)
  t.deepEqual(regle.preleveur, preleveur._id)
  t.is(regle.parametre, 'volume prélevé')
  t.is(regle.valeur, 100)
  t.is(regle.exploitations.length, 1)
})

test.serial('createRegle / lance une erreur si préleveur introuvable', async t => {
  const payload = {
    exploitations: [new ObjectId().toString()],
    parametre: 'volume prélevé',
    unite: 'm³',
    valeur: 100,
    contrainte: 'max',
    debut_validite: '2024-01-01',
    frequence: '1 month'
  }

  await t.throwsAsync(
    async () => RegleService.createRegle(payload, new ObjectId(), 'TEST-001'),
    {message: /préleveur est introuvable/}
  )
})

test.serial('createRegle / lance une erreur si exploitation introuvable', async t => {
  const preleveur = await PreleveurModel.insertDeclarant('TEST-001', {
    nom: 'Préleveur Test',
    statut: 'En activité'
  })

  const payload = {
    exploitations: [new ObjectId().toString()],
    parametre: 'volume prélevé',
    unite: 'm³',
    valeur: 100,
    contrainte: 'max',
    debut_validite: '2024-01-01',
    frequence: '1 month'
  }

  await t.throwsAsync(
    async () => RegleService.createRegle(payload, preleveur._id, 'TEST-001'),
    {message: /exploitation.*introuvable/}
  )
})

test.serial('createRegle / crée une règle avec document', async t => {
  const preleveur = await PreleveurModel.insertDeclarant('TEST-001', {
    nom: 'Préleveur Test',
    statut: 'En activité'
  })

  const document = await DocumentModel.insertDocument({
    preleveur: preleveur._id,
    nom_fichier: 'test.pdf',
    reference: 'REF-001',
    nature: 'Arrêté préfectoral',
    date_signature: '2024-01-01',
    date_ajout: '2024-01-01',
    taille: 1024,
    objectKey: 'territoire/123/abc123/test.pdf'
  })

  const exploitation = await ExploitationModel.insertExploitation({
    preleveur: preleveur._id,
    point: new ObjectId(),
    usage: 'Irrigation',
    statut: 'En activité',
    date_debut: '2024-01-01'
  })

  const payload = {
    document: document._id.toString(),
    exploitations: [exploitation._id.toString()],
    parametre: 'volume prélevé',
    unite: 'm³',
    valeur: 100,
    contrainte: 'max',
    debut_validite: '2024-01-01',
    frequence: '1 month'
  }

  const regle = await RegleService.createRegle(payload, preleveur._id, 'TEST-001')

  t.truthy(regle.document)
  t.deepEqual(regle.document, document._id)
})

test.serial('createRegle / lance une erreur si document introuvable', async t => {
  const preleveur = await PreleveurModel.insertDeclarant('TEST-001', {
    nom: 'Préleveur Test',
    statut: 'En activité'
  })

  const exploitation = await ExploitationModel.insertExploitation({
    preleveur: preleveur._id,
    point: new ObjectId(),
    usage: 'Irrigation',
    statut: 'En activité',
    date_debut: '2024-01-01'
  })

  const payload = {
    document: new ObjectId().toString(),
    exploitations: [exploitation._id.toString()],
    parametre: 'volume prélevé',
    unite: 'm³',
    valeur: 100,
    contrainte: 'max',
    debut_validite: '2024-01-01',
    frequence: '1 month'
  }

  await t.throwsAsync(
    async () => RegleService.createRegle(payload, preleveur._id, 'TEST-001'),
    {message: /document est introuvable/}
  )
})

test.serial('updateRegle / met à jour une règle', async t => {
  const preleveur = await PreleveurModel.insertDeclarant('TEST-001', {
    nom: 'Préleveur Test',
    statut: 'En activité'
  })

  const exploitation = await ExploitationModel.insertExploitation({
    preleveur: preleveur._id,
    point: new ObjectId(),
    usage: 'Irrigation',
    statut: 'En activité',
    date_debut: '2024-01-01'
  }, 'TEST-001')

  const regle = await RegleModel.insertRegle({
    preleveur: preleveur._id,
    exploitations: [exploitation._id],
    parametre: 'volume prélevé',
    unite: 'm³',
    valeur: 100,
    contrainte: 'max',
    debut_validite: '2024-01-01',
    frequence: '1 month'
  }, 'TEST-001')

  const updated = await RegleService.updateRegle(regle._id, {
    valeur: 200,
    remarque: 'Mise à jour'
  })

  t.is(updated.valeur, 200)
  t.is(updated.remarque, 'Mise à jour')
  t.is(updated.parametre, 'volume prélevé') // Inchangé
})

test.serial('updateRegle / lance une erreur si aucun champ valide', async t => {
  const regle = await RegleModel.insertRegle({
    preleveur: new ObjectId(),
    exploitations: [new ObjectId()],
    parametre: 'volume prélevé',
    unite: 'm³',
    valeur: 100,
    contrainte: 'max',
    debut_validite: '2024-01-01',
    frequence: '1 month'
  }, 'TEST-001')

  await t.throwsAsync(
    async () => RegleService.updateRegle(regle._id, {}),
    {message: /Aucun champ valide/}
  )
})

test.serial('deleteRegle / supprime une règle', async t => {
  const regle = await RegleModel.insertRegle({
    preleveur: new ObjectId(),
    exploitations: [new ObjectId()],
    parametre: 'volume prélevé',
    unite: 'm³',
    valeur: 100,
    contrainte: 'max',
    debut_validite: '2024-01-01',
    frequence: '1 month'
  }, 'TEST-001')

  const deleted = await RegleService.deleteRegle(regle._id)

  t.truthy(deleted)
  t.truthy(deleted.deletedAt)
})

test.serial('deleteRegle / lance une erreur si règle introuvable', async t => {
  await t.throwsAsync(
    async () => RegleService.deleteRegle(new ObjectId()),
    {message: /règle est introuvable/}
  )
})
