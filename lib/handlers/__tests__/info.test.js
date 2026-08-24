import test from 'ava'

import {getInfoHandler} from '../info.js'

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

  await getInfoHandler(request, response)

  t.is(responseBody.expiresAt, expiresAt)
  t.is(responseBody.user.id, 'user-id')
})
