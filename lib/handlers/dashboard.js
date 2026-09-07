import {Buffer} from 'node:buffer'
import {performance} from 'node:perf_hooks'
import process from 'node:process'

import createHttpError from 'http-errors'
import {Prisma} from '@prisma/client'

import {prisma} from '../../db/prisma.js'
import {LEGACY_METRIC_TYPE_CODES, METRIC_TYPE_CODES} from '../constants/metric-type-codes.js'
import {ZONE_PERMISSION_CODES, sortZonePermissions} from '../constants/zone-permissions.js'
import {getPreleveurIdsForCollecteur} from '../models/exploitation.js'
import {activeWindowWhere, getCoordsByPointIds} from '../models/point-prelevement.js'
import {serializeWaterUse} from '../services/sandre-water-uses.js'
import {getExploitationWaterUses} from '../services/exploitation-usages.js'
import {getDashboardMapCapabilities, getDashboardMapPointScope} from '../services/dashboard-map-access.js'
import {withRequestPerformancePhase} from '../util/request-performance.js'
import {
  getDeclarationPeriodKey,
  getDeclarationPeriodKeysBetween,
  getDeclarationPeriodStart,
  getMonthStart,
  getNextDeclarationPeriodStart,
  getNextWeekStart,
  parseDeclarationPeriodKey,
  parseDeclarationPeriodType
} from '../util/declaration-periods.js'

const LEGACY_WATER_BODY_TYPE_REPLACEMENTS = {
  SURFACE: 'SUPERFICIELLE'
}
const WATER_BODY_TYPE_VALUES = ['SUPERFICIELLE', 'SOUTERRAIN', 'TRANSITION']
const WATER_BODY_TYPES = new Set(WATER_BODY_TYPE_VALUES)
const NO_WATER_BODY_TYPES_SENTINEL = '__none__'
const VOLUME_MONTH_SHORT_LABELS = [
  'jan',
  'fév',
  'mar',
  'avr',
  'mai',
  'jun',
  'jul',
  'aoû',
  'sep',
  'oct',
  'nov',
  'déc'
]
const VOLUME_CHART_METRICS = [
  {
    key: 'withdrawn',
    metricTypeCode: METRIC_TYPE_CODES.VOLUME,
    flowType: 'PRELEVEMENT',
    title: 'Volumes prélevés par usage'
  },
  {
    key: 'discharged',
    metricTypeCode: METRIC_TYPE_CODES.VOLUME,
    flowType: 'REJET',
    title: 'Volumes rejetés par usage'
  }
]
const VOLUME_METRIC_TYPE_CODES = [
  METRIC_TYPE_CODES.VOLUME,
  LEGACY_METRIC_TYPE_CODES.VOLUME_PRELEVE,
  LEGACY_METRIC_TYPE_CODES.VOLUME_REJETE
]
export const DASHBOARD_SOURCE_TYPES = Object.freeze(['DECLARATION', 'API'])
const DASHBOARD_SOURCE_STATUS = 'COMPLETED'

const COMPLETED_DASHBOARD_SOURCE_SQL = Prisma.sql`
  AND s.type IN (${Prisma.join(
    DASHBOARD_SOURCE_TYPES.map(sourceType => Prisma.sql`${sourceType}::"SourceType"`)
  )})
  AND s.status = ${DASHBOARD_SOURCE_STATUS}::"SourceStatus"
`

const VOLUME_FLOW_TYPE_SQL = Prisma.sql`
  COALESCE(
    c."flowType"::text,
    p."flowType"::text,
    CASE
      WHEN v."metricTypeCode" = ${LEGACY_METRIC_TYPE_CODES.VOLUME_REJETE} THEN 'REJET'
      WHEN v."metricTypeCode" = ${LEGACY_METRIC_TYPE_CODES.VOLUME_PRELEVE} THEN 'PRELEVEMENT'
      ELSE NULL
    END
  )
`

function roundDuration(duration) {
  return Math.round(duration * 10) / 10
}

function createDashboardPerfLogger() {
  const enabled = process.env.DASHBOARD_PERF_LOG === '1'
  const startedAt = performance.now()
  const timings = []

  return {
    async time(label, action) {
      if (!enabled) {
        return action()
      }

      const stepStartedAt = performance.now()

      try {
        return await action()
      } finally {
        timings.push({
          label,
          durationMs: roundDuration(performance.now() - stepStartedAt)
        })
      }
    },
    log(payload) {
      if (!enabled) {
        return
      }

      const payloadBytes = Buffer.byteLength(JSON.stringify(payload))

      console.log('[dashboard] territory perf', JSON.stringify({
        durationMs: roundDuration(performance.now() - startedAt),
        payloadBytes,
        pointsCount: payload.points.length,
        scope: payload.scope,
        timings,
        zonesCount: payload.zones.length
      }))
    }
  }
}

function splitZoneCodes(value) {
  const values = Array.isArray(value) ? value : [value]

  return [
    ...new Set(
      values
        .flatMap(item => String(item ?? '').split(','))
        .map(item => item.trim())
        .filter(Boolean)
    )
  ]
}

function compareUsageCodes(a, b) {
  return String(a.usage?.code ?? '').localeCompare(String(b.usage?.code ?? ''), 'fr', {
    numeric: true,
    sensitivity: 'base'
  })
}

function parseYear(value) {
  const year = Number(Array.isArray(value) ? value[0] : value)
  const currentYear = new Date().getUTCFullYear()

  if (!Number.isInteger(year) || year < 2000 || year > currentYear) {
    return null
  }

  return year
}

export function parseDashboardIncludePoints(value) {
  if (value === undefined) {
    return true
  }

  const normalizedValue = Array.isArray(value) ? value[0] : value
  if (normalizedValue === true || normalizedValue === 'true') {
    return true
  }

  if (normalizedValue === false || normalizedValue === 'false') {
    return false
  }

  throw createHttpError(400, 'Le paramètre includePoints doit être un booléen.')
}

export function parseDashboardMapScope(value) {
  const normalizedValue = Array.isArray(value) ? value[0] : value
  const scope = normalizedValue ?? 'territory'

  if (scope !== 'territory' && scope !== 'activity') {
    throw createHttpError(400, 'Le paramètre scope doit valoir territory ou activity.')
  }

  return scope
}

function parseWaterBodyTypes(...values) {
  const hasFilter = values.some(value => value !== undefined)
  const rawValues = values
    .flatMap(value => Array.isArray(value) ? value : [value])
    .flatMap(value => String(value ?? '').split(','))
    .map(value => value.trim())
    .filter(Boolean)

  if (!hasFilter) {
    return null
  }

  if (rawValues.includes(NO_WATER_BODY_TYPES_SENTINEL)) {
    return []
  }

  return [
    ...new Set(
      rawValues
        .map(value => LEGACY_WATER_BODY_TYPE_REPLACEMENTS[value] ?? value)
        .filter(value => WATER_BODY_TYPES.has(value))
    )
  ]
}

function capitalize(value) {
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value
}

const monthFormatter = new Intl.DateTimeFormat('fr-FR', {
  month: 'long',
  timeZone: 'UTC',
  year: 'numeric'
})
const weekStartFormatter = new Intl.DateTimeFormat('fr-FR', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC'
})
const weekEndFormatter = new Intl.DateTimeFormat('fr-FR', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
  year: 'numeric'
})

function serializeMonthOption(monthKey) {
  return {
    value: monthKey,
    label: capitalize(monthFormatter.format(getMonthStart(monthKey)))
  }
}

function serializeWeekOption(weekKey) {
  const start = getDeclarationPeriodStart('week', weekKey)
  const end = new Date(getNextWeekStart(weekKey).getTime() - (24 * 60 * 60 * 1000))
  const week = Number(weekKey.slice(6, 8))

  return {
    value: weekKey,
    label: `Semaine ${week} (${weekStartFormatter.format(start)} - ${weekEndFormatter.format(end)})`
  }
}

function serializeDeclarationPeriodOption(periodType, periodKey) {
  return periodType === 'week'
    ? serializeWeekOption(periodKey)
    : serializeMonthOption(periodKey)
}

function serializeVolumeMonth(year, month) {
  const monthKey = `${year}-${String(month).padStart(2, '0')}`

  return {
    month,
    monthKey,
    label: monthFormatter.format(getMonthStart(monthKey)),
    shortLabel: `${VOLUME_MONTH_SHORT_LABELS[month - 1]} ${year}`,
    total: 0,
    usages: []
  }
}

function getRootUsage(usage) {
  if (usage?.kind === 'SUB_USAGE' && usage.parent) {
    return usage.parent
  }

  return usage
}

function getZoneIdsSql(zoneIds) {
  return Prisma.join(zoneIds.map(zoneId => Prisma.sql`${zoneId}::uuid`))
}

function getWaterBodyTypesSql(waterBodyTypes) {
  if (waterBodyTypes === null) {
    return Prisma.empty
  }

  if (waterBodyTypes.length === 0) {
    return Prisma.sql`AND false`
  }

  return Prisma.sql`AND p."waterBodyType" IN (${Prisma.join(waterBodyTypes.map(waterBodyType => Prisma.sql`${waterBodyType}::"WaterBodyType"`))})`
}

function getVisibleUsageSql() {
  return Prisma.sql`AND COALESCE(parent_usage."dashboardVisible", usage."dashboardVisible") = true`
}

function serializeUsageFromVolumeRow(row) {
  return {
    id: row.usageId,
    code: row.usageCode,
    kind: 'USAGE',
    parentId: null,
    mnemonic: row.usageMnemonic ?? null,
    label: row.usageLabel,
    definition: null,
    status: null,
    color: row.usageColor,
    dashboardVisible: true
  }
}

function isDashboardVisibleUsage(usage) {
  return getRootUsage(usage)?.dashboardVisible !== false
}

function addPointToUsage(pointIdsByUsageId, usagesById, usage, pointPrelevementId) {
  const rootUsage = getRootUsage(usage)

  if (!rootUsage?.id || !pointPrelevementId || rootUsage.dashboardVisible === false) {
    return null
  }

  if (!pointIdsByUsageId.has(rootUsage.id)) {
    pointIdsByUsageId.set(rootUsage.id, new Set())
  }

  pointIdsByUsageId.get(rootUsage.id).add(pointPrelevementId)

  if (!usagesById.has(rootUsage.id)) {
    usagesById.set(rootUsage.id, serializeWaterUse(rootUsage))
  }

  return rootUsage.id
}

function getPointDashboardUsages(point, declarantUserIds = null) {
  const declarantUserIdsSet = declarantUserIds ? new Set(declarantUserIds) : null
  const usagesById = new Map()

  for (const exploitation of point.declarants ?? []) {
    if (declarantUserIdsSet && !declarantUserIdsSet.has(exploitation.declarantUserId)) {
      continue
    }

    for (const usage of getExploitationWaterUses(exploitation)) {
      const rootUsage = getRootUsage(usage)

      if (!rootUsage?.id || rootUsage.dashboardVisible === false) {
        continue
      }

      usagesById.set(rootUsage.id, serializeWaterUse(rootUsage))
    }
  }

  return [...usagesById.values()]
}

function serializeZoneRight(right) {
  const permissions = sortZonePermissions(
    (right.permissions || []).map(item => item.permission || item)
  )

  return {
    id: right.zone.id,
    type: right.zone.type,
    code: right.zone.code,
    name: right.zone.name,
    isAdmin: permissions.length === ZONE_PERMISSION_CODES.length,
    permissions,
    startDate: right.startDate,
    endDate: right.endDate
  }
}

async function getDashboardDeclarantUserIds(user) {
  if (user.role !== 'DECLARANT') {
    return null
  }

  const preleveurIds = user.declarant?.declarantRole === 'COLLECTEUR'
    ? await getPreleveurIdsForCollecteur(user.id)
    : []

  return [...new Set([user.id, ...preleveurIds].filter(Boolean))]
}

function getDashboardScope(user) {
  if (user.role !== 'DECLARANT') {
    return 'TERRITORY'
  }

  return user.declarant?.declarantRole === 'COLLECTEUR'
    ? 'COLLECTOR'
    : 'DECLARANT'
}

function getDeclarantPointWhere(declarantUserIds, collecteurUserId = null) {
  if (collecteurUserId) {
    return {
      declarants: {
        some: {
          collecteurs: {
            some: {collecteurUserId}
          }
        }
      }
    }
  }

  if (!declarantUserIds) {
    return {}
  }

  return {
    declarants: {
      some: {
        declarantUserId: {
          in: declarantUserIds
        }
      }
    }
  }
}

function getExploitationDeclarantWhere(declarantUserIds, collecteurUserId = null) {
  if (collecteurUserId) {
    return {
      collecteurs: {
        some: {collecteurUserId}
      },
      declarant: {
        declarantRole: 'PRELEVEUR',
        user: {
          deletedAt: null
        }
      }
    }
  }

  if (!declarantUserIds) {
    return {
      declarant: {
        declarantRole: 'PRELEVEUR',
        user: {
          deletedAt: null
        }
      }
    }
  }

  return {
    declarantUserId: {
      in: declarantUserIds
    },
    declarant: {
      user: {
        deletedAt: null
      }
    }
  }
}

function getDeclarationSourceWhere(declarantUserIds) {
  if (!declarantUserIds) {
    return {}
  }

  return {
    declaration: {
      OR: [
        {
          declarantUserId: {
            in: declarantUserIds
          }
        },
        {
          createdByDeclarantUserId: {
            in: declarantUserIds
          }
        }
      ]
    }
  }
}

export function getCompletedDashboardSourceWhere() {
  return {
    type: {
      in: [...DASHBOARD_SOURCE_TYPES]
    },
    status: DASHBOARD_SOURCE_STATUS
  }
}

function getDashboardChunkDeclarantWhere(declarantUserIds) {
  if (!declarantUserIds) {
    return {}
  }

  const actorWhere = {
    in: declarantUserIds
  }

  return {
    OR: [
      {source: getDeclarationSourceWhere(declarantUserIds)},
      {
        source: {
          type: 'API'
        },
        OR: [
          {preleveurUserId: actorWhere},
          {submittedByDeclarantUserId: actorWhere},
          {collecteurUserId: actorWhere}
        ]
      }
    ]
  }
}

async function getAccessibleZoneRights(user, declarantUserIds = null, {collecteurUserId = null} = {}) {
  if (user.role === 'ADMIN') {
    const zones = await prisma.zone.findMany({
      where: {
        pointPrelevementZones: {
          some: {
            pointPrelevement: {
              deletedAt: null
            }
          }
        }
      },
      select: {
        id: true,
        type: true,
        code: true,
        name: true
      },
      orderBy: {
        name: 'asc'
      }
    })

    return zones.map(zone => ({
      zone,
      isAdmin: true,
      permissions: ZONE_PERMISSION_CODES,
      startDate: null,
      endDate: null
    }))
  }

  if (user.role === 'DECLARANT') {
    const zones = await prisma.zone.findMany({
      where: {
        type: 'SAGE',
        pointPrelevementZones: {
          some: {
            pointPrelevement: {
              deletedAt: null,
              ...getDeclarantPointWhere(declarantUserIds, collecteurUserId)
            }
          }
        }
      },
      select: {
        id: true,
        type: true,
        code: true,
        name: true
      },
      orderBy: {
        name: 'asc'
      }
    })

    return zones.map(zone => ({
      zone,
      isAdmin: false,
      permissions: [],
      startDate: null,
      endDate: null
    }))
  }

  return prisma.instructorZone.findMany({
    where: {
      instructorUserId: user.id,
      ...activeWindowWhere(new Date(), {
        startNullable: false,
        endNullable: true
      }),
      permissions: {
        some: {permission: 'zone.dashboard.read'}
      }
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
    },
    orderBy: {
      createdAt: 'asc'
    }
  })
}

function selectZones(accessibleZones, requestedCodes) {
  if (requestedCodes.length === 0) {
    return accessibleZones
  }

  const requestedCodesSet = new Set(requestedCodes)
  return accessibleZones.filter(zone => requestedCodesSet.has(zone.code))
}

export async function resolveDashboardZoneSelection(
  user, requestedZoneCodesValue, {collecteurUserId = null, declarantUserIds: scopedDeclarantUserIds} = {}
) {
  const hasExplicitDeclarantScope = collecteurUserId || Array.isArray(scopedDeclarantUserIds)
  const declarantUserIds = hasExplicitDeclarantScope
    ? (scopedDeclarantUserIds ?? null)
    : await getDashboardDeclarantUserIds(user)
  const zoneRights = await getAccessibleZoneRights(user, declarantUserIds, {collecteurUserId})
  const accessibleZones = zoneRights
    .map(serializeZoneRight)
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
  const requestedZoneCodes = splitZoneCodes(requestedZoneCodesValue)
  const selectedZones = selectZones(accessibleZones, requestedZoneCodes)

  return {
    scope: getDashboardScope(user),
    declarantUserIds,
    accessibleZones,
    requestedZoneCodes,
    selectedZones
  }
}

function getDashboardPointWhere(zoneIds, declarantUserIds, collecteurUserId = null) {
  return {
    deletedAt: null,
    ...getDeclarantPointWhere(declarantUserIds, collecteurUserId),
    ...(zoneIds.length > 0
      ? {
        zones: {
          some: {
            zoneId: {
              in: zoneIds
            }
          }
        }
      }
      : {})
  }
}

async function loadDashboardPointCorpus(
  zoneIds,
  {
    client = prisma, collecteurUserId = null,
    declarantUserIds = null,
    getCoordinatesByPointIds = getCoordsByPointIds,
    requireZoneFilter = true
  } = {}
) {
  if (requireZoneFilter && zoneIds.length === 0) {
    return {coordinatesById: new Map(), points: []}
  }

  const points = await client.pointPrelevement.findMany({
    where: getDashboardPointWhere(zoneIds, declarantUserIds, collecteurUserId),
    select: {
      id: true,
      name: true,
      usageName: true,
      flowType: true,
      nature: true,
      withdrawalType: true,
      declarants: {
        where: getExploitationDeclarantWhere(declarantUserIds, collecteurUserId),
        include: {
          usage: {
            include: {
              parent: true
            }
          },
          secondaryUsageLinks: {
            include: {
              usage: {
                include: {parent: true}
              }
            },
            orderBy: {usageId: 'asc'}
          }
        }
      }
    },
    orderBy: {
      name: 'asc'
    }
  })
  const coordinatesById = await getCoordinatesByPointIds(points.map(point => point.id))

  return {coordinatesById, points}
}

function serializeDashboardPointCorpus({coordinatesById, points}, declarantUserIds) {
  return points.map(point => ({
    id: point.id,
    name: point.name,
    usageName: point.usageName,
    flowType: point.flowType,
    nature: point.nature,
    withdrawalType: point.withdrawalType,
    coordinates: coordinatesById.get(point.id) ?? null,
    usages: getPointDashboardUsages(point, declarantUserIds)
  }))
}

export async function listDashboardPoints(zoneIds, options = {}) {
  const corpus = await loadDashboardPointCorpus(zoneIds, options)

  return serializeDashboardPointCorpus(corpus, options.declarantUserIds ?? null)
}

export async function countDashboardPoints(
  zoneIds,
  {client = prisma, declarantUserIds = null, requireZoneFilter = true} = {}
) {
  if (requireZoneFilter && zoneIds.length === 0) {
    return 0
  }

  return client.pointPrelevement.count({
    where: getDashboardPointWhere(zoneIds, declarantUserIds)
  })
}

function buildUsageDistributionFromExploitations(exploitations) {
  const countsByUsageId = new Map()
  const serializedUsagesById = new Map()

  for (const exploitation of exploitations) {
    const rootsById = new Map()

    for (const usage of getExploitationWaterUses(exploitation)) {
      const rootUsage = getRootUsage(usage)

      if (rootUsage?.id && rootUsage.dashboardVisible !== false) {
        rootsById.set(rootUsage.id, rootUsage)
      }
    }

    for (const rootUsage of rootsById.values()) {
      countsByUsageId.set(rootUsage.id, (countsByUsageId.get(rootUsage.id) ?? 0) + 1)
      serializedUsagesById.set(rootUsage.id, serializeWaterUse(rootUsage))
    }
  }

  return [...countsByUsageId.entries()]
    .map(([usageId, count]) => ({
      usage: serializedUsagesById.get(usageId),
      count
    }))
    .sort(compareUsageCodes)
}

export function buildUsageDistributionFromDashboardPoints(points) {
  return buildUsageDistributionFromExploitations(
    points.flatMap(point => point.declarants ?? [])
  )
}

export async function getUsageDistribution(
  zoneIds,
  {client = prisma, declarantUserIds = null} = {}
) {
  if (zoneIds.length === 0) {
    return []
  }

  const exploitations = await client.declarantPointPrelevement.findMany({
    where: {
      ...getExploitationDeclarantWhere(declarantUserIds),
      pointPrelevement: {
        deletedAt: null,
        zones: {
          some: {
            zoneId: {
              in: zoneIds
            }
          }
        }
      }
    },
    select: {
      usage: {
        include: {parent: true}
      },
      secondaryUsageLinks: {
        include: {
          usage: {
            include: {parent: true}
          }
        },
        orderBy: {usageId: 'asc'}
      }
    }
  })

  return buildUsageDistributionFromExploitations(exploitations)
}

export async function getDashboardTerritoryPointData({
  declarantUserIds,
  includePoints,
  shouldLoadActivityPoints,
  zoneIds
}, {
  countPoints = countDashboardPoints,
  getDistribution = getUsageDistribution,
  listPoints = listDashboardPoints,
  loadPointCorpus = loadDashboardPointCorpus
} = {}) {
  if (!includePoints) {
    const [totalPoints, usageDistribution] = await Promise.all([
      countPoints(zoneIds, {declarantUserIds}),
      getDistribution(zoneIds, {declarantUserIds})
    ])

    return {
      activityPoints: shouldLoadActivityPoints ? [] : null,
      points: [],
      totalPoints,
      usageDistribution
    }
  }

  const [pointCorpus, activityPoints] = await Promise.all([
    loadPointCorpus(zoneIds, {declarantUserIds}),
    shouldLoadActivityPoints
      ? listPoints([], {declarantUserIds, requireZoneFilter: false})
      : Promise.resolve(null)
  ])
  const points = serializeDashboardPointCorpus(pointCorpus, declarantUserIds)

  return {
    activityPoints,
    points,
    totalPoints: points.length,
    usageDistribution: buildUsageDistributionFromDashboardPoints(pointCorpus.points)
  }
}

export async function getDeclarationPeriodOptions(
  zoneIds,
  periodType,
  {client = prisma, declarantUserIds = null} = {}
) {
  const currentPeriodKey = getDeclarationPeriodKey(periodType)

  if (zoneIds.length === 0) {
    return [serializeDeclarationPeriodOption(periodType, currentPeriodKey)]
  }

  const chunks = await client.chunk.findMany({
    where: {
      pointPrelevementId: {
        not: null
      },
      instructionStatus: {
        not: 'REJECTED'
      },
      ...getDashboardChunkDeclarantWhere(declarantUserIds),
      source: getCompletedDashboardSourceWhere(),
      pointPrelevement: {
        deletedAt: null,
        zones: {
          some: {
            zoneId: {
              in: zoneIds
            }
          }
        }
      }
    },
    select: {
      minDate: true,
      maxDate: true,
      usage: {
        include: {
          parent: true
        }
      }
    }
  })

  const periodKeys = new Set([currentPeriodKey])

  for (const chunk of chunks) {
    if (!isDashboardVisibleUsage(chunk.usage)) {
      continue
    }

    for (const periodKey of getDeclarationPeriodKeysBetween(periodType, chunk.minDate, chunk.maxDate)) {
      if (periodKey <= currentPeriodKey) {
        periodKeys.add(periodKey)
      }
    }
  }

  return [...periodKeys]
    .sort()
    .reverse()
    .map(periodKey => serializeDeclarationPeriodOption(periodType, periodKey))
}

export async function getRegisteredPrelevementsByUsage(
  zoneIds,
  periodType,
  periodKey,
  {client = prisma, declarantUserIds = null} = {}
) {
  if (zoneIds.length === 0) {
    return []
  }

  const pointIdsByUsageId = new Map()
  const usagesById = new Map()

  const exploitations = await client.declarantPointPrelevement.findMany({
    where: {
      ...getExploitationDeclarantWhere(declarantUserIds),
      pointPrelevement: {
        deletedAt: null,
        zones: {
          some: {
            zoneId: {
              in: zoneIds
            }
          }
        }
      }
    },
    select: {
      pointPrelevementId: true,
      usage: {
        include: {
          parent: true
        }
      },
      secondaryUsageLinks: {
        include: {
          usage: {
            include: {parent: true}
          }
        },
        orderBy: {usageId: 'asc'}
      }
    }
  })

  for (const exploitation of exploitations) {
    for (const usage of getExploitationWaterUses(exploitation)) {
      addPointToUsage(
        pointIdsByUsageId,
        usagesById,
        usage,
        exploitation.pointPrelevementId
      )
    }
  }

  const periodStart = getDeclarationPeriodStart(periodType, periodKey)
  const nextPeriodStart = getNextDeclarationPeriodStart(periodType, periodKey)
  const declaredPointIdsByUsageId = new Map()

  const chunks = await client.chunk.findMany({
    where: {
      pointPrelevementId: {
        not: null
      },
      minDate: {
        lt: nextPeriodStart
      },
      maxDate: {
        gte: periodStart
      },
      instructionStatus: {
        not: 'REJECTED'
      },
      ...getDashboardChunkDeclarantWhere(declarantUserIds),
      source: getCompletedDashboardSourceWhere(),
      pointPrelevement: {
        deletedAt: null,
        zones: {
          some: {
            zoneId: {
              in: zoneIds
            }
          }
        }
      }
    },
    select: {
      pointPrelevementId: true,
      usage: {
        include: {
          parent: true
        }
      }
    }
  })

  for (const chunk of chunks) {
    const usageId = addPointToUsage(
      pointIdsByUsageId,
      usagesById,
      chunk.usage,
      chunk.pointPrelevementId
    )

    if (!usageId) {
      continue
    }

    if (!declaredPointIdsByUsageId.has(usageId)) {
      declaredPointIdsByUsageId.set(usageId, new Set())
    }

    declaredPointIdsByUsageId.get(usageId).add(chunk.pointPrelevementId)
  }

  return [...pointIdsByUsageId.entries()]
    .map(([usageId, pointIds]) => {
      const declaredPointIds = declaredPointIdsByUsageId.get(usageId) ?? new Set()
      const declaredPointsCount = declaredPointIds.size
      const totalPointsCount = pointIds.size

      return {
        usage: usagesById.get(usageId),
        declaredPointsCount,
        missingPointsCount: Math.max(totalPointsCount - declaredPointsCount, 0),
        totalPointsCount
      }
    })
    .filter(item => item.usage && item.totalPointsCount > 0)
    .sort(compareUsageCodes)
}

export async function getVolumeYearOptions(zoneIds, waterBodyTypes, {client = prisma} = {}) {
  const currentYear = new Date().getUTCFullYear()

  if (zoneIds.length === 0) {
    return [currentYear]
  }

  const rows = await client.$queryRaw(Prisma.sql`
    SELECT DISTINCT EXTRACT(YEAR FROM v."periodStart")::int AS year
    FROM "ChunkValue" v
    JOIN "Chunk" c ON c.id = v."chunkId"
    JOIN "Source" s ON s.id = c."sourceId"
    JOIN "PointPrelevement" p ON p.id = c."pointPrelevementId"
    JOIN "SandreWaterUse" usage ON usage.id = c."usageId"
    LEFT JOIN "SandreWaterUse" parent_usage ON parent_usage.id = usage."parentId"
    WHERE v."metricTypeCode" IN (${Prisma.join(VOLUME_METRIC_TYPE_CODES)})
      AND v.value <> 0
      AND EXTRACT(YEAR FROM v."periodStart")::int <= ${currentYear}
      AND c."pointPrelevementId" IS NOT NULL
      AND c."instructionStatus" <> 'REJECTED'
      ${COMPLETED_DASHBOARD_SOURCE_SQL}
      AND p."deletedAt" IS NULL
      AND EXISTS (
        SELECT 1
        FROM "PointPrelevementZone" ppz
        WHERE ppz."pointPrelevementId" = p.id
          AND ppz."zoneId" IN (${getZoneIdsSql(zoneIds)})
      )
      ${getWaterBodyTypesSql(waterBodyTypes)}
      ${getVisibleUsageSql()}
    ORDER BY year DESC
  `)

  const yearOptions = [
    ...new Set([
      currentYear,
      ...rows.map(row => Number(row.year)).filter(Number.isInteger)
    ])
  ].filter(year => year <= currentYear)

  return yearOptions.sort((a, b) => b - a)
}

function buildEmptyVolumeChart(metric, selectedYear) {
  return {
    key: metric.key,
    metricTypeCode: metric.metricTypeCode,
    flowType: metric.flowType,
    title: metric.title,
    unit: 'm³',
    usages: [],
    months: Array.from({length: 12}, (_item, index) =>
      serializeVolumeMonth(selectedYear, index + 1))
  }
}

export function buildVolumeCharts(rows, selectedYear, expectedUsages = []) {
  const chartsByFlowType = new Map(
    VOLUME_CHART_METRICS.map(metric => [
      metric.flowType,
      buildEmptyVolumeChart(metric, selectedYear)
    ])
  )
  const usageTotalsByFlowType = new Map(
    VOLUME_CHART_METRICS.map(metric => [metric.flowType, new Map()])
  )
  const usagesByFlowTypeAndId = new Map(
    VOLUME_CHART_METRICS.map(metric => [metric.flowType, new Map()])
  )

  for (const item of expectedUsages) {
    const usageTotals = usageTotalsByFlowType.get(item.flowType)
    const usagesById = usagesByFlowTypeAndId.get(item.flowType)
    const {usage} = item

    if (!usageTotals || !usagesById || !usage?.id) {
      continue
    }

    usagesById.set(usage.id, usage)
    usageTotals.set(usage.id, usageTotals.get(usage.id) ?? 0)
  }

  for (const row of rows) {
    const chart = chartsByFlowType.get(row.flowType)
    const usageTotals = usageTotalsByFlowType.get(row.flowType)
    const usagesById = usagesByFlowTypeAndId.get(row.flowType)

    if (!chart || !usageTotals || !usagesById) {
      continue
    }

    const month = chart.months[Number(row.month) - 1]
    const usage = serializeUsageFromVolumeRow(row)
    const volume = Number(row.volume) || 0

    if (!month) {
      continue
    }

    usagesById.set(usage.id, usage)
    usageTotals.set(usage.id, (usageTotals.get(usage.id) ?? 0) + volume)

    if (volume === 0) {
      continue
    }

    month.usages.push({
      usage,
      volume
    })
    month.total += volume
  }

  for (const metric of VOLUME_CHART_METRICS) {
    const chart = chartsByFlowType.get(metric.flowType)
    const usageTotals = usageTotalsByFlowType.get(metric.flowType)
    const usagesById = usagesByFlowTypeAndId.get(metric.flowType)

    chart.usages = [...usageTotals.entries()]
      .map(([usageId, total]) => ({
        usage: usagesById.get(usageId),
        total,
        hasData: total > 0
      }))
      .filter(item => item.usage)
      .sort(compareUsageCodes)

    for (const month of chart.months) {
      month.usages = month.usages
        .map(item => ({
          ...item,
          percentage: month.total > 0 ? item.volume / month.total * 100 : 0
        }))
        .sort(compareUsageCodes)
    }
  }

  return Object.fromEntries(
    VOLUME_CHART_METRICS.map(metric => [metric.key, chartsByFlowType.get(metric.flowType)])
  )
}

async function getExpectedVolumeUsages(
  zoneIds,
  selectedYear,
  selectedWaterBodyTypes,
  {client = prisma} = {}
) {
  if (zoneIds.length === 0) {
    return []
  }

  const yearStart = new Date(Date.UTC(selectedYear, 0, 1))
  const nextYearStart = new Date(Date.UTC(selectedYear + 1, 0, 1))
  const exploitations = await client.declarantPointPrelevement.findMany({
    where: {
      status: {
        not: 'ABANDONNEE'
      },
      ...getExploitationDeclarantWhere(null),
      AND: [
        {
          OR: [
            {startDate: null},
            {startDate: {lt: nextYearStart}}
          ]
        },
        {
          OR: [
            {endDate: null},
            {endDate: {gte: yearStart}}
          ]
        }
      ],
      pointPrelevement: {
        deletedAt: null,
        zones: {
          some: {
            zoneId: {
              in: zoneIds
            }
          }
        },
        ...(selectedWaterBodyTypes === null
          ? {}
          : {
            waterBodyType: {
              in: selectedWaterBodyTypes
            }
          })
      }
    },
    select: {
      pointPrelevement: {
        select: {
          flowType: true
        }
      },
      usage: {
        include: {
          parent: true
        }
      }
    }
  })

  const usagesByFlowTypeAndId = new Map()

  for (const exploitation of exploitations) {
    const {flowType} = exploitation.pointPrelevement
    const usage = getRootUsage(exploitation.usage)

    if (!usage?.id || usage.dashboardVisible === false) {
      continue
    }

    usagesByFlowTypeAndId.set(`${flowType}:${usage.id}`, {
      flowType,
      usage: serializeWaterUse(usage)
    })
  }

  return [...usagesByFlowTypeAndId.values()]
}

export async function getVolumesByUsage(
  zoneIds,
  selectedYear,
  selectedWaterBodyTypes,
  {client = prisma} = {}
) {
  if (zoneIds.length === 0) {
    return buildVolumeCharts([], selectedYear)
  }

  const [rows, expectedUsages] = await Promise.all([
    client.$queryRaw(Prisma.sql`
      SELECT
        ${VOLUME_FLOW_TYPE_SQL} AS "flowType",
        EXTRACT(MONTH FROM v."periodStart")::int AS month,
        COALESCE(parent_usage.id, usage.id) AS "usageId",
        COALESCE(parent_usage.code, usage.code) AS "usageCode",
        COALESCE(parent_usage.mnemonic, usage.mnemonic) AS "usageMnemonic",
        COALESCE(parent_usage.label, usage.label) AS "usageLabel",
        COALESCE(parent_usage.color, usage.color) AS "usageColor",
        SUM(v.value)::float8 AS volume
      FROM "ChunkValue" v
      JOIN "Chunk" c ON c.id = v."chunkId"
      JOIN "Source" s ON s.id = c."sourceId"
      JOIN "PointPrelevement" p ON p.id = c."pointPrelevementId"
      JOIN "SandreWaterUse" usage ON usage.id = c."usageId"
      LEFT JOIN "SandreWaterUse" parent_usage ON parent_usage.id = usage."parentId"
      WHERE v."metricTypeCode" IN (${Prisma.join(VOLUME_METRIC_TYPE_CODES)})
        AND v."periodStart" >= ${new Date(Date.UTC(selectedYear, 0, 1))}
        AND v."periodStart" < ${new Date(Date.UTC(selectedYear + 1, 0, 1))}
        AND c."pointPrelevementId" IS NOT NULL
        AND c."instructionStatus" <> 'REJECTED'
        ${COMPLETED_DASHBOARD_SOURCE_SQL}
        AND p."deletedAt" IS NULL
        AND EXISTS (
          SELECT 1
          FROM "PointPrelevementZone" ppz
          WHERE ppz."pointPrelevementId" = p.id
            AND ppz."zoneId" IN (${getZoneIdsSql(zoneIds)})
        )
        ${getWaterBodyTypesSql(selectedWaterBodyTypes)}
        ${getVisibleUsageSql()}
      GROUP BY 1, 2, 3, 4, 5, 6, 7
      ORDER BY month ASC, "usageCode" ASC
    `),
    getExpectedVolumeUsages(zoneIds, selectedYear, selectedWaterBodyTypes, {client})
  ])

  return buildVolumeCharts(rows, selectedYear, expectedUsages)
}

export async function buildDashboardMapPayload({
  requestedZoneCodes,
  scope,
  user
}, {
  getMapPointScope = getDashboardMapPointScope,
  listPoints = listDashboardPoints,
  resolveZoneSelection = resolveDashboardZoneSelection
} = {}) {
  const mapScope = parseDashboardMapScope(scope)
  const pointScope = getMapPointScope(user)

  if (mapScope === 'activity') {
    const dashboardScope = getDashboardScope(user)
    if (dashboardScope === 'TERRITORY') {
      throw createHttpError(403, 'Le périmètre activity est réservé aux déclarants et collecteurs.')
    }

    const points = await listPoints([], {
      ...pointScope,
      requireZoneFilter: false
    })

    return {
      scope: mapScope,
      selectedZoneCodes: [],
      unknownZoneCodes: [],
      capabilities: getDashboardMapCapabilities(user),
      points
    }
  }

  const selection = await resolveZoneSelection(user, requestedZoneCodes, pointScope)
  const zoneIds = selection.selectedZones.map(zone => zone.id)
  const points = await listPoints(zoneIds, {
    ...pointScope
  })

  return {
    scope: mapScope,
    selectedZoneCodes: selection.selectedZones.map(zone => zone.code),
    unknownZoneCodes: selection.requestedZoneCodes.filter(code =>
      !selection.accessibleZones.some(zone => zone.code === code)
    ),
    capabilities: getDashboardMapCapabilities(user, selection.selectedZones),
    points
  }
}

export async function getDashboardMapHandler(req, res) {
  const payload = await withRequestPerformancePhase(
    'dashboard_map',
    () => buildDashboardMapPayload({
      requestedZoneCodes: req.query.zones,
      scope: req.query.scope,
      user: req.user
    })
  )

  res.json(payload)
}

export async function getDashboardTerritoryHandler(req, res) {
  const perf = createDashboardPerfLogger()
  const declarantUserIds = await withRequestPerformancePhase(
    'dashboard_scope',
    () => perf.time('declarant-user-ids', () => getDashboardDeclarantUserIds(req.user))
  )
  const scope = getDashboardScope(req.user)
  const zoneRights = await perf.time('accessible-zone-rights', () =>
    getAccessibleZoneRights(req.user, declarantUserIds))
  const accessibleZones = zoneRights
    .map(serializeZoneRight)
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
  const requestedZoneCodes = splitZoneCodes(req.query.zones)
  const selectedZones = selectZones(accessibleZones, requestedZoneCodes)
  const zoneIds = selectedZones.map(zone => zone.id)
  const selectedWaterBodyTypes = parseWaterBodyTypes(
    req.query.waterBodyTypes,
    req.query.waterBodyType
  )
  const selectedPeriodType = parseDeclarationPeriodType(req.query.periodType)
  const includePoints = parseDashboardIncludePoints(req.query.includePoints)
  const shouldLoadActivityPoints = scope === 'DECLARANT' || scope === 'COLLECTOR'
  const declarationStatsDeclarantUserIds = shouldLoadActivityPoints ? null : declarantUserIds
  const [pointData, periodOptions, volumeYearOptions] = await Promise.all([
    withRequestPerformancePhase(
      'dashboard_points',
      () => perf.time('point-data', () => getDashboardTerritoryPointData({
        declarantUserIds,
        includePoints,
        shouldLoadActivityPoints,
        zoneIds
      }))
    ),
    perf.time('declaration-period-options', () =>
      getDeclarationPeriodOptions(zoneIds, selectedPeriodType, {
        declarantUserIds: declarationStatsDeclarantUserIds
      })),
    perf.time('volume-year-options', () => getVolumeYearOptions(zoneIds, selectedWaterBodyTypes))
  ])
  const currentPeriodKey = getDeclarationPeriodKey(selectedPeriodType)
  const requestedPeriodKey = parseDeclarationPeriodKey(req.query.period, selectedPeriodType)
  const selectedPeriodKey = periodOptions.some(option => option.value === requestedPeriodKey)
    ? requestedPeriodKey
    : currentPeriodKey
  const currentYear = new Date().getUTCFullYear()
  const requestedYear = parseYear(req.query.year)
  const selectedVolumeYear = volumeYearOptions.includes(requestedYear)
    ? requestedYear
    : currentYear
  const [registeredPrelevementsByUsage, volumeCharts] = await Promise.all([
    perf.time('registered-prelevements', () =>
      getRegisteredPrelevementsByUsage(
        zoneIds,
        selectedPeriodType,
        selectedPeriodKey,
        {declarantUserIds: declarationStatsDeclarantUserIds}
      )),
    perf.time('volumes-by-usage', () =>
      getVolumesByUsage(
        zoneIds,
        selectedVolumeYear,
        selectedWaterBodyTypes
      ))
  ])

  const payload = {
    scope,
    zones: accessibleZones,
    selectedZoneCodes: selectedZones.map(zone => zone.code),
    unknownZoneCodes: requestedZoneCodes.filter(code =>
      !accessibleZones.some(zone => zone.code === code)
    ),
    metrics: {
      totalPoints: pointData.totalPoints,
      usageDistribution: pointData.usageDistribution
    },
    registeredPrelevements: {
      selectedPeriodType,
      selectedPeriod: selectedPeriodKey,
      periodOptions,
      byUsage: registeredPrelevementsByUsage
    },
    volumesByUsage: {
      selectedYear: selectedVolumeYear,
      yearOptions: volumeYearOptions,
      selectedWaterBodyTypes: selectedWaterBodyTypes ?? WATER_BODY_TYPE_VALUES,
      charts: volumeCharts
    },
    activityPoints: pointData.activityPoints,
    points: pointData.points
  }

  perf.log(payload)

  res.json(payload)
}
