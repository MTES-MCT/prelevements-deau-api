import {Buffer} from 'node:buffer'

import createHttpError from 'http-errors'
import Joi from 'joi'

import {prisma} from '../../db/prisma.js'
import {decorateDeclarationsWithDeclarationTypes} from '../models/declaration-type.js'
import {loadChunkValueCounts} from '../services/chunk-value-summaries.js'
import {getVisibleTelemetryChunksWhere, hydrateMeterSourcePeriods, scopeMeterSource} from '../services/telemetry-source-access.js'
import {
  FEED_KINDS,
  buildFeedDeclarationFilters,
  findFeedDeclarantMatches,
  findFilteredTelemetryIds
} from '../services/declaration-feed-filters.js'
import {
  canReadDeclarationWhere,
  canReadTelemetrySourceWhere,
  getAllowedTypesMetaForDeclarant,
  getReadableDeclarantUserIdsForDeclarant
} from './declarations.js'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
const CURSOR_VERSION = 1

export const DECLARATION_FEED_ENTRY_TYPES = {
  DECLARATION: 'DECLARATION',
  TELEMETRY: 'TELEMETRY'
}

const ENTRY_TYPE_RANK = {
  [DECLARATION_FEED_ENTRY_TYPES.DECLARATION]: 2,
  [DECLARATION_FEED_ENTRY_TYPES.TELEMETRY]: 1
}

const feedDateSchema = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).isoDate().strict().custom((value, helpers) => (
  new Date(value).toISOString().slice(0, 10) === value ? value : helpers.error('any.invalid')
))

const feedQuerySchema = Joi.object({
  cursor: Joi.string().trim().min(1).max(512).optional(),
  includeMeta: Joi.boolean().default(true),
  includeCounts: Joi.boolean().default(true),
  limit: Joi.number().integer().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  kinds: Joi.string().allow('').custom((value, helpers) => {
    const kinds = value ? value.split(',') : []
    return kinds.every(kind => FEED_KINDS.includes(kind)) ? [...new Set(kinds)] : helpers.error('any.invalid')
  }),
  declarationCode: Joi.string().trim().max(100).allow(''),
  declarantName: Joi.string().trim().max(200).allow(''),
  dateFrom: feedDateSchema,
  dateTo: feedDateSchema,
  pointsToAssociateOnly: Joi.boolean().default(false)
}).unknown(false)

const cursorPayloadSchema = Joi.object({
  createdAt: Joi.date().iso().required(),
  id: Joi.string().uuid().required(),
  type: Joi.string().valid(...Object.values(DECLARATION_FEED_ENTRY_TYPES)).required(),
  version: Joi.number().integer().valid(CURSOR_VERSION).required()
}).unknown(false)

const compactUserSelect = {
  id: true,
  email: true,
  firstName: true,
  lastName: true
}

const compactDeclarantSelect = {
  userId: true,
  declarantType: true,
  declarantRole: true,
  civility: true,
  socialReason: true,
  user: {
    select: compactUserSelect
  }
}

const compactPointSelect = {
  id: true,
  name: true,
  otherNames: true,
  usageName: true
}

const compactChunkSelect = {
  id: true,
  calculationStrategy: true,
  instructionStatus: true,
  preleveurUserId: true,
  pointPrelevementId: true,
  pointPrelevementName: true,
  minDate: true,
  maxDate: true,
  metadata: true,
  pointPrelevement: {
    select: compactPointSelect
  }
}

const compactSourceSelect = {
  id: true,
  type: true,
  status: true,
  globalInstructionStatus: true,
  metadata: true,
  createdAt: true,
  chunks: {
    orderBy: [
      {minDate: 'asc'},
      {createdAt: 'asc'}
    ],
    select: compactChunkSelect
  },
  _count: {
    select: {
      chunks: true
    }
  }
}

const compactDeclarationFields = {
  id: true,
  code: true,
  type: true,
  dataSourceType: true,
  processingStatus: true,
  createdAt: true,
  declarant: {
    select: compactDeclarantSelect
  },
  createdByDeclarant: {
    select: compactDeclarantSelect
  }
}

export const DECLARATION_FEED_DECLARATION_SELECT = {
  ...compactDeclarationFields,
  source: {
    select: compactSourceSelect
  }
}

function buildTelemetrySourceSelect(declarantUserIds, user) {
  return {
    id: true,
    type: true,
    status: true,
    globalInstructionStatus: true,
    metadata: true,
    createdAt: true,
    declaration: {
      select: compactDeclarationFields
    },
    chunks: {
      where: getVisibleTelemetryChunksWhere({user}),
      orderBy: [
        {minDate: 'asc'},
        {createdAt: 'asc'}
      ],
      select: {
        ...compactChunkSelect,
        preleveur: {select: compactDeclarantSelect},
        pointPrelevement: {
          select: {
            ...compactPointSelect,
            declarants: {
              where: {
                declarantUserId: {
                  in: declarantUserIds
                }
              },
              select: {
                declarantUserId: true,
                declarant: {
                  select: compactDeclarantSelect
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
}

function pickProperties(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  return Object.fromEntries(
    keys
      .filter(key => Object.hasOwn(value, key))
      .map(key => [key, value[key]])
  )
}

function serializeDeclarant(declarant) {
  if (!declarant) {
    return null
  }

  const user = declarant.user ?? {}

  return {
    ...declarant,
    id: declarant.userId ?? user.id,
    email: user.email ?? null,
    firstName: user.firstName ?? null,
    lastName: user.lastName ?? null
  }
}

function serializeChunk(chunk) {
  const {pointPrelevement} = chunk

  return {
    ...chunk,
    metadata: pickProperties(chunk.metadata, chunk.calculationStrategy === 'METER'
      ? ['calculationStrategy', 'totalWaterVolume', 'totalWaterVolumeWithdrawn', 'totalWaterVolumeDischarged', 'periodStart', 'periodEnd']
      : ['readingDate']),
    ...(pointPrelevement
      ? {
        pointPrelevement: {
          ...pointPrelevement,
          ...(pointPrelevement.declarants
            ? {
              declarants: pointPrelevement.declarants.map(link => ({
                ...link,
                declarant: serializeDeclarant(link.declarant)
              }))
            }
            : {})
        }
      }
      : {})
  }
}

function serializeDeclaration(declaration) {
  if (!declaration) {
    return null
  }

  const {source, ...declarationFields} = declaration

  return {
    ...declarationFields,
    declarant: serializeDeclarant(declaration.declarant),
    createdByDeclarant: serializeDeclarant(declaration.createdByDeclarant),
    ...(source ? {source: serializeSource(source)} : {})
  }
}

function getTelemetrySourceDeclarant(source, declarantUserIds) {
  const meteredPreleveur = source.chunks?.find(chunk => chunk.calculationStrategy === 'METER' && chunk.preleveur)?.preleveur
  if (meteredPreleveur) return serializeDeclarant(meteredPreleveur)
  const readableIds = new Set(declarantUserIds)
  const links = (source.chunks ?? [])
    .flatMap(chunk => chunk.pointPrelevement?.declarants ?? [])
    .filter(link => readableIds.has(link.declarantUserId))
  const link = links.find(candidate => candidate.declarantUserId === declarantUserIds[0])
    ?? links[0]

  return serializeDeclarant(link?.declarant)
}

function serializeSource(input, declarantUserIds = []) {
  const source = scopeMeterSource(input)
  if (!source) {
    return null
  }

  const {declaration, ...sourceFields} = source
  const serialized = {
    ...sourceFields,
    metadata: pickProperties(source.metadata, [
      'connector',
      'calculationStrategy',
      'entriesCount',
      'manualQuickDeclaration',
      'measurementType',
      'readingDate',
      ...(source.metadata?.calculationStrategy === 'METER' ? ['periodStart', 'periodEnd'] : []),
      'totalWaterVolumeDischarged',
      'totalWaterVolumeWithdrawn'
    ]),
    chunks: (source.chunks ?? []).map(serializeChunk),
    ...(declaration ? {declaration: serializeDeclaration(declaration)} : {})
  }

  if (source.type === 'API') {
    serialized.declarant = getTelemetrySourceDeclarant(serialized, declarantUserIds)
  }

  return serialized
}

function buildTelemetryDeclaration(source) {
  if (source.declaration) {
    return source.declaration
  }

  return {
    id: source.id,
    code: null,
    title: source.metadata?.connector
      ? `Télérelève ${source.metadata.connector}`
      : 'Données télérelevées',
    type: 'telemetry',
    declarationType: {
      name: source.metadata?.connector ?? 'Télérelève'
    },
    dataSourceType: 'API',
    processingStatus: null,
    createdAt: source.createdAt,
    declarant: source.declarant ?? null,
    createdByDeclarant: null
  }
}

function getDeclarationEntryKind(declaration) {
  if (declaration.dataSourceType === 'API') {
    return 'TELEMETRY'
  }

  return declaration.dataSourceType ?? 'NONE'
}

function getEntryResourceId(entry) {
  return entry.entryType === DECLARATION_FEED_ENTRY_TYPES.DECLARATION
    ? entry.declaration.id
    : entry.source.id
}

function getComparableTimestamp(value) {
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? timestamp : 0
}

export function compareDeclarationFeedEntriesDescending(a, b) {
  const dateDifference = getComparableTimestamp(b.createdAt) - getComparableTimestamp(a.createdAt)
  if (dateDifference !== 0) {
    return dateDifference
  }

  const typeDifference = ENTRY_TYPE_RANK[b.entryType] - ENTRY_TYPE_RANK[a.entryType]
  if (typeDifference !== 0) {
    return typeDifference
  }

  const aId = getEntryResourceId(a)
  const bId = getEntryResourceId(b)
  if (aId === bId) {
    return 0
  }

  return aId > bId ? -1 : 1
}

export function encodeDeclarationFeedCursor(entry) {
  const payload = {
    version: CURSOR_VERSION,
    createdAt: new Date(entry.createdAt).toISOString(),
    type: entry.entryType,
    id: getEntryResourceId(entry)
  }

  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

export function decodeDeclarationFeedCursor(cursor) {
  try {
    const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    const {error, value} = cursorPayloadSchema.validate(payload, {
      abortEarly: false,
      convert: true
    })

    if (error) {
      throw error
    }

    return {
      ...value,
      createdAt: new Date(value.createdAt)
    }
  } catch {
    throw createHttpError(400, 'Curseur de pagination invalide.')
  }
}

export function buildDeclarationFeedPositionWhere(entryType, cursor) {
  if (!cursor) {
    return null
  }

  const entryRank = ENTRY_TYPE_RANK[entryType]
  const cursorRank = ENTRY_TYPE_RANK[cursor.type]
  const sameDateConditions = []

  if (entryRank < cursorRank) {
    sameDateConditions.push({createdAt: cursor.createdAt})
  } else if (entryRank === cursorRank) {
    sameDateConditions.push({
      createdAt: cursor.createdAt,
      id: {lt: cursor.id}
    })
  }

  return {
    OR: [
      {createdAt: {lt: cursor.createdAt}},
      ...sameDateConditions
    ]
  }
}

function withPositionWhere(accessWhere, entryType, cursor) {
  const positionWhere = buildDeclarationFeedPositionWhere(entryType, cursor)

  return positionWhere
    ? {AND: [accessWhere, positionWhere]}
    : accessWhere
}

export function getDeclarationFeedAccessWhere(user, declarantUserIds) {
  const preleveurIds = declarantUserIds.filter(id => id !== user.id)

  return {
    declarations: canReadDeclarationWhere(user.id, preleveurIds),
    telemetrySources: canReadTelemetrySourceWhere(declarantUserIds, {user})
  }
}

function getGroupCount(group) {
  return Number(group?._count?._all ?? group?._count ?? 0)
}

export function buildDeclarationFeedCounts(declarationGroups, telemetryCount) {
  const countsByKind = {
    MANUAL: 0,
    SPREADSHEET: 0,
    TELEMETRY: Number(telemetryCount) || 0,
    NONE: 0
  }

  for (const group of declarationGroups) {
    const kind = group.dataSourceType === 'API'
      ? 'TELEMETRY'
      : group.dataSourceType ?? 'NONE'
    countsByKind[kind] = (countsByKind[kind] ?? 0) + getGroupCount(group)
  }

  return {
    countsByKind,
    total: Object.values(countsByKind).reduce((sum, count) => sum + count, 0)
  }
}

export function paginateDeclarationFeedEntries(entries, limit) {
  const ordered = [...entries].sort(compareDeclarationFeedEntriesDescending)
  const hasNext = ordered.length > limit
  const data = ordered.slice(0, limit)

  return {
    data,
    hasNext,
    nextCursor: hasNext && data.length > 0
      ? encodeDeclarationFeedCursor(data.at(-1))
      : null
  }
}

export function parseDeclarationFeedQuery(query) {
  const {error, value} = feedQuerySchema.validate(query ?? {}, {
    abortEarly: false,
    convert: true,
    stripUnknown: false
  })

  if (error) {
    throw createHttpError(400, error.message)
  }
  if (value.dateFrom && value.dateTo && value.dateFrom > value.dateTo) {
    throw createHttpError(400, 'La date de début doit précéder la date de fin.')
  }

  return {
    ...value,
    ...(Object.hasOwn(value, 'kinds') ? {kinds: value.kinds === '' ? [] : value.kinds} : {}),
    cursor: value.cursor ? decodeDeclarationFeedCursor(value.cursor) : null
  }
}

async function findTelemetryPage({user, declarantUserIds, filters, declarantMatches, cursor, take, accessWhere, client}) {
  const {kinds, pointsToAssociateOnly, declarationCode, declarantName, dateFrom, dateTo} = filters
  if (pointsToAssociateOnly || (kinds !== undefined && !kinds.includes('TELEMETRY'))) return []
  const hasFilters = Boolean(declarationCode || declarantName || dateFrom || dateTo)
  const ids = hasFilters
    ? await findFilteredTelemetryIds({user, declarantUserIds, filters, declarantMatches, cursor, take, client})
    : null
  if (ids?.length === 0) return []
  const where = withPositionWhere(accessWhere, DECLARATION_FEED_ENTRY_TYPES.TELEMETRY, cursor)
  return client.source.findMany({
    where: ids ? {AND: [where, {id: {in: ids}}]} : where,
    orderBy: [{createdAt: 'desc'}, {id: 'desc'}],
    take,
    select: buildTelemetrySourceSelect(declarantUserIds, user)
  })
}

function buildGlobalFeedMeta({includeMeta, allowedTypesPayload, counts, otherDeclaration}) {
  return includeMeta ? {
    ...allowedTypesPayload?.meta,
    ...counts,
    hasOtherDeclarations: counts ? counts.countsByKind.NONE > 0 : Boolean(otherDeclaration)
  } : {}
}

async function hydrateFeedChunkCounts(entries, client) {
  // Scope counts to the final page and already-authorized chunks. Prisma's
  // nested relation count otherwise aggregates the whole ChunkValue table.
  const sources = entries.flatMap(entry => [entry.source, entry.declaration?.source]).filter(Boolean)
  const chunkIds = sources.flatMap(source => (source.chunks ?? []).map(chunk => chunk.id))
  const counts = await loadChunkValueCounts(chunkIds, {client})
  const hydrateSource = source => source && ({
    ...source,
    chunks: (source.chunks ?? []).map(chunk => ({
      ...chunk,
      _count: {...chunk._count, chunkValues: counts.get(chunk.id) ?? 0}
    }))
  })

  return entries.map(entry => ({
    ...entry,
    source: hydrateSource(entry.source),
    declaration: entry.declaration?.source
      ? {...entry.declaration, source: hydrateSource(entry.declaration.source)}
      : entry.declaration
  }))
}

export async function buildDeclarantDeclarationFeed({
  user,
  limit = DEFAULT_LIMIT,
  cursor = null,
  includeMeta = true,
  includeCounts = true,
  kinds,
  declarationCode,
  declarantName,
  dateFrom,
  dateTo,
  pointsToAssociateOnly = false,
  client = prisma,
  findReadableDeclarantUserIds = getReadableDeclarantUserIdsForDeclarant,
  findAllowedTypesMeta = getAllowedTypesMetaForDeclarant,
  decorateDeclarationTypes = decorateDeclarationsWithDeclarationTypes
}) {
  const declarantUserIds = await findReadableDeclarantUserIds(user)
  const accessWhere = getDeclarationFeedAccessWhere(user, declarantUserIds)
  const take = limit + 1
  const filters = {kinds, declarationCode, declarantName, dateFrom, dateTo, pointsToAssociateOnly}
  const declarantMatches = await findFeedDeclarantMatches(declarantName, client)
  const declarationFilters = buildFeedDeclarationFilters(filters, declarantMatches)
  const declarationWhere = declarationFilters.length
    ? {AND: [accessWhere.declarations, ...declarationFilters]}
    : accessWhere.declarations
  const readDeclarations = kinds === undefined || kinds.length > 0
  const readCounts = includeMeta && includeCounts

  const [
    declarationRows,
    telemetryRows,
    declarationGroups,
    telemetryCount,
    allowedTypesPayload,
    otherDeclaration
  ] = await Promise.all([
    readDeclarations ? client.declaration.findMany({
      where: withPositionWhere(
        declarationWhere,
        DECLARATION_FEED_ENTRY_TYPES.DECLARATION,
        cursor
      ),
      orderBy: [
        {createdAt: 'desc'},
        {id: 'desc'}
      ],
      take,
      select: DECLARATION_FEED_DECLARATION_SELECT
    }) : [],
    findTelemetryPage({user, declarantUserIds, filters, declarantMatches, cursor, take, accessWhere: accessWhere.telemetrySources, client}),
    readCounts
      ? client.declaration.groupBy({
        by: ['dataSourceType'],
        where: accessWhere.declarations,
        _count: {_all: true}
      })
      : null,
    readCounts ? client.source.count({where: accessWhere.telemetrySources}) : null,
    includeMeta ? findAllowedTypesMeta(user.id, {includePreleveurs: false}) : null,
    includeMeta && !includeCounts ? client.declaration.findFirst({
      where: {
        AND: [
          accessWhere.declarations,
          {OR: [{dataSourceType: 'NONE'}, {dataSourceType: null}]}
        ]
      },
      select: {id: true}
    }) : null
  ])

  const declarations = declarationRows.map(serializeDeclaration)
  const telemetrySources = (await hydrateMeterSourcePeriods(telemetryRows, {client})).map(source => serializeSource(source, declarantUserIds))
  const declarationsToDecorate = [
    ...declarations,
    ...telemetrySources.map(source => source.declaration).filter(Boolean)
  ]
  const decoratedDeclarations = await decorateDeclarationTypes(declarationsToDecorate)
  const decoratedDeclarationsById = new Map(
    decoratedDeclarations.map(declaration => [declaration.id, declaration])
  )

  const entries = [
    ...declarations.map(declaration => {
      const decorated = decoratedDeclarationsById.get(declaration.id) ?? declaration

      return {
        id: `declaration-${declaration.id}`,
        entryType: DECLARATION_FEED_ENTRY_TYPES.DECLARATION,
        kind: getDeclarationEntryKind(decorated),
        createdAt: decorated.createdAt,
        declaration: decorated,
        source: decorated.source ?? null,
        url: `/mes-declarations/${declaration.id}`
      }
    }),
    ...telemetrySources.map(source => {
      const decoratedSource = source.declaration
        ? {
          ...source,
          declaration: decoratedDeclarationsById.get(source.declaration.id) ?? source.declaration
        }
        : source

      return {
        id: `telemetry-${source.id}`,
        entryType: DECLARATION_FEED_ENTRY_TYPES.TELEMETRY,
        kind: 'TELEMETRY',
        createdAt: source.createdAt,
        declaration: buildTelemetryDeclaration(decoratedSource),
        source: decoratedSource,
        url: `/mes-declarations/sources/${source.id}`
      }
    })
  ]
  const page = paginateDeclarationFeedEntries(entries, limit)
  const counts = readCounts
    ? buildDeclarationFeedCounts(declarationGroups, telemetryCount)
    : null

  return {
    success: true,
    data: await hydrateFeedChunkCounts(page.data, client),
    meta: {
      ...buildGlobalFeedMeta({includeMeta, allowedTypesPayload, counts, otherDeclaration}),
      pagination: {
        limit,
        hasNext: page.hasNext,
        nextCursor: page.nextCursor
      }
    }
  }
}

export async function listMyDeclarationFeedHandler(req, res, next) {
  try {
    const query = parseDeclarationFeedQuery(req.query)
    const response = await buildDeclarantDeclarationFeed({
      user: req.user,
      ...query
    })

    return res.json(response)
  } catch (error) {
    next(error)
  }
}
