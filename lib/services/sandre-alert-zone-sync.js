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
// Environ 0,11 mm à l'équateur : assez pour le bruit flottant, pas pour déplacer une limite métier.
const MAX_BBOX_DELTA_DEGREES = 1e-9
// À incrémenter dès que la normalisation, ses critères ou la matérialisation changent.
const SNAPSHOT_PROCESSING_VERSION = 1
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
  WITH geometry_input AS MATERIALIZED (
    SELECT
      ordinality::integer AS ordinal,
      item->>'codeSandre' AS code_sandre,
      ST_SetSRID(
        ST_GeomFromGeoJSON((item->'geometry')::text),
        4326
      ) AS raw_geometry
    FROM jsonb_array_elements($1::jsonb)
      WITH ORDINALITY AS input(item, ordinality)
  ), raw_assessment AS MATERIALIZED (
    SELECT
      *,
      ST_IsValid(raw_geometry) AS raw_valid,
      ST_IsValidReason(raw_geometry) AS invalid_reason
    FROM geometry_input
  ), normalized AS MATERIALIZED (
    SELECT
      ordinal,
      code_sandre,
      raw_geometry,
      raw_valid,
      invalid_reason,
      ST_Multi(
        CASE
          WHEN raw_valid THEN raw_geometry
          ELSE ST_CollectionExtract(
            ST_MakeValid(raw_geometry, 'method=structure keepcollapsed=false'),
            3
          )
        END
      ) AS normalized_geometry
    FROM raw_assessment
  ), boxed AS MATERIALIZED (
    SELECT
      *,
      Box3D(raw_geometry) AS raw_bbox,
      Box3D(normalized_geometry) AS normalized_bbox
    FROM normalized
  ), measured AS MATERIALIZED (
    SELECT
      ordinal,
      code_sandre,
      ST_AsGeoJSON(normalized_geometry, 15, 0)::jsonb AS geometry,
      raw_valid,
      invalid_reason,
      ST_IsEmpty(normalized_geometry) AS normalized_empty,
      ST_IsValid(normalized_geometry) AS normalized_geometry_valid,
      GeometryType(normalized_geometry) AS normalized_geometry_type,
      ST_XMin(raw_bbox)::double precision AS raw_xmin,
      ST_XMax(raw_bbox)::double precision AS raw_xmax,
      ST_YMin(raw_bbox)::double precision AS raw_ymin,
      ST_YMax(raw_bbox)::double precision AS raw_ymax,
      ST_XMin(normalized_bbox)::double precision AS normalized_xmin,
      ST_XMax(normalized_bbox)::double precision AS normalized_xmax,
      ST_YMin(normalized_bbox)::double precision AS normalized_ymin,
      ST_YMax(normalized_bbox)::double precision AS normalized_ymax,
      ST_Area(raw_geometry) AS raw_area,
      ST_Area(normalized_geometry) AS normalized_area
    FROM boxed
  ), audited AS MATERIALIZED (
    SELECT
      *,
      abs(normalized_xmin - raw_xmin)::double precision AS bbox_xmin_delta,
      abs(normalized_xmax - raw_xmax)::double precision AS bbox_xmax_delta,
      abs(normalized_ymin - raw_ymin)::double precision AS bbox_ymin_delta,
      abs(normalized_ymax - raw_ymax)::double precision AS bbox_ymax_delta
    FROM measured
  )
  SELECT
    ordinal,
    code_sandre,
    geometry,
    raw_valid,
    invalid_reason,
    normalized_geometry_type,
    (
      NOT normalized_empty
      AND normalized_geometry_valid
      AND normalized_geometry_type = 'MULTIPOLYGON'
      AND normalized_xmin >= -180
      AND normalized_xmax <= 180
      AND normalized_ymin >= -90
      AND normalized_ymax <= 90
    ) AS normalized_valid,
    bbox_xmin_delta,
    bbox_xmax_delta,
    bbox_ymin_delta,
    bbox_ymax_delta,
    GREATEST(
      bbox_xmin_delta,
      bbox_xmax_delta,
      bbox_ymin_delta,
      bbox_ymax_delta
    )::double precision AS max_bbox_delta,
    CASE
      WHEN GREATEST(abs(raw_area), abs(normalized_area)) = 0 THEN 0
      ELSE abs(normalized_area - raw_area)
        / GREATEST(abs(raw_area), abs(normalized_area))
    END::double precision AS relative_area_delta
  FROM audited
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

const STORED_ZONES_FOR_REUSE_SQL = `
  SELECT
    "codeSandre" AS code_sandre,
    "payloadHash" AS payload_hash,
    status::text AS status,
    active,
    coordinates IS NOT NULL AS has_coordinates
  FROM "SandreAlertZone"
  WHERE "departmentCode" = $1
    AND "codeSandre" IN (
      SELECT jsonb_array_elements_text($2::jsonb)
    )
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
    const relativeAreaDelta = parseFiniteMetric(row.relative_area_delta)
    const bboxDeltas = {
      xmin: parseFiniteMetric(row.bbox_xmin_delta),
      xmax: parseFiniteMetric(row.bbox_xmax_delta),
      ymin: parseFiniteMetric(row.bbox_ymin_delta),
      ymax: parseFiniteMetric(row.bbox_ymax_delta)
    }
    const reportedMaxBBoxDelta = parseFiniteMetric(row.max_bbox_delta)
    const bboxMetricsAreFinite = Object.values(bboxDeltas).every(Number.isFinite)
    const maxBBoxDelta = bboxMetricsAreFinite && Number.isFinite(reportedMaxBBoxDelta)
      ? Math.max(reportedMaxBBoxDelta, ...Object.values(bboxDeltas))
      : Number.NaN
    const rowIsSafe = [
      Number(row.ordinal) === index + 1,
      row.code_sandre === feature.codeSandre,
      row.normalized_valid === true,
      Boolean(row.geometry),
      Number.isFinite(relativeAreaDelta),
      relativeAreaDelta <= MAX_RELATIVE_AREA_DELTA,
      bboxMetricsAreFinite,
      Number.isFinite(maxBBoxDelta),
      maxBBoxDelta <= MAX_BBOX_DELTA_DEGREES
    ].every(Boolean)
    if (!rowIsSafe) {
      throw new Error(
        `Normalisation de géométrie SANDRE non sûre pour ${feature.codeSandre} `
        + `(valid=${row.normalized_valid === true}, rawValid=${row.raw_valid === true}, `
        + `type=${row.normalized_geometry_type ?? 'inconnu'}, `
        + `bboxDelta=${formatMetric(maxBBoxDelta)}, `
        + `bbox[xmin=${formatMetric(bboxDeltas.xmin)}, xmax=${formatMetric(bboxDeltas.xmax)}, `
        + `ymin=${formatMetric(bboxDeltas.ymin)}, ymax=${formatMetric(bboxDeltas.ymax)}], `
        + `aire=${formatMetric(relativeAreaDelta)}, raison=${row.invalid_reason ?? 'aucune'}).`
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

    await upsertSuccessfulSyncState(transaction, departmentCode, snapshot, now)
  }, {timeout: TRANSACTION_TIMEOUT_MS})
}

export function getProcessedSnapshotHash(snapshotHash) {
  return `geometry-v${SNAPSHOT_PROCESSING_VERSION}:${snapshotHash}`
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
    const snapshotIsReusable = await canReuseSandreDepartmentSnapshot(departmentCode, snapshot, {database})
    assertLockHealthy()
    if (snapshotIsReusable) {
      if (apply) {
        await markSandreDepartmentSnapshotSeen(departmentCode, snapshot, {database, now: attemptedAt})
        assertLockHealthy()
      }

      logger.log(`[sandre-zones] ${departmentCode} : snapshot inchangé, normalisation ignorée.`)
      return {
        departmentCode,
        featureCount: snapshot.featureCount,
        zoneCodes: snapshot.features.map(feature => feature.codeSandre),
        unchanged: true
      }
    }

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

async function canReuseSandreDepartmentSnapshot(departmentCode, snapshot, {database}) {
  const state = await database.sandreAlertZoneSyncState.findUnique({
    where: {departmentCode},
    select: {
      lastSuccessAt: true,
      featureCount: true,
      snapshotHash: true
    }
  })
  if (
    !state?.lastSuccessAt
    || state.featureCount !== snapshot.featureCount
    || state.snapshotHash !== getProcessedSnapshotHash(snapshot.snapshotHash)
  ) {
    return false
  }

  if (snapshot.features.length === 0) {
    return true
  }

  const storedZones = await database.$queryRawUnsafe(
    STORED_ZONES_FOR_REUSE_SQL,
    departmentCode,
    JSON.stringify(snapshot.features.map(feature => feature.codeSandre))
  )
  if (storedZones.length !== snapshot.features.length) {
    return false
  }

  const storedZonesByCode = new Map(storedZones.map(zone => [zone.code_sandre, zone]))
  return snapshot.features.every(feature => {
    const storedZone = storedZonesByCode.get(feature.codeSandre)
    return storedZone?.payload_hash === feature.payloadHash
      && storedZone.status === feature.status
      && storedZone.active === (feature.status === 'VALIDATED')
      && (feature.geometry === null || storedZone.has_coordinates === true)
  })
}

async function markSandreDepartmentSnapshotSeen(
  departmentCode,
  snapshot,
  {
    database,
    now = new Date()
  }
) {
  const zoneCodes = snapshot.features.map(feature => feature.codeSandre)
  await database.$transaction(async transaction => {
    if (zoneCodes.length > 0) {
      const updated = await transaction.sandreAlertZone.updateMany({
        where: {
          departmentCode,
          codeSandre: {in: zoneCodes}
        },
        data: {lastSeenAt: now}
      })
      if (updated.count !== zoneCodes.length) {
        throw new Error(
          `Le snapshot SANDRE inchangé de ${departmentCode} ne correspond plus aux zones stockées `
          + `(${updated.count}/${zoneCodes.length}).`
        )
      }
    }

    await upsertSuccessfulSyncState(transaction, departmentCode, snapshot, now)
  }, {timeout: TRANSACTION_TIMEOUT_MS})
}

async function upsertSuccessfulSyncState(database, departmentCode, snapshot, now) {
  const state = {
    lastAttemptAt: now,
    lastSuccessAt: now,
    lastError: null,
    featureCount: snapshot.featureCount,
    snapshotHash: getProcessedSnapshotHash(snapshot.snapshotHash),
    sourceUpdatedAt: toDatabaseDate(snapshot.sourceUpdatedAt)
  }
  await database.sandreAlertZoneSyncState.upsert({
    where: {departmentCode},
    create: {departmentCode, ...state},
    update: state
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

function parseFiniteMetric(value) {
  if (value === null || value === undefined || value === '') {
    return Number.NaN
  }

  return Number(value)
}

function formatMetric(value) {
  return Number.isFinite(value) ? String(value) : 'invalide'
}

function parseGeometry(value) {
  return typeof value === 'string' ? JSON.parse(value) : value
}
