// Noinspection JSNonASCIINames

import 'dotenv/config'

import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {randomUUID} from 'node:crypto'

import {prisma} from '../../../db/prisma.js'
import createStorageClient from '../../../lib/util/s3.js'
import {DECLARATIONS_BUCKET, generateDossierCode, safeFilename} from '../../../lib/handlers/declarations.js'
import {addJobProcessDeclaration} from '../../../lib/queues/jobs.js'
import {closeQueues} from '../../../lib/queues/config.js'
import {closeRedis} from '../../../lib/queues/redis.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const VOLUMES_DIR = path.resolve(__dirname, '../../../data/blv/irrigants-aquasys/volumes')
const XLSX_PATTERN = /\.xlsx$/i
const OUGC_DECLARANT_SOURCE_ID = 'blv-aquasys-ougc'

function listVolumesXlsxFiles() {
  if (!fs.existsSync(VOLUMES_DIR) || !fs.statSync(VOLUMES_DIR).isDirectory()) {
    return []
  }

  const entries = fs.readdirSync(VOLUMES_DIR, {withFileTypes: true})

  return entries
    .filter(entry => entry.isFile() && XLSX_PATTERN.test(entry.name))
    .map(entry => path.join(VOLUMES_DIR, entry.name))
    .sort()
}

function getImportSourceId(filePath) {
  const filename = path.basename(filePath, path.extname(filePath))
  return `blv-import-${filename}`
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
          type: 'aquasys',
          comment,
          dataSourceType: 'SPREADSHEET',
          waterWithdrawalType: 'unknown'
        }
      })
      : await prisma.declaration.create({
        data: {
          id: randomUUID(),
          code: generateDossierCode(6),
          type: 'aquasys',
          declarantUserId,
          comment,
          importSourceId,
          dataSourceType: 'SPREADSHEET',
          waterWithdrawalType: 'unknown'
        }
      })

    const toDelete = (existing?.files ?? []).filter(file => file.type === 'aquasys')

    if (toDelete.length > 0) {
      await prisma.declarationFile.deleteMany({
        where: {
          declarationId: declaration.id,
          type: 'aquasys'
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
        type: 'aquasys',
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

async function importFile(filePath, declarantUserId) {
  const importSourceId = getImportSourceId(filePath)
  const originalname = path.basename(filePath)
  const comment = `Importé depuis le fichier Aquasys ${originalname}`

  const buffer = fs.readFileSync(filePath)

  if (!buffer?.length) {
    throw new Error(`Fichier vide: ${filePath}`)
  }

  await upsertDeclarationAndReplaceFile({
    importSourceId,
    declarantUserId,
    buffer,
    originalname,
    comment
  })
}

async function main() {
  console.log('[import-volumes-aquasys] start')

  const files = listVolumesXlsxFiles()

  if (files.length === 0) {
    console.log('[import-volumes-aquasys] aucun fichier trouvé')
    return
  }

  const declarant = await prisma.declarant.findUnique({
    where: {sourceId: OUGC_DECLARANT_SOURCE_ID},
    select: {userId: true}
  })

  if (!declarant?.userId) {
    throw new Error(
      `Declarant introuvable pour sourceId=${OUGC_DECLARANT_SOURCE_ID}. Lancer d'abord create-ougc-account.js`
    )
  }

  console.log(`[import-volumes-aquasys] ${files.length} fichiers trouvés`)

  let count = 0

  for (const filePath of files) {
    console.log(`[import-volumes-aquasys] import ${filePath}`)

    await importFile(filePath, declarant.userId)

    count++

    if (count % 25 === 0) {
      console.log(`[import-volumes-aquasys] ${count} fichiers importés`)
    }
  }

  console.log(`[import-volumes-aquasys] terminé (${count} fichiers)`)
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
