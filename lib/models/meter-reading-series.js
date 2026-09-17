import createHttpError from 'http-errors'
import {Prisma} from '@prisma/client'
import {prisma} from '../../db/prisma.js'

export const METER_READING_SERIES_WARNING = 'Index du compteur, non répartis entre les exploitations.'
const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit'
})

function meterScopeWhere({pointIds = [], preleveurId, collecteurId, pointFlowType}) {
  return {
    deletedAt: null,
    meterAllocations: {some: {exploitation: {
      pointPrelevementId: {in: pointIds},
      pointPrelevement: {deletedAt: null, ...(pointFlowType ? {flowType: pointFlowType} : {})},
      declarant: {user: {deletedAt: null}},
      ...(preleveurId ? {declarantUserId: preleveurId} : {}),
      ...(collecteurId ? {collecteurs: {some: {collecteurUserId: collecteurId}}} : {})
    }}}
  }
}

// These are physical meter histories, not historically attributed exploitation
// volumes. Allocation activation dates are not reading visibility boundaries.
export async function listMeterReadingSeriesOptions({user, sourceId, client = prisma, ...scope}) {
  if (user?.role !== 'ADMIN' || sourceId || !scope.pointIds?.length) return []
  const meters = await client.compteur.findMany({
    where: meterScopeWhere(scope), select: {id: true, serialNumber: true, identifier: true}, orderBy: {id: 'asc'}
  })
  if (meters.length === 0) return []
  const summaries = await client.meterReading.groupBy({
    by: ['compteurId'], where: {compteurId: {in: meters.map(meter => meter.id)}, currentRevisionId: {not: null}},
    _min: {observedAt: true}, _max: {observedAt: true}, _count: {_all: true}
  })
  const byMeter = new Map(summaries.map(summary => [summary.compteurId, summary]))
  return meters.filter(meter => byMeter.has(meter.id)).map(meter => {
    const summary = byMeter.get(meter.id)
    return {
      id: `index:meter:${meter.id}`, name: 'index', meterId: meter.id, readingSeries: true,
      label: `Index — compteur ${meter.serialNumber ?? meter.identifier ?? meter.id}`,
      flowType: null, unit: 'm³', valueType: 'instantaneous', precision: 4,
      spatialOperators: [], temporalOperators: ['raw'], defaultSpatialOperator: null, defaultTemporalOperator: 'raw',
      availableFrequencies: ['instantaneous'], warning: METER_READING_SERIES_WARNING, hasTemporalOverlap: false,
      minDate: dateFormatter.format(summary._min.observedAt), maxDate: dateFormatter.format(summary._max.observedAt),
      seriesCount: 1, valuesCount: summary._count._all
    }
  })
}

function readingScopeSql({meterId, startDate, endDate}) {
  return Prisma.sql`
    r."compteurId" = ${meterId}::uuid AND r."currentRevisionId" IS NOT NULL
    ${startDate ? Prisma.sql`AND r."observedAt" >= (${startDate}::date::timestamp AT TIME ZONE 'Europe/Paris')` : Prisma.empty}
    ${endDate ? Prisma.sql`AND r."observedAt" < ((${endDate}::date + 1)::timestamp AT TIME ZONE 'Europe/Paris')` : Prisma.empty}
  `
}

export async function getMeterReadingSeries({user, meterId, startDate, endDate, cursor, limit = 1000, client = prisma, ...scope}) {
  if (user?.role !== 'ADMIN') throw createHttpError(403, 'Les index physiques partagés sont réservés aux administrateurs.')
  const meter = await client.compteur.findFirst({
    where: {id: meterId, ...meterScopeWhere(scope)}, select: {id: true, serialNumber: true, identifier: true}
  })
  if (!meter) throw createHttpError(404, 'Compteur introuvable dans ce périmètre.')
  const readingScope = readingScopeSql({meterId, startDate, endDate})
  let cursorFilter = Prisma.empty
  if (cursor) {
    const [previous] = await client.$queryRaw`
      SELECT r.id, r."observedAt" FROM "MeterReading" r WHERE ${readingScope} AND r.id = ${cursor}::uuid
    `
    if (!previous) throw createHttpError(400, 'Curseur invalide pour ce compteur ou cette période.')
    cursorFilter = Prisma.sql`AND (r."observedAt", r.id) > (${previous.observedAt}, ${previous.id}::uuid)`
  }
  const rows = await client.$queryRaw`
    SELECT r.id AS "readingId", r."observedAt", revision.index::text AS index,
      revision.admissible, revision.quality, revision.origin, revision.reason,
      to_char(r."observedAt" AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD') AS date,
      to_char(r."observedAt" AT TIME ZONE 'Europe/Paris', 'HH24:MI:SS') AS time
    FROM "MeterReading" r
    JOIN "MeterReadingRevision" revision ON revision.id = r."currentRevisionId"
    WHERE ${readingScope} ${cursorFilter}
    ORDER BY r."observedAt", r.id LIMIT ${limit + 1}
  `
  const page = rows.slice(0, limit)
  const days = new Map()
  for (const {date, ...reading} of page) {
    if (!days.has(date)) days.set(date, {date, values: []})
    days.get(date).values.push({
      ...reading, observedAt: reading.observedAt.toISOString(), value: reading.admissible ? reading.index : null
    })
  }
  return {
    meter,
    values: [...days.values()],
    valuesCount: page.length,
    minDate: page[0]?.date ?? null,
    maxDate: page.at(-1)?.date ?? null,
    nextCursor: rows.length > limit ? page.at(-1).readingId : null
  }
}
