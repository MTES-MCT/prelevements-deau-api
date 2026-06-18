import {randomUUID} from 'node:crypto'
import process from 'node:process'
import {prisma} from '../../db/prisma.js'

const SESSION_TOKEN_TTL = Number.parseInt(
  process.env.SESSION_TOKEN_TTL || '2592000',
  10
)

/**
 * Crée un SessionToken
 * @param {number} userId
 * @param {'DECLARANT'|'INSTRUCTOR'|'ADMIN'} role
 * @param {number} ttl
 * @param {object} options
 * @param {string} [options.impersonatedByUserId]
 * @param {'DECLARANT'|'INSTRUCTOR'|'ADMIN'} [options.impersonatedByRole]
 */
export async function createSessionToken(userId, role, ttl = SESSION_TOKEN_TTL, options = {}) {
  const token = randomUUID()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + (ttl * 1000))

  const sessionToken = await prisma.sessionToken.create({
    data: {
      id: randomUUID(),
      token,
      userId,
      role,
      impersonatedByUserId: options.impersonatedByUserId ?? null,
      impersonatedByRole: options.impersonatedByRole ?? null,
      expiresAt
    }
  })

  return {
    token: sessionToken.token,
    userId: sessionToken.userId,
    role: sessionToken.role,
    impersonatedByUserId: sessionToken.impersonatedByUserId,
    impersonatedByRole: sessionToken.impersonatedByRole,
    createdAt: sessionToken.createdAt,
    expiresAt: sessionToken.expiresAt
  }
}

/**
 * Récupère une session valide (non expirée)
 */
export async function getSessionByToken(token) {
  const session = await prisma.sessionToken.findFirst({
    where: {
      token,
      expiresAt: {
        gt: new Date()
      }
    }
  })

  return session ?? null
}

/**
 * Supprime une session par token
 */
export async function deleteSessionToken(token) {
  await prisma.sessionToken.delete({
    where: {token}
  })
}

/**
 * Supprime TOUTES les sessions d'un user
 * @returns {number} nombre de sessions supprimées
 */
export async function deleteUserSessions(userId) {
  const result = await prisma.sessionToken.deleteMany({
    where: {userId}
  })

  return result.count
}
