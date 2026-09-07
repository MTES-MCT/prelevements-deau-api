import test from 'ava'

import {processAuthTokenVerification} from '../auth.js'

test('processAuthTokenVerification refuse le magic link d’un utilisateur supprimé', async t => {
  const dependencies = {
    client: {
      async $transaction(callback) {
        return callback({})
      }
    },
    async getAuthTokenByToken() {
      return {userId: 'deleted-user'}
    },
    async getUserById() {
      return {
        id: 'deleted-user',
        role: 'DECLARANT',
        deletedAt: new Date('2026-08-11T12:00:00.000Z')
      }
    },
    async lockUser() {
      return true
    },
    async createSessionToken() {
      t.fail('Aucune session ne doit être créée pour un utilisateur supprimé.')
    },
    async updateLastLoginAt() {
      t.fail('La dernière connexion ne doit pas être mise à jour pour un utilisateur supprimé.')
    }
  }

  const error = await t.throwsAsync(() => processAuthTokenVerification(
    'magic-link-token',
    {},
    dependencies
  ))

  t.is(error.status, 401)
  t.is(error.message, 'Utilisateur non trouvé')
})

test('processAuthTokenVerification retourne aussi l’expiration de la session', async t => {
  const expiresAt = new Date('2026-08-21T20:00:00.000Z')
  const session = {token: 'session-token', expiresAt}
  const result = await processAuthTokenVerification('magic-link-token', {}, {
    client: {
      async $transaction(callback) {
        return callback({})
      }
    },
    async getAuthTokenByToken() {
      return {userId: 'active-user'}
    },
    async getUserById() {
      return {
        id: 'active-user',
        role: 'DECLARANT',
        authVersion: 4,
        deletedAt: null
      }
    },
    async lockUser() {
      return true
    },
    async createSessionToken(userId, role, ttl, options) {
      t.is(userId, 'active-user')
      t.is(role, 'DECLARANT')
      t.is(ttl, undefined)
      t.is(options.authVersion, 4)
      return session
    },
    async updateLastLoginAt() {}
  })

  t.is(result, session)
  t.is(result.expiresAt, expiresAt)
})

test('processAuthTokenVerification revalide le magic link après verrouillage', async t => {
  let tokenReads = 0
  let sessionCreated = false
  const error = await t.throwsAsync(() => processAuthTokenVerification(
    'magic-link-token',
    {},
    {
      client: {
        async $transaction(callback) {
          return callback({})
        }
      },
      async getAuthTokenByToken() {
        tokenReads += 1
        return tokenReads === 1 ? {userId: 'active-user'} : null
      },
      async lockUser() {
        return true
      },
      async getUserById() {
        t.fail('Le compte ne doit pas être chargé si le lien a été révoqué.')
      },
      async createSessionToken() {
        sessionCreated = true
      },
      async updateLastLoginAt() {}
    }
  ))

  t.is(error.status, 401)
  t.false(sessionCreated)
  t.is(tokenReads, 2)
})
