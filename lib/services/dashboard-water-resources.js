import {Prisma} from '@prisma/client'

import {prisma} from '../../db/prisma.js'
import {withRequestPerformancePhase} from '../util/request-performance.js'
import {
  getMonitoringStationDetails,
  getMonitoringStationSyncStatus
} from './monitoring-stations.js'
import {
  buildPiezometryIpsFromMonthlyValues,
  PIEZOMETRY_IPS
} from './piezometry-index.js'

const PIEZOMETRY_PERIODS = new Set([
  'week',
  'month',
  'year',
  'five-years',
  'ten-years',
  'twenty-years'
])
const HISTORICAL_PIEZOMETRY_PERIODS = new Set([
  'five-years',
  'ten-years',
  'twenty-years'
])
const FLOW_PERIODS = new Set(['week', 'month', 'year'])

function subtractDays(date, days) {
  const result = new Date(date)
  result.setUTCDate(result.getUTCDate() - days)
  return result
}

function subtractYears(date, years) {
  const result = new Date(date)
  result.setUTCFullYear(result.getUTCFullYear() - years)
  return result
}

function startOfUTCDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function startOfUTCMonth(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
}

function startOfUTCWeek(date) {
  const start = startOfUTCDay(date)
  const daysSinceMonday = (start.getUTCDay() + 6) % 7
  start.setUTCDate(start.getUTCDate() - daysSinceMonday)
  return start
}

function subtractUTCMonths(date, months) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - months, 1))
}

function dateKey(value) {
  return new Date(value).toISOString().slice(0, 10)
}

function getCoordinates(station) {
  return Number.isFinite(station.longitude) && Number.isFinite(station.latitude)
    ? {type: 'Point', coordinates: [station.longitude, station.latitude]}
    : null
}

function getDisplayLabel(associations, station) {
  const labels = [...new Set(associations.map(item => item.label).filter(Boolean))]
  return labels.length === 1 ? labels[0] : station.providerLabel || station.stationCode
}

function serializeStation(group) {
  const {station, associations} = group

  return {
    id: station.id,
    type: station.type,
    label: getDisplayLabel(associations, station),
    providerLabel: station.providerLabel,
    stationCode: station.stationCode,
    bssId: station.bssId,
    siteCode: station.siteCode,
    coordinates: getCoordinates(station),
    details: getMonitoringStationDetails(station),
    zones: associations.map(association => ({
      id: association.zone.id,
      code: association.zone.code,
      name: association.zone.name
    })),
    sync: {
      status: getMonitoringStationSyncStatus(station),
      lastSuccessAt: station.lastSyncSuccessAt,
      error: station.lastSyncError
    }
  }
}

async function listStationGroups(type, zoneIds, {client = prisma} = {}) {
  if (zoneIds.length === 0) {
    return []
  }

  const associations = await client.zoneMonitoringStation.findMany({
    where: {
      zoneId: {in: zoneIds},
      enabled: true,
      monitoringStation: {type}
    },
    include: {
      zone: {
        select: {id: true, code: true, name: true}
      },
      monitoringStation: {
        select: {
          id: true,
          type: true,
          providerLabel: true,
          stationCode: true,
          bssId: true,
          siteCode: true,
          metadata: true,
          longitude: true,
          latitude: true,
          lastSyncAttemptAt: true,
          lastSyncSuccessAt: true,
          lastSyncError: true
        }
      }
    },
    orderBy: [
      {zone: {name: 'asc'}},
      {label: 'asc'}
    ]
  })
  const groups = new Map()

  for (const association of associations) {
    const station = association.monitoringStation
    const group = groups.get(station.id) ?? {station, associations: []}
    group.associations.push(association)
    groups.set(station.id, group)
  }

  return [...groups.values()]
}

function groupRowsByStation(rows) {
  const groups = new Map()
  for (const row of rows) {
    const stationRows = groups.get(row.monitoringStationId) ?? []
    stationRows.push(row)
    groups.set(row.monitoringStationId, stationRows)
  }

  return groups
}

function getUuidListSql(ids) {
  return Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))
}

export function buildPiezometryIpsMonthlyQuery({end, start, stationIds}) {
  return Prisma.sql`
    WITH daily_values AS (
      SELECT
        observation."monitoringStationId",
        observation."measurementDate" AS day,
        avg(observation."levelNgf")::float8 AS "levelNgf",
        avg(observation.depth)::float8 AS depth
      FROM "GroundwaterObservation" observation
      WHERE observation."monitoringStationId" IN (${getUuidListSql(stationIds)})
        AND observation.kind = 'CHRONICLE'::"GroundwaterObservationKind"
        AND observation."measuredAt" >= ${start}
        AND observation."measuredAt" < ${end}
      GROUP BY observation."monitoringStationId", observation."measurementDate"
    )
    SELECT
      daily_values."monitoringStationId",
      date_trunc('month', daily_values.day)::date AS at,
      avg(daily_values."levelNgf")::float8 AS "levelNgf",
      avg(daily_values.depth)::float8 AS depth,
      count(daily_values."levelNgf")::int AS "levelNgfObservationDays",
      count(daily_values.depth)::int AS "depthObservationDays"
    FROM daily_values
    GROUP BY
      daily_values."monitoringStationId",
      date_trunc('month', daily_values.day)
    ORDER BY
      daily_values."monitoringStationId",
      at
  `
}

export async function listPiezometryIpsMonthlyValues({
  client = prisma,
  end,
  start,
  stationIds
}) {
  if (stationIds.length === 0) {
    return []
  }

  return client.$queryRaw(buildPiezometryIpsMonthlyQuery({end, start, stationIds}))
}

export function periodBounds(period, now, type = 'PIEZOMETER') {
  if (period === 'week') {
    return {start: subtractDays(now, 7), end: now}
  }

  if (period === 'month') {
    if (type === 'FLOW_STATION') {
      const end = startOfUTCDay(now)
      return {start: subtractDays(end, 30), end}
    }

    return {start: subtractDays(now, 30), end: now}
  }

  if (period === 'five-years') {
    return {start: subtractYears(now, 5), end: now}
  }

  if (period === 'ten-years') {
    return {start: subtractYears(now, 10), end: now}
  }

  if (period === 'twenty-years') {
    return {start: subtractYears(now, 20), end: now}
  }

  if (type === 'FLOW_STATION') {
    const end = startOfUTCMonth(now)
    return {start: subtractUTCMonths(end, 12), end}
  }

  return {start: subtractYears(now, 1), end: now}
}

export function selectGroundwaterRows(rows, period) {
  const chronicles = rows.filter(row => row.kind === 'CHRONICLE')
  const realtime = rows.filter(row => row.kind === 'REALTIME')

  if (period === 'week') {
    return realtime.length > 0 ? realtime : chronicles
  }

  if (period !== 'month') {
    return chronicles
  }

  if (chronicles.length === 0) {
    return realtime
  }

  let latestChronicleDate = ''
  for (const row of chronicles) {
    const key = dateKey(row.measurementDate)
    if (key > latestChronicleDate) {
      latestChronicleDate = key
    }
  }

  return [
    ...chronicles,
    ...realtime.filter(row => dateKey(row.measurementDate) > latestChronicleDate)
  ].sort((first, second) => first.measuredAt - second.measuredAt)
}

function serializeGroundwaterValue(row) {
  return {
    at: row.measuredAt,
    levelNgf: row.levelNgf,
    depth: row.depth,
    origin: row.kind
  }
}

function mean(values) {
  return values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length
}

export function aggregateGroundwaterValuesByUTCWeek(values) {
  const buckets = new Map()

  for (const value of values) {
    const measuredAt = new Date(value.at)
    const weekStart = startOfUTCWeek(measuredAt)
    const key = weekStart.getTime()
    const bucket = buckets.get(key) ?? {
      at: weekStart,
      levelsNgf: [],
      depths: []
    }

    if (Number.isFinite(value.levelNgf)) {
      bucket.levelsNgf.push(value.levelNgf)
    }

    if (Number.isFinite(value.depth)) {
      bucket.depths.push(value.depth)
    }

    buckets.set(key, bucket)
  }

  return [...buckets.values()]
    .sort((first, second) => first.at - second.at)
    .map(bucket => ({
      at: bucket.at,
      levelNgf: mean(bucket.levelsNgf),
      depth: mean(bucket.depths),
      origin: 'CHRONICLE',
      aggregation: 'WEEKLY_MEAN'
    }))
}

export function aggregateGroundwaterValuesForPeriod(values, period) {
  return HISTORICAL_PIEZOMETRY_PERIODS.has(period)
    ? aggregateGroundwaterValuesByUTCWeek(values)
    : values
}

function latestAt(values) {
  let latest = null
  for (const value of values) {
    const measuredAt = new Date(value.at)
    if (!latest || measuredAt > latest) {
      latest = measuredAt
    }
  }

  return latest
}

function stationWarnings(stations) {
  return stations
    .filter(station => station.sync.status === 'ERROR')
    .map(station => ({
      stationId: station.id,
      stationCode: station.stationCode,
      label: station.label,
      message: station.sync.error || 'La dernière synchronisation a échoué.'
    }))
}

export async function getDashboardPiezometry({
  client = prisma,
  zoneIds,
  period = 'week',
  includeIps = false,
  now = new Date()
}) {
  const normalizedPeriod = PIEZOMETRY_PERIODS.has(period) ? period : 'week'
  const bounds = periodBounds(normalizedPeriod, now, 'PIEZOMETER')
  const stationGroups = await withRequestPerformancePhase(
    'piezometry_station_scope',
    () => listStationGroups('PIEZOMETER', zoneIds, {client})
  )
  const stationIds = stationGroups.map(group => group.station.id)
  const kinds = normalizedPeriod === 'week' || normalizedPeriod === 'month'
    ? ['CHRONICLE', 'REALTIME']
    : ['CHRONICLE']
  const [rows, ipsRows] = stationIds.length === 0
    ? [[], []]
    : await Promise.all([
      withRequestPerformancePhase(
        'piezometry_observations',
        () => client.groundwaterObservation.findMany({
          where: {
            monitoringStationId: {in: stationIds},
            kind: {in: kinds},
            measuredAt: {gte: bounds.start, lt: bounds.end}
          },
          orderBy: {measuredAt: 'asc'},
          select: {
            monitoringStationId: true,
            kind: true,
            measuredAt: true,
            measurementDate: true,
            levelNgf: true,
            depth: true
          }
        })
      ),
      includeIps
        ? withRequestPerformancePhase(
          'piezometry_ips_monthly',
          () => listPiezometryIpsMonthlyValues({
            client,
            end: now,
            start: subtractYears(now, PIEZOMETRY_IPS.referenceHistoryYears),
            stationIds
          })
        )
        : Promise.resolve([])
    ])
  const rowsByStation = groupRowsByStation(rows)
  const ipsRowsByStation = groupRowsByStation(ipsRows)
  const stations = withRequestPerformancePhase(
    'piezometry_transform',
    () => stationGroups.map(group => {
      const station = serializeStation(group)
      const selectedRows = selectGroundwaterRows(rowsByStation.get(station.id) ?? [], normalizedPeriod)
      const rawValues = selectedRows.map(serializeGroundwaterValue)
      const values = aggregateGroundwaterValuesForPeriod(rawValues, normalizedPeriod)

      return {
        ...station,
        latestObservationAt: latestAt(rawValues),
        values,
        ...(includeIps && {
          ips: buildPiezometryIpsFromMonthlyValues(
            ipsRowsByStation.get(station.id) ?? [],
            {
              start: startOfUTCMonth(bounds.start),
              end: bounds.end,
              now
            }
          )
        })
      }
    })
  )

  return {
    period: {key: normalizedPeriod, start: bounds.start, end: bounds.end},
    source: 'Hub’Eau / ADES (BRGM)',
    aggregation: HISTORICAL_PIEZOMETRY_PERIODS.has(normalizedPeriod)
      ? {frequency: '1 week', operator: 'mean'}
      : null,
    ...(includeIps && {
      indicator: {
        key: 'IPS',
        label: 'Indicateur piézométrique standardisé',
        method: 'MONTHLY_GAUSSIAN_KERNEL',
        minimum: PIEZOMETRY_IPS.minimum,
        maximum: PIEZOMETRY_IPS.maximum,
        minimumReferenceYears: PIEZOMETRY_IPS.minimumReferenceYears,
        referenceHistoryYears: PIEZOMETRY_IPS.referenceHistoryYears
      }
    }),
    warnings: stationWarnings(stations),
    stations
  }
}

function serializeFlowValue(row) {
  return {
    at: row.measuredAt,
    valueLitersPerSecond: row.valueLitersPerSecond,
    granularity: row.granularity
  }
}

export async function getDashboardRiverFlows({zoneIds, period = 'week', now = new Date()}) {
  const normalizedPeriod = FLOW_PERIODS.has(period) ? period : 'week'
  const bounds = periodBounds(normalizedPeriod, now, 'FLOW_STATION')
  const stationGroups = await listStationGroups('FLOW_STATION', zoneIds)
  const stationIds = stationGroups.map(group => group.station.id)
  let granularity = 'MONTHLY'
  if (normalizedPeriod === 'week') {
    granularity = 'REALTIME'
  } else if (normalizedPeriod === 'month') {
    granularity = 'DAILY'
  }

  const rows = stationIds.length === 0
    ? []
    : await prisma.riverFlowObservation.findMany({
      where: {
        monitoringStationId: {in: stationIds},
        granularity,
        measuredAt: {gte: bounds.start, lt: bounds.end}
      },
      orderBy: {measuredAt: 'asc'},
      select: {
        monitoringStationId: true,
        granularity: true,
        measuredAt: true,
        valueLitersPerSecond: true
      }
    })
  const rowsByStation = groupRowsByStation(rows)
  const stations = stationGroups.map(group => {
    const station = serializeStation(group)
    const values = (rowsByStation.get(station.id) ?? []).map(serializeFlowValue)

    return {
      ...station,
      latestObservationAt: latestAt(values),
      values
    }
  })

  return {
    period: {key: normalizedPeriod, start: bounds.start, end: bounds.end},
    source: 'Hub’Eau - réseau hydrométrique national (DREAL / Service central Vigicrues)',
    aggregation: null,
    warnings: stationWarnings(stations),
    stations
  }
}
