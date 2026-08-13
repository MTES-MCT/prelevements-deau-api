import {Buffer} from 'node:buffer'

import createHttpError from 'http-errors'
import ExcelJS from 'exceljs'
import Joi from 'joi'

import {prisma} from '../../db/prisma.js'
import {stageAuditMutation} from '../audit/mutations.js'
import {ZONE_PERMISSION_CODES} from '../constants/zone-permissions.js'
import {activeWindowWhere, getPointPrelevement} from '../models/point-prelevement.js'
import {defaultExploitationInclude, getExploitation} from '../models/exploitation.js'
import {
  createPointPrelevement,
  decoratePointPrelevement,
  decoratePointsPrelevement,
  deletePointPrelevement,
  updatePointPrelevement
} from '../services/point-prelevement.js'
import {
  createExploitation,
  decorateExploitation,
  deleteExploitation,
  updateExploitation
} from '../services/exploitation.js'
import {getEffectiveDeclarantUserIdsByZone} from '../services/zone-permissions.js'
import {
  legacyUsageToRootUsageCode,
  normalizeWaterUseCode
} from '../constants/sandre-water-uses.js'
import {serializeWaterUse} from '../services/sandre-water-uses.js'
import {
  getDeclarationPeriodKey,
  getDeclarationPeriodKeysBetween,
  getDeclarationPeriodLabel,
  getDeclarationPeriodStart,
  getNextDeclarationPeriodStart,
  parseDeclarationPeriodKey,
  parseDeclarationPeriodType
} from '../util/declaration-periods.js'
import {normalizeSiretSearch} from '../util/search-identifiers.js'

const uuidSchema = Joi.string().guid({version: 'uuidv4'}).required()
const DEFAULT_PAGE = 1
const DEFAULT_PER_PAGE = 20
const MAX_PER_PAGE = 100
const DEFAULT_MATRIX_PERIODS = 12
const MAX_MATRIX_PERIODS = 36
const PERIOD_TYPES_BY_PRIORITY = new Map([
  ['month', 1],
  ['week', 2]
])
const PERIOD_TYPE_FROM_DB = new Map([
  ['MONTH', 'month'],
  ['WEEK', 'week']
])

const STATUS_VALUES = new Set(['EN_ACTIVITE', 'NON_RENSEIGNE', 'ABANDONNEE', 'TERMINEE'])
const DECLARANT_ROLE_VALUES = new Set(['PRELEVEUR', 'COLLECTEUR'])
const COLLECTEUR_FILTER_VALUES = new Set(['WITH_COLLECTEUR', 'WITHOUT_COLLECTEUR'])
const EMAIL_FILTER_VALUES = new Set(['WITH_EMAIL', 'WITHOUT_EMAIL'])
const STATUS_SEARCH_ALIASES = new Map([
  ['EN ACTIVITE', 'EN_ACTIVITE'],
  ['EN ACTIVITÉ', 'EN_ACTIVITE'],
  ['ACTIVE', 'EN_ACTIVITE'],
  ['ACTIF', 'EN_ACTIVITE'],
  ['ACTIFS', 'EN_ACTIVITE'],
  ['TERMINEE', 'TERMINEE'],
  ['TERMINÉE', 'TERMINEE'],
  ['TERMINE', 'TERMINEE'],
  ['TERMINÉ', 'TERMINEE'],
  ['ABANDONNEE', 'ABANDONNEE'],
  ['ABANDONNÉE', 'ABANDONNEE'],
  ['ABANDONNE', 'ABANDONNEE'],
  ['ABANDONNÉ', 'ABANDONNEE'],
  ['NON RENSEIGNE', 'NON_RENSEIGNE'],
  ['NON RENSEIGNÉ', 'NON_RENSEIGNE']
])

const DECLARANT_ROLE_ALIASES = new Map([
  ['PRELEVEUR', 'PRELEVEUR'],
  ['PRÉLEVEUR', 'PRELEVEUR'],
  ['PRELEVEURS', 'PRELEVEUR'],
  ['PRÉLEVEURS', 'PRELEVEUR'],
  ['COLLECTEUR', 'COLLECTEUR'],
  ['COLLECTEURS', 'COLLECTEUR']
])

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

function optionalText(value) {
  if (value === undefined || value === null) {
    return null
  }

  const trimmed = String(value).trim()
  return trimmed || null
}

function parsePositiveInteger(value, fallback, {max = Number.MAX_SAFE_INTEGER} = {}) {
  const parsed = Number.parseInt(value, 10)

  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback
  }

  return Math.min(parsed, max)
}

function normalizeEnumSearch(value) {
  return String(value || '')
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036F]/g, '')
    .toUpperCase()
    .replaceAll(/[^A-Z\d]+/g, '_')
    .replaceAll(/^_+|_+$/g, '')
}

function getStatusSearch(value) {
  const normalized = normalizeEnumSearch(value)
  const spaced = String(value || '').trim().toUpperCase()

  if (STATUS_VALUES.has(normalized)) {
    return normalized
  }

  return STATUS_SEARCH_ALIASES.get(spaced) ?? null
}

function getDeclarantRoleSearch(value) {
  const normalized = normalizeEnumSearch(value)

  if (DECLARANT_ROLE_VALUES.has(normalized)) {
    return normalized
  }

  return DECLARANT_ROLE_ALIASES.get(String(value || '').trim().toUpperCase()) ?? null
}

function getCollecteurFilter(value) {
  const normalized = normalizeEnumSearch(value)

  if (COLLECTEUR_FILTER_VALUES.has(normalized)) {
    return normalized
  }

  if (['AVEC_COLLECTEUR', 'AVEC_COLLECTEURS'].includes(normalized)) {
    return 'WITH_COLLECTEUR'
  }

  if (['SANS_COLLECTEUR', 'SANS_COLLECTEURS'].includes(normalized)) {
    return 'WITHOUT_COLLECTEUR'
  }

  return null
}

function getEmailFilter(value) {
  const normalized = normalizeEnumSearch(value)

  if (EMAIL_FILTER_VALUES.has(normalized)) {
    return normalized
  }

  if (['AVEC_EMAIL', 'AVEC_MAIL'].includes(normalized)) {
    return 'WITH_EMAIL'
  }

  if (['SANS_EMAIL', 'SANS_MAIL'].includes(normalized)) {
    return 'WITHOUT_EMAIL'
  }

  return null
}

function getUsageSearch(value) {
  return legacyUsageToRootUsageCode(value) ?? normalizeWaterUseCode(value)
}

function parseListQuery(query = {}) {
  const page = parsePositiveInteger(query.page, DEFAULT_PAGE)
  const perPage = parsePositiveInteger(query.perPage, DEFAULT_PER_PAGE, {max: MAX_PER_PAGE})
  const search = optionalText(query.search) || ''

  return {
    page,
    perPage,
    search,
    filters: {
      declarantRole: getDeclarantRoleSearch(query.declarantRole ?? query.role),
      status: getStatusSearch(query.status),
      usage: getUsageSearch(query.usage),
      collecteur: getCollecteurFilter(query.collecteur ?? query.collector),
      email: getEmailFilter(query.email ?? query.emailStatus)
    },
    skip: (page - 1) * perPage,
    take: perPage
  }
}

function createPaginationMeta({page, perPage, total, totalAll, count, search, filters}) {
  return {
    page,
    perPage,
    total,
    totalAll,
    count,
    pages: Math.max(1, Math.ceil(total / perPage)),
    search: search || null,
    filters: filters || {}
  }
}

function sendPaginated(res, data, query, {total, totalAll}) {
  res.send({
    data,
    meta: createPaginationMeta({
      page: query.page,
      perPage: query.perPage,
      total,
      totalAll,
      count: data.length,
      search: query.search,
      filters: query.filters
    })
  })
}

function stringSearch(value) {
  return {
    contains: value,
    mode: 'insensitive'
  }
}

async function getZoneById(zoneId) {
  return prisma.zone.findUnique({
    where: {id: zoneId},
    select: {
      id: true,
      type: true,
      code: true,
      name: true
    }
  })
}

export async function getZoneRightOrThrow(user, zoneId, {permission} = {}) {
  if (isGlobalAdmin(user)) {
    const zone = await getZoneById(zoneId)

    if (!zone) {
      throw createHttpError(404, 'Cette zone est introuvable.')
    }

    return {
      zone,
      isAdmin: true,
      permissions: [],
      startDate: null,
      endDate: null
    }
  }

  const right = await prisma.instructorZone.findFirst({
    where: {
      instructorUserId: user.id,
      zoneId,
      ...activeWindowWhere(new Date(), {
        startNullable: false,
        endNullable: true
      })
    },
    include: {
      permissions: true,
      zone: {
        select: {
          id: true,
          type: true,
          code: true,
          name: true
        }
      }
    }
  })

  if (!right) {
    throw createHttpError(403, 'Vous n’avez pas accès à cette zone.')
  }

  if (permission && !right.permissions.some(item => item.permission === permission)) {
    throw createHttpError(403, 'Vous ne disposez pas de ce droit sur cette zone.')
  }

  return right
}

async function isPointInZone(pointPrelevementId, zoneId) {
  const point = await prisma.pointPrelevement.findFirst({
    where: {
      id: pointPrelevementId,
      deletedAt: null,
      zones: {
        some: {zoneId}
      }
    },
    select: {id: true}
  })

  return Boolean(point)
}

async function assertPointInZone(pointPrelevementId, zoneId) {
  const allowed = await isPointInZone(pointPrelevementId, zoneId)

  if (!allowed) {
    throw createHttpError(404, 'Ce point de prélèvement n’est pas rattaché à cette zone.')
  }
}

function getCoordinatesPair(coordinates) {
  if (
    !coordinates
    || coordinates.type !== 'Point'
    || !Array.isArray(coordinates.coordinates)
    || coordinates.coordinates.length !== 2
  ) {
    throw createHttpError(400, 'Les coordonnées du point sont invalides.')
  }

  const [longitude, latitude] = coordinates.coordinates

  if (
    typeof longitude !== 'number'
    || typeof latitude !== 'number'
    || !Number.isFinite(longitude)
    || !Number.isFinite(latitude)
    || longitude < -180
    || longitude > 180
    || latitude < -90
    || latitude > 90
  ) {
    throw createHttpError(400, 'Les coordonnées du point sont invalides.')
  }

  return {longitude, latitude}
}

async function assertCoordinatesInZone(zoneId, coordinates) {
  const {longitude, latitude} = getCoordinatesPair(coordinates)

  const rows = await prisma.$queryRaw`
    SELECT EXISTS (
      SELECT 1
      FROM "Zone"
      WHERE id = ${zoneId}::uuid
        AND ST_Intersects(
          coordinates,
          ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)
        )
    ) AS intersects
  `

  if (!rows?.[0]?.intersects) {
    throw createHttpError(
      400,
      'Les coordonnées du point doivent se situer dans la zone administrée.'
    )
  }
}

async function getPointInZone(zoneId, pointId) {
  await assertPointInZone(pointId, zoneId)
  return getPointPrelevement(pointId)
}

async function getExploitationInZone(zoneId, exploitationId) {
  const exploitation = await getExploitation(exploitationId)

  if (!exploitation) {
    return null
  }

  if (!await isPointInZone(exploitation.pointPrelevementId, zoneId)) {
    return null
  }

  return exploitation
}

async function decorateZoneExploitation(exploitation, user) {
  if (!exploitation) {
    return null
  }

  const decorated = await decorateExploitation(exploitation, {user})

  if (!exploitation.declarant) {
    return decorated
  }

  const {user: declarantUser, ...declarantData} = exploitation.declarant

  return {
    ...decorated,
    declarant: {
      ...declarantData,
      ...declarantUser,
      id: declarantData.userId,
      userId: declarantData.userId,
      user: declarantUser
    }
  }
}

function serializeDeclarantOption(item) {
  const user = item.user ?? item
  const declarant = item.declarant ?? item
  const userId = user.id ?? declarant.userId

  return {
    id: userId,
    userId,
    email: user.email ?? null,
    firstName: user.firstName ?? null,
    lastName: user.lastName ?? null,
    lastLoginAt: user.lastLoginAt ?? null,
    declarantType: declarant.declarantType ?? null,
    declarantRole: declarant.declarantRole ?? 'PRELEVEUR',
    preleveurType: declarant.preleveurType ?? null,
    socialReason: declarant.socialReason ?? null,
    civility: declarant.civility ?? null,
    siret: declarant.siret ?? null,
    city: declarant.city ?? null,
    phoneNumber: declarant.phoneNumber ?? null,
    declarant: declarant.declarant || {
      socialReason: declarant.socialReason ?? null,
      declarantType: declarant.declarantType ?? null,
      declarantRole: declarant.declarantRole ?? 'PRELEVEUR',
      preleveurType: declarant.preleveurType ?? null
    },
    user
  }
}

export async function listDeclarantOptionsForZone(zoneId, {client = prisma} = {}) {
  const declarantUserIdsByZone = await getEffectiveDeclarantUserIdsByZone(
    [zoneId],
    {client}
  )
  const declarantUserIds = declarantUserIdsByZone.get(zoneId) ?? []

  if (declarantUserIds.length === 0) {
    return []
  }

  const users = await client.user.findMany({
    where: {
      id: {in: declarantUserIds},
      role: 'DECLARANT',
      deletedAt: null
    },
    include: {
      declarant: true
    },
    orderBy: [
      {lastName: 'asc'},
      {firstName: 'asc'},
      {email: 'asc'}
    ]
  })

  return users.map(serializeDeclarantOption)
}

function pointInZoneWhere(zoneId) {
  return {
    deletedAt: null,
    zones: {
      some: {zoneId}
    }
  }
}

function getZonePointBaseWhere(zoneId) {
  return pointInZoneWhere(zoneId)
}

function getZonePointSearchWhere(search) {
  if (!search) {
    return {}
  }

  return {
    OR: [
      {name: stringSearch(search)},
      {communeName: stringSearch(search)},
      {communeCode: stringSearch(search)},
      {codeBSS: stringSearch(search)},
      {codeBNPE: stringSearch(search)},
      {codeAIOT: stringSearch(search)},
      {codePTP: stringSearch(search)},
      {declarants: {
        some: {
          declarant: {
            user: {
              OR: [
                {email: stringSearch(search)},
                {firstName: stringSearch(search)},
                {lastName: stringSearch(search)}
              ]
            }
          }
        }
      }},
      {declarants: {
        some: {
          declarant: {
            socialReason: stringSearch(search)
          }
        }
      }}
    ]
  }
}

function getZoneExploitationBaseWhere(zoneId) {
  return {
    pointPrelevement: pointInZoneWhere(zoneId),
    declarant: {
      declarantRole: 'PRELEVEUR',
      user: {
        deletedAt: null
      }
    }
  }
}

function getZoneExploitationSearchWhere(search) {
  if (!search) {
    return {}
  }

  const status = getStatusSearch(search)
  const usage = getUsageSearch(search)

  return {
    OR: [
      {pointPrelevement: {name: stringSearch(search)}},
      {pointPrelevement: {codeBSS: stringSearch(search)}},
      {declarant: {user: {email: stringSearch(search)}}},
      {declarant: {user: {firstName: stringSearch(search)}}},
      {declarant: {user: {lastName: stringSearch(search)}}},
      {declarant: {socialReason: stringSearch(search)}},
      {collecteurs: {
        some: {
          collecteur: {
            OR: [
              {socialReason: stringSearch(search)},
              {user: {email: stringSearch(search)}},
              {user: {firstName: stringSearch(search)}},
              {user: {lastName: stringSearch(search)}}
            ]
          }
        }
      }},
      {comment: stringSearch(search)},
      {usage: {is: {label: stringSearch(search)}}},
      {usage: {is: {mnemonic: stringSearch(search)}}},
      ...(status ? [{status}] : []),
      ...(usage ? [{usage: {is: {code: usage}}}] : [])
    ]
  }
}

function getZoneExploitationFilterWhere(filters = {}) {
  const AND = []

  if (filters.status) {
    AND.push({status: filters.status})
  }

  if (filters.usage) {
    AND.push({usage: {is: {code: filters.usage}}})
  }

  if (filters.collecteur === 'WITH_COLLECTEUR') {
    AND.push({
      collecteurs: {
        some: {
          collecteur: {
            user: {
              deletedAt: null
            }
          }
        }
      }
    })
  }

  if (filters.collecteur === 'WITHOUT_COLLECTEUR') {
    AND.push({
      collecteurs: {
        none: {}
      }
    })
  }

  return AND.length > 0 ? {AND} : {}
}

export function getZoneDeclarantBaseWhere(declarantUserIds = [], declarantRole = null) {
  return {
    id: {in: [...new Set(declarantUserIds)]},
    role: 'DECLARANT',
    deletedAt: null,
    ...(declarantRole ? {declarant: {declarantRole}} : {})
  }
}

function getZoneDeclarantSearchWhere(search) {
  if (!search) {
    return {}
  }

  const declarantRole = getDeclarantRoleSearch(search)
  const siretSearch = normalizeSiretSearch(search)

  return {
    OR: [
      {email: stringSearch(search)},
      {firstName: stringSearch(search)},
      {lastName: stringSearch(search)},
      {declarant: {socialReason: stringSearch(search)}},
      {declarant: {phoneNumber: stringSearch(search)}},
      {declarant: {city: stringSearch(search)}},
      ...(siretSearch ? [{declarant: {siret: stringSearch(siretSearch)}}] : []),
      ...(declarantRole ? [{declarant: {declarantRole}}] : []),
      {declarant: {
        pointPrelevements: {
          some: {
            pointPrelevement: {
              name: stringSearch(search)
            }
          }
        }
      }},
      {declarant: {
        collecteurExploitations: {
          some: {
            exploitation: {
              pointPrelevement: {
                name: stringSearch(search)
              }
            }
          }
        }
      }},
      {declarant: {
        collecteurExploitations: {
          some: {
            exploitation: {
              declarant: {
                socialReason: stringSearch(search)
              }
            }
          }
        }
      }}
    ]
  }
}

function getZoneDeclarantCollecteurFilterWhere(collecteurFilter, zoneId) {
  if (collecteurFilter === 'WITH_COLLECTEUR') {
    return {
      declarant: {
        declarantRole: 'PRELEVEUR',
        pointPrelevements: {
          some: {
            pointPrelevement: pointInZoneWhere(zoneId),
            collecteurs: {
              some: {}
            }
          }
        }
      }
    }
  }

  if (collecteurFilter === 'WITHOUT_COLLECTEUR') {
    return {
      declarant: {
        declarantRole: 'PRELEVEUR',
        pointPrelevements: {
          none: {
            pointPrelevement: pointInZoneWhere(zoneId),
            collecteurs: {
              some: {}
            }
          }
        }
      }
    }
  }

  return null
}

function getZoneDeclarantFilterWhere(filters = {}, zoneId) {
  const where = {}
  const AND = []

  if (filters.email === 'WITH_EMAIL') {
    where.email = {not: null}
  }

  if (filters.email === 'WITHOUT_EMAIL') {
    where.email = null
  }

  const collecteurWhere = getZoneDeclarantCollecteurFilterWhere(filters.collecteur, zoneId)
  if (collecteurWhere) {
    AND.push(collecteurWhere)
  }

  if (AND.length > 0) {
    where.AND = AND
  }

  return where
}

function getZoneDeclarantInclude(zoneId) {
  return {
    declarant: {
      include: {
        pointPrelevements: {
          where: {
            pointPrelevement: pointInZoneWhere(zoneId)
          },
          include: {
            pointPrelevement: {
              select: {
                id: true,
                name: true
              }
            },
            usage: true,
            collecteurs: {
              include: {
                collecteur: {
                  include: {
                    user: true
                  }
                }
              },
              orderBy: {
                createdAt: 'asc'
              }
            }
          },
          orderBy: {
            createdAt: 'asc'
          }
        },
        collecteurExploitations: {
          where: {
            exploitation: {
              pointPrelevement: pointInZoneWhere(zoneId)
            }
          },
          include: {
            exploitation: {
              include: {
                pointPrelevement: {
                  select: {
                    id: true,
                    name: true
                  }
                },
                usage: true,
                declarant: {
                  include: {
                    user: true
                  }
                }
              }
            }
          },
          orderBy: {
            createdAt: 'asc'
          }
        }
      }
    }
  }
}

function preleveurLabel(declarant) {
  const user = declarant?.user
  const socialReason = optionalText(declarant?.socialReason)

  if (socialReason) {
    return socialReason
  }

  return [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.email || 'Préleveur sans nom'
}

function collecteurLabel(collecteur) {
  const user = collecteur?.user
  const socialReason = optionalText(collecteur?.socialReason)

  if (socialReason) {
    return socialReason
  }

  return [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.email || 'Collecteur sans nom'
}

function normalizeCollecteurLink(link) {
  const {collecteur} = link

  if (!collecteur) {
    return null
  }

  return {
    id: link.id,
    collecteurUserId: collecteur.userId,
    label: collecteurLabel(collecteur),
    email: collecteur.user?.email ?? null,
    firstName: collecteur.user?.firstName ?? null,
    lastName: collecteur.user?.lastName ?? null,
    lastLoginAt: collecteur.user?.lastLoginAt ?? null,
    socialReason: collecteur.socialReason ?? null
  }
}

function normalizeZoneDeclarant(user, zoneId) {
  const declarant = user.declarant ?? {}
  const directPoints = (declarant.pointPrelevements ?? [])
    .map(link => ({
      id: link.pointPrelevement?.id,
      name: link.pointPrelevement?.name,
      exploitationId: link.id,
      status: link.status,
      startDate: link.startDate,
      endDate: link.endDate,
      usage: serializeWaterUse(link.usage),
      collecteurs: (link.collecteurs ?? []).map(normalizeCollecteurLink).filter(Boolean)
    }))
    .filter(point => point.id)

  const collecteurExploitations = (declarant.collecteurExploitations ?? [])
    .map(link => {
      const {exploitation} = link
      const point = exploitation?.pointPrelevement
      const preleveur = exploitation?.declarant

      return {
        id: link.id,
        exploitationId: exploitation?.id,
        pointPrelevementId: point?.id,
        pointName: point?.name,
        status: exploitation?.status,
        startDate: exploitation?.startDate,
        endDate: exploitation?.endDate,
        usage: serializeWaterUse(exploitation?.usage),
        preleveurUserId: preleveur?.userId,
        preleveurLabel: preleveurLabel(preleveur),
        preleveurLastLoginAt: preleveur?.user?.lastLoginAt ?? null,
        createdAt: link.createdAt,
        updatedAt: link.updatedAt
      }
    })
    .filter(link => link.exploitationId && link.pointPrelevementId)

  const pointsById = new Map()

  for (const point of directPoints) {
    pointsById.set(point.id, point)
  }

  for (const link of collecteurExploitations) {
    if (!pointsById.has(link.pointPrelevementId)) {
      pointsById.set(link.pointPrelevementId, {
        id: link.pointPrelevementId,
        name: link.pointName,
        exploitationId: link.exploitationId,
        status: link.status,
        startDate: link.startDate,
        endDate: link.endDate,
        usage: link.usage ?? null,
        collecteurs: []
      })
    }
  }

  const points = [...pointsById.values()]
    .filter(point => point.id)
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'fr'))

  return {
    id: user.id,
    userId: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    lastLoginAt: user.lastLoginAt,
    declarantType: declarant.declarantType,
    declarantRole: declarant.declarantRole ?? 'PRELEVEUR',
    preleveurType: declarant.preleveurType ?? null,
    civility: declarant.civility,
    socialReason: declarant.socialReason,
    siret: declarant.siret,
    phoneNumber: declarant.phoneNumber,
    city: declarant.city,
    declarant: {
      socialReason: declarant.socialReason,
      declarantType: declarant.declarantType,
      declarantRole: declarant.declarantRole ?? 'PRELEVEUR',
      preleveurType: declarant.preleveurType ?? null,
      _count: {
        pointPrelevements: directPoints.length,
        collecteurExploitations: collecteurExploitations.length
      }
    },
    zoneId,
    points,
    collecteurExploitations
  }
}

function parseMatrixToPeriod(value, periodType) {
  const raw = optionalText(value)

  if (!raw) {
    return getDeclarationPeriodKey(periodType)
  }

  const periodKey = parseDeclarationPeriodKey(raw, periodType)

  if (!periodKey) {
    throw createHttpError(400, 'Le paramètre "to" est invalide pour ce type de période.')
  }

  return periodKey
}

function createPeriodDescriptor(periodType, periodKey) {
  const start = getDeclarationPeriodStart(periodType, periodKey)
  const end = new Date(getNextDeclarationPeriodStart(periodType, periodKey).getTime() - 1)

  return {
    key: periodKey,
    periodType,
    label: periodType === 'week'
      ? periodKey
      : start.toLocaleDateString('fr-FR', {month: 'short', year: '2-digit', timeZone: 'UTC'}),
    fullLabel: getDeclarationPeriodLabel(periodType, periodKey),
    start,
    end
  }
}

function getPreviousMatrixPeriodKey(periodType, periodKey) {
  const start = getDeclarationPeriodStart(periodType, periodKey)
  const previous = new Date(start)

  if (periodType === 'week') {
    previous.setUTCDate(previous.getUTCDate() - 7)
  } else {
    previous.setUTCMonth(previous.getUTCMonth() - 1)
  }

  return getDeclarationPeriodKey(periodType, previous)
}

function buildPeriodDescriptors({to, periodType, periodsCount}) {
  let periodKey = parseMatrixToPeriod(to, periodType)
  const periods = []

  for (let index = 0; index < periodsCount; index++) {
    periods.unshift(createPeriodDescriptor(periodType, periodKey))

    periodKey = getPreviousMatrixPeriodKey(periodType, periodKey)
  }

  return periods
}

function parseMatrixQuery(query = {}) {
  const selectedPeriodKey = optionalText(query.periodKey)

  if (selectedPeriodKey) {
    const periodType = parseDeclarationPeriodType(query.periodType)
    const periodKey = parseDeclarationPeriodKey(selectedPeriodKey, periodType)

    if (!periodKey) {
      throw createHttpError(400, 'La période sélectionnée est invalide.')
    }

    const periods = [createPeriodDescriptor(periodType, periodKey)]

    return {
      periodType,
      periodMode: 'selected',
      periods,
      periodsCount: 1,
      from: periodKey,
      to: periodKey,
      fromDate: periods[0].start,
      toDate: periods[0].end
    }
  }

  const periodsCount = parsePositiveInteger(
    query.periodCount ?? query.periods ?? query.months,
    DEFAULT_MATRIX_PERIODS,
    {max: MAX_MATRIX_PERIODS}
  )
  const periods = buildPeriodDescriptors({
    to: query.to,
    periodType: 'month',
    periodsCount
  })

  return {
    periodType: 'mixed',
    periodMode: 'expected',
    periods,
    periodsCount,
    from: periods[0].key,
    to: periods.at(-1).key,
    fromDate: periods[0].start,
    toDate: periods.at(-1).end
  }
}

function dateOrNull(value) {
  if (!value) {
    return null
  }

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function overlapsPeriod(range, period) {
  const start = dateOrNull(range.startDate ?? range.minDate)
  const end = dateOrNull(range.endDate ?? range.maxDate)

  if (start && start > period.end) {
    return false
  }

  if (end && end < period.start) {
    return false
  }

  return true
}

function fromDbPeriodType(periodType) {
  return PERIOD_TYPE_FROM_DB.get(periodType) ?? 'month'
}

function getPeriodTypePriority(periodType) {
  return PERIOD_TYPES_BY_PRIORITY.get(periodType) ?? 0
}

function getZoneExpectedPeriodType(zone, period) {
  const override = (zone.declarationOverrides ?? [])
    .find(item => overlapsPeriod(item, period))

  return override
    ? fromDbPeriodType(override.periodType)
    : fromDbPeriodType(zone.declarationSettings?.defaultPeriodType ?? 'MONTH')
}

function getExpectedPeriodTypeForExploitation(exploitation, period) {
  const zones = (exploitation.pointPrelevement?.zones ?? [])
    .map(link => link.zone)
    .filter(Boolean)

  if (zones.length === 0) {
    return null
  }

  return zones
    .map(zone => getZoneExpectedPeriodType(zone, period))
    .sort((a, b) => getPeriodTypePriority(b) - getPeriodTypePriority(a))[0] ?? null
}

function isPeriodTypeExpectedForExploitation(exploitation, period) {
  return getExpectedPeriodTypeForExploitation(exploitation, period) === period.periodType
}

function isExploitationExpectedForPeriod(exploitation, period) {
  if (exploitation.status === 'ABANDONNEE') {
    return false
  }

  return overlapsPeriod(exploitation, period)
}

function isDeclarationExpectedForMatrixPeriod(exploitation, period) {
  return isExploitationExpectedForPeriod(exploitation, period)
    && isPeriodTypeExpectedForExploitation(exploitation, period)
}

function shouldIncludePeriod(exploitations, period) {
  return exploitations.some(exploitation => isDeclarationExpectedForMatrixPeriod(exploitation, period))
}

function buildExpectedMatrixPeriods({exploitations, basePeriods}) {
  const periodsByKey = new Map()

  for (const monthPeriod of basePeriods) {
    if (shouldIncludePeriod(exploitations, monthPeriod)) {
      periodsByKey.set(monthPeriod.key, monthPeriod)
    }

    const weekKeys = getDeclarationPeriodKeysBetween('week', monthPeriod.start, monthPeriod.end)

    for (const weekKey of weekKeys) {
      const weekPeriod = createPeriodDescriptor('week', weekKey)

      if (shouldIncludePeriod(exploitations, weekPeriod)) {
        periodsByKey.set(weekPeriod.key, weekPeriod)
      }
    }
  }

  const periods = [...periodsByKey.values()]
    .sort((a, b) => a.start - b.start || getPeriodTypePriority(a.periodType) - getPeriodTypePriority(b.periodType))

  return periods.length > 0 ? periods : basePeriods
}

function declarationActorLabel(actor) {
  if (!actor) {
    return null
  }

  const user = actor.user ?? actor
  const socialReason = optionalText(actor.socialReason)

  if (socialReason) {
    return socialReason
  }

  return [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email || null
}

function normalizeDeclarationForCell(declaration, globalInstructionStatus) {
  return {
    id: declaration.id,
    code: declaration.code,
    createdAt: declaration.createdAt,
    createdByDeclarantUserId: declaration.createdByDeclarantUserId,
    createdByDeclarantLabel: declarationActorLabel(declaration.createdByDeclarant),
    globalInstructionStatus
  }
}

function addDeclarationToPeriodIndex(index, {key, declaration}) {
  const current = index.get(key) ?? new Map()
  current.set(declaration.id, declaration)
  index.set(key, current)
}

function createDeclarationIndex(chunks, periods) {
  const declarationIndex = new Map()

  for (const chunk of chunks) {
    const declaration = chunk.source?.declaration

    if (!declaration || !chunk.pointPrelevementId) {
      continue
    }

    for (const period of periods) {
      if (!overlapsPeriod(chunk, period)) {
        continue
      }

      const key = `${chunk.pointPrelevementId}:${period.key}`
      addDeclarationToPeriodIndex(declarationIndex, {
        key,
        declaration: normalizeDeclarationForCell(declaration, chunk.source?.globalInstructionStatus)
      })
    }
  }

  return declarationIndex
}

function getCellStatus({declarations, isExpected}) {
  if (!isExpected) {
    return 'INACTIVE'
  }

  return declarations.length > 0 ? 'DECLARED' : 'MISSING'
}

function incrementMatrixSummary(summary, {status, isExpected}) {
  summary[status.toLowerCase()] += 1

  if (isExpected) {
    summary.expected += 1
  }

  summary.totalCells += 1
}

function createMatrixCell({declarationIndex, exploitation, period, pointId, summary}) {
  const declarationsById = declarationIndex.get(`${pointId}:${period.key}`)
  const declarations = declarationsById ? [...declarationsById.values()] : []
  const expectedPeriodType = getExpectedPeriodTypeForExploitation(exploitation, period)
  const isExpected = isExploitationExpectedForPeriod(exploitation, period)
    && expectedPeriodType === period.periodType
  const status = getCellStatus({declarations, isExpected})

  incrementMatrixSummary(summary, {status, isExpected})

  return {
    period: period.key,
    month: period.key,
    periodType: period.periodType,
    periodLabel: period.fullLabel,
    expectedPeriodType,
    status,
    expected: isExpected,
    declarationsCount: declarations.length,
    declarations
  }
}

function createMatrixRows({exploitations, chunks, periods}) {
  const declarationIndex = createDeclarationIndex(chunks, periods)
  const groupsByDeclarantId = new Map()
  const rows = []
  const summary = {
    declared: 0,
    missing: 0,
    inactive: 0,
    expected: 0,
    totalCells: 0,
    rows: 0
  }

  for (const exploitation of exploitations) {
    const {declarant} = exploitation
    const declarantUser = declarant?.user
    const declarantId = declarant?.userId
    const point = exploitation.pointPrelevement

    if (!declarantId || !point?.id) {
      continue
    }

    const cells = periods.map(period => createMatrixCell({
      declarationIndex,
      exploitation,
      period,
      pointId: point.id,
      summary
    }))

    const collecteurs = (exploitation.collecteurs ?? [])
      .map(normalizeCollecteurLink)
      .filter(Boolean)

    const row = {
      id: exploitation.id,
      exploitationId: exploitation.id,
      declarantUserId: declarantId,
      declarantLabel: preleveurLabel(declarant),
      declarantEmail: declarantUser?.email ?? null,
      declarantFirstName: declarantUser?.firstName ?? null,
      declarantLastName: declarantUser?.lastName ?? null,
      declarantLastLoginAt: declarantUser?.lastLoginAt ?? null,
      declarantPhoneNumber: declarant.phoneNumber ?? null,
      declarantSocialReason: declarant.socialReason ?? null,
      pointPrelevementId: point.id,
      pointName: point.name,
      resourceName: point.resourceName ?? null,
      exploitationStatus: exploitation.status,
      startDate: exploitation.startDate,
      endDate: exploitation.endDate,
      usage: serializeWaterUse(exploitation.usage),
      collecteurs,
      cells
    }

    rows.push(row)
    summary.rows += 1

    const group = groupsByDeclarantId.get(declarantId) ?? {
      declarantUserId: declarantId,
      declarantLabel: row.declarantLabel,
      declarantEmail: row.declarantEmail,
      declarantLastLoginAt: row.declarantLastLoginAt,
      rows: []
    }

    group.rows.push(row)
    groupsByDeclarantId.set(declarantId, group)
  }

  const groups = [...groupsByDeclarantId.values()]
    .map(group => ({
      ...group,
      rows: group.rows.sort((a, b) => a.pointName.localeCompare(b.pointName, 'fr'))
    }))
    .sort((a, b) => a.declarantLabel.localeCompare(b.declarantLabel, 'fr'))

  return {
    groups,
    rows,
    summary
  }
}

function exportValue(value) {
  return optionalText(value) ?? 'Non renseigné'
}

function exportList(values = []) {
  const normalized = [...new Set(values.map(value => optionalText(value)).filter(Boolean))]

  return normalized.length > 0 ? normalized.join(', ') : 'Non renseigné'
}

function createMissingDeclarationsWorkbook({matrix, periods}) {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Non déclarants')
  const periodsByKey = new Map(periods.map(period => [period.key, period]))

  sheet.columns = [
    {header: 'Raison sociale', key: 'socialReason', width: 28},
    {header: 'Nom', key: 'lastName', width: 20},
    {header: 'Prénom', key: 'firstName', width: 20},
    {header: 'Mail', key: 'email', width: 32},
    {header: 'Téléphone', key: 'phoneNumber', width: 18},
    {header: 'Point concerné', key: 'pointName', width: 32},
    {header: 'Usage', key: 'usage', width: 24},
    {header: 'Ressource', key: 'resourceName', width: 24},
    {header: 'Période attendue', key: 'period', width: 24},
    {header: 'Collecteurs', key: 'collecteurs', width: 32},
    {header: 'Mails collecteurs', key: 'collecteurEmails', width: 36}
  ]

  for (const row of matrix.rows) {
    const missingCells = row.cells.filter(cell => cell.status === 'MISSING')

    for (const cell of missingCells) {
      const period = periodsByKey.get(cell.period)

      sheet.addRow({
        socialReason: exportValue(row.declarantSocialReason),
        lastName: exportValue(row.declarantLastName),
        firstName: exportValue(row.declarantFirstName),
        email: exportValue(row.declarantEmail),
        phoneNumber: exportValue(row.declarantPhoneNumber),
        pointName: exportValue(row.pointName),
        usage: exportValue(row.usage?.label),
        resourceName: exportValue(row.resourceName),
        period: exportValue(period?.fullLabel ?? period?.label ?? cell.period),
        collecteurs: exportList(row.collecteurs.map(collecteur => collecteur.label)),
        collecteurEmails: exportList(row.collecteurs.map(collecteur => collecteur.email))
      })
    }
  }

  sheet.getRow(1).font = {bold: true}
  sheet.views = [{state: 'frozen', ySplit: 1}]
  sheet.autoFilter = {
    from: 'A1',
    to: 'K1'
  }

  return workbook
}

async function getZoneExploitationsForMatrix(zoneId) {
  const include = defaultExploitationInclude()
  include.pointPrelevement = {
    include: {
      zones: {
        where: {zoneId},
        include: {
          zone: {
            include: {
              declarationSettings: true,
              declarationOverrides: true
            }
          }
        }
      }
    }
  }

  return prisma.declarantPointPrelevement.findMany({
    where: getZoneExploitationBaseWhere(zoneId),
    include,
    orderBy: [
      {createdAt: 'asc'}
    ]
  })
}

async function getChunksForMatrix({pointIds, fromDate, toDate}) {
  if (pointIds.length === 0) {
    return []
  }

  return prisma.chunk.findMany({
    where: {
      pointPrelevementId: {in: pointIds},
      minDate: {lte: toDate},
      maxDate: {gte: fromDate},
      source: {
        type: 'DECLARATION'
      }
    },
    select: {
      id: true,
      pointPrelevementId: true,
      minDate: true,
      maxDate: true,
      source: {
        select: {
          id: true,
          globalInstructionStatus: true,
          declaration: {
            select: {
              id: true,
              code: true,
              createdAt: true,
              declarantUserId: true,
              createdByDeclarantUserId: true,
              createdByDeclarant: {
                select: {
                  userId: true,
                  socialReason: true,
                  user: {
                    select: {
                      email: true,
                      firstName: true,
                      lastName: true
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    orderBy: [
      {minDate: 'asc'},
      {createdAt: 'asc'}
    ]
  })
}

export async function getZoneGeometryHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')

  const right = await getZoneRightOrThrow(req.user, zoneId, {permission: 'zone.geometry.read'})

  const rows = await prisma.$queryRaw`
    SELECT
      id,
      name,
      type,
      code,
      ST_AsGeoJSON(coordinates)::json AS geometry
    FROM "Zone"
    WHERE id = ${zoneId}::uuid
  `

  const zone = rows?.[0]

  if (!zone?.geometry) {
    throw createHttpError(404, 'Géométrie de zone introuvable.')
  }

  res.send({
    type: 'Feature',
    properties: {
      id: zone.id,
      name: zone.name,
      type: zone.type,
      code: zone.code,
      isAdmin: isGlobalAdmin(req.user) || right.permissions.length === ZONE_PERMISSION_CODES.length
    },
    geometry: zone.geometry
  })
}

export async function listZonePointsPrelevementHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')
  const query = parseListQuery(req.query)

  await getZoneRightOrThrow(req.user, zoneId, {permission: 'pp.list'})

  const baseWhere = getZonePointBaseWhere(zoneId)
  const where = {
    ...baseWhere,
    ...getZonePointSearchWhere(query.search)
  }

  const [totalAll, total, points] = await Promise.all([
    prisma.pointPrelevement.count({where: baseWhere}),
    prisma.pointPrelevement.count({where}),
    prisma.pointPrelevement.findMany({
      where,
      include: {
        zones: {
          include: {
            zone: true
          }
        },
        declarants: true
      },
      orderBy: [
        {name: 'asc'}
      ],
      skip: query.skip,
      take: query.take
    })
  ])

  const decorated = await decoratePointsPrelevement(points, {user: req.user})
  sendPaginated(res, decorated, query, {total, totalAll})
}

export async function listZonePointOptionsHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')

  await getZoneRightOrThrow(req.user, zoneId, {permission: 'pp.list'})

  const points = await prisma.pointPrelevement.findMany({
    where: getZonePointBaseWhere(zoneId),
    select: {
      id: true,
      name: true,
      codeBSS: true
    },
    orderBy: {
      name: 'asc'
    }
  })

  res.send(points)
}

export async function getZonePointPrelevementHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')
  const pointId = validateUuid(req.params.pointId, 'Identifiant de point')

  await getZoneRightOrThrow(req.user, zoneId, {permission: 'pp.detail.read'})

  const point = await getPointInZone(zoneId, pointId)

  if (!point) {
    throw createHttpError(404, 'Ce point de prélèvement est introuvable.')
  }

  res.send(await decoratePointPrelevement(point, {user: req.user}))
}

export async function createZonePointPrelevementHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')

  await getZoneRightOrThrow(req.user, zoneId, {permission: 'pp.create'})
  await assertCoordinatesInZone(zoneId, req.body.coordinates)

  const point = await createPointPrelevement(req.body, {user: req.user})
  await assertPointInZone(point.id, zoneId)

  stageAuditMutation(req, {
    operation: 'CREATE',
    entityType: 'POINT',
    entityId: point.id,
    entityLabel: point.usageName || point.name,
    after: point
  })

  res.status(201).send(await decoratePointPrelevement(point, {user: req.user}))
}

export async function updateZonePointPrelevementHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')
  const pointId = validateUuid(req.params.pointId, 'Identifiant de point')

  await getZoneRightOrThrow(req.user, zoneId, {permission: 'pp.update'})
  const existing = await getPointInZone(zoneId, pointId)

  if (Object.hasOwn(req.body, 'coordinates')) {
    await assertCoordinatesInZone(zoneId, req.body.coordinates)
  }

  const point = await updatePointPrelevement(pointId, req.body, {user: req.user})
  await assertPointInZone(point.id, zoneId)

  stageAuditMutation(req, {
    operation: 'UPDATE',
    entityType: 'POINT',
    entityId: point.id,
    entityLabel: point.usageName || point.name,
    before: existing,
    after: point
  })

  res.send(await decoratePointPrelevement(point, {user: req.user}))
}

export async function deleteZonePointPrelevementHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')
  const pointId = validateUuid(req.params.pointId, 'Identifiant de point')

  await getZoneRightOrThrow(req.user, zoneId, {permission: 'pp.delete'})
  const existing = await getPointInZone(zoneId, pointId)

  const deletedPoint = await deletePointPrelevement(pointId)

  if (!deletedPoint) {
    throw createHttpError(404, 'Ce point de prélèvement est introuvable.')
  }

  stageAuditMutation(req, {
    operation: 'DELETE',
    entityType: 'POINT',
    entityId: existing.id,
    entityLabel: existing.usageName || existing.name,
    before: existing
  })

  res.send(deletedPoint)
}

export async function listZoneExploitationsHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')
  const query = parseListQuery(req.query)

  await getZoneRightOrThrow(req.user, zoneId, {permission: 'exploitation.list'})

  const baseWhere = getZoneExploitationBaseWhere(zoneId)
  const where = {
    ...baseWhere,
    ...getZoneExploitationFilterWhere(query.filters),
    ...getZoneExploitationSearchWhere(query.search)
  }

  const [totalAll, total, exploitations] = await Promise.all([
    prisma.declarantPointPrelevement.count({where: baseWhere}),
    prisma.declarantPointPrelevement.count({where}),
    prisma.declarantPointPrelevement.findMany({
      where,
      include: defaultExploitationInclude(),
      orderBy: [
        {createdAt: 'desc'}
      ],
      skip: query.skip,
      take: query.take
    })
  ])

  const decorated = await Promise.all(
    exploitations.map(exploitation => decorateZoneExploitation(exploitation, req.user))
  )

  sendPaginated(res, decorated, query, {total, totalAll})
}

export async function getZoneExploitationHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')
  const exploitationId = validateUuid(req.params.exploitationId, 'Identifiant d’exploitation')

  await getZoneRightOrThrow(req.user, zoneId, {permission: 'exploitation.detail.read'})

  const exploitation = await getExploitationInZone(zoneId, exploitationId)

  if (!exploitation) {
    throw createHttpError(404, 'Cette exploitation est introuvable dans cette zone.')
  }

  res.send(await decorateZoneExploitation(exploitation, req.user))
}

export async function createZoneExploitationHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')

  await getZoneRightOrThrow(req.user, zoneId, {permission: 'exploitation.create'})

  if (!req.body?.pointPrelevementId) {
    throw createHttpError(400, 'Le point de prélèvement est obligatoire.')
  }

  await assertPointInZone(req.body.pointPrelevementId, zoneId)

  const exploitation = await createExploitation(req.body, {user: req.user})

  stageAuditMutation(req, {
    operation: 'CREATE',
    entityType: 'EXPLOITATION',
    entityId: exploitation.id,
    before: null,
    after: exploitation
  })

  res.status(201).send(await decorateZoneExploitation(exploitation, req.user))
}

export async function updateZoneExploitationHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')
  const exploitationId = validateUuid(req.params.exploitationId, 'Identifiant d’exploitation')

  await getZoneRightOrThrow(req.user, zoneId, {permission: 'exploitation.update'})

  const existing = await getExploitationInZone(zoneId, exploitationId)

  if (!existing) {
    throw createHttpError(404, 'Cette exploitation est introuvable dans cette zone.')
  }

  if (req.body?.pointPrelevementId) {
    await assertPointInZone(req.body.pointPrelevementId, zoneId)
  }

  const exploitation = await updateExploitation(exploitationId, req.body, {user: req.user})

  stageAuditMutation(req, {
    operation: 'UPDATE',
    entityType: 'EXPLOITATION',
    entityId: exploitation.id,
    before: existing,
    after: exploitation
  })

  res.send(await decorateZoneExploitation(exploitation, req.user))
}

export async function deleteZoneExploitationHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')
  const exploitationId = validateUuid(req.params.exploitationId, 'Identifiant d’exploitation')

  await getZoneRightOrThrow(req.user, zoneId, {permission: 'exploitation.delete'})

  const existing = await getExploitationInZone(zoneId, exploitationId)

  if (!existing) {
    throw createHttpError(404, 'Cette exploitation est introuvable dans cette zone.')
  }

  const deleted = await deleteExploitation(exploitationId)

  stageAuditMutation(req, {
    operation: 'DELETE',
    entityType: 'EXPLOITATION',
    entityId: existing.id,
    before: existing
  })

  res.send(deleted)
}

export async function listZoneDeclarantOptionsHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')

  const right = await getZoneRightOrThrow(req.user, zoneId)
  const permissions = new Set(
    (right.permissions ?? []).map(item => item.permission ?? item)
  )

  if (!isGlobalAdmin(req.user)
    && !permissions.has('exploitation.create')
    && !permissions.has('exploitation.update')) {
    throw createHttpError(403, 'Vous ne disposez pas du droit de gérer les exploitations de cette zone.')
  }

  const options = await listDeclarantOptionsForZone(zoneId)

  res.send(options.sort((a, b) => {
    const labelA = optionalText(a.socialReason) || `${a.firstName || ''} ${a.lastName || ''}`.trim() || a.email || ''
    const labelB = optionalText(b.socialReason) || `${b.firstName || ''} ${b.lastName || ''}`.trim() || b.email || ''

    return labelA.localeCompare(labelB, 'fr')
  }))
}

async function listZoneDeclarantsByRole(req, res, forcedDeclarantRole = null) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')
  const query = parseListQuery(req.query)
  const declarantRole = forcedDeclarantRole ?? query.filters.declarantRole

  await getZoneRightOrThrow(req.user, zoneId, {permission: 'declarant.list'})

  const declarantUserIdsByZone = await getEffectiveDeclarantUserIdsByZone([zoneId])
  const declarantUserIds = declarantUserIdsByZone.get(zoneId) ?? []
  const baseWhere = getZoneDeclarantBaseWhere(declarantUserIds, declarantRole)
  const where = {
    ...baseWhere,
    ...getZoneDeclarantFilterWhere(query.filters, zoneId),
    ...getZoneDeclarantSearchWhere(query.search)
  }

  const [totalAll, total, users] = await Promise.all([
    prisma.user.count({where: baseWhere}),
    prisma.user.count({where}),
    prisma.user.findMany({
      where,
      include: getZoneDeclarantInclude(zoneId),
      orderBy: [
        {lastName: 'asc'},
        {firstName: 'asc'},
        {email: 'asc'}
      ],
      skip: query.skip,
      take: query.take
    })
  ])

  sendPaginated(
    res,
    users.map(user => normalizeZoneDeclarant(user, zoneId)),
    {
      ...query,
      filters: {
        ...query.filters,
        declarantRole
      }
    },
    {total, totalAll}
  )
}

export async function listZoneDeclarantsHandler(req, res) {
  await listZoneDeclarantsByRole(req, res)
}

export async function listZoneCollecteursHandler(req, res) {
  await listZoneDeclarantsByRole(req, res, 'COLLECTEUR')
}

export async function getZoneDeclarationMonthlyStatusHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')
  const matrixQuery = parseMatrixQuery(req.query)

  await getZoneRightOrThrow(req.user, zoneId, {permission: 'declaration.followup.read'})

  const exploitations = await getZoneExploitationsForMatrix(zoneId)
  const periods = matrixQuery.periodMode === 'expected'
    ? buildExpectedMatrixPeriods({
      exploitations,
      basePeriods: matrixQuery.periods
    })
    : matrixQuery.periods
  const pointIds = [...new Set(exploitations.map(exploitation => exploitation.pointPrelevementId).filter(Boolean))]
  const chunks = await getChunksForMatrix({
    pointIds,
    fromDate: matrixQuery.fromDate,
    toDate: matrixQuery.toDate
  })

  const matrix = createMatrixRows({
    exploitations,
    chunks,
    periods
  })

  const serializedPeriods = periods.map(period => ({
    key: period.key,
    periodType: period.periodType,
    label: period.label,
    fullLabel: period.fullLabel
  }))

  res.send({
    data: {
      periodType: matrixQuery.periodType,
      periodMode: matrixQuery.periodMode,
      periods: serializedPeriods,
      months: serializedPeriods,
      groups: matrix.groups,
      rows: matrix.rows,
      legend: [
        {status: 'DECLARED', label: 'Déclaration déposée sur cette période'},
        {status: 'MISSING', label: 'Déclaration attendue mais non trouvée'},
        {status: 'INACTIVE', label: 'Exploitation inactive ou hors période'}
      ]
    },
    meta: {
      zoneId,
      periodType: matrixQuery.periodType,
      from: matrixQuery.from,
      to: matrixQuery.to,
      periodsCount: periods.length,
      monthsCount: matrixQuery.periodsCount,
      generatedAt: new Date().toISOString(),
      summary: matrix.summary
    }
  })
}

export async function exportZoneDeclarationMissingHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')
  const periodType = parseDeclarationPeriodType(req.query.periodType)
  const periodKey = parseDeclarationPeriodKey(req.query.periodKey ?? req.query.to, periodType)

  if (!periodKey) {
    throw createHttpError(400, 'La période à exporter est obligatoire.')
  }

  const query = {
    periodType,
    periodKey
  }
  const matrixQuery = parseMatrixQuery(query)

  await getZoneRightOrThrow(req.user, zoneId, {permission: 'declaration.followup.export'})

  const exploitations = await getZoneExploitationsForMatrix(zoneId)
  const pointIds = [...new Set(exploitations.map(exploitation => exploitation.pointPrelevementId).filter(Boolean))]
  const chunks = await getChunksForMatrix({
    pointIds,
    fromDate: matrixQuery.fromDate,
    toDate: matrixQuery.toDate
  })
  const matrix = createMatrixRows({
    exploitations,
    chunks,
    periods: matrixQuery.periods
  })
  const workbook = createMissingDeclarationsWorkbook({
    matrix,
    periods: matrixQuery.periods
  })
  const buffer = await workbook.xlsx.writeBuffer()
  const filename = `non-declarants-${matrixQuery.periodType}-${matrixQuery.to}.xlsx`

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.send(Buffer.from(buffer))
}
