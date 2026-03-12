// Noinspection JSNonASCIINames

import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import {parse} from 'csv-parse'
import {fileURLToPath} from 'node:url'

import {prisma} from '../../../db/prisma.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const OUGC_CSV_PATH = path.resolve(
  __dirname,
  '../../../data/blv/irrigants-aquasys/referentiels/ougc-accounts.csv'
)

const RAW_DATA_CSV_PATH = path.resolve(
  __dirname,
  '../../../data/blv/irrigants-aquasys/referentiels/donnees-brutes.csv'
)

function clean(value) {
  const v = String(value ?? '').trim()
  return v || null
}

function normalizeDeclarantType(value) {
  const v = clean(value)

  if (v === 'LEGAL_PERSON' || v === 'NATURAL_PERSON') {
    return v
  }

  return 'LEGAL_PERSON'
}

async function getBlvPointSourceIdsFromCsv() {
  const parser = fs
    .createReadStream(RAW_DATA_CSV_PATH)
    .pipe(
      parse({
        columns: true,
        skip_empty_lines: true,
        trim: true
      })
    )

  const pointSourceIds = new Set()

  for await (const row of parser) {
    if (row['Libellé_UG'] !== 'Bievre Liers Valloire') {
      continue
    }

    const pointId = clean(row['ID_Point_Prélèvement'])
    if (!pointId) {
      continue
    }

    pointSourceIds.add(`blv-${pointId}`)
  }

  return [...pointSourceIds]
}

async function upsertDeclarantFromRow(row) {
  const sourceId = clean(row.sourceId)
  const email = clean(row.email)

  if (!sourceId) {
    throw new Error('sourceId manquant dans ougc-accounts.csv')
  }

  if (!email) {
    throw new Error(`email manquant pour sourceId=${sourceId}`)
  }

  const firstName = clean(row.firstName)
  const lastName = clean(row.lastName)
  const addressLine1 = clean(row.addressLine1)
  const addressLine2 = clean(row.addressLine2)
  const city = clean(row.city)
  const declarantType = normalizeDeclarantType(row.declarantType)
  const phoneNumber = clean(row.phoneNumber)
  const poBox = clean(row.poBox)
  const postalCode = clean(row.postalCode)
  const socialReason = clean(row.socialReason)
  const civility = clean(row.civility)
  const jobTitle = clean(row.jobTitle)

  const existingDeclarant = await prisma.declarant.findUnique({
    where: {sourceId},
    include: {user: true}
  })

  let userId

  if (existingDeclarant) {
    userId = existingDeclarant.userId

    await prisma.user.update({
      where: {id: userId},
      data: {
        email,
        role: 'DECLARANT',
        firstName,
        lastName
      }
    })

    await prisma.declarant.update({
      where: {userId},
      data: {
        sourceId,
        declarantType,
        socialReason,
        addressLine1,
        addressLine2,
        postalCode,
        city,
        phoneNumber,
        poBox,
        civility,
        jobTitle
      }
    })
  } else {
    const user = await prisma.user.upsert({
      where: {email},
      update: {
        role: 'DECLARANT',
        firstName,
        lastName
      },
      create: {
        email,
        role: 'DECLARANT',
        firstName,
        lastName
      }
    })

    userId = user.id

    await prisma.declarant.upsert({
      where: {userId},
      update: {
        sourceId,
        declarantType,
        socialReason,
        addressLine1,
        addressLine2,
        postalCode,
        city,
        phoneNumber,
        poBox,
        civility,
        jobTitle
      },
      create: {
        userId,
        sourceId,
        declarantType,
        socialReason,
        addressLine1,
        addressLine2,
        postalCode,
        city,
        phoneNumber,
        poBox,
        civility,
        jobTitle
      }
    })
  }

  return {userId, sourceId}
}

async function upsertCollecteurExploitationsForPointsFromCsv(declarantUserId, declarantSourceId, pointSourceIds) {
  if (pointSourceIds.length === 0) {
    return 0
  }

  const points = await prisma.pointPrelevement.findMany({
    where: {
      sourceId: {
        in: pointSourceIds
      }
    },
    select: {
      id: true,
      sourceId: true
    }
  })

  const foundPointSourceIds = new Set(points.map(point => point.sourceId))
  const missingPointSourceIds = pointSourceIds.filter(sourceId => !foundPointSourceIds.has(sourceId))

  if (missingPointSourceIds.length > 0) {
    console.warn(
      `[import-ougc-accounts] ${missingPointSourceIds.length} points absents en BDD pour ${declarantSourceId}: ${missingPointSourceIds.join(', ')}`
    )
  }

  let count = 0

  for (const point of points) {
    const sourceId = `${declarantSourceId}-${point.sourceId}`

    await prisma.declarantPointPrelevement.upsert({
      where: {sourceId},
      update: {
        declarantUserId,
        pointPrelevementId: point.id,
        type: 'COLLECTEUR',
        status: 'NON_RENSEIGNE',
        usages: []
      },
      create: {
        sourceId,
        declarantUserId,
        pointPrelevementId: point.id,
        type: 'COLLECTEUR',
        status: 'NON_RENSEIGNE',
        usages: []
      }
    })

    count++
  }

  return count
}

async function importRow(row, pointSourceIds) {
  const {userId, sourceId} = await upsertDeclarantFromRow(row)
  const exploitationsCount = await upsertCollecteurExploitationsForPointsFromCsv(
    userId,
    sourceId,
    pointSourceIds
  )

  return {
    declarantSourceId: sourceId,
    exploitationsCount
  }
}

async function main() {
  console.log('[import-ougc-accounts] start')

  const pointSourceIds = await getBlvPointSourceIdsFromCsv()

  console.log(`[import-ougc-accounts] ${pointSourceIds.length} points trouvés dans donnees-brutes.csv`)

  const parser = fs
    .createReadStream(OUGC_CSV_PATH)
    .pipe(
      parse({
        columns: true,
        skip_empty_lines: true,
        trim: true
      })
    )

  let declarantsCount = 0
  let exploitationsCount = 0

  for await (const row of parser) {
    const result = await prisma.$transaction(async () => importRow(row, pointSourceIds))

    declarantsCount++
    exploitationsCount += result.exploitationsCount

    console.log(
      `[import-ougc-accounts] ${result.declarantSourceId} => ${result.exploitationsCount} exploitations COLLECTEUR upsert`
    )
  }

  console.log(
    `[import-ougc-accounts] terminé (${declarantsCount} déclarants, ${exploitationsCount} exploitations)`
  )
}

try {
  await main()
} catch (error) {
  console.error(error)
  throw error
} finally {
  await prisma.$disconnect()
}
