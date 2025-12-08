import {randomUUID} from 'node:crypto'
import process from 'node:process'
import mongo from '../util/mongo.js'

const SESSION_TOKEN_TTL = Number.parseInt(process.env.SESSION_TOKEN_TTL || '2592000', 10)

export async function createSessionToken(userId, territoire, role, ttl = SESSION_TOKEN_TTL) {
  const token = randomUUID()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + (ttl * 1000))

  const sessionToken = {
    token,
    userId,
    territoire,
    role,
    createdAt: now,
    expiresAt
  }

  await mongo.db.collection('session_tokens').insertOne(sessionToken)

  return sessionToken
}

export async function getSessionByToken(token) {
  const session = await mongo.db.collection('session_tokens').findOne({token})

  if (!session) {
    return null
  }

  // Vérifier que la session n'a pas expiré
  if (session.expiresAt < new Date()) {
    return null
  }

  return session
}

export async function deleteSessionToken(token) {
  await mongo.db.collection('session_tokens').deleteOne({token})
}

export async function deleteUserSessions(userId) {
  const result = await mongo.db.collection('session_tokens').deleteMany({userId})
  return result.deletedCount
}
