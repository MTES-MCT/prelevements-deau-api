import {randomUUID} from 'node:crypto'
import process from 'node:process'
import {prisma} from '../../db/prisma.js'
import {getAuthUserByEmail, lockActiveUser} from './user.js'

const AUTH_TOKEN_TTL = Number.parseInt(
  process.env.AUTH_TOKEN_TTL || '900',
  10
)

/**
 * Crée un AuthToken pour un utilisateur EXISTANT.
 */
export async function createAuthTokenForUser(userId, ttl = AUTH_TOKEN_TTL, {
  authVersion,
  client = prisma
} = {}) {
  if (!Number.isInteger(authVersion) || authVersion < 0) {
    throw new Error('Une génération d’authentification valide est requise.')
  }

  const token = randomUUID()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + (ttl * 1000))

  const authToken = await client.authToken.create({
    data: {
      token,
      userId,
      authVersion,
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

export async function issueAuthTokenForLoginEmail(email, ttl = AUTH_TOKEN_TTL, {
  client = prisma,
  findUserByEmail = getAuthUserByEmail,
  lockUser = lockActiveUser
} = {}) {
  const candidate = await findUserByEmail(email, {client})
  if (!candidate) {
    return null
  }

  return client.$transaction(async transaction => {
    if (!await lockUser(candidate.id, {client: transaction})) {
      return null
    }

    const currentUser = await findUserByEmail(email, {client: transaction})
    if (!currentUser || currentUser.id !== candidate.id) {
      return null
    }

    const authToken = await createAuthTokenForUser(currentUser.id, ttl, {
      authVersion: currentUser.authVersion,
      client: transaction
    })

    return {authToken, user: currentUser}
  })
}

/**
 * Crée un AuthToken pour un utilisateur EXISTANT identifié par email.
 */
export async function createAuthToken(email, ttl = AUTH_TOKEN_TTL) {
  const issued = await issueAuthTokenForLoginEmail(email, ttl)

  if (!issued) {
    throw new Error('USER_NOT_FOUND')
  }

  return issued.authToken
}

/**
 * Récupère un AuthToken valide (non expiré)
 */
export async function getAuthTokenByToken(token, {
  client = prisma,
  now = new Date()
} = {}) {
  const authToken = await client.authToken.findFirst({
    where: {
      token,
      expiresAt: {
        gt: now
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
