import {parseObjectId} from '../util/mongo.js'
import * as Dossier from '../models/dossier.js'
import * as DossierService from '../services/dossier.js'
import {listIntegrationsByAttachment} from '../models/integration-journaliere.js'
import {getPointInfo} from '../services/point-prelevement.js'
import s3 from '../util/s3.js'
import {getAttachmentObjectKey} from '@fabnum/demarches-simplifiees'

// Handlers Dossiers
export async function listDossiers(req, res) {
  const query = {}
  if (req.query.status) {
    query.status = req.query.status
  }

  if (req.query.preleveur && req.query.preleveur !== 'unknown') {
    query['result.preleveur'] = parseObjectId(req.query.preleveur)
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

  const dossiers = await Dossier.getDossiers(req.territoire.code, query)
  const decorateDossiers = await Promise.all(dossiers.map(d => Dossier.decorateDossier(d)))
  res.send(decorateDossiers)
}

export async function getDossiersStatsHandler(req, res) {
  const stats = await Dossier.getDossiersStats(req.territoire.code)
  res.send(stats)
}

export async function getDossierDetail(req, res) {
  const attachments = await Dossier.getAttachmentsSummaryByDossierId(req.dossier._id)
  res.send({...req.dossier, files: attachments})
}

export async function reconsolidateDossier(req, res) {
  const dossier = await DossierService.markDossierForReconsolidation(req.dossier._id)

  res.status(202).send({
    success: true,
    dossierId: dossier._id,
    message: 'Dossier marqué pour reconsolidation. Il sera retraité dès que possible.'
  })
}

export async function reprocessAttachment(req, res) {
  const attachment = await DossierService.markAttachmentForReprocessing(req.attachment._id)

  res.status(202).send({
    success: true,
    attachmentId: attachment._id,
    message: 'Pièce jointe marquée pour retraitement. Elle sera retraitée dès que possible.'
  })
}

export async function getAttachmentDetail(req, res) {
  res.send(req.attachment)
}

export async function getAttachmentIntegrations(req, res) {
  const integrations = await listIntegrationsByAttachment(req.attachment._id)

  if (req.query.withPoint === '1') {
    await Promise.all(
      integrations.map(async integration => {
        integration.pointInfo = await getPointInfo(integration.point)
      })
    )
  }

  res.send({integrations})
}

export async function downloadAttachment(req, res) {
  const objectKey = getAttachmentObjectKey(
    req.dossier.ds.demarcheNumber,
    req.dossier.ds.dossierNumber,
    req.attachment.storageKey
  )
  const buffer = await s3('ds').downloadObject(objectKey)
  res.send(buffer)
}
