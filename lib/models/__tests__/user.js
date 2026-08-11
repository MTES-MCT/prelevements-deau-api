import test from 'ava'

import {getAuthUserByEmail, getUserByEmail} from '../user.js'

test('getAuthUserByEmail limite la résolution principale aux utilisateurs actifs', async t => {
  let primaryQuery
  const expectedUser = {
    id: 'user-1',
    email: 'user@example.test',
    role: 'DECLARANT'
  }
  const client = {
    user: {
      async findFirst(query) {
        primaryQuery = query
        return expectedUser
      }
    },
    userEmailAlias: {
      async findFirst() {
        t.fail('Un email principal trouvé ne doit pas déclencher la recherche d’un alias.')
      }
    }
  }

  const user = await getAuthUserByEmail(' USER@example.test ', {client})

  t.is(user, expectedUser)
  t.deepEqual(primaryQuery.where, {
    email: 'user@example.test',
    deletedAt: null
  })
})

test('getAuthUserByEmail limite la résolution d’un alias aux utilisateurs actifs', async t => {
  let aliasQuery
  const expectedUser = {
    id: 'user-1',
    email: 'primary@example.test',
    role: 'DECLARANT'
  }
  const client = {
    user: {
      async findFirst() {
        return null
      }
    },
    userEmailAlias: {
      async findFirst(query) {
        aliasQuery = query
        return {user: expectedUser}
      }
    }
  }

  const user = await getAuthUserByEmail(' ALIAS@example.test ', {client})

  t.is(user, expectedUser)
  t.deepEqual(aliasQuery.where, {
    email: 'alias@example.test',
    user: {deletedAt: null}
  })
})

test('getUserByEmail applique les mêmes filtres aux résolutions principale et alias', async t => {
  let primaryQuery
  let aliasQuery
  const expectedUser = {
    id: 'user-1',
    email: 'primary@example.test',
    deletedAt: null
  }
  const client = {
    user: {
      async findFirst(query) {
        primaryQuery = query
        return null
      }
    },
    userEmailAlias: {
      async findFirst(query) {
        aliasQuery = query
        return {user: expectedUser}
      }
    }
  }

  const user = await getUserByEmail(' ALIAS@example.test ', {client})

  t.is(user, expectedUser)
  t.deepEqual(primaryQuery.where, {
    email: 'alias@example.test',
    deletedAt: null
  })
  t.deepEqual(aliasQuery.where, {
    email: 'alias@example.test',
    user: {deletedAt: null}
  })
})
