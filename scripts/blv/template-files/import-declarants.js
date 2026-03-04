// Noinspection JSNonASCIINames

import 'dotenv/config'

import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {parse} from 'csv-parse'
import {prisma} from '../../../db/prisma.js'

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
  const {kind, firstName, lastName, socialReason, siret} = parseDeclarantRow(row)

  const rawKey = siret || stripParens(row.raison_sociale_preleveur) || null
  if (!rawKey) {
    throw new Error(`Clé de déclarant introuvable pour la ligne : ${JSON.stringify(row)}`)
  }

  const sourceId = `blv-${fileSource}-declarant-${rawKey}`
  const email = `${sourceId}@import.local`

  const postalCode = String(row.code_INSEE ?? '').trim() || null
  const city = null
  const address = null

  const declarantType
    = kind === PERSON_KIND.LEGAL
      ? 'LEGAL_PERSON'
      : (kind === PERSON_KIND.NATURAL
        ? 'NATURAL_PERSON'
        : null)

  // 1️⃣ Chercher le déclarant par sourceId (Prisma)
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
        siret: siret ?? null,
        addressLine1: address,
        postalCode,
        city
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
        siret: siret ?? null,
        addressLine1: address,
        postalCode,
        city
      },
      create: {
        userId: declarantUserId,
        sourceId,
        declarantType: declarantType ?? 'NATURAL_PERSON',
        socialReason: kind === PERSON_KIND.LEGAL ? (socialReason ?? null) : null,
        siret: siret ?? null,
        addressLine1: address,
        postalCode,
        city
      }
    })
  }
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

  console.log(`[import-declarants-template-file] ${files.length} fichiers trouvés`)

  for (const filePath of files) {
    console.log(`[import-declarants-template-file] import ${filePath}`)
    await importFile(filePath)
  }

  console.log('[import-declarants-template-file] terminé')
}

try {
  await main()
} catch (error) {
  console.error(error)
  throw error
} finally {
  await prisma.$disconnect()
}
