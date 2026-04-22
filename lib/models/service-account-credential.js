import {randomUUID} from 'node:crypto'
import {prisma} from '../../db/prisma.js'
import {generateOpaqueToken, hashSecret, verifySecret} from '../util/secrets.js'

export async function createServiceAccountCredential(serviceAccountId, {name = null, expiresAt = null} = {}) {
  const keyId = `sa_${randomUUID()}`
  const clientSecret = generateOpaqueToken()
  const secretHash = hashSecret(clientSecret)

  const credential = await prisma.serviceAccountCredential.create({
    data: {
      serviceAccountId,
      keyId,
      secretHash,
      name,
      expiresAt
    }
  })

  return {
    id: credential.id,
    keyId: credential.keyId,
    clientSecret
  }
}

export async function getValidServiceAccountCredentialByKeyId(keyId) {
  return prisma.serviceAccountCredential.findFirst({
    where: {
      keyId,
      revokedAt: null,
      OR: [
        {expiresAt: null},
        {expiresAt: {gt: new Date()}}
      ],
      serviceAccount: {
        isActive: true,
        deletedAt: null
      }
    },
    include: {
      serviceAccount: true
    }
  })
}

export async function authenticateServiceAccountCredential(keyId, clientSecret) {
  const credential = await getValidServiceAccountCredentialByKeyId(keyId)

  if (!credential) {
    return null
  }

  const valid = verifySecret(clientSecret, credential.secretHash)

  if (!valid) {
    return null
  }

  await prisma.serviceAccountCredential.update({
    where: {id: credential.id},
    data: {lastUsedAt: new Date()}
  })

  return credential
}
