// Noinspection JSNonASCIINames

import 'dotenv/config'

import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {randomUUID} from 'node:crypto'
import * as XLSX from 'xlsx'

import {prisma} from '../../../db/prisma.js'
import createStorageClient from '../../../lib/util/s3.js'
import {DECLARATIONS_BUCKET, generateDossierCode, safeFilename} from '../../../lib/handlers/declarations.js'
import {addJobProcessDeclaration} from '../../../lib/queues/jobs.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const ROOT_DIR = path.resolve(__dirname, '../../../data/blv/industriels-icpe-gidaf')
const PRELEVEMENTS_FILENAME = /^prelevements.*\.xlsx$/i

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

function normalizeSiret(value) {
  const raw = String(value ?? '').trim()
  if (!raw) {
    return null
  }

  const digits = raw.replaceAll(/\D/g, '')
  return digits ? digits.slice(0, 14) : null
}

function listPrelevementsFiles() {
  const entries = fs.readdirSync(ROOT_DIR, {withFileTypes: true})
  const files = []

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    const monthDir = path.join(ROOT_DIR, entry.name)
    const childEntries = fs.readdirSync(monthDir, {withFileTypes: true})

    for (const child of childEntries) {
      if (child.isFile() && PRELEVEMENTS_FILENAME.test(child.name)) {
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

function getFileMonthKey(filePath) {
  return path.basename(path.dirname(filePath))
}

function buildGroupKey(row) {
  const codeInspection = clean(row['Code Inspection'])
  if (!codeInspection) {
    throw new Error(`Code Inspection manquant: ${JSON.stringify(row)}`)
  }

  return codeInspection
}

function buildImportSourceId({monthKey, codeInspection}) {
  return `blv-import-industriels-icpe-gidaf-${normalizeSourcePart(monthKey)}-${normalizeSourcePart(codeInspection)}`
}

function buildDeclarationFilename({monthKey, codeInspection, socialReason}) {
  const base = [
    'gidaf',
    monthKey,
    codeInspection,
    normalizeSourcePart(socialReason || 'unknown')
  ].join('-')

  return `${base}.xlsx`
}

function buildWorkbookBuffer(rows) {
  const headers = [
    'Code Inspection',
    'Raison sociale',
    'SIRET',
    'Point de surveillance',
    'Type de point',
    'Date de mesure',
    'Volume (m3)'
  ]

  const normalizedRows = rows.map(row => ({
    'Code Inspection': clean(row['Code Inspection']),
    'Raison sociale': clean(row['Raison sociale']),
    SIRET: clean(row.SIRET),
    'Point de surveillance': clean(row['Point de surveillance']),
    'Type de point': clean(row['Type de point']),
    'Date de mesure': clean(row['Date de mesure']),
    'Volume (m3)': clean(row['Volume (m3)'])
  }))

  const worksheet = XLSX.utils.json_to_sheet(normalizedRows, {header: headers})
  const workbook = XLSX.utils.book_new()

  XLSX.utils.book_append_sheet(workbook, worksheet, 'Prelevements')

  return XLSX.write(workbook, {
    bookType: 'xlsx',
    type: 'buffer'
  })
}

async function resolveDeclarantUserId(row) {
  const socialReason = clean(row['Raison sociale'])
  const siret = normalizeSiret(row.SIRET)

  if (siret) {
    const declarantBySiret = await prisma.declarant.findFirst({
      where: {siret},
      select: {userId: true}
    })

    if (declarantBySiret?.userId) {
      return declarantBySiret.userId
    }
  }

  if (socialReason) {
    const declarantBySocialReason = await prisma.declarant.findFirst({
      where: {
        socialReason: {
          equals: socialReason,
          mode: 'insensitive'
        }
      },
      select: {userId: true}
    })

    if (declarantBySocialReason?.userId) {
      return declarantBySocialReason.userId
    }

    const fallbackSourceId = `blv-industriels-icpe-gidaf-declarant-${normalizeSourcePart(socialReason)}`
    const declarantBySourceId = await prisma.declarant.findUnique({
      where: {sourceId: fallbackSourceId},
      select: {userId: true}
    })

    if (declarantBySourceId?.userId) {
      return declarantBySourceId.userId
    }
  }

  throw new Error(
    `Déclarant introuvable pour raison sociale="${socialReason ?? ''}" siret="${siret ?? ''}"`
  )
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
          declarantUserId,
          type: 'gidaf',
          comment,
          dataSourceType: 'SPREADSHEET',
          waterWithdrawalType: 'unknown'
        }
      })
      : await prisma.declaration.create({
        data: {
          id: randomUUID(),
          code: generateDossierCode(6),
          type: 'gidaf',
          declarantUserId,
          comment,
          importSourceId,
          dataSourceType: 'SPREADSHEET',
          waterWithdrawalType: 'unknown'
        }
      })

    const toDelete = (existing?.files ?? []).filter(file => file.type === 'gidaf')

    if (toDelete.length > 0) {
      await prisma.declarationFile.deleteMany({
        where: {
          declarationId: declaration.id,
          type: 'gidaf'
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
        type: 'gidaf',
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

async function importGroup({monthKey, codeInspection, rows}) {
  const firstRow = rows[0]
  if (!firstRow) {
    return
  }

  const socialReason = clean(firstRow['Raison sociale'])
  const declarantUserId = await resolveDeclarantUserId(firstRow)

  const importSourceId = buildImportSourceId({monthKey, codeInspection})
  const originalname = buildDeclarationFilename({monthKey, codeInspection, socialReason})
  const comment = `Import GIDAF ${monthKey} - Code Inspection ${codeInspection}`

  const buffer = buildWorkbookBuffer(rows)

  await upsertDeclarationAndReplaceFile({
    importSourceId,
    declarantUserId,
    buffer,
    originalname,
    comment
  })
}

async function importFile(filePath) {
  const monthKey = getFileMonthKey(filePath)
  const rows = readWorkbookRows(filePath)

  if (rows.length === 0) {
    console.log(`[import-volumes-icpe] aucun enregistrement dans ${filePath}`)
    return
  }

  const groups = new Map()

  for (const row of rows) {
    const codeInspection = buildGroupKey(row)

    if (!groups.has(codeInspection)) {
      groups.set(codeInspection, [])
    }

    groups.get(codeInspection).push(row)
  }

  let count = 0

  for (const [codeInspection, groupRows] of groups.entries()) {
    await importGroup({
      monthKey,
      codeInspection,
      rows: groupRows
    })

    count++

    if (count % 100 === 0) {
      console.log(`[import-volumes-icpe] ${monthKey} ${count} déclarations importées`)
    }
  }

  console.log(`[import-volumes-icpe] ${filePath} terminé (${count} déclarations)`)
}

async function main() {
  console.log('[import-volumes-icpe] start')

  const files = listPrelevementsFiles()

  if (files.length === 0) {
    console.log('[import-volumes-icpe] aucun fichier Prelevements trouvé')
    return
  }

  console.log(`[import-volumes-icpe] ${files.length} fichiers trouvés`)

  let count = 0

  for (const filePath of files) {
    console.log(`[import-volumes-icpe] import ${filePath}`)
    await importFile(filePath)
    count++
  }

  console.log(`[import-volumes-icpe] terminé (${count} fichiers)`)
}

try {
  await main()
} catch (error) {
  console.error(error)
  throw error
} finally {
  await prisma.$disconnect()
}
