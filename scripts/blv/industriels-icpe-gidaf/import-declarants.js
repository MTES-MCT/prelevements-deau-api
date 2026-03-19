// Noinspection JSNonASCIINames

import 'dotenv/config'

import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import * as XLSX from 'xlsx'
import {prisma} from '../../../db/prisma.js'
import {closeQueues} from '../../../lib/queues/config.js'
import {closeRedis} from '../../../lib/queues/redis.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const ROOT_DIR = path.resolve(__dirname, '../../../data/blv/industriels-icpe-gidaf')
const CADRES_FILENAME = /^cadres\.xlsx$/i

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

function extractFirstEmail(value) {
  const raw = String(value ?? '').trim()
  if (!raw) {
    return null
  }

  const parts = raw
    .split(/[;,]/g)
    .map(part => part.trim())
    .filter(Boolean)

  for (const part of parts) {
    const match = part.match(/[\w.%+-]+@[a-z\d.-]+\.[a-z]{2,}/i)
    if (match) {
      return match[0].toLowerCase()
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

function buildDeclarantPayload(row) {
  const socialReason = clean(row['Raison sociale'])
  const siret = normalizeSiret(row.SIRET)

  if (!socialReason && !siret) {
    throw new Error(`Impossible d’identifier le déclarant: ${JSON.stringify(row)}`)
  }

  const uniqueKey = siret || socialReason
  const sourceId = `blv-industriels-icpe-gidaf-declarant-${normalizeSourcePart(uniqueKey)}`

  const email = extractFirstEmail(row['Adresse mail exploitant']) || `${sourceId}@import.local`

  return {
    sourceId,
    email,
    socialReason: socialReason || null,
    siret: siret || null,
    declarantType: 'LEGAL_PERSON',
    addressLine1: clean(row.Adresse),
    addressLine2: clean(row['Adresse complément']),
    postalCode: clean(row['Code INSEE']),
    city: clean(row.Commune),
    phoneNumber: null,
    civility: null,
    jobTitle: null
  }
}

async function importDeclarant(row) {
  const payload = buildDeclarantPayload(row)

  const existing = await prisma.declarant.findUnique({
    where: {sourceId: payload.sourceId},
    include: {user: true}
  })

  let declarantUserId

  if (existing) {
    declarantUserId = existing.userId

    await prisma.user.update({
      where: {id: declarantUserId},
      data: {
        email: payload.email,
        role: 'DECLARANT',
        firstName: null,
        lastName: null
      }
    })

    await prisma.declarant.update({
      where: {userId: declarantUserId},
      data: {
        sourceId: payload.sourceId,
        declarantType: payload.declarantType,
        socialReason: payload.socialReason,
        siret: payload.siret,
        addressLine1: payload.addressLine1,
        addressLine2: payload.addressLine2,
        postalCode: payload.postalCode,
        city: payload.city,
        phoneNumber: payload.phoneNumber,
        civility: payload.civility,
        jobTitle: payload.jobTitle
      }
    })

    return
  }

  const user = await prisma.user.upsert({
    where: {email: payload.email},
    update: {
      role: 'DECLARANT',
      firstName: null,
      lastName: null
    },
    create: {
      email: payload.email,
      role: 'DECLARANT',
      firstName: null,
      lastName: null
    }
  })

  declarantUserId = user.id

  await prisma.declarant.upsert({
    where: {userId: declarantUserId},
    update: {
      sourceId: payload.sourceId,
      declarantType: payload.declarantType,
      socialReason: payload.socialReason,
      siret: payload.siret,
      addressLine1: payload.addressLine1,
      addressLine2: payload.addressLine2,
      postalCode: payload.postalCode,
      city: payload.city,
      phoneNumber: payload.phoneNumber,
      civility: payload.civility,
      jobTitle: payload.jobTitle
    },
    create: {
      userId: declarantUserId,
      sourceId: payload.sourceId,
      declarantType: payload.declarantType,
      socialReason: payload.socialReason,
      siret: payload.siret,
      addressLine1: payload.addressLine1,
      addressLine2: payload.addressLine2,
      postalCode: payload.postalCode,
      city: payload.city,
      phoneNumber: payload.phoneNumber,
      civility: payload.civility,
      jobTitle: payload.jobTitle
    }
  })
}

async function importFile(filePath, seenSourceIds) {
  const rows = readWorkbookRows(filePath)

  if (rows.length === 0) {
    console.log(`[import-declarants-icpe] aucun enregistrement dans ${filePath}`)
    return
  }

  let count = 0
  let imported = 0
  let skipped = 0

  for (const row of rows) {
    count++

    const payload = buildDeclarantPayload(row)

    if (seenSourceIds.has(payload.sourceId)) {
      skipped++
      continue
    }

    await prisma.$transaction(async () => {
      await importDeclarant(row)
    })

    seenSourceIds.add(payload.sourceId)
    imported++

    if (imported % 200 === 0) {
      console.log(`[import-declarants-icpe] ${imported} déclarants importés`)
    }
  }

  console.log(
    `[import-declarants-icpe] ${filePath} terminé (${count} lignes, ${imported} déclarants importés, ${skipped} doublons ignorés)`
  )
}

async function main() {
  console.log('[import-declarants-icpe] start')

  const files = listCadresFiles()

  if (files.length === 0) {
    console.log('[import-declarants-icpe] aucun fichier Cadres.xlsx trouvé')
    return
  }

  console.log(`[import-declarants-icpe] ${files.length} fichiers trouvés`)

  const seenSourceIds = new Set()

  for (const filePath of files) {
    console.log(`[import-declarants-icpe] import ${filePath}`)
    await importFile(filePath, seenSourceIds)
  }

  console.log('[import-declarants-icpe] terminé')
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
