import test from 'ava'
import {setupTestMongo, cleanupCollections} from '../../util/test-helpers/mongo.js'
import mongo from '../../util/mongo.js'
import {authenticateByToken} from '../auth.js'
import {insertUser} from '../../models/user.js'
import {insertToken} from '../../models/token.js'
import {createSessionToken} from '../../models/session-token.js'

setupTestMongo(test)
cleanupCollections(test, ['users', 'session_tokens', 'tokens', 'territoires'])

test.beforeEach(async () => {
  // Créer des territoires de test
  await mongo.db.collection('territoires').insertOne({code: 'DEP-974', nom: 'Réunion'})
  await mongo.db.collection('territoires').insertOne({code: 'DEP-971', nom: 'Guadeloupe'})
})

test.serial('authenticateByToken / authentifie avec un session token valide', async t => {
  const user = {
    email: 'alice@example.com',
    nom: 'Dupont',
    prenom: 'Alice',
    roles: [{territoire: 'DEP-974', role: 'editor'}]
  }

  const insertedUser = await insertUser(user)
  const session = await createSessionToken(insertedUser._id, 'DEP-974', 'editor')

  const auth = await authenticateByToken(session.token)

  t.truthy(auth)
  t.truthy(auth.user)
  t.is(auth.user.email, 'alice@example.com')
  t.truthy(auth.territoire)
  t.is(auth.territoire.code, 'DEP-974')
  t.is(auth.userRole, 'editor')
  t.is(auth.isAdmin, true)
})

test.serial('authenticateByToken / reader n\'est pas admin', async t => {
  const user = {
    email: 'bob@example.com',
    nom: 'Martin',
    prenom: 'Bob',
    roles: [{territoire: 'DEP-971', role: 'reader'}]
  }

  const insertedUser = await insertUser(user)
  const session = await createSessionToken(insertedUser._id, 'DEP-971', 'reader')

  const auth = await authenticateByToken(session.token)

  t.truthy(auth)
  t.is(auth.userRole, 'reader')
  t.is(auth.isAdmin, false)
})

test.serial('authenticateByToken / retourne null pour un session token inexistant', async t => {
  const auth = await authenticateByToken('non-existent-session-token')

  t.is(auth, null)
})

test.serial('authenticateByToken / retourne null si l\'utilisateur n\'existe plus', async t => {
  const user = {
    email: 'deleted@example.com',
    nom: 'Deleted',
    prenom: 'User',
    roles: [{territoire: 'DEP-974', role: 'editor'}]
  }

  const insertedUser = await insertUser(user)
  const session = await createSessionToken(insertedUser._id, 'DEP-974', 'editor')

  // Supprimer l'utilisateur
  await mongo.db.collection('users').deleteOne({_id: insertedUser._id})

  const auth = await authenticateByToken(session.token)

  t.is(auth, null)
})

test.serial('authenticateByToken / retourne null si le territoire n\'existe pas', async t => {
  const user = {
    email: 'territoire@example.com',
    nom: 'Test',
    prenom: 'User',
    roles: [{territoire: 'DEP-999', role: 'editor'}]
  }

  const insertedUser = await insertUser(user)
  const session = await createSessionToken(insertedUser._id, 'DEP-999', 'editor')

  const auth = await authenticateByToken(session.token)

  t.is(auth, null)
})

test.serial('authenticateByToken / fallback sur token legacy avec role editor', async t => {
  const token = 'legacy-token-editor'
  await insertToken(token, 'DEP-974', 'editor')

  const auth = await authenticateByToken(token)

  t.truthy(auth)
  t.is(auth.user, null) // Pas d'utilisateur pour les tokens legacy
  t.truthy(auth.territoire)
  t.is(auth.territoire.code, 'DEP-974')
  t.is(auth.userRole, 'editor')
  t.is(auth.isAdmin, true)
})

test.serial('authenticateByToken / fallback sur token legacy avec role reader', async t => {
  const token = 'legacy-token-reader'
  await insertToken(token, 'DEP-971', 'reader')

  const auth = await authenticateByToken(token)

  t.truthy(auth)
  t.is(auth.user, null)
  t.truthy(auth.territoire)
  t.is(auth.territoire.code, 'DEP-971')
  t.is(auth.userRole, 'reader')
  t.is(auth.isAdmin, false)
})

test.serial('authenticateByToken / retourne null pour un token legacy inexistant', async t => {
  const auth = await authenticateByToken('non-existent-legacy-token')

  t.is(auth, null)
})

test.serial('authenticateByToken / token legacy sans role utilise reader par défaut', async t => {
  const token = 'legacy-token-no-role'

  // Insérer directement sans role pour simuler ancien système
  await mongo.db.collection('tokens').insertOne({
    token,
    territoire: 'DEP-974'
    // Pas de champ role
  })

  const auth = await authenticateByToken(token)

  t.truthy(auth)
  t.is(auth.userRole, 'reader')
  t.is(auth.isAdmin, false)
})
