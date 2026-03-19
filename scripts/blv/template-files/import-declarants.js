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

const PERSON_KIND = {
  NATURAL: 'NATURAL_PERSON',
  LEGAL: 'LEGAL_PERSON'
}

function stripParens(s) {
  return String(s ?? '')
    .replaceAll(/\(.*?\)/g, '')
    .replaceAll(/\s+/g, ' ')
    .trim()
}

function clean(value) {
  const v = String(value ?? '').trim()
  return v || null
}

function normalizeSiret(s) {
  const raw = String(s ?? '').trim()
  if (!raw) {
    return null
  }

  const digits = raw.replaceAll(/\D/g, '')
  if (!digits) {
    return null
  }

  return digits.slice(0, 14) || null
}

function parseIndividual(fullNameRaw) {
  const fullName = stripParens(fullNameRaw)
  if (!fullName) {
    return {firstName: null, lastName: null}
  }

  const parts = fullName.split(' ')
  if (parts.length === 1) {
    return {firstName: null, lastName: parts[0]}
  }

  return {
    lastName: parts[0],
    firstName: parts.slice(1).join(' ') || null
  }
}

function parseDeclarantRow(row) {
  const socialReasonRaw = stripParens(row.raison_sociale_preleveur)
  const siret = normalizeSiret(row.siret_preleveur)

  if (siret) {
    return {
      kind: PERSON_KIND.LEGAL,
      firstName: null,
      lastName: null,
      socialReason: socialReasonRaw || null,
      siret
    }
  }

  if (!socialReasonRaw) {
    return {
      kind: null,
      firstName: null,
      lastName: null,
      socialReason: null,
      siret: null
    }
  }

  const {firstName, lastName} = parseIndividual(socialReasonRaw)

  return {
    kind: PERSON_KIND.NATURAL,
    firstName,
    lastName,
    socialReason: null,
    siret: null
  }
}

function listTemplateDirs() {
  const entries = fs.readdirSync(ROOT_DIR, {withFileTypes: true})

  return entries
    .filter(entry => entry.isDirectory() && DIR_PATTERN.test(entry.name))
    .map(entry => path.join(ROOT_DIR, entry.name))
}

function listTemplateReferentielCsvFiles() {
  const templateDirs = listTemplateDirs()
  const files = []

  for (const templateDir of templateDirs) {
    const referentielsDir = path.join(templateDir, 'referentiels')
    if (!fs.existsSync(referentielsDir) || !fs.statSync(referentielsDir).isDirectory()) {
      continue
    }

    const csvEntries = fs.readdirSync(referentielsDir, {withFileTypes: true})
    for (const entry of csvEntries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.csv')) {
        files.push(path.join(referentielsDir, entry.name))
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

function getTemplateDirFromFilePath(filePath) {
  const referentielsDir = path.dirname(filePath)
  return path.dirname(referentielsDir)
}

async function readCsvRows(filePath) {
  const rows = []

  const parser = fs
    .createReadStream(filePath)
    .pipe(
      parse({
        columns: true,
        skip_empty_lines: true,
        trim: true
      })
    )

  for await (const row of parser) {
    rows.push(row)
  }

  return rows
}

async function loadAccountsByTemplateDir() {
  const templateDirs = listTemplateDirs()
  const accountsByTemplateDir = new Map()

  for (const templateDir of templateDirs) {
    const accountsPath = path.join(templateDir, 'accounts.csv')
    const accountsMap = new Map()

    if (fs.existsSync(accountsPath) && fs.statSync(accountsPath).isFile()) {
      const rows = await readCsvRows(accountsPath)

      for (const row of rows) {
        const sourceId = clean(row.sourceId)
        if (!sourceId) {
          continue
        }

        accountsMap.set(sourceId, {
          sourceId,
          email: clean(row.email),
          firstName: clean(row.firstName),
          lastName: clean(row.lastName),
          phoneNumber: clean(row.phoneNumber),
          socialReason: clean(row.socialReason),
          civility: clean(row.civility),
          jobTitle: clean(row.jobTitle)
        })
      }
    }

    accountsByTemplateDir.set(templateDir, accountsMap)
  }

  return accountsByTemplateDir
}

async function importRow(row, fileSource, account) {
  const parsed = parseDeclarantRow(row)

  const rawKey = parsed.siret || stripParens(row.raison_sociale_preleveur) || null
  if (!rawKey) {
    throw new Error(`Clé de déclarant introuvable pour la ligne : ${JSON.stringify(row)}`)
  }

  const sourceId = `blv-${fileSource}-declarant-${rawKey}`

  const email = account?.email || `${sourceId}@import.local`

  const postalCode = clean(row.code_INSEE)
  const city = null
  const address = null

  const {kind} = parsed
  const declarantType
    = kind === PERSON_KIND.LEGAL
      ? 'LEGAL_PERSON'
      : (kind === PERSON_KIND.NATURAL ? 'NATURAL_PERSON' : null)

  const firstName = account?.firstName ?? parsed.firstName
  const lastName = account?.lastName ?? parsed.lastName
  const socialReason = account?.socialReason ?? parsed.socialReason
  const phoneNumber = account?.phoneNumber ?? null
  const civility = account?.civility ?? null
  const jobTitle = account?.jobTitle ?? null
  const siret = parsed.siret ?? null

  const existing = await prisma.declarant.findUnique({
    where: {sourceId},
    include: {user: true}
  })

  let declarantUserId

  if (existing) {
    declarantUserId = existing.userId

    await prisma.user.update({
      where: {id: declarantUserId},
      data: {
        email,
        role: 'DECLARANT',
        firstName: kind === PERSON_KIND.NATURAL ? firstName : null,
        lastName: kind === PERSON_KIND.NATURAL ? lastName : null
      }
    })

    await prisma.declarant.update({
      where: {userId: declarantUserId},
      data: {
        sourceId,
        declarantType: declarantType ?? undefined,
        socialReason: kind === PERSON_KIND.LEGAL ? (socialReason ?? null) : null,
        siret,
        addressLine1: address,
        postalCode,
        city,
        phoneNumber,
        civility,
        jobTitle
      }
    })
  } else {
    const user = await prisma.user.upsert({
      where: {email},
      update: {
        role: 'DECLARANT',
        firstName: kind === PERSON_KIND.NATURAL ? firstName : null,
        lastName: kind === PERSON_KIND.NATURAL ? lastName : null
      },
      create: {
        email,
        role: 'DECLARANT',
        firstName: kind === PERSON_KIND.NATURAL ? firstName : null,
        lastName: kind === PERSON_KIND.NATURAL ? lastName : null
      }
    })

    declarantUserId = user.id

    await prisma.declarant.upsert({
      where: {userId: declarantUserId},
      update: {
        sourceId,
        declarantType: declarantType ?? undefined,
        socialReason: kind === PERSON_KIND.LEGAL ? (socialReason ?? null) : null,
        siret,
        addressLine1: address,
        postalCode,
        city,
        phoneNumber,
        civility,
        jobTitle
      },
      create: {
        userId: declarantUserId,
        sourceId,
        declarantType: declarantType ?? 'NATURAL_PERSON',
        socialReason: kind === PERSON_KIND.LEGAL ? (socialReason ?? null) : null,
        siret,
        addressLine1: address,
        postalCode,
        city,
        phoneNumber,
        civility,
        jobTitle
      }
    })
  }
}

async function importFile(filePath, accountsByTemplateDir) {
  const fileSource = getFileSourceId(filePath)
  const templateDir = getTemplateDirFromFilePath(filePath)
  const accountsMap = accountsByTemplateDir.get(templateDir) ?? new Map()
  const csvFileName = path.basename(filePath)

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
    const account = accountsMap.get(csvFileName) ?? null

    await prisma.$transaction(async () => {
      await importRow(row, fileSource, account)
    })

    count++
    if (count % 500 === 0) {
      console.log(`[import-declarants-template-file] ${fileSource} ${count} déclarants importés`)
    }
  }

  console.log(`[import-declarants-template-file] ${fileSource} terminé (${count} déclarants)`)
}

async function main() {
  console.log('[import-declarants-template-file] start')

  const files = listTemplateReferentielCsvFiles()

  if (files.length === 0) {
    console.log('[import-declarants-template-file] aucun fichier trouvé')
    return
  }

  const accountsByTemplateDir = await loadAccountsByTemplateDir()

  console.log(`[import-declarants-template-file] ${files.length} fichiers trouvés`)

  for (const filePath of files) {
    console.log(`[import-declarants-template-file] import ${filePath}`)
    await importFile(filePath, accountsByTemplateDir)
  }

  console.log('[import-declarants-template-file] terminé')
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
