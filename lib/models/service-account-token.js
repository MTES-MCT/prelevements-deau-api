import process from 'node:process'
import {prisma} from '../../db/prisma.js'
import {generateOpaqueToken, hashToken} from '../util/secrets.js'

const SERVICE_ACCOUNT_ACCESS_TOKEN_TTL = Number.parseInt(
  process.env.SERVICE_ACCOUNT_ACCESS_TOKEN_TTL || '3600',
  10
)

const SERVICE_ACCOUNT_IMPERSONATION_TOKEN_TTL = Number.parseInt(
  process.env.SERVICE_ACCOUNT_IMPERSONATION_TOKEN_TTL || '900',
  10
)

export async function createServiceAccountAccessToken(serviceAccountId, credentialId, ttl = SERVICE_ACCOUNT_ACCESS_TOKEN_TTL) {
  const token = generateOpaqueToken()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + ttl * 1000)

  const record = await prisma.serviceAccountToken.create({
    data: {
      serviceAccountId,
      credentialId,
      type: 'ACCESS',
      tokenHash: hashToken(token),
      expiresAt
    }
  })

  return {
    token,
    id: record.id,
    serviceAccountId: record.serviceAccountId,
    type: record.type,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt
  }
}

export async function createServiceAccountImpersonationToken(serviceAccountId, declarantUserId, ttl = SERVICE_ACCOUNT_IMPERSONATION_TOKEN_TTL) {
  const token = generateOpaqueToken()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + ttl * 1000)

  const record = await prisma.serviceAccountToken.create({
    data: {
      serviceAccountId,
      declarantUserId,
      type: 'IMPERSONATION',
      tokenHash: hashToken(token),
      expiresAt
    }
  })

  return {
    token,
    id: record.id,
    serviceAccountId: record.serviceAccountId,
    declarantUserId: record.declarantUserId,
    type: record.type,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt
  }
}

export async function getServiceAccountTokenByToken(token) {
  return prisma.serviceAccountToken.findFirst({
    where: {
      tokenHash: hashToken(token),
      revokedAt: null,
      expiresAt: {
        gt: new Date()
      }
    },
    include: {
      serviceAccount: true,
      declarant: {
        include: {
          user: true
        }
      }
    }
  })
}

export async function revokeServiceAccountToken(token) {
  const tokenHash = hashToken(token)

  await prisma.serviceAccountToken.updateMany({
    where: {
      tokenHash,
      revokedAt: null
    },
    data: {
      revokedAt: new Date()
    }
  })
}
