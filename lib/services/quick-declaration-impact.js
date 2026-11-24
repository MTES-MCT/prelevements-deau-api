import {Prisma} from '@prisma/client'
import {getCompatibleMetricTypeCodes} from '../constants/metric-type-codes.js'
import {computeInstantPeriodEnd} from '../util/temporal-discretization.js'
import {manualQuickChunkSql, quickSeriesExploitationSql, quickSeriesOwnerSql} from './quick-declaration-series.js'
import {orangeIndexPartitionSql} from './orange-connector-identity.js'
import {INDEX_METRIC_TYPE_CODES, indexCoverageDateSql, indexOrderingDateSql, lockPointForReconstruction, reconstructVolumesFromIndexInTransaction} from './volumes-from-index.js'

const volumeCodes = getCompatibleMetricTypeCodes('volume')
const isoDay = date => date.toISOString().slice(0, 10)
const frenchDay = date => isoDay(date).split('-').reverse().join('/')

export function quickSeriesKey({pointPrelevementId, effectiveExploitationId, exploitationId, compteurId}) {
  return [pointPrelevementId, effectiveExploitationId ?? exploitationId ?? '', compteurId ?? ''].join('|')
}

// The actor has already authorized every submitted series. A null identifier
// designates the historical series without that identifier, never a wildcard.
function seriesTable(entries) {
  const unique = new Map(entries.map(entry => [quickSeriesKey(entry), entry]))
  return Prisma.join([...unique.values()].map(({pointPrelevementId, effectiveExploitationId, exploitationId, compteurId}) =>
    Prisma.sql`(${pointPrelevementId}::uuid, ${effectiveExploitationId ?? exploitationId ?? null}::uuid, ${compteurId ?? null}::uuid)`))
}

function seriesChunks(declarantUserId, entries) {
  return Prisma.sql`
    SELECT c.id, c."pointPrelevementId", scope.exploitation AS "exploitationId", c."compteurId", c."autoCalculateVolumes", ${manualQuickChunkSql} AS manual
    FROM "Chunk" c JOIN "Source" s ON s.id = c."sourceId"
    JOIN (VALUES ${seriesTable(entries)}) AS scope(point, exploitation, compteur) ON c."pointPrelevementId" = scope.point
      AND ${quickSeriesExploitationSql} IS NOT DISTINCT FROM scope.exploitation AND c."compteurId" IS NOT DISTINCT FROM scope.compteur
    WHERE ${quickSeriesOwnerSql} = ${declarantUserId}::uuid AND c."calculationStrategy" = 'GENERIC'
      AND s.status = 'COMPLETED' AND c."instructionStatus" <> 'REJECTED' AND (${orangeIndexPartitionSql()}) IS NULL`
}

// Keep direct and calculated amounts separate even when they share the same stored interval.
export async function captureQuickVolumes(tx, {declarantUserId, entries}) {
  if (!entries.length) return []
  const rows = await tx.$queryRaw`
    WITH chunks AS (${seriesChunks(declarantUserId, entries)})
    SELECT c."pointPrelevementId", c."exploitationId", c."compteurId", v."periodStart", v."periodEnd",
      COALESCE(NULLIF(btrim(p."usageName"), ''), NULLIF(p.name,''), p."sourceId", 'Point de prélèvement') AS "pointName",
      (v."valueKind" = 'DECLARED') AS "direct", SUM(v.value) AS volume
    FROM chunks c JOIN "ChunkValue" v ON v."chunkId" = c.id JOIN "PointPrelevement" p ON p.id = c."pointPrelevementId"
    WHERE v."metricTypeCode" IN (${Prisma.join(volumeCodes)})
    GROUP BY c."pointPrelevementId", c."exploitationId", c."compteurId", v."periodStart", v."periodEnd", v."valueKind", p.id`
  return rows
}

// ChunkValue has 53 digits of precision. Keep sums exact until the JSON number conversion.
const VolumeDecimal = Prisma.Decimal.clone({precision: 80})

function volumesByDisplayedPeriod(rows) {
  const periods = new Map()
  for (const row of rows) {
    const periodStartDate = isoDay(row.periodStart)
    // Direct periods end on the last included day. An index interval ends on the day of the last reading.
    const end = row.direct && row.periodEnd > row.periodStart ? new Date(row.periodEnd.getTime() - 1) : row.periodEnd
    const periodEndDate = isoDay(end)
    const key = [quickSeriesKey(row), periodStartDate, periodEndDate].join('|')
    const period = periods.get(key) ?? {pointPrelevementId: row.pointPrelevementId, pointName: row.pointName,
      exploitationId: row.exploitationId, compteurId: row.compteurId, periodStartDate, periodEndDate,
      declared: null, computed: null}
    const kind = row.direct ? 'declared' : 'computed'
    period[kind] = (period[kind] ?? new VolumeDecimal(0)).plus(String(row.volume))
    periods.set(key, period)
  }
  return periods
}

function publicationKind(period) {
  if (!period) return null
  if (period.declared && period.computed) return 'MIXED'
  return period.declared ? 'DECLARED' : 'COMPUTED'
}

function periodVolume(period) {
  if (!period) return null
  return Number(period.declared?.plus(period.computed ?? 0) ?? period.computed)
}

function breakdown(period) {
  return {declared: Number(period.declared), computed: Number(period.computed)}
}

export function compareQuickVolumes(before, after) {
  const old = volumesByDisplayedPeriod(before)
  const current = volumesByDisplayedPeriod(after)
  const changes = []
  for (const key of [...new Set([...old.keys(), ...current.keys()])].sort()) {
    const previous = old.get(key)
    const next = current.get(key)
    if (previous && next && String(previous.declared) === String(next.declared)
      && String(previous.computed) === String(next.computed)) continue
    const {declared, computed, ...period} = next ?? previous
    const beforeKind = publicationKind(previous)
    const afterKind = publicationKind(next)
    changes.push({...period, before: periodVolume(previous), after: periodVolume(next), beforeKind, afterKind,
      ...(beforeKind === 'MIXED' ? {beforeBreakdown: breakdown(previous)} : {}),
      ...(afterKind === 'MIXED' ? {afterBreakdown: breakdown(next)} : {})})
  }
  return changes
}

export async function reconstructQuickVolumes(tx, {declarantUserId, entries}) {
  if (!entries.length) return []
  const pointIds = [...new Set(entries.map(entry => entry.pointPrelevementId))].sort()
  // eslint-disable-next-line no-await-in-loop -- Common acquisition order across transactions.
  for (const pointId of pointIds) await lockPointForReconstruction(tx, pointId)
  const chunks = await tx.$queryRaw`${seriesChunks(declarantUserId, entries)}`
  const results = []
  for (const pointId of pointIds) {
    const chunkIds = chunks.filter(chunk => chunk.pointPrelevementId === pointId).map(chunk => chunk.id)
    // eslint-disable-next-line no-await-in-loop -- The point calculations share this transaction.
    if (chunkIds.length) results.push(await reconstructVolumesFromIndexInTransaction(tx, pointId, {chunkIds}))
  }

  return results
}

const ordinaryIndexReadings = Prisma.sql`
      SELECT c."pointPrelevementId", c."exploitationId", c."compteurId", ${indexOrderingDateSql(Prisma.sql`c.manual`)} AS date, ${indexCoverageDateSql(Prisma.sql`c.manual`)} AS "coverageDate", v.value, v."createdAt", v.id, CASE WHEN c.manual THEN v."chunkId" ELSE v.id END AS "tieBreaker"
      FROM chunks c JOIN "ChunkValue" v ON v."chunkId" = c.id
      WHERE c."autoCalculateVolumes" AND v."valueKind" = 'DECLARED' AND v."metricTypeCode" IN (${Prisma.join(INDEX_METRIC_TYPE_CODES)})
        AND NOT EXISTS (SELECT 1 FROM "ChunkValue" other WHERE other."chunkId" = c.id AND other."valueKind" = 'DECLARED'
          AND other."metricTypeCode" NOT IN (${Prisma.join(INDEX_METRIC_TYPE_CODES)}))
`

function neighbor(sqlDirection) {
  const previous = sqlDirection === 'previous'
  const comparison = previous ? Prisma.sql`<` : Prisma.sql`>`
  const sort = previous ? Prisma.sql`DESC` : Prisma.sql`ASC`
  return Prisma.sql`
    SELECT idx.date, idx.value FROM readings idx
    WHERE idx."pointPrelevementId" = i.point AND idx."exploitationId" IS NOT DISTINCT FROM i.exploitation
      AND idx."compteurId" IS NOT DISTINCT FROM i.compteur AND idx.date ${comparison} i.date
    ORDER BY idx.date ${sort}, idx."createdAt" DESC, idx."tieBreaker" DESC, idx.id DESC LIMIT 1`
}

async function findIndexNeighbors(tx, {declarantUserId, entries}) {
  entries = entries.filter(entry => entry.readingDate)
  if (!entries.length) return []
  const incoming = Prisma.join(entries.map(entry => Prisma.sql`(
    ${entry.pointPrelevementId}::uuid, ${entry.effectiveExploitationId ?? entry.exploitationId ?? null}::uuid, ${entry.compteurId ?? null}::uuid,
    ${computeInstantPeriodEnd(new Date(entry.readingDate))}::timestamp, ${entry.value}::numeric, ${entry.id ?? null}::uuid)`))
  return tx.$queryRaw`
    WITH chunks AS (${seriesChunks(declarantUserId, entries)}),
    readings AS (
      ${ordinaryIndexReadings}
    )
    SELECT i.chunk AS "chunkId", i.point AS "pointPrelevementId", i.exploitation AS "exploitationId", i.compteur AS "compteurId",
      COALESCE(NULLIF(btrim(p."usageName"), ''), NULLIF(p.name,''), p."sourceId", 'Point de prélèvement') AS "pointName",
      coalesce(m."serialNumber", m.identifier) AS "compteurName", i.date AS "readingDate", i.value, prev.value AS "previousValue", prev.date AS "previousDate",
      nxt.value AS "nextValue", nxt.date AS "nextDate"
    FROM (VALUES ${incoming}) AS i(point, exploitation, compteur, date, value, chunk)
    JOIN "PointPrelevement" p ON p.id = i.point
    LEFT JOIN "Compteur" m ON m.id = i.compteur
    LEFT JOIN LATERAL (${neighbor('previous')}) prev ON true
    LEFT JOIN LATERAL (${neighbor('next')}) nxt ON true
    ORDER BY i.point, i.exploitation, i.compteur, i.date`
}

export async function getQuickPreviousReadings(tx, scope) {
  const neighbors = await findIndexNeighbors(tx, scope)
  return new Map(neighbors.filter(row => row.chunkId && row.previousDate).map(row => [row.chunkId,
    {date: isoDay(row.previousDate), value: Number(row.previousValue), unit: 'm³'}]))
}

export async function findQuickIndexWarnings(tx, scope) {
  const rows = await findIndexNeighbors(tx, scope)
  const warnings = []
  for (const row of rows) {
    for (const previous of [true, false]) {
      const neighborValue = previous ? row.previousValue : row.nextValue
      if (neighborValue == null || !(previous ? row.value.lessThan(neighborValue) : row.value.greaterThan(neighborValue))) continue
      const neighborDate = isoDay(previous ? row.previousDate : row.nextDate)
      const [year, month, day] = neighborDate.split('-')
      const direction = previous ? 'inférieur au relevé précédent' : 'supérieur au relevé suivant'
      warnings.push({
        pointPrelevementId: row.pointPrelevementId, pointName: row.pointName, exploitationId: row.exploitationId,
        compteurId: row.compteurId, compteurName: row.compteurName, readingDate: isoDay(row.readingDate), value: Number(row.value),
        code: previous ? 'INDEX_BELOW_PREVIOUS' : 'INDEX_ABOVE_NEXT', neighborDate, neighborValue: Number(neighborValue),
        message: `L’index saisi est ${direction} (${Number(neighborValue).toLocaleString('fr-FR')} m³ le ${day}/${month}/${year}).`
      })
    }
  }

  return warnings
}

export async function findQuickMixedWarnings(tx, {declarantUserId, entries}) {
  const active = entries.filter(entry => entry.readingDate || (entry.periodStartDate && entry.periodEndDate))
  if (!active.length) return []
  const windows = Prisma.join(active.map(entry => {
    const isReading = Boolean(entry.readingDate)
    const start = new Date(isReading ? entry.readingDate : entry.periodStartDate)
    const end = isReading ? start : new Date(entry.periodEndDate)
    if (!isReading) end.setUTCDate(end.getUTCDate() + 1)
    return Prisma.sql`(${entry.pointPrelevementId}::uuid, ${entry.effectiveExploitationId ?? entry.exploitationId ?? null}::uuid, ${entry.compteurId ?? null}::uuid,
      ${start}::timestamp, ${end}::timestamp, ${isReading}::boolean)`
  }))
  const rows = await tx.$queryRaw`
    WITH chunks AS (${seriesChunks(declarantUserId, active)}), readings AS (${ordinaryIndexReadings}),
    distinct_readings AS (
      SELECT DISTINCT ON ("pointPrelevementId", "exploitationId", "compteurId", date) *
      FROM readings ORDER BY "pointPrelevementId", "exploitationId", "compteurId", date, "createdAt" DESC, "tieBreaker" DESC, id DESC
    ), intervals AS (
      SELECT *, LAG("coverageDate") OVER (PARTITION BY "pointPrelevementId", "exploitationId", "compteurId" ORDER BY date) AS start
      FROM distinct_readings
    )
    SELECT DISTINCT i."pointPrelevementId", i."exploitationId", i."compteurId",
      COALESCE(NULLIF(btrim(p."usageName"), ''), NULLIF(p.name, ''), p."sourceId", 'Point de prélèvement') AS "pointName",
      coalesce(m."serialNumber", m.identifier) AS "compteurName",
      i.start AS "indexStart", i."coverageDate" AS "indexEnd", d."periodStart" AS "directStart", d."periodEnd" AS "directEnd"
    FROM intervals i JOIN chunks c ON i."pointPrelevementId" = c."pointPrelevementId"
      AND i."exploitationId" IS NOT DISTINCT FROM c."exploitationId" AND i."compteurId" IS NOT DISTINCT FROM c."compteurId"
    JOIN "ChunkValue" d ON d."chunkId" = c.id AND d."valueKind" = 'DECLARED' AND d."metricTypeCode" IN (${Prisma.join(volumeCodes)})
      AND i.start < d."periodEnd" AND i."coverageDate" > d."periodStart"
    JOIN "PointPrelevement" p ON p.id = i."pointPrelevementId"
    LEFT JOIN "Compteur" m ON m.id = i."compteurId"
    WHERE EXISTS (SELECT 1 FROM (VALUES ${windows}) AS w(point, exploitation, compteur, start, stop, reading)
      WHERE w.point = i."pointPrelevementId" AND w.exploitation IS NOT DISTINCT FROM i."exploitationId"
        AND w.compteur IS NOT DISTINCT FROM i."compteurId" AND (
          (w.reading AND w.start IN (i.start, i."coverageDate")) OR
          (NOT w.reading AND w.start = d."periodStart" AND w.stop = d."periodEnd")
        ))
    ORDER BY i."pointPrelevementId", i."exploitationId", i."compteurId", "indexStart", "indexEnd", "directStart", "directEnd"`
  return rows.map(row => {
    const directEnd = new Date(Math.max(+row.directStart, +row.directEnd - 1))
    return {
      pointPrelevementId: row.pointPrelevementId, pointName: row.pointName, exploitationId: row.exploitationId,
      compteurId: row.compteurId, compteurName: row.compteurName, code: 'DIRECT_VOLUME_PRIORITY',
      periodStartDate: isoDay(row.directStart), periodEndDate: isoDay(directEnd),
      message: `Le volume déclaré du ${frenchDay(row.directStart)} au ${frenchDay(directEnd)} est retenu. Le volume entre les index du ${frenchDay(row.indexStart)} et du ${frenchDay(row.indexEnd)} ne sera pas ajouté, même en cas de recouvrement partiel.`
    }
  })
}

// Same-date readings are retained. Removing the winning reading can reveal
// an older one even when it is the only reading and no volume changes.
export async function captureQuickEffectiveReadings(tx, {declarantUserId, entries}) {
  const oldReadings = entries.filter(entry => entry.readingDate)
  if (!oldReadings.length) return []
  const dates = Prisma.join(oldReadings.map(entry => Prisma.sql`(
    ${entry.pointPrelevementId}::uuid, ${entry.effectiveExploitationId ?? entry.exploitationId ?? null}::uuid, ${entry.compteurId ?? null}::uuid,
    ${computeInstantPeriodEnd(new Date(entry.readingDate))}::timestamp)`))
  return tx.$queryRaw`
    WITH chunks AS (${seriesChunks(declarantUserId, oldReadings)}), readings AS (${ordinaryIndexReadings})
    SELECT i."pointPrelevementId", i."exploitationId", i."compteurId", i.date, i.value, i.id,
      COALESCE(NULLIF(btrim(p."usageName"), ''), NULLIF(p.name, ''), p."sourceId", 'Point de prélèvement') AS "pointName",
      COALESCE(m."serialNumber", m.identifier) AS "compteurName"
    FROM readings i JOIN "PointPrelevement" p ON p.id = i."pointPrelevementId" LEFT JOIN "Compteur" m ON m.id = i."compteurId"
    WHERE EXISTS (SELECT 1 FROM (VALUES ${dates}) AS target(point, exploitation, compteur, date)
      WHERE target.point = i."pointPrelevementId" AND target.exploitation IS NOT DISTINCT FROM i."exploitationId"
        AND target.compteur IS NOT DISTINCT FROM i."compteurId" AND target.date = i.date)
    ORDER BY i."pointPrelevementId", i."exploitationId", i."compteurId", i.date, i."createdAt" DESC, i."tieBreaker" DESC, i.id DESC`
}

export function restoredQuickReadingWarnings(before, after) {
  function byDate(rows) {
    const grouped = new Map()
    for (const row of rows) {
      const key = quickSeriesKey(row) + '|' + isoDay(row.date)
      const readings = grouped.get(key) ?? []
      readings.push(row)
      grouped.set(key, readings)
    }

    return grouped
  }

  const previous = byDate(before)
  const warnings = []
  for (const [key, [active]] of byDate(after)) {
    const candidates = previous.get(key)
    if (!candidates?.slice(1).some(row => row.id === active.id)) continue
    warnings.push({
      pointPrelevementId: active.pointPrelevementId, pointName: active.pointName, exploitationId: active.exploitationId,
      compteurId: active.compteurId, compteurName: active.compteurName, readingDate: isoDay(active.date), value: Number(active.value),
      code: 'PREVIOUS_INDEX_RESTORED',
      message: `Un relevé antérieur de ${Number(active.value).toLocaleString('fr-FR')} m³ redevient l’index retenu pour le ${frenchDay(active.date)}.`
    })
  }

  return warnings
}
