import test from 'ava'

import {
  renderDeclarationReminderEmail,
  renderMagicLinkEmail
} from '../email-templates.js'

const userWithoutName = {
  email: 'agent@example.test'
}

test('renderMagicLinkEmail / utilise l’email quand le nom est absent', t => {
  const html = renderMagicLinkEmail(userWithoutName, 'token', 'https://api.example.test')

  t.true(html.includes('Bonjour agent@example.test'))
  t.false(html.includes('undefined'))
})

test('renderDeclarationReminderEmail / utilise l’email quand le nom est absent', t => {
  const html = renderDeclarationReminderEmail(userWithoutName, 'https://app.example.test')

  t.true(html.includes('Bonjour agent@example.test'))
  t.false(html.includes('undefined'))
})
