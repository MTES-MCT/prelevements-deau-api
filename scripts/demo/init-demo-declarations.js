// Noinspection JSNonASCIINames
import 'dotenv/config'

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {fileURLToPath} from 'node:url'
import {randomUUID} from 'node:crypto'
import ExcelJS from 'exceljs'

import {prisma} from '../../db/prisma.js'
import createStorageClient from '../../lib/util/s3.js'
import {
  DECLARATIONS_BUCKET,
  generateDossierCode,
  safeFilename
} from '../../lib/handlers/declarations.js'
import {addJobProcessDeclaration} from '../../lib/queues/jobs.js'
import {closeQueues} from '../../lib/queues/config.js'
import {closeRedis} from '../../lib/queues/redis.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const TEMPLATE_PATH = path.resolve(__dirname, './template_declaration.xlsx')

const OUTPUT_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'demo-declarations-2025-')
)

const YEAR = 2025

function mkdirp(dir) {
  fs.mkdirSync(dir, {recursive: true})
}

function pad(value) {
  return String(value).padStart(2, '0')
}

function monthKey(year, month) {
  return `${year}-${pad(month)}`
}

function getMonthStart(year, month) {
  return new Date(Date.UTC(year, month - 1, 1))
}

function getMonthEnd(year, month) {
  return new Date(Date.UTC(year, month, 0))
}

function formatDate(date) {
  const year = date.getUTCFullYear()
  const month = pad(date.getUTCMonth() + 1)
  const day = pad(date.getUTCDate())
  return `${year}-${month}-${day}`
}

function pseudoRandomInt(seed, min, max) {
  let h = 0
  const str = String(seed)

  for (let i = 0; i < str.length; i += 1) {
    h = Math.imul(31, h) + str.charCodeAt(i) | 0
  }

  const normalized = Math.abs(h) / 2147483647
  return Math.round(min + normalized * (max - min))
}

function pickUsage(usages = []) {
  if (usages.includes('IRRIGATION')) {
    return 'IRRIGATION'
  }

  if (usages.includes('INDUSTRIE')) {
    return 'INDUSTRIE'
  }

  if (usages.includes('AEP')) {
    return 'AEP'
  }

  return usages[0] ?? 'INCONNU'
}

function monthSeasonalityFactor(usage, month) {
  if (usage === 'IRRIGATION') {
    const factors = {
      1: 0.15,
      2: 0.2,
      3: 0.35,
      4: 0.6,
      5: 0.9,
      6: 1.15,
      7: 1.3,
      8: 1.2,
      9: 0.85,
      10: 0.45,
      11: 0.2,
      12: 0.1
    }

    return factors[month] ?? 1
  }

  if (usage === 'AEP') {
    const factors = {
      1: 0.95,
      2: 0.92,
      3: 0.96,
      4: 1.0,
      5: 1.05,
      6: 1.1,
      7: 1.18,
      8: 1.2,
      9: 1.08,
      10: 1.0,
      11: 0.96,
      12: 0.94
    }

    return factors[month] ?? 1
  }

  if (usage === 'INDUSTRIE') {
    const factors = {
      1: 0.92,
      2: 0.95,
      3: 1.0,
      4: 1.04,
      5: 1.08,
      6: 1.12,
      7: 0.9,
      8: 0.82,
      9: 1.02,
      10: 1.08,
      11: 1.04,
      12: 0.94
    }

    return factors[month] ?? 1
  }

  return 1
}

function computeMonthlyVolume({usage, pointName, declarantSourceId, year, month, pointIndex}) {
  const baseSeed = `base-${usage}-${pointName}-${declarantSourceId}-${pointIndex}`
  const noiseSeed = `noise-${usage}-${pointName}-${declarantSourceId}-${year}-${month}-${pointIndex}`

  let baseMin = 100
  let baseMax = 1000
  let noiseMin = 0.65
  let noiseMax = 1.35

  if (usage === 'IRRIGATION') {
    baseMin = 1500
    baseMax = 9000
    noiseMin = 0.45
    noiseMax = 1.55
  } else if (usage === 'INDUSTRIE') {
    baseMin = 800
    baseMax = 7000
    noiseMin = 0.6
    noiseMax = 1.45
  } else if (usage === 'AEP') {
    baseMin = 3000
    baseMax = 14000
    noiseMin = 0.75
    noiseMax = 1.25
  }

  const base = pseudoRandomInt(baseSeed, baseMin, baseMax)
  const seasonality = monthSeasonalityFactor(usage, month)
  const noisePercent = pseudoRandomInt(noiseSeed, Math.round(noiseMin * 100), Math.round(noiseMax * 100)) / 100

  const volume = Math.round(base * seasonality * noisePercent)

  return Math.max(volume, 0)
}

function filenameFor(declarantSourceId, year, month) {
  return `${declarantSourceId}-${monthKey(year, month)}.xlsx`
}

function importSourceIdFor(declarantSourceId, year, month) {
  return `demo-import-${declarantSourceId.replace(/^demo-declarant-/, '')}-${monthKey(year, month)}`
}

function declarationCommentFor(filename) {
  return `Importé depuis le fichier ${filename}`
}

function clearSheetRows(ws, startRow, endRow, columnCount) {
  for (let rowIndex = startRow; rowIndex <= endRow; rowIndex += 1) {
    const row = ws.getRow(rowIndex)

    for (let col = 1; col <= columnCount; col += 1) {
      row.getCell(col).value = null
    }
  }
}

async function listDemoDeclarants() {
  const declarants = await prisma.declarant.findMany({
    where: {
      sourceId: {
        startsWith: 'demo-declarant-'
      }
    },
    select: {
      userId: true,
      sourceId: true,
      socialReason: true,
      user: {
        select: {
          email: true
        }
      },
      pointPrelevements: {
        where: {
          pointPrelevement: {
            deletedAt: null
          }
        },
        select: {
          usages: true,
          pointPrelevement: {
            select: {
              id: true,
              name: true,
              sourceId: true
            }
          }
        },
        orderBy: {
          pointPrelevement: {
            sourceId: 'asc'
          }
        }
      }
    },
    orderBy: {
      sourceId: 'asc'
    }
  })

  return declarants.map(declarant => ({
    userId: declarant.userId,
    sourceId: declarant.sourceId,
    email: declarant.user.email,
    socialReason: declarant.socialReason,
    points: declarant.pointPrelevements.map((item, index) => ({
      index,
      id: item.pointPrelevement.id,
      name: item.pointPrelevement.name,
      sourceId: item.pointPrelevement.sourceId,
      usage: pickUsage(item.usages)
    }))
  }))
}

async function generateWorkbookBuffer({declarant, year, month}) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(TEMPLATE_PATH)

  const volumesSheet = workbook.getWorksheet('declaration_de_volume')

  if (!volumesSheet) {
    throw new Error('Feuille declaration_de_volume introuvable dans le template')
  }

  clearSheetRows(volumesSheet, 2, 5000, 14)

  const startDate = getMonthStart(year, month)
  const endDate = getMonthEnd(year, month)

  declarant.points.forEach((point, index) => {
    const volumePreleve = computeMonthlyVolume({
      usage: point.usage,
      pointName: point.name,
      declarantSourceId: declarant.sourceId,
      year,
      month,
      pointIndex: index
    })

    const isIndustrie = point.usage === 'INDUSTRIE'

    const volumeRejete = isIndustrie
      ? Math.round(
        volumePreleve * (
          pseudoRandomInt(
            `rejete-ratio-${point.name}-${declarant.sourceId}-${year}-${month}-${index}`,
            15,
            95
          ) / 100
        )
      )
      : null

    const rowIndex = 2 + index
    const row = volumesSheet.getRow(rowIndex)

    row.getCell(1).value = point.name
    row.getCell(2).value = formatDate(startDate)
    row.getCell(3).value = formatDate(endDate)
    row.getCell(4).value = volumePreleve
    row.getCell(6).value = volumeRejete
    row.commit()
  })

  return workbook.xlsx.writeBuffer()
}

async function upsertDeclarationAndReplaceFile({
                                                 importSourceId,
                                                 declarantUserId,
                                                 buffer,
                                                 originalname,
                                                 comment
                                               }) {
  const storage = createStorageClient(DECLARATIONS_BUCKET)

  const existing = await prisma.declaration.findUnique({
    where: {importSourceId},
    include: {files: true}
  })

  const uploadedKeys = []

  try {
    const declaration = existing
      ? await prisma.declaration.update({
        where: {id: existing.id},
        data: {
          declarant: {
            connect: {
              userId: declarantUserId
            }
          },
          type: 'template-file',
          comment,
          dataSourceType: 'SPREADSHEET',
          waterWithdrawalType: 'unknown',
          autoValidationEnabled: true,
        }
      })
      : await prisma.declaration.create({
        data: {
          id: randomUUID(),
          code: generateDossierCode(6),
          type: 'template-file',
          declarantUserId,
          comment,
          importSourceId,
          dataSourceType: 'SPREADSHEET',
          waterWithdrawalType: 'unknown',
          autoValidationEnabled: true,
        }
      })

    const toDelete = (existing?.files ?? []).filter(file => file.type === 'template-file')

    if (toDelete.length > 0) {
      await prisma.declarationFile.deleteMany({
        where: {
          declarationId: declaration.id,
          type: 'template-file'
        }
      })

      await Promise.all(toDelete.map(file => storage.deleteObject(file.storageKey, true))).catch(() => {})
    }

    const filename = safeFilename(originalname)
    const objectKey = `declarations/${declaration.id}/${randomUUID()}-${filename}`

    await storage.uploadObject(objectKey, buffer, {
      filename,
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    })

    uploadedKeys.push(objectKey)

    await prisma.declarationFile.create({
      data: {
        id: randomUUID(),
        declarationId: declaration.id,
        type: 'template-file',
        filename,
        storageKey: objectKey
      }
    })

    await addJobProcessDeclaration(declaration.id)

    return declaration
  } catch (error) {
    await Promise.all(uploadedKeys.map(key => storage.deleteObject(key, true))).catch(() => {})
    throw error
  }
}

async function createDeclarationsForDeclarant(declarant) {
  if (!declarant.points.length) {
    console.log(`SKIP ${declarant.email} aucun PP`)
    return
  }

  for (let month = 1; month <= 12; month += 1) {
    const filename = filenameFor(declarant.sourceId, YEAR, month)
    const importSourceId = importSourceIdFor(declarant.sourceId, YEAR, month)
    const comment = declarationCommentFor(filename)

    const buffer = await generateWorkbookBuffer({
      declarant,
      year: YEAR,
      month
    })

    mkdirp(OUTPUT_DIR)
    fs.writeFileSync(path.join(OUTPUT_DIR, filename), Buffer.from(buffer))

    await upsertDeclarationAndReplaceFile({
      importSourceId,
      declarantUserId: declarant.userId,
      buffer: Buffer.from(buffer),
      originalname: filename,
      comment
    })

    console.log(`OK ${declarant.email} ${monthKey(YEAR, month)} (${declarant.points.length} PP)`)
  }
}

async function main() {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    throw new Error(`Template introuvable: ${TEMPLATE_PATH}`)
  }

  mkdirp(OUTPUT_DIR)

  const declarants = await listDemoDeclarants()

  if (!declarants.length) {
    throw new Error('Aucun déclarant de démo trouvé')
  }

  for (const declarant of declarants) {
    await createDeclarationsForDeclarant(declarant)
  }

  console.log('Terminé')
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
