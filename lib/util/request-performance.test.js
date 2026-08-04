import test from 'ava'

import {
  normalizeRequestPath,
  resolveRequestId
} from './request-performance.js'

test('normalizeRequestPath masque les identifiants dynamiques', t => {
  t.is(
    normalizeRequestPath('/declarants/024ab8c0-6d6f-47a5-b2c3-377420a5cfbf'),
    '/declarants/:id'
  )
  t.is(normalizeRequestPath('/zones/75/declarants?page=2'), '/zones/:id/declarants')
})

test('resolveRequestId conserve uniquement un identifiant sûr', t => {
  t.is(resolveRequestId('front_01-abc.def'), 'front_01-abc.def')
  t.regex(resolveRequestId('invalid id with spaces'), /^[\da-f-]{36}$/)
})
