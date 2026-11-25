import {fetchPtgeSnapshot} from './gesteau-ptge.js'

// Stage the complete catalogue. A NULL source geometry and an invalid one have
// different meanings: only the former can withdraw a previously published contour.
const STAGE_SOURCE = `
  CREATE TEMP TABLE ptge_source ON COMMIT DROP AS
  WITH raw AS MATERIALIZED (
    SELECT code, name, "progressStatus" AS status,
      CASE WHEN geometry IS NOT NULL THEN ST_GeomFromGeoJSON(geometry) END AS geom
    FROM jsonb_to_recordset($1::jsonb) AS s(code text, name text, "progressStatus" text, geometry jsonb)
  ), assessed AS MATERIALIZED (
    SELECT *, ST_IsValid(geom) AS valid FROM raw
  )
  SELECT code, name, status, geom AS original_geom, valid IS FALSE AS repaired,
    ST_Multi(CASE WHEN valid THEN geom
      ELSE ST_CollectionExtract(ST_MakeValid(geom, 'method=linework'), 3)
    END) AS geom
  FROM assessed
`

const VALIDATE_SOURCE = `
  SELECT code FROM ptge_source
  WHERE original_geom IS NOT NULL AND (
    geom IS NULL OR ST_IsEmpty(geom) OR NOT ST_IsValid(geom) OR GeometryType(geom) <> 'MULTIPOLYGON'
    OR ST_SRID(geom) <> 4326 OR ST_NDims(geom) <> 2 OR NOT (ST_Area(geom) > 0)
    OR ST_XMin(geom) < -180 OR ST_XMax(geom) > 180 OR ST_YMin(geom) < -90 OR ST_YMax(geom) > 90
    -- For holes outside the first shell, the raw Polygon envelope can itself omit islands.
    OR (repaired AND NOT ST_Equals(
      (SELECT ST_Envelope(ST_Collect(p.geom)) FROM ST_DumpPoints(original_geom) p), ST_Envelope(geom)
    ))
  )
  ORDER BY code
`

const STAGE_ZONE_CHANGES = `
  CREATE TEMP TABLE ptge_zone_changes ON COMMIT DROP AS
  WITH stored AS (
    SELECT id, "sourceCode" AS code, name, "progressStatus" AS status, coordinates AS geom
    FROM "Zone" WHERE type = 'PTGE' AND "sourceCode" IS NOT NULL
  )
  SELECT COALESCE(stored.id, gen_random_uuid()) AS id, COALESCE(src.code, stored.code) AS code,
    COALESCE(src.name, stored.name) AS name, COALESCE(src.status, stored.status) AS status,
    src.geom, stored.id IS NULL AS created, stored.geom IS DISTINCT FROM src.geom AS geometry_changed,
    stored.geom IS NOT NULL AND src.geom IS NULL AS withdrawn
  FROM ptge_source src FULL JOIN stored USING (code)
  WHERE (stored.id IS NULL AND src.geom IS NOT NULL)
     OR (stored.id IS NOT NULL AND (
       stored.geom IS DISTINCT FROM src.geom OR (src.code IS NOT NULL AND
       (stored.name, stored.status) IS DISTINCT FROM (src.name, src.status))))
`

// Existing links cover the old footprint, including links outside its boundary.
// The GiST index supplies the candidate points for each changed new footprint.
const STAGE_POINT_CHANGES = `
  CREATE TEMP TABLE ptge_point_changes ON COMMIT DROP AS
  WITH previous AS (
    SELECT l."pointPrelevementId" AS point_id, l."zoneId" AS zone_id
    FROM ptge_zone_changes z JOIN "PointPrelevementZone" l ON l."zoneId" = z.id
    WHERE z.geometry_changed
  ), expected AS (
    SELECT p.id AS point_id, z.id AS zone_id
    FROM ptge_zone_changes z JOIN "PointPrelevement" p ON ST_Covers(z.geom, p.coordinates)
    WHERE z.geometry_changed AND p."deletedAt" IS NULL
  )
  SELECT point_id, zone_id, previous.zone_id IS NULL AS added
  FROM previous FULL JOIN expected USING (point_id, zone_id)
  WHERE previous.zone_id IS NULL OR expected.zone_id IS NULL
`

const APPLY_ZONES = `
  INSERT INTO "Zone" (id, type, code, name, "sourceCode", "progressStatus", coordinates, "updatedAt")
  SELECT id, 'PTGE', 'ptge-' || code, name, code, status, geom, now() FROM ptge_zone_changes
  ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name, "progressStatus" = EXCLUDED."progressStatus",
      coordinates = EXCLUDED.coordinates, "updatedAt" = EXCLUDED."updatedAt"
`

async function stagePointChanges(client, apply) {
  if (apply) {
    await client.query('LOCK TABLE "PointPrelevement" IN SHARE MODE')
    await client.query('LOCK TABLE "PointPrelevementZone" IN SHARE ROW EXCLUSIVE MODE')
  }
  await client.query('ANALYZE ptge_zone_changes')
  await client.query(STAGE_POINT_CHANGES)
  const {rows: [counts]} = await client.query(`
    SELECT count(*) FILTER (WHERE added)::int AS added, count(*) FILTER (WHERE NOT added)::int AS removed
    FROM ptge_point_changes
  `)
  return counts
}

export async function importPtge(client, {apply = false, loadSnapshot = fetchPtgeSnapshot} = {}) {
  await client.query('BEGIN')
  try {
    // Acquire before fetching: an older, slower download cannot overwrite a newer one.
    const {rows: [lock]} = await client.query("SELECT pg_try_advisory_xact_lock(hashtext('partageonsleau:import:ptge')) AS acquired")
    if (!lock.acquired) throw new Error('Un import PTGE est déjà en cours.')
    const snapshot = await loadSnapshot()
    await client.query(STAGE_SOURCE, [JSON.stringify(snapshot)])
    const invalid = (await client.query(VALIDATE_SOURCE)).rows
    if (invalid.length) throw new Error(`Contours PTGE inutilisables après validation : ${invalid.map(row => row.code).join(', ')}.`)
    await client.query(STAGE_ZONE_CHANGES)
    const {rows: [zones]} = await client.query(`
      SELECT count(*) FILTER (WHERE created)::int AS created, count(*) FILTER (WHERE NOT created)::int AS updated,
        count(*) FILTER (WHERE geometry_changed)::int AS "changedContours",
        ARRAY(SELECT code FROM ptge_zone_changes WHERE withdrawn ORDER BY code) AS "withdrawnContours"
      FROM ptge_zone_changes
    `)
    const links = zones.changedContours ? await stagePointChanges(client, apply) : {added: 0, removed: 0}
    if (apply && zones.created + zones.updated > 0) await client.query(APPLY_ZONES)
    if (apply && links.removed > 0) {
      await client.query(`
        DELETE FROM "PointPrelevementZone" l USING ptge_point_changes c
        WHERE NOT c.added AND l."pointPrelevementId" = c.point_id AND l."zoneId" = c.zone_id
      `)
    }
    if (apply && links.added > 0) {
      await client.query(`
        INSERT INTO "PointPrelevementZone" (id, "pointPrelevementId", "zoneId")
        SELECT gen_random_uuid(), point_id, zone_id FROM ptge_point_changes WHERE added
        ON CONFLICT ("pointPrelevementId", "zoneId") DO NOTHING
      `)
    }
    const withoutContour = snapshot.filter(row => !row.geometry).map(({code, name}) => ({code, name}))
    const repairedContours = (await client.query('SELECT code FROM ptge_source WHERE repaired ORDER BY code')).rows.map(row => row.code)
    await client.query('COMMIT')
    return {apply, catalogue: snapshot.length, contours: snapshot.length - withoutContour.length, withoutContour, repairedContours, zones, links}
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}
