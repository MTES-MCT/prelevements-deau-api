import test from 'ava'

import {createUpdateMyProfileHandler} from '../user-profile.js'

test('updateMyProfileHandler met à jour le compte courant et renvoie le profil aplati', async t => {
  const request = {
    user: {id: '11111111-1111-4111-8111-111111111111'},
    authToken: 'session-courante',
    body: {firstName: 'Aline'}
  }
  const updatedUser = {
    id: request.user.id,
    role: 'ADMIN',
    email: 'admin@example.test',
    emailAliases: [],
    emailVerifications: [],
    firstName: 'Aline',
    lastName: 'Martin',
    lastLoginAt: null
  }
  let responseStatus
  let responseBody
  const response = {
    status(status) {
      responseStatus = status
      return this
    },
    send(body) {
      responseBody = body
      return this
    }
  }
  const calls = []
  const handler = createUpdateMyProfileHandler({
    async updateProfile(userId, changes, options) {
      calls.push({userId, changes, options})
      return updatedUser
    }
  })

  await handler(request, response)

  t.deepEqual(calls, [{
    userId: request.user.id,
    changes: request.body,
    options: {
      allowImpersonatedSession: true,
      sessionToken: request.authToken
    }
  }])
  t.is(responseStatus, 200)
  t.deepEqual(responseBody, {
    id: updatedUser.id,
    email: updatedUser.email,
    emailAliases: [],
    emailVerifications: [],
    lastName: 'Martin',
    firstName: 'Aline',
    lastLoginAt: null
  })
})
