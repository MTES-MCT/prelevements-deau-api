import process from 'node:process'

import {Router} from 'express'
import createHttpError from 'http-errors'
import {eachDayOfInterval} from 'date-fns'
import {ObjectId} from 'mongodb'
import multer from 'multer'

import {getAttachmentObjectKey} from '@fabnum/demarches-simplifiees'

import mongo from './util/mongo.js'
import w from './util/w.js'
import s3 from './util/s3.js'

import * as Dossier from './models/dossier.js'

import {
  decoratePointPrelevement,
  getPointPrelevement,
  getPointsFromPreleveur,
  getStats,
  createPointPrelevement,
  updatePointPrelevement,
  deletePointPrelevement,
  getPointsPrelevementFromTerritoire
} from './models/points-prelevement.js'

import {
  getPreleveur,
  getPreleveurByObjectId,
  decoratePreleveur,
  createPreleveur,
  updatePreleveur,
  deletePreleveur,
  getPreleveursFromTerritoire,
  getPreleveurDocuments
} from './models/preleveur.js'

import {
  getDocument,
  uploadDocument,
  createDocument,
  deleteDocument
} from './models/documents.js'

import {
  getExploitationsFromPointId,
  getExploitation,
  createExploitation,
  updateExploitation,
  deleteExploitation
} from './models/exploitation.js'

import {
  getVolumesPreleves
} from './models/volume-preleve.js'
import {
  checkPermissionOnExploitation,
  checkPermissionOnPoint,
  checkPermissionOnPreleveur,
  checkPermissionOnTerritoire,
  ensureIsAdmin
} from './auth/middleware.js'

import {
  getBnpe,
  getBnpeList,
  getBss,
  getBssList,
  getBvBdcarthage,
  getBvBdcarthageList,
  getMeContinentalesBv,
  getMeContinentalesBvList,
  getMeso,
  getMesoList
} from './models/referentiels.js'

const demarcheNumber = Number.parseInt(process.env.DS_DEMARCHE_NUMBER, 10)

const storage = multer.memoryStorage()
const upload = multer({
  storage,
  limits: {
    fileSize: 10_000_000
  }
})

export const handleDossier = w(async (req, res, next) => {
  const dossierId = mongo.parseObjectId(req.params.dossierId)
  req.dossier = await Dossier.getDossier(dossierId)

  if (!req.dossier) {
    throw createHttpError(404, 'Dossier not found')
  }

  next()
})

async function getTerritoireByToken(token) {
  const territoire = await mongo.db.collection('tokens').findOne({token})

  return territoire
}

async function createRoutes() {
  const app = new Router()

  // Authenticate user / runner
  app.use(w(async (req, res, next) => {
    if (!req.get('Authorization')) {
      return next()
    }

    const token = req.get('Authorization').split(' ')[1]
    const codeTerritoire = await getTerritoireByToken(token)

    if (!codeTerritoire) {
      return next(createHttpError(401, 'Unauthorized'))
    }

    req.isAdmin = true
    req.territoire = codeTerritoire.territoire

    next()
  }))

  /* Resolvers */

  app.param('dossierId', handleDossier)
  app.param('pointId', w(async (req, res, next) => {
    req.point = await getPointPrelevement(req.params.pointId)

    if (!req.point) {
      throw createHttpError(404, 'Ce point de prélèvement est introuvable.')
    }

    next()
  }))
  app.param('preleveurId', w(async (req, res, next) => {
    req.preleveur = await getPreleveur(req.params.preleveurId)

    if (req.preleveur) {
      return next()
    }

    // Second chance: maybe it's an ObjectId?

    let preleveurId

    try {
      preleveurId = ObjectId.createFromHexString(req.params.preleveurId)
    } catch {}

    if (preleveurId) {
      req.preleveur = await getPreleveurByObjectId(preleveurId)
    }

    if (req.preleveur) {
      return next()
    }

    throw createHttpError(404, 'Ce préleveur est introuvable.')
  }))
  app.param('exploitationId', w(async (req, res, next) => {
    req.exploitation = await getExploitation(req.params.exploitationId)

    if (!req.exploitation) {
      throw createHttpError(404, 'Cette exploitation est introuvable.')
    }

    next()
  }))
  app.param('documentId', w(async (req, res, next) => {
    req.document = await getDocument(req.params.documentId)

    if (!req.document) {
      throw createHttpError(404, 'Ce document est introuvable.')
    }

    next()
  }))

  app.get('/info', w(async (req, res) => {
    if (!req.isAdmin) {
      throw createHttpError(403, 'Vous n’êtes pas autorisé à accéder à cette ressource')
    }

    res.send({
      isAdmin: true,
      territoire: req.territoire
    })
  }))

  /* Dossiers */

  app.get('/dossiers', w(async (req, res) => {
    const dossiers = await Dossier.getDossiers(demarcheNumber)
    res.send(dossiers)
  }))

  app.get('/dossiers/:dossierId', w(async (req, res) => {
    const attachments = await Dossier.getAttachmentsSummary(req.dossier.demarcheNumber, req.dossier.number)
    res.send({
      ...req.dossier,
      files: attachments
    })
  }))

  app.param('storageHash', async (req, res, next) => {
    req.attachment = await Dossier.getAttachmentByStorageHash(
      req.dossier.demarcheNumber,
      req.dossier.number,
      req.params.storageHash
    )

    if (!req.attachment) {
      throw createHttpError(404, 'File not found')
    }

    next()
  })

  app.get('/dossiers/:dossierId/files/:storageHash', w(async (req, res) => {
    const attachment = await Dossier.getAttachmentByStorageKey(
      req.dossier.demarcheNumber,
      req.dossier.number,
      req.attachment.storageKey,
      true
    )

    res.send(attachment)
  }))

  app.get('/dossiers/:dossierId/files/:storageHash/download', w(async (req, res) => {
    const objectKey = getAttachmentObjectKey(
      req.dossier.demarcheNumber,
      req.dossier.number,
      req.attachment.storageKey
    )

    const buffer = await s3('ds').downloadObject(objectKey)
    res.send(buffer)
  }))

  /* Points */

  app.route('/points-prelevement')
    .get(w(ensureIsAdmin), w(async (req, res) => {
      const prelevements = await getPointsPrelevementFromTerritoire(req.territoire)
      const decoratedPoints = await Promise.all(prelevements.map(p => decoratePointPrelevement(p)))

      res.send(decoratedPoints)
    }))
    .post(w(ensureIsAdmin), w(async (req, res) => {
      const point = await createPointPrelevement(req.body, req.territoire)
      const decoratedPoint = await decoratePointPrelevement(point)

      res.send(decoratedPoint)
    }))

  app.route('/points-prelevement/:pointId')
    .get(w(checkPermissionOnPoint), w(async (req, res) => {
      const decoratedPoint = await decoratePointPrelevement(req.point)

      res.send(decoratedPoint)
    }))
    .put(w(checkPermissionOnPoint), w(async (req, res) => {
      const point = await updatePointPrelevement(req.params.pointId, req.body)

      res.send(point)
    }))
    .delete(w(checkPermissionOnPoint), w(async (req, res) => {
      const deletedPoint = await deletePointPrelevement(req.params.pointId)

      if (!deletedPoint) {
        throw createHttpError(404, 'Ce point de prélèvement est introuvable.')
      }

      res.send(deletedPoint)
    }))

  app.get('/points-prelevement/:pointId/exploitations', w(checkPermissionOnPoint), w(async (req, res) => {
    const exploitations = await getExploitationsFromPointId(req.params.pointId)

    res.send(exploitations)
  }))

  /* Exploitations */

  app.route('/exploitations')
    .post(w(ensureIsAdmin), w(async (req, res) => {
      const exploitation = await createExploitation(req.body, req.territoire)

      res.send(exploitation)
    }))

  app.route('/exploitations/:exploitationId')
    .get(w(checkPermissionOnExploitation), w(async (req, res) => {
      res.send(req.exploitation)
    }))
    .put(w(checkPermissionOnExploitation), w(async (req, res) => {
      const exploitation = await updateExploitation(req.params.exploitationId, req.body)

      res.send(exploitation)
    }))
    .delete(w(ensureIsAdmin), w(async (req, res) => {
      const deletedExploitation = await deleteExploitation(req.params.exploitationId, req.territoire)

      res.send(deletedExploitation)
    }))

  app.get('/exploitations/:exploitationId/volumes-preleves', w(checkPermissionOnExploitation), w(async (req, res) => {
    const volumesPreleves = await getVolumesPreleves(req.params.exploitationId)

    const exploitation = await mongo.db.collection('exploitations').findOne(
      {id_exploitation: req.params.exploitationId}
    )

    if (!exploitation) {
      throw createHttpError(404, 'Cette exploitation est introuvable.')
    }

    const {regles} = exploitation
    const regleVolumeJournalier = regles.find(r => r.parametre === 'Volume journalier')

    const dateDebut = volumesPreleves.at(-1)?.date
    const dateFin = volumesPreleves[0]?.date
    const volumeJournalierMax = regleVolumeJournalier?.valeur

    const result = {
      dateDebut,
      dateFin,
      volumeJournalierMax,
      valeurs: volumesPreleves
    }

    if (dateDebut && dateFin) {
      result.nbValeursAttendues = eachDayOfInterval({
        start: new Date(dateDebut), end: new Date(dateFin)
      }).length
    }

    result.nbValeursRenseignees = volumesPreleves.filter(v => v.volume !== null).length

    if (volumeJournalierMax) {
      result.valeurs = volumesPreleves.map(v => ({
        ...v,
        depassement: v.volume > volumeJournalierMax
      }))

      result.nbDepassements = result.valeurs.filter(v => v.depassement).length
    }

    res.send(result)
  }))

  /* Préleveurs */

  app.route('/preleveurs')
    .get(w(ensureIsAdmin), w(async (req, res) => {
      const preleveurs = await getPreleveursFromTerritoire(req.territoire)
      const decoratedPreleveurs = await Promise.all(preleveurs.map(b => decoratePreleveur(b)))

      res.send(decoratedPreleveurs)
    }))
    .post(w(ensureIsAdmin), w(async (req, res) => {
      const preleveur = await createPreleveur(req.body, req.territoire)

      res.send(preleveur)
    }))

  app.route('/preleveurs/:preleveurId')
    .get(w(checkPermissionOnPreleveur), w(async (req, res) => {
      const decoratedPreleveur = await decoratePreleveur(req.preleveur)

      res.send(decoratedPreleveur)
    }))
    .put(w(checkPermissionOnPreleveur), w(async (req, res) => {
      const preleveur = await updatePreleveur(req.params.preleveurId, req.body)

      res.send(preleveur)
    }))
    .delete(w(checkPermissionOnPreleveur), w(async (req, res) => {
      const deletedPreleveur = await deletePreleveur(req.params.preleveurId)

      res.send(deletedPreleveur)
    }))

  app.get('/preleveurs/:preleveurId/points-prelevement', w(checkPermissionOnPreleveur), w(async (req, res) => {
    const points = await getPointsFromPreleveur(req.params.preleveurId)

    res.send(points)
  }))

  app.route('/preleveurs/:preleveurId/documents')
    .get(w(checkPermissionOnPreleveur), w(async (req, res) => {
      const documents = await getPreleveurDocuments(req.params.preleveurId)

      res.send(documents)
    }))
    .post(w(checkPermissionOnPreleveur), w(async (req, res) => {
      const document = await createDocument(req.body, req.params.preleveurId, req.territoire)

      res.send(document)
    }))
  app.route('/preleveurs/:preleveurId/documents/:documentId')
    .delete(w(checkPermissionOnPreleveur), w(async (req, res) => {
      const deletedDocument = await deleteDocument(req.params.documentId)

      res.send(deletedDocument)
    }))
  app.route('/preleveurs/:preleveurId/documents/upload')
    .post(w(checkPermissionOnPreleveur), upload.single('document'), w(async (req, res) => {
      const {file} = req
      const documentInfos = await uploadDocument(file)

      res.send(documentInfos)
    }))

  /* Territoires */

  app.get('/territoires/:codeTerritoire/points-prelevement', w(checkPermissionOnTerritoire), w(async (req, res) => {
    const points = await getPointsPrelevementFromTerritoire(req.params.codeTerritoire)

    res.send(points)
  }))

  app.get('/territoires/:codeTerritoire/preleveurs', w(checkPermissionOnTerritoire), w(async (req, res) => {
    const preleveurs = await getPreleveursFromTerritoire(req.params.codeTerritoire)

    res.send(preleveurs)
  }))

  /* Référentiels */

  app.get('/referentiels/bss', w(async (req, res) => {
    const bssList = await getBssList()

    res.send(bssList)
  }))

  app.get('/referentiels/bss/:idBss', w(async (req, res) => {
    const bss = await getBss(req.params.idBss)

    res.send(bss)
  }))

  app.get('/referentiels/bnpe', w(async (req, res) => {
    const bnpeList = await getBnpeList()

    res.send(bnpeList)
  }))

  app.get('/referentiels/bnpe/:idBnpe', w(async (req, res) => {
    const bnpe = await getBnpe(req.params.idBnpe)

    res.send(bnpe)
  }))

  app.get('/referentiels/me-continentales-bv', w(async (req, res) => {
    const meContinentalesBvList = await getMeContinentalesBvList()

    res.send(meContinentalesBvList)
  }))

  app.get('/referentiels/me-continentales-bv/:idMeContinentalesBv', w(async (req, res) => {
    const meContinentalesBv = await getMeContinentalesBv(req.params.idMeContinentalesBv)

    res.send(meContinentalesBv)
  }))

  app.get('/referentiels/bv-bdcarthage', w(async (req, res) => {
    const bvBdCarthageList = await getBvBdcarthageList()

    res.send(bvBdCarthageList)
  }))

  app.get('/referentiels/bv-bdcarthage/:idBvBdcarthage', w(async (req, res) => {
    const bvBdCarthage = await getBvBdcarthage(req.params.idBvBdcarthage)

    res.send(bvBdCarthage)
  }))

  app.get('/referentiels/meso', w(async (req, res) => {
    const mesoList = await getMesoList()

    res.send(mesoList)
  }))

  app.get('/referentiels/meso/:idMeso', w(async (req, res) => {
    const meso = await getMeso(req.params.idMeso)

    res.send(meso)
  }))

  /* Statistiques */

  app.get('/stats', w(async (req, res) => {
    const stats = await getStats()

    res.send(stats)
  }))

  return app
}

const routes = await createRoutes()
export default routes
