import createHttpError from 'http-errors'
import Joi from 'joi'

import {stageAuditMutation} from '../audit/mutations.js'
import {
  getCollectorPointManagement,
  updateCollectorPointManagement
} from '../services/collector-point-management.js'
import {createCollectorPoint, getCollectorPointCreationPreleveurs} from '../services/collector-point-creation.js'
import {searchCurrentCommunes} from '../validation/collector-point-management-validation.js'
import {decoratePointPrelevement} from '../services/point-prelevement.js'

function collectorId(req) {
  const id = req.params.collecteurId ?? req.user.id
  if (Joi.string().uuid().required().validate(id).error) {
    throw createHttpError(400, 'Identifiant du collecteur invalide.')
  }

  return id
}

export async function getCollectorPointManagementHandler(req, res) {
  res.send(await getCollectorPointManagement(collectorId(req)))
}

export async function getCollectorPointCreationPreleveursHandler(req, res) {
  res.send(await getCollectorPointCreationPreleveurs(req.user))
}

export function searchCurrentCommunesHandler(req, res) {
  const {error, value} = Joi.string().trim().max(100).allow('').default('').validate(req.query.q)
  if (error) throw createHttpError(400, 'Recherche de commune invalide.')
  res.send(searchCurrentCommunes(value))
}

export async function updateCollectorPointManagementHandler(req, res) {
  const id = collectorId(req)
  const before = await getCollectorPointManagement(id)
  const after = await updateCollectorPointManagement(id, req.body, {user: req.user})
  stageAuditMutation(req, {
    operation: 'UPDATE', entityType: 'COLLECTOR_POINT_MANAGEMENT', entityId: id,
    before, after
  })
  res.send(after)
}

export async function createCollectorPointHandler(req, res) {
  const result = await createCollectorPoint(req.body, {
    user: req.user,
    onCreated({point, preleveur, exploitation}) {
      for (const [entityType, entity] of [['POINT', point], ['DECLARANT', preleveur], ['EXPLOITATION', exploitation]]) {
        if (entity) stageAuditMutation(req, {
          operation: 'CREATE', entityType, entityId: entity.userId ?? entity.id,
          after: entity
        })
      }
    }
  })
  const point = await decoratePointPrelevement(result.point, {user: req.user})
  res.status(result.replayed ? 200 : 201).send({...result, point})
}
