import Joi from 'joi'
import createHttpError from 'http-errors'

import {
  getDashboardPiezometry,
  getDashboardRiverFlows
} from '../services/dashboard-water-resources.js'
import {resourceIdSchema} from '../validation/resource-id.js'
import {dashboardSelectionFields, resolveDashboardZoneSelection} from './dashboard.js'

const territoryQuery = {
  zones: Joi.string().allow('', null),
  zoneId: resourceIdSchema,
  scope: Joi.string().valid('territory', 'activity').default('territory')
}

const piezometryQuerySchema = Joi.object({
  ...territoryQuery,
  period: Joi.string().valid(
    'week',
    'month',
    'year',
    'five-years',
    'ten-years',
    'twenty-years'
  ).default('week'),
  includeIps: Joi.boolean().truthy('true').falsy('false').default(false)
}).unknown(false)
const flowQuerySchema = Joi.object({
  ...territoryQuery,
  period: Joi.string().valid('week', 'month', 'year').default('week')
}).unknown(false)

function validateQuery(schema, query) {
  const {error, value} = schema.validate(query, {stripUnknown: true})
  if (error) {
    throw createHttpError(400, error.details.map(detail => detail.message).join(', '))
  }

  return value
}

export async function getDashboardStationSelection(user, {zones, zoneId, scope}, resolveSelection = resolveDashboardZoneSelection) {
  if (scope === 'activity') {
    if (user.role !== 'DECLARANT') {
      throw createHttpError(403, 'La carte de votre activité est réservée aux déclarants.')
    }
    const {accessibleZones} = await resolveSelection(user)
    return {zoneIds: accessibleZones.map(zone => zone.id), selectedZoneId: null, selectedZoneCodes: [], unknownZoneCodes: []}
  }

  const selection = await resolveSelection(user, zones, {requestedZoneId: zoneId})
  return {zoneIds: selection.selectedZones.map(zone => zone.id), ...dashboardSelectionFields(selection)}
}

export async function getDashboardPiezometryHandler(req, res) {
  const query = validateQuery(piezometryQuerySchema, req.query)
  const selection = await getDashboardStationSelection(req.user, query)
  const payload = await getDashboardPiezometry({
    zoneIds: selection.zoneIds,
    period: query.period,
    includeIps: query.includeIps
  })

  res.json({...payload, ...selection})
}

export async function getDashboardRiverFlowsHandler(req, res) {
  const query = validateQuery(flowQuerySchema, req.query)
  const selection = await getDashboardStationSelection(req.user, query)
  const payload = await getDashboardRiverFlows({
    zoneIds: selection.zoneIds,
    period: query.period
  })

  res.json({...payload, ...selection})
}
