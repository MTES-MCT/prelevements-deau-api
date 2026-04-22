import 'dotenv/config'
import process from 'node:process'
import {prisma} from '../db/prisma.js'
import {createServiceAccountCredential} from '../lib/models/service-account-credential.js'

async function main() {
  const serviceAccountId = process.argv[2]

  if (!serviceAccountId) {
    throw new Error('Usage: node scripts/create-service-account-credential.js <serviceAccountId>')
  }

  const serviceAccount = await prisma.serviceAccount.findUnique({
    where: {id: serviceAccountId}
  })

  if (!serviceAccount) {
    throw new Error('SERVICE_ACCOUNT_NOT_FOUND')
  }

  const credential = await createServiceAccountCredential(serviceAccountId, {
    name: 'default'
  })

  console.log('clientId:', credential.keyId)
  console.log('clientSecret:', credential.clientSecret)
}

main()
  .catch(error => {
    console.error(error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
