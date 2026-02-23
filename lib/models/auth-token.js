import {randomUUID} from 'node:crypto'
import process from 'node:process'
import {prisma} from '../../db/prisma.js'
import {normalizeEmail} from '../util/email.js'

const AUTH_TOKEN_TTL = Number.parseInt(
  process.env.AUTH_TOKEN_TTL || '900',
  10
)

/**
 * Crée un AuthToken pour un utilisateur EXISTANT
 */
export async function createAuthToken(email, ttl = AUTH_TOKEN_TTL) {
  const normalized = normalizeEmail(email)

  const user = await prisma.user.findUnique({
    where: {email: normalized}
  })

  if (!user) {
    throw new Error('USER_NOT_FOUND')
  }

  const token = randomUUID()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + ttl * 1000)

  const authToken = await prisma.authToken.create({
    data: {
      token,
      userId: user.id,
      expiresAt
    }
  })

  return {
    token: authToken.token,
    userId: authToken.userId,
    createdAt: authToken.createdAt,
    expiresAt: authToken.expiresAt
  }
}

/**
 * Récupère un AuthToken valide (non expiré)
 */
export async function getAuthTokenByToken(token) {
  const authToken = await prisma.authToken.findFirst({
    where: {
      token,
      expiresAt: {
        gt: new Date()
      }
    }
  })

  return authToken ?? null
}

/**
 * Supprime un AuthToken par son token
 */
export async function deleteAuthToken(token) {
  await prisma.authToken.delete({
    where: {token}
  })
}
