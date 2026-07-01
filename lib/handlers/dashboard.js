import {Prisma} from '@prisma/client'

import {prisma} from '../../db/prisma.js'
import {METRIC_TYPE_CODES} from '../constants/metric-type-codes.js'
import {getPreleveurIdsForCollecteur} from '../models/exploitation.js'
import {activeWindowWhere} from '../models/point-prelevement.js'
import {decoratePointsPrelevement} from '../services/point-prelevement.js'
import {serializeWaterUse} from '../services/sandre-water-uses.js'

const WATER_BODY_TYPE_VALUES = ['SURFACE', 'SUPERFICIELLE', 'SOUTERRAIN', 'TRANSITION']
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
    metricTypeCode: METRIC_TYPE_CODES.VOLUME_PRELEVE,
    title: 'Volumes prélevés par usage'
  },
  {
    key: 'discharged',
    metricTypeCode: METRIC_TYPE_CODES.VOLUME_REJETE,
    title: 'Volumes rejetés par usage'
  }
]

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

function getMonthKey(date = new Date()) {
  const year = date.getUTCFullYear()
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0')

  return `${year}-${month}`
}

function parseMonthKey(value) {
  const monthKey = String(Array.isArray(value) ? value[0] : value ?? '')

  if (!/^\d{4}-\d{2}$/.test(monthKey)) {
    return null
  }

  const month = Number(monthKey.slice(5, 7))

  return month >= 1 && month <= 12 ? monthKey : null
}

function parseYear(value) {
  const year = Number(Array.isArray(value) ? value[0] : value)
  const currentYear = new Date().getUTCFullYear()

  if (!Number.isInteger(year) || year < 2000 || year > currentYear) {
    return null
  }

  return year
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
      rawValues.filter(value => WATER_BODY_TYPES.has(value))
    )
  ]
}

function getMonthStart(monthKey) {
  const [year, month] = monthKey.split('-').map(Number)

  return new Date(Date.UTC(year, month - 1, 1))
}

function getNextMonthStart(monthKey) {
  const [year, month] = monthKey.split('-').map(Number)

  return new Date(Date.UTC(year, month, 1))
}

function getMonthKeysBetween(startDate, endDate) {
  if (!startDate || !endDate) {
    return []
  }

  const monthKeys = []
  const start = getMonthStart(getMonthKey(startDate))
  const end = getMonthStart(getMonthKey(endDate)).getTime()

  for (
    let cursor = start.getTime();
    cursor <= end;
    cursor = Date.UTC(new Date(cursor).getUTCFullYear(), new Date(cursor).getUTCMonth() + 1, 1)
  ) {
    monthKeys.push(getMonthKey(new Date(cursor)))
  }

  return monthKeys
}

function capitalize(value) {
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value
}

const monthFormatter = new Intl.DateTimeFormat('fr-FR', {
  month: 'long',
  timeZone: 'UTC',
  year: 'numeric'
})

function serializeMonthOption(monthKey) {
  return {
    value: monthKey,
    label: capitalize(monthFormatter.format(getMonthStart(monthKey)))
  }
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
  if (!declarantUserIds) {
    return (point.usages ?? []).filter(isDashboardVisibleUsage)
  }

  const declarantUserIdsSet = new Set(declarantUserIds)
  const usagesById = new Map()

  for (const exploitation of point.declarants ?? []) {
    if (!declarantUserIdsSet.has(exploitation.declarantUserId)) {
      continue
    }

    const rootUsage = getRootUsage(exploitation.usage)

    if (!rootUsage?.id || rootUsage.dashboardVisible === false) {
      continue
    }

    usagesById.set(rootUsage.id, serializeWaterUse(rootUsage))
  }

  return [...usagesById.values()]
}

function serializeZoneRight(right) {
  return {
    id: right.zone.id,
    type: right.zone.type,
    code: right.zone.code,
    name: right.zone.name,
    isAdmin: right.isAdmin,
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

function getDeclarantPointWhere(declarantUserIds) {
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

function getExploitationDeclarantWhere(declarantUserIds) {
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

async function getAccessibleZoneRights(user, declarantUserIds = null) {
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
      startDate: null,
      endDate: null
    }))
  }

  if (user.role === 'DECLARANT') {
    const zones = await prisma.zone.findMany({
      where: {
        pointPrelevementZones: {
          some: {
            pointPrelevement: {
              deletedAt: null,
              ...getDeclarantPointWhere(declarantUserIds)
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

async function listDashboardPoints(zoneIds, user, {declarantUserIds = null} = {}) {
  if (zoneIds.length === 0) {
    return []
  }

  const points = await prisma.pointPrelevement.findMany({
    where: {
      deletedAt: null,
      ...getDeclarantPointWhere(declarantUserIds),
      zones: {
        some: {
          zoneId: {
            in: zoneIds
          }
        }
      }
    },
    include: {
      zones: {
        include: {
          zone: true
        }
      },
      declarants: {
        include: {
          usage: {
            include: {
              parent: true
            }
          }
        }
      }
    },
    orderBy: {
      name: 'asc'
    }
  })

  const decoratedPoints = await decoratePointsPrelevement(points, {user})

  return decoratedPoints.map(point => ({
    ...point,
    usages: getPointDashboardUsages(point, declarantUserIds)
  }))
}

async function getUsageDistribution(zoneIds, {declarantUserIds = null} = {}) {
  if (zoneIds.length === 0) {
    return []
  }

  const rows = await prisma.declarantPointPrelevement.groupBy({
    by: ['usageId'],
    where: {
      usageId: {
        not: null
      },
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
    _count: {
      _all: true
    }
  })

  const usageIds = rows.map(row => row.usageId).filter(Boolean)
  const usages = usageIds.length === 0
    ? []
    : await prisma.sandreWaterUse.findMany({
      where: {
        id: {
          in: usageIds
        }
      },
      include: {
        parent: true
      }
    })

  const usagesById = new Map(usages.map(usage => [usage.id, usage]))
  const countsByUsageId = new Map()
  const serializedUsagesById = new Map()

  for (const row of rows) {
    const usage = usagesById.get(row.usageId)
    const rootUsage = getRootUsage(usage)

    if (!rootUsage?.id || rootUsage.dashboardVisible === false) {
      continue
    }

    countsByUsageId.set(rootUsage.id, (countsByUsageId.get(rootUsage.id) ?? 0) + row._count._all)
    serializedUsagesById.set(rootUsage.id, serializeWaterUse(rootUsage))
  }

  return [...countsByUsageId.entries()]
    .map(([usageId, count]) => ({
      usage: serializedUsagesById.get(usageId),
      count
    }))
    .sort(compareUsageCodes)
}

async function getDeclarationMonthOptions(zoneIds, {declarantUserIds = null} = {}) {
  const currentMonthKey = getMonthKey()

  if (zoneIds.length === 0) {
    return [serializeMonthOption(currentMonthKey)]
  }

  const chunks = await prisma.chunk.findMany({
    where: {
      pointPrelevementId: {
        not: null
      },
      source: {
        type: 'DECLARATION',
        status: 'COMPLETED',
        ...getDeclarationSourceWhere(declarantUserIds)
      },
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

  const monthKeys = new Set([currentMonthKey])

  for (const chunk of chunks) {
    if (!isDashboardVisibleUsage(chunk.usage)) {
      continue
    }

    for (const monthKey of getMonthKeysBetween(chunk.minDate, chunk.maxDate)) {
      if (monthKey <= currentMonthKey) {
        monthKeys.add(monthKey)
      }
    }
  }

  return [...monthKeys]
    .sort()
    .reverse()
    .map(serializeMonthOption)
}

async function getRegisteredPrelevementsByUsage(zoneIds, monthKey, {declarantUserIds = null} = {}) {
  if (zoneIds.length === 0) {
    return []
  }

  const pointIdsByUsageId = new Map()
  const usagesById = new Map()

  const exploitations = await prisma.declarantPointPrelevement.findMany({
    where: {
      usageId: {
        not: null
      },
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
      }
    }
  })

  for (const exploitation of exploitations) {
    addPointToUsage(
      pointIdsByUsageId,
      usagesById,
      exploitation.usage,
      exploitation.pointPrelevementId
    )
  }

  const monthStart = getMonthStart(monthKey)
  const nextMonthStart = getNextMonthStart(monthKey)
  const declaredPointIdsByUsageId = new Map()

  const chunks = await prisma.chunk.findMany({
    where: {
      pointPrelevementId: {
        not: null
      },
      minDate: {
        lt: nextMonthStart
      },
      maxDate: {
        gte: monthStart
      },
      source: {
        type: 'DECLARATION',
        status: 'COMPLETED',
        ...getDeclarationSourceWhere(declarantUserIds)
      },
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

async function getVolumeYearOptions(zoneIds, waterBodyTypes) {
  const currentYear = new Date().getUTCFullYear()

  if (zoneIds.length === 0) {
    return [currentYear]
  }

  const rows = await prisma.$queryRaw`
    SELECT DISTINCT EXTRACT(YEAR FROM v."periodStart")::int AS year
    FROM "ChunkValue" v
    JOIN "Chunk" c ON c.id = v."chunkId"
    JOIN "Source" s ON s.id = c."sourceId"
    JOIN "PointPrelevement" p ON p.id = c."pointPrelevementId"
    JOIN "SandreWaterUse" usage ON usage.id = c."usageId"
    LEFT JOIN "SandreWaterUse" parent_usage ON parent_usage.id = usage."parentId"
    WHERE v."metricTypeCode" = ${METRIC_TYPE_CODES.VOLUME_PRELEVE}
      AND v.value <> 0
      AND EXTRACT(YEAR FROM v."periodStart")::int <= ${currentYear}
      AND c."pointPrelevementId" IS NOT NULL
      AND c."instructionStatus" <> 'REJECTED'
      AND s.type = 'DECLARATION'
      AND s.status = 'COMPLETED'
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
  `

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
    title: metric.title,
    unit: 'm³',
    usages: [],
    months: Array.from({length: 12}, (_item, index) =>
      serializeVolumeMonth(selectedYear, index + 1))
  }
}

function buildVolumeCharts(rows, selectedYear) {
  const chartsByMetricCode = new Map(
    VOLUME_CHART_METRICS.map(metric => [
      metric.metricTypeCode,
      buildEmptyVolumeChart(metric, selectedYear)
    ])
  )
  const usageTotalsByMetricCode = new Map(
    VOLUME_CHART_METRICS.map(metric => [metric.metricTypeCode, new Map()])
  )
  const usagesByMetricAndId = new Map(
    VOLUME_CHART_METRICS.map(metric => [metric.metricTypeCode, new Map()])
  )

  for (const row of rows) {
    const chart = chartsByMetricCode.get(row.metricTypeCode)
    const usageTotals = usageTotalsByMetricCode.get(row.metricTypeCode)
    const usagesById = usagesByMetricAndId.get(row.metricTypeCode)

    if (!chart || !usageTotals || !usagesById) {
      continue
    }

    const month = chart.months[Number(row.month) - 1]
    const usage = serializeUsageFromVolumeRow(row)
    const volume = Number(row.volume) || 0

    if (!month || volume === 0) {
      continue
    }

    usagesById.set(usage.id, usage)
    usageTotals.set(usage.id, (usageTotals.get(usage.id) ?? 0) + volume)
    month.usages.push({
      usage,
      volume
    })
    month.total += volume
  }

  for (const metric of VOLUME_CHART_METRICS) {
    const chart = chartsByMetricCode.get(metric.metricTypeCode)
    const usageTotals = usageTotalsByMetricCode.get(metric.metricTypeCode)
    const usagesById = usagesByMetricAndId.get(metric.metricTypeCode)

    chart.usages = [...usageTotals.entries()]
      .map(([usageId, total]) => ({
        usage: usagesById.get(usageId),
        total
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
    VOLUME_CHART_METRICS.map(metric => [metric.key, chartsByMetricCode.get(metric.metricTypeCode)])
  )
}

async function getVolumesByUsage(zoneIds, selectedYear, selectedWaterBodyTypes) {
  if (zoneIds.length === 0) {
    return buildVolumeCharts([], selectedYear)
  }

  const rows = await prisma.$queryRaw`
    SELECT
      v."metricTypeCode" AS "metricTypeCode",
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
    WHERE v."metricTypeCode" IN (${Prisma.join(VOLUME_CHART_METRICS.map(metric => metric.metricTypeCode))})
      AND v."periodStart" >= ${new Date(Date.UTC(selectedYear, 0, 1))}
      AND v."periodStart" < ${new Date(Date.UTC(selectedYear + 1, 0, 1))}
      AND c."pointPrelevementId" IS NOT NULL
      AND c."instructionStatus" <> 'REJECTED'
      AND s.type = 'DECLARATION'
      AND s.status = 'COMPLETED'
      AND p."deletedAt" IS NULL
      AND EXISTS (
        SELECT 1
        FROM "PointPrelevementZone" ppz
        WHERE ppz."pointPrelevementId" = p.id
          AND ppz."zoneId" IN (${getZoneIdsSql(zoneIds)})
      )
      ${getWaterBodyTypesSql(selectedWaterBodyTypes)}
      ${getVisibleUsageSql()}
    GROUP BY
      v."metricTypeCode",
      EXTRACT(MONTH FROM v."periodStart")::int,
      COALESCE(parent_usage.id, usage.id),
      COALESCE(parent_usage.code, usage.code),
      COALESCE(parent_usage.mnemonic, usage.mnemonic),
      COALESCE(parent_usage.label, usage.label),
      COALESCE(parent_usage.color, usage.color)
    ORDER BY month ASC, "usageCode" ASC
  `

  return buildVolumeCharts(rows, selectedYear)
}

export async function getDashboardTerritoryHandler(req, res) {
  const declarantUserIds = await getDashboardDeclarantUserIds(req.user)
  const scope = getDashboardScope(req.user)
  const zoneRights = await getAccessibleZoneRights(req.user, declarantUserIds)
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
  const [points, usageDistribution, monthOptions, volumeYearOptions] = await Promise.all([
    listDashboardPoints(zoneIds, req.user, {declarantUserIds}),
    getUsageDistribution(zoneIds, {declarantUserIds}),
    getDeclarationMonthOptions(zoneIds, {declarantUserIds}),
    getVolumeYearOptions(zoneIds, selectedWaterBodyTypes)
  ])
  const currentMonthKey = getMonthKey()
  const requestedMonthKey = parseMonthKey(req.query.month)
  const selectedMonthKey = monthOptions.some(option => option.value === requestedMonthKey)
    ? requestedMonthKey
    : currentMonthKey
  const currentYear = new Date().getUTCFullYear()
  const requestedYear = parseYear(req.query.year)
  const selectedVolumeYear = volumeYearOptions.includes(requestedYear)
    ? requestedYear
    : currentYear
  const registeredPrelevementsByUsage = await getRegisteredPrelevementsByUsage(
    zoneIds,
    selectedMonthKey,
    {declarantUserIds}
  )
  const volumeCharts = await getVolumesByUsage(
    zoneIds,
    selectedVolumeYear,
    selectedWaterBodyTypes
  )

  res.json({
    scope,
    zones: accessibleZones,
    selectedZoneCodes: selectedZones.map(zone => zone.code),
    unknownZoneCodes: requestedZoneCodes.filter(code =>
      !accessibleZones.some(zone => zone.code === code)
    ),
    metrics: {
      totalPoints: points.length,
      usageDistribution
    },
    registeredPrelevements: {
      selectedMonth: selectedMonthKey,
      monthOptions,
      byUsage: registeredPrelevementsByUsage
    },
    volumesByUsage: {
      selectedYear: selectedVolumeYear,
      yearOptions: volumeYearOptions,
      selectedWaterBodyTypes: selectedWaterBodyTypes ?? WATER_BODY_TYPE_VALUES,
      charts: volumeCharts
    },
    points
  })
}
