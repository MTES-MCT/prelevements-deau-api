import createHttpError from 'http-errors'
import process from 'node:process'

import {
  createPreleveur,
  deletePreleveur,
  updatePreleveur
} from '../services/preleveur.js'

import {
  getDeclarantById,
  getDeclarants,
  getDeclarantsByInstructor,
  updateLastReminderSentAt
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
import {decorateDeclarantRight} from '../services/resource-permissions.js'

import {
  getPreleveurDocuments
} from '../models/document.js'

import {
  createDocument,
  decorateDocument
} from '../services/document.js'
import {sendAccountCreationNotification} from '../services/account-notifications.js'
import {renderDeclarationReminderEmail} from '../util/email-templates.js'
import {sendEmail} from '../util/email.js'

const FRONT_URL = process.env.FRONT_URL || 'http://localhost:3000'

function extractNotificationOptions(payload) {
  const {notifyAccountCreation, ...data} = payload || {}

  return {
    shouldNotifyAccountCreation: notifyAccountCreation === true,
    data
  }
}

async function sendDeclarantAccountCreationNotification(declarantId) {
  const declarant = await getDeclarantById(declarantId)

  if (!declarant?.user) {
    throw createHttpError(404, 'Ce déclarant est introuvable.')
  }

  await sendAccountCreationNotification(declarant.user, {role: 'DECLARANT'})

  return getDeclarantById(declarantId)
}

// Liste des déclarants
export async function listDeclarants(req, res) {
  const declarants = req.user.role === 'ADMIN'
    ? await getDeclarants()
    : await getDeclarantsByInstructor(req.user.id)

  const decoratedDeclarants = await Promise.all(declarants.map(d => decorateDeclarantRight(d, req.user)))
  res.send(decoratedDeclarants)
}

// Détail d'un déclarant
export async function getDeclarantDetail(req, res) {
  const declarant = await getDeclarantById(req.declarant.id)

  res.send(await decorateDeclarantRight(declarant, req.user))
}

export async function sendDeclarationReminderHandler(req, res) {
  const declarant = await getDeclarantById(req.declarant.id)

  const html = renderDeclarationReminderEmail(declarant.user, FRONT_URL)
  await sendEmail(declarant.user.email, 'Partageons l\'Eau - Suivi de déclaration', html)

  await updateLastReminderSentAt(req.declarant.id)

  res.send(await getDeclarantById(req.declarant.id))
}

// Création d'un déclarant
export async function createPreleveurHandler(req, res) {
  const {data, shouldNotifyAccountCreation} = extractNotificationOptions(req.body)
  let preleveur = await createPreleveur(data)

  if (shouldNotifyAccountCreation) {
    preleveur = await sendDeclarantAccountCreationNotification(preleveur.userId || preleveur.id)
  }

  res.send(preleveur)
}

// Mise à jour d'un déclarant
export async function updatePreleveurHandler(req, res) {
  const {data, shouldNotifyAccountCreation} = extractNotificationOptions(req.body)
  let preleveur = Object.keys(data).length > 0
    ? await updatePreleveur(req.declarant.id, data)
    : await getDeclarantById(req.declarant.id)

  if (shouldNotifyAccountCreation) {
    preleveur = await sendDeclarantAccountCreationNotification(req.declarant.id)
  }

  res.send(preleveur)
}

// Suppression d'un déclarant
export async function deletePreleveurHandler(req, res) {
  const deletedPreleveur = await deletePreleveur(req.declarant.id)

  res.send(deletedPreleveur)
}

// Liste des points de prélèvement d'un déclarant
export async function getPreleveurPointsPrelevement(req, res) {
  const points = await getPointsFromDeclarant(req.declarant.id)
  const decoratedPoints = await Promise.all(points.map(p => decoratePointPrelevement(p, {user: req.user})))

  res.send(decoratedPoints)
}

// Liste des exploitations d'un déclarant directement liées
export async function getPreleveurExploitationsHandler(req, res) {
  const exploitations = await getDeclarantExploitations(req.declarant.id)

  res.send(exploitations)
}

// Liste des exploitations d'un déclarant via les points de prélèvements
export async function getPreleveurExploitationsViaPointsHandler(req, res) {
  const exploitations = await getPreleveurExploitationsViaPoints(req.declarant.id)

  res.send(exploitations)
}

// Liste des règles d'un déclarant
export async function getPreleveurReglesHandler(req, res) {
  const regles = await getPreleveurRegles(req.declarant.id)
  const decoratedRegles = await Promise.all(regles.map(r => decorateRegle(r)))

  res.send(decoratedRegles)
}

// Création d'une règle pour un déclarant
export async function createPreleveurRegle(req, res) {
  const regle = await createRegle(req.body, req.declarant.id)
  const decoratedRegle = await decorateRegle(regle)

  res.send(decoratedRegle)
}

// Liste des documents d'un déclarant
export async function getPreleveurDocumentsHandler(req, res) {
  const documents = await getPreleveurDocuments(req.declarant.id)
  const decoratedDocuments = await Promise.all(documents.map(d => decorateDocument(d, {includeRelations: true})))

  res.send(decoratedDocuments)
}

// Création d'un document pour un déclarant
export async function createPreleveurDocument(req, res) {
  const document = await createDocument({
    payload: req.body,
    file: req.file,
    declarantUserId: req.declarant.id
  })

  const decoratedDocument = await decorateDocument(document)
  res.send(decoratedDocument)
}
