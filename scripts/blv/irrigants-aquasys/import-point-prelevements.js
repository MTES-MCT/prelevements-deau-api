// Noinspection JSNonASCIINames

import 'dotenv/config'

import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {parse} from 'csv-parse'
import {prisma} from '../../../db/prisma.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const CSV_PATH = path.resolve(__dirname, '../../../data/blv/irrigants-aquasys/referentiels/donnees-brutes.csv')

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

async function importRow(row) {
  const sourceId = `blv-${row['ID_Point_Prélèvement']}`
  const name = row['ID_Point_Prélèvement']
  const geoX = row.X
  const geoY = row.Y

  const waterBodyType = getWaterBodyType(row['Type_Prélèvement'])

  // 1️⃣ Chercher le point par sourceId (Prisma)
  const existing = await prisma.pointPrelevement.findUnique({
    where: {sourceId}
  }) || await prisma.pointPrelevement.findUnique({
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
        "coordinates" = ST_Transform(
          ST_SetSRID(
            ST_MakePoint($3, $4),
            2154
          ),
          4326
        ),
        "updatedAt" = now(),
        "sourceId" = $6
      WHERE "id" = $1
      `,
      pointId,
      name,
      geoX,
      geoY,
      waterBodyType,
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
        ST_Transform(
          ST_SetSRID(
            ST_MakePoint($3, $4),
            2154
          ),
          4326
        ),
        now(),
        now()
      )
      RETURNING "id"
      `,
      sourceId,
      name,
      geoX,
      geoY,
      waterBodyType
    )
    pointId = id
  }

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
