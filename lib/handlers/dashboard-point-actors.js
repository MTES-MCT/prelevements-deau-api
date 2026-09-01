import createHttpError from 'http-errors'
import Joi from 'joi'

import {getDashboardPointActors} from '../services/dashboard-point-actors.js'

const dashboardPointIdSchema = Joi.string().guid({version: 'uuidv4'}).required()

export async function getDashboardPointActorsHandler(req, res, {
  getPointActors = getDashboardPointActors
} = {}) {
  const {error, value: pointId} = dashboardPointIdSchema.validate(req.params.dashboardPointId)
  if (error) {
    throw createHttpError(400, 'L’identifiant du point est invalide.')
  }

  const payload = await getPointActors(pointId, req.user)
  res.json(payload)
}
