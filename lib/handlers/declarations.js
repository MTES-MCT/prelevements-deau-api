import createHttpError from 'http-errors'
import Joi from 'joi'
import crypto, {randomUUID} from 'node:crypto'
import path from 'node:path'
import {Buffer} from 'node:buffer'

import createStorageClient from '../util/s3.js'
import {prisma} from '../../db/prisma.js'
import {activeWindowWhere, getCoordsByPointIds} from '../models/point-prelevement.js'
import {getCollecteurPreleveurs, updateLastDeclarationAt} from '../models/declarant.js'
import {getPreleveurIdsForCollecteur} from '../models/exploitation.js'
import {computeGlobalPointMatchingStatus} from './chunks.js'
import {
  decorateDeclarationsWithDeclarationTypes,
  findAllowedDeclarationTypeForDeclarant,
  listAllowedDeclarationTypesForDeclarant,
  normalizeDeclarationTypeCode
} from '../models/declaration-type.js'
import {METRIC_TYPE_CODES} from '../constants/metric-type-codes.js'
import {notifyDeclarationUploaded} from '../services/orchestration-client.js'
import {INDEX_METRIC_TYPE_CODES, reconstructVolumesFromIndexForPoint} from '../services/volumes-from-index.js'

export const DECLARATIONS_BUCKET = 'declarations'

const DOSSIER_ALPHABET = 'ACDEFHJMNPRTUVWY23479'

export function generateDossierCode(length = 6) {
  const bytes = crypto.randomBytes(length)
  let code = ''

  for (let i = 0; i < length; i++) {
    code += DOSSIER_ALPHABET[bytes[i] % DOSSIER_ALPHABET.length]
  }

  return code
}

export function safeFilename(filename) {
  const base = path.basename(filename || 'file')
  return base
    .normalize('NFC')
    .replaceAll(/[^\p{L}\p{N}._-]+/gu, '_')
    .slice(0, 180)
}

function uuid() {
  return crypto.randomUUID()
}

function normalizeRepeatedField(value) {
  if (Array.isArray(value)) {
    return value
  }

  if (typeof value === 'string') {
    return [value]
  }

  return null
}

const createDeclarationSchema = Joi.object({
  type: Joi.string().trim().min(1).max(120).required(),
  declarantUserId: Joi.string().uuid({version: 'uuidv4'}).optional(),
  preleveurUserId: Joi.string().uuid({version: 'uuidv4'}).optional(),
  targetDeclarantUserId: Joi.string().uuid({version: 'uuidv4'}).optional(),
  comment: Joi.string().trim().max(20_000).allow('').optional(),
  aotDecreeNumber: Joi.string().trim().max(255).allow('').optional(),

  fileTypes: Joi.alternatives()
    .try(
      Joi.string().trim().min(1).max(120),
      Joi.array().items(Joi.string().trim().min(1).max(120)).min(1).max(50)
    )
    .optional()
}).unknown(true)

const declarationIdSchema = Joi.object({
  declarationId: Joi.string().uuid({version: 'uuidv4'}).required()
})

const reconcileDeclarationChunkSchema = Joi.object({
  pointPrelevementId: Joi.alternatives()
    .try(
      Joi.string().uuid({version: 'uuidv4'}),
      Joi.valid(null)
    )
    .required()
}).unknown(false)

const USAGE_EAU_VALUES = [
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
]

const USAGE_EAU_SET = new Set(USAGE_EAU_VALUES)

function isUsageEau(value) {
  return typeof value === 'string' && USAGE_EAU_SET.has(value)
}

function mergeUsageFirst(usages = [], preferredUsage = null) {
  return [
    ...new Set([
      preferredUsage,
      ...(Array.isArray(usages) ? usages : [])
    ].filter(isUsageEau))
  ]
}

function appendMissingUsage(usages = [], usage) {
  const existingUsages = Array.isArray(usages) ? usages : []

  if (!isUsageEau(usage) || existingUsages.includes(usage)) {
    return existingUsages
  }

  return [...existingUsages, usage]
}

function activeWindowOverlapsWhere(startDate, endDate) {
  return {
    AND: [
      {OR: [{startDate: null}, {startDate: {lte: endDate}}]},
      {OR: [{endDate: null}, {endDate: {gte: startDate}}]}
    ]
  }
}

function normalizePointNameAlias(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replaceAll(/\p{Diacritic}/gu, '')
    .trim()
    .replaceAll(/\s+/g, ' ')
    .toLocaleLowerCase('fr-FR')
}

function appendMissingPointNameAlias(aliases = [], alias) {
  const normalizedAlias = normalizePointNameAlias(alias)
  const existingAliases = Array.isArray(aliases) ? aliases : []

  if (!normalizedAlias) {
    return existingAliases
  }

  if (existingAliases.some(existingAlias => normalizePointNameAlias(existingAlias) === normalizedAlias)) {
    return existingAliases
  }

  return [...existingAliases, String(alias).trim().replaceAll(/\s+/g, ' ')]
}

function removePointNameAlias(aliases = [], alias) {
  const normalizedAlias = normalizePointNameAlias(alias)
  const existingAliases = Array.isArray(aliases) ? aliases : []

  if (!normalizedAlias) {
    return existingAliases
  }

  return existingAliases.filter(existingAlias => normalizePointNameAlias(existingAlias) !== normalizedAlias)
}

function getRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

const quickDeclarationContextSchema = Joi.object({
  declarantUserId: Joi.string().uuid({version: 'uuidv4'}).optional(),
  preleveurUserId: Joi.string().uuid({version: 'uuidv4'}).optional(),
  targetDeclarantUserId: Joi.string().uuid({version: 'uuidv4'}).optional()
}).unknown(true)

const quickDeclarationEntrySchema = Joi.object({
  pointPrelevementId: Joi.string().uuid({version: 'uuidv4'}).required(),
  index: Joi.number().min(0).precision(4).required(),
  usage: Joi.string().valid(...USAGE_EAU_VALUES).required()
})

const createQuickDeclarationSchema = Joi.object({
  type: Joi.string().trim().min(1).max(120).allow('').optional(),
  declarantUserId: Joi.string().uuid({version: 'uuidv4'}).optional(),
  preleveurUserId: Joi.string().uuid({version: 'uuidv4'}).optional(),
  targetDeclarantUserId: Joi.string().uuid({version: 'uuidv4'}).optional(),
  readingDate: Joi.string().trim().pattern(/^\d{4}-\d{2}-\d{2}$/).required(),
  comment: Joi.string().trim().max(20_000).allow('').optional(),
  aotDecreeNumber: Joi.string().trim().max(255).allow('').optional(),
  entries: Joi.array().items(quickDeclarationEntrySchema).min(1).max(500).required()
}).unknown(false)

function getTargetDeclarantUserId(body, actorDeclarantUserId) {
  return String(
    body.declarantUserId
    || body.preleveurUserId
    || body.targetDeclarantUserId
    || actorDeclarantUserId
  ).trim()
}

async function getDeclarantProfile(userId) {
  const declarant = await prisma.declarant.findUnique({
    where: {userId},
    select: {
      declarantRole: true,
      quickDeclarationEnabled: true
    }
  })

  return declarant ?? null
}

async function getDeclarantRole(userId) {
  const declarant = await getDeclarantProfile(userId)

  return declarant?.declarantRole ?? null
}

async function assertQuickDeclarationEnabled({actorDeclarantUserId, targetDeclarantUserId}) {
  const declarants = await prisma.declarant.findMany({
    where: {
      userId: {
        in: [...new Set([actorDeclarantUserId, targetDeclarantUserId])]
      }
    },
    select: {
      userId: true,
      quickDeclarationEnabled: true
    }
  })

  const byId = new Map(declarants.map(declarant => [declarant.userId, declarant]))

  if (byId.get(actorDeclarantUserId)?.quickDeclarationEnabled === false) {
    throw createHttpError(403, 'La saisie rapide n’est pas activée pour votre compte déclarant.')
  }

  if (byId.get(targetDeclarantUserId)?.quickDeclarationEnabled === false) {
    throw createHttpError(403, 'La saisie rapide n’est pas activée pour ce préleveur.')
  }
}

function parseReadingDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''))

  if (!match) {
    throw createHttpError(400, 'La date de relevé doit être au format YYYY-MM-DD.')
  }

  const [, year, month, day] = match
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))

  if (
    Number.isNaN(date.getTime())
    || date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() !== Number(month) - 1
    || date.getUTCDate() !== Number(day)
  ) {
    throw createHttpError(400, 'La date de relevé est invalide.')
  }

  return date
}

function formatDateForMetadata(date) {
  return date.toISOString().slice(0, 10)
}

async function assertCanDeclareFor({actorDeclarantUserId, targetDeclarantUserId}) {
  const targetRole = await getDeclarantRole(targetDeclarantUserId)

  if (!targetRole) {
    throw createHttpError(404, 'Préleveur introuvable.')
  }

  if (targetRole !== 'PRELEVEUR') {
    throw createHttpError(400, 'Une déclaration de volumes doit être rattachée à un préleveur.')
  }

  if (actorDeclarantUserId === targetDeclarantUserId) {
    return
  }

  const actorRole = await getDeclarantRole(actorDeclarantUserId)

  if (actorRole !== 'COLLECTEUR') {
    throw createHttpError(403, 'Seul un collecteur peut déclarer pour un autre déclarant.')
  }

  const count = await prisma.declarantCollecteurExploitation.count({
    where: {
      collecteurUserId: actorDeclarantUserId,
      exploitation: {
        declarantUserId: targetDeclarantUserId
      }
    }
  })

  if (count === 0) {
    throw createHttpError(403, 'Ce collecteur n’a aucun droit sur les exploitations de ce préleveur.')
  }
}

async function assertCanCreateFileDeclarationFor({actorDeclarantUserId, targetDeclarantUserId}) {
  const targetRole = await getDeclarantRole(targetDeclarantUserId)

  if (!targetRole) {
    throw createHttpError(404, 'Déclarant introuvable.')
  }

  if (actorDeclarantUserId === targetDeclarantUserId && targetRole === 'COLLECTEUR') {
    return
  }

  await assertCanDeclareFor({actorDeclarantUserId, targetDeclarantUserId})
}

async function findAllowedDeclarationTypeForCollecteur({
  collecteurUserId,
  code
}) {
  const preleveurs = await getCollecteurPreleveurs(collecteurUserId)

  for (const preleveur of preleveurs) {
    // eslint-disable-next-line no-await-in-loop
    const declarationType = await findAllowedDeclarationTypeForDeclarant(
      preleveur.id,
      code
    )

    if (declarationType) {
      return declarationType
    }
  }

  return null
}

async function findAllowedDeclarationTypeForFileDeclaration({
  actorDeclarantUserId,
  targetDeclarantUserId,
  code
}) {
  const directDeclarationType = await findAllowedDeclarationTypeForDeclarant(
    targetDeclarantUserId,
    code
  )

  if (directDeclarationType) {
    return directDeclarationType
  }

  const targetRole = await getDeclarantRole(targetDeclarantUserId)

  if (
    actorDeclarantUserId === targetDeclarantUserId
    && targetRole === 'COLLECTEUR'
  ) {
    return findAllowedDeclarationTypeForCollecteur({
      collecteurUserId: targetDeclarantUserId,
      code
    })
  }

  return null
}

function canReadDeclarationWhere(userId, preleveurIds = []) {
  return {
    OR: [
      {declarantUserId: userId},
      {createdByDeclarantUserId: userId},
      ...(preleveurIds.length > 0 ? [{declarantUserId: {in: preleveurIds}}] : [])
    ]
  }
}

function getDeclarantDisplay(declarant) {
  if (!declarant) {
    return null
  }

  const user = declarant.user ?? declarant

  return {
    ...declarant,
    id: declarant.userId ?? user.id,
    email: user.email ?? declarant.email ?? null,
    firstName: user.firstName ?? declarant.firstName ?? null,
    lastName: user.lastName ?? declarant.lastName ?? null
  }
}

async function decorateDeclarationActors(declarations) {
  return declarations.map(declaration => ({
    ...declaration,
    declarant: getDeclarantDisplay(declaration.declarant),
    createdByDeclarant: getDeclarantDisplay(declaration.createdByDeclarant)
  }))
}

function decimalToNumber(value) {
  if (value === null || value === undefined) {
    return null
  }

  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function getPointDisplayName(point) {
  return point?.name || point?.sourceId || 'Point de prélèvement'
}

async function getLastIndexReadingsByPoint({declarantUserId, pointPrelevementIds}) {
  if (!Array.isArray(pointPrelevementIds) || pointPrelevementIds.length === 0) {
    return new Map()
  }

  const values = await prisma.chunkValue.findMany({
    where: {
      valueKind: 'DECLARED',
      metricTypeCode: {in: INDEX_METRIC_TYPE_CODES},
      chunk: {
        pointPrelevementId: {in: pointPrelevementIds},
        source: {
          status: 'COMPLETED',
          declaration: {
            declarantUserId
          }
        }
      }
    },
    select: {
      id: true,
      periodEnd: true,
      value: true,
      unit: true,
      chunk: {
        select: {
          pointPrelevementId: true
        }
      }
    },
    orderBy: [
      {periodEnd: 'desc'},
      {createdAt: 'desc'}
    ]
  })

  const byPointId = new Map()

  for (const value of values) {
    const pointPrelevementId = value.chunk?.pointPrelevementId

    if (!pointPrelevementId || byPointId.has(pointPrelevementId)) {
      continue
    }

    byPointId.set(pointPrelevementId, {
      value: decimalToNumber(value.value),
      date: value.periodEnd,
      unit: value.unit ?? 'm³'
    })
  }

  return byPointId
}

async function getLastKnownUsagesByPoint({declarantUserId, pointPrelevementIds}) {
  if (!Array.isArray(pointPrelevementIds) || pointPrelevementIds.length === 0) {
    return new Map()
  }

  const chunks = await prisma.chunk.findMany({
    where: {
      pointPrelevementId: {in: pointPrelevementIds},
      usage: {not: null},
      source: {
        status: 'COMPLETED',
        declaration: {
          declarantUserId
        }
      }
    },
    select: {
      pointPrelevementId: true,
      usage: true
    },
    orderBy: [
      {maxDate: 'desc'},
      {createdAt: 'desc'}
    ]
  })

  const byPointId = new Map()

  for (const chunk of chunks) {
    const {pointPrelevementId} = chunk

    if (!pointPrelevementId || byPointId.has(pointPrelevementId) || !isUsageEau(chunk.usage)) {
      continue
    }

    byPointId.set(pointPrelevementId, chunk.usage)
  }

  return byPointId
}

async function getQuickDeclarationPoints(declarantUserId) {
  const exploitations = await prisma.declarantPointPrelevement.findMany({
    where: {
      declarantUserId,
      status: {notIn: ['ABANDONNEE', 'TERMINEE']},
      ...activeWindowWhere(),
      pointPrelevement: {
        deletedAt: null
      }
    },
    include: {
      pointPrelevement: true
    },
    orderBy: [
      {createdAt: 'asc'}
    ]
  })

  const pointIds = exploitations
    .map(exploitation => exploitation.pointPrelevementId)
    .filter(Boolean)

  const [coordsById, lastReadingsByPointId, lastKnownUsagesByPointId] = await Promise.all([
    getCoordsByPointIds(pointIds),
    getLastIndexReadingsByPoint({declarantUserId, pointPrelevementIds: pointIds}),
    getLastKnownUsagesByPoint({declarantUserId, pointPrelevementIds: pointIds})
  ])

  return exploitations
    .map(exploitation => {
      const point = exploitation.pointPrelevement
      const coordinates = coordsById.get(point?.id) ?? null
      const lastReading = lastReadingsByPointId.get(point?.id) ?? null
      const lastKnownUsage = lastKnownUsagesByPointId.get(point?.id) ?? null

      return {
        id: point?.id,
        pointPrelevementId: point?.id,
        exploitationId: exploitation.id,
        name: getPointDisplayName(point),
        waterBodyType: point?.waterBodyType ?? null,
        nature: point?.nature ?? null,
        withdrawalType: point?.withdrawalType ?? null,
        coordinates,
        usages: mergeUsageFirst(exploitation.usages ?? [], lastKnownUsage),
        lastKnownUsage,
        lastReading: lastReading
          ? {
            ...lastReading,
            date: lastReading.date?.toISOString?.() ?? lastReading.date
          }
          : null
      }
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'fr'))
}

async function getAllowedQuickDeclarationTypes({actorDeclarantUserId, targetDeclarantUserId}) {
  await assertCanDeclareFor({actorDeclarantUserId, targetDeclarantUserId})
  await assertQuickDeclarationEnabled({actorDeclarantUserId, targetDeclarantUserId})

  return listAllowedDeclarationTypesForDeclarant(targetDeclarantUserId)
}

function ensureUniquePointEntries(entries) {
  const seen = new Set()

  for (const entry of entries) {
    if (seen.has(entry.pointPrelevementId)) {
      throw createHttpError(400, `Le point ${entry.pointPrelevementId} est présent plusieurs fois dans la saisie rapide.`)
    }

    seen.add(entry.pointPrelevementId)
  }
}

async function getLinkedExploitationsByPointId({declarantUserId, pointPrelevementIds}) {
  const exploitations = await prisma.declarantPointPrelevement.findMany({
    where: {
      declarantUserId,
      pointPrelevementId: {in: pointPrelevementIds},
      status: {notIn: ['ABANDONNEE', 'TERMINEE']},
      ...activeWindowWhere(),
      pointPrelevement: {
        deletedAt: null
      }
    },
    include: {
      pointPrelevement: true
    }
  })

  return new Map(exploitations.map(exploitation => [exploitation.pointPrelevementId, exploitation]))
}

async function getActiveExploitationForReconciliation({
  declarantUserId,
  pointPrelevementId,
  chunkStart,
  chunkEnd
}) {
  const declarantRole = await getDeclarantRole(declarantUserId)
  const accessWhere = declarantRole === 'COLLECTEUR'
    ? {
      OR: [
        {declarantUserId},
        {
          collecteurs: {
            some: {collecteurUserId: declarantUserId}
          }
        }
      ]
    }
    : {declarantUserId}

  return prisma.declarantPointPrelevement.findFirst({
    where: {
      ...accessWhere,
      pointPrelevementId,
      ...activeWindowOverlapsWhere(chunkStart, chunkEnd),
      pointPrelevement: {
        deletedAt: null
      }
    },
    include: {
      pointPrelevement: true
    }
  })
}

async function getReconciliationConflicts({
  chunkId,
  declarantUserId,
  pointPrelevementId,
  minDate,
  maxDate
}) {
  return prisma.chunk.findMany({
    where: {
      id: {not: chunkId},
      pointPrelevementId,
      instructionStatus: {in: ['PENDING', 'VALIDATED', 'AUTOMATICALLY_VALIDATED']},
      minDate: {lte: maxDate},
      maxDate: {gte: minDate},
      source: {
        declaration: {
          declarantUserId
        }
      }
    },
    select: {
      id: true,
      sourceId: true,
      pointPrelevementId: true,
      minDate: true,
      maxDate: true,
      source: {
        select: {
          declaration: {
            select: {
              id: true,
              code: true
            }
          }
        }
      },
      pointPrelevement: {
        select: {
          id: true,
          name: true
        }
      }
    }
  })
}

function computeChunkValueTotals(chunkValues = []) {
  let totalWaterVolumeWithdrawn = 0
  let totalWaterVolumeDischarged = 0

  for (const value of chunkValues) {
    const numericValue = decimalToNumber(value.value)

    if (numericValue === null) {
      continue
    }

    if (value.metricTypeCode === METRIC_TYPE_CODES.VOLUME_PRELEVE) {
      totalWaterVolumeWithdrawn += numericValue
    }

    if (value.metricTypeCode === METRIC_TYPE_CODES.VOLUME_REJETE) {
      totalWaterVolumeDischarged += numericValue
    }
  }

  return {
    totalWaterVolumeWithdrawn,
    totalWaterVolumeDischarged
  }
}

async function refreshSourceVolumeMetadata(sourceId) {
  const source = await prisma.source.findUnique({
    where: {id: sourceId},
    include: {
      chunks: {
        include: {
          chunkValues: true
        }
      }
    }
  })

  if (!source) {
    return null
  }

  let sourceTotalWaterVolumeWithdrawn = 0
  let sourceTotalWaterVolumeDischarged = 0

  for (const chunk of source.chunks) {
    const {
      totalWaterVolumeWithdrawn,
      totalWaterVolumeDischarged
    } = computeChunkValueTotals(chunk.chunkValues)

    sourceTotalWaterVolumeWithdrawn += totalWaterVolumeWithdrawn
    sourceTotalWaterVolumeDischarged += totalWaterVolumeDischarged

    // eslint-disable-next-line no-await-in-loop
    await prisma.chunk.update({
      where: {id: chunk.id},
      data: {
        metadata: {
          ...chunk.metadata,
          totalWaterVolumeWithdrawn,
          totalWaterVolumeDischarged
        }
      }
    })
  }

  return prisma.source.update({
    where: {id: sourceId},
    data: {
      metadata: {
        ...source.metadata,
        totalWaterVolumeWithdrawn: sourceTotalWaterVolumeWithdrawn,
        totalWaterVolumeDischarged: sourceTotalWaterVolumeDischarged
      }
    },
    include: {
      chunks: {
        include: {
          pointPrelevement: true,
          chunkValues: true
        }
      }
    }
  })
}

async function getAllowedTypesMetaForDeclarant(actorDeclarantUserId) {
  const actorProfile = await getDeclarantProfile(actorDeclarantUserId)
  const actorRole = actorProfile?.declarantRole ?? null
  const actorQuickDeclarationEnabled = actorProfile?.quickDeclarationEnabled !== false

  if (actorRole === 'COLLECTEUR') {
    const preleveurs = await getCollecteurPreleveurs(actorDeclarantUserId)
    const preleveursWithAllowedTypes = []
    const uniqueByCode = new Map()
    const collecteurAllowedDeclarationTypes = await listAllowedDeclarationTypesForDeclarant(actorDeclarantUserId)

    for (const declarationType of collecteurAllowedDeclarationTypes) {
      uniqueByCode.set(declarationType.code, declarationType)
    }

    for (const preleveur of preleveurs) {
      // eslint-disable-next-line no-await-in-loop
      const allowedDeclarationTypes = await listAllowedDeclarationTypesForDeclarant(preleveur.id)
      const quickDeclarationEnabled = preleveur.declarant?.quickDeclarationEnabled !== false

      for (const declarationType of allowedDeclarationTypes) {
        uniqueByCode.set(declarationType.code, declarationType)
      }

      preleveursWithAllowedTypes.push({
        id: preleveur.id,
        userId: preleveur.id,
        firstName: preleveur.firstName,
        lastName: preleveur.lastName,
        email: preleveur.email,
        declarant: preleveur.declarant,
        quickDeclarationEnabled,
        canCreateQuickDeclaration: actorQuickDeclarationEnabled && quickDeclarationEnabled && allowedDeclarationTypes.length > 0,
        allowedDeclarationTypes
      })
    }

    const allowedDeclarationTypes = [...uniqueByCode.values()]
    const canCreateDeclaration = allowedDeclarationTypes.length > 0
    const canCreateQuickDeclaration = preleveursWithAllowedTypes.some(preleveur => preleveur.canCreateQuickDeclaration)

    return {
      data: allowedDeclarationTypes,
      meta: {
        declarantRole: actorRole,
        quickDeclarationEnabled: actorQuickDeclarationEnabled,
        canCreateDeclaration,
        canCreateQuickDeclaration,
        allowedDeclarationTypes,
        preleveurs: preleveursWithAllowedTypes
      }
    }
  }

  const allowedDeclarationTypes = await listAllowedDeclarationTypesForDeclarant(actorDeclarantUserId)

  return {
    data: allowedDeclarationTypes,
    meta: {
      declarantRole: actorRole,
      quickDeclarationEnabled: actorQuickDeclarationEnabled,
      canCreateDeclaration: allowedDeclarationTypes.length > 0,
      canCreateQuickDeclaration: actorQuickDeclarationEnabled && allowedDeclarationTypes.length > 0,
      allowedDeclarationTypes,
      preleveurs: []
    }
  }
}

/**
 * POST /declarations
 * multipart/form-data:
 * - files: fichiers du type sélectionné
 * - fileTypes: champ répété, UN type métier par fichier (facultatif ; défaut = type de déclaration)
 * - declarantUserId?: déclarant cible lorsque le compte connecté dépose pour un autre déclarant
 * - comment?: string
 * - aotDecreeNumber?: string
 */
export async function createDeclarationHandler(req, res, next) {
  try {
    const {error} = createDeclarationSchema.validate(req.body)
    if (error) {
      throw createHttpError(400, error.message)
    }

    const files = req.files || []
    if (!Array.isArray(files) || files.length === 0) {
      throw createHttpError(400, 'Aucun fichier envoyé (champ "files")')
    }

    for (const f of files) {
      if (!f?.buffer || !Buffer.isBuffer(f.buffer)) {
        throw createHttpError(400, 'Fichier invalide (buffer manquant)')
      }

      if (!f.originalname) {
        throw createHttpError(400, 'Fichier invalide (originalname manquant)')
      }
    }

    const createdByDeclarantUserId = req.user.id
    const declarantUserId = getTargetDeclarantUserId(req.body, createdByDeclarantUserId)
    const type = normalizeDeclarationTypeCode(req.body.type)

    await assertCanCreateFileDeclarationFor({
      actorDeclarantUserId: createdByDeclarantUserId,
      targetDeclarantUserId: declarantUserId
    })

    const allowedDeclarationType = await findAllowedDeclarationTypeForFileDeclaration({
      actorDeclarantUserId: createdByDeclarantUserId,
      targetDeclarantUserId: declarantUserId,
      code: type
    })

    if (!allowedDeclarationType) {
      throw createHttpError(
        403,
        `Le déclarant concerné n’est pas autorisé à déposer une déclaration de type "${type}".`
      )
    }

    const fileTypesRaw = normalizeRepeatedField(req.body.fileTypes)

    if (fileTypesRaw && fileTypesRaw.length !== files.length) {
      throw createHttpError(
        400,
        `Le nombre de fileTypes (${fileTypesRaw.length}) doit correspondre au nombre de fichiers (${files.length}).`
      )
    }

    const fileTypes = fileTypesRaw
      ? fileTypesRaw.map((t, i) => {
        const value = normalizeDeclarationTypeCode(t)
        if (!value) {
          throw createHttpError(400, `Type manquant pour le fichier #${i + 1}.`)
        }

        return value
      })
      : files.map(() => type)

    const unexpectedFileType = fileTypes.find(fileType => fileType !== type)
    if (unexpectedFileType) {
      throw createHttpError(
        400,
        `Tous les fichiers d’une déclaration doivent avoir le type sélectionné "${type}". Type reçu: "${unexpectedFileType}".`
      )
    }

    const commentRaw = typeof req.body.comment === 'string' ? req.body.comment.trim() : undefined
    const comment = commentRaw || null

    const aotRaw = typeof req.body.aotDecreeNumber === 'string' ? req.body.aotDecreeNumber.trim() : undefined
    const aotDecreeNumber = aotRaw || null

    const storage = createStorageClient(DECLARATIONS_BUCKET)

    const declaration = await prisma.declaration.create({
      data: {
        id: randomUUID(),
        code: generateDossierCode(6),
        type,
        declarantUserId,
        createdByDeclarantUserId,
        comment,
        aotDecreeNumber,
        dataSourceType: 'SPREADSHEET',
        waterWithdrawalType: 'unknown'
      }
    })

    await updateLastDeclarationAt(declarantUserId)
    if (createdByDeclarantUserId !== declarantUserId) {
      await updateLastDeclarationAt(createdByDeclarantUserId)
    }

    const uploadedKeys = []

    try {
      const createdFiles = []

      for (const [i, file] of files.entries()) {
        const filename = safeFilename(file.originalname)
        const type = fileTypes[i]

        const objectKey = `declarations/${declaration.id}/${uuid()}-${filename}`

        // eslint-disable-next-line no-await-in-loop
        await storage.uploadObject(objectKey, file.buffer, {
          filename,
          type: file.mimetype
        })

        uploadedKeys.push(objectKey)

        // eslint-disable-next-line no-await-in-loop
        const row = await prisma.declarationFile.create({
          data: {
            id: randomUUID(),
            declarationId: declaration.id,
            type,
            filename,
            storageKey: objectKey
          }
        })

        createdFiles.push(row)
      }

      const filesWithUrls = await Promise.all(
        createdFiles.map(async f => ({
          ...f,
          url: await storage.getPresignedUrl(f.storageKey)
        }))
      )

      await notifyDeclarationUploaded({declarationId: declaration.id})

      return res.status(201).json({
        success: true,
        data: {
          ...declaration,
          declarationType: allowedDeclarationType,
          files: filesWithUrls
        }
      })
    } catch (error_) {
      try {
        await prisma.declaration.delete({where: {id: declaration.id}})
      } catch {}

      try {
        await Promise.all(uploadedKeys.map(async k => storage.deleteObject(k, true)))
      } catch {}

      throw error_
    }
  } catch (error) {
    next(error)
  }
}

export async function getQuickDeclarationContextHandler(req, res, next) {
  try {
    const {error, value} = quickDeclarationContextSchema.validate(req.query)
    if (error) {
      throw createHttpError(400, error.message)
    }

    const actorDeclarantUserId = req.user.id
    const targetDeclarantUserId = getTargetDeclarantUserId(value, actorDeclarantUserId)

    const allowedDeclarationTypes = await getAllowedQuickDeclarationTypes({
      actorDeclarantUserId,
      targetDeclarantUserId
    })
    const points = await getQuickDeclarationPoints(targetDeclarantUserId)

    return res.json({
      success: true,
      data: {
        declarantUserId: targetDeclarantUserId,
        quickDeclarationEnabled: true,
        canCreateQuickDeclaration: allowedDeclarationTypes.length > 0,
        allowedDeclarationTypes,
        usageOptions: USAGE_EAU_VALUES,
        points
      }
    })
  } catch (error) {
    next(error)
  }
}

export async function createQuickDeclarationHandler(req, res, next) {
  try {
    const {error, value} = createQuickDeclarationSchema.validate(req.body, {abortEarly: false})
    if (error) {
      throw createHttpError(400, error.message)
    }

    const createdByDeclarantUserId = req.user.id
    const declarantUserId = getTargetDeclarantUserId(value, createdByDeclarantUserId)
    let type = normalizeDeclarationTypeCode(value.type)
    const readingDate = parseReadingDate(value.readingDate)
    const readingDateLabel = formatDateForMetadata(readingDate)
    const comment = typeof value.comment === 'string' && value.comment.trim()
      ? value.comment.trim()
      : null
    const aotDecreeNumber = typeof value.aotDecreeNumber === 'string' && value.aotDecreeNumber.trim()
      ? value.aotDecreeNumber.trim()
      : null
    const entries = value.entries.map(entry => ({
      pointPrelevementId: entry.pointPrelevementId,
      index: Number(entry.index),
      usage: entry.usage
    }))

    ensureUniquePointEntries(entries)

    await assertCanDeclareFor({actorDeclarantUserId: createdByDeclarantUserId, targetDeclarantUserId: declarantUserId})
    await assertQuickDeclarationEnabled({actorDeclarantUserId: createdByDeclarantUserId, targetDeclarantUserId: declarantUserId})

    let allowedDeclarationType

    if (type) {
      allowedDeclarationType = await findAllowedDeclarationTypeForDeclarant(
        declarantUserId,
        type
      )
    } else {
      const allowedDeclarationTypes = await listAllowedDeclarationTypesForDeclarant(declarantUserId)
      allowedDeclarationType = allowedDeclarationTypes[0] ?? null
      type = normalizeDeclarationTypeCode(allowedDeclarationType?.code)
    }

    if (!allowedDeclarationType || !type) {
      throw createHttpError(
        403,
        value.type
          ? `Le préleveur concerné n’est pas autorisé à déposer une déclaration de type "${type}".`
          : 'Le préleveur concerné n’est autorisé à déposer aucun type de déclaration.'
      )
    }

    const pointPrelevementIds = entries.map(entry => entry.pointPrelevementId)
    const exploitationsByPointId = await getLinkedExploitationsByPointId({
      declarantUserId,
      pointPrelevementIds
    })

    const missingPointIds = pointPrelevementIds.filter(pointId => !exploitationsByPointId.has(pointId))
    if (missingPointIds.length > 0) {
      throw createHttpError(400, 'Un ou plusieurs points ne sont pas rattachés au préleveur concerné.')
    }

    const declaration = await prisma.$transaction(async tx => {
      const createdDeclaration = await tx.declaration.create({
        data: {
          id: randomUUID(),
          code: generateDossierCode(6),
          type,
          declarantUserId,
          createdByDeclarantUserId,
          comment,
          aotDecreeNumber,
          dataSourceType: 'MANUAL',
          waterWithdrawalType: 'unknown'
        }
      })

      const source = await tx.source.create({
        data: {
          id: randomUUID(),
          type: 'DECLARATION',
          status: 'COMPLETED',
          globalInstructionStatus: 'VALIDATED',
          declarationId: createdDeclaration.id,
          metadata: {
            manualQuickDeclaration: true,
            readingDate: readingDateLabel,
            entriesCount: entries.length,
            totalWaterVolumeWithdrawn: 0,
            totalWaterVolumeDischarged: 0
          },
          chunks: {
            create: entries.map(entry => {
              const exploitation = exploitationsByPointId.get(entry.pointPrelevementId)
              const point = exploitation.pointPrelevement

              return {
                id: randomUUID(),
                pointPrelevementId: entry.pointPrelevementId,
                pointPrelevementName: getPointDisplayName(point),
                instructionStatus: 'VALIDATED',
                usage: entry.usage,
                minDate: readingDate,
                maxDate: readingDate,
                parsingInfo: {
                  parser: 'quick-declaration-form',
                  reason: 'MANUAL_QUICK_DECLARATION'
                },
                metadata: {
                  quickDeclaration: true,
                  indexValue: entry.index,
                  indexUnit: 'm³',
                  readingDate: readingDateLabel,
                  totalWaterVolumeWithdrawn: 0,
                  totalWaterVolumeDischarged: 0
                },
                chunkValues: {
                  create: [
                    {
                      id: randomUUID(),
                      metricTypeCode: METRIC_TYPE_CODES.RELEVE_INDEX,
                      unit: 'm³',
                      frequency: 'instant',
                      periodStart: readingDate,
                      periodEnd: readingDate,
                      valueKind: 'DECLARED',
                      value: entry.index
                    }
                  ]
                }
              }
            })
          }
        },
        include: {
          chunks: true
        }
      })

      for (const entry of entries) {
        const exploitation = exploitationsByPointId.get(entry.pointPrelevementId)
        const usages = appendMissingUsage(exploitation.usages, entry.usage)

        if (usages.length > (exploitation.usages ?? []).length) {
          // eslint-disable-next-line no-await-in-loop
          await tx.declarantPointPrelevement.update({
            where: {id: exploitation.id},
            data: {usages}
          })
          exploitation.usages = usages
        }

        // eslint-disable-next-line no-await-in-loop
        await tx.declarantPointPrelevement.updateMany({
          where: {
            id: exploitation.id,
            OR: [
              {mostRecentAvailableDate: null},
              {mostRecentAvailableDate: {lt: readingDate}}
            ]
          },
          data: {
            mostRecentAvailableDate: readingDate
          }
        })
      }

      return {
        ...createdDeclaration,
        source
      }
    })

    await updateLastDeclarationAt(declarantUserId)
    if (createdByDeclarantUserId !== declarantUserId) {
      await updateLastDeclarationAt(createdByDeclarantUserId)
    }

    const reconstructionResults = []
    for (const pointId of new Set(pointPrelevementIds)) {
      try {
        // eslint-disable-next-line no-await-in-loop
        reconstructionResults.push(await reconstructVolumesFromIndexForPoint(pointId))
      } catch (error_) {
        console.error('[quick-declaration] volume reconstruction failed:', {
          pointId,
          declarationId: declaration.id,
          error: error_?.message
        })
      }
    }

    let source = await refreshSourceVolumeMetadata(declaration.source.id)

    if (source && reconstructionResults.length > 0) {
      source = await prisma.source.update({
        where: {id: source.id},
        data: {
          metadata: {
            ...source.metadata,
            reconstructionResults
          }
        },
        include: {
          chunks: {
            include: {
              pointPrelevement: true,
              chunkValues: true
            }
          }
        }
      })
    }

    return res.status(201).json({
      success: true,
      data: {
        ...declaration,
        source,
        declarationType: allowedDeclarationType,
        files: []
      }
    })
  } catch (error) {
    next(error)
  }
}

export async function listMyDeclarationsHandler(req, res, next) {
  try {
    const userId = req.user.id
    const collecteurPreleveurIds = req.user.declarant?.declarantRole === 'COLLECTEUR'
      ? await getPreleveurIdsForCollecteur(userId)
      : []

    const allowedTypesPayload = await getAllowedTypesMetaForDeclarant(userId)

    const items = await prisma.declaration.findMany({
      where: canReadDeclarationWhere(userId, collecteurPreleveurIds),
      orderBy: {createdAt: 'desc'},
      include: {
        files: true,
        source: {
          include: {
            chunks: true
          }
        },
        declarant: {
          include: {
            user: true
          }
        },
        createdByDeclarant: {
          include: {
            user: true
          }
        }
      }
    })

    const decorated = await decorateDeclarationsWithDeclarationTypes(await decorateDeclarationActors(items))

    return res.json({
      success: true,
      data: decorated,
      meta: allowedTypesPayload.meta
    })
  } catch (error) {
    next(error)
  }
}

export async function listMyAllowedDeclarationTypesHandler(req, res, next) {
  try {
    const payload = await getAllowedTypesMetaForDeclarant(req.user.id)

    return res.json({
      success: true,
      data: payload.data,
      meta: payload.meta
    })
  } catch (error) {
    next(error)
  }
}

export async function getDeclarationDetailHandler(req, res, next) {
  try {
    const declarationId = String(req.params.declarationId || '').trim()
    const {error} = declarationIdSchema.validate({declarationId})
    if (error) {
      throw createHttpError(400, error.message)
    }

    const userId = req.user.id
    const collecteurPreleveurIds = req.user.declarant?.declarantRole === 'COLLECTEUR'
      ? await getPreleveurIdsForCollecteur(userId)
      : []
    const storage = createStorageClient(DECLARATIONS_BUCKET)

    const declaration = await prisma.declaration.findFirst({
      where: {
        id: declarationId,
        ...canReadDeclarationWhere(userId, collecteurPreleveurIds)
      },
      include: {
        files: true,
        source: {
          include: {
            chunks: {
              include: {
                pointPrelevement: true,
                chunkValues: true,
                instructedByInstructor: {
                  include: {
                    user: {
                      select: {
                        lastName: true,
                        firstName: true
                      }
                    }
                  }
                }
              }
            }
          }
        },
        declarant: {
          include: {
            user: true
          }
        },
        createdByDeclarant: {
          include: {
            user: true
          }
        }
      }
    })

    if (!declaration) {
      throw createHttpError(404, 'Déclaration introuvable')
    }

    const [declarationWithActors] = await decorateDeclarationActors([declaration])
    const [declarationWithType] = await decorateDeclarationsWithDeclarationTypes([declarationWithActors])

    declaration.files = await Promise.all(
      declaration.files.map(async file => ({
        ...file,
        url: await storage.getPresignedUrl(file.storageKey)
      }))
    )

    return res.json({
      success: true,
      data: {
        ...declarationWithType,
        files: declaration.files,
        declarationType: declarationWithType.declarationType
      }
    })
  } catch (error) {
    next(error)
  }
}

export async function reconcileDeclarationChunkHandler(req, res, next) {
  try {
    const declarationId = String(req.params.declarationId || '').trim()
    const chunkId = String(req.params.chunkId || '').trim()

    const {error: declarationIdError} = declarationIdSchema.validate({declarationId})
    if (declarationIdError) {
      throw createHttpError(400, declarationIdError.message)
    }

    const {error, value} = reconcileDeclarationChunkSchema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true
    })

    if (error) {
      throw createHttpError(400, error.details.map(detail => detail.message).join(' '))
    }

    const userId = req.user.id
    const collecteurPreleveurIds = req.user.declarant?.declarantRole === 'COLLECTEUR'
      ? await getPreleveurIdsForCollecteur(userId)
      : []

    const declaration = await prisma.declaration.findFirst({
      where: {
        id: declarationId,
        ...canReadDeclarationWhere(userId, collecteurPreleveurIds)
      },
      select: {
        id: true,
        declarantUserId: true,
        source: {
          select: {
            id: true
          }
        }
      }
    })

    if (!declaration?.source?.id) {
      throw createHttpError(404, 'Déclaration introuvable')
    }

    const chunk = await prisma.chunk.findFirst({
      where: {
        id: chunkId,
        sourceId: declaration.source.id
      },
      select: {
        id: true,
        sourceId: true,
        pointPrelevementName: true,
        pointPrelevementId: true,
        usage: true,
        minDate: true,
        maxDate: true,
        parsingInfo: true
      }
    })

    if (!chunk) {
      throw createHttpError(404, 'Point du fichier introuvable dans cette déclaration.')
    }

    const targetPointPrelevementId = value.pointPrelevementId
    const isDetaching = targetPointPrelevementId === null
    const alias = chunk.pointPrelevementName
    const previousPointPrelevementId = chunk.pointPrelevementId
    const shouldRemovePreviousAlias = Boolean(previousPointPrelevementId) && previousPointPrelevementId !== targetPointPrelevementId

    const previousExploitation = shouldRemovePreviousAlias
      ? await getActiveExploitationForReconciliation({
        declarantUserId: declaration.declarantUserId,
        pointPrelevementId: previousPointPrelevementId,
        chunkStart: chunk.minDate,
        chunkEnd: chunk.maxDate
      })
      : null

    let exploitation = null
    let aliases = null
    let usages = null

    if (!isDetaching) {
      exploitation = await getActiveExploitationForReconciliation({
        declarantUserId: declaration.declarantUserId,
        pointPrelevementId: targetPointPrelevementId,
        chunkStart: chunk.minDate,
        chunkEnd: chunk.maxDate
      })

      if (!exploitation) {
        throw createHttpError(400, 'Ce point de prélèvement n’est pas rattaché au préleveur concerné sur la période déclarée.')
      }

      const conflicts = await getReconciliationConflicts({
        chunkId: chunk.id,
        declarantUserId: declaration.declarantUserId,
        pointPrelevementId: targetPointPrelevementId,
        minDate: chunk.minDate,
        maxDate: chunk.maxDate
      })

      if (conflicts.length > 0) {
        return res.status(409).json({
          success: false,
          message: 'Ce point contient déjà des données sur une période qui chevauche cette ligne. Pour éviter un double comptage, choisissez un autre point ou corrigez l’association existante.',
          data: {
            reason: 'POINT_ALREADY_HAS_OVERLAPPING_DATA',
            declarationId,
            chunkId,
            pointPrelevementId: targetPointPrelevementId,
            conflicts
          }
        })
      }

      aliases = appendMissingPointNameAlias(exploitation.pointPrelevementNameAliases, alias)
      usages = appendMissingUsage(exploitation.usages, chunk.usage)
    }

    const previousAliases = previousExploitation
      ? removePointNameAlias(previousExploitation.pointPrelevementNameAliases, alias)
      : null
    const changedAtIso = new Date().toISOString()

    const result = await prisma.$transaction(async tx => {
      const updatedChunk = await tx.chunk.update({
        where: {id: chunk.id},
        data: {
          pointPrelevementId: targetPointPrelevementId,
          instructionStatus: isDetaching ? 'PENDING' : 'VALIDATED',
          instructedAt: null,
          instructedByInstructorUserId: null,
          instructionComment: null,
          parsingInfo: {
            ...getRecord(chunk.parsingInfo),
            reason: isDetaching ? 'POINT_DETACHED_BY_DECLARANT' : 'POINT_RECONCILED_BY_DECLARANT',
            previousPointPrelevementId,
            pointPrelevementName: alias,
            pointPrelevementId: targetPointPrelevementId,
            exploitationId: exploitation?.id ?? null,
            ...(isDetaching
              ? {detachedAt: changedAtIso, reconciledAt: null}
              : {detachedAt: null, reconciledAt: changedAtIso})
          }
        },
        select: {
          id: true,
          sourceId: true,
          pointPrelevementId: true
        }
      })

      if (previousExploitation) {
        await tx.declarantPointPrelevement.update({
          where: {
            id: previousExploitation.id
          },
          data: {
            pointPrelevementNameAliases: previousAliases
          }
        })
      }

      if (exploitation) {
        await tx.declarantPointPrelevement.update({
          where: {
            id: exploitation.id
          },
          data: {
            pointPrelevementNameAliases: aliases,
            usages
          }
        })

        if (chunk.maxDate) {
          await tx.declarantPointPrelevement.updateMany({
            where: {
              id: exploitation.id,
              OR: [
                {mostRecentAvailableDate: null},
                {mostRecentAvailableDate: {lt: chunk.maxDate}}
              ]
            },
            data: {
              mostRecentAvailableDate: chunk.maxDate
            }
          })
        }
      }

      const sourceChunks = await tx.chunk.findMany({
        where: {
          sourceId: chunk.sourceId
        },
        select: {
          pointPrelevementId: true
        }
      })

      const globalInstructionStatus = computeGlobalPointMatchingStatus(sourceChunks)

      await tx.source.update({
        where: {
          id: chunk.sourceId
        },
        data: {
          globalInstructionStatus
        }
      })

      return {
        ...updatedChunk,
        globalInstructionStatus
      }
    })

    return res.status(200).json({
      success: true,
      data: {
        declarationId,
        sourceId: chunk.sourceId,
        chunkId: result.id,
        pointPrelevementId: result.pointPrelevementId,
        globalInstructionStatus: result.globalInstructionStatus
      }
    })
  } catch (error) {
    next(error)
  }
}

export async function getAvailablePointsPrelevementsForDeclarationHandler(req, res, next) {
  try {
    const declarationId = String(req.params.declarationId || '').trim()
    const {error} = declarationIdSchema.validate({declarationId})

    if (error) {
      throw createHttpError(400, error.message)
    }

    const isDeclarant = req.user.role === 'DECLARANT'
    const isGlobalAdmin = req.user.role === 'ADMIN'
    const instructorUserId = isGlobalAdmin || isDeclarant ? undefined : req.user.id
    const userId = req.user.id

    const declaration = await prisma.declaration.findUnique({
      where: {id: declarationId},
      select: {
        id: true,
        declarantUserId: true
      }
    })

    if (!declaration) {
      throw createHttpError(404, 'Déclaration introuvable')
    }

    if (isDeclarant) {
      const collecteurPreleveurIds = req.user.declarant?.declarantRole === 'COLLECTEUR'
        ? await getPreleveurIdsForCollecteur(userId)
        : []

      const canRead = await prisma.declaration.count({
        where: {
          id: declarationId,
          ...canReadDeclarationWhere(userId, collecteurPreleveurIds)
        }
      })

      if (canRead === 0) {
        throw createHttpError(403, 'Droits insuffisants.')
      }
    }

    const points = await getAvailablePointsPrelevementsForDeclaration({
      declarationId,
      declarantUserId: declaration.declarantUserId,
      instructorUserId,
      isGlobalAdmin
    })

    return res.json({
      success: true,
      data: points
    })
  } catch (error) {
    next(error)
  }
}

export async function getAvailablePointsPrelevementsForDeclaration({
  declarantUserId,
  instructorUserId,
  isGlobalAdmin = false
}) {
  const now = new Date()

  const shouldFilterInstructorZones = !isGlobalAdmin && typeof instructorUserId === 'string' && instructorUserId.length > 0
  const instructorZoneActiveWhere = shouldFilterInstructorZones
    ? {
      instructorUserId,
      ...activeWindowWhere(now, {startNullable: false, endNullable: true})
    }
    : null

  const declarantLinkActiveWhere = {
    declarantUserId,
    ...activeWindowWhere(now)
  }
  const declarantRole = await getDeclarantRole(declarantUserId)

  const pointAccessWhere = declarantRole === 'COLLECTEUR'
    ? {
      OR: [
        {
          declarants: {
            some: declarantLinkActiveWhere
          }
        },
        {
          declarants: {
            some: {
              ...activeWindowWhere(now),
              collecteurs: {
                some: {
                  collecteurUserId: declarantUserId
                }
              }
            }
          }
        }
      ]
    }
    : {
      declarants: {
        some: declarantLinkActiveWhere
      }
    }

  const instructorZoneWhere = shouldFilterInstructorZones
    ? {
      zones: {
        some: {
          zone: {
            instructorZones: {
              some: instructorZoneActiveWhere
            }
          }
        }
      }
    }
    : {}

  const points = await prisma.pointPrelevement.findMany({
    where: {
      deletedAt: null,
      ...pointAccessWhere,
      ...instructorZoneWhere
    },
    select: {
      id: true,
      name: true,
      waterBodyType: true,
      nature: true,
      withdrawalType: true
    },
    orderBy: {
      name: 'asc'
    }
  })

  const exploitations = await prisma.declarantPointPrelevement.findMany({
    where: {
      pointPrelevementId: {
        in: points.map(point => point.id)
      },
      status: {notIn: ['ABANDONNEE', 'TERMINEE']},
      ...activeWindowWhere(now),
      ...(declarantRole === 'COLLECTEUR'
        ? {
          OR: [
            {declarantUserId},
            {
              collecteurs: {
                some: {
                  collecteurUserId: declarantUserId
                }
              }
            }
          ]
        }
        : {declarantUserId})
    },
    select: {
      pointPrelevementId: true,
      pointPrelevementNameAliases: true,
      usages: true,
      mostRecentAvailableDate: true
    }
  })
  const exploitationByPointId = new Map()

  for (const exploitation of exploitations) {
    const existing = exploitationByPointId.get(exploitation.pointPrelevementId) ?? {
      pointPrelevementNameAliases: [],
      usages: [],
      mostRecentAvailableDate: null
    }
    const existingDate = existing.mostRecentAvailableDate
      ? new Date(existing.mostRecentAvailableDate)
      : null
    const exploitationDate = exploitation.mostRecentAvailableDate
      ? new Date(exploitation.mostRecentAvailableDate)
      : null
    const mostRecentAvailableDate = exploitationDate && (!existingDate || exploitationDate > existingDate)
      ? exploitation.mostRecentAvailableDate
      : existing.mostRecentAvailableDate

    exploitationByPointId.set(exploitation.pointPrelevementId, {
      pointPrelevementNameAliases: [
        ...new Set([
          ...existing.pointPrelevementNameAliases,
          ...exploitation.pointPrelevementNameAliases
        ])
      ],
      usages: [...new Set([...existing.usages, ...exploitation.usages])],
      mostRecentAvailableDate
    })
  }

  const coordsById = await getCoordsByPointIds(points.map(point => point.id))

  return points.map(point => ({
    ...point,
    pointPrelevementNameAliases: exploitationByPointId.get(point.id)?.pointPrelevementNameAliases ?? [],
    usages: exploitationByPointId.get(point.id)?.usages ?? [],
    mostRecentAvailableDate: exploitationByPointId.get(point.id)?.mostRecentAvailableDate ?? null,
    coordinates: coordsById.get(point.id) ?? null
  }))
}
