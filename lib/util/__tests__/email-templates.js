import test from 'ava'

import {
  renderEmailVerificationEmail,
  renderEmailVerificationRequestedAlertEmail,
  renderMagicLinkEmail,
  renderPasswordActivatedAlertEmail,
  renderPasswordChangedAlertEmail,
  renderPasswordResetAlertEmail,
  renderPrimaryEmailChangedAlertEmail
} from '../email-templates.js'

const SECURITY_CONTACT_LINK = 'mailto:contact@partageonsleau.beta.gouv.fr'

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
  t.true(verification.includes(SECURITY_CONTACT_LINK))
  t.true(alert.includes(SECURITY_CONTACT_LINK))
  t.true(changed.includes(SECURITY_CONTACT_LINK))
  t.false(verification.includes('PRIMARY_CHANGE'))
  t.false(alert.includes('ALIAS_ADD'))
})

test('les alertes de mot de passe indiquent le contact de sécurité', async t => {
  const user = {firstName: 'Camille', lastName: 'Rivière'}
  const [activated, changed, reset] = await Promise.all([
    renderPasswordActivatedAlertEmail(user),
    renderPasswordChangedAlertEmail(user),
    renderPasswordResetAlertEmail(user)
  ])

  for (const html of [activated, changed, reset]) {
    t.true(html.includes(SECURITY_CONTACT_LINK))
    t.true(html.includes('Camille Rivière'))
  }

  t.true(activated.includes('mot de passe a été défini'))
  t.true(changed.includes('mot de passe a été modifié'))
  t.true(reset.includes('accès par mot de passe a été réinitialisé'))
})
