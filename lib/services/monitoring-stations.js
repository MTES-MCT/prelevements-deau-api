import {hubeau} from './hubeau.js'

export const MONITORING_STATION_TYPES = new Set(['PIEZOMETER', 'FLOW_STATION'])

function finiteNumber(value) {
  if (value === undefined || value === null || value === '') {
    return null
  }

  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function coordinatesFromMetadata(metadata, longitudeKey, latitudeKey) {
  const geometryCoordinates = metadata?.geometry?.coordinates
  const longitude = finiteNumber(geometryCoordinates?.[0] ?? metadata?.[longitudeKey])
  const latitude = finiteNumber(geometryCoordinates?.[1] ?? metadata?.[latitudeKey])

  return {longitude, latitude}
}

export function normalizeStationCode(value) {
  return String(value ?? '').trim().toUpperCase()
}

export async function resolveMonitoringStationMetadata(type, stationCode, client = hubeau) {
  const normalizedCode = normalizeStationCode(stationCode)

  if (!MONITORING_STATION_TYPES.has(type)) {
    throw new TypeError(`Type de station non pris en charge : ${type}`)
  }

  if (type === 'PIEZOMETER') {
    const metadata = await client.getPiezometer(normalizedCode)
    const coordinates = coordinatesFromMetadata(metadata, 'x', 'y')

    return {
      type,
      stationCode: normalizeStationCode(metadata.code_bss || normalizedCode),
      bssId: normalizeStationCode(metadata.bss_id) || null,
      siteCode: null,
      providerLabel: metadata.libelle_pe || metadata.code_bss || normalizedCode,
      ...coordinates,
      metadata
    }
  }

  const metadata = await client.getFlowStation(normalizedCode)
  const coordinates = coordinatesFromMetadata(metadata, 'longitude_station', 'latitude_station')

  return {
    type,
    stationCode: normalizeStationCode(metadata.code_station || normalizedCode),
    bssId: null,
    siteCode: metadata.code_site ? String(metadata.code_site).trim() : null,
    providerLabel: metadata.libelle_station || metadata.code_station || normalizedCode,
    ...coordinates,
    metadata
  }
}

export async function upsertMonitoringStationMetadata(transaction, metadata) {
  const syncedAt = new Date()
  const data = {
    type: metadata.type,
    stationCode: metadata.stationCode,
    bssId: metadata.bssId,
    siteCode: metadata.siteCode,
    providerLabel: metadata.providerLabel,
    longitude: metadata.longitude,
    latitude: metadata.latitude,
    metadata: metadata.metadata,
    lastMetadataSyncAt: syncedAt
  }

  if (metadata.bssId) {
    const existing = await transaction.monitoringStation.findUnique({
      where: {bssId: metadata.bssId},
      select: {id: true}
    })

    if (existing) {
      return transaction.monitoringStation.update({
        where: {id: existing.id},
        data
      })
    }
  }

  return transaction.monitoringStation.upsert({
    where: {
      type_stationCode: {
        type: metadata.type,
        stationCode: metadata.stationCode
      }
    },
    create: data,
    update: data
  })
}

export function getMonitoringStationSyncStatus(station) {
  if (!station.lastSyncSuccessAt) {
    return station.lastSyncError ? 'ERROR' : 'PENDING'
  }

  if (
    station.lastSyncError
    && station.lastSyncAttemptAt
    && station.lastSyncAttemptAt >= station.lastSyncSuccessAt
  ) {
    return 'ERROR'
  }

  return 'READY'
}

export function serializeMonitoringStationAssociation(association) {
  const station = association.monitoringStation

  return {
    id: association.id,
    zoneId: association.zoneId,
    label: association.label,
    enabled: association.enabled,
    type: station.type,
    stationCode: station.stationCode,
    bssId: station.bssId,
    siteCode: station.siteCode,
    providerLabel: station.providerLabel,
    coordinates: Number.isFinite(station.longitude) && Number.isFinite(station.latitude)
      ? {
        type: 'Point',
        coordinates: [station.longitude, station.latitude]
      }
      : null,
    sync: {
      status: getMonitoringStationSyncStatus(station),
      lastAttemptAt: station.lastSyncAttemptAt,
      lastSuccessAt: station.lastSyncSuccessAt,
      lastRealtimeSyncAt: station.lastRealtimeSyncAt,
      lastHistoricalSyncAt: station.lastHistoricalSyncAt,
      error: station.lastSyncError
    },
    createdAt: association.createdAt,
    updatedAt: association.updatedAt
  }
}
