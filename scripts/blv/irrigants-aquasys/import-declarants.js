// Noinspection JSNonASCIINames

import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import {parse} from 'csv-parse'
import {prisma} from '../../../db/prisma.js'
import {fileURLToPath} from 'node:url'
import {closeQueues} from '../../../lib/queues/config.js'
import {closeRedis} from '../../../lib/queues/redis.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const CSV_PATH = path.resolve(__dirname, '../../../data/blv/irrigants-aquasys/referentiels/donnees-brutes.csv')

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

function normalizeType(typeRaw) {
  return stripParens(typeRaw)
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036F]/g, '')
    .toLowerCase()
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

export function parseUsagerRow(row) {
  const typeNormalized = normalizeType(row.Type_Usager)
  const nom = stripParens(row.Nom_Usager)

  if (!nom) {
    return {
      kind: null,
      firstName: null,
      lastName: null,
      socialReason: null
    }
  }

  const isCompany = typeNormalized.startsWith('soc')

  if (isCompany) {
    return {
      kind: PERSON_KIND.LEGAL,
      firstName: null,
      lastName: null,
      socialReason: nom
    }
  }

  const {firstName, lastName} = parseIndividual(nom)

  return {
    kind: PERSON_KIND.NATURAL,
    firstName,
    lastName,
    socialReason: null
  }
}

async function importRow(row) {
  const sourceId = `blv-${row.ID_Usager}`

  const siret = row.SIRET.slice(0, 14)
  const {kind, firstName, lastName, socialReason} = parseUsagerRow(row)
  const postalCode = row.Code_INSEE_Commune
  const city = row.NOM_Commune
  const address = row['Lieu-Dit_Parcelle']

  // 1️⃣ Chercher le déclarant par sourceId (Prisma)
  const existing = await prisma.declarant.findUnique({
    where: {sourceId},
    include: {
      user: true
    }
  })

  let declarantUserId

  const declarantType
    = kind === PERSON_KIND.LEGAL
      ? 'LEGAL_PERSON'
      : (kind === PERSON_KIND.NATURAL
        ? 'NATURAL_PERSON'
        : null)

  const email = `${sourceId}@import.local`

  if (existing) {
    declarantUserId = existing.userId

    await prisma.user.update({
      where: {id: declarantUserId},
      data: {
        role: 'DECLARANT',
        firstName,
        lastName,
      }
    })

    await prisma.declarant.update({
      where: {userId: declarantUserId},
      data: {
        sourceId,
        declarantType: declarantType ?? undefined,
        socialReason,
        siret,
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
        firstName,
        lastName,
      },
      create: {
        email,
        role: 'DECLARANT',
        firstName,
        lastName,
      }
    })

    declarantUserId = user.id

    await prisma.declarant.upsert({
      where: {userId: declarantUserId},
      update: {
        sourceId,
        declarantType: declarantType ?? undefined,
        socialReason,
        siret,
        addressLine1: address,
        postalCode,
        city
      },
      create: {
        userId: declarantUserId,
        sourceId,
        declarantType: declarantType ?? 'NATURAL_PERSON',
        socialReason,
        siret,
        addressLine1: address,
        postalCode,
        city
      }
    })
  }
}

async function main() {
  console.log('[import-declarants] start')

  const parser = fs
    .createReadStream(CSV_PATH)
    .pipe(
      parse({
        columns: true,
        skip_empty_lines: true,
        trim: true
      })
    )

  let count = 0

  for await (const row of parser) {
    if (row['Libellé_UG'] === 'Bievre Liers Valloire') {
      await prisma.$transaction(async () => {
        await importRow(row)
      })

      count++
      if (count % 500 === 0) {
        console.log(`[import-declarants] ${count} déclarants importés`)
      }
    }
  }

  console.log(`[import-declarants] terminé (${count} déclarants)`)
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
