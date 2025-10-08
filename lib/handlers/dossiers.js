import createHttpError from 'http-errors'
import mongo from '../util/mongo.js'
import * as Dossier from '../models/dossier.js'
import {listIntegrationsByAttachment} from '../models/integration-journaliere.js'
import {getPointsPrelevementByIds} from '../models/point-prelevement.js'
import {enrichWithPointInfo} from '../util/point-info.js'
import s3 from '../util/s3.js'
import {getAttachmentObjectKey} from '@fabnum/demarches-simplifiees'

// Handlers Dossiers
export async function listDossiers(req, res) {
  if (!req.territoire.demarcheNumber) {
    throw createHttpError(404, 'Le territoire n’est pas associé à une démarche de Démarches Simplifiées')
  }

  const query = {}
  if (req.query.status) {
    query.status = req.query.status
  }

  if (req.query.preleveur && req.query.preleveur !== 'unknown') {
    query['result.preleveur'] = mongo.parseObjectId(req.query.preleveur)
  }

  if (req.query.preleveur === 'unknown') {
    query['result.preleveur'] = {$exists: false}
  }

  if (req.query.typePrelevement) {
    query.typePrelevement = req.query.typePrelevement
  }

  if (req.query.moisDeclaration) {
    query.moisDeclaration = req.query.moisDeclaration
  }

  if (req.query.number) {
    query.number = mongo.parseObjectId(req.query.number)
  }

  const dossiers = await Dossier.getDossiers(req.territoire.demarcheNumber, query)
  const decorateDossiers = await Promise.all(dossiers.map(d => Dossier.decorateDossier(d)))
  res.send(decorateDossiers)
}

export async function getDossiersStatsHandler(req, res) {
  const stats = await Dossier.getDossiersStats(req.territoire.demarcheNumber)
  res.send(stats)
}

export async function getDossierDetail(req, res) {
  const attachments = await Dossier.getAttachmentsSummaryByDossierId(req.dossier._id)
  res.send({...req.dossier, files: attachments})
}

export async function getAttachmentDetail(req, res) {
  res.send(req.attachment)
}

export async function getAttachmentIntegrations(req, res) {
  const integrations = await listIntegrationsByAttachment(req.attachment._id)
  if (req.query.withPoint === '1') {
    await enrichWithPointInfo(integrations, {
      getId(i) {
        return i.point
      },
      setInfo(i, info) {
        i.pointInfo = info
      },
      fetchPoints(ids) {
        return getPointsPrelevementByIds(ids.map(id => mongo.parseObjectId(id)))
      }
    })
  }

  res.send({integrations})
}

export async function downloadAttachment(req, res) {
  const objectKey = getAttachmentObjectKey(
    req.dossier.demarcheNumber,
    req.dossier.number,
    req.attachment.storageKey
  )
  const buffer = await s3('ds').downloadObject(objectKey)
  res.send(buffer)
}
