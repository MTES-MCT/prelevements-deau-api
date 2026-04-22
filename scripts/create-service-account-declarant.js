import 'dotenv/config'
import {prisma} from '../db/prisma.js'

function parseDate(value, label) {
  if (!value) {
    return null
  }

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`${label} invalide`)
  }

  return date
}

async function main() {
  const serviceAccountId = process.argv[2]
  const declarantUserId = process.argv[3]
  const startDateArg = process.argv[4]
  const endDateArg = process.argv[5]

  if (!serviceAccountId || !declarantUserId || !startDateArg) {
    throw new Error(
      'Usage: node scripts/create-service-account-declarant.js <serviceAccountId> <declarantUserId> <startDate> [endDate]'
    )
  }

  const startDate = parseDate(startDateArg, 'startDate')
  const endDate = parseDate(endDateArg, 'endDate')

  if (endDate && endDate < startDate) {
    throw new Error('endDate doit être supérieure ou égale à startDate')
  }

  const [serviceAccount, declarant] = await Promise.all([
    prisma.serviceAccount.findUnique({
      where: {id: serviceAccountId}
    }),
    prisma.declarant.findUnique({
      where: {userId: declarantUserId},
      include: {
        user: true
      }
    })
  ])

  if (!serviceAccount) {
    throw new Error('SERVICE_ACCOUNT_NOT_FOUND')
  }

  if (!declarant) {
    throw new Error('DECLARANT_NOT_FOUND')
  }

  const link = await prisma.serviceAccountDeclarant.create({
    data: {
      serviceAccountId,
      declarantUserId,
      startDate,
      endDate
    }
  })

  console.log('serviceAccountDeclarantId:', link.id)
  console.log('serviceAccountId:', link.serviceAccountId)
  console.log('declarantUserId:', link.declarantUserId)
  console.log('declarantEmail:', declarant.user.email)
  console.log('startDate:', link.startDate.toISOString())
  console.log('endDate:', link.endDate ? link.endDate.toISOString() : null)
}

main()
  .catch(error => {
    console.error(error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
