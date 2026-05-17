import {randomUUID} from 'node:crypto'

import createHttpError from 'http-errors'
import Joi from 'joi'

import {prisma} from '../../db/prisma.js'
import {createServiceAccountCredential} from '../models/service-account-credential.js'

const uuidSchema = Joi.string().guid({version: 'uuidv4'}).required()

const listServiceAccountsQuerySchema = Joi.object({
  includeDeleted: Joi.boolean().truthy('true').falsy('false').default(true)
})

const createServiceAccountSchema = Joi.object({
  name: Joi.string().trim().min(1).max(255).required(),
  description: Joi.string().trim().max(4000).allow('', null),
  isActive: Joi.boolean().default(true)
})

const updateServiceAccountSchema = Joi.object({
  name: Joi.string().trim().min(1).max(255),
  description: Joi.string().trim().max(4000).allow('', null),
  isActive: Joi.boolean()
}).min(1)

const createCredentialSchema = Joi.object({
  name: Joi.string().trim().max(255).allow('', null),
  expiresAt: Joi.alternatives().try(
    Joi.date().iso(),
    Joi.valid('', null)
  )
})

const createDeclarantLinkSchema = Joi.object({
  declarantUserId: Joi.string().guid({version: 'uuidv4'}).required(),
  startDate: Joi.alternatives().try(
    Joi.date().iso(),
    Joi.valid('', null)
  ),
  endDate: Joi.alternatives().try(
    Joi.date().iso(),
    Joi.valid('', null)
  )
})

const updateDeclarantLinkSchema = Joi.object({
  startDate: Joi.alternatives().try(
    Joi.date().iso(),
    Joi.valid('', null)
  ),
  endDate: Joi.alternatives().try(
    Joi.date().iso(),
    Joi.valid('', null)
  )
}).min(1)

const FAR_FUTURE_DATE = new Date('9999-12-31T23:59:59.999Z')

function validateUuid(value, label = 'Identifiant') {
  const {error, value: validated} = uuidSchema.validate(value)

  if (error) {
    throw createHttpError(400, `${label} invalide.`)
  }

  return validated
}

function validatePayload(schema, payload, label) {
  const {error, value} = schema.validate(payload, {
    abortEarly: false,
    convert: true,
    stripUnknown: true
  })

  if (error) {
    throw createHttpError(
      400,
      `${label} invalide : ${error.details.map(detail => detail.message).join(' ')}`
    )
  }

  return value
}

function nullableText(value) {
  if (value === undefined) {
    return undefined
  }

  if (value === null) {
    return null
  }

  const trimmed = String(value).trim()
  return trimmed || null
}

function nullableDate(value) {
  if (value === undefined) {
    return undefined
  }

  if (value === null || value === '') {
    return null
  }

  return new Date(value)
}

function normalizeServiceAccountPayload(payload) {
  return Object.fromEntries(
    Object.entries({
      name: payload.name,
      description: nullableText(payload.description),
      isActive: payload.isActive
    }).filter(([, value]) => value !== undefined)
  )
}

function assertDateRangeIsValid(startDate, endDate) {
  if (startDate && endDate && startDate > endDate) {
    throw createHttpError(400, 'La date de fin doit être postérieure ou égale à la date de début.')
  }
}

function isWindowActive({startDate, endDate}, now = new Date()) {
  const startsAt = new Date(startDate)
  const endsAt = endDate ? new Date(endDate) : null

  return startsAt <= now && (!endsAt || endsAt >= now)
}

function isWindowFuture({startDate}, now = new Date()) {
  return new Date(startDate) > now
}

function isWindowEnded({endDate}, now = new Date()) {
  return Boolean(endDate) && new Date(endDate) < now
}

function getDisplayName({user, declarant} = {}) {
  const person = user ?? declarant?.user ?? {}
  const profile = declarant ?? {}
  const fullName = [person.firstName, person.lastName].filter(Boolean).join(' ').trim()

  return fullName || profile.socialReason || person.email || 'Déclarant sans nom'
}

function serializeDeclarant(declarant) {
  if (!declarant) {
    return null
  }

  const user = declarant.user ?? {}

  return {
    id: declarant.userId,
    userId: declarant.userId,
    email: user.email ?? null,
    firstName: user.firstName ?? null,
    lastName: user.lastName ?? null,
    declarantType: declarant.declarantType,
    socialReason: declarant.socialReason,
    siret: declarant.siret,
    city: declarant.city,
    label: getDisplayName({user, declarant})
  }
}

function serializeCredential(credential, now = new Date()) {
  const isExpired = credential.expiresAt ? new Date(credential.expiresAt) <= now : false
  const isRevoked = Boolean(credential.revokedAt)

  let status = 'ACTIVE'
  let statusLabel = 'Actif'

  if (isRevoked) {
    status = 'REVOKED'
    statusLabel = 'Révoqué'
  } else if (isExpired) {
    status = 'EXPIRED'
    statusLabel = 'Expiré'
  }

  return {
    id: credential.id,
    keyId: credential.keyId,
    name: credential.name,
    lastUsedAt: credential.lastUsedAt,
    expiresAt: credential.expiresAt,
    revokedAt: credential.revokedAt,
    createdAt: credential.createdAt,
    updatedAt: credential.updatedAt,
    isExpired,
    isRevoked,
    isUsable: !isExpired && !isRevoked,
    status,
    statusLabel
  }
}

function serializeDeclarantLink(link, now = new Date()) {
  const active = isWindowActive(link, now)
  const future = isWindowFuture(link, now)
  const ended = isWindowEnded(link, now)

  let status = 'ACTIVE'
  let statusLabel = 'Actif'

  if (future) {
    status = 'FUTURE'
    statusLabel = 'À venir'
  } else if (ended) {
    status = 'ENDED'
    statusLabel = 'Terminé'
  }

  return {
    id: link.id,
    serviceAccountId: link.serviceAccountId,
    declarantUserId: link.declarantUserId,
    startDate: link.startDate,
    endDate: link.endDate,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
    isActive: active,
    isFuture: future,
    isEnded: ended,
    status,
    statusLabel,
    declarant: serializeDeclarant(link.declarant)
  }
}

function getServiceAccountStatus(serviceAccount) {
  if (serviceAccount.deletedAt) {
    return {
      status: 'DELETED',
      statusLabel: 'Supprimé'
    }
  }

  if (!serviceAccount.isActive) {
    return {
      status: 'INACTIVE',
      statusLabel: 'Désactivé'
    }
  }

  return {
    status: 'ACTIVE',
    statusLabel: 'Actif'
  }
}

function serializeServiceAccount(serviceAccount) {
  const now = new Date()
  const credentials = (serviceAccount.credentials ?? [])
    .map(credential => serializeCredential(credential, now))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))

  const declarants = (serviceAccount.declarants ?? [])
    .map(link => serializeDeclarantLink(link, now))
    .sort((a, b) => {
      if (a.isActive !== b.isActive) {
        return a.isActive ? -1 : 1
      }

      return (a.declarant?.label ?? '').localeCompare(b.declarant?.label ?? '', 'fr')
    })

  const status = getServiceAccountStatus(serviceAccount)

  return {
    id: serviceAccount.id,
    name: serviceAccount.name,
    description: serviceAccount.description,
    isActive: serviceAccount.isActive,
    isDeleted: Boolean(serviceAccount.deletedAt),
    sourceId: serviceAccount.sourceId,
    createdAt: serviceAccount.createdAt,
    updatedAt: serviceAccount.updatedAt,
    deletedAt: serviceAccount.deletedAt,
    ...status,
    credentials,
    declarants,
    counts: {
      credentials: credentials.length,
      usableCredentials: credentials.filter(credential => credential.isUsable).length,
      declarants: declarants.length,
      activeDeclarants: declarants.filter(link => link.isActive).length,
      tokens: serviceAccount._count?.serviceAccountTokens ?? 0
    }
  }
}

async function getServiceAccountWithRelations(serviceAccountId, {includeDeleted = true} = {}) {
  return prisma.serviceAccount.findFirst({
    where: {
      id: serviceAccountId,
      ...(includeDeleted ? {} : {deletedAt: null})
    },
    include: {
      credentials: {
        orderBy: {
          createdAt: 'desc'
        }
      },
      declarants: {
        include: {
          declarant: {
            include: {
              user: true
            }
          }
        },
        orderBy: [
          {startDate: 'desc'},
          {createdAt: 'desc'}
        ]
      },
      _count: {
        select: {
          serviceAccountTokens: true
        }
      }
    }
  })
}

async function getServiceAccountOrThrow(serviceAccountId, {includeDeleted = true} = {}) {
  const serviceAccount = await getServiceAccountWithRelations(serviceAccountId, {
    includeDeleted
  })

  if (!serviceAccount) {
    throw createHttpError(404, 'Compte de service introuvable.')
  }

  return serviceAccount
}

function assertServiceAccountIsNotDeleted(serviceAccount) {
  if (serviceAccount.deletedAt) {
    throw createHttpError(410, 'Ce compte de service est supprimé. Restaurez-le avant de le modifier.')
  }
}

async function getDeclarantOrThrow(declarantUserId) {
  const declarant = await prisma.declarant.findFirst({
    where: {
      userId: declarantUserId,
      user: {
        role: 'DECLARANT',
        deletedAt: null
      }
    },
    include: {
      user: true
    }
  })

  if (!declarant) {
    throw createHttpError(404, 'Déclarant introuvable.')
  }

  return declarant
}

function buildOverlappingDeclarantLinkWhere({
  serviceAccountId,
  declarantUserId,
  startDate,
  endDate,
  ignoredLinkId
}) {
  const effectiveEndDate = endDate ?? FAR_FUTURE_DATE

  return {
    serviceAccountId,
    declarantUserId,
    ...(ignoredLinkId ? {id: {not: ignoredLinkId}} : {}),
    startDate: {
      lte: effectiveEndDate
    },
    OR: [
      {endDate: null},
      {
        endDate: {
          gte: startDate
        }
      }
    ]
  }
}

async function assertNoOverlappingDeclarantLink({
  serviceAccountId,
  declarantUserId,
  startDate,
  endDate,
  ignoredLinkId
}) {
  const existing = await prisma.serviceAccountDeclarant.findFirst({
    where: buildOverlappingDeclarantLinkWhere({
      serviceAccountId,
      declarantUserId,
      startDate,
      endDate,
      ignoredLinkId
    }),
    select: {
      id: true
    }
  })

  if (existing) {
    throw createHttpError(
      409,
      'Ce déclarant est déjà rattaché à ce compte de service sur une période qui chevauche celle demandée.'
    )
  }
}

async function revokeServiceAccountTokens(serviceAccountId, tx = prisma) {
  return tx.serviceAccountToken.updateMany({
    where: {
      serviceAccountId,
      revokedAt: null
    },
    data: {
      revokedAt: new Date()
    }
  })
}

async function revokeCredentialTokens(credentialId, tx = prisma) {
  return tx.serviceAccountToken.updateMany({
    where: {
      credentialId,
      revokedAt: null
    },
    data: {
      revokedAt: new Date()
    }
  })
}

async function revokeDeclarantImpersonationTokens(serviceAccountId, declarantUserId, tx = prisma) {
  return tx.serviceAccountToken.updateMany({
    where: {
      serviceAccountId,
      declarantUserId,
      type: 'IMPERSONATION',
      revokedAt: null
    },
    data: {
      revokedAt: new Date()
    }
  })
}

export async function listServiceAccountDeclarantOptionsHandler(req, res) {
  const declarants = await prisma.declarant.findMany({
    where: {
      user: {
        role: 'DECLARANT',
        deletedAt: null
      }
    },
    include: {
      user: true
    }
  })

  const data = declarants
    .map(declarant => serializeDeclarant(declarant))
    .sort((a, b) => a.label.localeCompare(b.label, 'fr'))

  res.status(200).send({
    success: true,
    data
  })
}

export async function listServiceAccountsHandler(req, res) {
  const query = validatePayload(
    listServiceAccountsQuerySchema,
    req.query,
    'Paramètres de recherche'
  )

  const serviceAccounts = await prisma.serviceAccount.findMany({
    where: query.includeDeleted ? {} : {deletedAt: null},
    include: {
      credentials: true,
      declarants: {
        include: {
          declarant: {
            include: {
              user: true
            }
          }
        }
      },
      _count: {
        select: {
          serviceAccountTokens: true
        }
      }
    },
    orderBy: [
      {deletedAt: 'asc'},
      {createdAt: 'desc'}
    ]
  })

  res.status(200).send({
    success: true,
    data: serviceAccounts.map(serviceAccount => serializeServiceAccount(serviceAccount))
  })
}

export async function createServiceAccountHandler(req, res) {
  const payload = validatePayload(
    createServiceAccountSchema,
    req.body,
    'Compte de service'
  )

  const serviceAccount = await prisma.serviceAccount.create({
    data: {
      id: randomUUID(),
      ...normalizeServiceAccountPayload(payload)
    }
  })

  const created = await getServiceAccountWithRelations(serviceAccount.id)

  res.status(201).send({
    success: true,
    data: serializeServiceAccount(created)
  })
}

export async function getServiceAccountHandler(req, res) {
  const serviceAccountId = validateUuid(req.params.serviceAccountId, 'Identifiant de compte de service')
  const serviceAccount = await getServiceAccountOrThrow(serviceAccountId)

  res.status(200).send({
    success: true,
    data: serializeServiceAccount(serviceAccount)
  })
}

export async function updateServiceAccountHandler(req, res) {
  const serviceAccountId = validateUuid(req.params.serviceAccountId, 'Identifiant de compte de service')
  const payload = validatePayload(
    updateServiceAccountSchema,
    req.body,
    'Compte de service'
  )

  const serviceAccount = await getServiceAccountOrThrow(serviceAccountId)
  assertServiceAccountIsNotDeleted(serviceAccount)

  const data = normalizeServiceAccountPayload(payload)

  await prisma.$transaction(async tx => {
    await tx.serviceAccount.update({
      where: {
        id: serviceAccountId
      },
      data
    })

    if (data.isActive === false) {
      await revokeServiceAccountTokens(serviceAccountId, tx)
    }
  })

  const updated = await getServiceAccountWithRelations(serviceAccountId)

  res.status(200).send({
    success: true,
    data: serializeServiceAccount(updated)
  })
}

export async function deleteServiceAccountHandler(req, res) {
  const serviceAccountId = validateUuid(req.params.serviceAccountId, 'Identifiant de compte de service')

  await getServiceAccountOrThrow(serviceAccountId)

  await prisma.$transaction(async tx => {
    await tx.serviceAccount.update({
      where: {
        id: serviceAccountId
      },
      data: {
        isActive: false,
        deletedAt: new Date()
      }
    })

    await tx.serviceAccountCredential.updateMany({
      where: {
        serviceAccountId,
        revokedAt: null
      },
      data: {
        revokedAt: new Date()
      }
    })

    await revokeServiceAccountTokens(serviceAccountId, tx)
  })

  const deleted = await getServiceAccountWithRelations(serviceAccountId)

  res.status(200).send({
    success: true,
    data: serializeServiceAccount(deleted)
  })
}

export async function restoreServiceAccountHandler(req, res) {
  const serviceAccountId = validateUuid(req.params.serviceAccountId, 'Identifiant de compte de service')

  await getServiceAccountOrThrow(serviceAccountId)

  await prisma.serviceAccount.update({
    where: {
      id: serviceAccountId
    },
    data: {
      deletedAt: null,
      isActive: true
    }
  })

  const restored = await getServiceAccountWithRelations(serviceAccountId)

  res.status(200).send({
    success: true,
    data: serializeServiceAccount(restored)
  })
}

export async function listServiceAccountCredentialsHandler(req, res) {
  const serviceAccountId = validateUuid(req.params.serviceAccountId, 'Identifiant de compte de service')
  const serviceAccount = await getServiceAccountOrThrow(serviceAccountId)

  res.status(200).send({
    success: true,
    data: serializeServiceAccount(serviceAccount).credentials
  })
}

export async function createServiceAccountCredentialHandler(req, res) {
  const serviceAccountId = validateUuid(req.params.serviceAccountId, 'Identifiant de compte de service')
  const payload = validatePayload(
    createCredentialSchema,
    req.body,
    'Identifiant technique'
  )

  const serviceAccount = await getServiceAccountOrThrow(serviceAccountId)
  assertServiceAccountIsNotDeleted(serviceAccount)

  const expiresAt = nullableDate(payload.expiresAt)
  if (expiresAt && expiresAt <= new Date()) {
    throw createHttpError(400, 'La date d’expiration doit être dans le futur.')
  }

  const createdCredential = await createServiceAccountCredential(serviceAccountId, {
    name: nullableText(payload.name) ?? null,
    expiresAt: expiresAt ?? null
  })

  const credential = await prisma.serviceAccountCredential.findUnique({
    where: {
      id: createdCredential.id
    }
  })

  const account = await getServiceAccountWithRelations(serviceAccountId)

  res.status(201).send({
    success: true,
    data: {
      account: serializeServiceAccount(account),
      credential: serializeCredential(credential),
      keyId: createdCredential.keyId,
      clientSecret: createdCredential.clientSecret
    }
  })
}

export async function revokeServiceAccountCredentialHandler(req, res) {
  const serviceAccountId = validateUuid(req.params.serviceAccountId, 'Identifiant de compte de service')
  const credentialId = validateUuid(req.params.credentialId, 'Identifiant technique')

  await getServiceAccountOrThrow(serviceAccountId)

  const credential = await prisma.serviceAccountCredential.findFirst({
    where: {
      id: credentialId,
      serviceAccountId
    }
  })

  if (!credential) {
    throw createHttpError(404, 'Identifiant technique introuvable.')
  }

  await prisma.$transaction(async tx => {
    if (!credential.revokedAt) {
      await tx.serviceAccountCredential.update({
        where: {
          id: credentialId
        },
        data: {
          revokedAt: new Date()
        }
      })
    }

    await revokeCredentialTokens(credentialId, tx)
  })

  const account = await getServiceAccountWithRelations(serviceAccountId)

  res.status(200).send({
    success: true,
    data: serializeServiceAccount(account)
  })
}

export async function listServiceAccountDeclarantsHandler(req, res) {
  const serviceAccountId = validateUuid(req.params.serviceAccountId, 'Identifiant de compte de service')
  const serviceAccount = await getServiceAccountOrThrow(serviceAccountId)

  res.status(200).send({
    success: true,
    data: serializeServiceAccount(serviceAccount).declarants
  })
}

export async function addServiceAccountDeclarantHandler(req, res) {
  const serviceAccountId = validateUuid(req.params.serviceAccountId, 'Identifiant de compte de service')
  const payload = validatePayload(
    createDeclarantLinkSchema,
    req.body,
    'Rattachement déclarant'
  )

  const serviceAccount = await getServiceAccountOrThrow(serviceAccountId)
  assertServiceAccountIsNotDeleted(serviceAccount)
  await getDeclarantOrThrow(payload.declarantUserId)

  const startDate = nullableDate(payload.startDate) ?? new Date()
  const endDate = nullableDate(payload.endDate) ?? null

  assertDateRangeIsValid(startDate, endDate)

  await assertNoOverlappingDeclarantLink({
    serviceAccountId,
    declarantUserId: payload.declarantUserId,
    startDate,
    endDate
  })

  await prisma.serviceAccountDeclarant.create({
    data: {
      id: randomUUID(),
      serviceAccountId,
      declarantUserId: payload.declarantUserId,
      startDate,
      endDate
    }
  })

  const account = await getServiceAccountWithRelations(serviceAccountId)

  res.status(201).send({
    success: true,
    data: serializeServiceAccount(account)
  })
}

export async function updateServiceAccountDeclarantHandler(req, res) {
  const serviceAccountId = validateUuid(req.params.serviceAccountId, 'Identifiant de compte de service')
  const linkId = validateUuid(req.params.linkId, 'Identifiant de rattachement')
  const payload = validatePayload(
    updateDeclarantLinkSchema,
    req.body,
    'Rattachement déclarant'
  )

  const serviceAccount = await getServiceAccountOrThrow(serviceAccountId)
  assertServiceAccountIsNotDeleted(serviceAccount)

  const currentLink = await prisma.serviceAccountDeclarant.findFirst({
    where: {
      id: linkId,
      serviceAccountId
    }
  })

  if (!currentLink) {
    throw createHttpError(404, 'Rattachement déclarant introuvable.')
  }

  const startDate = nullableDate(payload.startDate) ?? currentLink.startDate
  const endDate = payload.endDate === undefined
    ? currentLink.endDate
    : nullableDate(payload.endDate)

  assertDateRangeIsValid(startDate, endDate)

  await assertNoOverlappingDeclarantLink({
    serviceAccountId,
    declarantUserId: currentLink.declarantUserId,
    startDate,
    endDate,
    ignoredLinkId: linkId
  })

  const updatedLink = await prisma.serviceAccountDeclarant.update({
    where: {
      id: linkId
    },
    data: {
      startDate,
      endDate
    }
  })

  if (!isWindowActive(updatedLink)) {
    await revokeDeclarantImpersonationTokens(
      serviceAccountId,
      currentLink.declarantUserId
    )
  }

  const account = await getServiceAccountWithRelations(serviceAccountId)

  res.status(200).send({
    success: true,
    data: serializeServiceAccount(account)
  })
}

export async function removeServiceAccountDeclarantHandler(req, res) {
  const serviceAccountId = validateUuid(req.params.serviceAccountId, 'Identifiant de compte de service')
  const linkId = validateUuid(req.params.linkId, 'Identifiant de rattachement')

  const serviceAccount = await getServiceAccountOrThrow(serviceAccountId)
  assertServiceAccountIsNotDeleted(serviceAccount)

  const link = await prisma.serviceAccountDeclarant.findFirst({
    where: {
      id: linkId,
      serviceAccountId
    }
  })

  if (!link) {
    throw createHttpError(404, 'Rattachement déclarant introuvable.')
  }

  await prisma.$transaction(async tx => {
    await tx.serviceAccountDeclarant.delete({
      where: {
        id: linkId
      }
    })

    await revokeDeclarantImpersonationTokens(
      serviceAccountId,
      link.declarantUserId,
      tx
    )
  })

  const account = await getServiceAccountWithRelations(serviceAccountId)

  res.status(200).send({
    success: true,
    data: serializeServiceAccount(account)
  })
}
