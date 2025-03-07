import process from 'node:process'
import {Router} from 'express'
import createHttpError from 'http-errors'
import {eachDayOfInterval} from 'date-fns'

import mongo from './util/mongo.js'
import w from './util/w.js'
import {downloadFile} from './util/s3.js'

import * as Dossier from './models/dossier.js'

import {
  getPointsPrelevement,
  getPointPrelevement,
  getPointsFromBeneficiaire,
  getBssById,
  getBnpe,
  getCommune
} from './models/points-prelevement.js'

import {
  getBeneficiaire,
  getBeneficiaires,
  getBeneficiairesFromPointId
} from './models/beneficiaire.js'

import {
  getExploitationsFromPointId,
  getDocumentFromExploitationId,
  getReglesFromExploitationId,
  getRegle,
  getDocument,
  getDocumentFromRegleId,
  getExploitation,
  getModalitesFromExploitationId
} from './models/exploitation.js'

import {
  getVolumesPreleves
} from './models/volume-preleve.js'

export const handleDossier = w(async (req, res, next) => {
  const dossierId = mongo.parseObjectId(req.params.dossierId)
  req.dossier = await Dossier.getDossier(dossierId)

  if (!req.dossier) {
    throw createHttpError(404, 'Dossier not found')
  }

  next()
})

async function createRoutes() {
  const app = new Router()

  // Authenticate user / runner
  app.use(w(async (req, res, next) => {
    if (!req.get('Authorization')) {
      return next()
    }

    const token = req.get('Authorization').split(' ')[1]

    if (token !== process.env.TOKEN) {
      return next(createHttpError(401, 'Unauthorized'))
    }

    next()
  }))

  /* Resolvers */

  app.param('dossierId', handleDossier)

  /* Dossiers */

  app.get('/dossiers', w(async (req, res) => {
    const dossiers = await Dossier.getDossiers()
    res.send(dossiers)
  }))

  app.get('/dossiers/:dossierId', w(async (req, res) => {
    res.send(req.dossier)
  }))

  app.get('/dossiers/:dossierId/files/:checksum', w(async (req, res) => {
    const file = req.dossier.files.find(f => f.checksum === req.params.checksum)

    if (!file) {
      throw createHttpError(404, 'File not found')
    }

    const key = file.objectKey
    const buffer = await downloadFile(key)
    res.send(buffer)
  }))

  app.get('/points-prelevement', w(async (req, res) => {
    const prelevements = await getPointsPrelevement()

    res.send(prelevements)
  }))

  app.get('/points-prelevement/:id', w(async (req, res) => {
    const pointPrelevement = await getPointPrelevement(req.params.id)

    res.send(pointPrelevement)
  }))

  app.get('/points-prelevement/:id/beneficiaires', w(async (req, res) => {
    const beneficiaires = await getBeneficiairesFromPointId(req.params.id)

    res.send(beneficiaires)
  }))

  app.get('/points-prelevement/:id/exploitations', w(async (req, res) => {
    const exploitations = await getExploitationsFromPointId(req.params.id)

    res.send(exploitations)
  }))

  app.get('/exploitations/:id', w(async (req, res) => {
    const exploitation = await getExploitation(req.params.id)

    res.send(exploitation)
  }))

  app.get('/exploitations/:id/documents', w(async (req, res) => {
    const documents = await getDocumentFromExploitationId(req.params.id)

    res.send(documents)
  }))

  app.get('/exploitations/:id/regles', w(async (req, res) => {
    const regles = await getReglesFromExploitationId(req.params.id)

    res.send(regles)
  }))

  app.get('/exploitations/:id/modalites', w(async (req, res) => {
    const modalites = await getModalitesFromExploitationId(req.params.id)

    res.send(modalites)
  }))

  app.get('/exploitations/:id/volumes-preleves', w(async (req, res) => {
    const volumesPreleves = await getVolumesPreleves(req.params.id)

    const regles = await getReglesFromExploitationId(req.params.id)
    const regleVolumeJournalier = regles.find(r => r.parametre === 'Volume journalier')

    const dateDebut = volumesPreleves[0]?.date
    const dateFin = volumesPreleves.at(-1)?.date
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

  app.get('/regles/:id/documents', w(async (req, res) => {
    const document = await getDocumentFromRegleId(req.params.id)

    res.send(document)
  }))

  app.get('/beneficiaires', w(async (req, res) => {
    const beneficiaires = await getBeneficiaires()

    res.send(beneficiaires)
  }))

  app.get('/beneficiaires/:id', w(async (req, res) => {
    const beneficiaire = await getBeneficiaire(req.params.id)

    res.send(beneficiaire)
  }))

  app.get('/beneficiaires/:id/points-prelevement', w(async (req, res) => {
    const points = await getPointsFromBeneficiaire(req.params.id)

    res.send(points)
  }))

  app.get('/regles/:id', w(async (req, res) => {
    const regle = await getRegle(req.params.id)

    res.send(regle)
  }))

  app.get('/documents/:id', w(async (req, res) => {
    const document = await getDocument(req.params.id)

    res.send(document)
  }))

  app.get('/bss/:id', w(async (req, res) => {
    const bss = await getBssById(req.params.id)

    res.send(bss)
  }))

  app.get('/bnpe/:id', w(async (req, res) => {
    const bnpe = await getBnpe(req.params.id)

    res.send(bnpe)
  }))

  app.get('/commune/:codeInsee', w(async (req, res) => {
    const commune = await getCommune(req.params.codeInsee)

    res.send(commune)
  }))

  return app
}

const routes = await createRoutes()
export default routes
