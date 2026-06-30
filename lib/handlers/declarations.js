import createHttpError from 'http-errors'
import Joi from 'joi'
import {Prisma} from '@prisma/client'
import crypto, {randomUUID} from 'node:crypto'
import path from 'node:path'
import {Buffer} from 'node:buffer'
import process from 'node:process'

import createStorageClient from '../util/s3.js'
import {prisma} from '../../db/prisma.js'
import {activeWindowWhere, getCoordsByPointIds} from '../models/point-prelevement.js'
import {getCollecteurPreleveurs, updateLastDeclarationAt} from '../models/declarant.js'
import {getPreleveurIdsForCollecteur} from '../models/exploitation.js'
import {computeGlobalPointMatchingStatus} from './chunks.js'
import {
  getAccessiblePointPrelevementIdsSetForInstructor,
  getChunkAuthorizationForInstructor
} from '../services/instructor-sources.js'
import {refreshMostRecentAvailableDateForDeclarantPoints} from '../services/declaration-side-effects.js'
import {
  decorateDeclarationsWithDeclarationTypes,
  findAllowedDeclarationTypeForDeclarant,
  listAllowedDeclarationTypesForDeclarant,
  normalizeDeclarationTypeCode
} from '../models/declaration-type.js'
import {METRIC_TYPE_CODES} from '../constants/metric-type-codes.js'
import {
  getWaterUseRootId,
  listSandreWaterUses,
  resolveWaterUseInput,
  serializeWaterUse,
  serializeWaterUses
} from '../services/sandre-water-uses.js'
import {notifyDeclarationUploaded} from '../services/orchestration-client.js'
import {INDEX_METRIC_TYPE_CODES, reconstructVolumesFromIndexForPoint} from '../services/volumes-from-index.js'
import {renderDeclarationPointsChangeRequestEmail} from '../util/email-templates.js'
import {sendEmail} from '../util/email.js'

export const DECLARATIONS_BUCKET = 'declarations'

const DOSSIER_ALPHABET = 'ACDEFHJMNPRTUVWY23479'
const DECLARATION_POINTS_CHANGE_REQUEST_EMAIL = process.env.DECLARATION_POINTS_CHANGE_REQUEST_EMAIL
  || process.env.DECLARATION_REPORT_EMAIL
  || 'contact@partageonsleau.beta.gouv.fr'
const FRONT_URL = process.env.FRONT_URL || process.env.FRONTEND_URL || 'http://localhost:3000'
const QUICK_DECLARATION_TYPE_CODE = 'quick-declaration'
const LATEST_INDEX_READINGS_LIMIT = 10
const QUICK_DECLARATION_TYPE = {
  id: null,
  code: QUICK_DECLARATION_TYPE_CODE,
  name: 'Saisie rapide',
  version: 1,
  isAvailable: true
}
const VOLUME_METRIC_TYPE_CODES = [
  METRIC_TYPE_CODES.VOLUME_PRELEVE,
  METRIC_TYPE_CODES.VOLUME_REJETE
]

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

const sourceIdSchema = Joi.object({
  sourceId: Joi.string().uuid({version: 'uuidv4'}).required()
})

const reconcileDeclarationChunkSchema = Joi.object({
  pointPrelevementId: Joi.alternatives()
    .try(
      Joi.string().uuid({version: 'uuidv4'}),
      Joi.valid(null)
    )
    .required()
}).unknown(false)

const declarationPointsChangeRequestSchema = Joi.object({
  message: Joi.string().trim().min(1).max(5000).required()
}).unknown(false)

async function refreshLastDeclarationAt(declarantUserId) {
  if (!declarantUserId) {
    return
  }

  const latestDeclaration = await prisma.declaration.findFirst({
    where: {
      OR: [
        {declarantUserId},
        {createdByDeclarantUserId: declarantUserId}
      ]
    },
    orderBy: {createdAt: 'desc'},
    select: {createdAt: true}
  })

  await prisma.declarant.updateMany({
    where: {userId: declarantUserId},
    data: {
      lastDeclarationAt: latestDeclaration?.createdAt ?? null
    }
  })
}

async function deleteDeclarationFilesFromStorage(files = []) {
  if (files.length === 0) {
    return
  }

  try {
    const storage = createStorageClient(DECLARATIONS_BUCKET)
    await Promise.all(files.map(async file => storage.deleteObject(file.storageKey, true)))
  } catch (error) {
    console.warn(`[declarations] suppression fichiers S3 ignorée: ${error.message}`)
  }
}

function getObjectMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {}
  }

  return metadata
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

const QUICK_DECLARATION_MEASUREMENT_TYPES = Object.freeze({
  INDEX: 'INDEX',
  VOLUME_PRELEVE: 'VOLUME_PRELEVE',
  VOLUME_REJETE: 'VOLUME_REJETE'
})

const quickDeclarationEntrySchema = Joi.object({
  pointPrelevementId: Joi.string().uuid({version: 'uuidv4'}).required(),
  index: Joi.number().min(0).precision(4),
  value: Joi.number().min(0).precision(4),
  usageId: Joi.string().uuid({version: 'uuidv4'}),
  usage: Joi.string().trim()
}).or('index', 'value').or('usageId', 'usage')

const createQuickDeclarationSchema = Joi.object({
  type: Joi.string().trim().min(1).max(120).allow('').optional(),
  declarantUserId: Joi.string().uuid({version: 'uuidv4'}).optional(),
  preleveurUserId: Joi.string().uuid({version: 'uuidv4'}).optional(),
  targetDeclarantUserId: Joi.string().uuid({version: 'uuidv4'}).optional(),
  measurementType: Joi.string().valid(...Object.values(QUICK_DECLARATION_MEASUREMENT_TYPES)).default(QUICK_DECLARATION_MEASUREMENT_TYPES.INDEX),
  readingDate: Joi.string().trim().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  periodStartDate: Joi.string().trim().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  periodEndDate: Joi.string().trim().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
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

function parseQuickDeclarationDate(value, label) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''))

  if (!match) {
    throw createHttpError(400, `${label} doit être au format YYYY-MM-DD.`)
  }

  const [, year, month, day] = match
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))

  if (
    Number.isNaN(date.getTime())
    || date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() !== Number(month) - 1
    || date.getUTCDate() !== Number(day)
  ) {
    throw createHttpError(400, `${label} est invalide.`)
  }

  return date
}

function parseReadingDate(value) {
  return parseQuickDeclarationDate(value, 'La date de relevé')
}

function formatDateForMetadata(date) {
  return date.toISOString().slice(0, 10)
}

function addUtcDays(date, days) {
  const nextDate = new Date(date)
  nextDate.setUTCDate(nextDate.getUTCDate() + days)
  return nextDate
}

function getQuickDeclarationMetricTypeCode(measurementType) {
  if (measurementType === QUICK_DECLARATION_MEASUREMENT_TYPES.VOLUME_REJETE) {
    return METRIC_TYPE_CODES.VOLUME_REJETE
  }

  if (measurementType === QUICK_DECLARATION_MEASUREMENT_TYPES.VOLUME_PRELEVE) {
    return METRIC_TYPE_CODES.VOLUME_PRELEVE
  }

  return METRIC_TYPE_CODES.RELEVE_INDEX
}

function getQuickDeclarationPeriodMetadata({
  isIndexMeasurement,
  periodEndDateLabel,
  periodStartDateLabel,
  readingDateLabel
}) {
  if (isIndexMeasurement) {
    return {readingDate: readingDateLabel}
  }

  return {
    periodStartDate: periodStartDateLabel,
    periodEndDate: periodEndDateLabel
  }
}

function getQuickDeclarationVolumeTotals(measurementType, value) {
  let totalWaterVolumeWithdrawn = 0
  let totalWaterVolumeDischarged = 0

  if (measurementType === QUICK_DECLARATION_MEASUREMENT_TYPES.VOLUME_PRELEVE) {
    totalWaterVolumeWithdrawn = value
  }

  if (measurementType === QUICK_DECLARATION_MEASUREMENT_TYPES.VOLUME_REJETE) {
    totalWaterVolumeDischarged = value
  }

  return {
    totalWaterVolumeWithdrawn,
    totalWaterVolumeDischarged
  }
}

function sumQuickDeclarationVolumeTotals(measurementType, entries) {
  const totalValue = entries.reduce((total, entry) => total + entry.value, 0)

  return getQuickDeclarationVolumeTotals(measurementType, totalValue)
}

function getQuickDeclarationIndexMetadata(isIndexMeasurement, value) {
  if (!isIndexMeasurement) {
    return {}
  }

  return {
    indexValue: value,
    indexUnit: 'm³'
  }
}

function getQuickDeclarationValuePeriodEnd(isIndexMeasurement, periodEndDate) {
  if (isIndexMeasurement) {
    return periodEndDate
  }

  return addUtcDays(periodEndDate, 1)
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

async function getReadableDeclarantUserIdsForDeclarant(user) {
  const preleveurIds = user.declarant?.declarantRole === 'COLLECTEUR'
    ? await getPreleveurIdsForCollecteur(user.id)
    : []

  return [...new Set([user.id, ...preleveurIds].filter(Boolean))]
}

function canReadTelemetrySourceWhere(declarantUserIds) {
  return {
    type: 'API',
    chunks: {
      some: {
        pointPrelevement: {
          declarants: {
            some: {
              declarantUserId: {
                in: declarantUserIds
              }
            }
          }
        }
      }
    }
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

function getTelemetrySourceDeclarant(source, declarantUserIds) {
  const declarantUserIdsSet = new Set(declarantUserIds)
  const links = (source.chunks ?? [])
    .flatMap(chunk => chunk.pointPrelevement?.declarants ?? [])
    .filter(link => declarantUserIdsSet.has(link.declarantUserId))

  const directLink = links.find(link => link.declarantUserId === declarantUserIds[0])
  const link = directLink ?? links[0]

  return getDeclarantDisplay(link?.declarant)
}

function decorateTelemetrySourcesForDeclarant(sources, declarantUserIds) {
  return sources.map(source => ({
    ...source,
    declarant: getTelemetrySourceDeclarant(source, declarantUserIds)
  }))
}

const sourceStatusLabels = {
  PENDING: 'Traitement en attente',
  PROCESSING: 'Traitement en cours',
  FAILED: 'Traitement en erreur',
  TO_INSTRUCT: 'Points à associer',
  VALIDATED: 'Points associés',
  REJECTED: 'Remplacée',
  PARTIALLY_VALIDATED: 'Partiellement associée',
  INSTRUCTION_IN_PROGRESS: 'Association en cours'
}

const dataSourceTypeLabels = {
  MANUAL: 'Saisie rapide',
  SPREADSHEET: 'Dépôt de fichier',
  API: 'Télérelève',
  NONE: 'Aucun fichier'
}

const fallbackDeclarationTypeLabels = {
  'aep-zre': 'AEP ou en ZRE',
  'icpe-hors-zre': 'ICPE hors ZRE',
  'camion-citerne': 'Camion citerne',
  'quick-declaration': 'Saisie rapide',
  'template-file': 'Modèle de déclaration de volumes',
  'extract-aquasys': 'Extraction Aquasys',
  gidaf: 'Extraction Gidaf',
  unknown: 'Autre'
}

function formatPointsChangeRequestDate(value) {
  if (!value) {
    return null
  }

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return null
  }

  return new Intl.DateTimeFormat('fr-FR').format(date)
}

function formatPointsChangeRequestNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? new Intl.NumberFormat('fr-FR').format(number) : null
}

function getDeclarationTypeLabelForPointsChangeRequest(declaration) {
  if (declaration?.declarationType?.name) {
    return declaration.declarationType.name
  }

  const normalizedCode = String(declaration?.type ?? '').trim().toLocaleLowerCase('fr-FR')

  return fallbackDeclarationTypeLabels[normalizedCode] ?? (normalizedCode || fallbackDeclarationTypeLabels.unknown)
}

function getDeclarantLabelForPointsChangeRequest(declarant) {
  if (!declarant) {
    return null
  }

  const user = declarant.user ?? declarant
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim()

  return declarant.socialReason || fullName || user.email || declarant.email || null
}

function getUserLabelForPointsChangeRequest(user) {
  const fullName = [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim()
  return [fullName, user?.email].filter(Boolean).join(' - ') || null
}

function getSourceStatusLabel(source) {
  if (!source) {
    return sourceStatusLabels.PROCESSING
  }

  if (source.status && source.status !== 'COMPLETED') {
    return sourceStatusLabels[source.status] ?? source.status
  }

  return sourceStatusLabels[source.globalInstructionStatus] ?? source.globalInstructionStatus
}

function getSourcePeriodLabelForPointsChangeRequest(source) {
  const dates = (source?.chunks ?? []).flatMap(chunk => [chunk.minDate, chunk.maxDate].filter(Boolean))

  if (dates.length === 0) {
    return null
  }

  const timestamps = dates
    .map(value => new Date(value).getTime())
    .filter(timestamp => Number.isFinite(timestamp))

  if (timestamps.length === 0) {
    return null
  }

  const start = formatPointsChangeRequestDate(Math.min(...timestamps))
  const end = formatPointsChangeRequestDate(Math.max(...timestamps))

  return start === end ? start : `${start} au ${end}`
}

function getChunkCountLabel(source) {
  const count = source?.chunks?.length ?? 0
  return `${count} ligne${count > 1 ? 's' : ''}`
}

function getMatchedPointsLabel(source) {
  const chunks = source?.chunks ?? []
  const matchedCount = chunks.filter(chunk => chunk.pointPrelevementId).length
  const totalCount = chunks.length

  return `${matchedCount}/${totalCount}`
}

function getTotalWithdrawnLabel(source) {
  const value = source?.metadata?.totalWaterVolumeWithdrawn
  const formatted = formatPointsChangeRequestNumber(value)

  return formatted ? `${formatted} m³` : null
}

function buildDeclarationPointsChangeRequestContext(declaration) {
  const createdByDeclarantLabel = getDeclarantLabelForPointsChangeRequest(declaration.createdByDeclarant)
  const declarantLabel = getDeclarantLabelForPointsChangeRequest(declaration.declarant)

  return {
    declarationLabel: `Déclaration n°${declaration.code}`,
    url: `${FRONT_URL}/mes-declarations/${declaration.id}`,
    statusLabel: getSourceStatusLabel(declaration.source),
    periodLabel: getSourcePeriodLabelForPointsChangeRequest(declaration.source),
    declarantLabel,
    createdByDeclarantLabel: createdByDeclarantLabel && createdByDeclarantLabel !== declarantLabel
      ? createdByDeclarantLabel
      : null,
    declarationTypeLabel: getDeclarationTypeLabelForPointsChangeRequest(declaration),
    dataSourceTypeLabel: dataSourceTypeLabels[declaration.dataSourceType] ?? declaration.dataSourceType,
    chunkCountLabel: getChunkCountLabel(declaration.source),
    matchedPointsLabel: getMatchedPointsLabel(declaration.source),
    totalWithdrawnLabel: getTotalWithdrawnLabel(declaration.source),
    fileLabels: (declaration.files ?? []).map(file => file.filename || file.type)
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

async function getLastVolumePeriodsByPoint({declarantUserId, pointPrelevementIds}) {
  if (!Array.isArray(pointPrelevementIds) || pointPrelevementIds.length === 0) {
    return new Map()
  }

  const values = await prisma.chunkValue.findMany({
    where: {
      valueKind: 'DECLARED',
      metricTypeCode: {in: VOLUME_METRIC_TYPE_CODES},
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
      metricTypeCode: true,
      periodStart: true,
      periodEnd: true,
      frequency: true,
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
    const volumeKind = value.metricTypeCode === METRIC_TYPE_CODES.VOLUME_REJETE
      ? 'discharged'
      : 'withdrawn'

    if (!pointPrelevementId) {
      continue
    }

    const pointVolumes = byPointId.get(pointPrelevementId) ?? {}

    if (pointVolumes[volumeKind]) {
      continue
    }

    pointVolumes[volumeKind] = {
      value: decimalToNumber(value.value),
      unit: value.unit ?? 'm³',
      frequency: value.frequency,
      periodStart: value.periodStart?.toISOString?.() ?? value.periodStart,
      periodEnd: value.periodEnd?.toISOString?.() ?? value.periodEnd
    }
    byPointId.set(pointPrelevementId, pointVolumes)
  }

  return byPointId
}

async function getLatestIndexReadingsByPoint({
  declarantUserId,
  pointPrelevementIds,
  limit = LATEST_INDEX_READINGS_LIMIT
}) {
  if (!Array.isArray(pointPrelevementIds) || pointPrelevementIds.length === 0) {
    return new Map()
  }

  const uniquePointIds = [...new Set(pointPrelevementIds.filter(Boolean))]
  if (uniquePointIds.length === 0) {
    return new Map()
  }

  const safeLimit = Math.max(1, Math.min(Number(limit) || LATEST_INDEX_READINGS_LIMIT, 50))
  const pointIdFilters = uniquePointIds.map(pointId => Prisma.sql`${pointId}::uuid`)

  const values = await prisma.$queryRaw`
    WITH ranked_index_values AS (
      SELECT
        v.id,
        v."metricTypeCode",
        v."periodStart",
        v."periodEnd",
        v.value,
        v.unit,
        c."pointPrelevementId",
        c."sourceId",
        s."declarationId",
        ROW_NUMBER() OVER (
          PARTITION BY c."pointPrelevementId"
          ORDER BY v."periodEnd" DESC, v."createdAt" DESC, v.id DESC
        ) AS "rowNumber"
      FROM "ChunkValue" v
      JOIN "Chunk" c ON c.id = v."chunkId"
      JOIN "Source" s ON s.id = c."sourceId"
      JOIN "Declaration" d ON d.id = s."declarationId"
      WHERE v."valueKind" = 'DECLARED'
        AND v."metricTypeCode" IN (${Prisma.join(INDEX_METRIC_TYPE_CODES)})
        AND c."pointPrelevementId" IN (${Prisma.join(pointIdFilters)})
        AND s.status = 'COMPLETED'
        AND d."declarantUserId" = ${declarantUserId}::uuid
    )
    SELECT
      id,
      "metricTypeCode",
      "periodStart",
      "periodEnd",
      value,
      unit,
      "pointPrelevementId",
      "sourceId",
      "declarationId"
    FROM ranked_index_values
    WHERE "rowNumber" <= ${safeLimit}
    ORDER BY "pointPrelevementId", "periodEnd" DESC, id DESC
  `

  const byPointId = new Map()

  for (const value of values) {
    const {pointPrelevementId} = value

    if (!pointPrelevementId) {
      continue
    }

    const pointValues = byPointId.get(pointPrelevementId) ?? []
    pointValues.push({
      id: value.id,
      metricTypeCode: value.metricTypeCode,
      periodStart: value.periodStart,
      periodEnd: value.periodEnd,
      value: decimalToNumber(value.value),
      unit: value.unit ?? 'm³',
      sourceId: value.sourceId,
      declarationId: value.declarationId
    })
    byPointId.set(pointPrelevementId, pointValues)
  }

  return byPointId
}

function decorateQuickDeclarationChunksWithLatestIndexReadings(declaration, latestIndexReadingsByPoint) {
  if (declaration.source?.metadata?.manualQuickDeclaration !== true) {
    return declaration
  }

  return {
    ...declaration,
    source: {
      ...declaration.source,
      chunks: declaration.source.chunks.map(chunk => ({
        ...chunk,
        latestIndexReadings: latestIndexReadingsByPoint.get(chunk.pointPrelevementId) ?? []
      }))
    }
  }
}

async function getLastKnownUsagesByPoint({declarantUserId, pointPrelevementIds}) {
  if (!Array.isArray(pointPrelevementIds) || pointPrelevementIds.length === 0) {
    return new Map()
  }

  const chunks = await prisma.chunk.findMany({
    where: {
      pointPrelevementId: {in: pointPrelevementIds},
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
    const usage = serializeWaterUse(chunk.usage)

    if (!pointPrelevementId || byPointId.has(pointPrelevementId) || !usage) {
      continue
    }

    byPointId.set(pointPrelevementId, usage)
  }

  return byPointId
}

function serializeQuickDeclarationPointIdentity(point) {
  return {
    id: point?.id,
    pointPrelevementId: point?.id,
    name: getPointDisplayName(point),
    waterBodyType: point?.waterBodyType ?? null,
    nature: point?.nature ?? null,
    withdrawalType: point?.withdrawalType ?? null
  }
}

function serializeQuickDeclarationLastReading(lastReading) {
  if (!lastReading) {
    return null
  }

  return {
    ...lastReading,
    date: lastReading.date?.toISOString?.() ?? lastReading.date
  }
}

function serializeQuickDeclarationPoint({
  coordsById,
  exploitation,
  lastKnownUsagesByPointId,
  lastReadingsByPointId,
  lastVolumePeriodsByPointId,
  usageOptions
}) {
  const point = exploitation.pointPrelevement
  const pointId = point?.id

  return {
    ...serializeQuickDeclarationPointIdentity(point),
    exploitationId: exploitation.id,
    coordinates: coordsById.get(pointId) ?? null,
    usage: serializeWaterUse(exploitation.usage),
    usageOptions,
    declarationUsageOptions: usageOptions,
    lastKnownUsage: lastKnownUsagesByPointId.get(pointId) ?? null,
    lastVolumePeriods: lastVolumePeriodsByPointId.get(pointId) ?? null,
    lastReading: serializeQuickDeclarationLastReading(lastReadingsByPointId.get(pointId))
  }
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
      pointPrelevement: true,
      usage: true
    },
    orderBy: [
      {createdAt: 'asc'}
    ]
  })

  const pointIds = exploitations
    .map(exploitation => exploitation.pointPrelevementId)
    .filter(Boolean)

  const [coordsById, lastReadingsByPointId, lastKnownUsagesByPointId, lastVolumePeriodsByPointId, waterUses] = await Promise.all([
    getCoordsByPointIds(pointIds),
    getLastIndexReadingsByPoint({declarantUserId, pointPrelevementIds: pointIds}),
    getLastKnownUsagesByPoint({declarantUserId, pointPrelevementIds: pointIds}),
    getLastVolumePeriodsByPoint({declarantUserId, pointPrelevementIds: pointIds}),
    listSandreWaterUses()
  ])

  const usageOptions = serializeWaterUses(waterUses)

  return exploitations
    .map(exploitation => serializeQuickDeclarationPoint({
      coordsById,
      exploitation,
      lastKnownUsagesByPointId,
      lastReadingsByPointId,
      lastVolumePeriodsByPointId,
      usageOptions
    }))
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
      pointPrelevement: true,
      usage: true
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
          usage: true,
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
          usage: true,
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
        canCreateQuickDeclaration: actorQuickDeclarationEnabled && quickDeclarationEnabled,
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
      canCreateQuickDeclaration: actorQuickDeclarationEnabled,
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
    const [points, waterUses] = await Promise.all([
      getQuickDeclarationPoints(targetDeclarantUserId),
      listSandreWaterUses()
    ])

    return res.json({
      success: true,
      data: {
        declarantUserId: targetDeclarantUserId,
        quickDeclarationEnabled: true,
        canCreateQuickDeclaration: true,
        allowedDeclarationTypes,
        usageOptions: serializeWaterUses(waterUses),
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
    const measurementType = value.measurementType ?? QUICK_DECLARATION_MEASUREMENT_TYPES.INDEX
    const isIndexMeasurement = measurementType === QUICK_DECLARATION_MEASUREMENT_TYPES.INDEX
    const metricTypeCode = getQuickDeclarationMetricTypeCode(measurementType)
    const readingDate = isIndexMeasurement ? parseReadingDate(value.readingDate) : null
    const periodStartDate = isIndexMeasurement
      ? readingDate
      : parseQuickDeclarationDate(value.periodStartDate, 'La date de début')
    const periodEndDate = isIndexMeasurement
      ? readingDate
      : parseQuickDeclarationDate(value.periodEndDate, 'La date de fin')
    if (periodEndDate < periodStartDate) {
      throw createHttpError(400, 'La date de fin doit être postérieure ou égale à la date de début.')
    }

    const readingDateLabel = readingDate ? formatDateForMetadata(readingDate) : null
    const periodStartDateLabel = formatDateForMetadata(periodStartDate)
    const periodEndDateLabel = formatDateForMetadata(periodEndDate)
    const periodMetadata = getQuickDeclarationPeriodMetadata({
      isIndexMeasurement,
      periodEndDateLabel,
      periodStartDateLabel,
      readingDateLabel
    })
    const comment = typeof value.comment === 'string' && value.comment.trim()
      ? value.comment.trim()
      : null
    const valuePeriodEnd = getQuickDeclarationValuePeriodEnd(isIndexMeasurement, periodEndDate)
    const aotDecreeNumber = typeof value.aotDecreeNumber === 'string' && value.aotDecreeNumber.trim()
      ? value.aotDecreeNumber.trim()
      : null
    const entries = await Promise.all(value.entries.map(async entry => {
      const usage = await resolveWaterUseInput(entry, {declaration: true})

      return {
        pointPrelevementId: entry.pointPrelevementId,
        value: Number(entry.value ?? entry.index),
        usageId: usage.id,
        usage
      }
    }))

    ensureUniquePointEntries(entries)

    await assertCanDeclareFor({actorDeclarantUserId: createdByDeclarantUserId, targetDeclarantUserId: declarantUserId})
    await assertQuickDeclarationEnabled({actorDeclarantUserId: createdByDeclarantUserId, targetDeclarantUserId: declarantUserId})

    let declarationType = QUICK_DECLARATION_TYPE

    if (!type || type === QUICK_DECLARATION_TYPE_CODE) {
      type = QUICK_DECLARATION_TYPE_CODE
    } else {
      declarationType = await findAllowedDeclarationTypeForDeclarant(
        declarantUserId,
        type
      )

      if (!declarationType) {
        throw createHttpError(
          403,
          `Le préleveur concerné n’est pas autorisé à déposer une déclaration de type "${type}".`
        )
      }
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

    const quickDeclarationTotals = sumQuickDeclarationVolumeTotals(measurementType, entries)

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
            measurementType,
            ...periodMetadata,
            entriesCount: entries.length,
            ...quickDeclarationTotals
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
                usageId: entry.usageId,
                minDate: periodStartDate,
                maxDate: periodEndDate,
                parsingInfo: {
                  parser: 'quick-declaration-form',
                  reason: 'MANUAL_QUICK_DECLARATION'
                },
                metadata: {
                  quickDeclaration: true,
                  measurementType,
                  declaredValue: entry.value,
                  unit: 'm³',
                  ...periodMetadata,
                  ...getQuickDeclarationIndexMetadata(isIndexMeasurement, entry.value),
                  ...getQuickDeclarationVolumeTotals(measurementType, entry.value)
                },
                chunkValues: {
                  create: [
                    {
                      id: randomUUID(),
                      metricTypeCode,
                      unit: 'm³',
                      frequency: isIndexMeasurement ? 'instant' : '1 day',
                      periodStart: periodStartDate,
                      periodEnd: valuePeriodEnd,
                      valueKind: 'DECLARED',
                      value: entry.value
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
        const rootUsageId = getWaterUseRootId(entry.usage)

        if (rootUsageId && exploitation.usageId !== rootUsageId) {
          // eslint-disable-next-line no-await-in-loop
          await tx.declarantPointPrelevement.update({
            where: {id: exploitation.id},
            data: {usageId: rootUsageId}
          })
        }

        // eslint-disable-next-line no-await-in-loop
        await tx.declarantPointPrelevement.updateMany({
          where: {
            id: exploitation.id,
            OR: [
              {mostRecentAvailableDate: null},
              {mostRecentAvailableDate: {lt: periodEndDate}}
            ]
          },
          data: {
            mostRecentAvailableDate: periodEndDate
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
    if (isIndexMeasurement) {
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
              usage: true,
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
        declarationType,
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
            chunks: {
              include: {
                usage: true
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

export async function listMyTelemetrySourcesHandler(req, res, next) {
  try {
    const declarantUserIds = await getReadableDeclarantUserIdsForDeclarant(req.user)

    const sources = await prisma.source.findMany({
      where: canReadTelemetrySourceWhere(declarantUserIds),
      orderBy: {createdAt: 'desc'},
      include: {
        chunks: {
          orderBy: [{minDate: 'asc'}, {createdAt: 'asc'}],
          include: {
            usage: true,
            pointPrelevement: {
              include: {
                declarants: {
                  where: {
                    declarantUserId: {
                      in: declarantUserIds
                    }
                  },
                  include: {
                    declarant: {
                      include: {
                        user: true
                      }
                    }
                  }
                }
              }
            }
          }
        },
        _count: {
          select: {
            chunks: true
          }
        }
      }
    })

    return res.json({
      success: true,
      data: decorateTelemetrySourcesForDeclarant(sources, declarantUserIds)
    })
  } catch (error) {
    next(error)
  }
}

export async function getMyTelemetrySourceHandler(req, res, next) {
  try {
    const sourceId = String(req.params.sourceId || '').trim()
    const {error} = sourceIdSchema.validate({sourceId})
    if (error) {
      throw createHttpError(400, error.message)
    }

    const declarantUserIds = await getReadableDeclarantUserIdsForDeclarant(req.user)

    const source = await prisma.source.findFirst({
      where: {
        id: sourceId,
        ...canReadTelemetrySourceWhere(declarantUserIds)
      },
      include: {
        chunks: {
          orderBy: [{minDate: 'asc'}, {createdAt: 'asc'}],
          include: {
            usage: true,
            pointPrelevement: {
              include: {
                declarants: {
                  where: {
                    declarantUserId: {
                      in: declarantUserIds
                    }
                  },
                  include: {
                    declarant: {
                      include: {
                        user: true
                      }
                    }
                  }
                }
              }
            },
            chunkValues: {
              orderBy: {
                periodEnd: 'asc'
              }
            }
          }
        },
        _count: {
          select: {
            chunks: true
          }
        }
      }
    })

    if (!source) {
      throw createHttpError(404, 'Télérelève introuvable')
    }

    const [decorated] = decorateTelemetrySourcesForDeclarant([source], declarantUserIds)

    return res.json({
      success: true,
      data: decorated
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
                usage: true,
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

    const pointPrelevementIds = declaration.source?.metadata?.manualQuickDeclaration === true
      ? [...new Set(declaration.source.chunks.map(chunk => chunk.pointPrelevementId).filter(Boolean))]
      : []
    const latestIndexReadingsByPoint = await getLatestIndexReadingsByPoint({
      declarantUserId: declaration.declarantUserId,
      pointPrelevementIds
    })
    const declarationWithLatestIndexReadings = decorateQuickDeclarationChunksWithLatestIndexReadings(
      declaration,
      latestIndexReadingsByPoint
    )
    const [declarationWithActors] = await decorateDeclarationActors([declarationWithLatestIndexReadings])
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

export async function requestDeclarationPointsChangeHandler(req, res, next) {
  try {
    const declarationId = String(req.params.declarationId || '').trim()
    const {error: declarationIdError} = declarationIdSchema.validate({declarationId})
    if (declarationIdError) {
      throw createHttpError(400, declarationIdError.message)
    }

    const {error, value} = declarationPointsChangeRequestSchema.validate(req.body, {
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
      include: {
        files: true,
        source: {
          include: {
            chunks: {
              include: {
                pointPrelevement: true,
                usage: true
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
    const context = {
      ...buildDeclarationPointsChangeRequestContext(declarationWithType),
      requesterLabel: getUserLabelForPointsChangeRequest(req.user)
    }
    const html = renderDeclarationPointsChangeRequestEmail({
      context,
      message: value.message
    })

    await sendEmail(
      DECLARATION_POINTS_CHANGE_REQUEST_EMAIL,
      `[Partageons l'Eau] Demande de modification de points - déclaration ${declaration.code}`,
      html
    )

    return res.json({
      success: true,
      data: {
        recipient: DECLARATION_POINTS_CHANGE_REQUEST_EMAIL
      }
    })
  } catch (error) {
    next(error)
  }
}

export async function deleteDeclarationHandler(req, res, next) {
  try {
    const declarationId = String(req.params.declarationId || '').trim()
    const {error} = declarationIdSchema.validate({declarationId})

    if (error) {
      throw createHttpError(400, error.message)
    }

    const declaration = await prisma.declaration.findUnique({
      where: {id: declarationId},
      select: {
        id: true,
        code: true,
        declarantUserId: true,
        createdByDeclarantUserId: true,
        files: {
          select: {
            storageKey: true
          }
        },
        source: {
          select: {
            id: true,
            chunks: {
              select: {
                pointPrelevementId: true,
                chunkValues: {
                  where: {
                    metricTypeCode: {in: INDEX_METRIC_TYPE_CODES}
                  },
                  select: {
                    id: true
                  },
                  take: 1
                }
              }
            }
          }
        }
      }
    })

    if (!declaration) {
      throw createHttpError(404, 'Déclaration introuvable')
    }

    await prisma.declaration.delete({
      where: {id: declaration.id}
    })

    const declarantUserIds = [
      ...new Set([
        declaration.declarantUserId,
        declaration.createdByDeclarantUserId
      ].filter(Boolean))
    ]

    const impactedIndexPointPrelevementIds = [
      ...new Set(
        (declaration.source?.chunks ?? [])
          .filter(chunk => chunk.pointPrelevementId && chunk.chunkValues.length > 0)
          .map(chunk => chunk.pointPrelevementId)
      )
    ]

    await Promise.all(declarantUserIds.map(async declarantUserId => refreshLastDeclarationAt(declarantUserId)))
    await Promise.all(
      impactedIndexPointPrelevementIds.map(async pointPrelevementId =>
        reconstructVolumesFromIndexForPoint(pointPrelevementId)
      )
    )
    await refreshMostRecentAvailableDateForDeclarantPoints({
      declarantUserId: declaration.declarantUserId,
      pointPrelevementIds: declaration.source?.chunks.map(chunk => chunk.pointPrelevementId) ?? []
    })
    await deleteDeclarationFilesFromStorage(declaration.files)

    return res.json({
      success: true,
      data: {
        id: declaration.id,
        code: declaration.code,
        sourceId: declaration.source?.id ?? null
      }
    })
  } catch (error) {
    next(error)
  }
}

export async function replayDeclarationHandler(req, res, next) {
  try {
    const declarationId = String(req.params.declarationId || '').trim()
    const {error} = declarationIdSchema.validate({declarationId})

    if (error) {
      throw createHttpError(400, error.message)
    }

    const declaration = await prisma.declaration.findUnique({
      where: {id: declarationId},
      select: {
        id: true,
        code: true,
        files: {
          select: {
            id: true
          }
        },
        source: {
          select: {
            id: true,
            status: true,
            globalInstructionStatus: true,
            metadata: true
          }
        }
      }
    })

    if (!declaration) {
      throw createHttpError(404, 'Déclaration introuvable')
    }

    if (declaration.files.length === 0) {
      throw createHttpError(400, 'Seules les déclarations avec fichier peuvent être rejouées par l’orchestrateur.')
    }

    const previousSource = declaration.source

    if (previousSource?.id) {
      await prisma.source.update({
        where: {id: previousSource.id},
        data: {
          status: 'PENDING',
          globalInstructionStatus: 'TO_INSTRUCT',
          metadata: {
            ...getObjectMetadata(previousSource.metadata),
            replayRequestedAt: new Date().toISOString(),
            replayRequestedByUserId: req.user.id
          }
        }
      })
    }

    let orchestration
    try {
      orchestration = await notifyDeclarationUploaded({
        declarationId: declaration.id,
        required: true
      })
    } catch (error_) {
      if (previousSource?.id) {
        await prisma.source.update({
          where: {id: previousSource.id},
          data: {
            status: previousSource.status,
            globalInstructionStatus: previousSource.globalInstructionStatus,
            metadata: getObjectMetadata(previousSource.metadata)
          }
        })
      }

      throw error_
    }

    return res.status(202).json({
      success: true,
      data: {
        id: declaration.id,
        code: declaration.code,
        sourceId: declaration.source?.id ?? null,
        orchestration
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

    const isDeclarant = req.user.role === 'DECLARANT'
    const isInstructor = req.user.role === 'INSTRUCTOR'
    const userId = req.user.id

    const declaration = isDeclarant
      ? await prisma.declaration.findFirst({
        where: {
          id: declarationId,
          ...canReadDeclarationWhere(
            userId,
            req.user.declarant?.declarantRole === 'COLLECTEUR'
              ? await getPreleveurIdsForCollecteur(userId)
              : []
          )
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
      : await prisma.declaration.findUnique({
        where: {id: declarationId},
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
        usageId: true,
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
    if (isInstructor) {
      const chunkAuthorization = await getChunkAuthorizationForInstructor(req.user.id, chunk.id)
      if (!chunkAuthorization?.canWrite) {
        throw createHttpError(403, 'Droits insuffisants pour modifier ce rapprochement.')
      }

      if (targetPointPrelevementId) {
        const accessiblePointIds = await getAccessiblePointPrelevementIdsSetForInstructor(req.user.id)
        if (!accessiblePointIds.has(targetPointPrelevementId)) {
          throw createHttpError(403, 'Ce point de prélèvement n’est pas dans votre périmètre.')
        }
      }
    }

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
    }

    const previousAliases = previousExploitation
      ? removePointNameAlias(previousExploitation.pointPrelevementNameAliases, alias)
      : null
    const changedAtIso = new Date().toISOString()
    const rootUsageId = !isDetaching && chunk.usage
      ? getWaterUseRootId(chunk.usage)
      : null

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
            reason: `POINT_${isDetaching ? 'DETACHED' : 'RECONCILED'}_BY_${req.user.role}`,
            changedByUserId: req.user.id,
            changedByRole: req.user.role,
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
            ...(rootUsageId && exploitation.usageId !== rootUsageId ? {usageId: rootUsageId} : {})
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
      usage: true,
      mostRecentAvailableDate: true
    }
  })
  const exploitationByPointId = new Map()

  for (const exploitation of exploitations) {
    const existing = exploitationByPointId.get(exploitation.pointPrelevementId) ?? {
      pointPrelevementNameAliases: [],
      usages: [],
      usagesById: new Map(),
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

    const usagesById = new Map(existing.usagesById)
    if (exploitation.usage?.id) {
      usagesById.set(exploitation.usage.id, serializeWaterUse(exploitation.usage))
    }

    exploitationByPointId.set(exploitation.pointPrelevementId, {
      pointPrelevementNameAliases: [
        ...new Set([
          ...existing.pointPrelevementNameAliases,
          ...exploitation.pointPrelevementNameAliases
        ])
      ],
      usages: [...usagesById.values()],
      usagesById,
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
