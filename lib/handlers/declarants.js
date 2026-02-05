import {
  createPreleveur,
  decoratePreleveur,
  deletePreleveur,
  updatePreleveur
} from '../services/preleveur.js'

import {
  getDeclarants
} from '../models/declarant.js'

import {
  decoratePointPrelevement,
  getPointsFromPreleveur
} from '../services/point-prelevement.js'

import {
  getDeclarantExploitations
} from '../models/exploitation.js'

import {
  getPreleveurRegles
} from '../models/regle.js'

import {
  createRegle,
  decorateRegle
} from '../services/regle.js'

import {
  getPreleveurDocuments
} from '../models/document.js'

import {
  createDocument,
  decorateDocument
} from '../services/document.js'

// Liste des préleveurs
export async function listPreleveurs(req, res) {
  const preleveurs = await getDeclarants()
  const decoratedPreleveurs = await Promise.all(preleveurs.map(p => decoratePreleveur(p)))

  res.send(decoratedPreleveurs)
}

// Création d'un préleveur
export async function createPreleveurHandler(req, res) {
  const preleveur = await createPreleveur(req.body)

  res.send(preleveur)
}

// Détail d'un préleveur
export async function getPreleveurDetail(req, res) {
  const decoratedPreleveur = await decoratePreleveur(req.preleveur)

  res.send(decoratedPreleveur)
}

// Mise à jour d'un préleveur
export async function updatePreleveurHandler(req, res) {
  const preleveur = await updatePreleveur(req.preleveur._id, req.body)

  res.send(preleveur)
}

// Suppression d'un préleveur
export async function deletePreleveurHandler(req, res) {
  const deletedPreleveur = await deletePreleveur(req.preleveur._id)

  res.send(deletedPreleveur)
}

// Liste des points de prélèvement d'un préleveur
export async function getPreleveurPointsPrelevement(req, res) {
  const points = await getPointsFromPreleveur(req.preleveur._id)
  const decoratedPoints = await Promise.all(points.map(p => decoratePointPrelevement(p)))

  res.send(decoratedPoints)
}

// Liste des exploitations d'un préleveur
export async function getPreleveurExploitationsHandler(req, res) {
  const exploitations = await getDeclarantExploitations(req.preleveur._id)

  res.send(exploitations)
}

// Liste des règles d'un préleveur
export async function getPreleveurReglesHandler(req, res) {
  const regles = await getPreleveurRegles(req.preleveur._id)
  const decoratedRegles = await Promise.all(regles.map(r => decorateRegle(r)))

  res.send(decoratedRegles)
}

// Création d'une règle pour un préleveur
export async function createPreleveurRegle(req, res) {
  const regle = await createRegle(req.body, req.preleveur._id)
  const decoratedRegle = await decorateRegle(regle)

  res.send(decoratedRegle)
}

// Liste des documents d'un préleveur
export async function getPreleveurDocumentsHandler(req, res) {
  const documents = await getPreleveurDocuments(req.preleveur._id)
  const decoratedDocuments = await Promise.all(documents.map(d => decorateDocument(d, {includeRelations: true})))

  res.send(decoratedDocuments)
}

// Création d'un document pour un préleveur
export async function createPreleveurDocument(req, res) {
  const document = await createDocument({
    payload: req.body,
    file: req.file,
    preleveurSeqId: req.preleveur.id_preleveur,
    preleveurObjectId: req.preleveur._id
  })

  const decoratedDocument = await decorateDocument(document)
  res.send(decoratedDocument)
}
