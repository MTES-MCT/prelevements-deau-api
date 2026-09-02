import test from 'ava'

import {
  handlePasswordActivationIssue,
  issuePasswordActivationHandler,
  revokePasswordAccessHandler
} from '../admin-password-accesses.js'
import {PASSWORD_SECURITY_NOTIFICATION_TYPES} from '../../services/password-security-notifications.js'

const ADMIN_USER_ID = '11111111-1111-4111-8111-111111111111'
const TARGET_USER_ID = '22222222-2222-4222-8222-222222222222'

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

function failIfCalled(t) {
  return new Proxy({}, {
    get() {
      t.fail('La réponse ne doit pas être écrite quand la cible est l’administrateur courant.')
    }
  })
}

test('issuePasswordActivationHandler refuse l’auto-émission avant toute mutation', async t => {
  const error = await t.throwsAsync(() => issuePasswordActivationHandler({
    body: {userId: ADMIN_USER_ID},
    user: {id: ADMIN_USER_ID}
  }, failIfCalled(t)))

  t.is(error.status, 403)
  t.is(error.message, 'Action interdite.')
})

test('revokePasswordAccessHandler refuse l’auto-révocation avant toute mutation', async t => {
  const error = await t.throwsAsync(() => revokePasswordAccessHandler({
    params: {userId: ADMIN_USER_ID},
    user: {id: ADMIN_USER_ID}
  }, failIfCalled(t)))

  t.is(error.status, 403)
  t.is(error.message, 'Action interdite.')
})

for (const reset of [false, true]) {
  test(`handlePasswordActivationIssue ${reset ? 'notifie le reset' : 'ne notifie pas la première activation'}`, async t => {
    const notifications = []
    const expiresAt = new Date('2026-09-05T12:00:00.000Z')
    const user = {
      id: TARGET_USER_ID,
      email: 'personne@example.test',
      firstName: 'Camille',
      lastName: 'Rivière',
      role: 'DECLARANT'
    }
    const response = createResponse()

    await handlePasswordActivationIssue({
      body: {userId: TARGET_USER_ID},
      user: {id: ADMIN_USER_ID}
    }, response, {
      async issue(userId, options) {
        t.is(userId, TARGET_USER_ID)
        t.is(options.createdByUserId, ADMIN_USER_ID)
        return {
          activation: {createdAt: new Date(), expiresAt},
          reset,
          sessionsRevoked: reset ? 2 : 0,
          token: 'activation-token',
          user
        }
      },
      async notify(notifiedUser, type) {
        notifications.push({notifiedUser, type})
        return false
      },
      readFrontUrl() {
        return 'https://app.example.test'
      }
    })

    t.is(response.statusCode, 201)
    t.is(response.body.reset, reset)
    t.is(response.body.activationUrl, 'https://app.example.test/activation-mot-de-passe#token=activation-token')
    t.is(notifications.length, reset ? 1 : 0)
    if (reset) {
      t.is(notifications[0].notifiedUser, user)
      t.is(notifications[0].type, PASSWORD_SECURITY_NOTIFICATION_TYPES.RESET)
    }
  })
}
