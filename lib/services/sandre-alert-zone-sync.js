import {randomUUID} from 'node:crypto'
import process from 'node:process'
import pg from 'pg'

import {prisma} from '../../db/prisma.js'
import {fetchSandreZoneSnapshot} from './sandre-alert-zones.js'

const {Client} = pg

const SANDRE_SYNC_LOCK_NAME = 'partageonsleau:sandre-alert-zones:sync'
const DEFAULT_CONCURRENCY = 1
const MAX_CONCURRENCY = 2
const GEOMETRY_NORMALIZATION_BATCH_SIZE = 5
const MAX_RELATIVE_AREA_DELTA = 1e-6
const TRANSACTION_TIMEOUT_MS = 120_000
const LOCK_HEARTBEAT_INTERVAL_MS = 20_000

export const SANDRE_DEPARTMENT_CODES = Object.freeze([
  ...Array.from({length: 19}, (_, index) => String(index + 1).padStart(2, '0')),
  '2A',
  '2B',
  ...Array.from({length: 75}, (_, index) => String(index + 21)),
  '971',
  '972',
  '973',
  '974',
  '976'
])

const NORMALIZE_GEOMETRIES_SQL = `
  WITH geometry_input AS (
    SELECT
      ordinality::integer AS ordinal,
      item->>'codeSandre' AS code_sandre,
      ST_SetSRID(
        ST_GeomFromGeoJSON((item->'geometry')::text),
        4326
      ) AS raw_geometry
    FROM jsonb_array_elements($1::jsonb)
      WITH ORDINALITY AS input(item, ordinality)
  ), normalized AS (
    SELECT
      ordinal,
      code_sandre,
      raw_geometry,
      ST_Multi(
        CASE
          WHEN ST_IsValid(raw_geometry) THEN raw_geometry
          ELSE ST_CollectionExtract(
            ST_MakeValid(raw_geometry, 'method=structure keepcollapsed=false'),
            3
          )
        END
      ) AS normalized_geometry
    FROM geometry_input
  ), measured AS (
    SELECT
      *,
      ST_Area(raw_geometry) AS raw_area,
      ST_Area(normalized_geometry) AS normalized_area
    FROM normalized
  )
  SELECT
    ordinal,
    code_sandre,
    ST_AsGeoJSON(normalized_geometry, 15, 0)::jsonb AS geometry,
    ST_IsValid(raw_geometry) AS raw_valid,
    ST_IsValidReason(raw_geometry) AS invalid_reason,
    GeometryType(normalized_geometry) AS normalized_geometry_type,
    (
      NOT ST_IsEmpty(normalized_geometry)
      AND ST_IsValid(normalized_geometry)
      AND GeometryType(normalized_geometry) = 'MULTIPOLYGON'
      AND ST_XMin(Box3D(normalized_geometry)) >= -180
      AND ST_XMax(Box3D(normalized_geometry)) <= 180
      AND ST_YMin(Box3D(normalized_geometry)) >= -90
      AND ST_YMax(Box3D(normalized_geometry)) <= 90
    ) AS normalized_valid,
    (
      ST_XMin(Box3D(normalized_geometry)) = ST_XMin(Box3D(raw_geometry))
      AND ST_XMax(Box3D(normalized_geometry)) = ST_XMax(Box3D(raw_geometry))
      AND ST_YMin(Box3D(normalized_geometry)) = ST_YMin(Box3D(raw_geometry))
      AND ST_YMax(Box3D(normalized_geometry)) = ST_YMax(Box3D(raw_geometry))
    ) AS bbox_unchanged,
    CASE
      WHEN GREATEST(abs(raw_area), abs(normalized_area)) = 0 THEN 0
      ELSE abs(normalized_area - raw_area)
        / GREATEST(abs(raw_area), abs(normalized_area))
    END::double precision AS relative_area_delta
  FROM measured
  ORDER BY ordinal
`

const UPSERT_ZONES_SQL = `
  WITH zone_input AS (
    SELECT item
    FROM jsonb_array_elements($1::jsonb) AS input(item)
  ), prepared AS (
    SELECT
      (item->>'id')::uuid AS id,
      item->>'codeSandre' AS code_sandre,
      (item->>'gid')::integer AS gid,
      item->>'name' AS name,
      (item->>'type')::"SandreAlertZoneType" AS type,
      (item->>'status')::"SandreAlertZoneStatus" AS status,
      item->>'departmentCode' AS department_code,
      (item->>'basinCode')::integer AS basin_code,
      (item->>'version')::integer AS version,
      (item->>'influencedResource')::boolean AS influenced_resource,
      item->'alternateCodes' AS alternate_codes,
      NULLIF(item->>'preferredAlternateCode', '') AS preferred_alternate_code,
      (item->>'sourceUpdatedAt')::date AS source_updated_at,
      item->>'payloadHash' AS payload_hash,
      (item->>'active')::boolean AS active,
      CASE
        WHEN item->'geometry' IS NULL OR item->'geometry' = 'null'::jsonb THEN NULL
        ELSE ST_Multi(
          ST_SetSRID(
            ST_GeomFromGeoJSON((item->'geometry')::text),
            4326
          )
        )::geometry(MultiPolygon,4326)
      END AS coordinates
    FROM zone_input
  )
  INSERT INTO "SandreAlertZone" (
    "id",
    "codeSandre",
    "gid",
    "name",
    "type",
    "status",
    "departmentCode",
    "basinCode",
    "version",
    "influencedResource",
    "alternateCodes",
    "preferredAlternateCode",
    "sourceUpdatedAt",
    "payloadHash",
    "active",
    "coordinates",
    "lastSeenAt",
    "createdAt",
    "updatedAt"
  )
  SELECT
    id,
    code_sandre,
    gid,
    name,
    type,
    status,
    department_code,
    basin_code,
    version,
    influenced_resource,
    alternate_codes,
    preferred_alternate_code,
    source_updated_at,
    payload_hash,
    active,
    coordinates,
    $2::timestamp,
    $2::timestamp,
    $2::timestamp
  FROM prepared
  ON CONFLICT ("codeSandre") DO UPDATE SET
    "gid" = EXCLUDED."gid",
    "name" = EXCLUDED."name",
    "type" = EXCLUDED."type",
    "status" = EXCLUDED."status",
    "departmentCode" = EXCLUDED."departmentCode",
    "basinCode" = EXCLUDED."basinCode",
    "version" = EXCLUDED."version",
    "influencedResource" = EXCLUDED."influencedResource",
    "alternateCodes" = EXCLUDED."alternateCodes",
    "preferredAlternateCode" = EXCLUDED."preferredAlternateCode",
    "sourceUpdatedAt" = EXCLUDED."sourceUpdatedAt",
    "payloadHash" = EXCLUDED."payloadHash",
    "active" = EXCLUDED."active",
    "coordinates" = COALESCE(EXCLUDED."coordinates", "SandreAlertZone"."coordinates"),
    "lastSeenAt" = EXCLUDED."lastSeenAt",
    "updatedAt" = EXCLUDED."updatedAt"
`

export async function normalizeSandreZoneGeometries(features, {database = prisma} = {}) {
  const geometricFeatures = features.filter(feature => feature.geometry !== null)
  if (geometricFeatures.length === 0) {
    return features
  }

  const rows = []
  for (let index = 0; index < geometricFeatures.length; index += GEOMETRY_NORMALIZATION_BATCH_SIZE) {
    const batch = geometricFeatures.slice(index, index + GEOMETRY_NORMALIZATION_BATCH_SIZE)
    // Les lots doivent rester séquentiels pour borner la charge CPU et mémoire de PostGIS.
    // eslint-disable-next-line no-await-in-loop
    const batchRows = await database.$queryRawUnsafe(
      NORMALIZE_GEOMETRIES_SQL,
      JSON.stringify(batch.map(feature => ({
        codeSandre: feature.codeSandre,
        geometry: feature.geometry
      })))
    )

    if (!Array.isArray(batchRows) || batchRows.length !== batch.length) {
      throw new Error(`La normalisation SANDRE a retourné ${batchRows?.length ?? 0}/${batch.length} géométries.`)
    }

    rows.push(...batchRows.map((row, rowIndex) => {
      if (Number(row.ordinal) !== rowIndex + 1) {
        const batchNumber = Math.floor(index / GEOMETRY_NORMALIZATION_BATCH_SIZE) + 1
        throw new Error(`La normalisation SANDRE a retourné un ordre incohérent pour le lot ${batchNumber}.`)
      }

      return {
        ...row,
        ordinal: index + rowIndex + 1
      }
    }))
  }

  const normalizedByCode = new Map()
  for (const [index, feature] of geometricFeatures.entries()) {
    const row = rows[index]
    const relativeAreaDelta = Number(row.relative_area_delta)
    if (
      Number(row.ordinal) !== index + 1
      || row.code_sandre !== feature.codeSandre
      || row.normalized_valid !== true
      || row.bbox_unchanged !== true
      || !row.geometry
      || !Number.isFinite(relativeAreaDelta)
      || relativeAreaDelta > MAX_RELATIVE_AREA_DELTA
    ) {
      throw new Error(
        `Normalisation de géométrie SANDRE non sûre pour ${feature.codeSandre} `
        + `(valid=${row.normalized_valid === true}, bbox=${row.bbox_unchanged === true}, aire=${relativeAreaDelta}).`
      )
    }

    normalizedByCode.set(feature.codeSandre, parseGeometry(row.geometry))
  }

  return features.map(feature => ({
    ...feature,
    geometry: normalizedByCode.get(feature.codeSandre) ?? null
  }))
}

export async function applySandreDepartmentSnapshot(
  departmentCode,
  snapshot,
  {
    database = prisma,
    now = new Date()
  } = {}
) {
  const zones = snapshot.features.map(feature => ({
    id: randomUUID(),
    ...feature,
    active: feature.status === 'VALIDATED'
  }))

  await database.$transaction(async transaction => {
    if (zones.length > 0) {
      await transaction.$executeRawUnsafe(UPSERT_ZONES_SQL, JSON.stringify(zones), now)
    }

    await transaction.sandreAlertZoneSyncState.upsert({
      where: {departmentCode},
      create: {
        departmentCode,
        lastAttemptAt: now,
        lastSuccessAt: now,
        lastError: null,
        featureCount: snapshot.featureCount,
        snapshotHash: snapshot.snapshotHash,
        sourceUpdatedAt: toDatabaseDate(snapshot.sourceUpdatedAt)
      },
      update: {
        lastAttemptAt: now,
        lastSuccessAt: now,
        lastError: null,
        featureCount: snapshot.featureCount,
        snapshotHash: snapshot.snapshotHash,
        sourceUpdatedAt: toDatabaseDate(snapshot.sourceUpdatedAt)
      }
    })
  }, {timeout: TRANSACTION_TIMEOUT_MS})
}

export async function synchronizeSandreAlertZones({
  apply = true,
  departmentCodes,
  database = prisma,
  fetchSnapshot = fetchSandreZoneSnapshot,
  normalizeGeometries = normalizeSandreZoneGeometries,
  concurrency = Number(process.env.SANDRE_SYNC_CONCURRENCY || DEFAULT_CONCURRENCY),
  acquireLock = true,
  lockClientFactory,
  logger = console
} = {}) {
  const run = async (assertLockHealthy = () => {}) => {
    const departments = departmentCodes
      ? normalizeDepartmentCodes(departmentCodes)
      : SANDRE_DEPARTMENT_CODES
    const fullSynchronization = !departmentCodes
    const startedAt = new Date()

    logger.log(
      `[sandre-zones] Synchronisation ${apply ? 'apply' : 'dry-run'} de ${departments.length} département(s).`
    )

    const results = await mapWithConcurrency(
      departments,
      normalizeConcurrency(concurrency),
      async departmentCode => {
        assertLockHealthy()
        return synchronizeDepartment(departmentCode, {
          apply,
          database,
          fetchSnapshot,
          normalizeGeometries,
          assertLockHealthy,
          logger
        })
      }
    )
    const failures = results.filter(result => result.error)
    const summary = {
      apply,
      departmentCount: departments.length,
      featureCount: results.reduce((sum, result) => sum + (result.featureCount ?? 0), 0),
      successCount: results.length - failures.length,
      failureCount: failures.length,
      durationMs: Date.now() - startedAt.getTime(),
      failures: failures.map(({departmentCode, error}) => ({
        departmentCode,
        message: error.message
      }))
    }

    if (failures.length > 0) {
      const error = new AggregateError(
        failures.map(result => result.error),
        `Échec de la synchronisation SANDRE pour ${failures.length} département(s).`
      )
      error.summary = summary
      throw error
    }

    if (apply && fullSynchronization) {
      assertLockHealthy()
      const seenCodes = [...new Set(results.flatMap(result => result.zoneCodes))]
      await deactivateMissingSandreAlertZones(seenCodes, {database})
      assertLockHealthy()
    }

    logger.log(
      `[sandre-zones] Terminé : ${summary.featureCount} zone(s), ${summary.departmentCount} département(s), ${summary.durationMs} ms.`
    )
    return summary
  }

  return acquireLock
    ? withSandreSyncLock(run, {clientFactory: lockClientFactory, logger})
    : run()
}

export async function deactivateMissingSandreAlertZones(seenCodes, {database = prisma} = {}) {
  return database.sandreAlertZone.updateMany({
    where: {
      active: true,
      codeSandre: {notIn: seenCodes}
    },
    data: {
      active: false,
      status: 'FROZEN'
    }
  })
}

export async function withSandreSyncLock(callback, {clientFactory, logger = console} = {}) {
  const client = clientFactory
    ? await clientFactory()
    : new Client({connectionString: process.env.DATABASE_URL, keepAlive: true})
  let lockError = null
  const onClientError = error => {
    lockError = error
    logger.error?.(`[sandre-zones] Connexion du verrou perdue : ${error.message}`)
  }

  client.on?.('error', onClientError)
  await client.connect()

  try {
    const lockResult = await client.query(
      'SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS acquired',
      [SANDRE_SYNC_LOCK_NAME]
    )
    if (lockResult.rows?.[0]?.acquired !== true) {
      logger.warn?.('[sandre-zones] Une synchronisation est déjà en cours, exécution ignorée.')
      return {skipped: true, reason: 'already-running'}
    }

    let heartbeatRunning = false
    const heartbeat = setInterval(async () => {
      if (heartbeatRunning || lockError) {
        return
      }

      heartbeatRunning = true
      try {
        await client.query('SELECT 1')
      } catch (error) {
        onClientError(error)
      } finally {
        heartbeatRunning = false
      }
    }, LOCK_HEARTBEAT_INTERVAL_MS)
    heartbeat.unref()
    const assertLockHealthy = () => {
      if (lockError) {
        throw new Error('Le verrou de synchronisation SANDRE a été perdu.', {cause: lockError})
      }
    }

    try {
      const result = await callback(assertLockHealthy)
      assertLockHealthy()
      return result
    } finally {
      clearInterval(heartbeat)
      if (!lockError) {
        await client.query(
          'SELECT pg_advisory_unlock(hashtext($1)::bigint)',
          [SANDRE_SYNC_LOCK_NAME]
        )
      }
    }
  } finally {
    try {
      await client.end()
    } catch (error) {
      onClientError(error)
    } finally {
      client.off?.('error', onClientError)
    }
  }
}

async function synchronizeDepartment(departmentCode, {
  apply,
  database,
  fetchSnapshot,
  normalizeGeometries,
  assertLockHealthy,
  logger
}) {
  const attemptedAt = new Date()

  try {
    const snapshot = await fetchSnapshot(departmentCode)
    assertLockHealthy()
    const features = await normalizeGeometries(snapshot.features, {database})
    assertLockHealthy()
    const normalizedSnapshot = {...snapshot, features}

    if (apply) {
      await applySandreDepartmentSnapshot(departmentCode, normalizedSnapshot, {database, now: attemptedAt})
    }

    logger.log(`[sandre-zones] ${departmentCode} : ${snapshot.featureCount} zone(s) validée(s).`)
    return {
      departmentCode,
      featureCount: snapshot.featureCount,
      zoneCodes: snapshot.features.map(feature => feature.codeSandre)
    }
  } catch (error) {
    logger.error?.(`[sandre-zones] ${departmentCode} : ${error.message}`)
    if (apply) {
      try {
        await recordSyncFailure(database, departmentCode, attemptedAt, error)
      } catch (stateError) {
        logger.error?.(`[sandre-zones] ${departmentCode} : état d'erreur non enregistré (${stateError.message}).`)
      }
    }

    return {departmentCode, error}
  }
}

async function recordSyncFailure(database, departmentCode, attemptedAt, error) {
  const lastError = String(error?.stack || error?.message || error).slice(0, 10_000)
  await database.sandreAlertZoneSyncState.upsert({
    where: {departmentCode},
    create: {
      departmentCode,
      lastAttemptAt: attemptedAt,
      lastError
    },
    update: {
      lastAttemptAt: attemptedAt,
      lastError
    }
  })
}

async function mapWithConcurrency(values, concurrency, callback) {
  const results = Array.from({length: values.length})
  let nextIndex = 0

  async function worker() {
    const index = nextIndex
    nextIndex += 1
    if (index >= values.length) {
      return
    }

    results[index] = await callback(values[index], index)
    return worker()
  }

  await Promise.all(Array.from(
    {length: Math.min(concurrency, values.length)},
    async () => worker()
  ))
  return results
}

function normalizeDepartmentCodes(departmentCodes) {
  const normalized = [...new Set(departmentCodes.map(code => String(code).trim().toUpperCase()))].sort()
  for (const code of normalized) {
    if (!/^(?:\d{2,3}|2[AB])$/.test(code)) {
      throw new Error(`Code département invalide : ${code}.`)
    }
  }

  return normalized
}

function normalizeConcurrency(value) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, MAX_CONCURRENCY) : DEFAULT_CONCURRENCY
}

function toDatabaseDate(value) {
  return value ? new Date(`${value}T00:00:00.000Z`) : null
}

function parseGeometry(value) {
  return typeof value === 'string' ? JSON.parse(value) : value
}
