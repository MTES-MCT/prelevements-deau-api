// Noinspection JSNonASCIINames

import '../../lib/config/env.js'

import {prisma} from '../../db/prisma.js'
import {closeQueues} from '../../lib/queues/config.js'
import {closeRedis} from '../../lib/queues/redis.js'
import {allowTemplateDeclarationTypeForDeclarant} from '../../lib/models/declaration-type.js'
import {
  getDeclarantData,
  readDroptRows
} from './lib/dropt-data.js'

function groupRowsByDeclarant(rows) {
  const byDeclarant = new Map()

  for (const row of rows) {
    if (!byDeclarant.has(row.declarantSourceId)) {
      byDeclarant.set(row.declarantSourceId, {
        row,
        realEmails: new Set()
      })
    }

    const group = byDeclarant.get(row.declarantSourceId)
    for (const email of getDeclarantData(row).realEmails) {
      group.realEmails.add(email)
    }
  }

  return [...byDeclarant.values()].map(group => ({
    row: group.row,
    realEmails: [...group.realEmails]
  }))
}

async function upsertUserEmailAlias(userId, email) {
  const existing = await prisma.userEmailAlias.findUnique({
    where: {email}
  })

  if (existing) {
    if (existing.userId !== userId) {
      console.warn(
        `[import-dropt-declarants] alias email ignoré car déjà rattaché à un autre utilisateur: ${email}`
      )
    }

    return
  }

  await prisma.userEmailAlias.create({
    data: {userId, email}
  })
}

async function upsertDeclarant(item) {
  const data = getDeclarantData(item.row)
  const realEmails = [...new Set([...data.realEmails, ...item.realEmails])]

  const existing = await prisma.declarant.findUnique({
    where: {sourceId: data.sourceId},
    include: {user: true}
  })

  let declarantUserId

  if (existing) {
    declarantUserId = existing.userId

    await prisma.user.update({
      where: {id: declarantUserId},
      data: {
        email: data.syntheticEmail,
        role: 'DECLARANT',
        firstName: data.firstName,
        lastName: data.lastName
      }
    })

    await prisma.declarant.update({
      where: {userId: declarantUserId},
      data: {
        sourceId: data.sourceId,
        declarantType: data.declarantType,
        socialReason: data.socialReason,
        siret: data.siret,
        addressLine1: data.addressLine1,
        addressLine2: data.addressLine2,
        postalCode: data.postalCode,
        city: data.city,
        phoneNumber: data.phoneNumber,
        civility: data.civility,
        jobTitle: data.jobTitle
      }
    })
  } else {
    const user = await prisma.user.upsert({
      where: {email: data.syntheticEmail},
      update: {
        role: 'DECLARANT',
        firstName: data.firstName,
        lastName: data.lastName
      },
      create: {
        email: data.syntheticEmail,
        role: 'DECLARANT',
        firstName: data.firstName,
        lastName: data.lastName
      }
    })

    declarantUserId = user.id

    await prisma.declarant.upsert({
      where: {userId: declarantUserId},
      update: {
        sourceId: data.sourceId,
        declarantType: data.declarantType,
        socialReason: data.socialReason,
        siret: data.siret,
        addressLine1: data.addressLine1,
        addressLine2: data.addressLine2,
        postalCode: data.postalCode,
        city: data.city,
        phoneNumber: data.phoneNumber,
        civility: data.civility,
        jobTitle: data.jobTitle
      },
      create: {
        userId: declarantUserId,
        sourceId: data.sourceId,
        declarantType: data.declarantType,
        socialReason: data.socialReason,
        siret: data.siret,
        addressLine1: data.addressLine1,
        addressLine2: data.addressLine2,
        postalCode: data.postalCode,
        city: data.city,
        phoneNumber: data.phoneNumber,
        civility: data.civility,
        jobTitle: data.jobTitle
      }
    })
  }

  for (const email of realEmails) {
    await upsertUserEmailAlias(declarantUserId, email)
  }

  await allowTemplateDeclarationTypeForDeclarant(declarantUserId)
}

async function main() {
  console.log('[import-dropt-declarants] start')

  const rows = await readDroptRows()
  const declarants = groupRowsByDeclarant(rows)
  let count = 0

  for (const item of declarants) {
    await prisma.$transaction(async () => {
      await upsertDeclarant(item)
    })

    count++
    if (count % 100 === 0) {
      console.log(`[import-dropt-declarants] ${count} déclarants importés`)
    }
  }

  console.log(`[import-dropt-declarants] terminé (${count} déclarants)`)
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
