import {randomUUID} from 'node:crypto'

import createHttpError from 'http-errors'
import Joi from 'joi'

import {prisma} from '../../db/prisma.js'
import {
  normalizeDeclarationTypeCode,
  serializeDeclarationType
} from '../models/declaration-type.js'

const uuidSchema = Joi.string().guid({version: 'uuidv4'}).required()

const declarationTypeCreationSchema = Joi.object({
  code: Joi.string().trim().min(2).max(120).required(),
  name: Joi.string().trim().min(2).max(240).required(),
  version: Joi.number().integer().min(1).default(1),
  isAvailable: Joi.boolean().default(true)
})

const declarationTypeUpdateSchema = Joi.object({
  name: Joi.string().trim().min(2).max(240),
  version: Joi.number().integer().min(1),
  isAvailable: Joi.boolean()
}).min(1)

const declarantDeclarationTypePayloadSchema = Joi.object({
  declarationTypeId: Joi.string().guid({version: 'uuidv4'}).required(),
  startDate: Joi.date().iso().allow(null),
  endDate: Joi.date().iso().allow(null)
}).custom((value, helpers) => {
  if (value.startDate && value.endDate && value.startDate > value.endDate) {
    return helpers.error('any.invalid')
  }

  return value
}, 'cohérence des dates')

function validateUuid(value, label = 'Identifiant') {
  const {error, value: validated} = uuidSchema.validate(value)

  if (error) {
    throw createHttpError(400, `${label} invalide.`)
  }

  return validated
}

function normalizeDate(value) {
  if (value === undefined || value === null || value === '') {
    return null
  }

  const date = value instanceof Date ? value : new Date(value)

  if (Number.isNaN(date.getTime())) {
    throw createHttpError(400, 'Date invalide.')
  }

  date.setHours(0, 0, 0, 0)
  return date
}

function serializeDate(date) {
  return date ? date.toISOString().slice(0, 10) : null
}

function getTemporalStatus({startDate, endDate}, now = new Date()) {
  const today = normalizeDate(now)

  if (startDate && startDate > today) {
    return 'FUTURE'
  }

  if (endDate && endDate < today) {
    return 'EXPIRED'
  }

  return 'ACTIVE'
}

function serializeDeclarationTypeWithStats(declarationType, declarationsCountByCode = new Map()) {
  return {
    ...serializeDeclarationType(declarationType),
    declarantsCount: declarationType._count?.declarants ?? 0,
    declarationsCount: declarationsCountByCode.get(declarationType.code) ?? 0,
    createdAt: declarationType.createdAt,
    updatedAt: declarationType.updatedAt
  }
}

function serializeDeclarantDeclarationType(link) {
  const temporalStatus = getTemporalStatus(link)
  const declarationType = serializeDeclarationType(link.declarationType)
  const isAvailable = Boolean(link.declarationType?.isAvailable)

  return {
    id: link.id,
    declarantUserId: link.declarantUserId,
    declarationTypeId: link.declarationTypeId,
    declarationType,
    startDate: serializeDate(link.startDate),
    endDate: serializeDate(link.endDate),
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
    status: isAvailable ? temporalStatus : 'UNAVAILABLE',
    isActive: isAvailable && temporalStatus === 'ACTIVE'
  }
}

async function getDeclarationsCountByCode(codes) {
  if (!codes?.length) {
    return new Map()
  }

  const rows = await prisma.declaration.groupBy({
    by: ['type'],
    where: {
      type: {
        in: codes
      }
    },
    _count: {
      _all: true
    }
  })

  return new Map(
    rows.map(row => [
      normalizeDeclarationTypeCode(row.type),
      row._count._all
    ])
  )
}

async function getDeclarationTypeOrThrow(declarationTypeId, {requireAvailable = false} = {}) {
  const id = validateUuid(declarationTypeId, 'Identifiant de type de déclaration')

  const declarationType = await prisma.declarationType.findUnique({
    where: {id}
  })

  if (!declarationType) {
    throw createHttpError(404, 'Ce type de déclaration est introuvable.')
  }

  if (requireAvailable && !declarationType.isAvailable) {
    throw createHttpError(400, 'Ce type de déclaration est désactivé sur la plateforme.')
  }

  return declarationType
}

function buildOverlapWhere({
  declarantUserId,
  declarationTypeId,
  startDate,
  endDate,
  ignoredLinkId = null
}) {
  const conditions = [
    {
      declarantUserId,
      declarationTypeId
    }
  ]

  if (ignoredLinkId) {
    conditions.push({id: {not: ignoredLinkId}})
  }

  if (endDate) {
    conditions.push({
      OR: [
        {startDate: null},
        {startDate: {lte: endDate}}
      ]
    })
  }

  if (startDate) {
    conditions.push({
      OR: [
        {endDate: null},
        {endDate: {gte: startDate}}
      ]
    })
  }

  return {AND: conditions}
}

async function assertNoDeclarantTypeOverlap({
  declarantUserId,
  declarationTypeId,
  startDate,
  endDate,
  ignoredLinkId = null
}) {
  const overlappingLink = await prisma.declarantDeclarationType.findFirst({
    where: buildOverlapWhere({
      declarantUserId,
      declarationTypeId,
      startDate,
      endDate,
      ignoredLinkId
    }),
    include: {
      declarationType: true
    }
  })

  if (overlappingLink) {
    const typeName = overlappingLink.declarationType?.name || 'ce type'
    throw createHttpError(
      409,
      `Une autorisation existe déjà sur une période qui chevauche ${typeName}.`
    )
  }
}

async function listDeclarantDeclarationTypesPayload(declarantUserId, {canManage = false} = {}) {
  const [links, declarationTypes] = await Promise.all([
    prisma.declarantDeclarationType.findMany({
      where: {declarantUserId},
      include: {
        declarationType: true
      },
      orderBy: [
        {endDate: 'asc'},
        {startDate: 'asc'},
        {
          declarationType: {
            name: 'asc'
          }
        }
      ]
    }),
    prisma.declarationType.findMany({
      where: {
        isAvailable: true
      },
      orderBy: [
        {name: 'asc'},
        {code: 'asc'}
      ]
    })
  ])

  const serializedLinks = links
    .map(link => serializeDeclarantDeclarationType(link))
    .sort((a, b) => {
      const statusOrder = {ACTIVE: 0, FUTURE: 1, EXPIRED: 2, UNAVAILABLE: 3}
      const statusDiff = (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9)

      if (statusDiff !== 0) {
        return statusDiff
      }

      return (a.declarationType?.name || '').localeCompare(b.declarationType?.name || '', 'fr')
    })

  return {
    success: true,
    data: serializedLinks,
    meta: {
      canManage,
      availableDeclarationTypes: declarationTypes.map(serializeDeclarationType),
      activeCount: serializedLinks.filter(link => link.status === 'ACTIVE').length,
      futureCount: serializedLinks.filter(link => link.status === 'FUTURE').length,
      expiredCount: serializedLinks.filter(link => link.status === 'EXPIRED').length,
      unavailableCount: serializedLinks.filter(link => link.status === 'UNAVAILABLE').length
    }
  }
}

export async function listDeclarationTypesHandler(_req, res) {
  const declarationTypes = await prisma.declarationType.findMany({
    include: {
      _count: {
        select: {
          declarants: true
        }
      }
    },
    orderBy: [
      {isAvailable: 'desc'},
      {name: 'asc'},
      {code: 'asc'}
    ]
  })

  const declarationsCountByCode = await getDeclarationsCountByCode(
    declarationTypes.map(type => type.code)
  )

  const data = declarationTypes.map(type => serializeDeclarationTypeWithStats(type, declarationsCountByCode))

  res.json({
    success: true,
    data,
    meta: {
      total: data.length,
      availableCount: data.filter(type => type.isAvailable).length,
      unavailableCount: data.filter(type => !type.isAvailable).length
    }
  })
}

export async function createDeclarationTypeHandler(req, res) {
  const {error, value} = declarationTypeCreationSchema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true
  })

  if (error) {
    throw createHttpError(400, error.details.map(detail => detail.message).join(' '))
  }

  const code = normalizeDeclarationTypeCode(value.code)

  if (!/^[a-z\d][a-z\d._-]*$/.test(code)) {
    throw createHttpError(
      400,
      'Le code doit contenir uniquement des lettres non accentuées, chiffres, points, tirets ou underscores.'
    )
  }

  try {
    const declarationType = await prisma.declarationType.create({
      data: {
        id: randomUUID(),
        code,
        name: value.name,
        version: value.version,
        isAvailable: value.isAvailable
      },
      include: {
        _count: {
          select: {
            declarants: true
          }
        }
      }
    })

    res.status(201).json({
      success: true,
      data: serializeDeclarationTypeWithStats(declarationType)
    })
  } catch (error_) {
    if (error_?.code === 'P2002') {
      throw createHttpError(409, 'Un type de déclaration existe déjà avec ce code.')
    }

    throw error_
  }
}

export async function getDeclarationTypeHandler(req, res) {
  const declarationTypeId = validateUuid(req.params.declarationTypeId, 'Identifiant de type de déclaration')

  const declarationType = await prisma.declarationType.findUnique({
    where: {id: declarationTypeId},
    include: {
      _count: {
        select: {
          declarants: true
        }
      }
    }
  })

  if (!declarationType) {
    throw createHttpError(404, 'Ce type de déclaration est introuvable.')
  }

  const declarationsCountByCode = await getDeclarationsCountByCode([declarationType.code])

  res.json({
    success: true,
    data: serializeDeclarationTypeWithStats(declarationType, declarationsCountByCode)
  })
}

export async function updateDeclarationTypeHandler(req, res) {
  const declarationTypeId = validateUuid(req.params.declarationTypeId, 'Identifiant de type de déclaration')

  const {error, value} = declarationTypeUpdateSchema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true
  })

  if (error) {
    throw createHttpError(400, error.details.map(detail => detail.message).join(' '))
  }

  try {
    const declarationType = await prisma.declarationType.update({
      where: {id: declarationTypeId},
      data: value,
      include: {
        _count: {
          select: {
            declarants: true
          }
        }
      }
    })

    const declarationsCountByCode = await getDeclarationsCountByCode([declarationType.code])

    res.json({
      success: true,
      data: serializeDeclarationTypeWithStats(declarationType, declarationsCountByCode)
    })
  } catch (error_) {
    if (error_?.code === 'P2025') {
      throw createHttpError(404, 'Ce type de déclaration est introuvable.')
    }

    throw error_
  }
}

export async function disableDeclarationTypeHandler(req, res) {
  const declarationTypeId = validateUuid(req.params.declarationTypeId, 'Identifiant de type de déclaration')

  const declarationType = await prisma.declarationType.update({
    where: {id: declarationTypeId},
    data: {
      isAvailable: false
    },
    include: {
      _count: {
        select: {
          declarants: true
        }
      }
    }
  })

  const declarationsCountByCode = await getDeclarationsCountByCode([declarationType.code])

  res.json({
    success: true,
    data: serializeDeclarationTypeWithStats(declarationType, declarationsCountByCode)
  })
}

export async function restoreDeclarationTypeHandler(req, res) {
  const declarationTypeId = validateUuid(req.params.declarationTypeId, 'Identifiant de type de déclaration')

  const declarationType = await prisma.declarationType.update({
    where: {id: declarationTypeId},
    data: {
      isAvailable: true
    },
    include: {
      _count: {
        select: {
          declarants: true
        }
      }
    }
  })

  const declarationsCountByCode = await getDeclarationsCountByCode([declarationType.code])

  res.json({
    success: true,
    data: serializeDeclarationTypeWithStats(declarationType, declarationsCountByCode)
  })
}

export async function listDeclarantDeclarationTypesHandler(req, res) {
  const declarantUserId = validateUuid(req.params.declarantId, 'Identifiant de déclarant')

  const payload = await listDeclarantDeclarationTypesPayload(declarantUserId, {
    canManage: req.user?.role === 'ADMIN' || req.user?.role === 'INSTRUCTOR'
  })

  res.json(payload)
}

export async function addDeclarantDeclarationTypeHandler(req, res) {
  const declarantUserId = validateUuid(req.params.declarantId, 'Identifiant de déclarant')

  const {error, value} = declarantDeclarationTypePayloadSchema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true
  })

  if (error) {
    throw createHttpError(
      400,
      error.details.map(detail => detail.message).join(' ')
    )
  }

  const declarationType = await getDeclarationTypeOrThrow(value.declarationTypeId, {
    requireAvailable: true
  })

  const startDate = normalizeDate(value.startDate)
  const endDate = normalizeDate(value.endDate)

  await assertNoDeclarantTypeOverlap({
    declarantUserId,
    declarationTypeId: declarationType.id,
    startDate,
    endDate
  })

  await prisma.declarantDeclarationType.create({
    data: {
      id: randomUUID(),
      declarantUserId,
      declarationTypeId: declarationType.id,
      startDate,
      endDate
    }
  })

  res.status(201).json(await listDeclarantDeclarationTypesPayload(declarantUserId, {canManage: true}))
}

export async function updateDeclarantDeclarationTypeHandler(req, res) {
  const declarantUserId = validateUuid(req.params.declarantId, 'Identifiant de déclarant')
  const linkId = validateUuid(req.params.linkId, 'Identifiant d’autorisation')

  const {error, value} = declarantDeclarationTypePayloadSchema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true
  })

  if (error) {
    throw createHttpError(
      400,
      error.details.map(detail => detail.message).join(' ')
    )
  }

  const existingLink = await prisma.declarantDeclarationType.findFirst({
    where: {
      id: linkId,
      declarantUserId
    }
  })

  if (!existingLink) {
    throw createHttpError(404, 'Cette autorisation est introuvable.')
  }

  const declarationType = await getDeclarationTypeOrThrow(value.declarationTypeId, {
    requireAvailable: true
  })

  const startDate = normalizeDate(value.startDate)
  const endDate = normalizeDate(value.endDate)

  await assertNoDeclarantTypeOverlap({
    declarantUserId,
    declarationTypeId: declarationType.id,
    startDate,
    endDate,
    ignoredLinkId: linkId
  })

  await prisma.declarantDeclarationType.update({
    where: {id: linkId},
    data: {
      declarationTypeId: declarationType.id,
      startDate,
      endDate
    }
  })

  res.json(await listDeclarantDeclarationTypesPayload(declarantUserId, {canManage: true}))
}

export async function removeDeclarantDeclarationTypeHandler(req, res) {
  const declarantUserId = validateUuid(req.params.declarantId, 'Identifiant de déclarant')
  const linkId = validateUuid(req.params.linkId, 'Identifiant d’autorisation')

  const existingLink = await prisma.declarantDeclarationType.findFirst({
    where: {
      id: linkId,
      declarantUserId
    }
  })

  if (!existingLink) {
    throw createHttpError(404, 'Cette autorisation est introuvable.')
  }

  await prisma.declarantDeclarationType.delete({
    where: {id: linkId}
  })

  res.json(await listDeclarantDeclarationTypesPayload(declarantUserId, {canManage: true}))
}
