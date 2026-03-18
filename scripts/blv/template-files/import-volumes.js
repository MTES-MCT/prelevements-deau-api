// Noinspection JSNonASCIINames

import 'dotenv/config'

import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {prisma} from '../../../db/prisma.js'
import createStorageClient from '../../../lib/util/s3.js'
import {DECLARATIONS_BUCKET, generateDossierCode, safeFilename} from '../../../lib/handlers/declarations.js'
import {extractTemplateFile} from '@fabnum/prelevements-deau-timeseries-parsers'
import {randomUUID} from 'node:crypto'
import {addJobProcessDeclaration} from '../../../lib/queues/jobs.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const ROOT_DIR = path.resolve(__dirname, '../../../data/blv')
const DIR_PATTERN = /-template-file$/i
const XLSX_PATTERN = /\.xlsx$/i

function listTemplateVolumesXlsxFiles() {
  const entries = fs.readdirSync(ROOT_DIR, {withFileTypes: true})

  const files = []

  for (const e of entries) {
    if (!e.isDirectory()) {
      continue
    }

    if (!DIR_PATTERN.test(e.name)) {
      continue
    }

    const volumesDir = path.join(ROOT_DIR, e.name, 'volumes')
    if (!fs.existsSync(volumesDir) || !fs.statSync(volumesDir).isDirectory()) {
      continue
    }

    const xlsxEntries = fs.readdirSync(volumesDir, {withFileTypes: true})
    for (const xe of xlsxEntries) {
      if (xe.isFile() && XLSX_PATTERN.test(xe.name)) {
        files.push(path.join(volumesDir, xe.name))
      }
    }
  }

  return files
}

function getImportSourceId(filePath) {
  const filename = path.basename(filePath, path.extname(filePath))
  return `blv-import-${filename}`
}

function normalizeSiret(s) {
  const raw = String(s ?? '').trim()
  if (!raw) {
    return null
  }

  const digits = raw.replaceAll(/\s+/g, '').replaceAll(/\D/g, '')
  if (!digits) {
    return null
  }

  return digits.slice(0, 14) || null
}

function extractUniqueSiretFromTemplateData(data) {
  const preleveurs = data?.metadata?.preleveurs ?? []
  const sirets = preleveurs
    .map(p => normalizeSiret(p?.siret))
    .filter(Boolean)

  const unique = [...new Set(sirets)]

  if (unique.length === 0) {
    throw new Error('Aucun SIRET trouvé dans data.metadata.preleveurs')
  }

  if (unique.length !== 1) {
    throw new Error(`Plusieurs SIRET trouvés dans le fichier: ${unique.join(', ')}`)
  }

  return unique[0]
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
        }
      })

    const toDelete = (existing?.files ?? []).filter(f => f.type === 'template-file')
    if (toDelete.length > 0) {
      await prisma.declarationFile.deleteMany({
        where: {
          declarationId: declaration.id,
          type: 'template-file'
        }
      })

      await Promise.all(toDelete.map(f => storage.deleteObject(f.storageKey, true))).catch(() => {})
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
    await Promise.all(uploadedKeys.map(k => storage.deleteObject(k, true))).catch(() => {})
    throw error
  }
}

async function importFile(filePath) {
  const importSourceId = getImportSourceId(filePath)
  const originalname = path.basename(filePath)
  const comment = `Importé depuis le fichier ${originalname}`

  const buffer = fs.readFileSync(filePath)
  if (!buffer?.length) {
    throw new Error(`Fichier vide: ${filePath}`)
  }

  const result = await extractTemplateFile(buffer)
  const data = result?.data

  if (!data) {
    throw new Error(`Aucune donnée extraite (extractTemplateFile) pour ${originalname}`)
  }

  const siret = extractUniqueSiretFromTemplateData(data)

  const declarant = await prisma.declarant.findFirst({
    where: {siret},
    select: {userId: true}
  })

  if (!declarant?.userId) {
    throw new Error(`Declarant introuvable pour siret=${siret} (fichier=${originalname})`)
  }

  await upsertDeclarationAndReplaceFile({
    importSourceId,
    declarantUserId: declarant.userId,
    buffer,
    originalname,
    comment
  })
}

async function main() {
  console.log('[import-volumes] start')

  const files = listTemplateVolumesXlsxFiles()

  if (files.length === 0) {
    console.log('[import-volumes] aucun fichier trouvé')
    return
  }

  console.log(`[import-volumes] ${files.length} fichiers trouvés`)

  let count = 0

  for (const filePath of files) {
    console.log(`[import-volumes] import ${filePath}`)

    await prisma.$transaction(async () => {
      await importFile(filePath)
    })

    count++
    if (count % 25 === 0) {
      console.log(`[import-volumes] ${count} fichiers importés`)
    }
  }

  console.log(`[import-volumes] terminé (${count} fichiers)`)
}

try {
  await main()
} catch (error) {
  console.error(error)
  throw error
} finally {
  await prisma.$disconnect()
}
