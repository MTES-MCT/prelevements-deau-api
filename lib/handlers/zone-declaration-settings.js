import createHttpError from 'http-errors'
import Joi from 'joi'

import {prisma} from '../../db/prisma.js'
import {activeWindowWhere} from '../models/point-prelevement.js'

const uuidSchema = Joi.string().guid({version: 'uuidv4'}).required()
const PERIOD_TYPES = new Map([
  ['month', 'MONTH'],
  ['week', 'WEEK']
])
const PERIOD_TYPES_FROM_DB = new Map([
  ['MONTH', 'month'],
  ['WEEK', 'week']
])
const REASONS = new Set(['DROUGHT', 'STRUCTURAL', 'OTHER'])

const settingsSchema = Joi.object({
  defaultPeriodType: Joi.string().valid('month', 'week').required()
})

const overrideSchema = Joi.object({
  periodType: Joi.string().valid('month', 'week').required(),
  reason: Joi.string().valid(...REASONS).default('DROUGHT'),
  label: Joi.string().allow('', null),
  startDate: Joi.date().iso().required(),
  endDate: Joi.date().iso().required()
}).custom((value, helpers) => {
  if (value.startDate > value.endDate) {
    return helpers.error('any.invalid')
  }

  return value
}, 'cohérence des dates')

function validateUuid(value, label) {
  const {error, value: uuid} = uuidSchema.validate(value)

  if (error) {
    throw createHttpError(400, `${label} invalide.`)
  }

  return uuid
}

function isGlobalAdmin(user) {
  return user?.role === 'ADMIN'
}

async function ensureZoneRight(user, zoneId, {requireAdmin = false} = {}) {
  if (isGlobalAdmin(user)) {
    const zone = await prisma.zone.findUnique({
      where: {id: zoneId},
      select: {id: true}
    })

    if (!zone) {
      throw createHttpError(404, 'Cette zone est introuvable.')
    }

    return
  }

  const right = await prisma.instructorZone.findFirst({
    where: {
      instructorUserId: user.id,
      zoneId,
      ...activeWindowWhere(new Date(), {startNullable: false, endNullable: true})
    },
    select: {isAdmin: true}
  })

  if (!right) {
    throw createHttpError(403, 'Vous n’avez pas accès à cette zone.')
  }

  if (requireAdmin && !right.isAdmin) {
    throw createHttpError(403, 'Droits insuffisants. Vous devez être admin de cette zone.')
  }
}

function toDateOnly(value) {
  const date = new Date(value)

  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function serializeOverride(override) {
  return {
    id: override.id,
    periodType: PERIOD_TYPES_FROM_DB.get(override.periodType) ?? 'month',
    reason: override.reason,
    label: override.label,
    startDate: override.startDate,
    endDate: override.endDate,
    createdAt: override.createdAt,
    updatedAt: override.updatedAt
  }
}

function serializeSettings(settings, overrides) {
  return {
    defaultPeriodType: PERIOD_TYPES_FROM_DB.get(settings?.defaultPeriodType ?? 'MONTH') ?? 'month',
    overrides: overrides.map(serializeOverride)
  }
}

async function ensureNoOverlap({zoneId, startDate, endDate, excludeId = null}) {
  const overlap = await prisma.zoneDeclarationPeriodOverride.findFirst({
    where: {
      zoneId,
      ...(excludeId ? {id: {not: excludeId}} : {}),
      startDate: {lte: endDate},
      endDate: {gte: startDate}
    },
    select: {id: true}
  })

  if (overlap) {
    throw createHttpError(400, 'Cette période chevauche une période déjà configurée.')
  }
}

export async function getZoneDeclarationSettingsHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')

  await ensureZoneRight(req.user, zoneId)

  const [settings, overrides] = await Promise.all([
    prisma.zoneDeclarationSettings.findUnique({where: {zoneId}}),
    prisma.zoneDeclarationPeriodOverride.findMany({
      where: {zoneId},
      orderBy: [{startDate: 'asc'}, {createdAt: 'asc'}]
    })
  ])

  res.send({
    data: serializeSettings(settings, overrides)
  })
}

export async function updateZoneDeclarationSettingsHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')
  const {error, value} = settingsSchema.validate(req.body, {abortEarly: false})

  if (error) {
    throw createHttpError(400, 'Configuration invalide.')
  }

  await ensureZoneRight(req.user, zoneId, {requireAdmin: true})

  const settings = await prisma.zoneDeclarationSettings.upsert({
    where: {zoneId},
    update: {
      defaultPeriodType: PERIOD_TYPES.get(value.defaultPeriodType)
    },
    create: {
      zoneId,
      defaultPeriodType: PERIOD_TYPES.get(value.defaultPeriodType)
    }
  })
  const overrides = await prisma.zoneDeclarationPeriodOverride.findMany({
    where: {zoneId},
    orderBy: [{startDate: 'asc'}, {createdAt: 'asc'}]
  })

  res.send({
    data: serializeSettings(settings, overrides)
  })
}

export async function createZoneDeclarationOverrideHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')
  const {error, value} = overrideSchema.validate(req.body, {abortEarly: false})

  if (error) {
    throw createHttpError(400, 'Période invalide.')
  }

  await ensureZoneRight(req.user, zoneId, {requireAdmin: true})

  const startDate = toDateOnly(value.startDate)
  const endDate = toDateOnly(value.endDate)

  await ensureNoOverlap({zoneId, startDate, endDate})

  const override = await prisma.zoneDeclarationPeriodOverride.create({
    data: {
      zoneId,
      periodType: PERIOD_TYPES.get(value.periodType),
      reason: value.reason,
      label: value.label || null,
      startDate,
      endDate
    }
  })

  res.status(201).send({
    data: serializeOverride(override)
  })
}

export async function updateZoneDeclarationOverrideHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')
  const overrideId = validateUuid(req.params.overrideId, 'Identifiant de période')
  const {error, value} = overrideSchema.validate(req.body, {abortEarly: false})

  if (error) {
    throw createHttpError(400, 'Période invalide.')
  }

  await ensureZoneRight(req.user, zoneId, {requireAdmin: true})

  const startDate = toDateOnly(value.startDate)
  const endDate = toDateOnly(value.endDate)

  await ensureNoOverlap({zoneId, startDate, endDate, excludeId: overrideId})

  const existing = await prisma.zoneDeclarationPeriodOverride.findFirst({
    where: {id: overrideId, zoneId},
    select: {id: true}
  })

  if (!existing) {
    throw createHttpError(404, 'Cette période est introuvable.')
  }

  const override = await prisma.zoneDeclarationPeriodOverride.update({
    where: {id: overrideId},
    data: {
      periodType: PERIOD_TYPES.get(value.periodType),
      reason: value.reason,
      label: value.label || null,
      startDate,
      endDate
    }
  })

  res.send({
    data: serializeOverride(override)
  })
}

export async function deleteZoneDeclarationOverrideHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')
  const overrideId = validateUuid(req.params.overrideId, 'Identifiant de période')

  await ensureZoneRight(req.user, zoneId, {requireAdmin: true})

  const existing = await prisma.zoneDeclarationPeriodOverride.findFirst({
    where: {id: overrideId, zoneId},
    select: {id: true}
  })

  if (!existing) {
    throw createHttpError(404, 'Cette période est introuvable.')
  }

  await prisma.zoneDeclarationPeriodOverride.delete({
    where: {id: overrideId}
  })

  res.status(204).send()
}
