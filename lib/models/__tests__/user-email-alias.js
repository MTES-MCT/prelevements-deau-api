import test from 'ava'

import {
  createUserEmailAlias,
  deleteUserEmailAlias,
  isEmailAliasConflictError
} from '../user-email-alias.js'

const USER_ID = '11111111-1111-4111-8111-111111111111'

test('isEmailAliasConflictError reconnaît une adresse en cours de validation', t => {
  t.true(isEmailAliasConflictError(
    new Error('constraint UserEmailAlias_email_reserved failed')
  ))
})

test('isEmailAliasConflictError reconnaît une course détectée par le registre', t => {
  t.true(isEmailAliasConflictError({
    code: 'P2004',
    meta: {
      database_error: 'constraint UserEmailIdentity_compatible_claims_check failed'
    }
  }))
})

test('createUserEmailAlias verrouille exclusivement un utilisateur actif avant de créer l’alias', async t => {
  let createdData
  const tx = {
    async $queryRaw(query, userId) {
      t.is(userId, USER_ID)
      t.regex(query.join(' '), /FOR UPDATE/)
      return [{id: USER_ID, email: 'principal@example.test'}]
    },
    userEmailAlias: {
      async create({data}) {
        createdData = data
        return data
      }
    },
    userEmailVerification: {
      async updateMany({where, data}) {
        t.deepEqual(where, {
          userId: USER_ID,
          email: 'alias@example.test',
          status: {in: ['PENDING', 'SEND_FAILED']}
        })
        t.deepEqual(data, {
          status: 'SUPERSEDED',
          tokenHash: null
        })
      }
    }
  }
  const client = {
    async $transaction(callback) {
      return callback(tx)
    }
  }

  const alias = await createUserEmailAlias(
    USER_ID,
    ' ALIAS@EXAMPLE.TEST ',
    {client}
  )

  t.like(createdData, {
    userId: USER_ID,
    email: 'alias@example.test'
  })
  t.regex(createdData.id, /^[\da-f-]{36}$/)
  t.is(alias, createdData)
})

test('createUserEmailAlias refuse un utilisateur supprimé après le verrouillage', async t => {
  let aliasCreated = false
  const tx = {
    async $queryRaw() {
      return []
    },
    userEmailAlias: {
      async create() {
        aliasCreated = true
      }
    },
    userEmailVerification: {
      async updateMany() {}
    }
  }
  const client = {
    async $transaction(callback) {
      return callback(tx)
    }
  }

  const error = await t.throwsAsync(
    createUserEmailAlias(USER_ID, 'alias@example.test', {client}),
    {message: 'Utilisateur introuvable.'}
  )

  t.is(error.status, 404)
  t.false(aliasCreated)
})

test('deleteUserEmailAlias conserve la dernière adresse de connexion', async t => {
  let deleted = false
  const tx = {
    async $queryRaw(query, userId) {
      t.is(userId, USER_ID)
      t.regex(query.join(' '), /FOR UPDATE/)
      return [{id: USER_ID, email: null}]
    },
    userEmailAlias: {
      async count() {
        return 1
      },
      async delete() {
        deleted = true
      }
    }
  }
  const client = {
    async $transaction(callback) {
      return callback(tx)
    }
  }

  const error = await t.throwsAsync(
    deleteUserEmailAlias(USER_ID, 'alias-id', {
      client,
      requireRemainingLogin: true
    }),
    {message: 'Vous devez conserver au moins une adresse permettant de vous connecter.'}
  )

  t.is(error.status, 409)
  t.false(deleted)
})

test('deleteUserEmailAlias supprime un alias et neutralise sa promotion en cours', async t => {
  const alias = {
    id: 'alias-id',
    userId: USER_ID,
    email: 'alias@example.test'
  }
  let countCalled = false
  let authTokensRevoked = false
  let sessionValidated = false
  let verificationSuperseded = false
  const tx = {
    async $queryRaw() {
      return [{id: USER_ID, email: 'principal@example.test'}]
    },
    userEmailAlias: {
      async count() {
        countCalled = true
      },
      async findFirst() {
        return alias
      },
      async delete({where}) {
        t.deepEqual(where, {id: alias.id})
        return alias
      }
    },
    authToken: {
      async deleteMany({where}) {
        t.deepEqual(where, {userId: USER_ID})
        authTokensRevoked = true
      }
    },
    userEmailVerification: {
      async updateMany({where, data}) {
        t.deepEqual(where, {
          userId: USER_ID,
          email: alias.email,
          status: {in: ['PENDING', 'SEND_FAILED']}
        })
        t.deepEqual(data, {
          status: 'SUPERSEDED',
          tokenHash: null
        })
        verificationSuperseded = true
      }
    }
  }
  const client = {
    async $transaction(callback) {
      return callback(tx)
    }
  }

  const deletedAlias = await deleteUserEmailAlias(USER_ID, alias.id, {
    allowImpersonatedSession: true,
    client,
    requireRemainingLogin: true,
    sessionToken: 'session-assistance',
    async validateSession(userId, token, options) {
      t.is(userId, USER_ID)
      t.is(token, 'session-assistance')
      t.true(options.allowImpersonated)
      sessionValidated = true
    }
  })

  t.is(deletedAlias, alias)
  t.false(countCalled)
  t.true(authTokensRevoked)
  t.true(sessionValidated)
  t.true(verificationSuperseded)
})
