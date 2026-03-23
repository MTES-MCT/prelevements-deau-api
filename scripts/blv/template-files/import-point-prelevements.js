// Noinspection JSNonASCIINames

import 'dotenv/config'

import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {parse} from 'csv-parse'
import {prisma} from '../../../db/prisma.js'
import {closeQueues} from '../../../lib/queues/config.js'
import {closeRedis} from '../../../lib/queues/redis.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const ROOT_DIR = path.resolve(__dirname, '../../../data/blv')
const DIR_PATTERN = /-template-file$/i

function getWaterBodyType(typeRaw) {
  switch (String(typeRaw ?? '').trim()) {
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

function normalizeCode(value) {
  const raw = String(value ?? '').trim()
  return raw || null
}

function parseLambertNumber(s) {
  const raw = String(s ?? '').trim()
  if (!raw) {
    return null
  }

  const normalized = raw.replaceAll(/\s/g, '').replace(',', '.')
  const n = Number(normalized)

  return Number.isFinite(n) ? n : null
}

function listTemplateReferentielCsvFiles() {
  const entries = fs.readdirSync(ROOT_DIR, {withFileTypes: true})

  const files = []

  for (const e of entries) {
    if (!e.isDirectory()) {
      continue
    }

    if (!DIR_PATTERN.test(e.name)) {
      continue
    }

    const referentielsDir = path.join(ROOT_DIR, e.name, 'referentiels')
    if (!fs.existsSync(referentielsDir) || !fs.statSync(referentielsDir).isDirectory()) {
      continue
    }

    const csvEntries = fs.readdirSync(referentielsDir, {withFileTypes: true})
    for (const ce of csvEntries) {
      if (ce.isFile() && ce.name.toLowerCase().endsWith('.csv')) {
        files.push(path.join(referentielsDir, ce.name))
      }
    }
  }

  return files
}

function getFileSourceId(filePath) {
  const referentielsDir = path.dirname(filePath)
  const templateDir = path.basename(path.dirname(referentielsDir))
  const csvName = path.basename(filePath, '.csv')

  return `${templateDir}-${csvName}`
}

async function importRow(row, fileSource) {
  const name = row.id_point_de_prelevement || row.id_point_de_prelevement_ou_rejet
  if (!name) {
    throw new Error('Le champ "id_point_de_prelevement" ou "id_point_de_prelevement_ou_rejet" est requis')
  }

  const sourceId = `blv-${fileSource}-${name}`

  const geoX = parseLambertNumber(row.x_lambert93)
  const geoY = parseLambertNumber(row.y_lambert93)

  if (geoX == null || geoY == null) {
    throw new Error(`Coordonnées invalides pour "${name}" (x=${row.x_lambert93}, y=${row.y_lambert93})`)
  }

  const waterBodyType = getWaterBodyType(row.type_point_prelevement)
  const codeEUMasseDEau = normalizeCode(row.code_masse_eau_européen)
  const codeBSS = normalizeCode(row.code_BSS)
  const codeOPR = normalizeCode(row.code_OPR)
  const codePTP = normalizeCode(row.code_PTP)
  const codeBDLISA = normalizeCode(row.code_BDLISA)
  const codeBDTopage = normalizeCode(row.code_BDTopage)
  const codeBDCarthage = normalizeCode(row.code_BDCarthage)
  const codeAIOT = normalizeCode(row.code_aiot)

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
          "codeEUMasseDEau" = $7,
          "codeBSS" = $8,
          "codeOPR" = $9,
          "codePTP" = $10,
          "codeBDLISA" = $11,
          "codeBDTopage" = $12,
          "codeBDCarthage" = $13,
          "codeAIOT" = $14,
          "updatedAt" = now(),
          "sourceId" = $6
        WHERE "id" = $1
      `,
      pointId,
      name,
      geoX,
      geoY,
      waterBodyType,
      sourceId,
      codeEUMasseDEau,
      codeBSS,
      codeOPR,
      codePTP,
      codeBDLISA,
      codeBDTopage,
      codeBDCarthage,
      codeAIOT
    )
  } else {
    const [{id}] = await prisma.$queryRawUnsafe(
      `
        INSERT INTO "PointPrelevement"
        (
          "id",
          "sourceId",
          "name",
          "waterBodyType",
          "coordinates",
          "codeEUMasseDEau",
          "codeBSS",
          "codeOPR",
          "codePTP",
          "codeBDLISA",
          "codeBDTopage",
          "codeBDCarthage",
          "codeAIOT",
          "createdAt",
          "updatedAt"
        )
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
                 $6,
                 $7,
                 $8,
                 $9,
                 $10,
                 $11,
                 $12,
                 $13,
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
      codeEUMasseDEau,
      codeBSS,
      codeOPR,
      codePTP,
      codeBDLISA,
      codeBDTopage,
      codeBDCarthage,
      codeAIOT
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

async function importFile(filePath) {
  const fileSource = getFileSourceId(filePath)

  const parser = fs
    .createReadStream(filePath)
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
      await importRow(row, fileSource)
    })

    count++
    if (count % 500 === 0) {
      console.log(`[import-point-prelevements-template-file] ${fileSource} ${count} points importés`)
    }
  }

  console.log(`[import-point-prelevements-template-file] ${fileSource} terminé (${count} points)`)
}

async function main() {
  console.log('[import-point-prelevements-template-file] start')

  const files = listTemplateReferentielCsvFiles()

  if (files.length === 0) {
    console.log('[import-point-prelevements-template-file] aucun fichier trouvé')
    return
  }

  console.log(`[import-point-prelevements-template-file] ${files.length} fichiers trouvés`)

  for (const filePath of files) {
    console.log(`[import-point-prelevements-template-file] import ${filePath}`)
    await importFile(filePath)
  }

  console.log('[import-point-prelevements-template-file] terminé')
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
