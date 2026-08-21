import test from 'ava'

import {
  issuePasswordActivationHandler,
  revokePasswordAccessHandler
} from '../admin-password-accesses.js'

const ADMIN_USER_ID = '11111111-1111-4111-8111-111111111111'

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
