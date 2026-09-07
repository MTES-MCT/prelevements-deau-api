import test from 'ava'

import {
  serializeUserProfile,
  updateCurrentUserProfile
} from '../user-profile.js'

const activeDeclarant = {
  id: '11111111-1111-4111-8111-111111111111',
  role: 'DECLARANT',
  email: 'alice@example.test',
  emailAliases: [],
  emailVerifications: [],
  firstName: 'Alice',
  lastName: 'Martin',
  lastLoginAt: null,
  deletedAt: null,
  declarant: {
    declarantType: 'NATURAL_PERSON',
    declarantRole: 'PRELEVEUR',
    preleveurType: 'IRRIGANT',
    socialReason: null,
    civility: 'MRS',
    addressLine1: null,
    addressLine2: null,
    poBox: null,
    postalCode: null,
    city: null,
    phoneNumber: null,
    jobTitle: null
  },
  instructor: null
}

function createClient(currentUser, updatedUser = currentUser) {
  const calls = {}
  const transaction = {
    user: {
      async findFirst(query) {
        calls.findFirst = query
        return currentUser
      },
      async update(query) {
        calls.update = query
        return updatedUser
      }
    }
  }

  return {
    calls,
    client: {
      async $transaction(callback) {
        calls.transaction = true
        return callback(transaction)
      }
    }
  }
}

test('met à jour transactionnellement les tables User et Declarant d’un compte actif', async t => {
  const updatedUser = {
    ...activeDeclarant,
    firstName: 'Aline',
    declarant: {
      ...activeDeclarant.declarant,
      phoneNumber: '0102030405'
    }
  }
  const {calls, client} = createClient(activeDeclarant, updatedUser)

  const result = await updateCurrentUserProfile(activeDeclarant.id, {
    firstName: ' Aline ',
    phoneNumber: '0102030405'
  }, {client})

  t.true(calls.transaction)
  t.deepEqual(calls.findFirst.where, {
    id: activeDeclarant.id,
    deletedAt: null
  })
  t.deepEqual(calls.update.where, {
    id: activeDeclarant.id,
    deletedAt: null
  })
  t.deepEqual(calls.update.data, {
    firstName: 'Aline',
    declarant: {
      update: {
        data: {phoneNumber: '0102030405'}
      }
    }
  })
  t.is(result, updatedUser)
})

test('autorise explicitement la session d’assistance après le verrouillage', async t => {
  const {client} = createClient(activeDeclarant)
  let sessionOptions

  await updateCurrentUserProfile(activeDeclarant.id, {
    firstName: 'Aline'
  }, {
    allowImpersonatedSession: true,
    client,
    sessionToken: 'session-assistance',
    async lockUser() {
      return true
    },
    async validateSession(userId, token, options) {
      t.is(userId, activeDeclarant.id)
      t.is(token, 'session-assistance')
      sessionOptions = options
    }
  })

  t.true(sessionOptions.allowImpersonated)
})

test('met à jour les coordonnées dans la relation Instructor', async t => {
  const instructor = {
    ...activeDeclarant,
    role: 'INSTRUCTOR',
    firstName: 'Ada',
    lastName: 'Lovelace',
    declarant: null,
    instructor: {phoneNumber: null, jobTitle: null}
  }
  const {calls, client} = createClient(instructor)

  await updateCurrentUserProfile(instructor.id, {
    jobTitle: 'Chargée de mission'
  }, {client})

  t.deepEqual(calls.update.data, {
    instructor: {
      update: {
        data: {jobTitle: 'Chargée de mission'}
      }
    }
  })
})

test('refuse un utilisateur supprimé ou introuvable', async t => {
  const {client} = createClient(null)

  const error = await t.throwsAsync(
    updateCurrentUserProfile(activeDeclarant.id, {firstName: 'Aline'}, {client})
  )

  t.is(error.statusCode, 404)
})

test('sérialise les champs pertinents selon le rôle', t => {
  const declarant = serializeUserProfile(activeDeclarant)
  t.like(declarant, {
    id: activeDeclarant.id,
    firstName: 'Alice',
    emailVerifications: [],
    declarantType: 'NATURAL_PERSON',
    phoneNumber: null,
    jobTitle: null
  })

  const instructor = serializeUserProfile({
    ...activeDeclarant,
    role: 'INSTRUCTOR',
    declarant: null,
    instructor: {
      phoneNumber: '0102030405',
      jobTitle: 'Chargée de mission'
    }
  })
  t.like(instructor, {
    phoneNumber: '0102030405',
    jobTitle: 'Chargée de mission'
  })
  t.false(Object.hasOwn(instructor, 'declarantType'))
})

test('sérialise les états de validation email sans exposer les secrets', t => {
  const profile = serializeUserProfile({
    ...activeDeclarant,
    emailVerifications: [{
      id: 'verification-1',
      purpose: 'PRIMARY_CHANGE',
      email: 'nouvelle@example.test',
      status: 'PENDING',
      tokenHash: 'secret',
      primaryEmailSnapshot: 'alice@example.test',
      createdAt: new Date('2026-08-29T10:00:00.000Z'),
      sentAt: new Date('2026-08-29T10:00:00.000Z'),
      expiresAt: new Date('2026-08-30T10:00:00.000Z'),
      verifiedAt: null,
      cancelledAt: null
    }]
  })

  t.like(profile.emailVerifications[0], {
    id: 'verification-1',
    purpose: 'PRIMARY_CHANGE',
    email: 'nouvelle@example.test',
    status: 'EXPIRED'
  })
  t.false(Object.hasOwn(profile.emailVerifications[0], 'tokenHash'))
  t.false(Object.hasOwn(profile.emailVerifications[0], 'primaryEmailSnapshot'))
})
