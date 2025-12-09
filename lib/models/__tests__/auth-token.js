import test from 'ava'
import {setupTestMongo, cleanupCollections} from '../../util/test-helpers/mongo.js'
import {
  createAuthToken,
  getAuthTokenByToken,
  deleteAuthToken
} from '../auth-token.js'

setupTestMongo(test)
cleanupCollections(test, ['auth_tokens'])

test.serial('createAuthToken / crée un token d\'authentification', async t => {
  const authToken = await createAuthToken('alice@example.com')

  t.truthy(authToken.token)
  t.is(authToken.email, 'alice@example.com')
  t.truthy(authToken.createdAt)
  t.truthy(authToken.expiresAt)
  t.true(authToken.expiresAt > authToken.createdAt)
})

test.serial('createAuthToken / normalise l\'email', async t => {
  const authToken = await createAuthToken('Bob.Martin@EXAMPLE.COM')

  t.is(authToken.email, 'bob.martin@example.com')
})

test.serial('createAuthToken / accepte un TTL personnalisé', async t => {
  const authToken = await createAuthToken('test@example.com', 7200) // 2 heures

  const ttlMs = authToken.expiresAt.getTime() - authToken.createdAt.getTime()
  const ttlSeconds = Math.floor(ttlMs / 1000)

  t.is(ttlSeconds, 7200)
})

test.serial('getAuthTokenByToken / récupère un token valide', async t => {
  const created = await createAuthToken('claire@example.com')
  const found = await getAuthTokenByToken(created.token)

  t.truthy(found)
  t.is(found.token, created.token)
  t.is(found.email, 'claire@example.com')
})

test.serial('getAuthTokenByToken / retourne null pour un token inexistant', async t => {
  const found = await getAuthTokenByToken('non-existent-token')

  t.is(found, null)
})

test.serial('getAuthTokenByToken / retourne null pour un token expiré', async t => {
  const authToken = await createAuthToken('expired@example.com', -1) // Expire immédiatement

  // Attendre un peu pour être sûr que le token est expiré
  await new Promise(resolve => {
    setTimeout(resolve, 100)
  })

  const found = await getAuthTokenByToken(authToken.token)

  t.is(found, null)
})

test.serial('deleteAuthToken / supprime un token', async t => {
  const authToken = await createAuthToken('delete@example.com')

  await deleteAuthToken(authToken.token)

  const found = await getAuthTokenByToken(authToken.token)
  t.is(found, null)
})
