import createHttpError from 'http-errors'
import Joi from 'joi'

import {prisma} from '../../db/prisma.js'
import {activeWindowWhere, getPointPrelevement} from '../models/point-prelevement.js'
import {defaultExploitationInclude, getExploitation} from '../models/exploitation.js'
import {getDeclarantsByInstructor} from '../models/declarant.js'
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

const uuidSchema = Joi.string().guid({version: 'uuidv4'}).required()
const DEFAULT_PAGE = 1
const DEFAULT_PER_PAGE = 20
const MAX_PER_PAGE = 100

const STATUS_VALUES = new Set(['EN_ACTIVITE', 'NON_RENSEIGNE', 'ABANDONNEE', 'TERMINEE'])
const DECLARANT_ROLE_VALUES = new Set(['PRELEVEUR', 'COLLECTEUR'])
const COLLECTEUR_FILTER_VALUES = new Set(['WITH_COLLECTEUR', 'WITHOUT_COLLECTEUR'])
const EMAIL_FILTER_VALUES = new Set(['WITH_EMAIL', 'WITHOUT_EMAIL'])
const USAGE_VALUES = new Set([
  'INCONNU',
  'PAS_D_USAGE',
  'IRRIGATION',
  'AGRICULTURE_ELEVAGE',
  'AQUACULTURE',
  'INDUSTRIE',
  'AEP',
  'ENERGIE',
  'LOISIRS',
  'EMBOUTEILLAGE',
  'THERMALISME_THALASSO',
  'DEFENSE_INCENDIE',
  'REALIMENTATION_EAU',
  'CANAUX',
  'ETIAGE',
  'ENTRETIEN_VOIRIES',
  'ALIMENTATION_SOUTIEN_CANAL',
  'DOMESTIQUE'
])

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
  const normalized = normalizeEnumSearch(value)
  return USAGE_VALUES.has(normalized) ? normalized : null
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

async function getZoneRightOrThrow(user, zoneId, {requireAdmin = false} = {}) {
  if (isGlobalAdmin(user)) {
    const zone = await getZoneById(zoneId)

    if (!zone) {
      throw createHttpError(404, 'Cette zone est introuvable.')
    }

    return {
      zone,
      isAdmin: true,
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

  if (requireAdmin && !right.isAdmin) {
    throw createHttpError(403, 'Droits insuffisants. Vous devez être admin de cette zone.')
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
    declarantType: declarant.declarantType ?? null,
    declarantRole: declarant.declarantRole ?? 'PRELEVEUR',
    socialReason: declarant.socialReason ?? null,
    civility: declarant.civility ?? null,
    siret: declarant.siret ?? null,
    city: declarant.city ?? null,
    phoneNumber: declarant.phoneNumber ?? null,
    declarant: declarant.declarant || {
      socialReason: declarant.socialReason ?? null,
      declarantType: declarant.declarantType ?? null,
      declarantRole: declarant.declarantRole ?? 'PRELEVEUR'
    },
    user
  }
}

async function listDeclarantOptionsForUser(user) {
  if (isGlobalAdmin(user)) {
    const users = await prisma.user.findMany({
      where: {
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

  const users = await getDeclarantsByInstructor(user.id)
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
      ...(status ? [{status}] : []),
      ...(usage ? [{usages: {has: usage}}] : [])
    ]
  }
}

function getZoneExploitationFilterWhere(filters = {}) {
  const AND = []

  if (filters.status) {
    AND.push({status: filters.status})
  }

  if (filters.usage) {
    AND.push({usages: {has: filters.usage}})
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

function directPreleveurInZoneWhere(zoneId) {
  return {
    declarantRole: 'PRELEVEUR',
    pointPrelevements: {
      some: {
        pointPrelevement: pointInZoneWhere(zoneId)
      }
    }
  }
}

function collecteurInZoneWhere(zoneId) {
  return {
    declarantRole: 'COLLECTEUR',
    collecteurExploitations: {
      some: {
        exploitation: {
          pointPrelevement: pointInZoneWhere(zoneId)
        }
      }
    }
  }
}

function getZoneDeclarantBaseWhere(zoneId, declarantRole = null) {
  const base = {
    role: 'DECLARANT',
    deletedAt: null
  }

  if (declarantRole === 'PRELEVEUR') {
    return {
      ...base,
      declarant: directPreleveurInZoneWhere(zoneId)
    }
  }

  if (declarantRole === 'COLLECTEUR') {
    return {
      ...base,
      declarant: collecteurInZoneWhere(zoneId)
    }
  }

  return {
    ...base,
    declarant: {
      OR: [
        directPreleveurInZoneWhere(zoneId),
        collecteurInZoneWhere(zoneId)
      ]
    }
  }
}

function getZoneDeclarantSearchWhere(search) {
  if (!search) {
    return {}
  }

  const declarantRole = getDeclarantRoleSearch(search)

  return {
    OR: [
      {email: stringSearch(search)},
      {firstName: stringSearch(search)},
      {lastName: stringSearch(search)},
      {declarant: {socialReason: stringSearch(search)}},
      {declarant: {phoneNumber: stringSearch(search)}},
      {declarant: {city: stringSearch(search)}},
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

function getZoneDeclarantFilterWhere(filters = {}) {
  const where = {}

  if (filters.email === 'WITH_EMAIL') {
    where.email = {not: null}
  }

  if (filters.email === 'WITHOUT_EMAIL') {
    where.email = null
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
      usages: link.usages ?? [],
      collecteurs: link.collecteurs ?? []
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
        usages: exploitation?.usages ?? [],
        preleveurUserId: preleveur?.userId,
        preleveurLabel: preleveurLabel(preleveur),
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
        usages: link.usages ?? []
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
    declarantType: declarant.declarantType,
    declarantRole: declarant.declarantRole ?? 'PRELEVEUR',
    civility: declarant.civility,
    socialReason: declarant.socialReason,
    siret: declarant.siret,
    phoneNumber: declarant.phoneNumber,
    city: declarant.city,
    declarant: {
      socialReason: declarant.socialReason,
      declarantType: declarant.declarantType,
      declarantRole: declarant.declarantRole ?? 'PRELEVEUR',
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

export async function getZoneGeometryHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')

  const right = await getZoneRightOrThrow(req.user, zoneId)

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
      isAdmin: right.isAdmin
    },
    geometry: zone.geometry
  })
}

export async function listZonePointsPrelevementHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')
  const query = parseListQuery(req.query)

  await getZoneRightOrThrow(req.user, zoneId)

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

  await getZoneRightOrThrow(req.user, zoneId)

  const points = await prisma.pointPrelevement.findMany({
    where: getZonePointBaseWhere(zoneId),
    select: {
      id: true,
      name: true
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

  await getZoneRightOrThrow(req.user, zoneId)

  const point = await getPointInZone(zoneId, pointId)

  if (!point) {
    throw createHttpError(404, 'Ce point de prélèvement est introuvable.')
  }

  res.send(await decoratePointPrelevement(point, {user: req.user}))
}

export async function createZonePointPrelevementHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')

  await getZoneRightOrThrow(req.user, zoneId, {requireAdmin: true})
  await assertCoordinatesInZone(zoneId, req.body.coordinates)

  const point = await createPointPrelevement(req.body, {user: req.user})
  await assertPointInZone(point.id, zoneId)

  res.status(201).send(await decoratePointPrelevement(point, {user: req.user}))
}

export async function updateZonePointPrelevementHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')
  const pointId = validateUuid(req.params.pointId, 'Identifiant de point')

  await getZoneRightOrThrow(req.user, zoneId, {requireAdmin: true})
  await assertPointInZone(pointId, zoneId)

  if (Object.hasOwn(req.body, 'coordinates')) {
    await assertCoordinatesInZone(zoneId, req.body.coordinates)
  }

  const point = await updatePointPrelevement(pointId, req.body, {user: req.user})
  await assertPointInZone(point.id, zoneId)

  res.send(await decoratePointPrelevement(point, {user: req.user}))
}

export async function deleteZonePointPrelevementHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')
  const pointId = validateUuid(req.params.pointId, 'Identifiant de point')

  await getZoneRightOrThrow(req.user, zoneId, {requireAdmin: true})
  await assertPointInZone(pointId, zoneId)

  const deletedPoint = await deletePointPrelevement(pointId)

  if (!deletedPoint) {
    throw createHttpError(404, 'Ce point de prélèvement est introuvable.')
  }

  res.send(deletedPoint)
}

export async function listZoneExploitationsHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')
  const query = parseListQuery(req.query)

  await getZoneRightOrThrow(req.user, zoneId)

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

  await getZoneRightOrThrow(req.user, zoneId)

  const exploitation = await getExploitationInZone(zoneId, exploitationId)

  if (!exploitation) {
    throw createHttpError(404, 'Cette exploitation est introuvable dans cette zone.')
  }

  res.send(await decorateZoneExploitation(exploitation, req.user))
}

export async function createZoneExploitationHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')

  await getZoneRightOrThrow(req.user, zoneId, {requireAdmin: true})

  if (!req.body?.pointPrelevementId) {
    throw createHttpError(400, 'Le point de prélèvement est obligatoire.')
  }

  await assertPointInZone(req.body.pointPrelevementId, zoneId)

  const exploitation = await createExploitation(req.body, {user: req.user})

  res.status(201).send(await decorateZoneExploitation(exploitation, req.user))
}

export async function updateZoneExploitationHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')
  const exploitationId = validateUuid(req.params.exploitationId, 'Identifiant d’exploitation')

  await getZoneRightOrThrow(req.user, zoneId, {requireAdmin: true})

  const existing = await getExploitationInZone(zoneId, exploitationId)

  if (!existing) {
    throw createHttpError(404, 'Cette exploitation est introuvable dans cette zone.')
  }

  if (req.body?.pointPrelevementId) {
    await assertPointInZone(req.body.pointPrelevementId, zoneId)
  }

  const exploitation = await updateExploitation(exploitationId, req.body, {user: req.user})

  res.send(await decorateZoneExploitation(exploitation, req.user))
}

export async function deleteZoneExploitationHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')
  const exploitationId = validateUuid(req.params.exploitationId, 'Identifiant d’exploitation')

  await getZoneRightOrThrow(req.user, zoneId, {requireAdmin: true})

  const existing = await getExploitationInZone(zoneId, exploitationId)

  if (!existing) {
    throw createHttpError(404, 'Cette exploitation est introuvable dans cette zone.')
  }

  const deleted = await deleteExploitation(exploitationId)

  res.send(deleted)
}

export async function listZoneDeclarantOptionsHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')

  await getZoneRightOrThrow(req.user, zoneId, {requireAdmin: true})

  const options = await listDeclarantOptionsForUser(req.user)

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

  await getZoneRightOrThrow(req.user, zoneId)

  const baseWhere = getZoneDeclarantBaseWhere(zoneId, declarantRole)
  const where = {
    ...baseWhere,
    ...getZoneDeclarantFilterWhere(query.filters),
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
