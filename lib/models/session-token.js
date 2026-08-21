import {randomUUID} from 'node:crypto'
import process from 'node:process'
import {prisma} from '../../db/prisma.js'

export function readSessionTokenTtl(value = process.env.SESSION_TOKEN_TTL) {
  const rawValue = value === undefined ? '2592000' : String(value).trim()
  const ttl = Number.parseInt(rawValue, 10)

  if (!Number.isSafeInteger(ttl) || ttl < 1 || String(ttl) !== rawValue) {
    throw new Error('SESSION_TOKEN_TTL doit être un entier positif exprimé en secondes.')
  }

  return ttl
}

export function validateSessionTokenConfig(value = process.env.SESSION_TOKEN_TTL) {
  return readSessionTokenTtl(value)
}

const SESSION_TOKEN_TTL = readSessionTokenTtl()

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
  const effectiveTtl = readSessionTokenTtl(ttl)
  const client = options.client ?? prisma
  const token = randomUUID()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + (effectiveTtl * 1000))

  const sessionToken = await client.sessionToken.create({
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
export async function getSessionByToken(token, {
  client = prisma,
  now = new Date(),
  ttl = SESSION_TOKEN_TTL
} = {}) {
  const effectiveTtl = readSessionTokenTtl(ttl)
  const oldestAcceptedCreation = new Date(now.getTime() - (effectiveTtl * 1000))
  const session = await client.sessionToken.findFirst({
    where: {
      token,
      expiresAt: {
        gt: now
      },
      createdAt: {
        gt: oldestAcceptedCreation
      }
    }
  })

  if (!session) {
    return null
  }

  const runtimeExpiresAt = new Date(
    new Date(session.createdAt).getTime() + (effectiveTtl * 1000)
  )
  const databaseExpiresAt = new Date(session.expiresAt)
  const expiresAt = new Date(Math.min(
    runtimeExpiresAt.getTime(),
    databaseExpiresAt.getTime()
  ))

  if (expiresAt <= now) {
    return null
  }

  return {...session, expiresAt}
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
export async function deleteUserSessions(userId, {client = prisma} = {}) {
  const result = await client.sessionToken.deleteMany({
    where: {
      OR: [
        {userId},
        {impersonatedByUserId: userId}
      ]
    }
  })

  return result.count
}
