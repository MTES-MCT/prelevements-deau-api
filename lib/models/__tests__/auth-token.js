import test from 'ava'

import {issueAuthTokenForLoginEmail} from '../auth-token.js'

const USER = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'personne@example.test',
  role: 'DECLARANT',
  authVersion: 3
}

function transactionClient(transaction) {
  return {
    async $transaction(callback) {
      return callback(transaction)
    }
  }
}

test('issueAuthTokenForLoginEmail revalide l’adresse après verrouillage', async t => {
  let reads = 0
  let tokenCreated = false
  const transaction = {
    authToken: {
      async create() {
        tokenCreated = true
      }
    }
  }

  const result = await issueAuthTokenForLoginEmail(USER.email, 900, {
    client: transactionClient(transaction),
    async findUserByEmail() {
      reads += 1
      return reads === 1 ? USER : null
    },
    async lockUser() {
      return true
    }
  })

  t.is(result, null)
  t.false(tokenCreated)
  t.is(reads, 2)
})

test('issueAuthTokenForLoginEmail crée le lien sous le verrou du compte', async t => {
  let lockClient
  const createdAt = new Date('2026-08-31T12:00:00.000Z')
  const transaction = {
    authToken: {
      async create({data}) {
        t.is(data.userId, USER.id)
        t.is(data.authVersion, USER.authVersion)
        return {...data, createdAt}
      }
    }
  }

  const result = await issueAuthTokenForLoginEmail(USER.email, 900, {
    client: transactionClient(transaction),
    async findUserByEmail() {
      return USER
    },
    async lockUser(_userId, {client}) {
      lockClient = client
      return true
    }
  })

  t.is(lockClient, transaction)
  t.is(result.user, USER)
  t.is(result.authToken.userId, USER.id)
  t.is(result.authToken.createdAt, createdAt)
})
