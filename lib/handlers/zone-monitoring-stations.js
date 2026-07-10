import createHttpError from 'http-errors'
import Joi from 'joi'

import {prisma} from '../../db/prisma.js'
import {addJobSyncMonitoringStation} from '../queues/jobs.js'
import {HubeauError} from '../services/hubeau.js'
import {
  resolveMonitoringStationMetadata,
  serializeMonitoringStationAssociation,
  upsertMonitoringStationMetadata
} from '../services/monitoring-stations.js'
import {getZoneRightOrThrow} from './zone-resources.js'

const uuidSchema = Joi.string().guid({version: 'uuidv4'}).required()
const stationSchema = Joi.object({
  type: Joi.string().valid('PIEZOMETER', 'FLOW_STATION').required(),
  stationCode: Joi.string().trim().min(2).max(100).required(),
  label: Joi.string().trim().min(1).max(300).required(),
  enabled: Joi.boolean().default(true)
})
const associationInclude = {
  monitoringStation: true
}

function validateUuid(value, label) {
  const {error, value: uuid} = uuidSchema.validate(value)
  if (error) {
    throw createHttpError(400, `${label} invalide.`)
  }

  return uuid
}

function validatePayload(payload) {
  const {error, value} = stationSchema.validate(payload, {
    abortEarly: false,
    stripUnknown: true
  })

  if (error) {
    throw createHttpError(400, error.details.map(detail => detail.message).join(', '))
  }

  return value
}

function translateHubeauError(error) {
  if (!(error instanceof HubeauError)) {
    return error
  }

  if (error.status === 404) {
    return createHttpError(422, error.message)
  }

  return createHttpError(503, 'Hub’Eau est momentanément indisponible. Réessayez dans quelques instants.')
}

async function deleteStationIfOrphan(stationId, transaction = prisma) {
  const associationCount = await transaction.zoneMonitoringStation.count({
    where: {monitoringStationId: stationId}
  })

  if (associationCount === 0) {
    await transaction.monitoringStation.delete({where: {id: stationId}})
  }
}

async function getAssociation(zoneId, associationId) {
  const association = await prisma.zoneMonitoringStation.findFirst({
    where: {id: associationId, zoneId},
    include: associationInclude
  })

  if (!association) {
    throw createHttpError(404, 'Cette station de mesure est introuvable dans la zone.')
  }

  return association
}

function isUniqueConstraintError(error) {
  return error?.code === 'P2002'
}

export async function listZoneMonitoringStationsHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')
  await getZoneRightOrThrow(req.user, zoneId)

  const associations = await prisma.zoneMonitoringStation.findMany({
    where: {zoneId},
    include: associationInclude,
    orderBy: [
      {monitoringStation: {type: 'asc'}},
      {label: 'asc'}
    ]
  })

  res.json(associations.map(serializeMonitoringStationAssociation))
}

export async function createZoneMonitoringStationHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')
  await getZoneRightOrThrow(req.user, zoneId, {requireAdmin: true})
  const payload = validatePayload(req.body)

  let metadata
  try {
    metadata = await resolveMonitoringStationMetadata(payload.type, payload.stationCode)
  } catch (error) {
    throw translateHubeauError(error)
  }

  let association
  try {
    association = await prisma.$transaction(async transaction => {
      const station = await upsertMonitoringStationMetadata(transaction, metadata)
      return transaction.zoneMonitoringStation.create({
        data: {
          zoneId,
          monitoringStationId: station.id,
          label: payload.label,
          enabled: payload.enabled
        },
        include: associationInclude
      })
    })
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw createHttpError(409, 'Cette station est déjà configurée pour la zone.')
    }

    throw error
  }

  if (association.enabled) {
    await addJobSyncMonitoringStation(association.monitoringStationId, 'full')
    await addJobSyncMonitoringStation(association.monitoringStationId, 'realtime')
  }

  res.status(201).json(serializeMonitoringStationAssociation(association))
}

export async function updateZoneMonitoringStationHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')
  const associationId = validateUuid(req.params.associationId, 'Identifiant de station')
  await getZoneRightOrThrow(req.user, zoneId, {requireAdmin: true})
  const current = await getAssociation(zoneId, associationId)
  const payload = validatePayload(req.body)

  const stationChanged = payload.type !== current.monitoringStation.type
    || payload.stationCode.trim().toUpperCase() !== current.monitoringStation.stationCode
  let metadata = null

  if (stationChanged) {
    try {
      metadata = await resolveMonitoringStationMetadata(payload.type, payload.stationCode)
    } catch (error) {
      throw translateHubeauError(error)
    }
  }

  let association
  try {
    association = await prisma.$transaction(async transaction => {
      let {monitoringStationId} = current

      if (metadata) {
        const nextStation = await upsertMonitoringStationMetadata(transaction, metadata)
        monitoringStationId = nextStation.id
      }

      const updated = await transaction.zoneMonitoringStation.update({
        where: {id: associationId},
        data: {
          monitoringStationId,
          label: payload.label,
          enabled: payload.enabled
        },
        include: associationInclude
      })

      if (monitoringStationId !== current.monitoringStationId) {
        await deleteStationIfOrphan(current.monitoringStationId, transaction)
      }

      return updated
    })
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw createHttpError(409, 'Cette station est déjà configurée pour la zone.')
    }

    throw error
  }

  if (association.enabled) {
    if (stationChanged || !current.enabled) {
      await addJobSyncMonitoringStation(association.monitoringStationId, 'full')
    }

    await addJobSyncMonitoringStation(association.monitoringStationId, 'realtime')
  }

  res.json(serializeMonitoringStationAssociation(association))
}

export async function deleteZoneMonitoringStationHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')
  const associationId = validateUuid(req.params.associationId, 'Identifiant de station')
  await getZoneRightOrThrow(req.user, zoneId, {requireAdmin: true})
  const association = await getAssociation(zoneId, associationId)

  await prisma.$transaction(async transaction => {
    await transaction.zoneMonitoringStation.delete({where: {id: association.id}})
    await deleteStationIfOrphan(association.monitoringStationId, transaction)
  })

  res.status(204).end()
}
