import test from 'ava'

import {
  activatePassword,
  authenticateWithPassword,
  changePassword
} from '../password-auth.js'

const USER = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'personne@example.test',
  firstName: 'Camille',
  lastName: 'Rivière',
  role: 'DECLARANT',
  authVersion: 3
}

function createTransactionClient() {
  const updates = []
  const transaction = {
    user: {
      async update(operation) {
        updates.push(operation)
      }
    }
  }

  return {
    updates,
    transaction,
    client: {
      async $transaction(callback) {
        return callback(transaction)
      }
    }
  }
}

test('authenticateWithPassword calcule un hash factice sans utilisateur', async t => {
  let dummyCalls = 0
  const result = await authenticateWithPassword('inconnu@example.test', 'secret', {
    async findUserByEmail() {
      return null
    },
    async verifyDummy() {
      dummyCalls++
    }
  })

  t.is(result, null)
  t.is(dummyCalls, 1)
})

test('authenticateWithPassword borne email et mot de passe avant toute normalisation coûteuse', async t => {
  let dummyCalls = 0
  const result = await authenticateWithPassword('x'.repeat(1_000_000), 'y'.repeat(1_000_000), {
    async findUserByEmail() {
      t.fail('Un email démesuré ne doit jamais atteindre la résolution utilisateur.')
    },
    async verifyDummy(password) {
      dummyCalls++
      t.is(password.length, 1_000_000)
    }
  })

  t.is(result, null)
  t.is(dummyCalls, 1)
})

test('authenticateWithPassword calcule un hash factice sans credential', async t => {
  let dummyCalls = 0
  const result = await authenticateWithPassword(USER.email, 'secret', {
    async findUserByEmail() {
      return USER
    },
    async findCredential() {
      return null
    },
    async verifyDummy() {
      dummyCalls++
    }
  })

  t.is(result, null)
  t.is(dummyCalls, 1)
})

test('authenticateWithPassword conserve une réponse générique après un mauvais mot de passe', async t => {
  const result = await authenticateWithPassword(USER.email, 'secret', {
    async findUserByEmail() {
      return USER
    },
    async findCredential() {
      return {passwordHash: 'hash', pepperVersion: 1}
    },
    async verify() {
      return {valid: false, needsRehash: false}
    }
  })

  t.is(result.user, USER)
  t.is(result.session, null)
})

test('authenticateWithPassword rehash puis crée une session et met à jour lastLoginAt', async t => {
  const {client, transaction, updates} = createTransactionClient()
  const now = new Date('2026-08-21T12:00:00.000Z')
  const replacement = {passwordHash: 'new-hash', pepperVersion: 2}
  const session = {token: 'session', expiresAt: new Date('2026-08-21T20:00:00.000Z')}
  const rehashCalls = []

  const result = await authenticateWithPassword(USER.email, 'secret', {
    client,
    now,
    async findUserByEmail() {
      return USER
    },
    async findCredential() {
      return {passwordHash: 'old-hash', pepperVersion: 1}
    },
    async verify() {
      return {valid: true, needsRehash: true}
    },
    async hash() {
      return replacement
    },
    async lockUser(userId, options) {
      t.is(userId, USER.id)
      t.is(options.client, transaction)
      return true
    },
    async lockCredential(userId, expectedCredential, options) {
      t.is(userId, USER.id)
      t.is(expectedCredential.passwordHash, 'old-hash')
      t.is(options.client, transaction)
      return true
    },
    async updateCredentialHash(userId, credential, options) {
      rehashCalls.push({userId, credential, options})
    },
    async createSession(userId, role, ttl, options) {
      t.is(options.client, transaction)
      t.is(options.authVersion, USER.authVersion)
      t.is(userId, USER.id)
      t.is(role, USER.role)
      t.is(ttl, undefined)
      return session
    }
  })

  t.is(result.user, USER)
  t.is(result.session, session)
  t.deepEqual(rehashCalls, [{
    userId: USER.id,
    credential: replacement,
    options: {client: transaction}
  }])
  t.deepEqual(updates, [{where: {id: USER.id}, data: {lastLoginAt: now}}])
})

test('authenticateWithPassword ne crée pas de session si le credential change après vérification', async t => {
  const {client} = createTransactionClient()
  const result = await authenticateWithPassword(USER.email, 'secret', {
    client,
    async findUserByEmail() {
      return USER
    },
    async findCredential() {
      return {passwordHash: 'old-hash', pepperVersion: 1}
    },
    async verify() {
      return {valid: true, needsRehash: false}
    },
    async lockUser() {
      return true
    },
    async lockCredential() {
      return false
    },
    async createSession() {
      t.fail('Aucune session ne doit survivre à un reset concurrent.')
    }
  })

  t.is(result.user, USER)
  t.is(result.session, null)
})

test('authenticateWithPassword revalide l’adresse sous le verrou du compte', async t => {
  const {client} = createTransactionClient()
  let userReads = 0
  const result = await authenticateWithPassword(USER.email, 'secret', {
    client,
    async findUserByEmail() {
      userReads += 1
      return userReads === 1 ? USER : null
    },
    async findCredential() {
      return {passwordHash: 'old-hash', pepperVersion: 1}
    },
    async verify() {
      return {valid: true, needsRehash: false}
    },
    async lockUser() {
      return true
    },
    async lockCredential() {
      t.fail('Le credential ne doit pas être consommé après un changement d’adresse.')
    },
    async createSession() {
      t.fail('Aucune session ne doit être créée avec l’ancienne adresse.')
    }
  })

  t.is(result.user, USER)
  t.is(result.session, null)
  t.is(userReads, 2)
})

test('activatePassword refuse un lien expiré sans évaluer le mot de passe', async t => {
  let hashCalled = false
  const result = await activatePassword('x'.repeat(43), 'secret', {
    async findActivation() {
      return null
    },
    async hash() {
      hashCalled = true
    }
  })

  t.is(result, null)
  t.false(hashCalled)
})

test('activatePassword valide la policy et consomme le lien une seule fois', async t => {
  const session = {token: 'session', expiresAt: new Date('2026-08-21T20:00:00.000Z')}
  const credential = {passwordHash: 'hash', pepperVersion: 1}
  let consumeCalls = 0
  const result = await activatePassword(
    'x'.repeat(43),
    'Deux grandes rivières courent vite ! 2048',
    {
      async findActivation() {
        return {user: USER}
      },
      async hash() {
        return credential
      },
      async consumeActivation(token, suppliedCredential) {
        consumeCalls++
        t.is(token, 'x'.repeat(43))
        t.is(suppliedCredential, credential)
        return consumeCalls === 1 ? session : null
      }
    }
  )

  t.is(result.user, USER)
  t.is(result.session, session)
  t.is(consumeCalls, 1)
})

test('changePassword calcule un hash factice sans credential', async t => {
  let dummyCalls = 0
  const result = await changePassword(USER, 'ancien', 'nouveau', {
    async findCredential() {
      return null
    },
    async verifyDummy() {
      dummyCalls++
    }
  })

  t.is(result, null)
  t.is(dummyCalls, 1)
})

test('changePassword vérifie l’ancien secret puis remplace credential et session', async t => {
  const session = {token: 'nouvelle-session'}
  const replacement = {passwordHash: 'new-hash', pepperVersion: 1}
  const result = await changePassword(
    USER,
    'ancien secret',
    'Deux grandes rivières courent vite ! 2048',
    {
      async findCredential() {
        return {passwordHash: 'old-hash', pepperVersion: 1}
      },
      async verify() {
        return {valid: true, needsRehash: false}
      },
      async hash() {
        return replacement
      },
      async replaceCredential(user, credential, options) {
        t.is(user, USER)
        t.is(credential, replacement)
        t.is(options.expectedCredential.passwordHash, 'old-hash')
        return session
      }
    }
  )

  t.is(result, session)
})
