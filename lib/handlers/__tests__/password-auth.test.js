import test from 'ava'

import {
  handlePasswordActivation,
  handlePasswordChange,
  handlePasswordLogin
} from '../password-auth.js'
import {PASSWORD_SECURITY_NOTIFICATION_TYPES} from '../../services/password-security-notifications.js'

const USER = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'personne@example.test',
  role: 'DECLARANT'
}
const SESSION = {
  token: 'session-token',
  expiresAt: new Date('2026-09-03T12:00:00.000Z')
}

function createResponse() {
  return {
    body: null,
    statusCode: null,
    status(statusCode) {
      this.statusCode = statusCode
      return this
    },
    send(body) {
      this.body = body
      return this
    }
  }
}

test('handlePasswordLogin ne déclenche aucune notification de sécurité', async t => {
  let notifications = 0
  const request = {
    body: {email: USER.email, password: 'secret'}
  }
  const response = createResponse()

  await handlePasswordLogin(request, response, {
    async authenticate(email, password) {
      t.is(email, USER.email)
      t.is(password, 'secret')
      return {user: USER, session: SESSION}
    },
    async notify() {
      notifications++
    }
  })

  t.is(notifications, 0)
  t.is(response.statusCode, 200)
  t.is(response.body.token, SESSION.token)
  t.false(Object.hasOwn(request.body, 'password'))
})

test('handlePasswordActivation notifie après succès sans bloquer le 200', async t => {
  const calls = []
  const request = {
    body: {token: 'activation-token', password: 'nouveau-secret'}
  }
  const response = createResponse()

  await handlePasswordActivation(request, response, {
    async activate(token, password) {
      calls.push('activate')
      t.is(token, 'activation-token')
      t.is(password, 'nouveau-secret')
      return {user: USER, session: SESSION}
    },
    async notify(user, type) {
      calls.push('notify')
      t.is(user, USER)
      t.is(type, PASSWORD_SECURITY_NOTIFICATION_TYPES.ACTIVATED)
      return false
    }
  })

  t.deepEqual(calls, ['activate', 'notify'])
  t.is(response.statusCode, 200)
  t.is(response.body.token, SESSION.token)
  t.false(Object.hasOwn(request.body, 'password'))
  t.false(Object.hasOwn(request.body, 'token'))
})

test('handlePasswordChange notifie après succès sans bloquer le 200', async t => {
  const calls = []
  const request = {
    authToken: 'current-session',
    body: {currentPassword: 'ancien', newPassword: 'nouveau'},
    user: USER
  }
  const response = createResponse()

  await handlePasswordChange(request, response, {
    async change(user, currentPassword, newPassword, options) {
      calls.push('change')
      t.is(user, USER)
      t.is(currentPassword, 'ancien')
      t.is(newPassword, 'nouveau')
      t.is(options.sessionToken, request.authToken)
      return SESSION
    },
    async notify(user, type) {
      calls.push('notify')
      t.is(user, USER)
      t.is(type, PASSWORD_SECURITY_NOTIFICATION_TYPES.CHANGED)
      return false
    }
  })

  t.deepEqual(calls, ['change', 'notify'])
  t.is(response.statusCode, 200)
  t.is(response.body.token, SESSION.token)
  t.false(Object.hasOwn(request.body, 'currentPassword'))
  t.false(Object.hasOwn(request.body, 'newPassword'))
})
