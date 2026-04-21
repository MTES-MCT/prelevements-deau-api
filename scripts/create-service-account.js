import 'dotenv/config'
import {prisma} from '../db/prisma.js'

async function main() {
  const name = process.argv[2]

  if (!name) {
    throw new Error('Usage: node scripts/create-service-account.js <name>')
  }

  const serviceAccount = await prisma.serviceAccount.create({
    data: {
      name,
      isActive: true
    }
  })

  console.log('serviceAccountId:', serviceAccount.id)
}

main()
  .catch(error => {
    console.error(error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
