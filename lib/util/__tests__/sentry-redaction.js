import test from 'ava'

import {
  redactSentryEvent,
  SENTRY_FILTERED_VALUE
} from '../sentry-redaction.js'

test('redactSentryEvent retire récursivement les secrets d’authentification', t => {
  const redacted = redactSentryEvent({
    request: {
      headers: {
        authorization: 'Bearer session-secrete',
        cookie: 'session=secrete',
        accept: 'application/json'
      },
      data: {
        email: 'personne@example.test',
        password: 'mot-de-passe-secret',
        activationUrl: 'https://app.example.test/activation#token=secret',
        nested: {
          currentPassword: 'ancien',
          activationToken: 'activation-secrete'
        }
      }
    }
  })

  t.is(redacted.request.headers.authorization, SENTRY_FILTERED_VALUE)
  t.is(redacted.request.headers.cookie, SENTRY_FILTERED_VALUE)
  t.is(redacted.request.data.password, SENTRY_FILTERED_VALUE)
  t.is(redacted.request.data.activationUrl, SENTRY_FILTERED_VALUE)
  t.is(redacted.request.data.nested.currentPassword, SENTRY_FILTERED_VALUE)
  t.is(redacted.request.data.nested.activationToken, SENTRY_FILTERED_VALUE)
  t.is(redacted.request.data.email, 'personne@example.test')
  t.is(redacted.request.headers.accept, 'application/json')
})

test('redactSentryEvent filtre aussi un corps JSON sérialisé par Sentry', t => {
  const redacted = redactSentryEvent({
    request: {
      data: JSON.stringify({
        email: 'personne@example.test',
        password: 'mot-de-passe-secret',
        token: 'activation-secrete'
      })
    }
  })
  const body = JSON.parse(redacted.request.data)

  t.is(body.email, 'personne@example.test')
  t.is(body.password, SENTRY_FILTERED_VALUE)
  t.is(body.token, SENTRY_FILTERED_VALUE)
})

test('redactSentryEvent masque intégralement un corps JSON tronqué', t => {
  const redacted = redactSentryEvent({
    request: {
      data: '{"email":"personne@example.test","password":"secret"'
    }
  })

  t.is(redacted.request.data, SENTRY_FILTERED_VALUE)
})

test('redactSentryEvent conserve le corps ordinaire d’un log', t => {
  const redacted = redactSentryEvent({
    body: 'Redis prêt',
    attributes: {component: 'redis'}
  })

  t.is(redacted.body, 'Redis prêt')
  t.is(redacted.attributes.component, 'redis')
})
