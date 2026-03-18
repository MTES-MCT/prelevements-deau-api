// Noinspection JSNonASCIINames

import 'dotenv/config'

import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {parse} from 'csv-parse'
import {prisma} from '../../../db/prisma.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const CSV_PATH = path.resolve(
  __dirname,
  '../../../data/blv/irrigants-aquasys/referentiels/donnees-brutes.csv'
)

function getWaterBodyType(typeMilieu) {
  switch (typeMilieu) {
    case 'Superficiel': {
      return 'SURFACE'
    }

    case 'Souterrain': {
      return 'SOUTERRAIN'
    }

    default: {
      return null
    }
  }
}

function parseNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null
  }

  const normalized = String(value).trim().replace(',', '.')
  const parsed = Number(normalized)

  if (Number.isNaN(parsed)) {
    throw new TypeError(`Nombre invalide : "${value}"`)
  }

  return parsed
}

function isLonLatCoordinates(x, y) {
  return Math.abs(x) <= 180 && Math.abs(y) <= 90
}

function getProjectionSRID(projection, geoX, geoY) {
  switch ((projection || '').trim()) {
    case 'Lambert 93': {
      return 2154
    }

    case 'WGS84 UTM30': {
      // Certaines lignes sont visiblement déjà en lon/lat malgré le libellé
      if (isLonLatCoordinates(geoX, geoY)) {
        return 4326
      }

      return 32_630
    }

    default: {
      throw new Error(`Projection non supportée : "${projection}"`)
    }
  }
}

async function upsertPointPrelevement({
  sourceId,
  name,
  waterBodyType,
  geoX,
  geoY,
  srid
}) {
  const existing
    = await prisma.pointPrelevement.findUnique({
      where: {sourceId}
    })
    || await prisma.pointPrelevement.findUnique({
      where: {name}
    })

  let pointId

  if (existing) {
    pointId = existing.id

    await prisma.$executeRawUnsafe(
      `
      UPDATE "PointPrelevement"
      SET
        "name" = $2,
        "waterBodyType" = $5,
        "coordinates" = CASE
          WHEN $6 = 4326 THEN ST_SetSRID(ST_MakePoint($3, $4), 4326)
          ELSE ST_Transform(
            ST_SetSRID(
              ST_MakePoint($3, $4),
              $6
            ),
            4326
          )
        END,
        "updatedAt" = now(),
        "sourceId" = $7
      WHERE "id" = $1
      `,
      pointId,
      name,
      geoX,
      geoY,
      waterBodyType,
      srid,
      sourceId
    )
  } else {
    const [{id}] = await prisma.$queryRawUnsafe(
      `
      INSERT INTO "PointPrelevement"
        ("id", "sourceId", "name", "waterBodyType", "coordinates", "createdAt", "updatedAt")
      VALUES (
        gen_random_uuid(),
        $1,
        $2,
        $5,
        CASE
          WHEN $6 = 4326 THEN ST_SetSRID(ST_MakePoint($3, $4), 4326)
          ELSE ST_Transform(
            ST_SetSRID(
              ST_MakePoint($3, $4),
              $6
            ),
            4326
          )
        END,
        now(),
        now()
      )
      RETURNING "id"
      `,
      sourceId,
      name,
      geoX,
      geoY,
      waterBodyType,
      srid
    )

    pointId = id
  }

  return pointId
}

async function refreshPointZones(pointId) {
  await prisma.pointPrelevementZone.deleteMany({
    where: {pointPrelevementId: pointId}
  })

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
    WHERE ST_Contains(
      z.coordinates,
      (SELECT coordinates FROM "PointPrelevement" WHERE id = $1)
    )
    `,
    pointId
  )
}

async function importRow(row) {
  const sourceId = `blv-${row['ID_Point_Prélèvement']}`
  const name = row['ID_Point_Prélèvement']

  const geoX = parseNumber(row.X)
  const geoY = parseNumber(row.Y)

  if (geoX === null || geoY === null) {
    throw new Error(
      `Coordonnées manquantes pour le point ${name} (X="${row.X}", Y="${row.Y}")`
    )
  }

  const srid = getProjectionSRID(row.Projection, geoX, geoY)
  const waterBodyType = getWaterBodyType(row['Type_Prélèvement'])

  const pointId = await upsertPointPrelevement({
    sourceId,
    name,
    waterBodyType,
    geoX,
    geoY,
    srid
  })

  await refreshPointZones(pointId)
}

async function main() {
  console.log('[import-point-prelevements] start')

  const parser = fs
    .createReadStream(CSV_PATH)
    .pipe(
      parse({
        columns: true,
        skip_empty_lines: true,
        trim: true
      })
    )

  let count = 0

  for await (const row of parser) {
    if (row['Libellé_UG'] === 'Bievre Liers Valloire') {
      await prisma.$transaction(async () => {
        await importRow(row)
      })

      count++

      if (count % 500 === 0) {
        console.log(`[import-point-prelevements] ${count} points importés`)
      }
    }
  }

  console.log(`[import-point-prelevements] terminé (${count} points)`)
}

try {
  await main()
} catch (error) {
  console.error(error)
  throw error
} finally {
  await prisma.$disconnect()
}
