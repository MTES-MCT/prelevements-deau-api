import test from 'ava'

import {createUserEmailAlias} from '../user-email-alias.js'

const USER_ID = '11111111-1111-4111-8111-111111111111'

test('createUserEmailAlias verrouille un utilisateur actif avant de créer l’alias', async t => {
  let createdData
  const tx = {
    async $queryRaw(query, userId) {
      t.is(userId, USER_ID)
      t.regex(query.join(' '), /FOR SHARE/)
      return [{id: USER_ID, email: 'principal@example.test'}]
    },
    userEmailAlias: {
      async create({data}) {
        createdData = data
        return data
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
