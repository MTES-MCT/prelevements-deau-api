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

const ROOT_DIR = path.resolve(__dirname, '../../../data/blv/industriels-icpe-gidaf')
const CADRES_FILENAME = /^cadres\.xlsx$/i
const PRELEVEMENTS_FILENAME = /^prelevements.*\.xlsx$/i

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

function listMonthDirs() {
  const entries = fs.readdirSync(ROOT_DIR, {withFileTypes: true})

  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(ROOT_DIR, entry.name))
    .sort()
}

function getImportSourceId(monthDirPath) {
  const monthKey = path.basename(monthDirPath)
  return `blv-import-industriels-icpe-gidaf-${normalizeSourcePart(monthKey)}`
}

function findMonthFiles(monthDirPath) {
  const entries = fs.readdirSync(monthDirPath, {withFileTypes: true})

  const cadresPath = entries.find(entry => entry.isFile() && CADRES_FILENAME.test(entry.name))
  const prelevementsPath = entries.find(entry => entry.isFile() && PRELEVEMENTS_FILENAME.test(entry.name))

  return {
    cadresPath: cadresPath ? path.join(monthDirPath, cadresPath.name) : null,
    prelevementsPath: prelevementsPath ? path.join(monthDirPath, prelevementsPath.name) : null
  }
}

async function resolveDeclarantUserId() {
  const fallbackDeclarant = await prisma.declarant.findUnique({
    where: {
      sourceId: 'blv-gidaf-brgl'
    },
    select: {
      userId: true
    }
  })

  if (fallbackDeclarant?.userId) {
    return fallbackDeclarant.userId
  }

  throw new Error('Declarant introuvable pour GIDAF. Lance d’abord create-gidaf-account.js')
}

async function upsertDeclarationAndReplaceFiles({
  importSourceId,
  declarantUserId,
  cadresFile,
  prelevementsFile,
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

    const toDelete = (existing?.files ?? []).filter(file =>
      ['gidaf', 'gidaf-cadres', 'gidaf-prelevements'].includes(file.type)
    )

    if (toDelete.length > 0) {
      await prisma.declarationFile.deleteMany({
        where: {
          declarationId: declaration.id,
          type: {
            in: ['gidaf', 'gidaf-cadres', 'gidaf-prelevements']
          }
        }
      })

      await Promise.all(toDelete.map(file => storage.deleteObject(file.storageKey, true))).catch(() => {})
    }

    for (const file of [
      {...cadresFile, type: 'gidaf-cadres'},
      {...prelevementsFile, type: 'gidaf-prelevements'}
    ]) {
      const filename = safeFilename(file.originalname)
      const objectKey = `declarations/${declaration.id}/${randomUUID()}-${filename}`

      await storage.uploadObject(objectKey, file.buffer, {
        filename,
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      })

      uploadedKeys.push(objectKey)

      await prisma.declarationFile.create({
        data: {
          id: randomUUID(),
          declarationId: declaration.id,
          type: file.type,
          filename,
          storageKey: objectKey
        }
      })
    }

    await addJobProcessDeclaration(declaration.id)

    return declaration
  } catch (error) {
    await Promise.all(uploadedKeys.map(key => storage.deleteObject(key, true))).catch(() => {})
    throw error
  }
}

async function importMonthDir(monthDirPath, fallbackCadresPath) {
  const monthKey = path.basename(monthDirPath)
  const importSourceId = getImportSourceId(monthDirPath)
  const comment = `Import GIDAF ${monthKey}`

  const {cadresPath, prelevementsPath} = findMonthFiles(monthDirPath)
  const effectiveCadresPath = cadresPath || fallbackCadresPath

  if (!effectiveCadresPath) {
    throw new Error(
      `Fichier Cadres.xlsx introuvable dans ${monthDirPath} et aucun fichier Cadres précédent disponible`
    )
  }

  if (!prelevementsPath) {
    throw new Error(`Fichier Prelevements introuvable dans ${monthDirPath}`)
  }

  const declarantUserId = await resolveDeclarantUserId()

  const cadresFile = {
    originalname: path.basename(effectiveCadresPath),
    buffer: fs.readFileSync(effectiveCadresPath)
  }

  const prelevementsFile = {
    originalname: path.basename(prelevementsPath),
    buffer: fs.readFileSync(prelevementsPath)
  }

  if (!cadresFile.buffer?.length) {
    throw new Error(`Fichier vide: ${cadresFile.originalname}`)
  }

  if (!prelevementsFile.buffer?.length) {
    throw new Error(`Fichier vide: ${prelevementsFile.originalname}`)
  }

  await upsertDeclarationAndReplaceFiles({
    importSourceId,
    declarantUserId,
    cadresFile,
    prelevementsFile,
    comment
  })

  return {
    usedCadresPath: effectiveCadresPath,
    currentCadresPath: cadresPath || null
  }
}

async function main() {
  console.log('[import-volumes-gidaf] start')

  const monthDirs = listMonthDirs()

  if (monthDirs.length === 0) {
    console.log('[import-volumes-gidaf] aucun dossier trouvé')
    return
  }

  console.log(`[import-volumes-gidaf] ${monthDirs.length} dossiers trouvés`)

  let count = 0
  let lastCadresPath = null

  for (const monthDirPath of monthDirs) {
    console.log(`[import-volumes-gidaf] import ${monthDirPath}`)

    const {usedCadresPath, currentCadresPath} = await importMonthDir(monthDirPath, lastCadresPath)

    if (currentCadresPath) {
      lastCadresPath = currentCadresPath
    }

    if (!currentCadresPath) {
      console.log(
        `[import-volumes-gidaf] aucun Cadres.xlsx dans ${path.basename(monthDirPath)}, réutilisation de ${usedCadresPath}`
      )
    }

    count++

    if (count % 25 === 0) {
      console.log(`[import-volumes-gidaf] ${count} dossiers importés`)
    }
  }

  console.log(`[import-volumes-gidaf] terminé (${count} dossiers)`)
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
