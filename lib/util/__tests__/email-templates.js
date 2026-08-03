import test from 'ava'

import {renderMagicLinkEmail} from '../email-templates.js'

const userWithoutName = {
  email: 'agent@example.test'
}

test('renderMagicLinkEmail / utilise l’email quand le nom est absent', async t => {
  const html = await renderMagicLinkEmail(userWithoutName, 'token', 'https://api.example.test')

  t.true(html.includes('Bonjour agent@example.test'))
  t.false(html.includes('undefined'))
})
