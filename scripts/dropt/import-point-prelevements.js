// Noinspection JSNonASCIINames

import '../../lib/config/env.js'

import {prisma} from '../../db/prisma.js'
import {closeQueues} from '../../lib/queues/config.js'
import {closeRedis} from '../../lib/queues/redis.js'
import {
  buildLocationDescription,
  buildOtherNames,
  buildPointComment,
  buildPointInternalComment,
  clean,
  getPointCodes,
  getWaterBodyType,
  normalizeCoordinates,
  readDroptRows
} from './lib/dropt-data.js'

function coordinatesSql() {
  return `
    CASE
      WHEN $6::int IS NULL OR $3::double precision IS NULL OR $4::double precision IS NULL THEN NULL
      WHEN $6 = 4326 THEN ST_SetSRID(ST_MakePoint($3, $4), 4326)
      ELSE ST_Transform(
        ST_SetSRID(
          ST_MakePoint($3, $4),
          $6
        ),
        4326
      )
    END
  `
}

async function refreshPointZones(pointId, hasCoordinates) {
  await prisma.pointPrelevementZone.deleteMany({
    where: {pointPrelevementId: pointId}
  })

  if (!hasCoordinates) {
    return []
  }

  await prisma.$executeRawUnsafe(
    `
    INSERT INTO "PointPrelevementZone"
      ("id", "pointPrelevementId", "zoneId", "createdAt")
    SELECT
      gen_random_uuid(),
      $1,
      z.id,
      now()
    FROM "Zone" z
    JOIN "PointPrelevement" pp ON pp.id = $1
    WHERE pp.coordinates IS NOT NULL
      AND ST_Contains(z.coordinates, pp.coordinates)
    ON CONFLICT ("pointPrelevementId", "zoneId") DO NOTHING
    `,
    pointId
  )

  return prisma.$queryRawUnsafe(
    `
    SELECT z.type, z.code, z.name
    FROM "PointPrelevementZone" ppz
    JOIN "Zone" z ON z.id = ppz."zoneId"
    WHERE ppz."pointPrelevementId" = $1
    ORDER BY z.type, z.name
    `,
    pointId
  )
}

async function upsertPointPrelevement(row) {
  const coordinates = normalizeCoordinates(row)
  const waterBodyType = getWaterBodyType(row)
  const otherNames = buildOtherNames(row)
  const locationDescription = buildLocationDescription(row)
  const pointComment = buildPointComment(row)
  const internalComment = buildPointInternalComment(row, coordinates)
  const {codePTP, codeOPR, codeAIOT, codeBNPE} = getPointCodes(row)

  const existing = await prisma.pointPrelevement.findUnique({
    where: {sourceId: row.pointSourceId}
  }) || await prisma.pointPrelevement.findUnique({
    where: {name: row.pointName}
  })

  let pointId

  if (existing) {
    pointId = existing.id

    await prisma.$executeRawUnsafe(
      `
      UPDATE "PointPrelevement"
      SET
        "name" = $2,
        "coordinates" = ${coordinatesSql()},
        "waterBodyType" = $5::"WaterBodyType",
        "sourceId" = $7,
        "otherNames" = $8,
        "streamName" = $9,
        "locationDescription" = $10,
        "geometryPrecision" = $11,
        "comment" = $12,
        "internalComment" = $13,
        "communeName" = $14,
        "codePTP" = $15,
        "codeOPR" = $16,
        "codeAIOT" = $17,
        "codeBNPE" = $18,
        "updatedAt" = now()
      WHERE "id" = $1
      `,
      pointId,
      row.pointName,
      coordinates.x,
      coordinates.y,
      waterBodyType,
      coordinates.srid,
      row.pointSourceId,
      otherNames,
      clean(row.ressourceLocale),
      locationDescription,
      'PAR_2026-2027 Dropt - coordonnées contrôlées par emprise géographique approximative puis zones PostGIS',
      pointComment,
      internalComment,
      clean(row.communeOuvrage),
      codePTP,
      codeOPR,
      codeAIOT,
      codeBNPE
    )
  } else {
    const [{id}] = await prisma.$queryRawUnsafe(
      `
      INSERT INTO "PointPrelevement"
        (
          "id",
          "sourceId",
          "name",
          "coordinates",
          "waterBodyType",
          "otherNames",
          "streamName",
          "locationDescription",
          "geometryPrecision",
          "comment",
          "internalComment",
          "communeName",
          "codePTP",
          "codeOPR",
          "codeAIOT",
          "codeBNPE",
          "createdAt",
          "updatedAt"
        )
      VALUES (
        gen_random_uuid(),
        $1,
        $2,
        ${coordinatesSql()},
        $5::"WaterBodyType",
        $7,
        $8,
        $9,
        $10,
        $11,
        $12,
        $13,
        $14,
        $15,
        $16,
        $17,
        now(),
        now()
      )
      RETURNING "id"
      `,
      row.pointSourceId,
      row.pointName,
      coordinates.x,
      coordinates.y,
      waterBodyType,
      coordinates.srid,
      otherNames,
      clean(row.ressourceLocale),
      locationDescription,
      'PAR_2026-2027 Dropt - coordonnées contrôlées par emprise géographique approximative puis zones PostGIS',
      pointComment,
      internalComment,
      clean(row.communeOuvrage),
      codePTP,
      codeOPR,
      codeAIOT,
      codeBNPE
    )

    pointId = id
  }

  const zones = await refreshPointZones(pointId, Boolean(coordinates.srid))
  const sageZones = zones.filter(zone => zone.type === 'SAGE')

  if (coordinates.srid && sageZones.length === 0) {
    console.warn(
      `[import-dropt-point-prelevements] ligne ${row.excelRowNumber}: aucune zone SAGE trouvée après import pour ${row.pointName} (${coordinates.note})`
    )
  }

  if (!coordinates.srid && coordinates.note !== 'coordonnées absentes ou nulles') {
    console.warn(
      `[import-dropt-point-prelevements] ligne ${row.excelRowNumber}: ${coordinates.note}`
    )
  }

  return {pointId, coordinates, sageZones}
}

async function main() {
  console.log('[import-dropt-point-prelevements] start')

  const rows = await readDroptRows()
  let count = 0

  for (const row of rows) {
    await prisma.$transaction(async () => {
      await upsertPointPrelevement(row)
    })

    count++
    if (count % 250 === 0) {
      console.log(`[import-dropt-point-prelevements] ${count} points importés`)
    }
  }

  console.log(`[import-dropt-point-prelevements] terminé (${count} points)`)
}

try {
  await main()
} catch (error) {
  console.error(error)
  throw error
} finally {
  await closeQueues()
  await closeRedis()
  await prisma.$disconnect()
}
