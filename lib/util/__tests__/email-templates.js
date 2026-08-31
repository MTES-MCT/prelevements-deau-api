import test from 'ava'

import {
  renderEmailVerificationEmail,
  renderEmailVerificationRequestedAlertEmail,
  renderMagicLinkEmail,
  renderPrimaryEmailChangedAlertEmail
} from '../email-templates.js'

const userWithoutName = {
  email: 'agent@example.test'
}

test('renderMagicLinkEmail / utilise l’email quand le nom est absent', async t => {
  const html = await renderMagicLinkEmail(userWithoutName, 'token', 'https://api.example.test')

  t.true(html.includes('Bonjour agent@example.test'))
  t.false(html.includes('undefined'))
})

test('les emails de validation décrivent les étapes sans exposer de jargon technique', async t => {
  const expiresAt = new Date('2026-09-01T12:00:00.000Z')
  const verification = await renderEmailVerificationEmail({
    user: {firstName: 'Camille', lastName: 'Rivière'},
    email: 'nouvelle@example.test',
    purpose: 'PRIMARY_CHANGE',
    confirmationUrl: 'https://app.example.test/validation-email#token=secret',
    expiresAt
  })
  const alert = await renderEmailVerificationRequestedAlertEmail({
    user: {firstName: 'Camille'},
    email: 'alias@example.test',
    purpose: 'ALIAS_ADD',
    expiresAt
  })
  const changed = await renderPrimaryEmailChangedAlertEmail({
    user: {firstName: 'Camille'},
    previousEmail: 'ancienne@example.test',
    newEmail: 'nouvelle@example.test'
  })

  t.true(verification.includes('nouvelle@example.test'))
  t.true(verification.includes('validation-email#token=secret'))
  t.true(alert.includes('autre adresse de connexion'))
  t.true(changed.includes('Toutes les sessions ouvertes ont été fermées'))
  t.false(verification.includes('PRIMARY_CHANGE'))
  t.false(alert.includes('ALIAS_ADD'))
})
