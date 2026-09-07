import test from 'ava'

import {
  buildEmailVerificationUrl,
  confirmUserEmailVerification,
  requestEmailAliasAddition,
  requestPrimaryEmailChange,
  resendUserEmailVerification
} from '../user-email-verifications.js'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const VERIFICATION_ID = '22222222-2222-4222-8222-222222222222'
const NOW = new Date('2026-08-31T12:00:00.000Z')

function buildIssued(overrides = {}) {
  const {
    verification: verificationOverrides,
    ...rootOverrides
  } = overrides
  const verification = {
    id: VERIFICATION_ID,
    userId: USER_ID,
    purpose: 'PRIMARY_CHANGE',
    status: 'PENDING',
    email: 'nouvelle@example.test',
    primaryEmailSnapshot: 'ancienne@example.test',
    tokenHash: 'a'.repeat(64),
    createdAt: NOW,
    updatedAt: NOW,
    lastAttemptedAt: NOW,
    sentAt: null,
    expiresAt: new Date(NOW.getTime() + (24 * 60 * 60 * 1000)),
    verifiedAt: null,
    cancelledAt: null,
    ...verificationOverrides
  }

  return {
    verification,
    user: {
      id: USER_ID,
      email: 'ancienne@example.test',
      firstName: 'Camille',
      lastName: 'Rivière'
    },
    token: 'jeton-secret',
    tokenHash: verification.tokenHash,
    securityNotificationRecipients: ['ancienne@example.test'],
    ...rootOverrides
  }
}

test('buildEmailVerificationUrl place le secret uniquement dans le fragment', t => {
  const url = new URL(buildEmailVerificationUrl(
    'secret+/=',
    'https://app.example.test/sous-chemin'
  ))

  t.is(url.origin, 'https://app.example.test')
  t.is(url.pathname, '/validation-email')
  t.is(url.search, '')
  t.is(url.hash, '#token=secret%2B%2F%3D')
})

test('une demande envoie la validation à la cible et une alerte à l’adresse actuelle', async t => {
  const sent = []
  let recorded
  const issued = buildIssued()

  const result = await requestPrimaryEmailChange(
    USER_ID,
    'nouvelle@example.test',
    {
      allowImpersonatedSession: true,
      now: NOW,
      frontUrl: 'https://app.example.test',
      async issue(userId, purpose, email, options) {
        t.is(userId, USER_ID)
        t.is(purpose, 'PRIMARY_CHANGE')
        t.is(email, 'nouvelle@example.test')
        t.true(options.allowImpersonatedSession)
        return issued
      },
      async renderVerification({confirmationUrl}) {
        t.true(confirmationUrl.endsWith('/validation-email#token=jeton-secret'))
        return 'validation-html'
      },
      async renderRequestedAlert() {
        return 'alert-html'
      },
      async send(recipient, subject, html) {
        sent.push({recipient, subject, html})
      },
      async recordDelivery(id, tokenHash, delivered) {
        recorded = {id, tokenHash, delivered}
        return {...issued.verification, sentAt: NOW}
      }
    }
  )

  t.deepEqual(recorded, {
    id: VERIFICATION_ID,
    tokenHash: 'a'.repeat(64),
    delivered: true
  })
  t.deepEqual(sent
    .map(message => [message.recipient, message.html])
    .sort(), [
    ['ancienne@example.test', 'alert-html'],
    ['nouvelle@example.test', 'validation-html']
  ])
  t.is(result.status, 'PENDING')
  t.is(result.sentAt, NOW)
  t.false(result.canResend)
})

test('un échec SMTP devient SEND_FAILED sans perdre la demande', async t => {
  const issued = buildIssued({
    verification: {purpose: 'ALIAS_ADD'}
  })
  let recordedDelivery

  const result = await requestEmailAliasAddition(
    USER_ID,
    'nouvelle@example.test',
    {
      now: NOW,
      async issue() {
        return issued
      },
      async renderVerification() {
        return 'validation-html'
      },
      async renderRequestedAlert() {
        throw new Error('rendu indisponible')
      },
      async send() {
        throw new Error('smtp indisponible')
      },
      async recordDelivery(id, tokenHash, delivered) {
        recordedDelivery = delivered
        return {
          ...issued.verification,
          status: delivered ? 'PENDING' : 'SEND_FAILED'
        }
      }
    }
  )

  t.false(recordedDelivery)
  t.is(result.status, 'SEND_FAILED')
})

test('le cooldown de renvoi devient une erreur HTTP 429 exploitable', async t => {
  const error = await t.throwsAsync(resendUserEmailVerification(
    USER_ID,
    VERIFICATION_ID,
    {
      now: NOW,
      async resend() {
        return {
          outcome: 'COOLDOWN',
          verification: buildIssued().verification,
          retryAfterSeconds: 37
        }
      }
    }
  ))

  t.is(error.status, 429)
  t.is(error.retryAfterSeconds, 37)
})

test('un renvoi expiré crée une nouvelle demande et envoie un nouveau jeton', async t => {
  const recipients = []
  const verification = {
    ...buildIssued().verification,
    status: 'EXPIRED',
    tokenHash: null
  }

  const result = await resendUserEmailVerification(
    USER_ID,
    VERIFICATION_ID,
    {
      now: NOW,
      async resend() {
        return {outcome: 'EXPIRED', verification}
      },
      async issue(userId, purpose, email) {
        t.is(userId, USER_ID)
        t.is(purpose, 'PRIMARY_CHANGE')
        t.is(email, 'nouvelle@example.test')
        return buildIssued()
      },
      async renderVerification() {
        return 'validation-html'
      },
      async renderRequestedAlert() {
        return 'alert-html'
      },
      async send(recipient) {
        recipients.push(recipient)
      },
      async recordDelivery(id, tokenHash, delivered) {
        t.true(delivered)
        return {...buildIssued().verification, sentAt: NOW}
      }
    }
  )

  t.is(result.status, 'PENDING')
  t.is(result.sentAt, NOW)
  t.deepEqual(recipients.sort(), [
    'ancienne@example.test',
    'nouvelle@example.test'
  ])
})

test('l’échec de l’alerte secondaire ne remet pas une confirmation en cause', async t => {
  const verification = {
    ...buildIssued().verification,
    status: 'VERIFIED',
    tokenHash: null,
    verifiedAt: NOW
  }

  const result = await confirmUserEmailVerification('jeton', {
    now: NOW,
    async consume() {
      return {
        outcome: 'VERIFIED',
        verification,
        purpose: 'PRIMARY_CHANGE',
        email: 'nouvelle@example.test',
        previousEmail: 'ancienne@example.test',
        user: buildIssued().user,
        securityNotificationRecipients: ['ancienne@example.test'],
        authTokensRevoked: 2,
        sessionsRevoked: 3
      }
    },
    async renderChangedAlert() {
      throw new Error('rendu indisponible')
    },
    async send() {
      t.fail('Aucun envoi sans contenu rendu.')
    }
  })

  t.is(result.outcome, 'VERIFIED')
  t.is(result.verification.status, 'VERIFIED')
  t.is(result.sessionsRevoked, 3)
})
