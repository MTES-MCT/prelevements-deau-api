// Noinspection JSNonASCIINames

import 'dotenv/config'

import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import * as XLSX from 'xlsx'
import {prisma} from '../../../db/prisma.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const ROOT_DIR = path.resolve(__dirname, '../../../data/blv/industriels-icpe-gidaf')
const CADRES_FILENAME = /^cadres\.xlsx$/i

const COORDINATES_OVERRIDES = [
  {
    match: {x: 4.817_892_8, y: 6_453_707.85},
    resolved: {longitude: 4.813_651_5, latitude: 45.167_068_4}
  }
]

function clean(value) {
  const v = String(value ?? '').trim()
  return v || null
}

function normalizeSpaces(value) {
  return String(value ?? '')
    .replaceAll(/\s+/g, ' ')
    .trim()
}

function normalizeSourcePart(value) {
  return normalizeSpaces(value)
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036F]/g, '')
    .replaceAll(/[^a-zA-Z\d]+/g, '-')
    .replaceAll(/-+/g, '-')
    .replaceAll(/^-|-$/g, '')
    .toLowerCase()
}

function getWaterBodyType(milieuRaw) {
  const milieu = normalizeSpaces(milieuRaw).toLowerCase()

  if (!milieu) {
    return null
  }

  if (milieu.startsWith('eaux souterraines')) {
    return 'SOUTERRAIN'
  }

  if (milieu.startsWith('eaux superficielles')) {
    return 'SURFACE'
  }

  if (milieu.startsWith('eau potable')) {
    return null
  }

  return null
}

function parseCoordinate(value) {
  if (value == null || value === '') {
    return null
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }

  const normalized = String(value)
    .trim()
    .replaceAll(/\s/g, '')
    .replace(',', '.')

  if (!normalized) {
    return null
  }

  const n = Number(normalized)
  return Number.isFinite(n) ? n : null
}

function areSameCoordinate(a, b) {
  if (a == null || b == null) {
    return false
  }

  return Math.abs(a - b) < 0.000_001
}

function findCoordinatesOverride(x, y) {
  return COORDINATES_OVERRIDES.find(override =>
    areSameCoordinate(override.match.x, x) && areSameCoordinate(override.match.y, y)
  ) ?? null
}

function resolveCoordinatePayload(x, y) {
  const override = findCoordinatesOverride(x, y)
  if (override) {
    return {
      srid: 4326,
      x: override.resolved.longitude,
      y: override.resolved.latitude
    }
  }

  if (x == null || y == null) {
    return null
  }

  if (x > 100_000 && x < 1_400_000 && y > 6_000_000 && y < 7_200_000) {
    return {
      srid: 2154,
      x,
      y
    }
  }

  if (x >= -180 && x <= 180 && y >= -90 && y <= 90) {
    return {
      srid: 4326,
      x,
      y
    }
  }

  return null
}

function listCadresFiles() {
  const entries = fs.readdirSync(ROOT_DIR, {withFileTypes: true})
  const files = []

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    const monthDir = path.join(ROOT_DIR, entry.name)
    const childEntries = fs.readdirSync(monthDir, {withFileTypes: true})

    for (const child of childEntries) {
      if (child.isFile() && CADRES_FILENAME.test(child.name)) {
        files.push(path.join(monthDir, child.name))
      }
    }
  }

  return files.sort()
}

function readWorkbookRows(filePath) {
  const buffer = fs.readFileSync(filePath)
  const workbook = XLSX.read(buffer, {type: 'buffer', cellDates: false})
  const firstSheetName = workbook.SheetNames[0]

  if (!firstSheetName) {
    return []
  }

  const sheet = workbook.Sheets[firstSheetName]

  return XLSX.utils.sheet_to_json(sheet, {
    defval: null,
    raw: false
  })
}

function buildPointSourceId(row) {
  const codeInspection = clean(row['Code Inspection'])
  const pointName = clean(row['Point de surveillance'])
  const typePoint = clean(row['Type de point'])

  if (!codeInspection) {
    throw new Error(`Code Inspection manquant: ${JSON.stringify(row)}`)
  }

  if (!pointName) {
    throw new Error(`Point de surveillance manquant: ${JSON.stringify(row)}`)
  }

  return [
    'blv',
    'industriels-icpe-gidaf',
    normalizeSourcePart(codeInspection),
    normalizeSourcePart(pointName),
    normalizeSourcePart(typePoint || 'unknown')
  ].join('-')
}

function extractPointName(row) {
  const pointName = clean(row['Point de surveillance'])
  const socialReason = clean(row['Raison sociale'])
  const codeInspection = clean(row['Code Inspection'])

  if (!pointName) {
    throw new Error(`Point de surveillance manquant: ${JSON.stringify(row)}`)
  }

  return [
    normalizeSpaces(pointName),
    normalizeSpaces(socialReason || 'unknown'),
    normalizeSpaces(codeInspection || 'unknown')
  ].join(' - ')
}

async function upsertPoint(row, filePath) {
  const sourceId = buildPointSourceId(row)
  const name = extractPointName(row)
  const waterBodyType = getWaterBodyType(row.Milieu)

  const rawX = parseCoordinate(row['Coordonnées X'])
  const rawY = parseCoordinate(row['Coordonnées Y'])
  const coordinates = resolveCoordinatePayload(rawX, rawY)

  const existing = await prisma.pointPrelevement.findUnique({
    where: {sourceId}
  })

  let pointId

  if (existing) {
    pointId = existing.id

    if (coordinates) {
      await prisma.$executeRawUnsafe(
        `
          UPDATE "PointPrelevement"
          SET
            "name" = $2,
            "waterBodyType" = $3,
            "coordinates" = CASE
              WHEN $4 = 2154 THEN ST_Transform(ST_SetSRID(ST_MakePoint($5, $6), 2154), 4326)
              WHEN $4 = 4326 THEN ST_SetSRID(ST_MakePoint($5, $6), 4326)
              ELSE "coordinates"
            END,
            "updatedAt" = now()
          WHERE "id" = $1
        `,
        pointId,
        name,
        waterBodyType,
        coordinates.srid,
        coordinates.x,
        coordinates.y
      )
    } else {
      await prisma.pointPrelevement.update({
        where: {id: pointId},
        data: {
          name,
          waterBodyType
        }
      })
    }
  } else {
    if (!coordinates) {
      throw new Error(
        `Coordonnées invalides pour "${name}" dans ${filePath} (x=${row['Coordonnées X']}, y=${row['Coordonnées Y']})`
      )
    }

    const [{id}] = await prisma.$queryRawUnsafe(
      `
        INSERT INTO "PointPrelevement"
        ("id", "sourceId", "name", "waterBodyType", "coordinates", "createdAt", "updatedAt")
        VALUES (
          gen_random_uuid(),
          $1,
          $2,
          $3,
          CASE
            WHEN $4 = 2154 THEN ST_Transform(ST_SetSRID(ST_MakePoint($5, $6), 2154), 4326)
            WHEN $4 = 4326 THEN ST_SetSRID(ST_MakePoint($5, $6), 4326)
          END,
          now(),
          now()
        )
        RETURNING "id"
      `,
      sourceId,
      name,
      waterBodyType,
      coordinates.srid,
      coordinates.x,
      coordinates.y
    )

    pointId = id
  }

  if (coordinates) {
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
}

async function importFile(filePath) {
  const rows = readWorkbookRows(filePath)

  if (rows.length === 0) {
    console.log(`[import-point-prelevements-icpe] aucun enregistrement dans ${filePath}`)
    return
  }

  let count = 0

  for (const row of rows) {
    await prisma.$transaction(async () => {
      await upsertPoint(row, filePath)
    })

    count++

    if (count % 500 === 0) {
      console.log(`[import-point-prelevements-icpe] ${path.basename(path.dirname(filePath))} ${count} points importés`)
    }
  }

  console.log(`[import-point-prelevements-icpe] ${filePath} terminé (${count} lignes)`)
}

async function main() {
  console.log('[import-point-prelevements-icpe] start')

  const files = listCadresFiles()

  if (files.length === 0) {
    console.log('[import-point-prelevements-icpe] aucun fichier Cadres.xlsx trouvé')
    return
  }

  console.log(`[import-point-prelevements-icpe] ${files.length} fichiers trouvés`)

  for (const filePath of files) {
    console.log(`[import-point-prelevements-icpe] import ${filePath}`)
    await importFile(filePath)
  }

  console.log('[import-point-prelevements-icpe] terminé')
}

try {
  await main()
} catch (error) {
  console.error(error)
  throw error
} finally {
  await prisma.$disconnect()
}
