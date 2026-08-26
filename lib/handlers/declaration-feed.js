import {Buffer} from 'node:buffer'

import createHttpError from 'http-errors'
import Joi from 'joi'

import {prisma} from '../../db/prisma.js'
import {decorateDeclarationsWithDeclarationTypes} from '../models/declaration-type.js'
import {
  canReadDeclarationWhere,
  canReadTelemetrySourceWhere,
  getAllowedTypesMetaForDeclarant,
  getReadableDeclarantUserIdsForDeclarant
} from './declarations.js'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const CURSOR_VERSION = 1

export const DECLARATION_FEED_ENTRY_TYPES = {
  DECLARATION: 'DECLARATION',
  TELEMETRY: 'TELEMETRY'
}

const ENTRY_TYPE_RANK = {
  [DECLARATION_FEED_ENTRY_TYPES.DECLARATION]: 2,
  [DECLARATION_FEED_ENTRY_TYPES.TELEMETRY]: 1
}

const feedQuerySchema = Joi.object({
  cursor: Joi.string().trim().min(1).max(512).optional(),
  includeMeta: Joi.boolean().default(true),
  limit: Joi.number().integer().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT)
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
  pointPrelevementId: true,
  pointPrelevementName: true,
  minDate: true,
  maxDate: true,
  metadata: true,
  pointPrelevement: {
    select: compactPointSelect
  },
  _count: {
    select: {
      chunkValues: true
    }
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

function buildTelemetrySourceSelect(declarantUserIds) {
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
      orderBy: [
        {minDate: 'asc'},
        {createdAt: 'asc'}
      ],
      select: {
        ...compactChunkSelect,
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
    metadata: pickProperties(chunk.metadata, ['readingDate']),
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
  const readableIds = new Set(declarantUserIds)
  const links = (source.chunks ?? [])
    .flatMap(chunk => chunk.pointPrelevement?.declarants ?? [])
    .filter(link => readableIds.has(link.declarantUserId))
  const link = links.find(candidate => candidate.declarantUserId === declarantUserIds[0])
    ?? links[0]

  return serializeDeclarant(link?.declarant)
}

function serializeSource(source, declarantUserIds = []) {
  if (!source) {
    return null
  }

  const {declaration, ...sourceFields} = source
  const serialized = {
    ...sourceFields,
    metadata: pickProperties(source.metadata, [
      'connector',
      'entriesCount',
      'manualQuickDeclaration',
      'measurementType',
      'readingDate',
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
    telemetrySources: canReadTelemetrySourceWhere(declarantUserIds)
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

  return {
    ...value,
    cursor: value.cursor ? decodeDeclarationFeedCursor(value.cursor) : null
  }
}

export async function buildDeclarantDeclarationFeed({
  user,
  limit = DEFAULT_LIMIT,
  cursor = null,
  includeMeta = true,
  client = prisma,
  findReadableDeclarantUserIds = getReadableDeclarantUserIdsForDeclarant,
  findAllowedTypesMeta = getAllowedTypesMetaForDeclarant,
  decorateDeclarationTypes = decorateDeclarationsWithDeclarationTypes
}) {
  const declarantUserIds = await findReadableDeclarantUserIds(user)
  const accessWhere = getDeclarationFeedAccessWhere(user, declarantUserIds)
  const take = limit + 1

  const [
    declarationRows,
    telemetryRows,
    declarationGroups,
    telemetryCount,
    allowedTypesPayload
  ] = await Promise.all([
    client.declaration.findMany({
      where: withPositionWhere(
        accessWhere.declarations,
        DECLARATION_FEED_ENTRY_TYPES.DECLARATION,
        cursor
      ),
      orderBy: [
        {createdAt: 'desc'},
        {id: 'desc'}
      ],
      take,
      select: DECLARATION_FEED_DECLARATION_SELECT
    }),
    client.source.findMany({
      where: withPositionWhere(
        accessWhere.telemetrySources,
        DECLARATION_FEED_ENTRY_TYPES.TELEMETRY,
        cursor
      ),
      orderBy: [
        {createdAt: 'desc'},
        {id: 'desc'}
      ],
      take,
      select: buildTelemetrySourceSelect(declarantUserIds)
    }),
    includeMeta
      ? client.declaration.groupBy({
        by: ['dataSourceType'],
        where: accessWhere.declarations,
        _count: {_all: true}
      })
      : null,
    includeMeta ? client.source.count({where: accessWhere.telemetrySources}) : null,
    includeMeta ? findAllowedTypesMeta(user.id, {includePreleveurs: false}) : null
  ])

  const declarations = declarationRows.map(serializeDeclaration)
  const telemetrySources = telemetryRows.map(source => serializeSource(source, declarantUserIds))
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
  const counts = includeMeta
    ? buildDeclarationFeedCounts(declarationGroups, telemetryCount)
    : null

  return {
    success: true,
    data: page.data,
    meta: {
      ...(includeMeta
        ? {
          ...allowedTypesPayload?.meta,
          ...counts
        }
        : {}),
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
    const {cursor, includeMeta, limit} = parseDeclarationFeedQuery(req.query)
    const response = await buildDeclarantDeclarationFeed({
      user: req.user,
      cursor,
      includeMeta,
      limit
    })

    return res.json(response)
  } catch (error) {
    next(error)
  }
}
