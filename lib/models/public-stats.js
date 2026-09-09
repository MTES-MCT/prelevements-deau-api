import {Prisma} from '@prisma/client'
import createHttpError from 'http-errors'

import {prisma} from '../../db/prisma.js'
import {getCompatibleMetricTypeCodes, LEGACY_METRIC_TYPE_CODES, METRIC_TYPE_CODES} from '../constants/metric-type-codes.js'

const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/
const MIN_SUPPORTED_MONTH = '1900-01'
const CACHE_TTL_MS = 60 * 60 * 1000
const MAX_CACHED_MONTHS = 24
const cachesByClient = new WeakMap()
const VOLUME_METRIC_CODES = getCompatibleMetricTypeCodes(METRIC_TYPE_CODES.VOLUME)
  .filter(code => code !== LEGACY_METRIC_TYPE_CODES.VOLUME_REJETE)
const MEASUREMENT_METRIC_CODES = [
  ...VOLUME_METRIC_CODES,
  ...getCompatibleMetricTypeCodes(METRIC_TYPE_CODES.INDEX),
  ...getCompatibleMetricTypeCodes(METRIC_TYPE_CODES.DEBIT)
]

const PROFILE_DEFINITIONS = Object.freeze([
  {key: 'AGRICULTURE', label: 'Agriculteurs', type: 'IRRIGANT'},
  {key: 'INDUSTRY', label: 'Industriels', type: 'ICPE'},
  {key: 'DRINKING_WATER', label: 'Gestionnaires d’eau potable', type: 'GESTIONNAIRE_AEP'},
  {key: 'OTHER', label: 'Autres', type: 'AUTRE'},
  {key: 'UNKNOWN', label: 'Non renseigné', type: null}
])

const CHANNEL_DEFINITIONS = Object.freeze([
  {key: 'DIRECT', label: 'Directement dans l’outil'},
  {key: 'THIRD_PARTY', label: 'Via un outil tiers'},
  {key: 'MIXED', label: 'Les deux canaux à parts égales'},
  {key: 'UNKNOWN', label: 'Canal non renseigné'}
])

function getParisMonth(date) {
  const parts = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit'
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${values.year}-${values.month}`
}

export function shiftPublicStatsMonth(month, offset) {
  const [year, monthNumber] = month.split('-').map(Number)
  const date = new Date(0)
  date.setUTCFullYear(year, monthNumber - 1 + offset, 1)
  return date.toISOString().slice(0, 7)
}

export function resolvePublicStatsMonth(month, now = new Date()) {
  const currentMonth = getParisMonth(now)
  if (month === undefined) {
    return shiftPublicStatsMonth(currentMonth, -1)
  }

  if (typeof month !== 'string' || !MONTH_PATTERN.test(month) || month.startsWith('0000-')) {
    throw createHttpError(400, 'Le mois doit être au format AAAA-MM.')
  }

  if (month < MIN_SUPPORTED_MONTH) {
    throw createHttpError(400, 'Le mois doit être compris entre janvier 1900 et le dernier mois terminé.')
  }

  if (month >= currentMonth) {
    throw createHttpError(400, 'Sélectionnez un mois terminé.')
  }

  return month
}

export function listPublicStatsMonths(firstMonth, lastMonth) {
  if (!firstMonth || firstMonth > lastMonth) {
    return []
  }

  const months = []
  // eslint-disable-next-line unicorn/prefer-math-min-max -- YYYY-MM values compare lexicographically, not numerically.
  const start = firstMonth < MIN_SUPPORTED_MONTH ? MIN_SUPPORTED_MONTH : firstMonth
  for (let month = start; month <= lastMonth; month = shiftPublicStatsMonth(month, 1)) {
    months.push(month)
  }

  return months
}

export function createPublicStatsCache({ttlMs = CACHE_TTL_MS, maxEntries = MAX_CACHED_MONTHS} = {}) {
  const entries = new Map()

  return {
    get size() {
      return entries.size
    },
    get(key, loader, now = Date.now()) {
      const cached = entries.get(key)
      if (cached && (cached.pending || cached.expiresAt > now)) {
        entries.delete(key)
        entries.set(key, cached)
        return cached.promise
      }

      entries.delete(key)
      const entry = {pending: true, expiresAt: now + ttlMs}
      entry.promise = (async () => {
        // Install the entry before invoking even a synchronous loader.
        await Promise.resolve()
        try {
          const value = await loader()
          entry.pending = false
          return value
        } catch (error) {
          if (entries.get(key) === entry) {
            entries.delete(key)
          }

          throw error
        }
      })()
      entries.set(key, entry)
      while (entries.size > maxEntries) {
        entries.delete(entries.keys().next().value)
      }

      return entry.promise
    }
  }
}

function percentage(count, total) {
  return total > 0 ? Math.round(count / total * 10_000) / 100 : null
}

// Unknown points must not turn an uncertain majority into an asserted channel.
export function classifyPublicStatsChannel({direct = 0, thirdParty = 0, unknown = 0}) {
  if (direct > thirdParty + unknown) {
    return 'DIRECT'
  }

  if (thirdParty > direct + unknown) {
    return 'THIRD_PARTY'
  }

  if (unknown === 0 && direct > 0 && direct === thirdParty) {
    return 'MIXED'
  }

  return 'UNKNOWN'
}

export function summarizePublicStatsChannels(rows = []) {
  const counts = new Map(CHANNEL_DEFINITIONS.map(({key}) => [key, 0]))
  let total = 0
  for (const row of rows) {
    const count = Number(row.count)
    const key = classifyPublicStatsChannel({
      direct: Number(row.direct),
      thirdParty: Number(row.thirdParty),
      unknown: Number(row.unknown)
    })
    counts.set(key, counts.get(key) + count)
    total += count
  }

  return CHANNEL_DEFINITIONS.map(channel => ({
    ...channel,
    count: counts.get(channel.key),
    percentage: percentage(counts.get(channel.key), total)
  }))
}

export function buildPublicStatsDataQuery(month) {
  const start = `${month}-01`
  const end = `${shiftPublicStatsMonth(month, 1)}-01`

  return Prisma.sql`
    WITH live_preleveurs AS MATERIALIZED (
      SELECT d."userId", d."preleveurType"
      FROM "Declarant" d
      JOIN "User" u ON u.id = d."userId"
      WHERE d."declarantRole" = 'PRELEVEUR'
        AND u.role = 'DECLARANT' AND u."deletedAt" IS NULL
    ), live_points AS MATERIALIZED (
      SELECT id FROM "PointPrelevement"
      WHERE "deletedAt" IS NULL AND "flowType" = 'PRELEVEMENT'
    ), candidate_chunks AS MATERIALIZED (
      SELECT c.id, c."pointPrelevementId" AS "pointId", c."preleveurUserId",
        c."minDate", c."maxDate", declared_preleveur."userId" AS "declarationPreleveurId",
        CASE
          WHEN s.type = 'API' OR d."dataSourceType" = 'API' THEN 'THIRD_PARTY'
          WHEN s.type = 'DECLARATION' AND d."dataSourceType" IN ('MANUAL', 'SPREADSHEET')
            AND d."importSourceId" IS NULL THEN 'DIRECT'
          ELSE 'UNKNOWN'
        END AS channel
      FROM "Chunk" c
      JOIN "Source" s ON s.id = c."sourceId"
      JOIN live_points p ON p.id = c."pointPrelevementId"
      LEFT JOIN "Declaration" d ON d.id = s."declarationId"
      LEFT JOIN "Declarant" declared_preleveur ON declared_preleveur."userId" = d."declarantUserId"
        AND declared_preleveur."declarantRole" = 'PRELEVEUR'
      WHERE s.status = 'COMPLETED'
        AND c."instructionStatus" IN ('PENDING', 'VALIDATED', 'AUTOMATICALLY_VALIDATED')
        AND (c."flowType" IS NULL OR c."flowType" = 'PRELEVEMENT')
    ), value_summary AS MATERIALIZED (
      SELECT cv."chunkId",
        MIN(CASE WHEN cv."metricTypeCode" IN (${Prisma.join(VOLUME_METRIC_CODES)})
          THEN cv."periodStart" ELSE cv."periodEnd" END) AS "firstMeasurementAt",
        BOOL_OR(CASE WHEN cv."metricTypeCode" IN (${Prisma.join(VOLUME_METRIC_CODES)})
          THEN cv."periodStart" < ${end}::date AND cv."periodEnd" > ${start}::date
          ELSE cv."periodEnd" >= ${start}::date AND cv."periodEnd" < ${end}::date
        END) AS "inMonth"
      FROM "ChunkValue" cv
      JOIN candidate_chunks c ON c.id = cv."chunkId"
      WHERE cv."metricTypeCode" IN (${Prisma.join(MEASUREMENT_METRIC_CODES)})
      GROUP BY cv."chunkId"
    ), valid_chunks AS MATERIALIZED (
      SELECT c.*, measurements."firstMeasurementAt", measurements."inMonth",
        COALESCE(c."preleveurUserId", c."declarationPreleveurId", fallback."userId") AS "attributedPreleveurId"
      FROM candidate_chunks c
      JOIN value_summary measurements ON measurements."chunkId" = c.id
      LEFT JOIN LATERAL (
        SELECT (ARRAY_AGG(DISTINCT e."declarantUserId"))[1] AS "userId"
        FROM "DeclarantPointPrelevement" e
        JOIN live_preleveurs owner ON owner."userId" = e."declarantUserId"
        WHERE c."preleveurUserId" IS NULL AND c."declarationPreleveurId" IS NULL
          AND e."pointPrelevementId" = c."pointId"
          AND (e."startDate" IS NULL OR e."startDate" <= c."maxDate")
          AND (e."endDate" IS NULL OR e."endDate" >= c."minDate")
        HAVING COUNT(DISTINCT e."declarantUserId") = 1
      ) fallback ON true
    ), represented_zones AS MATERIALIZED (
      SELECT DISTINCT z.id, z.name, z.type
      FROM "Zone" z
      JOIN "PointPrelevementZone" pz ON pz."zoneId" = z.id
      JOIN valid_chunks c ON c."pointId" = pz."pointPrelevementId"
      WHERE z.type IN ('SAGE', 'DEPARTEMENT')
    ), scoped_points AS MATERIALIZED (
      SELECT DISTINCT p.id, pz."zoneId"
      FROM live_points p
      JOIN "PointPrelevementZone" pz ON pz."pointPrelevementId" = p.id
      JOIN represented_zones z ON z.id = pz."zoneId"
    ), preleveur_zone_links AS (
      SELECT dz."declarantUserId" AS "userId", dz."zoneId"
      FROM "DeclarantZone" dz
      WHERE dz.source IN ('CREATION', 'MANUAL', 'MIGRATION')
      UNION
      SELECT e."declarantUserId", p."zoneId"
      FROM "DeclarantPointPrelevement" e JOIN scoped_points p ON p.id = e."pointPrelevementId"
      UNION
      SELECT c."preleveurUserId", p."zoneId"
      FROM "Chunk" c JOIN scoped_points p ON p.id = c."pointPrelevementId"
      UNION
      SELECT d."declarantUserId", p."zoneId"
      FROM "Declaration" d
      JOIN "Source" s ON s."declarationId" = d.id
      JOIN "Chunk" c ON c."sourceId" = s.id
      JOIN scoped_points p ON p.id = c."pointPrelevementId"
      UNION
      SELECT c."attributedPreleveurId", p."zoneId"
      FROM valid_chunks c JOIN scoped_points p ON p.id = c."pointId"
    ), territory_preleveurs AS MATERIALIZED (
      SELECT DISTINCT links."userId", links."zoneId", d."preleveurType"
      FROM preleveur_zone_links links
      JOIN live_preleveurs d ON d."userId" = links."userId"
      JOIN represented_zones z ON z.id = links."zoneId"
    ), reporting_pairs AS MATERIALIZED (
      SELECT DISTINCT c."attributedPreleveurId" AS "userId", c."pointId", c.channel
      FROM valid_chunks c
      JOIN live_preleveurs d ON d."userId" = c."attributedPreleveurId"
      WHERE c."inMonth" AND EXISTS (SELECT 1 FROM scoped_points p WHERE p.id = c."pointId")
    ), territory_reporting AS (
      SELECT DISTINCT r."userId", p."zoneId"
      FROM reporting_pairs r JOIN scoped_points p ON p.id = r."pointId"
    ), territory_point_counts AS (
      SELECT "zoneId", COUNT(DISTINCT id) AS count
      FROM scoped_points GROUP BY "zoneId"
    ), territory_counts AS (
      SELECT z.id, z.name, z.type,
        COALESCE(points.count, 0) AS "pointsCount",
        COUNT(DISTINCT d."userId") AS "preleveursCount",
        COUNT(DISTINCT r."userId") AS "reportingPreleveursCount",
        COUNT(DISTINCT d."userId") FILTER (WHERE d."preleveurType" = 'IRRIGANT') AS agriculture,
        COUNT(DISTINCT d."userId") FILTER (WHERE d."preleveurType" = 'ICPE') AS industry,
        COUNT(DISTINCT d."userId") FILTER (WHERE d."preleveurType" = 'GESTIONNAIRE_AEP') AS "drinkingWater",
        COUNT(DISTINCT d."userId") FILTER (WHERE d."preleveurType" = 'AUTRE') AS other,
        COUNT(DISTINCT d."userId") FILTER (WHERE d."preleveurType" IS NULL) AS unknown
      FROM represented_zones z
      LEFT JOIN territory_point_counts points ON points."zoneId" = z.id
      LEFT JOIN territory_preleveurs d ON d."zoneId" = z.id
      LEFT JOIN territory_reporting r ON r."zoneId" = z.id AND r."userId" = d."userId"
      GROUP BY z.id, z.name, z.type, points.count
    ), channel_point_counts AS (
      SELECT "userId",
        COUNT(DISTINCT "pointId") FILTER (WHERE channel = 'DIRECT') AS direct,
        COUNT(DISTINCT "pointId") FILTER (WHERE channel = 'THIRD_PARTY') AS "thirdParty",
        COUNT(DISTINCT "pointId") FILTER (WHERE channel = 'UNKNOWN') AS unknown
      FROM reporting_pairs GROUP BY "userId"
    ), channel_groups AS (
      SELECT direct, "thirdParty", unknown, COUNT(*) AS count
      FROM channel_point_counts GROUP BY direct, "thirdParty", unknown
    )
    SELECT
      (SELECT TO_CHAR(MIN("firstMeasurementAt"), 'YYYY-MM') FROM valid_chunks) AS "firstMeasurementMonth",
      (SELECT COUNT(DISTINCT id) FROM scoped_points) AS "pointsCount",
      (SELECT COUNT(DISTINCT "userId") FROM territory_preleveurs) AS "preleveursCount",
      COALESCE((SELECT JSON_AGG(territory_counts) FROM territory_counts), '[]'::json) AS territories,
      COALESCE((SELECT JSON_AGG(channel_groups) FROM channel_groups), '[]'::json) AS "channelGroups"
  `
}

export function buildPublicStatsConnectionsQuery(month) {
  const start = `${shiftPublicStatsMonth(month, -5)}-01`
  const end = `${shiftPublicStatsMonth(month, 1)}-01`

  return Prisma.sql`
    WITH first_event AS (
      SELECT MIN("occurredAt") AS "availableSince"
      FROM "AuditEvent"
      WHERE "actionType" IN (
        'AUTH.LOGIN_LINK_REQUESTED', 'AUTH.LOGIN_VERIFIED',
        'AUTH.PASSWORD_LOGIN_VERIFIED', 'AUTH.PASSWORD_ACTIVATED'
      )
    ), successful_connections AS (
      SELECT DISTINCT ON (month, "subjectUserId")
        TO_CHAR(("occurredAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Paris', 'YYYY-MM') AS month,
        "subjectUserId", "subjectUserRole"
      FROM "AuditEvent"
      WHERE outcome = 'SUCCESS' AND "subjectUserId" IS NOT NULL
        AND "actionType" IN ('AUTH.LOGIN_VERIFIED', 'AUTH.PASSWORD_LOGIN_VERIFIED', 'AUTH.PASSWORD_ACTIVATED')
        AND "occurredAt" >= (${start}::timestamp AT TIME ZONE 'Europe/Paris') AT TIME ZONE 'UTC'
        AND "occurredAt" < (${end}::timestamp AT TIME ZONE 'Europe/Paris') AT TIME ZONE 'UTC'
      ORDER BY month, "subjectUserId", "occurredAt" DESC, id DESC
    ), counts AS (
      SELECT month,
        COUNT(*) FILTER (WHERE "subjectUserRole" IN ('ADMIN', 'INSTRUCTOR')) AS administration,
        COUNT(*) FILTER (WHERE "subjectUserRole" = 'DECLARANT') AS declarants
      FROM successful_connections GROUP BY month
    )
    SELECT (SELECT "availableSince" FROM first_event) AS "availableSince",
      COALESCE((SELECT JSON_AGG(counts) FROM counts), '[]'::json) AS months
  `
}

export function summarizePublicStatsConnections({month, availableSince = null, months = []}) {
  const firstRecordedAt = availableSince ? new Date(availableSince) : null
  const firstRecordedMonth = firstRecordedAt ? getParisMonth(firstRecordedAt) : null
  const byMonth = new Map(months.map(row => [row.month, row]))
  const displayedMonths = Array.from({length: 6}, (_, index) => shiftPublicStatsMonth(month, index - 5))

  return {
    months: displayedMonths.map(key => {
      const unavailable = firstRecordedMonth === null || key < firstRecordedMonth
      const row = byMonth.get(key)
      const administration = unavailable ? null : Number(row?.administration ?? 0)
      const declarants = unavailable ? null : Number(row?.declarants ?? 0)
      return {
        month: key,
        administration,
        declarants,
        total: unavailable ? null : administration + declarants,
        status: unavailable ? 'unavailable' : (key === firstRecordedMonth ? 'partial' : 'available')
      }
    }),
    availableSince: firstRecordedAt?.toISOString() ?? null
  }
}

function serializeTerritory(row) {
  const profileCounts = [row.agriculture, row.industry, row.drinkingWater, row.other, row.unknown]
  const preleveursCount = Number(row.preleveursCount)
  const reportingPreleveursCount = Number(row.reportingPreleveursCount)
  return {
    id: row.id,
    name: row.name,
    pointsCount: Number(row.pointsCount),
    preleveursCount,
    reportingPreleveursCount,
    reportingRate: percentage(reportingPreleveursCount, preleveursCount),
    profiles: PROFILE_DEFINITIONS.map(({key, label}, index) => ({
      key, label, count: Number(profileCounts[index] ?? 0)
    }))
  }
}

export async function loadPublicStats({month, client = prisma, now = new Date()}) {
  const [[data], [connections]] = await Promise.all([
    client.$queryRaw(buildPublicStatsDataQuery(month)),
    client.$queryRaw(buildPublicStatsConnectionsQuery(month))
  ])
  const territories = {SAGE: [], DEPARTEMENT: []}
  for (const row of data.territories) {
    territories[row.type].push(serializeTerritory(row))
  }

  for (const rows of Object.values(territories)) {
    rows.sort((left, right) => left.name.localeCompare(right.name, 'fr'))
  }

  const lastCompletedMonth = resolvePublicStatsMonth(undefined, now)
  const availableMonths = listPublicStatsMonths(data.firstMeasurementMonth ?? month, lastCompletedMonth)
  if (!availableMonths.includes(month)) {
    availableMonths.push(month)
    availableMonths.sort()
  }

  return {
    month,
    generatedAt: now.toISOString(),
    availableMonths,
    totals: {
      pointsCount: Number(data.pointsCount),
      preleveursCount: Number(data.preleveursCount),
      sageCount: territories.SAGE.length,
      departmentCount: territories.DEPARTEMENT.length
    },
    territories,
    channels: summarizePublicStatsChannels(data.channelGroups),
    connections: summarizePublicStatsConnections({month, ...connections})
  }
}

export function getPublicStats({month, client = prisma, now = new Date()} = {}) {
  const resolvedMonth = resolvePublicStatsMonth(month, now)
  let cache = cachesByClient.get(client)
  if (!cache) {
    cache = createPublicStatsCache()
    cachesByClient.set(client, cache)
  }

  return cache.get(
    `${getParisMonth(now)}:${resolvedMonth}`,
    () => loadPublicStats({month: resolvedMonth, client, now}),
    now.getTime()
  )
}
