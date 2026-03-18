import {
  createPreleveur,
  decoratePreleveur,
  deletePreleveur,
  updatePreleveur
} from '../services/preleveur.js'

import {
  getDeclarantById,
  getDeclarantsByInstructor
} from '../models/declarant.js'

import {
  decoratePointPrelevement,
  getPointsFromDeclarant
} from '../services/point-prelevement.js'

import {
  getDeclarantExploitations,
  getPreleveurExploitationsViaPoints
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

// Liste des déclarants
export async function listDeclarants(req, res) {
  const declarants = await getDeclarantsByInstructor(req.user.id)
  res.send(declarants)
}

// Détail d'un déclarant
export async function getDeclarantDetail(req, res) {
  const declarant = await getDeclarantById(req.declarant.id)

  res.send(declarant)
}

// Création d'un préleveur
export async function createPreleveurHandler(req, res) {
  const preleveur = await createPreleveur(req.body)

  res.send(preleveur)
}

// Mise à jour d'un préleveur
export async function updatePreleveurHandler(req, res) {
  const preleveur = await updatePreleveur(req.declarant._id, req.body)

  res.send(preleveur)
}

// Suppression d'un préleveur
export async function deletePreleveurHandler(req, res) {
  const deletedPreleveur = await deletePreleveur(req.declarant._id)

  res.send(deletedPreleveur)
}

// Liste des points de prélèvement d'un préleveur
export async function getPreleveurPointsPrelevement(req, res) {
  const points = await getPointsFromDeclarant(req.declarant._id)
  const decoratedPoints = await Promise.all(points.map(p => decoratePointPrelevement(p)))

  res.send(decoratedPoints)
}

// Liste des exploitations d'un préleveur directement liés
export async function getPreleveurExploitationsHandler(req, res) {
  const exploitations = await getDeclarantExploitations(req.declarant._id)

  res.send(exploitations)
}

// Liste des exploitations d'un préleveur via les points de prélèvements
export async function getPreleveurExploitationsViaPointsHandler(req, res) {
  const exploitations = await getPreleveurExploitationsViaPoints(req.declarant._id)

  res.send(exploitations)
}

// Liste des règles d'un préleveur
export async function getPreleveurReglesHandler(req, res) {
  const regles = await getPreleveurRegles(req.declarant.id)
  const decoratedRegles = await Promise.all(regles.map(r => decorateRegle(r)))

  res.send(decoratedRegles)
}

// Création d'une règle pour un préleveur
export async function createPreleveurRegle(req, res) {
  const regle = await createRegle(req.body, req.declarant._id)
  const decoratedRegle = await decorateRegle(regle)

  res.send(decoratedRegle)
}

// Liste des documents d'un préleveur
export async function getPreleveurDocumentsHandler(req, res) {
  const documents = await getPreleveurDocuments(req.declarant._id)
  const decoratedDocuments = await Promise.all(documents.map(d => decorateDocument(d, {includeRelations: true})))

  res.send(decoratedDocuments)
}

// Création d'un document pour un préleveur
export async function createPreleveurDocument(req, res) {
  const document = await createDocument({
    payload: req.body,
    file: req.file,
    preleveurSeqId: req.declarant.id_preleveur,
    preleveurObjectId: req.declarant._id
  })

  const decoratedDocument = await decorateDocument(document)
  res.send(decoratedDocument)
}
