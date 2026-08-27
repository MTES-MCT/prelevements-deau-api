import test from 'ava'

import {
  getEffectiveDeclarantContactEmails,
  getPrimaryDeclarantContactEmail,
  hasDeclarantContactEmail,
  serializeDeclarantContactEmails
} from '../declarant-contact-emails.js'

test('les contacts déclarants priment sur l’adresse de connexion', t => {
  const declarant = {
    user: {email: 'connexion@example.test'},
    contactEmails: [
      {id: 'secondaire', email: 'secondaire@example.test', isPrimary: false},
      {id: 'principal', email: 'principal@example.test', isPrimary: true}
    ]
  }

  t.deepEqual(getEffectiveDeclarantContactEmails(declarant), [
    'principal@example.test',
    'secondaire@example.test'
  ])
  t.is(getPrimaryDeclarantContactEmail(declarant), 'principal@example.test')
  t.deepEqual(serializeDeclarantContactEmails(declarant), [
    {id: 'principal', email: 'principal@example.test', isPrimary: true},
    {id: 'secondaire', email: 'secondaire@example.test', isPrimary: false}
  ])
})

test('le fallback utilise seulement le login réel, jamais un login technique', t => {
  t.deepEqual(getEffectiveDeclarantContactEmails({
    user: {email: 'fallback@example.test'},
    contactEmails: []
  }), ['fallback@example.test'])

  const imported = {
    user: {email: 'reunion-preleveur-42@import.local'},
    contactEmails: []
  }

  t.deepEqual(getEffectiveDeclarantContactEmails(imported), [])
  t.false(hasDeclarantContactEmail(imported))
})

test('les alias de connexion ne sont pas des contacts de fallback', t => {
  const declarant = {
    user: {
      email: 'reunion-preleveur-42@import.local',
      emailAliases: [{email: 'alias@example.test'}]
    },
    contactEmails: []
  }

  t.deepEqual(getEffectiveDeclarantContactEmails(declarant), [])
})
