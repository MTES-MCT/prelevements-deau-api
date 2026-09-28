import createHttpError from 'http-errors'
import Joi from 'joi'

import {prisma} from '../../db/prisma.js'
import {stageAuditMutation} from '../audit/mutations.js'
import {ZONE_AGENT_MANAGEMENT_PERMISSIONS} from '../constants/zone-permissions.js'
import {hasZonePermission} from '../services/zone-permissions.js'
import {getZoneManagedResourceType, ZONE_MANAGED_RESOURCE_TYPES} from '../services/zone-resource-types.js'

const zoneIdSchema = Joi.string().guid({version: 'uuidv4'}).required()
export const zoneResourceSettingsSchema = Joi.object({
  managedResourceType: Joi.string().valid(...ZONE_MANAGED_RESOURCE_TYPES).required()
}).required()

function validateRequest(req, {write = false} = {}) {
  if (!req.auth || !req.user) throw createHttpError(401, 'Non authentifié.')
  if (req.auth.type !== 'USER_SESSION' || req.user.deletedAt || !['ADMIN', 'INSTRUCTOR'].includes(req.user.role)) {
    throw createHttpError(403, 'Cette action est réservée aux agents connectés.')
  }
  if (write && req.auth.impersonation) throw createHttpError(403, 'Cette action est indisponible pendant une impersonation.')
  const {error, value} = zoneIdSchema.validate(req.params.zoneId)
  if (error) throw createHttpError(400, 'Identifiant de zone invalide.')
  return value
}

async function getSettingsContext(req, zoneId, client, checkPermission) {
  const zone = await client.zone.findUnique({where: {id: zoneId}, select: {
    id: true, type: true, code: true, name: true, managedResourceType: true
  }})
  if (!zone) throw createHttpError(404, 'Cette zone est introuvable.')
  const isAdmin = req.user.role === 'ADMIN'
  if (!isAdmin && !await checkPermission(req.user, 'zone.detail.read', [zoneId], {client})) {
    throw createHttpError(403, 'Vous ne disposez pas de ce droit sur cette zone.')
  }
  if (zone.type !== 'SAGE') throw createHttpError(400, 'Ce paramètre est réservé aux SAGE.')
  const canEdit = isAdmin || (await Promise.all(ZONE_AGENT_MANAGEMENT_PERMISSIONS.map(permission =>
    checkPermission(req.user, permission, [zoneId], {client})))).every(Boolean)
  return {zone, canEdit}
}

function serializeSettings({zone, canEdit}) {
  return {data: {managedResourceType: getZoneManagedResourceType(zone)}, canEdit}
}

export function createZoneResourceSettingsHandlers({client = prisma, checkPermission = hasZonePermission} = {}) {
  return {
    async get(req, res) {
      const zoneId = validateRequest(req)
      const context = await getSettingsContext(req, zoneId, client, checkPermission)
      res.set('Cache-Control', 'no-store').json(serializeSettings(context))
    },
    async update(req, res) {
      const zoneId = validateRequest(req, {write: true})
      const {error, value} = zoneResourceSettingsSchema.validate(req.body, {abortEarly: false, convert: false})
      if (error) throw createHttpError(400, 'Type de ressource gérée invalide.')
      const result = await client.$transaction(async transaction => {
        const context = await getSettingsContext(req, zoneId, transaction, checkPermission)
        if (!context.canEdit) throw createHttpError(403, 'La modification est réservée aux gestionnaires de cette zone.')
        const zone = await transaction.zone.update({where: {id: zoneId}, data: {managedResourceType: value.managedResourceType}})
        return {before: context.zone, zone, canEdit: true}
      })
      stageAuditMutation(req, {operation: 'UPDATE', entityType: 'ZONE', entityId: zoneId,
        entityLabel: result.zone.name, before: result.before, after: result.zone})
      res.set('Cache-Control', 'no-store').json(serializeSettings(result))
    }
  }
}

const handlers = createZoneResourceSettingsHandlers()
export const getZoneResourceSettingsHandler = handlers.get
export const updateZoneResourceSettingsHandler = handlers.update
