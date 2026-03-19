// Noinspection JSNonASCIINames

import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import {parse} from 'csv-parse'
import {fileURLToPath} from 'node:url'

import {prisma} from '../../../db/prisma.js'
import {closeQueues} from '../../../lib/queues/config.js'
import {closeRedis} from '../../../lib/queues/redis.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const GIDAF_ACCOUNTS_CSV_PATH = path.resolve(
  __dirname,
  '../../../data/blv/industriels-icpe-gidaf/gidaf-accounts.csv'
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

async function getGidafPointSourceIds() {
  const points = await prisma.pointPrelevement.findMany({
    where: {
      sourceId: {
        startsWith: 'blv-industriels-icpe-gidaf-'
      }
    },
    select: {
      sourceId: true
    }
  })

  return points
    .map(point => point.sourceId)
    .filter(Boolean)
    .sort()
}

async function upsertDeclarantFromRow(row) {
  const sourceId = clean(row.sourceId)
  const email = clean(row.email)

  if (!sourceId) {
    throw new Error('sourceId manquant dans gidaf-accounts.csv')
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

async function upsertCollecteurExploitationsForPoints(declarantUserId, declarantSourceId, pointSourceIds) {
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
      `[create-gidaf-account] ${missingPointSourceIds.length} points absents en BDD pour ${declarantSourceId}: ${missingPointSourceIds.join(', ')}`
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
  const exploitationsCount = await upsertCollecteurExploitationsForPoints(
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
  console.log('[create-gidaf-account] start')

  const pointSourceIds = await getGidafPointSourceIds()

  console.log(`[create-gidaf-account] ${pointSourceIds.length} points GIDAF trouvés en BDD`)

  const parser = fs
    .createReadStream(GIDAF_ACCOUNTS_CSV_PATH)
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
      `[create-gidaf-account] ${result.declarantSourceId} => ${result.exploitationsCount} exploitations COLLECTEUR upsert`
    )
  }

  console.log(
    `[create-gidaf-account] terminé (${declarantsCount} déclarants, ${exploitationsCount} exploitations)`
  )
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
