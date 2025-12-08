import {randomUUID} from 'node:crypto'
import process from 'node:process'
import mongo from '../util/mongo.js'
import {normalizeEmail} from '../util/email.js'

const AUTH_TOKEN_TTL = Number.parseInt(process.env.AUTH_TOKEN_TTL || '3600', 10)

export async function createAuthToken(email, ttl = AUTH_TOKEN_TTL) {
  const token = randomUUID()
  const normalized = normalizeEmail(email)
  const now = new Date()
  const expiresAt = new Date(now.getTime() + (ttl * 1000))

  const authToken = {
    token,
    email: normalized,
    createdAt: now,
    expiresAt
  }

  await mongo.db.collection('auth_tokens').insertOne(authToken)

  return authToken
}

export async function getAuthTokenByToken(token) {
  const authToken = await mongo.db.collection('auth_tokens').findOne({token})

  if (!authToken) {
    return null
  }

  // Vérifier que le token n'a pas expiré
  if (authToken.expiresAt < new Date()) {
    return null
  }

  return authToken
}

export async function deleteAuthToken(token) {
  await mongo.db.collection('auth_tokens').deleteOne({token})
}

export async function cleanExpiredTokens() {
  const result = await mongo.db.collection('auth_tokens').deleteMany({
    expiresAt: {$lt: new Date()}
  })

  return result.deletedCount
}
