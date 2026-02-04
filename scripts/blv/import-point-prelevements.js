import 'dotenv/config'

import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {parse} from 'csv-parse'
import {prisma} from '../../db/prisma.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const CSV_PATH = path.resolve(__dirname, '../../data/point-prelevement.csv')

async function importRow(row) {
  const sourceId = `blv-${row.id_point}`
  const name = row.nom
  const geomHex = row.geom

  // 1️⃣ Chercher le point par sourceId (Prisma)
  const existing = await prisma.pointPrelevement.findUnique({
    where: {sourceId}
  })

  let pointId

  if (existing) {
    pointId = existing.id

    await prisma.$executeRawUnsafe(
      `
      UPDATE "PointPrelevement"
      SET
        "name" = $2,
        "coordinates" = ST_Transform(
          ST_SetSRID(
            ST_GeomFromEWKB(decode($3, 'hex')),
            32740
          ),
          4326
        ),
        "updatedAt" = now()
      WHERE "id" = $1
      `,
      pointId,
      name,
      geomHex
    )
  } else {
    const [{id}] = await prisma.$queryRawUnsafe(
      `
      INSERT INTO "PointPrelevement"
        ("id", "sourceId", "name", "coordinates", "createdAt", "updatedAt")
      VALUES (
        gen_random_uuid(),
        $1,
        $2,
        ST_Transform(
          ST_SetSRID(
            ST_GeomFromEWKB(decode($3, 'hex')),
            32740
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
      geomHex
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
    await prisma.$transaction(async () => {
      await importRow(row)
    })

    count++
    if (count % 500 === 0) {
      console.log(`[import-point-prelevements] ${count} points importés`)
    }
  }

  console.log(`[import-point-prelevements] terminé (${count} points)`)
}

main()
  .catch(error => {
    console.error(error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
