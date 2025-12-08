import test from 'ava'
import {ObjectId} from 'mongodb'
import {setupTestMongo, cleanupCollections} from '../../util/test-helpers/mongo.js'
import {
  createSessionToken,
  getSessionByToken,
  deleteSessionToken,
  deleteUserSessions,
  cleanExpiredSessions
} from '../session-token.js'

setupTestMongo(test)
cleanupCollections(test, ['session_tokens'])

test.serial('createSessionToken / crée un token de session', async t => {
  const userId = new ObjectId()
  const session = await createSessionToken(userId, 'DEP-974', 'editor')

  t.truthy(session.token)
  t.deepEqual(session.userId, userId)
  t.is(session.territoire, 'DEP-974')
  t.is(session.role, 'editor')
  t.truthy(session.createdAt)
  t.truthy(session.expiresAt)
  t.true(session.expiresAt > session.createdAt)
})

test.serial('createSessionToken / accepte un TTL personnalisé', async t => {
  const userId = new ObjectId()
  const session = await createSessionToken(userId, 'DEP-971', 'reader', 86_400) // 1 jour

  const ttlMs = session.expiresAt.getTime() - session.createdAt.getTime()
  const ttlSeconds = Math.floor(ttlMs / 1000)

  t.is(ttlSeconds, 86_400)
})

test.serial('getSessionByToken / récupère une session valide', async t => {
  const userId = new ObjectId()
  const created = await createSessionToken(userId, 'DEP-972', 'editor')

  const found = await getSessionByToken(created.token)

  t.truthy(found)
  t.is(found.token, created.token)
  t.deepEqual(found.userId, userId)
  t.is(found.territoire, 'DEP-972')
  t.is(found.role, 'editor')
})

test.serial('getSessionByToken / retourne null pour un token inexistant', async t => {
  const found = await getSessionByToken('non-existent-token')

  t.is(found, null)
})

test.serial('getSessionByToken / retourne null pour une session expirée', async t => {
  const userId = new ObjectId()
  const session = await createSessionToken(userId, 'DEP-973', 'reader', -1)

  // Attendre un peu pour être sûr que la session est expirée
  await new Promise(resolve => {
    setTimeout(resolve, 100)
  })

  const found = await getSessionByToken(session.token)

  t.is(found, null)
})

test.serial('deleteSessionToken / supprime une session', async t => {
  const userId = new ObjectId()
  const session = await createSessionToken(userId, 'DEP-974', 'editor')

  await deleteSessionToken(session.token)

  const found = await getSessionByToken(session.token)
  t.is(found, null)
})

test.serial('deleteUserSessions / supprime toutes les sessions d\'un utilisateur', async t => {
  const userId = new ObjectId()

  // Créer plusieurs sessions pour le même utilisateur
  await createSessionToken(userId, 'DEP-971', 'editor')
  await createSessionToken(userId, 'DEP-972', 'reader')
  await createSessionToken(userId, 'DEP-973', 'editor')

  // Créer une session pour un autre utilisateur
  const otherUserId = new ObjectId()
  await createSessionToken(otherUserId, 'DEP-974', 'reader')

  const deletedCount = await deleteUserSessions(userId)

  t.is(deletedCount, 3)
})

test.serial('cleanExpiredSessions / nettoie les sessions expirées', async t => {
  const userId1 = new ObjectId()
  const userId2 = new ObjectId()
  const userId3 = new ObjectId()

  // Créer des sessions expirées
  await createSessionToken(userId1, 'DEP-971', 'editor', -10)
  await createSessionToken(userId2, 'DEP-972', 'reader', -10)

  // Créer une session valide
  const validSession = await createSessionToken(userId3, 'DEP-973', 'editor', 3600)

  // Attendre un peu
  await new Promise(resolve => {
    setTimeout(resolve, 100)
  })

  const deletedCount = await cleanExpiredSessions()

  t.true(deletedCount >= 2)

  // Vérifier que la session valide existe toujours
  const found = await getSessionByToken(validSession.token)
  t.truthy(found)
})
