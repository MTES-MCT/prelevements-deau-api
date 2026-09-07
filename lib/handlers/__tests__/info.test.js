import test from 'ava'

import {createGetInfoHandler} from '../info.js'

function createInfoHandler(options = {}) {
  return createGetInfoHandler({
    async getEmailVerifications() {
      return []
    },
    ...options
  })
}

test('getInfoHandler expose l’expiration de la session API', async t => {
  const expiresAt = new Date('2026-08-21T20:00:00.000Z')
  const request = {
    auth: {type: 'USER_SESSION', expiresAt},
    user: {
      id: 'user-id',
      role: 'DECLARANT',
      email: 'personne@example.test',
      emailAliases: []
    },
    userRole: 'DECLARANT'
  }
  let responseBody
  const response = {
    send(body) {
      responseBody = body
      return this
    }
  }

  await createInfoHandler()(request, response)

  t.is(responseBody.expiresAt, expiresAt)
  t.is(responseBody.user.id, 'user-id')
})

test('getInfoHandler expose la fonction d’un déclarant', async t => {
  const request = {
    auth: {type: 'USER_SESSION'},
    user: {
      id: 'user-id',
      role: 'DECLARANT',
      email: 'personne@example.test',
      emailAliases: [],
      firstName: 'Alice',
      lastName: 'Martin',
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
        phoneNumber: '0102030405',
        jobTitle: 'Exploitante'
      }
    },
    userRole: 'DECLARANT'
  }
  let responseBody
  const response = {
    send(body) {
      responseBody = body
      return this
    }
  }

  await createInfoHandler()(request, response)

  t.is(responseBody.user.phoneNumber, '0102030405')
  t.is(responseBody.user.jobTitle, 'Exploitante')
})

test('getInfoHandler expose le téléphone et la fonction d’un agent', async t => {
  const request = {
    auth: {type: 'USER_SESSION'},
    user: {
      id: 'user-id',
      role: 'INSTRUCTOR',
      email: 'agent@example.test',
      emailAliases: [],
      firstName: 'Ada',
      lastName: 'Lovelace',
      instructor: {
        phoneNumber: '0102030405',
        jobTitle: 'Chargée de mission'
      }
    },
    userRole: 'INSTRUCTOR'
  }
  let responseBody
  const response = {
    send(body) {
      responseBody = body
      return this
    }
  }

  const getInfo = createInfoHandler({
    async getPermissions() {
      return ['declarant.list']
    }
  })

  await getInfo(request, response)

  t.is(responseBody.user.phoneNumber, '0102030405')
  t.is(responseBody.user.jobTitle, 'Chargée de mission')
  t.deepEqual(responseBody.permissions, ['declarant.list'])
})
