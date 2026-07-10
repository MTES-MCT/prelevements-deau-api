import Joi from 'joi'
import createHttpError from 'http-errors'

import {
  getDashboardPiezometry,
  getDashboardRiverFlows
} from '../services/dashboard-water-resources.js'
import {resolveDashboardZoneSelection} from './dashboard.js'

const piezometryQuerySchema = Joi.object({
  zones: Joi.string().allow('', null),
  period: Joi.string().valid('week', 'month', 'year', 'twenty-years').default('week')
}).unknown(false)
const flowQuerySchema = Joi.object({
  zones: Joi.string().allow('', null),
  period: Joi.string().valid('week', 'month', 'year').default('week')
}).unknown(false)

function validateQuery(schema, query) {
  const {error, value} = schema.validate(query, {stripUnknown: true})
  if (error) {
    throw createHttpError(400, error.details.map(detail => detail.message).join(', '))
  }

  return value
}

async function getSelection(user, zones) {
  const selection = await resolveDashboardZoneSelection(user, zones)

  return {
    zoneIds: selection.selectedZones.map(zone => zone.id),
    selectedZoneCodes: selection.selectedZones.map(zone => zone.code),
    unknownZoneCodes: selection.requestedZoneCodes.filter(code =>
      !selection.accessibleZones.some(zone => zone.code === code)
    )
  }
}

export async function getDashboardPiezometryHandler(req, res) {
  const query = validateQuery(piezometryQuerySchema, req.query)
  const selection = await getSelection(req.user, query.zones)
  const payload = await getDashboardPiezometry({
    zoneIds: selection.zoneIds,
    period: query.period
  })

  res.json({...payload, ...selection})
}

export async function getDashboardRiverFlowsHandler(req, res) {
  const query = validateQuery(flowQuerySchema, req.query)
  const selection = await getSelection(req.user, query.zones)
  const payload = await getDashboardRiverFlows({
    zoneIds: selection.zoneIds,
    period: query.period
  })

  res.json({...payload, ...selection})
}
