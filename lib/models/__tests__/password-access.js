import test from 'ava'
import {Buffer} from 'node:buffer'

import {
  consumePasswordActivation,
  hashPasswordActivationToken,
  issuePasswordActivation,
  PASSWORD_ACTIVATION_TTL_SECONDS,
  replacePasswordCredential
} from '../password-access.js'

test('issuePasswordActivation crée un jeton opaque de 256 bits valable exactement 72 heures', async t => {
  const now = new Date('2026-08-21T12:00:00.000Z')
  let createdData
  const transaction = {
    user: {
      async findFirst() {
        return {
          id: '11111111-1111-4111-8111-111111111111',
          email: 'personne@example.test',
          role: 'DECLARANT',
          authVersion: 2
        }
      }
    },
    passwordCredential: {
      async findUnique() {
        return null
      }
    },
    sessionToken: {
      async deleteMany() {
        return {count: 0}
      }
    },
    passwordActivation: {
      async deleteMany() {},
      async create({data}) {
        createdData = data
        return {createdAt: now, expiresAt: data.expiresAt}
      }
    }
  }
  const client = {
    async $transaction(callback) {
      return callback(transaction)
    }
  }

  const result = await issuePasswordActivation(
    '11111111-1111-4111-8111-111111111111',
    {
      client,
      now,
      async lockUser() {
        return true
      }
    }
  )

  t.is(Buffer.from(result.token, 'base64url').length, 32)
  t.is(createdData.tokenHash, hashPasswordActivationToken(result.token))
  t.is(createdData.authVersion, 2)
  t.is(
    result.activation.expiresAt.getTime() - now.getTime(),
    PASSWORD_ACTIVATION_TTL_SECONDS * 1000
  )
  t.is(PASSWORD_ACTIVATION_TTL_SECONDS, 72 * 60 * 60)
  t.false(result.reset)
  t.is(result.sessionsRevoked, 0)
})

test('issuePasswordActivation révoque credential et sessions uniquement lors d’un reset', async t => {
  const calls = []
  const transaction = {
    user: {
      async findFirst() {
        return {
          id: 'user-id',
          email: 'personne@example.test',
          role: 'DECLARANT',
          authVersion: 0
        }
      }
    },
    passwordCredential: {
      async findUnique() {
        return {userId: 'user-id'}
      },
      async delete() {
        calls.push('credential')
      }
    },
    sessionToken: {
      async deleteMany() {
        calls.push('sessions')
        return {count: 3}
      }
    },
    passwordActivation: {
      async deleteMany() {
        calls.push('activation')
      },
      async create({data}) {
        return {createdAt: new Date(), expiresAt: data.expiresAt}
      }
    }
  }
  const client = {
    async $transaction(callback) {
      return callback(transaction)
    }
  }

  const result = await issuePasswordActivation('user-id', {
    client,
    async lockUser() {
      return true
    }
  })

  t.true(result.reset)
  t.is(result.sessionsRevoked, 3)
  t.deepEqual(calls, ['credential', 'sessions', 'activation'])
})

test('replacePasswordCredential échoue fermé après un reset concurrent', async t => {
  let updateCalled = false
  const transaction = {
    passwordCredential: {
      async update() {
        updateCalled = true
      }
    }
  }
  const client = {
    async $transaction(callback) {
      return callback(transaction)
    }
  }

  const result = await replacePasswordCredential(
    {id: 'user-id', role: 'DECLARANT'},
    {passwordHash: 'new-hash', pepperVersion: 2},
    {
      client,
      expectedCredential: {passwordHash: 'old-hash', pepperVersion: 1},
      async lockCredential() {
        return false
      }
    }
  )

  t.is(result, null)
  t.false(updateCalled)
})

test('replacePasswordCredential ne recrée pas de session après révocation', async t => {
  let updateCalled = false
  const transaction = {
    passwordCredential: {
      async update() {
        updateCalled = true
      }
    }
  }
  const client = {
    async $transaction(callback) {
      return callback(transaction)
    }
  }

  const error = await t.throwsAsync(replacePasswordCredential(
    {id: 'user-id', role: 'DECLARANT'},
    {passwordHash: 'new-hash', pepperVersion: 2},
    {
      client,
      expectedCredential: {passwordHash: 'old-hash', pepperVersion: 1},
      sessionToken: 'session-révoquée',
      async lockCredential() {
        return true
      },
      async validateSession() {
        throw Object.assign(new Error('session révoquée'), {status: 401})
      }
    }
  ))

  t.is(error.status, 401)
  t.false(updateCalled)
})

test('replacePasswordCredential relit la génération avant de recréer la session', async t => {
  let createdSessionData
  const transaction = {
    user: {
      async findFirst() {
        return {id: 'user-id', role: 'DECLARANT', authVersion: 5}
      }
    },
    passwordCredential: {
      async update() {}
    },
    passwordActivation: {
      async deleteMany() {}
    },
    sessionToken: {
      async deleteMany() {},
      async create({data}) {
        createdSessionData = data
        return {...data, createdAt: new Date()}
      }
    }
  }
  const client = {
    async $transaction(callback) {
      return callback(transaction)
    }
  }

  await replacePasswordCredential(
    {id: 'user-id', role: 'DECLARANT', authVersion: 4},
    {passwordHash: 'new-hash', pepperVersion: 2},
    {
      client,
      expectedCredential: {passwordHash: 'old-hash', pepperVersion: 1},
      async lockCredential() {
        return true
      }
    }
  )

  t.is(createdSessionData.authVersion, 5)
})

test('consumePasswordActivation revalide le lien après avoir verrouillé l’utilisateur', async t => {
  let activationLookupCount = 0
  let credentialWritten = false
  const transaction = {
    passwordActivation: {
      async findFirst() {
        activationLookupCount++
        return activationLookupCount === 1 ? {userId: 'user-id'} : null
      }
    },
    passwordCredential: {
      async upsert() {
        credentialWritten = true
      }
    }
  }
  const client = {
    async $transaction(callback) {
      return callback(transaction)
    }
  }

  const result = await consumePasswordActivation(
    'ancien-token-remplace-pendant-le-verrouillage',
    {passwordHash: 'hash', pepperVersion: 1},
    {
      client,
      async lockUser() {
        return true
      }
    }
  )

  t.is(result, null)
  t.is(activationLookupCount, 2)
  t.false(credentialWritten)
})
