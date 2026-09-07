import test from 'ava'

import {validateDeclarantContactEmailsPayload} from '../declarant-contact-emails.js'

test('le payload PUT normalise les emails', t => {
  t.deepEqual(validateDeclarantContactEmailsPayload({
    contactEmails: [
      {email: 'CONTACT@EXAMPLE.TEST', isPrimary: false},
      {email: 'principal@example.test', isPrimary: true}
    ]
  }), {
    contactEmails: [
      {email: 'contact@example.test', isPrimary: false},
      {email: 'principal@example.test', isPrimary: true}
    ]
  })
})

test('le payload PUT exige isPrimary explicitement', t => {
  const error = t.throws(() => validateDeclarantContactEmailsPayload({
    contactEmails: [{email: 'contact@example.test'}]
  }))

  t.is(error.status, 400)
})

test('le payload PUT refuse les propriétés inconnues', t => {
  const error = t.throws(() => validateDeclarantContactEmailsPayload({
    contactEmails: [{
      id: '11111111-1111-4111-8111-111111111111',
      email: 'contact@example.test',
      isPrimary: true
    }]
  }))

  t.is(error.status, 400)
})
