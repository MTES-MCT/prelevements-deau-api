import test from 'ava'

import {
  readAuthMethods,
  readCurrentPasswordPepperVersion,
  readPasswordActivationFrontUrl,
  readPasswordPepper,
  validateAuthConfig
} from '../auth.js'

test('readAuthMethods conserve magic_link par défaut', t => {
  t.deepEqual(readAuthMethods(undefined), ['magic_link'])
})

test('readAuthMethods conserve l’ordre configuré', t => {
  t.deepEqual(readAuthMethods('password, magic_link'), ['password', 'magic_link'])
})

test('readAuthMethods refuse les listes vides, doublons et méthodes inconnues', t => {
  t.throws(() => readAuthMethods(''), {message: /au moins une méthode/})
  t.throws(() => readAuthMethods('magic_link,magic_link'), {message: /doublon/})
  t.throws(() => readAuthMethods('oidc'), {message: /inconnues/})
})

test('validateAuthConfig ne demande un pepper que lorsque password est actif', t => {
  t.deepEqual(validateAuthConfig({AUTH_METHODS: 'magic_link'}), ['magic_link'])

  t.throws(() => validateAuthConfig({AUTH_METHODS: 'password'}), {
    message: /PASSWORD_PEPPER_CURRENT_VERSION/
  })

  t.deepEqual(validateAuthConfig({
    AUTH_METHODS: 'password,magic_link',
    PASSWORD_PEPPER_CURRENT_VERSION: '1',
    PASSWORD_PEPPER_V1: 'x'.repeat(32),
    FRONT_URL: 'https://app.example.test'
  }), ['password', 'magic_link'])
})

test('la version et la longueur du pepper sont strictement validées', t => {
  t.is(readCurrentPasswordPepperVersion('2'), 2)
  t.throws(() => readCurrentPasswordPepperVersion('02'))
  t.throws(() => readPasswordPepper(1, {PASSWORD_PEPPER_V1: 'trop-court'}), {
    message: /au moins 32 octets/
  })
})

test('FRONT_URL est obligatoire et sûr lorsque password est actif', t => {
  t.is(
    readPasswordActivationFrontUrl('https://app.example.test/'),
    'https://app.example.test'
  )
  t.throws(() => readPasswordActivationFrontUrl(undefined))
  t.throws(() => readPasswordActivationFrontUrl('file:///tmp/demo'))
  t.throws(() => readPasswordActivationFrontUrl('https://user:secret@app.example.test'))
  t.throws(() => readPasswordActivationFrontUrl('https://app.example.test?token=secret'))
  t.throws(() => validateAuthConfig({
    AUTH_METHODS: 'password',
    PASSWORD_PEPPER_CURRENT_VERSION: '1',
    PASSWORD_PEPPER_V1: 'x'.repeat(32)
  }), {message: /FRONT_URL/})
})
