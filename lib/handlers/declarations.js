import createHttpError from 'http-errors'
import Joi from 'joi'
import {Prisma} from '@prisma/client'
import crypto, {randomUUID} from 'node:crypto'
import path from 'node:path'
import {Buffer} from 'node:buffer'
import process from 'node:process'

import createStorageClient from '../util/s3.js'
import {prisma} from '../../db/prisma.js'
import {getCoordsByPointIds} from '../models/point-prelevement.js'
import {
  exploitationAtDateWhere,
  findUniqueExploitationForPeriod,
  indexUniqueExploitationsByPoint
} from '../services/exploitation-periods.js'
import {
  getCollecteurDeclarationTargets,
  getDeclarantUserIdsForSourceActivity,
  getSourceActivityDeclarantUserIds,
  refreshDeclarantsLastDeclarationAt,
  refreshSourceDeclarantsLastDeclarationAt,
  updateLastDeclarationAt
} from '../models/declarant.js'
import {
  addExploitationSecondaryUsage,
  getPreleveurIdsForCollecteur
} from '../models/exploitation.js'
import {getReplayableDeclarationsWhere} from '../services/replayable-declarations.js'
import {computeGlobalPointMatchingStatus} from './chunks.js'
import {refreshMostRecentAvailableDateForDeclarantPoints} from '../services/declaration-side-effects.js'
import {
  decorateDeclarationsWithDeclarationTypes,
  findAllowedDeclarationTypeForDeclarant,
  listAllowedDeclarationTypesForDeclarant,
  listAllowedDeclarationTypesForDeclarants,
  normalizeDeclarationTypeCode
} from '../models/declaration-type.js'
import {
  LEGACY_METRIC_TYPE_CODES,
  METRIC_TYPE_CODES
} from '../constants/metric-type-codes.js'
import {
  POINT_FLOW_TYPES,
  getSourceFlowTypeFromMetadata
} from '../constants/point-flow-types.js'
import {
  getWaterUseRootId,
  listSandreWaterUses,
  resolveWaterUseInput,
  serializeWaterUse,
  serializeWaterUses
} from '../services/sandre-water-uses.js'
import {
  getExploitationWaterUses,
  serializeExploitationUsageFields
} from '../services/exploitation-usages.js'
import {INDEX_METRIC_TYPE_CODES, reconstructVolumesFromIndexForPoint} from '../services/volumes-from-index.js'
import {renderDeclarationPointsChangeRequestEmail} from '../util/email-templates.js'
import {sendEmail} from '../util/email.js'
import {computeInstantPeriodEnd} from '../util/temporal-discretization.js'
import {
  markDeclarationProcessingCompleted,
  markDeclarationProcessingUploaded,
  requestDeclarationProcessing
} from '../services/declaration-processing.js'
import {
  applyConflictPolicyForIncomingChunkValues,
  findConflictingChunkValuesForIncomingChunkValues
} from '../services/chunk-value-conflicts.js'
import {buildChunkActorData} from '../services/chunk-actors.js'
import {
  AUTOMATIC_POINT_ASSOCIATION_LOCK_REASON,
  buildManualChunkPointAssociationParsingInfo,
  decorateSourcePointAssociations,
  getChunkPointAssociationOrigin,
  isChunkPointAssociationChangeAllowed
} from '../services/chunk-point-associations.js'
import {
  refreshVolumeMetadataForSourceIds,
  resolveValueFlowType
} from '../services/volume-totals.js'
import {
  getPermissionZoneIdsForUser,
  syncDeclarantZonesFromPoint
} from '../services/zone-permissions.js'

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
  METRIC_TYPE_CODES.VOLUME,
  LEGACY_METRIC_TYPE_CODES.VOLUME_PRELEVE,
  LEGACY_METRIC_TYPE_CODES.VOLUME_REJETE
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

const quickDeclarationContextSchema = Joi.object({
  declarantUserId: Joi.string().uuid({version: 'uuidv4'}).optional(),
  preleveurUserId: Joi.string().uuid({version: 'uuidv4'}).optional(),
  targetDeclarantUserId: Joi.string().uuid({version: 'uuidv4'}).optional()
}).unknown(true)

const QUICK_DECLARATION_MEASUREMENT_TYPES = Object.freeze({
  INDEX: 'INDEX',
  VOLUME: 'VOLUME',
  // Compatibilité temporaire avec les clients déployés avant la séparation.
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

const quickDeclarationPointUsageNameSchema = Joi.object({
  pointPrelevementId: Joi.string().uuid({version: 'uuidv4'}).required(),
  usageName: Joi.string().trim().max(200).allow('', null).required()
})

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
  entries: Joi.array().items(quickDeclarationEntrySchema).min(1).max(500).required(),
  pointUsageNames: Joi.array().items(quickDeclarationPointUsageNameSchema).max(500).default([])
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
    throw createHttpError(403, 'La saisie rapide est indisponible pour le moment.')
  }

  if (byId.get(targetDeclarantUserId)?.quickDeclarationEnabled === false) {
    throw createHttpError(403, 'La saisie rapide est indisponible pour le moment.')
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
  return measurementType === QUICK_DECLARATION_MEASUREMENT_TYPES.INDEX
    ? METRIC_TYPE_CODES.INDEX
    : METRIC_TYPE_CODES.VOLUME
}

function normalizeQuickDeclarationMeasurementType(measurementType) {
  return measurementType === QUICK_DECLARATION_MEASUREMENT_TYPES.INDEX
    ? QUICK_DECLARATION_MEASUREMENT_TYPES.INDEX
    : QUICK_DECLARATION_MEASUREMENT_TYPES.VOLUME
}

function getLegacyQuickDeclarationFlowType(measurementType) {
  if (measurementType === QUICK_DECLARATION_MEASUREMENT_TYPES.VOLUME_PRELEVE) {
    return POINT_FLOW_TYPES.PRELEVEMENT
  }

  if (measurementType === QUICK_DECLARATION_MEASUREMENT_TYPES.VOLUME_REJETE) {
    return POINT_FLOW_TYPES.REJET
  }

  return null
}

function assertLegacyQuickDeclarationFlowType(measurementType, exploitationsByPointId) {
  const legacyFlowType = getLegacyQuickDeclarationFlowType(measurementType)
  if (!legacyFlowType) {
    return
  }

  const conflictingPointIds = [...exploitationsByPointId.entries()]
    .filter(([, exploitation]) => {
      const pointFlowType = exploitation.pointPrelevement.flowType ?? POINT_FLOW_TYPES.PRELEVEMENT
      return pointFlowType !== legacyFlowType
    })
    .map(([pointId]) => pointId)

  if (conflictingPointIds.length > 0) {
    const error = createHttpError(
      409,
      'Le type historique demandé ne correspond pas au type d’un ou plusieurs points.'
    )
    error.data = {
      reason: 'POINT_FLOW_TYPE_MISMATCH',
      requestedFlowType: legacyFlowType,
      conflictingPointIds
    }
    throw error
  }
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

function getQuickDeclarationVolumeTotals(measurementType, value, flowType) {
  if (measurementType === QUICK_DECLARATION_MEASUREMENT_TYPES.INDEX) {
    return {
      totalWaterVolume: 0,
      totalWaterVolumeWithdrawn: 0,
      totalWaterVolumeDischarged: 0
    }
  }

  return {
    totalWaterVolume: value,
    totalWaterVolumeWithdrawn: flowType === POINT_FLOW_TYPES.PRELEVEMENT ? value : 0,
    totalWaterVolumeDischarged: flowType === POINT_FLOW_TYPES.REJET ? value : 0
  }
}

function sumQuickDeclarationVolumeTotals(measurementType, chunks) {
  const totals = {
    totalWaterVolume: 0,
    totalWaterVolumeWithdrawn: 0,
    totalWaterVolumeDischarged: 0
  }

  for (const chunk of chunks) {
    const chunkTotals = getQuickDeclarationVolumeTotals(
      measurementType,
      chunk.entry.value,
      chunk.flowType
    )

    totals.totalWaterVolume += chunkTotals.totalWaterVolume
    totals.totalWaterVolumeWithdrawn += chunkTotals.totalWaterVolumeWithdrawn
    totals.totalWaterVolumeDischarged += chunkTotals.totalWaterVolumeDischarged
  }

  return totals
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
    return computeInstantPeriodEnd(periodEndDate)
  }

  return addUtcDays(periodEndDate, 1)
}

function serializeQuickDeclarationConflict(conflict, point) {
  return {
    chunkValueId: conflict.chunkValueId,
    chunkId: conflict.chunkId,
    sourceId: conflict.sourceId,
    declarationId: conflict.declarationId ?? null,
    declarationCode: conflict.declarationCode ?? null,
    pointPrelevementId: conflict.pointPrelevementId,
    pointPrelevementName: getQuickDeclarationPointDisplayName(point),
    flowType: point?.flowType ?? POINT_FLOW_TYPES.PRELEVEMENT,
    metricTypeCode: conflict.metricTypeCode,
    frequency: conflict.frequency,
    periodStart: conflict.periodStart,
    periodEnd: conflict.periodEnd,
    value: decimalToNumber(conflict.value),
    unit: conflict.unit ?? 'm³'
  }
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

async function findAllowedDeclarationTypeForFileDeclaration({
  targetDeclarantUserId,
  code
}) {
  return findAllowedDeclarationTypeForDeclarant(
    targetDeclarantUserId,
    code
  )
}

export function canReadDeclarationWhere(userId, preleveurIds = []) {
  return {
    OR: [
      {declarantUserId: userId},
      {createdByDeclarantUserId: userId},
      ...(preleveurIds.length > 0 ? [{declarantUserId: {in: preleveurIds}}] : [])
    ]
  }
}

export async function getReadableDeclarantUserIdsForDeclarant(user) {
  const preleveurIds = user.declarant?.declarantRole === 'COLLECTEUR'
    ? await getPreleveurIdsForCollecteur(user.id)
    : []

  return [...new Set([user.id, ...preleveurIds].filter(Boolean))]
}

export function canReadTelemetrySourceWhere(declarantUserIds) {
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

function getComparableTimestamp(value) {
  if (!value) {
    return 0
  }

  const date = value instanceof Date ? value : new Date(value)
  const timestamp = date.getTime()
  return Number.isNaN(timestamp) ? 0 : timestamp
}

function getDateBounds(values) {
  const timestamps = values
    .map(value => getComparableTimestamp(value))
    .filter(timestamp => timestamp > 0)

  if (timestamps.length === 0) {
    return null
  }

  return {
    min: new Date(Math.min(...timestamps)),
    max: new Date(Math.max(...timestamps))
  }
}

function toReplacementDateKey(value) {
  const timestamp = getComparableTimestamp(value)
  return timestamp > 0 ? new Date(timestamp).toISOString() : String(value ?? '')
}

function getQuickDeclarationValueReplacementKey({
  pointPrelevementId,
  metricTypeCode,
  periodStart,
  periodEnd
}) {
  return [
    pointPrelevementId,
    metricTypeCode,
    toReplacementDateKey(periodStart),
    toReplacementDateKey(periodEnd)
  ].join('|')
}

function compareQuickDeclarationValuesDesc(a, b) {
  const createdAtDelta = getComparableTimestamp(b.createdAt) - getComparableTimestamp(a.createdAt)
  if (createdAtDelta !== 0) {
    return createdAtDelta
  }

  return String(b.id ?? '').localeCompare(String(a.id ?? ''))
}

function serializeQuickDeclarationReplacementValue(value) {
  if (!value) {
    return null
  }

  return {
    id: value.id,
    declarationId: value.declarationId ?? value.chunk?.source?.declarationId ?? null,
    declarationCode: value.declarationCode ?? value.chunk?.source?.declaration?.code ?? null,
    periodStart: value.periodStart,
    periodEnd: value.periodEnd,
    value: decimalToNumber(value.value),
    unit: value.unit ?? 'm³',
    createdAt: value.createdAt
  }
}

function getPointDisplayName(point) {
  return point?.name || point?.sourceId || 'Point de prélèvement'
}

function getQuickDeclarationPointDisplayName(point) {
  return point?.usageName?.trim() || getPointDisplayName(point)
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
          pointPrelevementId: true,
          flowType: true,
          pointPrelevement: {
            select: {flowType: true}
          }
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
          pointPrelevementId: true,
          flowType: true,
          pointPrelevement: {
            select: {flowType: true}
          }
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
    const flowType = resolveValueFlowType(
      value.chunk?.flowType ?? value.chunk?.pointPrelevement?.flowType,
      value.metricTypeCode
    )
    const volumeKind = flowType === POINT_FLOW_TYPES.REJET
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
        v."createdAt",
        c."pointPrelevementId",
        c."sourceId",
        s."declarationId",
        ROW_NUMBER() OVER (
          PARTITION BY c."pointPrelevementId"
          ORDER BY v."periodEnd" DESC, v."createdAt" DESC, v.id DESC
        ) AS "pointRowNumber",
        ROW_NUMBER() OVER (
          PARTITION BY c."pointPrelevementId", v."metricTypeCode", v."periodStart", v."periodEnd"
          ORDER BY v."createdAt" DESC, v.id DESC
        ) AS "replacementRowNumber",
        FIRST_VALUE(v.id) OVER replacement_window AS "effectiveValueId",
        FIRST_VALUE(v.value) OVER replacement_window AS "effectiveValue",
        FIRST_VALUE(v.unit) OVER replacement_window AS "effectiveUnit",
        FIRST_VALUE(v."createdAt") OVER replacement_window AS "effectiveCreatedAt",
        FIRST_VALUE(s."declarationId") OVER replacement_window AS "effectiveDeclarationId",
        FIRST_VALUE(d.code) OVER replacement_window AS "effectiveDeclarationCode"
      FROM "ChunkValue" v
      JOIN "Chunk" c ON c.id = v."chunkId"
      JOIN "Source" s ON s.id = c."sourceId"
      JOIN "Declaration" d ON d.id = s."declarationId"
      WHERE v."valueKind" = 'DECLARED'
        AND v."metricTypeCode" IN (${Prisma.join(INDEX_METRIC_TYPE_CODES)})
        AND c."pointPrelevementId" IN (${Prisma.join(pointIdFilters)})
        AND s.status = 'COMPLETED'
        AND d."declarantUserId" = ${declarantUserId}::uuid
      WINDOW replacement_window AS (
        PARTITION BY c."pointPrelevementId", v."metricTypeCode", v."periodStart", v."periodEnd"
        ORDER BY v."createdAt" DESC, v.id DESC
        ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
      )
    )
    SELECT
      id,
      "metricTypeCode",
      "periodStart",
      "periodEnd",
      value,
      unit,
      "createdAt",
      "pointPrelevementId",
      "sourceId",
      "declarationId",
      "replacementRowNumber",
      "effectiveValueId",
      "effectiveValue",
      "effectiveUnit",
      "effectiveCreatedAt",
      "effectiveDeclarationId",
      "effectiveDeclarationCode"
    FROM ranked_index_values
    WHERE "pointRowNumber" <= ${safeLimit}
    ORDER BY "pointPrelevementId", "periodEnd" DESC, "createdAt" DESC, id DESC
  `

  const byPointId = new Map()

  for (const value of values) {
    const {pointPrelevementId} = value

    if (!pointPrelevementId) {
      continue
    }

    const pointValues = byPointId.get(pointPrelevementId) ?? []
    const isOverwritten = Number(value.replacementRowNumber) > 1
    pointValues.push({
      id: value.id,
      metricTypeCode: value.metricTypeCode,
      periodStart: value.periodStart,
      periodEnd: value.periodEnd,
      value: decimalToNumber(value.value),
      unit: value.unit ?? 'm³',
      createdAt: value.createdAt,
      sourceId: value.sourceId,
      declarationId: value.declarationId,
      valueStatus: isOverwritten ? 'OVERWRITTEN' : 'ACTIVE',
      isOverwritten,
      overwrittenBy: isOverwritten
        ? serializeQuickDeclarationReplacementValue({
          id: value.effectiveValueId,
          declarationId: value.effectiveDeclarationId,
          declarationCode: value.effectiveDeclarationCode,
          periodStart: value.periodStart,
          periodEnd: value.periodEnd,
          value: value.effectiveValue,
          unit: value.effectiveUnit,
          createdAt: value.effectiveCreatedAt
        })
        : null
    })
    byPointId.set(pointPrelevementId, pointValues)
  }

  return byPointId
}

function collectQuickDeclarationDeclaredValues(chunks) {
  const values = []

  for (const chunk of chunks ?? []) {
    for (const value of chunk.chunkValues ?? []) {
      if (
        value.valueKind !== 'DECLARED'
        || !chunk.pointPrelevementId
        || !value.metricTypeCode
        || !value.periodStart
        || !value.periodEnd
      ) {
        continue
      }

      values.push({
        ...value,
        pointPrelevementId: chunk.pointPrelevementId
      })
    }
  }

  return values
}

async function getQuickDeclarationValueReplacementStatuses({declarantUserId, chunks}) {
  const declaredValues = collectQuickDeclarationDeclaredValues(chunks)

  if (declaredValues.length === 0) {
    return new Map()
  }

  const pointPrelevementIds = [...new Set(declaredValues.map(value => value.pointPrelevementId))]
  const metricTypeCodes = [...new Set(declaredValues.map(value => value.metricTypeCode))]
  const periodStartBounds = getDateBounds(declaredValues.map(value => value.periodStart))
  const periodEndBounds = getDateBounds(declaredValues.map(value => value.periodEnd))
  const expectedKeys = new Set(declaredValues.map(getQuickDeclarationValueReplacementKey))

  if (!periodStartBounds || !periodEndBounds) {
    return new Map()
  }

  const rows = await prisma.chunkValue.findMany({
    where: {
      valueKind: 'DECLARED',
      metricTypeCode: {in: metricTypeCodes},
      periodStart: {gte: periodStartBounds.min, lte: periodStartBounds.max},
      periodEnd: {gte: periodEndBounds.min, lte: periodEndBounds.max},
      chunk: {
        pointPrelevementId: {in: pointPrelevementIds},
        source: {
          status: 'COMPLETED',
          declaration: {
            declarantUserId,
            type: QUICK_DECLARATION_TYPE_CODE
          }
        }
      }
    },
    select: {
      id: true,
      metricTypeCode: true,
      periodStart: true,
      periodEnd: true,
      value: true,
      unit: true,
      createdAt: true,
      chunk: {
        select: {
          pointPrelevementId: true,
          source: {
            select: {
              declarationId: true,
              declaration: {
                select: {
                  code: true
                }
              }
            }
          }
        }
      }
    }
  })

  const rowsByKey = new Map()

  for (const row of rows) {
    const key = getQuickDeclarationValueReplacementKey({
      pointPrelevementId: row.chunk?.pointPrelevementId,
      metricTypeCode: row.metricTypeCode,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd
    })

    if (!expectedKeys.has(key)) {
      continue
    }

    const keyRows = rowsByKey.get(key) ?? []
    keyRows.push(row)
    rowsByKey.set(key, keyRows)
  }

  const statuses = new Map()

  for (const value of declaredValues) {
    const keyRows = rowsByKey.get(getQuickDeclarationValueReplacementKey(value)) ?? []
    const [latestValue] = [...keyRows].sort(compareQuickDeclarationValuesDesc)
    const isOverwritten = Boolean(latestValue && latestValue.id !== value.id)

    statuses.set(value.id, {
      valueStatus: isOverwritten ? 'OVERWRITTEN' : 'ACTIVE',
      isOverwritten,
      overwrittenBy: isOverwritten ? serializeQuickDeclarationReplacementValue(latestValue) : null
    })
  }

  return statuses
}

async function getQuickDeclarationReplacementAuditValuesByChunk(chunks) {
  const chunkIds = [...new Set((chunks ?? []).map(chunk => chunk.id).filter(Boolean))]

  if (chunkIds.length === 0) {
    return new Map()
  }

  const existingValueIds = new Set(
    (chunks ?? [])
      .flatMap(chunk => chunk.chunkValues ?? [])
      .map(value => value.id)
      .filter(Boolean)
  )
  const audits = await prisma.chunkValueReplacement.findMany({
    where: {
      replacedChunkId: {
        in: chunkIds
      }
    },
    orderBy: {
      createdAt: 'asc'
    }
  })

  if (audits.length === 0) {
    return new Map()
  }

  const replacementValueIds = [
    ...new Set(audits.map(audit => audit.replacementChunkValueId).filter(Boolean))
  ]
  const replacementValues = replacementValueIds.length === 0
    ? []
    : await prisma.chunkValue.findMany({
      where: {
        id: {
          in: replacementValueIds
        }
      },
      select: {
        id: true,
        periodStart: true,
        periodEnd: true,
        value: true,
        unit: true,
        createdAt: true,
        chunk: {
          select: {
            source: {
              select: {
                declarationId: true,
                declaration: {
                  select: {
                    code: true
                  }
                }
              }
            }
          }
        }
      }
    })
  const replacementValuesById = new Map(replacementValues.map(value => [value.id, value]))
  const auditValuesByChunkId = new Map()

  for (const audit of audits) {
    if (existingValueIds.has(audit.replacedChunkValueId)) {
      continue
    }

    const chunkAuditValues = auditValuesByChunkId.get(audit.replacedChunkId) ?? []
    chunkAuditValues.push({
      id: audit.replacedChunkValueId,
      metricTypeCode: audit.metricTypeCode,
      unit: audit.unit ?? 'm³',
      frequency: audit.frequency,
      periodStart: audit.periodStart,
      periodEnd: audit.periodEnd,
      valueKind: audit.valueKind,
      value: audit.value,
      createdAt: audit.createdAt,
      valueStatus: 'OVERWRITTEN',
      isOverwritten: true,
      overwrittenBy: serializeQuickDeclarationReplacementValue(
        replacementValuesById.get(audit.replacementChunkValueId)
      )
    })
    auditValuesByChunkId.set(audit.replacedChunkId, chunkAuditValues)
  }

  return auditValuesByChunkId
}

function decorateQuickDeclarationChunksWithValueReplacementStatuses(declaration, replacementStatusesByValueId) {
  if (declaration.source?.metadata?.manualQuickDeclaration !== true) {
    return declaration
  }

  return {
    ...declaration,
    source: {
      ...declaration.source,
      chunks: declaration.source.chunks.map(chunk => ({
        ...chunk,
        chunkValues: (chunk.chunkValues ?? []).map(value => {
          const replacementStatus = replacementStatusesByValueId.get(value.id)
          return replacementStatus ? {...value, ...replacementStatus} : value
        })
      }))
    }
  }
}

function decorateQuickDeclarationChunksWithReplacementAuditValues(declaration, auditValuesByChunkId) {
  if (declaration.source?.metadata?.manualQuickDeclaration !== true || auditValuesByChunkId.size === 0) {
    return declaration
  }

  return {
    ...declaration,
    source: {
      ...declaration.source,
      chunks: declaration.source.chunks.map(chunk => {
        const auditValues = auditValuesByChunkId.get(chunk.id) ?? []

        if (auditValues.length === 0) {
          return chunk
        }

        return {
          ...chunk,
          chunkValues: [
            ...(chunk.chunkValues ?? []),
            ...auditValues
          ]
        }
      })
    }
  }
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
    usageName: point?.usageName ?? null,
    flowType: point?.flowType ?? POINT_FLOW_TYPES.PRELEVEMENT,
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

export function serializeQuickDeclarationPoint({
  coordsById,
  exploitation,
  lastKnownUsagesByPointId,
  lastReadingsByPointId,
  lastVolumePeriodsByPointId
}) {
  const point = exploitation.pointPrelevement
  const pointId = point?.id
  const serializedUsageFields = serializeExploitationUsageFields(exploitation)

  return {
    ...serializeQuickDeclarationPointIdentity(point),
    exploitationId: exploitation.id,
    coordinates: coordsById.get(pointId) ?? null,
    usage: serializedUsageFields.usage,
    secondaryUsages: serializedUsageFields.secondaryUsages,
    lastKnownUsage: lastKnownUsagesByPointId.get(pointId) ?? null,
    lastVolumePeriods: lastVolumePeriodsByPointId.get(pointId) ?? null,
    lastReading: serializeQuickDeclarationLastReading(lastReadingsByPointId.get(pointId))
  }
}

async function getQuickDeclarationPoints(declarantUserId) {
  const exploitations = await prisma.declarantPointPrelevement.findMany({
    where: {
      declarantUserId,
      ...exploitationAtDateWhere(),
      pointPrelevement: {
        deletedAt: null
      }
    },
    include: {
      pointPrelevement: true,
      usage: true,
      secondaryUsageLinks: {
        include: {usage: true},
        orderBy: {usageId: 'asc'}
      }
    },
    orderBy: [
      {createdAt: 'asc'}
    ]
  })

  const pointIds = exploitations
    .map(exploitation => exploitation.pointPrelevementId)
    .filter(Boolean)

  const [coordsById, lastReadingsByPointId, lastKnownUsagesByPointId, lastVolumePeriodsByPointId] = await Promise.all([
    getCoordsByPointIds(pointIds),
    getLastIndexReadingsByPoint({declarantUserId, pointPrelevementIds: pointIds}),
    getLastKnownUsagesByPoint({declarantUserId, pointPrelevementIds: pointIds}),
    getLastVolumePeriodsByPoint({declarantUserId, pointPrelevementIds: pointIds})
  ])

  return exploitations
    .map(exploitation => serializeQuickDeclarationPoint({
      coordsById,
      exploitation,
      lastKnownUsagesByPointId,
      lastReadingsByPointId,
      lastVolumePeriodsByPointId
    }))
    .sort((a, b) => getQuickDeclarationPointDisplayName(a).localeCompare(
      getQuickDeclarationPointDisplayName(b),
      'fr',
      {sensitivity: 'base'}
    ))
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

function ensureUniquePointUsageNames(pointUsageNames) {
  const seen = new Set()

  for (const item of pointUsageNames) {
    if (seen.has(item.pointPrelevementId)) {
      throw createHttpError(400, `Le nom d’usage du point ${item.pointPrelevementId} est présent plusieurs fois.`)
    }

    seen.add(item.pointPrelevementId)
  }
}

async function getLinkedExploitationsByPointId({declarantUserId, pointPrelevementIds}) {
  const exploitations = await prisma.declarantPointPrelevement.findMany({
    where: {
      declarantUserId,
      pointPrelevementId: {in: pointPrelevementIds},
      ...exploitationAtDateWhere(),
      pointPrelevement: {
        deletedAt: null
      }
    },
    include: {
      pointPrelevement: true,
      usage: true
    }
  })

  return indexUniqueExploitationsByPoint(exploitations, {declarantUserId})
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

  return findUniqueExploitationForPeriod({
    client: prisma,
    pointPrelevementId,
    start: chunkStart,
    end: chunkEnd,
    where: {
      ...accessWhere,
      pointPrelevement: {deletedAt: null}
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

async function refreshSourceVolumeMetadata(sourceId) {
  await refreshVolumeMetadataForSourceIds([sourceId])

  return prisma.source.findUnique({
    where: {id: sourceId},
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

export async function getAllowedTypesMetaForDeclarant(actorDeclarantUserId, {
  includePreleveurs = true,
  findDeclarantProfile = getDeclarantProfile,
  findDeclarationTargets = getCollecteurDeclarationTargets,
  listAllowedTypes = listAllowedDeclarationTypesForDeclarants
} = {}) {
  const actorProfile = await findDeclarantProfile(actorDeclarantUserId)
  const actorRole = actorProfile?.declarantRole ?? null
  const actorQuickDeclarationEnabled = actorProfile?.quickDeclarationEnabled !== false

  if (actorRole === 'COLLECTEUR') {
    const preleveurs = await findDeclarationTargets(actorDeclarantUserId)
    const declarantUserIds = [
      actorDeclarantUserId,
      ...(includePreleveurs ? preleveurs.map(preleveur => preleveur.id) : [])
    ]
    const allowedTypesByDeclarantId = await listAllowedTypes(declarantUserIds)
    const collecteurAllowedDeclarationTypes = allowedTypesByDeclarantId.get(actorDeclarantUserId) ?? []
    const preleveursWithAllowedTypes = includePreleveurs
      ? preleveurs.map(preleveur => {
        const allowedDeclarationTypes = allowedTypesByDeclarantId.get(preleveur.id) ?? []
        const quickDeclarationEnabled = preleveur.declarant?.quickDeclarationEnabled !== false

        return {
          id: preleveur.id,
          userId: preleveur.id,
          firstName: preleveur.firstName,
          lastName: preleveur.lastName,
          email: preleveur.email,
          loginEmail: preleveur.loginEmail ?? preleveur.email,
          contactEmails: preleveur.contactEmails ?? [],
          declarant: preleveur.declarant,
          quickDeclarationEnabled,
          canCreateQuickDeclaration: actorQuickDeclarationEnabled && quickDeclarationEnabled,
          allowedDeclarationTypes
        }
      })
      : []

    const canCreateDeclaration = collecteurAllowedDeclarationTypes.length > 0
    const canCreateQuickDeclaration = actorQuickDeclarationEnabled
      && preleveurs.some(preleveur => preleveur.declarant?.quickDeclarationEnabled !== false)

    return {
      data: collecteurAllowedDeclarationTypes,
      meta: {
        declarantRole: actorRole,
        quickDeclarationEnabled: actorQuickDeclarationEnabled,
        canCreateDeclaration,
        canCreateQuickDeclaration,
        allowedDeclarationTypes: collecteurAllowedDeclarationTypes,
        preleveurs: preleveursWithAllowedTypes
      }
    }
  }

  const allowedTypesByDeclarantId = await listAllowedTypes([actorDeclarantUserId])
  const allowedDeclarationTypes = allowedTypesByDeclarantId.get(actorDeclarantUserId) ?? []

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

export function shouldIncludeAllowedTypePreleveurs(value) {
  const candidate = Array.isArray(value) ? value[0] : value
  return candidate !== false && String(candidate ?? '').trim().toLowerCase() !== 'false'
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

    const uploadedKeys = []
    let filesPersisted = false

    try {
      const createdFiles = []

      for (const [i, file] of files.entries()) {
        const filename = safeFilename(file.originalname)
        const type = fileTypes[i]

        const objectKey = `declarations/${declaration.id}/${uuid()}-${filename}`

        // eslint-disable-next-line no-await-in-loop
        await storage.uploadObject(objectKey, file.buffer, {
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

      filesPersisted = true
      await markDeclarationProcessingUploaded({
        declarationId: declaration.id,
        createdByUserId: req.user.id,
        metadata: {
          fileCount: createdFiles.length,
          declarationType: type
        }
      })

      const filesWithUrls = await Promise.all(
        createdFiles.map(async f => ({
          ...f,
          url: await storage.getPresignedUrl(f.storageKey)
        }))
      )

      const orchestration = await requestDeclarationProcessing({
        declarationId: declaration.id,
        createdByUserId: req.user.id,
        metadata: {
          fileCount: createdFiles.length,
          declarationType: type
        }
      })
      const declarationForResponse = await prisma.declaration.findUnique({
        where: {id: declaration.id}
      })

      await updateLastDeclarationAt(declarantUserId)
      if (createdByDeclarantUserId !== declarantUserId) {
        await updateLastDeclarationAt(createdByDeclarantUserId)
      }

      return res.status(201).json({
        success: true,
        data: {
          ...(declarationForResponse ?? declaration),
          declarationType: allowedDeclarationType,
          files: filesWithUrls,
          orchestration
        }
      })
    } catch (error_) {
      if (!filesPersisted) {
        try {
          await prisma.declaration.delete({where: {id: declaration.id}})
        } catch {}

        try {
          await Promise.all(uploadedKeys.map(async k => storage.deleteObject(k, true)))
        } catch {}
      }

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

export async function previewQuickDeclarationConflictsHandler(req, res, next) {
  try {
    const {error, value} = createQuickDeclarationSchema.validate(req.body, {abortEarly: false})
    if (error) {
      throw createHttpError(400, error.message)
    }

    const createdByDeclarantUserId = req.user.id
    const declarantUserId = getTargetDeclarantUserId(value, createdByDeclarantUserId)
    const requestedMeasurementType = value.measurementType ?? QUICK_DECLARATION_MEASUREMENT_TYPES.INDEX
    const measurementType = normalizeQuickDeclarationMeasurementType(requestedMeasurementType)
    const isIndexMeasurement = measurementType === QUICK_DECLARATION_MEASUREMENT_TYPES.INDEX

    if (isIndexMeasurement) {
      return res.json({
        success: true,
        data: {
          hasConflicts: false,
          conflicts: []
        }
      })
    }

    const metricTypeCode = getQuickDeclarationMetricTypeCode(measurementType)
    const periodStartDate = parseQuickDeclarationDate(value.periodStartDate, 'La date de début')
    const periodEndDate = parseQuickDeclarationDate(value.periodEndDate, 'La date de fin')
    if (periodEndDate < periodStartDate) {
      throw createHttpError(400, 'La date de fin doit être postérieure ou égale à la date de début.')
    }

    const valuePeriodEnd = getQuickDeclarationValuePeriodEnd(isIndexMeasurement, periodEndDate)
    const entries = value.entries.map(entry => ({
      pointPrelevementId: entry.pointPrelevementId,
      value: Number(entry.value ?? entry.index)
    }))

    ensureUniquePointEntries(entries)

    await assertCanDeclareFor({actorDeclarantUserId: createdByDeclarantUserId, targetDeclarantUserId: declarantUserId})
    await assertQuickDeclarationEnabled({actorDeclarantUserId: createdByDeclarantUserId, targetDeclarantUserId: declarantUserId})

    const pointPrelevementIds = entries.map(entry => entry.pointPrelevementId)
    const exploitationsByPointId = await getLinkedExploitationsByPointId({
      declarantUserId,
      pointPrelevementIds
    })

    const missingPointIds = pointPrelevementIds.filter(pointId => !exploitationsByPointId.has(pointId))
    if (missingPointIds.length > 0) {
      throw createHttpError(400, 'Un ou plusieurs points ne sont pas rattachés au préleveur concerné.')
    }

    assertLegacyQuickDeclarationFlowType(requestedMeasurementType, exploitationsByPointId)

    const conflicts = []

    for (const entry of entries) {
      const exploitation = exploitationsByPointId.get(entry.pointPrelevementId)
      const valueRows = [{
        metricTypeCode,
        periodStart: periodStartDate,
        periodEnd: valuePeriodEnd
      }]

      // eslint-disable-next-line no-await-in-loop
      const pointConflicts = await findConflictingChunkValuesForIncomingChunkValues({
        pointPrelevementId: entry.pointPrelevementId,
        preleveurUserId: declarantUserId,
        valueRows
      })

      conflicts.push(
        ...pointConflicts.map(conflict =>
          serializeQuickDeclarationConflict(conflict, exploitation.pointPrelevement))
      )
    }

    return res.json({
      success: true,
      data: {
        hasConflicts: conflicts.length > 0,
        conflicts
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
    const requestedMeasurementType = value.measurementType ?? QUICK_DECLARATION_MEASUREMENT_TYPES.INDEX
    const measurementType = normalizeQuickDeclarationMeasurementType(requestedMeasurementType)
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
    const pointUsageNames = value.pointUsageNames.map(item => ({
      pointPrelevementId: item.pointPrelevementId,
      usageName: item.usageName?.trim() || null
    }))

    ensureUniquePointEntries(entries)
    ensureUniquePointUsageNames(pointUsageNames)

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
    const pointUsageNameIds = pointUsageNames.map(item => item.pointPrelevementId)
    const requestedPointPrelevementIds = [...new Set([
      ...pointPrelevementIds,
      ...pointUsageNameIds
    ])]
    const exploitationsByPointId = await getLinkedExploitationsByPointId({
      declarantUserId,
      pointPrelevementIds: requestedPointPrelevementIds
    })

    const missingPointIds = pointPrelevementIds.filter(pointId => !exploitationsByPointId.has(pointId))
    if (missingPointIds.length > 0) {
      throw createHttpError(400, 'Un ou plusieurs points ne sont pas rattachés au préleveur concerné.')
    }

    const missingPointUsageNameIds = pointUsageNameIds.filter(pointId => !exploitationsByPointId.has(pointId))
    if (missingPointUsageNameIds.length > 0) {
      throw createHttpError(400, 'Un ou plusieurs noms d’usage concernent un point qui n’est pas rattaché au préleveur concerné.')
    }

    assertLegacyQuickDeclarationFlowType(requestedMeasurementType, exploitationsByPointId)

    const quickDeclarationChunks = entries.map(entry => {
      const exploitation = exploitationsByPointId.get(entry.pointPrelevementId)
      const point = exploitation.pointPrelevement
      const flowType = point.flowType ?? POINT_FLOW_TYPES.PRELEVEMENT
      const chunkId = randomUUID()

      return {
        entry,
        exploitation,
        point,
        flowType,
        chunkId,
        valueRow: {
          id: randomUUID(),
          chunkId,
          metricTypeCode,
          unit: 'm³',
          frequency: isIndexMeasurement ? 'instant' : '1 day',
          periodStart: periodStartDate,
          periodEnd: valuePeriodEnd,
          valueKind: 'DECLARED',
          value: entry.value
        }
      }
    })
    const quickDeclarationTotals = sumQuickDeclarationVolumeTotals(measurementType, quickDeclarationChunks)

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
          waterWithdrawalType: 'unknown',
          processingStatus: 'COMPLETED',
          processingCompletedAt: new Date()
        }
      })

      await Promise.all(pointUsageNames.map(({pointPrelevementId, usageName}) =>
        tx.pointPrelevement.update({
          where: {id: pointPrelevementId},
          data: {usageName},
          select: {id: true}
        })
      ))

      const actorData = await buildChunkActorData({
        preleveurUserId: declarantUserId,
        submittedByDeclarantUserId: createdByDeclarantUserId,
        client: tx
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
            create: quickDeclarationChunks.map(({chunkId, entry, point, flowType}) => ({
              id: chunkId,
              pointPrelevementId: entry.pointPrelevementId,
              pointPrelevementName: getPointDisplayName(point),
              flowType,
              ...actorData,
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
                flowType,
                declaredValue: entry.value,
                unit: 'm³',
                ...periodMetadata,
                ...getQuickDeclarationIndexMetadata(isIndexMeasurement, entry.value),
                ...getQuickDeclarationVolumeTotals(measurementType, entry.value, flowType)
              }
            }))
          }
        },
        include: {
          chunks: true
        }
      })

      if (!isIndexMeasurement) {
        for (const {chunkId, entry, valueRow} of quickDeclarationChunks) {
          // eslint-disable-next-line no-await-in-loop
          await applyConflictPolicyForIncomingChunkValues({
            pointPrelevementId: entry.pointPrelevementId,
            preleveurUserId: actorData.preleveurUserId,
            valueRows: [valueRow],
            requestedPolicy: 'REPLACE_EXISTING',
            replaceComment: 'AUTO_REPLACED_BY_QUICK_DECLARATION',
            replacementSourceId: source.id,
            replacementMetadata: {
              manualQuickDeclaration: true,
              measurementType,
              declarationId: createdDeclaration.id,
              declarationCode: createdDeclaration.code,
              incomingChunkId: chunkId
            },
            client: tx
          })
        }
      }

      await tx.chunkValue.createMany({
        data: quickDeclarationChunks.map(({valueRow}) => valueRow)
      })

      for (const pointPrelevementId of new Set(pointPrelevementIds)) {
        // eslint-disable-next-line no-await-in-loop
        await syncDeclarantZonesFromPoint({
          declarantUserIds: [
            declarantUserId,
            createdByDeclarantUserId,
            actorData.preleveurUserId,
            actorData.submittedByDeclarantUserId,
            actorData.collecteurUserId
          ],
          pointPrelevementId,
          source: 'DECLARATION',
          createdByUserId: req.user.id,
          client: tx
        })
      }

      const quickDeclarationUsagesByExploitationId = new Map()

      for (const {entry, exploitation} of quickDeclarationChunks) {
        const rootUsageId = getWaterUseRootId(entry.usage)
        const usageIds = quickDeclarationUsagesByExploitationId.get(exploitation.id) ?? new Set()

        if (rootUsageId) {
          usageIds.add(rootUsageId)
        }

        quickDeclarationUsagesByExploitationId.set(exploitation.id, usageIds)
      }

      for (const [exploitationId, usageIds] of [...quickDeclarationUsagesByExploitationId.entries()]
        .sort(([leftId], [rightId]) => leftId.localeCompare(rightId))) {
        for (const usageId of usageIds) {
          // eslint-disable-next-line no-await-in-loop
          await addExploitationSecondaryUsage(exploitationId, usageId, {client: tx})
        }

        // eslint-disable-next-line no-await-in-loop
        await tx.declarantPointPrelevement.updateMany({
          where: {
            id: exploitationId,
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

      await refreshSourceDeclarantsLastDeclarationAt(source.id, {client: tx})

      return {
        ...createdDeclaration,
        source
      }
    }, {isolationLevel: Prisma.TransactionIsolationLevel.Serializable})

    await markDeclarationProcessingCompleted({
      declarationId: declaration.id,
      createdByUserId: req.user.id,
      metadata: {
        manualQuickDeclaration: true,
        measurementType,
        entriesCount: entries.length
      }
    })

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

    await refreshMostRecentAvailableDateForDeclarantPoints({
      declarantUserId,
      pointPrelevementIds
    })

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
                pointPrelevement: true,
                usage: true,
                _count: {
                  select: {
                    chunkValues: true
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
        },
        processingEvents: {
          orderBy: {
            createdAt: 'desc'
          },
          take: 20
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

export async function listReplayableDeclarationsHandler(req, res, next) {
  try {
    const declarations = await prisma.declaration.findMany({
      where: getReplayableDeclarationsWhere(),
      orderBy: {
        createdAt: 'desc'
      },
      take: 100,
      include: {
        files: {
          select: {
            id: true,
            filename: true,
            type: true,
            storageKey: true
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
        },
        processingEvents: {
          orderBy: {
            createdAt: 'desc'
          },
          take: 5
        }
      }
    })

    const storage = createStorageClient(DECLARATIONS_BUCKET)
    const decorated = await decorateDeclarationsWithDeclarationTypes(
      await decorateDeclarationActors(declarations)
    )
    const decoratedWithDownloadUrls = await Promise.all(
      decorated.map(async declaration => ({
        ...declaration,
        files: await Promise.all((declaration.files ?? []).map(async file => {
          const {storageKey, ...fileWithoutStorageKey} = file

          return {
            ...fileWithoutStorageKey,
            url: await storage.getPresignedUrl(storageKey)
          }
        }))
      }))
    )

    return res.json({
      success: true,
      data: decoratedWithDownloadUrls
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
            _count: {
              select: {
                chunkValues: true
              }
            },
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
    const payload = await getAllowedTypesMetaForDeclarant(req.user.id, {
      includePreleveurs: shouldIncludeAllowedTypePreleveurs(req.query?.includePreleveurs)
    })

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
                preleveur: {
                  include: {
                    user: true
                  }
                },
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
        },
        processingEvents: {
          orderBy: {
            createdAt: 'desc'
          },
          take: 50
        }
      }
    })

    if (!declaration) {
      throw createHttpError(404, 'Déclaration introuvable')
    }

    const isManualQuickDeclaration = declaration.source?.metadata?.manualQuickDeclaration === true
    const pointPrelevementIds = isManualQuickDeclaration
      ? [...new Set(declaration.source.chunks.map(chunk => chunk.pointPrelevementId).filter(Boolean))]
      : []
    const latestIndexReadingsByPoint = await getLatestIndexReadingsByPoint({
      declarantUserId: declaration.declarantUserId,
      pointPrelevementIds
    })
    const replacementStatusesByValueId = isManualQuickDeclaration
      ? await getQuickDeclarationValueReplacementStatuses({
        declarantUserId: declaration.declarantUserId,
        chunks: declaration.source?.chunks ?? []
      })
      : new Map()
    const replacementAuditValuesByChunkId = isManualQuickDeclaration
      ? await getQuickDeclarationReplacementAuditValuesByChunk(declaration.source?.chunks ?? [])
      : new Map()
    const declarationWithReplacementStatuses = decorateQuickDeclarationChunksWithValueReplacementStatuses(
      declaration,
      replacementStatusesByValueId
    )
    const declarationWithReplacementAuditValues = decorateQuickDeclarationChunksWithReplacementAuditValues(
      declarationWithReplacementStatuses,
      replacementAuditValuesByChunkId
    )
    const declarationWithLatestIndexReadings = decorateQuickDeclarationChunksWithLatestIndexReadings(
      declarationWithReplacementAuditValues,
      latestIndexReadingsByPoint
    )
    const declarationWithPointAssociationOrigins = {
      ...declarationWithLatestIndexReadings,
      source: decorateSourcePointAssociations(declarationWithLatestIndexReadings.source)
    }
    const [declarationWithActors] = await decorateDeclarationActors([declarationWithPointAssociationOrigins])
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
    const html = await renderDeclarationPointsChangeRequestEmail({
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
                preleveurUserId: true,
                submittedByDeclarantUserId: true,
                collecteurUserId: true,
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

    const declarantUserIds = getSourceActivityDeclarantUserIds({
      declaration,
      chunks: declaration.source?.chunks
    })

    await prisma.$transaction(async tx => {
      await tx.declaration.delete({
        where: {id: declaration.id}
      })

      await refreshDeclarantsLastDeclarationAt(declarantUserIds, {client: tx})
    })

    const impactedIndexPointPrelevementIds = [
      ...new Set(
        (declaration.source?.chunks ?? [])
          .filter(chunk => chunk.pointPrelevementId && chunk.chunkValues.length > 0)
          .map(chunk => chunk.pointPrelevementId)
      )
    ]

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
      await prisma.$transaction(async tx => {
        const previousDeclarantUserIds = await getDeclarantUserIdsForSourceActivity(
          previousSource.id,
          {client: tx}
        )

        await tx.source.update({
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

        await refreshDeclarantsLastDeclarationAt(previousDeclarantUserIds, {client: tx})
      })
    }

    let orchestration
    try {
      orchestration = await requestDeclarationProcessing({
        declarationId: declaration.id,
        createdByUserId: req.user.id,
        replay: true,
        required: true,
        metadata: {
          previousSourceId: previousSource?.id ?? null
        }
      })
    } catch (error_) {
      if (previousSource?.id) {
        await prisma.$transaction(async tx => {
          await tx.source.update({
            where: {id: previousSource.id},
            data: {
              status: previousSource.status,
              globalInstructionStatus: previousSource.globalInstructionStatus,
              metadata: getObjectMetadata(previousSource.metadata)
            }
          })

          await refreshSourceDeclarantsLastDeclarationAt(previousSource.id, {client: tx})
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
          createdByDeclarantUserId: true,
          declarant: {
            select: {
              declarantRole: true
            }
          },
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
          createdByDeclarantUserId: true,
          declarant: {
            select: {
              declarantRole: true
            }
          },
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
        flowType: true,
        metadata: true,
        usageId: true,
        usage: true,
        minDate: true,
        maxDate: true,
        parsingInfo: true,
        preleveurUserId: true,
        submittedByDeclarantUserId: true,
        collecteurUserId: true
      }
    })

    if (!chunk) {
      throw createHttpError(404, 'Point du fichier introuvable dans cette déclaration.')
    }

    const targetPointPrelevementId = value.pointPrelevementId
    const previousPointPrelevementId = chunk.pointPrelevementId
    const pointAssociationChanged = previousPointPrelevementId !== targetPointPrelevementId

    if (!isChunkPointAssociationChangeAllowed(chunk, targetPointPrelevementId)) {
      const lockedAssociationError = createHttpError(
        409,
        'Une association automatique ne peut être ni modifiée ni détachée.'
      )
      lockedAssociationError.data = {
        reason: AUTOMATIC_POINT_ASSOCIATION_LOCK_REASON,
        chunkId: chunk.id,
        pointPrelevementId: previousPointPrelevementId
      }
      throw lockedAssociationError
    }

    if (isInstructor && targetPointPrelevementId) {
      const permittedZoneIds = await getPermissionZoneIdsForUser(
        req.user,
        'declaration.reconcile'
      )
      const targetPoint = await prisma.pointPrelevement.findFirst({
        where: {
          id: targetPointPrelevementId,
          zones: {some: {zoneId: {in: permittedZoneIds}}}
        },
        select: {id: true}
      })

      if (!targetPoint) {
        throw createHttpError(403, 'Ce point de prélèvement n’est pas dans votre périmètre.')
      }
    }

    const isDetaching = targetPointPrelevementId === null
    const alias = chunk.pointPrelevementName
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

      const pointFlowType = exploitation.pointPrelevement.flowType
      const sourceFlowType = getSourceFlowTypeFromMetadata(chunk.metadata)
      if (sourceFlowType && sourceFlowType !== pointFlowType) {
        return res.status(409).json({
          success: false,
          message: 'Le type de point indiqué par le fichier ne correspond pas à celui du point sélectionné.',
          data: {
            reason: 'POINT_FLOW_TYPE_MISMATCH',
            sourceFlowType,
            pointFlowType,
            pointPrelevementId: targetPointPrelevementId
          }
        })
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
    const rootUsageId = !isDetaching && chunk.usage
      ? getWaterUseRootId(chunk.usage)
      : null
    const actorData = await buildChunkActorData({
      preleveurUserId: declaration.declarant?.declarantRole === 'COLLECTEUR' ? null : declaration.declarantUserId,
      matchedPreleveurUserId: exploitation?.declarantUserId ?? null,
      submittedByDeclarantUserId: declaration.createdByDeclarantUserId || declaration.declarantUserId,
      client: prisma
    })
    const activityDeclarantUserIds = getSourceActivityDeclarantUserIds({
      declaration,
      chunks: [chunk, actorData]
    })

    const result = await prisma.$transaction(async tx => {
      const updatedChunk = await tx.chunk.update({
        where: {id: chunk.id},
        data: {
          pointPrelevementId: targetPointPrelevementId,
          flowType: isDetaching
            ? getSourceFlowTypeFromMetadata(chunk.metadata)
            : exploitation.pointPrelevement.flowType,
          ...actorData,
          instructionStatus: isDetaching ? 'PENDING' : 'VALIDATED',
          instructedAt: null,
          instructedByInstructorUserId: null,
          instructionComment: null,
          parsingInfo: pointAssociationChanged
            ? buildManualChunkPointAssociationParsingInfo({
              parsingInfo: chunk.parsingInfo,
              previousPointPrelevementId,
              pointPrelevementId: targetPointPrelevementId,
              changedByUserId: req.user.id,
              changedByRole: req.user.role,
              details: {
                pointPrelevementName: alias,
                exploitationId: exploitation?.id ?? null
              }
            })
            : chunk.parsingInfo
        },
        select: {
          id: true,
          sourceId: true,
          pointPrelevementId: true,
          parsingInfo: true
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
            pointPrelevementNameAliases: aliases
          }
        })

        if (rootUsageId) {
          await addExploitationSecondaryUsage(exploitation.id, rootUsageId, {client: tx})
        }

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

      if (targetPointPrelevementId) {
        await syncDeclarantZonesFromPoint({
          declarantUserIds: [
            declaration.declarantUserId,
            declaration.createdByDeclarantUserId,
            actorData.preleveurUserId,
            actorData.submittedByDeclarantUserId,
            actorData.collecteurUserId
          ],
          pointPrelevementId: targetPointPrelevementId,
          source: 'RECONCILIATION',
          createdByUserId: req.user.id,
          client: tx
        })
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

      await refreshVolumeMetadataForSourceIds([chunk.sourceId], tx)
      await refreshDeclarantsLastDeclarationAt(activityDeclarantUserIds, {client: tx})

      return {
        ...updatedChunk,
        globalInstructionStatus
      }
    }, {isolationLevel: Prisma.TransactionIsolationLevel.Serializable})

    return res.status(200).json({
      success: true,
      data: {
        declarationId,
        sourceId: chunk.sourceId,
        chunkId: result.id,
        pointPrelevementId: result.pointPrelevementId,
        pointAssociationOrigin: getChunkPointAssociationOrigin(result),
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
      permittedZoneIds: isGlobalAdmin || isDeclarant ? null : req.permittedZoneIds,
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
  permittedZoneIds,
  isGlobalAdmin = false
}) {
  const now = new Date()
  const shouldFilterInstructorZones = !isGlobalAdmin && Array.isArray(permittedZoneIds)

  const declarantLinkActiveWhere = {
    declarantUserId,
    ...exploitationAtDateWhere(now)
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
              ...exploitationAtDateWhere(now),
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
        some: {zoneId: {in: permittedZoneIds}}
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
      codeBSS: true,
      flowType: true,
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
      ...exploitationAtDateWhere(now),
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
      secondaryUsageLinks: {
        include: {usage: true}
      },
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
    for (const usage of getExploitationWaterUses(exploitation)) {
      if (usage.id) {
        usagesById.set(usage.id, serializeWaterUse(usage))
      }
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
