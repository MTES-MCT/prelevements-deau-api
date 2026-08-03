import createHttpError from 'http-errors'
import Joi from 'joi'

import {prisma} from '../../db/prisma.js'

import {
  createPreleveur,
  deletePreleveur,
  updatePreleveur
} from '../services/preleveur.js'

import {
  getCollecteurPreleveurs,
  getDeclarantById,
  getDeclarants,
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
import {decorateExploitation} from '../services/exploitation.js'

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
import {
  getPermissionZoneIdsForUser,
  hasZonePermission
} from '../services/zone-permissions.js'

const declarantZonesSchema = Joi.object({
  zoneIds: Joi.array()
    .items(Joi.string().guid({version: 'uuidv4'}))
    .min(1)
    .unique()
    .required()
})

function extractNotificationOptions(payload) {
  const {notifyAccountCreation, zoneIds, ...data} = payload || {}

  return {
    shouldNotifyAccountCreation: notifyAccountCreation === true,
    zoneIds,
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

// Liste des préleveurs accessibles par le collecteur connecté
export async function getCollecteurPreleveursHandler(req, res) {
  if (req.user?.declarant?.declarantRole !== 'COLLECTEUR') {
    throw createHttpError(403, 'Cette liste est réservée aux collecteurs.')
  }

  const preleveurs = await getCollecteurPreleveurs(req.user.id)
  const decoratedPreleveurs = await Promise.all(preleveurs.map(d => decorateDeclarantRight(d, req.user)))

  res.send(decoratedPreleveurs)
}

// Détail d'un déclarant
export async function getDeclarantDetail(req, res) {
  const declarant = await getDeclarantById(req.declarant.id)
  const decoratedDeclarant = await decorateDeclarantRight(declarant, req.user)

  if (req.user.role === 'INSTRUCTOR' && !decoratedDeclarant.right.permissions.includes('exploitation.list')) {
    decoratedDeclarant.pointPrelevements = []
    decoratedDeclarant.collecteurExploitations = []
  }

  if (req.user.role === 'INSTRUCTOR' && !decoratedDeclarant.right.permissions.includes('declarant.email-alias.read')) {
    decoratedDeclarant.emailAliases = []
    if (decoratedDeclarant.user) {
      decoratedDeclarant.user.emailAliases = []
    }
  }

  res.send(decoratedDeclarant)
}

export async function getDeclarantZonesHandler(req, res) {
  const declarant = await getDeclarantById(req.declarant.id)

  res.send({
    items: (declarant.zones ?? []).map(link => ({
      id: link.id,
      zoneId: link.zoneId,
      zone: link.zone,
      source: link.source,
      createdAt: link.createdAt,
      updatedAt: link.updatedAt
    }))
  })
}

export async function updateDeclarantZonesHandler(req, res) {
  const {error, value} = declarantZonesSchema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true
  })

  if (error) {
    throw createHttpError(400, 'Sélectionnez au moins une zone valide.')
  }

  const currentLinks = await prisma.declarantZone.findMany({
    where: {declarantUserId: req.declarant.id},
    select: {zoneId: true}
  })
  const currentZoneIds = currentLinks.map(link => link.zoneId)
  const current = new Set(currentZoneIds)
  const next = new Set(value.zoneIds)
  const changedZoneIds = [...new Set([
    ...currentZoneIds.filter(zoneId => !next.has(zoneId)),
    ...value.zoneIds.filter(zoneId => !current.has(zoneId))
  ])]

  if (changedZoneIds.length > 0 && req.user.role !== 'ADMIN') {
    const permittedZoneIds = await getPermissionZoneIdsForUser(
      req.user,
      'declarant.zone.update',
      {zoneIds: changedZoneIds}
    )

    if (permittedZoneIds.length !== changedZoneIds.length) {
      throw createHttpError(403, 'Vous ne pouvez modifier que les rattachements des zones où ce droit vous est attribué.')
    }
  }

  const existingZonesCount = await prisma.zone.count({
    where: {id: {in: value.zoneIds}}
  })
  if (existingZonesCount !== value.zoneIds.length) {
    throw createHttpError(400, 'Une ou plusieurs zones sont introuvables.')
  }

  await prisma.$transaction(async tx => {
    await tx.declarantZone.deleteMany({
      where: {
        declarantUserId: req.declarant.id,
        zoneId: {notIn: value.zoneIds}
      }
    })
    await tx.declarantZone.createMany({
      data: value.zoneIds.map(zoneId => ({
        declarantUserId: req.declarant.id,
        zoneId,
        source: 'MANUAL',
        createdByUserId: req.user.id
      })),
      skipDuplicates: true
    })
  })

  const declarant = await getDeclarantById(req.declarant.id)
  res.send(await decorateDeclarantRight(declarant, req.user))
}

// Création d'un déclarant
export async function createPreleveurHandler(req, res) {
  const {data, shouldNotifyAccountCreation} = extractNotificationOptions(req.body)

  if (shouldNotifyAccountCreation && !await hasZonePermission(
    req.user,
    'declarant.invite',
    req.declarantZoneIds
  )) {
    throw createHttpError(403, 'Vous ne disposez pas du droit d’envoyer l’email de création de compte.')
  }

  let preleveur = await createPreleveur(data, {
    zoneIds: req.declarantZoneIds,
    createdByUserId: req.user.id
  })

  if (shouldNotifyAccountCreation) {
    preleveur = await sendDeclarantAccountCreationNotification(preleveur.userId || preleveur.id)
  }

  res.send(preleveur)
}

// Mise à jour d'un déclarant
export async function updatePreleveurHandler(req, res) {
  const {data} = extractNotificationOptions(req.body)
  const preleveur = Object.keys(data).length > 0
    ? await updatePreleveur(req.declarant.id, data)
    : await getDeclarantById(req.declarant.id)

  res.send(preleveur)
}

export async function sendDeclarantAccountCreationNotificationHandler(req, res) {
  res.send(await sendDeclarantAccountCreationNotification(req.declarant.id))
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

  res.send(await Promise.all(
    exploitations.map(exploitation => decorateExploitation(exploitation, {user: req.user}))
  ))
}

// Liste des exploitations d'un déclarant via les points de prélèvements
export async function getPreleveurExploitationsViaPointsHandler(req, res) {
  const exploitations = await getPreleveurExploitationsViaPoints(req.declarant.id)

  res.send(await Promise.all(
    exploitations.map(exploitation => decorateExploitation(exploitation, {user: req.user}))
  ))
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
