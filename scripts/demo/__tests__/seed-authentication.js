import test from 'ava'

import {resetPersonaAuthentication} from '../lib/seed-authentication.js'

function personaRecords() {
  return Array.from({length: 6}, (_, index) => ({
    id: `persona-${index + 1}`,
    email: `persona-${index + 1}@demo.invalid`,
    role: index < 2 ? 'INSTRUCTOR' : 'DECLARANT',
    firstName: `Prénom ${index + 1}`,
    lastName: `Persona ${index + 1}`,
    deletedAt: null
  }))
}

function buildDatabase({existingUsers = [], counts = {}} = {}) {
  const calls = {}
  const record = (name, result) => async query => {
    calls[name] ??= []
    calls[name].push(query)
    return result
  }

  const mutation = name => record(name, {count: counts[name] ?? 0})

  return {
    calls,
    database: {
      $queryRawUnsafe: record('$queryRawUnsafe', []),
      user: {
        findMany: record('user.findMany', existingUsers),
        updateMany: mutation('user.updateMany')
      },
      userEmailAlias: {deleteMany: mutation('userEmailAlias.deleteMany')},
      userEmailVerification: {
        async updateMany(query) {
          const name = query.where.status
            ? 'userEmailVerification.cancel'
            : 'userEmailVerification.clearTokens'
          calls[name] ??= []
          calls[name].push(query)
          return {count: counts[name] ?? 0}
        }
      },
      passwordCredential: {deleteMany: mutation('passwordCredential.deleteMany')},
      passwordActivation: {deleteMany: mutation('passwordActivation.deleteMany')},
      authToken: {deleteMany: mutation('authToken.deleteMany')},
      sessionToken: {deleteMany: mutation('sessionToken.deleteMany')}
    }
  }
}

function emptyArtifacts(user) {
  return {
    ...user,
    emailAliases: [],
    emailVerifications: [],
    passwordCredential: null,
    passwordActivation: null,
    authTokens: [],
    sessionTokens: []
  }
}

test('purge les artefacts des seuls personas et invalide les profils modifiés', async t => {
  const records = personaRecords()
  const changed = {
    ...emptyArtifacts(records[0]),
    email: 'ancienne-adresse@demo.invalid',
    role: 'DECLARANT',
    emailAliases: [{id: 'alias-id'}]
  }
  const roleChanged = {
    ...emptyArtifacts(records[1]),
    role: 'DECLARANT'
  }
  const unchanged = emptyArtifacts(records[2])
  const {database, calls} = buildDatabase({
    existingUsers: [changed, roleChanged, unchanged],
    counts: {
      'user.updateMany': 1,
      'userEmailAlias.deleteMany': 1,
      'userEmailVerification.cancel': 1,
      'userEmailVerification.clearTokens': 1,
      'passwordCredential.deleteMany': 1,
      'passwordActivation.deleteMany': 1,
      'authToken.deleteMany': 1,
      'sessionToken.deleteMany': 2
    }
  })

  const result = await resetPersonaAuthentication({
    database,
    userRecords: [
      ...records,
      {id: 'background-user', email: null, role: 'DECLARANT'}
    ]
  })
  const personaIds = records.map(record => record.id)

  t.deepEqual(result, {
    personaUsers: 6,
    existingPersonaUsers: 3,
    changedUsers: 2,
    authVersionsIncrementedExplicitly: 1,
    aliasesDeleted: 1,
    emailVerificationsCancelled: 1,
    emailVerificationTokensCleared: 1,
    passwordCredentialsDeleted: 1,
    passwordActivationsDeleted: 1,
    authTokensDeleted: 1,
    sessionTokensDeleted: 2
  })
  t.deepEqual(calls['user.findMany'][0].where.id.in, personaIds)
  t.deepEqual(calls['user.updateMany'][0], {
    where: {id: {in: [roleChanged.id]}},
    data: {authVersion: {increment: 1}}
  })
  t.deepEqual(calls['sessionToken.deleteMany'][0].where, {
    OR: [
      {userId: {in: [changed.id, roleChanged.id]}},
      {impersonatedByUserId: {in: [changed.id, roleChanged.id]}}
    ]
  })
  t.false(JSON.stringify(result).includes(changed.email))
  t.false(JSON.stringify(result).includes('auth-token-id'))
  t.false(JSON.stringify(calls).includes('background-user'))
})

test('reste sans incrément lors d’une première création passwordless', async t => {
  const records = personaRecords()
  const {database, calls} = buildDatabase()

  const result = await resetPersonaAuthentication({database, userRecords: records})

  t.is(result.personaUsers, 6)
  t.is(result.existingPersonaUsers, 0)
  t.is(result.changedUsers, 0)
  t.is(result.authVersionsIncrementedExplicitly, 0)
  t.is(calls['user.updateMany'], undefined)
  t.is(calls['authToken.deleteMany'], undefined)
  t.is(calls['sessionToken.deleteMany'], undefined)
  t.true(Object.entries(result)
    .filter(([key]) => key.endsWith('Deleted') || key.endsWith('Cancelled'))
    .every(([, value]) => value === 0))
})

test('retire le mot de passe sans révoquer une session si l’identité est stable', async t => {
  const records = personaRecords()
  const {database, calls} = buildDatabase({
    existingUsers: records.map(emptyArtifacts),
    counts: {
      'passwordCredential.deleteMany': 1,
      'passwordActivation.deleteMany': 1
    }
  })

  const result = await resetPersonaAuthentication({database, userRecords: records})

  t.is(result.changedUsers, 0)
  t.is(result.passwordCredentialsDeleted, 1)
  t.is(result.passwordActivationsDeleted, 1)
  t.is(result.authTokensDeleted, 0)
  t.is(result.sessionTokensDeleted, 0)
  t.is(result.authVersionsIncrementedExplicitly, 0)
  t.is(calls['authToken.deleteMany'], undefined)
  t.is(calls['sessionToken.deleteMany'], undefined)
  t.is(calls['user.updateMany'], undefined)
})

test('refuse une portée différente des six personas uniques', async t => {
  const records = personaRecords()
  const {database} = buildDatabase()

  await t.throwsAsync(
    resetPersonaAuthentication({database, userRecords: records.slice(1)}),
    {message: 'Le nettoyage d’authentification requiert exactement six personas uniques'}
  )
  await t.throwsAsync(
    resetPersonaAuthentication({
      database,
      userRecords: [...records.slice(0, 5), records[0]]
    }),
    {message: 'Le nettoyage d’authentification requiert exactement six personas uniques'}
  )
})
