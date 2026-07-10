import {randomUUID} from 'node:crypto'

import {Prisma} from '@prisma/client'

import {prisma} from '../../db/prisma.js'
import {hubeau} from './hubeau.js'
import {resolveMonitoringStationMetadata} from './monitoring-stations.js'

const WRITE_BATCH_SIZE = 500
const GROUNDWATER_REALTIME_RETENTION_DAYS = 31
const GROUNDWATER_INCREMENTAL_HISTORY_DAYS = 45
const GROUNDWATER_HISTORY_YEARS = 20
const FLOW_REALTIME_RETENTION_DAYS = 8
const FLOW_DAILY_RETENTION_DAYS = 45
const FLOW_MONTHLY_RETENTION_MONTHS = 13

function asFiniteNumber(value) {
  if (value === undefined || value === null || value === '') {
    return null
  }

  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function asInteger(value) {
  const number = asFiniteNumber(value)
  return number === null ? null : Math.trunc(number)
}

function asDate(value) {
  if (!value) {
    return null
  }

  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function dateFromTimestampOrValue(timestamp, value) {
  const numericTimestamp = asFiniteNumber(timestamp)
  return asDate(numericTimestamp === null ? value : numericTimestamp)
}

function dateOnly(value) {
  const raw = String(value ?? '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00.000Z`) : null
}

function formatDate(date) {
  return date.toISOString().slice(0, 10)
}

function subtractDays(date, days) {
  const result = new Date(date)
  result.setUTCDate(result.getUTCDate() - days)
  return result
}

function subtractMonths(date, months) {
  const result = new Date(date)
  result.setUTCMonth(result.getUTCMonth() - months)
  return result
}

function subtractYears(date, years) {
  const result = new Date(date)
  result.setUTCFullYear(result.getUTCFullYear() - years)
  return result
}

function chunks(items, size = WRITE_BATCH_SIZE) {
  const result = []
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size))
  }

  return result
}

function normalizeGroundwaterRows(rows, kind) {
  return rows.map(row => {
    const measuredAt = dateFromTimestampOrValue(row.timestamp_mesure, row.date_mesure)
    const measurementDate = dateOnly(row.date_mesure) || (measuredAt ? dateOnly(measuredAt.toISOString()) : null)
    const levelNgf = asFiniteNumber(kind === 'REALTIME' ? row.niveau_eau_ngf : row.niveau_nappe_eau)
    const depth = asFiniteNumber(row.profondeur_nappe)

    if (!measuredAt || !measurementDate || (levelNgf === null && depth === null)) {
      return null
    }

    return {
      kind,
      measuredAt,
      measurementDate,
      levelNgf,
      depth,
      status: row.statut || (kind === 'REALTIME' ? 'Donnée temps réel brute' : null),
      qualification: row.qualification || null,
      raw: row
    }
  }).filter(Boolean)
}

function normalizeFlowRows(rows, granularity) {
  return rows.map(row => {
    const measuredAt = asDate(granularity === 'REALTIME' ? row.date_obs : row.date_obs_elab)
    const valueLitersPerSecond = asFiniteNumber(
      granularity === 'REALTIME' ? row.resultat_obs : row.resultat_obs_elab
    )

    if (!measuredAt || valueLitersPerSecond === null) {
      return null
    }

    return {
      granularity,
      measuredAt,
      valueLitersPerSecond,
      producedAt: asDate(row.date_prod),
      statusCode: asInteger(row.code_statut),
      status: row.libelle_statut || null,
      methodCode: asInteger(granularity === 'REALTIME' ? row.code_methode_obs : row.code_methode),
      method: granularity === 'REALTIME' ? row.libelle_methode_obs || null : row.libelle_methode || null,
      qualificationCode: asInteger(
        granularity === 'REALTIME' ? row.code_qualification_obs : row.code_qualification
      ),
      qualification: granularity === 'REALTIME'
        ? row.libelle_qualification_obs || null
        : row.libelle_qualification || null,
      raw: row
    }
  }).filter(Boolean)
}

async function upsertGroundwaterRows(monitoringStationId, rows) {
  for (const batch of chunks(rows)) {
    const values = batch.map(row => Prisma.sql`(
      ${randomUUID()}::uuid,
      ${monitoringStationId}::uuid,
      ${row.kind}::"GroundwaterObservationKind",
      ${row.measuredAt},
      ${row.measurementDate}::date,
      ${row.levelNgf},
      ${row.depth},
      ${row.status},
      ${row.qualification},
      ${JSON.stringify(row.raw)}::jsonb,
      now(),
      now()
    )`)

    // eslint-disable-next-line no-await-in-loop
    await prisma.$executeRaw`
      INSERT INTO "GroundwaterObservation" (
        id, "monitoringStationId", kind, "measuredAt", "measurementDate",
        "levelNgf", depth, status, qualification, raw, "createdAt", "updatedAt"
      )
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("monitoringStationId", kind, "measuredAt")
      DO UPDATE SET
        "measurementDate" = EXCLUDED."measurementDate",
        "levelNgf" = EXCLUDED."levelNgf",
        depth = EXCLUDED.depth,
        status = EXCLUDED.status,
        qualification = EXCLUDED.qualification,
        raw = EXCLUDED.raw,
        "updatedAt" = now()
    `
  }

  return rows.length
}

async function upsertFlowRows(monitoringStationId, rows) {
  for (const batch of chunks(rows)) {
    const values = batch.map(row => Prisma.sql`(
      ${randomUUID()}::uuid,
      ${monitoringStationId}::uuid,
      ${row.granularity}::"RiverFlowObservationGranularity",
      ${row.measuredAt},
      ${row.valueLitersPerSecond},
      ${row.producedAt},
      ${row.statusCode},
      ${row.status},
      ${row.methodCode},
      ${row.method},
      ${row.qualificationCode},
      ${row.qualification},
      ${JSON.stringify(row.raw)}::jsonb,
      now(),
      now()
    )`)

    // eslint-disable-next-line no-await-in-loop
    await prisma.$executeRaw`
      INSERT INTO "RiverFlowObservation" (
        id, "monitoringStationId", granularity, "measuredAt", "valueLitersPerSecond",
        "producedAt", "statusCode", status, "methodCode", method,
        "qualificationCode", qualification, raw, "createdAt", "updatedAt"
      )
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("monitoringStationId", granularity, "measuredAt")
      DO UPDATE SET
        "valueLitersPerSecond" = EXCLUDED."valueLitersPerSecond",
        "producedAt" = EXCLUDED."producedAt",
        "statusCode" = EXCLUDED."statusCode",
        status = EXCLUDED.status,
        "methodCode" = EXCLUDED."methodCode",
        method = EXCLUDED.method,
        "qualificationCode" = EXCLUDED."qualificationCode",
        qualification = EXCLUDED.qualification,
        raw = EXCLUDED.raw,
        "updatedAt" = now()
    `
  }

  return rows.length
}

async function refreshMetadata(station, client) {
  const metadata = await resolveMonitoringStationMetadata(station.type, station.stationCode, client)
  const syncedAt = new Date()

  await prisma.monitoringStation.update({
    where: {id: station.id},
    data: {
      stationCode: metadata.stationCode,
      bssId: metadata.bssId,
      siteCode: metadata.siteCode,
      providerLabel: metadata.providerLabel,
      longitude: metadata.longitude,
      latitude: metadata.latitude,
      metadata: metadata.metadata,
      lastMetadataSyncAt: syncedAt
    }
  })

  return syncedAt
}

async function syncGroundwater(station, {client, mode, now}) {
  const result = {chronicle: 0, realtime: 0}

  if (mode === 'realtime') {
    const rows = await client.listGroundwaterRealtime(station.stationCode, {
      bssId: station.bssId,
      startDate: formatDate(subtractDays(now, GROUNDWATER_REALTIME_RETENTION_DAYS))
    })
    result.realtime = await upsertGroundwaterRows(
      station.id,
      normalizeGroundwaterRows(rows, 'REALTIME')
    )
  } else {
    const startDate = mode === 'full'
      ? subtractYears(now, GROUNDWATER_HISTORY_YEARS)
      : subtractDays(now, GROUNDWATER_INCREMENTAL_HISTORY_DAYS)
    const rows = await client.listGroundwaterChronicles(station.stationCode, {
      bssId: station.bssId,
      startDate: formatDate(startDate)
    })
    result.chronicle = await upsertGroundwaterRows(
      station.id,
      normalizeGroundwaterRows(rows, 'CHRONICLE')
    )
  }

  await prisma.groundwaterObservation.deleteMany({
    where: {
      monitoringStationId: station.id,
      OR: [
        {
          kind: 'REALTIME',
          measuredAt: {lt: subtractDays(now, GROUNDWATER_REALTIME_RETENTION_DAYS)}
        },
        {
          kind: 'CHRONICLE',
          measurementDate: {lt: subtractYears(now, GROUNDWATER_HISTORY_YEARS)}
        }
      ]
    }
  })

  return result
}

async function syncFlow(station, {client, mode, now}) {
  const result = {realtime: 0, daily: 0, monthly: 0}

  if (mode === 'realtime') {
    const rows = await client.listFlowRealtime(station.stationCode, {
      startDate: subtractDays(now, FLOW_REALTIME_RETENTION_DAYS).toISOString()
    })
    result.realtime = await upsertFlowRows(
      station.id,
      normalizeFlowRows(rows, 'REALTIME')
    )
  } else {
    const dailyRows = await client.listFlowDaily(station.stationCode, {
      startDate: formatDate(subtractDays(now, FLOW_DAILY_RETENTION_DAYS))
    })
    result.daily = await upsertFlowRows(station.id, normalizeFlowRows(dailyRows, 'DAILY'))

    const monthlyRows = await client.listFlowMonthly(station.stationCode, {
      startDate: formatDate(subtractMonths(now, FLOW_MONTHLY_RETENTION_MONTHS))
    })
    result.monthly = await upsertFlowRows(station.id, normalizeFlowRows(monthlyRows, 'MONTHLY'))
  }

  await prisma.riverFlowObservation.deleteMany({
    where: {
      monitoringStationId: station.id,
      OR: [
        {
          granularity: 'REALTIME',
          measuredAt: {lt: subtractDays(now, FLOW_REALTIME_RETENTION_DAYS)}
        },
        {
          granularity: 'DAILY',
          measuredAt: {lt: subtractDays(now, FLOW_DAILY_RETENTION_DAYS)}
        },
        {
          granularity: 'MONTHLY',
          measuredAt: {lt: subtractMonths(now, FLOW_MONTHLY_RETENTION_MONTHS)}
        }
      ]
    }
  })

  return result
}

export async function syncMonitoringStation(stationId, {
  client = hubeau,
  logger = console,
  mode = 'realtime',
  now = new Date()
} = {}) {
  const station = await prisma.monitoringStation.findUnique({where: {id: stationId}})
  if (!station) {
    return {skipped: true, reason: 'station-not-found'}
  }

  if (!['realtime', 'daily', 'full'].includes(mode)) {
    throw new TypeError(`Mode de synchronisation inconnu : ${mode}`)
  }

  await prisma.monitoringStation.update({
    where: {id: station.id},
    data: {lastSyncAttemptAt: now}
  })

  try {
    if (mode !== 'realtime' || !station.lastMetadataSyncAt || !station.providerLabel) {
      await refreshMetadata(station, client)
    }

    const counts = station.type === 'PIEZOMETER'
      ? await syncGroundwater(station, {client, mode, now})
      : await syncFlow(station, {client, mode, now})
    const successAt = new Date()
    const data = {
      lastSyncSuccessAt: successAt,
      lastSyncError: null,
      ...(mode === 'realtime' ? {lastRealtimeSyncAt: successAt} : {}),
      ...(mode === 'daily' ? {lastHistoricalSyncAt: successAt} : {}),
      ...(mode === 'full'
        ? {
          lastHistoricalSyncAt: successAt,
          lastFullSyncAt: successAt
        }
        : {})
    }

    await prisma.monitoringStation.update({where: {id: station.id}, data})
    logger.log?.(`[monitoring] station=${station.stationCode} mode=${mode} rows=${JSON.stringify(counts)}`)

    return {stationId: station.id, stationCode: station.stationCode, mode, counts}
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await prisma.monitoringStation.update({
      where: {id: station.id},
      data: {lastSyncError: message.slice(0, 4000)}
    })
    logger.error?.(`[monitoring] station=${station.stationCode} mode=${mode} error=${message}`)
    throw error
  }
}

export async function listEnabledMonitoringStationIds() {
  const rows = await prisma.monitoringStation.findMany({
    where: {
      zones: {
        some: {enabled: true}
      }
    },
    select: {id: true},
    orderBy: {id: 'asc'}
  })

  return rows.map(row => row.id)
}
